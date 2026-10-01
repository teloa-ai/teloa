import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeBusinessSyncRules,BusinessSyncRuleService} from '../src/work/business-sync-rules.ts'
import {initializeBusinessSpaces,BusinessSpaceService} from '../src/work/business-spaces.ts'
import {initializeBusinessRuntime,BusinessRuntimeService,lockBusinessRuntime} from '../src/work/business-runtime.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const now='2026-09-30T08:00:00.000Z',hashA='a'.repeat(64),hashB='b'.repeat(64)
const identity={id:randomUUID,now:()=>now}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeBusinessSpaces(pool)
 await initializeBusinessRuntime(pool)
 await initializeBusinessSyncRules(pool)
 await initializeBusinessSyncRules(pool)
 await pool.query('create table test_sync_rule_definitions(owner_id text,scope_id text,mapping_id text,definition_hash text,primary key(owner_id,scope_id,mapping_id))')
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(managed:boolean){
 const ownerId='rule:'+randomUUID(),scope='SOC',mappingId='alerts'
 const actor={ownerId,scopeIds:[scope]}
 await new BusinessSpaceService(pool,identity).ensurePersonal(ownerId)
 if(managed){
  const db=await pool.connect()
  try{await db.query('begin');await new BusinessRuntimeService(pool,identity).registerInTransaction(db,ownerId,scope);await db.query('commit')}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 await pool.query('insert into test_sync_rule_definitions values($1,$2,$3,$4)',[ownerId,scope,mappingId,hashA])
 const resolve=async(db:PoolClient,owner:string,scopeId:string,id:string)=>{
  const row=(await db.query(`select d.definition_hash,s.runtime_managed from test_sync_rule_definitions d
    join teloa_business_scopes s on s.owner_id=d.owner_id and s.scope=d.scope_id
    where d.owner_id=$1 and d.scope_id=$2 and d.mapping_id=$3`,[owner,scopeId,id])).rows[0]
  return row?{definitionHash:row.definition_hash as string,managed:row.runtime_managed as boolean}:undefined
 }
 const service=new BusinessSyncRuleService(pool,identity,resolve)
 const set=(enabled:boolean,expectedRevision:number,requestId=randomUUID())=>service.set(actor,{scope,mappingId,enabled,expectedRevision,requestId})
 const current=()=>service.get(actor,{scope,mappingId})
 const allowed=async(expectedRevision?:number,expectedHash?:string)=>{
  const db=await pool.connect()
  try{return await service.assertEnabled(db,ownerId,scope,mappingId,expectedRevision,expectedHash)}finally{db.release()}
 }
 return {ownerId,scope,mappingId,actor,service,resolve,set,current,allowed}
}

test('受管规则未明确启用不会到期；旧未受管映射保留启用语义',async()=>{
 const managed=await fixture(true),legacy=await fixture(false)
 assert.deepEqual(await managed.current(),{scope:'SOC',mappingId:'alerts',definitionHash:hashA,enabled:false,revision:0})
 await assert.rejects(managed.allowed(),{code:'teloa/conflict'})
 assert.deepEqual(await legacy.current(),{scope:'SOC',mappingId:'alerts',definitionHash:hashA,enabled:true,revision:0})
 assert.equal((await legacy.allowed()).enabled,true)
})

test('启用、暂停与重启复查同一持久状态；旧 tick 修订不能越过暂停再启用',async()=>{
 const h=await fixture(true)
 const enabled=await h.set(true,0)
 assert.deepEqual(enabled,{scope:'SOC',mappingId:'alerts',definitionHash:hashA,enabled:true,revision:1})
 assert.equal((await h.allowed(1,hashA)).enabled,true)
 const paused=await h.set(false,1)
 assert.equal(paused.enabled,false)
 await assert.rejects(h.allowed(1,hashA),{code:'teloa/conflict'})
 const reloaded=new BusinessSyncRuleService(pool,identity,h.resolve)
 assert.deepEqual(await reloaded.get(h.actor,{scope:h.scope,mappingId:h.mappingId}),paused)
 await h.set(true,2)
 await assert.rejects(h.allowed(1,hashA),{code:'teloa/conflict'})
 assert.equal((await h.allowed(3,hashA)).enabled,true)
})

test('声明摘要变化撤销旧启用；未能核对当前声明时关闭执行',async()=>{
 const h=await fixture(true)
 await h.set(true,0)
 await pool.query('update test_sync_rule_definitions set definition_hash=$4 where owner_id=$1 and scope_id=$2 and mapping_id=$3',[h.ownerId,h.scope,h.mappingId,hashB])
 assert.deepEqual(await h.current(),{scope:'SOC',mappingId:'alerts',definitionHash:hashB,enabled:false,revision:1})
 await assert.rejects(h.allowed(1,hashA),{code:'teloa/conflict'})
 assert.equal((await h.set(true,1)).definitionHash,hashB)
 await assert.rejects(h.allowed(2,hashA),{code:'teloa/conflict'})
 await pool.query('update test_sync_rule_definitions set definition_hash=$4 where owner_id=$1 and scope_id=$2 and mapping_id=$3',[h.ownerId,h.scope,h.mappingId,'bad'])
 await assert.rejects(h.current(),{code:'teloa/storage-corrupt'})
 await assert.rejects(h.allowed(),{code:'teloa/storage-corrupt'})
})

test('启停请求按身份幂等，过期修订、同请求异内容及越权均拒绝',async()=>{
 const h=await fixture(true),requestId=randomUUID()
 const first=await h.set(true,0,requestId)
 assert.deepEqual(await h.set(true,0,requestId),first)
 await assert.rejects(h.set(false,0,requestId),{code:'teloa/conflict'})
 await assert.rejects(h.set(false,0),{code:'teloa/conflict'})
 await assert.rejects(h.service.set({ownerId:h.ownerId,scopeIds:[]},{scope:h.scope,mappingId:h.mappingId,enabled:false,expectedRevision:1,requestId:randomUUID()}),{code:'teloa/forbidden'})
 assert.deepEqual(await h.current(),first)
})

test('暂停事务等候在途来源调用共享锁，落定后后续检查拒绝旧修订',async()=>{
 const h=await fixture(true)
 await h.set(true,0)
 const db=await pool.connect()
 try{
  await db.query('begin')
  await lockBusinessRuntime(db,h.ownerId,h.scope,'shared')
  const pending=h.set(false,1)
  let settled=false
  void pending.then(()=>{settled=true},()=>{settled=true})
  await new Promise(resolve=>setTimeout(resolve,50))
  assert.equal(settled,false)
  await db.query('commit')
  await pending
  await assert.rejects(h.allowed(1,hashA),{code:'teloa/conflict'})
 }finally{await db.query('rollback').catch(()=>{});db.release()}
})
