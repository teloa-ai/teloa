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
import {BusinessConfigurationStore,businessConfigurationHash} from '../src/work/business-configuration-store.ts'
import {insertBusinessDefinitionVersion} from '../src/work/business-definition-write.ts'
import {lockBusinessConfiguration} from '../src/work/business-configuration-lock.ts'
import {BusinessSpaceService,BusinessScopeService} from '../src/index.ts'
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

import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
const unavailable=async():Promise<never>=>{throw new Error('本地配置不得访问市场或来源')}
function reader(configured=true){
 return new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,configured?new BusinessConfigurationStore(pool):undefined)
}
test('真实本地配置没有市场加载也能读取，来源分支无伪造 loadId，旧叶子 wire 不变',async()=>{
 const {a,draft}=await managedFixture(),db=await pool.connect()
 try{
  const bundles=await reader().forScope(db,a.ownerId,draft.scope)
  assert.equal(bundles.length,1)
  assert.equal(bundles[0]?.origin.kind,'local-configuration')
  assert.equal(bundles[0]?.origin.configurationVersion,1)
  assert.equal(Object.hasOwn(bundles[0]!,'loadId'),false)
  assert.equal(bundles[0]?.objectTypes[0]?.definition.id,'ticket')
  assert.equal(bundles[0]?.sources.get(draft.candidate.sources[0]!.sourceId)?.connected,true)
  assert.deepEqual(Object.keys(bundles[0]!.objectTypes[0]!.source).sort(),['contentHash','definitionHash','fileHash','loadId','localId','origin','scope','version'])
  assert.equal(bundles[0]!.objectTypes[0]!.source.loadId,'local')
  await assert.rejects(reader(false).forScope(db,a.ownerId,draft.scope),{code:'teloa/dependency-unavailable'})
 }finally{db.release()}
})

test('整体候选保持中文改名的 name/from，拒绝假来源、跨范围、页面字段、非法 SQL 和未读取的时间表',async()=>{
 const {a,draft,definition,manifest}=await managedFixture(),db=await pool.connect()
 try{
  const candidate={...manifest,definitions:[{kind:'object-type',definition:{...definition,fields:[{...definition.fields[0],label:'处理阶段'}]}}]}
  const source=reader()
  assert.equal(typeof source.forConfigurationCandidate,'function','须提供整体候选读取入口')
  const bundles=await source.forConfigurationCandidate(db,a.ownerId,candidate)
  assert.equal(bundles[0]?.origin.kind,'configuration-preview')
  assert.equal(bundles[0]?.objectTypes[0]?.definition.fields[0]?.name,'state')
  assert.equal(bundles[0]?.objectTypes[0]?.definition.fields[0]?.from,'状态')
  assert.equal(bundles[0]?.objectTypes[0]?.definition.fields[0]?.label,'处理阶段')
  const bad=[
   {...candidate,definitions:[{kind:'object-type',definition:{...definition,sourceId:'fake'}}]},
   {...candidate,definitions:[{kind:'object-type',definition:{...definition,domain:'SOC'}}]},
   {...candidate,pages:[{...manifest.pages[0],fields:['missing']}]},
  ]
  const widget={format:'teloa.business-widget/v1',id:'counts',version:'1.0.0',domain:draft.scope,title:'统计',kind:'metric',query:'select count(*) as total from ticket',metric:{valueColumn:'total'}}
  assert.equal((await source.forConfigurationCandidate(db,a.ownerId,{...candidate,definitions:[...candidate.definitions,{kind:'widget',definition:widget}]}))[0]?.widgets.length,1)
  for(const change of [{query:'select * from pg_catalog.pg_class'},{query:'select 1 as total',timeFilter:{table:'ticket',column:'_observed_at'}}])bad.push({...candidate,definitions:[...candidate.definitions,{kind:'widget',definition:{...widget,...change}}]} as never)
  for(const value of bad)await assert.rejects(source.forConfigurationCandidate(db,a.ownerId,value),(error:{code:string})=>['teloa/invalid-input','teloa/source-unavailable'].includes(error.code))
 }finally{db.release()}
})

test('完整预览只读且签名绑定本人、正文、修订与当前基线；缺页不签成功回执',async()=>{
 const api=await import('../src/index.ts')
 assert.equal(typeof api.BusinessConfigurationPreviewService,'function','须提供整体预览服务')
 const {verifiesBusinessConfigurationPreviewReceipt}=await import('../src/work/business-configuration-preview-receipt.ts')
 const {a,s,draft,definition,manifest}=await managedFixture()
 const next=await s.begin(a,{requestId:randomUUID(),title:'改名',scope:draft.scope})
 const preview=new api.BusinessConfigurationPreviewService(pool,s,reader(),identity)
 const result=await preview.preview(a,{draftId:next.id,expectedRevision:1})
 assert.equal(result.baseVersion,1);assert.equal(result.revision,1)
 assert.deepEqual(result.issues,[]);assert.ok(result.changes.rows.some(row=>row.path==='title'))
 const binding={ownerId:a.ownerId,scope:draft.scope,draftId:next.id,revision:1,candidateHash:next.hash,baseVersion:1,dependencyHash:result.dependencyHash}
 assert.equal(verifiesBusinessConfigurationPreviewReceipt(result.receipt,binding),true)
 for(const delta of [{ownerId:'other'},{scope:'SOC'},{draftId:randomUUID()},{revision:2},{candidateHash:'a'.repeat(64)},{baseVersion:2},{dependencyHash:'a'.repeat(64)}])assert.equal(verifiesBusinessConfigurationPreviewReceipt(result.receipt,{...binding,...delta}),false)
 assert.equal(verifiesBusinessConfigurationPreviewReceipt('0'.repeat(64),binding),false)
 const leafReceipt=issueBusinessDefinitionPreviewReceipt({ownerId:a.ownerId,scope:draft.scope,draftId:next.id,definitionHash:next.hash,currentVersion:1})
 assert.equal(verifiesBusinessConfigurationPreviewReceipt(leafReceipt,binding),false)
 const {spawnSync}=await import('node:child_process')
 const restarted=spawnSync(process.execPath,['--input-type=module','-e',"import {verifiesBusinessConfigurationPreviewReceipt as verify} from './packages/backend/src/work/business-configuration-preview-receipt.ts';process.stdout.write(String(verify(process.argv[1],JSON.parse(process.argv[2]))))",result.receipt,JSON.stringify(binding)],{cwd:new URL('../../../',import.meta.url),encoding:'utf8'})
 assert.equal(restarted.status,0,restarted.stderr);assert.equal(restarted.stdout,'false')

 const before=(await pool.query('select count(*)::int n from teloa_business_configuration_receipts where owner_id=$1',[a.ownerId])).rows[0].n
 const second=await preview.preview(a,{draftId:next.id,expectedRevision:1})
 assert.deepEqual(second,result)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_configuration_receipts where owner_id=$1',[a.ownerId])).rows[0].n,before)
 const revised=await s.revise(a,{draftId:next.id,expectedRevision:1,requestId:randomUUID(),patch:{upsertDefinitions:[{kind:'object-type',definition:{...definition,fields:[{...definition.fields[0],label:'处理阶段'}]}}]}})
 await assert.rejects(preview.preview(a,{draftId:next.id,expectedRevision:1}),{code:'teloa/version-conflict'})
 const changed=await preview.preview(a,{draftId:next.id,expectedRevision:revised.revision})
 assert.notEqual(changed.receipt,result.receipt)
 await assert.rejects(preview.preview(actor(),{draftId:next.id,expectedRevision:2}),{code:'teloa/forbidden'})
 const fresh=await s.begin(a,{requestId:randomUUID(),title:'空业务'})
 await assert.rejects(preview.preview(a,{draftId:fresh.id,expectedRevision:1}),{code:'teloa/invalid-input'})
 // 真实基线推进后原草案不能重新签发旧 base 的成功预览。
 await pool.query('insert into teloa_business_configuration_versions(owner_id,scope_id,version,manifest,hash,created_at) values($1,$2,2,$3,$4,now())',[a.ownerId,draft.scope,JSON.stringify(manifest),businessConfigurationHash(manifest)])
 await pool.query('update teloa_business_configuration_heads set version=2 where owner_id=$1 and scope_id=$2',[a.ownerId,draft.scope])
 await assert.rejects(preview.preview(a,{draftId:next.id,expectedRevision:2}),{code:'teloa/version-conflict'})
})

test('受管配置表缺失固定报损坏，缺版本不退回市场；事务回滚恢复隔离夹具',async()=>{
 const {a,draft}=await managedFixture(),db=await pool.connect()
 try{
  await db.query('begin')
  await db.query('drop table teloa_business_configuration_versions cascade')
  await assert.rejects(reader().forScope(db,a.ownerId,draft.scope),{code:'teloa/storage-corrupt'})
  await assert.rejects(new BusinessConfigurationStore(pool).currentInTransaction(db,a.ownerId,draft.scope),{code:'teloa/storage-corrupt'})
  await db.query('rollback')
  await db.query('begin')
  await db.query('delete from teloa_business_configuration_heads where owner_id=$1',[a.ownerId])
  await assert.rejects(reader().forScope(db,a.ownerId,draft.scope),{code:'teloa/storage-corrupt'})
 }finally{await db.query('rollback');db.release()}
})

test('差异截断到200行但完整候选仍全部校验；本地客户和内容对象可整组读取',async()=>{
 const {BusinessConfigurationPreviewService}=await import('../src/index.ts')
 const a=actor(),s=service(),d=await s.begin(a,{requestId:randomUUID(),title:'客户与内容'})
 const object=(id:string,title:string)=>({kind:'object-type',definition:{format:'teloa.business-object-type/v1',id,version:'1.0.0',domain:d.scope,title,unit:'条',lead:'本地维护',sourceId:d.candidate.sources[0]!.sourceId,fields:[{name:'name',label:'名称',type:'text',required:true,from:'历史名称'}]}})
 const widgets=Array.from({length:32},(_,i)=>({kind:'widget',definition:{format:'teloa.business-widget/v1',id:'count-'+i,version:'1.0.0',domain:d.scope,title:'统计 '+i,kind:'metric',query:'select count(*) as total from customer',metric:{valueColumn:'total'}}}))
 const pages=['customer','content'].map(id=>({id,title:id==='customer'?'客户':'内容',kind:'records',objectType:id,fields:['name'],allowCreate:true,allowEdit:true,allowArchive:true}))
 const revised=await s.revise(a,{draftId:d.id,expectedRevision:1,requestId:randomUUID(),patch:{upsertDefinitions:[object('customer','客户'),object('content','内容'),...widgets],upsertPages:pages,homePageId:'customer'}})
 const actual=reader()
 let reads=0
 const definitions={forConfigurationCandidate:async(db:import('pg').PoolClient,owner:string,candidate:unknown)=>{
  assert.equal((await db.query('show transaction_read_only')).rows[0].transaction_read_only,'on')
  assert.equal((await db.query('show transaction_isolation')).rows[0].transaction_isolation,'repeatable read')
  reads++
  return actual.forConfigurationCandidate(db,owner,candidate)
 }}
 const preview=new BusinessConfigurationPreviewService(pool,s,definitions,identity)
 const result=await preview.preview(a,{draftId:d.id,expectedRevision:revised.revision})
 assert.equal(reads,1);assert.equal(result.changes.rows.length,200);assert.equal(result.changes.truncated,true)
 assert.match(result.receipt,/^[a-f0-9]{64}$/)
 assert.equal((await pool.query('select 1 from teloa_business_scopes where owner_id=$1',[a.ownerId])).rowCount,0)
 assert.equal((await pool.query('select 1 from teloa_business_local_definitions where owner_id=$1',[a.ownerId])).rowCount,0)
 const last=widgets[31]!
 await s.revise(a,{draftId:d.id,expectedRevision:2,requestId:randomUUID(),patch:{upsertDefinitions:[{...last,definition:{...last.definition,query:'select * from pg_catalog.pg_class'}}]}})
 await assert.rejects(preview.preview(a,{draftId:d.id,expectedRevision:3}),{code:'teloa/invalid-input'})
})

test('整体候选拒绝后续片动作和映射，并复用看板、下钻和视图字段交叉校验',async()=>{
 const {a,draft,definition,manifest}=await managedFixture(),db=await pool.connect()
 const candidate={...manifest,definitions:[{kind:'object-type',definition}]}
 const widget={format:'teloa.business-widget/v1',id:'counts',version:'1.0.0',domain:draft.scope,title:'统计',kind:'metric',query:'select count(*) as total from ticket',metric:{valueColumn:'total'}}
 const dashboard={format:'teloa.business-dashboard/v1',id:'board',version:'1.0.0',domain:draft.scope,title:'看板',widgets:['missing'],layout:[{widget:'missing',x:0,y:0,w:12,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false}
 const invalids=[
  {kind:'action',definition:{format:'teloa.business-action/v1',id:'act',version:'1.0.0',domain:draft.scope,title:'执行',objectType:'ticket',target:{kind:'work-template',localId:'nonexistent'},inputs:[{from:'object',part:'title'}]}},
  {kind:'source-mapping',definition:{}},
  {kind:'dashboard',definition:dashboard},
  {kind:'widget',definition:{...widget,drilldown:{objectType:'ticket'}}},
  {kind:'widget',definition:{...widget,timeFilter:{table:'missing',column:'_observed_at'}}},
  {kind:'view',definition:{format:'teloa.business-view/v1',id:'risk',version:'1.0.0',domain:draft.scope,title:'风险',kind:'distribution',chart:'bar',objectType:'ticket',dimension:{field:'missing',limit:3},measures:[{id:'total',label:'数量',aggregation:'count'}],filters:[],sort:{by:'measure',measureId:'total',direction:'desc'},limit:3}},
 ]
 try{
  for(const invalid of invalids)await assert.rejects(reader().forConfigurationCandidate(db,a.ownerId,{...candidate,definitions:[...candidate.definitions,invalid]}),(e:{code:string;details?:{path?:string}})=>['teloa/invalid-input','teloa/source-unavailable'].includes(e.code)&&typeof e.details?.path==='string')
 }finally{db.release()}
})

test('本地单选reference同时支持只读和可创建编辑记录页面',async()=>{
 const {a,definition,manifest}=await managedFixture(),db=await pool.connect()
 const candidate={...manifest,definitions:[{kind:'object-type',definition:{...definition,fields:[{name:'parent',label:'关联',type:'reference',required:false,from:'关联',referenceType:'ticket'}]}}],pages:[{...manifest.pages[0],fields:['parent'],allowCreate:false,allowEdit:false}]}
 try{
  assert.equal((await reader().forConfigurationCandidate(db,a.ownerId,candidate))[0]?.objectTypes[0]?.definition.fields[0]?.type,'reference')
  for(const writable of [{allowCreate:true},{allowEdit:true}])assert.equal((await reader().forConfigurationCandidate(db,a.ownerId,{...candidate,pages:[{...candidate.pages[0],...writable}]}))[0]!.objectTypes[0]!.definition.id,'ticket')
 }finally{db.release()}
})

test('同配置本地目标的单选关联允许可编辑记录页，未解析目标仍拒绝',async()=>{
 const {a,definition,manifest}=await managedFixture(),db=await pool.connect()
 try{
  const related={...definition,fields:[...definition.fields,{name:'related',label:'关联工单',from:'关联工单',type:'reference',referenceType:'ticket',required:false}]}
  const candidate={...manifest,definitions:[{kind:'object-type',definition:related}]}
  const bundles=await reader().forConfigurationCandidate(db,a.ownerId,candidate)
  assert.equal(bundles[0]!.objectTypes[0]!.definition.fields[1]!.type,'reference')
  await assert.rejects(reader().forConfigurationCandidate(db,a.ownerId,{...candidate,definitions:[{kind:'object-type',definition:{...related,fields:[related.fields[0],{...related.fields[1],referenceType:'missing'}]}}]}),(error:{code:string})=>['teloa/invalid-input','teloa/source-unavailable'].includes(error.code))
 }finally{db.release()}
})
