import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import type {Pool as PoolType} from 'pg'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {BusinessSpaceService,initializeBusinessSpaces,initializeIndustryLoads,readEdition} from '../src/index.ts'

let container:StartedPostgreSqlContainer,pool:PoolType
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 // 只调加载初始化：既有测试就是这么建库的，`kind` 列与唯一索引必须随之到位。
 await initializeIndustryLoads(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const identity={id:randomUUID,now:()=>new Date().toISOString()}
const service=()=>new BusinessSpaceService(pool,identity)
const insertSpace=async(ownerId:string,name:string,createdAt:string)=>{
 const id=randomUUID()
 await pool.query("insert into teloa_business_spaces(id,owner_id,name,description,version,created_at,updated_at,kind) values($1,$2,$3,'',1,$4,$4,'team')",[id,ownerId,name,createdAt])
 return id
}
const spaces=async(ownerId:string)=>(await pool.query('select id,kind from teloa_business_spaces where owner_id=$1 order by created_at,id',[ownerId])).rows as Array<{id:string;kind:string}>
const edits=async(ownerId:string)=>(await pool.query('select * from teloa_business_space_edits where owner_id=$1',[ownerId])).rows

test('空库引导出唯一的本人空间，重跑幂等',async()=>{
 const ownerId='local:space-empty'
 const created=await service().ensurePersonal(ownerId)
 assert.equal(created.name,'我的工作空间');assert.equal(created.description,'');assert.equal(created.kind,'personal');assert.equal(created.version,1)
 assert.equal(created.createdAt,created.updatedAt)
 const again=await service().ensurePersonal(ownerId)
 assert.deepEqual(again,created)
 assert.deepEqual(await spaces(ownerId),[{id:created.id,kind:'personal'}])
})

test('存量一个空间：原地标为本人空间，不新建也不改版本',async()=>{
 const ownerId='local:space-one'
 const id=await insertSpace(ownerId,'安全运营','2026-09-01T00:00:00.000Z')
 const result=await service().ensurePersonal(ownerId)
 assert.equal(result.id,id);assert.equal(result.kind,'personal');assert.equal(result.name,'安全运营');assert.equal(result.version,1)
 assert.deepEqual(await spaces(ownerId),[{id,kind:'personal'}])
})

test('存量多个空间：最早创建的一行成为本人空间，其余保持 team 且加载归属不动',async()=>{
 const ownerId='local:space-many'
 const earliest=await insertSpace(ownerId,'最早的空间','2026-08-01T00:00:00.000Z')
 const middle=await insertSpace(ownerId,'后来的空间','2026-08-15T00:00:00.000Z')
 const latest=await insertSpace(ownerId,'最新的空间','2026-09-01T00:00:00.000Z')
 const result=await service().ensurePersonal(ownerId)
 assert.equal(result.id,earliest);assert.equal(result.name,'最早的空间')
 assert.deepEqual(await spaces(ownerId),[{id:earliest,kind:'personal'},{id:middle,kind:'team'},{id:latest,kind:'team'}])
})

test('并发引导只落一个本人空间',async()=>{
 const ownerId='local:space-concurrent'
 const results=await Promise.all([1,2,3,4,5].map(()=>service().ensurePersonal(ownerId)))
 for(const result of results)assert.equal(result.id,results[0]!.id)
 assert.deepEqual(await spaces(ownerId),[{id:results[0]!.id,kind:'personal'}])
})

test('尚未引导时读本人空间显式失败，引导后可读',async()=>{
 const ownerId='local:space-current'
 await assert.rejects(service().current(ownerId),{code:'teloa/dependency-unavailable'})
 const created=await service().ensurePersonal(ownerId)
 assert.deepEqual(await service().current(ownerId),created)
})

test('改名：版本加一、时间推进并留下回执',async()=>{
 const ownerId='local:space-rename'
 const created=await service().ensurePersonal(ownerId)
 const requestId=randomUUID()
 const renamed=await service().rename(ownerId,{requestId,expectedVersion:1,name:'我的安全工作台',description:'个人版单空间'})
 assert.equal(renamed.id,created.id);assert.equal(renamed.name,'我的安全工作台');assert.equal(renamed.description,'个人版单空间')
 assert.equal(renamed.version,2);assert.equal(renamed.kind,'personal');assert.equal(renamed.createdAt,created.createdAt)
 const receipts=await edits(ownerId)
 assert.equal(receipts.length,1)
 assert.equal(receipts[0]!.request_id,requestId);assert.equal(receipts[0]!.space_id,created.id)
 assert.deepEqual(receipts[0]!.request_spec,{expectedVersion:1,name:'我的安全工作台',description:'个人版单空间'})
})

test('同一改名请求重放返回同一记录，换了内容即冲突',async()=>{
 const ownerId='local:space-replay'
 await service().ensurePersonal(ownerId)
 const requestId=randomUUID(),input={requestId,expectedVersion:1,name:'重放空间',description:'第一次'}
 const first=await service().rename(ownerId,input)
 assert.deepEqual(await service().rename(ownerId,{...input}),first)
 await assert.rejects(service().rename(ownerId,{...input,name:'换个名字'}),{code:'teloa/conflict'})
 await assert.rejects(service().rename(ownerId,{...input,expectedVersion:2}),{code:'teloa/conflict'})
 assert.equal((await edits(ownerId)).length,1)
 assert.deepEqual(await service().current(ownerId),first)
})

test('期望版本落后即版本冲突，空间不被改写',async()=>{
 const ownerId='local:space-stale'
 await service().ensurePersonal(ownerId)
 const current=await service().rename(ownerId,{requestId:randomUUID(),expectedVersion:1,name:'先改一次',description:''})
 await assert.rejects(service().rename(ownerId,{requestId:randomUUID(),expectedVersion:1,name:'落后的改名',description:''}),{code:'teloa/version-conflict'})
 assert.deepEqual(await service().current(ownerId),current)
 assert.equal((await edits(ownerId)).length,1)
})

test('名称不合法或字段越权一律拒绝，且不落任何写',async()=>{
 const ownerId='local:space-invalid'
 const created=await service().ensurePersonal(ownerId)
 for(const value of [
  {requestId:randomUUID(),expectedVersion:1,name:'',description:''},
  {requestId:randomUUID(),expectedVersion:1,name:'  ',description:''},
  {requestId:randomUUID(),expectedVersion:1,name:'名'.repeat(81),description:''},
  {requestId:randomUUID(),expectedVersion:1,name:'越权',description:'x'.repeat(2001)},
  {requestId:randomUUID(),expectedVersion:0,name:'越权',description:''},
  {requestId:randomUUID(),expectedVersion:1,name:'越权',description:'',kind:'team'},
  {requestId:randomUUID(),expectedVersion:1,name:'越权',description:'',spaceId:randomUUID()},
  {requestId:'not-a-uuid',expectedVersion:1,name:'越权',description:''},
 ])await assert.rejects(service().rename(ownerId,value),{code:'teloa/invalid-input'})
 assert.deepEqual(await service().current(ownerId),created)
 assert.equal((await edits(ownerId)).length,0)
})

test('建表语句在已有数据的库上可重跑',async()=>{
 const ownerId='local:space-reinit'
 const created=await service().ensurePersonal(ownerId)
 await initializeBusinessSpaces(pool)
 await initializeIndustryLoads(pool)
 assert.deepEqual(await service().current(ownerId),created)
})

test('check 约束挡住非法归属取值',async()=>{
 const ownerId='local:space-kind-check'
 await assert.rejects(pool.query("insert into teloa_business_spaces(id,owner_id,name,description,version,created_at,updated_at,kind) values($1,$2,'坏归属','',1,now(),now(),'shared')",[randomUUID(),ownerId]),/teloa_business_spaces_kind_check/)
 assert.equal((await spaces(ownerId)).length,0)
})

test('部分唯一索引挡住第二行本人空间',async()=>{
 const ownerId='local:space-unique'
 await service().ensurePersonal(ownerId)
 await assert.rejects(pool.query("insert into teloa_business_spaces(id,owner_id,name,description,version,created_at,updated_at,kind) values($1,$2,'第二个本人空间','',1,now(),now(),'personal')",[randomUUID(),ownerId]),/teloa_business_spaces_personal/)
 assert.deepEqual((await spaces(ownerId)).map(row=>row.kind),['personal'])
})

test('版本配置默认个人版，其它取值在装配时失败',()=>{
 assert.equal(readEdition({}),'personal')
 assert.equal(readEdition({TELOA_EDITION:'personal'}),'personal')
 for(const value of ['enterprise','professional',''])assert.throws(()=>readEdition({TELOA_EDITION:value}),{code:'teloa/invalid-input'})
})
