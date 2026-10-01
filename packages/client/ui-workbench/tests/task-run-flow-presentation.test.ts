import test from 'node:test'
import assert from 'node:assert/strict'
import {createTaskRunApi,type RunView} from '../src/client/task-run-api.ts'
import {taskRunFlowPresentation} from '../src/client/task-run-flow-presentation.ts'
import type {TaskRunFlow} from '@teloa/contract'

const runId='11111111-1111-4111-8111-111111111111',flowId='22222222-2222-4222-8222-222222222222',at='2026-09-13T08:00:00.000Z'
const ordinary={id:runId,taskId:'33333333-3333-4333-8333-333333333333',sessionId:'session',nativeRequestId:'44444444-4444-4444-8444-444444444444',state:'active',stopRequestedAt:null,taskVersion:1,roleVersion:2,goal:'核对资料',roleName:'核对岗',createdAt:at,skills:[],knowledge:[],toolRules:[]} as RunView
const step=(value:Partial<TaskRunFlow['steps'][number]>&Pick<TaskRunFlow['steps'][number],'id'|'title'|'kind'|'dependsOn'|'state'>):TaskRunFlow['steps'][number]=>({inputSummary:'固定输入',attempts:0,outputSummary:null,waitReason:null,startedAt:null,updatedAt:at,completedAt:null,...value})
const flow:TaskRunFlow={flowId,runId,definitionVersion:4,state:'waiting',createdAt:at,updatedAt:at,steps:[
 step({id:'read',title:'读取资料',kind:'work',dependsOn:[],state:'succeeded',attempts:1,outputSummary:'资料已固定',startedAt:at,completedAt:at}),
 step({id:'external',title:'等待外部回执',kind:'wait_external',dependsOn:['read'],state:'waiting',attempts:1,waitReason:'等待工单系统回执',startedAt:at}),
 step({id:'undo',title:'补偿外部动作',kind:'compensation',dependsOn:['read'],compensates:'external',state:'blocked'}),
]}

test('普通 Run 不请求或展示空 Flow',async()=>{
 let calls=0
 const api=createTaskRunApi(async()=>{calls++;throw Error('普通 Run 不应读取 Flow')})
 assert.equal(typeof api.flow,'function','缺少按 Run 读取 Flow 的客户端边界')
 assert.equal(await api.flow(ordinary),null)
 assert.equal(calls,0)
})

test('复杂 Run 只接受自己的 Flow，并呈现固定定义、依赖、等待原因与补偿状态',async()=>{
 const run={...ordinary,flowId},api=createTaskRunApi(async(method,payload)=>{assert.equal(method,'task-run-flows/get');assert.deepEqual(payload,{runId});return flow})
 const loaded=await api.flow(run)
 assert.deepEqual(loaded,flow)
 const view=taskRunFlowPresentation(loaded!)
 assert.deepEqual({state:view.stateKey,version:view.definitionVersion,completed:view.completed,total:view.total},{state:'taskExecution.flow.state.waiting',version:4,completed:1,total:3})
 assert.deepEqual(view.steps.map(item=>[item.id,item.kindKey,item.stateKey]),[
  ['read','taskExecution.flow.kind.work','taskExecution.flow.step.succeeded'],['external','taskExecution.flow.kind.external','taskExecution.flow.step.waiting'],['undo','taskExecution.flow.kind.compensation','taskExecution.flow.step.trigger'],
 ])
 assert.deepEqual(view.steps[1]!.dependencies,['读取资料']);assert.equal(view.steps[1]!.waitReason,'等待工单系统回执')
 await assert.rejects(createTaskRunApi(async()=>({...flow,runId:'55555555-5555-4555-8555-555555555555'})).flow(run),/其他执行/)
 await assert.rejects(createTaskRunApi(async()=>null).flow(run))
})
