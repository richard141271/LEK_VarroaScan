grant usage on schema public to anon, authenticated;

grant insert on table public.varroa_submissions to anon, authenticated;
grant select, update on table public.varroa_submissions to authenticated;

grant select, insert on table public.varroa_admins to authenticated;
grant select, insert, update, delete on table public.varroa_labels to authenticated;
grant select, insert, update, delete on table public.varroa_models to authenticated;

