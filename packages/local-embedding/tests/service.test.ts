import test from 'node:test'
import assert from 'node:assert/strict'
import {setTimeout as sleep} from 'node:timers/promises'
import {WorkError,readEmbeddingPreparationState,type EmbeddingPreparationState} from '@teloa/contract'
import {AssetDownloadError} from '../src/assets.ts'
import {createEmbeddingProvider,createEmbeddingService,type EmbeddingEngine,type EmbeddingProviderOptions} from '../src/service.ts'

const vector=(seed:number)=>{const v=new Float32Array(1024);v[seed%1024]=1;return v}
type FakeEngine=EmbeddingEngine&{calls:{kind:string;texts:string[]}[];closed:boolean;crash():void}
function fakeEngine(behavior:{fail?:boolean;bad?:boolean;delayMs?:number}={},concurrency={active:0,peak:0}):FakeEngine{
 let crash!:()=>void
 const exited=new Promise<void>(resolve=>{crash=resolve})
 const engine:FakeEngine={calls:[],closed:false,exited,crash:()=>crash(),
  async embed(kind,texts,signal){
   engine.calls.push({kind,texts})
   concurrency.active++;concurrency.peak=Math.max(concurrency.peak,concurrency.active)
   try{
    await sleep(behavior.delayMs??5,undefined,{signal})
    if(behavior.fail)throw new Error('推理失败')
    return {vectors:behavior.bad?[new Float32Array(3)]:texts.map((_,i)=>vector(i)),truncated:texts.filter(text=>text.length>100).length}
   }finally{concurrency.active--}
  },
  async close(){engine.closed=true;crash()},
 }
 return engine
}

type Harness={options:EmbeddingProviderOptions;states:EmbeddingPreparationState[];log:string[];engines:FakeEngine[]}
function harness(overrides:Partial<EmbeddingProviderOptions>&{installed?:boolean;cached?:boolean;engine?:()=>FakeEngine}={}):Harness{
 const states:EmbeddingPreparationState[]=[],log:string[]=[],engines:FakeEngine[]=[]
 let installed=overrides.installed??false,cached=overrides.cached??false
 const options:EmbeddingProviderOptions={
  id:'qwen3-embedding-0.6b',catalogId:'teloa.model.qwen3-embedding-0-6b',catalogVersion:'1.0.0',variant:'fp32',profileHash:'a'.repeat(64),
  runtime:{resource:'onnxruntime-node@1.30.0',source:'registry.npmjs.org',check:async()=>{log.push('runtime.check');return installed},install:async()=>{log.push('runtime.install');await sleep(5);installed=true;return '/runtime'}},
  assets:{resource:'onnx/model.onnx',inspect:async()=>{log.push('assets.inspect');return cached?'complete':'missing'},prepare:async(signal,onProgress)=>{
   log.push('assets.prepare')
   onProgress({resource:'onnx/model.onnx',completedBytes:10,totalBytes:100})
   await sleep(20,undefined,{signal})
   onProgress({resource:'onnx/model.onnx',completedBytes:100,totalBytes:100})
   cached=true
  }},
  startEngine:async()=>{log.push('engine.start');const engine=(overrides.engine??(()=>fakeEngine()))();engines.push(engine);return engine},
  idleTimeoutMs:60_000,
  totalMemoryBytes:48*1024**3,
  onChange:state=>states.push(readEmbeddingPreparationState(state)),
  ...overrides,
 }
 return {options,states,log,engines}
}
const phases=(states:EmbeddingPreparationState[])=>states.map(state=>state.phase==='downloading'?`downloading:${state.stage}`:state.phase).filter((phase,i,all)=>phase!==all[i-1])
const code=(expected:string)=>(error:unknown)=>error instanceof WorkError&&error.code===expected
const until=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await sleep(5);assert.ok(check())}

test('启用只检查：运行时与缓存都完整即 standby；缺任一为 unprepared；检查出错为 failed；从不安装或下载',async()=>{
 for(const [installed,cached,expected] of [[true,true,'standby'],[false,true,'unprepared'],[true,false,'unprepared']] as const){
  const h=harness({installed,cached})
  const provider=createEmbeddingProvider(h.options)
  await provider.inspected
  assert.equal(provider.state().phase,expected)
  assert.deepEqual(phases(h.states),['checking',expected])
  assert.ok(!h.log.includes('runtime.install')&&!h.log.includes('assets.prepare')&&!h.log.includes('engine.start'))
 }
 const h=harness({assets:{resource:'onnx/model.onnx',inspect:async()=>{throw Object.assign(new Error('EACCES'),{code:'EACCES'})},prepare:async()=>{}}})
 const provider=createEmbeddingProvider(h.options)
 await provider.inspected
 const state=provider.state()
 assert.equal(state.phase,'failed')
})

test('未就绪时 embed 报 dependency-unavailable，绝不隐式安装、下载或加载',async()=>{
 const h=harness()
 const provider=createEmbeddingProvider(h.options)
 await provider.inspected
 await assert.rejects(provider.embed({kind:'query',texts:['报销']},new AbortController().signal),code('teloa/dependency-unavailable'))
 assert.deepEqual(h.log,['runtime.check','assets.inspect'])
})

test('prepare：先 stage runtime 装运行时，再 stage assets 下载工件，然后加载进入 ready；已就绪再 prepare 不重复安装',async()=>{
 const h=harness()
 const provider=createEmbeddingProvider(h.options)
 await provider.inspected
 provider.prepare()
 await provider.settled()
 assert.deepEqual(phases(h.states),['checking','unprepared','downloading:runtime','downloading:assets','loading','ready'])
 assert.deepEqual(h.log.slice(2),['runtime.install','assets.prepare','engine.start'])
 const runtimeState=h.states.find(state=>state.phase==='downloading'&&state.stage==='runtime')
 assert.deepEqual(runtimeState,{phase:'downloading',stage:'runtime',resource:'onnxruntime-node@1.30.0',completedBytes:0})
 assert.ok(h.states.some(state=>state.phase==='downloading'&&state.stage==='assets'&&state.completedBytes===100&&state.totalBytes===100))
 assert.deepEqual(h.states.find(state=>state.phase==='downloading'&&state.stage==='assets'),{phase:'downloading',stage:'assets',resource:'onnx/model.onnx',completedBytes:0},'工件阶段一开始就可见（复核已在位文件时也不停留在运行时阶段）')
 provider.prepare()
 await provider.settled()
 assert.equal(h.log.filter(entry=>entry==='runtime.install').length,1)
 await provider.dispose()
})

test('运行时安装失败映射为 failed：install-timeout → timeout，install-failed → unknown；不进入工件阶段；可重试',async()=>{
 for(const [errorCode,reason] of [['install-timeout','timeout'],['install-failed','unknown']] as const){
  let fail=true
  const h=harness()
  h.options.runtime={...h.options.runtime,install:async()=>{h.log.push('runtime.install');if(fail)throw new WorkError('teloa/dependency-unavailable','安装包 onnxruntime-node@1.30.0 安装失败，已清理未装完的文件；请稍后重试。',{errorCode,retryable:true});return '/runtime'}}
  const provider=createEmbeddingProvider(h.options)
  await provider.inspected
  provider.prepare()
  await provider.settled()
  const state=provider.state()
  assert.equal(state.phase,'failed')
  assert.deepEqual(state.phase==='failed'&&state.download,{resource:'onnxruntime-node@1.30.0',source:'registry.npmjs.org',reason})
  assert.ok(!h.log.includes('assets.prepare'))
  fail=false
  provider.prepare()
  await provider.settled()
  assert.equal(provider.state().phase,'ready')
  await provider.dispose()
 }
})

test('工件下载失败映射为 failed：带文件、来源主机与原因分类',async()=>{
 const h=harness({installed:true})
 h.options.assets={...h.options.assets,prepare:async()=>{throw new AssetDownloadError('onnx/model.onnx_data','huggingface.co','integrity','SHA-256 与清单不符。')}}
 const provider=createEmbeddingProvider(h.options)
 await provider.inspected
 provider.prepare()
 await provider.settled()
 const state=provider.state()
 assert.equal(state.phase,'failed')
 assert.deepEqual(state.phase==='failed'&&state.download,{resource:'onnx/model.onnx_data',source:'huggingface.co',reason:'integrity'})
 assert.match(state.phase==='failed'?state.message:'',/onnx\/model\.onnx_data/)
})

test('cancelPreparation：下载中取消 → cancelling → cancelled，等待收尾；结果发布后取消不覆盖；取消后可重新准备',async()=>{
 const h=harness({installed:true})
 const provider=createEmbeddingProvider(h.options)
 await provider.inspected
 provider.prepare()
 await until(()=>h.log.includes('assets.prepare'))
 await provider.cancelPreparation()
 assert.equal(provider.state().phase,'cancelled')
 assert.deepEqual(phases(h.states).slice(-2),['cancelling','cancelled'])
 assert.ok(!h.log.includes('engine.start'))
 provider.prepare()
 await provider.settled()
 assert.equal(provider.state().phase,'ready')
 await provider.cancelPreparation()
 assert.equal(provider.state().phase,'ready')
 await provider.dispose()
})

test('embed：standby 按需唤醒子进程；串行执行；返回 profileHash 与向量；截断次数计入度量',async()=>{
 const concurrency={active:0,peak:0}
 const h=harness({installed:true,cached:true,engine:()=>fakeEngine({delayMs:10},concurrency)})
 const provider=createEmbeddingProvider(h.options)
 await provider.inspected
 const signal=new AbortController().signal
 const results=await Promise.all([provider.embed({kind:'query',texts:['a']},signal),provider.embed({kind:'passage',texts:['b','x'.repeat(200)]},signal),provider.embed({kind:'passage',texts:['c']},signal)])
 assert.equal(h.engines.length,1,'只唤醒一次')
 assert.equal(concurrency.peak,1,'推理串行')
 assert.deepEqual(results.map(result=>result.vectors.length),[1,2,1])
 assert.ok(results.every(result=>result.profileHash==='a'.repeat(64)&&result.vectors.every(v=>v.length===1024)))
 assert.deepEqual(h.engines[0]!.calls.map(call=>call.kind),['query','passage','passage'])
 assert.equal(provider.metrics().truncatedTexts,1)
 assert.equal(provider.state().phase,'ready')
 assert.deepEqual(phases(h.states),['checking','standby','loading','ready'])
 await provider.dispose()
})

test('embed 入参：空数组、超过 32 条、非字符串、未知 kind 报 invalid-input；队列上限 maxPending（默认 8）外报 dependency-unavailable',async()=>{
 const h=harness({installed:true,cached:true,engine:()=>fakeEngine({delayMs:30})})
 const provider=createEmbeddingProvider(h.options)
 await provider.inspected
 const signal=new AbortController().signal
 for(const input of [{kind:'query',texts:[]},{kind:'query',texts:Array.from({length:33},()=>'x')},{kind:'query',texts:[1]},{kind:'other',texts:['x']},{kind:'query'}])
  await assert.rejects(provider.embed(input as never,signal),code('teloa/invalid-input'),JSON.stringify(input))
 const accepted=Array.from({length:8},()=>provider.embed({kind:'passage',texts:['x']},signal))
 await assert.rejects(provider.embed({kind:'passage',texts:['x']},signal),code('teloa/dependency-unavailable'))
 await Promise.all(accepted)
 await provider.embed({kind:'passage',texts:Array.from({length:32},()=>'x')},signal)
 await provider.dispose()
})

test('推理失败或响应格式错：回收子进程、回到 standby、报 dependency-unavailable；下次 embed 重新唤醒',async()=>{
 for(const behavior of [{fail:true},{bad:true}]){
  let first=true
  const h=harness({installed:true,cached:true,engine:()=>{const engine=fakeEngine(first?behavior:{});first=false;return engine}})
  const provider=createEmbeddingProvider(h.options)
  await provider.inspected
  await assert.rejects(provider.embed({kind:'query',texts:['a']},new AbortController().signal),code('teloa/dependency-unavailable'))
  assert.equal(h.engines[0]!.closed,true)
  assert.equal(provider.state().phase,'standby')
  await provider.embed({kind:'query',texts:['a']},new AbortController().signal)
  assert.equal(h.engines.length,2)
  await provider.dispose()
 }
})

test('子进程崩溃：状态回到 standby，下次 embed 重新唤醒；推理截止时间到期回收子进程',async()=>{
 const h=harness({installed:true,cached:true})
 const provider=createEmbeddingProvider(h.options)
 await provider.inspected
 await provider.embed({kind:'query',texts:['a']},new AbortController().signal)
 h.engines[0]!.crash()
 await until(()=>provider.state().phase==='standby')
 await provider.embed({kind:'query',texts:['a']},new AbortController().signal)
 assert.equal(h.engines.length,2)
 await provider.dispose()
 const slow=harness({installed:true,cached:true,inferenceTimeoutMs:20,engine:()=>fakeEngine({delayMs:500})})
 const other=createEmbeddingProvider(slow.options)
 await other.inspected
 await assert.rejects(other.embed({kind:'query',texts:['a']},new AbortController().signal),code('teloa/dependency-unavailable'))
 assert.equal(slow.engines[0]!.closed,true)
 await other.dispose()
})

test('空闲超时后子进程退出、回到 standby；调用方取消排队中的请求报 cancelled 且不执行',async()=>{
 const h=harness({installed:true,cached:true,idleTimeoutMs:30,engine:()=>fakeEngine({delayMs:20})})
 const provider=createEmbeddingProvider(h.options)
 await provider.inspected
 await provider.embed({kind:'query',texts:['a']},new AbortController().signal)
 assert.equal(provider.state().phase,'ready')
 await until(()=>provider.state().phase==='standby')
 assert.equal(h.engines[0]!.closed,true)
 const controller=new AbortController()
 const running=provider.embed({kind:'query',texts:['first']},new AbortController().signal)
 const queued=provider.embed({kind:'query',texts:['second']},controller.signal)
 controller.abort()
 await assert.rejects(queued,code('teloa/cancelled'))
 await running
 assert.deepEqual(h.engines.flatMap(engine=>engine.calls.map(call=>call.texts[0])),['a','first'])
 await provider.dispose()
})

test('内存风险：物理内存 ≤ 8 GiB 且 fp32 时快照 memoryRisk=true；int8 或大内存为 false',async()=>{
 for(const [totalMemoryBytes,variant,risk] of [[8*1024**3,'fp32',true],[8*1024**3,'int8',false],[16*1024**3,'fp32',false]] as const){
  const h=harness({installed:true,cached:true,totalMemoryBytes,variant})
  const provider=createEmbeddingProvider(h.options)
  await provider.inspected
  assert.equal(provider.snapshotRow().memoryRisk,risk,`${totalMemoryBytes} ${variant}`)
  assert.equal(provider.snapshotRow().totalMemoryBytes,totalMemoryBytes)
  await provider.dispose()
 }
})

test('服务接口：snapshot 同形于语音服务；未知 provider 报 not-found',async()=>{
 const h=harness({installed:true,cached:true})
 const provider=createEmbeddingProvider(h.options)
 const service=createEmbeddingService([provider])
 await provider.inspected
 assert.deepEqual(service.snapshot(),{providers:[{id:'qwen3-embedding-0.6b',location:'host-local',catalogId:'teloa.model.qwen3-embedding-0-6b',catalogVersion:'1.0.0',profileHash:'a'.repeat(64),variant:'fp32',totalMemoryBytes:48*1024**3,memoryRisk:false,preparation:{phase:'standby'}}]})
 assert.throws(()=>service.prepare('other'),code('teloa/not-found'))
 await assert.rejects(service.cancelPreparation('other'),code('teloa/not-found'))
 await assert.rejects(service.embed('other',{kind:'query',texts:['a']},new AbortController().signal),code('teloa/not-found'))
 const result=await service.embed('qwen3-embedding-0.6b',{kind:'query',texts:['a']},new AbortController().signal)
 assert.equal(result.vectors.length,1)
 await provider.dispose()
})

test('准备来源只作用于本次准备：service.prepare(id,{source}) 原样交给工件阶段；缺省为 official；下次准备不沿用上次选择',async()=>{
 const sources:string[]=[]
 const h=harness()
 h.options.assets={...h.options.assets,prepare:async(_signal,_onProgress,source)=>{sources.push(source);throw new AssetDownloadError('tokenizer.json','hf-mirror.com','integrity','SHA-256 与清单不符。请改用 Hugging Face 官方来源重试。')}}
 const provider=createEmbeddingProvider(h.options)
 const service=createEmbeddingService([provider])
 await provider.inspected
 service.prepare('qwen3-embedding-0.6b',{source:'hf-mirror'})
 await provider.settled()
 assert.deepEqual(provider.state(),{phase:'failed',message:'模型文件 tokenizer.json（来源 hf-mirror.com）准备失败：SHA-256 与清单不符。请改用 Hugging Face 官方来源重试。',download:{resource:'tokenizer.json',source:'hf-mirror.com',reason:'integrity'}})
 service.prepare('qwen3-embedding-0.6b')
 await provider.settled()
 provider.prepare({source:'official'})
 await provider.settled()
 assert.deepEqual(sources,['hf-mirror','official','official'])
 await provider.dispose()
})
