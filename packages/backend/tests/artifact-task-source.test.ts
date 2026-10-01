import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {taskArtifactSource} from '../src/work/artifact-task-source.ts'
let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeTasks(pool)})
after(async()=>{await pool?.end();await container?.stop()})
test('任务成果来源取真实版本，已结束任务只能读取历史来源',async()=>{
 const owner=randomUUID(),service=new TaskService(pool,{id:randomUUID,now:()=>new Date().toISOString()}),task=await service.create(owner,{requestId:randomUUID(),fields:{title:'调查',goal:'核对证据',scope:'general'}})
 const source=await taskArtifactSource(pool,owner,task.id,false)
 assert.deepEqual(source,{kind:'task',id:task.id,scope:'general',version:`1 · ${task.updatedAt}`,title:'调查'})
 await assert.rejects(taskArtifactSource(pool,'other',task.id,false),{code:'teloa/forbidden'})
 await assert.rejects(taskArtifactSource(pool,owner,'invalid',false),{code:'teloa/invalid-input'})
 await pool.query("update teloa_tasks set state='completed' where id=$1",[task.id])
 assert.deepEqual(await taskArtifactSource(pool,owner,task.id,false),source)
 await assert.rejects(taskArtifactSource(pool,owner,task.id,true),{code:'teloa/conflict'})
})
test('成果事务持有来源共享锁直到提交，任务修改不能穿透',async()=>{
 const owner=randomUUID(),task=await new TaskService(pool,{id:randomUUID,now:()=>new Date().toISOString()}).create(owner,{requestId:randomUUID(),fields:{title:'锁定来源',goal:'核对',scope:'general'}})
 const writer=await pool.connect(),other=await pool.connect()
 try{await writer.query('begin');await taskArtifactSource(writer,owner,task.id,true)
  await assert.rejects(other.query('select * from teloa_tasks where id=$1 for update nowait',[task.id]),{code:'55P03'})
  await writer.query('commit');assert.equal((await other.query('select * from teloa_tasks where id=$1 for update nowait',[task.id])).rowCount,1)
 }finally{await writer.query('rollback');writer.release();other.release()}
})
