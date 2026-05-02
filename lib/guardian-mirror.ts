import { classifyIntent } from "./intent-classifier";

const EMOJI_ONLY_PATTERN = /^[\s\u{1F44D}\u2764\uFE0F\u2705\u{1F64F}]+$/u;

function joinList(values: unknown): string {
  if (!Array.isArray(values)) return "";
  return values.map(String).filter(Boolean).join(", ");
}

function toStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map(String).filter(Boolean);
}

function uniqueValues(values: string[]): string[] {
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

function removeDuplicateValues(primary: string[], valuesToRemove: string[]): string[] {
  const blocked = new Set(valuesToRemove.map((value) => value.toLowerCase()));
  return primary.filter((value) => !blocked.has(value.toLowerCase()));
}

function splitLabeledValues(rawValue: string): string[] {
  return rawValue
    .split(/(?:,|\n|\s+and\s+|\s*&\s*)/i)
    .map((value) => value.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9_-]+$/g, ""))
    .filter(Boolean);
}

function extractAfterLabels(message: string, pattern: RegExp): string[] {
  const values: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(message)) !== null) {
    values.push(...splitLabeledValues(match[1] ?? ""));
  }

  return uniqueValues(values);
}

function parseMirrorEntities(message: string) {
  const adAccountValues = extractAfterLabels(
    message,
    /\b(?:ad\s+accounts?|accounts?|accs?|acc)\b\s*[:#-]?\s+(.+?)(?=\s+\b(?:to|into|for|with|bm|business\s+manager|full|partial|view|access)\b|[.!?]?$|$)/gi
  );
  const bmValues = extractAfterLabels(
    message,
    /\b(?:bm|business\s+manager)\b\s*[:#-]?\s+(.+?)(?=\s+\b(?:with|for|account|accounts|ad\s+account|acc|full|partial|view|access)\b|[.!?]?$|$)/gi
  );

  return {
    adAccountValues: removeDuplicateValues(adAccountValues, bmValues),
    bmValues: removeDuplicateValues(bmValues, adAccountValues)
  };
}

export function shouldIgnoreTelegramMessage(message: string): boolean {
  return EMOJI_ONLY_PATTERN.test(message.trim());
}

export function buildGuardianMirrorMessage(message: string, previousContext = ""): string | null {
  const cleanMessage = message.trim();
  if (!cleanMessage || shouldIgnoreTelegramMessage(cleanMessage)) return null;

  const classification = classifyIntent(cleanMessage, previousContext);
  const parsedEntities = parseMirrorEntities(cleanMessage);
  const fallbackBmValues = toStringList(classification.extractedData.bmIds);
  const fallbackAdAccountValues = removeDuplicateValues(toStringList(classification.extractedData.adAccountIds), fallbackBmValues);
  const bmIds = joinList(parsedEntities.bmValues) || joinList(fallbackBmValues);
  const adAccountIds = joinList(parsedEntities.adAccountValues) || joinList(fallbackAdAccountValues);
  const accountNames = joinList(classification.extractedData.accountNames);
  const access = classification.accessLevel !== "not_specified" ? classification.accessLevel : "";

  if (classification.intent === "share_ad_account" && (adAccountIds || accountNames) && bmIds) {
    const accountPart = adAccountIds || accountNames;
    const accessPart = access ? ` with ${access} access` : "";
    return `Please share ad account ${accountPart} to BM ${bmIds}${accessPart}.`;
  }

  if (classification.intent === "unshare_ad_account" && (adAccountIds || accountNames)) {
    const accountPart = adAccountIds || accountNames;
    const bmPart = bmIds ? ` from BM ${bmIds}` : "";
    return `Please remove access${bmPart} from ad account ${accountPart}.`;
  }

  if (classification.intent === "transfer_ad_account" && bmIds) {
    return `Please move the mentioned ad account(s) to BM ${bmIds}.`;
  }

  if (classification.intent === "deposit_funds") {
    return `Please check whether the client payment/funds have arrived.`;
  }

  if (classification.intent === "check_availability") {
    return `Please check availability for the requested account type.`;
  }

  if (classification.intent === "refund_request") {
    return `Please check the refund request and remaining balance.`;
  }

  if (classification.intent === "check_policy") {
    return `Please check whether this offer/domain can run.`;
  }

  return cleanMessage;
}
