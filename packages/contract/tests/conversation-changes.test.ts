import test from 'node:test'
import assert from 'node:assert/strict'
import {isKnowledgeSaveReceipt,parseConversationKnowledgeCommand,parseSaveKnowledgeMessageToolInput} from '../src/conversation-changes.ts'

const hash='a'.repeat(64),knowledgeId='11111111-1111-4111-8111-111111111111',resourceId='22222222-2222-4222-8222-222222222222'

test('会话保存工具只接受消息指针、标题、主分类和标签',()=>{
 const value=parseSaveKnowledgeMessageToolInput({message:{messageId:'answer-1',seq:8,selectionHash:hash},title:'发布检查',category:'sop',topics:['发布']})
 assert.deepEqual(value,{message:{messageId:'answer-1',seq:8,selectionHash:hash},title:'发布检查',category:'sop',topics:['发布']})
 for(const extra of ['ownerId','sessionId','workspaceId','scopeIds','markdown','path','token'])assert.throws(()=>parseSaveKnowledgeMessageToolInput({...value,[extra]:'forged'}))
 assert.throws(()=>parseSaveKnowledgeMessageToolInput({...value,message:{...value.message,seq:-1}}))
 assert.throws(()=>parseSaveKnowledgeMessageToolInput({...value,topics:Array.from({length:21},(_,index)=>String(index))}))
})

test('内部命令严格固定可信 origin、subject 和服务端目标',()=>{
 const value={schema:'teloa.conversation-knowledge-command/v1',requestId:knowledgeId,origin:{sessionId:'session-1',messageId:'instruction-1',seq:9,selectionHash:'b'.repeat(64)},subject:{sessionId:'session-1',messageId:'answer-1',seq:8,role:'assistant',at:'2026-09-12T10:00:00.000Z',selectionHash:hash,markdown:'# 发布检查\n'},target:{workspaceId:'default',title:'发布检查',category:'sop',topics:['发布'],scopeIds:['general']}}
 assert.deepEqual(parseConversationKnowledgeCommand(value),value)
 assert.throws(()=>parseConversationKnowledgeCommand({...value,ownerId:'forged'}))
 assert.throws(()=>parseConversationKnowledgeCommand({...value,subject:{...value.subject,omittedBlocks:1}}))
})

test('知识保存回执只有完整 active、needs-recovery 和 failed 三态',()=>{
 const base={schema:'teloa.knowledge-save-receipt/v1',requestId:knowledgeId,title:'发布检查',category:'sop',topics:['发布'],workspaceId:'default',scopeIds:['general'],source:{sessionId:'session-1',messageId:'answer-1',seq:8,selectionHash:hash}}
 assert.equal(isKnowledgeSaveReceipt({...base,status:'active',knowledge:{id:knowledgeId,version:1,contentHash:hash},resource:{id:resourceId,version:1}}),true)
 assert.equal(isKnowledgeSaveReceipt({...base,status:'active',knowledge:{id:knowledgeId,version:1,contentHash:hash},resource:null}),false)
 assert.equal(isKnowledgeSaveReceipt({...base,status:'needs-recovery',stage:'resource-applying'}),true)
 assert.equal(isKnowledgeSaveReceipt({...base,status:'failed',stage:'prepared',error:{code:'teloa/invalid-input',message:'无法保存。'}}),true)
 assert.equal(isKnowledgeSaveReceipt({...base,status:'saved'}),false)
})
