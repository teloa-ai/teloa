import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join,relative,sep} from 'node:path'
import {readFile,readdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {businessCustomizationLimits,type BusinessDefinitionKind} from '@teloa/contract'
import {
 MarketContentStore,initializeMarketContents,
 createIndustryLoadSource,IndustryLoadService,initializeIndustryLoads,type IndustryLoadRecord,
 IndustryDataSourceService,IndustryDataSourceSource,initializeIndustryDataSources,
 BusinessDataService,initializeBusinessData,
 BusinessDefinitionSourceReader,BusinessLedgerService,
 BusinessLocalDefinitionService,initializeBusinessDefinitions,type BusinessLocalActor,
} from '../src/index.ts'
import {issueBusinessDefinitionPreviewReceipt} from '../src/work/business-definition-preview-receipt.ts'

/**
 * 业务定制层第二期后端存储的真库验收：草案只能是 draft、生效走两条乐观判据、回退只改指针、
 * 版本链不截断，以及同 localId 的本地声明在台账里覆盖模板那一份（最后一条走真夹具 + 真台账计算）。
 */

let container:StartedPostgreSqlContainer,pool:Pool
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
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const identity={id:randomUUID,now:()=>new Date().toISOString()}
const sha256=(value:string)=>createHash('sha256').update(value).digest('hex')
function confirmed(actor:BusinessLocalActor,draft:{id:string;scope:string;definitionHash:string},expectedCurrentVersion:number,expectedDefinitionHash=draft.definitionHash){
 return {requestId:randomUUID(),draftId:draft.id,expectedDefinitionHash,expectedCurrentVersion,previewReceipt:issueBusinessDefinitionPreviewReceipt({ownerId:actor.ownerId,scope:draft.scope,draftId:draft.id,definitionHash:draft.definitionHash,currentVersion:expectedCurrentVersion})}
}

/** 由数据库确认旧入口已抵达范围锁、正被当前事务阻塞，再释放当前事务。 */
async function waitForConfigurationLock(holder:PoolClient):Promise<void>{
 const holderPid=Number((await holder.query('select pg_backend_pid() as pid')).rows[0].pid)
 const deadline=Date.now()+5000
 do{
  const waiting=(await pool.query(`select 1 from pg_stat_activity where datname=current_database()
   and wait_event_type='Lock' and wait_event='advisory' and $1=any(pg_blocking_pids(pid))
   and query='select pg_advisory_xact_lock(hashtextextended($1,0))'`,[holderPid])).rowCount
  if(waiting)return
  await new Promise<void>(resolve=>setImmediate(resolve))
 }while(Date.now()<deadline)
 throw new Error('竞争连接未进入受当前事务阻塞的业务范围 advisory 锁等待')
}

/** 一份合法的 SOC 视图声明，字段与夹具 `soc-risk-distribution` 逐字对上——台账合并那一条要覆盖它。 */
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
 * 只装三张本地表的那一套：模板侧有没有同名声明由一个可变映射假注入，
 * 这样「回到模板版本能不能点」两个分支都验得到，而不必为此先导入一份模板。
 */
function plain(){
 const owner='local:'+randomUUID(),actor:BusinessLocalActor={ownerId:owner,scopeIds:['SOC','AppSec']}
 const templates=new Map<string,string>()
 const service=new BusinessLocalDefinitionService(pool,identity,async()=>templates)
 /** 写一份草案再立刻生效，返回落地后的版本链。生效是唯一写路径，测试也只能走它。 */
 async function land(definition:Record<string,unknown>,expectedCurrentVersion:number){
  const draft=await service.draft(actor,{scope:'SOC',kind:'view',definition,requestId:randomUUID()})
  return service.apply(actor,confirmed(actor,draft,expectedCurrentVersion))
 }
 return {owner,actor,service,templates,land}
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
 * 真夹具 + 真加载 + 真台账，读取器多带一个本地声明读口：合并只发生在 `forScope` 里，
 * 台账服务与客户端都不知道有这回事（D3）。搭法照 `business-definition-integration.test.ts`。
 */
async function ledgerHarness(){
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

 const base=fileURLToPath(new URL('../../../tests/fixtures/业务定制层/SOC/',import.meta.url))
 const paths=await walk(base,base)
 const files=await Promise.all(paths.map(async path=>({path,bytes:new Uint8Array(await readFile(join(base,path)))})))
 const saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'SOC'},manifestPath:'teloa.json',files,references:[]})
 const load:IndustryLoadRecord=await loads.create(owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'SOC'}})
 const item=load.items.find(row=>row.localId==='soc-alert-source')!
 const created=await dataSources.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:item.instanceId})
 await dataSources.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:created.revision},new AbortController().signal)
 const port={id:'security-alert-http',scopes:['SOC'],query:async()=>({schema:'teloa.data-source-page/v1',sourceId:'security-alert-http',scope:'SOC',capturedAt:identity.now(),items:Array.from({length:9},(_value,index)=>alertSnapshot(index+1))})}
 await new BusinessDataService(pool,port as never).query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:9})

 /** 台账里 `alert-ticket` 那个块的全部视图结果。 */
 async function views(){
  const blocks=(await ledger.read(actor,{scope:'SOC'})).blocks
  return blocks.find(block=>block.objectType.definition.id==='alert-ticket')!.views
 }
 return {owner,actor,local,views}
}

test('草案只能是 draft：同 requestId 重放替换同一行，status 与 appliedVersion 恒定',async()=>{
 const f=plain(),requestId=randomUUID()
 const first=await f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView(),requestId})
 const again=await f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({title:'风险分布（改）'}),requestId})
 assert.equal(again.id,first.id);assert.equal(again.status,'draft');assert.equal(again.appliedVersion,undefined)
 assert.notEqual(again.definitionHash,first.definitionHash,'正文换了摘要必须跟着换')
 assert.equal((await f.service.directory(f.actor,{scope:'SOC'})).drafts.length,1)
 // 正文是规范化 JSON，bodyHash 与 definitionHash 由同一条公式决定，预览与生效两处都按它核对。
 assert.equal(JSON.parse(again.body).title,'风险分布（改）')
 assert.equal(again.definitionHash,sha256(JSON.stringify(['teloa.business-local-definition/v1','SOC','view','soc-risk-distribution','1.0.0',sha256(again.body)])))
 const db=await pool.connect()
 try{
  assert.deepEqual(await f.service.draftInTransaction(db,f.owner,again.id),again)
  await assert.rejects(()=>f.service.draftInTransaction(db,'local:'+randomUUID(),again.id),{code:'teloa/forbidden'},'别人的草案一律回不存在')
 }finally{db.release()}
})

test('apply 的 expectedDefinitionHash 与库里草案不符即 version-conflict（预览过的才能生效）',async()=>{
 const f=plain()
 const draft=await f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView(),requestId:randomUUID()})
 await assert.rejects(
  ()=>f.service.apply(f.actor,confirmed(f.actor,draft,0,sha256('另一份正文'))),
  {code:'teloa/version-conflict'},
 )
 assert.equal((await f.service.directory(f.actor,{scope:'SOC'})).entries.length,0,'判据不成立时一个版本也不写')
})

test('整体事务采用两份定义：rollback 撤销版本、指针和草案状态，commit 同时公开',async()=>{
 const f=plain()
 const first=await f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({id:'transaction-first'}),requestId:randomUUID()})
 const second=await f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({id:'transaction-second'}),requestId:randomUUID()})
 const db=await pool.connect()
 try{
  await db.query('begin')
  await f.service.applyInTransaction(db,f.actor,confirmed(f.actor,first,0))
  await f.service.applyInTransaction(db,f.actor,confirmed(f.actor,second,0))
  assert.equal((await f.service.directory(f.actor,{scope:'SOC'})).entries.length,0,'调用方尚未提交时外部目录不可见')
  await db.query('rollback')
  const rolled=await f.service.directory(f.actor,{scope:'SOC'})
  assert.equal(rolled.entries.length,0)
  assert.deepEqual(rolled.drafts.map(row=>row.status),['draft','draft'])

  await db.query('begin')
  await f.service.applyInTransaction(db,f.actor,confirmed(f.actor,first,0))
  await f.service.applyInTransaction(db,f.actor,confirmed(f.actor,second,0))
  await db.query('commit')
  const committed=await f.service.directory(f.actor,{scope:'SOC'})
  assert.deepEqual(committed.entries.map(row=>row.localId),['transaction-first','transaction-second'])
  assert.deepEqual(committed.entries.map(row=>row.current?.version),[1,1])
  assert.deepEqual(committed.drafts.map(row=>row.status),['applied','applied'])
 }finally{await db.query('rollback').catch(()=>{});db.release()}
})

test('事务采用第二份摘要不符时调用方 rollback 撤销第一份',async()=>{
 const f=plain()
 const first=await f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({id:'transaction-valid'}),requestId:randomUUID()})
 const second=await f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({id:'transaction-invalid'}),requestId:randomUUID()})
 const db=await pool.connect()
 try{
  await db.query('begin')
  await f.service.applyInTransaction(db,f.actor,confirmed(f.actor,first,0))
  await assert.rejects(()=>f.service.applyInTransaction(db,f.actor,confirmed(f.actor,second,0,sha256('错误摘要'))),{code:'teloa/version-conflict'})
  await db.query('rollback')
  const directory=await f.service.directory(f.actor,{scope:'SOC'})
  assert.equal(directory.entries.length,0)
  assert.deepEqual(directory.drafts.map(row=>row.status),['draft','draft'])
 }finally{await db.query('rollback').catch(()=>{});db.release()}
})

test('事务采用与旧 apply 并发首次写同一无 head 定义，仅一方成功',async()=>{
 const f=plain()
 const left=await f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({id:'first-head',title:'左'}),requestId:randomUUID()})
 const right=await f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({id:'first-head',title:'右'}),requestId:randomUUID()})
 const db=await pool.connect()
 try{
  await db.query('begin')
  await f.service.applyInTransaction(db,f.actor,confirmed(f.actor,left,0))
  const competing=f.service.apply(f.actor,confirmed(f.actor,right,0)).then(()=>({code:'success'}),error=>({code:error.code}))
  await waitForConfigurationLock(db)
  await db.query('commit')
  assert.deepEqual(await competing,{code:'teloa/version-conflict'})
  const directory=await f.service.directory(f.actor,{scope:'SOC'})
  assert.deepEqual(directory.entries[0]?.versions.map(row=>row.version),[1])
  assert.equal(directory.entries[0]?.current?.draftId,left.id)
  assert.deepEqual(directory.drafts.map(row=>row.status),['applied','draft'])
 }finally{await db.query('rollback').catch(()=>{});db.release()}
})

test('旧 revert 与事务采用竞争时旧版本判据不能覆盖新指针',async()=>{
 const f=plain()
 await f.land(riskView({id:'revert-race'}),0)
 const next=await f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({id:'revert-race',version:'1.0.1'}),requestId:randomUUID()})
 const db=await pool.connect()
 try{
  await db.query('begin')
  await f.service.applyInTransaction(db,f.actor,confirmed(f.actor,next,1))
  const competing=f.service.revert(f.actor,{requestId:randomUUID(),scope:'SOC',kind:'view',localId:'revert-race',target:{kind:'template'},expectedCurrentVersion:1}).then(()=>({code:'success'}),error=>({code:error.code}))
  await waitForConfigurationLock(db)
  await db.query('commit')
  assert.deepEqual(await competing,{code:'teloa/version-conflict'})
  const entry=(await f.service.directory(f.actor,{scope:'SOC'})).entries[0]!
  assert.equal(entry.current?.version,2)
  assert.deepEqual(entry.versions.map(row=>row.version),[1,2])
 }finally{await db.query('rollback').catch(()=>{});db.release()}
})

test('事务采用仍核对本人范围和预览凭证，不写版本链',async()=>{
 const f=plain()
 const draft=await f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({id:'transaction-guard'}),requestId:randomUUID()})
 const db=await pool.connect()
 try{
  await db.query('begin')
  await assert.rejects(()=>f.service.applyInTransaction(db,{ownerId:f.owner,scopeIds:['AppSec']},confirmed(f.actor,draft,0)),{code:'teloa/forbidden'})
  await assert.rejects(()=>f.service.applyInTransaction(db,f.actor,{...confirmed(f.actor,draft,0),previewReceipt:issueBusinessDefinitionPreviewReceipt({ownerId:f.owner,scope:'SOC',draftId:draft.id,definitionHash:draft.definitionHash,currentVersion:1})}),{code:'teloa/version-conflict'})
  await db.query('rollback')
  const directory=await f.service.directory(f.actor,{scope:'SOC'})
  assert.equal(directory.entries.length,0)
  assert.equal(directory.drafts[0]?.status,'draft')
 }finally{await db.query('rollback').catch(()=>{});db.release()}
})

test('apply 的 expectedCurrentVersion 与当前指针不符即 version-conflict',async()=>{
 const f=plain()
 await f.land(riskView(),0)
 const draft=await f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({title:'风险分布（二）'}),requestId:randomUUID()})
 await assert.rejects(
  ()=>f.service.apply(f.actor,confirmed(f.actor,draft,0)),
  {code:'teloa/version-conflict'},
 )
 const entry=(await f.service.directory(f.actor,{scope:'SOC'})).entries[0]!
 assert.equal(entry.versions.length,1);assert.equal(entry.current?.version,1)
})

test('apply 之后草案置 applied 并带 appliedVersion，版本号单调递增',async()=>{
 const f=plain()
 f.templates.set('view\0soc-risk-distribution','1.0.0')
 const first=await f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView(),requestId:randomUUID()})
 const entry=await f.service.apply(f.actor,confirmed(f.actor,first,0))
 assert.deepEqual([entry.scope,entry.kind,entry.localId],['SOC','view','soc-risk-distribution'])
 assert.equal(entry.current?.version,1);assert.equal(entry.current?.draftId,first.id)
 assert.deepEqual(entry.template,{available:true,version:'1.0.0'},'模板侧有同名声明时「回到模板版本」可点')
 const second=await f.land(riskView({title:'风险分布（二）'}),1)
 assert.deepEqual(second.versions.map(row=>row.version),[1,2],'版本号单调递增，旧版本留在链上')
 assert.equal(second.current?.version,2)
 const drafts=(await f.service.directory(f.actor,{scope:'SOC'})).drafts
 assert.deepEqual(drafts.map(row=>row.status),['applied','applied'])
 assert.deepEqual(drafts.map(row=>row.appliedVersion).sort(),[1,2])
 // 已生效的草案不再被同 requestId 的重放改写：重放会把一份已经落库的版本的来源正文换掉。
 await assert.rejects(
  ()=>f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({title:'风险分布（三）'}),requestId:first.requestId}),
  {code:'teloa/conflict'},
 )
})

test('revert 到历史版本只改指针，历史版本一条不删',async()=>{
 const f=plain()
 await f.land(riskView(),0)
 const second=await f.land(riskView({title:'风险分布（二）'}),1)
 assert.equal(second.current?.version,2)
 const reverted=await f.service.revert(f.actor,{requestId:randomUUID(),scope:'SOC',kind:'view',localId:'soc-risk-distribution',target:{kind:'local-version',version:1},expectedCurrentVersion:2})
 assert.equal(reverted.current?.version,1)
 assert.deepEqual(reverted.versions,second.versions,'版本链一条不少、一字不改')
 // 同一次回退重放第二遍：指针已是 1，乐观判据必然不符。
 await assert.rejects(
  ()=>f.service.revert(f.actor,{requestId:randomUUID(),scope:'SOC',kind:'view',localId:'soc-risk-distribution',target:{kind:'local-version',version:1},expectedCurrentVersion:2}),
  {code:'teloa/version-conflict'},
 )
 await assert.rejects(
  ()=>f.service.revert(f.actor,{requestId:randomUUID(),scope:'SOC',kind:'view',localId:'soc-risk-distribution',target:{kind:'local-version',version:9},expectedCurrentVersion:1}),
  {code:'teloa/conflict'},
 )
})

test('revert 到模板版本把指针置空，本地版本仍在 versions 里',async()=>{
 const f=plain()
 const landed=await f.land(riskView(),0)
 const reverted=await f.service.revert(f.actor,{requestId:randomUUID(),scope:'SOC',kind:'view',localId:'soc-risk-distribution',target:{kind:'template'},expectedCurrentVersion:1})
 assert.equal(reverted.current,undefined,'指针置空即回到模板那一份')
 assert.deepEqual(reverted.versions,landed.versions,'本地版本一条不删')
 // 指针为空时台账合并读不到这条本地声明：`currentInTransaction` 只认指针非空的行。
 const db=await pool.connect()
 try{assert.deepEqual(await f.service.currentInTransaction(db,f.owner,'SOC'),[])}
 finally{db.release()}
 // 回到本地那一版仍然可行：expectedCurrentVersion 此时是 0（回到模板版本即"当前没有本地版本"）。
 const again=await f.service.revert(f.actor,{requestId:randomUUID(),scope:'SOC',kind:'view',localId:'soc-risk-distribution',target:{kind:'local-version',version:1},expectedCurrentVersion:0})
 assert.equal(again.current?.version,1)
})

test('本地声明的 domain 必须等于目标 scope，general 一律拒绝',async()=>{
 const f=plain()
 await assert.rejects(
  ()=>f.service.draft(f.actor,{scope:'AppSec',kind:'view',definition:riskView(),requestId:randomUUID()}),
  {code:'teloa/invalid-input'},'domain 是 SOC 的声明不能写进 AppSec',
 )
 await assert.rejects(
  ()=>f.service.draft(f.actor,{scope:'general',kind:'view',definition:riskView({domain:'general'}),requestId:randomUUID()}),
  {code:'teloa/invalid-input'},'general 在范围与 domain 两处都被拒',
 )
 await assert.rejects(
  ()=>f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({domain:'general'}),requestId:randomUUID()}),
  {code:'teloa/invalid-input'},
 )
 await assert.rejects(
  ()=>f.service.draft(f.actor,{scope:'Unknown',kind:'view',definition:riskView({domain:'Unknown'}),requestId:randomUUID()}),
  {code:'teloa/forbidden'},'未登记给本人的范围一律拒绝',
 )
 // 种类与正文对不上（按 object-type 读一份视图正文）也在这一道闸上被拦住。
 await assert.rejects(
  ()=>f.service.draft(f.actor,{scope:'SOC',kind:'object-type',definition:riskView(),requestId:randomUUID()}),
  {code:'teloa/invalid-input'},
 )
})

test('版本链超过 50 条即 teloa/conflict，不截断、不覆盖最旧的一条',async()=>{
 const f=plain()
 const limit=businessCustomizationLimits.versionsPerDefinition
 for(let index=0;index<limit;index+=1)await f.land(riskView({title:'风险分布 '+index}),index)
 const draft=await f.service.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({title:'第 51 版'}),requestId:randomUUID()})
 await assert.rejects(
  ()=>f.service.apply(f.actor,confirmed(f.actor,draft,limit)),
  {code:'teloa/conflict'},
 )
 const entry=(await f.service.directory(f.actor,{scope:'SOC'})).entries[0]!
 assert.equal(entry.versions.length,limit)
 assert.equal(entry.versions[0]!.version,1,'最旧的那一条还在')
 assert.equal(entry.current?.version,limit)
 // 被拒的那一份仍是草案：上限拦在写版本之前，草案与指针都没动。
 const db=await pool.connect()
 try{
  const stored=await f.service.draftInTransaction(db,f.owner,draft.id)
  assert.deepEqual([stored.status,stored.appliedVersion],['draft',undefined])
 }finally{db.release()}
})

test('数据源映射生效数上限：范围内已有 32 个生效映射时新映射 teloa/conflict，改既有映射不受限',async()=>{
 const f=plain()
 const mapping=(id:string)=>({format:'teloa.business-source-mapping/v1',id,version:'1.0.0',domain:'SOC',title:'告警同步',objectType:'alert-ticket',
  source:{kind:'business-data-port',sourceId:'security-alert-http'},mapping:[],primaryKey:['id'],deletionSemantics:'compare',schedule:{kind:'every',seconds:3600},acknowledgeShortInterval:false})
 for(let index=0;index<31;index+=1)await pool.query(`insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,'SOC','source-mapping',$2,1,1,now())`,[f.owner,'filler-'+index])
 // 回到模板版本的指针（version 为空）不算生效。
 await pool.query(`insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,'SOC','source-mapping','reverted',null,2,now())`,[f.owner])
 const first=await f.service.draft(f.actor,{scope:'SOC',kind:'source-mapping',definition:mapping('soc-port'),requestId:randomUUID()})
 await f.service.apply(f.actor,confirmed(f.actor,first,0))
 const again=await f.service.draft(f.actor,{scope:'SOC',kind:'source-mapping',definition:{...mapping('soc-port'),version:'1.0.1'},requestId:randomUUID()})
 await f.service.apply(f.actor,confirmed(f.actor,again,1))
 const extra=await f.service.draft(f.actor,{scope:'SOC',kind:'source-mapping',definition:mapping('soc-extra'),requestId:randomUUID()})
 await assert.rejects(f.service.apply(f.actor,confirmed(f.actor,extra,0)),(error:{code?:string;message?:string})=>error.code==='teloa/conflict'&&/32/.test(error.message!))
 // 回退到模板版本腾出一个位置；再从模板回到本地版本同样算新增生效。
 await f.service.revert(f.actor,{requestId:randomUUID(),scope:'SOC',kind:'source-mapping',localId:'soc-port',target:{kind:'template'},expectedCurrentVersion:2})
 await f.service.apply(f.actor,confirmed(f.actor,extra,0))
 await assert.rejects(f.service.revert(f.actor,{requestId:randomUUID(),scope:'SOC',kind:'source-mapping',localId:'soc-port',target:{kind:'local-version',version:2},expectedCurrentVersion:0}),{code:'teloa/conflict'})
 // 后面有用例会临时把种类约束收紧回三种：本条写下的映射行必须清掉，否则收紧时被存量行挡住。
 for(const table of ['teloa_business_definition_drafts','teloa_business_local_definitions','teloa_business_local_definition_heads'])await pool.query(`delete from ${table} where owner_id=$1`,[f.owner])
})

test('同一范围同一对象类型只允许一个 compare 映射生效；tombstone 映射、其他对象类型、改同一映射不受限',async()=>{
 const f=plain()
 const port=(id:string,overrides:Record<string,unknown>={})=>({format:'teloa.business-source-mapping/v1',id,version:'1.0.0',domain:'SOC',title:'告警同步',objectType:'alert-ticket',
  source:{kind:'business-data-port',sourceId:'security-alert-http'},mapping:[],primaryKey:['id'],deletionSemantics:'compare',schedule:{kind:'every',seconds:3600},acknowledgeShortInterval:false,...overrides})
 const tomb=(id:string)=>port(id,{source:{kind:'mcp-tool',serverName:'soc',tool:'list_alerts',arguments:{},itemsPath:'$.items[*]'},mapping:[{path:'$.id',field:'id'}],deletionSemantics:'tombstone',deletedAtPath:'$.deleted_at'})
 const draft=(definition:Record<string,unknown>)=>f.service.draft(f.actor,{scope:'SOC',kind:'source-mapping',definition,requestId:randomUUID()})
 const land=async(definition:Record<string,unknown>,expected=0)=>f.service.apply(f.actor,confirmed(f.actor,await draft(definition),expected))
 const refused=(error:{code?:string;message?:string})=>error.code==='teloa/invalid-input'&&error.message==='同一业务范围的同一对象类型只能有一个按 compare 对比缺席的数据源映射生效；请先回退另一个。'
 await land(port('soc-port'))
 await land({...port('soc-port'),version:'1.0.1'},1)
 const second=await draft(port('soc-port-2'))
 await assert.rejects(f.service.apply(f.actor,confirmed(f.actor,second,0)),refused)
 await land(tomb('soc-tomb'))
 await land(port('asset-port',{objectType:'asset'}))
 // 回退到模板版本腾出位置后第二个可以生效；原来那个再从模板回到本地版本同样被拒。
 await f.service.revert(f.actor,{requestId:randomUUID(),scope:'SOC',kind:'source-mapping',localId:'soc-port',target:{kind:'template'},expectedCurrentVersion:2})
 await f.service.apply(f.actor,confirmed(f.actor,second,0))
 await assert.rejects(f.service.revert(f.actor,{requestId:randomUUID(),scope:'SOC',kind:'source-mapping',localId:'soc-port',target:{kind:'local-version',version:2},expectedCurrentVersion:0}),refused)
 for(const table of ['teloa_business_definition_drafts','teloa_business_local_definitions','teloa_business_local_definition_heads'])await pool.query(`delete from ${table} where owner_id=$1`,[f.owner])
})

test('同 localId 时台账取本地那一份，source.origin==="local"；模板那一份不出现两次',async()=>{
 const f=await ledgerHarness()
 // 版本从夹具 body 读，不写死：夹具改版号时这条测试不必跟着改。
 const templatePath=fileURLToPath(new URL('../../../tests/fixtures/业务定制层/SOC/views/soc-risk-distribution.json',import.meta.url))
 const templateVersion=(JSON.parse(await readFile(templatePath,'utf8')) as {version:string}).version
 const before=await f.views()
 const baseline=before.find(view=>view.viewId==='soc-risk-distribution')!
 assert.equal(baseline.origin,'template')
 assert.ok(before.every(view=>view.origin==='template'))
 assert.deepEqual([baseline.title,baseline.viewVersion],['风险分布',templateVersion])

 const draft=await f.local.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({version:'1.1.0',title:'风险分布（本地）',dimension:{field:'severity',limit:2},limit:2}),requestId:randomUUID()})
 const entry=await f.local.apply(f.actor,confirmed(f.actor,draft,0))
 assert.deepEqual(entry.template,{available:true,version:templateVersion},'模板侧同名声明由加载项读出来')

 const after=await f.views()
 assert.equal(after.filter(view=>view.viewId==='soc-risk-distribution').length,1,'模板那一份被覆盖，不出现两次')
 assert.equal(after.length,before.length,'块里的视图条数不变')
 const merged=after.find(view=>view.viewId==='soc-risk-distribution')!
 assert.deepEqual([merged.origin,merged.title,merged.viewVersion],['local','风险分布（本地）','1.1.0'])
 assert.equal(merged.definitionHash,entry.current!.definitionHash,'台账带出来的摘要就是版本链里那一份')
 assert.notEqual(merged.definitionHash,baseline.definitionHash,'声明一变旧结果整条作废重算')
 assert.equal(merged.rows.length,2,'本地声明里的维度上限真的生效了')
 assert.ok(after.filter(view=>view.viewId!=='soc-risk-distribution').every(view=>view.origin==='template'),'同块里没被定制的视图仍标模板')

 // 回到模板版本后台账立刻回到模板那一份，仍旧只有一条。
 await f.local.revert(f.actor,{requestId:randomUUID(),scope:'SOC',kind:'view',localId:'soc-risk-distribution',target:{kind:'template'},expectedCurrentVersion:1})
 const restored=await f.views()
 const back=restored.filter(view=>view.viewId==='soc-risk-distribution')
 assert.equal(back.length,1)
 assert.deepEqual([back[0]!.origin,back[0]!.definitionHash],['template',baseline.definitionHash])
})

test('本地声明的跨引用核对一条不放宽：引用不存在的对象类型即 source-unavailable 并指名是哪一份',async()=>{
 const f=await ledgerHarness()
 const draft=await f.local.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({id:'soc-local-only',objectType:'alert-ticket',title:'只在本地的视图'}),requestId:randomUUID()})
 await f.local.apply(f.actor,confirmed(f.actor,draft,0))
 // 新增（模板侧没有同名）的本地视图按"引用的对象类型在哪个加载里"归位，跨引用成立时照常进台账。
 assert.ok((await f.views()).some(view=>view.viewId==='soc-local-only'))

 // 换成一个引用不存在字段的本地视图：判据与模板声明共用同一处，覆盖不放宽任何一条。
 const broken=await f.local.draft(f.actor,{scope:'SOC',kind:'view',definition:riskView({dimension:{field:'not-a-field',limit:3}}),requestId:randomUUID()})
 await f.local.apply(f.actor,confirmed(f.actor,broken,0))
 await assert.rejects(()=>f.views(),(error:unknown)=>{
  const work=error as {code?:string;message?:string}
  assert.equal(work.code,'teloa/source-unavailable')
  assert.match(String(work.message),/view:soc-risk-distribution/)
  return true
 })
})

test('声明种类约束放宽为六种：存量库上的旧约束被替换，重复初始化幂等',async()=>{
 const tables=['teloa_business_definition_drafts','teloa_business_local_definitions','teloa_business_local_definition_heads']
 // 还原成第一期那条未命名 check（PostgreSQL 自动命名为 <表>_kind_check），模拟存量库。
 for(const table of tables)await pool.query(`alter table ${table} drop constraint ${table}_kind_check, add check(kind in ('object-type','view','action'))`)
 await initializeBusinessDefinitions(pool)
 await initializeBusinessDefinitions(pool)
 const checks=(await pool.query(`select conrelid::regclass::text as t,conname from pg_constraint where contype='c' and conrelid=any($1::regclass[]) and pg_get_constraintdef(oid) like '%kind%' order by 1`,[tables])).rows
 assert.deepEqual(checks,tables.map(t=>({t,conname:t+'_kind_check'})).sort((a,b)=>a.t.localeCompare(b.t)),'每张表只剩一条 kind 约束')
 const owner='local:'+randomUUID(),insert=(kind:string)=>pool.query(`insert into teloa_business_definition_drafts(owner_id,id,request_id,scope_id,kind,local_id,semver,definition_hash,body,status,applied_version,created_at,updated_at)
   values($1,$2,$3,'SOC',$4,'w-1','1.0.0',$5,'{}','draft',null,now(),now())`,[owner,randomUUID(),randomUUID(),kind,'a'.repeat(64)])
 for(const kind of ['source-mapping','widget','dashboard'])await insert(kind)
 await assert.rejects(insert('foo'),{code:'23514'})
 await pool.query('delete from teloa_business_definition_drafts where owner_id=$1',[owner])
 // 定义已一致时重复初始化不再 drop/add：约束 oid 不变（每次启动不为三张表各取一次排他锁、不重扫全表）。
 const oids=async()=>(await pool.query(`select conrelid::regclass::text as t,oid::text as o from pg_constraint where contype='c' and conrelid=any($1::regclass[]) and conname=conrelid::regclass::text||'_kind_check' order by 1`,[tables])).rows
 const settled=await oids()
 assert.equal(settled.length,3)
 await initializeBusinessDefinitions(pool)
 assert.deepEqual(await oids(),settled)
})

test('草案写库遇数据库约束错误映射为既有错误码，文案不带表名与约束名；放宽后组件草案可落库',async()=>{
 const {actor,service}=plain()
 const widget={format:'teloa.business-widget/v1',id:'alert-count',version:'1.0.0',domain:'SOC',title:'告警数',kind:'metric',query:'select count(*) as n from alert_ticket',metric:{valueColumn:'n'}}
 await pool.query(`alter table teloa_business_definition_drafts drop constraint teloa_business_definition_drafts_kind_check, add constraint teloa_business_definition_drafts_kind_check check(kind in ('object-type','view','action'))`)
 try{
  await assert.rejects(service.draft(actor,{scope:'SOC',kind:'widget',definition:widget,requestId:randomUUID()}),(error:{code?:string;message?:string})=>
   error.code==='teloa/invalid-input'&&!/teloa_|_check|constraint|violates/i.test(error.message!))
 }finally{await initializeBusinessDefinitions(pool)}
 const saved=await service.draft(actor,{scope:'SOC',kind:'widget',definition:widget,requestId:randomUUID()})
 assert.equal(saved.kind,'widget')
})

test('页内 business-definition 草案经 applyInTransaction 不能绕过配置受管保护',async()=>{
 const {initializePageCreateDrafts}=await import('../src/work/page-create-drafts.ts')
 const {BusinessSpaceService}=await import('../src/work/business-spaces.ts')
 await initializePageCreateDrafts(pool)
 const {actor,service}=plain()
 await new BusinessSpaceService(pool,identity).ensurePersonal(actor.ownerId)
 await pool.query("update teloa_business_scopes set configuration_managed=true where owner_id=$1 and scope='SOC'",[actor.ownerId])
 const id=randomUUID(),body=JSON.stringify(riskView())
 await pool.query("insert into teloa_page_create_drafts(owner_id,id,request_id,entity,scope_id,title,body,body_hash,status,created_at,updated_at) values($1,$2,$3,'business-definition','SOC','风险分布',$4,$5,'draft',now(),now())",[actor.ownerId,id,randomUUID(),body,sha256(body)])
 const db=await pool.connect()
 try{
  await db.query('begin')
  await assert.rejects(service.applyInTransaction(db,actor,confirmed(actor,{id,scope:'SOC',definitionHash:'a'.repeat(64)},0)),{code:'teloa/conflict'})
  await db.query('rollback')
  assert.equal((await pool.query('select 1 from teloa_business_local_definitions where owner_id=$1',[actor.ownerId])).rowCount,0)
 }finally{db.release()}
})
