import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as api from '../src/index.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import {businessObjectSnapshotHash} from '../src/work/business-data.ts'
import {lockBusinessRecordTypes} from '../src/work/business-record-constraints.ts'
import {lockBusinessConfiguration} from '../src/work/business-configuration-lock.ts'
import type {BusinessObjectTypeDefinitionV2,BusinessRecordCreate} from '@teloa/contract'

let pool:Pool,container:StartedPostgreSqlContainer
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const unavailable=async():Promise<never>=>{throw Error('不得访问市场或外部来源')}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await api.initializeBusinessSpaces(pool);await api.initializeBusinessDefinitions(pool);await api.initializeBusinessConfigurations(pool);await api.initializeBusinessRuntime(pool);await api.initializeBusinessData(pool);await api.initializeBusinessWarehouse(pool);await api.initializeBusinessSnapshotReferences(pool);await api.initializeBusinessRecords(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(uniqueFields:string[]|null=['code','customers']){
 const drafts=new api.BusinessConfigurationDraftService(pool,identity),store=new api.BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const runtime=new api.BusinessRuntimeService(pool,identity),spaces=new api.BusinessSpaceService(pool,identity)
 const apply=new api.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime,spaces}),preview=new api.BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 const actor={ownerId:'relations:'+randomUUID(),scopeIds:[] as string[]}
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'项目客户',format:'teloa.business-configuration/v2'})
 const base={format:'teloa.business-object-type/v2',version:'1.0.0',domain:draft.scope,title:'客户',unit:'个',lead:'本地记录',sourceId:draft.candidate.sources[0]!.sourceId}
 const customer={...base,id:'customer',fields:[{name:'code',label:'编号',type:'text',required:false,from:'原编号'}]} as BusinessObjectTypeDefinitionV2
 const project={...base,id:'project',title:'项目',fields:[...customer.fields,{format:'teloa.business-rich-field/v2',name:'customers',label:'客户',type:'multi-reference',referenceType:'customer',required:false,from:'原客户'}],...(uniqueFields?{constraints:{uniqueFields}}:{})} as BusinessObjectTypeDefinitionV2
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:customer},{kind:'object-type',definition:project}],upsertPages:[{id:'projects',title:'项目',kind:'records',objectType:'project',fields:['code','customers'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'projects'}})
 const input={requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:(await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt}
 await apply.apply(actor,input);actor.scopeIds=[draft.scope]
 const dependencies={definitions,warehouse:new api.BusinessWarehouseService(pool,identity),references:new api.BusinessSnapshotReferenceService(pool,identity)}
 const records=new api.BusinessRecordService(pool,identity,dependencies)
 const create=(type:string,code:string|undefined,ids:string[]=[]):BusinessRecordCreate=>({scope:draft.scope,type,requestId:randomUUID(),title:type,summary:'',fields:[...(code===undefined?[]:[{name:'code',value:code}]),...(ids.length?[{name:'customers',value:JSON.stringify([...ids].sort())}]:[])]})
 return {drafts,store,definitions,apply,preview,actor,draft,project,customer,input,records,dependencies,create}
}
async function counts(owner:string){
 const result:number[]=[]
 for(const table of ['teloa_business_object_snapshots','teloa_business_record_heads','teloa_business_record_receipts','teloa_business_record_batches','teloa_business_snapshot_references','teloa_business_configuration_versions','teloa_business_local_definitions','teloa_business_configuration_receipts'])result.push((await pool.query('select count(*)::int n from '+table+' where owner_id=$1',[owner])).rows[0].n)
 return result
}
function edit(row:Awaited<ReturnType<api.BusinessRecordService['create']>>,input:BusinessRecordCreate){return {...input,id:row.id,expectedVersion:row.version}}
function archive(row:Awaited<ReturnType<api.BusinessRecordService['create']>>){return {scope:row.scope,type:row.type,id:row.id,expectedVersion:row.version,requestId:randomUUID()}}
async function blockedBy(client:PoolClient,count:number){
 const pid=(await client.query('select pg_backend_pid() pid')).rows[0].pid
 for(let i=0;i<6000;i++){
  if(((await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[pid])).rowCount??0)>=count)return
  await new Promise<void>(resolve=>setImmediate(resolve))
 }
 throw Error('未观察到独立PG事务等待指定锁')
}
async function revise(f:Awaited<ReturnType<typeof fixture>>,definition:BusinessObjectTypeDefinitionV2){
 let draft=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:f.draft.scope,title:'项目客户',format:'teloa.business-configuration/v2'})
 return f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,patch:{upsertDefinitions:[{kind:'object-type',definition}]}})
}
function adoptInput(draft:Awaited<ReturnType<typeof revise>>,receipt:string){return {requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:draft.baseVersion,previewReceipt:receipt}}

test('多个真实本地目标固定ID，改名与重建读取不改数组，失效关系可清除',async()=>{
 const f=await fixture(),a=await f.records.create(f.actor,f.create('customer','C1')),b=await f.records.create(f.actor,f.create('customer','C2'))
 const input=f.create('project','P1',[a.id,b.id]),first=await f.records.create(f.actor,input)
 assert.deepEqual(first.fields,[{label:'原编号',value:'P1'},{label:'原客户',value:JSON.stringify([a.id,b.id].sort())}])
 await f.records.edit(f.actor,{...edit(a,f.create('customer','C1')),title:'客户已改名'})
 await f.records.archive(f.actor,archive(b))
 const baseline=await counts(f.actor.ownerId),restored=new api.BusinessRecordService(pool,identity,f.dependencies)
 assert.deepEqual(await restored.create(f.actor,input),first);assert.deepEqual(await restored.receipt(f.actor,{requestId:input.requestId}),first)
 assert.deepEqual(await restored.get(f.actor,{scope:first.scope,type:first.type,id:first.id}),first)
 await assert.rejects(restored.edit(f.actor,edit(first,input)),{code:'teloa/conflict'})
 await assert.rejects(restored.edit(f.actor,edit(first,{...input,requestId:randomUUID()})),{code:'teloa/invalid-input'})
 assert.deepEqual(await counts(f.actor.ownerId),baseline)
 const cleared=await restored.edit(f.actor,edit(first,f.create('project','P1',[a.id])))
 assert.deepEqual(cleared.fields[1],{label:'原客户',value:JSON.stringify([a.id])})
})
test('每个多关联目标须同本人同业务同类型且活跃，缺失之一整次零写',async()=>{
 const f=await fixture(),foreign=await fixture(),a=await f.records.create(f.actor,f.create('customer','C1')),other=await foreign.records.create(foreign.actor,foreign.create('customer','F1')),wrong=await f.records.create(f.actor,f.create('project','P0'))
 const baseline=await counts(f.actor.ownerId)
 for(const ids of [[a.id,'missing'],[a.id,other.id],[a.id,wrong.id]])await assert.rejects(f.records.create(f.actor,f.create('project',randomUUID(),ids)),{code:'teloa/invalid-input'})
 assert.deepEqual(await counts(f.actor.ownerId),baseline)
 const draft=await revise(f,{...f.project,fields:f.project.fields.map(field=>field.name==='customers'?{...field,referenceType:'missing'}:field)} as BusinessObjectTypeDefinitionV2)
 await assert.rejects(f.preview.preview(f.actor,{draftId:draft.id,expectedRevision:draft.revision}),{code:'teloa/invalid-input'})
})
test('多目标中任一来源/摘要/head/孤立快照损坏均不按缺失放行',async()=>{
 for(const fault of ['source','body-source','hash','head','orphan']){
  const f=await fixture(),a=await f.records.create(f.actor,f.create('customer','C1')),b=await f.records.create(f.actor,f.create('customer','C2'))
  if(fault==='source')await pool.query("update teloa_business_object_snapshots set source_id='external' where owner_id=$1 and object_id=$2",[f.actor.ownerId,b.id])
  if(fault==='body-source'){
   const {snapshotHash:_,...raw}=b,changed={...raw,source:'external'}
   await pool.query('update teloa_business_object_snapshots set snapshot=$3,snapshot_hash=$4 where owner_id=$1 and object_id=$2',[f.actor.ownerId,b.id,JSON.stringify(changed),businessObjectSnapshotHash(changed)])
  }
  if(fault==='hash')await pool.query("update teloa_business_object_snapshots set snapshot_hash=repeat('0',64) where owner_id=$1 and object_id=$2",[f.actor.ownerId,b.id])
  if(fault==='head'){
   const {snapshotHash:_,...raw}=b,changed={...raw,version:2}
   await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,2,$5,$6,$7,now())',[f.actor.ownerId,b.scope,b.type,b.id,businessObjectSnapshotHash(changed),JSON.stringify(changed),f.customer.sourceId])
  }
  if(fault==='orphan')await pool.query('delete from teloa_business_record_heads where owner_id=$1 and object_id=$2',[f.actor.ownerId,b.id])
  const baseline=await counts(f.actor.ownerId)
  await assert.rejects(f.records.create(f.actor,f.create('project','P1',[a.id,b.id])),{code:'teloa/storage-corrupt'},fault)
  assert.deepEqual(await counts(f.actor.ownerId),baseline)
 }
})
test('逐字段唯一拒绝重复值和重叠成员，缺值可重复，归档释放占用',async()=>{
 const f=await fixture(),a=await f.records.create(f.actor,f.create('customer','C1')),b=await f.records.create(f.actor,f.create('customer','C2'))
 const first=await f.records.create(f.actor,f.create('project','P1',[a.id]))
 const baseline=await counts(f.actor.ownerId)
 for(const input of [f.create('project','P1',[b.id]),f.create('project','P2',[a.id,b.id])])await assert.rejects(f.records.create(f.actor,input),{code:'teloa/conflict'})
 assert.deepEqual(await counts(f.actor.ownerId),baseline)
 await f.records.create(f.actor,f.create('project',undefined));await f.records.create(f.actor,f.create('project',undefined))
 await f.records.archive(f.actor,archive(first))
 const reused=await f.records.create(f.actor,f.create('project','P1',[a.id]));assert.equal(reused.version,1)
})
test('两个新源抢同一唯一成员在类型锁后只成功一个，失败不留任何写入',async()=>{
 const f=await fixture(),target=await f.records.create(f.actor,f.create('customer','C1')),baseline=await counts(f.actor.ownerId),block=await pool.connect()
 await block.query('begin');await lockBusinessConfiguration(block,f.actor.ownerId,target.scope,'shared');await lockBusinessRecordTypes(block,f.actor.ownerId,target.scope,['project'])
 const inputs=[f.create('project','P1',[target.id]),f.create('project','P2',[target.id])],pending=Promise.allSettled(inputs.map(input=>f.records.create(f.actor,input)))
 try{await blockedBy(block,2)}finally{await block.query('commit');block.release()}
 const settled=await pending
 assert.equal(settled.filter(row=>row.status==='fulfilled').length,1);assert.equal(settled.filter(row=>row.status==='rejected'&&row.reason.code==='teloa/conflict').length,1)
 const after=await counts(f.actor.ownerId);assert.deepEqual(after.slice(0,5),baseline.slice(0,5).map((n,i)=>n+[1,1,1,0,1][i]!))
 for(const [index,row] of settled.entries())assert.equal(await f.records.receipt(f.actor,{requestId:inputs[index]!.requestId})!==undefined,row.status==='fulfilled')
})
test('同批全部后态允许交换与归档释放，与操作排列无关，失败批次零写',async()=>{
 for(const reverse of [false,true]){
  const f=await fixture(),a=await f.records.create(f.actor,f.create('customer','C1')),b=await f.records.create(f.actor,f.create('customer','C2')),p=await f.records.create(f.actor,f.create('project','P1',[a.id])),q=await f.records.create(f.actor,f.create('project','P2',[b.id]))
  const ops=[{operation:'edit',type:'project',id:p.id,expectedVersion:1,fields:f.create('project','P2',[b.id]).fields},{operation:'edit',type:'project',id:q.id,expectedVersion:1,fields:f.create('project','P1',[a.id]).fields}]
  const swapped=await f.records.batch(f.actor,{scope:p.scope,requestId:randomUUID(),operations:reverse?[...ops].reverse():ops})
  assert.equal(swapped.items.length,2)
  const changed=swapped.items.find(row=>row.id===p.id)!,release=[{operation:'create',type:'project',title:'新项目',summary:'',fields:f.create('project','P2',[b.id]).fields},{operation:'archive',type:'project',id:changed.id,expectedVersion:2}]
  const released=await f.records.batch(f.actor,{scope:p.scope,requestId:randomUUID(),operations:reverse?[...release].reverse():release})
  assert.equal(released.items.length,2)
  const baseline=await counts(f.actor.ownerId),requestId=randomUUID()
  await assert.rejects(f.records.batch(f.actor,{scope:p.scope,requestId,operations:[{operation:'create',type:'project',title:'可用',summary:'',fields:f.create('project','unused').fields},{operation:'create',type:'project',title:'重复',summary:'',fields:f.create('project','P1').fields}]}),{code:'teloa/conflict'})
  assert.equal(await f.records.batchReceipt(f.actor,{requestId}),undefined);assert.deepEqual(await counts(f.actor.ownerId),baseline)
 }
})
test('新增唯一约束现存重复时预览不签回执，采用锁内重新检查迟到重复',async()=>{
 const f=await fixture(null),a=await f.records.create(f.actor,f.create('customer','C1'))
 const first=await f.records.create(f.actor,f.create('project','P1',[a.id]))
 const draft=await revise(f,{...f.project,constraints:{uniqueFields:['code','customers']}}),preview=await f.preview.preview(f.actor,{draftId:draft.id,expectedRevision:draft.revision}),input=adoptInput(draft,preview.receipt)
 await f.records.create(f.actor,f.create('project','P1',[a.id]))
 const baseline=await counts(f.actor.ownerId)
 await assert.rejects(f.preview.preview(f.actor,{draftId:draft.id,expectedRevision:draft.revision}),{code:'teloa/conflict'})
 await assert.rejects(f.apply.apply(f.actor,input),{code:'teloa/conflict'})
 assert.deepEqual(await counts(f.actor.ownerId),baseline);assert.equal(await f.apply.receipt(f.actor,{requestId:input.requestId}),undefined)
 assert.deepEqual(await f.records.get(f.actor,{scope:first.scope,type:first.type,id:first.id}),first)
})
test('合法增加移除唯一约束不重写旧快照，原成功请求仍优先回放',async()=>{
 const f=await fixture(null),input=f.create('project','P1'),first=await f.records.create(f.actor,input)
 const snapshots=(await pool.query('select snapshot_hash,snapshot from teloa_business_object_snapshots where owner_id=$1 order by object_type,object_id,object_version',[f.actor.ownerId])).rows
 const add=await revise(f,{...f.project,constraints:{uniqueFields:['code']}}),adopt=adoptInput(add,(await f.preview.preview(f.actor,{draftId:add.id,expectedRevision:add.revision})).receipt)
 await f.apply.apply(f.actor,adopt)
 assert.deepEqual(await f.records.create(f.actor,input),first)
 await assert.rejects(f.records.create(f.actor,f.create('project','P1')),{code:'teloa/conflict'})
 const remove=await revise(f,f.project),removeInput=adoptInput(remove,(await f.preview.preview(f.actor,{draftId:remove.id,expectedRevision:remove.revision})).receipt)
 await f.apply.apply(f.actor,removeInput)
 assert.deepEqual((await pool.query('select snapshot_hash,snapshot from teloa_business_object_snapshots where owner_id=$1 order by object_type,object_id,object_version',[f.actor.ownerId])).rows,snapshots)
 await f.records.create(f.actor,f.create('project','P1'))
 assert.deepEqual(await f.apply.apply(f.actor,adopt),await f.apply.receipt(f.actor,{requestId:adopt.requestId}))
})
test('无约束本地写和归档仍使用同一源类型锁，不能绕过未来约束串行',async()=>{
 const f=await fixture(null),first=await f.records.create(f.actor,f.create('project','P1')),block=await pool.connect()
 await block.query('begin');await lockBusinessConfiguration(block,f.actor.ownerId,first.scope,'shared');await lockBusinessRecordTypes(block,f.actor.ownerId,first.scope,['project'])
 const pending=Promise.all([f.records.create(f.actor,f.create('project','P2')),f.records.archive(f.actor,archive(first))])
 try{await blockedBy(block,2)}finally{await block.query('commit');block.release()}
 const [created,archived]=await pending;assert.equal(created.version,1);assert.equal(archived.version,2);assert.ok(archived.deletedAt)
})
test('预览新增唯一约束须核真实当前head和来源，不能相信伪造的活跃快照',async()=>{
 for(const fault of ['head-source','body-source','orphan']){
  const f=await fixture(null),first=await f.records.create(f.actor,f.create('project','P1')),draft=await revise(f,{...f.project,constraints:{uniqueFields:['code']}})
  if(fault==='head-source')await pool.query("update teloa_business_record_heads set source_id='external' where owner_id=$1",[f.actor.ownerId])
  if(fault==='body-source'){
   const {snapshotHash:_,...body}=first,changed={...body,source:'external'}
   await pool.query('update teloa_business_object_snapshots set snapshot=$2,snapshot_hash=$3 where owner_id=$1',[f.actor.ownerId,JSON.stringify(changed),businessObjectSnapshotHash(changed)])
  }
  if(fault==='orphan')await pool.query('delete from teloa_business_record_heads where owner_id=$1',[f.actor.ownerId])
  const baseline=await counts(f.actor.ownerId)
  await assert.rejects(f.preview.preview(f.actor,{draftId:draft.id,expectedRevision:draft.revision}),{code:'teloa/storage-corrupt'},fault)
  assert.deepEqual(await counts(f.actor.ownerId),baseline)
 }
})
test('唯一字段由真实数字布尔时长和精确金额语义计算，非字符串比较',async()=>{
 const f=await fixture(null),definition={...f.project,fields:[...f.project.fields,
  {name:'number',label:'数量',from:'数量',type:'number',required:false},
  {name:'boolean',label:'有效',from:'有效',type:'boolean',required:false},
  {name:'duration',label:'时长',from:'时长',type:'duration',required:false},
  {format:'teloa.business-rich-field/v2',name:'money',label:'金额',from:'金额',type:'money',currencies:['CNY','USD'],required:false},
 ],constraints:{uniqueFields:['number','boolean','duration','money']}} as BusinessObjectTypeDefinitionV2
 const draft=await revise(f,definition),input=adoptInput(draft,(await f.preview.preview(f.actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt)
 await f.apply.apply(f.actor,input)
 const amount='{"currency":"CNY","decimal":"9007199254740993.0001"}'
 await f.records.create(f.actor,{...f.create('project','P1'),fields:[{name:'number',value:'1e3'},{name:'boolean',value:'是'},{name:'duration',value:'PT5M'},{name:'money',value:amount}]})
 const baseline=await counts(f.actor.ownerId)
 for(const [name,value] of [['number','1000'],['boolean','true'],['duration','300'],['money',amount]])await assert.rejects(f.records.create(f.actor,{...f.create('project','P2'),fields:[{name:name!,value:value!}]}),{code:'teloa/conflict',details:{reason:'unique-field',field:name}})
 assert.deepEqual(await counts(f.actor.ownerId),baseline)
 for(const value of ['{"currency":"USD","decimal":"9007199254740993.0001"}','{"currency":"CNY","decimal":"9007199254740993.0002"}'])await f.records.create(f.actor,{...f.create('project','P3'),fields:[{name:'money',value}]})
})
test('单选关联唯一形成一对一，编辑空值和归档释放占用，历史成功回执不翻判',async()=>{
 const f=await fixture(null),definition={...f.project,fields:[...f.project.fields,{name:'customer',label:'负责客户',from:'原负责客户',type:'reference',referenceType:'customer',required:false}],constraints:{uniqueFields:['customer']}} as BusinessObjectTypeDefinitionV2
 const draft=await revise(f,definition),adoption=adoptInput(draft,(await f.preview.preview(f.actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt)
 await f.apply.apply(f.actor,adoption)
 const a=await f.records.create(f.actor,f.create('customer','C1')),b=await f.records.create(f.actor,f.create('customer','C2'))
 const single=(code:string,target?:string):BusinessRecordCreate=>({...f.create('project',code),fields:[{name:'code',value:code},...(target===undefined?[]:[{name:'customer',value:target}])]})
 const pInput=single('P1',a.id),qInput=single('P2',b.id),p=await f.records.create(f.actor,pInput),q=await f.records.create(f.actor,qInput)
 assert.deepEqual(p.fields,[{label:'原编号',value:'P1'},{label:'原负责客户',value:a.id}])
 const duplicate=edit(q,single('P2',a.id)),baseline=await counts(f.actor.ownerId)
 await assert.rejects(f.records.edit(f.actor,duplicate),{code:'teloa/conflict',details:{reason:'unique-field',field:'customer'}})
 assert.deepEqual(await counts(f.actor.ownerId),baseline);assert.equal(await f.records.receipt(f.actor,{requestId:duplicate.requestId}),undefined)
 assert.deepEqual(await f.records.get(f.actor,{scope:q.scope,type:q.type,id:q.id}),q)
 const pEmpty=await f.records.edit(f.actor,edit(p,single('P1'))),qMoved=await f.records.edit(f.actor,edit(q,single('P2',a.id)))
 assert.deepEqual(qMoved.fields,[{label:'原编号',value:'P2'},{label:'原负责客户',value:a.id}])
 const qEmpty=await f.records.edit(f.actor,edit(qMoved,single('P2','')))
 assert.deepEqual(pEmpty.fields,[{label:'原编号',value:'P1'}]);assert.deepEqual(qEmpty.fields,[{label:'原编号',value:'P2'}])
 // 两源同时空值不占用；单条修改已释放原目标，随后重新绑定仍遵守唯一。
 const pAgain=await f.records.edit(f.actor,edit(pEmpty,single('P1',a.id))),qAgain=await f.records.edit(f.actor,edit(qEmpty,single('P2',b.id)))
 const archived=await f.records.archive(f.actor,archive(pAgain));assert.ok(archived.deletedAt)
 const rebound=await f.records.edit(f.actor,edit(qAgain,single('P2',a.id)))
 assert.deepEqual(rebound.fields,[{label:'原编号',value:'P2'},{label:'原负责客户',value:a.id}])
 await f.records.archive(f.actor,archive(a))
 const replayBaseline=await counts(f.actor.ownerId)
 assert.deepEqual(await f.records.create(f.actor,pInput),p);assert.deepEqual(await f.records.receipt(f.actor,{requestId:pInput.requestId}),p)
 assert.deepEqual(await f.records.create(f.actor,qInput),q);assert.deepEqual(await f.records.receipt(f.actor,{requestId:qInput.requestId}),q)
 assert.deepEqual(await counts(f.actor.ownerId),replayBaseline)
})
