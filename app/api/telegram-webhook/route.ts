import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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
  date?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: Array<{
    file_id: string;
    file_unique_id?: string;
    width?: number;
    height?: number;
    file_size?: number;
  }>;
  document?: {
    file_id: string;
    file_unique_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
};

const HOLDING_MESSAGE = "Hello! I'll check this now and update you shortly.";
const DEBOUNCE_WINDOW_SECONDS = 10;
const DUPLICATE_WINDOW_SECONDS = 15;
const LOGICAL_GROUP_WINDOW_SECONDS = 60;
const RECENT_TICKET_WINDOW_HOURS = 24;
const BURST_GAP_SECONDS = 6;
const BURST_LOOKBACK_MINUTES = 10;

type ContextClass =
  | "new_request"
  | "follow_up"
  | "correction"
  | "extra_info"
  | "close_signal"
  | "unknown";

type TicketRow = {
  id: string;
  ticket_code?: string | null;
  status: string | null;
  priority: string | null;
  client_chat_id: string | number | null;
  client_username?: string | null;
  client_original_message?: string | null;
  internal_message_id?: string | number | null;
  created_at: string | null;
  updated_at: string | null;
};

type StoredMessageRow = {
  id: string;
  created_at: string | null;
  message_text: string | null;
  message_type: string | null;
  telegram_message_id: number | null;
};

type TicketGroupingClass =
  | "standalone_request"
  | "continuation_fragment"
  | "amount_fragment"
  | "currency_fragment"
  | "smalltalk"
  | "follow_up"
  | "correction";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function largestPhotoFileId(photo?: TelegramMessage["photo"]): string | null {
  if (!photo || photo.length === 0) return null;

  const sorted = [...photo].sort((a, b) => {
    const aSize = a.file_size ?? a.width ?? 0;
    const bSize = b.file_size ?? b.width ?? 0;
    return bSize - aSize;
  });

  return sorted[0]?.file_id ?? null;
}

function isImageDocument(document?: TelegramMessage["document"]): boolean {
  return Boolean(document?.file_id && document.mime_type?.toLowerCase().startsWith("image/"));
}

function createTicketCode(): string {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().slice(0, 6).toUpperCase();
  return `AL-${stamp}-${suffix}`;
}

function getRuntimeEnv() {
  return {
    botToken: requireEnv("TELEGRAM_BOT_TOKEN", ["TELEGRAM_BOT_TOKEN"]),
    markGroupChatId: requireEnv("MARK_GROUP_CHAT_ID or MARK_INTERNAL_CHAT_ID", ["MARK_GROUP_CHAT_ID", "MARK_INTERNAL_CHAT_ID"]),
    supabaseUrl: requireEnv("NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL", ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]),
    serviceRoleKey: requireEnv("SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY", ["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"])
  };
}

function isOpenTicketStatus(status: string | null | undefined): boolean {
  const value = String(status ?? "").toLowerCase();
  return ["open", "new", "waiting_mark", "waiting_for_mark"].includes(value);
}

function hasAnyPhrase(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

function chooseGreetingMessage(normalizedText: string): string {
  if (normalizedText.includes("good morning")) return "Good morning, how can I help?";
  if (normalizedText.includes("good evening") || normalizedText.includes("good night")) return "Good evening, how can I help?";
  const variants = ["Hey, how can I help you today?", "Hi, how can I help?", "Hey, what can I help you with?", "Hi, tell me what you need and I’ll check it."];
  return variants[Math.floor(Math.random() * variants.length)] ?? variants[0];
}

function chooseContextAck(contextClass: ContextClass): string {
  if (contextClass === "follow_up") {
    const variants = [
      "Checking this now, I’ll update you shortly.",
      "I’ll follow up on this now.",
      "Let me check this and get back to you."
    ];
    const index = Math.floor(Math.random() * variants.length);
    return variants[index] ?? variants[0];
  }
  if (contextClass === "correction") {
    const variants = [
      "Got it, I’ll update the team with the correction.",
      "Understood, I’ll correct this with the team now."
    ];
    const index = Math.floor(Math.random() * variants.length);
    return variants[index] ?? variants[0];
  }
  return "Got it, I’ll add this to the request.";
}

function isGreetingOnly(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[!?.]+$/g, "");
  return ["hey", "hi", "hello", "yo", "good morning", "good evening"].includes(normalized);
}

function normalizeComparableText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function classifyTicketGrouping(text: string): TicketGroupingClass {
  const normalized = normalizeComparableText(text).replace(/[!?.,]+$/g, "");
  const smalltalkKind = classifyIncomingTextKind(normalized);
  if (smalltalkKind !== "support_request") return "smalltalk";

  const followUpPhrases = ["any update", "update?", "status?", "done?", "waiting", "wait?"];
  if (hasAnyPhrase(normalized, followUpPhrases)) return "follow_up";

  const correctionPhrases = ["no wait", "actually", "wrong", "instead", "changed", "i see now", "please check", "same one", "for this"];
  if (hasAnyPhrase(normalized, correctionPhrases)) return "correction";

  if (/^\$|^usd$|^usdt$|^dollars?$/.test(normalized)) return "currency_fragment";
  if (/^(?:\d+(?:[.,]\d+)?(?:k)?|\d+(?:[.,]\d+)?\s*(?:usd|usdt|\$|dollars?))$/i.test(normalized)) return "amount_fragment";

  const continuationPhrases = [
    "and one more",
    "one more",
    "also",
    "plus",
    "check this",
    "check on this",
    "please check",
    "and",
    "more",
    "another",
    "sent",
    "send",
    "paid",
    "deposit"
  ];
  if (hasAnyPhrase(normalized, continuationPhrases) || normalized.split(" ").length <= 3) return "continuation_fragment";

  return "standalone_request";
}

function isClearNewActionRequest(text: string): boolean {
  const normalized = normalizeComparableText(text);
  const isBarePaymentVerb = /^(send|sent|paid|deposit)$/.test(normalized);
  if (isBarePaymentVerb) return false;
  const signals = [
    "send",
    "sent",
    "share",
    "unshare",
    "bm access",
    "add account",
    "verification",
    "verify",
    "refund",
    "account issue",
    "issue",
    "availability",
    "request account",
    "need account",
    "need ",
    "check account status",
    "policy",
    "check this deposit",
    "please check"
  ];
  return hasAnyPhrase(normalized, signals);
}

function isCorrectionMessage(text: string): boolean {
  const normalized = normalizeComparableText(text);
  const phrases = [
    "no wait",
    "i meant",
    "wrong bm",
    "not this",
    "actually",
    "replace it",
    "instead use",
    "i made a mistake",
    "only",
    "approved",
    "use this one",
    "not 123",
    "use 456",
    "wrong",
    "changed"
  ];
  return hasAnyPhrase(normalized, phrases);
}

function isFollowUpMessage(text: string): boolean {
  const normalized = normalizeComparableText(text);
  const phrases = ["any update", "status?", "done?", "hello??", "hello?", "waiting?", "update?"];
  return normalized === "??" || hasAnyPhrase(normalized, phrases);
}

function isLogicalGroupReady(text: string, fragmentCount: number): boolean {
  const normalized = normalizeComparableText(text);
  const incompleteOnly = /^(?:sent|send|paid|deposit|check on this|please check|check this|\d+(?:[.,]\d+)?k?|\$|usd|usdt|dollars?)$/i.test(normalized);
  if (incompleteOnly) return false;
  const requestSignals = ["send", "sent", "share", "unshare", "deposit", "funds", "refund", "verify", "request", "need", "availability", "issue", "check"];
  if (hasAnyPhrase(normalized, requestSignals)) return true;
  if (/\$|usd|usdt|dollars?/i.test(normalized) && /\d/.test(normalized)) return true;
  return fragmentCount >= 4;
}

function pickSafeHoldingMessage(defaultMessage: string): string {
  if (!/^received/i.test(defaultMessage.trim())) return defaultMessage;
  const safeVariants = [
    "Sure, I’ll check this and get back to you shortly.",
    "Got it, I’ll check with the team and update you.",
    "I’ll check this now and update you shortly."
  ];
  return safeVariants[Math.floor(Math.random() * safeVariants.length)] ?? safeVariants[0];
}

function buildBurstMessages(rows: StoredMessageRow[], latestRowId: string | null | undefined): StoredMessageRow[] {
  const textRows = rows
    .filter((row) => (row.message_type ?? "client") === "client" && Boolean(row.message_text?.trim()) && Boolean(row.created_at))
    .sort((a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime());
  if (textRows.length === 0) return [];

  let latestIndex = latestRowId ? textRows.findIndex((row) => row.id === latestRowId) : -1;
  if (latestIndex < 0) latestIndex = textRows.length - 1;

  const burst: StoredMessageRow[] = [textRows[latestIndex]];
  for (let idx = latestIndex - 1; idx >= 0; idx -= 1) {
    const current = textRows[idx];
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

type TextKind = "greeting_only" | "thanks_only" | "close_only" | "support_request";

function classifyIncomingTextKind(text: string): TextKind {
  const normalized = normalizeComparableText(text).replace(/[!?.,]+$/g, "");
  const greetingPhrases = [
    "hey",
    "hi",
    "hello",
    "hola",
    "yo",
    "bro",
    "good morning",
    "good evening",
    "good night",
    "how are you",
    "how are you guys"
  ];
  const thanksPhrases = ["thanks", "thank you", "ok thanks", "okay thanks", "thx", "ty"];
  const closePhrases = ["ok", "okay", "alright", "👍", "👌", "🙏", "received", "noted"];
  const supportSignals = [
    "share",
    "unshare",
    "account",
    "bm",
    "deposit",
    "funds",
    "refund",
    "verify",
    "request account",
    "need account",
    "availability",
    "issue",
    "check",
    "status",
    "problem",
    "help",
    "can you",
    "please",
    "send",
    "sent",
    "$",
    "usd"
  ];

  const hasSupportSignals = hasAnyPhrase(normalized, supportSignals);
  if (hasSupportSignals) return "support_request";
  if (thanksPhrases.includes(normalized)) return "thanks_only";
  if (greetingPhrases.includes(normalized)) return "greeting_only";
  if (closePhrases.includes(normalized)) return "close_only";
  return "support_request";
}

function isPureNonSupportChatter(text: string): boolean {
  const normalized = normalizeComparableText(text).replace(/[!?.,]+$/g, "");
  const reactionOnly = /^[\s\u{1F44D}\u2764\uFE0F\u2705\u{1F64F}]+$/u.test(text.trim());
  if (reactionOnly) return true;
  return classifyIncomingTextKind(normalized) !== "support_request";
}

function messageFragmentsLookRelated(a: string, b: string): boolean {
  const aa = normalizeComparableText(a);
  const bb = normalizeComparableText(b);
  if (!aa || !bb) return false;
  if (aa === bb || aa.startsWith(bb) || bb.startsWith(aa)) return true;
  const tokensA = aa.split(" ").filter(Boolean);
  const tokensB = bb.split(" ").filter(Boolean);
  const tokenSetA = new Set(tokensA);
  const overlap = tokensB.filter((token) => tokenSetA.has(token)).length;
  return overlap >= 1;
}

function classifyContextLayer(messageText: string, hasImageAttachment: boolean, hasOpenTicket: boolean): ContextClass {
  const normalized = messageText.trim().toLowerCase();
  if (!normalized && hasImageAttachment && hasOpenTicket) return "extra_info";

  const closePhrases = ["close", "cancel", "never mind", "nevermind", "resolved", "done thanks", "all good", "no need"];
  if (hasOpenTicket && isFollowUpMessage(normalized)) return "follow_up";
  if (hasOpenTicket && isCorrectionMessage(normalized)) return "correction";
  if (hasOpenTicket && hasAnyPhrase(normalized, closePhrases)) return "close_signal";
  if (isClearNewActionRequest(normalized)) return "new_request";
  if (hasOpenTicket && hasImageAttachment) return "extra_info";

  return "unknown";
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    env: {
      telegramBotToken: Boolean(firstEnv(["TELEGRAM_BOT_TOKEN"])),
      markGroupChatId: Boolean(firstEnv(["MARK_GROUP_CHAT_ID", "MARK_INTERNAL_CHAT_ID"])),
      supabaseUrl: Boolean(firstEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"])),
      serviceRoleKey: Boolean(firstEnv(["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]))
    }
  });
}

export async function POST(request: Request) {
  try {
    const markGroupChatId = requireEnv("MARK_GROUP_CHAT_ID or MARK_INTERNAL_CHAT_ID", ["MARK_GROUP_CHAT_ID", "MARK_INTERNAL_CHAT_ID"]);
    const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL", ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]);
    const serviceRoleKey = requireEnv("SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY", ["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const update = (await request.json()) as TelegramUpdate;
    const message = update.message ?? update.edited_message ?? update.channel_post;

    if (!message?.chat?.id) {
      return NextResponse.json({ ok: true, ignored: "no_message" });
    }

    const chatId = message.chat.id;

    if (String(chatId) === String(markGroupChatId)) {
      console.log("mark-internal-group-skipped", { chatId, messageId: message.message_id });
      return NextResponse.json({ ok: true, ignored: "guardian_group" });
    }

    console.log("incoming-message-received", { chatId, messageId: message.message_id });
    const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
    const hasImageDocument = isImageDocument(message.document);
    const hasImageAttachment = hasPhoto || hasImageDocument;
    const caption = (message.caption ?? "").trim();
    const text = (message.text ?? caption).trim();
    const clientMessageText = text || (hasImageAttachment ? "Image/screenshot sent by client." : "");

    if (!clientMessageText) {
      return NextResponse.json({ ok: true, ignored: "empty_message" });
    }

    const { data: storedMessage, error: messageError } = await supabase
      .from("messages")
      .insert({
        telegram_message_id: message.message_id,
        telegram_chat_id: chatId,
        telegram_user_id: message.from?.id ?? null,
        telegram_username: message.from?.username ?? null,
        message_text: clientMessageText,
        message_type: hasImageAttachment ? "client_photo" : "client",
        raw_payload: update
      })
      .select("id, created_at, message_text, message_type, telegram_message_id")
      .single();

    if (messageError) {
      console.error("supabase-insert-error", { table: "messages", message: messageError.message });
      throw new Error(`Supabase messages insert failed: ${messageError.message}`);
    }
    console.log("telegram-message-saved", { chatId, messageId: message.message_id, rowId: storedMessage?.id });
    if (!hasImageAttachment) {
      console.log("text-message-queued", { chatId, messageId: message.message_id, rowId: storedMessage?.id });
      console.log("instant-mark-forward-disabled", { chatId, messageId: message.message_id });
      console.log("mark-instant-text-forward-disabled", { chatId, messageId: message.message_id });
      console.log("conversation-burst-message-held-for-batch", { chatId, messageId: message.message_id });
    } else {
      console.log("media-message-queued", { chatId, messageId: message.message_id, rowId: storedMessage?.id });
    }

    return NextResponse.json({ ok: true, queued: true, rowId: storedMessage?.id ?? null });
  } catch (error) {
    console.error("telegram-webhook-error", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unexpected telegram webhook error."
      },
      { status: 500 }
    );
  }
}
