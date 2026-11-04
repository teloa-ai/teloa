import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {ToolCallId,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionSeq,type SessionEvent} from '@deepseek-ai/dsh-session'
import {inspectNativeTurnContinuation,type NativeTurnCheckpoint} from '../src/native-turn-continuation.ts'
import {nativeInputIdentity} from '../src/native-input-access.ts'
import type {NativeCheckpointSnapshot} from '../src/native-input-checkpoint.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {loopWorkFixture} from './fixtures/native-loop-work-admission.ts'

async function checkpointAfterKnownTool(t:TestContext,cause?:'disposed'|'user',toolName='resume_probe'){
 const f=await loopWorkFixture(t,true)
 f.ctx.tools.register(defineTool({name:toolName,description:'无外部效果的合成取证',parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:async()=> '原取证回执'}))
 f.adapter.scripts.push([{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',id:ToolCallId('probe'),name:toolName,arguments:'{}'}},{type:'finish',reason:{kind:'tool-calls'}}] as readonly StreamChunk[])
 let snapshot:NativeCheckpointSnapshot|undefined
 f.ctx.on('agent/pre-step',async(_payload,next)=>{
  if(f.adapter.requests.length){snapshot={header:f.agent.session.header,events:[...readSessionEvents(f.agent.session)],inheritedEventCount:Number(f.agent.session.inheritedEventCount)};if(cause){f.agent.cancel({kind:cause},{keepInbox:true});return next()}throw Error('在下一模型请求前截取中断前缀')}
  return next()
 })
 await f.send();assert.ok(snapshot)
 if(cause)snapshot={header:f.agent.session.header,events:[...readSessionEvents(f.agent.session)],inheritedEventCount:Number(f.agent.session.inheritedEventCount)}
 const original=snapshot.events.find((event):event is Extract<SessionEvent,{type:'user/message'}>=>event.type==='user/message'&&event.data.source.kind==='user');assert.ok(original)
 const identity=nativeInputIdentity(original.data,'loop-input'),checkpoint:NativeTurnCheckpoint={sessionId:f.agent.id,hostGeneration:1,phase:cause?'turn-end':'step-end',logCut:snapshot.events.length-1,logSha256:createHash('sha256').update(JSON.stringify(snapshot.events)).digest('hex'),roots:[{sessionId:f.agent.id,messageId:original.data.id,nativeRequestId:'loop-input',payloadSha256:identity.payloadSha256}]}
 return {f,snapshot,checkpoint}
}

test('真实Loop保留已完成工具回执，原受理根与完整检查点一致才产生续作数据候选',async t=>{
 const {f,snapshot,checkpoint}=await checkpointAfterKnownTool(t),read=inspectNativeTurnContinuation(snapshot,checkpoint,2)
 assert.equal(read.state,'ready',JSON.stringify(read))
 assert.equal(f.adapter.requests.length,1,'检查器不启动模型或重发工具')
 assert.deepEqual(snapshot.events.filter(event=>event.type==='tool/result').map(event=>event.data.message.content),[[{type:'text',text:'原取证回执'}]])
 if(read.state==='ready'){assert.equal(read.candidate.requestId,'loop-input');assert.equal(read.candidate.logSha256,checkpoint.logSha256)}
})

test('未知工具结果、篡改前缀、同宿主与缺少真实Inbox受理均保留待核对',async t=>{
 const {snapshot,checkpoint}=await checkpointAfterKnownTool(t)
 assert.equal(inspectNativeTurnContinuation(snapshot,checkpoint,1).state,'held')
 assert.equal(inspectNativeTurnContinuation(snapshot,{...checkpoint,logSha256:'0'.repeat(64)},2).state,'held')
 for(const kind of ['missing-result','error-result','missing-inbox'] as const){
  const events=structuredClone(snapshot.events).filter(event=>kind==='missing-result'?event.type!=='tool/result':kind==='missing-inbox'?event.type!=='agent/inbox/spliced':true)
  if(kind==='error-result'){const index=events.findIndex(event=>event.type==='tool/result'),result=events[index];assert.ok(result?.type==='tool/result');events[index]={...result,data:{...result.data,message:{...result.data.message,isError:true}}}}
  events.forEach((event,index)=>{event.seq=SessionSeq(index)})
  const current={...checkpoint,logCut:events.length-1,logSha256:createHash('sha256').update(JSON.stringify(events)).digest('hex')}
  assert.equal(inspectNativeTurnContinuation({...snapshot,events},current,2).state,'held',kind)
 }
})

test('官方disposed与本人取消分开：程序退役保留已知回执候选，本人取消不恢复',async t=>{
 for(const cause of ['disposed','user'] as const)await t.test(cause,async sub=>{
  const {f,snapshot,checkpoint}=await checkpointAfterKnownTool(sub,cause),terminal=snapshot.events.at(-1)
  assert.ok(terminal?.type==='turn/end'&&terminal.data.reason.kind==='aborted');assert.equal(terminal.data.reason.reason.kind,cause)
  assert.equal(inspectNativeTurnContinuation(snapshot,checkpoint,2).state,cause==='disposed'?'ready':'held')
  assert.equal(f.adapter.requests.length,1)
 })
})

test('可能启动后台的工具必须有覆盖原返回的同宿主结清事实，不能用新宿主空目录替代',async t=>{
 const {snapshot,checkpoint}=await checkpointAfterKnownTool(t,undefined,'bash'),runtimeId='original-physical-host'
 assert.equal(inspectNativeTurnContinuation(snapshot,checkpoint,2).state,'held')
 assert.equal(inspectNativeTurnContinuation(snapshot,{...checkpoint,runtimeId,background:{runtimeId,unsettledJobIds:['still-running']}},2).state,'held')
 assert.equal(inspectNativeTurnContinuation(snapshot,{...checkpoint,runtimeId,background:{runtimeId:'replacement-host',unsettledJobIds:[]}},2).state,'held')
 assert.equal(inspectNativeTurnContinuation(snapshot,{...checkpoint,runtimeId,background:{runtimeId,unsettledJobIds:[]}},2).state,'ready')
})
