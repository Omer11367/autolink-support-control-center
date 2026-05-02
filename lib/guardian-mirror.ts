import { classifyIntent } from "./intent-classifier";

const EMOJI_ONLY_PATTERN = /^[\s\u{1F44D}\u2764\uFE0F\u2705\u{1F64F}]+$/u;

function joinList(values: unknown): string {
  if (!Array.isArray(values)) return "";
  return values.map(String).filter(Boolean).join(", ");
}

export function shouldIgnoreTelegramMessage(message: string): boolean {
  return EMOJI_ONLY_PATTERN.test(message.trim());
}

export function buildGuardianMirrorMessage(message: string, previousContext = ""): string | null {
  const cleanMessage = message.trim();
  if (!cleanMessage || shouldIgnoreTelegramMessage(cleanMessage)) return null;

  const classification = classifyIntent(cleanMessage, previousContext);
  const bmIds = joinList(classification.extractedData.bmIds);
  const adAccountIds = joinList(classification.extractedData.adAccountIds);
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
