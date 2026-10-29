import test from 'node:test'
import assert from 'node:assert/strict'
import {readWorkTokenLimit,readWorkBudgetPolicy} from '../src/work-budget.ts'

test('交办token上限与完整工作预算共享正安全整数范围，显式null不限，不接受无穷/小数/字符串或省略值',()=>{
 const policy={maxGoalRounds:32,maxTokens:1,maxElapsedMs:1000,maxConcurrent:1,maxRetries:0,stagnationRounds:1,money:null}
 for(const value of [1,6_000_000,Number.MAX_SAFE_INTEGER,null]){assert.equal(readWorkTokenLimit(value),value);assert.equal(readWorkBudgetPolicy({...policy,maxTokens:value}).maxTokens,value)}
 for(const value of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,'6000000',undefined,{},[]]){
  assert.throws(()=>readWorkTokenLimit(value),{code:'teloa/invalid-input'})
  assert.throws(()=>readWorkBudgetPolicy({...policy,maxTokens:value}),{code:'teloa/invalid-input'})
 }
})


test('四项资源上限可逐项不限，重试与无进展保护及字段完整性仍严格',()=>{
 const policy={maxGoalRounds:null,maxTokens:null,maxElapsedMs:null,maxConcurrent:null,maxRetries:0,stagnationRounds:1,money:null}
 assert.deepEqual(readWorkBudgetPolicy(policy),policy)
 for(const key of ['maxTokens','maxGoalRounds','maxElapsedMs','maxConcurrent','maxRetries','stagnationRounds','money']){const value={...policy} as Record<string,unknown>;delete value[key];assert.throws(()=>readWorkBudgetPolicy(value),{code:'teloa/invalid-input'})}
 for(const key of ['maxRetries','stagnationRounds'])assert.throws(()=>readWorkBudgetPolicy({...policy,[key]:null}),{code:'teloa/invalid-input'})
 assert.throws(()=>readWorkBudgetPolicy({...policy,anotherLimit:null}),{code:'teloa/invalid-input'})
})
