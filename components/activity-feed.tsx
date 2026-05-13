"use client";

import { useEffect, useState, useMemo } from "react";
import { Search, Image as ImageIcon, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { Card, Input, Select } from "@/components/ui";
import type { ActivityItem } from "@/app/api/activity/route";

const CATEGORIES = ["All", "Deposit", "Share", "Unshare", "Payment Issue", "Account Creation", "Verification", "Bans", "General"];

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

function Row({ item }: { item: ActivityItem }) {
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
        <td className="py-3 pl-2 pr-3 text-sm font-medium text-zinc-100">{item.clientName}</td>
        <td className="py-3 pl-2 pr-3">
          <Badge text={item.category} className={catStyle} />
        </td>
        <td className="max-w-xs py-3 pl-2 pr-3 text-sm text-zinc-300">
          <p className="truncate">{item.message ?? "—"}</p>
        </td>
        <td className="py-3 pl-2 pr-3">
          {item.status && <Badge text={item.status.replace(/_/g, " ")} className={statusStyle} />}
        </td>
        <td className="py-3 pl-2 pr-4 text-center">
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
          <td colSpan={7} className="px-4 py-4">
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

export function ActivityFeed() {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [client, setClient] = useState("All");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const fetchData = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (category && category !== "All") params.set("category", category);
      if (startDate) params.set("start", startDate);
      if (endDate) params.set("end", endDate);
      const res = await fetch(`/api/activity?${params.toString()}`);
      const json = await res.json() as { items: ActivityItem[] };
      setItems(json.items ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void fetchData(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const clientOptions = useMemo(() => {
    const names = Array.from(new Set(items.map((i) => i.clientName))).sort();
    return ["All", ...names];
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((i) => {
      if (client !== "All" && i.clientName !== client) return false;
      if (search && !i.clientName.toLowerCase().includes(search.toLowerCase()) &&
          !(i.message ?? "").toLowerCase().includes(search.toLowerCase()) &&
          !i.category.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [items, client, search]);

  // Stats
  const stats = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const todayItems = items.filter((i) => i.createdAt.startsWith(today));
    return {
      total: items.length,
      today: todayItems.length,
      deposits: items.filter((i) => i.category === "Deposit").length,
      issues: items.filter((i) => i.category === "Payment Issue").length,
    };
  }, [items]);

  return (
    <div className="space-y-5">
      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: "Total requests", value: stats.total },
          { label: "Today", value: stats.today },
          { label: "Deposits", value: stats.deposits },
          { label: "Payment issues", value: stats.issues },
        ].map((s) => (
          <Card key={s.label} className="text-center">
            <p className="text-2xl font-bold text-zinc-100">{s.value}</p>
            <p className="mt-0.5 text-xs text-zinc-500">{s.label}</p>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <Card className="flex flex-wrap items-end gap-3">
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <Input
            placeholder="Search client, message…"
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="w-40">
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </div>
        <div className="w-48">
          <Select value={client} onChange={(e) => setClient(e.target.value)}>
            {clientOptions.map((c) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="date"
            className="min-h-10 rounded-md border border-border bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-2 focus:ring-zinc-400/20"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
          <span className="text-xs text-zinc-500">to</span>
          <input
            type="date"
            className="min-h-10 rounded-md border border-border bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-2 focus:ring-zinc-400/20"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
        <button
          onClick={() => void fetchData()}
          className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-zinc-900 px-3 py-2 text-sm font-semibold text-zinc-100 transition hover:bg-zinc-800"
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </Card>

      {/* Table */}
      <Card className="p-0 overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-sm text-zinc-500">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-sm text-zinc-500">No activity found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="border-b border-border bg-zinc-900/60">
                <tr>
                  <th className="py-3 pl-4 pr-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Date & Time</th>
                  <th className="py-3 pl-2 pr-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Client</th>
                  <th className="py-3 pl-2 pr-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Category</th>
                  <th className="py-3 pl-2 pr-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Request</th>
                  <th className="py-3 pl-2 pr-3 text-xs font-semibold uppercase tracking-wide text-zinc-500">Status</th>
                  <th className="py-3 pl-2 pr-3 text-center text-xs font-semibold uppercase tracking-wide text-zinc-500">📷</th>
                  <th className="py-3 pl-2 pr-4" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => <Row key={item.id} item={item} />)}
              </tbody>
            </table>
            <div className="border-t border-border px-4 py-3 text-xs text-zinc-500">
              Showing {filtered.length} of {items.length} requests
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
