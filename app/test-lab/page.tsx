import { TestLabClient } from "@/components/test-lab-client";

export default function TestLabPage() {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-normal">Bot Test Lab</h1>
        <p className="mt-1 text-sm text-muted-foreground">Test local intent classification without sending Telegram messages.</p>
      </header>
      <TestLabClient />
    </div>
  );
}
