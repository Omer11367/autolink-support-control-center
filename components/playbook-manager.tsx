"use client";

import { Save, Search, Sprout } from "lucide-react";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/status-badge";
import { Button, Card, Input, SecondaryButton, Textarea } from "@/components/ui";
import { formatIntentLabel } from "@/lib/display";
import type { PlaybookEntry } from "@/lib/types";

type FormState = {
  id?: string;
  intent: string;
  title: string;
  description: string;
  detection_rules: string;
  first_response_examples: string;
  completion_examples: string;
  escalation_rules: string;
  is_active: boolean;
};

const emptyForm: FormState = {
  intent: "",
  title: "",
  description: "",
  detection_rules: "",
  first_response_examples: "",
  completion_examples: "",
  escalation_rules: "",
  is_active: true
};

function entryToForm(entry: PlaybookEntry): FormState {
  return {
    id: entry.id,
    intent: entry.intent,
    title: entry.title,
    description: entry.description ?? "",
    detection_rules: entry.detection_rules ?? "",
    first_response_examples: (entry.first_response_examples ?? []).join("\n"),
    completion_examples: (entry.completion_examples ?? []).join("\n"),
    escalation_rules: entry.escalation_rules ?? "",
    is_active: Boolean(entry.is_active)
  };
}

function nonEmptyString(value: string): value is string {
  return Boolean(value);
}

function payloadFromForm(form: FormState) {
  return {
    intent: form.intent.trim(),
    title: form.title.trim(),
    description: form.description.trim(),
    detection_rules: form.detection_rules.trim(),
    first_response_examples: form.first_response_examples.split("\n").map((line) => line.trim()).filter(nonEmptyString),
    completion_examples: form.completion_examples.split("\n").map((line) => line.trim()).filter(nonEmptyString),
    escalation_rules: form.escalation_rules.trim(),
    is_active: form.is_active
  };
}

export function PlaybookManager({ entries }: { entries: PlaybookEntry[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "inactive">("all");
  const [form, setForm] = useState<FormState>(emptyForm);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return entries.filter((entry) => {
      const matchesStatus =
        activeFilter === "all" ||
        (activeFilter === "active" && entry.is_active) ||
        (activeFilter === "inactive" && !entry.is_active);
      const matchesSearch = !term || `${entry.intent} ${entry.title} ${entry.description ?? ""}`.toLowerCase().includes(term);
      return matchesStatus && matchesSearch;
    });
  }, [activeFilter, entries, query]);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function save() {
    setNotice(null);
    setError(null);

    if (!form.intent.trim() || !form.title.trim()) {
      setError("Intent and title are required.");
      return;
    }

    startTransition(async () => {
      const response = await fetch(form.id ? `/api/playbook/${form.id}` : "/api/playbook", {
        method: form.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadFromForm(form))
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "Save failed.");
        return;
      }

      setNotice(form.id ? "Playbook entry updated." : "Playbook entry created.");
      setForm(emptyForm);
      router.refresh();
    });
  }

  function seed() {
    setNotice(null);
    setError(null);
    startTransition(async () => {
      const response = await fetch("/api/playbook/seed", { method: "POST" });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "Seed failed.");
        return;
      }
      setNotice(`Seed complete. Inserted ${payload.inserted} entries.`);
      router.refresh();
    });
  }

  function deactivate(entry: PlaybookEntry) {
    setNotice(null);
    setError(null);
    startTransition(async () => {
      const response = await fetch(`/api/playbook/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payloadFromForm(entryToForm(entry)), is_active: false })
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "Deactivate failed.");
        return;
      }

      setNotice("Playbook entry deactivated.");
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[0.95fr_1.2fr]">
      <Card>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">{form.id ? "Edit entry" : "Create entry"}</h2>
          <SecondaryButton onClick={seed} disabled={isPending}>
            <Sprout className="h-4 w-4" aria-hidden="true" />
            Seed Playbook
          </SecondaryButton>
        </div>

        <div className="mt-4 space-y-3">
          <Input value={form.intent} onChange={(event) => update("intent", event.target.value)} placeholder="intent" />
          <Input value={form.title} onChange={(event) => update("title", event.target.value)} placeholder="title" />
          <Textarea value={form.description} onChange={(event) => update("description", event.target.value)} placeholder="description" />
          <Textarea value={form.detection_rules} onChange={(event) => update("detection_rules", event.target.value)} placeholder="detection rules" />
          <Textarea value={form.first_response_examples} onChange={(event) => update("first_response_examples", event.target.value)} placeholder="first responses, one per line" />
          <Textarea value={form.completion_examples} onChange={(event) => update("completion_examples", event.target.value)} placeholder="completion responses, one per line" />
          <Textarea value={form.escalation_rules} onChange={(event) => update("escalation_rules", event.target.value)} placeholder="escalation rules" />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.is_active} onChange={(event) => update("is_active", event.target.checked)} />
            Active
          </label>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={isPending}>
              <Save className="h-4 w-4" aria-hidden="true" />
              Save
            </Button>
            {form.id ? <SecondaryButton onClick={() => setForm(emptyForm)} disabled={isPending}>Cancel edit</SecondaryButton> : null}
          </div>
          {notice ? <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-200">{notice}</p> : null}
          {error ? <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">{error}</p> : null}
        </div>
      </Card>

      <div className="space-y-3">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input className="pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search intent, title, or description" />
        </label>
        <div className="flex flex-wrap gap-2">
          {(["all", "active", "inactive"] as const).map((filter) => (
            <button
              key={filter}
              type="button"
              onClick={() => setActiveFilter(filter)}
              className={activeFilter === filter ? "rounded-full bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground" : "rounded-full border border-border bg-card px-3 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted"}
            >
              {filter[0].toUpperCase() + filter.slice(1)}
            </button>
          ))}
        </div>

        {filtered.length === 0 ? (
          <Card className="text-sm text-muted-foreground">No playbook entries match this search.</Card>
        ) : filtered.map((entry) => (
          <Card key={entry.id}>
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-bold">{formatIntentLabel(entry.intent)}</h3>
                  <StatusBadge value={entry.is_active ? "resolved" : "closed"} label={entry.is_active ? "Active" : "Inactive"} />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{entry.title}</p>
                <p className="mt-1 font-mono text-xs text-muted-foreground">{entry.intent}</p>
              </div>
              <div className="flex gap-2">
                <SecondaryButton onClick={() => setForm(entryToForm(entry))}>Edit</SecondaryButton>
                <SecondaryButton onClick={() => deactivate(entry)} disabled={isPending}>Deactivate</SecondaryButton>
              </div>
            </div>
            <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
              <div>
                <p className="font-semibold">Detection</p>
                <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{entry.detection_rules ?? "No detection rules."}</p>
              </div>
              <div>
                <p className="font-semibold">Escalation</p>
                <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{entry.escalation_rules ?? "No escalation rules."}</p>
              </div>
              <div>
                <p className="font-semibold">First responses</p>
                <p className="mt-1 text-xs text-muted-foreground">{(entry.first_response_examples ?? []).length} saved</p>
                <ul className="mt-1 space-y-1 text-muted-foreground">
                  {(entry.first_response_examples ?? []).map((example, index) => <li key={index}>{example}</li>)}
                </ul>
              </div>
              <div>
                <p className="font-semibold">Completion responses</p>
                <p className="mt-1 text-xs text-muted-foreground">{(entry.completion_examples ?? []).length} saved</p>
                <ul className="mt-1 space-y-1 text-muted-foreground">
                  {(entry.completion_examples ?? []).map((example, index) => <li key={index}>{example}</li>)}
                </ul>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
