import test from 'node:test'
import assert from 'node:assert/strict'
import {createGroupReactionApi} from '../src/client/group-reaction-api.ts'
import {createGroupRoutingApi} from '../src/client/group-routing-api.ts'
import {createTaskRunApi} from '../src/client/task-run-api.ts'

const G='11111111-1111-4111-8111-111111111111'
const M='22222222-2222-4222-8222-222222222222'
const M2='33333333-3333-4333-8333-333333333333'
const R='44444444-4444-4444-8444-444444444444'

function calling(){
 const calls:[string,unknown][]=[]
 return {calls,call:async(endpoint:string,payload:unknown)=>{calls.push([endpoint,payload]);return undefined}}
}

test('toggle 的回执被逐字段核对，不符即抛',async()=>{
 const api=createGroupReactionApi(async()=>({messageId:'别的消息',items:[]}))
 await assert.rejects(()=>api.toggle(G,M,'👍'))
})

test('toggle 只提交白名单四键，同 requestId 在未核对完成时原样重放',async()=>{
 const log=calling()
 let attempt=0
 const api=createGroupReactionApi(async(endpoint,payload)=>{
  log.calls.push([endpoint,payload])
  attempt++
  if(attempt===1)throw Error('网络断开')
  return {messageId:M,items:[{messageId:M,emoji:'👍',count:1,mine:true,actors:[{actorKind:'self',actorId:'self'}]}]}
 })
 await assert.rejects(()=>api.toggle(G,M,'👍'))
 assert.deepEqual(Object.keys(log.calls[0]![1] as Record<string,unknown>).sort(),['emoji','groupId','messageId','requestId'])
 const items=await api.toggle(G,M,'👍')
 assert.equal(items.length,1)
 assert.deepEqual(log.calls[0]![1],log.calls[1]![1])
 assert.equal(api.pending(),undefined)
})

test('toggle 回执与请求身份不一致的确定性错误会清掉本地恢复记录',async()=>{
 let raw:string|null=null
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createGroupReactionApi(async()=>{throw Object.assign(Error('版本已变化'),{rejected:true,code:'teloa/version-conflict'})},journal)
 await assert.rejects(()=>api.toggle(G,M,'👍'))
 assert.equal(api.pending(),undefined)
 assert.equal(raw,null)
})

test('journal 预置未核对的表情请求：跨实例构造后 pending() 反映它，recover() 原样重放同一 requestId',async()=>{
 const requestId='c1234567-1234-4123-8123-123456789abc'
 const request={requestId,groupId:G,messageId:M,emoji:'👍' as const}
 let raw:string|null=JSON.stringify({schema:'teloa.group-reaction/v1',request})
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const sent:unknown[]=[]
 const api=createGroupReactionApi(async(_endpoint,payload)=>{sent.push(payload);return {messageId:M,items:[]}},journal)
 assert.deepEqual(api.pending(),request)
 const items=await api.recover()
 assert.deepEqual(items,[])
 assert.deepEqual(sent,[request])
 assert.equal(raw,null)
})

test('journal schema 不符或损坏：recoveryMessage() 有值，discard() 清掉',async()=>{
 const requestId='c1234567-1234-4123-8123-123456789abc'
 let raw:string|null=JSON.stringify({schema:'other/v1',request:{requestId,groupId:G,messageId:M,emoji:'👍'}})
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}}
 const api=createGroupReactionApi(async()=>{throw Error('不应调用')},journal)
 assert.ok(api.recoveryMessage())
 assert.equal(api.pending(),undefined)
 assert.equal(api.discard(),true)
 assert.equal(api.recoveryMessage(),undefined)
 assert.equal(raw,null)

 raw='{broken'
 const corrupt=createGroupReactionApi(async()=>{throw Error('不应调用')},journal)
 assert.ok(corrupt.recoveryMessage())
 assert.equal(corrupt.discard(),true)
 assert.equal(raw,null)
})

test('list 只提交两键，超两百在客户端就被拦',async()=>{
 const log=calling()
 const api=createGroupReactionApi(async(endpoint,payload)=>{log.calls.push([endpoint,payload]);return {items:[]}})
 await api.list(G,[M])
 assert.deepEqual(Object.keys(log.calls[0]![1] as Record<string,unknown>).sort(),['groupId','messageIds'])
 await assert.rejects(()=>api.list(G,new Array(201).fill(M)))
})

test('list 只接受属于本次请求的表情汇总，格式或归属不符即抛',async()=>{
 const valid={messageId:M,emoji:'👍',count:1,mine:false,actors:[{actorKind:'role',actorId:R}]}
 const api=createGroupReactionApi(async()=>({items:[valid]}))
 const items=await api.list(G,[M])
 assert.deepEqual(items,[valid])
 const foreign=createGroupReactionApi(async()=>({items:[{...valid,messageId:M2}]}))
 await assert.rejects(()=>foreign.list(G,[M]))
 const malformed=createGroupReactionApi(async()=>({items:[{...valid,count:0}]}))
 await assert.rejects(()=>malformed.list(G,[M]))
})

test('群内路由决策只读投影：白名单两键、不下发候选集、归属外泄即抛',async()=>{
 const log=calling()
 const view={messageId:M,kind:'routed' as const,respond:[R],hops:1}
 const api=createGroupRoutingApi(async(endpoint,payload)=>{log.calls.push([endpoint,payload]);return {items:[view]}})
 const items=await api.list(G,[M])
 assert.deepEqual(items,[view])
 assert.deepEqual(Object.keys(log.calls[0]![1] as Record<string,unknown>).sort(),['groupId','messageIds'])
 const foreign=createGroupRoutingApi(async()=>({items:[{...view,messageId:M2}]}))
 await assert.rejects(()=>foreign.list(G,[M]))
 // 混进 candidateIds 的整型会让 isGroupRoutingDecisionView 判假（该守卫恰四键，不认多余字段）。
 const leaked=createGroupRoutingApi(async()=>({items:[{...view,candidateIds:[R]}]}))
 await assert.rejects(()=>leaked.list(G,[M]))
})

const taskId='55555555-5555-4555-8555-555555555555',roleId='66666666-6666-4666-8666-666666666666',runId='77777777-7777-4777-8777-777777777777'
const baseRun={id:runId,taskId,roleId,taskVersion:1,roleVersion:1,linkVersion:1,sessionId:'session',nativeRequestId:runId,state:'prepared',evidence:null,allowedTools:[],memory:[],createdAt:'2026-09-21T10:00:00.000Z'}
const baseSnapshot={task:{id:taskId,version:1,title:'群任务',goal:'核对群消息',scope:'general'},role:{id:roleId,version:1,name:'群岗位',duty:'协作',dataScope:'只读',executionScope:'代拟'}}
const groupContext={taskId,groupId:G,groupVersion:1,roleId,roleVersion:1,grantVersion:1,source:{messageId:M,rootId:M,createdAt:'2026-09-21T09:00:00.000Z',text:'消息正文'},materials:[],files:[],notice:'群上下文提示'}
const groupReference={notice:'引用提示',handles:[]}
const groupTopic={notice:'话题提示',messages:[]}

test('执行记录顶层带 groupContext 键不再判「格式不正确」（键表补位修复群运行读回）',async()=>{
 const row={...baseRun,inputText:JSON.stringify(baseSnapshot),groupContext}
 const saved=(await createTaskRunApi(async()=>[row]).list(taskId))[0]!
 assert.equal(saved.taskId,taskId)
})

test('inputText 快照带 groupContext/groupReference/groupTopic 三键不再判「格式不正确」',async()=>{
 const row={...baseRun,inputText:JSON.stringify({...baseSnapshot,groupContext,groupReference,groupTopic})}
 const saved=(await createTaskRunApi(async()=>[row]).list(taskId))[0]!
 assert.equal(saved.taskId,taskId)
 // 旧行仍不带这三键：既有兼容路径一条不红。
 const legacy=(await createTaskRunApi(async()=>[{...baseRun,inputText:JSON.stringify(baseSnapshot)}]).list(taskId))[0]!
 assert.equal(legacy.taskId,taskId)
})
