import { ClientsGrid } from "@/components/clients-grid";

export const dynamic = "force-dynamic";

export default function ActivityPage() {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-normal">Activity</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          All client activity at a glance. Click any client card to see their full request history by category.
        </p>
      </header>
      <ClientsGrid />
    </div>
  );
}
