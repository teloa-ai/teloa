import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createGroupHandler} from '../src/groups.ts'
import {createGroupAgentGrantHandler} from '../src/group-agent-grants.ts'
import {createGroupTaskHandler} from '../src/group-tasks.ts'

const groupId=randomUUID(),roleId=randomUUID(),referenceId=randomUUID(),artifactRefId=randomUUID(),attachmentRefId='sha256:'+'a'.repeat(64)
// 引用是判别联合：一个数组同时管群资料、成果与附件三类原件（附件原件本人级，version 恒 1）。
const references=[{kind:'group-resource',id:referenceId,version:3},{kind:'artifact',id:artifactRefId,version:2},{kind:'attachment',id:attachmentRefId,version:1}]
const create={requestId:randomUUID(),expectedVersion:0 as const,fields:{name:'SOC 调查群',scope:'SOC',announcement:'固定协作范围。',memberRoleIds:[roleId]}}
const change={requestId:randomUUID(),groupId,expectedVersion:1,fields:{name:'SOC 调查群',announcement:'更新说明。',memberRoleIds:[roleId],pinned:true,archived:false}}
const send={requestId:randomUUID(),groupId,expectedVersion:2,text:'开始核验。',references}

test('群协作 RPC 固定使用宿主本人，十类端点分别调用服务',async()=>{
 const calls:unknown[]=[],backend={list:async(owner:string,input:unknown)=>{calls.push(['list',owner,input]);return []},get:async(owner:string,input:unknown)=>{calls.push(['get',owner,input]);return {id:groupId}},create:async(owner:string,input:unknown)=>{calls.push(['create',owner,input]);return {id:groupId}},change:async(owner:string,input:unknown)=>{calls.push(['change',owner,input]);return {id:groupId}},messages:async(owner:string,input:unknown)=>{calls.push(['messages',owner,input]);return []},send:async(owner:string,input:unknown)=>{calls.push(['send',owner,input]);return {id:randomUUID()}},resources:async(owner:string,input:unknown)=>{calls.push(['resources',owner,input]);return []},resource:async(owner:string,input:unknown)=>{calls.push(['resource',owner,input]);return {resourceId:referenceId}},saveResource:async(owner:string,input:unknown)=>{calls.push(['saveResource',owner,input]);return {id:referenceId}},withdrawResource:async(owner:string,input:unknown)=>{calls.push(['withdrawResource',owner,input]);return {id:referenceId}},reactions:async(owner:string,input:unknown)=>{calls.push(['reactions',owner,input]);return {items:[]}},toggleReaction:async(owner:string,input:unknown)=>{calls.push(['toggleReaction',owner,input]);return {messageId:'',items:[]}},routing:async(owner:string,input:unknown)=>{calls.push(['routing',owner,input]);return {items:[]}}}
 const handle=createGroupHandler('local:owner',async()=>backend,()=>{})
 await handle('groups/list',{})
 await handle('groups/get',{groupId})
 await handle('groups/create',create)
 await handle('groups/change',change)
 await handle('groups/messages/list',{groupId})
 await handle('groups/messages/send',send)
 await handle('groups/resources/list',{groupId})
 await handle('groups/resources/get',{groupId,resourceId:referenceId,resourceVersion:1})
 await handle('groups/resources/save',{requestId:randomUUID(),groupId,resourceId:referenceId,expectedVersion:0,title:'研判依据',markdown:'# 固定证据'})
 await handle('groups/resources/withdraw',{requestId:randomUUID(),groupId,resourceId:referenceId,expectedVersion:1})
 assert.deepEqual(calls.map(row=>(row as unknown[]).slice(0,2)),[['list','local:owner'],['get','local:owner'],['create','local:owner'],['change','local:owner'],['messages','local:owner'],['send','local:owner'],['resources','local:owner'],['resource','local:owner'],['saveResource','local:owner'],['withdrawResource','local:owner']])
})

test('客户端不能伪造 owner、作者、消息身份或在 get 中混入根消息；服务未就绪显式失败',async()=>{
 let opened=0
 const handle=createGroupHandler('local:owner',async()=>{opened++;return undefined as never},()=>{})
 await assert.rejects(handle('groups/retire',{}),{code:'teloa/not-found'})
 await assert.rejects(handle('groups/create',{...create,ownerId:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('groups/messages/send',{...send,authorId:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('groups/messages/send',{...send,messageId:randomUUID()}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('groups/resources/save',{requestId:randomUUID(),groupId,resourceId:referenceId,expectedVersion:0,title:'资料',markdown:'正文',ownerId:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('groups/get',{groupId,rootId:randomUUID()}),{code:'teloa/invalid-input'})
 assert.equal(opened,0)
 await assert.rejects(handle('groups/list',{}),{code:'teloa/host-unavailable'})
 assert.equal(opened,1)
 // 旧引用形状 {resourceId,resourceVersion} 仍按群资料归一化通过解析器：拦下它的只能是服务未就绪。
 await assert.rejects(handle('groups/messages/send',{...send,references:[{resourceId:referenceId,resourceVersion:3}]}),{code:'teloa/host-unavailable'})
 assert.equal(opened,2)
})

test('群数字员工授权 RPC 固定宿主身份并拒绝伪造字段',async()=>{
 const calls:unknown[]=[],backend={get:async(owner:string,input:unknown)=>{calls.push(['get',owner,input]);return {}},change:async(owner:string,input:unknown)=>{calls.push(['change',owner,input]);return {}}}
 const handle=createGroupAgentGrantHandler('local:owner',async()=>backend)
 const change={requestId:randomUUID(),groupId,roleId,expectedGroupVersion:1,expectedRoleVersion:1,action:'save',resources:references,canPost:true,canAutoRun:false}
 await handle('groups/agent-grants/get',{groupId,roleId})
 await handle('groups/agent-grants/change',change)
 assert.deepEqual(calls.map(row=>(row as unknown[]).slice(0,2)),[['get','local:owner'],['change','local:owner']])
 await assert.rejects(handle('groups/agent-grants/change',{...change,ownerId:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('groups/agent-grants/change',{...change,action:'revoke',resources:references}),{code:'teloa/invalid-input'})
})


test('群消息任务 RPC 固定宿主身份并拒绝伪造任务来源字段',async()=>{
 const messageId=randomUUID(),request={requestId:randomUUID(),groupId,messageId,expectedGroupVersion:1,goal:'形成结论。',assignee:{roleId,expectedVersion:2}}
 const calls:unknown[]=[]
 const handler=createGroupTaskHandler('local:owner',async()=>({
  create:async(owner:string,input:unknown)=>{calls.push(['create',owner,input]);return {task:{id:randomUUID(),ownerId:owner,title:'群任务：告警',goal:'形成结论。',scope:'SOC',groupId:null,skills:[],version:1,state:'ready',assigneeRoleId:roleId,assigneeRoleVersion:2,createdAt:'2026-09-18T00:00:00.000Z',updatedAt:'2026-09-18T00:00:00.000Z'},source:{schema:'teloa.group-task-source/v1',taskId:'11111111-1111-4111-8111-111111111111',ownerId:owner,groupId,groupVersion:1,messageId,rootId:messageId,messageCreatedAt:'2026-09-18T00:00:00.000Z',messageText:'告警',references:[],createdAssignee:{roleId,roleVersion:2},trigger:'manual',createdAt:'2026-09-18T00:00:00.000Z'}}},
  source:async(owner:string,input:unknown)=>{calls.push(['source',owner,input]);return null},
 }))
 // 此处服务故意回传不一致 taskId，宿主必须阻断而不是透传。
 await assert.rejects(handler('groups/tasks/create',request),{code:'teloa/invalid-host-response'})
 assert.deepEqual(calls.map(row=>(row as unknown[]).slice(0,2)),[['create','local:owner']])
 await assert.rejects(handler('groups/tasks/create',{...request,ownerId:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('groups/tasks/source',{taskId:randomUUID(),ownerId:'other'}),{code:'teloa/invalid-input'})
})
