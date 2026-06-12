do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'varroa_submissions'
      and policyname = 'varroa_submissions_select_anyone'
  ) then
    drop policy varroa_submissions_select_anyone on public.varroa_submissions;
  end if;
end $$;

revoke select on table public.varroa_submissions from anon;

do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'storage_varroa_read_anyone'
  ) then
    drop policy storage_varroa_read_anyone on storage.objects;
  end if;
end $$;

