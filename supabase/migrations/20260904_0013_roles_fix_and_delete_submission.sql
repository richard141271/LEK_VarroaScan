-- ================================================================
-- 0013 — FIX eksisterende brukere (rolletildeling for gamle brukere)
--       + SLETT FUNKSJON for submission (kun admin)
-- Idempotent. Kjør trygt.
-- ================================================================

-- 1) Legger til igjen expires_at og banned_at og created_by (idempotent)
do $$
begin
  alter table public.varroa_user_roles
    add column if not exists expires_at timestamptz;
exception when duplicate_column then null;
end $$;

do $$
begin
  alter table public.varroa_user_roles
    add column if not exists banned_at timestamptz;
exception when duplicate_column then null;
end $$;

do $$
begin
  alter table public.varroa_user_roles
    add column if not exists created_by uuid references auth.users(id) on delete set null;
exception when duplicate_column then null;
end $$;

-- 2) Oppdater varroa_role_for_user (ignorer utløpte + sperrede)
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
      where r.user_id = check_user
        and r.banned_at is null
        and r.role = 'SUPERADMIN'
        and (r.expires_at is null or r.expires_at > now())
    ) then 'SUPERADMIN'
    when exists (
      select 1 from public.varroa_user_roles r
      where r.user_id = check_user
        and r.banned_at is null
        and r.role = 'FAGANSVARLIG'
        and (r.expires_at is null or r.expires_at > now())
    ) then 'FAGANSVARLIG'
    when exists (
      select 1 from public.varroa_user_roles r
      where r.user_id = check_user
        and r.banned_at is null
        and r.role = 'STUDENT'
        and (r.expires_at is null or r.expires_at > now())
    ) then 'STUDENT'
    when exists (
      select 1 from public.varroa_admins a where a.user_id = check_user
    ) then 'SUPERADMIN'
    else null
  end;
$$;

grant execute on function public.varroa_role_for_user(uuid) to anon, authenticated;

-- 3) Trigger: auto-rolle KUN for hviteliste
create or replace function public.varroa_auto_assign_student_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_student_expires timestamptz := '2026-12-31 23:59:59+01';
  v_role text;
  v_expires timestamptz;
begin
  v_email := lower(coalesce(NEW.email, ''));

  if v_email = 'richard141271@gmail.com' then
    v_role := 'SUPERADMIN';
    v_expires := null;
  elsif v_email = 'richard141271@icloud.com' then
    v_role := 'FAGANSVARLIG';
    v_expires := v_student_expires;
  elsif v_email = 'daniel.azam@hiof.no' then
    v_role := 'STUDENT';
    v_expires := v_student_expires;
  elsif v_email = 'torgeir.g.fjereide@hiof.no' then
    v_role := 'STUDENT';
    v_expires := v_student_expires;
  else
    return NEW;
  end if;

  insert into public.varroa_user_roles (user_id, role, expires_at, created_by)
  values (NEW.id, v_role, v_expires, NEW.id)
  on conflict (user_id) do update
    set
      role = excluded.role,
      expires_at = coalesce(public.varroa_user_roles.expires_at, excluded.expires_at),
      banned_at = case when public.varroa_user_roles.banned_at is null then null else public.varroa_user_roles.banned_at end;

  return NEW;
exception when others then
  raise warning 'varroa_auto_assign_student_role failed for %: %', NEW.id, sqlerrm;
  return NEW;
end;
$$;

drop trigger if exists varroa_auto_assign_student_role_trigger on auth.users;
create trigger varroa_auto_assign_student_role_trigger
after insert on auth.users
for each row
execute function public.varroa_auto_assign_student_role();

-- ================================================================
-- 4) FIKS: GI RIKHARD GMAIL SUPERADMIN UMIDDELBART
--    (og icloud + de 2 studentene)
-- ================================================================
insert into public.varroa_user_roles (user_id, role, expires_at, banned_at, created_by)
select
  id,
  'SUPERADMIN' as role,
  null as expires_at,
  null as banned_at,
  id as created_by
from auth.users
where lower(email) = 'richard141271@gmail.com'
on conflict (user_id) do update set
  role = 'SUPERADMIN',
  expires_at = null,
  banned_at = null;

insert into public.varroa_user_roles (user_id, role, expires_at, banned_at, created_by)
select
  id,
  'FAGANSVARLIG' as role,
  '2026-12-31 23:59:59+01' as expires_at,
  null as banned_at,
  id as created_by
from auth.users
where lower(email) = 'richard141271@icloud.com'
on conflict (user_id) do update set
  role = 'FAGANSVARLIG',
  expires_at = '2026-12-31 23:59:59+01',
  banned_at = null;

do $$
declare
  v_email text;
  v_emails text[] := array['daniel.azam@hiof.no', 'torgeir.g.fjereide@hiof.no'];
begin
  foreach v_email in array v_emails loop
    insert into public.varroa_user_roles (user_id, role, expires_at, banned_at, created_by)
    select
      id,
      'STUDENT' as role,
      '2026-12-31 23:59:59+01' as expires_at,
      null as banned_at,
      id as created_by
    from auth.users
    where lower(email) = v_email
    on conflict (user_id) do update set
      role = 'STUDENT',
      expires_at = '2026-12-31 23:59:59+01',
      banned_at = null;
  end loop;
end $$;

-- ================================================================
-- 5) RPC: List alle brukere for administrasjonspanel
-- ================================================================
create or replace function public.varroa_list_users()
returns table (
  user_id uuid,
  email text,
  created_at timestamptz,
  last_sign_in_at timestamptz,
  role text,
  role_created_at timestamptz,
  expires_at timestamptz,
  banned_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.varroa_is_privileged(auth.uid()) then
    raise exception 'Ingen tilgang.';
  end if;

  return query
  select
    a.id as user_id,
    lower(a.email) as email,
    a.created_at,
    a.last_sign_in_at,
    r.role,
    r.created_at as role_created_at,
    r.expires_at,
    r.banned_at
  from auth.users a
  left join public.varroa_user_roles r on r.user_id = a.id
  order by
    case when r.role is null and (r.banned_at is null) then 0 else 1 end,
    a.created_at desc;
end;
$$;

grant execute on function public.varroa_list_users() to authenticated;

-- ================================================================
-- 6) RPC: Oppdater/legg til/sperr/fjern rolle
-- ================================================================
create or replace function public.varroa_upsert_user_role(
  p_target_user_id uuid,
  p_new_role text default null,
  p_new_expires_at timestamptz default null,
  p_set_banned boolean default null,
  p_unused_dummy uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_has_role boolean;
  v_now timestamptz := now();
begin
  if not public.varroa_is_privileged(auth.uid()) then
    raise exception 'Ingen tilgang.';
  end if;

  if auth.uid() = p_target_user_id and p_new_role = 'SUPERADMIN' then
    raise exception 'Kan ikke endre egen rolle til SUPERADMIN.';
  end if;

  select exists (
    select 1 from public.varroa_user_roles r
    where r.user_id = p_target_user_id
  ) into v_has_role;

  if v_has_role then
    update public.varroa_user_roles
    set
      role = coalesce(p_new_role, role),
      expires_at = case
        when p_new_expires_at is not null then p_new_expires_at
        else expires_at
      end,
      banned_at = case
        when p_set_banned is true then v_now
        when p_set_banned is false then null
        else banned_at
      end
    where user_id = p_target_user_id;
  else
    if p_new_role is not null or p_set_banned is true then
      insert into public.varroa_user_roles (user_id, role, expires_at, banned_at, created_by)
      values (
        p_target_user_id,
        coalesce(p_new_role, 'STUDENT'),
        p_new_expires_at,
        case when p_set_banned is true then v_now else null end,
        auth.uid()
      );
    end if;
  end if;

  if p_new_role is null and p_set_banned is false and v_has_role then
    delete from public.varroa_user_roles
    where user_id = p_target_user_id;
  end if;

  return true;
end;
$$;

grant execute on function public.varroa_upsert_user_role(uuid, text, timestamptz, boolean, uuid) to authenticated;

-- ================================================================
-- 7) RPC: Slett submission som ADMIN (revurder, historie, bilder)
-- ================================================================
create or replace function public.varroa_delete_submission_as_admin(p_submission_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.varroa_is_privileged(auth.uid()) then
    raise exception 'Ingen tilgang.';
  end if;

  if not exists (
    select 1 from public.varroa_submissions s where s.id = p_submission_id
  ) then
    return false;
  end if;

  delete from public.varroa_submission_review_images ri
    where ri.review_id in (
      select r.id from public.varroa_submission_reviews r where r.submission_id = p_submission_id
    );

  delete from public.varroa_submission_history h where h.submission_id = p_submission_id;
  delete from public.varroa_submission_reviews r where r.submission_id = p_submission_id;
  delete from public.varroa_submissions s where s.id = p_submission_id;

  return true;
end;
$$;

grant execute on function public.varroa_delete_submission_as_admin(uuid) to authenticated;

-- ---------------------------------------------------------------
-- Ferdig!
-- Husk å gi rettigheter på tabeller (gjentas idempotent):
-- ---------------------------------------------------------------
grant select, insert, update, delete on table public.varroa_user_roles to authenticated, service_role;
grant all on table public.varroa_user_roles to postgres;

do $$
begin
  drop policy if exists "varroa_user_roles_self_read" on public.varroa_user_roles;
exception when others then null;
end $$;
create policy "varroa_user_roles_self_read"
  on public.varroa_user_roles for select to authenticated
  using (auth.uid() = user_id or public.varroa_is_privileged(auth.uid()));

do $$
begin
  drop policy if exists "varroa_user_roles_self_write" on public.varroa_user_roles;
exception when others then null;
end $$;
create policy "varroa_user_roles_self_write"
  on public.varroa_user_roles for insert to authenticated
  with check (public.varroa_is_privileged(auth.uid()));

do $$
begin
  drop policy if exists "varroa_user_roles_self_update" on public.varroa_user_roles;
exception when others then null;
end $$;
create policy "varroa_user_roles_self_update"
  on public.varroa_user_roles for update to authenticated
  using (public.varroa_is_privileged(auth.uid()))
  with check (public.varroa_is_privileged(auth.uid()));

do $$
begin
  drop policy if exists "varroa_user_roles_self_delete" on public.varroa_user_roles;
exception when others then null;
end $$;
create policy "varroa_user_roles_self_delete"
  on public.varroa_user_roles for delete to authenticated
  using (public.varroa_is_privileged(auth.uid()));
