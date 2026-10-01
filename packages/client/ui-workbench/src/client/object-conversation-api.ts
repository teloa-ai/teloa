import {taskInput} from '@teloa/contract'
import type {TaskRequestJournal} from './task-api.ts'
import {readSavedTask} from './task-api.ts'
import {readSavedRole} from './role-api.ts'
import {readBusinessDataPage,type BusinessDataItem} from './business-data-api.ts'
import {readBusinessTaskSource,type BusinessTaskSource} from './business-task-api.ts'
import type {ObjectConversationLink} from './object-conversations.ts'
import {recoveryStorageError} from './recovery-error.ts'
export type SavedObjectLink=ObjectConversationLink&{version:number;active:boolean;updatedAt:string}
export type TaskConversationBusinessContext={source:BusinessTaskSource;object:BusinessDataItem}
type Command={kind:'task'|'role';objectId:string;expectedObjectVersion:number;sessionId:string;expectedLinkVersion:number;action:'link'|'unlink';scopeId?:string}
type Request=Command&{requestId:string}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const identity=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v)
function request(value:unknown):Request{
 const r=taskInput(value,['kind','objectId','expectedObjectVersion','sessionId','expectedLinkVersion','action','requestId','scopeId'])
 if(!['task','role'].includes(String(r.kind))||!uuid(r.objectId)||!uuid(r.requestId)||!identity(r.sessionId)||!Number.isSafeInteger(r.expectedObjectVersion)||(r.expectedObjectVersion as number)<1||!Number.isSafeInteger(r.expectedLinkVersion)||(r.expectedLinkVersion as number)<0||!['link','unlink'].includes(String(r.action))||(r.scopeId!==undefined&&!identity(r.scopeId)))throw Error('会话关联请求格式不正确。')
 return {kind:r.kind as Command['kind'],objectId:r.objectId,expectedObjectVersion:r.expectedObjectVersion as number,sessionId:r.sessionId as string,expectedLinkVersion:r.expectedLinkVersion as number,action:r.action as Command['action'],requestId:r.requestId,...(typeof r.scopeId==='string'?{scopeId:r.scopeId}:{})}
}
function read(value:unknown):SavedObjectLink{
 const r=taskInput(value,['kind','objectId','objectVersion','conversationId','sessionId','version','active','updatedAt','scopeId'])
 if(!['task','role'].includes(String(r.kind))||!uuid(r.objectId)||!identity(r.conversationId)||!identity(r.sessionId)||!Number.isSafeInteger(r.objectVersion)||(r.objectVersion as number)<1||!Number.isSafeInteger(r.version)||(r.version as number)<1||typeof r.active!=='boolean'||typeof r.updatedAt!=='string'||!Number.isFinite(Date.parse(r.updatedAt))||(r.scopeId!==undefined&&r.scopeId!==null&&!identity(r.scopeId)))throw Error('会话关联响应格式不正确。')
 return {kind:r.kind as SavedObjectLink['kind'],objectId:r.objectId,objectVersion:r.objectVersion as number,conversationId:r.conversationId as string,sessionId:r.sessionId as string,version:r.version as number,active:r.active,updatedAt:r.updatedAt,...(typeof r.scopeId==='string'?{scopeId:r.scopeId}:{})}
}
export type ObjectConversationApi=ReturnType<typeof createObjectConversationApi>
export function createObjectConversationApi(call:(method:string,payload:unknown)=>Promise<unknown>,journal?:TaskRequestJournal){
 let pending:Request|undefined,error:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{const raw=journal?.read();if(raw){if(raw.length>3000)throw Error();const r=taskInput(JSON.parse(raw),['schema','request']);if(r.schema!=='teloa.object-conversation/v1')throw Error();pending=request(r.request)}}catch{error=recoveryStorageError()}
 const send=async()=>{
  if(error)throw error;if(busy)throw Error('会话关联正在核对。');if(!pending)throw Error('没有待核对的会话关联。');busy=true
  try{journal?.write(JSON.stringify({schema:'teloa.object-conversation/v1',request:pending}));const row=read(await call('object-conversations/change',pending))
   if(row.kind!==pending.kind||row.objectId!==pending.objectId||row.sessionId!==pending.sessionId||row.version<pending.expectedLinkVersion+1||row.version===pending.expectedLinkVersion+1&&(row.active!==(pending.action==='link')||row.objectVersion!==pending.expectedObjectVersion||pending.action==='link'&&pending.scopeId!==undefined&&row.scopeId!==pending.scopeId))throw Error('会话关联响应与原请求不一致。')
   journal?.clear();pending=undefined;return row
  }catch(e){if(e&&typeof e==='object'&&'rejected' in e&&e.rejected===true&&'code' in e&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String(e.code))){journal?.clear();pending=undefined}throw e}finally{busy=false}
 }
 return {pending:()=>pending?{...pending}:undefined,recoveryMessage:()=>error,
  /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discard(){const had=pending!==undefined||error!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;error=undefined;return had},
  recover:send,
  async taskContext(taskId:string,sessionId:string,expectedTaskVersion:number){
   const value=taskInput(await call('tasks/context',{taskId,sessionId,expectedTaskVersion}),['task','role','link','business']),task=readSavedTask(value.task),role=value.role===null?null:readSavedRole(value.role),link=read(value.link)
   if(task.id!==taskId||task.version!==expectedTaskVersion||link.kind!=='task'||link.objectId!==taskId||link.sessionId!==sessionId||!link.active||task.assigneeRoleId!==(role?.id??null)||role&&role.ownerId!==task.ownerId)throw Error('任务上下文与请求不一致。')
   let business:TaskConversationBusinessContext|null=null
   if(value.business!==null&&value.business!==undefined){
    const row=taskInput(value.business,['source','object']),objectRow=taskInput(row.object,['scope','type','id','version','title','source','observedAt','receivedAt','quality','summary','fields','snapshotHash'])
    if(typeof objectRow.receivedAt!=='string')throw Error('任务业务对象快照格式不正确。')
    const source=readBusinessTaskSource(row.source,task.ownerId)
    const page=await readBusinessDataPage({schema:'teloa.business-data-page/v1',sourceId:source.sourceId,capturedAt:objectRow.receivedAt,items:[row.object]},{scope:source.reference.scope,sourceId:source.sourceId}),object=page.items[0]
    if(!object||source.taskId!==task.id||task.scope!==source.reference.scope||source.reference.scope!==object.scope||source.reference.type!==object.type||source.reference.id!==object.id||source.reference.version!==object.version||source.reference.snapshotHash!==object.snapshotHash)throw Error('任务业务对象快照与固定来源不一致。')
    business={source,object}
   }
   return {task,role,link,business}
  },
  async list(kind:Command['kind'],objectId:string){const value=await call('object-conversations/list',{kind,objectId});if(!Array.isArray(value))throw Error('会话关联目录不正确。');const rows=value.map(read);if(rows.some(r=>r.kind!==kind||r.objectId!==objectId)||new Set(rows.map(r=>r.sessionId)).size!==rows.length)throw Error('会话关联目录身份不一致。');return rows},
  async bySession(sessionId:string){if(!identity(sessionId))throw Error('会话身份不正确。');const value=await call('object-conversations/session',{sessionId});if(!Array.isArray(value))throw Error('会话上下文目录不正确。');const rows=value.map(read);if(rows.some(r=>r.sessionId!==sessionId||!r.active)||new Set(rows.map(r=>r.kind+':'+r.objectId)).size!==rows.length)throw Error('会话上下文目录身份不一致。');return rows},
  async change(command:Command){if(error)throw error;const proposed=request({...command,requestId:pending?.requestId??crypto.randomUUID()});if(pending&&JSON.stringify(pending)!==JSON.stringify(proposed))throw Error('请先核对原请求，再改变会话关联。');pending??=proposed;return send()}
 }
}
