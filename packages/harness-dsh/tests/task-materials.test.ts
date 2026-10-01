import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import type {TaskMaterialService} from '@teloa/backend'
import type {TaskExecutionScope,TaskRunSkillDatabase} from '@teloa/backend'
import {createTaskMaterialHandler,createTaskMaterialKnowledgeLoader} from '../src/task-materials.ts'

test('任务知识 RPC 固定宿主本人并拒绝未知字段',async()=>{
 const calls:unknown[]=[]
 const service={
  list:async(owner:string,payload:unknown)=>{calls.push(['list',owner,payload]);return []},
  add:async(owner:string,payload:unknown)=>{calls.push(['add',owner,payload]);return {task:{},material:{}}},
 } as unknown as Pick<TaskMaterialService,'list'|'add'>
 const handler=createTaskMaterialHandler('local-owner',async()=>service)
 assert.deepEqual(await handler('tasks/materials',{taskId:'task'}),[])
 await handler('tasks/materials/add',{requestId:'request',taskId:'task',expectedTaskVersion:2,resourceId:'resource',expectedResourceVersion:1})
 assert.deepEqual(calls,[
  ['list','local-owner',{taskId:'task'}],
  ['add','local-owner',{requestId:'request',taskId:'task',expectedTaskVersion:2,resourceId:'resource',expectedResourceVersion:1}],
 ])
 await assert.rejects(handler('tasks/materials',{taskId:'task',ownerId:'forged'}),{code:'teloa/invalid-input'})
 await assert.rejects(handler('tasks/materials/remove',{taskId:'task'}),{code:'teloa/not-found'})
})

test('任务知识加载在 prepare 数据库连接内固定引用并复验资源版本',async()=>{
 const target:TaskExecutionScope={taskId:'task',taskVersion:3,sessionId:'session',linkVersion:2,scope:'SOC'}
 const database={query:async()=>({rows:[]})} as unknown as TaskRunSkillDatabase
 const text='任务补充知识',sourceVersion=createHash('sha256').update(text).digest('hex')
 const resourceId='d87222d1-d5a2-4d4b-8860-9b1bfd331ddb'
 const knowledge={id:resourceId,version:4,title:'SOP',sourceId:'markdown-knowledge',sourceVersion,scopeIds:['SOC'],text}
 const calls:unknown[]=[]
 const service={executionRefsInTransaction:async(...args:unknown[])=>{calls.push(args);return [{id:resourceId,version:4}]}}
 const read=async(...args:unknown[])=>{calls.push(args);return [knowledge]}
 const load=createTaskMaterialKnowledgeLoader('local-owner',async()=>service as never,read as never)
 const signal=new AbortController().signal
 assert.deepEqual(await load(target,{} as never,database,signal),[knowledge])
 assert.deepEqual(calls,[[database,'local-owner','task',3],[target,[{id:resourceId,version:4}],database,signal]])
})

test('任务知识加载拒绝正文读取时被静默换成其他版本',async()=>{
 const target:TaskExecutionScope={taskId:'task',taskVersion:3,sessionId:'session',linkVersion:2,scope:'SOC'}
 const database={query:async()=>({rows:[]})} as unknown as TaskRunSkillDatabase
 const text='新版正文',sourceVersion=createHash('sha256').update(text).digest('hex')
 const resourceId='d87222d1-d5a2-4d4b-8860-9b1bfd331ddb'
 const service={executionRefsInTransaction:async()=>[{id:resourceId,version:4}]}
 const read=async()=>[{id:resourceId,version:5,title:'SOP',sourceId:'markdown-knowledge',sourceVersion,scopeIds:['SOC'],text}]
 const load=createTaskMaterialKnowledgeLoader('local-owner',async()=>service as never,read as never)
 await assert.rejects(load(target,{} as never,database,new AbortController().signal),{code:'teloa/version-conflict'})
})

test('添加任务知识前先按资料体积预检，超限时不写任务',async()=>{
 const calls:unknown[]=[]
 const service={list:async()=>[],add:async()=>{calls.push('add');return {task:{},material:{}}}} as unknown as Pick<TaskMaterialService,'list'|'add'>
 const handler=createTaskMaterialHandler('local-owner',async()=>service,async(taskId,resourceId)=>{calls.push(['check',taskId,resourceId]);if(resourceId==='big')throw Object.assign(Error('只能加入本地检索使用'),{code:'teloa/invalid-input'})})
 await handler('tasks/materials',{taskId:'task'})
 await handler('tasks/materials/add',{requestId:'request',taskId:'task',expectedTaskVersion:2,resourceId:'small',expectedResourceVersion:1})
 await assert.rejects(handler('tasks/materials/add',{requestId:'request-2',taskId:'task',expectedTaskVersion:3,resourceId:'big',expectedResourceVersion:1}),{code:'teloa/invalid-input'})
 assert.deepEqual(calls,[['check','task','small'],'add',['check','task','big']])
})
