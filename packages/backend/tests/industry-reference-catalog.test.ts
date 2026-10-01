import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeMarketContents,MarketContentStore,type MarketFileInput} from '../src/market/content-store.ts'
import {createIndustryLoadSource} from '../src/work/industry-load-source.ts'
import {initializeIndustryLoads,IndustryLoadService} from '../src/work/industry-loads.ts'
import {IndustryReferenceCatalog,industryReferenceId} from '../src/capabilities/industry-reference-catalog.ts'
import {combineReferenceCatalogs} from '../src/capabilities/industry-reference-catalog.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {ResourceService} from '../src/capabilities/resources.ts'
import {createPublicReferenceCatalog} from '@teloa/mcp-reference/local'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()},bytes=(text:string)=>new TextEncoder().encode(text),file=(path:string,text:string):MarketFileInput=>({path,bytes:bytes(text)})
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeMarketContents(pool);await initializeIndustryLoads(pool);await initializeResources(pool)},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(db:Pool,owner:string,guide:Uint8Array=bytes('\ufeff# 固定指南\n')){
 const market=new MarketContentStore(db,identity),manifest={format:'teloa.business-package/v2',id:'knowledge-test',title:'资料行业',version:'1.0.0',domain:'research-industry',scope:'research',description:'资料来源验收',resources:[{id:'guide',kind:'knowledge',title:'核对指南',version:'1.0.0',required:true,source:{kind:'local',path:'knowledge/guide.md'}},{id:'optional',kind:'knowledge',title:'缺失资料',version:'1.0.0',required:false,source:{kind:'local',path:'knowledge/missing.md'}},{id:'role',kind:'role',title:'分析岗',version:'1.0.0',required:true,source:{kind:'local',path:'roles/role.json'}}],relations:[{kind:'role-knowledge',from:'role',to:'guide'}],entrypoints:[]}
 const imported=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'知识验收'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(manifest)),{path:'knowledge/guide.md',bytes:guide},file('roles/role.json','{}')],references:[]})
 const loads=new IndustryLoadService(db,identity,createIndustryLoadSource(market)),load=await loads.create(owner,{requestId:randomUUID(),contentId:imported.content.id,contentHash:imported.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'知识空间'}})
 return {market,loads,load,imported,sourceId:industryReferenceId(load.id,load.items.find(item=>item.localId==='guide')!.instanceId)}
}

test('只列出本人空间内已加载知识并按固定摘要读取原字节',async()=>{
 const owner=randomUUID(),{market,loads,load,sourceId}=await fixture(pool,owner),catalog=new IndustryReferenceCatalog(pool,market,loads),actor={ownerId:owner,kind:'human' as const,scopeIds:[load.space.scope]}
 const directory=await catalog.list({actor});assert.equal(directory.references.length,1);assert.equal(directory.references[0]!.id,sourceId);assert.equal(directory.references[0]!.title,'核对指南')
 const version=createHash('sha256').update(bytes('\ufeff# 固定指南\n')).digest('hex'),result=await catalog.read(sourceId,version,{actor,scopeIds:[load.space.scope]})
 assert.equal(result.text,'\ufeff# 固定指南\n');assert.equal(result.bytes,bytes('\ufeff# 固定指南\n').byteLength);assert.equal(result.version,version)
 await assert.rejects(catalog.read(sourceId,'0'.repeat(64),{actor,scopeIds:[load.space.scope]}),{code:'teloa/version-conflict'})
 await assert.rejects(catalog.read(sourceId,version,{actor:{...actor,ownerId:randomUUID()},scopeIds:[load.space.scope]}))
 await assert.rejects(catalog.read(sourceId,version,{actor,scopeIds:['general']}),{code:'teloa/forbidden'})
 const skipped=industryReferenceId(load.id,load.items.find(item=>item.localId==='optional')!.instanceId);await assert.rejects(catalog.read(skipped,version,{actor,scopeIds:[load.space.scope]}),{code:'teloa/source-unavailable'})
})

test('固定市场内容缺失或改动不能作为行业资料读取',async()=>{
 const owner=randomUUID(),{market,loads,load,imported,sourceId}=await fixture(pool,owner),catalog=new IndustryReferenceCatalog(pool,market,loads),actor={ownerId:owner,kind:'human' as const,scopeIds:[load.space.scope]},version=createHash('sha256').update(bytes('\ufeff# 固定指南\n')).digest('hex')
 await pool.query("update teloa_market_files set bytes=$2 where content_id=$1 and path='knowledge/guide.md'",[imported.content.id,Buffer.from('# 已改变')]);await assert.rejects(catalog.read(sourceId,version,{actor,scopeIds:[load.space.scope]}),{code:'teloa/storage-corrupt'});await pool.query("update teloa_market_files set bytes=$2 where content_id=$1 and path='knowledge/guide.md'",[imported.content.id,Buffer.from(bytes('\ufeff# 固定指南\n'))])
 await pool.query("delete from teloa_market_files where content_id=$1 and path='knowledge/guide.md'",[imported.content.id]);await assert.rejects(catalog.read(sourceId,version,{actor,scopeIds:[load.space.scope]}),{code:'teloa/storage-corrupt'})
})

test('有效导入中的超限或非法 UTF-8 知识不能进入来源目录',async()=>{
 for(const guide of [new Uint8Array(128*1024+1),new Uint8Array([0xc3,0x28])]){
  const owner=randomUUID(),{market,loads,load,sourceId}=await fixture(pool,owner,guide),catalog=new IndustryReferenceCatalog(pool,market,loads),actor={ownerId:owner,kind:'human' as const,scopeIds:[load.space.scope]},version=createHash('sha256').update(guide).digest('hex')
  await assert.rejects(catalog.read(sourceId,version,{actor,scopeIds:[load.space.scope]}),{code:'teloa/source-unavailable'})
 }
})

test('事务内读取复用单连接池，不再次借连接',async()=>{
 const single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:1000}),owner=randomUUID()
 try{const {market,loads,load,sourceId}=await fixture(single,owner),catalog=new IndustryReferenceCatalog(single,market,loads),actor={ownerId:owner,kind:'human' as const,scopeIds:[load.space.scope]},reference=(await catalog.list({actor})).references[0]!,client=await single.connect();try{await client.query('begin');const result=await catalog.read(sourceId,reference.version,{actor,scopeIds:[load.space.scope],client});assert.equal(result.id,sourceId);await client.query('rollback')}finally{client.release()}}finally{await single.end()}
})

test('无行业范围不访问行业表，无权坏记录不阻断公共目录',async()=>{
 const owner=randomUUID(),{market,loads,load}=await fixture(pool,owner),catalog=new IndustryReferenceCatalog(pool,market,loads),notes=load.items.find(item=>item.localId==='guide')!
 await pool.query('update teloa_industry_load_items set instance_id=$2 where load_id=$1 and local_id=$3',[load.id,randomUUID(),notes.localId])
 assert.deepEqual(await catalog.list({actor:{ownerId:owner,kind:'human',scopeIds:['general']}}),{schema:'teloa.reference-list/v1',references:[]})
 await assert.rejects(catalog.list({actor:{ownerId:owner,kind:'human',scopeIds:[load.space.scope]}}),{code:'teloa/storage-corrupt'})
})

test('单连接 ResourceService 真实创建、应用、执行与消息读取共用行业来源',async()=>{
 const single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:1500}),owner=randomUUID()
 try{
  const {market,loads,load,sourceId}=await fixture(single,owner),industry=new IndustryReferenceCatalog(single,market,loads),catalog=combineReferenceCatalogs(createPublicReferenceCatalog(),industry),service=new ResourceService(single,catalog,identity),actor={ownerId:owner,kind:'human' as const,scopeIds:['general',load.space.scope]}
  const reference=(await service.sourceDirectory(actor)).find(item=>item.id===sourceId)!;assert.ok(reference)
  const draft=await service.create(actor,{requestId:randomUUID(),title:'行业核对指南',sourceId,sourceVersion:reference.version,scopeIds:[load.space.scope]})
  const resource=await service.apply(actor,{draftId:draft.id,expectedVersion:draft.version})
  const execution=await service.executionKnowledge(actor,[load.space.scope],[resource.id]);assert.equal(execution[0]!.text,'\ufeff# 固定指南\n')
  const message=await service.resolve(actor,{sessionId:'industry-session',scopeIds:[load.space.scope]},{messageId:'industry-message',references:[{id:resource.id,version:resource.version}]});assert.equal(message.contents[0]!.id,resource.id)
  const activeBefore=(await single.query("select count(*)::int count from teloa_resources where owner_id=$1 and status='active'",[owner])).rows[0].count
  const wrong=await service.create(actor,{requestId:randomUUID(),title:'错误范围',sourceId,sourceVersion:reference.version,scopeIds:['general']});await assert.rejects(service.apply(actor,{draftId:wrong.id,expectedVersion:wrong.version}),{code:'teloa/forbidden'});assert.equal((await single.query("select count(*)::int count from teloa_resources where owner_id=$1 and status='active'",[owner])).rows[0].count,activeBefore)
  const withdrawn=await service.withdraw(actor,{resourceId:resource.id,expectedVersion:resource.version});assert.equal(withdrawn.status,'withdrawn');await assert.rejects(service.executionKnowledge(actor,[load.space.scope],[resource.id]),{code:'teloa/resource-withdrawn'})
 }finally{await single.end()}
})
