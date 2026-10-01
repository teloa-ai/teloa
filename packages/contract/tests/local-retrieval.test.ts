import test from 'node:test'
import assert from 'node:assert/strict'
import {retrievalEndpoints,retrievalLimits,embeddingPreparationPhases,readEmbeddingPreparationState,readRetrievalSearchResult} from '../src/local-retrieval.ts'

const rejects=(fn:()=>unknown,message?:RegExp)=>assert.throws(fn,(error:any)=>error?.code==='teloa/invalid-input'&&(message===undefined||message.test(error.message)))

test('端点与上限是编译期常量',()=>{
 assert.deepEqual(retrievalEndpoints,['retrieval/status','retrieval/enroll','retrieval/remove','retrieval/reindex','retrieval/cancel','retrieval-model/status','retrieval-model/prepare','retrieval-model/cancel'])
 assert.deepEqual(retrievalLimits,{maxEnrollments:500,maxSourceBytes:2*1024*1024,maxChunks:50000,maxQueryChars:500,maxResults:8,maxExcerptBytes:2048,maxTotalExcerptBytes:16384,dimensions:1024,vectorBytes:4096})
 assert.equal(retrievalLimits.vectorBytes,retrievalLimits.dimensions*4)
})

test('准备状态：downloading 必带 stage，其他阶段不得带',()=>{
 assert.deepEqual(embeddingPreparationPhases,['unprepared','checking','downloading','loading','ready','standby','cancelling','cancelled','failed'])
 for(const phase of ['unprepared','ready','standby','cancelled'] as const)assert.deepEqual(readEmbeddingPreparationState({phase}),{phase})
 for(const phase of ['checking','loading','cancelling'] as const)assert.deepEqual(readEmbeddingPreparationState({phase,startedAt:1700000000000}),{phase,startedAt:1700000000000})
 const downloading={phase:'downloading',stage:'runtime',resource:'onnxruntime-node@1.30.0',completedBytes:1024,totalBytes:4096}
 assert.deepEqual(readEmbeddingPreparationState(downloading),downloading)
 assert.deepEqual(readEmbeddingPreparationState({...downloading,stage:'assets',resource:'onnx/model.onnx',totalBytes:undefined}),{phase:'downloading',stage:'assets',resource:'onnx/model.onnx',completedBytes:1024})
 const failed={phase:'failed',message:'下载中断。',download:{resource:'onnx/model.onnx_data',source:'huggingface.co',reason:'integrity'}}
 assert.deepEqual(readEmbeddingPreparationState(failed),failed)
 assert.deepEqual(readEmbeddingPreparationState({phase:'failed',message:'运行时安装失败。'}),{phase:'failed',message:'运行时安装失败。'})
 for(const bad of [
  {...downloading,stage:undefined},
  {...downloading,stage:'model'},
  {...downloading,completedBytes:-1},
  {...downloading,completedBytes:8192},
  {...downloading,resource:''},
  {...downloading,resource:'https://us.aws.cdn.hf.co/x?Signature=1'},
  {...downloading,resource:'a?b=1'},
  {...downloading,resource:'/onnx/model.onnx'},
  {...downloading,resource:'onnx//model.onnx'},
  {...downloading,resource:'../model.onnx'},
  {phase:'failed',message:'x',download:{resource:'https://huggingface.co/x/resolve/y/onnx/model.onnx?token=1',source:'huggingface.co',reason:'http'}},
  {...downloading,extra:1},
  {phase:'ready',stage:'assets'},
  {phase:'checking',startedAt:1700000000000,stage:'runtime'},
  {phase:'failed',message:'x',stage:'assets'},
  {phase:'checking'},
  {phase:'waking',startedAt:1},
  {phase:'unsupported'},
  {phase:'failed',message:''},
  {phase:'failed',message:'x',download:{resource:'a',source:'b',reason:'other'}},
  {phase:'failed',message:'x',download:{resource:'a',source:'https://huggingface.co/x?token=1',reason:'http'}},
  null,'ready',
 ])rejects(()=>readEmbeddingPreparationState(bad),/本地检索模型状态/)
})

const rid=(n:number)=>`0000000${n}-0000-4000-8000-000000000000`
const sha=(c:string)=>c.repeat(64)
const hit=()=>({resourceId:rid(1),resourceVersion:3,title:'差旅报销制度',sourceId:'knowledge_abc',sourceVersion:sha('a'),lines:[12,19],chars:[380,702],heading:'二、报销流程',score:0.71,excerpt:'报销单须在出差结束后 30 日内提交。'})
const result=()=>({coverage:{searched:[{resourceId:rid(1),title:'差旅报销制度',version:3},{resourceId:rid(2),title:'产品手册',version:1}],pending:[{resourceId:rid(3),title:'会议纪要',reason:'building'}],note:'仅检索已加入本地检索且当前会话有权读取的资料，不是全部资料。'},results:[hit()]})

test('检索结果守卫：严格键集、区间、分值、摘录上限与覆盖说明',()=>{
 assert.deepEqual(readRetrievalSearchResult(result()),result())
 const empty={coverage:{searched:[],pending:[],note:'仅检索已加入本地检索的资料。'},results:[]}
 assert.deepEqual(readRetrievalSearchResult(empty),empty)
 assert.deepEqual(readRetrievalSearchResult({...result(),results:[{...hit(),heading:null,score:-1,lines:[0,0],chars:[0,1]}]}).results[0]?.heading,null)
 for(const reason of ['stale','building','failed'])assert.equal(readRetrievalSearchResult({...result(),coverage:{...result().coverage,pending:[{resourceId:rid(3),title:'x',reason}]}}).coverage.pending[0]?.reason,reason)
 const withHit=(change:(h:any)=>void)=>{const r=result();change(r.results[0]);return r}
 const withCoverage=(change:(c:any)=>void)=>{const r=result();change(r.coverage);return r}
 for(const bad of [
  withHit(h=>{h.extra=1}),withHit(h=>{delete h.heading}),withHit(h=>{delete h.sourceVersion}),
  withHit(h=>{h.lines=[19,12]}),withHit(h=>{h.lines=[-1,3]}),withHit(h=>{h.lines=[1.5,3]}),withHit(h=>{h.lines=[1]}),withHit(h=>{h.lines='12-19'}),
  withHit(h=>{h.chars=[702,380]}),withHit(h=>{h.chars=[380,380]}),withHit(h=>{h.chars=[0,Number.MAX_SAFE_INTEGER+2]}),
  withHit(h=>{h.score=1.01}),withHit(h=>{h.score=-1.01}),withHit(h=>{h.score=Number.NaN}),withHit(h=>{h.score='0.7'}),
  withHit(h=>{h.excerpt=''}),withHit(h=>{h.excerpt='中'.repeat(683)}),
  withHit(h=>{h.resourceId='not-a-uuid'}),withHit(h=>{h.resourceVersion=0}),withHit(h=>{h.sourceVersion='sha256:abc'}),withHit(h=>{h.sourceId='has space'}),withHit(h=>{h.title=''}),withHit(h=>{h.heading=''}),
  withHit(h=>{h.resourceId=rid(9)}),withHit(h=>{h.resourceVersion=2}),
  withCoverage(c=>{delete c.note}),withCoverage(c=>{c.note=''}),withCoverage(c=>{c.note=1}),withCoverage(c=>{c.extra=[]}),
  withCoverage(c=>{c.pending[0].reason='queued'}),withCoverage(c=>{c.pending[0].reason='ready'}),withCoverage(c=>{c.pending.push({resourceId:rid(3),title:'重复',reason:'stale'})}),
  withCoverage(c=>{c.searched.push({resourceId:rid(1),title:'重复',version:3})}),withCoverage(c=>{c.searched[0].version=0}),withCoverage(c=>{c.searched[0].extra=1}),
  {...result(),results:Array.from({length:9},hit)},
  {...result(),extra:1},{coverage:result().coverage},null,[],'x',
 ])rejects(()=>readRetrievalSearchResult(bad),/检索结果/)
})

test('摘录上限按 UTF-8 字节计，8 条满额恰好等于 16 KiB 总上限',()=>{
 const okExcerpt='中'.repeat(682)
 assert.equal(new TextEncoder().encode(okExcerpt).byteLength,2046)
 assert.equal(readRetrievalSearchResult({...result(),results:[{...hit(),excerpt:okExcerpt}]}).results[0]?.excerpt,okExcerpt)
 const full=Array.from({length:8},()=>({...hit(),excerpt:'a'.repeat(retrievalLimits.maxExcerptBytes)}))
 assert.equal(full.reduce((sum,row)=>sum+row.excerpt.length,0),retrievalLimits.maxTotalExcerptBytes)
 assert.equal(readRetrievalSearchResult({...result(),results:full}).results.length,8)
 rejects(()=>readRetrievalSearchResult({...result(),results:[{...hit(),excerpt:'a'.repeat(retrievalLimits.maxExcerptBytes+1)}]}),/检索结果/)
})

test('内存风险：物理内存 ≤ 8 GiB 且变体为 fp32 才提示；默认变体为 fp32',async()=>{
 const {embeddingMemoryRisk,embeddingDefaultVariant,embeddingLowMemoryBytes}=await import('../src/local-retrieval.ts')
 assert.equal(embeddingDefaultVariant,'fp32')
 assert.equal(embeddingLowMemoryBytes,8*1024**3)
 assert.equal(embeddingMemoryRisk({totalMemoryBytes:8*1024**3,variant:'fp32'}),true)
 assert.equal(embeddingMemoryRisk({totalMemoryBytes:4*1024**3,variant:'fp32'}),true)
 assert.equal(embeddingMemoryRisk({totalMemoryBytes:8*1024**3+1,variant:'fp32'}),false)
 assert.equal(embeddingMemoryRisk({totalMemoryBytes:8*1024**3,variant:'int8'}),false)
})

test('prepare 载荷可选下载来源 source：缺省即官方且载荷原样；只收 official 与已确认来源表里的镜像；未知值、空值与多余键拒绝',async()=>{
 const {embeddingDownloadSources,captureRetrievalPreparation,readRetrievalPrepareInput}=await import('../src/index.ts')
 assert.deepEqual(embeddingDownloadSources,['official','hf-mirror'])
 const details={
  modelName:'Fixture model',license:'Apache-2.0',upstreamRepo:'fixture/model',conversionRepo:'fixture/converted',modelDirectory:'/model',runtimeDirectory:'/runtime',
  files:[{path:'model.onnx',source:'huggingface.co',bytes:1,sha256:'b'.repeat(64),shared:false}],
  runtime:{package:'fixture-runtime',version:'1.0.0',source:'registry.npmjs.org',integrity:'sha512-YQ==',unpackedBytesEstimate:1},
  reserveBytes:1,memoryBytesEstimate:[1,2] as [number,number],
 }
 const provider={id:'model',location:'host-local' as const,catalogId:'fixture.model',catalogVersion:'1',profileHash:'a'.repeat(64),variant:'fp32' as const,totalMemoryBytes:8*1024**3,memoryRisk:true}
 const expected=captureRetrievalPreparation({...provider,preparationDetails:{...details,downloadSources:[{id:'official',host:'huggingface.co'},{id:'hf-mirror',host:'hf-mirror.com'}]}})
 assert.deepEqual(readRetrievalPrepareInput({expected}),{expected})
 for(const source of ['official','hf-mirror'] as const)assert.deepEqual(readRetrievalPrepareInput({expected,source}),{expected,source})
 for(const payload of [{expected,source:'evil-mirror'},{expected,source:''},{expected,source:null},{expected,source:undefined},{expected,source:['hf-mirror']},{expected,source:'HF-MIRROR'},{expected,source:'hf-mirror',force:true},{source:'hf-mirror'}]){
  assert.throws(()=>readRetrievalPrepareInput(payload),{code:'teloa/invalid-input'},JSON.stringify(payload))
 }
 // 用户确认的来源表里没有镜像时，镜像不可选；官方始终可选。
 const officialOnly=captureRetrievalPreparation({...provider,preparationDetails:details})
 assert.throws(()=>readRetrievalPrepareInput({expected:officialOnly,source:'hf-mirror'}),{code:'teloa/invalid-input'})
 assert.deepEqual(readRetrievalPrepareInput({expected:officialOnly,source:'official'}),{expected:officialOnly,source:'official'})
})
