import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {pageCreateLimits} from '@teloa/contract'
import {initializePageCreateDrafts,PageCreateDraftService,type PageCreateActor} from '../src/work/page-create-drafts.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializePageCreateDrafts(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const identity={id:randomUUID,now:()=>new Date().toISOString()}
const actor=():PageCreateActor=>({ownerId:'local:'+randomUUID(),scopeIds:['SOC']})
const role=(name='对账同事')=>({name,kind:'employee',scopes:['SOC'],duty:'核对账单',dataScope:'本人授权资料',executionScope:'只提出建议',skills:[],knowledge:[],responsibility:{triggers:['每天'],autonomousActions:['整理账单'],confirmationPoints:['发出前'],escalationRules:['资料不足'],deliveryChecks:['逐项核对']}})
const view=(title='风险分布')=>({format:'teloa.business-view/v1',id:'risk-distribution',version:'1.0.0',domain:'SOC',title,kind:'distribution',chart:'bar',objectType:'alert-ticket',dimension:{field:'severity',limit:3},measures:[{id:'total',label:'条数',aggregation:'count'}],filters:[],sort:{by:'measure',measureId:'total',direction:'desc'},limit:3})
const businessDomainBody=(scope:string)=>({
 manifest:{format:'teloa.business-package/v2',id:'recruiting-template',title:'招聘行业模板',version:'1.0.0',domain:'recruiting',scope,description:'用于验证新业务范围目录读取。',resources:[{id:'recruiting-template-work',kind:'work-template',title:'招聘工作模板',version:'1.0.0',required:true,source:{kind:'local',path:'work-template.json'}}],relations:[],entrypoints:[]},
 definitions:[view()],
})

test('草案同 requestId 只替换同一条待确认记录，落定后不再允许改写',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),requestId=randomUUID()
 const first=await service.draft(owner,{entity:'role',body:role(),requestId})
 const again=await service.draft(owner,{entity:'role',body:role('对账同事（二次修改）'),requestId})
 assert.equal(again.id,first.id);assert.equal(again.status,'draft');assert.equal(again.appliedRef,undefined);assert.notEqual(again.bodyHash,first.bodyHash)
 await assert.rejects(()=>service.settle(owner,{requestId:randomUUID(),draftId:again.id,expectedBodyHash:again.bodyHash,outcome:'applied'}),{code:'teloa/invalid-input'})
 await service.settle(owner,{requestId:randomUUID(),draftId:again.id,expectedBodyHash:again.bodyHash,outcome:'applied',appliedRef:'role-created-1'})
 await assert.rejects(()=>service.draft(owner,{entity:'role',body:role('不应覆盖'),requestId}),{code:'teloa/conflict'})
 const directory=await service.directory(owner,{entity:'role'})
 assert.equal(directory.drafts[0]?.status,'applied');assert.equal(directory.drafts[0]?.appliedRef,'role-created-1')
})

test('草案上限按实体和范围硬性拒绝，不截断也不删除旧草案',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity)
 for(let index=0;index<pageCreateLimits.draftsPerEntity;index++)await service.draft(owner,{entity:'role',body:role('同事 '+index),requestId:randomUUID()})
 await assert.rejects(()=>service.draft(owner,{entity:'role',body:role('超出上限'),requestId:randomUUID()}),{code:'teloa/conflict'})
 assert.equal((await service.directory(owner,{entity:'role'})).drafts.length,pageCreateLimits.draftsPerEntity)
})

test('范围只允许本人已登记的业务；通用范围和多余范围一律拒绝',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity)
 const saved=await service.draft(owner,{entity:'business-definition',scope:'SOC',body:view(),requestId:randomUUID()})
 assert.equal(saved.scope,'SOC')
 await assert.rejects(()=>service.draft(owner,{entity:'business-definition',scope:'general',body:view(),requestId:randomUUID()}),{code:'teloa/invalid-input'})
 await assert.rejects(()=>service.draft(owner,{entity:'business-definition',scope:'AppSec',body:{...view(),domain:'AppSec'},requestId:randomUUID()}),{code:'teloa/forbidden'})
 await assert.rejects(()=>service.draft(owner,{entity:'role',scope:'SOC',body:role(),requestId:randomUUID()}),{code:'teloa/invalid-input'})
})

test('落定按正文摘要乐观核对，丢弃不能带落地记录',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),draft=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID()})
 await assert.rejects(()=>service.settle(owner,{requestId:randomUUID(),draftId:draft.id,expectedBodyHash:'a'.repeat(64),outcome:'discarded'}),{code:'teloa/version-conflict'})
 await assert.rejects(()=>service.settle(owner,{requestId:randomUUID(),draftId:draft.id,expectedBodyHash:draft.bodyHash,outcome:'discarded',appliedRef:'role-1'}),{code:'teloa/invalid-input'})
 const directory=await service.settle(owner,{requestId:randomUUID(),draftId:draft.id,expectedBodyHash:draft.bodyHash,outcome:'discarded'})
 assert.equal(directory.drafts.find(item=>item.id===draft.id)?.status,'discarded')
 await assert.rejects(()=>service.settle(owner,{requestId:randomUUID(),draftId:draft.id,expectedBodyHash:draft.bodyHash,outcome:'discarded'}),{code:'teloa/version-conflict'})
})

test('新业务范围键未登记也能读取目录；键格式不合规一律拒绝',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity)
 const saved=await service.draft(owner,{entity:'business-domain',scope:'recruiting',body:businessDomainBody('recruiting'),requestId:randomUUID()})
 assert.equal(saved.scope,'recruiting')
 const directory=await service.directory(owner,{entity:'business-domain',scope:'recruiting'})
 assert.equal(directory.drafts[0]?.id,saved.id)
 await assert.rejects(()=>service.draft(owner,{entity:'business-domain',scope:'招聘',body:businessDomainBody('招聘'),requestId:randomUUID()}),{code:'teloa/invalid-input'})
 await assert.rejects(()=>service.directory(owner,{entity:'business-domain',scope:'招聘'}),{code:'teloa/invalid-input'})
})

test('业务范围一旦登记，业务台账不能借目录再走一遍新建',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity)
 await assert.rejects(()=>service.directory(owner,{entity:'business-domain',scope:'SOC'}),{code:'teloa/conflict'})
})

test('事务读取仍核对库中正文，篡改后的草案不能静默返回',async()=>{
 const owner=actor(),service=new PageCreateDraftService(pool,identity),draft=await service.draft(owner,{entity:'role',body:role(),requestId:randomUUID()})
 const db=await pool.connect()
 try{
  await db.query("update teloa_page_create_drafts set body='{}' where owner_id=$1 and id=$2",[owner.ownerId,draft.id])
  await assert.rejects(()=>service.draftInTransaction(db,owner.ownerId,draft.id),{code:'teloa/storage-corrupt'})
  await assert.rejects(()=>service.draftInTransaction(db,'local:'+randomUUID(),draft.id),{code:'teloa/forbidden'})
 }finally{db.release()}
})
