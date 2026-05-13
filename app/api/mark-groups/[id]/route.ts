import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createSupabaseAdminClient();
  // Unassign all client groups that point to this mark group first
  await supabase
    .from("client_groups")
    .update({ mark_group_id: null, updated_at: new Date().toISOString() })
    .eq("mark_group_id", params.id);
  const { error } = await supabase
    .from("mark_groups")
    .delete()
    .eq("id", params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  const body = await request.json() as { name?: string; telegramChatId?: string };
  const update: Record<string, string> = {};
  if (body.name?.trim()) update.name = body.name.trim();
  if (body.telegramChatId?.trim()) update.telegram_chat_id = body.telegramChatId.trim();
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("mark_groups")
    .update(update)
    .eq("id", params.id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ markGroup: data });
}
