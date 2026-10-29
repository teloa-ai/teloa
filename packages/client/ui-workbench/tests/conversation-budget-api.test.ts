import test from 'node:test'
import assert from 'node:assert/strict'
import {createConversationBudgetApi} from '../src/client/conversation-budget-api.ts'
const policy={maxTokens:2_000_000,maxGoalRounds:32,maxConcurrent:4,maxElapsedMs:21600000,maxRetries:3,stagnationRounds:3,money:null}
const current={sessionId:'settings-session',version:0,configured:false,policy}
const id='33333333-3333-4333-8333-333333333333'

test('新任务页设读取身份核验，明确不限通过且默认不触发写入',async()=>{
 const calls:{endpoint:string;payload:any}[]=[],api=createConversationBudgetApi(async(endpoint,payload)=>{calls.push({endpoint,payload});return endpoint.endsWith('/read')?current:{...current,version:1,configured:true,policy:(payload as any).policy}},()=>id)
 assert.deepEqual(await api.read(current.sessionId),current);assert.equal(calls.length,1);assert.equal(calls[0]!.endpoint,'conversation-budgets/read')
 const saved=await api.configure(current,{...policy,maxTokens:null,maxGoalRounds:null,maxConcurrent:null,maxElapsedMs:null})
 assert.equal(saved.policy.maxTokens,null);assert.equal(saved.version,1);assert.equal(api.pending(current.sessionId),false)
 assert.equal(calls[1]!.payload.expectedVersion,0);assert.equal(calls[1]!.payload.requestId,id)
 const mismatch=createConversationBudgetApi(async()=>({...current,sessionId:'another-session'}))
 await assert.rejects(mismatch.read(current.sessionId),/当前会话不一致/)
})

test('丢失回包保留同一请求，恢复可接受JSONB字段顺序，冲突不隐藏成成功',async()=>{
 let count=0;const commands:unknown[]=[],api=createConversationBudgetApi(async(_endpoint,payload)=>{
  commands.push(structuredClone(payload));if(++count===1)throw Error('lost reply')
  return {...current,configured:true,version:1,policy:{money:null,stagnationRounds:3,maxRetries:3,maxElapsedMs:21600000,maxConcurrent:4,maxGoalRounds:32,maxTokens:null}}
 },()=>id)
 await assert.rejects(api.configure(current,{...policy,maxTokens:null}),/lost reply/)
 assert.equal(api.pending(current.sessionId),true)
 assert.throws(()=>api.configure(current,{...policy,maxTokens:10}),/核对上次/)
 const recovered=await api.recover(current.sessionId);assert.equal(recovered.policy.maxTokens,null)
 assert.deepEqual(commands[0],commands[1]);assert.equal(api.pending(current.sessionId),false)
 const conflict=createConversationBudgetApi(async()=>{throw Object.assign(Error('changed'),{code:'teloa/version-conflict',rejected:true})},()=>id)
 await assert.rejects(conflict.configure(current,policy),{code:'teloa/version-conflict'});assert.equal(conflict.pending(current.sessionId),false)
})
