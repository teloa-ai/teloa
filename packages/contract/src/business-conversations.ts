import {WorkError} from './work-error.ts'
import {taskInput} from './tasks.ts'
import {isBusinessScopeKey} from './business-scopes.ts'
export type BusinessConversationKind='builder'|'daily'
export type BusinessConversationReserve={requestId:string;kind:BusinessConversationKind;title:string;workspaceId?:string;scope?:string}
export type BusinessConversationBinding=BusinessConversationReserve&{draftId?:string;sessionId?:string;createdAt:string;updatedAt:string}
export type BusinessConversationList={kind?:BusinessConversationKind;scope?:string;limit:number;cursor?:string}
const invalid=()=>new WorkError('teloa/invalid-input','业务会话请求格式不正确。')
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v)
const scope=(v:unknown):v is string=>isBusinessScopeKey(v)&&v!=='general'
export function readBusinessConversationReserve(input:unknown):BusinessConversationReserve{
 const r=taskInput(input,['requestId','kind','title','workspaceId','scope'])
 if(!uuid(r.requestId)||(r.kind!=='builder'&&r.kind!=='daily')||typeof r.title!=='string'||!r.title.trim()||r.title.length>200||(r.workspaceId!==undefined&&!id(r.workspaceId))||(r.scope!==undefined&&!scope(r.scope))||(r.kind==='daily'&&r.scope===undefined))throw invalid()
 return {requestId:r.requestId,kind:r.kind,title:r.title.trim(),...(r.workspaceId===undefined?{}:{workspaceId:r.workspaceId as string}),...(r.scope===undefined?{}:{scope:r.scope as string})}
}
export function readBusinessConversationRequest(input:unknown):{requestId:string}{
 const r=taskInput(input,['requestId']);if(!uuid(r.requestId))throw invalid();return {requestId:r.requestId}
}
export function readBusinessConversationSession(input:unknown):{sessionId:string}{
 const r=taskInput(input,['sessionId']);if(!id(r.sessionId))throw invalid();return {sessionId:r.sessionId}
}
export function readBusinessConversationBind(input:unknown):{requestId:string;sessionId:string}{
 const r=taskInput(input,['requestId','sessionId'])
 return {...readBusinessConversationRequest({requestId:r.requestId}),...readBusinessConversationSession({sessionId:r.sessionId})}
}
export function readBusinessConversationList(input:unknown):BusinessConversationList{
 const r=taskInput(input,['kind','scope','limit','cursor']),limit=r.limit===undefined?20:r.limit
 if((r.kind!==undefined&&r.kind!=='builder'&&r.kind!=='daily')||(r.scope!==undefined&&!scope(r.scope))||!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>100||(r.cursor!==undefined&&(typeof r.cursor!=='string'||!r.cursor||r.cursor.length>4096)))throw invalid()
 return {limit:Number(limit),...(r.kind===undefined?{}:{kind:r.kind as BusinessConversationKind}),...(r.scope===undefined?{}:{scope:r.scope as string}),...(r.cursor===undefined?{}:{cursor:r.cursor as string})}
}
export function readBusinessConversationRecentDaily(input:unknown):{scope:string}{
 const r=taskInput(input,['scope']);if(!scope(r.scope))throw invalid();return {scope:r.scope}
}

export type BusinessConversationDirectoryItem={binding:BusinessConversationBinding;draft?:{id:string;title:string;scope:string;revision:number;status:'draft'|'applied';updatedAt:string}}
export type BusinessConversationDirectory={items:BusinessConversationDirectoryItem[];nextCursor?:string}
const responseInvalid=()=>new WorkError('teloa/invalid-host-response','业务会话回包身份或格式不一致。')
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v
export function readBusinessConversationBinding(value:unknown):BusinessConversationBinding{
 try{
  const r=taskInput(value,['requestId','kind','title','workspaceId','scope','draftId','sessionId','createdAt','updatedAt'])
  const {draftId,sessionId,createdAt,updatedAt,...request}=r
  const fixed=readBusinessConversationReserve(request)
  if(fixed.title!==r.title||!stamp(createdAt)||!stamp(updatedAt)||updatedAt<createdAt||(draftId!==undefined&&!uuid(draftId))||(sessionId!==undefined&&!id(sessionId))||(fixed.kind==='daily'&&draftId!==undefined)||(fixed.kind==='builder'&&sessionId!==undefined&&draftId===undefined))throw responseInvalid()
  return {...fixed,...(draftId===undefined?{}:{draftId:draftId as string}),...(sessionId===undefined?{}:{sessionId:sessionId as string}),createdAt,updatedAt}
 }catch{throw responseInvalid()}
}
export function readBusinessConversationRecentDailyResponse(value:unknown,expectedScope:string):BusinessConversationBinding|null{
 if(value===null)return null
 const binding=readBusinessConversationBinding(value)
 if(binding.kind!=='daily'||binding.scope!==expectedScope)throw responseInvalid()
 return binding
}
export function readBusinessConversationDirectory(value:unknown):BusinessConversationDirectory{
 try{
  const row=taskInput(value,['items','nextCursor'])
  if(!Array.isArray(row.items)||row.items.length>100||row.nextCursor!==undefined&&(typeof row.nextCursor!=='string'||!row.nextCursor||row.nextCursor.length>4096))throw responseInvalid()
  const items=row.items.map(value=>{
   const r=taskInput(value,['binding','draft']),binding=readBusinessConversationBinding(r.binding)
   if(binding.kind==='builder'&&binding.draftId!==undefined){
    const d=taskInput(r.draft,['id','title','scope','revision','status','updatedAt'])
    if(d.id!==binding.draftId||typeof d.title!=='string'||!d.title.trim()||d.title.length>80||!scope(d.scope)||!Number.isSafeInteger(d.revision)||Number(d.revision)<1||!['draft','applied'].includes(String(d.status))||!stamp(d.updatedAt))throw responseInvalid()
    return {binding,draft:d as NonNullable<BusinessConversationDirectoryItem['draft']>}
   }
   if(r.draft!==undefined)throw responseInvalid()
   return {binding}
  })
  if(new Set(items.map(item=>item.binding.requestId)).size!==items.length)throw responseInvalid()
  return {items,...(row.nextCursor===undefined?{}:{nextCursor:row.nextCursor as string})}
 }catch{throw responseInvalid()}
}
