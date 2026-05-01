"use client";

import { Brain, Send } from "lucide-react";
import { useState, useTransition } from "react";
import { StatusBadge } from "@/components/status-badge";
import { Button, Card, Textarea } from "@/components/ui";
import type { ClassifiedIntent } from "@/lib/intent-classifier";

export function TestLabClient() {
  const [message, setMessage] = useState("");
  const [previousContext, setPreviousContext] = useState("");
  const [result, setResult] = useState<ClassifiedIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function analyze() {
    setError(null);
    setResult(null);

    startTransition(async () => {
      const response = await fetch("/api/test-lab/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, previousContext })
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "Analyze failed.");
        return;
      }

      setResult(payload as ClassifiedIntent);
    });
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[0.9fr_1.1fr]">
      <Card>
        <div className="flex items-center gap-2">
          <Brain className="h-5 w-5" aria-hidden="true" />
          <h2 className="text-lg font-bold">Analyze client message</h2>
        </div>
        <div className="mt-4 space-y-3">
          <Textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Paste a Telegram client message..."
            className="min-h-40"
          />
          <Textarea
            value={previousContext}
            onChange={(event) => setPreviousContext(event.target.value)}
            placeholder="Previous 1-2 messages, optional"
          />
          <Button onClick={analyze} disabled={isPending || !message.trim()}>
            <Send className="h-4 w-4" aria-hidden="true" />
            Analyze
          </Button>
          {error ? <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">{error}</p> : null}
        </div>
      </Card>

      <Card>
        <h2 className="text-lg font-bold">Result</h2>
        {!result ? (
          <p className="mt-3 text-sm text-muted-foreground">Run an analysis to see intent, extraction, and Mark handoff details.</p>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap gap-2">
              <StatusBadge value={result.intent} type="neutral" label={result.humanLabel} />
              <StatusBadge value={result.confidence} type="priority" label={`Confidence: ${result.confidence}`} />
              <StatusBadge value={result.requiresMark ? "waiting_for_mark" : "closed"} label={result.requiresMark ? "Requires Mark" : "No Mark"} />
            </div>
            <dl className="grid gap-3 text-sm md:grid-cols-2">
              <div><dt className="font-semibold">Should reply</dt><dd className="text-muted-foreground">{result.shouldReply ? "yes" : "no"}</dd></div>
              <div><dt className="font-semibold">Close conversation</dt><dd className="text-muted-foreground">{result.closeConversation ? "yes" : "no"}</dd></div>
              <div><dt className="font-semibold">Access level</dt><dd className="text-muted-foreground">{result.accessLevel}</dd></div>
              <div><dt className="font-semibold">Holding message</dt><dd className="text-muted-foreground">{result.holdingMessage || "No reply"}</dd></div>
            </dl>
            <div>
              <p className="font-semibold">Internal summary</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{result.internalSummary}</p>
            </div>
            <div>
              <p className="font-semibold">Extracted data</p>
              <pre className="mt-1 max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(result.extractedData, null, 2)}</pre>
            </div>
            <div>
              <p className="font-semibold">Completion options</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {result.completionOptions.map((option) => <StatusBadge key={option} value={option} type="neutral" label={option} />)}
              </div>
            </div>
            <div>
              <p className="font-semibold">Matched rules</p>
              <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                {result.matchedRules.map((rule) => <li key={rule}>{rule}</li>)}
              </ul>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
