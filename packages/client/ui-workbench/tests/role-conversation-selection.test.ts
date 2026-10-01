import assert from 'node:assert/strict'
import test from 'node:test'
import type {Conversation} from '@teloa/contract'
import {latestRoleConversation,roleCanStartConversation} from '../src/client/role-conversation-selection.ts'
import type {PresentedConversation} from '../src/client/work-presentation.ts'

const conversation=(id:string,status:Conversation['status']='ready'):Conversation=>({id:'work-'+id,sessionId:id,requestedSessionId:id,ownerId:'owner',title:'会话 '+id,scopeIds:['general'],version:1,status,createdAt:'2026-09-01T00:00:00.000Z'})
const presented=(id:string,updatedAt:number,status:Conversation['status']='ready'):PresentedConversation=>({conversation:conversation(id,status),title:'会话 '+id,updatedAt,status:status==='pending'?'pending':'idle'})
const link=(sessionId:string,active=true)=>({sessionId,active})

test('0 条有效关联返回 undefined',()=>{
  assert.equal(latestRoleConversation([presented('a',1)],[link('other')],[]),undefined)
})

test('1 条有效关联直接返回该会话',()=>{
  assert.equal(latestRoleConversation([presented('a',1)],[link('a')],[])?.conversation.sessionId,'a')
})

test('N 条关联按原生更新时间选择最近一条，不依赖输入顺序',()=>{
  assert.equal(latestRoleConversation([presented('old',1),presented('new',3),presented('middle',2)],[link('middle'),link('old'),link('new')],[])?.conversation.sessionId,'new')
})

test('排除归档、已解除关联和仍在创建中的会话',()=>{
  const rows=[presented('archived',4),presented('inactive',3),presented('pending',2,'pending'),presented('ready',1)]
  assert.equal(latestRoleConversation(rows,[link('archived'),link('inactive',false),link('pending'),link('ready')],['archived'])?.conversation.sessionId,'ready')
})

test('更新时间相同时按 conversation id 稳定选择',()=>{
  const rows=[presented('z',2),presented('a',2)]
  assert.equal(latestRoleConversation(rows,[link('z'),link('a')],[])?.conversation.id,'work-a')
})

test('暂停仍可开始聊天，离职才禁止新会话',()=>{
  assert.equal(roleCanStartConversation('active'),true)
  assert.equal(roleCanStartConversation('paused'),true)
  assert.equal(roleCanStartConversation('retired'),false)
})
