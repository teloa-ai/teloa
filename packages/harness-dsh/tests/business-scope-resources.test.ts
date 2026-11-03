import test from 'node:test'
import assert from 'node:assert/strict'
import {resourceConversationScope} from '../src/resources.ts'
import {authorizeConversationBusinessScope} from '../src/business-scope-context.ts'
import type {ToolExecution} from '@deepseek-ai/dsh-tools'
test('NF02资源候选/附件正文使用同一真实选择而非legacy general；scope改变拒绝原lease',async()=>{
 let scope='SOC',version=1
 const exec={agent:{session:{id:'session',header:{}}},signal:AbortSignal.timeout(5000)} as Pick<ToolExecution,'agent'|'signal'>
 const ports={owner:'owner',conversation:async(sessionId:string)=>({ownerId:'owner',sessionId,status:'ready' as const}),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isTaskConversation:async()=>false,binding:async()=>undefined,context:async()=>({sessionId:'session',scopeId:scope,roleId:null,version,locked:false}),scopes:async()=>[{scope,title:scope}]}
 const read=await resourceConversationScope('owner',{scopeIds:['general']},'session',exec.signal,async()=>authorizeConversationBusinessScope(ports,exec))
 assert.deepEqual(read.actor,{ownerId:'owner',kind:'agent',scopeIds:['SOC']})
 scope='AppSec';version++;await assert.rejects(()=>read.assertCurrent())
 const switched=await resourceConversationScope('owner',{scopeIds:['general']},'session',exec.signal,async()=>authorizeConversationBusinessScope(ports,exec))
 assert.deepEqual(switched.actor.scopeIds,['AppSec'])
})
test('已有受管读取绑定不借用owner业务全集；错误owner/范围lease拒绝',async()=>{
 const signal=AbortSignal.timeout(5000)
 const legacy=await resourceConversationScope('owner',{scopeIds:['task-scope']},'task',signal,async()=>undefined)
 assert.deepEqual(legacy.actor.scopeIds,['task-scope'])
 await assert.rejects(()=>resourceConversationScope('owner',{scopeIds:['general']},'session',signal,async()=>({scope:'SOC',context:null,actor:{ownerId:'other',scopeIds:['SOC']},fingerprint:'bad',assertCurrent:async()=>{}})))
})
