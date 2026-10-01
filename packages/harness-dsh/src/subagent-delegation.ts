import {createHash} from 'node:crypto'

export type SubagentDelegationLimits={maxDepth:number;maxPerRun:number}

export const defaultSubagentDelegationLimits:SubagentDelegationLimits=Object.freeze({maxDepth:1,maxPerRun:6})

function limit(value:string|undefined,name:string,min:number,max:number,fallback:number):number{
 if(value===undefined)return fallback
 if(!/^(?:0|[1-9][0-9]*)$/.test(value)){throw new Error(name+' 必须是 '+min+'–'+max+' 的整数。')}
 const parsed=Number(value)
 if(!Number.isSafeInteger(parsed)||parsed<min||parsed>max)throw new Error(name+' 必须是 '+min+'–'+max+' 的整数。')
 return parsed
}

/** 配置错误在宿主装配期显式失败，避免把操作者写下的限制悄悄换成默认值。 */
export function readSubagentDelegationLimits(env:Record<string,string|undefined>):SubagentDelegationLimits{
 return Object.freeze({
  maxDepth:limit(env.TELOA_SUBAGENT_MAX_DEPTH,'TELOA_SUBAGENT_MAX_DEPTH',0,3,defaultSubagentDelegationLimits.maxDepth),
  maxPerRun:limit(env.TELOA_SUBAGENT_MAX_PER_RUN,'TELOA_SUBAGENT_MAX_PER_RUN',1,32,defaultSubagentDelegationLimits.maxPerRun),
 })
}

/** 只取会话与调用身份，重试同一次原生工具调用才能复用同一条预留。 */
export function subagentReservationId(runSessionId:string,callId:string):string{
 return 'call:'+createHash('sha256').update(JSON.stringify([runSessionId,callId])).digest('hex')
}

export type SubagentDelegationPorts={
 limits:SubagentDelegationLimits
 list?:(runId:string)=>Promise<readonly {reservationId:string;state:'reserved'|'started'|'ended'|'abandoned';childSessionId?:string;depth?:number}[]>
 runId:(sessionId:string,signal:AbortSignal)=>Promise<string|undefined>
 reserve:(input:{runId:string;reservationId:string;limit:number})=>Promise<void>
 release:(input:{reservationId:string})=>Promise<void>
 bind:(input:{reservationId:string;childSessionId:string;depth:number})=>Promise<void>
 settle:(input:{childSessionId:string;stopReason:string;tokenEstimate?:number})=>Promise<void>
 abandon:(input:{reservationId:string;childSessionId:string;depth:number;stopReason:string})=>Promise<void>
}
