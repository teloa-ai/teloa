import test from 'node:test'
import assert from 'node:assert/strict'
import {groupCreateInput,groupChangeFields,isGroup} from '../src/collaboration.ts'

const lead='11111111-1111-4111-8111-111111111111',member='22222222-2222-4222-8222-222222222222'
const source={kind:'industry-load',loadId:'33333333-3333-4333-8333-333333333333',contentId:'44444444-4444-4444-8444-444444444444',contentHash:'a'.repeat(64),mappingHash:'b'.repeat(64)}
const fields={name:'固定团队',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[lead,member],source,coordinatorRoleId:lead}
test('团队群固定来源与群内协调者往返，旧定义兼容且未知授权字段拒绝',()=>{
 const value={requestId:'55555555-5555-4555-8555-555555555555',expectedVersion:0,fields}
 assert.deepEqual(groupCreateInput(value),value)
 const {memberRoleIds:_,...definition}=fields
 const group={...definition,id:lead,ownerId:'owner',version:1,pinned:false,archived:false,createdAt:'2026-10-16T00:00:00.000Z',updatedAt:'2026-10-16T00:00:00.000Z'}
 assert.equal(isGroup(group),true)
 for(const changed of [{...source,contentHash:'bad'},{...source,kind:'upload'},{...source,ownerId:'other'}])assert.throws(()=>groupCreateInput({...value,fields:{...fields,source:changed}}),{code:'teloa/invalid-input'})
 assert.throws(()=>groupCreateInput({...value,fields:{...fields,coordinatorRoleId:source.loadId}}),{code:'teloa/invalid-input'})
 const {source:_source,coordinatorRoleId:_lead,...legacy}=fields
 assert.deepEqual(groupCreateInput({...value,fields:legacy}).fields,legacy)
})
test('群编辑只接受可选协调者；省略与明确清除区分，固定来源不可重写',()=>{
 const change={name:fields.name,announcement:'',rules:fields.rules,memberRoleIds:fields.memberRoleIds,pinned:false,archived:false}
 assert.equal('coordinatorRoleId' in groupChangeFields(change),false)
 assert.equal(groupChangeFields({...change,coordinatorRoleId:null}).coordinatorRoleId,null)
 assert.equal(groupChangeFields({...change,coordinatorRoleId:member}).coordinatorRoleId,member)
 assert.throws(()=>groupChangeFields({...change,source}),{code:'teloa/invalid-input'})
 assert.throws(()=>groupChangeFields({...change,coordinatorRoleId:source.loadId}),{code:'teloa/invalid-input'})
})
