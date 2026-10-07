import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {TokenMeter} from '@deepseek-ai/dsh-token-meter'
import {createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {installLocalModelRequests} from '../src/local-model-request.ts'
import type {LocalModelCompaction} from '../src/local-model-compaction.ts'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'
import {drain,hotGate,nativeHotCausalityFixture,textAnswer} from './fixtures/native-hot-causality.ts'

const options={timeout:10000},forbidden={code:'teloa/forbidden'}
const overflow:readonly StreamChunk[]=[{type:'finish',reason:{kind:'error',failure:{code:'CONTEXT_WINDOW_EXCEEDED',message:'明确的容量溢出夹具'}}}]

/** 实际产品源码临时副本只重接 import；准入与摘要子类复用同一精确官方补丁模块。 */
async function fixture(t:TestContext,local=false){
 const pkg=await patchedNativePackage<typeof import('@deepseek-ai/dsh-compaction-basic')>(t,{packageName:'@deepseek-ai/dsh-compaction-basic',compatBasename:'dsh-compaction-basic-0.2.1-alpha.1-summary-request'})
 const basic=pathToFileURL(join(pkg.root,'lib/index.js')).href
 const copy=async(relative:string,name:string,replacements:Record<string,string>={})=>{
  const origin=new URL(relative,import.meta.url),require=createRequire(origin)
  const source=(await readFile(origin,'utf8')).replace(/from (['"])([^'"]+)\1/g,(original,_quote,specifier:string)=>{
   if(specifier.startsWith('node:'))return original
   const target=replacements[specifier]??(specifier.startsWith('.')?new URL(specifier,origin).href:pathToFileURL(require.resolve(specifier)).href)
   return 'from '+JSON.stringify(target)
  })
  const file=join(pkg.root,name);await writeFile(file,source);return pathToFileURL(file).href
 }
 const causality=await copy('../src/native-work-causality.ts','native-work-causality.ts',{'@deepseek-ai/dsh-compaction-basic':basic})
 const input=await copy('../src/native-work-input.ts','native-work-input.ts',{'./native-work-causality.ts':causality})
 const kernel=await copy('./fixtures/native-hot-causality.ts','native-hot-causality.ts',{'../../src/native-work-input.ts':input})
 const fixtureModule=await import(kernel) as {nativeHotCausalityFixture:typeof nativeHotCausalityFixture}
 const f=await fixtureModule.nativeHotCausalityFixture(t)
 const product=await import(await copy('../src/local-model-compaction.ts','local-model-compaction.ts',{'@deepseek-ai/dsh-compaction-basic':basic})) as {LocalModelCompaction:typeof LocalModelCompaction}
 await f.ctx.plugin(TokenMeter)
 let capacity=8192
 if(local){
  f.ctx.llm.registerAdapter(['ollama'],f.adapter)
  f.agent.ctx.on('agent/request',async(_payload,next)=>({...await next(),provider:'ollama',maxTokens:2048}))
  installLocalModelRequests(f.ctx,{prepareRequest:async config=>config,requestCapacity:async()=>capacity})
 }
 await f.agent.ctx.plugin(product.LocalModelCompaction,{headroomTokens:128,maxTokens:256,retainTokens:0,compactionRetries:0,maxOverflowRetries:1})
 return {...f,engine:f.agent.ctx.get('compaction') as LocalModelCompaction,
  // 官方始终保留最后一个 surface 节点；先真实完成长历史，再由下一回合触发压缩。
  async start(id:string){
   const message=createUserMessage({source:{kind:'user',rpcId:id},content:[{type:'text',text:'a'.repeat(9000)}]})
   await f.work.withNewInput(f.agent,message,{producer:'prompt',identity:id},()=>f.agent.followup(message))
  },
  shrink(){capacity=4096},
 }
}

test('真实官方本地容量闸触发摘要，沿原受理完成同一回合且不新增授权',options,async t=>{
 const f=await fixture(t,true)
 f.adapter.scripts.push(textAnswer,textAnswer,textAnswer)
 await f.start('local-history');await f.agent.whenIdle();f.shrink()
 await f.send('local-overflow');await f.agent.whenIdle()
 assert.deepEqual(f.adapter.requests.map(request=>request.purpose??'main'),['main','compaction','main'])
 assert.equal(f.adapter.requests[1]!.sessionId,f.agent.id)
 assert.equal(f.authorizations.length,2)
 assert.ok(f.counters.continuationAssertions>0)
 assert.equal(f.events().filter(event=>event.type==='step/start').length,2)
 const end=f.events().find(event=>event.type==='compaction/end')
 assert.ok(end&&end.type==='compaction/end'&&!end.data.error,'真实摘要替换已提交')
 assert.equal(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed')
})

test('官方 pre-step 在新 turn 尚未 claim 时绑定原 Inbox 最终受理，摘要后原输入只领取一次',options,async t=>{
 const f=await fixture(t)
 f.adapter.resolveModel=async(provider,model)=>({provider,id:model,name:model,inputModalities:['text'] as const,context:{contextWindow:2400},defaultMaxTokens:256})
 f.adapter.scripts.push(textAnswer,textAnswer,textAnswer)
 await f.start('pressure-first');await f.agent.whenIdle()
 await f.send('pressure-next');await f.agent.whenIdle()
 assert.deepEqual(f.adapter.requests.map(request=>request.purpose??'main'),['main','compaction','main'])
 assert.equal(f.authorizations.length,2)
 assert.equal(f.events().filter(event=>event.type==='user/message'&&event.data.source.kind==='user').length,2)
 assert.equal(f.events().filter(event=>event.type==='turn/start').length,2)
 assert.equal(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed')
})

for(const invalidation of ['撤销','换代'] as const)test(`官方摘要 middleware 等待期间${invalidation}，最终派发拒绝且原回合不重试`,options,async t=>{
 const f=await fixture(t),gate=hotGate();t.after(gate.release)
 f.adapter.scripts.push(textAnswer,overflow,textAnswer,textAnswer)
 f.ctx.on('llm/stream',async function*(request,next){if(request.purpose==='compaction')await gate.wait(request.signal);yield* next()})
 await f.start('summary-history');await f.agent.whenIdle()
 await f.send('summary-invalidation');await gate.entered
 if(invalidation==='撤销')f.rights.revoked=true;else f.rights.generation++
 gate.release();await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,2,'撤销/原归属世代失效后不派发摘要或重试主模型')
 assert.equal(f.events().filter(event=>event.type==='assistant/message').length,1)
 assert.ok(f.events().some(event=>event.type==='compaction/end'&&event.data.error))
})

test('官方摘要自然到期仍沿原受理续作，新输入不继承许可',options,async t=>{
 const f=await fixture(t),gate=hotGate();t.after(gate.release)
 f.adapter.scripts.push(textAnswer,overflow,textAnswer,textAnswer)
 f.ctx.on('llm/stream',async function*(request,next){if(request.purpose==='compaction')await gate.wait(request.signal);yield* next()})
 await f.start('summary-history');await f.agent.whenIdle()
 await f.send('summary-expiry');await gate.entered
 f.rights.valid=false;gate.release();await f.agent.whenIdle()
 assert.deepEqual(f.adapter.requests.map(request=>request.purpose??'main'),['main','main','compaction','main'])
 assert.equal(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed')
 await assert.rejects(f.send('new-after-summary-expiry'),forbidden)
 assert.equal(f.authorizations.length,3)
 assert.equal(f.adapter.requests.length,4)
})

test('purpose、原 session 与 initiator 都不授予伪造摘要许可，完成的实际摘要也不能重放',options,async t=>{
 const f=await fixture(t)
 const fake:GenerateOptions={provider:'hot-test',model:'hot-model',messages:[],purpose:'compaction',sessionId:f.agent.id,signal:new AbortController().signal}
 await assert.rejects(drain(f.ctx.llm.stream(fake)),forbidden)
 let exact:GenerateOptions|undefined,rejected=false
 f.ctx.on('llm/stream',async function*(request,next){
  if(request.purpose==='compaction'&&!exact){
   exact=request
   try{await f.ctx.agents.withInitiator(f.agent,()=>drain(f.ctx.llm.stream(Object.freeze({...request}))))}catch{rejected=true}
  }
  yield* next()
 },{prepend:true})
 f.adapter.scripts.push(textAnswer,overflow,textAnswer,textAnswer)
 await f.start('summary-history');await f.agent.whenIdle()
 await f.send('summary-provenance');await f.agent.whenIdle()
 assert.equal(rejected,true);assert.ok(exact)
 assert.equal(f.adapter.requests.length,4)
 await assert.rejects(drain(f.ctx.llm.stream(exact)),forbidden)
 assert.equal(f.adapter.requests.length,4)
})

test('自定义 engine 的不可替换同名查询不能为 active turn 伪造官方摘要请求',options,async t=>{
 const f=await fixture(t)
 let attempted=false,rejected=false
 f.ctx.on('llm/stream',async function*(request,next){
  if(!attempted){
   attempted=true
   const fake=Object.freeze({...request,purpose:'compaction' as const})
   Object.defineProperty(f.engine,'summaryRequestOwner',{value:()=>Object.freeze({agent:f.agent,session:f.agent.session,options:fake,signal:fake.signal}),writable:false,configurable:false})
   try{await drain(f.ctx.llm.stream(fake))}catch{rejected=true}
  }
  yield* next()
 },{prepend:true})
 f.adapter.scripts.push(textAnswer)
 await f.start('custom-engine-forgery');await f.agent.whenIdle()
 assert.equal(attempted,true);assert.equal(rejected,true)
 assert.equal(f.adapter.requests.length,1,'只有已受理的原主模型请求派发')
 assert.equal(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'completed')
})
