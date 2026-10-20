import type {DigitalRole} from '@teloa/contract'
import {readSavedRole} from './role-api.js'
export type EmployeeIntegration={id:string;name:string;employeeId:string;employeeVersion:number;scope:string;permissions:('read'|'execute'|'cancel')[];maxConcurrent:number;expiresAt:string;revokedAt:string|null;webhookUrl:string|null;createdAt:string;updatedAt:string}
export type IntegrationIssue={integration:EmployeeIntegration;apiKey:string;signingSecret?:string}
type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v
function exact(v:unknown,keys:string[]):Record<string,any>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw Error('集成服务返回格式不正确。');return v as Record<string,any>}
function integration(v:unknown):EmployeeIntegration{
 const r=exact(v,['id','name','employeeId','employeeVersion','scope','permissions','maxConcurrent','expiresAt','revokedAt','webhookUrl','createdAt','updatedAt'])
 if(!uuid(r.id)||!uuid(r.employeeId)||typeof r.name!=='string'||!r.name.trim()||typeof r.scope!=='string'||!Number.isSafeInteger(r.employeeVersion)||r.employeeVersion<1||!Array.isArray(r.permissions)||!r.permissions.includes('read')||r.permissions.some((p:unknown)=>!['read','execute','cancel'].includes(String(p)))||!Number.isSafeInteger(r.maxConcurrent)||r.maxConcurrent<1||r.maxConcurrent>4||!stamp(r.expiresAt)||r.revokedAt!==null&&!stamp(r.revokedAt)||r.webhookUrl!==null&&typeof r.webhookUrl!=='string'||!stamp(r.createdAt)||!stamp(r.updatedAt))throw Error('集成服务返回格式不正确。')
 return r as EmployeeIntegration
}
function issued(v:unknown):IntegrationIssue{const r=exact(v,['integration','apiKey','signingSecret']);if(typeof r.apiKey!=='string'||!/^teloa_api_[A-Za-z0-9_-]{43}$/.test(r.apiKey)||r.signingSecret!==undefined&&(typeof r.signingSecret!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(r.signingSecret)))throw Error('集成凭据返回格式不正确。');return {integration:integration(r.integration),apiKey:r.apiKey,...r.signingSecret?{signingSecret:r.signingSecret}:{}}}
export type EmployeeIntegrationApi=ReturnType<typeof createEmployeeIntegrationApi>
/** 一次性秘密不进入本机journal、localStorage或通用待恢复请求。 */
export function createEmployeeIntegrationApi(call:Call){return {
 async list():Promise<{items:EmployeeIntegration[];employees:DigitalRole[];scopes:string[]}>{const r=exact(await call('employee-integrations/list',{}),['items','employees','scopes']);if(!Array.isArray(r.items)||!Array.isArray(r.employees)||!Array.isArray(r.scopes)||r.scopes.some((scope:unknown)=>typeof scope!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(scope)))throw Error('集成目录格式不正确。');return {items:r.items.map(integration),employees:r.employees.map(readSavedRole),scopes:r.scopes}},
 async create(input:{name:string;employeeId:string;expectedEmployeeVersion:number;scope:string;permissions:string[];maxConcurrent:number;expiresInDays:number;webhookUrl?:string}){return issued(await call('employee-integrations/create',input))},
 async rotate(id:string){if(!uuid(id))throw Error('集成身份不正确。');return issued(await call('employee-integrations/rotate',{id}))},
 async revoke(id:string){if(!uuid(id))throw Error('集成身份不正确。');return integration(await call('employee-integrations/revoke',{id}))},
 async deliveries(id:string){if(!uuid(id))throw Error('集成身份不正确。');const r=exact(await call('employee-integrations/deliveries',{id}),['items']);if(!Array.isArray(r.items))throw Error('投递记录格式不正确。');return r.items.map(v=>{const row=exact(v,['eventId','attempts','state','nextAt','lastStatus','updatedAt']);if(!uuid(row.eventId)||!Number.isSafeInteger(row.attempts)||row.attempts<0||!['pending','delivered','failed','cancelled'].includes(row.state)||!stamp(row.nextAt)||!stamp(row.updatedAt)||row.lastStatus!==null&&(!Number.isSafeInteger(row.lastStatus)||row.lastStatus<100||row.lastStatus>599))throw Error('投递记录格式不正确。');return row as {eventId:string;attempts:number;state:string;nextAt:string;lastStatus:number|null;updatedAt:string}})},
 async retry(eventId:string){if(!uuid(eventId))throw Error('事件身份不正确。');const r=exact(await call('employee-integrations/retry',{eventId}),['retried']);if(typeof r.retried!=='boolean')throw Error('投递回执格式不正确。');return r as {retried:boolean}},
}}
