"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button, Card } from "@/components/ui";

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <Card className="max-w-2xl border-danger/30">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-1 h-5 w-5 text-danger" aria-hidden="true" />
        <div>
          <h1 className="text-lg font-bold">Could not load this view</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
          <Button className="mt-4" onClick={reset}>
            <RotateCcw className="h-4 w-4" aria-hidden="true" />
            Retry
          </Button>
        </div>
      </div>
    </Card>
  );
}
