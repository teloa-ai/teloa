import type { Pool } from 'pg'
import {initializeMarkdownKnowledge} from './markdown-knowledge.ts'
import {initializeKnowledgeResources} from './knowledge-resources.ts'
import {initializeRetrievalIndex} from './retrieval-index.ts'
export async function initializeResources(pool:Pool):Promise<void>{
  const client=await pool.connect()
  try{
    await client.query('begin')
    await client.query(`
      create table if not exists teloa_resources (
        id uuid primary key, owner_id text not null, revision integer not null check(revision>0),
        status text not null check(status in ('active','withdrawn')), spec jsonb not null check(jsonb_typeof(spec)='object'),
        created_at timestamptz not null, updated_at timestamptz not null
      );
      create table if not exists teloa_resource_drafts (
        id uuid primary key, owner_id text not null, request_id uuid not null,
        request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
        spec jsonb not null check(jsonb_typeof(spec)='object'), revision integer not null check(revision>0),
        status text not null check(status in ('draft','applied')), resource_id uuid references teloa_resources(id),
        applied_version integer, created_at timestamptz not null, updated_at timestamptz not null,
        unique(owner_id,request_id), unique(resource_id),
        check((status='draft' and resource_id is null and applied_version is null) or (status='applied' and resource_id is not null and applied_version is not null and applied_version>0))
      );
      create table if not exists teloa_message_snapshots (
        id uuid primary key, owner_id text not null, session_id text not null, message_id text not null,
        request_id text, scope_ids jsonb not null check(jsonb_typeof(scope_ids)='array'),
        refs jsonb not null check(jsonb_typeof(refs)='array'), created_at timestamptz not null,
        unique(session_id,message_id)
      );
      create table if not exists teloa_resource_reads (
        id uuid primary key, snapshot_id uuid not null references teloa_message_snapshots(id),
        outcome text not null check(outcome in ('provided','failed')),
        result jsonb not null check(jsonb_typeof(result)='object'), created_at timestamptz not null
      );
    `)
    await client.query('commit')
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
  await initializeMarkdownKnowledge(pool)
  await initializeKnowledgeResources(pool)
  // 本地检索索引外键指向 teloa_resources，随资料底座一起建。
  await initializeRetrievalIndex(pool)
  await pool.query(`
    create table if not exists teloa_conversation_knowledge_operations(
      owner_id text not null,request_id uuid not null,command_hash text not null check(command_hash ~ '^[a-f0-9]{64}$'),command_spec jsonb not null check(jsonb_typeof(command_spec)='object'),
      stage text not null check(stage in ('prepared','knowledge-saved','resource-applying','active','failed')),
      knowledge_id uuid,knowledge_version integer,content_hash text,resource_draft_id uuid,resource_id uuid,receipt jsonb,error jsonb,
      failed_stage text check(failed_stage is null or failed_stage in ('prepared','knowledge-saved','resource-applying')),
      created_at timestamptz not null,updated_at timestamptz not null,primary key(owner_id,request_id),
      check((knowledge_id is null and knowledge_version is null and content_hash is null) or (knowledge_id is not null and knowledge_version>0 and content_hash ~ '^[a-f0-9]{64}$')),
      check((stage<>'active') or (knowledge_id is not null and resource_id is not null and receipt is not null)),
      check((stage<>'failed') or error is not null),
      constraint teloa_conversation_knowledge_receipt_error_exclusive check(receipt is null or error is null)
    );
  `)
  await pool.query(`alter table teloa_conversation_knowledge_operations add column if not exists failed_stage text`)
  await pool.query(`update teloa_conversation_knowledge_operations set error=null,failed_stage=null where stage='active' and receipt is not null; update teloa_conversation_knowledge_operations set receipt=null where stage='failed' and error is not null;`)
  await pool.query(`do $$ begin if not exists(select 1 from pg_constraint where conrelid='teloa_conversation_knowledge_operations'::regclass and conname='teloa_conversation_knowledge_receipt_error_exclusive') then alter table teloa_conversation_knowledge_operations add constraint teloa_conversation_knowledge_receipt_error_exclusive check(receipt is null or error is null); end if; end $$;`)
}
