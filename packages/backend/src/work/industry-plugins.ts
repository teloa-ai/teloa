import {createHash} from 'node:crypto'
import type {Pool} from 'pg'
import {WorkError,readIndustryPluginDefinition,readMarketPluginInstallPreview,type IndustryPluginDefinition,type MarketPluginInstallPreview,type MarketPluginInstallSpec,type MarketPluginInstallationState,type MarketPluginRegistrySource} from '@teloa/contract'
import {createIndustryInstanceKit,industryDetachedState,type IndustryInstanceKit,industryOwner,industryPredicates,type IndustryInstanceListError,type IndustryInstanceStored} from './industry-instance-kit.ts'
import type {PluginInstallation} from '../market/plugin-installations.ts'
import type {IndustryPluginSource,IndustryPluginSourceSnapshot} from './industry-plugin-source.ts'
import type {IndustryLoadService} from './industry-loads.ts'

export type IndustryPluginState='needs_install'|'installing'|'pending-enable'|'active'|'restart-required'|'failed'|'detached'
/** `drift` 只出现在读路径投影上：固定来源已变化时状态回落为初始态，绑定与安装身份仍保留供核对。 */
export type IndustryPluginInstance={id:string;ownerId:string;loadId:string;itemInstanceId:string;itemLocalId:string;contentId:string;contentHash:string;itemVersion:string;scope:string;definition:IndustryPluginDefinition;definitionHash:string;installationId:string|null;state:IndustryPluginState;revision:number;createdAt:string;updatedAt:string;drift?:true}
export type IndustryPluginPage={items:IndustryPluginInstance[];errors?:IndustryInstanceListError[]}
/** 端口只能抛 WorkError：宿主适配层必须把非 WorkError 异常收敛成 WorkError 后再交给本服务。 */
export type IndustryPluginInstallPort={
 preview:(owner:string,source:MarketPluginRegistrySource)=>Promise<MarketPluginInstallPreview>
 install:(owner:string,spec:MarketPluginInstallSpec)=>Promise<PluginInstallation>
 reconcile:(owner:string,installationId:string)=>Promise<PluginInstallation>
 find:(owner:string,source:MarketPluginRegistrySource)=>Promise<PluginInstallation|null>
}
type Stored=IndustryPluginInstance&{mappingDigest:string}&IndustryInstanceStored

const states:readonly IndustryPluginState[]=['needs_install','installing','pending-enable','active','restart-required','failed',industryDetachedState]
const {uuid,hash,exact,same}=industryPredicates
const invalid=()=>new WorkError('teloa/invalid-input','行业扩展实例请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','行业扩展实例记录损坏，已停止读取。')
const mismatch=()=>new WorkError('teloa/source-unavailable','DSH 扩展安装与行业扩展固定定义不一致。')
const definitionHash=(value:IndustryPluginSourceSnapshot)=>createHash('sha256').update(JSON.stringify([value.loadId.toLowerCase(),value.itemInstanceId.toLowerCase(),value.itemLocalId,value.contentId.toLowerCase(),value.contentHash,value.itemVersion,value.fileHash,value.definition])).digest('hex')
const registrySource=(value:IndustryPluginDefinition):MarketPluginRegistrySource=>({registry:'npm',packageName:value.packageName,version:value.version})

/** DSH 插件安装状态只投影为行业实例可展示的状态，登记态 `needs_install` 只由本服务产生。 */
export function projectPluginState(state:MarketPluginInstallationState):IndustryPluginState{
 return /fail/.test(state)?'failed':state==='installed-active'?'active':state==='installed-restart-required'?'restart-required':state==='installed-pending-enable'?'pending-enable':'installing'
}

export async function initializeIndustryPlugins(pool:Pool):Promise<void>{
 await pool.query(`
  create table if not exists teloa_industry_plugin_instances(
   id uuid primary key,owner_id text not null,load_id uuid not null references teloa_industry_loads(id),item_instance_id uuid not null,item_local_id text not null,
   content_id uuid not null,content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),item_version text not null,scope text not null,
   definition jsonb not null check(jsonb_typeof(definition)='object'),definition_hash text not null check(definition_hash ~ '^[a-f0-9]{64}$'),
   installation_id uuid,state text not null check(state in ('needs_install','installing','pending-enable','active','restart-required','failed','detached')),revision integer not null check(revision>=1),
   mapping_digest text not null check(mapping_digest ~ '^[a-f0-9]{64}$'),created_at timestamptz not null,updated_at timestamptz not null,
   unique(owner_id,load_id,item_instance_id),
   constraint teloa_industry_plugin_instances_installation_check check((state='needs_install' and installation_id is null) or (state<>'needs_install' and installation_id is not null))
  );
  alter table teloa_industry_plugin_instances drop constraint if exists teloa_industry_plugin_instances_state_check;
  alter table teloa_industry_plugin_instances drop constraint if exists teloa_industry_plugin_instances_installation_check;
  alter table teloa_industry_plugin_instances add constraint teloa_industry_plugin_instances_state_check check(state in ('needs_install','installing','pending-enable','active','restart-required','failed','detached'));
  alter table teloa_industry_plugin_instances add constraint teloa_industry_plugin_instances_installation_check check(
   state='detached' or (state='needs_install' and installation_id is null) or (state not in ('needs_install','detached') and installation_id is not null)
  );
  create table if not exists teloa_industry_plugin_create_requests(
   owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),instance_id uuid not null references teloa_industry_plugin_instances(id),primary key(owner_id,request_id)
  );
  create table if not exists teloa_industry_plugin_install_requests(
   owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),instance_id uuid not null references teloa_industry_plugin_instances(id),result_revision integer not null check(result_revision>=2),primary key(owner_id,request_id)
  );
 `)
}

export class IndustryPluginService{
 private readonly pool:Pool
 private readonly identity:{id:()=>string;now:()=>string}
 private readonly source:Pick<IndustryPluginSource,'read'>
 private readonly plugins:IndustryPluginInstallPort
 private readonly kit:IndustryInstanceKit<Stored,IndustryPluginInstance,IndustryPluginSourceSnapshot>
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},loads:Pick<IndustryLoadService,'get'|'getInTransaction'|'storedItemStatus'>,source:Pick<IndustryPluginSource,'read'>,plugins:IndustryPluginInstallPort){
  this.pool=pool;this.identity=identity;this.source=source;this.plugins=plugins
  this.kit=createIndustryInstanceKit<Stored,IndustryPluginInstance,IndustryPluginSourceSnapshot>({
   kind:'plugin',table:'teloa_industry_plugin_instances',createRequests:'teloa_industry_plugin_create_requests',advanceRequests:'teloa_industry_plugin_install_requests',
   lockPrefix:'industry-plugin',advanceName:'install',initialState:'needs_install',states,hidden:['mappingDigest'],
   messages:{forbidden:'行业扩展实例不存在或不属于当前本人。',conflictCreate:'同一请求不能实例化不同的行业扩展。',notInstantiable:'目标不是可实例化的行业扩展。',conflictAdvance:'同一请求不能安装不同的行业扩展。',versionConflict:'行业扩展安装状态已变化，请刷新后重试。',drift:'扩展固定来源已变化，停止使用当前安装。'},
   invalid,corrupt,
   readExtra:row=>({definition:readIndustryPluginDefinition(row.definition),definitionHash:row.definition_hash as string,installationId:row.installation_id as string|null}),
   // 终态 `detached` 保留解除前的安装身份：从登记态解除时仍为 null，从已安装态解除时仍是原安装。
   checkExtra:(value,initialState)=>hash(value.definitionHash)&&(value.state===industryDetachedState?value.revision>=2&&(value.installationId===null||uuid(value.installationId)):value.state===initialState?value.installationId===null&&value.revision===1:uuid(value.installationId)),
   sourceRequired:()=>true,
   sameSource:(value,fixed)=>value.definitionHash===definitionHash(fixed)&&same(value.definition,fixed.definition),
   advanced:state=>state!=='needs_install',
  },{pool,identity,loads,source})
 }

 /** DSH 插件安装必须属于本人，且其固定来源必须与行业插件定义完全一致，否则不能建立绑定。 */
 private checkInstallation(ownerId:string,value:PluginInstallation,definition:IndustryPluginDefinition,expectedId?:string):void{
  if(value.ownerId!==ownerId||!uuid(value.id)||(expectedId!==undefined&&value.id.toLowerCase()!==expectedId.toLowerCase()))throw mismatch()
  if(!same(value.preview.source,registrySource(definition)))throw mismatch()
 }

 async instantiate(ownerId:string,input:unknown):Promise<IndustryPluginInstance>{
  return this.kit.instantiate(ownerId,input,{
   preview:async(db,context)=>this.source.read(db,context.ownerId,{loadId:context.loadId,itemInstanceId:context.itemInstanceId}),
   columns:async(snapshot,context)=>{
    const found=await this.plugins.find(context.ownerId,registrySource(snapshot.definition))
    if(found)this.checkInstallation(context.ownerId,found,snapshot.definition)
    return {definition:JSON.stringify(snapshot.definition),definition_hash:definitionHash(snapshot),installation_id:found?found.id:null,state:found?projectPluginState(found.state):'needs_install'}
   },
  })
 }

 /**
  * 安装前的知情同意来源：把市场路径同一份 `MarketPluginInstallPreview` 原样交给客户端。
  *
  * 行业模板是第三方内容进入系统的主入口，此前这条路径在**服务端**取预览、比对来源、直接安装，
  * 本人从头到尾看不到"该插件会改动 X"。现在与市场路径同形：先取预览给人看，
  * 安装由客户端持这一份固定预览提交（见 `install`），服务端再与现取的 registry 预览逐字比对。
  * 本方法只读，不写任何记录，也不推进实例状态。
  */
 async preview(ownerId:string,input:unknown):Promise<MarketPluginInstallPreview>{
  industryOwner(ownerId);const row=exact(input,['instanceId'],invalid);if(!uuid(row.instanceId))throw invalid()
  const current=await this.kit.readProjectedStrict(ownerId,row.instanceId.toLowerCase())
  const preview=await this.plugins.preview(ownerId,registrySource(current.definition))
  if(!same(preview.source,registrySource(current.definition)))throw mismatch()
  return preview
 }

 async install(ownerId:string,input:unknown):Promise<IndustryPluginInstance>{
  // 客户端持固定预览提交：`preview` 不进推进请求的幂等键（那把键只认实例与修订），
  // 但每次尝试都要求这一份预览与来源、与 registry 现取的预览逐字一致。
  const row=exact(input,['requestId','instanceId','expectedRevision','preview'],invalid)
  let fixed:MarketPluginInstallPreview
  try{fixed=readMarketPluginInstallPreview(row.preview)}catch{throw invalid()}
  return this.kit.advance<IndustryPluginDefinition,PluginInstallation>(ownerId,{requestId:row.requestId,instanceId:row.instanceId,expectedRevision:row.expectedRevision},null,{
   preview:async(db,current)=>current.definition,
   probe:async(definition,context)=>{
    if(!same(fixed.source,registrySource(definition)))throw mismatch()
    // 宿主侧按 (owner,requestId)/(owner,package) 幂等：并发时可能被调用多次，落败方重试会收敛到同一安装。
    // 市场安装服务会拿这一份固定预览与现取的 registry 预览逐字比对，不一致即 teloa/source-unavailable；
    // 补丁命中拒绝清单（trust.status==='rejected'）时在落任何记录之前就拒绝。
    const installation=await this.plugins.install(context.ownerId,{schema:'teloa.market-plugin-install-spec/v1',requestId:context.requestId,preview:fixed})
    this.checkInstallation(context.ownerId,installation,definition)
    return installation
   },
   write:async(db,context)=>{
    if(!same(context.current.definition,context.preview))throw new WorkError('teloa/source-unavailable','扩展固定定义在安装期间发生变化，请重新安装。')
    return (await db.query("update teloa_industry_plugin_instances set installation_id=$3,state=$4,revision=revision+1,updated_at=$5 where id=$1 and owner_id=$2 and state='needs_install' and revision=$6 returning *",[context.instanceId,context.ownerId,context.probe.id,projectPluginState(context.probe.state),context.now(),context.expectedRevision])).rows[0]
   },
  })
 }

 /**
  * 核对是写路径：来源已漂移时与安装、登记一样直接拒绝，绝不把漂移投影出来的初始态当成真实状态回写。
  * 状态确有变化时修订递增：目录与客户端据此判定哪一份更新（等值仍允许覆盖，更低的修订被丢弃）；
  * 状态未变化时提前返回，不写库也不动修订。
  */
 async reconcile(ownerId:string,input:unknown):Promise<IndustryPluginInstance>{
  industryOwner(ownerId);const row=exact(input,['instanceId'],invalid);if(!uuid(row.instanceId))throw invalid()
  const instanceId=row.instanceId.toLowerCase(),current=await this.kit.readProjectedStrict(ownerId,instanceId)
  if(current.installationId===null)return current
  const installation=await this.plugins.reconcile(ownerId,current.installationId)
  this.checkInstallation(ownerId,installation,current.definition,current.installationId)
  return this.writeProjectedState(ownerId,instanceId,current,installation)
 }

 /**
  * 本人的第二次显式动作：把待启用的插件加回 `dsh.profile.bundles`。
  *
  * 与市场路径同一条服务端实现（`install(spec)` 的 `action: 'enable'`）：不经 prepare、
  * 不消耗 requestId、不再向 registry 取预览，只要求这一份固定预览与既有安装记录逐字一致，
  * 并由宿主按磁盘副本重算权限摘要再比对一次。这里额外要求实例当前就是 `pending-enable`：
  * 已经 active / restart-required 的实例不该再走一次启用。
  */
 async enable(ownerId:string,input:unknown):Promise<IndustryPluginInstance>{
  industryOwner(ownerId);const row=exact(input,['instanceId','preview'],invalid);if(!uuid(row.instanceId))throw invalid()
  let fixed:MarketPluginInstallPreview
  try{fixed=readMarketPluginInstallPreview(row.preview)}catch{throw invalid()}
  const instanceId=row.instanceId.toLowerCase(),current=await this.kit.readProjectedStrict(ownerId,instanceId)
  if(current.installationId===null||current.state!=='pending-enable')throw new WorkError('teloa/conflict','只有待启用的行业扩展可以启用。')
  if(!same(fixed.source,registrySource(current.definition)))throw mismatch()
  const requestId=this.identity.id();if(!uuid(requestId))throw invalid()
  const installation=await this.plugins.install(ownerId,{schema:'teloa.market-plugin-install-spec/v1',requestId,preview:fixed,action:'enable'})
  this.checkInstallation(ownerId,installation,current.definition,current.installationId)
  return this.writeProjectedState(ownerId,instanceId,current,installation)
 }

 /** 把 DSH 安装状态投影回实例；状态未变化时不写库也不动修订。 */
 private async writeProjectedState(ownerId:string,instanceId:string,current:IndustryPluginInstance,installation:PluginInstallation):Promise<IndustryPluginInstance>{
  const projected=projectPluginState(installation.state)
  if(projected===current.state)return current
  const now=this.identity.now();if(!Number.isFinite(Date.parse(now)))throw invalid()
  const db=await this.pool.connect();let value:IndustryPluginInstance
  try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['industry-plugin-install-instance',ownerId,instanceId])])
   // 终态守卫在条件更新里：预检与本次写不在同一事务，其间发生的卸载或升级解除必须让这次核对整笔落空。
   const saved=(await db.query('update teloa_industry_plugin_instances set state=$3,revision=revision+1,updated_at=$4 where id=$1 and owner_id=$2 and installation_id=$5 and state<>$3 and state<>$6 returning *',[instanceId,ownerId,projected,now,current.installationId,industryDetachedState])).rows[0]
   value=await this.kit.projectStrict(db,saved?this.kit.stored(saved):await this.kit.row(ownerId,instanceId,db))
   await db.query('commit')
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
  return value
 }

 async get(ownerId:string,input:unknown):Promise<IndustryPluginInstance>{return this.kit.get(ownerId,input)}
 async list(ownerId:string,input:unknown):Promise<IndustryPluginPage>{return this.kit.list(ownerId,input)}
}
