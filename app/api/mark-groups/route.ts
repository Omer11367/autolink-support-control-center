import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function GET() {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("mark_groups")
    .select("*")
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ markGroups: data ?? [] });
}

export async function POST(request: Request) {
  const body = await request.json() as { name?: string; telegramChatId?: string };
  const name = body.name?.trim();
  const telegramChatId = body.telegramChatId?.trim();
  if (!name || !telegramChatId) {
    return NextResponse.json({ error: "name and telegramChatId are required" }, { status: 400 });
  }
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("mark_groups")
    .insert({ name, telegram_chat_id: telegramChatId })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ markGroup: data });
}
