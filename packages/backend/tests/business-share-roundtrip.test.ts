import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,readdir} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join,relative,sep} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {
 BusinessDataService,BusinessDefinitionSourceReader,BusinessLedgerService,
 createIndustryLoadSource,IndustryDataSourceService,IndustryDataSourceSource,IndustryLoadService,
 initializeBusinessData,initializeIndustryDataSources,initializeIndustryLoads,initializeMarketContents,MarketContentStore,
} from '../src/index.ts'

/**
 * 分享包的真库回归：原 SOC 模板与只含声明的生成包各自落到独立本人和空间，
 * 对同一组固定快照计算台账。这样既经 MarketContentStore / IndustryLoadService 的真实
 * 字节路径，又避免同范围双加载触发同 localId 的冲突保护。
 */
let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool);await initializeIndustryLoads(pool);await initializeIndustryDataSources(pool);await initializeBusinessData(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const NOW='2026-09-17T00:00:00.000Z'
const identity={id:randomUUID,now:()=>NOW}
const root=fileURLToPath(new URL('../../../tests/fixtures/',import.meta.url))
type FixtureFile={path:string;bytes:Uint8Array}

async function walk(directory:string,base=directory):Promise<FixtureFile[]>{
 const entries=await readdir(directory,{withFileTypes:true})
 return (await Promise.all(entries.map(async entry=>{
  const full=join(directory,entry.name)
  return entry.isDirectory()?walk(full,base):[{path:relative(base,full).split(sep).join('/'),bytes:new Uint8Array(await readFile(full))}]
 }))).flat()
}

const snapshots=Array.from({length:3},(_value,index)=>({
 scope:'SOC',type:'alert-ticket',id:'alert-'+(index+1),version:1,title:'告警 '+(index+1),source:'EDR',
 observedAt:'2026-09-16T0'+(index+1)+':00:00.000Z',receivedAt:'2026-09-16T0'+(index+1)+':00:01.000Z',quality:'complete' as const,
 summary:'第 '+(index+1)+' 条告警。',fields:[
  {label:'严重度',value:['高','中','低'][index]!},{label:'主机',value:'prod-'+(index+1)},
  {label:'当前判定',value:'还没有人看'},{label:'首次出现',value:'2026-09-16T0'+(index+1)+':00:00.000Z'},
  {label:'涉及账号数',value:String(index+1)},
 ],
}))

async function runFiles(files:FixtureFile[],name:string){
 const owner='local:'+randomUUID(),actor={ownerId:owner,scopeIds:['SOC']}
 const market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
 const saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name},manifestPath:'teloa.json',files,references:[]})
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'SOC'}})
 const dataSources=new IndustryDataSourceService(pool,identity,loads,new IndustryDataSourceSource(market,loads),{ready:async()=>({ready:true,probedAt:NOW})})
 const sourceItem=load.items.find(item=>item.kind==='data-source')
 assert.ok(sourceItem,'声明包必须有数据源')
 const instance=await dataSources.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:sourceItem.instanceId})
 await dataSources.authorize(owner,{requestId:randomUUID(),instanceId:instance.id,expectedRevision:instance.revision},new AbortController().signal)
 const data=new BusinessDataService(pool,{id:'security-alert-http',scopes:['SOC'],query:async()=>({schema:'teloa.data-source-page/v1',sourceId:'security-alert-http',scope:'SOC',capturedAt:NOW,items:snapshots})})
 await data.query(actor,{scope:'SOC',limit:10})
 const definitions=new BusinessDefinitionSourceReader(market,loads,{activeSourceIds:async(db:PoolClient,ownerId:string,loadId:string)=>{
  const rows=(await db.query(`select binding->>'sourceId' source_id from teloa_industry_data_source_instances where owner_id=$1 and load_id=$2 and state='active'`,[ownerId,loadId])).rows as Array<{source_id:string}>
  return new Set(rows.map(row=>row.source_id))
 }})
 const ledger=await new BusinessLedgerService(pool,identity,definitions).read(actor,{scope:'SOC'})
 return {saved,load,ledger}
}

async function runFixture(directory:string){return runFiles(await walk(join(root,directory)),directory)}

/**
 * 模拟导出前对一张视图的真实修改：正文与资源清单都升到同一版。
 * 清单版本保持包版本；资源版本才是这张视图的 `viewVersion` 来源。
 */
function revisedViewPackage(files:FixtureFile[],version:string):FixtureFile[]{
 const decoder=new TextDecoder('utf-8',{fatal:true}),encoder=new TextEncoder()
 return files.map(file=>{
  if(file.path==='views/soc-risk-distribution.json'){
   const view=JSON.parse(decoder.decode(file.bytes)) as Record<string,unknown>
   view.title='风险分布（已更新）'
   view.version=version
   // 契约把标题的本地化原文钉在 localized.title.original 上：title 改了它必须跟着改，否则 teloa/invalid-input。
   const localized=view.localized as {title?:{original:string;locales:Record<string,string>}}|undefined
   if(localized?.title){
    localized.title.original=view.title as string
    localized.title.locales['zh-CN']=view.title as string
   }
   return {path:file.path,bytes:encoder.encode(JSON.stringify(view))}
  }
  if(file.path==='teloa.json'){
   const manifest=JSON.parse(decoder.decode(file.bytes)) as Record<string,unknown>
   const resources=manifest.resources as Array<Record<string,unknown>>
   const view=resources.find(resource=>resource.id==='soc-risk-distribution')
   assert.ok(view,'清单必须包含被更新的视图资源')
   view.title='风险分布（已更新）'
   view.version=version
   return {path:file.path,bytes:encoder.encode(JSON.stringify(manifest))}
  }
  return {path:file.path,bytes:Uint8Array.from(file.bytes)}
 })
}

function comparable(value:Awaited<ReturnType<typeof runFixture>>['ledger']){
 return {
  schema:value.schema,scope:value.scope,
  blocks:value.blocks.map(block=>{
   const {defaultAction:_defaultAction,...definition}=block.objectType.definition
   return {
   objectType:{definition},objects:block.objects,source:{sourceId:block.source.sourceId,connected:block.source.connected},
   coverage:block.coverage,missingFields:block.missingFields,
   views:block.views.map(view=>({title:view.title,kind:view.kind,chart:view.chart,measures:view.measures,rows:view.rows,coverage:view.coverage,missingFields:view.missingFields,objects:view.objects})).sort((a,b)=>a.title.localeCompare(b.title)),
  }}).sort((a,b)=>a.objectType.definition.id.localeCompare(b.objectType.definition.id)),
  // 生成包刻意不带工作模板，业务动作与 defaultAction 必须在生成时排除，不能让它阻断数据面台账。
  actions:[],
 }
}

test('生成 → 固定 → 加载 → 同快照台账与原 SOC 声明等价，且动作依赖被安全排除',async()=>{
 const original=await runFixture('业务定制层/SOC')
 const shared=await runFixture('业务定制层分享/SOC声明包')
 assert.notEqual(original.saved.content.hash,shared.saved.content.hash,'原模板含工作模板与执行工具，声明包是另一份固定内容')
 assert.notEqual(original.load.id,shared.load.id,'两份加载必须独立')
 assert.deepEqual(comparable(shared.ledger),comparable(original.ledger),'定义、视图、覆盖面、来源名词与同批快照计算结果逐字段相等')
 const alert=shared.ledger.blocks.find(block=>block.objectType.definition.id==='alert-ticket')
 assert.ok(alert)
 assert.equal(alert.source.sourceNoun,'告警源')
 assert.equal(alert.defaultAction,undefined,'接收方没有被重发的工作模板时不留下悬挂默认动作')
 assert.deepEqual(shared.ledger.actions,[],'声明包不带第三方工作模板时不携带无法闭合的动作')
})

test('同一份声明包重复固定并加载，内容摘要与声明摘要均稳定',async()=>{
 const first=await runFixture('业务定制层分享/SOC声明包')
 const second=await runFixture('业务定制层分享/SOC声明包')
 assert.equal(second.saved.content.hash,first.saved.content.hash,'确定性夹具重复固定不得漂移 contentHash')
 const hashes=(value:Awaited<ReturnType<typeof runFixture>>)=>value.ledger.blocks
  .map(block=>[block.objectType.definition.id,block.objectType.source.definitionHash] as const)
  .sort(([a],[b])=>a.localeCompare(b))
 assert.deepEqual(hashes(second),hashes(first),'加载身份不同不应改变同一份声明的 definitionHash')
})

test('导出包的内容与视图版本身份随声明变化，未改时稳定',async()=>{
 const files=await walk(join(root,'业务定制层分享/SOC声明包'))
 // 版本从夹具 body 读，不写死：夹具的视图声明版本一变，这里跟着变，不必猜一个巧合相等的常量。
 const view=files.find(file=>file.path==='views/soc-risk-distribution.json')!
 const originalVersion=(JSON.parse(new TextDecoder().decode(view.bytes)) as {version:string}).version
 const bumpedVersion=originalVersion.replace(/\d+$/,digits=>String(Number(digits)+1))
 const first=await runFiles(files,'SOC 声明包原版')
 const same=await runFiles(files,'SOC 声明包原版重发')
 const contentChanged=await runFiles(revisedViewPackage(files,originalVersion),'SOC 声明包视图正文更新')
 const versionChanged=await runFiles(revisedViewPackage(files,bumpedVersion),'SOC 声明包视图版本更新')
 const resultOf=(value:Awaited<ReturnType<typeof runFixture>>)=>{
  const block=value.ledger.blocks.find(candidate=>candidate.objectType.definition.id==='alert-ticket')
  assert.ok(block,'声明包必须产生告警对象类型台账')
  const view=block.views.find(candidate=>candidate.viewId==='soc-risk-distribution')
  assert.ok(view,'声明包必须产生风险分布视图')
  return {contentHash:value.saved.content.hash,viewVersion:view.viewVersion,definitionHash:view.definitionHash}
 }
 const before=resultOf(first),unchanged=resultOf(same),bodyAfter=resultOf(contentChanged),versionAfter=resultOf(versionChanged)
 assert.deepEqual(unchanged,before,'同一份导出字节再次固定，contentHash、viewVersion 与 definitionHash 必须保持不变')
 assert.notEqual(bodyAfter.contentHash,before.contentHash,'视图正文改变后，导出包 contentHash 必须改变')
 assert.equal(bodyAfter.viewVersion,before.viewVersion,'只改正文不伪造版本变化，viewVersion 必须保持声明原值')
 assert.notEqual(bodyAfter.definitionHash,before.definitionHash,'视图正文改变后，definitionHash 必须改变')
 assert.notEqual(versionAfter.contentHash,before.contentHash,'视图版本改变后，导出包 contentHash 必须改变')
 assert.equal(versionAfter.viewVersion,bumpedVersion,'视图资源版本必须逐字进入导出后计算结果')
 assert.notEqual(versionAfter.viewVersion,before.viewVersion,'视图资源版本改变后，viewVersion 必须改变')
 assert.notEqual(versionAfter.definitionHash,before.definitionHash,'视图版本改变后，definitionHash 必须改变')
})
