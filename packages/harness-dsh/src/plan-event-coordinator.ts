import type {WorkEvent} from '@teloa/contract'
import type {PlanOccurrence} from '@teloa/backend'
export type PlanEventPorts={
 events:{pending:(owner:string)=>Promise<{event:WorkEvent;planId:string;definitionVersion:number;controlGeneration:number}[]>;claim:(owner:string,input:{planId:string;definitionVersion:number;eventId:string;controlGeneration:number})=>Promise<PlanOccurrence|null>}
 dispatch:(owner:string,occurrence:PlanOccurrence,signal:AbortSignal)=>Promise<void>
 report?:(eventId:string,code:string)=>void
}
/** 持久事件先领取再复用原 Task/Run 派发；恢复由原 pending occurrence/execution 协调器处理。 */
export async function dispatchPlanEvent(owner:string,eventId:string,ports:PlanEventPorts,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();const pending=await ports.events.pending(owner)
 for(const row of pending){if(row.event.id!==eventId)continue;signal.throwIfAborted();const occurrence=await ports.events.claim(owner,{planId:row.planId,definitionVersion:row.definitionVersion,eventId,controlGeneration:row.controlGeneration});if(occurrence){signal.throwIfAborted();await ports.dispatch(owner,occurrence,signal)}}
}
export async function dispatchPendingPlanEvents(owner:string,ports:PlanEventPorts,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();const pending=await ports.events.pending(owner)
 for(const row of pending){signal.throwIfAborted();try{const occurrence=await ports.events.claim(owner,{planId:row.planId,definitionVersion:row.definitionVersion,eventId:row.event.id,controlGeneration:row.controlGeneration});if(occurrence){signal.throwIfAborted();await ports.dispatch(owner,occurrence,signal)}}catch(error){ports.report?.(row.event.id,error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:'teloa/unavailable')}}
}
