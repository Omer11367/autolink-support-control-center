import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { shouldIgnoreTelegramMessage } from "../../../lib/guardian-mirror.ts";
import { classifyIntent } from "../../../lib/intent-classifier.ts";

type TelegramChat = {
  id: number;
  title?: string;
  type?: string;
};

type TelegramUser = {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramMessage = {
  message_id: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type StoredMessageRow = {
  id: string;
  created_at: string | null;
  message_text: string | null;
  message_type: string | null;
};

type SheetAction = {
  type?: string;
  account?: string;
  accounts?: string[];
  bm?: string;
  amount?: string;
};

const DEBOUNCE_WINDOW_SECONDS = 10;
const BURST_LOOKBACK_MINUTES = 5;
const BURST_GAP_SECONDS = 75;
const SHEET_HEADERS = [
  "Date",
  "Time",
  "Ticket ID",
  "Category",
  "Client Group",
  "Username",
  "Original Message",
  "Parsed Summary",
  "Status",
  "Notes"
];
const STATUS_OPTIONS = ["Pending", "In Progress", "Waiting Client", "Completed", "Rejected"];
const CATEGORY_COLORS: Record<string, { red: number; green: number; blue: number }> = {
  Share: { red: 0.18, green: 0.42, blue: 0.78 },
  Unshare: { red: 0.92, green: 0.55, blue: 0.18 },
  Deposits: { red: 0.22, green: 0.56, blue: 0.24 },
  "Payment Issues": { red: 0.78, green: 0.22, blue: 0.19 },
  Verification: { red: 0.49, green: 0.28, blue: 0.74 },
  "Account Issues": { red: 0.42, green: 0.45, blue: 0.50 },
  General: { red: 0.35, green: 0.39, blue: 0.45 }
};
const CATEGORY_PREFIXES: Record<string, string> = {
  Share: "S",
  Unshare: "U",
  Deposits: "D",
  "Payment Issues": "P",
  Verification: "V",
  "Account Issues": "A",
  General: "G"
};

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function optionalEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function requiredEnv(names: string[]): string {
  const value = optionalEnv(names);
  if (!value) throw new Error(`Missing environment variable: ${names.join(" or ")}`);
  return value;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTicketCode(): string {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().slice(0, 6).toUpperCase();
  return `AL-${stamp}-${suffix}`;
}

function normalizeComparableText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isGreetingOnly(text: string): boolean {
  const normalized = normalizeComparableText(text).replace(/[!?.,]+$/g, "");
  return ["hey", "hi", "hello", "yo", "good morning", "good evening", "good night", "how are you"].includes(normalized);
}

function hasRequestSignal(text: string): boolean {
  const normalized = normalizeComparableText(text);
  return /\b(share|unshare|remove|bm|account|deposit|sent|paid|payment|funds|usdt|usd|verify|verification|disabled|restricted|failed|issue|problem|check|status|availability|need|request|refund)\b|\$|\d/.test(normalized);
}

function isIncompleteRequestFragment(text: string): boolean {
  const normalized = normalizeComparableText(text).replace(/[!?.,]+$/g, "");
  if (!normalized) return true;
  if (/^(?:sent|send|paid|deposit|check|please check|pls check|\$|usd|usdt|dollars?)$/i.test(normalized)) return true;
  if (/^(?:\d+(?:[.,]\d+)?k?|\d+(?:[.,]\d+)?\s*(?:usd|usdt|\$|dollars?))$/i.test(normalized)) return true;
  if (/^(?:bm|business manager)\s+[A-Za-z0-9_-]+$/i.test(normalized)) return true;
  if (/^(?:account|acc|ad account)\s+[A-Za-z0-9_-]+$/i.test(normalized)) return true;
  return false;
}

function mapIntentToCategory(intent: string): string {
  const normalized = String(intent || "").toLowerCase();
  if (["share_ad_account", "transfer_ad_account"].includes(normalized)) return "Share";
  if (["unshare_ad_account"].includes(normalized)) return "Unshare";
  if (["deposit_funds"].includes(normalized)) return "Deposits";
  if (["payment_issue", "refund_request"].includes(normalized)) return "Payment Issues";
  if (["verify_account"].includes(normalized)) return "Verification";
  if (["check_account_status", "request_data_banned_accounts", "check_policy"].includes(normalized)) return "Account Issues";
  return "General";
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quoteSheetName(tabName: string): string {
  return `'${tabName.replaceAll("'", "''")}'`;
}

function isHeaderRow(values: string[]): boolean {
  return SHEET_HEADERS.every((header, index) => values[index] === header);
}

function hasAnyCellValue(values: string[]): boolean {
  return values.some((value) => value.trim().length > 0);
}

function parseClientSheetsMap(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>)
      .filter(([key, value]) => typeof key === "string" && typeof value === "string" && key.trim() && value.trim())
      .map(([key, value]) => [key.trim(), (value as string).trim()])
  );
}

function getSpreadsheetIdForClient(map: Record<string, string>, groupName: string): string | null {
  if (!groupName.trim()) return null;
  const exact = map[groupName];
  if (exact) return exact;
  const normalized = groupName.trim().toLowerCase();
  const foundEntry = Object.entries(map).find(([name]) => name.trim().toLowerCase() === normalized);
  return foundEntry?.[1] ?? null;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlString(value: string): string {
  return base64Url(new TextEncoder().encode(value));
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

async function getGoogleAccessToken(serviceAccount: { client_email: string; private_key: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: serviceAccount.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now
  };
  const unsigned = `${base64UrlString(JSON.stringify(header))}.${base64UrlString(JSON.stringify(claim))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(serviceAccount.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const assertion = `${unsigned}.${base64Url(new Uint8Array(signature))}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });
  const payload = await response.json();
  if (!response.ok || !payload.access_token) throw new Error(payload.error_description ?? "Google token request failed.");
  return payload.access_token as string;
}

async function googleSheetsRequest<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`https://sheets.googleapis.com/v4${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(init.headers ?? {})
    }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message ?? "Google Sheets request failed.");
  return payload as T;
}

async function ensureSheetTabReady(accessToken: string, spreadsheetId: string, tabName: string) {
  const spreadsheet = await googleSheetsRequest<{
    sheets?: Array<{ properties?: { sheetId?: number; title?: string }; bandedRanges?: unknown[] }>;
  }>(accessToken, `/spreadsheets/${spreadsheetId}`);
  let sheet = (spreadsheet.sheets ?? []).find((item) => item.properties?.title === tabName);

  if (!sheet) {
    const created = await googleSheetsRequest<{
      replies?: Array<{ addSheet?: { properties?: { sheetId?: number; title?: string } } }>;
    }>(accessToken, `/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: tabName } } }] })
    });
    sheet = { properties: created.replies?.[0]?.addSheet?.properties };
    console.log("sheets-tab-created", { tabName });
  }

  const sheetId = sheet?.properties?.sheetId;
  if (typeof sheetId !== "number") throw new Error(`Missing Google Sheet ID for tab: ${tabName}`);

  const headerRange = encodeURIComponent(`${quoteSheetName(tabName)}!A1:J1`);
  const headerResponse = await googleSheetsRequest<{ values?: string[][] }>(
    accessToken,
    `/spreadsheets/${spreadsheetId}/values/${headerRange}`
  );
  const currentHeader = (headerResponse.values?.[0] ?? []).map((value) => String(value ?? ""));
  const shouldWriteHeaders = !isHeaderRow(currentHeader);
  const shouldInsertHeaderRow = shouldWriteHeaders && hasAnyCellValue(currentHeader);
  const headerColor = CATEGORY_COLORS[tabName] ?? CATEGORY_COLORS.General;
  const hasBanding = Boolean(sheet.bandedRanges?.length);

  await googleSheetsRequest(accessToken, `/spreadsheets/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [
        ...(shouldInsertHeaderRow
          ? [{
              insertDimension: {
                range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 },
                inheritFromBefore: false
              }
            }]
          : []),
        {
          updateSheetProperties: {
            properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
            fields: "gridProperties.frozenRowCount"
          }
        },
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: SHEET_HEADERS.length },
            cell: {
              userEnteredFormat: {
                backgroundColor: headerColor,
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                verticalAlignment: "MIDDLE",
                wrapStrategy: "WRAP"
              }
            },
            fields: "userEnteredFormat(backgroundColor,textFormat,verticalAlignment,wrapStrategy)"
          }
        },
        {
          setDataValidation: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: 8, endColumnIndex: 9 },
            rule: {
              condition: {
                type: "ONE_OF_LIST",
                values: STATUS_OPTIONS.map((userEnteredValue) => ({ userEnteredValue }))
              },
              inputMessage: "Select ticket status",
              strict: true,
              showCustomUi: true
            }
          }
        },
        {
          autoResizeDimensions: {
            dimensions: { sheetId, dimension: "COLUMNS", startIndex: 0, endIndex: SHEET_HEADERS.length }
          }
        },
        ...(!hasBanding
          ? [{
              addBanding: {
                bandedRange: {
                  range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: SHEET_HEADERS.length },
                  rowProperties: {
                    headerColor,
                    firstBandColor: { red: 1, green: 1, blue: 1 },
                    secondBandColor: { red: 0.96, green: 0.97, blue: 0.98 }
                  }
                }
              }
            }]
          : [])
      ]
    })
  });

  if (shouldWriteHeaders) {
    await googleSheetsRequest(
      accessToken,
      `/spreadsheets/${spreadsheetId}/values/${headerRange}?valueInputOption=RAW`,
      {
        method: "PUT",
        body: JSON.stringify({ values: [SHEET_HEADERS] })
      }
    );
  }
}

async function generateTicketId(accessToken: string, spreadsheetId: string, tabName: string): Promise<string> {
  const prefix = CATEGORY_PREFIXES[tabName] ?? "G";
  const range = encodeURIComponent(`${quoteSheetName(tabName)}!C2:C`);
  const response = await googleSheetsRequest<{ values?: string[][] }>(
    accessToken,
    `/spreadsheets/${spreadsheetId}/values/${range}`
  );
  const ids = (response.values ?? [])
    .flat()
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.startsWith(`${prefix}-`));
  const max = ids.reduce((highest, value) => {
    const number = Number(value.replace(`${prefix}-`, ""));
    return Number.isFinite(number) ? Math.max(highest, number) : highest;
  }, 1000);
  return `${prefix}-${max + 1}`;
}

function getActions(extractedData: Record<string, unknown> | undefined): SheetAction[] {
  const actions = extractedData?.actions;
  if (!Array.isArray(actions)) return [];
  return actions.filter((action): action is SheetAction => Boolean(action) && typeof action === "object");
}

function firstAccountFromAction(action: SheetAction | undefined): string | null {
  return action?.account ?? action?.accounts?.[0] ?? null;
}

function extractAmount(message: string): string | null {
  const match = message.match(/(?:\$|usd\s*)?\d+(?:[,.]\d+)?\s*(?:k|K)?\s*(?:usdt|usd|dollars?|\$)?/i);
  return match?.[0] ? compactText(match[0]).replace(/\s+/g, "") : null;
}

function extractEntityAfter(text: string, labels: string[]): string | null {
  const labelPattern = labels.map((label) => label.replace(/\s+/g, "\\s+")).join("|");
  const match = text.match(new RegExp(`\\b(?:${labelPattern})\\b\\s*[:#-]?\\s*([A-Za-z0-9_-]+)`, "i"));
  return match?.[1] ?? null;
}

function generateParsedSummary(
  intent: string,
  originalMessage: string,
  fallback: string,
  extractedData?: Record<string, unknown>
): string {
  const category = mapIntentToCategory(intent);
  const actions = getActions(extractedData);
  const message = compactText(originalMessage);
  const shareAction = actions.find((action) => action.type === "share_account");
  const unshareAction = actions.find((action) => action.type === "unshare_account");
  const paymentAction = actions.find((action) => action.type === "payment_check");
  const verifyAction = actions.find((action) => action.type === "verify_account");
  const accountStatusAction = actions.find((action) => action.type === "account_status_check");
  const account = extractEntityAfter(message, ["account", "accounts", "acc", "ad account", "ad accounts"]);
  const bm = extractEntityAfter(message, ["bm", "business manager"]);

  if (category === "Deposits") {
    const amount = paymentAction?.amount ?? extractAmount(message);
    return amount ? `Deposit check request for ${amount}` : "Deposit check request";
  }
  if (category === "Share") {
    const actionAccount = firstAccountFromAction(shareAction) ?? account;
    const actionBm = shareAction?.bm ?? bm;
    if (actionAccount && actionBm) return `Share account ${actionAccount} to BM ${actionBm}`;
    if (actionAccount) return `Share account ${actionAccount}`;
    return "Share account request";
  }
  if (category === "Unshare") {
    const actionAccount = firstAccountFromAction(unshareAction) ?? account;
    const actionBm = unshareAction?.bm ?? bm;
    if (actionAccount && actionBm) return `Unshare account ${actionAccount} from BM ${actionBm}`;
    if (actionAccount) return `Unshare account ${actionAccount}`;
    return "Unshare account request";
  }
  if (category === "Payment Issues") {
    const actionAccount = firstAccountFromAction(accountStatusAction) ?? account;
    return actionAccount ? `Payment issue on account ${actionAccount}` : "Payment issue reported";
  }
  if (category === "Verification") {
    const actionAccount = firstAccountFromAction(verifyAction) ?? account;
    return actionAccount ? `Verification request for account ${actionAccount}` : "Verification request";
  }
  if (category === "Account Issues") {
    const actionAccount = firstAccountFromAction(accountStatusAction) ?? account;
    return actionAccount ? `Account issue on account ${actionAccount}` : "Account issue reported";
  }

  const cleanFallback = fallback.trim();
  return cleanFallback && !/^detected intent:/i.test(cleanFallback) ? cleanFallback : "General support request";
}

async function writeClientRequestRowToGoogleSheet(input: {
  telegramGroup: string;
  username: string;
  originalMessage: string;
  parsedMessage: string;
  intent: string;
  extractedData?: Record<string, unknown>;
}) {
  const serviceJsonRaw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_JSON");
  const sheetsMapRaw = Deno.env.get("CLIENT_SHEETS_MAP");
  if (!serviceJsonRaw?.trim() || !sheetsMapRaw?.trim()) {
    console.log("google-sheets-no-client-map", { reason: "missing_env" });
    return;
  }

  const serviceAccount = JSON.parse(serviceJsonRaw) as { client_email: string; private_key: string };
  const clientSheetsMap = parseClientSheetsMap(sheetsMapRaw);
  const spreadsheetId = getSpreadsheetIdForClient(clientSheetsMap, input.telegramGroup);
  if (!spreadsheetId) {
    console.log("google-sheets-no-client-map", { telegramGroup: input.telegramGroup });
    return;
  }

  const category = mapIntentToCategory(input.intent);
  console.log("sheets-category-selected", { category, intent: input.intent });
  const accessToken = await getGoogleAccessToken(serviceAccount);
  await ensureSheetTabReady(accessToken, spreadsheetId, category);

  const now = new Date();
  const ticketId = await generateTicketId(accessToken, spreadsheetId, category);
  const parsedSummary = generateParsedSummary(input.intent, input.originalMessage, input.parsedMessage, input.extractedData);
  const row = [
    now.toISOString().slice(0, 10),
    now.toTimeString().slice(0, 8),
    ticketId,
    category,
    input.telegramGroup,
    input.username,
    input.originalMessage,
    parsedSummary,
    "Pending",
    ""
  ];

  const appendRange = encodeURIComponent(`${quoteSheetName(category)}!A:J`);
  await googleSheetsRequest(
    accessToken,
    `/spreadsheets/${spreadsheetId}/values/${appendRange}:append?valueInputOption=RAW`,
    {
      method: "POST",
      body: JSON.stringify({ values: [row] })
    }
  );
  console.log("google-sheets-row-write-success", { tab: category });
  console.log("sheets-row-written", { tab: category, ticketId });
}

function buildBurstMessages(rows: StoredMessageRow[], latestRowId: string | null | undefined): StoredMessageRow[] {
  const textRows = rows
    .filter((row) => (row.message_type ?? "client") === "client" && Boolean(row.message_text?.trim()) && Boolean(row.created_at))
    .sort((a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime());
  if (textRows.length === 0) return [];

  let latestIndex = latestRowId ? textRows.findIndex((row) => row.id === latestRowId) : -1;
  if (latestIndex < 0) latestIndex = textRows.length - 1;

  const burst: StoredMessageRow[] = [textRows[latestIndex]];
  for (let index = latestIndex - 1; index >= 0; index -= 1) {
    const current = textRows[index];
    const next = burst[0];
    const gapMs = new Date(next.created_at ?? 0).getTime() - new Date(current.created_at ?? 0).getTime();
    if (gapMs <= BURST_GAP_SECONDS * 1000) {
      burst.unshift(current);
      continue;
    }
    break;
  }

  return burst;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ ok: true });
  }

  try {
    env("TELEGRAM_BOT_TOKEN");
    const guardianChatId = requiredEnv(["MARK_GROUP_CHAT_ID", "MARK_INTERNAL_CHAT_ID"]);
    const supabaseUrl = requiredEnv(["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]);
    const serviceRoleKey = requiredEnv(["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const update = (await request.json()) as TelegramUpdate;
    const message = update.message;

    if (!message?.chat?.id) {
      return json({ ok: true, ignored: "no_message" });
    }

    const chatId = message.chat.id;
    console.log("incoming-message-received", { chatId, messageId: message.message_id });

    if (String(chatId) === String(guardianChatId)) {
      console.log("mark-internal-group-skipped", { chatId, messageId: message.message_id });
      return json({ ok: true, ignored: "guardian_group" });
    }

    const text = (message.text ?? message.caption ?? "").trim();

    if (!text || shouldIgnoreTelegramMessage(text)) {
      console.log("non-request-message-skipped", { chatId, messageId: message.message_id });
      return json({ ok: true, ignored: "empty_or_reaction" });
    }

    console.log("instant-mark-forward-disabled", { chatId, messageId: message.message_id });

    const { data: storedMessage, error: messageError } = await supabase
      .from("messages")
      .insert({
        telegram_message_id: message.message_id,
        telegram_chat_id: chatId,
        telegram_user_id: message.from?.id ?? null,
        telegram_username: message.from?.username ?? null,
        message_text: text,
        message_type: "client",
        raw_payload: update
      })
      .select("id, created_at, message_text, message_type")
      .single();

    if (messageError) throw new Error(messageError.message);
    const storedMessageRow = storedMessage as StoredMessageRow | null;

    await sleep(DEBOUNCE_WINDOW_SECONDS * 1000);

    const { data: latestMessage, error: latestMessageError } = await supabase
      .from("messages")
      .select("id")
      .eq("telegram_chat_id", chatId)
      .eq("message_type", "client")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestMessageError) throw new Error(latestMessageError.message);
    if (latestMessage?.id && latestMessage.id !== storedMessageRow?.id) {
      console.log("grouped-message-created", { chatId, messageId: message.message_id, ignored: "older_fragment" });
      return json({ ok: true, saved: true, ignored: "older_fragment_waiting_for_latest" });
    }

    const lookbackIso = new Date(Date.now() - BURST_LOOKBACK_MINUTES * 60 * 1000).toISOString();
    const { data: recentMessages, error: recentMessagesError } = await supabase
      .from("messages")
      .select("id, created_at, message_text, message_type")
      .eq("telegram_chat_id", chatId)
      .gte("created_at", lookbackIso)
      .order("created_at", { ascending: true });
    if (recentMessagesError) throw new Error(recentMessagesError.message);

    const burstMessages = buildBurstMessages((recentMessages ?? []) as StoredMessageRow[], storedMessageRow?.id);
    const groupedText = burstMessages.map((row) => row.message_text?.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (!groupedText || isGreetingOnly(groupedText) || !hasRequestSignal(groupedText) || isIncompleteRequestFragment(groupedText)) {
      console.log("non-request-message-skipped", { chatId, messageId: message.message_id, groupedText });
      return json({ ok: true, saved: true, ignored: "non_request" });
    }

    if (burstMessages.length > 1) {
      console.log("grouped-message-created", { chatId, messageId: message.message_id, fragmentCount: burstMessages.length });
    }

    const classification = classifyIntent(groupedText);
    if (!classification.requiresMark || classification.intent === "no_action") {
      console.log("non-request-message-skipped", { chatId, messageId: message.message_id, intent: classification.intent });
      return json({ ok: true, saved: true, ignored: "no_mark_required" });
    }

    const duplicateWindowIso = new Date(Date.now() - 30 * 1000).toISOString();
    const { data: duplicateTicket, error: duplicateTicketError } = await supabase
      .from("tickets")
      .select("id")
      .eq("client_chat_id", chatId)
      .eq("client_original_message", groupedText)
      .gte("created_at", duplicateWindowIso)
      .limit(1)
      .maybeSingle();
    if (duplicateTicketError) throw new Error(duplicateTicketError.message);
    if (duplicateTicket?.id) {
      console.log("duplicate-batch-prevented", { chatId, ticketId: duplicateTicket.id });
      return json({ ok: true, saved: true, duplicateTicketId: duplicateTicket.id });
    }

    const { data: ticket, error: ticketError } = await supabase
      .from("tickets")
      .insert({
        ticket_code: createTicketCode(),
        client_chat_id: chatId,
        client_message_id: storedMessage?.id ?? null,
        client_user_id: message.from?.id ?? null,
        client_username: message.from?.username ?? null,
        intent: classification.intent,
        status: "waiting_mark",
        priority: ["deposit_funds", "refund_request", "payment_issue", "check_policy"].includes(classification.intent) ? "high" : "normal",
        needs_mark: true,
        client_original_message: groupedText,
        extracted_data: classification.extractedData,
        internal_summary: classification.internalSummary,
        holding_message_id: null,
        internal_message_id: null
      })
      .select("id")
      .single();

    if (ticketError) throw new Error(ticketError.message);

    try {
      await writeClientRequestRowToGoogleSheet({
        telegramGroup: message.chat.title?.trim() || String(chatId),
        username: message.from?.username?.trim() || "",
        originalMessage: groupedText,
        parsedMessage: classification.internalSummary || groupedText,
        intent: classification.intent,
        extractedData: classification.extractedData
      });
    } catch (sheetError) {
      console.log("google-sheets-row-write-failed", {
        chatId,
        ticketId: ticket?.id ?? null,
        error: sheetError instanceof Error ? sheetError.message : "Google Sheets write failed."
      });
    }

    console.log("request-added-to-mark-batch", {
      chatId,
      messageId: message.message_id,
      ticketId: ticket?.id ?? null,
      intent: classification.intent
    });
    console.log("client-ack-scheduled", { chatId, ticketId: ticket?.id ?? null });

    return json({ ok: true });
  } catch (error) {
    return json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unexpected telegram webhook error."
      },
      500
    );
  }
});
