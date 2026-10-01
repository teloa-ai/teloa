import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeBusinessDefinitions,initializeBusinessScopes,initializeBusinessSpaces} from '../src/index.ts'
import * as configuration from '../src/work/business-configuration-drafts.ts'
import {initializeBusinessConfigurations} from '../src/work/business-configuration-store.ts'
let pool:Pool,container:StartedPostgreSqlContainer
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeBusinessSpaces(pool);await initializeBusinessScopes(pool);await initializeBusinessDefinitions(pool);await initializeBusinessConfigurations(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const service=()=>new configuration.BusinessConfigurationDraftService(pool,identity)
const actor=()=>({ownerId:'config:'+randomUUID(),scopeIds:[] as string[]})
test('新草案不登记范围；begin 和 revise 回执跨重建返回原结果，异内容和跨操作冲突',async()=>{
 const a=actor(),s=service(),input={requestId:randomUUID(),title:'工单'}
 const d=await s.begin(a,input)
 assert.match(d.scope,/^business_[a-f0-9]{32}$/)
 assert.equal((await pool.query('select 1 from teloa_business_scopes where owner_id=$1',[a.ownerId])).rowCount,0)
 assert.deepEqual(await service().begin(a,input),d)
 await assert.rejects(s.begin(a,{...input,title:'不同'}),{code:'teloa/conflict'})
 const edit={draftId:d.id,expectedRevision:1,requestId:randomUUID(),patch:{title:'更新'}}
 const r=await s.revise(a,edit)
 assert.equal(r.revision,2);assert.equal(r.candidate.title,'更新')
 assert.deepEqual(await service().revise(a,edit),r)
 assert.deepEqual(await s.begin(a,input),d)
 await assert.rejects(s.revise(a,{...edit,requestId:input.requestId}),{code:'teloa/conflict'})
 await assert.rejects(s.revise(a,{...edit,requestId:randomUUID()}),{code:'teloa/version-conflict'})
 await assert.rejects(s.get(actor(),{draftId:d.id}),{code:'teloa/forbidden'})
})
test('两个 CAS 只有一个成功；并发新建不越过每本人 16 份额度',async()=>{
 const a=actor(),s=service(),d=await s.begin(a,{requestId:randomUUID(),title:'工单'})
 const results=await Promise.allSettled(['甲','乙'].map(title=>s.revise(a,{draftId:d.id,expectedRevision:1,requestId:randomUUID(),patch:{title}})))
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 const created=await Promise.allSettled(Array.from({length:18},()=>s.begin(a,{requestId:randomUUID(),title:'工单'})))
 assert.equal(created.filter(r=>r.status==='fulfilled').length,15)
 assert.equal((await pool.query("select count(*)::int n from teloa_business_configuration_drafts where owner_id=$1",[a.ownerId])).rows[0].n,16)
})
test('合并缺省保留定义页面，修改保留位置，排序完整覆盖，显式删除',async()=>{
 const a=actor(),s=service(),d=await s.begin(a,{requestId:randomUUID(),title:'工单'})
 const definition={format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:d.scope,title:'工单',unit:'条',lead:'跟进事项',sourceId:d.candidate.sources[0]!.sourceId,fields:[{name:'state',label:'状态',type:'text',required:true,from:'状态'}]}
 const page={id:'home',title:'记录',kind:'records',objectType:'ticket',fields:['state'],allowCreate:true,allowEdit:true,allowArchive:true}
 let r=await s.revise(a,{draftId:d.id,expectedRevision:1,requestId:randomUUID(),patch:{upsertDefinitions:[{kind:'object-type',definition}],upsertPages:[page,{...page,id:'other'}],homePageId:'home'}})
 r=await s.revise(a,{draftId:d.id,expectedRevision:2,requestId:randomUUID(),patch:{title:'新标题',upsertPages:[{...page,title:'改名'}]}})
 assert.equal(r.candidate.definitions.length,1);assert.deepEqual(r.candidate.pages.map(p=>p.id),['home','other'])
 await assert.rejects(s.revise(a,{draftId:d.id,expectedRevision:3,requestId:randomUUID(),patch:{pageOrder:['home']}}),{code:'teloa/invalid-input'})
 r=await s.revise(a,{draftId:d.id,expectedRevision:3,requestId:randomUUID(),patch:{removePageIds:['home','other'],removeDefinitions:[{kind:'object-type',localId:'ticket'}]}})
 assert.deepEqual(r.candidate.pages,[]);assert.deepEqual(r.candidate.definitions,[]);assert.equal(r.candidate.homePageId,undefined)
})

import {BusinessConfigurationStore,businessConfigurationHash} from '../src/work/business-configuration-store.ts'
import {insertBusinessDefinitionVersion} from '../src/work/business-definition-write.ts'
import {lockBusinessConfiguration} from '../src/work/business-configuration-lock.ts'
import {BusinessLocalDefinitionService,BusinessSpaceService,BusinessScopeService} from '../src/index.ts'
import {issueBusinessDefinitionPreviewReceipt} from '../src/work/business-definition-preview-receipt.ts'
async function managedFixture(){
 const a=actor(),s=service(),draft=await s.begin(a,{requestId:randomUUID(),title:'工单'})
 a.scopeIds=[draft.scope]
 const definition={format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:draft.scope,title:'工单',unit:'条',lead:'跟进事项',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'state',label:'状态',type:'text',required:true,from:'状态'}]}
 const page={id:'home',title:'记录',kind:'records',objectType:'ticket',fields:['state'],allowCreate:true,allowEdit:true,allowArchive:true}
 const space=await new BusinessSpaceService(pool,identity).ensurePersonal(a.ownerId)
 const db=await pool.connect()
 await db.query('begin')
 await lockBusinessConfiguration(db,a.ownerId,draft.scope)
 await BusinessScopeService.ensure(db,a.ownerId,{scope:draft.scope,title:'工单',kind:'domain',spaceId:space.id})
 const leaf=await insertBusinessDefinitionVersion(db,{ownerId:a.ownerId,scope:draft.scope,kind:'object-type',definition,draftId:draft.id,now:identity.now()})
 await db.query('insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,$2,$3,$4,1,1,now())',[a.ownerId,draft.scope,'object-type','ticket'])
 const manifest={...draft.candidate,definitions:[{kind:'object-type',localId:'ticket',version:leaf.version,definitionHash:leaf.definitionHash}],pages:[page],homePageId:'home'}
 await db.query('insert into teloa_business_configuration_versions(owner_id,scope_id,version,manifest,hash,created_at) values($1,$2,1,$3,$4,now())',[a.ownerId,draft.scope,JSON.stringify(manifest),businessConfigurationHash(manifest)])
 await db.query('insert into teloa_business_configuration_heads(owner_id,scope_id,version,updated_at) values($1,$2,1,now())',[a.ownerId,draft.scope])
 await db.query('update teloa_business_scopes set configuration_managed=true where owner_id=$1 and scope=$2',[a.ownerId,draft.scope])
 await db.query('commit');db.release()
 return {a,s,draft,manifest,definition}
}
test('受管当前配置在只读快照核对；修改从已采用固定叶子组成候选且要求范围授权',async()=>{
 const {a,s,draft,manifest}=await managedFixture(),db=await pool.connect()
 try{
  await db.query('begin isolation level repeatable read read only')
  const current=await new BusinessConfigurationStore(pool).currentInTransaction(db,a.ownerId,draft.scope)
  assert.deepEqual(current?.manifest,manifest)
  assert.equal((await s.draftInTransaction(db,a,draft.id)).id,draft.id)
  await db.query('commit')
 }finally{db.release()}
 const next=await s.begin(a,{requestId:randomUUID(),title:'改业务',scope:draft.scope})
 assert.equal(next.baseVersion,1);assert.equal(next.candidate.definitions.length,1)
 assert.deepEqual(next.candidate.sources,draft.candidate.sources)
 await assert.rejects(s.begin({...a,scopeIds:[]},{requestId:randomUUID(),title:'不准',scope:draft.scope}),{code:'teloa/forbidden'})
 await assert.rejects(s.get({...a,scopeIds:[]},{draftId:next.id}),{code:'teloa/forbidden'})
 await assert.rejects(s.begin({...a,scopeIds:['SOC']},{requestId:randomUUID(),title:'不能接管',scope:'SOC'}),{code:'teloa/forbidden'})
})
test('marker/head/manifest/hash/leaf 投影错配都拒绝，空历史 head 不算活跃投影',async()=>{
 const {a,draft}=await managedFixture(),store=new BusinessConfigurationStore(pool),db=await pool.connect()
 const cases=[
  "update teloa_business_scopes set configuration_managed=false where owner_id=$1",
  "delete from teloa_business_configuration_heads where owner_id=$1",
  "update teloa_business_configuration_versions set hash=repeat('a',64) where owner_id=$1",
  "update teloa_business_local_definition_heads set version=2 where owner_id=$1",
  "delete from teloa_business_local_definition_heads where owner_id=$1",
  "update teloa_business_local_definitions set body='{}' where owner_id=$1",
 ]
 try{
  for(const sql of cases){
   await db.query('begin');await db.query(sql,[a.ownerId])
   await assert.rejects(store.currentInTransaction(db,a.ownerId,draft.scope),{code:'teloa/storage-corrupt'})
   await db.query('rollback')
  }
  await db.query('begin')
  await db.query("insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,$2,'view','old',null,1,now())",[a.ownerId,draft.scope])
  assert.equal((await store.currentInTransaction(db,a.ownerId,draft.scope))?.version,1)
  await db.query('rollback')
 }finally{db.release()}
})
test('旧 draft/apply/revert 与受管登记争锁；等待登记提交后不能写穿配置',async()=>{
 const a=actor();a.scopeIds=['SOC']
 const legacy=new BusinessLocalDefinitionService(pool,identity)
 const definition={format:'teloa.business-view/v1',id:'risk',version:'1.0.0',domain:'SOC',title:'风险',kind:'distribution',chart:'bar',objectType:'ticket',dimension:{field:'state',limit:3},measures:[{id:'total',label:'数量',aggregation:'count'}],filters:[],sort:{by:'measure',measureId:'total',direction:'desc'},limit:3}
 const draft=await legacy.draft(a,{scope:'SOC',kind:'view',definition,requestId:randomUUID()})
 const space=await new BusinessSpaceService(pool,identity).ensurePersonal(a.ownerId)
 const db=await pool.connect()
 await db.query('begin');await lockBusinessConfiguration(db,a.ownerId,'SOC')
 await db.query('update teloa_business_scopes set configuration_managed=true where owner_id=$1 and scope=$2',[a.ownerId,'SOC'])
 const pid=Number((await db.query('select pg_backend_pid() pid')).rows[0].pid)
 const pending=assert.rejects(legacy.apply(a,{requestId:randomUUID(),draftId:draft.id,expectedCurrentVersion:0,expectedDefinitionHash:draft.definitionHash,previewReceipt:issueBusinessDefinitionPreviewReceipt({ownerId:a.ownerId,scope:'SOC',draftId:draft.id,definitionHash:draft.definitionHash,currentVersion:0})}),{code:'teloa/conflict'})
 try{
  const deadline=Date.now()+5000;let blocked=false
  while(Date.now()<deadline){
   if((await pool.query("select 1 from pg_stat_activity where wait_event='advisory' and $1=any(pg_blocking_pids(pid))",[pid])).rowCount){blocked=true;break}
   await new Promise<void>(resolve=>setImmediate(resolve))
  }
  assert.equal(blocked,true);await db.query('commit');await pending
 }finally{await db.query('rollback');db.release()}
 await assert.rejects(legacy.draft(a,{scope:'SOC',kind:'view',definition,requestId:randomUUID()}),{code:'teloa/conflict'})
 await assert.rejects(legacy.revert(a,{requestId:randomUUID(),scope:'SOC',kind:'view',localId:'risk',target:{kind:'template'},expectedCurrentVersion:0}),{code:'teloa/conflict'})
 assert.equal((await pool.query('select 1 from teloa_business_local_definitions where owner_id=$1',[a.ownerId])).rowCount,0)
 assert.ok(space.id)
})
test('匹配摘要的叶子正文也必须与版本身份一致',async()=>{
 const {a,draft,definition}=await managedFixture(),db=await pool.connect()
 try{
  await db.query('begin')
  const {prepareBusinessDefinition}=await import('../src/work/business-definition-write.ts')
  const swapped=prepareBusinessDefinition(draft.scope,'object-type',{...definition,version:'2.0.0'})
  // 保留版本行 semver=1.0.0，重算其身份摘要模拟损坏而非简单正文 hash 错误。
  const {businessLocalDefinitionHash}=await import('../src/work/business-definition-write.ts')
  const hash=businessLocalDefinitionHash(draft.scope,'object-type','ticket','1.0.0',swapped.bodyHash)
  await db.query('update teloa_business_local_definitions set body=$2,body_hash=$3,definition_hash=$4 where owner_id=$1',[a.ownerId,swapped.body,swapped.bodyHash,hash])
  const row=(await db.query('select manifest from teloa_business_configuration_versions where owner_id=$1',[a.ownerId])).rows[0]
  row.manifest.definitions[0].definitionHash=hash
  await db.query('update teloa_business_configuration_versions set manifest=$2,hash=$3 where owner_id=$1',[a.ownerId,JSON.stringify(row.manifest),businessConfigurationHash(row.manifest)])
  await assert.rejects(new BusinessConfigurationStore(pool).currentInTransaction(db,a.ownerId,draft.scope),{code:'teloa/storage-corrupt'})
 }finally{await db.query('rollback');db.release()}
})
test('空草案显式首页不能被静默丢弃；草案正文损坏读取不外带正文',async()=>{
 const a=actor(),s=service(),d=await s.begin(a,{requestId:randomUUID(),title:'工单'})
 await assert.rejects(s.revise(a,{draftId:d.id,expectedRevision:1,requestId:randomUUID(),patch:{homePageId:'missing'}}),{code:'teloa/invalid-input'})
 await pool.query("update teloa_business_configuration_drafts set hash=repeat('a',64) where owner_id=$1",[a.ownerId])
 await assert.rejects(s.get(a,{draftId:d.id}),{code:'teloa/storage-corrupt'})
})
test('整体叶子写原语不占 32 份独立草案额度；旧版本链上限仍保留',async()=>{
 const a=actor();a.scopeIds=['SOC']
 const legacy=new BusinessLocalDefinitionService(pool,identity)
 const definition={format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:'SOC',title:'工单',unit:'条',lead:'跟进事项',sourceId:'records',fields:[{name:'state',label:'状态',type:'text',required:true,from:'状态'}]}
 for(let i=0;i<32;i++)await legacy.draft(a,{scope:'SOC',kind:'object-type',definition,requestId:randomUUID()})
 const db=await pool.connect()
 try{
  await db.query('begin');await lockBusinessConfiguration(db,a.ownerId,'SOC')
  const inserted=await insertBusinessDefinitionVersion(db,{ownerId:a.ownerId,scope:'SOC',kind:'object-type',definition,draftId:randomUUID(),now:identity.now()})
  assert.equal(inserted.version,1)
  await db.query('commit')
  assert.equal((await pool.query("select count(*)::int n from teloa_business_definition_drafts where owner_id=$1 and status='draft'",[a.ownerId])).rows[0].n,32)
 }finally{db.release()}
})
