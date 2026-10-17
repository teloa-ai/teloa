import {isDeepStrictEqual} from 'node:util'
import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,isBusinessScopeKey,taskInput,taskDefinition,taskConfigurationFields,workTaskStates,type WorkTask,type TaskConfigurationFields,type TaskDraftCreateInput,type TaskDraftCreateReceipt,type BusinessScopeLabel} from '@teloa/contract'
import {authorizeOrdinaryConversationMutation,authorizeConversationInstructionMutation,assertConversationInstructionMutationAuthorization,conversationInstructionMutationRequestId,type ConversationInstructionMutationAuthorization} from './conversation-mutation.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'

type TaskConfigurationGroup={id:string;ownerId:string;name:string;scope:string;archived:boolean}
type ConfigurationRequest={task:WorkTask;fields:TaskConfigurationFields;taskName?:string;groupName?:string|null}
export type TaskConfigurationToolsPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>
 readTaskPolicy:TaskToolPolicyReader
 isBuilder?:(sessionId:string)=>Promise<boolean>
 isPendingDaily?:(sessionId:string)=>Promise<boolean>
 list:()=>Promise<WorkTask[]>
 scopes:()=>Promise<Pick<BusinessScopeLabel,'scope'|'title'|'kind'>[]>
 groups:()=>Promise<TaskConfigurationGroup[]>
 request:(requestId:string)=>Promise<ConfigurationRequest|null>
 createRequest:(requestId:string)=>Promise<TaskDraftCreateReceipt|null>
 configure:(input:{requestId:string;taskId:string;expectedVersion:number;fields:TaskConfigurationFields;taskName:string;groupName?:string|null},signal:AbortSignal,revalidate:()=>Promise<void>)=>Promise<WorkTask>
 create:(input:TaskDraftCreateInput,signal:AbortSignal,revalidate:()=>Promise<void>)=>Promise<WorkTask>
 admitText?:(text:string)=>void
}
export const taskConfigurationToolNames=['teloa_task_configuration_list','teloa_task_configuration_read','teloa_task_configuration_create','teloa_task_configuration_save'] as const
const definitions=[
 {name:'teloa_task_configuration_list',description:'读取本人真实任务定义，按名称定位要继续调整的原任务。用户只需说任务名称和修改目标，不索要对象 ID、版本或请求身份。目录中的内部身份仅用于平台回读，最终回复只说名称、准确状态和必要下一步。',parameters:{}},
 {name:'teloa_task_configuration_read',description:'按名称读取原任务的目标、业务、协作群及技能声明；重名时根据可信目录中的目标辨别，并传内部 taskId 定位，不能要求用户填写 UUID。读取不交办、不启动。',parameters:{task:{type:'string',required:true},taskId:{type:'string'}}},
 {name:'teloa_task_configuration_create',description:'本人要求先准备或保存任务时，以当前目标保存真实未执行任务草稿；不指定员工、不启动运行。默认通用工作，无须先建业务；仅本人指定业务时传 business 显示名称，工具从真实目录解析业务身份。group 为同业务的协作群名称，skills 为技能声明；保存不授予员工或群访问权限、不激活技能。请求身份内部生成，原调用重放复用原任务，结果未知先回读。最终回复任务名称、已保存且未执行的状态及必要下一步，不展示技术身份。',parameters:{title:{type:'string',required:true},goal:{type:'string',required:true},business:{type:'string'},group:{type:'string'},skills:{type:'array',items:{type:'string'}}}},
 {name:'teloa_task_configuration_save',description:'在本人原会话修改原任务定义，保留同一任务身份和谱系。task 为原任务名称；重名时模型从可信目录传内部 taskId，不能让用户填写 UUID。只传明确要修改的 title、goal、group（群名称，null解除）或 skills。版本和请求身份由工具内部核对，不能要求用户提供。群和技能声明仅允许尚未启动的本人任务草稿，业务来源固定不能迁移。已准备或运行的上下文禁止修改，先停止或撤销原执行。保存清除旧执行授权但不会执行、改派、扩大机器权限或激活技能；技能声明不替代员工实际技能授权。最终只回复名称、已保存状态和必要下一步，不复述内部身份或版本。',parameters:{task:{type:'string',required:true},taskId:{type:'string'},title:{type:'string'},goal:{type:'string'},group:{oneOf:[{type:'string'},{type:'null'}]},skills:{type:'array',items:{type:'string'}}}},
] as const
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
function taskName(value:unknown):string{if(typeof value!=='string'||!value.trim()||value.length>120)throw new WorkError('teloa/invalid-input','请提供要调整的原任务名称。');return value.trim()}
export function checkedTask(ports:Pick<TaskConfigurationToolsPorts,'owner'|'admitText'>,value:WorkTask):WorkTask{
 if(!value||value.ownerId!==ports.owner||!uuid(value.id)||!Number.isSafeInteger(value.version)||value.version<1||!workTaskStates.includes(value.state))throw new WorkError('teloa/invalid-host-response','任务目录的本人归属或状态不可核对。')
 taskDefinition({title:value.title,goal:value.goal,scope:value.scope,groupId:value.groupId,skills:value.skills,...(value.completionPolicy?{completionPolicy:value.completionPolicy}:{})});ports.admitText?.(value.title);ports.admitText?.(value.goal);return value
}
export async function authorizeTaskConfiguration(ports:Pick<TaskConfigurationToolsPorts,'owner'|'conversation'|'readTaskPolicy'|'isBuilder'|'isPendingDaily'>,exec:ToolExecution,write:boolean){
 const input={...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal},auth=write?await authorizeConversationInstructionMutation(input):await authorizeOrdinaryConversationMutation(input,'任务定义配置')
 if(await ports.isBuilder?.(auth.sessionId))throw new WorkError('teloa/forbidden','业务搭建会话不能修改正式任务定义。')
 if(await ports.isPendingDaily?.(auth.sessionId))throw new WorkError('teloa/binding-pending','本人工作会话尚未完成归属，请先恢复原预约。')
 exec.signal.throwIfAborted();return auth
}
const authorize=authorizeTaskConfiguration
export const taskConfigurationResult=(task:WorkTask,sessionId:string,operation:'created'|'saved')=>({schema:'teloa.task-configuration-result/v1',operation,task,taskId:task.id,taskName:task.title,sessionId,status:'已保存',executionStarted:false})
async function prepare(ports:TaskConfigurationToolsPorts,exec:ToolExecution,args:unknown){
 const auth=await authorize(ports,exec,true) as ConversationInstructionMutationAuthorization,row=taskInput(args,['task','taskId','title','goal','group','skills']),name=taskName(row.task)
 if(row.taskId!==undefined&&!uuid(row.taskId))throw new WorkError('teloa/invalid-input','任务目录中的内部身份不正确。')
 const requestId=conversationInstructionMutationRequestId(auth,exec.name,exec.callId),prior=await ports.request(requestId)
 const tasks=(await ports.list()).map(task=>checkedTask(ports,task))
 let task:WorkTask
 if(prior){task=checkedTask(ports,prior.task);if(prior.taskName!==name||row.taskId!==undefined&&row.taskId!==task.id)throw new WorkError('teloa/conflict','同一原任务配置请求不能改成另一任务。')}
 else{const selected=tasks.filter(task=>task.title===name&&(row.taskId===undefined||task.id===row.taskId));if(selected.length!==1)throw new WorkError('teloa/conflict',selected.length?'有多个同名任务，请先读取任务目录核对目标。':'未找到本人原任务，请先核对任务目录。');task=selected[0]!}
 const {task:_,taskId:_id,group,...patch}=row
 let selectedGroup:TaskConfigurationGroup|null=null,groupName:string|null|undefined='group' in row?(group===null?null:taskName(group)):undefined,groupId:string|null|undefined
 if(prior&&prior.groupName!==undefined){
  // 恢复成功请求只使用持久回执：当前目录中的改名、归档或同名新群不改变原保存身份。
  if(groupName!==prior.groupName||prior.fields.groupId===undefined||groupName===null&&prior.fields.groupId!==null||groupName!==null&&!uuid(prior.fields.groupId))throw new WorkError('teloa/conflict','同一原任务配置请求不能改变关联群。')
  groupId=prior.fields.groupId
 }else if('group' in row&&group!==null){
  const name=taskName(group),groups=await ports.groups()
  if(groups.some(group=>group.ownerId!==ports.owner||!uuid(group.id)))throw new WorkError('teloa/invalid-host-response','协作群目录的本人归属不可核对。')
  const selected=groups.filter(group=>group.name===name&&group.scope===task.scope&&!group.archived)
  if(selected.length!==1)throw new WorkError('teloa/conflict','协作群名称、业务或状态不可唯一核对，请先读取原群。')
  selectedGroup=selected[0]!;groupId=selectedGroup.id
 }
 const fields=taskConfigurationFields({...patch,...('group' in row?{groupId:group===null?null:groupId}:{})})
 if(prior&&!isDeepStrictEqual(taskConfigurationFields(prior.fields),fields))throw new WorkError('teloa/conflict','同一原任务配置请求不能改变修改内容。')
 for(const value of [name,...Object.values(fields).filter((value):value is string=>typeof value==='string')])ports.admitText?.(value)
 // 旧回执没有原显示名，保持原请求格式；新请求将名称语义与真实 groupId 一起持久化。
 if(prior&&prior.groupName===undefined)groupName=undefined
 const request={requestId,taskId:task.id,expectedVersion:task.version,fields,taskName:name,...(groupName===undefined?{}:{groupName})}
 exec.signal.throwIfAborted()
 return {auth,task,selectedGroup,request,replay:prior!==null,fingerprint:JSON.stringify({task,selectedGroup,request})}
}
async function prepareCreate(ports:TaskConfigurationToolsPorts,exec:ToolExecution,args:unknown){
 const auth=await authorize(ports,exec,true) as ConversationInstructionMutationAuthorization,row=taskInput(args,['title','goal','business','group','skills']),requestId=conversationInstructionMutationRequestId(auth,exec.name,exec.callId)
 const prior=await ports.createRequest(requestId),businessName=row.business===undefined?undefined:taskName(row.business),groupName=row.group===undefined?undefined:taskName(row.group)
 if(prior){
  const saved=checkedTask(ports,prior.task),fields=taskDefinition({...prior.fields,title:row.title,goal:row.goal,skills:row.skills??[]})
  if(prior.requestId!==requestId||prior.sessionId!==auth.sessionId||prior.businessName!==businessName||prior.groupName!==groupName||!isDeepStrictEqual(fields,prior.fields)||saved.version!==1||saved.state!=='ready'||saved.assigneeRoleId!==null||!isDeepStrictEqual(taskDefinition({title:saved.title,goal:saved.goal,scope:saved.scope,groupId:saved.groupId,skills:saved.skills}),prior.fields))throw new WorkError('teloa/conflict','同一任务草稿创建请求不能改变原选择或内容。')
  exec.signal.throwIfAborted();const {task:_,...request}=prior
  return {auth,request,fingerprint:JSON.stringify(request)}
 }
 let scope='general',selectedBusiness:Pick<BusinessScopeLabel,'scope'|'title'|'kind'>|null=null,selectedGroup:TaskConfigurationGroup|null=null
 if(row.business!==undefined){
  const name=taskName(row.business),scopes=await ports.scopes()
  if(scopes.some(scope=>!isBusinessScopeKey(scope.scope)||typeof scope.title!=='string'||!scope.title.trim())||new Set(scopes.map(scope=>scope.scope)).size!==scopes.length)throw new WorkError('teloa/invalid-host-response','业务目录身份不可核对。')
  const selected=scopes.filter(scope=>scope.title===name&&scope.kind!=='legacy');if(selected.length!==1)throw new WorkError('teloa/conflict','业务名称不能唯一定位到本人可用业务，请核对业务目录。')
  selectedBusiness=selected[0]!;scope=selectedBusiness.scope
 }
 if(row.group!==undefined){
  const name=taskName(row.group),groups=await ports.groups();if(groups.some(group=>group.ownerId!==ports.owner||!uuid(group.id)))throw new WorkError('teloa/invalid-host-response','协作群目录的本人归属不可核对。')
  const selected=groups.filter(group=>group.name===name&&group.scope===scope&&!group.archived);if(selected.length!==1)throw new WorkError('teloa/conflict','协作群名称、业务或状态不可唯一核对。');selectedGroup=selected[0]!
 }
 const fields=taskDefinition({title:row.title,goal:row.goal,scope,groupId:selectedGroup?.id??null,...(row.skills===undefined?{}:{skills:row.skills})});ports.admitText?.(fields.title);ports.admitText?.(fields.goal);for(const skill of fields.skills)ports.admitText?.(skill)
 const request:TaskDraftCreateInput={requestId,sessionId:auth.sessionId,fields,...(businessName===undefined?{}:{businessName}),...(groupName===undefined?{}:{groupName})}
 exec.signal.throwIfAborted();return {auth,request,fingerprint:JSON.stringify(request)}
}
/** 沿用 DSH 原生审核；工具前置与服务提交前均复核原本人轮次。 */
export function registerTaskConfigurationTools(ctx:Context,ports:TaskConfigurationToolsPorts){
 const prepared=new WeakMap<ToolExecution,Awaited<ReturnType<typeof prepare>>>()
 const created=new WeakMap<ToolExecution,Awaited<ReturnType<typeof prepareCreate>>>()
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  const auth=await authorize(ports,exec,definition.name==='teloa_task_configuration_save'||definition.name==='teloa_task_configuration_create')
  try{
   if(definition.name==='teloa_task_configuration_create'){
    const fixed=created.get(exec);if(!fixed)throw new WorkError('teloa/conflict','任务草稿尚未完成审核核对。')
    const revalidate=async()=>{const current=await prepareCreate(ports,exec,args);assertConversationInstructionMutationAuthorization(fixed.auth,current.auth);if(current.fingerprint!==fixed.fingerprint)throw new WorkError('teloa/version-conflict','审核期间业务或协作群已变化，请重新核对任务草稿。');exec.signal.throwIfAborted()}
    await revalidate();const saved=checkedTask(ports,await ports.create(fixed.request,exec.signal,revalidate));assertConversationInstructionMutationAuthorization(fixed.auth,await authorize(ports,exec,true) as ConversationInstructionMutationAuthorization);exec.signal.throwIfAborted()
    return JSON.stringify(taskConfigurationResult(saved,auth.sessionId,'created'))
   }
   if(definition.name==='teloa_task_configuration_save'){
    const fixed=prepared.get(exec);if(!fixed)throw new WorkError('teloa/conflict','原任务配置尚未完成审核核对。')
    const revalidate=async()=>{
     const current=await prepare(ports,exec,args);assertConversationInstructionMutationAuthorization(fixed.auth,current.auth)
     if(current.fingerprint!==fixed.fingerprint)throw new WorkError('teloa/version-conflict','审核期间任务定义或协作群已变化，请核对原任务。')
     exec.signal.throwIfAborted()
    }
    await revalidate()
    const saved=checkedTask(ports,await ports.configure(fixed.request,exec.signal,revalidate))
    assertConversationInstructionMutationAuthorization(fixed.auth,await authorize(ports,exec,true) as ConversationInstructionMutationAuthorization);exec.signal.throwIfAborted()
    if(saved.id!==fixed.task.id||saved.scope!==fixed.task.scope||!Object.entries(fixed.request.fields).every(([key,value])=>isDeepStrictEqual(saved[key as keyof WorkTask],value)))throw new WorkError('teloa/invalid-host-response','任务保存回执与原任务修改不一致。')
    return JSON.stringify(taskConfigurationResult(saved,auth.sessionId,'saved'))
   }
   const row=taskInput(args,definition.name==='teloa_task_configuration_list'?[]:['task','taskId']),tasks=(await ports.list()).map(task=>checkedTask(ports,task))
   exec.signal.throwIfAborted()
   if(definition.name==='teloa_task_configuration_list')return JSON.stringify({tasks,sessionId:auth.sessionId,executionStarted:false})
   if(row.taskId!==undefined&&!uuid(row.taskId))throw new WorkError('teloa/invalid-input','任务目录中的内部身份不正确。')
   const selected=tasks.filter(task=>task.title===taskName(row.task)&&(row.taskId===undefined||task.id===row.taskId));if(selected.length!==1)throw new WorkError('teloa/conflict','原任务名称不能唯一定位，请先核对任务目录。')
   return JSON.stringify({task:selected[0],sessionId:auth.sessionId,executionStarted:false})
  }catch(error){if(error instanceof WorkError||exec.signal.aborted)throw error;throw new WorkError('teloa/host-unavailable','任务配置暂不可用，请先读取原任务核对保存结果。')}
 }}))
 return ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!(taskConfigurationToolNames as readonly string[]).includes(exec.name))return next()
  try{if(exec.name==='teloa_task_configuration_save')prepared.set(exec,await prepare(ports,exec,exec.arguments));else if(exec.name==='teloa_task_configuration_create')created.set(exec,await prepareCreate(ports,exec,exec.arguments));else await authorize(ports,exec,false)}
  catch(error){return {kind:'deny' as const,reason:error instanceof WorkError?error.message:'暂时无法核对原任务配置。'}}
  return next()
 })
}
