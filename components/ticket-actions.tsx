"use client";

import { Check, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CopyButton } from "@/components/copy-button";
import { Button, Textarea } from "@/components/ui";
import { resolveCompletionMessage, type MarkActionType } from "@/lib/playbook";
import type { ActionRecommendation } from "@/lib/operations";

type ActionButtonConfig = {
  id: string;
  label: string;
  actionType: MarkActionType;
  message: string;
};

const ACTION_BUTTONS_BY_INTENT: Record<string, ActionButtonConfig[]> = {
  share_account: [
    { id: "share-done", label: "Done", actionType: "done", message: "This is done. Kindly check on your end. Thank you!" },
    { id: "share-already-shared", label: "Already Shared", actionType: "already_shared", message: "Hello @{{username}}, this is already shared. Kindly check." },
    { id: "share-view-access", label: "Only View Access", actionType: "only_view_access", message: "The BM currently has view access only. Please confirm if full access is needed." },
    { id: "share-request-bm", label: "Request BM ID", actionType: "handled", message: "Hello @{{username}}, please send the correct BM ID." },
    { id: "share-request-account", label: "Request Account ID", actionType: "handled", message: "Hello @{{username}}, please send the ad account ID." },
    { id: "share-access-updated", label: "Access Updated", actionType: "done", message: "Hello @{{username}}, access has been updated. Please check." }
  ],
  unshare_account: [
    { id: "unshare-removed", label: "Removed", actionType: "done", message: "This has been removed. Kindly check on your end." },
    { id: "unshare-already-removed", label: "Already Removed", actionType: "already_shared", message: "Hello @{{username}}, this is already removed." },
    { id: "unshare-confirm-removal", label: "Confirm Removal", actionType: "handled", message: "Hello @{{username}}, the account has been removed. Please confirm." },
    { id: "unshare-request-bm", label: "Request BM ID", actionType: "handled", message: "Hello @{{username}}, please confirm the BM ID." },
    { id: "unshare-request-account", label: "Request Account ID", actionType: "handled", message: "Hello @{{username}}, please send the ad account ID." },
    { id: "unshare-partial-removal", label: "Partial Removal", actionType: "handled", message: "Hello @{{username}}, some accounts were removed. Please check." }
  ],
  deposit: [
    { id: "deposit-funds-arrived", label: "Funds Arrived", actionType: "funds_arrived", message: "Hello @{{username}}, we received your funds. Please check your balance." },
    { id: "deposit-payment-confirmed", label: "Payment Confirmed", actionType: "done", message: "Hello @{{username}}, your payment has been confirmed on our side. Thank you!" },
    { id: "deposit-checking-payment", label: "Checking Payment", actionType: "handled", message: "Hello @{{username}}, we are currently checking your payment." },
    { id: "deposit-request-proof", label: "Request Proof", actionType: "handled", message: "Hello @{{username}}, please send the payment proof so we can verify it." },
    { id: "deposit-amount-mismatch", label: "Amount Mismatch", actionType: "handled", message: "Hello @{{username}}, the amount received does not match. Please confirm the amount sent." },
    { id: "deposit-pending-confirmation", label: "Pending Confirmation", actionType: "handled", message: "Hello @{{username}}, the payment is still pending confirmation." }
  ],
  verification: [
    { id: "verification-checking", label: "Checking Verification", actionType: "handled", message: "Hello @{{username}}, we are checking the verification now." },
    { id: "verification-completed", label: "Verification Completed", actionType: "done", message: "Hello @{{username}}, verification has been completed. Please check." },
    { id: "verification-still-required", label: "Still Required", actionType: "handled", message: "Hello @{{username}}, verification is still required on this account." },
    { id: "verification-request-screenshot", label: "Request Screenshot", actionType: "handled", message: "Hello @{{username}}, please send a screenshot of the verification issue." },
    { id: "verification-card-check", label: "Card Check", actionType: "handled", message: "Hello @{{username}}, we are checking the card verification now." },
    { id: "verification-failed", label: "Failed Verification", actionType: "handled", message: "Hello @{{username}}, verification failed. Please check the account details." }
  ],
  general_support: [
    { id: "general-checking", label: "Checking", actionType: "handled", message: "Hello @{{username}}, we are checking this now." },
    { id: "general-understood", label: "Understood", actionType: "handled", message: "Hello @{{username}}, understood." },
    { id: "general-request-info", label: "Request Info", actionType: "handled", message: "Hello @{{username}}, please send more details." },
    { id: "general-request-screenshot", label: "Request Screenshot", actionType: "handled", message: "Hello @{{username}}, please send a screenshot." },
    { id: "general-resolved", label: "Resolved", actionType: "done", message: "Hello @{{username}}, this has been resolved. Please check." },
    { id: "general-friendly", label: "Friendly", actionType: "handled", message: "Hello @{{username}}, happy to help." }
  ]
};

function actionIntentKey(intent?: string | null) {
  if (intent === "share_ad_account" || intent === "share_account") return "share_account";
  if (intent === "unshare_ad_account" || intent === "unshare_account" || intent === "remove_account") return "unshare_account";
  if (intent === "deposit" || intent === "deposit_funds" || intent === "payment_check" || intent === "payment_issue") return "deposit";
  if (intent === "verification" || intent === "verify_account") return "verification";
  return "general_support";
}

function getActionButtons(intent?: string | null) {
  return ACTION_BUTTONS_BY_INTENT[actionIntentKey(intent)];
}

function formatButtonMessage(message: string, username?: string | null) {
  const handle = username ? `@${username.replace(/^@/, "")}` : "@client";
  return message.replaceAll("@{{username}}", handle);
}

type TicketActionsProps = {
  ticketId: string;
  ticketIntent?: string | null;
  clientUsername?: string | null;
  recommendation: ActionRecommendation;
};

export function TicketActions({ ticketId, ticketIntent, clientUsername, recommendation }: TicketActionsProps) {
  const router = useRouter();
  const actionButtons = getActionButtons(ticketIntent);
  const [customReply, setCustomReply] = useState("");
  const recommendedAction = recommendation.action === "reclassify_first" ? "handled" : recommendation.action;
  const initialButton = actionButtons.find((button) => button.actionType === recommendedAction) ?? actionButtons[0];
  const initialAction = initialButton?.actionType ?? "handled";
  const [selectedAction, setSelectedAction] = useState<MarkActionType>(initialAction);
  const [selectedButtonId, setSelectedButtonId] = useState(initialButton?.id);
  const [selectedButtonMessage, setSelectedButtonMessage] = useState(
    initialButton ? formatButtonMessage(initialButton.message, clientUsername) : ""
  );
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function selectAction(button: ActionButtonConfig) {
    setSelectedAction(button.actionType);
    setSelectedButtonId(button.id);
    setSelectedButtonMessage(formatButtonMessage(button.message, clientUsername));
    setMessage(null);
    setError(null);
  }

  function selectCustomReply() {
    setSelectedAction("custom_reply");
    setSelectedButtonId("");
    setSelectedButtonMessage("");
    setMessage(null);
    setError(null);
  }

  function runSelectedAction() {
    startTransition(async () => {
      const response = await fetch(`/api/tickets/${ticketId}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionType: selectedButtonMessage ? "custom_reply" : selectedAction,
          customReply: selectedButtonMessage || customReply
        })
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
    : selectedButtonMessage || resolveCompletionMessage(selectedAction, clientUsername, customReply, ticketIntent) || "Write a custom reply to preview the message.";

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {actionButtons.map((button) => (
          <Button
            key={button.id}
            onClick={() => selectAction(button)}
            disabled={isPending}
            className={selectedButtonId === button.id ? "ring-2 ring-primary/40" : ""}
          >
            <Check className="h-4 w-4" aria-hidden="true" />
            {button.label}
          </Button>
        ))}
      </div>

      <div className="space-y-2">
        <label className="text-sm font-semibold" htmlFor="custom-reply">Custom reply</label>
        <Textarea
          id="custom-reply"
          value={customReply}
          onChange={(event) => setCustomReply(event.target.value)}
          onFocus={selectCustomReply}
          placeholder="Write exact client-facing response"
        />
        <Button onClick={selectCustomReply} disabled={isPending || !customReply.trim()}>
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
