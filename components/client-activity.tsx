"use client";

import { useEffect, useState, useMemo } from "react";
import { ArrowLeft, Image as ImageIcon, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui";
import type { ActivityItem } from "@/app/api/activity/route";

const CATEGORIES = ["All", "Deposit", "Share", "Unshare", "Payment Issue", "Account Creation", "Verification", "Bans", "General"] as const;
type Category = typeof CATEGORIES[number];

const CATEGORY_STYLE: Record<string, string> = {
  Deposit:           "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  Share:             "bg-blue-500/15 text-blue-300 border-blue-500/30",
  Unshare:           "bg-amber-500/15 text-amber-300 border-amber-500/30",
  "Payment Issue":   "bg-red-500/15 text-red-300 border-red-500/30",
  "Account Creation":"bg-violet-500/15 text-violet-300 border-violet-500/30",
  Verification:      "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  Bans:              "bg-orange-500/15 text-orange-300 border-orange-500/30",
  General:           "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
};

const STATUS_STYLE: Record<string, string> = {
  open:          "bg-blue-500/15 text-blue-300",
  new:           "bg-violet-500/15 text-violet-300",
  waiting_mark:  "bg-amber-500/15 text-amber-300",
  closed:        "bg-emerald-500/15 text-emerald-300",
};

function Badge({ text, className }: { text: string; className: string }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${className}`}>
      {text}
    </span>
  );
}

function formatDate(iso: string) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

function PhotoThumb({ fileId }: { fileId: string }) {
  const src = `/api/activity/photo?fileId=${encodeURIComponent(fileId)}`;
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt="attachment"
        className="h-32 w-auto max-w-[240px] rounded-md border border-border object-cover transition hover:opacity-80"
      />
    </a>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const [expanded, setExpanded] = useState(false);
  const catStyle = CATEGORY_STYLE[item.category] ?? CATEGORY_STYLE.General;
  const statusStyle = STATUS_STYLE[item.status ?? ""] ?? "bg-zinc-500/15 text-zinc-400";

  return (
    <>
      <tr
        className="cursor-pointer border-b border-border transition hover:bg-zinc-900/60"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="whitespace-nowrap py-3 pl-4 pr-3 text-xs text-zinc-400">{formatDate(item.createdAt)}</td>
        <td className="py-3 pl-2 pr-3">
          <Badge text={item.category} className={catStyle} />
        </td>
        <td className="max-w-xs py-3 pl-2 pr-3 text-sm text-zinc-300">
          <p className="truncate">{item.message ?? "—"}</p>
        </td>
        <td className="py-3 pl-2 pr-3">
          {item.status && <Badge text={item.status.replace(/_/g, " ")} className={statusStyle} />}
        </td>
        <td className="py-3 pl-2 pr-3 text-center">
          {item.photoFileIds.length > 0 && (
            <ImageIcon className="mx-auto h-4 w-4 text-zinc-400" />
          )}
        </td>
        <td className="py-3 pl-2 pr-4 text-zinc-500">
          {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-border bg-zinc-900/40">
          <td colSpan={6} className="px-4 py-4">
            <div className="space-y-3">
              {item.ticketCode && (
                <p className="text-xs text-zinc-500">Ticket: <span className="font-mono text-zinc-300">{item.ticketCode}</span></p>
              )}
              {item.message && (
                <div>
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">Full message</p>
                  <p className="whitespace-pre-wrap text-sm text-zinc-200">{item.message}</p>
                </div>
              )}
              {item.photoFileIds.length > 0 && (
                <div>
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Attachments</p>
                  <div className="flex flex-wrap gap-3">
                    {item.photoFileIds.map((fid) => <PhotoThumb key={fid} fileId={fid} />)}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function CategoryTab({ label, count, active, onClick }: {
  label: Category;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition ${
        active
          ? "bg-zinc-100 text-zinc-950"
          : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
      }`}
    >
      {label}
      {count > 0 && (
        <span className={`rounded-full px-1.5 py-0.5 text-xs font-bold ${active ? "bg-zinc-300 text-zinc-800" : "bg-zinc-700 text-zinc-300"}`}>
          {count}
        </span>
      )}
    </button>
  );
}

export function ClientActivity({ chatId }: { chatId: string }) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [clientName, setClientName] = useState("");
  const [agencyName, setAgencyName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeCategory, setActiveCategory] = useState<Category>("All");

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/activity/client?chatId=${encodeURIComponent(chatId)}`);
      const json = await res.json() as { items: ActivityItem[]; clientName: string; agencyName: string | null };
      setItems(json.items ?? []);
      setClientName(json.clientName ?? chatId);
      setAgencyName(json.agencyName ?? null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => { void fetchData(); }, 30_000);
    return () => clearInterval(interval);
  }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const result: Record<Category, number> = { All: items.length, Deposit: 0, Share: 0, Unshare: 0, "Payment Issue": 0, "Account Creation": 0, Verification: 0, Bans: 0, General: 0 };
    for (const item of items) {
      const cat = item.category as Category;
      if (cat in result) result[cat]++;
    }
    return result;
  }, [items]);

  const filtered = useMemo(() => {
    if (activeCategory === "All") return items;
    return items.filter((i) => i.category === activeCategory);
  }, [items, activeCategory]);

  const openCount = useMemo(() => items.filter((i) => !["closed", "resolved", "done"].includes((i.status ?? "").toLowerCase())).length, [items]);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start gap-4">
        <Link
          href="/activity"
          className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-zinc-900 text-zinc-400 transition hover:text-zinc-100"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight text-zinc-100">{clientName || chatId}</h1>
          {agencyName && <p className="mt-0.5 text-sm text-zinc-500">Agency: {agencyName}</p>}
        </div>
        <div className="ml-auto shrink-0">
          <button
            onClick={() => void fetchData()}
            className="inline-flex min-h-9 items-center gap-2 rounded-md border border-border bg-zinc-900 px-3 py-2 text-sm font-semibold text-zinc-100 transition hover:bg-zinc-800"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="text-center">
          <p className="text-2xl font-bold text-zinc-100">{items.length}</p>
          <p className="mt-0.5 text-xs text-zinc-500">Total requests</p>
        </Card>
        <Card className="text-center">
          <p className="text-2xl font-bold text-blue-300">{openCount}</p>
          <p className="mt-0.5 text-xs text-zinc-500">Open tickets</p>
        </Card>
        <Card className="text-center">
          <p className="text-2xl font-bold text-emerald-300">{counts.Deposit}</p>
          <p className="mt-0.5 text-xs text-zinc-500">Deposits</p>
        </Card>
        <Card className="text-center">
          <p className="text-2xl font-bold text-red-300">{counts["Payment Issue"]}</p>
          <p className="mt-0.5 text-xs text-zinc-500">Payment issues</p>
        </Card>
      </div>

      {/* Category tabs */}
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-zinc-900/40 p-1">
        {CATEGORIES.filter((c) => c === "All" || counts[c] > 0).map((cat) => (
          <CategoryTab
            key={cat}
            label={cat}
            count={cat === "All" ? 0 : counts[cat]}
            active={activeCategory === cat}
            onClick={() => setActiveCategory(cat)}
          />
        ))}
      </div>

      {/* Table */}
      <Card className="overflow-hidden p-0">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-sm text-zinc-500">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-sm text-zinc-500">No activity in this category</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="border-b border-border bg-zinc-900/60">
                <tr>
                  <th className="py-3 pl-4 pr-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Date & Time</th>
                  <th className="py-3 pl-2 pr-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Category</th>
                  <th className="py-3 pl-2 pr-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Request</th>
                  <th className="py-3 pl-2 pr-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Status</th>
                  <th className="py-3 pl-2 pr-3 text-center text-xs font-semibold uppercase tracking-wide text-zinc-500">📷</th>
                  <th className="py-3 pl-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => <ActivityRow key={item.id} item={item} />)}
              </tbody>
            </table>
            <div className="border-t border-border px-4 py-3 text-xs text-zinc-500">
              Showing {filtered.length} of {items.length} requests · auto-refreshes every 30s
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
