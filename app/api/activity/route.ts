import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export type ActivityItem = {
  id: string;
  ticketCode: string | null;
  clientChatId: string;
  clientName: string;
  category: string;
  intent: string | null;
  message: string | null;
  status: string | null;
  createdAt: string;
  photoFileIds: string[];
};

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
    if (msg?.photo && msg.photo.length > 0) {
      return [msg.photo[msg.photo.length - 1].file_id];
    }
  } catch {}
  return [];
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search")?.toLowerCase() ?? "";
  const category = searchParams.get("category") ?? "";
  const client = searchParams.get("client") ?? "";
  const start = searchParams.get("start") ?? "";
  const end = searchParams.get("end") ?? "";

  const supabase = createSupabaseAdminClient();

  const [{ data: tickets }, { data: clientGroupsData }, { data: photoMessages }] = await Promise.all([
    supabase
      .from("tickets")
      .select("id, ticket_code, client_chat_id, intent, status, client_original_message, created_at, client_username")
      .order("created_at", { ascending: false })
      .limit(1000),
    supabase.from("client_groups").select("telegram_chat_id, group_name"),
    supabase
      .from("messages")
      .select("telegram_chat_id, raw_payload, created_at, telegram_message_id")
      .eq("message_type", "client_photo")
      .order("created_at", { ascending: false })
      .limit(2000)
  ]);

  const groupNameMap = new Map<string, string>(
    (clientGroupsData ?? []).map((cg) => [String(cg.telegram_chat_id), cg.group_name ?? String(cg.telegram_chat_id)])
  );

  // Build a map: clientChatId → list of photo file IDs (with timestamp for matching)
  type PhotoEntry = { fileId: string; createdAt: string };
  const photosByChat = new Map<string, PhotoEntry[]>();
  for (const msg of photoMessages ?? []) {
    const chatId = String(msg.telegram_chat_id ?? "");
    if (!chatId) continue;
    const fileIds = extractPhotoFileIds(msg.raw_payload);
    for (const fileId of fileIds) {
      const existing = photosByChat.get(chatId) ?? [];
      existing.push({ fileId, createdAt: msg.created_at ?? "" });
      photosByChat.set(chatId, existing);
    }
  }

  let items: ActivityItem[] = (tickets ?? []).map((t) => {
    const chatId = String(t.client_chat_id ?? "");
    const cat = intentToCategory(t.intent);

    // Match photos from same chat within ±10 minutes of this ticket
    const ticketMs = t.created_at ? new Date(t.created_at).getTime() : 0;
    const relatedPhotos = (photosByChat.get(chatId) ?? [])
      .filter((p) => {
        const pMs = p.createdAt ? new Date(p.createdAt).getTime() : 0;
        return Math.abs(pMs - ticketMs) < 10 * 60 * 1000;
      })
      .map((p) => p.fileId);

    return {
      id: t.id,
      ticketCode: t.ticket_code ?? null,
      clientChatId: chatId,
      clientName: groupNameMap.get(chatId) ?? t.client_username ?? chatId,
      category: cat,
      intent: t.intent ?? null,
      message: t.client_original_message ?? null,
      status: t.status ?? null,
      createdAt: t.created_at ?? "",
      photoFileIds: relatedPhotos
    };
  });

  // Filters
  if (search) {
    items = items.filter(
      (i) =>
        i.clientName.toLowerCase().includes(search) ||
        (i.message ?? "").toLowerCase().includes(search) ||
        i.category.toLowerCase().includes(search)
    );
  }
  if (category) items = items.filter((i) => i.category === category);
  if (client) items = items.filter((i) => i.clientChatId === client || i.clientName === client);
  if (start) items = items.filter((i) => i.createdAt >= start);
  if (end) items = items.filter((i) => i.createdAt <= end + "T23:59:59");

  return NextResponse.json({ items });
}
