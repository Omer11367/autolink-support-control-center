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
const RECENT_TICKET_WINDOW_HOURS = 24;

type ContextClass =
  | "new_request"
  | "follow_up"
  | "correction"
  | "extra_info"
  | "close_signal"
  | "unknown";

type TicketRow = {
  id: string;
  status: string | null;
  priority: string | null;
  client_chat_id: string | number | null;
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

function classifyContextLayer(messageText: string, hasImageAttachment: boolean, hasOpenTicket: boolean): ContextClass {
  const normalized = messageText.trim().toLowerCase();
  if (!normalized && hasImageAttachment && hasOpenTicket) return "extra_info";

  const followUpPhrases = ["any update", "update?", "hello?", "??", "status?", "done?", "waiting", "wait?", "still waiting", "where are you"];
  const correctionPhrases = ["no wait", "wrong", "sorry", "use this", "instead", "different bm", "not this", "ignore previous", "change it"];
  const closePhrases = ["close", "cancel", "never mind", "nevermind", "resolved", "done thanks", "all good", "no need"];
  const extraInfoPhrases = ["bm", "account", "access", "id", "login", "password", "mail", "email", "screenshot", "image", "attached", "proof", "here it is"];
  const newRequestPhrases = [
    "share",
    "unshare",
    "deposit",
    "funds",
    "refund",
    "verify",
    "request account",
    "need account",
    "availability",
    "issue"
  ];

  if (hasOpenTicket && (normalized === "??" || hasAnyPhrase(normalized, followUpPhrases))) return "follow_up";
  if (hasOpenTicket && hasAnyPhrase(normalized, correctionPhrases)) return "correction";
  if (hasOpenTicket && hasAnyPhrase(normalized, closePhrases)) return "close_signal";
  if (hasOpenTicket && (hasImageAttachment || hasAnyPhrase(normalized, extraInfoPhrases))) return "extra_info";
  if (hasAnyPhrase(normalized, newRequestPhrases)) return "new_request";

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

    const storedMessageRow = (storedMessage ?? null) as StoredMessageRow | null;
    const debounceWindowStartIso = new Date(Date.now() - DEBOUNCE_WINDOW_SECONDS * 1000).toISOString();

    console.log("debounce-buffer-start", { chatId, messageId: message.message_id, windowSeconds: DEBOUNCE_WINDOW_SECONDS });
    const { data: recentMessagesData, error: recentMessagesError } = await supabase
      .from("messages")
      .select("id, created_at, message_text, message_type, telegram_message_id")
      .eq("telegram_chat_id", chatId)
      .gte("created_at", debounceWindowStartIso)
      .order("created_at", { ascending: true })
      .limit(30);

    if (recentMessagesError) {
      console.error("supabase-query-error", { table: "messages", message: recentMessagesError.message });
      throw new Error(`Supabase messages query failed: ${recentMessagesError.message}`);
    }

    const recentMessages = (recentMessagesData ?? []) as StoredMessageRow[];
    const recentTextMessages = recentMessages.filter((row) => (row.message_type ?? "client") === "client" && Boolean(row.message_text?.trim()));
    const currentCreatedAt = storedMessageRow?.created_at ? new Date(storedMessageRow.created_at).getTime() : Date.now();
    const hasNewerTextMessage = recentTextMessages.some((row) => {
      if (!row.created_at) return false;
      const createdAt = new Date(row.created_at).getTime();
      return createdAt > currentCreatedAt;
    });

    if (!hasImageAttachment && hasNewerTextMessage) {
      console.log("debounce-buffer-flush", {
        chatId,
        messageId: message.message_id,
        action: "skip_older_fragment"
      });
      return NextResponse.json({ ok: true, saved: true, ignored: "debounce_older_fragment" });
    }

    const combinedClientMessageText = !hasImageAttachment && recentTextMessages.length > 1
      ? recentTextMessages.map((row) => row.message_text?.trim() ?? "").filter(Boolean).join(" ").trim()
      : clientMessageText;

    console.log("debounce-buffer-flush", {
      chatId,
      messageId: message.message_id,
      combinedCount: !hasImageAttachment ? recentTextMessages.length : 1,
      combinedTextLength: combinedClientMessageText.length
    });

    console.log("context-layer-start", { chatId, messageId: message.message_id });
    const recentTicketStartIso = new Date(Date.now() - RECENT_TICKET_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const { data: latestTicketData, error: latestTicketError } = await supabase
      .from("tickets")
      .select("id, status, priority, client_chat_id, created_at, updated_at")
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

      const contextForwardMessage = `[#${latestTicket.id}] ${contextPrefix}: ${contextText}`;

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

      return NextResponse.json({ ok: true, saved: true, routedToTicketId: latestTicket.id, contextClass });
    }

    const classification = classifyIntent(combinedClientMessageText);
    const requiresMark = hasImageAttachment ? true : classification.requiresMark;
    const shouldReply = hasImageAttachment ? true : classification.shouldReply;
    const guardianMessage = hasImageAttachment
      ? (text ? (buildGuardianMirrorMessage(text) ?? text) : "Client sent an image/screenshot.")
      : (buildGuardianMirrorMessage(combinedClientMessageText) ?? combinedClientMessageText);

    if (contextClass === "new_request") {
      console.log("context-new-request", { chatId, messageId: message.message_id });
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
        status: requiresMark ? "waiting_mark" : "closed",
        priority: ["deposit_funds", "refund_request", "payment_issue", "check_policy"].includes(classification.intent) ? "high" : "normal",
        needs_mark: requiresMark,
        client_original_message: combinedClientMessageText,
        extracted_data: classification.extractedData,
        internal_summary: classification.internalSummary
      })
      .select("id")
      .single();

    if (ticketError) {
      console.error("supabase-insert-error", { table: "tickets", message: ticketError.message });
      throw new Error(`Supabase tickets insert failed: ${ticketError.message}`);
    }
    console.log("telegram-ticket-created", { chatId, messageId: message.message_id, ticketId: ticket?.id });

    if (!requiresMark || !shouldReply) {
      return NextResponse.json({ ok: true, saved: true, ignored: "no_action", ticketId: ticket?.id ?? null });
    }

    const holdingMessage = classification.holdingMessage || HOLDING_MESSAGE;
    const holdingMessageId = await sendTelegramMessage(botToken, chatId, holdingMessage);
    let guardianMessageId: number | undefined;

    if (hasImageAttachment) {
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

      console.log("telegram-media-forwarded", { ticketId: ticket?.id, guardianMessageId });
    } else {
      guardianMessageId = await sendTelegramMessage(botToken, markGroupChatId, guardianMessage);
    }

    const { error: ticketMessageIdsError } = await supabase
      .from("tickets")
      .update({
        holding_message_id: holdingMessageId ?? null,
        internal_message_id: guardianMessageId ?? null
      })
      .eq("id", ticket?.id);

    if (ticketMessageIdsError) {
      console.error("supabase-update-error", { table: "tickets", message: ticketMessageIdsError.message });
      throw new Error(`Supabase tickets update failed: ${ticketMessageIdsError.message}`);
    }
    console.log("telegram-ticket-message-ids-updated", { ticketId: ticket?.id, holdingMessageId, guardianMessageId });

    const { error: botResponsesError } = await supabase.from("bot_responses").insert([
      {
        ticket_id: ticket?.id ?? null,
        telegram_chat_id: chatId,
        telegram_message_id: holdingMessageId ?? null,
        response_type: "holding",
        response_text: holdingMessage
      },
      {
        ticket_id: ticket?.id ?? null,
        telegram_chat_id: Number(markGroupChatId),
        telegram_message_id: guardianMessageId ?? null,
        response_type: "guardian_mirror",
        response_text: guardianMessage
      }
    ]);

    if (botResponsesError) {
      console.error("supabase-insert-error", { table: "bot_responses", message: botResponsesError.message });
      throw new Error(`Supabase bot_responses insert failed: ${botResponsesError.message}`);
    }
    console.log("telegram-bot-responses-saved", { ticketId: ticket?.id });

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
