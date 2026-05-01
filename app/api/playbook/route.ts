import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const supabase = createSupabaseAdminClient();

    const { data, error } = await supabase
      .from("playbook_entries")
      .insert({
        intent: body.intent,
        title: body.title,
        description: body.description,
        detection_rules: body.detection_rules,
        first_response_examples: body.first_response_examples ?? [],
        completion_examples: body.completion_examples ?? [],
        escalation_rules: body.escalation_rules,
        is_active: body.is_active ?? true
      })
      .select("*")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unexpected playbook create failure." },
      { status: 500 }
    );
  }
}
