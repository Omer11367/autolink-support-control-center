alter table tickets
add column if not exists closed_at timestamptz;

create index if not exists tickets_closed_at_idx on tickets (closed_at desc);
