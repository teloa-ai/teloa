import {WorkError,isRecord,taskDefinition,taskInput,workTaskStates,type WorkTask} from '@teloa/contract'
import type {IndustryTaskRecord,IndustryTaskSource,IndustryWorkSnapshot} from '@teloa/backend'
type Ports={preview:(owner:string,input:unknown)=>Promise<unknown>;create:(owner:string,input:unknown)=>Promise<unknown>;source:(owner:string,input:unknown)=>Promise<unknown>}
export const industryTaskEndpoints=['industry-tasks/preview','industry-tasks/create','industry-tasks/source'] as const
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&v.length<=max
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const local=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(v)
const semver=(v:unknown)=>text(v,80)&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(v)
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v
const invalid=()=>new WorkError('teloa/invalid-host-response','行业任务回包的来源、身份或任务状态不一致。')
const exact=(v:unknown,keys:string[])=>{if(!isRecord(v)||Object.keys(v).some(key=>!keys.includes(key)))throw invalid();return v}
const snapshotKeys=['loadId','itemInstanceId','itemLocalId','contentId','contentHash','templateId','templateVersion','fileHash','title','method','requirements','output','skills','scope']
function snapshot(value:unknown,extras:string[]=[]):IndustryWorkSnapshot{
 const row=exact(value,[...snapshotKeys,...extras])
 if(!uuid(row.loadId)||!uuid(row.itemInstanceId)||!local(row.itemLocalId)||!uuid(row.contentId)||!hash(row.contentHash)||!local(row.templateId)||!semver(row.templateVersion)||!hash(row.fileHash)||!text(row.title,120)||!text(row.method,2000)||!text(row.output,2000)||!text(row.scope,80)||!Array.isArray(row.requirements)||!row.requirements.length||row.requirements.length>100||!row.requirements.every(item=>text(item,500))||!Array.isArray(row.skills)||row.skills.length>100)throw invalid()
 for(const value of row.skills){const skill=exact(value,['id','title','version']);if(!local(skill.id)||!text(skill.title,120)||!semver(skill.version))throw invalid()}
 return row as unknown as IndustryWorkSnapshot
}
function source(value:unknown,owner:string):IndustryTaskSource{
 const row=snapshot(value,['taskId','ownerId','inputs','createdAssignee','createdAt']) as IndustryTaskSource
 if(!uuid(row.taskId)||row.ownerId!==owner||!Array.isArray(row.inputs)||row.inputs.length!==row.requirements.length||!row.inputs.every(item=>text(item,4000))||!stamp(row.createdAt))throw invalid()
 if(row.createdAssignee!==null){const role=exact(row.createdAssignee,['roleId','roleVersion']);if(!uuid(role.roleId)||!integer(role.roleVersion))throw invalid()}
 return row
}
function task(value:unknown,owner:string):WorkTask{
 const row=exact(value,['id','ownerId','title','goal','scope','version','state','assigneeRoleId','assigneeRoleVersion','createdAt','updatedAt'].concat(['groupId','skills']))
 if(!uuid(row.id)||row.ownerId!==owner||!integer(row.version)||!workTaskStates.some(state=>state===row.state)||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt||(row.assigneeRoleId===null?row.assigneeRoleVersion!==null:!uuid(row.assigneeRoleId)||!integer(row.assigneeRoleVersion)))throw invalid()
 let definition:ReturnType<typeof taskDefinition>
 try{definition=taskDefinition({title:row.title,goal:row.goal,scope:row.scope,groupId:row.groupId,skills:row.skills})}catch{throw invalid()}
 return {...(row as unknown as WorkTask),...definition}
}
export function createIndustryTasksHandler(owner:string,get:()=>Promise<Ports>){
 return async(method:string,payload:unknown):Promise<IndustryWorkSnapshot|IndustryTaskRecord|IndustryTaskSource|null>=>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  if(method==='industry-tasks/source'){
   const input=taskInput(payload,['taskId']);if(!uuid(input.taskId))throw new WorkError('teloa/invalid-input','需要真实任务身份。')
   const response=await(await get()).source(owner,payload);if(response===null)return null
   const result=source(response,owner);if(result.taskId.toLowerCase()!==input.taskId.toLowerCase())throw invalid();return result
  }
  if(method!=='industry-tasks/preview'&&method!=='industry-tasks/create')throw new WorkError('teloa/invalid-input','不支持的行业任务操作。')
  const input=taskInput(payload,method==='industry-tasks/preview'?['loadId','itemInstanceId']:['requestId','loadId','itemInstanceId','goal','inputs','assignee'])
  if(!uuid(input.loadId)||!uuid(input.itemInstanceId))throw new WorkError('teloa/invalid-input','需要真实行业加载项身份。')
  if(method==='industry-tasks/preview'){
   const result=snapshot(await(await get()).preview(owner,payload));if(result.loadId.toLowerCase()!==input.loadId.toLowerCase()||result.itemInstanceId.toLowerCase()!==input.itemInstanceId.toLowerCase())throw invalid();return result
  }
  if(!uuid(input.requestId)||typeof input.goal!=='string'||!input.goal.trim()||input.goal.length>8000||!Array.isArray(input.inputs)||!input.inputs.length||input.inputs.length>100||!input.inputs.every(item=>typeof item==='string'&&!!item.trim()&&item.length<=4000))throw new WorkError('teloa/invalid-input','任务目标与输入不完整。')
  if(input.assignee!==undefined){const role=taskInput(input.assignee,['roleId','expectedVersion']);if(!uuid(role.roleId)||!integer(role.expectedVersion))throw new WorkError('teloa/invalid-input','员工身份或版本不合法。')}
  const response=exact(await(await get()).create(owner,payload),['task','source']),created=task(response.task,owner),fixed=source(response.source,owner)
  // 当前任务可合法编辑或流转，来源仍描述创建依据；不以当前标题和状态覆盖历史。
  if(created.id!==fixed.taskId||created.scope!==fixed.scope||fixed.loadId.toLowerCase()!==input.loadId.toLowerCase()||fixed.itemInstanceId.toLowerCase()!==input.itemInstanceId.toLowerCase()||JSON.stringify(fixed.inputs)!==JSON.stringify(input.inputs.map(item=>(item as string).trim())))throw invalid()
  const assigned=input.assignee as {roleId:string;expectedVersion:number}|undefined
  if(assigned?fixed.createdAssignee?.roleId.toLowerCase()!==assigned.roleId.toLowerCase()||fixed.createdAssignee?.roleVersion!==assigned.expectedVersion:fixed.createdAssignee!==null)throw invalid()
  return {task:created,source:fixed}
 }
}

export {snapshot as readIndustryWorkSnapshot}
