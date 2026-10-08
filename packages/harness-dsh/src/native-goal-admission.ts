import type {Context} from '@deepseek-ai/cordis'
import {createHash} from 'node:crypto'
import type {WorkAccessLease} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import type {GoalRunBinding,GoalContinuationReceipt} from '@teloa/contract'
import type {GoalInputCandidate} from './native-producer-admission.ts'
import type {createNativeWorkInput} from './native-work-input.ts'
import {nativeInputIdentity} from './native-input-access.ts'
import {readSessionEvents} from './session-events.ts'

export type NativeGoalAdmissionPorts={
 resolve:(candidate:GoalInputCandidate)=>Promise<GoalRunBinding>
 reserve:(input:{binding:GoalRunBinding;round:number;messageId:string;nativeRequestId:string;payloadSha256:string})=>Promise<GoalContinuationReceipt>
 acquire:(input:{binding:GoalRunBinding;round:number})=>Promise<WorkAccessLease>
 confirm:(input:{nativeRequestId:string;acceptedSeq:number})=>Promise<GoalContinuationReceipt>
 unknown:(nativeRequestId:string)=>Promise<void>
 /** 同步查询 exact live Goal/ref/round；与许可一同进入既有最终 Session guard。 */
 assertCurrent:(candidate:GoalInputCandidate,binding:GoalRunBinding)=>void
 assertContinuationCurrent:(candidate:GoalInputCandidate,binding:GoalRunBinding)=>void
}
/** 官方 source 没有 rpcId；receipt 身份独立，载荷仍用官方完整 UserMessage 的 lossless 摘要。 */
export function createNativeGoalAdmission(ctx:Context,input:Pick<ReturnType<typeof createNativeWorkInput>,'withNewInput'>,ports:NativeGoalAdmissionPorts){
 const invoke=(fn:()=>void,receiver:unknown)=>{const result:unknown=Reflect.apply(fn,receiver,[]);if(result!==undefined){void Promise.resolve(result).catch(()=>{});throw new WorkError('teloa/forbidden','Goal 最终准入必须同步核验。')}}
 return async(candidate:GoalInputCandidate,dispatch:()=>void):Promise<void>=>{
  const {agent,message,goal,round}=candidate,session=agent.session,identity=nativeInputIdentity(message)
  const source=message.source as unknown as Record<string,unknown>
  if(source.kind!=='goal'||source.goalId!==goal.id||source.revision!==goal.revision||source.round!==round||Object.keys(source).some(key=>!['kind','goalId','revision','round'].includes(key)))throw new WorkError('teloa/forbidden','Goal 续轮不是官方固定候选。')
  const binding=await ports.resolve(candidate)
  const nativeRequestId='goal:'+createHash('sha256').update(JSON.stringify([binding.runId,goal.id,goal.revision,round])).digest('hex')
  const receipt=await ports.reserve({binding,round,messageId:identity.messageId,nativeRequestId,payloadSha256:identity.payloadSha256})
  if(receipt.state!=='reserved')throw new WorkError('teloa/execution-pending','Goal 本轮已有受理或未知结果，请核对原生会话，不能重发。')
  try{
   const lease=await ports.acquire({binding,round})
   const current=lease.assertCurrent,continueCurrent=lease.assertContinuationCurrent??current
   const assertion=()=>{if(agent.session!==session||ctx.agents.get(agent.id)!==agent||ctx.sessions.get(session.id)!==session||nativeInputIdentity(message).payloadSha256!==identity.payloadSha256)throw new WorkError('teloa/forbidden','Goal 会话或固定输入已变化。');invoke(current,lease);invoke(()=>ports.assertCurrent(candidate,binding),ports)}
   const continuation=()=>{if(agent.session!==session||ctx.agents.get(agent.id)!==agent||ctx.sessions.get(session.id)!==session)throw new WorkError('teloa/forbidden','Goal 会话已变化。');invoke(continueCurrent,lease);invoke(()=>ports.assertContinuationCurrent(candidate,binding),ports)}
   await input.withNewInput(agent,message,{producer:'goal',identity:JSON.stringify([binding,round,identity.payloadSha256])},dispatch,undefined,{assertCurrent:assertion,assertContinuationCurrent:continuation})
   const accepted=readSessionEvents(session).find(event=>event.type==='agent/inbox/spliced'&&session.isOwnSeq(event.seq)&&event.data.inserted.length===1&&event.data.inserted[0]?.id===message.id&&nativeInputIdentity(event.data.inserted[0]).payloadSha256===identity.payloadSha256)
   if(!accepted)throw new WorkError('teloa/execution-pending','Goal 原生受理证据尚未可核验。')
   if(!await ctx.sessions.flush(session))throw new WorkError('teloa/unavailable','Goal 原生受理日志尚未持久化，不能确认票据。')
   await ports.confirm({nativeRequestId,acceptedSeq:accepted.seq})
  }catch(error){await ports.unknown(nativeRequestId).catch(()=>{});throw error}
 }
}
