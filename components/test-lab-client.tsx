"use client";

import { Brain, Send } from "lucide-react";
import { useState, useTransition } from "react";
import { StatusBadge } from "@/components/status-badge";
import { Button, Card, Textarea } from "@/components/ui";
import { getActionRecommendation } from "@/lib/operations";
import type { ClassifiedIntent } from "@/lib/intent-classifier";
import type { Ticket } from "@/lib/types";

const examples = [
  { label: "Deposit example", text: "Hello we sent 1500 USDT top up payment done please add funds" },
  { label: "Share ad account example", text: "Please share ad account 1234567890 to BM 987654321 full access" },
  { label: "Availability example", text: "Do you have GH accounts available today? Can we request 5?" },
  { label: "Refund example", text: "Please refund remaining balance to my TRC20 wallet address" },
  { label: "Policy example", text: "Can we run this offer domain? Is this website compliant with policy?" }
];

export function TestLabClient() {
  const [message, setMessage] = useState("");
  const [previousContext, setPreviousContext] = useState("");
  const [result, setResult] = useState<ClassifiedIntent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createMessage, setCreateMessage] = useState<string | null>(null);
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

  function createTestTicket() {
    setError(null);
    setCreateMessage(null);

    startTransition(async () => {
      const response = await fetch("/api/test-lab/create-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, previousContext })
      });
      const payload = await response.json();

      if (!response.ok) {
        setError(payload.error ?? "Create test ticket failed.");
        return;
      }

      setCreateMessage(`Created ${payload.ticket?.ticket_code ?? "test ticket"}.`);
    });
  }

  const recommendation = result
    ? getActionRecommendation({
        id: "preview",
        ticket_code: null,
        client_chat_id: null,
        client_message_id: null,
        client_user_id: null,
        client_username: "test_client",
        intent: result.intent,
        status: result.requiresMark ? "waiting_mark" : "new",
        priority: "normal",
        needs_mark: result.requiresMark,
        client_original_message: message,
        extracted_data: null,
        internal_summary: result.internalSummary,
        holding_message_id: null,
        internal_message_id: null,
        completion_message: null,
        created_at: null,
        updated_at: null
      } satisfies Ticket)
    : null;

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
          <div className="flex flex-wrap gap-2">
            {examples.map((example) => (
              <button
                key={example.label}
                type="button"
                onClick={() => setMessage(example.text)}
                className="rounded-full border border-border bg-card px-3 py-2 text-xs font-semibold text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                {example.label}
              </button>
            ))}
          </div>
          <Textarea
            value={previousContext}
            onChange={(event) => setPreviousContext(event.target.value)}
            placeholder="Previous 1-2 messages, optional"
          />
          <Button onClick={analyze} disabled={isPending || !message.trim()}>
            <Send className="h-4 w-4" aria-hidden="true" />
            Analyze
          </Button>
          {result ? (
            <Button onClick={createTestTicket} disabled={isPending || !message.trim()}>
              Create test ticket
            </Button>
          ) : null}
          {error ? <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">{error}</p> : null}
          {createMessage ? <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-200">{createMessage}</p> : null}
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
            {recommendation ? (
              <div className="rounded-md border border-border bg-muted p-3 text-sm">
                <p className="font-semibold">Recommended Mark action</p>
                <p className="mt-1 text-muted-foreground">{recommendation.label} | Risk: {recommendation.riskLevel}</p>
                <p className="mt-1 text-muted-foreground">{recommendation.reason}</p>
              </div>
            ) : null}
            <div>
              <p className="font-semibold">Internal summary</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{result.internalSummary}</p>
            </div>
            <div>
              <p className="font-semibold">Extracted data</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {Object.entries(result.extractedData).map(([key, value]) => (
                  <StatusBadge key={key} value={key} type="neutral" label={`${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`} />
                ))}
              </div>
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
