import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildGuardianMirrorMessage } from "@/lib/guardian-mirror";
import { classifyIntent } from "@/lib/intent-classifier";

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

type TelegramSendResponse = {
  ok: boolean;
  description?: string;
  result?: {
    message_id?: number;
  };
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

async function sendTelegramMessage(token: string, chatId: number | string, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    })
  });

  const payload = (await response.json()) as TelegramSendResponse;

  if (!response.ok || !payload.ok) {
    console.error("telegram-send-error", payload.description ?? response.statusText);
    throw new Error(payload.description ?? "Telegram send failed.");
  }

  return payload.result?.message_id;
}

async function copyTelegramMessage(
  token: string,
  chatId: number | string,
  fromChatId: number | string,
  messageId: number,
  caption: string
) {
  const response = await fetch(`https://api.telegram.org/bot${token}/copyMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      from_chat_id: fromChatId,
      message_id: messageId,
      caption
    })
  });

  const payload = (await response.json()) as TelegramSendResponse;

  if (!response.ok || !payload.ok) {
    console.error("telegram-copy-message-error", payload.description ?? response.statusText);
    throw new Error(payload.description ?? "Telegram copyMessage failed.");
  }

  return payload.result?.message_id;
}

async function sendTelegramPhoto(token: string, chatId: number | string, photoFileId: string, caption: string) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo: photoFileId,
      caption
    })
  });

  const payload = (await response.json()) as TelegramSendResponse;

  if (!response.ok || !payload.ok) {
    console.error("telegram-send-photo-error", payload.description ?? response.statusText);
    throw new Error(payload.description ?? "Telegram sendPhoto failed.");
  }

  return payload.result?.message_id;
}

async function sendTelegramDocument(token: string, chatId: number | string, documentFileId: string, caption: string) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      document: documentFileId,
      caption
    })
  });

  const payload = (await response.json()) as TelegramSendResponse;

  if (!response.ok || !payload.ok) {
    console.error("telegram-send-document-error", payload.description ?? response.statusText);
    throw new Error(payload.description ?? "Telegram sendDocument failed.");
  }

  return payload.result?.message_id;
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
    const { botToken, markGroupChatId, supabaseUrl, serviceRoleKey } = getRuntimeEnv();

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
      return NextResponse.json({ ok: true, ignored: "guardian_group" });
    }

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
      await sendTelegramMessage(botToken, markGroupChatId, `NEW REQUEST:\n${clientMessageText}`);
      console.log("conversation-burst-message-forwarded", { chatId, messageId: message.message_id });
    }

    const storedMessageRow = (storedMessage ?? null) as StoredMessageRow | null;
    const shouldDebounce = !hasImageAttachment;
    if (shouldDebounce) {
      console.log("debounce-quiet-window-start", { chatId, messageId: message.message_id, windowSeconds: DEBOUNCE_WINDOW_SECONDS });
      await sleep(DEBOUNCE_WINDOW_SECONDS * 1000);
    }

    const debounceWindowStartIso = new Date(Date.now() - BURST_LOOKBACK_MINUTES * 60 * 1000).toISOString();

    console.log("debounce-buffer-start", { chatId, messageId: message.message_id, windowSeconds: DEBOUNCE_WINDOW_SECONDS });
    const { data: recentMessagesData, error: recentMessagesError } = await supabase
      .from("messages")
      .select("id, created_at, message_text, message_type, telegram_message_id")
      .eq("telegram_chat_id", chatId)
      .gte("created_at", debounceWindowStartIso)
      .order("created_at", { ascending: true })
      .limit(40);

    if (recentMessagesError) {
      console.error("supabase-query-error", { table: "messages", message: recentMessagesError.message });
      throw new Error(`Supabase messages query failed: ${recentMessagesError.message}`);
    }

    const recentMessages = (recentMessagesData ?? []) as StoredMessageRow[];
    const recentTextMessages = recentMessages.filter((row) => (row.message_type ?? "client") === "client" && Boolean(row.message_text?.trim()));
    let combinedClientMessageText = clientMessageText;
    let burstMessages: StoredMessageRow[] = [];
    let groupedFromFragments = false;

    if (!hasImageAttachment) {
      const { data: newestTextMessageData, error: newestTextMessageError } = await supabase
        .from("messages")
        .select("id, created_at, message_text, message_type, telegram_message_id")
        .eq("telegram_chat_id", chatId)
        .eq("message_type", "client")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (newestTextMessageError) {
        console.error("supabase-query-error", { table: "messages", message: newestTextMessageError.message });
        throw new Error(`Supabase newest message query failed: ${newestTextMessageError.message}`);
      }

      const newestTextMessage = (newestTextMessageData ?? null) as StoredMessageRow | null;
      const newestCreatedAtMs = newestTextMessage?.created_at ? new Date(newestTextMessage.created_at).getTime() : Date.now();
      if (newestTextMessage?.id && newestTextMessage.id !== storedMessageRow?.id) {
        console.log("older-fragment-exit-no-ticket", {
          chatId,
          messageId: message.message_id,
          rowId: storedMessageRow?.id ?? null,
          latestRowId: newestTextMessage.id
        });
        return NextResponse.json({ ok: true, saved: true, ignored: "older_fragment_exit_no_ticket" });
      }

      console.log("latest-burst-processing", { chatId, messageId: message.message_id, rowId: storedMessageRow?.id ?? null });
      console.log("conversation-burst-start", { chatId, messageId: message.message_id, burstGapSeconds: BURST_GAP_SECONDS });
      const burstWindowStartIso = new Date(Date.now() - BURST_LOOKBACK_MINUTES * 60 * 1000).toISOString();
      const { data: burstMessagesData, error: burstMessagesError } = await supabase
        .from("messages")
        .select("id, created_at, message_text, message_type, telegram_message_id")
        .eq("telegram_chat_id", chatId)
        .eq("message_type", "client")
        .gte("created_at", burstWindowStartIso)
        .lte("created_at", new Date(newestCreatedAtMs).toISOString())
        .order("created_at", { ascending: true })
        .limit(50);

      if (burstMessagesError) {
        console.error("supabase-query-error", { table: "messages", message: burstMessagesError.message });
        throw new Error(`Supabase burst messages query failed: ${burstMessagesError.message}`);
      }

      const lookbackRows = (burstMessagesData ?? []) as StoredMessageRow[];
      burstMessages = buildBurstMessages(lookbackRows, newestTextMessage?.id ?? storedMessageRow?.id ?? null);
      if (burstMessages.length > 1) {
        console.log("debounce-quiet-window-reset", { chatId, messageId: message.message_id, fragmentCount: burstMessages.length });
      }

      combinedClientMessageText = burstMessages.map((row) => row.message_text?.trim() ?? "").filter(Boolean).join(" ").trim() || clientMessageText;
      console.log("combined-burst-text", {
        chatId,
        messageId: message.message_id,
        fragmentCount: burstMessages.length,
        text: combinedClientMessageText
      });
      console.log("conversation-burst-intents-detected", {
        chatId,
        messageId: message.message_id,
        fragmentCount: burstMessages.length
      });
    }

    console.log("debounce-buffer-flush", {
      chatId,
      messageId: message.message_id,
      combinedCount: !hasImageAttachment ? recentTextMessages.length : 1,
      combinedTextLength: combinedClientMessageText.length
    });
    console.log("debounce-final-single-processing", { chatId, messageId: message.message_id, finalLength: combinedClientMessageText.length });

    if (!hasImageAttachment) {
      const groupingClass = classifyTicketGrouping(combinedClientMessageText);
      if (["continuation_fragment", "amount_fragment", "currency_fragment"].includes(groupingClass)) {
        console.log("ticket-fragment-detected", {
          chatId,
          messageId: message.message_id,
          groupingClass,
          fragmentCount: burstMessages.length
        });
        if (!isLogicalGroupReady(combinedClientMessageText, burstMessages.length)) {
          console.log("prevented-fragment-ticket", {
            chatId,
            messageId: message.message_id,
            groupingClass,
            fragmentCount: burstMessages.length
          });
          return NextResponse.json({ ok: true, saved: true, ignored: "fragment_waiting_for_group_completion" });
        }
        console.log("ticket-fragment-merged", {
          chatId,
          messageId: message.message_id,
          groupingClass,
          mergedTextLength: combinedClientMessageText.length
        });
        groupedFromFragments = true;
      }
    }

    if (!hasImageAttachment) {
      const textKind = classifyIncomingTextKind(combinedClientMessageText);
      if (textKind === "greeting_only" || textKind === "thanks_only" || textKind === "close_only") {
        console.log("smart-greeting-detected", { chatId, messageId: message.message_id, textKind });
        console.log("smart-smalltalk-no-ticket", { chatId, messageId: message.message_id, textKind });
        const greetingAckWindowStartIso = new Date(Date.now() - DEBOUNCE_WINDOW_SECONDS * 1000).toISOString();
        const responseType = `smalltalk_${textKind}`;
        const { data: recentGreetingAck } = await supabase
          .from("bot_responses")
          .select("id")
          .eq("telegram_chat_id", chatId)
          .eq("response_type", responseType)
          .gte("created_at", greetingAckWindowStartIso)
          .order("created_at", { ascending: false })
          .limit(1);

        if (!recentGreetingAck || recentGreetingAck.length === 0) {
          if (textKind !== "close_only") {
            const smallTalkReply = textKind === "thanks_only"
              ? "You're welcome."
              : chooseGreetingMessage(normalizeComparableText(combinedClientMessageText));
            const greetingMessageId = await sendTelegramMessage(botToken, chatId, smallTalkReply);
            await supabase.from("bot_responses").insert({
              ticket_id: null,
              telegram_chat_id: chatId,
              telegram_message_id: greetingMessageId ?? null,
              response_type: responseType,
              response_text: smallTalkReply
            });
          }
        }

        return NextResponse.json({ ok: true, saved: true, ignored: "smart_smalltalk_no_ticket" });
      }
    }

    if (!hasImageAttachment && isGreetingOnly(combinedClientMessageText)) {
      console.log("smart-greeting-detected", { chatId, messageId: message.message_id, textKind: "greeting_only_legacy" });
      const greetingAckWindowStartIso = new Date(Date.now() - DEBOUNCE_WINDOW_SECONDS * 1000).toISOString();
      const { data: recentGreetingAck } = await supabase
        .from("bot_responses")
        .select("id")
        .eq("telegram_chat_id", chatId)
        .eq("response_type", "greeting_ack")
        .gte("created_at", greetingAckWindowStartIso)
        .order("created_at", { ascending: false })
        .limit(1);

      if (!recentGreetingAck || recentGreetingAck.length === 0) {
        const greetingMessage = chooseGreetingMessage(normalizeComparableText(combinedClientMessageText));
        const greetingMessageId = await sendTelegramMessage(botToken, chatId, greetingMessage);
        await supabase.from("bot_responses").insert({
          ticket_id: null,
          telegram_chat_id: chatId,
          telegram_message_id: greetingMessageId ?? null,
          response_type: "greeting_ack",
          response_text: greetingMessage
        });
      }

      return NextResponse.json({ ok: true, saved: true, ignored: "greeting_only" });
    }

    console.log("context-layer-start", { chatId, messageId: message.message_id });
    const recentTicketStartIso = new Date(Date.now() - RECENT_TICKET_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const { data: latestTicketData, error: latestTicketError } = await supabase
      .from("tickets")
      .select("id, ticket_code, status, priority, client_chat_id, client_username, client_original_message, internal_message_id, created_at, updated_at")
      .eq("client_chat_id", chatId)
      .gte("created_at", recentTicketStartIso)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestTicketError) {
      console.error("supabase-query-error", { table: "tickets", message: latestTicketError.message });
      throw new Error(`Supabase tickets query failed: ${latestTicketError.message}`);
    }

    const latestTicket = (latestTicketData ?? null) as TicketRow | null;
    const hasOpenTicket = isOpenTicketStatus(latestTicket?.status);
    const contextClass = classifyContextLayer(combinedClientMessageText, hasImageAttachment, hasOpenTicket);
    if (hasOpenTicket && contextClass === "new_request") {
      console.log("smart-prevent-overlink", {
        chatId,
        messageId: message.message_id,
        latestTicketId: latestTicket?.id ?? null
      });
    }
    console.log("context-layer-result", {
      chatId,
      messageId: message.message_id,
      contextClass,
      hasOpenTicket,
      latestTicketId: latestTicket?.id ?? null
    });

    if (latestTicket?.id && hasOpenTicket && ["follow_up", "correction", "extra_info", "close_signal"].includes(contextClass)) {
      const contextText = combinedClientMessageText || "Image/screenshot sent by client.";
      const contextPrefix =
        contextClass === "follow_up"
          ? "Follow-up from client"
          : contextClass === "correction"
            ? "Correction from client"
            : contextClass === "close_signal"
              ? "Close signal from client"
              : "Additional info from client";

      if (contextClass === "follow_up") {
        console.log("context-follow-up", { chatId, ticketId: latestTicket.id });
      } else if (contextClass === "correction") {
        console.log("context-correction", { chatId, ticketId: latestTicket.id });
      } else if (contextClass === "extra_info") {
        console.log("context-extra-info", { chatId, ticketId: latestTicket.id });
      } else if (contextClass === "close_signal") {
        console.log("context-close-signal", { chatId, ticketId: latestTicket.id });
      }

      const { error: noteError } = await supabase.from("ticket_notes").insert({
        ticket_id: latestTicket.id,
        note_text: `${contextPrefix}: ${contextText}`
      });
      if (noteError) {
        console.error("supabase-insert-error", { table: "ticket_notes", message: noteError.message });
      }

      const contextForwardMessage = contextClass === "follow_up"
        ? `FOLLOW-UP FROM CLIENT:\n${contextText}`
        : contextClass === "correction"
          ? `CORRECTION FROM CLIENT:\n${contextText}`
          : `ADDITIONAL INFO FROM CLIENT:\n${contextText}`;
      console.log("mark-message-private-safe", {
        chatId,
        messageId: message.message_id,
        contextClass
      });

      let guardianMessageId: number | undefined;
      if (hasImageAttachment) {
        const captionForContext = `${contextForwardMessage}\n${caption || "Image/screenshot sent by client."}`;
        const fallbackPhotoFileId = largestPhotoFileId(message.photo);
        const fallbackDocumentFileId = hasImageDocument ? message.document?.file_id : null;
        try {
          guardianMessageId = await copyTelegramMessage(botToken, markGroupChatId, chatId, message.message_id, captionForContext);
        } catch (copyError) {
          console.error("telegram-copy-message-fallback", copyError);
          if (fallbackPhotoFileId) {
            guardianMessageId = await sendTelegramPhoto(botToken, markGroupChatId, fallbackPhotoFileId, captionForContext);
          } else if (fallbackDocumentFileId) {
            guardianMessageId = await sendTelegramDocument(botToken, markGroupChatId, fallbackDocumentFileId, captionForContext);
          }
        }
      } else {
        guardianMessageId = await sendTelegramMessage(botToken, markGroupChatId, contextForwardMessage);
      }
      if (contextClass === "follow_up") {
        console.log("follow-up-with-ticket-context", { chatId, ticketId: latestTicket.id, ticketCode: latestTicket.ticket_code ?? null });
        console.log("smart-follow-up-linked", { chatId, ticketId: latestTicket.id });
      }

      if (contextClass === "follow_up" && latestTicket.priority !== "high" && latestTicket.priority !== "urgent") {
        const { error: escalateError } = await supabase
          .from("tickets")
          .update({ priority: "high", updated_at: new Date().toISOString() })
          .eq("id", latestTicket.id);
        if (escalateError) {
          console.error("supabase-update-error", { table: "tickets", message: escalateError.message });
        }
      }

      if (contextClass === "close_signal") {
        const closeAt = new Date().toISOString();
        const { error: closeError } = await supabase
          .from("tickets")
          .update({ status: "closed", needs_mark: false, updated_at: closeAt, closed_at: closeAt })
          .eq("id", latestTicket.id);
        if (closeError) {
          console.error("supabase-update-error", { table: "tickets", message: closeError.message });
        }
      } else if (contextClass === "correction") {
        const { data: ticketForCorrection } = await supabase
          .from("tickets")
          .select("client_original_message")
          .eq("id", latestTicket.id)
          .single();
        const currentOriginal = String(ticketForCorrection?.client_original_message ?? "").trim();
        const correctionSuffix = `Correction: ${contextText}`;
        const mergedOriginal = currentOriginal
          ? `${currentOriginal}\n${correctionSuffix}`
          : correctionSuffix;
        const { error: correctionUpdateError } = await supabase
          .from("tickets")
          .update({ client_original_message: mergedOriginal, updated_at: new Date().toISOString() })
          .eq("id", latestTicket.id);
        if (correctionUpdateError) {
          console.error("supabase-update-error", { table: "tickets", message: correctionUpdateError.message });
        } else {
          console.log("correction-dashboard-updated", { chatId, ticketId: latestTicket.id });
          console.log("dashboard-history-appended", { chatId, ticketId: latestTicket.id, updateType: "correction" });
          console.log("correction-linked-to-existing-ticket", { chatId, ticketId: latestTicket.id, ticketCode: latestTicket.ticket_code ?? null });
          console.log("smart-correction-linked", { chatId, ticketId: latestTicket.id });
        }
      } else if (contextClass === "extra_info" && hasImageAttachment) {
        const imageNote = "Image/screenshot attached by client.";
        const { error: imageNoteError } = await supabase.from("ticket_notes").insert({
          ticket_id: latestTicket.id,
          note_text: imageNote
        });
        if (imageNoteError) {
          console.error("supabase-insert-error", { table: "ticket_notes", message: imageNoteError.message });
        } else {
          console.log("dashboard-history-appended", { chatId, ticketId: latestTicket.id, updateType: "image_extra_info" });
        }
      }

      const { error: contextResponseError } = await supabase.from("bot_responses").insert({
        ticket_id: latestTicket.id,
        telegram_chat_id: Number(markGroupChatId),
        telegram_message_id: guardianMessageId ?? null,
        response_type: `context_${contextClass}`,
        response_text: contextForwardMessage
      });
      if (contextResponseError) {
        console.error("supabase-insert-error", { table: "bot_responses", message: contextResponseError.message });
      }

      if (["follow_up", "correction", "extra_info"].includes(contextClass)) {
        const ackWindowSeconds = contextClass === "follow_up" ? DEBOUNCE_WINDOW_SECONDS : DUPLICATE_WINDOW_SECONDS;
        const ackWindowStartIso = new Date(Date.now() - ackWindowSeconds * 1000).toISOString();
        const responseType = `context_${contextClass}_ack`;
        const { data: recentAck } = await supabase
          .from("bot_responses")
          .select("id")
          .eq("ticket_id", latestTicket.id)
          .eq("response_type", responseType)
          .gte("created_at", ackWindowStartIso)
          .order("created_at", { ascending: false })
          .limit(1);

        if (!recentAck || recentAck.length === 0) {
          const clientAckText = chooseContextAck(contextClass);
          const clientAckMessageId = await sendTelegramMessage(botToken, chatId, clientAckText);
          await supabase.from("bot_responses").insert({
            ticket_id: latestTicket.id,
            telegram_chat_id: chatId,
            telegram_message_id: clientAckMessageId ?? null,
            response_type: responseType,
            response_text: clientAckText
          });
          if (contextClass === "follow_up") {
            console.log("follow-up-client-ack-sent", { chatId, ticketId: latestTicket.id, messageId: clientAckMessageId ?? null });
          }
        }
      }

      return NextResponse.json({ ok: true, saved: true, routedToTicketId: latestTicket.id, contextClass });
    }

    const classification = classifyIntent(combinedClientMessageText);
    const requiresMark = hasImageAttachment ? true : classification.requiresMark;
    const shouldReply = hasImageAttachment ? true : classification.shouldReply;
    const guardianMessage = hasImageAttachment
      ? (text ? (buildGuardianMirrorMessage(text) ?? text) : "Client sent an image/screenshot.")
      : `NEW REQUEST:\n${combinedClientMessageText}`;
    if (!hasImageAttachment) {
      console.log("mark-message-private-safe", {
        chatId,
        messageId: message.message_id,
        grouped: groupedFromFragments || burstMessages.length > 1
      });
    }

    if (contextClass === "new_request") {
      console.log("context-new-request", { chatId, messageId: message.message_id });
    }

    const duplicateWindowStartIso = new Date(Date.now() - DUPLICATE_WINDOW_SECONDS * 1000).toISOString();
    const { data: recentOpenTicketData, error: recentOpenTicketError } = await supabase
      .from("tickets")
      .select("id, status, priority, client_original_message, holding_message_id")
      .eq("client_chat_id", chatId)
      .gte("created_at", duplicateWindowStartIso)
      .in("status", ["open", "new", "waiting_mark", "waiting_for_mark"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentOpenTicketError) {
      console.error("supabase-query-error", { table: "tickets", message: recentOpenTicketError.message });
      throw new Error(`Supabase recent open ticket query failed: ${recentOpenTicketError.message}`);
    }

    const recentOpenTicket = recentOpenTicketData as
      | { id: string; status: string | null; priority: string | null; client_original_message: string | null; holding_message_id: string | number | null }
      | null;

    if (
      recentOpenTicket?.id &&
      messageFragmentsLookRelated(String(recentOpenTicket.client_original_message ?? ""), combinedClientMessageText)
    ) {
      console.log("duplicate-ticket-prevented", { chatId, ticketId: recentOpenTicket.id, messageId: message.message_id });
      const mergedMessage = normalizeComparableText(String(recentOpenTicket.client_original_message ?? "")) === normalizeComparableText(combinedClientMessageText)
        ? String(recentOpenTicket.client_original_message ?? combinedClientMessageText)
        : combinedClientMessageText;
      const { error: mergeUpdateError } = await supabase
        .from("tickets")
        .update({
          client_original_message: mergedMessage,
          extracted_data: classification.extractedData,
          internal_summary: classification.internalSummary,
          updated_at: new Date().toISOString()
        })
        .eq("id", recentOpenTicket.id);
      if (mergeUpdateError) {
        console.error("supabase-update-error", { table: "tickets", message: mergeUpdateError.message });
      } else {
        console.log("debounce-merged-into-existing", { chatId, ticketId: recentOpenTicket.id });
      }
      return NextResponse.json({ ok: true, saved: true, mergedIntoTicketId: recentOpenTicket.id });
    }

    if (!hasImageAttachment) {
      const { data: finalNewestTextData, error: finalNewestTextError } = await supabase
        .from("messages")
        .select("id")
        .eq("telegram_chat_id", chatId)
        .eq("message_type", "client")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (finalNewestTextError) {
        console.error("supabase-query-error", { table: "messages", message: finalNewestTextError.message });
        throw new Error(`Supabase final latest check failed: ${finalNewestTextError.message}`);
      }
      if (finalNewestTextData?.id && finalNewestTextData.id !== storedMessageRow?.id) {
        console.log("older-fragment-exit-no-ticket", {
          chatId,
          messageId: message.message_id,
          rowId: storedMessageRow?.id ?? null,
          latestRowId: finalNewestTextData.id,
          stage: "before_ticket_insert"
        });
        return NextResponse.json({ ok: true, saved: true, ignored: "older_fragment_before_ticket_insert" });
      }
    }

    const intentBuckets = new Map<string, string[]>();
    if (!hasImageAttachment && burstMessages.length > 0) {
      for (const row of burstMessages) {
        const raw = row.message_text?.trim() ?? "";
        if (!raw) continue;
        const rowClassified = classifyIntent(raw);
        const intent = rowClassified.intent || "general_support";
        const existing = intentBuckets.get(intent) ?? [];
        existing.push(raw);
        intentBuckets.set(intent, existing);
      }
    } else {
      intentBuckets.set(classification.intent || "general_support", [combinedClientMessageText]);
    }

    const intentEntries = Array.from(intentBuckets.entries()).filter(([, texts]) => texts.length > 0);
    if (intentEntries.length > 1) {
      console.log("conversation-burst-multi-intent-split", { chatId, messageId: message.message_id, intents: intentEntries.map(([intent]) => intent) });
    } else if (intentEntries.length === 1) {
      console.log("conversation-burst-same-intent-grouped", { chatId, messageId: message.message_id, intent: intentEntries[0][0] });
    }

    const createdTickets: Array<{
      id: string;
      intent: string;
      groupedText: string;
      classification: ReturnType<typeof classifyIntent>;
    }> = [];

    for (const [intent, texts] of intentEntries) {
      const groupedText = texts.join(" ").replace(/\s+/g, " ").trim();
      const groupedClassification = classifyIntent(groupedText);
      const groupedRequiresMark = groupedClassification.requiresMark;
      const { data: createdTicket, error: createTicketError } = await supabase
        .from("tickets")
        .insert({
          ticket_code: createTicketCode(),
          client_chat_id: chatId,
          client_message_id: storedMessage?.id ?? null,
          client_user_id: message.from?.id ?? null,
          client_username: message.from?.username ?? null,
          intent: intent || groupedClassification.intent,
          status: groupedRequiresMark ? "waiting_mark" : "closed",
          priority: ["deposit_funds", "refund_request", "payment_issue", "check_policy"].includes(groupedClassification.intent) ? "high" : "normal",
          needs_mark: groupedRequiresMark,
          client_original_message: groupedText,
          extracted_data: groupedClassification.extractedData,
          internal_summary: groupedClassification.internalSummary
        })
        .select("id")
        .single();

      if (createTicketError || !createdTicket?.id) {
        console.error("supabase-insert-error", { table: "tickets", message: createTicketError?.message ?? "ticket insert failed" });
        throw new Error(`Supabase tickets insert failed: ${createTicketError?.message ?? "Unknown error"}`);
      }

      createdTickets.push({
        id: createdTicket.id,
        intent: intent || groupedClassification.intent,
        groupedText,
        classification: groupedClassification
      });
      console.log("conversation-burst-ticket-created", { chatId, messageId: message.message_id, ticketId: createdTicket.id, intent: intent || groupedClassification.intent });
    }

    if (createdTickets.length === 0) {
      return NextResponse.json({ ok: true, saved: true, ignored: "no_tickets_from_burst" });
    }

    const shouldSendOneHolding = createdTickets.some((ticketItem) => ticketItem.classification.requiresMark && ticketItem.classification.shouldReply);
    let holdingMessageId: number | undefined;
    let holdingMessage: string | null = null;
    if (shouldSendOneHolding) {
      const firstHolding = createdTickets.find((ticketItem) => ticketItem.classification.requiresMark && ticketItem.classification.shouldReply);
      holdingMessage = pickSafeHoldingMessage(firstHolding?.classification.holdingMessage || HOLDING_MESSAGE);
      holdingMessageId = await sendTelegramMessage(botToken, chatId, holdingMessage);
      console.log("conversation-burst-single-client-reply", { chatId, messageId: message.message_id, holdingMessageId: holdingMessageId ?? null });
    }

    if (hasImageAttachment) {
      const ticket = createdTickets[0];
      let guardianMessageId: number | undefined;
      const fallbackPhotoFileId = largestPhotoFileId(message.photo);
      const fallbackDocumentFileId = hasImageDocument ? message.document?.file_id : null;
      console.log("telegram-media-forward-start", {
        chatId,
        messageId: message.message_id,
        hasPhoto,
        hasImageDocument,
        markGroupChatIdConfigured: Boolean(markGroupChatId)
      });

      try {
        guardianMessageId = await copyTelegramMessage(botToken, markGroupChatId, chatId, message.message_id, guardianMessage);
      } catch (copyError) {
        console.error("telegram-copy-message-fallback", copyError);
        if (fallbackPhotoFileId) {
          guardianMessageId = await sendTelegramPhoto(botToken, markGroupChatId, fallbackPhotoFileId, guardianMessage);
        } else if (fallbackDocumentFileId) {
          guardianMessageId = await sendTelegramDocument(botToken, markGroupChatId, fallbackDocumentFileId, guardianMessage);
        } else {
          throw copyError;
        }
      }

      const { error: singleUpdateError } = await supabase
        .from("tickets")
        .update({
          holding_message_id: holdingMessageId ?? null,
          internal_message_id: guardianMessageId ?? null
        })
        .eq("id", ticket.id);
      if (singleUpdateError) {
        console.error("supabase-update-error", { table: "tickets", message: singleUpdateError.message });
      }
    } else {
      for (let index = 0; index < createdTickets.length; index += 1) {
        const ticketItem = createdTickets[index];
        if (!ticketItem.classification.requiresMark) continue;
        const groupedGuardianMessage = `NEW REQUEST:\n${ticketItem.groupedText}`;
        const guardianMessageId = await sendTelegramMessage(botToken, markGroupChatId, groupedGuardianMessage);

        const { error: idsError } = await supabase
          .from("tickets")
          .update({
            holding_message_id: index === 0 ? (holdingMessageId ?? null) : null,
            internal_message_id: guardianMessageId ?? null
          })
          .eq("id", ticketItem.id);
        if (idsError) {
          console.error("supabase-update-error", { table: "tickets", message: idsError.message });
        }

        const responsesToInsert = [
          index === 0 && holdingMessage
            ? {
                ticket_id: ticketItem.id,
                telegram_chat_id: chatId,
                telegram_message_id: holdingMessageId ?? null,
                response_type: "holding",
                response_text: holdingMessage
              }
            : null,
          {
            ticket_id: ticketItem.id,
            telegram_chat_id: Number(markGroupChatId),
            telegram_message_id: guardianMessageId ?? null,
            response_type: "guardian_mirror",
            response_text: groupedGuardianMessage
          }
        ].filter(Boolean) as Array<{
          ticket_id: string;
          telegram_chat_id: number;
          telegram_message_id: number | null;
          response_type: string;
          response_text: string;
        }>;

        const { error: botResponsesError } = await supabase.from("bot_responses").insert(responsesToInsert);
        if (botResponsesError) {
          console.error("supabase-insert-error", { table: "bot_responses", message: botResponsesError.message });
        }
      }
    }

    return NextResponse.json({ ok: true });
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
