-- Auth metadata cleanup.
-- The app now stores user-facing auth data in auth.users metadata:
-- - raw_user_meta_data: username, display_name
-- - raw_app_meta_data: role
-- Use the Supabase Auth Admin API from the auth Edge Function to update it.

drop trigger if exists on_auth_user_created_profile on auth.users;

do $$
begin
  if to_regclass('public.user_profiles') is not null then
    drop trigger if exists user_profiles_set_updated_at on public.user_profiles;
  end if;
end $$;

drop function if exists public.handle_new_auth_user();

drop table if exists public.user_profiles;
drop type if exists public.app_role;
