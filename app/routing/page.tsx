import { createSupabaseAdminClient, hasSupabaseServerEnv } from "@/lib/supabase/admin";
import { RoutingManager } from "@/components/routing-manager";

export const dynamic = "force-dynamic";

async function getInitialData() {
  if (!hasSupabaseServerEnv()) {
    return { markGroups: [], clientGroups: [] };
  }
  const supabase = createSupabaseAdminClient();

  const [{ data: markGroupsData }, { data: messagesData }, { data: clientGroupsData }] =
    await Promise.all([
      supabase.from("mark_groups").select("*").order("created_at", { ascending: true }),
      supabase
        .from("messages")
        .select("telegram_chat_id, raw_payload, created_at")
        .not("telegram_chat_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(5000),
      supabase.from("client_groups").select("*")
    ]);

  const assignmentMap = new Map(
    (clientGroupsData ?? []).map((cg) => [String(cg.telegram_chat_id), cg])
  );

  type RawPayload = {
    message?: { chat?: { title?: string } };
    edited_message?: { chat?: { title?: string } };
    channel_post?: { chat?: { title?: string } };
  };

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
    const payload = msg.raw_payload as RawPayload | null;
    const groupName =
      assignment?.group_name ??
      payload?.message?.chat?.title ??
      payload?.edited_message?.chat?.title ??
      payload?.channel_post?.chat?.title ??
      chatId;
    seen.set(chatId, {
      telegram_chat_id: chatId,
      group_name: groupName,
      mark_group_id: assignment?.mark_group_id ?? null,
      last_seen: msg.created_at ?? ""
    });
  }

  return {
    markGroups: markGroupsData ?? [],
    clientGroups: Array.from(seen.values())
  };
}

export default async function RoutingPage() {
  const { markGroups, clientGroups } = await getInitialData();
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-normal">Routing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Manage your agency groups and assign each client group to the right one.
          Only assigned clients will appear in that agency&apos;s request batch.
        </p>
      </header>
      <RoutingManager initialMarkGroups={markGroups} initialClientGroups={clientGroups} />
    </div>
  );
}
