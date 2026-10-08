import test from 'node:test'
import assert from 'node:assert/strict'
import type {TaskRunFlowService} from '@teloa/backend'
import {createTaskRunFlowHandler,taskRunFlowEndpoints,confirmedTaskRunFlowEndpoints,createConfirmedTaskRunFlowHandler} from '../src/task-run-flows.ts'

test('内部 Flow RPC 固定宿主身份，只公开读回与固定步骤事件',async()=>{
 const calls:Array<[string,string,unknown]>=[],service={
  get:async(owner:string,payload:unknown)=>{calls.push(['get',owner,payload]);return null},
  create:async(owner:string,payload:unknown)=>{calls.push(['create',owner,payload]);return {kind:'created'}},
  transition:async(owner:string,payload:unknown)=>{calls.push(['transition',owner,payload]);return {kind:'transitioned'}},
 } as unknown as TaskRunFlowService
 const handler=createTaskRunFlowHandler('local-owner',async()=>service),signal=new AbortController().signal
 assert.equal(await handler('task-run-flows/get',{runId:'run'},signal),null)
 await assert.rejects(handler('task-run-flows/create',{requestId:'request',runId:'run',definitionVersion:1,steps:[]},signal),{code:'teloa/not-found'})
 assert.deepEqual(await handler('task-run-flows/transition',{requestId:'request',flowId:'flow',stepId:'step',action:'start',expectedAttempts:0},signal),{kind:'transitioned'})
 assert.deepEqual(calls,[
  ['get','local-owner',{runId:'run'}],
  ['transition','local-owner',{requestId:'request',flowId:'flow',stepId:'step',action:'start',expectedAttempts:0}],
 ])
 for(const endpoint of taskRunFlowEndpoints)await assert.rejects(handler(endpoint,{ownerId:'forged'},signal),{code:'teloa/invalid-input'})
 await assert.rejects(handler('task-run-flows/record',{flowId:'flow'},signal),{code:'teloa/not-found'})
 const controller=new AbortController();controller.abort()
 await assert.rejects(handler('task-run-flows/get',{runId:'run'},controller.signal),error=>error instanceof Error&&error.name==='AbortError')
 assert.deepEqual(taskRunFlowEndpoints,['task-run-flows/get','task-run-flows/transition'])
 assert.equal(calls.length,2)
})
test('本人 Flow 确认入口独立于 generic set，宿主绑定身份且取消后不进入服务',async()=>{
 const calls:string[]=[],service={createConfirmed:async(owner:string)=>{calls.push(owner);return null},waitSources:async(owner:string)=>{calls.push(owner);return {}},rebindWaitConfirmed:async(owner:string)=>{calls.push(owner);return null}} as unknown as TaskRunFlowService,handler=createConfirmedTaskRunFlowHandler('real-self',async()=>service),signal=new AbortController().signal
 for(const endpoint of confirmedTaskRunFlowEndpoints){assert.equal((taskRunFlowEndpoints as readonly string[]).includes(endpoint),false);await handler(endpoint,{},signal)}assert.deepEqual(calls,['real-self','real-self','real-self'])
 const controller=new AbortController();controller.abort();await assert.rejects(handler(confirmedTaskRunFlowEndpoints[0],{},controller.signal),{name:'AbortError'});assert.equal(calls.length,3)
})
