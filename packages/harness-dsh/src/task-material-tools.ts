import {isDeepStrictEqual} from 'node:util'
import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,isTaskMaterialAddInput,isTaskMaterialList,isTaskMaterialResult,isWorkResource,resourceId,taskInput,type TaskMaterialAddInput,type TaskMaterialRef,type TaskMaterialResult,type WorkResource} from '@teloa/contract'
import {authorizeTaskConfiguration,checkedTask,taskConfigurationResult,type TaskConfigurationToolsPorts} from './task-configuration-tools.ts'
import {assertConversationInstructionMutationAuthorization,conversationInstructionMutationRequestId,type ConversationInstructionMutationAuthorization} from './conversation-mutation.ts'

export type TaskMaterialToolsPorts=Pick<TaskConfigurationToolsPorts,'owner'|'conversation'|'readTaskPolicy'|'isBuilder'|'isPendingDaily'|'admitText'|'list'>&{
 resources:(sessionId:string)=>Promise<WorkResource[]>
 materials:(taskId:string)=>Promise<TaskMaterialRef[]>
 request:(requestId:string)=>Promise<{input:TaskMaterialAddInput;result:TaskMaterialResult}|null>
 checkBudget:(taskId:string,resourceId:string)=>Promise<void>
 add:(input:TaskMaterialAddInput,signal:AbortSignal,revalidate:()=>Promise<void>)=>Promise<TaskMaterialResult>
}
export const taskMaterialToolNames=['teloa_task_materials_read','teloa_task_materials_add'] as const
const field={type:'string',required:true} as const
const definitions=[
 {name:taskMaterialToolNames[0],description:'按名称回读本人原任务已固定的资料引用及当前会话可用的同业务资料候选，不读取正文、不添加或执行。资料与技能分别管理，不能把资料名称存成skills。重名时模型用目录中的内部taskId核对，不让用户提供ID或版本。',parameters:{task:field,taskId:{type:'string'}}},
 {name:taskMaterialToolNames[1],description:'按本人当前指令把一份真实 WorkResource 资料加到同一原任务。业务告警等对象的 recordRef 不是资料，不能在此绑定；员工对象交办直接使用 teloa_work_dispatch.reference，不先建无员工任务。task和material为显示名称；重名时模型从真实目录用taskId或materialId定位，不要求用户填写ID或版本。请求、任务及资料版本由宿主固定，沿原生审批；只添加固定资料引用，不改skills、负责人或业务，不执行任务，不授予其他员工权限。结果未知先用read回读，不能换请求重复添加；同调用重放只恢复原添加回执，当前可用性另行回读。',parameters:{task:field,taskId:{type:'string'},material:field,materialId:{type:'string'}}},
] as const
const bad=()=>new WorkError('teloa/invalid-host-response','任务资料目录或回执与本人原对象不一致。')
function name(value:unknown,max:number):string{if(typeof value!=='string'||!value.trim()||value.length>max)throw new WorkError('teloa/invalid-input','请提供原任务和资料名称。');return value.trim()}
function argumentsOf(args:unknown,write:boolean){
 const row=taskInput(args,write?['task','taskId','material','materialId']:['task','taskId'])
 for(const key of ['taskId','materialId'])if(row[key]!==undefined&&!resourceId(row[key]))throw new WorkError('teloa/invalid-input','原目录中的内部身份不正确。')
 return {task:name(row.task,120),...(row.taskId===undefined?{}:{taskId:String(row.taskId).toLowerCase()}),...(write?{material:name(row.material,200),...(row.materialId===undefined?{}:{materialId:String(row.materialId).toLowerCase()})}:{})}
}
async function selectTask(ports:TaskMaterialToolsPorts,row:ReturnType<typeof argumentsOf>){
 const tasks=(await ports.list()).map(task=>checkedTask(ports,task)),selected=tasks.filter(task=>task.title===row.task&&(!row.taskId||task.id===row.taskId))
 if(selected.length!==1)throw new WorkError('teloa/conflict','原任务名称不能唯一定位，请先读取任务目录核对目标。')
 return selected[0]!
}
async function directory(ports:TaskMaterialToolsPorts,sessionId:string,task:Awaited<ReturnType<typeof selectTask>>){
 const rows=await ports.resources(sessionId)
 if(!Array.isArray(rows)||rows.some(row=>!isWorkResource(row)||row.ownerId!==ports.owner)||new Set(rows.map(row=>row.id)).size!==rows.length)throw bad()
 const resources=rows.filter(row=>row.status==='active'&&row.scopeIds.every(scope=>scope===task.scope)),materials=await ports.materials(task.id)
 if(!isTaskMaterialList(materials)||materials.some(item=>item.taskId!==task.id||item.taskVersion>task.version))throw bad()
 for(const resource of resources)ports.admitText?.(resource.title)
 return {resources,materials}
}
async function prepare(ports:TaskMaterialToolsPorts,exec:ToolExecution,args:unknown){
 const auth=await authorizeTaskConfiguration(ports,exec,true) as ConversationInstructionMutationAuthorization,row=argumentsOf(args,true),requestId=conversationInstructionMutationRequestId(auth,exec.name,exec.callId),prior=await ports.request(requestId)
 if(prior){
  if(!isTaskMaterialAddInput(prior.input)||!isTaskMaterialResult(prior.result)||prior.input.requestId!==requestId||prior.result.task.ownerId!==ports.owner||prior.input.taskId!==prior.result.task.id||prior.input.expectedTaskVersion+1!==prior.result.task.version||prior.input.resourceId!==prior.result.material.resourceId||prior.input.expectedResourceVersion!==prior.result.material.resourceVersion)throw bad()
  const task=checkedTask(ports,prior.result.task),material=prior.result.material
  if(task.title!==row.task||material.title!==row.material||row.taskId&&row.taskId!==task.id||row.materialId&&row.materialId!==material.resourceId)throw new WorkError('teloa/conflict','同一添加请求不能改成其他任务或资料。')
  return {auth,task,input:prior.input,replay:prior.result,existing:undefined,fingerprint:JSON.stringify(prior)}
 }
 const task=await selectTask(ports,row),{resources,materials}=await directory(ports,auth.sessionId,task),selected=resources.filter(resource=>resource.title.trim()===row.material&&(!row.materialId||resource.id===row.materialId))
 if(selected.length!==1)throw new WorkError('teloa/conflict','资料名称、业务或状态不能唯一核对，请先回读任务资料候选。')
 const resource=selected[0]!,existing=materials.find(item=>item.resourceId===resource.id)
 if(existing&&(!existing.available||existing.resourceVersion!==resource.version||existing.sourceId!==resource.sourceId||existing.sourceVersion!==resource.sourceVersion||existing.title!==resource.title.trim()||!isDeepStrictEqual(existing.scopeIds,resource.scopeIds)))throw new WorkError('teloa/version-conflict','原任务的固定资料已变化，请先核对原引用，不自动替换。')
 if(!existing)await ports.checkBudget(task.id,resource.id)
 const input={requestId,taskId:task.id,expectedTaskVersion:task.version,resourceId:resource.id,expectedResourceVersion:resource.version}
 exec.signal.throwIfAborted()
 return {auth,task,input,replay:undefined,existing,fingerprint:JSON.stringify({task,resource,existing:existing??null,input})}
}

/** 复用原任务资料服务与原生工具审核，提交前复核同一用户指令、任务和固定资料版本。 */
export function registerTaskMaterialTools(ctx:Context,ports:TaskMaterialToolsPorts){
 const prepared=new WeakMap<ToolExecution,Awaited<ReturnType<typeof prepare>>>()
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  try{
   if(definition.name===taskMaterialToolNames[0]){
    const auth=await authorizeTaskConfiguration(ports,exec,false),task=await selectTask(ports,argumentsOf(args,false)),{resources,materials}=await directory(ports,auth.sessionId,task)
    await authorizeTaskConfiguration(ports,exec,false);exec.signal.throwIfAborted()
    return JSON.stringify({task,materials,candidates:resources.filter(resource=>!materials.some(item=>item.resourceId===resource.id)),executionStarted:false})
   }
   const fixed=prepared.get(exec);if(!fixed)throw new WorkError('teloa/conflict','任务资料尚未完成审核核对。')
   const revalidate=async()=>{const current=await prepare(ports,exec,args);assertConversationInstructionMutationAuthorization(fixed.auth,current.auth);if(current.fingerprint!==fixed.fingerprint)throw new WorkError('teloa/version-conflict','审核期间任务或资料已变化，请先核对原任务。');exec.signal.throwIfAborted()}
   await revalidate()
   if(fixed.replay||fixed.existing)return JSON.stringify({...taskConfigurationResult(fixed.replay?.task??fixed.task,fixed.auth.sessionId,'saved'),material:fixed.replay?.material??fixed.existing,materialOperation:fixed.replay?'recovered':'already-added',replayed:!!fixed.replay})
   const saved=await ports.add(fixed.input,exec.signal,revalidate)
   assertConversationInstructionMutationAuthorization(fixed.auth,await authorizeTaskConfiguration(ports,exec,true) as ConversationInstructionMutationAuthorization);exec.signal.throwIfAborted()
   if(!isTaskMaterialResult(saved)||saved.task.ownerId!==ports.owner||saved.task.id!==fixed.task.id||saved.task.version!==fixed.input.expectedTaskVersion+1||saved.task.scope!==fixed.task.scope||saved.task.state!==fixed.task.state||saved.task.assigneeRoleId!==fixed.task.assigneeRoleId||saved.task.assigneeRoleVersion!==fixed.task.assigneeRoleVersion||!isDeepStrictEqual(saved.task.skills,fixed.task.skills)||saved.material.resourceId!==fixed.input.resourceId||saved.material.resourceVersion!==fixed.input.expectedResourceVersion)throw bad()
   return JSON.stringify({...taskConfigurationResult(saved.task,fixed.auth.sessionId,'saved'),material:saved.material,materialOperation:'added',replayed:false})
  }catch(error){if(error instanceof WorkError||exec.signal.aborted)throw error;throw new WorkError('teloa/host-unavailable','任务资料暂不可用，请先回读原任务核对添加结果。')}
 }}))
 return ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!(taskMaterialToolNames as readonly string[]).includes(exec.name))return next()
  try{if(exec.name===taskMaterialToolNames[1])prepared.set(exec,await prepare(ports,exec,exec.arguments));else{argumentsOf(exec.arguments,false);await authorizeTaskConfiguration(ports,exec,false)}}
  catch(error){return {kind:'deny' as const,reason:error instanceof WorkError?error.message:'暂时无法核对原任务资料。'}}
  return next()
 })
}
