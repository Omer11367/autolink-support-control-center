import "server-only";
import { unstable_noStore as noStore } from "next/cache";
import { createSupabaseAdminClient, hasSupabaseServerEnv } from "@/lib/supabase/admin";
import { getEscalationState, getMinutesBetween, getTicketTimerMinutes, isOpenTicketStatus, isResolvedTicketStatus } from "@/lib/operations";
import type { BotResponse, DashboardStats, MarkAction, Message, PlaybookEntry, Ticket, TicketNote } from "@/lib/types";

export type TicketFilters = {
  status?: string;
  intent?: string;
  priority?: string;
  search?: string;
  client?: string;
  date?: string;
  start?: string;
  end?: string;
};

export type ClientOption = {
  value: string;
  label: string;
};

function getDateBounds(filters: TicketFilters): { start?: string; end?: string } {
  const now = new Date();
  const selected = filters.date ?? "lifetime";

  if (selected === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { start: start.toISOString() };
  }

  if (selected === "7d") {
    return { start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString() };
  }

  if (selected === "month") {
    return { start: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() };
  }

  if (selected === "custom") {
    const start = filters.start ? new Date(`${filters.start}T00:00:00`) : null;
    const end = filters.end ? new Date(`${filters.end}T23:59:59.999`) : null;
    return {
      start: start && !Number.isNaN(start.getTime()) ? start.toISOString() : undefined,
      end: end && !Number.isNaN(end.getTime()) ? end.toISOString() : undefined
    };
  }

  return {};
}

function readChatTitle(rawPayload: unknown): string | null {
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return null;
  const message = (rawPayload as { message?: unknown }).message;
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const chat = (message as { chat?: unknown }).chat;
  if (!chat || typeof chat !== "object" || Array.isArray(chat)) return null;
  const title = (chat as { title?: unknown }).title;
  return typeof title === "string" && title.trim() ? title : null;
}

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
    waitingOver10Minutes: 0,
    waitingOver30Minutes: 0,
    paymentTickets: 0,
    unknownIntentTickets: 0,
    recentTickets: [],
    attentionTickets: [],
    topIntents: [],
    totalOpenTickets: 0,
    resolvedToday: 0,
    ticketsWaitingOpen: 0,
    longestOpenMinutes: null,
    averageResolutionMinutes: null,
    ticketsByClient: []
  };
}

async function getClientLabelMap(): Promise<Map<string, string>> {
  const supabase = createSupabaseAdminClient();
  const { data, error } = await supabase
    .from("messages")
    .select("telegram_chat_id, raw_payload")
    .not("telegram_chat_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1000);

  if (error) throw new Error(error.message);

  const labels = new Map<string, string>();
  for (const row of data ?? []) {
    const value = String(row.telegram_chat_id);
    if (!value || labels.has(value)) continue;
    labels.set(value, readChatTitle(row.raw_payload) ?? value);
  }

  return labels;
}

export async function getDashboardStats(filters: TicketFilters = {}): Promise<DashboardStats> {
  noStore();
  if (!hasSupabaseServerEnv()) return emptyDashboard();

  const supabase = createSupabaseAdminClient();
  const bounds = getDateBounds(filters);
  let ticketsQuery = supabase.from("tickets").select("*").order("created_at", { ascending: false }).limit(1000);
  if (filters.client && filters.client !== "all") ticketsQuery = ticketsQuery.eq("client_chat_id", filters.client);
  if (bounds.start) ticketsQuery = ticketsQuery.gte("created_at", bounds.start);
  if (bounds.end) ticketsQuery = ticketsQuery.lte("created_at", bounds.end);

  const { data: operationalRows, error: operationalError } = await ticketsQuery;
  const telegramErrors = await supabase.from("bot_responses").select("id", { count: "exact", head: true }).in("response_type", ["error", "failed", "telegram_error"]);

  if (operationalError || telegramErrors.error) {
    throw new Error(operationalError?.message ?? telegramErrors.error?.message);
  }

  const operationalTickets = (operationalRows ?? []) as Ticket[];
  const clientLabels = await getClientLabelMap();

  const counts = new Map<string, number>();
  for (const ticket of operationalTickets) {
    const intent = String(ticket.intent ?? "unknown");
    counts.set(intent, (counts.get(intent) ?? 0) + 1);
  }

  const topIntents = [...counts.entries()]
    .map(([intent, count]) => ({ intent, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  const attentionTickets = operationalTickets
    .filter((ticket) => getEscalationState(ticket) !== "none")
    .sort((a, b) => {
      const aState = getEscalationState(a);
      const bState = getEscalationState(b);
      if (aState === bState) return new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime();
      return aState === "urgent" ? -1 : 1;
    })
    .slice(0, 8);

  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const openTickets = operationalTickets.filter((ticket) => isOpenTicketStatus(ticket.status));
  const resolvedTickets = operationalTickets.filter((ticket) => isResolvedTicketStatus(ticket.status));
  const openDurations = openTickets
    .map((ticket) => getTicketTimerMinutes(ticket))
    .filter((duration): duration is number => duration !== null);
  const resolutionDurations = resolvedTickets
    .map((ticket) => getMinutesBetween(ticket.created_at, ticket.closed_at ?? ticket.updated_at))
    .filter((duration): duration is number => duration !== null);
  const clientCounts = new Map<string, number>();

  for (const ticket of openTickets) {
    const client = ticket.client_chat_id ? String(ticket.client_chat_id) : "unknown";
    clientCounts.set(client, (clientCounts.get(client) ?? 0) + 1);
  }

  const ticketsByClient = Array.from(clientCounts.entries())
    .map(([client, openCount]) => ({
      client,
      label: clientLabels.get(client) ?? client,
      openCount
    }))
    .sort((a, b) => b.openCount - a.openCount || a.label.localeCompare(b.label));

  return {
    totalTickets: operationalTickets.length,
    waitingForMark: operationalTickets.filter((ticket) => ticket.needs_mark || ["waiting_mark", "waiting_for_mark"].includes(ticket.status ?? "")).length,
    resolved: operationalTickets.filter((ticket) => ticket.status === "resolved").length,
    closed: operationalTickets.filter((ticket) => ticket.status === "closed").length,
    newTickets: operationalTickets.filter((ticket) => ["new", "open"].includes(ticket.status ?? "")).length,
    highPriorityTickets: operationalTickets.filter((ticket) => ["high", "urgent"].includes(ticket.priority ?? "")).length,
    telegramSendErrors: telegramErrors.count ?? 0,
    last24HoursTickets: operationalTickets.filter((ticket) => new Date(ticket.created_at ?? 0).getTime() >= Date.now() - 24 * 60 * 60 * 1000).length,
    waitingOver10Minutes: operationalTickets.filter((ticket) => getEscalationState(ticket) === "needs_attention").length,
    waitingOver30Minutes: operationalTickets.filter((ticket) => getEscalationState(ticket) === "urgent").length,
    paymentTickets: operationalTickets.filter((ticket) => ["deposit_funds", "payment_issue", "refund_request"].includes(ticket.intent ?? "")).length,
    unknownIntentTickets: operationalTickets.filter((ticket) => !ticket.intent || ["unknown", "other"].includes(ticket.intent)).length,
    recentTickets: operationalTickets.slice(0, 8),
    attentionTickets,
    topIntents,
    totalOpenTickets: openTickets.length,
    resolvedToday: resolvedTickets.filter((ticket) => {
      const resolvedAt = new Date(ticket.closed_at ?? ticket.updated_at ?? 0).getTime();
      return !Number.isNaN(resolvedAt) && resolvedAt >= todayStart.getTime();
    }).length,
    ticketsWaitingOpen: openTickets.filter((ticket) => ticket.needs_mark || ["waiting_mark", "waiting_for_mark"].includes(ticket.status ?? "")).length,
    longestOpenMinutes: openDurations.length > 0 ? Math.max(...openDurations) : null,
    averageResolutionMinutes: resolutionDurations.length > 0
      ? Math.round(resolutionDurations.reduce((sum, duration) => sum + duration, 0) / resolutionDurations.length)
      : null,
    ticketsByClient
  };
}

export async function getTickets(filters: TicketFilters): Promise<Ticket[]> {
  noStore();
  if (!hasSupabaseServerEnv()) return [] as Ticket[];

  const supabase = createSupabaseAdminClient();
  const bounds = getDateBounds(filters);
  let query = supabase.from("tickets").select("*").order("created_at", { ascending: false }).limit(250);

  if (filters.client && filters.client !== "all") query = query.eq("client_chat_id", filters.client);
  if (bounds.start) query = query.gte("created_at", bounds.start);
  if (bounds.end) query = query.lte("created_at", bounds.end);

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

export async function getClientOptions(): Promise<ClientOption[]> {
  noStore();
  if (!hasSupabaseServerEnv()) return [];

  const options = await getClientLabelMap();

  return Array.from(options.entries())
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function getTicketDetail(id: string) {
  noStore();
  if (!hasSupabaseServerEnv()) {
    return {
      ticket: null,
      messages: [] as Message[],
      actions: [] as MarkAction[],
      botResponses: [] as BotResponse[],
      notes: [] as TicketNote[]
    };
  }

  const supabase = createSupabaseAdminClient();
  const { data: ticket, error: ticketError } = await supabase.from("tickets").select("*").eq("id", id).single();
  if (ticketError) throw new Error(ticketError.message);

  const typedTicket = ticket as Ticket;
  const [messages, actions, botResponses, notes] = await Promise.all([
    supabase
      .from("messages")
      .select("*")
      .eq("telegram_chat_id", typedTicket.client_chat_id)
      .order("created_at", { ascending: true })
      .limit(20),
    supabase.from("mark_actions").select("*").eq("ticket_id", id).order("created_at", { ascending: true }),
    supabase.from("bot_responses").select("*").eq("ticket_id", id).order("created_at", { ascending: true }),
    supabase.from("ticket_notes").select("*").eq("ticket_id", id).order("created_at", { ascending: true })
  ]);

  if (messages.error || actions.error || botResponses.error) {
    throw new Error(messages.error?.message ?? actions.error?.message ?? botResponses.error?.message);
  }

  return {
    ticket: typedTicket,
    messages: (messages.data ?? []) as Message[],
    actions: (actions.data ?? []) as MarkAction[],
    botResponses: (botResponses.data ?? []) as BotResponse[],
    notes: notes.error ? [] : ((notes.data ?? []) as TicketNote[])
  };
}

export async function getPlaybookEntries() {
  noStore();
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
  noStore();
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
