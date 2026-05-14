import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { ActivityItem } from "@/app/api/activity/route";

export const dynamic = "force-dynamic";

function intentToCategory(intent: string | null): string {
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

function extractPhotoFileIds(rawPayload: unknown): string[] {
  try {
    const msg = (rawPayload as { message?: { photo?: Array<{ file_id: string }> } } | null)?.message;
    if (msg?.photo && msg.photo.length > 0) return [msg.photo[msg.photo.length - 1].file_id];
  } catch {}
  return [];
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const chatId = searchParams.get("chatId");
  if (!chatId) return NextResponse.json({ error: "missing chatId" }, { status: 400 });

  const supabase = createSupabaseAdminClient();

  const [{ data: tickets }, { data: clientGroups }, { data: markGroups }, { data: photoMessages }] = await Promise.all([
    supabase
      .from("tickets")
      .select("id, ticket_code, client_chat_id, intent, status, client_original_message, created_at, client_username")
      .eq("client_chat_id", chatId)
      .order("created_at", { ascending: false })
      .limit(500),
    supabase.from("client_groups").select("telegram_chat_id, group_name, mark_group_id"),
    supabase.from("mark_groups").select("id, name, telegram_chat_id"),
    supabase
      .from("messages")
      .select("raw_payload, created_at")
      .eq("telegram_chat_id", chatId)
      .eq("message_type", "client_photo")
      .order("created_at", { ascending: false })
      .limit(200)
  ]);

  const cg = (clientGroups ?? []).find((c) => String(c.telegram_chat_id) === chatId);
  const clientName = cg?.group_name ?? chatId;
  const agency = cg?.mark_group_id ? (markGroups ?? []).find((m) => m.id === cg.mark_group_id) : null;

  const photos = (photoMessages ?? []).map((m) => ({
    fileIds: extractPhotoFileIds(m.raw_payload),
    createdAt: m.created_at ?? ""
  }));

  const items: ActivityItem[] = (tickets ?? []).map((t) => {
    const ticketMs = t.created_at ? new Date(t.created_at).getTime() : 0;
    const relatedPhotos = photos
      .filter((p) => p.createdAt && Math.abs(new Date(p.createdAt).getTime() - ticketMs) < 10 * 60 * 1000)
      .flatMap((p) => p.fileIds);

    return {
      id: t.id,
      ticketCode: t.ticket_code ?? null,
      clientChatId: chatId,
      clientName,
      category: intentToCategory(t.intent),
      intent: t.intent ?? null,
      message: t.client_original_message ?? null,
      status: t.status ?? null,
      createdAt: t.created_at ?? "",
      photoFileIds: relatedPhotos
    };
  });

  return NextResponse.json({
    clientName,
    agencyName: agency?.name ?? null,
    agencyChatId: agency?.telegram_chat_id ?? null,
    items
  });
}
