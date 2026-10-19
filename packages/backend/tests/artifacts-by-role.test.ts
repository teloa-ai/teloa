import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import type {SavedArtifactSource} from '@teloa/contract'
import {initializeRoles} from '../src/work/roles.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {initializeObjectConversations} from '../src/work/object-conversations.ts'
import {initializeTaskRuns} from '../src/work/task-runs.ts'
import {initializeBusinessSpaces} from '../src/work/business-spaces.ts'
import {initializeBusinessScopes} from '../src/work/business-scopes.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {ArtifactService,initializeArtifacts} from '../src/work/artifacts.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)
 await initializeBusinessSpaces(pool);await initializeBusinessScopes(pool);await initializeArtifactSnapshots(pool);await initializeArtifacts(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

let clock=Date.parse('2026-10-01T00:00:00.000Z')
const identity={id:randomUUID,now:()=>new Date(clock+=1000).toISOString()}
const service=()=>new ArtifactService(pool,identity,async(_owner,expected)=>({source:expected,sessionIds:[]}))
async function role(owner:string){
 const id=randomUUID(),now=new Date().toISOString()
 await pool.query("insert into teloa_roles(id,owner_id,request_id,request_spec,definition,version,state,created_at,updated_at) values($1,$2,$3,'{}','{}',1,'active',$4,$4)",[id,owner,randomUUID(),now])
 return id
}
async function task(owner:string,assignee?:string){
 const id=randomUUID()
 await pool.query("insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,state,assignee_role_id,assignee_role_version,created_at,updated_at) values($1,$2,$3,'{}',$4,1,'ready',$5,$6,now(),now())",[id,owner,randomUUID(),JSON.stringify({title:'任务',goal:'完成',scope:'general'}),assignee??null,assignee?1:null])
 return id
}
async function run(owner:string,taskId:string,roleId:string|null){
 const id=randomUUID()
 await pool.query("insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,owner_executor) values($1,$2,$3,'{}',$4,$5,1,$6,1,$7,$8,'ended','{}',now(),$9)",[id,owner,randomUUID(),taskId,roleId,roleId?1:null,'run-'+id,randomUUID(),roleId?null:JSON.stringify({kind:'owner'})])
 return id
}
async function link(owner:string,sessionId:string,roleId:string,active=true){
 await pool.query("insert into teloa_object_conversations(owner_id,kind,object_id,object_version,conversation_id,session_id,version,active,updated_at) values($1,'role',$2,1,$3,$4,1,$5,now())",[owner,roleId,'binding-'+sessionId,sessionId,active])
}
const source=(kind:'task'|'session',id:string,scope='general'):SavedArtifactSource=>({kind,id,scope,version:'v1',title:'来源'})
async function artifact(owner:string,from:SavedArtifactSource,title:string){
 return service().create(owner,{requestId:randomUUID(),source:from,content:{title,sections:[{id:'p1',title:'正文',text:title+' 初稿'}],snapshotIds:[],note:'保存'}})
}
/** 生产回执只经续改登记；这里直接写入一条已完成修订及其回执，模拟某个运行产出该版本。 */
async function produce(owner:string,artifactId:string,base:number,taskId:string,runId:string){
 const saved=await service().revise(owner,{artifactId,expectedVersion:base,source:(await service().list(owner,{artifactId}))[0]!.source,content:{title:'修订稿',sections:[{id:'p1',title:'正文',text:'修订 '+randomUUID()}],snapshotIds:[],note:'修订'}})
 const revisionId=randomUUID()
 await pool.query("insert into teloa_artifact_revision_requests(owner_id,id,request_spec,artifact_id,base_version,feedback_id,section_id,session_id,state,task_id,run_id,produced_version,created_at) values($1,$2,'{}',$3,$4,$5,'p1','chat','completed',$6,$7,$8,now())",[owner,revisionId,artifactId,base,randomUUID(),taskId,runId,saved.number])
 await pool.query('insert into teloa_artifact_revision_producers values($1,$2,$3,$4,$5,$6,$7)',[owner,artifactId,saved.number,revisionId,taskId,runId,2])
 return saved
}
const ids=(rows:{artifactId:string}[])=>rows.map(row=>row.artifactId)

test('按员工归集成果：任务 Run、任务指派、会话链接三条规则，多员工或无法确定的不归入',async()=>{
 const owner=randomUUID(),alice=await role(owner),bob=await role(owner)
 // b) 任务的全部 Run 都由 alice 执行
 const soloTask=await task(owner);await run(owner,soloTask,alice);await run(owner,soloTask,alice)
 const solo=await artifact(owner,source('task',soloTask),'独立任务成果')
 // b) 没有 Run 时按任务指派
 const assigned=await artifact(owner,source('task',await task(owner,alice)),'指派任务成果')
 // 多员工参与同一任务：不归入任何人
 const sharedTask=await task(owner);await run(owner,sharedTask,alice);await run(owner,sharedTask,bob)
 const shared=await artifact(owner,source('task',sharedTask),'多人任务成果')
 // 员工与本人都执行过：不能确定，不归入
 const mixedTask=await task(owner,alice);await run(owner,mixedTask,alice);await run(owner,mixedTask,null)
 const mixed=await artifact(owner,source('task',mixedTask),'混合任务成果')
 // c) 会话恰好一条 active 员工链接
 const chat='chat-'+randomUUID();await link(owner,chat,alice);await link(owner,chat,bob,false)
 const conversation=await artifact(owner,source('session',chat),'员工会话成果')
 const crowded='chat-'+randomUUID();await link(owner,crowded,alice);await link(owner,crowded,bob)
 const ambiguous=await artifact(owner,source('session',crowded),'多链接会话成果')
 const plain=await artifact(owner,source('session','chat-'+randomUUID()),'本人会话成果')
 // a) 生产回执的 Run 优先：bob 的任务成果被 alice 的 Run 修订后，只归 alice
 const bobTask=await task(owner);await run(owner,bobTask,bob)
 const revised=await artifact(owner,source('task',bobTask),'被修订成果')
 const reviseTask=await task(owner),aliceRun=await run(owner,reviseTask,alice)
 const latest=await produce(owner,revised.artifactId,1,reviseTask,aliceRun)

 const forAlice=await service().listByRole(owner,alice)
 assert.deepEqual(ids(forAlice).sort(),[solo,assigned,conversation,revised].map(row=>row.artifactId).sort())
 for(const excluded of [shared,mixed,ambiguous,plain])assert.ok(!ids(forAlice).includes(excluded.artifactId))
 const byId=new Map(forAlice.map(row=>[row.artifactId,row]))
 assert.equal(byId.get(solo.artifactId)!.attribution,'task')
 assert.equal(byId.get(assigned.artifactId)!.attribution,'task')
 assert.equal(byId.get(conversation.artifactId)!.attribution,'session')
 assert.equal(byId.get(revised.artifactId)!.attribution,'run')
 // 只列当前版本：版本号、标题与更新时间取当前版本，创建时间取初版
 assert.deepEqual(byId.get(revised.artifactId),{artifactId:revised.artifactId,number:2,title:'修订稿',source:source('task',bobTask),createdAt:revised.createdAt,updatedAt:latest.createdAt,attribution:'run'})
 // 按更新时间倒序
 assert.deepEqual(forAlice.map(row=>row.updatedAt),[...forAlice.map(row=>row.updatedAt)].sort().reverse())
 assert.equal(forAlice[0]!.artifactId,revised.artifactId)
 assert.deepEqual(ids(await service().listByRole(owner,bob)),[],'bob 的唯一成果已被 alice 的生产回执接管，其余均为多人参与')
})

test('按员工归集只读本人数据，并过滤本人无权查看的业务范围',async()=>{
 const owner=randomUUID(),other=randomUUID(),roleId=await role(owner),foreignRole=await role(other)
 const general=await artifact(owner,source('task',await task(owner,roleId)),'通用成果')
 const space=randomUUID()
 await pool.query("insert into teloa_business_spaces(id,owner_id,name,description,version,created_at,updated_at) values($1,$2,'空间','',1,now(),now())",[space,owner])
 await pool.query("insert into teloa_business_scopes(owner_id,space_id,scope,title,kind,created_at) values($1,$2,'sales','销售','domain',now())",[owner,space])
 const sales=await artifact(owner,source('task',await task(owner,roleId),'sales'),'销售成果')
 await artifact(owner,source('task',await task(owner,roleId),'secret'),'无权业务成果')
 assert.deepEqual(ids(await service().listByRole(owner,roleId)).sort(),[general.artifactId,sales.artifactId].sort())
 // 他人的员工与成果不能经本人身份读取
 await artifact(other,source('task',await task(other,foreignRole)),'他人成果')
 await assert.rejects(service().listByRole(owner,foreignRole),{code:'teloa/forbidden'})
 await assert.rejects(service().listByRole(other,roleId),{code:'teloa/forbidden'})
 await assert.rejects(service().listByRole(owner,'not-a-role'),{code:'teloa/invalid-input'})
 assert.equal((await service().listByRole(other,foreignRole)).length,1)
})

test('按员工归集设置上限，只返回最近更新的 50 条',async()=>{
 const owner=randomUUID(),roleId=await role(owner),taskId=await task(owner,roleId)
 for(let index=0;index<52;index++)await artifact(owner,{...source('task',taskId),version:'v'+index},'成果 '+index)
 const rows=await service().listByRole(owner,roleId)
 assert.equal(rows.length,50);assert.equal(rows[0]!.title,'成果 51');assert.equal(rows.at(-1)!.title,'成果 2')
})
