import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {readFileSync} from 'node:fs'
import type {Pool} from 'pg'
import {readMarketCatalogEntry,type MarketCatalogUpstreamSkillEntry} from '@teloa/contract'
import {MarketContentStore,marketTrustHash,normalizeMarketSourceTrust,type MarketActor} from '../src/market/content-store.ts'
import {OfficialCatalogService,officialCatalogTrust} from '../src/market/official-catalog.ts'
import {adoptRemoteUpstreamEntries} from '../src/market/official-upstream.ts'

const raw=JSON.parse(readFileSync(new URL('../../../tests/fixtures/public-market/catalog/skills/clawhub.jaaneek.x-search.json',import.meta.url),'utf8'))
const entry=():MarketCatalogUpstreamSkillEntry=>readMarketCatalogEntry(raw) as MarketCatalogUpstreamSkillEntry
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const tree=(e:MarketCatalogUpstreamSkillEntry)=>hash(JSON.stringify(e.upstream.files.map(f=>[f.path,f.sha256]).sort()))
const self:MarketActor={ownerId:'local:self',kind:'human'},other:MarketActor={ownerId:'local:other',kind:'human'}
type Stored=ReturnType<typeof stored>
function stored(e=entry(),ownerId=self.ownerId){
 const trust=officialCatalogTrust(e),source={kind:'catalog',catalog:'teloa-official',catalogVersion:'older-release',entryId:e.id,entryVersion:e.version,treeHash:tree(e)}
 const content={id:randomUUID(),owner_id:ownerId,kind:'atomic-skill',logical_id:e.skill.name,version:e.version,content_hash:'a'.repeat(64),base_hash:'a'.repeat(64),manifest_path:e.skill.name+'/SKILL.md',metadata:{id:e.skill.name,title:'固定标题',version:e.version,categories:[]},trust,trust_hash:marketTrustHash(trust),refs:[]}
 const request_spec={kind:content.kind,source,logicalId:content.logical_id,version:content.version,hash:content.content_hash,baseHash:content.base_hash,manifestPath:content.manifest_path,metadata:content.metadata,trustHash:content.trust_hash,references:[]}
 return {...content,import_owner_id:ownerId,source,request_spec}
}
function fixture(rows:Stored[],failure?:'connect'|'query'){
 const calls:{sql:string;values:unknown[]}[]=[];let released=0
 const pool={connect:async()=>{
  if(failure==='connect')throw Error('synthetic unavailable')
  return {query:async(sql:string,values:unknown[])=>{
   calls.push({sql,values});if(failure==='query')throw Error('synthetic query failure')
   // 只模拟 SQL 的候选集，不模拟写入或文件读取；真实 PostgreSQL 执行留给主控。
   const sources=JSON.parse(values[1] as string) as Record<string,unknown>[]
   return {rows:rows.filter(row=>row.import_owner_id===values[0]&&sources.some(source=>Object.entries(source).every(([key,value])=>row.source[key as keyof typeof row.source]===value)))}
  },release(){released++}}
 }} as unknown as Pool
 return {store:new MarketContentStore(pool,{id:randomUUID,now:()=>new Date().toISOString()}),calls,released:()=>released}
}

test('上游已添加状态来自本人固定导入回执，跨发行版本仍识别；列表不下载或读文件',async t=>{
 const e=entry(),row=stored(e),f=fixture([row]);adoptRemoteUpstreamEntries([e])
 t.mock.method(globalThis,'fetch',async()=>{throw Error('列表不得下载')})
 const result=await new OfficialCatalogService(f.store).list(self,{marketplace:'clawhub'})
 assert.equal(result.items[0]!.addedContentId,row.id)
 assert.equal(result.items[0]!.artifact,null);assert.equal(f.calls.length,1);assert.equal(f.released(),1)
 assert.match(f.calls[0]!.sql,/teloa_market_imports/);assert.match(f.calls[0]!.sql,/teloa_market_contents/)
 assert.doesNotMatch(f.calls[0]!.sql,/teloa_market_files|for (?:share|update)/i)
 assert.equal((await new OfficialCatalogService(f.store).list(other,{marketplace:'clawhub'})).items[0]!.addedContentId,null)
})

test('上游未添加、仅同名内容、固定版本或文件树变化均不冒充已添加',async()=>{
 const e=entry(),row=stored(e),f=fixture([row]),service=new OfficialCatalogService(f.store)
 for(const changed of [
  {...e,id:'clawhub.other.x-search'},
  {...e,version:'1.0.1',upstream:{...e.upstream,version:'1.0.1'}},
  {...e,upstream:{...e.upstream,files:e.upstream.files.map(file=>({...file,sha256:'b'.repeat(64)}))}},
 ] as MarketCatalogUpstreamSkillEntry[]){
  adoptRemoteUpstreamEntries([changed])
  assert.equal((await service.list(self,{marketplace:'clawhub'})).items[0]!.addedContentId,null)
 }
 adoptRemoteUpstreamEntries([e])
 assert.equal((await new OfficialCatalogService(fixture([]).store).list(self,{marketplace:'clawhub'})).items[0]!.addedContentId,null)
})

test('上游按当前页批量查状态，不因同一内容较新的其他来源回执丢失原绑定',async()=>{
 const e=entry(),a=stored(e),b={...stored(e),id:a.id,source:{...a.source,entryId:'clawhub.other.x-search'}},f=fixture([b,a])
 b.request_spec={...b.request_spec,source:b.source}
 adoptRemoteUpstreamEntries([e,{...e,id:b.source.entryId}])
 const result=await new OfficialCatalogService(f.store).list(self,{marketplace:'clawhub',limit:1,sort:'name'})
 assert.equal(result.items[0]!.entry.id,e.id);assert.equal(result.items[0]!.addedContentId,a.id)
 assert.equal(f.calls.length,1);assert.equal((JSON.parse(f.calls[0]!.values[1] as string) as unknown[]).length,1)
 // 两条来源可指向同一内容；查询必须按每条回执匹配，不能只取 content 最新来源。
 const lookup=(source:Stored['source'])=>({entryId:source.entryId,entryVersion:source.entryVersion,treeHash:source.treeHash,logicalId:a.logical_id,trustHash:a.trust_hash})
 const ids=await f.store.findByCatalogSources(self,[lookup(a.source),lookup(b.source)])
 assert.equal(ids.get(a.source.entryId),a.id);assert.equal(ids.get(b.source.entryId),a.id)
})

for(const failure of ['connect','query'] as const)test('上游状态'+failure+'失败明确报错，不返回未添加',async()=>{
 adoptRemoteUpstreamEntries([entry()]);const f=fixture([],failure)
 await assert.rejects(new OfficialCatalogService(f.store).list(self,{marketplace:'clawhub'}),{code:'teloa/dependency-unavailable'})
 assert.equal(f.released(),failure==='query'?1:0)
})

test('回执与内容归属或固定快照不一致时拒绝，当前信任声明已变化则不匹配',async()=>{
 const e=entry();adoptRemoteUpstreamEntries([e])
 for(const change of [(r:Stored)=>{r.owner_id=other.ownerId},(r:Stored)=>{r.request_spec.hash='b'.repeat(64)},(r:Stored)=>{r.trust_hash='c'.repeat(64)}]){
  const row=stored(e);change(row)
  await assert.rejects(new OfficialCatalogService(fixture([row]).store).list(self,{marketplace:'clawhub'}),{code:'teloa/storage-corrupt'})
 }
 const row=stored(e);row.trust={...row.trust,publisher:'以前的发布者'};row.trust_hash=marketTrustHash(row.trust);row.request_spec.trustHash=row.trust_hash
 assert.equal((await new OfficialCatalogService(fixture([row]).store).list(self,{marketplace:'clawhub'})).items[0]!.addedContentId,null)
})

test('旧版默认信任回执可读取，但不能冒充当前目录信任；缺失其他字段仍拒绝',async()=>{
 const e=entry(),row=stored(e);adoptRemoteUpstreamEntries([e])
 row.trust=normalizeMarketSourceTrust(undefined);row.trust_hash=marketTrustHash(row.trust)
 Reflect.deleteProperty(row.request_spec,'trustHash')
 const f=fixture([row]),lookup={entryId:e.id,entryVersion:e.version,treeHash:tree(e),logicalId:e.skill.name,trustHash:row.trust_hash}
 assert.equal((await f.store.findByCatalogSources(self,[lookup])).get(e.id),row.id)
 assert.equal((await new OfficialCatalogService(f.store).list(self,{marketplace:'clawhub'})).items[0]!.addedContentId,null)
 Reflect.deleteProperty(row.request_spec,'hash')
 await assert.rejects(f.store.findByCatalogSources(self,[lookup]),{code:'teloa/storage-corrupt'})
 const current=stored(e);Reflect.deleteProperty(current.request_spec,'trustHash')
 await assert.rejects(new OfficialCatalogService(fixture([current]).store).list(self,{marketplace:'clawhub'}),{code:'teloa/storage-corrupt'})
})

test('信任摘要：二次开发条目写「二次开发自 {author}，修改清单 {n} 项」；旧式与原版条目摘要不变',async()=>{
 const {catalogEntry,derivativeEntry}=await import('../../client/ui-workbench/tests/market-catalog-fixture.ts')
 const derived=officialCatalogTrust(readMarketCatalogEntry(derivativeEntry()))
 assert.equal(derived.review.summary,'Teloa 官方目录收录（资源 anthropic.internal-comms-plus@1.1.0）；二次开发自 Anthropic，修改清单 5 项；许可 Apache-2.0；兼容状态 content-only')
 assert.equal(derived.publisher,'Teloa 官方目录');assert.deepEqual(derived.repository,{host:'github.com',owner:'anthropics',repo:'skills'})
 assert.equal(officialCatalogTrust(readMarketCatalogEntry(catalogEntry())).review.summary,'Teloa 官方目录收录（资源 anthropic.internal-comms@1.0.0）；上游 Anthropic，许可 Apache-2.0；兼容状态 content-only')
 assert.equal(officialCatalogTrust(entry()).review.summary,`从 ClawHub ${raw.upstream.owner}/${raw.upstream.slug} 机器固定收录（${raw.id}@${raw.version}）；来源 clawhub，许可 ${raw.license.spdx}；Teloa 官方目录脚本核验摘要，未逐行审核。`)
})
