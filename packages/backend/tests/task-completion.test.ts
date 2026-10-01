import {TaskRunService,initializeTaskRuns} from '../src/work/task-runs.ts'
import {ObjectConversationService,initializeObjectConversations} from '../src/work/object-conversations.ts'
import {ArtifactService,initializeArtifacts} from '../src/work/artifacts.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {taskArtifactSource} from '../src/work/artifact-task-source.ts'
import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {TaskTransitions,initializeTaskTransitions,initializeTaskCompletions} from '../src/work/task-transitions.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeTaskTransitions(pool);await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeTaskCompletions(pool)})
after(async()=>{await pool?.end();await container?.stop()})
test('结项固定本任务成果版本，并发及重试不重复，结束后保留结项依据',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},tasks=new TaskService(pool,identity),states=new TaskTransitions(pool,identity)
 const initial=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'调查',goal:'核对证据',scope:'general'}})
 const task=await states.change(owner,{taskId:initial.id,requestId:randomUUID(),expectedVersion:1,action:'start'})
 const source=await taskArtifactSource(pool,owner,task.id,false)
 const artifacts=new ArtifactService(pool,identity,async(actor,expected,client)=>({source:await taskArtifactSource(client,actor,expected.id,true),sessionIds:[]}))
 const artifact=await artifacts.create(owner,{requestId:randomUUID(),source,content:{title:'调查报告',sections:[{id:'p1',title:'结论',text:'核对完毕'}],snapshotIds:[],note:'保存'}})
 const command={taskId:task.id,requestId:randomUUID(),expectedVersion:2,action:'complete',artifact:{id:artifact.artifactId,version:1},note:'本人确认交付'}
 await assert.rejects(states.change(owner,{...command,artifact:{id:randomUUID(),version:1}}))
 assert.equal((await tasks.list(owner,{}))[0]!.state,'running')
 await pool.query(`create function reject_completion_receipt_test() returns trigger language plpgsql as $$ begin if new.task_id='${task.id}' then raise exception 'completion receipt failed'; end if; return new; end $$;create trigger reject_completion_receipt_test before insert on teloa_task_transitions for each row execute function reject_completion_receipt_test()`)
 try{await assert.rejects(states.change(owner,command),/completion receipt failed/);assert.equal((await tasks.list(owner,{}))[0]!.state,'running');assert.equal(await states.completion(owner,{taskId:task.id}),null)}finally{await pool.query('drop trigger reject_completion_receipt_test on teloa_task_transitions;drop function reject_completion_receipt_test()')}
 const [a,b]=await Promise.all([states.change(owner,command),states.change(owner,command)]);assert.deepEqual(a,b);assert.equal(a.state,'completed');assert.equal(a.version,3)
 const completion=await states.completion(owner,{taskId:task.id});assert.equal(completion!.artifactId,artifact.artifactId);assert.equal(completion!.artifactVersion,1);assert.equal(completion!.note,'本人确认交付')
 await assert.rejects(states.change(owner,{...command,note:'另一份交付'}),{code:'teloa/conflict'})
 await assert.rejects(taskArtifactSource(pool,owner,task.id,true),{code:'teloa/conflict'})
})
test('过期或其他任务的成果不能结项，拒绝后仍保留进行中任务',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},tasks=new TaskService(pool,identity),states=new TaskTransitions(pool,identity)
 const created=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'当前调查',goal:'核对',scope:'general'}})
 const task=await states.change(owner,{taskId:created.id,requestId:randomUUID(),expectedVersion:1,action:'start'})
 const artifacts=new ArtifactService(pool,identity,async(actor,expected,client)=>({source:await taskArtifactSource(client,actor,expected.id,true),sessionIds:[]}))
 const artifact=await artifacts.create(owner,{requestId:randomUUID(),source:await taskArtifactSource(pool,owner,task.id,false),content:{title:'原成果',sections:[{id:'p1',title:'说明',text:'原结论'}],snapshotIds:[],note:'保存'}})
 await states.change(owner,{taskId:task.id,requestId:randomUUID(),expectedVersion:2,action:'pause'})
 await states.change(owner,{taskId:task.id,requestId:randomUUID(),expectedVersion:3,action:'resume'})
 const command={taskId:task.id,expectedVersion:4,requestId:randomUUID(),action:'complete',artifact:{id:artifact.artifactId,version:1},note:'结项'}
 await assert.rejects(states.change(owner,command),{code:'teloa/version-conflict'})
 const other=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'另一调查',goal:'核对',scope:'general'}})
 await states.change(owner,{taskId:other.id,requestId:randomUUID(),expectedVersion:1,action:'start'})
 await assert.rejects(states.change(owner,{...command,taskId:other.id,expectedVersion:2,requestId:randomUUID()}),{code:'teloa/version-conflict'})
 assert.equal((await tasks.list(owner,{})).find(t=>t.id===task.id)!.state,'running');assert.equal(await states.completion(owner,{taskId:task.id}),null)
})

test('数字员工仅在本轮成功后由本人验收固定成果，执行中不可结项',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},tasks=new TaskService(pool,identity),states=new TaskTransitions(pool,identity)
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['general'],duty:'调查',dataScope:'只读',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'investigator'}}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'岗位调查',goal:'核对证据',scope:'general'},assignee:{roleId:role.id,expectedVersion:1}})
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),run=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:1})
 await runs.claim(owner,{runId:run.id})
 const command={taskId:task.id,requestId:randomUUID(),expectedVersion:2,action:'complete',artifact:{id:randomUUID(),version:1},note:'本人验收'}
 await assert.rejects(states.change(owner,command),{code:'teloa/conflict'})
 await pool.query("update teloa_tasks set state='waiting' where id=$1",[task.id])
 await assert.rejects(states.change(owner,command),{code:'teloa/conflict'})
 await pool.query("update teloa_tasks set state='running' where id=$1",[task.id])
 await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 const source=await taskArtifactSource(pool,owner,task.id,false)
 const artifacts=new ArtifactService(pool,identity,async(actor,expected,client)=>({source:await taskArtifactSource(client,actor,expected.id,true),sessionIds:[]}))
 const artifact=await artifacts.create(owner,{requestId:randomUUID(),source,content:{title:'验收报告',sections:[{id:'p1',title:'结论',text:'证据已核对'}],snapshotIds:[],note:'保存'}})
 await pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,agent_preset_id,configuration_error)
  select $2,owner_id,$3::uuid,jsonb_set(request_spec,'{requestId}',to_jsonb($3::uuid::text)),task_id,role_id,task_version,role_version,0,$4,$5,'configuration_failed',input_text,created_at+interval '1 second',agent_preset_id,$6 from teloa_task_runs where id=$1`,[run.id,randomUUID(),randomUUID(),randomUUID(),randomUUID(),JSON.stringify({code:'teloa/preset-unavailable',stage:'preset-resolve',message:'另一轮运行配置不可用'})])
 const final={...command,expectedVersion:3,artifact:{id:artifact.artifactId,version:1}}
 const [a,b]=await Promise.all([states.change(owner,final),states.change(owner,final)])
 assert.equal(a.state,'completed');assert.equal(a.version,4);assert.deepEqual(a,b)
 assert.equal((await states.completion(owner,{taskId:task.id}))!.artifactId,artifact.artifactId)
})
