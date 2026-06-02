create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'varroa_submission_status') then
    create type public.varroa_submission_status as enum ('NY', 'UNDER_ARBEID', 'ARKIVERT');
  end if;
end $$;

create table if not exists public.varroa_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  user_name text,
  created_at timestamptz not null default now(),
  type text not null,
  images text[] not null default '{}',
  note text,
  source text not null default 'web',
  app_version text,
  device_info jsonb,
  route text,
  status public.varroa_submission_status not null default 'NY',
  admin_comment text
);

create index if not exists varroa_submissions_status_created_at_idx
  on public.varroa_submissions (status, created_at desc);

create table if not exists public.varroa_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.varroa_labels (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.varroa_submissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  label_type text not null,
  data jsonb not null default '{}'::jsonb,
  note text
);

create table if not exists public.varroa_models (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  version text,
  metadata jsonb not null default '{}'::jsonb
);

alter table public.varroa_submissions enable row level security;
alter table public.varroa_admins enable row level security;
alter table public.varroa_labels enable row level security;
alter table public.varroa_models enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'varroa_submissions' and policyname = 'varroa_submissions_insert_anyone'
  ) then
    create policy varroa_submissions_insert_anyone
      on public.varroa_submissions
      for insert
      to anon, authenticated
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'varroa_submissions' and policyname = 'varroa_submissions_admin_select'
  ) then
    create policy varroa_submissions_admin_select
      on public.varroa_submissions
      for select
      to authenticated
      using (exists (select 1 from public.varroa_admins a where a.user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'varroa_submissions' and policyname = 'varroa_submissions_admin_update'
  ) then
    create policy varroa_submissions_admin_update
      on public.varroa_submissions
      for update
      to authenticated
      using (exists (select 1 from public.varroa_admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.varroa_admins a where a.user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'varroa_admins' and policyname = 'varroa_admins_admin_select'
  ) then
    create policy varroa_admins_admin_select
      on public.varroa_admins
      for select
      to authenticated
      using (exists (select 1 from public.varroa_admins a where a.user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'varroa_admins' and policyname = 'varroa_admins_admin_insert'
  ) then
    create policy varroa_admins_admin_insert
      on public.varroa_admins
      for insert
      to authenticated
      with check (exists (select 1 from public.varroa_admins a where a.user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'varroa_labels' and policyname = 'varroa_labels_admin_all'
  ) then
    create policy varroa_labels_admin_all
      on public.varroa_labels
      for all
      to authenticated
      using (exists (select 1 from public.varroa_admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.varroa_admins a where a.user_id = auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'varroa_models' and policyname = 'varroa_models_admin_all'
  ) then
    create policy varroa_models_admin_all
      on public.varroa_models
      for all
      to authenticated
      using (exists (select 1 from public.varroa_admins a where a.user_id = auth.uid()))
      with check (exists (select 1 from public.varroa_admins a where a.user_id = auth.uid()));
  end if;
end $$;

insert into storage.buckets (id, name, public)
values ('varroa-submissions', 'varroa-submissions', false)
on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'storage_varroa_upload_anyone'
  ) then
    create policy storage_varroa_upload_anyone
      on storage.objects
      for insert
      to anon, authenticated
      with check (bucket_id = 'varroa-submissions' and name like 'submissions/%');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'storage_varroa_admin_read'
  ) then
    create policy storage_varroa_admin_read
      on storage.objects
      for select
      to authenticated
      using (
        bucket_id = 'varroa-submissions'
        and exists (select 1 from public.varroa_admins a where a.user_id = auth.uid())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'storage_varroa_admin_update'
  ) then
    create policy storage_varroa_admin_update
      on storage.objects
      for update
      to authenticated
      using (
        bucket_id = 'varroa-submissions'
        and exists (select 1 from public.varroa_admins a where a.user_id = auth.uid())
      )
      with check (
        bucket_id = 'varroa-submissions'
        and exists (select 1 from public.varroa_admins a where a.user_id = auth.uid())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'storage_varroa_admin_delete'
  ) then
    create policy storage_varroa_admin_delete
      on storage.objects
      for delete
      to authenticated
      using (
        bucket_id = 'varroa-submissions'
        and exists (select 1 from public.varroa_admins a where a.user_id = auth.uid())
      );
  end if;
end $$;
