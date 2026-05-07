import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = Deno.env.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function requireEnv(names: string[]): string {
  const value = firstEnv(names);
  if (!value) throw new Error(`Missing environment variable: ${names.join(" or ")}`);
  return value;
}

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function isImageDocument(document?: TelegramMessage["document"]): boolean {
  return Boolean(document?.file_id && document.mime_type?.toLowerCase().startsWith("image/"));
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return json({ ok: true });
  }

  try {
    const markGroupChatId = requireEnv(["MARK_GROUP_CHAT_ID", "MARK_INTERNAL_CHAT_ID"]);
    const supabaseUrl = requireEnv(["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]);
    const serviceRoleKey = requireEnv(["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const update = (await request.json()) as TelegramUpdate;
    const message = update.message ?? update.edited_message ?? update.channel_post;

    if (!message?.chat?.id) {
      return json({ ok: true, ignored: "no_message" });
    }

    const chatId = message.chat.id;
    if (String(chatId) === String(markGroupChatId)) {
      console.log("mark-internal-group-skipped", { chatId, messageId: message.message_id });
      return json({ ok: true, ignored: "guardian_group" });
    }

    console.log("incoming-message-received", { chatId, messageId: message.message_id });
    const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
    const hasImageDocument = isImageDocument(message.document);
    const hasImageAttachment = hasPhoto || hasImageDocument;
    const text = (message.text ?? message.caption ?? "").trim();
    const clientMessageText = text || (hasImageAttachment ? "Image/screenshot sent by client." : "");

    if (!clientMessageText) {
      return json({ ok: true, ignored: "empty_message" });
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
      .select("id")
      .single();

    if (messageError) {
      throw new Error(`Supabase messages insert failed: ${messageError.message}`);
    }

    console.log("telegram-message-saved", { chatId, messageId: message.message_id, rowId: storedMessage?.id });
    if (hasImageAttachment) {
      console.log("media-message-queued", { chatId, messageId: message.message_id, rowId: storedMessage?.id });
    } else {
      console.log("text-message-queued", { chatId, messageId: message.message_id, rowId: storedMessage?.id });
      console.log("instant-mark-forward-disabled", { chatId, messageId: message.message_id });
    }

    return json({ ok: true, queued: true, rowId: storedMessage?.id ?? null });
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
