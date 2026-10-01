import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {open,readFile,unlink,type FileHandle} from 'node:fs/promises'
import {join} from 'node:path'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as api from '../src/index.ts'
import {BusinessRecordImportService,initializeBusinessRecordImports} from '../src/work/business-record-imports.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import {parseBusinessImportCsv} from '../src/work/business-import-csv.ts'
import {readBusinessObjectSnapshot,businessObjectSnapshotHash} from '../src/work/business-data.ts'
import {WorkError,readBusinessImportMapping,type BusinessImportAnyDraft,type BusinessImportDraft,type BusinessImportDraftV2,type BusinessImportXlsxPort,type BusinessImportTableV2,type BusinessImportActor,type BusinessObjectFieldDefinition} from '@teloa/contract'
import {businessImportHash} from '../src/work/business-record-import-preview.ts'

// 真实PG测试由主控串行运行；文件/表端口使用隔离内存文件和唯一CSV解析器。
let pool:Pool,container:StartedPostgreSqlContainer,dbLock:FileHandle|undefined
const lockPath='/tmp/teloa-db-test.lock',lockOwner=JSON.stringify({pid:process.pid,task:'xlsx-task-1-business-record-imports',token:randomUUID()})
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const unavailable=async():Promise<never>=>{throw Error('不得访问市场或远端来源')}
before(async()=>{
 dbLock=await open(lockPath,'wx');await dbLock.writeFile(lockOwner)
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await api.initializeBusinessSpaces(pool);await api.initializeBusinessDefinitions(pool);await api.initializeBusinessConfigurations(pool);await api.initializeBusinessRuntime(pool)
 await api.initializeBusinessData(pool);await api.initializeBusinessWarehouse(pool);await api.initializeBusinessSnapshotReferences(pool);await api.initializeBusinessRecords(pool);await initializeBusinessRecordImports(pool)
},{timeout:120000})
after(async()=>{
 const errors:unknown[]=[]
 try{await pool?.end()}catch(error){errors.push(error)}
 try{await container?.stop()}catch(error){errors.push(error)}
 if(dbLock){await dbLock.close();if(!errors.length&&await readFile(lockPath,'utf8')===lockOwner)await unlink(lockPath)}
 if(errors.length)throw new AggregateError(errors,'数据库测试清理失败，保留本人锁供主控核对。')
})
const fields:BusinessObjectFieldDefinition[]=[{name:'state',label:'状态',from:'状态',type:'text',required:true}]
const mapping=readBusinessImportMapping({delimiter:',',headerRow:1,primaryKey:[{column:0,trim:false}],title:{column:1,trim:false},fields:[{field:'state',value:{column:2,trim:false}}]})
async function fixture(ownerId:string=randomUUID(),fieldDefinitions=fields,extraTypes:string[]=[],versioned=false){
 const drafts=new api.BusinessConfigurationDraftService(pool,identity),store=new api.BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const runtime=new api.BusinessRuntimeService(pool,identity),spaces=new api.BusinessSpaceService(pool,identity)
 const configuration=new api.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime,spaces}),configurationPreview=new api.BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 const actor:BusinessImportActor={ownerId,scopeIds:[]}
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'客户业务',...(versioned?{format:'teloa.business-configuration/v2'}:{})})
 const definition={format:versioned?'teloa.business-object-type/v2' as const:'teloa.business-object-type/v1' as const,id:'customer',version:'1.0.0',domain:draft.scope,title:'客户',unit:'条',lead:'客户记录',sourceId:draft.candidate.sources[0]!.sourceId,fields:fieldDefinitions}
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition},...extraTypes.map(id=>({kind:'object-type',definition:{...definition,id,title:id,fields}}))],upsertPages:[{id:'home',title:'记录',kind:'records',objectType:'customer',fields:fieldDefinitions.map(field=>field.name),allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}})
 await configuration.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:(await configurationPreview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt})
 actor.scopeIds=(await new api.BusinessScopeService(pool).list(actor.ownerId)).map(row=>row.scope)
 const warehouse=new api.BusinessWarehouseService(pool,identity),references=new api.BusinessSnapshotReferenceService(pool,identity)
 const records=new api.BusinessRecordService(pool,identity,{definitions,warehouse,references})
 const filesById=new Map<string,Uint8Array>();let saved=0,read=0,parsed=0
 const files={save:async(input:{dataBase64:string;name:string;bytes:number})=>{
  saved++;const bytes=Buffer.from(input.dataBase64,'base64'),attachmentId=randomUUID();filesById.set(attachmentId,bytes)
  return {attachmentId,name:input.name,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}
 },read:async(file:{attachmentId:string})=>{read++;const bytes=filesById.get(file.attachmentId);if(!bytes)throw new WorkError('teloa/file-unavailable','文件不可读。');return bytes}}
 const tables={parse:async(bytes:Uint8Array,input:{delimiter:','|';'|'\t'},signal?:AbortSignal)=>{parsed++;return parseBusinessImportCsv(bytes,input.delimiter,signal)}}
 const dependencies={definitions,store,records,references,files,tables},imports=new BusinessRecordImportService(pool,identity,dependencies)
 const stageInput=(text='编号,标题,状态\n001,第一位,新\n002,第二位,旧',name='customers.csv',requestId=randomUUID())=>({requestId,scope:draft.scope,type:'customer',name,bytes:Buffer.byteLength(text),dataBase64:Buffer.from(text).toString('base64')})
 const stage=async(text?:string,name?:string)=>imports.stage(actor,stageInput(text,name))
 const prepare=async(text?:string,name?:string)=>{const staged=await stage(text,name);return imports.preview(actor,{draftId:staged.id,expectedRevision:staged.revision,mapping})}
 const confirm=(previewed:BusinessImportAnyDraft,requestId=randomUUID())=>({requestId,draftId:previewed.id,previewRevision:previewed.preview!.revision,previewDigest:previewed.preview!.digest})
 const rename=async(patch:Record<string,unknown>)=>{
  let candidate=await drafts.begin(actor,{requestId:randomUUID(),title:'客户业务',scope:draft.scope})
  candidate=await drafts.revise(actor,{requestId:randomUUID(),draftId:candidate.id,expectedRevision:candidate.revision,patch:{upsertDefinitions:[{kind:'object-type',definition:{...definition,...patch}}]}})
  await configuration.apply(actor,{requestId:randomUUID(),draftId:candidate.id,expectedRevision:candidate.revision,expectedBaseVersion:candidate.baseVersion,previewReceipt:(await configurationPreview.preview(actor,{draftId:candidate.id,expectedRevision:candidate.revision})).receipt})
 }
 return {actor,scope:draft.scope,definition,records,warehouse,references,imports,dependencies,filesById,stageInput,stage,prepare,confirm,rename,stats:()=>({saved,read,parsed})}
}
async function counts(owner:string){
 const result:number[]=[]
 for(const table of ['teloa_business_object_snapshots','teloa_business_record_heads','teloa_business_record_receipts','teloa_business_record_batches','teloa_business_record_import_receipts','teloa_business_record_import_source_keys','teloa_business_snapshot_references'])result.push((await pool.query('select count(*)::int n from '+table+' where owner_id=$1',[owner])).rows[0].n)
 return result
}
test('same_stage_request_replays_one_draft_and_changed_input_conflicts',async()=>{
 const f=await fixture(),input=f.stageInput(),first=await f.imports.stage(f.actor,input)
 assert.equal(first.revision,1)
 assert.deepEqual(await f.imports.stage(f.actor,input),first);assert.equal(f.stats().saved,1)
 await assert.rejects(f.imports.stage(f.actor,{...input,name:'other.csv'}),{code:'teloa/conflict'})
 assert.equal((await pool.query('select count(*)::int n from teloa_business_record_import_drafts where owner_id=$1',[f.actor.ownerId])).rows[0].n,1)
})
test('stage_receipt_recovers_without_draft_id_and_rechecks_owner_scope_type',async()=>{
 const f=await fixture(),input=f.stageInput(),staged=await f.imports.stage(f.actor,input)
 const rebuilt=new BusinessRecordImportService(pool,identity,f.dependencies)
 assert.deepEqual(await rebuilt.stageReceipt(f.actor,{requestId:input.requestId,scope:f.scope,type:'customer'}),staged)
 assert.equal(await rebuilt.stageReceipt({...f.actor,ownerId:randomUUID()},{requestId:input.requestId,scope:f.scope,type:'customer'}),undefined)
 await assert.rejects(rebuilt.stageReceipt({...f.actor,scopeIds:[]},{requestId:input.requestId,scope:f.scope,type:'customer'}),{code:'teloa/forbidden'})
 await assert.rejects(rebuilt.stageReceipt(f.actor,{requestId:input.requestId,scope:f.scope,type:'other'}),{code:'teloa/forbidden'})
 assert.equal(f.stats().saved,1)
})
test('inspect_does_not_change_revision_or_write_records',async()=>{
 const f=await fixture(),staged=await f.stage(),before=await counts(f.actor.ownerId)
 const inspection=await f.imports.inspect(f.actor,{draftId:staged.id,expectedRevision:1,delimiter:','})
 assert.equal(inspection.complete,true);assert.equal(inspection.dataRows,2)
 assert.equal((await f.imports.get(f.actor,{draftId:staged.id})).revision,1)
 assert.deepEqual(await counts(f.actor.ownerId),before)
 const empty=await f.stage('','empty.csv'),failed=await f.imports.inspect(f.actor,{draftId:empty.id,expectedRevision:1,delimiter:','})
 assert.equal(failed.complete,false);assert.equal(failed.issues[0]!.code,'empty-table')
})
test('preview_is_zero_write_and_preserves_source_rows',async()=>{
 const f=await fixture(),draft=await f.prepare()
 assert.equal(draft.revision,2);assert.equal(draft.preview!.canApply,true)
 assert.deepEqual(draft.preview!.rows.map(row=>row.rowNumber),[2,3]);assert.deepEqual(await counts(f.actor.ownerId),[0,0,0,0,0,0,0])
})
test('same_preview_input_replays_accepted_revision_without_another_revision',async()=>{
 const f=await fixture(),staged=await f.stage(),input={draftId:staged.id,expectedRevision:1,mapping},first=await f.imports.preview(f.actor,input)
 assert.deepEqual(await f.imports.preview(f.actor,input),first)
 const newPreview=await f.imports.preview(f.actor,{...input,expectedRevision:first.revision})
 assert.equal(newPreview.revision,3);assert.deepEqual(await counts(f.actor.ownerId),[0,0,0,0,0,0,0])
 const second=await f.stage(),same={draftId:second.id,expectedRevision:1,mapping},concurrent=await Promise.all([f.imports.preview(f.actor,same),f.imports.preview(f.actor,same)])
 assert.deepEqual(concurrent[0],concurrent[1]);assert.equal(concurrent[0]!.revision,2)
})
test('different_owners_and_scopes_cannot_read_or_apply',async()=>{
 const f=await fixture(),draft=await f.prepare(),input=f.confirm(draft)
 await assert.rejects(f.imports.get({...f.actor,ownerId:randomUUID()},{draftId:draft.id}),{code:'teloa/not-found'})
 await assert.rejects(f.imports.apply({...f.actor,scopeIds:[]},input),{code:'teloa/forbidden'})
 await assert.rejects(f.imports.apply({...f.actor,ownerId:randomUUID()},input),{code:'teloa/not-found'})
 assert.deepEqual(await counts(f.actor.ownerId),[0,0,0,0,0,0,0])
})
test('same_request_different_preview_conflicts',async()=>{
 const f=await fixture(),draft=await f.prepare(),input=f.confirm(draft),first=await f.imports.apply(f.actor,input),before=await counts(f.actor.ownerId)
 assert.deepEqual(await f.imports.apply(f.actor,input),first)
 await assert.rejects(f.imports.apply(f.actor,{...input,previewDigest:'a'.repeat(64)}),{code:'teloa/conflict'})
 assert.deepEqual(await counts(f.actor.ownerId),before)
})
test('ordinary_batch_request_is_not_adopted_as_an_import_with_unchanged_or_renamed_schema',async()=>{
 for(const rename of [false,true]){
  const f=await fixture(),draft=await f.prepare(),request=f.confirm(draft),ordinary={requestId:request.requestId,scope:f.scope,operations:draft.preview!.rows.map(row=>row.operation)}
  const batch=await f.records.batch(f.actor,ordinary)
  if(rename)await f.rename({version:'1.0.1',title:'改名后的客户'})
  const before=await counts(f.actor.ownerId),unchanged=await f.imports.get(f.actor,{draftId:draft.id})
  assert.deepEqual(before,[2,2,2,1,0,0,2])
  await assert.rejects(f.imports.apply(f.actor,request),{code:'teloa/conflict'})
  assert.deepEqual(await counts(f.actor.ownerId),before)
  assert.deepEqual(await f.imports.get(f.actor,{draftId:draft.id}),unchanged)
  assert.equal(await f.imports.receipt(f.actor,{requestId:request.requestId,scope:f.scope}),undefined)
  // 记录原语原有成功事实仍沿默认回放，不能被导入的new-only政策改写。
  assert.deepEqual(await f.records.batch(f.actor,ordinary),batch)
 }
})
test('ordinary_batch_and_import_with_the_same_request_serialize_without_adopting_an_ordinary_winner',async()=>{
 for(const first of ['ordinary','import'] as const){
  const f=await fixture(),draft=await f.prepare(),request=f.confirm(draft),ordinaryInput={requestId:request.requestId,scope:f.scope,operations:draft.preview!.rows.map(row=>row.operation)}
  const gate=await pool.connect()
  const pending=await (async()=>{
   await gate.query('begin')
   try{
    await gate.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-record-request',f.actor.ownerId,request.requestId])])
    if(first==='ordinary'){
     const ordinary=f.records.batch(f.actor,ordinaryInput)
     await blockedBy(gate)
     return {ordinary,imported:f.imports.apply(f.actor,request)}
    }
    const imported=f.imports.apply(f.actor,request)
    await blockedBy(gate)
    return {imported,ordinary:f.records.batch(f.actor,ordinaryInput)}
   }finally{await gate.query('rollback');gate.release()}
  })()
  const [imported,ordinary]=await Promise.allSettled([pending.imported,pending.ordinary] as const)
  assert.equal(ordinary.status,'fulfilled')
  if(first==='ordinary'){
   assert.equal(imported.status,'rejected')
   if(imported.status==='rejected')assert.equal(imported.reason.code,'teloa/conflict')
   assert.deepEqual(await counts(f.actor.ownerId),[2,2,2,1,0,0,2])
   assert.deepEqual(await f.imports.get(f.actor,{draftId:draft.id}),draft)
  }else{
   assert.equal(imported.status,'fulfilled')
   assert.deepEqual(await counts(f.actor.ownerId),[2,2,2,1,1,2,4])
   const current=await f.imports.get(f.actor,{draftId:draft.id})
   assert.equal(current.status,'applied')
   if(imported.status==='fulfilled'&&ordinary.status==='fulfilled'){
    assert.deepEqual(current.receipt,imported.value)
    assert.deepEqual(ordinary.value.items.map(item=>({scope:item.scope,type:item.type,id:item.id,version:item.version,snapshotHash:item.snapshotHash})),imported.value.references)
   }
  }
 }
})
test('different_request_same_content_returns_canonical_receipt_and_filename_is_not_identity',async()=>{
 const f=await fixture(),firstDraft=await f.prepare(),first=await f.imports.apply(f.actor,f.confirm(firstDraft)),before=await counts(f.actor.ownerId)
 const reuploaded=await f.prepare(undefined,'renamed.csv'),request=f.confirm(reuploaded),alias=await f.imports.apply(f.actor,request)
 assert.equal(alias.requestId,request.requestId);assert.equal(alias.draftId,reuploaded.id);assert.equal(alias.previewDigest,reuploaded.preview!.digest)
 assert.equal(alias.canonicalRequestId,first.requestId);assert.deepEqual(alias.references,first.references);assert.equal(alias.appliedAt,first.appliedAt)
 const after=await counts(f.actor.ownerId);assert.deepEqual(after,[before[0],before[1],before[2],before[3],before[4]!+1,before[5],before[6]])
 assert.equal((await f.imports.get(f.actor,{draftId:reuploaded.id})).status,'applied')
})
test('same_source_changed_key_trim_mapping_or_write_schema_conflicts',async()=>{
 const f=await fixture(),first=await f.prepare();await f.imports.apply(f.actor,f.confirm(first));const before=await counts(f.actor.ownerId)
 for(const altered of [{...mapping,primaryKey:[{column:0,trim:true}]},{...mapping,title:{column:1,trim:true}},{...mapping,primaryKey:[{column:1,trim:false},{column:0,trim:false}]}]){
  const staged=await f.stage(),bad=await f.imports.preview(f.actor,{draftId:staged.id,expectedRevision:1,mapping:altered})
  assert.equal(bad.preview!.canApply,false);assert.ok(bad.preview!.issues.some(issue=>issue.code==='source-policy-conflict'))
  await assert.rejects(f.imports.apply(f.actor,f.confirm(bad)),{code:'teloa/conflict'})
 }
 await f.rename({version:'1.0.1',fields:fields.map(field=>({...field,required:false}))})
 const changed=await f.prepare();assert.equal(changed.preview!.canApply,false)
 assert.deepEqual(await counts(f.actor.ownerId),before)
})
test('simultaneous_confirms_create_one_batch',async()=>{
 const f=await fixture(),a=await f.prepare(),b=await f.prepare(undefined,'again.csv')
 const receipts=await Promise.all([f.imports.apply(f.actor,f.confirm(a)),f.imports.apply(f.actor,f.confirm(b))])
 assert.equal(receipts[0]!.canonicalRequestId,receipts[1]!.canonicalRequestId);assert.deepEqual(receipts[0]!.references,receipts[1]!.references)
 assert.deepEqual(await counts(f.actor.ownerId),[2,2,2,1,2,2,4])
})
test('different_request_on_the_applied_draft_returns_an_alias_without_another_batch',async()=>{
 const f=await fixture(),draft=await f.prepare(),first=await f.imports.apply(f.actor,f.confirm(draft))
 const alias=await f.imports.apply(f.actor,f.confirm(draft)),current=await f.imports.get(f.actor,{draftId:draft.id})
 assert.equal(alias.canonicalRequestId,first.requestId);assert.deepEqual(alias.references,first.references)
 assert.equal(current.status,'applied');assert.equal(current.revision,4);assert.equal((await counts(f.actor.ownerId))[0],2)
})
test('concurrent_same_source_with_different_policy_has_one_success_and_one_conflict',async()=>{
 const f=await fixture(),a=await f.prepare(),staged=await f.stage(),b=await f.imports.preview(f.actor,{draftId:staged.id,expectedRevision:1,mapping:{...mapping,primaryKey:[{column:0,trim:true}]}})
 const settled=await Promise.allSettled([f.imports.apply(f.actor,f.confirm(a)),f.imports.apply(f.actor,f.confirm(b))])
 assert.equal(settled.filter(result=>result.status==='fulfilled').length,1)
 assert.equal(settled.filter(result=>result.status==='rejected'&&result.reason.code==='teloa/conflict').length,1)
 assert.deepEqual(await counts(f.actor.ownerId),[2,2,2,1,1,2,4])
})
test('row_n_unique_reference_or_quota_failure_rolls_back_everything',async()=>{
 const f=await fixture(),previewed=await f.prepare(),before=await counts(f.actor.ownerId)
 const limited=new api.BusinessRecordService(pool,identity,{definitions:f.dependencies.definitions,warehouse:{tombstone:f.warehouse.tombstone.bind(f.warehouse),assertQuota:async()=>{throw new WorkError('teloa/invalid-input','记录配额不足。')}},references:f.references})
 const imports=new BusinessRecordImportService(pool,identity,{...f.dependencies,records:limited})
 await assert.rejects(imports.apply(f.actor,f.confirm(previewed)),{code:'teloa/invalid-input'})
 assert.deepEqual(await counts(f.actor.ownerId),before);assert.equal((await imports.get(f.actor,{draftId:previewed.id})).status,'previewed')
 const failPins=new BusinessRecordImportService(pool,identity,{...f.dependencies,references:{pinInTransaction:async(db,actor,input)=>{await f.references.pinInTransaction(db,actor,input);throw Error('import pin failed')}}})
 await assert.rejects(failPins.apply(f.actor,f.confirm(previewed)),/import pin failed/)
 assert.deepEqual(await counts(f.actor.ownerId),before)
 const unique=await fixture(randomUUID(),fields,[],true);await unique.rename({version:'1.0.1',constraints:{uniqueFields:['state']}})
 const duplicate=await unique.prepare('编号,标题,状态\n001,甲,新\n002,乙,新')
 await assert.rejects(unique.imports.apply(unique.actor,unique.confirm(duplicate)),{code:'teloa/conflict'})
 assert.deepEqual(await counts(unique.actor.ownerId),[0,0,0,0,0,0,0])
})
test('cancel_apply_race_has_one_truth_and_resume_retains_mapping_without_preview',async()=>{
 const f=await fixture(),draft=await f.prepare(),input=f.confirm(draft),cancel={requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision}
 const result=await Promise.allSettled([f.imports.apply(f.actor,input),f.imports.cancel(f.actor,cancel)])
 const current=await f.imports.get(f.actor,{draftId:draft.id})
 if(current.status==='applied'){
  assert.equal(result[0]!.status,'fulfilled');assert.equal(result[1]!.status,'fulfilled')
  assert.equal((result[1] as PromiseFulfilledResult<BusinessImportDraft>).value.status,'applied')
 }else{
  assert.equal(current.status,'cancelled');assert.equal(result[0]!.status,'rejected');assert.equal((await counts(f.actor.ownerId))[0],0)
  const resume={requestId:randomUUID(),draftId:draft.id,expectedRevision:current.revision},ready=await f.imports.resume(f.actor,resume)
  assert.equal(ready.status,'ready');assert.deepEqual(ready.mapping,mapping);assert.equal(ready.preview,undefined)
  assert.deepEqual(await f.imports.resume(f.actor,resume),ready)
 }
})
test('cancel_before_apply_is_zero_write_and_cancel_after_apply_is_a_too_late_fact',async()=>{
 const f=await fixture(),first=await f.prepare(),cancel={requestId:randomUUID(),draftId:first.id,expectedRevision:first.revision},cancelled=await f.imports.cancel(f.actor,cancel)
 assert.equal(cancelled.status,'cancelled');assert.deepEqual(cancelled.mapping,mapping)
 assert.deepEqual(await f.imports.cancel(f.actor,cancel),cancelled)
 await assert.rejects(f.imports.apply(f.actor,f.confirm(first)),{code:'teloa/conflict'})
 assert.equal((await counts(f.actor.ownerId))[0],0)
 const ready=await f.imports.resume(f.actor,{requestId:randomUUID(),draftId:first.id,expectedRevision:cancelled.revision})
 assert.equal(ready.status,'ready');assert.equal(ready.preview,undefined);assert.deepEqual(ready.file,first.file)
 const previewed=await f.imports.preview(f.actor,{draftId:first.id,expectedRevision:ready.revision,mapping}),applied=await f.imports.apply(f.actor,f.confirm(previewed))
 const tooLate=await f.imports.cancel(f.actor,{requestId:randomUUID(),draftId:first.id,expectedRevision:previewed.revision})
 assert.equal(tooLate.status,'applied');assert.deepEqual(tooLate.receipt,applied)
 assert.equal((await counts(f.actor.ownerId))[0],2)
})
test('reference_archived_after_preview_rolls_back_the_entire_import',async()=>{
 const relationFields=[...fields,{name:'account',label:'客户关联',from:'客户关联',type:'reference' as const,referenceType:'account',required:true}]
 const f=await fixture(randomUUID(),relationFields,['account']),target=await f.records.create(f.actor,{requestId:randomUUID(),scope:f.scope,type:'account',title:'客户目标',summary:'',fields:[{name:'state',value:'有效'}]})
 const staged=await f.stage('编号,标题,状态,关联\n001,甲,新,'+target.id+'\n002,乙,新,'+target.id)
 const previewed=await f.imports.preview(f.actor,{draftId:staged.id,expectedRevision:1,mapping:{...mapping,fields:[...mapping.fields,{field:'account',value:{column:3,trim:false}}]}})
 assert.equal(previewed.preview!.canApply,true)
 await f.records.archive(f.actor,{requestId:randomUUID(),scope:f.scope,type:'account',id:target.id,expectedVersion:1})
 const before=await counts(f.actor.ownerId)
 await assert.rejects(f.imports.apply(f.actor,f.confirm(previewed)))
 assert.deepEqual(await counts(f.actor.ownerId),before);assert.equal((await f.imports.get(f.actor,{draftId:staged.id})).status,'previewed')
})
test('different_file_sources_with_key_001_create_distinct_uuid',async()=>{
 const f=await fixture(),a=await f.prepare('编号,标题,状态\n001,甲,新'),b=await f.prepare('编号,标题,状态\n001,乙,新')
 const first=await f.imports.apply(f.actor,f.confirm(a)),second=await f.imports.apply(f.actor,f.confirm(b))
 assert.notEqual(first.sourceIdentity,second.sourceIdentity);assert.notEqual(first.references[0]!.id,second.references[0]!.id)
 const other=await fixture(f.actor.ownerId),differentScope=await other.prepare('编号,标题,状态\n001,甲,新'),third=await other.imports.apply(other.actor,other.confirm(differentScope))
 assert.notEqual(first.sourceIdentity,third.sourceIdentity);assert.notEqual(first.references[0]!.id,third.references[0]!.id)
})
test('same_bytes_in_another_owner_or_type_cannot_adopt_the_original_batch',async()=>{
 const f=await fixture(randomUUID(),fields,['account']),text='编号,标题,状态\n001,甲,新',a=await f.prepare(text),first=await f.imports.apply(f.actor,f.confirm(a))
 const staged=await f.imports.stage(f.actor,{...f.stageInput(text),type:'account'}),b=await f.imports.preview(f.actor,{draftId:staged.id,expectedRevision:1,mapping}),second=await f.imports.apply(f.actor,f.confirm(b))
 const other=await fixture(),c=await other.prepare(text),third=await other.imports.apply(other.actor,other.confirm(c))
 assert.notEqual(first.sourceIdentity,second.sourceIdentity);assert.notEqual(first.canonicalRequestId,second.canonicalRequestId)
 assert.notEqual(first.sourceIdentity,third.sourceIdentity);assert.notEqual(first.canonicalRequestId,third.canonicalRequestId)
 assert.equal(await other.imports.receipt(other.actor,{requestId:first.requestId,scope:other.scope}),undefined)
})
test('nonlocal_or_orphan_snapshot_ownership_refuses_stage_without_business_writes',async()=>{
 const f=await fixture(),now=identity.now(),snapshot=readBusinessObjectSnapshot({scope:f.scope,type:'customer',id:randomUUID(),version:1,title:'外部旧记录',source:'旧同步来源',observedAt:now,receivedAt:now,quality:'complete',summary:'',fields:[{label:'状态',value:'新'}]},f.scope)
 await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[f.actor.ownerId,f.scope,'customer',snapshot.id,1,businessObjectSnapshotHash(snapshot),JSON.stringify(snapshot),f.definition.sourceId,now])
 const before=await counts(f.actor.ownerId)
 await assert.rejects(f.stage(),{code:'teloa/conflict'})
 assert.deepEqual(await counts(f.actor.ownerId),before)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_record_import_drafts where owner_id=$1',[f.actor.ownerId])).rows[0].n,0)
})
test('applied_receipt_survives_type_rename_record_edit_and_import_pins_prevent_prune',async()=>{
 const f=await fixture(),draft=await f.prepare(),input=f.confirm(draft)
 const importPins=async()=> (await pool.query("select reference_id,object_id,object_version from teloa_business_snapshot_references where owner_id=$1 and scope_id=$2 and kind='import' order by object_id,object_version",[f.actor.ownerId,f.scope])).rows
 assert.deepEqual(await importPins(),[])
 const receipt=await f.imports.apply(f.actor,input),ref=receipt.references[0]!,pins=await importPins()
 assert.equal(pins.length,2,'两条 import 引用必须由真实 apply 自动生成，不由测试手工固定')
 assert.deepEqual(pins.filter(pin=>pin.object_id===ref.id),[{reference_id:input.requestId,object_id:ref.id,object_version:1}])
 const original=await f.records.get(f.actor,{scope:f.scope,type:'customer',id:ref.id,version:1})
 const oldBytes=async()=> (await pool.query('select snapshot::text as bytes,snapshot_hash from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 and object_version=1',[f.actor.ownerId,f.scope,'customer',ref.id])).rows
 const beforeBytes=await oldBytes();assert.equal(beforeBytes.length,1);assert.equal(beforeBytes[0].snapshot_hash,ref.snapshotHash)
 const edited=await f.records.edit(f.actor,{requestId:randomUUID(),scope:f.scope,type:'customer',id:ref.id,expectedVersion:1,fields:[{name:'state',value:'已改'}]})
 const control=await f.records.create(f.actor,{requestId:randomUUID(),scope:f.scope,type:'customer',title:'无引用对照',summary:'',fields:[{name:'state',value:'对照旧值'}]})
 const controlEdited=await f.records.edit(f.actor,{requestId:randomUUID(),scope:f.scope,type:'customer',id:control.id,expectedVersion:1,fields:[{name:'state',value:'对照新值'}]})
 assert.equal(edited.version,2);assert.equal(controlEdited.version,2)
 await f.rename({version:'1.0.1',title:'客户新名称',fields:fields.map(field=>({...field,label:'新状态'}))})
 const rebuilt=new BusinessRecordImportService(pool,identity,f.dependencies)
 assert.deepEqual(await rebuilt.receipt(f.actor,{requestId:input.requestId,scope:f.scope}),receipt)
 assert.deepEqual(await rebuilt.apply(f.actor,input),receipt)
 // 仅老化这两个自有 v1，移除其普通操作引用；当前 v2 与真实 import 引用不动。
 const oldIds=[ref.id,control.id]
 const aged=await pool.query("update teloa_business_object_snapshots set first_seen_at='2000-01-01T00:00:00Z' where owner_id=$1 and scope_id=$2 and object_type='customer' and object_id=any($3::text[]) and object_version=1",[f.actor.ownerId,f.scope,oldIds])
 assert.equal(aged.rowCount,2)
 await pool.query("delete from teloa_business_snapshot_references where owner_id=$1 and scope_id=$2 and kind='record-operation' and object_type='customer' and object_id=any($3::text[]) and object_version=1",[f.actor.ownerId,f.scope,oldIds])
 const remaining=(await pool.query('select kind,reference_id,object_id,object_version from teloa_business_snapshot_references where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=any($4::text[]) and object_version=1',[f.actor.ownerId,f.scope,'customer',oldIds])).rows
 assert.deepEqual(remaining,[{kind:'import',reference_id:input.requestId,object_id:ref.id,object_version:1}],'旧目标仅由真实 import pin 保护，对照旧版本完全无引用')
 assert.deepEqual(await importPins(),pins)
 assert.equal(await f.warehouse.prune(f.actor.ownerId,f.scope,'customer',1),1,'真正过期的无引用对照 v1 应删，import 固定的过期 v1 必须保留')
 const versions=async(id:string)=> (await pool.query('select object_version from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 order by object_version',[f.actor.ownerId,f.scope,'customer',id])).rows.map(row=>row.object_version)
 assert.deepEqual(await versions(ref.id),[1,2]);assert.deepEqual(await versions(control.id),[2])
 assert.deepEqual(await oldBytes(),beforeBytes)
 assert.deepEqual(await f.records.get(f.actor,{scope:f.scope,type:'customer',id:ref.id,version:1}),original)
 assert.deepEqual(await f.records.get(f.actor,{scope:f.scope,type:'customer',id:ref.id}),edited)
 assert.deepEqual(await f.records.get(f.actor,{scope:f.scope,type:'customer',id:control.id}),controlEdited)
 await assert.rejects(f.records.get(f.actor,{scope:f.scope,type:'customer',id:control.id,version:1}),{code:'teloa/not-found'})
 assert.deepEqual(await importPins(),pins)
 assert.deepEqual(await rebuilt.receipt(f.actor,{requestId:input.requestId,scope:f.scope}),receipt)
 assert.deepEqual(await rebuilt.apply(f.actor,input),receipt)
 assert.deepEqual((await rebuilt.get(f.actor,{draftId:draft.id})).receipt,receipt)
 assert.equal(await f.warehouse.prune(f.actor.ownerId,f.scope,'customer',1),0,'对照已删，第二次清理不得删除仍被 import 固定的历史')
})
test('display_rename_then_reupload_repreviews_but_replays_original_refs',async()=>{
 const f=await fixture(),old=await f.prepare(),unconfirmed=await f.prepare(),first=await f.imports.apply(f.actor,f.confirm(old))
 await f.rename({version:'1.0.1',title:'中文新名',fields:fields.map(field=>({...field,label:'中文新标签'}))})
 await assert.rejects(f.imports.apply(f.actor,f.confirm(unconfirmed)),{code:'teloa/version-conflict'})
 const fresh=await f.imports.preview(f.actor,{draftId:unconfirmed.id,expectedRevision:unconfirmed.revision,mapping}),alias=await f.imports.apply(f.actor,f.confirm(fresh))
 assert.equal(alias.canonicalRequestId,first.requestId);assert.deepEqual(alias.references,first.references)
 assert.equal((await counts(f.actor.ownerId))[0],2)
})
test('fresh_service_instance_recovers_stage_request_draft_and_fixed_refs',async()=>{
 const f=await fixture(),input=f.stageInput(),staged=await f.imports.stage(f.actor,input),previewed=await f.imports.preview(f.actor,{draftId:staged.id,expectedRevision:1,mapping}),request=f.confirm(previewed),first=await f.imports.apply(f.actor,request)
 const rebuilt=new BusinessRecordImportService(pool,identity,f.dependencies)
 const recovered=await rebuilt.stageReceipt(f.actor,{requestId:input.requestId,scope:f.scope,type:'customer'})
 assert.equal(recovered!.status,'applied');assert.deepEqual(recovered!.receipt,first)
 assert.deepEqual(await rebuilt.receipt(f.actor,{requestId:request.requestId,scope:f.scope}),first)
 assert.equal(f.stats().saved,1)
})
test('full_file_hash_and_signal_are_rechecked_before_parse_or_draft_write',async()=>{
 const f=await fixture(),staged=await f.stage(),original=f.filesById.get(staged.file.attachmentId)!
 f.filesById.set(staged.file.attachmentId,Buffer.alloc(original.length,120))
 await assert.rejects(f.imports.inspect(f.actor,{draftId:staged.id,expectedRevision:1,delimiter:','}),{code:'teloa/file-changed'})
 assert.equal(f.stats().parsed,0);assert.equal((await f.imports.get(f.actor,{draftId:staged.id})).revision,1)
 const controller=new AbortController(),cancelled=new BusinessRecordImportService(pool,identity,{...f.dependencies,files:{...f.dependencies.files,save:async(input)=>{const ref=await f.dependencies.files.save(input);controller.abort(new WorkError('teloa/cancelled','停止。'));return ref}}})
 await assert.rejects(cancelled.stage(f.actor,f.stageInput(),controller.signal),{code:'teloa/cancelled'})
 assert.equal((await pool.query('select count(*)::int n from teloa_business_record_import_drafts where owner_id=$1',[f.actor.ownerId])).rows[0].n,1)
})
async function blockedBy(client:PoolClient){
 const pid=(await client.query('select pg_backend_pid() pid')).rows[0].pid
 for(let attempt=0;attempt<4000;attempt++){
  if((await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[pid])).rowCount)return
  await new Promise<void>(resolve=>setImmediate(resolve))
 }
 throw Error('未观察到PG锁屏障')
}
test('import_and_regular_batch_preserve_record_lock_order',async()=>{
 const f=await fixture(),draft=await f.prepare(),gate=await pool.connect();await gate.query('begin')
 await gate.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-configuration',f.actor.ownerId,f.scope])])
 const imported=f.imports.apply(f.actor,f.confirm(draft)),regular=f.records.batch(f.actor,{requestId:randomUUID(),scope:f.scope,operations:[{operation:'create',type:'customer',title:'普通记录',summary:'',fields:[{name:'state',value:'普通'}]}]})
 await blockedBy(gate);await gate.query('commit');gate.release()
 await Promise.all([imported,regular]);assert.equal((await counts(f.actor.ownerId))[0],3)
})

const xlsxSheets=[{sheetId:'1',name:'客户甲',part:'xl/worksheets/sheet1.xml'},{sheetId:'2',name:'客户乙',part:'xl/worksheets/sheet2.xml'}]
const xlsxPolicy={parserVersion:'xlsx-scalar-v1' as const,scalarPolicy:'closed-scalar-v1' as const,datePolicy:'reject-date-v1' as const,formulaPolicy:'reject-formula-v1' as const}
const {delimiter:unusedDelimiter,...xlsxMapping}=mapping
async function xlsxFixture(){
 const f=await fixture(),raw=Buffer.from('isolated workbook bytes'),tables=new Map<string,BusinessImportTableV2>()
 for(const sheet of xlsxSheets)tables.set(sheet.part,{format:'teloa.business-import-table/v2',source:{kind:'xlsx',sheet},policy:xlsxPolicy,columns:3,rows:[{rowNumber:1,cells:['编号','标题','状态'].map(text=>({kind:'string',text}))},{rowNumber:2,cells:['001',sheet.name,'新'].map(text=>({kind:'string',text}))}]})
 const xlsx:BusinessImportXlsxPort={inspectWorkbook:async bytes=>({format:'teloa.business-import-workbook/v2',fileHash:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.byteLength,sheets:xlsxSheets,policy:xlsxPolicy}),parseSheet:async(_bytes,source)=>structuredClone(tables.get(source.sheet.part)!)}
 const dependencies={...f.dependencies,xlsx},imports=new BusinessRecordImportService(pool,identity,dependencies)
 const input=(sheet=xlsxSheets[0]!,requestId=randomUUID())=>({...f.stageInput(raw.toString(),'original.xlsx',requestId),format:'teloa.business-import-stage/v2',source:{kind:'xlsx',sheet}})
 const prepare=async(sheet=xlsxSheets[0]!)=>{const draft=await imports.stage(f.actor,input(sheet));return imports.preview(f.actor,{format:'teloa.business-import-preview-input/v2',draftId:draft.id,expectedRevision:draft.revision,mapping:xlsxMapping})}
 return {...f,imports,dependencies,input,prepare,tables,xlsx}
}
test('xlsx_persisted_preview_recomputes_policy_raw_and_content_domains',async()=>{
 const f=await xlsxFixture(),draft=await f.prepare(),changed=structuredClone(draft) as BusinessImportDraftV2
 changed.preview!.rawCellsDigest='f'.repeat(64)
 await pool.query('update teloa_business_record_import_drafts set draft=$3,draft_hash=$4 where owner_id=$1 and id=$2',[f.actor.ownerId,draft.id,JSON.stringify(changed),businessImportHash(changed)])
 await assert.rejects(f.imports.get(f.actor,{draftId:draft.id}),{code:'teloa/storage-corrupt'})
})
test('xlsx_workbook_is_readonly_and_selected_sheet_is_exact_before_save',async()=>{
 const f=await xlsxFixture(),{requestId:_,format:__,source:___,...input}=f.input(),before=await counts(f.actor.ownerId)
 const workbook=await f.imports.inspectWorkbook(f.actor,input)
 assert.deepEqual(workbook.sheets,xlsxSheets);assert.equal(f.stats().saved,0);assert.deepEqual(await counts(f.actor.ownerId),before)
 await assert.rejects(f.imports.stage(f.actor,{...f.input(),source:{kind:'xlsx',sheet:{...xlsxSheets[0],name:'wrong'}}}),{code:'teloa/invalid-input'})
 const bad=new BusinessRecordImportService(pool,identity,{...f.dependencies,xlsx:{...f.xlsx,inspectWorkbook:async bytes=>({...await f.xlsx.inspectWorkbook(bytes),fileHash:'0'.repeat(64)})}})
 await assert.rejects(bad.inspectWorkbook(f.actor,input),{code:'teloa/invalid-host-response'});assert.equal(f.stats().saved,0)
 const revoked=new BusinessRecordImportService(pool,identity,{...f.dependencies,xlsx:{...f.xlsx,inspectWorkbook:async bytes=>{const result=await f.xlsx.inspectWorkbook(bytes);f.actor.scopeIds=[];return result}}})
 await assert.rejects(revoked.inspectWorkbook(f.actor,input),{code:'teloa/forbidden'})
})
test('xlsx_two_sheets_are_independent_same_sheet_aliases_one_batch_and_mapping_conflicts',async()=>{
 const f=await xlsxFixture(),a=await f.prepare(),b=await f.prepare(xlsxSheets[1]!)
 assert.notEqual(a.sourceIdentity,b.sourceIdentity)
 const first=await f.imports.apply(f.actor,f.confirm(a)),second=await f.imports.apply(f.actor,f.confirm(b))
 assert.notEqual(first.canonicalRequestId,second.canonicalRequestId);assert.notDeepEqual(first.references,second.references)
 const sameA=await f.prepare(),sameB=await f.prepare(),[aliasA,aliasB]=await Promise.all([f.imports.apply(f.actor,f.confirm(sameA)),f.imports.apply(f.actor,f.confirm(sameB))])
 assert.equal(aliasA.canonicalRequestId,first.requestId);assert.equal(aliasB.canonicalRequestId,first.requestId)
 const staged=await f.imports.stage(f.actor,f.input()),altered=await f.imports.preview(f.actor,{format:'teloa.business-import-preview-input/v2',draftId:staged.id,expectedRevision:1,mapping:{...xlsxMapping,title:{column:1,trim:true}}})
 assert.equal(altered.preview!.canApply,false);assert.ok(altered.preview!.issues.some(issue=>issue.code==='source-policy-conflict'))
 await assert.rejects(f.imports.apply(f.actor,f.confirm(altered)),{code:'teloa/conflict'})
 assert.deepEqual(await counts(f.actor.ownerId),[2,2,2,2,4,2,4]);assert.equal(f.stats().parsed,0)
})
test('xlsx_cancel_resume_and_new_service_keep_exact_source_and_mix_v1_history',async()=>{
 const f=await xlsxFixture(),input=f.input(),staged=await f.imports.stage(f.actor,input)
 const cancelled=await f.imports.cancel(f.actor,{requestId:randomUUID(),draftId:staged.id,expectedRevision:1}),rebuilt=new BusinessRecordImportService(pool,identity,f.dependencies)
 const resumed=await rebuilt.resume(f.actor,{requestId:randomUUID(),draftId:staged.id,expectedRevision:cancelled.revision})
 assert.equal(resumed.format,'teloa.business-record-import/v2');assert.deepEqual((resumed as BusinessImportDraftV2).source,input.source)
 assert.deepEqual(await rebuilt.stageReceipt(f.actor,{requestId:input.requestId,scope:f.scope,type:'customer'}),resumed)
 await assert.rejects(rebuilt.stage(f.actor,{...input,source:{kind:'xlsx',sheet:xlsxSheets[1]}}),{code:'teloa/conflict'})
 await assert.rejects(rebuilt.inspect(f.actor,{draftId:staged.id,expectedRevision:resumed.revision,delimiter:','}),{code:'teloa/invalid-input'})
 const inspected=await rebuilt.inspect(f.actor,{format:'teloa.business-import-inspect/v2',draftId:staged.id,expectedRevision:resumed.revision})
 assert.equal(inspected.format,'teloa.business-import-inspection/v2');assert.equal(inspected.canMap,true)
 const previewed=await rebuilt.preview(f.actor,{format:'teloa.business-import-preview-input/v2',draftId:staged.id,expectedRevision:resumed.revision,mapping:xlsxMapping}),request=f.confirm(previewed),receipt=await rebuilt.apply(f.actor,request)
 const csv=await f.imports.stage(f.actor,f.stageInput()),csvPreview=await f.imports.preview(f.actor,{draftId:csv.id,expectedRevision:1,mapping}),csvReceipt=await f.imports.apply(f.actor,f.confirm(csvPreview))
 assert.equal(Object.hasOwn(csvReceipt,'format'),false)
 const {xlsx:unusedXlsx,...withoutXlsx}=f.dependencies
 const fixed=new BusinessRecordImportService(pool,identity,{...withoutXlsx,files:{...f.dependencies.files,read:async()=>{throw new WorkError('teloa/file-unavailable','历史文件不可读。')}}})
 assert.deepEqual(await fixed.apply(f.actor,request),receipt);assert.deepEqual(await fixed.receipt(f.actor,{requestId:receipt.requestId,scope:f.scope}),receipt)
 assert.deepEqual((await fixed.stageReceipt(f.actor,{requestId:input.requestId,scope:f.scope,type:'customer'}))!.receipt,receipt)
 assert.deepEqual(await fixed.receipt(f.actor,{requestId:csvReceipt.requestId,scope:f.scope}),csvReceipt)
 assert.deepEqual(await counts(f.actor.ownerId),[3,3,3,2,4,3,6])
})
test('xlsx_apply_rechecks_raw_kind_current_policy_and_original_attachment_without_writing',async()=>{
 const f=await xlsxFixture(),draft=await f.prepare(),before=await counts(f.actor.ownerId),table=f.tables.get(xlsxSheets[0]!.part)!
 table.rows[1]!.cells[0]={kind:'number',text:'001'}
 await assert.rejects(f.imports.apply(f.actor,f.confirm(draft)),{code:'teloa/file-changed'})
 table.rows[1]!.cells[0]={kind:'string',text:'001'}
 const wrong=new BusinessRecordImportService(pool,identity,{...f.dependencies,xlsx:{...f.xlsx,parseSheet:async(bytes,source)=>({...await f.xlsx.parseSheet(bytes,source),source:{kind:'xlsx',sheet:xlsxSheets[1]!}})}})
 await assert.rejects(wrong.apply(f.actor,f.confirm(draft)),{code:'teloa/invalid-host-response'})
 const raw=f.filesById.get(draft.file.attachmentId)!,old=new Uint8Array(raw);f.filesById.set(draft.file.attachmentId,Buffer.alloc(raw.length,120))
 await assert.rejects(f.imports.apply(f.actor,f.confirm(draft)),{code:'teloa/file-changed'});f.filesById.set(draft.file.attachmentId,old)
 assert.deepEqual(await counts(f.actor.ownerId),before)
 const applied=await f.imports.apply(f.actor,f.confirm(draft));assert.equal(applied.created,1)
})
test('xlsx_parser_failure_never_adopts_partial_rows_and_atomic_batch_failure_rolls_back',async()=>{
 const f=await xlsxFixture(),staged=await f.imports.stage(f.actor,f.input()),before=await counts(f.actor.ownerId)
 const rejected=new BusinessRecordImportService(pool,identity,{...f.dependencies,xlsx:{...f.xlsx,parseSheet:async()=>{throw new WorkError('teloa/invalid-input','公式不支持。',{businessImportIssues:[{code:'xlsx-formula',message:'公式不支持。'}]})}}})
 const failed=await rejected.preview(f.actor,{format:'teloa.business-import-preview-input/v2',draftId:staged.id,expectedRevision:1,mapping:xlsxMapping}) as BusinessImportDraftV2
 assert.equal(failed.preview!.rawCellsDigest,null);assert.deepEqual(failed.preview!.rows,[]);assert.equal(failed.preview!.canApply,false)
 await assert.rejects(rejected.apply(f.actor,f.confirm(failed)),{code:'teloa/invalid-input'})
 const draft=await f.prepare(),limited=new api.BusinessRecordService(pool,identity,{definitions:f.dependencies.definitions,warehouse:{tombstone:f.warehouse.tombstone.bind(f.warehouse),assertQuota:async()=>{throw new WorkError('teloa/invalid-input','配额不足。')}},references:f.references})
 const imports=new BusinessRecordImportService(pool,identity,{...f.dependencies,records:limited}),request=f.confirm(draft)
 await assert.rejects(imports.apply(f.actor,request),{code:'teloa/invalid-input'})
 assert.deepEqual(await counts(f.actor.ownerId),before);assert.equal(await imports.receipt(f.actor,{requestId:request.requestId,scope:f.scope}),undefined)
 assert.deepEqual(await imports.get(f.actor,{draftId:draft.id}),draft)
})
test('xlsx_corrupted_alias_or_canonical_raw_is_rejected_by_fixed_historical_receipt',async()=>{
 const f=await xlsxFixture(),draft=await f.prepare(),receipt=await f.imports.apply(f.actor,f.confirm(draft)),another=await f.prepare(),alias=await f.imports.apply(f.actor,f.confirm(another))
 for(const original of [alias,receipt]){
  const changed={...original,rawCellsDigest:'f'.repeat(64)}
  await pool.query('update teloa_business_record_import_receipts set result=$3,result_hash=$4 where owner_id=$1 and request_id=$2',[f.actor.ownerId,original.requestId,JSON.stringify(changed),businessImportHash(changed)])
  await assert.rejects(f.imports.receipt(f.actor,{requestId:original.requestId,scope:f.scope}),{code:'teloa/storage-corrupt'})
  await pool.query('update teloa_business_record_import_receipts set result=$3,result_hash=$4 where owner_id=$1 and request_id=$2',[f.actor.ownerId,original.requestId,JSON.stringify(original),businessImportHash(original)])
 }
 assert.deepEqual(await f.imports.receipt(f.actor,{requestId:alias.requestId,scope:f.scope}),alias)
})
test('xlsx_replayed_preview_rechecks_revision_after_delayed_original_file_read',async()=>{
 const f=await xlsxFixture(),draft=await f.prepare(),before=await counts(f.actor.ownerId)
 let release!:()=>void,entered!:()=>void
 const reading=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 const imports=new BusinessRecordImportService(pool,identity,{...f.dependencies,files:{...f.dependencies.files,read:async file=>{entered();await gate;return f.dependencies.files.read(file)}}})
 const pending=imports.preview(f.actor,{format:'teloa.business-import-preview-input/v2',draftId:draft.id,expectedRevision:1,mapping:xlsxMapping}).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 await reading
 try{await f.imports.cancel(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision})}finally{release()}
 const result=await pending
 assert.equal(result.error?.code,'teloa/version-conflict','旧预览不可越过附件等待期间的取消继续返回可采用事实')
 assert.equal(result.value,undefined)
 assert.equal((await f.imports.get(f.actor,{draftId:draft.id})).status,'cancelled')
 assert.deepEqual(await counts(f.actor.ownerId),[...before.slice(0,4),before[4]!+1,...before.slice(5)])
})
test('xlsx_replayed_preview_rechecks_scope_after_delayed_original_file_read',async()=>{
 const f=await xlsxFixture(),draft=await f.prepare(),before=await counts(f.actor.ownerId)
 let release!:()=>void,entered!:()=>void
 const reading=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 const imports=new BusinessRecordImportService(pool,identity,{...f.dependencies,files:{...f.dependencies.files,read:async file=>{entered();await gate;return f.dependencies.files.read(file)}}})
 const pending=imports.preview(f.actor,{format:'teloa.business-import-preview-input/v2',draftId:draft.id,expectedRevision:1,mapping:xlsxMapping}).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 await reading
 f.actor.scopeIds=[];release()
 const result=await pending
 assert.equal(result.error?.code,'teloa/forbidden','附件等待期间撤销业务权限后不能回显旧预览')
 assert.equal(result.value,undefined);assert.deepEqual(await counts(f.actor.ownerId),before)
})
