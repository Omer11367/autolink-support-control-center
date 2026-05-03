import type { Json } from "@/lib/types";

export type ReplyCategory =
  | "payment_check"
  | "share_account"
  | "unshare_account"
  | "account_status_check"
  | "verify_account"
  | "request_accounts"
  | "refund_request"
  | "availability_check"
  | "general_support";

const CATEGORY_TEMPLATES: Record<ReplyCategory, string[]> = {
  payment_check: [
    "Payment received.",
    "Deposit confirmed.",
    "Funds received, thank you.",
    "Payment is confirmed on our side.",
    "Please send the payment proof.",
    "Please confirm the amount sent."
  ],
  share_account: [
    "Shared, please check now.",
    "Access has been added, please check.",
    "Please send the correct BM ID.",
    "Please send the ad account ID.",
    "Full access has been shared.",
    "Partial access has been shared."
  ],
  unshare_account: [
    "Removed from the BM, please check.",
    "Access has been removed.",
    "The account has been unshared.",
    "Please confirm which BM to remove it from.",
    "Please send the ad account ID to remove.",
    "Removed, please confirm on your side."
  ],
  account_status_check: [
    "Checking the account status now.",
    "The account is active.",
    "The account is under review.",
    "The account is restricted.",
    "Please send the ad account ID.",
    "Please send a screenshot of the issue."
  ],
  verify_account: [
    "Verification is being checked.",
    "Card verification is being checked.",
    "Please send the verification screenshot.",
    "Please send the ad account ID.",
    "Verification completed.",
    "The account still needs verification."
  ],
  request_accounts: [
    "Checking account availability.",
    "Accounts are available.",
    "Accounts are not available right now.",
    "Please confirm how many accounts you need.",
    "Accounts are being prepared.",
    "I'll update once the accounts are ready."
  ],
  refund_request: [
    "Refund request received.",
    "Refund is being checked.",
    "Refund approved.",
    "Refund completed.",
    "Please confirm the amount for refund.",
    "Please send the payment details for refund."
  ],
  availability_check: [
    "Checking availability.",
    "Available now.",
    "Not available right now.",
    "Please confirm the quantity needed.",
    "I'll update once availability changes."
  ],
  general_support: [
    "Got it.",
    "Happy to help.",
    "You're welcome.",
    "Please send more details.",
    "Please send a screenshot.",
    "Understood."
  ]
};

const INTENT_TO_CATEGORY: Record<string, ReplyCategory> = {
  deposit_funds: "payment_check",
  payment_check: "payment_check",
  payment_issue: "payment_check",
  share_ad_account: "share_account",
  share_account: "share_account",
  unshare_ad_account: "unshare_account",
  unshare_account: "unshare_account",
  remove_account: "unshare_account",
  check_account_status: "account_status_check",
  account_status_check: "account_status_check",
  verify_account: "verify_account",
  request_accounts: "request_accounts",
  refund_request: "refund_request",
  check_availability: "availability_check",
  availability_check: "availability_check",
  general_support: "general_support",
  other: "general_support",
  unknown: "general_support"
};

function readActionTypes(extractedData?: Json | null): string[] {
  if (!extractedData || typeof extractedData !== "object" || Array.isArray(extractedData)) return [];
  const actions = extractedData.actions;
  if (!Array.isArray(actions)) return [];

  return actions
    .map((action) => {
      if (!action || typeof action !== "object" || Array.isArray(action)) return null;
      return typeof action.type === "string" ? action.type : null;
    })
    .filter((type): type is string => Boolean(type));
}

export function getReplyCategories(intent?: string | null, extractedData?: Json | null): ReplyCategory[] {
  const categories = readActionTypes(extractedData)
    .map((type) => INTENT_TO_CATEGORY[type])
    .filter((category): category is ReplyCategory => Boolean(category));

  if (categories.length === 0 && intent) {
    const fallback = INTENT_TO_CATEGORY[intent];
    if (fallback) categories.push(fallback);
  }

  if (categories.length === 0) categories.push("general_support");

  return Array.from(new Set(categories));
}

export function getReplyTemplates(intent?: string | null, extractedData?: Json | null): string[] {
  return getReplyCategories(intent, extractedData).flatMap((category) => CATEGORY_TEMPLATES[category].slice(0, 3));
}
