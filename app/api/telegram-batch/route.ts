import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { classifyIntent } from "@/lib/intent-classifier";
import { writeClientRequestRowToGoogleSheet } from "@/lib/google-sheets";
import { maybeSendTelegramMessage } from "@/lib/telegram";

type QueuedMessage = {
  id: string;
  created_at: string | null;
  telegram_chat_id: string | number | null;
  telegram_username: string | null;
  message_text: string | null;
  message_type: string | null;
  raw_payload: {
    message?: {
      chat?: { id?: number; title?: string };
      from?: { username?: string };
    };
    edited_message?: {
      chat?: { id?: number; title?: string };
      from?: { username?: string };
    };
    channel_post?: {
      chat?: { id?: number; title?: string };
      from?: { username?: string };
    };
  } | null;
};

type BatchTicket = {
  id: string;
  intent: string | null;
  client_chat_id: string | number | null;
  client_original_message: string | null;
  extracted_data: unknown;
  internal_summary: string | null;
  created_at: string | null;
  holding_message_id: string | number | null;
};

type SheetAction = {
  type?: string;
  account?: string;
  accounts?: string[];
  bm?: string;
  amount?: string;
};

const CATEGORY_ORDER = ["Share", "Unshare", "Deposits", "Payment Issues", "Verification", "Account Issues", "General"] as const;
const BATCH_DELAY_MINUTES = 5;
const MESSAGE_LOOKBACK_MINUTES = 15;
const CLIENT_BATCH_REPLY = "Understood, I’ll check and update you.";

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

function normalizeComparableText(text: string): string {
  return compactText(text).toLowerCase().replace(/[!?.,]+$/g, "");
}

function isPureNonSupportChatter(text: string): boolean {
  const normalized = normalizeComparableText(text);
  const reactionOnly = /^[\s\u{1F44D}\u2764\uFE0F\u2705\u{1F64F}]+$/u.test(text.trim());
  const chatter = ["hi", "hello", "hey", "yo", "good morning", "good evening", "good night", "thanks", "thank you", "thx", "ty", "ok", "okay", "alright", "received", "noted"];
  return reactionOnly || chatter.includes(normalized);
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

function mapIntentToCategory(intent: string | null | undefined): typeof CATEGORY_ORDER[number] {
  const normalized = String(intent || "").toLowerCase();
  if (["share_ad_account", "transfer_ad_account"].includes(normalized)) return "Share";
  if (["unshare_ad_account"].includes(normalized)) return "Unshare";
  if (["deposit_funds"].includes(normalized)) return "Deposits";
  if (["payment_issue", "refund_request"].includes(normalized)) return "Payment Issues";
  if (["verify_account"].includes(normalized)) return "Verification";
  if (["check_account_status", "request_data_banned_accounts", "check_policy"].includes(normalized)) return "Account Issues";
  return "General";
}

function getActions(extractedData: unknown): SheetAction[] {
  if (!extractedData || typeof extractedData !== "object" || Array.isArray(extractedData)) return [];
  const actions = (extractedData as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return [];
  return actions.filter((action): action is SheetAction => Boolean(action) && typeof action === "object");
}

function firstAccount(action: SheetAction | undefined): string | null {
  return action?.account ?? action?.accounts?.[0] ?? null;
}

function extractAmount(text: string): string | null {
  const match = text.match(/(?:\$|usd\s*)?\d+(?:[,.]\d+)?\s*(?:k|K)?\s*(?:usdt|usd|dollars?|\$)?/i);
  return match?.[0] ? compactText(match[0]).replace(/\s+/g, "") : null;
}

function extractEntityAfter(text: string, labels: string[]): string | null {
  const labelPattern = labels.map((label) => label.replace(/\s+/g, "\\s+")).join("|");
  const match = text.match(new RegExp(`\\b(?:${labelPattern})\\b\\s*[:#-]?\\s*([A-Za-z0-9_-]+)`, "i"));
  return match?.[1] ?? null;
}

function cleanTaskText(ticket: BatchTicket): string {
  const category = mapIntentToCategory(ticket.intent);
  const original = compactText(ticket.client_original_message ?? "");
  const actions = getActions(ticket.extracted_data);
  const shareAction = actions.find((action) => action.type === "share_account");
  const unshareAction = actions.find((action) => action.type === "unshare_account");
  const paymentAction = actions.find((action) => action.type === "payment_check");
  const verifyAction = actions.find((action) => action.type === "verify_account");
  const accountStatusAction = actions.find((action) => action.type === "account_status_check");

  if (category === "Share") {
    const account = firstAccount(shareAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    const bm = shareAction?.bm ?? extractEntityAfter(original, ["bm", "business manager"]);
    if (account && bm) return `Please share account ${account} to BM ${bm}`;
    if (account) return `Please share account ${account}`;
  }

  if (category === "Unshare") {
    const account = firstAccount(unshareAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    const bm = unshareAction?.bm ?? extractEntityAfter(original, ["bm", "business manager"]);
    if (account && bm) return `Please unshare account ${account} from BM ${bm}`;
    if (account) return `Please unshare account ${account}`;
  }

  if (category === "Deposits") {
    const amount = paymentAction?.amount ?? extractAmount(original);
    return amount ? `Client sent ${amount} deposit` : "Client sent deposit, please check";
  }

  if (category === "Payment Issues") {
    const account = firstAccount(accountStatusAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    return account ? `Payment issue on account ${account}` : "Payment issue reported";
  }

  if (category === "Verification") {
    const account = firstAccount(verifyAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    return account ? `Please verify account ${account}` : "Verification request";
  }

  if (category === "Account Issues") {
    const account = firstAccount(accountStatusAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    return account ? `Account issue on account ${account}` : "Account issue reported";
  }

  return original || "General support request";
}

function buildMarkSummary(tickets: BatchTicket[]): string {
  const grouped = new Map<typeof CATEGORY_ORDER[number], string[]>();
  for (const category of CATEGORY_ORDER) grouped.set(category, []);
  for (const ticket of tickets) grouped.get(mapIntentToCategory(ticket.intent))?.push(cleanTaskText(ticket));

  const sections = CATEGORY_ORDER
    .map((category) => {
      const items = grouped.get(category) ?? [];
      if (items.length === 0) return null;
      return [`${category.toUpperCase()}`, ...items.map((item) => `- ${escapeTelegramHtml(item)}`)].join("\n");
    })
    .filter(Boolean);

  return ["📌 NEW REQUESTS BATCH", ...sections].join("\n\n");
}

function chooseClientReply(tickets: BatchTicket[]): string {
  const categories = tickets.map((ticket) => mapIntentToCategory(ticket.intent));
  if (categories.includes("Deposits")) return "Understood, I’ll check the deposit and update you.";
  if (categories.includes("Payment Issues")) return "Got it, I’ll check the payment issue and update you.";
  if (categories.includes("Share") || categories.includes("Unshare")) return "Sure, I’ll check this and update you.";
  if (categories.includes("Verification")) return "Got it, checking the verification request now.";
  return CLIENT_BATCH_REPLY;
}

function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getTelegramMessage(update: QueuedMessage["raw_payload"]) {
  return update?.message ?? update?.edited_message ?? update?.channel_post ?? null;
}

function getChatTitle(message: QueuedMessage): string {
  const telegramMessage = getTelegramMessage(message.raw_payload);
  return telegramMessage?.chat?.title?.trim() || String(message.telegram_chat_id ?? "");
}

function getUsername(message: QueuedMessage): string {
  const telegramMessage = getTelegramMessage(message.raw_payload);
  return telegramMessage?.from?.username?.trim() || message.telegram_username?.trim() || "";
}

async function createTicketsFromQueuedMessages(
  supabase: ReturnType<typeof createClient>,
  messages: QueuedMessage[]
): Promise<BatchTicket[]> {
  const messagesByChat = new Map<string, QueuedMessage[]>();
  for (const message of messages) {
    if (!message.telegram_chat_id) continue;
    const key = String(message.telegram_chat_id);
    messagesByChat.set(key, [...(messagesByChat.get(key) ?? []), message]);
  }

  const createdTickets: BatchTicket[] = [];
  for (const [chatId, chatMessages] of messagesByChat.entries()) {
    const { data: latestTicket, error: latestTicketError } = await supabase
      .from("tickets")
      .select("client_message_id")
      .eq("client_chat_id", chatId)
      .not("client_message_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestTicketError) throw new Error(`Supabase latest ticket query failed: ${latestTicketError.message}`);

    let processedThroughMs = 0;
    if (latestTicket?.client_message_id) {
      const { data: processedMessage, error: processedMessageError } = await supabase
        .from("messages")
        .select("created_at")
        .eq("id", latestTicket.client_message_id)
        .maybeSingle();
      if (processedMessageError) throw new Error(`Supabase processed message query failed: ${processedMessageError.message}`);
      processedThroughMs = processedMessage?.created_at ? new Date(processedMessage.created_at).getTime() : 0;
    }

    const unprocessedMessages = chatMessages.filter((message) => {
      const createdAtMs = message.created_at ? new Date(message.created_at).getTime() : 0;
      return createdAtMs > processedThroughMs;
    });

    const cleanMessages = unprocessedMessages
      .sort((a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime())
      .map((message) => compactText(message.message_text ?? ""))
      .filter((text) => text && !isPureNonSupportChatter(text));
    const groupedText = compactText(cleanMessages.join(" "));

    if (!groupedText || !hasRequestSignal(groupedText) || isIncompleteRequestFragment(groupedText)) {
      console.log("non-request-message-skipped", { chatId, messageCount: unprocessedMessages.length });
      continue;
    }

    console.log("grouped-message-created", { chatId, messageCount: unprocessedMessages.length });
    const classification = classifyIntent(groupedText);
    if (!classification.requiresMark || classification.intent === "no_action") {
      console.log("non-request-message-skipped", { chatId, intent: classification.intent });
      continue;
    }

    const duplicateStartIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: duplicateTicket, error: duplicateError } = await supabase
      .from("tickets")
      .select("id")
      .eq("client_chat_id", chatId)
      .eq("client_original_message", groupedText)
      .gte("created_at", duplicateStartIso)
      .limit(1)
      .maybeSingle();
    if (duplicateError) throw new Error(`Supabase duplicate ticket query failed: ${duplicateError.message}`);
    if (duplicateTicket?.id) {
      console.log("duplicate-batch-prevented", { chatId, ticketId: duplicateTicket.id });
      continue;
    }

    const latestMessage = unprocessedMessages[unprocessedMessages.length - 1];
    if (!latestMessage) continue;
    const { data: createdTicket, error: createTicketError } = await supabase
      .from("tickets")
      .insert({
        ticket_code: createTicketCode(),
        client_chat_id: chatId,
        client_message_id: latestMessage?.id ?? null,
        client_user_id: null,
        client_username: getUsername(latestMessage),
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
      .select("id, intent, client_chat_id, client_original_message, extracted_data, internal_summary, created_at, holding_message_id")
      .single();
    if (createTicketError || !createdTicket?.id) {
      throw new Error(`Supabase tickets insert failed: ${createTicketError?.message ?? "Unknown error"}`);
    }

    try {
      await writeClientRequestRowToGoogleSheet({
        telegramGroup: getChatTitle(latestMessage),
        username: getUsername(latestMessage),
        originalMessage: groupedText,
        parsedMessage: classification.internalSummary || groupedText,
        intent: classification.intent,
        status: "Pending",
        extractedData: classification.extractedData
      });
      console.log("google-sheets-row-write-success", { chatId, ticketId: createdTicket.id });
    } catch (error) {
      console.log("google-sheets-write-failed", {
        chatId,
        ticketId: createdTicket.id,
        error: error instanceof Error ? error.message : "Google Sheets write failed."
      });
    }

    console.log("request-added-to-mark-batch", { chatId, ticketId: createdTicket.id, intent: classification.intent });
    console.log("client-ack-scheduled", { chatId, ticketId: createdTicket.id });
    createdTickets.push(createdTicket as BatchTicket);
  }

  return createdTickets;
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

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const batchCutoffIso = new Date(Date.now() - BATCH_DELAY_MINUTES * 60 * 1000).toISOString();
  const messageStartIso = new Date(Date.now() - MESSAGE_LOOKBACK_MINUTES * 60 * 1000).toISOString();
  const { data: queuedMessagesData, error: queuedMessagesError } = await supabase
    .from("messages")
    .select("id, created_at, telegram_chat_id, telegram_username, message_text, message_type, raw_payload")
    .gte("created_at", messageStartIso)
    .lte("created_at", batchCutoffIso)
    .in("message_type", ["client", "client_photo"])
    .order("created_at", { ascending: true })
    .limit(500);
  if (queuedMessagesError) throw new Error(`Supabase queued messages query failed: ${queuedMessagesError.message}`);

  const createdTickets = await createTicketsFromQueuedMessages(supabase, (queuedMessagesData ?? []) as QueuedMessage[]);

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
  const markSummary = buildMarkSummary(tickets);
  const markSendResult = await maybeSendTelegramMessage({ chatId: markGroupChatId, text: markSummary });
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

  const ticketsByClient = new Map<string, BatchTicket[]>();
  for (const ticket of tickets) {
    if (!ticket.client_chat_id || ticket.holding_message_id) continue;
    const key = String(ticket.client_chat_id);
    ticketsByClient.set(key, [...(ticketsByClient.get(key) ?? []), ticket]);
  }

  let clientReplyCount = 0;
  for (const [clientChatId, clientTickets] of ticketsByClient.entries()) {
    try {
      const clientReply = chooseClientReply(clientTickets);
      const clientSendResult = await maybeSendTelegramMessage({ chatId: clientChatId, text: clientReply });
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
    console.log("request-marked-as-processed", { ticketId: ticket.id });
    console.log("mark-batch-request-marked-sent", { ticketId: ticket.id });
  }

  return NextResponse.json({ ok: true, count: tickets.length, clientGroups: clientReplyCount });
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
