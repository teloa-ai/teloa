import {lockBusinessConfiguration} from './business-configuration-lock.ts'
import {BusinessConfigurationStore} from './business-configuration-store.ts'
import type {Pool,PoolClient} from 'pg'
import {createHash} from 'node:crypto'
import {WorkError,isRecord,industryResourceModelDependencies,type IndustryModelDependency,compareIndustryUpdateCore,industryUpdateCanonical,industryUpdateChoiceProblem,readIndustryUpdateChoices,type IndustryUpdateChoices} from '@teloa/contract'
import {detachIndustryInstanceByItem} from './industry-instance-kit.ts'
import {initializeBusinessSpaces} from './business-spaces.ts'
import {BusinessScopeService,isBusinessScopeDomain} from './business-scopes.ts'
import {readEdition} from '../edition.ts'
import {detachTableByKind as retireDetachTableByKind,detachTables,presentTables,carriedInstanceHolders,pauseLoadPlans,retireIndustryLoadInTransaction,type IndustryLoadPlanPort} from './industry-load-retire.ts'
import type {IndustryLoadContent,IndustryLoadSource,IndustryLoadSourceSnapshot} from './industry-load-source.ts'
export type {IndustryLoadContent,IndustryLoadSource,IndustryLoadSourceSnapshot} from './industry-load-source.ts'

export type IndustryLoadResourceKind='role'|'knowledge'|'skill'|'mcp'|'plugin'|'data-source'|'execution-tool'|'work-template'|'plan'|'object-type'|'business-view'|'business-action'|'business-configuration'
/** 目标锁定用的版本判定。`enterprise` 尚未交付，只能由调用方显式注入：保留多空间分支，并让测试同时覆盖两侧。 */
export type IndustryLoadEdition='personal'|'enterprise'
export type IndustryLoadStoredStatus='pending-adapter'|'skipped'
export type IndustryLoadItemStatus=IndustryLoadStoredStatus|'instantiated'|'active'|'detached'
/** `carriedFrom` 指向被替代加载上的同名资源实例：本项沿用旧实例，不再另行实例化；只有有实例投影的六类会带它。 */
export type IndustryLoadItem={localId:string;instanceId:string;kind:IndustryLoadResourceKind;title:string;version:string;required:boolean;status:IndustryLoadItemStatus;carriedFrom?:string;modelDependencies?:IndustryModelDependency[]}
/** 加载自身的生命周期：`unloaded` 由卸载产生，`superseded` 由升级产生，两者都不再提供可执行血缘。 */
export type IndustryLoadStatus='active'|'unloaded'|'superseded'
/** 继任加载的升级血缘：被替代的加载、它的模板版本，以及当时固定下来的升级计划。非继任加载没有这一段。 */
export type IndustryLoadUpgrade={loadId:string;templateVersion:string;choices:IndustryUpdateChoices;diffDigest:string;createdAt:string}
/** `domain` 是市场行业归类；`scope`/`space.scope` 是这次加载所属的业务范围标签，不再是 `space-<id>`。 */
export type IndustryLoadRecord={id:string;ownerId:string;contentId:string;contentHash:string;templateId:string;templateVersion:string;templateTitle:string;domain:string;scope:string;description:string;targetVersion:number;space:{id:string;name:string;version:number;scope:string};items:IndustryLoadItem[];relations:Array<{kind:string;from:string;to:string}>;entrypoints:string[];createdAt:string;mappingHash:string;status:IndustryLoadStatus;unloadedAt?:string;upgrade?:IndustryLoadUpgrade}
export type IndustryLoadPage={items:IndustryLoadRecord[]}
/** 卸载被拒绝时回报的在途事实：本人据此先收尾，再重新发起卸载。 */
export type IndustryLoadUnloadBlocker={kind:'plan-occurrence'|'task-run';id:string}
/** 升级按 `use-template` 重放岗位模板字段所需的最小端口，由 `IndustryRoleService.applyTemplateInTransaction` 满足。 */
export type IndustryLoadRolePort={applyTemplateInTransaction:(db:PoolClient,ownerId:string,input:unknown)=>Promise<unknown>}

const kinds:readonly IndustryLoadResourceKind[]=['role','knowledge','skill','mcp','plugin','data-source','execution-tool','work-template','plan','object-type','business-view','business-action','business-configuration']
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
const invalid=()=>new WorkError('teloa/invalid-input','行业模板加载请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','行业模板加载记录损坏，已停止读取。')
/**
 * `scope` 是业务范围标签，要能当任务、计划、群与资料的业务身份用；`domain` 只保留市场行业归类。
 * （`taskDefinition` 限 `[-a-zA-Z0-9_]+`、`resourceScopes` 限 `[a-zA-Z0-9_-]{1,64}`）。
 * 不合规的模板在进入写事务之前就拒绝，免得加载成功却在该范围下寸步难行。
 */
const scopeLabel=(value:string)=>{if(!isBusinessScopeDomain(value))throw new WorkError('teloa/invalid-input','行业模板的业务范围只能是 1–64 位字母、数字、下划线或连字符。')}
const owner=(value:string)=>{if(!text(value,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const stamp=(value:unknown)=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
/**
 * 加载项状态是读取时投影：存储列只记录加载当时的可用性（`pending-adapter`/`skipped`），
 * 真实进展来自各类资源实例表，按本表联合查询后映射，绝不回写存储列。
 * 知识与岗位实例表用 `phase` 记录协调阶段，真正的启用状态在下游资料表与岗位表里，因此联接取真值。
 */
const instanceProjections:readonly {tables:readonly string[];sql:string}[]=[
 {tables:['teloa_industry_data_source_instances'],sql:'select item_instance_id,state from teloa_industry_data_source_instances where owner_id=$1 and item_instance_id=any($2::uuid[])'},
 {tables:['teloa_industry_execution_tool_instances'],sql:'select item_instance_id,state from teloa_industry_execution_tool_instances where owner_id=$1 and item_instance_id=any($2::uuid[])'},
 {tables:['teloa_industry_mcp_instances'],sql:'select item_instance_id,state from teloa_industry_mcp_instances where owner_id=$1 and item_instance_id=any($2::uuid[])'},
 {tables:['teloa_industry_plugin_instances'],sql:'select item_instance_id,state from teloa_industry_plugin_instances where owner_id=$1 and item_instance_id=any($2::uuid[])'},
 {tables:['teloa_industry_knowledge_instances','teloa_resources'],sql:'select k.item_instance_id,coalesce(r.status,k.phase) as state from teloa_industry_knowledge_instances k left join teloa_resources r on r.id=k.resource_id where k.owner_id=$1 and k.item_instance_id=any($2::uuid[])'},
 {tables:['teloa_industry_role_instances','teloa_roles'],sql:'select i.item_instance_id,coalesce(r.state,i.phase) as state from teloa_industry_role_instances i left join teloa_roles r on r.id=i.role_id where i.owner_id=$1 and i.item_instance_id=any($2::uuid[])'},
]
const loadStatuses:readonly IndustryLoadStatus[]=['active','unloaded','superseded']
/** 由 industry-instance-kit 管理状态与修订的四类实例表（定义在卸载协议模块）；这里复核键集确实是资源类型的子集。 */
const detachTableByKind=retireDetachTableByKind satisfies Partial<Record<IndustryLoadResourceKind,string>>
/**
 * 允许标记"沿用"的资源类型：只有存在实例投影的六类（四类 kit 实例 + 知识 + 岗位）才有可沿用的实例。
 * 能力、计划、任务与工作模板没有实例行——能力的使用关系按 (加载,加载项) 绑定，计划随升级一并暂停后须重建——
 * 它们在继任加载上一律是全新的待接入项，标"沿用"会与"请先安装"这类真实状态自相矛盾。
 * 三类业务定制声明（对象类型、业务视图、业务动作）同理：声明没有实例投影，继任加载上一律是全新的待接入项。
 */
const carryKinds:readonly IndustryLoadResourceKind[]=['data-source','execution-tool','mcp','plugin','knowledge','role']
/** 阻塞项回报上限：与客户端 `readUnloadBlockers` 的同一上限对齐，两类阻塞项合并后一并截断；拒绝本身不受截断影响。 */
const blockerLimit=100
const projectStatus=(state:unknown):IndustryLoadItemStatus=>['active','paused','restart-required'].includes(String(state))?'active':['withdrawn','retired','detached'].includes(String(state))?'detached':'instantiated'
/** 版本按 semver 拆成三段数字与预发布标识；构建元数据（`+`）不参与比较。 */
const parseVersion=(value:string)=>{
 const main=value.split('+')[0]!,dash=main.indexOf('-')
 return {core:(dash<0?main:main.slice(0,dash)).split('.').map(part=>Number.parseInt(part,10)),pre:dash<0?[]:main.slice(dash+1).split('.')}
}
/** 预发布标识：两段都是数字按数值比较，数字段低于非数字段，其余按 ASCII。 */
const compareIdentifier=(a:string,b:string)=>{
 const numberA=/^\d+$/.test(a),numberB=/^\d+$/.test(b)
 if(numberA&&numberB)return Number(a)-Number(b)
 if(numberA!==numberB)return numberA?-1:1
 return a<b?-1:a>b?1:0
}
/**
 * 升级只认更高的 semver 版本（§11）：先比三段数字；三段相同时无预发布高于有预发布，
 * 两者都有预发布则逐段比较，前缀相同时段数多的更高。版本完全相同即视为没有更高版本。
 */
const newerVersion=(candidate:string,current:string)=>{
 const next=parseVersion(candidate),now=parseVersion(current)
 for(let index=0;index<3;index++)if(next.core[index]!==now.core[index])return Number(next.core[index])>Number(now.core[index])
 if(!next.pre.length||!now.pre.length)return !next.pre.length&&!!now.pre.length
 for(let index=0;index<Math.max(next.pre.length,now.pre.length);index++){
  const a=next.pre[index],b=now.pre[index]
  if(a===undefined||b===undefined)return b===undefined
  const order=compareIdentifier(a,b)
  if(order!==0)return order>0
 }
 return false
}
const mappingHash=(items:readonly {localId:string;instanceId:string}[])=>createHash('sha256').update(JSON.stringify(items.map(item=>[item.localId,item.instanceId.toLowerCase()]).sort(([a],[b])=>a!<b!?-1:a!>b!?1:0))).digest('hex')

type Input={requestId:string;contentId:string;contentHash:string;target:{kind:'new';spaceId:string;name:string}|{kind:'existing';spaceId:string;expectedVersion:number};spec:Record<string,unknown>}
function input(ownerId:string,value:unknown):Input{
 owner(ownerId);const row=exact(value,['requestId','contentId','contentHash','target']),target=exact(row.target,['kind','spaceId','name','expectedVersion'])
 if(!uuid(row.requestId)||!uuid(row.contentId)||!hash(row.contentHash)||!uuid(target.spaceId))throw invalid()
 let normalized:Input['target']
 if(target.kind==='new'){exact(target,['kind','spaceId','name']);if(!text(target.name,80))throw invalid();normalized={kind:'new',spaceId:target.spaceId.toLowerCase(),name:target.name.trim()}}
 else if(target.kind==='existing'){exact(target,['kind','spaceId','expectedVersion']);if(!positive(target.expectedVersion))throw invalid();normalized={kind:'existing',spaceId:target.spaceId.toLowerCase(),expectedVersion:target.expectedVersion}}
 else throw invalid()
 const contentId=row.contentId.toLowerCase(),spec={contentId,contentHash:row.contentHash,target:normalized}
 return {requestId:row.requestId.toLowerCase(),contentId,contentHash:row.contentHash,target:normalized,spec}
}
type ResolvedIndustryLoadSourceSnapshot=IndustryLoadSourceSnapshot&{scope:string}
function sourceSnapshot(value:unknown):ResolvedIndustryLoadSourceSnapshot{
 const hasScope=isRecord(value)&&Object.hasOwn(value,'scope')
 const row=exact(value,['templateId','templateVersion','title','domain','scope','description','resources','relations','entrypoints'])
 if(!id(row.templateId)||!semver(row.templateVersion)||!text(row.title,120)||!text(row.domain,80)||hasScope&&!text(row.scope,80)||typeof row.description!=='string'||row.description.length>2000||!Array.isArray(row.resources)||!row.resources.length||row.resources.length>500||!Array.isArray(row.relations)||row.relations.length>2000||!Array.isArray(row.entrypoints)||row.entrypoints.length>500)throw corrupt()
 const resources=row.resources.map(value=>{
  const hasSourceNoun=isRecord(value)&&Object.hasOwn(value,'sourceNoun')
  const item=exact(value,['localId','kind','title','version','required','available','modelDependencies',...(hasSourceNoun?['sourceNoun']:[])])
  const invalidNoun=hasSourceNoun&&(
   item.kind!=='data-source'||typeof item.sourceNoun!=='string'||!item.sourceNoun.trim()||
   item.sourceNoun!==item.sourceNoun.trim()||item.sourceNoun.length>12||/[\x00-\x1f\x7f]/.test(item.sourceNoun)
  )
  if(!id(item.localId)||!kinds.includes(item.kind as IndustryLoadResourceKind)||!text(item.title,120)||!semver(item.version)||typeof item.required!=='boolean'||typeof item.available!=='boolean'||invalidNoun)throw corrupt()
  return {localId:item.localId,kind:item.kind as IndustryLoadResourceKind,title:item.title.trim(),version:item.version,required:item.required,available:item.available,...(hasSourceNoun?{sourceNoun:item.sourceNoun as string}:{}),...industryResourceModelDependencies(item.kind,item.modelDependencies)}
 })
 const ids=new Set(resources.map(item=>item.localId));if(ids.size!==resources.length)throw corrupt()
 const relations=row.relations.map(value=>{const link=exact(value,['kind','from','to']);if(!text(link.kind,80)||!id(link.from)||!id(link.to)||!ids.has(link.from)||!ids.has(link.to))throw corrupt();return {kind:link.kind.trim(),from:link.from,to:link.to}})
 const entrypoints=row.entrypoints.map(value=>{if(!id(value)||!ids.has(value))throw corrupt();return value})
 if(new Set(entrypoints).size!==entrypoints.length||resources.some(item=>item.required&&!item.available))throw new WorkError('teloa/source-unavailable','行业模板包含不可用的必需资源。')
 return {templateId:row.templateId,templateVersion:row.templateVersion,title:row.title.trim(),domain:row.domain.trim(),scope:(hasScope?row.scope as string:row.domain).trim(),description:row.description.trim(),resources,relations,entrypoints}
}

export async function initializeIndustryLoads(pool:Pool):Promise<void>{
 // 加载表的外键指向业务空间表；空间表连同 `kind` 列与唯一索引统一由业务空间模块定义，这里先建好再建加载表。
 await initializeBusinessSpaces(pool)
 await pool.query(`
 create table if not exists teloa_industry_loads(id uuid primary key,owner_id text not null,content_id uuid not null,content_hash text not null check(content_hash ~ '^[0-9a-f]{64}$'),template_id text not null,template_version text not null,template_title text not null,domain text not null,scope text not null,description text not null,source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object'),space_id uuid not null,space_version integer not null check(space_version>0),mapping_hash text check(mapping_hash ~ '^[0-9a-f]{64}$'),relations jsonb not null check(jsonb_typeof(relations)='array'),entrypoints jsonb not null check(jsonb_typeof(entrypoints)='array'),created_at timestamptz not null,unique(owner_id,space_id,content_hash),foreign key(space_id,owner_id) references teloa_business_spaces(id,owner_id));
 alter table teloa_industry_loads add column if not exists scope text;
 update teloa_industry_loads set scope=domain where scope is null;
 alter table teloa_industry_loads alter column scope set not null;
 alter table teloa_industry_loads add column if not exists mapping_hash text check(mapping_hash ~ '^[0-9a-f]{64}$');
 create table if not exists teloa_industry_load_items(load_id uuid not null references teloa_industry_loads(id),local_id text not null,instance_id uuid not null unique,kind text not null,title text not null,version text not null,required boolean not null,status text not null check(status in ('pending-adapter','skipped')),primary key(load_id,local_id));
 create table if not exists teloa_industry_load_requests(owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),load_id uuid not null references teloa_industry_loads(id),primary key(owner_id,request_id));
 alter table teloa_industry_loads add column if not exists status text not null default 'active';
 alter table teloa_industry_loads add column if not exists unloaded_at timestamptz;
 alter table teloa_industry_loads drop constraint if exists teloa_industry_loads_status_check;
 alter table teloa_industry_loads add constraint teloa_industry_loads_status_check check(status in ('active','unloaded','superseded'));
 create table if not exists teloa_industry_load_unload_requests(owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),load_id uuid not null references teloa_industry_loads(id),primary key(owner_id,request_id));
 alter table teloa_industry_loads add column if not exists supersedes uuid references teloa_industry_loads(id);
 alter table teloa_industry_load_items add column if not exists carried_from uuid;
 create table if not exists teloa_industry_load_upgrade_requests(owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),load_id uuid not null references teloa_industry_loads(id),successor_load_id uuid not null references teloa_industry_loads(id),primary key(owner_id,request_id));
 create table if not exists teloa_industry_upgrade_plans(owner_id text not null,load_id uuid not null references teloa_industry_loads(id),successor_load_id uuid not null references teloa_industry_loads(id),choices jsonb not null check(jsonb_typeof(choices)='object'),diff_digest text not null check(diff_digest ~ '^[0-9a-f]{64}$'),created_at timestamptz not null,primary key(owner_id,successor_load_id));
 `)}


export class IndustryLoadService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly source:IndustryLoadSource
 /** 只有卸载需要持续计划服务；其余读写路径不用，因此保持可选，未接入时卸载仍在生效的计划会显式失败。 */
 readonly plans:IndustryLoadPlanPort|undefined
 /** 只有升级里的 `use-template` 需要岗位服务；未接入时带该选择的升级显式失败，其余路径不受影响。 */
 readonly roles:IndustryLoadRolePort|undefined
 /** 目标锁定按版本判定；缺省读环境配置。显式注入只为让测试同时覆盖两条分支，不必改环境变量。 */
 readonly edition:IndustryLoadEdition
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},source:IndustryLoadSource,plans?:IndustryLoadPlanPort,roles?:IndustryLoadRolePort,edition:IndustryLoadEdition=readEdition()){this.pool=pool;this.identity=identity;this.source=source;this.plans=plans;this.roles=roles;this.edition=edition}
 /**
  * 个人版的加载目标锁定（规格 §3.3）：只能加载到本人空间，不能顺手开新空间。
  *
  * 判据以「本人空间已引导」为前提：本人空间是这条规则要锁定的那个目标，还没有它时任何目标都无从比较，
  * 不加这个前提会让尚未引导的装配连 `kind:'existing'` 都无法通过，服务整体不可用。
  * 真实宿主装配在服务对外之前就调过 `ensurePersonal`，因此锁定在真实路径上始终生效。
  */
 private async assertTarget(ownerId:string,target:Input['target']):Promise<void>{
  if(this.edition!=='personal')return
  const personal=(await this.pool.query("select id from teloa_business_spaces where owner_id=$1 and kind='personal'",[ownerId])).rows[0]
  // 前提由宿主装配保证：`BusinessSpaceService.ensurePersonal` 在服务对外之前跑过一次。
  // 真落到这里说明装配顺序出了问题，锁定无从比较——不静默放行，先把它记出来。
  if(!personal){console.warn('[teloa] 个人版加载目标锁定未生效：本人工作空间尚未引导，请确认装配时已调用 ensurePersonal。');return}
  if(target.kind==='new')throw new WorkError('teloa/forbidden','个人版只有一个工作空间，新建空间是专业版 / 企业版功能。')
  if(target.spaceId!==String(personal.id).toLowerCase())throw new WorkError('teloa/forbidden','个人版只能加载到本人工作空间。')
 }
 private async read(db:PoolClient,ownerId:string,loadId:string):Promise<IndustryLoadRecord>{
  const row=(await db.query('select l.*,s.name as space_name,s.version as current_space_version,old.template_version as superseded_version from teloa_industry_loads l join teloa_business_spaces s on s.id=l.space_id and s.owner_id=l.owner_id left join teloa_industry_loads old on old.id=l.supersedes and old.owner_id=l.owner_id where l.id=$1',[loadId])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','行业模板加载记录不存在或不属于当前本人。')
  if(row.owner_id!==ownerId)throw new WorkError('teloa/forbidden','行业模板加载记录不存在或不属于当前本人。')
  const itemRows=(await db.query('select * from teloa_industry_load_items where load_id=$1 order by local_id',[loadId])).rows
  const planRow=(await db.query('select choices,diff_digest,created_at from teloa_industry_upgrade_plans where owner_id=$1 and successor_load_id=$2',[ownerId,loadId])).rows[0]
  // 沿用项的实例挂在被替代的加载上，因此按实例身份（全表唯一）而不是按加载查询，两类身份一次取齐。
  const instanceStates=await this.instanceStates(db,ownerId,itemRows.flatMap(item=>[item.instance_id,item.carried_from]).filter((value):value is string=>uuid(value)))
  try{
   const snapshot=sourceSnapshot(row.source_snapshot)
   if(!loadStatuses.includes(row.status)||(row.status==='unloaded')!==(row.unloaded_at!==null))throw Error()
   // 继任血缘三件事同生共死：`supersedes` 指向的旧加载、它的模板版本与那次升级的计划，缺一即视为记录损坏。
   const superseded=row.supersedes===null?undefined:row.supersedes
   if((superseded!==undefined)!==!!planRow||(superseded!==undefined)!==(row.superseded_version!==null))throw Error()
   if(superseded!==undefined&&(!uuid(superseded)||!semver(row.superseded_version)||!hash(planRow.diff_digest)))throw Error()
   const upgrade:IndustryLoadUpgrade|undefined=superseded===undefined?undefined:{loadId:superseded,templateVersion:row.superseded_version,choices:readIndustryUpdateChoices(planRow.choices),diffDigest:planRow.diff_digest,createdAt:stamp(planRow.created_at)}
   if(!uuid(row.id)||!uuid(row.content_id)||!hash(row.content_hash)||row.template_id!==snapshot.templateId||row.template_version!==snapshot.templateVersion||row.template_title!==snapshot.title||row.domain!==snapshot.domain||row.scope!==snapshot.scope||row.description!==snapshot.description||!uuid(row.space_id)||!positive(row.space_version)||!positive(row.current_space_version)||row.current_space_version<row.space_version||!text(row.space_name,80)||!Array.isArray(row.relations)||!Array.isArray(row.entrypoints))throw Error()
   const items:IndustryLoadItem[]=itemRows.map(item=>{if(!id(item.local_id)||!uuid(item.instance_id)||!kinds.includes(item.kind)||!text(item.title,120)||!semver(item.version)||typeof item.required!=='boolean'||!['pending-adapter','skipped'].includes(item.status)||item.required&&item.status==='skipped')throw Error();if(item.carried_from!==null&&(superseded===undefined||!uuid(item.carried_from)))throw Error();return {localId:item.local_id,instanceId:item.instance_id,kind:item.kind,title:item.title,version:item.version,required:item.required,status:item.status,...(item.carried_from===null?{}:{carriedFrom:item.carried_from})}})
   const carried=items.flatMap(item=>item.carriedFrom?[item.carriedFrom]:[]);if(new Set(carried).size!==carried.length)throw Error()
   const byLocal=new Map(items.map(item=>[item.localId,item])),byInstance=new Set(items.map(item=>item.instanceId));if(byLocal.size!==items.length||byInstance.size!==items.length||items.length!==snapshot.resources.length||row.mapping_hash!==mappingHash(items))throw Error()
   for(const expected of snapshot.resources){const actual=byLocal.get(expected.localId);if(!actual||actual.kind!==expected.kind||actual.title!==expected.title||actual.version!==expected.version||actual.required!==expected.required||actual.status!==(expected.available?'pending-adapter':'skipped'))throw Error()}
   const relations=row.relations.map((value:unknown)=>{const link=exact(value,['kind','from','to']);if(!text(link.kind,80)||!uuid(link.from)||!uuid(link.to)||!byInstance.has(link.from)||!byInstance.has(link.to))throw Error();return {kind:link.kind,from:link.from,to:link.to}})
   const entrypoints=row.entrypoints.map((value:unknown)=>{if(!uuid(value)||!byInstance.has(value))throw Error();return value})
   const expectedRelations=snapshot.relations.map(link=>({kind:link.kind,from:byLocal.get(link.from)!.instanceId,to:byLocal.get(link.to)!.instanceId})),expectedEntrypoints=snapshot.entrypoints.map(local=>byLocal.get(local)!.instanceId)
   if(!same(relations,expectedRelations)||!same(entrypoints,expectedEntrypoints))throw Error()
   // 沿用项自己没有实例，状态取来源实例的真实状态——这才是「沿用 vN 实例」在目录上看得见的含义。
   const projected=items.map(item=>{const state=instanceStates.get(item.instanceId.toLowerCase())??(item.carriedFrom?instanceStates.get(item.carriedFrom.toLowerCase()):undefined);return state?{...item,status:state}:item})
   return {id:row.id,ownerId:row.owner_id,contentId:row.content_id,contentHash:row.content_hash,templateId:row.template_id,templateVersion:row.template_version,templateTitle:row.template_title,domain:row.domain,scope:row.scope,description:row.description,targetVersion:row.space_version,space:{id:row.space_id,name:row.space_name,version:row.current_space_version,scope:row.scope},items:projected.map(item=>({...item,...industryResourceModelDependencies(item.kind,snapshot.resources.find(resource=>resource.localId===item.localId)?.modelDependencies)})),relations,entrypoints,createdAt:stamp(row.created_at),mappingHash:row.mapping_hash as string,status:row.status as IndustryLoadStatus,...(row.unloaded_at===null?{}:{unloadedAt:stamp(row.unloaded_at)}),...(upgrade?{upgrade}:{})}
  }catch(error){if(error instanceof WorkError&&error.code==='teloa/forbidden')throw error;throw corrupt()}
 }
 /** 只读地汇总给定加载项身份在六张资源实例表中的真实状态；缺表的实例种类直接跳过。 */
 private async instanceStates(db:PoolClient,ownerId:string,itemInstanceIds:readonly string[]):Promise<Map<string,IndustryLoadItemStatus>>{
  const states=new Map<string,IndustryLoadItemStatus>()
  if(!itemInstanceIds.length)return states
  const names=[...new Set(instanceProjections.flatMap(row=>row.tables))]
  const present=new Set((await db.query('select name from unnest($1::text[]) as name where to_regclass(name) is not null',[names])).rows.map(row=>row.name as string))
  const parts=instanceProjections.filter(row=>row.tables.every(table=>present.has(table))).map(row=>row.sql)
  if(!parts.length)return states
  for(const row of (await db.query(parts.join(' union all '),[ownerId,[...itemInstanceIds]])).rows){if(!uuid(row.item_instance_id))throw corrupt();states.set(row.item_instance_id.toLowerCase(),projectStatus(row.state))}
  return states
 }
 /** 读取加载项在存储列上的原始状态；实例化前置检查与固定来源核验都以它为准，不受投影影响。 */
 async storedItemStatus(db:Pool|PoolClient,ownerId:string,itemInstanceId:string):Promise<IndustryLoadStoredStatus>{
  owner(ownerId);if(!uuid(itemInstanceId))throw invalid()
  const row=(await db.query('select i.status from teloa_industry_load_items i join teloa_industry_loads l on l.id=i.load_id where i.instance_id=$1 and l.owner_id=$2',[itemInstanceId.toLowerCase(),ownerId])).rows[0]
  if(!row||!['pending-adapter','skipped'].includes(row.status))throw corrupt()
  return row.status as IndustryLoadStoredStatus
 }
 async create(ownerId:string,value:unknown):Promise<IndustryLoadRecord>{
  const data=input(ownerId,value)
  const initialReceipt=(await this.pool.query('select *,request_spec=$3::jsonb as same_request from teloa_industry_load_requests where owner_id=$1 and request_id=$2',[ownerId,data.requestId,JSON.stringify(data.spec)])).rows[0]
  if(initialReceipt){
   if(!initialReceipt.same_request)throw new WorkError('teloa/conflict','同一加载请求不能更换来源或目标。')
   const db=await this.pool.connect()
   try{await db.query('begin isolation level repeatable read read only');let result:IndustryLoadRecord;try{result=await this.read(db,ownerId,initialReceipt.load_id)}catch{throw corrupt()}if(result.contentId!==data.contentId||result.contentHash!==data.contentHash||result.space.id!==data.target.spaceId)throw corrupt();await db.query('commit');return result}catch(error){await db.query('rollback');throw error}finally{db.release()}
  }
  await this.assertTarget(ownerId,data.target)
  const snapshot=sourceSnapshot(await this.source.read(ownerId,data.contentId,data.contentHash));scopeLabel(snapshot.scope)
  const now=this.identity.now();if(!Number.isFinite(Date.parse(now)))throw invalid()
  const db=await this.pool.connect()
  try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['industry-load-request',ownerId,data.requestId])])
   const receipt=(await db.query('select *,request_spec=$3::jsonb as same_request from teloa_industry_load_requests where owner_id=$1 and request_id=$2',[ownerId,data.requestId,JSON.stringify(data.spec)])).rows[0]
   if(receipt){
    if(!receipt.same_request)throw new WorkError('teloa/conflict','同一加载请求不能更换来源或目标。')
    let result:IndustryLoadRecord
    try{result=await this.read(db,ownerId,receipt.load_id)}catch{throw corrupt()}
    if(result.contentId!==data.contentId||result.contentHash!==data.contentHash||result.space.id!==data.target.spaceId)throw corrupt()
    await db.query('commit');return result
   }
   const loadId=await this.insert(db,ownerId,data,snapshot,now,{duplicate:'reuse'})
   await db.query('insert into teloa_industry_load_requests values($1,$2,$3,$4)',[ownerId,data.requestId,JSON.stringify(data.spec),loadId])
   const result=await this.read(db,ownerId,loadId);await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 配置锁必须早于加载行、空间咨询锁与空间行锁；同事务重复取得为可重入。 */
 private async lockConfiguration(db:PoolClient,ownerId:string,scope:string):Promise<void>{
  await lockBusinessConfiguration(db,ownerId,scope)
  await new BusinessConfigurationStore(this.pool).assertStandaloneMutationAllowed(db,ownerId,scope)
 }
 /**
  * 加载写入段：锁住业务空间、登记空间、加载行与加载项，返回加载身份。`create` 与 `upgrade` 共用；
  * 调用方须已在写事务内并已完成回执复放，回执由调用方按各自的回执表写。
  * 同空间同内容摘要已有加载时，`reuse` 直接复用（原加载语义），`reject` 拒绝（升级不能把已在场的版本当作继任）。
  */
 private async insert(db:PoolClient,ownerId:string,data:Pick<Input,'contentId'|'contentHash'|'target'>,snapshot:ResolvedIndustryLoadSourceSnapshot,now:string,options:{duplicate:'reuse'|'reject';supersedes?:string;carriedFrom?:ReadonlyMap<string,string>}):Promise<string>{
  await this.lockConfiguration(db,ownerId,snapshot.scope)
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['industry-load-space',ownerId,data.target.spaceId])])
  let space=(await db.query('select * from teloa_business_spaces where id=$1 and owner_id=$2 for update',[data.target.spaceId,ownerId])).rows[0]
  const newName=data.target.kind==='new'?data.target.name:null
  if(data.target.kind==='new'){
   if(space&&space.name!==data.target.name)throw new WorkError('teloa/conflict','业务空间身份已用于其他名称。')
  }else if(!space)throw new WorkError('teloa/forbidden','目标业务空间不存在或不属于当前本人。')
  else if(space.version!==data.target.expectedVersion)throw new WorkError('teloa/version-conflict','目标业务空间版本已变化。')
  const duplicate=space&&(await db.query('select id,status from teloa_industry_loads where owner_id=$1 and space_id=$2 and content_hash=$3',[ownerId,data.target.spaceId,data.contentHash])).rows[0]
  if(duplicate){
   // 同一内容在同一空间只有一条加载行（唯一约束）。已卸载或已被替代的那条不能复活：
   // 复用它会让"新加载"既不在目录里、又拒绝一切实例写入，因此两条重复路径都直接拒绝。
   if(duplicate.status!=='active')throw new WorkError('teloa/conflict','同一内容已在此业务空间加载过，并已卸载或被升级替代，不能再次加载。')
   if(options.duplicate==='reject')throw new WorkError('teloa/conflict','候选版本已加载到该业务空间，不能再作为继任加载。')
   return duplicate.id as string
  }
  if(space&&data.target.kind==='new')throw new WorkError('teloa/conflict','业务空间已存在；加载其他版本须按当前空间版本提交。')
  if(!space)space=(await db.query('insert into teloa_business_spaces(id,owner_id,name,description,version,created_at,updated_at) values($1,$2,$3,$4,1,$5,$5) returning *',[data.target.spaceId,ownerId,newName!,snapshot.description,now])).rows[0]
  else if(data.target.kind==='existing')space=(await db.query('update teloa_business_spaces set version=version+1,updated_at=$3 where id=$1 and owner_id=$2 returning *',[space.id,ownerId,now])).rows[0]
  // 加载成功即把模板 `scope` 登记为业务范围标签（规格 §3.3）：与加载行同一事务，加载写不成标签也不会留下。
  // 标题优先用模板标题，超过标签上限就退回 `scope` 本身。同一 `scope` 重复加载时登记幂等，不改已有标题与来源。
  await BusinessScopeService.ensure(db,ownerId,{scope:snapshot.scope,title:snapshot.title.length<=80?snapshot.title:snapshot.scope,kind:'domain',spaceId:space.id})
  const loadId=this.identity.id();if(!uuid(loadId))throw invalid()
  const mapping=new Map(snapshot.resources.map(item=>[item.localId,this.identity.id()]));if([...mapping.values()].some(value=>!uuid(value)))throw invalid()
  const relations=snapshot.relations.map(link=>({kind:link.kind,from:mapping.get(link.from)!,to:mapping.get(link.to)!})),entrypoints=snapshot.entrypoints.map(local=>mapping.get(local)!)
  const digest=mappingHash([...mapping].map(([localId,instanceId])=>({localId,instanceId})))
  await db.query('insert into teloa_industry_loads(id,owner_id,content_id,content_hash,template_id,template_version,template_title,domain,scope,description,source_snapshot,space_id,space_version,mapping_hash,relations,entrypoints,created_at,supersedes) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)',[loadId,ownerId,data.contentId,data.contentHash,snapshot.templateId,snapshot.templateVersion,snapshot.title,snapshot.domain,snapshot.scope,snapshot.description,JSON.stringify(snapshot),space.id,space.version,digest,JSON.stringify(relations),JSON.stringify(entrypoints),now,options.supersedes??null])
  for(const item of snapshot.resources)await db.query('insert into teloa_industry_load_items(load_id,local_id,instance_id,kind,title,version,required,status,carried_from) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[loadId,item.localId,mapping.get(item.localId),item.kind,item.title,item.version,item.required,item.available?'pending-adapter':'skipped',options.carriedFrom?.get(item.localId)??null])
  return loadId
 }
 async get(ownerId:string,value:unknown):Promise<IndustryLoadRecord>{owner(ownerId);const row=exact(value,['loadId']);if(!uuid(row.loadId))throw invalid();const db=await this.pool.connect();try{await db.query('begin isolation level repeatable read read only');const result=await this.read(db,ownerId,row.loadId);await db.query('commit');return result}catch(error){await db.query('rollback');throw error}finally{db.release()}}
 async getInTransaction(db:PoolClient,ownerId:string,value:unknown):Promise<IndustryLoadRecord>{owner(ownerId);const row=exact(value,['loadId']);if(!uuid(row.loadId))throw invalid();return this.read(db,ownerId,row.loadId)}
 /** 目录默认只列出仍在生效的加载；已卸载与已被升级替代的加载要显式索取，`get` 则始终可读以便追溯。 */
 async list(ownerId:string,value:unknown):Promise<IndustryLoadPage>{
  // 入参先过一遍再去拿连接：非法请求不该占用连接池里的一个连接，也不该开一个随即回滚的事务（复审 T3 LOW-1）。
  // `listRows` 里那一遍照旧保留——它也被 `listInTransaction` 直接调用，校验不能只留在这一条入口上。
  owner(ownerId);const pre=exact(value,['includeUnloaded']);if(pre.includeUnloaded!==undefined&&typeof pre.includeUnloaded!=='boolean')throw invalid()
  const db=await this.pool.connect()
  try{await db.query('begin isolation level repeatable read read only');const result=await this.listRows(db,ownerId,value);await db.query('commit');return result}catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /**
  * `list()` 的同一事务变体：业务定制层的 `BusinessDefinitionSourceReader.forScope`（`business-definition-source.ts`）
  * 要在同一个只读可重复读事务里既确定"哪些加载参与本次台账"、又读每份加载的声明与快照行——分两次快照，
  * 加载列表与随后算出的视图结果可能互相矛盾（例如列表里还在但读的瞬间已被卸载）。
  */
 async listInTransaction(db:PoolClient,ownerId:string,value:unknown):Promise<IndustryLoadPage>{return this.listRows(db,ownerId,value)}
 private async listRows(db:PoolClient,ownerId:string,value:unknown):Promise<IndustryLoadPage>{
  owner(ownerId);const row=exact(value,['includeUnloaded']);if(row.includeUnloaded!==undefined&&typeof row.includeUnloaded!=='boolean')throw invalid()
  const includeUnloaded=row.includeUnloaded===true
  const rows=(await db.query("select id from teloa_industry_loads where owner_id=$1 and ($2::boolean or status='active') order by created_at,id",[ownerId,includeUnloaded])).rows,items=[]
  for(const row of rows)items.push(await this.read(db,ownerId,row.id))
  return {items}
 }
 /** 缺表即视为该类下游尚未接入：卸载不因未初始化的表而失败，也不会遗漏已存在表上的解除。 */
 private async present(db:PoolClient,names:readonly string[]):Promise<Set<string>>{return presentTables(db,names)}
 /**
  * 卸载前置阻断：该加载的计划还有领取后未结束的日程，或还有 `prepared`/`submitting` 的运行引用该加载的 Skill。
  * 两个查询都在锁住加载行的同一事务内执行，非空即整笔拒绝，任何写都不发生。
  * 两条判据都按 `load_id` 成立：计划与 Skill 使用关系都不沿用（计划随升级暂停后须重建，Skill 在继任加载上重新安装），
  * 因此继任加载的在途事实全部记在它自己名下，不必回溯被替代的加载。
  * 每条判据的缺表门槛就是它自己联接的全部表：少一张表这条判据无从成立，跳过它不会漏判其余判据。
  */
 private async blockers(db:PoolClient,ownerId:string,loadId:string,present:Set<string>):Promise<IndustryLoadUnloadBlocker[]>{
  const found:IndustryLoadUnloadBlocker[]=[]
  if(['teloa_plan_occurrences','teloa_plans','teloa_industry_plan_sources','teloa_tasks'].every(name=>present.has(name))){
   const rows=(await db.query(`select o.id from teloa_plan_occurrences o
    join teloa_plans p on p.id=o.plan_id and p.owner_id=o.owner_id
    join teloa_industry_plan_sources s on s.plan_id=p.id and s.owner_id=p.owner_id
    left join teloa_tasks t on t.owner_id=o.owner_id and t.request_id=o.task_request_id
    where o.owner_id=$1 and s.source_snapshot->>'loadId'=$2 and (
     (t.id is not null and t.state not in ('completed','cancelled')) or
     (t.id is null and p.state='active' and o.plan_version=p.version and o.config_version=p.config_version)
    ) order by o.id limit ${blockerLimit}`,[ownerId,loadId])).rows
   for(const row of rows){if(!uuid(row.id))throw corrupt();found.push({kind:'plan-occurrence',id:row.id})}
  }
  if(['teloa_task_runs','teloa_task_run_skill_refs','teloa_skill_install_usages'].every(name=>present.has(name))){
   const rows=(await db.query(`select distinct r.id from teloa_task_runs r
    join teloa_task_run_skill_refs f on f.run_id=r.id and f.owner_id=r.owner_id
    join teloa_skill_install_usages u on u.owner_id=r.owner_id and u.installation_id=f.installation_id
    where r.owner_id=$1 and u.load_id=$2 and r.state in ('prepared','submitting') order by r.id limit ${blockerLimit}`,[ownerId,loadId])).rows
   for(const row of rows){if(!uuid(row.id))throw corrupt();found.push({kind:'task-run',id:row.id})}
  }
  return found.slice(0,blockerLimit)
 }
 /**
  * 暂停该加载创建且仍在生效的计划：原因记在计划变更台账，计划与其历史仍完整属于本人。
  * 缺表门槛同样只列本查询联接的两张表——它与阻塞检查是两笔独立判据，互不依赖对方的表是否存在。
  */
 private async pausePlans(db:PoolClient,ownerId:string,loadId:string,present:Set<string>,note:string,dependency:string):Promise<void>{
  return pauseLoadPlans(db,ownerId,loadId,present,{note,dependency,plans:this.plans,identity:this.identity})
 }
 /**
  * 本加载沿用来的持有实例：继任加载上的沿用项自己没有实例行，实例仍挂在被替代（或更早）的加载上，
  * 因此按 `load_id` 一行都找不到。卸载继任加载要连它们一起解除，否则升级过的模板卸载后仍留着一批可写实例。
  * 只取四类 kit 实例：知识与岗位的沿用项同样不改下游对象状态，与卸载"本地对象一律保留"的取舍一致。
  */
 private async carriedHolders(db:PoolClient,loadId:string):Promise<{table:string;itemInstanceId:string}[]>{return carriedInstanceHolders(db,loadId)}
 /**
  * 卸载已加载模板：先按 (本人,请求) 复放回执，再在同一事务里 `for update` 锁住加载行核对状态、映射与阻塞项；
  * 通过后一次性解除四类实例（含沿用来的持有实例）、删除该加载的 Skill 使用关系、暂停该加载创建的计划，
  * 最后落卸载状态与回执。岗位、知识与任务不改状态：模板只失去活跃血缘，本地对象一律保留。
  * 任一核对不通过都不落任何写。
  */
 async unload(ownerId:string,value:unknown):Promise<IndustryLoadRecord>{
  owner(ownerId);const row=exact(value,['requestId','loadId','expectedMappingHash'])
  if(!uuid(row.requestId)||!uuid(row.loadId)||!hash(row.expectedMappingHash))throw invalid()
  const requestId=row.requestId.toLowerCase(),loadId=row.loadId.toLowerCase(),spec={loadId,expectedMappingHash:row.expectedMappingHash}
  const query='select *,request_spec=$3::jsonb as same_request from teloa_industry_load_unload_requests where owner_id=$1 and request_id=$2'
  const replay=async(db:PoolClient,receipt:Record<string,unknown>):Promise<IndustryLoadRecord>=>{
   if(!receipt.same_request)throw new WorkError('teloa/conflict','同一卸载请求不能更换目标加载或映射指纹。')
   let result:IndustryLoadRecord;try{result=await this.read(db,ownerId,receipt.load_id as string)}catch{throw corrupt()}
   if(result.id.toLowerCase()!==loadId||result.status!=='unloaded')throw corrupt()
   return result
  }
  const initial=(await this.pool.query(query,[ownerId,requestId,JSON.stringify(spec)])).rows[0]
  if(initial){
   const db=await this.pool.connect()
   try{await db.query('begin isolation level repeatable read read only');const result=await replay(db,initial);await db.query('commit');return result}catch(error){await db.query('rollback');throw error}finally{db.release()}
  }
  const now=this.identity.now();if(!Number.isFinite(Date.parse(now)))throw invalid()
  const db=await this.pool.connect()
  try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['industry-load-unload-request',ownerId,requestId])])
   const receipt=(await db.query(query,[ownerId,requestId,JSON.stringify(spec)])).rows[0]
   if(receipt){const result=await replay(db,receipt);await db.query('commit');return result}
   const initialScope=(await db.query('select scope from teloa_industry_loads where id=$1 and owner_id=$2',[loadId,ownerId])).rows[0]?.scope
   if(typeof initialScope!=='string')throw new WorkError('teloa/forbidden','行业模板加载记录不存在或不属于当前本人。')
   await this.lockConfiguration(db,ownerId,initialScope)
   const locked=(await db.query('select owner_id,status,mapping_hash from teloa_industry_loads where id=$1 for update',[loadId])).rows[0]
   if(!locked||locked.owner_id!==ownerId)throw new WorkError('teloa/forbidden','行业模板加载记录不存在或不属于当前本人。')
   if(locked.status!=='active')throw new WorkError('teloa/conflict','行业模板加载已卸载或已被升级替代。')
   if(locked.mapping_hash!==spec.expectedMappingHash)throw new WorkError('teloa/version-conflict','行业模板加载的资源映射已变化，请重新核对。')
   const present=await this.present(db,[...detachTables,'teloa_skill_install_usages','teloa_plan_occurrences','teloa_plans','teloa_industry_plan_sources','teloa_tasks','teloa_task_runs','teloa_task_run_skill_refs'])
   const blocked=await this.blockers(db,ownerId,loadId,present)
   if(blocked.length)throw new WorkError('teloa/conflict','存在进行中的计划执行或运行，暂不能卸载。',{blockers:blocked})
   await retireIndustryLoadInTransaction(db,ownerId,loadId,now,{present,plans:this.plans,identity:this.identity,note:'模板已卸载',dependency:'持续计划服务尚未接入，不能卸载仍在生效的行业计划。'})
   await db.query("update teloa_industry_loads set status='unloaded',unloaded_at=$3 where id=$1 and owner_id=$2",[loadId,ownerId,now])
   await db.query('insert into teloa_industry_load_unload_requests values($1,$2,$3,$4)',[ownerId,requestId,JSON.stringify(spec),loadId])
   const result=await this.read(db,ownerId,loadId);await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /**
  * 升级到候选版本：固定一份升级计划、建立继任加载，并在同一笔写里按选择应用。
  * 差异用 contract 的比较核按两份固定内容重算（与客户端同一函数），`choices` 必须逐项覆盖发生变化的资源；
  * 通过后旧加载转 `superseded`，继任加载 `supersedes` 指回旧加载，沿用项记 `carried_from`=旧实例身份。
  * 应用：`detach` 解除旧加载上该项的 kit 实例；`use-template` 重放岗位模板字段；
  * `candidate`/新增资源留作继任加载上的待接入项，由既有各类 `instantiate` 建立新实例；`skip` 与 `keep` 不写。
  */
 async upgrade(ownerId:string,value:unknown):Promise<{superseded:IndustryLoadRecord;successor:IndustryLoadRecord}>{
  owner(ownerId);const row=exact(value,['requestId','loadId','candidateContentId','choices','expectedMappingHash'])
  if(!uuid(row.requestId)||!uuid(row.loadId)||!uuid(row.candidateContentId)||!hash(row.expectedMappingHash))throw invalid()
  let choices:IndustryUpdateChoices
  try{choices=readIndustryUpdateChoices(row.choices)}catch{throw invalid()}
  const requestId=row.requestId.toLowerCase(),loadId=row.loadId.toLowerCase(),candidateContentId=row.candidateContentId.toLowerCase()
  const spec={loadId,candidateContentId,expectedMappingHash:row.expectedMappingHash,choices}
  const query='select *,request_spec=$3::jsonb as same_request from teloa_industry_load_upgrade_requests where owner_id=$1 and request_id=$2'
  const replay=async(db:PoolClient,receipt:Record<string,unknown>):Promise<{superseded:IndustryLoadRecord;successor:IndustryLoadRecord}>=>{
   if(!receipt.same_request)throw new WorkError('teloa/conflict','同一升级请求不能更换目标加载、候选内容或处理方式。')
   let superseded:IndustryLoadRecord,successor:IndustryLoadRecord
   try{superseded=await this.read(db,ownerId,receipt.load_id as string);successor=await this.read(db,ownerId,receipt.successor_load_id as string)}catch{throw corrupt()}
   if(superseded.id.toLowerCase()!==loadId||superseded.status!=='superseded'||successor.upgrade?.loadId.toLowerCase()!==loadId)throw corrupt()
   return {superseded,successor}
  }
  const initial=(await this.pool.query(query,[ownerId,requestId,JSON.stringify(spec)])).rows[0]
  if(initial){
   const db=await this.pool.connect()
   try{await db.query('begin isolation level repeatable read read only');const result=await replay(db,initial);await db.query('commit');return result}catch(error){await db.query('rollback');throw error}finally{db.release()}
  }
  if(!this.source.content)throw new WorkError('teloa/dependency-unavailable','行业模板内容读取尚未接入，不能比较升级差异。')
  // 事务外：读旧加载与两份固定内容，重算差异并核对选择；任何一步不通过都不进入写事务。
  const current=await this.get(ownerId,{loadId})
  if(current.status!=='active')throw new WorkError('teloa/conflict','行业模板加载已卸载或已被升级替代。')
  if(current.mappingHash!==spec.expectedMappingHash)throw new WorkError('teloa/version-conflict','行业模板加载的资源映射已变化，请重新核对。')
  const baseline=await this.source.content(ownerId,current.contentId)
  if(baseline.hash!==current.contentHash)throw new WorkError('teloa/source-unavailable','行业模板固定来源不一致，请重新核对。')
  const candidate=await this.source.content(ownerId,candidateContentId)
  if(candidate.templateId!==current.templateId||candidate.domain!==current.domain||candidate.scope!==current.scope||!newerVersion(candidate.templateVersion,current.templateVersion))throw new WorkError('teloa/invalid-input','候选内容必须是同一行业模板的更高版本。')
  const diff=compareIndustryUpdateCore(baseline,candidate)
  if(diff.kindChanges.length)throw new WorkError('teloa/invalid-input','同一资源标识的类型发生变化，需换用新资源标识单独迁移。')
  const problem=industryUpdateChoiceProblem(diff,choices)
  if(problem)throw new WorkError('teloa/invalid-input',problem)
  const roleInstances=new Set(current.items.filter(item=>item.kind==='role').map(item=>item.instanceId.toLowerCase()))
  for(const key of Object.keys(choices.roles))if(!roleInstances.has(key.toLowerCase()))throw new WorkError('teloa/invalid-input','员工处理方式指向的员工不属于本次加载。')
  const snapshot=sourceSnapshot(await this.source.read(ownerId,candidateContentId,candidate.hash));scopeLabel(snapshot.scope)
  if(snapshot.scope!==current.scope||snapshot.domain!==candidate.domain||snapshot.templateId!==candidate.templateId||snapshot.templateVersion!==candidate.templateVersion)throw new WorkError('teloa/source-unavailable','升级固定来源与候选身份或业务范围不一致。')
  const digest=createHash('sha256').update(industryUpdateCanonical(diff)).digest('hex')
  // 未列出选择的资源一律未变化，默认沿用旧实例；`candidate`/`skip`/`detach` 与新增资源都不带沿用来源。
  // 只有有实例投影的六类才标沿用（`carryKinds`），其余类型在继任加载上是全新的待接入项。
  // 沿用来源恒指向**真正持有实例**的那一项：旧项自己也是沿用项时要继续往上指，否则链式升级第二跳就落空
  // （v1.1 的沿用项自身没有实例行，v1.2 指向它会让投影取不到状态、kit 的防重判据也失效）。
  const carriedFrom=new Map(snapshot.resources.flatMap(item=>{
   const old=carryKinds.includes(item.kind)?current.items.find(row=>row.localId===item.localId):undefined
   return old&&(choices.resources[item.localId]??'keep')==='keep'?[[item.localId,old.carriedFrom??old.instanceId] as [string,string]]:[]
  }))
  // `detach` 只可能落在被移除的资源上（取值表已保证）。四类 kit 实例按类型定位到唯一一张表；
  // 知识、岗位、能力、计划与任务不改状态，只是随旧加载一起失去活跃血缘——与卸载的取舍一致。
  // 解除的是**持有实例的那一项**：本次加载自己就是继任加载时，被移除项的实例还挂在更早的加载上。
  const detachTargets=Object.entries(choices.resources).flatMap(([localId,choice])=>{
   const item=choice==='detach'?current.items.find(row=>row.localId===localId):undefined
   const table=item&&item.kind in detachTableByKind?detachTableByKind[item.kind as keyof typeof detachTableByKind]:undefined
   return item&&table?[{table,itemInstanceId:item.carriedFrom??item.instanceId}]:[]
  })
  // `use-template` 的岗位按候选内容里的同一资源标识重放模板字段；候选里没有这个岗位就无从重放。
  const roleTargets=Object.entries(choices.roles).flatMap(([key,choice])=>{
   if(choice!=='use-template')return []
   const item=current.items.find(row=>row.instanceId.toLowerCase()===key.toLowerCase())!
   const resource=candidate.manifest.resources.find(row=>row.id===item.localId)
   if(!resource||resource.kind!=='role'||resource.source.kind!=='local')throw new WorkError('teloa/invalid-input','采用模板定义的员工在候选模板中已移除或不再是包内定义。')
   return [{loadId,itemInstanceId:item.instanceId,contentId:candidateContentId,contentHash:candidate.hash,itemLocalId:item.localId,itemVersion:resource.version}]
  })
  if(roleTargets.length&&!this.roles)throw new WorkError('teloa/dependency-unavailable','员工服务尚未接入，不能按模板重放员工定义。')
  const now=this.identity.now();if(!Number.isFinite(Date.parse(now)))throw invalid()
  const db=await this.pool.connect()
  try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['industry-load-upgrade-request',ownerId,requestId])])
   const receipt=(await db.query(query,[ownerId,requestId,JSON.stringify(spec)])).rows[0]
   if(receipt){const result=await replay(db,receipt);await db.query('commit');return result}
   await this.lockConfiguration(db,ownerId,current.scope)
   const locked=(await db.query('select owner_id,status,mapping_hash,content_hash,space_id from teloa_industry_loads where id=$1 for update',[loadId])).rows[0]
   if(!locked||locked.owner_id!==ownerId)throw new WorkError('teloa/forbidden','行业模板加载记录不存在或不属于当前本人。')
   if(locked.status!=='active')throw new WorkError('teloa/conflict','行业模板加载已卸载或已被升级替代。')
   if(locked.mapping_hash!==spec.expectedMappingHash)throw new WorkError('teloa/version-conflict','行业模板加载的资源映射已变化，请重新核对。')
   if(locked.content_hash!==current.contentHash||locked.space_id!==current.space.id)throw corrupt()
   // 按选择应用：先复用卸载的在途阻断判据（旧加载正在被执行时不能替代它），再建立继任加载、
   // 解除被移除资源的旧实例、按 use-template 重放岗位模板字段，最后暂停旧加载创建的计划
   // ——候选的计划项在继任加载上重新创建。阻断判据放在继任加载 `insert` 之前：同一笔事务里两种顺序语义等价，
   // 但被拒绝时不必先写继任加载再整笔回滚（判据只读计划、运行与 Skill 使用关系，不依赖继任加载存在）。
   // 关联、常用入口与行业说明只落在计划里：继任加载行必须与候选快照逐字一致（`read` 的硬不变量），
   // 选 `keep` 也无法改写那一行，因此这三项在这里没有任何写。
   const present=await this.present(db,[...detachTables,'teloa_skill_install_usages','teloa_plan_occurrences','teloa_plans','teloa_industry_plan_sources','teloa_tasks','teloa_task_runs','teloa_task_run_skill_refs'])
   const blocked=await this.blockers(db,ownerId,loadId,present)
   if(blocked.length)throw new WorkError('teloa/conflict','存在进行中的计划执行或运行，暂不能升级。',{blockers:blocked})
   const successorId=await this.insert(db,ownerId,{contentId:candidateContentId,contentHash:candidate.hash,target:{kind:'existing',spaceId:current.space.id,expectedVersion:current.space.version}},snapshot,now,{duplicate:'reject',supersedes:loadId,carriedFrom})
   await db.query('insert into teloa_industry_upgrade_plans values($1,$2,$3,$4,$5,$6)',[ownerId,loadId,successorId,JSON.stringify(choices),digest,now])
   await db.query("update teloa_industry_loads set status='superseded' where id=$1 and owner_id=$2",[loadId,ownerId])
   for(const target of detachTargets)if(present.has(target.table))await detachIndustryInstanceByItem(db,target.table,ownerId,target.itemInstanceId,now)
   for(const target of roleTargets)await this.roles!.applyTemplateInTransaction(db,ownerId,target)
   await this.pausePlans(db,ownerId,loadId,present,'模板已升级，请在新版本重新启用','持续计划服务尚未接入，不能升级仍在生效的行业计划。')
   await db.query('insert into teloa_industry_load_upgrade_requests values($1,$2,$3,$4,$5)',[ownerId,requestId,JSON.stringify(spec),loadId,successorId])
   const superseded=await this.read(db,ownerId,loadId),successor=await this.read(db,ownerId,successorId)
   await db.query('commit');return {superseded,successor}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}
