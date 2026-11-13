-- 007_drive_items_soft_delete.sql

alter table public.drive_items
  add column if not exists deleted_at timestamptz;

create index if not exists drive_items_connection_parent_deleted_idx
  on public.drive_items (connection_id, parent_drive_item_id, deleted_at);

create index if not exists drive_items_sync_status_deleted_idx
  on public.drive_items (sync_status, deleted_at);
