import { formatIntentLabel } from "@/lib/display";
import { resolveCompletionMessage, type MarkActionType } from "@/lib/playbook";
import type { Ticket } from "@/lib/types";

export type RiskLevel = "low" | "medium" | "high";

export type ActionRecommendation = {
  action: MarkActionType | "reclassify_first";
  label: string;
  reason: string;
  suggestedReply: string;
  riskLevel: RiskLevel;
};

export function getTicketAgeMinutes(createdAt?: string | null): number | null {
  if (!createdAt) return null;
  const created = new Date(createdAt).getTime();
  if (Number.isNaN(created)) return null;
  return Math.max(0, Math.floor((Date.now() - created) / 60000));
}

export function isResolvedTicketStatus(status?: string | null): boolean {
  return ["done", "resolved", "closed"].includes((status ?? "").toLowerCase());
}

export function isOpenTicketStatus(status?: string | null): boolean {
  return !isResolvedTicketStatus(status);
}

export function getMinutesBetween(start?: string | null, end?: string | null): number | null {
  if (!start || !end) return null;
  const startTime = new Date(start).getTime();
  const endTime = new Date(end).getTime();
  if (Number.isNaN(startTime) || Number.isNaN(endTime)) return null;
  return Math.max(0, Math.floor((endTime - startTime) / 60000));
}

export function getTicketTimerMinutes(ticket: Pick<Ticket, "status" | "created_at" | "updated_at" | "closed_at">): number | null {
  if (isResolvedTicketStatus(ticket.status)) {
    return getMinutesBetween(ticket.created_at, ticket.closed_at ?? ticket.updated_at);
  }

  return getTicketAgeMinutes(ticket.created_at);
}

export function formatDurationMinutes(minutes: number | null): string {
  if (minutes === null) return "Unknown";
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

export function getTicketTimerLabel(ticket: Pick<Ticket, "status" | "created_at" | "updated_at" | "closed_at">): string {
  const duration = formatDurationMinutes(getTicketTimerMinutes(ticket));
  return isResolvedTicketStatus(ticket.status) ? `Resolved in: ${duration}` : `Open for: ${duration}`;
}

export function getEscalationState(ticket: Pick<Ticket, "status" | "created_at">): "none" | "needs_attention" | "urgent" {
  const status = (ticket.status ?? "unknown").toLowerCase();
  if (!["new", "open", "waiting_mark", "waiting_for_mark"].includes(status)) return "none";

  const age = getTicketAgeMinutes(ticket.created_at);
  if (age === null) return "none";
  if (age > 30) return "urgent";
  if (age > 10) return "needs_attention";
  return "none";
}

export function getActionRecommendation(ticket: Ticket): ActionRecommendation {
  const intent = ticket.intent ?? "unknown";
  const username = ticket.client_username;
  const message = (ticket.client_original_message ?? "").toLowerCase();

  if (intent === "deposit_funds") {
    return {
      action: "funds_arrived",
      label: "Funds arrived",
      reason: "Payment and deposit requests are high risk. Never confirm payment before Mark verifies the funds arrived.",
      suggestedReply: resolveCompletionMessage("funds_arrived", username),
      riskLevel: "high"
    };
  }

  if (intent === "share_ad_account") {
    const alreadyShared = /already|shared before|has access/.test(message);
    const action: MarkActionType = alreadyShared ? "already_shared" : "done";
    return {
      action,
      label: alreadyShared ? "Already shared" : "Done",
      reason: "Client is asking for BM/ad account access. Mark should confirm whether access was added or already exists.",
      suggestedReply: resolveCompletionMessage(action, username),
      riskLevel: "medium"
    };
  }

  if (intent === "check_availability") {
    return {
      action: "not_available",
      label: "Not available or custom reply",
      reason: "Availability should not be guessed. Use Not available only after Mark confirms, otherwise send a custom availability reply.",
      suggestedReply: resolveCompletionMessage("not_available", username),
      riskLevel: "medium"
    };
  }

  if (intent === "other" || intent === "unknown" || !ticket.intent) {
    return {
      action: "reclassify_first",
      label: "Reclassify first",
      reason: "Intent is unknown, so sending a completion reply could create the wrong client expectation.",
      suggestedReply: "Run Reclassify, review detected intent and extracted data, then apply before taking a Mark action.",
      riskLevel: "high"
    };
  }

  return {
    action: "handled",
    label: "Handled",
    reason: `${formatIntentLabel(intent)} requires a manual review before the bot confirms completion.`,
    suggestedReply: resolveCompletionMessage("handled", username),
    riskLevel: intent.includes("payment") || intent.includes("refund") || intent.includes("policy") ? "high" : "medium"
  };
}
