import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError} from '@teloa/contract'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {initializeWebAccessPolicy,TaskRunWebAccessService,WebAccessPolicyService,webAccessPolicyDefaults} from '../src/work/web-access.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
/** 八个正式码，逐字抄自 `packages/contract/src/work-error.ts:1-10`。本文件抛出的每个错误都必须落在这八个里。 */
const formalCodes=['teloa/invalid-input','teloa/forbidden','teloa/version-conflict','teloa/conflict','teloa/dependency-unavailable','teloa/storage-corrupt','teloa/source-unavailable','teloa/invalid-host-response']

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool)
 // 运行内上网记录表由 `initializeTaskRuns` 的链式初始化带出，这里刻意不单独调用，钉住那条链。
 await initializeTaskRuns(pool);await initializeWebAccessPolicy(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

/** 断言抛出的是 `WorkError`、码在八码之内、且没有 `details`。 */
async function rejects(promise:Promise<unknown>,code:string){
 await assert.rejects(promise,(error:unknown)=>{
  assert.ok(error instanceof WorkError,'不是 WorkError：'+String(error))
  assert.ok(formalCodes.includes(error.code),'用了八码之外的错误码：'+error.code)
  assert.equal(error.code,code)
  assert.equal((error as {details?:unknown}).details,undefined)
  return true
 })
}

async function runFixture(){
 const owner=randomUUID()
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'资料岗',kind:'employee',scopes:['general'],duty:'资料检索',dataScope:'范围内',executionScope:'受管',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},runtimeConfig:{agentPresetId:'teloa-standard'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'检索任务',goal:'验证上网记录',scope:'general'},assignee:{roleId:role.id,expectedVersion:2}})
 const sessionId='parent_'+randomUUID().replaceAll('-',''),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect)
 const prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1})
 const claimed=await runs.claim(owner,{runId:prepared.id})
 return {owner,runId:claimed.run.id}
}

test('空库读策略回出厂值，且不写入任何行',async()=>{
 const owner=randomUUID(),service=new WebAccessPolicyService(pool,identity.now)
 assert.deepEqual(await service.get(owner,{}),{version:0,enabled:true,blocked:[]})
 assert.deepEqual(webAccessPolicyDefaults,{version:0,enabled:true,blocked:[]})
 // 出厂值连同内层数组一起冻结：调用方拿到的 blocked 是副本，改不脏它。
 assert.ok(Object.isFrozen(webAccessPolicyDefaults)&&Object.isFrozen(webAccessPolicyDefaults.blocked))
 const fetched=await service.get(owner,{});fetched.blocked.push('example.com')
 assert.deepEqual(webAccessPolicyDefaults.blocked,[])
 assert.equal((await pool.query('select * from teloa_web_access_policy where owner_id=$1',[owner])).rowCount,0)
 await rejects(service.get(owner,{unknown:1}),'teloa/invalid-input')
 await rejects(service.get('',{}),'teloa/forbidden')
})

test('改写提升版本；同请求同内容重放回原回执，同版本不同内容与落后版本都判版本冲突',async()=>{
 const owner=randomUUID(),service=new WebAccessPolicyService(pool,identity.now)
 const requestId=randomUUID(),command={requestId,expectedVersion:0,enabled:false,blocked:['example.com']}
 const saved=await service.change(owner,command)
 assert.deepEqual(saved,{version:1,enabled:false,blocked:['example.com']})
 assert.deepEqual(await service.get(owner,{}),saved)
 assert.deepEqual(await service.change(owner,command),saved)
 assert.equal((await pool.query('select * from teloa_web_access_policy where owner_id=$1',[owner])).rowCount,1)
 // 别的请求抢下了同一个 base_version：版本冲突。
 await rejects(service.change(owner,{requestId:randomUUID(),expectedVersion:0,enabled:true,blocked:[]}),'teloa/version-conflict')
 // 同一个 requestId 换内容、或换版本：请求冲突，与 unique(owner_id,request_id) 同口径。
 await rejects(service.change(owner,{...command,enabled:true}),'teloa/conflict')
 await rejects(service.change(owner,{...command,blocked:['other.example.com']}),'teloa/conflict')
 await rejects(service.change(owner,{requestId,expectedVersion:1,enabled:false,blocked:['example.com']}),'teloa/conflict')
 const second=await service.change(owner,{requestId:randomUUID(),expectedVersion:1,enabled:true,blocked:[]})
 assert.deepEqual(second,{version:2,enabled:true,blocked:[]})
 assert.deepEqual(await service.get(owner,{}),second)
})

test('拦截名单格式与未知键一律拒绝，跨本人读写都拒绝',async()=>{
 const owner=randomUUID(),service=new WebAccessPolicyService(pool,identity.now)
 const base={requestId:randomUUID(),expectedVersion:0,enabled:true}
 for(const blocked of [
  Array.from({length:129},(_,index)=>'h'+index+'.example.com'),
  ['http://example.com'],['example.com/path'],['EXAMPLE.com'],['127.0.0.1'],
  ['example.com','example.com'],['example.com:8080'],['.example.com'],
 ])await rejects(service.change(owner,{...base,blocked}),'teloa/invalid-input')
 await rejects(service.change(owner,{...base,blocked:[],extra:1}),'teloa/invalid-input')
 await rejects(service.change(owner,{requestId:'not-a-uuid',expectedVersion:0,enabled:true,blocked:[]}),'teloa/invalid-input')
 await rejects(service.change(owner,{...base,expectedVersion:-1,blocked:[]}),'teloa/invalid-input')
 await service.change(owner,{...base,blocked:['example.com']})
 await rejects(service.get('',{}),'teloa/forbidden')
 await rejects(service.change('',{requestId:randomUUID(),expectedVersion:0,enabled:true,blocked:[]}),'teloa/forbidden')
 // 另一位本人读不到这一位的策略，只会拿到出厂值。
 assert.deepEqual(await service.get(randomUUID(),{}),webAccessPolicyDefaults)
})

test('策略行损坏时读写都报存储损坏；jsonb 数组判据本身挡住非数组',async()=>{
 const owner=randomUUID(),service=new WebAccessPolicyService(pool,identity.now)
 await service.change(owner,{requestId:randomUUID(),expectedVersion:0,enabled:true,blocked:['example.com']})
 await assert.rejects(pool.query(`update teloa_web_access_policy set blocked='"x"'::jsonb where owner_id=$1`,[owner]),/blocked/)
 await pool.query(`update teloa_web_access_policy set blocked='["EXAMPLE.COM"]'::jsonb where owner_id=$1`,[owner])
 await rejects(service.get(owner,{}),'teloa/storage-corrupt')
 await rejects(service.change(owner,{requestId:randomUUID(),expectedVersion:1,enabled:false,blocked:[]}),'teloa/storage-corrupt')
})

test('运行内上网记录只追加：seq 连续、跨 run 各自从 1 起、并发不撞主键',async()=>{
 const {owner,runId}=await runFixture(),other=await runFixture(),service=new TaskRunWebAccessService(pool,identity)
 const written=[]
 for(let index=1;index<=5;index++)written.push(await service.append(owner,runId,{kind:index%2?'search':'fetch',value:'第'+index+'条'}))
 assert.deepEqual(written.map(entry=>entry.kind),['search','fetch','search','fetch','search'])
 assert.deepEqual((await pool.query('select seq from teloa_task_run_web_access where owner_id=$1 and run_id=$2 order by seq',[owner,runId])).rows.map(row=>row.seq),[1,2,3,4,5])
 const crossed=await service.append(other.owner,other.runId,{kind:'fetch',value:'https://example.com/'})
 assert.deepEqual(crossed,{kind:'fetch',value:'https://example.com/',at:crossed.at})
 assert.deepEqual((await pool.query('select seq from teloa_task_run_web_access where owner_id=$1 and run_id=$2',[other.owner,other.runId])).rows.map(row=>row.seq),[1])
 const racing=await Promise.all([service.append(owner,runId,{kind:'search',value:'并发甲'}),service.append(owner,runId,{kind:'search',value:'并发乙'})])
 assert.equal(racing.length,2)
 const seqs=(await pool.query('select seq from teloa_task_run_web_access where owner_id=$1 and run_id=$2 order by seq',[owner,runId])).rows.map(row=>row.seq)
 assert.deepEqual(seqs,[1,2,3,4,5,6,7])
 const listed=await service.listMany(owner,[runId])
 assert.equal(listed.get(runId)?.length,7)
 assert.deepEqual(listed.get(runId)?.slice(0,5).map(entry=>entry.value),['第1条','第2条','第3条','第4条','第5条'])
 assert.deepEqual(listed.get(runId)?.slice(5).map(entry=>entry.value).sort(),['并发乙','并发甲'].sort())
 assert.equal((await service.listMany(owner,[])).size,0)
 await rejects(service.listMany(owner,[randomUUID()]),'teloa/forbidden')
 await rejects(service.listMany(owner,['not-a-uuid']),'teloa/invalid-input')
})

test('外键与入参：不存在的 run、跨本人、非法 kind 与空值都按八码拒绝',async()=>{
 const {owner,runId}=await runFixture(),service=new TaskRunWebAccessService(pool,identity)
 await rejects(service.append(owner,randomUUID(),{kind:'search',value:'无主'}),'teloa/forbidden')
 await rejects(service.append(randomUUID(),runId,{kind:'search',value:'他人'}),'teloa/forbidden')
 await rejects(service.append(owner,'not-a-uuid',{kind:'search',value:'坏身份'}),'teloa/invalid-input')
 await rejects(service.append(owner,runId,{kind:'browse' as never,value:'未知类别'}),'teloa/invalid-input')
 await rejects(service.append(owner,runId,{kind:'search',value:''}),'teloa/invalid-input')
 await rejects(service.append('',runId,{kind:'search',value:'无身份'}),'teloa/forbidden')
})

test('超长外发按码点截断到 512 落库，且不违反长度判据',async()=>{
 const {owner,runId}=await runFixture(),service=new TaskRunWebAccessService(pool,identity)
 const entry=await service.append(owner,runId,{kind:'fetch',value:'x'.repeat(600)})
 assert.equal(entry.value.length,512)
 assert.equal((await pool.query('select length(value) as size from teloa_task_run_web_access where owner_id=$1 and run_id=$2 and seq=1',[owner,runId])).rows[0].size,512)
 // 代理对整个留或整个丢，不切出半个字符；边界按更紧的那条判据（契约数 UTF-16 码元）收，落库码点数因此是 256。
 const wide=await service.append(owner,runId,{kind:'search',value:'𝌆'.repeat(600)})
 assert.equal(wide.value,'𝌆'.repeat(256))
 assert.equal(wide.value.length,512)
 assert.equal((await pool.query('select length(value) as size from teloa_task_run_web_access where owner_id=$1 and run_id=$2 and seq=2',[owner,runId])).rows[0].size,256)
})

test('运行记录表在 DB 层不可变：直接 update 或 delete 都被触发器拒',async()=>{
 const {owner,runId}=await runFixture(),service=new TaskRunWebAccessService(pool,identity)
 await service.append(owner,runId,{kind:'search',value:'原件'})
 await assert.rejects(pool.query('update teloa_task_run_web_access set value=$3 where owner_id=$1 and run_id=$2',[owner,runId,'改过']),/只追加/)
 await assert.rejects(pool.query('delete from teloa_task_run_web_access where owner_id=$1 and run_id=$2',[owner,runId]),/只追加/)
 assert.equal((await pool.query('select value from teloa_task_run_web_access where owner_id=$1 and run_id=$2',[owner,runId])).rows[0].value,'原件')
})

test('运行记录服务只有追加与读取两个方法，没有更新或删除',()=>{
 const methods=Object.getOwnPropertyNames(TaskRunWebAccessService.prototype).filter(name=>name!=='constructor')
 assert.deepEqual(methods.sort(),['append','listMany'])
 const service=new TaskRunWebAccessService(pool,identity)
 for(const name of ['update','delete','remove','clear','prune'])assert.equal((service as unknown as Record<string,unknown>)[name],undefined)
})

test('事务内读口与 get 同答，且不从池里再取一条连接',async()=>{
 const owner=randomUUID(),service=new WebAccessPolicyService(pool,identity.now)
 const client=await pool.connect()
 try{
  // 把池占到只剩这一条：事务内若再 `pool.query` 一次就会卡到 connectionTimeoutMillis，
  // 这里的 `getInTransaction` 必须只用调用方给的那条连接。
  await client.query('begin')
  assert.deepEqual(await service.getInTransaction(client,owner),{version:0,enabled:true,blocked:[]})
  await service.change(owner,{requestId:randomUUID(),expectedVersion:0,enabled:false,blocked:['example.com']})
  // 同一条事务内再读：判据与 `get` 逐字同一条 SQL，答案也必须一致。
  assert.deepEqual(await service.getInTransaction(client,owner),await service.get(owner,{}))
  assert.deepEqual(await service.getInTransaction(client,owner),{version:1,enabled:false,blocked:['example.com']})
  await client.query('commit')
 }catch(error){await client.query('rollback');throw error}finally{client.release()}
 // 损坏判据也是同一份：事务内读到坏行照样 fail-closed，不做就地修补。
 await pool.query(`update teloa_web_access_policy set blocked='["EXAMPLE.COM"]'::jsonb where owner_id=$1`,[owner])
 const second=await pool.connect()
 try{await rejects(service.getInTransaction(second,owner),'teloa/storage-corrupt')}finally{second.release()}
 await rejects(service.getInTransaction(pool,''),'teloa/forbidden')
})
