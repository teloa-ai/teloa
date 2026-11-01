import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,type DigitalRole,type ModelOptionsDirectory} from '@teloa/contract'
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {RoleService,initializeRoles} from '../../backend/src/work/roles.ts'
import {initializeCollaboration} from '../../backend/src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../../backend/src/work/group-agent-grants.ts'
import {initializeTasks} from '../../backend/src/work/tasks.ts'
import {initializeTaskRuns} from '../../backend/src/work/task-runs.ts'
import {initializePlans} from '../../backend/src/work/plans.ts'
import {initializePlanOccurrences} from '../../backend/src/work/plan-occurrences.ts'
import {createRoleHandler} from '../src/roles.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri(),connectionTimeoutMillis:5000})
 await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeTasks(pool);await initializeTaskRuns(pool);await initializePlans(pool);await initializePlanOccurrences(pool)
},{timeout:60000})
after(async()=>{await pool?.end();await container?.stop()})
const identity={id:randomUUID,now:()=>new Date().toISOString()},model={provider:'minimax',model:'MiniMax-M3',reasoningEffort:'high'}
const fields={name:'订单核对员',kind:'employee' as const,scopes:['general'],duty:'逐项核对',dataScope:'合成资料',executionScope:'只读',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}
const directory:ModelOptionsDirectory={default:{provider:'minimax',model:'MiniMax-M3'},groups:[{id:'minimax',name:'MiniMax',remote:true,models:[{id:'MiniMax-M3',name:'MiniMax M3',reasoning:{efforts:[{id:'off',name:'Off'},{id:'high',name:'High'}]}}]},{id:'local',name:'Local',remote:false,models:[{id:'small',name:'Small'}]}],failures:[]}
function fixture(){
 const owner=randomUUID();let reads=0,current=directory,failed=false
 const service=new RoleService(pool,identity,undefined,async()=>{reads++;if(failed)throw new WorkError('teloa/source-unavailable','目录读取失败');return current})
 return {owner,service,handle:createRoleHandler(owner,async()=>service),reads:()=>reads,directory:(value:ModelOptionsDirectory)=>{current=value},fail:()=>{failed=true}}
}

test('正式RPC与PG拒绝显示名provider/effort及不可用新模型，不改写输入、不写岗位',async t=>{
 for(const [name,runtimeConfig] of [
  ['provider显示名',{model:{...model,provider:'MiniMax'}}],['effort显示名',{model:{...model,reasoningEffort:'High'}}],
  ['模型显示名',{model:{...model,model:'MiniMax M3'}}],['本机备用',{model,fallbackModel:{provider:'local',model:'small'}}],
  ['相同备用',{model,fallbackModel:{provider:'minimax',model:'MiniMax-M3'}}],
 ] as const)await t.test(name,async()=>{
  const f=fixture(),input={requestId:randomUUID(),fields:{...fields,runtimeConfig}},original=JSON.stringify(input)
  // 带空格的模型名、相同主备已由原字段契约拒绝；其余合法格式须核对当前目录。
  await assert.rejects(f.handle('roles/create',input),{code:name==='模型显示名'||name==='相同备用'?'teloa/invalid-input':'teloa/model-unavailable'})
  assert.deepEqual(await f.service.list(f.owner,{}),[]);assert.equal(JSON.stringify(input),original)
 })
 await t.test('缺凭据和目录失败均不保存',async()=>{
  const f=fixture();f.directory({...directory,groups:directory.groups.map(group=>({...group,credentialMissing:true as const}))})
  await assert.rejects(f.handle('roles/create',{requestId:randomUUID(),fields:{...fields,runtimeConfig:{model}}}),{code:'teloa/model-unavailable'})
  f.fail();await assert.rejects(f.handle('roles/create',{requestId:randomUUID(),fields:{...fields,runtimeConfig:{model}}}),{code:'teloa/source-unavailable'})
  assert.deepEqual(await f.service.list(f.owner,{}),[])
 })
})

test('正式RPC合法模型原样保存；并发同请求及目录失效后的回执恢复不重验',async()=>{
 const f=fixture(),input={requestId:randomUUID(),fields:{...fields,runtimeConfig:{model}}}
 const [first,duplicate]=await Promise.all([f.handle('roles/create',input),f.handle('roles/create',input)]) as DigitalRole[]
 assert.equal(first!.id,duplicate!.id);assert.deepEqual(first!.runtimeConfig,{model});assert.equal(f.reads(),1)
 f.fail();assert.deepEqual(await f.handle('roles/create',input),first);assert.equal(f.reads(),1)
 await assert.rejects(f.handle('roles/create',{...input,fields:{...input.fields,duty:'不同请求'}}),{code:'teloa/conflict'})
 const inherited=await f.handle('roles/create',{requestId:randomUUID(),fields}) as DigitalRole
 assert.equal(inherited.runtimeConfig,undefined);assert.equal(f.reads(),1,'未选模型继承默认，不因目录故障阻止保存')
})

test('原失效模型可保留修改职责；明确改选必须精确验效，编辑回执不受后来目录失败影响',async()=>{
 const f=fixture(),old={...model,provider:'MiniMax',reasoningEffort:'High'},id=randomUUID(),now=new Date()
 // 合成历史脏配置，复现修复前已保存的数据；不通过新增准入伪造一笔“新建成功”。
 const saved={...fields,runtimeConfig:{model:old}}
 await pool.query("insert into teloa_roles(id,owner_id,request_id,request_spec,definition,version,state,created_at,updated_at) values($1,$2,$3,$4,$4,1,'paused',$5,$5)",[id,f.owner,randomUUID(),JSON.stringify(saved),now])
 const unchanged=await f.handle('roles/edit',{roleId:id,expectedVersion:1,fields:{...saved,duty:'更新核对职责'}}) as DigitalRole
 assert.deepEqual(unchanged.runtimeConfig,{model:old});assert.equal(f.reads(),0)
 await assert.rejects(f.handle('roles/edit',{roleId:id,expectedVersion:2,fields:{...saved,runtimeConfig:{model:{...model,reasoningEffort:'High'}}}}),{code:'teloa/model-unavailable'})
 assert.equal((await f.service.get(f.owner,id))?.version,2)
 const edit={roleId:id,expectedVersion:2,fields:{...saved,duty:'更新核对职责',runtimeConfig:{model}}}
 const fixed=await f.handle('roles/edit',edit) as DigitalRole;assert.deepEqual(fixed.runtimeConfig,{model});const before=f.reads()
 f.fail();assert.deepEqual(await f.handle('roles/edit',edit),fixed);assert.equal(f.reads(),before)
 const other=await f.handle('roles/edit',{roleId:id,expectedVersion:fixed.version,fields:{...edit.fields,duty:'仅修改职责'}}) as DigitalRole
 assert.deepEqual(other.runtimeConfig,{model});assert.equal(f.reads(),before)
 await assert.rejects(f.handle('roles/edit',{roleId:id,expectedVersion:other.version,fields:{...edit.fields,runtimeConfig:{model:{...model,reasoningEffort:'off'}}}}),{code:'teloa/source-unavailable'})
 const inherited=await f.handle('roles/edit',{roleId:id,expectedVersion:other.version,fields}) as DigitalRole
 assert.equal(inherited.runtimeConfig,undefined,'本人明确清除模型可恢复默认，不偷换原选择')
})
