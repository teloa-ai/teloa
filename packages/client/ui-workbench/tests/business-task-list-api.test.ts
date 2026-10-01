import test from 'node:test'
import assert from 'node:assert/strict'
import {createBusinessTaskListApi} from '../src/client/business-task-list-api.ts'

const id='10000000-0000-4000-8000-000000000001',owner='owner:test',scope='sales'
const task={id,ownerId:owner,title:'跟进客户',scope,version:2,state:'waiting',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:'2026-09-29T00:00:00.000Z',updatedAt:'2026-09-29T01:00:00.000Z'}
const source={schema:'teloa.business-task-source/v1',taskId:id,ownerId:owner,sourceId:'local-configuration',reference:{scope,type:'customer',id:'customer-1',version:3,snapshotHash:'a'.repeat(64)},createdAssignee:null,createdAt:task.createdAt}
const item=(target:unknown,origin:unknown)=>({task:target,source:origin,progress:null,completion:null})
const withFacts=(response:any)=>({...response,...(response.items?{items:response.items.map((row:any)=>({...row,progress:null,completion:null}))}:{})})

test('只读 scope 目录保留真实状态、空来源和不透明分页，不读取额外范围',async()=>{
 const calls:unknown[]=[],signal=new AbortController().signal
 const api=createBusinessTaskListApi(async(...args)=>{calls.push(args);return {items:[item(task,null)],nextCursor:'opaque'}},owner)
 const page=await api.list({scope,limit:1},signal)
 assert.deepEqual(calls,[['business-tasks/list-for-scope',{scope,limit:1},signal]])
 assert.deepEqual(page,{items:[item(task,null)],nextCursor:'opaque'})
})

test('对象目录保持原历史快照，不把当前对象版本当筛选条件',async()=>{
 const calls:unknown[]=[],api=createBusinessTaskListApi(async(...args)=>{calls.push(args);return {items:[item(task,source)]}},owner)
 const page=await api.list({scope,object:{type:'customer',id:'customer-1'},cursor:'opaque'})
 assert.deepEqual(calls,[['business-tasks/list-for-object',{scope,type:'customer',id:'customer-1',limit:20,cursor:'opaque'},undefined]])
 assert.deepEqual(page.items[0]?.source?.reference,source.reference)
})

test('非法范围、对象、分页在发请求前拒绝，无默认 owner',async()=>{
 let calls=0;const api=createBusinessTaskListApi(async()=>{calls++;return {items:[]}},owner)
 for(const input of [{scope:'general'},{scope:'sales',limit:51},{scope,limit:0},{scope,limit:null},{scope,cursor:''},{scope,object:{type:'customer',id:''}},{scope,extra:true}])await assert.rejects(api.list(input as never))
 assert.equal(calls,0)
 assert.throws(()=>createBusinessTaskListApi(async()=>({items:[]}),''))
})

test('拒绝跨本人/范围/对象、错误来源、未知字段、重复和畸形目录',async()=>{
 const bad=[
  {items:[{task:{...task,ownerId:'other'},source:null}]},
  {items:[{task:{...task,scope:'support'},source:null}]},
  {items:[{task:{...task,goal:'不应复制正文'},source:null}]},
  {items:[{task:{...task,state:'succeeded'},source:null}]},
  {items:[{task:{...task,assigneeRoleId:id},source:null}]},
  {items:[{task:{...task,createdAt:'bad'},source:null}]},
  {items:[{task,source:{...source,taskId:'20000000-0000-4000-8000-000000000001'}}]},
  {items:[{task,source:{...source,reference:{...source.reference,scope:'support'}}}]},
  {items:[{task,source:null},{task,source:null}]},
  {items:[],nextCursor:'cursor'}, {items:[],unexpected:true},
 ]
 for(const response of bad)await assert.rejects(createBusinessTaskListApi(async()=>withFacts(response),owner).list({scope}))
 for(const response of [{items:[{task,source:null}]},{items:[{task,source:{...source,reference:{...source.reference,id:'other'}}}]}])await assert.rejects(createBusinessTaskListApi(async()=>withFacts(response),owner).list({scope,object:{type:'customer',id:'customer-1'}}))
 await assert.rejects(createBusinessTaskListApi(async()=>({items:[item(task,null),item({...task,id:'20000000-0000-4000-8000-000000000001'},null)]}),owner).list({scope,limit:1}))
})

test('权限错误与取消不变成空列表',async()=>{
 const error=Object.assign(Error('forbidden'),{code:'teloa/forbidden'})
 await assert.rejects(createBusinessTaskListApi(async()=>{throw error},owner).list({scope}),value=>value===error)
})
test('Run 结束不等于已验收，畸形进度或成果摘要不进入正式业务页',async()=>{
 const runId='30000000-0000-4000-8000-000000000003',artifactId='40000000-0000-4000-8000-000000000004'
 const progress={runId,state:'ended',reason:'completed',stopRequestedAt:null},completion={artifactId,version:1,title:'验收版本',completedAt:'2026-09-30T00:00:00.000Z'}
 const completed={...task,state:'completed',assigneeRoleId:'50000000-0000-4000-8000-000000000005',assigneeRoleVersion:1}
 const api=createBusinessTaskListApi(async()=>({items:[{task:completed,source:null,progress,completion}]}),owner)
 assert.deepEqual((await api.list({scope})).items[0]?.completion,completion)
 for(const entry of [
  {...item(task,null),progress:{...progress,reason:null}},
  {...item(task,null),progress:{...progress,state:'active',reason:'completed'}},
  {...item(task,null),completion},
  {...item(completed,null),progress,completion:null},
  {...item({...completed,assigneeRoleId:null,assigneeRoleVersion:null},null),progress,completion:null},
  {...item(completed,null),progress,completion:{...completion,artifactId:'foreign'}},
 ])await assert.rejects(createBusinessTaskListApi(async()=>({items:[entry]}),owner).list({scope}))
})
