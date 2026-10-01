import { isRecord,resourceVersion } from './resources.ts'
export type RecoverableRequest={id:string;text:string;otherContentCount:number}
export type ResourceFailure={endSeq:number;turn:number;at:string;code:string;reason:string;messages:RecoverableRequest[]}
export type ResourceRecoveryPage={sessionId:string;failures:ResourceFailure[];nextBeforeSeq:number|null}
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v)
const seq=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0
export function isResourceRecoveryPage(value:unknown):value is ResourceRecoveryPage{
  if(!isRecord(value)||!id(value.sessionId)||!Array.isArray(value.failures)||value.failures.length>10||!(value.nextBeforeSeq===null||seq(value.nextBeforeSeq)))return false
  let previous=Number.MAX_SAFE_INTEGER
  for(const failure of value.failures){
    if(!isRecord(failure)||!seq(failure.endSeq)||failure.endSeq>=previous||!resourceVersion(failure.turn)||typeof failure.at!=='string'||!Number.isFinite(Date.parse(failure.at))||typeof failure.code!=='string'||!failure.code.startsWith('teloa/resources/')||typeof failure.reason!=='string'||!failure.reason||!Array.isArray(failure.messages)||failure.messages.length===0)return false
    const seen=new Set<string>()
    for(const message of failure.messages){if(!isRecord(message)||!id(message.id)||seen.has(message.id)||typeof message.text!=='string'||!seq(message.otherContentCount))return false;seen.add(message.id)}
    previous=failure.endSeq
  }
  return value.nextBeforeSeq===null||(value.failures.length>0&&value.nextBeforeSeq===previous)
}
