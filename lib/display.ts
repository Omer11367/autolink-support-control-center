import { INTENT_LIBRARY } from "./intent-library";

export const INTENT_LABELS: Record<string, string> = {
  share_ad_account: "Share Ad Account",
  unshare_ad_account: "Unshare Ad Account",
  transfer_ad_account: "Transfer Ad Account",
  verify_account: "Verify Account",
  deposit_funds: "Deposit Funds",
  refund_request: "Refund Request",
  request_accounts: "Request Accounts",
  check_availability: "Check Availability",
  get_spend_report: "Spend Report",
  check_account_status: "Account Status",
  check_policy: "Policy Check",
  payment_issue: "Payment Issue",
  request_data_banned_accounts: "Data From Banned Accounts",
  access_level: "Access Level",
  other: "Other",
  unknown: "Unknown"
};

export function formatIntentLabel(intent?: string | null): string {
  if (!intent) return "Unknown";
  if (INTENT_LABELS[intent]) return INTENT_LABELS[intent];

  const libraryMatch = INTENT_LIBRARY.find((item) => item.intent === intent);
  if (libraryMatch) return libraryMatch.label;

  return intent
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function formatValueLabel(value?: string | null): string {
  if (!value) return "Unknown";
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getStatusTone(status?: string | null): "blue" | "orange" | "green" | "gray" | "red" | "neutral" {
  const normalized = (status ?? "unknown").toLowerCase();
  if (["new", "open"].includes(normalized)) return "blue";
  if (["waiting_mark", "waiting_for_mark", "waiting"].includes(normalized)) return "orange";
  if (["done", "resolved"].includes(normalized)) return "green";
  if (normalized === "closed") return "gray";
  if (["error", "failed", "failure"].includes(normalized)) return "red";
  return "neutral";
}

export function getPriorityTone(priority?: string | null): "blue" | "gray" | "red" | "neutral" {
  const normalized = (priority ?? "normal").toLowerCase();
  if (["urgent", "high"].includes(normalized)) return "red";
  if (["normal", "medium"].includes(normalized)) return "blue";
  if (normalized === "low") return "gray";
  return "neutral";
}

export function getDefaultCompletionForIntent(intent?: string | null): string {
  const normalized = intent ?? "unknown";
  const item = INTENT_LIBRARY.find((entry) => entry.intent === normalized);
  return item?.defaultCompletionResponse ?? "Pick an action or write a custom reply.";
}
