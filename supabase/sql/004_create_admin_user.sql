-- Create or Update Admin User for Supabase Auth
-- Username / Identifier: admin (or admin@admin.local)
-- Password: admin
-- Role: admin

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $$
declare
  v_admin_id uuid;
  v_email text := 'admin@admin.local';
  v_password text := 'admin';
  v_encrypted_password text;
begin
  -- Generate bcrypt encrypted password hash
  v_encrypted_password := extensions.crypt(v_password, extensions.gen_salt('bf', 10));

  -- Check if admin user already exists by email
  select id into v_admin_id from auth.users where lower(email) = lower(v_email);

  if v_admin_id is not null then
    -- Update existing admin user password & metadata
    update auth.users
    set
      encrypted_password = v_encrypted_password,
      email_confirmed_at = coalesce(email_confirmed_at, now()),
      raw_app_meta_data = jsonb_build_object(
        'provider', 'email',
        'providers', array['email'],
        'role', 'admin'
      ),
      raw_user_meta_data = jsonb_build_object(
        'username', 'admin',
        'display_name', 'Admin'
      ),
      updated_at = now()
    where id = v_admin_id;
  else
    -- Generate new UUID for admin
    v_admin_id := gen_random_uuid();

    -- Insert new user into auth.users
    insert into auth.users (
      instance_id,
      id,
      aud,
      role,
      email,
      encrypted_password,
      email_confirmed_at,
      raw_app_meta_data,
      raw_user_meta_data,
      created_at,
      updated_at,
      confirmation_token,
      email_change,
      email_change_token_new,
      recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000',
      v_admin_id,
      'authenticated',
      'authenticated',
      v_email,
      v_encrypted_password,
      now(),
      jsonb_build_object(
        'provider', 'email',
        'providers', array['email'],
        'role', 'admin'
      ),
      jsonb_build_object(
        'username', 'admin',
        'display_name', 'Admin'
      ),
      now(),
      now(),
      '',
      '',
      '',
      ''
    );
  end if;

  -- Ensure identity record exists in auth.identities
  if not exists (
    select 1 from auth.identities 
    where user_id = v_admin_id and provider = 'email'
  ) then
    insert into auth.identities (
      id,
      user_id,
      identity_data,
      provider,
      provider_id,
      last_sign_in_at,
      created_at,
      updated_at
    ) values (
      v_admin_id,
      v_admin_id,
      jsonb_build_object('sub', v_admin_id::text, 'email', v_email),
      'email',
      v_admin_id::text,
      now(),
      now(),
      now()
    );
  else
    update auth.identities
    set
      identity_data = jsonb_build_object('sub', v_admin_id::text, 'email', v_email),
      updated_at = now()
    where user_id = v_admin_id and provider = 'email';
  end if;

end $$;
