import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord} from '@teloa/contract'
import type {IndustryLoadItem,IndustryLoadRecord,IndustryLoadResourceKind,IndustryLoadService} from './industry-loads.ts'

/** 行业资源实例的冻结映射身份：四类实例表共用同一组冻结列，映射指纹只由这些列决定。 */
export type IndustryInstanceIdentity={id:string;ownerId:string;loadId:string;itemInstanceId:string;itemLocalId:string;contentId:string;contentHash:string;itemVersion:string;scope:string}
/** `drift` 只由读路径投影产生：固定来源已变化时回落为初始态，落库的行上永远没有这个字段。 */
export type IndustryInstanceBase=IndustryInstanceIdentity&{state:string;revision:number;createdAt:string;updatedAt:string;drift?:true}
export type IndustryInstanceStored=IndustryInstanceBase&{mappingDigest:string}
/** 目录逐行容错的失败项：一行读坏或其固定来源读不出来都不应遮蔽其余行。 */
export type IndustryInstanceListError={instanceId:string;code:'teloa/storage-corrupt'|'teloa/source-unavailable'}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const stableId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=1
const stamp=(value:unknown,corrupt:()=>WorkError):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const exact=(value:unknown,keys:readonly string[],invalid:()=>WorkError):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right)
const mapping=(value:IndustryInstanceIdentity)=>createHash('sha256').update(JSON.stringify([value.id.toLowerCase(),value.ownerId,value.loadId.toLowerCase(),value.itemInstanceId.toLowerCase(),value.itemLocalId,value.contentId.toLowerCase(),value.contentHash,value.itemVersion,value.scope])).digest('hex')

/** 四个行业资源实例服务共用的谓词与指纹，任何一处调整都同时影响四张实例表的读取核验。 */
export const industryPredicates={uuid,hash,stableId,semver,positive,stamp,exact,same,mapping}
export const industryOwner=(value:string):void=>{if(typeof value!=='string'||!value||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}

/**
 * 卸载后的终态：四类实例表共用。`get`/`list` 仍照常读出已解除的实例（供界面追溯），
 * 但任何写路径（登记、推进、核对）都不能再落到它上面，也不能在非活跃加载上新开实例。
 */
export const industryDetachedState='detached'
const detachedRejected=()=>new WorkError('teloa/conflict','行业模板已卸载或已被升级替代，不能继续操作。')
/**
 * 解除本次加载在某张实例表里的全部实例：状态改为终态、修订递增，绑定与定义列原样保留供追溯。
 * `table` 只接受调用方代码内的常量表名（与 kit 自身拼表名的方式一致），值全部走参数化占位符。
 */
export async function detachIndustryInstances(db:PoolClient,table:string,ownerId:string,loadId:string,now:string):Promise<number>{
 return (await db.query(`update ${table} set state=$4,revision=revision+1,updated_at=$3 where owner_id=$1 and load_id=$2 and state<>$4`,[ownerId,loadId,now,industryDetachedState])).rowCount??0
}

/**
 * 按加载项身份解除那一个实例：`teloa_industry_load_items.instance_id` 全表唯一，因此这个身份精确定位到
 * 持有实例的那一行，**与它挂在哪次加载上无关**。沿用项的实例仍留在被替代的加载上，按当前加载过滤会一行都匹配不到，
 * 所以解除与回收都必须走这条路径；实例行自带 `owner_id`，归属由它限定。
 */
export async function detachIndustryInstanceByItem(db:PoolClient,table:string,ownerId:string,itemInstanceId:string,now:string):Promise<number>{
 return (await db.query(`update ${table} set state=$4,revision=revision+1,updated_at=$3 where owner_id=$1 and item_instance_id=$2 and state<>$4`,[ownerId,itemInstanceId,now,industryDetachedState])).rowCount??0
}

/**
 * 本实例是否被某条仍在生效的加载沿用：升级时继任加载项记 `carried_from`=持有实例的那一项，
 * 因此"被替代的加载上的实例仍在服役"这件事可以只靠加载项表判定，不需要各实例表参与。
 */
async function carriedForward(db:PoolClient,ownerId:string,itemInstanceId:string):Promise<boolean>{
 const found=(await db.query("select 1 from teloa_industry_load_items i join teloa_industry_loads l on l.id=i.load_id and l.owner_id=$1 where i.carried_from=$2 and l.status='active' limit 1",[ownerId,itemInstanceId])).rows[0]
 return !!found
}

export type IndustryInstanceMessages={forbidden:string;conflictCreate:string;notInstantiable:string;conflictAdvance:string;versionConflict:string;drift:string}

export type IndustryInstanceSpec<TStored extends IndustryInstanceStored,TInstance extends IndustryInstanceBase,TSnapshot>={
 kind:IndustryLoadResourceKind
 table:string
 createRequests:string
 advanceRequests:string
 /** 建议锁键前缀，例如 `industry-data-source`；推进锁键为 `<lockPrefix>-<advanceName>-request|-instance`。 */
 lockPrefix:string
 advanceName:string
 initialState:string
 states:readonly string[]
 /** 只存在于存储投影、不出现在对外实例上的字段名。 */
 hidden:readonly (Exclude<keyof TStored,keyof TInstance>&string)[]
 messages:IndustryInstanceMessages
 invalid:()=>WorkError
 corrupt:()=>WorkError
 /** 从数据库行读出该类实例独有的字段（不含公共冻结列与状态列）；格式不符必须抛错。 */
 readExtra:(row:Record<string,unknown>)=>Omit<TStored,keyof IndustryInstanceStored>
 /** 该类实例独有的状态不变量，返回 false 视为记录损坏。 */
 checkExtra:(value:TStored,initialState:string)=>boolean
 /** 是否需要在核验时回读固定来源。 */
 sourceRequired:(value:TStored)=>boolean
 /** 固定来源是否仍与已冻结的绑定一致；false 视为来源漂移。 */
 sameSource:(value:TStored,snapshot:TSnapshot)=>boolean
 /** 推进已完成的终态判定，用于回执复放核对。 */
 advanced:(state:string)=>boolean
}

export type IndustryInstancePorts<TSnapshot>={
 pool:Pool
 identity:{id:()=>string;now:()=>string}
 loads:Pick<IndustryLoadService,'get'|'getInTransaction'|'storedItemStatus'>
 source:{read:(db:PoolClient,owner:string,input:{loadId:string;itemInstanceId:string})=>Promise<TSnapshot>}
}

export type IndustryBindingExtra<TBinding extends {definitionHash:string}>={binding:TBinding|null;bindingHash:string|null}
export type IndustryBindingStored<TBinding extends {definitionHash:string}>=IndustryInstanceStored&IndustryBindingExtra<TBinding>

/**
 * 三个绑定型资源（数据源、执行工具、MCP 连接）共用的 spec 片段：`binding`/`binding_hash` 两列的读取、
 * 「初始态无绑定、active 态绑定摘要自洽」的不变量、来源回读条件、推进终态与隐藏字段在三者上完全一致，
 * 差异只剩各自的 `readBinding` 与 `sameSource`。初始状态由 kit 从 `spec.initialState` 回传，无需重复声明。
 * 终态 `detached` 保留解除前的绑定列，因此两种形态（解除自初始态、解除自 active）都要接受。
 */
export function industryBindingSpec<TBinding extends {definitionHash:string},TStored extends IndustryBindingStored<TBinding>>(readBinding:(value:unknown)=>TBinding):{
 readExtra:(row:Record<string,unknown>)=>IndustryBindingExtra<TBinding>
 checkExtra:(value:TStored,initialState:string)=>boolean
 sourceRequired:(value:TStored)=>boolean
 advanced:(state:string)=>boolean
 hidden:readonly ('mappingDigest'|'bindingHash')[]
}{
 return {
  readExtra:row=>({binding:row.binding===null?null:readBinding(row.binding),bindingHash:row.binding_hash as string|null}),
  checkExtra:(value,initialState)=>value.state===industryDetachedState
   ?value.revision>=2&&(value.binding===null?value.bindingHash===null:hash(value.bindingHash)&&value.bindingHash===value.binding.definitionHash)
   :value.state===initialState?value.revision===1&&value.binding===null&&value.bindingHash===null:value.revision>=2&&value.binding!==null&&hash(value.bindingHash)&&value.bindingHash===value.binding.definitionHash,
  sourceRequired:value=>value.state==='active',
  advanced:state=>state==='active',
  hidden:['mappingDigest','bindingHash'],
 }
}

export type IndustryInstantiateContext={ownerId:string;loadId:string;itemInstanceId:string;load:IndustryLoadRecord;item:IndustryLoadItem}
export type IndustryAdvanceContext={ownerId:string;requestId:string;instanceId:string;expectedRevision:number}

/**
 * 行业资源实例的公共骨架：登记与三段式推进（事务外预检 → 事务外就绪核验 → 写事务内条件更新）
 * 在四类资源上完全一致，差异只在表名、状态字面量、文案与绑定形状，由 spec 与钩子提供。
 */
export function createIndustryInstanceKit<TStored extends IndustryInstanceStored,TInstance extends IndustryInstanceBase,TSnapshot>(spec:IndustryInstanceSpec<TStored,TInstance,TSnapshot>,ports:IndustryInstancePorts<TSnapshot>){
 const {pool,identity,loads,source}=ports,{invalid,corrupt}=spec
 const versionConflict=()=>new WorkError('teloa/version-conflict',spec.messages.versionConflict)
 const now=():string=>{const value=identity.now();if(!Number.isFinite(Date.parse(value)))throw invalid();return value}

 const stored=(row:Record<string,unknown>):TStored=>{
  try{
   // 公共冻结列在 readExtra 之后展开：钩子既不能覆盖身份与状态列，也无需自行搬运它们。
   const value={...spec.readExtra(row),id:row.id as string,ownerId:row.owner_id as string,loadId:row.load_id as string,itemInstanceId:row.item_instance_id as string,itemLocalId:row.item_local_id as string,contentId:row.content_id as string,contentHash:row.content_hash as string,itemVersion:row.item_version as string,scope:row.scope as string,state:row.state as string,revision:Number(row.revision),mappingDigest:row.mapping_digest as string,createdAt:stamp(row.created_at,corrupt),updatedAt:stamp(row.updated_at,corrupt)} as TStored
   if(!uuid(value.id)||!value.ownerId||!uuid(value.loadId)||!uuid(value.itemInstanceId)||!stableId(value.itemLocalId)||!uuid(value.contentId)||!hash(value.contentHash)||!semver(value.itemVersion)||typeof value.scope!=='string'||!value.scope||!spec.states.includes(value.state)||!Number.isSafeInteger(value.revision)||value.revision<1||!hash(value.mappingDigest)||value.mappingDigest!==mapping(value)||value.updatedAt<value.createdAt)throw Error()
   if(!spec.checkExtra(value,spec.initialState))throw Error()
   return value
  }catch{throw corrupt()}
 }
 const result=(value:TStored):TInstance=>{const projected:Record<string,unknown>={...value};for(const key of spec.hidden)delete projected[key];return projected as TInstance}
 const row=async(ownerId:string,instanceId:string,db:Pool|PoolClient=pool):Promise<TStored>=>{
  const found=(await db.query(`select * from ${spec.table} where id=$1 and owner_id=$2`,[instanceId,ownerId])).rows[0]
  if(!found)throw new WorkError('teloa/forbidden',spec.messages.forbidden)
  return stored(found)
 }
 /**
  * 核验身份与固定来源：身份不符（归属、加载映射、内容指纹）一律判定记录损坏；
  * 固定来源本身读不出来仍抛 `teloa/source-unavailable`，只有「读得出但已变化」才报告为漂移。
  */
 const verify=async(db:PoolClient,value:TStored):Promise<{drift:boolean;load:IndustryLoadRecord}>=>{
  const load=await loads.getInTransaction(db,value.ownerId,{loadId:value.loadId}),item=load.items.find(candidate=>candidate.instanceId===value.itemInstanceId)
  if(!item||item.kind!==spec.kind||await loads.storedItemStatus(db,value.ownerId,value.itemInstanceId)!=='pending-adapter'||item.localId!==value.itemLocalId||item.version!==value.itemVersion||load.contentId!==value.contentId||load.contentHash!==value.contentHash||load.space.scope!==value.scope)throw corrupt()
  if(!spec.sourceRequired(value))return {drift:false,load}
  let fixed:TSnapshot
  try{fixed=await source.read(db,value.ownerId,{loadId:value.loadId,itemInstanceId:value.itemInstanceId})}catch(error){if(error instanceof WorkError&&error.code==='teloa/source-unavailable')throw error;throw corrupt()}
  return {drift:!spec.sameSource(value,fixed),load}
 }
 /** 读路径投影：来源已漂移的实例回落为初始态并标记 `drift`，已冻结的绑定仍保留供界面核对。 */
 const project=async(db:PoolClient,value:TStored):Promise<TInstance>=>{
  const {drift}=await verify(db,value)
  return drift?{...result(value),state:spec.initialState,drift:true} as TInstance:result(value)
 }
 /**
  * 写路径核验：来源已漂移即拒绝，既不落状态也不落回执；加载已卸载、实例已解除同样拒绝。
  * 例外只有一个：加载已被升级替代，但仍有一条活跃加载把本实例作为沿用来源——那说明这个实例仍在服役，
  * 沿用一个尚未接入完的资源之后必须还能把它推进完（授权、连接、安装），否则它在新版本上永远无路可走。
  * 新开实例不走这个例外：`instantiate` 自己先核对目标加载必须 `active`。
  * 所有写路径（登记、推进、插件核对）都经过这里，读路径的 `project` 不经过，因此已解除的实例仍可读。
  */
 const verifyFresh=async(db:PoolClient,value:TStored):Promise<void>=>{
  const {drift,load}=await verify(db,value)
  if(value.state===industryDetachedState)throw detachedRejected()
  if(load.status!=='active'&&!(load.status==='superseded'&&await carriedForward(db,value.ownerId,value.itemInstanceId)))throw detachedRejected()
  if(drift)throw new WorkError('teloa/source-unavailable',spec.messages.drift)
 }
 const projectStrict=async(db:PoolClient,value:TStored):Promise<TInstance>=>{await verifyFresh(db,value);return result(value)}
 const readWith=async(project:(db:PoolClient,value:TStored)=>Promise<TInstance>,ownerId:string,instanceId:string):Promise<TInstance>=>{
  const db=await pool.connect()
  try{await db.query('begin isolation level repeatable read');const value=await project(db,await row(ownerId,instanceId,db));await db.query('commit');return value}catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
 const readProjected=async(ownerId:string,instanceId:string):Promise<TInstance>=>readWith(project,ownerId,instanceId)
 const readProjectedStrict=async(ownerId:string,instanceId:string):Promise<TInstance>=>readWith(projectStrict,ownerId,instanceId)
 /**
  * 回执是否属于同一请求交给 Postgres 的 `jsonb` 相等判定（查询里的 `request_spec=$3::jsonb`），
  * 与加载层一致：键序与数值书写形式不同的同一份请求仍判为同一请求，逐字比较会把它误判为换了请求。
  */
 const receipt=(found:Record<string,unknown>|undefined):{instanceId:string;revision:number}|null=>{
  if(!found)return null
  if(!found.same_request)throw new WorkError('teloa/conflict',spec.messages.conflictAdvance)
  if(!uuid(found.instance_id)||!Number.isSafeInteger(Number(found.result_revision))||Number(found.result_revision)<2)throw corrupt()
  return {instanceId:found.instance_id,revision:Number(found.result_revision)}
 }

 /**
  * 登记：请求回执幂等 → 加载项可实例化核对 → 事务外预检 → 写事务内按 (owner,load,item) 去重插入。
  * `preview` 在可重复读事务内运行，`columns` 在事务外运行并给出该类实例独有的插入列（可含 `state`）。
  */
 const instantiate=async<TPreview>(ownerId:string,input:unknown,hooks:{preview?:(db:PoolClient,context:IndustryInstantiateContext)=>Promise<TPreview>;columns?:(preview:TPreview,context:IndustryInstantiateContext)=>Promise<Record<string,unknown>>|Record<string,unknown>}={}):Promise<TInstance>=>{
  industryOwner(ownerId);const value=exact(input,['requestId','loadId','itemInstanceId'],invalid);if(!uuid(value.requestId)||!uuid(value.loadId)||!uuid(value.itemInstanceId))throw invalid()
  const requestId=value.requestId.toLowerCase(),loadId=value.loadId.toLowerCase(),itemInstanceId=value.itemInstanceId.toLowerCase(),request={loadId,itemInstanceId}
  const requests=`select *,request_spec=$3::jsonb as same_request from ${spec.createRequests} where owner_id=$1 and request_id=$2`,spelled=JSON.stringify(request)
  const initial=(await pool.query(requests,[ownerId,requestId,spelled])).rows[0]
  if(initial){if(!initial.same_request)throw new WorkError('teloa/conflict',spec.messages.conflictCreate);if(!uuid(initial.instance_id))throw corrupt();const found=await readProjectedStrict(ownerId,initial.instance_id);if(found.loadId!==loadId||found.itemInstanceId!==itemInstanceId)throw corrupt();return found}
  const load=await loads.get(ownerId,{loadId}),item=load.items.find(candidate=>candidate.instanceId===itemInstanceId)
  if(load.status!=='active')throw detachedRejected()
  // 沿用旧实例的加载项不再另行实例化：投影状态不是初始态就说明来源实例真实存在，重开一个会造成同一项两个实例。
  if(!item||item.kind!==spec.kind||item.carriedFrom&&item.status!=='pending-adapter'||await loads.storedItemStatus(pool,ownerId,itemInstanceId)!=='pending-adapter')throw new WorkError('teloa/conflict',spec.messages.notInstantiable)
  const context:IndustryInstantiateContext={ownerId,loadId,itemInstanceId,load,item}
  let preview=undefined as TPreview
  if(hooks.preview){
   const previewDb=await pool.connect()
   try{await previewDb.query('begin isolation level repeatable read');preview=await hooks.preview(previewDb,context);await previewDb.query('commit')}catch(error){await previewDb.query('rollback').catch(()=>{});throw error}finally{previewDb.release()}
  }
  const extra=hooks.columns?await hooks.columns(preview,context):{}
  const initialState=extra.state===undefined?spec.initialState:String(extra.state),rest=Object.entries(extra).filter(([key])=>key!=='state')
  const client=await pool.connect();let instanceId:string
  try{
   await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([spec.lockPrefix+'-request',ownerId,requestId])]);await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([spec.lockPrefix+'-item',ownerId,loadId,itemInstanceId])])
   const found=(await client.query(requests,[ownerId,requestId,spelled])).rows[0]
   if(found){if(!found.same_request)throw new WorkError('teloa/conflict',spec.messages.conflictCreate);if(!uuid(found.instance_id))throw corrupt();instanceId=found.instance_id}
   else{
    const existing=(await client.query(`select * from ${spec.table} where owner_id=$1 and load_id=$2 and item_instance_id=$3`,[ownerId,loadId,itemInstanceId])).rows[0]
    if(existing)instanceId=stored(existing).id
    else{
     const id=identity.id(),stamped=identity.now();if(!uuid(id)||!Number.isFinite(Date.parse(stamped)))throw invalid()
     const frozen={id,ownerId,loadId,itemInstanceId,itemLocalId:item.localId,contentId:load.contentId,contentHash:load.contentHash,itemVersion:item.version,scope:load.space.scope}
     // 参数化列按 (列名,值) 成对生成；`revision` 恒为 1，`updated_at` 复用 `created_at` 的占位符，故两者只追加列名。
     const columns:[string,unknown][]=[['id',id],['owner_id',ownerId],['load_id',loadId],['item_instance_id',itemInstanceId],['item_local_id',item.localId],['content_id',load.contentId],['content_hash',load.contentHash],['item_version',item.version],['scope',load.space.scope],['state',initialState],...rest,['mapping_digest',mapping(frozen)],['created_at',stamped]]
     const marks=columns.map((_,index)=>'$'+(index+1)),createdAt=marks[marks.length-1]!
     const names=[...columns.map(([key])=>key),'revision','updated_at'],values=[...marks,'1',createdAt]
     instanceId=stored((await client.query(`insert into ${spec.table}(${names.join(',')}) values(${values.join(',')}) returning *`,columns.map(([,column])=>column))).rows[0]).id
    }
    await client.query(`insert into ${spec.createRequests}(owner_id,request_id,request_spec,instance_id) values($1,$2,$3,$4)`,[ownerId,requestId,JSON.stringify(request),instanceId])
   }
   await client.query('commit')
  }catch(error){await client.query('rollback').catch(()=>{});throw error}finally{client.release()}
  const projected=await readProjectedStrict(ownerId,instanceId)
  if(projected.loadId!==loadId||projected.itemInstanceId!==itemInstanceId)throw corrupt()
  return projected
 }

 /**
  * 三段式推进：事务外预检读取固定来源 → 事务外就绪核验（`probe`）→ 写事务内条件更新（`write`）。
  * `write` 必须自行完成来源新鲜度比对与条件更新，返回 undefined 表示乐观锁落空。
  */
 const advance=async<TPreview,TProbe>(ownerId:string,input:unknown,signal:AbortSignal|null,hooks:{
  preview:(db:PoolClient,current:TStored,context:IndustryAdvanceContext)=>Promise<TPreview>
  probe:(preview:TPreview,context:IndustryAdvanceContext)=>Promise<TProbe>
  write:(db:PoolClient,context:{current:TStored;preview:TPreview;probe:TProbe;now:()=>string}&IndustryAdvanceContext)=>Promise<Record<string,unknown>|undefined>
 }):Promise<TInstance>=>{
  industryOwner(ownerId);const value=exact(input,['requestId','instanceId','expectedRevision'],invalid);if(!uuid(value.requestId)||!uuid(value.instanceId)||!positive(value.expectedRevision))throw invalid()
  const requestId=value.requestId.toLowerCase(),instanceId=value.instanceId.toLowerCase(),expectedRevision=Number(value.expectedRevision),request={instanceId,expectedRevision}
  const context:IndustryAdvanceContext={ownerId,requestId,instanceId,expectedRevision}
  const requests=`select *,request_spec=$3::jsonb as same_request from ${spec.advanceRequests} where owner_id=$1 and request_id=$2`,spelled=JSON.stringify(request)
  const initial=receipt((await pool.query(requests,[ownerId,requestId,spelled])).rows[0])
  if(initial){if(initial.instanceId.toLowerCase()!==instanceId)throw corrupt();const found=await readProjectedStrict(ownerId,instanceId);if(!spec.advanced(found.state)||found.revision!==initial.revision)throw corrupt();return found}
  signal?.throwIfAborted()
  const previewDb=await pool.connect();let preview:TPreview
  try{
   await previewDb.query('begin isolation level repeatable read')
   // 来源核验先于乐观锁：来源已漂移的实例即便被投影成初始态展示，也只能得到「来源已变化」而不是「刷新后重试」。
   const current=await row(ownerId,instanceId,previewDb);await verifyFresh(previewDb,current)
   if(current.state!==spec.initialState||current.revision!==expectedRevision)throw versionConflict()
   preview=await hooks.preview(previewDb,current,context);await previewDb.query('commit')
  }catch(error){await previewDb.query('rollback').catch(()=>{});throw error}finally{previewDb.release()}
  signal?.throwIfAborted();const probe=await hooks.probe(preview,context)
  signal?.throwIfAborted()
  const db=await pool.connect();let projected:TInstance
  try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([`${spec.lockPrefix}-${spec.advanceName}-request`,ownerId,requestId])]);await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([`${spec.lockPrefix}-${spec.advanceName}-instance`,ownerId,instanceId])])
   const restored=receipt((await db.query(requests,[ownerId,requestId,spelled])).rows[0])
   if(restored){if(restored.instanceId.toLowerCase()!==instanceId)throw corrupt();const current=await projectStrict(db,await row(ownerId,instanceId,db));if(!spec.advanced(current.state)||current.revision!==restored.revision)throw corrupt();projected=current}
   else{
    const current=await row(ownerId,instanceId,db);await verifyFresh(db,current)
    if(current.state!==spec.initialState||current.revision!==expectedRevision)throw versionConflict()
    const saved=await hooks.write(db,{...context,current,preview,probe,now})
    if(!saved)throw versionConflict()
    const value=await projectStrict(db,stored(saved))
    await db.query(`insert into ${spec.advanceRequests}(owner_id,request_id,request_spec,instance_id,result_revision) values($1,$2,$3,$4,$5)`,[ownerId,requestId,JSON.stringify(request),instanceId,value.revision]);projected=value
   }
   await db.query('commit')
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
  return projected
 }

 const get=async(ownerId:string,input:unknown):Promise<TInstance>=>{industryOwner(ownerId);const value=exact(input,['instanceId'],invalid);if(!uuid(value.instanceId))throw invalid();return readProjected(ownerId,value.instanceId.toLowerCase())}
 /** 目录逐行容错：单行损坏或其固定来源读不出来只记入 `errors`，其余行照常返回；`errors` 为空时不出现。 */
 const list=async(ownerId:string,input:unknown):Promise<{items:TInstance[];errors?:IndustryInstanceListError[]}>=>{
  industryOwner(ownerId);exact(input,[],invalid);const db=await pool.connect()
  try{
   await db.query('begin isolation level repeatable read')
   const rows=(await db.query(`select * from ${spec.table} where owner_id=$1 order by created_at,id`,[ownerId])).rows,items:TInstance[]=[],errors:IndustryInstanceListError[]=[]
   for(const found of rows){
    if(!uuid(found.id))throw corrupt()
    try{items.push(await project(db,stored(found)))}
    catch(error){if(!(error instanceof WorkError)||error.code!=='teloa/storage-corrupt'&&error.code!=='teloa/source-unavailable')throw error;errors.push({instanceId:found.id as string,code:error.code})}
   }
   await db.query('commit');return {items,...(errors.length?{errors}:{})}
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 return {stored,result,row,verify,project,projectStrict,readProjected,readProjectedStrict,receipt,instantiate,advance,get,list}
}

export type IndustryInstanceKit<TStored extends IndustryInstanceStored,TInstance extends IndustryInstanceBase,TSnapshot>=ReturnType<typeof createIndustryInstanceKit<TStored,TInstance,TSnapshot>>
