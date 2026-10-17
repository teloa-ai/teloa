import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {templateShareTextIssue} from './template-share.mjs'
import {readIndustryMcpConnectionDefinition,readIndustryPluginDefinition,type IndustryMcpConnectionDefinition,type IndustryPluginDefinition} from './industry-definitions.ts'
import {readMarketCatalogEntry,type MarketCatalogConnectorEntry} from './market-catalog.ts'
import {isBusinessScopeKey} from './business-scopes.ts'

type Profile={name:string;title:string;description:string;avatarColor?:string;avatarShape?:string}
type Memory={kind:'profile'|'log';content:string;createdAt?:string}
type Skill={name:string;description:string;content:string}
type Routine=Skill&{slug:string}
type Plugin={pluginId:string;name:string;description?:string}
export type GrokRecipe={profile:Profile;memory:Memory[];skills:Skill[];routines:Routine[];plugins:Plugin[];gettingStarted?:{skill:string}}
export type GrokRecipeImport={
 format:'teloa.grok-recipe-import/v1';sourceHash:string
 skills:{resourceId:string;title:string}[]
 routines:{resourceId:string;skillResourceId:string;title:string;state:'needs-schedule'}[]
 plugins:{pluginId:string;name:string;resourceId:string;state:'needs-configuration'|'declared-not-connected'}[]
 /** `method`：原 profile 记忆另生成的固定方法技能及其对应的原 memory 下标；旧包没有该字段，不补造。 */
 memory:{resourceIds:string[];importedAs:'template-reference';method?:{resourceId:string;memoryIndexes:number[]}}
 gettingStarted?:{skill:string;skillResourceId?:string}
}
const methodResourceId='method-reference',methodTitle='模板工作准则'
export type GrokRecipePluginMapping={kind:'mcp';definition:IndustryMcpConnectionDefinition}|{kind:'plugin';definition:IndustryPluginDefinition}
export type GrokRecipeOptions={pluginMappings?:Readonly<Record<string,GrokRecipePluginMapping>>;scope?:string}
export type GrokRecipeConnectorCandidate={pluginId:string;catalogEntryId:string;catalogVersion:string;serverName:string;tools:MarketCatalogConnectorEntry['connector']['tools'];compatibility:MarketCatalogConnectorEntry['compatibility'];auth:MarketCatalogConnectorEntry['connector']['auth']}
type Resource={id:string;kind:'role'|'knowledge'|'skill'|'work-template'|'mcp'|'plugin';title:string;version:string;required:boolean;source:{kind:'local';path:string}}
export type GrokRecipePackage={
 manifest:{format:'teloa.business-package/v2';id:string;title:string;version:string;domain:string;scope:string;description:string;resources:Resource[];relations:{kind:'role-knowledge'|'role-skill'|'role-work'|'role-connection';from:string;to:string}[];entrypoints:string[]}
 manifestPath:string;hash:string;files:{path:string;hash:string;bytes:Uint8Array}[];report:GrokRecipeImport
}
const invalid=(message:string)=>new WorkError('teloa/invalid-input','Grok recipe：'+message)
const exact=(value:unknown,allowed:readonly string[],label:string)=>{
 if(!isRecord(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw invalid(label+'字段不受支持。')
 return value
}
const text=(value:unknown,label:string,max=2000):string=>{
 if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw invalid(label+'须为有效的非空文本。')
 return value
}
const list=(value:unknown,label:string):unknown[]=>{
 if(!Array.isArray(value)||value.length>100)throw invalid(label+'须为不超过100项的列表。')
 return value
}
const sha=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(bytes))),byte=>byte.toString(16).padStart(2,'0')).join('')
const encode=(value:string)=>new TextEncoder().encode(value)
// 原平台固定应用ID与已审目录服务的对照；不按上传的名字、URL或npm猜测连接器。
const connectorIds:Readonly<Record<string,readonly string[]>>={
 '48677658':['teloa.mcp-github'],'512':['teloa.mcp-linear'],'674':['teloa.mcp-slack'],
 '404':['teloa.mcp-notion-remote','teloa.mcp-notion'],'657':['teloa.mcp-figma'],'579':['teloa.mcp-sentry'],
}

/** catalog 必须取自宿主 market-catalog/list 的已审目录，不收模板作者自报的目录或配方。此对照不连接、不授权。 */
export function grokRecipeConnectorCandidates(value:unknown,catalog:readonly unknown[]):GrokRecipeConnectorCandidate[]{
 const recipe=readGrokRecipe(value),entries=catalog.map(readMarketCatalogEntry),result:GrokRecipeConnectorCandidate[]=[]
 for(const plugin of recipe.plugins)for(const id of connectorIds[plugin.pluginId]??[]){
  const entry=entries.find(entry=>entry.id===id)
  if(entry?.kind!=='connector'||entry.compatibility.status==='unsupported')continue
  result.push({pluginId:plugin.pluginId,catalogEntryId:entry.id,catalogVersion:entry.version,serverName:entry.connector.serverName,tools:entry.connector.tools,compatibility:entry.compatibility,auth:entry.connector.auth})
 }
 return result
}

/** 用户显式选择服务及已审工具，只生成现有 MCP 引用定义；OAuth、凭据和实际就绪继续走原连接器入口。 */
export function grokRecipeConnectorMapping(value:unknown,selection:{pluginId:string;catalogEntryId:string;tools:readonly string[]},catalog:readonly unknown[]):GrokRecipePluginMapping{
 const candidate=grokRecipeConnectorCandidates(value,catalog).find(row=>row.pluginId===selection.pluginId&&row.catalogEntryId===selection.catalogEntryId)
 if(!candidate)throw invalid('该应用没有所选的已审目录服务。')
 if(!selection.tools.length||selection.tools.some(name=>!candidate.tools.some(tool=>tool.name===name)))throw invalid('请显式选择目录已审工具；未列出的工具须先经原连接器核实。')
 const definition=readIndustryMcpConnectionDefinition({format:'teloa.mcp-connection/v1',serverName:candidate.serverName,tools:[...selection.tools]})
 definition.tools.sort()
 return {kind:'mcp',definition}
}

/** 仅作格式分流；完整校验仍由 readGrokRecipe 承担。 */
export const isGrokRecipe=(value:unknown):value is Record<string,unknown>=>isRecord(value)&&['profile','memory','skills','routines','plugins'].every(key=>Object.hasOwn(value,key))
export function readGrokRecipe(value:unknown):GrokRecipe{
 const row=exact(value,['profile','memory','skills','routines','plugins','gettingStarted'],'根'),profile=exact(row.profile,['name','title','description','avatarColor','avatarShape'],'profile')
 const parsedProfile:Profile={name:text(profile.name,'profile.name',80),title:text(profile.title,'profile.title',120),description:text(profile.description,'profile.description')}
 for(const field of ['avatarColor','avatarShape'] as const)if(profile[field]!==undefined)parsedProfile[field]=text(profile[field],'profile.'+field,80)
 const memory=list(row.memory,'memory').map(input=>{const value=exact(input,['kind','content','createdAt'],'memory');if(value.kind!=='profile'&&value.kind!=='log')throw invalid('memory.kind 不受支持。');return {kind:value.kind,content:text(value.content,'memory.content',128*1024),...(value.createdAt===undefined?{}:{createdAt:text(value.createdAt,'memory.createdAt',80)})} as Memory})
 const skill=(input:unknown,routine=false)=>{const value=exact(input,['name','description','content',...(routine?['slug']:[])],routine?'routine':'skill');return {name:text(value.name,'名称',120),description:text(value.description,'说明'),content:text(value.content,'正文',2*1024*1024),...(routine?{slug:text(value.slug,'routine.slug',120)}:{})}}
 const skills=list(row.skills,'skills').map(input=>skill(input)),routines=list(row.routines,'routines').map(input=>skill(input,true) as Routine)
 const plugins=list(row.plugins,'plugins').map(input=>{const value=exact(input,['pluginId','name','description'],'plugin');return {pluginId:text(value.pluginId,'pluginId',120),name:text(value.name,'plugin.name',120),...(value.description===undefined?{}:{description:text(value.description,'plugin.description')})}})
 if(new Set(plugins.map(plugin=>plugin.pluginId)).size!==plugins.length)throw invalid('pluginId 重复。')
 let gettingStarted:GrokRecipe['gettingStarted']
 if(row.gettingStarted!==undefined){const value=exact(row.gettingStarted,['skill'],'gettingStarted');gettingStarted={skill:text(value.skill,'gettingStarted.skill',120)}}
 return {profile:parsedProfile,memory,skills,routines,plugins,...(gettingStarted?{gettingStarted}:{})}
}

/** 转成现有固定内容包；不写账号、私有记忆、计划、安装目录或任何授权。 */
export async function convertGrokRecipe(raw:string,options:GrokRecipeOptions={}):Promise<GrokRecipePackage>{
 const sourceBytes=encode(raw);if(sourceBytes.length>1024*1024)throw invalid('文件不能超过1MiB。')
 // 上传来源可以保留模板作者写的路径说明；凭据仍不得进入生成包。
 const screening=raw.replace(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\|file:\/\/)/gi,'local-reference/')
 if(templateShareTextIssue(screening))throw invalid('内容可能包含凭据，请移除后重新导入。')
 let input:unknown;try{input=JSON.parse(raw)}catch{throw invalid('JSON 格式无效。')}
 const recipe=readGrokRecipe(input),sourceHash=await sha(sourceBytes),scope=options.scope??'general',version='1.0.0'
 // 目标范围由调用方从本人已有业务选择；源模板标识不能注册为一门新业务。
 if(!isBusinessScopeKey(scope))throw invalid('目标业务范围格式不正确。')
 if(recipe.memory.length+(recipe.plugins.length?1:0)>30)throw invalid('模板参考超过当前员工支持的30个知识来源，请先整理原参考内容。')
 const resources:Resource[]=[],relations:GrokRecipePackage['manifest']['relations']=[],texts=new Map<string,string>(),entrypoints:string[]=[]
 const report:GrokRecipeImport={format:'teloa.grok-recipe-import/v1',sourceHash,skills:[],routines:[],plugins:[],memory:{resourceIds:[],importedAs:'template-reference'}}
 const add=(id:string,kind:Resource['kind'],title:string,path:string,body:string|undefined,relation?:GrokRecipePackage['manifest']['relations'][number]['kind'],required=true)=>{
  resources.push({id,kind,title,version,required,source:{kind:'local',path}});if(body!==undefined)texts.set(path,body);if(relation)relations.push({kind:relation,from:'employee',to:id})
 }
 add('employee','role',recipe.profile.name,'roles/employee.json',JSON.stringify({format:'teloa.role/v1',name:recipe.profile.name,kind:'employee',duty:recipe.profile.description,dataScope:'仅使用本人明确提供或授权的资料；模板参考不代表本人记忆。',executionScope:'沿用当前会话与员工的真实授权；模板声明不授予权限，外部应用须先配置。'},null,2))
 recipe.memory.forEach((memory,index)=>{
  const id='memory-'+String(index+1).padStart(4,'0');report.memory.resourceIds.push(id)
  add(id,'knowledge','模板参考 '+(index+1),'references/'+id+'.md','# 模板参考\n\n以下内容来自模板作者，未经本人确认为私人记忆；仅供该员工按来源参考。\n\n原类型：'+memory.kind+(memory.createdAt?'\n原记录时间：'+memory.createdAt:'')+'\n\n'+memory.content,'role-knowledge')
 })
 const slug=(value:string,fallback:string,max:number)=>value.normalize('NFKD').toLowerCase().replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,max).replace(/-$/,'')||fallback
 const addSkill=async(id:string,name:string,description:string,content:string)=>{
  // 原有 frontmatter 作为原文保留在正文中；新的固定名称避免跨模板同名覆盖，不从正文继承权限。
  const suffix=(await sha(encode(sourceHash+':'+id))).slice(0,8),nativeName=slug(recipe.profile.name,'assistant',16)+'-'+slug(name,'method',28)+'-'+suffix
  const markdown='---\nname: '+nativeName+'\ndescription: '+JSON.stringify(name+' · '+description)+'\n---\n\n'+content
  add(id,'skill',name,'skills/'+id+'/SKILL.md',markdown,'role-skill');return id
 }
 for(const [index,skill]of recipe.skills.entries()){const resourceId='skill-'+String(index+1).padStart(4,'0');await addSkill(resourceId,skill.name,skill.description,skill.content);report.skills.push({resourceId,title:skill.name});entrypoints.push(resourceId)}
 // 原平台的 profile 记忆是机器人的常驻工作准则，不是私人事实：按 memory.kind 这一导入语义另生成一份固定方法技能，
 // 与其他技能走同一校验、SHA 与系统方法段；知识参考照旧保留。log 记忆只是作者日志，不进入方法；不按正文内容挑选。
 const profileIndexes=recipe.memory.flatMap((memory,index)=>memory.kind==='profile'?[index]:[])
 if(profileIndexes.length){
  const body='# '+methodTitle+'\n\n以下 '+profileIndexes.length+' 条是原模板作者的 profile 记忆（原件 recipe.json SHA-256 '+sourceHash+'），作为该员工的工作方法与行为约定遵循；它们不是本人记忆，也不授予任何工具、应用或数据权限。\n\n'
   +profileIndexes.map((index,order)=>{const memory=recipe.memory[index]!;return '## 准则 '+(order+1)+'（原 memory['+(index+1)+']'+(memory.createdAt?'，原记录时间 '+memory.createdAt:'')+'）\n\n'+memory.content}).join('\n\n')
  if(encode(body).length>2*1024*1024)throw invalid('模板 profile 记忆合计超过 2MiB，无法作为固定方法导入。')
  await addSkill(methodResourceId,methodTitle,'原模板 profile 记忆 '+profileIndexes.length+' 条，作为工作方法遵循；不代表本人记忆，不授予权限。',body)
  report.memory.method={resourceId:methodResourceId,memoryIndexes:profileIndexes}
 }
 for(const [index,routine]of recipe.routines.entries()){
  const resourceId='routine-'+String(index+1).padStart(4,'0'),skillResourceId='routine-method-'+String(index+1).padStart(4,'0')
  await addSkill(skillResourceId,routine.name,routine.description,routine.content)
  add(resourceId,'work-template',routine.name,'routines/'+resourceId+'.json',JSON.stringify({format:'teloa.work-template/v1',id:resourceId,title:routine.name,version,domain:scope,description:routine.description,requirements:['提供本次需要处理的资料；按固定方法执行，不自行启动定时任务。'],output:'按原例行任务方法返回结果，缺少应用或资料时明确说明。',skills:[{id:skillResourceId,title:routine.name,version}]},null,2),'role-work')
  report.routines.push({resourceId,skillResourceId,title:routine.name,state:'needs-schedule'});entrypoints.push(resourceId)
 }
 const mappings=options.pluginMappings??{}
 for(const key of Object.keys(mappings))if(!recipe.plugins.some(plugin=>plugin.pluginId===key))throw invalid('应用映射不属于该模板。')
 recipe.plugins.forEach((plugin,index)=>{
  const resourceId='connection-'+String(index+1).padStart(4,'0'),mapping=mappings[plugin.pluginId]
  if(mapping){const checked=exact(mapping,['kind','definition'],'应用映射');if(checked.kind!=='mcp'&&checked.kind!=='plugin')throw invalid('应用映射只支持现有MCP或固定npm扩展定义。');const definition=checked.kind==='mcp'?readIndustryMcpConnectionDefinition(checked.definition):readIndustryPluginDefinition(checked.definition);add(resourceId,checked.kind,plugin.name,'connections/'+resourceId+'.json',JSON.stringify(definition,null,2),checked.kind==='mcp'?'role-connection':undefined,false);if(checked.kind==='plugin')resources[resources.length-1]!.version=(definition as IndustryPluginDefinition).version}
  else add(resourceId,'mcp',plugin.name,'connections/'+resourceId+'.json',undefined,'role-connection',false)
  report.plugins.push({pluginId:plugin.pluginId,name:plugin.name,resourceId,state:mapping?'declared-not-connected':'needs-configuration'})
 })
 if(recipe.plugins.length)add('connection-requirements','knowledge','模板应用条件','references/connections.md','# 模板应用条件\n\n这些应用仅为原模板声明，未连接账号、未授予权限。缺少所需应用时说明条件，不声称已经读取或写入。\n\n'+recipe.plugins.map(plugin=>'- '+plugin.name+(plugin.description?'：'+plugin.description:'')).join('\n'),'role-knowledge')
 if(recipe.gettingStarted){const matches=report.skills.filter(skill=>skill.title===recipe.gettingStarted!.skill);report.gettingStarted={skill:recipe.gettingStarted.skill,...(matches.length===1?{skillResourceId:matches[0]!.resourceId}:{})}}
 if(resources.length>500||texts.size+3>500)throw invalid('转换后的资源或文件超过500项。')
 // profile 方法扩展属于新的转换包；原件身份和既有原子资源版本保持，旧固定包不会被同版本新内容替代。
 const manifest:GrokRecipePackage['manifest']={format:'teloa.business-package/v2',id:'grok-recipe-'+sourceHash.slice(0,32),title:recipe.profile.title,version:profileIndexes.length?'1.0.1':version,domain:'grok-template',scope,description:recipe.profile.description,resources,relations,entrypoints}
 texts.set('source/recipe.json',raw);texts.set('source/import.json',JSON.stringify(report,null,2));texts.set('teloa.json',JSON.stringify(manifest,null,2))
 const files=await Promise.all([...texts].sort(([a],[b])=>a<b?-1:a>b?1:0).map(async([path,text])=>{const bytes=encode(text);return {path,bytes,hash:await sha(bytes)}}))
 if(files.some(file=>file.bytes.length>2*1024*1024)||files.reduce((sum,file)=>sum+file.bytes.length,0)>20*1024*1024)throw invalid('转换内容超过文件大小限制。')
 const hash=await sha(encode(JSON.stringify({manifestPath:'teloa.json',files:files.map(file=>[file.path,file.hash])})))
 return {manifest,manifestPath:'teloa.json',hash,files,report}
}

/** 固定包回读的展示报告；校验原件摘要，报告本身不授予安装、连接或运行能力。 */
export async function grokRecipeImportFromFiles(files:readonly {path:string;bytes:Uint8Array}[],manifestPath:string):Promise<GrokRecipeImport|undefined>{
 const root=manifestPath.includes('/')?manifestPath.slice(0,manifestPath.lastIndexOf('/')+1):'',reportFile=files.find(file=>file.path===root+'source/import.json')
 if(!reportFile)return
 let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(reportFile.bytes))}catch{throw invalid('固定导入报告无法读取。')}
 if(!isRecord(value)||value.format!=='teloa.grok-recipe-import/v1')return
 const row=exact(value,['format','sourceHash','skills','routines','plugins','memory','gettingStarted'],'导入报告'),source=files.find(file=>file.path===root+'source/recipe.json')
 if(!source||typeof row.sourceHash!=='string'||!/^[a-f0-9]{64}$/.test(row.sourceHash)||await sha(source.bytes)!==row.sourceHash)throw invalid('固定原件与导入报告摘要不一致。')
 const resourceId=(value:unknown)=>{const id=text(value,'资源标识',120);if(!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(id))throw invalid('资源标识无效。');return id}
 const skills=list(row.skills,'报告.skills').map(input=>{const value=exact(input,['resourceId','title'],'报告.skill');return {resourceId:resourceId(value.resourceId),title:text(value.title,'技能标题',120)}})
 const routines=list(row.routines,'报告.routines').map(input=>{const value=exact(input,['resourceId','skillResourceId','title','state'],'报告.routine');if(value.state!=='needs-schedule')throw invalid('例行任务报告不能声明已启用。');return {resourceId:resourceId(value.resourceId),skillResourceId:resourceId(value.skillResourceId),title:text(value.title,'例行标题',120),state:'needs-schedule' as const}})
 const plugins=list(row.plugins,'报告.plugins').map(input=>{const value=exact(input,['pluginId','name','resourceId','state'],'报告.plugin');if(value.state!=='needs-configuration'&&value.state!=='declared-not-connected')throw invalid('应用报告不能声明已连接。');return {pluginId:text(value.pluginId,'应用身份',120),name:text(value.name,'应用名称',120),resourceId:resourceId(value.resourceId),state:value.state as GrokRecipeImport['plugins'][number]['state']}})
 const memory=exact(row.memory,['resourceIds','importedAs','method'],'报告.memory');if(memory.importedAs!=='template-reference')throw invalid('模板参考不能声明为本人记忆。')
 let method:NonNullable<GrokRecipeImport['memory']['method']>|undefined
 if(memory.method!==undefined){const value=exact(memory.method,['resourceId','memoryIndexes'],'报告.memory.method');if(!Array.isArray(value.memoryIndexes)||value.memoryIndexes.some(index=>!Number.isSafeInteger(index)||(index as number)<0))throw invalid('报告.memory.method 下标无效。');method={resourceId:resourceId(value.resourceId),memoryIndexes:value.memoryIndexes as number[]}}
 let gettingStarted:GrokRecipeImport['gettingStarted']
 if(row.gettingStarted!==undefined){const value=exact(row.gettingStarted,['skill','skillResourceId'],'报告.gettingStarted');gettingStarted={skill:text(value.skill,'开始技能',120),...(value.skillResourceId===undefined?{}:{skillResourceId:resourceId(value.skillResourceId)})}}
 const memoryIds=list(memory.resourceIds,'报告.memory.resourceIds').map(resourceId)
 let original:GrokRecipe;try{original=readGrokRecipe(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(source.bytes)))}catch{throw invalid('固定原件格式无法核对。')}
 const numbered=(prefix:string,index:number)=>prefix+String(index+1).padStart(4,'0')
 if(skills.length!==original.skills.length||skills.some((row,index)=>row.resourceId!==numbered('skill-',index)||row.title!==original.skills[index]!.name)||routines.length!==original.routines.length||routines.some((row,index)=>row.resourceId!==numbered('routine-',index)||row.skillResourceId!==numbered('routine-method-',index)||row.title!==original.routines[index]!.name)||plugins.length!==original.plugins.length||plugins.some((row,index)=>row.resourceId!==numbered('connection-',index)||row.pluginId!==original.plugins[index]!.pluginId||row.name!==original.plugins[index]!.name)||memoryIds.length!==original.memory.length||memoryIds.some((id,index)=>id!==numbered('memory-',index)))throw invalid('导入报告与原件资源身份或内容声明不一致。')
 if(gettingStarted?.skill!==original.gettingStarted?.skill||gettingStarted?.skillResourceId!==undefined&&!skills.some(row=>row.resourceId===gettingStarted.skillResourceId&&row.title===gettingStarted.skill))throw invalid('开始技能与固定原件不一致。')
 // 声明了方法技能的包：下标必须正好是原件里的 profile 记忆，且技能文件确实在包内；没声明的旧包按原样回读，不补造。
 if(method){
  const profileIndexes=original.memory.flatMap((memory,index)=>memory.kind==='profile'?[index]:[])
  if(method.resourceId!==methodResourceId||JSON.stringify(method.memoryIndexes)!==JSON.stringify(profileIndexes)||!files.some(file=>file.path===root+'skills/'+methodResourceId+'/SKILL.md'))throw invalid('导入报告与原件资源身份或内容声明不一致。')
 }
 return {format:'teloa.grok-recipe-import/v1',sourceHash:row.sourceHash,skills,routines,plugins,memory:{resourceIds:memoryIds,importedAs:'template-reference',...(method?{method}:{})},...(gettingStarted?{gettingStarted}:{})}
}
