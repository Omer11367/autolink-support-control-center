import { AlertTriangle, CheckCircle2, CircleSlash } from "lucide-react";
import { Card } from "@/components/ui";
import { createSupabaseAdminClient, hasSupabaseServerEnv } from "@/lib/supabase/admin";
import { booleanStatus } from "@/lib/utils";

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

function EnvRow({ label, ok }: { label: string; ok: boolean }) {
  const Icon = ok ? CheckCircle2 : CircleSlash;
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-card px-4 py-3">
      <div className="flex items-center gap-3">
        <Icon className={ok ? "h-5 w-5 text-success" : "h-5 w-5 text-muted-foreground"} aria-hidden="true" />
        <span className="font-medium">{label}</span>
      </div>
      <span className="rounded-full bg-muted px-2 py-1 text-xs font-semibold">{booleanStatus(ok)}</span>
    </div>
  );
}

export default async function SettingsPage() {
  const supabaseConnected = await getSupabaseConnected();
  const supabaseUrlConfigured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const supabaseAnonConfigured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const serviceRoleConfigured = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const telegramConfigured = Boolean(process.env.TELEGRAM_BOT_TOKEN);
  const geminiConfigured = Boolean(process.env.GEMINI_API_KEY);
  const markChatConfigured = Boolean(process.env.MARK_INTERNAL_CHAT_ID);
  const deploymentMode = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown";

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-normal">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Configuration health checks without exposing secret values.</p>
      </header>

      <Card className="border-warning/30 bg-warning/10">
        <div className="flex gap-3">
          <AlertTriangle className="mt-1 h-5 w-5 text-warning" aria-hidden="true" />
          <div>
            <h2 className="font-bold">Never expose API keys in the frontend</h2>
            <p className="mt-1 text-sm text-muted-foreground">Service role, Telegram token, and Gemini key must never be exposed to client components. This page checks presence, not values.</p>
          </div>
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <EnvRow label="Supabase connected" ok={supabaseConnected} />
        <EnvRow label="Supabase URL configured" ok={supabaseUrlConfigured} />
        <EnvRow label="Supabase anon key configured" ok={supabaseAnonConfigured} />
        <EnvRow label="Service role key configured" ok={serviceRoleConfigured} />
        <EnvRow label="Telegram token configured" ok={telegramConfigured} />
        <EnvRow label="Gemini key configured" ok={geminiConfigured} />
        <EnvRow label="Mark internal chat id configured" ok={markChatConfigured} />
      </div>

      <Card>
        <h2 className="font-bold">Deployment mode</h2>
        <p className="mt-2 text-sm text-muted-foreground">{deploymentMode}</p>
      </Card>
    </div>
  );
}
