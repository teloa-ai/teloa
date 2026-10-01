import test from 'node:test'
import assert from 'node:assert/strict'
import {OfficialCatalogService} from '../src/market/official-catalog.ts'
import {listUpstreamEntries,getUpstreamEntry} from '../src/market/official-upstream.ts'
import type {MarketActor} from '../src/market/content-store.ts'

// 独立进程：上游索引从未加载（等同读取失败）。上游来源读不到必须报错，界面据此显示「来源暂时无法读取」，不能冒充「没有资源」。
const self:MarketActor={ownerId:'local:self',kind:'human'}
const store={findByCatalogSources:async()=>{throw Error('上游不可读时不得查询已添加状态')},findByIdentity:async()=>null} as unknown as ConstructorParameters<typeof OfficialCatalogService>[0]

test('上游索引不可读：来源列表报 source-unavailable，不返回空列表',async()=>{
 assert.throws(()=>listUpstreamEntries(),{code:'teloa/source-unavailable'})
 const service=new OfficialCatalogService(store)
 for(const marketplace of ['clawhub','codex','openclaw','hermes','dsh','claude-code'] as const){
  await assert.rejects(service.list(self,{marketplace}),{code:'teloa/source-unavailable'},marketplace)
 }
 // Teloa 官方目录不依赖上游索引，照常可读
 assert.ok((await service.list(self,{marketplace:'teloa'})).items.length>0)
})

test('上游索引不可读：按条目查询与密钥声明查询保持降级（查不到），不因上游故障连带失败',()=>{
 const service=new OfficialCatalogService(store)
 assert.equal(getUpstreamEntry('clawhub.jaaneek.x-search'),undefined)
 assert.equal(service.hasEntry('clawhub.jaaneek.x-search'),false)
 assert.deepEqual(service.getSkillSecretsByEntry('clawhub.jaaneek.x-search'),[])
})
