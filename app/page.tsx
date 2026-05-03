import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock3, Inbox, Sparkles, Users } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { MetricCard } from "@/components/metric-card";
import { StatusBadge } from "@/components/status-badge";
import { TicketFilters } from "@/components/ticket-filters";
import { Card } from "@/components/ui";
import { formatIntentLabel } from "@/lib/display";
import { formatDurationMinutes, getEscalationState, getTicketTimerLabel } from "@/lib/operations";
import { getClientOptions, getDashboardStats } from "@/lib/tickets";
import { truncate } from "@/lib/utils";

export const dynamic = "force-dynamic";

type DashboardPageProps = {
  searchParams: {
    client?: string;
    date?: string;
    start?: string;
    end?: string;
  };
};

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const [stats, clients] = await Promise.all([
    getDashboardStats(searchParams),
    getClientOptions()
  ]);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-normal">Dashboard</h1>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Total Open Tickets" value={stats.totalOpenTickets} icon={Inbox} />
        <MetricCard label="Resolved Today" value={stats.resolvedToday} icon={CheckCircle2} />
        <MetricCard label="Tickets Waiting" value={stats.ticketsWaitingOpen} icon={Clock3} helper="Open tickets waiting on Mark" />
        <MetricCard label="Longest Open Ticket" value={formatDurationMinutes(stats.longestOpenMinutes)} icon={AlertTriangle} />
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Total" value={stats.totalTickets} icon={Inbox} />
        <MetricCard label="New" value={stats.newTickets} icon={Sparkles} />
        <MetricCard label="Urgent" value={stats.waitingOver30Minutes} icon={AlertTriangle} />
        <MetricCard
          label="Avg Resolution"
          value={formatDurationMinutes(stats.averageResolutionMinutes)}
          icon={CheckCircle2}
        />
      </section>

      <TicketFilters clients={clients} basePath="/" showTicketFilters={false} />

      <Card>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold">Tickets per client</h2>
          <Users className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        </div>
        {stats.ticketsByClient.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No open client tickets.</p>
        ) : (
          <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {stats.ticketsByClient.map((client) => (
              <Link
                key={client.client}
                href={`/tickets?client=${encodeURIComponent(client.client)}`}
                className="rounded-md border border-border bg-muted px-3 py-2 transition hover:bg-zinc-800"
              >
                <span className="block truncate text-sm font-semibold">{client.label}</span>
                <span className="text-xs text-muted-foreground">{client.openCount} open</span>
              </Link>
            ))}
          </div>
        )}
      </Card>

      <Card className="p-0">
        <div className="border-b border-border p-4">
          <h2 className="text-lg font-bold">Attention</h2>
        </div>
        {stats.attentionTickets.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No tickets need attention" description="Waiting and urgent tickets will appear here." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-border bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Ticket</th>
                  <th className="px-4 py-3">Intent</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">SLA</th>
                  <th className="px-4 py-3">Timer</th>
                  <th className="px-4 py-3">Message</th>
                  <th className="px-4 py-3">Open</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stats.attentionTickets.map((ticket) => {
                  const sla = getEscalationState(ticket);
                  return (
                    <tr key={ticket.id} className="hover:bg-muted/60">
                      <td className="px-4 py-3 font-semibold">{ticket.ticket_code ?? ticket.id.slice(0, 8)}</td>
                      <td className="px-4 py-3">{formatIntentLabel(ticket.intent)}</td>
                      <td className="px-4 py-3"><StatusBadge value={ticket.status} /></td>
                      <td className="px-4 py-3">
                        {sla === "urgent" ? (
                          <StatusBadge value="urgent" type="priority" label="Urgent" />
                        ) : (
                          <StatusBadge value="waiting_for_mark" label="Needs attention" />
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{getTicketTimerLabel(ticket)}</td>
                      <td className="max-w-md px-4 py-3 text-muted-foreground">
                        <span className="block truncate">{truncate(ticket.client_original_message, 120)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <Link className="font-semibold text-primary hover:underline" href={`/tickets/${ticket.id}`}>
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-0">
        <div className="border-b border-border p-4">
          <h2 className="text-lg font-bold">Recent tickets</h2>
        </div>
        {stats.recentTickets.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No recent tickets" description="New Telegram tickets will appear here after refresh." />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-border bg-muted/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Ticket</th>
                  <th className="px-4 py-3">Intent</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Message</th>
                  <th className="px-4 py-3">Open</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stats.recentTickets.map((ticket) => (
                  <tr key={ticket.id} className="hover:bg-muted/60">
                    <td className="px-4 py-3 font-semibold">{ticket.ticket_code ?? ticket.id.slice(0, 8)}</td>
                    <td className="px-4 py-3">{formatIntentLabel(ticket.intent)}</td>
                    <td className="px-4 py-3"><StatusBadge value={ticket.status} /></td>
                    <td className="max-w-md px-4 py-3 text-muted-foreground">
                      <span className="block truncate">{truncate(ticket.client_original_message, 120)}</span>
                    </td>
                    <td className="px-4 py-3">
                      <Link className="font-semibold text-primary hover:underline" href={`/tickets/${ticket.id}`}>
                        Open
                      </Link>
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
