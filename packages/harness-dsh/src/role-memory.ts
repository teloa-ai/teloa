import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,isRoleMemory,roleMemorySource,taskInput} from '@teloa/contract'
import {resolveSessionLineage,type LineageSession} from './subagent-lineage.ts'
import type {RoleMemoryActor,TaskExecutionScope} from '@teloa/backend'

export const roleMemoryEndpoints=['role-memory/list','role-memory/create','role-memory/confirm','role-memory/withdraw'] as const
export const roleMemoryProposalToolName='teloa_role_memory_propose'
type RoleMemoryOperations={
 list:(actor:RoleMemoryActor,input:unknown)=>Promise<unknown>
 create:(actor:RoleMemoryActor,input:unknown)=>Promise<unknown>
 confirm:(actor:RoleMemoryActor,input:unknown)=>Promise<unknown>
 withdraw:(actor:RoleMemoryActor,input:unknown)=>Promise<unknown>
}

/** 浏览器只以已认证的本人身份管理候选和确认记录，不接受调用方声明主体。 */
export function createRoleMemoryHandler(ownerId:string,get:()=>Promise<RoleMemoryOperations>){
 return async(endpoint:string,payload:unknown)=>{
  if(!(roleMemoryEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此员工记忆接口。')
  taskInput(payload,endpoint==='role-memory/list'?['roleId']:endpoint==='role-memory/create'?['requestId','roleId','expectedRoleVersion','title','markdown','source','visibility']:['requestId','memoryId','expectedStateVersion'])
  const service=await get(),actor={ownerId,kind:'human' as const}
  if(endpoint==='role-memory/list')return service.list(actor,payload)
  if(endpoint==='role-memory/create')return service.create(actor,payload)
  if(endpoint==='role-memory/confirm')return service.confirm(actor,payload)
  return service.withdraw(actor,payload)
 }
}

type RoleMemoryRunIdentity={id:string;roleId:string;roleVersion:number;sessionId:string;state:string}
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
 const scope=await ports.scope(run.id)
 if(scope.sessionId!==run.sessionId||typeof scope.scope!=='string'||!scope.scope.trim())throw new WorkError('teloa/forbidden','当前运行员工与业务范围不一致。')
 return {run,scope}
}

/** AI 员工只能在获准 Run 内，为固定岗位和业务范围提出候选；确认与撤回仍由本人 RPC 完成。 */
export function registerRoleMemoryTools(ctx:Context,ports:RoleMemoryToolPorts){
 ctx.tools.register(defineTool({
  name:roleMemoryProposalToolName,
  description:'为当前执行员工提出一条员工记忆候选。员工身份和业务范围由当前 Run 固定；必须引用本次可核验的任务、运行、成果或知识来源。候选不会自动确认。',
  parameters:{title:{type:'string',required:true},markdown:{type:'string',required:true},source:{type:'object',additionalProperties:false,required:true,properties:{kind:{type:'string',enum:['task','run','artifact','knowledge'],required:true},id:{type:'string',required:true},version:{type:'integer',required:true}}}},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  execute:async(args,exec)=>{
   const row=exact(args,['title','markdown','source']),source=roleMemorySource(row.source)
   if(source.kind==='self-feedback')throw new WorkError('teloa/forbidden','员工候选必须引用可核验来源。')
   const {run,scope}=await authorize(ctx,ports,exec),requestId=requestIdentity(ports.owner,run.sessionId,String(exec.callId))
   const memory=await ports.create({ownerId:ports.owner,kind:'agent',roleId:run.roleId},{requestId,roleId:run.roleId,expectedRoleVersion:run.roleVersion,title:row.title,markdown:row.markdown,source,visibility:{kind:'role',scopeIds:[scope.scope]}})
   if(!isRoleMemory(memory)||memory.ownerId!==ports.owner||memory.roleId!==run.roleId||memory.roleVersion!==run.roleVersion||memory.state!=='candidate'||memory.proposedBy.kind!=='role'||memory.proposedBy.roleId!==run.roleId||memory.proposedBy.roleVersion!==run.roleVersion||memory.visibility.kind!=='role'||memory.visibility.scopeIds.length!==1||memory.visibility.scopeIds[0]!==scope.scope||JSON.stringify(memory.source)!==JSON.stringify(source))throw new WorkError('teloa/invalid-host-response','员工记忆服务返回了与当前运行身份不一致的候选。')
   return JSON.stringify({requestId,memory})
  },
 }))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(exec.name!==roleMemoryProposalToolName)return next()
  try{await authorize(ctx,ports,exec)}catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法核对当前运行员工。'}}
  return next()
 })
}
