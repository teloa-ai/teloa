import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
const source=new URL('../src/client/business-import-flow.ts',import.meta.url)
const draftId='11111111-1111-4111-8111-111111111111',stageId='22222222-2222-4222-8222-222222222222',applyId='33333333-3333-4333-8333-333333333333',fileHash='ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',hash='a'.repeat(64),stamp='2026-09-30T00:00:00.000Z'
const file={name:'客户.csv',bytes:1,dataBase64:'YQ=='}
const mapping={delimiter:',' as const,headerRow:1,primaryKey:[{column:0,trim:false}],title:{column:1,trim:false},fields:[]}
const base={format:'teloa.business-record-import/v1',id:draftId,stageRequestId:stageId,ownerId:'self',scope:'sales',type:'customer',sourceIdentity:hash,revision:1,status:'ready',file:{attachmentId:'attachment',name:file.name,bytes:1,sha256:fileHash},createdAt:stamp,updatedAt:stamp}
const inspection={format:'teloa.business-import-inspection/v1',draftId,scope:'sales',type:'customer',fileHash,revision:1,delimiter:',',parserVersion:'csv-v1',headerRow:1,columns:[{column:0,header:''},{column:1,header:''}],sampleRows:[{rowNumber:2,cells:['001','客户一']}],sampleRowsOmitted:0,dataRows:1,issues:[],complete:true,canMap:true}
const preview={revision:2,digest:hash,schemaFingerprint:hash,writeSchemaFingerprint:hash,configurationVersion:1,sourceIdentity:hash,sourcePolicyDigest:hash,contentKey:hash,mapping,rows:[{rowNumber:2,primaryKey:['001'],operation:{operation:'create',type:'customer',title:'客户一',summary:'',fields:[]}}],issues:[],canApply:true}
const result={requestId:applyId,canonicalRequestId:applyId,draftId,scope:'sales',type:'customer',fileHash,previewDigest:hash,sourceIdentity:hash,sourcePolicyDigest:hash,contentKey:hash,created:1,references:[{scope:'sales',type:'customer',id:'44444444-4444-4444-8444-444444444444',version:1,snapshotHash:hash}],appliedAt:stamp}
const definition={format:'teloa.business-object-type/v1' as const,domain:'sales',id:'customer',version:'1.0.0',sourceId:'records',title:'客户',unit:'条',lead:'',fields:[]}
async function setup(){
 assert.ok(existsSync(source),'缺少原请求导入flow');const {BusinessImportFlow}=await import('../src/client/business-import-flow.ts');const {createBusinessImportApi}=await import('../src/client/business-import-api.ts')
 let raw:string|null=null,current=true,draft:any=structuredClone(base),receipt:any=null;const calls:{method:string;input:any}[]=[],waits=new Map<string,()=>Promise<void>>(),fails=new Set<string>();let n=0
 const api=createBusinessImportApi(async(method,input:any)=>{calls.push({method,input});await waits.get(method)?.();if(fails.has(method))throw Error('lost response');switch(method){case 'business-imports/stage':return draft;case 'business-imports/stage-receipt':return draft;case 'business-imports/get':return draft;case 'business-imports/inspect':return {...inspection,revision:draft.revision};case 'business-imports/preview':draft={...draft,status:'previewed',revision:draft.revision+1,mapping:input.mapping,preview:{...preview,revision:draft.revision+1,mapping:input.mapping}};return draft;case 'business-imports/apply':receipt={...result,requestId:input.requestId};return receipt;case 'business-imports/receipt':return receipt;case 'business-imports/cancel':draft={...draft,status:'cancelled',revision:draft.revision+1};return draft;case 'business-imports/resume':{const {preview:_,...kept}=draft;draft={...kept,status:'ready',revision:draft.revision+1};return draft}}
 })
 const journal={read:()=>raw,write:(value:string)=>{raw=value},clear:()=>{raw=null}},ports={api,ownerId:'self',personalSpaceId:'personal-self',scope:'sales',type:'customer',journal,isCurrent:()=>current,id:()=>n++===0?stageId:applyId}
 const make=(patch={})=>{const f=new BusinessImportFlow({...ports,...patch});f.configure({...definition,domain:f.scope});return f},flow=make()
 return {flow,make,calls,fails,waits,journal,get raw(){return raw},set raw(v:string|null){raw=v},set current(v:boolean){current=v},set draft(v:any){draft=v},get draft(){return draft},set receipt(v:any){receipt=v}}
}
test('inspect_before_mapping_uses_headers_column_numbers_and_marked_samples',async()=>{const x=await setup();await x.flow.stage(file);assert.equal(x.flow.getSnapshot().inspection,undefined);await x.flow.inspect(',');assert.equal(x.flow.getSnapshot().inspection?.columns[1]?.column,1);assert.equal(x.flow.getSnapshot().inspection?.dataRows,1);assert.equal(x.calls.some(c=>c.method.endsWith('/apply')),false)})
test('inspection_errors_block_mapping_without_partial_success',async()=>{const x=await setup();x.draft={...base,status:'cancelled',revision:2};await x.flow.get(draftId);await assert.rejects(x.flow.preview(mapping));assert.equal(x.calls.some(c=>c.method.endsWith('/preview')),false)})
test('primary_key_trim_is_explicit_and_invalidates_preview',async()=>{const x=await setup();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping);assert.ok(x.flow.getSnapshot().preview);x.flow.changeMapping({...mapping,primaryKey:[{column:0,trim:true}]});assert.equal(x.flow.getSnapshot().preview,undefined);await x.flow.apply();assert.equal(x.calls.some(c=>c.method.endsWith('/apply')),false)})
test('preview_never_calls_apply_and_confirmed_batch_sends_exact_digest',async()=>{const x=await setup();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping);assert.equal(x.calls.some(c=>c.method.endsWith('/apply')),false);await x.flow.apply();assert.deepEqual(x.calls.find(c=>c.method.endsWith('/apply'))?.input,{requestId:applyId,draftId,previewRevision:2,previewDigest:hash});assert.equal(x.flow.getSnapshot().phase,'applied');assert.equal(x.raw,null)})
test('stage_accepted_lost_response_reload_finds_original_draft_without_file_bytes',async()=>{const x=await setup();x.fails.add('business-imports/stage');await x.flow.stage(file);assert.equal(x.flow.getSnapshot().phase,'unknown');assert.ok(x.raw);assert.equal(x.raw.includes('dataBase64'),false);assert.equal(x.raw.includes('YQ=='),false);x.fails.clear();const restored=x.make();await restored.reconcile();assert.equal(restored.getSnapshot().draft?.id,draftId);assert.deepEqual(x.calls.at(-1)?.input,{requestId:stageId,scope:'sales',type:'customer'});assert.equal(x.calls.filter(c=>c.method.endsWith('/stage')).length,1)})
test('null_stage_receipt_remains_unknown_without_reupload',async()=>{const x=await setup();x.fails.add('business-imports/stage');await x.flow.stage(file);x.fails.clear();x.draft=null;const f=x.make();await f.reconcile();assert.equal(f.getSnapshot().phase,'unknown');await assert.rejects(f.stage(file));assert.equal(x.calls.filter(c=>c.method.endsWith('/stage')).length,1);assert.ok(x.raw)})
test('manual_stage_retry_requires_same_request_and_original_input_digest',async()=>{const x=await setup();x.fails.add('business-imports/stage');await x.flow.stage(file);x.fails.clear();const f=x.make();await assert.rejects(f.retryStage({...file,name:'重命名.csv'}));await assert.rejects(f.retryStage({...file,dataBase64:'Yg=='}));await f.retryStage(file);const stages=x.calls.filter(c=>c.method.endsWith('/stage'));assert.equal(stages.length,2);assert.deepEqual(stages[1]?.input,stages[0]?.input)})
test('lost_apply_response_reload_restores_original_scope_request_and_null_stays_unknown',async()=>{const x=await setup();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping);x.fails.add('business-imports/apply');await x.flow.apply();assert.equal(x.flow.getSnapshot().phase,'unknown');const f=x.make();await f.reconcile();assert.equal(f.getSnapshot().phase,'unknown');assert.deepEqual(x.calls.at(-1)?.input,{requestId:applyId,scope:'sales'});x.fails.clear();await f.retryApply();assert.equal(f.getSnapshot().phase,'applied');assert.deepEqual(x.calls.filter(c=>c.method.endsWith('/apply'))[0]?.input,x.calls.filter(c=>c.method.endsWith('/apply'))[1]?.input)})
test('different_scope_owner_or_personal_space_cannot_claim_journal',async()=>{const x=await setup();x.fails.add('business-imports/stage');await x.flow.stage(file);for(const patch of [{ownerId:'other'},{personalSpaceId:'other'},{scope:'content'}]){const f=x.make(patch);assert.equal(f.getSnapshot().phase,'recovery-error');await f.reconcile();assert.equal(x.calls.length,1)}assert.ok(x.raw)})
test('late_response_after_api_switch_does_not_clear_new_journal',async()=>{const x=await setup();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping);let release!:()=>void;x.waits.set('business-imports/apply',()=>new Promise<void>(resolve=>{release=resolve}));const sending=x.flow.apply();await new Promise(resolve=>setImmediate(resolve));x.current=false;x.raw='new generation journal';release();await sending;assert.equal(x.raw,'new generation journal');assert.notEqual(x.flow.getSnapshot().phase,'applied')})
test('cancel_after_recovered_stage_keeps_file_mapping_and_resume_needs_preview',async()=>{const x=await setup();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping);await x.flow.cancel();assert.equal(x.flow.getSnapshot().phase,'cancelled');assert.deepEqual(x.flow.getSnapshot().draft?.file,base.file);assert.deepEqual(x.flow.getSnapshot().mapping,mapping);await x.flow.resume();assert.equal(x.flow.getSnapshot().preview,undefined);assert.deepEqual(x.flow.getSnapshot().mapping,mapping);await x.flow.apply();assert.equal(x.calls.some(c=>c.method.endsWith('/apply')),false)})
test('cancel_after_applied_is_too_late_not_successful_undo',async()=>{const x=await setup();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping);await x.flow.apply();await x.flow.cancel();assert.equal(x.flow.getSnapshot().phase,'applied');assert.equal(x.flow.getSnapshot().errorCode,'teloa/too-late');assert.equal(x.calls.some(c=>c.method.endsWith('/cancel')),false)})
test('mapping_cleared_or_incomplete_cannot_keep_a_confirmable_preview',async()=>{const x=await setup();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping);x.flow.changeMapping(undefined);assert.equal(x.flow.getSnapshot().preview,undefined);assert.equal(x.flow.getSnapshot().mapping,undefined);await x.flow.apply();assert.equal(x.calls.some(c=>c.method.endsWith('/apply')),false)})
test('storage_write_failure_preserves_recoverable_original_request_and_sends_nothing',async()=>{const x=await setup();const f=x.make({journal:{...x.journal,write:()=>{throw Error('unavailable')}}});await f.stage(file);assert.equal(x.calls.length,0);assert.equal(f.getSnapshot().phase,'recovery-error');assert.equal(f.getSnapshot().pending?.phase,'stage')})
test('stage_wrong_owner_or_file_hash_remains_unknown_with_original_journal',async()=>{for(const patch of [{ownerId:'other'},{file:{...base.file,sha256:hash}}]){const x=await setup();x.draft={...base,...patch};await x.flow.stage(file);assert.equal(x.flow.getSnapshot().phase,'unknown');assert.ok(x.raw);assert.equal(x.flow.getSnapshot().draft,undefined)}})
test('late_inspection_after_identity_change_cannot_replace_previous_mapping',async()=>{const x=await setup();await x.flow.stage(file);let release!:()=>void;x.waits.set('business-imports/inspect',()=>new Promise<void>(resolve=>{release=resolve}));const reading=x.flow.inspect(',');await new Promise(resolve=>setImmediate(resolve));x.current=false;release();await reading;assert.equal(x.flow.getSnapshot().inspection,undefined)})
test('stage_and_apply_double_clicks_never_generate_a_second_request',async()=>{const x=await setup();const sending=x.flow.stage(file);await assert.rejects(x.flow.stage(file));await sending;await x.flow.inspect(',');await x.flow.preview(mapping);let release!:()=>void;x.waits.set('business-imports/apply',()=>new Promise<void>(resolve=>{release=resolve}));const applying=x.flow.apply();await assert.rejects(x.flow.apply());await new Promise(resolve=>setImmediate(resolve));release();await applying;assert.equal(x.calls.filter(c=>c.method.endsWith('/stage')).length,1);assert.equal(x.calls.filter(c=>c.method.endsWith('/apply')).length,1)})
test('retry_file_argument_cannot_replace_original_request_identity',async()=>{const x=await setup();x.fails.add('business-imports/stage');await x.flow.stage(file);x.fails.clear();await x.make().retryStage({...file,requestId:applyId} as typeof file);assert.equal(x.calls.filter(c=>c.method.endsWith('/stage')).at(-1)?.input.requestId,stageId);assert.equal(x.calls.at(-1)?.input.scope,'sales');assert.equal(x.calls.at(-1)?.input.type,'customer')})
test('public_snapshot_cannot_mutate_the_frozen_apply_request_before_manual_resend',async()=>{const x=await setup();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping);x.fails.add('business-imports/apply');await x.flow.apply();const pending=x.flow.getSnapshot().pending!;assert.throws(()=>{pending.input.requestId=stageId});x.fails.clear();await x.flow.retryApply();assert.equal(x.calls.filter(c=>c.method.endsWith('/apply')).at(-1)?.input.requestId,applyId)})
test('unrelated_applied_draft_does_not_clear_original_staged_file_journal',async()=>{const x=await setup();await x.flow.stage(file);const raw=x.raw;const otherId='55555555-5555-4555-8555-555555555555';x.draft={...base,id:otherId,stageRequestId:otherId,status:'applied',revision:2,receipt:{...result,draftId:otherId}};await x.flow.get(otherId);assert.equal(x.raw,raw);assert.notEqual(x.flow.getSnapshot().phase,'applied')})
test('manual_stage_retry_locks_before_hashing_against_double_clicks',async()=>{const x=await setup();x.fails.add('business-imports/stage');await x.flow.stage(file);x.fails.clear();const f=x.make(),retry=f.retryStage(file);await assert.rejects(f.retryStage(file));await retry;assert.equal(x.calls.filter(c=>c.method.endsWith('/stage')).length,2)})
test('explicit_apply_rejection_preserves_draft_and_mapping_and_reload_can_repreview_or_cancel',async()=>{
 const x=await setup();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping)
 x.waits.set('business-imports/apply',async()=>{throw Object.assign(Error('字段定义已变化'),{rejected:true,code:'teloa/version-conflict'})});await x.flow.apply();await x.flow.reconcile()
 assert.equal(x.flow.getSnapshot().phase,'error');assert.equal(x.flow.getSnapshot().preview,undefined);assert.deepEqual(x.flow.getSnapshot().mapping,mapping);assert.deepEqual(x.flow.getSnapshot().draft?.file,base.file);assert.ok(x.raw)
 const original=JSON.parse(x.raw!).request;assert.equal(original.input.requestId,applyId);assert.equal(original.input.previewDigest,hash)
 const f=x.make();assert.equal(f.getSnapshot().phase,'error');assert.equal(f.getSnapshot().pending,undefined);assert.deepEqual(f.getSnapshot().mapping,mapping)
 // 另一个页面已经推进草案：重新读取不能一直卡在原版本。
 x.draft={...x.draft,revision:3,preview:{...preview,revision:3}};await f.inspect(',');await f.preview(mapping);assert.ok(f.getSnapshot().preview?.canApply);await f.cancel();assert.equal(f.getSnapshot().phase,'cancelled');assert.equal(x.calls.filter(c=>c.method.endsWith('/apply')).length,1)
})
test('code_only_and_transport_rejections_keep_original_apply_unknown_even_after_null_receipt',async()=>{
 for(const failure of [Object.assign(Error('lost'),{code:'teloa/version-conflict'}),Object.assign(Error('lost'),{rejected:true,code:'teloa/host-unavailable'})]){
  const x=await setup();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping);x.waits.set('business-imports/apply',async()=>{throw failure});await x.flow.apply();const raw=x.raw;await x.flow.reconcile();assert.equal(x.flow.getSnapshot().phase,'unknown');assert.equal(x.raw,raw);const f=x.make();await f.reconcile();await assert.rejects(f.preview(mapping));await assert.rejects(f.cancel());assert.equal(f.getSnapshot().phase,'unknown')
 }
})
test('definition_change_during_preview_discards_late_result_and_requires_fresh_preview',async()=>{
 const x=await setup();await x.flow.stage(file);await x.flow.inspect(',');let release!:()=>void;x.waits.set('business-imports/preview',()=>new Promise<void>(resolve=>{release=resolve}));const reading=x.flow.preview(mapping);await new Promise(resolve=>setImmediate(resolve));x.flow.configure({...definition,title:'新客户名称',version:'2.0.0'});release();await reading
 assert.equal(x.flow.getSnapshot().preview,undefined);assert.equal(x.flow.getSnapshot().relationsReady,false);assert.equal(x.flow.getSnapshot().errorCode,'teloa/schema-changed');await x.flow.apply();assert.equal(x.calls.some(c=>c.method.endsWith('/apply')),false)
 x.waits.clear();await x.flow.preview(mapping);assert.equal(x.flow.getSnapshot().preview?.revision,3);await x.flow.apply();assert.equal(x.flow.getSnapshot().phase,'applied')
})
test('definition_change_during_accepted_apply_or_unknown_recovery_keeps_original_receipt',async()=>{
 const x=await setup();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping);let release!:()=>void;x.waits.set('business-imports/apply',()=>new Promise<void>(resolve=>{release=resolve}));const applying=x.flow.apply();await new Promise(resolve=>setImmediate(resolve));x.flow.configure({...definition,title:'新客户名称',version:'2.0.0'});release();await applying;assert.equal(x.flow.getSnapshot().phase,'applied');assert.equal(x.flow.getSnapshot().receipt?.requestId,applyId);assert.equal(x.raw,null)
 const y=await setup();await y.flow.stage(file);await y.flow.inspect(',');await y.flow.preview(mapping);y.fails.add('business-imports/apply');await y.flow.apply();const f=y.make();f.configure({...definition,title:'新客户名称',version:'2.0.0'});y.receipt=result;await f.reconcile();assert.equal(f.getSnapshot().phase,'applied');assert.equal(f.getSnapshot().receipt?.requestId,applyId);assert.equal(y.raw,null)
})
test('untrusted_stage_owner_or_file_hash_does_not_poison_original_receipt_recovery',async()=>{
 for(const patch of [{ownerId:'other'},{file:{...base.file,sha256:hash}}]){const x=await setup();x.draft={...base,...patch};await x.flow.stage(file);assert.equal(x.flow.getSnapshot().phase,'unknown');x.draft=structuredClone(base);await x.flow.reconcile();assert.equal(x.flow.getSnapshot().phase,'ready');assert.equal(x.flow.getSnapshot().draft?.ownerId,'self');assert.equal(x.flow.getSnapshot().draft?.file.sha256,fileHash)}
})
test('rejected_resend_cannot_prove_the_original_unknown_apply_was_not_accepted',async()=>{
 const x=await setup();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping);x.fails.add('business-imports/apply');await x.flow.apply();const raw=x.raw;x.fails.clear();x.waits.set('business-imports/apply',async()=>{throw Object.assign(Error('当前权限变化'),{rejected:true,code:'teloa/forbidden'})});await x.flow.retryApply();assert.equal(x.flow.getSnapshot().phase,'unknown');assert.equal(x.raw,raw);await assert.rejects(x.flow.cancel());x.receipt=result;await x.flow.reconcile();assert.equal(x.flow.getSnapshot().phase,'applied');assert.equal(x.raw,null)
})
test('cancel_after_explicit_rejection_refreshes_the_preserved_draft_before_sending',async()=>{
 const x=await setup();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping);x.waits.set('business-imports/apply',async()=>{throw Object.assign(Error('版本变化'),{rejected:true,code:'teloa/version-conflict'})});await x.flow.apply();x.draft={...x.draft,revision:3,preview:{...preview,revision:3}};await x.flow.cancel();assert.equal(x.calls.find(c=>c.method.endsWith('/cancel'))?.input.expectedRevision,3);assert.equal(x.flow.getSnapshot().phase,'cancelled')
})
test('xlsx_requires_explicit_sheet_and_runs_versioned_preview_apply_without_csv_delimiter',async()=>{
 const x=await setup(),{createBusinessImportApi}=await import('../src/client/business-import-api.ts')
 const sheet={sheetId:'1',name:'客户甲',part:'xl/worksheets/sheet1.xml'},other={sheetId:'2',name:'客户乙',part:'xl/worksheets/sheet2.xml'},source={kind:'xlsx' as const,sheet}
 const policy={parserVersion:'xlsx-scalar-v1' as const,scalarPolicy:'closed-scalar-v1' as const,datePolicy:'reject-date-v1' as const,formulaPolicy:'reject-formula-v1' as const}
 const {delimiter:_,...mapped}=mapping,xfile={...file,name:'客户.xlsx'}
 const original={...base,format:'teloa.business-record-import/v2',source,policy,file:{...base.file,name:xfile.name}}
 const inspected={...inspection,format:'teloa.business-import-inspection/v2',source,policy,rawCellsDigest:hash,sampleRows:[{rowNumber:2,cells:[{kind:'string',text:'001'},{kind:'string',text:'客户一'}]}]}
 delete (inspected as {delimiter?:unknown}).delimiter;delete (inspected as {parserVersion?:unknown}).parserVersion
 const normalized={...preview,format:'teloa.business-import-preview/v2',source,policy,rawCellsDigest:hash,mapping:mapped}
 const applied={...result,format:'teloa.business-import-receipt/v2',source,policy,rawCellsDigest:hash}
 let draft:any=original
 const api=createBusinessImportApi(async(method,input:any)=>{
  x.calls.push({method,input})
  if(method==='business-imports/workbook')return {format:'teloa.business-import-workbook/v2',fileHash,bytes:1,sheets:[sheet,other],policy}
  if(method==='business-imports/stage'){draft={...draft,stageRequestId:input.requestId};return draft}
  if(method==='business-imports/get'||method==='business-imports/stage-receipt')return draft
  if(method==='business-imports/inspect')return inspected
  if(method==='business-imports/preview'){draft={...draft,status:'previewed',revision:2,mapping:mapped,preview:normalized};return draft}
  if(method==='business-imports/apply')return {...applied,requestId:input.requestId}
  throw Error(method)
 })
 const flow=x.make({api})
 await flow.inspectWorkbook(xfile);assert.equal(flow.getSnapshot().phase,'selecting-sheet')
 assert.equal(x.calls.some(call=>call.method==='business-imports/stage'),false)
 await assert.rejects(flow.stage(xfile,{kind:'xlsx',sheet:{...sheet,name:'伪造'}}))
 await flow.stage({...xfile,dataBase64:'Yg=='},source);assert.equal(flow.getSnapshot().phase,'selecting-sheet');assert.equal(x.calls.some(call=>call.method==='business-imports/stage'),false)
 await flow.stage(xfile,source);assert.equal(flow.getSnapshot().draft?.format,'teloa.business-record-import/v2')
 assert.equal(x.calls.find(call=>call.method==='business-imports/stage')?.input.source.sheet.name,'客户甲')
 await flow.inspect();assert.equal(flow.getSnapshot().inspection?.format,'teloa.business-import-inspection/v2')
 await flow.preview(mapped);assert.equal(flow.getSnapshot().preview?.canApply,true)
 assert.equal(Object.hasOwn(x.calls.find(call=>call.method==='business-imports/preview')?.input.mapping,'delimiter'),false)
 await flow.apply();assert.equal(flow.getSnapshot().phase,'applied');assert.equal(x.raw,null)
})
test('xlsx_unknown_stage_recovers_the_same_sheet_request_without_persisting_file_bytes',async()=>{
 const x=await setup(),{createBusinessImportApi}=await import('../src/client/business-import-api.ts')
 const sheet={sheetId:'1',name:'客户',part:'xl/worksheets/sheet1.xml'},source={kind:'xlsx' as const,sheet},policy={parserVersion:'xlsx-scalar-v1' as const,scalarPolicy:'closed-scalar-v1' as const,datePolicy:'reject-date-v1' as const,formulaPolicy:'reject-formula-v1' as const},xlsx={...file,name:'客户.xlsx'}
 const draft={...base,format:'teloa.business-record-import/v2',source,policy,file:{...base.file,name:xlsx.name}}
 let lost=true
 const api=createBusinessImportApi(async(method,input:any)=>{
  x.calls.push({method,input})
  if(method==='business-imports/workbook')return {format:'teloa.business-import-workbook/v2',fileHash,bytes:1,sheets:[sheet],policy}
  if(method==='business-imports/stage'){if(lost)throw Error('response lost');return draft}
  if(method==='business-imports/stage-receipt')return null
  throw Error(method)
 })
 const flow=x.make({api});await flow.inspectWorkbook(xlsx);await flow.stage(xlsx,source)
 assert.equal(flow.getSnapshot().phase,'unknown');assert.ok(x.raw?.includes('teloa.business-import-request/v2'));assert.equal(x.raw?.includes('dataBase64'),false)
 const restored=x.make({api});assert.equal(restored.getSnapshot().phase,'unknown')
 await restored.reconcile();assert.equal(restored.getSnapshot().phase,'unknown')
 await assert.rejects(restored.retryStage({...xlsx,dataBase64:'Yg=='}));assert.equal(restored.getSnapshot().phase,'unknown')
 lost=false;await restored.retryStage(xlsx);assert.equal(restored.getSnapshot().draft?.format,'teloa.business-record-import/v2')
 assert.equal(x.calls.filter(call=>call.method==='business-imports/stage').length,2);assert.ok(x.raw&&!x.raw.includes('dataBase64'))
})
test('xlsx_workbook_check_blocks_stale_sheet_stage_until_selection_finishes',async()=>{
 const x=await setup(),{createBusinessImportApi}=await import('../src/client/business-import-api.ts')
 const sheet={sheetId:'1',name:'客户',part:'xl/worksheets/sheet1.xml'},policy={parserVersion:'xlsx-scalar-v1' as const,scalarPolicy:'closed-scalar-v1' as const,datePolicy:'reject-date-v1' as const,formulaPolicy:'reject-formula-v1' as const}
 let release:(()=>void)|undefined
 const api=createBusinessImportApi(async(method)=>{
  x.calls.push({method,input:{}})
  if(method==='business-imports/workbook'){await new Promise<void>(resolve=>{release=resolve});return {format:'teloa.business-import-workbook/v2',fileHash,bytes:1,sheets:[sheet],policy}}
  throw Error('stale sheet must not stage')
 })
 const flow=x.make({api}),xlsx={...file,name:'客户.xlsx'},checking=flow.inspectWorkbook(xlsx)
 await new Promise<void>((resolve,reject)=>{let tries=0;const poll=()=>{if(release)resolve();else if(++tries>100)reject(Error('workbook request did not start'));else setTimeout(poll,1)};poll()});assert.equal(flow.getSnapshot().phase,'checking-workbook')
 await assert.rejects(flow.stage(xlsx,{kind:'xlsx',sheet}));assert.equal(x.calls.filter(call=>call.method==='business-imports/stage').length,0)
 assert.ok(release);release();await checking;assert.equal(flow.getSnapshot().phase,'selecting-sheet')
})
test('cold_cancel_recovery_rejects_changed_xlsx_file_or_sheet_with_same_draft_id',async()=>{
 const x=await setup(),{createBusinessImportApi}=await import('../src/client/business-import-api.ts')
 const sheet={sheetId:'1',name:'客户',part:'xl/worksheets/sheet1.xml'},policy={parserVersion:'xlsx-scalar-v1' as const,scalarPolicy:'closed-scalar-v1' as const,datePolicy:'reject-date-v1' as const,formulaPolicy:'reject-formula-v1' as const}
 const original={...base,format:'teloa.business-record-import/v2',source:{kind:'xlsx',sheet},policy,file:{...base.file,name:'客户.xlsx'}}
 const input={requestId:applyId,draftId,expectedRevision:1}
 x.raw=JSON.stringify({format:'teloa.business-import-request/v2',ownerId:'self',personalSpaceId:'personal-self',scope:'sales',type:'customer',request:{phase:'cancel',input,draft:original}})
 const frozen=x.raw
 for(const changed of [{...original,file:{...original.file,name:'另一个.xlsx'}},{...original,source:{kind:'xlsx',sheet:{...sheet,name:'错误工作表'}}}]){
  const api=createBusinessImportApi(async method=>{assert.equal(method,'business-imports/get');return {...changed,status:'cancelled',revision:2}})
  const flow=x.make({api});assert.equal(flow.getSnapshot().phase,'unknown')
  await flow.reconcile();assert.equal(flow.getSnapshot().phase,'unknown');assert.equal(flow.getSnapshot().draft?.file.name,'客户.xlsx');assert.equal(x.raw,frozen)
 }
})
