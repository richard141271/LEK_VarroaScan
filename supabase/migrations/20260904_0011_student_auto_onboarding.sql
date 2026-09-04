-- ================================================================
-- 0011 — STUDENT AUTO-ONBOARDING (magic link + auto role)
-- Idempotent: try/catch / if not exists overalt. Kjør trygt.
-- ================================================================

-- ---------------------------------------------------------------
-- 1. Legg til utløpsdato på roller (gjelder f.eks. til 31.12.2026)
-- ---------------------------------------------------------------
do $$
begin
  alter table public.varroa_user_roles
    add column if not exists expires_at timestamptz;
exception
  when duplicate_column then null;
end $$;

-- ---------------------------------------------------------------
-- 2. Oppdater varroa_role_for_user — ignorer utløpte roller
--    (hvis expires_at er satt OG nå() >= expires_at → rollen teller ikke)
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
        and r.role = 'SUPERADMIN'
        and (r.expires_at is null or r.expires_at > now())
    ) then 'SUPERADMIN'
    when exists (
      select 1 from public.varroa_user_roles r
      where r.user_id = check_user
        and r.role = 'FAGANSVARLIG'
        and (r.expires_at is null or r.expires_at > now())
    ) then 'FAGANSVARLIG'
    when exists (
      select 1 from public.varroa_user_roles r
      where r.user_id = check_user
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

-- ---------------------------------------------------------------
-- 3. Trigger: auto-tildel STUDENT-rolle når ny bruker opprettes
--    (kjøres når magic link / passord-signup oppretter i auth.users)
--
--    Tilbyr STUDENT bare for kjente HIØ-eposter. Legg til flere
--    domener under dersom dere trenger det.
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
begin
  v_email := lower(coalesce(NEW.email, ''));

  -- Bare kjør hvis det er en e-post vi kjenner igjen (HIØ-studenter/fagansvarlige)
  -- LEGG TIL FLERE DOMENER HER OM NØDVENDIG:
  if v_email ~* '(^|@)(hiof\.no|stud\.hiof\.no|hit\.no|stud\.hit\.no)$' then
    insert into public.varroa_user_roles (user_id, role, expires_at, created_by)
    values (
      NEW.id,
      'STUDENT',
      v_student_expires,
      NEW.id
    )
    on conflict (user_id) do nothing;
  end if;

  return NEW;
end;
$$;

drop trigger if exists varroa_auto_assign_student_role_trigger on auth.users;

create trigger varroa_auto_assign_student_role_trigger
after insert on auth.users
for each row
execute function public.varroa_auto_assign_student_role();

-- ---------------------------------------------------------------
-- 4. Samme rettigheter til rollen som tidligere (oppdateres pga ny kolonne)
-- ---------------------------------------------------------------
grant select, insert, update, delete on table public.varroa_user_roles to authenticated;
grant all on table public.varroa_user_roles to postgres;

do $$
begin
  drop policy if exists "varroa_user_roles_self_read" on public.varroa_user_roles;
exception when others then null;
end $$;

create policy "varroa_user_roles_self_read"
  on public.varroa_user_roles
  for select
  to authenticated
  using (
    auth.uid() = user_id
    or public.varroa_is_privileged(auth.uid())
  );

do $$
begin
  drop policy if exists "varroa_user_roles_self_write" on public.varroa_user_roles;
exception when others then null;
end $$;

create policy "varroa_user_roles_self_write"
  on public.varroa_user_roles
  for insert
  to authenticated
  with check (
    public.varroa_is_privileged(auth.uid())
  );

do $$
begin
  drop policy if exists "varroa_user_roles_self_update" on public.varroa_user_roles;
exception when others then null;
end $$;

create policy "varroa_user_roles_self_update"
  on public.varroa_user_roles
  for update
  to authenticated
  using (public.varroa_is_privileged(auth.uid()))
  with check (public.varroa_is_privileged(auth.uid()));

do $$
begin
  drop policy if exists "varroa_user_roles_self_delete" on public.varroa_user_roles;
exception when others then null;
end $$;

create policy "varroa_user_roles_self_delete"
  on public.varroa_user_roles
  for delete
  to authenticated
  using (public.varroa_is_privileged(auth.uid()));

-- ---------------------------------------------------------------
-- Ferdig!
-- Oppsummering:
--   - varroa_user_roles.expires_at = når rolle utløper (f.eks. 31.12.2026)
--   - varroa_role_for_user() ignorerer nå utløpte roller
--   - Trigger på auth.users tildeler AUTOMATISK STUDENT for
--     @hiof.no / @stud.hiof.no / @hit.no / @stud.hit.no
--     utløpt 31.12.2026 23:59 norsk tid
-- ---------------------------------------------------------------
