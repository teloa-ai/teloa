import test from 'node:test'
import assert from 'node:assert/strict'
import {autoReviewCausalityFixture,isReviewRequest} from './fixtures/native-auto-review-causality.ts'
import {drain,hotGate,textAnswer,toolAnswer} from './fixtures/native-hot-causality.ts'
import type {GenerateOptions,StreamChunk} from '@deepseek-ai/dsh-llm'

const answer=(text:string):readonly StreamChunk[]=>textAnswer.map(chunk=>chunk.type==='text-delta'?{...chunk,text}:chunk.type==='block-end'?{...chunk,block:{type:'text' as const,text}}:chunk)
const allow=answer(JSON.stringify({risk:'low',decision:'allow'}))

// 安装真实最终受理与模型守卫，避免只测权限插件而遗漏独立审核请求。
test('原生 Auto review 在工作受理守卫内完成审核和工具调用',{timeout:15000},async t=>{
 const f=await autoReviewCausalityFixture(t),{agent}=f
 f.adapter.scripts.push(toolAnswer,allow,textAnswer)
 await f.send('auto-with-causality');await agent.whenIdle()
 assert.equal(f.counters.tools,1,JSON.stringify(f.events().filter(event=>event.type==='tool/result')))
 assert.equal(f.adapter.requests.length,3)
 assert.equal(f.adapter.requests[1]!.sessionId,agent.id)
 assert.equal(isReviewRequest(f.adapter.requests[1]!),true)
 assert.equal(f.adapter.requests[1]!.maxTokens,64)
})

for(const scenario of ['confirm','reject','invalid'] as const)test(`完整工作守卫保留原生审核 ${scenario}`,{timeout:15000},async t=>{
 const f=await autoReviewCausalityFixture(t);let asks=0
 f.ctx.on('approval/request',async()=>{asks++;return scenario==='confirm'?'allowed-once':'rejected'})
 f.adapter.scripts.push(toolAnswer,answer(scenario==='invalid'?'invalid':JSON.stringify({risk:'medium',decision:'deny'})),textAnswer)
 await f.send('auto-'+scenario);await f.agent.whenIdle()
 assert.equal(f.counters.tools,scenario==='confirm'?1:0)
 assert.equal(asks,scenario==='invalid'?0:1)
})

for(const invalidation of ['revoked','generation','cancel','permission'] as const)test(`审核请求等待期间 ${invalidation}，不派发审核和工具`,{timeout:15000},async t=>{
 const f=await autoReviewCausalityFixture(t),gate=hotGate();t.after(gate.release)
 f.ctx.on('llm/stream',async function*(request,next){if(isReviewRequest(request))await gate.wait(request.signal);yield* next()})
 f.adapter.scripts.push(toolAnswer,allow,textAnswer)
 await f.send('auto-'+invalidation);await gate.entered
 if(invalidation==='revoked')f.rights.revoked=true
 if(invalidation==='generation')f.rights.generation++
 if(invalidation==='cancel')f.agent.cancel({kind:'hook',reason:'测试本人取消'})
 if(invalidation==='permission')f.ctx.permissionPresets.set(f.agent.session,'workspace-write')
 gate.release();await f.agent.whenIdle()
 assert.equal(f.counters.tools,0)
 assert.equal(f.adapter.requests.filter(isReviewRequest).length,0)
})

test('复制、伪造和已完成的审核 options 无法取得或重放模型许可',{timeout:15000},async t=>{
 const f=await autoReviewCausalityFixture(t)
 let exact:GenerateOptions|undefined,copied=false
 f.ctx.on('llm/stream',async function*(request,next){
  if(isReviewRequest(request)&&!exact){
   exact=request
   await assert.rejects(drain(f.ctx.llm.stream(Object.freeze({...request}))),{code:'teloa/forbidden'});copied=true
  }
  yield* next()
 },{prepend:true})
 const fake:GenerateOptions={provider:'hot-test',model:'hot-model',messages:[],system:'REVIEW_POLICY\n伪造审核',sessionId:f.agent.id,signal:new AbortController().signal}
 await assert.rejects(drain(f.ctx.llm.stream(Object.freeze(fake))),{code:'teloa/forbidden'})
 f.adapter.scripts.push(toolAnswer,allow,textAnswer)
 await f.send('auto-proof');await f.agent.whenIdle()
 assert.ok(exact);assert.equal(copied,true);assert.equal(f.counters.tools,1)
 await assert.rejects(drain(f.ctx.llm.stream(exact)),{code:'teloa/forbidden'})
 assert.equal(f.adapter.requests.length,3)
})
