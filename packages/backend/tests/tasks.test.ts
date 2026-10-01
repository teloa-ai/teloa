import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()},fields={title:'调查异常外联',goal:'核对证据与影响范围',scope:'SOC'}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeTasks(pool)})
after(async()=>{await pool?.end();await container?.stop()})
const fixture=()=>({owner:randomUUID(),service:new TaskService(pool,identity)})
/** 创建后直接在岗；这些用例要的是「暂停岗位」起点，夹具把状态摆回暂停且不动版本。 */
const makeRole=async(owner:string)=>{const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['SOC'],duty:'调查',dataScope:'提供的资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}});await pool.query("update teloa_roles set state='paused' where id=$1",[role.id]);return role}
test('任务并发幂等创建、本人隔离和数据库恢复',async()=>{
 const {owner,service}=fixture(),input={requestId:randomUUID(),fields}
 const [a,b]=await Promise.all([service.create(owner,input),service.create(owner,input)])
 assert.deepEqual(a,b);assert.equal(a.state,'ready');assert.equal(a.assigneeRoleId,null)
 assert.deepEqual(await new TaskService(pool,identity).list(owner,{}),[a]);assert.deepEqual(await service.list('other',{}),[])
 await assert.rejects(service.create(owner,{...input,fields:{...fields,title:'不同意图'}}),{code:'teloa/conflict'})
})
test('交办需要本人在岗员工、原岗位版本和匹配业务，重试不重新交办',async()=>{
 const {owner,service}=fixture(),role=await makeRole(owner),input={requestId:randomUUID(),fields,assignee:{roleId:role.id,expectedVersion:1}}
 await assert.rejects(service.create(owner,input),{code:'teloa/conflict'})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 await assert.rejects(service.create('other',input),{code:'teloa/forbidden'})
 await assert.rejects(service.create(owner,{...input,assignee:{roleId:role.id,expectedVersion:9}}),{code:'teloa/version-conflict'})
 await assert.rejects(service.create(owner,{...input,fields:{...fields,scope:'AppSec'}}),{code:'teloa/forbidden'})
 const created=await service.create(owner,input);assert.equal(created.assigneeRoleId,role.id);assert.equal(created.assigneeRoleVersion,1)
 await pool.query("update teloa_roles set state='paused',version=2 where id=$1",[role.id]);assert.deepEqual(await service.create(owner,input),created)
 await assert.rejects(service.create(owner,{...input,requestId:randomUUID()}),{code:'teloa/version-conflict'})
})
test('伪造状态和作者不能入库，损坏定义显式失败',async()=>{
 const {owner,service}=fixture()
 for(const input of [{requestId:randomUUID(),fields,ownerId:'other'},{requestId:randomUUID(),fields:{...fields,state:'completed'}},{requestId:randomUUID(),fields:{...fields,goal:''}},{requestId:randomUUID(),fields,assignee:{roleId:'not-uuid',expectedVersion:1}}])await assert.rejects(service.create(owner,input),{code:'teloa/invalid-input'})
 assert.deepEqual(await service.list(owner,{}),[])
 const task=await service.create(owner,{requestId:randomUUID(),fields});await pool.query("update teloa_tasks set definition=jsonb_set(definition,'{title}','null') where id=$1",[task.id]);await assert.rejects(service.list(owner,{}),{code:'teloa/storage-corrupt'})
})
test('数据库拒绝跨本人岗位引用，写入错误回滚',async()=>{
 const {owner,service}=fixture(),role=await makeRole('other'),task=await service.create(owner,{requestId:randomUUID(),fields})
 await assert.rejects(pool.query('update teloa_tasks set assignee_role_id=$2,assignee_role_version=1 where id=$1',[task.id,role.id]),{code:'23503'})
 const failedOwner=randomUUID(),broken=new TaskService(pool,{id:randomUUID,now:()=> 'bad-time'})
 await assert.rejects(broken.create(failedOwner,{requestId:randomUUID(),fields}));assert.deepEqual(await service.list(failedOwner,{}),[])
})
test('负责人被锁期间交办等待，提交暂停后不能穿透接收任务',async()=>{
 const {owner,service}=fixture(),role=await makeRole(owner)
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const holder=await pool.connect();await holder.query('begin');await holder.query('select * from teloa_roles where id=$1 for update',[role.id])
 const pending=service.create(owner,{requestId:randomUUID(),fields,assignee:{roleId:role.id,expectedVersion:1}}).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 try{
  const deadline=Date.now()+3000;let waiting=false
  while(Date.now()<deadline){const result=await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select * from teloa_roles where id=%'");if(result.rowCount){waiting=true;break}await new Promise(resolve=>setTimeout(resolve,10))}
  assert.ok(waiting,'真实交办应等待岗位行锁')
  await holder.query("update teloa_roles set state='paused' where id=$1",[role.id]);await holder.query('commit')
  assert.equal((await pending).error?.code,'teloa/conflict');assert.deepEqual(await service.list(owner,{}),[])
 }finally{await holder.query('rollback');holder.release();await pending}
})

test('任务目标编辑保留业务与负责人，旧版本重试固定回执，不覆盖更新版本',async()=>{
 const owner=randomUUID(),service=new TaskService(pool,{id:randomUUID,now:()=>new Date().toISOString()})
 const task=await service.create(owner,{requestId:randomUUID(),fields:{title:'原任务',goal:'原目标',scope:'general'}})
 const command={taskId:task.id,expectedVersion:1,fields:{title:'新任务',goal:'新目标'}}
 const [a,b]=await Promise.all([service.edit(owner,command),service.edit(owner,command)])
 assert.deepEqual(a,b);assert.equal(a.version,2);assert.equal(a.scope,'general');assert.equal(a.assigneeRoleId,null)
 await assert.rejects(service.edit(owner,{...command,fields:{title:'另一个任务',goal:'另一个目标'}}),{code:'teloa/version-conflict'})
 const latest=await service.edit(owner,{taskId:task.id,expectedVersion:2,fields:{title:'最终任务',goal:'最终目标'}})
 assert.equal(latest.version,3);assert.deepEqual(await service.edit(owner,command),a)
 assert.equal((await service.list(owner,{}))[0]!.title,'最终任务')
 await assert.rejects(service.edit('other',command),{code:'teloa/forbidden'})
 await pool.query("update teloa_tasks set state='running' where id=$1",[task.id])
 await assert.rejects(service.edit(owner,{...command,expectedVersion:3}),{code:'teloa/conflict'})
})
test('编辑回执写入失败回滚任务，损坏回执不能作为成功返回',async()=>{
 const owner=randomUUID(),service=new TaskService(pool,identity),task=await service.create(owner,{requestId:randomUUID(),fields})
 const command={taskId:task.id,expectedVersion:1,fields:{title:'待保存',goal:'待保存目标'}}
 await pool.query(`create function reject_task_edit_test() returns trigger language plpgsql as $$ begin if new.task_id='${task.id}' then raise exception 'receipt failed'; end if; return new; end $$;create trigger reject_task_edit_test before insert on teloa_task_edits for each row execute function reject_task_edit_test()`)
 try{await assert.rejects(service.edit(owner,command),/receipt failed/);assert.equal((await service.list(owner,{}))[0]!.version,1)}finally{await pool.query('drop trigger reject_task_edit_test on teloa_task_edits;drop function reject_task_edit_test()')}
 await service.edit(owner,command)
 await pool.query("update teloa_task_edits set result=jsonb_set(result,'{owner_id}','\"other\"') where task_id=$1",[task.id])
 await assert.rejects(service.edit(owner,command),{code:'teloa/storage-corrupt'})
})

test('复用调用者事务创建任务，外层回滚后任务与调用者修改一起消失',async()=>{
 const {owner,service}=fixture(),role=await makeRole(owner),client=await pool.connect()
 const input={requestId:randomUUID(),fields,assignee:{roleId:role.id,expectedVersion:1}}
 try{
  await client.query('begin')
  await client.query("update teloa_roles set state='active' where id=$1",[role.id])
  const created=await service.createInTransaction(client,owner,input)
  assert.equal((await client.query('select id from teloa_tasks where id=$1',[created.id])).rowCount,1)
  assert.equal((await pool.query('select id from teloa_tasks where id=$1',[created.id])).rowCount,0,'外层提交前不能泄漏任务')
  await client.query('rollback')
  assert.deepEqual(await service.list(owner,{}),[])
  assert.equal((await pool.query('select state from teloa_roles where id=$1',[role.id])).rows[0].state,'paused')
 }finally{await client.query('rollback');client.release()}
})

test('调用者提交后同请求幂等找回任务，不重新检查已暂停岗位或暗中提交外层事务',async()=>{
 const {owner,service}=fixture(),role=await makeRole(owner),client=await pool.connect()
 const input={requestId:randomUUID(),fields,assignee:{roleId:role.id,expectedVersion:1}}
 try{
  await client.query('begin');await client.query("update teloa_roles set state='active' where id=$1",[role.id])
  const created=await service.createInTransaction(client,owner,input)
  assert.deepEqual(await service.createInTransaction(client,owner,input),created)
  await client.query('commit')
  await pool.query("update teloa_roles set state='paused',version=2 where id=$1",[role.id])
  assert.deepEqual(await new TaskService(pool,identity).create(owner,input),created)
  await client.query('begin');await client.query('update teloa_roles set version=3 where id=$1',[role.id])
  assert.deepEqual(await service.createInTransaction(client,owner,input),created)
  await client.query('rollback')
  assert.equal((await pool.query('select version from teloa_roles where id=$1',[role.id])).rows[0].version,2)
  assert.equal((await service.list(owner,{})).length,1)
 }finally{await client.query('rollback');client.release()}
})
test('关联协作群必须属于本人且未归档，编辑目标不丢关联群与使用技能',async()=>{
 const {owner,service}=fixture()
 await initializeCollaboration(pool)
 const now=new Date().toISOString()
 const definition=JSON.stringify({name:'调查协作',scope:'SOC',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[]})
 const addGroup=async(groupOwner:string,archived:boolean)=>{const id=randomUUID();await pool.query('insert into teloa_groups(id,owner_id,request_id,request_spec,definition,version,pinned,archived,created_at,updated_at) values($1,$2,$3,$4,$4,1,false,$5,$6,$6)',[id,groupOwner,randomUUID(),definition,archived,now]);return id}
 const mine=await addGroup(owner,false),archivedGroup=await addGroup(owner,true),other=await addGroup(randomUUID(),false)
 for(const groupId of [archivedGroup,other,randomUUID()])await assert.rejects(service.create(owner,{requestId:randomUUID(),fields:{...fields,groupId}}),{code:'teloa/invalid-input'})
 assert.deepEqual(await service.list(owner,{}),[])
 const task=await service.create(owner,{requestId:randomUUID(),fields:{...fields,groupId:mine,skills:['证据核对','工单归档']}})
 assert.equal(task.groupId,mine);assert.deepEqual(task.skills,['证据核对','工单归档'])
 const edited=await service.edit(owner,{taskId:task.id,expectedVersion:task.version,fields:{title:'调查异常外联（复核）',goal:task.goal}})
 assert.equal(edited.groupId,mine);assert.deepEqual(edited.skills,['证据核对','工单归档'])
})
