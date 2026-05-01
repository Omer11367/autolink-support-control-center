import { ShieldCheck } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { Card } from "@/components/ui";
import { formatIntentLabel } from "@/lib/display";
import { GLOBAL_RULES, INTENT_LIBRARY } from "@/lib/intent-library";

export default function IntentsPage() {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-normal">Intent Library</h1>
        <p className="mt-1 text-sm text-muted-foreground">Current classification catalog for the Telegram support bot.</p>
      </header>

      <Card>
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          <h2 className="text-lg font-bold">Global rules</h2>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          {GLOBAL_RULES.map((rule) => (
            <div key={rule} className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">{rule}</div>
          ))}
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {INTENT_LIBRARY.map((intent) => (
          <Card key={intent.intent}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">{formatIntentLabel(intent.intent)}</h2>
                <p className="mt-1 text-sm font-mono text-muted-foreground">{intent.intent}</p>
              </div>
              <StatusBadge value={intent.requiresMark ? "waiting_for_mark" : "closed"} label={intent.requiresMark ? "Requires Mark" : "No Mark action"} />
            </div>
            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="font-semibold">When to detect</dt>
                <dd className="mt-1 text-muted-foreground">{intent.whenToDetect}</dd>
              </div>
              <div>
                <dt className="font-semibold">Default holding response</dt>
                <dd className="mt-1 whitespace-pre-wrap text-muted-foreground">{intent.defaultHoldingResponse}</dd>
              </div>
              <div>
                <dt className="font-semibold">Default completion response</dt>
                <dd className="mt-1 whitespace-pre-wrap text-muted-foreground">{intent.defaultCompletionResponse}</dd>
              </div>
            </dl>
          </Card>
        ))}
      </div>
    </div>
  );
}
