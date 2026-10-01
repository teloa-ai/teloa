import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir,tmpdir} from 'node:os'
import {join,relative,sep} from 'node:path'
import {mkdtemp,readFile,readdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,businessCustomizationLimits,type BusinessDefinitionKind} from '@teloa/contract'
import {createHash} from 'node:crypto'
import {businessLocalDefinitionHash} from '../src/work/business-definition-local.ts'
import {
 MarketContentStore,initializeMarketContents,
 createIndustryLoadSource,IndustryLoadService,initializeIndustryLoads,type IndustryLoadRecord,
 IndustryDataSourceService,IndustryDataSourceSource,initializeIndustryDataSources,
 BusinessDataService,initializeBusinessData,
 BusinessDefinitionSourceReader,BusinessLedgerService,BusinessDefinitionPreviewService,
 BusinessLocalDefinitionService,initializeBusinessDefinitions,initializePageCreateDrafts,PageCreateDraftService,PageCreatePreviewService,type BusinessLocalActor,
 initializeBusinessWarehouse,initializeBusinessSqlRole,initializeBusinessWidgets,BusinessSqlExecutor,businessSqlPoolConfig,BusinessWidgetService,type BusinessSyncSourceResolver,
} from '../src/index.ts'

/**
 * 业务定制草案预览的真库验收：差异按规范化路径逐条给出、影响范围只含标识、试算与生效之后的台账逐字相同，
 * 以及"预览全程一个字节也不写"。三块都在同一次 `repeatable read read only` 事务里算完。
 */

let container:StartedPostgreSqlContainer,pool:Pool,reader:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool)
 await initializeIndustryLoads(pool)
 await initializeIndustryDataSources(pool)
 await initializeBusinessData(pool)
 await initializeBusinessDefinitions(pool)
 await initializePageCreateDrafts(pool)
 // 看板三种声明的试算：快照安全函数、只读角色与结果快照表。
 await initializeBusinessWarehouse(pool)
 // 执行器专用连接池按口令文件以只读角色直接登录（role 模式拒绝其他会话用户）。
 const secretPath=join(await mkdtemp(join(tmpdir(),'teloa-preview-')),'business-sql-reader.json')
 const role=await initializeBusinessSqlRole(pool,secretPath)
 reader=new Pool(await businessSqlPoolConfig({connectionString:container.getConnectionUri()},role,secretPath))
 await initializeBusinessWidgets(pool)
},{timeout:120000})
after(async()=>{await reader?.end();await pool?.end();await container?.stop()})

/**
 * 全套服务共用一个钉死的时刻：试算那一个块与生效之后读出来的那一个块要逐字比对，
 * 而 `computedAt` 取的就是这个时刻——不钉死它，两次读必然差在时间戳上，"逐字相同"就验不成了。
 */
const NOW=new Date().toISOString()
const identity={id:randomUUID,now:()=>NOW}

/** 一份与夹具 `views/soc-risk-distribution.json` 逐字相同的视图声明：差异那几条要从"只改一处"开始验。 */
function riskView(overrides:Record<string,unknown>={}):Record<string,unknown>{
 return {
  format:'teloa.business-view/v1',id:'soc-risk-distribution',version:'1.0.0',domain:'SOC',
  title:'风险分布',kind:'distribution',chart:'bar',objectType:'alert-ticket',
  dimension:{field:'severity',limit:3},
  measures:[{id:'total',label:'条数',aggregation:'count'}],
  filters:[{field:'verdict',op:'ne',values:['已确认维护']}],
  sort:{by:'measure',measureId:'total',direction:'desc'},
  limit:3,
  ...overrides,
 }
}

/**
 * 与夹具 `views/soc-risk-distribution.json` 逐字对上，连 localized 也一并带出——
 * 只有在测试要跟当前生效的模板逐路径比对差异时才需要它，否则 localized.* 会被当成"删除"多算出好几行。
 */
function riskViewMatchingTemplate(overrides:Record<string,unknown>={}):Record<string,unknown>{
 return riskView({
  version:'1.0.1',
  measures:[{id:'total',label:'条数',aggregation:'count',localized:{label:{original:'条数',defaultLocale:'en',locales:{'zh-CN':'条数',en:'Alerts'}}}}],
  localized:{title:{original:'风险分布',defaultLocale:'en',locales:{'zh-CN':'风险分布',en:'Risk distribution'}}},
  ...overrides,
 })
}

/** 一份与夹具 `object-types/alert-ticket.json` 逐字相同的对象类型声明。 */
function alertTicket(overrides:Record<string,unknown>={}):Record<string,unknown>{
 return {
  format:'teloa.business-object-type/v1',id:'alert-ticket',version:'1.0.0',domain:'SOC',
  title:'告警工单',unit:'条',lead:'来自告警平台和终端记录，进来之后先归并再判断。',
  sourceId:'security-alert-http',
  fields:[
   {name:'severity',label:'严重度',type:'enum',required:true,from:'严重度',values:['高','中','低']},
   {name:'host',label:'主机',type:'text',required:true,from:'主机'},
   {name:'verdict',label:'当前判定',type:'enum',required:true,from:'当前判定',values:['还没有人看','正在核对','等你确认','已确认维护']},
   {name:'first-seen-at',label:'首次出现',type:'datetime',required:true,from:'首次出现'},
   {name:'account-count',label:'涉及账号数',type:'number',required:false,from:'涉及账号数'},
   {name:'incident',label:'关联调查',type:'reference',required:false,from:'关联调查',referenceType:'incident-ticket'},
  ],
  defaultAction:'assign-alert-review',
  ...overrides,
 }
}

/** 递归列出一个夹具目录下的全部文件，路径按 POSIX 分隔符归一——与清单里的 `source.path` 同一写法。 */
async function walk(dir:string,base:string):Promise<string[]>{
 const entries=await readdir(dir,{withFileTypes:true})
 const paths:string[]=[]
 for(const entry of entries){
  const full=join(dir,entry.name)
  if(entry.isDirectory())paths.push(...await walk(full,base))
  else paths.push(relative(base,full).split(sep).join('/'))
 }
 return paths
}

const SEVERITIES=['高','中','低']
/** 一条告警快照，字段标签与 `alert-ticket` 声明的 `from` 逐字对上。 */
function alertSnapshot(index:number){
 const at=Date.now()-index*3600000
 return {
  scope:'SOC',type:'alert-ticket',id:'soc-alert-'+index,version:1,title:'告警 '+index,source:'EDR',
  observedAt:new Date(at).toISOString(),receivedAt:new Date(at+1000).toISOString(),
  quality:'complete' as const,summary:'告警 '+index+' 的处置说明。',
  fields:[
   {label:'严重度',value:SEVERITIES[index%3]!},
   {label:'主机',value:'prod-'+(index%5)},
   {label:'当前判定',value:'还没有人看'},
   {label:'首次出现',value:new Date(at).toISOString()},
   {label:'涉及账号数',value:String(index%4)},
  ],
 }
}

/**
 * 真夹具 + 真加载 + 真快照 + 真台账 + 预览服务。`connect:false` 时不实例化也不授权数据源，
 * 用来验"来源没接上就不画空块"那一条。
 */
async function harness(options:{connect?:boolean;boards?:boolean;resolveSource?:BusinessSyncSourceResolver}={}){
 const owner='local:'+randomUUID(),actor:BusinessLocalActor={ownerId:owner,scopeIds:['SOC']}
 const market=new MarketContentStore(pool,identity)
 const loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
 const dataSources=new IndustryDataSourceService(pool,identity,loads,new IndustryDataSourceSource(market,loads),{
  ready:async()=>({ready:true,probedAt:identity.now()}),
 })
 /** 模板侧同 localId 声明在不在，按加载项读——清单资源的 kind 与本地声明的 kind 名字不同，这里换一次。 */
 const itemKinds:Record<string,BusinessDefinitionKind>={'object-type':'object-type','business-view':'view','business-action':'action'}
 const local=new BusinessLocalDefinitionService(pool,identity,async(db,ownerId,scope)=>{
  const page=await loads.listInTransaction(db,ownerId,{})
  const found=new Map<string,string>()
  for(const load of page.items)if(load.domain===scope)for(const item of load.items){
   const kind=itemKinds[item.kind]
   if(kind)found.set(kind+'\0'+item.localId,item.version)
  }
  return found
 })
 const definitions=new BusinessDefinitionSourceReader(market,loads,{
  activeSourceIds:async(client:PoolClient,ownerId:string,loadId:string)=>{
   const rows=(await client.query(`select binding->>'sourceId' as source_id from teloa_industry_data_source_instances where owner_id=$1 and load_id=$2 and state='active'`,[ownerId,loadId])).rows as Array<{source_id:string}>
   return new Set(rows.map(row=>row.source_id))
  },
 },local)
 const ledger=new BusinessLedgerService(pool,identity,definitions)
 const widgets=new BusinessWidgetService(pool,identity,new BusinessSqlExecutor(reader,identity,'role'),ledger)
 const preview=options.boards
  ?new BusinessDefinitionPreviewService(pool,identity,local,definitions,ledger,{widgets,...(options.resolveSource?{resolveSource:options.resolveSource}:{})})
  :new BusinessDefinitionPreviewService(pool,identity,local,definitions,ledger)

 const base=fileURLToPath(new URL('../../../tests/fixtures/业务定制层/SOC/',import.meta.url))
 const paths=await walk(base,base)
 const files=await Promise.all(paths.map(async path=>({path,bytes:new Uint8Array(await readFile(join(base,path)))})))
 const saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'SOC'},manifestPath:'teloa.json',files,references:[]})
 const load:IndustryLoadRecord=await loads.create(owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'SOC'}})
 if(options.connect!==false){
  const item=load.items.find(row=>row.localId==='soc-alert-source')!
  const created=await dataSources.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:item.instanceId})
  await dataSources.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:created.revision},new AbortController().signal)
 }
 const port={id:'security-alert-http',scopes:['SOC'],query:async()=>({schema:'teloa.data-source-page/v1',sourceId:'security-alert-http',scope:'SOC',capturedAt:identity.now(),items:Array.from({length:9},(_value,index)=>alertSnapshot(index+1))})}
 await new BusinessDataService(pool,port as never).query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:9})

 /** 写一份草案（不生效）：预览只认 `status:'draft'` 的那一种。 */
 const draft=(kind:BusinessDefinitionKind,definition:Record<string,unknown>)=>
  local.draft(actor,{scope:'SOC',kind,definition,requestId:randomUUID()})
 return {owner,actor,local,ledger,preview,draft,definitions,widgets}
}

test('差异按规范化路径逐条给出，改一个没有本地化绑定的字段只出一行',async()=>{
 const f=await harness()
 // 夹具 `soc-risk-distribution` 的 title 已经挂了 localized 原文：改 title 会连带 localized.title.* 一起变，
 // 不再是「一行」。改 dimension.limit（没有本地化绑定）才能验"逐条给出"而不是"整份重排"这条性质。
 const draft=await f.draft('view',riskViewMatchingTemplate({dimension:{field:'severity',limit:2}}))
 const preview=await f.preview.preview(f.actor,{draftId:draft.id})
 assert.equal(preview.schema,'teloa.business-definition-preview/v1')
 assert.deepEqual(preview.draft,draft)
 // 基准是当前生效的那一份：本地还没有版本，因此是模板侧那一版，来源逐字取 source.origin。
 assert.equal(preview.base.origin,'template')
 assert.equal(preview.base.semver,'1.0.1')
 assert.match(String(preview.base.definitionHash),/^[a-f0-9]{64}$/)
 assert.deepEqual(preview.diff,[{path:'dimension.limit',before:'3',after:'2'}])
 assert.equal(preview.diffTruncated,false)
})

test('页内新建的业务声明复用同一份预览和生效路径，页面草案仅由落定端点改状态',async()=>{
 const f=await harness(),pages=new PageCreateDraftService(pool,identity)
 // 契约把标题的本地化原文钉在 localized.title.original 上：改标题必须同步改它与 locales.zh-CN，否则 teloa/invalid-input。
 const pageDraft=await pages.draft(f.actor,{entity:'business-definition',scope:'SOC',body:riskViewMatchingTemplate({
  version:'1.1.0',title:'风险分布（页内新建）',
  localized:{title:{original:'风险分布（页内新建）',defaultLocale:'en',locales:{'zh-CN':'风险分布（页内新建）',en:'Risk distribution'}}},
 }),requestId:randomUUID()})
 const pagePreview=new PageCreatePreviewService(pool,identity,pages,f.preview)
 const result=await pagePreview.preview(f.actor,{draftId:pageDraft.id})
 const preview=result.businessPreview
 assert.ok(preview)
 assert.equal(preview.draft.id,pageDraft.id)
 assert.equal(preview.draft.definitionHash.length,64)
 assert.deepEqual(preview.diff,[
  {path:'localized.title.locales.zh-CN',before:'"风险分布"',after:'"风险分布（页内新建）"'},
  {path:'localized.title.original',before:'"风险分布"',after:'"风险分布（页内新建）"'},
  {path:'title',before:'"风险分布"',after:'"风险分布（页内新建）"'},
  {path:'version',before:'"1.0.1"',after:'"1.1.0"'},
 ])
 const entry=await f.local.apply(f.actor,{requestId:randomUUID(),draftId:pageDraft.id,expectedDefinitionHash:preview.draft.definitionHash,expectedCurrentVersion:0,previewReceipt:preview.receipt})
 assert.equal(entry.current?.version,1)
 // 业务生效只写本地声明版本；页面草案必须仍由 page-create-drafts/settle 落定，不能双写状态。
 assert.equal((await pages.directory(f.actor,{entity:'business-definition',scope:'SOC'})).drafts.find(item=>item.id===pageDraft.id)?.status,'draft')
})

test('确认必须带真实预览回执：缺失、伪造或另一草案的回执都不能写入版本',async()=>{
 const f=await harness()
 const definition=riskView({version:'1.1.0',title:'风险分布（回执闸）'})
 const first=await f.draft('view',definition),second=await f.draft('view',definition)
 const preview=await f.preview.preview(f.actor,{draftId:first.id})
 assert.match(preview.receipt,/^[a-f0-9]{64}$/)
 await assert.rejects(
  ()=>f.local.apply(f.actor,{requestId:randomUUID(),draftId:first.id,expectedDefinitionHash:first.definitionHash,expectedCurrentVersion:0}),
  {code:'teloa/invalid-input'},
 )
 await assert.rejects(
  ()=>f.local.apply(f.actor,{requestId:randomUUID(),draftId:first.id,expectedDefinitionHash:first.definitionHash,expectedCurrentVersion:0,previewReceipt:'0'.repeat(64)}),
  {code:'teloa/version-conflict'},
 )
 await assert.rejects(
  ()=>f.local.apply(f.actor,{requestId:randomUUID(),draftId:second.id,expectedDefinitionHash:second.definitionHash,expectedCurrentVersion:0,previewReceipt:preview.receipt}),
  {code:'teloa/version-conflict'},
 )
 const entry=await f.local.apply(f.actor,{requestId:randomUUID(),draftId:first.id,expectedDefinitionHash:first.definitionHash,expectedCurrentVersion:0,previewReceipt:preview.receipt})
 assert.equal(entry.current?.version,1)
})

test('新增声明（模板与本地都没有同 localId）时 base.origin==="none"，diff 全是 before:null',async()=>{
 const f=await harness()
 const draft=await f.draft('view',riskView({id:'soc-local-only',title:'只在本地的视图'}))
 const preview=await f.preview.preview(f.actor,{draftId:draft.id})
 assert.deepEqual(preview.base,{origin:'none'},'新增声明没有基准版本，也没有基准摘要')
 assert.ok(preview.diff.length>10)
 assert.ok(preview.diff.every(row=>row.before===null&&row.after!==null))
 assert.ok(preview.diff.some(row=>row.path==='title'&&row.after==='"只在本地的视图"'))
 // 路径并集按字典序，数组保序展开成 `[i]`：差异是逐条路径，不是整份正文重排。
 assert.deepEqual([...preview.diff].map(row=>row.path).sort(),preview.diff.map(row=>row.path))
 assert.ok(preview.diff.some(row=>row.path==='filters[0].values[0]'&&row.after==='"已确认维护"'))
})

test('差异超过 400 行时 diffTruncated 为真，且只列前 400 行',async()=>{
 const f=await harness()
 // 20 个枚举字段 × 32 个取值：路径数远超 400，而每一条都是新增（基准是"没有"），因此差异行数就是路径数。
 const fields=Array.from({length:20},(_value,index)=>({
  name:'field-'+index,label:'字段 '+index,type:'enum',required:false,from:'来源 '+index,
  values:Array.from({length:32},(_item,value)=>'取值 '+index+'-'+value),
 }))
 const draft=await f.draft('object-type',{
  format:'teloa.business-object-type/v1',id:'wide-type',version:'1.0.0',domain:'SOC',
  title:'很宽的对象类型',unit:'条',lead:'只为把差异撑过上限。',sourceId:'security-alert-http',fields,
 })
 const preview=await f.preview.preview(f.actor,{draftId:draft.id})
 assert.equal(preview.diffTruncated,true)
 assert.equal(preview.diff.length,businessCustomizationLimits.diffRows)
 assert.equal(preview.diff[0]!.path,'domain','截断取的是排序后的前 400 行，不是随机 400 行')
})

test('影响范围只含标识：objectType / views / actions / fields，不含任何对象取值',async()=>{
 const f=await harness()
 const typeDraft=await f.draft('object-type',alertTicket({lead:'改了一句处境说明。'}))
 const typePreview=await f.preview.preview(f.actor,{draftId:typeDraft.id})
 assert.deepEqual(typePreview.impact,{
  scope:'SOC',objectType:'alert-ticket',
  // 对象类型一改，挂在它上面的视图与动作全部跟着重算。
  views:['soc-alert-list','soc-alert-trend','soc-pending-board','soc-risk-distribution'],
  actions:['assign-alert-review','isolate-endpoint'],
  fields:['account-count','first-seen-at','host','incident','severity','verdict'],
  widgets:[],dashboards:[],
 })
 // 影响范围里一个对象取值都没有：它会连同摘要一起进模型上下文（规格 §7 第 3 条）。
 const serialized=JSON.stringify(typePreview.impact)
 for(const value of ['高','中','低','prod-','还没有人看','告警 1','严重度','告警工单'])assert.ok(!serialized.includes(value),'影响范围里不该出现 '+value)

 const viewDraft=await f.draft('view',riskView({title:'风险分布（本地）'}))
 const viewPreview=await f.preview.preview(f.actor,{draftId:viewDraft.id})
 assert.deepEqual(viewPreview.impact,{
  scope:'SOC',objectType:'alert-ticket',views:['soc-risk-distribution'],actions:[],
  fields:['severity','verdict'],widgets:[],dashboards:[],
 })
})

test('试算按草案算出的块与生效后的台账逐字相同（同一批行、同一条计算路径）',async()=>{
 const f=await harness()
 const draft=await f.draft('view',riskView({version:'1.1.0',title:'风险分布（本地）',dimension:{field:'severity',limit:2},limit:2}))
 const preview=await f.preview.preview(f.actor,{draftId:draft.id})
 assert.equal(preview.trialUnavailable,undefined)
 const trial=preview.trial!
 assert.ok(trial)
 const trialView=trial.views.find(view=>view.viewId==='soc-risk-distribution')!
 assert.deepEqual([trialView.origin,trialView.title,trialView.viewVersion],['local','风险分布（本地）','1.1.0'])
 assert.equal(trialView.definitionHash,draft.definitionHash,'试算带出来的摘要就是预览过的那一份草案的摘要')
 assert.equal(trialView.rows.length,2,'草案里的维度上限在试算里真的生效了')

 await f.local.apply(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedDefinitionHash:draft.definitionHash,expectedCurrentVersion:0,previewReceipt:preview.receipt})
 const landed=(await f.ledger.read(f.actor,{scope:'SOC',objectType:'alert-ticket'})).blocks[0]!
 assert.deepEqual(trial,landed,'试算就是确认之后的那一个块，不另算一遍')
})

test('数据源未连接时 trial 缺省、trialUnavailable==="source-disconnected"，不画空块',async()=>{
 const f=await harness({connect:false})
 // dimension.limit 没有本地化绑定，改它只出一行差异，不牵动 localized.title.*。
 const draft=await f.draft('view',riskViewMatchingTemplate({dimension:{field:'severity',limit:2}}))
 const preview=await f.preview.preview(f.actor,{draftId:draft.id})
 assert.equal(preview.trial,undefined,'来源没接上就不画块，而不是画一堆 0')
 assert.equal(preview.trialUnavailable,'source-disconnected')
 // 差异与影响范围照常给出：来源没接上不影响"这份声明改了什么"。
 assert.equal(preview.diff.length,1)
 assert.equal(preview.impact.objectType,'alert-ticket')
})

test('零对象时 trialUnavailable==="no-objects"',async()=>{
 const f=await harness()
 // 新增一个对象类型：本人一条这种对象的快照都没有，试算因此没有可算的分母。
 const draft=await f.draft('object-type',{
  format:'teloa.business-object-type/v1',id:'empty-type',version:'1.0.0',domain:'SOC',
  title:'还没有数据的对象类型',unit:'条',lead:'只为验零对象那一档。',sourceId:'security-alert-http',
  fields:[{name:'state',label:'状态',type:'text',required:false,from:'状态'}],
 })
 const preview=await f.preview.preview(f.actor,{draftId:draft.id})
 assert.equal(preview.trial,undefined)
 assert.equal(preview.trialUnavailable,'no-objects')
})

test('预览全程不写库：预览前后三张表与快照表的行数、指针 revision 逐列不变',async()=>{
 const f=await harness()
 // 先落一版本地声明，让三张表与指针都有行：只数空表数不出"预览改了指针"这种错。
 const first=await f.draft('view',riskView({title:'风险分布（第一版）'}))
 const firstPreview=await f.preview.preview(f.actor,{draftId:first.id})
 await f.local.apply(f.actor,{requestId:randomUUID(),draftId:first.id,expectedDefinitionHash:first.definitionHash,expectedCurrentVersion:0,previewReceipt:firstPreview.receipt})
 const second=await f.draft('view',riskView({version:'1.2.0',title:'风险分布（第二版）'}))

 const census=async()=>{
  const counts=await Promise.all([
   'teloa_business_definition_drafts','teloa_business_local_definitions',
   'teloa_business_local_definition_heads','teloa_business_object_snapshots',
  ].map(async table=>Number((await pool.query('select count(*)::int as total from '+table+' where owner_id=$1',[f.owner])).rows[0].total)))
  const heads=(await pool.query('select kind,local_id,version,revision,updated_at from teloa_business_local_definition_heads where owner_id=$1 order by kind,local_id',[f.owner])).rows
  const drafts=(await pool.query('select id,status,applied_version,definition_hash,updated_at from teloa_business_definition_drafts where owner_id=$1 order by id',[f.owner])).rows
  return {counts,heads,drafts}
 }
 const before=await census()
 const preview=await f.preview.preview(f.actor,{draftId:second.id})
 assert.equal(preview.base.origin,'local','基准此时是本地当前那一版')
 assert.equal(preview.base.semver,'1.0.0')
 assert.deepEqual(await census(),before,'预览一个字节也不写：行数、指针版本与 revision 逐列不变')
})

test('草案不存在或不属本人即 teloa/forbidden；已 applied 的草案不再预览（teloa/conflict）',async()=>{
 const f=await harness()
 await assert.rejects(()=>f.preview.preview(f.actor,{draftId:randomUUID()}),{code:'teloa/forbidden'})
 await assert.rejects(()=>f.preview.preview(f.actor,{draftId:'not-a-uuid'}),{code:'teloa/forbidden'})
 const draft=await f.draft('view',riskView({title:'风险分布（本地）'}))
 await assert.rejects(
  ()=>f.preview.preview({ownerId:'local:'+randomUUID(),scopeIds:['SOC']},{draftId:draft.id}),
  {code:'teloa/forbidden'},'别人的草案一律回不存在',
 )
 const preview=await f.preview.preview(f.actor,{draftId:draft.id})
 await f.local.apply(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedDefinitionHash:draft.definitionHash,expectedCurrentVersion:0,previewReceipt:preview.receipt})
 await assert.rejects(()=>f.preview.preview(f.actor,{draftId:draft.id}),{code:'teloa/conflict'},'已生效的草案没有"确认之后会变成什么样"可言')
})

const widgetHead={format:'teloa.business-widget/v1',version:'1.0.0',domain:'SOC',title:'告警'}
const widgetResults=async()=>(await pool.query('select count(*)::int as n from teloa_business_widget_results')).rows[0].n as number

test('widget 草案预览：按草案真跑一次 SQL、至多 50 行；SQL 不合规时预览照常返回 failed 与原因；预览不落结果',async()=>{
 const f=await harness({boards:true})
 const before=await widgetResults()
 // 9 条快照 union all 6 次 = 54 行：试算只回前 50 行。
 const query=Array.from({length:6},()=>'select _id, host from alert_ticket').join(' union all ')
 const draft=await f.draft('widget',{...widgetHead,id:'alert-table',kind:'table',query})
 const preview=await f.preview.preview(f.actor,{draftId:draft.id})
 assert.equal(preview.widgetTrial?.status,'ok',JSON.stringify(preview.widgetTrial?.error))
 assert.equal(preview.widgetTrial?.rowCount,50)
 assert.equal(Object.hasOwn(preview.widgetTrial!,'throttled'),false,'内部排队标记不下发')
 assert.deepEqual(preview.impact,{scope:'SOC',objectType:'',views:[],actions:[],fields:[],widgets:['alert-table'],dashboards:[]})
 assert.equal(Object.hasOwn(preview,'trial'),false)
 assert.equal(Object.hasOwn(preview,'trialUnavailable'),false)
 const bad=await f.draft('widget',{...widgetHead,id:'sleepy',kind:'metric',query:'select pg_sleep(1) as value',metric:{valueColumn:'value'}})
 const failed=await f.preview.preview(f.actor,{draftId:bad.id})
 assert.equal(failed.widgetTrial?.status,'failed')
 assert.equal(failed.widgetTrial?.error?.code,'teloa/invalid-input')
 assert.match(String(failed.widgetTrial?.error?.reason),/pg_sleep/)
 assert.equal(await widgetResults(),before,'预览一个字节也不写')
 // 装配方没给看板试算依赖时，三种新声明照旧不给预览。
 const plain=await harness()
 const other=await plain.draft('widget',{...widgetHead,id:'alert-table',kind:'table',query})
 await assert.rejects(plain.preview.preview(plain.actor,{draftId:other.id}),{code:'teloa/invalid-input'})
})

test('dashboard 草案预览：引用不存在的组件 → invalid-input；组件生效后给出布局与影响范围，组件预览列出引用它的看板',async()=>{
 const f=await harness({boards:true})
 const board={format:'teloa.business-dashboard/v1',id:'soc-overview',version:'1.0.0',domain:'SOC',title:'安全运营大盘',widgets:['alert-count'],
  layout:[{widget:'alert-count',x:0,y:0,w:12,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false}
 const early=await f.draft('dashboard',board)
 await assert.rejects(f.preview.preview(f.actor,{draftId:early.id}),{code:'teloa/invalid-input',message:/alert-count/})
 const widgetDraft=await f.draft('widget',{...widgetHead,id:'alert-count',kind:'metric',query:'select count(*) as value from alert_ticket',metric:{valueColumn:'value'}})
 const widgetPreview=await f.preview.preview(f.actor,{draftId:widgetDraft.id})
 assert.deepEqual(widgetPreview.widgetTrial?.rows,[[9]])
 await f.local.apply(f.actor,{requestId:randomUUID(),draftId:widgetDraft.id,expectedDefinitionHash:widgetDraft.definitionHash,expectedCurrentVersion:0,previewReceipt:widgetPreview.receipt})
 const preview=await f.preview.preview(f.actor,{draftId:early.id})
 assert.deepEqual(preview.dashboardTrial,{layout:board.layout})
 assert.deepEqual(preview.impact,{scope:'SOC',objectType:'',views:[],actions:[],fields:[],widgets:['alert-count'],dashboards:['soc-overview']})
 await f.local.apply(f.actor,{requestId:randomUUID(),draftId:early.id,expectedDefinitionHash:early.definitionHash,expectedCurrentVersion:0,previewReceipt:preview.receipt})
 const edit=await f.draft('widget',{...widgetHead,id:'alert-count',version:'1.0.1',kind:'metric',query:'select count(*) as value from alert_ticket',metric:{valueColumn:'value'}})
 assert.deepEqual((await f.preview.preview(f.actor,{draftId:edit.id})).impact.dashboards,['soc-overview'])
})

test('整页时间范围：接入组件草案按 all 试算成功；SQL 不读接入表 → widgetTrial failed 带原因；接入列 / 表不成立、带 filters 却无接入组件 → invalid-input 带 crossReference',async()=>{
 const f=await harness({boards:true})
 const before=await widgetResults()
 const timeFilter={table:'alert_ticket',column:'first-seen-at'}
 const bound=await f.draft('widget',{...widgetHead,id:'alert-range',kind:'metric',query:'select count(*) as value from alert_ticket',metric:{valueColumn:'value'},timeFilter})
 const ok=await f.preview.preview(f.actor,{draftId:bound.id})
 assert.equal(ok.widgetTrial?.status,'ok',JSON.stringify(ok.widgetTrial?.error))
 assert.deepEqual(ok.widgetTrial?.rows,[[9]],'试算按 all：全部 9 条')
 const blind=await f.draft('widget',{...widgetHead,id:'alert-blind',kind:'metric',query:'select 42 as value',metric:{valueColumn:'value'},timeFilter})
 const failed=await f.preview.preview(f.actor,{draftId:blind.id})
 assert.equal(failed.widgetTrial?.status,'failed')
 assert.deepEqual(failed.widgetTrial?.error,{code:'teloa/invalid-input',reason:'组件接入了时间范围，但 SQL 没有读取表 alert_ticket。'})
 assert.deepEqual([failed.widgetTrial?.rows,failed.widgetTrial?.rowCount],[[],0])
 const crossReference=(reason:RegExp)=>(error:WorkError)=>error.code==='teloa/invalid-input'&&reason.test(error.message)&&JSON.stringify(error.details)==='{"crossReference":true}'||assert.fail(JSON.stringify({code:error.code,message:error.message,details:error.details}))
 for(const [name,filter,reason] of [
  ['number 字段',{table:'alert_ticket',column:'account-count'},/account-count.*时间字段/],
  ['未声明列',{table:'alert_ticket',column:'closed-at'},/closed-at.*时间字段/],
  ['表不在本范围',{table:'vulnerability',column:'_observed_at'},/vulnerability.*不是本业务范围/],
 ] as const){
  const draft=await f.draft('widget',{...widgetHead,id:'alert-bad-'+name.length,kind:'metric',query:'select count(*) as value from alert_ticket',metric:{valueColumn:'value'},timeFilter:filter})
  await assert.rejects(f.preview.preview(f.actor,{draftId:draft.id}),crossReference(reason),name)
 }
 // 看板带 filters：组件都没接入 → 拒；接入组件生效后同一份看板草案可预览。
 const plain=await f.draft('widget',{...widgetHead,id:'alert-count',kind:'metric',query:'select count(*) as value from alert_ticket',metric:{valueColumn:'value'}})
 const plainPreview=await f.preview.preview(f.actor,{draftId:plain.id})
 await f.local.apply(f.actor,{requestId:randomUUID(),draftId:plain.id,expectedDefinitionHash:plain.definitionHash,expectedCurrentVersion:0,previewReceipt:plainPreview.receipt})
 const board=(widgets:string[])=>({format:'teloa.business-dashboard/v1',id:'soc-overview',version:'1.0.0',domain:'SOC',title:'安全运营大盘',widgets,
  layout:widgets.map((widget,index)=>({widget,x:0,y:index*2,w:12,h:2})),refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false,filters:{timeRange:{options:['7d','30d','all'],default:'7d'}}})
 await assert.rejects(f.preview.preview(f.actor,{draftId:(await f.draft('dashboard',board(['alert-count']))).id}),crossReference(/^业务看板 soc-overview 声明了时间范围，但没有任何组件接入/))
 await f.local.apply(f.actor,{requestId:randomUUID(),draftId:bound.id,expectedDefinitionHash:bound.definitionHash,expectedCurrentVersion:0,previewReceipt:ok.receipt})
 const ranged=await f.preview.preview(f.actor,{draftId:(await f.draft('dashboard',board(['alert-count','alert-range']))).id})
 assert.deepEqual(ranged.dashboardTrial,{layout:board(['alert-count','alert-range']).layout})
 assert.equal(await widgetResults(),before,'预览一个字节也不写')
})

test('source-mapping 草案预览：试拉 1 页按映射转换不落库；试拉失败按连接未建立 / 工具不可用 / 调用失败三分',async()=>{
 let pulls=0
 const f=await harness({boards:true,resolveSource:async()=>({key:'security-alert-http',fetch:async input=>{
  pulls+=1
  assert.equal(input.cursor,undefined)
  return {capturedAt:NOW,items:[{sev:'高',host:'h-1',title:'一'},{sev:'低',host:'h-2',title:'二'},{host:null}]}
 }})})
 const mapping={format:'teloa.business-source-mapping/v1',id:'alert-sync',version:'1.0.0',domain:'SOC',title:'告警同步',objectType:'alert-ticket',
  source:{kind:'business-data-port',sourceId:'security-alert-http'},mapping:[{path:'$.host',field:'host'},{path:'$.sev',field:'severity'},{path:'$.title',field:'title'}],
  primaryKey:['host'],deletionSemantics:'compare',schedule:{kind:'every',seconds:300},acknowledgeShortInterval:false}
 const snapshots=async()=>(await pool.query('select count(*)::int as n from teloa_business_object_snapshots')).rows[0].n as number
 const before=await snapshots()
 const draft=await f.draft('source-mapping',mapping)
 const preview=await f.preview.preview(f.actor,{draftId:draft.id})
 assert.equal(pulls,1)
 assert.deepEqual(preview.mappingTrial,{fetched:3,objects:[
  {objectId:'h-1',fields:[{field:'severity',value:'高'},{field:'host',value:'h-1'}]},
  {objectId:'h-2',fields:[{field:'severity',value:'低'},{field:'host',value:'h-2'}]},
 ]})
 assert.deepEqual(preview.impact,{scope:'SOC',objectType:'alert-ticket',views:[],actions:[],fields:['host','severity'],widgets:[],dashboards:[]})
 assert.equal(await snapshots(),before,'试拉不落库')
 // 试拉三分（规格 §5.2）：来源已接上但调用失败 → pull-failed；来源没接上（sourceState:disconnected 或没有解析器）→ source-disconnected；
 // 草案点名了不能用于同步的工具（forbidden）→ 预览抛 invalid-input 带原文。
 const down=await harness({boards:true,resolveSource:async()=>({key:'x',fetch:async()=>{throw new WorkError('teloa/source-unavailable','数据源暂不可读。')}})})
 const other=await down.draft('source-mapping',mapping)
 const failed=await down.preview.preview(down.actor,{draftId:other.id})
 assert.equal(failed.trialUnavailable,'pull-failed')
 assert.equal(Object.hasOwn(failed,'mappingTrial'),false)
 const disconnected=await harness({boards:true,resolveSource:async()=>{throw new WorkError('teloa/source-unavailable','受管连接 soc 连接未建立。',{sourceState:'disconnected'})}})
 assert.equal((await disconnected.preview.preview(disconnected.actor,{draftId:(await disconnected.draft('source-mapping',mapping)).id})).trialUnavailable,'source-disconnected')
 const unresolved=await harness({boards:true})
 assert.equal((await unresolved.preview.preview(unresolved.actor,{draftId:(await unresolved.draft('source-mapping',mapping)).id})).trialUnavailable,'source-disconnected','没有来源解析器等同没接上')
 // 同步源 fetch 时连接中途断开（形状同 business-mcp-sync-source 保留下来的错误）：仍是 source-disconnected，不说成 pull-failed。
 const dropped=await harness({boards:true,resolveSource:async()=>({key:'soc/list_alerts',fetch:async()=>{throw new WorkError('teloa/source-unavailable','受管连接 soc 连接未建立或已断开。',{sourceState:'disconnected'})}})})
 assert.equal((await dropped.preview.preview(dropped.actor,{draftId:(await dropped.draft('source-mapping',mapping)).id})).trialUnavailable,'source-disconnected','拉取中途断开也是没接上')
 // 只有同步源只读门的 forbidden（details.toolGate）转 invalid-input 带原文；其他来源的 forbidden 按试拉失败处理，原文不上屏。
 const forbidden=await harness({boards:true,resolveSource:async()=>{throw new WorkError('teloa/forbidden','看板同步只允许只读工具：soc/list_alerts 不存在或不是只读工具。',{toolGate:true})}})
 await assert.rejects(forbidden.preview.preview(forbidden.actor,{draftId:(await forbidden.draft('source-mapping',mapping)).id}),(error:WorkError)=>error.code==='teloa/invalid-input'&&error.message==='看板同步只允许只读工具：soc/list_alerts 不存在或不是只读工具。'&&error.details===undefined,'forbidden 转来的不是跨声明核对失败，不带 crossReference')
 const portForbidden=await harness({boards:true,resolveSource:async()=>({key:'x',fetch:async()=>{throw new WorkError('teloa/forbidden','外部系统拒绝：tenant-42 无权访问。')}})})
 const denied=await portForbidden.preview.preview(portForbidden.actor,{draftId:(await portForbidden.draft('source-mapping',mapping)).id})
 assert.equal(denied.trialUnavailable,'pull-failed','不带 toolGate 的 forbidden 不上屏原文')
 assert.doesNotMatch(JSON.stringify(denied),/tenant-42/)
 // 数据源配置文件存在却读不了：单列一种，界面请用户检查配置文件。
 const broken=await harness({boards:true,resolveSource:async()=>({key:'x',fetch:async()=>{throw new WorkError('teloa/source-unavailable','安全告警来源配置文件无法读取，请检查配置文件。',{sourceState:'config-unreadable'})}})})
 const unreadable=await broken.preview.preview(broken.actor,{draftId:(await broken.draft('source-mapping',mapping)).id})
 assert.equal(unreadable.trialUnavailable,'config-unreadable')
 assert.equal(Object.hasOwn(unreadable,'mappingTrial'),false)
})

test('组件下钻：目标类型有清单视图、match 字段可等值即可预览试算；match 字段为时间 / 数值或目标类型不在本范围 → invalid-input 带 crossReference；结果缺下钻列 → widgetTrial failed',async()=>{
 const f=await harness({boards:true})
 const table=(id:string,drilldown:Record<string,unknown>,query='select _id, severity from alert_ticket')=>({...widgetHead,id,kind:'table',query,drilldown})
 const ok=await f.preview.preview(f.actor,{draftId:(await f.draft('widget',table('alert-drill',{objectType:'alert-ticket',match:{column:'severity',field:'severity'}}))).id})
 assert.equal(ok.widgetTrial?.status,'ok',JSON.stringify(ok.widgetTrial?.error))
 const crossReference=(reason:RegExp)=>(error:WorkError)=>error.code==='teloa/invalid-input'&&reason.test(error.message)&&JSON.stringify(error.details)==='{"crossReference":true}'||assert.fail(JSON.stringify({code:error.code,message:error.message,details:error.details}))
 for(const [id,drilldown,reason] of [
  ['drill-datetime',{objectType:'alert-ticket',match:{column:'severity',field:'first-seen-at'}},/first-seen-at/],
  ['drill-number',{objectType:'alert-ticket',match:{column:'severity',field:'account-count'}},/account-count/],
  ['drill-missing-type',{objectType:'vulnerability'},/vulnerability.*不是本业务范围/],
 ] as const)await assert.rejects(f.preview.preview(f.actor,{draftId:(await f.draft('widget',table(id,drilldown))).id}),crossReference(reason),id)
 const missing=await f.preview.preview(f.actor,{draftId:(await f.draft('widget',table('drill-no-column',{objectType:'alert-ticket',idColumn:'_id'},'select severity from alert_ticket'))).id})
 assert.equal(missing.widgetTrial?.status,'failed')
 assert.match(String(missing.widgetTrial?.error?.reason),/缺少组件声明要用的列：_id/)
})

test('草案造成的跨声明核对失败回 invalid-input 带原因；同样的问题已在库里生效则基线照旧 source-unavailable 带 crossReference，此时任一草案的预览都不转码',async()=>{
 const f=await harness({boards:true,resolveSource:async()=>({key:'security-alert-http',fetch:async()=>({capturedAt:NOW,items:[{host:'h-1'}]})})})
 const mapping=(fields:Array<{path:string;field:string}>)=>({format:'teloa.business-source-mapping/v1',id:'alert-sync',version:'1.0.0',domain:'SOC',title:'告警同步',objectType:'alert-ticket',
  source:{kind:'business-data-port',sourceId:'security-alert-http'},mapping:fields,primaryKey:['host'],deletionSemantics:'compare',schedule:{kind:'every',seconds:300},acknowledgeShortInterval:false})
 const badFields=[{path:'$.host',field:'host'},{path:'$.x',field:'no-such-field'}]
 const bad=await f.draft('source-mapping',mapping(badFields))
 // 转码后只转发 crossReference 一项：客户端据此单说「草案与已有定义对不上」，其余 invalid-input 另说通用原因。
 await assert.rejects(f.preview.preview(f.actor,{draftId:bad.id}),(error:WorkError)=>error.code==='teloa/invalid-input'&&error.message.startsWith('数据源映射的目标字段不在对象类型声明里。')&&JSON.stringify(error.details)==='{"crossReference":true}')
 const view=await f.draft('view',riskView({dimension:{field:'nope',limit:3}}))
 await assert.rejects(f.preview.preview(f.actor,{draftId:view.id}),(error:WorkError)=>error.code==='teloa/invalid-input'&&error.message.startsWith('视图引用的字段不在对象类型声明里。')&&error.details?.crossReference===true,'视图草案引用不存在的字段同理')
 // 先让一份好映射生效，再直接把本地声明表里的正文改成坏映射：库里已生效的问题不算到草案头上。
 const good=await f.draft('source-mapping',mapping([{path:'$.host',field:'host'}]))
 const okPreview=await f.preview.preview(f.actor,{draftId:good.id})
 assert.equal(okPreview.mappingTrial?.fetched,1)
 await f.local.apply(f.actor,{requestId:randomUUID(),draftId:good.id,expectedDefinitionHash:good.definitionHash,expectedCurrentVersion:0,previewReceipt:okPreview.receipt})
 const body=JSON.stringify(mapping(badFields)),bodyHash=createHash('sha256').update(body).digest('hex')
 await pool.query('update teloa_business_local_definitions set body=$1,body_hash=$2,definition_hash=$3 where owner_id=$4 and scope_id=$5 and kind=$6 and local_id=$7',[body,bodyHash,businessLocalDefinitionHash('SOC','source-mapping','alert-sync','1.0.0',bodyHash),f.owner,'SOC','source-mapping','alert-sync'])
 const db=await pool.connect()
 try{await assert.rejects(f.definitions.forScope(db,f.owner,'SOC'),(error:WorkError)=>error.code==='teloa/source-unavailable'&&error.details?.crossReference===true&&error.message.startsWith('数据源映射的目标字段不在对象类型声明里。'))}
 finally{db.release()}
 const another=await f.draft('view',riskView({title:'风险分布（本地）'}))
 await assert.rejects(f.preview.preview(f.actor,{draftId:another.id}),{code:'teloa/source-unavailable'},'基线失败不算草案的')
})

test('台账计算与合并里非跨引用的 source-unavailable（如引用目标超过 5000 个）不被转码',async()=>{
 const f=await harness({boards:true})
 const plain=()=>new WorkError('teloa/source-unavailable','引用目标超过 5000 个。')
 const definitions:Pick<BusinessDefinitionSourceReader,'forScope'>={forScope:(db,owner,scope,override)=>override?Promise.reject(plain()):f.definitions.forScope(db,owner,scope)}
 const service=new BusinessDefinitionPreviewService(pool,identity,f.local,definitions,{computeInTransaction:async()=>{throw plain()}},{widgets:f.widgets})
 const view=await f.draft('view',riskView({title:'风险分布（本地）'}))
 await assert.rejects(service.preview(f.actor,{draftId:view.id}),(error:WorkError)=>error.code==='teloa/source-unavailable'&&error.message==='引用目标超过 5000 个。'&&error.details===undefined)
 const widget=await f.draft('widget',{...widgetHead,id:'alert-count',kind:'metric',query:'select count(*) as value from alert_ticket',metric:{valueColumn:'value'}})
 await assert.rejects(service.preview(f.actor,{draftId:widget.id}),(error:WorkError)=>error.code==='teloa/source-unavailable'&&error.message==='引用目标超过 5000 个。')
})

test('声明了分页的 mcp-tool 映射草案：试拉仍只拉第 1 页，来源给出下一页游标也不续拉',async()=>{
 const inputs:unknown[]=[]
 const f=await harness({boards:true,resolveSource:async()=>({key:'soc/list_alerts',fetch:async input=>{inputs.push({cursor:input.cursor,pageToken:input.pageToken});return {capturedAt:NOW,items:[{host:'h-1',sev:'高'}],nextCursor:'p2'}}})})
 const mapping={format:'teloa.business-source-mapping/v1',id:'alert-mcp-paged',version:'1.0.0',domain:'SOC',title:'告警同步',objectType:'alert-ticket',
  source:{kind:'mcp-tool',serverName:'soc',tool:'list_alerts',arguments:{status:'open'},itemsPath:'$.items',pagination:{cursorArgument:'page',nextCursorPath:'$.next'}},mapping:[{path:'$.host',field:'host'},{path:'$.sev',field:'severity'}],
  primaryKey:['host'],deletionSemantics:'compare',schedule:{kind:'every',seconds:300},acknowledgeShortInterval:false}
 const draft=await f.draft('source-mapping',mapping)
 const pulled=await f.preview.preview(f.actor,{draftId:draft.id,pull:true})
 assert.equal(pulled.mappingTrial?.fetched,1)
 assert.deepEqual(inputs,[{cursor:undefined,pageToken:undefined}],'只拉一次、不带水位与续页标记')
})

test('mcp-tool 来源的映射草案：打开预览不调工具（pull-required），显式 pull:true 才试拉一次；pull 只收 true',async()=>{
 let pulls=0
 const f=await harness({boards:true,resolveSource:async()=>({key:'soc/list_alerts',fetch:async()=>{pulls+=1;return {capturedAt:NOW,items:[{host:'h-1',sev:'高'}]}}})})
 const mapping={format:'teloa.business-source-mapping/v1',id:'alert-mcp',version:'1.0.0',domain:'SOC',title:'告警同步',objectType:'alert-ticket',
  source:{kind:'mcp-tool',serverName:'soc',tool:'list_alerts',arguments:{status:'open'},itemsPath:'$.items'},mapping:[{path:'$.host',field:'host'},{path:'$.sev',field:'severity'}],
  primaryKey:['host'],deletionSemantics:'compare',schedule:{kind:'every',seconds:300},acknowledgeShortInterval:false}
 const draft=await f.draft('source-mapping',mapping)
 const idle=await f.preview.preview(f.actor,{draftId:draft.id})
 assert.equal(pulls,0)
 assert.equal(idle.trialUnavailable,'pull-required')
 assert.equal(Object.hasOwn(idle,'mappingTrial'),false)
 const pulled=await f.preview.preview(f.actor,{draftId:draft.id,pull:true})
 assert.equal(pulls,1)
 assert.equal(pulled.mappingTrial?.fetched,1)
 assert.equal(pulled.receipt,idle.receipt,'试拉与否不改变确认回执')
 for(const pull of [false,'yes',1])await assert.rejects(f.preview.preview(f.actor,{draftId:draft.id,pull}),{code:'teloa/invalid-input'})
 assert.equal(pulls,1)
})
