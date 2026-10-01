import test from 'node:test'
import assert from 'node:assert/strict'
import type {Conversation} from '@teloa/contract'
import {linkObjectConversation,unlinkObjectConversation,type ConversationObject} from '../src/client/object-conversations.ts'
const role:ConversationObject={kind:'role',id:'same',title:'调查岗',version:1,canStart:true}
const session=(id:string):Conversation=>({id:'work-'+id,sessionId:id,requestedSessionId:id,ownerId:'self',title:id,scopeIds:['general'],version:1,status:'ready',createdAt:'2026-09-11T00:00:00Z'})
test('对象与会话多对多，解除关联不影响同会话的另一对象或同对象的其他会话',()=>{
 const task={...role,kind:'task' as const},a=session('a'),b=session('b')
 let links=linkObjectConversation([],role,a);links=linkObjectConversation(links,role,b);links=linkObjectConversation(links,task,a)
 assert.equal(links.length,3);assert.equal(linkObjectConversation(links,role,a).length,3)
 const remaining=unlinkObjectConversation(links,role,a.id)
 assert.deepEqual(remaining.map(row=>[row.kind,row.sessionId]),[['role','b'],['task','a']])
 assert.equal(a.status,'ready')
})
test('暂停或结束对象、未就绪会话和身份漂移不能建立关联',()=>{
 assert.throws(()=>linkObjectConversation([],{...role,canStart:false},session('a')),/暂停或结束/)
 assert.throws(()=>linkObjectConversation([],role,{...session('a'),status:'pending'}),/尚未就绪/)
 const links=linkObjectConversation([],role,session('a'))
 assert.throws(()=>linkObjectConversation(links,role,{...session('a'),sessionId:'other'}),/身份不一致/)
})
