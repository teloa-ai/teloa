import test from 'node:test'
import assert from 'node:assert/strict'
import {groupRoleMemories} from '../src/client/role-memory-grouping.ts'
import type {RoleDailyLogPruneHint, RoleMemory} from '@teloa/contract'

const at='2026-09-13T00:00:00.000Z',hash='a'.repeat(64)
const memory=(id:string,state:RoleMemory['state'],stateVersion:number):RoleMemory=>({
 id,ownerId:'local:owner',roleId:'16057272-ed9d-44a3-abe4-2ab04e056105',roleVersion:2,title:'记忆-'+id,state,stateVersion,
 source:{kind:'self-feedback',id:'26057272-ed9d-44a3-abe4-2ab04e056105',version:1},sourceTitle:'本人反馈',sourceAvailable:true,
 visibility:{kind:'private',scopeIds:[]},proposedBy:{kind:'self'},
 content:{version:1,contentHash:hash,bytes:new TextEncoder().encode('内容').byteLength,markdown:'内容',createdAt:at},
 candidateAt:at,confirmedAt:state==='confirmed'||state==='withdrawn'?at:null,withdrawnAt:state==='withdrawn'?at:null,
})
const hint=(memoryId:string,memoryStateVersion:number):RoleDailyLogPruneHint=>({memoryId,memoryStateVersion,reason:'与今天的证据不一致'})

test('四组顺序固定：待确认 → 建议撤回 → 已确认 → 已撤回',()=>{
 const pending=memory('m1','candidate',1),confirmed=memory('m2','confirmed',2),withdrawn=memory('m3','withdrawn',3)
 const groups=groupRoleMemories([confirmed,withdrawn,pending],[])
 assert.deepEqual(groups.map(group=>group.id),['pending','pruneSuggested','confirmed','withdrawn'])
 assert.deepEqual(groups.map(group=>group.items.map(item=>item.id)),[['m1'],[],['m2'],['m3']])
})

test('被建议撤回的已确认条目从「已确认」移进「建议撤回」，且不在两组重复出现',()=>{
 const confirmed=memory('m1','confirmed',2)
 const groups=groupRoleMemories([confirmed],[hint('m1',2)])
 const byId=new Map(groups.map(group=>[group.id,group.items.map(item=>item.id)]))
 assert.deepEqual(byId.get('pruneSuggested'),['m1'])
 assert.deepEqual(byId.get('confirmed'),[])
})

test('memoryStateVersion 与当前记忆不符的建议不生效，该条留在「已确认」',()=>{
 const confirmed=memory('m1','confirmed',2)
 const groups=groupRoleMemories([confirmed],[hint('m1',1)])
 const byId=new Map(groups.map(group=>[group.id,group.items.map(item=>item.id)]))
 assert.deepEqual(byId.get('pruneSuggested'),[])
 assert.deepEqual(byId.get('confirmed'),['m1'])
})

test('空输入回四组空列表而不是抛',()=>{
 const groups=groupRoleMemories([],[])
 assert.equal(groups.length,4)
 for(const group of groups)assert.deepEqual(group.items,[])
})
