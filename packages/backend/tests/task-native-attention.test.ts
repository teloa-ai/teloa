import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import {TaskAttentionService} from '../src/work/task-attention.ts'

// 此夹具只替代 PostgreSQL I/O；真实服务负责解析固定快照、事务边界、归属重核与投影。
// SQL 谓词由 task-attention.test.ts 在独立 PostgreSQL 上验证。
function fixture(){
 const owner='attention-owner',roleId=randomUUID(),taskId=randomUUID(),runId=randomUUID(),sessionId=randomUUID(),requestId=randomUUID(),nativeRequestId=randomUUID(),at=new Date('2026-10-30T00:00:00.000Z')
 const task={id:taskId,owner_id:owner,definition:{title:'等待工具审批的任务',goal:'核对证据',scope:'general'},version:2,state:'running',assignee_role_id:roleId,assignee_role_version:1,created_at:at,updated_at:at}
 const run={id:runId,owner_id:owner,task_id:taskId,task_version:1,task_state_version:2,role_id:roleId,role_version:1,request_id:requestId,session_id:sessionId,native_request_id:nativeRequestId,link_version:1,state:'active',stop_requested_at:null,created_at:at,allowed_tools:[],role_skills:[],role_knowledge:[],evidence:{state:'active',turn:0,messageSeq:1},request_spec:{requestId,taskId,expectedTaskVersion:1,roleId,expectedRoleVersion:1,sessionId,expectedLinkVersion:1},input_text:JSON.stringify({task:{id:taskId,version:1,title:'等待工具审批的任务',goal:'核对证据',scope:'general'},role:{id:roleId,version:1,name:'调查员',duty:'核对',dataScope:'本人资料',executionScope:'明确交办'}})}
 let committed=false,released=false,current=true
 const query=async(sql:string,args?:unknown[])=>{
  if(sql==='begin isolation level repeatable read read only')return {rows:[]}
  if(sql==='commit'){committed=true;return {rows:[]}}
  if(sql==='rollback')return {rows:[]}
  assert.equal(args?.[0],owner,'查询始终使用可信本人身份')
  if(sql.startsWith('select * from teloa_tasks'))return {rows:[task]}
  if(sql.startsWith('select r.*'))return {rows:[run]}
  if(sql.startsWith('select r.id')){assert.equal(committed&&released,true);assert.deepEqual(args?.[1],[runId]);return {rows:current?[{id:runId}]:[]}}
  assert.fail('unexpected query')
 }
 const pool={connect:async()=>({query,release:()=>{released=true}}),query} as unknown as Pool
 return {owner,task,run,runId,taskId,sessionId,nativeRequestId,pool,ready:()=>committed&&released,changed:()=>{current=false}}
}

test('真实任务目录服务在提交并释放 SQL 快照后读取固定 Run 原生审批',async()=>{
 const f=fixture(),seen:string[]=[]
 const page=await new TaskAttentionService(f.pool,async run=>{assert.equal(f.ready(),true);seen.push(run.id);assert.equal(run.nativeRequestId,f.nativeRequestId);return true}).list(f.owner,{})
 assert.deepEqual(seen,[f.runId])
 assert.equal(page.items[0]!.task.state,'running')
 assert.equal(page.items[0]!.attention,null)
 assert.deepEqual(page.items[0]!.nativeApproval,{runId:f.runId,sessionId:f.sessionId})
})

test('原生会话未知保留任务快照，读取后归属变化撤下旧审批',async()=>{
 const failed=fixture(),page=await new TaskAttentionService(failed.pool,async()=>{throw Error('offline')}).list(failed.owner,{})
 assert.equal(page.items.length,1);assert.equal(page.items[0]!.nativeApprovalUnknown,true);assert.equal(page.items[0]!.nativeApproval,undefined)
 const changed=fixture(),stale=await new TaskAttentionService(changed.pool,async()=>{changed.changed();return true}).list(changed.owner,{})
 assert.equal(stale.items.length,1);assert.equal(stale.items[0]!.nativeApproval,undefined);assert.equal(stale.items[0]!.nativeApprovalUnknown,undefined)
 const decided=fixture(),absent=await new TaskAttentionService(decided.pool,async()=>false).list(decided.owner,{})
 assert.equal(absent.items[0]!.nativeApproval,undefined)
})
