-- 005_drive_metadata.sql

create table if not exists public.drive_connections (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  connection_type text not null default 'MY_DRIVE',
  root_folder_id text,
  created_by uuid references auth.users(id) on delete set null,
  status text not null default 'ACTIVE',
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.drive_connections
  add column if not exists created_by uuid references auth.users(id) on delete set null;

create table if not exists public.drive_items (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null references public.drive_connections(id) on delete cascade,
  drive_item_id text not null,
  parent_drive_item_id text,
  name text not null,
  mime_type text,
  item_type text not null default 'OTHER', -- FOLDER, IMAGE, VIDEO, DOCUMENT, OTHER
  size_bytes bigint,
  thumbnail_url text,
  web_view_link text,
  modified_time timestamptz,
  sync_status text not null default 'SYNCED',
  deleted_at timestamptz,
  cached_storage_path text,
  cached_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(connection_id, drive_item_id)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke execute on function public.set_updated_at() from PUBLIC, anon, authenticated;

-- Triggers to auto-update updated_at
drop trigger if exists drive_connections_set_updated_at on public.drive_connections;
create trigger drive_connections_set_updated_at
  before update on public.drive_connections
  for each row execute function public.set_updated_at();

drop trigger if exists drive_items_set_updated_at on public.drive_items;
create trigger drive_items_set_updated_at
  before update on public.drive_items
  for each row execute function public.set_updated_at();

-- RLS policies
alter table public.drive_connections enable row level security;
alter table public.drive_items enable row level security;

-- Policies for drive_connections (Authenticated users can read)
drop policy if exists "Authenticated users can select drive_connections" on public.drive_connections;
create policy "Authenticated users can select drive_connections"
  on public.drive_connections for select
  to authenticated using (true);

-- Policies for drive_items (Authenticated users can read)
drop policy if exists "Authenticated users can select drive_items" on public.drive_items;
create policy "Authenticated users can select drive_items"
  on public.drive_items for select
  to authenticated using (true);

-- Insert a default connection if it doesn't exist so UI can sync
do $$
declare
  v_admin_id uuid;
begin
  select id into v_admin_id
  from auth.users
  where lower(email) = 'admin@admin.local'
  limit 1;

  if v_admin_id is null then
    raise exception 'Run 004_create_admin_user.sql before 005_drive_metadata.sql';
  end if;

  insert into public.drive_connections (
    id,
    name,
    connection_type,
    root_folder_id,
    created_by
  )
  values (
    '00000000-0000-0000-0000-000000000000',
    'Default Drive',
    'MY_DRIVE',
    '1KrFpZP-Po0suX8tg7xxWD1uPc8HOQtaN',
    v_admin_id
  )
  on conflict (id) do update set
    root_folder_id = case
      when public.drive_connections.root_folder_id is null
        or public.drive_connections.root_folder_id = 'root'
      then excluded.root_folder_id
      else public.drive_connections.root_folder_id
    end,
    created_by = coalesce(public.drive_connections.created_by, excluded.created_by),
    updated_at = now();
end $$;
