import { Card } from "@/components/ui";

export default function Loading() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-64 animate-pulse rounded bg-muted" />
      <div className="grid gap-4 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Card key={index} className="h-28 animate-pulse bg-muted" />
        ))}
      </div>
      <Card className="h-80 animate-pulse bg-muted" />
    </div>
  );
}
