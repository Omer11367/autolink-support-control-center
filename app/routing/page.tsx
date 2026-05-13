import { createSupabaseAdminClient, hasSupabaseServerEnv } from "@/lib/supabase/admin";
import { RoutingManager } from "@/components/routing-manager";

export const dynamic = "force-dynamic";

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

async function getInitialData() {
  if (!hasSupabaseServerEnv()) {
    return { markGroups: [], knownGroups: [] };
  }
  const supabase = createSupabaseAdminClient();

  const [{ data: markGroupsData }, { data: clientGroupsData }, { data: messagesData }] =
    await Promise.all([
      supabase.from("mark_groups").select("*").order("created_at", { ascending: true }),
      supabase.from("client_groups").select("*").order("created_at", { ascending: true }),
      supabase
        .from("messages")
        .select("telegram_chat_id, raw_payload, created_at")
        .not("telegram_chat_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(5000)
    ]);

  // client_groups is authoritative for group_type and mark_group_id
  const clientGroupsMap = new Map(
    (clientGroupsData ?? []).map((cg) => [String(cg.telegram_chat_id), cg])
  );

  // Discover all groups from messages table (so groups that messaged before
  // auto-registration was added still appear here)
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
    const groupName = cg?.group_name ?? extractGroupName(msg.raw_payload, chatId);
    seen.set(chatId, {
      telegram_chat_id: chatId,
      group_name: groupName,
      mark_group_id: cg?.mark_group_id ?? null,
      group_type: cg?.group_type ?? null,
      last_seen: msg.created_at ?? ""
    });
  }

  // Also include groups in client_groups that haven't sent any messages yet
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

  return {
    markGroups: markGroupsData ?? [],
    knownGroups: Array.from(seen.values())
  };
}

export default async function RoutingPage() {
  const { markGroups, knownGroups } = await getInitialData();
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-normal">Routing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every group the bot joins appears here automatically. Set each as{" "}
          <strong>Agency</strong> (your providers — they receive the request batches) or{" "}
          <strong>Client</strong> (your clients — their requests get routed to an agency).
          Unclassified groups are completely ignored by the bot.
        </p>
      </header>
      <RoutingManager initialMarkGroups={markGroups} initialKnownGroups={knownGroups} />
    </div>
  );
}
