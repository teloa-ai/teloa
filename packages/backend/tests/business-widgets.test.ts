import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import type {Pool} from 'pg'
import type {StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {readBusinessDashboardPage} from '@teloa/contract'
import {businessObjectSnapshotHash} from '../src/work/business-data.ts'
import {BusinessSqlExecutor} from '../src/work/business-sql-executor.ts'
import {BusinessLedgerService} from '../src/work/business-view-compute.ts'
import {BusinessWidgetService,type BusinessWidgetComputeContext} from '../src/work/business-widgets.ts'
import {alertTicket,definitionsOf,riskView,seedAlerts,startDatabase,widget} from './business-widget-fixture.ts'

/** 组件计算与结果快照的真库验收（计划 功能验证 第 1–4 条）：SQL 组件只经白名单 → 改写 → 执行器，view-ref 走台账同一路径。 */

let container:StartedPostgreSqlContainer,pool:Pool,reader:Pool
const OWNER='local:widget-owner',OTHER='local:widget-other'
before(async()=>{
 ({container,pool,reader}=await startDatabase())
 await seedAlerts(pool,OWNER,12)
 // 另一个本人同范围 30 条：结果里一条都不能出现。
 await seedAlerts(pool,OTHER,30,'secret')
},{timeout:120000})
after(async()=>{await reader?.end();await pool?.end();await container?.stop()})

const identity={now:()=>new Date().toISOString()}
const ledgerOf=()=>new BusinessLedgerService(pool,identity,definitionsOf({widgets:[],dashboards:[]}) as never)
const serviceOf=()=>new BusinessWidgetService(pool,identity,new BusinessSqlExecutor(reader,identity,'role'),ledgerOf())
const ctx=(owner=OWNER):BusinessWidgetComputeContext=>({ownerId:owner,scope:'SOC',objectTypes:[alertTicket],views:[{source:{} as never,definition:riskView}],now:identity.now()})

test('metric：恰 1 行且含取值列 → ok；多行或缺列 → failed 带原因；结果只含本人数据',async()=>{
 const service=serviceOf()
 const ok=await service.compute(ctx(),widget({id:'alert-count',kind:'metric',query:'select count(*) as value, 10 as previous from alert_ticket',metric:{valueColumn:'value',previousColumn:'previous'}}))
 assert.equal(ok.status,'ok',JSON.stringify(ok.error))
 assert.deepEqual(ok.columns.map(column=>column.name),['value','previous'])
 assert.deepEqual(ok.rows,[[12,10]],'只数到本人 12 条，另一个本人的 30 条不在内')
 assert.match(ok.definitionHash,/^[a-f0-9]{64}$/)
 const many=await service.compute(ctx(),widget({id:'alert-count',kind:'metric',query:'select count(*) as value from alert_ticket group by severity',metric:{valueColumn:'value'}}))
 assert.equal(many.status,'failed')
 assert.equal(many.error?.code,'teloa/invalid-input')
 assert.match(String(many.error?.reason),/恰好 1 行/)
 assert.deepEqual([many.rows,many.rowCount],[[],0])
 const missing=await service.compute(ctx(),widget({id:'alert-count',kind:'metric',query:'select count(*) as n from alert_ticket',metric:{valueColumn:'value'}}))
 assert.equal(missing.status,'failed')
 assert.match(String(missing.error?.reason),/value/)
})

test('board：含状态、标题、标识列即 ok，声明之外的状态值不影响形状',async()=>{
 const result=await serviceOf().compute(ctx(),widget({id:'alert-board',kind:'board',query:'select verdict as status, host as title, _id from alert_ticket',board:{statusColumn:'status',titleColumn:'title',idColumn:'_id',statuses:['正在核对']}}))
 assert.equal(result.status,'ok',JSON.stringify(result.error))
 assert.equal(result.rowCount,12)
 assert.ok(result.rows.every(row=>row[0]==='还没有人看'))
 assert.ok(result.rows.every(row=>String(row[2]).startsWith('alert-')),'只回本人对象')
})

test('view-ref：投影成 dimension/label/度量列，数字与台账同一视图逐一相等',async()=>{
 const result=await serviceOf().compute(ctx(),widget({id:'risk-ref',kind:'view-ref',viewRef:'soc-risk-distribution'}))
 assert.equal(result.status,'ok',JSON.stringify(result.error))
 assert.deepEqual(result.columns,[{name:'dimension',type:'text'},{name:'label',type:'text'},{name:'total',type:'number'}])
 const ledger=await ledgerOf().read({ownerId:OWNER,scopeIds:['SOC']},{scope:'SOC',objectType:'alert-ticket'})
 const view=ledger.blocks[0]!.views.find(item=>item.viewId==='soc-risk-distribution')!
 assert.deepEqual(result.rows,view.rows.map(row=>[row.dimension,row.label,...row.values]))
 assert.deepEqual(result.rows.map(row=>row[2]),[4,4,4])
 const dangling=await serviceOf().compute(ctx(),widget({id:'risk-ref',kind:'view-ref',viewRef:'no-such-view'}))
 assert.equal(dangling.status,'failed')
 assert.equal(dangling.error?.code,'teloa/source-unavailable')
})

test('chart 调用白名单外函数 → failed（invalid-input，原因含函数名）；失败也落库，latest 读得到',async()=>{
 const service=serviceOf()
 const chart=widget({id:'sleepy',kind:'chart',query:'select pg_sleep(1) as x',chart:{engine:'vega-lite',spec:{mark:'bar',encoding:{x:{field:'x',type:'nominal'}}}}})
 const result=await service.compute(ctx(),chart)
 assert.equal(result.status,'failed')
 assert.equal(result.error?.code,'teloa/invalid-input')
 assert.match(String(result.error?.reason),/pg_sleep/)
 const db=await pool.connect()
 try{
  await service.persist(db,OWNER,'SOC','soc-overview',result,'manual')
  const latest=await service.latest(db,OWNER,'SOC','soc-overview',new Map([['sleepy','all'],['absent','all']]))
  assert.deepEqual([...latest.keys()],['sleepy'])
  const stored=latest.get('sleepy')!
  assert.deepEqual({...stored},{...result,stale:false})
  // 读出来的结果照样过得了宿主侧严格读取器（结果不含 throttled 等内部键）。
  assert.doesNotThrow(()=>readBusinessDashboardPage({schema:'teloa.business-dashboard-page/v1',scope:'SOC',dashboard:{format:'teloa.business-dashboard/v1',id:'soc-overview',version:'1.0.0',domain:'SOC',title:'大盘',widgets:['sleepy'],layout:[{widget:'sleepy',x:0,y:0,w:12,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false},widgets:[chart],results:[stored],updatedAt:stored.computedAt,nextRefreshAt:null,refreshing:false,timeRange:null},'SOC'))
  const audit=(await db.query(`select status,error_code,trigger,row_count,bytes from teloa_business_widget_results where owner_id=$1 and widget_id='sleepy'`,[OWNER])).rows
  assert.deepEqual(audit,[{status:'failed',error_code:'teloa/invalid-input',trigger:'manual',row_count:0,bytes:0}])
 }finally{db.release()}
})

test('rowLimit 只截返回行：同一条 SQL 仍在完整执行边界内跑',async()=>{
 const result=await serviceOf().compute(ctx(),widget({id:'alert-table',kind:'table',query:'select _id, host from alert_ticket order by _id'}),5)
 assert.equal(result.status,'ok')
 assert.equal(result.rowCount,5)
 assert.equal(result.rows.length,5)
})

test('结果快照保留：同一组件只留最近 30 条，超过 90 天的旧结果也清，最新一条永远保留',async()=>{
 const service=serviceOf(),db=await pool.connect()
 try{
  const base=Date.parse('2026-09-01T00:00:00.000Z')
  const at=(offset:number)=>new Date(base+offset).toISOString()
  const row=(computedAt:string)=>({widgetId:'kept',definitionHash:'a'.repeat(64),computedAt,status:'ok' as const,columns:[{name:'n',type:'number' as const}],rows:[[1]],rowCount:1,truncated:false as const,bytes:3,stale:false})
  for(let index=0;index<35;index++)await service.persist(db,OWNER,'SOC','retention',row(at(index*1000)),'schedule')
  assert.equal((await db.query(`select count(*)::int as n from teloa_business_widget_results where owner_id=$1 and dashboard_id='retention'`,[OWNER])).rows[0].n,30)
  // 一条很久以前的孤立组件：只有它自己，作为最新一条保留；再写一条新的，旧的超过 90 天被清。
  await service.persist(db,OWNER,'SOC','retention',{...row('2020-01-01T00:00:00.000Z'),widgetId:'old'},'schedule')
  assert.equal((await db.query(`select count(*)::int as n from teloa_business_widget_results where owner_id=$1 and widget_id='old'`,[OWNER])).rows[0].n,1)
  await service.persist(db,OWNER,'SOC','retention',{...row(new Date().toISOString()),widgetId:'old'},'schedule')
  assert.deepEqual((await db.query(`select count(*)::int as n from teloa_business_widget_results where owner_id=$1 and widget_id='old'`,[OWNER])).rows[0].n,1)
 }finally{db.release()}
})

/** 给 owner 写几条告警快照，observedAt 分别是若干小时前：整页时间范围按 `_observed_at` 接入时据此落窗。 */
async function seedObserved(owner:string,hoursAgo:number[]):Promise<void>{
 for(const [index,hours] of hoursAgo.entries()){
  const at=new Date(Date.now()-hours*3_600_000).toISOString()
  const item={scope:'SOC',type:'alert-ticket',id:'range-'+index,version:1,title:'告警 '+index,source:'EDR',observedAt:at,receivedAt:at,quality:'complete' as const,summary:'说明',
   fields:[{label:'严重度',value:'高'},{label:'主机',value:'h-'+index},{label:'当前判定',value:'还没有人看'}]}
  await pool.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
    values($1,'SOC','alert-ticket',$2,1,$3,$4,'EDR',$5)`,[owner,item.id,businessObjectSnapshotHash(item),JSON.stringify(item),at])
 }
}

test('整页时间范围：接入组件按所选范围经执行器真算；all / 未接入组件不过滤；SQL 没读接入表 → failed 带原因',async()=>{
 const owner='local:widget-range'
 await seedObserved(owner,[1,3*24,10*24,40*24])
 const service=serviceOf()
 const bound=widget({id:'alert-range',kind:'metric',query:'select count(*) as value from alert_ticket',metric:{valueColumn:'value'},timeFilter:{table:'alert_ticket',column:'_observed_at'}})
 const counts:Record<string,unknown>={}
 for(const range of ['24h','7d','30d','90d','all'] as const){
  const result=await service.compute(ctx(owner),bound,undefined,undefined,range)
  assert.equal(result.status,'ok',JSON.stringify(result.error))
  counts[range]=result.rows[0]![0]
 }
 assert.deepEqual(counts,{'24h':1,'7d':2,'30d':3,'90d':4,all:4})
 assert.deepEqual((await service.compute(ctx(owner),bound)).rows,[[4]],'不传范围按 all')
 const {timeFilter:_timeFilter,...unboundBody}=bound
 assert.deepEqual((await service.compute(ctx(owner),unboundBody as typeof bound,undefined,undefined,'24h')).rows,[[4]],'未接入组件不随范围变化')
 // 只改写不执行：参数末位是服务端常量表里的区间文本。
 assert.equal((await service.rewrite(ctx(owner),bound,'30d')).params.at(-1),'30 days')
 assert.equal((await service.rewrite(ctx(owner),bound,'all')).params.includes('30 days'),false)
 const blind=widget({id:'alert-range',kind:'metric',query:'select 1 as value',metric:{valueColumn:'value'},timeFilter:{table:'alert_ticket',column:'_observed_at'}})
 const failed=await service.compute(ctx(owner),blind,undefined,undefined,'7d')
 assert.equal(failed.status,'failed')
 assert.equal(failed.error?.code,'teloa/invalid-input')
 assert.equal(failed.error?.reason,'组件接入了时间范围，但 SQL 没有读取表 alert_ticket。')
 assert.equal((await service.compute(ctx(owner),blind,undefined,undefined,'all')).status,'ok','all 不注入，也就不核对读表')
})

test('结果快照按范围分份：persist 写 time_range，latest 按组件各自的范围取；保留清理按范围分开算',async()=>{
 const service=serviceOf(),db=await pool.connect()
 try{
  const row=(widgetId:string,computedAt:string)=>({widgetId,definitionHash:'a'.repeat(64),computedAt,status:'ok' as const,columns:[{name:'n',type:'number' as const}],rows:[[1]],rowCount:1,truncated:false as const,bytes:3,stale:false})
  await service.persist(db,OWNER,'SOC','ranged',row('bound','2026-09-20T00:00:01.000Z'),'schedule','7d')
  await service.persist(db,OWNER,'SOC','ranged',row('bound','2026-09-20T00:00:02.000Z'),'manual','30d')
  // 同一时刻不同范围各成一行（主键含 time_range）。
  await service.persist(db,OWNER,'SOC','ranged',row('bound','2026-09-20T00:00:02.000Z'),'manual','7d')
  await service.persist(db,OWNER,'SOC','ranged',row('plain','2026-09-20T00:00:03.000Z'),'schedule')
  const stored=(await db.query(`select widget_id,time_range,computed_at from teloa_business_widget_results where owner_id=$1 and dashboard_id='ranged' order by widget_id,time_range,computed_at`,[OWNER])).rows
   .map(item=>[item.widget_id,item.time_range,(item.computed_at as Date).toISOString()])
  assert.deepEqual(stored,[
   ['bound','30d','2026-09-20T00:00:02.000Z'],['bound','7d','2026-09-20T00:00:01.000Z'],['bound','7d','2026-09-20T00:00:02.000Z'],['plain','all','2026-09-20T00:00:03.000Z'],
  ])
  const pick=async(ranges:Array<[string,'24h'|'7d'|'30d'|'90d'|'all']>)=>[...(await service.latest(db,OWNER,'SOC','ranged',new Map(ranges))).entries()].map(([id,result])=>[id,result.computedAt])
  assert.deepEqual(await pick([['bound','30d'],['plain','all']]),[['bound','2026-09-20T00:00:02.000Z'],['plain','2026-09-20T00:00:03.000Z']])
  assert.deepEqual(await pick([['bound','90d'],['plain','all']]),[['plain','2026-09-20T00:00:03.000Z']],'没算过的范围不回别的范围的结果')
  assert.deepEqual(await pick([['plain','7d']]),[],'未接入组件只有 all')
  // 默认范围连刷 35 次：30d 那一份不被挤掉（每个范围各留最近 30 条）。
  for(let index=0;index<35;index++)await service.persist(db,OWNER,'SOC','ranged',row('bound',new Date(Date.parse('2026-09-21T00:00:00.000Z')+index*1000).toISOString()),'schedule','7d')
  const kept=(await db.query(`select time_range,count(*)::int as n from teloa_business_widget_results where owner_id=$1 and dashboard_id='ranged' and widget_id='bound' group by time_range order by time_range`,[OWNER])).rows
  assert.deepEqual(kept,[{time_range:'30d',n:1},{time_range:'7d',n:30}])
  await assert.rejects(db.query(`insert into teloa_business_widget_results(owner_id,scope_id,dashboard_id,widget_id,definition_hash,computed_at,status,columns,rows,row_count,bytes,trigger,time_range)
    values($1,'SOC','ranged','x','h',now(),'ok','[]','[]',0,0,'manual','1y')`,[OWNER]),(error:{code?:string})=>error.code==='23514','time_range 受 check 约束')
 }finally{db.release()}
})
