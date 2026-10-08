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
import {HandoffService,initializeHandoffs} from '../src/work/handoffs.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {ObjectConversationService,initializeObjectConversations} from '../src/work/object-conversations.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeRoleDelegations} from '../src/work/role-delegations.ts'
let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeTasks(pool);await initializeRoleLifecycle(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeHandoffs(pool);await initializeRoleDelegations(pool)})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(){const owner=randomUUID(),roles=new RoleService(pool,identity),tasks=new TaskService(pool,identity),lifecycle=new RoleLifecycleService(pool,identity),service=new HandoffService(pool,identity);const make=async()=>roles.create(owner,{requestId:randomUUID(),fields:{name:'调查',kind:'employee',scopes:['SOC'],duty:'调查',dataScope:'资料',executionScope:'声明',skills:[],knowledge:[],responsibility:testRoleResponsibility}});const from=await make(),to=await make(),task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'待交接',goal:'核对',scope:'SOC'},assignee:{roleId:from.id,expectedVersion:1}});await lifecycle.change(owner,{roleId:from.id,expectedVersion:1,action:'retire',reason:'职责交接'});const handoff=(await service.list(owner,{}))[0]!;const input={handoffId:handoff.id,expectedTaskVersion:1,toRoleId:to.id,expectedRoleVersion:1,note:'接续原目标'};return {owner,from,to,task,handoff,input,service,tasks,lifecycle}}
async function activeFixture(assignee:'role'|'self'='role'){
 const owner=randomUUID(),roles=new RoleService(pool,identity),tasks=new TaskService(pool,identity),lifecycle=new RoleLifecycleService(pool,identity),service=new HandoffService(pool,identity)
 const make=async(name:string,options:{owner?:string;kind?:'employee'|'twin';scopes?:string[];active?:boolean}={})=>{const roleOwner=options.owner??owner,role=await roles.create(roleOwner,{requestId:randomUUID(),fields:{name,kind:options.kind??'employee',scopes:options.scopes??['SOC'],duty:'调查',dataScope:'资料',executionScope:'声明',skills:[],knowledge:[],responsibility:testRoleResponsibility}});if(options.active===false)await lifecycle.change(roleOwner,{roleId:role.id,expectedVersion:1,action:'pause',reason:'先歇一会'});return {...role,version:options.active===false?2:1,state:options.active===false?'paused' as const:'active' as const}}
 const from=await make('原负责人'),to=await make('新负责人'),task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'主动改派',goal:'保持目标',scope:'SOC'},...(assignee==='role'?{assignee:{roleId:from.id,expectedVersion:1}}:{})})
 return {owner,roles,tasks,lifecycle,service,make,from,to,task}
}

test('主动改派岗位到岗位写入固定审计回执，重试返回当前任务且不改写任务定义与状态',async()=>{
 const f=await activeFixture(),requestId=randomUUID(),input={requestId,taskId:f.task.id,expectedTaskVersion:1,target:{kind:'role' as const,roleId:f.to.id,expectedRoleVersion:1},note:'  转交后续核对  '}
 const before=(await pool.query('select * from teloa_tasks where id=$1',[f.task.id])).rows[0],first=await f.service.change(f.owner,input)
 assert.equal(first.task.assigneeRoleId,f.to.id);assert.equal(first.task.assigneeRoleVersion,1);assert.equal(first.task.version,2);assert.equal(first.task.state,'ready')
 assert.deepEqual(first.change,{requestId,taskId:f.task.id,baseVersion:1,appliedVersion:2,from:{kind:'role',roleId:f.from.id,roleVersion:1},to:{kind:'role',roleId:f.to.id,roleVersion:1},note:'转交后续核对',createdAt:first.change.createdAt})
 const after=(await pool.query('select * from teloa_tasks where id=$1',[f.task.id])).rows[0]
 assert.deepEqual(after.definition,before.definition);assert.deepEqual(after.request_spec,before.request_spec);assert.equal(after.state,before.state)
 await f.tasks.edit(f.owner,{taskId:f.task.id,expectedVersion:2,fields:{title:'主动改派后更新',goal:'保持目标'}})
 const retry=await new HandoffService(pool,identity).change(f.owner,input);assert.equal(retry.task.version,3);assert.deepEqual(retry.change,first.change)
 const receipts=await pool.query('select * from teloa_task_handoff_changes where owner_id=$1 and request_id=$2',[f.owner,requestId]);assert.equal(receipts.rowCount,1)
 assert.deepEqual(receipts.rows[0].request_spec,{...input,note:'转交后续核对'});assert.deepEqual(receipts.rows[0].from_party,first.change.from);assert.deepEqual(receipts.rows[0].to_party,first.change.to);assert.equal(receipts.rows[0].base_version,1);assert.equal(receipts.rows[0].applied_version,2);assert.equal(receipts.rows[0].note,'转交后续核对')
 await assert.rejects(f.service.change(f.owner,{...input,note:'参数漂移'}),{code:'teloa/conflict'})
})

test('主动改派支持岗位到本人和本人到岗位',async()=>{
 const roleTask=await activeFixture(),toSelf=await roleTask.service.change(roleTask.owner,{requestId:randomUUID(),taskId:roleTask.task.id,expectedTaskVersion:1,target:{kind:'self'},note:'本人接管'})
 assert.equal(toSelf.task.assigneeRoleId,null);assert.deepEqual(toSelf.change.to,{kind:'self'})
 const selfTask=await activeFixture('self'),toRole=await selfTask.service.change(selfTask.owner,{requestId:randomUUID(),taskId:selfTask.task.id,expectedTaskVersion:1,target:{kind:'role',roleId:selfTask.to.id,expectedRoleVersion:1},note:'交给岗位'})
 assert.equal(toRole.task.assigneeRoleId,selfTask.to.id);assert.deepEqual(toRole.change.from,{kind:'self'})
})

test('主动改派拒绝不合格目标、相同目标、旧版本和被动待交接',async()=>{
 const f=await activeFixture(),base={requestId:randomUUID(),taskId:f.task.id,expectedTaskVersion:1,note:'调整负责人'}
 await assert.rejects(f.service.change(randomUUID(),{...base,target:{kind:'self'}}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.change(f.owner,{...base,target:{kind:'role',roleId:f.from.id,expectedRoleVersion:1}}),{code:'teloa/conflict'})
 await assert.rejects(f.service.change(f.owner,{...base,requestId:randomUUID(),expectedTaskVersion:9,target:{kind:'self'}}),{code:'teloa/version-conflict'})
 const paused=await f.make('暂停负责人',{active:false});await assert.rejects(f.service.change(f.owner,{...base,requestId:randomUUID(),target:{kind:'role',roleId:paused.id,expectedRoleVersion:paused.version}}),{code:'teloa/conflict'})
 const agent=await f.make('数字分身',{kind:'twin'});await assert.rejects(f.service.change(f.owner,{...base,requestId:randomUUID(),target:{kind:'role',roleId:agent.id,expectedRoleVersion:1}}),{code:'teloa/forbidden'})
 const otherScope=await f.make('其他业务',{scopes:['AppSec']});await assert.rejects(f.service.change(f.owner,{...base,requestId:randomUUID(),target:{kind:'role',roleId:otherScope.id,expectedRoleVersion:1}}),{code:'teloa/conflict'})
 const otherOwner=randomUUID(),foreign=await f.make('其他本人',{owner:otherOwner});await assert.rejects(f.service.change(f.owner,{...base,requestId:randomUUID(),target:{kind:'role',roleId:foreign.id,expectedRoleVersion:1}}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.change(f.owner,{...base,requestId:randomUUID(),target:{kind:'role',roleId:f.to.id,expectedRoleVersion:9}}),{code:'teloa/version-conflict'})
 const pending=await fixture();await assert.rejects(pending.service.change(pending.owner,{requestId:randomUUID(),taskId:pending.task.id,expectedTaskVersion:1,target:{kind:'self'},note:'绕过待交接'}),{code:'teloa/conflict'})
})

test('同任务版本并发改派只成功一次，终态和在途执行均阻止主动与被动交接',async()=>{
 const f=await activeFixture(),inputs=[f.to,await f.make('另一负责人')].map(role=>({requestId:randomUUID(),taskId:f.task.id,expectedTaskVersion:1,target:{kind:'role' as const,roleId:role.id,expectedRoleVersion:1},note:'并发改派'})),results=await Promise.allSettled(inputs.map(input=>f.service.change(f.owner,input)))
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.filter(result=>result.status==='rejected'&&(result.reason as {code?:string}).code==='teloa/version-conflict').length,1)
 for(const state of ['running','completed','cancelled'] as const){const next=await activeFixture();await pool.query('update teloa_tasks set state=$2 where id=$1',[next.task.id,state]);await assert.rejects(next.service.change(next.owner,{requestId:randomUUID(),taskId:next.task.id,expectedTaskVersion:1,target:{kind:'self'},note:'终态改派'}),{code:'teloa/conflict'})}
 for(const state of ['prepared','submitting','accepted','active']){const running=await activeFixture();await pool.query("insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at) values($1,$2,$3,'{}',$4,$5,1,1,1,$6,$7,$8,'{}',now())",[randomUUID(),running.owner,randomUUID(),running.task.id,running.from.id,randomUUID(),randomUUID(),state]);await assert.rejects(running.service.change(running.owner,{requestId:randomUUID(),taskId:running.task.id,expectedTaskVersion:1,target:{kind:'self'},note:'执行中改派'}),{code:'teloa/conflict'})}
 const passive=await fixture();await pool.query("insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at) values($1,$2,$3,'{}',$4,$5,1,2,1,$6,$7,'prepared','{}',now())",[randomUUID(),passive.owner,randomUUID(),passive.task.id,passive.from.id,randomUUID(),randomUUID()]);await assert.rejects(passive.service.resolve(passive.owner,passive.input),{code:'teloa/conflict'});assert.equal((await passive.service.list(passive.owner,{}))[0]?.status,'pending')
})

test('暂停、阻塞和等待状态只更换负责人并保留原状态',async()=>{
 for(const state of ['paused','blocked','waiting'] as const){const f=await activeFixture();await pool.query('update teloa_tasks set state=$2 where id=$1',[f.task.id,state]);const result=await f.service.change(f.owner,{requestId:randomUUID(),taskId:f.task.id,expectedTaskVersion:1,target:{kind:'self'},note:'调整后续负责人'});assert.equal(result.task.state,state);assert.equal(result.task.assigneeRoleId,null)}
})

test('运行配置失败是终态，不阻止主动改派',async()=>{
 const f=await activeFixture()
 await pool.query("insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,agent_preset_id,configuration_error) values($1,$2,$3,'{}',$4,$5,1,1,0,$6,$7,'configuration_failed','{}',now(),'missing-preset',$8)",[randomUUID(),f.owner,randomUUID(),f.task.id,f.from.id,randomUUID(),randomUUID(),JSON.stringify({code:'teloa/preset-unavailable',stage:'preset-resolve',message:'运行配置不可用'})])
 const result=await f.service.change(f.owner,{requestId:randomUUID(),taskId:f.task.id,expectedTaskVersion:1,target:{kind:'self'},note:'核对配置后改由本人负责'})
 assert.equal(result.task.assigneeRoleId,null)
})

test('主动改派与岗位暂停或退役并发时遵循岗位到任务锁序且只保留合法结果',async()=>{
 const pausing=await activeFixture(),[pause,change]=await Promise.allSettled([
  pausing.lifecycle.change(pausing.owner,{roleId:pausing.to.id,expectedVersion:1,action:'pause',reason:'并发暂停'}),
  pausing.service.change(pausing.owner,{requestId:randomUUID(),taskId:pausing.task.id,expectedTaskVersion:1,target:{kind:'role',roleId:pausing.to.id,expectedRoleVersion:1},note:'并发改派'}),
 ])
 assert.equal(pause.status,'fulfilled');if(change.status==='rejected')assert.ok(['teloa/conflict','teloa/version-conflict'].includes(change.reason.code))
 const current=(await pausing.tasks.list(pausing.owner,{}))[0]!;assert.equal(current.assigneeRoleId,change.status==='fulfilled'?pausing.to.id:pausing.from.id)
 const retiring=await activeFixture(),[retire,moved]=await Promise.allSettled([
  retiring.lifecycle.change(retiring.owner,{roleId:retiring.from.id,expectedVersion:1,action:'retire',reason:'并发退役'}),
  retiring.service.change(retiring.owner,{requestId:randomUUID(),taskId:retiring.task.id,expectedTaskVersion:1,target:{kind:'role',roleId:retiring.to.id,expectedRoleVersion:1},note:'并发改派'}),
 ])
 assert.equal(retire.status,'fulfilled');if(moved.status==='rejected')assert.ok(['teloa/conflict','teloa/version-conflict'].includes(moved.reason.code))
 const saved=(await retiring.tasks.list(retiring.owner,{}))[0]!,pending=(await retiring.service.list(retiring.owner,{})).filter(row=>row.status==='pending')
 assert.equal(saved.assigneeRoleId,moved.status==='fulfilled'?retiring.to.id:retiring.from.id);assert.equal(pending.length,moved.status==='fulfilled'?0:1)
})

test('主动改派与真实执行准备并发时不死锁且只有一条路径生效',async()=>{
 const f=await activeFixture(),sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:f.owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:f.task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const [prepared,changed]=await Promise.allSettled([
  new TaskRunService(pool,identity,inspect).prepare(f.owner,{requestId:randomUUID(),taskId:f.task.id,expectedTaskVersion:1,roleId:f.from.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:1}),
  f.service.change(f.owner,{requestId:randomUUID(),taskId:f.task.id,expectedTaskVersion:1,target:{kind:'self'},note:'改由本人负责'}),
 ])
 assert.equal([prepared,changed].filter(result=>result.status==='fulfilled').length,1)
 const task=(await f.tasks.list(f.owner,{}))[0]!,runs=(await pool.query('select state from teloa_task_runs where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows
 if(prepared.status==='fulfilled'){assert.equal(changed.status,'rejected');assert.equal(changed.reason.code,'teloa/conflict');assert.equal(task.assigneeRoleId,f.from.id);assert.deepEqual(runs.map(row=>row.state),['prepared'])}
 else{assert.equal(prepared.reason.code,'teloa/version-conflict');assert.equal(task.assigneeRoleId,null);assert.deepEqual(runs,[])}
})
test('同一交接并发接任一次，保留来源与原任务状态',async()=>{
 const f=await fixture(),[a,b]=await Promise.all([f.service.resolve(f.owner,f.input),f.service.resolve(f.owner,f.input)]);assert.deepEqual(a,b);assert.equal(a.task.assigneeRoleId,f.to.id);assert.equal(a.task.version,2);assert.equal(a.task.state,'ready')
 const rows=await f.service.list(f.owner,{});assert.equal(rows[0]?.status,'resolved');assert.equal(rows[0]?.fromRoleId,f.from.id)
 await f.lifecycle.change(f.owner,{roleId:f.to.id,expectedVersion:1,action:'pause',reason:'暂停后不重复交接'});assert.equal((await f.service.resolve(f.owner,f.input)).appliedVersion,2)
 await assert.rejects(f.service.resolve(f.owner,{...f.input,note:'不同意图'}),{code:'teloa/conflict'})
})
test('主体、任务版本、岗位版本及岗位状态都在服务端校验',async()=>{
 const f=await fixture();assert.deepEqual(await f.service.list('other',{}),[])
 await assert.rejects(f.service.resolve('other',f.input),{code:'teloa/forbidden'})
 await assert.rejects(f.service.resolve(f.owner,{...f.input,expectedTaskVersion:9}),{code:'teloa/version-conflict'})
 await assert.rejects(f.service.resolve(f.owner,{...f.input,expectedRoleVersion:9}),{code:'teloa/version-conflict'})
 await f.lifecycle.change(f.owner,{roleId:f.to.id,expectedVersion:1,action:'pause',reason:'暂停'})
 await assert.rejects(f.service.resolve(f.owner,{...f.input,expectedRoleVersion:2}),{code:'teloa/conflict'})
 assert.equal((await f.tasks.list(f.owner,{}))[0]?.assigneeRoleId,f.from.id)
})
test('本人可接管待交接任务，清除数字岗位绑定且不启动执行',async()=>{
 const f=await fixture(),result=await f.service.resolve(f.owner,{handoffId:f.handoff.id,expectedTaskVersion:1,target:{kind:'self'},note:'由本人接管并重新核对后续安排'})
 assert.equal(result.task.assigneeRoleId,null);assert.equal(result.task.assigneeRoleVersion,null);assert.equal(result.task.version,2);assert.equal(result.task.state,'ready')
 assert.equal((await f.service.list(f.owner,{}))[0]?.status,'resolved')
 const retry=await f.service.resolve(f.owner,{handoffId:f.handoff.id,expectedTaskVersion:1,target:{kind:'self'},note:'由本人接管并重新核对后续安排'})
 assert.equal(retry.appliedVersion,2);assert.equal(retry.task.assigneeRoleId,null)
})
test('接任回执失败时负责人和交接状态一起回滚',async()=>{
 const f=await fixture();await pool.query(`create function reject_test_resolution() returns trigger language plpgsql as $$ begin if new.handoff_id='${f.handoff.id}'::uuid then raise exception 'resolution unavailable'; end if; return new; end $$;create trigger reject_test_resolution before insert on teloa_handoff_resolutions for each row execute function reject_test_resolution()`)
 try{await assert.rejects(f.service.resolve(f.owner,f.input),/resolution unavailable/);assert.equal((await f.tasks.list(f.owner,{}))[0]?.version,1);assert.equal((await f.service.list(f.owner,{}))[0]?.status,'pending')}finally{await pool.query('drop trigger reject_test_resolution on teloa_handoff_resolutions;drop function reject_test_resolution()')}
})
test('运行中任务和不匹配业务拒绝改派，损坏交接不能被读成已完成',async()=>{
 const f=await fixture();await pool.query("update teloa_tasks set state='running' where id=$1",[f.task.id]);await assert.rejects(f.service.resolve(f.owner,f.input),{code:'teloa/conflict'})
 await pool.query("update teloa_tasks set state='ready' where id=$1",[f.task.id]);await pool.query("update teloa_roles set definition=jsonb_set(definition,'{scopes}','[\"AppSec\"]') where id=$1",[f.to.id]);await assert.rejects(f.service.resolve(f.owner,f.input),{code:'teloa/conflict'})
 await pool.query("update teloa_task_handoffs set status='resolved' where id=$1",[f.handoff.id]);await assert.rejects(f.service.list(f.owner,{}),{code:'teloa/storage-corrupt'})
})
test('接任岗位再次退役后保留连续交接，旧请求不能恢复旧负责人',async()=>{
 const f=await fixture();await f.service.resolve(f.owner,f.input)
 await f.lifecycle.change(f.owner,{roleId:f.to.id,expectedVersion:1,action:'retire',reason:'继续移交'})
 const rows=await f.service.list(f.owner,{}),second=rows.find(row=>row.fromRoleId===f.to.id)!
 assert.equal(rows.length,2);assert.equal(second.status,'pending');assert.equal(second.taskVersion,2)
 const roles=new RoleService(pool,identity),third=await roles.create(f.owner,{requestId:randomUUID(),fields:{name:'第三位接任者',kind:'employee',scopes:['SOC'],duty:'接续调查',dataScope:'资料',executionScope:'声明',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const latest=await f.service.resolve(f.owner,{handoffId:second.id,expectedTaskVersion:2,toRoleId:third.id,expectedRoleVersion:1,note:'第二次接任'})
 assert.equal(latest.task.version,3);assert.equal(latest.task.assigneeRoleId,third.id)
 const old=await f.service.resolve(f.owner,f.input)
 assert.equal(old.appliedVersion,2);assert.equal(old.task.version,3);assert.equal(old.task.assigneeRoleId,third.id)
 assert.ok((await f.service.list(f.owner,{})).every(row=>row.status==='resolved'))
})
