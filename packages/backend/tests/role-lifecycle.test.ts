import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {RoleLifecycleService,initializeRoleLifecycle} from '../src/work/role-lifecycle.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
// 改岗位定义与恢复在岗都会在同一笔事务里按新岗位版本续签群授权（`collaboration.ts` 的 `renewRoleGrants`），
// 所以这套用例也要把群协作与群授权两张表建起来——否则岗位写口会因为表不存在整笔回滚。
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeTasks(pool);await initializeRoleLifecycle(pool)})
after(async()=>{await pool?.end();await container?.stop()})
const fixture=async()=>{const owner=randomUUID(),roles=new RoleService(pool,identity),role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['SOC'],duty:'调查',dataScope:'资料',executionScope:'仅声明',skills:[],knowledge:[],responsibility:testRoleResponsibility}});return {owner,role,roles,service:new RoleLifecycleService(pool,identity),tasks:new TaskService(pool,identity)}}
const command=(roleId:string,expectedVersion:number,action:string)=>({roleId,expectedVersion,action,reason:'本人调整职责安排'})
test('在岗与暂停转换有版本回执，旧重试不恢复已退役岗位',async()=>{
 const {owner,role,service}=await fixture()
 // 创建后直接在岗，先暂停一次才能核对恢复的并发去重与版本回执
 await service.change(owner,command(role.id,1,'pause'));const resume=command(role.id,2,'resume')
 const [a,b]=await Promise.all([service.change(owner,resume),service.change(owner,resume)]);assert.deepEqual(a,b);assert.equal(a.role.state,'active');assert.equal(a.appliedVersion,3)
 const paused=await service.change(owner,command(role.id,3,'pause'));assert.equal(paused.role.version,4)
 const retired=await service.change(owner,command(role.id,4,'retire'));assert.equal(retired.role.state,'retired')
 const retry=await service.change(owner,resume);assert.equal(retry.role.state,'retired');assert.equal(retry.appliedVersion,3)
 await assert.rejects(service.change(owner,command(role.id,5,'resume')),{code:'teloa/conflict'})
 await assert.rejects(service.change('other',resume),{code:'teloa/forbidden'})
 await assert.rejects(service.change(owner,{...resume,reason:'另一意图'}),{code:'teloa/version-conflict'})
})
test('个人分身是默认代拟身份，不能暂停或退役',async()=>{
 const owner=randomUUID(),roles=new RoleService(pool,identity),service=new RoleLifecycleService(pool,identity)
 const twin=await roles.create(owner,{requestId:randomUUID(),fields:{name:'我的分身',kind:'twin',scopes:['general'],duty:'代拟',dataScope:'个人工作资料',executionScope:'仅代拟，不执行',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 for(const action of ['pause','retire'])await assert.rejects(service.change(owner,command(twin.id,1,action)),{code:'teloa/conflict'})
 const stored=(await roles.list(owner,{})).find(role=>role.id===twin.id)
 assert.equal(stored?.state,'active');assert.equal(stored?.version,1)
})
test('退役只为未完成工作登记独立交接，原任务状态和引用保留',async()=>{
 const {owner,role,service,tasks}=await fixture()
 const create=()=>tasks.create(owner,{requestId:randomUUID(),fields:{title:'调查',goal:'核对来源',scope:'SOC'},assignee:{roleId:role.id,expectedVersion:1}})
 const active=await create(),closed=await create();await pool.query("update teloa_tasks set state='completed' where id=$1",[closed.id])
 const result=await service.change(owner,command(role.id,1,'retire'));assert.deepEqual(result.handoffTaskIds,[active.id])
 assert.deepEqual(await service.change(owner,command(role.id,1,'retire')),result)
 const stored=await tasks.list(owner,{});assert.equal(stored.find(row=>row.id===active.id)?.state,'ready');assert.equal(stored.find(row=>row.id===active.id)?.assigneeRoleId,role.id)
 const handoffs=await pool.query('select * from teloa_task_handoffs where from_role_id=$1',[role.id]);assert.equal(handoffs.rowCount,1);assert.equal(handoffs.rows[0].task_id,active.id)
 await assert.rejects(create(),{code:'teloa/version-conflict'})
})
test('交接写入失败回滚退役，不能留下已退役但没有交接的状态',async()=>{
 const {owner,role,roles,service,tasks}=await fixture()
 await tasks.create(owner,{requestId:randomUUID(),fields:{title:'调查',goal:'证据',scope:'SOC'},assignee:{roleId:role.id,expectedVersion:1}})
 await pool.query(`create function reject_test_handoff() returns trigger language plpgsql as $$ begin if new.from_role_id='${role.id}'::uuid then raise exception 'handoff unavailable'; end if; return new; end $$;create trigger reject_test_handoff before insert on teloa_task_handoffs for each row execute function reject_test_handoff()`)
 try{await assert.rejects(service.change(owner,command(role.id,1,'retire')),/handoff unavailable/);assert.equal((await roles.list(owner,{}))[0]?.state,'active')}finally{await pool.query('drop trigger reject_test_handoff on teloa_task_handoffs;drop function reject_test_handoff()')}
 assert.equal((await service.change(owner,command(role.id,1,'retire'))).handoffTaskIds.length,1)
})
test('未知字段、数组动作与无效原因不能改变岗位',async()=>{
 const {owner,role,roles,service}=await fixture()
 for(const change of [{...command(role.id,1,'resume'),action:['resume']},{...command(role.id,1,'resume'),ownerId:'forged'},{...command(role.id,1,'resume'),reason:''}])await assert.rejects(service.change(owner,change),{code:'teloa/invalid-input'})
 assert.equal((await roles.list(owner,{}))[0]?.version,1)
})
test('退役与新交办竞争，不产生没有交接的在途任务',async()=>{
 const {owner,role,service,tasks}=await fixture()
 const [assigned,retired]=await Promise.allSettled([tasks.create(owner,{requestId:randomUUID(),fields:{title:'竞争交办',goal:'核对',scope:'SOC'},assignee:{roleId:role.id,expectedVersion:1}}),service.change(owner,command(role.id,1,'retire'))])
 assert.equal(retired.status,'fulfilled');if(retired.status!=='fulfilled')throw Error('退役失败')
 if(assigned.status==='fulfilled')assert.ok(retired.value.handoffTaskIds.includes(assigned.value.id))
 else{assert.equal(assigned.reason.code,'teloa/version-conflict');assert.deepEqual(await tasks.list(owner,{}),[])}
})
test('生命周期回执失败时岗位更新和交接同时回滚',async()=>{
 const {owner,role,roles,service,tasks}=await fixture();await tasks.create(owner,{requestId:randomUUID(),fields:{title:'回滚',goal:'核对',scope:'SOC'},assignee:{roleId:role.id,expectedVersion:1}})
 await pool.query(`create function reject_test_transition() returns trigger language plpgsql as $$ begin if new.role_id='${role.id}'::uuid then raise exception 'transition unavailable'; end if; return new; end $$;create trigger reject_test_transition before insert on teloa_role_transitions for each row execute function reject_test_transition()`)
 try{await assert.rejects(service.change(owner,command(role.id,1,'retire')),/transition unavailable/);assert.equal((await roles.list(owner,{}))[0]?.version,1);assert.equal((await pool.query('select * from teloa_task_handoffs where from_role_id=$1',[role.id])).rowCount,0)}finally{await pool.query('drop trigger reject_test_transition on teloa_role_transitions;drop function reject_test_transition()')}
})
