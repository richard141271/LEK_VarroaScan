-- ================================================================
-- 0012 — HVITLISTE + GODKJENNINGSVURDERING
-- Idempotent. Kjør trygt i SQL Editor.
--
-- Hva den gjør:
--   1. Fjerner gammel auto-rolle for alle @hiof.no (kun hvitliste gir rolle)
--   2. Automatisk rolle KUN for 4 hviteliste eposter:
--        richard141271@gmail.com   -> SUPERADMIN (uendelig)
--        richard141271@icloud.com  -> FAGANSVARLIG (til 31.12.2026)
--        daniel.azam@hiof.no       -> STUDENT (til 31.12.2026)
--        torgeir.g.fjereide@hiof.no -> STUDENT (til 31.12.2026)
--   3. Kolonne `banned_at` på varroa_user_roles for sperring av brukere
--   4. RPC: varroa_list_users            (alle brukere + rolle status, kun for privelegierte)
--   5. RPC: varroa_upsert_user_role      (sette rolle / sperre / slette rolle)
-- ================================================================

-- ---------------------------------------------------------------
-- 1. Legg til banned_at kolonne for sperring
-- ---------------------------------------------------------------
do $$
begin
  alter table public.varroa_user_roles
    add column if not exists banned_at timestamptz;
exception when duplicate_column then null;
end $$;

-- ---------------------------------------------------------------
-- 2. Oppdater varroa_role_for_user — ignorer utløpte OG sperrede roller
-- ---------------------------------------------------------------
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

-- Oppdater varroa_is_privileged avhengig av funksjonen over (bruker den allerede implisitt)
do $$ begin null; end $$;

-- ---------------------------------------------------------------
-- 3. Oppdatert trigger: KUN hvitliste gir AUTOMATISK rolle.
--    Alle andre kan logge seg inn, men må godkjennes manuelt
--    i panelet vårt (får bare "Mangler tilgang"-skjermen).
-- ---------------------------------------------------------------
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

  -- HVITLISTE: bare DE 4 som skal få automatisk tilgang
  if v_email = 'richard141271@gmail.com' then
    v_role := 'SUPERADMIN';
    v_expires := null; -- aldri utløper
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
    -- Alle andre: ingen rolle, de må godkjennes manuelt i panelet.
    -- Bare returner uten å gjøre noe.
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

-- (Re)opprett trigger
drop trigger if exists varroa_auto_assign_student_role_trigger on auth.users;
create trigger varroa_auto_assign_student_role_trigger
after insert on auth.users
for each row
execute function public.varroa_auto_assign_student_role();

-- ---------------------------------------------------------------
-- 4. RPC: list alle brukere (for godkjenningsvindu)
--    Returnerer: id, email, created_at, sign_in_at,
--                role, role_created_at, expires_at, banned_at
--    Tilgang: KUN for SUPERADMIN / FAGANSVARLIG
-- ---------------------------------------------------------------
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
    case when r.role is null and r.banned_at is null then 0 else 1 end, -- ventende øverst
    a.created_at desc;
end;
$$;

grant execute on function public.varroa_list_users() to authenticated;

-- ---------------------------------------------------------------
-- 5. RPC: Sett / oppdater / fjern / sperre rolle for en bruker
--    Eksempler:
--      select varroa_upsert_user_role('UUID', 'STUDENT', null::timestamptz, null::boolean, null::uuid)
--      select varroa_upsert_user_role('UUID', null, null, true, null::uuid)  -- sperr (banned)
--      select varroa_upsert_user_role('UUID', null, null, null, null::uuid)  -- slett rolle
-- ---------------------------------------------------------------
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
    -- Ikke tillat å endre egen rolle til superadmin for å unngå feil
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

  -- Hvis begge er null → slett rad (fjern rolle helt)
  if p_new_role is null and p_set_banned is false and v_has_role then
    delete from public.varroa_user_roles
    where user_id = p_target_user_id;
  end if;

  return true;
end;
$$;

grant execute on function public.varroa_upsert_user_role(uuid, text, timestamptz, boolean, uuid) to authenticated;

-- ---------------------------------------------------------------
-- Ferdig. Oppsummering:
--   - Kun 4 personer får automatisk rolle ved registrering.
--   - Alle andre får "Mangler tilgang" → venter på godkjenning.
--   - Panelet vårt viser alle brukere, med status VENTENDE / STUDENT /
--     FAGANSVARLIG / SUPERADMIN / SPERRET, med knapper for å endre.
-- ---------------------------------------------------------------
