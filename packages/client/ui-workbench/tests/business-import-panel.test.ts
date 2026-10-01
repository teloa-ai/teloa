import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无界面浏览器夹具。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {BusinessImportPanel} from '${client}BusinessImportPanel.tsx';import {BusinessImportFlow} from '${client}business-import-flow.ts';import {createBusinessImportApi} from '${client}business-import-api.ts';import {createBusinessRecordApi} from '${client}business-record-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);
const stamp='2026-09-30T00:00:00.000Z',hash='a'.repeat(64),id='11111111-1111-4111-8111-111111111111',contactId='44444444-4444-4444-8444-444444444444';let draft,journal=null,n=0;
const fixture=window.importFixture={calls:[],inspectionFails:false,sourceConflict:false,holdApply:false};let release;fixture.release=()=>release?.();
const definition={format:'teloa.business-object-type/v2',domain:'sales',id:'customer',version:'1.0.0',sourceId:'records',title:'客户',unit:'条',lead:'',fields:[{format:'teloa.business-rich-field/v2',name:'amount',label:'费用',from:'amount',type:'money',currencies:['SGD','USD'],required:false},{format:'teloa.business-rich-field/v2',name:'tags',label:'标签',from:'tags',type:'multi-enum',values:['重点','续约'],required:false},{format:'teloa.business-rich-field/v2',name:'contacts',label:'联系人',from:'contacts',type:'multi-reference',referenceType:'contact',required:false}]};
const rows=Array.from({length:6},(_,index)=>({rowNumber:index+2,cells:[index===0?' 001 ':String(index+1).padStart(3,'0'),index===5?'完整长文本 '+ '长'.repeat(200):'客户'+(index+1),'9007199254740993.12','SGD','["重点","续约"]',JSON.stringify([contactId])]}));
const xlsxSheet={sheetId:'2',name:'客户数据',part:'xl/worksheets/sheet2.xml'},otherSheet={sheetId:'1',name:'说明',part:'xl/worksheets/sheet1.xml'},xlsxSource={kind:'xlsx',sheet:xlsxSheet},xlsxPolicy={parserVersion:'xlsx-scalar-v1',scalarPolicy:'closed-scalar-v1',datePolicy:'reject-date-v1',formulaPolicy:'reject-formula-v1'};
const api=createBusinessImportApi(async(method,input)=>{fixture.calls.push({method,input});switch(method){
case 'business-imports/workbook':{const bytes=Uint8Array.from(atob(input.dataBase64),c=>c.charCodeAt(0)),fileHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');return {format:'teloa.business-import-workbook/v2',fileHash,bytes:input.bytes,sheets:[otherSheet,xlsxSheet],policy:xlsxPolicy}}
case 'business-imports/stage':{const bytes=Uint8Array.from(atob(input.dataBase64),c=>c.charCodeAt(0)),fileHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');draft={format:input.format?'teloa.business-record-import/v2':'teloa.business-record-import/v1',...(input.format?{source:input.source,policy:xlsxPolicy}:{}),id,stageRequestId:input.requestId,ownerId:'self',scope:'sales',type:'customer',sourceIdentity:hash,revision:1,status:'ready',file:{attachmentId:'attachment',name:input.name,bytes:input.bytes,sha256:fileHash},createdAt:stamp,updatedAt:stamp};return draft}
case 'business-imports/inspect':return fixture.inspectionFails?{format:'teloa.business-import-inspection/v1',draftId:id,scope:'sales',type:'customer',fileHash:draft.file.sha256,revision:draft.revision,delimiter:input.delimiter,parserVersion:'csv-v1',headerRow:1,columns:[],sampleRows:[],issues:[{rowNumber:3,column:2,code:'ragged-rows',message:'第3行列数不同'}],complete:false,canMap:false}:{format:input.format?'teloa.business-import-inspection/v2':'teloa.business-import-inspection/v1',...(input.format?{source:xlsxSource,policy:xlsxPolicy,rawCellsDigest:hash}:{delimiter:input.delimiter,parserVersion:'csv-v1'}),draftId:id,scope:'sales',type:'customer',fileHash:draft.file.sha256,revision:draft.revision,headerRow:1,columns:['编号','名称','名称','','标签','联系人'].map((header,column)=>({column,header})),sampleRows:input.format?rows.slice(0,5).map(row=>({rowNumber:row.rowNumber,cells:row.cells.map(text=>({kind:'string',text}))})):rows.slice(0,5),sampleRowsOmitted:1,dataRows:6,issues:[],complete:true,canMap:true};
case 'business-imports/preview':{const p={...(input.format?{format:'teloa.business-import-preview/v2',source:xlsxSource,policy:xlsxPolicy,rawCellsDigest:hash}:{}),revision:draft.revision+1,digest:hash,schemaFingerprint:hash,writeSchemaFingerprint:hash,configurationVersion:1,sourceIdentity:hash,sourcePolicyDigest:hash,contentKey:hash,mapping:input.mapping,rows:rows.map(row=>({rowNumber:row.rowNumber,primaryKey:[input.mapping.primaryKey[0].trim?row.cells[0].trim():row.cells[0]],operation:{operation:'create',type:'customer',title:row.cells[1],summary:'',fields:[{name:'amount',value:'{"currency":"SGD","decimal":"9007199254740993.12"}'},{name:'tags',value:row.cells[4]},{name:'contacts',value:row.cells[5]}]}})),issues:fixture.sourceConflict?[{rowNumber:2,column:0,code:'source-policy-conflict',message:'此文件已有不同映射的固定批次'}]:[],canApply:!fixture.sourceConflict};draft={...draft,revision:p.revision,status:'previewed',mapping:input.mapping,preview:p};return draft}
case 'business-imports/apply':if(fixture.holdApply)await new Promise(resolve=>{release=resolve});return {...(draft.format==='teloa.business-record-import/v2'?{format:'teloa.business-import-receipt/v2',source:xlsxSource,policy:xlsxPolicy,rawCellsDigest:hash}:{}),requestId:input.requestId,canonicalRequestId:fixture.alias?'55555555-5555-4555-8555-555555555555':input.requestId,draftId:id,scope:'sales',type:'customer',fileHash:draft.file.sha256,previewDigest:input.previewDigest,sourceIdentity:hash,sourcePolicyDigest:hash,contentKey:hash,created:6,references:rows.map((_,index)=>({scope:'sales',type:'customer',id:'66666666-6666-4666-8666-'+String(index+1).padStart(12,'0'),version:1,snapshotHash:hash})),appliedAt:stamp};
case 'business-imports/cancel':draft={...draft,status:'cancelled',revision:draft.revision+1};return draft;
case 'business-imports/resume':{const {preview,...keep}=draft;draft={...keep,status:'ready',revision:draft.revision+1};return draft}
case 'business-imports/get':case 'business-imports/stage-receipt':return draft;
case 'business-imports/receipt':return null;
}});
const records=createBusinessRecordApi(async(method,input)=>{fixture.calls.push({method,input});if(fixture.relationFails)throw Error('unavailable');return {scope:'sales',type:'contact',id:contactId,version:1,snapshotHash:hash,title:'实际联系人',summary:'',source:'records',observedAt:stamp,receivedAt:stamp,quality:fixture.relationMissing?'missing':'complete',fields:[],...(fixture.archived?{deletedAt:stamp}:{})}});
const flow=fixture.flow=new BusinessImportFlow({api,records,ownerId:'self',personalSpaceId:'personal-self',scope:'sales',type:'customer',journal:{read:()=>journal,write:value=>journal=value,clear:()=>journal=null},isCurrent:()=>true,id:()=>n++===0?'22222222-2222-4222-8222-222222222222':'33333333-3333-4333-8333-333333333333'});fixture.snapshot=()=>flow.getSnapshot();
const snapshot={locale:document.documentElement.lang,dshLocale:'zh-CN',revision:1},runtime={t:key=>key,subscribe:()=>()=>{},getSnapshot:()=>snapshot};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><main><BusinessImportPanel flow={flow} scope="sales" type="customer" definition={definition}/></main></I18nProvider>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-import-panel-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ImportPanelFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,width=1280){
 const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(6000);const errors:string[]=[]
 page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.goto('https://fixture.invalid');await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0;font-family:system-ui}main{max-width:1100px;padding:20px;margin:auto}'+styles});await page.addScriptTag({content:script});return page
}
async function upload(page:any){await page.getByLabel('CSV 或 XLSX 文件',{exact:true}).setInputFiles({name:'客户.csv',mimeType:'text/csv',buffer:Buffer.from('fixture file bytes')});await page.getByText('文件已保存',{exact:false}).waitFor();await page.getByLabel('分隔符',{exact:true}).selectOption(',');await page.getByRole('button',{name:'读取表头与样例',exact:true}).click()}
async function map(page:any){await page.getByLabel('主键第1列',{exact:true}).selectOption('0');await page.getByLabel('标题列',{exact:true}).selectOption('1');await page.getByLabel('费用来源列',{exact:true}).selectOption('2');await page.getByLabel('费用币种',{exact:true}).selectOption('SGD');await page.getByLabel('标签来源列',{exact:true}).selectOption('4');await page.getByLabel('联系人来源列',{exact:true}).selectOption('5')}
for(const width of [390,1280])test(width+' xlsx_sheet_selection_keeps_typed_original_and_confirmed_apply',async t=>{
 const page=await mount(t,width)
 await page.getByLabel('CSV 或 XLSX 文件',{exact:true}).setInputFiles({name:'客户.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('fixture file bytes')})
 await page.getByRole('group',{name:'选择工作表'}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).importFixture.calls.some((call:any)=>call.method==='business-imports/stage')),false)
 await page.getByRole('button',{name:'客户数据',exact:true}).click()
 await page.getByText('文件已保存',{exact:false}).waitFor()
 assert.equal(await page.getByLabel('分隔符',{exact:true}).count(),0)
 await page.getByRole('button',{name:'读取表头与样例',exact:true}).click()
 await page.getByText('已完整读取6行数据；以下仅为前5行样例，另1行未展示。',{exact:true}).waitFor()
 await map(page);await page.getByRole('button',{name:'生成全部行预览',exact:true}).click()
 await page.getByText('全部6行规范结果',{exact:true}).waitFor()
 const calls=await page.evaluate(()=>(window as any).importFixture.calls)
 assert.equal(calls.find((call:any)=>call.method==='business-imports/stage').input.source.sheet.name,'客户数据')
 assert.equal(Object.hasOwn(calls.find((call:any)=>call.method==='business-imports/preview').input.mapping,'delimiter'),false)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.getByRole('checkbox',{name:'我已核对全部行并确认导入',exact:true}).check()
 await page.getByRole('button',{name:'确认导入',exact:true}).click()
 await page.getByText('已导入批次：6条记录',{exact:true}).waitFor()
})
test('late_sheet_file_read_cannot_replace_a_newer_selected_workbook',async t=>{
 const page=await mount(t)
 await page.getByLabel('CSV 或 XLSX 文件',{exact:true}).setInputFiles({name:'A.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('first workbook')})
 await page.getByRole('group',{name:'选择工作表'}).waitFor()
 await page.evaluate(()=>{
  const original=File.prototype.arrayBuffer;let release:(()=>void)|undefined
  File.prototype.arrayBuffer=function(){if(this.name!=='A.xlsx')return original.call(this);return new Promise(resolve=>{release=()=>{void original.call(this).then(resolve)}})}
  ;(window as any).importFixture.releaseFileRead=()=>release?.()
 })
 await page.getByRole('button',{name:'客户数据',exact:true}).click()
 await page.getByLabel('CSV 或 XLSX 文件',{exact:true}).setInputFiles({name:'B.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('newer workbook')})
 await page.waitForFunction(()=>(window as any).importFixture.calls.filter((call:any)=>call.method==='business-imports/workbook').length===2)
 await page.getByRole('group',{name:'选择工作表'}).waitFor()
 await page.evaluate(()=>(window as any).importFixture.releaseFileRead())
 await page.waitForTimeout(50)
 assert.equal(await page.evaluate(()=>(window as any).importFixture.calls.some((call:any)=>call.method==='business-imports/stage')),false)
 assert.equal(await page.evaluate(()=>(window as any).importFixture.snapshot().phase),'selecting-sheet')
})
for(const width of [390,1280])test(width+' inspect_before_mapping_uses_headers_column_numbers_and_marked_samples_and_all_rows',async t=>{
 const page=await mount(t,width);await upload(page);await page.getByText('已完整读取6行数据；以下仅为前5行样例，另1行未展示。',{exact:true}).waitFor();assert.equal(await page.locator('[data-source-row]').count(),5)
 assert.equal(await page.getByLabel('费用来源列',{exact:true}).locator('option').filter({hasText:'第3列 · 名称'}).count(),1);assert.equal(await page.getByLabel('标题列',{exact:true}).locator('option').filter({hasText:'第2列 · 名称'}).count(),1)
 await map(page);await page.getByLabel('主键第1列去除首尾空白',{exact:true}).check();await page.getByRole('button',{name:'生成全部行预览',exact:true}).focus();await page.keyboard.press('Enter');await page.getByText('全部6行规范结果',{exact:true}).waitFor()
 assert.equal(await page.locator('[data-preview-row]').count(),6);assert.equal(await page.getByText('SGD 9007199254740993.12',{exact:true}).count(),6);assert.equal(await page.getByText('实际联系人',{exact:true}).count(),6)
 const calls=await page.evaluate(()=>(window as any).importFixture.calls);assert.equal(calls.some((c:any)=>c.method.endsWith('/apply')),false);const m=calls.find((c:any)=>c.method.endsWith('/preview')).input.mapping;assert.deepEqual(m.primaryKey,[{column:0,trim:true}]);assert.deepEqual(m.fields.map((f:any)=>f.field),['amount','contacts','tags'])
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.locator('[data-preview-row="7"] details summary').first().focus();await page.keyboard.press('Enter');assert.equal(await page.locator('[data-preview-row="7"] details[open]').count(),1)
 await page.getByRole('checkbox',{name:'我已核对全部行并确认导入',exact:true}).check();await page.evaluate(()=>{(window as any).importFixture.alias=true;(window as any).importFixture.holdApply=true});await page.getByRole('button',{name:'确认导入',exact:true}).click();await page.waitForFunction(()=>(window as any).importFixture.calls.some((c:any)=>c.method.endsWith('/apply')));assert.equal(await page.getByRole('button',{name:'正在导入',exact:true}).isDisabled(),true);await page.evaluate(()=>(window as any).importFixture.release());await page.getByText('已导入批次：6条记录',{exact:true}).waitFor();await page.getByText('此文件与已有固定批次一致，已返回原批次。',{exact:true}).waitFor()
})
test('inspection_errors_block_mapping_and_keyboard_focuses_real_row_issue',async t=>{const page=await mount(t,390);await page.evaluate(()=>{(window as any).importFixture.inspectionFails=true});await upload(page);await page.getByRole('button',{name:'第3行 · 第3列：第3行列数不同',exact:true}).focus();await page.keyboard.press('Enter');assert.equal(await page.locator(':focus').getAttribute('data-issue'),'0');assert.equal(await page.getByRole('button',{name:'生成全部行预览',exact:true}).isDisabled(),true)})
test('mapping_changes_invalidate_confirmation_and_cancel_resume_preserves_host_mapping',async t=>{const page=await mount(t);await upload(page);await map(page);await page.getByRole('button',{name:'生成全部行预览',exact:true}).click();await page.getByText('全部6行规范结果',{exact:true}).waitFor();await page.getByRole('checkbox',{name:'我已核对全部行并确认导入',exact:true}).check();await page.getByLabel('主键第1列去除首尾空白',{exact:true}).check();assert.equal(await page.getByRole('button',{name:'确认导入',exact:true}).isDisabled(),true);await page.getByRole('button',{name:'生成全部行预览',exact:true}).click();await page.getByRole('button',{name:'取消此草案',exact:true}).click();await page.getByText('草案已取消，文件和映射仍保留。',{exact:true}).waitFor();await page.getByRole('button',{name:'恢复草案',exact:true}).click();await page.getByText('文件已保存',{exact:false}).waitFor();assert.equal(await page.getByLabel('主键第1列',{exact:true}).inputValue(),'0');assert.equal(await page.getByRole('button',{name:'确认导入',exact:true}).isDisabled(),true)})
test('source_conflicts_and_unverified_relations_cannot_be_confirmed',async t=>{const page=await mount(t);await upload(page);await map(page);await page.evaluate(()=>{(window as any).importFixture.sourceConflict=true});await page.getByRole('button',{name:'生成全部行预览',exact:true}).click();await page.getByRole('button',{name:'第2行 · 第1列：此文件已有不同映射的固定批次',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'确认导入',exact:true}).isDisabled(),true);await page.evaluate(()=>{(window as any).importFixture.sourceConflict=false;(window as any).importFixture.relationFails=true});await page.getByRole('button',{name:'生成全部行预览',exact:true}).click();await page.getByRole('alert').filter({hasText:'关联记录尚未核对'}).waitFor();assert.equal(await page.getByRole('button',{name:'确认导入',exact:true}).isDisabled(),true);assert.equal(await page.getByText('实际联系人',{exact:true}).count(),0)})
test('archived_relation_titles_show_actual_status_and_block_confirmation',async t=>{const page=await mount(t);await upload(page);await map(page);await page.evaluate(()=>{(window as any).importFixture.archived=true});await page.getByRole('button',{name:'生成全部行预览',exact:true}).click();await page.getByText('实际联系人（已归档）',{exact:true}).first().waitFor();assert.equal(await page.getByRole('button',{name:'确认导入',exact:true}).isDisabled(),true)})
test('missing_relation_snapshot_does_not_claim_a_verified_title_or_enable_confirmation',async t=>{const page=await mount(t);await upload(page);await map(page);await page.evaluate(()=>{(window as any).importFixture.relationMissing=true});await page.getByRole('button',{name:'生成全部行预览',exact:true}).click();await page.getByText('全部6行规范结果',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'确认导入',exact:true}).isDisabled(),true);assert.equal(await page.evaluate(()=>(window as any).importFixture.snapshot().relationsReady),false);assert.equal(await page.getByText('实际联系人',{exact:true}).count(),0);await page.getByText('关联尚未核对',{exact:true}).first().waitFor()})
