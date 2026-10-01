import {WorkError,taskDefinition,taskInput,workTaskStates,isRecord} from '@teloa/contract'
import type {TaskAttentionPage} from '@teloa/backend'

type Ports={list:(owner:string,input:unknown)=>Promise<unknown>}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const timestamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const invalid=()=>new WorkError('teloa/invalid-host-response','需要你目录返回了无效任务或待处理依据。')
const exact=(value:unknown,keys:readonly string[])=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}

function read(value:unknown,owner:string):TaskAttentionPage{
 try{
  const page=exact(value,['items']);if(!Array.isArray(page.items))throw invalid()
  const ids=new Set<string>()
  for(const value of page.items){
   const row=exact(value,['task','attention']),task=exact(row.task,['id','ownerId','version','state','createdAt','updatedAt','title','goal','scope','assigneeRoleId','assigneeRoleVersion'].concat(['groupId','skills']))
   if(!uuid(task.id)||ids.has(task.id.toLowerCase())||task.ownerId!==owner||!positive(task.version)||!workTaskStates.some(state=>state===task.state)||!timestamp(task.createdAt)||!timestamp(task.updatedAt)||task.updatedAt<task.createdAt)throw invalid()
   ids.add(task.id.toLowerCase());taskDefinition({title:task.title,goal:task.goal,scope:task.scope,groupId:task.groupId,skills:task.skills})
   if(task.assigneeRoleId===null?task.assigneeRoleVersion!==null:!uuid(task.assigneeRoleId)||!positive(task.assigneeRoleVersion))throw invalid()
   if(task.state==='blocked'||task.state==='waiting'||row.attention!==null){
    const attention=exact(row.attention,['kind','reason'])
    const configurationFailed=attention.kind==='error'&&attention.reason==='execution-configuration-failed'
    if(task.state==='blocked'?!configurationFailed&&(attention.kind!=='error'||!['task-blocked','execution-failed'].some(reason=>reason===attention.reason)):task.state==='waiting'?!configurationFailed&&(attention.kind!=='review'||!['task-waiting','execution-completed'].some(reason=>reason===attention.reason)):!configurationFailed)throw invalid()
    if(['execution-failed','execution-completed','execution-configuration-failed'].some(reason=>reason===attention.reason)&&task.assigneeRoleId===null)throw invalid()
   }else if(row.attention!==null)throw invalid()
  }
  return page as unknown as TaskAttentionPage
 }catch{throw invalid()}
}

/** 一次持久快照同时标明任务版本及是否需要介入；不授予任何执行或结项权限。 */
export function createTaskAttentionHandler(owner:string,get:()=>Promise<Ports>){
 return async(payload:unknown):Promise<TaskAttentionPage>=>{
  if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  taskInput(payload,[])
  return read(await (await get()).list(owner,payload),owner)
 }
}
