import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeTaskRuns} from '../src/work/task-runs.ts'
import {initializeIndustryTasks} from '../src/work/industry-tasks.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeTasks(pool);await initializeCollaboration(pool);await initializeTaskRuns(pool);await initializeIndustryTasks(pool)})
after(async()=>{await pool?.end();await container?.stop()})
async function setup(){const owner=randomUUID(),service=new TaskService(pool,identity),task=await service.create(owner,{requestId:randomUUID(),fields:{title:'原任务',goal:'核对证据',scope:'general'}});return {owner,service,task}}
async function group(owner:string,scope='general',archived=false){const id=randomUUID(),definition=JSON.stringify({name:'证据组',scope,announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[]});await pool.query('insert into teloa_groups(id,owner_id,request_id,request_spec,definition,version,pinned,archived,created_at,updated_at) values($1,$2,$3,$4,$4,1,false,$5,$6,$6)',[id,owner,randomUUID(),definition,archived,identity.now()]);return id}
async function run(owner:string,taskId:string,state='ended'){const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'核对员',kind:'employee',scopes:['general'],duty:'核对证据',dataScope:'提供的资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}});await pool.query('insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at) values($1,$2,$3,$4,$5,$6,1,1,1,$7,$8,$9,$10,$11)',[randomUUID(),owner,randomUUID(),'{}',taskId,role.id,'isolated',randomUUID(),state,'fixed context',identity.now()])}
test('未启动原任务可保存群和技能声明；任务身份、谱系、创建请求与负责人保持',async()=>{
 const {owner,service,task}=await setup(),groupId=await group(owner),before=(await pool.query('select * from teloa_task_work_lineage where task_id=$1',[task.id])).rows
 const input={requestId:randomUUID(),taskId:task.id,expectedVersion:1,fields:{title:'证据复核',groupId,skills:['证据核对']}}
 const saved=await service.configure(owner,input)
 assert.equal(saved.id,task.id);assert.equal(saved.version,2);assert.equal(saved.contentVersion,2);assert.equal(saved.goal,'核对证据');assert.equal(saved.groupId,groupId);assert.deepEqual(saved.skills,['证据核对']);assert.equal(saved.assigneeRoleId,null);assert.equal(saved.state,'ready')
 assert.deepEqual((await pool.query('select * from teloa_task_work_lineage where task_id=$1',[task.id])).rows,before)
 assert.equal((await pool.query('select execution_authorization from teloa_tasks where id=$1',[task.id])).rows[0].execution_authorization,null)
 assert.deepEqual(await new TaskService(pool,identity).configure(owner,{...input,expectedVersion:2}),saved)
 assert.deepEqual(await new TaskService(pool,identity).configurationRequest(owner,{requestId:input.requestId}),{task:saved,fields:{groupId,skills:['证据核对'],title:'证据复核'}})
 await assert.rejects(service.configure(owner,{...input,fields:{title:'另一个要求'}}),{code:'teloa/conflict'})
 assert.equal((await service.list(owner,{}))[0]!.version,2)
})
test('配置拒绝跨本人、跨业务或归档群；不能修改原业务身份或机器权限',async()=>{
 const {owner,service,task}=await setup()
 for(const groupId of [await group('other'),await group(owner,'SOC'),await group(owner,'general',true)])await assert.rejects(service.configure(owner,{requestId:randomUUID(),taskId:task.id,expectedVersion:1,fields:{groupId}}))
 await assert.rejects(service.configure(owner,{requestId:randomUUID(),taskId:task.id,expectedVersion:1,fields:{scope:'SOC'}}),{code:'teloa/forbidden'})
 await assert.rejects(service.configure(owner,{requestId:randomUUID(),taskId:task.id,expectedVersion:1,fields:{allowedTools:['bash']}}),{code:'teloa/invalid-input'})
 await assert.rejects(service.configure('other',{requestId:randomUUID(),taskId:task.id,expectedVersion:1,fields:{goal:'变更'}}),{code:'teloa/forbidden'})
 assert.equal((await service.list(owner,{}))[0]!.version,1)
})
test('已有运行记录禁止换群和技能；冻结的准备或执行上下文禁止改目标',async()=>{
 const {owner,service,task}=await setup();await run(owner,task.id)
 await assert.rejects(service.configure(owner,{requestId:randomUUID(),taskId:task.id,expectedVersion:1,fields:{skills:['新技能']}}),{code:'teloa/conflict'})
 const saved=await service.configure(owner,{requestId:randomUUID(),taskId:task.id,expectedVersion:1,fields:{goal:'补充验收标准'}});assert.equal(saved.version,2)
 const active=await setup();await run(active.owner,active.task.id,'prepared')
 await assert.rejects(active.service.configure(active.owner,{requestId:randomUUID(),taskId:active.task.id,expectedVersion:1,fields:{goal:'偷偷替换'}}),{code:'teloa/conflict'})
 assert.equal((await active.service.list(active.owner,{}))[0]!.goal,'核对证据')
})
test('并发同请求只保存一版，取消与写入回执失败均回滚',async()=>{
 const {owner,service,task}=await setup(),input={requestId:randomUUID(),taskId:task.id,expectedVersion:1,fields:{goal:'复核'}}
 const [a,b]=await Promise.all([service.configure(owner,input),service.configure(owner,input)]);assert.deepEqual(a,b);assert.equal(a.version,2)
 const controller=new AbortController();controller.abort();await assert.rejects(service.configure(owner,{...input,requestId:randomUUID(),expectedVersion:2,fields:{goal:'取消后写入'}},controller.signal));assert.equal((await service.list(owner,{}))[0]!.version,2)
 let checks=0;const late=new AbortController(),cancelled={...input,requestId:randomUUID(),expectedVersion:2,fields:{goal:'晚取消'}}
 await assert.rejects(service.configure(owner,cancelled,late.signal,async()=>{if(++checks===2)late.abort()}));assert.equal((await service.list(owner,{}))[0]!.version,2);assert.equal(await service.configurationRequest(owner,{requestId:cancelled.requestId}),null)
 const failed={...input,requestId:randomUUID(),expectedVersion:2,fields:{goal:'回执失败'}}
 await pool.query(`create function reject_configuration_receipt() returns trigger language plpgsql as $$ begin if new.owner_id='${owner}' then raise exception 'receipt failed'; end if; return new; end $$; create trigger reject_configuration_receipt before insert on teloa_task_configuration_requests for each row execute function reject_configuration_receipt()`)
 try{await assert.rejects(service.configure(owner,failed),/receipt failed/);assert.equal((await service.list(owner,{}))[0]!.version,2);assert.equal(await service.configurationRequest(owner,{requestId:failed.requestId}),null)}finally{await pool.query('drop trigger reject_configuration_receipt on teloa_task_configuration_requests; drop function reject_configuration_receipt()')}
})
test('固定行业来源即使尚未生成运行，也不能另换群或技能声明',async()=>{
 const {owner,service,task}=await setup()
 await pool.query('insert into teloa_industry_task_sources(task_id,owner_id,request_id,request_spec,source_snapshot,snapshot_digest,created_at) values($1,$2,$3,$4,$4,$5,$6)',[task.id,owner,randomUUID(),'{}','a'.repeat(64),identity.now()])
 await assert.rejects(service.configure(owner,{requestId:randomUUID(),taskId:task.id,expectedVersion:1,fields:{skills:['替代来源技能']}}),{code:'teloa/conflict'})
 assert.equal((await service.list(owner,{}))[0]!.version,1)
})
test('会话建任务草稿在提交前取消，不留下任务或谱系',async()=>{
 const owner=randomUUID(),service=new TaskService(pool,identity),controller=new AbortController(),input={requestId:randomUUID(),fields:{title:'待保存',goal:'先准备',scope:'general'}}
 await assert.rejects(service.create(owner,input,controller.signal,async()=>controller.abort()))
 assert.deepEqual(await service.list(owner,{}),[])
 assert.equal((await pool.query('select 1 from teloa_task_work_lineage where owner_id=$1',[owner])).rowCount,0)
})
test('群显示名语义随配置请求持久恢复，改名归档不重写回执且同请求换名称拒绝',async()=>{
 const {owner,service,task}=await setup(),groupId=await group(owner),input={requestId:randomUUID(),taskId:task.id,expectedVersion:1,taskName:task.title,groupName:'证据组',fields:{groupId}}
 const saved=await service.configure(owner,input)
 await pool.query("update teloa_groups set archived=true,definition=jsonb_set(definition,'{name}','\"已归档证据组\"') where id=$1",[groupId])
 assert.deepEqual(await new TaskService(pool,identity).configurationRequest(owner,{requestId:input.requestId}),{task:saved,fields:{groupId},taskName:'原任务',groupName:'证据组'})
 assert.deepEqual(await service.configure(owner,{...input,expectedVersion:2}),saved)
 await assert.rejects(service.configure(owner,{...input,expectedVersion:2,groupName:'已归档证据组'}),{code:'teloa/conflict'})
 await pool.query("update teloa_task_configuration_requests set request_spec=jsonb_set(request_spec,'{groupName}','null') where owner_id=$1 and request_id=$2",[owner,input.requestId])
 await assert.rejects(service.configurationRequest(owner,{requestId:input.requestId}),{code:'teloa/storage-corrupt'})
})
test('NL创建回执固定原v1，群和任务改名后恢复原compiled定义及原会话语义',async()=>{
 const owner=randomUUID(),service=new TaskService(pool,identity),groupId=await group(owner),input={requestId:randomUUID(),sessionId:'ordinary-origin',businessName:'通用工作',groupName:'证据组',fields:{title:'原草稿',goal:'准备核验',scope:'general',groupId,skills:['证据核对']}}
 const created=await service.createConfiguration(owner,input)
 assert.equal(created.version,1);assert.equal(created.state,'ready');assert.equal(created.assigneeRoleId,null)
 await service.edit(owner,{taskId:created.id,expectedVersion:1,fields:{title:'更名草稿',goal:'更新目标'}})
 await pool.query("update teloa_groups set archived=true,definition=jsonb_set(definition,'{name}','\"新名称\"') where id=$1",[groupId])
 assert.deepEqual(await new TaskService(pool,identity).createConfiguration(owner,input),created)
 assert.deepEqual(await service.createConfigurationRequest(owner,{requestId:input.requestId}),{...input,task:created})
 for(const patch of [{sessionId:'another'},{groupName:'新名称'},{businessName:'别的业务'},{fields:{...input.fields,goal:'变更请求'}}])await assert.rejects(service.createConfiguration(owner,{...input,...patch}),{code:'teloa/conflict'})
 assert.equal((await service.list(owner,{}))[0]!.title,'更名草稿');assert.equal((await service.list(owner,{})).length,1)
 assert.equal(await service.createConfigurationRequest('other',{requestId:input.requestId}),null)
 const controller=new AbortController();controller.abort();await assert.rejects(service.createConfiguration(owner,input,controller.signal))
})
test('NL草稿并发恢复只有原Task，取消与回执失败回滚，损坏回执不能冒充成功',async()=>{
 const owner=randomUUID(),service=new TaskService(pool,identity),input={requestId:randomUUID(),sessionId:'origin',fields:{title:'草稿',goal:'先准备',scope:'general'}}
 const [a,b]=await Promise.all([service.createConfiguration(owner,input),service.createConfiguration(owner,input)]);assert.deepEqual(a,b);assert.equal((await service.list(owner,{})).length,1)
 const cancelledOwner=randomUUID(),controller=new AbortController(),cancelled={...input,requestId:randomUUID()};let checks=0
 await assert.rejects(service.createConfiguration(cancelledOwner,cancelled,controller.signal,async()=>{if(++checks===2)controller.abort()}));assert.deepEqual(await service.list(cancelledOwner,{}),[]);assert.equal(await service.createConfigurationRequest(cancelledOwner,{requestId:cancelled.requestId}),null)
 const failedOwner=randomUUID(),failed={...input,requestId:randomUUID()}
 await pool.query(`create function reject_draft_receipt() returns trigger language plpgsql as $$ begin if new.owner_id='${failedOwner}' then raise exception 'draft receipt failed'; end if; return new; end $$;create trigger reject_draft_receipt before insert on teloa_task_draft_requests for each row execute function reject_draft_receipt()`)
 try{await assert.rejects(service.createConfiguration(failedOwner,failed),/draft receipt failed/);assert.deepEqual(await service.list(failedOwner,{}),[]);assert.equal(await service.createConfigurationRequest(failedOwner,{requestId:failed.requestId}),null)}finally{await pool.query('drop trigger reject_draft_receipt on teloa_task_draft_requests;drop function reject_draft_receipt()')}
 await pool.query("update teloa_task_draft_requests set result=jsonb_set(result,'{version}','2') where owner_id=$1 and request_id=$2",[owner,input.requestId])
 await assert.rejects(service.createConfigurationRequest(owner,{requestId:input.requestId}),{code:'teloa/storage-corrupt'});await assert.rejects(service.createConfiguration(owner,input),{code:'teloa/storage-corrupt'})
})
test('NL草稿真实后端拒绝任务业务不一致的群，失败不留任务与创建回执',async()=>{
 const owner=randomUUID(),service=new TaskService(pool,identity),groupId=await group(owner,'SOC'),input={requestId:randomUUID(),sessionId:'origin',groupName:'证据组',fields:{title:'跨业务草稿',goal:'准备',scope:'general',groupId}}
 await assert.rejects(service.createConfiguration(owner,input),{code:'teloa/forbidden'});assert.deepEqual(await service.list(owner,{}),[]);assert.equal(await service.createConfigurationRequest(owner,{requestId:input.requestId}),null)
})
