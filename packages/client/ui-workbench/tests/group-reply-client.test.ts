import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import type {GroupEmployeeReplyMessage,GroupMessage,GroupRecipientStatus,GroupRoutingStatusView} from '@teloa/contract'
import {createGroupApi} from '../src/client/group-api.ts'
import {createGroupRoutingApi,groupRunStopTargets} from '../src/client/group-routing-api.ts'
import {groupMainMessages,groupProgressStatuses} from '../src/client/group-message-overlays.ts'
import {groupRoutingFollowupIsIdle} from '../src/client/group-routing-view.ts'
import {groupMessageIdentity} from '../src/client/saved-collaboration-state.ts'

const groupId=randomUUID(),messageId=randomUUID(),roleId=randomUUID(),replyExecutionId=randomUUID(),rootId=randomUUID()
const reply:GroupEmployeeReplyMessage={id:messageId,groupId,rootId,authorId:roleId,replyExecutionId,text:'收到，继续在本群沟通。',references:[],createdAt:'2026-11-05T01:00:00.000Z',contextMode:'main',author:{name:'群聊员工',kind:'employee',version:2}}
const status=(recipients:GroupRecipientStatus[]=[]):GroupRoutingStatusView=>({messageId,attemptVersion:1,phase:'running',recipients,hintCode:null,canRetry:false})
const recipient=(phase:GroupRecipientStatus['phase']):GroupRecipientStatus=>({roleId,name:'群聊员工',taskId:null,runId:null,replyExecutionId,resultMessageId:null,phase,executionMode:'reply'})

test('普通群回复保留员工身份和主群位置，不被当作本人消息或遗落在话题中',()=>{
 const names={self:'本人',[roleId]:'修改后的岗位名'},t=((key:string)=>key) as never
 assert.deepEqual(groupMessageIdentity(reply,names,t),{name:'群聊员工',kind:'employee'})
 assert.deepEqual(groupMessageIdentity({...reply,author:{...reply.author!,kind:'twin'}},names,t),{name:'修改后的岗位名',kind:'twin'})
 const main=groupMainMessages([reply,{...reply,id:randomUUID(),contextMode:'thread'}])
 assert.deepEqual(main,[reply])
 assert.deepEqual(groupProgressStatuses([reply],[status()]),[],'普通员工回帖不会再制造一个本人等待中的回复')
 const followup={...status(),phase:'unavailable' as const,hintCode:'target-unavailable' as const}
 assert.equal(groupRoutingFollowupIsIdle(reply,{messageId,kind:'no-candidate',respond:[],hops:1},followup),true)
})

test('群消息目录与引用来源接受独立回复证明，但不接受跨执行回包或正文篡改',async()=>{
 const source:GroupMessage={id:rootId,groupId,rootId:null,authorId:'self',text:'你好，直接在群里回复。',mentions:[],references:[],createdAt:'2026-11-05T00:59:00.000Z'}
 const sha256=createHash('sha256').update(source.text).digest('hex')
 let result:unknown={schema:'teloa.group-message-sources/v1',groupId,messageId,runId:null,replyExecutionId,items:[{message:source,rootId:null,sha256}],unavailableCount:0}
 const calls:unknown[]=[],api=createGroupApi(async(endpoint,input)=>{calls.push([endpoint,input]);return endpoint==='groups/messages/list'?[source,reply]:result})
 assert.deepEqual((await api.messages(groupId)).items,[source,reply])
 assert.deepEqual(await api.messageSources(groupId,messageId,{replyExecutionId}),result)
 assert.deepEqual(calls[1],['groups/messages/sources',{groupId,messageId}],'执行证明只核对返回值，不能冒充请求授权')
 const valid=structuredClone(result) as Record<string,unknown>
 for(const bad of [{...valid,replyExecutionId:randomUUID()},{...valid,runId:randomUUID()},{...valid,items:[{message:source,rootId:null,sha256:'f'.repeat(64)}]}]){
  result=bad;await assert.rejects(api.messageSources(groupId,messageId,{replyExecutionId}))
 }
 result=valid;await assert.rejects(api.messageSources(groupId,messageId,randomUUID()),'新回复不得被误认为旧任务运行来源')
})

test('普通群回复停止不需要任务，未知回执复用同一请求，原任务停止仍走旧端口',async()=>{
 assert.deepEqual(groupRunStopTargets(status([recipient('running'),recipient('unknown'),recipient('completed')])),[
  {roleId,name:'群聊员工',phase:'running',replyExecutionId},
  {roleId,name:'群聊员工',phase:'unknown',replyExecutionId},
 ])
 const calls:{endpoint:string;input:unknown}[]=[],taskId=randomUUID(),runId=randomUUID(),legacy:unknown[]=[]
 let attempt=0
 const api=createGroupRoutingApi(async(endpoint,input)=>{
  calls.push({endpoint,input});if(++attempt===1)throw Error('回执连接中断')
  return {replyExecutionId,state:'stopped'}
 },{stop:async input=>{legacy.push(input)}})
 await assert.rejects(api.stopReply({groupId,replyExecutionId}),/回执连接中断/)
 await api.stopReply({groupId,replyExecutionId})
 assert.deepEqual(calls[0],calls[1]);assert.equal(calls[0]!.endpoint,'groups/replies/stop')
 assert.deepEqual(Object.keys(calls[0]!.input as object).sort(),['groupId','replyExecutionId','requestId'])
 await api.stopRun({taskId,runId});assert.deepEqual(legacy,[{taskId,runId}])
 const invalid=createGroupRoutingApi(async()=>({replyExecutionId:randomUUID(),state:'stopped'}))
 await assert.rejects(invalid.stopReply({groupId,replyExecutionId}),/原执行不一致/)
})
