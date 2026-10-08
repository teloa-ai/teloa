import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setupRoleWork,roleFixture,insertRoleRun,identity,loadRoleWorkModule} from './role-work-test-fixture.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import {createRunRoleSnapshot} from '../src/work/run-role-snapshot.ts'
import {WorkControlService,initializeWorkControl} from '../src/work/work-control.ts'

test('恢复仅本人明确批准当前 checkpoint；未知拒绝，已受理不重发，旧冻结 input 不改',{timeout:15000},async()=>{
 const f=await setupRoleWork()
 try{
  f.pool.options.max=1 // 真实单连接池：所有恢复事务和谱系读口必须复用同一连接。
  const api=await loadRoleWorkModule('work-recovery');assert.equal(typeof api.WorkRecoveryService,'function','必须存在 checkpoint 恢复服务')
  await initializeWorkControl(f.pool);await api.initializeWorkRecovery(f.pool)
  const {owner,role,taskId,authorization}=await roleFixture(f.pool,'employee'),runId=await insertRoleRun(f.pool,owner,role.id,taskId)
  const db=await f.pool.connect();let lineage
  try{await db.query('begin');lineage=await new WorkLineageService(f.pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
  const original=JSON.stringify({schema:'teloa.task-run-input/v2',role:createRunRoleSnapshot(role,authorization),lineage})
  await f.pool.query('update teloa_task_runs set input_text=$2 where id=$1',[runId,original])
  const controls=new WorkControlService(f.pool,identity,{ownerAuthority:{authorize:async()=>({assertCurrent(){}})},inspectRun:async()=>({settled:true,unknownOperationIds:[]})})
  const c=await controls.get(owner,{controlId:lineage.roundControlId}),p=await controls.change(owner,{requestId:randomUUID(),controlId:c.id,expectedVersion:c.version,action:'pause',scope:'round',roundControlId:null}),paused=await controls.reconcile(owner,{controlId:c.id,generation:p.generation})
  let reason='unknown',hash='a'.repeat(64),host=1,transactionInspections=0
  const ports={hostGeneration:()=>host,ownerAuthority:{authorize:async()=>({assertCurrent(){}})},inspectCheckpoint:async(_owner:string,_input:any,db:any)=>{if(db)transactionInspections++;await (db??f.pool).query('select 1');return {reason,checkpointSha256:hash,hasPendingInput:true,unknownOperationIds:reason==='unknown'?['external:unknown']:[]}},authorizeResume:async()=>({assertCurrent(){}})}
  const service=new api.WorkRecoveryService(f.pool,identity,controls,ports)
  const pending=await service.inspect(owner,{controlId:c.id});assert.equal(pending[0].reason,'unknown');assert.equal(pending[0].safeRecovery,false)
  const request={requestId:randomUUID(),controlId:c.id,expectedVersion:paused.version,candidateRunIds:[runId]}
  await assert.rejects(service.resume(owner,request),{code:'teloa/execution-pending'})
  assert.equal((await controls.get(owner,{controlId:c.id})).state,'paused')
  reason='accepted';const active=await service.resume(owner,request);assert.equal(active.state,'active');assert.ok(active.generation>paused.generation)
  assert.deepEqual(await service.resume(owner,request),active)
  const ticket=await service.acquire(owner,{requestId:request.requestId,runId});assert.equal(ticket.candidate.reason,'accepted');ticket.lease.assertCurrent()
  assert.equal((await service.begin(owner,{requestId:request.requestId,runId})).dispatch,true)
  assert.equal((await service.begin(owner,{requestId:request.requestId,runId})).dispatch,false)
  hash='b'.repeat(64);await assert.rejects(service.acquire(owner,{requestId:request.requestId,runId}),{code:'teloa/version-conflict'})
  assert.equal((await f.pool.query('select input_text from teloa_task_runs where id=$1',[runId])).rows[0].input_text,original)
  hash='a'.repeat(64);host=2;assert.throws(ticket.lease.assertCurrent,{code:'teloa/forbidden'})
  await service.record(owner,{requestId:request.requestId,runId,checkpointSha256:hash,state:'applied'})
  const replay=await service.begin(owner,{requestId:request.requestId,runId});assert.equal(replay.dispatch,false);assert.throws(replay.lease.assertCurrent,{code:'teloa/forbidden'})
  assert.ok(transactionInspections>=3,'固定检查点检查器也必须复用已持有的真实单连接事务')
 }finally{await f.close()}
})
