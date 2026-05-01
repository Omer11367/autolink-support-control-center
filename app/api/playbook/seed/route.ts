import { NextResponse } from "next/server";
import { PLAYBOOK_SEED } from "@/lib/playbook";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export async function POST() {
  try {
    const supabase = createSupabaseAdminClient();
    const { data: existing, error: existingError } = await supabase.from("playbook_entries").select("intent");

    if (existingError) {
      return NextResponse.json({ error: existingError.message }, { status: 500 });
    }

    const existingIntents = new Set((existing ?? []).map((entry) => entry.intent));
    const missingEntries = PLAYBOOK_SEED.filter((entry) => !existingIntents.has(entry.intent));

    if (missingEntries.length === 0) {
      return NextResponse.json({ ok: true, inserted: 0 });
    }

    const { error: insertError } = await supabase.from("playbook_entries").insert(missingEntries);

    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, inserted: missingEntries.length });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unexpected seed failure." },
      { status: 500 }
    );
  }
}
