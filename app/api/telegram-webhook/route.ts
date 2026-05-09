import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

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
  reply_to_message?: {
    message_id?: number;
    text?: string;
    caption?: string;
  };
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
  edited_channel_post?: TelegramMessage;
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

function isImageDocument(document?: TelegramMessage["document"]): boolean {
  return Boolean(document?.file_id && document.mime_type?.toLowerCase().startsWith("image/"));
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

    const supabase = createClient<Database, "public">(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const update = (await request.json()) as TelegramUpdate;
    const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;

    if (!message?.chat?.id) {
      return NextResponse.json({ ok: true, ignored: "no_message" });
    }

    const chatId = message.chat.id;

    if (String(chatId) === String(markGroupChatId)) {
      console.log("mark-internal-group-skipped", { chatId, messageId: message.message_id });
      return NextResponse.json({ ok: true, ignored: "mark_internal_group" });
    }

    console.log("incoming-message-received", { chatId, messageId: message.message_id });

    const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
    const hasImageAttachment = hasPhoto || isImageDocument(message.document);
    const caption = (message.caption ?? "").trim();
    const text = (message.text ?? caption).trim();
    const clientMessageText = text || (hasImageAttachment ? "Image/screenshot sent by client." : "");

    if (!clientMessageText) {
      return NextResponse.json({ ok: true, ignored: "empty_message" });
    }

    const isEditedMessage = Boolean(update.edited_message || update.edited_channel_post);

    if (isEditedMessage) {
      const { data: existingMessage, error: existingMessageError } = await supabase
        .from("messages")
        .select("id")
        .eq("telegram_message_id", message.message_id)
        .eq("telegram_chat_id", chatId)
        .in("message_type", ["client", "client_photo"])
        .maybeSingle();

      if (existingMessageError) throw new Error(`Supabase edited message lookup failed: ${existingMessageError.message}`);
      if (!existingMessage?.id) {
        console.log("edited-message-no-unprocessed-row", { chatId, messageId: message.message_id });
        return NextResponse.json({ ok: true, ignored: "edited_message_not_queued" });
      }

      const { data: processedTicket, error: processedTicketError } = await supabase
        .from("tickets")
        .select("id")
        .eq("client_message_id", existingMessage.id)
        .limit(1)
        .maybeSingle();

      if (processedTicketError) throw new Error(`Supabase edited message ticket lookup failed: ${processedTicketError.message}`);
      if (processedTicket?.id) {
        console.log("edited-message-already-processed", { chatId, messageId: message.message_id });
        return NextResponse.json({ ok: true, ignored: "edited_message_already_processed" });
      }

      const { data: storedMessage, error: messageError } = await supabase
        .from("messages")
        .update({
          telegram_user_id: message.from?.id ?? null,
          telegram_username: message.from?.username ?? null,
          message_text: clientMessageText,
          message_type: hasImageAttachment ? "client_photo" : "client",
          raw_payload: update,
          ...(typeof message.date === "number" ? { created_at: new Date(message.date * 1000).toISOString() } : {})
        })
        .eq("id", existingMessage.id)
        .select("id, created_at, message_text, message_type, telegram_message_id")
        .single();

      if (messageError) throw new Error(`Supabase edited message update failed: ${messageError.message}`);
      console.log("telegram-message-edited", { chatId, messageId: message.message_id, rowId: storedMessage?.id });
      return NextResponse.json({ ok: true, queued: true, edited: true, rowId: storedMessage?.id ?? null });
    }

    const { data: insertedMessage, error: insertSelectError } = await supabase
      .from("messages")
      .insert({
        telegram_message_id: message.message_id,
        telegram_chat_id: chatId,
        telegram_user_id: message.from?.id ?? null,
        telegram_username: message.from?.username ?? null,
        message_text: clientMessageText,
        message_type: hasImageAttachment ? "client_photo" : "client",
        raw_payload: update,
        ...(typeof message.date === "number" ? { created_at: new Date(message.date * 1000).toISOString() } : {})
      })
      .select("id, created_at, message_text, message_type, telegram_message_id")
      .single();

    if (insertSelectError) {
      console.error("supabase-insert-error", { table: "messages", message: insertSelectError.message });
      throw new Error(`Supabase messages insert failed: ${insertSelectError.message}`);
    }

    console.log("telegram-message-saved", { chatId, messageId: message.message_id, rowId: insertedMessage?.id });

    if (hasImageAttachment) {
      console.log("media-message-queued", { chatId, messageId: message.message_id, rowId: insertedMessage?.id });
    } else {
      console.log("text-message-queued", { chatId, messageId: message.message_id, rowId: insertedMessage?.id });
      console.log("instant-mark-forward-disabled", { chatId, messageId: message.message_id });
      console.log("mark-instant-text-forward-disabled", { chatId, messageId: message.message_id });
      console.log("conversation-burst-message-held-for-batch", { chatId, messageId: message.message_id });
    }

    return NextResponse.json({ ok: true, queued: true, rowId: insertedMessage?.id ?? null });
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
