import type {Pool} from 'pg'
import {WorkError,type Conversation} from '@teloa/contract'
import {readStoredTask} from './tasks.ts'
import {readStoredRole} from './roles.ts'
import type {TaskRun} from './task-runs.ts'
import type {ObjectConversation} from './object-conversations.ts'
import {readRunBusinessContext} from './task-run-business-context.ts'

type Run=Pick<TaskRun,'id'|'taskId'|'sessionId'|'roleId'|'roleVersion'|'createdAt'|'linkVersion'|'state'|'inputText'>
type Filter={roleId?:string;sessionId?:string}
type SessionReader=(owner:string,sessionId:string,signal?:AbortSignal)=>Promise<{conversation:Conversation;currentRunId:string;run:Run}>
export type RoleRunConversation={conversation:Conversation;link:ObjectConversation}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const session=(value:unknown):value is string=>typeof value==='string'&&/^[-a-zA-Z0-9_]{1,128}$/.test(value)

/** 自动工作的目录只是原预约的只读投影；既不写手工关联，也不产生执行许可。 */
export class RoleRunConversationDirectory{
 readonly pool:Pool;readonly readSession:SessionReader
 constructor(pool:Pool,readSession:SessionReader){this.pool=pool;this.readSession=readSession}
 private async current(owner:string,run:Run){
  if(!owner?.trim()||!uuid(run.roleId))throw new WorkError('teloa/forbidden','员工运行归属不正确。')
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const taskRow=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2',[owner,run.taskId])).rows[0]
   const roleRow=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2',[owner,run.roleId])).rows[0]
   if(!taskRow||!roleRow)throw new WorkError('teloa/forbidden','工作或员工不属于本人。')
   const task=readStoredTask(taskRow),role=readStoredRole(roleRow),fixed=JSON.parse(run.inputText).task
   // 本人历史阅读不重新申请员工执行许可；停岗、换负责人或收窄执行范围不改写旧Run身份。
   if(fixed?.id!==task.id||typeof fixed.scope!=='string')throw new WorkError('teloa/forbidden','原运行不属于该工作。')
   await db.query('commit');return {task,role,scope:fixed.scope}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async list(owner:string,filter:Filter={},signal?:AbortSignal):Promise<RoleRunConversation[]>{
  signal?.throwIfAborted()
  if(!owner?.trim()||owner.length>128||filter.roleId!==undefined&&!uuid(filter.roleId)||filter.sessionId!==undefined&&!session(filter.sessionId))throw new WorkError('teloa/invalid-input','员工会话目录身份不正确。')
  // 每个参与员工的Task只列最新有效会话；明确按旧session读取仍保留该段历史。
  const candidates=await this.pool.query("select distinct on (task_id,role_id) session_id from teloa_task_runs where owner_id=$1 and role_id is not null and state not in ('withdrawn','configuration_failed') and ($2::uuid is null or role_id=$2) and ($3::text is null or session_id=$3) order by task_id,role_id,task_version desc,created_at desc,id desc",[owner,filter.roleId??null,filter.sessionId??null])
  const entries:RoleRunConversation[]=[]
  // 目录只做只读核验；限制并发，避免历史数量线性放大延迟或占满连接池。
  for(let offset=0;offset<candidates.rows.length;offset+=4){
   signal?.throwIfAborted()
   const batch=await Promise.all(candidates.rows.slice(offset,offset+4).map(async({session_id:sessionId})=>{
   try{
    signal?.throwIfAborted()
    const {conversation,run,currentRunId}=await this.readSession(owner,sessionId,signal)
    signal?.throwIfAborted()
    if(['withdrawn','configuration_failed'].includes(run.state))return undefined
    if(conversation.ownerId!==owner||conversation.sessionId!==sessionId||conversation.status!=='ready'||conversation.purpose!=='task-run'||run.sessionId!==sessionId||run.id!==currentRunId||!run.roleId||filter.roleId!==undefined&&run.roleId!==filter.roleId||conversation.run?.taskId!==run.taskId||conversation.run.roleId!==run.roleId||conversation.run.roleVersion!==run.roleVersion)throw new WorkError('teloa/forbidden','原运行目录与规范预约不一致。')
    const {role,scope}=await this.current(owner,run),input=JSON.parse(run.inputText),displayTitle=readRunBusinessContext(input.businessContext===undefined?undefined:Object.fromEntries(Object.entries(input.businessContext).filter(([key])=>key!=='notice')))?.object.title??input.task.title
    signal?.throwIfAborted()
    return {conversation,link:{kind:'role' as const,objectId:role.id,objectVersion:run.roleVersion!,conversationId:conversation.id,sessionId,version:run.linkVersion,active:true,updatedAt:run.createdAt,scopeId:scope,readOnly:true,displayTitle}} satisfies RoleRunConversation
   }catch(error){if(error instanceof WorkError&&['teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(error.code))return undefined;throw error}
   }))
   entries.push(...batch.filter((entry):entry is NonNullable<typeof entry>=>entry!==undefined))
  }
  return entries
 }
}
