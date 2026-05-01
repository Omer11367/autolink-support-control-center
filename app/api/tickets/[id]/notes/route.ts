import { NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type NoteRequest = {
  noteText?: string;
};

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const body = (await request.json()) as NoteRequest;
    const noteText = body.noteText?.trim();

    if (!noteText) {
      return NextResponse.json({ error: "Note text is required." }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const { data, error } = await supabase
      .from("ticket_notes")
      .insert({
        ticket_id: params.id,
        note_text: noteText
      })
      .select("*")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, note: data });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Note create failed." },
      { status: 500 }
    );
  }
}
