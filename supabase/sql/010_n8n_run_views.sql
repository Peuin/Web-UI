-- Read-only views over n8n_run for the Web UI / ops.
--   kind = 'batch'  : one Web UI submission (created by Production_01 "Create Batch Run")
--   kind = 'folder' : one Drive folder in that batch's scan tree, linked by batch_id and
--                     parent_drive_folder_id (inserted by "Create Root Scan Run" / "Insert Child Scan Rows")

-- One row per batch with its folder counts by status.
create or replace view public.n8n_run_batch_overview
with (security_invoker = true) as
select
  b.id                                   as batch_id,
  b.status                               as batch_status,
  b.root_drive_folder_id,
  b.input_json ->> 'product_type'        as product_type,
  b.input_json ->> 'output_type'         as output_type,
  b.n8n_execution_id,
  b.started_at,
  b.finished_at,
  b.created_at,
  b.updated_at,
  count(f.id)                                              as folders_total,
  count(f.id) filter (where f.status = 'queued_scan')      as folders_queued_scan,
  count(f.id) filter (where f.status = 'scanning')         as folders_scanning,
  count(f.id) filter (where f.status = 'ready')            as folders_ready,
  count(f.id) filter (where f.status = 'processing')       as folders_processing,
  count(f.id) filter (where f.status = 'completed')        as folders_completed,
  count(f.id) filter (where f.status = 'skipped')          as folders_skipped,
  count(f.id) filter (where f.status = 'failed')           as folders_failed,
  b.result_json                          as batch_result,
  b.error_json                           as batch_error
from public.n8n_run b
left join public.n8n_run f
  on f.batch_id = b.id and f.kind = 'folder'
where b.kind = 'batch'
group by b.id;

-- Folder scan tree: each folder row with its batch and parent folder row.
create or replace view public.n8n_run_folder_tree
with (security_invoker = true) as
select
  f.id                                   as run_id,
  f.batch_id,
  b.status                               as batch_status,
  f.status,
  f.depth,
  f.source_path,
  f.result_json ->> 'source_name'        as source_name,
  f.source_drive_folder_id,
  f.parent_drive_folder_id,
  p.id                                   as parent_run_id,
  (f.result_json ->> 'direct_image_count')::int        as direct_image_count,
  (f.result_json ->> 'direct_child_folder_count')::int as direct_child_folder_count,
  f.attempt,
  f.worker_execution_id,
  f.error_json,
  f.started_at,
  f.finished_at,
  f.created_at,
  f.updated_at
from public.n8n_run f
join public.n8n_run b
  on b.id = f.batch_id and b.kind = 'batch'
left join public.n8n_run p
  on p.batch_id = f.batch_id
 and p.kind = 'folder'
 and p.source_drive_folder_id = f.parent_drive_folder_id
where f.kind = 'folder';
