import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {initializeTaskRunSubagents,TaskRunSubagentService} from '../src/work/task-run-subagents.ts'
import {TaskRunRuntimeLinkService} from '../src/work/task-run-runtime-links.ts'
import {initializeTaskRunAbortProofs,readNativeRunSettlement,recordNativeRunAbortProof,assertNativeRunAbortProof,hashNativeRunSettlement} from '../src/work/task-run-abort-proof.ts'
let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri(),statement_timeout:4000,lock_timeout:2500})
 await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeTaskRunSubagents(pool);await initializeTaskRunAbortProofs(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(){
 const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'核对岗',kind:'employee',scopes:['general'],duty:'核对',dataScope:'范围内',executionScope:'受管',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},runtimeConfig:{agentPresetId:'teloa-standard'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'核对任务',goal:'登记竞争',scope:'general'},assignee:{roleId:role.id,expectedVersion:2}})
 const sessionId='parent_'+randomUUID().replaceAll('-',''),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1}),claimed=await runs.claim(owner,{runId:prepared.id})
 return {owner,run:claimed.run,runs}
}
async function endRun(f:Awaited<ReturnType<typeof fixture>>,db:import('pg').PoolClient){
 const evidence={state:'ended' as const,turn:0,messageSeq:1,endSeq:2,reason:'aborted'}
 const stopped=identity.now()
 await db.query("update teloa_task_runs set state='ended',evidence=$3,stop_requested_at=$4 where owner_id=$1 and id=$2",[f.owner,f.run.id,JSON.stringify(evidence),stopped])
 return {...f.run,state:'ended',evidence,stopRequestedAt:stopped}
}
async function record(db:import('pg').PoolClient,owner:string,run:Awaited<ReturnType<typeof fixture>>['run']){
 const settlement=await readNativeRunSettlement(db,owner,run)
 await recordNativeRunAbortProof(db,owner,run,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,turn:0,ownedEndTurn:0,messageSeq:1,endSeq:2,logCut:2,inheritedEventCount:0,reason:'aborted',source:'native-turn-end',eventHash:'a'.repeat(64),settlementHash:hashNativeRunSettlement(settlement)})
}
async function waitBlocked(pid:number){
 const deadline=Date.now()+1500
 while(!(await pool.query("select 1 from pg_stat_activity where pid=$1 and wait_event_type='Lock'",[pid])).rowCount){assert.ok(Date.now()<deadline,'登记操作必须等待同一个 Run 行锁');await new Promise(resolve=>setTimeout(resolve,10))}
}

test('register_runtime_link_vs_abort_proof',{timeout:20000},async()=>{
 const f=await fixture(),links=new TaskRunRuntimeLinkService(pool),holder=await pool.connect()
 const link={runId:f.run.id,kind:'browser',nativeId:'runtime:dispatch',sessionId:f.run.sessionId,payload:{runtimeId:'runtime',requestId:f.run.nativeRequestId,dispatchId:'dispatch',status:'dirty'}}
 try{
  await holder.query('begin');const ended=await endRun(f,holder);await record(holder,f.owner,ended)
  const registering=links.put(f.owner,link).then(()=>({error:undefined}),error=>({error}))
  const deadline=Date.now()+1500
  while(!(await pool.query("select 1 from pg_stat_activity where query like 'select session_id,%' and wait_event_type='Lock'")).rowCount){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10))}
  await holder.query('commit')
  assert.equal((await registering).error?.code,'teloa/conflict')
  assert.equal((await links.list(f.owner,{runId:f.run.id})).length,0)
  await holder.query('begin');await assertNativeRunAbortProof(holder,f.owner,ended);await holder.query('rollback')
 }finally{await holder.query('rollback');holder.release()}
})
test('existing_browser_can_close_after_terminal_but_new_link_is_rejected',{timeout:20000},async()=>{
 const f=await fixture(),links=new TaskRunRuntimeLinkService(pool),db=await pool.connect()
 const link={runId:f.run.id,kind:'browser',nativeId:'runtime:dispatch',sessionId:f.run.sessionId,payload:{runtimeId:'runtime',requestId:f.run.nativeRequestId,dispatchId:'dispatch',status:'dirty'}}
 await links.put(f.owner,link)
 try{
  await db.query('begin');const ended=await endRun(f,db);await db.query('commit')
  await links.put(f.owner,{...link,payload:{...link.payload,status:'closed'}})
  await assert.rejects(links.put(f.owner,{...link,nativeId:'runtime:late',payload:{...link.payload,dispatchId:'late'}}),{code:'teloa/conflict'})
  await db.query('begin');await record(db,f.owner,ended);await assertNativeRunAbortProof(db,f.owner,ended);await db.query('commit')
 }finally{await db.query('rollback');db.release()}
})
