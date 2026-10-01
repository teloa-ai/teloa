import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createBusinessTaskHandler,readRunBusinessTaskContext} from '../src/business-tasks.ts'

const taskId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222'
const reference={scope:'SOC',type:'alert',id:'evt-1842',version:1,snapshotHash:'a'.repeat(64)}
const task={id:taskId,ownerId:'local:owner',title:'调查：异常脚本与外联',goal:'调查',scope:'SOC',groupId:null,skills:[],version:1,state:'ready',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:'2026-09-12T01:00:03.000Z',updatedAt:'2026-09-12T01:00:03.000Z'}
const source={schema:'teloa.business-task-source/v1',taskId,ownerId:'local:owner',sourceId:'security-alert-http',reference,createdAssignee:null,createdAt:'2026-09-12T01:00:03.000Z'}
const createInput={requestId,reference,goal:'调查'}
const item=(task:unknown,source:unknown)=>({task,source,progress:null,completion:null})
const withFacts=(response:any)=>({...response,...(response.items?{items:response.items.map((row:any)=>({...row,progress:null,completion:null}))}:{})})

test('宿主装配复用台账的已登记业务范围读取器',()=>{
 const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8')
 assert.match(source,/createBusinessTaskHandler\(owner,businessScopeIds,async\(\)=>/)
})

test('业务对象任务接口固定本人和已登记业务范围并分派创建与来源读取',async()=>{
 const calls:Array<{method:string;actor:unknown;input:unknown}>=[],service={
  create:async(actor:unknown,input:unknown)=>{calls.push({method:'create',actor,input});return {task,source}},
  source:async(actor:unknown,input:unknown)=>{calls.push({method:'source',actor,input});return source},
 }
 const handler=createBusinessTaskHandler('local:owner',async()=>['SOC'],async()=>service as never)
 assert.deepEqual(await handler('business-tasks/create',createInput),{task,source})
 assert.deepEqual(await handler('business-tasks/source',{taskId}),source)
 assert.deepEqual(calls,[
  {method:'create',actor:{ownerId:'local:owner',scopeIds:['SOC']},input:createInput},
  {method:'source',actor:{ownerId:'local:owner',scopeIds:['SOC']},input:{taskId}},
 ])
 await assert.rejects(handler('business-tasks/delete',{}),{code:'teloa/not-found'})
})

test('业务对象任务 RPC 拒绝跨本人、跨已登记范围与非法来源形状的宿主回包',async()=>{
 const mutations=[
  {task:{...task,ownerId:'other'},source},
  {task:{...task,unexpected:true},source},
  {task,source:{...source,ownerId:'other'}},
  {task,source:{...source,schema:'teloa.business-task-source/v2'}},
  {task,source:{...source,reference:{...reference,scope:'AppSec'}}},
  {task,source:{...source,taskId:'33333333-3333-4333-8333-333333333333'}},
  {task,source:{...source,sourceId:'\n来源不合法'}},
  {task,source:{...source,reference:{...reference,snapshotHash:'b'.repeat(64)}}},
  {task,source:{...source,unexpected:true}},
 ]
 for(const response of mutations){
  const handler=createBusinessTaskHandler('local:owner',async()=>['SOC'],async()=>({create:async()=>response,source:async()=>response.source}) as never)
  await assert.rejects(handler('business-tasks/create',createInput),{code:'teloa/invalid-host-response'})
 }
 const handler=createBusinessTaskHandler('local:owner',async()=>['SOC'],async()=>({create:async()=>({task,source}),source:async()=>({...source,ownerId:'other'})}) as never)
 await assert.rejects(handler('business-tasks/source',{taskId}),{code:'teloa/invalid-host-response'})
})

test('MCP 工具来源身份带斜杠时，创建、固定来源回读与业务目录保持原值',async()=>{
 const mcpSource={...source,sourceId:'acc_business_sync/list_items'}
 const {goal:_,groupId:__,skills:___,...summary}=task
 const service={create:async()=>({task,source:mcpSource}),source:async()=>mcpSource,listForScope:async()=>({items:[item(summary,mcpSource)]})}
 const handler=createBusinessTaskHandler('local:owner',async()=>['SOC'],async()=>service as never)
 assert.deepEqual(await handler('business-tasks/create',createInput),{task,source:mcpSource})
 assert.deepEqual(await handler('business-tasks/source',{taskId}),mcpSource)
 assert.deepEqual(await handler('business-tasks/list-for-scope',{scope:'SOC'}),{items:[item(summary,mcpSource)]})
})

test('合法最长 MCP 来源的任务回包在创建和目录中保留完整身份',async()=>{
 const longSource={...source,sourceId:'s'.repeat(64)+'/'+'t'.repeat(128)}
 const {goal:_,groupId:__,skills:___,...summary}=task
 const handler=createBusinessTaskHandler('local:owner',async()=>['SOC'],async()=>({
  create:async()=>({task,source:longSource}),source:async()=>longSource,listForScope:async()=>({items:[item(summary,longSource)]}),
 }) as never)
 assert.deepEqual(await handler('business-tasks/create',createInput),{task,source:longSource})
 assert.deepEqual(await handler('business-tasks/source',{taskId}),longSource)
 assert.deepEqual(await handler('business-tasks/list-for-scope',{scope:'SOC'}),{items:[item(summary,longSource)]})
})

test('已登记的非 SOC 范围按该范围建任务，来源不再绑定安全告警数据源',async()=>{
 const appSecReference={...reference,scope:'AppSec',type:'finding',id:'finding-1024'}
 const appSecTask={...task,title:'调查：暴露密钥',scope:'AppSec'}
 const appSecSource={...source,sourceId:'vendor.appsec-findings',reference:appSecReference}
 const calls:unknown[]=[]
 const handler=createBusinessTaskHandler('local:owner',async()=>['AppSec'],async()=>({
  create:async(actor:unknown)=>{calls.push(actor);return {task:appSecTask,source:appSecSource}},
  source:async(actor:unknown)=>{calls.push(actor);return appSecSource},
 }) as never)
 const input={...createInput,reference:appSecReference}
 assert.deepEqual(await handler('business-tasks/create',input),{task:appSecTask,source:appSecSource})
 assert.deepEqual(await handler('business-tasks/source',{taskId}),appSecSource)
 assert.deepEqual(calls,[{ownerId:'local:owner',scopeIds:['AppSec']},{ownerId:'local:owner',scopeIds:['AppSec']}])
})

test('未登记范围在调用宿主前就被拒绝',async()=>{
 let called=false
 const handler=createBusinessTaskHandler('local:owner',async()=>['SOC'],async()=>({
  create:async()=>{called=true;return {task,source}},
  source:async()=>source,
 }) as never)
 await assert.rejects(handler('business-tasks/create',{...createInput,reference:{...reference,scope:'AppSec'}}),{code:'teloa/forbidden'})
 assert.equal(called,false)
})

test('通用工作的执行准备不去问业务依据，真实业务范围照旧读取',async()=>{
 const object={scope:'SOC',type:'alert',id:'evt-1842',version:1,snapshotHash:'a'.repeat(64)}
 const asked:unknown[]=[],read=async(actor:unknown,input:unknown)=>{asked.push({actor,input});return {source,object} as never}
 // 隔离宿主实测：通用工作任务问一次业务依据就被身份闸判 teloa/forbidden，整次执行准备随之失败。
 assert.equal(await readRunBusinessTaskContext('local:owner',{id:taskId,scope:'general'},read),undefined)
 assert.deepEqual(asked,[])
 assert.deepEqual(await readRunBusinessTaskContext('local:owner',{id:taskId,scope:'SOC'},read),{taskId,sourceId:'security-alert-http',object})
 assert.deepEqual(asked,[{actor:{ownerId:'local:owner',scopeIds:['SOC']},input:{taskId}}])
 assert.equal(await readRunBusinessTaskContext('local:owner',{id:taskId,scope:'AppSec'},async()=>null),undefined)
})

test('业务/对象窄列表传真实单scope、分页原样传递，任务摘要不冒造goal或正文',async()=>{
 const {goal:_,groupId:__,skills:___,...summary}=task,page={items:[item(summary,source)],nextCursor:'opaque-next'},calls:unknown[]=[]
 const handler=createBusinessTaskHandler('local:owner',async()=>['SOC','AppSec'],async()=>({listForScope:async(actor:unknown,input:unknown)=>{calls.push({actor,input});return page},listForObject:async(actor:unknown,input:unknown)=>{calls.push({actor,input});return page}}) as never)
 assert.deepEqual(await handler('business-tasks/list-for-scope',{scope:'SOC',limit:2}),page)
 assert.deepEqual(await handler('business-tasks/list-for-object',{scope:'SOC',type:'alert',id:reference.id,limit:2,cursor:'original-cursor'}),page)
 assert.deepEqual(calls,[{actor:{ownerId:'local:owner',scopeIds:['SOC']},input:{scope:'SOC',limit:2}},{actor:{ownerId:'local:owner',scopeIds:['SOC']},input:{scope:'SOC',type:'alert',id:reference.id,limit:2,cursor:'original-cursor'}}])
})
test('进度与固定成果只接受同一真实任务可核验的窄回包',async()=>{
 const {goal:_,groupId:__,skills:___,...summary}=task,runId='33333333-3333-4333-8333-333333333333',artifactId='44444444-4444-4444-8444-444444444444'
 const completed={...summary,state:'completed',version:3,assigneeRoleId:'55555555-5555-4555-8555-555555555555',assigneeRoleVersion:2},progress={runId,state:'ended',reason:'completed',stopRequestedAt:null},completion={artifactId,version:1,title:'已验收报告',completedAt:'2026-09-30T00:00:00.000Z'}
 const make=(entry:unknown)=>createBusinessTaskHandler('local:owner',async()=>['SOC'],async()=>({listForScope:async()=>({items:[entry]})}) as never)
 assert.deepEqual(await make({task:completed,source,progress,completion})('business-tasks/list-for-scope',{scope:'SOC'}),{items:[{task:completed,source,progress,completion}]})
 for(const entry of [
  {task:completed,source,progress,completion:{...completion,artifactId:'other'}},
  {task:completed,source,progress:{...progress,runId:'other'},completion},
  {task:completed,source,progress:{...progress,reason:null},completion},
  {task:summary,source,progress,completion},
  {task:completed,source,progress,completion:null},
  {task:{...completed,assigneeRoleId:null,assigneeRoleVersion:null},source,progress,completion:null},
  {task:completed,source,progress,completion:{...completion,title:''}},
 ])await assert.rejects(make(entry)('business-tasks/list-for-scope',{scope:'SOC'}),{code:'teloa/invalid-host-response'})
})
test('窄列表在服务前拒绝身份/范围/分页漂移；回包核task/source当前授权与原对象',async()=>{
 const {goal:_,groupId:__,skills:___,...summary}=task
 let calls=0,response:unknown={items:[item(summary,null)]}
 const handler=createBusinessTaskHandler('local:owner',async()=>['SOC'],async()=>({listForScope:async()=>{calls++;return response},listForObject:async()=>{calls++;return response}}) as never)
 assert.deepEqual(await handler('business-tasks/list-for-scope',{scope:'SOC'}),response)
 const before=calls
 for(const payload of [{scope:'general'},{scope:'AppSec'},{scope:'SOC',ownerId:'other'},{scope:'SOC',limit:51},{scope:'SOC',limit:0},{scope:'SOC',cursor:''}])await assert.rejects(handler('business-tasks/list-for-scope',payload))
 assert.equal(calls,before)
 for(const value of [{items:[{task:{...summary,ownerId:'foreign'},source}]},{items:[{task:{...summary,scope:'AppSec'},source}]},{items:[{task:summary,source:null}]},{items:[{task:summary,source:{...source,reference:{...reference,id:'different'}}}]},{items:[{task:summary,source},{task:summary,source}]},{items:[],nextCursor:'orphan'}]){
  response=withFacts(value);await assert.rejects(handler('business-tasks/list-for-object',{scope:'SOC',type:'alert',id:reference.id}),{code:'teloa/invalid-host-response'})
 }
})
test('本人明确确认的任务title传给真实业务create并核对，不能与固定action同时提供',async()=>{
 const title='跟进客户需求',confirmed={...task,title},payload={...createInput,title}
 let received:unknown
 const handler=createBusinessTaskHandler('local:owner',async()=>['SOC'],async()=>({create:async(_actor:unknown,input:unknown)=>{received=input;return {task:confirmed,source}}}) as never)
 assert.deepEqual(await handler('business-tasks/create',payload),{task:confirmed,source});assert.deepEqual(received,payload)
 await assert.rejects(handler('business-tasks/create',{...payload,actionId:'fixed-action'}),{code:'teloa/invalid-input'})
 confirmed.title='其它任务';await assert.rejects(handler('business-tasks/create',payload),{code:'teloa/invalid-host-response'})
})
