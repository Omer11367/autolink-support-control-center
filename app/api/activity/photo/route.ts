import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const fileId = new URL(request.url).searchParams.get("fileId");
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!fileId || !botToken) return NextResponse.json({ error: "missing params" }, { status: 400 });

  const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const fileData = await fileRes.json() as { ok: boolean; result?: { file_path: string } };
  if (!fileData.ok || !fileData.result?.file_path) return NextResponse.json({ error: "not found" }, { status: 404 });

  const imgUrl = `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
  return NextResponse.redirect(imgUrl);
}
