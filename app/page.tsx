import Link from "next/link";
import { AlertTriangle, ArrowUpRight, Clock3, CreditCard, Share2, ShieldAlert, Users } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { Card } from "@/components/ui";
import { getClientCards } from "@/lib/tickets";
import { truncate } from "@/lib/utils";

export const dynamic = "force-dynamic";

function formatDate(value: string | null) {
  if (!value) return "No activity";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function MiniMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-zinc-950/50 px-3 py-2">
      <div className="text-[11px] font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-bold text-foreground">{value}</div>
    </div>
  );
}

export default async function DashboardPage() {
  const clients = await getClientCards();
  const totals = clients.reduce(
    (sum, client) => ({
      open: sum.open + client.openRequests,
      urgent: sum.urgent + client.urgentRequests,
      waiting: sum.waiting + client.waitingMark,
      deposits: sum.deposits + client.depositsToday
    }),
    { open: 0, urgent: 0, waiting: 0, deposits: 0 }
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Telegram operations CRM</div>
          <h1 className="mt-2 text-3xl font-bold tracking-normal">Client Operations</h1>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <MiniMetric label="Open" value={totals.open} />
          <MiniMetric label="Urgent" value={totals.urgent} />
          <MiniMetric label="Waiting Mark" value={totals.waiting} />
          <MiniMetric label="Deposits Today" value={totals.deposits} />
        </div>
      </header>

      {clients.length === 0 ? (
        <EmptyState title="No clients yet" description="Client groups appear here after requests are processed." />
      ) : (
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {clients.map((client) => (
            <Link key={client.client} href={`/dashboard/client/${encodeURIComponent(client.client)}`} className="group block">
              <Card className="h-full border-zinc-800 bg-zinc-950/70 transition hover:-translate-y-0.5 hover:border-zinc-600 hover:bg-zinc-950">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-9 w-9 items-center justify-center rounded-md bg-zinc-100 text-zinc-950">
                        <Users className="h-4 w-4" />
                      </span>
                      <h2 className="truncate text-lg font-bold">{client.label}</h2>
                    </div>
                    <p className="mt-3 text-sm text-muted-foreground">{truncate(client.latestMessage ?? "No message preview yet.", 120)}</p>
                  </div>
                  <ArrowUpRight className="h-5 w-5 text-muted-foreground transition group-hover:text-foreground" />
                </div>

                <div className="mt-5 grid grid-cols-3 gap-2">
                  <MiniMetric label="Open" value={client.openRequests} />
                  <MiniMetric label="Urgent" value={client.urgentRequests} />
                  <MiniMetric label="Waiting" value={client.waitingMark} />
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
                  <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-emerald-200"><CreditCard className="h-3 w-3" /> {client.depositsToday} deposits</span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-blue-500/20 bg-blue-500/10 px-2 py-1 text-blue-200"><Share2 className="h-3 w-3" /> {client.shareRequests} share</span>
                  <span className="inline-flex items-center gap-1 rounded-md border border-orange-500/20 bg-orange-500/10 px-2 py-1 text-orange-200"><ShieldAlert className="h-3 w-3" /> {client.unshareRequests} unshare</span>
                </div>

                <div className="mt-5 flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" /> {formatDate(client.lastActivity)}</span>
                  {client.urgentRequests > 0 ? <span className="inline-flex items-center gap-1 text-red-200"><AlertTriangle className="h-3 w-3" /> action needed</span> : <span>steady</span>}
                </div>
              </Card>
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
