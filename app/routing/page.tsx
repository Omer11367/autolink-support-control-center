import { createSupabaseAdminClient, hasSupabaseServerEnv } from "@/lib/supabase/admin";
import { RoutingManager } from "@/components/routing-manager";

export const dynamic = "force-dynamic";

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
        .select("telegram_chat_id, created_at")
        .not("telegram_chat_id", "is", null)
        .order("created_at", { ascending: false })
        .limit(5000)
    ]);

  // Build last-seen map from messages
  const lastSeenMap = new Map<string, string>();
  for (const msg of (messagesData ?? [])) {
    const id = String(msg.telegram_chat_id ?? "");
    if (id && !lastSeenMap.has(id)) lastSeenMap.set(id, msg.created_at ?? "");
  }

  const knownGroups = (clientGroupsData ?? []).map((cg) => ({
    telegram_chat_id: String(cg.telegram_chat_id),
    group_name: cg.group_name ?? String(cg.telegram_chat_id),
    mark_group_id: cg.mark_group_id ?? null,
    group_type: (cg as Record<string, unknown>).group_type as string | null ?? null,
    last_seen: lastSeenMap.get(String(cg.telegram_chat_id)) ?? ""
  }));

  return {
    markGroups: markGroupsData ?? [],
    knownGroups
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
