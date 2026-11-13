-- 008_final_items.sql

create table if not exists public.final_items (
  id uuid primary key default gen_random_uuid(),
  drive_item_id text not null unique,
  parent_drive_item_id text,
  name text not null,
  mime_type text,
  item_type text not null default 'OTHER', -- FOLDER, IMAGE, VIDEO, DOCUMENT, OTHER
  size_bytes bigint,
  thumbnail_url text,
  web_view_link text,
  modified_time timestamptz,
  source_folder_id text not null,
  raw_payload jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists final_items_set_updated_at on public.final_items;
create trigger final_items_set_updated_at
  before update on public.final_items
  for each row execute function public.set_updated_at();

alter table public.final_items enable row level security;

drop policy if exists "Authenticated users can select final_items" on public.final_items;
create policy "Authenticated users can select final_items"
  on public.final_items for select
  to authenticated using (true);

