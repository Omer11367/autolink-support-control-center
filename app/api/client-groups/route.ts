import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const supabase = createSupabaseAdminClient();

  // All known groups — auto-registered the first time they message the bot.
  const { data: clientGroupsData, error: cgError } = await supabase
    .from("client_groups")
    .select("*")
    .order("created_at", { ascending: true });
  if (cgError) return NextResponse.json({ error: cgError.message }, { status: 500 });

  // Last-seen timestamps from messages table (one scan, deduplicated).
  const { data: messagesData } = await supabase
    .from("messages")
    .select("telegram_chat_id, created_at")
    .not("telegram_chat_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(5000);

  const lastSeenMap = new Map<string, string>();
  for (const msg of (messagesData ?? [])) {
    const id = String(msg.telegram_chat_id ?? "");
    if (id && !lastSeenMap.has(id)) lastSeenMap.set(id, msg.created_at ?? "");
  }

  const groups = (clientGroupsData ?? []).map((cg) => ({
    telegram_chat_id: String(cg.telegram_chat_id),
    group_name: cg.group_name ?? String(cg.telegram_chat_id),
    mark_group_id: cg.mark_group_id ?? null,
    group_type: (cg as Record<string, unknown>).group_type as string | null ?? null,
    last_seen: lastSeenMap.get(String(cg.telegram_chat_id)) ?? ""
  }));

  return NextResponse.json({ clientGroups: groups });
}
