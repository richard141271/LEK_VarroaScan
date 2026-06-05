do $$
begin
  if not exists (select 1 from pg_type where typname = 'varroa_ai_status') then
    create type public.varroa_ai_status as enum ('PENDING', 'RUNNING', 'DONE', 'FAILED');
  end if;
end $$;

alter table public.varroa_submissions
  add column if not exists ai_status public.varroa_ai_status not null default 'PENDING',
  add column if not exists ai_started_at timestamptz,
  add column if not exists ai_finished_at timestamptz,
  add column if not exists ai_error text,
  add column if not exists ai_model text,
  add column if not exists ai_count int,
  add column if not exists ai_confidence real,
  add column if not exists ai_result jsonb;

create index if not exists varroa_submissions_ai_status_created_at_idx
  on public.varroa_submissions (ai_status, created_at desc);
