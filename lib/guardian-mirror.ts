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

function cleanToken(value: string): string {
  return value.trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9_-]+$/g, "");
}

function tokenKey(value: string): string {
  return cleanToken(value).toLowerCase();
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

function splitValueToken(token: string): string[] {
  return token
    .split(/[,;&]+/)
    .map(cleanToken)
    .filter(Boolean);
}

function collectValuesAfterLabel(tokens: string[], startIndex: number, labelType: "account" | "bm"): string[] {
  const values: string[] = [];
  let index = startIndex;

  while (index < tokens.length) {
    const key = tokenKey(tokens[index] ?? "");
    const accountLabelLength = isAccountLabel(tokens, index);
    const bmLabelLength = isBmLabel(tokens, index);
    const isOtherLabel = labelType === "account" ? bmLabelLength > 0 : accountLabelLength > 0;
    const isAccessWord = ["full", "partial", "view", "access", "admin", "management", "limited"].includes(key);
    const isConnector = ["to", "into", "for", "from", "with", "please", "pls"].includes(key);

    if (isOtherLabel || isAccessWord) break;
    if (isConnector && values.length > 0) break;
    if (isConnector) {
      index += 1;
      continue;
    }

    const tokenValues = splitValueToken(tokens[index] ?? "");
    if (tokenValues.length === 0) break;

    values.push(...tokenValues);
    index += 1;
  }

  return values;
}

function parseMirrorEntities(message: string) {
  const tokens = message.split(/\s+/).filter(Boolean);
  const adAccountValues: string[] = [];
  const bmValues: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const accountLabelLength = isAccountLabel(tokens, index);
    if (accountLabelLength > 0) {
      adAccountValues.push(...collectValuesAfterLabel(tokens, index + accountLabelLength, "account"));
      index += accountLabelLength - 1;
      continue;
    }

    const bmLabelLength = isBmLabel(tokens, index);
    if (bmLabelLength > 0) {
      bmValues.push(...collectValuesAfterLabel(tokens, index + bmLabelLength, "bm"));
      index += bmLabelLength - 1;
    }
  }

  const uniqueAdAccountValues = uniqueValues(adAccountValues);
  const uniqueBmValues = uniqueValues(bmValues);

  return {
    adAccountValues: removeDuplicateValues(uniqueAdAccountValues, uniqueBmValues),
    bmValues: removeDuplicateValues(uniqueBmValues, uniqueAdAccountValues)
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
  const hasLabeledShareEntities = parsedEntities.adAccountValues.length > 0 && parsedEntities.bmValues.length > 0;
  const bmIds = joinList(parsedEntities.bmValues) || joinList(fallbackBmValues);
  const adAccountIds = joinList(parsedEntities.adAccountValues) || joinList(fallbackAdAccountValues);
  const accountNames = joinList(classification.extractedData.accountNames);
  const access = classification.accessLevel !== "not_specified" ? classification.accessLevel : "";

  if (classification.intent === "share_ad_account" && !hasLabeledShareEntities) {
    return cleanMessage;
  }

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
