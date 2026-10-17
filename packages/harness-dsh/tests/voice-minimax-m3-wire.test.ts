import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime,ReasoningEffortId,createUserMessage,type ContentBlock,type FinishReason} from '@deepseek-ai/dsh-llm'
import type {UserMessage} from '@deepseek-ai/dsh-session'
import {nativeHotCausalityFixture,textAnswer} from './fixtures/native-hot-causality.ts'

const provider='teloa-voice-minimax-wire',baseURL='https://api.minimax.io/anthropic',modelId='MiniMax-M3'
const keyName='TELOA_TEST_VOICE_M3_WIRE_KEY'
type Model={id:string;contextWindow:number;maxTokens:number;reasoningEfforts?:Record<string,string|null>}
// 容量仅为本地夹具的必填元数据，不宣称是真实 M3 的模型规格。
const model=(id:string,reasoning=true):Model=>({id,contextWindow:65536,maxTokens:4096,...reasoning?{reasoningEfforts:{off:null,high:'high'}}:{}})

function reply(model:string){
 const events:readonly [string,object][]=[
  ['message_start',{type:'message_start',message:{id:'msg_wire_fixture',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:3,output_tokens:0}}}],
  ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],
  ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'模拟回复'}}],
  ['content_block_stop',{type:'content_block_stop',index:0}],
  ['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:2}}],
  ['message_stop',{type:'message_stop'}],
 ]
 return new Response(events.map(([name,data])=>'event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})
}

async function fixture(models:readonly Model[]|undefined,providerId=provider){
 const ctx=new Context(),previousFetch=globalThis.fetch,previousKey=process.env[keyName],requests:Record<string,any>[]=[]
 process.env[keyName]='synthetic-test-key-only'
 globalThis.fetch=async(input,init)=>{
  const url=new URL(input instanceof Request?input.url:String(input))
  assert.equal(url.origin,'https://api.minimax.io');assert.equal(url.pathname,'/anthropic/v1/messages')
  assert.equal(init?.method??(input instanceof Request?input.method:'GET'),'POST')
  const body=init?.body??(input instanceof Request?await input.clone().text():undefined)
  assert.equal(typeof body,'string')
  const request=JSON.parse(body as string);requests.push(request)
  return reply(request.model)
 }
 const dispose=async()=>{try{await ctx.fiber.dispose()}finally{globalThis.fetch=previousFetch;if(previousKey===undefined)delete process.env[keyName];else process.env[keyName]=previousKey}}
 try{
  await ctx.plugin(LlmRuntime)
  const host=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
  const metadata=host(requirePath(host.resolve('@deepseek-ai/dsh-llm-pi-ai')))
  assert.equal(metadata.version,'0.2.1-rc.2')
  const plugin=await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-llm-pi-ai')).href)
  await ctx.plugin(plugin,{providers:{[providerId]:models?{apiKeyEnv:keyName,api:'anthropic-messages',baseURL,reasoning:'high',models}:{apiKeyEnv:keyName}}})
  const stream=async(id:string,effort:'off'|'high')=>{
   const blocks:ContentBlock[]=[],finishes:FinishReason[]=[]
   for await(const chunk of ctx.llm.stream({provider:providerId,model:id,reasoningEffort:ReasoningEffortId(effort),messages:[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'合成测试输入'}]})],tools:[],signal:AbortSignal.timeout(5000)})){
    if(chunk.type==='finish')finishes.push(chunk.reason)
    if(chunk.type==='block-end')blocks.push(chunk.block)
   }
   return {blocks,finishes}
  }
  return {ctx,requests,stream,dispose}
 }catch(error){await dispose();throw error}
}
function requirePath(entry:string){return new URL('../package.json',pathToFileURL(entry)).pathname}

test('固定官方pi-ai：M3显式声明后off覆盖high默认，最终wire为thinking.disabled且后续基线独立',async t=>{
 const baseline='MiniMax-M2.7-highspeed',f=await fixture([model(baseline),model(modelId)]);t.after(f.dispose)
 const info=await f.ctx.llm.resolveModelInfo(provider,modelId)
 assert.equal(info.id,modelId);assert.ok(info.reasoning?.efforts.some(row=>row.id==='off'))
 const first=await f.stream(baseline,'high')
 const {blocks,finishes}=await f.stream(modelId,'off')
 const last=await f.stream(baseline,'high')
 assert.deepEqual(first.finishes,[{kind:'stop'}]);assert.deepEqual(finishes,[{kind:'stop'}]);assert.deepEqual(last.finishes,[{kind:'stop'}])
 assert.deepEqual(f.requests.map(row=>({model:row.model,thinking:row.thinking?.type})),[
  {model:baseline,thinking:'enabled'},{model:modelId,thinking:'disabled'},{model:baseline,thinking:'enabled'},
 ])
 assert.deepEqual(blocks.filter(block=>block.type==='text').map(block=>block.text),['模拟回复'])
 assert.equal(blocks.some(block=>block.type==='reasoning'),false,'这里只验证模拟wire，不代表真实提供方零思考质量')
})

test('固定官方pi-ai：provider未声明M3时resolve与发送都UNKNOWN_MODEL，不接受任意ID或发网络请求',async t=>{
 const f=await fixture([model('MiniMax-M2.7-highspeed')]);t.after(f.dispose)
 await assert.rejects(f.ctx.llm.resolveModelInfo(provider,modelId),{code:'UNKNOWN_MODEL'})
 const {blocks,finishes}=await f.stream(modelId,'off')
 assert.deepEqual(blocks,[]);assert.equal(finishes.length,1)
 const finish=finishes[0];assert.ok(finish&&finish.kind==='error')
 assert.equal(finish.failure.code,'UNKNOWN_MODEL')
 assert.equal(f.requests.length,0)
})

test('固定官方pi-ai：builtin minimax只配置凭据引用时目录已含M3，off最终发thinking.disabled',async t=>{
 const f=await fixture(undefined,'minimax');t.after(f.dispose)
 const info=await f.ctx.llm.resolveModelInfo('minimax',modelId)
 assert.equal(info.id,modelId);assert.ok(info.reasoning?.efforts.some(row=>row.id==='off'))
 const result=await f.stream(modelId,'off')
 assert.deepEqual(result.finishes,[{kind:'stop'}])
 assert.deepEqual(f.requests.map(row=>({model:row.model,thinking:row.thinking?.type})),[{model:modelId,thinking:'disabled'}])
})

test('原生Session会快照Controller消息，可信标记须绑定inserted的canonical对象而非原候选',async t=>{
 const f=await nativeHotCausalityFixture(t),id='voice-canonical-wire',original=createUserMessage({source:{kind:'user',rpcId:id},content:[{type:'text',text:'合成语音来源测试'}]})
 let inserted:UserMessage|undefined,claimed:UserMessage|undefined
 const trusted=new WeakSet<object>()
 f.ctx.on('agent/inbox/inserted',({message})=>{if(message.source.kind==='user'&&'rpcId'in message.source&&message.source.rpcId===id){inserted=message;trusted.add(message)}})
 f.ctx.on('agent/inbox/claimed',({message})=>{if(message.source.kind==='user'&&'rpcId'in message.source&&message.source.rpcId===id)claimed=message})
 f.adapter.scripts.push(textAnswer)
 await f.work.withNewInput(f.agent,original,{producer:'prompt',identity:id},()=>f.agent.followup(original));await f.agent.whenIdle()
 assert.ok(inserted&&claimed)
 assert.notEqual(inserted,original,'Session.append拥有自己的不可变快照')
 assert.equal(claimed,inserted,'同一活跃宿主内Inbox消费原canonical消息对象')
 assert.equal(trusted.has(claimed),true);assert.equal(trusted.has({...claimed}),false,'同形浏览器数据不能继承不可序列化标记')
})
