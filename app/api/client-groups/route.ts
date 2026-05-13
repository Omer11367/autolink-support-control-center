import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RawPayload = {
  message?: { chat?: { title?: string } };
  edited_message?: { chat?: { title?: string } };
  channel_post?: { chat?: { title?: string } };
};

function extractGroupName(rawPayload: unknown, fallback: string): string {
  const payload = rawPayload as RawPayload | null;
  return (
    payload?.message?.chat?.title ??
    payload?.edited_message?.chat?.title ??
    payload?.channel_post?.chat?.title ??
    fallback
  );
}

export async function GET() {
  const supabase = createSupabaseAdminClient();

  const [{ data: clientGroupsData, error: cgError }, { data: messagesData }] = await Promise.all([
    supabase.from("client_groups").select("*").order("created_at", { ascending: true }),
    supabase
      .from("messages")
      .select("telegram_chat_id, raw_payload, created_at")
      .not("telegram_chat_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(5000)
  ]);

  if (cgError) return NextResponse.json({ error: cgError.message }, { status: 500 });

  // client_groups is authoritative for group_type and mark_group_id
  const clientGroupsMap = new Map(
    (clientGroupsData ?? []).map((cg) => [String(cg.telegram_chat_id), cg])
  );

  // Discover all groups from messages table
  const seen = new Map<string, {
    telegram_chat_id: string;
    group_name: string;
    mark_group_id: string | null;
    group_type: string | null;
    last_seen: string;
  }>();

  for (const msg of (messagesData ?? [])) {
    const chatId = String(msg.telegram_chat_id ?? "");
    if (!chatId || seen.has(chatId)) continue;
    const cg = clientGroupsMap.get(chatId);
    seen.set(chatId, {
      telegram_chat_id: chatId,
      group_name: cg?.group_name ?? extractGroupName(msg.raw_payload, chatId),
      mark_group_id: cg?.mark_group_id ?? null,
      group_type: cg?.group_type ?? null,
      last_seen: msg.created_at ?? ""
    });
  }

  // Also include groups in client_groups that have no messages yet
  for (const [chatId, cg] of clientGroupsMap.entries()) {
    if (!seen.has(chatId)) {
      seen.set(chatId, {
        telegram_chat_id: chatId,
        group_name: cg.group_name ?? chatId,
        mark_group_id: cg.mark_group_id ?? null,
        group_type: cg.group_type ?? null,
        last_seen: ""
      });
    }
  }

  return NextResponse.json({ clientGroups: Array.from(seen.values()) });
}
