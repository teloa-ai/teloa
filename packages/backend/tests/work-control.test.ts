import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setupRoleWork,roleFixture,insertRoleRun,identity,loadRoleWorkModule} from './role-work-test-fixture.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'

test('已结项来源只能沿真实持久谱系取得后继控制许可，外来谱系拒绝且暂停即时封租约',{timeout:15000},async()=>{
 const f=await setupRoleWork()
 try{
  const api=await loadRoleWorkModule('work-control');await api.initializeWorkControl(f.pool)
  const {owner,role,taskId}=await roleFixture(f.pool,'employee'),runId=await insertRoleRun(f.pool,owner,role.id,taskId,'ended'),db=await f.pool.connect();let lineage
  try{await db.query('begin');lineage=await new WorkLineageService(f.pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
  const service=new api.WorkControlService(f.pool,identity,{hostGeneration:()=>1,ownerAuthority:{authorize:async()=>({assertCurrent(){}})}})
  assert.equal(typeof service.acquireForLineage,'function','需要固定持久来源控制口，不放宽已结项 Run')
  await assert.rejects(service.acquireForRun(owner,{runId,mode:'new-input'}),{code:'teloa/forbidden'})
  await assert.rejects(service.acquireForLineage(owner,{taskId:randomUUID(),mode:'new-input'}),{code:'teloa/forbidden'})
  const permitted=await service.acquireForLineage(owner,{taskId,expectedGeneration:1,mode:'new-input'});permitted.lease.assertCurrent()
  await service.change(owner,{requestId:randomUUID(),controlId:permitted.control.id,expectedVersion:permitted.control.version,action:'pause',scope:'round',roundControlId:null})
  assert.throws(permitted.lease.assertCurrent,{code:'teloa/forbidden'})
  await assert.rejects(service.acquireForLineage(owner,{taskId,mode:'continuation'}),{code:'teloa/forbidden'})
 }finally{await f.close()}
})

test('整项控制先封旧许可，真实孩子未结清/外部未知时保留中间态；恢复产生新世代',{timeout:15000},async()=>{
 const f=await setupRoleWork()
 try{
  const api=await loadRoleWorkModule('work-control');assert.equal(typeof api.WorkControlService,'function','必须存在持久整项控制服务')
  await api.initializeWorkControl(f.pool)
  const {owner,role,taskId}=await roleFixture(f.pool,'employee'),runId=await insertRoleRun(f.pool,owner,role.id,taskId)
  const db=await f.pool.connect();let lineage
  try{await db.query('begin');lineage=await new WorkLineageService(f.pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
  let settled=false,unknown=['external:unknown'],host=1
  const service=new api.WorkControlService(f.pool,identity,{hostGeneration:()=>host,ownerAuthority:{authorize:async()=>({assertCurrent(){}})},inspectRun:async()=>({settled,unknownOperationIds:unknown})})
  const current=await service.get(owner,{controlId:lineage.roundControlId}),permit=await service.acquireForRun(owner,{runId,expectedGeneration:1,mode:'new-input'})
  permit.lease.assertCurrent()
  const pauseRequest={requestId:randomUUID(),controlId:current.id,expectedVersion:current.version,action:'pause' as const,scope:'round' as const,roundControlId:null}
  await assert.rejects(new api.WorkControlService(f.pool,identity).change(owner,pauseRequest),{code:'teloa/forbidden'})
  const pausing=await service.change(owner,pauseRequest)
  assert.deepEqual(await service.change(owner,pauseRequest),pausing)
  await assert.rejects(service.change(owner,{...pauseRequest,action:'stop'}),{code:'teloa/conflict'})
  await assert.rejects(service.get(randomUUID(),{controlId:current.id}),{code:'teloa/forbidden'})
  assert.equal(pausing.state,'pausing');assert.throws(permit.lease.assertCurrent,{code:'teloa/forbidden'})
  assert.equal((await service.reconcile(owner,{controlId:current.id,generation:pausing.generation})).state,'pausing')
  settled=true;assert.equal((await service.reconcile(owner,{controlId:current.id,generation:pausing.generation})).state,'pausing')
  unknown=[];const paused=await service.reconcile(owner,{controlId:current.id,generation:pausing.generation});assert.equal(paused.state,'paused')
  const closed=await new api.WorkControlService(f.pool,identity).get(owner,{controlId:current.id});assert.equal(closed.state,'paused')
  await assert.rejects(service.change(owner,{requestId:randomUUID(),controlId:current.id,expectedVersion:paused.version,action:'resume',scope:'round',roundControlId:null}),{code:'teloa/forbidden'})
  const resumeInternally=async(expectedVersion:number)=>{const db=await f.pool.connect();try{await db.query('begin');const result=await service.resumeInTransaction(db,owner,{controlId:current.id,expectedVersion},{assertCurrent(){}});await db.query('commit');return result}finally{db.release()}}
  const active=await resumeInternally(paused.version)
  assert.equal(active.state,'active');assert.ok(active.generation>pausing.generation)
  await assert.rejects(service.acquireForRun(owner,{runId,expectedGeneration:1,mode:'new-input'}),{code:'teloa/version-conflict'})
  await assert.rejects(service.reconcile(owner,{controlId:current.id,generation:pausing.generation}),{code:'teloa/version-conflict'})
  const beforeRestart=await service.acquireForRun(owner,{runId,mode:'continuation'});host=2
  const restarted=await service.disarmForRestart(owner,{hostGeneration:2});assert.equal(restarted[0].state,'pausing');assert.throws(beforeRestart.lease.assertCurrent,{code:'teloa/forbidden'});assert.deepEqual(await service.disarmForRestart(owner,{hostGeneration:2}),[])
  const restartPaused=await service.reconcile(owner,{controlId:current.id,generation:restarted[0].generation});assert.equal(restartPaused.state,'paused')
  assert.equal(await service.stateForRun(owner,{runId}),'paused')
  const resumed=await resumeInternally(restartPaused.version)
  const permit2=await service.acquireForRun(owner,{runId,expectedGeneration:resumed.generation,mode:'continuation'}),stop=await service.change(owner,{requestId:randomUUID(),controlId:current.id,expectedVersion:resumed.version,action:'stop',scope:'round',roundControlId:null})
  assert.throws(permit2.lease.assertContinuationCurrent,{code:'teloa/forbidden'})
  assert.equal((await new api.WorkControlService(f.pool,identity).reconcile(owner,{controlId:current.id,generation:stop.generation})).state,'stopping','没有真实检查器不能把取消当停止完成')
  assert.equal((await service.reconcile(owner,{controlId:current.id,generation:stop.generation})).state,'stopped')
  assert.equal((await f.pool.query('select control_generation from teloa_task_work_lineage where task_id=$1',[taskId])).rows[0].control_generation,1)
 }finally{await f.close()}
})
