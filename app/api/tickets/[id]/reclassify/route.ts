import { NextResponse } from "next/server";
import { classifyIntent } from "@/lib/intent-classifier";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Ticket } from "@/lib/types";

function shouldMoveToWaitingMark(status?: string | null) {
  const normalized = (status ?? "unknown").toLowerCase();
  return ["new", "open", "other", "unknown", ""].includes(normalized);
}

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  try {
    const supabase = createSupabaseAdminClient();
    const { data: ticketRow, error: ticketError } = await supabase.from("tickets").select("*").eq("id", params.id).single();

    if (ticketError || !ticketRow) {
      return NextResponse.json({ error: ticketError?.message ?? "Ticket not found." }, { status: 404 });
    }

    const ticket = ticketRow as Ticket;
    const result = classifyIntent(ticket.client_original_message ?? "");

    const nextStatus = result.requiresMark && shouldMoveToWaitingMark(ticket.status)
      ? "waiting_mark"
      : ticket.status;

    const { error: updateError } = await supabase
      .from("tickets")
      .update({
        intent: result.intent,
        extracted_data: result.extractedData,
        internal_summary: result.internalSummary,
        needs_mark: result.requiresMark,
        status: nextStatus,
        updated_at: new Date().toISOString()
      })
      .eq("id", params.id);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Reclassify failed." },
      { status: 500 }
    );
  }
}
