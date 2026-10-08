import test from 'node:test'
import assert from 'node:assert/strict'
import {createWorkControlApi} from '../src/client/work-control-api.ts'
import {persistentPlanAction} from '../src/client/continuous-persistence.ts'
import type {PlanApi,SavedPlan} from '../src/client/plan-api.ts'
const controlId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',runId='33333333-3333-4333-8333-333333333333'
const control={id:controlId,ownerId:'local:owner',generation:2,version:3,state:'paused' as const,scope:'definition' as const,pendingRunIds:[],unknownOperationIds:[]}
const plan={id:runId,ownerId:'local:owner',version:7,workDefinition:{definitionControlId:controlId}} as SavedPlan
test('实际控制网络未知保存原请求，明确拒绝清掉journal，恢复端点不走普通resume',async()=>{
 let raw:string|null=null,phase=0;const calls:unknown[][]=[],journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}},call=async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);if(++phase===1)throw Error('控制网络未知');return {...control,version:4,generation:3,state:'active'}}
 const api=createWorkControlApi(call,journal,()=>requestId);await assert.rejects(api.resume(control,[runId]),/未知/);assert.ok(raw)
 const restored=createWorkControlApi(call,journal);assert.equal((await restored.recover()).state,'active');assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0]?.[0],'work-recovery/resume');assert.equal(raw,null)
 const rejected=createWorkControlApi(async()=>{throw Object.assign(Error('明确拒绝'),{rejected:true,code:'teloa/version-conflict'})},journal,()=>requestId);await assert.rejects(rejected.change(control,'stop'),/拒绝/);assert.equal(rejected.pending(),undefined);assert.equal(raw,null)
})
test('长期计划恢复先检验原候选和控制回执，失败时不提前启用计划',async()=>{
 const calls:string[]=[],planApi={changeConfirmed:async()=>{calls.push('enable');return plan}} as unknown as PlanApi
 const api=createWorkControlApi(async(endpoint,payload)=>{calls.push(endpoint);if(endpoint==='work-controls/get')return control;if(endpoint==='work-recovery/inspect')return [{controlId,expectedGeneration:2,runId,nativeRequestId:requestId,goal:null,reason:'unaccepted',safeRecovery:false}];assert.deepEqual(payload,{requestId,controlId,expectedVersion:3,candidateRunIds:[runId]});return {...control,version:4,generation:3,state:'active'}},undefined,()=>requestId)
 await persistentPlanAction(planApi,api,plan,'enable');assert.deepEqual(calls,['work-controls/get','work-recovery/inspect','work-recovery/resume','enable'])
 calls.length=0
 const refused=createWorkControlApi(async endpoint=>{calls.push(endpoint);if(endpoint==='work-controls/get')return control;if(endpoint==='work-recovery/inspect')return [];throw Object.assign(Error('原操作未知'),{rejected:true,code:'teloa/conflict'})})
 await assert.rejects(persistentPlanAction(planApi,refused,plan,'enable'),/未知/);assert.equal(calls.includes('enable'),false)
})
