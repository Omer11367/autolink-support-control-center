import Link from "next/link";
import { ArrowLeft, Filter, Inbox, Search } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { Card, Input, Select } from "@/components/ui";
import { formatIntentLabel } from "@/lib/display";
import { formatDurationMinutes, getTicketTimerLabel } from "@/lib/operations";
import { getClientOperations } from "@/lib/tickets";
import type { Ticket } from "@/lib/types";
import { truncate } from "@/lib/utils";

export const dynamic = "force-dynamic";

type PageProps = {
  params: { client: string };
  searchParams: {
    category?: string;
    status?: string;
    priority?: string;
    search?: string;
    unresolved?: string;
    waitingMark?: string;
    depositsOnly?: string;
  };
};

function formatDate(value: string | null) {
  if (!value) return "No activity";
  return new Intl.DateTimeFormat("en", { timeZone: "Asia/Jerusalem", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function Metric({ label, value, helper }: { label: string; value: string | number; helper?: string }) {
  return (
    <Card className="bg-zinc-950/70">
      <div className="text-xs font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-2 text-2xl font-bold">{value}</div>
      {helper ? <div className="mt-1 text-xs text-muted-foreground">{helper}</div> : null}
    </Card>
  );
}

type DetailField = {
  label: string;
  value: string | null;
};

type DetectedAction = {
  type?: string;
  account?: string;
  accounts?: string[];
  bm?: string;
  amount?: string;
};

function readExtractedData(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  return data as Record<string, unknown>;
}

function readExtractedText(data: unknown, keys: string[]): string | null {
  const record = readExtractedData(data);
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function readActions(data: unknown): DetectedAction[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) return [];
  const actions = (data as { actions?: unknown }).actions;
  return Array.isArray(actions) ? actions.filter((item): item is DetectedAction => Boolean(item) && typeof item === "object") : [];
}

function uniqueValues(values: Array<string | null | undefined>): string | null {
  const clean = values.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return clean.length ? Array.from(new Set(clean)).join(", ") : null;
}

function actionAccounts(actions: DetectedAction[]): string | null {
  return uniqueValues(actions.flatMap((action) => [action.account, ...(action.accounts ?? [])]));
}

function actionBm(actions: DetectedAction[]): string | null {
  const bm = uniqueValues(actions.map((action) => action.bm));
  return bm?.toUpperCase() === "ALL BMS" ? "all BMs" : bm;
}

function firstActionAmount(actions: DetectedAction[]): string | null {
  return actions.find((action) => action.amount)?.amount ?? null;
}

function extractAmountFromText(text: string): string | null {
  return text.match(/(?:\$|usd\s*)?\d+(?:[,.]\d+)?\s*(?:k|K)?\s*(?:usdt|usd|dollars?|\$)?/i)?.[0]?.trim() ?? null;
}

function extractCurrency(value: string | null): string | null {
  if (!value) return null;
  if (/usdt/i.test(value)) return "USDT";
  if (/\$|usd|dollars?/i.test(value)) return "USD";
  return null;
}

function extractTransactionReference(text: string): string | null {
  const link = text.match(/https?:\/\/\S+/i)?.[0]?.replace(/[).,]+$/g, "");
  if (link) return link;
  return text.match(/\b(?:0x)?[A-Fa-f0-9]{32,}\b/)?.[0] ?? null;
}

function inferProblem(text: string): string | null {
  const match = text.match(/\b(?:failed|declined|rejected|disabled|restricted|blocked|cannot pay|can't pay|card problem|payment issue|error[:\s-]*[^.]+)/i);
  return match?.[0] ?? null;
}

function inferRequiredAction(ticket: Ticket): string | null {
  if (ticket.needs_mark || ["waiting_mark", "waiting_for_mark"].includes(ticket.status ?? "")) return "Mark review needed";
  if (ticket.status === "resolved") return "Resolved";
  return null;
}

function ticketCategory(intent: string | null | undefined): string {
  const value = String(intent ?? "");
  if (["share_ad_account", "transfer_ad_account"].includes(value)) return "share";
  if (value === "unshare_ad_account") return "unshare";
  if (value === "deposit_funds") return "deposits";
  if (["payment_issue", "refund_request"].includes(value)) return "payment_issues";
  if (["check_account_status", "request_data_banned_accounts", "check_policy", "verify_account"].includes(value)) return "site_access";
  return "general";
}

function compactFieldText(value: string | null, max = 120): string | null {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max - 1)}...` : value;
}

function buildDetailFields(ticket: Ticket): DetailField[] {
  const data = ticket.extracted_data;
  const actions = readActions(data);
  const message = ticket.client_original_message ?? "";
  const context = readExtractedText(data, ["linkedOriginalSummary", "linkedOriginalMessage", "replyToMessageText"]);
  const followUp = readExtractedText(data, ["followUpMessage"]);
  const accounts = actionAccounts(actions) ?? readExtractedText(data, ["adAccountIds", "accountIds", "account"]);
  const bm = actionBm(actions) ?? readExtractedText(data, ["bmIds", "bmId", "bm"]);
  const amount = firstActionAmount(actions) ?? readExtractedText(data, ["amount", "amountOrPayment", "payment"]) ?? extractAmountFromText(message);
  const category = ticketCategory(ticket.intent);
  const commonTimeline = getTicketTimerLabel(ticket);
  const notes = "Open ticket for notes";

  const fieldsByCategory: Record<string, DetailField[]> = {
    share: [
      { label: "Account IDs", value: accounts },
      { label: "BM ID", value: bm },
      { label: "Access level", value: readExtractedText(data, ["accessLevel", "access_level"]) },
      { label: "Mark status", value: ticket.needs_mark ? "Waiting Mark" : "No Mark needed" },
      { label: "Timeline", value: commonTimeline },
      { label: "Notes", value: notes }
    ],
    unshare: [
      { label: "Account IDs", value: accounts },
      { label: "BM / from BM", value: bm },
      { label: "Mark status", value: ticket.needs_mark ? "Waiting Mark" : "No Mark needed" },
      { label: "Timeline", value: commonTimeline },
      { label: "Notes", value: notes }
    ],
    deposits: [
      { label: "Amount", value: amount },
      { label: "Currency", value: extractCurrency(amount ?? message) },
      { label: "Transaction link/hash", value: extractTransactionReference(message) },
      { label: "Confirmation status", value: ticket.status ?? null },
      { label: "Timeline", value: commonTimeline },
      { label: "Notes", value: notes }
    ],
    payment_issues: [
      { label: "Account/card/payment method", value: accounts ?? (/\bcard\b/i.test(message) ? "Card" : null) ?? (/\bpayment method\b/i.test(message) ? "Payment method" : null) },
      { label: "Error/problem", value: inferProblem(message) ?? compactFieldText(ticket.internal_summary, 140) },
      { label: "Required action", value: inferRequiredAction(ticket) },
      { label: "Timeline", value: commonTimeline },
      { label: "Notes", value: notes }
    ],
    general: [
      { label: "Question/topic", value: followUp ?? compactFieldText(message, 120) },
      { label: "Related context", value: compactFieldText(context, 160) },
      { label: "Mark status", value: ticket.needs_mark ? "Waiting Mark" : null },
      { label: "Timeline", value: commonTimeline },
      { label: "Notes", value: notes }
    ],
    site_access: [
      { label: "Site/system affected", value: accounts ?? bm ?? readExtractedText(data, ["system", "site", "domain"]) },
      { label: "Error description", value: inferProblem(message) ?? compactFieldText(ticket.internal_summary, 140) },
      { label: "Urgency", value: ticket.priority ?? null },
      { label: "Timeline", value: commonTimeline },
      { label: "Notes", value: notes }
    ]
  };

  const fields = fieldsByCategory[category] ?? fieldsByCategory.general;
  return fields.filter((field) => field.value && field.value !== "not_specified");
}

export default async function ClientOperationsPage({ params, searchParams }: PageProps) {
  const clientId = decodeURIComponent(params.client);
  const data = await getClientOperations(clientId, searchParams);

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <Link href="/" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Back to clients
          </Link>
          <h1 className="mt-3 text-3xl font-bold tracking-normal">{data.client.label}</h1>
          <p className="mt-1 text-sm text-muted-foreground">Client operations center</p>
        </div>
        <div className="text-sm text-muted-foreground">Last activity: {formatDate(data.metrics.lastActivity)}</div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Total requests" value={data.metrics.totalRequests} />
        <Metric label="Active requests" value={data.metrics.activeRequests} />
        <Metric label="Waiting Mark" value={data.metrics.waitingMark} />
        <Metric label="Avg response" value={formatDurationMinutes(data.metrics.averageResponseMinutes)} />
        <Metric label="Deposits" value={data.metrics.deposits} />
        <Metric label="Urgent issues" value={data.metrics.urgentIssues} />
        <Metric label="Visible now" value={data.visibleTickets.length} />
        <Metric label="Client ID" value={data.client.id.slice(0, 12)} />
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {data.categories.map((category) => (
          <Link key={category.key} href={`/dashboard/client/${encodeURIComponent(data.client.id)}?category=${category.key}`} className="group">
            <Card className="h-full bg-zinc-950/70 transition hover:border-zinc-600">
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-bold">{category.label}</h2>
                <Inbox className="h-4 w-4 text-muted-foreground group-hover:text-foreground" />
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <div><div className="text-xl font-bold">{category.count}</div><div className="text-[11px] text-muted-foreground">total</div></div>
                <div><div className="text-xl font-bold">{category.pendingCount}</div><div className="text-[11px] text-muted-foreground">pending</div></div>
                <div><div className="text-xl font-bold">{category.urgentCount}</div><div className="text-[11px] text-muted-foreground">urgent</div></div>
              </div>
              <div className="mt-4 text-xs text-muted-foreground">Latest: {formatDate(category.latestActivity)}</div>
            </Card>
          </Link>
        ))}
      </section>

      <Card>
        <form className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_repeat(7,145px)]" action={`/dashboard/client/${encodeURIComponent(data.client.id)}`}>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input name="search" defaultValue={searchParams.search ?? ""} placeholder="Search username, account ID, BM ID, message..." className="pl-9" />
          </div>
          <Select name="category" defaultValue={searchParams.category ?? "all"}>
            <option value="all">All categories</option>
            {data.categories.map((category) => <option key={category.key} value={category.key}>{category.label}</option>)}
          </Select>
          <Select name="status" defaultValue={searchParams.status ?? "all"}>
            <option value="all">All status</option>
            <option value="waiting_mark">Waiting Mark</option>
            <option value="waiting_for_mark">Waiting for Mark</option>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="closed">Closed</option>
          </Select>
          <Select name="priority" defaultValue={searchParams.priority ?? "all"}>
            <option value="all">All priority</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
          </Select>
          <Select name="waitingMark" defaultValue={searchParams.waitingMark ?? ""}>
            <option value="">Any Mark state</option>
            <option value="1">Waiting Mark only</option>
          </Select>
          <Select name="unresolved" defaultValue={searchParams.unresolved ?? ""}>
            <option value="">Any resolution</option>
            <option value="1">Unresolved only</option>
          </Select>
          <Select name="depositsOnly" defaultValue={searchParams.depositsOnly ?? ""}>
            <option value="">All request types</option>
            <option value="1">Deposits only</option>
          </Select>
          <button className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-zinc-100 px-3 text-sm font-bold text-zinc-950 hover:bg-white">
            <Filter className="h-4 w-4" /> Filter
          </button>
        </form>
      </Card>

      <section className="space-y-3">
        {data.visibleTickets.map((ticket) => {
          const detailFields = buildDetailFields(ticket);
          const followUpMessage = readExtractedText(ticket.extracted_data, ["followUpMessage"]);
          const linkedContext = readExtractedText(ticket.extracted_data, ["linkedOriginalSummary", "linkedOriginalMessage"]);

          return (
            <Card key={ticket.id} className="bg-zinc-950/70">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge value={ticket.status} />
                    <StatusBadge value={ticket.priority ?? "normal"} type="priority" />
                    <StatusBadge value={ticket.intent ?? "unknown"} type="neutral" label={formatIntentLabel(ticket.intent)} />
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">{formatDate(ticket.created_at)} | @{ticket.client_username ?? "unknown"}</p>
                  <h3 className="mt-2 text-base font-semibold">{truncate(followUpMessage ? `Follow-up: ${followUpMessage}` : (ticket.client_original_message ?? "No original message"), 220)}</h3>
                  {linkedContext ? <p className="mt-2 text-sm text-muted-foreground">{truncate(`Original: ${linkedContext}`, 260)}</p> : null}
                  <p className="mt-2 text-sm text-muted-foreground">{truncate(ticket.internal_summary ?? "No AI summary", 260)}</p>
                </div>
                <Link className="shrink-0 rounded-md border border-border px-3 py-2 text-sm font-semibold hover:bg-zinc-900" href={`/tickets/${ticket.id}`}>Open ticket</Link>
              </div>
              {detailFields.length > 0 ? (
                <div className="mt-4 grid gap-2 border-t border-border pt-4 text-sm md:grid-cols-3 xl:grid-cols-6">
                  {detailFields.map((field) => (
                    <div key={field.label}>
                      <div className="text-xs text-muted-foreground">{field.label}</div>
                      <div>{field.value}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </Card>
          );
        })}
        {data.visibleTickets.length === 0 ? (
          <Card className="text-center text-sm text-muted-foreground">
            No requests match these filters.
          </Card>
        ) : null}
      </section>
    </div>
  );
}
