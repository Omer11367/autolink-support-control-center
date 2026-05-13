import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RawPayload = {
  message?: { chat?: { title?: string; id?: number } };
  edited_message?: { chat?: { title?: string; id?: number } };
  channel_post?: { chat?: { title?: string; id?: number } };
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

  // Fetch last known message per chat to get group names and last-active timestamps
  const { data: messagesData, error: messagesError } = await supabase
    .from("messages")
    .select("telegram_chat_id, raw_payload, created_at")
    .not("telegram_chat_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(5000);
  if (messagesError) return NextResponse.json({ error: messagesError.message }, { status: 500 });

  // Fetch existing assignments
  const { data: clientGroupsData, error: cgError } = await supabase
    .from("client_groups")
    .select("*");
  if (cgError) return NextResponse.json({ error: cgError.message }, { status: 500 });

  const assignmentMap = new Map(
    (clientGroupsData ?? []).map((cg) => [String(cg.telegram_chat_id), cg])
  );

  // Deduplicate — keep only the most recent message per chat (messages ordered desc)
  const seen = new Map<string, {
    telegram_chat_id: string;
    group_name: string;
    mark_group_id: string | null;
    last_seen: string;
  }>();

  for (const msg of messagesData ?? []) {
    const chatId = String(msg.telegram_chat_id ?? "");
    if (!chatId || seen.has(chatId)) continue;
    const assignment = assignmentMap.get(chatId);
    const groupName = assignment?.group_name ?? extractGroupName(msg.raw_payload, chatId);
    seen.set(chatId, {
      telegram_chat_id: chatId,
      group_name: groupName,
      mark_group_id: assignment?.mark_group_id ?? null,
      last_seen: msg.created_at ?? ""
    });
  }

  return NextResponse.json({ clientGroups: Array.from(seen.values()) });
}
