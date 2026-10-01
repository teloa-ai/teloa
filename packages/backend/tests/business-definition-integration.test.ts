import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join,relative,sep} from 'node:path'
import {readFile,readdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {
 compareIndustryUpdateCore,industryUpdateResourceOptions,
 type IndustryUpdateManifest,type IndustryUpdateSide,
} from '@teloa/contract'
import {
 MarketContentStore,initializeMarketContents,type MarketContent,
 createIndustryLoadSource,IndustryLoadService,initializeIndustryLoads,type IndustryLoadRecord,
 IndustryDataSourceService,IndustryDataSourceSource,initializeIndustryDataSources,
 IndustryWorkSource,IndustryTaskService,initializeIndustryTasks,
 TaskService,initializeTasks,initializeRoles,
 BusinessDataService,initializeBusinessData,
 BusinessDefinitionSourceReader,BusinessLedgerService,type BusinessLedgerActor,
 ConnectorProbeService,
} from '../src/index.ts'

/**
 * 本测试是业务定制层第一期的端到端验收：两份真夹具模板（SOC / AppSec）经真实
 * MarketContentStore 导入、真实 IndustryLoadService 加载，最终由 BusinessLedgerService
 * 算出台账。SOC 绑今天已经在跑的真实端口 `security-alert-http`（数据面本身用假来源，
 * 只有身份字符串是真的），AppSec 绑 `appsec-finding-http`——这个端口今天不存在，
 * 规格 §十二已说明它是为把声明写完整而假定的身份，本测试只验到"有声明、数据源未接上"这一档。
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
 await initializeRoles(pool)
 await initializeTasks(pool)
 await initializeIndustryTasks(pool)
 await initializeBusinessData(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const enc=new TextEncoder()
const identity={id:randomUUID,now:()=>new Date().toISOString()}

type Built={manifest:Record<string,unknown>;files:Array<{path:string;bytes:Uint8Array}>}

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

async function readManifestFiles(domain:string):Promise<Built>{
 const base=fileURLToPath(new URL('../../../tests/fixtures/业务定制层/'+domain+'/',import.meta.url))
 const paths=await walk(base,base)
 const files=await Promise.all(paths.map(async path=>({path,bytes:new Uint8Array(await readFile(join(base,path)))})))
 const manifestFile=files.find(file=>file.path==='teloa.json')
 if(!manifestFile)throw new Error('夹具缺少 teloa.json：'+domain)
 const manifest=JSON.parse(new TextDecoder('utf-8').decode(manifestFile.bytes)) as Record<string,unknown>
 return {manifest,files}
}

function cloneBuilt(built:Built):Built{
 return {manifest:JSON.parse(JSON.stringify(built.manifest)),files:built.files.map(file=>({path:file.path,bytes:file.bytes}))}
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
 * 端到端夹具：真 MarketContentStore 导入 + 真 IndustryLoadService 加载 + 真 BusinessLedgerService 计算，
 * 三件套复用 `industry-resource-instantiation-integration.test.ts` 已验证的搭法，只把资源换成业务定制声明。
 */
async function harness(db:Pool){
 const owner='local:'+randomUUID(),actor:BusinessLedgerActor={ownerId:owner,scopeIds:['SOC','AppSec']}
 const market=new MarketContentStore(db,identity)
 const loads=new IndustryLoadService(db,identity,createIndustryLoadSource(market))
 const dataSources=new IndustryDataSourceService(db,identity,loads,new IndustryDataSourceSource(market,loads),{
  ready:async()=>({ready:true,probedAt:identity.now()}),
 })
 const tasks=new TaskService(db,identity)
 const industryTasks=new IndustryTaskService(db,identity,new IndustryWorkSource(market,loads),tasks)
 /**
  * 一个加载内已激活的数据源标识集合，按 `binding` 里记的 `sourceId` 取——这是
  * `BusinessDefinitionSourceReader` 实际比对的那个标识（声明的 `sourceId`，不是清单资源自己的 `id`）。
  */
 const definitions=new BusinessDefinitionSourceReader(market,loads,{
  activeSourceIds:async(client:PoolClient,ownerId:string,loadId:string)=>{
   const rows=(await client.query(`select binding->>'sourceId' as source_id from teloa_industry_data_source_instances where owner_id=$1 and load_id=$2 and state='active'`,[ownerId,loadId])).rows as Array<{source_id:string}>
   return new Set(rows.map(row=>row.source_id))
  },
 })
 const ledgerService=new BusinessLedgerService(db,identity,definitions)
 const cache=new Map<string,Built>()

 async function importAndLoad(domain:string):Promise<IndustryLoadRecord>{
  let built=cache.get(domain)
  if(!built){built=await readManifestFiles(domain);cache.set(domain,built)}
  const saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:domain},manifestPath:'teloa.json',files:built.files.map(file=>({path:file.path,bytes:file.bytes})),references:[]})
  return loads.create(owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'new',spaceId:randomUUID(),name:domain}})
 }

 async function connectDataSource(load:IndustryLoadRecord,localId:string){
  const item=load.items.find(row=>row.localId===localId)
  if(!item)throw new Error('夹具里没有这个数据源资源：'+localId)
  const created=await dataSources.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:item.instanceId})
  return dataSources.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:created.revision},new AbortController().signal)
 }

 async function pushAlerts(count:number){
  const port={id:'security-alert-http',scopes:['SOC'],query:async()=>({schema:'teloa.data-source-page/v1',sourceId:'security-alert-http',scope:'SOC',capturedAt:identity.now(),items:Array.from({length:count},(_value,index)=>alertSnapshot(index+1))})}
  return new BusinessDataService(db,port as never).query({ownerId:owner,scopeIds:['SOC']},{scope:'SOC',limit:count})
 }

 /**
  * 台账读取不做任何夹具层的加工：卸载之后服务端回的就是"没有块"的空台账（客户端第 1 档空态），
  * 这是规格行为，不是错误——此前夹具在这里自己 `throw` 一个 `source-unavailable`，
  * 用例断言的其实是夹具自己的那一行，与生产行为无关（复审 HIGH-3）。
  */
 async function ledger(scope:string,objectType?:string){return ledgerService.read(actor,{scope,...(objectType?{objectType}:{})})}

 function requirementsCount(domain:string,localId:string):number{
  const built=cache.get(domain)
  if(!built)throw new Error('先调用 importAndLoad 生成夹具缓存：'+domain)
  const resource=(built.manifest.resources as Array<Record<string,unknown>>).find(row=>row.id===localId)
  if(!resource)throw new Error('夹具里没有这个资源：'+localId)
  const path=(resource.source as {path:string}).path
  const file=built.files.find(row=>row.path===path)
  if(!file)throw new Error('夹具里没有这个文件：'+path)
  const template=JSON.parse(new TextDecoder('utf-8').decode(file.bytes)) as {requirements:string[]}
  return template.requirements.length
 }

 async function createTaskFromWorkTemplate(load:IndustryLoadRecord,localId:string){
  const item=load.items.find(row=>row.localId===localId)
  if(!item)throw new Error('夹具里没有这个工作模板：'+localId)
  const count=requirementsCount(load.domain,localId)
  const record=await industryTasks.create(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:item.instanceId,goal:'核对并给出结论',inputs:Array.from({length:count},(_value,index)=>'输入 '+(index+1))})
  return record.task
 }

 async function task(taskId:string){
  // `IndustryTaskService.source` 回的是任务的行业来源快照（`taskId` 字段），不是 `{task,source}`：
  // 这里按 `taskId` 认领出 `.id`，用来证明卸载后任务定义与对象快照仍能独立读出，不依赖声明。
  const record=await industryTasks.source(owner,{taskId})
  if(!record)throw new Error('任务不存在：'+taskId)
  return {id:record.taskId,...record}
 }

 async function retire(load:IndustryLoadRecord){
  return loads.unload(owner,{requestId:randomUUID(),loadId:load.id,expectedMappingHash:load.mappingHash})
 }

 /** 任务本体：走 `TaskService` 这条与行业加载无关的读取路径，卸载之后任务定义本身必须照常读得出来。 */
 async function storedTask(taskId:string){return (await tasks.list(owner,{})).find(row=>row.id===taskId)}
 /** 固定快照行：直接查快照表，声明卸载不影响已经落库的对象快照（规格 §4.2「读过即固定」）。 */
 async function storedSnapshots(scope:string,objectType:string){
  return (await db.query('select object_id,object_version,snapshot_hash from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 order by object_id',[owner,scope,objectType])).rows as Array<{object_id:string;object_version:number;snapshot_hash:string}>
 }

 async function bundle(load:IndustryLoadRecord){
  const client=await db.connect()
  try{
   // 这里不需要 `read only`：`BusinessLedgerService.read` 现在也用得上它，因为它经
   // `BusinessDefinitionSourceReader` 读固定内容时走的是不取锁的读口（`getInTransaction(...,false)`），
   // 不再发 `select ... for share`，两者不冲突。这条测试路径只是普通只读事务，无须特意加这一位。
   await client.query('begin isolation level repeatable read')
   const result=await definitions.bundle(client,owner,load.id)
   await client.query('commit')
   return result
  }catch(error){await client.query('rollback').catch(()=>{});throw error}finally{client.release()}
 }

 async function exportArchive(load:IndustryLoadRecord){
  const content=await market.get({ownerId:owner,kind:'human'},{contentId:load.contentId})
  return {manifestPath:content.manifestPath,files:content.files.map(file=>({path:file.path,bytes:file.bytes}))}
 }

 /**
  * 重新导入并加载到一个**新空间**：同空间重入会命中"同一份摘要复用既有加载"的路径，
  * 那样比出来的两个 definitionHash 来自同一条加载记录，是自反比较，证明不了任何事（复审 HIGH-4）。
  */
 async function importArchiveAndLoad(archive:Awaited<ReturnType<typeof exportArchive>>){
  const saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'重新导入'},manifestPath:archive.manifestPath,files:archive.files.map(file=>({path:file.path,bytes:file.bytes})),references:[]})
  return loads.create(owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'重新导入'}})
 }

 /** 把某个已加载模板里的一张视图声明升到候选版本：维度上限从 3 改成 4，版本随之升到 1.1.0。 */
 function bumpView(localId:string):Built{
  for(const built of cache.values()){
   const resource=(built.manifest.resources as Array<Record<string,unknown>>).find(row=>row.id===localId)
   if(!resource)continue
   const next=cloneBuilt(built)
   const nextResource=(next.manifest.resources as Array<Record<string,unknown>>).find(row=>row.id===localId)!
   nextResource.version='1.1.0'
   const path=(nextResource.source as {path:string}).path
   const file=next.files.find(row=>row.path===path)!
   const view=JSON.parse(new TextDecoder('utf-8').decode(file.bytes)) as {version:string;dimension:{limit:number}}
   view.version='1.1.0';view.dimension.limit=4
   file.bytes=enc.encode(JSON.stringify(view))
   return next
  }
  throw new Error('夹具缓存里没有这个视图：'+localId)
 }

 /**
  * 两侧都取真实 `MarketContentStore` 已固定下来的内容：候选包先真导入一次，再拿它落库后的
  * 清单与文件摘要参与比对——此前候选侧是测试自己拼的一份 `IndustryUpdateSide`（清单取原始 JSON、
  * 摘要自己 sha 一遍），等于用一份测试内的重实现去喂差异算法，导入这一路的归一化根本没被走过。
  */
 async function compare(load:IndustryLoadRecord,candidate:Built){
  const content=await market.get({ownerId:owner,kind:'human'},{contentId:load.contentId})
  const saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'候选版本'},manifestPath:'teloa.json',files:candidate.files.map(file=>({path:file.path,bytes:file.bytes})),references:[]})
  const side=(value:MarketContent):IndustryUpdateSide=>({manifest:value.metadata as unknown as IndustryUpdateManifest,manifestPath:value.manifestPath,files:value.files.map(file=>({path:file.path,hash:file.hash}))})
  return compareIndustryUpdateCore(side(content),side(saved.content))
 }

 /**
  * 连接器「测试连接」按 DSH 装配处的同一形状搭起来：探针整条路径跑在 `repeatable read read only` 事务里，
  * 因此它那一份读取层必须拿**不取锁**的市场读口（`getInTransaction(...,false)`）。`locked` 传真时故意换回
  * 缺省读口，用来钉住"为什么必须传 false"——那条路径会被 Postgres 判 25006（`for share` 不能在只读事务里跑）。
  */
 function connectorProbe(locked=false){
  const port=locked?market:{getInTransaction:(client:PoolClient,actor:Parameters<MarketContentStore['getInTransaction']>[1],input:unknown)=>market.getInTransaction(client,actor,input,false)}
  const source=new IndustryDataSourceSource(port,loads)
  return new ConnectorProbeService(db,identity,{
   'data-source':{read:(client:PoolClient,ownerId:string,input:{loadId:string;itemInstanceId:string})=>source.read(client,ownerId,input),ready:async()=>({ready:true,probedAt:identity.now()})},
   mcp:{read:async()=>{throw new Error('本用例不验 MCP')},ready:async()=>({ready:true,observedAt:identity.now()})},
   'execution-tool':{read:async()=>{throw new Error('本用例不验执行工具')},ready:async()=>({ready:true})},
  } as never)
 }
 /** 数据源实例行原样取出：探针只读，`revision` 与 `binding` 必须逐列不变。 */
 async function dataSourceRow(instanceId:string){
  return (await db.query('select revision,state,binding from teloa_industry_data_source_instances where id=$1',[instanceId])).rows[0] as {revision:number;state:string;binding:unknown}
 }

 return {
  owner,importAndLoad,connectDataSource,pushAlerts,ledger,createTaskFromWorkTemplate,task,retire,bundle,
  storedTask,storedSnapshots,connectorProbe,dataSourceRow,
  export:exportArchive,importArchiveAndLoad,bumpView,compare,options:industryUpdateResourceOptions,
 }
}

test('两个 domain 不同的夹具模板：导入 → 加载 → 台账，组件侧共用同一批数据',async()=>{
 const f=await harness(pool)
 const soc=await f.importAndLoad('SOC'),appsec=await f.importAndLoad('AppSec')
 assert.equal(soc.items.filter(item=>item.kind==='object-type').length,3)
 assert.equal(soc.items.filter(item=>item.kind==='execution-tool').length,1,'isolate-endpoint 的 target.localId 在加载里真有一个执行工具项')
 assert.equal(appsec.items.filter(item=>item.kind==='business-view').length,5,'三个对象类型各有清单视图，另保留两张低频分析视图')
 await f.connectDataSource(soc,'soc-alert-source') // 只连 SOC 那一个
 await f.pushAlerts(12)
 const socLedger=await f.ledger('SOC')
 assert.deepEqual(socLedger.blocks.map(block=>block.objectType.definition.id).sort(),['alert-ticket','asset','incident-ticket'])
 assert.equal(socLedger.blocks.find(b=>b.objectType.definition.id==='alert-ticket')!.source.connected,true)
 assert.equal(socLedger.blocks.find(b=>b.objectType.definition.id==='alert-ticket')!.views.length,3,'不指名对象类型时不算清单视图')
 // 指名对象类型才算清单：告警工单目录里的表在夹具上端到端跑通。
 const directory=(await f.ledger('SOC','alert-ticket')).blocks[0]!
 const list=directory.views.find(view=>view.kind==='list')!
 assert.deepEqual([list.chart,list.title],['table','告警清单'])
 assert.equal(list.objects?.length,12)
 assert.deepEqual(list.objects?.map(row=>row.id),list.rows.map(row=>row.dimension))
 assert.deepEqual(directory.coverage,{objects:12,latestReceivedAt:directory.coverage.latestReceivedAt,truncated:false})
 const appsecLedger=await f.ledger('AppSec')
 assert.equal(appsecLedger.blocks.length,3)
 assert.ok(appsecLedger.blocks.every(block=>block.source.connected===false),'AppSec 走第 2 档空态：有声明、数据源未连接')
})

test('导出 → 重新导入到另一个空间 → 加载，definitionHash 逐字相同',async()=>{
 const f=await harness(pool),first=await f.importAndLoad('SOC')
 const archive=await f.export(first) // exportIndustryArchive 路径零改动，声明作为包内文件天然被带上
 const second=await f.importArchiveAndLoad(archive)
 const a=await f.bundle(first),b=await f.bundle(second)
 assert.equal(a.origin.kind,'market');assert.equal(b.origin.kind,'market')
 assert.notEqual(a.origin.kind==='market'?a.origin.loadId:null,b.origin.kind==='market'?b.origin.loadId:null,'两个加载各自独立，比较不是自反的')
 assert.deepEqual(b.objectTypes.map(row=>row.source.definitionHash),a.objectTypes.map(row=>row.source.definitionHash))
 assert.deepEqual(b.views.map(row=>row.source.definitionHash),a.views.map(row=>row.source.definitionHash))
 assert.deepEqual(b.actions.map(row=>row.source.definitionHash),a.actions.map(row=>row.source.definitionHash))
})

test('升级预览把三类声明当普通资源逐项判差异，compareIndustryUpdateCore 一行没改',async()=>{
 const f=await harness(pool),loaded=await f.importAndLoad('SOC')
 const v2=f.bumpView('soc-risk-distribution') // 模板侧把维度上限从 3 改成 4，版本升到 1.1.0
 const diff=await f.compare(loaded,v2)
 assert.deepEqual(diff.resources.find(row=>row.id==='soc-risk-distribution')?.change,'changed')
 assert.deepEqual([...f.options('changed','business-view')],['keep','candidate','skip'],'声明没有实例，没有 detach')
 assert.deepEqual([...f.options('added','business-view')],['candidate','skip'])
})

test('卸载后台账空掉，已产出的业务任务与固定快照照常保留',async()=>{
 const f=await harness(pool),loaded=await f.importAndLoad('SOC')
 await f.connectDataSource(loaded,'soc-alert-source');await f.pushAlerts(2)
 const task=await f.createTaskFromWorkTemplate(loaded,'alert-triage-review')
 const before=await f.storedSnapshots('SOC','alert-ticket')
 assert.equal(before.length,2)
 await f.retire(loaded)
 // 声明随加载一起走掉，台账就没有块了——这是规格里的第 1 档空态，不是读取失败。
 assert.deepEqual((await f.ledger('SOC')).blocks,[])
 assert.equal((await f.task(task.id)).id,task.id,'行业来源快照仍能按任务标识认领出来')
 assert.equal((await f.storedTask(task.id))?.goal,'核对并给出结论','任务本体走 TaskService 读，与行业加载无关')
 assert.deepEqual(await f.storedSnapshots('SOC','alert-ticket'),before,'固定快照行一条没少、摘要一字没变')
})

/**
 * 2026-09-16 隔离宿主验收实测：三类连接器的「测试连接」在真宿主上一律回 `teloa/host-unavailable`，
 * 根因是探针的只读事务撞上市场固定内容读口缺省的 `select … for share`（Postgres 25006）。
 * T6 的既有用例全部用假读取层，从没经过真实 `MarketContentStore`，这条路径此前零覆盖。
 */
test('连接器测试连接走真实固定内容读取：回真形状、实例逐列不变，取锁读口则被只读事务判 25006',async()=>{
 const f=await harness(pool)
 const soc=await f.importAndLoad('SOC')
 const instance=await f.connectDataSource(soc,'soc-alert-source')
 const before=await f.dataSourceRow(instance.id)
 const result=await f.connectorProbe().probe(f.owner,{kind:'data-source',instanceId:instance.id},new AbortController().signal)
 assert.deepEqual(Object.keys(result).sort(),['instanceId','kind','ok','probedAt'],'成功回包只有四列，不带 details 也不带凭据')
 assert.equal(result.ok,true)
 assert.equal(result.kind,'data-source')
 assert.equal(result.instanceId,instance.id)
 assert.ok(Number.isFinite(Date.parse(result.probedAt)))
 assert.deepEqual(await f.dataSourceRow(instance.id),before,'一次试探不推进 revision、不改 state 与 binding')
 await assert.rejects(
  ()=>f.connectorProbe(true).probe(f.owner,{kind:'data-source',instanceId:instance.id},new AbortController().signal),
  (error:unknown)=>(error as {code?:string}).code==='25006',
  '缺省取锁的市场读口在只读事务里必然被 Postgres 拒绝——装配处必须传 false，这条断言就是那个理由',
 )
})
