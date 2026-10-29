import {WorkError,industryUpdateCanonical,isEmployeeKnowledgeContent,localizedMetadata,readBusinessActionDefinition,readBusinessDashboardResource,readBusinessObjectTypeDefinition,readBusinessViewDefinition,readIndustryDataSourceDefinition,readRoleTemplateDefinition,type DigitalRole,type EmployeeKnowledgeContent,type BusinessDashboardResourceDefinition} from '@teloa/contract'
import {readIndustryDirectory,validateIndustryPath,type IndustryContent} from './industry-directory.ts'
import {inspectIndustryContent} from './industry-content.ts'
import {isIndustryManifest,validateIndustryManifest,type IndustryManifest,type IndustryRelation,type IndustryResource} from './industry-manifest.ts'
import {planBusinessSharePackage,type BusinessShareInput} from './business-share-package.ts'
import {validateManifest,type MarketItem} from './market-preview.ts'
import type {ShareSkillSource} from './share-package-plan.ts'

export type CompleteBusinessPackageRole={role:DigitalRole;origin?:{loadId:string;localId:string};documents:readonly EmployeeKnowledgeContent[];skills:readonly ShareSkillSource[]}
export type CompleteBusinessPackageKnowledge={title:string;markdown:string;contentHash:string}
export type CompleteBusinessPackageInput={scope:string;packageId:string;packageVersion:string;title:string;description:string;english?:BusinessShareInput['english'];packages:readonly {loadId:string;loadScope?:string;item:MarketItem}[];roles:readonly CompleteBusinessPackageRole[];/** null表示尚无正式应用配置，仍保留原包待准备配置。 */configuration?:BusinessDashboardResourceDefinition|null;knowledge?:readonly CompleteBusinessPackageKnowledge[];declarations:Pick<BusinessShareInput,'objectTypes'|'views'|'actions'|'sources'|'available'>}
export type CompleteBusinessPackageResult={item:MarketItem;counts:Record<string,number>;fileCount:number}
const encode=(value:string)=>new TextEncoder().encode(value)
const decode=(value:Uint8Array)=>new TextDecoder('utf-8',{fatal:true}).decode(value)
const hash=async(value:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(value))),byte=>byte.toString(16).padStart(2,'0')).join('')
const json=(value:unknown)=>encode(industryUpdateCanonical(value))
const order=(a:string,b:string)=>a<b?-1:a>b?1:0
const fail=(message:string):never=>{throw Error(message)}
/** 同一份资料所要求的其他业务范围不能在打包时被隐式丢弃。 */
export const completeBusinessCrossScope=(title:string,scope:string)=>new WorkError('teloa/complete-business-cross-scope','「'+title+'」包含其他业务范围的资料或员工语义，不能随当前业务导出。请先单独处理跨业务范围资料。',{title,scope})
export function assertCompleteBusinessKnowledgeScope(scope:string,title:string,scopeIds:readonly string[]):void{
 if(scopeIds.length!==1||scopeIds[0]!==scope)throw completeBusinessCrossScope(title,scope)
}

/** 只组合调用方已读取的静态快照；正文与关联经过导入端同一份解析器，不读取执行记录或账户。 */
export async function buildCompleteBusinessPackage(input:CompleteBusinessPackageInput):Promise<CompleteBusinessPackageResult>{
 const files=new Map<string,Uint8Array>(),resources=new Map<string,IndustryResource>(),relations:IndustryRelation[]=[],entrypoints=new Set<string>(),origins=new Map<string,string>()
 const addFile=(path:string,bytes:Uint8Array)=>{validateIndustryPath(path);if(files.has(path))fail('完整业务包内文件路径重复：'+path);files.set(path,Uint8Array.from(bytes))}
 const addResource=(resource:IndustryResource)=>{if(resources.has(resource.id))fail('多个业务包的资源标识冲突：'+resource.id+'。请先调整包内标识后重新导出。');resources.set(resource.id,structuredClone(resource))}
 const unique=(base:string)=>{let value=base,index=2;while(resources.has(value))value=base+'-'+index++;return value}
 const configuration=input.configuration===undefined?undefined:input.configuration===null?null:readBusinessDashboardResource(input.configuration)
 if(configuration&&configuration.configuration.scope!==input.scope)throw completeBusinessCrossScope(configuration.configuration.title,input.scope)
 const packages=[...input.packages].sort((a,b)=>order(a.loadId,b.loadId))
 if(new Set(packages.map(row=>row.loadId)).size!==packages.length)fail('完整业务包来源加载重复。')
 for(const [index,{loadId,loadScope,item}] of packages.entries()){
  const content=item.packageContent??fail('来源包「'+item.title+'」缺少完整静态内容。')
  if(!isIndustryManifest(item.manifest))fail('来源包「'+item.title+'」缺少完整静态内容。')
  const checked=await readIndustryDirectory(content.files.map(file=>({path:file.path,size:file.bytes.length,read:async()=>file.bytes})),content.manifestPath,item.title)
  if(checked.packageContent!.hash!==(content.baseHash??content.hash)||industryUpdateCanonical(checked.manifest)!==industryUpdateCanonical(item.manifest))fail('来源包「'+item.title+'」的固定内容已变化，请重新读取。')
  const manifest=validateIndustryManifest(item.manifest)
  if(manifest.scope!==input.scope&&loadScope===undefined)fail('来源包「'+item.title+'」缺少当前业务范围的可信加载归属。')
  const upstream=loadScope!==undefined&&loadScope!==input.scope
  const currentRoles=new Set(input.roles.filter(row=>row.role.kind==='employee'&&row.role.state!=='retired'&&row.role.scopes.includes(input.scope)&&row.origin?.loadId===loadId&&manifest.resources.some(resource=>resource.id===row.origin!.localId&&resource.kind==='role')).map(row=>row.origin!.localId))
  if(upstream&&!currentRoles.size)fail('上游包「'+item.title+'」没有当前业务员工的可信来源关联。')
  // 上游仅带当前员工及其协调关系需要的员工；其他静态依赖完整保留，未关联这些员工的计划移出清单。
  if(upstream)for(let previous=-1;previous!==currentRoles.size;){previous=currentRoles.size;for(const link of manifest.relations)if(link.kind==='role-coordination'&&currentRoles.has(link.from))currentRoles.add(link.to)}
  const included=new Set(manifest.resources.filter(resource=>configuration!==undefined&&configuration!==null&&resource.kind==='business-configuration'?false:!upstream||resource.kind!=='role'&&resource.kind!=='plan'||resource.kind==='role'&&currentRoles.has(resource.id)||resource.kind==='plan'&&manifest.relations.some(link=>link.kind==='role-work'&&link.to===resource.id&&currentRoles.has(link.from))).map(row=>row.id))
  const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):'',prefix='packages/package-'+(index+1)+'/'
  const excludedEntries=new Set(manifest.resources.filter(resource=>!included.has(resource.id)&&['role','plan','business-configuration'].includes(resource.kind)&&resource.source.kind==='local').map(resource=>root+(resource.source as {kind:'local';path:string}).path))
  const includedEntries=new Set(manifest.resources.filter(resource=>included.has(resource.id)&&resource.source.kind==='local').map(resource=>root+(resource.source as {kind:'local';path:string}).path))
  for(const resource of manifest.resources.filter(resource=>included.has(resource.id)&&resource.kind==='skill'&&resource.source.kind==='local')){
   const path=root+(resource.source as {kind:'local';path:string}).path,folder=path.includes('/')?path.slice(0,path.lastIndexOf('/')+1):''
   if([...excludedEntries].some(entry=>entry.startsWith(folder)))fail('技能「'+resource.title+'」的完整目录包含被排除或替换的员工、计划或业务配置正文，请先整理来源目录后导出。')
  }
  for(const file of content.files){
   if(!file.path.startsWith(root))fail('来源包包含根目录之外的文件：'+file.path)
   const relative=file.path.slice(root.length)
   if(excludedEntries.has(file.path)&&!includedEntries.has(file.path))continue
   // 出处清单也只保留实际带出的资源，不能从侧车恢复被排除员工或计划的定义与关系。
   const bytes=file.path===content.manifestPath?json({...manifest,resources:manifest.resources.filter(resource=>included.has(resource.id)),relations:manifest.relations.filter(link=>included.has(link.from)&&included.has(link.to)),entrypoints:manifest.entrypoints.filter(id=>included.has(id))}):file.bytes
   addFile(prefix+(file.path===content.manifestPath?'source-manifest.json.txt':relative),bytes)
  }
  for(const resource of manifest.resources.filter(row=>included.has(row.id))){
   origins.set(loadId+'\0'+resource.id,resource.id)
   if(resource.source.kind==='local'){addResource(redirectResourceScope({...resource,source:{kind:'local',path:prefix+resource.source.path}},manifest.scope,input.scope,'current/scopes/package-'+(index+1)+'/',files,addFile,loadScope));continue}
   const sourceReference=resource.source
   const reference=content.resolved?.find(row=>row.resourceId===resource.id&&row.sourceResourceId===sourceReference.id&&row.kind===resource.kind&&row.version===resource.version)??fail('公共资源「'+resource.title+'」尚未取得完整正文，不能生成完整业务 ZIP。')
   const folder=reference.sourcePath.includes('/')?reference.sourcePath.slice(0,reference.sourcePath.lastIndexOf('/')+1):'',referencePrefix='references/package-'+(index+1)+'/'+resource.id+'/'
   if(!reference.sourceFiles.some(file=>file.path===reference.sourcePath))fail('公共资源「'+resource.title+'」缺少入口文件。')
   for(const file of reference.sourceFiles){if(!file.path.startsWith(folder)||await hash(file.bytes)!==file.hash)fail('公共资源「'+resource.title+'」的静态文件已变化。');addFile(referencePrefix+file.path.slice(folder.length),file.bytes)}
   addResource(redirectResourceScope({...resource,source:{kind:'local',path:referencePrefix+reference.sourcePath.slice(folder.length)}},manifest.scope,input.scope,'current/scopes/package-'+(index+1)+'/',files,addFile,loadScope))
  }
  relations.push(...structuredClone(manifest.relations.filter(link=>included.has(link.from)&&included.has(link.to))));for(const id of manifest.entrypoints)if(included.has(id))entrypoints.add(id)
 }
 for(const [index,knowledge] of (input.knowledge??[]).entries()){
  const bytes=typeof knowledge.markdown==='string'?encode(knowledge.markdown):new Uint8Array()
  if(typeof knowledge.title!=='string'||!knowledge.title.trim()||knowledge.title.length>120||typeof knowledge.markdown!=='string'||!knowledge.markdown.trim()||!bytes.length||bytes.length>2*1024*1024||await hash(bytes)!==knowledge.contentHash)fail('业务知识的标题、正文摘要或2 MiB大小边界不正确。')
  const id=unique('business-knowledge-'+(index+1)),path='current/knowledge/'+id+'.md'
  addFile(path,bytes);addResource({id,kind:'knowledge',title:knowledge.title,version:'1.0.0',required:true,source:{kind:'local',path}})
 }
 const roleIds=new Set<string>(),roleOrigins=new Set<string>(),skillDefinitions=new Map<string,{id:string;signature:string}>()
 for(const [index,source] of [...input.roles].sort((a,b)=>order(a.role.id,b.role.id)).entries()){
  const {role}=source
  if(role.kind!=='employee'||role.state==='retired'||!role.scopes.includes(input.scope)||roleIds.has(role.id))fail('员工快照不属于当前业务、已离职或身份重复：'+role.name)
  if(role.scopes.length!==1||role.scopes[0]!==input.scope)throw completeBusinessCrossScope(role.name,input.scope)
  roleIds.add(role.id)
  let localId:string
  if(source.origin){const identity=source.origin.loadId+'\0'+source.origin.localId;localId=origins.get(identity)??fail('员工「'+role.name+'」缺少对应的来源资源。');if(resources.get(localId)?.kind!=='role'||roleOrigins.has(identity))fail('员工来源资源重复或类型不匹配：'+role.name);roleOrigins.add(identity)}else localId=unique('employee-'+(index+1))
  const body=readRoleTemplateDefinition({format:'teloa.role/v1',name:role.name,kind:role.kind,duty:role.duty,dataScope:role.dataScope,executionScope:role.executionScope,...(role.avatarKey?{avatarKey:role.avatarKey}:{}),...(role.responsibility?{responsibility:role.responsibility}:{}),...(role.runtimeConfig?{runtimeConfig:role.runtimeConfig}:{})}).definition
  const existing=resources.get(localId),path='current/employees/'+localId+'.json'
  addFile(path,json({format:'teloa.role/v1',...body}))
  const {localized:_localized,...metadata}=existing??{id:localId,kind:'role' as const,title:role.name,version:input.packageVersion,required:true,source:{kind:'local' as const,path}}
  resources.set(localId,{...metadata,title:role.name,source:{kind:'local',path}})
  for(let i=relations.length-1;i>=0;i--)if(relations[i]!.from===localId&&['role-knowledge','role-skill'].includes(relations[i]!.kind))relations.splice(i,1)
  if(source.documents.length!==role.knowledge.length||new Set(source.documents.map(row=>row.resourceId)).size!==source.documents.length)fail('员工「'+role.name+'」的知识正文不完整或重复。')
  for(const [documentIndex,document] of [...source.documents].sort((a,b)=>order(a.resourceId,b.resourceId)).entries()){
   if(!isEmployeeKnowledgeContent(document)||document.roleId!==role.id||document.resource.ownerId!==role.ownerId||!role.knowledge.includes(document.resourceId)||await hash(encode(document.markdown))!==document.contentHash)fail('员工「'+role.name+'」的当前知识正文身份或摘要不匹配。')
   assertCompleteBusinessKnowledgeScope(input.scope,document.title,document.resource.scopeIds)
   const id=unique('employee-'+(index+1)+'-knowledge-'+(documentIndex+1)),path='current/knowledge/'+id+'.md'
   addFile(path,encode(document.markdown));addResource({id,kind:'knowledge',title:document.title,version:'1.0.0',required:true,source:{kind:'local',path}});relations.push({kind:'role-knowledge',from:localId,to:id})
  }
  if(new Set(source.skills.map(row=>row.name)).size!==source.skills.length||role.skills.some(name=>!source.skills.some(row=>row.name===name)))fail('员工「'+role.name+'」的技能静态正文不完整或重复。')
  for(const [skillIndex,name] of [...role.skills].sort(order).entries()){
   const skill=source.skills.find(row=>row.name===name)!,entries=skill.files?.map(row=>({...row}))??(skill.text?[{path:'SKILL.md',text:skill.text}]:[])
   if(!entries.length||!entries.some(row=>row.path==='SKILL.md')||skill.text!==undefined&&entries.find(row=>row.path==='SKILL.md')?.text!==skill.text)fail('技能「'+name+'」缺少一致的 SKILL.md 与静态附件，不能生成完整业务 ZIP。')
   if(new Set(entries.map(row=>row.path)).size!==entries.length)fail('技能「'+name+'」的静态文件路径重复。')
   const signature=industryUpdateCanonical({version:skill.version??'1.0.0',files:[...entries].sort((a,b)=>order(a.path,b.path))}),previous=skillDefinitions.get(name)
   if(previous&&previous.signature!==signature)fail('同一技能「'+name+'」有不同的静态版本，不能合并为一个业务包。')
   let id=previous?.id
   if(!id){
    const original=skill.resourceId?resources.get(skill.resourceId):undefined
    if(original&&original.kind!=='skill')fail('技能来源标识被其他资源占用：'+skill.resourceId)
    id=original?.id??unique('employee-'+(index+1)+'-skill-'+(skillIndex+1));const prefix='current/skills/'+id+'/'
    for(const entry of entries){validateIndustryPath(entry.path);addFile(prefix+entry.path,encode(entry.text))}
    const {localized:_localized,...metadata}=original??{id,kind:'skill' as const,title:skill.title??name,version:skill.version??'1.0.0',required:true,source:{kind:'local' as const,path:prefix+'SKILL.md'}}
    resources.set(id,{...metadata,title:skill.title??name,version:skill.version??original?.version??'1.0.0',source:{kind:'local',path:prefix+'SKILL.md'}});skillDefinitions.set(name,{id,signature})
   }
   relations.push({kind:'role-skill',from:localId,to:id})
  }
 }
 const setDeclaration=(kind:'object-type'|'business-view'|'business-action',row:BusinessShareInput['objectTypes'][number])=>{
  const definition=kind==='object-type'?readBusinessObjectTypeDefinition(row.body):kind==='business-view'?readBusinessViewDefinition(row.body):readBusinessActionDefinition(row.body)
  if(definition.id!==row.localId||definition.version!==row.version||definition.domain!==input.scope)fail('当前业务声明身份、版本或范围不匹配：'+row.localId)
  const existing=resources.get(row.localId);if(existing&&existing.kind!==kind)fail('当前业务声明与包内其他资源标识冲突：'+row.localId)
  const path='current/declarations/'+kind+'/'+row.localId+'.json';addFile(path,json(definition));resources.set(row.localId,{id:row.localId,kind,title:definition.title,version:definition.version,required:existing?.required??kind==='object-type',source:{kind:'local',path}})
 }
 for(const [kind,rows] of [['object-type',input.declarations.objectTypes],['business-view',input.declarations.views],['business-action',input.declarations.actions]] as const){if(new Set(rows.map(row=>row.localId)).size!==rows.length)fail('当前业务声明标识重复：'+kind);for(const row of rows)setDeclaration(kind,row)}
 const sourceIds=new Set<string>()
 for(const [index,source] of input.declarations.sources.entries()){
  if(sourceIds.has(source.sourceId))fail('当前业务数据源声明重复：'+source.sourceId);sourceIds.add(source.sourceId)
  const matching=[...resources.values()].find(resource=>resource.kind==='data-source'&&resource.source.kind==='local'&&readIndustryDataSourceDefinition(JSON.parse(decode(files.get(resource.source.path)!))).sourceId===source.sourceId)
  const original=matching?.source.kind==='local'?readIndustryDataSourceDefinition(JSON.parse(decode(files.get(matching.source.path)!))):undefined
  const definition=readIndustryDataSourceDefinition({...original,format:'teloa.data-source/v1',sourceId:source.sourceId,scopes:[input.scope],...(source.sourceNoun?{sourceNoun:source.sourceNoun}:{})}),id=matching?.id??unique('business-source-'+(index+1)),path='current/declarations/sources/'+id+'.json'
  addFile(path,json(definition));resources.set(id,{id,kind:'data-source',title:definition.sourceNoun??source.sourceId,version:matching?.version??input.packageVersion,required:matching?.required??true,source:{kind:'local',path}})
 }
 if(configuration){
  const existing=resources.get(configuration.id)
  if(existing&&existing.kind!=='business-configuration')fail('当前正式业务页面配置标识与其他资源冲突：'+configuration.id)
  const path='current/configuration/'+configuration.id+'.json'
  addFile(path,json(configuration));resources.set(configuration.id,{id:configuration.id,kind:'business-configuration',title:configuration.configuration.title,version:configuration.version,required:true,source:{kind:'local',path}})
 }
 const facade=input.english?{localized:{title:localizedMetadata({original:input.title,defaultLocale:'en',locales:{'zh-CN':input.title,en:input.english.title}}),description:localizedMetadata({original:input.description,defaultLocale:'en',locales:{'zh-CN':input.description,en:input.english.description}})}}:{}
 const manifest=validateIndustryManifest({format:'teloa.business-package/v4',id:input.packageId,version:input.packageVersion,title:input.title,description:input.description,domain:input.scope,scope:input.scope,...facade,resources:[...resources.values()].sort((a,b)=>order(a.id,b.id)),relations:relations.sort((a,b)=>order(a.kind+'\0'+a.from+'\0'+a.to,b.kind+'\0'+b.from+'\0'+b.to)),entrypoints:[...entrypoints].sort(order)})
 addFile('teloa.json',json(manifest))
 const item=await readIndustryDirectory([...files].map(([path,bytes])=>({path,size:bytes.length,read:async()=>bytes})),'teloa.json',input.title)
 validateClosure(manifest,item.packageContent!)
 const counts:Record<string,number>={};for(const resource of manifest.resources)counts[resource.kind]=(counts[resource.kind]??0)+1
 return {item,counts,fileCount:files.size}
}

/** 与宿主同样按结构字段重定向业务身份；不替换正文、SQL、对象ID或工作模板ID。 */
function redirectResourceScope(resource:IndustryResource,sourceScope:string,targetScope:string,prefix:string,files:ReadonlyMap<string,Uint8Array>,addFile:(path:string,bytes:Uint8Array)=>void,loadScope?:string):IndustryResource{
 if(sourceScope===targetScope&&(loadScope===undefined||loadScope===targetScope)||resource.source.kind!=='local'||!['object-type','business-view','business-action','work-template','data-source','business-configuration'].includes(resource.kind))return resource
 const bytes=files.get(resource.source.path)??fail('来源资源缺少包内正文：'+resource.id),raw:unknown=JSON.parse(decode(bytes))
 const domain=(value:string,allowGeneral=false)=>{if(value===targetScope||allowGeneral&&value==='general')return value;if(value!==sourceScope&&value!==loadScope)fail('资源「'+resource.title+'」包含其他业务范围，不能重定向：'+value);return targetScope}
 let projected:unknown
 if(resource.kind==='object-type'){const value=readBusinessObjectTypeDefinition(raw);projected={...value,domain:domain(value.domain)}}
 else if(resource.kind==='business-view'){const value=readBusinessViewDefinition(raw);projected={...value,domain:domain(value.domain)}}
 else if(resource.kind==='business-action'){const value=readBusinessActionDefinition(raw);projected={...value,domain:domain(value.domain)}}
 else if(resource.kind==='work-template'){
  const value=validateManifest(raw);if(value.format!=='teloa.work-template/v1')return fail('工作模板正文格式不匹配：'+resource.id)
  projected={...value,domain:domain(value.domain,true)}
 }else if(resource.kind==='data-source'){
  const value=readIndustryDataSourceDefinition(raw)
  if(!value.scopes.includes(sourceScope)&&!value.scopes.includes(targetScope)&&!(loadScope&&value.scopes.includes(loadScope)))fail('数据源「'+resource.title+'」的声明不包含本加载的业务范围。')
  // 导出当前业务的连接声明，接收方授权也只针对这一业务，不带出来源声明的其他业务。
  projected={...value,scopes:[targetScope]}
 }else{
  const value=readBusinessDashboardResource(raw),configuration=value.configuration
  if(![sourceScope,targetScope,'template',loadScope].includes(configuration.scope))fail('业务页面配置不属于本加载的业务范围：'+resource.id)
  projected=readBusinessDashboardResource({...value,configuration:{...configuration,scope:targetScope,definitions:configuration.definitions.map(row=>({...row,definition:{...row.definition,domain:targetScope}}))}})
 }
 const path=prefix+resource.id+'.json';addFile(path,json(projected));return {...resource,source:{kind:'local',path}}
}

function validateClosure(manifest:IndustryManifest,content:IndustryContent){
 const inspections=inspectIndustryContent(manifest,content),bad=inspections.find(row=>['missing','invalid','unresolved'].includes(row.state))
 if(bad)fail('完整业务包的资源无法重新导入：'+bad.id+'：'+bad.message)
 const objects=inspections.flatMap(row=>row.definition?.kind==='object-type'?[row.definition.definition]:[]),views=inspections.flatMap(row=>row.definition?.kind==='business-view'?[row.definition.definition]:[]),actions=inspections.flatMap(row=>row.definition?.kind==='business-action'?[row.definition.definition]:[]),sources=inspections.flatMap(row=>row.definition?.kind==='data-source'?[row.definition.definition]:[])
 const templates=new Map(inspections.flatMap(row=>row.definition?.kind==='work-template'?[[row.id,row.definition.manifest] as const]:[])),tools=manifest.resources.filter(row=>row.kind==='execution-tool').map(row=>row.id)
 if(objects.length||views.length||actions.length){
  // 旧声明检查器要求来源标识能作清单ID。这里只做语义闭合验证，临时映射来源名，实际文件保持原sourceId。
  const sourceNames=new Map([...new Set(sources.map(row=>row.sourceId))].sort(order).map((name,index)=>[name,'source-'+(index+1)]))
  const declared=<T extends {id:string;version:string}>(row:T)=>({localId:row.id,version:row.version,body:row})
  const checked=planBusinessSharePackage({scope:manifest.scope,packageId:manifest.id,packageVersion:manifest.version,title:manifest.title,description:manifest.description,objectTypes:objects.map(row=>declared({...row,sourceId:sourceNames.get(row.sourceId)??row.sourceId})),views:views.map(declared),actions:actions.map(declared),sources:[...sourceNames.values()].map(sourceId=>({sourceId})),available:{workTemplates:[...templates.keys()],executionTools:tools}})
  if(checked.excluded.length)fail('完整业务包存在未闭合声明：'+checked.excluded.map(row=>row.localId+'：'+row.reason).join('；'))
 }
 for(const action of actions){
  const object=objects.find(row=>row.id===action.objectType)!,target=action.target,template=templates.get(target.kind==='work-template'?target.localId:target.workTemplate)
  if(!template||template.requirements.length!==action.inputs.length)fail('业务动作「'+action.id+'」的输入数量与随包任务模板不匹配。')
  const targetField=target.kind==='execution-tool'&&target.targetFrom.from==='field'?target.targetFrom.field:undefined
  if(action.inputs.some(row=>row.from==='field'&&!object.fields.some(field=>field.name===row.field))||targetField!==undefined&&!object.fields.some(field=>field.name===targetField))fail('业务动作「'+action.id+'」引用了不存在的对象字段。')
 }
}
