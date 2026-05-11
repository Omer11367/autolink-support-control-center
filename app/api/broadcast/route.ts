import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return undefined;
}

type RawPayload = {
  message?: { chat?: { id?: number; title?: string } };
  edited_message?: { chat?: { id?: number; title?: string } };
  channel_post?: { chat?: { id?: number; title?: string } };
};

// GET /api/broadcast — returns the list of connected client chat IDs + titles.
export async function GET() {
  const markGroupChatId = firstEnv(["MARK_GROUP_CHAT_ID", "MARK_INTERNAL_CHAT_ID"]) ?? "";
  const supabase = createSupabaseAdminClient();

  const { data, error } = await supabase
    .from("messages")
    .select("telegram_chat_id, raw_payload")
    .in("message_type", ["client", "client_photo"])
    .not("telegram_chat_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(2000);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Collect unique chat IDs with the best title we can find.
  const seenChats = new Map<string, string>();
  for (const row of data ?? []) {
    const chatId = String(row.telegram_chat_id ?? "");
    if (!chatId || chatId === markGroupChatId) continue;
    if (seenChats.has(chatId)) continue;

    const payload = row.raw_payload as RawPayload | null;
    const msg = payload?.message ?? payload?.edited_message ?? payload?.channel_post;
    const title = msg?.chat?.title?.trim() || chatId;
    seenChats.set(chatId, title);
  }

  const chats = [...seenChats.entries()].map(([id, title]) => ({ id, title }));
  return NextResponse.json({ chats, total: chats.length });
}

// POST /api/broadcast — send a message (and optionally a photo) to all client groups.
// Body: multipart/form-data with fields:
//   text   — message text (optional if photo is provided)
//   photo  — image file (optional)
export async function POST(request: Request) {
  const token = firstEnv(["TELEGRAM_BOT_TOKEN"]);
  if (!token) {
    return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN not configured" }, { status: 500 });
  }

  const markGroupChatId = firstEnv(["MARK_GROUP_CHAT_ID", "MARK_INTERNAL_CHAT_ID"]) ?? "";

  let text = "";
  let photoFile: File | null = null;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    text = (form.get("text") as string | null)?.trim() ?? "";
    photoFile = (form.get("photo") as File | null) ?? null;
    if (photoFile && photoFile.size === 0) photoFile = null;
  } else {
    const body = (await request.json()) as { text?: string };
    text = body.text?.trim() ?? "";
  }

  if (!text && !photoFile) {
    return NextResponse.json({ error: "Provide at least a message or a photo." }, { status: 400 });
  }

  // Fetch all connected client chat IDs.
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("messages")
    .select("telegram_chat_id")
    .in("message_type", ["client", "client_photo"])
    .not("telegram_chat_id", "is", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const chatIds = [
    ...new Set(
      (data ?? [])
        .map((r) => String(r.telegram_chat_id ?? ""))
        .filter((id) => id && id !== markGroupChatId)
    )
  ];

  if (chatIds.length === 0) {
    return NextResponse.json({ sent: 0, failed: 0, total: 0, results: [] });
  }

  // Convert photo file to ArrayBuffer once (reused per chat).
  let photoBuffer: ArrayBuffer | null = null;
  let photoName = "photo.jpg";
  let photoMimeType = "image/jpeg";
  if (photoFile) {
    photoBuffer = await photoFile.arrayBuffer();
    photoName = photoFile.name || "photo.jpg";
    photoMimeType = photoFile.type || "image/jpeg";
  }

  const results: Array<{ chatId: string; success: boolean; error?: string }> = [];

  for (const chatId of chatIds) {
    try {
      let res: Response;

      if (photoBuffer) {
        // Send photo — recreate FormData each time (can't reuse a sent FormData).
        const tgForm = new FormData();
        tgForm.set("chat_id", chatId);
        tgForm.set("photo", new Blob([photoBuffer], { type: photoMimeType }), photoName);
        if (text) {
          tgForm.set("caption", text);
          tgForm.set("parse_mode", "HTML");
        }
        res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
          method: "POST",
          body: tgForm
        });
      } else {
        res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            parse_mode: "HTML",
            disable_web_page_preview: false
          })
        });
      }

      const payload = (await res.json()) as { ok: boolean; description?: string };
      results.push({ chatId, success: payload.ok, error: payload.ok ? undefined : (payload.description ?? "Unknown error") });
    } catch (err) {
      results.push({ chatId, success: false, error: err instanceof Error ? err.message : "Network error" });
    }
  }

  const sent = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;

  console.log("broadcast-sent", { sent, failed, total: results.length });

  return NextResponse.json({ sent, failed, total: results.length, results });
}
