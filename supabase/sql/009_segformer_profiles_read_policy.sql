-- Let signed-in Web-UI users read product types for the generation form.
grant select on table public.baartwork_segformer_profiles to authenticated;

drop policy if exists "Authenticated users can read segformer profiles"
  on public.baartwork_segformer_profiles;

create policy "Authenticated users can read segformer profiles"
  on public.baartwork_segformer_profiles
  for select
  to authenticated
  using (true);
