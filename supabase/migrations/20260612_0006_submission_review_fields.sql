alter table public.varroa_submissions
  add column if not exists image_url text,
  add column if not exists beekeeper_name text,
  add column if not exists apiary_name text,
  add column if not exists comment text,
  add column if not exists mite_count_manual integer,
  add column if not exists reviewed_by text,
  add column if not exists review_status text not null default 'pending';

