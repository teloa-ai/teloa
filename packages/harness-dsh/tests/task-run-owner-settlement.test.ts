import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {TaskRun,TaskRunRuntimeLink} from '@teloa/backend'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {TaskRunPorts} from '../src/task-run-driver.ts'

const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
const runtimeId='current-runtime'
function fixture(){
 const run:TaskRun={id:'11111111-1111-4111-8111-111111111111',taskId:'33333333-3333-4333-8333-333333333333',roleId:'44444444-4444-4444-8444-444444444444',taskVersion:1,roleVersion:1,linkVersion:1,sessionId:'owner-settlement',nativeRequestId:'22222222-2222-4222-8222-222222222222',inputText:'fixed original input',state:'ended',stopRequestedAt:null,allowedTools:['any_registered_tool'],skills:[],knowledge:[],memory:[],createdAt:new Date(1000).toISOString(),evidence:{state:'ended',turn:0,messageSeq:1,endSeq:4,reason:'completed'}}
 const events=[{seq:0,time:1000,type:'turn/start',data:{turn:0}},{seq:1,time:1001,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:run.nativeRequestId}}},{seq:2,time:1002,type:'tool/call',data:{turn:0,step:0,callId:'original-call',name:'any_registered_tool',arguments:'{}'}},{seq:3,time:1003,type:'tool/result',data:{turn:0,step:0,message:{toolCallId:'original-call',isError:false}}},{seq:4,time:1004,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}}] as SessionEvent[]
 const link:TaskRunRuntimeLink={runId:run.id,kind:'job',nativeId:'owner:'+runtimeId+':'+run.sessionId,sessionId:run.sessionId,payload:{record:'owner',runtimeId,requestId:run.nativeRequestId}}
 const state={agent:{status:'idle',id:run.sessionId,session:{inheritedEventCount:0},inbox:{nextTurn:[] as unknown[],nextStep:[] as unknown[]}},jobs:[] as Array<{owner:string;id:string;status:string}>,links:[link],events,background:{outstanding:false,interrupted:false},children:'none' as 'none'|'outstanding',flow:'none' as 'none'|'outstanding',pending:false,cancelled:false,reads:0,afterRead:()=>{}}
 const ctx={agents:{get:()=>state.agent},jobs:{list:()=>state.jobs}} as unknown as Context
 const ports:TaskRunPorts={check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>{state.reads++;state.afterRead();return structuredClone(state.events)},backgroundState:async()=>state.background,subagentState:async()=>state.children,flowState:async()=>state.flow}
 const options={runtimeId,ports,listLinks:async()=>structuredClone(state.links),nativeInput:{hasPendingJobCompletion:()=>state.pending,hasCancelledJobCompletion:()=>state.cancelled},now:()=>new Date(2000).toISOString()}
 return {run,state,ctx,options}
}
// 旧实现没有宿主终态证明，沿原行为返回无回执；正例必须因实际缺少回执变红。
const module=await import('../src/task-run-owner-settlement.ts').catch(error=>{if(error.code==='ERR_MODULE_NOT_FOUND'&&error.url?.endsWith('/task-run-owner-settlement.ts'))return undefined;throw error})
const produce:NonNullable<typeof module>['taskRunOwnerSettlement']=module?.taskRunOwnerSettlement??(async()=>null)

test('同宿主非零工具运行在原生终态和实际活动两次稳定后生成固定owner证明',async()=>{
 const f=fixture(),proof=await produce(f.ctx,f.run,f.options)
 assert.deepEqual(proof,{schema:'teloa.task-run-owner-settlement/v1',runId:f.run.id,nativeId:f.state.links[0]!.nativeId,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,inputSha256:sha(f.run.inputText),evidence:f.run.evidence,prefixLength:5,prefixSha256:sha(JSON.stringify(f.state.events)),observedAt:f.options.now()})
 assert.equal(f.state.reads,2,'证明必须在实际活动检查前后重读完整持久日志')
 f.run.allowedTools=['completely_different_tool'];assert.ok(await produce(f.ctx,f.run,f.options),'按真实活动结算，不按工具名白名单')
})
test('旧runtime、错父会话/原请求、多个owner及缺失宿主端口均不签新证明',async()=>{
 for(const change of [
  (f:ReturnType<typeof fixture>)=>{f.options.runtimeId='new-host'},
  (f:ReturnType<typeof fixture>)=>{f.state.links[0]={...f.state.links[0]!,sessionId:'foreign'}},
  (f:ReturnType<typeof fixture>)=>{f.state.links[0]={...f.state.links[0]!,payload:{record:'owner',runtimeId,requestId:'foreign'}}},
  (f:ReturnType<typeof fixture>)=>{f.state.links.push(f.state.links[0]!)},
  (f:ReturnType<typeof fixture>)=>{delete f.options.ports.backgroundState},
  (f:ReturnType<typeof fixture>)=>{delete f.options.ports.subagentState},
  (f:ReturnType<typeof fixture>)=>{delete f.options.ports.flowState},
 ]){const f=fixture();change(f);assert.equal(await produce(f.ctx,f.run,f.options),null)}
})
test('真实agent/队列/job通知/子级/流程/未知后台仍阻止owner结算',async()=>{
 for(const change of [
  (f:ReturnType<typeof fixture>)=>{f.state.agent.status='running'},
  (f:ReturnType<typeof fixture>)=>{f.state.agent.inbox.nextTurn.push({})},
  (f:ReturnType<typeof fixture>)=>{f.state.agent.inbox.nextStep.push({})},
  (f:ReturnType<typeof fixture>)=>{f.state.jobs.push({owner:f.run.sessionId,id:'live',status:'running'})},
  (f:ReturnType<typeof fixture>)=>{f.state.pending=true},
  (f:ReturnType<typeof fixture>)=>{f.state.cancelled=true},
  (f:ReturnType<typeof fixture>)=>{f.state.background.outstanding=true},
  (f:ReturnType<typeof fixture>)=>{f.state.background.interrupted=true},
  (f:ReturnType<typeof fixture>)=>{f.state.children='outstanding'},
  (f:ReturnType<typeof fixture>)=>{f.state.flow='outstanding'},
 ]){const f=fixture();change(f);assert.equal(await produce(f.ctx,f.run,f.options),null)}
})
test('损坏/跨请求/缺工具结果/区间外来输入不冒充固定原生终态',async()=>{
 for(const change of [
  (f:ReturnType<typeof fixture>)=>{f.run.state='active'},
  (f:ReturnType<typeof fixture>)=>{f.run.nativeRequestId='foreign'},
  (f:ReturnType<typeof fixture>)=>{f.state.agent.session.inheritedEventCount=2},
  (f:ReturnType<typeof fixture>)=>{f.state.events[4]={...f.state.events[4]!,seq:8} as SessionEvent},
  (f:ReturnType<typeof fixture>)=>{f.state.events[3]={...f.state.events[3]!,type:'step/end',data:{}} as SessionEvent},
  (f:ReturnType<typeof fixture>)=>{f.state.events[3]={...f.state.events[3]!,data:{message:{toolCallId:'foreign'}}} as SessionEvent},
  (f:ReturnType<typeof fixture>)=>{f.state.events[2]={...f.state.events[2]!,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'foreign'}}} as SessionEvent},
 ]){const f=fixture();change(f);assert.equal(await produce(f.ctx,f.run,f.options),null)}
})
test('二次读取期间新活动、队列或日志变化一律不落旧证明',async()=>{
 for(const change of [
  (f:ReturnType<typeof fixture>)=>{f.state.agent.inbox.nextTurn.push({})},
  (f:ReturnType<typeof fixture>)=>{f.state.jobs.push({owner:f.run.sessionId,id:'late',status:'running'})},
  (f:ReturnType<typeof fixture>)=>{f.state.events.push({seq:5,time:1005,type:'turn/start',data:{turn:1}} as SessionEvent)},
 ]){const f=fixture();f.state.afterRead=()=>{if(f.state.reads===2)change(f)};assert.equal(await produce(f.ctx,f.run,f.options),null)}
})
