import {industryTeamSeed,industryTeamRole,type IndustryTeamSeed} from './industry-team.ts'
import type {MarketCatalogEntry,TemplateShareIntent} from '@teloa/contract'
import type {RoleFields} from './role-preview.ts'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.ts'
import type {IndustryLoadCreateInput,IndustryLoadRecord,IndustryReadiness} from './industry-load-api.ts'
import type {MarketItem} from './market-preview.ts'
import {createTemplateAcceptance,type TemplateAcceptanceResult} from './employee-template-share.ts'
import {readIndustryDirectory} from './industry-directory.ts'
import {referenceCandidates,resolveIndustryReferences} from './industry-reference.ts'
import {hasShareSelection,isSharePackageV2,readSharePackage,sharePackageDigest,sharePackageSummary,type SharePackage,type SharePackageV2,type ShareSummary} from './share-package-plan.ts'

/**
 * v2 分享包接收复用固定内容 → 行业加载 → 一键准备这条既有链路，不另建运行引擎：
 * 1. 按冻结的选择（目标业务范围与所选技能）把分享包转成固定内容：未选技能不进内容，团队协调者写成
 *    `role-coordination` 静态关系，随固定内容摘要与加载实例持久保存；
 * 2. 所选公共技能按「公共名 + 固定版本」唯一解析到官方目录条目，零或多命中都拒绝；
 * 3. 固定内容导入、加载、所选技能按 industry 来源逐项安装（技能 usage 绑定到本加载条目，回执给出实际原生名）；
 * 4. 技能全部装好后才调用原 `industry-loads/prepare`：资料实例化、连接登记、岗位按 role.json 原样（含结构化职责与
 *    role-knowledge 资料）建立，并经原 `roles/edit` 绑定实际安装的原生名。
 * 每个子请求的 requestId 与选择先持久化再调用；恢复只能继续原选择，不改原请求参数。
 * v1 员工包仍走原 `createTemplateAcceptance` 与原恢复键。
 */
export type ShareAcceptItemState='done'|'pending'|'failed'|'unavailable'|'skipped'
export type ShareAcceptItem={resourceId:string;title:string;state:ShareAcceptItemState;installationId?:string;nativeName?:string}
export type ShareAcceptanceResult={sha256:string;complete:boolean;roleIds:string[];roles:{resourceId:string;name:string;roleId?:string;state:ShareAcceptItemState}[];coordinatorRoleId?:string;coordinator:ShareAcceptItemState;groupId?:string;loadId?:string;pendingKinds:string[];skills:ShareAcceptItem[];mcp:ShareAcceptItem[];plugins:ShareAcceptItem[];plans:ShareAcceptItem[]}
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
  roles:(loadId:string)=>Promise<ShareIndustryRole[]>
  /** 只读核对本人明确创建的真实团队，不在接收过程中建群。 */
  team?:(seed:IndustryTeamSeed)=>Promise<{groupId:string}|undefined>
 }
 /** v1 员工包沿用的原端口；缺省只需 createRole。 */
 v1?:Omit<Parameters<typeof createTemplateAcceptance>[1],'createRole'>
}
type Install={requestId:string;state?:'installed'|'pending'|'failed';installationId?:string;nativeName?:string}
type Progress={sha256:string;scope:string;skills:string[];contentRequestId:string;loadRequestId:string;sourceMetadataVersion?:1;target?:IndustryLoadCreateInput['target'];content?:{id:string;hash:string};loadId?:string;installs:Record<string,Install>}
const KEY='teloa.share-accept/v3/'
const uuid=()=>crypto.randomUUID()

/** 官方目录里与「公共名 + 固定版本」完全对应的唯一技能条目；目录 id（如 `anthropic.x`）不等于公共名，不取第一位、不取最新。 */
export function resolvePublicCatalogEntry<T extends {entry:MarketCatalogEntry}>(items:readonly T[],publicId:string,version:string):T{
 const found=items.filter(item=>item.entry.kind==='skill'&&item.entry.skill.name===publicId&&item.entry.version===version)
 if(found.length!==1)throw Object.assign(Error(found.length?'Public skill reference is ambiguous.':'Public skill reference is not in the catalog.'),{code:'teloa/source-unavailable'})
 return found[0]!
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

/** 按冻结选择把 v2 分享包转成可固定保存的业务包：只改目标范围、去掉未选技能、技能正文落到 SKILL.md 目录、写入协调关系。 */
export async function shareIndustryItem(pkg:SharePackageV2,choice:{scope:string;skills:readonly string[]}):Promise<MarketItem>{
 const byPath=new Map(pkg.files.map(f=>[f.path,f.text])),manifest=JSON.parse(byPath.get('teloa.json')!) as {scope?:string;resources:{id:string;kind:string;source:{kind:string;path?:string}}[];relations:{kind:string;from:string;to:string}[];[key:string]:unknown}
 const dropped=new Set(manifest.resources.filter(r=>r.kind==='skill'&&!choice.skills.includes(r.id)).map(r=>r.id)),moved=new Map<string,string>()
 const resources=manifest.resources.filter(r=>!dropped.has(r.id)).map(r=>{
  if(r.kind!=='skill'||r.source.kind!=='local'||r.source.path!.endsWith('/SKILL.md'))return r
  const path=r.id+'/SKILL.md';moved.set(r.source.path!,path);return {...r,source:{kind:'local',path}}
 })
 const removed=new Set(manifest.resources.filter(r=>dropped.has(r.id)&&r.source.kind==='local').map(r=>r.source.path!))
 const removedFolders=[...removed].filter(path=>path.includes('/')).map(path=>path.slice(0,path.lastIndexOf('/')+1))
 const keptPaths=new Set(['teloa.json',...pkg.sourceFiles,...resources.filter(r=>r.source.kind==='local').map(r=>r.source.path!)])
 const keptSkillFolders=resources.filter(r=>r.kind==='skill'&&r.source.kind==='local'&&r.source.path!.includes('/')).map(r=>r.source.path!.slice(0,r.source.path!.lastIndexOf('/')+1))
 // 取消技能时连同它的静态附属文件移出本次内容；其它保留资源的显式文件与技能目录仍属于原组成。
 const removeFile=(path:string)=>!keptPaths.has(path)&&(removed.has(path)||removedFolders.some(folder=>path.startsWith(folder))&&!keptSkillFolders.some(folder=>path.startsWith(folder)))
 const relations=manifest.relations.filter(link=>!dropped.has(link.to))
 if(pkg.team){const lead=pkg.team.coordinatorResourceId;for(const r of resources)if(r.kind==='role'&&r.id!==lead)relations.push({kind:'role-coordination',from:lead,to:r.id})}
 const files=pkg.files.filter(f=>!removeFile(f.path)).map(f=>f.path==='teloa.json'?{path:f.path,text:JSON.stringify({...manifest,scope:choice.scope,resources,relations},null,2)}:moved.has(f.path)?{path:moved.get(f.path)!,text:f.text}:f)
 const encoder=new TextEncoder()
 const item=await readIndustryDirectory(files.map(f=>{const bytes=encoder.encode(f.text);return {path:f.path,size:bytes.length,read:async()=>bytes}}),'teloa.json',pkg.title)
 // 分享方的署名与许可只是声明；保留来源信息，不把离线文件提升为已签名或已审来源。
 return {...item,author:pkg.trust.publisher,license:pkg.license,trust:{publisher:pkg.trust.publisher,repository:null,license:{status:'declared',value:pkg.license},signature:{status:'unverified',signer:null},compatibility:{teloa:'未声明',dsh:'未声明'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review',summary:'本地上传来源尚未完成签名与兼容审查'}}}
}

const empty=(summary:ShareSummary,kind:'plugins'|'plans'):ShareAcceptItem[]=>summary[kind].map(r=>({resourceId:r.resourceId,title:r.title,state:'pending'}))
export function createShareAcceptance(storage:WorkbenchNavigationStorage,ports:ShareAcceptPorts){
 const legacy=createTemplateAcceptance(storage,{createRole:ports.createRole,...(ports.v1??{})} as Parameters<typeof createTemplateAcceptance>[1])
 let busy=false
 const progress=(sha256:string):Progress|undefined=>{const raw=storage.getItem(KEY+sha256);if(!raw)return undefined;const p=JSON.parse(raw) as Progress;if(p.sha256!==sha256||typeof p.scope!=='string'||!Array.isArray(p.skills)||!p.contentRequestId||!p.loadRequestId||!p.installs||p.sourceMetadataVersion!==undefined&&p.sourceMetadataVersion!==1)throw Error('Template recovery record is invalid.');return p}
 const selectedProgress=(sha256:string,summary:ShareSummary):Progress|undefined=>{
  const p=progress(sha256)
  // 旧空包在构造内容时即失败，尚无任何派发步骤才允许重新选择；未知回执仍锁定原申请。
  return p&&!hasShareSelection(summary,p.skills)&&!p.target&&!p.content&&!p.loadId&&Object.keys(p.installs).length===0?undefined:p
 }
 return {
  /** 已开始的接收沿用的原选择；界面据此锁定选择，只能继续原申请。 */
  async choice(value:SharePackage):Promise<ShareAcceptChoice|undefined>{const pkg=readSharePackage(value);if(!isSharePackageV2(pkg))return undefined;const p=selectedProgress(await sharePackageDigest(pkg),sharePackageSummary(pkg));return p?{scope:p.scope,skills:[...p.skills]}:undefined},
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
   const summary=sharePackageSummary(pkg),sha256=await sharePackageDigest(pkg),key=KEY+sha256
   // 选择只在首次确认时冻结；恢复与继续不改原范围、所选技能和任何已发出的请求参数。
   const previous=selectedProgress(sha256,summary)
   const p:Progress=previous??{sha256,scope:choice.scope,skills:summary.skills.map(s=>s.resourceId).filter(id=>choice.skills.includes(id)),contentRequestId:uuid(),loadRequestId:uuid(),sourceMetadataVersion:1,installs:{}}
   if(!hasShareSelection(summary,p.skills))throw Object.assign(Error('Choose at least one item to add.'),{code:'teloa/validation-error'})
   // 保留原请求，但不能把界面新确认的范围或技能静默替换成旧选择。
   if(previous&&(previous.scope!==choice.scope||new Set(previous.skills).size!==new Set(choice.skills).size||previous.skills.some(id=>!choice.skills.includes(id))))throw Object.assign(Error('Continue with the original saved template selection.'),{code:'acceptance-choice-conflict'})
   const save=()=>storage.setItem(key,JSON.stringify(p))
   save()
   if(!p.loadId){
    let item=await shareIndustryItem(pkg,p)
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
   if(installed){try{readiness=await industry.prepare(loadId)}catch{readiness=undefined}}
   const instances=await industry.roles(loadId)
   const roles:ShareAcceptanceResult['roles']=summary.roles.map(role=>{const target=itemOf(role.resourceId),instance=target?industryTeamRole(load,target.instanceId,instances):undefined;return {resourceId:role.resourceId,name:role.name,...(instance?.roleId?{roleId:instance.roleId}:{}),state:instance?.roleId&&['active','paused'].includes(instance.state)?'done':instance?.state==='failed'?'failed':'pending'}})
   const skills:ShareAcceptItem[]=summary.skills.map(s=>{const step=p.installs[s.resourceId];if(!p.skills.includes(s.resourceId))return {resourceId:s.resourceId,title:s.title,state:'skipped'};return {resourceId:s.resourceId,title:s.title,state:step?.state==='installed'?'done':step?.state==='failed'?'failed':'pending',...(step?.installationId?{installationId:step.installationId}:{}),...(step?.nativeName?{nativeName:step.nativeName}:{})}})
   // 连接只登记定义；需要本人授权的显示为已添加，账号授权仍在连接设置完成。
   const mcp:ShareAcceptItem[]=summary.connections.map(c=>{const row=readiness?.rows.find(r=>r.itemInstanceId===itemOf(c.resourceId)?.instanceId);return {resourceId:c.resourceId,title:c.title,state:!row?(readiness?'unavailable':'pending'):row.state==='ready'||row.entry==='connector-settings'?'done':row.state==='needs-user'?'failed':'pending'}})
   let coordinator:ShareAcceptItemState='skipped',coordinatorRoleId:string|undefined
   if(summary.coordinatorResourceId){const team=teamCoordination(load,instances);if(team){coordinator='done';coordinatorRoleId=team.coordinatorRoleId}else coordinator=load.relations.some(l=>l.kind==='role-coordination')?'pending':'failed'}
   let groupId:string|undefined
   if(summary.subject==='team'){
    const seed=industryTeamSeed(load,instances)
    if(seed)coordinatorRoleId=seed.coordinatorRoleId
    if(seed&&roles.every(role=>role.state==='done')){try{groupId=(await industry.team?.(seed))?.groupId}catch{/* 未核对的群不冒充接收完成。 */}}
    coordinator=groupId?'done':'pending'
   }
   const result:ShareAcceptanceResult={sha256,complete:false,...(groupId?{groupId}:{}),roleIds:roles.flatMap(r=>r.roleId?[r.roleId]:[]),roles,...(coordinatorRoleId?{coordinatorRoleId}:{}),coordinator,loadId,pendingKinds:[...new Set([...(summary.plans.length?['plan']:[]),...(summary.workTemplates.length?['work-template']:[]),...(summary.plugins.length?['plugin']:[])])],skills,mcp,plugins:empty(summary,'plugins'),plans:empty(summary,'plans')}
   result.complete=roles.every(r=>r.state==='done')&&[...skills,...mcp].every(i=>i.state==='done'||i.state==='skipped')&&(coordinator==='done'||coordinator==='skipped')
   return result
  }finally{busy=false}
 }}
}
