import {WorkError,taskInput,type DigitalRole,type ResourceReference} from '@teloa/contract'
import {readRunKnowledge,type TaskExecutionScope,type TaskMaterialService,type TaskRun,type TaskRunSkillDatabase} from '@teloa/backend'

export const taskMaterialEndpoints=['tasks/materials','tasks/materials/add'] as const

/** `checkKnowledge`：添加前按资料体积预检（超过整段进提示词上限的资料只能加入本地检索），拒绝时不写任务。 */
export function createTaskMaterialHandler(
 owner:string,
 get:()=>Promise<Pick<TaskMaterialService,'list'|'add'>>,
 checkKnowledge?:(taskId:string,resourceId:string)=>Promise<void>,
){
 return async(endpoint:string,payload:unknown)=>{
  if(!(taskMaterialEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此任务知识接口。')
  const row=taskInput(payload,endpoint==='tasks/materials'?['taskId']:['requestId','taskId','expectedTaskVersion','resourceId','expectedResourceVersion'])
  if(endpoint==='tasks/materials/add'&&checkKnowledge&&typeof row.taskId==='string'&&typeof row.resourceId==='string')await checkKnowledge(row.taskId,row.resourceId)
  const service=await get()
  return endpoint==='tasks/materials'?service.list(owner,payload):service.add(owner,payload)
 }
}

export type TaskMaterialKnowledgeReader=(target:TaskExecutionScope,references:readonly ResourceReference[],database:TaskRunSkillDatabase,signal:AbortSignal)=>Promise<TaskRun['knowledge']>

/** 在 TaskRun prepare 的同一事务内固定任务引用，再按固定版本读取正文。 */
export function createTaskMaterialKnowledgeLoader(
 owner:string,
 get:()=>Promise<Pick<TaskMaterialService,'executionRefsInTransaction'>>,
 read:TaskMaterialKnowledgeReader,
){
 return async(target:TaskExecutionScope,_role:DigitalRole,database:TaskRunSkillDatabase,signal:AbortSignal):Promise<TaskRun['knowledge']>=>{
  signal.throwIfAborted()
  const saved=await (await get()).executionRefsInTransaction(database,owner,target.taskId,target.taskVersion)
  const references=target.knowledgeIds==null?saved:saved.filter(ref=>target.knowledgeIds!.includes(ref.id))
  signal.throwIfAborted()
  if(!references.length)return []
  const knowledge=readRunKnowledge(await read(target,references,database,signal))
  if(JSON.stringify(knowledge.map(item=>({id:item.id,version:item.version})))!==JSON.stringify(references))throw new WorkError('teloa/version-conflict','任务知识版本已变化，请重新核对执行准备。')
  return knowledge
 }
}
