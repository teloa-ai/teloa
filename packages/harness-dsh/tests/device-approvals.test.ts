import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setImmediate as tick} from 'node:timers/promises'
import {ApprovalService} from '@deepseek-ai/dsh-user-approval'
import {ToolCallId,createAssistantMessage} from '@deepseek-ai/dsh-llm'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {createDeviceApprovals} from '../src/device-approvals.ts'
import {readSessionEvents} from '../src/session-events.ts'

test('设备只答复原生一次审批，Web 竞争、重连、篡改与取消不产生第二次决定',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t);await ctx.plugin(ApprovalService,{policy:'ask'})
 let answer:(outcome:'allowed-once'|'rejected')=>void=()=>{},webSignal:AbortSignal|undefined
 ctx.on('approval/request',request=>new Promise(resolve=>{webSignal=request.signal;answer=resolve;request.signal?.addEventListener('abort',()=>resolve('cancelled'),{once:true})}))
 const broker=createDeviceApprovals(ctx,async()=>true,()=>true);t.after(()=>broker.close())
 const binding={id:randomUUID(),allowApprovals:true} as never
 const authorize=()=>({bindingId:'test',signal:new AbortController().signal,assertCurrent(){},release(){}})
 const one=authorize(),two=authorize()
 agent.session.append('turn/start',{turn:0})
 let serial=0
 const request=async(text='{"path":"test.txt"}',signal?:AbortSignal)=>{
  const callId=ToolCallId('device-test-'+ ++serial)
  agent.session.append('assistant/message',{turn:0,step:serial,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'tool-call',id:callId,name:'write_file',arguments:text}]}),stream:[]},{surfaceOp:'append'})
  return ctx.approval.request({agent,toolName:'write_file',callId,reason:'写入测试文件',...(signal?{signal}:{})})
 }
 let result=request();await tick();let card=await broker.open(one,binding,0)
 assert.equal(card.canDecide,true);assert.match(card.text,/test.txt/)
 assert.equal((await broker.decide(two,binding,{ticket:card.ticket,digest:card.digest,decision:'approve'})).state,'stale')
 assert.equal((await broker.decide(one,binding,{ticket:card.ticket,digest:'0'.repeat(64),decision:'approve'})).state,'stale')
 assert.equal((await broker.decide(one,binding,{ticket:card.ticket,digest:card.digest,decision:'approve'})).state,'submitted')
 assert.equal(await result,'allowed-once');assert.equal(webSignal?.aborted,true)
 assert.equal((await broker.decide(one,binding,{ticket:card.ticket,digest:card.digest,decision:'approve'})).state,'stale')
 result=request();await tick();card=await broker.open(one,binding,0);answer('rejected');assert.equal(await result,'rejected')
 assert.equal((await broker.decide(one,binding,{ticket:card.ticket,digest:card.digest,decision:'approve'})).state,'stale')
 const cancel=new AbortController();result=request('x'.repeat(4001),cancel.signal);await tick();card=await broker.open(one,binding,0);assert.equal(card.canDecide,false)
 assert.equal((await broker.decide(one,binding,{ticket:card.ticket,digest:card.digest,decision:'approve'})).state,'stale');cancel.abort();assert.equal(await result,'cancelled')
 const events=readSessionEvents(agent.session)
 assert.equal(events.filter(event=>event.type==='approval/asked').length,3)
 assert.deepEqual(events.filter(event=>event.type==='approval/decided').map(event=>event.data.outcome),['allowed-once','rejected','cancelled'])
 await assert.rejects(broker.open(one,{...binding as object,allowApprovals:false} as never,0))
})
