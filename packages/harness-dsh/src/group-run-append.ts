import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {groupRunAppendRequestId} from '@teloa/contract'
import type {GroupWorkInputRecord,GroupWorkInputService} from '@teloa/backend'

/** 追加正文前的固定说明：这是本人对同一工作的补充，不扩大原 Run 已冻结的工具、资料或负责人范围。 */
export const groupRunAppendNotice='本人在原群对你正在处理的这项工作追加了要求。原任务目标、原文中的全部限制与已授权范围不变；只按下面的补充调整本次交付，需要新的资料、工具或敏感动作时说明后等待本人处理。本人追加：'

export type GroupRunAppendPorts={
 settle:Pick<GroupWorkInputService,'settle'>['settle']
 /** 仍在原生处理中的原 Run 与追加正文；带新资料或原 Run 已收敛时为 null（改走收敛后的新版本续办）。 */
 target:(owner:string,requestId:string)=>Promise<{runId:string;sessionId:string;text:string}|null>
 /** 原 Run 会话的完整原生日志。 */
 events:(sessionId:string)=>Promise<readonly SessionEvent[]>
 run:(owner:string,runId:string,signal:AbortSignal)=>Promise<{state:string;sessionId:string}>
 /**
  * 经官方会话控制器以 queue 模式把一条带固定 rpcId 的用户消息排入原 Run 会话：
  * 它与本人普通追问走同一原生输入准入（运行许可、工作控制 new-input 票据、宿主常驻准入），不绕过守卫、不另起模型循环。
  */
 submit:(sessionId:string,nativeRequestId:string,text:string,signal:AbortSignal)=>Promise<void>
}

/** 原生受理证据：官方 Inbox 把这条用户消息拼入轮次（agent/inbox/spliced）或已追加为 user/message 的那个序号。 */
export function groupRunAppendAcceptedSeq(events:readonly SessionEvent[],nativeRequestId:string):number|null{
 const owns=(message:unknown)=>{const source=(message as {source?:Record<string,unknown>})?.source;return source?.kind==='user'&&source.rpcId===nativeRequestId}
 for(const event of events){
  if(event.type==='agent/inbox/spliced'&&(event.data as {inserted?:unknown[]}).inserted?.some(owns))return event.seq
  if(event.type==='user/message'&&event.surfaceOp==='append'&&owns(event.data))return event.seq
 }
 return null
}

/**
 * 活动 Run 即时追加（规格 §4.4 / C1）。登记→提交→核实分三步，每步可恢复：
 * 1. 提交前先把原 Run 身份与派生原生请求身份持久写进回执（unknown），崩溃后不会换身份重发；
 * 2. 经原生 queue 准入排入原会话；
 * 3. 只在原生日志里出现同一 rpcId 的受理证据后写 accepted 与实际接受序号。
 * 回执已带原生身份时只核对日志，绝不再次提交；原 Run 已收敛而日志里没有它，返回 absent 交给新版本续办。
 */
export async function deliverGroupRunAppend(owner:string,item:GroupWorkInputRecord,ports:GroupRunAppendPorts,signal:AbortSignal):Promise<'accepted'|'pending'|'absent'|'skipped'>{
 if(item.operation!=='continue'||item.versioned)return 'skipped'
 if(item.nativeRequestId&&item.runId){
  // 先读原 Run 状态再读日志：若读到已收敛，其日志已经完整，日志里没有这条才能断定未受理。
  const run=await ports.run(owner,item.runId,signal)
  const seq=groupRunAppendAcceptedSeq(await ports.events(run.sessionId),item.nativeRequestId)
  if(seq!==null){await ports.settle(owner,{requestId:item.requestId,state:'accepted',runId:item.runId,nativeRequestId:item.nativeRequestId,acceptedSeq:seq,reason:null});return 'accepted'}
  return ['ended','withdrawn','configuration_failed'].includes(run.state)?'absent':'pending'
 }
 if(item.state!=='reserved')return 'skipped'
 const target=await ports.target(owner,item.requestId)
 if(!target)return 'skipped'
 const nativeRequestId=groupRunAppendRequestId(owner,item.requestId)
 const bound=await ports.settle(owner,{requestId:item.requestId,state:'unknown',runId:target.runId,nativeRequestId,reason:'teloa/execution-pending'})
 if(bound.nativeRequestId!==nativeRequestId||bound.runId!==target.runId)return 'pending'
 signal.throwIfAborted()
 await ports.submit(target.sessionId,nativeRequestId,groupRunAppendNotice+'\n'+target.text,signal)
 const seq=groupRunAppendAcceptedSeq(await ports.events(target.sessionId),nativeRequestId)
 if(seq===null)return 'pending'
 await ports.settle(owner,{requestId:item.requestId,state:'accepted',runId:target.runId,nativeRequestId,acceptedSeq:seq,reason:null})
 return 'accepted'
}

/** 原 Run 会话里仍待本人决定的原生审批：官方 approval/asked 之后尚无同 id 的 approval/decided。 */
export function groupRunAwaitsApproval(events:readonly SessionEvent[]):boolean{
 const open=new Set<unknown>()
 for(const event of events){
  const id=(event.data as {id?:unknown}|undefined)?.id
  if(event.type==='approval/asked')open.add(id)
  else if(event.type==='approval/decided')open.delete(id)
 }
 return open.size>0
}
