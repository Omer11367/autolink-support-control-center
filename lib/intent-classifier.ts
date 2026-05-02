import { formatIntentLabel } from "./display";

export type AccessLevel = "full" | "partial" | "view" | "not_specified";

export type ClassifiedIntent = {
  intent: string;
  humanLabel: string;
  confidence: "high" | "medium" | "low";
  requiresMark: boolean;
  shouldReply: boolean;
  closeConversation: boolean;
  extractedData: Record<string, unknown>;
  accessLevel: AccessLevel;
  holdingMessage: string;
  internalSummary: string;
  completionOptions: string[];
  matchedRules: string[];
};

type IntentRule = {
  intent: string;
  phrases: string[];
  completionOptions: string[];
  note?: string;
};

const RULES: IntentRule[] = [
  {
    intent: "share_ad_account",
    phrases: ["share", "share account", "share accounts", "add", "connect", "give access", "grant access", "attach", "link", "add acc to bm"],
    completionOptions: ["Done", "Already shared", "Only view access"]
  },
  {
    intent: "unshare_ad_account",
    phrases: ["unbind", "unshare", "remove bm", "remove access", "disconnect", "unlink", "revoke access"],
    completionOptions: ["Done", "Handled"]
  },
  {
    intent: "transfer_ad_account",
    phrases: ["transfer", "move accounts", "new bm", "switch bm", "replace bm"],
    completionOptions: ["Done", "Handled"]
  },
  {
    intent: "verify_account",
    phrases: ["verify", "verification"],
    completionOptions: ["Done", "Handled"]
  },
  {
    intent: "deposit_funds",
    phrases: ["paid", "payment done", "deposit", "funds sent", "transferred", "top up", "usdt", "sent money", "dollar", "usd", "please check payment"],
    completionOptions: ["Funds arrived", "Handled"],
    note: "Never confirm funds automatically."
  },
  {
    intent: "refund_request",
    phrases: ["refund", "withdraw", "return money", "wallet address", "trc20", "remaining balance"],
    completionOptions: ["Handled"]
  },
  {
    intent: "request_accounts",
    phrases: ["request accounts", "need account", "need accounts", "new account", "new accounts", "more account", "more accounts"],
    completionOptions: ["Done", "Handled"]
  },
  {
    intent: "check_availability",
    phrases: ["available", "availability", "do you have", "stock", "can we request"],
    completionOptions: ["Not available", "Handled"]
  },
  {
    intent: "get_spend_report",
    phrases: ["daily spend", "spend", "report", "stats", "last days", "data"],
    completionOptions: ["Handled"],
    note: "Never generate spend numbers automatically."
  },
  {
    intent: "check_account_status",
    phrases: ["status", "check status", "account status", "active", "blocked", "disabled", "usable", "can run ads"],
    completionOptions: ["Handled"]
  },
  {
    intent: "check_policy",
    phrases: ["can we run", "offer", "link", "website", "domain", "allowed", "compliant", "policy"],
    completionOptions: ["Handled"],
    note: "Never decide policy automatically."
  },
  {
    intent: "payment_issue",
    phrases: ["debt", "balance issue", "payment issue", "cannot launch campaigns", "campaigns blocked"],
    completionOptions: ["Done", "Handled"]
  },
  {
    intent: "request_data_banned_accounts",
    phrases: ["need data", "account id", "campaign name", "expenses", "banned accounts", "report from banned", "down accounts"],
    completionOptions: ["Handled"]
  }
];

const REACTION_ONLY = /^[\s\u{1F44D}\u2764\uFE0F\u2705\u{1F64F}]+$/u;
const SIMPLE_ACK_ONLY = /^(?:ok|okay|thanks|thank you|ty|yes|no|wait|one sec|one second|sec|noted|got it|received|sure|alright|all good)[.!\s]*$/i;

const SAFE_HOLDING_RESPONSES = [
  "Got it, checking this now.",
  "Thanks, I'll check and update you shortly.",
  "Received, I'm checking with the team now.",
  "Understood, I'll update you once I have confirmation.",
  "Sure, I'll check this and get back to you shortly."
];
const HOLDING_RESPONSES = SAFE_HOLDING_RESPONSES;

function includesPhrase(text: string, phrase: string): boolean {
  return text.includes(phrase);
}

function extractNumbersNear(text: string, keywords: string[]): string[] {
  const numbers = new Set<string>();
  const tokens = text.split(/\s+/);

  tokens.forEach((token, index) => {
    const normalized = token.toLowerCase().replace(/[^a-z0-9]/g, "");
    const nearby = tokens.slice(Math.max(0, index - 4), index + 5).join(" ").toLowerCase();
    const match = token.match(/\d{5,}/);

    if (match && keywords.some((keyword) => nearby.includes(keyword))) {
      numbers.add(match[0]);
    }

    if (keywords.some((keyword) => normalized === keyword.replace(/\s+/g, ""))) {
      tokens.slice(index + 1, index + 5).forEach((nearToken) => {
        const nearMatch = nearToken.match(/\d{5,}/);
        if (nearMatch) numbers.add(nearMatch[0]);
      });
    }
  });

  return Array.from(numbers);
}

function extractAccountNames(message: string): string[] {
  const matches = message.match(/\b\d{3,5}\s*-\s*\d{3,8}\s*-\s*[a-z0-9-]+\s*-\s*[a-z0-9-]+\b/gi);
  return matches ?? [];
}

function extractAccessLevel(text: string): AccessLevel {
  if (/\b(view|view-access|view access|limited)\b/i.test(text)) return "view";
  if (/\b(partial|partial management)\b/i.test(text)) return "partial";
  if (/\b(full|admin)\b/i.test(text)) return "full";
  return "not_specified";
}

function extractAmount(text: string): string | null {
  const match = text.match(/(?:\$|usdt|usd)?\s?\d+(?:[,.]\d+)?\s?(?:usdt|usd|\$)?/i);
  return match?.[0]?.trim() ?? null;
}

function extractReportRange(text: string): string | null {
  const match = text.match(/(?:last\s+\d+\s+days?|december|january|today|yesterday|this\s+week|this\s+month)/i);
  return match?.[0] ?? null;
}

function chooseHoldingMessage(): string {
  // Keep holding replies varied, short, and safe: no manual action is confirmed here.
  const index = Math.floor(Math.random() * SAFE_HOLDING_RESPONSES.length);
  return HOLDING_RESPONSES[index] ?? "Hello! Let me check on this and I’ll get back to you shortly.";
}

export function classifyIntent(message: string, previousContext = ""): ClassifiedIntent {
  const combined = `${previousContext}\n${message}`.trim();
  const normalized = combined.toLowerCase();
  const currentMessage = message.trim();

  // Noise-only messages should not create meaningful Mark work.
  if (currentMessage && (REACTION_ONLY.test(currentMessage) || SIMPLE_ACK_ONLY.test(currentMessage))) {
    return {
      intent: "no_action",
      humanLabel: formatIntentLabel("no_action"),
      confidence: "high",
      requiresMark: false,
      shouldReply: false,
      closeConversation: true,
      extractedData: {},
      accessLevel: "not_specified",
      holdingMessage: "",
      internalSummary: "Simple acknowledgement only. No reply or Mark action needed.",
      completionOptions: ["Close"],
      matchedRules: ["Simple acknowledgement or emoji reaction closes conversation with no reply."]
    };
  }

  const ranked = RULES.map((rule) => {
    const matched = rule.phrases.filter((phrase) => includesPhrase(normalized, phrase));
    return { rule, matched, score: matched.length };
  }).sort((a, b) => b.score - a.score);

  const inferredRequestAccounts = /\b(?:need|request|want|more)\s+\d+\s+(?:ad\s+)?accounts?\b/i.test(combined);
  const best = ranked.find((entry) => entry.score > 0) ??
    (inferredRequestAccounts
      ? {
          rule: RULES.find((rule) => rule.intent === "request_accounts") ?? RULES[0],
          matched: ["numbered account request"],
          score: 1
        }
      : undefined);
  const intent = best?.rule.intent ?? "general_support";
  const matchedRules = best
    ? best.matched.map((phrase) => `Matched phrase: ${phrase}`)
    : ["No specific rule matched. Forward as general support."];

  const bmIds = extractNumbersNear(combined, ["bm", "business manager"]);
  const adAccountIds = extractNumbersNear(combined, ["account", "ad account", "acc"]);
  const accountNames = extractAccountNames(combined);
  const accessLevel = extractAccessLevel(combined);
  const amount = extractAmount(combined);
  const reportRange = extractReportRange(combined);

  const extractedData: Record<string, unknown> = {
    bmIds,
    adAccountIds,
    accountNames,
    accessLevel
  };

  if (amount) extractedData.amountOrPayment = amount;
  if (reportRange) extractedData.reportRange = reportRange;

  const confidence = best ? (best.score > 1 ? "high" : "medium") : "low";
  const requiresMark = intent !== "no_action";
  const holdingMessage = requiresMark ? chooseHoldingMessage() : "";
  const humanLabel = formatIntentLabel(intent);
  const note = best?.rule.note ? ` ${best.rule.note}` : "";
  const internalSummary = [
    `Detected intent: ${humanLabel}.`,
    `Requires Mark: ${requiresMark ? "yes" : "no"}.`,
    `Requested access level: ${accessLevel}.`,
    bmIds.length ? `BM ID(s): ${bmIds.join(", ")}.` : "",
    adAccountIds.length ? `Ad account ID(s): ${adAccountIds.join(", ")}.` : "",
    accountNames.length ? `Account name(s): ${accountNames.join(", ")}.` : "",
    amount ? `Amount/payment detail: ${amount}.` : "",
    reportRange ? `Report/date range: ${reportRange}.` : "",
    note.trim()
  ].filter(Boolean).join(" ");

  return {
    intent,
    humanLabel,
    confidence,
    requiresMark,
    shouldReply: true,
    closeConversation: false,
    extractedData,
    accessLevel,
    holdingMessage: requiresMark ? holdingMessage : "",
    internalSummary,
    completionOptions: best?.rule.completionOptions ?? ["Handled", "Close"],
    matchedRules
  };
}
