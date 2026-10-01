import test from 'node:test'
import assert from 'node:assert/strict'
import {isRoleMemory,roleMemorySource,roleMemoryVisibility,type RoleMemory} from '../src/role-memory.ts'

const id='16057272-ed9d-44a3-abe4-2ab04e056105'
const hash='a'.repeat(64)
const sourceKinds=['task','run','artifact','knowledge'] as const

test('岗位记忆合同只接受五类固定来源及明确版本',()=>{
 for(const kind of sourceKinds)assert.deepEqual(roleMemorySource({kind,id,version:2}),{kind,id,version:2})
 assert.deepEqual(roleMemorySource({kind:'self-feedback',id,version:1}),{kind:'self-feedback',id,version:1})
 for(const invalid of [
  {kind:'conversation',id,version:1},
  {kind:'task',id,version:0},
  {kind:'self-feedback',id,version:2},
  {kind:'task',id,version:1,summary:'模型猜测'},
 ])assert.throws(()=>roleMemorySource(invalid),{code:'teloa/invalid-input'})
})

test('岗位记忆可见范围明确区分岗位范围与本人私有',()=>{
 assert.deepEqual(roleMemoryVisibility({kind:'role',scopeIds:['SOC','general']}),{kind:'role',scopeIds:['SOC','general']})
 assert.deepEqual(roleMemoryVisibility({kind:'private',scopeIds:[]}),{kind:'private',scopeIds:[]})
 for(const invalid of [
  {kind:'role',scopeIds:[]},
  {kind:'private',scopeIds:['general']},
  {kind:'role',scopeIds:['SOC','SOC']},
 ])assert.throws(()=>roleMemoryVisibility(invalid),{code:'teloa/invalid-input'})
})

test('岗位记忆返回值固定正文版本、摘要、来源、提出主体与状态历史',()=>{
 const memory:RoleMemory={
  id,ownerId:'local:owner',roleId:'26057272-ed9d-44a3-abe4-2ab04e056105',roleVersion:3,title:'交付前复核来源',
  state:'confirmed',stateVersion:2,source:{kind:'task',id:'36057272-ed9d-44a3-abe4-2ab04e056105',version:4},
  sourceTitle:'季度复盘',sourceAvailable:true,visibility:{kind:'role',scopeIds:['SOC']},proposedBy:{kind:'self'},
  content:{version:1,contentHash:hash,bytes:30,markdown:'交付前必须复核来源。',createdAt:'2026-09-13T01:00:00.000Z'},
  candidateAt:'2026-09-13T01:00:00.000Z',confirmedAt:'2026-09-13T02:00:00.000Z',withdrawnAt:null,
 }
 assert.equal(isRoleMemory(memory),true)
 assert.equal(isRoleMemory({...memory,content:{...memory.content,contentHash:'bad'}}),false)
 assert.equal(isRoleMemory({...memory,state:'candidate',confirmedAt:memory.confirmedAt}),false)
 assert.equal(isRoleMemory({...memory,visibility:{kind:'private',scopeIds:[]}}),true)
 assert.equal(isRoleMemory({...memory,proposedBy:{kind:'role',roleId:memory.roleId,roleVersion:4}}),true)
})

test('岗位记忆键集与键数扩位后一字不变，daily-digest 来源走通',()=>{
 const memory:RoleMemory={
  id,ownerId:'local:owner',roleId:'26057272-ed9d-44a3-abe4-2ab04e056105',roleVersion:3,title:'今日小结归档',
  state:'confirmed',stateVersion:2,source:{kind:'daily-digest',id:'36057272-ed9d-44a3-abe4-2ab04e056105',version:1},
  sourceTitle:'今日小结',sourceAvailable:true,visibility:{kind:'role',scopeIds:['SOC']},proposedBy:{kind:'self'},
  content:{version:1,contentHash:hash,bytes:33,markdown:'今天完成了交付前复核。',createdAt:'2026-09-13T01:00:00.000Z'},
  candidateAt:'2026-09-13T01:00:00.000Z',confirmedAt:'2026-09-13T02:00:00.000Z',withdrawnAt:null,
 }
 assert.equal(isRoleMemory(memory),true)
 assert.deepEqual(Object.keys(memory).sort(),['candidateAt','confirmedAt','content','id','ownerId','proposedBy','roleId','roleVersion','source','sourceAvailable','sourceTitle','state','stateVersion','title','visibility','withdrawnAt'])
 assert.equal(Object.keys(memory).length,16)
 assert.equal(isRoleMemory({...memory,extra:'x'}),false)
 const {sourceAvailable:_dropped,...missing}=memory
 assert.equal(isRoleMemory(missing),false)
 assert.equal(isRoleMemory({...memory,source:{kind:'habit-digest',id:memory.source.id,version:1}}),true)
})
