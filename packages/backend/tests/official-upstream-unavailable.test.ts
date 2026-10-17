import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {OfficialCatalogService} from '../src/market/official-catalog.ts'
import {listUpstreamEntries,getUpstreamEntry} from '../src/market/official-upstream.ts'
import type {MarketActor} from '../src/market/content-store.ts'

// 独立进程：上游索引从未加载（等同读取失败）。上游来源读不到必须报错，界面据此显示「来源暂时无法读取」，不能冒充「没有资源」。
const self:MarketActor={ownerId:'local:self',kind:'human'}
const store={findByCatalogSources:async()=>{throw Error('上游不可读时不得查询已添加状态')},findByIdentity:async()=>null} as unknown as ConstructorParameters<typeof OfficialCatalogService>[0]

const reviewed=JSON.parse(readFileSync(new URL('../../../tests/fixtures/reviewed-catalog-20261014.json',import.meta.url),'utf8')) as {hosted:{byKind:Record<string,string[]>};upstream:{byMarketplace:Record<string,string[]>}}
const upstreamId=reviewed.upstream.byMarketplace.cursor![0]!

test('上游索引不可读：来源列表与统一 Teloa 目录都报 source-unavailable，不返回空列表或半份目录',async()=>{
 assert.throws(()=>listUpstreamEntries(),{code:'teloa/source-unavailable'})
 const service=new OfficialCatalogService(store)
 for(const marketplace of ['cursor','claude-code','codex','dsh','openclaw','clawhub','hermes'] as const){
  await assert.rejects(service.list(self,{marketplace}),{code:'teloa/source-unavailable'},marketplace)
 }
 // 统一 Teloa 目录合并托管快照与上游：上游未加载时整份拒绝，不把托管部分当完整目录
 await assert.rejects(service.list(self,{marketplace:'teloa'}),{code:'teloa/source-unavailable'})
 // 不带 marketplace 的旧宿主契约只列托管快照，不依赖上游索引：精确等于已审托管集合
 const legacy=await service.list(self)
 assert.equal(legacy.nextCursor,null)
 assert.deepEqual(legacy.items.map(item=>item.entry.id).sort(),Object.values(reviewed.hosted.byKind).flat().sort())
})

test('上游索引不可读：按条目查询与密钥声明查询保持降级（查不到），不因上游故障连带失败',()=>{
 const service=new OfficialCatalogService(store)
 assert.equal(getUpstreamEntry(upstreamId),undefined)
 assert.equal(service.hasEntry(upstreamId),false)
 assert.deepEqual(service.getSkillSecretsByEntry(upstreamId),[])
})
