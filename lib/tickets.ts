import "server-only";
import { createSupabaseAdminClient, hasSupabaseServerEnv } from "@/lib/supabase/admin";
import type { BotResponse, DashboardStats, MarkAction, Message, PlaybookEntry, Ticket } from "@/lib/types";

export type TicketFilters = {
  status?: string;
  intent?: string;
  priority?: string;
  search?: string;
};

function emptyDashboard(): DashboardStats {
  return {
    totalTickets: 0,
    waitingForMark: 0,
    resolved: 0,
    closed: 0,
    newTickets: 0,
    highPriorityTickets: 0,
    telegramSendErrors: 0,
    last24HoursTickets: 0,
    recentTickets: [],
    topIntents: []
  };
}

export async function getDashboardStats(): Promise<DashboardStats> {
  if (!hasSupabaseServerEnv()) return emptyDashboard();

  const supabase = createSupabaseAdminClient();
  const since24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [total, waiting, resolved, closed, recent, intentRows] = await Promise.all([
    supabase.from("tickets").select("id", { count: "exact", head: true }),
    supabase.from("tickets").select("id", { count: "exact", head: true }).or("needs_mark.eq.true,status.eq.waiting_for_mark"),
    supabase.from("tickets").select("id", { count: "exact", head: true }).eq("status", "resolved"),
    supabase.from("tickets").select("id", { count: "exact", head: true }).eq("status", "closed"),
    supabase.from("tickets").select("*").order("created_at", { ascending: false }).limit(8),
    supabase.from("tickets").select("intent").not("intent", "is", null).limit(500)
  ]);

  const [newTickets, highPriorityTickets, telegramErrors, last24Hours] = await Promise.all([
    supabase.from("tickets").select("id", { count: "exact", head: true }).in("status", ["new", "open"]),
    supabase.from("tickets").select("id", { count: "exact", head: true }).in("priority", ["high", "urgent"]),
    supabase.from("bot_responses").select("id", { count: "exact", head: true }).in("response_type", ["error", "failed", "telegram_error"]),
    supabase.from("tickets").select("id", { count: "exact", head: true }).gte("created_at", since24Hours)
  ]);

  if (
    total.error ||
    waiting.error ||
    resolved.error ||
    closed.error ||
    recent.error ||
    intentRows.error ||
    newTickets.error ||
    highPriorityTickets.error ||
    telegramErrors.error ||
    last24Hours.error
  ) {
    throw new Error(
      total.error?.message ??
        waiting.error?.message ??
        resolved.error?.message ??
        closed.error?.message ??
        recent.error?.message ??
        intentRows.error?.message ??
        newTickets.error?.message ??
        highPriorityTickets.error?.message ??
        telegramErrors.error?.message ??
        last24Hours.error?.message
    );
  }

  const counts = new Map<string, number>();
  for (const row of intentRows.data ?? []) {
    const intent = String(row.intent ?? "unknown");
    counts.set(intent, (counts.get(intent) ?? 0) + 1);
  }

  const topIntents = [...counts.entries()]
    .map(([intent, count]) => ({ intent, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  return {
    totalTickets: total.count ?? 0,
    waitingForMark: waiting.count ?? 0,
    resolved: resolved.count ?? 0,
    closed: closed.count ?? 0,
    newTickets: newTickets.count ?? 0,
    highPriorityTickets: highPriorityTickets.count ?? 0,
    telegramSendErrors: telegramErrors.count ?? 0,
    last24HoursTickets: last24Hours.count ?? 0,
    recentTickets: (recent.data ?? []) as Ticket[],
    topIntents
  };
}

export async function getTickets(filters: TicketFilters): Promise<Ticket[]> {
  if (!hasSupabaseServerEnv()) return [] as Ticket[];

  const supabase = createSupabaseAdminClient();
  let query = supabase.from("tickets").select("*").order("created_at", { ascending: false }).limit(100);

  if (filters.status && filters.status !== "all") query = query.eq("status", filters.status);
  if (filters.intent && filters.intent !== "all") query = query.eq("intent", filters.intent);
  if (filters.priority && filters.priority !== "all") query = query.eq("priority", filters.priority);

  if (filters.search) {
    const term = filters.search.replaceAll(",", " ").trim();
    query = query.or(
      `ticket_code.ilike.%${term}%,client_username.ilike.%${term}%,client_original_message.ilike.%${term}%,intent.ilike.%${term}%`
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Ticket[];
}

export async function getTicketDetail(id: string) {
  if (!hasSupabaseServerEnv()) {
    return {
      ticket: null,
      messages: [] as Message[],
      actions: [] as MarkAction[],
      botResponses: [] as BotResponse[]
    };
  }

  const supabase = createSupabaseAdminClient();
  const { data: ticket, error: ticketError } = await supabase.from("tickets").select("*").eq("id", id).single();
  if (ticketError) throw new Error(ticketError.message);

  const typedTicket = ticket as Ticket;
  const [messages, actions, botResponses] = await Promise.all([
    supabase
      .from("messages")
      .select("*")
      .eq("telegram_chat_id", typedTicket.client_chat_id)
      .order("created_at", { ascending: true })
      .limit(20),
    supabase.from("mark_actions").select("*").eq("ticket_id", id).order("created_at", { ascending: true }),
    supabase.from("bot_responses").select("*").eq("ticket_id", id).order("created_at", { ascending: true })
  ]);

  if (messages.error || actions.error || botResponses.error) {
    throw new Error(messages.error?.message ?? actions.error?.message ?? botResponses.error?.message);
  }

  return {
    ticket: typedTicket,
    messages: (messages.data ?? []) as Message[],
    actions: (actions.data ?? []) as MarkAction[],
    botResponses: (botResponses.data ?? []) as BotResponse[]
  };
}

export async function getPlaybookEntries() {
  if (!hasSupabaseServerEnv()) return [] as PlaybookEntry[];
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase.from("playbook_entries").select("*").order("intent", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as PlaybookEntry[];
}

function uniqueNonEmptyStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value)))).sort();
}

export async function getDistinctTicketValues(field: "status" | "intent" | "priority"): Promise<string[]> {
  if (!hasSupabaseServerEnv()) return [] as string[];
  const supabase = createSupabaseAdminClient();

  if (field === "status") {
    const { data, error } = await supabase.from("tickets").select("status").not("status", "is", null).limit(500);
    if (error) throw new Error(error.message);
    return uniqueNonEmptyStrings((data ?? []).map((row) => row.status));
  }

  if (field === "intent") {
    const { data, error } = await supabase.from("tickets").select("intent").not("intent", "is", null).limit(500);
    if (error) throw new Error(error.message);
    return uniqueNonEmptyStrings((data ?? []).map((row) => row.intent));
  }

  const { data, error } = await supabase.from("tickets").select("priority").not("priority", "is", null).limit(500);
  if (error) throw new Error(error.message);
  return uniqueNonEmptyStrings((data ?? []).map((row) => row.priority));
}
