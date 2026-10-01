import test from 'node:test'
import assert from 'node:assert/strict'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {authorizeConversationMutation,conversationMutationRequestId} from '../src/conversation-mutation.ts'

const user=(seq:number,id:string,source:object={kind:'user',rpcId:'native-request'}):SessionEvent=>({type:'user/message',seq,time:seq,surfaceOp:'append',data:{id,role:'user',source,content:[{type:'text',text:'保存上一条'}]}} as unknown as SessionEvent)
const start=(seq:number):SessionEvent=>({type:'turn/start',seq,time:seq,data:{turn:1}} as unknown as SessionEvent)

test('普通会话授权固定当前真实用户指令并生成稳定请求身份',async()=>{
 const events=[start(0),user(1,'instruction')]
 const input={owner:'local:teloa-owner',conversation:async(id:string)=>({ownerId:'local:teloa-owner',sessionId:id,status:'ready' as const}),readTaskPolicy:async()=>null,agent:{session:{id:'session-1',header:{},inheritedEventCount:0,snapshotEvents:()=>events}},signal:AbortSignal.timeout(1000)}
 const first=await authorizeConversationMutation(input),second=await authorizeConversationMutation(input)
 assert.deepEqual(first,second)
 assert.equal(first.instruction.messageId,'instruction')
 assert.equal(conversationMutationRequestId(first,'teloa_knowledge_save_message'),conversationMutationRequestId(second,'teloa_knowledge_save_message'))
})

test('拒绝子 Agent、任务执行、继承指令、非当前会话及多个当前用户指令',async()=>{
 const base={owner:'local:teloa-owner',conversation:async(id:string)=>({ownerId:'local:teloa-owner',sessionId:id,status:'ready' as const}),readTaskPolicy:async()=>null,signal:AbortSignal.timeout(1000)}
 for(const agent of [
  {session:{id:'session-1',header:{origin:'subagent'},inheritedEventCount:0,snapshotEvents:()=>[start(0),user(1,'instruction')]}},
  {session:{id:'session-1',header:{},inheritedEventCount:2,snapshotEvents:()=>[start(0),user(1,'instruction')]}},
  {session:{id:'session-1',header:{},inheritedEventCount:0,snapshotEvents:()=>[start(0),user(1,'a'),user(2,'b')]}},
 ])await assert.rejects(authorizeConversationMutation({...base,agent}),{code:'teloa/forbidden'})
 await assert.rejects(authorizeConversationMutation({...base,agent:{session:{id:'session-1',header:{},inheritedEventCount:0,snapshotEvents:()=>[start(0),user(1,'instruction')] }},readTaskPolicy:async()=>({allowedTools:[],nativeRequestId:'task'})}),{code:'teloa/forbidden'})
 await assert.rejects(authorizeConversationMutation({...base,agent:{session:{id:'session-1',header:{},inheritedEventCount:0,snapshotEvents:()=>[start(0),user(1,'instruction')] }},conversation:async()=>({ownerId:'local:teloa-owner',sessionId:'other',status:'ready' as const})}),{code:'teloa/forbidden'})
})
