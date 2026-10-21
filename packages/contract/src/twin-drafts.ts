import {WorkError} from './work-error.ts'

export type TwinDraftSourceInput={kind:'group';groupId:string;messageId:string}|{kind:'conversation';sessionId:string;messageId:string;messageSeq:number}|{kind:'provided';label:string;text:string}
export type TwinDraftSource=TwinDraftSourceInput&{label:string;text:string;bodyHash:string;groupVersion?:number;rootId?:string|null}
export type TwinDraftBasis={id:string;version:number;contentHash:string;title:string}
export type TwinDraft={schema:'teloa.twin-draft/v1';id:string;ownerId:string;roleId:string;roleVersion:number;revision:number;state:'draft'|'returned'|'sent'|'prepared';title:string;body:string;bodyHash:string;source:TwinDraftSource;basis:TwinDraftBasis[];createdAt:string;updatedAt:string;returnReason?:string}
export type TwinDraftCreate={requestId:string;roleId:string;expectedRoleVersion:number;title:string;body:string;source:TwinDraftSourceInput;basis:Array<Pick<TwinDraftBasis,'id'|'version'|'contentHash'>>}
export type TwinDraftCommand={requestId:string;draftId:string;expectedRevision:number;expectedRoleVersion:number;expectedBodyHash:string}
export type TwinDraftRevise=TwinDraftCommand&{body:string}
export type TwinDraftReturn=TwinDraftCommand&{reason:string}
export type TwinDraftReceipt={requestId:string;draftId:string;revision:number;bodyHash:string;decidedAt:string;result:{kind:'group-message';groupId:string;messageId:string;authorId:'self'}|{kind:'conversation-draft';sessionId:string}}
export type TwinDraftAdoption={draft:TwinDraft;receipt:TwinDraftReceipt}
export type TwinDraftDirectory={ownerId:string;roleId:string;roleVersion:number;drafts:TwinDraft[]}
export const twinDraftHumanEndpoints=['twin-drafts/list','twin-drafts/get','twin-drafts/create','twin-drafts/revise','twin-drafts/return','twin-drafts/adopt','twin-drafts/receipt'] as const
export const twinDraftUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const version=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const invalid=():never=>{throw new WorkError('teloa/invalid-input','代拟稿身份、版本或内容格式不正确。')}
export function twinDraftRecord(v:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 if(!v||typeof v!=='object'||Array.isArray(v)||required.some(k=>!Object.hasOwn(v,k))||Object.keys(v).some(k=>![...required,...optional].includes(k)))return invalid()
 return v as Record<string,unknown>
}
function text(v:unknown,max=8000):string{if(typeof v!=='string'||!v.trim()||v.length>max||v.includes('\u0000'))return invalid();return v}
export function readTwinDraftSourceInput(v:unknown):TwinDraftSourceInput{
 if(!v||typeof v!=='object'||!('kind'in v))return invalid()
 if(v.kind==='group'){const r=twinDraftRecord(v,['kind','groupId','messageId']);if(!twinDraftUuid(r.groupId)||!twinDraftUuid(r.messageId))return invalid();return {kind:'group',groupId:r.groupId,messageId:r.messageId}}
 if(v.kind==='conversation'){const r=twinDraftRecord(v,['kind','sessionId','messageId','messageSeq']);if(typeof r.sessionId!=='string'||!r.sessionId.trim()||r.sessionId.length>200||typeof r.messageId!=='string'||!r.messageId||r.messageId.length>200||!Number.isSafeInteger(r.messageSeq)||Number(r.messageSeq)<0)return invalid();return {kind:'conversation',sessionId:r.sessionId,messageId:r.messageId,messageSeq:Number(r.messageSeq)}}
 if(v.kind==='provided'){const r=twinDraftRecord(v,['kind','label','text']);return {kind:'provided',label:text(r.label,200),text:text(r.text,128000)}}
 return invalid()
}
export function readTwinDraftCreate(v:unknown):TwinDraftCreate{
 const r=twinDraftRecord(v,['requestId','roleId','expectedRoleVersion','title','body','source','basis'])
 if(!twinDraftUuid(r.requestId)||!twinDraftUuid(r.roleId)||!version(r.expectedRoleVersion)||!Array.isArray(r.basis)||r.basis.length>30)return invalid()
 const basis=r.basis.map(v=>{const b=twinDraftRecord(v,['id','version','contentHash']);if(!twinDraftUuid(b.id)||!version(b.version)||!digest(b.contentHash))return invalid();return {id:b.id,version:b.version,contentHash:b.contentHash}})
 if(new Set(basis.map(b=>b.id)).size!==basis.length)return invalid()
 return {requestId:r.requestId,roleId:r.roleId,expectedRoleVersion:r.expectedRoleVersion,title:text(r.title,200).trim(),body:text(r.body).trim(),source:readTwinDraftSourceInput(r.source),basis}
}
export function readTwinDraftCommand(v:unknown,extra:'body'|'reason'|null=null):TwinDraftCommand|TwinDraftRevise|TwinDraftReturn{
 const r=twinDraftRecord(v,['requestId','draftId','expectedRevision','expectedRoleVersion','expectedBodyHash',...(extra?[extra]:[])])
 if(!twinDraftUuid(r.requestId)||!twinDraftUuid(r.draftId)||!version(r.expectedRevision)||!version(r.expectedRoleVersion)||!digest(r.expectedBodyHash))return invalid()
 const base={requestId:r.requestId,draftId:r.draftId,expectedRevision:r.expectedRevision,expectedRoleVersion:r.expectedRoleVersion,expectedBodyHash:r.expectedBodyHash}
 return extra==='body'?{...base,body:text(r.body).trim()}:extra==='reason'?{...base,reason:text(r.reason,2000).trim()}:base
}
export function readTwinDraft(v:unknown):TwinDraft{
 const r=twinDraftRecord(v,['schema','id','ownerId','roleId','roleVersion','revision','state','title','body','bodyHash','source','basis','createdAt','updatedAt'],['returnReason'])
 if(r.schema!=='teloa.twin-draft/v1'||!twinDraftUuid(r.id)||typeof r.ownerId!=='string'||!r.ownerId||!twinDraftUuid(r.roleId)||!version(r.roleVersion)||!version(r.revision)||!['draft','returned','sent','prepared'].includes(String(r.state))||!digest(r.bodyHash)||!Array.isArray(r.basis)||r.basis.length>30)return invalid()
 for(const date of [r.createdAt,r.updatedAt])if(typeof date!=='string'||!Number.isFinite(Date.parse(date)))return invalid()
 const source=twinDraftRecord(r.source,['kind','label','text','bodyHash'],['groupId','messageId','groupVersion','rootId','sessionId','messageSeq'])
 const sourceKeys=source.kind==='group'?['kind','label','text','bodyHash','groupId','messageId','groupVersion','rootId']:source.kind==='conversation'?['kind','label','text','bodyHash','sessionId','messageId','messageSeq']:['kind','label','text','bodyHash']
 twinDraftRecord(source,sourceKeys)
 if(!digest(source.bodyHash))return invalid()
 const input=readTwinDraftSourceInput(source.kind==='group'?{kind:source.kind,groupId:source.groupId,messageId:source.messageId}:source.kind==='conversation'?{kind:source.kind,sessionId:source.sessionId,messageId:source.messageId,messageSeq:source.messageSeq}:{kind:source.kind,label:source.label,text:source.text})
 if(input.kind==='group'&&(!version(source.groupVersion)||(source.rootId!==null&&!twinDraftUuid(source.rootId))))return invalid()
 const basis=r.basis.map(v=>{const b=twinDraftRecord(v,['id','version','contentHash','title']);if(!twinDraftUuid(b.id)||!version(b.version)||!digest(b.contentHash))return invalid();return {id:b.id,version:b.version,contentHash:b.contentHash,title:text(b.title,120)}})
 if(new Set(basis.map(b=>b.id)).size!==basis.length||r.state==='returned'&&r.returnReason===undefined||r.returnReason!==undefined&&typeof r.returnReason!=='string')return invalid()
 return {schema:r.schema,id:r.id,ownerId:r.ownerId,roleId:r.roleId,roleVersion:r.roleVersion,revision:r.revision,state:r.state as TwinDraft['state'],title:text(r.title,200),body:text(r.body),bodyHash:r.bodyHash,source:{...input,label:text(source.label,200),text:text(source.text,Number.MAX_SAFE_INTEGER),bodyHash:source.bodyHash,...(input.kind==='group'?{groupVersion:source.groupVersion as number,rootId:source.rootId as string|null}:{})},basis,createdAt:r.createdAt as string,updatedAt:r.updatedAt as string,...(r.returnReason===undefined?{}:{returnReason:text(r.returnReason,2000)})}
}
export function readTwinDraftAdoption(v:unknown):TwinDraftAdoption{
 const r=twinDraftRecord(v,['draft','receipt']),draft=readTwinDraft(r.draft),a=twinDraftRecord(r.receipt,['requestId','draftId','revision','bodyHash','decidedAt','result'])
 if(!twinDraftUuid(a.requestId)||a.draftId!==draft.id||a.revision!==draft.revision||a.bodyHash!==draft.bodyHash||typeof a.decidedAt!=='string'||!Number.isFinite(Date.parse(a.decidedAt)))return invalid()
 const result=twinDraftRecord(a.result,['kind'],['groupId','messageId','authorId','sessionId'])
 if(result.kind==='group-message'){if(Object.keys(result).length!==4||!twinDraftUuid(result.groupId)||!twinDraftUuid(result.messageId)||result.authorId!=='self'||draft.source.kind!=='group'||result.groupId!==draft.source.groupId||draft.state!=='sent')return invalid()}
 else if(result.kind==='conversation-draft'){if(Object.keys(result).length!==2||draft.source.kind!=='conversation'||result.sessionId!==draft.source.sessionId||draft.state!=='prepared')return invalid()}else return invalid()
 return {draft,receipt:{requestId:a.requestId,draftId:draft.id,revision:draft.revision,bodyHash:draft.bodyHash,decidedAt:a.decidedAt,result:result as TwinDraftReceipt['result']}}
}
