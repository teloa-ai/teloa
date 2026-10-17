import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import type {Pool as PoolType} from 'pg'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {BusinessScopeService,BusinessSpaceService,RoleService,TaskService,initializeCollaboration,initializeIndustryLoads,initializePlans,initializeProjects,initializeRoles,initializeTasks} from '../src/index.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {initializeBusinessData} from '../src/work/business-data.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

// 新装只从「通用工作」开始；SOC/AppSec 仍是合法旧 ID：已有标签行原样保留，只被员工、资料、项目或业务记录引用也要出现，
// 旧 ID 的写入不被误拒，且在同一写事务里补登记，目录与数据一致。
let container:StartedPostgreSqlContainer,pool:PoolType
before(async()=>{
 if(process.platform==='darwin'&&!process.env.DOCKER_HOST){
  process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
  process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 }
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeIndustryLoads(pool);await initializeTasks(pool);await initializePlans(pool);await initializeCollaboration(pool)
 await initializeProjects(pool);await initializeResources(pool);await initializeBusinessData(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const identity={id:randomUUID,now:()=>new Date().toISOString()}
const spaces=()=>new BusinessSpaceService(pool,identity)
const labels=async(ownerId:string)=>Object.fromEntries((await new BusinessScopeService(pool).list(ownerId)).map(item=>[item.scope,item]))

test('新装引导本人空间只登记通用工作，重跑幂等',async()=>{
 const ownerId='local:fresh-general'
 await spaces().ensurePersonal(ownerId)
 assert.deepEqual(Object.keys(await labels(ownerId)),['general'])
 await spaces().ensurePersonal(ownerId)
 assert.deepEqual(Object.keys(await labels(ownerId)),['general'])
})

test('已有 SOC/AppSec 标签行即使零数据也原样保留，不按计数隐藏',async()=>{
 const ownerId='local:fresh-kept'
 const spaceId=(await spaces().ensurePersonal(ownerId)).id
 for(const [scope,title] of [['SOC','安全运营'],['AppSec','应用安全']] as const)await BusinessScopeService.ensure(pool,ownerId,{scope,title,kind:'builtin',spaceId})
 await spaces().ensurePersonal(ownerId)
 const found=await labels(ownerId)
 assert.deepEqual(Object.keys(found),['general','SOC','AppSec'])
 assert.deepEqual({...found.SOC},{scope:'SOC',title:'安全运营',kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0})
})

test('只被员工、资料、项目或业务记录引用的旧内置业务在引导后可见，原 ID 与标题不变',async()=>{
 const now=new Date().toISOString()
 const cases:[string,string,(ownerId:string)=>Promise<void>][]=[
  ['员工','SOC',async ownerId=>{await new RoleService(pool,identity).create(ownerId,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['SOC'],duty:'核对告警',dataScope:'已授权资料',executionScope:'只读整理',skills:[],knowledge:[],responsibility:testRoleResponsibility}})}],
  ['资料','AppSec',async ownerId=>{await pool.query("insert into teloa_resources(id,owner_id,revision,status,spec,created_at,updated_at) values($1,$2,1,'active',$3,$4,$4)",[randomUUID(),ownerId,{title:'研发安全规范',sourceId:'local',sourceVersion:'1',scopeIds:['AppSec']},now])}],
  ['项目','SOC',async ownerId=>{const definition={title:'告警复盘',scope:'SOC'};await pool.query('insert into teloa_projects(id,owner_id,request_id,request_spec,definition,version,created_at,updated_at) values($1,$2,$3,$4,$4,1,$5,$5)',[randomUUID(),ownerId,randomUUID(),definition,now])}],
  ['业务记录','AppSec',async ownerId=>{await pool.query("insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,'AppSec','repository','gateway',1,$2,'{}','local',$3)",[ownerId,'a'.repeat(64),now])}],
 ]
 for(const [kind,scope,seed] of cases){
  const ownerId='local:fresh-ref-'+randomUUID()
  await seed(ownerId)
  await spaces().ensurePersonal(ownerId)
  const found=await labels(ownerId)
  assert.deepEqual(Object.keys(found),['general',scope],kind+'引用的业务应可见且不额外生成另一个旧业务')
  assert.equal(found[scope]?.kind,'builtin');assert.equal(found[scope]?.title,scope==='SOC'?'安全运营':'应用安全')
 }
})

test('合法旧 ID 写入不被误拒，并在同一写事务内补登记，目录与数据一致',async()=>{
 const ownerId='local:fresh-write'
 await spaces().ensurePersonal(ownerId)
 assert.deepEqual(Object.keys(await labels(ownerId)),['general'])
 assert.equal(await BusinessScopeService.registered(pool,ownerId,'SOC'),true,'纯查询仍放行合法旧 ID')
 assert.deepEqual(Object.keys(await labels(ownerId)),['general'],'纯查询不能隐式写入目录')
 const task=await new TaskService(pool,identity).create(ownerId,{requestId:randomUUID(),fields:{title:'核对告警',goal:'核对来源',scope:'SOC'}})
 assert.equal(task.scope,'SOC')
 const found=await labels(ownerId)
 assert.deepEqual(Object.keys(found),['general','SOC'])
 assert.equal(found.SOC?.tasks,1)
})
