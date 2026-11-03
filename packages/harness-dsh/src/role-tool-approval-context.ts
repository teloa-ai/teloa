import {createHash} from 'node:crypto'
import type {SessionEvent,SessionSeq} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval/types'

export const roleToolApprovalContextName='teloa/role-tool-approval-facts'
type Scope={ownerId:string;sessionId:string;conversationId:string;roleId:string}
type Session={id:string;seq:number;inheritedEventCount:number;isOwnSeq:(seq:SessionSeq)=>boolean}
type Call=Extract<SessionEvent,{type:'tool/call'}>
type Rejection={askedId:string;callId:string;toolName:string;turn:number;step:number;callSeq:number;askedSeq:number;decidedSeq:number;resultSeq:number;operationFingerprint:string}

/** JSON 字段顺序不改变同一次操作的指纹；不声称识别任意脚本的语义等价。 */
function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 if(value!==null&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}'
 if(typeof value==='number'&&!Number.isFinite(value))throw Error('non-finite arguments')
 return JSON.stringify(value)
}

/** 原生同会话的审批事实只读投影。outcome 不证明答复人，不产生执行权限或工具限制。 */
export function roleToolApprovalFacts(events:readonly SessionEvent[],session:Session,scope:Scope){
 const issues=new Set<string>(),rejected:Rejection[]=[]
 const calls=new Map<string,Call[]>(),asked=new Map<string,{call:Call;seq:number;turn:number}>(),decided=new Set<string>()
 const pending=new Map<string,Omit<Rejection,'resultSeq'>>()
 let turn:number|undefined,step:number|undefined
 const result=()=>({schema:'teloa.role-tool-approval-context/v1',...scope,actor:'not-recorded' as const,coverage:issues.size?'unknown' as const:'verified' as const,issues:[...issues].slice(0,8),totalRejected:issues.size?null:rejected.length,truncated:rejected.length>8,rejectedAttempts:rejected.slice(-8),notice:'These are runtime approval outcomes, not proof of who answered. A generic continuation does not reverse a rejected attempt. Do not repeat it or a materially equivalent operation without an explicit owner change. Unrelated work and independently authorized cleanup remain subject to their existing permissions. Unknown or truncated coverage is not evidence of zero approvals or new authorization. No approval or permission is granted by this context.'})
 if(session.id!==scope.sessionId){issues.add('session-mismatch');return result()}
 if(events.length!==session.seq||events.some((event,index)=>event.seq!==index)){issues.add('log-incomplete-or-invalid');return result()}
 const own=events.filter(event=>event.seq>=session.inheritedEventCount&&session.isOwnSeq(event.seq))
 const duplicates=new Set<string>()
 for(const type of ['approval/asked','approval/decided'] as const){const ids=new Set<string>();for(const event of own)if(event.type===type){if(ids.has(event.data.id))duplicates.add(event.data.id);ids.add(event.data.id)}}
 if(duplicates.size)issues.add('duplicate-approval-event')
 for(const event of own){
  if(event.type==='turn/start'){
   if(turn!==undefined)issues.add('overlapping-turns')
   turn=event.data.turn;step=undefined;calls.clear();continue
  }
  if(event.type==='turn/end'){
   if(turn!==event.data.turn)issues.add('turn-mismatch')
   if(pending.size)issues.add('rejected-result-not-observed')
   pending.clear();turn=undefined;step=undefined;calls.clear();continue
  }
  if(event.type==='step/start'){if(turn!==event.data.turn)issues.add('step-outside-owned-turn');else step=event.data.step;continue}
  if(event.type==='step/end'){step=undefined;continue}
  if(event.type==='tool/result'){
   const key=JSON.stringify([event.data.turn,event.data.step,event.data.message.toolCallId]),fact=pending.get(key)
   if(fact){
    pending.delete(key)
    if(fact.decidedSeq>=event.seq||event.data.message.isError!==true||event.data.message.source.kind!=='tool'||event.data.message.source.callId!==fact.callId||!event.sourceEventSeqs?.some(seq=>seq===fact.callSeq))issues.add('rejected-result-unverified')
    else rejected.push({...fact,resultSeq:event.seq})
   }
   continue
  }
  if(event.type==='tool/call'){
   if(turn===undefined||event.data.turn!==turn||event.data.step!==step){issues.add('call-outside-owned-turn');continue}
   const rows=calls.get(event.data.callId)??[];rows.push(event);calls.set(event.data.callId,rows);continue
  }
  if(event.type==='approval/asked'){
   const rows=event.data.callId===undefined?[]:calls.get(event.data.callId)??[]
   if(turn===undefined||duplicates.has(event.data.id)||asked.has(event.data.id)||rows.length!==1||rows[0]!.data.name!==event.data.toolName){issues.add('approval-call-unverified');continue}
   asked.set(event.data.id,{call:rows[0]!,seq:event.seq,turn});continue
  }
  if(event.type!=='approval/decided')continue
  const request=asked.get(event.data.id)
  if(!request||duplicates.has(event.data.id)||decided.has(event.data.id)||turn!==request.turn||step!==request.call.data.step||request.seq>=event.seq){issues.add('approval-decision-unverified');continue}
  decided.add(event.data.id)
  if(!['allowed-once','rejected','cancelled','unavailable'].includes(event.data.outcome)){issues.add('approval-outcome-invalid');continue}
  if(event.data.outcome!=='rejected')continue
  let argumentsText:string
  try{argumentsText=canonical(JSON.parse(request.call.data.arguments))}catch{issues.add('call-arguments-invalid');continue}
  const call=request.call
  const operationFingerprint=createHash('sha256').update(JSON.stringify([scope.ownerId,scope.sessionId,scope.conversationId,scope.roleId,call.data.name,argumentsText])).digest('hex')
  pending.set(JSON.stringify([request.turn,call.data.step,call.data.callId]),{askedId:event.data.id,callId:call.data.callId,toolName:call.data.name,turn:request.turn,step:call.data.step,callSeq:call.seq,askedSeq:request.seq,decidedSeq:event.seq,operationFingerprint})
 }
 if(pending.size)issues.add('rejected-result-not-observed')
 return result()
}
