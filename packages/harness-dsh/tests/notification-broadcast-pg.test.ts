import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {openResourceDatabase,initializeRoles,initializeTasks,initializePlans,initializePlanOccurrences,initializeObjectConversations,initializeTaskRuns,initializeNotificationDeliveries,RoleService,PlanService,PlanOccurrenceService,ObjectConversationService,TaskRunService,NotificationDeliveryService} from '@teloa/backend'
import {NotificationDeliveryDriver,createBroadcastNotificationAdapter,createLocalNotificationAdapter,type NotificationChannelAdapter} from '../src/notification-deliveries.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:TaskRunService['pool'],temporary:string

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').withDatabase('teloa').start()
 temporary=await mkdtemp(join(tmpdir(),'teloa-notification-broadcast-'));const config=join(temporary,'database.json')
 await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 pool=(await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})).pool
 await initializeRoles(pool);await initializeTasks(pool);await initializePlans(pool);await initializePlanOccurrences(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeNotificationDeliveries(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop();if(temporary)await rm(temporary,{recursive:true,force:true})})

/** 造一条「always」策略、已正常结束的计划运行（与 backend notification-deliveries.test.ts 的 terminal 同构）。 */
async function endedRun():Promise<string>{
 const owner=randomUUID(),now='2026-09-13T01:00:00.000Z',identity={id:randomUUID,now:()=>now}
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'资料核对岗',kind:'employee',scopes:['general'],duty:'核对资料',dataScope:'本人授权资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'investigator'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const plans=new PlanService(pool,identity),created=await plans.create(owner,{requestId:randomUUID(),fields:{title:'每日资料核对',goal:'核对新增资料',scope:'general',dataScope:'本人授权资料',delivery:'变化与待核对项',roleId:role.id,expectedRoleVersion:2,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'always'},source:{kind:'manual'}})
 const plan=await plans.change(owner,{planId:created.id,requestId:randomUUID(),expectedVersion:1,action:'enable'})
 const occurrences=new PlanOccurrenceService(pool,{id:randomUUID});await occurrences.recover(owner,{planId:plan.id,now:'2026-09-13T00:00:00.000Z'})
 const occurrence=(await occurrences.claim(owner,{planId:plan.id,now})).occurrence!
 const {task}=await occurrences.dispatchTask(owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now})
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready' as const})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect)
 const prepared=await runs.prepare(owner,{requestId:occurrence.id,taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1})
 await runs.claim(owner,{runId:prepared.id})
 await runs.record(owner,{runId:prepared.id,sessionId,nativeRequestId:prepared.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 return owner
}

test('I1：升级前已按 local-log 投递的运行，换成广播适配器后不再生成新投递行、IM 旁路不重投',async()=>{
 const owner=await endedRun(),service=new NotificationDeliveryService(pool,{id:randomUUID,now:()=>new Date().toISOString()}),options={now:()=>new Date().toISOString(),limit:50}
 const before=await new NotificationDeliveryDriver(service,createLocalNotificationAdapter({info(){}}),options).deliver(owner,new AbortController().signal)
 assert.deepEqual(before,{materialized:1,attempted:1,delivered:1,failed:0})
 let imCalls=0
 const im:NotificationChannelAdapter={channel:'im-telegram',deliver:async()=>{imCalls+=1;return {receiptId:'im'}}}
 const broadcast=createBroadcastNotificationAdapter(createLocalNotificationAdapter({info(){}}),{warn(){}});broadcast.add(im)
 const after=await new NotificationDeliveryDriver(service,broadcast,options).deliver(owner,new AbortController().signal)
 assert.deepEqual(after,{materialized:0,attempted:0,delivered:0,failed:0})
 assert.equal(imCalls,0)
 assert.equal((await pool.query('select count(*)::int count from teloa_notification_deliveries where owner_id=$1',[owner])).rows[0].count,1)
})

/** 功能验证 接线：真 NotificationDeliveryService + 驱动 + 广播（local 桩在前、im 桩追加）。 */
async function wired(local:NotificationChannelAdapter['deliver'],im:NotificationChannelAdapter['deliver']){
 const owner=await endedRun(),service=new NotificationDeliveryService(pool,{id:randomUUID,now:()=>new Date().toISOString()})
 const broadcast=createBroadcastNotificationAdapter({channel:'local-log',deliver:local},{warn(){}});broadcast.add({channel:'im',deliver:im})
 const result=await new NotificationDeliveryDriver(service,broadcast,{now:()=>new Date().toISOString(),limit:50}).deliver(owner,new AbortController().signal)
 const rows=(await pool.query('select status,channel,error from teloa_notification_deliveries where owner_id=$1',[owner])).rows as {status:string;channel:string;error:{code:string}|null}[]
 return {result,rows}
}

test('功能验证：一条投递 → delivered 1，local 与 im 桩各收到一次、同一 idempotencyKey；投递行 channel 仍为 local-log',async()=>{
 const keys:{local:string[];im:string[]}={local:[],im:[]}
 const {result,rows}=await wired(async input=>{keys.local.push(input.idempotencyKey);return {receiptId:'l'}},async input=>{keys.im.push(input.idempotencyKey);return {receiptId:'i'}})
 assert.deepEqual(result,{materialized:1,attempted:1,delivered:1,failed:0})
 assert.equal(keys.local.length,1)
 assert.deepEqual(keys.im,keys.local)
 assert.deepEqual(rows.map(row=>[row.status,row.channel]),[['delivered','local-log']])
})

test('功能验证：im 桩抛错、local 成功 → 仍 delivered 1',async()=>{
 const {result,rows}=await wired(async()=>({receiptId:'l'}),async()=>{throw new Error('im: no bound channel')})
 assert.deepEqual(result,{materialized:1,attempted:1,delivered:1,failed:0})
 assert.deepEqual(rows.map(row=>row.status),['delivered'])
})

test('功能验证：local 与 im 都抛错 → failed 1，fail 记 teloa/notification-unavailable',async()=>{
 const {result,rows}=await wired(async()=>{throw new Error('local down')},async()=>{throw new Error('im down')})
 assert.deepEqual(result,{materialized:1,attempted:1,delivered:0,failed:1})
 assert.deepEqual(rows.map(row=>[row.status,row.error?.code]),[['failed','teloa/notification-unavailable']])
})
