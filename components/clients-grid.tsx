"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Search, Users, TrendingUp } from "lucide-react";
import { Card, Input } from "@/components/ui";
import type { ClientSummary } from "@/app/api/activity/summary/route";

const CATEGORY_KEYS = ["Deposit", "Share", "Unshare", "Payment Issue", "Account Creation", "Verification", "Bans", "General"] as const;

const CATEGORY_COLOR: Record<string, string> = {
  Deposit:           "bg-emerald-500",
  Share:             "bg-blue-500",
  Unshare:           "bg-amber-500",
  "Payment Issue":   "bg-red-500",
  "Account Creation":"bg-violet-500",
  Verification:      "bg-cyan-500",
  Bans:              "bg-orange-500",
  General:           "bg-zinc-500",
};

const CATEGORY_TEXT: Record<string, string> = {
  Deposit:           "text-emerald-300",
  Share:             "text-blue-300",
  Unshare:           "text-amber-300",
  "Payment Issue":   "text-red-300",
  "Account Creation":"text-violet-300",
  Verification:      "text-cyan-300",
  Bans:              "text-orange-300",
  General:           "text-zinc-400",
};

function formatRelative(iso: string) {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function CategoryBar({ byCategory }: { byCategory: ClientSummary["byCategory"] }) {
  const total = CATEGORY_KEYS.reduce((s, k) => s + byCategory[k], 0);
  if (total === 0) return null;

  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
      {CATEGORY_KEYS.map((k) => {
        const pct = (byCategory[k] / total) * 100;
        if (pct === 0) return null;
        return (
          <div
            key={k}
            className={`${CATEGORY_COLOR[k]} transition-all`}
            style={{ width: `${pct}%` }}
            title={`${k}: ${byCategory[k]}`}
          />
        );
      })}
    </div>
  );
}

function ClientCard({ summary, onClick }: { summary: ClientSummary; onClick: () => void }) {
  const hasOpen = summary.open > 0;
  const topCategories = CATEGORY_KEYS
    .filter((k) => summary.byCategory[k] > 0)
    .sort((a, b) => summary.byCategory[b] - summary.byCategory[a])
    .slice(0, 3);

  return (
    <button
      onClick={onClick}
      className="group w-full rounded-xl border border-border bg-zinc-900/60 p-4 text-left transition hover:border-zinc-600 hover:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-400/20"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-100 group-hover:text-white">
            {summary.clientName}
          </p>
          {summary.agencyName && (
            <p className="mt-0.5 truncate text-xs text-zinc-500">{summary.agencyName}</p>
          )}
        </div>
        {hasOpen && (
          <span className="shrink-0 rounded-full bg-blue-500/20 px-2 py-0.5 text-xs font-bold text-blue-300">
            {summary.open} open
          </span>
        )}
      </div>

      <CategoryBar byCategory={summary.byCategory} />

      <div className="mt-3 flex flex-wrap gap-1.5">
        {topCategories.map((k) => (
          <span
            key={k}
            className={`text-xs font-medium ${CATEGORY_TEXT[k]}`}
          >
            {k} {summary.byCategory[k]}
          </span>
        ))}
        {topCategories.length < CATEGORY_KEYS.filter((k) => summary.byCategory[k] > 0).length && (
          <span className="text-xs text-zinc-600">…</span>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
        <span>{summary.total} requests</span>
        <span>{formatRelative(summary.lastActivity)}</span>
      </div>

      {summary.lastMessage && (
        <p className="mt-2 truncate text-xs text-zinc-600">{summary.lastMessage}</p>
      )}
    </button>
  );
}

export function ClientsGrid() {
  const router = useRouter();
  const [summaries, setSummaries] = useState<ClientSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/activity/summary");
      const json = await res.json() as { summaries: ClientSummary[] };
      setSummaries(json.summaries ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => { void fetchData(); }, 30_000);
    return () => clearInterval(interval);
  }, []);

  const filtered = search
    ? summaries.filter(
        (s) =>
          s.clientName.toLowerCase().includes(search.toLowerCase()) ||
          (s.agencyName ?? "").toLowerCase().includes(search.toLowerCase())
      )
    : summaries;

  const totalOpen = summaries.reduce((acc, s) => acc + s.open, 0);
  const totalRequests = summaries.reduce((acc, s) => acc + s.total, 0);

  return (
    <div className="space-y-5">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card className="text-center">
          <p className="text-2xl font-bold text-zinc-100">{summaries.length}</p>
          <p className="mt-0.5 text-xs text-zinc-500">Active clients</p>
        </Card>
        <Card className="text-center">
          <p className="text-2xl font-bold text-zinc-100">{totalRequests}</p>
          <p className="mt-0.5 text-xs text-zinc-500">Total requests</p>
        </Card>
        <Card className="col-span-2 text-center sm:col-span-1">
          <p className="text-2xl font-bold text-blue-300">{totalOpen}</p>
          <p className="mt-0.5 text-xs text-zinc-500">Open tickets</p>
        </Card>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <Input
            placeholder="Search client or agency…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <button
          onClick={() => void fetchData()}
          className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-zinc-900 px-3 py-2 text-sm font-semibold text-zinc-100 transition hover:bg-zinc-800"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      {/* Grid */}
      {loading ? (
        <div className="flex items-center justify-center py-24 text-sm text-zinc-500">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="flex items-center justify-center py-24 text-sm text-zinc-500">
          {search ? "No clients match your search" : "No client activity yet"}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((s) => (
              <ClientCard
                key={s.chatId}
                summary={s}
                onClick={() => router.push(`/activity/${s.chatId}`)}
              />
            ))}
          </div>
          <p className="text-right text-xs text-zinc-600">
            Showing {filtered.length} of {summaries.length} clients · auto-refreshes every 30s
          </p>
        </>
      )}
    </div>
  );
}
