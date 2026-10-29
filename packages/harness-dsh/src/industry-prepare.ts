import {createHash} from 'node:crypto'
import {WorkError,isRecord,taskInput,industryResourceModelDependencies,industryModelReady,type IndustryModelDependency,type IndustryModelProbe,type IndustryModelObservation} from '@teloa/contract'

/**
 * 方案一键准备（规格 design specification）。
 * 只经既有 handler 读写，不绕过它们各自的校验；子请求 requestId 由宿主从（本人, 加载, 条目, 步骤, 摘要）派生，
 * 同一摘要重放得到同一批 id，下游按既有请求回执去重；状态一变摘要随之变，再点一次按新 id 续做。
 * 同一加载串行执行；同摘要的并发调用共用一次执行，各调用方只取消自己的等待。
 * 新员工上岗前经原 roles/edit 绑定同一加载已显式安装且实际可用的关联方法；面板与会话一键共用本 handler。
 * 员工经 role-connection 依赖的应用（扩展）：已核验（只新增配置行、未命中禁止项）的经原扩展接口登记→安装→启用；
 * 会改动现有配置或无法核验的不安装，记下原因归需要你操作，不扩大一键确认的授权。
 */
export const industryPrepareEndpoints=['industry-loads/readiness','industry-loads/prepare'] as const
type Call=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>
/** `roleRecords` 是原员工 handler 的 roles/list 与 roles/edit：新员工上岗前经它把本加载已装且可用的方法写回同一员工（CAS），未接入时不上岗。 */
export type IndustryPreparePorts={loads:Call;models?:IndustryModelProbe;modelTitle?:(id:string)=>string;knowledge:Call;roles:Call;roleRecords?:Call;skills:Call;mcp:Call;dataSources:Call;executionTools:Call;plugins:Call;lifecycle:(payload:unknown)=>Promise<unknown>;audit?:(entry:PrepareAudit)=>void;sleep?:(ms:number)=>Promise<void>;now?:()=>number;waitMs?:number}
export type PrepareStep='knowledge'|'skill'|'mcp'|'data-source'|'execution-tool'|'plugin'|'role'|'role-resume'
/**
 * 依赖应用归需要你操作的原因：unverified 会改动 DSH 现有配置、须本人查看权限后安装；rejected 无法核验或命中禁止项、不能安装；
 * restart-required 已启用、重启后生效；failed 安装失败；drift 固定来源已变化；unreadable 已登记而读不出。
 */
export type PluginHoldReason='unverified'|'rejected'|'restart-required'|'failed'|'drift'|'unreadable'
export type ReadinessEntry='model-settings'|'connector-settings'|'skill-confirm'|'skill-link'|'plugin'|'knowledge-retry'|'role-retry'|'role-resume'|'task-form'|'plan-form'
export type ReadinessState='ready'|'auto'|'needs-user'|'optional'|'pending'
/** trust 只出现在随一键安装、带信任声明的技能行上：确认卡与面板据此逐项列出名称与信任摘要，不静默安装。 */
export type SkillTrustSummary={publisher:string;license:string|null}
/** app 只出现在应用行上：方案声明的固定版本与（已登记时）npm 包名，确认卡与面板据此逐项列出将安装启用的应用。 */
export type PluginSummary={version:string;packageName:string|null}
export type ReadinessRow={itemInstanceId:string;kind:string;title:string;state:ReadinessState;step:Exclude<PrepareStep,'role-resume'>|null;entry:ReadinessEntry|null;trust?:SkillTrustSummary;models?:IndustryModelObservation[];reason?:PluginHoldReason;app?:PluginSummary}
export type IndustryReadiness={loadId:string;status:string;title:string;version:string;digest:string;counts:{ready:number;auto:number;needsUser:number;optional:number;pending:number};rows:ReadinessRow[]}
export type PrepareResult={itemInstanceId:string;title:string;step:PrepareStep;outcome:'done'|'pending'|'failed'|'skipped';code:string|null;message:string|null}
/** readiness 为 null 表示执行后读取最终清单失败、待刷新；results 照常返回。 */
export type PrepareReceipt={loadId:string;digest:string;results:PrepareResult[];readiness:IndustryReadiness|null}
export type PrepareChannel='panel'|'session'|'catalog'
/** 每次真正执行的一键准备写一条汇总（宿主日志）：哪一次、经哪个入口、各步骤结果、装了哪些技能。 */
export type PrepareAudit={loadId:string;digest:string;channel:PrepareChannel;outcomes:Record<PrepareResult['outcome'],number>;steps:Partial<Record<PrepareStep,number>>;skills:{itemInstanceId:string;trustHash:string|null;outcome:PrepareResult['outcome']}[]}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HEX=/^[0-9a-f]{64}$/
// 白名单：只有文本、数据与常见位图文件的技能可一键；其余（含无扩展名、可能带 shebang 或可执行位的文件、scripts/ 下的一切）
// 一律逐个确认，不进一键（规格 §3）
const INERT=/(^|\/)[^/]+\.(md|txt|json|ya?ml|csv|png|jpe?g|gif|webp|bmp|ico)$/i
const inert=(file:unknown)=>isRecord(file)&&typeof file.path==='string'&&INERT.test(file.path)&&!/(^|\/)scripts\//i.test(file.path)
// 信任声明按结构字段判定（规格 §3）：发布者为「Teloa 官方目录」（content-store.ts 只许 catalog 来源用此名；unsupported 条目在 official-catalog.ts add 处即拒，
// 故官方来源即非 unsupported）、审核 approved、签名非 invalid、无插件与外部能力、权限全部在只读白名单内，才可随一键安装
const OFFICIAL='Teloa 官方目录'
// 权限白名单：只有明确列出的纯内容/只读权限可进一键。目前官方信任声明只产出 network 与 tool:*，没有只读类权限，故为空——任何权限都逐个确认
const READ_ONLY_PERMISSIONS:ReadonlySet<string>=new Set()
function readOnlyOfficial(trust:unknown):SkillTrustSummary|null{
 if(!isRecord(trust)||trust.publisher!==OFFICIAL||!isRecord(trust.review)||trust.review.conclusion!=='approved'||!isRecord(trust.signature)||trust.signature.status==='invalid')return null
 if(!Array.isArray(trust.plugins)||trust.plugins.length>0||!Array.isArray(trust.externalCapabilities)||trust.externalCapabilities.length>0||!Array.isArray(trust.permissions))return null
 if(trust.permissions.some(p=>!isRecord(p)||typeof p.id!=='string'||!READ_ONLY_PERMISSIONS.has(p.id)))return null
 return {publisher:OFFICIAL,license:isRecord(trust.license)&&trust.license.status==='declared'&&typeof trust.license.value==='string'?trust.license.value:null}
}
// 原生观测状态只按固定枚举输出，不透传原文
const observedLabels:Record<string,string>={shadowed:'被同名技能遮蔽',missing:'未找到',disabled:'已停用'}
// 原生技能名与员工技能名同一口径；员工定义按原字段白名单回写，绑定只替换 skills
const NATIVE_NAME=/^[a-z0-9]+(?:-[a-z0-9]+)*$/
const ROLE_FIELDS=['avatarKey','name','kind','scopes','duty','dataScope','executionScope','skills','knowledge','responsibility','runtimeConfig'] as const
const CONTINUE='仍在处理，稍后再点一次「一键准备」继续。'
const PLUGIN_HOLD={unverified:'应用会改动 DSH 现有配置，未自动安装：请到「扩展」查看改动与权限后自行确认安装。',rejected:'应用的配置改动无法核验或命中禁止项，不能安装：请联系发布者或改用其他应用。'} as const
const PLUGIN_RESTART='应用已安装并启用，重启 Teloa 后生效；重启后到「扩展」核对，再到员工分组恢复上岗。'
const hostBad=()=>new WorkError('teloa/invalid-host-response','方案准备读取到的宿主回包格式不正确。')
const lower=(value:unknown)=>typeof value==='string'?value.toLowerCase():''
const items=(value:unknown):Record<string,unknown>[]=>{if(!isRecord(value)||!Array.isArray(value.items))throw hostBad();return value.items.filter(isRecord)}
const ofLoad=(rows:Record<string,unknown>[],loadId:string)=>rows.filter(row=>lower(row.loadId)===loadId)
const failureOf=(value:unknown,fallback:{code:string;message:string})=>isRecord(value)&&typeof value.code==='string'&&typeof value.message==='string'?{code:value.code,message:value.message}:fallback
const revisionOf=(value:unknown)=>Number.isSafeInteger(value)?Number(value):null

type LoadItem={instanceId:string;carriedFrom?:string;kind:string;title:string;required:boolean;status:string;version?:string;modelDependencies?:IndustryModelDependency[]}
type Load={id:string;status:string;title:string;version:string;mappingHash:string;items:LoadItem[];relations:{kind:string;from:string;to:string}[]}
type Fact={state:string;revision:number|null}
type RoleFact=Fact&{role:{id:string;version:number;state:string}|null}
/** 已登记安装的完整身份：进入准备摘要，绑定前按同一 usage 逐项重核；只比版本不能发现迁到另一份同版本安装。 */
type Installed={id:string;version:number|null;source:string;bundleHash:string|null;trustHash:string|null;native:string;name:string|null;bodyHash:string|null}
type SkillFact={raw:string;revision:number|null;installed:boolean;preparing:boolean;confirm:boolean;link?:boolean;bundleHash:string|null;trustHash:string|null;trust?:SkillTrustSummary;installation?:Installed}
type PluginFact=Fact&{id:string;drift:boolean;packageName:string|null}
/** 一键准备时预览得出的不可自动安装结论：按（加载, 条目）记在本人的准备 handler 里，只对同一实例修订有效；实例一推进（本人自行安装等）即失效。 */
type PluginHolds=Map<string,{revision:number|null;reason:PluginHoldReason}>
type Snapshot={load:Load;models:Map<string,IndustryModelObservation[]>;knowledge:Map<string,Fact>;roles:Map<string,RoleFact>;skills:Map<string,SkillFact>;connectors:Map<string,Fact>;plugins:Map<string,PluginFact>;holds:PluginHolds}

function readLoad(value:unknown):Load{
 if(!isRecord(value)||typeof value.id!=='string'||typeof value.status!=='string'||typeof value.templateTitle!=='string'||typeof value.templateVersion!=='string'||typeof value.mappingHash!=='string'||!Array.isArray(value.items)||!Array.isArray(value.relations))throw hostBad()
 const list=value.items.map(item=>{if(!isRecord(item)||typeof item.instanceId!=='string'||typeof item.kind!=='string'||typeof item.title!=='string'||typeof item.required!=='boolean'||typeof item.status!=='string')throw hostBad();return {instanceId:item.instanceId.toLowerCase(),...(typeof item.carriedFrom==='string'?{carriedFrom:item.carriedFrom.toLowerCase()}:{}),kind:item.kind,title:item.title,required:item.required,status:item.status,...(typeof item.version==='string'?{version:item.version}:{}),...industryResourceModelDependencies(item.kind,item.modelDependencies)}})
 const relations=value.relations.map(link=>{if(!isRecord(link)||typeof link.kind!=='string'||typeof link.from!=='string'||typeof link.to!=='string')throw hostBad();return {kind:link.kind,from:link.from.toLowerCase(),to:link.to.toLowerCase()}})
 return {id:value.id.toLowerCase(),status:value.status,title:value.templateTitle,version:value.templateVersion,mappingHash:value.mappingHash,items:list,relations}
}
const stable=(value:unknown):string=>JSON.stringify(value,(_,item)=>isRecord(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)
const installedOf=(row:Record<string,unknown>):Installed=>{const native=isRecord(row.native)?row.native:{};return {id:lower(row.id),version:revisionOf(row.version),source:stable(row.source),bundleHash:typeof row.bundleHash==='string'?row.bundleHash:null,trustHash:typeof row.trustHash==='string'?row.trustHash:null,native:stable(native),name:typeof native.name==='string'?native.name:null,bodyHash:typeof native.bodyHash==='string'?native.bodyHash:null}}
/**
 * 方案条目的固定引用：自装来源只认同一资源标识与版本——首次安装它的可以是另一加载（团队包与从它派生的单员工包共用同一份方法），
 * 字节摘要与原生正文由调用处逐项核对（跨加载共用安装须信任说明相同，由安装服务保证）；公共来源只认同一 sourceContent/sourceResource（skill-installations.ts:25）。其余来源不属于方案条目。
 */
function fixedReference(source:unknown):string|null{
 if(!isRecord(source))return null
 const pick=(keys:readonly string[])=>keys.every(key=>typeof source[key]==='string')?JSON.stringify([source.kind,...keys.map(key=>key.endsWith('Id')&&UUID.test(String(source[key]))?String(source[key]).toLowerCase():source[key])]):null
 if(source.kind==='industry-local')return pick(['resourceId','resourceVersion'])
 if(source.kind==='industry-public')return pick(['sourceContentId','sourceContentHash','sourceResourceId','sourceResourceVersion'])
 return null
}
/** 新加载尚无 usage 时只识别严格等价的本地行业方法；这里只读展示，不能代替本人的沿用确认。 */
function reusableLocalSkill(row:Record<string,unknown>,preview:Record<string,unknown>):boolean{
 if(!isRecord(row.source)||row.source.kind!=='industry-local'||!isRecord(preview.source)||preview.source.kind!=='industry-local'||!isRecord(row.native)||!isRecord(preview.native))return false
 const reference=fixedReference(row.source),stored=row.native,current=preview.native
 return reference!==null&&reference===fixedReference(preview.source)&&row.bundleHash===preview.bundleHash&&(row.trustHash??null)===(preview.trustHash??null)&&(['name','description','bodyHash','modelInvocable','userInvocable'] as const).every(key=>stored[key]===current[key])
}
const pluginOf=(row:unknown):PluginFact=>{if(!isRecord(row)||typeof row.id!=='string'||!UUID.test(row.id)||typeof row.state!=='string')throw hostBad();return {id:row.id.toLowerCase(),state:row.state,revision:revisionOf(row.revision),drift:row.drift===true,packageName:isRecord(row.definition)&&typeof row.definition.packageName==='string'?row.definition.packageName:null}}
const holdKey=(loadId:string,itemInstanceId:string)=>loadId+'/'+itemInstanceId
const roleOf=(row:Record<string,unknown>)=>isRecord(row.role)&&typeof row.role.id==='string'&&Number.isSafeInteger(row.role.version)&&typeof row.role.state==='string'?{id:row.role.id,version:Number(row.role.version),state:row.role.state}:null

async function snapshot(ports:IndustryPreparePorts,loadId:string,holds:PluginHolds,signal?:AbortSignal):Promise<Snapshot>{
 const load=readLoad(await ports.loads('industry-loads/get',{loadId},signal))
 if(load.id!==loadId)throw hostBad()
 const currentRows=(rows:Record<string,unknown>[]):Record<string,unknown>[]=>load.items.flatMap(item=>{const found=rows.find(row=>lower(row.itemInstanceId)===item.instanceId&&lower(row.loadId)===load.id)??(item.carriedFrom?rows.find(row=>lower(row.itemInstanceId)===item.carriedFrom):undefined);return found?[{...found,itemInstanceId:item.instanceId}]:[]})
 const facts=(rows:Record<string,unknown>[])=>new Map(currentRows(rows).map(row=>[lower(row.itemInstanceId),{state:String(row.state),revision:revisionOf(row.revision)}] as const))
 const knowledge=facts(items(await ports.knowledge('industry-knowledge/list',{},signal)))
 const roles=new Map(currentRows(items(await ports.roles('industry-roles/list',{},signal))).map(row=>[lower(row.itemInstanceId),{state:String(row.state),revision:revisionOf(row.revision),role:roleOf(row)}] as const))
 // 连接器列表逐行容错：读不出的行只进 errors（只带实例身份），对应条目由 classify 按「已登记但读不出」处理
 const connectors=new Map([...facts(items(await ports.mcp('industry-mcp-connections/list',{},signal))),...facts(items(await ports.dataSources('industry-data-sources/list',{},signal))),...facts(items(await ports.executionTools('industry-execution-tools/list',{},signal)))])
 const plugins=new Map(currentRows(items(await ports.plugins('industry-plugins/list',{},signal))).map(row=>[lower(row.itemInstanceId),pluginOf(row)] as const))
 // usages 固定安装归属；就绪还必须核对默认工作区实际加载的同一份正文。
 const listed=await ports.skills('skill-installations/list',{},signal)
 if(!isRecord(listed)||!Array.isArray(listed.items)||!Array.isArray(listed.usages))throw hostBad()
 const installs=new Map(listed.items.filter(isRecord).map(row=>[lower(row.id),{state:String(row.state),revision:revisionOf(row.version),identity:installedOf(row),record:row}] as const))
 const used=new Map(listed.usages.filter(isRecord).filter(use=>lower(use.loadId)===load.id).map(use=>[lower(use.itemInstanceId),installs.get(lower(use.installationId))] as const))
 const skills=new Map<string,SkillFact>()
 for(const item of load.items){
  if(item.kind!=='skill'||item.status==='skipped'||item.status==='detached')continue
  if(used.has(item.instanceId)){
   const found=used.get(item.instanceId)
   // 有使用登记但安装记录缺失：不重装、不当作处理中，归需要你操作
   if(!found){skills.set(item.instanceId,{raw:'missing',revision:null,installed:false,preparing:false,confirm:true,bundleHash:null,trustHash:null});continue}
   let observed='unverified'
   if(found.state==='installed'){
    try{
     const value=await ports.skills('skill-installations/observe',{installationId:found.identity.id},signal)
     if(isRecord(value)&&typeof value.state==='string')observed=value.state==='available'?isRecord(value.current)&&value.current.name===found.identity.name&&value.current.bodyHash===found.identity.bodyHash?'available':'mismatch':['shadowed','missing','disabled'].includes(value.state)?value.state:'unverified'
    }catch(error){if(signal?.aborted)throw error}
   }
   skills.set(item.instanceId,{raw:found.state+'/'+observed,revision:found.revision,installed:found.state==='installed'&&observed==='available',preparing:found.state!=='installed',confirm:found.state==='installed'&&observed!=='available',bundleHash:null,trustHash:null,installation:found.identity});continue
  }
  // 预览逐条捕获：单个技能读不出只让该条目归需要你操作，不拖垮整份清单
  let preview:unknown
  try{preview=await ports.skills('skill-installations/preview',{source:{kind:'industry',loadId:load.id,itemInstanceId:item.instanceId}},signal)}catch(error){if(signal?.aborted)throw error;preview=undefined}
  if(!isRecord(preview)||typeof preview.bundleHash!=='string'||!HEX.test(preview.bundleHash)||!Array.isArray(preview.files)){skills.set(item.instanceId,{raw:'preview-failed',revision:null,installed:false,preparing:false,confirm:true,bundleHash:null,trustHash:null});continue}
  const trustHash=typeof preview.trustHash==='string'&&HEX.test(preview.trustHash)?preview.trustHash:null
  const reusable=[...installs.values()].find(found=>reusableLocalSkill(found.record,preview))
  if(reusable){
   let observed='unverified'
   if(reusable.state==='installed')try{
    const value=await ports.skills('skill-installations/observe',{installationId:reusable.identity.id},signal)
    if(isRecord(value)&&typeof value.state==='string'){
     const current=value.current,stored=reusable.record.native
     observed=value.state==='available'?isRecord(current)&&isRecord(stored)&&(['name','description','bodyHash','modelInvocable','userInvocable'] as const).every(key=>current[key]===stored[key])?'available':'mismatch':['shadowed','missing','disabled'].includes(value.state)?value.state:'unverified'
    }
   }catch(error){if(signal?.aborted)throw error}
   skills.set(item.instanceId,{raw:'unlinked/'+reusable.state+'/'+observed,revision:reusable.revision,installed:false,preparing:false,confirm:true,link:true,bundleHash:preview.bundleHash,trustHash,installation:reusable.identity});continue
  }
  const scripted=!preview.files.every(inert),trust=trustHash?readOnlyOfficial(preview.trust):null
  // 没有信任声明的技能无法判定来源与审核，一律逐个确认
  const blocked=!trust
  skills.set(item.instanceId,{raw:scripted?'scripted':blocked?'trusted':'previewed',revision:null,installed:false,preparing:false,confirm:blocked||scripted,bundleHash:preview.bundleHash,trustHash,...(trust&&!scripted?{trust}:{})})
 }
 const models=new Map<string,IndustryModelObservation[]>(),phases=new Map<string,Promise<IndustryModelObservation['phase']>>()
 for(const item of load.items){
  if(!item.modelDependencies||item.status==='skipped'||item.status==='detached')continue
  const observations:IndustryModelObservation[]=[]
  for(const dependency of item.modelDependencies){
   const key=[dependency.catalogId,dependency.version,dependency.usage].join('/')
   // 同一份准备清单共用一次原生状态观察，多个入口不会重复启动或下载模型。
   if(!phases.has(key))phases.set(key,ports.models?ports.models(dependency).catch(()=> 'unavailable' as const):Promise.resolve('unavailable'))
   observations.push({...dependency,title:ports.modelTitle?.(dependency.catalogId)??dependency.catalogId,phase:await phases.get(key)!})
  }
  models.set(item.instanceId,observations)
 }
 return {load,knowledge,roles,skills,connectors,plugins,models,holds}
}

type Classified=Pick<ReadinessRow,'state'|'step'|'entry'|'trust'|'reason'|'app'>&{raw:string;revision:number|null}
const connectorStep={mcp:'mcp','data-source':'data-source','execution-tool':'execution-tool'} as const
function classify(s:Snapshot,item:LoadItem):Classified|null{
 const row=(state:ReadinessState,raw:string,revision:number|null,step:ReadinessRow['step']=null,entry:ReadinessEntry|null=null):Classified=>({state,step,entry,raw,revision})
 if(item.status==='skipped'||item.status==='detached')return null
 const id=item.instanceId
 const missing=s.models.get(id)?.filter(model=>model.required&&!industryModelReady(model.phase))??[]
 if(missing.length)return row('needs-user',missing.map(model=>model.phase).join('/'),null,null,'model-settings')
 switch(item.kind){
  case 'knowledge':{
   const v=s.knowledge.get(id);if(!v)return row('auto','none',null,'knowledge')
   if(v.state==='active')return row('ready',v.state,v.revision)
   if(v.state==='pending')return row('pending',v.state,v.revision)
   return v.state==='failed'?row('needs-user',v.state,v.revision,null,'knowledge-retry'):null
  }
  case 'role':{
   const v=s.roles.get(id);if(!v)return row('auto','none',null,'role')
   const raw=[v.state,v.role?.state??'-',v.role?.version??'-'].join('/')
   if(v.state==='pending')return row('pending',raw,v.revision)
   if(v.state==='failed')return row('needs-user',raw,v.revision,null,'role-retry')
   if(v.role?.state==='active'||v.state==='active')return row('ready',raw,v.revision)
   // 原本就暂停（含本人主动暂停）的岗位只给入口，不自动恢复（规格 §4 第 5 步）
   return v.role?.state==='paused'||v.state==='paused'?row('needs-user',raw,v.revision,null,'role-resume'):null
  }
  case 'skill':{
   const v=s.skills.get(id);if(!v)return null
   if(v.installed)return row('ready',v.raw,v.revision)
   if(v.preparing)return row('pending',v.raw,v.revision)
   return v.confirm?row('needs-user',v.raw,v.revision,null,v.link?'skill-link':'skill-confirm'):{...row('auto',v.raw,v.revision,'skill'),...(v.trust?{trust:v.trust}:{})}
  }
  case 'mcp':case 'data-source':case 'execution-tool':{
   const v=s.connectors.get(id)
   // 列表里没有、但加载条目已不是 pending-adapter：已登记而读不出（列表 errors），归需要你操作，绝不重复登记
   if(!v)return item.status==='pending-adapter'?row('auto','none',null,connectorStep[item.kind as keyof typeof connectorStep]):row('needs-user','unreadable',null,null,'connector-settings')
   if(v.state==='active')return row('ready',v.state,v.revision)
   return v.state==='needs_connection'||v.state==='needs_authorization'?row('needs-user',v.state,v.revision,null,'connector-settings'):null
  }
  case 'plugin':{
   const v=s.plugins.get(id),version=item.version??null
   const app=(c:Classified):Classified=>version?{...c,app:{version,packageName:v?.packageName??null}}:c
   const hold=(reason:PluginHoldReason,raw:string=reason):Classified=>app({...row('needs-user',raw,v?.revision??null,null,'plugin'),reason})
   if(v?.state==='detached')return null
   if(v?.state==='active')return app(row('ready',v.state,v.revision))
   if(v?.state==='installing')return app(row('pending',v.state,v.revision))
   // 只有员工经 role-connection 依赖的应用才随一键安装启用；未被员工依赖的应用条目照旧由本人在「扩展」中处理
   if(!s.load.relations.some(link=>link.kind==='role-connection'&&link.to===id))return app(row('needs-user',v?.state??'none',v?.revision??null,null,'plugin'))
   // 与连接同口径：列表里没有、但加载条目已不是 pending-adapter，是已登记而读不出，绝不重复登记
   if(!v)return item.status==='pending-adapter'?app(row('auto','none',null,'plugin')):hold('unreadable')
   if(v.drift)return hold('drift')
   const held=s.holds.get(holdKey(s.load.id,id))
   if(held&&held.revision===v.revision)return hold(held.reason,'held:'+held.reason)
   if(v.state==='needs_install'||v.state==='pending-enable')return app(row('auto',v.state,v.revision,'plugin'))
   return v.state==='restart-required'||v.state==='failed'?hold(v.state):null
  }
  case 'work-template':return row('optional','-',null,null,'task-form')
  case 'plan':return row('optional','-',null,null,'plan-form')
  default:return null
 }
}

function buildReadiness(s:Snapshot):IndustryReadiness{
 const rows:ReadinessRow[]=[],facts:unknown[]=[]
 for(const item of s.load.items){
  const c=classify(s,item);if(!c)continue
  rows.push({itemInstanceId:item.instanceId,kind:item.kind,title:item.title,state:c.state,step:c.step,entry:c.entry,...(c.trust?{trust:c.trust}:{}),...(s.models.has(item.instanceId)?{models:s.models.get(item.instanceId)!}:{}),...(c.reason?{reason:c.reason}:{}),...(c.app?{app:c.app}:{})})
  facts.push([item.instanceId,item.status,c.state,c.step,c.entry,c.raw,c.revision,s.models.get(item.instanceId)??null])
 }
 const count=(state:ReadinessState)=>rows.filter(row=>row.state===state).length
 const hashes=[...s.skills].filter(([,v])=>!v.installed&&!v.preparing).map(([id,v])=>[id,v.bundleHash,v.trustHash].join('/')).sort()
 // 已登记安装按完整身份固定：usage 迁到另一份安装（即便版本相同）都会改变摘要
 const installations=[...s.skills].filter(([,v])=>v.installation).map(([id,v])=>stable([id,v.installation])).sort()
 // 摘要纳入原始状态与 revision：同一分类下底层状态有任何推进，摘要都会变
 const digest=createHash('sha256').update(JSON.stringify(['teloa-industry-readiness/v3',s.load.id,s.load.mappingHash,facts,hashes,installations])).digest('hex')
 return {loadId:s.load.id,status:s.load.status,title:s.load.title,version:s.load.version,digest,counts:{ready:count('ready'),auto:count('auto'),needsUser:count('needs-user'),optional:count('optional'),pending:count('pending')},rows}
}

/** `plugin-install` 是依赖应用登记之后的安装请求：与登记（`plugin`）各用一份 id。 */
export function prepareRequestId(owner:string,loadId:string,itemInstanceId:string,step:PrepareStep|'plugin-install',digest:string):string{
 const h=createHash('sha256').update(['teloa-industry-prepare/v1',owner,loadId,itemInstanceId,step,digest].join('\0')).digest('hex')
 return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
}
const failure=(error:unknown)=>error instanceof WorkError?{code:error.code as string,message:error.message}:{code:'teloa/dependency-unavailable',message:'宿主服务暂不可用，请稍后重试。'}

/**
 * 底层执行不接调用方的取消信号：共用这次执行的其他调用方不因首个调用方断开而失败。
 * `activate:false`（单个目录员工的完整资源安装）照常实例化资料、建立员工并绑定实际方法，但不代为恢复上岗：员工保持暂停，由本人检查后恢复。
 */
async function execute(owner:string,ports:IndustryPreparePorts,s:Snapshot,readiness:IndustryReadiness,activate=true):Promise<PrepareResult[]>{
 const sleep=ports.sleep??((ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))),now=ports.now??Date.now,deadline=now()+(ports.waitMs??20000)
 const results:PrepareResult[]=[],loadId=s.load.id,digest=readiness.digest
 const id=(row:ReadinessRow,step:PrepareStep|'plugin-install')=>prepareRequestId(owner,loadId,row.itemInstanceId,step,digest)
 const due=(step:ReadinessRow['step'])=>readiness.rows.filter(row=>row.state==='auto'&&row.step===step)
 const push=(row:ReadinessRow,step:PrepareStep,outcome:PrepareResult['outcome'],detail?:{code:string;message:string}|string)=>{results.push({itemInstanceId:row.itemInstanceId,title:row.title,step,outcome,code:typeof detail==='object'?detail.code:null,message:typeof detail==='object'?detail.message:detail??null})}
 const attempt=async<T>(row:ReadinessRow,step:PrepareStep,action:()=>Promise<T>):Promise<{value:T}|undefined>=>{try{return {value:await action()}}catch(error){push(row,step,'failed',failure(error));return undefined}}
 const until=async<T>(read:()=>Promise<T|undefined>):Promise<T|undefined>=>{for(;;){const value=await read();if(value!==undefined)return value;if(now()>=deadline)return undefined;await sleep(500)}}
 const knowledgeRows=async()=>ofLoad(items(await ports.knowledge('industry-knowledge/list',{})),loadId)
 const roleRow=async(itemInstanceId:string)=>ofLoad(items(await ports.roles('industry-roles/list',{})),loadId).find(row=>lower(row.itemInstanceId)===itemInstanceId)

 // 1 资料：实例化后等到不再 pending
 const started:ReadinessRow[]=[]
 for(const row of due('knowledge'))if(await attempt(row,'knowledge',()=>ports.knowledge('industry-knowledge/instantiate',{requestId:id(row,'knowledge'),loadId,itemInstanceId:row.itemInstanceId})))started.push(row)
 for(const row of started){
  const settled=await attempt(row,'knowledge',()=>until(async()=>{const found=(await knowledgeRows()).find(v=>lower(v.itemInstanceId)===row.itemInstanceId);return !found||found.state==='pending'?undefined:found}))
  if(!settled)continue
  const found=settled.value
  if(!found)push(row,'knowledge','pending',CONTINUE)
  else if(found.state==='active')push(row,'knowledge','done')
  else push(row,'knowledge','failed',failureOf(found.failure,{code:'teloa/source-unavailable',message:'资料启用失败，请到资料分组查看原因。'}))
 }
 // 2 技能：只装可一键的（带信任声明的按预览 trustHash 固定）；观测到 available 才算完成
 const installedNow=new Map<string,string>()
 for(const row of due('skill')){
  const skill=s.skills.get(row.itemInstanceId)!
  const installed=await attempt(row,'skill',async()=>{const result=await ports.skills('skill-installations/install',{requestId:id(row,'skill'),source:{kind:'industry',loadId,itemInstanceId:row.itemInstanceId},expectedBundleHash:skill.bundleHash,...(skill.trustHash?{expectedTrustHash:skill.trustHash}:{})});if(!isRecord(result)||!isRecord(result.installation)||typeof result.installation.id!=='string')throw hostBad();return result.installation.id})
  if(!installed)continue
  installedNow.set(row.itemInstanceId,lower(installed.value))
  const observed=await attempt(row,'skill',()=>until(async()=>{const v=await ports.skills('skill-installations/observe',{installationId:installed.value});if(!isRecord(v)||typeof v.state!=='string')throw hostBad();return v.state==='pending'||v.state==='installing'?undefined:v.state}))
  if(!observed)continue
  if(observed.value===undefined)push(row,'skill','pending',CONTINUE)
  else if(observed.value==='available')push(row,'skill','done')
  else push(row,'skill','failed',{code:'teloa/dependency-unavailable',message:`技能安装后${observedLabels[observed.value]??'状态未知'}，未生效。`})
 }
 // 3 连接器：只登记，不试连、不授权
 const connectorPort={mcp:['mcp','industry-mcp-connections/instantiate'],'data-source':['dataSources','industry-data-sources/instantiate'],'execution-tool':['executionTools','industry-execution-tools/instantiate']} as const
 for(const step of ['mcp','data-source','execution-tool'] as const)for(const row of due(step)){
  const [port,endpoint]=connectorPort[step]
  if(await attempt(row,step,()=>ports[port](endpoint,{requestId:id(row,step),loadId,itemInstanceId:row.itemInstanceId})))push(row,step,'done')
 }
 // 4 应用：未登记的先登记；预览核验为 verified（只新增配置行、未命中禁止项）才按同一份预览安装、启用；
 // 会改动现有配置或无法核验的不安装，原因记到本 handler，清单据此归需要你操作，再点一键也不会自动装
 const settledPlugin=(plugin:PluginFact):{outcome:PrepareResult['outcome'];detail?:{code:string;message:string}|string}=>plugin.state==='active'?{outcome:'done'}
  :plugin.state==='detached'?{outcome:'skipped',detail:'应用已从方案解除，未安装。'}
  :plugin.state==='restart-required'?{outcome:'skipped',detail:PLUGIN_RESTART}:plugin.state==='installing'?{outcome:'pending',detail:CONTINUE}
  :{outcome:'failed',detail:{code:'teloa/dependency-unavailable',message:'应用安装失败，请到「扩展」查看原因后重试。'}}
 for(const row of due('plugin')){
  const done=await attempt(row,'plugin',async()=>{
   let plugin=s.plugins.get(row.itemInstanceId)??pluginOf(await ports.plugins('industry-plugins/instantiate',{requestId:id(row,'plugin'),loadId,itemInstanceId:row.itemInstanceId}))
   // 登记时已找到本人此前装好的同一份应用：沿用其真实状态，不重装
   if(plugin.state!=='needs_install'&&plugin.state!=='pending-enable')return settledPlugin(plugin)
   const preview=await ports.plugins('industry-plugins/preview',{instanceId:plugin.id})
   if(!isRecord(preview)||!isRecord(preview.trust)||typeof preview.trust.status!=='string')throw hostBad()
   if(preview.trust.status!=='verified'){
    const reason=preview.trust.status==='unverified'?'unverified':'rejected'
    s.holds.set(holdKey(loadId,row.itemInstanceId),{revision:plugin.revision,reason});while(s.holds.size>200)s.holds.delete(s.holds.keys().next().value!)
    return {outcome:'skipped' as const,detail:PLUGIN_HOLD[reason]}
   }
   if(plugin.state==='needs_install')plugin=pluginOf(await ports.plugins('industry-plugins/install',{requestId:id(row,'plugin-install'),instanceId:plugin.id,expectedRevision:plugin.revision,preview}))
   if(plugin.state==='pending-enable')plugin=pluginOf(await ports.plugins('industry-plugins/enable',{instanceId:plugin.id,preview}))
   return settledPlugin(plugin)
  })
  if(done)push(row,'plugin',done.value.outcome,done.value.detail)
 }
 // 5 岗位：以执行到此处的最新清单为准——必需资料 ready 才实例化；建好后关联资料、技能、连接都 ready 才上岗
 const mid=await snapshot(ports,loadId,s.holds).then(buildReadiness,()=>undefined)
 const states=new Map(mid?.rows.map(row=>[row.itemInstanceId,row.state] as const)??[])
 const linked=(roleItem:string,kinds:readonly string[],requiredOnly:boolean)=>s.load.relations.filter(link=>link.from===roleItem&&kinds.includes(link.kind)).map(link=>s.load.items.find(item=>item.instanceId===link.to)).filter((item):item is LoadItem=>!!item&&item.status!=='skipped'&&item.status!=='detached'&&(!requiredOnly||item.required))
 const resume:ReadinessRow[]=[]
 for(const row of due('role')){
  if(!mid){push(row,'role','skipped',CONTINUE);continue}
  if(linked(row.itemInstanceId,['role-knowledge'],true).some(item=>states.get(item.instanceId)!=='ready')){push(row,'role','skipped','员工依赖的资料仍在启用，稍后再点一次「一键准备」继续。');continue}
  if(!await attempt(row,'role',()=>ports.roles('industry-roles/instantiate',{requestId:id(row,'role'),loadId,itemInstanceId:row.itemInstanceId})))continue
  const settled=await attempt(row,'role',()=>until(async()=>{const v=await roleRow(row.itemInstanceId);return !v||v.state==='pending'?undefined:v}))
  if(!settled)continue
  const found=settled.value
  if(!found){push(row,'role','pending',CONTINUE);continue}
  if(found.state==='failed'){push(row,'role','failed',failureOf(found.failure,{code:'teloa/conflict',message:'员工创建失败，请到员工分组查看原因。'}));continue}
  push(row,'role','done')
  resume.push(row)
 }
 // 6a 方法：只给本批首建、未被改过的暂停员工（v1）绑定同一加载已显式安装且实际可用的关联方法，经原 roles/edit（事务与 CAS）保存；
 // 绑定前重新核对关联、安装来源、原生名与实际可用，任一缺项都保持暂停并返回缺项，不让空方法员工上岗。
 const bindMethods=async(row:ReadinessRow,role:{id:string;version:number}):Promise<{version:number}|{gap:string}>=>{
  const methods=linked(row.itemInstanceId,['role-skill'],false)
  if(!methods.length)return {version:role.version}
  const gap=(reason:string)=>({gap:'员工已创建并保持暂停：'+reason+'，处理后到员工分组恢复。'})
  if(!ports.roleRecords)return gap('方法绑定服务未接入')
  const listedRoles=await ports.roleRecords('roles/list',{})
  if(!Array.isArray(listedRoles))throw hostBad()
  const current=listedRoles.find(value=>isRecord(value)&&value.id===role.id)
  if(!isRecord(current)||current.kind!=='employee'||current.state!=='paused'||current.version!==1||role.version!==1||!Array.isArray(current.skills)||current.skills.length)return gap('员工已被修改，未覆盖其方法设置')
  const load=readLoad(await ports.loads('industry-loads/get',{loadId}))
  if(load.id!==loadId||load.status!=='active'||load.mappingHash!==s.load.mappingHash)return gap('方案关联已变化，请重新核对后再准备')
  const listed=await ports.skills('skill-installations/list',{})
  if(!isRecord(listed)||!Array.isArray(listed.items)||!Array.isArray(listed.usages))throw hostBad()
  const names:string[]=[]
  for(const method of methods){
   if(!load.relations.some(link=>link.kind==='role-skill'&&link.from===row.itemInstanceId&&link.to===method.instanceId)||!load.items.some(item=>item.instanceId===method.instanceId&&item.kind==='skill'&&item.status!=='skipped'&&item.status!=='detached'))return gap('方案关联已变化，请重新核对后再准备')
   const label='方法「'+method.title+'」'
   const usage=listed.usages.filter(isRecord).find(use=>lower(use.loadId)===loadId&&lower(use.itemInstanceId)===method.instanceId)
   const installation=usage?listed.items.filter(isRecord).find(value=>lower(value.id)===lower(usage.installationId)):undefined
   if(!installation||installation.state!=='installed')return gap(label+'未安装或已撤销')
   const native=installation.native
   if(typeof installation.id!=='string'||!isRecord(native)||typeof native.name!=='string'||!NATIVE_NAME.test(native.name)||native.name.length>80||typeof native.bodyHash!=='string'||!HEX.test(native.bodyHash))throw hostBad()
   // 同一 usage 仍须指向本人确认时的那份安装：确认前已装的按摘要固定的完整身份比对；本次一键所装的按安装回执 ID 与确认时的预览包摘要比对
   const confirmed=s.skills.get(method.instanceId),identity=installedOf(installation),installedHere=installedNow.get(method.instanceId)
   if(confirmed?.installation?stable(identity)!==stable(confirmed.installation):installedHere===undefined||identity.id!==installedHere||identity.bundleHash!==confirmed?.bundleHash)return gap(label+'的安装在确认后已变化')
   // 只读预览解析本加载条目的固定引用与正文：真实安装须来自同一引用（公共来源允许首次安装在另一加载），不重新安装
   const fixed=await ports.skills('skill-installations/preview',{source:{kind:'industry',loadId,itemInstanceId:method.instanceId}})
   if(!isRecord(fixed)||!isRecord(fixed.native)||typeof fixed.bundleHash!=='string')throw hostBad()
   const reference=fixedReference(installation.source)
   if(!reference||reference!==fixedReference(fixed.source)||installation.bundleHash!==fixed.bundleHash||native.name!==fixed.native.name||native.bodyHash!==fixed.native.bodyHash)return gap(label+'的安装与方案固定来源不一致')
   if(names.includes(native.name))return gap(label+'与其他方法同名')
   const seen=await ports.skills('skill-installations/observe',{installationId:installation.id})
   if(!isRecord(seen)||typeof seen.state!=='string')throw hostBad()
   if(seen.state!=='available')return gap(label+(observedLabels[seen.state]??'状态未知'))
   if(!isRecord(seen.current)||seen.current.name!==native.name||seen.current.bodyHash!==native.bodyHash)return gap(label+'已被替换为其他内容')
   names.push(native.name)
  }
  const fields=Object.fromEntries(ROLE_FIELDS.filter(key=>current[key]!==undefined).map(key=>[key,key==='skills'?names:current[key]]))
  const saved=await ports.roleRecords('roles/edit',{roleId:role.id,expectedVersion:1,fields,expectedProfile:{name:current.name,...(current.avatarKey===undefined?{}:{avatarKey:current.avatarKey})}})
  if(!isRecord(saved)||saved.id!==role.id||saved.version!==2||saved.state!=='paused'||!Array.isArray(saved.skills)||saved.skills.join('\0')!==names.join('\0'))throw hostBad()
  return {version:2}
 }
 // 6b 上岗：只恢复本次新建的岗位；恢复会一并启用该岗位的每日小结（role-lifecycle.ts:68）
 for(const row of resume){
  const current=await attempt(row,'role-resume',()=>roleRow(row.itemInstanceId))
  if(!current)continue
  const role=current.value?roleOf(current.value):null
  if(!role){push(row,'role-resume','skipped','员工尚未就绪。');continue}
  if(role.state==='active'){push(row,'role-resume','done');continue}
  if(role.state!=='paused'){push(row,'role-resume','skipped','员工当前状态不能上岗。');continue}
  // 方法就绪即先绑定实际安装的原生名：连接仍待本人授权时员工保持暂停，但已经带着真实方法，不留空方法员工。
  const ready=(kinds:readonly string[])=>!linked(row.itemInstanceId,kinds,false).some(item=>states.get(item.instanceId)!=='ready')
  let version=role.version
  if(ready(['role-skill'])){
   const bound=await attempt(row,'role-resume',()=>bindMethods(row,role))
   if(!bound)continue
   if('gap' in bound.value){push(row,'role-resume','skipped',bound.value.gap);continue}
   version=bound.value.version
  }
  if(!activate){push(row,'role-resume','skipped','员工已创建并保持暂停：请检查后在「员工」中恢复。');continue}
  // 新岗位默认暂停；只有关联资料、技能、连接与应用都已就绪才视为检查完成、代为恢复，否则保持暂停交本人检查
  // 关联项缺失于清单（已撤回、已解除等无法归类）同样视为未就绪
  if(!ready(['role-knowledge','role-skill','role-connection'])){push(row,'role-resume','skipped','员工已创建并保持暂停：关联的资料、技能、连接或应用还没就绪，处理后到员工分组恢复。');continue}
  if(await attempt(row,'role-resume',()=>ports.lifecycle({roleId:role.id,expectedVersion:version,action:'resume',reason:'方案一键准备'})))push(row,'role-resume','done')
 }
 return results
}

/** 宿主内部或公开载荷的 `activate:false` 只收紧准备行为：建立并绑定方法后保持暂停。 */
export function createIndustryPrepareHandler(owner:string,get:()=>Promise<IndustryPreparePorts>){
 const tally=<K extends string>(keys:K[])=>keys.reduce((m,k)=>({...m,[k]:(m[k]??0)+1}),{} as Partial<Record<K,number>>)
 const inflight=new Map<string,Promise<PrepareReceipt>>(),receipts=new Map<string,PrepareReceipt>(),lanes=new Map<string,Promise<unknown>>(),holds:PluginHolds=new Map()
 const remember=(key:string,value:PrepareReceipt)=>{receipts.set(key,value);while(receipts.size>50)receipts.delete(receipts.keys().next().value!)}
 // 各调用方只等待、只取消自己的这一份
 const wait=<T>(work:Promise<T>,signal?:AbortSignal):Promise<T>=>!signal?work:new Promise<T>((resolve,reject)=>{
  if(signal.aborted)return reject(signal.reason)
  const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true})
  work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop))
 })
 return async(method:string,payload:unknown,signal?:AbortSignal,channel:PrepareChannel='panel',options:{activate?:boolean}={}):Promise<IndustryReadiness|PrepareReceipt>=>{
  if(typeof owner!=='string'||!owner.trim())throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  if(method==='industry-loads/readiness'){
   const input=taskInput(payload,['loadId'])
   if(typeof input.loadId!=='string'||!UUID.test(input.loadId))throw new WorkError('teloa/invalid-input','加载身份必须是 UUID。')
   return buildReadiness(await snapshot(await get(),input.loadId.toLowerCase(),holds,signal))
  }
  if(method==='industry-loads/prepare'){
   const input=taskInput(payload,['loadId','expectedDigest','activate'])
   if(typeof input.loadId!=='string'||!UUID.test(input.loadId)||typeof input.expectedDigest!=='string'||!HEX.test(input.expectedDigest))throw new WorkError('teloa/invalid-input','加载身份必须是 UUID，摘要必须是 64 位十六进制。')
   // 公开载荷只能收紧：`activate:false` 让本次准备建好员工后保持暂停（分享副本不自动上岗）；其余值一律拒绝，缺省沿用一键准备原语义。宿主内部 options.activate:false 仍最高限制。
   if(input.activate!==undefined&&input.activate!==false)throw new WorkError('teloa/invalid-input','activate 只能省略或为 false。')
   const loadId=input.loadId.toLowerCase(),expected=input.expectedDigest,activate=options.activate!==false&&input.activate!==false,key=loadId+'/'+expected+(activate?'':'/paused')
   const done=receipts.get(key);if(done)return structuredClone(done)
   let running=inflight.get(key)
   if(!running){
    // 同一加载串行：后到者排在前一次之后，轮到时按最新状态复核摘要，因此两次一键只会执行一次
    const previous=lanes.get(loadId)??Promise.resolve()
    running=previous.catch(()=>{}).then(async()=>{
     const ports=await get(),s=await snapshot(ports,loadId,holds)
     if(s.load.status!=='active')throw new WorkError('teloa/conflict','方案已卸载或已被升级替代，不能准备。')
     const readiness=buildReadiness(s)
     if(readiness.digest!==expected)throw new WorkError('teloa/version-conflict','方案状态已变化，请重新核对后再确认。')
     if(readiness.counts.auto===0)throw new WorkError('teloa/conflict','该方案当前没有可一键完成的项，其余项请到「准备就绪」里处理。')
     const results=await execute(owner,ports,s,readiness,activate)
     // 审计只写日志，写失败不影响已执行的回执
     try{ports.audit?.({loadId,digest:readiness.digest,channel,outcomes:{done:0,pending:0,failed:0,skipped:0,...tally(results.map(row=>row.outcome))},steps:tally(results.map(row=>row.step)),
      skills:results.filter(row=>row.step==='skill').map(row=>({itemInstanceId:row.itemInstanceId,trustHash:s.skills.get(row.itemInstanceId)?.trustHash??null,outcome:row.outcome}))})}catch{/* 见上 */}
     // 已执行的写不能因最终读取失败而丢失回执：清单记 null（待刷新），结果照常返回
     const after=await snapshot(ports,loadId,holds).then(buildReadiness,()=>null)
     const receipt:PrepareReceipt={loadId,digest:readiness.digest,results,readiness:after}
     // 只缓存全部完成且带最终清单的回执；含失败、处理中、跳过或清单待刷新的不缓存，再点一次按新摘要续做
     if(after&&results.every(row=>row.outcome==='done'))remember(key,receipt)
     return receipt
    })
    inflight.set(key,running);lanes.set(loadId,running)
    const settled=running
    void settled.catch(()=>{}).finally(()=>{inflight.delete(key);if(lanes.get(loadId)===settled)lanes.delete(loadId)})
   }
   return structuredClone(await wait(running,signal))
  }
  throw new WorkError('teloa/invalid-input','不支持的方案准备操作。')
 }
}
