import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {LlmAdapter,LlmRuntime,ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import type {PageCreateDraft} from '@teloa/contract'
import {registerPageCreateTools,type PageCreateToolsPorts} from '../src/page-create-tools.ts'

const owner='local:teloa-owner',id='11111111-1111-4111-8111-111111111111',stamp='2026-10-12T00:00:00.000Z'
class Adapter extends LlmAdapter{
 requests:GenerateOptions[]=[];lookup=true
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model,inputModalities:['text'] as const}}
 async *stream(options:GenerateOptions):AsyncGenerator<StreamChunk>{
  this.requests.push(options)
  if(this.requests.length===1&&this.lookup){const id=ToolCallId('original-lookup'),name='teloa_create_drafts',args=JSON.stringify({entity:'skill',title:'核对原稿'});yield {type:'block-start',index:0,blockType:'tool-call'};yield {type:'tool-call-delta',index:0,id,name,argumentsDelta:args};yield {type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:args}};yield {type:'finish',reason:{kind:'tool-calls'}};return}
  yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'收到'};yield {type:'block-end',index:0,block:{type:'text',text:'收到'}};yield {type:'finish',reason:{kind:'stop'}}
 }
}
async function fixture(t:TestContext){
 const ctx=new Context();t.after(()=>ctx.fiber.dispose());for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin);await ctx.plugin(AgentLoop,{agents:[]})
 const adapter=new Adapter();ctx.llm.registerAdapter(['capture'],adapter)
 const {agent}=await ctx.agents.create({sessionId:SessionId('saved-state'),agentOptions:{provider:'capture',model:'model'}})
 const state={draft:{id,ownerId:owner,requestId:'22222222-2222-4222-8222-222222222222',entity:'skill',title:'核对原稿',body:'PRIVATE_BODY_DO_NOT_INJECT',bodyHash:'a'.repeat(64),status:'draft',createdAt:stamp,updatedAt:stamp} as PageCreateDraft,reads:0,owner,policy:null as null|Record<string,unknown>,offline:false,revokeAfterRead:false}
 const ports:PageCreateToolsPorts={owner,conversation:async sessionId=>({ownerId:state.owner,sessionId,status:'ready'}),readTaskPolicy:async()=>state.policy as never,skillCreator:null,directory:async()=>{throw Error('new-directory must not run')},draft:async()=>{throw Error('write must not run')},preview:async()=>{throw Error('body must not run')},draftDirectory:async input=>{state.reads++;if(state.offline)throw Error('PRIVATE_EXCEPTION');if(state.revokeAfterRead)state.owner='other';return {schema:'teloa.page-create-drafts/v1',...input,readAt:new Date().toISOString(),drafts:[{...state.draft}]}}}
 registerPageCreateTools(ctx,ports)
 const send=async(text:string)=>{agent.followup(createUserMessage({source:{kind:'user',rpcId:'saved-state-'+adapter.requests.length},content:[{type:'text',text}]}));await agent.whenIdle()}
 return {ctx,agent,adapter,state,send}
}
const text=(request:GenerateOptions)=>request.messages.flatMap(row=>row.content.filter(block=>block.type==='text').map(block=>block.text)).join('\n')

test('正式原稿回执后，每次原生模型请求刷新同一原稿的当前元数据，不读取正文或改历史',async t=>{
 const f=await fixture(t);await f.send('查核对原稿');assert.equal(f.adapter.requests.length,2)
 assert.match(text(f.adapter.requests[1]!),/teloa.saved-draft-state\/v1/);assert.doesNotMatch(text(f.adapter.requests[1]!),/PRIVATE_BODY/)
 const previous=f.agent.session.snapshotEvents().filter(row=>row.type==='tool/result')
 f.state.draft={...f.state.draft,status:'discarded',updatedAt:'2026-10-12T00:01:00.000Z'};const reads=f.state.reads;await f.send('现在是什么状态？')
 assert.equal(f.adapter.requests.length,3);assert.ok(f.state.reads>reads)
 assert.match(text(f.adapter.requests[2]!),/"state":"discarded"/);assert.doesNotMatch(text(f.adapter.requests[2]!),/PRIVATE_BODY/)
 assert.deepEqual(f.agent.session.snapshotEvents().filter(row=>row.type==='tool/result'),previous,'不能重写旧工具快照冒充本轮读取')
 assert.equal(f.agent.session.snapshotEvents().filter(row=>row.type==='tool/call').length,1,'动态只读事实不强迫额外模型工具调用')
})

test('没有正式原稿关联不扫描目录，当前工具不可见时不刷新已关联原稿',async t=>{
 const f=await fixture(t);f.adapter.lookup=false;await f.send('普通工作');assert.equal(f.state.reads,0);assert.doesNotMatch(text(f.adapter.requests[0]!),/teloa.saved-draft-state/)
 const other=await fixture(t);await other.send('查核对原稿');const reads=other.state.reads
 other.ctx.on('system-prompt/assemble',async(_a,_c,next)=>{const result=await next();return {...result,tools:result.tools.filter(row=>row.name!=='teloa_create_drafts')}})
 await other.send('继续普通工作');assert.equal(other.state.reads,reads,'权限过滤后的不可见读口不能被动态上下文绕过')
})

test('关联原稿读取失败明确标记当前未知，不注入正文、异常或虚构当前状态',async t=>{
 const f=await fixture(t);await f.send('查核对原稿');f.state.offline=true;await f.send('现在呢？')
 const messages=text(f.adapter.requests.at(-1)!);assert.match(messages,/"state":"currently unverified"/);assert.doesNotMatch(messages,/PRIVATE_EXCEPTION|PRIVATE_BODY/)
})

test('归属或任务策略在读取前后变化，真实Loop不将旧元数据发送给模型',async t=>{
 for(const kind of ['owner','policy','after']){const f=await fixture(t);await f.send('查核对原稿');const before=f.adapter.requests.length,reads=f.state.reads
  if(kind==='owner')f.state.owner='other';if(kind==='policy')f.state.policy={kind:'history'};if(kind==='after')f.state.revokeAfterRead=true
  await f.send('再次核对当前状态');assert.equal(f.adapter.requests.length,before,kind);assert.equal(f.state.reads,reads+(kind==='after'?1:0),kind)
 }
})

test('动态事实在系统变量和真实模型请求出口复用已存凭据脱敏，原库和历史保持原文',async t=>{
 const f=await fixture(t);await f.send('查核对原稿')
 const secret='dummy-known-credential-only-for-test',history=f.agent.session.snapshotEvents().filter(row=>row.type==='tool/result')
 f.ctx.provide('credentials',{secretValues:()=>[secret]} as never)
 f.state.draft={...f.state.draft,title:'原稿 '+secret}
 let variable=''
 f.ctx.on('system-prompt/assemble',async(_a,_c,next)=>{const result=await next();variable=result.variables.teloa_saved_draft_state??'';return result},{prepend:true})
 await f.send('核对当前状态')
 assert.ok(variable.includes('[已隐藏]'));assert.equal(variable.includes(secret),false)
 assert.equal(text(f.adapter.requests.at(-1)!).includes(secret),false)
 assert.equal(f.state.draft.title,'原稿 '+secret,'脱敏只作用于模型文本副本')
 assert.deepEqual(f.agent.session.snapshotEvents().filter(row=>row.type==='tool/result'),history)
})

test('已存凭据读取失败时不把动态事实发送给模型',async t=>{
 const f=await fixture(t);await f.send('查核对原稿');const requests=f.adapter.requests.length
 f.ctx.provide('credentials',{secretValues:()=>{throw Error('PRIVATE_LOCK_FAILURE')}} as never)
 await f.send('核对当前状态');assert.equal(f.adapter.requests.length,requests)
})

test('只接受对应原生工具的一次成功正式回执，忽略陌生schema、外来归属和重复callId',async t=>{
 for(const kind of ['schema','owner','collision','duplicate','error','user']){
  const f=await fixture(t);f.adapter.lookup=false
  const draft={...f.state.draft,...(kind==='owner'?{ownerId:'other'}:{})}
  const value={schema:kind==='schema'?'foreign.schema/v1':'teloa.page-create-draft-reference/v1',ownerId:owner,sessionId:f.agent.session.id,draft}
  const call={turn:0,step:0,callId:'artificial-reference',name:'teloa_create_drafts',arguments:'{}'}
  if(kind==='user')f.agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:JSON.stringify(value)}]}),{surfaceOp:'append'})
  else{
   f.agent.session.append('tool/call',call as never)
   if(kind==='collision')f.agent.session.append('tool/call',{...call,name:'foreign_tool'} as never)
   const result=(text:string,isError=false)=>({turn:0,step:0,message:{role:'tool',toolCallId:call.callId,content:[{type:'text',text}],...(isError?{isError:true}:{})}})
   if(kind==='duplicate')f.agent.session.append('tool/result',result('{}') as never,{surfaceOp:'append'})
   f.agent.session.append('tool/result',result(JSON.stringify(value),kind==='error') as never,{surfaceOp:'append'})
  }
  await f.send('普通工作');assert.equal(f.state.reads,0,kind);assert.doesNotMatch(text(f.adapter.requests.at(-1)!),/teloa.saved-draft-state/,kind)
 }
})
