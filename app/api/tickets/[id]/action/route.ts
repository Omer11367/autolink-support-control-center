import { NextResponse } from "next/server";
import { actionLabel, resolveCompletionMessage, type MarkActionType } from "@/lib/playbook";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { maybeSendTelegramMessage } from "@/lib/telegram";
import type { Ticket } from "@/lib/types";

type ActionRequest = {
  actionType: MarkActionType;
  customReply?: string;
};

const allowedActions: MarkActionType[] = [
  "done",
  "already_shared",
  "only_view_access",
  "funds_arrived",
  "not_available",
  "handled",
  "close",
  "custom_reply"
];

function nextStatus(actionType: MarkActionType) {
  if (actionType === "close") return "closed";
  return "resolved";
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const body = (await request.json()) as ActionRequest;
    const actionType = body.actionType;

    if (!actionType || !allowedActions.includes(actionType)) {
      return NextResponse.json({ error: "Invalid actionType." }, { status: 400 });
    }

    if (actionType === "custom_reply" && !body.customReply?.trim()) {
      return NextResponse.json({ error: "Custom reply cannot be empty." }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const { data: ticketRow, error: ticketError } = await supabase.from("tickets").select("*").eq("id", params.id).single();

    if (ticketError || !ticketRow) {
      return NextResponse.json({ error: ticketError?.message ?? "Ticket not found." }, { status: 404 });
    }

    const ticket = ticketRow as Ticket;
    const completionMessage = resolveCompletionMessage(actionType, ticket.client_username, body.customReply);
    const status = nextStatus(actionType);

    const { error: actionError } = await supabase.from("mark_actions").insert({
      ticket_id: params.id,
      mark_telegram_user_id: null,
      mark_username: "dashboard_admin",
      action_type: actionType,
      action_text: actionType === "custom_reply" ? body.customReply : actionLabel(actionType),
      raw_payload: {
        source: "control_center",
        action_type: actionType,
        completion_message: completionMessage
      }
    });

    if (actionError) {
      return NextResponse.json({ error: actionError.message }, { status: 500 });
    }

    const { error: updateError } = await supabase
      .from("tickets")
      .update({
        status,
        needs_mark: false,
        completion_message: completionMessage || ticket.completion_message,
        updated_at: new Date().toISOString()
      })
      .eq("id", params.id);

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    let telegramSent = false;
    let telegramSkippedReason: string | null = null;

    if (actionType !== "close" && completionMessage && ticket.client_chat_id) {
      try {
        const telegramResult = await maybeSendTelegramMessage({
          chatId: ticket.client_chat_id,
          text: completionMessage
        });

        telegramSent = telegramResult.sent;
        telegramSkippedReason = telegramResult.reason;

        if (telegramResult.sent) {
          const { error: responseError } = await supabase.from("bot_responses").insert({
            ticket_id: params.id,
            telegram_chat_id: ticket.client_chat_id,
            telegram_message_id: telegramResult.telegramMessageId,
            response_type: actionType === "custom_reply" ? "custom_completion" : "completion",
            response_text: completionMessage
          });

          if (responseError) {
            return NextResponse.json({ error: responseError.message }, { status: 500 });
          }
        }
      } catch (telegramError) {
        telegramSkippedReason = telegramError instanceof Error ? telegramError.message : "Telegram send failed.";
        await supabase.from("bot_responses").insert({
          ticket_id: params.id,
          telegram_chat_id: ticket.client_chat_id,
          telegram_message_id: null,
          response_type: "telegram_error",
          response_text: telegramSkippedReason
        });
      }
    } else if (actionType !== "close") {
      telegramSkippedReason = "Missing client chat id or completion message.";
    }

    return NextResponse.json({
      ok: true,
      status,
      completionMessage,
      telegramSent,
      telegramSkippedReason
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unexpected action failure." },
      { status: 500 }
    );
  }
}
