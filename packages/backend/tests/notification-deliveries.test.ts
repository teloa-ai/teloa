import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {randomUUID,createHash} from 'node:crypto'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {initializePlanOccurrences,PlanOccurrenceService} from '../src/work/plan-occurrences.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {PlanService,type PlanNotificationPolicy} from '../src/work/plans.ts'
import {PlanSchedulerStatusService} from '../src/work/plan-scheduler-status.ts'
import {initializeArtifacts} from '../src/work/artifacts.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

const feature=await import('../src/work/notification-deliveries.ts').catch(()=>null)
let container:StartedPostgreSqlContainer,pool:Pool

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializePlanOccurrences(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeArtifactSnapshots(pool);await initializeArtifacts(pool)
 await feature!.initializeNotificationDeliveries(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function terminal(policy:PlanNotificationPolicy,reason:string){
 const owner=randomUUID(),now='2026-09-13T01:00:00.000Z',identity={id:randomUUID,now:()=>now}
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'资料核对岗',kind:'employee',scopes:['general'],duty:'核对资料',dataScope:'本人授权资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'investigator'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const plans=new PlanService(pool,identity),created=await plans.create(owner,{requestId:randomUUID(),fields:{title:'每日资料核对',goal:'核对新增资料',scope:'general',dataScope:'本人授权资料',delivery:'变化与待核对项',roleId:role.id,expectedRoleVersion:2,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:policy},source:{kind:'manual'}})
 const plan=await plans.change(owner,{planId:created.id,requestId:randomUUID(),expectedVersion:1,action:'enable'})
 const occurrences=new PlanOccurrenceService(pool,{id:randomUUID});await occurrences.recover(owner,{planId:plan.id,now:'2026-09-13T00:00:00.000Z'})
 const occurrence=(await occurrences.claim(owner,{planId:plan.id,now})).occurrence!
 const {task}=await occurrences.dispatchTask(owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now})
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),command={requestId:occurrence.id,taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1}
 const prepared=reason==='configuration_failed'?await runs.prepare(owner,command,undefined,undefined,undefined,async()=>{throw new Error('private preset details')}):await runs.prepare(owner,command)
 if(reason==='configuration_failed')return {owner,plan,occurrence,task,run:prepared}
 await runs.claim(owner,{runId:prepared.id})
 const run=await runs.record(owner,{runId:prepared.id,sessionId,nativeRequestId:prepared.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason}})
 return {owner,plan,occurrence,task,run}
}

test('通知投递服务建立独立投递状态且不向计划保存凭据',async()=>{
 assert.equal(typeof feature?.NotificationDeliveryService,'function')
 assert.equal(typeof feature?.initializeNotificationDeliveries,'function')
 const table=(await pool.query("select to_regclass('teloa_notification_deliveries') name")).rows[0]
 assert.equal(table.name,'teloa_notification_deliveries')
 const columns=(await pool.query("select column_name from information_schema.columns where table_name='teloa_notification_deliveries' order by ordinal_position")).rows.map(row=>row.column_name)
 assert.deepEqual(columns,['id','owner_id','claim_id','plan_id','task_id','run_id','policy','conclusion','channel','status','attempts','attempt_token','lease_expires_at','receipt','error','created_at','updated_at','delivered_at'])
 assert.equal((await pool.query("select column_name from information_schema.columns where table_name='teloa_plans' and column_name ilike '%credential%'")).rowCount,0)
})

test('只从固定 occurrence→task→run 终轮事实按四种策略生成投递',async()=>{
 const cases=[
  {policy:'always',reason:'aborted',want:true,conclusion:'policy-always'},
  {policy:'attention',reason:'completed',want:true,conclusion:'attention-required'},
  {policy:'attention',reason:'aborted',want:false},
  {policy:'failure',reason:'error',want:true,conclusion:'execution-failed'},
  {policy:'failure',reason:'completed',want:false},
  {policy:'silent',reason:'error',want:false},
 ] as const
 for(const item of cases){
  const fact=await terminal(item.policy,item.reason),service=new feature!.NotificationDeliveryService(pool,{id:randomUUID,now:()=>new Date().toISOString()})
  const generated=await service.materialize(fact.owner,{channel:'local-log',limit:20,now:'2026-09-13T02:00:00.000Z'})
  assert.equal(generated.deliveryIds.length,item.want?1:0,`${item.policy}/${item.reason}`)
  const deliveries=await service.list(fact.owner,{})
  assert.equal(deliveries.length,item.want?1:0)
  if(!item.want)continue
  const delivery=deliveries[0]!
  assert.equal(delivery.claimId,fact.occurrence.id);assert.equal(delivery.planId,fact.plan.id);assert.equal(delivery.taskId,fact.task.id);assert.equal(delivery.runId,fact.run.id)
  assert.equal(delivery.policy,item.policy);assert.equal(delivery.conclusion,item.conclusion);assert.equal(delivery.channel,'local-log');assert.equal(delivery.status,'pending');assert.equal(delivery.attempts,0)
 }
})

test('delivery id 对版本化 source/fact/policy/channel 使用稳定 canonical 哈希，重扫复用同一行',async()=>{
 const fact=await terminal('always','completed'),service=new feature!.NotificationDeliveryService(pool,{id:randomUUID,now:()=>new Date().toISOString()})
 await pool.query(`update teloa_plans set notification_policy='silent',definition=jsonb_set(definition,'{notificationPolicy}','"silent"'),request_spec=jsonb_set(request_spec,'{fields,notificationPolicy}','"silent"') where id=$1`,[fact.plan.id])
 const first=await service.materialize(fact.owner,{channel:'local-log',limit:20,now:'2026-09-13T02:00:00.000Z'}),second=await service.materialize(fact.owner,{channel:'local-log',limit:20,now:'2026-09-13T03:00:00.000Z'})
 const canonical=JSON.stringify(['teloa.notification-delivery/v1',['plan-occurrence',fact.occurrence.id],['task-run-terminal',fact.run.id],['always','local-log']])
 const expected='notification:v1:'+createHash('sha256').update(canonical).digest('hex')
 assert.deepEqual(first.deliveryIds,[expected]);assert.deepEqual(second.deliveryIds,[expected])
 assert.equal((await pool.query('select count(*)::int count from teloa_notification_deliveries where owner_id=$1',[fact.owner])).rows[0].count,1)
})

test('运行配置失败属于业务失败；调度健康失败不会把成功 Run 伪造成失败通知',async()=>{
 const failed=await terminal('failure','configuration_failed'),service=new feature!.NotificationDeliveryService(pool,{id:randomUUID,now:()=>new Date().toISOString()})
 assert.equal((await service.materialize(failed.owner,{channel:'local-log',limit:20,now:'2026-09-13T02:00:00.000Z'})).deliveryIds.length,1)
 const healthyRun=await terminal('failure','completed'),status=new PlanSchedulerStatusService(pool,{now:()=>'2026-09-13T02:00:00.000Z'})
 await status.record(healthyRun.owner,{planId:healthyRun.plan.id,outcome:'failed',code:'teloa/source-unavailable'})
 assert.deepEqual(await service.materialize(healthyRun.owner,{channel:'local-log',limit:20,now:'2026-09-13T02:00:00.000Z'}),{deliveryIds:[]})
})

test('并发只领取一次；失败只写回执状态并以同一 id 重试，过期旧尝试不能覆盖新回执',async()=>{
 const fact=await terminal('always','completed'),service=new feature!.NotificationDeliveryService(pool,{id:randomUUID,now:()=>new Date().toISOString()})
 const [deliveryId]=((await service.materialize(fact.owner,{channel:'local-log',limit:20,now:'2026-09-13T02:00:00.000Z'})).deliveryIds)
 assert.ok(deliveryId)
 const artifactId=randomUUID(),artifactRequestId=randomUUID(),source={kind:'session',id:fact.run.sessionId,scope:'general',version:'bound-v1',title:'运行成果'},content={title:'成果',sections:[{id:'summary',title:'摘要',text:'已完成'}],snapshotIds:[],note:'固定成果'}
 await pool.query('insert into teloa_artifacts(id,owner_id,request_id,request_spec,source_key,current_version) values($1,$2,$3,$4,$5,1)',[artifactId,fact.owner,artifactRequestId,JSON.stringify({source,content}),JSON.stringify(['session',fact.run.sessionId,'general',''])])
 await pool.query('insert into teloa_artifact_versions(owner_id,artifact_id,number,source,content,created_at) values($1,$2,1,$3,$4,$5)',[fact.owner,artifactId,JSON.stringify(source),JSON.stringify(content),'2026-09-13T01:00:00.000Z'])
 const taskBefore=(await pool.query('select state,version,updated_at from teloa_tasks where id=$1',[fact.task.id])).rows[0],runBefore=(await pool.query('select state,evidence from teloa_task_runs where id=$1',[fact.run.id])).rows[0],artifactBefore=(await pool.query('select h.*,v.* from teloa_artifacts h join teloa_artifact_versions v on v.owner_id=h.owner_id and v.artifact_id=h.id where h.id=$1',[artifactId])).rows[0]
 const claims=await Promise.all([service.claim(fact.owner,{deliveryId,now:'2026-09-13T02:00:00.000Z'}),service.claim(fact.owner,{deliveryId,now:'2026-09-13T02:00:00.000Z'})]),first=claims.find(Boolean)!
 assert.equal(claims.filter(Boolean).length,1);assert.equal(first.id,deliveryId);assert.equal(first.attempts,1);assert.ok(first.attemptToken)
 assert.equal(await service.claim(fact.owner,{deliveryId,now:'2026-09-13T02:00:29.999Z'}),null)
 await service.fail(fact.owner,{deliveryId,attemptToken:first.attemptToken,code:'teloa/notification-unavailable',now:'2026-09-13T02:00:30.000Z'})
 const failed=(await service.list(fact.owner,{}))[0]!;assert.equal(failed.status,'failed');assert.equal(failed.attempts,1);assert.deepEqual(failed.error,{code:'teloa/notification-unavailable'})
 assert.deepEqual((await pool.query('select state,version,updated_at from teloa_tasks where id=$1',[fact.task.id])).rows[0],taskBefore)
 assert.deepEqual((await pool.query('select state,evidence from teloa_task_runs where id=$1',[fact.run.id])).rows[0],runBefore)
 assert.deepEqual((await pool.query('select h.*,v.* from teloa_artifacts h join teloa_artifact_versions v on v.owner_id=h.owner_id and v.artifact_id=h.id where h.id=$1',[artifactId])).rows[0],artifactBefore)
 const retry=await service.claim(fact.owner,{deliveryId,now:'2026-09-13T02:00:31.000Z'});assert.equal(retry?.id,deliveryId);assert.equal(retry?.attempts,2);assert.notEqual(retry?.attemptToken,first.attemptToken)
 await assert.rejects(service.complete(fact.owner,{deliveryId,attemptToken:first.attemptToken,receiptId:'stale',now:'2026-09-13T02:00:32.000Z'}),{code:'teloa/conflict'})
 const delivered=await service.complete(fact.owner,{deliveryId,attemptToken:retry!.attemptToken,receiptId:'local-receipt',now:'2026-09-13T02:00:33.000Z'})
 assert.equal(delivered.status,'delivered');assert.equal(delivered.id,deliveryId);assert.deepEqual(delivered.receipt,{receiptId:'local-receipt'})
})

test('过期 delivering 可恢复；损坏来源事实显式失败且不生成投递',async()=>{
 const fact=await terminal('always','error'),service=new feature!.NotificationDeliveryService(pool,{id:randomUUID,now:()=>new Date().toISOString()}),[deliveryId]=(await service.materialize(fact.owner,{channel:'local-log',limit:20,now:'2026-09-13T02:00:00.000Z'})).deliveryIds
 const first=await service.claim(fact.owner,{deliveryId,now:'2026-09-13T02:00:00.000Z'});assert.equal(first?.attempts,1)
 const recovered=await service.claim(fact.owner,{deliveryId,now:'2026-09-13T02:00:30.000Z'});assert.equal(recovered?.id,deliveryId);assert.equal(recovered?.attempts,2)
 const corrupt=await terminal('always','completed');await pool.query("update teloa_task_runs set input_text='broken' where id=$1",[corrupt.run.id])
 await assert.rejects(service.materialize(corrupt.owner,{channel:'local-log',limit:20,now:'2026-09-13T02:00:00.000Z'}),{code:'teloa/storage-corrupt'})
 assert.equal((await service.list(corrupt.owner,{})).length,0)
 const hidden=await terminal('attention','completed');await pool.query("update teloa_task_runs set evidence=evidence-'reason' where id=$1",[hidden.run.id])
 await assert.rejects(service.materialize(hidden.owner,{channel:'local-log',limit:20,now:'2026-09-13T02:00:00.000Z'}),{code:'teloa/storage-corrupt'})
 const invalidPolicy=await terminal('always','completed');await pool.query(`update teloa_plan_occurrences set snapshot=jsonb_set(snapshot,'{fields,notificationPolicy}','"unknown"') where id=$1`,[invalidPolicy.occurrence.id])
 await assert.rejects(service.materialize(invalidPolicy.owner,{channel:'local-log',limit:20,now:'2026-09-13T02:00:00.000Z'}),{code:'teloa/storage-corrupt'})
})
