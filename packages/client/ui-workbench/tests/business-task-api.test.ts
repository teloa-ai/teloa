import test from 'node:test'
import assert from 'node:assert/strict'
import {businessTaskSupports,createBusinessTaskApi} from '../src/client/business-task-api.ts'

const request={requestId:'11111111-1111-4111-8111-111111111111',reference:{scope:'SOC',type:'alert',id:'alert-42',version:3,snapshotHash:'a'.repeat(64)},goal:'核对横向移动迹象并形成调查结论。',actionId:'assign-alert-review',assignee:{roleId:'22222222-2222-4222-8222-222222222222',expectedVersion:4}}
const task={id:'33333333-3333-4333-8333-333333333333',ownerId:'local:owner',title:'调查：异常登录告警',goal:request.goal,scope:'SOC',groupId:null,skills:[],version:1,state:'ready' as const,assigneeRoleId:request.assignee.roleId,assigneeRoleVersion:4,createdAt:'2026-09-13T00:00:00.000Z',updatedAt:'2026-09-13T00:00:00.000Z'}
const source={schema:'teloa.business-task-source/v1' as const,taskId:task.id,ownerId:task.ownerId,sourceId:'security-alert-http',reference:request.reference,createdAssignee:{roleId:request.assignee.roleId,roleVersion:4},createdAt:task.createdAt}
type Call=(method:string,payload:unknown)=>Promise<unknown>
type Journal={read():string|null;write(value:string):void;clear():void}
function api(call:Call,journal?:Journal){return createBusinessTaskApi(call,journal,task.ownerId)}
const available={defaultAction:{available:true}} as never
test('业务真实任务复用完整 reader 接受内容版本和完成策略且保留本人及原始字段核验',async()=>{
 const current={...task,contentVersion:1,completionPolicy:{kind:'manual' as const}}
 assert.deepEqual(await api(async()=>({task:current,source})).create(request),{task:current,source})
 for(const invalid of [{...current,contentVersion:0},{...current,completionPolicy:{kind:'verified',verifier:'model-quality',verifierVersion:1,authorizationVersion:1}},{...current,ownerId:'other'},{...current,title:' '+task.title},{...current,updatedAt:'2026-01-01T00:00:00.000Z'},{...current,extra:true}])await assert.rejects(api(async()=>({task:invalid,source})).create(request),/格式|不一致/)
})

 test('客户端按台账动作能力展示入口，不维护 SOC 或来源标识白名单',()=>{
  assert.equal(businessTaskSupports('SOC',available),true)
  assert.equal(businessTaskSupports('AppSec',available),true)
  assert.equal(businessTaskSupports('general',available),false)
  assert.equal(businessTaskSupports('SOC',{defaultAction:{available:false}} as never),false)
  assert.equal(businessTaskSupports('SOC',undefined),false)
 })

test('AppSec 的动作请求可完整透传，来源以服务端固定回执为准',async()=>{
 const reference={...request.reference,scope:'AppSec'},appsec={...request,reference,actionId:'assign-finding-review'}
 const saved={task:{...task,scope:'AppSec'},source:{...source,sourceId:'appsec-finding-http',reference}}
 const client=api(async()=>saved)
 assert.deepEqual(await client.create(appsec),saved)
 await assert.rejects(client.create({...appsec,reference:{...reference,scope:'general'}}),/请求格式/)
 await assert.rejects(api(async()=>({...saved,source:{...saved.source,sourceId:' bad '}})).create(appsec),/不一致|格式/)
})

test('创建严格固定真实业务对象快照、动作、负责人版本和返回任务',async()=>{
 const calls:unknown[]=[]
 const client=api(async(method,payload)=>{calls.push([method,payload]);return {task,source}})
 assert.deepEqual(await client.create(request),{task,source})
 assert.deepEqual(calls,[['business-tasks/create',request]])
})

test('客户端保留合法最长 MCP 工具来源的固定任务身份',async()=>{
 const longSource={...source,sourceId:'s'.repeat(64)+'/'+'t'.repeat(128)}
 const client=api(async method=>method==='business-tasks/source'?longSource:{task,source:longSource})
 assert.deepEqual(await client.create(request),{task,source:longSource})
 assert.deepEqual(await client.source(task.id),longSource)
})

test('未知结果保留完整请求并以相同 requestId 恢复',async()=>{
 let raw:string|null=null,calls:unknown[]=[]
 const client=api(async(method,payload)=>{calls.push([method,payload]);if(calls.length===1)throw Error('连接中断');return {task,source}},{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}})
 await assert.rejects(client.create(request),/连接中断/)
 assert.deepEqual(client.pending(),request)
 assert.deepEqual(JSON.parse(raw!).request.reference,request.reference)
 assert.deepEqual(await client.recover(),{task,source})
 assert.equal(raw,null)
 assert.deepEqual(calls,[['business-tasks/create',request],['business-tasks/create',request]])
})

test('严格拒绝固定快照、负责人或来源格式与请求不一致的回包，并保留恢复记录',async()=>{
 for(const response of [
  {task,source:{...source,sourceId:' bad '}},
  {task,source:{...source,reference:{...source.reference,version:4}}},
  {task:{...task,assigneeRoleVersion:5},source},
  {task,source:{...source,ownerId:'other'}},
 ]){
  let raw:string|null=null
  const client=api(async()=>response,{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}})
  await assert.rejects(client.create(request),/不一致|格式/)
  assert.deepEqual(client.pending(),request)
  assert.ok(raw)
 }
})

test('只为明确无副作用的输入、授权或事务冲突拒绝清理恢复记录',async()=>{
 for(const code of ['teloa/invalid-input','teloa/forbidden','teloa/version-conflict','teloa/source-unavailable','teloa/conflict']){
  let raw:string|null=null
  const client=api(async()=>{throw Object.assign(Error(code),{rejected:true,code})},{read:()=>raw,write:value=>{raw=value},clear:()=>{raw=null}})
  await assert.rejects(client.create(request))
  assert.equal(client.pending(),undefined)
  assert.equal(raw,null)
 }
})

test('读取任务来源核对固定引用、本人和目标任务',async()=>{
 const client=api(async(method,payload)=>{assert.deepEqual([method,payload],['business-tasks/source',{taskId:task.id}]);return source})
 assert.deepEqual(await client.source(task.id),source)
 await assert.rejects(api(async()=>({...source,sourceId:' bad-source'})).source(task.id),/不一致|格式/)
})

test('恢复可接受创建后已编辑的当前任务，但仍固定原业务对象来源',async()=>{
 const edited={...task,version:2,goal:'后续补充的调查目标',assigneeRoleId:null,assigneeRoleVersion:null,updatedAt:'2026-09-13T00:01:00.000Z'}
 assert.equal((await api(async()=>({task:edited,source})).create(request)).task.goal,edited.goal)
})

test('不规范请求或回包不会被静默裁剪、改写，且回包必须属于预期负责人',async()=>{
 const upperTask={...task,id:task.id.toUpperCase()},upperSource={...source,taskId:upperTask.id}
 assert.equal((await api(async()=>({task:upperTask,source:upperSource})).create(request)).task.id,upperTask.id)
 await assert.rejects(api(async()=>({task:{...task,title:' '+task.title},source})).create(request),/不一致|格式/)
 await assert.rejects(api(async()=>({task:{...task,ownerId:'local:other'},source:{...source,ownerId:'local:other'}})).create(request),/不一致|格式/)
 let calls=0
 await assert.rejects(api(async()=>{calls++;return {task,source}}).create({...request,goal:' '+request.goal}),/请求格式/)
 assert.equal(calls,0)
})
