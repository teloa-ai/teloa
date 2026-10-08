import {WorkError} from './work-error.ts'
export const workEventKinds=['material-version','group-message','child-completed','approval-result'] as const
export type WorkEvent={schema:'teloa.work-event/v1';id:string;ownerId:string;sourceEventId:string;kind:typeof workEventKinds[number];sourceId:string;sourceVersion:string;createdAt:string}
export const workUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
export const workIdentity=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&v.length<=256&&!/[\x00-\x1f]/.test(v)
export function workObject(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(k=>!keys.includes(k)))throw new WorkError('teloa/invalid-input','长期工作记录字段不完整或包含未知字段。');return value as Record<string,unknown>}
export function workMoment(value:unknown):string{if(typeof value!=='string'||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)throw new WorkError('teloa/invalid-input','长期工作时间格式不正确。');return value}
export function readWorkEvent(value:unknown):WorkEvent{
 const v=workObject(value,['schema','id','ownerId','sourceEventId','kind','sourceId','sourceVersion','createdAt'])
 if(v.schema!=='teloa.work-event/v1'||!workUuid(v.id)||!workIdentity(v.ownerId)||!workIdentity(v.sourceEventId)||!workUuid(v.sourceId)||!workIdentity(v.sourceVersion)||!workEventKinds.includes(v.kind as WorkEvent['kind']))throw new WorkError('teloa/invalid-input','工作事件来源身份或版本不正确。')
 return {...v,createdAt:workMoment(v.createdAt)} as WorkEvent
}
