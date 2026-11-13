-- 006_rename_drive_file_id_to_drive_item_id.sql

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'drive_items'
      and column_name = 'drive_file_id'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'drive_items'
      and column_name = 'drive_item_id'
  ) then
    alter table public.drive_items
      rename column drive_file_id to drive_item_id;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'drive_items'
      and column_name = 'parent_drive_file_id'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'drive_items'
      and column_name = 'parent_drive_item_id'
  ) then
    alter table public.drive_items
      rename column parent_drive_file_id to parent_drive_item_id;
  end if;
end $$;

do $$
declare
  old_constraint_name text;
begin
  select con.conname into old_constraint_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'drive_items'
    and con.contype = 'u'
    and pg_get_constraintdef(con.oid) like '%drive_file_id%';

  if old_constraint_name is not null then
    execute format(
      'alter table public.drive_items drop constraint if exists %I',
      old_constraint_name
    );
  end if;
end $$;

drop index if exists public.drive_items_connection_id_drive_file_id_key;
drop index if exists public.idx_drive_items_drive_file_id;
drop index if exists public.idx_drive_items_parent_drive_file_id;

do $$
begin
  if not exists (
    select 1
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'drive_items'
      and con.conname = 'drive_items_connection_id_drive_item_id_key'
  ) then
    alter table public.drive_items
      add constraint drive_items_connection_id_drive_item_id_key
      unique (connection_id, drive_item_id);
  end if;
end $$;

create index if not exists idx_drive_items_drive_item_id
  on public.drive_items (drive_item_id);

create index if not exists idx_drive_items_parent_drive_item_id
  on public.drive_items (parent_drive_item_id);
