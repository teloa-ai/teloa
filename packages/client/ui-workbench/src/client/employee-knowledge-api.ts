import {isEmployeeKnowledgeContent,isEmployeeKnowledgeDocument,isEmployeeKnowledgeRevision,isEmployeeKnowledgeVersion,type EmployeeKnowledgeContent,type EmployeeKnowledgeDocument,type EmployeeKnowledgeRevision,type EmployeeKnowledgeReviseInput,type EmployeeKnowledgeRestoreInput,type EmployeeKnowledgeTarget,type EmployeeKnowledgeVersion} from '@teloa/contract'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'

export type EmployeeKnowledgeCommand={kind:'revise';input:EmployeeKnowledgeReviseInput}|{kind:'restore';input:EmployeeKnowledgeRestoreInput}
export type EmployeeKnowledgeDraft={ownerId:string;roleId:string;resourceId:string;base:EmployeeKnowledgeContent;markdown:string;requestId:string;pending?:EmployeeKnowledgeCommand}
type Call=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>
const invalid=()=>Object.assign(Error('员工知识服务返回的内容格式不正确。'),{code:'teloa/invalid-host-response'})
const sameTarget=(document:EmployeeKnowledgeDocument,target:EmployeeKnowledgeTarget)=>document.roleId===target.roleId&&document.resourceId===target.resourceId
const checkedContent=async(value:unknown,target?:EmployeeKnowledgeTarget)=>{
 if(!isEmployeeKnowledgeContent(value)||target&&!sameTarget(value,target))throw invalid()
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value.markdown))),byte=>byte.toString(16).padStart(2,'0')).join('')
 if(digest!==value.contentHash)throw invalid()
 return value
}
export type EmployeeKnowledgeApi=ReturnType<typeof createEmployeeKnowledgeApi>
export function createEmployeeKnowledgeApi(call:Call,storage?:WorkbenchNavigationStorage){
 const drafts=new Map<string,EmployeeKnowledgeDraft|null>();let storageWarning=!storage
 const key=(ownerId:string,target:EmployeeKnowledgeTarget)=>'teloa.employee-knowledge-edit/v1/'+[ownerId,target.roleId,target.resourceId].map(encodeURIComponent).join('/')
 const revision=async(value:unknown,requestId:string,target?:EmployeeKnowledgeTarget)=>{
  if(!isEmployeeKnowledgeRevision(value)||value.requestId!==requestId)throw invalid()
  await checkedContent(value.document,target);return value
 }
 return {
  async list(roleId:string,options?:{requireReady:true}):Promise<EmployeeKnowledgeDocument[]>{const value=await call('employee-knowledge/list',{roleId,...options});if(!Array.isArray(value)||!value.every(row=>isEmployeeKnowledgeDocument(row)&&row.roleId===roleId)||new Set(value.map(row=>row.resourceId)).size!==value.length)throw invalid();return value},
  async read(target:EmployeeKnowledgeTarget&{version?:number}):Promise<EmployeeKnowledgeContent>{const value=await checkedContent(await call('employee-knowledge/read',target),target);if(target.version!==undefined&&value.bodyVersion!==target.version)throw invalid();return value},
  async versions(target:EmployeeKnowledgeTarget):Promise<EmployeeKnowledgeVersion[]>{const value=await call('employee-knowledge/versions',target);if(!Array.isArray(value)||!value.every(isEmployeeKnowledgeVersion)||new Set(value.map(row=>row.version)).size!==value.length)throw invalid();return value},
  async revise(input:EmployeeKnowledgeReviseInput){const value=await revision(await call('employee-knowledge/revise',input),input.requestId,input);if(value.operation!=='revise'||value.document.bodyVersion!==input.expectedBodyVersion+1||value.document.markdown!==input.markdown.replace(/^\ufeff/,'').replace(/\r\n?/g,'\n'))throw invalid();return value},
  async restore(input:EmployeeKnowledgeRestoreInput){const value=await revision(await call('employee-knowledge/restore',input),input.requestId,input);if(value.operation!=='restore'||value.document.bodyVersion!==input.expectedBodyVersion+1)throw invalid();return value},
  async status(requestId:string,target:EmployeeKnowledgeTarget):Promise<EmployeeKnowledgeRevision|null>{const value=await call('employee-knowledge/status',{requestId});return value===null?null:revision(value,requestId,target)},
  draft(ownerId:string,target:EmployeeKnowledgeTarget){
   const id=key(ownerId,target)
   const read=():EmployeeKnowledgeDraft|undefined=>{
    if(drafts.has(id))return drafts.get(id)??undefined
    const raw=storage?.getItem(id);if(!raw)return undefined
    const value:unknown=JSON.parse(raw)
    if(!value||typeof value!=='object')throw invalid()
    const row=value as EmployeeKnowledgeDraft&{schema?:unknown}
    if(row.schema!=='teloa.employee-knowledge-edit/v1'||row.ownerId!==ownerId||row.roleId!==target.roleId||row.resourceId!==target.resourceId||!isEmployeeKnowledgeContent(row.base)||!sameTarget(row.base,target)||row.base.resource.ownerId!==ownerId||typeof row.markdown!=='string'||new TextEncoder().encode(row.markdown).byteLength>2*1024*1024||typeof row.requestId!=='string'||!row.requestId)throw invalid()
    if(row.pending){const {kind,input}=row.pending;if(!['revise','restore'].includes(kind)||!input||input.requestId!==row.requestId||input.roleId!==target.roleId||input.resourceId!==target.resourceId||input.expectedBodyVersion!==row.base.bodyVersion||input.expectedContentHash!==row.base.contentHash||kind==='revise'&&(!('markdown'in input)||input.markdown!==row.markdown)||kind==='restore'&&(!('restoreVersion'in input)||!Number.isSafeInteger(input.restoreVersion)||input.restoreVersion<1||input.restoreVersion>row.base.bodyVersion))throw invalid()}
    const {schema:_schema,...draft}=row;drafts.set(id,draft);return draft
   }
   return {
    read,
    write(value:EmployeeKnowledgeDraft){drafts.set(id,value);try{storage?.setItem(id,JSON.stringify({schema:'teloa.employee-knowledge-edit/v1',...value}))}catch{storageWarning=true}},
    clear(requestId:string){if(read()?.requestId!==requestId)return;drafts.set(id,null);try{storage?.removeItem(id)}catch{storageWarning=true}},
    warning:()=>storageWarning,
   }
  },
 }
}
