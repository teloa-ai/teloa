import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {
 WorkError,
 isRecord,
 readMarketPluginInstallFailure,
 readMarketPluginInstallObservation,
 marketPluginPermissionKey,
 readMarketPluginInstallPreview,
 sameMarketPluginPermissions,
 readMarketPluginInstallReceipt,
 readMarketPluginInstallSpec,
 readMarketPluginInstallationState,
 readMarketPluginRegistrySource,
 type MarketPluginInstallFailure,
 type MarketPluginInstallObservation,
 type MarketPluginInstallPreview,
 type MarketPluginInstallReceipt,
 type MarketPluginInstallSpec,
 type MarketPluginInstallationState,
 type MarketPluginRegistrySource,
} from '@teloa/contract'

export type PluginInstallPort={
 preview:(source:MarketPluginRegistrySource)=>Promise<unknown>
 install:(preview:MarketPluginInstallPreview)=>Promise<unknown>
 observe:(source:MarketPluginRegistrySource)=>Promise<unknown>
 /** 放行"已安装 · 待启用"：先按固定预览核对磁盘现状，通过才把包加回 profile 的 bundles。 */
 enable:(preview:MarketPluginInstallPreview)=>Promise<void>
}

export type PluginInstallation={
 id:string
 ownerId:string
 preview:MarketPluginInstallPreview
 state:MarketPluginInstallationState
 attempt:number
 receipt?:MarketPluginInstallReceipt
 observation?:MarketPluginInstallObservation
 failure?:MarketPluginInstallFailure
 createdAt:string
 updatedAt:string
}

const invalid=()=>new WorkError('teloa/invalid-input','DSH 扩展安装请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','DSH 扩展安装记录损坏，已停止读取。')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const owner=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=128&&value===value.trim()
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const stable=(value:unknown):string=>JSON.stringify(value,(_,item)=>isRecord(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)
const sha=(value:unknown):string=>createHash('sha256').update(stable(value)).digest('hex')
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
const same=(left:unknown,right:unknown):boolean=>stable(left)===stable(right)
// 预览与请求规格的比对里，能力摘要只看每项的 id 与 required：说明文字由 id 决定、只用于展示，
// 改版前存进记录的旧说明（「该插件会新增…」）不能让启用、核对或重装误判为权限已变化。
const previewKey=(preview:MarketPluginInstallPreview)=>({...preview,permissionSummary:marketPluginPermissionKey(preview.permissionSummary)})
const samePreview=(left:MarketPluginInstallPreview,right:MarketPluginInstallPreview):boolean=>same(previewKey(left),previewKey(right))
const sameSpec=(left:MarketPluginInstallSpec,right:MarketPluginInstallSpec):boolean=>same({...left,preview:previewKey(left.preview)},{...right,preview:previewKey(right.preview)})
const effectLock=(ownerId:string,packageName:string):string=>stable(['plugin-install-effect',ownerId,packageName])
const packageLock=(ownerId:string,packageName:string):string=>stable(['plugin-install-package',ownerId,packageName])

function storedFailure(value:unknown):MarketPluginInstallFailure|undefined{
 if(value===null||value===undefined)return undefined
 try{return readMarketPluginInstallFailure(value)}catch{throw corrupt()}
}

function storedReceipt(value:unknown):MarketPluginInstallReceipt|undefined{
 if(value===null||value===undefined)return undefined
 try{return readMarketPluginInstallReceipt(value)}catch{throw corrupt()}
}

function storedObservation(value:unknown):MarketPluginInstallObservation|undefined{
 if(value===null||value===undefined)return undefined
 try{return readMarketPluginInstallObservation(value)}catch{throw corrupt()}
}

function storedSpec(value:unknown):MarketPluginInstallSpec{
 try{return readMarketPluginInstallSpec(value)}catch{throw corrupt()}
}

export function readStoredPluginInstallation(row:Record<string,unknown>,ownerId:string):PluginInstallation{
 let preview:MarketPluginInstallPreview,state:MarketPluginInstallationState
 try{preview=readMarketPluginInstallPreview(row.preview);state=readMarketPluginInstallationState(row.state)}catch{throw corrupt()}
 const attempt=row.attempt,receipt=storedReceipt(row.last_receipt),observation=storedObservation(row.last_observation),failure=storedFailure(row.failure)
 if(row.owner_id!==ownerId||!uuid(row.id)||row.package_name!==preview.source.packageName||!hex(row.preview_hash)||row.preview_hash!==sha(preview)||!Number.isSafeInteger(attempt)||Number(attempt)<0||Number(attempt)>2147483647)throw corrupt()
 if((state==='failed'||state==='unknown')&&!failure||state.startsWith('installed-')&&failure!==undefined||state==='preparing'&&failure!==undefined)throw corrupt()
 if(state==='installed-active'&&(observation?.status!=='active'||!observationMatches(preview,observation)))throw corrupt()
 if(state==='installed-restart-required'&&(observation?.status!=='restart-required'||!observationMatches(preview,observation)))throw corrupt()
 if(state==='installed-pending-enable'&&(observation?.status!=='pending-enable'||!observationMatches(preview,observation)))throw corrupt()
 return {id:row.id,ownerId,preview,state,attempt:Number(attempt),...(receipt?{receipt}:{}),...(observation?{observation}:{}),...(failure?{failure}:{}),createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)}
}

export async function initializePluginInstallations(pool:Pool):Promise<void>{
 await pool.query(`
  create table if not exists teloa_plugin_installations(
   id uuid primary key,
   owner_id text not null,
   package_name text not null,
   preview jsonb not null check(jsonb_typeof(preview)='object'),
   preview_hash text not null check(preview_hash ~ '^[a-f0-9]{64}$'),
   state text not null check(state in ('preparing','installed-pending-enable','installed-active','installed-restart-required','failed','unknown')),
   attempt integer not null check(attempt>=0),
   last_receipt jsonb,
   last_observation jsonb,
   failure jsonb,
   created_at timestamptz not null,
   updated_at timestamptz not null,
   unique(owner_id,package_name)
  );
  create table if not exists teloa_plugin_install_requests(
   owner_id text not null,
   request_id uuid not null,
   request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
   spec_hash text not null check(spec_hash ~ '^[a-f0-9]{64}$'),
   installation_id uuid not null references teloa_plugin_installations(id),
   created_at timestamptz not null,
   primary key(owner_id,request_id)
  );
  -- 内联 check 只在建表那一次生效：任何跑过一次初始化的库里，约束仍是加 installed-pending-enable
  -- 之前的旧枚举，插件落到待启用状态时 insert 会违反约束并被事务包装成"存储不可用"。
  -- 与行业插件表同一写法：先 drop 再 add，幂等，存量库重跑初始化即完成迁移。
  alter table teloa_plugin_installations drop constraint if exists teloa_plugin_installations_state_check;
  alter table teloa_plugin_installations add constraint teloa_plugin_installations_state_check
   check(state in ('preparing','installed-pending-enable','installed-active','installed-restart-required','failed','unknown'));
 `)
}

/**
 * 可以重新走一次安装流程的既有记录：安装失败，或"已安装 · 待启用"但回执从未确认成功
 * （被中断的安装 reconcile 之后正是落在这里——它不是正常待启用，出路是重装而不是启用）。
 * 已确认成功待启用的记录不在此列：那条路只能走启用，不能重装。
 *
 * 注意这对请求重放的含义：重放同一个 requestId 命中一条落在此列的记录时，不是回放上一次结果，
 * 而是把它重置回 preparing 去触发新一次安装尝试——被中断的安装本来就只能靠重装收尾。
 */
function resettableForReinstall(installation:PluginInstallation):boolean{
 return installation.state==='failed'||(installation.state==='installed-pending-enable'&&installation.receipt?.outcome!=='succeeded')
}

function observationMatches(preview:MarketPluginInstallPreview,observation:MarketPluginInstallObservation):boolean{
 return (observation.status==='active'||observation.status==='restart-required'||observation.status==='pending-enable')&&same(observation.source,preview.source)&&observation.bundleHash===preview.bundleHash&&sameMarketPluginPermissions(observation.permissionSummary,preview.permissionSummary)
}

function mismatchFailure():MarketPluginInstallFailure{return {code:'observation-mismatch',message:'DSH 原生观察与安装前固定的包、版本、摘要或权限不一致。',retryable:true}}
function failureMessage(value:unknown,fallback:string):string{if(typeof value!=='string')return fallback;const fixed=value.trim().slice(0,1000);return fixed||fallback}
function unavailableFailure(message?:unknown):MarketPluginInstallFailure{return {code:'observation-unavailable',message:failureMessage(message,'DSH 原生安装结果暂时无法确认。'),retryable:true}}
function unknownInstallFailure(message?:unknown):MarketPluginInstallFailure{return {code:'install-unknown',message:failureMessage(message,'DSH 原生安装命令结果未知。'),retryable:true}}

export class PluginInstallationService{
 private readonly pool:Pool
 private readonly identity:{id:()=>string;now:()=>string}
 private readonly port:PluginInstallPort
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},port:PluginInstallPort){this.pool=pool;this.identity=identity;this.port=port}

 private authorize(ownerId:string):void{if(!owner(ownerId))throw new WorkError('teloa/forbidden','需要有效的本人身份。')}

 private async tx<T>(operation:(db:PoolClient)=>Promise<T>):Promise<T>{
  let db:PoolClient
  try{db=await this.pool.connect()}catch{throw new WorkError('teloa/storage-unavailable','DSH 扩展安装存储当前不可连接。')}
  try{await db.query('begin');const result=await operation(db);await db.query('commit');return result}
  catch(error){await db.query('rollback').catch(()=>{});if(error instanceof WorkError)throw error;throw new WorkError('teloa/storage-unavailable','DSH 扩展安装存储操作未完成。')}
  finally{db.release()}
 }

 private async find(db:PoolClient,ownerId:string,installationId:string,lock=''):Promise<PluginInstallation>{
  const row=(await db.query(`select * from teloa_plugin_installations where id=$1 ${lock}`,[installationId])).rows[0] as Record<string,unknown>|undefined
  if(!row||row.owner_id!==ownerId)throw new WorkError('teloa/forbidden','DSH 扩展安装不存在或不属于当前本人。')
  return readStoredPluginInstallation(row,ownerId)
 }

 private async freshPreview(source:MarketPluginRegistrySource):Promise<MarketPluginInstallPreview>{
  let value:unknown
  try{value=await this.port.preview(source)}catch{throw new WorkError('teloa/source-unavailable','DSH 扩展固定 registry 来源当前不可核对。')}
  let preview:MarketPluginInstallPreview
  try{preview=readMarketPluginInstallPreview(value)}catch{throw new WorkError('teloa/source-unavailable','DSH 扩展 registry 返回了不可信的预览。')}
  if(!same(preview.source,source))throw new WorkError('teloa/source-unavailable','DSH 扩展 registry 解析出的包身份或版本已变化。')
  return preview
 }

 async preview(ownerId:string,value:unknown):Promise<MarketPluginInstallPreview>{
  this.authorize(ownerId)
  const row=exact(value,['source'])
  let source:MarketPluginRegistrySource
  try{source=readMarketPluginRegistrySource(row.source)}catch{throw invalid()}
  return this.freshPreview(source)
 }

 /** 按包名找本人的安装记录；启用路径用它替代 prepare。 */
 private async byPackage(ownerId:string,packageName:string):Promise<PluginInstallation|undefined>{
  let row:Record<string,unknown>|undefined
  try{row=(await this.pool.query('select * from teloa_plugin_installations where owner_id=$1 and package_name=$2',[ownerId,packageName])).rows[0] as Record<string,unknown>|undefined}catch{throw new WorkError('teloa/storage-unavailable','DSH 扩展安装记录当前不可读取。')}
  return row?readStoredPluginInstallation(row,ownerId):undefined
 }

 private async knownRequest(ownerId:string,spec:MarketPluginInstallSpec):Promise<Record<string,unknown>|undefined>{
  let row:Record<string,unknown>|undefined
  try{row=(await this.pool.query('select * from teloa_plugin_install_requests where owner_id=$1 and request_id=$2',[ownerId,spec.requestId])).rows[0] as Record<string,unknown>|undefined}catch{throw new WorkError('teloa/storage-unavailable','DSH 扩展安装请求当前不可读取。')}
  if(!row)return undefined
  const saved=storedSpec(row.request_spec)
  if(!hex(row.spec_hash)||row.spec_hash!==sha(saved))throw corrupt()
  if(!sameSpec(saved,spec))throw new WorkError('teloa/conflict','同一请求 ID 不能安装另一份 DSH 扩展规格。')
  return row
 }

 private async prepare(ownerId:string,spec:MarketPluginInstallSpec):Promise<PluginInstallation>{
  return this.tx(async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[packageLock(ownerId,spec.preview.source.packageName)])
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[stable(['plugin-install-request',ownerId,spec.requestId])])
   const request=(await db.query('select * from teloa_plugin_install_requests where owner_id=$1 and request_id=$2',[ownerId,spec.requestId])).rows[0] as Record<string,unknown>|undefined
   if(request){
    const saved=storedSpec(request.request_spec)
    if(!hex(request.spec_hash)||request.spec_hash!==sha(saved))throw corrupt()
    if(!sameSpec(saved,spec))throw new WorkError('teloa/conflict','同一请求 ID 不能安装另一份 DSH 扩展规格。')
    if(!uuid(request.installation_id))throw corrupt()
    const current=await this.find(db,ownerId,request.installation_id,'for update')
    if(!samePreview(current.preview,spec.preview))throw corrupt()
    if(resettableForReinstall(current))return this.update(db,current,{state:'preparing',failure:null,observation:null})
    return current
   }
   const existingRow=(await db.query('select * from teloa_plugin_installations where owner_id=$1 and package_name=$2 for update',[ownerId,spec.preview.source.packageName])).rows[0] as Record<string,unknown>|undefined
   let installation:PluginInstallation
   if(existingRow){
    installation=readStoredPluginInstallation(existingRow,ownerId)
    if(!samePreview(installation.preview,spec.preview))throw new WorkError('teloa/conflict','此 DSH 扩展包已有不同来源、版本、信任摘要或权限摘要，需使用独立升级流程。')
    if(resettableForReinstall(installation))installation=await this.update(db,installation,{state:'preparing',failure:null,observation:null})
   }else{
    const id=this.identity.id(),at=this.identity.now()
    if(!uuid(id)||!Number.isFinite(Date.parse(at)))throw invalid()
    const inserted=(await db.query("insert into teloa_plugin_installations(id,owner_id,package_name,preview,preview_hash,state,attempt,created_at,updated_at) values($1,$2,$3,$4,$5,'preparing',0,$6,$6) returning *",[id,ownerId,spec.preview.source.packageName,JSON.stringify(spec.preview),sha(spec.preview),at])).rows[0] as Record<string,unknown>
    installation=readStoredPluginInstallation(inserted,ownerId)
   }
   await db.query('insert into teloa_plugin_install_requests(owner_id,request_id,request_spec,spec_hash,installation_id,created_at) values($1,$2,$3,$4,$5,$6)',[ownerId,spec.requestId,JSON.stringify(spec),sha(spec),installation.id,this.identity.now()])
   return installation
  })
 }

 private async update(db:PoolClient,current:PluginInstallation,change:{state:MarketPluginInstallationState;attempt?:number;receipt?:MarketPluginInstallReceipt|null;observation?:MarketPluginInstallObservation|null;failure?:MarketPluginInstallFailure|null}):Promise<PluginInstallation>{
  const receipt=change.receipt===undefined?current.receipt??null:change.receipt
  const observation=change.observation===undefined?current.observation??null:change.observation
  const failure=change.failure===undefined?current.failure??null:change.failure
  const row=(await db.query('update teloa_plugin_installations set state=$3,attempt=$4,last_receipt=$5,last_observation=$6,failure=$7,updated_at=$8 where id=$1 and owner_id=$2 returning *',[current.id,current.ownerId,change.state,change.attempt??current.attempt,receipt?JSON.stringify(receipt):null,observation?JSON.stringify(observation):null,failure?JSON.stringify(failure):null,this.identity.now()])).rows[0] as Record<string,unknown>|undefined
  if(!row)throw corrupt()
  return readStoredPluginInstallation(row,current.ownerId)
 }

 private async observe(source:MarketPluginRegistrySource):Promise<MarketPluginInstallObservation>{
  try{return readMarketPluginInstallObservation(await this.port.observe(source))}
  catch(error){return {schema:'teloa.market-plugin-install-observation/v1',status:'unknown',failure:unavailableFailure(error instanceof Error&&error.message?error.message:undefined)}}
 }

 private async applyObservation(db:PoolClient,current:PluginInstallation,observation:MarketPluginInstallObservation,receipt?:MarketPluginInstallReceipt,attempt=current.attempt):Promise<PluginInstallation>{
  const receiptChange=receipt===undefined?{}:{receipt}
  if(observation.status==='active'||observation.status==='restart-required'||observation.status==='pending-enable'){
   if(!observationMatches(current.preview,observation))return this.update(db,current,{state:'failed',attempt,...receiptChange,observation,failure:mismatchFailure()})
   // 状态直接由"包是否在 dsh.profile.bundles 里"给出：pending-enable 表示装好了但还没进组合。
   const state=observation.status==='active'?'installed-active':observation.status==='pending-enable'?'installed-pending-enable':'installed-restart-required'
   return this.update(db,current,{state,attempt,...receiptChange,observation,failure:null})
  }
  if(!('failure' in observation))throw corrupt()
  if(observation.status==='absent')return this.update(db,current,{state:'failed',attempt,...receiptChange,observation,failure:observation.failure})
  return this.update(db,current,{state:'unknown',attempt,...receiptChange,observation,failure:observation.failure})
 }

 private async run(ownerId:string,prepared:PluginInstallation,enable=false):Promise<PluginInstallation>{
  return this.tx(async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[effectLock(ownerId,prepared.preview.source.packageName)])
   const current=await this.find(db,ownerId,prepared.id,'for update')
   if(enable){
    // 安装只把包装进 profile 而不进 bundles；启用是本人的第二次显式动作。
    if(!current.state.startsWith('installed-'))throw new WorkError('teloa/conflict','只有已安装的 DSH 扩展可以启用。')
    // 超时/中止等留下 unknown 回执的安装不可放行启用：上一次安装没有完整核对过。
    if(current.receipt?.outcome!=='succeeded')throw new WorkError('teloa/conflict','上次安装未完整核对，请重新安装后再启用。')
    // 端口先核对磁盘补丁摘要与固定预览是否一致，不一致就不加回 bundles，插件保持待启用。
    try{await this.port.enable(current.preview)}
    catch(error){
     // 端口侧没有待启用记录：这个包要么没走过安装路径，要么已经启用过一次。都不是"放行一次待启用"。
     if(error instanceof Error&&error.message==='enable-not-pending')throw new WorkError('teloa/not-found','未找到该 DSH 扩展的待启用记录，无法启用。')
     if(error instanceof Error&&error.message==='enable-verification-failed')throw new WorkError('teloa/conflict','DSH 扩展当前的组合补丁与安装时固定的摘要不一致，已保持待启用。')
     throw new WorkError('teloa/dependency-unavailable','DSH 扩展启用未完成。')
    }
    return this.applyObservation(db,current,await this.observe(current.preview.source))
   }
   if(current.state==='installed-active'||current.state==='installed-restart-required')return current
   if(current.state==='unknown')return this.applyObservation(db,current,await this.observe(current.preview.source))
   if(current.state!=='preparing')return current
   const fresh=await this.freshPreview(current.preview.source)
   if(!samePreview(fresh,current.preview))throw new WorkError('teloa/source-unavailable','DSH 扩展来源、信任、bundle 摘要或权限摘要已变化。')
   let receipt:MarketPluginInstallReceipt
   try{receipt=readMarketPluginInstallReceipt(await this.port.install(current.preview))}
   catch(error){receipt={schema:'teloa.market-plugin-install-receipt/v1',outcome:'unknown',failure:unknownInstallFailure(error instanceof Error&&error.message?error.message:undefined)}}
   const attempt=current.attempt+1
   if(receipt.outcome==='failed')return this.update(db,current,{state:'failed',attempt,receipt,observation:null,failure:receipt.failure})
   if(receipt.outcome==='unknown')return this.update(db,current,{state:'unknown',attempt,receipt,observation:null,failure:receipt.failure})
   return this.applyObservation(db,current,await this.observe(current.preview.source),receipt,attempt)
  })
 }

 async install(ownerId:string,value:unknown):Promise<PluginInstallation>{
  this.authorize(ownerId)
  let spec:MarketPluginInstallSpec
  try{spec=readMarketPluginInstallSpec(value)}catch{throw invalid()}
  // 启用不是安装：它作用在既有记录上，不经 prepare、不消耗 requestId，也不再向 registry 取一次预览。
  if(spec.action==='enable'){
   const existing=await this.byPackage(ownerId,spec.preview.source.packageName)
   if(!existing||!samePreview(existing.preview,spec.preview))throw new WorkError('teloa/not-found','未找到与该固定预览匹配的 DSH 扩展安装记录。')
   // 纵深：安装路径在落记录之前就拒绝 rejected，因此构造不出这样的存量记录；
   // 但"能不能启用"这道闸不该依赖另一条路径的前置条件，信任结论在这里再判一次。
   if(existing.preview.trust.status==='rejected')throw new WorkError('teloa/forbidden','此 DSH 扩展的组合补丁会改动部署安全配置或插入原生命令行，已拒绝启用。')
   return this.run(ownerId,existing,true)
  }
  const known=await this.knownRequest(ownerId,spec)
  if(!known){
   const fresh=await this.freshPreview(spec.preview.source)
   if(!samePreview(fresh,spec.preview))throw new WorkError('teloa/source-unavailable','DSH 扩展来源、信任、bundle 摘要或权限摘要已变化，请重新预览。')
   // 信任结论由组合补丁的逐行核验得出：命中拒绝清单（遥测、沙箱、审批、权限预设、工具呈现、
   // 原生命令行或 Teloa 自有行）即在落任何记录之前拒绝，文案固定且不回显补丁内容。
   if(fresh.trust.status==='rejected')throw new WorkError('teloa/forbidden','此 DSH 扩展的组合补丁会改动部署安全配置或插入原生命令行，已拒绝安装。')
  }
  return this.run(ownerId,await this.prepare(ownerId,spec))
 }

 async reconcile(ownerId:string,value:unknown):Promise<PluginInstallation>{
  this.authorize(ownerId)
  const row=exact(value,['installationId'])
  if(!uuid(row.installationId))throw invalid()
  return this.tx(async db=>{
   const initial=await this.find(db,ownerId,row.installationId as string)
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[effectLock(ownerId,initial.preview.source.packageName)])
   const current=await this.find(db,ownerId,initial.id,'for update')
   return this.applyObservation(db,current,await this.observe(current.preview.source))
  })
 }

 async get(ownerId:string,value:unknown):Promise<PluginInstallation>{
  this.authorize(ownerId)
  const row=exact(value,['installationId'])
  if(!uuid(row.installationId))throw invalid()
  return this.tx(db=>this.find(db,ownerId,row.installationId as string))
 }

 async list(ownerId:string,value:unknown):Promise<{items:PluginInstallation[]}>{
  this.authorize(ownerId);exact(value,[])
  return this.tx(async db=>({items:(await db.query('select * from teloa_plugin_installations where owner_id=$1 order by created_at,id',[ownerId])).rows.map(row=>readStoredPluginInstallation(row,ownerId))}))
 }

 /**
  * 启动期核对目标：停在准备中或结果未知的安装记录。上限 50 条。
  * 安装写序是"先写待启用记录、再跑 dsh plugin add"，进程被杀之后
  * 磁盘上一定是三道钉认得出的样子（不会装错），但数据库里的事务回滚了，记录停在 preparing——
  * 界面因此永远显示"准备中"而不说话。这个读口就是给启动核对用的。
  */
 async outstanding(ownerId:string):Promise<string[]>{
  this.authorize(ownerId)
  const rows=await this.pool.query("select id from teloa_plugin_installations where owner_id=$1 and state in ('preparing','unknown') order by created_at,id limit 50",[ownerId])
  if(rows.rows.some(row=>!uuid(row.id)))throw new WorkError('teloa/storage-corrupt','待核对 DSH 扩展安装身份损坏。')
  return rows.rows.map(row=>String(row.id))
 }
}
