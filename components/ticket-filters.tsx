"use client";

import { RotateCcw, Search } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Input, Select } from "@/components/ui";
import { formatIntentLabel, formatValueLabel } from "@/lib/display";

type TicketFiltersProps = {
  statuses: string[];
  intents: string[];
};

export function TicketFilters({ statuses, intents }: TicketFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams.toString());
    if (!value || value === "all") next.delete(key);
    else next.set(key, value);

    startTransition(() => {
      router.push(`/tickets?${next.toString()}`);
    });
  }

  function resetFilters() {
    startTransition(() => {
      router.push("/tickets");
    });
  }

  return (
    <div className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-[1.4fr_1fr_1fr_auto]">
      <label className="relative">
        <span className="sr-only">Search tickets</span>
        <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <Input
          className="pl-9"
          defaultValue={searchParams.get("search") ?? ""}
          placeholder="Search ticket, username, message, intent..."
          onKeyDown={(event) => {
            if (event.key === "Enter") updateParam("search", event.currentTarget.value);
          }}
          onBlur={(event) => updateParam("search", event.currentTarget.value)}
          disabled={isPending}
        />
      </label>
      <Select defaultValue={searchParams.get("status") ?? "all"} onChange={(event) => updateParam("status", event.target.value)} disabled={isPending} aria-label="Filter status">
        <option value="all">All statuses</option>
        {statuses.map((status) => <option key={status} value={status}>{formatValueLabel(status)}</option>)}
      </Select>
      <Select defaultValue={searchParams.get("intent") ?? "all"} onChange={(event) => updateParam("intent", event.target.value)} disabled={isPending} aria-label="Filter intent">
        <option value="all">All intents</option>
        {intents.map((intent) => <option key={intent} value={intent}>{formatIntentLabel(intent)}</option>)}
      </Select>
      <button
        type="button"
        onClick={resetFilters}
        disabled={isPending}
        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-semibold transition hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
      >
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
        Reset
      </button>
    </div>
  );
}
