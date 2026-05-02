import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { StatusBadge } from "@/components/status-badge";
import { TicketActions } from "@/components/ticket-actions";
import { Card } from "@/components/ui";
import { formatIntentLabel } from "@/lib/display";
import { getActionRecommendation, getEscalationState } from "@/lib/operations";
import { getTicketDetail } from "@/lib/tickets";
import { formatDate } from "@/lib/utils";
import type { Json, Message } from "@/lib/types";

export const dynamic = "force-dynamic";

function readExtractedValue(data: Json | null, keys: string[]): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value) && value.length > 0) return value.map(String).join(", ");
    if (typeof value === "string" || typeof value === "number") return String(value);
  }

  return null;
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
    const isStopWord = ["to", "into", "for", "from", "with", "full", "partial", "view", "access", "admin", "management", "limited"].includes(key);

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

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractShareEntities(message: string | null): { bmIds: string[]; adAccountIds: string[] } {
  const tokens = (message ?? "").split(/\s+/).filter(Boolean);
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

function readChatTitleFromMessage(message: Message): string | null {
  const payload = message.raw_payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  const telegramMessage = payload.message;
  if (!telegramMessage || typeof telegramMessage !== "object" || Array.isArray(telegramMessage)) return null;

  const chat = telegramMessage.chat;
  if (!chat || typeof chat !== "object" || Array.isArray(chat)) return null;

  return typeof chat.title === "string" && chat.title.trim() ? chat.title : null;
}

function getClientDisplayName(ticketClientUsername: string | null, clientChatId: string | number | null, messages: Message[]): string {
  const groupTitle = messages.map(readChatTitleFromMessage).find((title): title is string => Boolean(title));
  if (groupTitle) return groupTitle;
  if (ticketClientUsername) return `@${ticketClientUsername}`;
  return clientChatId ? String(clientChatId) : "Unknown client";
}

export default async function TicketDetailPage({ params }: { params: { id: string } }) {
  const { ticket, messages } = await getTicketDetail(params.id);
  if (!ticket) notFound();

  const recommendation = getActionRecommendation(ticket);
  const escalationState = getEscalationState(ticket);
  const clientDisplayName = getClientDisplayName(ticket.client_username, ticket.client_chat_id, messages);
  const isShareTicket = ticket.intent === "share_ad_account" || ticket.intent === "share_account";
  const shareEntities = isShareTicket ? extractShareEntities(ticket.client_original_message) : null;
  const bmValue = shareEntities?.bmIds.length ? shareEntities.bmIds.join(", ") : readExtractedValue(ticket.extracted_data, ["bmId", "bmIds", "bm_id"]);
  const adAccountValue = shareEntities?.adAccountIds.length
    ? shareEntities.adAccountIds.join(", ")
    : readExtractedValue(ticket.extracted_data, ["adAccountIds", "accountIds", "ad_account_ids"]);
  const accessLevel = readExtractedValue(ticket.extracted_data, ["accessLevel", "access_level"]);
  const highlightedData = [
    ["BM ID", bmValue],
    ["Ad accounts", adAccountValue],
    ["Account names", readExtractedValue(ticket.extracted_data, ["accountNames", "account_names"])],
    ["Access level", accessLevel === "not_specified" ? null : accessLevel],
    ["Amount/payment", isShareTicket ? null : readExtractedValue(ticket.extracted_data, ["amountOrPayment", "amount", "payment"])],
    ["Account type", readExtractedValue(ticket.extracted_data, ["accountType", "account_type"])],
    ["Dates/report range", readExtractedValue(ticket.extracted_data, ["reportRange", "dateRange", "dates"])]
  ].filter((item): item is [string, string] => Boolean(item[1]));

  return (
    <div className="space-y-5">
      <Link href="/tickets" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to tickets
      </Link>

      <header className="flex flex-col justify-between gap-3 lg:flex-row lg:items-start">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-normal">{ticket.ticket_code ?? ticket.id}</h1>
            <CopyButton value={ticket.ticket_code ?? ticket.id} label="Copy ticket" />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{clientDisplayName}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatIntentLabel(ticket.intent)} | Created {formatDate(ticket.created_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusBadge value={ticket.status} />
          <StatusBadge value={ticket.priority ?? "normal"} type="priority" />
          <StatusBadge value={ticket.intent ?? "unknown"} type="neutral" label={formatIntentLabel(ticket.intent)} />
          {escalationState === "urgent" ? <StatusBadge value="urgent" type="priority" label="Urgent" /> : null}
          {escalationState === "needs_attention" ? <StatusBadge value="waiting_for_mark" label="Needs attention" /> : null}
        </div>
      </header>

      <section className="grid gap-4 lg:grid-cols-[1fr_420px]">
        <div className="space-y-4">
          <Card>
            <h2 className="text-lg font-bold">Client message</h2>
            <p className="mt-3 whitespace-pre-wrap rounded-md bg-muted p-4 text-sm leading-6">
              {ticket.client_original_message ?? "No original message stored."}
            </p>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">Client</dt>
                <dd className="font-medium">{clientDisplayName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Username</dt>
                <dd className="font-medium">{ticket.client_username ? `@${ticket.client_username}` : "Unknown"}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">User id</dt>
                <dd className="font-medium">{ticket.client_user_id ?? "Missing"}</dd>
              </div>
            </dl>
          </Card>

          <Card>
            <h2 className="text-lg font-bold">Extracted data</h2>
            {highlightedData.length > 0 ? (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {highlightedData.map(([label, value]) => (
                  <div key={label} className="rounded-md border border-border bg-muted p-3 text-sm">
                    <p className="text-xs font-semibold uppercase text-muted-foreground">{label}</p>
                    <p className="mt-1">{value}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 rounded-md bg-muted p-4 text-sm text-muted-foreground">No extracted data yet.</p>
            )}
          </Card>
        </div>

        <Card>
          <h2 className="text-lg font-bold">Actions</h2>
          <div className="mt-4">
            <TicketActions
              ticketId={ticket.id}
              clientUsername={ticket.client_username}
              recommendation={recommendation}
            />
          </div>
        </Card>
      </section>
    </div>
  );
}
