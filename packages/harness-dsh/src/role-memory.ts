import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,isRoleMemory,roleMemorySource,roleMemoryPreference,taskInput,type DigitalRole} from '@teloa/contract'
import {resolveSessionLineage,type LineageSession} from './subagent-lineage.ts'
import type {RoleMemoryActor,TaskExecutionScope} from '@teloa/backend'

export const roleMemoryEndpoints=['role-memory/list','role-memory/create','role-memory/confirm','role-memory/withdraw','role-memory/edit','role-memory/read-version'] as const
export const roleMemoryViewEndpoints=['role-memory-views/create','role-memory-views/read'] as const
export const roleMemoryProposalToolName='teloa_role_memory_propose'
/** 岗位记忆读口只接受已授权的范围选择，不把任务及原生会话载体作为读取权限。 */
export function roleMemoryRunTarget(target:TaskExecutionScope,role:Pick<DigitalRole,'kind'>){
 if(role.kind==='employee')return target.scope
 if(target.groupId===undefined||target.memoryViewId===undefined)throw new WorkError('teloa/forbidden','分身记忆读取需要明确的群与视图选择。')
 return {scope:target.scope,taskId:target.taskId,groupId:target.groupId,memoryViewId:target.memoryViewId}
}
type RoleMemoryOperations={
 list:(actor:RoleMemoryActor,input:unknown)=>Promise<unknown>
 create:(actor:RoleMemoryActor,input:unknown)=>Promise<unknown>
 confirm:(actor:RoleMemoryActor,input:unknown)=>Promise<unknown>
 withdraw:(actor:RoleMemoryActor,input:unknown)=>Promise<unknown>
 edit?:(actor:RoleMemoryActor,input:unknown)=>Promise<unknown>
 readVersion?:(actor:RoleMemoryActor,input:unknown)=>Promise<unknown>
}

/** 浏览器只以已认证的本人身份管理候选和确认记录，不接受调用方声明主体。 */
export function createRoleMemoryHandler(ownerId:string,get:()=>Promise<RoleMemoryOperations>){
 return async(endpoint:string,payload:unknown)=>{
  if(!(roleMemoryEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此员工记忆接口。')
  taskInput(payload,endpoint==='role-memory/list'?['roleId']:endpoint==='role-memory/create'?['requestId','roleId','expectedRoleVersion','title','markdown','source','visibility','preference']:endpoint==='role-memory/edit'?['requestId','roleId','memoryId','expectedContentVersion','expectedContentHash','expectedStateVersion','title','markdown','preference']:endpoint==='role-memory/read-version'?['roleId','memoryId','version']:['requestId','memoryId','expectedStateVersion'])
  const service=await get(),actor={ownerId,kind:'human' as const}
  if(endpoint==='role-memory/list')return service.list(actor,payload)
  if(endpoint==='role-memory/create')return service.create(actor,payload)
  if(endpoint==='role-memory/confirm')return service.confirm(actor,payload)
  if(endpoint==='role-memory/edit'){if(!service.edit)throw new WorkError('teloa/not-found','当前宿主尚不支持编辑员工记忆。');return service.edit(actor,payload)}
  if(endpoint==='role-memory/read-version'){if(!service.readVersion)throw new WorkError('teloa/not-found','当前宿主尚不支持读取记忆历史。');return service.readVersion(actor,payload)}
  return service.withdraw(actor,payload)
 }
}

type RoleMemoryViewOperations={create:(ownerId:string,input:unknown)=>Promise<unknown>;read:(ownerId:string,input:unknown)=>Promise<unknown>}
/** 只装配到已有本人认证 RPC，不注册为模型工具，也不接受调用方提供 owner。 */
export function createRoleMemoryViewHandler(ownerId:string,get:()=>Promise<RoleMemoryViewOperations>){
 return async(endpoint:string,payload:unknown)=>{
  if(!(roleMemoryViewEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此共享记忆视图接口。')
  taskInput(payload,endpoint==='role-memory-views/create'?['requestId','roleId','expectedRoleVersion','groupId','entries']:['viewId'])
  const service=await get()
  return endpoint==='role-memory-views/create'?service.create(ownerId,payload):service.read(ownerId,payload)
 }
}

export type RoleMemoryRunIdentity={id:string;roleId:string;roleVersion:number;sessionId:string;state:string;roleSnapshot?:{kind:'employee'|'twin'}|null}
export type RoleMemoryToolPorts={
 owner:string
 run:(sessionId:string)=>Promise<RoleMemoryRunIdentity|null>
 scope:(runId:string)=>Promise<TaskExecutionScope>
 create:(actor:RoleMemoryActor,input:unknown)=>Promise<unknown>
}

const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new WorkError('teloa/invalid-input','员工记忆工具参数格式不正确或包含未知字段。')
 return value as Record<string,unknown>
}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
function requestIdentity(owner:string,sessionId:string,callId:string):string{
 const value=createHash('sha256').update(['teloa-role-memory-tool/v1',owner,sessionId,roleMemoryProposalToolName,callId].join('\0')).digest('hex')
 return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`
}
async function authorize(ctx:Context,ports:RoleMemoryToolPorts,exec:{agent?:{session:LineageSession};signal:AbortSignal}){
 if(!exec.agent)throw new WorkError('teloa/forbidden','提出员工记忆候选需要真实运行会话。')
 exec.signal.throwIfAborted()
 // 子 Agent 会话自己不持有 Run，必须按谱系根会话查；谱系断链一律拒，不因为多了一层就放宽。
 let root:LineageSession
 try{root=resolveSessionLineage(ctx,exec.agent.session).root}catch{throw new WorkError('teloa/forbidden','无法核对当前会话的子 Agent 谱系。')}
 const run=await ports.run(root.id)
 if(!run||!uuid(run.id)||!uuid(run.roleId)||!positive(run.roleVersion)||run.sessionId!==root.id||!['accepted','active'].includes(run.state))throw new WorkError('teloa/forbidden','当前会话没有可核验的在运行员工。')
 if(run.roleSnapshot&& !['employee','twin'].includes(run.roleSnapshot.kind))throw new WorkError('teloa/forbidden','当前运行岗位快照不完整。')
 const scope=await ports.scope(run.id)
 if(scope.sessionId!==run.sessionId||typeof scope.scope!=='string'||!scope.scope.trim())throw new WorkError('teloa/forbidden','当前运行员工与业务范围不一致。')
 return {run,scope}
}

/** AI 员工只能在获准 Run 内提出候选；本轮经验默认绑定该 Run，确认与撤回仍由本人 RPC 完成。 */
export function registerRoleMemoryTools(ctx:Context,ports:RoleMemoryToolPorts){
 ctx.tools.register(defineTool({
  name:roleMemoryProposalToolName,
  description:'为当前执行员工提出一条员工记忆候选。员工身份和业务范围由当前 Run 固定。本轮工作形成的经验请省略 source，宿主会绑定当前已核验的固定 Run；无需查找或猜测运行编号、任务版本。仅引用其他已核验的任务、运行、成果或知识时填写 source，显式来源仍须有效。候选不会自动确认。本人分身识别个人习惯时使用显式 preference：preference 为长期默认，one-off 仅当前任务，correction 明确更正，counterexample 为当前任务的反例；更正/反例的 against 必须引用当前上下文中的原记忆固定版本和 contentHash。长期性由完整本人语义判断，不能由词频或固定词触发。basis.owner-input 引用本次获准任务或群本人输入原文；habit-observation 只能引用已注入的私有观察中已展示的本人审批理由及证据指针，统计和未读指针不能代替理由；owner-revision 只引用已注入的本人修订成果文件正文。适用业务和一次性 Task 由宿主固定，不传身份、权限或 Task 编号。Markdown 用自然语言说明适用范围及例外，正文不承载参数，不让用户填写 JSON。',
  parameters:{preference:{type:'object',additionalProperties:false,description:'仅本人分身可用的可选语义提议；由模型填写，不要求用户配置。',properties:{kind:{type:'string',enum:['preference','one-off','correction','counterexample'],required:true},basis:{type:'object',additionalProperties:false,required:true,properties:{kind:{type:'string',enum:['owner-input','habit-observation','owner-revision'],required:true},quote:{type:'string',required:true},memoryId:{type:'string'},version:{type:'integer'},contentHash:{type:'string'},evidenceId:{type:'string'},artifactId:{type:'string'}}},against:{type:'object',additionalProperties:false,properties:{memoryId:{type:'string',required:true},version:{type:'integer',required:true},contentHash:{type:'string',required:true}}}}},title:{type:'string',required:true},markdown:{type:'string',required:true},source:{type:'object',additionalProperties:false,description:'可选的其他已核验来源；本轮经验省略此字段，由宿主绑定当前 Run。',properties:{kind:{type:'string',enum:['task','run','artifact','knowledge'],required:true},id:{type:'string',required:true},version:{type:'integer',required:true}}}},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  execute:async(args,exec)=>{
   const row=exact(args,['title','markdown','source','preference']),{run,scope}=await authorize(ctx,ports,exec)
   const source=row.source===undefined?{kind:'run' as const,id:run.id,version:1}:roleMemorySource(row.source)
   if(source.kind==='self-feedback')throw new WorkError('teloa/forbidden','员工候选必须引用可核验来源。')
   const requestId=requestIdentity(ports.owner,run.sessionId,String(exec.callId)),twin=run.roleSnapshot?.kind==='twin'
   if(twin&&(source.kind!=='run'||source.id!==run.id||source.version!==1))throw new WorkError('teloa/forbidden','分身经验只能引用本次真实运行。')
   if(row.preference!==undefined&&!twin)throw new WorkError('teloa/forbidden','个人偏好提议仅属于本人分身。')
   const preference=row.preference===undefined?undefined:roleMemoryPreference({...exact(row.preference,['kind','basis','against']),schema:'teloa.preference-candidate/v1',scope:scope.scope})
   const visibility=twin?{kind:'private' as const,scopeIds:[] as []}:{kind:'role' as const,scopeIds:[scope.scope]}
   const memory=await ports.create({ownerId:ports.owner,kind:'agent',roleId:run.roleId},{requestId,roleId:run.roleId,expectedRoleVersion:run.roleVersion,title:row.title,markdown:row.markdown,source,visibility,...(preference?{preference}:{})})
   if(!isRoleMemory(memory)||memory.ownerId!==ports.owner||memory.roleId!==run.roleId||memory.roleVersion!==run.roleVersion||memory.state!=='candidate'||memory.proposedBy.kind!=='role'||memory.proposedBy.roleId!==run.roleId||memory.proposedBy.roleVersion!==run.roleVersion||memory.visibility.kind!==visibility.kind||JSON.stringify(memory.visibility.scopeIds)!==JSON.stringify(visibility.scopeIds)||memory.source.kind!==source.kind||memory.source.id!==source.id||memory.source.version!==source.version)throw new WorkError('teloa/invalid-host-response','员工记忆服务返回了与当前运行身份不一致的候选。')
   return JSON.stringify({requestId,memory})
  },
 }))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(exec.name!==roleMemoryProposalToolName)return next()
  try{await authorize(ctx,ports,exec)}catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法核对当前运行员工。'}}
  return next()
 })
}
