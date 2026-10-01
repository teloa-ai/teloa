import {WorkError,isRecord,roleDefinition,taskInput} from '@teloa/contract'
import type {IndustryRoleInstance} from '@teloa/backend'
type Ports={instantiate:(owner:string,input:unknown)=>Promise<unknown>;get:(owner:string,input:unknown)=>Promise<unknown>;list:(owner:string,input:unknown)=>Promise<unknown>}
export const industryRoleEndpoints=['industry-roles/instantiate','industry-roles/get','industry-roles/list'] as const
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v
const invalid=()=>new WorkError('teloa/invalid-host-response','行业员工回包的身份、依赖或员工状态不一致。')
const exact=(v:unknown,keys:string[])=>{if(!isRecord(v)||Object.keys(v).some(key=>!keys.includes(key)))throw invalid();return v}
function read(value:unknown,owner:string):IndustryRoleInstance{
 const row=exact(value,['id','ownerId','loadId','itemInstanceId','itemLocalId','scope','definitionHash','revision','state','role','knowledge','omittedKnowledge','declarations','failure','createdAt','updatedAt'])
 if(!uuid(row.id)||row.ownerId!==owner||!uuid(row.loadId)||!uuid(row.itemInstanceId)||typeof row.itemLocalId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(row.itemLocalId)||!text(row.scope,80)||typeof row.definitionHash!=='string'||!/^[a-f0-9]{64}$/.test(row.definitionHash)||!integer(row.revision)||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt||!Array.isArray(row.knowledge)||row.knowledge.length>30||!Array.isArray(row.omittedKnowledge)||row.omittedKnowledge.length>500||!Array.isArray(row.declarations)||row.declarations.length>500)throw invalid()
 const targets=new Set<string>(),instances=new Set<string>(),resources=new Set<string>()
 for(const value of row.knowledge){const item=exact(value,['itemInstanceId','instanceId','resourceId','resourceVersion']);if(!uuid(item.itemInstanceId)||!uuid(item.instanceId)||!uuid(item.resourceId)||!integer(item.resourceVersion)||targets.has(item.itemInstanceId.toLowerCase())||instances.has(item.instanceId.toLowerCase())||resources.has(item.resourceId.toLowerCase()))throw invalid();targets.add(item.itemInstanceId.toLowerCase());instances.add(item.instanceId.toLowerCase());resources.add(item.resourceId.toLowerCase())}
 for(const value of row.omittedKnowledge){const item=exact(value,['itemInstanceId','reason']);if(!uuid(item.itemInstanceId)||targets.has(item.itemInstanceId.toLowerCase())||!['not-instantiated','pending','failed','withdrawn','skipped'].some(reason=>reason===item.reason))throw invalid();targets.add(item.itemInstanceId.toLowerCase())}
 // `kind:'model'` 不是资源关联（复审 N-1）：表示模板里的岗位模型指定已被剥离；只允许 skipped、指向岗位项自身、至多一条，不占依赖目标。
 let modelNotice=false
 for(const value of row.declarations){const item=exact(value,['kind','itemInstanceId','status']);if(!uuid(item.itemInstanceId)||!['skill','mcp','data-source','execution-tool','model'].some(kind=>kind===item.kind)||!['pending-adapter','skipped'].some(status=>status===item.status))throw invalid()
  if(item.kind==='model'){if(modelNotice||item.status!=='skipped'||item.itemInstanceId.toLowerCase()!==row.itemInstanceId.toLowerCase())throw invalid();modelNotice=true;continue}
  if(targets.has(item.itemInstanceId.toLowerCase()))throw invalid();targets.add(item.itemInstanceId.toLowerCase())}
 if(['paused','active','retired'].some(state=>state===row.state)){
  const role=exact(row.role,['id','ownerId','version','state','createdAt','updatedAt','name','kind','scopes','duty','dataScope','executionScope','skills','knowledge','responsibility','runtimeConfig'])
  if(!uuid(role.id)||role.ownerId!==owner||!integer(role.version)||role.state!==row.state||!stamp(role.createdAt)||!stamp(role.updatedAt)||role.updatedAt<role.createdAt||row.failure!==null)throw invalid()
  // 原始创建依据与本人后续合法编辑分开；当前岗位范围不必等于模板来源范围。
  try{roleDefinition({name:role.name,kind:role.kind,scopes:role.scopes,duty:role.duty,dataScope:role.dataScope,executionScope:role.executionScope,skills:role.skills,knowledge:role.knowledge,...(role.responsibility===undefined?{}:{responsibility:role.responsibility}),...(role.runtimeConfig===undefined?{}:{runtimeConfig:role.runtimeConfig})})}catch{throw invalid()}
 }else if(row.state==='pending'||row.state==='failed'){
  if(row.role!==null)throw invalid()
  if(row.state==='pending'){if(row.failure!==null)throw invalid()}
  else{const failure=exact(row.failure,['code','message']);if(typeof failure.code!=='string'||!/^teloa\/[a-z0-9-]+$/.test(failure.code)||!text(failure.message,2000))throw invalid()}
 }else throw invalid()
 return row as unknown as IndustryRoleInstance
}
export function createIndustryRolesHandler(owner:string,get:()=>Promise<Ports>){
 return async(method:string,payload:unknown):Promise<IndustryRoleInstance|{items:IndustryRoleInstance[]}>=>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  if(method==='industry-roles/list'){
   taskInput(payload,[]);const result=exact(await(await get()).list(owner,payload),['items']);if(!Array.isArray(result.items))throw invalid()
   const items=result.items.map(item=>read(item,owner)),ids=new Set<string>(),mappings=new Set<string>(),roles=new Set<string>()
   for(const item of items){const key=item.loadId.toLowerCase()+'/'+item.itemInstanceId.toLowerCase(),id=item.id.toLowerCase();if(ids.has(id)||mappings.has(key)||item.role&&roles.has(item.role.id.toLowerCase()))throw invalid();ids.add(id);mappings.add(key);if(item.role)roles.add(item.role.id.toLowerCase())}return {items}
  }
  if(method==='industry-roles/get'){
   const input=taskInput(payload,['instanceId']);if(!uuid(input.instanceId))throw new WorkError('teloa/invalid-input','实例身份必须是 UUID。')
   const result=read(await(await get()).get(owner,payload),owner);if(result.id.toLowerCase()!==input.instanceId.toLowerCase())throw invalid();return result
  }
  if(method==='industry-roles/instantiate'){
   const input=taskInput(payload,['requestId','loadId','itemInstanceId']);if(!uuid(input.requestId)||!uuid(input.loadId)||!uuid(input.itemInstanceId))throw new WorkError('teloa/invalid-input','行业员工请求身份必须是 UUID。')
   const result=read(await(await get()).instantiate(owner,payload),owner);if(result.loadId.toLowerCase()!==input.loadId.toLowerCase()||result.itemInstanceId.toLowerCase()!==input.itemInstanceId.toLowerCase())throw invalid();return result
  }
  throw new WorkError('teloa/invalid-input','不支持的行业员工操作。')
 }
}
