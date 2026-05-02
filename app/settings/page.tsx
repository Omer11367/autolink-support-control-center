import { CheckCircle2, CircleSlash } from "lucide-react";
import { Card } from "@/components/ui";
import { createSupabaseAdminClient, hasSupabaseServerEnv } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function getSupabaseConnected() {
  if (!hasSupabaseServerEnv()) return false;
  try {
    const supabase = createSupabaseAdminClient();
    const { error } = await supabase.from("tickets").select("id", { head: true, count: "exact" });
    return !error;
  } catch {
    return false;
  }
}

function CheckRow({ label, ok }: { label: string; ok: boolean }) {
  const Icon = ok ? CheckCircle2 : CircleSlash;
  return (
    <div className="flex items-center justify-between rounded-md border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-3">
        <Icon className={ok ? "h-5 w-5 text-success" : "h-5 w-5 text-muted-foreground"} aria-hidden="true" />
        <span className="font-medium">{label}</span>
      </div>
      <span className="text-sm text-muted-foreground">{ok ? "Ready" : "Missing"}</span>
    </div>
  );
}

export default async function SettingsPage() {
  const supabaseConnected = await getSupabaseConnected();
  const telegramConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const guardianGroupConfigured = Boolean(process.env.GUARDIAN_GROUP_CHAT_ID ?? process.env.MARK_INTERNAL_CHAT_ID);

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-normal">Settings</h1>
      </header>

      <Card className="space-y-3">
        <CheckRow label="Supabase" ok={supabaseConnected} />
        <CheckRow label="Telegram" ok={telegramConfigured} />
        <CheckRow label="Guardian group" ok={guardianGroupConfigured} />
      </Card>
    </div>
  );
}
