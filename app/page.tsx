import { ClientCardSearch } from "@/components/client-card-search";
import { EmptyState } from "@/components/empty-state";
import { BroadcastModal } from "@/components/broadcast-modal";
import { getClientCards } from "@/lib/tickets";

export const dynamic = "force-dynamic";

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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <MiniMetric label="Open" value={totals.open} />
            <MiniMetric label="Urgent" value={totals.urgent} />
            <MiniMetric label="Waiting Mark" value={totals.waiting} />
            <MiniMetric label="Deposits Today" value={totals.deposits} />
          </div>
          <BroadcastModal />
        </div>
      </header>

      {clients.length === 0 ? (
        <EmptyState title="No clients yet" description="Client groups appear here after requests are processed." />
      ) : (
        <ClientCardSearch clients={clients} />
      )}
    </div>
  );
}
