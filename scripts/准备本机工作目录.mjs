import {createHash,randomUUID} from 'node:crypto'
import {readdir,readFile} from 'node:fs/promises'
import {basename,join,relative,resolve} from 'node:path'
import {
 ArtifactService,BusinessDataService,BusinessSpaceService,BusinessTaskService,CollaborationService,IndustryDataSourceService,IndustryDataSourceSource,
 IndustryExecutionToolService,IndustryExecutionToolSource,IndustryLoadService,MarketContentStore,PlanOccurrenceService,PlanService,RoleService,SecurityActionAttentionService,
 SecurityActionService,SecurityRequestJournal,TaskAttentionService,
 RoleMemoryService,TaskMaterialService,TaskRunPresetError,TaskRunService,TaskService,TaskTransitions,
 createIndustryLoadSource,createSecurityEndpointIsolateDefinition,markdownKnowledgeReferenceId,openResourceDatabase,taskArtifactSource,
} from '../packages/backend/src/index.ts'
import {compareIndustryUpdateCore,industryUpdateCanonical} from '../packages/contract/src/index.ts'
import {ensureFormalMarketTemplate} from './准备正式技能能力数据.mjs'
import {summarizePreparedPlanHistory} from './核对本机计划运行记录.mjs'
import {ensureNamedSeedRole,preserveSeedObjectNames,seedRoleNames} from './种子同事姓名.mjs'

const ownerId='local:teloa-owner',scopeIds=['general','SOC','AppSec']
const resourceActor={ownerId,kind:'human',scopeIds},businessActor={ownerId,scopeIds:['SOC','AppSec']}
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const database=await openResourceDatabase(resolve(process.env.TELOA_RUNTIME_ROOT||'.runtime/teloa','database.json'),identity),{pool}=database

// 种子身份固定；展示名变更通过原请求兼容处理，不换盐复制整套数据。
const seedSchemaVersion='v3'
function requestId(name){
 const bytes=Buffer.from(createHash('sha256').update(`teloa-local-workspace:${seedSchemaVersion}:${name}`).digest().subarray(0,16))
 bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128
 const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}

const knowledgeDefinitions=[
 {key:'team-conventions',folder:'通用工作',title:'团队协作约定',category:'business-context',topics:['协作','交付'],scopeIds:['general'],markdown:`# 团队协作约定

## 工作如何流转

1. 用明确目标创建任务，并写清验收条件。
2. 数字员工只读取任务范围内已授权的资料和业务对象。
3. 证据不足、结论冲突或动作越过授权边界时，回到「需要你」。
4. 交付时说明结论、依据、尚未确认的部分和下一步。

## 记录原则

事实、推断和建议分开书写。引用可能变化的内容时固定版本。对外发送、生产变更和不可逆操作由本人完成最终确认。
`,revisedMarkdown:`# 团队协作约定

> 当前版本补充了交付检查表；历史版本仍可从右上角的版本记录查看。

## 工作如何流转

1. 用明确目标创建任务，并写清验收条件。
2. 数字员工只读取任务范围内已授权的资料和业务对象。
3. 证据不足、结论冲突或动作越过授权边界时，回到「需要你」。
4. 交付时说明结论、依据、尚未确认的部分和下一步。

## 交付检查

| 检查项 | 要求 |
| --- | --- |
| 事实 | 能回到固定资料、业务对象或运行记录 |
| 推断 | 明确成立前提和仍存在的疑点 |
| 动作 | 对外发送、生产变更和不可逆操作由本人确认 |

- [ ] 已固定引用版本
- [ ] 已说明未确认事项
- [ ] 已写明下一步与负责人

## 记录原则

事实、推断和建议分开书写。引用可能变化的内容时固定版本。对外发送、生产变更和不可逆操作由本人完成最终确认。
`},
 {key:'soc-playbook',folder:'安全运营',title:'SOC 告警调查手册',category:'sop',topics:['SOC','告警调查'],scopeIds:['SOC'],markdown:`# SOC 告警调查手册

## 调查顺序

1. 核对告警来源、规则、首次出现和最近变化。
2. 关联主机、账号、进程、网络连接和同类历史事件。
3. 区分已知维护、配置偏差、误报和真实攻击活动。
4. 同时记录支持结论的证据与仍无法解释的矛盾点。
5. 给出结论、置信度、影响范围和建议动作。

## 必须回流

- 缺少关键日志或资产负责人。
- 建议隔离、封禁、删除或生产变更。
- 证据互相冲突，尚未达到处置判据。
`},
 {key:'soc-criteria',folder:'安全运营',title:'安全告警判据',category:'criteria',topics:['SOC','判据'],scopeIds:['SOC'],markdown:`# 安全告警判据

## 高可信恶意

同时满足行为异常、上下文不符合维护窗口，并且至少有一项独立证据可以复核。

## 已确认维护

变更单、负责人确认与实际行为三者一致，且影响范围没有超出计划边界。

## 继续核对

关键日志缺失、资产归属不明、同一证据支持多种解释，或建议动作会影响生产环境时，不得直接关闭。
`},
 {key:'appsec-criteria',folder:'应用安全',title:'AppSec 代码审计判据',category:'criteria',topics:['AppSec','代码审计'],scopeIds:['AppSec'],markdown:`# AppSec 代码审计判据

## 有效发现

至少包含可定位的代码路径、可复现的输入路径、成立前提、影响说明和修复建议。

## 风险判断

核对可利用性、影响、暴露面、现有缓解措施和修复截止。仅命中危险函数但输入不可控，或缺少调用上下文时，不直接判定为漏洞。
`},
]

async function ensureKnowledge(){
 const treeService=database.knowledgeTree,folders={},resources={}
 let tree=await treeService.list(resourceActor,{})
 for(const title of ['通用工作','安全运营','应用安全']){
  let folder=tree.nodes.find(node=>node.type==='folder'&&node.parentId===tree.space.rootNodeId&&node.title===title)
  if(!folder){const created=await treeService.createFolder(resourceActor,{requestId:requestId('knowledge-folder:'+title),parentId:tree.space.rootNodeId,title,expectedDirectoryRevision:tree.space.directoryRevision});folder=created.node;tree=await treeService.list(resourceActor,{})}
  folders[title]=folder
 }
 const items=await database.knowledge.list(resourceActor,{}),directory=await database.service.list(resourceActor)
 for(const definition of knowledgeDefinitions){
  const knowledgeRequestId=requestId('knowledge:'+definition.key)
  const owned=(await pool.query('select id from teloa_knowledge_items where owner_id=$1 and request_id=$2',[ownerId,knowledgeRequestId])).rows[0]
  let item=owned?items.find(value=>value.id===owned.id):undefined
  if(owned&&!item)throw Error('本机固定知识存在，但当前主体无法按固定身份读取：'+definition.key)
  let saved
  if(item){saved={item,version:await database.knowledge.readVersion(resourceActor,{knowledgeId:item.id,version:item.currentVersion})}}
  else{
   tree=await treeService.list(resourceActor,{})
   const folder=folders[definition.folder]
   saved=await database.knowledge.createPaste(resourceActor,{requestId:knowledgeRequestId,title:definition.title,category:definition.category,topics:definition.topics,scopeIds:definition.scopeIds,markdown:definition.markdown,parentId:folder.id,expectedDirectoryRevision:tree.space.directoryRevision})
   item=saved.item;items.push(item);tree=await treeService.list(resourceActor,{})
  }
  let page=tree.nodes.find(node=>node.type==='page'&&node.knowledgeId===saved.item.id),folder=folders[definition.folder]
  if(page&&page.parentId!==folder.id){await treeService.moveNode(resourceActor,{requestId:requestId('knowledge-move:'+definition.key),nodeId:page.id,parentId:folder.id,expectedDirectoryRevision:tree.space.directoryRevision});tree=await treeService.list(resourceActor,{})}
  const sourceId=markdownKnowledgeReferenceId(saved.item.id)
  let resource=directory.resources.find(value=>value.status==='active'&&value.sourceId===sourceId&&value.sourceVersion===saved.version.contentHash)
  if(!resource){
   if(saved.item.currentVersion>1)throw Error('知识已有修订版本但缺少对应的可引用资料投影：'+definition.key)
   const draft=await database.service.create(resourceActor,{requestId:requestId('resource:'+definition.key),title:definition.title,sourceId,sourceVersion:saved.version.contentHash,scopeIds:definition.scopeIds})
   resource=draft.status==='applied'?await database.service.getResource(resourceActor,{resourceId:draft.resourceId}):await database.service.apply(resourceActor,{draftId:draft.id,expectedVersion:draft.version})
   directory.resources.push(resource)
  }
  if(definition.revisedMarkdown&&saved.item.currentVersion===1){
   const revised=await database.knowledgeResources.revise(resourceActor,{requestId:requestId('knowledge-revision:'+definition.key),knowledgeId:saved.item.id,expectedKnowledgeVersion:1,resourceId:resource.id,expectedResourceVersion:resource.version,markdown:definition.revisedMarkdown})
   saved=revised.knowledge;resource=revised.resource;directory.resources.push(resource)
  }
  let fixedProjection
  if(definition.revisedMarkdown){
   const revision=(await pool.query('select knowledge_id,knowledge_version,resource_id from teloa_knowledge_resource_revisions where owner_id=$1 and request_id=$2',[ownerId,requestId('knowledge-revision:'+definition.key)])).rows[0]
   if(!revision||revision.knowledge_id!==saved.item.id||revision.knowledge_version!==2)throw Error('本机固定知识缺少预置的第二版资料投影：'+definition.key)
   fixedProjection=await database.service.getResource(resourceActor,{resourceId:revision.resource_id})
  }else{
   const draft=(await pool.query("select resource_id from teloa_resource_drafts where owner_id=$1 and request_id=$2 and status='applied'",[ownerId,requestId('resource:'+definition.key)])).rows[0]
   if(!draft?.resource_id)throw Error('本机固定知识缺少最初的资料投影：'+definition.key)
   fixedProjection=await database.service.getResource(resourceActor,{resourceId:draft.resource_id})
  }
  if(fixedProjection.sourceId!==sourceId)throw Error('本机固定知识资料投影指向了其他来源：'+definition.key)
  // 岗位定义继续引用本 seed 当时固定的资料版本；用户后续 v3+ 不会改写同一岗位创建请求。
  resources[definition.key]=fixedProjection
 }
 tree=await treeService.list(resourceActor,{})
 return {resources,summary:{folders:tree.nodes.filter(node=>node.type==='folder').length,pages:tree.nodes.filter(node=>node.type==='page').length,versionedPages:knowledgeDefinitions.filter(definition=>definition.revisedMarkdown).length}}
}

const responsibility={triggers:['收到明确目标或被分配任务'],autonomousActions:['读取获准资料并整理事实、证据与候选结论'],confirmationPoints:['对外发送、生产变更或高风险动作前交回本人确认'],escalationRules:['证据不足、范围不清或结论冲突时说明阻塞并回流'],deliveryChecks:['交付包含结论、依据、未确认事项和下一步']}

async function ensureRoles(resources){
 const service=new RoleService(pool,identity);await service.ensurePersonalTwin(ownerId)
 const definitions=[
  {key:'lin-xi',name:seedRoleNames['lin-xi'].name,scopes:['SOC'],duty:'调查安全告警，归并证据并形成可复核的判断。',dataScope:'安全运营范围内已授权的告警、资产、事件和调查资料。',executionScope:'可自主读取、关联与代拟；隔离、封禁和生产变更必须由本人确认。',skills:[],knowledge:[resources['soc-playbook'].id,resources['soc-criteria'].id]},
  {key:'zhou-heng',name:seedRoleNames['zhou-heng'].name,scopes:['SOC'],duty:'复核高风险告警的判断依据与处置建议。',dataScope:'安全运营范围内已授权的告警、调查结论和判据。',executionScope:'可复核和代拟审批意见；不得代替本人批准高风险动作。',skills:[],knowledge:[resources['soc-criteria'].id,resources['team-conventions'].id]},
  {key:'cheng-jian',name:seedRoleNames['cheng-jian'].name,scopes:['AppSec'],duty:'审计应用安全问题，定位影响路径并推动修复闭环。',dataScope:'应用安全范围内已授权的代码发现、应用、漏洞和修复工单。',executionScope:'可分析、归类和代拟修复建议；代码合并与生产发布由本人确认。',skills:[],knowledge:[resources['appsec-criteria'].id,resources['team-conventions'].id]},
 ]
 const roles={}
 for(const {key,...fields} of definitions)roles[key]=await ensureNamedSeedRole({pool,service,ownerId,key,requestId:requestId('role:'+key),fields:{...fields,kind:'employee',responsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}})
 return roles
}

const fixedContentNotice='本机固定内容，仅用于展示结构，不表示外部连接已就绪。'
const fixedContentNoticeEn='Local fixed content for structural display only; it does not indicate that external connections are ready.'
const approvedLocalDirectoryAdditions={
 'security-operations':new Set([
  'alert-ticket','incident-ticket','asset',
  'soc-risk-distribution','soc-pending-board','soc-alert-trend','soc-alert-list','soc-incident-list','soc-asset-list',
  'assign-alert-review','isolate-endpoint','alert-triage-review','endpoint-isolation-record',
 ]),
}
const localizedBusinessKinds=new Set(['object-type','business-view','business-action','work-template'])

/**
 * 本机固定行业包的本地化补丁可以自动升级，但先逐字证明每个资源除了顶层 patch 版本与
 * 任意层级的 `localized` 外完全相同。这样 3100 能拿到新语言，同时不会把业务规则、筛选、
 * 动作目标或工作要求的稳定原文伪装成“翻译更新”带过去。
 */
function withoutLocalization(value,top=true){
 if(Array.isArray(value))return value.map(item=>withoutLocalization(item,false))
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='localized'&&!(top&&key==='version')).map(([key,item])=>[key,withoutLocalization(item,false)]))
 return value
}
function nextPatch(before,after){
 const left=String(before).match(/^(\d+)\.(\d+)\.(\d+)$/),right=String(after).match(/^(\d+)\.(\d+)\.(\d+)$/)
 return !!left&&!!right&&left[1]===right[1]&&left[2]===right[2]&&Number(right[3])===Number(left[3])+1
}
function localDefinition(content,localId){
 const manifest=content.metadata,resource=manifest.resources?.find(item=>item.id===localId)
 if(!resource||resource.source?.kind!=='local')return undefined
 const root=content.manifestPath.includes('/')?content.manifestPath.slice(0,content.manifestPath.lastIndexOf('/')+1):''
 const file=content.files.find(item=>item.path===root+resource.source.path)
 if(!file)return undefined
 try{return {resource,definition:JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes))}}catch{return undefined}
}
function localizationOnlyChange(beforeContent,afterContent,change){
 if(change.change!=='changed'||!localizedBusinessKinds.has(change.kind))return false
 const before=localDefinition(beforeContent,change.id),after=localDefinition(afterContent,change.id)
 if(!before||!after||!nextPatch(before.resource.version,after.resource.version)||!nextPatch(before.definition.version,after.definition.version))return false
 const beforeResource={...before.resource},afterResource={...after.resource};delete beforeResource.version;delete afterResource.version
 return industryUpdateCanonical(beforeResource)===industryUpdateCanonical(afterResource)
  &&industryUpdateCanonical(withoutLocalization(before.definition))===industryUpdateCanonical(withoutLocalization(after.definition))
}

const approvedLocalPositioning={}

function withFixedContentNotice(manifest){
 manifest.description=`${fixedContentNotice}${manifest.description}`
 if(manifest.localized?.description){
  manifest.localized.description.original=manifest.description
  for(const [locale,value] of Object.entries(manifest.localized.description.locales??{})){
   if(typeof value!=='string')continue
   const notice=locale.toLowerCase().startsWith('zh')?fixedContentNotice:fixedContentNoticeEn
   manifest.localized.description.locales[locale]=`${notice}${locale.toLowerCase().startsWith('zh')?'':' '}${value}`
  }
 }
 return manifest
}

async function packageFiles(directory){
 const files=[]
 let manifest
 async function walk(current){for(const entry of await readdir(current,{withFileTypes:true})){const absolute=join(current,entry.name);if(entry.isDirectory())await walk(absolute);else{const path=relative(directory,absolute).split('\\').join('/');let bytes=await readFile(absolute);if(path==='teloa.json'){manifest=withFixedContentNotice(JSON.parse(bytes.toString('utf8')));bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n')}files.push({path,bytes})}}}
 await walk(directory)
 if(!manifest)throw Error(`本机${basename(directory)}目录缺少 teloa.json。`)
 return {manifest,files:files.sort((left,right)=>left.path.localeCompare(right.path))}
}

/**
 * 市场条目从测试夹具换成示例合包之后，旧的 `soc-ledger` / `appsec-ledger` 活动加载再也不会出现在
 * 任何一次导入的 `templateId` 里，因此 `ensureIndustry` 的 stale 判定（同 templateId 不同内容）
 * 认不出它们：已有 `.runtime` 上重跑，旧台账会与新包在同一业务范围里各留一条活动加载，
 * 同名 object-type 跨加载冲突，台账整条读不出来。这里按 templateId 显式退役，走正式卸载服务
 * （解除四类实例、删 Skill 使用关系、暂停计划、落 unloaded 状态），不直接删表。
 */
const retiredLedgerTemplateIds=['soc-ledger','appsec-ledger']
async function retireFixtureLedgerLoads(){
 const market=new MarketContentStore(pool,identity)
 const loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market),new PlanService(pool,identity))
 const stale=(await loads.list(ownerId,{})).items.filter(load=>load.status==='active'&&retiredLedgerTemplateIds.includes(load.templateId))
 for(const load of stale){
  const unloaded=await loads.unload(ownerId,{requestId:requestId('retire-fixture-ledger:'+load.templateId),loadId:load.id,expectedMappingHash:load.mappingHash})
  if(unloaded.status!=='unloaded')throw Error(`旧台账加载 ${load.templateId} 未能卸载，初始化不能与它并存。`)
 }
 return stale.map(load=>load.templateId)
}

async function ensureIndustry(key,directory){
 const market=new MarketContentStore(pool,identity),{manifest,files}=await packageFiles(directory)
 const imported=await market.import({ownerId,kind:'human'},{kind:'industry-template',requestId:requestId(`market:${key}:${manifest.version}`),source:{kind:'upload',name:`本机固定${basename(directory)}目录（仅用于展示结构，不表示外部连接已就绪）`},manifestPath:'teloa.json',files,references:[]})
 const source=createIndustryLoadSource(market),loads=new IndustryLoadService(pool,identity,source)
 const currentLoads=(await loads.list(ownerId,{})).items
 /**
  * 认领与 stale 判定都按 `contentHash`，不按 `contentId`：市场内容的唯一键含来源指纹
  *（`unique(owner_id,kind,logical_id,version,content_hash,trust_hash)`），同一批字节换个来源名就会多出一行
  * 内容、拿到另一个 contentId；而加载表的唯一键是 `unique(owner_id,space_id,content_hash)`。
  * 按 contentId 认领会在旧 `.runtime` 上同时判成「没认领到」和「不是 stale 的新内容」，
  * 于是既走不了升级（同版本），又建不了新加载（同字节已占用唯一键），整条初始化卡死。
  * 换市场条目时真会撞上：旧库里的 `security-operations` 是被退役的能力目录那条路径导入的，
  * 字节逐字相同、只有来源名不同。按字节认领即可原样沿用，不必卸载重建。
  */
 const stale=currentLoads.find(value=>value.status==='active'&&value.templateId===imported.content.logicalId&&value.contentHash!==imported.content.hash)
 let load=currentLoads.find(value=>value.status==='active'&&value.contentHash===imported.content.hash)
 if(!load&&stale){
  const baselineSnapshot=await source.read(ownerId,stale.contentId,stale.contentHash),candidateSnapshot=await source.read(ownerId,imported.content.id,imported.content.hash)
  const withoutVersion=value=>{const copy=structuredClone(value);delete copy.templateVersion;return copy}
  if(!source.content)throw Error(`本机${basename(directory)}目录缺少固定内容读取能力，不能完成元数据升级。`)
  const baseline=await source.content(ownerId,stale.contentId),candidate=await source.content(ownerId,imported.content.id),diff=compareIndustryUpdateCore(baseline,candidate)
  const changed=diff.resources.filter(item=>item.change!=='unchanged')
  const allowed=approvedLocalDirectoryAdditions[manifest.id]
  const metadataOnly=industryUpdateCanonical(withoutVersion(baselineSnapshot))===industryUpdateCanonical(withoutVersion(candidateSnapshot))
  const approvedDirectoryCompletion=!!allowed&&changed.length===allowed.size&&changed.every(item=>item.change==='added'&&allowed.has(item.id))&&!diff.relationsChanged&&!diff.entrypointsChanged&&!diff.positioningChanged&&!diff.kindChanges.length
  const [baselineContent,candidateContent]=await Promise.all([
   market.get({ownerId,kind:'human'},{contentId:stale.contentId}),
   market.get({ownerId,kind:'human'},{contentId:imported.content.id}),
  ])
  const localizedChanges=new Set(changed.filter(item=>localizationOnlyChange(baselineContent,candidateContent,item)).map(item=>item.id))
  const approvedRename=approvedLocalPositioning[manifest.id]
  const positioningSafe=!diff.positioningChanged||(!!approvedRename&&baseline.manifest.title===approvedRename.before&&candidate.manifest.title===approvedRename.after&&baseline.manifest.description===candidate.manifest.description)
  const approvedLocalizedCompletion=changed.length>0&&changed.every(item=>(item.change==='added'&&!!allowed?.has(item.id))||localizedChanges.has(item.id))&&!diff.relationsChanged&&!diff.entrypointsChanged&&positioningSafe&&!diff.kindChanges.length
  if(!metadataOnly&&!approvedDirectoryCompletion&&!approvedLocalizedCompletion)throw Error(`本机${basename(directory)}目录的业务结构已经变化，必须在界面中核对升级差异。`)
  const resources=Object.fromEntries(changed.map(item=>[item.id,item.change==='added'||localizedChanges.has(item.id)?'candidate':item.change==='removed'?'skip':'keep']))
  load=(await loads.upgrade(ownerId,{requestId:requestId(`upgrade:${key}:${manifest.version}`),loadId:stale.id,candidateContentId:imported.content.id,expectedMappingHash:stale.mappingHash,choices:{resources,roles:{},relations:'keep',entrypoints:'keep',positioning:diff.positioningChanged?'candidate':'keep'}})).successor
 }
 if(!load){const space=(await pool.query("select id,version from teloa_business_spaces where owner_id=$1 and kind='personal'",[ownerId])).rows[0];if(!space)throw Error('本人工作空间尚未准备。');load=await loads.create(ownerId,{requestId:requestId('load:'+key),contentId:imported.content.id,contentHash:imported.content.hash,target:{kind:'existing',spaceId:space.id,expectedVersion:space.version}})}
 const service=new IndustryDataSourceService(pool,identity,loads,new IndustryDataSourceSource(market,loads),{ready:async()=>({ready:false,reason:'本机固定目录只登记声明；尚未连接并核验真实数据源。'})}),sourceItem=load.items.find(item=>item.kind==='data-source')
 if(sourceItem){
  const sourceIdentity=sourceItem.carriedFrom??sourceItem.instanceId
  const current=(await service.list(ownerId,{})).items.find(item=>item.itemInstanceId===sourceIdentity)
  const instance=current??await service.instantiate(ownerId,{requestId:requestId('source:'+key),loadId:load.id,itemInstanceId:sourceItem.instanceId})
  if(instance.state!=='needs_authorization'||instance.binding!==null)throw Error(`本机${basename(directory)}数据源已处于非待连接状态；初始化不能伪造或沿用授权结果。`)
 }
 const toolItem=load.items.find(item=>item.kind==='execution-tool')
 if(!toolItem)return {load,dataSourceInstances:sourceItem?1:0,activeDataSources:0,executionTools:0,activeExecutionTools:0}
 const toolIdentity=fixedIdentity('industry-tool:'+key,'2026-09-19T03:10:00.000Z')
 const tools=new IndustryExecutionToolService(pool,toolIdentity,loads,new IndustryExecutionToolSource(market,loads),{ready:async()=>({ready:false,reason:'本机固定目录只登记声明；尚未连接并核验真实执行工具。'})})
 const toolIdentityValue=toolItem.carriedFrom??toolItem.instanceId
 const current=(await tools.list(ownerId,{})).items.find(item=>item.itemInstanceId===toolIdentityValue)
 const instance=current??await tools.instantiate(ownerId,{requestId:requestId('execution-tool:'+key),loadId:load.id,itemInstanceId:toolItem.instanceId})
 if(instance.state!=='needs_authorization'||instance.binding!==null)throw Error(`本机${basename(directory)}执行工具已处于非待连接状态；初始化不能伪造或沿用授权结果。`)
 return {load,dataSourceInstances:sourceItem?1:0,activeDataSources:0,executionTools:1,activeExecutionTools:0}
}

const iso=value=>new Date(value).toISOString()
const object=(scope,type,id,title,source,observedAt,summary,fields)=>({scope,type,id,version:1,title,source,observedAt:iso(observedAt),receivedAt:iso('2026-09-19T02:55:00Z'),quality:'complete',summary:`本机固定快照，仅用于展示结构，不表示外部连接已就绪。${summary}`,fields:Object.entries(fields).map(([label,value])=>({label,value:String(value)}))})

const socObjects=[
 object('SOC','alert-ticket','evt-1842','生产主机出现异常 PowerShell','security-alert-http','2026-09-19T01:24:00Z','生产主机连续执行编码 PowerShell，并与新注册域名建立连接。',{'严重度':'高','主机':'api-prod-03','当前判定':'正在核对','首次出现':iso('2026-09-19T01:24:00Z'),'最近变化':iso('2026-09-19T02:38:00Z'),'涉及账号数':'2','关联调查':'SOC-2026-0042'}),
 object('SOC','alert-ticket','evt-1843','服务账号从新位置登录','security-alert-http','2026-09-19T01:42:00Z','支付服务账号从未登记的网络位置登录，等待核对变更窗口。',{'严重度':'高','主机':'gateway-prod-01','当前判定':'等你确认','首次出现':iso('2026-09-19T01:42:00Z'),'最近变化':iso('2026-09-19T02:47:00Z'),'涉及账号数':'1','关联调查':'SOC-2026-0042'}),
 object('SOC','alert-ticket','evt-1844','文件服务器短时大量读取','security-alert-http','2026-09-19T00:58:00Z','文件服务器发生集中读取，资产负责人尚未补齐。',{'严重度':'中','主机':'srv-file-02','当前判定':'还没有人看','首次出现':iso('2026-09-19T00:58:00Z'),'最近变化':iso('2026-09-19T02:12:00Z'),'涉及账号数':'4'}),
 object('SOC','alert-ticket','evt-1845','备份窗口内的端口扫描','security-alert-http','2026-09-18T23:30:00Z','行为与已登记备份巡检窗口一致，证据已经核对。',{'严重度':'低','主机':'backup-01','当前判定':'已确认维护','首次出现':iso('2026-09-18T23:30:00Z'),'最近变化':iso('2026-09-19T01:18:00Z'),'涉及账号数':'1'}),
 object('SOC','incident-ticket','SOC-2026-0042','生产服务异常访问调查','security-alert-http','2026-09-19T01:35:00Z','两条高风险告警已经归并，正在核对账号与主机行为。',{'当前状态':'正在处理','负责同事':seedRoleNames['lin-xi'].name,'立案时间':iso('2026-09-19T01:35:00Z'),'用到的对象数':'5','涉及资产':'api-prod-03'}),
 object('SOC','asset','api-prod-03','api-prod-03','security-alert-http','2026-09-01T02:00:00Z','核心 API 生产主机，负责人和资产等级信息完整。',{'环境':'生产','负责人':'平台工程组','资产等级':'重要','接入时间':iso('2026-08-12T03:00:00Z')}),
 object('SOC','asset','srv-file-02','srv-file-02','security-alert-http','2026-09-01T02:00:00Z','共享文件服务器，当前缺少明确负责人。',{'环境':'生产','负责人':'待补充','资产等级':'一般','接入时间':iso('2026-08-18T03:00:00Z')}),
]
const appsecObjects=[
 object('AppSec','application','payment-api','支付 API','appsec-finding-http','2026-09-15T02:00:00Z','核心支付接口，归属支付平台组。',{'环境':'生产','重要级别':'核心','负责团队':'支付平台组','仓库':'payment/payment-api'}),
 object('AppSec','application','gateway','统一网关','appsec-finding-http','2026-09-15T02:00:00Z','统一入口网关，承载外部 API 流量。',{'环境':'生产','重要级别':'核心','负责团队':'平台工程组','仓库':'platform/gateway'}),
 object('AppSec','vulnerability','APP-F-17','支付回调缺少重放校验','appsec-finding-http','2026-09-18T06:20:00Z','回调签名有效，但缺少时间窗与一次性标识校验。',{'风险等级':'高','修复状态':'修复中','所属应用':'payment-api','CVSS':'8.1','CWE':'CWE-294','发现时间':iso('2026-09-18T06:20:00Z'),'最近变化':iso('2026-09-19T02:20:00Z'),'修复截止':iso('2026-09-22T10:00:00Z')}),
 object('AppSec','vulnerability','APP-F-18','网关调试接口暴露','appsec-finding-http','2026-09-18T08:10:00Z','预发调试接口可被外部访问，需要确认生产配置是否同源。',{'风险等级':'严重','修复状态':'未修复','所属应用':'gateway','CVSS':'9.0','CWE':'CWE-489','发现时间':iso('2026-09-18T08:10:00Z'),'最近变化':iso('2026-09-19T01:50:00Z'),'修复截止':iso('2026-09-20T10:00:00Z')}),
 object('AppSec','vulnerability','APP-F-11','日志字段包含会话标识','appsec-finding-http','2026-09-15T04:45:00Z','日志脱敏已经完成并通过复核。',{'风险等级':'中','修复状态':'已修复','所属应用':'payment-api','CVSS':'5.3','CWE':'CWE-532','发现时间':iso('2026-09-15T04:45:00Z'),'最近变化':iso('2026-09-18T09:40:00Z'),'修复截止':iso('2026-09-25T10:00:00Z')}),
 object('AppSec','fix-ticket','FIX-2026-0017','修复支付回调重放校验','appsec-finding-http','2026-09-18T07:00:00Z','修复分支已建立，等待补充回归测试。',{'当前状态':'修复中','关联漏洞':'APP-F-17','负责同事':seedRoleNames['cheng-jian'].name,'承诺完成':iso('2026-09-21T10:00:00Z')}),
]

// 正式页面只汇总领域服务返回的持久事实。这组固定记录由本机工作目录准备命令幂等创建，
// 不进入客户端假数组，也不挂到 dev:dsh 启动链路。
const attentionActionSeeds=[
 {key:'host-verdict-1846',objectId:'evt-1846',version:1,asset:'api-prod-03',observedAt:'2026-09-19T01:24:00Z',changedAt:'2026-09-19T02:38:00Z',title:'确认生产主机调查结论',summary:'异常脚本与外联证据已固定，等待核对隔离范围。',action:'隔离异常外联主机'},
]
const attentionFailureSeeds=[
 {key:'run-config',scope:'AppSec',role:'cheng-jian',title:'为代码审计任务选择运行配置',goal:'当前本机未配置该任务所需的运行配置；选择可用配置后再启动。'},
]

async function persistObjects(sourceId,scope,items){const page={schema:'teloa.data-source-page/v1',sourceId,scope,capturedAt:'2026-09-19T03:00:00.000Z',items:await preserveSeedObjectNames(pool,ownerId,items)};return new BusinessDataService(pool,{id:sourceId,scopes:[scope],query:async()=>structuredClone(page)}).query({ownerId,scopeIds:[scope]},{scope,limit:100})}

async function ensureAttentionRecords(roles){
 const snapshots=attentionActionSeeds.map(entry=>({...object('SOC','alert-ticket',entry.objectId,entry.title,'security-alert-http',entry.observedAt,entry.summary,{'严重度':'高','资产':entry.asset,'当前判定':'等你确认','最近变化':iso(entry.changedAt)}),version:entry.version}))
 const page=await persistObjects('security-alert-http','SOC',snapshots)
 const definition=createSecurityEndpointIsolateDefinition(),catalog={require(tool){if(tool!==definition.tool)throw Error('本机需要你预置事项引用了未声明的安全工具。');return definition}}
 const journal=new SecurityRequestJournal(pool),executions={existsForAction:async()=>false},principal={ownerId,approverId:ownerId,scopeIds:['SOC']}
 const actionIds=[]
 for(const entry of attentionActionSeeds){
  const tasks=new TaskService(pool,identity),businessTasks=new BusinessTaskService(pool,identity,tasks)
  const snapshot=page.items.find(item=>item.id===entry.objectId&&item.version===entry.version)
  if(!snapshot)throw Error('本机需要你预置事项缺少固定业务对象：'+entry.key)
  const {task}=await businessTasks.create(businessActor,{requestId:requestId('attention-task:'+entry.key),reference:{scope:snapshot.scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash},goal:entry.summary,assignee:{roleId:roles['lin-xi'].id,expectedVersion:roles['lin-xi'].version}})
  const actions=new SecurityActionService(pool,identity,catalog,journal,executions),proposal=await actions.propose(principal,{requestId:requestId('attention-owner-action:'+entry.key),taskId:task.id,expectedTaskVersion:task.version,title:entry.action,goal:entry.summary,tool:definition.tool,targetSet:[entry.asset],params:{reason:'仅处理已核对的固定目标，并保留独立审批与效果核对。'}})
  const submitted=await actions.submit(principal,{requestId:requestId('attention-owner-submit:'+entry.key),actionId:proposal.id,expectedActionVersion:proposal.version})
  if(submitted.state!=='pending_approval')throw Error('本机需要你预置动作未停在真实待审批状态。')
  actionIds.push(submitted.id)
 }
 const failureTaskIds=[],runService=new TaskRunService(pool,identity,async()=>{throw Error('预置的配置失败事项不会读取真实会话。')})
 for(const entry of attentionFailureSeeds){
  const role=roles[entry.role],task=await new TaskService(pool,identity).create(ownerId,{requestId:requestId('attention-failure-task:'+entry.key),fields:{title:entry.title,goal:entry.goal,scope:entry.scope},assignee:{roleId:role.id,expectedVersion:role.version}})
  await runService.failPreparation(ownerId,{requestId:requestId('attention-failure-run:'+entry.key),taskId:task.id,expectedTaskVersion:task.version,roleId:task.assigneeRoleId,expectedRoleVersion:task.assigneeRoleVersion,sessionId:'attention_seed_'+entry.key.replaceAll('-','_')},new TaskRunPresetError('teloa/preset-unavailable','preset-resolve','当前本机未配置该任务所需的运行配置。'))
  failureTaskIds.push(task.id)
 }
 const signal=new AbortController().signal
 const securityRows=(await new SecurityActionAttentionService(pool,catalog,{ready:async()=>({ready:false,reason:'本机固定目录尚未连接真实执行工具。'})},identity.now).list(principal,{},signal)).filter(row=>actionIds.includes(row.actionId))
 const taskRows=(await new TaskAttentionService(pool).list(ownerId,{})).items.filter(row=>failureTaskIds.includes(row.task.id)&&row.attention)
 const counts={approval:securityRows.filter(row=>row.reason==='approval-required').length,error:taskRows.length}
 if(counts.approval!==1||counts.error!==1)throw Error('本机需要你预置事项未形成预期的一条待审批和一条配置异常。')
 return {count:counts.approval+counts.error,...counts}
}

async function ensureTasks(roles,socPage,appsecPage){
 const tasks=new TaskService(pool,identity),businessTasks=new BusinessTaskService(pool,identity,tasks),find=(page,type,id)=>page.items.find(item=>item.type===type&&item.id===id)
 for(const entry of [
  {key:'soc-account-login',item:find(socPage,'alert-ticket','evt-1843'),goal:'核对账号登录是否属于已登记变更，补齐支持结论的证据。',role:roles['lin-xi']},
  {key:'appsec-replay',item:find(appsecPage,'vulnerability','APP-F-17'),goal:'核对可利用路径与修复方案，推动回归验证形成闭环。',role:roles['cheng-jian']},
 ])await businessTasks.create(businessActor,{requestId:requestId('business-task:'+entry.key),reference:{scope:entry.item.scope,type:entry.item.type,id:entry.item.id,version:entry.item.version,snapshotHash:entry.item.snapshotHash},goal:entry.goal,assignee:{roleId:entry.role.id,expectedVersion:entry.role.version}})
 const transitions=new TaskTransitions(pool,identity)
 for(const entry of [{key:'weekly-brief',title:'整理本周工作简报',goal:'汇总本周完成、待处理和需要本人判断的事项。',state:'running'},{key:'next-week',title:'核对下周重点工作安排',goal:'确认下周优先级、负责人和交付时间。',state:'paused'}]){let task=await tasks.create(ownerId,{requestId:requestId('task:'+entry.key),fields:{title:entry.title,goal:entry.goal,scope:'general'}});if(task.state==='ready')task=await transitions.change(ownerId,{taskId:task.id,requestId:requestId('task-start:'+entry.key),expectedVersion:task.version,action:'start'});if(entry.state==='paused'&&task.state==='running')await transitions.change(ownerId,{taskId:task.id,requestId:requestId('task-pause:'+entry.key),expectedVersion:task.version,action:'pause'})}
}

async function ensurePlans(roles){
 const service=new PlanService(pool,identity),definitions=[
  {key:'soc-triage',title:'告警分诊与持续分析',goal:'每天归并新增告警，识别需要人工判断和需要继续调查的事项。',scope:'SOC',role:roles['lin-xi'],delivery:'把高风险结论和阻塞项送到「需要你」。',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'08:30',timezone:'Asia/Singapore'},notificationPolicy:'attention',active:true},
  {key:'soc-check',title:'每日调查待办检查',goal:'检查未完成调查、缺失证据和临近截止的工作。',scope:'SOC',role:roles['zhou-heng'],delivery:'仅在有阻塞、超期或待本人判断时提醒。',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'attention',active:true},
  {key:'appsec-audit',title:'代码变更审计检查',goal:'检查关键应用的代码安全发现和修复状态。',scope:'AppSec',role:roles['cheng-jian'],delivery:'形成变化摘要与需要跟进的修复项。',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'10:00',timezone:'Asia/Singapore'},notificationPolicy:'failure',active:false},
  {key:'weekly-summary',title:'每周安全运营工作简报',goal:'汇总本周安全运营完成情况、重要变化和下周重点。',scope:'SOC',role:roles['lin-xi'],delivery:'每周五形成一份可继续编辑的简报。',trigger:{kind:'schedule',cadence:'weekly',weekday:5,time:'17:00',timezone:'Asia/Singapore'},notificationPolicy:'always',active:true},
 ]
 const plans={}
 for(const definition of definitions){const created=await service.create(ownerId,{requestId:requestId('plan:'+definition.key),fields:{title:definition.title,goal:definition.goal,scope:definition.scope,dataScope:'计划所属业务范围内已授权的数据、资料与任务状态。',delivery:definition.delivery,roleId:definition.role.id,expectedRoleVersion:definition.role.version,trigger:definition.trigger,notificationPolicy:definition.notificationPolicy},source:{kind:'manual'}});plans[definition.key]=definition.active&&created.state==='paused'?await service.change(ownerId,{planId:created.id,requestId:requestId('plan-enable:'+definition.key),expectedVersion:created.version,action:'enable'}):created}
 return plans
}

const fixedIdentity=(key,time)=>({id:()=>requestId('record:'+key),now:()=>time})

async function ensurePlanHistory(plans){
 const plan=plans['soc-triage'],manualRequestId=requestId('plan-trigger:soc-triage')
 if(!plan||plan.state!=='active')throw Error('本机告警分诊计划尚未启用，无法创建正式运行历史。')
 const occurrences=new PlanOccurrenceService(pool,fixedIdentity('plan-occurrence:soc-triage','2026-09-19T05:00:00.000Z'))
 const prior=(await occurrences.list(ownerId,{planId:plan.id})).find(item=>item.occurrenceId===`manual:${manualRequestId}`)
 const triggered=await occurrences.trigger(ownerId,{
  planId:plan.id,requestId:manualRequestId,
  expectedVersion:prior?.planVersion??plan.version,expectedConfigVersion:prior?.configVersion??plan.configVersion,
  now:'2026-09-19T05:00:00.000Z',
 })
 const dispatched=await occurrences.dispatchTask(ownerId,{claimId:triggered.occurrence.id,taskRequestId:triggered.occurrence.taskRequestId,now:'2026-09-19T05:00:01.000Z'})
 const history=await occurrences.executionHistory(ownerId,{planId:plan.id,limit:10}),saved=history.items.find(item=>item.claimId===triggered.occurrence.id)
 return summarizePreparedPlanHistory(saved,dispatched.task.id)
}

async function ensureTaskOutputs(resources){
 const taskIdentity=fixedIdentity('task-output:soc-review','2026-09-19T04:30:00.000Z')
 const tasks=new TaskService(pool,taskIdentity)
 const initial=await tasks.create(ownerId,{requestId:requestId('task-output:soc-review'),fields:{title:'复核生产服务异常访问调查',goal:'固定已核对的证据、尚未确认的矛盾和后续处置建议。',scope:'SOC'}})
 const selected=resources['soc-playbook']
 const material=await new TaskMaterialService(pool,fixedIdentity('task-output-material:soc-playbook','2026-09-19T04:31:00.000Z')).add(ownerId,{
  requestId:requestId('task-output-material:soc-playbook'),taskId:initial.id,expectedTaskVersion:1,resourceId:selected.id,expectedResourceVersion:selected.version,
 })
 const transitions=new TaskTransitions(pool,fixedIdentity('task-output-start:soc-review','2026-09-19T04:32:00.000Z'))
 const started=await transitions.change(ownerId,{taskId:initial.id,requestId:requestId('task-output-start:soc-review'),expectedVersion:material.task.version,action:'start'})
 const source={kind:'task',id:started.id,scope:started.scope,version:`${started.version} · ${started.updatedAt}`,title:started.title}
 const resolveSource=async(actor,expected,client)=>({source:await taskArtifactSource(client,actor,expected.id,true),sessionIds:[]})
 const first=await new ArtifactService(pool,fixedIdentity('task-output-artifact:soc-review','2026-09-19T04:33:00.000Z'),resolveSource).create(ownerId,{
  requestId:requestId('task-output-artifact:soc-review'),source,
  content:{title:'生产服务异常访问调查报告',sections:[
   {id:'conclusion',title:'结论',text:'api-prod-03 的异常脚本与外联行为需要持续调查，当前不建议直接关闭告警。'},
   {id:'evidence',title:'依据',text:'已核对脚本执行时间、新注册域名外联和资产归属；还需补充服务账号变更记录。'},
  ],snapshotIds:[],messageSnapshotIds:[],note:'固定首轮调查结论和证据边界。'},
 })
 const finalContent={title:first.content.title,sections:[
  {id:'conclusion',title:'结论',text:'api-prod-03 的异常脚本与外联行为已达到高风险调查判据，建议在本人确认影响范围后执行隔离。'},
  {id:'evidence',title:'依据',text:'脚本执行时间、新注册域名外联、资产归属和服务账号变更记录已完成交叉核对。'},
  {id:'next-step',title:'下一步',text:'保留当前网络证据，确认业务影响范围，将隔离动作交回本人审批。'},
 ],snapshotIds:[],messageSnapshotIds:[],note:'补齐变更记录后形成可交付版本。'}
 const revised=await new ArtifactService(pool,fixedIdentity('task-output-artifact-revision:soc-review','2026-09-19T04:35:00.000Z'),resolveSource).revise(ownerId,{artifactId:first.artifactId,expectedVersion:1,source,content:finalContent})
 const completed=await new TaskTransitions(pool,fixedIdentity('task-output-complete:soc-review','2026-09-19T04:36:00.000Z')).change(ownerId,{taskId:started.id,requestId:requestId('task-output-complete:soc-review'),expectedVersion:started.version,action:'complete',artifact:{id:revised.artifactId,version:revised.number},note:'已核对交付范围，固定第二版调查报告结项。'})
 const savedMaterials=await new TaskMaterialService(pool,identity).list(ownerId,{taskId:completed.id})
 const versions=await new ArtifactService(pool,identity,resolveSource).list(ownerId,{artifactId:revised.artifactId})
 const completion=await new TaskTransitions(pool,identity).completion(ownerId,{taskId:completed.id})
 if(completed.state!=='completed'||savedMaterials.length!==1||savedMaterials[0].resourceId!==selected.id||versions.length!==2||completion?.artifactId!==revised.artifactId||completion.artifactVersion!==2)throw Error('本机任务资料、成果版本或结项依据未形成预期记录。')
 return {tasks:1,materials:savedMaterials.length,artifacts:1,artifactVersions:versions.length,completions:1}
}

async function ensureCollaboration(roles){
 const group=await new CollaborationService(pool,fixedIdentity('group:soc-investigation','2026-09-19T04:00:00.000Z')).create(ownerId,{
  requestId:requestId('group:soc-investigation'),expectedVersion:0,
  fields:{name:'生产服务异常访问调查',scope:'SOC',announcement:'集中核对账号、主机与外联证据，结论必须可以复核。',memberRoleIds:[roles['lin-xi'].id,roles['zhou-heng'].id]},
 })
 const resourceId=requestId('group-resource:soc-investigation-notes')
 const resource=await new CollaborationService(pool,fixedIdentity('group-resource:soc-investigation-notes','2026-09-19T04:05:00.000Z')).saveResource(ownerId,{
  requestId:requestId('group-resource-save:soc-investigation-notes'),groupId:group.id,resourceId,expectedVersion:0,
  title:'生产服务异常访问调查说明',
  markdown:'# 生产服务异常访问调查说明\n\n## 核对范围\n\n- api-prod-03 的异常脚本与外联记录\n- gateway-prod-01 的服务账号登录时间线\n- 维护窗口、资产负责人和独立证据\n\n## 交付要求\n\n结论须区分事实、推断与建议；涉及隔离或封禁时交回本人确认。\n',
 })
 const first=await new CollaborationService(pool,fixedIdentity('group-message:soc-investigation-context','2026-09-19T04:10:00.000Z')).send(ownerId,{
  requestId:requestId('group-message:soc-investigation-context'),groupId:group.id,expectedVersion:1,
  text:'请先核对两台生产资产的时间线，并标出证据一致处和仍有冲突的地方。',
  references:[{kind:'group-resource',id:resource.id,version:resource.version}],
 })
 await new CollaborationService(pool,fixedIdentity('group-message:soc-investigation-boundary','2026-09-19T04:15:00.000Z')).send(ownerId,{
  requestId:requestId('group-message:soc-investigation-boundary'),groupId:group.id,expectedVersion:1,rootId:first.id,
  text:'隔离、封禁和生产变更先形成建议，保留证据与影响范围，等我确认后再执行。',references:[],
 })
 const service=new CollaborationService(pool,identity),messages=await service.messages(ownerId,{groupId:group.id}),resources=await service.resources(ownerId,{groupId:group.id})
 const savedMessages=messages.filter(message=>message.id===first.id||message.rootId===first.id)
 const savedResources=resources.filter(item=>item.id===resource.id&&item.withdrawnAt===null)
 if(savedMessages.length!==2||savedResources.length!==1||!savedMessages.some(message=>message.references.some(reference=>reference.kind==='group-resource'&&reference.id===resource.id&&reference.version===resource.version)))throw Error('本机群协作记录未形成预期的两条消息和一份资料关联。')
 return {groups:1,messages:savedMessages.length,resources:savedResources.length}
}

async function ensureRoleMemory(roles){
 const human={ownerId,kind:'human'},role=roles['lin-xi']
 const created=await new RoleMemoryService(pool,fixedIdentity('role-memory:lin-xi-evidence-boundary','2026-09-19T04:20:00.000Z')).create(human,{
  requestId:requestId('role-memory:lin-xi-evidence-boundary'),roleId:role.id,expectedRoleVersion:role.version,
  title:'结论交付前核对证据边界',
  markdown:'形成告警结论时，先区分已确认事实、仍待核对的矛盾和处置建议。缺少关键日志、资产负责人或独立证据时，不直接关闭告警；涉及隔离、封禁和生产变更时，先交回本人确认。',
  source:{kind:'self-feedback',id:requestId('role-memory-source:lin-xi-evidence-boundary'),version:1},
  visibility:{kind:'role',scopeIds:['SOC']},
 })
 const memory=await new RoleMemoryService(pool,fixedIdentity('role-memory-confirm:lin-xi-evidence-boundary','2026-09-19T04:25:00.000Z')).confirm(human,{
  requestId:requestId('role-memory-confirm:lin-xi-evidence-boundary'),memoryId:created.id,expectedStateVersion:created.stateVersion,
 })
 const rows=await new RoleMemoryService(pool,identity).list(human,{roleId:role.id})
 if(memory.state!=='confirmed'||rows.filter(item=>item.id===memory.id&&item.state==='confirmed').length!==1)throw Error(`${role.name}的岗位记忆未形成唯一的已确认记录。`)
 return {confirmed:1}
}

try{
 await new BusinessSpaceService(pool,identity).ensurePersonal(ownerId)
 const knowledge=await ensureKnowledge(),resources=knowledge.resources,roles=await ensureRoles(resources)
 // 内置示例只认仓内 `examples/industry/**` 下的合包：安全运营一包同时带同事、技能、资料、接入源、
 // 台账声明与任务模板，市场展品与本机业务台账读的是同一份内容，不再拿测试夹具当市场条目。
 const retiredLedgers=await retireFixtureLedgerLoads()
 const socIndustry=await ensureIndustry('soc',resolve('examples/industry/安全运营'))
 const socCapabilities=socIndustry.load.items.filter(item=>['skill','mcp'].includes(item.kind))
 if(!socCapabilities.some(item=>item.kind==='skill')||!socCapabilities.some(item=>item.kind==='mcp'))throw Error('本机固定安全运营合包必须同时声明至少一项 Skill 和一项 MCP／连接。')
 // 应用安全是只带台账声明的部分包：没有同事、技能与资料，Sam Taylor 那条业务因此有对象、视图和动作可渲染。
 const appsecIndustry=await ensureIndustry('appsec',resolve('examples/industry/应用安全'))
 const generalResearch=await ensureFormalMarketTemplate({pool,identity,ownerId,requestId,directory:resolve('examples/industry/通用研究'),sourceName:'本机固定通用研究目录（仅用于展示结构，不表示外部连接已就绪）'})
 const socPage=await persistObjects('security-alert-http','SOC',socObjects),appsecPage=await persistObjects('appsec-finding-http','AppSec',appsecObjects)
 await ensureTasks(roles,socPage,appsecPage);const plans=await ensurePlans(roles),planHistory=await ensurePlanHistory(plans)
 const taskOutputs=await ensureTaskOutputs(resources),collaboration=await ensureCollaboration(roles),roleMemory=await ensureRoleMemory(roles)
 const attention=await ensureAttentionRecords(roles)
 const rows=(await pool.query(`select '资料' name,count(*)::int count from teloa_resources where owner_id=$1 and status='active' union all select '同事',count(*)::int from teloa_roles where owner_id=$1 and definition->>'kind'='employee' and state='active' union all select '任务',count(*)::int from teloa_tasks where owner_id=$1 union all select '自动化',count(*)::int from teloa_plans where owner_id=$1 and state<>'archived' union all select '业务对象',count(*)::int from teloa_business_object_snapshots where owner_id=$1 union all select '行业目录',count(*)::int from teloa_industry_loads where owner_id=$1 and status='active'`,[ownerId])).rows
 console.log(JSON.stringify({prepared:true,counts:Object.fromEntries(rows.map(row=>[row.name,row.count])),knowledge:knowledge.summary,attention,industry:{dataSourceInstances:socIndustry.dataSourceInstances+appsecIndustry.dataSourceInstances,activeDataSources:0,executionTools:socIndustry.executionTools+appsecIndustry.executionTools,activeExecutionTools:0},capabilities:{skills:socCapabilities.filter(item=>item.kind==='skill').length,connections:socCapabilities.filter(item=>item.kind==='mcp').length},market:{catalogOnlyTemplates:1,generalResearchContentId:generalResearch.content.id,retiredLedgers},planHistory,taskOutputs,collaboration,roleMemory},null,2))
}finally{await pool.end()}
