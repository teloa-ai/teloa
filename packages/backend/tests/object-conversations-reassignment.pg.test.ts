import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {ObjectConversationService,initializeObjectConversations} from '../src/work/object-conversations.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool,observer:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 const connectionString=container.getConnectionUri()
 pool=new Pool({connectionString,max:1,statement_timeout:6000,lock_timeout:4000})
 observer=new Pool({connectionString,max:3,statement_timeout:6000,lock_timeout:4000})
 await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await observer?.end();await container?.stop()})

async function fixture(kind:'task'|'role'){
 const owner=randomUUID(),sessionId='daily_'+randomUUID().replaceAll('-','')
 const object=kind==='task'
  ?await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'核对任务',goal:'保留原关联规则',scope:'general'}})
  :await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'核对岗',kind:'employee',scopes:['general'],duty:'核对',dataScope:'范围内',executionScope:'受管',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const conversation={id:randomUUID(),sessionId,ownerId:owner as string,status:'ready'}
 const service=new ObjectConversationService(pool,async(actor,id)=>{
  assert.equal(actor,owner);assert.equal(id,sessionId);return {...conversation}
 },identity.now)
 const command={requestId:randomUUID(),kind,objectId:object.id,expectedObjectVersion:object.version,sessionId,expectedLinkVersion:0,action:'link'}
 return {owner,kind,object,conversation,service,command}
}
type Fixture=Awaited<ReturnType<typeof fixture>>
type Outcome={value:Awaited<ReturnType<ObjectConversationService['change']>>;error?:never}|{error:unknown;value?:never}
async function state(f:Fixture){
 const links=(await observer.query('select version,active from teloa_object_conversations where owner_id=$1 and kind=$2 and object_id=$3 and session_id=$4',[f.owner,f.kind,f.object.id,f.command.sessionId])).rows
 const receipts=(await observer.query('select request_id from teloa_object_conversation_requests where owner_id=$1 order by request_id',[f.owner])).rows
 return {links,receipts}
}
async function waitForContextLock(pid:number,holderPid:number,outcome:()=>Outcome|undefined){
 const deadline=Date.now()+2000
 while(true){
  const blocked=(await observer.query("select wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity where pid=$1 and wait_event_type='Lock'",[pid])).rows[0]
  if(blocked){assert.equal(blocked.wait_event,'advisory');assert.ok(blocked.blockers.includes(holderPid),'必须等待持有该 session context 锁的事务');return}
  assert.equal(outcome(),undefined,'change 不得绕过改派 context 锁完成关联或解除')
  assert.ok(Date.now()<deadline,'change 必须在 pg_stat_activity 中呈现真实 context 锁等待')
  await new Promise(resolve=>setTimeout(resolve,10))
 }
}
async function blockedChange(f:Fixture,command:Fixture['command'],whileBlocked:(holder:PoolClient)=>Promise<void>){
 const holder=await observer.connect()
 let changing:Promise<Outcome>|undefined
 try{
  const pid=Number((await pool.query('select pg_backend_pid() pid')).rows[0].pid)
  await holder.query('begin')
  const holderPid=Number((await holder.query('select pg_backend_pid() pid')).rows[0].pid)
  await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/conversation-work',f.owner,'context:'+f.command.sessionId])])
  let outcome:Outcome|undefined
  changing=f.service.change(f.owner,command).then(value=>({value}),error=>({error})).then(result=>{outcome=result;return result})
  await waitForContextLock(pid,holderPid,()=>outcome)
  await whileBlocked(holder)
  await holder.query('commit')
  return await changing
 }finally{
  await holder.query('rollback');holder.release()
  await changing
 }
}

// 缺少同 session context 锁，或把它放在对象行锁之后，必须让以下真实竞争失败。
for(const kind of ['task','role'] as const){
 for(const action of ['link','unlink'] as const){
  test(`${kind}_${action}_waits_for_reassignment_context`,{timeout:20000},async()=>{
   const f=await fixture(kind)
   if(action==='unlink')await f.service.change(f.owner,f.command)
   const before=await state(f),command={...f.command,requestId:randomUUID(),expectedLinkVersion:action==='unlink'?1:0,action}
   const result=await blockedChange(f,command,async()=>{assert.deepEqual(await state(f),before)})
   if(result.error)throw result.error
   assert.equal(result.value!.active,action==='link');assert.equal(result.value!.version,action==='link'?1:2)
   assert.deepEqual((await state(f)).links,[{version:action==='link'?1:2,active:action==='link'}])
   assert.equal((await state(f)).receipts.length,before.receipts.length+1)
   assert.equal(pool.waitingCount,0)
  })
 }
 test(`${kind}_link_revalidates_session_permission_after_context_wait`,{timeout:20000},async()=>{
  const f=await fixture(kind),before=await state(f)
  const result=await blockedChange(f,f.command,async()=>{f.conversation.ownerId='other';assert.deepEqual(await state(f),before)})
  assert.equal((result.error as {code?:string})?.code,'teloa/forbidden')
  assert.deepEqual(await state(f),before);assert.equal(pool.waitingCount,0)
 })
 test(`${kind}_link_revalidates_object_version_after_context_wait`,{timeout:20000},async()=>{
  const f=await fixture(kind),before=await state(f),table=kind==='task'?'teloa_tasks':'teloa_roles'
  const result=await blockedChange(f,f.command,async()=>{
   await observer.query(`update ${table} set version=version+1 where owner_id=$1 and id=$2`,[f.owner,f.object.id])
   assert.deepEqual(await state(f),before)
  })
  assert.equal((result.error as {code?:string})?.code,'teloa/version-conflict')
  assert.deepEqual(await state(f),before);assert.equal(pool.waitingCount,0)
 })
 test(`${kind}_old_link_replay_returns_unlinked_state_without_reactivation`,{timeout:20000},async()=>{
  const f=await fixture(kind)
  await f.service.change(f.owner,f.command)
  const removed=await f.service.change(f.owner,{...f.command,requestId:randomUUID(),expectedLinkVersion:1,action:'unlink'})
  const before=await state(f)
  // 已有回执仍按原规则返回当前关联，不重新核验原链接动作或恢复 active。
  f.conversation.ownerId='other'
  assert.deepEqual(await f.service.change(f.owner,f.command),removed)
  assert.deepEqual(await state(f),before)
  await assert.rejects(f.service.change(f.owner,{...f.command,action:'unlink'}),{code:'teloa/conflict'})
  assert.deepEqual(await state(f),before)
 })
}
