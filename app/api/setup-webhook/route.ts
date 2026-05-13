import { NextResponse } from "next/server";

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

// GET  → returns current Telegram webhook info (useful for diagnosing missing allowed_updates)
// POST → registers / updates the webhook URL with the correct allowed_updates list
//        Body: { "url": "https://your-domain.com" }  (omit trailing slash and path)

export async function GET() {
  const botToken = firstEnv(["TELEGRAM_BOT_TOKEN"]);
  if (!botToken) return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN not set" }, { status: 500 });

  const res = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
  return NextResponse.json(await res.json());
}

export async function POST(request: Request) {
  const botToken = firstEnv(["TELEGRAM_BOT_TOKEN"]);
  if (!botToken) return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN not set" }, { status: 500 });

  const body = (await request.json()) as { url?: string };
  const base = body.url ?? firstEnv(["WEBHOOK_URL", "NEXT_PUBLIC_APP_URL"]);
  if (!base) {
    return NextResponse.json(
      { error: "Provide { url: 'https://your-domain.com' } in the request body or set WEBHOOK_URL env var" },
      { status: 400 }
    );
  }

  const webhookUrl = base.endsWith("/api/telegram-webhook")
    ? base
    : `${base.replace(/\/$/, "")}/api/telegram-webhook`;

  const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      allowed_updates: ["message", "edited_message", "channel_post", "edited_channel_post", "my_chat_member"]
    })
  });

  const data = await res.json();
  return NextResponse.json({ webhookUrl, telegram: data });
}
