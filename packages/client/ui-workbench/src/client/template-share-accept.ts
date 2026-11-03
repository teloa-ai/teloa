import {sha256Digest} from '@teloa/contract'
import {industryTeamSeed,industryTeamRole,type IndustryTeamSeed} from './industry-team.ts'
import {marketCatalogUpstreamTreeInput,type MarketCatalogEntry,type TemplateShareIntent} from '@teloa/contract'
import type {RoleFields} from './role-preview.ts'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.ts'
import type {IndustryLoadCreateInput,IndustryLoadRecord,IndustryPluginHoldReason,IndustryReadiness,IndustryReadinessRow} from './industry-load-api.ts'
import type {MarketItem} from './market-preview.ts'
import {loadCatalogListing,type MarketCatalogApi} from './market-catalog-api.ts'
import type {MarketContentApi} from './market-content-api.ts'
import {createTemplateAcceptance,type TemplateAcceptanceResult} from './employee-template-share.ts'
import {shareIndustryItem} from './industry-directory.ts'
import {referenceCandidates,resolveIndustryReferences} from './industry-reference.ts'
import {hasShareSelection,isSharePackageV2,readSharePackage,sharePackageDigest,sharePackageSummary,shareWorkCopy,type ShareWorkMapping,type SharePackage,type SharePackageV2,type ShareSummary} from './share-package-plan.ts'
import {shareOriginalIndustryItem} from './industry-directory.ts'

/**
 * v2 分享包接收复用固定内容 → 行业加载 → 一键准备这条既有链路，不另建运行引擎：
 * 1. 按冻结的选择（目标业务范围与所选技能）把分享包转成固定内容：未选技能不进内容，团队协调者写成
 *    `role-coordination` 静态关系，随固定内容摘要与加载实例持久保存；
 * 2. 所选公共技能按「公共名 + 固定版本」唯一解析到官方目录条目，零或多命中都拒绝；
 * 3. 固定内容导入、加载、所选技能按 industry 来源逐项安装（技能 usage 绑定到本加载条目，回执给出实际原生名）；
 * 4. 技能全部装好后才调用原 `industry-loads/prepare`：资料实例化、连接登记、已核验的依赖应用安装启用、岗位按 role.json 原样（含结构化职责与
 *    role-knowledge 资料）建立，并经原 `roles/edit` 绑定实际安装的原生名；应用按准备后读到的真实状态回报。
 * 每个子请求的 requestId 与选择先持久化再调用；恢复只能继续原选择，不改原请求参数。
 * v1 员工包仍走原 `createTemplateAcceptance` 与原恢复键。
 */
/** needs-user：实际方法尚不可用，或依赖应用待本人查看权限、重启或核对固定来源；应用原因见 reason。 */
export type ShareAcceptItemState='done'|'pending'|'failed'|'unavailable'|'skipped'|'needs-user'
export type ShareAcceptItem={resourceId:string;title:string;state:ShareAcceptItemState;installationId?:string;nativeName?:string;reason?:IndustryPluginHoldReason}
export type ShareOriginalSource={contentId:string;contentHash:string;shareSha256:string;scope:string;targetScope:string;mappings:ShareWorkMapping[]}
export type ShareAcceptanceResult={sha256:string;complete:boolean;roleIds:string[];roles:{resourceId:string;name:string;roleId?:string;state:ShareAcceptItemState}[];coordinatorRoleId?:string;coordinator:ShareAcceptItemState;groupId?:string;loadId?:string;pendingKinds:string[];skills:ShareAcceptItem[];mcp:ShareAcceptItem[];plugins:ShareAcceptItem[];plans:ShareAcceptItem[];knowledge?:ShareAcceptItem[];workTemplates?:ShareAcceptItem[];businessConfigurations?:ShareAcceptItem[];originalSource?:ShareOriginalSource}
export type ShareAcceptChoice={skills:readonly string[];scope:string}
export type ShareIndustryRole={loadId?:string;itemInstanceId:string;state:string;roleId?:string}
export type ShareAcceptPorts={
 createRole:(fields:RoleFields,requestId:string)=>Promise<string>
 industry?:{
  /** 公共技能按「公共名 + 固定版本」取得官方目录原子正文；返回已持久化、已读取的原子技能项。 */
  publicSkill:(input:{publicId:string;version:string})=>Promise<MarketItem>
  target:()=>Promise<IndustryLoadCreateInput['target']>
  importContent:(item:MarketItem,requestId:string)=>Promise<MarketItem>
  load:(request:IndustryLoadCreateInput)=>Promise<IndustryLoadRecord>
  getLoad:(loadId:string)=>Promise<IndustryLoadRecord>
  installSkill:(source:{loadId:string;itemInstanceId:string},requestId:string)=>Promise<{state:'installed';installationId:string;nativeName:string}|{state:'pending'}>
  /** 原一键准备：有可自动完成的项就执行一次，返回最终清单。 */
  prepare:(loadId:string)=>Promise<IndustryReadiness>
  /** 已完成的接收只读核对，不再准备或覆盖本人后续配置。 */
  readiness:(loadId:string)=>Promise<IndustryReadiness>
  roles:(loadId:string)=>Promise<ShareIndustryRole[]>
  /** 只读核对本人明确创建的真实团队，不在接收过程中建群。 */
  team?:(seed:IndustryTeamSeed)=>Promise<{groupId:string}|undefined>
 }
 /** v1 员工包沿用的原端口；缺省只需 createRole。 */
 v1?:Omit<Parameters<typeof createTemplateAcceptance>[1],'createRole'>
}
type Install={requestId:string;state?:'installed'|'pending'|'failed';installationId?:string;nativeName?:string}
type Progress={sha256:string;scope:string;skills:string[];contentRequestId:string;loadRequestId:string;sourceMetadataVersion?:1;completed?:true;target?:IndustryLoadCreateInput['target'];content?:{id:string;hash:string};loadId?:string;installs:Record<string,Install>;original?:{requestId:string;content?:{id:string;hash:string};copyId:string;scope:string;targetScope:string;files:{path:string;sha256:string}[];mappings:ShareWorkMapping[]}}
const KEY='teloa.share-accept/v3/'
const uuid=()=>crypto.randomUUID()
const textHash=async(text:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),byte=>byte.toString(16).padStart(2,'0')).join('')

/** 官方目录里与「公共名 + 固定版本」完全对应的唯一技能条目；目录 id（如 `anthropic.x`）不等于公共名，不取第一位、不取最新。 */
export function resolvePublicCatalogEntry<T extends {entry:MarketCatalogEntry}>(items:readonly T[],publicId:string,version:string):T{
 const found=items.filter(item=>item.entry.kind==='skill'&&item.entry.skill.name===publicId&&item.entry.version===version)
 if(found.length!==1)throw Object.assign(Error(found.length?'Public skill reference is ambiguous.':'Public skill reference is not in the catalog.'),{code:'teloa/source-unavailable'})
 return found[0]!
}

/**
 * 当前目录的 addedContentId 是本人内容身份与信任摘要的查询信号；上游来源还由宿主核原导入回执、条目版本与树。
 * hydrate 再按本人权限读取、重算完整字节与信任摘要。这里继续核完整文件集合，不能用同名内容或旧目录替代。
 * 已有内容读不出或不匹配时保留原失败，不静默下载另一份；只有当前目录明确未添加才走原 add。
 */
export async function readPublicCatalogSkill(catalog:Pick<MarketCatalogApi,'list'|'add'>,content:Pick<MarketContentApi,'hydrate'>,{publicId,version}:{publicId:string;version:string}):Promise<MarketItem>{
 const found=resolvePublicCatalogEntry((await loadCatalogListing(catalog)).items,publicId,version)
 const entry=found.entry,unavailable=()=>Object.assign(Error('Public skill content does not match the current catalog source.'),{code:'teloa/source-unavailable'})
 if(entry.kind!=='skill'||entry.compatibility.status==='unsupported')throw unavailable()
 const files=entry.delivery==='upstream'?entry.upstream.files:found.artifact?.files
 const treeHash=entry.delivery==='upstream'?Array.from(new Uint8Array(await sha256Digest(new TextEncoder().encode(marketCatalogUpstreamTreeInput(entry.upstream)))),byte=>byte.toString(16).padStart(2,'0')).join(''):found.artifact?.treeHash
 if(!files?.length||!treeHash)throw unavailable()
 const contentId=found.addedContentId===null?(await catalog.add(entry.id,{version,treeHash})).contentId:found.addedContentId
 const item=await content.hydrate({kind:'skill',contentStorage:{contentId,createdAt:new Date().toISOString(),loaded:true}} as MarketItem),skill=item.atomicSkill
 if(item.kind!=='skill'||item.contentStorage?.contentId!==contentId||!item.contentStorage.loaded||item.version!==version||!skill||skill.id!==publicId||skill.version!==version||skill.entryPath!==publicId+'/SKILL.md'||!item.trust||item.trust.review.conclusion!=='approved'||skill.files.length!==files.length)throw unavailable()
 for(const expected of files){
  const actual=skill.files.find(file=>file.path===publicId+'/'+expected.path)
  if(!actual||actual.hash!==expected.sha256||expected.size!==null&&actual.bytes.byteLength!==expected.size)throw unavailable()
 }
 return item
}

/** 团队协调关系从加载真源读回：协调者 → 成员的 `role-coordination` 关系映射到实际员工；旧包没有声明时为空。 */
export function teamCoordination(load:Pick<IndustryLoadRecord,'relations'>,roles:readonly ShareIndustryRole[]):{coordinatorRoleId:string;memberRoleIds:string[]}|undefined{
 const links=load.relations.filter(link=>link.kind==='role-coordination'),from=[...new Set(links.map(link=>link.from))]
 if(from.length!==1)return undefined
 const roleOf=(itemInstanceId:string)=>roles.find(row=>row.itemInstanceId===itemInstanceId)?.roleId
 const coordinatorRoleId=roleOf(from[0]!),memberRoleIds=links.map(link=>roleOf(link.to))
 if(!coordinatorRoleId||memberRoleIds.some(id=>!id))return undefined
 return {coordinatorRoleId,memberRoleIds:memberRoleIds as string[]}
}

export {shareIndustryItem}

const empty=(summary:ShareSummary,kind:'plans'):ShareAcceptItem[]=>summary[kind].map(r=>({resourceId:r.resourceId,title:r.title,state:'pending'}))
/** 依赖应用按一键准备后的清单行回报：已启用算完成；只有安装失败记失败（可再添加重试），其余待确认、不能安装、待重启、来源变化、读不出或未被员工依赖的都交本人处理；其余仍在处理。 */
function pluginState(row:IndustryReadinessRow|undefined,read:boolean):ShareAcceptItemState{
 if(!row)return read?'unavailable':'pending'
 if(row.state==='ready')return 'done'
 if(row.state!=='needs-user')return 'pending'
 return row.reason==='failed'?'failed':'needs-user'
}
export function createShareAcceptance(storage:WorkbenchNavigationStorage,ports:ShareAcceptPorts){
 const legacy=createTemplateAcceptance(storage,{createRole:ports.createRole,...(ports.v1??{})} as Parameters<typeof createTemplateAcceptance>[1])
 let busy=false
 const progress=(sha256:string):Progress|undefined=>{const raw=storage.getItem(KEY+sha256);if(!raw)return undefined;const p=JSON.parse(raw) as Progress;if(p.sha256!==sha256||typeof p.scope!=='string'||!Array.isArray(p.skills)||!p.contentRequestId||!p.loadRequestId||!p.installs||p.sourceMetadataVersion!==undefined&&p.sourceMetadataVersion!==1||p.completed!==undefined&&p.completed!==true)throw Error('Template recovery record is invalid.');return p}
 const selectedProgress=(sha256:string,summary:ShareSummary):Progress|undefined=>{
  const p=progress(sha256)
  // 旧空包在构造内容时即失败，尚无任何派发步骤才允许重新选择；未知回执仍锁定原申请。
  return p&&!hasShareSelection(summary,p.skills)&&!p.target&&!p.content&&!p.loadId&&Object.keys(p.installs).length===0?undefined:p
 }
 return {
  /** 已开始的接收沿用的原选择；界面据此锁定选择，只能继续原申请。 */
  async choice(value:SharePackage):Promise<ShareAcceptChoice|undefined>{const pkg=readSharePackage(value);if(!isSharePackageV2(pkg))return await legacy.hasRequest(pkg)?{scope:'general',skills:[]}:undefined;const p=selectedProgress(await sharePackageDigest(pkg),sharePackageSummary(pkg));return p?{scope:p.scope,skills:[...p.skills]}:undefined},
  async accept(value:SharePackage,choice:ShareAcceptChoice,intent?:TemplateShareIntent):Promise<ShareAcceptanceResult>{
  const pkg=readSharePackage(value)
  if(!isSharePackageV2(pkg)){
   const result:TemplateAcceptanceResult=await legacy.accept(pkg,intent)
   return {sha256:await sharePackageDigest(pkg),complete:true,roleIds:[result.roleId],roles:[{resourceId:'employee',name:pkg.title,roleId:result.roleId,state:'done'}],coordinator:'skipped',...(result.loadId?{loadId:result.loadId}:{}),pendingKinds:result.pendingKinds,skills:[],mcp:[],plugins:[],plans:[]}
  }
  if(busy)throw Error('Template acceptance is already running.')
  const industry=ports.industry
  if(!industry)throw Object.assign(Error('Template installation is unavailable.'),{code:'teloa/dependency-unavailable'})
  busy=true
  try{
   const summary=sharePackageSummary(pkg),sha256=await sharePackageDigest(pkg),key=KEY+sha256,derived=shareWorkCopy(pkg,choice.scope,'copy-'+sha256),needsOriginal=!!summary.businessConfigurations?.length||derived.mappings.length>0
   // 选择只在首次确认时冻结；恢复与继续不改原范围、所选技能和任何已发出的请求参数。
   const previous=selectedProgress(sha256,summary)
   const p:Progress=previous??{sha256,scope:choice.scope,skills:summary.skills.map(s=>s.resourceId).filter(id=>choice.skills.includes(id)),contentRequestId:uuid(),loadRequestId:uuid(),sourceMetadataVersion:1,installs:{},...(needsOriginal?{original:{requestId:uuid(),copyId:'copy-'+sha256,scope:summary.scope,targetScope:choice.scope,files:await Promise.all(pkg.files.map(async file=>({path:file.path,sha256:await textHash(file.text)}))),mappings:derived.mappings}}:{})}
   if(!hasShareSelection(summary,p.skills))throw Object.assign(Error('Choose at least one item to add.'),{code:'teloa/validation-error'})
   // 保留原请求，但不能把界面新确认的范围或技能静默替换成旧选择。
   if(previous&&(previous.scope!==choice.scope||new Set(previous.skills).size!==new Set(choice.skills).size||previous.skills.some(id=>!choice.skills.includes(id))))throw Object.assign(Error('Continue with the original saved template selection.'),{code:'acceptance-choice-conflict'})
   const save=()=>storage.setItem(key,JSON.stringify(p))
   save()
   let originalSource:ShareOriginalSource|undefined
   if(p.original){
    const original=p.original
    if(original.copyId!=='copy-'+sha256||original.scope!==summary.scope||original.targetScope!==p.scope||JSON.stringify(original.mappings)!==JSON.stringify(derived.mappings)||original.files.length!==pkg.files.length)throw Error('Original sharing source recovery differs from the confirmed copy.')
    const currentFiles=await Promise.all(pkg.files.map(async file=>({path:file.path,sha256:await textHash(file.text)})))
    if(JSON.stringify(original.files)!==JSON.stringify(currentFiles))throw Error('Original sharing source file hashes changed.')
    if(!original.content){
     let item=await shareOriginalIndustryItem(pkg)
     const publicSkills=summary.skills.filter(skill=>skill.source==='public')
     if(publicSkills.length){const sources=await Promise.all(publicSkills.map(skill=>industry.publicSkill({publicId:skill.publicId!,version:skill.version}))),choices=publicSkills.map(skill=>{const found=referenceCandidates(item,sources,skill.resourceId);if(found.length!==1)throw Error('Original public source is unavailable.');return found[0]!});item=await resolveIndustryReferences(item,sources,choices)}
     const saved=await industry.importContent(item,original.requestId)
     if(!saved.contentStorage?.contentId||!saved.packageContent?.hash)throw Error('Original template source has not been saved.')
     original.content={id:saved.contentStorage.contentId,hash:saved.packageContent.hash};save()
    }
    originalSource={contentId:original.content.id,contentHash:original.content.hash,shareSha256:sha256,scope:original.scope,targetScope:original.targetScope,mappings:original.mappings}
   }
   const workPackage=p.original?derived.copy:pkg
   if(!p.loadId){
    let item=await shareIndustryItem(workPackage,p)
    const pub=summary.skills.filter(s=>s.source==='public'&&p.skills.includes(s.resourceId))
    if(pub.length){
     const sources=await Promise.all(pub.map(s=>industry.publicSkill({publicId:s.publicId!,version:s.version})))
     const choices=pub.map(s=>{const found=referenceCandidates(item,sources,s.resourceId);if(found.length!==1)throw Object.assign(Error('Public skill reference does not match the pinned version.'),{code:'teloa/source-unavailable'});return found[0]!})
     item=await resolveIndustryReferences(item,sources,choices)
    }
    if(!p.target){p.target=await industry.target();save()}
    if(!p.content){
     // 旧接收可能已经导入而回执丢失；缺少新版本标记时保持原上传声明，不能用同请求改变 trustHash。
     const {trust:declaration,...legacy}=item
     const saved=await industry.importContent(p.sourceMetadataVersion===1?item:legacy,p.contentRequestId)
     if(!saved.contentStorage?.contentId||!saved.packageContent?.hash)throw Error('Template content has not been saved.')
     p.content={id:saved.contentStorage.contentId,hash:saved.packageContent.hash};save()
    }
    const created=await industry.load({requestId:p.loadRequestId,contentId:p.content.id,contentHash:p.content.hash,target:p.target});p.loadId=created.id;save()
   }
   const loadId=p.loadId,load=await industry.getLoad(loadId)
   const itemOf=(resourceId:string)=>load.items.find(i=>i.localId===resourceId)
   // 所选技能按本加载条目安装：usage 把安装绑定到该条目，回执给出实际原生名，岗位只绑定这个名字。
   for(const resourceId of p.skills){
    const step=p.installs[resourceId]??={requestId:uuid()},target=itemOf(resourceId)
    if(step.state==='installed'||!target)continue
    save()
    try{const r=await industry.installSkill({loadId,itemInstanceId:target.instanceId},step.requestId);step.state=r.state;if(r.state==='installed'){step.installationId=r.installationId;step.nativeName=r.nativeName}}catch{step.state='failed'}
    save()
   }
   const installed=p.skills.every(id=>p.installs[id]?.state==='installed')
   // 技能未全部装好时不建岗位：避免员工先建好、方法却留空。
   let readiness:IndustryReadiness|undefined
   if(installed){try{readiness=await (p.completed?industry.readiness(loadId):industry.prepare(loadId))}catch{readiness=undefined}}
   const instances=await industry.roles(loadId)
   const roles:ShareAcceptanceResult['roles']=summary.roles.map(role=>{const target=itemOf(role.resourceId),instance=target?industryTeamRole(load,target.instanceId,instances):undefined;return {resourceId:role.resourceId,name:role.name,...(instance?.roleId?{roleId:instance.roleId}:{}),state:instance?.roleId&&['active','paused'].includes(instance.state)?'done':instance?.state==='failed'?'failed':'pending'}})
   const skills:ShareAcceptItem[]=summary.skills.map(s=>{
    const step=p.installs[s.resourceId],row=readiness?.rows.find(r=>r.itemInstanceId===itemOf(s.resourceId)?.instanceId)
    if(!p.skills.includes(s.resourceId))return {resourceId:s.resourceId,title:s.title,state:'skipped'}
    // 安装回执沿用原请求；实际可用性取本加载条目的最终清单，缺项、读取失败或同名来源冲突均不能报完成。
    const state=step?.state==='failed'?'failed':step?.state!=='installed'?'pending':row?.state==='ready'?'done':row?.state==='needs-user'||row?.entry==='skill-confirm'?'needs-user':'pending'
    return {resourceId:s.resourceId,title:s.title,state,...(step?.installationId?{installationId:step.installationId}:{}),...(step?.nativeName?{nativeName:step.nativeName}:{})}
   })
   // 连接只登记定义；需要本人授权的显示为已添加，账号授权仍在连接设置完成。
   const mcp:ShareAcceptItem[]=summary.connections.map(c=>{const row=readiness?.rows.find(r=>r.itemInstanceId===itemOf(c.resourceId)?.instanceId);return {resourceId:c.resourceId,title:c.title,state:!row?(readiness?'unavailable':'pending'):row.state==='ready'||row.entry==='connector-settings'?'done':row.state==='needs-user'?'failed':'pending'}})
   const plugins:ShareAcceptItem[]=summary.plugins.map(r=>{const row=readiness?.rows.find(x=>x.itemInstanceId===itemOf(r.resourceId)?.instanceId);return {resourceId:r.resourceId,title:r.title,state:pluginState(row,!!readiness),...(row?.reason?{reason:row.reason}:{})}})
   const knowledge:ShareAcceptItem[]=summary.knowledge.map(r=>{const row=readiness?.rows.find(x=>x.itemInstanceId===itemOf(r.resourceId)?.instanceId);return {resourceId:r.resourceId,title:r.title,state:row?.state==='ready'?'done':row?.state==='needs-user'?'failed':'pending'}})
   // 模板定义已加载也不等于创建或启用了任务/计划。继续使用原配置入口，不自动执行。
   const workTemplates:ShareAcceptItem[]=summary.workTemplates.map(r=>{const row=readiness?.rows.find(x=>x.itemInstanceId===itemOf(r.resourceId)?.instanceId);return {resourceId:r.resourceId,title:r.title,state:row?.entry==='task-form'?'needs-user':'pending'}})
   const businessConfigurations:ShareAcceptItem[]=(summary.businessConfigurations??[]).map(r=>({resourceId:r.resourceId,title:r.title,state:'needs-user'}))
   let coordinator:ShareAcceptItemState='skipped',coordinatorRoleId:string|undefined
   if(summary.coordinatorResourceId){const team=teamCoordination(load,instances);if(team){coordinator='done';coordinatorRoleId=team.coordinatorRoleId}else coordinator=load.relations.some(l=>l.kind==='role-coordination')?'pending':'failed'}
   let groupId:string|undefined
   if(summary.subject==='team'){
    const seed=industryTeamSeed(load,instances)
    if(seed)coordinatorRoleId=seed.coordinatorRoleId
    if(seed&&roles.every(role=>role.state==='done')){try{groupId=(await industry.team?.(seed))?.groupId}catch{/* 未核对的群不冒充接收完成。 */}}
    coordinator=groupId?'done':'pending'
   }
   const result:ShareAcceptanceResult={sha256,complete:false,...(groupId?{groupId}:{}),roleIds:roles.flatMap(r=>r.roleId?[r.roleId]:[]),roles,...(coordinatorRoleId?{coordinatorRoleId}:{}),coordinator,loadId,pendingKinds:[...new Set([...(summary.plans.length?['plan']:[]),...(summary.workTemplates.length?['work-template']:[]),...(businessConfigurations.length?['business-configuration']:[]),...(skills.some(p=>p.state!=='done'&&p.state!=='skipped')?['skill']:[]),...(knowledge.some(p=>p.state!=='done')?['knowledge']:[]),...(plugins.some(p=>p.state!=='done')?['plugin']:[])])],skills,mcp,plugins,knowledge,workTemplates,businessConfigurations,plans:empty(summary,'plans'),...(originalSource?{originalSource}:{})}
   result.complete=roles.every(r=>r.state==='done')&&[...skills,...mcp,...knowledge,...plugins].every(i=>i.state==='done'||i.state==='skipped')&&(coordinator==='done'||coordinator==='skipped')
   if(result.complete&&!p.completed){p.completed=true;save()}
   return result
  }finally{busy=false}
 }}
}
