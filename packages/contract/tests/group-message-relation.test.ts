import assert from 'node:assert/strict'
import {test} from 'node:test'
import {groupMessageRelationFields,resolveGroupDirectRecipients} from '../src/group-message-relation.ts'
import {groupSendInput,isGroupMessage} from '../src/collaboration.ts'
import {groupRoutedAttemptTaskRequestId,groupRoutedTaskRequestId,groupRoutingAttemptRequestId,groupRoutingRequestId,groupRoutingRetryInput,isGroupRoutingDecision,isGroupRoutingStatusView} from '../src/group-routing.ts'

const A='aaaaaaaa-1111-4111-8111-111111111111',B='bbbbbbbb-1111-4111-8111-111111111111',C='cccccccc-1111-4111-8111-111111111111'
const groupId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',messageId='44444444-4444-4444-8444-444444444444',replyId='55555555-5555-4555-8555-555555555555'
const base={mentionIds:[] as string[],replyAuthorRoleId:null as string|null,candidateIds:[A,B],mentionAll:false,mentionAllAllowed:true}

test('显式 @ 覆盖引用对象：引用 A、点名 B，只选 B',()=>{
 assert.deepEqual(resolveGroupDirectRecipients({...base,mentionIds:[B],replyAuthorRoleId:A}),{mode:'direct',recipientIds:[B],unavailableIds:[]})
})
test('引用员工消息选中准确作者；引用作者不可回应时 blocked 并保留原因对象，不换人',()=>{
 assert.deepEqual(resolveGroupDirectRecipients({...base,replyAuthorRoleId:A}),{mode:'direct',recipientIds:[A],unavailableIds:[]})
 assert.deepEqual(resolveGroupDirectRecipients({...base,replyAuthorRoleId:C}),{mode:'blocked',recipientIds:[],unavailableIds:[C]})
})
test('部分点名不可用：可用者进入派发，不可用者逐位保留',()=>{
 assert.deepEqual(resolveGroupDirectRecipients({...base,mentionIds:[C,A]}),{mode:'direct',recipientIds:[A],unavailableIds:[C]})
})
test('全员优先于 @；群规则关闭全员时 blocked；名单只来自宿主候选',()=>{
 assert.deepEqual(resolveGroupDirectRecipients({...base,mentionIds:[A],mentionAll:true}),{mode:'direct',recipientIds:[A,B],unavailableIds:[]})
 assert.deepEqual(resolveGroupDirectRecipients({...base,mentionAll:true,mentionAllAllowed:false}),{mode:'blocked',recipientIds:[],unavailableIds:[]})
 assert.deepEqual(resolveGroupDirectRecipients({...base,candidateIds:[],mentionAll:true}),{mode:'blocked',recipientIds:[],unavailableIds:[]})
})
test('没有结构化目标才走语义选人；引用本人消息只是上下文锚点',()=>{
 assert.deepEqual(resolveGroupDirectRecipients(base),{mode:'semantic',recipientIds:[],unavailableIds:[]})
})

test('发送请求：旧请求原样；新关系严格解析；mentionAll=false 与省略同义',()=>{
 assert.deepEqual(groupSendInput({requestId,groupId,expectedVersion:1,text:'问题'}),{requestId,groupId,expectedVersion:1,text:'问题'})
 assert.deepEqual(groupSendInput({requestId,groupId,expectedVersion:1,text:'问题',replyToMessageId:replyId,mentionAll:true}),{requestId,groupId,expectedVersion:1,text:'问题',replyToMessageId:replyId,mentionAll:true})
 assert.deepEqual(groupSendInput({requestId,groupId,expectedVersion:1,text:'问题',mentionAll:false}),{requestId,groupId,expectedVersion:1,text:'问题'})
 for(const bad of [{replyToMessageId:'x'},{mentionAll:'yes'},{replyAuthorId:A}])assert.throws(()=>groupSendInput({requestId,groupId,expectedVersion:1,text:'问题',...bad}),{code:'teloa/invalid-input'})
})
test('消息回包：关系键可选；自引用、false 值与未知键被拒',()=>{
 const message={id:messageId,groupId,rootId:null,authorId:'self',text:'问题',references:[],mentions:[],createdAt:'2026-10-14T00:00:00.000Z'}
 assert.equal(isGroupMessage(message),true)
 assert.equal(isGroupMessage({...message,...groupMessageRelationFields(replyId,true)}),true)
 assert.equal(isGroupMessage({...message,...groupMessageRelationFields(null,false)}),true)
 assert.deepEqual(groupMessageRelationFields(null,false),{})
 assert.equal(isGroupMessage({...message,replyToMessageId:messageId}),false)
 assert.equal(isGroupMessage({...message,mentionAll:false}),false)
 assert.equal(isGroupMessage({...message,extra:1}),false)
})

test('尝试世代：第一尝试沿原身份，重试身份随版本变化且不同于原身份',()=>{
 assert.equal(groupRoutingAttemptRequestId('o',groupId,messageId,1),groupRoutingRequestId('o',groupId,messageId))
 assert.notEqual(groupRoutingAttemptRequestId('o',groupId,messageId,2),groupRoutingRequestId('o',groupId,messageId))
 assert.notEqual(groupRoutingAttemptRequestId('o',groupId,messageId,2),groupRoutingAttemptRequestId('o',groupId,messageId,3))
 assert.equal(groupRoutedAttemptTaskRequestId('o',groupId,messageId,A,1),groupRoutedTaskRequestId('o',groupId,messageId,A))
 assert.notEqual(groupRoutedAttemptTaskRequestId('o',groupId,messageId,A,2),groupRoutedTaskRequestId('o',groupId,messageId,A))
})
test('决策新增 direct / blocked 两种终态',()=>{
 const decision={kind:'direct',respond:[A],reactions:[],hops:0,candidateIds:[A],truncatedCandidates:false,stopMessageId:null,at:'2026-10-14T00:00:00.000Z'}
 assert.equal(isGroupRoutingDecision(decision),true)
 assert.equal(isGroupRoutingDecision({...decision,kind:'blocked',respond:[]}),true)
 assert.equal(isGroupRoutingDecision({...decision,kind:'mystery'}),false)
})
test('重试请求严格解析：版本必须为正，覆盖接收者去重且有上限',()=>{
 const input={requestId,groupId,messageId,expectedAttempt:1,expectedGroupVersion:2}
 assert.deepEqual(groupRoutingRetryInput(input),input)
 assert.deepEqual(groupRoutingRetryInput({...input,overrideRecipients:[{roleId:A,expectedVersion:3}]}),{...input,overrideRecipients:[{roleId:A,expectedVersion:3}]})
 for(const bad of [{expectedAttempt:0},{overrideRecipients:[]},{overrideRecipients:[{roleId:A,expectedVersion:1},{roleId:A,expectedVersion:1}]},{text:'重发正文'}])assert.throws(()=>groupRoutingRetryInput({...input,...bad}),{code:'teloa/invalid-input'})
})
test('状态投影：恰 6 键、闭集 phase/hint、空身份只用 null',()=>{
 const view={messageId,attemptVersion:1,phase:'running',recipients:[{roleId:A,name:'售后',taskId:requestId,runId:null,phase:'running',resultMessageId:null,executionMode:null}],hintCode:null,canRetry:false}
 assert.equal(isGroupRoutingStatusView(view),true)
 assert.equal(isGroupRoutingStatusView({...view,phase:'thinking'}),false)
 assert.equal(isGroupRoutingStatusView({...view,hintCode:'Error: boom'}),false)
 assert.equal(isGroupRoutingStatusView({...view,recipients:[{...view.recipients[0],taskId:null,runId:requestId}]}),false)
 assert.equal(isGroupRoutingStatusView({...view,recipients:[{...view.recipients[0],taskId:''}]}),false)
})
