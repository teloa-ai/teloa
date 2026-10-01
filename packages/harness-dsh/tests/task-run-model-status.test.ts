import test from 'node:test'
import assert from 'node:assert/strict'
import type {Context} from '@deepseek-ai/cordis'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import type {TaskRun} from '@teloa/backend'
import {createTaskRunModelReader,projectTaskRunModelStatus} from '../src/task-run-model-status.ts'
import {taskModelRecoverySource} from '../src/task-model-dsh.ts'

const primary={provider:'local',model:'small'},fallback={provider:'remote',model:'large'},policy={primary,fallback}
const run={id:'run',nativeRequestId:'target',sessionId:'session',modelPolicy:policy} as TaskRun
const events=(...rows:object[])=>rows.map((row,seq)=>({seq,time:seq,...row})) as SessionEvent[]
const start=(turn:number)=>({type:'turn/start',data:{turn}})
const end=(turn:number)=>({type:'turn/end',data:{turn,reason:{kind:'completed'}}})
const message=(rpcId:string)=>({type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId}}})
const header=(model:object)=>({type:'request/header',data:{header:{config:{...model,maxTokens:2000}},reason:'change'}})
const recovery={from:primary,to:fallback,reason:'TRANSPORT' as const}
const notice=(runId='run')=>({type:'user/message',surfaceOp:'append',data:{source:{kind:taskModelRecoverySource,runId,recovery}}})

test('准备配置不是实际请求，只有本请求轮次的原生请求头可以展示',()=>{
 assert.deepEqual(projectTaskRunModelStatus(run,[]),{state:'unobserved'})
 assert.deepEqual(projectTaskRunModelStatus(run,events(start(0),message('other'),header(fallback),end(0),start(1),message('target'))),{state:'unobserved'})
 assert.deepEqual(projectTaskRunModelStatus(run,events(start(0),message('target'),header(primary))),{state:'observed',model:primary,requestSeq:2})
})
test('切换记录须与备用请求头一起成立；模型解析期可在首次用户消息前持久化原因',()=>{
 assert.deepEqual(projectTaskRunModelStatus(run,events(start(0),notice(),message('target'))),{state:'unobserved'})
 assert.deepEqual(projectTaskRunModelStatus(run,events(start(0),notice(),message('target'),header(fallback))),{state:'observed',model:fallback,requestSeq:3,recovery})
 const history=events(start(0),message('target'),header(primary),notice(),header({...fallback,reasoningEffort:'high'}),end(0))
 assert.deepEqual(projectTaskRunModelStatus(run,history),{state:'observed',model:{...fallback,reasoningEffort:'high'},requestSeq:4,recovery})
 for(const bad of [events(start(0),message('target'),header(fallback)),events(start(0),message('target'),notice('other'),header(fallback)),events(start(0),notice(),notice(),message('target'),header(fallback)),events(start(0),notice(),message('target'),header(primary))])assert.throws(()=>projectTaskRunModelStatus(run,bad))
})
test('后续普通聊天及同轮外来消息不污染历史模型；官方后台续接沿用任务归属判据',()=>{
 const foreign={provider:'outside',model:'unrelated'}
 assert.equal(projectTaskRunModelStatus(run,events(start(0),message('target'),header(primary),end(0),start(1),message('other'),header(foreign))).state,'observed')
 assert.deepEqual(projectTaskRunModelStatus(run,events(start(0),message('target'),header(primary),message('other'),header(foreign))),{state:'observed',model:primary,requestSeq:2})
 const continuation={type:'user/message',surfaceOp:'append',data:{source:{kind:'tool-jobs'}}}
 assert.deepEqual(projectTaskRunModelStatus(run,events(start(0),message('target'),header(primary),end(0),start(1),continuation,notice(),header(fallback))),{state:'observed',model:fallback,requestSeq:7,recovery})
 const broken=events(start(0),message('target'),header(primary));broken[2]!.seq=9 as SessionEvent['seq']
 assert.throws(()=>projectTaskRunModelStatus(run,broken))
})
test('读取优先实时日志，未加载时只读持久存储并关句柄，绝不拉起 Agent',async()=>{
 const history=events(start(0),message('target'),header(primary),end(0));let live=true,opened=0,closed=0
 const ctx={sessions:{get:()=>live?{snapshotEvents:()=>history}:undefined},sessionPersistence:{open:async(id:string,access:string)=>{assert.equal(id,run.sessionId);assert.equal(access,'read');opened++;return {read:async()=>({events:history}),close:async()=>{closed++}}}},sessionController:{resolveAgent:()=>assert.fail('不得启动 Agent')}} as unknown as Context
 const reader=createTaskRunModelReader(ctx),expected={state:'observed',model:primary,requestSeq:2}
 assert.deepEqual(await reader.read(run),expected);assert.equal(opened,0)
 live=false;assert.deepEqual(await reader.read(run),expected);assert.equal(opened,1);assert.equal(closed,1)
 const {modelPolicy:_policy,...legacy}=run
 assert.equal(await reader.read(legacy),undefined);assert.equal(opened,1)
})
test('持久日志读取或关闭失败可见不可用，不假装从未请求、不暴露内部错误',async()=>{
 for(const fail of ['open','read','close']){
  let closed=0
  const ctx={sessions:{get:()=>undefined},sessionPersistence:{open:async()=>{if(fail==='open')throw Error('private path');return {read:async()=>{if(fail==='read')throw Error('secret');return {events:[]}},close:async()=>{closed++;if(fail==='close')throw Error('secret')}}}}} as unknown as Context
  assert.deepEqual(await createTaskRunModelReader(ctx).read(run),{state:'unavailable'})
  assert.equal(closed,fail==='open'?0:1)
 }
})
