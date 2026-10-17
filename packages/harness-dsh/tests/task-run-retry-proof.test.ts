import test from 'node:test'
import assert from 'node:assert/strict'
import {SessionSeq,type SessionEvent} from '@deepseek-ai/dsh-session/types'
import {createUserMessage,ToolCallId} from '@deepseek-ai/dsh-llm'
import type {TaskRun} from '@teloa/backend'
import type {TaskRunPorts} from '../src/task-run-driver.ts'
import {assertSafeTaskRunRetry} from '../src/task-run-retry-proof.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {Session} from '@deepseek-ai/dsh-session'
const id='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',roleId='33333333-3333-4333-8333-333333333333'
const events:SessionEvent[]=[
 {seq:SessionSeq(0),time:1,type:'turn/start',data:{turn:0}},
 {seq:SessionSeq(1),time:2,type:'user/message',surfaceOp:'append',data:createUserMessage({source:{kind:'user',rpcId:id},content:[{type:'text',text:'Fixed input'}]})},
 {seq:SessionSeq(2),time:3,type:'turn/end',data:{turn:0,reason:{kind:'error',error:{code:'UNKNOWN',message:'Model failed before output'}}}},
]
const run:TaskRun={id,taskId,roleId,taskVersion:1,roleVersion:1,linkVersion:1,sessionId:'failed-native-run',nativeRequestId:id,state:'ended',evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'error'},stopRequestedAt:null,allowedTools:['result'],skills:[],knowledge:[],memory:[],inputText:'fixed',createdAt:'2026-10-12T00:00:00.000Z'}
const ports=(entries:readonly SessionEvent[]=events):TaskRunPorts=>({check:async()=>{},send:async()=>{throw Error('Proof must never send')},stop:async()=>{throw Error('Proof must never stop')},events:async()=>entries,backgroundState:async()=>({outstanding:false,interrupted:false}),subagentState:async()=> 'none',flowState:async()=> 'none',stopState:async()=>({running:false,settledSeq:null}),goalObservation:async()=>undefined})
const registries={subagents:[],webAccess:[]},signal=new AbortController().signal
test('真实失败轮零输出/零tool可证明，声明结果能力不代表已发生副作用',async()=>{
 await assertSafeTaskRunRetry(run,ports(),signal,registries)
})
test('active/unknown/完成/停止、已有子级或上网事实、缺少读口均不得重试',async()=>{
 for(const unsafe of [{...run,state:'active'},{...run,evidence:null},{...run,evidence:{state:'ended' as const,turn:0,messageSeq:1,endSeq:2,reason:'completed'}},{...run,stopRequestedAt:run.createdAt},{...run,flowId:id}])await assert.rejects(assertSafeTaskRunRetry(unsafe,ports(),signal,registries))
 for(const registry of [{subagents:[{}],webAccess:[]},{subagents:[],webAccess:[{}]}])await assert.rejects(assertSafeTaskRunRetry(run,ports(),signal,registry))
 const missing=ports();delete missing.backgroundState;await assert.rejects(assertSafeTaskRunRetry(run,missing,signal,registries))
 const failed=ports();failed.subagentState=async()=>{throw Error('unknown child registry')};await assert.rejects(assertSafeTaskRunRetry(run,failed,signal,registries))
})
test('tool、副作用迹象、后台未收口、迟到日志和取消均不能借旧终态重派',async()=>{
 const tool:SessionEvent={seq:SessionSeq(2),time:3,type:'tool/call',data:{turn:0,step:0,callId:ToolCallId('unsafe'),name:'write',arguments:'{}'}}
 const entries=[events[0]!,events[1]!,tool,{...events[2]!,seq:SessionSeq(3)}] as SessionEvent[]
 await assert.rejects(assertSafeTaskRunRetry({...run,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:3,reason:'error'}},ports(entries),signal,registries))
 const background=ports();background.backgroundState=async()=>({outstanding:true,interrupted:false});await assert.rejects(assertSafeTaskRunRetry(run,background,signal,registries))
 let reads=0;const late=ports();late.events=async()=>++reads===1?events:entries;await assert.rejects(assertSafeTaskRunRetry(run,late,signal,registries))
 const abort=new AbortController();abort.abort();await assert.rejects(assertSafeTaskRunRetry(run,ports(),abort.signal,registries))
})
test('owner 专用读口不替代原零副作用证明，空登记和收口后新增登记均拒绝',async()=>{
 const known=ports();known.backgroundState=async()=>({outstanding:false,interrupted:true});known.retryOwnerOnlyBackground=async()=>true
 await assertSafeTaskRunRetry(run,known,signal,registries)
 known.retryOwnerOnlyBackground=async()=>false;await assert.rejects(assertSafeTaskRunRetry(run,known,signal,registries))
 let reads=0;known.retryOwnerOnlyBackground=async()=>++reads===1
 await assert.rejects(assertSafeTaskRunRetry(run,known,signal,registries));assert.equal(reads,2)
 known.retryOwnerOnlyBackground=async()=>true
 for(const unsafe of [{...run,stopRequestedAt:run.createdAt},{...run,evidence:{state:'ended' as const,turn:0,messageSeq:1,endSeq:2,reason:'completed'}}])await assert.rejects(assertSafeTaskRunRetry(unsafe,known,signal,registries))
 const entries=await metadataFixture();Object.assign(entries[14]!,{data:{turn:1,step:0,stream:[{type:'chunk',chunk:{type:'text-delta',index:0,text:'真实已输出'}}]}})
 known.events=async()=>entries
 await assert.rejects(assertSafeTaskRunRetry({...run,evidence:{state:'ended',turn:1,messageSeq:8,endSeq:16,reason:'error'}},known,signal,registries))
})
test('官方真实AgentLoop模型在首输出前失败，原持久事件形成retry证明',async t=>{
 const native=await import('../../../tests/native-auto-review-fixture.mjs')
 const runtime=await native.createRuntime(t),agent=await runtime.create(run.sessionId),adapter:unknown=Reflect.get(runtime,'adapter')
 assert.ok(adapter!==null&&typeof adapter==='object'&&'script'in adapter&&Array.isArray(adapter.script)&&'requests'in adapter&&Array.isArray(adapter.requests))
 adapter.script.push((async function*(){throw Error('controlled model failure before first output')})())
 agent.followup(createUserMessage({source:{kind:'user',rpcId:id},content:[{type:'text',text:'Fixed input'}]}))
 await agent.whenIdle()
 const entries=readSessionEvents(agent.session),end=[...entries].reverse().find(event=>event.type==='turn/end'),message=entries.find(event=>event.type==='user/message'&&event.data.source.kind==='user'&&'rpcId'in event.data.source&&event.data.source.rpcId===id)
 assert.ok(end?.type==='turn/end'&&end.data.reason.kind==='error');assert.ok(message?.type==='user/message')
 const fixed={...run,evidence:{state:'ended' as const,turn:end.data.turn,messageSeq:message.seq,endSeq:end.seq,reason:'error'}}
 await assertSafeTaskRunRetry(fixed,ports(entries),signal,registries)
 assert.equal(adapter.requests.length,1)
 assert.equal(entries.some(event=>event.type==='tool/call'),false)
})

const metadataFixture=async():Promise<SessionEvent[]>=>JSON.parse(await readFile(new URL('./fixtures/task-run-retry-error-metadata.json',import.meta.url),'utf8'))
test('完整18事件脱敏durable形态：官方fallback标题与end-seed不是业务输出',async()=>{
 const entries=await metadataFixture(),fixed={...run,evidence:{state:'ended' as const,turn:1,messageSeq:8,endSeq:16,reason:'error'}}
 assert.equal(entries.length,18);assert.equal(entries[13]?.type,'session/title');assert.equal(entries[17]?.type,'session/end-seed')
 await assertSafeTaskRunRetry(fixed,ports(entries),signal,registries)
})
test('标题来源、原messageSeq与官方字段必须完全相符；未知元数据和业务输出仍拒绝',async()=>{
 const fixed={...run,evidence:{state:'ended' as const,turn:1,messageSeq:8,endSeq:16,reason:'error'}}
 const title={title:'Fixed task input',messageSeqs:[8],source:{kind:'fallback'}}
 for(const data of [{...title,source:{kind:'user'}},{...title,source:{kind:'provider',provider:'unknown'}},{...title,source:{kind:'fallback',extra:true}},{...title,messageSeqs:[7]},{...title,messageSeqs:[8,8]},{...title,messageSeqs:['8']},{...title,title:'\u001b[31munsafe'},{...title,extra:true}]){
  const entries=await metadataFixture();Object.assign(entries[13]!,{data});await assert.rejects(assertSafeTaskRunRetry(fixed,ports(entries),signal,registries),{code:'teloa/conflict'})
 }
 for(const data of [{inherited:false},{inherited:true},{unknown:true}]){
  const entries=await metadataFixture();Object.assign(entries[17]!,{data});await assert.rejects(assertSafeTaskRunRetry(fixed,ports(entries),signal,registries),{code:'teloa/conflict'})
 }
 const unknown=await metadataFixture();Object.assign(unknown[13]!,{type:'session/unknown-metadata'});await assert.rejects(assertSafeTaskRunRetry(fixed,ports(unknown),signal,registries))
 const output=await metadataFixture();Object.assign(output[14]!,{data:{turn:1,step:0,stream:[{type:'chunk',chunk:{type:'text-delta',index:0,text:'Partial business output'}}]}});await assert.rejects(assertSafeTaskRunRetry(fixed,ports(output),signal,registries))
 const background=ports(await metadataFixture());background.backgroundState=async()=>({outstanding:true,interrupted:false});await assert.rejects(assertSafeTaskRunRetry(fixed,background,signal,registries))
 await assert.rejects(assertSafeTaskRunRetry(fixed,ports(await metadataFixture()),signal,{subagents:[{}],webAccess:[]}))
 await assert.rejects(assertSafeTaskRunRetry({...fixed,stopRequestedAt:run.createdAt},ports(await metadataFixture()),signal,registries))
})
test('真实官方标题服务与Session种子生命周期仍允许零输出失败证明',async t=>{
 const native=await import('../../../tests/native-auto-review-fixture.mjs'),runtime=await native.createRuntime(t)
 const rootRequire=createRequire(new URL('../../../package.json',import.meta.url)),cliRequire=createRequire(rootRequire.resolve('@deepseek-ai/dsh/package.json'))
 const title=await import(cliRequire.resolve('@deepseek-ai/dsh-session-title'))
 await runtime.ctx.plugin(title.SessionTitleService,{fallbackMaxWords:8,fallbackMaxBytes:120,maxTitleBytes:240})
 const agent=await runtime.create(run.sessionId),adapter:unknown=Reflect.get(runtime,'adapter')
 assert.ok(adapter!==null&&typeof adapter==='object'&&'script'in adapter&&Array.isArray(adapter.script))
 adapter.script.push((async function*(){throw Error('controlled model failure before output')})())
 agent.followup(createUserMessage({source:{kind:'user',rpcId:id},content:[{type:'text',text:'Fixed task input'}]}));await agent.whenIdle()
 const entries=readSessionEvents(agent.session),end=[...entries].reverse().find(event=>event.type==='turn/end'),message=entries.find(event=>event.type==='user/message'&&event.data.source.kind==='user')
 assert.ok(end?.type==='turn/end'&&end.data.reason.kind==='error');assert.ok(message?.type==='user/message')
 const restored=Session.create(agent.session.id,entries,agent.session.header)
 const durable=readSessionEvents(restored)
 assert.ok(durable.some(event=>event.type==='session/title'));assert.equal(durable[durable.length-1]?.type,'session/end-seed')
 await assertSafeTaskRunRetry({...run,evidence:{state:'ended',turn:end.data.turn,messageSeq:message.seq,endSeq:end.seq,reason:'error'}},ports(durable),signal,registries)
})
