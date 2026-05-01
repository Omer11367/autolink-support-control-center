create table if not exists public.ticket_notes (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid references public.tickets(id) on delete cascade,
  note_text text not null,
  created_at timestamptz default now()
);

create index if not exists ticket_notes_ticket_id_created_idx
  on public.ticket_notes (ticket_id, created_at desc);
