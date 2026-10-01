import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError} from '@teloa/contract'
import type {TaskRun} from '@teloa/backend'
import {PlanDshDispatcher,type PlanDshDispatchPorts} from '../src/plan-dispatch-dsh.ts'

const claimId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',roleId='33333333-3333-4333-8333-333333333333',runId='44444444-4444-4444-8444-444444444444'
const job={claimId,taskId,taskCreatedVersion:1 as const,taskTitle:'每日资料核对',roleId,roleVersion:3}
const taskRun=(state:string):TaskRun=>({id:runId,taskId,roleId,taskVersion:1,roleVersion:3,linkVersion:state==='configuration_failed'?0:1,sessionId:'task-run-'+claimId,nativeRequestId:'55555555-5555-4555-8555-555555555555',state,evidence:null,stopRequestedAt:null,...(state==='configuration_failed'?{agentPresetId:'security-analyst',configurationError:{code:'teloa/preset-unavailable',stage:'session-create',message:'不可用'}}:{}),allowedTools:[],skills:[],knowledge:[],memory:[],inputText:'fixed',createdAt:'2026-09-12T00:00:00.000Z'})

function fixture(){
 const calls:{prepare:unknown[];start:number;reconcile:number}={prepare:[],start:0,reconcile:0};let state='prepared'
 const ports:PlanDshDispatchPorts={
  prepare:async(owner,input)=>{calls.prepare.push([owner,input]);return taskRun(state)},
  driver:{start:async()=>{calls.start++;state='accepted';return taskRun(state)},reconcile:async()=>{calls.reconcile++;state='active';return taskRun(state)}},
 }
 return {dispatcher:new PlanDshDispatcher(ports),ports,calls,setState:(value:string)=>{state=value}}
}

test('计划只传 claim 与任务身份复用受信任一键准备，再启动同一次执行',async()=>{
 const f=fixture(),result=await f.dispatcher.dispatch('owner',job,new AbortController().signal)
 assert.equal(result.run.state,'active')
 assert.deepEqual(f.calls.prepare,[['owner',{requestId:claimId,taskId,expectedTaskVersion:1}]])
 assert.equal(f.calls.start,1);assert.equal(f.calls.reconcile,1)
})

test('准备回包丢失后由同一 claim 恢复，不在计划层重新构造会话或岗位配置',async()=>{
 const f=fixture(),signal=new AbortController().signal,original=f.ports.prepare,requests:unknown[]=[];let failed=false
 f.ports.prepare=async(owner,input,current)=>{requests.push(input);const run=await original(owner,input,current);if(!failed){failed=true;throw Error('准备已落盘但回执丢失')}return run}
 await assert.rejects(f.dispatcher.dispatch('owner',job,signal))
 assert.equal((await f.dispatcher.dispatch('owner',job,signal)).run.state,'active')
 assert.deepEqual(requests,[{requestId:claimId,taskId,expectedTaskVersion:1},{requestId:claimId,taskId,expectedTaskVersion:1}])
 assert.equal(f.calls.start,1)
})

test('运行配置失败已持久化后报告稳定失败，不启动或核对原生轮次',async()=>{
 const f=fixture();f.setState('configuration_failed')
 await assert.rejects(f.dispatcher.dispatch('owner',job,new AbortController().signal),{code:'teloa/run-configuration-failed'})
 assert.equal(f.calls.start,0);assert.equal(f.calls.reconcile,0)
})

test('启动结果未知后只核对原生日志，不再次领取发送权',async()=>{
 const f=fixture(),signal=new AbortController().signal;let state='prepared',starts=0,reconciles=0
 f.ports.prepare=async()=>taskRun(state)
 f.ports.driver={start:async()=>{starts++;state='submitting';throw new WorkError('teloa/execution-pending','需要核对')},reconcile:async()=>{reconciles++;state='active';return taskRun(state)}}
 await assert.rejects(f.dispatcher.dispatch('owner',job,signal),{code:'teloa/execution-pending'})
 assert.equal((await f.dispatcher.dispatch('owner',job,signal)).run.state,'active');assert.equal(starts,1);assert.equal(reconciles,1)
})

test('未知提交持续报告待核对，恢复证据后才成功',async()=>{
 const f=fixture(),signal=new AbortController().signal;let observed=false
 f.ports.prepare=async()=>taskRun('submitting');f.ports.driver.reconcile=async()=>{f.calls.reconcile++;return taskRun(observed?'active':'submitting')}
 for(let cycle=0;cycle<2;cycle++)await assert.rejects(f.dispatcher.dispatch('owner',job,signal),{code:'teloa/execution-pending'})
 observed=true;assert.equal((await f.dispatcher.dispatch('owner',job,signal)).run.state,'active');assert.equal(f.calls.start,0);assert.equal(f.calls.reconcile,3)
})
