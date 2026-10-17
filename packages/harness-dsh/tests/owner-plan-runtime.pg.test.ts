import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeTeloaDatabase,openResourceDatabase,ArtifactService,PlanService,TaskRunService,ConversationService,WorkControlService,type OwnerPlanAuthority} from '@teloa/backend'
import {methodReuseBasisHash,type Conversation} from '@teloa/contract'
import {createPlanRuntime} from '../src/plan-runtime.ts'
import type {TaskRunPorts} from '../src/task-run-driver.ts'

test('本人计划经原runtime定时准备并只启动同一Run，固定模型和工具不借员工/全局默认；暂停阻止继续',{timeout:120000},async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 const container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').withPullPolicy({shouldPull:()=>false}).start(),temporary=await mkdtemp(join(tmpdir(),'teloa-owner-plan-')),file=join(temporary,'database.json')
 await writeFile(file,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 const {pool}=await openResourceDatabase(file,{id:randomUUID,now:()=>new Date().toISOString()})
 try{
  await initializeTeloaDatabase(pool)
  const owner=randomUUID();let now='2026-10-17T10:00:00.000Z',rows:Conversation[]=[],sends=0
  const identity={id:randomUUID,now:()=>now},modelPolicy={primary:{provider:'minimax',model:'MiniMax-M3',reasoningEffort:'high'}},policy={allowedTools:['get_goal'],argumentRules:[{name:'get_goal',allowed:[{}]}],agentPresetId:'owner-worker',modelPolicy},lease={assertCurrent(){}}
  const ownerPlans:OwnerPlanAuthority={verifySource:async()=>lease,capture:async()=>({policy,admission:lease}),authorize:async()=>lease}
  const plans=new PlanService(pool,identity,undefined,undefined,undefined,undefined,ownerPlans),schedule={kind:'schedule',cadence:'daily',weekday:1,time:'11:00',timezone:'Asia/Singapore'}
  const configuration={completion:{kind:'manual'},triggers:[{kind:'schedule',schedule}],budget:{maxGoalRounds:4,maxTokens:10000,maxElapsedMs:600000,maxConcurrent:1,maxRetries:1,stagnationRounds:2,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
  const originalSource={kind:'session' as const,id:'original',scope:'general',version:'4',title:'固定原稿'},artifact=await new ArtifactService(pool,identity,async(_owner,source)=>({source,sessionIds:[source.id]})).create(owner,{requestId:randomUUID(),source:originalSource,content:{title:'核对方法',sections:[{id:'result',title:'完整原稿',text:'原稿的完整合成事实和行动清单'}],snapshotIds:[],note:'仅合成资料'}})
  const paused=await plans.createOwnerConfirmed(owner,{requestId:randomUUID(),fields:{title:'本人每日核对',goal:'核对本人已授权资料',scope:'general',roleId:null,executor:{kind:'owner'},dataScope:'仅明确选择的资料',delivery:'核对结论',notificationPolicy:'attention',trigger:schedule},source:{kind:'method-reuse',artifactId:artifact.artifactId,version:artifact.number,basisHash:await methodReuseBasisHash(artifact),acceptedSource:{sessionId:'original',messageId:'owner-message',messageSeq:3,requestId:randomUUID()}},configuration,intent:'save-paused'})
  const sessions=new Set<string>(),conversations=new ConversationService({read:async()=>rows,write:async value=>{rows=structuredClone(value)}},{create:async id=>{sessions.add(id);return id},inspect:async id=>{assert.ok(sessions.has(id))}},identity)
  const controls=new WorkControlService(pool,identity,{ownerAuthority:{authorize:async()=>lease},inspectRun:async()=>({settled:true,unknownOperationIds:[]})})
  const ports:TaskRunPorts={resolvePreset:async declared=>{assert.equal(declared,policy.agentPresetId);return policy.agentPresetId},check:async()=>{},prepareModels:async declared=>{assert.deepEqual(declared,{model:modelPolicy.primary});return modelPolicy},prepareOwnerPolicy:async()=>({allowedTools:policy.allowedTools,argumentRules:policy.argumentRules}),controlState:run=>controls.stateForRun(owner,{runId:run.id}),send:async()=>{sends++},stop:async()=>{},events:async()=>[]}
  const getRuns=async()=>new TaskRunService(pool,identity,(actor,id)=>conversations.bySession(actor,id),{allowedTools:[],ownerPlans,runReservation:(actor,id)=>conversations.isTaskRunReserved(actor,id),planContext:(db,actor,id,completion,includeMethodSource)=>runtime.executionContext(db,actor,id,completion,includeMethodSource)})
  const runtime=createPlanRuntime({owner,getPool:async()=>pool,ownerPlans,conversations,getRunService:getRuns,runPorts:ports}),signal=new AbortController().signal
  await runtime.coordinator.recover(now,signal);assert.equal(sends,0)
  const plan=await plans.changeConfirmed(owner,{requestId:randomUUID(),planId:paused.id,expectedVersion:paused.version,action:'enable'})
  await runtime.coordinator.recover(now,signal)
  now='2026-10-18T03:00:00.000Z';await runtime.coordinator.tick(now,signal)
  assert.equal(sends,1)
  const tasks=(await pool.query('select id from teloa_tasks where owner_id=$1',[owner])).rows;assert.equal(tasks.length,1)
  const runs=await getRuns(),run=(await runs.list(owner,{taskId:tasks[0].id}))[0]!
  assert.equal(run.state,'accepted');assert.deepEqual(run.executor,plan.executor);assert.deepEqual(run.modelPolicy,modelPolicy);assert.equal(run.roleId,null)
  assert.equal(JSON.parse(run.inputText).planContext.delivery,'核对结论');assert.deepEqual(JSON.parse(run.inputText).planContext.methodSource.content,artifact.content)
  await runtime.coordinator.tick(now,signal);assert.equal(sends,1)
  await plans.change(owner,{requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,action:'pause'})
  const db=await pool.connect();try{await db.query('begin');await assert.rejects(runs.executionAdmissionInTransaction(db,owner,run.id),{code:'teloa/forbidden'});await db.query('rollback')}finally{db.release()}
  assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1',[owner])).rows[0].n,0)
 }finally{await pool.end();await container.stop();await rm(temporary,{recursive:true,force:true})}
})
