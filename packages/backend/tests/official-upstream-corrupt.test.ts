import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {registerHooks} from 'node:module'
import type {MarketActor} from '../src/market/content-store.ts'

// 独立进程：上游索引已加载但完整性校验失败（随发行打包的摘要与索引字节不符）。与「从未加载」同样必须报错，不能冒充「没有资源」。
registerHooks({load:(url,context,next)=>url.endsWith('/official-upstream-index-sha256.ts')
 ?{format:'module',source:`export const officialUpstreamIndexSha256='${'0'.repeat(64)}'`,shortCircuit:true}
 :next(url,context)})
const {OfficialCatalogService}=await import('../src/market/official-catalog.ts')
const {listUpstreamEntries,getUpstreamEntry,loadOfficialUpstreamIndex}=await import('../src/market/official-upstream.ts')

const self:MarketActor={ownerId:'local:self',kind:'human'}
const store={findByCatalogSources:async()=>{throw Error('上游损坏时不得查询已添加状态')},findByIdentity:async()=>null} as unknown as ConstructorParameters<typeof OfficialCatalogService>[0]

const reviewed=JSON.parse(readFileSync(new URL('../../../tests/fixtures/reviewed-catalog-20261014.json',import.meta.url),'utf8')) as {hosted:{byKind:Record<string,string[]>};upstream:{byMarketplace:Record<string,string[]>}}
const upstreamId=reviewed.upstream.byMarketplace.cursor![0]!

test('上游索引已加载但损坏：来源列表与统一 Teloa 目录都报 storage-corrupt；按条目查询降级为查不到；旧宿主托管列表照常可读',async()=>{
 await loadOfficialUpstreamIndex()
 assert.throws(()=>listUpstreamEntries(),{code:'teloa/storage-corrupt'})
 const service=new OfficialCatalogService(store)
 // 协议仍接受的每个来源筛选都必须报错，不能冒充空来源
 for(const marketplace of ['cursor','claude-code','codex','dsh','openclaw','clawhub','hermes'] as const){
  await assert.rejects(service.list(self,{marketplace}),{code:'teloa/storage-corrupt'},marketplace)
 }
 // 统一 Teloa 目录合并托管快照与上游：缺了上游就不是完整目录，整份拒绝，不回一半
 await assert.rejects(service.list(self,{marketplace:'teloa'}),{code:'teloa/storage-corrupt'})
 assert.equal(getUpstreamEntry(upstreamId),undefined)
 assert.equal(service.hasEntry(upstreamId),false)
 assert.deepEqual(service.getSkillSecretsByEntry(upstreamId),[])
 // 不带 marketplace 的旧宿主契约只列托管快照，不依赖上游索引：精确等于已审托管集合
 const legacy=await service.list(self)
 assert.equal(legacy.nextCursor,null)
 assert.deepEqual(legacy.items.map(item=>item.entry.id).sort(),Object.values(reviewed.hosted.byKind).flat().sort())
})
