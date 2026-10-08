import test from 'node:test'
import assert from 'node:assert/strict'
import {createConfirmedFlowApi} from '../src/client/flow-api.ts'
const runId='11111111-1111-4111-8111-111111111111',flowId='22222222-2222-4222-8222-222222222222',sourceId='33333333-3333-4333-8333-333333333333',requestId='44444444-4444-4444-8444-444444444444',at='2026-10-09T00:00:00.000Z',definition={definitionVersion:1,steps:[{id:'left',title:'第一路',kind:'work' as const,dependsOn:[],inputSummary:'第一路原输入'},{id:'right',title:'第二路',kind:'work' as const,dependsOn:[],inputSummary:'第二路原输入'}]},flow={flowId,runId,definitionVersion:1,state:'active',steps:definition.steps.map(s=>({...s,state:'ready',attempts:0,outputSummary:null,waitReason:null,startedAt:null,updatedAt:at,completedAt:null})),createdAt:at,updatedAt:at}
test('本人 Flow 未知创建恢复原端点和固定输入；明确拒绝清 journal，来源身份不受请求覆盖',async()=>{
 let raw:string|null=null,lost=true;const calls:unknown[][]=[],journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}},call=async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);if(lost){lost=false;throw Error('网络未知')}return flow},api=createConfirmedFlowApi(call,journal,()=>requestId)
 await assert.rejects(api.create(runId,definition,[]),/未知/);assert.ok(raw);assert.deepEqual(await createConfirmedFlowApi(call,journal).recover(),flow);assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0]![0],'task-run-flows/create-confirmed');assert.equal(raw,null)
 const rejected=createConfirmedFlowApi(async()=>{throw Object.assign(Error('明确拒绝'),{rejected:true})},journal,()=>requestId);await assert.rejects(rejected.create(runId,definition,[]),/拒绝/);assert.equal(raw,null);assert.equal(rejected.pending(),undefined)
 const sources=createConfirmedFlowApi(async()=>({materials:[{id:sourceId,title:'真实材料'}],approvals:[],bindings:[]}));assert.equal((await sources.sources(runId)).materials[0]!.id,sourceId)
 await assert.rejects(createConfirmedFlowApi(async()=>({materials:[{id:sourceId,title:'资料',ownerId:'other'}],approvals:[],bindings:[]})).sources(runId),{code:'teloa/invalid-input'})
})
test('checkpoint 重新绑定未知结果保留同一步骤、来源及版本，无普通 resume 调用',async()=>{
 let raw:string|null=null,lost=true;const calls:unknown[][]=[],waiting={...flow,state:'waiting',steps:[{...flow.steps[0]!,kind:'human_checkpoint',state:'waiting',attempts:1,startedAt:at,waitReason:'等本人核对'},flow.steps[1]!]},journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}},call=async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);if(lost){lost=false;throw Error('结果未知')}return waiting}
 await assert.rejects(createConfirmedFlowApi(call,journal,()=>requestId).rebind({runId,flowId,stepId:'left',expectedAttempts:1,expectedBindingVersion:2,sourceKind:'approval-result',sourceId}),/未知/);await createConfirmedFlowApi(call,journal).recover();assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0]![0],'task-run-flows/rebind-wait-confirmed');assert.equal(raw,null)
})
