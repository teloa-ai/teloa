import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-tool-jobs'
import {WorkError} from '@teloa/contract'
import {taskRunTeamMessageKey} from './task-run-team-records.ts'

export type TaskRunObservation = {state:'unobserved'}
 | {state:'active';turn:number;messageSeq:number}
 | {state:'ended';turn:number;messageSeq:number;endSeq:number;reason:string}

/** 原请求保持证据锚点；只有官方后台通知可续接，其他人类/插件轮会切断续接资格。 */
export function observeTaskRunTimeline(events:readonly SessionEvent[],requestId:string,teamMessages:ReadonlySet<string>=new Set(),visitOwned?:(event:SessionEvent)=>void):{observation:TaskRunObservation;turn?:number;authorized:boolean}{
 if(!requestId.trim())throw new WorkError('teloa/invalid-input','执行请求身份不能为空。')
 let open:number|undefined,owned=false,foreign=false,lastOwnedTurn:number|undefined
 let result:TaskRunObservation={state:'unobserved'}
 const corrupt=():never=>{throw new WorkError('teloa/storage-corrupt','执行日志不完整或请求重复，请核对原生会话。')}
 for(let index=0;index<events.length;index++){
  const event=events[index]!
  if(event.seq!==index)corrupt()
  if(event.type==='turn/start'){
   if(open!==undefined||!Number.isSafeInteger(event.data.turn)||event.data.turn<0)corrupt()
   open=event.data.turn;owned=false
  }else if(event.type==='turn/end'){
   if(open===undefined||open!==event.data.turn)corrupt()
   if(owned&&result.state==='active'){
    const reason=event.data.reason.kind
    if(typeof reason!=='string'||!reason.trim())corrupt()
    result={state:'ended',turn:result.turn,messageSeq:result.messageSeq,endSeq:event.seq,reason}
   }
   open=undefined;owned=false
  }else if(event.type==='user/message'&&event.surfaceOp==='append'){
   const source=event.data.source
   if(source.kind==='user'&&'rpcId' in source&&source.rpcId===requestId){
    if(open===undefined||result.state!=='unobserved')corrupt()
    result={state:'active',turn:open!,messageSeq:event.seq};owned=true;lastOwnedTurn=open
   }else if(result.state!=='unobserved'){
    if((source.kind==='tool-jobs'||teamMessages.has(taskRunTeamMessageKey(event)??''))&&!foreign&&open!==undefined&&(result.state==='active'||result.reason==='completed')){
     result={state:'active',turn:result.turn,messageSeq:result.messageSeq};owned=true;lastOwnedTurn=open
    }else if(source.kind==='user'||!owned){
     foreign=true
    }
   }
  }
  if(owned&&!foreign)visitOwned?.(event)
 }
 return {observation:result,authorized:owned&&!foreign,...(lastOwnedTurn===undefined?{}:{turn:lastOwnedTurn})}
}

/** 读取完整原生日志；终轮仅代表执行收口候选，后台工作由官方服务另行核验。 */
export function observeTaskRun(events:readonly SessionEvent[],requestId:string,teamMessages?:ReadonlySet<string>):TaskRunObservation{
 return observeTaskRunTimeline(events,requestId,teamMessages).observation
}

export type StopFreeze={seq:number;since:number}
/**
 * H-C 的收口判据。上游文档写明：取消落在已无活跃活动的 agent 上是 no-op，于是原生 `turn/end`
 * 永远不会来，只等日志是等不到终态的。此时唯一诚实的依据是宿主自己的读数——它自报不在运行，
 * 并且原生日志 `seq` 自上次观察起一动不动、已经持续够久。
 *
 * 返回冻结到的那个 `seq`：它就是收口依据本身，会作为 `evidence.endSeq` 落库，配合记录上的
 * `stopRequestedAt`，「凭哪个 seq、何时收的口」都留得下来。仍在运行、或 `seq` 还在增长，
 * 一律返回 null 并把计时重新开始——这条判据只认「已经不动了」，不猜、更不替原生宣布终态。
 */
export function settledStopSeq(memory:Map<string,StopFreeze>,runId:string,running:boolean,lastSeq:number,now:number,holdMs=3000):number|null{
 if(running||!Number.isSafeInteger(lastSeq)||lastSeq<0){memory.delete(runId);return null}
 const mark=memory.get(runId)
 if(!mark||mark.seq!==lastSeq){memory.set(runId,{seq:lastSeq,since:now});return null}
 if(now-mark.since<holdMs)return null
 // 收口之后这条记录就离开待观察目录了，冻结表不必替它继续长住。
 memory.delete(runId)
 return lastSeq
}
