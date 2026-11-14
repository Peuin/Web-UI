-- 012_perf_indexes.sql
-- Indexes for the folder-listing queries used by drive-list-folder and
-- final-files, plus Realtime publication so the Web UI can refresh an open
-- folder the moment a sync writes rows (replaces client-side polling).

create index if not exists final_items_parent_type_modified_idx
  on public.final_items (parent_drive_item_id, item_type, modified_time desc);

create index if not exists final_items_source_modified_idx
  on public.final_items (source_folder_id, modified_time desc);

create index if not exists drive_items_list_idx
  on public.drive_items (connection_id, parent_drive_item_id, item_type, modified_time desc)
  where deleted_at is null;

-- Publish both tables on supabase_realtime for postgres_changes subscriptions.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'drive_items'
    ) then
      alter publication supabase_realtime add table public.drive_items;
    end if;

    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'final_items'
    ) then
      alter publication supabase_realtime add table public.final_items;
    end if;
  end if;
end $$;
