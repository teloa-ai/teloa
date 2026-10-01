import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,type QueryResult} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeMarketContents,MarketContentStore} from '../src/market/content-store.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializePlans,PlanService,type PlanNotificationPolicy} from '../src/work/plans.ts'
import {initializePlanOccurrences,PlanOccurrenceService} from '../src/work/plan-occurrences.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const schedule={kind:'schedule' as const,cadence:'daily' as const,weekday:1,time:'09:00',timezone:'Asia/Singapore' as const}
const source={kind:'manual' as const}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool);await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializePlans(pool);await initializeTasks(pool);await initializePlanOccurrences(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function activePlan(owner:string,enabledAt='2026-09-11T00:00:00.000Z',options:{title?:string;scope?:string;notificationPolicy?:PlanNotificationPolicy}={}){
 const identity={id:randomUUID,now:()=>enabledAt},roles=new RoleService(pool,identity)
 const scope=options.scope??'general',role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'日程核对岗',kind:'employee',scopes:[scope],duty:'核对资料',dataScope:'已授权资料',executionScope:'只读整理',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'schedule-reviewer'}}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const plans=new PlanService(pool,identity),created=await plans.create(owner,{requestId:randomUUID(),fields:{title:options.title??'每日资料核对',goal:'核对新增资料并形成结论。',scope,dataScope:'本人已授权资料。',delivery:'变化与待核对项。',roleId:role.id,expectedRoleVersion:1,trigger:schedule,notificationPolicy:options.notificationPolicy??'attention'},source})
 const active=await plans.change(owner,{planId:created.id,requestId:randomUUID(),expectedVersion:1,action:'enable'})
 return {role,plan:active,plans}
}

test('显式恢复固定未来日程，并发到期领取只有一个dispatch和一条记录',async()=>{
 const owner=randomUUID(),{role,plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const baseline=await service.recover(owner,{planId:plan.id,now:'2026-09-11T00:30:00.000Z'})
 assert.deepEqual(baseline,{nextAt:'2026-09-11T01:00:00.000Z',occurrenceId:'2026-09-11T09:00[Asia/Singapore]'})
 const claims=await Promise.all(Array.from({length:8},()=>service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})))
 assert.equal(claims.filter(result=>result.dispatch).length,1)
 const occurrence=claims.find(result=>result.dispatch)!.occurrence!
 assert.equal(occurrence.planId,plan.id);assert.equal(occurrence.planVersion,plan.version);assert.equal(occurrence.configVersion,1)
 assert.equal(occurrence.roleVersion,1);assert.equal(occurrence.fields.roleId,role.id);assert.equal(occurrence.fields.notificationPolicy,'attention');assert.deepEqual(occurrence.source,source)
 assert.equal(occurrence.scheduledAt,'2026-09-11T01:00:00.000Z');assert.equal(occurrence.claimedAt,'2026-09-11T01:00:00.000Z')
 assert.match(occurrence.taskRequestId,/^[a-f0-9-]{36}$/);assert.deepEqual(occurrence.taskRequest,{requestId:occurrence.taskRequestId,fields:{title:'每日资料核对',goal:'核对新增资料并形成结论。',scope:'general'},assignee:{roleId:role.id,expectedVersion:1}})
 assert.deepEqual(await new PlanOccurrenceService(pool,{id:randomUUID}).list(owner,{planId:plan.id}),[occurrence])
 assert.deepEqual(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'}),{occurrence:null,dispatch:false})
})

test('本人立即运行固定一次执行，不改日程游标、不会并发重入或用旧版本覆盖',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const baseline=await service.recover(owner,{planId:plan.id,now:'2026-09-11T00:30:00.000Z'})
 const requestId=randomUUID(),input={planId:plan.id,requestId,expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,now:'2026-09-11T00:31:00.000Z'}
 const results=await Promise.all(Array.from({length:6},()=>service.trigger(owner,input)))
 assert.equal(results.filter(result=>result.dispatch).length,1)
 const occurrence=results.find(result=>result.dispatch)!.occurrence
 assert.equal(occurrence.occurrenceId,'manual:'+requestId)
 assert.equal(occurrence.scheduledAt,input.now);assert.equal(occurrence.claimedAt,input.now);assert.equal(occurrence.taskRequestId,requestId)
 assert.deepEqual(await service.recover(owner,{planId:plan.id,now:'2026-09-11T00:31:01.000Z'}),baseline)
 await assert.rejects(service.trigger(owner,{...input,requestId:randomUUID(),now:'2026-09-11T00:31:02.000Z'}),{code:'teloa/conflict'})
 await service.dispatchTask(owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now:'2026-09-11T00:31:03.000Z'})
 const current=await new PlanService(pool,{id:randomUUID,now:()=>'2026-09-11T00:32:00.000Z'}).change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,action:'pause'})
 await assert.rejects(service.trigger(owner,{...input,requestId:randomUUID(),expectedVersion:current.version,expectedConfigVersion:plan.configVersion,now:'2026-09-11T00:32:01.000Z'}),{code:'teloa/conflict'})
})

test('四种通知策略都先固定领取和任务事实，执行历史只读领取时策略',async()=>{
 const service=new PlanOccurrenceService(pool,{id:randomUUID})
 for(const notificationPolicy of ['always','attention','failure','silent'] as const){
  const owner=randomUUID(),{plan}=await activePlan(owner,'2026-09-11T00:00:00.000Z',{notificationPolicy,title:'策略 '+notificationPolicy})
  const occurrence=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
  assert.equal(occurrence.fields.notificationPolicy,notificationPolicy)
  const dispatched=await service.dispatchTask(owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now:'2026-09-11T01:00:01.000Z'})
  assert.equal(dispatched.association.taskId,dispatched.task.id)
  assert.equal((await pool.query('select request_id from teloa_tasks where id=$1',[dispatched.task.id])).rows[0].request_id,occurrence.taskRequestId)
  const currentPolicy=notificationPolicy==='always'?'silent':'always'
  await pool.query(`update teloa_plans set notification_policy=$2,
   definition=jsonb_set(definition,'{notificationPolicy}',to_jsonb($2::text)),
   request_spec=jsonb_set(request_spec,'{fields,notificationPolicy}',to_jsonb($2::text)) where id=$1`,[plan.id,currentPolicy])
  const history=await service.executionHistory(owner,{planId:plan.id,limit:1})
  assert.equal(history.items[0]?.notificationPolicy,notificationPolicy)
 }
})

test('旧计划缺少通知策略仍可领取且不静默迁移，历史保持旧领取形状',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 await pool.query(`update teloa_plans set notification_policy=null,definition=definition-'notificationPolicy',
  request_spec=jsonb_set(request_spec,'{fields}',(request_spec->'fields')-'notificationPolicy') where id=$1`,[plan.id])
 const occurrence=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 assert.equal(Object.hasOwn(occurrence.fields,'notificationPolicy'),false)
 await service.dispatchTask(owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now:'2026-09-11T01:00:01.000Z'})
 const history=await service.executionHistory(owner,{planId:plan.id,limit:1})
 assert.equal(Object.hasOwn(history.items[0]!,'notificationPolicy'),false)
 const stored=(await pool.query("select notification_policy,definition ? 'notificationPolicy' has_definition,request_spec #> '{fields}' ? 'notificationPolicy' has_request from teloa_plans where id=$1",[plan.id])).rows[0]
 assert.deepEqual(stored,{notification_policy:null,has_definition:false,has_request:false})
})

test('首次观察和显式恢复都从now计算未来一次，不补跑停机或暂停历史',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const first=await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:01.000Z'})
 assert.equal(first.dispatch,true);assert.equal(first.occurrence?.scheduledAt,'2026-09-11T01:00:00.000Z')
 await service.recover(owner,{planId:plan.id,now:'2026-09-20T12:00:00.000Z'})
 assert.deepEqual((await service.list(owner,{planId:plan.id})).map(row=>row.scheduledAt),['2026-09-11T01:00:00.000Z'])
 const pauseService=new PlanService(pool,{id:randomUUID,now:()=>'2026-09-20T13:00:00.000Z'}),current=await pauseService.get(owner,{planId:plan.id})
 const paused=await pauseService.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:current.version,action:'pause'})
 await assert.rejects(service.claim(owner,{planId:plan.id,now:'2026-09-21T01:00:00.000Z'}),{code:'teloa/conflict'})
 const resumeService=new PlanService(pool,{id:randomUUID,now:()=>'2026-09-21T00:00:00.000Z'}),resumed=await resumeService.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:paused.version,action:'enable'})
 assert.deepEqual(await service.claim(owner,{planId:plan.id,now:'2026-09-21T00:30:00.000Z'}),{occurrence:null,dispatch:false})
 assert.equal((await service.claim(owner,{planId:plan.id,now:'2026-09-21T01:00:00.000Z'})).dispatch,true)
 assert.equal(resumed.version,4);assert.equal((await service.list(owner,{planId:plan.id})).length,2)
})

test('暂停、归档及岗位版本或状态变化拒绝领取且不产生记录',async()=>{
 const pausedOwner=randomUUID(),pausedSetup=await activePlan(pausedOwner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 await service.recover(pausedOwner,{planId:pausedSetup.plan.id,now:'2026-09-11T00:00:00.000Z'})
 const paused=await pausedSetup.plans.change(pausedOwner,{planId:pausedSetup.plan.id,requestId:randomUUID(),expectedVersion:pausedSetup.plan.version,action:'pause'})
 await assert.rejects(service.claim(pausedOwner,{planId:paused.id,now:'2026-09-11T01:00:00.000Z'}),{code:'teloa/conflict'})
 const archived=await pausedSetup.plans.change(pausedOwner,{planId:paused.id,requestId:randomUUID(),expectedVersion:paused.version,action:'archive',note:'停止计划'})
 await assert.rejects(service.claim(pausedOwner,{planId:archived.id,now:'2026-09-12T01:00:00.000Z'}),{code:'teloa/conflict'})
 assert.deepEqual(await service.list(pausedOwner,{planId:paused.id}),[])

 const versionOwner=randomUUID(),versionSetup=await activePlan(versionOwner)
 await service.recover(versionOwner,{planId:versionSetup.plan.id,now:'2026-09-11T00:00:00.000Z'})
 await pool.query('update teloa_roles set version=2 where id=$1',[versionSetup.role.id])
 await assert.rejects(service.claim(versionOwner,{planId:versionSetup.plan.id,now:'2026-09-11T01:00:00.000Z'}),{code:'teloa/version-conflict'})
 const stateOwner=randomUUID(),stateSetup=await activePlan(stateOwner)
 await service.recover(stateOwner,{planId:stateSetup.plan.id,now:'2026-09-11T00:00:00.000Z'})
 await pool.query("update teloa_roles set state='paused' where id=$1",[stateSetup.role.id])
 await assert.rejects(service.claim(stateOwner,{planId:stateSetup.plan.id,now:'2026-09-11T01:00:00.000Z'}),{code:'teloa/conflict'})
 assert.deepEqual(await service.list(versionOwner,{planId:versionSetup.plan.id}),[]);assert.deepEqual(await service.list(stateOwner,{planId:stateSetup.plan.id}),[])
})

test('本人隔离、固定记录篡改和日程游标篡改均显式失败',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 await service.recover(owner,{planId:plan.id,now:'2026-09-11T00:00:00.000Z'})
 await assert.rejects(service.claim('other',{planId:plan.id,now:'2026-09-11T01:00:00.000Z'}),{code:'teloa/forbidden'})
 await pool.query("update teloa_plan_schedule_state set occurrence_id='forged' where plan_id=$1",[plan.id])
 await assert.rejects(service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'}),{code:'teloa/storage-corrupt'})
 await service.recover(owner,{planId:plan.id,now:'2026-09-11T00:00:00.000Z'})
 const claimed=await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'});assert.equal(claimed.dispatch,true)
 await pool.query("update teloa_plan_occurrences set snapshot=jsonb_set(snapshot,'{fields,title}','\"伪造\"') where plan_id=$1",[plan.id])
 await assert.rejects(service.list(owner,{planId:plan.id}),{code:'teloa/storage-corrupt'})
})


test('已启用计划的市场文件变动必须阻断领取，事务不留下领取记录',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),market=new MarketContentStore(pool,{id:randomUUID,now:()=>'2026-09-11T00:00:00.000Z'})
 const manifest={format:'teloa.business-package/v2',id:'research',title:'研究',version:'1.0.0',domain:'general',description:'研究',resources:[{id:'daily',kind:'work-template',title:'每日',version:'1.0.0',required:true,source:{kind:'local',path:'work.json'}}],relations:[],entrypoints:['daily']}
 const content=(await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'研究'},manifestPath:'teloa.json',files:[{path:'teloa.json',bytes:new TextEncoder().encode(JSON.stringify(manifest))},{path:'work.json',bytes:new TextEncoder().encode('{}')}],references:[]})).content
 const fixed={kind:'market-content',contentId:content.id,contentHash:content.hash,resourceId:'daily',resourceVersion:'1.0.0'}
 await pool.query("update teloa_plans set source=$2,request_spec=jsonb_set(request_spec,'{source}',$2::jsonb) where id=$1",[plan.id,JSON.stringify(fixed)])
 const service=new PlanOccurrenceService(pool,{id:randomUUID},market)
 await service.recover(owner,{planId:plan.id,now:'2026-09-11T00:00:00.000Z'})
 await pool.query("update teloa_market_files set bytes='tampered' where content_id=$1 and path='work.json'",[content.id])
 await assert.rejects(service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'}),{code:'teloa/storage-corrupt'})
 assert.deepEqual(await service.list(owner,{planId:plan.id}),[])
})


test('领取后中断仍可查待派发记录，同一任务关联可重试且拒绝替换',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const claim=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 const identity={claimId:claim.id,taskRequestId:claim.taskRequestId}
 assert.deepEqual(await service.pending(owner),[claim])
 assert.deepEqual(await service.revalidate(owner,identity),claim)
 const tasks=new TaskService(pool,{id:randomUUID,now:()=>'2026-09-11T01:00:01.000Z'}),task=await tasks.create(owner,claim.taskRequest)
 const receipt={...identity,taskId:task.id}
 assert.deepEqual(await service.linkTask(owner,receipt),receipt)
 assert.deepEqual(await new PlanOccurrenceService(pool,{id:randomUUID}).linkTask(owner,receipt),receipt)
 assert.deepEqual(await service.pending(owner),[])
 await assert.rejects(service.linkTask(owner,{...receipt,taskId:randomUUID()}))
 await assert.rejects(service.revalidate('other',identity),{code:'teloa/forbidden'})
})


test('原子派发把任务与领取关联一起提交，暂停后拒绝新建但允许恢复既有任务',async()=>{
 const owner=randomUUID(),{plan,plans}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const claim=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 const input={claimId:claim.id,taskRequestId:claim.taskRequestId,now:'2026-09-11T01:00:01.000Z'}
 const first=await service.dispatchTask(owner,input)
 assert.equal(first.task.ownerId,owner);assert.equal(first.association.taskId,first.task.id)
 assert.deepEqual(await service.pending(owner),[])
 await plans.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,action:'pause'})
 const retry=await service.dispatchTask(owner,input)
 assert.equal(retry.task.id,first.task.id)
 const otherOwner=randomUUID(),other=await activePlan(otherOwner)
 const blocked=(await service.claim(otherOwner,{planId:other.plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 await other.plans.change(otherOwner,{planId:other.plan.id,requestId:randomUUID(),expectedVersion:other.plan.version,action:'pause'})
 await assert.rejects(service.dispatchTask(otherOwner,{claimId:blocked.id,taskRequestId:blocked.taskRequestId,now:input.now}),{code:'teloa/conflict'})
 assert.equal((await pool.query('select count(*) from teloa_tasks where owner_id=$1',[otherOwner])).rows[0].count,'0')
})

// 只截取服务连接的查询边界，SQL 仍完整交给真实 PostgreSQL 执行。
function observedPool(query:(sql:string,run:()=>Promise<QueryResult>,values?:unknown[])=>Promise<QueryResult>):Pool{
 return new Proxy(pool,{get(target,key){
  if(key==='connect')return async()=>{
   const client=await target.connect()
   return new Proxy(client,{get(connection,field){
    if(field==='query')return (sql:string,values?:unknown[])=>query(sql,()=>connection.query(sql,values),values)
    const value=Reflect.get(connection,field);return typeof value==='function'?value.bind(connection):value
   }})
  }
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
 }})
}
async function waitForBlockers(holderPid:number,count:number):Promise<void>{
 const deadline=Date.now()+5000
 while(Date.now()<deadline){
  // 第二个排队者可能等待第一个排队者的 tuple 锁，而非直接等待持锁事务。
  const result=await pool.query(`with recursive blocked(pid) as (
   select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))
   union select activity.pid from pg_stat_activity activity join blocked on blocked.pid=any(pg_blocking_pids(activity.pid))
  ) select pid from blocked`,[holderPid])
  if(result.rows.length>=count)return
  await new Promise(resolve=>setTimeout(resolve,10))
 }
 assert.fail(`应观察到 ${count} 个等待指定 PostgreSQL 连接的事务`)
}

test('不同计划同岗位并发派发等待同一岗位锁，两项均提交且不发生锁升级死锁',async()=>{
 const owner=randomUUID(),{role,plan,plans}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const {id:_id,ownerId:_owner,version:_version,configVersion:_config,state:_state,roleVersion:_roleVersion,archivedReason:_reason,archivedAt:_archived,createdAt:_created,updatedAt:_updated,source:fixedSource,...fields}=plan
 const second=await plans.create(owner,{requestId:randomUUID(),fields:{...fields,title:'同岗位的另一计划',expectedRoleVersion:1},source:fixedSource})
 await plans.change(owner,{planId:second.id,requestId:randomUUID(),expectedVersion:1,action:'enable'})
 const claims=await Promise.all([plan.id,second.id].map(planId=>service.claim(owner,{planId,now:'2026-09-11T01:00:00.000Z'})))
 const holder=await pool.connect();await holder.query('begin')
 const holderPid=(await holder.query('select pg_backend_pid() as pid')).rows[0].pid as number
 await holder.query('select id from teloa_roles where id=$1 for update',[role.id])
 const pending=Promise.allSettled(claims.map(({occurrence})=>service.dispatchTask(owner,{claimId:occurrence!.id,taskRequestId:occurrence!.taskRequestId,now:'2026-09-11T01:00:01.000Z'})))
 try{
  await waitForBlockers(holderPid,2)
  await holder.query('commit')
  const results=await pending
  for(const result of results)assert.equal(result.status,'fulfilled',result.status==='rejected'?String(result.reason):undefined)
  assert.equal((await pool.query('select count(*) from teloa_tasks where owner_id=$1',[owner])).rows[0].count,'2')
  assert.equal((await pool.query('select count(*) from teloa_plan_task_links where owner_id=$1',[owner])).rows[0].count,'2')
  assert.deepEqual(await service.pending(owner),[])
 }finally{await holder.query('rollback');holder.release();await pending}
})

test('普通任务创建持有同请求锁时原子派发等待，恢复后返回同一任务且无反序死锁',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const claim=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 let release!:()=>void,locked!:()=>void,holderPid=0
 const gate=new Promise<void>(resolve=>{release=resolve}),ready=new Promise<void>(resolve=>{locked=resolve})
 const childKey=JSON.stringify(['teloa/conversation-task-child',owner,claim.taskRequestId]),taskKey=JSON.stringify(['teloa/task-create',owner,claim.taskRequestId]),acquired:unknown[]=[]
 const tasks=new TaskService(observedPool(async(sql,run,values)=>{
  const result=await run()
  if(sql.includes('pg_advisory_xact_lock'))acquired.push(values?.[0])
  if(sql.includes('pg_advisory_xact_lock')&&values?.[0]===childKey&&holderPid===0){
   assert.deepEqual(acquired,[childKey],'第一把保护必须是确定子键 C')
   const holders=await pool.query("select pid from pg_locks where locktype='advisory' and granted and pid<>pg_backend_pid()")
   assert.equal(holders.rowCount,1);holderPid=holders.rows[0].pid;locked();await gate
  }
  return result
 }),{id:randomUUID,now:()=>'2026-09-11T01:00:01.000Z'})
 const ordinary=tasks.create(owner,claim.taskRequest)
 const ordinaryResult=ordinary.then(value=>({value}),error=>({error}))
 let dispatched:ReturnType<PlanOccurrenceService['dispatchTask']>|undefined
 try{
  await ready
  dispatched=service.dispatchTask(owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:'2026-09-11T01:00:01.000Z'})
  const dispatchResult=dispatched.then(value=>({value}),error=>({error}))
  await waitForBlockers(holderPid,1);release()
  const [a,b]=await Promise.all([ordinaryResult,dispatchResult])
  assert.ok('value' in a,'普通创建应成功');assert.ok('value' in b,'原子派发应成功')
  assert.deepEqual(acquired,[childKey,taskKey],'无父普通 Task 必须先 C 后 task-create，不能倒序或漏锁')
  assert.equal(a.value.id,b.value.task.id)
  assert.equal((await pool.query('select count(*) from teloa_tasks where owner_id=$1',[owner])).rows[0].count,'1')
  assert.deepEqual(b.value.association,{claimId:claim.id,taskRequestId:claim.taskRequestId,taskId:a.value.id})
 }finally{release();await Promise.allSettled([ordinary,...(dispatched?[dispatched]:[])])}
})

test('真实提交后丢失回包，新服务在计划与岗位暂停后仍恢复固定任务及关联',async()=>{
 const owner=randomUUID(),{role,plan,plans}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const claim=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 const input={claimId:claim.id,taskRequestId:claim.taskRequestId,now:'2026-09-11T01:00:01.000Z'}
 let lost=false
 const broken=new PlanOccurrenceService(observedPool(async(sql,run)=>{
  const result=await run()
  if(sql==='commit'&&!lost){lost=true;throw new Error('提交已成功，回执丢失')}
  return result
 }),{id:randomUUID})
 await assert.rejects(broken.dispatchTask(owner,input),/提交已成功，回执丢失/)
 assert.equal(lost,true)
 const committed=(await pool.query('select id,request_id from teloa_tasks where owner_id=$1',[owner])).rows
 assert.equal(committed.length,1);assert.equal(committed[0].request_id,claim.taskRequestId)
 assert.deepEqual(await service.pending(owner),[])
 await plans.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,action:'pause'})
 await pool.query("update teloa_roles set state='paused',version=version+1 where id=$1",[role.id])
 const recovered=await new PlanOccurrenceService(pool,{id:()=>{throw new Error('恢复不得生成新任务身份')}}).dispatchTask(owner,input)
 assert.equal(recovered.task.id,committed[0].id)
 assert.deepEqual(recovered.association,{claimId:claim.id,taskRequestId:claim.taskRequestId,taskId:committed[0].id})
 assert.equal((await pool.query('select count(*) from teloa_tasks where owner_id=$1',[owner])).rows[0].count,'1')
 assert.equal((await pool.query('select count(*) from teloa_plan_task_links where owner_id=$1',[owner])).rows[0].count,'1')
})

test('同计划前次未派发时到点明确跳过并保存原因，推进游标且不新增领取',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const prior=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 const results=await Promise.all(Array.from({length:4},()=>service.claim(owner,{planId:plan.id,now:'2026-09-12T01:00:00.000Z'})))
 const skipped=results.find(result=>result.skip)!
 assert.equal(skipped.dispatch,false);assert.equal(skipped.occurrence,null)
 assert.equal(skipped.skip!.reason,'previous-pending');assert.equal(skipped.skip!.blockingClaimId,prior.id);assert.equal(skipped.skip!.taskId,null)
 assert.equal(results.filter(result=>result.skip).length,1)
 assert.deepEqual(await service.skips(owner,{planId:plan.id}),[skipped.skip])
 assert.deepEqual(await service.list(owner,{planId:plan.id}),[prior])
 assert.deepEqual(await service.claim(owner,{planId:plan.id,now:'2026-09-12T01:00:01.000Z'}),{occurrence:null,dispatch:false})
 assert.equal((await pool.query('select next_at from teloa_plan_schedule_state where plan_id=$1',[plan.id])).rows[0].next_at.toISOString(),'2026-09-13T01:00:00.000Z')
 await assert.rejects(service.skips('other',{planId:plan.id}),{code:'teloa/forbidden'})
 assert.deepEqual(await service.skips('other',{}),[])
})

test('前次任务所有未结束状态均阻止重叠，完成或取消后下一到点恢复',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const first=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 const {task}=await service.dispatchTask(owner,{claimId:first.id,taskRequestId:first.taskRequestId,now:'2026-09-11T01:00:01.000Z'})
 let day=12
 for(const state of ['ready','running','paused','waiting','blocked']){
  await pool.query('update teloa_tasks set state=$2 where id=$1',[task.id,state])
  const result=await service.claim(owner,{planId:plan.id,now:`2026-09-${day++}T01:00:00.000Z`})
  assert.equal(result.skip?.reason,'previous-task-unfinished');assert.equal(result.skip?.taskId,task.id)
 }
 await pool.query("update teloa_tasks set state='completed' where id=$1",[task.id])
 const second=(await service.claim(owner,{planId:plan.id,now:`2026-09-${day++}T01:00:00.000Z`})).occurrence!
 assert.ok(second);const next=await service.dispatchTask(owner,{claimId:second.id,taskRequestId:second.taskRequestId,now:'2026-09-17T01:00:01.000Z'})
 await pool.query("update teloa_tasks set state='cancelled' where id=$1",[next.task.id])
 assert.equal((await service.claim(owner,{planId:plan.id,now:`2026-09-${day}T01:00:00.000Z`})).dispatch,true)
 assert.equal((await service.skips(owner,{planId:plan.id})).length,5)
})

test('暂停和新版本使无任务旧领取显式失效，历史保留且不阻塞新领取',async()=>{
 const owner=randomUUID(),{plan,plans}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const old=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 const paused=await plans.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,action:'pause'})
 assert.deepEqual(await service.pending(owner),[])
 assert.deepEqual((await service.list(owner,{planId:plan.id}))[0]!.invalidated,{reason:'plan-paused',observedPlanUpdatedAt:paused.updatedAt})
 const resumed=await new PlanService(pool,{id:randomUUID,now:()=>'2026-09-12T00:00:00.000Z'}).change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:paused.version,action:'enable'})
 assert.deepEqual((await service.list(owner,{planId:plan.id}))[0]!.invalidated,{reason:'plan-version-changed',observedPlanUpdatedAt:resumed.updatedAt})
 const fresh=await service.claim(owner,{planId:plan.id,now:'2026-09-12T01:00:00.000Z'})
 assert.equal(fresh.dispatch,true);assert.notEqual(fresh.occurrence?.id,old.id)
 assert.deepEqual(await service.pending(owner),[fresh.occurrence])
 assert.equal((await service.list(owner,{planId:plan.id})).length,2)
 await assert.rejects(service.dispatchTask(owner,{claimId:old.id,taskRequestId:old.taskRequestId,now:'2026-09-12T01:00:01.000Z'}),{code:'teloa/version-conflict'})
 const archived=await plans.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:resumed.version,action:'archive',note:'结束计划'})
 assert.equal((await service.list(owner,{planId:plan.id}))[1]!.invalidated?.reason,'plan-archived')
 assert.equal(archived.state,'archived');assert.deepEqual(await service.pending(owner),[])
})

test('跨版本已创建但未关联的任务不被作废，恢复原关联前后均阻止同计划重叠',async()=>{
 const owner=randomUUID(),{plan,plans}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const old=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 const task=await new TaskService(pool,{id:randomUUID,now:()=>'2026-09-11T01:00:01.000Z'}).create(owner,old.taskRequest)
 const paused=await plans.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,action:'pause'})
 assert.deepEqual(await service.pending(owner),[old])
 await new PlanService(pool,{id:randomUUID,now:()=>'2026-09-12T00:00:00.000Z'}).change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:paused.version,action:'enable'})
 const blocked=await service.claim(owner,{planId:plan.id,now:'2026-09-12T01:00:00.000Z'})
 assert.equal(blocked.skip?.reason,'previous-task-unfinished');assert.equal(blocked.skip?.taskId,task.id)
 const recovered=await service.dispatchTask(owner,{claimId:old.id,taskRequestId:old.taskRequestId,now:'2026-09-12T01:00:01.000Z'})
 assert.equal(recovered.task.id,task.id);assert.deepEqual(await service.pending(owner),[])
 assert.equal((await service.claim(owner,{planId:plan.id,now:'2026-09-13T01:00:00.000Z'})).skip?.taskId,task.id)
})

test('非法任务状态显式阻断领取，不推进游标；跳过记录的阻塞身份错配拒绝读取',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const claim=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 const {task}=await service.dispatchTask(owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:'2026-09-11T01:00:01.000Z'})
 await pool.query('alter table teloa_tasks drop constraint teloa_tasks_state_check')
 try{
  await pool.query("update teloa_tasks set state='unknown' where id=$1",[task.id])
  await assert.rejects(service.claim(owner,{planId:plan.id,now:'2026-09-12T01:00:00.000Z'}),{code:'teloa/storage-corrupt'})
  assert.equal((await pool.query('select next_at from teloa_plan_schedule_state where plan_id=$1',[plan.id])).rows[0].next_at.toISOString(),'2026-09-12T01:00:00.000Z')
 }finally{
  await pool.query("update teloa_tasks set state='ready' where id=$1",[task.id])
  await pool.query("alter table teloa_tasks add constraint teloa_tasks_state_check check(state in ('ready','running','paused','waiting','blocked','completed','cancelled'))")
 }
 await service.claim(owner,{planId:plan.id,now:'2026-09-12T01:00:00.000Z'})
 const otherOwner=randomUUID(),other=await activePlan(otherOwner)
 const otherClaim=(await service.claim(otherOwner,{planId:other.plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 await pool.query('update teloa_plan_schedule_skips set blocking_claim_id=$2 where plan_id=$1',[plan.id,otherClaim.id])
 await assert.rejects(service.skips(owner,{planId:plan.id}),{code:'teloa/storage-corrupt'})
})

test('执行上下文只读取任务的固定计划依据，暂停后仍可读取；普通任务无计划上下文',async()=>{
 const owner=randomUUID(),{plan,plans}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const claim=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 const {task}=await service.dispatchTask(owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:'2026-09-11T01:00:01.000Z'})
 await plans.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,action:'pause'})
 const ordinary=await new TaskService(pool,{id:randomUUID,now:()=>'2026-09-11T02:00:00.000Z'}).create(owner,{requestId:randomUUID(),fields:{title:'普通任务',goal:'核对',scope:'general'}})
 const client=await pool.connect()
 try{
  await client.query('begin')
  assert.deepEqual(await service.executionContext(client,owner,task.id),{occurrenceId:claim.id,goal:claim.fields.goal,dataScope:claim.fields.dataScope,delivery:claim.fields.delivery})
  assert.equal(await service.executionContext(client,owner,ordinary.id),undefined)
  await assert.rejects(service.executionContext(client,'other',task.id),{code:'teloa/forbidden'})
  await client.query("update teloa_tasks set definition=jsonb_set(definition,'{goal}','\"改变原计划目标\"') where id=$1",[task.id])
  await assert.rejects(service.executionContext(client,owner,task.id),{code:'teloa/storage-corrupt'})
  await client.query('rollback')
 }finally{await client.query('rollback');client.release()}
})

test('计划执行上下文拒绝缺失关联和错配关联，不降级成普通任务',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const claim=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 const task=await new TaskService(pool,{id:randomUUID,now:()=>'2026-09-11T01:00:01.000Z'}).create(owner,claim.taskRequest)
 const client=await pool.connect()
 try{
  await assert.rejects(service.executionContext(client,owner,task.id),{code:'teloa/storage-corrupt'})
  await service.linkTask(owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,taskId:task.id})
  await client.query('begin')
  await client.query('update teloa_plan_task_links set task_request_id=$2 where task_id=$1',[task.id,randomUUID()])
  await assert.rejects(service.executionContext(client,owner,task.id),{code:'teloa/storage-corrupt'})
 }finally{await client.query('rollback');client.release()}
})

async function executionFixture(owner:string){
 const {plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const occurrence=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 const {task}=await service.dispatchTask(owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now:'2026-09-11T01:00:01.000Z'})
 const sessionId=randomUUID(),conversationId=randomUUID(),now=()=>'2026-09-11T01:00:02.000Z'
 const inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 const prepare=async(resolveRuntime?:Parameters<TaskRunService['prepare']>[5])=>{
  await new ObjectConversationService(pool,inspect,now).change(owner,{requestId:occurrence.id,kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  return runs.prepare(owner,{requestId:occurrence.id,taskId:task.id,expectedTaskVersion:1,roleId:occurrence.fields.roleId,expectedRoleVersion:occurrence.roleVersion,sessionId,expectedLinkVersion:1},undefined,undefined,undefined,resolveRuntime)
 }
 const runs=new TaskRunService(pool,{id:randomUUID,now},inspect,{allowedTools:[],planContext:(db,actor,id)=>service.executionContext(db,actor,id)})
 return {service,occurrence,task,runs,prepare}
}

test('真实执行历史按领取时间倒序分页并核对本人、任务和原生会话',async()=>{
 const owner=randomUUID(),other=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const claims=[] as Awaited<ReturnType<PlanOccurrenceService['claim']>>['occurrence'][]
 const tasks=[] as Awaited<ReturnType<PlanOccurrenceService['dispatchTask']>>['task'][]
 for(const [index,now] of ['2026-09-11T01:00:00.000Z','2026-09-12T01:00:00.000Z','2026-09-13T01:00:00.000Z'].entries()){
  const claim=(await service.claim(owner,{planId:plan.id,now})).occurrence!;claims.push(claim)
  if(index>0){
   const task=(await service.dispatchTask(owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now})).task;tasks.push(task)
   if(index===1)await pool.query("update teloa_tasks set state='completed' where id=$1",[task.id])
  }else{
   const plans=new PlanService(pool,{id:randomUUID,now:()=>now}),current=await plans.get(owner,{planId:plan.id})
   await plans.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:current.version,action:'pause'})
   const paused=await plans.get(owner,{planId:plan.id})
   await new PlanService(pool,{id:randomUUID,now:()=>new Date(Date.parse(now)+1).toISOString()}).change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:paused.version,action:'enable'})
  }
 }
 const latest={occurrence:claims[2]!,task:tasks[1]!},sessionId=randomUUID(),conversationId=randomUUID(),runNow=()=>'2026-09-13T01:00:02.000Z'
 const inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,runNow).change(owner,{requestId:randomUUID(),kind:'task',objectId:latest.task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const run=await new TaskRunService(pool,{id:randomUUID,now:runNow},inspect,{allowedTools:[],planContext:(db,actor,id)=>service.executionContext(db,actor,id)}).prepare(owner,{requestId:latest.occurrence.id,taskId:latest.task.id,expectedTaskVersion:1,roleId:latest.occurrence.fields.roleId,expectedRoleVersion:latest.occurrence.roleVersion,sessionId,expectedLinkVersion:1})

 const first=await service.executionHistory(owner,{planId:plan.id,limit:2})
 assert.deepEqual(first.items.map(item=>item.claimId),[claims[2]!.id,claims[1]!.id])
 assert.deepEqual(first.cursor,{claimedAt:claims[1]!.claimedAt,claimId:claims[1]!.id})
 assert.deepEqual(first.items[0]!.task,{id:latest.task.id,state:'ready'})
 assert.deepEqual(first.items[0]!.run,{id:run.id,state:'prepared',sessionId:run.sessionId,createdAt:run.createdAt})
 const second=await service.executionHistory(owner,{planId:plan.id,limit:2,cursor:first.cursor})
 assert.deepEqual(second.items.map(item=>item.claimId),[claims[0]!.id])
 assert.equal(second.items[0]!.task,null);assert.equal(second.items[0]!.run,null);assert.equal(second.cursor,undefined)
 await assert.rejects(service.executionHistory(other,{planId:plan.id,limit:2}),{code:'teloa/forbidden'})
 for(const input of [{planId:plan.id,limit:0},{planId:plan.id,limit:51},{planId:plan.id,limit:1.5},{planId:plan.id,limit:2,extra:true}])await assert.rejects(service.executionHistory(owner,input),{code:'teloa/invalid-input'})
 await assert.rejects(service.executionHistory(other,{planId:plan.id,limit:2,cursor:first.cursor}),{code:'teloa/forbidden'})
 const otherPlan=(await activePlan(owner)).plan
 await assert.rejects(service.executionHistory(owner,{planId:otherPlan.id,limit:2,cursor:first.cursor}),{code:'teloa/forbidden'})
 await assert.rejects(service.executionHistory(owner,{planId:plan.id,limit:2,cursor:{...first.cursor!,claimedAt:'2026-09-12T01:00:01.000Z'}}),{code:'teloa/invalid-input'})
 const unrelated=await new TaskService(pool,{id:randomUUID,now:runNow}).create(owner,{requestId:randomUUID(),fields:{title:'其他任务',goal:'不属于本次计划领取',scope:'general'}})
 await pool.query('update teloa_task_runs set task_id=$2 where id=$1',[run.id,unrelated.id])
 const mismatched=await service.executionHistory(owner,{planId:plan.id,limit:2})
 assert.deepEqual(mismatched.items.map(item=>item.claimId),[claims[1]!.id])
 assert.deepEqual(mismatched.errors,[{claimId:claims[2]!.id,code:'teloa/storage-corrupt'}])
})

test('跨计划执行目录在limit前按固定快照、首轮状态和普通文本筛选',async()=>{
 const owner=randomUUID(),first=await activePlan(owner,'2026-09-11T00:00:00.000Z',{title:'Alpha 100% 核对',scope:'SOC'}),second=await activePlan(owner,'2026-09-11T00:00:00.000Z',{title:'Beta 核对',scope:'general'})
 const service=new PlanOccurrenceService(pool,{id:randomUUID})
 const old=(await service.claim(owner,{planId:first.plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 const oldTask=(await service.dispatchTask(owner,{claimId:old.id,taskRequestId:old.taskRequestId,now:'2026-09-11T01:00:01.000Z'})).task
 const fresh=(await service.claim(owner,{planId:second.plan.id,now:'2026-09-12T01:00:00.000Z'})).occurrence!
 const freshTask=(await service.dispatchTask(owner,{claimId:fresh.id,taskRequestId:fresh.taskRequestId,now:'2026-09-12T01:00:01.000Z'})).task
 const sessionId=randomUUID(),conversationId=randomUUID(),now=()=>'2026-09-12T01:00:02.000Z',inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,now).change(owner,{requestId:fresh.id,kind:'task',objectId:freshTask.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 await new TaskRunService(pool,{id:randomUUID,now},inspect,{allowedTools:[],planContext:(db,actor,id)=>service.executionContext(db,actor,id)}).prepare(owner,{requestId:fresh.id,taskId:freshTask.id,expectedTaskVersion:1,roleId:fresh.fields.roleId,expectedRoleVersion:fresh.roleVersion,sessionId,expectedLinkVersion:1})

 assert.deepEqual((await service.executionHistory(owner,{limit:1,scope:'SOC'})).items.map(item=>item.claimId),[old.id])
 assert.deepEqual((await service.executionHistory(owner,{limit:1,roleId:first.role.id})).items.map(item=>item.claimId),[old.id])
 assert.deepEqual((await service.executionHistory(owner,{limit:1,runState:'not-started'})).items.map(item=>item.claimId),[old.id])
 assert.deepEqual((await service.executionHistory(owner,{limit:1,runState:'prepared'})).items.map(item=>item.claimId),[fresh.id])
 for(const query of [' 100% ','ALPHA',first.plan.id,old.id,oldTask.id])assert.deepEqual((await service.executionHistory(owner,{limit:1,query})).items.map(item=>item.claimId),[old.id])
 assert.deepEqual((await service.executionHistory(owner,{planId:first.plan.id,limit:1})).items.map(item=>item.claimId),[old.id])
 await pool.query("update teloa_plan_occurrences set snapshot=jsonb_set(snapshot,'{roleVersion}','99') where id=$1",[old.id])
 const damaged=await service.executionHistory(owner,{limit:1,query:'Alpha'})
 assert.deepEqual(damaged.items,[]);assert.deepEqual(damaged.errors,[{claimId:old.id,code:'teloa/storage-corrupt'}])
 for(const input of [{limit:1,scope:'bad scope'},{limit:1,roleId:'bad'},{limit:1,query:' '},{limit:1,query:'x'.repeat(241)},{limit:1,runState:'queued'}])await assert.rejects(service.executionHistory(owner,input),{code:'teloa/invalid-input'})
})

test('跨计划执行目录同时间按claimId倒序分页，游标属本人且指定计划时须匹配',async()=>{
 const owner=randomUUID(),plans=await Promise.all([activePlan(owner),activePlan(owner)]),service=new PlanOccurrenceService(pool,{id:randomUUID}),claims=[] as NonNullable<Awaited<ReturnType<PlanOccurrenceService['claim']>>['occurrence']>[]
 for(const {plan} of plans){const claim=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!;claims.push(claim)}
 const claimedAt='2026-09-12T00:00:00.000Z';await pool.query('update teloa_plan_occurrences set claimed_at=$2 where id=any($1::uuid[])',[claims.map(item=>item.id),claimedAt])
 const expected=claims.map(item=>item.id).sort((a,b)=>b.localeCompare(a)),first=await service.executionHistory(owner,{limit:1}),second=await service.executionHistory(owner,{limit:1,cursor:first.cursor})
 assert.deepEqual([...first.items,...second.items].map(item=>item.claimId),expected)
 await assert.rejects(service.executionHistory(owner,{planId:plans.find(item=>item.plan.id!==claims.find(claim=>claim.id===first.items[0]!.claimId)!.planId)!.plan.id,limit:1,cursor:first.cursor}),{code:'teloa/forbidden'})
 await assert.rejects(service.executionHistory(randomUUID(),{limit:1,cursor:first.cursor}),{code:'teloa/forbidden'})
})

test('真实执行历史坏行消耗页额度并隔离错误，且不解析额外探针',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID}),fixtures=[]
 for(const now of ['2026-09-11T01:00:00.000Z','2026-09-12T01:00:00.000Z','2026-09-13T01:00:00.000Z','2026-09-14T01:00:00.000Z']){
  const occurrence=(await service.claim(owner,{planId:plan.id,now})).occurrence!
  const task=(await service.dispatchTask(owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now})).task
  fixtures.push({occurrence,task});await pool.query("update teloa_tasks set state='completed' where id=$1",[task.id])
 }
 await pool.query('update teloa_plan_task_links set task_request_id=$2 where claim_id=$1',[fixtures[2]!.occurrence.id,randomUUID()])
 await pool.query("update teloa_plan_occurrences set snapshot=jsonb_set(snapshot,'{fields,title}',to_jsonb('探针损坏'::text)) where id=$1",[fixtures[0]!.occurrence.id])
 const page=await service.executionHistory(owner,{planId:plan.id,limit:3})
 assert.deepEqual(page.items.map(item=>item.claimId),[fixtures[3]!.occurrence.id,fixtures[1]!.occurrence.id])
 assert.deepEqual(page.errors,[{claimId:fixtures[2]!.occurrence.id,code:'teloa/storage-corrupt'}])
 assert.deepEqual(page.cursor,{claimedAt:fixtures[1]!.occurrence.claimedAt,claimId:fixtures[1]!.occurrence.id})
 await pool.query("update teloa_plan_occurrences set claimed_at='infinity' where id=$1",[fixtures[3]!.occurrence.id])
 await assert.rejects(service.executionHistory(owner,{planId:plan.id,limit:3}),{code:'teloa/storage-corrupt'})
})

test('历史固定首轮计划执行，不受后续人工执行、任务调整和当前授权状态影响',async()=>{
 const owner=randomUUID(),fixture=await executionFixture(owner),firstRun=await fixture.prepare()
 await fixture.runs.withdraw(owner,{runId:firstRun.id})
 const secondRun=await fixture.runs.prepare(owner,{requestId:randomUUID(),taskId:fixture.task.id,expectedTaskVersion:1,roleId:fixture.occurrence.fields.roleId,expectedRoleVersion:fixture.occurrence.roleVersion,sessionId:firstRun.sessionId,expectedLinkVersion:1})
 const before=await fixture.service.executionHistory(owner,{planId:fixture.occurrence.planId,limit:10})
 assert.equal(before.items[0]!.run!.id,firstRun.id);assert.notEqual(before.items[0]!.run!.id,secondRun.id)
 await fixture.runs.withdraw(owner,{runId:secondRun.id})
 const edited=await new TaskService(pool,{id:randomUUID,now:()=>'2026-09-11T01:00:03.000Z'}).edit(owner,{taskId:fixture.task.id,expectedVersion:1,fields:{title:'人工调整后的标题',goal:'人工调整后的目标'}})
 const replacement=(await activePlan(owner)).role
 await pool.query('update teloa_tasks set assignee_role_id=$2,assignee_role_version=$3,version=version+1 where id=$1',[fixture.task.id,replacement.id,replacement.version])
 await pool.query("update teloa_roles set state='paused',version=version+1 where id=any($1::uuid[])",[[fixture.occurrence.fields.roleId,replacement.id]])
 const conversationId=(await pool.query('select conversation_id from teloa_object_conversations where owner_id=$1 and object_id=$2 and session_id=$3',[owner,fixture.task.id,firstRun.sessionId])).rows[0].conversation_id
 const inspect=async()=>({id:conversationId,sessionId:firstRun.sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,()=>'2026-09-11T01:00:04.000Z').change(owner,{requestId:randomUUID(),kind:'task',objectId:fixture.task.id,expectedObjectVersion:edited.version+1,sessionId:firstRun.sessionId,expectedLinkVersion:1,action:'unlink'})
 const after=await fixture.service.executionHistory(owner,{planId:fixture.occurrence.planId,limit:10})
 assert.equal(after.items[0]!.task!.id,fixture.task.id);assert.equal(after.items[0]!.run!.id,firstRun.id)
 await pool.query("update teloa_tasks set request_spec=jsonb_set(request_spec,'{fields,goal}',to_jsonb('被篡改的固定目标'::text)) where id=$1",[fixture.task.id])
 const corrupt=await fixture.service.executionHistory(owner,{planId:fixture.occurrence.planId,limit:10})
 assert.deepEqual(corrupt.items,[]);assert.deepEqual(corrupt.errors,[{claimId:fixture.occurrence.id,code:'teloa/storage-corrupt'}])
})

test('同毫秒领取以claimId倒序稳定分页',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID}),claims=[]
 for(const now of ['2026-09-11T01:00:00.000Z','2026-09-12T01:00:00.000Z','2026-09-13T01:00:00.000Z']){
  const occurrence=(await service.claim(owner,{planId:plan.id,now})).occurrence!;claims.push(occurrence)
  const task=(await service.dispatchTask(owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now})).task
  await pool.query("update teloa_tasks set state='completed' where id=$1",[task.id])
 }
 const claimedAt='2026-09-14T00:00:00.000Z';await pool.query('update teloa_plan_occurrences set claimed_at=$2 where id=any($1::uuid[])',[claims.map(item=>item.id),claimedAt])
 const expected=claims.map(item=>item.id).sort((a,b)=>a<b?1:a>b?-1:0)
 const first=await service.executionHistory(owner,{planId:plan.id,limit:2}),second=await service.executionHistory(owner,{planId:plan.id,limit:2,cursor:first.cursor})
 assert.deepEqual([...first.items,...second.items].map(item=>item.claimId),expected)
 assert.deepEqual(first.cursor,{claimedAt,claimId:expected[1]!})
})

test('整页坏领取仍返回原始游标并可继续读取正常下一页',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID}),claims=[]
 for(const now of ['2026-09-11T01:00:00.000Z','2026-09-12T01:00:00.000Z','2026-09-13T01:00:00.000Z','2026-09-14T01:00:00.000Z']){
  const occurrence=(await service.claim(owner,{planId:plan.id,now})).occurrence!;claims.push(occurrence)
  const task=(await service.dispatchTask(owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now})).task
  await pool.query("update teloa_tasks set state='completed' where id=$1",[task.id])
 }
 await pool.query("update teloa_plan_occurrences set snapshot=jsonb_set(snapshot,'{fields,title}',to_jsonb('损坏'::text)) where id=any($1::uuid[])",[claims.slice(2).map(item=>item.id)])
 const bad=await service.executionHistory(owner,{planId:plan.id,limit:2})
 assert.deepEqual(bad.items,[]);assert.deepEqual(bad.errors,claims.slice(2).reverse().map(item=>({claimId:item.id,code:'teloa/storage-corrupt'})))
 assert.deepEqual(bad.cursor,{claimedAt:claims[2]!.claimedAt,claimId:claims[2]!.id})
 const good=await service.executionHistory(owner,{planId:plan.id,limit:2,cursor:bad.cursor})
 assert.deepEqual(good.items.map(item=>item.claimId),[claims[1]!.id,claims[0]!.id]);assert.equal(good.cursor,undefined)
})

test('已关联任务的执行恢复目录按固定领取分页，重建服务仍找到未准备执行',async()=>{
 const owner=randomUUID(),fixtures=await Promise.all(Array.from({length:3},()=>executionFixture(owner)))
 const service=new PlanOccurrenceService(pool,{id:randomUUID}),first=await service.pendingExecutions(owner,{limit:2})
 assert.equal(first.items.length,2);assert.ok(first.cursor)
 const second=await new PlanOccurrenceService(pool,{id:randomUUID}).pendingExecutions(owner,{limit:2,cursor:first.cursor})
 assert.equal(second.items.length,1);assert.equal(second.cursor,undefined)
 const items=[...first.items,...second.items]
 assert.equal(new Set(items.map(item=>item.job.claimId)).size,3)
 for(const item of items){
  const fixture=fixtures.find(value=>value.occurrence.id===item.job.claimId)!
  assert.deepEqual(item,{planId:fixture.occurrence.planId,job:{claimId:fixture.occurrence.id,taskId:fixture.task.id,taskCreatedVersion:1,taskTitle:fixture.occurrence.fields.title,roleId:fixture.occurrence.fields.roleId,roleVersion:fixture.occurrence.roleVersion},run:null,action:'prepare'})
 }
 assert.deepEqual(await service.pendingExecutions('other',{limit:2}),{items:[]})
 for(const input of [{limit:0},{limit:101},{limit:1.5},{limit:2,cursor:{claimId:'bad',claimedAt:'bad'}},{limit:2,extra:true}])await assert.rejects(service.pendingExecutions(owner,input),{code:'teloa/invalid-input'})
 await assert.rejects(service.pendingExecutions('other',{limit:2,cursor:first.cursor}),{code:'teloa/forbidden'})
})

test('执行阶段决定恢复动作，版本仍固定为创建版本；终轮与撤销不能重建',async()=>{
 const owner=randomUUID(),fixture=await executionFixture(owner),{service,runs,prepare,task}=fixture
 const prepared=await prepare()
 const item=()=>service.pendingExecutions(owner,{limit:10}).then(result=>result.items[0])
 assert.equal((await item())?.action,'start');assert.equal((await item())?.run?.state,'prepared')
 await runs.claim(owner,{runId:prepared.id})
 assert.equal((await item())?.action,'reconcile');assert.equal((await item())?.run?.state,'submitting')
 assert.equal((await pool.query('select version from teloa_tasks where id=$1',[task.id])).rows[0].version,2)
 assert.equal((await item())?.job.taskCreatedVersion,1)
 const ref={runId:prepared.id,sessionId:prepared.sessionId,nativeRequestId:prepared.nativeRequestId}
 await runs.record(owner,{...ref,evidence:{state:'accepted'}})
 assert.equal((await item())?.run?.state,'accepted')
 await runs.record(owner,{...ref,evidence:{state:'active',turn:0,messageSeq:1}})
 assert.equal((await item())?.run?.state,'active')
 await runs.record(owner,{...ref,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})
 assert.deepEqual(await service.pendingExecutions(owner,{limit:10}),{items:[]})
 const withdrawn=await executionFixture(owner),run=await withdrawn.prepare();await withdrawn.runs.withdraw(owner,{runId:run.id})
 assert.deepEqual(await service.pendingExecutions(owner,{limit:10}),{items:[]})
 const cancelled=await executionFixture(owner)
 await pool.query("update teloa_tasks set state='cancelled' where id=$1",[cancelled.task.id])
 const skipped=(await service.pendingExecutions(owner,{limit:10})).items
 assert.equal(skipped.length,1);assert.equal(skipped[0]?.action,'skip');assert.equal(skipped[0]?.reason,'task-ended')
})

test('计划运行配置失败进入历史与状态筛选，恢复目录不再重试',async()=>{
 const owner=randomUUID(),fixture=await executionFixture(owner),run=await fixture.prepare(async()=>{throw new Error('preset missing')})
 assert.equal(run.state,'configuration_failed')
 const history=await fixture.service.executionHistory(owner,{planId:fixture.occurrence.planId,limit:10})
 assert.equal(history.items[0]?.run?.state,'configuration_failed')
 assert.deepEqual((await fixture.service.executionHistory(owner,{limit:10,runState:'configuration_failed'})).items.map(item=>item.claimId),[fixture.occurrence.id])
 assert.deepEqual(await fixture.service.pendingExecutions(owner,{limit:10}),{items:[]})
})

test('恢复目录不把未知执行状态或错配执行身份漏成无执行',async()=>{
 const owner=randomUUID(),fixture=await executionFixture(owner),run=await fixture.prepare()
 await pool.query('alter table teloa_task_runs drop constraint teloa_task_runs_state_v3')
 try{
  await pool.query("update teloa_task_runs set state='unrecognized' where id=$1",[run.id])
  assert.deepEqual((await fixture.service.pendingExecutions(owner,{limit:10})).errors,[{claimId:fixture.occurrence.id,planId:fixture.occurrence.planId,code:'teloa/storage-corrupt'}])
 }finally{
  await pool.query("update teloa_task_runs set state='prepared' where id=$1",[run.id])
  await pool.query("alter table teloa_task_runs add constraint teloa_task_runs_state_v3 check(state in ('prepared','submitting','accepted','active','ended','withdrawn','configuration_failed'))")
 }
 const other=await executionFixture(owner)
 await pool.query('update teloa_task_runs set task_id=$2 where id=$1',[run.id,other.task.id])
 assert.deepEqual((await fixture.service.pendingExecutions(owner,{limit:10})).errors,[{claimId:fixture.occurrence.id,planId:fixture.occurrence.planId,code:'teloa/storage-corrupt'}])
 await pool.query('update teloa_task_runs set task_id=$2 where id=$1',[run.id,fixture.task.id])
 await pool.query("update teloa_task_runs set input_text='bad snapshot' where id=$1",[run.id])
 assert.deepEqual((await fixture.service.pendingExecutions(owner,{limit:10})).errors,[{claimId:fixture.occurrence.id,planId:fixture.occurrence.planId,code:'teloa/storage-corrupt'}])
})

test('恢复分页按扫描记录推进，空终态页和显式跳过页都不会漏掉后续待执行任务',async()=>{
 const owner=randomUUID(),fixtures=await Promise.all(Array.from({length:4},()=>executionFixture(owner)))
 fixtures.sort((a,b)=>a.occurrence.id.localeCompare(b.occurrence.id))
 for(const index of [0,2]){const fixture=fixtures[index]!,run=await fixture.prepare();await fixture.runs.withdraw(owner,{runId:run.id})}
 await pool.query("update teloa_tasks set state='completed' where id=$1",[fixtures[1]!.task.id])
 const service=fixtures[0]!.service
 const first=await service.pendingExecutions(owner,{limit:1})
 assert.deepEqual(first.items,[]);assert.equal(first.cursor?.claimId,fixtures[0]!.occurrence.id)
 const second=await service.pendingExecutions(owner,{limit:1,cursor:first.cursor})
 assert.equal(second.items[0]?.action,'skip');assert.equal(second.cursor?.claimId,fixtures[1]!.occurrence.id)
 const third=await service.pendingExecutions(owner,{limit:1,cursor:second.cursor})
 assert.deepEqual(third.items,[]);assert.equal(third.cursor?.claimId,fixtures[2]!.occurrence.id)
 const fourth=await service.pendingExecutions(owner,{limit:1,cursor:third.cursor})
 assert.equal(fourth.items[0]?.action,'prepare');assert.equal(fourth.items[0]?.job.claimId,fixtures[3]!.occurrence.id);assert.equal(fourth.cursor,undefined)
})

test('调度概览读真实游标与最近任务，暂停不再显示未来触发，跨本人拒绝',async()=>{
 const owner=randomUUID(),{plan,plans}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const empty=await service.overview(owner,{planId:plan.id})
 assert.equal(empty.nextAt,null);assert.equal(empty.latest,null);assert.equal(empty.latestSkip,null)
 await service.recover(owner,{planId:plan.id,now:'2026-09-11T00:30:00.000Z'})
 assert.equal((await service.overview(owner,{planId:plan.id})).nextAt,'2026-09-11T01:00:00.000Z')
 const occurrence=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 const dispatched=await service.dispatchTask(owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now:'2026-09-11T01:00:01.000Z'})
 await service.claim(owner,{planId:plan.id,now:'2026-09-12T01:00:00.000Z'})
 const active=await service.overview(owner,{planId:plan.id})
 assert.equal(active.latest?.occurrence.id,occurrence.id);assert.deepEqual(active.latest?.task,{id:dispatched.task.id,state:'ready'})
 assert.equal(active.latestSkip?.reason,'previous-task-unfinished');assert.equal(active.nextAt,'2026-09-13T01:00:00.000Z')
 await plans.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,action:'pause'})
 const paused=await service.overview(owner,{planId:plan.id})
 assert.equal(paused.state,'paused');assert.equal(paused.nextAt,null);assert.equal(paused.latest?.task?.id,dispatched.task.id)
 await assert.rejects(service.overview(randomUUID(),{planId:plan.id}),{code:'teloa/forbidden'})
})


test('坏领取单独报告且分页继续，不阻塞其他计划恢复',async()=>{
 const owner=randomUUID(),fixtures=await Promise.all(Array.from({length:3},()=>executionFixture(owner)))
 fixtures.sort((a,b)=>a.occurrence.id.localeCompare(b.occurrence.id))
 await pool.query("update teloa_plan_occurrences set snapshot=jsonb_set(snapshot,'{fields,title}',to_jsonb('bad'::text)) where id=$1",[fixtures[0]!.occurrence.id])
 const service=fixtures[0]!.service,first=await service.pendingExecutions(owner,{limit:1})
 assert.deepEqual(first.errors,[{claimId:fixtures[0]!.occurrence.id,planId:fixtures[0]!.occurrence.planId,code:'teloa/storage-corrupt'}]);assert.deepEqual(first.items,[])
 assert.equal(first.cursor?.claimId,fixtures[0]!.occurrence.id)
 const second=await service.pendingExecutions(owner,{limit:2,cursor:first.cursor})
 assert.equal(second.items.length,2);assert.equal(second.errors,undefined)
})

test('旧待派发领取损坏逐条报告，正常领取仍可跨页恢复',async()=>{
 const owner=randomUUID(),plans=await Promise.all([activePlan(owner),activePlan(owner),activePlan(owner)])
 const service=new PlanOccurrenceService(pool,{id:randomUUID}),claims=[]
 for(const {plan} of plans)claims.push((await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!)
 claims.sort((a,b)=>a.id.localeCompare(b.id))
 await pool.query("update teloa_plan_occurrences set snapshot=jsonb_set(snapshot,'{fields,title}',to_jsonb('bad'::text)) where id=$1",[claims[0]!.id])
 const first=await service.recoveryPending(owner,{limit:1})
 assert.deepEqual(first.items,[]);assert.deepEqual(first.errors,[{claimId:claims[0]!.id,planId:claims[0]!.planId,code:'teloa/storage-corrupt'}]);assert.ok(first.cursor)
 const next=await service.recoveryPending(owner,{limit:5,cursor:first.cursor})
 assert.deepEqual(next.items.map(item=>item.id),claims.slice(1).map(item=>item.id))
 await assert.rejects(service.recoveryPending('other',{limit:5,cursor:first.cursor}),{code:'teloa/forbidden'})
})

test('终态任务跳过确认后恢复目录不再重复报告，损坏确认显式隔离',async()=>{
 const {initializePlanSchedulerStatus,PlanSchedulerStatusService}=await import('../src/work/plan-scheduler-status.ts')
 await initializePlanSchedulerStatus(pool)
 const owner=randomUUID(),f=await executionFixture(owner)
 await pool.query("update teloa_tasks set state='completed' where id=$1",[f.task.id])
 const status=new PlanSchedulerStatusService(pool,{now:()=>'2026-09-11T02:00:00.000Z'})
 await status.acknowledge(owner,{claimId:f.occurrence.id,taskId:f.task.id,reason:'task-ended'})
 assert.deepEqual(await f.service.pendingExecutions(owner,{limit:5}),{items:[]})
 await pool.query('update teloa_plan_scheduler_acks set owner_id=$2 where claim_id=$1',[f.occurrence.id,'other'])
 assert.deepEqual((await f.service.pendingExecutions(owner,{limit:5})).errors,[{claimId:f.occurrence.id,planId:f.occurrence.planId,code:'teloa/storage-corrupt'}])
})

test('完整跳过历史按倒序三元游标稳定分页并隔离本人和计划',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),other=(await activePlan(owner)).plan,service=new PlanOccurrenceService(pool,{id:randomUUID})
 await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})
 for(const now of ['2026-09-12T01:00:00.000Z','2026-09-13T01:00:00.000Z','2026-09-14T01:00:00.000Z'])await service.claim(owner,{planId:plan.id,now})
 const sameTime='2026-09-15T00:00:00.000Z';await pool.query('update teloa_plan_schedule_skips set skipped_at=$2 where plan_id=$1',[plan.id,sameTime])
 const expected=(await pool.query('select occurrence_id from teloa_plan_schedule_skips where plan_id=$1 order by skipped_at desc,config_version desc,occurrence_id collate "C" desc',[plan.id])).rows.map(row=>row.occurrence_id)
 const first=await service.skipHistory(owner,{planId:plan.id,limit:2}),second=await service.skipHistory(owner,{planId:plan.id,limit:2,cursor:first.cursor})
 assert.deepEqual([...first.items,...second.items].map(item=>item.occurrenceId),expected)
 assert.deepEqual(first.cursor,{skippedAt:sameTime,configVersion:1,occurrenceId:expected[1]})
 await assert.rejects(service.skipHistory(owner,{planId:other.id,limit:2,cursor:first.cursor}),{code:'teloa/forbidden'})
 await assert.rejects(service.skipHistory(randomUUID(),{planId:plan.id,limit:2,cursor:first.cursor}),{code:'teloa/forbidden'})
 await assert.rejects(service.skipHistory(owner,{planId:plan.id,limit:2,cursor:{...first.cursor!,skippedAt:'2026-09-15T00:00:01.000Z'}}),{code:'teloa/invalid-input'})
 await assert.rejects(service.skipHistory(owner,{planId:plan.id,limit:2,cursor:{...first.cursor!,configVersion:2147483648}}),{code:'teloa/invalid-input'})
})

test('完整跳过历史坏行消耗页额度并从尾页继续，额外探针不被解析',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const claim=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!
 await service.dispatchTask(owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:'2026-09-11T01:00:01.000Z'})
 for(const now of ['2026-09-12T01:00:00.000Z','2026-09-13T01:00:00.000Z','2026-09-14T01:00:00.000Z'])await service.claim(owner,{planId:plan.id,now})
 const ordered=(await pool.query('select occurrence_id from teloa_plan_schedule_skips where plan_id=$1 order by skipped_at desc,config_version desc,occurrence_id collate "C" desc',[plan.id])).rows.map(row=>row.occurrence_id as string)
 const unrelated=await new TaskService(pool,{id:randomUUID,now:()=>'2026-09-15T00:00:00.000Z'}).create(owner,{requestId:randomUUID(),fields:{title:'无关任务',goal:'不能替代固定阻塞任务',scope:'general'}})
 try{
  await pool.query("update teloa_plan_schedule_skips set task_id=$3 where plan_id=$1 and occurrence_id=$2",[plan.id,ordered[0],unrelated.id])
  const page=await service.skipHistory(owner,{planId:plan.id,limit:1})
  assert.deepEqual(page.items,[]);assert.deepEqual(page.errors,[{skippedAt:'2026-09-14T01:00:00.000Z',configVersion:1,occurrenceId:ordered[0],code:'teloa/storage-corrupt'}]);assert.ok(page.cursor)
  const next=await service.skipHistory(owner,{planId:plan.id,limit:1,cursor:page.cursor})
  assert.equal(next.items[0]?.occurrenceId,ordered[1])
  await pool.query("update teloa_plan_schedule_skips set skipped_at='infinity' where plan_id=$1 and occurrence_id=$2",[plan.id,ordered[2]])
  await assert.rejects(service.skipHistory(owner,{planId:plan.id,limit:3}),{code:'teloa/storage-corrupt'})
 }finally{
  await pool.query("update teloa_plan_schedule_skips set skipped_at='2026-09-12T01:00:00.000Z' where plan_id=$1 and occurrence_id=$2",[plan.id,ordered[2]])
 }
})

test('完整跳过历史保留固定阻塞关联，不依赖任务和岗位当前状态',async()=>{
 const owner=randomUUID(),{plan,role}=await activePlan(owner),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const claim=(await service.claim(owner,{planId:plan.id,now:'2026-09-11T01:00:00.000Z'})).occurrence!,task=(await service.dispatchTask(owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:'2026-09-11T01:00:01.000Z'})).task
 await service.claim(owner,{planId:plan.id,now:'2026-09-12T01:00:00.000Z'})
 await pool.query("update teloa_tasks set state='completed' where id=$1",[task.id]);await pool.query("update teloa_roles set state='retired' where id=$1",[role.id])
 const history=await service.skipHistory(owner,{planId:plan.id,limit:10})
 assert.equal(history.items[0]?.blockingClaimId,claim.id);assert.equal(history.items[0]?.taskId,task.id)
 for(const input of [{planId:plan.id,limit:0},{planId:plan.id,limit:51},{planId:plan.id,limit:1.5},{planId:plan.id,limit:1,extra:true}])await assert.rejects(service.skipHistory(owner,input),{code:'teloa/invalid-input'})
})
