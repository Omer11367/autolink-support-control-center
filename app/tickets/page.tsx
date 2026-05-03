import { EmptyState } from "@/components/empty-state";
import { TicketFilters } from "@/components/ticket-filters";
import { TicketsTable } from "@/components/tickets-table";
import { Card } from "@/components/ui";
import { getClientOptions, getTickets } from "@/lib/tickets";

export const dynamic = "force-dynamic";

type TicketsPageProps = {
  searchParams: {
    status?: string;
    intent?: string;
    priority?: string;
    search?: string;
    client?: string;
    date?: string;
    start?: string;
    end?: string;
  };
};

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  );
}

export default async function TicketsPage({ searchParams }: TicketsPageProps) {
  const [tickets, clients] = await Promise.all([
    getTickets(searchParams),
    getClientOptions()
  ]);
  const statuses = uniqueStrings(tickets.map((t) => t.status));
  const intents = uniqueStrings(tickets.map((t) => t.intent));

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-normal">Tickets</h1>
        <p className="mt-1 text-sm text-muted-foreground">Filter client requests, prioritize Mark actions, and open the full handling timeline.</p>
      </header>

      <TicketFilters statuses={statuses} intents={intents} clients={clients} />

      <Card className="p-0">
        {tickets.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No matching tickets" description="Adjust filters or seed incoming Telegram messages into the tickets table." />
          </div>
        ) : (
          <TicketsTable tickets={tickets} />
        )}
      </Card>
    </div>
  );
}
