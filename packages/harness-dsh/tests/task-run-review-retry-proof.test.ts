import test from 'node:test'
import assert from 'node:assert/strict'
import {Session,SessionId,type SessionEvent} from '@deepseek-ai/dsh-session'
import {ToolCallId,createUserMessage,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import type {TaskRun,TaskRunSubagent} from '@teloa/backend'
import {nativeHotSubagentFixture} from './fixtures/native-hot-subagent.ts'
import {registerTaskSubagentTool} from '../src/task-subagent-tool.ts'
import {registerBusinessResultTools} from '../src/business-result-tools.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {observeTaskRun} from '../src/task-run-observation.ts'
import {assertSafeTaskRunRetry} from '../src/task-run-retry-proof.ts'
import type {TaskRunPorts} from '../src/task-run-driver.ts'
import type {RetryChildInspection} from '../src/task-run-review-retry-proof.ts'
const answer='37 × 23 = 37 × (20 + 3) = 740 + 111 = 851。'
const createUserMessageForSuffix=()=>createUserMessage({source:{kind:'user',rpcId:'late-request'},content:[{type:'text',text:'另一条指令'}]})
const text=(value:string):StreamChunk[]=>[{type:'block-start',index:0,blockType:'text'},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]
const call=(name:string,id:string,args:unknown):StreamChunk[]=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',name,id:ToolCallId(id),arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}]

test('官方父子Loop纯计算与真实平台拒绝写口：完整原事件可安全重试，未知副作用继续拒绝',{timeout:15000},async t=>{
 const f=await nativeHotSubagentFixture(t,'one-shot',false,true),runId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',registrations:TaskRunSubagent[]=[]
 const noBusiness=async():Promise<never>=>assert.fail('child前置身份拒绝必须先于实际业务读取/写入')
 t.after(registerBusinessResultTools(f.ctx,{owner:'owner',conversation:noBusiness,readTaskPolicy:noBusiness,readBusinessScope:noBusiness,services:noBusiness,scopeIds:noBusiness,recordObjectResult:noBusiness}))
 t.after(registerTaskSubagentTool(f.ctx,{limits:{maxDepth:1,maxPerRun:1},runId:async id=>id===f.parent.id?runId:undefined,reserve:async({reservationId})=>{registrations.push({runId,reservationId,state:'reserved',createdAt:new Date().toISOString()})},bind:async({reservationId,childSessionId,depth})=>{Object.assign(registrations.find(row=>row.reservationId===reservationId)!,{state:'started',childSessionId,depth,startedAt:new Date().toISOString()})},settle:async({childSessionId,stopReason})=>{Object.assign(registrations.find(row=>row.childSessionId===childSessionId)!,{state:'ended',stopReason,endedAt:new Date().toISOString()})},release:noBusiness,abandon:noBusiness}))
 const parent=[call('subagent_task','delegate',{description:'纯算术',prompt:'计算37×23并说明过程'}),text(answer)],child=[call('teloa_business_object_result_record','blocked-write',{result:{value:851}}),text(answer)]
 f.adapter.stream=async function*(options:GenerateOptions){this.requests.push(options);const script=options.sessionId===f.parent.id?parent.shift():child.shift();assert.ok(script);yield* script}
 await f.send(requestId,'计算37×23并说明过程')
 const events=readSessionEvents(f.parent.session),evidence=observeTaskRun(events,requestId);assert.ok(evidence.state==='ended'&&evidence.reason==='completed')
 t.diagnostic('原父会话事件类型：'+[...new Set(events.map(event=>event.type))].join(','))
 const run:TaskRun={id:runId,taskId:'33333333-3333-4333-8333-333333333333',taskVersion:1,roleId:null,roleVersion:null,executor:{kind:'owner',grantId:'44444444-4444-4444-8444-444444444444',grantVersion:1},linkVersion:1,sessionId:f.parent.id,nativeRequestId:requestId,state:'ended',evidence,stopRequestedAt:null,allowedTools:['subagent_task'],skills:[],knowledge:[],memory:[],inputText:'fixed original task',createdAt:new Date().toISOString()}
 const inspect=async(id:string,signal:AbortSignal):Promise<RetryChildInspection>=>{const handle=await f.ctx.sessionPersistence.open(SessionId(id),'read',{signal});try{return {meta:handle.header,inheritedEventCount:handle.inheritedEventCount,events:(await handle.read(undefined,undefined,{signal})).events}}finally{await handle.close()}}
 const snapshot=await inspect(registrations[0]!.childSessionId!,new AbortController().signal)
 assert.equal(snapshot.events.find(event=>event.type==='tool/result')?.data.message.isError,true)
 const ports:TaskRunPorts={check:noBusiness,send:noBusiness,stop:noBusiness,events:async()=>events,reviewSubagents:async()=>registrations,retryChildInspection:async()=>snapshot,backgroundState:async()=>({outstanding:false,interrupted:false}),retryOwnerOnlyBackground:async()=>true,subagentState:async()=> 'none',flowState:async()=> 'none',stopState:async()=>({running:false,settledSeq:evidence.endSeq}),goalObservation:async()=>undefined}
 const signal=new AbortController().signal,registry={subagents:registrations,webAccess:[]}
 await assertSafeTaskRunRetry(run,ports,signal,registry)
 assert.equal(f.adapter.requests.length,4,'证明不派发模型或再次执行child')
 await t.test('官方Session冷重建追加end-seed仍核原prefix，未知后缀不能被截掉',async()=>{
  const cold=readSessionEvents(Session.create(f.parent.id,events,f.parent.session.header)),last=cold.at(-1)!
  assert.equal(last.type,'session/end-seed');assert.equal(last.seq,evidence.endSeq+1)
  await assertSafeTaskRunRetry(run,{...ports,events:async()=>cold},signal,registry)
  for(const suffix of [
   {...last,data:{unknown:true}},
   {...last,type:'session/unknown-lifecycle'},
   {...last,time:events[evidence.endSeq]!.time-1},
   {...last,surfaceOp:'append'},
   {...last,type:'user/message',surfaceOp:'append',data:createUserMessageForSuffix()},
   {...last,type:'tool/call',data:{turn:evidence.turn,step:9,callId:ToolCallId('late-write'),name:'write',arguments:'{}'}},
  ])await assert.rejects(assertSafeTaskRunRetry(run,{...ports,events:async()=>[...events,suffix] as SessionEvent[]},signal,registry),{code:'teloa/conflict'})
  await assert.rejects(assertSafeTaskRunRetry(run,{...ports,events:async()=>[...cold,{...last,seq:last.seq+1}] as SessionEvent[]},signal,registry),{code:'teloa/conflict'})
 })
 for(const mode of ['missing-result','successful-write','unknown-tool','foreign-child','unfinished','missing-reader','late-event','pending','foreign-registry'] as const)await t.test(mode,async()=>{
  const changed=structuredClone(snapshot),bad={...ports},rows=structuredClone(registrations)
  const result=changed.events.find(event=>event.type==='tool/result'),tool=changed.events.find(event=>event.type==='tool/call')
  assert.ok(result?.type==='tool/result'&&tool?.type==='tool/call')
  if(mode==='missing-result')Reflect.set(changed,'events',changed.events.filter(event=>event!==result))
  if(mode==='successful-write')Reflect.set(result.data.message,'isError',false)
  if(mode==='unknown-tool'){
   const beforeName=tool.data.name;tool.data.name='bash'
   for(const event of changed.events)if(event.type==='assistant/message')for(const block of event.data.message.content)if(block.type==='tool-call'&&block.id===tool.data.callId){assert.equal(block.name,beforeName);Reflect.set(block,'name','bash')}
   assert.equal(result.data.message.isError,true,'声明、调用及错误回执保持一致，不能仅靠形状错配拒绝')
  }
  if(mode==='foreign-child')Reflect.set(changed.meta,'parentSession',SessionId('other-parent'))
  if(mode==='unfinished')rows[0]!.state='started'
  if(mode==='missing-reader')delete bad.retryChildInspection
  else bad.retryChildInspection=async()=>changed
  if(mode==='late-event'){let reads=0;bad.retryChildInspection=async()=>++reads===1?snapshot:changed;Reflect.set(changed,'events',[...changed.events,changed.events.at(-1)!])}
  if(mode==='pending')bad.subagentState=async()=> 'outstanding'
  if(mode==='foreign-registry')rows[0]!.runId='other-run'
  bad.reviewSubagents=async()=>rows
  await assert.rejects(assertSafeTaskRunRetry(run,bad,signal,{subagents:rows,webAccess:[]}),{code:'teloa/conflict'})
 })
 for(const bad of [{...run,stopRequestedAt:run.createdAt},{...run,executor:undefined},{...run,roleId:'55555555-5555-4555-8555-555555555555'}])await assert.rejects(assertSafeTaskRunRetry(bad as TaskRun,ports,signal,registry))
})
