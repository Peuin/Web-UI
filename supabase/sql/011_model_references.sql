-- Model reference images kept on Google Drive (n8n Production_07).
-- Rows are written by the model-library edge function from n8n responses;
-- the Web UI only reads them.
create table if not exists public.model_references (
  id uuid primary key default gen_random_uuid(),
  drive_file_id text not null unique,
  folder_id text not null,
  name text not null,
  mime_type text null,
  item_type text not null default 'IMAGE' check (item_type in ('FOLDER', 'IMAGE', 'OTHER')),
  size_bytes bigint null,
  thumbnail_url text null,
  web_view_link text null,
  -- "anyone with the link" URL returned by n8n; only usable once is_public = true
  public_url text null,
  is_public boolean not null default false,
  is_active boolean not null default true,
  modified_time timestamptz null,
  shared_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists model_references_folder_idx
  on public.model_references (folder_id) where is_active;

drop trigger if exists model_references_set_updated_at on public.model_references;
create trigger model_references_set_updated_at
  before update on public.model_references
  for each row execute function public.set_updated_at();

alter table public.model_references enable row level security;

grant select on table public.model_references to authenticated;

drop policy if exists "Authenticated users can read model references" on public.model_references;
create policy "Authenticated users can read model references"
  on public.model_references
  for select
  to authenticated
  using (true);
