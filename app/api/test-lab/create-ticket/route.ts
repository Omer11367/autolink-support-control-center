import { NextResponse } from "next/server";
import { classifyIntent } from "@/lib/intent-classifier";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type CreateTestTicketRequest = {
  message?: string;
  previousContext?: string;
};

function createTicketCode() {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `TEST-${stamp}-${suffix}`;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CreateTestTicketRequest;
    const message = body.message?.trim();

    if (!message) {
      return NextResponse.json({ error: "Message is required." }, { status: 400 });
    }

    const result = classifyIntent(message, body.previousContext ?? "");
    const supabase = createSupabaseAdminClient();
    const priority = ["deposit_funds", "refund_request", "payment_issue", "check_policy"].includes(result.intent) ? "high" : "normal";
    const { data, error } = await supabase
      .from("tickets")
      .insert({
        ticket_code: createTicketCode(),
        client_chat_id: 0,
        client_message_id: null,
        client_user_id: null,
        client_username: "test_client",
        intent: result.intent,
        status: result.requiresMark ? "waiting_mark" : "new",
        priority,
        needs_mark: result.requiresMark,
        client_original_message: message,
        extracted_data: result.extractedData,
        internal_summary: result.internalSummary,
        completion_message: result.completionOptions[0] ?? null
      })
      .select("id,ticket_code")
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, ticket: data, classification: result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Create test ticket failed." },
      { status: 500 }
    );
  }
}
