import assert from 'node:assert/strict'
import test from 'node:test'
import type {Conversation} from '@teloa/contract'
import {homeRecentContext} from '../src/client/home-recent-context.ts'

const scopes={general:'通用工作',SOC:'安全运营',AppSec:'应用安全'}
const base:Conversation={
 id:'work-session-1',sessionId:'session-1',requestedSessionId:'session-1',ownerId:'self',title:'依赖核对',scopeIds:['general'],version:1,status:'ready',createdAt:'2026-09-19T00:00:00.000Z',
}
const tasks=[
 {id:'task-soc',scope:'SOC',assigneeId:'self'},
 {id:'task-appsec',scope:'AppSec',assigneeId:'role-appsec'},
]
const roles=[
 {id:'role-appsec',name:'程简',scopes:['AppSec']},
 {id:'role-soc',name:'岑野',scopes:['SOC']},
 {id:'role-cross',name:'林析',scopes:['SOC','AppSec']},
]

test('固定任务运行按任务范围和运行岗位呈现真实语境',()=>{
 const conversation:Conversation={...base,run:{taskId:'task-appsec',taskVersion:2,roleId:'role-appsec',roleVersion:3,agentPresetId:'standard'}}
 assert.deepEqual(homeRecentContext(conversation,[],tasks,roles,scopes,'本人'),{scope:'应用安全',owner:'程简'})
})

test('任务与单范围数字员工关联可以证明最近会话语境',()=>{
 assert.deepEqual(homeRecentContext(base,[{kind:'task',objectId:'task-soc',sessionId:'session-1',active:true}],tasks,roles,scopes,'本人'),{scope:'安全运营',owner:'本人'})
 assert.deepEqual(homeRecentContext(base,[{kind:'role',objectId:'role-soc',sessionId:'session-1',active:true}],tasks,roles,scopes,'本人'),{scope:'安全运营',owner:'岑野'})
})

test('重复的同一语境会合并，冲突或证据不足时不猜',()=>{
 assert.deepEqual(homeRecentContext(base,[
  {kind:'task',objectId:'task-appsec',sessionId:'session-1',active:true},
  {kind:'role',objectId:'role-appsec',sessionId:'session-1',active:true},
 ],tasks,roles,scopes,'本人'),{scope:'应用安全',owner:'程简'})
 assert.equal(homeRecentContext(base,[
  {kind:'task',objectId:'task-soc',sessionId:'session-1',active:true},
  {kind:'role',objectId:'role-appsec',sessionId:'session-1',active:true},
 ],tasks,roles,scopes,'本人'),undefined)
 assert.equal(homeRecentContext(base,[{kind:'role',objectId:'role-cross',sessionId:'session-1',active:true}],tasks,roles,scopes,'本人'),undefined)
 assert.equal(homeRecentContext(base,[{kind:'role',objectId:'missing',sessionId:'session-1',active:true}],tasks,roles,scopes,'本人'),undefined)
})

test('普通会话的 general contract 范围不是业务语境证据',()=>{
 assert.deepEqual(base.scopeIds,['general'])
 assert.equal(homeRecentContext(base,[],tasks,roles,scopes,'本人'),undefined)
 assert.equal(homeRecentContext(base,[{kind:'task',objectId:'task-soc',sessionId:'other-session',active:true}],tasks,roles,scopes,'本人'),undefined)
})
