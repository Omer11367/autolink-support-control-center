import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { classifyIntent } from "@/lib/intent-classifier";
import { formatIntentLabel } from "@/lib/display";
import { writeClientRequestRowToGoogleSheet } from "@/lib/google-sheets";
import { maybeSendTelegramMessage, maybeSendTelegramPhoto } from "@/lib/telegram";
import type { Database } from "@/lib/supabase/database.types";

type TelegramReplyToMessage = {
  message_id?: number;
  text?: string;
  caption?: string;
};

type TelegramPhotoSize = { file_id: string; width?: number; height?: number; file_size?: number };
type TelegramDocument = { file_id: string; mime_type?: string; file_name?: string };

type TelegramMessageFields = {
  date?: number;
  chat?: { id?: number; title?: string };
  from?: { username?: string };
  reply_to_message?: TelegramReplyToMessage;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
};

type QueuedMessage = {
  id: string;
  created_at: string | null;
  telegram_chat_id: string | number | null;
  telegram_message_id: number | string | null;
  telegram_username: string | null;
  message_text: string | null;
  message_type: string | null;
  raw_payload: {
    message?: TelegramMessageFields;
    edited_message?: TelegramMessageFields;
    channel_post?: TelegramMessageFields;
  } | null;
};

// A photo (or image document) that should be forwarded to Mark after the text summary.
// NEVER include any client-identifying information (chat title, username, etc.) — privacy rule.
type PhotoForward = {
  fileId: string;
  isDeposit: boolean;
};

type BatchTicket = {
  id: string;
  intent: string | null;
  client_chat_id: string | number | null;
  client_message_id?: string | number | null;
  client_original_message: string | null;
  extracted_data: unknown;
  internal_summary: string | null;
  created_at: string | null;
  holding_message_id: string | number | null;
};

type BatchMarkerType = "batch_client_greeting" | "batch_non_request_skipped" | "batch_duplicate_skipped";

type SheetAction = {
  type?: string;
  account?: string;
  accounts?: string[];
  bm?: string;
  amount?: string;
};

type SupabaseAdminClient = SupabaseClient<Database, "public">;
type Classification = ReturnType<typeof classifyIntent>;

type LinkedFollowUpContext = {
  linkedTicketId: string | null;
  linkedClientMessageId: string | number | null;
  replyToTelegramMessageId: string | number | null;
  replyToMessageText: string | null;
  originalMessage: string;
  originalSummary: string;
  intent: string;
  extractedData: Record<string, unknown>;
};

const CATEGORY_ORDER = ["Share", "Unshare", "Deposits", "Payment Issues", "Verification", "Account Issues", "General"] as const;
// Cron fires every 5 min on wall-clock boundaries (:00, :05, :10, …). To make a message
// sent at 1:03 visible to the 1:05 batch, the eligibility cutoff must be tight (1 min).
// A message arriving exactly at 1:04 still passes the 1:05 cutoff (lte 1:04 includes equal).
const BATCH_DELAY_MINUTES = 1;
const MESSAGE_LOOKBACK_MINUTES = 24 * 60;
const BATCH_MARKER_TYPES: BatchMarkerType[] = ["batch_client_greeting", "batch_non_request_skipped", "batch_duplicate_skipped"];
const CLEAN_CLIENT_BATCH_REPLY = "Understood, I'll check and update you.";
const CLIENT_BATCH_REPLY = "Understood, I’ll check and update you.";
const BATCH_REPLY_ENCODING_CHECK = CLIENT_BATCH_REPLY.includes("â");
const USE_CLEAN_CLIENT_BATCH_REPLY = Boolean(CLIENT_BATCH_REPLY) || BATCH_REPLY_ENCODING_CHECK;

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function requireEnv(label: string, names: string[]): string {
  const value = firstEnv(names);
  if (!value) throw new Error(`Missing environment variable: ${label}`);
  return value;
}

function createTicketCode(): string {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().slice(0, 6).toUpperCase();
  return `AL-${stamp}-${suffix}`;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function preserveBatchText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeComparableText(text: string): string {
  return compactText(text).toLowerCase().replace(/[!?.,]+$/g, "");
}

function isPureNonSupportChatter(text: string): boolean {
  const normalized = normalizeComparableText(text);
  const reactionOnly = /^[\s\u{1F44D}\u2764\uFE0F\u2705\u{1F64F}]+$/u.test(text.trim());
  const chatter = ["hi", "hello", "hey", "yo", "good morning", "good evening", "good night", "thanks", "thank you", "thx", "ty", "ok", "okay", "alright", "received", "noted"];
  return reactionOnly || chatter.includes(normalized);
}

function isGreetingText(text: string): boolean {
  const normalized = normalizeComparableText(text);
  return ["hi", "hello", "hey", "yo", "good morning", "good evening", "good night"].includes(normalized);
}

function hasRequestSignal(text: string): boolean {
  const normalized = normalizeComparableText(text);
  return /\b(share|unshare|remove|bm|account|deposit|sent|paid|payment|funds|usdt|usd|verify|verification|disabled|restricted|failed|issue|problem|check|status|availability|replacement|replace|limit|spending|spend|need|request|refund|business|support)\b|\$|\d/.test(normalized);
}

function isIncompleteRequestFragment(text: string): boolean {
  const normalized = normalizeComparableText(text);
  if (!normalized) return true;
  if (/^(?:sent|send|paid|deposit|check|please check|pls check|\$|usd|usdt|dollars?)$/i.test(normalized)) return true;
  if (/^(?:\d+(?:[.,]\d+)?k?|\d+(?:[.,]\d+)?\s*(?:usd|usdt|\$|dollars?))$/i.test(normalized)) return true;
  if (/^(?:bm|business manager)\s+[A-Za-z0-9_-]+$/i.test(normalized)) return true;
  if (/^(?:account|acc|ad account)\s+[A-Za-z0-9_-]+$/i.test(normalized)) return true;
  return false;
}

function isFollowUpText(text: string): boolean {
  const normalized = normalizeComparableText(text);
  return /^(?:any\s+)?updates?$/.test(normalized)
    || /^(?:what(?:'s| is)\s+the\s+)?status$/.test(normalized)
    || /^(?:is\s+it\s+)?done$/.test(normalized)
    || /\b(?:any\s+update|update\??|status\??|done\??)\b/i.test(text)
    || /\bdid\s+you\s+(?:share|unshare|remove|do|finish|complete)\b/i.test(text);
}

function mapIntentToCategory(intent: string | null | undefined): typeof CATEGORY_ORDER[number] {
  const normalized = String(intent || "").toLowerCase();
  if (["share_ad_account", "transfer_ad_account"].includes(normalized)) return "Share";
  if (["unshare_ad_account"].includes(normalized)) return "Unshare";
  if (["deposit_funds"].includes(normalized)) return "Deposits";
  if (["payment_issue", "refund_request"].includes(normalized)) return "Payment Issues";
  if (["verify_account"].includes(normalized)) return "Verification";
  if (["check_account_status", "request_data_banned_accounts", "check_policy"].includes(normalized)) return "Account Issues";
  // site_issue, check_availability, get_spend_report, request_accounts, general_support → General
  return "General";
}

function getActions(extractedData: unknown): SheetAction[] {
  if (!extractedData || typeof extractedData !== "object" || Array.isArray(extractedData)) return [];
  const actions = (extractedData as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return [];
  return actions.filter((action): action is SheetAction => Boolean(action) && typeof action === "object");
}

function extractedObject(extractedData: unknown): Record<string, unknown> {
  if (!extractedData || typeof extractedData !== "object" || Array.isArray(extractedData)) return {};
  return extractedData as Record<string, unknown>;
}

function extractedText(extractedData: unknown, key: string): string | null {
  const value = extractedObject(extractedData)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstAccount(action: SheetAction | undefined): string | null {
  return action?.account ?? action?.accounts?.[0] ?? null;
}

function accountsText(action: SheetAction | undefined): string | null {
  if (!action) return null;
  if (Array.isArray(action.accounts) && action.accounts.length > 0) return action.accounts.join(", ");
  return action.account ?? null;
}

function formatBm(value: string | undefined): string | null {
  if (!value) return null;
  return value.toUpperCase() === "ALL BMS" ? "all BMs" : value;
}

function actionTypeToIntent(action: SheetAction): string {
  if (action.type === "share_account") return "share_ad_account";
  if (action.type === "unshare_account") return "unshare_ad_account";
  if (action.type === "payment_check") return "deposit_funds";
  if (action.type === "verify_account") return "verify_account";
  if (action.type === "account_status_check") return "check_account_status";
  return "general_support";
}

function actionToCategory(action: SheetAction): typeof CATEGORY_ORDER[number] {
  return mapIntentToCategory(actionTypeToIntent(action));
}

function extractAmount(text: string): string | null {
  const match = text.match(/(?:\$|usd\s*)?\d+(?:[,.]\d+)?\s*(?:k|K)?\s*(?:usdt|usd|dollars?|\$)?/i);
  return match?.[0] ? compactText(match[0]).replace(/\s+/g, "") : null;
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"]+/);
  return match?.[0] ?? null;
}

// Returns true when the message text is nothing but a URL (possibly with surrounding whitespace).
// Used during grouping so "sent 30K" + "https://etherscan.io/..." stay in the same Deposits group
// instead of splitting into Deposits + General.
function isUrlOnlyText(text: string): boolean {
  return /^https?:\/\/[^\s]+$/.test(text.trim());
}

// Extracts the largest available photo file_id from a Telegram message payload,
// or the file_id of an image document. Returns null if there is no photo.
function getPhotoFileId(message: QueuedMessage): string | null {
  const tgMsg = getTelegramMessage(message.raw_payload);
  if (tgMsg?.photo && tgMsg.photo.length > 0) {
    // Telegram provides multiple sizes; the last one is always the largest.
    return tgMsg.photo[tgMsg.photo.length - 1].file_id;
  }
  if (tgMsg?.document?.file_id && tgMsg.document.mime_type?.toLowerCase().startsWith("image/")) {
    return tgMsg.document.file_id;
  }
  return null;
}

function extractEntityAfter(text: string, labels: string[]): string | null {
  const labelPattern = labels.map((label) => label.replace(/\s+/g, "\\s+")).join("|");
  const match = text.match(new RegExp(`\\b(?:${labelPattern})\\b\\s*[:#-]?\\s*([A-Za-z0-9_-]+)`, "i"));
  return match?.[1] ?? null;
}

function formatFollowUpTask(followUpMessage: string | null, baseText: string, actionType?: string): string {
  if (!followUpMessage) return baseText;

  const cleanFollowUp = compactText(followUpMessage).replace(/[?!.]+$/g, "");
  if (!cleanFollowUp) return baseText;
  if (/\b(?:any\s+)?update|status|done\b/i.test(cleanFollowUp)) return `${cleanFollowUp} on: ${baseText}`;
  if (actionType === "share_account") return `follow-up on share request: ${baseText}`;
  if (actionType === "unshare_account") return `follow-up on unshare request: ${baseText}`;
  if (actionType === "payment_check") return `follow-up on deposit request: ${baseText}`;
  return `${cleanFollowUp} on: ${baseText}`;
}

function cleanTaskText(ticket: BatchTicket): string {
  const followUpMessage = extractedText(ticket.extracted_data, "followUpMessage");
  const linkedOriginalSummary = extractedText(ticket.extracted_data, "linkedOriginalSummary");
  if (followUpMessage && linkedOriginalSummary) return formatFollowUpTask(followUpMessage, linkedOriginalSummary);

  const category = mapIntentToCategory(ticket.intent);
  // Compact version is used for entity extraction (regex matching).
  // Preserved version is used as fallback display text so multi-line groups (e.g. reply context
  // prepended as "Re: …\nclient reply") show as separate lines in Mark's summary.
  const original = compactText(ticket.client_original_message ?? "");
  const preservedOriginal = preserveBatchText(ticket.client_original_message ?? "");
  const actions = getActions(ticket.extracted_data);
  const shareAction = actions.find((action) => action.type === "share_account");
  const unshareAction = actions.find((action) => action.type === "unshare_account");
  const paymentAction = actions.find((action) => action.type === "payment_check");
  const verifyAction = actions.find((action) => action.type === "verify_account");
  const accountStatusAction = actions.find((action) => action.type === "account_status_check");

  if (category === "Share") {
    const account = firstAccount(shareAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    const bm = formatBm(shareAction?.bm) ?? extractEntityAfter(original, ["bm", "business manager"]);
    if (account && bm) return `share account ${account} to BM ${bm}`;
    if (account) return `share account ${account}`;
    return preservedOriginal || "share account request";
  }

  if (category === "Unshare") {
    const accounts = unshareAction?.accounts?.length ? unshareAction.accounts.join(", ") : null;
    const account = accounts ?? firstAccount(unshareAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    const bm = formatBm(unshareAction?.bm) ?? extractEntityAfter(original, ["bm", "business manager"]);
    if (account && bm) return `unshare accounts ${account} from ${bm}`;
    if (account) return `unshare accounts ${account}`;
    return preservedOriginal || "unshare account request";
  }

  if (category === "Deposits") {
    const amount = paymentAction?.amount ?? extractAmount(original);
    const url = extractFirstUrl(original);
    const baseText = amount ? `sent ${amount}, please check` : "deposit sent, please check";
    // Append the Etherscan / blockchain link so Mark can click it directly from the summary.
    return url ? `${baseText}\n${url}` : baseText;
  }

  if (category === "Payment Issues") {
    const account = firstAccount(accountStatusAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    if (account && /\bfailed\b/i.test(original)) return `payment failed on account ${account}`;
    return account ? `payment issue on account ${account}` : "payment issue reported";
  }

  if (category === "Verification") {
    const bm = extractEntityAfter(original, ["bm", "business manager"]);
    const account = firstAccount(verifyAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    if (bm) return `verify BM ${bm}`;
    return account ? `verify account ${account}` : "verification request";
  }

  if (category === "Account Issues") {
    const account = firstAccount(accountStatusAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    if (account && /\b(disabled|restricted|blocked)\b/i.test(original)) return `account ${account} disabled`;
    return account ? `account issue on account ${account}` : "account issue reported";
  }

  // Return the full original message (line-breaks preserved) so multi-question groups
  // (e.g. "monthly reports?" + "accounts in stock?") and reply-context blocks
  // (e.g. "Re: "Did you share?"\nDid you share those?") display correctly in Mark's summary.
  // Deduplicate consecutive identical lines: if the same message was picked up twice because
  // a previous batch failed without advancing processedThroughMs, the grouped text contains
  // the same line twice (e.g. "do you have accounts?\ndo you have accounts?"). Remove the dupe.
  if (preservedOriginal) {
    const lines = preservedOriginal.split("\n");
    const deduped = lines.filter((line, i) => i === 0 || line.trim() !== lines[i - 1]?.trim());
    return deduped.join("\n");
  }
  return "General support request";
}

function cleanActionTaskText(ticket: BatchTicket, action: SheetAction): string {
  const original = compactText(ticket.client_original_message ?? "");
  const accounts = accountsText(action);
  const followUpMessage = extractedText(ticket.extracted_data, "followUpMessage");
  const linkedOriginalSummary = extractedText(ticket.extracted_data, "linkedOriginalSummary");
  let baseText: string;

  if (action.type === "share_account") {
    const bm = formatBm(action.bm);
    if (accounts && bm) baseText = `share account ${accounts} to BM ${bm}`;
    else if (accounts) baseText = `share account ${accounts}`;
    else baseText = linkedOriginalSummary || original || "share account request";
  } else if (action.type === "unshare_account") {
    const bm = formatBm(action.bm);
    if (accounts && bm) baseText = `unshare accounts ${accounts} from ${bm}`;
    else if (accounts) baseText = `unshare accounts ${accounts}`;
    else baseText = linkedOriginalSummary || original || "unshare account request";
  } else if (action.type === "payment_check") {
    const depositUrl = extractFirstUrl(original);
    baseText = action.amount ? `sent ${action.amount}, please check` : linkedOriginalSummary || "deposit sent, please check";
    if (depositUrl) baseText += `\n${depositUrl}`;
  } else if (action.type === "verify_account") {
    baseText = accounts ? `verify account ${accounts}` : linkedOriginalSummary || "verification request";
  } else if (action.type === "account_status_check") {
    baseText = accounts ? `account issue on account ${accounts}` : linkedOriginalSummary || "account issue reported";
  } else {
    baseText = linkedOriginalSummary || original || "General support request";
  }

  return formatFollowUpTask(followUpMessage, baseText, action.type);
}

function buildMarkSummary(tickets: BatchTicket[]): string {
  const grouped = new Map<typeof CATEGORY_ORDER[number], string[]>();
  for (const category of CATEGORY_ORDER) grouped.set(category, []);
  for (const ticket of tickets) {
    const intentCategory = mapIntentToCategory(ticket.intent);
    const actions = getActions(ticket.extracted_data);

    // When the ticket's intent is unambiguously a problem (Payment Issues, Account Issues),
    // never let an extracted payment_check action drag it into Deposits. The classifier
    // can falsely tag a long account-id number as an "amount" and produce a payment_check
    // action — e.g. "i have payment issue on this acocunts 51781181" was being shown as
    // "* sent 51781181, please check" under DEPOSITS instead of PAYMENT ISSUES.
    if (intentCategory === "Payment Issues" || intentCategory === "Account Issues") {
      grouped.get(intentCategory)?.push(cleanTaskText(ticket));
      continue;
    }

    if (actions.length > 0) {
      for (const action of actions) grouped.get(actionToCategory(action))?.push(cleanActionTaskText(ticket, action));
    } else {
      grouped.get(intentCategory)?.push(cleanTaskText(ticket));
    }
  }

  const headings: Record<typeof CATEGORY_ORDER[number], string> = {
    Share: "SHARE REQUESTS",
    Unshare: "UNSHARE REQUESTS",
    Deposits: "DEPOSITS",
    "Payment Issues": "PAYMENT ISSUES",
    Verification: "VERIFICATION",
    "Account Issues": "ACCOUNT ISSUES",
    General: "GENERAL QUESTIONS"
  };

  const sections = CATEGORY_ORDER
    .map((category) => {
      const items = grouped.get(category) ?? [];
      if (items.length === 0) return null;
      return [headings[category], ...items.map((item) => `* ${escapeTelegramHtml(item)}`)].join("\n\n");
    })
    .filter(Boolean);

  return ["\u{1F4CC} NEW REQUESTS BATCH", ...sections].join("\n\n");
}

function chooseClientReply(tickets: BatchTicket[]): string {
  const categories = tickets.map((ticket) => mapIntentToCategory(ticket.intent));
  const intents = tickets.map((ticket) => String(ticket.intent ?? ""));

  // Priority order: most action-required categories first.
  if (categories.includes("Deposits")) return "Got it! We received your deposit — we'll verify and confirm shortly.";
  if (categories.includes("Payment Issues")) return "Got it, we'll look into the payment issue and get back to you.";
  if (categories.includes("Share") && categories.includes("Unshare")) return "Sure, we'll handle your account requests and update you.";
  if (categories.includes("Share")) return "Sure, we'll take care of the share request and update you.";
  if (categories.includes("Unshare")) return "Sure, we'll process the unshare request and update you.";
  if (categories.includes("Verification")) return "Got it, we'll check the verification and update you.";
  if (categories.includes("Account Issues")) return "Got it, we'll look into the account issue and update you.";

  // General category — pick a reply based on the specific intent so clients get a useful response.
  if (intents.some((i) => i === "site_issue")) {
    return "We're looking into the site issue and will update you shortly.";
  }
  if (intents.some((i) => i === "check_availability")) {
    return "Thanks for reaching out! We'll check on availability and get back to you shortly.";
  }
  if (intents.some((i) => i === "get_spend_report")) {
    return "Got it, we'll pull the report and send it to you shortly.";
  }
  // Mixed or truly general
  return "Got it, we'll look into this and get back to you shortly.";
}

function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getTelegramMessage(update: QueuedMessage["raw_payload"]) {
  return update?.message ?? update?.edited_message ?? update?.channel_post ?? null;
}

function getReplyToMessage(message: QueuedMessage): TelegramReplyToMessage | null {
  return getTelegramMessage(message.raw_payload)?.reply_to_message ?? null;
}

function getReplyText(replyToMessage: TelegramReplyToMessage | null): string | null {
  const value = (replyToMessage?.text ?? replyToMessage?.caption ?? "").trim();
  return value || null;
}

function getTelegramMessageDate(message: QueuedMessage): Date {
  const telegramDate = getTelegramMessage(message.raw_payload)?.date;
  if (typeof telegramDate === "number" && Number.isFinite(telegramDate)) {
    return new Date(telegramDate * 1000);
  }

  return message.created_at ? new Date(message.created_at) : new Date();
}

function getChatTitle(message: QueuedMessage): string {
  const telegramMessage = getTelegramMessage(message.raw_payload);
  return telegramMessage?.chat?.title?.trim() || String(message.telegram_chat_id ?? "");
}

function getUsername(message: QueuedMessage): string {
  const telegramMessage = getTelegramMessage(message.raw_payload);
  return telegramMessage?.from?.username?.trim() || message.telegram_username?.trim() || "";
}

function chooseGreetingReply(messages: QueuedMessage[]): string {
  const text = messages.map((message) => message.message_text ?? "").join(" ");
  if (/good morning/i.test(text)) return "Good morning, how can I help?";
  if (/good evening|good night/i.test(text)) return "Good evening, how can I help?";
  return "Hi, how can I help?";
}

function isOpenTicketStatus(status: string | null | undefined): boolean {
  return ["open", "new", "waiting_mark", "waiting_for_mark"].includes(status ?? "");
}

function summarizeTicketContext(ticket: BatchTicket): string {
  const actions = getActions(ticket.extracted_data);
  if (actions.length > 0) return actions.map((action) => cleanActionTaskText(ticket, action)).join("; ");
  return cleanTaskText(ticket);
}

function buildFollowUpTicketMessage(followUpMessage: string, context: LinkedFollowUpContext): string {
  return [
    `Follow-up: ${compactText(followUpMessage)}`,
    `Original context: ${context.originalSummary}`,
    context.originalMessage ? `Original message: ${compactText(context.originalMessage)}` : ""
  ].filter(Boolean).join("\n\n");
}

function withFollowUpContext(classification: Classification, followUpMessage: string, context: LinkedFollowUpContext): Classification {
  const originalActions = getActions(context.extractedData);
  const currentData = extractedObject(classification.extractedData);
  const originalData = extractedObject(context.extractedData);
  const intent = context.intent || classification.intent || "general_support";
  const actionSummary = context.originalSummary || context.originalMessage || "original request";

  return {
    ...classification,
    intent,
    humanLabel: formatIntentLabel(intent),
    confidence: "high",
    requiresMark: true,
    shouldReply: true,
    closeConversation: false,
    extractedData: {
      ...currentData,
      ...originalData,
      actions: originalActions.length ? originalActions : getActions(classification.extractedData),
      followUp: true,
      followUpMessage: compactText(followUpMessage),
      linkedOriginalSummary: actionSummary,
      linkedOriginalMessage: context.originalMessage,
      linkedTicketId: context.linkedTicketId,
      linkedClientMessageId: context.linkedClientMessageId,
      replyToTelegramMessageId: context.replyToTelegramMessageId,
      replyToMessageText: context.replyToMessageText,
      category: mapIntentToCategory(intent)
    },
    internalSummary: `Follow-up: "${compactText(followUpMessage)}". Original context: ${actionSummary}. Detected intent: ${formatIntentLabel(intent)}. Requires Mark: yes.`,
    matchedRules: [
      "Follow-up detected from Telegram reply context or existing open client request.",
      ...(classification.matchedRules ?? [])
    ]
  };
}

async function findFollowUpContext(
  supabase: SupabaseAdminClient,
  chatId: string,
  messages: QueuedMessage[],
  groupedText: string
): Promise<LinkedFollowUpContext | null> {
  const replyTo = messages.map(getReplyToMessage).find((reply): reply is TelegramReplyToMessage => Boolean(reply?.message_id));
  const replyToTelegramMessageId = replyTo?.message_id ?? null;
  const replyToText = getReplyText(replyTo ?? null);
  const hasFollowUpSignal = isFollowUpText(groupedText);
  if (!replyToTelegramMessageId && !hasFollowUpSignal) return null;

  const { data: ticketRows, error: ticketsError } = await supabase
    .from("tickets")
    .select("id, intent, client_chat_id, client_message_id, client_original_message, extracted_data, internal_summary, created_at, holding_message_id, status")
    .eq("client_chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (ticketsError) throw new Error(`Supabase follow-up ticket lookup failed: ${ticketsError.message}`);

  const tickets = (ticketRows ?? []) as Array<BatchTicket & { status?: string | null }>;
  let linkedTicket: (BatchTicket & { status?: string | null }) | null = null;
  let linkedClientMessageId: string | number | null = null;
  let linkedOriginalMessage = replyToText ?? "";

  if (replyToTelegramMessageId) {
    const { data: botResponse, error: botResponseError } = await supabase
      .from("bot_responses")
      .select("ticket_id, response_text")
      .eq("telegram_chat_id", chatId)
      .eq("telegram_message_id", replyToTelegramMessageId)
      .limit(1)
      .maybeSingle();
    if (botResponseError) throw new Error(`Supabase follow-up bot response lookup failed: ${botResponseError.message}`);

    const botTicketId = (botResponse as { ticket_id?: string | null } | null)?.ticket_id;
    if (botTicketId) {
      linkedTicket = tickets.find((ticket) => ticket.id === botTicketId) ?? null;
      if (!linkedTicket) {
        const { data: ticketById, error: ticketByIdError } = await supabase
          .from("tickets")
          .select("id, intent, client_chat_id, client_message_id, client_original_message, extracted_data, internal_summary, created_at, holding_message_id, status")
          .eq("id", botTicketId)
          .maybeSingle();
        if (ticketByIdError) throw new Error(`Supabase follow-up linked ticket lookup failed: ${ticketByIdError.message}`);
        linkedTicket = ticketById as (BatchTicket & { status?: string | null }) | null;
      }
    }

    if (!linkedTicket) {
      const { data: repliedMessage, error: repliedMessageError } = await supabase
        .from("messages")
        .select("id, message_text")
        .eq("telegram_chat_id", chatId)
        .eq("telegram_message_id", replyToTelegramMessageId)
        .limit(1)
        .maybeSingle();
      if (repliedMessageError) throw new Error(`Supabase replied message lookup failed: ${repliedMessageError.message}`);

      const repliedRow = repliedMessage as { id?: string | null; message_text?: string | null } | null;
      linkedClientMessageId = repliedRow?.id ?? null;
      linkedOriginalMessage = repliedRow?.message_text ?? replyToText ?? "";
      linkedTicket = linkedClientMessageId
        ? tickets.find((ticket) => String(ticket.client_message_id ?? "") === String(linkedClientMessageId)) ?? null
        : null;

      if (!linkedTicket && linkedOriginalMessage) {
        const normalizedReply = compactText(linkedOriginalMessage).toLowerCase();
        linkedTicket = tickets.find((ticket) => compactText(ticket.client_original_message ?? "").toLowerCase().includes(normalizedReply)) ?? null;
      }
    }
  }

  if (!linkedTicket && hasFollowUpSignal) {
    linkedTicket = tickets.find((ticket) => isOpenTicketStatus(ticket.status)) ?? tickets[0] ?? null;
  }

  if (!linkedTicket && !linkedOriginalMessage) return null;

  const sourceTicket = linkedTicket;
  const originalMessage = sourceTicket?.client_original_message ?? linkedOriginalMessage;
  const extractedData = extractedObject(sourceTicket?.extracted_data);
  const originalSummary = sourceTicket ? summarizeTicketContext(sourceTicket) : compactText(linkedOriginalMessage);

  return {
    linkedTicketId: sourceTicket?.id ?? null,
    linkedClientMessageId: sourceTicket?.client_message_id ?? linkedClientMessageId,
    replyToTelegramMessageId,
    replyToMessageText: replyToText,
    originalMessage,
    originalSummary,
    intent: sourceTicket?.intent ?? "general_support",
    extractedData
  };
}

async function getLastBatchMarkerMs(supabase: SupabaseAdminClient, chatId: string): Promise<number> {
  const { data, error } = await supabase
    .from("bot_responses")
    .select("created_at, response_text")
    .eq("telegram_chat_id", chatId)
    .in("response_type", BATCH_MARKER_TYPES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Supabase batch marker query failed: ${error.message}`);
  if (!data?.created_at) return 0;
  // Use the stored last-message timestamp rather than the row insertion time.
  // The insertion time can be minutes ahead of the actual messages, causing those
  // messages to be permanently excluded from future batches.
  const msgMsMatch = (data.response_text ?? "").match(/\|lastMsgMs:(\d+)/);
  if (msgMsMatch?.[1]) return parseInt(msgMsMatch[1], 10);
  return new Date(data.created_at).getTime();
}

async function markChatBatchProcessed(
  supabase: SupabaseAdminClient,
  chatId: string,
  responseType: BatchMarkerType,
  responseText: string,
  telegramMessageId: number | null = null,
  lastMessageMs: number = 0
) {
  const storedText = lastMessageMs > 0 ? `${responseText}|lastMsgMs:${lastMessageMs}` : responseText;
  await supabase.from("bot_responses").insert({
    ticket_id: null,
    telegram_chat_id: chatId,
    telegram_message_id: telegramMessageId,
    response_type: responseType,
    response_text: storedText
  });
}

type ChatError = { chatId: string; error: string };

async function createTicketsFromQueuedMessages(
  supabase: SupabaseAdminClient,
  messages: QueuedMessage[]
): Promise<{ tickets: BatchTicket[]; photoForwards: PhotoForward[]; chatErrors: ChatError[] }> {
  const messagesByChat = new Map<string, QueuedMessage[]>();
  for (const message of messages) {
    if (!message.telegram_chat_id) continue;
    const key = String(message.telegram_chat_id);
    messagesByChat.set(key, [...(messagesByChat.get(key) ?? []), message]);
  }

  const createdTickets: BatchTicket[] = [];
  const allPhotoForwards: PhotoForward[] = [];
  const chatErrors: ChatError[] = [];
  for (const [chatId, chatMessages] of messagesByChat.entries()) {
    try {
    const { data: latestTicketData, error: latestTicketError } = await supabase
      .from("tickets")
      .select("client_message_id")
      .eq("client_chat_id", chatId)
      .not("client_message_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestTicketError) throw new Error(`Supabase latest ticket query failed: ${latestTicketError.message}`);
    const latestTicket = latestTicketData as { client_message_id: string | null } | null;

    let processedThroughMs = 0;
    if (latestTicket?.client_message_id) {
      const { data: processedMessageData, error: processedMessageError } = await supabase
        .from("messages")
        .select("created_at")
        .eq("id", latestTicket.client_message_id)
        .maybeSingle();
      if (processedMessageError) throw new Error(`Supabase processed message query failed: ${processedMessageError.message}`);
      const processedMessage = processedMessageData as { created_at: string | null } | null;
      processedThroughMs = processedMessage?.created_at ? new Date(processedMessage.created_at).getTime() : 0;
    }
    processedThroughMs = Math.max(processedThroughMs, await getLastBatchMarkerMs(supabase, chatId));

    const unprocessedMessages = chatMessages.filter((message) => {
      const createdAtMs = message.created_at ? new Date(message.created_at).getTime() : 0;
      return createdAtMs > processedThroughMs;
    });
    if (unprocessedMessages.length === 0) continue;

    const sortedUnprocessed = unprocessedMessages.sort(
      (a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime()
    );
    // Track the latest message timestamp so batch markers store message time,
    // not insertion time — prevents future messages from being permanently excluded.
    const lastMessageMs = Math.max(
      ...sortedUnprocessed.map((m) => (m.created_at ? new Date(m.created_at).getTime() : 0))
    );

    // Build a set of telegram_message_ids present in this batch so we can detect cross-batch replies.
    const batchTelegramMsgIds = new Set(
      sortedUnprocessed.map((m) => (m.telegram_message_id != null ? String(m.telegram_message_id) : "")).filter(Boolean)
    );

    // ── Step 1: classify each message individually and apply reply context ──────────────────────
    // Each message gets its own intent so that a batch containing BOTH "do you have GH accounts?"
    // (General) AND "please share 123 to BM 456" (Share) produces two separate tickets and two
    // separate sections in Mark's summary, rather than one ticket that picks only the dominant intent.
    type PerMessageItem = {
      message: QueuedMessage;
      text: string;
      category: typeof CATEGORY_ORDER[number];
      intent: string;
    };

    const perMessageItems: PerMessageItem[] = [];
    for (const message of sortedUnprocessed) {
      const rawText = preserveBatchText(message.message_text ?? "");
      // Detect cross-batch replies: client replied to a message from a previous batch window.
      const replyTo = getReplyToMessage(message);
      const replyText = getReplyText(replyTo);
      const replyTargetId = replyTo?.message_id != null ? String(replyTo.message_id) : null;
      const isCrossBatchReply = Boolean(replyText && replyTargetId && !batchTelegramMsgIds.has(replyTargetId));
      const text = isCrossBatchReply && rawText ? `Re: "${replyText}"\n${rawText}` : rawText;

      // Photo messages with no real caption (just the bot's placeholder) should NOT be
      // classified on their own — the placeholder "Image/screenshot sent by client." contains
      // the word "sent" which falsely triggers deposit detection and creates a duplicate
      // "deposit sent, please check" ticket alongside the real "sent 50K" ticket.
      // We skip them here; their file_id is collected later during grouping.
      const isPhotoWithoutCaption = message.message_type === "client_photo" &&
        (!text || /^image\/screenshot sent by client\.?$/i.test(text.trim()));
      if (isPhotoWithoutCaption) continue;

      if (!text || isPureNonSupportChatter(text)) continue;

      const singleClassification = classifyIntent(text);
      const category = mapIntentToCategory(singleClassification.intent);
      perMessageItems.push({ message, text, category, intent: singleClassification.intent });
    }

    // ── Step 2: handle all-chatter case (greetings, non-support) ───────────────────────────────
    if (perMessageItems.length === 0) {
      console.log("non-request-message-skipped", { chatId, messageCount: unprocessedMessages.length });
      const messageTexts = unprocessedMessages.map((m) => compactText(m.message_text ?? "")).filter(Boolean);
      if (messageTexts.some(isGreetingText)) {
        const reply = chooseGreetingReply(sortedUnprocessed);
        const greetingResult = await maybeSendTelegramMessage({ chatId, text: reply, source: "telegram_batch" });
        await markChatBatchProcessed(supabase, chatId, "batch_client_greeting", reply, greetingResult.telegramMessageId, lastMessageMs);
        console.log("client-greeting-sent", { chatId, messageCount: unprocessedMessages.length });
      } else {
        await markChatBatchProcessed(supabase, chatId, "batch_non_request_skipped", "non-support chatter skipped", null, lastMessageMs);
      }
      continue;
    }

    // ── Step 3: group consecutive messages that share the same category ─────────────────────────
    // Consecutive messages belonging to the same category are merged (e.g. two lines of a share
    // request). A category switch starts a new group (e.g. General → Share → General).
    // Special rule: a message that is ONLY a URL (e.g. an Etherscan link following "sent 30K")
    // inherits the previous group's category so the link stays with the deposit, not General.
    type MessageGroup = { texts: string[]; messages: QueuedMessage[]; category: typeof CATEGORY_ORDER[number] };
    const messageGroups: MessageGroup[] = [];
    const chatPhotoForwards: PhotoForward[] = [];

    for (const item of perMessageItems) {
      const lastGroup = messageGroups[messageGroups.length - 1];
      // URL-only messages (Etherscan links etc.) belong to whatever came before them.
      const effectiveCategory = (lastGroup && isUrlOnlyText(item.text)) ? lastGroup.category : item.category;
      if (lastGroup && lastGroup.category === effectiveCategory) {
        lastGroup.texts.push(item.text);
        lastGroup.messages.push(item.message);
      } else {
        messageGroups.push({ texts: [item.text], messages: [item.message], category: effectiveCategory });
      }
    }

    // Collect photos from ALL messages in this batch (including caption-less photo messages
    // that were excluded from classification). Only mark them as deposit evidence when the
    // chat has at least one Deposits group — this prevents random non-receipt screenshots
    // (marketing images, etc.) from being forwarded to Mark.
    const chatHasDeposit = messageGroups.some((g) => g.category === "Deposits");
    for (const message of sortedUnprocessed) {
      const photoFileId = getPhotoFileId(message);
      if (photoFileId && chatHasDeposit) {
        chatPhotoForwards.push({ fileId: photoFileId, isDeposit: true });
      }
    }

    // ── Step 4: create one ticket per category group ────────────────────────────────────────────
    const duplicateStartIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let ticketsCreatedForChat = 0;

    for (const group of messageGroups) {
      const groupedText = preserveBatchText(group.texts.join("\n"));
      if (!groupedText) continue;

      if (!hasRequestSignal(groupedText)) {
        console.log("unclear-batch-forwarded-as-general", { chatId, category: group.category });
      }

      if (isIncompleteRequestFragment(groupedText)) {
        console.log("support-fragment-held-for-next-batch", { chatId, groupedText });
        continue;
      }

      console.log("grouped-message-created", { chatId, category: group.category, messageCount: group.messages.length });
      const linkedContext = await findFollowUpContext(supabase, chatId, group.messages, groupedText);
      const isLinkedFollowUp = Boolean(linkedContext && isFollowUpText(groupedText));
      // Never pass previousContext to the base classification.
      // If we did (e.g. linkedContext.originalMessage = "sent 50K" from a previous deposit),
      // classifyIntent would combine that old deposit text with the current message, causing
      // hasDepositPriority() to fire and override the real intent — e.g. a site-down question
      // would be misclassified as deposit_funds. The linkedContext is used AFTER classification
      // to enrich the ticket's metadata, not to influence what the message is about.
      const baseClassification = classifyIntent(groupedText);
      const classification = linkedContext
        ? isLinkedFollowUp
          ? withFollowUpContext(baseClassification, groupedText, linkedContext)
          : {
              ...baseClassification,
              extractedData: {
                ...extractedObject(baseClassification.extractedData),
                linkedOriginalSummary: linkedContext.originalSummary,
                linkedOriginalMessage: linkedContext.originalMessage,
                linkedTicketId: linkedContext.linkedTicketId,
                linkedClientMessageId: linkedContext.linkedClientMessageId,
                replyToTelegramMessageId: linkedContext.replyToTelegramMessageId,
                replyToMessageText: linkedContext.replyToMessageText
              },
              internalSummary: `${baseClassification.internalSummary} Linked context: ${linkedContext.originalSummary}.`
            }
        : baseClassification;

      const storedClientMessage = linkedContext ? buildFollowUpTicketMessage(groupedText, linkedContext) : groupedText;

      if (!classification.requiresMark || classification.intent === "no_action") {
        console.log("non-request-group-skipped", { chatId, category: group.category, intent: classification.intent });
        continue;
      }

      const { data: duplicateTicketData, error: duplicateError } = await supabase
        .from("tickets")
        .select("id")
        .eq("client_chat_id", chatId)
        .eq("client_original_message", storedClientMessage)
        .gte("created_at", duplicateStartIso)
        .limit(1)
        .maybeSingle();
      if (duplicateError) throw new Error(`Supabase duplicate ticket query failed: ${duplicateError.message}`);
      const duplicateTicket = duplicateTicketData as { id: string } | null;
      if (duplicateTicket?.id) {
        console.log("duplicate-batch-prevented", { chatId, ticketId: duplicateTicket.id });
        ticketsCreatedForChat++; // count as handled so we don't add a spurious skip marker
        continue;
      }

      const latestGroupMessage = group.messages[group.messages.length - 1];
      if (!latestGroupMessage) continue;
      const messageTime = getTelegramMessageDate(latestGroupMessage);

      const { data: createdTicketData, error: createTicketError } = await supabase
        .from("tickets")
        .insert({
          ticket_code: createTicketCode(),
          client_chat_id: chatId,
          client_message_id: latestGroupMessage.id ?? null,
          client_user_id: null,
          client_username: getUsername(latestGroupMessage),
          intent: classification.intent,
          status: "waiting_mark",
          priority: ["deposit_funds", "refund_request", "payment_issue", "check_policy"].includes(classification.intent) ? "high" : "normal",
          needs_mark: true,
          client_original_message: storedClientMessage,
          extracted_data: { ...extractedObject(classification.extractedData), chatTitle: getChatTitle(latestGroupMessage) ?? null },
          internal_summary: classification.internalSummary,
          holding_message_id: null,
          internal_message_id: null,
          created_at: messageTime.toISOString(),
          updated_at: messageTime.toISOString()
        })
        .select("id, intent, client_chat_id, client_message_id, client_original_message, extracted_data, internal_summary, created_at")
        .single();
      const createdTicket = createdTicketData as BatchTicket | null;
      if (createTicketError || !createdTicket?.id) {
        throw new Error(`Supabase tickets insert failed: ${createTicketError?.message ?? "Unknown error"}`);
      }

      try {
        const sheetActions = getActions(classification.extractedData);
        const sheetRows = sheetActions.length > 0 ? sheetActions : [null];
        for (const action of sheetRows) {
          const extractedData = action ? { ...classification.extractedData, actions: [action] } : classification.extractedData;
          await writeClientRequestRowToGoogleSheet({
            telegramGroup: getChatTitle(latestGroupMessage),
            username: getUsername(latestGroupMessage),
            originalMessage: storedClientMessage,
            parsedMessage: action ? cleanActionTaskText(createdTicket, action) : classification.internalSummary || groupedText,
            intent: action ? actionTypeToIntent(action) : classification.intent,
            status: "Pending",
            extractedData,
            now: messageTime
          });
        }
        console.log("google-sheets-row-write-success", { chatId, ticketId: createdTicket.id });
      } catch (error) {
        console.log("google-sheets-write-failed", {
          chatId,
          ticketId: createdTicket.id,
          error: error instanceof Error ? error.message : "Google Sheets write failed."
        });
      }

      console.log("request-added-to-mark-batch", { chatId, ticketId: createdTicket.id, intent: classification.intent });
      createdTickets.push(createdTicket as BatchTicket);
      ticketsCreatedForChat++;
    }

    // If all groups were no-action / fragments, mark the chat so processedThroughMs advances.
    if (ticketsCreatedForChat === 0) {
      await markChatBatchProcessed(supabase, chatId, "batch_non_request_skipped", "no-action batch skipped", null, lastMessageMs);
    }

    // Accumulate photo forwards for this chat (only when at least one ticket was created,
    // so we don't spam Mark with photos from non-support messages).
    if (ticketsCreatedForChat > 0) {
      allPhotoForwards.push(...chatPhotoForwards);
    }
    } catch (chatError) {
      // Per-chat isolation: one failing chat must not block other chats from being processed.
      // Without this, a single bad query (e.g. a duplicate ticket race, a sheets API hiccup)
      // would silently kill the rest of the batch — symptoms exactly like BluePeak / NovaAds
      // never getting a reply while Client Test Group did.
      const errorMessage = chatError instanceof Error ? chatError.message : "unknown error";
      console.error("chat-batch-failed", {
        chatId,
        error: errorMessage,
        stack: chatError instanceof Error ? chatError.stack : undefined
      });
      chatErrors.push({ chatId, error: errorMessage });
    }
  }

  return { tickets: createdTickets, photoForwards: allPhotoForwards, chatErrors };
}

async function handleBatch(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  console.log("mark-batch-start");

  requireEnv("TELEGRAM_BOT_TOKEN", ["TELEGRAM_BOT_TOKEN"]);
  const markGroupChatId = requireEnv("MARK_GROUP_CHAT_ID or MARK_INTERNAL_CHAT_ID", ["MARK_GROUP_CHAT_ID", "MARK_INTERNAL_CHAT_ID"]);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL", ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]);
  const serviceRoleKey = requireEnv("SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY", ["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);

  const supabase = createClient<Database, "public">(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const batchCutoffIso = new Date(Date.now() - BATCH_DELAY_MINUTES * 60 * 1000).toISOString();
  const messageStartIso = new Date(Date.now() - MESSAGE_LOOKBACK_MINUTES * 60 * 1000).toISOString();
  const { data: queuedMessagesData, error: queuedMessagesError } = await supabase
    .from("messages")
    .select("id, created_at, telegram_chat_id, telegram_message_id, telegram_username, message_text, message_type, raw_payload")
    .gte("created_at", messageStartIso)
    .lte("created_at", batchCutoffIso)
    .in("message_type", ["client", "client_photo"])
    .order("created_at", { ascending: true })
    .limit(500);
  if (queuedMessagesError) throw new Error(`Supabase queued messages query failed: ${queuedMessagesError.message}`);

  const { tickets: createdTickets, photoForwards, chatErrors } = await createTicketsFromQueuedMessages(supabase, (queuedMessagesData ?? []) as unknown as QueuedMessage[]);
  if (chatErrors.length > 0) {
    console.error("batch-had-chat-errors", { count: chatErrors.length, errors: chatErrors });
  }

  const { data, error } = await supabase
    .from("tickets")
    .select("id, intent, client_chat_id, client_original_message, extracted_data, internal_summary, created_at, holding_message_id")
    .eq("needs_mark", true)
    .in("status", ["open", "new", "waiting_mark", "waiting_for_mark"])
    .is("internal_message_id", null)
    .lte("created_at", batchCutoffIso)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw new Error(`Supabase tickets batch query failed: ${error.message}`);

  const pendingTickets = (data ?? []) as BatchTicket[];
  const seenTicketIds = new Set(createdTickets.map((ticket) => ticket.id));
  const tickets = [
    ...createdTickets,
    ...pendingTickets.filter((ticket) => !seenTicketIds.has(ticket.id))
  ];
  console.log("mark-batch-found-requests", { count: tickets.length });
  if (tickets.length === 0) {
    console.log("mark-batch-no-requests");
    return NextResponse.json({ ok: true, count: 0 });
  }

  console.log("mark-batch-ready", { count: tickets.length });

  // Send the combined batch summary to Mark's group (one message with all requests grouped
  // by category — exactly as before). The Telegram message_id is stored as internal_message_id
  // on every ticket in this batch so the webhook can look them all up when an employee replies.
  const markSummary = buildMarkSummary(tickets);
  const markSendResult = await maybeSendTelegramMessage({ chatId: markGroupChatId, text: markSummary, source: "telegram_batch" });
  if (!markSendResult.sent || !markSendResult.telegramMessageId) {
    throw new Error(markSendResult.reason ?? "Mark batch summary was not sent.");
  }
  console.log("mark-batch-sent", { count: tickets.length, telegramMessageId: markSendResult.telegramMessageId });

  await supabase.from("bot_responses").insert({
    ticket_id: tickets[0]?.id ?? null,
    telegram_chat_id: markGroupChatId,
    telegram_message_id: markSendResult.telegramMessageId,
    response_type: "batch_mark_summary",
    response_text: markSummary
  });

  // Forward deposit evidence photos to Mark as follow-up messages after the text summary.
  // Only deposit-related photos are forwarded (non-deposit screenshots are never sent).
  // NO client-identifying info (group name, username) is included in the caption — privacy rule.
  for (const photo of photoForwards) {
    if (!photo.isDeposit) continue;
    try {
      await maybeSendTelegramPhoto({ chatId: markGroupChatId, fileId: photo.fileId, caption: "📸 Deposit screenshot", source: "telegram_batch" });
      console.log("deposit-photo-forwarded-to-mark");
    } catch (err) {
      console.error("photo-forward-failed", { error: err instanceof Error ? err.message : "unknown" });
    }
  }

  // Client replies are driven ONLY by tickets created in THIS batch run.
  // Old pending tickets (internal_message_id still null from a previous failed batch) were
  // already replied to in their own batch — including them here would send a second reply
  // hours later, and worse, a stuck deposit ticket could override a fresh site-issue reply.
  const ticketsByClient = new Map<string, BatchTicket[]>();
  for (const ticket of createdTickets) {
    if (!ticket.client_chat_id || ticket.holding_message_id) continue;
    const key = String(ticket.client_chat_id);
    ticketsByClient.set(key, [...(ticketsByClient.get(key) ?? []), ticket]);
  }

  let clientReplyCount = 0;
  for (const [clientChatId, clientTickets] of ticketsByClient.entries()) {
    try {
      const clientReply = chooseClientReply(clientTickets);
      const clientSendResult = await maybeSendTelegramMessage({ chatId: clientChatId, text: clientReply, source: "telegram_batch" });
      clientReplyCount += 1;

      await supabase.from("bot_responses").insert({
        ticket_id: clientTickets[0]?.id ?? null,
        telegram_chat_id: clientChatId,
        telegram_message_id: clientSendResult.telegramMessageId,
        response_type: "batch_client_reply",
        response_text: clientReply
      });

      await supabase
        .from("tickets")
        .update({ holding_message_id: clientSendResult.telegramMessageId, updated_at: new Date().toISOString() })
        .in("id", clientTickets.map((ticket) => ticket.id))
        .is("holding_message_id", null);
      console.log("client-ack-sent", { clientChatId, ticketCount: clientTickets.length });
    } catch (error) {
      console.error("telegram-batch-client-reply-error", {
        clientChatId,
        error: error instanceof Error ? error.message : "Client batch reply failed."
      });
    }
  }

  // Stamp every ticket in this batch with the combined summary's Telegram message_id.
  // The webhook uses this shared ID to find all tickets when an employee replies to the summary.
  for (const ticket of tickets) {
    const { data: processedTicket, error: updateError } = await supabase
      .from("tickets")
      .update({ internal_message_id: markSendResult.telegramMessageId, updated_at: new Date().toISOString() })
      .eq("id", ticket.id)
      .is("internal_message_id", null)
      .select("id");
    if (updateError) {
      console.error("supabase-update-error", { table: "tickets", ticketId: ticket.id, message: updateError.message });
      continue;
    }
    if (!processedTicket || processedTicket.length === 0) {
      console.log("duplicate-batch-prevented", { ticketId: ticket.id });
      continue;
    }
    console.log("mark-batch-request-marked-sent", { ticketId: ticket.id });
  }

  return NextResponse.json({
    ok: true,
    count: tickets.length,
    clientGroups: clientReplyCount,
    // Expose per-chat errors so they're visible in the Vercel function response
    // without needing to dig through server logs.
    chatErrors: chatErrors.length > 0 ? chatErrors : undefined
  });
}

export async function GET(request: Request) {
  try {
    return await handleBatch(request);
  } catch (error) {
    console.error("telegram-batch-error", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unexpected telegram batch error." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
