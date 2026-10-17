import test from 'node:test'
import assert from 'node:assert/strict'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import type {JobId,JobOutcome,JobView} from '@deepseek-ai/dsh-jobs'
import {ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {nativeHotCausalityFixture,textAnswer,toolAnswer} from './fixtures/native-hot-causality.ts'
import {patchedNativePackage} from './fixtures/native-patched-package.ts'
import type {NativeJobCompletion} from '../src/native-work-causality.ts'
import {WorkError} from '@teloa/contract'

type Fixture=Awaited<ReturnType<typeof nativeHotCausalityFixture>>
type Admission=(candidate:NativeJobCompletion,dispatch:()=>void)=>Promise<void>
async function installJobTools(t:Parameters<typeof nativeHotCausalityFixture>[0],f:Fixture,admit:Admission=f.work.withJobCompletion){
 const sdk=await patchedNativePackage<typeof import('@deepseek-ai/dsh-tool-jobs')&{apply:(ctx:typeof f.ctx,config:import('@deepseek-ai/dsh-tool-jobs').Config,options:{requireCompletionAdmission:true;admitCompletion:Admission;observeCompletionDecision:(job:JobView,notify:boolean)=>void})=>void}>(t,{packageName:'@deepseek-ai/dsh-tool-jobs',compatBasename:'dsh-tool-jobs-0.2.1-rc.2-completion-admission'})
 await f.ctx.plugin({name:'fixed-job-tools',inject:sdk.namespace.inject,apply:(ctx:typeof f.ctx,config:import('@deepseek-ai/dsh-tool-jobs').Config)=>sdk.namespace.apply(ctx,config,{requireCompletionAdmission:true,admitCompletion:admit,observeCompletionDecision:f.work.jobCompletionDecision})},{completionDelivery:'wakeup'})
}

async function until(check:()=>boolean,label:string){const deadline=Date.now()+2000;while(!check()){assert.ok(Date.now()<deadline,label);await new Promise(resolve=>setTimeout(resolve,5))}}
for(const mode of ['completion','expired','revoked','foreign','foreign-owner','late-revoked','root-ended','cancel-wait','revoke-then-cancel'] as const)test('真实 JobTools 完成通知只承接实际工具启动的原受理根：'+mode,{timeout:10000},async t=>{
 const f=await nativeHotCausalityFixture(t)
 await f.ctx.plugin(LocalJobRegistry,{})
 let candidate:NativeJobCompletion|undefined
 await installJobTools(t,f,async(value,dispatch)=>{candidate=value;await f.work.withJobCompletion(value,dispatch)})
 let settle!:(value:JobOutcome)=>void,id!:JobId
 const start=()=>f.ctx.jobs.start({kind:'bash',label:'原生完成通知',owner:mode==='foreign-owner'?f.other.id:f.agent.id,run:()=>({done:new Promise<JobOutcome>(resolve=>{settle=resolve}),cancel:()=>settle({status:'killed'})})})
 f.adapter.scripts.push(toolAnswer,textAnswer,textAnswer)
 const reviewed:Array<ReturnType<typeof f.work.readReviewState>>=[]
 if(mode==='completion')f.ctx.on('agent/turn-stopping',()=>{
  const state=f.work.readReviewState(f.agent,'job-root-'+mode);reviewed.push(state)
  assert.throws(()=>f.work.readReviewState(f.agent,'different-rpc'),{code:'teloa/forbidden'})
  assert.throws(()=>f.work.readReviewState(f.other,'job-root-'+mode),{code:'teloa/forbidden'})
  if(candidate){
   const forged=createUserMessage({source:candidate.message.source,content:candidate.message.content})
   assert.throws(()=>f.agent.followup(forged),{code:'teloa/forbidden'},'同kind同正文没有真实受理回执仍拒绝')
   assert.deepEqual(f.work.readReviewState(f.agent,'job-root-'+mode),state,'拒绝伪造不消费或扩大原证明')
  }
 })
 f.setToolAction(async()=>{if(mode!=='foreign'&&mode!=='foreign-owner')id=start()})
 await f.send('job-root-'+mode);await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,2)
 if(mode==='foreign'||mode==='foreign-owner')id=start()
 if(mode==='revoked')f.rights.revoked=true
 if(mode==='expired')f.rights.valid=false
 let release:()=>void=()=>{},waiting=false
 if(mode==='late-revoked'||mode==='root-ended'||mode==='cancel-wait'||mode==='revoke-then-cancel')f.ctx.provide('teloaResidentInputAdmission',{acquire:async()=>{
  waiting=true;await new Promise<void>(resolve=>{release=resolve})
  if(mode==='root-ended')throw new WorkError('teloa/forbidden','原工作已结束')
  return {assertCurrent(){if(f.rights.revoked)throw new WorkError('teloa/forbidden','原许可已撤销')}}
 }})
 settle({status:'completed',result:'实际工作已完成'})
 await until(()=>f.ctx.jobs.get(id,mode==='foreign-owner'?f.other.id:f.agent.id).status==='completed','实际 job 必须先完成')
 if(mode==='late-revoked'||mode==='root-ended'||mode==='cancel-wait'||mode==='revoke-then-cancel'){
  await until(()=>waiting,'实际完成通知必须等待居民准入复核')
  assert.equal(f.work.hasPendingJobCompletion(f.agent.id),true,'异步复核期间必须保留准确通知待办')
  if(mode==='late-revoked')f.rights.revoked=true
  if(mode==='cancel-wait')f.work.cancelJobCompletions(f.agent.id)
  if(mode==='revoke-then-cancel'){
   f.rights.revoked=true;assert.equal(f.work.hasPendingJobCompletion(f.agent.id),false)
   f.work.cancelJobCompletions(f.agent.id);assert.equal(f.work.hasCancelledJobCompletion(f.agent.id),true,'权限否决先消费了通知时，真实停止仍不能遗失后台取消事实')
  }
  release()
 }
 if(mode==='completion'||mode==='expired'){
  await until(()=>f.events().some(event=>event.type==='user/message'&&event.data.source.kind==='tool-jobs'),'原受理根必须收到真实完成通知')
  await f.agent.whenIdle();assert.equal(f.adapter.requests.length,3)
  assert.equal(f.events().filter(event=>event.type==='user/message'&&event.data.source.kind==='tool-jobs').length,1)
  assert.ok(candidate)
  if(mode==='completion'){
   const state=reviewed.at(-1);assert.ok(state);assert.deepEqual(state.continuationMessageIds,[candidate.message.id]);assert.ok(Object.isFrozen(state)&&Object.isFrozen(state.continuationMessageIds))
   assert.equal(state.pendingJobCompletion,false);assert.equal(state.pendingInput,false)
   assert.throws(()=>f.work.readReviewState(f.other,'job-root-'+mode),{code:'teloa/forbidden'})
   assert.throws(()=>f.work.readReviewState(f.agent,'different-rpc'),{code:'teloa/forbidden'})
  }
  await assert.rejects(f.work.withJobCompletion(candidate,()=>{throw Error('完成通知不得重复发布')}),{code:'teloa/forbidden'})
 }else{
  await new Promise(resolve=>setTimeout(resolve,30))
  assert.equal(f.events().filter(event=>event.type==='user/message'&&event.data.source.kind==='tool-jobs').length,0)
  assert.equal(f.adapter.requests.length,2)
  assert.equal(f.events(f.other).filter(event=>event.type==='user/message'&&event.data.source.kind==='tool-jobs').length,0)
 }
 assert.equal(f.work.hasPendingJobCompletion(f.agent.id),false,'受理/拒绝/撤销之后必须清除完成通知待办')
})

for(const collect of ['job_output','job_kill'] as const)test('官方 '+collect+' 已收集/取消的实际 Job 不留下完成通知待办',{timeout:10000},async t=>{
 const f=await nativeHotCausalityFixture(t);await f.ctx.plugin(LocalJobRegistry,{})
 let notices=0;await installJobTools(t,f,async(value,dispatch)=>{notices++;await f.work.withJobCompletion(value,dispatch)})
 let settle!:(value:JobOutcome)=>void,id!:JobId
 f.adapter.scripts.push(toolAnswer,textAnswer)
 f.setToolAction(async exec=>{
  id=f.ctx.jobs.start({kind:'bash',label:'原生工具真实收集',owner:f.agent.id,run:()=>({done:new Promise<JobOutcome>(resolve=>{settle=resolve}),cancel:()=>settle({status:'killed'})})})
  if(collect==='job_output')setTimeout(()=>settle({status:'completed',result:'本人已实际收集结果'}),10)
  const result=await f.ctx.tools.execute({agent:f.agent,parent:exec.token,rootCallId:exec.rootCallId,callId:ToolCallId('collect-'+collect),name:collect,arguments:{job_id:id,...(collect==='job_output'?{wait:true}:{})},signal:exec.signal})
  assert.equal(result.isError,false,JSON.stringify(result))
 })
 await f.send('collected-'+collect);await f.agent.whenIdle()
 await until(()=>['completed','killed'].includes(f.ctx.jobs.get(id,f.agent.id).status),'Job 必须真正终止')
 assert.equal(notices,0,'官方抑制通知的决策不应调用发布准入')
 assert.equal(f.work.hasPendingJobCompletion(f.agent.id),false,'官方已实际收集或取消，不可永久等待不存在的通知')
 assert.equal(f.events().filter(event=>event.type==='user/message'&&event.data.source.kind==='tool-jobs').length,0)
 assert.equal(f.adapter.requests.length,2)
})
