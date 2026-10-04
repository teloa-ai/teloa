import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setTimeout as delay} from 'node:timers/promises'
import {Pool} from 'pg'
import type {StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,readBusinessDashboardPage,readBusinessDashboardSummaries,type BusinessWidgetDefinition} from '@teloa/contract'
import type {BusinessSqlExecution} from '../src/work/business-sql-executor.ts'
import {BusinessLedgerService} from '../src/work/business-view-compute.ts'
import {BusinessWidgetService,initializeBusinessWidgets} from '../src/work/business-widgets.ts'
import {BusinessDashboardService,initializeBusinessDashboards} from '../src/work/business-dashboards.ts'
import {BusinessSpaceService} from '../src/work/business-spaces.ts'
import {BusinessRuntimeService} from '../src/work/business-runtime.ts'
import {dashboardOf,definitionsOf,riskView,startDatabase,widget} from './business-widget-fixture.ts'

/** 看板服务真库验收（计划 功能验证 第 5–7、10 条）：只读快照、刷新互斥与幂等、到期判定、权限。 */

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{({container,pool}=await startDatabase())},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const count=widget({id:'alert-count',kind:'metric',query:'select count(*) as value from alert_ticket',metric:{valueColumn:'value'}})
const table=widget({id:'alert-table',kind:'table',query:'select _id from alert_ticket'})

/** 执行器桩：计数、可挂起；每次回一个比上次晚 1 秒的计算时刻，保证两批刷新的 computedAt 可区分。 */
function executorStub(options:{hangFirstMs?:number}={}){
 let calls=0,clock=Date.parse('2026-09-25T00:00:00.000Z')
 const stub={
  schema:'public',
  get calls(){return calls},
  async execute():Promise<BusinessSqlExecution>{
   calls+=1
   if(calls===1&&options.hangFirstMs)await delay(options.hangFirstMs)
   clock+=1000
   return {columns:[{name:'value',type:'number'},{name:'_id',type:'text'}],rows:[[7,'a']],rowCount:1,bytes:9,computedAt:new Date(clock).toISOString(),throttled:false}
  },
 }
 return stub
}
function harness(widgets:BusinessWidgetDefinition[]=[count,table],options:{hangFirstMs?:number;dashboards?:ReturnType<typeof dashboardOf>[]}={}){
 const owner='local:'+randomUUID(),actor={ownerId:owner,scopeIds:['SOC']}
 const identity={id:randomUUID,now:()=>new Date().toISOString()}
 const state={widgets,dashboards:options.dashboards??[dashboardOf(widgets.map(item=>item.id))]}
 const definitions=definitionsOf(state)
 const executor=executorStub(options)
 const widgetService=new BusinessWidgetService(pool,identity,executor,new BusinessLedgerService(pool,identity,definitions as never))
 const service=new BusinessDashboardService(pool,identity,definitions,widgetService)
 return {owner,actor,state,executor,widgetService,service}
}
const rows=async(owner:string)=>(await pool.query('select count(*)::int as n from teloa_business_widget_results where owner_id=$1',[owner])).rows[0].n as number
const rejectsWith=(promise:Promise<unknown>,code:string,reason?:RegExp)=>assert.rejects(promise,(error:unknown)=>{
 assert.ok(error instanceof WorkError,String(error));assert.equal(error.code,code,error.message);if(reason)assert.match(error.message,reason);return true
})

test('refresh 幂等：同 requestId 重放不重算、computedAt 相同；不同 requestId 算出新一批',async()=>{
 const f=harness()
 const input={requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'}
 const first=await f.service.refresh(f.actor,input)
 assert.deepEqual(first.results.map(result=>result.status),['ok','ok'])
 assert.equal(await rows(f.owner),2)
 const replay=await f.service.refresh(f.actor,input)
 assert.equal(f.executor.calls,2,'重放不再执行')
 assert.equal(await rows(f.owner),2)
 assert.deepEqual(replay.results.map(result=>result.computedAt),first.results.map(result=>result.computedAt))
 assert.equal(replay.updatedAt,first.updatedAt)
 const next=await f.service.refresh(f.actor,{...input,requestId:randomUUID()})
 assert.equal(await rows(f.owner),4)
 for(const [index,result] of next.results.entries())assert.ok(result.computedAt>first.results[index]!.computedAt)
 // 首次那一批在更晚一批之后重放，仍回首次那一批。
 assert.deepEqual((await f.service.refresh(f.actor,input)).results.map(result=>result.computedAt),first.results.map(result=>result.computedAt))
 assert.doesNotThrow(()=>readBusinessDashboardPage(next,'SOC'))
 await rejectsWith(f.service.refresh(f.actor,{...input,dashboardId:'other'}),'teloa/not-found')
})

test('refresh 互斥：刷新进行中另一次立即 teloa/conflict「看板正在刷新」，不排队；read 看得到 refreshing',async()=>{
 const f=harness([count],{hangFirstMs:500})
 const running=f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'})
 await delay(100)
 const started=Date.now()
 await rejectsWith(f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'}),'teloa/conflict',/看板正在刷新/)
 assert.ok(Date.now()-started<100,'取不到锁即返回，不等待')
 assert.equal((await f.service.read(f.actor,{scope:'SOC',dashboardId:'soc-overview'})).refreshing,true)
 await running
 assert.equal(f.executor.calls,1)
 assert.equal((await f.service.read(f.actor,{scope:'SOC',dashboardId:'soc-overview'})).refreshing,false)
})

test('刷新锁与同步锁键不同：同范围同名映射正在同步时，看板照常刷新',async()=>{
 const f=harness([count])
 const sync=await pool.connect()
 try{
  await sync.query('begin')
  // 与 BusinessSyncService.tryLock 同一键式；映射标识故意取与看板同名。
  assert.equal((await sync.query('select pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) as locked',[f.owner,'SOC\u001fsoc-overview'])).rows[0].locked,true)
  const page=await f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'})
  assert.equal(page.results[0]!.status,'ok')
 }finally{await sync.query('rollback');sync.release()}
})

test('read 只读快照不执行；updatedAt 取已有结果最大值，缺结果的组件 failed「尚未计算」',async()=>{
 const f=harness()
 const empty=await f.service.read(f.actor,{scope:'SOC',dashboardId:'soc-overview'})
 assert.equal(f.executor.calls,0)
 assert.equal(empty.updatedAt,null)
 assert.equal(empty.nextRefreshAt,null)
 assert.deepEqual(empty.results.map(result=>[result.widgetId,result.status,result.error?.reason]),[['alert-count','failed','尚未计算'],['alert-table','failed','尚未计算']])
 assert.doesNotThrow(()=>readBusinessDashboardPage(empty,'SOC'))
 // 只算第一个组件（调度器的组件级到期），第二个仍无结果。
 const refreshed=await f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'},undefined,{trigger:'schedule',widgetIds:['alert-count']})
 const calls=f.executor.calls
 const page=await f.service.read(f.actor,{scope:'SOC',dashboardId:'soc-overview'})
 assert.equal(f.executor.calls,calls,'read 不触发执行')
 assert.equal(page.results[0]!.status,'ok')
 assert.equal(page.results[1]!.error?.reason,'尚未计算')
 assert.equal(page.updatedAt,refreshed.results[0]!.computedAt)
 assert.equal(page.nextRefreshAt,new Date(Date.parse(page.updatedAt!)+300_000).toISOString())
 assert.equal((await pool.query(`select trigger from teloa_business_widget_results where owner_id=$1`,[f.owner])).rows[0].trigger,'schedule')
 // 声明改了：旧结果标记过期。
 f.state.widgets=[{...count,title:'告警总数'},table]
 assert.equal((await f.service.read(f.actor,{scope:'SOC',dashboardId:'soc-overview'})).results[0]!.stale,true)
 const summaries=await f.service.list(f.actor,{scope:'SOC'})
 assert.deepEqual(summaries,[{id:'soc-overview',title:'安全运营大盘',widgets:2,updatedAt:page.updatedAt}])
 assert.doesNotThrow(()=>readBusinessDashboardSummaries(summaries,'SOC'))
})

test('due：看板周期 300s 按最新结果判到期；组件覆盖 60s 只该组件到期',async()=>{
 const fast=widget({id:'alert-fast',kind:'metric',query:'select count(*) as value from alert_ticket',metric:{valueColumn:'value'},refresh:{kind:'every',seconds:60},acknowledgeShortInterval:true})
 const now=Date.parse('2026-09-25T12:00:00.000Z')
 const seed=async(f:ReturnType<typeof harness>,ago:number)=>{
  const db=await pool.connect()
  try{for(const item of f.state.widgets)await f.widgetService.persist(db,f.owner,'SOC','soc-overview',{widgetId:item.id,definitionHash:'a'.repeat(64),computedAt:new Date(now-ago*1000).toISOString(),status:'ok',columns:[],rows:[],rowCount:0,truncated:false,bytes:0,stale:false},'schedule')}
  finally{db.release()}
 }
 const at=new Date(now).toISOString()
 const fresh=harness([count])
 await seed(fresh,200)
 assert.deepEqual(await fresh.service.due(fresh.owner,at),[])
 const old=harness([count])
 await seed(old,400)
 assert.deepEqual(await old.service.due(old.owner,at),[{scope:'SOC',dashboardId:'soc-overview'}])
 const mixed=harness([count,fast])
 await seed(mixed,200)
 assert.deepEqual(await mixed.service.due(mixed.owner,at),[{scope:'SOC',dashboardId:'soc-overview',widgetIds:['alert-fast']}])
 const never=harness([count])
 assert.deepEqual(await never.service.due(never.owner,at),[],'没有本地看板指针也没有结果的本人不枚举')
})

test('恢复暂停共享运行门控：due 与迟到定时请求不计算，旧成果可读、本人可手动刷新与重新启用',async()=>{
 const f=harness([count]),identity={id:randomUUID,now:()=>new Date().toISOString()}
 await new BusinessSpaceService(pool,identity).ensurePersonal(f.owner)
 const runtime=new BusinessRuntimeService(pool,identity)
 const first=await f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'})
 const at='2026-10-04T12:00:00.000Z'
 const queued=await f.service.due(f.owner,at)
 assert.deepEqual(queued,[{scope:'SOC',dashboardId:'soc-overview'}])
 const definitionsBefore=JSON.stringify(f.state)
 const resultsBefore=(await pool.query('select * from teloa_business_widget_results where owner_id=$1 order by computed_at',[f.owner])).rows
 const paused=await runtime.pauseScheduledWork(f.actor,{scope:'SOC',requestId:randomUUID()})
 assert.deepEqual(await f.service.due(f.owner,at),[])
 const calls=f.executor.calls
 await rejectsWith(f.service.refresh(f.actor,{requestId:randomUUID(),...queued[0]!},undefined,{trigger:'schedule'}),'teloa/conflict',/已暂停/)
 assert.equal(f.executor.calls,calls,'已排队的定时刷新也必须重新核对门控')
 assert.deepEqual((await pool.query('select * from teloa_business_widget_results where owner_id=$1 order by computed_at',[f.owner])).rows,resultsBefore,'暂停与拒绝迟到任务不改成果历史')
 assert.equal(JSON.stringify(f.state),definitionsBefore,'原刷新周期与声明不变')
 assert.deepEqual((await f.service.read(f.actor,{scope:'SOC',dashboardId:'soc-overview'})).results,first.results)
 const manual=await f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'})
 assert.equal(manual.results[0]!.status,'ok')
 assert.equal(f.executor.calls,calls+1,'本人按需刷新保留')
 await runtime.setSync(f.actor,{scope:'SOC',enabled:true,expectedRevision:paused.revision,requestId:randomUUID()})
 assert.deepEqual(await f.service.due(f.owner,at),queued)
 await f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'},undefined,{trigger:'schedule'})
 assert.equal(f.executor.calls,calls+2,'本人明确开启后恢复周期执行')
 await pool.query('delete from teloa_business_runtime where owner_id=$1 and scope_id=$2',[f.owner,'SOC'])
 assert.deepEqual(await f.service.due(f.owner,at),[],'受管状态损坏时不能按旧范围兼容语义继续调度')
 await rejectsWith(f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'},undefined,{trigger:'schedule'}),'teloa/storage-corrupt')
 assert.equal(f.executor.calls,calls+2)
})

test('定时刷新持运行锁至提交：暂停完成后不会再开始新计算，旧刷新回执仍可只读重放',async()=>{
 const f=harness([count]),identity={id:randomUUID,now:()=>new Date().toISOString()}
 await new BusinessSpaceService(pool,identity).ensurePersonal(f.owner)
 const runtime=new BusinessRuntimeService(pool,identity)
 const requestId=randomUUID(),pauseRequestId=randomUUID()
 let release!:()=>void,started!:()=>void
 const blocked=new Promise<void>(resolve=>{release=resolve})
 const entered=new Promise<void>(resolve=>{started=resolve})
 const execute=f.executor.execute.bind(f.executor)
 f.executor.execute=async()=>{started();await blocked;return execute()}
 const refresh=f.service.refresh(f.actor,{requestId,scope:'SOC',dashboardId:'soc-overview'},undefined,{trigger:'schedule'})
 await entered
 let paused=false
 const pause=runtime.pauseScheduledWork(f.actor,{scope:'SOC',requestId:pauseRequestId}).then(state=>{paused=true;return state})
 const finished=Promise.allSettled([refresh,pause])
 // 查询真实咨询锁等待，不用时间猜测暂停已经与在途刷新相遇。
 const deadline=Date.now()+3000
 let waiting=false
 try{
  while(!waiting&&Date.now()<deadline){
   waiting=(await pool.query("select exists(select 1 from pg_locks where locktype='advisory' and not granted and classid=((hashtextextended($1,0)>>32)&4294967295)::oid and objid=(hashtextextended($1,0)&4294967295)::oid and objsubid=1) as waiting",[JSON.stringify(['teloa.business-runtime',f.owner,'SOC'])])).rows[0].waiting===true
   if(!waiting)await delay(5)
  }
  assert.equal(waiting,true,'暂停应等待真实运行锁')
  assert.equal(paused,false)
 }finally{release();await finished}
 const [refreshed,pauseResult]=await finished
 assert.equal(refreshed!.status,'fulfilled')
 assert.equal(pauseResult!.status,'fulfilled')
 if(refreshed!.status!=='fulfilled')throw refreshed!.reason
 const page=refreshed!.value
 assert.equal(paused,true)
 const calls=f.executor.calls
 const replay=await f.service.refresh(f.actor,{requestId,scope:'SOC',dashboardId:'soc-overview'},undefined,{trigger:'schedule'})
 assert.deepEqual(replay.results,page.results,'暂停后重放已完成回执不重新计算')
 assert.equal(f.executor.calls,calls)
 await rejectsWith(f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'},undefined,{trigger:'schedule'}),'teloa/conflict',/已暂停/)
 assert.equal(f.executor.calls,calls)
})

test('权限与不存在：非本人范围 forbidden，看板不存在 not-found',async()=>{
 const f=harness()
 const other={ownerId:f.owner,scopeIds:['OPS']}
 await rejectsWith(f.service.read(other,{scope:'SOC',dashboardId:'soc-overview'}),'teloa/forbidden')
 await rejectsWith(f.service.refresh(other,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'}),'teloa/forbidden')
 await rejectsWith(f.service.list(other,{scope:'SOC'}),'teloa/forbidden')
 await rejectsWith(f.service.read(f.actor,{scope:'SOC',dashboardId:'nope'}),'teloa/not-found')
 await rejectsWith(f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'nope'}),'teloa/not-found')
 await rejectsWith(f.service.read(f.actor,{scope:'SOC',dashboardId:'soc-overview',extra:1}),'teloa/invalid-input')
 assert.equal(f.executor.calls,0)
})

test('refresh 只占一条应用连接：view-ref 组件复用刷新事务的连接算台账（单连接池也能刷完）',async()=>{
 const single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:3000})
 try{
  const ref=widget({id:'risk-ref',kind:'view-ref',viewRef:riskView.id})
  const owner='local:'+randomUUID(),actor={ownerId:owner,scopeIds:['SOC']},identity={id:randomUUID,now:()=>new Date().toISOString()}
  const definitions=definitionsOf({widgets:[count,ref],dashboards:[dashboardOf([count.id,ref.id])]})
  const widgetService=new BusinessWidgetService(single,identity,executorStub(),new BusinessLedgerService(single,identity,definitions as never))
  const service=new BusinessDashboardService(single,identity,definitions,widgetService)
  const page=await service.refresh(actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'})
  assert.deepEqual(page.results.map(result=>[result.widgetId,result.status]),[['alert-count','ok'],['risk-ref','ok']])
 }finally{await single.end()}
})

/* ---------- 二期：整页时间范围（规格 §3.3） ---------- */

const bound=widget({id:'alert-range',kind:'metric',query:'select count(*) as value from alert_ticket',metric:{valueColumn:'value'},timeFilter:{table:'alert_ticket',column:'_observed_at'}})
const rangedBoard=(widgets=[bound.id,count.id])=>dashboardOf(widgets,{filters:{timeRange:{options:['7d','30d','90d','all'],default:'7d'}}})
/** 执行器桩另记下每次执行的区间参数（末位参数是否区间文本）：刷新按范围交给改写器的区间据此可见。 */
function rangedHarness(widgets=[bound,count],dashboards=[rangedBoard()]){
 const f=harness(widgets,{dashboards})
 const intervals:Array<string|null>=[]
 const execute=f.executor.execute.bind(f.executor)
 ;(f.executor as {execute:(...args:unknown[])=>Promise<BusinessSqlExecution>}).execute=async(...args:unknown[])=>{
  const params=(args[1] as {params:string[]}).params,last=params.at(-1)
  intervals.push(last!==undefined&&/^\d+ (hours|days)$/.test(last)?last:null)
  return execute()
 }
 return {...f,intervals}
}
const stored=async(owner:string)=>(await pool.query('select widget_id,time_range from teloa_business_widget_results where owner_id=$1 order by computed_at,widget_id',[owner])).rows.map(row=>row.widget_id+'@'+row.time_range)

test('默认 7d 看板定时刷新：接入组件落 7d、未接入组件落 all；页面 timeRange.selected=7d',async()=>{
 const f=rangedHarness()
 const page=await f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'},undefined,{trigger:'schedule'})
 assert.deepEqual(page.timeRange,{selected:'7d',options:['7d','30d','90d','all']})
 assert.deepEqual((await stored(f.owner)).sort(),['alert-count@all','alert-range@7d'])
 assert.deepEqual(f.intervals,['7 days',null])
 assert.doesNotThrow(()=>readBusinessDashboardPage(page,'SOC'))
 assert.deepEqual(page.results.map(result=>result.status),['ok','ok'])
})

test('按需刷新 30d：接入组件落 30d、未接入组件复用 all 不重算；读 30d 回这一份且 selected=30d；读没算过的 90d 接入组件缺席；读默认仍是 7d 那一份',async()=>{
 const f=rangedHarness()
 const week=await f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'})
 const month=await f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview',timeRange:'30d'})
 assert.deepEqual(month.timeRange,{selected:'30d',options:['7d','30d','90d','all']})
 assert.deepEqual(f.intervals,['7 days',null,'30 days'],'非默认范围只算接入组件')
 assert.equal(month.results[1]!.computedAt,week.results[1]!.computedAt,'未接入组件直接用默认刷新那份 all 结果')
 assert.deepEqual((await stored(f.owner)).sort(),['alert-count@all','alert-range@30d','alert-range@7d'])
 const read30=await f.service.read(f.actor,{scope:'SOC',dashboardId:'soc-overview',timeRange:'30d'})
 assert.equal(read30.timeRange?.selected,'30d')
 assert.deepEqual(read30.results.map(result=>result.computedAt),month.results.map(result=>result.computedAt))
 const read90=await f.service.read(f.actor,{scope:'SOC',dashboardId:'soc-overview',timeRange:'90d'})
 assert.equal(read90.timeRange?.selected,'90d')
 assert.deepEqual(read90.results.map(result=>[result.widgetId,result.status,result.error?.reason??null]),[['alert-range','failed','尚未计算'],['alert-count','ok',null]],'接入组件缺结果；未接入组件照用 all')
 const readDefault=await f.service.read(f.actor,{scope:'SOC',dashboardId:'soc-overview'})
 assert.equal(readDefault.timeRange?.selected,'7d')
 assert.equal(readDefault.results[0]!.computedAt,week.results[0]!.computedAt,'默认范围读 7d 那一份，不被 30d 顶替')
 for(const page of [read30,read90,readDefault])assert.doesNotThrow(()=>readBusinessDashboardPage(page,'SOC'))
 assert.equal(f.executor.calls,3,'读不触发计算')
})

test('非默认范围按需刷新：未接入组件已有 all 结果即复用、没有才补算；重放同样回复用的那份；切到 all（非默认）同理',async()=>{
 const f=rangedHarness()
 const requestId=randomUUID()
 const first=await f.service.refresh(f.actor,{requestId,scope:'SOC',dashboardId:'soc-overview',timeRange:'30d'})
 assert.deepEqual(f.intervals,['30 days',null],'未接入组件还没有 all 结果：补算一次')
 assert.deepEqual(first.results.map(result=>result.status),['ok','ok'])
 const again=await f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview',timeRange:'90d'})
 assert.deepEqual(f.intervals,['30 days',null,'90 days'],'已有 all 结果：不重算')
 assert.equal(again.results[1]!.computedAt,first.results[1]!.computedAt)
 const replay=await f.service.refresh(f.actor,{requestId,scope:'SOC',dashboardId:'soc-overview',timeRange:'30d'})
 assert.deepEqual(replay.results.map(result=>result.computedAt),first.results.map(result=>result.computedAt))
 await f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview',timeRange:'all'})
 assert.deepEqual(f.intervals,['30 days',null,'90 days',null],'选 all（非默认）：接入组件按 all 算，未接入组件仍复用')
 assert.equal(f.executor.calls,4)
 // 读非默认范围同样拿未接入组件的 all 结果。
 const read=await f.service.read(f.actor,{scope:'SOC',dashboardId:'soc-overview',timeRange:'90d'})
 assert.equal(read.results[1]!.computedAt,first.results[1]!.computedAt)
 // 默认范围的刷新（手动或定时）照旧整页重算。
 await f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview',timeRange:'7d'})
 assert.deepEqual(f.intervals.slice(4),['7 days',null])
})

test('一期留下的刷新记录（批次不带范围）：看板后来加了 filters，同一 requestId 不带范围重放按默认范围回放、不报冲突；显式带非默认范围仍冲突',async()=>{
 const f=rangedHarness()
 const requestId=randomUUID(),legacyAt='2026-09-20T00:00:00.000Z'
 const db=await pool.connect()
 try{
  for(const widgetId of ['alert-range','alert-count'])await f.widgetService.persist(db,f.owner,'SOC','soc-overview',{widgetId,definitionHash:'a'.repeat(64),computedAt:legacyAt,status:'ok',columns:[{name:'value',type:'number'}],rows:[[1]],rowCount:1,truncated:false,bytes:3,stale:false},'manual')
  // 一期形状：批次项没有 timeRange，记录的 time_range 由迁移默认值补成 all。
  await db.query(`insert into teloa_business_dashboard_refreshes(owner_id,request_id,scope_id,dashboard_id,results) values($1,$2,'SOC','soc-overview',$3)`,[f.owner,requestId,JSON.stringify([{widgetId:'alert-range',computedAt:legacyAt},{widgetId:'alert-count',computedAt:legacyAt}])])
 }finally{db.release()}
 const replay=await f.service.refresh(f.actor,{requestId,scope:'SOC',dashboardId:'soc-overview'})
 assert.equal(f.executor.calls,0,'回放不重算')
 assert.equal(replay.timeRange?.selected,'7d')
 // 未接入组件取批次里那份 all；接入组件的批次项是 all、与 7d 视图不符，不冒充 7d 结果（7d 没算过 → 缺席）。
 assert.deepEqual(replay.results.map(result=>[result.widgetId,result.status,result.status==='ok'?result.computedAt:result.error?.reason]),[['alert-range','failed','尚未计算'],['alert-count','ok',legacyAt]])
 await rejectsWith(f.service.refresh(f.actor,{requestId,scope:'SOC',dashboardId:'soc-overview',timeRange:'30d'}),'teloa/conflict',/另一个时间范围/)
 assert.doesNotThrow(()=>readBusinessDashboardPage(replay,'SOC'))
})

test('看板列表 updatedAt 只看默认视图应有的结果：按需算出的 30d 更新不让它变新',async()=>{
 const f=rangedHarness()
 const week=await f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview'})
 await f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview',timeRange:'30d'})
 assert.deepEqual(await f.service.list(f.actor,{scope:'SOC'}),[{id:'soc-overview',title:'安全运营大盘',widgets:2,updatedAt:week.updatedAt}])
})

test('同一 requestId 换范围重放 → conflict；同范围重放回首次那一批；缺省范围等同默认范围',async()=>{
 const f=rangedHarness()
 const requestId=randomUUID()
 const first=await f.service.refresh(f.actor,{requestId,scope:'SOC',dashboardId:'soc-overview',timeRange:'30d'})
 await rejectsWith(f.service.refresh(f.actor,{requestId,scope:'SOC',dashboardId:'soc-overview',timeRange:'90d'}),'teloa/conflict',/^同一刷新请求标识已用于另一个时间范围/)
 await rejectsWith(f.service.refresh(f.actor,{requestId,scope:'SOC',dashboardId:'soc-overview'}),'teloa/conflict',/另一个时间范围/)
 const replay=await f.service.refresh(f.actor,{requestId,scope:'SOC',dashboardId:'soc-overview',timeRange:'30d'})
 assert.deepEqual(replay.results.map(result=>result.computedAt),first.results.map(result=>result.computedAt))
 assert.equal(replay.timeRange?.selected,'30d')
 const implicit=randomUUID()
 await f.service.refresh(f.actor,{requestId:implicit,scope:'SOC',dashboardId:'soc-overview'})
 const calls=f.executor.calls
 assert.equal((await f.service.refresh(f.actor,{requestId:implicit,scope:'SOC',dashboardId:'soc-overview',timeRange:'7d'})).timeRange?.selected,'7d')
 assert.equal(f.executor.calls,calls,'显式写默认范围的重放不重算')
 assert.equal((await pool.query('select time_range from teloa_business_dashboard_refreshes where owner_id=$1 and request_id=$2',[f.owner,requestId])).rows[0].time_range,'30d')
})

test('范围取值：无 filters 看板带 timeRange、取值不在 options、非枚举值 → invalid-input；无 filters 看板 timeRange=null',async()=>{
 const plain=harness()
 const page=await plain.service.read(plain.actor,{scope:'SOC',dashboardId:'soc-overview'})
 assert.equal(page.timeRange,null)
 for(const timeRange of ['7d','all']){
  await rejectsWith(plain.service.read(plain.actor,{scope:'SOC',dashboardId:'soc-overview',timeRange}),'teloa/invalid-input',/没有声明时间范围/)
  await rejectsWith(plain.service.refresh(plain.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview',timeRange}),'teloa/invalid-input',/没有声明时间范围/)
 }
 const f=rangedHarness()
 await rejectsWith(f.service.read(f.actor,{scope:'SOC',dashboardId:'soc-overview',timeRange:'24h'}),'teloa/invalid-input',/不在看板提供的选项里/)
 for(const timeRange of ['1y','7 days',"7d' or '1'='1",null,7,['7d'],''])
  await rejectsWith(f.service.refresh(f.actor,{requestId:randomUUID(),scope:'SOC',dashboardId:'soc-overview',timeRange}),'teloa/invalid-input',/时间范围/)
 assert.equal(f.executor.calls+plain.executor.calls,0)
})

test('due：只看默认视图应有的那份结果，30d 按需结果不推迟默认范围到期',async()=>{
 const now=Date.parse('2026-09-25T12:00:00.000Z'),at=new Date(now).toISOString()
 const seed=async(f:ReturnType<typeof rangedHarness>,rows:Array<[string,'7d'|'30d'|'all',number]>)=>{
  const db=await pool.connect()
  try{for(const [widgetId,range,ago] of rows)await f.widgetService.persist(db,f.owner,'SOC','soc-overview',{widgetId,definitionHash:'a'.repeat(64),computedAt:new Date(now-ago*1000).toISOString(),status:'ok',columns:[],rows:[],rowCount:0,truncated:false,bytes:0,stale:false},'schedule',range)}
  finally{db.release()}
 }
 const stale=rangedHarness()
 await seed(stale,[['alert-range','7d',400],['alert-range','30d',10],['alert-count','all',10]])
 assert.deepEqual(await stale.service.due(stale.owner,at),[{scope:'SOC',dashboardId:'soc-overview'}],'默认 7d 过期即到期，30d 新结果不算')
 const fresh=rangedHarness()
 await seed(fresh,[['alert-range','7d',10],['alert-range','30d',4000],['alert-count','all',10]])
 assert.deepEqual(await fresh.service.due(fresh.owner,at),[],'30d 旧结果不触发定时刷新')
 const unbound=rangedHarness()
 await seed(unbound,[['alert-range','7d',10],['alert-count','7d',10],['alert-count','all',400]])
 assert.deepEqual(await unbound.service.due(unbound.owner,at),[{scope:'SOC',dashboardId:'soc-overview'}],'未接入组件看 all')
})

/** 一期（a0760894）两张表的建表语句原文：迁移测试据此造一期库。 */
const phaseOneDdl=`
 create table teloa_business_widget_results (
   owner_id text not null, scope_id text not null, dashboard_id text not null, widget_id text not null,
   definition_hash text not null, computed_at timestamptz not null,
   status text not null check(status in ('ok','failed')),
   columns jsonb not null, rows jsonb not null, row_count integer not null check(row_count>=0), bytes integer not null check(bytes>=0),
   error_code text, error_reason text, throttled boolean not null default false,
   trigger text not null check(trigger in ('manual','schedule','session')),
   check((status='ok')=(error_code is null)),
   primary key(owner_id,scope_id,dashboard_id,widget_id,computed_at)
 );
 create table teloa_business_dashboard_refreshes (
   owner_id text not null, request_id text not null, scope_id text not null, dashboard_id text not null,
   results jsonb not null, created_at timestamptz not null default now(),
   primary key(owner_id,request_id)
 );`

test('迁移 widget-results-time-range-v1：一期旧行落 all、主键含 time_range；再初始化不再执行；并发初始化不报错',async()=>{
 for(const concurrent of [false,true]){
  const schema='phase_one_'+randomUUID().replaceAll('-','').slice(0,12)
  await pool.query(`create schema ${schema}`)
  const scoped=new Pool({connectionString:container.getConnectionUri(),options:`-c search_path=${schema}`})
  try{
   await scoped.query(phaseOneDdl)
   await scoped.query(`insert into teloa_business_widget_results(owner_id,scope_id,dashboard_id,widget_id,definition_hash,computed_at,status,columns,rows,row_count,bytes,trigger)
     values('local:old','SOC','soc-overview','alert-count','${'a'.repeat(64)}','2026-09-20T00:00:00Z','ok','[{"name":"value","type":"number"}]','[[3]]',1,3,'schedule')`)
   await scoped.query(`insert into teloa_business_dashboard_refreshes(owner_id,request_id,scope_id,dashboard_id,results) values('local:old','${randomUUID()}','SOC','soc-overview','[]')`)
   if(concurrent)await Promise.all(Array.from({length:4},()=>initializeBusinessDashboards(scoped)))
   else await initializeBusinessDashboards(scoped)
   assert.deepEqual((await scoped.query('select time_range from teloa_business_widget_results')).rows,[{time_range:'all'}])
   assert.deepEqual((await scoped.query('select time_range from teloa_business_dashboard_refreshes')).rows,[{time_range:'all'}])
   const key=(await scoped.query(`select array_agg(a.attname::text order by k.ordinality) as columns from pg_constraint c
     cross join lateral unnest(c.conkey) with ordinality as k(attnum,ordinality) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum
     where c.conrelid=to_regclass($1) and c.contype='p'`,[schema+'.teloa_business_widget_results'])).rows[0].columns
   assert.deepEqual(key,['owner_id','scope_id','dashboard_id','widget_id','time_range','computed_at'])
   const marker=(await scoped.query('select name,applied_at from teloa_business_dashboard_migrations')).rows
   assert.deepEqual(marker.map(row=>row.name),['widget-results-time-range-v1'])
   await initializeBusinessDashboards(scoped)
   assert.deepEqual((await scoped.query('select applied_at from teloa_business_dashboard_migrations')).rows.map(row=>(row.applied_at as Date).toISOString()),marker.map(row=>(row.applied_at as Date).toISOString()),'再初始化不再执行')
   await assert.rejects(scoped.query(`update teloa_business_widget_results set time_range='1y'`),(error:{code?:string})=>error.code==='23514')
  }finally{await scoped.end();await pool.query(`drop schema ${schema} cascade`)}
 }
})

test('全新库并发首启：结果表建表与迁移都在同一把咨询锁里，多进程同时初始化不报错',async()=>{
 const schema='fresh_'+randomUUID().replaceAll('-','').slice(0,12)
 await pool.query(`create schema ${schema}`)
 const scoped=new Pool({connectionString:container.getConnectionUri(),options:`-c search_path=${schema}`,max:8})
 try{
  await Promise.all(Array.from({length:4},async()=>{await initializeBusinessWidgets(scoped);await initializeBusinessDashboards(scoped)}))
  const columns=(await scoped.query(`select column_name from information_schema.columns where table_schema=$1 and table_name='teloa_business_widget_results' and column_name='time_range'`,[schema])).rows
  assert.equal(columns.length,1)
  assert.equal((await scoped.query('select count(*)::int as n from teloa_business_dashboard_migrations')).rows[0].n,1)
 }finally{await scoped.end();await pool.query(`drop schema ${schema} cascade`)}
})
