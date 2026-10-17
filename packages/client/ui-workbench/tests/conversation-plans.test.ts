import test from 'node:test'
import assert from 'node:assert/strict'
import {createConversationPlanDirectory,plansForConversation} from '../src/client/conversation-plans.ts'
import type {SavedPlan} from '../src/client/plan-api.ts'
const plan=(id:string,sessionId:string,state:SavedPlan['state']='paused',version=1)=>({id,source:{kind:'manual',sessionId},state,version} as SavedPlan)
test('仅来源会话展示计划，归档隐藏，暂停保留，多条计划不重复',()=>{
 const rows=[plan('a','one'),plan('b','one','active'),plan('c','one','archived'),plan('d','other')]
 assert.deepEqual(plansForConversation(rows,'one').map(row=>row.id),['a','b'])
 assert.deepEqual(plansForConversation(rows,'blank'),[])
})
test('慢回包不能覆盖新的目录和版本，失败不保留可点击的旧状态',async()=>{
 let resolve!:(rows:SavedPlan[])=>void,count=0
 const directory=createConversationPlanDirectory({list:async()=>++count===1?new Promise(done=>{resolve=done}):[plan('a','one','active',2)]})
 const first=directory.refresh();await directory.refresh();resolve([plan('a','one','paused')]);await first
 assert.equal(directory.getSnapshot().plans[0]!.state,'active')
 directory.merge([plan('a','one','archived',3)]);directory.merge([plan('a','one','paused',1)])
 assert.equal(directory.getSnapshot().plans[0]!.state,'archived')
 const failed=createConversationPlanDirectory({list:async()=>{throw Error('offline')}});failed.merge([plan('a','one')]);await assert.rejects(failed.refresh());assert.deepEqual(failed.getSnapshot(),{status:'failed',plans:[]})
})


test('成果计划只回连原本人消息的正式会话，人工结项无消息不猜当前会话',()=>{
 const source={kind:'method-reuse' as const,artifactId:'11111111-1111-4111-8111-111111111111',version:1,basisHash:'a'.repeat(64),taskId:'22222222-2222-4222-8222-222222222222'}
 const acceptedSource={sessionId:'original-method-session',messageId:'original-message',messageSeq:3,requestId:'33333333-3333-4333-8333-333333333333'}
 const linked={...plan('from-message','unused'),source:{...source,acceptedSource}}
 const manual={...plan('from-completion','unused'),source}
 const archived={...linked,id:'archived',state:'archived' as const}
 assert.deepEqual(plansForConversation([linked,manual,archived],'original-method-session').map(row=>row.id),['from-message'])
 assert.deepEqual(plansForConversation([linked,manual],'unused'),[])
})
