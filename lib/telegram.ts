import "server-only";

type SendTelegramMessageInput = {
  chatId: string | number;
  text: string;
};

export async function maybeSendTelegramMessage({ chatId, text }: SendTelegramMessageInput) {
  const token = process.env.TELEGRAM_BOT_TOKEN;

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
