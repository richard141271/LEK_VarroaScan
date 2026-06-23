alter table public.varroa_submissions
  add column if not exists image_notes jsonb not null default '[]'::jsonb;
