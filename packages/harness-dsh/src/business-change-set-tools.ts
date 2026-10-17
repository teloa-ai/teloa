import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type ToolExecution,type ParameterSchemaSpec} from '@deepseek-ai/dsh-tools'
import {WorkError,taskInput,readBusinessChangeSetApply,readBusinessChangeSetPrepare} from '@teloa/contract'
import type {BusinessChangeSetService,GroupTaskBusinessGrant} from '@teloa/backend'
import {authorizeBusinessConversation,type BusinessConversationAuthorizationPorts} from './business-conversation-authorization.ts'
import {readConversationInstructionIdentity,type ConversationInstructionIdentity} from './conversation-instruction-identity.ts'
import {authorizeGroupBusinessTask,readGroupBusinessTaskInstruction} from './group-business-task-authorization.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {businessRecordBatchProtocol,businessRecordOperationsParameter} from './business-record-batch-schema.ts'
export type BusinessChangeSetToolsPorts=BusinessConversationAuthorizationPorts&{
 readTaskPolicyInTransaction?:(db:unknown,sessionId:string,signal:AbortSignal)=>ReturnType<TaskToolPolicyReader>
 changes:Pick<BusinessChangeSetService,'prepare'|'get'|'apply'>;lockAuthorization?:(db:unknown,sessionId:string)=>Promise<void>
 /** 群明确工作的受限授权：只读宿主事实（Run、群来源、群许可、业务范围、工作控制）；db 为采用事务时在同一事务内加锁重读。未装配时任务会话一律拒绝。 */
 groupTask?:(db:unknown,sessionId:string)=>Promise<GroupTaskBusinessGrant>
}
/** 岗位可授予的业务修改草稿工具；只在群明确工作的受限授权下对任务可用，采用每次仍经原生审批。 */
export const businessChangeSetToolNames=['teloa_business_change_prepare','teloa_business_change_apply','teloa_business_change_read'] as const
const names=businessChangeSetToolNames
const requestId=(owner:string,source:unknown)=>{const h=createHash('sha256').update(JSON.stringify(['teloa.business-change/v1',owner,source])).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`}
/** 官方 ToolRuntime 管理批准；只有它随后调用 execute 时才构造后台授权回调。 */
export function registerBusinessChangeSetTools(ctx:Context,ports:BusinessChangeSetToolsPorts){
 type Current={scope:string;title:string;actor:{ownerId:string;scopeIds:string[]};fingerprint:string;task?:GroupTaskBusinessGrant}
 /**
  * 本人普通业务会话沿原授权闸（不放宽）。任务会话只走群明确工作的受限授权：这三项工具须在 Run 冻结的 allowed_tools 中由本人明确授予，
  * 原 Run 未要求停止，宿主事实（群来源 v2 work、摘要、原消息、群许可、同一业务范围、原工作控制）全部成立；子 Agent 不可用。
  */
 const authorize=async(exec:Pick<ToolExecution,'agent'|'signal'|'name'>,db:unknown=null):Promise<Current>=>{
  const sessionId=exec.agent?.session.id
  if(db&&sessionId&&!ports.readTaskPolicyInTransaction&&await ports.isTaskConversation(sessionId))throw new WorkError('teloa/forbidden','当前宿主未接入事务内工作权限复核，不能采用业务修改。')
  const policy=sessionId?await (db&&ports.readTaskPolicyInTransaction?ports.readTaskPolicyInTransaction(db,sessionId,exec.signal):ports.readTaskPolicy(sessionId,exec.signal)):null
  if(policy===null)return authorizeBusinessConversation(ports,exec,'业务修改草稿')
  return authorizeGroupBusinessTask(ports,exec,policy,db)
 }
 /** 任务 Run 的指令身份是宿主提交的那条原 Run 输入（按原生请求身份定位），活动追加不改变它。 */
 const instructionOf=(exec:Pick<ToolExecution,'agent'>,current:Current):ConversationInstructionIdentity=>{
  if(!current.task)return readConversationInstructionIdentity(exec.agent!)
  return readGroupBusinessTaskInstruction(exec,current.task)
 }
 const fixed=new WeakMap<ToolExecution,{current:Current;instruction:ConversationInstructionIdentity;input:unknown}>()
 const input=(name:string,args:unknown,current:Current,instruction:ReturnType<typeof readConversationInstructionIdentity>)=>{
  if(name==='teloa_business_change_prepare'){const row=taskInput(args,['operations','changeSetId','expectedRevision']);return readBusinessChangeSetPrepare({...row,scope:current.scope,requestId:requestId(ports.owner,instruction)})}
  if(name==='teloa_business_change_apply')return readBusinessChangeSetApply(args)
  const row=taskInput(args,['changeSetId']);readBusinessChangeSetApply({...row,expectedRevision:1,expectedDigest:'a'.repeat(64)});return row as {changeSetId:string}
 }
 const definitions:readonly {name:typeof names[number];description:string;parameters:ParameterSchemaSpec}[]=[
  {name:names[0],description:'准备当前业务的持久修改草稿，不写正式记录、不请求采用。operations 与本地记录写入同一批次协议，1–50项、128KiB：'+businessRecordBatchProtocol+'。记录类型 id 与字段 name 以业务定义为准（本人会话可先读取真实类型和记录；群工作按本人交办与业务上下文）。可用changeSetId和expectedRevision调整尚未采用的草稿。返回固定id、revision、digest供本人审阅；采用须另用apply工具经原生批准。',parameters:{operations:businessRecordOperationsParameter,changeSetId:{type:'string'},expectedRevision:{type:'integer'}}},
  {name:names[1],description:'采用本人已审阅的固定业务修改草稿。只接受changeSetId、expectedRevision、expectedDigest；原生批准后原子写入。过期时重新准备，不修改摘要重试。结果未知使用read核对原ID；批准只针对此版本，分析统计不需要此工具。',parameters:{changeSetId:{type:'string',required:true},expectedRevision:{type:'integer',required:true},expectedDigest:{type:'string',required:true}}},
  {name:names[2],description:'读取当前业务修改草稿及固定采用回执；不重写记录、不制造批准。',parameters:{changeSetId:{type:'string',required:true}}},
 ]
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,output:{schema:{type:'string'} as const,render:(_a:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  const prepared=fixed.get(exec),current=await authorize(exec),instruction=instructionOf(exec,current)
  if(!prepared||current.fingerprint!==prepared.current.fingerprint||JSON.stringify(instruction)!==JSON.stringify(prepared.instruction)||JSON.stringify(input(definition.name,args,current,instruction))!==JSON.stringify(prepared.input))throw new WorkError('teloa/forbidden','本人指令或业务授权在审批期间已变化。')
  if(definition.name===names[0])return JSON.stringify(await ports.changes.prepare(current.actor,prepared.input,{...instruction,fingerprint:current.fingerprint}))
  const value=prepared.input as {changeSetId:string},draft=await ports.changes.get(current.actor,value)
  if(draft.scope!==current.scope||draft.sessionId!==exec.agent!.session.id)throw new WorkError('teloa/forbidden','请在原业务工作会话中处理此草稿。')
  if(definition.name===names[2])return JSON.stringify(draft)
  const result=await ports.changes.apply(current.actor,prepared.input,async(db,origin)=>{
   await ports.lockAuthorization?.(db,origin.sessionId)
   const latest=await authorize(exec,db);exec.signal.throwIfAborted()
   if(latest.fingerprint!==current.fingerprint||origin.sessionId!==exec.agent!.session.id)throw new WorkError('teloa/forbidden','当前业务授权已变化。')
   return latest.fingerprint
  })
  return JSON.stringify(result)
 }}))
 const remove=ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!(names as readonly string[]).includes(exec.name))return next()
  try{
   const current=await authorize(exec),instruction=instructionOf(exec,current),value=input(exec.name,exec.arguments,current,instruction);fixed.set(exec,{current,instruction,input:value})
   if(exec.name!==names[1])return next()
   const draft=await ports.changes.get(current.actor,value as {changeSetId:string})
   if(draft.scope!==current.scope||draft.sessionId!==exec.agent!.session.id)throw new WorkError('teloa/forbidden','草稿不属于当前业务工作会话。')
   const decision=await next();if(decision.kind==='deny'||decision.kind==='cancel'||draft.state==='applied')return decision
   // 审批等待由原生会话持有；持久草稿不能冒充尚未完成的批准。
   const changes=draft.preview.operations.map((op,index)=>({项:index+1,操作:op.operation==='create'?'新增':op.operation==='edit'?'修改':'归档',记录:op.title,...(op.before?{原版本:op.before.version,原标题:op.before.title,原摘要:op.before.summary,原字段:op.before.fields}:{}),...(op.fields?{新摘要:op.summary,新字段:op.fields.map(field=>({名称:field.label??field.name,值:field.value}))}:{})}))
   const reason='采用业务“'+current.title+'”的这份本地记录修改？完整差异：'+JSON.stringify(changes)+'；关联及目标记录：'+JSON.stringify(draft.preview.targets.map(target=>({标题:target.title,版本:target.version,字段:target.fields})))
   if(Buffer.byteLength(reason)>131072)throw new WorkError('teloa/invalid-input','完整审批内容超过128KiB，请缩小批次。')
   return {kind:'ask' as const,reason:(decision.kind==='ask'&&decision.reason?decision.reason+'\n':'')+reason}
  }catch(e){return {kind:'deny' as const,reason:e instanceof WorkError?e.message:'暂时无法核对业务修改草稿。'}}
 })
 return ()=>{remove()}
}
