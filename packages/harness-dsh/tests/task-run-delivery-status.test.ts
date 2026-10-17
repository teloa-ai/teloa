import test from 'node:test'
import assert from 'node:assert/strict'
import type {TaskRun,TaskRunService} from '@teloa/backend'
import {createTaskRunHandler} from '../src/task-runs.ts'
import {createTaskRunDeliveryReader} from '../src/task-run-delivery-status.ts'
import {WorkError} from '@teloa/contract'
import {SessionSeq,SessionId,SessionStore,Session,type SessionEvent} from '@deepseek-ai/dsh-session'
import {createAssistantMessage,createUserMessage,LlmAdapter,LlmRuntime,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {observeTaskRun} from '../src/task-run-observation.ts'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {createReviewSourceCatalog,deliveryReviewToolName,leaseTaskDeliveryReview} from '../src/task-delivery-review.ts'
import {readSessionEvents} from '../src/session-events.ts'

test('正式Run列表附带只读交付检查，不执行核对或发布',async()=>{
 const run={id:'run',taskId:'task',state:'ended'} as unknown as TaskRun,calls:string[]=[]
 const service={list:async()=>[run]} as unknown as TaskRunService
 const delivery={read:async(owner:string,current:TaskRun)=>{assert.equal(owner,'owner');assert.equal(current,run);calls.push('delivery-read');return {state:'review-required' as const}}}
 const handler=createTaskRunHandler('owner',async()=>service,{check:async()=>assert.fail('只读不准入'),send:async()=>assert.fail('只读不发送'),stop:async()=>assert.fail('只读不停Run'),events:async()=>assert.fail('handler不自行读日志')},undefined,undefined,undefined,undefined,undefined,undefined,delivery)
 assert.deepEqual(await handler('task-runs/list',{taskId:'task'},new AbortController().signal),[{...run,deliveryCheck:{state:'review-required'}}])
 assert.deepEqual(calls,['delivery-read']);assert.equal('deliveryCheck'in run,false)
})

const native:SessionEvent[]=[
 {type:'turn/start',seq:SessionSeq(0),time:0,data:{turn:0}},
 {type:'user/message',seq:SessionSeq(1),time:1,surfaceOp:'append',data:createUserMessage({source:{kind:'user',rpcId:'rpc'},content:[{type:'text',text:'原材料'}]})},
 {type:'assistant/message',seq:SessionSeq(2),time:2,surfaceOp:'append',data:{turn:0,step:0,message:createAssistantMessage({source:{provider:'script',model:'m'},content:[{type:'text',text:'未经完整复核的普通稿'}]}),stream:[]}},
 {type:'turn/end',seq:SessionSeq(3),time:3,data:{turn:0,reason:{kind:'completed'}}},
]
const run={id:'run',taskId:'task',sessionId:'owner-session',nativeRequestId:'rpc',executor:{kind:'owner',grantId:'grant',grantVersion:1},state:'ended',evidence:observeTaskRun(native,'rpc'),stopRequestedAt:null} as TaskRun

test('精确已存回执优先，不读冷日志，不把保存等同本人认可',async()=>{
 const reader=createTaskRunDeliveryReader({receipt:async(owner,current)=>{assert.equal(owner,'owner');assert.equal(current,run);return true},events:async()=>assert.fail('原回执已证明保存，不读日志')})
 assert.deepEqual(await reader.read('owner',run),{state:'saved'})
 assert.equal('deliveryCheck'in run,false)
})
test('完整原生轮缺正式review才显示缺复核；读取缺失或证据边界不符为unknown',async()=>{
 const reader=createTaskRunDeliveryReader({receipt:async()=>false,events:async()=>native})
 assert.deepEqual(await reader.read('owner',run),{state:'review-required'})
 for(const code of ['teloa/session-unavailable','teloa/storage-corrupt'] as const){
  assert.deepEqual(await createTaskRunDeliveryReader({receipt:async()=>false,events:async()=>{throw new WorkError(code,'仅测试读取失败')}}).read('owner',run),{state:'unknown'})
 }
 assert.deepEqual(await reader.read('owner',{...run,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:9,reason:'completed'}}),{state:'unknown'})
 const error=new TypeError('programming bug')
 await assert.rejects(createTaskRunDeliveryReader({receipt:async()=>{throw error},events:async()=>native}).read('owner',run),value=>value===error)
 await assert.rejects(createTaskRunDeliveryReader({receipt:async()=>{throw new WorkError('teloa/forbidden','本人不一致')},events:async()=>native}).read('owner',run),{code:'teloa/forbidden'})
})
test('非owner、未完成或已停止不读交付证明，不因Task状态猜原因',async()=>{
 const reader=createTaskRunDeliveryReader({receipt:async()=>assert.fail('非适用状态不读'),events:async()=>assert.fail('非适用状态不读')})
 for(const changed of [{...run,executor:undefined},{...run,state:'active'},{...run,stopRequestedAt:'2026-10-17T00:00:00.000Z'},{...run,evidence:{...run.evidence,reason:'error'}}])assert.equal(await reader.read('owner',changed as TaskRun),undefined)
})
test('多轮读口仅核持久endSeq内原证据，并将可信continuation透给正式reader',async()=>{
 let passed:readonly SessionEvent[]|undefined
 const later={...native[0]!,seq:SessionSeq(4),time:4} as SessionEvent
 const reader=createTaskRunDeliveryReader({receipt:async()=>false,events:async()=>[...native,later],continuations:async(_run,events)=>{passed=events;return new Set<string>()}})
 assert.deepEqual(await reader.read('owner',run),{state:'review-required'});assert.deepEqual(passed,native)
})
test('真实SDK accepted冷读不冒已保存，仍须精确artifact回执',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 for(const plugin of [LlmRuntime,SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const reply=(value:string|unknown):StreamChunk[]=>typeof value==='string'?[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]:[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id:'delivery-'+(++call),name:deliveryReviewToolName,arguments:value}},{type:'finish',reason:{kind:'tool-calls'}}] as unknown as StreamChunk[]
 let call=0,requests=0
 const replies=[reply('原材料确认的正文'),reply({phase:'revise',issues:[]}),reply({phase:'verify',verdict:'accept',checks:(['goal',1,2,3,4,5,6,7,8] as const).map(id=>({id,status:'pass'})),changeChecks:[],findings:[]})]
 class Adapter extends LlmAdapter{async *stream(){requests++;for(const chunk of replies.shift()??[])yield chunk}}
 ctx.llm.registerAdapter(['script'],new Adapter())
 const {agent}=await ctx.agents.create({sessionId:SessionId(run.sessionId),agentOptions:{provider:'script',model:'m'}})
 const goal='仅按原材料核对正文。'
 leaseTaskDeliveryReview(agent,{runId:run.id,requestId:run.nativeRequestId,trace:()=>{},material:{goal,methods:[],inputs:{knowledge:0,group:false,context:false},catalog:createReviewSourceCatalog([{id:'goal',kind:'goal',title:'原目标',text:goal,origin:{field:'inputText',pointer:'/task/goal'}}])},publish:async message=>{agent.inject(message)}})
 agent.followup(createUserMessage({source:{kind:'user',rpcId:run.nativeRequestId},content:[{type:'text',text:goal}]}));await agent.whenIdle()
 assert.equal(requests,3)
 const cold=readSessionEvents(Session.create(agent.id,JSON.parse(JSON.stringify(readSessionEvents(agent.session))),agent.session.header)),evidence=observeTaskRun(cold,run.nativeRequestId)
 assert.ok(evidence.state==='ended');const fixed={...run,evidence}
 const reader=createTaskRunDeliveryReader({receipt:async()=>false,events:async()=>cold})
 assert.deepEqual(await reader.read('owner',fixed),{state:'unknown'},'通过完整复核不等于成果已存')
 assert.deepEqual(await reader.read('owner',{...fixed,id:'foreign-run'}),{state:'review-required'},'其他Run的回执不可借用')
 assert.equal(requests,3,'纯读不增加模型步骤')
})
