"use client";

import { useState, useMemo } from "react";
import { Plus, Trash2, Check, Loader2, Network } from "lucide-react";
import { Button, SecondaryButton, Card, Input, Select } from "@/components/ui";

type MarkGroup = {
  id: string;
  name: string;
  telegram_chat_id: string;
  created_at: string | null;
};

type ClientGroup = {
  telegram_chat_id: string;
  group_name: string;
  mark_group_id: string | null;
  last_seen: string;
};

type Props = {
  initialMarkGroups: MarkGroup[];
  initialClientGroups: ClientGroup[];
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

export function RoutingManager({ initialMarkGroups, initialClientGroups }: Props) {
  const [markGroups, setMarkGroups] = useState<MarkGroup[]>(initialMarkGroups);
  const [clientGroups, setClientGroups] = useState<ClientGroup[]>(initialClientGroups);
  const [search, setSearch] = useState("");

  // Add mark group form
  const [newName, setNewName] = useState("");
  const [newChatId, setNewChatId] = useState("");
  const [addingGroup, setAddingGroup] = useState(false);
  const [addError, setAddError] = useState("");

  // Per-client saving state
  const [savingClients, setSavingClients] = useState<Set<string>>(new Set());
  const [savedClients, setSavedClients] = useState<Set<string>>(new Set());

  const filteredClients = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return clientGroups;
    return clientGroups.filter(
      (cg) =>
        cg.group_name.toLowerCase().includes(q) ||
        cg.telegram_chat_id.includes(q)
    );
  }, [clientGroups, search]);

  async function handleAddMarkGroup() {
    setAddError("");
    if (!newName.trim() || !newChatId.trim()) {
      setAddError("Both name and Telegram Chat ID are required.");
      return;
    }
    setAddingGroup(true);
    try {
      const res = await fetch("/api/mark-groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), telegramChatId: newChatId.trim() })
      });
      const json = await res.json() as { markGroup?: MarkGroup; error?: string };
      if (!res.ok || json.error) { setAddError(json.error ?? "Failed to add group."); return; }
      if (json.markGroup) {
        setMarkGroups((prev) => [...prev, json.markGroup!]);
        setNewName("");
        setNewChatId("");
      }
    } catch {
      setAddError("Network error. Please try again.");
    } finally {
      setAddingGroup(false);
    }
  }

  async function handleDeleteMarkGroup(id: string) {
    if (!confirm("Delete this agency group? All clients assigned to it will become unassigned.")) return;
    const res = await fetch(`/api/mark-groups/${id}`, { method: "DELETE" });
    if (res.ok) {
      setMarkGroups((prev) => prev.filter((mg) => mg.id !== id));
      setClientGroups((prev) =>
        prev.map((cg) => cg.mark_group_id === id ? { ...cg, mark_group_id: null } : cg)
      );
    }
  }

  async function handleAssignClient(chatId: string, markGroupId: string | null, groupName: string) {
    setSavingClients((prev) => new Set(prev).add(chatId));
    setSavedClients((prev) => { const s = new Set(prev); s.delete(chatId); return s; });
    try {
      const res = await fetch(`/api/client-groups/${encodeURIComponent(chatId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markGroupId, groupName })
      });
      if (res.ok) {
        setClientGroups((prev) =>
          prev.map((cg) => cg.telegram_chat_id === chatId ? { ...cg, mark_group_id: markGroupId } : cg)
        );
        setSavedClients((prev) => new Set(prev).add(chatId));
        setTimeout(() => setSavedClients((prev) => { const s = new Set(prev); s.delete(chatId); return s; }), 2000);
      }
    } finally {
      setSavingClients((prev) => { const s = new Set(prev); s.delete(chatId); return s; });
    }
  }

  const assignedCount = clientGroups.filter((cg) => cg.mark_group_id !== null).length;

  return (
    <div className="space-y-6">
      {/* ── Mark Groups ──────────────────────────────────────────────────── */}
      <Card>
        <div className="mb-4 flex items-center gap-2">
          <Network className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-semibold">Agency Groups</h2>
          <span className="ml-auto text-xs text-muted-foreground">{markGroups.length} group{markGroups.length !== 1 ? "s" : ""}</span>
        </div>

        {markGroups.length > 0 && (
          <div className="mb-4 divide-y divide-border rounded-md border border-border">
            {markGroups.map((mg) => {
              const clientCount = clientGroups.filter((cg) => cg.mark_group_id === mg.id).length;
              return (
                <div key={mg.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm">{mg.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{mg.telegram_chat_id}</p>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0">
                    {clientCount} client{clientCount !== 1 ? "s" : ""}
                  </span>
                  <button
                    onClick={() => handleDeleteMarkGroup(mg.id)}
                    className="shrink-0 rounded p-1.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-400 transition"
                    title="Delete agency group"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Add new mark group */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Add Agency Group</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              placeholder="Agency name (e.g. Mark Agency)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddMarkGroup()}
              className="flex-1"
            />
            <Input
              placeholder="Telegram group chat ID (e.g. -1001234567890)"
              value={newChatId}
              onChange={(e) => setNewChatId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddMarkGroup()}
              className="flex-1"
            />
            <Button onClick={handleAddMarkGroup} disabled={addingGroup} className="shrink-0">
              {addingGroup ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Add
            </Button>
          </div>
          {addError && <p className="text-xs text-red-400">{addError}</p>}
          <p className="text-xs text-muted-foreground">
            To find a Telegram group chat ID: add your bot to the group, send a message, then check
            the <span className="font-mono">telegram_chat_id</span> column in the messages table.
          </p>
        </div>
      </Card>

      {/* ── Client Groups ─────────────────────────────────────────────────── */}
      <Card className="p-0">
        <div className="flex items-center gap-3 px-4 py-4 border-b border-border">
          <div>
            <h2 className="font-semibold">Client Groups</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {assignedCount} of {clientGroups.length} assigned
              {markGroups.length === 0 && (
                <span className="ml-2 text-amber-400">— add an agency group above first</span>
              )}
            </p>
          </div>
          <div className="ml-auto w-64">
            <Input
              placeholder="Search groups…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {filteredClients.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-muted-foreground">
            {clientGroups.length === 0
              ? "No client groups found yet. Once clients send messages through the bot, they appear here."
              : "No groups match your search."}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredClients.map((cg) => {
              const isSaving = savingClients.has(cg.telegram_chat_id);
              const isSaved = savedClients.has(cg.telegram_chat_id);
              return (
                <div key={cg.telegram_chat_id} className="flex items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{cg.group_name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{cg.telegram_chat_id}</p>
                  </div>
                  <span className="text-xs text-muted-foreground shrink-0 hidden sm:block">
                    {timeAgo(cg.last_seen)}
                  </span>
                  <div className="flex items-center gap-2 shrink-0">
                    <Select
                      value={cg.mark_group_id ?? ""}
                      onChange={(e) => handleAssignClient(cg.telegram_chat_id, e.target.value || null, cg.group_name)}
                      disabled={isSaving || markGroups.length === 0}
                      className="w-44 text-xs"
                    >
                      <option value="">— Not assigned (skip) —</option>
                      {markGroups.map((mg) => (
                        <option key={mg.id} value={mg.id}>
                          {mg.name}
                        </option>
                      ))}
                    </Select>
                    <span className="w-5 shrink-0">
                      {isSaving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                      {isSaved && !isSaving && <Check className="h-4 w-4 text-emerald-400" />}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <SecondaryButton
        onClick={async () => {
          const res = await fetch("/api/client-groups");
          const json = await res.json() as { clientGroups?: ClientGroup[] };
          if (json.clientGroups) setClientGroups(json.clientGroups);
        }}
        className="text-xs"
      >
        Refresh client list
      </SecondaryButton>
    </div>
  );
}
