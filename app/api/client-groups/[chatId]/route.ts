import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function POST(
  request: Request,
  { params }: { params: { chatId: string } }
) {
  const body = await request.json() as {
    markGroupId?: string | null;
    groupName?: string | null;
    groupType?: string | null;
  };
  const supabase = createSupabaseAdminClient();
  const chatId = params.chatId;

  // When classifying as agency: ensure a mark_groups entry exists so the
  // routing map (clientChatId → agency telegram_chat_id) resolves correctly.
  if (body.groupType === "agency") {
    const name = body.groupName ?? chatId;
    const { data: existing } = await supabase
      .from("mark_groups")
      .select("id")
      .eq("telegram_chat_id", chatId)
      .maybeSingle();
    if (!existing) {
      await supabase.from("mark_groups").insert({ name, telegram_chat_id: chatId });
    } else {
      await supabase.from("mark_groups").update({ name }).eq("telegram_chat_id", chatId);
    }
  }

  const { error } = await supabase
    .from("client_groups")
    .upsert(
      {
        telegram_chat_id: chatId,
        group_name: body.groupName ?? null,
        // Agency and Master groups are not assigned to another agency
        mark_group_id: (body.groupType === "agency" || body.groupType === "master") ? null : (body.markGroupId ?? null),
        group_type: body.groupType ?? null,
        updated_at: new Date().toISOString()
      },
      { onConflict: "telegram_chat_id" }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Trigger an immediate batch so queued messages from this client are routed to the
  // new agency right away instead of waiting up to 5 minutes for the next cron cycle.
  const batchUrl = new URL("/api/telegram-batch", request.url);
  fetch(batchUrl.toString(), { method: "POST" }).catch((e) => {
    console.error("routing-change-batch-trigger-failed", { error: e instanceof Error ? e.message : "unknown" });
  });

  return NextResponse.json({ ok: true });
}
