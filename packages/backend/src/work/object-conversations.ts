import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput} from '@teloa/contract'
import {readStoredTask} from './tasks.ts'
import {readStoredRole} from './roles.ts'
import {workAccess} from './work-access.ts'
type Kind='task'|'role'
export type ObjectConversation={kind:Kind;objectId:string;objectVersion:number;conversationId:string;sessionId:string;version:number;active:boolean;updatedAt:string;scopeId:string|null}
type Inspect=(owner:string,sessionId:string)=>Promise<{id:string;sessionId:string;ownerId:string;status:string}>
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const session=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v)
const positive=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>0
export async function initializeObjectConversations(pool:Pool){await pool.query(`
 create table if not exists teloa_object_conversations(
 owner_id text not null,kind text not null check(kind in ('task','role')),object_id uuid not null,
 object_version integer not null check(object_version>0),conversation_id text not null,session_id text not null,
 version integer not null check(version>0),active boolean not null,updated_at timestamptz not null,scope_id text,
 primary key(owner_id,kind,object_id,session_id)
 );
 alter table teloa_object_conversations add column if not exists scope_id text;
 create table if not exists teloa_object_conversation_requests(
 owner_id text not null,request_id uuid not null,request_spec jsonb not null,
 primary key(owner_id,request_id)
 )`)}
function read(row:Record<string,unknown>):ObjectConversation{
 if(!['task','role'].includes(String(row.kind))||!uuid(row.object_id)||!positive(row.object_version)||!session(row.conversation_id)||!session(row.session_id)||!positive(row.version)||typeof row.active!=='boolean'||!(row.updated_at instanceof Date)||!Number.isFinite(row.updated_at.getTime())||(row.scope_id!==null&&row.scope_id!==undefined&&!session(row.scope_id)))throw new WorkError('teloa/storage-corrupt','对象会话关联损坏。')
 return {kind:row.kind as Kind,objectId:row.object_id,objectVersion:row.object_version as number,conversationId:row.conversation_id,sessionId:row.session_id,version:row.version as number,active:row.active,updatedAt:row.updated_at.toISOString(),scopeId:typeof row.scope_id==='string'?row.scope_id:null}
}
function target(owner:string,row:Record<string,unknown>){if(typeof owner!=='string'||!owner.trim()||owner.length>128||!['task','role'].includes(String(row.kind))||!uuid(row.objectId))throw new WorkError('teloa/invalid-input','需要有效的本人及对象身份。')}
async function object(db:Pool|PoolClient,owner:string,kind:unknown,id:unknown,lock=false){
 // 表名来自固定分支，不使用请求中的字符串拼接表名。
 const table=kind==='task'?'teloa_tasks':'teloa_roles',rows=await db.query(`select * from ${table} where owner_id=$1 and id=$2${lock?' for share':''}`,[owner,id])
 if(!rows.rows[0])throw new WorkError('teloa/forbidden','对象不存在或不属于本人。')
 if(kind==='task'){
  const value=readStoredTask(rows.rows[0])
  return {version:value.version,canLink:!['completed','cancelled'].includes(value.state),scopes:[value.scope]}
 }
 const value=readStoredRole(rows.rows[0])
 // 暂停限制的是接新任务；本人仍可创建、关联普通聊天，不因此复岗或获得执行授权。
 return {version:value.version,canLink:value.state==='active'||value.state==='paused',scopes:value.scopes}
}
export class ObjectConversationService{
 readonly pool:Pool;readonly inspect:Inspect;readonly now:()=>string
 constructor(pool:Pool,inspect:Inspect,now:()=>string){this.pool=pool;this.inspect=inspect;this.now=now}
 async taskContext(owner:string,input:unknown){
  const row=taskInput(input,['taskId','sessionId','expectedTaskVersion']);target(owner,{kind:'task',objectId:row.taskId})
  if(!session(row.sessionId)||!positive(row.expectedTaskVersion))throw new WorkError('teloa/invalid-input','任务会话或版本不合法。')
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const tasks=await db.query('select * from teloa_tasks where owner_id=$1 and id=$2',[owner,row.taskId]);if(!tasks.rows[0])throw new WorkError('teloa/forbidden','任务不存在或不属于本人。')
   const task=readStoredTask(tasks.rows[0]);if(task.version!==row.expectedTaskVersion)throw new WorkError('teloa/version-conflict','任务目标或负责人已变化，请刷新任务。')
   if(['completed','cancelled'].includes(task.state))throw new WorkError('teloa/conflict','已结束任务不能准备新的执行上下文。')
   const links=await db.query("select * from teloa_object_conversations where owner_id=$1 and kind='task' and object_id=$2 and session_id=$3",[owner,task.id,row.sessionId]);if(!links.rows[0])throw new WorkError('teloa/forbidden','会话未关联此任务。')
   const link=read(links.rows[0]);if(!link.active)throw new WorkError('teloa/forbidden','任务会话关联已解除。')
   const conversation=await this.inspect(owner,row.sessionId);if(conversation.ownerId!==owner||conversation.status!=='ready'||conversation.id!==link.conversationId||conversation.sessionId!==link.sessionId)throw new WorkError('teloa/forbidden','会话身份或状态不匹配。')
   let role=null
   if(task.assigneeRoleId){const roles=await db.query('select * from teloa_roles where owner_id=$1 and id=$2',[owner,task.assigneeRoleId]);if(!roles.rows[0])throw new WorkError('teloa/storage-corrupt','负责员工缺失。');role=readStoredRole(roles.rows[0]);if(role.state!=='active'||role.kind!=='employee'||!role.scopes.includes(task.scope))throw new WorkError('teloa/conflict','负责员工当前不能接续此任务，请处理员工状态或交接。')}
   await db.query('commit');return {task,role,link}
  }catch(e){await db.query('rollback');throw e}finally{db.release()}
 }
 async list(owner:string,input:unknown):Promise<ObjectConversation[]>{
  const row=taskInput(input,['kind','objectId']);target(owner,row);await object(this.pool,owner,row.kind,row.objectId)
  const rows=await this.pool.query('select * from teloa_object_conversations where owner_id=$1 and kind=$2 and object_id=$3 order by updated_at,session_id',[owner,row.kind,row.objectId]);return rows.rows.map(read)
 }
 async bySession(owner:string,input:unknown):Promise<ObjectConversation[]>{
  const row=taskInput(input,['sessionId'])
  if(typeof owner!=='string'||!owner.trim()||owner.length>128||!session(row.sessionId))throw new WorkError('teloa/invalid-input','需要有效的本人及会话身份。')
  const rows=await this.pool.query("select * from teloa_object_conversations where owner_id=$1 and session_id=$2 and active=true order by case when kind='role' then 0 else 1 end,updated_at desc,object_id",[owner,row.sessionId])
  return rows.rows.map(read)
 }
 async change(owner:string,input:unknown):Promise<ObjectConversation>{
  const row=taskInput(input,['requestId','kind','objectId','expectedObjectVersion','sessionId','expectedLinkVersion','action','scopeId']);target(owner,row)
  if(!uuid(row.requestId)||!session(row.sessionId)||!positive(row.expectedObjectVersion)||!Number.isSafeInteger(row.expectedLinkVersion)||(row.expectedLinkVersion as number)<0||!['link','unlink'].includes(String(row.action))||(row.scopeId!==undefined&&!session(row.scopeId)))throw new WorkError('teloa/invalid-input','关联动作、业务范围或版本不合法。')
  const requestedScope=typeof row.scopeId==='string'?row.scopeId:undefined
  const spec=JSON.stringify({kind:row.kind,objectId:row.objectId,expectedObjectVersion:row.expectedObjectVersion,sessionId:row.sessionId,expectedLinkVersion:row.expectedLinkVersion,action:row.action,...(requestedScope?{scopeId:requestedScope}:{})}),db=await this.pool.connect()
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/conversation-work',owner,'context:'+row.sessionId])])
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['object-conversation-request',owner,row.requestId])])
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['object-conversation',owner,row.kind,row.objectId,row.sessionId])])
   const currentObject=await object(db,owner,row.kind,row.objectId,true)
   const records=await db.query('select * from teloa_object_conversations where owner_id=$1 and kind=$2 and object_id=$3 and session_id=$4 for update',[owner,row.kind,row.objectId,row.sessionId]),current=records.rows[0]?read(records.rows[0]):undefined
   const receipts=await db.query('select request_spec=$3::jsonb as same from teloa_object_conversation_requests where owner_id=$1 and request_id=$2',[owner,row.requestId,spec])
   if(receipts.rows[0]){
    if(!receipts.rows[0].same)throw new WorkError('teloa/conflict','同一请求不能改变关联安排。')
    if(!current||current.version<((row.expectedLinkVersion as number)+1))throw new WorkError('teloa/storage-corrupt','关联回执与记录不一致。')
    await db.query('commit');return current
   }
   if(currentObject.version!==row.expectedObjectVersion||(current?.version??0)!==row.expectedLinkVersion)throw new WorkError('teloa/version-conflict','对象或关联版本已变化，请复核。')
   if(row.action==='link'?!currentObject.canLink||current?.active:!current?.active)throw new WorkError('teloa/conflict','当前状态不能执行此关联操作。')
   if(row.action==='link'&&requestedScope&&!currentObject.scopes.includes(requestedScope))throw new WorkError('teloa/forbidden','员工或任务不支持所选业务范围。')
   const conversation=await this.inspect(owner,row.sessionId)
   if(conversation.ownerId!==owner||conversation.sessionId!==row.sessionId||conversation.status!=='ready'||!session(conversation.id))throw new WorkError('teloa/forbidden','只能关联本人已就绪的工作会话。')
   if(current&&current.conversationId!==conversation.id)throw new WorkError('teloa/storage-corrupt','会话身份与原关联不一致。')
   const scopeId=row.action==='link'?(requestedScope??(currentObject.scopes.length===1?currentObject.scopes[0]!:null)):(current?.scopeId??null)
   const admission=row.action==='link'?await workAccess.authorize({kind:'capability',capability:'people',ownerId:owner,sessionId:row.sessionId as string,objectId:row.objectId as string,operation:'edit'}):undefined
   admission?.assertCurrent()
   const saved=await db.query(`insert into teloa_object_conversations(owner_id,kind,object_id,object_version,conversation_id,session_id,version,active,updated_at,scope_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(owner_id,kind,object_id,session_id) do update set object_version=excluded.object_version,version=excluded.version,active=excluded.active,updated_at=excluded.updated_at,scope_id=excluded.scope_id returning *`,[owner,row.kind,row.objectId,currentObject.version,conversation.id,row.sessionId,(current?.version??0)+1,row.action==='link',this.now(),scopeId])
   await db.query('insert into teloa_object_conversation_requests values($1,$2,$3)',[owner,row.requestId,spec])
   const result=read(saved.rows[0]);admission?.assertCurrent();await db.query('commit');return result
  }catch(e){await db.query('rollback');throw e}finally{db.release()}
 }
}
