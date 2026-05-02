import { EmptyState } from "@/components/empty-state";
import { TicketFilters } from "@/components/ticket-filters";
import { TicketsTable } from "@/components/tickets-table";
import { Card } from "@/components/ui";
import { getTickets } from "@/lib/tickets";
import { getEscalationState } from "@/lib/operations";
import type { Ticket } from "@/lib/types";

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

function isUnresolved(ticket: Ticket) {
  const status = (ticket.status ?? "unknown").toLowerCase();
  return !["done", "resolved", "closed"].includes(status);
}

function sortedTickets(tickets: Ticket[], hasActiveFilter: boolean) {
  if (hasActiveFilter) return tickets;

  return [...tickets].sort((a, b) => {
    const score = (ticket: Ticket) => {
      const sla = getEscalationState(ticket);
      const status = (ticket.status ?? "").toLowerCase();
      if (sla === "urgent") return 0;
      if (sla === "needs_attention") return 1;
      if (status === "new" || status === "open") return 2;
      if (status === "waiting_mark" || status === "waiting_for_mark") return 3;
      return 4;
    };
    return score(a) - score(b);
  });
}

export default async function TicketsPage({ searchParams }: TicketsPageProps) {
  const tickets = await getTickets(searchParams);
  const hasActiveFilter = Boolean(searchParams.status || searchParams.intent || searchParams.priority || searchParams.search);
  const visibleTickets = sortedTickets(tickets, hasActiveFilter);
  const statuses = uniqueStrings(tickets.map((t) => t.status));
  const intents = uniqueStrings(tickets.map((t) => t.intent));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-normal">Tickets</h1>
        <p className="mt-1 text-sm text-muted-foreground">Filter client requests, prioritize Mark actions, and open the full handling timeline.</p>
      </header>

      <TicketFilters statuses={statuses} intents={intents} />

      <Card className="p-0">
        {tickets.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No matching tickets" description="Adjust filters or seed incoming Telegram messages into the tickets table." />
          </div>
        ) : (
          <TicketsTable tickets={visibleTickets.filter(isUnresolved).concat(visibleTickets.filter((ticket) => !isUnresolved(ticket)))} />
        )}
      </Card>
    </div>
  );
}
