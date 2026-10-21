import {WorkError} from './work-error.ts'
import {readBusinessConfigurationCandidateV2,type BusinessConfigurationCandidateV2} from './business-configuration-v2.ts'
import {isRecord} from './resources.ts'
import {roleDefinition,type RoleResponsibility} from './roles.ts'
import {readBusinessConfigurationApplyResult,type BusinessConfigurationApplyResult} from './business-configuration-page.ts'

export type BusinessSetupRoleEdit={roleId:string;expectedVersion:number;duty:string;responsibility:RoleResponsibility}
export type BusinessSetupResource={id:string;kind:string;title:string;version:string;description:string}
export type BusinessSetupChange={id:string;entity:'field'|'definition'|'page'|'business'|'role';label:string;before:unknown;after:unknown}
export type BusinessSetupStep={id:string;kind:string;title:string;state:'pending'|'done'|'needs-user'|'failed';objectId?:string;code?:string}
export type BusinessSetupAdoption={requestId:string;configuration:BusinessConfigurationApplyResult;roleIds:string[];contentId:string;contentHash:string;loadId?:string;steps:BusinessSetupStep[];preparation?:{digest:string;state:'unknown'|'finished';code?:string}}
export type BusinessSetupPlan={format:'teloa.business-setup-plan/v1';draftId:string;scope:string;revision:number;configurationRevision:number;configurationHash:string;contentId:string;contentHash:string;title:string;description:string;resources:BusinessSetupResource[];roleEdits:BusinessSetupRoleEdit[];roleNames?:Record<string,string>;rejected:string[];state:'draft'|'applied';updatedAt:string;adoption?:BusinessSetupAdoption}
export type BusinessSetupPreview={draftId:string;revision:number;digest:string;receipt:string;configurationReceipt:string;configurationRevision:number;baseVersion:number;changes:BusinessSetupChange[];rejected:string[];blocked:boolean}
export type BusinessSetupPackage={manifestPath:string;files:{path:string;text:string}[]}
const bad=()=>new WorkError('teloa/invalid-input','业务方案格式不正确或包含未知字段。')
export const businessSetupUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
const exact=(v:unknown,keys:readonly string[])=>{if(!isRecord(v)||Object.keys(v).some(k=>!keys.includes(k)))throw bad();return v}
const text=(v:unknown,max:number):string=>{if(typeof v!=='string'||!v.trim()||v.length>max)throw bad();return v}
export function readBusinessSetupRoleEdit(v:unknown):BusinessSetupRoleEdit{
 const r=exact(v,['roleId','expectedVersion','duty','responsibility'])
 if(!businessSetupUuid(r.roleId)||!positive(r.expectedVersion))throw bad()
 const role=roleDefinition({name:'岗位',kind:'employee',scopes:['placeholder'],duty:r.duty,responsibility:r.responsibility,dataScope:'保持既有范围',executionScope:'保持既有权限',skills:[],knowledge:[]})
 if(!role.responsibility)throw bad()
 return {roleId:r.roleId.toLowerCase(),expectedVersion:r.expectedVersion,duty:role.duty,responsibility:role.responsibility}
}
export function readBusinessSetupPackage(v:unknown):BusinessSetupPackage{
 const r=exact(v,['manifestPath','files']),safe=(x:unknown)=>{const p=text(x,300);if(p.startsWith('/')||p.split('/').some(s=>!s||s==='.'||s==='..')||/[\\:?%#\u0000-\u001f]/.test(p))throw bad();return p}
 if(!Array.isArray(r.files)||!r.files.length||r.files.length>500)throw bad()
 let size=0
 const files=r.files.map(v=>{const f=exact(v,['path','text']);if(typeof f.text!=='string')throw bad();size+=new TextEncoder().encode(f.text).length;if(size>2*1024*1024)throw bad();return {path:safe(f.path),text:f.text}})
 if(new Set(files.map(f=>f.path)).size!==files.length)throw bad()
 const manifestPath=safe(r.manifestPath);if(!files.some(f=>f.path===manifestPath))throw bad()
 return {manifestPath,files}
}
export function readBusinessSetupAdoption(v:unknown):BusinessSetupAdoption{
 const r=exact(v,['requestId','configuration','roleIds','contentId','contentHash','loadId','steps','preparation'])
 if(!businessSetupUuid(r.requestId)||!businessSetupUuid(r.contentId)||!hash(r.contentHash)||r.loadId!==undefined&&!businessSetupUuid(r.loadId)||!Array.isArray(r.roleIds)||r.roleIds.some(id=>!businessSetupUuid(id))||!Array.isArray(r.steps)||r.steps.length>1000)throw bad()
 const steps=r.steps.map(v=>{const s=exact(v,['id','kind','title','state','objectId','code']);if(!['pending','done','needs-user','failed'].includes(String(s.state))||s.objectId!==undefined&&typeof s.objectId!=='string'||s.code!==undefined&&typeof s.code!=='string')throw bad();return {id:text(s.id,200),kind:text(s.kind,80),title:text(s.title,200),state:s.state,...(s.objectId?{objectId:s.objectId}:{}),...(s.code?{code:s.code}:{})} as BusinessSetupStep})
 if(r.preparation!==undefined){const p=exact(r.preparation,['digest','state','code']);if(!hash(p.digest)||!['unknown','finished'].includes(String(p.state))||p.code!==undefined&&(typeof p.code!=='string'||!/^teloa\/[a-z0-9-]+$/.test(p.code)))throw bad()}
 return {...r,configuration:readBusinessConfigurationApplyResult(r.configuration),steps} as BusinessSetupAdoption
}
export function readBusinessSetupPlan(v:unknown):BusinessSetupPlan{
 const r=exact(v,['format','draftId','scope','revision','configurationRevision','configurationHash','contentId','contentHash','title','description','resources','roleEdits','roleNames','rejected','state','updatedAt','adoption'])
 if(r.format!=='teloa.business-setup-plan/v1'||!businessSetupUuid(r.draftId)||!positive(r.revision)||!positive(r.configurationRevision)||!hash(r.configurationHash)||!businessSetupUuid(r.contentId)||!hash(r.contentHash)||!Array.isArray(r.resources)||r.resources.length>500||!Array.isArray(r.roleEdits)||r.roleEdits.length>100||!Array.isArray(r.rejected)||r.rejected.some(x=>typeof x!=='string'||x.length>250)||!['draft','applied'].includes(String(r.state))||typeof r.updatedAt!=='string'||!Number.isFinite(Date.parse(r.updatedAt)))throw bad()
 const resources=r.resources.map(v=>{const s=exact(v,['id','kind','title','version','description']);return {id:text(s.id,120),kind:text(s.kind,80),title:text(s.title,120),version:text(s.version,80),description:typeof s.description==='string'&&s.description.length<=8000?s.description:(()=>{throw bad()})()}})
 const roleEdits=r.roleEdits.map(readBusinessSetupRoleEdit)
 if(r.roleNames!==undefined&&(!isRecord(r.roleNames)||Object.entries(r.roleNames).some(([id,name])=>!roleEdits.some(e=>e.roleId===id)||typeof name!=='string'||!name.trim()||name.length>80)))throw bad()
 if(new Set(resources.map(s=>s.id)).size!==resources.length||new Set(roleEdits.map(s=>s.roleId)).size!==roleEdits.length)throw bad()
 return {...r,scope:text(r.scope,64),title:text(r.title,120),description:text(r.description,2000),resources,roleEdits,...(r.adoption?{adoption:readBusinessSetupAdoption(r.adoption)}:{})} as BusinessSetupPlan
}
export function readBusinessSetupPreview(v:unknown):BusinessSetupPreview{
 const r=exact(v,['draftId','revision','digest','receipt','configurationReceipt','configurationRevision','baseVersion','changes','rejected','blocked'])
 if(!businessSetupUuid(r.draftId)||!positive(r.revision)||!hash(r.digest)||!hash(r.receipt)||!hash(r.configurationReceipt)||!positive(r.configurationRevision)||!Number.isSafeInteger(r.baseVersion)||Number(r.baseVersion)<0||!Array.isArray(r.changes)||r.changes.length>2000||!Array.isArray(r.rejected)||r.rejected.some(id=>typeof id!=='string')||typeof r.blocked!=='boolean')throw bad()
 const changes=r.changes.map(v=>{const c=exact(v,['id','entity','label','before','after']);if(!['field','definition','page','business','role'].includes(String(c.entity)))throw bad();return {...c,id:text(c.id,250),label:text(c.label,500)} as BusinessSetupChange})
 return {...r,changes} as BusinessSetupPreview
}

export type BusinessSetupManual={draftId:string;revision:number;configurationRevision:number;configurationHash:string;candidate:BusinessConfigurationCandidateV2;description:string;roleEdits:BusinessSetupRoleEdit[];employees:{roleId:string;expectedVersion:number;name:string;duty:string;responsibility:RoleResponsibility;state:'active'|'paused'}[]}
export function readBusinessSetupManual(value:unknown):BusinessSetupManual{
 const r=exact(value,['draftId','revision','configurationRevision','configurationHash','candidate','description','roleEdits','employees'])
 if(!businessSetupUuid(r.draftId)||!Number.isSafeInteger(r.revision)||Number(r.revision)<0||!positive(r.configurationRevision)||!hash(r.configurationHash)||!Array.isArray(r.roleEdits)||r.roleEdits.length>100||!Array.isArray(r.employees)||r.employees.length>100)throw bad()
 const employees=r.employees.map(value=>{const e=exact(value,['roleId','expectedVersion','name','duty','responsibility','state']),edit=readBusinessSetupRoleEdit({roleId:e.roleId,expectedVersion:e.expectedVersion,duty:e.duty,responsibility:e.responsibility});if(!['active','paused'].includes(String(e.state)))throw bad();return {...edit,name:text(e.name,80),state:e.state} as BusinessSetupManual['employees'][number]})
 const roleEdits=r.roleEdits.map(readBusinessSetupRoleEdit)
 if(new Set(employees.map(e=>e.roleId)).size!==employees.length||new Set(roleEdits.map(e=>e.roleId)).size!==roleEdits.length||roleEdits.some(edit=>!employees.some(e=>e.roleId===edit.roleId&&e.expectedVersion===edit.expectedVersion)))throw bad()
 return {...r,candidate:readBusinessConfigurationCandidateV2(r.candidate),description:text(r.description,2000),employees,roleEdits} as BusinessSetupManual
}

export type BusinessSetupHistory={scope:string;currentVersion:number;items:{version:number;hash:string;title:string;pages:number;createdAt:string}[];beforeVersion:number|null}
export function readBusinessSetupHistory(value:unknown):BusinessSetupHistory{
 const r=exact(value,['scope','currentVersion','items','beforeVersion'])
 if(typeof r.scope!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(r.scope)||r.scope==='general'||!positive(r.currentVersion)||!Array.isArray(r.items)||r.items.length>25||r.beforeVersion!==null&&!positive(r.beforeVersion))throw bad()
 const items=r.items.map(value=>{const row=exact(value,['version','hash','title','pages','createdAt']);if(!positive(row.version)||Number(row.version)>Number(r.currentVersion)||!hash(row.hash)||!Number.isSafeInteger(row.pages)||Number(row.pages)<0||Number(row.pages)>24||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt)))throw bad();return {...row,title:text(row.title,120)} as BusinessSetupHistory['items'][number]})
 if(items.some((row,i)=>i>0&&row.version>=items[i-1]!.version)||r.beforeVersion!==null&&r.beforeVersion!==items.at(-1)?.version)throw bad()
 return {...r,items} as BusinessSetupHistory
}
