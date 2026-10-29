import test from 'node:test'
import assert from 'node:assert/strict'
import {mount} from './market-component-harness.ts'
const {exported}=mount('WorkBudgetFields.tsx'),policy={maxGoalRounds:32,maxTokens:2_000_000,maxElapsedMs:21_600_000,maxConcurrent:4,maxRetries:3,stagnationRounds:3,money:null}
test('无限只用于四项资源，有限值和累计保护继续严格检查；额度方向按null为不限比较',()=>{
 const valid=exported.isWorkBudgetPolicyValid,increase=exported.isWorkBudgetIncrease
 assert.equal(valid(policy),true)
 for(const key of ['maxGoalRounds','maxTokens','maxElapsedMs','maxConcurrent']){assert.equal(valid({...policy,[key]:null}),true);for(const value of [0,-1,1.5,NaN,Infinity,undefined])assert.equal(valid({...policy,[key]:value}),false)}
 for(const key of ['maxRetries','stagnationRounds'])assert.equal(valid({...policy,[key]:null}),false)
 assert.equal(valid({...policy,maxRetries:0}),true);assert.equal(valid({...policy,stagnationRounds:0}),false)
 assert.equal(increase(policy,{...policy,maxTokens:null}),true);assert.equal(increase({...policy,maxTokens:null},policy),false)
 assert.equal(increase({...policy,maxTokens:null},{...policy,maxTokens:null,maxConcurrent:8}),true)
 assert.equal(increase(policy,{...policy,maxTokens:4_000_000,maxConcurrent:1}),false)
})
