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
  new_chat_title?: string;
};

type TelegramChatMemberStatus = "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";

type TelegramChatMember = {
  status: TelegramChatMemberStatus;
  user: { id: number; is_bot?: boolean };
};

type TelegramMyChatMember = {
  chat: TelegramChat;
  old_chat_member: TelegramChatMember;
  new_chat_member: TelegramChatMember;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  my_chat_member?: TelegramMyChatMember;
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
  if (n === "process_account_creation") return "Account Creation";
  if (["share_ad_account", "transfer_ad_account"].includes(n)) return "Share";
  if (n === "unshare_ad_account") return "Unshare";
  if (n === "deposit_funds") return "Deposits";
  if (["payment_issue", "refund_request"].includes(n)) return "Payment Issues";
  if (n === "verify_account") return "Verification";
  if (["check_account_status", "request_data_banned_accounts", "check_policy",
    "pause_campaigns", "appeal_review", "account_not_visible", "rename_account",
    "request_account_ids"].includes(n)) return "Account Issues";
  if (n === "replacement_request") return "Replacement";
  return "General";
}

// Category keyword patterns — used both for relevance checking and per-sentence extraction.
const CATEGORY_KEYWORDS: Record<string, RegExp> = {
  Deposits: /\b(deposit|funds?|confirmed|wallet|added|money|usdt|usd|transferred|crypto)\b/i,
  Share: /\b(shar(ed?|ing)|access\s+grant(ed)?|added?\s+(to\s+)?bm|link(ed)?|connected)\b/i,
  Unshare: /\b(unshar(ed?|ing)|remov(ed?|ing)|access\s+revok(ed)?|unlink(ed)?)\b/i,
  Verification: /\b(verif(ied|ication)?|card\s+check(ed)?)\b/i,
  // "withdraw/withdrawal/refund" must be here — refund_request maps to Payment Issues and
  // employees typically say "withdrawal" when answering those questions.
  "Payment Issues": /\b(payment|card|billing|charge|invoice|debt|balance|withdraw|withdrawal|refund)\b/i,
  "Account Issues": /\b(account|disabled|enabled|restor(ed)?|banned|blocked)\b/i,
  // General is intentionally broad — site issues, availability questions, reports, etc. use
  // varied language, so we capture common signal words rather than trying to be exhaustive.
  General: /\b(available|availability|stock|report|spend|site|error|issue|working|check|access|load|open|fixed|resolved|ready|done)\b/i
};

// Returns true when any part of the employee's text is relevant to this client's tickets.
function isRelevantForClient(
  employeeLower: string,
  tickets: Array<{ intent: string | null; chatTitle: string | null }>
): boolean {
  for (const t of tickets) {
    const title = (t.chatTitle ?? "").toLowerCase();
    if (title && employeeLower.includes(title)) return true;
  }
  const categories = tickets.map((t) => intentToCategory(t.intent));
  for (const cat of categories) {
    const pattern = CATEGORY_KEYWORDS[cat];
    if (pattern && pattern.test(employeeLower)) return true;
  }
  if (categories.includes("General") && employeeLower.length > 15) return true;
  return false;
}

// Extracts only the sentences from an employee's message that are relevant to a specific
// client's ticket categories. When the employee answers multiple questions in one message
// (e.g. "Accounts available for grant. Deposit of 60K confirmed."), each client should
// only receive the portion that answers THEIR question — not the entire message.
function extractRelevantAnswer(
  fullMessage: string,
  tickets: Array<{ intent: string | null; chatTitle: string | null }>
): string | null {
  // Split into sentences by period/exclamation/question followed by space, or by newlines.
  const sentences = fullMessage
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Single sentence → use simple relevance check (no splitting possible).
  if (sentences.length <= 1) {
    return isRelevantForClient(fullMessage.toLowerCase(), tickets) ? fullMessage.trim() : null;
  }

  const categories = [...new Set(tickets.map((t) => intentToCategory(t.intent)))];
  const relevant: string[] = [];

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    let matched = false;

    // Check if this sentence mentions the client's group name.
    for (const t of tickets) {
      const title = (t.chatTitle ?? "").toLowerCase();
      if (title && lower.includes(title)) { matched = true; break; }
    }

    // Check by category keywords.
    if (!matched) {
      for (const cat of categories) {
        const pattern = CATEGORY_KEYWORDS[cat];
        if (pattern && pattern.test(lower)) { matched = true; break; }
      }
    }

    if (matched) relevant.push(sentence);
  }

  return relevant.length > 0 ? relevant.join(" ") : null;
}

// Uses Gemini to intelligently route an employee's message to the correct client(s).
// Returns a Map of chatId → the relevant portion of the message to send that client.
// Returns null if the API call fails (caller should fall back to keyword routing).
async function routeWithGemini(
  employeeMessage: string,
  clients: Array<{ chatId: string; chatTitle: string | null; intent: string | null; originalQuestion: string | null }>
): Promise<Map<string, string> | null> {
  const apiKey = process.env.GEMINI_API_KEY_2 ?? process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const clientDescriptions = clients
    .map((c, i) => {
      const category = intentToCategory(c.intent);
      const name = c.chatTitle ?? c.chatId;
      const question = c.originalQuestion ? `"${c.originalQuestion.slice(0, 200)}"` : "(question not available)";
      return `Client ${i + 1}: ID=${c.chatId}, Name="${name}", Category=${category}, Their question: ${question}`;
    })
    .join("\n");

  const prompt = `You are a message router for a client support system. An employee answered questions in the internal team group.

Employee message:
"${employeeMessage}"

Client requests that were in this batch:
${clientDescriptions}

Your job: Decide which clients should receive this employee message (or a relevant portion of it).

Rules:
- Each client should ONLY receive content that directly answers THEIR specific question/category.
- If the message covers multiple topics, split it and send each client only the relevant part.
- If the message is entirely about one topic, only the client with that request should receive it.
- Do NOT send messages to clients whose question this does not answer.
- Keep the forwarded text natural — do not add explanations or modify the meaning.

Respond with ONLY valid JSON (no explanation, no markdown):
{"routing":[{"chatId":"<client chat id>","text":"<exact text to forward to this client>"}]}

Only include clients who should actually receive a message. If no client is relevant, return {"routing":[]}.`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );

    if (!res.ok) {
      console.error("gemini-routing-api-error", { status: res.status });
      return null;
    }

    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text: string }> } }> };
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as { routing?: Array<{ chatId: string; text: string }> };
    if (!Array.isArray(parsed.routing)) return null;

    const routing = new Map<string, string>();
    for (const item of parsed.routing) {
      if (item.chatId && item.text?.trim()) {
        routing.set(String(item.chatId), item.text.trim());
      }
    }

    console.log("gemini-routing-success", { clientsIn: clients.length, clientsRouted: routing.size });
    return routing.size > 0 ? routing : null;
  } catch (err) {
    console.error("gemini-routing-error", { error: err instanceof Error ? err.message : "unknown" });
    return null;
  }
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
    // markGroupChatId is kept for backward compatibility — optional when DB routing is configured.
    const markGroupChatId = firstEnv(["MARK_GROUP_CHAT_ID", "MARK_INTERNAL_CHAT_ID"]) ?? "";
    const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL", ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL"]);
    const serviceRoleKey = requireEnv("SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY", ["SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]);

    const supabase = createClient<Database, "public">(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    // Load all agency group chat IDs — mark_groups table, client_groups with group_type='agency',
    // and the legacy env var. Messages from any of these are employee replies, not client requests.
    // Also load master groups — the bot ignores all messages from master groups.
    const [{ data: agencyGroupsData }, { data: agencyTypeGroups }, { data: masterGroupsData }] = await Promise.all([
      supabase.from("mark_groups").select("telegram_chat_id"),
      supabase.from("client_groups").select("telegram_chat_id").eq("group_type", "agency"),
      supabase.from("client_groups").select("telegram_chat_id").eq("group_type", "master")
    ]);
    const masterChatIds = new Set<string>(
      (masterGroupsData ?? []).map((mg) => String(mg.telegram_chat_id))
    );
    const agencyChatIds = new Set<string>([
      ...(agencyGroupsData ?? []).map((ag) => String(ag.telegram_chat_id)),
      ...(agencyTypeGroups ?? []).map((ag) => String(ag.telegram_chat_id)),
      ...(markGroupChatId ? [markGroupChatId] : [])
    ]);

    const update = (await request.json()) as TelegramUpdate;

    // ── Bot added / promoted to group ────────────────────────────────────────────────────────────
    // Register the group immediately so it shows up in the routing dashboard without waiting
    // for the first user message. Fires when the bot is added to a group or its status changes.
    if (update.my_chat_member) {
      const { chat, new_chat_member } = update.my_chat_member;
      const isActiveInGroup = ["administrator", "member"].includes(new_chat_member.status);
      if (isActiveInGroup && chat.id) {
        const chatId = String(chat.id);
        const groupName = chat.title?.trim() ?? `Group ${chatId}`;
        const now = new Date().toISOString();
        // Insert if new group (ignoreDuplicates: true preserves existing group_type for re-adds)
        const { error: insertErr } = await supabase.from("client_groups").upsert(
          { telegram_chat_id: chatId, group_name: groupName, group_type: null, updated_at: now },
          { onConflict: "telegram_chat_id", ignoreDuplicates: true }
        );
        if (insertErr) console.error("my-chat-member-insert-failed", { chatId, error: insertErr.message });
        // Always sync the name (separate update so group_type is not touched)
        const { error: nameErr } = await supabase.from("client_groups")
          .update({ group_name: groupName, updated_at: now })
          .eq("telegram_chat_id", chatId);
        if (nameErr) console.error("my-chat-member-name-sync-failed", { chatId, error: nameErr.message });
        console.log("my-chat-member-group-synced", { chatId, groupName, status: new_chat_member.status });
      }
      return NextResponse.json({ ok: true, status: "my_chat_member_handled" });
    }

    const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;

    if (!message?.chat?.id) {
      return NextResponse.json({ ok: true, ignored: "no_message" });
    }

    const chatId = message.chat.id;

    // Master groups: bot is completely silent — ignore everything sent there.
    if (masterChatIds.has(String(chatId))) {
      return NextResponse.json({ ok: true, status: "master_group_ignored" });
    }

    // ── Employee message from an agency group (Mark / Momo / Bobo / etc.) ───────────────────────
    // When an employee answers in any agency group, the bot analyzes their text and forwards
    // the relevant portion to the right client group(s).
    //
    // How routing works:
    //  1. Employee can Reply to the batch summary (preferred) OR just type in the group.
    //     Standalone messages are matched against the most recent batch summary (24h lookback).
    //  2. The bot looks up all tickets that share that summary's internal_message_id.
    //  3. Holding acks ("got it", "we'll check", etc.) are ignored — client already has that.
    //  4. For multi-client batches, the message is split into sentences and each client only
    //     receives the sentences relevant to THEIR ticket category (smart extraction).
    //  5. Single-client batches receive the full employee message.
    if (agencyChatIds.has(String(chatId))) {
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
          .eq("telegram_chat_id", String(chatId))
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
        .select("id, client_chat_id, intent, extracted_data, client_original_message")
        .eq("internal_message_id", replyToMsgId)
        .not("client_chat_id", "is", null);

      if (ticketError || !batchTickets || batchTickets.length === 0) {
        console.log("mark-reply-no-tickets-found", { replyToMsgId, error: ticketError?.message ?? "no match" });
        return NextResponse.json({ ok: true, ignored: "no_matching_tickets" });
      }

      // Group tickets by client_chat_id, carrying the original question for AI routing context.
      type ClientTicket = { id: string; intent: string | null; chatTitle: string | null; originalQuestion: string | null };
      const byClient = new Map<string, ClientTicket[]>();
      for (const t of batchTickets) {
        const key = String(t.client_chat_id);
        const chatTitle = (typeof t.extracted_data === "object" && t.extracted_data !== null)
          ? String((t.extracted_data as Record<string, unknown>).chatTitle ?? "")
          : "";
        const originalQuestion = (t as { client_original_message?: string | null }).client_original_message ?? null;
        byClient.set(key, [...(byClient.get(key) ?? []), { id: t.id, intent: t.intent, chatTitle: chatTitle || null, originalQuestion }]);
      }

      // Determine which clients should receive this employee message and WHAT text each gets.
      //
      // Single client in batch → forward full message (all answers are for them).
      // Multiple clients → extract only the relevant portion for each client so they don't
      //   see answers meant for other clients.
      //
      // Example: employee writes "Accounts available for grant. Deposit of 60K confirmed."
      //   → Client A (asked about availability) gets only "Accounts available for grant."
      //   → Client B (asked about deposit) gets only "Deposit of 60K confirmed."
      type ForwardTarget = { chatId: string; text: string };
      const targets: ForwardTarget[] = [];

      const employeeLower = employeeText.toLowerCase();

      if (byClient.size === 1) {
        // Only one client — send the full employee message.
        const clientChatId = [...byClient.keys()][0]!;
        targets.push({ chatId: clientChatId, text: employeeText });
      } else {
        // Multiple clients — try Claude AI routing first for accurate semantic splitting.
        // Claude reads each client's original question and category, then decides which
        // client(s) the employee's answer applies to and what portion to send each.
        // Falls back to two-pass keyword extraction if Claude is unavailable or errors out.
        const clientsForAI = [...byClient.entries()].map(([cId, tickets]) => ({
          chatId: cId,
          chatTitle: tickets[0]?.chatTitle ?? null,
          intent: tickets[0]?.intent ?? null,
          originalQuestion: tickets[0]?.originalQuestion ?? null
        }));

        const aiRouting = await routeWithGemini(employeeText, clientsForAI);

        if (aiRouting && aiRouting.size > 0) {
          // Claude successfully routed — use its decisions directly.
          for (const [cId, routedText] of aiRouting.entries()) {
            targets.push({ chatId: cId, text: routedText });
            console.log("mark-reply-claude-routed", { clientChatId: cId, textLen: routedText.length });
          }
        } else {
          // Fallback: two-pass keyword extraction.
          console.log("mark-reply-falling-back-to-keyword-extraction", { clients: byClient.size });
          const unmatchedClients: Array<[string, Array<{ id: string; intent: string | null; chatTitle: string | null }>]> = [];

          // Pass 1: sentence-level extraction — each client gets only the sentences whose
          //   keywords match their ticket category.
          for (const [clientChatId, clientTickets] of byClient.entries()) {
            const relevantText = extractRelevantAnswer(employeeText, clientTickets);
            if (relevantText) {
              targets.push({ chatId: clientChatId, text: relevantText });
              console.log("mark-reply-extracted-for-client", { clientChatId, originalLen: employeeText.length, extractedLen: relevantText.length });
            } else {
              unmatchedClients.push([clientChatId, clientTickets]);
            }
          }

          // Pass 2: broader relevance check for clients that sentence extraction didn't cover.
          for (const [clientChatId, clientTickets] of unmatchedClients) {
            if (isRelevantForClient(employeeLower, clientTickets)) {
              targets.push({ chatId: clientChatId, text: employeeText });
              console.log("mark-reply-fullmsg-fallback-for-client", { clientChatId });
            }
          }

          // Final fallback: if neither pass matched anyone, forward full message to all clients.
          if (targets.length === 0) {
            console.log("mark-reply-extraction-fallback-all-clients", { clientCount: byClient.size });
            for (const clientChatId of byClient.keys()) {
              targets.push({ chatId: clientChatId, text: employeeText });
            }
          }
        }
      }

      const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
      if (!token) {
        console.error("mark-reply-forward-no-token");
        return NextResponse.json({ ok: false, error: "Missing bot token" }, { status: 500 });
      }

      const employeePhoto = message.photo?.length
        ? message.photo[message.photo.length - 1].file_id
        : isImageDocument(message.document) ? message.document!.file_id : null;

      const forwardedTo: string[] = [];
      for (const target of targets) {
        try {
          let payload: { ok: boolean; result?: { message_id: number }; description?: string };

          if (employeePhoto) {
            const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: target.chatId,
                photo: employeePhoto,
                ...(target.text ? { caption: target.text } : {})
              })
            });
            payload = await res.json();
          } else {
            const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: target.chatId,
                text: target.text,
                disable_web_page_preview: true
              })
            });
            payload = await res.json();
          }

          if (payload.ok) {
            forwardedTo.push(target.chatId);
            console.log("mark-reply-forwarded", { clientChatId: target.chatId, forwardedMsgId: payload.result?.message_id, hasPhoto: Boolean(employeePhoto) });
          } else {
            console.error("mark-reply-forward-failed", { clientChatId: target.chatId, error: payload.description });
          }
        } catch (fwdErr) {
          console.error("mark-reply-forward-error", { clientChatId: target.chatId, error: fwdErr instanceof Error ? fwdErr.message : "unknown" });
        }
      }

      return NextResponse.json({ ok: true, forwarded: forwardedTo.length, clients: forwardedTo });
    }

    // ── Auto-register unknown groups + silence unclassified ─────────────────────────────────────
    // Every group the bot is added to gets registered in client_groups the first time it sends
    // a message. Until the admin classifies it as "client" or "agency" in the Routing dashboard,
    // the bot does absolutely nothing — no replies, no storage, completely silent.
    const { data: knownGroup } = await supabase
      .from("client_groups")
      .select("group_type, group_name")
      .eq("telegram_chat_id", String(chatId))
      .maybeSingle();

    const groupName = message.chat.title?.trim() ?? `Group ${chatId}`;

    // Handle group rename service message — Telegram sends this when the group title changes.
    if (message.new_chat_title) {
      const newTitle = message.new_chat_title.trim();
      if (knownGroup) {
        await supabase.from("client_groups")
          .update({ group_name: newTitle, updated_at: new Date().toISOString() })
          .eq("telegram_chat_id", String(chatId));
        console.log("group-renamed-via-service-msg", { chatId, newTitle });
      }
      return NextResponse.json({ ok: true, status: "group_name_updated" });
    }

    // Silently sync name if it drifted (fire-and-forget — never blocks message processing)
    if (knownGroup && knownGroup.group_name !== groupName) {
      supabase.from("client_groups")
        .update({ group_name: groupName, updated_at: new Date().toISOString() })
        .eq("telegram_chat_id", String(chatId))
        .then(({ error }) => { if (error) console.error("group-name-drift-sync-failed", { chatId, error: error.message }); });
    }

    if (!knownGroup) {
      // First message ever from this group — register it as unclassified.
      const { error: regErr } = await supabase.from("client_groups").upsert(
        { telegram_chat_id: String(chatId), group_name: groupName, group_type: null, updated_at: new Date().toISOString() },
        { onConflict: "telegram_chat_id" }
      );
      if (regErr) {
        console.error("new-group-register-failed", { chatId, groupName, error: regErr.message });
        return NextResponse.json({ ok: false, error: "group_register_failed" }, { status: 500 });
      }
      console.log("new-group-auto-registered", { chatId, groupName });
      return NextResponse.json({ ok: true, status: "new_group_registered" });
    }

    const groupType = knownGroup.group_type ?? null;
    if (!groupType) {
      // Registered but not yet classified — completely silent.
      console.log("unclassified-group-ignored", { chatId });
      return NextResponse.json({ ok: true, status: "unclassified_group_ignored" });
    }

    // Non-client groups (should have been caught by agencyChatIds above, but guard here too).
    if (groupType !== "client") {
      return NextResponse.json({ ok: true, ignored: "non_client_group" });
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
