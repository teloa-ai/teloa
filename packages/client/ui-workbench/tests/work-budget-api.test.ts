import test from 'node:test'
import assert from 'node:assert/strict'
import {createWorkBudgetApi,type BudgetView} from '../src/client/work-budget-api.ts'
const budgetAccountId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333',policy={maxGoalRounds:32,maxTokens:2000000,maxElapsedMs:21600000,maxConcurrent:4,maxRetries:3,stagnationRounds:3,money:null},used={version:3,policy,usedTokens:120,usedRounds:2,concurrent:1,usedElapsedMs:90000,moneyMinorUnits:null},changed={...policy,maxTokens:4000000,maxElapsedMs:43200000,maxRetries:5,stagnationRounds:4}
test('真实职责/本人额度读口；本人确认未知回包恢复固定请求与累计用量，明确拒绝清 journal',async()=>{
 let raw:string|null=null,lost=true;const calls:unknown[][]=[],journal={read:()=>raw,write:(v:string)=>{raw=v},clear:()=>{raw=null}},call=async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);if(endpoint.endsWith('/configure')){if(lost){lost=false;throw Error('回包未知')}return {version:4,policy:Object.fromEntries(Object.entries(changed).reverse()),...(endpoint==='work-budgets/configure'?{budgetAccountId}:{})}}return {...used,version:4,policy:changed,...(endpoint==='work-budgets/read'?{budgetAccountId}:{})}},api=createWorkBudgetApi(call,journal,()=>requestId)
 const current=await api.read(budgetAccountId);assert.equal(current.usedTokens,120);assert.equal((await api.readOwner()).concurrent,1);calls.length=0
 await assert.rejects(api.configure({...current,version:3},changed),/未知/);assert.ok(raw);const restored=createWorkBudgetApi(call,journal),recovered=await restored.recover();assert.equal(recovered.usedTokens,120);assert.equal(recovered.usedRounds,2);assert.equal(recovered.policy.maxRetries,5);assert.deepEqual(calls[0],calls[1]);assert.deepEqual(calls[2],['work-budgets/read',{budgetAccountId}]);assert.equal(raw,null)
 calls.length=0;const owner=await restored.readOwner();await restored.configure({...owner,version:3},changed);assert.equal(calls[1]![0],'work-budgets/owner/configure');assert.equal(Object.hasOwn(calls[1]![1] as object,'budgetAccountId'),false);assert.equal(calls[2]![0],'work-budgets/owner/read')
 const rejected=createWorkBudgetApi(async()=>{throw Object.assign(Error('明确拒绝'),{rejected:true,code:'teloa/version-conflict'})},journal,()=>requestId);await assert.rejects(rejected.configure({...used,budgetAccountId},changed),/拒绝/);assert.equal(raw,null);assert.equal(rejected.pending(),undefined)
 await assert.rejects(createWorkBudgetApi(async()=>({...used,budgetAccountId:other})).read(budgetAccountId),/不属于/);await assert.rejects(createWorkBudgetApi(async()=>({...used,usedTokens:-1})).readOwner(),/格式/);assert.equal((await createWorkBudgetApi(async()=>used).readOwner()).usedElapsedMs,90000);for(const usedElapsedMs of [-1,1.5,'60000',undefined])await assert.rejects(createWorkBudgetApi(async()=>({...used,usedElapsedMs})).readOwner(),/格式/,'窗口耗时必须是真实非负整数，缺失也不冒充为零');await assert.rejects(createWorkBudgetApi(async()=>({...used,budgetAccountId})).readOwner(),/不属于/)
 await assert.rejects(async()=>restored.configure({...used,budgetAccountId},{...changed,maxElapsedMs:0}),{code:'teloa/invalid-input'})
})

test('四项不限按原null保存和恢复，保留真实用量；同版本回读不符不冒充保存成功',async()=>{
 const unlimited={...policy,maxGoalRounds:null,maxTokens:null,maxElapsedMs:null,maxConcurrent:null},calls:unknown[][]=[]
 let raw:string|null=null,lost=true,mutations=0;let current:BudgetView={...used,policy:unlimited,version:4}
 const receipts=new Map<string,unknown>(),journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const call=async(endpoint:string,payload:unknown)=>{
  calls.push([endpoint,payload]);if(endpoint.endsWith('/configure')){const input=payload as {requestId:string;policy:typeof unlimited};if(!receipts.has(input.requestId)){mutations++;receipts.set(input.requestId,{version:4,policy:input.policy})}if(lost){lost=false;throw Error('unknown result')}return receipts.get(input.requestId)}return current
 }
 const api=createWorkBudgetApi(call,journal,()=>requestId)
 await assert.rejects(api.configure(used,unlimited),/unknown/);assert.ok(raw)
 const restored=createWorkBudgetApi(call,journal),result=await restored.recover()
 assert.deepEqual(result.policy,unlimited);assert.equal(result.usedTokens,120);assert.equal(result.usedRounds,2);assert.equal(result.concurrent,1);assert.equal(result.usedElapsedMs,90000);assert.equal(mutations,1);assert.deepEqual(calls[0],calls[1]);assert.equal(raw,null)
 current={...current,policy:{...unlimited,maxTokens:123}}
 const mismatched=createWorkBudgetApi(call,journal,()=>other)
 await assert.rejects(mismatched.configure(used,unlimited),/尚未反映/);assert.ok(mismatched.pending());assert.ok(raw)
})
