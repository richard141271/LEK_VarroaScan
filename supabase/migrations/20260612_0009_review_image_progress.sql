alter table public.varroa_submission_reviews
  add column if not exists current_image_index integer not null default 0,
  add column if not exists image_notes jsonb not null default '[]'::jsonb;
