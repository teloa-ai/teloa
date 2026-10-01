import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
const source=new URL('../src/client/business-import-api.ts',import.meta.url)
const id='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222',applyId='33333333-3333-4333-8333-333333333333',hash='a'.repeat(64),stamp='2026-09-30T00:00:00.000Z'
const mapping={delimiter:',' as const,headerRow:1,primaryKey:[{column:0,trim:false}],title:{column:1,trim:false},fields:[]}
const draft={format:'teloa.business-record-import/v1',id,stageRequestId:requestId,ownerId:'self',scope:'sales',type:'customer',sourceIdentity:hash,revision:1,status:'ready',file:{attachmentId:'attachment',name:'客户.csv',bytes:1,sha256:hash},createdAt:stamp,updatedAt:stamp}
const inspection={format:'teloa.business-import-inspection/v1',draftId:id,scope:'sales',type:'customer',fileHash:hash,revision:1,delimiter:',',parserVersion:'csv-v1',headerRow:1,columns:[{column:0,header:'编号'},{column:1,header:'名称'}],sampleRows:[{rowNumber:2,cells:['001','客户一']}],sampleRowsOmitted:0,dataRows:1,issues:[],complete:true,canMap:true}
const preview={revision:2,digest:hash,schemaFingerprint:hash,writeSchemaFingerprint:hash,configurationVersion:1,sourceIdentity:hash,sourcePolicyDigest:hash,contentKey:hash,mapping,rows:[{rowNumber:2,primaryKey:['001'],operation:{operation:'create',type:'customer',title:'客户一',summary:'',fields:[]}}],issues:[],canApply:true}
const receipt={requestId:applyId,canonicalRequestId:applyId,draftId:id,scope:'sales',type:'customer',fileHash:hash,previewDigest:hash,sourceIdentity:hash,sourcePolicyDigest:hash,contentKey:hash,created:1,references:[{scope:'sales',type:'customer',id:'44444444-4444-4444-8444-444444444444',version:1,snapshotHash:hash}],appliedAt:stamp}
async function factory(){assert.ok(existsSync(source),'缺少严格导入API');return (await import('../src/client/business-import-api.ts')).createBusinessImportApi}
test('strict_stage_checks_original_request_target_file_and_unknown_keys',async()=>{
 const make=await factory(),input={requestId,scope:'sales',type:'customer',name:'客户.csv',bytes:1,dataBase64:'YQ=='};let calls=0
 const api=make(async(method)=>{calls++;assert.equal(method,'business-imports/stage');return draft})
 assert.equal((await api.stage(input)).id,id)
 await assert.rejects(api.stage({...input,extra:true} as typeof input));assert.equal(calls,1)
 for(const patch of [{stageRequestId:applyId},{scope:'content'},{type:'expense'},{file:{...draft.file,name:'其他.csv'}}])await assert.rejects(make(async()=>({...draft,...patch})).stage(input),{code:'teloa/invalid-host-response'})
})
test('null_receipts_are_unknown_and_undefined_or_wrong_requests_are_rejected',async()=>{
 const make=await factory();assert.equal(await make(async()=>null).stageReceipt({requestId,scope:'sales',type:'customer'}),null)
 assert.equal(await make(async()=>null).receipt({requestId:applyId,scope:'sales'}),null)
 await assert.rejects(make(async()=>undefined).receipt({requestId:applyId,scope:'sales'}))
 await assert.rejects(make(async()=>receipt).receipt({requestId,scope:'sales'}))
 await assert.rejects(make(async()=>draft).stageReceipt({requestId,scope:'content',type:'customer'}))
})
test('inspect_checks_cached_file_identity_revision_delimiter_and_complete_boundaries',async()=>{
 const make=await factory();let response:unknown=draft;const api=make(async()=>response);await api.get({draftId:id})
 const input={draftId:id,expectedRevision:1,delimiter:',' as const};response=inspection;assert.equal((await api.inspect(input)).dataRows,1)
 for(const patch of [{fileHash:'b'.repeat(64)},{revision:2},{delimiter:';'},{scope:'content'},{dataRows:2},{sampleRows:[{rowNumber:2,cells:['001']}]}]){response={...inspection,...patch};await assert.rejects(api.inspect(input))}
})
test('preview_apply_and_cancel_check_frozen_revision_mapping_digest_and_refs',async()=>{
 const make=await factory();let response:unknown=draft;const api=make(async()=>response);await api.get({draftId:id})
 response={...draft,revision:2,status:'previewed',mapping,preview};assert.equal((await api.preview({draftId:id,expectedRevision:1,mapping})).revision,2)
 response={...draft,revision:2,status:'previewed',mapping:{...mapping,title:{column:0,trim:false}},preview:{...preview,mapping:{...mapping,title:{column:0,trim:false}}}};await assert.rejects(api.preview({draftId:id,expectedRevision:1,mapping}))
 response=receipt;assert.equal((await api.apply({requestId:applyId,draftId:id,previewRevision:2,previewDigest:hash})).created,1)
 for(const patch of [{requestId},{previewDigest:'b'.repeat(64)},{fileHash:'b'.repeat(64)},{references:[{...receipt.references[0],scope:'content'}]}]){response={...receipt,...patch};await assert.rejects(api.apply({requestId:applyId,draftId:id,previewRevision:2,previewDigest:hash}))}
 response={...draft,revision:3,status:'cancelled',mapping,preview};assert.equal((await api.cancel({requestId:applyId,draftId:id,expectedRevision:2})).status,'cancelled')
 response={...draft,revision:4,status:'ready',mapping};assert.equal((await api.resume({requestId:applyId,draftId:id,expectedRevision:3})).status,'ready')
})
test('rejected_target_response_cannot_poison_later_valid_draft_reads',async()=>{const make=await factory();let response:unknown={...draft,scope:'content'};const api=make(async()=>response),input={requestId,scope:'sales',type:'customer',name:'客户.csv',bytes:1,dataBase64:'YQ=='};await assert.rejects(api.stage(input));response=draft;assert.equal((await api.stage(input)).scope,'sales')})
test('cancel_resume_noops_and_accepted_replays_read_current_revision_without_inventing_changes',async()=>{
 const make=await factory(),api=make(async(method)=>method.endsWith('/cancel')?{...draft,status:'cancelled',revision:3,mapping}:{...draft,status:'ready',revision:4,mapping})
 assert.equal((await api.cancel({requestId:applyId,draftId:id,expectedRevision:3})).revision,3)
 assert.equal((await api.resume({requestId:applyId,draftId:id,expectedRevision:4})).revision,4)
 assert.equal((await api.cancel({requestId:applyId,draftId:id,expectedRevision:1})).revision,3)
 assert.equal((await api.resume({requestId:applyId,draftId:id,expectedRevision:1})).revision,4)
 await assert.rejects(api.cancel({requestId:applyId,draftId:id,expectedRevision:5}))
})
test('xlsx workbook reply stays bound to the uploaded original bytes',async()=>{
 const make=await factory(),bytes='YQ==',fileHash='ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'
 const sheet={sheetId:'1',name:'客户',part:'xl/worksheets/sheet1.xml'}
 const policy={parserVersion:'xlsx-scalar-v1',scalarPolicy:'closed-scalar-v1',datePolicy:'reject-date-v1',formulaPolicy:'reject-formula-v1'}
 let reply:Record<string,unknown>={format:'teloa.business-import-workbook/v2',fileHash,bytes:1,sheets:[sheet],policy}
 const api=make(async(method)=>{assert.equal(method,'business-imports/workbook');return reply})
 const input={scope:'sales',type:'customer',name:'客户.xlsx',bytes:1,dataBase64:bytes}
 assert.equal((await api.workbook(input)).sheets[0]?.name,'客户')
 reply={...reply,fileHash:hash};await assert.rejects(api.workbook(input),{code:'teloa/invalid-host-response'})
 reply={format:'teloa.business-import-workbook/v2',fileHash,bytes:2,sheets:[sheet],policy};await assert.rejects(api.workbook(input),{code:'teloa/invalid-host-response'})
})
