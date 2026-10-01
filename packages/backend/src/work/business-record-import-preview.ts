import {createHash} from 'node:crypto'
import {
 WorkError,industryUpdateCanonical,readBusinessImportMapping,readBusinessImportTable,readBusinessImportIssues,
 readBusinessImportInspection,readBusinessImportPreview,readBusinessRecordCreate,encodeBusinessRichFieldValue,readBusinessRichFieldValue,
 type BusinessImportMapping,type BusinessImportTable,type BusinessImportIssue,type BusinessImportInspection,type BusinessImportPreview,
 type BusinessObjectTypeDefinition,type BusinessObjectTypeDefinitionV2,type BusinessObjectSnapshot,type BusinessObjectReference,
} from '@teloa/contract'
import {assertBusinessRecordFieldValue} from './business-record-values.ts'
import {businessRecordSchemaFingerprint,businessRecordImportWriteSchemaFingerprint} from './business-record-schema.ts'

type Definition=BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2
type InspectionInput={draftId:string;scope:string;type:string;fileHash:string;revision:number;delimiter:BusinessImportMapping['delimiter'];table?:BusinessImportTable;issues?:BusinessImportIssue[]}
type PreviewInput={scope:string;type:string;fileHash:string;revision:number;sourceIdentity:string;configurationVersion:number;definition:Definition;mapping:BusinessImportMapping;table?:BusinessImportTable;issues?:BusinessImportIssue[];sourceContentKey?:string|undefined;resolveReference?:(type:string,id:string)=>Promise<BusinessObjectSnapshot>;signal?:AbortSignal|undefined}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const canonicalBytes=(value:unknown)=>Buffer.byteLength(industryUpdateCanonical(value),'utf8')
export const businessImportHash=(value:unknown)=>createHash('sha256').update(industryUpdateCanonical(value)).digest('hex')
export const businessImportSourceIdentity=(owner:string,scope:string,type:string,fileHash:string)=>businessImportHash(['teloa.business-import-file-source/v1',owner,scope,type,fileHash])
export function checkBusinessImportSignal(signal?:AbortSignal):void{if(signal?.aborted)throw signal.reason??new WorkError('teloa/cancelled','表格导入已停止，尚未确认的草案已保留。')}
/** 仅折回冻结的解析问题；附件不可读、授权和取消仍保留原错误。 */
export function businessImportParseIssues(error:unknown):BusinessImportIssue[]{
 const codes=['invalid-utf8','invalid-csv','ragged-rows','empty-table','columns-too-many','rows-too-many','source-cell-too-long']
 if(!(error instanceof WorkError)||error.code!=='teloa/invalid-input')throw error
 let issues:BusinessImportIssue[]
 try{issues=readBusinessImportIssues(error.details?.businessImportIssues)}catch{throw error}
 if(!issues.length||issues.some(issue=>!codes.includes(issue.code)))throw error
 return issues
}
/** 样例只包含连续完整行；表头、原表数据均不做 trim 或截断。 */
export function buildBusinessImportInspection(input:InspectionInput):BusinessImportInspection{
 const base={format:'teloa.business-import-inspection/v1',draftId:input.draftId,scope:input.scope,type:input.type,fileHash:input.fileHash,revision:input.revision,delimiter:input.delimiter,parserVersion:'csv-v1',headerRow:1}
 const failure=(issues:BusinessImportIssue[])=>readBusinessImportInspection({...base,columns:[],sampleRows:[],issues,complete:false,canMap:false})
 if(input.issues?.length)return failure(readBusinessImportIssues(input.issues))
 if(!input.table)return failure([{code:'empty-table',message:'表格没有数据行，请补充表头和至少一条数据后重试。'}])
 const table=readBusinessImportTable(input.table),data=table.rows.slice(1),sampleRows:BusinessImportTable['rows']=[]
 for(const row of data.slice(0,5)){
  if(canonicalBytes([...sampleRows,row])>65_536)break
  sampleRows.push(row)
 }
 const result={...base,columns:table.rows[0]!.cells.map((header,column)=>({column,header})),sampleRows,dataRows:data.length,sampleRowsOmitted:data.length-sampleRows.length,issues:[],complete:true,canMap:true}
 if(canonicalBytes(result)>524_288)return failure([{code:'inspection-too-large',message:'表头和样例内容过大，请减少列数或表头长度后重试。'}])
 return readBusinessImportInspection(result)
}
function decimal(raw:string):string{
 if(!/^-?(?:0|[1-9]\d{0,17})(?:\.\d{1,4})?$/.test(raw))throw new WorkError('teloa/invalid-input','金额须为最多18位整数和4位小数的十进制文本，请修改金额列。')
 let value=raw.includes('.')?raw.replace(/0+$/,'').replace(/\.$/,''):raw
 if(value==='-0')value='0'
 return value
}
function cell(cells:string[],column:{column:number;trim:boolean}):string{
 const raw=cells[column.column]
 if(raw===undefined)throw new WorkError('teloa/invalid-input','映射列不存在，请重新选择列。')
 return column.trim?raw.trim():raw
}
function fieldValue(field:Definition['fields'][number],mapping:BusinessImportMapping['fields'][number],cells:string[]):string{
 const value=cell(cells,mapping.value)
 if(field.type==='money'){
  if(!mapping.currency)throw new WorkError('teloa/invalid-input','金额字段缺少币种，请指定固定币种或币种列。')
  if(value==='')return ''
  const currency='fixed' in mapping.currency?mapping.currency.fixed:cell(cells,mapping.currency)
  return encodeBusinessRichFieldValue(field,{currency,decimal:decimal(value)})
 }
 if(mapping.currency!==undefined)throw new WorkError('teloa/invalid-input','此字段不是金额，请移除币种映射。')
 if((field.type==='multi-enum'||field.type==='multi-reference')&&value!==''){
  let items:unknown
  try{items=JSON.parse(value)}catch{throw new WorkError('teloa/invalid-input','多选值须为JSON字符串数组，请修改对应单元格。')}
  if(!Array.isArray(items)||items.some(item=>typeof item!=='string'))throw new WorkError('teloa/invalid-input','多选值须为JSON字符串数组，请修改对应单元格。')
  return encodeBusinessRichFieldValue(field,items)
 }
 return value
}
/** 只计算规范 create 操作，不分配记录ID、不写记录或保存另一份字段真源。 */
export async function buildBusinessImportPreview(input:PreviewInput):Promise<BusinessImportPreview>{
 checkBusinessImportSignal(input.signal)
 const mapping=readBusinessImportMapping(input.mapping),schemaFingerprint=businessRecordSchemaFingerprint(input.definition),writeSchemaFingerprint=businessRecordImportWriteSchemaFingerprint(input.definition)
 const sourcePolicyDigest=businessImportHash(['teloa.business-import-source-policy/v1','csv-v1',mapping.delimiter,mapping.headerRow,mapping.primaryKey])
 const contentKey=businessImportHash(['teloa.business-import-content/v1',input.sourceIdentity,sourcePolicyDigest,mapping,writeSchemaFingerprint])
 const issues=readBusinessImportIssues(input.issues??[]),rows:BusinessImportPreview['rows']=[],relations:BusinessObjectReference[]=[],keys=new Set<string>()
 let issueCount=issues.length
 const add=(issue:BusinessImportIssue)=>{issueCount++;if(issues.length<100)issues.push(issue)}
 if(input.sourceContentKey!==undefined&&input.sourceContentKey!==contentKey)add({code:'source-policy-conflict',message:'此文件已按其他主键或映射导入，请使用原政策；更改政策不会新增另一批记录。'})
 let table:BusinessImportTable|undefined
 if(input.table){
  table=readBusinessImportTable(input.table)
  try{readBusinessImportMapping(mapping,table.columns)}catch{add({code:'mapping-column-missing',message:'映射引用了表格中不存在的列，请重新选择列。'});table=undefined}
 }
 if(!input.table&&!issues.length)add({code:'empty-table',message:'表格没有数据行，请补充表头和至少一条数据后重试。'})
 for(const item of mapping.fields){
  if(!input.definition.fields.some(field=>field.name===item.field))add({field:item.field,column:item.value.column,code:'mapping-field-missing',message:'映射字段已不存在，请按当前业务字段重新选择。'})
 }
 if(table)for(const row of table.rows.slice(1)){
  checkBusinessImportSignal(input.signal)
  const before=issueCount,primaryKey=mapping.primaryKey.map(column=>cell(row.cells,column)),key=industryUpdateCanonical(primaryKey)
  for(let index=0;index<primaryKey.length;index++)if(primaryKey[index]==='')add({rowNumber:row.rowNumber,column:mapping.primaryKey[index]!.column,code:'primary-key-empty',message:'此行主键为空，请补充主键值或调整该主键列去掉首尾空白的设置。'})
  if(keys.has(key))add({rowNumber:row.rowNumber,code:'primary-key-duplicate',message:'此行主键与前面的数据重复，请修改主键值或选择正确的组合主键。'})
  keys.add(key)
  const fields:Array<{name:string;value:string}>=[]
  for(const field of input.definition.fields){
   const mapped=mapping.fields.find(item=>item.field===field.name)
   try{
    const value=mapped?fieldValue(field,mapped,row.cells):undefined
    assertBusinessRecordFieldValue(field,value)
    if(value!==undefined)fields.push({name:field.name,value})
    const parsed=field.type==='multi-reference'?readBusinessRichFieldValue(field,value):undefined
    const ids:string[]=field.type==='reference'?(value?[value]:[]):parsed?.type==='multi-reference'?parsed.ids:[]
    for(const id of ids){
     checkBusinessImportSignal(input.signal)
     if(typeof id!=='string'||!uuid.test(id)||!input.resolveReference)throw new WorkError('teloa/invalid-input','关联须指向同业务现存的本地记录，请选择记录ID。')
     if(!('referenceType' in field))throw new WorkError('teloa/invalid-input','关联字段声明不完整，请重新采用业务配置。')
     const target=await input.resolveReference(field.referenceType!,id)
     checkBusinessImportSignal(input.signal)
     if(target.scope!==input.scope||target.type!==field.referenceType||target.id!==id||target.source!=='本地记录'||target.deletedAt)throw new WorkError('teloa/invalid-input','关联记录不可用，请选择同业务未归档的本地记录。')
     relations.push({scope:target.scope,type:target.type,id:target.id,version:target.version,snapshotHash:target.snapshotHash})
    }
   }catch(error){
    if(!(error instanceof WorkError)||!['teloa/invalid-input','teloa/not-found'].includes(error.code))throw error
    add({rowNumber:row.rowNumber,...(mapped?{column:mapped.value.column}:{}),field:field.name,code:'field-value-invalid',message:'字段「'+field.label+'」缺值、格式错误或关联不可用，请核对字段声明并修改该行。'})
   }
  }
  try{
   const {scope:_,requestId:__,...operation}=readBusinessRecordCreate({scope:input.scope,requestId:'00000000-0000-4000-8000-000000000000',type:input.type,title:cell(row.cells,mapping.title),summary:mapping.summary?cell(row.cells,mapping.summary):'',fields})
   if(issueCount===before)rows.push({rowNumber:row.rowNumber,primaryKey,operation:{operation:'create',...operation}})
  }catch{add({rowNumber:row.rowNumber,column:mapping.title.column,code:'record-value-invalid',message:'此行标题、摘要或字段超过限制或格式不正确，请缩短内容并核对去掉首尾空白的设置。'})}
 }
 checkBusinessImportSignal(input.signal)
 const digest=businessImportHash(['teloa.business-import-preview/v1',input.fileHash,'csv-v1',mapping,schemaFingerprint,writeSchemaFingerprint,input.sourceIdentity,sourcePolicyDigest,contentKey,rows,relations,issues])
 return readBusinessImportPreview({revision:input.revision,digest,schemaFingerprint,writeSchemaFingerprint,configurationVersion:input.configurationVersion,sourceIdentity:input.sourceIdentity,sourcePolicyDigest,contentKey,mapping,rows,issues,canApply:!!table&&rows.length===table.rows.length-1&&!issues.length})
}
