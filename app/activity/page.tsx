import { ActivityFeed } from "@/components/activity-feed";

export const dynamic = "force-dynamic";

export default function ActivityPage() {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-normal">Activity</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every request from every client — deposits, shares, payments, and more. Search, filter, and click any row to see the full message and attachments.
        </p>
      </header>
      <ActivityFeed />
    </div>
  );
}
