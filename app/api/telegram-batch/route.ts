import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { maybeSendTelegramMessage } from "@/lib/telegram";

type BatchTicket = {
  id: string;
  intent: string | null;
  client_chat_id: string | number | null;
  client_original_message: string | null;
  extracted_data: unknown;
  internal_summary: string | null;
  created_at: string | null;
};

type SheetAction = {
  type?: string;
  account?: string;
  accounts?: string[];
  bm?: string;
  amount?: string;
};

const CATEGORY_ORDER = ["Share", "Unshare", "Deposits", "Payment Issues", "General"] as const;
const CLIENT_BATCH_REPLY = "Understood, I’ll update you once I have confirmation.";

function firstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function requireEnv(label: string, names: string[]): string {
  const value = firstEnv(names);
  if (!value) throw new Error(`Missing environment variable: ${label}`);
  return value;
}

function mapIntentToCategory(intent: string | null | undefined): typeof CATEGORY_ORDER[number] {
  const normalized = String(intent || "").toLowerCase();
  if (["share_ad_account", "transfer_ad_account"].includes(normalized)) return "Share";
  if (["unshare_ad_account"].includes(normalized)) return "Unshare";
  if (["deposit_funds"].includes(normalized)) return "Deposits";
  if (["payment_issue"].includes(normalized)) return "Payment Issues";
  return "General";
}

function getActions(extractedData: unknown): SheetAction[] {
  if (!extractedData || typeof extractedData !== "object" || Array.isArray(extractedData)) return [];
  const actions = (extractedData as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return [];
  return actions.filter((action): action is SheetAction => Boolean(action) && typeof action === "object");
}

function firstAccount(action: SheetAction | undefined): string | null {
  return action?.account ?? action?.accounts?.[0] ?? null;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function extractAmount(text: string): string | null {
  const match = text.match(/(?:\$|usd\s*)?\d+(?:[,.]\d+)?\s*(?:k|K)?\s*(?:usdt|usd|dollars?|\$)?/i);
  return match?.[0] ? compactText(match[0]).replace(/\s+/g, "") : null;
}

function cleanTaskText(ticket: BatchTicket): string {
  const category = mapIntentToCategory(ticket.intent);
  const original = compactText(ticket.client_original_message ?? "");
  const actions = getActions(ticket.extracted_data);
  const shareAction = actions.find((action) => action.type === "share_account");
  const unshareAction = actions.find((action) => action.type === "unshare_account");
  const paymentAction = actions.find((action) => action.type === "payment_check");
  const accountStatusAction = actions.find((action) => action.type === "account_status_check");

  if (category === "Share") {
    const account = firstAccount(shareAction);
    if (account && shareAction?.bm) return `share account ${account} to BM ${shareAction.bm}`;
    if (account) return `share account ${account}`;
  }

  if (category === "Unshare") {
    const account = firstAccount(unshareAction);
    if (account && unshareAction?.bm) return `unshare account ${account} from BM ${unshareAction.bm}`;
    if (account) return `unshare account ${account}`;
  }

  if (category === "Deposits") {
    const amount = paymentAction?.amount ?? extractAmount(original);
    return amount ? `sent ${amount}` : (original || "deposit check request");
  }

  if (category === "Payment Issues") {
    const account = firstAccount(accountStatusAction);
    if (account) return `payment issue on account ${account}`;
  }

  return original || "general support request";
}

function buildMarkSummary(tickets: BatchTicket[]): string {
  const grouped = new Map<typeof CATEGORY_ORDER[number], string[]>();
  for (const category of CATEGORY_ORDER) grouped.set(category, []);

  for (const ticket of tickets) {
    const category = mapIntentToCategory(ticket.intent);
    grouped.get(category)?.push(cleanTaskText(ticket));
  }

  const sections = CATEGORY_ORDER
    .map((category) => {
      const items = grouped.get(category) ?? [];
      if (items.length === 0) return null;
      return [`${category.toUpperCase()}`, ...items.map((item) => `- ${escapeTelegramHtml(item)}`)].join("\n");
    })
    .filter(Boolean);

  return ["📌 NEW REQUESTS BATCH", ...sections].join("\n\n");
}

async function handleBatch(request: Request) {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (cronSecret && request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  console.log("batch-start");

  requireEnv("TELEGRAM_BOT_TOKEN", ["TELEGRAM_BOT_TOKEN"]);
  const markGroupChatId = requireEnv("MARK_GROUP_CHAT_ID or MARK_INTERNAL_CHAT_ID", ["MARK_GROUP_CHAT_ID", "MARK_INTERNAL_CHAT_ID"]);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL", ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]);
  const serviceRoleKey = requireEnv("SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY", ["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });

  const { data, error } = await supabase
    .from("tickets")
    .select("id, intent, client_chat_id, client_original_message, extracted_data, internal_summary, created_at")
    .eq("needs_mark", true)
    .in("status", ["open", "new", "waiting_mark", "waiting_for_mark"])
    .is("internal_message_id", null)
    .is("holding_message_id", null)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) throw new Error(`Supabase tickets batch query failed: ${error.message}`);

  const tickets = (data ?? []) as BatchTicket[];
  console.log("batch-found-requests", { count: tickets.length });

  if (tickets.length === 0) {
    console.log("batch-no-requests");
    return NextResponse.json({ ok: true, count: 0 });
  }

  const markSummary = buildMarkSummary(tickets);
  const markSendResult = await maybeSendTelegramMessage({ chatId: markGroupChatId, text: markSummary });
  if (!markSendResult.sent || !markSendResult.telegramMessageId) {
    throw new Error(markSendResult.reason ?? "Mark batch summary was not sent.");
  }
  console.log("batch-mark-summary-sent", { count: tickets.length, telegramMessageId: markSendResult.telegramMessageId });

  await supabase.from("bot_responses").insert({
    ticket_id: tickets[0]?.id ?? null,
    telegram_chat_id: markGroupChatId,
    telegram_message_id: markSendResult.telegramMessageId,
    response_type: "batch_mark_summary",
    response_text: markSummary
  });

  const ticketsByClient = new Map<string, BatchTicket[]>();
  for (const ticket of tickets) {
    if (!ticket.client_chat_id) continue;
    const key = String(ticket.client_chat_id);
    ticketsByClient.set(key, [...(ticketsByClient.get(key) ?? []), ticket]);
  }

  let clientReplyCount = 0;
  for (const [clientChatId, clientTickets] of ticketsByClient.entries()) {
    try {
      const clientSendResult = await maybeSendTelegramMessage({ chatId: clientChatId, text: CLIENT_BATCH_REPLY });
      clientReplyCount += 1;

      await supabase.from("bot_responses").insert({
        ticket_id: clientTickets[0]?.id ?? null,
        telegram_chat_id: clientChatId,
        telegram_message_id: clientSendResult.telegramMessageId,
        response_type: "batch_client_reply",
        response_text: CLIENT_BATCH_REPLY
      });

      const clientTicketIds = clientTickets.map((ticket) => ticket.id);
      await supabase
        .from("tickets")
        .update({ holding_message_id: clientSendResult.telegramMessageId, updated_at: new Date().toISOString() })
        .in("id", clientTicketIds);
    } catch (error) {
      console.error("telegram-batch-client-reply-error", {
        clientChatId,
        error: error instanceof Error ? error.message : "Client batch reply failed."
      });
    }
  }
  console.log("batch-client-replies-sent", { clientGroups: clientReplyCount });

  for (const ticket of tickets) {
    const { error: updateError } = await supabase
      .from("tickets")
      .update({ internal_message_id: markSendResult.telegramMessageId, updated_at: new Date().toISOString() })
      .eq("id", ticket.id)
      .is("internal_message_id", null);

    if (updateError) {
      console.error("supabase-update-error", { table: "tickets", ticketId: ticket.id, message: updateError.message });
      continue;
    }

    console.log("batch-request-marked-processed", { ticketId: ticket.id });
  }

  return NextResponse.json({ ok: true, count: tickets.length, clientGroups: clientReplyCount });
}

export async function GET(request: Request) {
  try {
    return await handleBatch(request);
  } catch (error) {
    console.error("telegram-batch-error", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Unexpected telegram batch error." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  return GET(request);
}
