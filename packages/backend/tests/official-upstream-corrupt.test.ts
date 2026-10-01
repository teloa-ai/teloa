import test from 'node:test'
import assert from 'node:assert/strict'
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

test('上游索引已加载但损坏：来源列表报 storage-corrupt；按条目查询降级为查不到；Teloa 目录照常可读',async()=>{
 await loadOfficialUpstreamIndex()
 assert.throws(()=>listUpstreamEntries(),{code:'teloa/storage-corrupt'})
 const service=new OfficialCatalogService(store)
 for(const marketplace of ['clawhub','codex','openclaw','hermes','dsh','claude-code'] as const){
  await assert.rejects(service.list(self,{marketplace}),{code:'teloa/storage-corrupt'},marketplace)
 }
 assert.equal(getUpstreamEntry('clawhub.jaaneek.x-search'),undefined)
 assert.equal(service.hasEntry('clawhub.jaaneek.x-search'),false)
 assert.deepEqual(service.getSkillSecretsByEntry('clawhub.jaaneek.x-search'),[])
 assert.ok((await service.list(self,{marketplace:'teloa'})).items.length>0)
})
