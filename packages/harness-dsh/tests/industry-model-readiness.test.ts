import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import type {MarketCatalogModelEntry} from '@teloa/contract'
import {createIndustryModelProbe} from '../src/industry-model-readiness.ts'

const entry=JSON.parse(readFileSync(new URL('../../../tests/fixtures/public-market/catalog/models/teloa.model.sensevoice.json',import.meta.url),'utf8')) as MarketCatalogModelEntry
const dependency={catalogId:entry.id,version:entry.version,usage:'speech-to-text' as const,required:true}
const snapshot=(phase:string)=>({providers:[{id:'sensevoice-local',location:'host-local',preparation:{phase}}]})
test('读取真实目录绑定和原生状态，不触发下载或选择默认模型',async()=>{
 let reads=0
 for(const phase of ['unprepared','downloading','ready','standby','failed']){
  const probe=createIndustryModelProbe(id=>id===entry.id?entry:undefined,()=>{reads++;return snapshot(phase)})
  assert.equal(await probe(dependency),phase)
  assert.equal(await probe({...dependency,version:'99.0.0'}),'unsupported')
  assert.equal(await probe({...dependency,usage:'ocr'}),'unsupported')
 }
 assert.equal(reads,5)
})
test('停用、缺失、损坏和远程 provider 不伪装本地就绪',async()=>{
 const cases:[unknown,string][]=[[undefined,'disabled'],[{},'unavailable'],[{providers:[]},'disabled'],[snapshot('invented'),'unavailable'],[{providers:[{id:'sensevoice-local',location:'remote',preparation:{phase:'ready'}}]},'unavailable']]
 for(const [value,phase] of cases)assert.equal(await createIndustryModelProbe(()=>entry,()=>value)(dependency),phase)
 assert.equal(await createIndustryModelProbe(()=>entry,()=>{throw Error('服务停用')})(dependency),'unavailable')
 assert.equal(await createIndustryModelProbe(()=>undefined,()=>{throw Error('不可调用')})(dependency),'unsupported')
})

// —— 端侧中文检索（规格 §7.2）：usage:"embedding" 走 teloaEmbedding.snapshot()，语音分支不变 ——
const embeddingEntry={...entry,id:'teloa.model.qwen3-embedding-0-6b',model:{...entry.model,modelId:'qwen3-embedding-0-6b',usage:['embedding'],native:{kind:'teloa-embedding',providerId:'qwen3-embedding-0.6b'}}} as unknown as MarketCatalogModelEntry
const embeddingDependency={catalogId:embeddingEntry.id,version:embeddingEntry.version,usage:'embedding' as const,required:true}
const embeddingSnapshot=(preparation:Record<string,unknown>)=>({providers:[{id:'qwen3-embedding-0.6b',location:'host-local',catalogId:embeddingEntry.id,catalogVersion:embeddingEntry.version,profileHash:'a'.repeat(64),variant:'fp32',totalMemoryBytes:16*1024**3,memoryRisk:false,preparation}]})
const entries=(id:string)=>id===entry.id?entry:id===embeddingEntry.id?embeddingEntry:undefined

test('embedding 依赖读 teloaEmbedding 快照：各阶段按原值投影，downloading 两段都投影为 downloading；语音快照不被误用',async()=>{
 let speechReads=0,embeddingReads=0
 for(const preparation of [{phase:'unprepared'},{phase:'downloading',stage:'runtime',resource:'onnxruntime-node@1.30.0',completedBytes:0},{phase:'downloading',stage:'assets',resource:'onnx/model.onnx',completedBytes:12,totalBytes:24},{phase:'loading',startedAt:1},{phase:'ready'},{phase:'standby'},{phase:'cancelling',startedAt:1},{phase:'cancelled'},{phase:'failed',message:'x'}]){
  const probe=createIndustryModelProbe(entries,()=>{speechReads++;return snapshot('ready')},()=>{embeddingReads++;return embeddingSnapshot(preparation)})
  assert.equal(await probe(embeddingDependency),preparation.phase)
  assert.equal(await probe(dependency),'ready','语音分支不变')
 }
 assert.equal(speechReads,9);assert.equal(embeddingReads,9)
 // 用途与绑定错配：语音条目声明 embedding、检索条目声明 speech-to-text 都是 unsupported，且不读任何快照。
 const strict=createIndustryModelProbe(entries,()=>{throw Error('不应读取')},()=>{throw Error('不应读取')})
 assert.equal(await strict({...dependency,usage:'embedding'}),'unsupported')
 assert.equal(await strict({...embeddingDependency,usage:'speech-to-text'}),'unsupported')
 assert.equal(await strict({...embeddingDependency,version:'99.0.0'}),'unsupported')
})
test('embedding：服务缺失或 provider 缺失为 disabled；抛错、形状不符、非 host-local 为 unavailable',async()=>{
 const cases:[unknown,string][]=[[undefined,'disabled'],[{providers:[]},'disabled'],[{providers:[{id:'other',location:'host-local',preparation:{phase:'ready'}}]},'disabled'],[{},'unavailable'],[{providers:[{id:'qwen3-embedding-0.6b',location:'remote',preparation:{phase:'ready'}}]},'unavailable'],[embeddingSnapshot({phase:'invented'}),'unavailable']]
 for(const [value,phase] of cases)assert.equal(await createIndustryModelProbe(entries,()=>snapshot('ready'),()=>value)(embeddingDependency),phase,JSON.stringify(value))
 assert.equal(await createIndustryModelProbe(entries,()=>snapshot('ready'),()=>{throw Error('扩展停用中')})(embeddingDependency),'unavailable')
 // 旧调用方不传第三个读口：embedding 依赖一律 disabled，不影响语音。
 const legacy=createIndustryModelProbe(entries,()=>snapshot('standby'))
 assert.equal(await legacy(embeddingDependency),'disabled');assert.equal(await legacy(dependency),'standby')
})
test('宿主探针经 ctx.reflect 发现插件作用域内提供的 teloaEmbedding；插件停用后回 disabled',async()=>{
 const {Context}=await import('@deepseek-ai/cordis')
 const {createHostIndustryModelProbe}=await import('../src/industry-model-readiness.ts')
 const ctx=new Context()
 const probe=createHostIndustryModelProbe(ctx,entries)
 assert.equal(await probe(embeddingDependency),'disabled')
 assert.equal(await probe(dependency),'disabled')
 let reads=0
 const fiber=ctx.plugin({name:'stub-local-embedding',apply(scope:InstanceType<typeof Context>){scope.provide('teloaEmbedding',{snapshot:()=>{reads++;return embeddingSnapshot({phase:'standby'})}})}})
 await fiber
 assert.equal(await probe(embeddingDependency),'standby')
 assert.equal(reads,1)
 assert.equal(await probe(dependency),'disabled','语音服务仍缺失')
 await fiber.dispose()
 assert.equal(await probe(embeddingDependency),'disabled')
 assert.equal(reads,1,'停用后不再调用旧服务')
})
