import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,readBusinessReassignmentSelection,readBusinessReassignmentInstruction,readBusinessReassignmentSnapshot,type BusinessReassignmentInstruction,type BusinessReassignmentSnapshot} from '@teloa/contract'
import {authorizeConversationWorkMutation,type ConversationWorkAuthorizationPorts} from './conversation-work-tools.ts'
import {sourceInstruction} from './conversation-work-instruction.ts'

export type BusinessReassignmentInput={oldRequestId:string;instruction:BusinessReassignmentInstruction}
export type BusinessReassignmentToolsPorts=ConversationWorkAuthorizationPorts&{
 prepare:(input:BusinessReassignmentInput,revalidateInstruction:()=>Promise<void>)=>Promise<BusinessReassignmentSnapshot>
 supersede:(snapshot:BusinessReassignmentSnapshot,signal:AbortSignal,revalidate:()=>Promise<void>)=>Promise<unknown>
}
export const businessReassignmentToolName='teloa_work_supersede' as const
/** 只有真实日常会话的本人新消息可以申请；旧正文、目标和固定引用由后端推导。 */
export function registerBusinessReassignmentTools(ctx:Context,ports:BusinessReassignmentToolsPorts):()=>void{
 const prepared=new WeakMap<ToolExecution,BusinessReassignmentSnapshot>()
 const instruction=(exec:ToolExecution)=>readBusinessReassignmentInstruction({...sourceInstruction(ports.owner,exec),selection:readBusinessReassignmentSelection(exec.arguments)})
 const read=async(exec:ToolExecution)=>{
  await authorizeConversationWorkMutation(ports,exec)
  const fixed=instruction(exec)
  const revalidateInstruction=async()=>{
   await authorizeConversationWorkMutation(ports,exec)
   if(JSON.stringify(instruction(exec))!==JSON.stringify(fixed))throw new WorkError('teloa/conflict','本人改派指令已变化，请重新确认。')
   exec.signal.throwIfAborted()
  }
  const snapshot=readBusinessReassignmentSnapshot(await ports.prepare({oldRequestId:fixed.selection.oldRequestId,instruction:fixed},revalidateInstruction))
  if(JSON.stringify(snapshot.instruction)!==JSON.stringify(fixed))throw new WorkError('teloa/invalid-host-response','改派快照与本人真实指令不一致。')
  await revalidateInstruction()
  return snapshot
 }
 const removeTool=ctx.tools.register(defineTool({name:businessReassignmentToolName,description:'本人明确要求把同一业务的原单人交办改派给另一真实员工时使用。仅支持双方完整日常业务会话；原目标、材料与固定引用由服务端保留。先本人批准，再核对全部旧运行实际收敛；结果未知或缺原生取消证明不能创建后继。不会修改持久业务负责人；同一真实本人消息重试只继续原后继链。',parameters:{oldRequestId:{type:'string',required:true},newRoleId:{type:'string',required:true},expectedNewRoleVersion:{type:'integer',required:true}},output:{schema:{type:'string'},render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  readBusinessReassignmentSelection(args)
  const fixed=prepared.get(exec)
  if(!fixed)throw new WorkError('teloa/conflict','改派尚未完成本人原生确认。')
  const revalidate=async()=>{
   const current=await read(exec)
   if(current.snapshotHash!==fixed.snapshotHash||JSON.stringify(current)!==JSON.stringify(fixed))throw new WorkError('teloa/conflict','确认期间指令、会话、负责人、岗位或固定资料已变化，请重新确认。')
   exec.signal.throwIfAborted()
  }
  try{await revalidate();const value=await ports.supersede(fixed,exec.signal,revalidate);exec.signal.throwIfAborted();return JSON.stringify(value)}
  catch(error){if(error instanceof WorkError||exec.signal.aborted)throw error;throw new WorkError('teloa/host-unavailable','改派结果尚不可核对，请使用同一原消息重试，不要新建替代交办。')}
 }}))
 const removeGuard=ctx.on('tools/pre-execute',async(exec,next)=>{
  if(exec.name!==businessReassignmentToolName)return next()
  let fixed:BusinessReassignmentSnapshot
  try{fixed=await read(exec);prepared.set(exec,fixed)}catch(error){return {kind:'deny' as const,reason:error instanceof WorkError?error.message:'暂时无法核对改派身份与授权。'}}
  const decision=await next()
  if(decision.kind==='deny'||decision.kind==='cancel')return decision
  const reason=(decision.kind==='ask'&&decision.reason?decision.reason+'\n':'')+'确认将原交办安全改派（不修改持久业务负责人；原任务、运行和成果保留；收到回复仍待本人核对）：'+JSON.stringify(fixed)
  if(Buffer.byteLength(reason,'utf8')>131072)return {kind:'deny' as const,reason:'完整改派确认内容超过 128 KiB，请缩小内容后重试；尚未停止或创建任务。'}
  return {kind:'ask' as const,reason}
 })
 return ()=>{removeGuard();removeTool()}
}
