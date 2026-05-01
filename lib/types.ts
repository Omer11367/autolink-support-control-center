export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export type TicketStatus = "open" | "waiting_for_mark" | "resolved" | "closed" | string;
export type TicketPriority = "low" | "normal" | "high" | "urgent" | string;

export type Ticket = {
  id: string;
  ticket_code: string | null;
  client_chat_id: string | number | null;
  client_message_id: string | number | null;
  client_user_id: string | number | null;
  client_username: string | null;
  intent: string | null;
  status: TicketStatus | null;
  priority: TicketPriority | null;
  needs_mark: boolean | null;
  client_original_message: string | null;
  extracted_data: Json | null;
  internal_summary: string | null;
  holding_message_id: string | number | null;
  internal_message_id: string | number | null;
  completion_message: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export type MarkAction = {
  id: string;
  ticket_id: string;
  mark_telegram_user_id: string | number | null;
  mark_username: string | null;
  action_type: string;
  action_text: string | null;
  raw_payload: Json | null;
  created_at: string | null;
};

export type BotResponse = {
  id: string;
  ticket_id: string | null;
  telegram_chat_id: string | number | null;
  telegram_message_id: string | number | null;
  response_type: string | null;
  response_text: string | null;
  created_at: string | null;
};

export type TicketNote = {
  id: string;
  ticket_id: string;
  note_text: string;
  created_at: string | null;
};

export type Message = {
  id: string;
  telegram_message_id: string | number | null;
  telegram_chat_id: string | number | null;
  telegram_user_id: string | number | null;
  telegram_username: string | null;
  message_text: string | null;
  message_type: string | null;
  raw_payload: Json | null;
  created_at: string | null;
};

export type PlaybookEntry = {
  id: string;
  intent: string;
  title: string;
  description: string | null;
  detection_rules: string | null;
  first_response_examples: string[] | null;
  completion_examples: string[] | null;
  escalation_rules: string | null;
  is_active: boolean | null;
  created_at: string | null;
};

export type DashboardStats = {
  totalTickets: number;
  waitingForMark: number;
  resolved: number;
  closed: number;
  newTickets: number;
  highPriorityTickets: number;
  telegramSendErrors: number;
  last24HoursTickets: number;
  recentTickets: Ticket[];
  topIntents: Array<{ intent: string; count: number }>;
};
