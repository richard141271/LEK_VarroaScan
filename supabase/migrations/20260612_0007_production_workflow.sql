do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'varroa_submission_status'
      and e.enumlabel = 'KLAR_FOR_KONTROLL'
  ) then
    alter type public.varroa_submission_status add value 'KLAR_FOR_KONTROLL';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'varroa_submission_status'
      and e.enumlabel = 'GODKJENT'
  ) then
    alter type public.varroa_submission_status add value 'GODKJENT';
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'varroa_submission_status'
      and e.enumlabel = 'KLAR_FOR_TRENING'
  ) then
    alter type public.varroa_submission_status add value 'KLAR_FOR_TRENING';
  end if;
end $$;

alter table public.varroa_submissions
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists assigned_to uuid references auth.users(id) on delete set null,
  add column if not exists assigned_at timestamptz,
  add column if not exists processed_by uuid references auth.users(id) on delete set null,
  add column if not exists processed_at timestamptz,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists returned_by uuid references auth.users(id) on delete set null,
  add column if not exists returned_at timestamptz,
  add column if not exists quality_rating text,
  add column if not exists training_ready boolean not null default false,
  add column if not exists manual_mite_count integer,
  add column if not exists review_comment text,
  add column if not exists current_role_owner text;

create index if not exists varroa_submissions_status_assigned_created_idx
  on public.varroa_submissions (status, assigned_to, created_at desc);

create index if not exists varroa_submissions_status_updated_idx
  on public.varroa_submissions (status, updated_at desc);

create index if not exists varroa_submissions_training_ready_idx
  on public.varroa_submissions (training_ready, approved_at desc);

create table if not exists public.varroa_user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('SUPERADMIN', 'FAGANSVARLIG', 'STUDENT')),
  created_at timestamptz not null default now()
);

create table if not exists public.varroa_submission_history (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.varroa_submissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  action text not null,
  from_status public.varroa_submission_status,
  to_status public.varroa_submission_status,
  comment text,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists varroa_submission_history_submission_created_idx
  on public.varroa_submission_history (submission_id, created_at desc);

create table if not exists public.varroa_submission_reviews (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.varroa_submissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete cascade,
  mite_count integer,
  image_quality text,
  comment text,
  training_ready boolean not null default false,
  approved boolean not null default false,
  unique (submission_id, created_by)
);

create index if not exists varroa_submission_reviews_submission_updated_idx
  on public.varroa_submission_reviews (submission_id, updated_at desc);

create or replace function public.varroa_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_varroa_submissions_touch_updated_at on public.varroa_submissions;
create trigger trg_varroa_submissions_touch_updated_at
before update on public.varroa_submissions
for each row execute function public.varroa_touch_updated_at();

drop trigger if exists trg_varroa_submission_reviews_touch_updated_at on public.varroa_submission_reviews;
create trigger trg_varroa_submission_reviews_touch_updated_at
before update on public.varroa_submission_reviews
for each row execute function public.varroa_touch_updated_at();

create or replace function public.varroa_role_for_user(check_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when exists (
      select 1 from public.varroa_user_roles r
      where r.user_id = check_user and r.role = 'SUPERADMIN'
    ) then 'SUPERADMIN'
    when exists (
      select 1 from public.varroa_user_roles r
      where r.user_id = check_user and r.role = 'FAGANSVARLIG'
    ) then 'FAGANSVARLIG'
    when exists (
      select 1 from public.varroa_user_roles r
      where r.user_id = check_user and r.role = 'STUDENT'
    ) then 'STUDENT'
    when exists (
      select 1 from public.varroa_admins a where a.user_id = check_user
    ) then 'SUPERADMIN'
    else null
  end;
$$;

create or replace function public.varroa_has_work_role(check_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.varroa_role_for_user(check_user) is not null;
$$;

create or replace function public.varroa_is_privileged(check_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.varroa_role_for_user(check_user) in ('SUPERADMIN', 'FAGANSVARLIG');
$$;

create or replace function public.varroa_available_new_count()
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_count integer := 0;
begin
  if v_user is null or not public.varroa_has_work_role(v_user) then
    return 0;
  end if;

  select count(*)
    into v_count
  from public.varroa_submissions
  where status = 'NY'
    and assigned_to is null;

  return coalesce(v_count, 0);
end;
$$;

create or replace function public.varroa_claim_next_submission()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_role text;
  v_submission_id uuid;
begin
  if v_user is null then
    raise exception 'Ikke innlogget';
  end if;

  if not public.varroa_has_work_role(v_user) then
    raise exception 'Ingen tilgang';
  end if;

  v_role := public.varroa_role_for_user(v_user);

  select s.id
    into v_submission_id
  from public.varroa_submissions s
  where s.status = 'NY'
    and s.assigned_to is null
  order by s.created_at asc
  for update skip locked
  limit 1;

  if v_submission_id is null then
    return null;
  end if;

  update public.varroa_submissions
  set status = 'UNDER_ARBEID',
      assigned_to = v_user,
      assigned_at = coalesce(assigned_at, now()),
      processed_by = coalesce(processed_by, v_user),
      processed_at = coalesce(processed_at, now()),
      current_role_owner = coalesce(v_role, 'STUDENT')
  where id = v_submission_id;

  insert into public.varroa_submission_history (
    submission_id,
    user_id,
    action,
    from_status,
    to_status,
    payload
  )
  values (
    v_submission_id,
    v_user,
    'CLAIMED_NEXT',
    'NY',
    'UNDER_ARBEID',
    jsonb_build_object('role', v_role)
  );

  return v_submission_id;
end;
$$;

alter table public.varroa_user_roles enable row level security;
alter table public.varroa_submission_history enable row level security;
alter table public.varroa_submission_reviews enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'varroa_submissions'
      and policyname = 'varroa_submissions_workflow_select'
  ) then
    create policy varroa_submissions_workflow_select
      on public.varroa_submissions
      for select
      to authenticated
      using (
        public.varroa_is_privileged(auth.uid())
        or assigned_to = auth.uid()
        or processed_by = auth.uid()
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'varroa_submissions'
      and policyname = 'varroa_submissions_workflow_update'
  ) then
    create policy varroa_submissions_workflow_update
      on public.varroa_submissions
      for update
      to authenticated
      using (
        public.varroa_is_privileged(auth.uid())
        or assigned_to = auth.uid()
        or processed_by = auth.uid()
      )
      with check (
        public.varroa_is_privileged(auth.uid())
        or assigned_to = auth.uid()
        or processed_by = auth.uid()
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'varroa_user_roles'
      and policyname = 'varroa_user_roles_select'
  ) then
    create policy varroa_user_roles_select
      on public.varroa_user_roles
      for select
      to authenticated
      using (
        user_id = auth.uid()
        or public.varroa_is_privileged(auth.uid())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'varroa_user_roles'
      and policyname = 'varroa_user_roles_manage'
  ) then
    create policy varroa_user_roles_manage
      on public.varroa_user_roles
      for all
      to authenticated
      using (public.varroa_role_for_user(auth.uid()) = 'SUPERADMIN')
      with check (public.varroa_role_for_user(auth.uid()) = 'SUPERADMIN');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'varroa_submission_history'
      and policyname = 'varroa_submission_history_select'
  ) then
    create policy varroa_submission_history_select
      on public.varroa_submission_history
      for select
      to authenticated
      using (public.varroa_has_work_role(auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'varroa_submission_history'
      and policyname = 'varroa_submission_history_insert'
  ) then
    create policy varroa_submission_history_insert
      on public.varroa_submission_history
      for insert
      to authenticated
      with check (
        public.varroa_has_work_role(auth.uid())
        and (
          user_id is null
          or user_id = auth.uid()
          or public.varroa_is_privileged(auth.uid())
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'varroa_submission_reviews'
      and policyname = 'varroa_submission_reviews_select'
  ) then
    create policy varroa_submission_reviews_select
      on public.varroa_submission_reviews
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
      and tablename = 'varroa_submission_reviews'
      and policyname = 'varroa_submission_reviews_insert'
  ) then
    create policy varroa_submission_reviews_insert
      on public.varroa_submission_reviews
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
      and tablename = 'varroa_submission_reviews'
      and policyname = 'varroa_submission_reviews_update'
  ) then
    create policy varroa_submission_reviews_update
      on public.varroa_submission_reviews
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

grant select, insert, update on table public.varroa_user_roles to authenticated;
grant select, insert on table public.varroa_submission_history to authenticated;
grant select, insert, update on table public.varroa_submission_reviews to authenticated;
grant execute on function public.varroa_available_new_count() to authenticated;
grant execute on function public.varroa_claim_next_submission() to authenticated;
