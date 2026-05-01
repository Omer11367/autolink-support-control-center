"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui";
import { formatIntentLabel } from "@/lib/display";
import type { ClassifiedIntent } from "@/lib/intent-classifier";

export function ReclassifyTicket({ ticketId, messageText, currentIntent }: { ticketId: string; messageText: string; currentIntent?: string | null }) {
  const router = useRouter();
  const [result, setResult] = useState<ClassifiedIntent | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function previewReclassify() {
    setError(null);
    setMessage(null);

    startTransition(async () => {
      const response = await fetch("/api/test-lab/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: messageText })
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "Preview failed.");
        return;
      }

      setResult(payload as ClassifiedIntent);
    });
  }

  function applyReclassify() {
    setError(null);
    setMessage(null);

    startTransition(async () => {
      const response = await fetch(`/api/tickets/${ticketId}/reclassify`, { method: "POST" });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "Apply failed.");
        return;
      }

      setResult(payload.result as ClassifiedIntent);
      setMessage("Reclassification applied.");
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <Button onClick={previewReclassify} disabled={isPending || !messageText.trim()}>
        <RefreshCw className="h-4 w-4" aria-hidden="true" />
        Reclassify
      </Button>

      {result ? (
        <div className="rounded-md border border-border bg-muted p-3 text-sm">
          <div className="flex flex-wrap gap-2">
            <StatusBadge value={currentIntent ?? "unknown"} type="neutral" label={`Current: ${formatIntentLabel(currentIntent)}`} />
            <StatusBadge value={result.intent} type="neutral" label={`Detected: ${result.humanLabel}`} />
            <StatusBadge value={result.confidence} type="priority" label={`Confidence: ${result.confidence}`} />
          </div>
          <div className="mt-3">
            <p className="font-semibold">Extracted data preview</p>
            <pre className="mt-1 max-h-56 overflow-auto rounded-md bg-background p-3 text-xs">{JSON.stringify(result.extractedData, null, 2)}</pre>
          </div>
          <p className="mt-3 font-semibold">Internal summary preview</p>
          <p className="mt-2 text-muted-foreground">{result.internalSummary}</p>
          <Button className="mt-3" onClick={applyReclassify} disabled={isPending}>
            Apply
          </Button>
        </div>
      ) : null}

      {message ? <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-200">{message}</p> : null}
      {error ? <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">{error}</p> : null}
    </div>
  );
}
