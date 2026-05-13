"use client";

import { useState, useMemo } from "react";
import { Check, Loader2, Network, RefreshCw } from "lucide-react";
import { Card, Input, Select } from "@/components/ui";

type MarkGroup = {
  id: string;
  name: string;
  telegram_chat_id: string;
  created_at: string | null;
};

type KnownGroup = {
  telegram_chat_id: string;
  group_name: string;
  mark_group_id: string | null;
  group_type: string | null; // 'client' | 'agency' | 'master' | null
  last_seen: string;
};

type Props = {
  initialMarkGroups: MarkGroup[];
  initialKnownGroups: KnownGroup[];
};

function timeAgo(isoString: string): string {
  if (!isoString) return "—";
  const diff = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function TypeBadge({ type }: { type: string | null }) {
  if (type === "agency") return (
    <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-300">Agency</span>
  );
  if (type === "client") return (
    <span className="rounded-full border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 text-xs font-semibold text-blue-300">Client</span>
  );
  if (type === "master") return (
    <span className="rounded-full border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 text-xs font-semibold text-purple-300">Master</span>
  );
  return (
    <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-300">Unclassified</span>
  );
}

export function RoutingManager({ initialMarkGroups, initialKnownGroups }: Props) {
  const [markGroups, setMarkGroups] = useState<MarkGroup[]>(initialMarkGroups);
  const [knownGroups, setKnownGroups] = useState<KnownGroup[]>(initialKnownGroups);
  const [search, setSearch] = useState("");
  const [savingGroups, setSavingGroups] = useState<Set<string>>(new Set());
  const [savedGroups, setSavedGroups] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  const filteredGroups = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return knownGroups;
    return knownGroups.filter(
      (g) => g.group_name.toLowerCase().includes(q) || g.telegram_chat_id.includes(q)
    );
  }, [knownGroups, search]);

  // Agencies derived from known groups (for the assignment dropdown)
  const agencyGroups = useMemo(
    () => knownGroups.filter((g) => g.group_type === "agency"),
    [knownGroups]
  );

  function markSaving(chatId: string) {
    setSavingGroups((prev) => new Set(prev).add(chatId));
    setSavedGroups((prev) => { const s = new Set(prev); s.delete(chatId); return s; });
  }
  function markSaved(chatId: string) {
    setSavingGroups((prev) => { const s = new Set(prev); s.delete(chatId); return s; });
    setSavedGroups((prev) => new Set(prev).add(chatId));
    setTimeout(() => setSavedGroups((prev) => { const s = new Set(prev); s.delete(chatId); return s; }), 2000);
  }
  function markError(chatId: string) {
    setSavingGroups((prev) => { const s = new Set(prev); s.delete(chatId); return s; });
  }

  async function saveGroup(chatId: string, patch: { groupType?: string | null; markGroupId?: string | null; groupName?: string }) {
    markSaving(chatId);
    try {
      const group = knownGroups.find((g) => g.telegram_chat_id === chatId);
      const res = await fetch(`/api/client-groups/${encodeURIComponent(chatId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupName: patch.groupName ?? group?.group_name,
          groupType: patch.groupType !== undefined ? patch.groupType : group?.group_type,
          markGroupId: patch.markGroupId !== undefined ? patch.markGroupId : group?.mark_group_id
        })
      });
      if (!res.ok) { markError(chatId); return; }

      // Update local state
      setKnownGroups((prev) => prev.map((g) => {
        if (g.telegram_chat_id !== chatId) return g;
        return {
          ...g,
          group_type: patch.groupType !== undefined ? patch.groupType : g.group_type,
          mark_group_id: patch.markGroupId !== undefined ? patch.markGroupId : g.mark_group_id
        };
      }));

      // If newly classified as agency, refresh mark_groups list
      if (patch.groupType === "agency") {
        const { markGroups: fresh } = await fetch("/api/mark-groups").then((r) => r.json() as Promise<{ markGroups: MarkGroup[] }>);
        if (fresh) setMarkGroups(fresh);
      }

      markSaved(chatId);
    } catch {
      markError(chatId);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const res = await fetch("/api/client-groups");
      const json = await res.json() as { clientGroups?: KnownGroup[] };
      if (json.clientGroups) setKnownGroups(json.clientGroups);
    } finally {
      setRefreshing(false);
    }
  }

  const unclassifiedCount = knownGroups.filter((g) => !g.group_type).length;
  const clientCount = knownGroups.filter((g) => g.group_type === "client").length;
  const agencyCount = knownGroups.filter((g) => g.group_type === "agency").length;
  const masterCount = knownGroups.filter((g) => g.group_type === "master").length;

  return (
    <div className="space-y-6">
      {/* ── Summary strip ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-center">
          <p className="text-2xl font-bold">{agencyCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Agencies</p>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-center">
          <p className="text-2xl font-bold">{clientCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Clients</p>
        </div>
        <div className="rounded-lg border border-purple-500/20 bg-purple-500/5 px-4 py-3 text-center">
          <p className="text-2xl font-bold text-purple-300">{masterCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Master</p>
        </div>
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-center">
          <p className="text-2xl font-bold text-amber-300">{unclassifiedCount}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Unclassified</p>
        </div>
      </div>

      {/* ── All groups ─────────────────────────────────────────────────────── */}
      <Card className="p-0">
        <div className="flex items-start gap-3 px-4 py-4 border-b border-border">
          <div>
            <div className="flex items-center gap-2">
              <Network className="h-4 w-4 text-muted-foreground" />
              <h2 className="font-semibold">All Groups</h2>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              Every group the bot has joined. <strong>Agency</strong> receives request batches. <strong>Client</strong> sends requests. <strong>Master</strong> receives deposits only (photos, links, payment proofs). Unclassified groups are completely ignored.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <Input
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-48"
            />
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="rounded-lg border border-border p-2 text-muted-foreground hover:bg-zinc-900 hover:text-zinc-100 transition"
              title="Refresh group list"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {filteredGroups.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            {knownGroups.length === 0
              ? "No groups yet. Add the bot to a Telegram group — it will appear here automatically once someone sends a message."
              : "No groups match your search."}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredGroups.map((group) => {
              const isSaving = savingGroups.has(group.telegram_chat_id);
              const isSaved = savedGroups.has(group.telegram_chat_id);
              return (
                <div key={group.telegram_chat_id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  {/* Group info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-medium truncate">{group.group_name}</p>
                      <TypeBadge type={group.group_type} />
                    </div>
                    <p className="text-xs text-muted-foreground font-mono">{group.telegram_chat_id}</p>
                  </div>

                  {/* Last seen */}
                  <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">
                    {timeAgo(group.last_seen)}
                  </span>

                  {/* Type selector */}
                  <Select
                    value={group.group_type ?? ""}
                    onChange={(e) => saveGroup(group.telegram_chat_id, { groupType: e.target.value || null })}
                    disabled={isSaving}
                    className="w-36 text-xs shrink-0"
                  >
                    <option value="">— Unclassified —</option>
                    <option value="agency">Agency</option>
                    <option value="client">Client</option>
                    <option value="master">Master</option>
                  </Select>

                  {/* Agency assignment (only for client groups) */}
                  {group.group_type === "client" && (
                    <Select
                      value={group.mark_group_id ?? ""}
                      onChange={(e) => saveGroup(group.telegram_chat_id, { markGroupId: e.target.value || null })}
                      disabled={isSaving || markGroups.length === 0}
                      className="w-40 text-xs shrink-0"
                    >
                      <option value="">— No agency —</option>
                      {markGroups.map((mg) => (
                        <option key={mg.id} value={mg.id}>{mg.name}</option>
                      ))}
                    </Select>
                  )}

                  {/* Save indicator */}
                  <span className="w-5 shrink-0">
                    {isSaving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    {isSaved && !isSaving && <Check className="h-4 w-4 text-emerald-400" />}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {agencyCount === 0 && clientCount > 0 && (
        <p className="text-xs text-amber-400">
          ⚠️ You have client groups but no agency groups. Set at least one group as Agency so clients have somewhere to route requests.
        </p>
      )}
      {clientCount > 0 && knownGroups.filter((g) => g.group_type === "client" && !g.mark_group_id).length > 0 && agencyCount > 0 && (
        <p className="text-xs text-amber-400">
          ⚠️ Some client groups have no agency assigned — their requests will be skipped.
        </p>
      )}
    </div>
  );
}
