-- Full schema baseline for Supabase project "n8n" (svykhovdpaviqgouaafh)
-- Generated 2026-11-24 with `supabase db dump` (pg_dump, schema only, no data).
-- Part 1: public schema + extensions (pg_dump output).
-- Part 2 (end of file): storage buckets/policies, Vault token and pg_cron jobs,
--          which pg_dump does not include.




SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."baartwork_prompt_revision"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$ begin new.prompt_version:=old.prompt_version+1;new.updated_at:=now();return new;end $$;


ALTER FUNCTION "public"."baartwork_prompt_revision"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."baartwork_segformer_profile_revision"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'pg_catalog', 'public'
    AS $$
begin new.profile_version := old.profile_version+1; new.updated_at := now(); return new; end $$;


ALTER FUNCTION "public"."baartwork_segformer_profile_revision"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_baartwork_exact_folder"("p_batch_id" "uuid", "p_job_id" "uuid", "p_execution_id" "text", "p_global_worker_limit" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$ declare b public.n8n_run; j public.n8n_run; active integer; begin if p_execution_id is null or length(p_execution_id)=0 or p_global_worker_limit is null or p_global_worker_limit<1 then raise exception 'Invalid execution or limit'; end if; perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.n8n_run:baartwork-workers',0)); select * into b from public.n8n_run where id=p_batch_id and kind='batch' for update; if not found or b.status not in ('failed','processing','scanning','ready') or jsonb_typeof(b.prompt_snapshot) is distinct from 'object' then raise exception 'Batch not eligible'; end if; select * into j from public.n8n_run where id=p_job_id and batch_id=p_batch_id and kind='folder' for update; if not found or j.status<>'ready' or j.worker_execution_id is not null then raise exception 'Exact job not eligible'; end if; select count(*) into active from public.n8n_run where kind='folder' and status='processing'; if active>=p_global_worker_limit then raise exception 'Global worker cap reached'; end if; update public.n8n_run set status='processing',attempt=coalesce(attempt,0)+1,worker_execution_id=p_execution_id,started_at=clock_timestamp(),finished_at=null,updated_at=clock_timestamp(),result_json=coalesce(result_json,'{}'::jsonb)||jsonb_build_object('resume_audit',jsonb_build_object('previous_error',error_json,'previous_status',status,'execution_id',p_execution_id,'claimed_at',clock_timestamp())) where id=p_job_id returning * into j; update public.n8n_run set status='processing',finished_at=null,updated_at=clock_timestamp() where id=p_batch_id; return jsonb_build_object('claimed',jsonb_build_array(to_jsonb(j)),'prompt_snapshot',b.prompt_snapshot); end $$;


ALTER FUNCTION "public"."claim_baartwork_exact_folder"("p_batch_id" "uuid", "p_job_id" "uuid", "p_execution_id" "text", "p_global_worker_limit" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_baartwork_folder_workers"("p_batch_id" "uuid", "p_requested_slots" integer, "p_global_worker_limit" integer, "p_worker_timeout_seconds" integer) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
declare
  v_global_active integer := 0;
  v_slots integer := 0;
  v_claimed jsonb := '[]'::jsonb;
  v_ready integer := 0;
  v_processing integer := 0;
  v_timed_out integer := 0;
begin
  if p_requested_slots < 1
    or p_global_worker_limit < 1
    or p_worker_timeout_seconds < 1 then
    raise exception 'worker limits and timeout must be positive integers';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('public.n8n_run:baartwork-workers', 0));

  with timed_out as (
    update public.n8n_run
    set
      status = 'failed',
      error_json = jsonb_build_object(
        'code', 'worker_timeout',
        'message', 'Worker did not report a terminal state before the configured timeout',
        'timeout_seconds', p_worker_timeout_seconds,
        'timed_out_at', clock_timestamp()
      ),
      finished_at = clock_timestamp(),
      updated_at = clock_timestamp()
    where kind = 'folder'
      and status = 'processing'
      and coalesce(updated_at, started_at, created_at)
          < clock_timestamp() - make_interval(secs => p_worker_timeout_seconds)
    returning 1
  )
  select count(*) into v_timed_out from timed_out;

  select count(*) into v_global_active
  from public.n8n_run
  where kind = 'folder' and status = 'processing';

  v_slots := least(
    p_requested_slots,
    greatest(p_global_worker_limit - v_global_active, 0)
  );

  if v_slots > 0 then
    with selected as (
      select id
      from public.n8n_run
      where batch_id = p_batch_id
        and kind = 'folder'
        and status = 'ready'
      order by depth, source_path, created_at
      limit v_slots
      for update skip locked
    ), claimed as (
      update public.n8n_run as run
      set
        status = 'processing',
        attempt = run.attempt + 1,
        started_at = coalesce(run.started_at, clock_timestamp()),
        updated_at = clock_timestamp()
      from selected
      where run.id = selected.id
      returning run.*
    )
    select coalesce(
      jsonb_agg(to_jsonb(claimed) order by claimed.depth, claimed.source_path, claimed.created_at),
      '[]'::jsonb
    )
    into v_claimed
    from claimed;
  end if;

  select count(*) into v_ready
  from public.n8n_run
  where batch_id = p_batch_id
    and kind = 'folder'
    and status = 'ready';

  select count(*) into v_processing
  from public.n8n_run
  where batch_id = p_batch_id
    and kind = 'folder'
    and status = 'processing';

  return jsonb_build_object(
    'claimed', v_claimed,
    'batch_ready_count', v_ready,
    'batch_processing_count', v_processing,
    'global_processing_count', v_global_active,
    'timed_out_count', v_timed_out
  );
end;
$$;


ALTER FUNCTION "public"."claim_baartwork_folder_workers"("p_batch_id" "uuid", "p_requested_slots" integer, "p_global_worker_limit" integer, "p_worker_timeout_seconds" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."claim_baartwork_folder_workers"("p_batch_id" "uuid", "p_requested_slots" integer, "p_global_worker_limit" integer, "p_worker_timeout_seconds" integer) IS 'Atomically claims ready BAArtwork folder jobs with a global worker cap and marks stale workers failed.';



CREATE OR REPLACE FUNCTION "public"."claim_folder_retry"("p_job_id" "uuid", "p_request_id" "uuid", "p_execution_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare j public.n8n_run;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.n8n_run:baartwork-workers',0));
 select * into j from public.n8n_run where id=p_job_id and kind='folder' for update;
 if not found or j.last_retry_request_id is distinct from p_request_id or j.last_retry_status<>'queued' then return jsonb_build_object('action','skip','reason','not_owned_queued_retry');end if;
 if exists(select 1 from public.n8n_run a where a.kind='folder' and a.source_drive_folder_id=j.source_drive_folder_id and a.status='processing') or (select count(*) from public.n8n_run where kind='folder' and status='processing')>=2 then return jsonb_build_object('action','wait');end if;
 update public.n8n_run set status='processing',last_retry_status='processing',last_retry_execution_id=p_execution_id,worker_execution_id=p_execution_id,attempt=attempt+1,finished_at=null,error_json=null,updated_at=clock_timestamp() where id=p_job_id returning * into j;
 return jsonb_build_object('action','claimed','job',to_jsonb(j));
end $$;


ALTER FUNCTION "public"."claim_folder_retry"("p_job_id" "uuid", "p_request_id" "uuid", "p_execution_id" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fail_baartwork_exact_folder"("p_batch_id" "uuid", "p_job_id" "uuid", "p_execution_id" "text", "p_error" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$ declare j public.n8n_run; terminal boolean; failed boolean; begin if p_execution_id is null or length(p_execution_id)=0 or p_error is null then raise exception 'Failure context required'; end if; perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.n8n_run:baartwork-workers',0)); perform 1 from public.n8n_run where id=p_batch_id and kind='batch' for update; update public.n8n_run set status='failed',error_json=jsonb_build_object('code','worker_execution_failed','execution_id',p_execution_id,'original_error',p_error,'previous_error',error_json,'failed_at',clock_timestamp()),finished_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_job_id and batch_id=p_batch_id and kind='folder' and status='processing' and worker_execution_id=p_execution_id returning * into j; if not found then return jsonb_build_object('updated',false,'reason','not_owned_processing_job'); end if; select not exists(select 1 from public.n8n_run where batch_id=p_batch_id and kind='folder' and status not in ('completed','skipped','failed')),exists(select 1 from public.n8n_run where batch_id=p_batch_id and kind='folder' and status='failed') into terminal,failed; if terminal then update public.n8n_run set status=case when failed then 'failed' else 'completed' end,error_json=jsonb_build_object('code','folder_worker_failed','job_id',p_job_id,'execution_id',p_execution_id,'previous_error',error_json),finished_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_batch_id and kind='batch' and status in ('ready','scanning','processing','failed'); end if; return jsonb_build_object('updated',true,'job_id',j.id,'status',j.status,'batch_terminal',terminal); end $$;


ALTER FUNCTION "public"."fail_baartwork_exact_folder"("p_batch_id" "uuid", "p_job_id" "uuid", "p_execution_id" "text", "p_error" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."finish_folder_retry"("p_job_id" "uuid", "p_request_id" "uuid", "p_error" "jsonb" DEFAULT NULL::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare j public.n8n_run;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.n8n_run:baartwork-workers',0));
 select * into j from public.n8n_run where id=p_job_id and kind='folder' for update;
 if j.last_retry_request_id is distinct from p_request_id then return jsonb_build_object('updated',false);end if;
 if j.last_retry_status='processing' and j.status='processing' and j.worker_execution_id=j.last_retry_execution_id then
 update public.n8n_run set status='failed',error_json=coalesce(p_error,jsonb_build_object('code','RETRY_WORKER_RETURNED_WITHOUT_COMPLETION')),finished_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_job_id returning * into j;
 end if;
 return jsonb_build_object('job_id',j.id,'retry_no',j.retry_count,'status',j.status,'last_retry_status',j.last_retry_status);
end $$;


ALTER FUNCTION "public"."finish_folder_retry"("p_job_id" "uuid", "p_request_id" "uuid", "p_error" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."n8n_endpoint_events_set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."n8n_endpoint_events_set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."queue_folder_retries"("p_request_id" "uuid", "p_job_ids" "uuid"[]) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare j public.n8n_run; v_job_id uuid; accepted jsonb:='[]'; skipped jsonb:='[]'; reason text; b public.n8n_run; original_name text;
begin
 if p_request_id is null or p_job_ids is null or cardinality(p_job_ids) not between 1 and 100 then raise exception 'REQUEST_UUID_AND_1_TO_100_JOB_UUIDS_REQUIRED'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.n8n_run:baartwork-workers',0));
 for v_job_id in select distinct unnest(p_job_ids) order by 1 loop
  select * into j from public.n8n_run where n8n_run.id=v_job_id and kind='folder' for update;
  reason:=null;
  if found and left(coalesce(j.input_json->>'original_source_name',''),2)='X_' then
   select h.input_json->>'original_source_name' into original_name from public.n8n_run h where h.kind='folder' and h.source_drive_folder_id=j.source_drive_folder_id and left(coalesce(h.input_json->>'original_source_name',''),2)<>'X_' and nullif(h.input_json->>'original_source_name','') is not null order by h.created_at desc limit 1;
   if original_name is not null then j.input_json:=jsonb_set(jsonb_set(j.input_json,'{original_source_name}',to_jsonb(original_name)),'{original_path_names}',coalesce((select jsonb_agg(case when ord=jsonb_array_length(j.input_json->'original_path_names') then to_jsonb(original_name) else val end order by ord) from jsonb_array_elements(j.input_json->'original_path_names') with ordinality t(val,ord)),'[]'::jsonb));end if;
  end if;
  if j.id is null then reason:='job_not_found';
  elsif p_request_id=any(j.retry_request_ids) then reason:='duplicate_request';
  elsif j.status not in ('failed','completed','skipped') then reason:='job_not_retryable';
  elsif coalesce(j.last_retry_status,'') in ('queued','processing') then reason:='retry_already_active';
  elsif exists(select 1 from public.n8n_run a where a.kind='folder' and a.source_drive_folder_id=j.source_drive_folder_id and (a.status='processing' or coalesce(a.last_retry_status,'') in ('queued','processing'))) then reason:='folder_busy';
  elsif (coalesce(j.input_json->>'original_source_name','')='' or left(j.input_json->>'original_source_name',2)='X_') or not(j.input_json->'original_path_names' is not null) then reason:='original_name_missing';
  elsif j.result_json->>'classification'='needs_review' and j.error_json->>'code' in ('BR18_AMBIGUOUS_OR_FAILED_BRANCH','BR18_SCAN_INCOMPLETE') then reason:='branch_review_required';
  end if;
  if reason is null then
   select * into b from public.n8n_run where n8n_run.id=j.batch_id and kind='batch';
   if b.prompt_snapshot is null or b.prompt_snapshot->>'output_config_id'<>'1' then reason:='batch_snapshot_missing'; end if;
  end if;
  if reason is not null then skipped:=skipped||jsonb_build_array(jsonb_build_object('job_id',v_job_id,'reason',reason));continue;end if;
  update public.n8n_run set retry_count=retry_count+1,last_retry_status='queued',last_retry_at=clock_timestamp(),last_retry_error=null,last_retry_request_id=p_request_id,input_json=j.input_json,retry_request_ids=array_append(retry_request_ids,p_request_id),retry_mode=null,updated_at=clock_timestamp() where n8n_run.id=v_job_id;
  accepted:=accepted||jsonb_build_array(jsonb_build_object('job_id',v_job_id,'batch_id',j.batch_id,'retry_no',j.retry_count+1));
 end loop;
 return jsonb_build_object('request_id',p_request_id,'accepted',accepted,'skipped',skipped);
end $$;


ALTER FUNCTION "public"."queue_folder_retries"("p_request_id" "uuid", "p_job_ids" "uuid"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."start_folder_retry_worker"("p_job_id" "uuid", "p_request_id" "uuid", "p_parent_execution_id" "text", "p_execution_id" "text", "p_mode" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare j public.n8n_run;b public.n8n_run;old_result jsonb;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('public.n8n_run:baartwork-workers',0));
 select * into j from public.n8n_run where id=p_job_id and kind='folder' for update;
 if found and j.status='processing' and j.last_retry_status='processing' and j.last_retry_request_id=p_request_id and j.worker_execution_id=p_execution_id and j.retry_mode=p_mode then
  select * into b from public.n8n_run where id=j.batch_id and kind='batch';
  return jsonb_build_object('job',to_jsonb(j),'snapshot',b.prompt_snapshot,'batch_created_at',b.created_at);
 end if;
 if not found or j.status<>'processing' or j.last_retry_status<>'processing' or j.last_retry_request_id is distinct from p_request_id or j.worker_execution_id<>p_parent_execution_id then raise exception 'RETRY_WORKER_CLAIM_NOT_OWNED';end if;
 if p_mode is null or p_mode not in ('finalize','regenerate') or coalesce(p_execution_id,'')='' then raise exception 'RETRY_MODE_OR_EXECUTION_INVALID';end if;
 select * into b from public.n8n_run where id=j.batch_id and kind='batch';
 old_result:=coalesce(j.result_json,'{}');
 update public.n8n_run set worker_execution_id=p_execution_id,last_retry_execution_id=p_execution_id,retry_mode=p_mode,retry_previous_result=old_result,
 result_json=case when p_mode='regenerate' then jsonb_build_object('classification_contract',1,'direct_image_count',coalesce(old_result->'direct_image_count',to_jsonb(1)),'retry_generation',true) else old_result end,updated_at=clock_timestamp() where id=p_job_id returning * into j;
 return jsonb_build_object('job',to_jsonb(j),'snapshot',b.prompt_snapshot,'batch_created_at',b.created_at);
end $$;


ALTER FUNCTION "public"."start_folder_retry_worker"("p_job_id" "uuid", "p_request_id" "uuid", "p_parent_execution_id" "text", "p_execution_id" "text", "p_mode" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_folder_processing"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
declare
 r jsonb:=coalesce(new.result_json,'{}'::jsonb);
 st text; action text:='none'; step text; done boolean;
begin
 if new.kind<>'folder' then return new; end if;
 if not exists(select 1 from public.folder_processing where job_id=new.id)
 and not (coalesce(r->>'classification_contract','')='1'
          and case when coalesce(r->>'direct_image_count','0') ~ '^[0-9]+$'
              then (r->>'direct_image_count')::numeric>0 else false end) then return new; end if;
 if new.status in ('queued_scan','scanning') then return new; end if;
 done:=coalesce(r#>>'{output_manifest,verified}','false')='true'
   and r#>>'{output_manifest,job_id}'=new.id::text
   and r#>>'{output_manifest,source_id}'=new.source_drive_folder_id
   and r#>>'{source_completion,state}'='renamed'
   and r#>>'{source_completion,source_id}'=new.source_drive_folder_id
   and left(coalesce(r#>>'{source_completion,name_after}',''),2)='X_'
   and coalesce(r#>>'{source_completion,name_after}','')=coalesce(r#>>'{source_completion,target_name}','')
   and r#>>'{source_completion,verified_at}' is not null;
 st:=case
  when new.status='completed' then case when done then 'completed' else 'needs_review' end
  when new.status='failed' and (r->>'classification'='needs_review'
    or coalesce(new.error_json->>'code','') in ('BR18_AMBIGUOUS_OR_FAILED_BRANCH','BR18_SCAN_INCOMPLETE')) then 'needs_review'
  when new.status='skipped' and r->>'skip_reason'='source_already_prefixed' then 'needs_review'
  when new.status in ('ready','processing','failed','skipped','canceled') then new.status
  else 'needs_review' end;
 step:=case when st='completed' then 'source_rename_confirmed'
  when r#>>'{output_manifest,verified}'='true' then 'manifest_verified'
  when r#>>'{collage_checkpoint,anchor,job_id}'=new.id::text then 'anchor_checkpoint'
  when r ? 'media_assets' then 'media_checkpoint'
  else 'source_classified' end;
 if st='needs_review' then action:='manual_review';
 elsif st='failed' then
  action:=case when r#>>'{output_manifest,verified}'='true' then 'recovery_existing_assets'
    when r#>>'{collage_checkpoint,anchor,job_id}'=new.id::text
      and nullif(r#>>'{collage_checkpoint,anchor,public_url}','') is not null then 'resume_anchor_checkpoint'
    when r ? 'media_assets' then 'recovery_existing_assets' else 'restart_generation_requires_approval' end;
 end if;
 insert into public.folder_processing (
 job_id,batch_id,source_drive_folder_id,root_drive_folder_id,source_path,source_name,depth,status,attempt,
 worker_execution_id,error_json,checkpoint,output_manifest,source_completion,retry_action,last_step,
 started_at,completed_at,job_created_at,updated_at)
 values(new.id,new.batch_id,new.source_drive_folder_id,new.root_drive_folder_id,new.source_path,
 coalesce(new.input_json->>'original_source_name',r->>'source_name'),new.depth,st,new.attempt,
 new.worker_execution_id,new.error_json,r,r->'output_manifest',r->'source_completion',action,step,
 new.started_at,case when st='completed' then new.finished_at else null end,new.created_at,clock_timestamp())
 on conflict(job_id) do update set
 status=excluded.status,attempt=excluded.attempt,worker_execution_id=excluded.worker_execution_id,
 error_json=excluded.error_json,checkpoint=excluded.checkpoint,output_manifest=excluded.output_manifest,
 source_completion=excluded.source_completion,retry_action=excluded.retry_action,last_step=excluded.last_step,
 source_path=excluded.source_path,source_name=coalesce(excluded.source_name,folder_processing.source_name),
 started_at=excluded.started_at,completed_at=excluded.completed_at,updated_at=excluded.updated_at;
 return new;
end $_$;


ALTER FUNCTION "public"."sync_folder_processing"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_folder_retry_metadata"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
begin
 if new.kind='folder' then
 update public.folder_processing set retry_count=new.retry_count,last_retry_status=new.last_retry_status,last_retry_at=new.last_retry_at,last_retry_error=new.last_retry_error,completed_via=new.completed_via,last_retry_request_id=new.last_retry_request_id,last_retry_execution_id=new.last_retry_execution_id,retry_mode=new.retry_mode where job_id=new.id;
 end if;return new;
end $$;


ALTER FUNCTION "public"."sync_folder_retry_metadata"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."sync_retry_batch_state"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
declare active boolean;bad boolean;
begin
 if new.kind<>'folder' or new.retry_count=0 then return new;end if;
 select exists(select 1 from public.n8n_run j where j.batch_id=new.batch_id and j.kind='folder' and (j.status in ('processing','ready','queued_scan','scanning') or j.last_retry_status in ('queued','processing'))),exists(select 1 from public.n8n_run j where j.batch_id=new.batch_id and j.kind='folder' and j.status in ('failed','canceled')) into active,bad;
 update public.n8n_run set status=case when active then 'processing' when bad then 'partial_failed' else 'completed' end,finished_at=case when active then null else clock_timestamp() end,updated_at=clock_timestamp() where id=new.batch_id and kind='batch';
 return new;
end $$;


ALTER FUNCTION "public"."sync_retry_batch_state"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_output_config"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin new.updated_at := pg_catalog.clock_timestamp(); return new; end
$$;


ALTER FUNCTION "public"."touch_output_config"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."track_folder_retry_terminal"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
 if new.kind='folder' and new.retry_count>0 and new.last_retry_status in ('queued','processing') then
  if new.status in ('failed','canceled','skipped') and new.last_retry_status='processing' then
   new.last_retry_status:='failed'; new.last_retry_error:=coalesce(new.error_json,jsonb_build_object('code','RETRY_DID_NOT_COMPLETE','status',new.status));
  elsif new.status='completed' and new.last_retry_status='processing' then
   if new.result_json#>>'{output_manifest,verified}'='true' and new.result_json#>>'{source_completion,state}'='renamed' then
    new.last_retry_status:='completed';new.last_retry_error:=null;new.completed_via:='retry';
   else new.last_retry_status:='failed';new.last_retry_error:=jsonb_build_object('code','RETRY_COMPLETION_UNVERIFIED'); end if;
  end if;
 end if;return new;
end $$;


ALTER FUNCTION "public"."track_folder_retry_terminal"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."verify_storage_purge_token"("p_token" "text") RETURNS boolean
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'storage_purge_token' and decrypted_secret = p_token
  );
$$;


ALTER FUNCTION "public"."verify_storage_purge_token"("p_token" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."baartwork_master_prompts" (
    "id" bigint NOT NULL,
    "is_active" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "prompt_version" integer DEFAULT 1 NOT NULL,
    "prompt_key" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "stage" "text" NOT NULL,
    "content" "text" NOT NULL,
    "notes" "text",
    CONSTRAINT "baartwork_master_prompts_prompt_version_check" CHECK (("prompt_version" > 0))
);


ALTER TABLE "public"."baartwork_master_prompts" OWNER TO "postgres";


ALTER TABLE "public"."baartwork_master_prompts" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME "public"."baartwork_master_prompts_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);



CREATE TABLE IF NOT EXISTS "public"."baartwork_segformer_profiles" (
    "product_type" "text" NOT NULL,
    "category_name" "text" NOT NULL,
    "profile_name" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "mask_mode" "text" NOT NULL,
    "validation_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "face" boolean DEFAULT false NOT NULL,
    "hair" boolean DEFAULT false NOT NULL,
    "hat" boolean DEFAULT false NOT NULL,
    "sunglass" boolean DEFAULT false NOT NULL,
    "left_arm" boolean DEFAULT false NOT NULL,
    "right_arm" boolean DEFAULT false NOT NULL,
    "left_leg" boolean DEFAULT false NOT NULL,
    "right_leg" boolean DEFAULT false NOT NULL,
    "upper_clothes" boolean DEFAULT false NOT NULL,
    "skirt" boolean DEFAULT false NOT NULL,
    "pants" boolean DEFAULT false NOT NULL,
    "dress" boolean DEFAULT false NOT NULL,
    "belt" boolean DEFAULT false NOT NULL,
    "shoe" boolean DEFAULT false NOT NULL,
    "bag" boolean DEFAULT false NOT NULL,
    "scarf" boolean DEFAULT false NOT NULL,
    "detail_method" "text" DEFAULT 'VITMatte'::"text" NOT NULL,
    "detail_erode" integer DEFAULT 12 NOT NULL,
    "detail_dilate" integer DEFAULT 6 NOT NULL,
    "black_point" numeric DEFAULT 0.15 NOT NULL,
    "white_point" numeric DEFAULT 0.99 NOT NULL,
    "process_detail" boolean DEFAULT true NOT NULL,
    "device" "text" DEFAULT 'cuda'::"text" NOT NULL,
    "max_megapixels" numeric DEFAULT 2.0 NOT NULL,
    "profile_version" integer DEFAULT 1 NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "baartwork_segformer_profiles_black_point_check" CHECK ((("black_point" >= 0.01) AND ("black_point" <= 0.98))),
    CONSTRAINT "baartwork_segformer_profiles_check" CHECK (((("white_point" >= 0.02) AND ("white_point" <= 0.99)) AND ("white_point" > "black_point"))),
    CONSTRAINT "baartwork_segformer_profiles_check1" CHECK (((("mask_mode" = 'masked'::"text") AND ("face" OR "hair" OR "hat" OR "sunglass" OR "left_arm" OR "right_arm" OR "left_leg" OR "right_leg" OR "upper_clothes" OR "skirt" OR "pants" OR "dress" OR "belt" OR "shoe" OR "bag" OR "scarf")) OR (("mask_mode" = 'raw'::"text") AND (NOT ("face" OR "hair" OR "hat" OR "sunglass" OR "left_arm" OR "right_arm" OR "left_leg" OR "right_leg" OR "upper_clothes" OR "skirt" OR "pants" OR "dress" OR "belt" OR "shoe" OR "bag" OR "scarf"))))),
    CONSTRAINT "baartwork_segformer_profiles_detail_dilate_check" CHECK ((("detail_dilate" >= 1) AND ("detail_dilate" <= 255))),
    CONSTRAINT "baartwork_segformer_profiles_detail_erode_check" CHECK ((("detail_erode" >= 1) AND ("detail_erode" <= 255))),
    CONSTRAINT "baartwork_segformer_profiles_detail_method_check" CHECK (("detail_method" = ANY (ARRAY['VITMatte'::"text", 'VITMatte(local)'::"text", 'vitmatte-base-composition-1k'::"text", 'PyMatting'::"text", 'GuidedFilter'::"text"]))),
    CONSTRAINT "baartwork_segformer_profiles_device_check" CHECK (("device" = ANY (ARRAY['cuda'::"text", 'cpu'::"text"]))),
    CONSTRAINT "baartwork_segformer_profiles_mask_mode_check" CHECK (("mask_mode" = ANY (ARRAY['masked'::"text", 'raw'::"text"]))),
    CONSTRAINT "baartwork_segformer_profiles_max_megapixels_check" CHECK ((("max_megapixels" >= (1)::numeric) AND ("max_megapixels" <= (999)::numeric))),
    CONSTRAINT "baartwork_segformer_profiles_product_type_check" CHECK (("product_type" ~ '^[a-z][a-z0-9_]*$'::"text")),
    CONSTRAINT "baartwork_segformer_profiles_profile_version_check" CHECK (("profile_version" > 0)),
    CONSTRAINT "baartwork_segformer_profiles_validation_status_check" CHECK (("validation_status" = ANY (ARRAY['pending'::"text", 'sample_accepted'::"text"])))
);


ALTER TABLE "public"."baartwork_segformer_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."drive_connections" (
    "id" "uuid" DEFAULT "extensions"."gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "connection_type" "text" NOT NULL,
    "root_folder_id" "text" NOT NULL,
    "drive_id" "text",
    "status" "text" DEFAULT 'ACTIVE'::"text" NOT NULL,
    "last_sync_at" timestamp with time zone,
    "created_by" "uuid" DEFAULT "auth"."uid"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "drive_connections_connection_type_check" CHECK (("connection_type" = ANY (ARRAY['MY_DRIVE'::"text", 'SHARED_DRIVE'::"text"]))),
    CONSTRAINT "drive_connections_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'INACTIVE'::"text", 'ERROR'::"text"])))
);


ALTER TABLE "public"."drive_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."drive_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "connection_id" "uuid" NOT NULL,
    "drive_item_id" "text" NOT NULL,
    "parent_drive_item_id" "text",
    "name" "text" NOT NULL,
    "mime_type" "text",
    "item_type" "text" DEFAULT 'OTHER'::"text" NOT NULL,
    "size_bytes" bigint,
    "thumbnail_url" "text",
    "web_view_link" "text",
    "modified_time" timestamp with time zone,
    "sync_status" "text" DEFAULT 'SYNCED'::"text" NOT NULL,
    "cached_storage_path" "text",
    "cached_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone
);


ALTER TABLE "public"."drive_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."final_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "drive_item_id" "text" NOT NULL,
    "parent_drive_item_id" "text",
    "name" "text" NOT NULL,
    "mime_type" "text",
    "item_type" "text" DEFAULT 'OTHER'::"text" NOT NULL,
    "size_bytes" bigint,
    "thumbnail_url" "text",
    "web_view_link" "text",
    "modified_time" timestamp with time zone,
    "source_folder_id" "text" NOT NULL,
    "raw_payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."final_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."folder_processing" (
    "job_id" "uuid" NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "source_drive_folder_id" "text" NOT NULL,
    "root_drive_folder_id" "text",
    "source_path" "text",
    "source_name" "text",
    "depth" integer NOT NULL,
    "status" "text" NOT NULL,
    "attempt" integer DEFAULT 0 NOT NULL,
    "worker_execution_id" "text",
    "error_json" "jsonb",
    "checkpoint" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "output_manifest" "jsonb",
    "source_completion" "jsonb",
    "retry_action" "text" NOT NULL,
    "last_step" "text" NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "job_created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "clock_timestamp"() NOT NULL,
    "retry_count" integer DEFAULT 0 NOT NULL,
    "last_retry_status" "text",
    "last_retry_at" timestamp with time zone,
    "last_retry_error" "jsonb",
    "completed_via" "text" DEFAULT 'initial'::"text" NOT NULL,
    "last_retry_request_id" "uuid",
    "last_retry_execution_id" "text",
    "retry_mode" "text",
    CONSTRAINT "folder_processing_retry_action_check" CHECK (("retry_action" = ANY (ARRAY['none'::"text", 'recovery_existing_assets'::"text", 'resume_anchor_checkpoint'::"text", 'restart_generation_requires_approval'::"text", 'manual_review'::"text"]))),
    CONSTRAINT "folder_processing_status_check" CHECK (("status" = ANY (ARRAY['ready'::"text", 'processing'::"text", 'completed'::"text", 'failed'::"text", 'needs_review'::"text", 'skipped'::"text", 'canceled'::"text"])))
);


ALTER TABLE "public"."folder_processing" OWNER TO "postgres";


COMMENT ON TABLE "public"."folder_processing" IS 'SKU folder status projection of n8n_run; completed requires verified output and confirmed X_ rename. No historical backfill.';



CREATE OR REPLACE VIEW "public"."folder_processing_latest" WITH ("security_invoker"='true') AS
 SELECT DISTINCT ON ("source_drive_folder_id") "job_id",
    "batch_id",
    "source_drive_folder_id",
    "root_drive_folder_id",
    "source_path",
    "source_name",
    "depth",
    "status",
    "attempt",
    "worker_execution_id",
    "error_json",
    "checkpoint",
    "output_manifest",
    "source_completion",
    "retry_action",
    "last_step",
    "started_at",
    "completed_at",
    "job_created_at",
    "updated_at",
    "retry_count",
    "last_retry_status",
    "last_retry_at",
    "last_retry_error",
    "completed_via",
    "last_retry_request_id",
    "last_retry_execution_id",
    "retry_mode"
   FROM "public"."folder_processing"
  ORDER BY "source_drive_folder_id", "last_retry_at" DESC NULLS LAST, ("status" = 'completed'::"text") DESC, "job_created_at" DESC, "job_id" DESC;


ALTER VIEW "public"."folder_processing_latest" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."n8n_run" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "batch_id" "uuid",
    "kind" "text" NOT NULL,
    "status" "text" NOT NULL,
    "root_drive_folder_id" "text",
    "source_drive_folder_id" "text",
    "source_path" "text",
    "depth" integer DEFAULT 0 NOT NULL,
    "parent_drive_folder_id" "text",
    "input_json" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "prompt_snapshot" "jsonb",
    "result_json" "jsonb",
    "error_json" "jsonb",
    "n8n_execution_id" "text",
    "worker_execution_id" "text",
    "attempt" integer DEFAULT 0 NOT NULL,
    "started_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "retry_count" integer DEFAULT 0 NOT NULL,
    "last_retry_status" "text",
    "last_retry_at" timestamp with time zone,
    "last_retry_error" "jsonb",
    "completed_via" "text" DEFAULT 'initial'::"text" NOT NULL,
    "last_retry_request_id" "uuid",
    "last_retry_execution_id" "text",
    "retry_request_ids" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "retry_mode" "text",
    "retry_previous_result" "jsonb",
    CONSTRAINT "n8n_run_attempt_check" CHECK (("attempt" >= 0)),
    CONSTRAINT "n8n_run_completed_via_check" CHECK (("completed_via" = ANY (ARRAY['initial'::"text", 'retry'::"text"]))),
    CONSTRAINT "n8n_run_depth_check" CHECK (("depth" >= 0)),
    CONSTRAINT "n8n_run_kind_check" CHECK (("kind" = ANY (ARRAY['batch'::"text", 'folder'::"text"]))),
    CONSTRAINT "n8n_run_kind_shape" CHECK (((("kind" = 'batch'::"text") AND ("batch_id" IS NULL)) OR (("kind" = 'folder'::"text") AND ("batch_id" IS NOT NULL) AND ("source_drive_folder_id" IS NOT NULL)))),
    CONSTRAINT "n8n_run_last_retry_status_check" CHECK (("last_retry_status" = ANY (ARRAY['queued'::"text", 'processing'::"text", 'completed'::"text", 'failed'::"text"]))),
    CONSTRAINT "n8n_run_retry_count_check" CHECK (("retry_count" >= 0)),
    CONSTRAINT "n8n_run_retry_mode_check" CHECK (("retry_mode" = ANY (ARRAY['finalize'::"text", 'regenerate'::"text"]))),
    CONSTRAINT "n8n_run_status_check" CHECK (("status" = ANY (ARRAY['queued_scan'::"text", 'scanning'::"text", 'ready'::"text", 'processing'::"text", 'completed'::"text", 'skipped'::"text", 'failed'::"text", 'partial_failed'::"text", 'canceled'::"text"])))
);


ALTER TABLE "public"."n8n_run" OWNER TO "postgres";


COMMENT ON TABLE "public"."n8n_run" IS 'BAArtwork recursive batch and per-folder execution state. Written only by the n8n service-role credential.';



CREATE OR REPLACE VIEW "public"."folder_retry_candidates" WITH ("security_invoker"='true') AS
 SELECT "job_id",
    "batch_id",
    "source_drive_folder_id",
    "root_drive_folder_id",
    "source_path",
    "source_name",
    "depth",
    "status",
    "attempt",
    "worker_execution_id",
    "error_json",
    "checkpoint",
    "output_manifest",
    "source_completion",
    "retry_action",
    "last_step",
    "started_at",
    "completed_at",
    "job_created_at",
    "updated_at",
    "retry_count",
    "last_retry_status",
    "last_retry_at",
    "last_retry_error",
    "completed_via",
    "last_retry_request_id",
    "last_retry_execution_id",
    "retry_mode"
   FROM "public"."folder_processing_latest" "p"
  WHERE (("status" = ANY (ARRAY['failed'::"text", 'needs_review'::"text"])) AND (COALESCE("last_retry_status", ''::"text") <> ALL (ARRAY['queued'::"text", 'processing'::"text"])) AND (NOT (EXISTS ( SELECT 1
           FROM "public"."n8n_run" "j"
          WHERE (("j"."kind" = 'folder'::"text") AND ("j"."source_drive_folder_id" = "p"."source_drive_folder_id") AND ("j"."status" = 'processing'::"text"))))));


ALTER VIEW "public"."folder_retry_candidates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."model_references" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "drive_file_id" "text" NOT NULL,
    "folder_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "mime_type" "text",
    "item_type" "text" DEFAULT 'IMAGE'::"text" NOT NULL,
    "size_bytes" bigint,
    "thumbnail_url" "text",
    "web_view_link" "text",
    "public_url" "text",
    "is_public" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "modified_time" timestamp with time zone,
    "shared_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "model_references_item_type_check" CHECK (("item_type" = ANY (ARRAY['FOLDER'::"text", 'IMAGE'::"text", 'OTHER'::"text"])))
);


ALTER TABLE "public"."model_references" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."output_config" (
    "id" smallint DEFAULT 1 NOT NULL,
    "folder_id" "text" NOT NULL,
    "folder_name" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "output_config_folder_id_check" CHECK (("folder_id" ~ '^[A-Za-z0-9_-]{10,}$'::"text")),
    CONSTRAINT "output_config_folder_name_check" CHECK (("length"("btrim"("folder_name")) > 0)),
    CONSTRAINT "output_config_id_check" CHECK (("id" = 1))
);


ALTER TABLE "public"."output_config" OWNER TO "postgres";


COMMENT ON TABLE "public"."output_config" IS 'Singleton output destination for new media jobs. Jobs snapshot this configuration; recovery preserves the saved destination.';



ALTER TABLE ONLY "public"."baartwork_master_prompts"
    ADD CONSTRAINT "baartwork_master_prompts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."baartwork_segformer_profiles"
    ADD CONSTRAINT "baartwork_segformer_profiles_pkey" PRIMARY KEY ("product_type");



ALTER TABLE ONLY "public"."drive_connections"
    ADD CONSTRAINT "drive_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drive_items"
    ADD CONSTRAINT "drive_items_connection_id_drive_item_id_key" UNIQUE ("connection_id", "drive_item_id");



ALTER TABLE ONLY "public"."drive_items"
    ADD CONSTRAINT "drive_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."final_items"
    ADD CONSTRAINT "final_items_drive_item_id_key" UNIQUE ("drive_item_id");



ALTER TABLE ONLY "public"."final_items"
    ADD CONSTRAINT "final_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."folder_processing"
    ADD CONSTRAINT "folder_processing_pkey" PRIMARY KEY ("job_id");



ALTER TABLE ONLY "public"."model_references"
    ADD CONSTRAINT "model_references_drive_file_id_key" UNIQUE ("drive_file_id");



ALTER TABLE ONLY "public"."model_references"
    ADD CONSTRAINT "model_references_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."n8n_run"
    ADD CONSTRAINT "n8n_run_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."output_config"
    ADD CONSTRAINT "output_config_pkey" PRIMARY KEY ("id");



CREATE UNIQUE INDEX "baartwork_one_active_prompt_role" ON "public"."baartwork_master_prompts" USING "btree" ("prompt_key") WHERE "is_active";



CREATE INDEX "drive_connections_created_by_idx" ON "public"."drive_connections" USING "btree" ("created_by");



CREATE INDEX "drive_items_connection_parent_deleted_idx" ON "public"."drive_items" USING "btree" ("connection_id", "parent_drive_item_id", "deleted_at");



CREATE INDEX "drive_items_list_idx" ON "public"."drive_items" USING "btree" ("connection_id", "parent_drive_item_id", "item_type", "modified_time" DESC) WHERE ("deleted_at" IS NULL);



CREATE INDEX "drive_items_sync_status_deleted_idx" ON "public"."drive_items" USING "btree" ("sync_status", "deleted_at");



CREATE INDEX "final_items_parent_type_modified_idx" ON "public"."final_items" USING "btree" ("parent_drive_item_id", "item_type", "modified_time" DESC);



CREATE INDEX "final_items_source_modified_idx" ON "public"."final_items" USING "btree" ("source_folder_id", "modified_time" DESC);



CREATE INDEX "folder_processing_batch_status" ON "public"."folder_processing" USING "btree" ("batch_id", "status");



CREATE INDEX "folder_processing_source_history" ON "public"."folder_processing" USING "btree" ("source_drive_folder_id", "job_created_at" DESC, "job_id");



CREATE INDEX "model_references_folder_idx" ON "public"."model_references" USING "btree" ("folder_id") WHERE "is_active";



CREATE INDEX "n8n_run_active_workers_idx" ON "public"."n8n_run" USING "btree" ("updated_at") WHERE (("kind" = 'folder'::"text") AND ("status" = 'processing'::"text"));



CREATE INDEX "n8n_run_next_media_idx" ON "public"."n8n_run" USING "btree" ("batch_id", "depth", "source_path") WHERE (("kind" = 'folder'::"text") AND ("status" = 'ready'::"text"));



CREATE INDEX "n8n_run_next_scan_idx" ON "public"."n8n_run" USING "btree" ("batch_id", "depth", "source_path") WHERE (("kind" = 'folder'::"text") AND ("status" = 'queued_scan'::"text"));



CREATE UNIQUE INDEX "n8n_run_one_folder_per_batch" ON "public"."n8n_run" USING "btree" ("batch_id", "source_drive_folder_id") WHERE ("kind" = 'folder'::"text");



CREATE INDEX "n8n_run_queued_retries" ON "public"."n8n_run" USING "btree" ("last_retry_at", "id") WHERE (("kind" = 'folder'::"text") AND ("last_retry_status" = 'queued'::"text"));



CREATE OR REPLACE TRIGGER "baartwork_prompt_revision" BEFORE UPDATE ON "public"."baartwork_master_prompts" FOR EACH ROW EXECUTE FUNCTION "public"."baartwork_prompt_revision"();



CREATE OR REPLACE TRIGGER "baartwork_segformer_profile_revision" BEFORE UPDATE ON "public"."baartwork_segformer_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."baartwork_segformer_profile_revision"();



CREATE OR REPLACE TRIGGER "drive_connections_set_updated_at" BEFORE UPDATE ON "public"."drive_connections" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "drive_items_set_updated_at" BEFORE UPDATE ON "public"."drive_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "final_items_set_updated_at" BEFORE UPDATE ON "public"."final_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "model_references_set_updated_at" BEFORE UPDATE ON "public"."model_references" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "output_config_updated_at" BEFORE UPDATE ON "public"."output_config" FOR EACH ROW EXECUTE FUNCTION "public"."touch_output_config"();



CREATE OR REPLACE TRIGGER "sync_folder_processing_status" AFTER INSERT OR UPDATE OF "status", "result_json", "error_json", "attempt", "worker_execution_id" ON "public"."n8n_run" FOR EACH ROW EXECUTE FUNCTION "public"."sync_folder_processing"();



CREATE OR REPLACE TRIGGER "track_retry_terminal" BEFORE UPDATE ON "public"."n8n_run" FOR EACH ROW EXECUTE FUNCTION "public"."track_folder_retry_terminal"();



CREATE OR REPLACE TRIGGER "zz_sync_retry_metadata" AFTER INSERT OR UPDATE ON "public"."n8n_run" FOR EACH ROW EXECUTE FUNCTION "public"."sync_folder_retry_metadata"();



CREATE OR REPLACE TRIGGER "zzz_sync_retry_batch" AFTER UPDATE ON "public"."n8n_run" FOR EACH ROW WHEN ((("new"."kind" = 'folder'::"text") AND ("new"."retry_count" > 0))) EXECUTE FUNCTION "public"."sync_retry_batch_state"();



ALTER TABLE ONLY "public"."drive_connections"
    ADD CONSTRAINT "drive_connections_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drive_items"
    ADD CONSTRAINT "drive_items_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."drive_connections"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."folder_processing"
    ADD CONSTRAINT "folder_processing_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."n8n_run"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."folder_processing"
    ADD CONSTRAINT "folder_processing_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."n8n_run"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."n8n_run"
    ADD CONSTRAINT "n8n_run_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."n8n_run"("id") ON DELETE RESTRICT;



CREATE POLICY "Authenticated users can read model references" ON "public"."model_references" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can read segformer profiles" ON "public"."baartwork_segformer_profiles" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can select drive_connections" ON "public"."drive_connections" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can select drive_items" ON "public"."drive_items" FOR SELECT TO "authenticated" USING (true);



CREATE POLICY "Authenticated users can select final_items" ON "public"."final_items" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."baartwork_master_prompts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."baartwork_segformer_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."drive_connections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drive_connections_insert_own" ON "public"."drive_connections" FOR INSERT TO "authenticated" WITH CHECK ((( SELECT "auth"."uid"() AS "uid") = "created_by"));



CREATE POLICY "drive_connections_select_own" ON "public"."drive_connections" FOR SELECT TO "authenticated" USING ((( SELECT "auth"."uid"() AS "uid") = "created_by"));



ALTER TABLE "public"."drive_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."final_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."folder_processing" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."model_references" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."n8n_run" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."output_config" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."drive_items";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."final_items";









GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";











































































































































































GRANT ALL ON FUNCTION "public"."baartwork_prompt_revision"() TO "anon";
GRANT ALL ON FUNCTION "public"."baartwork_prompt_revision"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."baartwork_prompt_revision"() TO "service_role";



GRANT ALL ON FUNCTION "public"."baartwork_segformer_profile_revision"() TO "anon";
GRANT ALL ON FUNCTION "public"."baartwork_segformer_profile_revision"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."baartwork_segformer_profile_revision"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_baartwork_exact_folder"("p_batch_id" "uuid", "p_job_id" "uuid", "p_execution_id" "text", "p_global_worker_limit" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_baartwork_exact_folder"("p_batch_id" "uuid", "p_job_id" "uuid", "p_execution_id" "text", "p_global_worker_limit" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_baartwork_folder_workers"("p_batch_id" "uuid", "p_requested_slots" integer, "p_global_worker_limit" integer, "p_worker_timeout_seconds" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_baartwork_folder_workers"("p_batch_id" "uuid", "p_requested_slots" integer, "p_global_worker_limit" integer, "p_worker_timeout_seconds" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."claim_folder_retry"("p_job_id" "uuid", "p_request_id" "uuid", "p_execution_id" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."claim_folder_retry"("p_job_id" "uuid", "p_request_id" "uuid", "p_execution_id" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."fail_baartwork_exact_folder"("p_batch_id" "uuid", "p_job_id" "uuid", "p_execution_id" "text", "p_error" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."fail_baartwork_exact_folder"("p_batch_id" "uuid", "p_job_id" "uuid", "p_execution_id" "text", "p_error" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."finish_folder_retry"("p_job_id" "uuid", "p_request_id" "uuid", "p_error" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."finish_folder_retry"("p_job_id" "uuid", "p_request_id" "uuid", "p_error" "jsonb") TO "service_role";



REVOKE ALL ON FUNCTION "public"."n8n_endpoint_events_set_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."n8n_endpoint_events_set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."queue_folder_retries"("p_request_id" "uuid", "p_job_ids" "uuid"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."queue_folder_retries"("p_request_id" "uuid", "p_job_ids" "uuid"[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "anon";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_updated_at"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."start_folder_retry_worker"("p_job_id" "uuid", "p_request_id" "uuid", "p_parent_execution_id" "text", "p_execution_id" "text", "p_mode" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."start_folder_retry_worker"("p_job_id" "uuid", "p_request_id" "uuid", "p_parent_execution_id" "text", "p_execution_id" "text", "p_mode" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_folder_processing"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_folder_processing"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_folder_retry_metadata"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_folder_retry_metadata"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."sync_retry_batch_state"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."sync_retry_batch_state"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."touch_output_config"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."touch_output_config"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."track_folder_retry_terminal"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."track_folder_retry_terminal"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."verify_storage_purge_token"("p_token" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."verify_storage_purge_token"("p_token" "text") TO "service_role";
























GRANT SELECT ON TABLE "public"."baartwork_master_prompts" TO "service_role";



GRANT ALL ON SEQUENCE "public"."baartwork_master_prompts_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."baartwork_master_prompts_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."baartwork_master_prompts_id_seq" TO "service_role";



GRANT SELECT ON TABLE "public"."baartwork_segformer_profiles" TO "service_role";
GRANT SELECT ON TABLE "public"."baartwork_segformer_profiles" TO "authenticated";



GRANT ALL ON TABLE "public"."drive_connections" TO "anon";
GRANT ALL ON TABLE "public"."drive_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."drive_connections" TO "service_role";



GRANT ALL ON TABLE "public"."drive_items" TO "anon";
GRANT ALL ON TABLE "public"."drive_items" TO "authenticated";
GRANT ALL ON TABLE "public"."drive_items" TO "service_role";



GRANT ALL ON TABLE "public"."final_items" TO "anon";
GRANT ALL ON TABLE "public"."final_items" TO "authenticated";
GRANT ALL ON TABLE "public"."final_items" TO "service_role";



GRANT SELECT ON TABLE "public"."folder_processing" TO "service_role";



GRANT SELECT ON TABLE "public"."folder_processing_latest" TO "service_role";



GRANT ALL ON TABLE "public"."n8n_run" TO "service_role";



GRANT SELECT ON TABLE "public"."folder_retry_candidates" TO "service_role";



GRANT ALL ON TABLE "public"."model_references" TO "anon";
GRANT ALL ON TABLE "public"."model_references" TO "authenticated";
GRANT ALL ON TABLE "public"."model_references" TO "service_role";



GRANT SELECT ON TABLE "public"."output_config" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";





































-- ============================================================
-- Part 2: Storage, Vault, pg_cron (not covered by pg_dump)
-- ============================================================

-- Storage buckets
insert into storage.buckets (id, name, public) values
  ('BAartworkShopify', 'BAartworkShopify', true),
  ('drive-thumbnails', 'drive-thumbnails', false),
  ('temp-media',       'temp-media',       false)
on conflict (id) do nothing;

-- Storage policies
drop policy if exists "Authenticated users can list BAartworkShopify" on storage.objects;
create policy "Authenticated users can list BAartworkShopify"
  on storage.objects for select to authenticated
  using (bucket_id = 'BAartworkShopify');

-- Vault token used by the storage-purge-cron Edge Function (random per environment)
select vault.create_secret(
  replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  'storage_purge_token',
  'Shared secret between pg_cron and the storage-purge-cron Edge Function'
)
where not exists (select 1 from vault.secrets where name = 'storage_purge_token');

-- Cron: empty BAartworkShopify daily at 03:00 Vietnam time (20:00 UTC)
select cron.schedule(
  'storage-purge-baartworkshopify-daily',
  '0 20 * * *',
  $cmd$
  select net.http_post(
    url := 'https://svykhovdpaviqgouaafh.supabase.co/functions/v1/storage-purge-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Purge-Token', (select decrypted_secret from vault.decrypted_secrets where name = 'storage_purge_token')
    ),
    body := '{"buckets": ["BAartworkShopify"]}'::jsonb,
    timeout_milliseconds := 120000
  );
  $cmd$
);

-- Cron "drive-sync-folders-every-30m" (*/30 * * * *) calls the drive-sync-cron Edge Function.
-- Its live definition hardcodes a secret key in the header, so it is NOT reproduced here.
-- Store that secret in Vault first, then schedule it the same way as the job above.
