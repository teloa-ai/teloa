import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError} from '@teloa/contract'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {PlanDispatcher,type PlanDispatchPorts,type PlanTaskAssociation} from '../src/work/plan-dispatch.ts'
import {PlanOccurrenceService,initializePlanOccurrences,type PlanOccurrence} from '../src/work/plan-occurrences.ts'
import {PlanService} from '../src/work/plans.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const now='2026-09-11T01:00:00.000Z',identity={id:randomUUID,now:()=>now}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializePlanOccurrences(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(){
 const owner=randomUUID(),tasks=new TaskService(pool,identity)
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'资料整理岗',kind:'employee',scopes:['general'],duty:'整理',dataScope:'本人授权资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const requestId=randomUUID(),fields={title:'每日资料整理',goal:'核对新增资料',scope:'general'}
 const occurrence:PlanOccurrence={id:randomUUID(),ownerId:owner,planId:randomUUID(),planVersion:2,configVersion:1,occurrenceId:'2026-09-11T09:00[Asia/Singapore]',scheduledAt:now,claimedAt:now,taskRequestId:requestId,fields:{...fields,dataScope:'固定已授权资料范围',delivery:'列出变化与缺口',roleId:role.id,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}},source:{kind:'manual'},roleVersion:1,taskRequest:{requestId,fields,assignee:{roleId:role.id,expectedVersion:1}}}
 const links:PlanTaskAssociation[]=[],calls:string[]=[]
 const ports:PlanDispatchPorts={
  tasks,
  revalidate:async(actualOwner,key)=>{assert.equal(actualOwner,owner);assert.deepEqual(key,{claimId:occurrence.id,taskRequestId:requestId});calls.push('revalidate');return structuredClone(occurrence)},
  linkTask:async(actualOwner,association)=>{assert.equal(actualOwner,owner);calls.push('link');links.push(association);return {...association}},
 }
 return {owner,role,occurrence,tasks,ports,links,calls}
}

test('领取按固定请求创建普通任务，回填同一身份并保留来源与交付快照',async()=>{
 const {owner,occurrence,ports,tasks,links,calls}=await fixture()
 const result=await new PlanDispatcher(ports).dispatch(owner,occurrence)
 const stored=(await tasks.list(owner,{}))[0]!
 assert.equal(stored.id,result.task.id);assert.equal(stored.title,'每日资料整理');assert.equal(stored.goal,'核对新增资料');assert.equal(stored.assigneeRoleId,occurrence.fields.roleId)
 assert.deepEqual(result.occurrence.fields,occurrence.fields);assert.deepEqual(result.occurrence.source,{kind:'manual'})
 assert.deepEqual(links,[{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,taskId:stored.id}]);assert.deepEqual(calls,['revalidate','link'])
 const row=(await pool.query('select request_id,request_spec from teloa_tasks where id=$1',[stored.id])).rows[0]
 assert.equal(row.request_id,occurrence.taskRequestId);assert.deepEqual(row.request_spec,{fields:occurrence.taskRequest.fields,assignee:occurrence.taskRequest.assignee})
})

test('计划复验拒绝后不创建任务、不回填成功',async()=>{
 const {owner,occurrence,ports,tasks,links}=await fixture()
 ports.revalidate=async()=>{throw new WorkError('teloa/conflict','计划已暂停')}
 await assert.rejects(new PlanDispatcher(ports).dispatch(owner,occurrence),{code:'teloa/conflict'})
 assert.deepEqual(await tasks.list(owner,{}),[]);assert.equal(links.length,0)
})

test('任务已落库但回包丢失，重建适配器后按原请求找回一项任务',async()=>{
 const {owner,occurrence,ports,tasks,links}=await fixture()
 ports.tasks={create:async(actualOwner,input)=>{await tasks.create(actualOwner,input);throw Error('任务回包丢失')}}
 await assert.rejects(new PlanDispatcher(ports).dispatch(owner,occurrence),/任务回包丢失/)
 const first=(await tasks.list(owner,{}))[0]!
 assert.ok(first);assert.equal(links.length,0)
 const recovered=await new PlanDispatcher({...ports,tasks:new TaskService(pool,identity)}).dispatch(owner,structuredClone(occurrence))
 assert.equal(recovered.task.id,first.id);assert.equal((await tasks.list(owner,{})).length,1)
 assert.equal(links[0]!.taskRequestId,occurrence.taskRequestId)
})

test('任务关联失败不撤销已创建任务，重试使用相同任务和请求身份',async()=>{
 const {owner,occurrence,ports,tasks}=await fixture(),link=ports.linkTask
 ports.linkTask=async()=>{throw Error('关联写入失败')}
 await assert.rejects(new PlanDispatcher(ports).dispatch(owner,occurrence),/关联写入失败/)
 const first=(await tasks.list(owner,{}))[0]!
 ports.linkTask=link
 const result=await new PlanDispatcher(ports).dispatch(owner,occurrence)
 assert.equal(result.task.id,first.id);assert.equal(result.association.taskRequestId,occurrence.taskRequestId);assert.equal((await tasks.list(owner,{})).length,1)
})

test('并发派发固定领取仍只创建一项普通任务',async()=>{
 const {owner,occurrence,ports,tasks}=await fixture()
 const results=await Promise.all(Array.from({length:4},()=>new PlanDispatcher(ports).dispatch(owner,occurrence)))
 assert.equal(new Set(results.map(result=>result.task.id)).size,1);assert.equal((await tasks.list(owner,{})).length,1)
})

test('本人、领取和任务请求身份错配均不能派发',async()=>{
 const {owner,occurrence,ports,tasks,links}=await fixture()
 await assert.rejects(new PlanDispatcher(ports).dispatch('other',occurrence),{code:'teloa/forbidden'})
 await assert.rejects(new PlanDispatcher(ports).dispatch(owner,{...occurrence,taskRequestId:randomUUID()}),{code:'teloa/storage-corrupt'})
 ports.revalidate=async()=>({...occurrence,id:randomUUID()})
 await assert.rejects(new PlanDispatcher(ports).dispatch(owner,occurrence),{code:'teloa/storage-corrupt'})
 ports.revalidate=async()=>({...occurrence,taskRequest:{...occurrence.taskRequest,fields:{...occurrence.taskRequest.fields,goal:'被替换的目标'}}})
 await assert.rejects(new PlanDispatcher(ports).dispatch(owner,occurrence),{code:'teloa/storage-corrupt'})
 assert.deepEqual(await tasks.list(owner,{}),[]);assert.equal(links.length,0)
})

test('任务与关联回执错配不会被当作派发成功',async()=>{
 const {owner,occurrence,ports,tasks,links}=await fixture()
 ports.tasks={create:async(actualOwner,input)=>({...await tasks.create(actualOwner,input),ownerId:'other'})}
 await assert.rejects(new PlanDispatcher(ports).dispatch(owner,occurrence),{code:'teloa/storage-corrupt'});assert.equal(links.length,0)
 ports.tasks=tasks;ports.linkTask=async(_owner,association)=>({...association,taskId:randomUUID()})
 await assert.rejects(new PlanDispatcher(ports).dispatch(owner,occurrence),{code:'teloa/storage-corrupt'})
 assert.equal((await tasks.list(owner,{})).length,1)
})

test('创建前岗位变更由真实TaskService拒绝，适配器不绕过岗位校验',async()=>{
 const {owner,occurrence,ports,tasks,role,links}=await fixture(),revalidate=ports.revalidate
 ports.revalidate=async(actualOwner,key)=>{const row=await revalidate(actualOwner,key);await pool.query("update teloa_roles set state='paused' where id=$1",[role.id]);return row}
 await assert.rejects(new PlanDispatcher(ports).dispatch(owner,occurrence),{code:'teloa/conflict'})
 assert.deepEqual(await tasks.list(owner,{}),[]);assert.equal(links.length,0)
})

test('真实领取服务在任务丢回包后保留pending，恢复关联后只有一项任务且退出pending',async()=>{
 const {owner,role,tasks,occurrence:sample}=await fixture()
 const plans=new PlanService(pool,{id:randomUUID,now:()=>'2026-09-11T00:00:00.000Z'})
 const plan=await plans.create(owner,{requestId:randomUUID(),fields:{...sample.fields,roleId:role.id,expectedRoleVersion:1,notificationPolicy:'attention'},source:{kind:'manual'}})
 await plans.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:1,action:'enable'})
 const occurrences=new PlanOccurrenceService(pool,{id:randomUUID})
 const occurrence=(await occurrences.claim(owner,{planId:plan.id,now})).occurrence!
 assert.ok(occurrence)
 const ports:PlanDispatchPorts={tasks:{create:async(actualOwner,input)=>{await tasks.create(actualOwner,input);throw Error('任务回执不可达')}},revalidate:occurrences.revalidate.bind(occurrences),linkTask:occurrences.linkTask.bind(occurrences)}
 await assert.rejects(new PlanDispatcher(ports).dispatch(owner,occurrence),/任务回执不可达/)
 const pending=await new PlanOccurrenceService(pool,{id:randomUUID}).pending(owner)
 assert.equal(pending.length,1);assert.equal(pending[0]!.taskRequestId,occurrence.taskRequestId)
 const first=(await tasks.list(owner,{}))[0]!
 const result=await new PlanDispatcher({...ports,tasks:new TaskService(pool,identity)}).dispatch(owner,pending[0]!)
 assert.equal(result.task.id,first.id);assert.deepEqual(await occurrences.pending(owner),[])
 const rows=await pool.query('select task_request_id,task_id from teloa_plan_task_links where claim_id=$1',[occurrence.id])
 assert.deepEqual(rows.rows,[{task_request_id:occurrence.taskRequestId,task_id:first.id}]);assert.equal((await tasks.list(owner,{})).length,1)
})
