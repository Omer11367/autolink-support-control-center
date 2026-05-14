"use client";

import { useState } from "react";
import { X, Download, ExternalLink, Loader2 } from "lucide-react";

type Preset = "today" | "7d" | "30d" | "90d" | "lifetime" | "custom";

const PRESETS: { id: Preset; label: string }[] = [
  { id: "today",    label: "Today" },
  { id: "7d",       label: "Last 7 days" },
  { id: "30d",      label: "Last 30 days" },
  { id: "90d",      label: "Last 90 days" },
  { id: "lifetime", label: "All time" },
  { id: "custom",   label: "Custom range" }
];

function presetToDates(preset: Preset): { from: string; to: string } {
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  if (preset === "today")    return { from: todayStr, to: todayStr };
  if (preset === "7d")       return { from: new Date(Date.now() - 7  * 86400000).toISOString().slice(0, 10), to: todayStr };
  if (preset === "30d")      return { from: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), to: todayStr };
  if (preset === "90d")      return { from: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10), to: todayStr };
  if (preset === "lifetime") return { from: "",        to: "" };
  return { from: "", to: "" };
}

type Props = {
  chatId: string;
  clientName: string;
  agencyName: string | null;
  onClose: () => void;
};

export function ClientExportModal({ chatId, clientName, agencyName, onClose }: Props) {
  const [preset, setPreset]       = useState<Preset>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo]   = useState("");
  const [loading, setLoading]     = useState(false);
  const [result, setResult]       = useState<{ ok: boolean; rows?: number; tabName?: string; sheetUrl?: string } | null>(null);

  const getRange = () => {
    if (preset === "custom") return { from: customFrom, to: customTo };
    return presetToDates(preset);
  };

  const handleExport = async () => {
    const { from, to } = getRange();
    setLoading(true);
    setResult(null);
    try {
      const params = new URLSearchParams({ chatId });
      if (from) params.set("from", from);
      if (to)   params.set("to",   to);
      const res  = await fetch(`/api/sheets-export/client?${params}`, { method: "POST" });
      const json = await res.json() as { ok: boolean; rows?: number; tabName?: string; sheetUrl?: string };
      setResult(json);
    } catch {
      setResult({ ok: false });
    } finally {
      setLoading(false);
    }
  };

  const { from, to } = getRange();
  const canExport = preset !== "custom" || (customFrom && customTo && customFrom <= customTo);

  return (
    // Backdrop
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md rounded-2xl border border-border bg-zinc-950 shadow-2xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-zinc-100">Export to Google Sheets</h2>
            <p className="mt-0.5 text-sm font-medium text-zinc-400">{clientName}</p>
            {agencyName && <p className="text-xs text-zinc-600">{agencyName}</p>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="space-y-5 px-5 py-5">
          {/* Preset buttons */}
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Date range</p>
            <div className="grid grid-cols-3 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => { setPreset(p.id); setResult(null); }}
                  className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                    preset === p.id
                      ? "border-zinc-400 bg-zinc-100 text-zinc-950"
                      : "border-border bg-zinc-900 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Custom date pickers */}
          {preset === "custom" && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <p className="mb-1 text-xs text-zinc-500">From</p>
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => { setCustomFrom(e.target.value); setResult(null); }}
                    className="w-full rounded-lg border border-border bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-2 focus:ring-zinc-400/20"
                  />
                </div>
                <div className="mt-5 text-zinc-600">→</div>
                <div className="flex-1">
                  <p className="mb-1 text-xs text-zinc-500">To</p>
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => { setCustomTo(e.target.value); setResult(null); }}
                    className="w-full rounded-lg border border-border bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:ring-2 focus:ring-zinc-400/20"
                  />
                </div>
              </div>
              {customFrom && customTo && customFrom > customTo && (
                <p className="text-xs text-red-400">Start date must be before end date</p>
              )}
            </div>
          )}

          {/* Range summary */}
          {preset !== "custom" && (
            <div className="rounded-lg border border-border bg-zinc-900/60 px-4 py-3">
              <p className="text-xs text-zinc-500">
                {preset === "lifetime"
                  ? "All requests ever — no date limit"
                  : `${from} → ${to}`}
              </p>
            </div>
          )}

          {/* Result */}
          {result && (
            <div className={`rounded-lg border px-4 py-3 ${result.ok ? "border-emerald-700/50 bg-emerald-950/40" : "border-red-700/50 bg-red-950/40"}`}>
              {result.ok ? (
                <div className="space-y-2">
                  <p className="text-sm font-semibold text-emerald-300">
                    ✓ Exported {result.rows} requests
                  </p>
                  {result.tabName && (
                    <p className="text-xs text-zinc-500">Tab: <span className="text-zinc-300">{result.tabName}</span></p>
                  )}
                  {result.sheetUrl && (
                    <a
                      href={result.sheetUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 hover:text-emerald-300 transition"
                    >
                      Open Google Sheet
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
              ) : (
                <p className="text-sm text-red-400">Export failed — check Google Sheets env vars in Vercel</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-border px-5 py-4">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition"
          >
            Close
          </button>
          <button
            onClick={() => void handleExport()}
            disabled={loading || !canExport}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-5 py-2 text-sm font-bold text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {loading ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
