import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {TaskService} from '../src/work/tasks.ts'
import {workRequestChildId} from '../src/work/conversation-work.ts'

// 纯边界探针只证明真实 TaskService 调用路径不会忽略已关闭父请求；数据库锁与迁移另用真 PG 验证。
test('已停止的父交办拒绝确定子 Task 新建，在任何写入之前退出',async()=>{
 const owner=randomUUID(),parentId=randomUUID(),roleId=randomUUID(),child=workRequestChildId(parentId,'task',roleId),writes:string[]=[]
 const parent={owner_id:owner,request_id:parentId,task_child_request_id:child,request_spec:{requestId:parentId,kind:'task',roleId,scope:'general',expectedRoleVersion:1},targets:[{roleId,scope:'general',roleVersion:1}],stopped_at:new Date()}
 const db={query:async(sql:string,values:unknown[]=[])=>{
  if(sql.includes('teloa_conversation_work_requests'))return {rows:[parent],rowCount:1}
  if(sql.startsWith('insert into teloa_tasks')){writes.push(sql);return {rows:[{id:randomUUID(),owner_id:owner,definition:{title:'固定任务',goal:'原交办目标',scope:'general',groupId:null,skills:[]},version:1,state:'ready',assignee_role_id:null,assignee_role_version:null,created_at:new Date(),updated_at:new Date()}]}}
  if(sql.includes('teloa_tasks'))return {rows:[],rowCount:0}
  if(sql.startsWith('select pg_advisory_xact_lock'))return {rows:[]}
  throw Error('unexpected query: '+sql+' '+JSON.stringify(values))
 }} as unknown as PoolClient
 const service=new TaskService({} as Pool,{id:randomUUID,now:()=>new Date().toISOString()})
 await assert.rejects(service.createInTransaction(db,owner,{requestId:child,fields:{title:'固定任务',goal:'原交办目标',scope:'general'}}),{code:'teloa/conflict'})
 assert.deepEqual(writes,[])
})

for(const operation of ['create','request'] as const)for(const saved of [false,true])test('R3 普通'+operation+'不能冒用在效父任务，'+(saved?'已有同字节回执也拒绝':'尚无Task时拒绝'),async()=>{
 const owner=randomUUID(),parentId=randomUUID(),roleId=randomUUID(),child=workRequestChildId(parentId,'task',roleId),writes:string[]=[]
 const parent={owner_id:owner,session_id:'origin',request_id:parentId,task_child_request_id:child,request_spec:{requestId:parentId,kind:'task',roleId,scope:'general',expectedRoleVersion:1},targets:[{roleId,scope:'general',roleVersion:1}],stopped_at:null}
 const task={id:randomUUID(),owner_id:owner,definition:{title:'固定任务',goal:'原交办目标',scope:'general',groupId:null,skills:[]},same_request:true,version:1,state:'ready',assignee_role_id:roleId,assignee_role_version:1,created_at:new Date(),updated_at:new Date()}
 const db={query:async(sql:string)=>{
  if(sql.includes('teloa_conversation_work_requests'))return {rows:[parent],rowCount:1}
  if(sql.startsWith('insert into teloa_tasks')){writes.push(sql);return {rows:[task]}}
  if(sql.includes('teloa_tasks'))return {rows:saved?[task]:[],rowCount:saved?1:0}
  if(sql.startsWith('select pg_advisory_xact_lock')||['begin','commit','rollback'].includes(sql))return {rows:[]}
  if(sql.includes('teloa_roles'))return {rows:[{id:roleId,owner_id:owner,version:1,state:'active',definition:{name:'调查员',kind:'employee',scopes:['general'],duty:'核对',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[]}}]}
  throw Error('unexpected query: '+sql)
 },release:()=>{}} as unknown as PoolClient
 const service=new TaskService({connect:async()=>db,query:db.query} as unknown as Pool,{id:randomUUID,now:()=>new Date().toISOString()})
 await assert.rejects(operation==='create'?service.create(owner,{requestId:child,fields:{title:'固定任务',goal:'原交办目标',scope:'general'}}):service.request(owner,{requestId:child}),{code:'teloa/conflict'})
 assert.deepEqual(writes,[])
})
