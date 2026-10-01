import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {BusinessSpaceService,initializeBusinessSpaces} from '../src/work/business-spaces.ts'
import * as backend from '../src/index.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>'2026-09-29T10:00:00.000Z'}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeBusinessSpaces(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
async function setup(){
 await backend.initializeBusinessRuntime(pool)
 const ownerId='runtime:'+randomUUID(),actor={ownerId,scopeIds:['SOC','AppSec']}
 await new BusinessSpaceService(pool,identity).ensurePersonal(ownerId)
 const service=new backend.BusinessRuntimeService(pool,identity)
 const db=await pool.connect()
 try{await db.query('begin');await service.registerInTransaction(db,ownerId,'SOC');await db.query('commit')}
 catch(error){await db.query('rollback');throw error}finally{db.release()}
 return {ownerId,actor,service}
}
test('受管登记需真实范围，同事务回滚，幂等保留状态与注入时间',async()=>{
 const h=await setup(),db=await pool.connect()
 assert.deepEqual(await h.service.get(h.actor,'SOC'),{scope:'SOC',managed:true,syncEnabled:false,revision:1})
 await assert.rejects(h.service.get({...h.actor,scopeIds:[]},'SOC'),{code:'teloa/forbidden'})
 await assert.rejects(h.service.get(h.actor,'general'),{code:'teloa/invalid-input'})
 try{
  await db.query('begin')
  await assert.rejects(h.service.registerInTransaction(db,h.ownerId,'missing'),{code:'teloa/invalid-input'})
  await db.query('rollback')
  await db.query('begin')
  await h.service.registerInTransaction(db,h.ownerId,'AppSec')
  await db.query('rollback')
  assert.deepEqual(await h.service.get(h.actor,'AppSec'),{scope:'AppSec',managed:false,syncEnabled:true,revision:0})
  const changed=await h.service.setSync(h.actor,{scope:'SOC',enabled:true,expectedRevision:1,requestId:randomUUID()})
  await db.query('begin')
  assert.deepEqual(await h.service.registerInTransaction(db,h.ownerId,'SOC'),changed)
  await db.query('commit')
  assert.equal((await pool.query('select updated_at from teloa_business_runtime where owner_id=$1',[h.ownerId])).rows[0].updated_at.toISOString(),identity.now())
 }finally{await db.query('rollback');db.release()}
})

test('启停回执跨重建幂等，过期版本与异内容冲突，不修改 legacy 或他人状态',async()=>{
 const h=await setup(),request={scope:'SOC',enabled:true,expectedRevision:1,requestId:randomUUID()}
 const result=await h.service.setSync(h.actor,request)
 assert.deepEqual(result,{scope:'SOC',managed:true,syncEnabled:true,revision:2})
 await assert.rejects(h.service.setSync(h.actor,{...request,enabled:false}),{code:'teloa/conflict'})
 await assert.rejects(h.service.setSync(h.actor,{...request,requestId:randomUUID()}),{code:'teloa/conflict'})
 const paused=await h.service.setSync(h.actor,{scope:'SOC',enabled:false,expectedRevision:2,requestId:randomUUID()})
 const restored=new backend.BusinessRuntimeService(pool,identity)
 assert.deepEqual(await restored.setSync(h.actor,request),result)
 assert.deepEqual(await restored.get(h.actor,'SOC'),paused)
 await assert.rejects(restored.setSync(h.actor,{...request,scope:'AppSec',requestId:randomUUID()}),{code:'teloa/invalid-input'})
 await assert.rejects(restored.setSync({...h.actor,scopeIds:['AppSec']},request),{code:'teloa/forbidden'})
 assert.deepEqual(await restored.get({ownerId:'other',scopeIds:['SOC']},'SOC'),{scope:'SOC',managed:false,syncEnabled:true,revision:0})
 assert.equal((await pool.query('select runtime_managed from teloa_business_scopes where owner_id=$1 and scope=$2',[h.ownerId,'SOC'])).rows[0].runtime_managed,true)
})

test('并发同请求只有一个修订，跨范围复用 requestId 拒绝',async()=>{
 const h=await setup(),request={scope:'SOC',enabled:true,expectedRevision:1,requestId:randomUUID()}
 const results=await Promise.all([h.service.setSync(h.actor,request),h.service.setSync(h.actor,request)])
 assert.deepEqual(results[0],results[1])
 assert.equal(results[0]!.revision,2)
 await assert.rejects(h.service.setSync(h.actor,{...request,scope:'AppSec'}),{code:'teloa/conflict'})
})

test('受管缺行或标记反转 fail closed，登记不能修复损坏为默认值',async()=>{
 const h=await setup()
 await pool.query("delete from teloa_business_runtime where owner_id=$1",[h.ownerId])
 await assert.rejects(h.service.get(h.actor,'SOC'),{code:'teloa/storage-corrupt'})
 const db=await pool.connect()
 try{await db.query('begin');await assert.rejects(h.service.registerInTransaction(db,h.ownerId,'SOC'),{code:'teloa/storage-corrupt'});await db.query('rollback')}finally{db.release()}
 const second=await setup()
 await pool.query('update teloa_business_scopes set runtime_managed=false where owner_id=$1',[second.ownerId])
 await assert.rejects(second.service.get(second.actor,'SOC'),{code:'teloa/storage-corrupt'})
})

test('旧最小库无运行表但明确未受管继续兼容，受管缺表或非法状态拒绝',async()=>{
 const db=await pool.connect()
 try{
  await db.query('begin')
  await db.query('create schema runtime_minimal')
  await db.query('set local search_path to runtime_minimal')
  await db.query('create table teloa_business_scopes(owner_id text,scope text,runtime_managed boolean)')
  await db.query("insert into teloa_business_scopes values('owner','SOC',false)")
  assert.equal(await backend.scheduledSyncAllowed(db,'owner','SOC'),true)
  await db.query("update teloa_business_scopes set runtime_managed=true")
  await assert.rejects(backend.scheduledSyncAllowed(db,'owner','SOC'),{code:'teloa/storage-corrupt'})
  await db.query('create table teloa_business_runtime(owner_id text,scope_id text,sync_enabled jsonb,revision double precision)')
  for(const [enabled,revision] of [['null',1],['true',0],['true',1.5]]){
   await db.query('delete from teloa_business_runtime')
   await db.query("insert into teloa_business_runtime values('owner','SOC',$1,$2)",[enabled,revision])
   await assert.rejects(backend.scheduledSyncAllowed(db,'owner','SOC'),{code:'teloa/storage-corrupt'})
  }
  await db.query('delete from teloa_business_runtime')
  await db.query('update teloa_business_scopes set runtime_managed=null')
  await assert.rejects(backend.scheduledSyncAllowed(db,'owner','SOC'),{code:'teloa/storage-corrupt'})
  await db.query('rollback')
 }finally{await db.query('rollback');db.release()}
})

test('升级已有空间与范围只补身份列，旧范围不自动登记或开启受管同步',async()=>{
 const db=await pool.connect()
 try{
  await db.query('begin')
  await db.query('create schema runtime_upgrade')
  await db.query('set local search_path to runtime_upgrade')
  await db.query('create table teloa_business_spaces(id uuid primary key,owner_id text not null,name text not null,description text not null,version integer not null,created_at timestamptz not null,updated_at timestamptz not null,unique(id,owner_id))')
  await db.query('create table teloa_business_scopes(owner_id text not null,space_id uuid not null,scope text not null,title text not null,kind text not null,created_at timestamptz not null,primary key(owner_id,scope),foreign key(space_id,owner_id) references teloa_business_spaces(id,owner_id))')
  const id=randomUUID()
  await db.query("insert into teloa_business_spaces values($1,'old','旧空间','',1,now(),now())",[id])
  await db.query("insert into teloa_business_scopes values('old',$1,'SOC','旧业务','builtin',now())",[id])
  await initializeBusinessSpaces(db as unknown as Pool)
  await backend.initializeBusinessRuntime(db as unknown as Pool)
  await backend.initializeBusinessRuntime(db as unknown as Pool)
  assert.equal((await db.query('select runtime_managed from teloa_business_scopes')).rows[0].runtime_managed,false)
  assert.equal((await db.query('select * from teloa_business_runtime')).rowCount,0)
  assert.equal(await backend.scheduledSyncAllowed(db,'old','SOC'),true)
  await db.query('rollback')
 }finally{await db.query('rollback');db.release()}
})

test('运行回执损坏不能伪造幂等结果',async()=>{
 const h=await setup(),input={scope:'SOC',enabled:true,expectedRevision:1,requestId:randomUUID()}
 await h.service.setSync(h.actor,input)
 await pool.query("update teloa_business_runtime_requests set result=jsonb_set(result,'{revision}','5') where owner_id=$1",[h.ownerId])
 await assert.rejects(h.service.setSync(h.actor,input),{code:'teloa/storage-corrupt'})
})
