import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Bot, CheckCircle2, MessageSquare, StickyNote, UserRound } from "lucide-react";
import { ReclassifyTicket } from "@/components/reclassify-ticket";
import { StatusBadge } from "@/components/status-badge";
import { TicketActions } from "@/components/ticket-actions";
import { TicketNotes } from "@/components/ticket-notes";
import { Card } from "@/components/ui";
import { formatIntentLabel, getDefaultCompletionForIntent } from "@/lib/display";
import { getActionRecommendation, getEscalationState } from "@/lib/operations";
import { getTicketDetail } from "@/lib/tickets";
import { formatDate, prettyJson } from "@/lib/utils";
import type { Json } from "@/lib/types";

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

export default async function TicketDetailPage({ params }: { params: { id: string } }) {
  const { ticket, messages, actions, botResponses, notes } = await getTicketDetail(params.id);
  if (!ticket) notFound();
  const recommendation = getActionRecommendation(ticket);
  const escalationState = getEscalationState(ticket);
  const telegramConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const highlightedData = [
    ["BM ID", readExtractedValue(ticket.extracted_data, ["bmId", "bmIds", "bm_id"])],
    ["Ad accounts", readExtractedValue(ticket.extracted_data, ["adAccountIds", "accountIds", "ad_account_ids"])],
    ["Account names", readExtractedValue(ticket.extracted_data, ["accountNames", "account_names"])],
    ["Access level", readExtractedValue(ticket.extracted_data, ["accessLevel", "access_level"])],
    ["Amount/payment", readExtractedValue(ticket.extracted_data, ["amountOrPayment", "amount", "payment"])],
    ["Account type", readExtractedValue(ticket.extracted_data, ["accountType", "account_type"])],
    ["Dates/report range", readExtractedValue(ticket.extracted_data, ["reportRange", "dateRange", "dates"])]
  ].filter((item): item is [string, string] => Boolean(item[1]));

  const timeline = [
    {
      at: ticket.created_at,
      icon: UserRound,
      title: "Original client message",
      text: ticket.client_original_message
    },
    ...messages.map((message) => ({
      at: message.created_at,
      icon: MessageSquare,
      title: `Telegram message ${message.telegram_message_id ?? ""}`.trim(),
      text: message.message_text
    })),
    ...botResponses.map((response) => ({
      at: response.created_at,
      icon: Bot,
      title: response.response_type === "telegram_error" ? "Telegram send failure" : "Bot response sent",
      text: response.response_text
    })),
    ...actions.map((action) => ({
      at: action.created_at,
      icon: CheckCircle2,
      title: action.action_type === "reclassify" ? "Classifier/reclassification event" : `Mark action: ${action.action_type}`,
      text: action.action_text
    })),
    ...notes.map((note) => ({
      at: note.created_at,
      icon: StickyNote,
      title: "Internal note added",
      text: note.note_text
    }))
  ].filter((item) => item.text).sort((a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime());

  return (
    <div className="space-y-5">
      <Link href="/tickets" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to tickets
      </Link>

      <header className="flex flex-col justify-between gap-3 lg:flex-row lg:items-start">
        <div>
          <h1 className="text-2xl font-bold tracking-normal">{ticket.ticket_code ?? ticket.id}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {formatIntentLabel(ticket.intent)} | Created {formatDate(ticket.created_at)} | Updated {formatDate(ticket.updated_at)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusBadge value={ticket.status} />
          <StatusBadge value={ticket.priority ?? "normal"} type="priority" />
          <StatusBadge value={ticket.intent ?? "unknown"} type="neutral" label={formatIntentLabel(ticket.intent)} />
          {ticket.needs_mark ? <StatusBadge value="waiting_for_mark" label="Needs Mark" /> : null}
          {escalationState === "urgent" ? <StatusBadge value="urgent" type="priority" label="Urgent" /> : null}
          {escalationState === "needs_attention" ? <StatusBadge value="waiting_for_mark" label="Needs attention" /> : null}
        </div>
      </header>

      <section className="grid gap-4 xl:grid-cols-[1.35fr_0.9fr]">
        <div className="space-y-4">
          <Card>
            <h2 className="text-lg font-bold">Client message</h2>
            <p className="mt-3 whitespace-pre-wrap rounded-md bg-muted p-4 text-sm leading-6">{ticket.client_original_message ?? "No original message stored."}</p>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="text-muted-foreground">Username</dt><dd className="font-medium">{ticket.client_username ?? "Unknown"}</dd></div>
              <div><dt className="text-muted-foreground">Client chat id</dt><dd className="font-medium">{ticket.client_chat_id ?? "Missing"}</dd></div>
              <div><dt className="text-muted-foreground">User id</dt><dd className="font-medium">{ticket.client_user_id ?? "Missing"}</dd></div>
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
            <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-muted p-4 text-xs leading-5">{prettyJson(ticket.extracted_data)}</pre>
          </Card>

          <Card>
            <h2 className="text-lg font-bold">Timeline</h2>
            <div className="mt-4 space-y-4">
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground">No timeline events yet.</p>
              ) : timeline.map((item, index) => {
                const Icon = item.icon;
                return (
                  <div key={`${item.title}-${index}`} className="flex gap-3">
                    <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Icon className="h-4 w-4" aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <p className="font-semibold">{item.title}</p>
                        <p className="text-xs text-muted-foreground">{formatDate(item.at)}</p>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{item.text}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="text-lg font-bold">Smart recommendation</h2>
            <div className="mt-3 space-y-3 text-sm">
              <div className="flex flex-wrap gap-2">
                <StatusBadge value={recommendation.riskLevel} type="priority" label={`Risk: ${recommendation.riskLevel}`} />
                <StatusBadge value={recommendation.action} type="neutral" label={recommendation.label} />
              </div>
              <div>
                <p className="font-semibold">Recommended next action</p>
                <p className="mt-1 text-muted-foreground">{recommendation.label}</p>
              </div>
              <div>
                <p className="font-semibold">Why</p>
                <p className="mt-1 text-muted-foreground">{recommendation.reason}</p>
              </div>
              <div>
                <p className="font-semibold">Suggested reply preview</p>
                <p className="mt-1 whitespace-pre-wrap rounded-md bg-muted p-3">{recommendation.suggestedReply}</p>
              </div>
            </div>
          </Card>

          <Card>
            <h2 className="text-lg font-bold">Ticket details</h2>
            <dl className="mt-4 space-y-3 text-sm">
              <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Client</dt><dd className="font-medium">{ticket.client_username ?? "Unknown"}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Chat ID</dt><dd className="font-medium">{ticket.client_chat_id ?? "Missing"}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Intent</dt><dd className="font-medium">{formatIntentLabel(ticket.intent)}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Created</dt><dd className="font-medium">{formatDate(ticket.created_at)}</dd></div>
              <div className="flex justify-between gap-4"><dt className="text-muted-foreground">Updated</dt><dd className="font-medium">{formatDate(ticket.updated_at)}</dd></div>
            </dl>
          </Card>

          <Card>
            <h2 className="text-lg font-bold">Internal summary</h2>
            <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{ticket.internal_summary ?? "No internal summary yet."}</p>
          </Card>

          <Card>
            <h2 className="text-lg font-bold">Suggested completion</h2>
            <p className="mt-3 whitespace-pre-wrap rounded-md bg-muted p-3 text-sm">{ticket.completion_message ?? getDefaultCompletionForIntent(ticket.intent)}</p>
          </Card>

          <Card>
            <h2 className="text-lg font-bold">Reclassify</h2>
            <p className="mt-1 text-sm text-muted-foreground">Preview local classifier output before applying it to the ticket.</p>
            <div className="mt-4">
              <ReclassifyTicket ticketId={ticket.id} messageText={ticket.client_original_message ?? ""} currentIntent={ticket.intent} />
            </div>
          </Card>

          <Card>
            <h2 className="text-lg font-bold">Internal notes</h2>
            <div className="mt-4">
              <TicketNotes ticketId={ticket.id} notes={notes} />
            </div>
          </Card>

          <Card>
            <h2 className="text-lg font-bold">Actions</h2>
            <p className="mt-1 text-sm text-muted-foreground">Actions are saved to mark_actions. Telegram sends only from the server when configured.</p>
            <div className="mt-4">
              <TicketActions
                ticketId={ticket.id}
                clientUsername={ticket.client_username}
                clientChatId={ticket.client_chat_id}
                telegramConfigured={telegramConfigured}
                recommendation={recommendation}
              />
            </div>
          </Card>
        </div>
      </section>
    </div>
  );
}
