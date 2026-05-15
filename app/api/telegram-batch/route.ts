import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { classifyIntent } from "@/lib/intent-classifier";
import { formatIntentLabel } from "@/lib/display";
import { writeClientRequestRowToGoogleSheet } from "@/lib/google-sheets";
import { maybeSendTelegramMessage, maybeSendTelegramPhoto } from "@/lib/telegram";
import type { Database } from "@/lib/supabase/database.types";

type TelegramReplyToMessage = {
  message_id?: number;
  text?: string;
  caption?: string;
};

type TelegramPhotoSize = { file_id: string; width?: number; height?: number; file_size?: number };
type TelegramDocument = { file_id: string; mime_type?: string; file_name?: string };

type TelegramMessageFields = {
  date?: number;
  chat?: { id?: number; title?: string };
  from?: { username?: string };
  reply_to_message?: TelegramReplyToMessage;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
};

type QueuedMessage = {
  id: string;
  created_at: string | null;
  telegram_chat_id: string | number | null;
  telegram_message_id: number | string | null;
  telegram_username: string | null;
  message_text: string | null;
  message_type: string | null;
  raw_payload: {
    message?: TelegramMessageFields;
    edited_message?: TelegramMessageFields;
    channel_post?: TelegramMessageFields;
  } | null;
};

// A photo (or image document) that should be forwarded to Mark after the text summary.
// Carries the request category and a short description so employees can match the photo
// to the right bullet in the batch summary — without revealing any client name.
type PhotoForward = {
  fileId: string;
  category: string;        // e.g. "Deposits", "General", "Account Issues"
  requestSummary: string;  // e.g. "sent 30K" or "site is down" — from the client's own message
  chatId: string;          // client's telegram_chat_id — used for agency routing
};

type BatchTicket = {
  id: string;
  intent: string | null;
  client_chat_id: string | number | null;
  client_message_id?: string | number | null;
  client_original_message: string | null;
  extracted_data: unknown;
  internal_summary: string | null;
  created_at: string | null;
  holding_message_id: string | number | null;
};

type BatchMarkerType = "batch_client_greeting" | "batch_non_request_skipped" | "batch_duplicate_skipped";

type SheetAction = {
  type?: string;
  account?: string;
  accounts?: string[];
  bm?: string;
  amount?: string;
};

type SupabaseAdminClient = SupabaseClient<Database, "public">;
type Classification = ReturnType<typeof classifyIntent>;

type LinkedFollowUpContext = {
  linkedTicketId: string | null;
  linkedClientMessageId: string | number | null;
  replyToTelegramMessageId: string | number | null;
  replyToMessageText: string | null;
  originalMessage: string;
  originalSummary: string;
  intent: string;
  extractedData: Record<string, unknown>;
};

const CATEGORY_ORDER = ["Account Creation", "Share", "Unshare", "Deposits", "Payment Issues", "Verification", "Account Issues", "Replacement", "General"] as const;
// Cron fires every 5 min on wall-clock boundaries (:00, :05, :10, …). To make a message
// sent at 1:03 visible to the 1:05 batch, the eligibility cutoff must be tight (1 min).
// A message arriving exactly at 1:04 still passes the 1:05 cutoff (lte 1:04 includes equal).
const BATCH_DELAY_MINUTES = 1;
const MESSAGE_LOOKBACK_MINUTES = 24 * 60;
const BATCH_MARKER_TYPES: BatchMarkerType[] = ["batch_client_greeting", "batch_non_request_skipped", "batch_duplicate_skipped"];
const CLEAN_CLIENT_BATCH_REPLY = "Understood, I'll check and update you.";
const CLIENT_BATCH_REPLY = "Understood, I’ll check and update you.";
const BATCH_REPLY_ENCODING_CHECK = CLIENT_BATCH_REPLY.includes("â");
const USE_CLEAN_CLIENT_BATCH_REPLY = Boolean(CLIENT_BATCH_REPLY) || BATCH_REPLY_ENCODING_CHECK;

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function requireEnv(label: string, names: string[]): string {
  const value = firstEnv(names);
  if (!value) throw new Error(`Missing environment variable: ${label}`);
  return value;
}

function createTicketCode(): string {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().slice(0, 6).toUpperCase();
  return `AL-${stamp}-${suffix}`;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function preserveBatchText(value: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeComparableText(text: string): string {
  return compactText(text).toLowerCase().replace(/[!?.,]+$/g, "");
}

function isPureNonSupportChatter(text: string): boolean {
  const normalized = normalizeComparableText(text);
  const trimmed = text.trim();
  const reactionOnly = /^[\s\u{1F44D}\u2764\uFE0F\u2705\u{1F64F}]+$/u.test(trimmed);
  const chatter = ["hi", "hello", "hey", "yo", "good morning", "good evening", "good night", "thanks", "thank you", "thx", "ty", "ok", "okay", "alright", "received", "noted", "greetings"];
  // Multi-word greetings: "hey guys", "hi team", "hello everyone", "hi all", etc.
  // "hey guys", "hi team", "hello everyone" — optionally followed by "how are you" etc.
  const isMultiWordGreeting = /^(hey|hi|hello|yo|sup|heya|hiya)\s+(guys|team|all|everyone|y'?all|there|fellas|folks)[,!?\s]*(?:how\s+(?:are|r)\s+(?:you|u|ya|yall|y'?all|you\s*guys|you\s*all|doing|everyone|everybody))?[.!?]*$/i.test(trimmed);
  // Social greetings that are clearly not support requests: "how are you guys?", "how r u", "how's it going" etc.
  const isSocialGreeting = /^how\s+(are|r)\s+(you|u|ya|yall|y'?all|you\s+guys|you\s+all|you\s+doing|everybody|everyone)/i.test(trimmed)
    || /^how'?s\s+(it going|everything|things|life|business)/i.test(trimmed)
    || /^(what'?s up|wyd|wassup|sup guys)/i.test(trimmed);
  return reactionOnly || chatter.includes(normalized) || isSocialGreeting || isMultiWordGreeting;
}

function isGreetingText(text: string): boolean {
  const normalized = normalizeComparableText(text);
  if (["hi", "hello", "hey", "yo", "good morning", "good evening", "good night", "greetings"].includes(normalized)) return true;
  // Social greetings: "how are you", "how are you guys", "what's up", etc.
  const trimmed = text.trim();
  // "hey guys", "hi team", "hello everyone" — optionally followed by "how are you" etc.
  if (/^(hey|hi|hello|yo|sup|heya|hiya)\s+(guys|team|all|everyone|y'?all|there|fellas|folks)[,!?\s]*(?:how\s+(?:are|r)\s+(?:you|u|ya|yall|y'?all|you\s*guys|you\s*all|doing|everyone|everybody))?[.!?]*$/i.test(trimmed)) return true;
  if (/^how\s+(are|r)\s+(you|u|ya|yall|y'?all|you\s+guys|you\s+all|you\s+doing|everybody|everyone)/i.test(trimmed)) return true;
  if (/^how'?s (it going|everything|things|life|business)/i.test(trimmed)) return true;
  if (/^(what'?s up|wyd|wassup|sup guys)/i.test(trimmed)) return true;
  return false;
}

function hasRequestSignal(text: string): boolean {
  const normalized = normalizeComparableText(text);
  return /\b(share|unshare|remove|bm|account|deposit|sent|paid|payment|funds|usdt|usd|verify|verification|disabled|restricted|failed|issue|problem|check|status|availability|replacement|replace|limit|spending|spend|need|request|refund|business|support)\b|\$|\d/.test(normalized);
}

function isIncompleteRequestFragment(text: string): boolean {
  const normalized = normalizeComparableText(text);
  if (!normalized) return true;
  if (/^(?:sent|send|paid|deposit|check|please check|pls check|\$|usd|usdt|dollars?)$/i.test(normalized)) return true;
  if (/^(?:\d+(?:[.,]\d+)?[kкК]?|\d+(?:[.,]\d+)?\s*(?:usd|usdt|\$|dollars?))$/i.test(normalized)) return true;
  if (/^(?:bm|business manager)\s+[A-Za-z0-9_-]+$/i.test(normalized)) return true;
  if (/^(?:account|acc|ad account)\s+[A-Za-z0-9_-]+$/i.test(normalized)) return true;
  return false;
}

function isFollowUpText(text: string): boolean {
  const normalized = normalizeComparableText(text);
  return /^(?:any\s+)?updates?$/.test(normalized)
    || /^(?:what(?:'s| is)\s+the\s+)?status$/.test(normalized)
    || /^(?:is\s+it\s+)?done$/.test(normalized)
    || /\b(?:any\s+update|update\??|status\??|done\??)\b/i.test(text)
    || /\bdid\s+you\s+(?:share|unshare|remove|do|finish|complete)\b/i.test(text);
}

function mapIntentToCategory(intent: string | null | undefined): typeof CATEGORY_ORDER[number] {
  const normalized = String(intent || "").toLowerCase();
  if (["process_account_creation", "request_accounts"].includes(normalized)) return "Account Creation";
  if (["share_ad_account", "transfer_ad_account"].includes(normalized)) return "Share";
  if (["unshare_ad_account"].includes(normalized)) return "Unshare";
  if (["deposit_funds"].includes(normalized)) return "Deposits";
  if (["payment_issue", "refund_request"].includes(normalized)) return "Payment Issues";
  if (["verify_account"].includes(normalized)) return "Verification";
  if (["check_account_status", "request_data_banned_accounts", "check_policy",
    "pause_campaigns", "appeal_review", "account_not_visible", "rename_account",
    "request_account_ids"].includes(normalized)) return "Account Issues";
  if (["replacement_request"].includes(normalized)) return "Replacement";
  // site_issue, check_availability, get_spend_report, request_accounts, remaining_balance, general_support → General
  return "General";
}

function getActions(extractedData: unknown): SheetAction[] {
  if (!extractedData || typeof extractedData !== "object" || Array.isArray(extractedData)) return [];
  const actions = (extractedData as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return [];
  return actions.filter((action): action is SheetAction => Boolean(action) && typeof action === "object");
}

function extractedObject(extractedData: unknown): Record<string, unknown> {
  if (!extractedData || typeof extractedData !== "object" || Array.isArray(extractedData)) return {};
  return extractedData as Record<string, unknown>;
}

function extractedText(extractedData: unknown, key: string): string | null {
  const value = extractedObject(extractedData)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstAccount(action: SheetAction | undefined): string | null {
  return action?.account ?? action?.accounts?.[0] ?? null;
}

function accountsText(action: SheetAction | undefined): string | null {
  if (!action) return null;
  if (Array.isArray(action.accounts) && action.accounts.length > 0) return action.accounts.join(", ");
  return action.account ?? null;
}

function formatBm(value: string | undefined): string | null {
  if (!value) return null;
  return value.toUpperCase() === "ALL BMS" ? "all BMs" : value;
}

function actionTypeToIntent(action: SheetAction): string {
  if (action.type === "share_account") return "share_ad_account";
  if (action.type === "unshare_account") return "unshare_ad_account";
  if (action.type === "payment_check") return "deposit_funds";
  if (action.type === "verify_account") return "verify_account";
  if (action.type === "account_status_check") return "check_account_status";
  return "general_support";
}

function actionToCategory(action: SheetAction): typeof CATEGORY_ORDER[number] {
  return mapIntentToCategory(actionTypeToIntent(action));
}

function extractAmount(text: string): string | null {
  const match = text.match(/(?:\$|usd\s*)?\d+(?:[,.]\d+)?\s*(?:[kкК])?\s*(?:usdt|usd|dollars?|\$)?/i);
  return match?.[0] ? compactText(match[0]).replace(/\s+/g, "") : null;
}

function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"]+/);
  return match?.[0] ?? null;
}

// Returns true when the message text is nothing but a URL (possibly with surrounding whitespace).
// Used during grouping so "sent 30K" + "https://etherscan.io/..." stay in the same Deposits group
// instead of splitting into Deposits + General.
function isUrlOnlyText(text: string): boolean {
  return /^https?:\/\/[^\s]+$/.test(text.trim());
}

// Extracts the largest available photo file_id from a Telegram message payload,
// or the file_id of an image document. Returns null if there is no photo.
function getPhotoFileId(message: QueuedMessage): string | null {
  const tgMsg = getTelegramMessage(message.raw_payload);
  if (tgMsg?.photo && tgMsg.photo.length > 0) {
    // Telegram provides multiple sizes; the last one is always the largest.
    return tgMsg.photo[tgMsg.photo.length - 1].file_id;
  }
  if (tgMsg?.document?.file_id && tgMsg.document.mime_type?.toLowerCase().startsWith("image/")) {
    return tgMsg.document.file_id;
  }
  return null;
}

function extractEntityAfter(text: string, labels: string[]): string | null {
  const labelPattern = labels.map((label) => label.replace(/\s+/g, "\\s+")).join("|");
  // Require at least one digit — account IDs are always numeric.
  // This prevents plain words like "are", "is", "banned" from being captured as IDs.
  const match = text.match(new RegExp(`\\b(?:${labelPattern})\\b\\s*[:#-]?\\s*([A-Za-z0-9_-]*\\d[A-Za-z0-9_-]*)`, "i"));
  return match?.[1] ?? null;
}

function formatFollowUpTask(followUpMessage: string | null, baseText: string, actionType?: string): string {
  if (!followUpMessage) return baseText;

  const cleanFollowUp = compactText(followUpMessage).replace(/[?!.]+$/g, "");
  if (!cleanFollowUp) return baseText;
  if (/\b(?:any\s+)?update|status|done\b/i.test(cleanFollowUp)) return `${cleanFollowUp} on: ${baseText}`;
  if (actionType === "share_account") return `follow-up on share request: ${baseText}`;
  if (actionType === "unshare_account") return `follow-up on unshare request: ${baseText}`;
  if (actionType === "payment_check") return `follow-up on deposit request: ${baseText}`;
  return `${cleanFollowUp} on: ${baseText}`;
}

function cleanTaskText(ticket: BatchTicket): string {
  const followUpMessage = extractedText(ticket.extracted_data, "followUpMessage");
  const linkedOriginalSummary = extractedText(ticket.extracted_data, "linkedOriginalSummary");
  if (followUpMessage && linkedOriginalSummary) return formatFollowUpTask(followUpMessage, linkedOriginalSummary);

  const category = mapIntentToCategory(ticket.intent);
  // Compact version is used for entity extraction (regex matching).
  // Preserved version is used as fallback display text so multi-line groups (e.g. reply context
  // prepended as "Re: …\nclient reply") show as separate lines in Mark's summary.
  const original = compactText(ticket.client_original_message ?? "");
  const preservedOriginal = preserveBatchText(ticket.client_original_message ?? "");
  const actions = getActions(ticket.extracted_data);
  const shareAction = actions.find((action) => action.type === "share_account");
  const unshareAction = actions.find((action) => action.type === "unshare_account");
  const paymentAction = actions.find((action) => action.type === "payment_check");
  const verifyAction = actions.find((action) => action.type === "verify_account");
  const accountStatusAction = actions.find((action) => action.type === "account_status_check");

  if (category === "Account Creation") {
    // Extract digit count: "I requested 20 more accounts" → "20"
    const numMatch = original.match(/\b(\d+)\s*(?:more\s+|new\s+|additional\s+)?(?:ad\s+)?accs?(?:ounts?)?\b/i)
      ?? original.match(/\b(\d+)\s+(?:more\s+)?(?:new\s+)?accounts?\b/i);
    // Extract word count: "I need twenty new accounts" → "twenty"
    const wordNumMatch = !numMatch ? original.match(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred)\s+(?:new\s+|more\s+|additional\s+)?(?:ad\s+)?accounts?\b/i) : null;
    const count = numMatch?.[1] ?? wordNumMatch?.[1] ?? null;
    // "request_accounts" = client is requesting new accounts (hasn't submitted yet)
    // "process_account_creation" = client already submitted, wants us to process it
    if (ticket.intent === "request_accounts") {
      return count ? `requesting ${count} new account(s)` : "requesting new accounts";
    }
    return count ? `process ${count} account creation request(s)` : "process account creation request";
  }

  if (category === "Share") {
    const account = firstAccount(shareAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    const bm = formatBm(shareAction?.bm) ?? extractEntityAfter(original, ["bm", "business manager"]);
    if (account && bm) return `share account ${account} to BM ${bm}`;
    if (account) return `share account ${account}`;
    return preservedOriginal || "share account request";
  }

  if (category === "Unshare") {
    const accounts = unshareAction?.accounts?.length ? unshareAction.accounts.join(", ") : null;
    const account = accounts ?? firstAccount(unshareAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    const bm = formatBm(unshareAction?.bm) ?? extractEntityAfter(original, ["bm", "business manager"]);
    if (account && bm) return `unshare accounts ${account} from ${bm}`;
    if (account) return `unshare accounts ${account}`;
    return preservedOriginal || "unshare account request";
  }

  if (category === "Deposits") {
    const amount = paymentAction?.amount ?? extractAmount(original);
    const url = extractFirstUrl(original);
    const baseText = amount ? `sent ${amount}, please check` : "deposit sent, please check";
    // Append the Etherscan / blockchain link so Mark can click it directly from the summary.
    return url ? `${baseText}\n${url}` : baseText;
  }

  if (category === "Payment Issues") {
    const account = firstAccount(accountStatusAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    if (account && /\bfailed\b/i.test(original)) return `payment failed on account ${account}`;
    return account ? `payment issue on account ${account}` : "payment issue reported";
  }

  if (category === "Verification") {
    const bm = extractEntityAfter(original, ["bm", "business manager"]);
    const account = firstAccount(verifyAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    if (bm) return `verify BM ${bm}`;
    return account ? `verify account ${account}` : "verification request";
  }

  if (category === "Account Issues") {
    const account = firstAccount(accountStatusAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    // Intent-specific labels for new sub-types
    if (ticket.intent === "pause_campaigns") return account ? `pause campaigns on account ${account}` : "pause / stop campaigns request";
    if (ticket.intent === "appeal_review") return account ? `appeal / review request for account ${account}` : "appeal / review request";
    if (ticket.intent === "rename_account") return "rename account request";
    if (ticket.intent === "account_not_visible") return account ? `account ${account} not visible in BM` : "account not visible in BM";
    if (ticket.intent === "request_account_ids") return "account IDs request";
    // Existing campaign / disabled detection
    if (/\b(campaigns?\s+stopped|campaigns?\s+paused|ads?\s+stopped|ads?\s+paused|not\s+running|not\s+delivering|not\s+spending|no\s+spend)\b/i.test(original)) {
      return account ? `campaigns stopped on account ${account}` : "campaigns stopped / not spending";
    }
    if (account && /\b(disabled|restricted|blocked|banned|suspended)\b/i.test(original)) return `account ${account} disabled/banned`;
    if (account) return `account issue on account ${account}`;
    // Fallback: pull the first 5+ digit number directly from the message text
    const numFallback = original.match(/\b\d{5,}\b/)?.[0] ?? null;
    return numFallback ? `account issue on account ${numFallback}` : "account issue reported";
  }

  if (category === "Replacement") {
    const account = firstAccount(accountStatusAction) ?? extractEntityAfter(original, ["account", "accounts", "acc", "ad account", "ad accounts"]);
    return account ? `replacement account request for ${account}` : "replacement account request";
  }

  // General — label known sub-intents clearly so Mark sees them in the summary
  if (category === "General" && ticket.intent === "site_issue") {
    return "site is down / client cannot load the site";
  }
  if (category === "General" && ticket.intent === "remaining_balance") {
    return "remaining balance inquiry";
  }

  // Return the full original message (line-breaks preserved) so multi-question groups
  // (e.g. "monthly reports?" + "accounts in stock?") and reply-context blocks
  // (e.g. "Re: "Did you share?"\nDid you share those?") display correctly in Mark's summary.
  // Deduplicate consecutive identical lines: if the same message was picked up twice because
  // a previous batch failed without advancing processedThroughMs, the grouped text contains
  // the same line twice (e.g. "do you have accounts?\ndo you have accounts?"). Remove the dupe.
  if (preservedOriginal) {
    const lines = preservedOriginal.split("\n");
    const deduped = lines.filter((line, i) => i === 0 || line.trim() !== lines[i - 1]?.trim());
    return deduped.join("\n");
  }
  return "General support request";
}

function cleanActionTaskText(ticket: BatchTicket, action: SheetAction): string {
  const original = compactText(ticket.client_original_message ?? "");
  const accounts = accountsText(action);
  const followUpMessage = extractedText(ticket.extracted_data, "followUpMessage");
  const linkedOriginalSummary = extractedText(ticket.extracted_data, "linkedOriginalSummary");
  let baseText: string;

  if (action.type === "share_account") {
    const bm = formatBm(action.bm);
    if (accounts && bm) baseText = `share account ${accounts} to BM ${bm}`;
    else if (accounts) baseText = `share account ${accounts}`;
    else baseText = linkedOriginalSummary || original || "share account request";
  } else if (action.type === "unshare_account") {
    const bm = formatBm(action.bm);
    if (accounts && bm) baseText = `unshare accounts ${accounts} from ${bm}`;
    else if (accounts) baseText = `unshare accounts ${accounts}`;
    else baseText = linkedOriginalSummary || original || "unshare account request";
  } else if (action.type === "payment_check") {
    const depositUrl = extractFirstUrl(original);
    baseText = action.amount ? `sent ${action.amount}, please check` : linkedOriginalSummary || "deposit sent, please check";
    if (depositUrl) baseText += `\n${depositUrl}`;
  } else if (action.type === "verify_account") {
    baseText = accounts ? `verify account ${accounts}` : linkedOriginalSummary || "verification request";
  } else if (action.type === "account_status_check") {
    baseText = accounts ? `account issue on account ${accounts}` : linkedOriginalSummary || "account issue reported";
  } else {
    baseText = linkedOriginalSummary || original || "General support request";
  }

  return formatFollowUpTask(followUpMessage, baseText, action.type);
}

function buildMarkSummary(tickets: BatchTicket[]): string {
  const grouped = new Map<typeof CATEGORY_ORDER[number], string[]>();
  for (const category of CATEGORY_ORDER) grouped.set(category, []);
  for (const ticket of tickets) {
    const intentCategory = mapIntentToCategory(ticket.intent);
    const actions = getActions(ticket.extracted_data);

    // When the ticket's intent is unambiguously a problem (Payment Issues, Account Issues),
    // never let an extracted payment_check action drag it into Deposits. The classifier
    // can falsely tag a long account-id number as an "amount" and produce a payment_check
    // action — e.g. "i have payment issue on this acocunts 51781181" was being shown as
    // "* sent 51781181, please check" under DEPOSITS instead of PAYMENT ISSUES.
    if (intentCategory === "Payment Issues" || intentCategory === "Account Issues") {
      grouped.get(intentCategory)?.push(cleanTaskText(ticket));
      continue;
    }

    if (actions.length > 0) {
      for (const action of actions) grouped.get(actionToCategory(action))?.push(cleanActionTaskText(ticket, action));
    } else {
      grouped.get(intentCategory)?.push(cleanTaskText(ticket));
    }
  }

  const headings: Record<typeof CATEGORY_ORDER[number], string> = {
    "Account Creation": "ACCOUNT CREATION",
    Share: "SHARE REQUESTS",
    Unshare: "UNSHARE REQUESTS",
    Deposits: "DEPOSITS",
    "Payment Issues": "PAYMENT ISSUES",
    Verification: "VERIFICATION",
    "Account Issues": "ACCOUNT ISSUES",
    Replacement: "REPLACEMENT REQUESTS",
    General: "GENERAL QUESTIONS"
  };

  const sections = CATEGORY_ORDER
    .map((category) => {
      const items = grouped.get(category) ?? [];
      if (items.length === 0) return null;
      // Deduplicate: if two tickets in the same category produce identical display text
      // (e.g. the same question picked up in two consecutive batches), show it only once.
      const seen = new Set<string>();
      const uniqueItems = items.filter((item) => {
        const key = item.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return [headings[category], ...uniqueItems.map((item) => `* ${escapeTelegramHtml(item)}`)].join("\n\n");
    })
    .filter(Boolean);

  return ["\u{1F4CC} NEW REQUESTS BATCH", ...sections].join("\n\n");
}

function chooseClientReply(tickets: BatchTicket[]): string {
  const categories = tickets.map((ticket) => mapIntentToCategory(ticket.intent));
  const intents = tickets.map((ticket) => String(ticket.intent ?? ""));
  const uniqueCategories = [...new Set(categories)];

  // When the client asked about multiple DIFFERENT categories in one batch (e.g. "do you have
  // accounts available?" + "please share 123 to BM 456"), picking one category-specific reply
  // silently ignores the other question. Use a neutral combined reply that covers everything.
  if (uniqueCategories.length > 1) {
    return "Got it, we'll handle your requests and get back to you shortly.";
  }

  // Single category — pick a tailored reply.
  if (categories.includes("Account Creation")) {
    if (intents.some((i) => i === "request_accounts")) return "Got it, we'll check on account availability and get back to you shortly.";
    return "Got it, we'll process the account creation and update you once done.";
  }
  if (categories.includes("Deposits")) return "Got it! We received your deposit — we'll verify and confirm shortly.";
  if (categories.includes("Payment Issues")) return "Got it, we'll look into the payment issue and get back to you.";
  if (categories.includes("Share") && categories.includes("Unshare")) return "Sure, we'll handle your account requests and update you.";
  if (categories.includes("Share")) return "Sure, we'll take care of the share request and update you.";
  if (categories.includes("Unshare")) return "Sure, we'll process the unshare request and update you.";
  if (categories.includes("Verification")) return "Got it, we'll check the verification and update you.";
  if (categories.includes("Account Issues")) {
    if (intents.some((i) => i === "pause_campaigns")) return "Got it, we'll pause the campaigns and confirm once done.";
    if (intents.some((i) => i === "appeal_review")) return "Got it, we'll submit the review request to Meta and update you.";
    if (intents.some((i) => i === "rename_account")) return "Sure, we'll rename the account and update you once done.";
    if (intents.some((i) => i === "account_not_visible")) return "Got it, we'll check the BM access and update you.";
    if (intents.some((i) => i === "request_account_ids")) return "Sure, we'll send you the account IDs shortly.";
    return "Got it, we'll look into the account issue and update you.";
  }
  if (categories.includes("Replacement")) return "Got it, we'll check on a replacement account and get back to you.";

  // General category — when there are multiple DIFFERENT intents the client asked about several
  // separate topics in one batch. Picking one intent-specific reply silently ignores the rest.
  const uniqueGeneralIntents = [...new Set(intents)];
  if (uniqueGeneralIntents.length > 1) {
    return "Got it, let me check and I'll get back to you.";
  }

  // Single General intent — pick a reply tailored to what they actually asked.
  if (intents.some((i) => i === "site_issue")) {
    return "We're looking into the site issue and will update you shortly.";
  }
  if (intents.some((i) => i === "check_availability")) {
    return "Thanks for reaching out! We'll check on availability and get back to you shortly.";
  }
  if (intents.some((i) => i === "get_spend_report")) {
    return "Got it, we'll pull the report and send it to you shortly.";
  }
  // Mixed or truly general
  return "Got it, we'll look into this and get back to you shortly.";
}

function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getTelegramMessage(update: QueuedMessage["raw_payload"]) {
  return update?.message ?? update?.edited_message ?? update?.channel_post ?? null;
}

function getReplyToMessage(message: QueuedMessage): TelegramReplyToMessage | null {
  return getTelegramMessage(message.raw_payload)?.reply_to_message ?? null;
}

function getReplyText(replyToMessage: TelegramReplyToMessage | null): string | null {
  const value = (replyToMessage?.text ?? replyToMessage?.caption ?? "").trim();
  return value || null;
}

function getTelegramMessageDate(message: QueuedMessage): Date {
  const telegramDate = getTelegramMessage(message.raw_payload)?.date;
  if (typeof telegramDate === "number" && Number.isFinite(telegramDate)) {
    return new Date(telegramDate * 1000);
  }

  return message.created_at ? new Date(message.created_at) : new Date();
}

function getChatTitle(message: QueuedMessage): string {
  const telegramMessage = getTelegramMessage(message.raw_payload);
  return telegramMessage?.chat?.title?.trim() || String(message.telegram_chat_id ?? "");
}

function getUsername(message: QueuedMessage): string {
  const telegramMessage = getTelegramMessage(message.raw_payload);
  return telegramMessage?.from?.username?.trim() || message.telegram_username?.trim() || "";
}

function chooseGreetingReply(messages: QueuedMessage[]): string {
  const text = messages.map((message) => message.message_text ?? "").join(" ");
  if (/good morning/i.test(text)) return "Good morning, how can I help?";
  if (/good evening|good night/i.test(text)) return "Good evening, how can I help?";
  // "How are you?" / "How are you guys?" — reply warmly with an offer to help.
  if (/how (are|r) (you|u|ya|yall|y'?all|you\s+guys)/i.test(text)) {
    const replies = [
      "Hey! All good here, how can I help you today?",
      "Hey! Doing great, thanks! How can I help?",
      "Hi! We're doing well, what can I do for you?",
      "Hey! All good, how can we help you today?"
    ];
    return replies[Math.floor(Math.random() * replies.length)] ?? replies[0]!;
  }
  if (/what'?s up|wassup|sup/i.test(text)) {
    return "Hey! What can I help you with?";
  }
  return "Hi, how can I help?";
}

function isOpenTicketStatus(status: string | null | undefined): boolean {
  return ["open", "new", "waiting_mark", "waiting_for_mark"].includes(status ?? "");
}

function summarizeTicketContext(ticket: BatchTicket): string {
  const actions = getActions(ticket.extracted_data);
  if (actions.length > 0) return actions.map((action) => cleanActionTaskText(ticket, action)).join("; ");
  return cleanTaskText(ticket);
}

function buildFollowUpTicketMessage(followUpMessage: string, context: LinkedFollowUpContext): string {
  return [
    `Follow-up: ${compactText(followUpMessage)}`,
    `Original context: ${context.originalSummary}`,
    context.originalMessage ? `Original message: ${compactText(context.originalMessage)}` : ""
  ].filter(Boolean).join("\n\n");
}

function withFollowUpContext(classification: Classification, followUpMessage: string, context: LinkedFollowUpContext): Classification {
  const originalActions = getActions(context.extractedData);
  const currentData = extractedObject(classification.extractedData);
  const originalData = extractedObject(context.extractedData);
  const intent = context.intent || classification.intent || "general_support";
  const actionSummary = context.originalSummary || context.originalMessage || "original request";

  return {
    ...classification,
    intent,
    humanLabel: formatIntentLabel(intent),
    confidence: "high",
    requiresMark: true,
    shouldReply: true,
    closeConversation: false,
    extractedData: {
      ...currentData,
      ...originalData,
      actions: originalActions.length ? originalActions : getActions(classification.extractedData),
      followUp: true,
      followUpMessage: compactText(followUpMessage),
      linkedOriginalSummary: actionSummary,
      linkedOriginalMessage: context.originalMessage,
      linkedTicketId: context.linkedTicketId,
      linkedClientMessageId: context.linkedClientMessageId,
      replyToTelegramMessageId: context.replyToTelegramMessageId,
      replyToMessageText: context.replyToMessageText,
      category: mapIntentToCategory(intent)
    },
    internalSummary: `Follow-up: "${compactText(followUpMessage)}". Original context: ${actionSummary}. Detected intent: ${formatIntentLabel(intent)}. Requires Mark: yes.`,
    matchedRules: [
      "Follow-up detected from Telegram reply context or existing open client request.",
      ...(classification.matchedRules ?? [])
    ]
  };
}

async function findFollowUpContext(
  supabase: SupabaseAdminClient,
  chatId: string,
  messages: QueuedMessage[],
  groupedText: string
): Promise<LinkedFollowUpContext | null> {
  const replyTo = messages.map(getReplyToMessage).find((reply): reply is TelegramReplyToMessage => Boolean(reply?.message_id));
  const replyToTelegramMessageId = replyTo?.message_id ?? null;
  const replyToText = getReplyText(replyTo ?? null);
  const hasFollowUpSignal = isFollowUpText(groupedText);
  if (!replyToTelegramMessageId && !hasFollowUpSignal) return null;

  const { data: ticketRows, error: ticketsError } = await supabase
    .from("tickets")
    .select("id, intent, client_chat_id, client_message_id, client_original_message, extracted_data, internal_summary, created_at, holding_message_id, status")
    .eq("client_chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (ticketsError) throw new Error(`Supabase follow-up ticket lookup failed: ${ticketsError.message}`);

  const tickets = (ticketRows ?? []) as Array<BatchTicket & { status?: string | null }>;
  let linkedTicket: (BatchTicket & { status?: string | null }) | null = null;
  let linkedClientMessageId: string | number | null = null;
  let linkedOriginalMessage = replyToText ?? "";

  if (replyToTelegramMessageId) {
    const { data: botResponse, error: botResponseError } = await supabase
      .from("bot_responses")
      .select("ticket_id, response_text")
      .eq("telegram_chat_id", chatId)
      .eq("telegram_message_id", replyToTelegramMessageId)
      .limit(1)
      .maybeSingle();
    if (botResponseError) throw new Error(`Supabase follow-up bot response lookup failed: ${botResponseError.message}`);

    const botTicketId = (botResponse as { ticket_id?: string | null } | null)?.ticket_id;
    if (botTicketId) {
      linkedTicket = tickets.find((ticket) => ticket.id === botTicketId) ?? null;
      if (!linkedTicket) {
        const { data: ticketById, error: ticketByIdError } = await supabase
          .from("tickets")
          .select("id, intent, client_chat_id, client_message_id, client_original_message, extracted_data, internal_summary, created_at, holding_message_id, status")
          .eq("id", botTicketId)
          .maybeSingle();
        if (ticketByIdError) throw new Error(`Supabase follow-up linked ticket lookup failed: ${ticketByIdError.message}`);
        linkedTicket = ticketById as (BatchTicket & { status?: string | null }) | null;
      }
    }

    if (!linkedTicket) {
      const { data: repliedMessage, error: repliedMessageError } = await supabase
        .from("messages")
        .select("id, message_text")
        .eq("telegram_chat_id", chatId)
        .eq("telegram_message_id", replyToTelegramMessageId)
        .limit(1)
        .maybeSingle();
      if (repliedMessageError) throw new Error(`Supabase replied message lookup failed: ${repliedMessageError.message}`);

      const repliedRow = repliedMessage as { id?: string | null; message_text?: string | null } | null;
      linkedClientMessageId = repliedRow?.id ?? null;
      linkedOriginalMessage = repliedRow?.message_text ?? replyToText ?? "";
      linkedTicket = linkedClientMessageId
        ? tickets.find((ticket) => String(ticket.client_message_id ?? "") === String(linkedClientMessageId)) ?? null
        : null;

      if (!linkedTicket && linkedOriginalMessage) {
        const normalizedReply = compactText(linkedOriginalMessage).toLowerCase();
        linkedTicket = tickets.find((ticket) => compactText(ticket.client_original_message ?? "").toLowerCase().includes(normalizedReply)) ?? null;
      }
    }
  }

  if (!linkedTicket && hasFollowUpSignal) {
    linkedTicket = tickets.find((ticket) => isOpenTicketStatus(ticket.status)) ?? tickets[0] ?? null;
  }

  if (!linkedTicket && !linkedOriginalMessage) return null;

  const sourceTicket = linkedTicket;
  const originalMessage = sourceTicket?.client_original_message ?? linkedOriginalMessage;
  const extractedData = extractedObject(sourceTicket?.extracted_data);
  const originalSummary = sourceTicket ? summarizeTicketContext(sourceTicket) : compactText(linkedOriginalMessage);

  return {
    linkedTicketId: sourceTicket?.id ?? null,
    linkedClientMessageId: sourceTicket?.client_message_id ?? linkedClientMessageId,
    replyToTelegramMessageId,
    replyToMessageText: replyToText,
    originalMessage,
    originalSummary,
    intent: sourceTicket?.intent ?? "general_support",
    extractedData
  };
}

async function getLastBatchMarkerMs(supabase: SupabaseAdminClient, chatId: string): Promise<number> {
  const { data, error } = await supabase
    .from("bot_responses")
    .select("created_at, response_text")
    .eq("telegram_chat_id", chatId)
    .in("response_type", BATCH_MARKER_TYPES)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Supabase batch marker query failed: ${error.message}`);
  if (!data?.created_at) return 0;
  // Use the stored last-message timestamp rather than the row insertion time.
  // The insertion time can be minutes ahead of the actual messages, causing those
  // messages to be permanently excluded from future batches.
  const msgMsMatch = (data.response_text ?? "").match(/\|lastMsgMs:(\d+)/);
  if (msgMsMatch?.[1]) return parseInt(msgMsMatch[1], 10);
  return new Date(data.created_at).getTime();
}

async function markChatBatchProcessed(
  supabase: SupabaseAdminClient,
  chatId: string,
  responseType: BatchMarkerType,
  responseText: string,
  telegramMessageId: number | null = null,
  lastMessageMs: number = 0
) {
  const storedText = lastMessageMs > 0 ? `${responseText}|lastMsgMs:${lastMessageMs}` : responseText;
  await supabase.from("bot_responses").insert({
    ticket_id: null,
    telegram_chat_id: chatId,
    telegram_message_id: telegramMessageId,
    response_type: responseType,
    response_text: storedText
  });
}

type ChatError = { chatId: string; error: string };
type DepositLinkUpdate = { chatTitle: string; url: string; ticketId: string; chatId: string };
type DepositForward = {
  clientChatId: string;
  clientTitle: string;
  originalMessage: string;
  photoFileId: string | null;
};

// ── Gemini vision: analyze a photo and return a context description ──────────────────────────────
// Called before batch classification so the classifier knows what the image shows.
// Returns a short description that gets prepended to message_text:
// - "payment proof sent" → routes to master as deposit
// - "site is down" → classified as site_issue
// - "account disabled screenshot" → classified as account issue
// - "" → no clear signal, classify on caption/text alone
async function analyzePhotoWithGemini(fileId: string, botToken: string, geminiKey: string): Promise<string> {
  try {
    const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const fileData = await fileRes.json() as { ok: boolean; result?: { file_path: string } };
    if (!fileData.ok || !fileData.result?.file_path) return "";

    const imgRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`);
    if (!imgRes.ok) return "";
    const mimeType = imgRes.headers.get("content-type") ?? "image/jpeg";
    const base64 = Buffer.from(await imgRes.arrayBuffer()).toString("base64");

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { inline_data: { mime_type: mimeType, data: base64 } },
              { text: `Classify this image into exactly ONE of these categories. Reply with ONLY the category label, nothing else.

Categories:
- "payment proof sent" — payment receipt, money transfer confirmation, crypto/blockchain transaction, bank transfer screenshot, USDT/crypto wallet screenshot
- "site is down" — website error page, blank/black screen, loading error, 404/500 error, "cannot reach site", browser showing site not loading
- "account disabled screenshot" — Facebook/Meta ad account disabled/restricted notification, account banned message, policy violation notice
- "account screenshot" — ad account dashboard, campaign stats, spend report, BM (Business Manager) screenshot, ad manager interface
- "other" — anything that doesn't clearly fit the above categories

Reply with ONLY the exact category label from the list above.` }
            ]
          }]
        })
      }
    );
    const geminiData = await geminiRes.json() as { candidates?: Array<{ content?: { parts?: Array<{ text: string }> } }> };
    const answer = geminiData.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toLowerCase() ?? "";
    console.log("gemini-photo-result", { fileId, answer });

    if (answer.includes("payment proof")) return "payment proof sent";
    if (answer.includes("site is down") || answer.includes("site down")) return "site is down";
    if (answer.includes("account disabled")) return "account disabled";
    if (answer.includes("account screenshot")) return "account status check";
    return "";
  } catch (e) {
    console.error("gemini-photo-analysis-failed", { error: e instanceof Error ? e.message : "unknown" });
    return "";
  }
}

async function createTicketsFromQueuedMessages(
  supabase: SupabaseAdminClient,
  messages: QueuedMessage[],
  routingMap: Map<string, string>  // clientChatId → agency Telegram chat ID; empty = process all
): Promise<{ tickets: BatchTicket[]; photoForwards: PhotoForward[]; depositLinkUpdates: DepositLinkUpdate[]; chatErrors: ChatError[]; chatDuplicateIntents: Map<string, string[]>; depositForwards: DepositForward[] }> {
  const messagesByChat = new Map<string, QueuedMessage[]>();
  for (const message of messages) {
    if (!message.telegram_chat_id) continue;
    const key = String(message.telegram_chat_id);
    messagesByChat.set(key, [...(messagesByChat.get(key) ?? []), message]);
  }

  const createdTickets: BatchTicket[] = [];
  const allPhotoForwards: PhotoForward[] = [];
  const allDepositLinkUpdates: DepositLinkUpdate[] = [];
  const allDepositForwards: DepositForward[] = [];
  const chatErrors: ChatError[] = [];
  const chatDuplicateIntents = new Map<string, string[]>();
  for (const [chatId, chatMessages] of messagesByChat.entries()) {
    // Multi-agency routing: when routing is configured, skip chats that have not been
    // assigned to any agency. Unassigned clients receive no reply and no ticket.
    if (routingMap.size > 0 && !routingMap.has(chatId)) {
      console.log("chat-skipped-not-assigned", { chatId });
      continue;
    }
    try {
    const { data: latestTicketData, error: latestTicketError } = await supabase
      .from("tickets")
      .select("client_message_id")
      .eq("client_chat_id", chatId)
      .not("client_message_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestTicketError) throw new Error(`Supabase latest ticket query failed: ${latestTicketError.message}`);
    const latestTicket = latestTicketData as { client_message_id: string | null } | null;

    let processedThroughMs = 0;
    if (latestTicket?.client_message_id) {
      const { data: processedMessageData, error: processedMessageError } = await supabase
        .from("messages")
        .select("created_at")
        .eq("id", latestTicket.client_message_id)
        .maybeSingle();
      if (processedMessageError) throw new Error(`Supabase processed message query failed: ${processedMessageError.message}`);
      const processedMessage = processedMessageData as { created_at: string | null } | null;
      processedThroughMs = processedMessage?.created_at ? new Date(processedMessage.created_at).getTime() : 0;
    }
    processedThroughMs = Math.max(processedThroughMs, await getLastBatchMarkerMs(supabase, chatId));

    const unprocessedMessages = chatMessages.filter((message) => {
      const createdAtMs = message.created_at ? new Date(message.created_at).getTime() : 0;
      return createdAtMs > processedThroughMs;
    });
    if (unprocessedMessages.length === 0) continue;

    const sortedUnprocessed = unprocessedMessages.sort(
      (a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime()
    );
    // Track the latest message timestamp so batch markers store message time,
    // not insertion time — prevents future messages from being permanently excluded.
    const lastMessageMs = Math.max(
      ...sortedUnprocessed.map((m) => (m.created_at ? new Date(m.created_at).getTime() : 0))
    );

    // Build a set of telegram_message_ids present in this batch so we can detect cross-batch replies.
    const batchTelegramMsgIds = new Set(
      sortedUnprocessed.map((m) => (m.telegram_message_id != null ? String(m.telegram_message_id) : "")).filter(Boolean)
    );

    // ── Step 1: classify each message individually and apply reply context ──────────────────────
    // Each message gets its own intent so that a batch containing BOTH "do you have GH accounts?"
    // (General) AND "please share 123 to BM 456" (Share) produces two separate tickets and two
    // separate sections in Mark's summary, rather than one ticket that picks only the dominant intent.
    type PerMessageItem = {
      message: QueuedMessage;
      text: string;
      category: typeof CATEGORY_ORDER[number];
      intent: string;
    };

    // Pre-scan: does this chat's batch contain any photo at all?
    // Used below to detect "photo sent separately + please check as text" — a very common
    // pattern where the client sends the payment receipt as a photo, then types "please check"
    // in a follow-up message. Without this flag the text message is classified as a fragment
    // and held, the photo is never forwarded, and the client gets no reply.
    const chatBatchHasPhoto = sortedUnprocessed.some((m) => getPhotoFileId(m) !== null);

    const perMessageItems: PerMessageItem[] = [];
    for (const message of sortedUnprocessed) {
      const rawText = preserveBatchText(message.message_text ?? "");
      // Detect cross-batch replies: client replied to a message from a previous batch window.
      const replyTo = getReplyToMessage(message);
      const replyText = getReplyText(replyTo);
      const replyTargetId = replyTo?.message_id != null ? String(replyTo.message_id) : null;
      const isCrossBatchReply = Boolean(replyText && replyTargetId && !batchTelegramMsgIds.has(replyTargetId));
      const text = isCrossBatchReply && rawText ? `Re: "${replyText}"\n${rawText}` : rawText;

      // Photo messages with no real caption (just the bot's placeholder) should NOT be
      // classified on their own — the placeholder "Image/screenshot sent by client." contains
      // the word "sent" which falsely triggers deposit detection and creates a duplicate
      // "deposit sent, please check" ticket alongside the real "sent 50K" ticket.
      // We skip them here; their file_id is collected later during grouping.
      const isPhotoWithoutCaption = message.message_type === "client_photo" &&
        (!text || /^image\/screenshot sent by client\.?$/i.test(text.trim()));
      if (isPhotoWithoutCaption) continue;

      if (!text || isPureNonSupportChatter(text)) continue;

      const singleClassification = classifyIntent(text);
      // Photo messages with a short payment-related caption ("please check", "sent", etc.)
      // are complete deposit requests — the photo IS the proof. Without this override the
      // classifier returns general_support and the message gets held as a fragment, so the
      // photo never reaches Mark and the client never gets a reply.
      const isPhotoMessage = message.message_type === "client_photo";
      // "isPaymentCaption" — short caption that appears ON a photo message (the photo IS the proof).
      const isPaymentCaption = /^(please\s*check|pls\s*check|check\s*please|check|sent|paid|deposit|please|pls|done)\.?!?$/i.test(text.trim());
      // "isClearDepositCaption" — only unambiguous deposit signals like "sent", "paid", "deposit".
      // "check" / "please check" alone are NOT clear deposit signals — a client could send
      // an account screenshot and write "please check" beneath it. Without image AI we can't
      // tell what the photo contains, so we classify on the text alone and let Mark look at the photo.
      const isClearDepositCaption = /^(sent|paid|deposit|payment\s*proof|proof|transferred|transfer|done)\.?!?$/i.test(text.trim());
      // Override to deposit_funds when:
      // (a) the caption is ON the photo itself (isPhotoMessage + any payment word), OR
      // (b) the text is an UNAMBIGUOUS deposit signal AND this chat's batch already contains a photo.
      //     "please check" alone is too ambiguous — it goes to normal classification instead.
      const effectiveIntent = ((isPhotoMessage && isPaymentCaption) || (chatBatchHasPhoto && isClearDepositCaption))
        ? "deposit_funds"
        : singleClassification.intent;
      const category = mapIntentToCategory(effectiveIntent);
      perMessageItems.push({ message, text, category, intent: effectiveIntent });
    }

    // ── Step 2: handle all-chatter case (greetings, non-support) ───────────────────────────────
    if (perMessageItems.length === 0) {
      console.log("non-request-message-skipped", { chatId, messageCount: unprocessedMessages.length });
      const messageTexts = unprocessedMessages.map((m) => compactText(m.message_text ?? "")).filter(Boolean);
      if (messageTexts.some(isGreetingText)) {
        const reply = chooseGreetingReply(sortedUnprocessed);
        const greetingResult = await maybeSendTelegramMessage({ chatId, text: reply, source: "telegram_batch" });
        await markChatBatchProcessed(supabase, chatId, "batch_client_greeting", reply, greetingResult.telegramMessageId, lastMessageMs);
        console.log("client-greeting-sent", { chatId, messageCount: unprocessedMessages.length });
      } else {
        await markChatBatchProcessed(supabase, chatId, "batch_non_request_skipped", "non-support chatter skipped", null, lastMessageMs);
      }
      continue;
    }

    // ── Step 3: group consecutive messages that share the same category ─────────────────────────
    // Consecutive messages belonging to the same category are merged (e.g. two lines of a share
    // request). A category switch starts a new group (e.g. General → Share → General).
    // Special rules:
    // - A URL-only message (e.g. an Etherscan link following "sent 30K") inherits the previous
    //   group's category so the link stays with the deposit, not General.
    // - Within the General category, consecutive messages are only merged when they share the
    //   same intent. A site-issue message followed by a monthly-report question are two separate
    //   topics — grouping them into one ticket would cause chooseClientReply to pick only one
    //   topic's reply and silently ignore the other.
    type MessageGroup = { texts: string[]; messages: QueuedMessage[]; category: typeof CATEGORY_ORDER[number]; intent: string };
    const messageGroups: MessageGroup[] = [];
    const chatPhotoForwards: PhotoForward[] = [];
    const chatDepositLinkUpdates: DepositLinkUpdate[] = [];

    for (const item of perMessageItems) {
      const lastGroup = messageGroups[messageGroups.length - 1];
      // URL-only messages (Etherscan links etc.) belong to whatever came before them.
      const effectiveCategory = (lastGroup && isUrlOnlyText(item.text)) ? lastGroup.category : item.category;
      // Messages sent within 3 minutes of each other are almost certainly about the same issue
      // (e.g. "your site is down?" then "cant seem to log in" as two separate messages).
      // Merge them regardless of intent difference so only one ticket is created.
      const lastMsgTime = lastGroup?.messages.at(-1)?.created_at ? new Date(lastGroup.messages.at(-1)!.created_at!).getTime() : 0;
      const currMsgTime = item.message.created_at ? new Date(item.message.created_at).getTime() : 0;
      const sentWithinWindow = lastMsgTime > 0 && currMsgTime > 0 && (currMsgTime - lastMsgTime) < 3 * 60 * 1000;
      const sameGroup = lastGroup && lastGroup.category === effectiveCategory
        // For General, also require the same intent so different questions (site-down vs monthly
        // report) get separate tickets — unless they were sent within 3 min (same burst = same issue).
        && (effectiveCategory !== "General" || lastGroup.intent === item.intent || sentWithinWindow);
      if (sameGroup) {
        lastGroup.texts.push(item.text);
        lastGroup.messages.push(item.message);
      } else {
        messageGroups.push({ texts: [item.text], messages: [item.message], category: effectiveCategory, intent: item.intent });
      }
    }

    // Collect photos from ALL messages in this batch (including caption-less photo messages
    // that were excluded from classification). Forward to Mark as follow-ups after the text
    // summary — each photo gets a caption showing the client group name and the category of
    // their request so employees immediately know whose screenshot it is and what it's about.
    const chatHasDeposit = messageGroups.some((g) => g.category === "Deposits");
    for (const message of sortedUnprocessed) {
      const photoFileId = getPhotoFileId(message);
      if (photoFileId) {
        // Find which classified group this photo message belongs to so we can pull
        // the request text and category. Caption-less photo messages won't appear in
        // perMessageItems, so fall back to the group that contains this message (if any),
        // then to chat-level deposit flag or General.
        const matchedItem = perMessageItems.find((item) => item.message.id === message.id);
        const matchedGroup = messageGroups.find((g) => g.messages.some((m) => m.id === message.id));
        const photoCategory = matchedItem?.category ?? matchedGroup?.category ?? (chatHasDeposit ? "Deposits" : "General");
        // Deposit photos are handled manually — the client gets an ack reply but Mark does NOT
        // receive the photo or any ticket for it.
        if (photoCategory === "Deposits") {
          console.log("deposit-photo-skipped-no-forward", { chatId });
          continue;
        }
        // Build a short request description from the client's own words (no client name).
        // Use the matched item's text first, then the first text in the group, then empty.
        const rawSummary = matchedItem?.text ?? matchedGroup?.texts[0] ?? "";
        // Trim to 80 chars so the caption stays readable on mobile.
        const requestSummary = rawSummary.length > 80 ? rawSummary.slice(0, 77) + "…" : rawSummary;
        chatPhotoForwards.push({ fileId: photoFileId, category: photoCategory, requestSummary, chatId });
      }
    }

    // ── Step 4: create one ticket per category group ────────────────────────────────────────────
    const duplicateStartIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let ticketsCreatedForChat = 0;
    let hasRealTickets = false; // true only when a non-deposit ticket is actually inserted in DB

    for (const group of messageGroups) {
      const groupedText = preserveBatchText(group.texts.join("\n"));
      if (!groupedText) continue;

      if (!hasRequestSignal(groupedText)) {
        console.log("unclear-batch-forwarded-as-general", { chatId, category: group.category });
      }

      // Skip fragment check when the group includes a photo — the photo is the substance,
      // so a short caption like "please check" or "sent" is NOT incomplete in this context.
      const groupHasPhoto = group.messages.some((m) => getPhotoFileId(m) !== null);
      // Also skip hold when a photo exists in this chat's batch AND the text is a short payment
      // caption — client sent a photo (deposit proof, account screenshot, etc.) as a separate
      // message and typed a brief caption. The photo provides the substance; we should not hold
      // the text as a fragment. It will classify on its own text (General if ambiguous, Deposits
      // if a clear deposit signal), create a ticket, and Mark will see the forwarded photo.
      const groupHasPaymentCaption = group.texts.some((t) =>
        /^(please\s*check|pls\s*check|check\s*please|check|sent|paid|deposit|please|pls|done)\.?!?$/i.test(t.trim())
      );
      const fragmentExemptDueToPhoto = chatBatchHasPhoto && groupHasPaymentCaption;
      if (isIncompleteRequestFragment(groupedText) && !groupHasPhoto && !fragmentExemptDueToPhoto) {
        console.log("support-fragment-held-for-next-batch", { chatId, groupedText });
        continue;
      }

      console.log("grouped-message-created", { chatId, category: group.category, messageCount: group.messages.length });
      const linkedContext = await findFollowUpContext(supabase, chatId, group.messages, groupedText);
      const isLinkedFollowUp = Boolean(linkedContext && isFollowUpText(groupedText));
      // Never pass previousContext to the base classification.
      // If we did (e.g. linkedContext.originalMessage = "sent 50K" from a previous deposit),
      // classifyIntent would combine that old deposit text with the current message, causing
      // hasDepositPriority() to fire and override the real intent — e.g. a site-down question
      // would be misclassified as deposit_funds. The linkedContext is used AFTER classification
      // to enrich the ticket's metadata, not to influence what the message is about.
      const baseClassification = classifyIntent(groupedText);
      const classification = linkedContext
        ? isLinkedFollowUp
          ? withFollowUpContext(baseClassification, groupedText, linkedContext)
          : {
              ...baseClassification,
              extractedData: {
                ...extractedObject(baseClassification.extractedData),
                linkedOriginalSummary: linkedContext.originalSummary,
                linkedOriginalMessage: linkedContext.originalMessage,
                linkedTicketId: linkedContext.linkedTicketId,
                linkedClientMessageId: linkedContext.linkedClientMessageId,
                replyToTelegramMessageId: linkedContext.replyToTelegramMessageId,
                replyToMessageText: linkedContext.replyToMessageText
              },
              internalSummary: `${baseClassification.internalSummary} Linked context: ${linkedContext.originalSummary}.`
            }
        : baseClassification;

      const storedClientMessage = linkedContext ? buildFollowUpTicketMessage(groupedText, linkedContext) : groupedText;

      if (!classification.requiresMark || classification.intent === "no_action") {
        console.log("non-request-group-skipped", { chatId, category: group.category, intent: classification.intent });
        continue;
      }

      // Deposits go to master group only — NOT to Mark's normal batch summary.
      // We still create a ticket so the deposit appears in the activity dashboard.
      // internal_message_id stays null so employee replies to the batch never
      // accidentally forward to a deposit-only client group.
      if (classification.intent === "deposit_funds") {
        ticketsCreatedForChat++;
        chatDuplicateIntents.set(chatId, [...(chatDuplicateIntents.get(chatId) ?? []), "deposit_funds"]);
        const depositPhotoFileId = group.messages
          .map((msg) => getPhotoFileId(msg))
          .find((id) => id !== null) ?? null;
        const depositLastMsg = group.messages[group.messages.length - 1];
        allDepositForwards.push({
          clientChatId: chatId,
          clientTitle: getChatTitle(depositLastMsg ?? sortedUnprocessed[sortedUnprocessed.length - 1]!),
          originalMessage: groupedText,
          photoFileId: depositPhotoFileId
        });
        // Create ticket for dashboard visibility (not added to createdTickets so it
        // is excluded from Mark's batch summary — master handles deposits, not Mark).
        if (depositLastMsg) {
          const { data: existingDeposit } = await supabase
            .from("tickets")
            .select("id")
            .eq("client_chat_id", chatId)
            .eq("client_original_message", groupedText)
            .gte("created_at", duplicateStartIso)
            .limit(1)
            .maybeSingle();
          if (!existingDeposit?.id) {
            await supabase.from("tickets").insert({
              ticket_code: createTicketCode(),
              client_chat_id: chatId,
              client_message_id: depositLastMsg.id ?? null,
              client_username: getUsername(depositLastMsg),
              intent: "deposit_funds",
              status: "waiting_mark",
              priority: "high",
              needs_mark: false,
              client_original_message: groupedText,
              extracted_data: { chatTitle: getChatTitle(depositLastMsg) ?? null },
              internal_summary: `Deposit notification. ${groupedText.slice(0, 200)}`,
              holding_message_id: null,
              internal_message_id: null,
            });
            console.log("deposit-ticket-created", { chatId, hasPhoto: Boolean(depositPhotoFileId) });
          }
        }
        continue;
      }

      const { data: duplicateTicketData, error: duplicateError } = await supabase
        .from("tickets")
        .select("id")
        .eq("client_chat_id", chatId)
        .eq("client_original_message", storedClientMessage)
        .gte("created_at", duplicateStartIso)
        .limit(1)
        .maybeSingle();
      if (duplicateError) throw new Error(`Supabase duplicate ticket query failed: ${duplicateError.message}`);
      const duplicateTicket = duplicateTicketData as { id: string } | null;
      if (duplicateTicket?.id) {
        console.log("duplicate-batch-prevented", { chatId, ticketId: duplicateTicket.id });
        ticketsCreatedForChat++; // count as handled so we don't add a spurious skip marker
        // Track the intent so duplicate-only chats can still receive a client reply.
        chatDuplicateIntents.set(chatId, [...(chatDuplicateIntents.get(chatId) ?? []), classification.intent ?? "general_support"]);
        continue;
      }

      const latestGroupMessage = group.messages[group.messages.length - 1];
      if (!latestGroupMessage) continue;
      const messageTime = getTelegramMessageDate(latestGroupMessage);

      // ── Split-deposit link detection ─────────────────────────────────────────────────────────
      // Client sometimes sends "sent 30K" in one message, then the Etherscan/blockchain URL in
      // a separate message (next batch). When the URL arrives, the original deposit ticket is
      // already stamped with internal_message_id (sent to Mark), so it's excluded from
      // pendingTickets. Mark never sees the link. Fix: detect URL-only deposit messages and
      // send Mark a targeted follow-up instead of creating a redundant second ticket.
      if (classification.intent === "deposit_funds") {
        const isUrlOnly = /^\s*https?:\/\/\S+\s*$/.test(groupedText);
        if (isUrlOnly) {
          const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const { data: sentDepositData } = await supabase
            .from("tickets")
            .select("id, internal_message_id")
            .eq("client_chat_id", chatId)
            .eq("intent", "deposit_funds")
            .not("internal_message_id", "is", null)
            .gte("created_at", oneDayAgo)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          const sentDeposit = sentDepositData as { id: string; internal_message_id: string | number | null } | null;
          if (sentDeposit?.id) {
            // Original deposit was already sent to Mark — queue a follow-up link notification.
            chatDepositLinkUpdates.push({
              chatTitle: getChatTitle(latestGroupMessage) ?? chatId,
              url: groupedText.trim(),
              ticketId: sentDeposit.id,
              chatId
            });
            ticketsCreatedForChat++; // count as handled — client will get ack reply
            chatDuplicateIntents.set(chatId, [...(chatDuplicateIntents.get(chatId) ?? []), "deposit_funds"]);
            console.log("deposit-link-update-queued", { chatId, ticketId: sentDeposit.id });
            continue; // skip creating a redundant second ticket
          }
        }
      }
      // ────────────────────────────────────────────────────────────────────────────────────────

      const { data: createdTicketData, error: createTicketError } = await supabase
        .from("tickets")
        .insert({
          ticket_code: createTicketCode(),
          client_chat_id: chatId,
          client_message_id: latestGroupMessage.id ?? null,
          client_user_id: null,
          client_username: getUsername(latestGroupMessage),
          intent: classification.intent,
          status: "waiting_mark",
          priority: ["deposit_funds", "refund_request", "payment_issue", "check_policy"].includes(classification.intent) ? "high" : "normal",
          needs_mark: true,
          client_original_message: storedClientMessage,
          extracted_data: { ...extractedObject(classification.extractedData), chatTitle: getChatTitle(latestGroupMessage) ?? null },
          internal_summary: classification.internalSummary,
          holding_message_id: null,
          internal_message_id: null,
          created_at: messageTime.toISOString(),
          updated_at: messageTime.toISOString()
        })
        .select("id, intent, client_chat_id, client_message_id, client_original_message, extracted_data, internal_summary, created_at")
        .single();
      const createdTicket = createdTicketData as BatchTicket | null;
      if (createTicketError || !createdTicket?.id) {
        throw new Error(`Supabase tickets insert failed: ${createTicketError?.message ?? "Unknown error"}`);
      }

      try {
        const sheetActions = getActions(classification.extractedData);
        const sheetRows = sheetActions.length > 0 ? sheetActions : [null];
        for (const action of sheetRows) {
          const extractedData = action ? { ...classification.extractedData, actions: [action] } : classification.extractedData;
          await writeClientRequestRowToGoogleSheet({
            telegramGroup: getChatTitle(latestGroupMessage),
            username: getUsername(latestGroupMessage),
            originalMessage: storedClientMessage,
            parsedMessage: action ? cleanActionTaskText(createdTicket, action) : classification.internalSummary || groupedText,
            intent: action ? actionTypeToIntent(action) : classification.intent,
            status: "Pending",
            extractedData,
            now: messageTime
          });
        }
        console.log("google-sheets-row-write-success", { chatId, ticketId: createdTicket.id });
      } catch (error) {
        console.log("google-sheets-write-failed", {
          chatId,
          ticketId: createdTicket.id,
          error: error instanceof Error ? error.message : "Google Sheets write failed."
        });
      }

      console.log("request-added-to-mark-batch", { chatId, ticketId: createdTicket.id, intent: classification.intent });
      createdTickets.push(createdTicket as BatchTicket);
      ticketsCreatedForChat++;
      hasRealTickets = true;
    }

    // Write a marker when no real DB ticket was created (deposit-only, deposit link, duplicate-only,
    // or no-action batches) so processedThroughMs advances and the same messages aren't re-processed.
    if (!hasRealTickets) {
      await markChatBatchProcessed(supabase, chatId, "batch_non_request_skipped", "deposit-ack or no-action batch", null, lastMessageMs);
    }

    // Accumulate photo forwards for this chat (only when at least one ticket was created,
    // so we don't spam Mark with photos from non-support messages).
    if (ticketsCreatedForChat > 0) {
      allPhotoForwards.push(...chatPhotoForwards);
      allDepositLinkUpdates.push(...chatDepositLinkUpdates);
    }
    } catch (chatError) {
      // Per-chat isolation: one failing chat must not block other chats from being processed.
      // Without this, a single bad query (e.g. a duplicate ticket race, a sheets API hiccup)
      // would silently kill the rest of the batch — symptoms exactly like BluePeak / NovaAds
      // never getting a reply while Client Test Group did.
      const errorMessage = chatError instanceof Error ? chatError.message : "unknown error";
      console.error("chat-batch-failed", {
        chatId,
        error: errorMessage,
        stack: chatError instanceof Error ? chatError.stack : undefined
      });
      chatErrors.push({ chatId, error: errorMessage });
    }
  }

  return { tickets: createdTickets, photoForwards: allPhotoForwards, depositLinkUpdates: allDepositLinkUpdates, depositForwards: allDepositForwards, chatErrors, chatDuplicateIntents };
}

async function handleBatch(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  console.log("mark-batch-start");

  requireEnv("TELEGRAM_BOT_TOKEN", ["TELEGRAM_BOT_TOKEN"]);
  // markGroupChatId is optional when multi-agency routing is configured in Supabase.
  // Validated below after we know whether DB routing is active.
  const markGroupChatId = firstEnv(["MARK_GROUP_CHAT_ID", "MARK_INTERNAL_CHAT_ID"]) ?? "";
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL", ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]);
  const serviceRoleKey = requireEnv("SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY", ["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);

  const supabase = createClient<Database, "public">(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  // ── Load multi-agency routing data ─────────────────────────────────────────────
  // mark_groups: each agency has a name and its own Telegram group chat ID.
  // client_groups: maps each client's telegram_chat_id to an agency (mark_group_id).
  // When no assignments exist in the DB the bot falls back to the single markGroupChatId env var.
  const [{ data: markGroupsData }, { data: clientGroupAssignments }] = await Promise.all([
    supabase.from("mark_groups").select("id, name, telegram_chat_id"),
    supabase.from("client_groups").select("telegram_chat_id, mark_group_id").not("mark_group_id", "is", null)
  ]);
  const markGroupById = new Map(
    (markGroupsData ?? []).map((mg) => [mg.id, { name: mg.name, telegramChatId: mg.telegram_chat_id }])
  );
  // clientRoutingMap: clientChatId (string) → agency Telegram chat ID (string)
  const clientRoutingMap = new Map<string, string>();
  for (const cg of (clientGroupAssignments ?? [])) {
    if (!cg.mark_group_id) continue;
    const agency = markGroupById.get(cg.mark_group_id);
    if (agency) clientRoutingMap.set(String(cg.telegram_chat_id), agency.telegramChatId);
  }
  const useMultiAgency = clientRoutingMap.size > 0;
  // Build a set of all agency Telegram chat IDs so we can exclude their messages from
  // client processing. Sources: mark_groups table, client_groups with group_type='agency',
  // and the legacy MARK_GROUP_CHAT_ID env var.
  const [{ data: agencyTypeGroups }, { data: masterGroupsData }] = await Promise.all([
    supabase.from("client_groups").select("telegram_chat_id").eq("group_type", "agency"),
    supabase.from("client_groups").select("telegram_chat_id").eq("group_type", "master")
  ]);
  const masterChatIds = (masterGroupsData ?? []).map((mg) => String(mg.telegram_chat_id)).filter(Boolean);
  const masterChatIdSet = new Set<string>(masterChatIds);
  const agencyChatIds = new Set<string>([
    ...Array.from(markGroupById.values()).map((mg) => String(mg.telegramChatId)),
    ...(agencyTypeGroups ?? []).map((ag) => String(ag.telegram_chat_id)),
    ...(markGroupChatId ? [markGroupChatId] : [])
  ]);
  console.log("routing-loaded", { useMultiAgency, agencyCount: markGroupById.size, assignedClients: clientRoutingMap.size, agencyChatIds: agencyChatIds.size });

  const batchCutoffIso = new Date(Date.now() - BATCH_DELAY_MINUTES * 60 * 1000).toISOString();
  const messageStartIso = new Date(Date.now() - MESSAGE_LOOKBACK_MINUTES * 60 * 1000).toISOString();
  const { data: queuedMessagesData, error: queuedMessagesError } = await supabase
    .from("messages")
    .select("id, created_at, telegram_chat_id, telegram_message_id, telegram_username, message_text, message_type, raw_payload")
    .gte("created_at", messageStartIso)
    .lte("created_at", batchCutoffIso)
    .in("message_type", ["client", "client_photo"])
    .order("created_at", { ascending: true })
    .limit(500);
  if (queuedMessagesError) throw new Error(`Supabase queued messages query failed: ${queuedMessagesError.message}`);

  // Filter out agency and master group messages — those are internal/operator groups,
  // never client request sources.
  const clientMessages = (queuedMessagesData ?? []).filter((msg) => {
    const id = String((msg as { telegram_chat_id?: unknown }).telegram_chat_id ?? "");
    return !agencyChatIds.has(id) && !masterChatIdSet.has(id);
  }) as unknown as QueuedMessage[];
  console.log("agency-messages-filtered", { total: (queuedMessagesData ?? []).length, afterFilter: clientMessages.length });

  // ── Gemini photo enrichment ───────────────────────────────────────────────────────────────────
  // For every photo message whose caption is ambiguous ("please check", no text, etc.), ask
  // Gemini Vision whether the image is a payment proof. If yes, prepend "payment proof sent"
  // to message_text so the classifier routes it to master (deposit) instead of the agency.
  const geminiKey = process.env.GEMINI_API_KEY_2;
  const botTokenForPhoto = firstEnv(["TELEGRAM_BOT_TOKEN"]) ?? "";
  if (geminiKey) {
    const photoEnrichPromises = clientMessages
      .filter((msg) => {
        const fileId = getPhotoFileId(msg as unknown as QueuedMessage);
        if (!fileId) return false;
        const caption = (msg as unknown as QueuedMessage).message_text ?? "";
        // Skip if caption already has clear deposit signals — no need to call Gemini
        const alreadyClear = /\b(sent|paid|deposit|payment\s*proof|transferred|transfer)\b/i.test(caption);
        return !alreadyClear;
      })
      .map(async (msg) => {
        const fileId = getPhotoFileId(msg as unknown as QueuedMessage)!;
        const description = await analyzePhotoWithGemini(fileId, botTokenForPhoto, geminiKey);
        if (description) {
          const existing = (msg as unknown as QueuedMessage).message_text ?? "";
          (msg as unknown as { message_text: string }).message_text = description + (existing ? ` ${existing}` : "");
        }
      });
    await Promise.all(photoEnrichPromises);
  }

  const { tickets: createdTickets, photoForwards, depositLinkUpdates, depositForwards, chatErrors, chatDuplicateIntents } = await createTicketsFromQueuedMessages(supabase, clientMessages, clientRoutingMap);
  if (chatErrors.length > 0) {
    console.error("batch-had-chat-errors", { count: chatErrors.length, errors: chatErrors });
  }

  const { data, error } = await supabase
    .from("tickets")
    .select("id, intent, client_chat_id, client_original_message, extracted_data, internal_summary, created_at, holding_message_id")
    .eq("needs_mark", true)
    .in("status", ["open", "new", "waiting_mark", "waiting_for_mark"])
    .is("internal_message_id", null)
    .lte("created_at", batchCutoffIso)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw new Error(`Supabase tickets batch query failed: ${error.message}`);

  const pendingTickets = (data ?? []) as BatchTicket[];
  const seenTicketIds = new Set(createdTickets.map((ticket) => ticket.id));
  const tickets = [
    ...createdTickets,
    ...pendingTickets.filter((ticket) => !seenTicketIds.has(ticket.id))
  ];
  console.log("mark-batch-found-requests", { count: tickets.length });

  if (tickets.length === 0 && depositLinkUpdates.length === 0 && chatDuplicateIntents.size === 0) {
    console.log("mark-batch-no-requests");
    return NextResponse.json({ ok: true, count: 0 });
  }

  // ── Multi-agency routing ────────────────────────────────────────────────────────
  // Maps each ticket / photo / deposit update to the correct agency Mark group.
  // When no routing is configured in Supabase (clientRoutingMap empty), all traffic
  // goes to markGroupChatId (the legacy single-agency env var).
  if (!useMultiAgency && !markGroupChatId) {
    throw new Error("Missing environment variable: MARK_GROUP_CHAT_ID or MARK_INTERNAL_CHAT_ID (required when no agency routing is configured in Supabase)");
  }

  const getAgencyChatId = (clientChatId: string | number | null): string => {
    const id = String(clientChatId ?? "");
    if (clientRoutingMap.size > 0) return clientRoutingMap.get(id) ?? "";
    return markGroupChatId;
  };

  // Collect the full set of agency chat IDs that have work in this batch.
  const activeAgencies = new Set<string>();
  for (const ticket of tickets) {
    const agency = getAgencyChatId(ticket.client_chat_id);
    if (agency) activeAgencies.add(agency);
  }
  for (const photo of photoForwards) {
    const agency = getAgencyChatId(photo.chatId);
    if (agency) activeAgencies.add(agency);
  }
  for (const update of depositLinkUpdates) {
    const agency = getAgencyChatId(update.chatId);
    if (agency) activeAgencies.add(agency);
  }

  console.log("mark-batch-ready", { count: tickets.length, agencies: activeAgencies.size });

  // ── Send one summary per agency, stamp tickets, forward photos ─────────────────
  let totalSentToMark = 0;

  for (const agencyChatId of activeAgencies) {
    const agencyTickets = tickets.filter((t) => getAgencyChatId(t.client_chat_id) === agencyChatId);
    const agencyPhotos = photoForwards.filter((p) => getAgencyChatId(p.chatId) === agencyChatId);
    const agencyDepositUpdates = depositLinkUpdates.filter((u) => getAgencyChatId(u.chatId) === agencyChatId);

    // If this agency only has deposit link follow-ups (no tickets), send them and move on.
    if (agencyTickets.length === 0) {
      for (const update of agencyDepositUpdates) {
        try {
          const updateText = `🔗 Deposit link received — ${escapeTelegramHtml(update.chatTitle)}\n${update.url}`;
          await maybeSendTelegramMessage({ chatId: agencyChatId, text: updateText, source: "telegram_batch" });
          console.log("deposit-link-update-sent-to-mark", { ticketId: update.ticketId, agencyChatId });
        } catch (err) {
          console.error("deposit-link-update-failed", { error: err instanceof Error ? err.message : "unknown" });
        }
      }
      continue;
    }

    // Build and send the batch summary for this agency.
    const markSummary = buildMarkSummary(agencyTickets);
    const markSendResult = await maybeSendTelegramMessage({ chatId: agencyChatId, text: markSummary, source: "telegram_batch" });
    if (!markSendResult.sent || !markSendResult.telegramMessageId) {
      console.error("mark-batch-summary-not-sent", { agencyChatId, reason: markSendResult.reason });
      continue;
    }
    console.log("mark-batch-sent", { count: agencyTickets.length, agencyChatId, telegramMessageId: markSendResult.telegramMessageId });
    totalSentToMark += agencyTickets.length;

    await supabase.from("bot_responses").insert({
      ticket_id: agencyTickets[0]?.id ?? null,
      telegram_chat_id: agencyChatId,
      telegram_message_id: markSendResult.telegramMessageId,
      response_type: "batch_mark_summary",
      response_text: markSummary
    });

    // Forward photos for this agency after the text summary.
    // No client name in caption — employees match the photo to the right bullet in the summary.
    for (const photo of agencyPhotos) {
      try {
        const categoryLabel = photo.category === "Deposits" ? "Deposit screenshot" : `${photo.category} screenshot`;
        const caption = photo.requestSummary ? `📸 ${categoryLabel} — ${photo.requestSummary}` : `📸 ${categoryLabel}`;
        await maybeSendTelegramPhoto({ chatId: agencyChatId, fileId: photo.fileId, caption, source: "telegram_batch" });
        console.log("photo-forwarded-to-mark", { category: photo.category, agencyChatId });
      } catch (err) {
        console.error("photo-forward-failed", { error: err instanceof Error ? err.message : "unknown" });
      }
    }

    // Send deposit link follow-ups for this agency — blockchain URLs that arrived in a
    // separate batch after the original deposit message was already forwarded to Mark.
    for (const update of agencyDepositUpdates) {
      try {
        const updateText = `🔗 Deposit link received — ${escapeTelegramHtml(update.chatTitle)}\n${update.url}`;
        await maybeSendTelegramMessage({ chatId: agencyChatId, text: updateText, source: "telegram_batch" });
        console.log("deposit-link-update-sent-to-mark", { ticketId: update.ticketId, agencyChatId });
      } catch (err) {
        console.error("deposit-link-update-failed", { error: err instanceof Error ? err.message : "unknown" });
      }
    }

    // Stamp every ticket for this agency with their summary's Telegram message_id.
    // The webhook uses this per-agency ID to find all tickets when an employee replies.
    for (const ticket of agencyTickets) {
      const { data: processedTicket, error: updateError } = await supabase
        .from("tickets")
        .update({ internal_message_id: markSendResult.telegramMessageId, updated_at: new Date().toISOString() })
        .eq("id", ticket.id)
        .is("internal_message_id", null)
        .select("id");
      if (updateError) {
        console.error("supabase-update-error", { table: "tickets", ticketId: ticket.id, message: updateError.message });
        continue;
      }
      if (!processedTicket || processedTicket.length === 0) {
        console.log("duplicate-batch-prevented", { ticketId: ticket.id });
        continue;
      }
      console.log("mark-batch-request-marked-sent", { ticketId: ticket.id });
    }
  }

  // ── Client replies (agency-independent — sent directly to each client chat) ─────
  // Driven ONLY by tickets created in THIS batch run. Old pending tickets were already
  // replied to in their own batch — re-sending would spam the client.
  const ticketsByClient = new Map<string, BatchTicket[]>();
  for (const ticket of createdTickets) {
    if (!ticket.client_chat_id || ticket.holding_message_id) continue;
    const key = String(ticket.client_chat_id);
    ticketsByClient.set(key, [...(ticketsByClient.get(key) ?? []), ticket]);
  }

  // Chats where every message was a duplicate still need a reply so the client isn't left waiting.
  // Synthesise a minimal ticket-like entry per duplicate chat so it enters the reply loop.
  for (const [dupChatId, intents] of chatDuplicateIntents.entries()) {
    if (ticketsByClient.has(dupChatId)) continue;
    ticketsByClient.set(dupChatId, intents.map((intent, i) => ({
      id: `dup-${dupChatId}-${i}`,
      intent,
      client_chat_id: dupChatId,
      client_original_message: null,
      extracted_data: null,
      internal_summary: null,
      created_at: null,
      holding_message_id: null
    })));
    console.log("duplicate-only-chat-queued-for-reply", { dupChatId, intents });
  }

  let clientReplyCount = 0;
  for (const [clientChatId, clientTickets] of ticketsByClient.entries()) {
    try {
      const clientReply = chooseClientReply(clientTickets);
      const clientSendResult = await maybeSendTelegramMessage({ chatId: clientChatId, text: clientReply, source: "telegram_batch" });
      clientReplyCount += 1;

      // Synthetic duplicate-only tickets have ids like "dup-chatId-0" — not real DB rows.
      const realTickets = clientTickets.filter((t) => !t.id.startsWith("dup-"));
      const firstRealId = realTickets[0]?.id ?? null;

      await supabase.from("bot_responses").insert({
        ticket_id: firstRealId,
        telegram_chat_id: clientChatId,
        telegram_message_id: clientSendResult.telegramMessageId,
        response_type: "batch_client_reply",
        response_text: clientReply
      });

      if (realTickets.length > 0) {
        await supabase
          .from("tickets")
          .update({ holding_message_id: clientSendResult.telegramMessageId, updated_at: new Date().toISOString() })
          .in("id", realTickets.map((ticket) => ticket.id))
          .is("holding_message_id", null);
      }
      console.log("client-ack-sent", { clientChatId, ticketCount: clientTickets.length, realTicketCount: realTickets.length });
    } catch (error) {
      console.error("telegram-batch-client-reply-error", {
        clientChatId,
        error: error instanceof Error ? error.message : "Client batch reply failed."
      });
    }
  }

  // ── Forward deposits to master group(s) ───────────────────────────────────────
  // Master groups receive ALL deposit notifications: text, photos, blockchain links.
  // Nothing else is forwarded here — only deposit_funds intent messages.
  if (masterChatIds.length > 0 && depositForwards.length > 0) {
    for (const masterChatId of masterChatIds) {
      for (const fwd of depositForwards) {
        try {
          const header = `💰 <b>Deposit</b> · ${escapeTelegramHtml(fwd.clientTitle)}`;
          const body = escapeTelegramHtml(fwd.originalMessage);
          if (fwd.photoFileId) {
            const caption = `${header}\n\n${body}`.slice(0, 1024);
            await maybeSendTelegramPhoto({ chatId: masterChatId, fileId: fwd.photoFileId, caption, source: "telegram_batch" });
          } else {
            await maybeSendTelegramMessage({ chatId: masterChatId, text: `${header}\n\n${body}`, source: "telegram_batch" });
          }
          console.log("deposit-forwarded-to-master", { masterChatId, clientChatId: fwd.clientChatId, hasPhoto: Boolean(fwd.photoFileId) });
        } catch (err) {
          console.error("deposit-master-forward-failed", { error: err instanceof Error ? err.message : "unknown" });
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    count: totalSentToMark,
    agencies: activeAgencies.size,
    masterForwards: depositForwards.length,
    clientGroups: clientReplyCount,
    chatErrors: chatErrors.length > 0 ? chatErrors : undefined
  });
}

export async function GET(request: Request) {
  try {
    return await handleBatch(request);
  } catch (error) {
    console.error("telegram-batch-error", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unexpected telegram batch error." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
