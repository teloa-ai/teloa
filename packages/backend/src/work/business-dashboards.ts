import type {Pool,PoolClient} from 'pg'
import {
 WorkError,businessScopeKeyRule,businessTimeRanges,isBusinessScopeKey,nextBusinessSyncOccurrence,taskInput,
 type BusinessDashboardDefinition,type BusinessDashboardPage,type BusinessDashboardSummary,type BusinessTimeRange,type BusinessWidgetDefinition,type BusinessWidgetResult,
} from '@teloa/contract'
import type {BusinessDefinitionBundle,BusinessDefinitionSourceReader} from './business-definition-source.ts'
import type {BusinessSyncTrigger} from './business-sync.ts'
import {businessDashboardMigrationLock,businessWidgetDefinitionHash,businessWidgetResultOf,type BusinessWidgetComputeContext,type BusinessWidgetService} from './business-widgets.ts'
import {assertScheduledSync,lockBusinessRuntime,scheduledSyncAllowed} from './business-runtime.ts'

export type BusinessDashboardActor={ownerId:string;scopeIds:string[]}

const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const localId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const invalid=(message:string)=>new WorkError('teloa/invalid-input',message)
const forbidden=()=>new WorkError('teloa/forbidden','当前主体未获准读取此业务范围。')
const notFound=()=>new WorkError('teloa/not-found','看板不存在。')
const epoch='1970-01-01T00:00:00.000Z'
/** 刷新请求记录只为幂等重放而留：超过这些天的清掉（每次刷新顺带清至多 100 行）。 */
const requestRetentionDays=90
/** 刷新锁第二键的前缀：与同步锁 `scope‖\u001f‖mappingId` 区分，映射与看板同名也不会撞键。 */
const lockKey=(scope:string,dashboardId:string)=>'dashboard\u001f'+scope+'\u001f'+dashboardId
/** 刷新记录里的一批：一期记录没有 timeRange（读回时按 all）。 */
type Batch=Array<{widgetId:string;computedAt:string;timeRange?:BusinessTimeRange}>

/**
 * 在 `initializeBusinessWidgets` 之后调用。刷新记录表照一期形状建；两表的整页时间范围列是一次性迁移
 *（照 `teloa_skill_selection_migrations` 形状：事务 + 咨询锁 + 迁移表 + 标记首次插入成功才执行）：
 * `time_range text not null default 'all'`（check 为五个键）、结果表主键换成含 `time_range` 的六列。一期旧行落 `all`，语义正确（一期没有范围）。
 */
export async function initializeBusinessDashboards(pool:Pool):Promise<void>{
 const ranges=businessTimeRanges.map(range=>`'${range}'`).join(',')
 const db=await pool.connect()
 try{
  await db.query('begin')
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[businessDashboardMigrationLock])
  await db.query(`
   create table if not exists teloa_business_dashboard_refreshes (
     owner_id text not null, request_id text not null, scope_id text not null, dashboard_id text not null,
     results jsonb not null, created_at timestamptz not null default now(),
     primary key(owner_id,request_id)
   );
   create table if not exists teloa_business_dashboard_migrations(name text primary key,applied_at timestamptz not null);
  `)
  const first=await db.query("insert into teloa_business_dashboard_migrations(name,applied_at) values('widget-results-time-range-v1',clock_timestamp()) on conflict(name) do nothing returning name")
  if(first.rowCount===1)await db.query(`
   alter table teloa_business_widget_results add column time_range text not null default 'all' check(time_range in (${ranges}));
   alter table teloa_business_widget_results drop constraint teloa_business_widget_results_pkey, add primary key(owner_id,scope_id,dashboard_id,widget_id,time_range,computed_at);
   alter table teloa_business_dashboard_refreshes add column time_range text not null default 'all' check(time_range in (${ranges}));
  `)
  await db.query('commit')
 }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
}

function actorOf(actor:BusinessDashboardActor):void{
 if(!text(actor?.ownerId,128)||!Array.isArray(actor.scopeIds)||!actor.scopeIds.length||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(scope=>!text(scope,120)))throw new WorkError('teloa/forbidden','需要有效的看板读取主体。')
}
function scopeOf(actor:BusinessDashboardActor,value:unknown):string{
 if(!isBusinessScopeKey(value)||value==='general')throw invalid(businessScopeKeyRule+'，general 一律拒绝。')
 if(!actor.scopeIds.includes(value))throw forbidden()
 return value
}

type Located={dashboard:BusinessDashboardDefinition;widgets:BusinessWidgetDefinition[];bundles:BusinessDefinitionBundle[]}
/** 请求里的时间范围：缺省即未指定；给了就必须是平台枚举键（进服务端的只有这五个字面量）。 */
function requestedRange(value:unknown):BusinessTimeRange|undefined{
 if(value===undefined)return undefined
 if(!(businessTimeRanges as readonly unknown[]).includes(value))throw invalid('时间范围不合法，允许：'+businessTimeRanges.join(' / ')+'。')
 return value as BusinessTimeRange
}
/** 本次所按的范围：看板无 filters 只能不指定（按 all）；有 filters 时取值须在 options 内，缺省为 default。 */
function selectedRange(dashboard:BusinessDashboardDefinition,requested:BusinessTimeRange|undefined):BusinessTimeRange{
 const filters=dashboard.filters?.timeRange
 if(requested===undefined)return filters?.default??'all'
 if(!filters)throw invalid('看板没有声明时间范围，不能按时间范围读取或刷新。')
 if(!filters.options.includes(requested))throw invalid('所选时间范围不在看板提供的选项里。')
 return requested
}
/** 每个组件在所选范围下用哪份结果（二期规格 §3.3）：看板有 filters 且组件接入 → 所选范围；否则 → all。 */
const widgetRange=(dashboard:BusinessDashboardDefinition,widget:BusinessWidgetDefinition,selected:BusinessTimeRange):BusinessTimeRange=>dashboard.filters&&widget.timeFilter?selected:'all'
const rangesOf=(located:Located,selected:BusinessTimeRange)=>new Map(located.widgets.map(widget=>[widget.id,widgetRange(located.dashboard,widget,selected)]))
/** 默认视图下的所选范围：看板默认范围，无 filters 即 all。定时刷新、到期判定与列表的 updatedAt 都按它。 */
const defaultRange=(dashboard:BusinessDashboardDefinition):BusinessTimeRange=>dashboard.filters?.timeRange.default??'all'
/** 一期留下的刷新记录：批次项不带 timeRange（记录的 time_range 由迁移默认值补成 all）。 */
const legacyBatch=(batch:Batch)=>batch.length>0&&batch.every(item=>item.timeRange===undefined)
/** 最新结果按 (看板, 组件, 范围) 取时刻，键里用 \u001f 分隔。 */
const stampKey=(dashboardId:string,widgetId:string,range:string)=>dashboardId+'\u001f'+widgetId+'\u001f'+range
/** 看板与组件都按**范围**找（组件跨加载落点不影响看板引用，见 `business-definition-source.ts` 合并处的说明）。 */
function locate(bundles:BusinessDefinitionBundle[],dashboardId:string):Located{
 const dashboard=bundles.flatMap(bundle=>bundle.dashboards).find(record=>record.definition.id===dashboardId)?.definition
 if(!dashboard)throw notFound()
 const all=new Map(bundles.flatMap(bundle=>bundle.widgets).map(record=>[record.definition.id,record.definition]))
 const widgets=dashboard.widgets.map(id=>{
  const found=all.get(id)
  if(!found)throw new WorkError('teloa/source-unavailable','看板引用的组件 '+id+' 不在本业务范围内。')
  return found
 })
 return {dashboard,widgets,bundles}
}

/**
 * 看板服务（规格 §4.4）：读只读快照、不现算；刷新同看板同时只一次（事务级 advisory 锁，取不到即冲突，不排队），
 * 逐组件算完落库；同一 requestId 重放返回首次那一批结果，不重算。
 */
export class BusinessDashboardService{
 private readonly pool:Pool
 private readonly identity:{id:()=>string;now:()=>string}
 private readonly definitions:Pick<BusinessDefinitionSourceReader,'forScope'>
 private readonly widgets:Pick<BusinessWidgetService,'compute'|'persist'|'latest'>
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},definitions:Pick<BusinessDefinitionSourceReader,'forScope'>,widgets:Pick<BusinessWidgetService,'compute'|'persist'|'latest'>){
  this.pool=pool;this.identity=identity;this.definitions=definitions;this.widgets=widgets
 }

 async list(actor:BusinessDashboardActor,input:unknown):Promise<BusinessDashboardSummary[]>{
  actorOf(actor)
  const scope=scopeOf(actor,taskInput(input,['scope']).scope)
  return this.readOnly(async db=>{
   const bundles=await this.definitions.forScope(db,actor.ownerId,scope)
   const dashboards=bundles.flatMap(bundle=>bundle.dashboards).map(record=>record.definition)
   const latest=await this.latestStamps(db,actor.ownerId,scope)
   // updatedAt 只看默认视图下各组件应有的那一份：按需算出的其他范围结果不让摘要变新（与 due() 同一口径）。
   return dashboards.map(dashboard=>{
    const {widgets}=locate(bundles,dashboard.id),selected=defaultRange(dashboard)
    const stamps=widgets.flatMap(widget=>latest.get(stampKey(dashboard.id,widget.id,widgetRange(dashboard,widget,selected)))??[])
    return {id:dashboard.id,title:dashboard.title,...(dashboard.localized?{localized:dashboard.localized}:{}),widgets:dashboard.widgets.length,updatedAt:stamps.length?stamps.reduce((a,b)=>a>b?a:b):null}
   })
  })
 }

 /**
  * 只读快照：不触发任何计算。没有结果的组件回 `status:'failed'`、reason「尚未计算」（界面文案由客户端按码映射）。
  * `timeRange` 可选：接入组件读所选范围那一份，该范围没算过即缺席（界面据此按需发一次带该范围的刷新）。
  */
 async read(actor:BusinessDashboardActor,input:unknown):Promise<BusinessDashboardPage>{
  actorOf(actor)
  const row=taskInput(input,['scope','dashboardId','timeRange'])
  const scope=scopeOf(actor,row.scope),dashboardId=dashboardIdOf(row.dashboardId),requested=requestedRange(row.timeRange)
  return this.readOnly(async db=>{
   const located=locate(await this.definitions.forScope(db,actor.ownerId,scope),dashboardId)
   const selected=selectedRange(located.dashboard,requested)
   const results=await this.widgets.latest(db,actor.ownerId,scope,dashboardId,rangesOf(located,selected))
   return this.page(db,actor.ownerId,scope,located,results,selected)
  })
 }

 /**
  * 刷新：事务首句取 `pg_try_advisory_xact_lock(hashtext(owner),hashtext('dashboard‖scope‖dashboardId'))`，取不到即 `teloa/conflict`；
  * 已有同 requestId 的记录则按记录读回那一批结果；否则逐组件 compute + persist，记下这一批，返回刷新后的页面。
  * `options` 只给服务端调用方（调度器）：触发方式与只刷部分组件（组件级 refresh 覆盖到期时）。
  * `timeRange` 可选（缺省 = 看板默认范围或 all）：接入组件按所选范围算、未接入组件按 all 算；调度器不带它，因此定时刷新只算默认范围。
  * 同一 requestId 重放带了另一个范围 → `teloa/conflict`。
  */
 async refresh(actor:BusinessDashboardActor,input:unknown,signal?:AbortSignal,options:{trigger?:BusinessSyncTrigger;widgetIds?:string[]}={}):Promise<BusinessDashboardPage>{
  actorOf(actor)
  const row=taskInput(input,['requestId','scope','dashboardId','timeRange'])
  if(!uuid(row.requestId))throw invalid('刷新请求标识不合法。')
  const scope=scopeOf(actor,row.scope),dashboardId=dashboardIdOf(row.dashboardId),owner=actor.ownerId,requestId=row.requestId,requested=requestedRange(row.timeRange)
  signal?.throwIfAborted()
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   if((await db.query('select pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) as locked',[owner,lockKey(scope,dashboardId)])).rows[0].locked!==true)throw new WorkError('teloa/conflict','看板正在刷新')
   const located=locate(await this.definitions.forScope(db,owner,scope),dashboardId)
   const selected=selectedRange(located.dashboard,requested)
   const recorded=(await db.query('select scope_id,dashboard_id,results,time_range from teloa_business_dashboard_refreshes where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0] as {scope_id:string;dashboard_id:string;results:Batch;time_range:string}|undefined
   let page:BusinessDashboardPage
   if(recorded){
    if(recorded.scope_id!==scope||recorded.dashboard_id!==dashboardId)throw new WorkError('teloa/conflict','同一刷新请求标识已用于另一个看板。')
    // 不带范围的重放即「按默认范围」：一期记录（批次不带范围）当年就是默认视图，按默认范围回放，不报冲突。
    if(recorded.time_range!==selected&&!(requested===undefined&&legacyBatch(recorded.results)))throw new WorkError('teloa/conflict','同一刷新请求标识已用于另一个时间范围。')
    page=await this.page(db,owner,scope,located,await this.resultsAt(db,owner,scope,located,selected,recorded.results),selected)
   }else{
    // 到期枚举不授予执行：暂停与实际定时刷新共享运行锁，暂停返回后旧任务不能再开始计算。
    if(options.trigger==='schedule'){
     await lockBusinessRuntime(db,owner,scope,'shared')
     await assertScheduledSync(db,owner,scope)
    }
    let targets=options.widgetIds===undefined?located.widgets:located.widgets.filter(widget=>options.widgetIds!.includes(widget.id))
    // 非默认范围的按需刷新：未接入组件的结果不随范围变，已有 all 结果即直接复用、不重算；还没有才补算一次。
    if(located.dashboard.filters&&selected!==defaultRange(located.dashboard)){
     const reusable=await this.widgets.latest(db,owner,scope,dashboardId,new Map(targets.filter(widget=>!widget.timeFilter).map(widget=>[widget.id,'all'] as const)))
     targets=targets.filter(widget=>widget.timeFilter||!reusable.has(widget.id))
    }
    const ctx:BusinessWidgetComputeContext={
     ownerId:owner,scope,now:this.identity.now(),db,
     objectTypes:located.bundles.flatMap(bundle=>bundle.objectTypes).map(record=>record.definition),views:located.bundles.flatMap(bundle=>bundle.views),
    }
    const batch:Batch=[]
    for(const widget of targets){
     signal?.throwIfAborted()
     const timeRange=widgetRange(located.dashboard,widget,selected)
     const result=await this.widgets.compute(ctx,widget,undefined,signal,timeRange)
     await this.widgets.persist(db,owner,scope,dashboardId,result,options.trigger??'manual',timeRange)
     batch.push({widgetId:widget.id,computedAt:result.computedAt,timeRange})
    }
    await db.query('insert into teloa_business_dashboard_refreshes(owner_id,request_id,scope_id,dashboard_id,results,time_range) values($1,$2,$3,$4,$5,$6)',[owner,requestId,scope,dashboardId,JSON.stringify(batch),selected])
    await db.query(`delete from teloa_business_dashboard_refreshes where (owner_id,request_id) in (
      select owner_id,request_id from teloa_business_dashboard_refreshes where owner_id=$1 and created_at<now()-interval '${requestRetentionDays} days' limit 100)`,[owner])
    page=await this.page(db,owner,scope,located,await this.widgets.latest(db,owner,scope,dashboardId,rangesOf(located,selected)),selected,false)
   }
   await db.query('commit')
   return page
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 /**
  * 调度器用：逐组件按「组件自己的 refresh ?? 看板 refresh」与该组件**默认视图下应有那一份**（看板默认范围或 all）的最新结果时刻判到期；
  * 按需刷新算出的其他范围结果不推迟定时刷新。
  * 有任一沿用看板周期的组件到期 → 整个看板刷新（不带 widgetIds）；只有带覆盖周期的组件到期 → 只刷那几个。
  * 哪些范围有看板：一期看板只来自本地声明，取本地指针里 dashboard 所在范围，并上已有结果的范围；某个范围读不出只跳过它。
  */
 async due(ownerId:string,now:string):Promise<Array<{scope:string;dashboardId:string;widgetIds?:string[]}>>{
  if(!text(ownerId,128)||!Number.isFinite(Date.parse(now)))throw invalid('到期判定参数不合法。')
  const scopes=(await this.pool.query(`select scope_id from teloa_business_local_definition_heads where owner_id=$1 and kind='dashboard' and version is not null
    union select scope_id from teloa_business_widget_results where owner_id=$1 order by scope_id`,[ownerId])).rows.map(row=>String(row.scope_id))
  const due:Array<{scope:string;dashboardId:string;widgetIds?:string[]}>=[]
  for(const scope of scopes){
   try{
    await this.readOnly(async db=>{
     if(!await scheduledSyncAllowed(db,ownerId,scope))return
     const bundles=await this.definitions.forScope(db,ownerId,scope)
     const latest=await this.latestStamps(db,ownerId,scope)
     for(const record of bundles.flatMap(bundle=>bundle.dashboards)){
      const {dashboard,widgets}=locate(bundles,record.definition.id)
      const selected=defaultRange(dashboard)
      const expired=widgets.filter(widget=>nextBusinessSyncOccurrence(widget.refresh??dashboard.refresh,latest.get(stampKey(dashboard.id,widget.id,widgetRange(dashboard,widget,selected)))??epoch)<=now)
      if(!expired.length)continue
      if(expired.some(widget=>widget.refresh===undefined))due.push({scope,dashboardId:dashboard.id})
      else due.push({scope,dashboardId:dashboard.id,widgetIds:expired.map(widget=>widget.id)})
     }
    })
   }catch(error){if(error instanceof WorkError)continue;throw error}
  }
  return due
 }

 private async page(db:PoolClient,owner:string,scope:string,located:Located,results:Map<string,BusinessWidgetResult>,selected:BusinessTimeRange,refreshing?:boolean):Promise<BusinessDashboardPage>{
  const {dashboard,widgets}=located
  const stamps=[...results.values()].map(result=>result.computedAt)
  const updatedAt=stamps.length?stamps.reduce((a,b)=>a>b?a:b):null
  const now=this.identity.now()
  return {
   schema:'teloa.business-dashboard-page/v1',scope,dashboard,widgets,
   results:widgets.map(widget=>{
    const hash=businessWidgetDefinitionHash(widget),found=results.get(widget.id)
    // 结果按当时的声明算出；声明摘要变了，这条结果就是过期的，界面据此提示「声明已更新，等待下次刷新」。
    if(found)return {...found,stale:found.definitionHash!==hash}
    return {widgetId:widget.id,definitionHash:hash,computedAt:now,status:'failed',columns:[],rows:[],rowCount:0,truncated:false,bytes:0,error:{code:'teloa/not-found',reason:'尚未计算'},stale:false}
   }),
   updatedAt,
   nextRefreshAt:updatedAt===null?null:nextBusinessSyncOccurrence(dashboard.refresh,updatedAt),
   refreshing:refreshing??await this.refreshing(db,owner,scope,dashboard.id),
   timeRange:dashboard.filters?{selected,options:[...dashboard.filters.timeRange.options]}:null,
  }
 }

 /** 是否有别的会话正持有这张看板的刷新锁：查 pg_locks，不自己去取锁（取锁会让并发的真实刷新误报冲突）。 */
 private async refreshing(db:PoolClient,owner:string,scope:string,dashboardId:string):Promise<boolean>{
  return (await db.query(`select exists(select 1 from pg_locks where locktype='advisory' and database=(select oid from pg_database where datname=current_database())
    and classid=hashtext($1)::oid and objid=hashtext($2)::oid and objsubid=2 and granted) as held`,[owner,lockKey(scope,dashboardId)])).rows[0].held===true
 }

 /**
  * 按刷新记录里的 (组件, 时刻, 范围) 读回那一批结果（一期记录没有范围，按 all）。批次项的范围与该组件在所选视图下应有的范围不符的
  * （一期记录按默认范围回放时的接入组件）不冒充；这些、已被保留清理删掉的、以及本批没算的（复用 all 的未接入组件、组件级到期只刷的那几个之外）
  * 一律退回该组件在所选范围下最新一条，与首次回包同一口径。
  */
 private async resultsAt(db:PoolClient,owner:string,scope:string,located:Located,selected:BusinessTimeRange,batch:Batch):Promise<Map<string,BusinessWidgetResult>>{
  const dashboardId=located.dashboard.id,ranges=rangesOf(located,selected)
  const usable=batch.filter(item=>(item.timeRange??'all')===ranges.get(item.widgetId))
  const rows=(await db.query(`select r.* from teloa_business_widget_results r join jsonb_to_recordset($4::jsonb) as b("widgetId" text,"computedAt" timestamptz,"timeRange" text)
    on r.widget_id=b."widgetId" and r.computed_at=b."computedAt" and r.time_range=coalesce(b."timeRange",'all') where r.owner_id=$1 and r.scope_id=$2 and r.dashboard_id=$3`,[owner,scope,dashboardId,JSON.stringify(usable)])).rows as Array<Record<string,unknown>>
  const results=new Map(rows.map(row=>[String(row.widget_id),businessWidgetResultOf(row)]))
  const missing=new Map([...ranges].filter(([id])=>!results.has(id)))
  if(missing.size)for(const [id,result] of await this.widgets.latest(db,owner,scope,dashboardId,missing))results.set(id,result)
  return results
 }

 /** 本人本范围每个 (看板, 组件, 范围) 的最新结果时刻。 */
 private async latestStamps(db:PoolClient,owner:string,scope:string):Promise<Map<string,string>>{
  const rows=(await db.query(`select dashboard_id,widget_id,time_range,max(computed_at) as computed_at from teloa_business_widget_results where owner_id=$1 and scope_id=$2 group by dashboard_id,widget_id,time_range`,[owner,scope])).rows as Array<{dashboard_id:string;widget_id:string;time_range:string;computed_at:Date}>
  return new Map(rows.map(row=>[stampKey(row.dashboard_id,row.widget_id,row.time_range),row.computed_at.toISOString()]))
 }

 private async readOnly<T>(run:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect()
  try{await db.query('begin isolation level repeatable read read only');const result=await run(db);await db.query('commit');return result}
  catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
}

function dashboardIdOf(value:unknown):string{
 if(!localId(value))throw invalid('看板标识不合法。')
 return value
}
