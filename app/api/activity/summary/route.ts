import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export type ClientSummary = {
  chatId: string;
  clientName: string;
  agencyName: string | null;
  lastActivity: string;
  lastMessage: string | null;
  open: number;
  total: number;
  byCategory: {
    Deposit: number;
    Share: number;
    Unshare: number;
    "Payment Issue": number;
    "Account Creation": number;
    Verification: number;
    Bans: number;
    General: number;
  };
};

function intentToCategory(intent: string | null): keyof ClientSummary["byCategory"] {
  const n = String(intent ?? "").toLowerCase();
  if (n === "deposit_funds") return "Deposit";
  if (["share_ad_account", "transfer_ad_account"].includes(n)) return "Share";
  if (n === "unshare_ad_account") return "Unshare";
  if (["payment_issue", "refund_request"].includes(n)) return "Payment Issue";
  if (n === "process_account_creation") return "Account Creation";
  if (n === "verify_account") return "Verification";
  if (["request_data_banned_accounts", "check_policy"].includes(n)) return "Bans";
  return "General";
}

export async function GET() {
  const supabase = createSupabaseAdminClient();

  const [{ data: tickets }, { data: clientGroups }, { data: markGroups }] = await Promise.all([
    supabase
      .from("tickets")
      .select("id, client_chat_id, intent, status, client_original_message, created_at, client_username")
      .order("created_at", { ascending: false })
      .limit(2000),
    supabase.from("client_groups").select("telegram_chat_id, group_name, mark_group_id, group_type"),
    supabase.from("mark_groups").select("id, name")
  ]);

  const groupNameMap = new Map((clientGroups ?? []).map((cg) => [String(cg.telegram_chat_id), cg]));
  const agencyNameMap = new Map((markGroups ?? []).map((mg) => [mg.id, mg.name]));

  const byClient = new Map<string, ClientSummary>();

  for (const t of tickets ?? []) {
    const chatId = String(t.client_chat_id ?? "");
    if (!chatId) continue;

    const cg = groupNameMap.get(chatId);
    const clientName = cg?.group_name ?? t.client_username ?? chatId;
    const agencyName = cg?.mark_group_id ? (agencyNameMap.get(cg.mark_group_id) ?? null) : null;
    const category = intentToCategory(t.intent);
    const isOpen = !["closed", "resolved", "done"].includes((t.status ?? "").toLowerCase());

    if (!byClient.has(chatId)) {
      byClient.set(chatId, {
        chatId,
        clientName,
        agencyName,
        lastActivity: t.created_at ?? "",
        lastMessage: t.client_original_message ?? null,
        open: 0,
        total: 0,
        byCategory: { Deposit: 0, Share: 0, Unshare: 0, "Payment Issue": 0, "Account Creation": 0, Verification: 0, Bans: 0, General: 0 }
      });
    }

    const s = byClient.get(chatId)!;
    s.total++;
    if (isOpen) s.open++;
    s.byCategory[category]++;
    if (t.created_at && t.created_at > s.lastActivity) {
      s.lastActivity = t.created_at;
      s.lastMessage = t.client_original_message ?? null;
    }
  }

  // Sort: clients with open requests first, then by last activity
  const summaries = Array.from(byClient.values()).sort((a, b) => {
    if (b.open !== a.open) return b.open - a.open;
    return b.lastActivity.localeCompare(a.lastActivity);
  });

  return NextResponse.json({ summaries });
}
