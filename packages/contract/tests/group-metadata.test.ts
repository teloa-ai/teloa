import test from 'node:test'
import assert from 'node:assert/strict'
import {groupDefinition,groupChangeFields,isGroup} from '../src/collaboration.ts'

const rules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
const definition={name:'跨行业核对组',scope:'general',announcement:'本周核对交付资料',rules,memberRoleIds:[]}
const group={id:'10000000-0000-4000-8000-000000000001',ownerId:'owner',version:1,name:definition.name,scope:definition.scope,announcement:definition.announcement,rules,pinned:false,archived:false,createdAt:'2026-10-13T00:00:00.000Z',updatedAt:'2026-10-13T00:00:00.000Z'}

test('群说明与临时公告独立，旧定义保持原形状且不清空说明',()=>{
 assert.deepEqual(groupDefinition(definition),definition)
 assert.deepEqual(groupDefinition({...definition,purpose:'  持续核对交付证据  '}),{...definition,purpose:'持续核对交付证据'})
 const change={name:definition.name,announcement:'下一轮安排',rules,memberRoleIds:[],pinned:false,archived:false}
 assert.equal(Object.hasOwn(groupChangeFields(change),'purpose'),false,'老客户端未传说明表示保留，不表示清空')
 assert.equal(groupChangeFields({...change,purpose:''}).purpose,'','显式空串才清空说明')
 for(const purpose of [false,null,'x'.repeat(241)])assert.throws(()=>groupDefinition({...definition,purpose}))
})

test('只读目录人数必须是真实有界整数，不能当作群设置提交',()=>{
 assert.equal(isGroup(group),true)
 assert.equal(isGroup({...group,purpose:'核对交付',memberCount:2}),true)
 for(const memberCount of [-1,32,1.5,'2',null])assert.equal(isGroup({...group,memberCount}),false)
 assert.equal(isGroup({...group,unknown:true}),false)
 assert.throws(()=>groupDefinition({...definition,memberCount:2}))
 assert.throws(()=>groupChangeFields({...definition,pinned:false,archived:false,memberCount:2}))
})
