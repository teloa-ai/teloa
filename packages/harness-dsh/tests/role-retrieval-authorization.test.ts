import test from 'node:test'
import assert from 'node:assert/strict'
import type {DigitalRole} from '@teloa/contract'
import {roleRetrievalAuthorization} from '../src/role-retrieval-authorization.ts'

const role=(overrides:Partial<Record<'id'|'ownerId'|'scopes'|'knowledge',unknown>>={})=>({
 id:'11111111-1111-4111-8111-111111111111',ownerId:'owner',scopes:['research'],knowledge:['22222222-2222-4222-8222-222222222222'],...overrides,
}) as unknown as DigitalRole

test('普通会话没有员工身份时不做岗位授权，沿用调用方的普通会话范围',async()=>{
 assert.equal(await roleRetrievalAuthorization('session',{owner:'owner',requestedRoleId:async()=>null,role:async()=>role()}),null)
})

test('员工单聊按岗位业务范围与员工资料清单限定检索主体',async()=>{
 const authorization=await roleRetrievalAuthorization('session',{owner:'owner',requestedRoleId:async()=>'11111111-1111-4111-8111-111111111111',role:async()=>role()})
 assert.deepEqual(authorization,{actor:{ownerId:'owner',kind:'agent',scopeIds:['research']},targetScopes:['research'],knowledgeIds:['22222222-2222-4222-8222-222222222222']})
})

test('员工身份失效、范围撤回或资料清单为空时明确拒绝或保持空清单',async()=>{
 const id='11111111-1111-4111-8111-111111111111'
 const call=(value:unknown)=>roleRetrievalAuthorization('session',{owner:'owner',requestedRoleId:async()=>id,role:async()=>value as DigitalRole|null})
 for(const value of [null,role({ownerId:'other'}),role({id:'33333333-3333-4333-8333-333333333333'}),role({scopes:[]}),role({scopes:['']})])
  await assert.rejects(call(value),{code:'teloa/forbidden'})
 const empty=await call(role({knowledge:[]}))
 assert.deepEqual(empty?.knowledgeIds,[])
 assert.deepEqual(await roleRetrievalAuthorization('session',{owner:'owner',requestedRoleId:async()=>id,role:async()=>role({scopes:['research','research'],knowledge:['22222222-2222-4222-8222-222222222222','22222222-2222-4222-8222-222222222222']})}),{actor:{ownerId:'owner',kind:'agent',scopeIds:['research']},targetScopes:['research'],knowledgeIds:['22222222-2222-4222-8222-222222222222']})
})
