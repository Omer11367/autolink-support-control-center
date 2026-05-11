import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";

type TelegramChat = {
  id: number;
  title?: string;
  type?: string;
};

type TelegramUser = {
  id?: number;
  username?: string;
  first_name?: string;
  last_name?: string;
};

type TelegramMessage = {
  message_id: number;
  date?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  reply_to_message?: {
    message_id?: number;
    text?: string;
    caption?: string;
  };
  text?: string;
  caption?: string;
  photo?: Array<{
    file_id: string;
    file_unique_id?: string;
    width?: number;
    height?: number;
    file_size?: number;
  }>;
  document?: {
    file_id: string;
    file_unique_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
};

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

function isImageDocument(document?: TelegramMessage["document"]): boolean {
  return Boolean(document?.file_id && document.mime_type?.toLowerCase().startsWith("image/"));
}

// Returns true when an employee reply from Mark's group is just a holding acknowledgment
// ("got it", "on it", "we'll check", etc.) that the client already received from the bot.
// These should NOT be forwarded — only real answers (resolutions, updates, results) go to clients.
function isEmployeeHoldingAck(text: string): boolean {
  const t = text.trim().toLowerCase().replace(/[!?.，。]+$/, "");
  // Exact short acks
  if (/^(ok|okay|got it|on it|noted|sure|copy|received|understood|will do|checking|check|yep|yup)$/.test(t)) return true;
  // "We'll / I'll / Let me check/look/handle"
  if (/\b(we'?ll|i'?ll|let me|will)\s+(check|look into|handle|take care of|get back)/.test(t)) return true;
  // "Looking / checking / working on it/this"
  if (/\b(looking|checking|working)\s+(into|on|at)\s+(it|this)/.test(t)) return true;
  // "On it / handling this"
  if (/^(on|handling)\s+(it|this)$/.test(t)) return true;
  // "We're on it / we got this"
  if (/^(we'?re on it|we got (it|this)|got this)$/.test(t)) return true;
  return false;
}

// Maps an intent string to a broad category label — mirrors the logic in telegram-batch/route.ts
// but kept local here so the webhook has no dependency on the batch route module.
function intentToCategory(intent: string | null): string {
  const n = String(intent ?? "").toLowerCase();
  if (["share_ad_account", "transfer_ad_account"].includes(n)) return "Share";
  if (n === "unshare_ad_account") return "Unshare";
  if (n === "deposit_funds") return "Deposits";
  if (["payment_issue", "refund_request"].includes(n)) return "Payment Issues";
  if (n === "verify_account") return "Verification";
  if (["check_account_status", "request_data_banned_accounts", "check_policy"].includes(n)) return "Account Issues";
  return "General";
}

// Decides whether an employee's reply message is relevant to a specific client's tickets.
// Used when the batch contained requests from multiple clients: routes the reply only to
// the client(s) whose topic the employee is addressing.
function isRelevantForClient(
  employeeLower: string,
  tickets: Array<{ intent: string | null; chatTitle: string | null }>
): boolean {
  // 1. Check if the employee mentioned the client's group name.
  for (const t of tickets) {
    const title = (t.chatTitle ?? "").toLowerCase();
    if (title && employeeLower.includes(title)) return true;
  }

  // 2. Match by category keywords in the employee's reply.
  const categories = tickets.map((t) => intentToCategory(t.intent));
  if (categories.includes("Deposits") && /\b(deposit|funds?|payment|confirmed|wallet|added|money|usdt|usd|transferred|crypto)\b/.test(employeeLower)) return true;
  if (categories.includes("Share") && /\b(shar(ed?|ing)|access\s+grant(ed)?|added?\s+(to\s+)?bm|link(ed)?|connected)\b/.test(employeeLower)) return true;
  if (categories.includes("Unshare") && /\b(unshar(ed?|ing)|remov(ed?|ing)|access\s+revok(ed)?|unlink(ed)?)\b/.test(employeeLower)) return true;
  if (categories.includes("Verification") && /\b(verif(ied|ication)?|card\s+check(ed)?)\b/.test(employeeLower)) return true;
  if (categories.includes("Payment Issues") && /\b(payment|card|billing|charge|invoice)\b/.test(employeeLower)) return true;
  if (categories.includes("Account Issues") && /\b(account|disabled|enabled|restor(ed)?|banned|blocked)\b/.test(employeeLower)) return true;
  // General questions: forward if the reply is a substantive sentence (>15 chars).
  if (categories.includes("General") && employeeLower.length > 15) return true;

  return false;
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    env: {
      telegramBotToken: Boolean(firstEnv(["TELEGRAM_BOT_TOKEN"])),
      markGroupChatId: Boolean(firstEnv(["MARK_GROUP_CHAT_ID", "MARK_INTERNAL_CHAT_ID"])),
      supabaseUrl: Boolean(firstEnv(["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"])),
      serviceRoleKey: Boolean(firstEnv(["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]))
    }
  });
}

export async function POST(request: Request) {
  try {
    const markGroupChatId = requireEnv("MARK_GROUP_CHAT_ID or MARK_INTERNAL_CHAT_ID", ["MARK_GROUP_CHAT_ID", "MARK_INTERNAL_CHAT_ID"]);
    const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL", ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]);
    const serviceRoleKey = requireEnv("SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY", ["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);

    const supabase = createClient<Database, "public">(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const update = (await request.json()) as TelegramUpdate;
    const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;

    if (!message?.chat?.id) {
      return NextResponse.json({ ok: true, ignored: "no_message" });
    }

    const chatId = message.chat.id;

    // ── Employee message from Mark's internal group ──────────────────────────────────────────────
    // When an employee replies to the batch summary, the bot analyzes their text and forwards
    // it to the right client group(s).
    //
    // How routing works:
    //  1. Employee must use Telegram's Reply feature on the batch summary message.
    //  2. The bot looks up all tickets that share that summary's internal_message_id.
    //  3. Holding acks ("got it", "we'll check", etc.) are ignored — client already has that.
    //  4. Real answers are matched to the relevant client(s) by category keywords or group name.
    //  5. The message is forwarded to each matched client group.
    if (String(chatId) === String(markGroupChatId)) {
      const employeeText = (message.text ?? message.caption ?? "").trim();
      if (!employeeText) {
        return NextResponse.json({ ok: true, ignored: "empty" });
      }

      // Holding acks are silently dropped — client already has the bot's auto-ack.
      if (isEmployeeHoldingAck(employeeText)) {
        console.log("mark-employee-holding-ack-ignored", { messageId: message.message_id });
        return NextResponse.json({ ok: true, ignored: "holding_ack" });
      }

      // Resolve the batch summary message_id to look up tickets.
      // Prefer an explicit Telegram reply (the employee tapped Reply on the summary).
      // Fall back to the most recent batch summary sent to this group — this handles the
      // common case where the employee just types a response without using the Reply feature.
      let replyToMsgId: number | null = message.reply_to_message?.message_id ?? null;

      if (!replyToMsgId) {
        const lookbackIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: latestSummary } = await supabase
          .from("bot_responses")
          .select("telegram_message_id")
          .eq("telegram_chat_id", String(markGroupChatId))
          .eq("response_type", "batch_mark_summary")
          .gte("created_at", lookbackIso)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const rawMsgId = (latestSummary as { telegram_message_id?: string | number | null } | null)?.telegram_message_id;
        replyToMsgId = rawMsgId != null ? Number(rawMsgId) : null;
        if (replyToMsgId) {
          console.log("mark-employee-standalone-message-using-latest-summary", { replyToMsgId, messageId: message.message_id });
        }
      }

      if (!replyToMsgId) {
        console.log("mark-group-no-summary-to-route-against", { messageId: message.message_id });
        return NextResponse.json({ ok: true, ignored: "no_summary_found" });
      }

      // Find all tickets from this batch (they all share the same internal_message_id = batch summary msg id).
      const { data: batchTickets, error: ticketError } = await supabase
        .from("tickets")
        .select("id, client_chat_id, intent, extracted_data")
        .eq("internal_message_id", replyToMsgId)
        .not("client_chat_id", "is", null);

      if (ticketError || !batchTickets || batchTickets.length === 0) {
        console.log("mark-reply-no-tickets-found", { replyToMsgId, error: ticketError?.message ?? "no match" });
        return NextResponse.json({ ok: true, ignored: "no_matching_tickets" });
      }

      // Group tickets by client_chat_id.
      const byClient = new Map<string, Array<{ id: string; intent: string | null; chatTitle: string | null }>>();
      for (const t of batchTickets) {
        const key = String(t.client_chat_id);
        const chatTitle = (typeof t.extracted_data === "object" && t.extracted_data !== null)
          ? String((t.extracted_data as Record<string, unknown>).chatTitle ?? "")
          : "";
        byClient.set(key, [...(byClient.get(key) ?? []), { id: t.id, intent: t.intent, chatTitle: chatTitle || null }]);
      }

      // Determine which clients should receive this employee message.
      // If there is only one client in the batch → always forward.
      // If multiple → match by category keywords or group name mention.
      const employeeLower = employeeText.toLowerCase();
      const clientsToForward: string[] = [];

      if (byClient.size === 1) {
        clientsToForward.push(...byClient.keys());
      } else {
        for (const [clientChatId, clientTickets] of byClient.entries()) {
          if (isRelevantForClient(employeeLower, clientTickets)) {
            clientsToForward.push(clientChatId);
          }
        }
        // Fallback: if routing could not determine any specific client, forward to all.
        if (clientsToForward.length === 0) {
          console.log("mark-reply-routing-fallback-all-clients", { clientCount: byClient.size });
          clientsToForward.push(...byClient.keys());
        }
      }

      const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
      if (!token) {
        console.error("mark-reply-forward-no-token");
        return NextResponse.json({ ok: false, error: "Missing bot token" }, { status: 500 });
      }

      const forwardedTo: string[] = [];
      for (const clientChatId of clientsToForward) {
        try {
          const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: clientChatId,
              text: employeeText,
              parse_mode: "HTML",
              disable_web_page_preview: true
            })
          });
          const payload = await res.json();
          if (res.ok && payload.ok) {
            forwardedTo.push(clientChatId);
            console.log("mark-reply-forwarded", { clientChatId, forwardedMsgId: payload.result?.message_id });
          } else {
            console.error("mark-reply-forward-failed", { clientChatId, error: payload.description });
          }
        } catch (fwdErr) {
          console.error("mark-reply-forward-error", { clientChatId, error: fwdErr instanceof Error ? fwdErr.message : "unknown" });
        }
      }

      return NextResponse.json({ ok: true, forwarded: forwardedTo.length, clients: forwardedTo });
    }

    console.log("incoming-message-received", { chatId, messageId: message.message_id });

    const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
    const hasImageAttachment = hasPhoto || isImageDocument(message.document);
    const caption = (message.caption ?? "").trim();
    const text = (message.text ?? caption).trim();
    const clientMessageText = text || (hasImageAttachment ? "Image/screenshot sent by client." : "");

    if (!clientMessageText) {
      return NextResponse.json({ ok: true, ignored: "empty_message" });
    }

    const isEditedMessage = Boolean(update.edited_message || update.edited_channel_post);

    if (isEditedMessage) {
      const { data: existingMessage, error: existingMessageError } = await supabase
        .from("messages")
        .select("id")
        .eq("telegram_message_id", message.message_id)
        .eq("telegram_chat_id", chatId)
        .in("message_type", ["client", "client_photo"])
        .maybeSingle();

      if (existingMessageError) throw new Error(`Supabase edited message lookup failed: ${existingMessageError.message}`);
      if (!existingMessage?.id) {
        console.log("edited-message-no-unprocessed-row", { chatId, messageId: message.message_id });
        return NextResponse.json({ ok: true, ignored: "edited_message_not_queued" });
      }

      const { data: processedTicket, error: processedTicketError } = await supabase
        .from("tickets")
        .select("id")
        .eq("client_message_id", existingMessage.id)
        .limit(1)
        .maybeSingle();

      if (processedTicketError) throw new Error(`Supabase edited message ticket lookup failed: ${processedTicketError.message}`);
      if (processedTicket?.id) {
        console.log("edited-message-already-processed", { chatId, messageId: message.message_id });
        return NextResponse.json({ ok: true, ignored: "edited_message_already_processed" });
      }

      const { data: storedMessage, error: messageError } = await supabase
        .from("messages")
        .update({
          telegram_user_id: message.from?.id ?? null,
          telegram_username: message.from?.username ?? null,
          message_text: clientMessageText,
          message_type: hasImageAttachment ? "client_photo" : "client",
          raw_payload: update,
          ...(typeof message.date === "number" ? { created_at: new Date(message.date * 1000).toISOString() } : {})
        })
        .eq("id", existingMessage.id)
        .select("id, created_at, message_text, message_type, telegram_message_id")
        .single();

      if (messageError) throw new Error(`Supabase edited message update failed: ${messageError.message}`);
      console.log("telegram-message-edited", { chatId, messageId: message.message_id, rowId: storedMessage?.id });
      return NextResponse.json({ ok: true, queued: true, edited: true, rowId: storedMessage?.id ?? null });
    }

    const { data: insertedMessage, error: insertSelectError } = await supabase
      .from("messages")
      .insert({
        telegram_message_id: message.message_id,
        telegram_chat_id: chatId,
        telegram_user_id: message.from?.id ?? null,
        telegram_username: message.from?.username ?? null,
        message_text: clientMessageText,
        message_type: hasImageAttachment ? "client_photo" : "client",
        raw_payload: update,
        ...(typeof message.date === "number" ? { created_at: new Date(message.date * 1000).toISOString() } : {})
      })
      .select("id, created_at, message_text, message_type, telegram_message_id")
      .single();

    if (insertSelectError) {
      console.error("supabase-insert-error", { table: "messages", message: insertSelectError.message });
      throw new Error(`Supabase messages insert failed: ${insertSelectError.message}`);
    }

    console.log("telegram-message-saved", { chatId, messageId: message.message_id, rowId: insertedMessage?.id });

    if (hasImageAttachment) {
      console.log("media-message-queued", { chatId, messageId: message.message_id, rowId: insertedMessage?.id });
    } else {
      console.log("text-message-queued", { chatId, messageId: message.message_id, rowId: insertedMessage?.id });
      console.log("instant-mark-forward-disabled", { chatId, messageId: message.message_id });
      console.log("mark-instant-text-forward-disabled", { chatId, messageId: message.message_id });
      console.log("conversation-burst-message-held-for-batch", { chatId, messageId: message.message_id });
    }

    return NextResponse.json({ ok: true, queued: true, rowId: insertedMessage?.id ?? null });
  } catch (error) {
    console.error("telegram-webhook-error", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Unexpected telegram webhook error."
      },
      { status: 500 }
    );
  }
}
