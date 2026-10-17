import {WorkError} from './work-error.ts'
import {isBusinessScopeKey} from './business-scopes.ts'
import {taskInput} from './tasks.ts'
import {isRecord} from './resources.ts'
export const workEventKinds=['material-version','group-message','child-completed','approval-result'] as const
export const businessWorkEventKinds=['business-object-version','business-sync-result'] as const
export type BusinessWorkSourceRef={kind:'business-object';scope:string;type:string;id:string}|{kind:'business-sync';scope:string;mappingId:string}
type WorkEventIdentity={id:string;ownerId:string;sourceEventId:string;sourceVersion:string;createdAt:string}
export type WorkEventV1=WorkEventIdentity&{schema:'teloa.work-event/v1';kind:typeof workEventKinds[number];sourceId:string}
export type WorkEventV2=WorkEventIdentity&{schema:'teloa.work-event/v2';kind:typeof businessWorkEventKinds[number];sourceRef:BusinessWorkSourceRef;basisHash:string}
export type WorkEvent=WorkEventV1|WorkEventV2
export type RunPlanEventContext={event:WorkEventV2;controlGeneration:number;data:Record<string,unknown>}
export const workUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
export const workIdentity=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&v.length<=256&&!/[\x00-\x1f]/.test(v)
export function workObject(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(k=>!keys.includes(k)))throw new WorkError('teloa/invalid-input','长期工作记录字段不完整或包含未知字段。');return value as Record<string,unknown>}
export function workMoment(value:unknown):string{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new WorkError('teloa/invalid-input','长期工作时间格式不正确。');return value}
export function readBusinessWorkSourceRef(value:unknown):BusinessWorkSourceRef{
 const kind=value&&typeof value==='object'&&'kind'in value?value.kind:undefined
 const v=workObject(value,kind==='business-object'?['kind','scope','type','id']:['kind','scope','mappingId'])
 if(!isBusinessScopeKey(v.scope)||(kind==='business-object'? !workIdentity(v.type)||!workIdentity(v.id):kind!=='business-sync'||!workIdentity(v.mappingId)))throw new WorkError('teloa/invalid-input','业务事件来源不正确。')
 return kind==='business-object'?{kind,scope:v.scope as string,type:v.type as string,id:v.id as string}:{kind:'business-sync',scope:v.scope as string,mappingId:v.mappingId as string}
}
export function businessWorkSourceKey(value:BusinessWorkSourceRef):string{
 const v=readBusinessWorkSourceRef(value)
 return JSON.stringify(v.kind==='business-object'?[v.kind,v.scope,v.type,v.id]:[v.kind,v.scope,v.mappingId])
}
export function readWorkEvent(value:unknown):WorkEvent{
 if(value&&typeof value==='object'&&'schema'in value&&value.schema==='teloa.work-event/v2'){
  const v=workObject(value,['schema','id','ownerId','sourceEventId','kind','sourceRef','sourceVersion','basisHash','createdAt']),sourceRef=readBusinessWorkSourceRef(v.sourceRef)
  if(!workUuid(v.id)||!workIdentity(v.ownerId)||!workIdentity(v.sourceEventId)||!workIdentity(v.sourceVersion)||typeof v.basisHash!=='string'||!/^[a-f0-9]{64}$/.test(v.basisHash)||v.kind!==(sourceRef.kind==='business-object'?'business-object-version':'business-sync-result'))throw new WorkError('teloa/invalid-input','业务事件身份或依据不正确。')
  return {...v,sourceRef,createdAt:workMoment(v.createdAt)} as WorkEventV2
 }
 const v=workObject(value,['schema','id','ownerId','sourceEventId','kind','sourceId','sourceVersion','createdAt'])
 if(v.schema!=='teloa.work-event/v1'||!workUuid(v.id)||!workIdentity(v.ownerId)||!workIdentity(v.sourceEventId)||!workUuid(v.sourceId)||!workIdentity(v.sourceVersion)||!workEventKinds.includes(v.kind as WorkEventV1['kind']))throw new WorkError('teloa/invalid-input','工作事件来源身份或版本不正确。')
 return {...v,createdAt:workMoment(v.createdAt)} as WorkEvent
}

/** 只读业务事件正文是固定依据，不提供新的工具或数据授权。 */
export function readRunPlanEventContext(value:unknown):RunPlanEventContext{
 try{
  const row=taskInput(value,['event','controlGeneration','data']),event=readWorkEvent(row.event)
  if(event.schema!=='teloa.work-event/v2'||!Number.isSafeInteger(row.controlGeneration)||Number(row.controlGeneration)<1||!isRecord(row.data))throw Error()
  const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):isRecord(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>[k,canonical(value)])):v
  return {event:{schema:event.schema,id:event.id,ownerId:event.ownerId,sourceEventId:event.sourceEventId,kind:event.kind,sourceRef:event.sourceRef,sourceVersion:event.sourceVersion,basisHash:event.basisHash,createdAt:event.createdAt},controlGeneration:Number(row.controlGeneration),data:canonical(row.data) as Record<string,unknown>}
 }catch{throw new WorkError('teloa/storage-corrupt','业务事件固定依据损坏。')}
}
