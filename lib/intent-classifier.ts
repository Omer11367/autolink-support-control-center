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

type DetectedAction = {
  type: "share_account" | "unshare_account" | "payment_check" | "verify_account" | "account_status_check" | "general_support";
  account?: string;
  accounts?: string[];
  bm?: string;
  amount?: string;
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
    phrases: ["share", "share account", "share accounts", "add", "connect", "give access", "grant access", "attach", "link", "add acc to bm", "add to bm", "add accs to bm", "add accounts to bm", "put in bm", "put on bm"],
    completionOptions: ["Done", "Already shared", "Only view access"]
  },
  {
    intent: "unshare_ad_account",
    phrases: ["unbind", "unshare", "unsher", "remove bm", "remove access", "remove from bm", "disconnect", "unlink", "revoke access", "take out from bm"],
    completionOptions: ["Done", "Handled"]
  },
  {
    intent: "transfer_ad_account",
    phrases: ["transfer", "move accounts", "new bm", "switch bm", "replace bm", "delete from bm", "change bm", "move to bm", "and delete from", "remove from old bm", "change business manager"],
    completionOptions: ["Done", "Handled"]
  },
  {
    intent: "verify_account",
    phrases: ["verify", "verification"],
    completionOptions: ["Done", "Handled"]
  },
  {
    intent: "deposit_funds",
    phrases: [
      "paid",
      "payment done",
      "deposit",
      "deposited",
      "deposit sent",
      "funds sent",
      "transferred",
      "transfer sent",
      "top up",
      "usdt",
      "sent money",
      "sent",
      "send",
      "dollar",
      "usd",
      "payment proof",
      "proof of payment",
      "transaction hash",
      "tx hash",
      "etherscan",
      "polygonscan",
      "bscscan",
      "check deposit",
      "please confirm deposit",
      "please check payment",
      "add balance",
      "add to wallet",
      "add balance to wallet",
      "add payment to wallet",
      "wallet balance",
      "funding",
      "i'm funding",
      "balance to our wallet",
      "budget to our wallet"
    ],
    completionOptions: ["Funds arrived", "Handled"],
    note: "Never confirm funds automatically."
  },
  {
    intent: "refund_request",
    phrases: ["refund", "withdraw", "return money", "wallet address", "trc20"],
    completionOptions: ["Handled"]
  },
  {
    intent: "remaining_balance",
    phrases: [
      "remaining balance", "balance left", "how much balance", "what's our balance",
      "whats our balance", "account balance", "how much credit", "credit left",
      "credit remaining", "how much do we have left", "balance check", "check balance",
      "check our balance", "balance inquiry", "what is our balance"
    ],
    completionOptions: ["Handled"]
  },
  {
    intent: "replacement_request",
    phrases: [
      "replacement", "replacement account", "replace account", "replace our account",
      "replace the account", "replace banned", "need replacement", "account replacement",
      "get a replacement", "new account instead", "substitute account",
      "can you replace", "replace it", "new one instead"
    ],
    completionOptions: ["Done", "Handled"]
  },
  {
    intent: "request_accounts",
    phrases: ["request accounts", "need account", "need accounts", "new account", "new accounts", "more account", "more accounts"],
    completionOptions: ["Done", "Handled"]
  },
  {
    intent: "check_availability",
    phrases: ["available", "availability", "do you have", "do you have accounts", "accounts available", "stock", "can we request"],
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
    phrases: ["status", "check status", "account status", "active", "blocked", "disabled", "restricted", "banned", "usable", "can run ads", "account problem",
      "campaigns stopped", "campaigns paused", "campaigns not running", "campaigns not delivering",
      "ads stopped", "ads paused", "ads not running", "ads not delivering", "ads not working",
      "campaigns disabled", "stopped running", "not running anymore",
      "not spending", "doesn't spend", "do not spend", "no spend", "stopped spending",
      "low usage", "not spending now", "haven't spent", "hasnt spent", "it doesn't spend",
      "they do not spend", "it stopped spending"],
    completionOptions: ["Handled"]
  },
  {
    intent: "check_policy",
    phrases: ["can we run", "offer", "link", "website", "domain", "allowed", "compliant", "policy"],
    completionOptions: ["Handled"],
    note: "Never decide policy automatically."
  },
  {
    intent: "site_issue",
    phrases: [
      "site is down", "site down", "website down", "site not working", "website not working",
      "cant load", "cannot load", "doesnt load", "doesn't load", "not loading",
      "cant open", "cannot open", "cant access", "cannot access", "not accessible",
      "cant see the site", "can't see the site", "page not loading", "link not working", "link is down"
    ],
    completionOptions: ["Handled"]
  },
  {
    intent: "payment_issue",
    phrases: [
      "debt",
      "balance issue",
      "payment issue",
      "payment failed",
      "cannot pay",
      "can't pay",
      "credit card problem",
      "card problem",
      "card verification issue",
      "verify card",
      "payment method rejected",
      "payment method problem",
      "card rejected",
      "payment declined",
      "cannot launch campaigns",
      "campaigns blocked"
    ],
    completionOptions: ["Done", "Handled"]
  },
  {
    intent: "request_data_banned_accounts",
    phrases: ["need data", "account id", "campaign name", "expenses", "banned accounts", "report from banned", "down accounts"],
    completionOptions: ["Handled"]
  },
  {
    // Client has already submitted via dashboard/spreadsheet and is asking staff to action it.
    // Distinct from request_accounts ("I need new accounts") — this is "I already submitted, please process".
    intent: "process_account_creation",
    phrases: [
      "process account creation", "process creation", "process new accs", "process new accounts",
      "please process", "could you process", "process account",
      "submitted request for", "submitted requests", "submitted some more",
      "submitted for ad accounts", "i just submitted", "i've submitted",
      "we requested", "i requested accounts", "requested more accounts"
    ],
    completionOptions: ["Done", "Handled"]
  },
  {
    // Client asking for the ad account IDs — very common follow-up after delivery.
    intent: "request_account_ids",
    phrases: [
      "add ids", "add id", "add the ids", "send ids", "send the ids",
      "account ids please", "need account ids", "i need ids",
      "provide ids", "provide the ids", "ids of ad accounts",
      "ids of accounts", "please add id", "can you add id",
      "please send ids", "send us the ids"
    ],
    completionOptions: ["Handled"]
  },
  {
    intent: "rename_account",
    phrases: [
      "rename", "rename acc", "rename account", "change name", "change naming",
      "change the name of", "account name change", "rename ad account",
      "change account name", "new name for"
    ],
    completionOptions: ["Done", "Handled"]
  },
  {
    intent: "pause_campaigns",
    phrases: [
      "pause campaigns", "pause ads", "pause ad accounts", "pause accounts",
      "stop campaigns", "stop advertising", "stop ads", "pause advertising",
      "turn off campaigns", "turn off ads", "stop running ads",
      "pause the campaigns", "pause the ads", "pause ad"
    ],
    completionOptions: ["Done", "Handled"]
  },
  {
    intent: "appeal_review",
    phrases: [
      "appeal", "request review", "request a review", "submit review",
      "review these accounts", "appeal acc", "appeal account",
      "accounts have been taken down", "taken down", "request for review",
      "meta review", "need a review", "review please", "please appeal",
      "asking for review", "ask for review"
    ],
    completionOptions: ["Handled"]
  },
  {
    // Account was shared but client can't see it in their BM or dashboard.
    intent: "account_not_visible",
    phrases: [
      "don't see acc", "dont see acc", "don't see this acc", "dont see this acc",
      "not in bm", "not showing in bm", "not visible in bm",
      "not appearing in bm", "account not found", "doesn't appear on dashboard",
      "not found on dashboard", "not showing on dashboard",
      "not found in bm", "cant find the account", "can't find the account",
      "account is missing", "missing from bm", "not showing up",
      "doesn't appear", "not showing up in bm"
    ],
    completionOptions: ["Handled"]
  }
];

const REACTION_ONLY = /^[\s\u{1F44D}\u2764\uFE0F\u2705\u{1F64F}]+$/u;
const SIMPLE_ACK_ONLY = /^(?:ok|okay|thanks|thank you|ty|yes|no|wait|one sec|one second|sec|noted|got it|received|sure|alright|all good|greetings|greetings everyone|nice to meet you|nice to e-meet you|bueno)[.!\s]*$/i;

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

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const key = value.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }

  return result;
}

function cleanEntityToken(value: string): string {
  return value.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9_-]+$/g, "");
}

function tokenKey(value: string): string {
  return cleanEntityToken(value).toLowerCase();
}

function isAccountLabel(tokens: string[], index: number): number {
  const current = tokenKey(tokens[index] ?? "");
  const next = tokenKey(tokens[index + 1] ?? "");

  if (current === "ad" && (next === "account" || next === "accounts")) return 2;
  if (["account", "accounts", "acc", "accs"].includes(current)) return 1;

  return 0;
}

function isBmLabel(tokens: string[], index: number): number {
  const current = tokenKey(tokens[index] ?? "");
  const next = tokenKey(tokens[index + 1] ?? "");

  if (current === "business" && next === "manager") return 2;
  if (current === "bm") return 1;

  return 0;
}

function collectLabeledValues(tokens: string[], startIndex: number, labelType: "account" | "bm"): string[] {
  const values: string[] = [];
  let index = startIndex;

  while (index < tokens.length) {
    const key = tokenKey(tokens[index] ?? "");
    const accountLabelLength = isAccountLabel(tokens, index);
    const bmLabelLength = isBmLabel(tokens, index);
    const isOtherLabel = labelType === "account" ? bmLabelLength > 0 : accountLabelLength > 0;
    const isStopWord = ["to", "into", "for", "from", "with", "and", "then", "full", "partial", "view", "access", "admin", "management", "limited", "need", "needs", "verify", "verification", "check", "status", "card"].includes(key);

    if (isOtherLabel || (isStopWord && values.length > 0)) break;
    if (isStopWord) {
      index += 1;
      continue;
    }

    const tokenValues = (tokens[index] ?? "")
      .split(/[,;&]+/)
      .map(cleanEntityToken)
      .filter(Boolean);

    if (tokenValues.length === 0) break;

    values.push(...tokenValues);
    index += 1;
  }

  return values;
}

function extractLabeledShareEntities(message: string): { bmIds: string[]; adAccountIds: string[] } {
  const tokens = message.split(/\s+/).filter(Boolean);
  const bmIds: string[] = [];
  const adAccountIds: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const accountLabelLength = isAccountLabel(tokens, index);
    if (accountLabelLength > 0) {
      adAccountIds.push(...collectLabeledValues(tokens, index + accountLabelLength, "account"));
      index += accountLabelLength - 1;
      continue;
    }

    const bmLabelLength = isBmLabel(tokens, index);
    if (bmLabelLength > 0) {
      bmIds.push(...collectLabeledValues(tokens, index + bmLabelLength, "bm"));
      index += bmLabelLength - 1;
    }
  }

  const uniqueBmIds = uniqueStrings(bmIds);
  const uniqueAdAccountIds = uniqueStrings(adAccountIds);
  const bmSet = new Set(uniqueBmIds.map((value) => value.toLowerCase()));
  const adAccountSet = new Set(uniqueAdAccountIds.map((value) => value.toLowerCase()));

  return {
    bmIds: uniqueBmIds.filter((value) => !adAccountSet.has(value.toLowerCase())),
    adAccountIds: uniqueAdAccountIds.filter((value) => !bmSet.has(value.toLowerCase()))
  };
}

function addAction(actions: DetectedAction[], action: DetectedAction) {
  const key = JSON.stringify(action).toLowerCase();
  const exists = actions.some((item) => JSON.stringify(item).toLowerCase() === key);
  if (!exists) actions.push(action);
}

function firstAccountValue(values: string[]): string | undefined {
  return values.find(Boolean);
}

function actionFromValues(type: "share_account" | "unshare_account", accounts: string[], bm?: string): DetectedAction | null {
  const cleanAccounts = uniqueStrings(accounts.map(cleanEntityToken).filter(Boolean));
  const cleanBm = cleanEntityToken(bm ?? "");
  if (cleanAccounts.length === 0) return null;

  return {
    type,
    ...(cleanAccounts.length === 1 ? { account: cleanAccounts[0] } : { accounts: cleanAccounts }),
    ...(cleanBm ? { bm: cleanBm } : {})
  };
}

function readTokenValuesUntilStop(tokens: string[], startIndex: number, stopWords: string[]): string[] {
  const values: string[] = [];
  let index = startIndex;

  while (index < tokens.length) {
    const key = tokenKey(tokens[index] ?? "");
    if (stopWords.includes(key)) break;

    const tokenValues = (tokens[index] ?? "")
      .split(/[,;&]+/)
      .map(cleanEntityToken)
      .filter((value) => /^[A-Za-z0-9_-]+$/.test(value));

    values.push(...tokenValues);
    index += 1;
  }

  return values.filter((value) => !["account", "accounts", "acc", "accs", "ad", "this", "these", "those", "all", "of"].includes(value.toLowerCase()));
}

function extractAccountsFromActionSegment(segment: string, actionType: "share_account" | "unshare_account"): string[] {
  if (actionType === "unshare_account") {
    const fromAllBms = segment.match(/\bfrom\s+(?:all\s+)?(?:bms?|business\s+managers?|all)\b[:\s-]*([\s\S]*)/i);
    const valuesAfterAllBms = fromAllBms?.[1]?.match(/[A-Za-z0-9_-]{5,}/g) ?? [];
    if (valuesAfterAllBms.length > 0) return uniqueStrings(valuesAfterAllBms.map(cleanEntityToken).filter(Boolean));
  }

  const looseUnshare = actionType === "unshare_account"
    ? segment.match(/\b(?:unshare|unsher|remove|disconnect|unlink|revoke|take\s+out)\b\s+(?:this|these|those)?\s*([\s\S]*?)(?:\bfrom\b|$)/i)
    : null;
  if (looseUnshare?.[1]) {
    const values = looseUnshare[1].match(/[A-Za-z0-9_-]+/g) ?? [];
    const cleanValues = values.filter((value) => !["account", "accounts", "acc", "ad", "this", "these", "those", "all", "of"].includes(value.toLowerCase()));
    if (cleanValues.length > 0) return uniqueStrings(cleanValues);
  }

  const labeled = extractLabeledShareEntities(segment).adAccountIds;
  if (labeled.length > 0) return labeled;

  const tokens = segment.split(/\s+/).filter(Boolean);
  const actionWords = actionType === "share_account"
    ? ["share", "add", "connect", "link", "attach"]
    : ["unshare", "unsher", "remove", "disconnect", "unlink", "revoke"];
  const startIndex = tokens.findIndex((token) => actionWords.includes(tokenKey(token)));
  if (startIndex < 0) return [];

  return uniqueStrings(readTokenValuesUntilStop(tokens, startIndex + 1, [
    "to",
    "into",
    "from",
    "bm",
    "bms",
    "business",
    "manager",
    "managers",
    "with",
    "full",
    "partial",
    "view",
    "access",
    "and"
  ]));
}

function extractBmFromActionSegment(segment: string, actionType: "share_account" | "unshare_account"): string {
  if (actionType === "unshare_account" && /\b(?:all\s+bms?|all\s+business\s+managers|all)\b/i.test(segment)) {
    return "ALL BMs";
  }

  const labeled = extractLabeledShareEntities(segment).bmIds;
  if (labeled.length > 0) return labeled.join(", ");

  const match = segment.match(/\b(?:to|into|from)\s+(?:bm|bms|business\s+managers?)\s+([A-Za-z0-9_-]+)/i);
  return cleanEntityToken(match?.[1] ?? "");
}

function splitActionSegments(message: string): Array<{ type: "share_account" | "unshare_account"; text: string }> {
  const actionPattern = /\b(unshare|unsher|remove|disconnect|unlink|revoke|share|add|connect|link|attach)\b/gi;
  const matches = Array.from(message.matchAll(actionPattern));
  const segments: Array<{ type: "share_account" | "unshare_account"; text: string }> = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const keyword = match[1]?.toLowerCase();
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? message.length;
    const type = ["unshare", "unsher", "remove", "disconnect", "unlink", "revoke"].includes(keyword ?? "")
      ? "unshare_account"
      : "share_account";

    segments.push({ type, text: message.slice(start, end).trim() });
  }

  return segments;
}

function extractAccountList(message: string): string[] {
  const lineValues = message
    .split(/\r?\n/)
    .map((line) => cleanEntityToken(line))
    .filter((line) => /^[A-Za-z0-9_-]{5,}$/.test(line));

  if (lineValues.length > 1) return uniqueStrings(lineValues);

  return uniqueStrings([
    ...extractLabeledShareEntities(message).adAccountIds,
    ...extractNumbersNear(message, ["account", "ad account", "acc", "verify", "status", "check"])
  ]);
}

function extractShareActions(message: string): DetectedAction[] {
  const actions: DetectedAction[] = [];
  const actionSegments = splitActionSegments(message);

  for (const segment of actionSegments) {
    const accounts = extractAccountsFromActionSegment(segment.text, segment.type);
    const bm = extractBmFromActionSegment(segment.text, segment.type);
    const action = actionFromValues(segment.type, accounts, segment.type === "unshare_account" && !bm ? "ALL BMs" : bm);

    if (action) addAction(actions, action);
  }

  if (actions.length > 0) return actions;

  const shareMatch = message.match(/\b(?:share|add|connect|link|attach)\b[\s\S]*?\b(?:ad\s+)?accounts?\s+([A-Za-z0-9_-]+)[\s\S]*?\b(?:to|into)\s+(?:bm|business\s+manager)\s+([A-Za-z0-9_-]+)/i);
  const fallbackShare = extractLabeledShareEntities(message);
  const sharedAccount = cleanEntityToken(shareMatch?.[1] ?? firstAccountValue(fallbackShare.adAccountIds) ?? "");
  const shareBm = cleanEntityToken(shareMatch?.[2] ?? firstAccountValue(fallbackShare.bmIds) ?? "");

  if (sharedAccount && shareBm && /\b(?:share|add|connect|link|attach)\b/i.test(message)) {
    addAction(actions, { type: "share_account", account: sharedAccount, bm: shareBm });
  }

  const unshareMatch = message.match(/\b(?:unshare|unsher|remove|disconnect|unlink|revoke)\b(?:[\s\S]*?\b(?:ad\s+)?accounts?\s+([A-Za-z0-9_-]+))?[\s\S]*?\b(?:from\s+)?(?:bm|business\s+manager)?\s*([A-Za-z0-9_-]+)/i);
  const unshareAccount = cleanEntityToken(unshareMatch?.[1] ?? sharedAccount);
  const unshareBm = cleanEntityToken(unshareMatch?.[2] ?? "");

  if (unshareAccount && unshareBm) {
    addAction(actions, { type: "unshare_account", account: unshareAccount, bm: unshareBm });
  }

  return actions;
}

function detectActions(message: string, intent: string, amount: string | null): DetectedAction[] {
  const actions: DetectedAction[] = [];
  const accounts = extractAccountList(message);

  for (const action of extractShareActions(message)) {
    addAction(actions, action);
  }

  if (amount) {
    addAction(actions, { type: "payment_check", amount });
  }

  if (/\b(verify|verification|card)\b/i.test(message) && accounts.length > 0) {
    addAction(actions, accounts.length > 1 ? { type: "verify_account", accounts } : { type: "verify_account", account: accounts[0] });
  }

  if (/\b(status|active|blocked|disabled|usable|can run ads)\b/i.test(message) && accounts.length > 0) {
    addAction(actions, accounts.length > 1 ? { type: "account_status_check", accounts } : { type: "account_status_check", account: accounts[0] });
  }

  if (actions.length === 0 && intent === "general_support") {
    addAction(actions, { type: "general_support" });
  }

  return actions;
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

function hasPaymentContext(text: string): boolean {
  return /\b(payment|deposit|deposited|sent|paid|funds?|usdt|usd|dollars?|top\s*up|transferred|transfer|transaction\s+hash|tx\s+hash|etherscan|payment\s+proof|proof\s+of\s+payment|funding|add\s+balance|wallet\s+balance|add\s+to\s+wallet)\b|\$/i.test(text);
}

function hasPaymentIssuePriority(text: string): boolean {
  return /\b(card\s+verification\s+issue|verify\s+card|payment\s+failed|cannot\s+pay|can't\s+pay|credit\s+card\s+problem|card\s+problem|payment\s+method\s+(?:rejected|problem|failed)|card\s+rejected|payment\s+declined)\b/i.test(text);
}

function hasDepositPriority(text: string): boolean {
  if (hasPaymentIssuePriority(text)) return false;

  const hasTransferProof = /\b(payment\s+proof|proof\s+of\s+payment|transaction\s+hash|tx\s+hash|etherscan|polygonscan|bscscan|tronscan|usdt|trc20|erc20|hash)\b|https?:\/\/\S*(?:etherscan|polygonscan|bscscan|tronscan|blockchain)\S*|\b0x[a-f0-9]{40,}\b/i.test(text);
  // "send" (present tense) is intentionally included: "guys send 25k" is a deposit notification.
  // "funding", "add balance", "add to wallet" are how clients announce they're sending money.
  const hasDepositWords = /\b(send|sent|deposit|deposited|paid|funds?\s+sent|transfer(?:red)?|top\s*up|money\s+sent|check\s+deposit|funding|add\s+balance|add\s+to\s+wallet|add\s+payment\s+to\s+wallet|balance\s+to\s+(our\s+)?wallet)\b/i.test(text);
  const hasAmount = /(?:\$|usd\s*)?\d+(?:[,.]\d+)?\s*(?:k|K)?\s*(?:usdt|usd|dollars?|\$)?/i.test(text);
  const asksToCheck = /\b(check|confirm|please\s+check|check\s+please)\b/i.test(text);

  return hasTransferProof || (hasDepositWords && (hasAmount || asksToCheck));
}

function hasAccountIssuePriority(text: string): boolean {
  return /\b(?:account\s+)?(?:disabled|restricted|banned|blocked)|account\s+problem\b/i.test(text);
}

function hasAccountContextNear(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 40), start).toLowerCase();
  const after = text.slice(end, Math.min(text.length, end + 40)).toLowerCase();
  const nearby = `${before} ${after}`;

  return /\b(account|accounts|ad account|acc|bm|check|verify|verification|status|card)\b/.test(nearby);
}

function hasPaymentContextNear(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 40), start).toLowerCase();
  const after = text.slice(end, Math.min(text.length, end + 40)).toLowerCase();
  const nearby = `${before} ${after}`;

  return /\b(payment|deposit|sent|paid|funds?|usdt|usd|dollars?|top\s*up|transferred)\b|\$/.test(nearby);
}

function extractAmount(text: string): string | null {
  if (!hasPaymentContext(text)) return null;

  const matches = text.matchAll(/(?:\$|usd\s*)?\d+(?:[,.]\d+)?\s*(?:k|K)?\s*(?:usdt|usd|dollars?|\$)?/gi);

  for (const match of matches) {
    const value = match[0]?.trim();
    if (!value) continue;

    const hasCurrencySignal = /[$]|usdt|usd|dollars?/i.test(value);
    const start = match.index ?? 0;
    const end = start + value.length;
    if (!hasCurrencySignal && hasAccountContextNear(text, start, end) && !hasPaymentContextNear(text, start, end)) continue;

    return value.replace(/\s+/g, " ");
  }

  return null;
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
  const priorityIntent =
    hasPaymentIssuePriority(combined)
      ? "payment_issue"
      : hasDepositPriority(combined)
        ? "deposit_funds"
        : hasAccountIssuePriority(combined)
          ? "check_account_status"
          : null;
  const best = priorityIntent
    ? {
        rule: RULES.find((rule) => rule.intent === priorityIntent) ?? RULES[0],
        matched: [`Priority detected: ${priorityIntent}`],
        score: 3
      }
    : ranked.find((entry) => entry.score > 0) ??
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

  const labeledShareEntities = intent === "share_ad_account" ? extractLabeledShareEntities(combined) : null;
  const bmIds = labeledShareEntities?.bmIds ?? extractNumbersNear(combined, ["bm", "business manager"]);
  const adAccountIds = labeledShareEntities?.adAccountIds ?? extractNumbersNear(combined, ["account", "ad account", "acc"]);
  const accountNames = extractAccountNames(combined);
  const accessLevel = extractAccessLevel(combined);
  const amount = ["share_ad_account", "verify_account", "check_account_status"].includes(intent) ? null : extractAmount(combined);
  const reportRange = extractReportRange(combined);
  const actions = detectActions(combined, intent, amount);

  const extractedData: Record<string, unknown> = {
    actions,
    accessLevel,
    ...(amount ? { amount } : {}),
    ...(reportRange ? { reportRange } : {})
  };

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
