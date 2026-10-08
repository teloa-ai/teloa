import test,{before,after,describe} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import type {WorkSource} from '@teloa/contract'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {initializeObjectConversations} from '../src/work/object-conversations.ts'
import {initializeTaskRuns} from '../src/work/task-runs.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializePlanOccurrences,PlanOccurrenceService} from '../src/work/plan-occurrences.ts'
import {PlanService} from '../src/work/plans.ts'
import {initializeTaskRunSubagents,TaskRunSubagentService} from '../src/work/task-run-subagents.ts'
import {initializeWorkLineage,WorkLineageService,readWorkLineage as backendLineage,readWorkSource as backendSource} from '../src/work/work-lineage.ts'
import {readWorkLineage,readWorkSource} from '../../contract/src/work-lineage.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

test('公共读取器由 backend 原样复用，UUID 来源规范化与谱系形状保持不变',()=>{
 assert.equal(backendLineage,readWorkLineage);assert.equal(backendSource,readWorkSource)
 const id='12345678-1234-4234-8234-123456789ABC',root={schema:'teloa.work-lineage/v1',ownerId:'local:owner',rootTaskId:id,definition:null,parentRunId:null,definitionControlId:null,roundControlId:id,controlGeneration:1,budgetAccountId:id}
 assert.deepEqual(readWorkLineage(root),root)
 assert.deepEqual(readWorkSource({kind:'owner-task',taskId:id}),{kind:'owner-task',taskId:id.toLowerCase()})
 assert.deepEqual(readWorkSource({kind:'plan-occurrence',claimId:id}),{kind:'plan-occurrence',claimId:id.toLowerCase()})
 assert.deepEqual(readWorkSource({kind:'group-run-message',messageId:id,runId:id}),{kind:'group-run-message',messageId:id.toLowerCase(),runId:id.toLowerCase()})
 assert.deepEqual(readWorkSource({kind:'team-child',parentRunId:id,memberId:'call:reservation-1'}),{kind:'team-child',parentRunId:id.toLowerCase(),memberId:'call:reservation-1'})
})

test('公共读取器保持缺字段、未知字段、版本与定义控制配对的拒绝判据',()=>{
 const id='12345678-1234-4234-8234-123456789012',root={schema:'teloa.work-lineage/v1',ownerId:'local:owner',rootTaskId:id,definition:null,parentRunId:null,definitionControlId:null,roundControlId:id,controlGeneration:1,budgetAccountId:id}
 for(const value of [null,[],{},...Object.keys(root).map(key=>Object.fromEntries(Object.entries(root).filter(([name])=>name!==key))),{...root,unknown:true},{...root,schema:'teloa.work-lineage/v2'},{...root,ownerId:' '},{...root,rootTaskId:'bad'},{...root,controlGeneration:0},{...root,controlGeneration:1.5},{...root,definitionControlId:id},{...root,definition:{planId:id,definitionVersion:2,occurrenceId:'bad\n'},definitionControlId:id}])assert.throws(()=>readWorkLineage(value),{code:'teloa/storage-corrupt'})
 for(const value of [null,{}, {kind:'owner-task',taskId:id,extra:true},{kind:'owner-task',taskId:'bad'},{kind:'plan-occurrence',claimId:id,taskId:id},{kind:'group-run-message',messageId:id},{kind:'team-child',parentRunId:id,memberId:'two members'},{kind:'unknown',taskId:id}])assert.throws(()=>readWorkSource(value),{code:'teloa/invalid-input'})
})

describe('持久工作谱系',()=>{
let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeWorkLineage(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeCollaboration(pool);await initializePlanOccurrences(pool);await initializeTaskRunSubagents(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function transaction<T>(body:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await pool.connect()
 try{await client.query('begin');const result=await body(client);await client.query('commit');return result}catch(error){await client.query('rollback');throw error}finally{client.release()}
}
async function task(owner:string=randomUUID(),requestId:string=randomUUID()){
 const id=randomUUID()
 await pool.query("insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,state,created_at,updated_at) values($1,$2,$3,$4,$5,1,'ready',now(),now())",[id,owner,requestId,JSON.stringify({fields:{title:'真实任务',goal:'核对资料',scope:'general'},assignee:null}),JSON.stringify({title:'真实任务',goal:'核对资料',scope:'general'})])
 return {id,owner,requestId}
}
function bind(service:WorkLineageService,target:{id:string;owner:string},source:WorkSource={kind:'owner-task',taskId:target.id}){return transaction(client=>service.bindTask(client,target.owner,{taskId:target.id,source}))}
async function role(owner:string){
 const value=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'核对岗',kind:'employee',scopes:['general'],duty:'核对资料',dataScope:'已授权资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 await pool.query("update teloa_roles set state='active' where id=$1",[value.id]);return value.id
}
async function run(target:{id:string;owner:string}){
 const id=randomUUID(),roleId=await role(target.owner)
 await pool.query("insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at) values($1,$2,$3,'{}',$4,$5,1,1,1,$6,$7,'active','{}',now())",[id,target.owner,randomUUID(),target.id,roleId,'lineage-run-'+id,randomUUID()])
 return {id,roleId,taskId:target.id,owner:target.owner}
}
async function message(source:Awaited<ReturnType<typeof run>>,rootId:string|null=null,existingGroupId?:string){
 const groupId=existingGroupId??randomUUID(),id=randomUUID()
 if(!existingGroupId)await pool.query("insert into teloa_groups(id,owner_id,request_id,request_spec,definition,version,pinned,archived,created_at,updated_at) values($1,$2,$3,'{}',$4,1,false,false,now(),now())",[groupId,source.owner,randomUUID(),JSON.stringify({name:'协作群',scope:'general',announcement:'',memberRoleIds:[]})])
 await pool.query("insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,text,reference_snapshot,task_id,run_id,created_at) values($1,$2,$3,$4,'{}',$5,$6,'真实运行结果','[]',$7,$8,now())",[id,source.owner,groupId,randomUUID(),rootId,source.roleId,source.taskId,source.id])
 return {id,groupId}
}

test('本人根任务同事务生成控制与预算身份，重放稳定且不覆盖来源',async()=>{
 const target=await task(),service=new WorkLineageService(pool,identity),lineages=await Promise.all(Array.from({length:6},()=>bind(service,target))),lineage=lineages[0]!
 assert.ok(lineages.every(value=>JSON.stringify(value)===JSON.stringify(lineage)))
 assert.equal(lineage.rootTaskId,target.id);assert.equal(lineage.ownerId,target.owner);assert.equal(lineage.controlGeneration,1);assert.equal(lineage.parentRunId,null);assert.equal(lineage.definition,null);assert.equal(lineage.definitionControlId,null)
 assert.match(lineage.roundControlId,/^[a-f0-9-]{36}$/);assert.match(lineage.budgetAccountId,/^[a-f0-9-]{36}$/)
 assert.deepEqual((await pool.query('select kind,state,generation,root_task_id,budget_account_id from teloa_work_controls where owner_id=$1 and id=$2',[target.owner,lineage.roundControlId])).rows[0],{kind:'round',state:'active',generation:1,root_task_id:target.id,budget_account_id:lineage.budgetAccountId})
 assert.deepEqual(await bind(service,target),lineage)
 assert.deepEqual(await new WorkLineageService(pool,identity).read(target.owner,{taskId:target.id}),lineage)
 await assert.rejects(bind(service,target,{kind:'team-child',parentRunId:randomUUID(),memberId:'call:missing'}),{code:'teloa/conflict'})
 assert.deepEqual(await service.descendants(target.owner,{controlId:lineage.roundControlId}),{taskIds:[target.id],runIds:[],teamMemberIds:[]})
})

test('不存在、跨本人和不匹配根 Task 都拒绝，历史 Task 空谱系不补猜',async()=>{
 const target=await task(),service=new WorkLineageService(pool,identity)
 assert.equal(await service.read(target.owner,{taskId:target.id}),null)
 await assert.rejects(bind(service,target,{kind:'owner-task',taskId:randomUUID()}),{code:'teloa/forbidden'})
 await assert.rejects(transaction(client=>service.bindTask(client,randomUUID(),{taskId:target.id,source:{kind:'owner-task',taskId:target.id}})),{code:'teloa/forbidden'})
 await assert.rejects(service.read(randomUUID(),{taskId:target.id}),{code:'teloa/forbidden'})
 await assert.rejects(bind(service,{...target,id:randomUUID()}),{code:'teloa/forbidden'})
})

test('群派生继承真实 Run 的根控制与预算，话题 root 不充当父工作',async()=>{
 const root=await task(),other=await task(root.owner),child=await task(root.owner),service=new WorkLineageService(pool,identity)
 const first=await bind(service,root),parent=await bind(service,other),topicRun=await run(root),parentRun=await run(other),topic=await message(topicRun),reply=await message(parentRun,topic.id,topic.groupId)
 const derived=await bind(service,child,{kind:'group-run-message',messageId:reply.id,runId:parentRun.id})
 assert.deepEqual(derived,{...parent,parentRunId:parentRun.id});assert.notEqual(derived.rootTaskId,first.rootTaskId)
 assert.deepEqual(await service.read(root.owner,{taskId:child.id}),derived)
 assert.deepEqual(await service.descendants(root.owner,{controlId:parent.roundControlId}),{taskIds:[other.id,child.id].sort(),runIds:[parentRun.id],teamMemberIds:[]})
 assert.deepEqual(await service.descendants(root.owner,{controlId:first.roundControlId}),{taskIds:[root.id],runIds:[topicRun.id],teamMemberIds:[]})
 for(const source of [{kind:'group-run-message' as const,messageId:reply.id,runId:topicRun.id},{kind:'group-run-message' as const,messageId:randomUUID(),runId:parentRun.id}])await assert.rejects(bind(service,await task(root.owner),source),{code:'teloa/forbidden'})
 await pool.query('update teloa_group_messages set author_id=$2 where id=$1',[reply.id,topicRun.roleId])
 await assert.rejects(service.read(root.owner,{taskId:child.id}),{code:'teloa/storage-corrupt'})
})

test('子预留沿父派生 Run 继承根，枚举包括所有真实 Run 和未收口预留',async()=>{
 const root=await task(),middle=await task(root.owner),child=await task(root.owner),foreign=await task(),service=new WorkLineageService(pool,identity),rootLineage=await bind(service,root),rootRun=await run(root),foreignRun=await run(foreign)
 const output=await message(rootRun)
 await bind(service,middle,{kind:'group-run-message',messageId:output.id,runId:rootRun.id})
 const middleRun=await run(middle),registry=new TaskRunSubagentService(pool,identity),memberId='call:'+randomUUID(),startedId='call:'+randomUUID(),endedId='call:'+randomUUID()
 await registry.reserve(root.owner,{runId:middleRun.id,reservationId:memberId,limit:8})
 for(const reservationId of [startedId,endedId]){await registry.reserve(root.owner,{runId:rootRun.id,reservationId,limit:8});await registry.bind(root.owner,{reservationId,childSessionId:'child_'+randomUUID().replaceAll('-',''),depth:1})}
 const ended=(await registry.list(root.owner,rootRun.id)).find(value=>value.reservationId===endedId)!
 await registry.settle(root.owner,{childSessionId:ended.childSessionId,stopReason:'completed'})
 const derived=await bind(service,child,{kind:'team-child',parentRunId:middleRun.id,memberId})
 assert.deepEqual(derived,{...rootLineage,parentRunId:middleRun.id})
 const childRun=await run(child)
 assert.deepEqual(await service.descendants(root.owner,{controlId:rootLineage.roundControlId}),{taskIds:[root.id,middle.id,child.id].sort(),runIds:[rootRun.id,middleRun.id,childRun.id].sort(),teamMemberIds:[memberId,startedId].sort()})
 await pool.query("update teloa_task_runs set state='withdrawn' where id=$1",[rootRun.id])
 assert.deepEqual(await service.descendants(root.owner,{controlId:rootLineage.roundControlId}),{taskIds:[root.id,middle.id,child.id].sort(),runIds:[rootRun.id,middleRun.id,childRun.id].sort(),teamMemberIds:[memberId,startedId].sort()})
 await assert.rejects(bind(service,await task(root.owner),{kind:'team-child',parentRunId:rootRun.id,memberId}),{code:'teloa/forbidden'})
 await assert.rejects(bind(service,await task(root.owner),{kind:'team-child',parentRunId:foreignRun.id,memberId}),{code:'teloa/forbidden'})
 await assert.rejects(service.descendants(foreign.owner,{controlId:rootLineage.roundControlId}),{code:'teloa/forbidden'})
})

test('计划相同配置多轮复用定义控制与预算，各轮有独立根与控制且定义枚举全轮',async()=>{
 const owner=randomUUID(),roleId=await role(owner),plans=new PlanService(pool,identity),created=await plans.create(owner,{requestId:randomUUID(),fields:{title:'每日核对',goal:'核对资料',scope:'general',dataScope:'本人资料',delivery:'核对结果',roleId,expectedRoleVersion:1,notificationPolicy:'attention',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}},source:{kind:'manual'}}),plan=await plans.change(owner,{planId:created.id,requestId:randomUUID(),expectedVersion:1,action:'enable'}),occurrences=new PlanOccurrenceService(pool,identity),service=new WorkLineageService(pool,identity)
 const one=(await occurrences.trigger(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,now:'2026-10-09T01:00:00.000Z'})).occurrence!,first=await task(owner,one.taskRequestId),firstLineage=await bind(service,first,{kind:'plan-occurrence',claimId:one.id})
 await pool.query("update teloa_tasks set state='completed' where id=$1",[first.id])
 const two=(await occurrences.trigger(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,now:'2026-10-09T01:01:00.000Z'})).occurrence!,second=await task(owner,two.taskRequestId),secondLineage=await bind(service,second,{kind:'plan-occurrence',claimId:two.id})
 assert.equal(firstLineage.definition?.occurrenceId,one.occurrenceId);assert.equal(secondLineage.definition?.occurrenceId,two.occurrenceId)
 assert.equal(firstLineage.definition?.definitionVersion,plan.configVersion);assert.equal(firstLineage.definitionControlId,secondLineage.definitionControlId);assert.equal(firstLineage.budgetAccountId,secondLineage.budgetAccountId);assert.notEqual(firstLineage.roundControlId,secondLineage.roundControlId)
 const firstRun=await run(first),secondRun=await run(second)
 assert.deepEqual(await service.descendants(owner,{controlId:firstLineage.definitionControlId!}),{taskIds:[first.id,second.id].sort(),runIds:[firstRun.id,secondRun.id].sort(),teamMemberIds:[]})
 assert.deepEqual(await service.descendants(owner,{controlId:firstLineage.roundControlId}),{taskIds:[first.id],runIds:[firstRun.id],teamMemberIds:[]})
 await assert.rejects(bind(service,await task(owner),{kind:'plan-occurrence',claimId:one.id}),{code:'teloa/forbidden'})
 await assert.rejects(bind(service,await task(),{kind:'plan-occurrence',claimId:one.id}),{code:'teloa/forbidden'})
 assert.deepEqual(await new WorkLineageService(pool,identity).read(owner,{taskId:second.id}),secondLineage)
})

test('绑定与外层事务一同回滚；未知字段、缺父谱系和改写的持久快照都拒绝',async()=>{
 const target=await task(),service=new WorkLineageService(pool,identity)
 await assert.rejects(transaction(async client=>{const lineage=await service.bindTask(client,target.owner,{taskId:target.id,source:{kind:'owner-task',taskId:target.id}});assert.deepEqual(await service.readInTransaction(client,target.owner,{taskId:target.id}),lineage);assert.equal(await service.read(target.owner,{taskId:target.id}),null);throw Error('回滚本轮')}),/回滚本轮/)
 assert.equal(await service.read(target.owner,{taskId:target.id}),null)
 assert.equal(Number((await pool.query('select count(*) from teloa_work_controls where owner_id=$1',[target.owner])).rows[0].count),0)
 await assert.rejects(bind(service,target,{kind:'owner-task',taskId:target.id,rootTaskId:randomUUID()} as WorkSource),{code:'teloa/invalid-input'})
 const parentRun=await run(target),output=await message(parentRun)
 await assert.rejects(bind(service,await task(target.owner),{kind:'group-run-message',messageId:output.id,runId:parentRun.id}),{code:'teloa/conflict'})
 await bind(service,target)
 await assert.rejects(pool.query("update teloa_task_work_lineage set lineage_hash=$2 where task_id=$1",[target.id,'0'.repeat(64)]),/immutable/)
 await pool.query('alter table teloa_task_work_lineage disable trigger teloa_task_work_lineage_immutable')
 await pool.query("update teloa_task_work_lineage set lineage=jsonb_set(lineage,'{ownerId}',to_jsonb('forged-owner'::text)) where task_id=$1",[target.id])
 await pool.query('alter table teloa_task_work_lineage enable trigger teloa_task_work_lineage_immutable')
 await assert.rejects(service.read(target.owner,{taskId:target.id}),{code:'teloa/storage-corrupt'})
})

test('历史缺谱系和执行子表返回空范围，初始化不依赖 Run 或计划建表',async()=>{
 const schema='lineage_legacy_'+randomUUID().replaceAll('-',''),owner=randomUUID(),taskId=randomUUID()
 await pool.query(`create schema "${schema}"`)
 const legacy=new Pool({connectionString:container.getConnectionUri(),options:'-c search_path='+schema})
 try{
  await legacy.query('create table teloa_tasks (like public.teloa_tasks including defaults including constraints)')
  await legacy.query("insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,state,created_at,updated_at) values($1,$2,$3,'{}',$4,1,'ready',now(),now())",[taskId,owner,randomUUID(),JSON.stringify({title:'历史任务',goal:'核对资料',scope:'general'})])
  const service=new WorkLineageService(legacy,identity)
  assert.equal(await service.read(owner,{taskId}),null)
  assert.deepEqual(await service.descendants(owner,{controlId:randomUUID()}),{taskIds:[],runIds:[],teamMemberIds:[]})
  await initializeWorkLineage(legacy)
  const client=await legacy.connect()
  try{await client.query('begin');const lineage=await service.bindTask(client,owner,{taskId,source:{kind:'owner-task',taskId}});await client.query('commit');assert.deepEqual(await service.descendants(owner,{controlId:lineage.roundControlId}),{taskIds:[taskId],runIds:[],teamMemberIds:[]})}finally{client.release()}
 }finally{await legacy.end();await pool.query(`drop schema "${schema}" cascade`)}
})
})
