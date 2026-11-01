import {verifyKnowledgeVersionContent,templateShareResourceCapability,type WorkResource,type SourceReference} from '@teloa/contract'
import type {ResourceApi} from './resource-api.ts'
import type {RoleApi} from './role-api.ts'
import type {IndustryRoleApi} from './industry-role-api.ts'
import type {IndustryKnowledgeApi} from './industry-knowledge-api.ts'
import type {IndustryLoadApi,IndustryLoadRecord} from './industry-load-api.ts'
import type {MarketContentApi} from './market-content-api.ts'
import type {ManagedMcpConnectionApi} from './mcp-connections-api.ts'
import type {RoleToolGrantApi} from './role-tool-grant-api.ts'
import type {RoleDelegationApi} from './role-delegation-api.ts'
import {customConnectionShareSource} from './connection-share-source.ts'
import {isIndustryManifest,type IndustryResource} from './industry-manifest.ts'
import {inspectIndustryContent} from './industry-content.ts'
import {readSharePackageV2,type SharePackageV2,type ShareRoleSource,type ShareKnowledgeSource,type ShareStaticSource,type ShareConnectionSource,type SharePlanInput} from './share-package-plan.ts'

type Ports={roles:Pick<RoleApi,'list'>;resources:ResourceApi;industryRoles:Pick<IndustryRoleApi,'list'>;industryKnowledge?:Pick<IndustryKnowledgeApi,'list'>;loads:Pick<IndustryLoadApi,'get'>;contents:Pick<MarketContentApi,'hydrate'>;mcp?:Pick<ManagedMcpConnectionApi,'list'|'getCustom'>;tools?:Pick<RoleToolGrantApi,'get'>;delegations?:Pick<RoleDelegationApi,'get'>}
export type ShareObjectCandidate={key:string;kind:string;title:string;version:string;roleIds:string[];available:boolean;reason?:'unavailable'|'withdrawn'|'too-large';defaultSelected:boolean}
export type ShareObjectComposition=Pick<SharePlanInput,'knowledge'|'static'|'connections'|'bindings'>
export type ShareObjectDraft={key:string;candidates:ShareObjectCandidate[];compose:(selected:readonly string[])=>Promise<ShareObjectComposition>;assertCurrent:()=>Promise<void>}
export type TemplateShareObjectSources={prepare:(roles:readonly ShareRoleSource[],scope:string)=>Promise<ShareObjectDraft>}
const fail=()=>Object.assign(Error('The selected sharing source is unavailable or changed. Refresh and review its current contents.'),{code:'teloa/source-unavailable'})
const stable=(v:unknown):string=>JSON.stringify(v,(_,value)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value)
const hash=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),x=>x.toString(16).padStart(2,'0')).join('')
const roleFields=(r:ShareRoleSource)=>({id:r.id,name:r.name,kind:r.kind,avatarKey:r.avatarKey,duty:r.duty,dataScope:r.dataScope,executionScope:r.executionScope,skills:r.skills,knowledge:r.knowledge,responsibility:r.responsibility})
type Fixed={load:IndustryLoadRecord;item:Awaited<ReturnType<MarketContentApi['hydrate']>>;roles:Map<string,string>}

/** 复杂应用沿原固定内容读取完整静态资源；不将不可分享的文件静默剔除成一个假完整包。 */
export async function readAppBundleSharePackage(item:Awaited<ReturnType<MarketContentApi['hydrate']>>,publisher:string):Promise<SharePackageV2>{
 const manifest=item.manifest,content=item.packageContent,license=item.trust?.license
 if(!isIndustryManifest(manifest)||!content||!item.contentStorage?.loaded||manifest.resources.some(r=>r.kind==='role'||r.kind==='business-configuration'&&r.source.kind==='public')||license?.status!=='declared')throw fail()
 if(inspectIndustryContent(manifest,content).some(row=>row.state==='invalid'||row.state==='missing'))throw fail()
 const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):'',id=crypto.randomUUID(),files:{path:string;text:string}[]=[]
 for(const file of content.files){
  if(!file.path.startsWith(root))throw fail()
  const original=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes);if(await hash(original)!==file.hash)throw fail()
  const {localized:_localized,...metadata}=manifest
  files.push({path:file.path.slice(root.length),text:file.path===content.manifestPath?JSON.stringify({...metadata,id,resources:manifest.resources.map(({localized:_,...resource})=>resource)},null,2):original})
  if(file.path===content.manifestPath)files.push({path:'source/original-manifest-'+(await hash(original)).slice(0,16)+'.json',text:original})
 }
 if(files.length>500||files.some(f=>new TextEncoder().encode(f.text).length>2*1024*1024)||new TextEncoder().encode(JSON.stringify(files)).length>8*1024*1024)throw Object.assign(Error('The complete application exceeds the static sharing limit.'),{code:'share-source-limit'})
 const provided=manifest.resources.filter(r=>r.source.kind==='local'&&files.some(f=>r.source.kind==='local'&&f.path===r.source.path)).map(r=>r.id)
 const sourceFiles=files.filter(f=>/^source\/[^/]+\.json$/.test(f.path)&&!manifest.resources.some(r=>r.source.kind==='local'&&r.source.path===f.path)).map(f=>f.path)
 const capabilities=[...new Set(manifest.resources.flatMap(r=>{const c=templateShareResourceCapability(r.kind);return c?[c]:[]}))]
 return readSharePackageV2({format:'teloa.template-share/v2',subject:'app',id,version:manifest.version,title:manifest.title,description:manifest.description,license:license.value,trust:{publisher},provenance:{sources:provided.length?[{title:item.title,license:license.value,version:manifest.version,resourceIds:provided}]:[]},sourceFiles,requirements:manifest.resources.filter(r=>r.kind==='mcp'||r.kind==='plugin').map(r=>'Configure your own connection or application: '+r.title+'.'),compatibility:{manifestFormat:manifest.format,capabilities},files})
}

/** 只读取本人已有对象的精确来源。返回的闭包在导出前再次核版本，不把目录或展示名称当授权。 */
export function createTemplateShareObjectSources(ports:Ports):TemplateShareObjectSources{
 return {async prepare(selectedRoles,scope){
  const [directory,resources,references,instances]=await Promise.all([ports.roles.list(),ports.resources.directory(),ports.resources.sources(),ports.industryRoles.list()])
  const roles=selectedRoles.map(role=>{const current=directory.find(row=>row.id===role.id);if(!current||current.state==='retired'||current.kind!=='employee'||role.version!==undefined&&current.version!==role.version||stable(roleFields(current))!==stable(roleFields(role)))throw fail();return current})
  if(new Set(roles.map(r=>r.ownerId)).size!==1)throw fail()
  const owner=roles[0]?.ownerId,resourceById=new Map(resources.resources.map(r=>[r.id,r])),referenceById=new Map(references.map(r=>[r.id,r]))
  const candidates:ShareObjectCandidate[]=[],knowledge=new Map<string,{resource:WorkResource;reference:SourceReference|undefined;roles:string[]}>()
  for(const role of roles)for(const id of role.knowledge){
   if(knowledge.has(id)){knowledge.get(id)!.roles.push(role.id);continue}
   const resource=resourceById.get(id),reference=resource&&referenceById.get(resource.sourceId)
   const available=!!resource&&resource.ownerId===owner&&resource.status==='active'&&!!reference&&reference.version===resource.sourceVersion&&(reference.knowledge!==undefined||!!ports.resources.readContent&&/^(local_material_|industry_)/.test(resource.sourceId))
   const key='knowledge/'+id,reason=resource?.status==='withdrawn'?'withdrawn':reference&&reference.bytes>128*1024&&!reference.knowledge?'too-large':!available?'unavailable':undefined
   candidates.push({key,kind:reference?.knowledge?.category==='sop'?'sop':'knowledge',title:resource?.title??'',version:reference?.knowledge?String(reference.knowledge.knowledgeVersion):String(resource?.version??''),roleIds:[role.id],available:available&&!reason,...(reason?{reason}:{}),defaultSelected:false})
   if(resource)knowledge.set(id,{resource,reference,roles:[role.id]})
  }
  for(const c of candidates)if(c.key.startsWith('knowledge/'))c.roleIds=knowledge.get(c.key.slice(10))?.roles??c.roleIds
  const fixed:Fixed[]=[]
  const loadFixed=async(loadId:string)=>{
   let group=fixed.find(row=>row.load.id===loadId)
   if(!group){
    const load=await ports.loads.get(loadId)
    if(load.ownerId!==owner||load.status!=='active')throw fail()
    const item=await ports.contents.hydrate({kind:'bundle',contentStorage:{contentId:load.contentId,createdAt:load.createdAt,loaded:true}} as Parameters<MarketContentApi['hydrate']>[0])
    if(item.contentStorage?.contentId!==load.contentId||item.packageContent?.hash!==load.contentHash||!isIndustryManifest(item.manifest)||item.manifest.id!==load.templateId||item.manifest.version!==load.templateVersion)throw fail()
    group={load,item,roles:new Map()};fixed.push(group)
   }
   return group
  }
  for(const role of roles){
   const mapped=instances.filter(row=>row.role?.id===role.id&&row.ownerId===owner&&['active','paused'].includes(row.state))
   if(mapped.length>1)throw fail()
   const source=mapped[0];if(!source)continue
   const group=await loadFixed(source.loadId)
   const resource=group.load.items.find(row=>row.instanceId===source.itemInstanceId)
   if(resource?.kind!=='role'||resource.localId!==source.itemLocalId||source.role?.version!==role.version)throw fail()
   group.roles.set(resource.localId,role.id)
  }
  const knowledgeOrigins=new Map<string,Fixed>()
  const boundIndustry=[...knowledge.values()].filter(row=>row.resource.sourceId.startsWith('industry_'))
  const industryKnowledge=boundIndustry.length&&ports.industryKnowledge?await ports.industryKnowledge.list():[]
  for(const known of boundIndustry){
   const matches=industryKnowledge.filter(row=>row.ownerId===owner&&row.state==='active'&&row.resource?.id===known.resource.id&&row.resource.version===known.resource.version&&row.sourceId===known.resource.sourceId&&row.sourceVersion===known.resource.sourceVersion)
   if(matches.length===1){const source=await loadFixed(matches[0]!.loadId),item=source.load.items.find(row=>row.instanceId===matches[0]!.itemInstanceId&&row.localId===matches[0]!.itemLocalId&&row.kind==='knowledge');if(item&&source.item.trust?.license.status==='declared')knowledgeOrigins.set(known.resource.id,source)}
   if(!knowledgeOrigins.has(known.resource.id)){const candidate=candidates.find(row=>row.key==='knowledge/'+known.resource.id)!;candidate.available=false;candidate.reason='unavailable'}
  }
  const fixedChoices=new Map<string,{source:Fixed;resource:IndustryResource;roleIds:string[]}>()
  for(const source of fixed){
   if(!source.roles.size)continue
   const manifest=source.item.manifest;if(!isIndustryManifest(manifest))throw fail()
   for(const resource of manifest.resources){
    if(['role','skill','knowledge'].includes(resource.kind))continue
    const roleIds=manifest.relations.filter(link=>source.roles.has(link.from)&&link.to===resource.id&&['role-work','role-connection'].includes(link.kind)).map(link=>source.roles.get(link.from)!)
    if(!roleIds.length&&resource.kind!=='business-configuration')continue
    const key='fixed/'+source.load.id+'/'+resource.id
    const content=source.item.packageContent!,root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):''
    const localPath=resource.source.kind==='local'?resource.source.path:undefined
    const available=(resource.source.kind==='public'?resource.kind!=='business-configuration':localPath!==undefined&&content.files.some(file=>file.path===root+localPath))&&source.item.trust?.license.status==='declared'
    candidates.push({key,kind:resource.kind,title:resource.title,version:resource.version,roleIds,available,...(!available?{reason:'unavailable' as const}:{}),defaultSelected:resource.kind!=='business-configuration'})
    fixedChoices.set(key,{source,resource,roleIds})
   }
  }
  const dynamicConnections:ShareConnectionSource[]=[],unresolvedTools:string[]=[],replacedFixedBindings=new Set<string>(),bindings=new Map(roles.map(role=>[role.id,{roleId:role.id,connections:[] as string[]}]))
  const managed=ports.mcp?await ports.mcp.list():[]
  const grantStates:unknown[]=[],grants=new Map<string,{tools:Awaited<ReturnType<RoleToolGrantApi['get']>>;delegation?:Awaited<ReturnType<RoleDelegationApi['get']>>}>()
  for(const role of roles){
   if(!ports.tools)continue
   const current=await ports.tools.get(role.id);if(current.roleVersion!==role.version)throw fail();grantStates.push(current);grants.set(role.id,{tools:current})
   const grant=current.grant;if(!grant||grant.state!=='active'||grant.roleVersion!==role.version)continue
   let names=grant.rules.map(rule=>rule.name)
   if(ports.delegations){const delegated=await ports.delegations.get(role.id);if(delegated.roleVersion!==role.version)throw fail();grantStates.push(delegated);grants.get(role.id)!.delegation=delegated;const matching=delegated.delegations.filter(row=>row.roleVersion===role.version&&row.scope===scope&&row.state==='active');if(matching.length)names=names.filter(name=>matching.some(row=>row.allowedTools.includes(name)))}
   unresolvedTools.push(...names.filter(name=>!managed.some(connection=>connection.tools?.some(tool=>tool.fullName===name))))
   for(const connection of managed){
    const tools=connection.tools?.filter(tool=>names.includes(tool.fullName));if(!tools?.length)continue
    for(const source of fixed){
     const from=[...source.roles].find(([,id])=>id===role.id)?.[0],manifest=source.item.manifest,content=source.item.packageContent
     if(!from||!isIndustryManifest(manifest)||!content)continue
     const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):''
     for(const link of manifest.relations.filter(link=>link.from===from&&link.kind==='role-connection')){const r=manifest.resources.find(r=>r.id===link.to&&r.kind==='mcp');if(r?.source.kind!=='local')continue;const path=root+r.source.path,file=content.files.find(file=>file.path===path);if(!file)throw fail();const body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(file.bytes));if(body.serverName===connection.serverName)replacedFixedBindings.add(role.id+'/'+source.load.id+'/'+r.id)}
    }
    const bindingKey=role.id+'/'+connection.id,preview=connection.custom&&ports.mcp?await ports.mcp.getCustom(connection.id):undefined
    const source=preview?customConnectionShareSource(preview.definition,tools):{serverName:connection.serverName,title:connection.serverName,tools:tools.map(tool=>tool.name)}
    dynamicConnections.push({...source,bindingKey});bindings.get(role.id)!.connections.push(bindingKey)
   }
  }
  // 原包同一连接可能曾声明更宽工具；已有正式绑定时按成员当前工具子集分享，不再附加那份宽声明。
  for(const [key,choice] of fixedChoices){
   const filtered=choice.roleIds.filter(roleId=>!replacedFixedBindings.has(roleId+'/'+choice.source.load.id+'/'+choice.resource.id))
   if(filtered.length!==choice.roleIds.length){const index=candidates.findIndex(row=>row.key===key);if(!filtered.length){fixedChoices.delete(key);if(index>=0)candidates.splice(index,1)}else{choice.roleIds=filtered;candidates[index]!.roleIds=filtered}}
  }
  const sourceState={roles:roles.map(role=>({id:role.id,version:role.version,fields:roleFields(role)})),knowledge:[...knowledge.values()].map(row=>row.resource),fixed:fixed.map(row=>({id:row.load.id,mappingHash:row.load.mappingHash,contentHash:row.load.contentHash})),candidates,managed,grantStates}
  const assertCurrent=async()=>{
   const [now,rd]=await Promise.all([ports.roles.list(),ports.resources.directory()])
   for(const role of roles){const current=now.find(r=>r.id===role.id);if(!current||current.ownerId!==owner||current.version!==role.version||stable(roleFields(current))!==stable(roleFields(role)))throw fail()}
   for(const {resource} of knowledge.values()){const current=rd.resources.find(row=>row.id===resource.id);if(!current||stable(current)!==stable(resource))throw fail()}
   for(const source of fixed){const current=await ports.loads.get(source.load.id);if(current.status!=='active'||current.mappingHash!==source.load.mappingHash||current.contentHash!==source.load.contentHash)throw fail()}
   if(ports.mcp&&stable(await ports.mcp.list())!==stable(managed))throw fail()
   for(const [roleId,value] of grants){if(!ports.tools||stable(await ports.tools.get(roleId))!==stable(value.tools))throw fail();if(value.delegation&&(!ports.delegations||stable(await ports.delegations.get(roleId))!==stable(value.delegation)))throw fail()}
  }
  return {key:await hash(stable(sourceState)),candidates,assertCurrent,async compose(selected){
   if(new Set(selected).size!==selected.length||selected.some(key=>!candidates.some(c=>c.key===key&&c.available)))throw fail()
   await assertCurrent()
   const texts:ShareKnowledgeSource[]=[],extra:ShareStaticSource={resources:[],files:[],relations:[],roleRelations:[],requirements:[]}
   for(const name of new Set(unresolvedTools))(extra.requirements as string[]).push('Review your own authorization for employee tool: '+name+' (no portable connection source).')
   for(const key of selected.filter(key=>key.startsWith('knowledge/'))){
    const id=key.slice(10),known=knowledge.get(id);if(!known?.reference)throw fail()
    let text:string
    if(known.reference.knowledge){const expected=known.reference.knowledge,value=await ports.resources.readKnowledgeVersion(expected.knowledgeId,expected.knowledgeVersion);if(value.ownerId!==owner||known.resource.sourceId!=='knowledge_'+expected.knowledgeId.toLowerCase()||value.contentHash!==known.resource.sourceVersion||!await verifyKnowledgeVersionContent(value))throw fail();text=value.markdown}
    else{if(!ports.resources.readContent)throw fail();text=(await ports.resources.readContent(known.resource,new AbortController().signal)).text}
    if(await hash(text)!==known.resource.sourceVersion)throw fail()
    const origin=knowledgeOrigins.get(id),license=origin?.item.trust?.license
    texts.push({referenceId:id,id:'knowledge-'+texts.length,title:known.resource.title,version:'1.0.0',text,sourceVersion:known.resource.sourceVersion,roleIds:known.roles,...(license?.status==='declared'?{license:license.value}:{})})
   }
   const used=new Map<string,string>(),extraResources:IndustryResource[]=[],extraFiles:{path:string;text:string}[]=[],roleRelations:{roleId:string;kind:'role-work'|'role-connection';to:string}[]=[],extraRelations:{kind:string;from:string;to:string}[]=[]
   const add=async(source:Fixed,resource:IndustryResource,index:number)=>{
    const identity=stable([source.load.contentHash,resource]);if(used.has(resource.id)){if(used.get(resource.id)===identity)return;throw fail()}
    if(['role','knowledge'].includes(resource.kind))throw fail()
    used.set(resource.id,identity)
    const content=source.item.packageContent!,root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):''
    if(resource.source.kind==='public'){extraResources.push(resource);return}
    const oldPath=resource.source.path,prefix='fixed-'+index+'/',file=content.files.find(f=>f.path===root+oldPath);if(!file||await hash(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes))!==file.hash)throw fail()
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes)
    extraResources.push({...resource,source:{kind:'local',path:prefix+oldPath}})
    const folder=resource.kind==='skill'?oldPath.slice(0,oldPath.lastIndexOf('/')+1):undefined
    for(const f of content.files.filter(f=>folder?f.path.startsWith(root+folder):f.path===root+oldPath)){const t=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(f.bytes);if(await hash(t)!==f.hash)throw fail();extraFiles.push({path:prefix+f.path.slice(root.length),text:t})}
    if(resource.kind==='plan'){const body=JSON.parse(text),manifest=source.item.manifest;if(!isIndustryManifest(manifest))throw fail();const work=manifest.resources.find(r=>r.id===body.workTemplate&&r.kind==='work-template');if(!work)throw fail();await add(source,work,index)}
    if(resource.kind==='work-template'){const body=JSON.parse(text),manifest=source.item.manifest;if(!isIndustryManifest(manifest))throw fail();for(const ref of body.skills??[]){const skill=manifest.resources.find(r=>r.id===ref.id&&r.version===ref.version&&r.kind==='skill');if(!skill)throw fail();await add(source,skill,index)}}
   }
   for(const key of selected.filter(key=>key.startsWith('fixed/'))){const choice=fixedChoices.get(key);if(!choice)throw fail();const index=fixed.indexOf(choice.source);await add(choice.source,choice.resource,index);for(const roleId of choice.roleIds)roleRelations.push({roleId,kind:choice.resource.kind==='work-template'||choice.resource.kind==='plan'?'role-work':'role-connection',to:choice.resource.id})}
   for(const [id,known] of knowledge)if(!selected.includes('knowledge/'+id))(extra.requirements as string[]).push('Provide your own knowledge: '+known.resource.title+' (not shared).')
   for(const candidate of candidates.filter(c=>c.key.startsWith('fixed/')&&!selected.includes(c.key)))(extra.requirements as string[]).push('Configure the omitted resource: '+candidate.title+'.')
   const includedSources=fixed.filter(source=>isIndustryManifest(source.item.manifest)&&source.item.manifest.resources.some(resource=>used.get(resource.id)===stable([source.load.contentHash,resource])))
   const sourceScopes=[...new Set(includedSources.map(source=>source.load.scope).filter(value=>value!=='general'))]
   if(sourceScopes.length>1)throw fail()
   // 原流程先保留来源范围；接收时再按本人的选择创建派生工作副本。
   extra.scope=sourceScopes[0]??scope
   if(includedSources.some(source=>source.load.scope!==extra.scope&&isIndustryManifest(source.item.manifest)&&source.item.manifest.resources.some(resource=>resource.kind==='business-configuration'&&used.get(resource.id)===stable([source.load.contentHash,resource]))))throw fail()
   if(extraResources.some(r=>r.kind==='business-configuration'))extra.manifestFormat='teloa.business-package/v4'
   else if(includedSources.some(source=>source.item.manifest?.format!=='teloa.business-package/v2'))extra.manifestFormat='teloa.business-package/v3'
   extra.resources=extraResources;extra.files=extraFiles;extra.roleRelations=roleRelations;extra.relations=extraRelations
   extra.sources=fixed.flatMap(source=>{
    const manifest=source.item.manifest;if(!isIndustryManifest(manifest))throw fail()
    const resourceIds=manifest.resources.filter(old=>used.get(old.id)===stable([source.load.contentHash,old])&&extraResources.some(r=>r.id===old.id&&r.source.kind==='local')).map(r=>r.id)
    if(!resourceIds.length)return []
    const license=source.item.trust?.license;if(license?.status!=='declared')throw fail()
    return [{title:source.item.title,version:source.load.templateVersion,license:license.value,resourceIds}]
   })
   const sourceFiles:string[]=[]
   for(const source of fixed){
    const manifest=source.item.manifest,content=source.item.packageContent!
    if(!isIndustryManifest(manifest)||!manifest.resources.some(resource=>used.get(resource.id)===stable([source.load.contentHash,resource])))continue
    const file=content.files.find(file=>file.path===content.manifestPath);if(!file)throw fail()
    const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes);if(await hash(text)!==file.hash)throw fail()
    const path='source/fixed-manifest-'+fixed.indexOf(source)+'.json';extraFiles.push({path,text});sourceFiles.push(path)
    const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):''
    for(const notice of content.files.filter(file=>file.path.startsWith(root)&&/^(?:LICENSE(?:\.(?:md|txt))?|NOTICE\.(?:md|txt))$/i.test(file.path.slice(root.length)))){
     const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(notice.bytes);if(await hash(text)!==notice.hash)throw fail()
     const path='fixed-'+fixed.indexOf(source)+'/'+notice.path.slice(root.length),existing=extraFiles.find(file=>file.path===path);if(existing?existing.text!==text:false)throw fail();if(!existing)extraFiles.push({path,text})
    }
   }
   extra.sourceFiles=sourceFiles
   await assertCurrent()
   return {knowledge:texts,static:extra,connections:dynamicConnections,bindings:[...bindings.values()]}
  }}
 }}
}
