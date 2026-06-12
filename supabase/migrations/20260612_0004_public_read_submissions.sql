do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'varroa_submissions'
      and policyname = 'varroa_submissions_select_anyone'
  ) then
    create policy varroa_submissions_select_anyone
      on public.varroa_submissions
      for select
      to anon, authenticated
      using (true);
  end if;
end $$;

grant select on table public.varroa_submissions to anon;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'storage_varroa_read_anyone'
  ) then
    create policy storage_varroa_read_anyone
      on storage.objects
      for select
      to anon, authenticated
      using (bucket_id = 'varroa-submissions' and name like 'submissions/%');
  end if;
end $$;

