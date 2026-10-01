import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord} from '@teloa/contract'

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const corrupt=()=>new WorkError('teloa/storage-corrupt','交办的任务归属索引损坏，请先核对原请求。')
/** 兼容既有确定子键；迁移与运行时只有这一份算法。 */
export function workRequestChildId(requestId:string,kind:string,roleId=''):string{
 const h=createHash('sha256').update(JSON.stringify(['teloa-conversation-work/v1',requestId,kind,roleId])).digest('hex')
 return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
}
function childIdentity(row:Record<string,unknown>):string|null{
 const spec=row.request_spec
 if(!isRecord(spec)||!uuid(row.request_id)||spec.requestId!==row.request_id)throw corrupt()
 if(spec.kind==='report'){if(row.task_child_request_id!=null)throw corrupt();return null}
 if(spec.kind!=='task'||!uuid(spec.roleId)||!Array.isArray(row.targets)||row.targets.length!==1)throw corrupt()
 const target=row.targets[0]
 if(!isRecord(target)||target.roleId!==spec.roleId||target.scope!==spec.scope||target.roleVersion!==spec.expectedRoleVersion||!Number.isSafeInteger(spec.expectedRoleVersion)||Number(spec.expectedRoleVersion)<1)throw corrupt()
 const child=workRequestChildId(row.request_id,'task',spec.roleId)
 if(row.task_child_request_id!=null&&row.task_child_request_id!==child)throw corrupt()
 return child
}
/** Tasks 可独立初始化；共享请求表不依赖会话/角色/原生服务，也不另建执行状态。 */
export async function initializeConversationWorkRequests(pool:Pool):Promise<void>{
 const db=await pool.connect()
 try{
  await db.query('begin')
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/conversation-work-request-schema/v1'])
  const ready=(await db.query(`select
   exists(select 1 from pg_attribute where attrelid=to_regclass('teloa_conversation_work_requests') and attname='task_child_request_id' and atttypid='uuid'::regtype and not attisdropped)
   and exists(select 1 from pg_constraint where conrelid=to_regclass('teloa_conversation_work_requests') and conname='teloa_conversation_work_task_child_required' and contype='c' and convalidated)
   and exists(select 1 from pg_index where indexrelid=to_regclass('teloa_conversation_work_task_child') and indrelid=to_regclass('teloa_conversation_work_requests') and indisunique and indisvalid and indisready and indnkeyatts=2 and pg_get_indexdef(indexrelid,1,true)='owner_id' and pg_get_indexdef(indexrelid,2,true)='task_child_request_id')
   and to_regclass('teloa_conversation_work_session') is not null as ready`)).rows[0]?.ready===true
  if(!ready){
  await db.query(`create table if not exists teloa_conversation_work_requests(
   owner_id text not null,request_id uuid not null,session_id text not null,request_spec jsonb not null,
   targets jsonb not null,failures jsonb not null default '{}'::jsonb,stopped_at timestamptz,created_at timestamptz not null,notified_at timestamptz,
   task_child_request_id uuid,primary key(owner_id,request_id)
  );alter table teloa_conversation_work_requests add column if not exists task_child_request_id uuid;`)
  // 迁移原子完成才开放流量；同事务表锁禁止 reserve 插入未核对的新行。分批只限制内存，不提前提交。
  await db.query('lock table teloa_conversation_work_requests in access exclusive mode')
  }
  // 稳定结构仍逐行核同源子键，但只持普通读锁，不阻塞运行中的请求写事务。
  let after:{owner:string;id:string}|undefined
  for(;;){
   const rows=(await db.query('select owner_id,request_id,request_spec,targets,task_child_request_id from teloa_conversation_work_requests where ($1::text is null or (owner_id,request_id)>($1,$2::uuid)) order by owner_id,request_id limit 256',[after?.owner??null,after?.id??null])).rows
   for(const row of rows){const child=childIdentity(row);if(child&&row.task_child_request_id===null){if(ready)throw corrupt();await db.query('update teloa_conversation_work_requests set task_child_request_id=$3 where owner_id=$1 and request_id=$2',[row.owner_id,row.request_id,child])}}
   if(rows.length<256)break
   const last=rows.at(-1)!;after={owner:last.owner_id,id:last.request_id}
  }
  if(!ready){
  await db.query(`do $$ begin
   if not exists(select 1 from pg_constraint where conrelid='teloa_conversation_work_requests'::regclass and conname='teloa_conversation_work_task_child_required') then
    alter table teloa_conversation_work_requests add constraint teloa_conversation_work_task_child_required check (
     (request_spec->>'kind'='task' and task_child_request_id is not null) or (request_spec->>'kind'='report' and task_child_request_id is null)
    );
   end if;
  end $$`)
  await db.query('create unique index if not exists teloa_conversation_work_task_child on teloa_conversation_work_requests(owner_id,task_child_request_id) where task_child_request_id is not null')
  await db.query('create index if not exists teloa_conversation_work_session on teloa_conversation_work_requests(owner_id,session_id,created_at)')
  }
  await db.query('commit')
 }catch(error){await db.query('rollback');if(isRecord(error)&&error.code==='23505')throw corrupt();throw error}finally{db.release()}
}
/** 在父索引可见之前，以确定子身份串行 reserve 和所有 Task 创建；必须先于父 request X。 */
export async function lockConversationTaskChild(db:PoolClient,owner:string,childRequestId:string):Promise<void>{
 // PostgreSQL uuid 比较不区分大小写；锁键必须与持久身份采用同一规范值。
 childRequestId=childRequestId.toLowerCase()
 await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/conversation-task-child',owner,childRequestId])])
}
/** 新父请求不能收养先前独立创建的 Task；已有父回执由调用者先返回。 */
export async function assertConversationTaskChildUnoccupied(db:PoolClient,owner:string,childRequestId:string):Promise<void>{
 // 会话服务可独立初始化；Task 表不存在时不可能已有占用。之后的 Task 创建仍须取得同一子锁。
 if(!(await db.query("select to_regclass('teloa_tasks') as relation")).rows[0]?.relation)return
 if((await db.query('select 1 from teloa_tasks where owner_id=$1 and request_id=$2',[owner,childRequestId])).rowCount)throw new WorkError('teloa/conflict','该任务请求已被独立任务使用，不能绑定为新的交办。')
}
export type ConversationTaskIdentity={sessionId:string;requestId:string;roleId:string}
export type ConversationTaskParent={stopped:boolean;row:Record<string,unknown>}
/** 必须在调用者同一事务、task-create/业务快照/角色行锁之前执行。无父请求的旧普通任务不改变行为。 */
export async function lockConversationTaskParent(db:PoolClient,owner:string,childRequestId:string,identity?:ConversationTaskIdentity):Promise<ConversationTaskParent|null>{
 childRequestId=childRequestId.toLowerCase()
 await lockConversationTaskChild(db,owner,childRequestId)
 const hint=(await db.query('select request_id from teloa_conversation_work_requests where owner_id=$1 and task_child_request_id=$2',[owner,childRequestId])).rows[0]
 if(!hint){if(identity)throw new WorkError('teloa/conflict','原交办任务身份不存在。');return null}
 if(!uuid(hint.request_id))throw corrupt()
 await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/conversation-work',owner,'request:'+hint.request_id])])
 const row=(await db.query('select * from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[owner,hint.request_id])).rows[0]
 if(!row||childIdentity(row)!==childRequestId||row.task_child_request_id!==childRequestId||row.stopped_at!==null&&(!(row.stopped_at instanceof Date)||!Number.isFinite(row.stopped_at.getTime())))throw corrupt()
 if(!identity)throw new WorkError('teloa/conflict','该任务请求属于会话交办，请从原交办核对或恢复。')
 if(row.owner_id!==owner||row.request_id!==identity.requestId||row.session_id!==identity.sessionId||workRequestChildId(identity.requestId,'task',identity.roleId)!==childRequestId)throw new WorkError('teloa/forbidden','原交办的本人、会话或员工身份不一致。')
 return {stopped:row.stopped_at!==null,row}
}
/** 已成功的原回执可以返回；只有会产生新 Task 的分支在这里拒绝。 */
export function assertConversationTaskOpen(parent:ConversationTaskParent|null):void{
 if(parent?.stopped)throw new WorkError('teloa/conflict','原交办已停止，不能再创建任务；请核对原请求。')
}
