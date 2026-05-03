"use client";

import { Check, Send, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button, SecondaryButton, Textarea } from "@/components/ui";
import { actionLabel, resolveCompletionMessage, type MarkActionType } from "@/lib/playbook";
import type { ActionRecommendation } from "@/lib/operations";

const actionTypes: MarkActionType[] = [
  "done",
  "already_shared",
  "only_view_access",
  "funds_arrived",
  "not_available",
  "handled"
];

type TicketActionsProps = {
  ticketId: string;
  clientUsername?: string | null;
  recommendation: ActionRecommendation;
};

export function TicketActions({ ticketId, clientUsername, recommendation }: TicketActionsProps) {
  const router = useRouter();
  const [customReply, setCustomReply] = useState("");
  const initialAction = recommendation.action === "reclassify_first" ? "handled" : recommendation.action;
  const [selectedAction, setSelectedAction] = useState<MarkActionType>(initialAction);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function selectAction(actionType: MarkActionType) {
    setSelectedAction(actionType);
    setMessage(null);
    setError(null);
  }

  function runSelectedAction() {
    startTransition(async () => {
      const response = await fetch(`/api/tickets/${ticketId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actionType: selectedAction, customReply })
      });

      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "Action failed.");
        return;
      }

      setMessage(
        payload.telegramSent
          ? "Action saved and Telegram completion sent."
          : `Action saved. Telegram skipped: ${payload.telegramSkippedReason ?? "not required"}.`
      );
      if (selectedAction === "custom_reply") setCustomReply("");
      router.refresh();
    });
  }

  const previewMessage = selectedAction === "close"
    ? "Close will update the ticket to closed and will not send Telegram."
    : resolveCompletionMessage(selectedAction, clientUsername, customReply) || "Write a custom reply to preview the message.";

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {actionTypes.map((actionType) => (
          <Button key={actionType} onClick={() => selectAction(actionType)} disabled={isPending} className={selectedAction === actionType ? "ring-2 ring-primary/40" : ""}>
            <Check className="h-4 w-4" aria-hidden="true" />
            {actionLabel(actionType)}
          </Button>
        ))}
        <SecondaryButton className="border-danger/30 text-danger hover:bg-danger/10" onClick={() => selectAction("close")} disabled={isPending}>
          <X className="h-4 w-4" aria-hidden="true" />
          Close
        </SecondaryButton>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-semibold" htmlFor="custom-reply">Custom reply</label>
        <Textarea
          id="custom-reply"
          value={customReply}
          onChange={(event) => setCustomReply(event.target.value)}
          onFocus={() => selectAction("custom_reply")}
          placeholder="Write exact client-facing response"
        />
        <Button onClick={() => selectAction("custom_reply")} disabled={isPending || !customReply.trim()}>
          <Send className="h-4 w-4" aria-hidden="true" />
          Preview custom reply
        </Button>
      </div>

      <div className="rounded-md border border-border bg-muted p-3">
        <p className="text-xs font-semibold uppercase text-muted-foreground">Message preview</p>
        <p className="mt-2 whitespace-pre-wrap text-sm">{previewMessage}</p>
        {selectedAction !== "close" ? <div className="mt-3"><CopyButton value={previewMessage} label="Copy reply" /></div> : null}
      </div>

      <Button onClick={runSelectedAction} disabled={isPending || (selectedAction === "custom_reply" && !customReply.trim())}>
        Confirm and execute
      </Button>

      {message ? <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-200">{message}</p> : null}
      {error ? <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-red-700 dark:text-red-200">{error}</p> : null}
    </div>
  );
}
