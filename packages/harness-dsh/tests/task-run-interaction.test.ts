import test from 'node:test'
import assert from 'node:assert/strict'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {ToolCallId,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {taskRunInteractionRequest} from '../src/task-run-interaction.ts'
import {observeTaskRun} from '../src/task-run-observation.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import {loopWorkFixture,loopText} from './fixtures/native-loop-work-admission.ts'
import {dshTaskRunPorts} from '../src/task-run-dsh.ts'
import type {TaskRun} from '@teloa/backend'
import {installModelSelection} from '@deepseek-ai/dsh-agent'
import {assertTaskRunCompletedProof} from '../src/task-run-completed-proof.ts'

test('真实Loop追问使用新的受理身份，原范围与当前参数范围取交集，旧报告保持固定',async t=>{
 for(const target of ['a','b','outside'])await t.test(target,async sub=>{
  const f=await loopWorkFixture(sub,true)
  f.adapter.scripts.push(loopText);await f.send()
  const prefix=[...readSessionEvents(f.agent.session)],evidence=observeTaskRun(prefix,'loop-input')
  assert.ok(evidence.state==='ended')
  const run={nativeRequestId:'loop-input',state:'ended' as const,evidence,stopRequestedAt:null}
  const fixed={...run,id:'fixed-run',sessionId:String(f.agent.id),allowedTools:[]}
  assertTaskRunCompletedProof(fixed,prefix,[],[],{binding:null,continuations:[]})
  assert.throws(()=>assertTaskRunCompletedProof({...fixed,nativeRequestId:'foreign-input'},prefix,[],[],{binding:null,continuations:[]}),{code:'teloa/conflict'})
  let bodies=0
  f.ctx.tools.register(defineTool({name:'scope_probe',description:'合成范围核对',parameters:{target:{type:'string',required:true}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=>{bodies++;return '已核对'}}))
  registerTaskToolGuard(f.ctx,async()=>({allowedTools:['scope_probe'],nativeRequestId:taskRunInteractionRequest(readSessionEvents(f.agent.session),run)??'not-authorized',argumentRules:[{name:'scope_probe',allowed:[{target:'a'},{target:'b'}]}],currentArgumentRules:[{name:'scope_probe',allowed:[{target:'a'},{target:'outside'}]}]}))
  const call:readonly StreamChunk[]=[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',name:'scope_probe',id:ToolCallId('followup-probe'),arguments:JSON.stringify({target})}},{type:'finish',reason:{kind:'tool-calls'}}]
  f.adapter.scripts.push(call,loopText)
  let request:string|undefined
  f.ctx.on('agent/pre-step',async(_payload,next)=>{const result=await next();request=taskRunInteractionRequest(readSessionEvents(f.agent.session),run)??request;return result})
  await f.send('new-followup')
  assert.equal(request,'new-followup')
  assert.equal(bodies,target==='a'?1:0)
  assert.equal(readTaskRunGroupResult(readSessionEvents(f.agent.session).slice(0,evidence.endSeq+1),'loop-input'),'done')
  assert.deepEqual(run.evidence,evidence)
  assert.equal(f.adapter.requests.length,3)
 })
})

test('完成后首次开放独立交互退役旧固定模型，原报告不变且重复开放不打断新输入',async t=>{
 const f=await loopWorkFixture(t,true),sessionId=String(f.agent.id),signal=new AbortController().signal
 // 与官方Controller相同的本人选模装配；仅AgentOptions不会覆盖已持久化请求头。
 const releaseSelection=installModelSelection(f.agent.ctx,{current:{provider:'loop-test',model:'loop-model'},assembled:undefined})
 t.after(releaseSelection)
 f.ctx.provide('sessionController',{resolveAgent:async()=>({agent:f.agent})} as never)
 f.ctx.provide('attachments',{admitPromptContent:async(content:unknown)=>structuredClone(content)} as never)
 const ports=dshTaskRunPorts(f.ctx,'owner',async()=>({ownerId:'owner',sessionId,status:'ready'}))
 const run:TaskRun={id:'run',roleId:null,roleVersion:null,state:'prepared',evidence:null,stopRequestedAt:null,skills:[],knowledge:[],memory:[],createdAt:'2026-11-04T00:00:00.000Z',allowedTools:[],taskId:'task',taskVersion:3,linkVersion:2,sessionId,nativeRequestId:'fixed-task-request',inputText:'固定目标',modelPolicy:{primary:{provider:'loop-test',model:'task-model'}}}
 f.adapter.scripts.push(loopText)
 await ports.send(run,signal,{taskId:run.taskId,taskVersion:3,linkVersion:2,sessionId,scope:'general'})
 await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,1)
 assert.equal(f.adapter.requests[0]!.model,'task-model')
 const prefix=[...readSessionEvents(f.agent.session)],evidence=observeTaskRun(prefix,run.nativeRequestId)
 assert.ok(evidence.state==='ended'&&evidence.reason==='completed')
 const completed:TaskRun={...run,state:'ended',evidence}
 await ports.openInteraction!(completed,signal)
 f.adapter.scripts.push(loopText)
 await f.send('new-independent-request')
 await ports.openInteraction!(completed,signal)
 assert.equal(f.adapter.requests.length,2)
 assert.equal(f.adapter.requests[1]!.model,'loop-model')
 assert.deepEqual(readSessionEvents(f.agent.session).slice(0,prefix.length),prefix)
 assert.equal(readTaskRunGroupResult(prefix,run.nativeRequestId),'done')
})
