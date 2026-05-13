import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function POST(
  request: Request,
  { params }: { params: { chatId: string } }
) {
  const body = await request.json() as { markGroupId?: string | null; groupName?: string };
  const supabase = createSupabaseAdminClient();
  const { error } = await supabase
    .from("client_groups")
    .upsert(
      {
        telegram_chat_id: params.chatId,
        group_name: body.groupName ?? null,
        mark_group_id: body.markGroupId ?? null,
        updated_at: new Date().toISOString()
      },
      { onConflict: "telegram_chat_id" }
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
