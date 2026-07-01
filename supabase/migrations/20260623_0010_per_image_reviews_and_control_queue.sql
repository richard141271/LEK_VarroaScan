create table if not exists public.varroa_submission_review_images (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.varroa_submissions(id) on delete cascade,
  review_id uuid not null references public.varroa_submission_reviews(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete cascade,
  image_index integer not null check (image_index >= 0),
  mite_count integer,
  image_quality text,
  comment text,
  training_ready boolean not null default false,
  approved boolean not null default false,
  unique (review_id, image_index)
);

create index if not exists varroa_review_images_submission_user_idx
  on public.varroa_submission_review_images (submission_id, created_by, image_index);

create index if not exists varroa_review_images_review_updated_idx
  on public.varroa_submission_review_images (review_id, updated_at desc);

drop trigger if exists trg_varroa_submission_review_images_touch_updated_at on public.varroa_submission_review_images;
create trigger trg_varroa_submission_review_images_touch_updated_at
before update on public.varroa_submission_review_images
for each row execute function public.varroa_touch_updated_at();

alter table public.varroa_submission_review_images enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'varroa_submission_review_images'
      and policyname = 'varroa_submission_review_images_select'
  ) then
    create policy varroa_submission_review_images_select
      on public.varroa_submission_review_images
      for select
      to authenticated
      using (
        public.varroa_is_privileged(auth.uid())
        or created_by = auth.uid()
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'varroa_submission_review_images'
      and policyname = 'varroa_submission_review_images_insert'
  ) then
    create policy varroa_submission_review_images_insert
      on public.varroa_submission_review_images
      for insert
      to authenticated
      with check (
        public.varroa_has_work_role(auth.uid())
        and created_by = auth.uid()
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'varroa_submission_review_images'
      and policyname = 'varroa_submission_review_images_update'
  ) then
    create policy varroa_submission_review_images_update
      on public.varroa_submission_review_images
      for update
      to authenticated
      using (
        public.varroa_is_privileged(auth.uid())
        or created_by = auth.uid()
      )
      with check (
        public.varroa_is_privileged(auth.uid())
        or created_by = auth.uid()
      );
  end if;
end $$;

grant select, insert, update on table public.varroa_submission_review_images to authenticated;

insert into public.varroa_submission_review_images (
  submission_id,
  review_id,
  created_by,
  image_index,
  mite_count,
  image_quality,
  comment,
  training_ready,
  approved
)
select
  r.submission_id,
  r.id,
  r.created_by,
  coalesce(r.current_image_index, 0),
  r.mite_count,
  r.image_quality,
  r.comment,
  r.training_ready,
  r.approved
from public.varroa_submission_reviews r
where (
  r.mite_count is not null
  or r.image_quality is not null
  or r.comment is not null
  or r.training_ready = true
  or r.approved = true
)
on conflict (review_id, image_index) do nothing;
