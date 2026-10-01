import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {businessLedgerLimits} from '@teloa/contract'
import {BusinessDataService,initializeBusinessData,type BusinessDataSourcePort,type BusinessObjectSnapshot} from '../src/work/business-data.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import {BusinessLedgerService,type BusinessLedgerActor} from '../src/work/business-view-compute.ts'
import {BusinessWarehouseService} from '../src/work/business-warehouse.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeBusinessData(pool)},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const enc=new TextEncoder()
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
/** 台账计算固定在这一刻：时间窗与 overdue 全部相对它算，测试因此不受真实时钟漂移影响。 */
const NOW='2026-09-16T12:00:00.000Z'
const DAY=86400000

/**
 * 规格 §12.1–12.2 的 SOC 声明样例（与 `tests/fixtures/业务定制层/SOC/**` 逐字一致），
 * 外加一份清单视图 `soc-alert-list`：夹具里没有 `kind:'list'` 的样例，而"列表视图多带 objects 段"
 * 是本任务必须钉住的判据，因此在测试内声明，不改动共享夹具文件。
 */
type BundleOptions={withList?:boolean;listLimit?:number;withReference?:boolean;withStats?:boolean}
function socBundle(options:BundleOptions){
 return {
  domain:'SOC',
  objectTypes:[
   {format:'teloa.business-object-type/v1',id:'alert-ticket',version:'1.0.0',domain:'SOC',title:'告警工单',unit:'条',lead:'来自告警平台和终端记录，进来之后先归并再判断。',sourceId:'security-alert-http',fields:[
    {name:'severity',label:'严重度',type:'enum',required:true,from:'严重度',values:['高','中','低']},
    {name:'host',label:'主机',type:'text',required:true,from:'主机'},
    {name:'verdict',label:'当前判定',type:'enum',required:true,from:'当前判定',values:['还没有人看','正在核对','等你确认','已确认维护']},
    {name:'first-seen-at',label:'首次出现',type:'datetime',required:true,from:'首次出现'},
    {name:'last-changed-at',label:'最近变化',type:'datetime',required:true,from:'最近变化'},
    {name:'account-count',label:'涉及账号数',type:'number',required:false,from:'涉及账号数'},
    {name:'incident',label:'关联调查',type:'reference',required:false,from:'关联调查',referenceType:'incident-ticket'},
   ],progress:{stageField:'verdict',unfinished:['还没有人看','正在核对','等你确认'],waitingForYou:['等你确认'],changedAtField:'last-changed-at'},defaultAction:'assign-alert-review'},
   {format:'teloa.business-object-type/v1',id:'incident-ticket',version:'1.0.0',domain:'SOC',title:'事件工单',unit:'件',lead:'告警里说不清的，立成一件调查，交给同事查到有结论为止。',sourceId:'security-alert-http',fields:[
    {name:'state',label:'当前状态',type:'enum',required:true,from:'当前状态',values:['进来的事','正在处理','需要你','已完成']},
    {name:'owner',label:'负责同事',type:'text',required:true,from:'负责同事'},
    {name:'opened-at',label:'立案时间',type:'datetime',required:true,from:'立案时间'},
   ]},
  ],
  views:[
   {format:'teloa.business-view/v1',id:'soc-alert-trend',version:'1.0.0',domain:'SOC',title:'告警趋势',kind:'trend',chart:'line',objectType:'alert-ticket',
    dimension:{field:'first-seen-at',bucket:'day',limit:30},
    measures:[
     {id:'high',label:'高',aggregation:'count',where:{field:'severity',op:'eq',values:['高']}},
     {id:'med',label:'中',aggregation:'count',where:{field:'severity',op:'eq',values:['中']}},
     {id:'low',label:'低',aggregation:'count',where:{field:'severity',op:'eq',values:['低']}},
    ],filters:[],sort:{by:'dimension',direction:'asc'},window:{field:'first-seen-at',relative:'last-30d'},limit:30},
   {format:'teloa.business-view/v1',id:'soc-risk-distribution',version:'1.0.0',domain:'SOC',title:'风险分布',kind:'distribution',chart:'bar',objectType:'alert-ticket',
    dimension:{field:'severity',limit:3},measures:[{id:'total',label:'条数',aggregation:'count'}],filters:[{field:'verdict',op:'ne',values:['已确认维护']}],sort:{by:'measure',measureId:'total',direction:'desc'},limit:3},
   {format:'teloa.business-view/v1',id:'soc-pending-board',version:'1.0.0',domain:'SOC',title:'待处理告警',kind:'board-card',chart:'number',objectType:'alert-ticket',
    measures:[{id:'pending',label:'条',aggregation:'count'}],filters:[{field:'verdict',op:'in',values:['还没有人看','正在核对','等你确认']}],limit:1},
   ...(options.withList?[{format:'teloa.business-view/v1',id:'soc-alert-list',version:'1.0.0',domain:'SOC',title:'告警清单',kind:'list',chart:'table',objectType:'alert-ticket',
    measures:[{id:'accounts',label:'涉及账号数',aggregation:'max',field:'account-count'}],filters:[],sort:{by:'dimension',direction:'asc'},limit:options.listLimit??100}]:[]),
   // reference 作维度：夹具样例没有这一档，而"跨范围引用禁止"必须有正反两面的用例（规格 §8 第 4 条）。
   ...(options.withReference?[{format:'teloa.business-view/v1',id:'soc-incident-link',version:'1.0.0',domain:'SOC',title:'关联调查分布',kind:'distribution',chart:'table',objectType:'alert-ticket',
    dimension:{field:'incident',limit:50},measures:[{id:'total',label:'条数',aggregation:'count'}],filters:[],sort:{by:'dimension',direction:'asc'},limit:50}]:[]),
   ...(options.withStats?[
    {format:'teloa.business-view/v1',id:'soc-alert-stats',version:'1.0.0',domain:'SOC',title:'账号数统计',kind:'distribution',chart:'table',objectType:'alert-ticket',
     dimension:{field:'severity',limit:3},measures:[
      {id:'accounts-sum',label:'合计',aggregation:'sum',field:'account-count'},
      {id:'accounts-avg',label:'均值',aggregation:'avg',field:'account-count'},
      {id:'accounts-min',label:'最小',aggregation:'min',field:'account-count'},
      {id:'seen-max',label:'最近一次出现',aggregation:'max',field:'first-seen-at'},
     ],filters:[],sort:{by:'dimension',direction:'asc'},limit:3},
    {format:'teloa.business-view/v1',id:'soc-overdue-board',version:'1.0.0',domain:'SOC',title:'已逾期',kind:'board-card',chart:'number',objectType:'alert-ticket',
     measures:[{id:'overdue',label:'条',aggregation:'count'}],filters:[],window:{field:'first-seen-at',relative:'overdue'},limit:1},
   ]:[]),
  ],
  actions:[
   {format:'teloa.business-action/v1',id:'assign-alert-review',version:'1.0.0',domain:'SOC',title:'交给同事核对',objectType:'alert-ticket',
    target:{kind:'work-template',localId:'alert-triage-review'},
    inputs:[{from:'field',field:'host'},{from:'object',part:'title'},{from:'object',part:'summary'}]},
   {format:'teloa.business-action/v1',id:'isolate-endpoint',version:'1.0.0',domain:'SOC',title:'隔离这台主机',objectType:'alert-ticket',
    target:{kind:'execution-tool',localId:'soc-endpoint-isolation',tool:'security.endpoint.isolate',workTemplate:'endpoint-isolation-record',targetFrom:{from:'field',field:'host'}},
    inputs:[{from:'object',part:'summary'},{from:'literal',value:'按告警工单发起，影响范围以资产台账为准。'}]},
  ],
  workTemplates:[
   {format:'teloa.work-template/v1',id:'alert-triage-review',title:'告警复核任务',version:'1.0.0',domain:'SOC',description:'核对告警并给出结论。',requirements:['主机','工单标题','工单摘要'],output:'复核结论',skills:[]},
   {format:'teloa.work-template/v1',id:'endpoint-isolation-record',title:'端点隔离记录',version:'1.0.0',domain:'SOC',description:'记录隔离动作。',requirements:['工单摘要','隔离说明'],output:'隔离记录',skills:[]},
  ],
  dataSources:[{format:'teloa.data-source/v1',sourceId:'security-alert-http',scopes:['SOC']}],
  /** `isolate-endpoint` 的 `target.localId` 指的就是它：动作引用的执行工具必须是同一加载内的加载项（复审 MEDIUM-9）。 */
  executionTools:[{localId:'soc-endpoint-isolation',definition:{format:'teloa.execution-tool/v1',adapterId:'security-action-http',tools:['security.endpoint.isolate']}}],
 }
}
type SocBundle=ReturnType<typeof socBundle>

test('来源名称从固定数据源声明进入台账，未声明则不输出该字段',async()=>{
 const named=await fixture({objects:0,mutate:value=>{Object.assign(value.dataSources[0]!,{sourceNoun:'告警源'})}})
 const blocks=(await named.service.read(named.actor,{scope:'SOC'})).blocks
 assert.ok(blocks.length>0)
 for(const block of blocks)assert.equal(block.source.sourceNoun,'告警源')
 const unnamed=await fixture({objects:0})
 for(const block of (await unnamed.service.read(unnamed.actor,{scope:'SOC'})).blocks)assert.equal(Object.hasOwn(block.source,'sourceNoun'),false)
})

test('共享来源称呼优先已连接加载，同状态按加载顺序保留且不改变数据口径',async()=>{
 const owner=randomUUID(),a=socBundle({}),b=socBundle({})
 Object.assign(a.dataSources[0]!,{sourceNoun:'较早来源'})
 Object.assign(b.dataSources[0]!,{sourceNoun:'较晚来源'})
 for(const [activeA,activeB,expected] of [[false,true,'较晚来源'],[true,false,'较早来源'],[false,false,'较早来源'],[true,true,'较早来源']] as const){
  const first=reader(a,owner,new Set(activeA?['security-alert-http']:[])),second=reader(b,owner,new Set(activeB?['security-alert-http']:[]))
  const definitions={forScope:async(...args:Parameters<BusinessDefinitionSourceReader['forScope']>)=>{
   const left=await first.forScope(...args),right=await second.forScope(...args)
   // 第二个加载贡献同一来源的称呼；声明标识不重复。两侧来源仍从固定字节经过真实读取器校验。
   return [...left,...right.map(bundle=>({...bundle,objectTypes:[],views:[],actions:[]}))]
  }}
  const service=new BusinessLedgerService(pool,{now:()=>NOW},definitions as BusinessDefinitionSourceReader)
  const result=await service.read({ownerId:owner,scopeIds:['SOC']},{scope:'SOC'})
  for(const block of result.blocks){
   assert.equal(block.source.sourceNoun,expected)
   assert.equal(block.source.connected,activeA||activeB)
   assert.equal(block.objects,0,'来源称呼不会产生业务对象')
  }
 }
})

/** 假市场内容 + 假加载，形状照 `business-definition-source.test.ts`：声明侧不进库，只有快照表用真库。 */
function reader(value:SocBundle,owner:string,activeSources=new Set(['security-alert-http'])){
 const contentId=randomUUID(),loadId=randomUUID(),contentHash='a'.repeat(64),templateId='security',templateVersion='1.0.0'
 const resources:unknown[]=[],items:unknown[]=[],provides:unknown[]=[],files:unknown[]=[]
 const add=(kind:string,localId:string,version:string,definition:unknown,prefix:string)=>{
  const path=prefix+'/'+localId+'.json',bytes=enc.encode(JSON.stringify(definition))
  resources.push({id:localId,kind,title:localId,version,required:true,source:{kind:'local',path}})
  provides.push({resourceId:localId,kind,version,path})
  files.push({path,hash:sha(bytes),bytes})
  items.push({localId,instanceId:randomUUID(),kind,title:localId,version,required:true,status:'pending-adapter'})
 }
 for(const definition of value.objectTypes)add('object-type',definition.id,definition.version,definition,'object-types')
 for(const definition of value.views)add('business-view',definition.id,definition.version,definition,'views')
 for(const definition of value.actions)add('business-action',definition.id,definition.version,definition,'actions')
 for(const definition of value.workTemplates)add('work-template',definition.id,definition.version,definition,'work-templates')
 for(const definition of value.dataSources)add('data-source',definition.sourceId,'1.0.0',definition,'data-sources')
 for(const tool of value.executionTools)add('execution-tool',tool.localId,'1.0.0',tool.definition,'connections')
 const manifest={format:'teloa.business-package/v2',id:templateId,title:'安全运营',version:templateVersion,domain:value.domain,scope:value.domain,description:'安全模板',resources,relations:[],entrypoints:[]}
 const load={id:loadId,ownerId:owner,contentId,contentHash,templateId,templateVersion,templateTitle:'安全运营',domain:value.domain,scope:value.domain,description:'安全模板',targetVersion:1,
  space:{id:randomUUID(),name:value.domain,version:1,scope:value.domain},items,relations:[],entrypoints:[],createdAt:NOW,mappingHash:'e'.repeat(64),status:'active' as const}
 const content={id:contentId,ownerId:owner,kind:'industry-template',logicalId:templateId,version:templateVersion,hash:contentHash,baseHash:'c'.repeat(64),
  manifestPath:'teloa.json',metadata:manifest,files,provides,references:[],createdAt:NOW}
 // 读取层枚举加载的入口在 T3 修复轮里从 `list` 改成同事务的 `listInTransaction`：替身两条都给，
 // 本用例的判据是台账算得对不对，不该跟那一侧的落地顺序耦合。
 const loads={get:async()=>{throw Error('未预期调用')},getInTransaction:async()=>load,list:async()=>({items:[load]}),listInTransaction:async()=>({items:[load]})}
 return new BusinessDefinitionSourceReader(
  {get:async()=>{throw Error('未预期调用')},getInTransaction:async()=>content as never},
  loads as never,
  {activeSourceIds:async()=>activeSources},
 )
}

const SEVERITIES=['高','中','低'] as const
const snapshot=(index:number,spreadDays:number)=>({
 scope:'SOC',type:'alert-ticket',id:'soc-alert-'+index,version:1,title:'告警 '+index,source:'EDR',
 observedAt:new Date(Date.parse(NOW)-(index%Math.max(spreadDays,1))*DAY-3600000).toISOString(),
 receivedAt:new Date(Date.parse(NOW)-(index%Math.max(spreadDays,1))*DAY-1800000).toISOString(),
 quality:'complete' as const,summary:'告警 '+index+' 的处置说明。',
 fields:[
  {label:'严重度',value:SEVERITIES[index%3]!},
  {label:'主机',value:'prod-'+(index%7)},
  {label:'当前判定',value:index%5===0?'已确认维护':'还没有人看'},
  {label:'首次出现',value:new Date(Date.parse(NOW)-(index%Math.max(spreadDays,1))*DAY-3600000).toISOString()},
  {label:'最近变化',value:new Date(Date.parse(NOW)-(index%Math.max(spreadDays,1))*DAY-900000).toISOString()},
  {label:'涉及账号数',value:String(index%5)},
 ],
})

/** 按逐字段覆写造一条告警：用来钉解析边界，字段清单完全由用例给。 */
const alertWith=(index:number,fields:Array<[string,string]>)=>({...snapshot(index,1),fields:fields.map(([label,value])=>({label,value}))})
/** 事件工单：`alert-ticket.incident` 的引用目标类型，同范围引用要先有它才谈得上成立。 */
const incidentWith=(id:string)=>({
 scope:'SOC',type:'incident-ticket',id,version:1,title:'调查 '+id,source:'SOAR',
 observedAt:new Date(Date.parse(NOW)-2*3600000).toISOString(),receivedAt:new Date(Date.parse(NOW)-3600000).toISOString(),
 quality:'complete' as const,summary:'调查 '+id+' 的进展。',
 fields:[{label:'当前状态',value:'正在处理'},{label:'负责同事',value:'值班组'},{label:'立案时间',value:new Date(Date.parse(NOW)-2*3600000).toISOString()}],
})

/** 灌数据走 `BusinessDataService.query` 的真实落库路径，`snapshot_hash` 因此与 `businessObjectSnapshotHash` 天然一致。 */
async function seed(owner:string,items:unknown[]):Promise<BusinessObjectSnapshot[]>{
 const stored:BusinessObjectSnapshot[]=[]
 const port=(batch:unknown[]):BusinessDataSourcePort=>({id:'security-alert-http',scopes:['SOC'],query:async()=>({schema:'teloa.data-source-page/v1',sourceId:'security-alert-http',scope:'SOC',capturedAt:NOW,items:batch})})
 for(let start=0;start<items.length;start+=100){
  const batch=items.slice(start,start+100)
  const page=await new BusinessDataService(pool,port(batch)).query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:100})
  stored.push(...page.items)
 }
 return stored
}

type FixtureOptions=BundleOptions&{objects:number;spreadDays?:number;activeSources?:Set<string>;mutate?:(value:SocBundle)=>void;actionAvailability?:boolean}
async function fixture(options:FixtureOptions){
 const owner=randomUUID(),spreadDays=options.spreadDays??1
 const rows=Array.from({length:options.objects},(_value,index)=>snapshot(index+1,spreadDays))
 const stored=await seed(owner,rows)
 const bundle=socBundle(options)
 options.mutate?.(bundle)
 const definitions=reader(bundle,owner,options.activeSources)
 const actor:BusinessLedgerActor={ownerId:owner,scopeIds:['SOC']}
 const texts:string[]=[],params:string[]=[]
 // 通过代理 Pool 记录 SQL 文本与参数：断言"声明字符串 / 下钻过滤值不进 SQL"必须落在真实执行的语句上，不能靠人工核对。
 const spy={connect:async()=>{
  const db=await pool.connect(),query=db.query.bind(db) as (...args:unknown[])=>unknown
  db.query=((...args:unknown[])=>{texts.push(typeof args[0]==='string'?args[0]:String((args[0] as {text?:string}|undefined)?.text));params.push(JSON.stringify(args[1]??(args[0] as {values?:unknown}|undefined)?.values??null));return query(...args)}) as PoolClient['query']
  return db
 }}
 const service=new BusinessLedgerService(spy as unknown as Pool,{now:()=>NOW},definitions,options.actionAvailability===undefined?undefined:async()=>options.actionAvailability!)
 return {
  owner,actor,service,stored,texts,params,now:NOW,
  latestReceivedAt:stored.length?stored.map(row=>row.receivedAt).sort().at(-1)!:null,
  seed:(items:unknown[])=>seed(owner,items),
  push:async(index:number,fields:Array<[string,string]>)=>seed(owner,[alertWith(index,fields)]),
  bump:async(id:string,severity:string)=>{
   const base=rows.find(row=>row.id===id)!
   return seed(owner,[{...base,version:base.version+1,fields:base.fields.map(field=>field.label==='严重度'?{label:'严重度',value:severity}:field)}])
  },
  view:async(viewId:string,input:Record<string,unknown>={scope:'SOC'})=>{
   const ledger=await service.read(actor,input)
   return ledger.blocks.flatMap(block=>block.views).find(row=>row.viewId===viewId)!
  },
 }
}

test('执行工具动作只在服务端确认连接可用时给业务台账入口',async()=>{
 const unavailable=await fixture({objects:1,actionAvailability:false,mutate:value=>{value.objectTypes[0]!.defaultAction='isolate-endpoint'}})
 const hidden=(await unavailable.service.read(unavailable.actor,{scope:'SOC'})).blocks.find(block=>block.objectType.definition.id==='alert-ticket')!.defaultAction
 assert.deepEqual(hidden,{actionId:'isolate-endpoint',title:'隔离这台主机',targetKind:'execution-tool',available:false})
 const available=await fixture({objects:1,actionAvailability:true,mutate:value=>{value.objectTypes[0]!.defaultAction='isolate-endpoint'}})
 const shown=(await available.service.read(available.actor,{scope:'SOC'})).blocks.find(block=>block.objectType.definition.id==='alert-ticket')!.defaultAction
 assert.deepEqual(shown,{actionId:'isolate-endpoint',title:'隔离这台主机',targetKind:'execution-tool',available:true})
})

test('分布视图按声明的维度聚合，覆盖率三项如实回报',async()=>{
 const f=await fixture({objects:12})
 const ledger=await f.service.read(f.actor,{scope:'SOC'})
 const block=ledger.blocks.find(row=>row.objectType.definition.id==='alert-ticket')!
 const view=block.views.find(row=>row.viewId==='soc-risk-distribution')!
 // 12 条里 1..12：severity 按 index%3 轮转（各 4 条），index%5===0 的 5、10 判定为已确认维护被 filters 筛掉。
 assert.deepEqual(view.measures,[{id:'total',label:'条数'}],'count 度量不绑字段，因此不带 fieldType')
 assert.deepEqual([view.kind,view.chart,view.title],['distribution','bar','风险分布'],'形态、图表与标题逐字照声明带出去，界面不反推')
 assert.equal(view.dimensionValues,3,'截断前的组数：三个严重度取值都成了桶')
 assert.equal(view.rows.reduce((total,row)=>total+(row.values[0]??0),0),10,'被 verdict 筛掉的两条不计入')
 assert.equal(view.rows[0]!.dimension,'高','按度量降序：高 4 条排首位')
 assert.deepEqual([...view.rows].map(row=>row.dimension).sort(),['中','低','高'])
 assert.ok(view.rows.every(row=>row.label===row.dimension),'枚举维度的界面文案就是声明取值本身')
 assert.equal(view.coverage.objects,12,'覆盖率分母是已同步的对象数，不受视图筛选影响')
 assert.equal(view.coverage.truncated,false)
 assert.equal(view.coverage.latestReceivedAt,f.latestReceivedAt)
 assert.equal(view.definitionHash.length,64)
 assert.equal(view.viewVersion,'1.0.0')
 assert.deepEqual(view.missingFields,[],'字段全部解析得出时不报缺失')
 assert.equal(view.scope,'SOC');assert.equal(view.objectType,'alert-ticket')
 assert.equal(block.objects,12)
 assert.deepEqual(block.source,{sourceId:'security-alert-http',connected:true})
 assert.deepEqual(block.defaultAction,{actionId:'assign-alert-review',title:'交给同事核对',targetKind:'work-template',available:true})
 // 块级覆盖面与缺失披露：一张视图都没声明的块也靠这两位上屏（复审 HIGH-2）。
 assert.deepEqual(block.coverage,{objects:12,latestReceivedAt:f.latestReceivedAt,truncated:false})
 assert.deepEqual(block.progress,{unfinished:10,waitingForYou:0,latestChangedAt:'2026-09-16T11:45:00.000Z'},'概览阶段与最近变化必须来自对象类型声明及固定快照')
 assert.deepEqual(block.missingFields,['incident'],'块级缺失是全量的：12 条都没有关联调查')
 const incident=ledger.blocks.find(row=>row.objectType.definition.id==='incident-ticket')!
 assert.equal(incident.views.length,0,'这个块一张视图都没声明')
 assert.deepEqual(incident.coverage,{objects:0,latestReceivedAt:null,truncated:false},'零视图块照样有分母交代')
 assert.deepEqual(incident.missingFields,[],'一条对象都没同步进来时没有可报的缺失')
})

test('只算每个对象的当前版本，旧版本不重复计数',async()=>{
 const f=await fixture({objects:3})
 await f.bump('soc-alert-1','低')
 const view=await f.view('soc-risk-distribution')
 assert.equal(view.rows.reduce((total,row)=>total+(row.values[0]??0),0),3,'总数仍是对象数，不是快照行数')
 assert.equal(view.rows.find(row=>row.dimension==='低')?.values[0],2)
 assert.equal(view.coverage.objects,3)
})

test('五种字段的解析边界：解析不出来是缺失，不是 0，也不落其他桶',async()=>{
 const f=await fixture({objects:0})
 await f.push(9001,[['严重度','紧急'],['首次出现','2026/09/16'],['涉及账号数','abc'],['关联调查','../别的范围/x']])
 const view=await f.view('soc-risk-distribution')
 assert.deepEqual(view.rows,[],'enum 没命中声明取值即缺失，不进任何桶')
 assert.deepEqual(view.missingFields,['severity','verdict'],'缺失披露只覆盖本视图引用到的字段，按声明顺序')
 const trend=await f.view('soc-alert-trend')
 assert.deepEqual(trend.rows,[],'datetime 不满足 new Date(v).toISOString()===v 即缺失')
 assert.deepEqual(trend.missingFields,['severity','first-seen-at'],'维度、时间窗与度量 where 引用到的字段都算')
 const board=await f.view('soc-pending-board')
 assert.deepEqual(board.missingFields,['verdict'])
 assert.equal(board.rows.length,1)
 assert.equal(board.rows[0]!.values[0],0,'count 度量没有可计的对象时是 0；被判缺失的是字段，不是计数本身')
})

test('时间窗与度量各自的 where 是与关系，趋势按桶起点给稳定键与本地化文案',async()=>{
 const f=await fixture({objects:6,spreadDays:60})
 const trend=await f.view('soc-alert-trend')
 assert.ok(trend.rows.length,'窗内至少有一天有数据')
 assert.ok(trend.rows.every(row=>row.dimension===new Date(row.dimension).toISOString()),'时间桶的 dimension 是桶起点 ISO 时刻')
 assert.ok(trend.rows.every(row=>row.label&&row.label!==row.dimension),'label 是服务端一次算好的界面文案')
 assert.ok(trend.rows.length<=30)
 assert.ok(trend.rows.every(row=>Date.parse(row.dimension)>=Date.parse(f.now)-31*DAY),'last-30d 之外的不进桶')
 assert.equal(trend.measures.length,3)
 assert.ok(trend.rows.every(row=>row.values.length===3))
 // 六条里 index%60 使 1..6 分别落在 now-1d..now-6d；每条只命中自己那一档严重度，其余两档为 0。
 assert.ok(trend.rows.every(row=>row.values.filter(value=>value===1).length===1&&row.values.filter(value=>value===0).length===2))
 const sorted=trend.rows.map(row=>row.dimension)
 assert.deepEqual(sorted,[...sorted].sort(),'按维度升序')
})

test('扫描行上限 5000 触发 truncated，并且覆盖率只认真正参与计算的对象',async()=>{
 const f=await fixture({objects:5001})
 const view=await f.view('soc-pending-board')
 assert.equal(view.coverage.truncated,true)
 assert.equal(view.coverage.objects,5000)
})

test('引用目标超过 5000 个一律拒绝整条台账计算，不做截断（loadIds 与块级扫描同口径披露，复审 MEDIUM-2）',async()=>{
 const f=await fixture({objects:1,withReference:true})
 await f.seed(Array.from({length:businessLedgerLimits.scanRows+1},(_value,index)=>incidentWith('inc-'+index)))
 await assert.rejects(f.service.read(f.actor,{scope:'SOC'}),{code:'teloa/source-unavailable'})
})

test('同一次请求里的多个视图来自同一批行',async()=>{
 const f=await fixture({objects:4})
 const ledger=await f.service.read(f.actor,{scope:'SOC'})
 const stamps=new Set(ledger.blocks.flatMap(block=>block.views.map(view=>view.computedAt)))
 assert.equal(stamps.size,1)
 assert.equal([...stamps][0],ledger.computedAt)
 assert.equal(ledger.schema,'teloa.business-ledger/v1')
 assert.equal(ledger.scope,'SOC')
 assert.deepEqual(ledger.actions.map(row=>row.definition.id),['assign-alert-review','isolate-endpoint'])
})

test('声明里的字符串一个都不进 SQL 文本',async()=>{
 const f=await fixture({objects:2,withList:true})
 await f.service.read(f.actor,{scope:'SOC',objectType:'alert-ticket'})
 assert.ok(f.texts.length)
 for(const literal of ['严重度','已确认维护','alert-ticket','security-alert-http','首次出现','还没有人看'])
  for(const text of f.texts)assert.ok(!text.includes(literal),'SQL 文本不得含声明字符串 '+literal+'：'+text)
})

test('列表视图带 objects 段，与 rows 同序同 dimension，摘要逐条可复算',async()=>{
 const f=await fixture({objects:3,withList:true})
 const ledger=await f.service.read(f.actor,{scope:'SOC',objectType:'alert-ticket'})
 assert.deepEqual(ledger.blocks.map(block=>block.objectType.definition.id),['alert-ticket'],'指名对象类型时只算这一个块')
 const list=ledger.blocks[0]!.views.find(row=>row.viewId==='soc-alert-list')!
 assert.equal(list.objects?.length,list.rows.length)
 assert.equal(list.rows.length,3)
 assert.deepEqual(list.objects?.map(row=>row.id),list.rows.map(row=>row.dimension))
 assert.deepEqual(list.rows.map(row=>row.label),list.objects?.map(row=>row.title))
 const hashes=new Map(f.stored.map(row=>[row.id,row.snapshotHash]))
 for(const object of list.objects!)assert.equal(object.snapshotHash,hashes.get(object.id),'objects 段的固定摘要与落库那一刻逐字相同')
 assert.deepEqual(list.rows.map(row=>row.values[0]),[1,2,3],'清单行的度量按该对象一条算')
})

test('台账 match：只在 list 视图取前 N 行之前过滤，分析视图与覆盖率保持全量；_id 恰含该对象；过滤值不进 SQL 文本与参数',async()=>{
 const f=await fixture({objects:12,withList:true,listLimit:3})
 const list=(ledger:Awaited<ReturnType<typeof f.service.read>>)=>ledger.blocks[0]!.views.find(row=>row.viewId==='soc-alert-list')!
 const analysis=(ledger:Awaited<ReturnType<typeof f.service.read>>)=>ledger.blocks[0]!.views.filter(row=>row.kind!=='list')
 const all=await f.service.read(f.actor,{scope:'SOC',objectType:'alert-ticket'})
 const high=await f.service.read(f.actor,{scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:'高'}})
 // 1..12 里严重度为「高」的是 3、6、9、12；按标识升序取前 3 条之前先过滤，否则前 3 条（1、10、11）一条「高」都没有。
 assert.deepEqual(list(high).objects?.map(row=>row.id),['soc-alert-12','soc-alert-3','soc-alert-6'])
 assert.ok(list(high).objects!.every(object=>object.fields.find(field=>field.label==='严重度')?.value==='高'))
 assert.equal(list(high).dimensionValues,4,'截断前的行数按过滤后算')
 assert.deepEqual(list(high).coverage,list(all).coverage,'覆盖率仍是已同步的全部对象')
 assert.deepEqual(analysis(high),analysis(all),'分析视图不受 match 影响')
 assert.deepEqual(high.blocks[0]!.coverage,all.blocks[0]!.coverage)
 const one=await f.service.read(f.actor,{scope:'SOC',objectType:'alert-ticket',match:{field:'_id',value:'soc-alert-7'}})
 assert.deepEqual(list(one).objects?.map(row=>row.id),['soc-alert-7'])
 const none=await f.service.read(f.actor,{scope:'SOC',objectType:'alert-ticket',match:{field:'host',value:'不存在的主机'}})
 assert.deepEqual(list(none).objects,[])
 assert.ok(f.texts.length&&f.params.length,'确实记到了执行的 SQL，下面的「不进 SQL」断言才不是永真')
 for(const value of ['高','soc-alert-7','不存在的主机']){
  for(const text of f.texts)assert.ok(!text.includes(value),'SQL 文本不得含过滤值 '+value+'：'+text)
  for(const param of f.params)assert.ok(!param.includes(value)&&!param.includes(JSON.stringify(value).slice(1,-1)),'SQL 参数不得含过滤值 '+value+'：'+param)
 }
 for(const input of [
  {scope:'SOC',match:{field:'severity',value:'高'}},
  {scope:'SOC',objectType:'alert-ticket',match:{field:'account-count',value:'1'}},
  {scope:'SOC',objectType:'alert-ticket',match:{field:'first-seen-at',value:NOW}},
  {scope:'SOC',objectType:'alert-ticket',match:{field:'nope',value:'x'}},
  {scope:'SOC',objectType:'alert-ticket',match:{field:'Severity',value:'高'}},
  {scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:'高'.repeat(201)}},
  {scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:''}},
  {scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:'高\n'}},
  {scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:1}},
  {scope:'SOC',objectType:'alert-ticket',match:{field:'severity'}},
  {scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:'高',op:'ne'}},
  {scope:'SOC',objectType:'alert-ticket',match:'severity=高'},
  {scope:'SOC',objectType:'alert-ticket',match:null},
 ])await assert.rejects(f.service.read(f.actor,input),{code:'teloa/invalid-input'},JSON.stringify(input))
 assert.equal(list(await f.service.read(f.actor,{scope:'SOC',objectType:'alert-ticket',match:{field:'severity',value:'高'.repeat(200)}})).objects?.length,0,'200 字是上限、仍可收')
})

test('不带 objectType 时不算 list 视图，也不带 objects 段',async()=>{
 const f=await fixture({objects:3,withList:true})
 const ledger=await f.service.read(f.actor,{scope:'SOC'})
 assert.ok(ledger.blocks[0]!.views.every(view=>view.objects===undefined))
 assert.ok(ledger.blocks.flatMap(block=>block.views).every(view=>view.viewId!=='soc-alert-list'))
})

test('tombstone 版本不进台账：被删对象不计数、不出现在清单，回包快照不带 deletedAt',async()=>{
 const f=await fixture({objects:3,withList:true})
 const target=f.stored[0]!
 const db=await pool.connect()
 try{await db.query('begin');assert.equal(await new BusinessWarehouseService(pool,{now:()=>NOW}).tombstone(db,f.owner,'SOC','alert-ticket',target.id,'security-alert-http'),true);await db.query('commit')}finally{db.release()}
 const ledger=await f.service.read(f.actor,{scope:'SOC',objectType:'alert-ticket'})
 const block=ledger.blocks[0]!,list=block.views.find(row=>row.viewId==='soc-alert-list')!
 assert.equal(block.coverage.objects,2)
 assert.deepEqual(list.objects?.map(row=>row.id),f.stored.slice(1).map(row=>row.id))
 assert.ok(list.objects?.every(row=>!('deletedAt' in row)))
})

test('数据源未连接只标未接上，不以空台账替代',async()=>{
 const f=await fixture({objects:2,activeSources:new Set<string>()})
 const ledger=await f.service.read(f.actor,{scope:'SOC'})
 assert.equal(ledger.blocks[0]!.source.connected,false)
 assert.equal(ledger.blocks[0]!.objects,2)
})

test('范围闸：不属于本人范围集合的范围一律 forbidden，general 一律拒绝',async()=>{
 const f=await fixture({objects:1})
 await assert.rejects(f.service.read({ownerId:f.actor.ownerId,scopeIds:['SOC']},{scope:'AppSec'}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.read(f.actor,{scope:'general'}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.read(f.actor,{scope:'SOC',extra:1}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.read(f.actor,{scope:'SOC',objectType:'不合法的标识'}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.read({ownerId:'',scopeIds:['SOC']},{scope:'SOC'}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.read(f.actor,{scope:'SOC',objectType:'not-declared'}),{code:'teloa/source-unavailable'})
 const controller=new AbortController();controller.abort()
 await assert.rejects(f.service.read(f.actor,{scope:'SOC'},controller.signal),{name:'AbortError'})
})

test('引用落在同范围的已有对象上即成立，可作维度，且不随入参带没带 objectType 漂移',async()=>{
 const f=await fixture({objects:0,withReference:true})
 await f.seed([incidentWith('inc-1')])
 await f.seed([alertWith(9101,[['严重度','高'],['主机','prod-1'],['当前判定','还没有人看'],['首次出现',new Date(Date.parse(NOW)-3600000).toISOString()],['关联调查','inc-1']])])
 const all=await f.view('soc-incident-link')
 assert.deepEqual(all.rows.map(row=>[row.dimension,row.values[0]]),[['inc-1',1]])
 assert.deepEqual(all.missingFields,[],'引用成立就不算缺失')
 const one=await f.view('soc-incident-link',{scope:'SOC',objectType:'alert-ticket'})
 assert.deepEqual(one.rows,all.rows,'引用目标的标识集按范围建，不受选中哪几个块影响')
 assert.deepEqual(one.missingFields,all.missingFields)
})

test('形状合法但本范围不存在的引用标识判缺失，不落任何桶',async()=>{
 const f=await fixture({objects:0,withReference:true})
 await f.seed([alertWith(9102,[['严重度','高'],['主机','prod-1'],['当前判定','还没有人看'],['首次出现',new Date(Date.parse(NOW)-3600000).toISOString()],['关联调查','inc-404']])])
 const view=await f.view('soc-incident-link')
 assert.deepEqual(view.rows,[],'跨范围或不存在的引用一律视为缺失')
 assert.deepEqual(view.missingFields,['incident'])
})

test('声明改一个字就换一个 definitionHash，viewVersion 跟着声明走',async()=>{
 const before=await (await fixture({objects:1})).view('soc-risk-distribution')
 const after=await (await fixture({objects:1,mutate:value=>{value.views[1]!.title='风险分布（改）';value.views[1]!.version='1.1.0'}})).view('soc-risk-distribution')
 assert.equal(before.viewVersion,'1.0.0');assert.equal(after.viewVersion,'1.1.0')
 assert.notEqual(before.definitionHash,after.definitionHash,'声明字节一变摘要就变，旧结果整条作废')
 assert.equal(after.definitionHash.length,64)
})

test('sum/avg/min 与 datetime 的 max 各按声明算，datetime 回的是毫秒时刻',async()=>{
 const f=await fixture({objects:4,withStats:true})
 const view=await f.view('soc-alert-stats')
 // 1..4：severity 按 index%3 → 中{1,4}、低{2}、高{3}；account-count 取 index%5 → 1、2、3、4。
 const middle=view.rows.find(row=>row.dimension==='中')!
 assert.deepEqual(middle.values.slice(0,3),[5,2.5,1],'sum / avg / min 各算各的')
 assert.equal(middle.values[3],Date.parse(NOW)-3600000,'datetime 度量回毫秒时刻，客户端按度量绑定的字段类型还原')
 assert.deepEqual(view.measures.map(row=>row.id),['accounts-sum','accounts-avg','accounts-min','seen-max'])
 // 度量绑定字段的类型随结果带出去：界面不再拿度量标识撞同名字段猜（复审 MEDIUM-2）。
 assert.deepEqual(view.measures.map(row=>row.fieldType),['number','number','number','datetime'])
})

test('大盘卡与清单的形态位：count 度量不带 fieldType，board-card 的 dimensionValues 恒为 1',async()=>{
 const f=await fixture({objects:4,withList:true})
 const board=await f.view('soc-pending-board')
 assert.deepEqual([board.kind,board.chart,board.title],['board-card','number','待处理告警'])
 assert.equal(board.dimensionValues,1)
 assert.deepEqual(board.measures,[{id:'pending',label:'条'}],'count 不绑字段，fieldType 整键缺省')
 const list=(await f.service.read(f.actor,{scope:'SOC',objectType:'alert-ticket'})).blocks[0]!.views.find(row=>row.viewId==='soc-alert-list')!
 assert.deepEqual([list.kind,list.chart,list.title],['list','table','告警清单'])
 assert.equal(list.dimensionValues,4,'清单的"组数"就是筛选后的对象条数')
})

test('维度取值多于行数上限时 dimensionValues 报截断前的组数',async()=>{
 const f=await fixture({objects:0,withStats:true,mutate:value=>{
  // 把风险分布的行数上限压到 1：三个严重度取值只画得下一行，界面要能说清"共 3 项、显示前 1 项"。
  const view=value.views.find(row=>row.id==='soc-risk-distribution')!
  view.limit=1;view.dimension!.limit=1
 }})
 const seen=new Date(Date.parse(NOW)-3600000).toISOString()
 await f.seed(['高','中','低'].map((severity,index)=>alertWith(9200+index,[['严重度',severity],['主机','prod-1'],['当前判定','还没有人看'],['首次出现',seen]])))
 const view=await f.view('soc-risk-distribution')
 assert.equal(view.rows.length,1)
 assert.equal(view.dimensionValues,3,'截断前有三个桶')
})

test('overdue 时间窗左开右开：恰好等于计算时刻的不算逾期',async()=>{
 const f=await fixture({objects:3,withStats:true})
 await f.seed([alertWith(9103,[['严重度','高'],['主机','prod-1'],['当前判定','还没有人看'],['首次出现',NOW]])])
 const board=await f.view('soc-overdue-board')
 assert.equal(board.rows[0]!.values[0],3,'三条早于计算时刻的计入，等于计算时刻的那条不计入')
})

test('number 解析守住 1e15 上界，部分对象读不出来即如实披露',async()=>{
 const f=await fixture({objects:0,withStats:true})
 const seen=new Date(Date.parse(NOW)-3600000).toISOString()
 await f.seed([
  alertWith(9104,[['严重度','高'],['主机','prod-1'],['当前判定','还没有人看'],['首次出现',seen],['涉及账号数','1000000000000000']]),
  alertWith(9105,[['严重度','高'],['主机','prod-2'],['当前判定','还没有人看'],['首次出现',seen],['涉及账号数','1e16']]),
 ])
 const view=await f.view('soc-alert-stats')
 const high=view.rows.find(row=>row.dimension==='高')!
 assert.equal(high.values[0],1e15,'恰好 1e15 可用；超过上界的那条按缺失处理，不并进合计')
 assert.deepEqual(view.missingFields,['account-count'],'两条里有一条读不出来就要说')
})

test('清单视图按声明的行数上限截断，objects 段跟着截',async()=>{
 const f=await fixture({objects:5,withList:true,listLimit:2})
 const ledger=await f.service.read(f.actor,{scope:'SOC',objectType:'alert-ticket'})
 const list=ledger.blocks[0]!.views.find(row=>row.viewId==='soc-alert-list')!
 assert.equal(list.rows.length,2)
 assert.equal(list.objects?.length,2)
 assert.deepEqual(list.objects?.map(row=>row.id),list.rows.map(row=>row.dimension))
 assert.equal(list.coverage.objects,5,'覆盖率报的是已同步的对象数，不是截断后的行数')
})

test('固定快照被改写即 storage-corrupt，不以缺省值继续算',async()=>{
 const f=await fixture({objects:2})
 await pool.query("update teloa_business_object_snapshots set snapshot=jsonb_set(snapshot,'{summary}',to_jsonb('被改写'::text)) where owner_id=$1",[f.owner])
 await assert.rejects(f.service.read(f.actor,{scope:'SOC'}),{code:'teloa/storage-corrupt'})
})

/** 七种字段里新增的两种（时长与布尔）：字段与视图都在用例内追加，共享夹具不动。 */
function withDurationAndBoolean(value:SocBundle){
 value.objectTypes[0]!.fields.push(
  {name:'handling-duration',label:'处置时长',type:'duration',required:false,from:'处置时长'} as never,
  {name:'false-positive',label:'是否误报',type:'boolean',required:false,from:'是否误报'} as never,
 )
 value.views.push(
  {format:'teloa.business-view/v1',id:'soc-handling-stats',version:'1.0.0',domain:'SOC',title:'处置时长统计',kind:'distribution',chart:'table',objectType:'alert-ticket',
   dimension:{field:'severity',limit:3},measures:[{id:'avg',label:'平均',aggregation:'avg',field:'handling-duration'},{id:'sum',label:'合计',aggregation:'sum',field:'handling-duration'}],
   filters:[],sort:{by:'dimension',direction:'asc'},limit:3} as never,
  {format:'teloa.business-view/v1',id:'soc-false-positive',version:'1.0.0',domain:'SOC',title:'误报分布',kind:'distribution',chart:'bar',objectType:'alert-ticket',
   dimension:{field:'false-positive',limit:2},measures:[{id:'total',label:'条数',aggregation:'count'}],filters:[],sort:{by:'dimension',direction:'asc'},limit:2} as never,
  {format:'teloa.business-view/v1',id:'soc-slow-fp-board',version:'1.0.0',domain:'SOC',title:'慢处置误报',kind:'board-card',chart:'number',objectType:'alert-ticket',
   measures:[{id:'total',label:'条',aggregation:'count'}],filters:[{field:'handling-duration',op:'gte',values:['PT1H']},{field:'false-positive',op:'eq',values:['是']}],limit:1} as never,
 )
}

test('duration 归一为秒参与 sum/avg，boolean 维度把 是/1/TRUE 归同一桶；解析不出的即缺失并披露',async()=>{
 const f=await fixture({objects:0,mutate:withDurationAndBoolean})
 const seen=new Date(Date.parse(NOW)-3600000).toISOString()
 const common:Array<[string,string]>=[['严重度','高'],['主机','prod-1'],['当前判定','还没有人看'],['首次出现',seen]]
 await f.seed([
  alertWith(9301,[...common,['处置时长','PT2H'],['是否误报','是']]),
  alertWith(9302,[...common,['处置时长','n/a'],['是否误报','1']]),
  alertWith(9303,[...common,['处置时长','1800'],['是否误报','TRUE']]),
  alertWith(9304,[...common,['处置时长','PT30M'],['是否误报','no']]),
 ])
 const stats=await f.view('soc-handling-stats')
 const high=stats.rows.find(row=>row.dimension==='高')!
 assert.deepEqual(high.values,[3600,10800],'avg 只计入解析得出的三条（7200+1800+1800）/3，"n/a" 不算 0')
 assert.deepEqual(stats.missingFields,['handling-duration'],'四条里有一条读不出来就要说')
 assert.deepEqual(stats.measures.map(row=>row.fieldType),['duration','duration'],'度量绑定字段的类型随结果带出去')
 const distribution=await f.view('soc-false-positive')
 assert.deepEqual(distribution.rows.map(row=>[row.dimension,row.values[0]]),[['true',3]],'是 / 1 / TRUE 同一桶，"no" 不落任何桶')
 assert.deepEqual(distribution.missingFields,['false-positive'])
 const board=await f.view('soc-slow-fp-board')
 assert.equal(board.rows[0]!.values[0],1,'duration 的 gte 与 boolean 的 eq 字面量各按本类型解析后再比：只有 PT2H 且 是 的那条')
})

test('duration 不可作维度、boolean 不接受 in 算子：读取层按能力表拒绝',async()=>{
 const dimension=await fixture({objects:1,mutate:value=>{withDurationAndBoolean(value);value.views.push({format:'teloa.business-view/v1',id:'soc-bad-dimension',version:'1.0.0',domain:'SOC',title:'时长分布',kind:'distribution',chart:'bar',objectType:'alert-ticket',
  dimension:{field:'handling-duration',limit:3},measures:[{id:'total',label:'条数',aggregation:'count'}],filters:[],sort:{by:'dimension',direction:'asc'},limit:3} as never)}})
 await assert.rejects(dimension.service.read(dimension.actor,{scope:'SOC'}),{code:'teloa/source-unavailable'})
 const operator=await fixture({objects:1,mutate:value=>{withDurationAndBoolean(value);value.views.push({format:'teloa.business-view/v1',id:'soc-bad-operator',version:'1.0.0',domain:'SOC',title:'误报卡',kind:'board-card',chart:'number',objectType:'alert-ticket',
  measures:[{id:'total',label:'条',aggregation:'count'}],filters:[{field:'false-positive',op:'in',values:['是','否']}],limit:1} as never)}})
 await assert.rejects(operator.service.read(operator.actor,{scope:'SOC'}),{code:'teloa/source-unavailable'})
})
