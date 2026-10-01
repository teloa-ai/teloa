import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {TaskTransitions,initializeTaskTransitions} from '../src/work/task-transitions.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeTasks(pool);await initializeTaskTransitions(pool)})
after(async()=>{await pool?.end();await container?.stop()})
test('本人任务状态按版本推进，重复请求不重复推进，取消不能被旧请求复活',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},tasks=new TaskService(pool,identity),service=new TaskTransitions(pool,identity)
 const task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'本人调查',goal:'核对证据',scope:'general'}})
 const start={taskId:task.id,requestId:randomUUID(),expectedVersion:1,action:'start'}
 const [a,b]=await Promise.all([service.change(owner,start),service.change(owner,start)])
 assert.deepEqual(a,b);assert.equal(a.state,'running');assert.equal(a.version,2)
 await assert.rejects(service.change(owner,{...start,action:'cancel'}),{code:'teloa/conflict'})
 const paused=await service.change(owner,{taskId:task.id,requestId:randomUUID(),expectedVersion:2,action:'pause'});assert.equal(paused.state,'paused')
 const cancelled=await service.change(owner,{taskId:task.id,requestId:randomUUID(),expectedVersion:3,action:'cancel'});assert.equal(cancelled.state,'cancelled')
 assert.deepEqual(await service.change(owner,start),a);assert.equal((await tasks.list(owner,{}))[0]!.state,'cancelled')
 await assert.rejects(service.change(owner,{...start,requestId:randomUUID(),expectedVersion:4}),{code:'teloa/conflict'})
 await assert.rejects(service.change('other',{...start,requestId:randomUUID()}),{code:'teloa/forbidden'})
 await assert.rejects(service.change(owner,{...start,ownerId:'other'}),{code:'teloa/invalid-input'})
})
test('数字员工任务不能伪装启动，状态回执损坏时停止重试',async()=>{
 const {RoleService}=await import('../src/work/roles.ts')
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},tasks=new TaskService(pool,identity),service=new TaskTransitions(pool,identity)
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['general'],duty:'调查',dataScope:'提供的材料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const assigned=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'交办调查',goal:'核对',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}})
 await assert.rejects(service.change(owner,{taskId:assigned.id,expectedVersion:1,requestId:randomUUID(),action:'start'}),{code:'teloa/conflict'})
 assert.equal((await tasks.list(owner,{}))[0]!.state,'ready')
 const task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'本人调查',goal:'核对',scope:'general'}}),command={taskId:task.id,requestId:randomUUID(),expectedVersion:1,action:'start'}
 await service.change(owner,command)
 await pool.query("update teloa_task_transitions set result=jsonb_set(result,'{state}','\"ready\"') where owner_id=$1 and request_id=$2",[owner,command.requestId])
 await assert.rejects(service.change(owner,command),{code:'teloa/storage-corrupt'})
})
