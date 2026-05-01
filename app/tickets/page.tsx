import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { StatusBadge } from "@/components/status-badge";
import { TicketFilters } from "@/components/ticket-filters";
import { Card } from "@/components/ui";
import { getTickets } from "@/lib/tickets";
import { formatDate, truncate } from "@/lib/utils";
import { formatIntentLabel } from "@/lib/display";
import { getEscalationState } from "@/lib/operations";

export const dynamic = "force-dynamic";

type TicketsPageProps = {
  searchParams: {
    status?: string;
    intent?: string;
    priority?: string;
    search?: string;
  };
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}

export default async function TicketsPage({ searchParams }: TicketsPageProps) {
  const tickets = await getTickets(searchParams);
  const statuses = uniqueStrings(tickets.map((t) => t.status));
  const intents = uniqueStrings(tickets.map((t) => t.intent));
  const priorities = uniqueStrings(tickets.map((t) => t.priority));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-normal">Tickets</h1>
        <p className="mt-1 text-sm text-muted-foreground">Filter client requests, prioritize Mark actions, and open the full handling timeline.</p>
      </header>

      <TicketFilters statuses={statuses} intents={intents} priorities={priorities} />

      <Card className="p-0">
        {tickets.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No matching tickets" description="Adjust filters or seed incoming Telegram messages into the tickets table." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] text-left text-sm">
              <thead className="border-b border-border bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Ticket</th>
                  <th className="px-4 py-3">Client</th>
                  <th className="px-4 py-3">Intent</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">SLA</th>
                  <th className="px-4 py-3">Priority</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Message</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {tickets.map((ticket) => (
                  <tr key={ticket.id} className="transition hover:bg-muted/60">
                    <td className="px-4 py-3 font-semibold">
                      <Link href={`/tickets/${ticket.id}`}>{ticket.ticket_code ?? ticket.id.slice(0, 8)}</Link>
                    </td>
                    <td className="px-4 py-3">{ticket.client_username ?? "Unknown"}</td>
                    <td className="px-4 py-3">{formatIntentLabel(ticket.intent)}</td>
                    <td className="px-4 py-3"><StatusBadge value={ticket.status} /></td>
                    <td className="px-4 py-3">
                      {getEscalationState(ticket) === "urgent" ? (
                        <StatusBadge value="urgent" type="priority" label="Urgent" />
                      ) : getEscalationState(ticket) === "needs_attention" ? (
                        <StatusBadge value="waiting_for_mark" label="Needs attention" />
                      ) : (
                        <StatusBadge value="normal" type="neutral" label="OK" />
                      )}
                    </td>
                    <td className="px-4 py-3"><StatusBadge value={ticket.priority ?? "normal"} type="priority" /></td>
                    <td className="px-4 py-3 text-muted-foreground">{formatDate(ticket.created_at)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{truncate(ticket.client_original_message, 110)}</td>
                    <td className="px-4 py-3">
                      <Link className="font-semibold text-primary hover:underline" href={`/tickets/${ticket.id}`}>Open</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
