import assert from 'node:assert/strict'
import test from 'node:test'
import {roleRunToolGateFailure} from '../src/work/task-runs.ts'

// RET-001 剩余：prepare 期按真实 executionMode/工具授权判定，空执行工具不能进入模型。
// v1 群手工任务没有 executionMode（null），按工作处理；v2 群 reply 型按设计冻结空工具集只写正文。
test('reply 型群回应允许空工具，其余角色运行必须至少有一项执行工具',()=>{
 assert.equal(roleRunToolGateFailure({executionMode:'reply',allowedTools:[],grantsWired:true}),null)
 assert.equal(roleRunToolGateFailure({executionMode:'work',allowedTools:[],grantsWired:true}),'role-run-no-execution-tools')
 assert.equal(roleRunToolGateFailure({executionMode:null,allowedTools:[],grantsWired:true}),'role-run-no-execution-tools')
 assert.equal(roleRunToolGateFailure({executionMode:'work',allowedTools:['read'],grantsWired:true}),null)
 assert.equal(roleRunToolGateFailure({executionMode:null,allowedTools:['read'],grantsWired:true}),null)
})

test('未接入岗位授权策略的旧宿主/单元夹具不按本规则拒绝，避免把空候选当空授权',()=>{
 assert.equal(roleRunToolGateFailure({executionMode:null,allowedTools:[],grantsWired:false}),null)
 assert.equal(roleRunToolGateFailure({executionMode:'work',allowedTools:[],grantsWired:false}),null)
})

// AutoDream 每日小结（completionPolicy.verifier='system-digest'）只用自授权证据/提交工具，
// 岗位 allowedTools 按设计为空，不得按普通员工工作拦截（3299 live 回归）。
test('system-digest 每日小结允许空执行工具，普通员工运行仍必须至少有一项执行工具',()=>{
 assert.equal(roleRunToolGateFailure({executionMode:null,allowedTools:[],grantsWired:true,systemDigest:true}),null)
 assert.equal(roleRunToolGateFailure({executionMode:null,allowedTools:[],grantsWired:true,systemDigest:false}),'role-run-no-execution-tools')
 assert.equal(roleRunToolGateFailure({executionMode:'work',allowedTools:[],grantsWired:true,systemDigest:false}),'role-run-no-execution-tools')
 assert.equal(roleRunToolGateFailure({executionMode:null,allowedTools:[],grantsWired:false,systemDigest:false}),null)
 assert.equal(roleRunToolGateFailure({executionMode:null,allowedTools:['read'],grantsWired:true,systemDigest:false}),null)
})
