import test from 'node:test'
import assert from 'node:assert/strict'
import * as module from '../src/business-import-handler.ts'
import {readBusinessImportDraft,readBusinessImportReceipt,readBusinessImportDraftV2,type BusinessImportActor} from '@teloa/contract'

const requestId='11111111-1111-4111-8111-111111111111',draftId='22222222-2222-4222-8222-222222222222',otherId='33333333-3333-4333-8333-333333333333'
const hash='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',stamp='2026-09-30T00:00:00.000Z'
const mapping={delimiter:',' as const,headerRow:1,primaryKey:[{column:0,trim:false}],title:{column:1,trim:true},fields:[]}
const draft=readBusinessImportDraft({format:'teloa.business-record-import/v1',id:draftId,stageRequestId:requestId,ownerId:'owner',scope:'crm',type:'customer',sourceIdentity:hash,revision:2,status:'previewed',file:{attachmentId:'attachment',name:'客户.csv',bytes:3,sha256:hash},mapping,preview:{revision:2,digest:hash,schemaFingerprint:hash,writeSchemaFingerprint:hash,configurationVersion:1,sourceIdentity:hash,sourcePolicyDigest:hash,contentKey:hash,mapping,rows:[{rowNumber:2,primaryKey:['001'],operation:{operation:'create',type:'customer',title:'客户',summary:'',fields:[]}}],issues:[],canApply:true},createdAt:stamp,updatedAt:stamp})
const receipt=readBusinessImportReceipt({requestId,canonicalRequestId:requestId,draftId,scope:'crm',type:'customer',fileHash:hash,previewDigest:hash,sourceIdentity:hash,sourcePolicyDigest:hash,contentKey:hash,created:1,references:[{scope:'crm',type:'customer',id:otherId,version:1,snapshotHash:hash}],appliedAt:stamp})
const stage={requestId,scope:'crm',type:'customer',name:'客户.csv',bytes:3,dataBase64:'YWJj'}
function fixture(){
 let scopes=['general','crm'],calls=0,result:unknown=draft,stored:unknown=draft
 const called=async(actor:BusinessImportActor)=>{calls++;assert.deepEqual(actor,{ownerId:'owner',scopeIds:['crm']});return result}
 const imports={stage:called,stageReceipt:called,get:async(actor:BusinessImportActor)=>{await called(actor);return stored},inspectWorkbook:called,inspect:called,preview:called,apply:called,cancel:called,resume:called,receipt:called}
 const handler=module.createBusinessImportHandler('owner',async()=>scopes,async()=>({imports}) as never)
 return {handler,imports,calls:()=>calls,setResult:(value:unknown)=>{result=value;stored=value},setStored:(value:unknown)=>stored=value,setScopes:(value:string[])=>scopes=value}
}
test('上传与无draftId的原stage回执核对真实本人和目标；只读缺失明确null',async()=>{
 const f=fixture()
 assert.deepEqual(await f.handler('business-imports/stage',stage),draft)
 assert.deepEqual(await f.handler('business-imports/stage-receipt',{requestId,scope:'crm',type:'customer'}),draft)
 f.setResult(undefined)
 assert.equal(await f.handler('business-imports/stage-receipt',{requestId,scope:'crm',type:'customer'}),null)
 assert.equal(await f.handler('business-imports/receipt',{requestId,scope:'crm'}),null)
 await assert.rejects(f.handler('business-imports/get',{draftId}),{code:'teloa/invalid-host-response'})
})
test('额外owner、伪来源和未授权scope在触达服务前拒绝',async()=>{
 const f=fixture()
 for(const input of [{...stage,ownerId:'other'},{...stage,attachmentId:'foreign'},{...stage,scope:'other'}])await assert.rejects(f.handler('business-imports/stage',input))
 f.setScopes(['general'])
 await assert.rejects(f.handler('business-imports/stage-receipt',{requestId,scope:'crm',type:'customer'}),{code:'teloa/forbidden'})
 assert.equal(f.calls(),0)
 await assert.rejects(f.handler('business-imports/unknown',{}),{code:'teloa/not-found'})
})
test('草案回包不能借合法结构串本人、业务、对象、草案或原stage请求',async()=>{
 const f=fixture()
 for(const change of [{ownerId:'other'},{scope:'other'},{type:'other'},{stageRequestId:otherId}]){
  f.setResult({...draft,...change})
  await assert.rejects(f.handler('business-imports/stage-receipt',{requestId,scope:'crm',type:'customer'}),{code:'teloa/invalid-host-response'})
 }
 f.setResult({...draft,id:otherId})
 await assert.rejects(f.handler('business-imports/get',{draftId}),{code:'teloa/invalid-host-response'})
})
test('inspect必须对应原草案revision和显式delimiter；不把检查失败包装成完整表',async()=>{
 const f=fixture(),inspection={format:'teloa.business-import-inspection/v1',draftId,scope:'crm',type:'customer',fileHash:hash,revision:2,delimiter:',',parserVersion:'csv-v1',headerRow:1,columns:[{column:0,header:'编号'},{column:1,header:' 名称 '}],sampleRows:[{rowNumber:2,cells:['001',' 客户 ']}],sampleRowsOmitted:0,dataRows:1,issues:[],complete:true,canMap:true}
 f.setResult(inspection)
 f.setStored(draft)
 assert.deepEqual(await f.handler('business-imports/inspect',{draftId,expectedRevision:2,delimiter:','}),inspection)
 for(const change of [{draftId:otherId},{revision:3},{delimiter:';'},{scope:'other'}]){
  f.setResult({...inspection,...change})
  f.setStored(draft)
  await assert.rejects(f.handler('business-imports/inspect',{draftId,expectedRevision:2,delimiter:','}),{code:'teloa/invalid-host-response'})
 }
 f.imports.inspect=async()=>{throw Error('文件不可读取')}
 await assert.rejects(f.handler('business-imports/inspect',{draftId,expectedRevision:2,delimiter:','}),/文件不可读取/)
})
test('apply和receipt保留新请求与原canonical身份，错误digest和业务不能伪造成功',async()=>{
 const f=fixture(),input={requestId,draftId,previewRevision:2,previewDigest:hash}
 f.setResult({...receipt,canonicalRequestId:otherId})
 f.setStored(draft)
 assert.deepEqual(await f.handler('business-imports/apply',input),{...receipt,canonicalRequestId:otherId})
 for(const change of [{requestId:otherId},{draftId:otherId},{previewDigest:'b'.repeat(64)},{scope:'other'}]){
  f.setResult({...receipt,...change})
  f.setStored(draft)
  await assert.rejects(f.handler('business-imports/apply',input),{code:'teloa/invalid-host-response'})
 }
 f.setResult(receipt)
 assert.deepEqual(await f.handler('business-imports/receipt',{requestId,scope:'crm'}),receipt)
 f.setResult({...receipt,requestId:otherId})
 await assert.rejects(f.handler('business-imports/receipt',{requestId,scope:'crm'}),{code:'teloa/invalid-host-response'})
})
test('取消迟到于apply时保留真实applied，不伪称撤销成功',async()=>{
 const f=fixture(),applied={...draft,revision:3,status:'applied',receipt}
 f.setResult(applied)
 assert.deepEqual(await f.handler('business-imports/cancel',{requestId:otherId,draftId,expectedRevision:2}),applied)
})
test('先前授权不能给下一次请求，取消前后均不返回迟到数据',async()=>{
 const f=fixture(),abort=new AbortController()
 abort.abort(Error('已取消'))
 await assert.rejects(f.handler('business-imports/get',{draftId},abort.signal),/已取消/)
 assert.equal(f.calls(),0)
 const inFlight=new AbortController()
 f.imports.get=async()=>{inFlight.abort(Error('切换业务'));return draft}
 await assert.rejects(f.handler('business-imports/get',{draftId},inFlight.signal),/切换业务/)
 f.setScopes(['general'])
 f.setResult(receipt)
 await assert.rejects(f.handler('business-imports/receipt',{requestId,scope:'crm'}),{code:'teloa/forbidden'})
})

const source={kind:'xlsx' as const,sheet:{sheetId:'2',name:'准确订单表',part:'xl/worksheets/sheet2.xml'}}
const policy={parserVersion:'xlsx-scalar-v1' as const,scalarPolicy:'closed-scalar-v1' as const,datePolicy:'reject-date-v1' as const,formulaPolicy:'reject-formula-v1' as const}
const {delimiter:_,...xlsxMapping}=mapping
const xlsxDraft=readBusinessImportDraftV2({...draft,format:'teloa.business-record-import/v2',file:{...draft.file,name:'客户.xlsx'},source,policy,mapping:xlsxMapping,preview:{...draft.preview,format:'teloa.business-import-preview/v2',source,policy,rawCellsDigest:hash,mapping:xlsxMapping}})
const xlsxStage={...stage,name:'客户.xlsx',format:'teloa.business-import-stage/v2',source}
const xlsxReceipt={...receipt,format:'teloa.business-import-receipt/v2',source,policy,rawCellsDigest:hash}
test('workbook只读绑定入参原文件SHA和bytes，权限与取消仍严格拒绝',async()=>{
 const f=fixture(),input={scope:'crm',type:'customer',name:'客户.xlsx',bytes:3,dataBase64:'YWJj'},workbook={format:'teloa.business-import-workbook/v2',fileHash:hash,bytes:3,sheets:[source.sheet],policy}
 f.setResult(workbook)
 assert.deepEqual(await f.handler('business-imports/workbook',input),workbook)
 assert.equal(f.calls(),1)
 for(const change of [{fileHash:'b'.repeat(64)},{bytes:4}]){f.setResult({...workbook,...change});await assert.rejects(f.handler('business-imports/workbook',input),{code:'teloa/invalid-host-response'})}
 const before=f.calls();await assert.rejects(f.handler('business-imports/workbook',{...input,ownerId:'foreign'}));await assert.rejects(f.handler('business-imports/workbook',{...input,scope:'other'}),{code:'teloa/forbidden'});assert.equal(f.calls(),before)
 const abort=new AbortController();f.imports.inspectWorkbook=async()=>{abort.abort(Error('目标改变'));return workbook}
 await assert.rejects(f.handler('business-imports/workbook',input,abort.signal),/目标改变/)
})
test('stage必须显式v2并核准确sheet、原文件与版本，不收养第一张表或CSV回包',async()=>{
 const f=fixture();f.setResult(xlsxDraft)
 assert.deepEqual(await f.handler('business-imports/stage',xlsxStage),xlsxDraft)
 const wrongSource={kind:'xlsx',sheet:{...source.sheet,sheetId:'1'}}
 for(const value of [draft,{...xlsxDraft,source:wrongSource,preview:{...xlsxDraft.preview,source:wrongSource}},{...xlsxDraft,file:{...xlsxDraft.file,sha256:'b'.repeat(64)}},{...xlsxDraft,file:{...xlsxDraft.file,bytes:4}},{...xlsxDraft,file:{...xlsxDraft.file,name:'其他.xlsx'}}]){f.setResult(value);await assert.rejects(f.handler('business-imports/stage',xlsxStage),{code:'teloa/invalid-host-response'})}
 await assert.rejects(f.handler('business-imports/stage',{...xlsxStage,format:'unknown'}),{code:'teloa/invalid-input'})
 f.setResult(xlsxDraft);await assert.rejects(f.handler('business-imports/stage',stage),{code:'teloa/invalid-host-response'})
})
test('v2 inspect与preview回包绑定原草案sheet/file/type，错误版本不触发写入',async()=>{
 const f=fixture(),inspection={format:'teloa.business-import-inspection/v2',draftId,scope:'crm',type:'customer',fileHash:hash,revision:2,source,policy,rawCellsDigest:hash,headerRow:1,columns:[{column:0,header:'编号'},{column:1,header:'名称'}],sampleRows:[{rowNumber:2,cells:[{kind:'string',text:'001'},{kind:'string',text:'客户'}]}],sampleRowsOmitted:0,dataRows:1,issues:[],complete:true,canMap:true}
 f.setResult(inspection);f.setStored(xlsxDraft)
 const input={format:'teloa.business-import-inspect/v2',draftId,expectedRevision:2}
 assert.deepEqual(await f.handler('business-imports/inspect',input),inspection)
 for(const change of [{source:{kind:'xlsx',sheet:{...source.sheet,name:'另一张表'}}},{fileHash:'b'.repeat(64)},{type:'other'},{revision:3}]){f.setResult({...inspection,...change});f.setStored(xlsxDraft);await assert.rejects(f.handler('business-imports/inspect',input),{code:'teloa/invalid-host-response'})}
 f.setResult(xlsxDraft);f.setStored(xlsxDraft)
 const previewInput={format:'teloa.business-import-preview-input/v2',draftId,expectedRevision:2,mapping:xlsxMapping}
 assert.deepEqual(await f.handler('business-imports/preview',previewInput),xlsxDraft)
 f.setResult(draft);f.setStored(xlsxDraft);await assert.rejects(f.handler('business-imports/preview',previewInput),{code:'teloa/invalid-host-response'})
 const differentMapping={...xlsxMapping,title:{column:0,trim:false}}
 f.setResult({...xlsxDraft,mapping:differentMapping,preview:{...xlsxDraft.preview,mapping:differentMapping}});f.setStored(xlsxDraft)
 await assert.rejects(f.handler('business-imports/preview',previewInput),{code:'teloa/invalid-host-response'})
 f.setResult(inspection);f.setStored(draft);await assert.rejects(f.handler('business-imports/inspect',input),{code:'teloa/invalid-host-response'})
})
test('v2 apply核原草案sheet与raw事实，仍允许读取历史CSV回执',async()=>{
 const f=fixture(),input={requestId,draftId,previewRevision:2,previewDigest:hash}
 f.setResult(xlsxReceipt);f.setStored(xlsxDraft)
 assert.deepEqual(await f.handler('business-imports/apply',input),xlsxReceipt)
 for(const value of [receipt,{...xlsxReceipt,source:{kind:'xlsx',sheet:{...source.sheet,part:'xl/worksheets/other.xml'}}},{...xlsxReceipt,rawCellsDigest:'b'.repeat(64)}]){f.setResult(value);f.setStored(xlsxDraft);await assert.rejects(f.handler('business-imports/apply',input),{code:'teloa/invalid-host-response'})}
 f.setResult(receipt);assert.deepEqual(await f.handler('business-imports/receipt',{requestId,scope:'crm'}),receipt)
})
test('v1 inspect/preview不额外读草案，v2读取一次，历史applied revision不否定原合法回执',async()=>{
 const f=fixture()
 f.setResult(draft)
 assert.deepEqual(await f.handler('business-imports/preview',{draftId,expectedRevision:2,mapping}),draft)
 assert.equal(f.calls(),1)
 f.setResult(xlsxDraft);f.setStored(xlsxDraft)
 assert.deepEqual(await f.handler('business-imports/preview',{format:'teloa.business-import-preview-input/v2',draftId,expectedRevision:2,mapping:xlsxMapping}),xlsxDraft)
 assert.equal(f.calls(),3)
 f.setResult(xlsxReceipt);f.setStored({...xlsxDraft,status:'applied',revision:3,receipt:xlsxReceipt})
 assert.deepEqual(await f.handler('business-imports/apply',{requestId,draftId,previewRevision:2,previewDigest:hash}),xlsxReceipt)
 assert.equal(f.calls(),5)
})
test('v2 stageReceipt/get/cancel/resume沿旧端点严格读回固定来源',async()=>{
 const f=fixture();f.setResult(xlsxDraft)
 assert.deepEqual(await f.handler('business-imports/stage-receipt',{requestId,scope:'crm',type:'customer'}),xlsxDraft)
 assert.deepEqual(await f.handler('business-imports/get',{draftId}),xlsxDraft)
 for(const method of ['cancel','resume'])assert.deepEqual(await f.handler('business-imports/'+method,{requestId:otherId,draftId,expectedRevision:2}),xlsxDraft)
 f.setResult({...xlsxDraft,format:'teloa.business-record-import/v3'})
 await assert.rejects(f.handler('business-imports/get',{draftId}),{code:'teloa/invalid-host-response'})
})
