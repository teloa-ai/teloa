import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {
 WorkError,businessDefinitionCanonicalBody,businessSyncTriggers,validateWidgetResultShape,
 type BusinessObjectTypeDefinition,type BusinessTimeRange,type BusinessViewRecord,type BusinessWidgetCell,type BusinessWidgetColumn,type BusinessWidgetDefinition,type BusinessWidgetResult,type WorkErrorCode,
} from '@teloa/contract'
import {rewriteBusinessWidgetSql,type BusinessSqlRewrite} from './business-sql-rewrite.ts'
import type {BusinessSqlExecutor} from './business-sql-executor.ts'
import type {BusinessLedgerService} from './business-view-compute.ts'
import type {BusinessSyncTrigger} from './business-sync.ts'

/**
 * 组件计算与结果快照（规格 §4.3/§6）：SQL 组件只经 `analyzeBusinessSql → rewriteBusinessSql → BusinessSqlExecutor.execute`，
 * 执行器只收改写产物（参数 $1=owner、$2=scope 由平台注入），因此结果里不会有其他本人或其他范围的数据；
 * view-ref 组件复用台账那一条计算路径再投影成行列。结果快照表同时承担查询审计（计划「审计由表承载」）。
 */

/** `db`：调用方已开事务的连接（看板刷新），给了就让 view-ref 在它上面算台账，不另借连接。 */
export type BusinessWidgetComputeContext={ownerId:string;scope:string;objectTypes:BusinessObjectTypeDefinition[];views:BusinessViewRecord[];now:string;db?:PoolClient}
/** compute 的产物：契约结果 + 本次是否在执行器里排过队（只落库作审计，不下发）。 */
export type BusinessWidgetComputed=BusinessWidgetResult&{throttled?:boolean}

/** 每个组件保留最近这么多条结果，另外超过 retentionDays 的也清；最新一条永远保留。 */
const keepPerWidget=30,retentionDays=90,pruneBatch=100
const reasonMax=2000
/** 组件声明摘要：规范化正文的 sha256——同一份声明必得同一个摘要，结果快照据此判「声明已变、结果过期」。 */
export function businessWidgetDefinitionHash(widget:BusinessWidgetDefinition):string{
 return createHash('sha256').update(businessDefinitionCanonicalBody(widget)).digest('hex')
}
const rowBytes=(rows:BusinessWidgetCell[][])=>rows.reduce((total,row)=>total+Buffer.byteLength(JSON.stringify(row)),0)
/** 错误原因进结果快照与界面：去掉控制字符（保留换行）并限长，与契约读取器同一口径。 */
const reasonOf=(message:string)=>(message.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,' ').trim()||'组件计算失败').slice(0,reasonMax)

/** 看板结果表建表与其一次性迁移共用的咨询锁键：多进程同时首启时建表与改表串行，不撞 pg_type 唯一键。 */
export const businessDashboardMigrationLock='teloa/business-dashboard-migrations'

/**
 * 建一期形状的结果表（持 `businessDashboardMigrationLock`）；`time_range` 列与含它的主键由 `initializeBusinessDashboards`
 * 的一次性迁移补上（新旧库同一条路径）。
 */
export async function initializeBusinessWidgets(pool:Pool):Promise<void>{
 const db=await pool.connect()
 try{
  await db.query('begin')
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[businessDashboardMigrationLock])
  await db.query(`create table if not exists teloa_business_widget_results (
   owner_id text not null, scope_id text not null, dashboard_id text not null, widget_id text not null,
   definition_hash text not null, computed_at timestamptz not null,
   status text not null check(status in ('ok','failed')),
   columns jsonb not null, rows jsonb not null, row_count integer not null check(row_count>=0), bytes integer not null check(bytes>=0),
   error_code text, error_reason text, throttled boolean not null default false,
   trigger text not null check(trigger in (${businessSyncTriggers.map(trigger=>`'${trigger}'`).join(',')})),
   check((status='ok')=(error_code is null)),
   primary key(owner_id,scope_id,dashboard_id,widget_id,computed_at)
  )`)
  await db.query('commit')
 }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
}

/** 结果快照表一行 → 契约结果；stale 由调用方按当前声明摘要判定，这里恒 false。 */
export function businessWidgetResultOf(row:Record<string,unknown>):BusinessWidgetResult{
 const status=row.status==='ok'?'ok':'failed'
 const rows=row.rows as BusinessWidgetCell[][]
 return {
  widgetId:String(row.widget_id),definitionHash:String(row.definition_hash),computedAt:(row.computed_at as Date).toISOString(),status,
  columns:row.columns as BusinessWidgetColumn[],rows,rowCount:rows.length,truncated:false,bytes:Number(row.bytes),
  ...(status==='failed'?{error:{code:String(row.error_code) as WorkErrorCode,reason:String(row.error_reason)}}:{}),stale:false,
 }
}

export class BusinessWidgetService{
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 private readonly executor:Pick<BusinessSqlExecutor,'execute'|'schema'>
 private readonly ledger:Pick<BusinessLedgerService,'computeInTransaction'>
 constructor(pool:Pool,identity:{now:()=>string},executor:Pick<BusinessSqlExecutor,'execute'|'schema'>,ledger:Pick<BusinessLedgerService,'computeInTransaction'>){
  this.pool=pool;this.identity=identity;this.executor=executor;this.ledger=ledger
 }

 /**
  * 一个组件算一次，不落库。任何业务错误（白名单拒绝、执行边界、形状不符、视图缺失）都收成 `status:'failed'`
  * 的结果——组件失败是要给人看的，不是要打断整个看板；只有中止信号与非 WorkError 的异常照抛。
  * rowLimit（预览用）只截返回的行，查询本身仍按完整执行边界跑：试算与真实刷新在同一处失败。
  * range：`all`（缺省）不注入；其他取值只对带 `timeFilter` 的 SQL 组件生效（区间交给改写器）。
  */
 async compute(ctx:BusinessWidgetComputeContext,widget:BusinessWidgetDefinition,rowLimit?:number,signal?:AbortSignal,range:BusinessTimeRange='all'):Promise<BusinessWidgetComputed>{
  const definitionHash=businessWidgetDefinitionHash(widget)
  const failed=(code:WorkErrorCode,reason:string,computedAt=this.identity.now()):BusinessWidgetComputed=>({
   widgetId:widget.id,definitionHash,computedAt,status:'failed',columns:[],rows:[],rowCount:0,truncated:false,bytes:0,error:{code,reason:reasonOf(reason)},stale:false,
  })
  let computed:{columns:BusinessWidgetColumn[];rows:BusinessWidgetCell[][];computedAt:string;throttled:boolean}
  try{
   signal?.throwIfAborted()
   computed=widget.kind==='view-ref'?await this.projectView(ctx,widget,signal):await this.runSql(ctx,widget,signal,range)
  }catch(error){
   if(signal?.aborted||!(error instanceof WorkError))throw error
   return failed(error.code,error.message)
  }
  const rows=rowLimit===undefined?computed.rows:computed.rows.slice(0,rowLimit)
  const result:BusinessWidgetComputed={
   widgetId:widget.id,definitionHash,computedAt:computed.computedAt,status:'ok',columns:computed.columns,rows,rowCount:rows.length,truncated:false,bytes:rowBytes(rows),stale:false,
   ...(computed.throttled?{throttled:true}:{}),
  }
  const shape=validateWidgetResultShape(widget,result)
  return shape===null?result:{...failed('teloa/invalid-input',shape,computed.computedAt),...(computed.throttled?{throttled:true}:{})}
 }

 /** 落库一条结果快照（成功或失败都记，失败时行为空），再顺带清理本组件同一范围下超出保留的旧结果（每次至多 100 行；各范围分开留）。 */
 async persist(db:PoolClient,ownerId:string,scope:string,dashboardId:string,result:BusinessWidgetComputed,trigger:BusinessSyncTrigger,timeRange:BusinessTimeRange='all'):Promise<void>{
  const failed=result.status==='failed'
  await db.query(`insert into teloa_business_widget_results(owner_id,scope_id,dashboard_id,widget_id,definition_hash,computed_at,status,columns,rows,row_count,bytes,error_code,error_reason,throttled,trigger,time_range)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    on conflict(owner_id,scope_id,dashboard_id,widget_id,time_range,computed_at) do update set definition_hash=excluded.definition_hash,status=excluded.status,columns=excluded.columns,rows=excluded.rows,
     row_count=excluded.row_count,bytes=excluded.bytes,error_code=excluded.error_code,error_reason=excluded.error_reason,throttled=excluded.throttled,trigger=excluded.trigger`,
  [ownerId,scope,dashboardId,result.widgetId,result.definitionHash,result.computedAt,result.status,JSON.stringify(failed?[]:result.columns),JSON.stringify(failed?[]:result.rows),
   failed?0:result.rowCount,failed?0:result.bytes,result.error?.code??null,result.error?.reason??null,result.throttled===true,trigger,timeRange])
  await db.query(`delete from teloa_business_widget_results where (owner_id,scope_id,dashboard_id,widget_id,time_range,computed_at) in (
    select owner_id,scope_id,dashboard_id,widget_id,time_range,computed_at from (
     select owner_id,scope_id,dashboard_id,widget_id,time_range,computed_at,row_number() over (order by computed_at desc) as rank
     from teloa_business_widget_results where owner_id=$1 and scope_id=$2 and dashboard_id=$3 and widget_id=$4 and time_range=$5
    ) ranked where rank>1 and (rank>${keepPerWidget} or computed_at<now()-interval '${retentionDays} days') limit ${pruneBatch})`,[ownerId,scope,dashboardId,result.widgetId,timeRange])
 }

 /** 每个组件在给定范围下最新的一条结果快照（成功或失败）；该范围下没有结果的组件不出现在返回里，不拿别的范围顶替。 */
 async latest(db:PoolClient,ownerId:string,scope:string,dashboardId:string,widgetRanges:Map<string,BusinessTimeRange>):Promise<Map<string,BusinessWidgetResult>>{
  const rows=(await db.query(`select distinct on (r.widget_id) r.* from teloa_business_widget_results r
    join unnest($4::text[],$5::text[]) as w(widget_id,time_range) on r.widget_id=w.widget_id and r.time_range=w.time_range
    where r.owner_id=$1 and r.scope_id=$2 and r.dashboard_id=$3 order by r.widget_id,r.computed_at desc`,[ownerId,scope,dashboardId,[...widgetRanges.keys()],[...widgetRanges.values()]])).rows as Array<Record<string,unknown>>
  return new Map(rows.map(row=>[String(row.widget_id),businessWidgetResultOf(row)]))
 }

 /**
  * SQL 组件只改写不执行：白名单分析 + 改写（含整页时间范围注入）+ 二次校验。刷新走它再交执行器；
  * 预览另按一个非 all 范围单调它一次，核对「接入了时间范围的组件确实读了那张表」（二期规格 §3.3）。
  */
 async rewrite(ctx:Pick<BusinessWidgetComputeContext,'ownerId'|'scope'|'objectTypes'>,widget:BusinessWidgetDefinition,range:BusinessTimeRange='all'):Promise<BusinessSqlRewrite>{
  return rewriteBusinessWidgetSql(ctx,widget,this.executor.schema,range)
 }

 private async runSql(ctx:BusinessWidgetComputeContext,widget:BusinessWidgetDefinition,signal:AbortSignal|undefined,range:BusinessTimeRange){
  const rewrite=await this.rewrite(ctx,widget,range)
  const executed=await this.executor.execute(ctx.ownerId+'\u001f'+ctx.scope,rewrite,signal)
  return {columns:executed.columns,rows:executed.rows,computedAt:executed.computedAt,throttled:executed.throttled}
 }

 /** view-ref：按台账那一条路径（同一只读可重复读事务）算出该视图，再投影成 `[dimension,label,<度量 id>…]`。 */
 private async projectView(ctx:BusinessWidgetComputeContext,widget:BusinessWidgetDefinition,signal?:AbortSignal){
  const view=ctx.views.find(record=>record.definition.id===widget.viewRef)
  if(!view)throw new WorkError('teloa/source-unavailable','组件引用的视图 '+widget.viewRef+' 不在本业务范围内。')
  const objectType=view.definition.objectType
  const actor={ownerId:ctx.ownerId,scopeIds:[ctx.scope]},input={scope:ctx.scope,objectType}
  let ledger
  // 调用方（看板刷新）已持有事务连接时就在它上面算，不再从同一个池里另借一条（安全审查 L2）。
  if(ctx.db)ledger=await this.ledger.computeInTransaction(ctx.db,actor,input,signal)
  else{
   const db=await this.pool.connect()
   try{
    await db.query('begin isolation level repeatable read read only')
    ledger=await this.ledger.computeInTransaction(db,actor,input,signal)
    await db.query('commit')
   }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
  }
  const result=ledger.blocks.find(block=>block.objectType.definition.id===objectType)?.views.find(item=>item.viewId===view.definition.id)
  if(!result)throw new WorkError('teloa/source-unavailable','台账没有算出组件引用的视图 '+view.definition.id+'。')
  return {
   columns:[{name:'dimension',type:'text'},{name:'label',type:'text'},...result.measures.map(measure=>({name:measure.id,type:'number'}))] as BusinessWidgetColumn[],
   rows:result.rows.map(row=>[row.dimension,row.label,...row.values]),
   computedAt:ledger.computedAt,throttled:false,
  }
 }
}
