import type { LucideIcon } from "lucide-react";
import { Card } from "@/components/ui";

export function MetricCard({ label, value, helper, icon: Icon }: { label: string; value: number | string; helper?: string; icon: LucideIcon }) {
  return (
    <Card className="min-h-28">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-normal">{value}</p>
        </div>
        <div className="rounded-md bg-muted p-2">
          <Icon className="h-5 w-5" aria-hidden="true" />
        </div>
      </div>
      {helper ? <p className="mt-3 text-xs text-muted-foreground">{helper}</p> : null}
    </Card>
  );
}
