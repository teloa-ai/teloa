import test from 'node:test'
import assert from 'node:assert/strict'
import type {Context} from '@deepseek-ai/cordis'
import {createUserMessage,type GenerateOptions} from '@deepseek-ai/dsh-llm'
import {SessionSeq,type Session,type SessionEvent} from '@deepseek-ai/dsh-session'
import type {SessionTitleProvider,SessionTitleProviderRequest} from '@deepseek-ai/dsh-session-title'
import {generateTeloaSessionTitle,registerTeloaSessionTitle,titleFromOutput,titleInput} from '../src/session-title-provider.ts'
import {nativeHotCausalityFixture,textAnswer} from './fixtures/native-hot-causality.ts'
import {readSessionEvents} from '../src/session-events.ts'

const response=(title:string)=>async function*(){
 yield {type:'text-delta' as const,index:0,text:title}
 yield {type:'finish' as const,reason:{kind:'stop' as const}}
}

function fixture(question='如何让会话标题自动更新？'){
 const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:question}]})
 const events:SessionEvent[]=[{seq:SessionSeq(0),time:1,type:'user/message',surfaceOp:'append',data:message}]
 const session={id:'test-session',inheritedEventCount:0,snapshotEvents:()=>events} as unknown as Session
 const request={session,messages:[{seq:SessionSeq(0),text:question}],route:{provider:'test',model:'title-model'},signal:new AbortController().signal} as SessionTitleProviderRequest
 const calls:{options:Readonly<GenerateOptions>;source:{ownerId:string;sessionId:string;messageId:string;eventId:string}}[]=[]
 const ctx={
  sessions:{get:(id:string)=>id===session.id?session:undefined},
  llm:{prepareCall:async()=>({config:{provider:'test',model:'title-model',maxTokens:1024},stream:(options:GenerateOptions)=>response('会话标题自动更新方案')()})},
  teloaNativeInput:{input:{withAuxiliaryModel:async function*(input:{options:Readonly<GenerateOptions>;source:{ownerId:string;sessionId:string;messageId:string;eventId:string};lease:{assertCurrent:()=>void}},dispatch:()=>AsyncIterable<unknown>){
   input.lease.assertCurrent();calls.push({options:input.options,source:input.source})
   yield* dispatch()
  }}},
 } as unknown as Context
 return {ctx,request,calls,message,events}
}

test('已注册标题 provider 只为已核验的普通会话调用模型，未知用途或存储失败不发出请求',async()=>{
 const {ctx,request,calls}=fixture()
 let provider:SessionTitleProvider|undefined,allowed=false,unavailable=false
 Reflect.set(ctx,'effect',(effect:()=>unknown)=>effect())
 Reflect.set(ctx,'sessionTitle',{register:(value:SessionTitleProvider)=>{provider=value;return()=>{provider=undefined}}})
 registerTeloaSessionTitle(ctx,'local:teloa-owner',async sessionId=>{
  assert.equal(sessionId,request.session.id)
  if(unavailable)throw Error('会话存储读取失败')
  return allowed
 })
 assert.ok(provider)
 await assert.rejects(Promise.resolve().then(()=>provider!.generate(request)),/not an ordinary conversation/)
 assert.equal(calls.length,0)
 allowed=true
 assert.equal((await provider.generate(request)).title,'会话标题自动更新方案')
 assert.equal(calls.length,1)
 unavailable=true
 await assert.rejects(Promise.resolve().then(()=>provider!.generate(request)),/会话存储读取失败/)
 assert.equal(calls.length,1)
})

test('首条本人问题经受控辅助模型调用生成短标题，且请求不携带工具',async()=>{
 const {ctx,request,calls,message}=fixture()
 const result=await generateTeloaSessionTitle(ctx,'local:teloa-owner',request)
 assert.equal(result.title,'会话标题自动更新方案')
 assert.deepEqual(result.messageSeqs,[SessionSeq(0)])
 assert.deepEqual(result.model,{provider:'test',model:'title-model'})
 assert.equal(calls.length,1)
 assert.deepEqual(calls[0]!.source,{ownerId:'local:teloa-owner',sessionId:'test-session',messageId:message.id,eventId:`session-title:${message.id}`})
 assert.equal(calls[0]!.options.purpose,'session-title')
 assert.equal(calls[0]!.options.tools,undefined)
 assert.equal(Object.isFrozen(calls[0]!.options),true)
 assert.equal(Object.isFrozen(calls[0]!.options.messages),true)
 assert.match(JSON.stringify(calls[0]!.options.messages),/如何让会话标题自动更新/)
})

test('真实原生输入与模型因果闸接受首问标题请求',async t=>{
 const runtime=await nativeHotCausalityFixture(t)
 runtime.adapter.scripts.push(textAnswer)
 await runtime.send('title-source')
 await runtime.agent.whenIdle()
 const event=readSessionEvents(runtime.agent.session).find(row=>row.type==='user/message'&&row.surfaceOp==='append'&&row.data.source.kind==='user')
 assert.ok(event?.type==='user/message')
 const question=event.data.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
 runtime.adapter.scripts.push([
  {type:'text-delta',index:0,text:'首问标题自动更新'},
  {type:'finish',reason:{kind:'stop'}},
 ])
 const ctx={sessions:runtime.sessions,llm:runtime.ctx.llm,teloaNativeInput:{input:runtime.work}} as unknown as Context
 const request={session:runtime.agent.session,messages:[{seq:event.seq,text:question}],route:{provider:'hot-test',model:'hot-model'},signal:new AbortController().signal} as SessionTitleProviderRequest
 const result=await generateTeloaSessionTitle(ctx,'local:teloa-owner',request)
 assert.equal(result.title,'首问标题自动更新')
 assert.equal(runtime.adapter.requests.length,2)
 assert.equal(runtime.adapter.requests[1]?.purpose,'session-title')
})

test('仅使用首问；来源失效或取消时不得发出辅助模型请求',async()=>{
 const {ctx,request,calls,events}=fixture()
 const second=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'第二个问题'}]})
 events.push({seq:SessionSeq(1),time:2,type:'user/message',surfaceOp:'append',data:second})
 await generateTeloaSessionTitle(ctx,'local:teloa-owner',{...request,messages:[...request.messages,{seq:SessionSeq(1),text:'第二个问题'}]})
 assert.equal(calls.length,1)
 assert.doesNotMatch(JSON.stringify(calls[0]!.options.messages),/第二个问题/)
 events[0]={...events[0]!,surfaceOp:'replay'} as SessionEvent
 await assert.rejects(generateTeloaSessionTitle(ctx,'local:teloa-owner',request),/not an accepted user question/)
 assert.equal(calls.length,1)
 const aborted=new AbortController();aborted.abort()
 await assert.rejects(generateTeloaSessionTitle(ctx,'local:teloa-owner',{...request,signal:aborted.signal}))
 assert.equal(calls.length,1)
})

test('标题清洗与长度上限，长问题安全裁剪',()=>{
 assert.equal(titleFromOutput('\n**关于自动生成会话标题的实现方案与相关设计说明**\n解释'), '关于自动生成会话标题的实现')
 assert.equal(titleFromOutput('"Improve session title generation safely"\nextra'), 'Improve session title generation safely')
 assert.ok(Buffer.byteLength(titleInput('问题'.repeat(5000)),'utf8')<=4096)
 assert.throws(()=>titleFromOutput('   \n  '),/no text/)
})
