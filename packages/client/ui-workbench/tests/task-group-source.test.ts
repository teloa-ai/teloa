import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createGroupApi} from '../src/client/group-api.ts'
import {shouldLoadGroupTaskSource,withGroupTaskSource} from '../src/client/group-task-source-presentation.ts'
import {projectSavedTask} from '../src/client/task-api.ts'
import type {GroupTaskSource,WorkTask} from '@teloa/contract'

const taskId='11111111-1111-4111-8111-111111111111'
const groupId='22222222-2222-4222-8222-222222222222'
const messageId='33333333-3333-4333-8333-333333333333'
const at='2026-09-20T00:00:00.000Z'

function groupTaskSource(patch:Partial<GroupTaskSource>={}):GroupTaskSource{
 return {
  schema:'teloa.group-task-source/v1',taskId,ownerId:'self',groupId,groupVersion:1,
  messageId,rootId:messageId,messageCreatedAt:at,messageText:'请核对这份异常访问。',
  references:[],createdAssignee:null,trigger:'manual',createdAt:at,...patch,
 }
}

function savedTask(patch:Partial<WorkTask>={}):WorkTask{
 return {
  id:taskId,ownerId:'self',title:'核对异常访问',goal:'核实异常访问范围并给出结论。',scope:'SOC',
  groupId:null,skills:[],version:1,state:'ready',assigneeRoleId:null,assigneeRoleVersion:null,
  createdAt:at,updatedAt:at,...patch,
 } as WorkTask
}

test('持久化路径读到群消息任务来源时，taskSource 按 TaskSource 形状并回，不臆造作者',()=>{
 const source=groupTaskSource()
 const projected=withGroupTaskSource(projectSavedTask(savedTask()),source)
 assert.deepEqual(projected.source,{groupId,messageId,rootId:messageId,text:'请核对这份异常访问。',trigger:'manual'})
 assert.equal('authorId' in projected.source!,false,'群消息任务来源记录没有作者字段，不能补一个假的进去')
})

test('群来源的 trigger 一并并回 TaskSource，属性栏能区分手动／提及／路由转出',()=>{
 assert.equal(withGroupTaskSource(projectSavedTask(savedTask()),groupTaskSource({trigger:'routed'})).source?.trigger,'routed')
})

test('非群消息任务（来源为 null）不带 source，且已带 source 的任务不用再问',()=>{
 const plain=projectSavedTask(savedTask())
 assert.equal(withGroupTaskSource(plain,null).source,undefined)
 assert.equal(shouldLoadGroupTaskSource(plain),true,'持久任务且还没有来源时才需要补拉')
 const withSource=withGroupTaskSource(plain,groupTaskSource())
 assert.equal(shouldLoadGroupTaskSource(withSource),false,'已经并回来源的任务不用再问一次')
 const {storage:_storage,...demo}=plain
 assert.equal(shouldLoadGroupTaskSource(demo),false,'非持久（演示）任务不走这条补拉路径')
})

test('group-api.taskSource 校验回包归属，任务身份或本人不一致时拒绝',async()=>{
 const calls:{endpoint:string;payload:unknown}[]=[]
 const api=createGroupApi(async(endpoint,payload)=>{calls.push({endpoint,payload});return groupTaskSource()})
 const result=await api.taskSource(taskId)
 assert.deepEqual(calls,[{endpoint:'groups/tasks/source',payload:{taskId}}])
 assert.equal(result?.taskId,taskId)

 await assert.rejects(createGroupApi(async()=>groupTaskSource({taskId:groupId})).taskSource(taskId),/群消息任务来源/)
 await assert.rejects(createGroupApi(async()=>groupTaskSource({ownerId:'other'})).taskSource(taskId),/群消息任务来源/)
})

test('group-api.taskSource 对不是群消息任务的持久任务回落 null，不当作错误',async()=>{
 const result=await createGroupApi(async()=>null).taskSource(taskId)
 assert.equal(result,null)
})

test('装配层把群来源接进任务投影，且补拉只发生在还没有来源的持久任务上',async()=>{
 const source=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8')
 assert.match(source,/withGroupTaskSource\(withBusinessTaskSource\(projectSavedTask\(row\),businessSources\.current\[row\.id\]\?\?null\),groupTaskSources\.current\[row\.id\]\?\?null\)/)
 assert.match(source,/if\(!shouldLoadGroupTaskSource\(task\)\|\|groupSourceLoads\.current\[task\.id\]\)continue/)
 assert.match(source,/groupApi\.taskSource\(task\.id\)/)
})
