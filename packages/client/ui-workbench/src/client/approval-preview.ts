import type { ArtifactRef } from './artifact-preview.js'
import type {MessageKey} from './i18n/messages.js'
import type {TeloaTranslate} from './i18n/index.js'

export const approvalStateKeys={pending:'approvalCard.status.pending',approved:'approvalCard.status.approved',rejected:'approvalCard.status.rejected',changes:'approvalCard.status.changes',stale:'approvalCard.status.stale'} as const
export type LocalizedText=Readonly<{key:MessageKey;params?:Readonly<Record<string,string|number>>}>
export type ApprovalText=string|LocalizedText
export type ApprovalSnapshot={artifact?:ArtifactRef;artifactText?:string;subjectVersion:number;subjectLabel:ApprovalText;title:string;goal:string;object:ApprovalText;result:string;evidence:string[];risk:ApprovalText;effect:ApprovalText}
export type ApprovalRecord={id:string;version:number;status:keyof typeof approvalStateKeys;submittedAt:string;expiresAt:string;snapshot:ApprovalSnapshot;decision?:{kind:'approved'|'rejected'|'changes';actorId:string;note:string;at:string}}
export type ApprovalDecision={approvalId:string;expectedVersion:number;decision:'approved'|'rejected'|'changes';note:string;now:string}

export const localizedText=(key:MessageKey,params?:Readonly<Record<string,string|number>>):LocalizedText=>params?{key,params}:{key}
export const approvalText=(value:ApprovalText,t:TeloaTranslate):string=>typeof value==='string'?value:t(value.key,value.params)
const copyText=(value:ApprovalText):ApprovalText=>typeof value==='string'?value:{key:value.key,...(value.params?{params:{...value.params}}:{})}

export function newApproval(id:string,snapshot:ApprovalSnapshot,now:string):ApprovalRecord{
  return {id,version:1,status:'pending',submittedAt:now,expiresAt:new Date(Date.parse(now)+24*60*60*1000).toISOString(),snapshot:{...snapshot,subjectLabel:copyText(snapshot.subjectLabel),object:copyText(snapshot.object),risk:copyText(snapshot.risk),effect:copyText(snapshot.effect),...(snapshot.artifact?{artifact:{...snapshot.artifact}}:{}),evidence:[...snapshot.evidence]}}
}
const invalid=(code:'teloa/invalid-input'|'teloa/conflict'|'teloa/version-conflict',message:string)=>Object.assign(Error(message),{rejected:true,code})
export function decideApproval<T extends ApprovalRecord>(approval:T,change:ApprovalDecision,subjectVersion:number):T{
  if(approval.id!==change.approvalId||approval.version!==change.expectedVersion)throw invalid('teloa/version-conflict','approval version conflict')
  if(approval.status==='stale'||approval.snapshot.subjectVersion!==subjectVersion)throw invalid('teloa/version-conflict','approval basis is stale')
  if(approval.status!=='pending')throw invalid('teloa/conflict','approval is already decided')
  if(!Number.isFinite(Date.parse(change.now))||Date.parse(change.now)>=Date.parse(approval.expiresAt))throw invalid('teloa/conflict','approval expired or has an invalid timestamp')
  const note=change.note.trim()
  if(!note||note.length>4000)throw invalid('teloa/invalid-input','approval note must contain 1 to 4000 characters')
  return {...approval,version:approval.version+1,status:change.decision,decision:{kind:change.decision,actorId:'self',note,at:change.now}}
}
