import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setupRoleWork,roleFixture,identity,loadRoleWorkModule} from './role-work-test-fixture.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'

test('停止未知提交只在本人、已退出宿主、稳定原生与持久事实都通过时撤回并留下审计',{timeout:30000},async()=>{
 const f=await setupRoleWork()
 try{
  await initializeTeloaDatabase(f.pool)
  const api=await loadRoleWorkModule('task-run-stop-recovery')
  assert.equal(typeof api.StoppedUnacceptedTaskRunService,'function','必须由独立正式服务撤回，不能改计数或制造结束事件')
  await api.initializeTaskRunStopRecovery(f.pool)
  const {owner,role,taskId}=await roleFixture(f.pool,'employee'),sessionId='stopped-'+randomUUID(),conversationId=randomUUID()
  const db=await f.pool.connect();try{await db.query('begin');await new WorkLineageService(f.pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
  await f.pool.query("update teloa_roles set state='active' where id=$1",[role.id])
  const inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
  const link=await new ObjectConversationService(f.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  const runs=new TaskRunService(f.pool,identity,inspect),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:link.version},undefined,undefined,undefined,async()=> 'teloa-standard')
  await runs.claim(owner,{runId:prepared.id});const stopped=await runs.requestStop(owner,{runId:prepared.id}),runtimeId=randomUUID()
  await f.pool.query("insert into teloa_task_run_runtime_links(owner_id,run_id,kind,native_id,session_id,payload) values($1,$2,'job',$3,$4,$5)",[owner,stopped.id,'owner:'+runtimeId+':'+sessionId,sessionId,JSON.stringify({record:'owner',runtimeId,requestId:stopped.nativeRequestId})])
  const before=(await f.pool.query('select * from teloa_task_runs where id=$1',[stopped.id])).rows[0]
  const taskBefore=(await f.pool.query('select * from teloa_tasks where id=$1',[taskId])).rows[0]
  let hostAlive=false,ownerInvalid=false,readFailure=false,changed=false,wrongIdentity=false,reads=0,lateEffect=false,lateHost=false,lateOwner=false
  const proof={schema:'teloa.stopped-unaccepted-native/v1',mode:'official-session-initial-inbox-no-commands',runId:stopped.id,sessionId,nativeRequestId:stopped.nativeRequestId,agentPresetId:'teloa-standard',logCut:2,logSha256:'a'.repeat(64)}
  const service=new api.StoppedUnacceptedTaskRunService(f.pool,runs,identity,{ownerAuthority:{authorize:async()=>({assertCurrent(){if(ownerInvalid)throw Error('owner revoked')}})},acquireHostStopped:async()=>({assertCurrent(){if(hostAlive)throw Error('宿主仍然存活')}}),inspectNative:async()=>{
   reads++;if(readFailure)throw Error('读取失败不能当空日志')
   if(reads===2&&lateHost)hostAlive=true
   if(reads===2&&lateOwner)ownerInvalid=true
   if(lateEffect&&reads===2)await f.pool.query("insert into teloa_plugin_installations(id,owner_id,package_name,preview,preview_hash,state,attempt,created_at,updated_at) values($1,$2,'synthetic-late-effect','{}',$3,'unknown',1,now(),now())",[randomUUID(),owner,'c'.repeat(64)])
   return {...proof,...(wrongIdentity?{nativeRequestId:randomUUID()}:{}),...(changed&&reads===2?{logSha256:'b'.repeat(64)}:{})}
  }})
  const request={requestId:randomUUID(),runId:stopped.id},signal=new AbortController().signal
  for(const flag of ['host','owner','read','changed','identity','effect','host-late','owner-late']){
   hostAlive=flag==='host';ownerInvalid=flag==='owner';readFailure=flag==='read';changed=flag==='changed';wrongIdentity=flag==='identity';lateEffect=flag==='effect';lateHost=flag==='host-late';lateOwner=flag==='owner-late';reads=0
   await assert.rejects(service.withdraw(owner,request,signal))
   assert.deepEqual((await f.pool.query('select * from teloa_task_runs where id=$1',[stopped.id])).rows[0],before)
   assert.equal((await f.pool.query('select count(*)::int n from teloa_task_run_stop_recoveries')).rows[0].n,0)
  }
  await f.pool.query("delete from teloa_plugin_installations where owner_id=$1 and package_name='synthetic-late-effect'",[owner])
  hostAlive=ownerInvalid=readFailure=changed=wrongIdentity=lateEffect=lateHost=lateOwner=false;reads=0
  for(const unsafe of [{...request,stopped:true},{...request,events:[]},{...request,runId:undefined}])await assert.rejects(service.withdraw(owner,unsafe,signal),{code:'teloa/invalid-input'})
  await assert.rejects(service.withdraw(randomUUID(),request,signal),{code:'teloa/forbidden'})
  await f.pool.query("update teloa_task_runs set state='accepted',evidence='{"+'"state":"accepted"'+"}'::jsonb where id=$1",[stopped.id])
  await assert.rejects(service.withdraw(owner,request,signal))
  await f.pool.query("update teloa_task_runs set state='submitting',evidence=null where id=$1",[stopped.id])
  const result=await service.withdraw(owner,request,signal)
  assert.equal(result.run.state,'withdrawn');assert.equal(result.run.evidence,null);assert.equal(result.run.stopRequestedAt,stopped.stopRequestedAt)
  assert.equal(result.receipt.runId,stopped.id);assert.equal(result.receipt.nativeRequestId,stopped.nativeRequestId)
  const taskAfter=(await f.pool.query('select * from teloa_tasks where id=$1',[taskId])).rows[0]
  assert.equal(taskAfter.state,'paused');assert.equal(taskAfter.version,taskBefore.version+1)
  assert.deepEqual({...taskAfter,state:taskBefore.state,version:taskBefore.version,updated_at:taskBefore.updated_at},taskBefore)
  assert.deepEqual(result.receipt.task,{taskId,changed:true,before:{state:'running',version:taskBefore.version},after:{state:'paused',version:taskBefore.version+1}})
  const after=(await f.pool.query('select * from teloa_task_runs where id=$1',[stopped.id])).rows[0]
  assert.deepEqual({...after,state:'submitting'},before,'只能改变未准入提交状态，原 Task/输入/身份/停止意图保留')
  assert.deepEqual(await service.withdraw(owner,request,signal),result,'同一维护请求的回包丢失只回读原审计')
  await assert.rejects(service.withdraw(owner,{...request,runId:randomUUID()},signal))
 }finally{await f.close()}
})
