import Link from "next/link";
import { AlertTriangle, Clock3, Inbox, Sparkles } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { MetricCard } from "@/components/metric-card";
import { StatusBadge } from "@/components/status-badge";
import { Card } from "@/components/ui";
import { formatIntentLabel } from "@/lib/display";
import { getEscalationState } from "@/lib/operations";
import { getDashboardStats } from "@/lib/tickets";
import { truncate } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const stats = await getDashboardStats();

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-normal">Dashboard</h1>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Total" value={stats.totalTickets} icon={Inbox} />
        <MetricCard label="New" value={stats.newTickets} icon={Sparkles} />
        <MetricCard label="Waiting" value={stats.waitingForMark} icon={Clock3} />
        <MetricCard label="Urgent" value={stats.waitingOver30Minutes} icon={AlertTriangle} />
      </section>

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
    </div>
  );
}
