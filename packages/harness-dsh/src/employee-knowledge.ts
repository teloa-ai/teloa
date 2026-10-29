import {WorkError,isEmployeeKnowledgeDocument,isEmployeeKnowledgeContent,isEmployeeKnowledgeVersion,isEmployeeKnowledgeRevision,resourceId,resourceVersion,taskInput,promptFullTextMaxBytes,type EmployeeKnowledgeDocument,type EmployeeKnowledgeContent,type EmployeeKnowledgeVersion,type EmployeeKnowledgeRevision,type DigitalRole} from '@teloa/contract'
import type {ResourceActor} from '@teloa/backend'

export const employeeKnowledgeEndpoints=['employee-knowledge/list','employee-knowledge/read','employee-knowledge/versions','employee-knowledge/revise','employee-knowledge/restore','employee-knowledge/status'] as const
export type EmployeeKnowledgeEndpoint=typeof employeeKnowledgeEndpoints[number]
export type EmployeeKnowledgeServicePort={
 list(actor:ResourceActor,input:unknown):Promise<EmployeeKnowledgeDocument[]>
 read(actor:ResourceActor,input:unknown):Promise<EmployeeKnowledgeContent>
 versions(actor:ResourceActor,input:unknown):Promise<EmployeeKnowledgeVersion[]>
 revise(actor:ResourceActor,input:unknown):Promise<EmployeeKnowledgeRevision>
 restore(actor:ResourceActor,input:unknown):Promise<EmployeeKnowledgeRevision>
 status(actor:ResourceActor,input:unknown):Promise<EmployeeKnowledgeRevision|null>
}
const invalid=()=>new WorkError('teloa/invalid-input','员工知识参数不正确或包含未知字段。')
const corrupt=()=>new WorkError('teloa/invalid-host-response','员工知识服务返回的身份、版本或正文不一致。')
export function employeeKnowledgeInput(operation:string,input:unknown):Record<string,unknown>{
 const keys=operation==='list'?['roleId','requireReady']:operation==='status'?['requestId']:operation==='read'?['roleId','resourceId','version']:operation==='versions'?['roleId','resourceId']:operation==='revise'?['requestId','roleId','resourceId','expectedBodyVersion','expectedContentHash','markdown']:operation==='restore'?['requestId','roleId','resourceId','expectedBodyVersion','expectedContentHash','restoreVersion']:undefined
 if(!keys)throw invalid()
 const row={...taskInput(input,keys)}
 for(const key of keys){
  if(key==='version'&&row[key]===undefined)continue
  if(['roleId','resourceId','requestId'].includes(key)){if(!resourceId(row[key]))throw invalid();row[key]=(row[key] as string).toLowerCase()}
  else if(['version','expectedBodyVersion','restoreVersion'].includes(key)){if(!resourceVersion(row[key]))throw invalid()}
  else if(key==='requireReady'){if(Object.hasOwn(row,key)&&row[key]!==true)throw invalid()}
  else if(key==='expectedContentHash'){if(typeof row[key]!=='string'||!/^[a-f0-9]{64}$/.test(row[key] as string))throw invalid()}
  else if(key==='markdown'){if(typeof row[key]!=='string'||!(row[key] as string).trim()||Buffer.byteLength(row[key] as string)>2*1024*1024)throw invalid()}
 }
 return row
}
export function createEmployeeKnowledgeHandler(ports:{service:()=>Promise<EmployeeKnowledgeServicePort>;actor:()=>Promise<ResourceActor>;changed?:()=>void}){
 return async(endpoint:string,input:unknown):Promise<unknown>=>{
  if(!(employeeKnowledgeEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此员工知识接口。')
  const operation=endpoint.slice('employee-knowledge/'.length),row=employeeKnowledgeInput(operation,input),service=await ports.service(),actor=await ports.actor()
  const result=await service[operation as keyof EmployeeKnowledgeServicePort](actor,row)
  verifyEmployeeKnowledgeResult(operation,result,row,actor.ownerId,actor.scopeIds)
  if(operation==='revise'||operation==='restore')ports.changed?.()
  return result
 }
}
export function verifyEmployeeKnowledgeResult(operation:string,value:unknown,input:Record<string,unknown>,owner:string,scopes:readonly string[]):void{
 const document=(value:unknown):value is EmployeeKnowledgeDocument=>isEmployeeKnowledgeDocument(value)&&value.roleId===input.roleId&&(input.resourceId===undefined||value.resourceId===input.resourceId)&&value.resource.ownerId===owner&&value.resource.scopeIds.every(scope=>scopes.includes(scope))
 if(operation==='list'){if(!Array.isArray(value)||!value.every(document)||new Set(value.map(row=>row.resourceId)).size!==value.length)throw corrupt();return}
 if(operation==='read'){if(!isEmployeeKnowledgeContent(value)||!document(value)||input.version!==undefined&&value.bodyVersion!==input.version)throw corrupt();return}
 if(operation==='versions'){if(!Array.isArray(value)||!value.every(isEmployeeKnowledgeVersion)||new Set(value.map(row=>row.version)).size!==value.length)throw corrupt();return}
 if(operation==='status'&&value===null)return
 if(!isEmployeeKnowledgeRevision(value)||value.requestId!==input.requestId||value.document.resource.ownerId!==owner||value.document.resource.scopeIds.some(scope=>!scopes.includes(scope))||operation!=='status'&&(!document(value.document)||value.operation!==operation))throw corrupt()
}
export async function employeeKnowledgeRole(owner:string,roleId:string,role:(id:string)=>Promise<DigitalRole|null>):Promise<DigitalRole>{
 const current=await role(roleId)
 if(!current||current.id!==roleId||current.ownerId!==owner||current.kind!=='employee'||current.state==='retired'||!current.scopes.length)throw new WorkError('teloa/forbidden','员工不存在、已离岗或不属于当前本人。')
 return current
}
export function assertEmployeeKnowledgeModelRead(content:EmployeeKnowledgeContent):void{
 if(content.bytes>promptFullTextMaxBytes)throw new WorkError('teloa/invalid-input','该资料超过整段进模型的 256 KiB 上限，请使用已授权本地检索摘录。')
}
