import test from 'node:test'
import assert from 'node:assert/strict'
import {createGroupTaskHandler} from '../src/group-tasks.ts'

const owner='local:owner',taskId='11111111-1111-4111-8111-111111111111',groupId='22222222-2222-4222-8222-222222222222',messageId='33333333-3333-4333-8333-333333333333',stamp='2026-10-09T00:00:00.000Z'
const task={id:taskId,ownerId:owner,title:'群任务：核对资料',goal:'形成结论。',scope:'general',groupId:null,skills:[],version:1,state:'ready',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:stamp,updatedAt:stamp}
const source={schema:'teloa.group-task-source/v1',taskId,ownerId:owner,groupId,groupVersion:1,messageId,rootId:messageId,messageCreatedAt:stamp,messageText:'核对资料',references:[],createdAssignee:null,trigger:'manual',createdAt:stamp}
const request={requestId:'44444444-4444-4444-8444-444444444444',groupId,messageId,expectedGroupVersion:1,goal:task.goal}

test('群任务内容版本与完成策略兼容旧回包并严格读取新增字段',async()=>{
 const read=(value:unknown,fixed:unknown=source)=>createGroupTaskHandler(owner,async()=>({create:async()=>({task:value,source:fixed}),source:async()=>fixed}) as never)('groups/tasks/create',request)
 assert.deepEqual(await read(task),{task,source})
 for(const completionPolicy of [{kind:'manual'},{kind:'verified',verifier:'material-version-summary',verifierVersion:1,authorizationVersion:2}]){
  const current={...task,contentVersion:2,completionPolicy};assert.deepEqual(await read(current),{task:current,source})
 }
 for(const fields of [
  ...[null,0,-1,1.5,'2',Number.MAX_SAFE_INTEGER+1].map(contentVersion=>({contentVersion})),
  ...[null,{kind:'manual',extra:true},{kind:'verified',verifier:'unknown',verifierVersion:1,authorizationVersion:1},{kind:'verified',verifier:'system-digest',verifierVersion:0,authorizationVersion:1},{kind:'verified',verifier:'system-digest',verifierVersion:1}].map(completionPolicy=>({completionPolicy})),
  {unexpected:true},{ownerId:'other'},
 ])await assert.rejects(read({...task,...fields}),{code:'teloa/invalid-host-response'})
 await assert.rejects(read(task,{...source,ownerId:'other'}),{code:'teloa/invalid-host-response'})
 await assert.rejects(read(task,{...source,messageId:taskId}),{code:'teloa/invalid-host-response'})
})

test('跨业务群任务回包必须保留固定业务目标和负责人，不接受换业务或丢失目标的成功回执',async()=>{
 const roleId='55555555-5555-4555-8555-555555555555',businessTarget={scope:'SOC'},input={...request,assignee:{roleId,expectedVersion:1},businessTarget}
 const fixed={...source,schema:'teloa.group-task-source/v2',createdAssignee:{roleId,roleVersion:1},replyToMessageId:null,contextMode:'main',routingAttemptVersion:1,executionMode:'work',businessTarget},saved={...task,scope:'SOC',groupId,assigneeRoleId:roleId,assigneeRoleVersion:1}
 const read=(nextTask:unknown,nextSource:unknown)=>createGroupTaskHandler(owner,async()=>({create:async()=>({task:nextTask,source:nextSource}),source:async()=>nextSource}) as never)('groups/tasks/create',input)
 assert.equal((await read(saved,fixed) as any).task.scope,'SOC')
 await assert.rejects(read({...saved,scope:'AppSec'},fixed),{code:'teloa/invalid-host-response'})
 await assert.rejects(read(saved,{...fixed,businessTarget:{scope:'AppSec'}}),{code:'teloa/invalid-host-response'})
 const {businessTarget:_drop,...missing}=fixed;await assert.rejects(read(saved,missing),{code:'teloa/invalid-host-response'})
})
