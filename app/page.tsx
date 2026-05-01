import Link from "next/link";
import { AlertTriangle, CheckCircle2, CircleSlash, Clock3, Inbox, Sparkles, TrendingUp, Zap } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { MetricCard } from "@/components/metric-card";
import { StatusBadge } from "@/components/status-badge";
import { Card } from "@/components/ui";
import { getDashboardStats } from "@/lib/tickets";
import { formatDate, truncate } from "@/lib/utils";
import { formatIntentLabel } from "@/lib/display";
import { getEscalationState } from "@/lib/operations";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const stats = await getDashboardStats();

  return (
    <div className="space-y-6">
      <header className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <h1 className="text-2xl font-bold tracking-normal">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">Focus here first: urgent SLA tickets, payment requests, and unknown intents need human action fastest.</p>
        </div>
        <Link href="/tickets" className="inline-flex min-h-10 items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground">
          Open ticket queue
        </Link>
      </header>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Total tickets" value={stats.totalTickets} helper="All tracked support requests" icon={Inbox} />
        <MetricCard label="Waiting for Mark" value={stats.waitingForMark} helper="Manual actions blocking client replies" icon={Clock3} />
        <MetricCard label="Resolved" value={stats.resolved} helper="Completed by admin or bot response" icon={CheckCircle2} />
        <MetricCard label="Closed" value={stats.closed} helper="No further client reply needed" icon={CircleSlash} />
        <MetricCard label="New tickets" value={stats.newTickets} helper="Fresh open client requests" icon={Sparkles} />
        <MetricCard label="High priority" value={stats.highPriorityTickets} helper="Urgent or high priority queue" icon={Zap} />
        <MetricCard label="Telegram errors" value={stats.telegramSendErrors} helper="Detected failed bot responses" icon={AlertTriangle} />
        <MetricCard label="Last 24 hours" value={stats.last24HoursTickets} helper="New ticket volume today" icon={Clock3} />
        <MetricCard label="Waiting >10 min" value={stats.waitingOver10Minutes} helper="Needs attention now" icon={Clock3} />
        <MetricCard label="Waiting >30 min" value={stats.waitingOver30Minutes} helper="Urgent queue risk" icon={AlertTriangle} />
        <MetricCard label="Payment tickets" value={stats.paymentTickets} helper="Funds, refunds, payment issues" icon={Zap} />
        <MetricCard label="Unknown intents" value={stats.unknownIntentTickets} helper="Reclassify before replying" icon={Sparkles} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <Card className="xl:col-span-2">
          <div className="mb-4">
            <h2 className="text-lg font-bold">Attention queue</h2>
            <p className="text-sm text-muted-foreground">Unresolved tickets breaching the 10 or 30 minute SLA windows.</p>
          </div>
          {stats.attentionTickets.length === 0 ? (
            <EmptyState title="No urgent tickets" description="Nothing is currently breaching the attention windows." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[850px] text-left text-sm">
                <thead className="border-b border-border text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-3 pr-4">Ticket</th>
                    <th className="py-3 pr-4">Intent</th>
                    <th className="py-3 pr-4">SLA</th>
                    <th className="py-3 pr-4">Message</th>
                    <th className="py-3">Open</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {stats.attentionTickets.map((ticket) => (
                    <tr key={ticket.id} className="hover:bg-muted/60">
                      <td className="py-3 pr-4 font-semibold">{ticket.ticket_code ?? ticket.id.slice(0, 8)}</td>
                      <td className="py-3 pr-4">{formatIntentLabel(ticket.intent)}</td>
                      <td className="py-3 pr-4">
                        {getEscalationState(ticket) === "urgent" ? (
                          <StatusBadge value="urgent" type="priority" label="Urgent" />
                        ) : (
                          <StatusBadge value="waiting_for_mark" label="Needs attention" />
                        )}
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">{truncate(ticket.client_original_message, 96)}</td>
                      <td className="py-3"><Link className="font-semibold text-primary hover:underline" href={`/tickets/${ticket.id}`}>Open</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">Recent tickets</h2>
              <p className="text-sm text-muted-foreground">Newest client messages needing operational review.</p>
            </div>
          </div>
          {stats.recentTickets.length === 0 ? (
            <EmptyState title="No tickets yet" description="Once the Telegram bot writes tickets to Supabase, they will appear here." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="border-b border-border text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-3 pr-4">Ticket</th>
                    <th className="py-3 pr-4">Client</th>
                    <th className="py-3 pr-4">Intent</th>
                    <th className="py-3 pr-4">Status</th>
                    <th className="py-3 pr-4">Created</th>
                    <th className="py-3">Preview</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {stats.recentTickets.map((ticket) => (
                    <tr key={ticket.id} className="hover:bg-muted/60">
                      <td className="py-3 pr-4 font-semibold">
                        <Link href={`/tickets/${ticket.id}`}>{ticket.ticket_code ?? ticket.id.slice(0, 8)}</Link>
                      </td>
                      <td className="py-3 pr-4">{ticket.client_username ?? "Unknown"}</td>
                      <td className="py-3 pr-4">{formatIntentLabel(ticket.intent)}</td>
                      <td className="py-3 pr-4"><StatusBadge value={ticket.status} /></td>
                      <td className="py-3 pr-4 text-muted-foreground">{formatDate(ticket.created_at)}</td>
                      <td className="py-3 text-muted-foreground">{truncate(ticket.client_original_message, 72)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card>
          <div className="mb-4 flex items-center gap-2">
            <TrendingUp className="h-5 w-5" aria-hidden="true" />
            <div>
              <h2 className="text-lg font-bold">Top intents</h2>
              <p className="text-sm text-muted-foreground">Volume concentration by support need.</p>
            </div>
          </div>
          {stats.topIntents.length === 0 ? (
            <EmptyState title="No intent data" description="Intent counts will populate as Gemini classification writes tickets." />
          ) : (
            <div className="space-y-3">
              {stats.topIntents.map((item) => (
                <div key={item.intent}>
                  <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">{formatIntentLabel(item.intent)}</span>
                    <span className="text-muted-foreground">{item.count}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(8, (item.count / Math.max(stats.topIntents[0].count, 1)) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
