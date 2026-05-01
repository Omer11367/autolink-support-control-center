import { cn } from "@/lib/utils";
import { formatValueLabel, getPriorityTone, getStatusTone } from "@/lib/display";

const toneClasses: Record<string, string> = {
  blue: "border-blue-400/30 bg-blue-500/10 text-blue-700 dark:text-blue-200",
  orange: "border-warning/30 bg-warning/10 text-amber-700 dark:text-amber-200",
  green: "border-success/30 bg-success/10 text-emerald-700 dark:text-emerald-200",
  gray: "border-muted bg-muted text-muted-foreground",
  red: "border-danger/30 bg-danger/10 text-red-700 dark:text-red-200",
  neutral: "border-border bg-muted text-muted-foreground"
};

export function StatusBadge({ value, type = "status", label }: { value?: string | null; type?: "status" | "priority" | "neutral"; label?: string }) {
  const displayLabel = label ?? formatValueLabel(value);
  const tone = type === "priority" ? getPriorityTone(value) : type === "status" ? getStatusTone(value) : "neutral";
  return (
    <span className={cn("inline-flex rounded-full border px-2 py-1 text-xs font-semibold", toneClasses[tone])}>
      {displayLabel}
    </span>
  );
}
