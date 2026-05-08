import "server-only";

type SendTelegramMessageInput = {
  chatId: string | number;
  text: string;
  source?: "telegram_batch" | "manual_action";
};

export async function maybeSendTelegramMessage({ chatId, text, source }: SendTelegramMessageInput) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

  if (source !== "telegram_batch") {
    console.log("telegram-send-blocked-non-batch", { source: source ?? "unknown" });
    return {
      sent: false,
      telegramMessageId: null as number | null,
      reason: "Telegram sends are disabled outside the 5-minute batch route."
    };
  }

  if (!token || !chatId || !text.trim()) {
    return {
      sent: false,
      telegramMessageId: null as number | null,
      reason: "Telegram token, chat id, or text missing."
    };
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });

  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description ?? "Telegram send failed.");
  }

  return {
    sent: true,
    telegramMessageId: payload.result?.message_id ?? null,
    reason: null
  };
}
