import test from 'node:test'
import assert from 'node:assert/strict'
import {defaultSubagentDelegationLimits,readSubagentDelegationLimits,subagentReservationId} from '../src/subagent-delegation.ts'

test('子 Agent 拆分上限在省略时取默认，环境变量只接受规定的整数范围',()=>{
 assert.deepEqual(defaultSubagentDelegationLimits,{maxDepth:1,maxPerRun:6})
 assert.deepEqual(readSubagentDelegationLimits({}),{maxDepth:1,maxPerRun:6})
 assert.deepEqual(readSubagentDelegationLimits({TELOA_SUBAGENT_MAX_DEPTH:'0',TELOA_SUBAGENT_MAX_PER_RUN:'1'}),{maxDepth:0,maxPerRun:1})
 assert.deepEqual(readSubagentDelegationLimits({TELOA_SUBAGENT_MAX_DEPTH:'3',TELOA_SUBAGENT_MAX_PER_RUN:'32'}),{maxDepth:3,maxPerRun:32})
 for(const [name,value] of [['TELOA_SUBAGENT_MAX_DEPTH','-1'],['TELOA_SUBAGENT_MAX_DEPTH','4'],['TELOA_SUBAGENT_MAX_DEPTH','01'],['TELOA_SUBAGENT_MAX_DEPTH','1.0'],['TELOA_SUBAGENT_MAX_PER_RUN','0'],['TELOA_SUBAGENT_MAX_PER_RUN','33'],['TELOA_SUBAGENT_MAX_PER_RUN','bad']] as const)assert.throws(()=>readSubagentDelegationLimits({[name]:value}),new RegExp(name))
})

test('同一 Run 会话与原生调用始终生成同一条预留身份，不同调用不能共享',()=>{
 const one=subagentReservationId('run-session','tool-call')
 assert.equal(one,subagentReservationId('run-session','tool-call'))
 assert.notEqual(one,subagentReservationId('other-session','tool-call'))
 assert.notEqual(one,subagentReservationId('run-session','other-call'))
 assert.match(one,/^call:[a-f0-9]{64}$/)
})
