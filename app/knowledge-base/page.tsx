import { PlaybookManager } from "@/components/playbook-manager";
import { getPlaybookEntries } from "@/lib/tickets";

export const dynamic = "force-dynamic";

export default async function KnowledgeBasePage() {
  const entries = await getPlaybookEntries();

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-normal">Knowledge Base</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage playbook entries used by Gemini classification and Mark escalation workflows.</p>
      </header>
      <PlaybookManager entries={entries} />
    </div>
  );
}
