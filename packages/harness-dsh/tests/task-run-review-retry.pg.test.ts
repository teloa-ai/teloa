import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool,stopTestContainer,type PoolClient} from '../../backend/tests/postgres-test-lifecycle.ts'
import {initializeTeloaDatabase,TaskService,ConversationWorkService,TaskRunService,ObjectConversationService,workRequestChildId,type TaskRun} from '@teloa/backend'
import {createAssistantMessage,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionSeq,type SessionEvent} from '@deepseek-ai/dsh-session'
import {createTaskRunHandler} from '../src/task-runs.ts'
import type {TaskRunPorts} from '../src/task-run-driver.ts'
const identity={id:randomUUID,now:()=>new Date().toISOString()}

test('真实PG：completed复核失败只按原grant/目标/blocked版本重试一次，pending/已交付/改目标/停止拒绝',{timeout:90000},async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri()}),locks=new Pool({connectionString:container.getConnectionUri()})
 t.after(async()=>{await locks.end();await pool.end();await stopTestContainer(container)})
 await initializeTeloaDatabase(pool)
 const fixture=async()=>{
  const owner=randomUUID(),source={sessionId:'retry-source-'+randomUUID(),requestId:randomUUID(),messageId:randomUUID(),messageSeq:1},parent={sessionId:source.sessionId,requestId:source.requestId,executor:'general' as const}
  const requests=new ConversationWorkService(pool,identity.now,async()=>({ownerId:owner,sessionId:source.sessionId,status:'ready',submitted:true}),undefined,undefined,locks)
  await requests.reserve(owner,{...source,kind:'task',executor:'general',scope:'general',title:'纯计算复核恢复',goal:'37×23并说明过程',sourceText:'只计算，不访问外网、不改文件'})
  const task=await new TaskService(pool,identity).createForConversation(owner,parent),sessionId='task-run-'+workRequestChildId(source.requestId,'run'),ids=new Map<string,string>()
  const inspect=async(actor:string,id:string)=>{if(!ids.has(id))ids.set(id,randomUUID());return {ownerId:actor,sessionId:id,id:ids.get(id)!,status:'ready'}}
  const links=new ObjectConversationService(pool,inspect,identity.now),runs=new TaskRunService(pool,identity,inspect)
  await links.change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  const run=await runs.prepareOwner(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,executor:task.executor,sessionId,expectedLinkVersion:1},{agentPresetId:'teloa-standard'})
  await runs.claim(owner,{runId:run.id})
  const events:SessionEvent[]=[{seq:SessionSeq(0),time:1,type:'turn/start',data:{turn:0}},{seq:SessionSeq(1),time:2,type:'user/message',surfaceOp:'append',data:createUserMessage({source:{kind:'user',rpcId:run.nativeRequestId},content:[{type:'text',text:run.inputText}]})},{seq:SessionSeq(2),time:3,type:'assistant/message',surfaceOp:'append',data:{turn:0,step:0,message:createAssistantMessage({source:{provider:'fixed',model:'fixed'},content:[{type:'text',text:'37×(20+3)=740+111=851。'}]}),stream:[]}},{seq:SessionSeq(3),time:4,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}}]
  const ended=await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:3,reason:'completed'}})
  await runs.ownerResultBlocked(owner,ended.id)
  return {owner,parent,requests,task,runs,links,inspect,ended,events}
 }
 const f=await fixture(),signal=new AbortController().signal,before=(await pool.query('select * from teloa_task_runs where id=$1',[f.ended.id])).rows[0]
 assert.equal(await f.runs.retryTaskVersion(f.owner,f.ended),4)
 const check=async(run:TaskRun,mutation?:(db:PoolClient)=>Promise<unknown>)=>{const db=await pool.connect();try{await db.query('begin');await mutation?.(db);const lease=await f.runs.retryAdmissionInTransaction(db,f.owner,run.id);lease.assertCurrent()}finally{await db.query('rollback');db.release()}}
 await check(f.ended)
 for(const sql of ["update teloa_task_runs set owner_result_pending=true where id=$1","update teloa_tasks set state='waiting' where id=(select task_id from teloa_task_runs where id=$1)","update teloa_tasks set version=version+1 where id=(select task_id from teloa_task_runs where id=$1)","update teloa_tasks set definition=jsonb_set(definition,'{goal}','\"不同目标\"') where id=(select task_id from teloa_task_runs where id=$1)"]){await assert.rejects(check(f.ended,db=>db.query(sql,[f.ended.id])),{code:'teloa/conflict'})}
 // 原Task已存在任何正式成果时，即使状态被改回blocked，也不能当作未交付重跑。
 await assert.rejects(check(f.ended,async db=>{
  const artifactId=randomUUID();await db.query("insert into teloa_artifacts(id,owner_id,request_id,request_spec,source_key,current_version) values($1,$2,$3,'{}','test',1)",[artifactId,f.owner,randomUUID()])
  await db.query("insert into teloa_artifact_versions(owner_id,artifact_id,number,source,content,created_at) values($1,$2,1,$3,'{}',now())",[f.owner,artifactId,JSON.stringify({kind:'task',id:f.task.id,scope:'general'})])
 }),{code:'teloa/conflict'})
 let delivery:'saved'|'review-required'|'unknown'='review-required',prepared=0,resumeChecks=0
 const ports:TaskRunPorts={check:async()=>{},send:async()=>assert.fail('prepare不执行模型'),stop:async()=>assert.fail('prepare不停止原Run'),events:async()=>f.events,resolvePreset:async()=> 'teloa-standard',backgroundState:async()=>({outstanding:false,interrupted:false}),retryOwnerOnlyBackground:async()=>true,reviewSubagents:async()=>[],subagentState:async()=> 'none',flowState:async()=> 'none',stopState:async()=>({running:false,settledSeq:3}),goalObservation:async()=>undefined,prepareRetry:async run=>{resumeChecks++;const db=await pool.connect();try{await db.query('begin');(await f.runs.retryAdmissionInTransaction(db,f.owner,run.id)).assertCurrent();await db.query('commit')}catch(e){await db.query('rollback');throw e}finally{db.release()}}}
 const handler=createTaskRunHandler(f.owner,async()=>f.runs,ports,undefined,{conversations:{runReservation:async()=>null,failRunReservation:async()=>false,createRun:async(actor,input,fixed)=>{prepared++;const row=await f.inspect(actor,fixed.sessionId);return {id:row.id,ownerId:actor,requestId:(input as {requestId:string}).requestId,title:'纯计算复核恢复',version:1,status:'ready',sessionId:fixed.sessionId,requestedSessionId:fixed.sessionId,scopeIds:['general'],purpose:'task-run',run:{taskId:fixed.taskId,taskVersion:fixed.taskVersion,roleId:null,roleVersion:null,executor:fixed.executor!,agentPresetId:fixed.agentPresetId},createdAt:identity.now()}}},links:f.links},{listMany:async()=>new Map()},undefined,{listMany:async()=>new Map()},undefined,{read:async()=>({state:delivery})})
 for(const state of ['saved','unknown'] as const){delivery=state;await assert.rejects(handler('task-runs/retry',{runId:f.ended.id},signal,f.parent),{code:'teloa/conflict'})}
 assert.equal(prepared,0);delivery='review-required'
 await assert.rejects(handler('task-runs/retry',{runId:f.ended.id},signal),{code:'teloa/conflict'})
 const retry=await handler('task-runs/retry',{runId:f.ended.id},signal,f.parent)
 assert.equal(retry.taskId,f.task.id);assert.deepEqual(retry.executor,f.task.executor);assert.equal(retry.taskVersion,4);assert.equal(retry.sessionId,'task-run-'+workRequestChildId(f.parent.requestId,'run-retry:'+f.ended.id));assert.equal(prepared,1);assert.equal(resumeChecks,1)
 const repeated=await handler('task-runs/retry',{runId:f.ended.id},signal,f.parent);assert.equal(repeated.id,retry.id);assert.equal(prepared,1);assert.equal((await f.runs.list(f.owner,{taskId:f.task.id})).length,2)
 assert.deepEqual((await pool.query('select * from teloa_task_runs where id=$1',[f.ended.id])).rows[0],before)
 const stopped=await fixture();await stopped.requests.stop(stopped.owner,{sessionId:stopped.parent.sessionId,requestId:stopped.parent.requestId})
 const db=await pool.connect();try{await db.query('begin');await assert.rejects(stopped.runs.retryAdmissionInTransaction(db,stopped.owner,stopped.ended.id));await db.query('rollback')}finally{db.release()}
})
