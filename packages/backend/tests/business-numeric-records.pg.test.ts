import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as api from '../src/index.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import type {BusinessObjectTypeDefinitionV2} from '@teloa/contract'
let pool:Pool,container:StartedPostgreSqlContainer|undefined
const identity={id:randomUUID,now:()=>new Date().toISOString()},unavailable=async():Promise<never>=>{throw Error('不得读取外部业务来源')}
before(async()=>{
 let connectionString=process.env.TELOA_BUSINESS_NUMERIC_TEST_PG_URL
 if(connectionString)assert.match(new URL(connectionString).pathname,/^\/quality_numeric_[a-z0-9_]+$/)
 else{container=await new PostgreSqlContainer('postgres:17-alpine').withPullPolicy({shouldPull:()=>false}).start();connectionString=container.getConnectionUri()}
 pool=new Pool({connectionString})
 await api.initializeBusinessSpaces(pool);await api.initializeBusinessDefinitions(pool);await api.initializeBusinessConfigurations(pool);await api.initializeBusinessRuntime(pool);await api.initializeBusinessData(pool);await api.initializeBusinessWarehouse(pool);await api.initializeBusinessSnapshotReferences(pool);await api.initializeBusinessRecords(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container)})
async function fixture(constrained=true){
 const drafts=new api.BusinessConfigurationDraftService(pool,identity),store=new api.BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const runtime=new api.BusinessRuntimeService(pool,identity),spaces=new api.BusinessSpaceService(pool,identity),apply=new api.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime,spaces}),preview=new api.BusinessConfigurationPreviewService(pool,drafts,definitions,identity),actor={ownerId:'numeric-source:'+randomUUID(),scopeIds:[] as string[]}
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'数值约束源测试',format:'teloa.business-configuration/v2'})
 const object:BusinessObjectTypeDefinitionV2={format:'teloa.business-object-type/v2',id:'inventory',version:'1.0.0',domain:draft.scope,title:'测试库存',unit:'条',lead:'独立测试数据',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'sku',label:'SKU',from:'SKU',type:'text',required:true},{name:'quantity',label:'数量',from:'数量',type:'number',required:true,...(constrained?{integer:true as const,minimum:0}:{})},{name:'warehouse',label:'仓库',from:'仓库',type:'text',required:true}],constraints:{uniqueFields:['sku']}}
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,patch:{upsertDefinitions:[{kind:'object-type',definition:object}],upsertPages:[{kind:'records',id:'inventory',title:'测试库存',objectType:'inventory',fields:['sku','quantity','warehouse'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'inventory'}})
 const p=await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})
 await apply.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:p.receipt});actor.scopeIds=[draft.scope]
 const records=new api.BusinessRecordService(pool,identity,{definitions,warehouse:new api.BusinessWarehouseService(pool,identity),references:new api.BusinessSnapshotReferenceService(pool,identity)})
 const input=(sku:string,quantity:string)=>({requestId:randomUUID(),scope:draft.scope,type:'inventory',title:sku,summary:'',fields:[{name:'sku',value:sku},{name:'quantity',value:quantity},{name:'warehouse',value:'测试仓'}]})
 const tighten=async()=>{let next=await drafts.begin(actor,{requestId:randomUUID(),scope:draft.scope,title:'收紧数量规则',format:'teloa.business-configuration/v2'});return drafts.revise(actor,{requestId:randomUUID(),draftId:next.id,expectedRevision:next.revision,patch:{upsertDefinitions:[{kind:'object-type',definition:{...object,fields:object.fields.map(f=>f.name==='quantity'?{...f,integer:true,minimum:0}:f)}}]}})}
 return {actor,draft,object,records,input,drafts,preview,apply,tighten}
}
async function counts(owner:string){
 const result:Record<string,number>={}
 for(const table of ['teloa_business_object_snapshots','teloa_business_record_heads','teloa_business_record_receipts','teloa_business_record_batches','teloa_business_snapshot_references','teloa_business_configuration_versions','teloa_business_local_definitions','teloa_business_configuration_receipts'])result[table]=(await pool.query('select count(*)::int n from '+table+' where owner_id=$1',[owner])).rows[0].n
 return result
}
test('库存非负整数真实创建、原回执和SKU唯一，拒绝值不留持久写入',async()=>{
 const f=await fixture(),zero=await f.records.create(f.actor,f.input('NUM-ZERO','0')),input=f.input('NUM-FOUR','4'),four=await f.records.create(f.actor,input)
 assert.equal(zero.fields.find(x=>x.label==='数量')?.value,'0');assert.equal(four.fields.find(x=>x.label==='数量')?.value,'4')
 const baseline=await counts(f.actor.ownerId)
 assert.deepEqual(await f.records.create(f.actor,input),four);assert.deepEqual(await f.records.receipt(f.actor,{requestId:input.requestId}),four)
 for(const value of ['-1','1.5','4.0000000000000001','1e-400']){const bad=f.input('NUM-'+value,value);await assert.rejects(f.records.create(f.actor,bad),{code:'teloa/invalid-input'});assert.equal(await f.records.receipt(f.actor,{requestId:bad.requestId}),undefined)}
 await assert.rejects(f.records.create(f.actor,f.input('NUM-FOUR','4')),{code:'teloa/conflict'})
 assert.deepEqual(await counts(f.actor.ownerId),baseline)
 const persisted=(await pool.query('select body from teloa_business_local_definitions where owner_id=$1 and local_id=$2',[f.actor.ownerId,'inventory'])).rows[0]
 assert.deepEqual(JSON.parse(persisted.body).fields[1],{name:'quantity',label:'数量',from:'数量',type:'number',required:true,integer:true,minimum:0})
})
test('数量编辑和整批写入均在事务内拒绝无效值，失败批次不留下前半条',async()=>{
 const f=await fixture(),first=await f.records.create(f.actor,f.input('EDIT','4')),baseline=await counts(f.actor.ownerId)
 for(const value of ['-1','1.5'])await assert.rejects(f.records.edit(f.actor,{...f.input('EDIT',value),id:first.id,expectedVersion:first.version}),{code:'teloa/invalid-input'})
 const good=f.input('BATCH-GOOD','4'),bad=f.input('BATCH-BAD','1.5'),requestId=randomUUID()
 await assert.rejects(f.records.batch(f.actor,{scope:f.draft.scope,requestId,operations:[good,bad].map(({requestId:_,scope:__,...row})=>({operation:'create' as const,...row}))}),{code:'teloa/invalid-input'})
 assert.equal(await f.records.batchReceipt(f.actor,{requestId}),undefined);assert.deepEqual(await f.records.get(f.actor,{scope:first.scope,type:first.type,id:first.id}),first);assert.deepEqual(await counts(f.actor.ownerId),baseline)
})
test('收紧已有库存规则时预览拒绝无效数量；采用须重查预览后迟到的无效值',async()=>{
 const invalid=await fixture(false);await invalid.records.create(invalid.actor,invalid.input('OLD-INVALID','-1'));const draft=await invalid.tighten(),baseline=await counts(invalid.actor.ownerId)
 await assert.rejects(invalid.preview.preview(invalid.actor,{draftId:draft.id,expectedRevision:draft.revision}),{code:'teloa/conflict'});assert.deepEqual(await counts(invalid.actor.ownerId),baseline)
 const race=await fixture(false);await race.records.create(race.actor,race.input('OLD-VALID','4'));const candidate=await race.tighten(),p=await race.preview.preview(race.actor,{draftId:candidate.id,expectedRevision:candidate.revision})
 await race.records.create(race.actor,race.input('LATE-INVALID','1.5'));const before=await counts(race.actor.ownerId),requestId=randomUUID()
 await assert.rejects(race.apply.apply(race.actor,{requestId,draftId:candidate.id,expectedRevision:candidate.revision,expectedBaseVersion:candidate.baseVersion,previewReceipt:p.receipt}),{code:'teloa/conflict'})
 assert.equal(await race.apply.receipt(race.actor,{requestId}),undefined);assert.deepEqual(await counts(race.actor.ownerId),before)
})
