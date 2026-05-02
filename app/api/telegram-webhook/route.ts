import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildGuardianMirrorMessage, shouldIgnoreTelegramMessage } from "@/lib/guardian-mirror";
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
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
};

type TelegramSendResponse = {
  ok: boolean;
  description?: string;
  result?: {
    message_id?: number;
  };
};

const HOLDING_MESSAGE = "Hello! I'll check this now and update you shortly.";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
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
    throw new Error(payload.description ?? "Telegram send failed.");
  }

  return payload.result?.message_id;
}

function createTicketCode(): string {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().slice(0, 6).toUpperCase();
  return `AL-${stamp}-${suffix}`;
}

export async function POST(request: Request) {
  try {
    const botToken = env("TELEGRAM_BOT_TOKEN");
    const guardianChatId = env("MARK_GROUP_CHAT_ID");
    const supabaseUrl = env("NEXT_PUBLIC_SUPABASE_URL");
    const serviceRoleKey = env("SERVICE_ROLE_KEY");

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const update = (await request.json()) as TelegramUpdate;
    const message = update.message;

    if (!message?.chat?.id) {
      return NextResponse.json({ ok: true, ignored: "no_message" });
    }

    const chatId = message.chat.id;

    if (String(chatId) === String(guardianChatId)) {
      return NextResponse.json({ ok: true, ignored: "guardian_group" });
    }

    const text = (message.text ?? message.caption ?? "").trim();

    if (!text || shouldIgnoreTelegramMessage(text)) {
      return NextResponse.json({ ok: true, ignored: "empty_or_reaction" });
    }

    const classification = classifyIntent(text);
    const guardianMessage = buildGuardianMirrorMessage(text) ?? text;

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
      .select("id")
      .single();

    if (messageError) throw new Error(messageError.message);

    const holdingMessageId = await sendTelegramMessage(botToken, chatId, HOLDING_MESSAGE);
    const guardianMessageId = await sendTelegramMessage(botToken, guardianChatId, guardianMessage);

    const { data: ticket, error: ticketError } = await supabase
      .from("tickets")
      .insert({
        ticket_code: createTicketCode(),
        client_chat_id: chatId,
        client_message_id: storedMessage?.id ?? null,
        client_user_id: message.from?.id ?? null,
        client_username: message.from?.username ?? null,
        intent: classification.intent,
        status: classification.requiresMark ? "waiting_mark" : "new",
        priority: ["deposit_funds", "refund_request", "payment_issue", "check_policy"].includes(classification.intent) ? "high" : "normal",
        needs_mark: classification.requiresMark,
        client_original_message: text,
        extracted_data: classification.extractedData,
        internal_summary: classification.internalSummary,
        holding_message_id: holdingMessageId ?? null,
        internal_message_id: guardianMessageId ?? null
      })
      .select("id")
      .single();

    if (ticketError) throw new Error(ticketError.message);

    await supabase.from("bot_responses").insert([
      {
        ticket_id: ticket?.id ?? null,
        telegram_chat_id: chatId,
        telegram_message_id: holdingMessageId ?? null,
        response_type: "holding",
        response_text: HOLDING_MESSAGE
      },
      {
        ticket_id: ticket?.id ?? null,
        telegram_chat_id: Number(guardianChatId),
        telegram_message_id: guardianMessageId ?? null,
        response_type: "guardian_mirror",
        response_text: guardianMessage
      }
    ]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unexpected telegram webhook error."
      },
      { status: 500 }
    );
  }
}
