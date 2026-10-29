import {industryUpdateCanonical,readBusinessDashboardResource,type BusinessDashboardResourceDefinition,type DigitalRole,type EmployeeKnowledgeContent,type WorkResource} from '@teloa/contract'
import {assertCompleteBusinessKnowledgeScope,completeBusinessCrossScope,type CompleteBusinessPackageInput} from './complete-business-package.ts'
import type {BusinessShareSource} from './business-share-source.ts'
import type {IndustryLoadApi,IndustryLoadRecord} from './industry-load-api.ts'
import type {IndustryRoleApi,IndustryRoleInstance} from './industry-role-api.ts'
import type {MarketContentApi} from './market-content-api.ts'
import type {ResourceApi} from './resource-api.ts'
import type {RoleApi} from './role-api.ts'
import type {ShareSkillSource} from './share-package-plan.ts'
import type {IndustryKnowledgeApi} from './industry-knowledge-api.ts'

export type CompleteBusinessSnapshot=Pick<CompleteBusinessPackageInput,'scope'|'packages'|'roles'|'declarations'|'knowledge'|'configuration'>
export type CompleteBusinessSource={read:(scope:string)=>Promise<CompleteBusinessSnapshot>}
type Ports={
 declarations:BusinessShareSource;loads:Pick<IndustryLoadApi,'list'>;roles:Pick<RoleApi,'list'>
 readDeclarations?:(scope:string,loads:readonly IndustryLoadRecord[])=>ReturnType<BusinessShareSource['read']>
 industryRoles:Pick<IndustryRoleApi,'list'>;market:Pick<MarketContentApi,'list'|'hydrate'>
 resources:ResourceApi;skills:(names:readonly string[])=>Promise<ShareSkillSource[]>
 industryKnowledge:Pick<IndustryKnowledgeApi,'list'>
 readConfiguration?:(scope:string)=>Promise<{resource:BusinessDashboardResourceDefinition;configurationHash:string}|null>
}
const changed=()=>Object.assign(Error('业务包内容在读取期间发生变化，请重新生成预览。'),{code:'teloa/version-conflict'})
const unavailable=()=>Object.assign(Error('完整业务包所需的固定内容暂不可读取，请刷新后重试。'),{code:'teloa/source-unavailable'})
const loadKey=(rows:readonly IndustryLoadRecord[])=>JSON.stringify(rows.map(row=>[row.id,row.mappingHash,row.contentHash,row.status]).sort(([a],[b])=>String(a).localeCompare(String(b))))
const roleKey=(rows:readonly DigitalRole[])=>JSON.stringify([...rows].sort((a,b)=>a.id.localeCompare(b.id)))
const documentKey=(rows:readonly Pick<EmployeeKnowledgeContent,'resourceId'|'bodyVersion'|'contentHash'|'resource'>[])=>JSON.stringify(rows.map(row=>[row.resourceId,row.bodyVersion,row.contentHash,row.resource.id,row.resource.version]).sort(([a],[b])=>String(a).localeCompare(String(b))))
const resourceKey=(rows:readonly WorkResource[])=>industryUpdateCanonical([...rows].sort((a,b)=>a.id.localeCompare(b.id)))
const configurationKey=(value:{resource:BusinessDashboardResourceDefinition;configurationHash:string}|null|undefined)=>industryUpdateCanonical(value)
const contentHash=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),byte=>byte.toString(16).padStart(2,'0')).join('')
function origin(role:DigitalRole,loads:readonly IndustryLoadRecord[],instances:readonly IndustryRoleInstance[]){
 for(const load of loads)for(const item of load.items){
  if(item.kind!=='role'||item.status==='skipped')continue
  if(instances.some(row=>row.role?.id===role.id&&(row.loadId===load.id&&row.itemInstanceId===item.instanceId||item.carriedFrom!==undefined&&row.itemInstanceId===item.carriedFrom)))return {loadId:load.id,localId:item.localId}
 }
 return undefined
}

/** 固定业务包和员工当前正文的只读快照；读取后重核版本，不把半旧半新的内容交给打包器。 */
export function createCompleteBusinessSource(ports:Ports):CompleteBusinessSource{
 return {async read(scope){
  if(!/^[a-zA-Z0-9_-]{1,64}$/.test(scope))throw unavailable()
  const readConfiguration=async()=>{
   if(!ports.readConfiguration)return undefined
   const value=await ports.readConfiguration(scope)
   if(value===null)return null
   const resource=readBusinessDashboardResource(value.resource)
   if(!/^[a-f0-9]{64}$/.test(value.configurationHash))throw unavailable()
   if(resource.configuration.scope!==scope)throw completeBusinessCrossScope(resource.configuration.title,scope)
   return {resource:structuredClone(resource),configurationHash:value.configurationHash}
  }
  const [allLoads,allRoles,instances,marketItems,directory,knowledgeInstances,sources,configuration]=await Promise.all([ports.loads.list(),ports.roles.list(),ports.industryRoles.list(),ports.market.list(),ports.resources.directory(),ports.industryKnowledge.list(),ports.resources.sources(),readConfiguration()])
  const roles=allRoles.filter(row=>row.kind==='employee'&&row.state!=='retired'&&row.scopes.includes(scope)).sort((a,b)=>a.id.localeCompare(b.id))
  const activeLoads=allLoads.filter(row=>row.status==='active'),selectedLoads=new Set(activeLoads.filter(row=>row.scope===scope&&row.space.scope===scope).map(row=>row.id))
  for(const role of roles){const inherited=origin(role,activeLoads,instances);if(inherited)selectedLoads.add(inherited.loadId)}
  const loads=activeLoads.filter(row=>selectedLoads.has(row.id)).sort((a,b)=>a.id.localeCompare(b.id))
  const declarations=await (ports.readDeclarations?ports.readDeclarations(scope,loads):ports.declarations.read(scope))
  const packages=await Promise.all(loads.map(async load=>{
   const summary=marketItems.find(item=>item.contentStorage?.contentId===load.contentId)
   if(!summary)throw unavailable()
   const item=await ports.market.hydrate(summary)
   if(!item.packageContent||item.contentStorage?.contentId!==load.contentId||item.packageContent.hash!==load.contentHash)throw unavailable()
   return {loadId:load.id,loadScope:load.scope,item:structuredClone(item)}
  }))
  const names=[...new Set(roles.flatMap(role=>role.skills))].sort(),skills=names.length?await ports.skills(names):[]
  const employee=ports.resources.employeeKnowledge
  if(roles.some(role=>role.knowledge.length)&&!employee)throw unavailable()
  const roleSnapshots=await Promise.all(roles.map(async role=>{
   const documents:EmployeeKnowledgeContent[]=[]
   if(employee){
    const listed=await employee.list(role.id,{requireReady:true})
    if(new Set(listed.map(row=>row.resourceId)).size!==listed.length||listed.some(doc=>!role.knowledge.includes(doc.resourceId)))throw changed()
    for(const row of listed){
     assertCompleteBusinessKnowledgeScope(scope,row.title,row.resource.scopeIds)
     const value=await employee.read({roleId:role.id,resourceId:row.resourceId,version:row.bodyVersion})
     if(value.contentHash!==row.contentHash||value.resource.id!==row.resource.id)throw changed()
     assertCompleteBusinessKnowledgeScope(scope,value.title,value.resource.scopeIds)
     documents.push(value)
    }
   }
   const source=origin(role,loads,instances)
   return {role:{...structuredClone(role),scopes:[scope],knowledge:documents.map(document=>document.resourceId)},...(source?{origin:source}:{}),documents,skills:role.skills.map(name=>{const source=skills.find(row=>row.name===name);if(!source)throw unavailable();return source})}
  }))
  const included=new Set([...roles.flatMap(role=>role.knowledge),...roleSnapshots.flatMap(row=>row.documents.flatMap(document=>[document.resourceId,document.resource.id])),...knowledgeInstances.filter(row=>selectedLoads.has(row.loadId)).flatMap(row=>row.resource?[row.resource.id]:[])])
  const currentResources=directory.resources.filter(row=>row.status==='active'&&row.scopeIds.includes(scope)),extra=currentResources.filter(row=>!included.has(row.id)),knowledge:NonNullable<CompleteBusinessPackageInput['knowledge']>[number][]=[]
  for(const resource of currentResources)assertCompleteBusinessKnowledgeScope(scope,resource.title,resource.scopeIds)
  for(const resource of extra){
   const source=sources.find(row=>row.id===resource.sourceId),native=source?.knowledge
   let markdown:string
   if(native){
    const versions=await ports.resources.listKnowledgeVersions(native.knowledgeId),version=versions.find(row=>row.contentHash===resource.sourceVersion)
    if(!version)throw unavailable()
    const value=await ports.resources.readKnowledgeVersion(native.knowledgeId,version.version)
    if(value.ownerId!==resource.ownerId||value.contentHash!==resource.sourceVersion)throw changed()
    markdown=value.markdown
   }else{
    if(!ports.resources.readContent)throw unavailable()
    markdown=(await ports.resources.readContent(resource,new AbortController().signal)).text
   }
   if(await contentHash(markdown)!==resource.sourceVersion)throw changed()
   knowledge.push({title:resource.title,markdown,contentHash:resource.sourceVersion})
  }
  const representedSources=new Set([...currentResources.map(row=>row.sourceId),...roleSnapshots.flatMap(row=>row.documents.flatMap(document=>[document.resource.sourceId,document.origin.sourceId]))])
  const standaloneSources=sources.filter(source=>source.knowledge?.scopeIds.includes(scope)&&!representedSources.has(source.id))
  for(const source of standaloneSources){
   assertCompleteBusinessKnowledgeScope(scope,source.title,source.knowledge!.scopeIds)
   const value=await ports.resources.readKnowledgeVersion(source.knowledge!.knowledgeId,source.knowledge!.knowledgeVersion)
   if(value.contentHash!==source.version||await contentHash(value.markdown)!==source.version)throw changed()
   knowledge.push({title:source.title,markdown:value.markdown,contentHash:value.contentHash})
  }
  const [currentLoads,currentRoles,currentDirectory,currentDeclarations,currentSkills,currentConfiguration]=await Promise.all([ports.loads.list(),ports.roles.list(),ports.resources.directory(),ports.readDeclarations?ports.readDeclarations(scope,loads):ports.declarations.read(scope),names.length?ports.skills(names):Promise.resolve([]),readConfiguration()])
  if(loadKey(loads)!==loadKey(currentLoads.filter(row=>row.status==='active'&&(selectedLoads.has(row.id)||row.scope===scope&&row.space.scope===scope)))||roleKey(roles)!==roleKey(currentRoles.filter(row=>row.kind==='employee'&&row.state!=='retired'&&row.scopes.includes(scope)))||resourceKey(currentResources)!==resourceKey(currentDirectory.resources.filter(row=>row.status==='active'&&row.scopeIds.includes(scope)))||industryUpdateCanonical(declarations)!==industryUpdateCanonical(currentDeclarations)||industryUpdateCanonical(skills)!==industryUpdateCanonical(currentSkills)||configurationKey(configuration)!==configurationKey(currentConfiguration))throw changed()
  if(employee)for(const row of roleSnapshots){if(documentKey(row.documents)!==documentKey(await employee.list(row.role.id,{requireReady:true})))throw changed()}
  if(standaloneSources.length){const latest=await ports.resources.sources();for(const source of standaloneSources){const current=latest.find(row=>row.id===source.id);if(!current||current.version!==source.version||industryUpdateCanonical(current.knowledge)!==industryUpdateCanonical(source.knowledge))throw changed()}}
  return {scope,packages,roles:roleSnapshots,declarations,knowledge,...(configuration===undefined?{}:{configuration:configuration?.resource??null})}
 }}
}
