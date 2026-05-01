-- Optional performance helpers for Autolink Support Control Center.
-- Existing tables from the bot operation are reused as-is.

create index if not exists tickets_status_idx on public.tickets (status);
create index if not exists tickets_intent_idx on public.tickets (intent);
create index if not exists tickets_priority_idx on public.tickets (priority);
create index if not exists tickets_needs_mark_idx on public.tickets (needs_mark);
create index if not exists tickets_created_at_idx on public.tickets (created_at desc);
create index if not exists mark_actions_ticket_id_idx on public.mark_actions (ticket_id);
create index if not exists bot_responses_ticket_id_idx on public.bot_responses (ticket_id);
create index if not exists messages_chat_created_idx on public.messages (telegram_chat_id, created_at);
create index if not exists playbook_entries_intent_idx on public.playbook_entries (intent);

alter table public.tickets
  alter column updated_at set default now();
