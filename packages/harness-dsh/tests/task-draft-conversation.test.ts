import test from 'node:test'
import assert from 'node:assert/strict'
import type {WorkTask,TaskDraftCreateInput} from '@teloa/contract'
import {createPlatformTaskDraft} from '../src/task-draft-conversation.ts'
const task:WorkTask={goal:'Prepare work',groupId:null,skills:[],state:'ready',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:'2026-10-12T00:00:00Z',updatedAt:'2026-10-12T00:00:00Z',id:'10000000-0000-4000-8000-000000000001',ownerId:'owner',title:'Original draft',scope:'general',version:1},request:TaskDraftCreateInput={requestId:'20000000-0000-4000-8000-000000000001',sessionId:'ordinary',fields:{scope:'general',title:task.title,goal:'Prepare work',groupId:null,skills:[]}}
test('来源关系只读当前对象版本，不改变不可变首次创建回执，不把普通聊天绑定成任务上下文',async()=>{
 const changes:unknown[]=[],ports={owner:'owner',create:async()=>task,list:async()=>[{...task,version:2}],conversation:async()=>({ownerId:'owner',sessionId:'ordinary',id:'conversation',status:'ready'}),links:{list:async()=>[],change:async(_owner:string,input:unknown)=>{changes.push(input);return {kind:'task' as const,objectId:task.id,objectVersion:2,sessionId:'ordinary',conversationId:'conversation',version:1,active:true,updatedAt:task.updatedAt,scopeId:'general',sourceOnly:true as const}}}}
 assert.equal(await createPlatformTaskDraft(ports,request,new AbortController().signal,async()=>{}),task)
 assert.deepEqual(changes,[{requestId:request.requestId,kind:'task',objectId:task.id,expectedObjectVersion:2,sessionId:request.sessionId,expectedLinkVersion:0,action:'link',sourceOnly:true}])
})
test('原来源已有成功或后来解除记录时不重新关联，也不随当前任务版本改造原请求',async()=>{
 for(const active of [true,false]){
  let writes=0;const ports={owner:'owner',create:async()=>task,list:async()=>[{...task,version:3}],conversation:async()=>({ownerId:'owner',sessionId:'ordinary',id:'conversation',status:'ready'}),links:{list:async()=>[{kind:'task' as const,objectId:task.id,objectVersion:1,sessionId:'ordinary',conversationId:'conversation',sourceOnly:true as const,active,version:active?1:2,updatedAt:task.updatedAt,scopeId:'general'}],change:async()=>{writes++;throw Error('unexpected')}}}
  assert.equal(await createPlatformTaskDraft(ports,request,new AbortController().signal,async()=>{}),task);assert.equal(writes,0)
 }
})
test('既有主执行上下文不能被降格为来源，来源所属本人不匹配时不得新增关系',async()=>{
 const ports={owner:'owner',create:async()=>task,list:async()=>[task],conversation:async()=>({ownerId:'other-owner',sessionId:'ordinary',id:'conversation',status:'ready'}),links:{list:async()=>[],change:async()=>{throw Error('unexpected')}}}
 await assert.rejects(createPlatformTaskDraft(ports,request,new AbortController().signal,async()=>{}),{code:'teloa/forbidden'})
})
