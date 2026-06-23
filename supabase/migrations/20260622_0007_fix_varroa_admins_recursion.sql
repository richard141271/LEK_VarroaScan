drop policy if exists varroa_admins_admin_select on public.varroa_admins;
drop policy if exists varroa_admins_admin_insert on public.varroa_admins;

create policy varroa_admins_read_own
  on public.varroa_admins
  for select
  to authenticated
  using (user_id = auth.uid());

create policy varroa_admins_insert_own
  on public.varroa_admins
  for insert
  to authenticated
  with check (user_id = auth.uid());
