import {useEffect,useId,useRef,useState,useSyncExternalStore,type ReactNode} from 'react'
import {readBusinessImportMapping,readBusinessRichFieldValue,type BusinessImportMapping,type BusinessImportMappingV2,type BusinessImportIssue,type BusinessImportSourceColumn,type BusinessImportCellV2} from '@teloa/contract'
import {BusinessImportFlow,type BusinessImportDefinition,type BusinessImportState} from './business-import-flow.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessImportPanel.module.css'
type ColumnChoice={column:string;trim:boolean}
type Choices={primaryKey:ColumnChoice[];title:ColumnChoice;summary:ColumnChoice;fields:Record<string,ColumnChoice&{currency:string;currencyColumn:ColumnChoice}>}
const blank=():ColumnChoice=>({column:'',trim:false})
function choices(mapping?:BusinessImportMapping|BusinessImportMappingV2):Choices{
 const column=(value?:BusinessImportSourceColumn)=>value?{column:String(value.column),trim:value.trim}:blank()
 return {primaryKey:mapping?mapping.primaryKey.map(column):[blank()],title:column(mapping?.title),summary:column(mapping?.summary),fields:Object.fromEntries((mapping?.fields??[]).map(field=>[field.field,{...column(field.value),currency:field.currency?'fixed'in field.currency?field.currency.fixed:'column':'',currencyColumn:field.currency&&'column'in field.currency?column(field.currency):blank()}]))}
}
function toMapping(value:Choices,delimiter:BusinessImportMapping['delimiter'],definition:BusinessImportDefinition,columns:number):BusinessImportMapping|undefined{
 const source=(input:ColumnChoice)=>({column:input.column===''?-1:Number(input.column),trim:input.trim})
 try{return readBusinessImportMapping({delimiter,headerRow:1,primaryKey:value.primaryKey.map(source),title:source(value.title),...(value.summary.column===''?{}:{summary:source(value.summary)}),fields:definition.fields.flatMap(field=>{
  const input=value.fields[field.name];if(!input||input.column==='')return []
  return [{field:field.name,value:source(input),...(field.type==='money'?{currency:input.currency==='column'?source(input.currencyColumn):{fixed:input.currency}}:{})}]
 })},columns)}catch{return undefined}
}
const busy=(state:BusinessImportState)=>state.phase.endsWith('ing')||state.phase==='checking-workbook'
const rawCell=(value:string|BusinessImportCellV2)=>typeof value==='string'?value:value.text
function normalized(field:BusinessImportDefinition['fields'][number],raw:string,state:BusinessImportState,pendingLabel:string,archivedLabel:string):string{
 const relation=(id:string)=>{const value=state.relations[JSON.stringify([field.type==='reference'||field.type==='multi-reference'?field.referenceType:'',id])];return value?value.title+(value.archived?archivedLabel:''):pendingLabel}
 if(!raw)return '—'
 if(field.type==='reference')return relation(raw)
 if('format'in field){
  try{const value=readBusinessRichFieldValue(field,raw)
   if(value?.type==='money')return value.currency+' '+value.decimal
   if(value?.type==='multi-enum')return value.values.join('、')
   if(value?.type==='multi-reference'&&field.type==='multi-reference')return value.ids.map(relation).join('、')
  }catch{return pendingLabel}
 }
 return raw
}
export function BusinessImportPanel({flow,scope,type,definition}:{flow:BusinessImportFlow;scope:string;type:string;definition:BusinessImportDefinition}){
 const {t}=useI18n()
 const state=useSyncExternalStore(flow.subscribe,flow.getSnapshot,flow.getSnapshot),id=useId(),panel=useRef<HTMLElement>(null),fileGeneration=useRef(0)
 const [delimiter,setDelimiter]=useState<''|BusinessImportMapping['delimiter']>(state.mapping&&'delimiter'in state.mapping?state.mapping.delimiter:''),[form,setForm]=useState<Choices>(()=>choices(state.mapping)),[confirmed,setConfirmed]=useState(false),[file,setFile]=useState<File>(),[localError,setLocalError]=useState<string>()
 const target=scope===flow.scope&&type===flow.type&&definition.domain===scope&&definition.id===type&&flow.isCurrent(),inFlight=busy(state),unknown=state.phase==='unknown',blocked=!target||inFlight||unknown||state.phase==='recovery-error'||state.phase==='cancelled'||state.phase==='applied'
 const inspection=state.inspection,preview=state.preview,xlsx=state.draft?.format==='teloa.business-record-import/v2'||state.phase==='selecting-sheet',effectiveDelimiter=xlsx?',':delimiter
 const confirmDelimiterMismatch=preview&&!('format'in preview)&&delimiter!==preview.mapping.delimiter
 const mapped=inspection?.canMap&&effectiveDelimiter?toMapping(form,effectiveDelimiter,definition,inspection.columns.length):undefined
 const mapping=mapped&&xlsx?(({delimiter:_,...value})=>value)(mapped):mapped
 useEffect(()=>{if(target)flow.configure(definition)},[flow,definition,target])
 useEffect(()=>{setForm(choices(state.mapping));if(state.mapping&&'delimiter'in state.mapping)setDelimiter(state.mapping.delimiter)},[flow,state.draft?.id,state.draft?.mapping])
 useEffect(()=>{setConfirmed(false)},[flow,preview?.digest,state.phase])
 const act=async(run:()=>Promise<unknown>|void)=>{setLocalError(undefined);try{await run()}catch{if(flow.isCurrent())setLocalError(t('businessImport.theOperationIsIncompleteCheckThe'))}}
 const change=(next:Choices)=>{setForm(next);setConfirmed(false);if(inspection?.canMap&&effectiveDelimiter){const value=toMapping(next,effectiveDelimiter,definition,inspection.columns.length);void act(()=>flow.changeMapping(value&&xlsx?(({delimiter:_,...rest})=>rest)(value):value))}}
 const readFile=async(selected:File,generation:number)=>{
  if(!/\.(csv|xlsx)$/i.test(selected.name)||selected.size>2_097_152)throw Error()
  const bytes=new Uint8Array(await selected.arrayBuffer());if(!flow.isCurrent()||fileGeneration.current!==generation)return
  let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte)
  const input={name:selected.name,bytes:bytes.length,dataBase64:btoa(binary)}
  if(unknown)await flow.retryStage(input);else if(selected.name.toLowerCase().endsWith('.xlsx'))await flow.inspectWorkbook(input);else await flow.stage(input)
 }
 const selectSheet=async(sheet:NonNullable<BusinessImportState['workbook']>['sheets'][number])=>{
  if(!file)throw Error('original file missing')
  const selected=file,generation=fileGeneration.current,bytes=new Uint8Array(await selected.arrayBuffer());if(!flow.isCurrent()||fileGeneration.current!==generation)return
  let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte)
  if(fileGeneration.current!==generation)return
  await flow.stage({name:selected.name,bytes:bytes.length,dataBase64:btoa(binary)},{kind:'xlsx',sheet})
 }
 const cell=(value:string):ReactNode=>value.length>100?<details><summary>{t('businessImport.viewFullText')}</summary><span className={css.raw}>{value}</span></details>:<span className={css.raw}>{value||'—'}</span>
 const columnInput=(label:string,value:ColumnChoice,onChange:(value:ColumnChoice)=>void)=><div className={css.column}><label><span>{label}</span><select aria-label={label} value={value.column} disabled={blocked||!inspection?.canMap} onChange={event=>onChange({...value,column:event.target.value})}><option value="">{t('businessImport.chooseAColumn')}</option>{inspection?.columns.map(source=><option key={source.column} value={source.column}>{t('businessImport.column',{value0:source.column+1,value1:source.header||t('businessImport.emptyHeader')})}</option>)}</select></label><label className={css.check}><input type="checkbox" aria-label={label+t('businessImport.trimSurroundingWhitespace')} checked={value.trim} disabled={blocked||!inspection?.canMap} onChange={event=>onChange({...value,trim:event.target.checked})}/>{t('businessImport.trimSurroundingWhitespace2')}</label></div>
 const issues=[...(inspection?.issues??[]),...(preview?.issues??[])]
 const focusIssue=(issue:BusinessImportIssue,index:number)=>{
  const row=panel.current?.querySelector<HTMLElement>(`[data-preview-row="${issue.rowNumber}"]`)??panel.current?.querySelector<HTMLElement>(`[data-source-row="${issue.rowNumber}"]`)??panel.current?.querySelector<HTMLElement>(`[data-issue="${index}"]`)
  row?.focus();row?.scrollIntoView({block:'nearest'})
 }
 return <section ref={panel} className={css.panel} aria-labelledby={id} aria-busy={inFlight}>
  <header className={css.header}><h2 id={id}>{t('businessImport.importATable')}</h2><p>{definition.title} · {t('businessImport.csvOrXlsx150Rows')}</p></header>
  <ol className={css.steps} aria-label={t('businessImport.importSteps')}><li>{t('businessImport.1Upload')}</li><li>{t('businessImport.2Map')}</li><li>{t('businessImport.3Confirm')}</li></ol>
  {!target&&<p role="alert" className={css.error}>{t('businessImport.yourIdentityOrBusinessConnectionChanged')}</p>}
  {unknown&&<div role="status" className={css.notice}><p>{t('businessImport.theOriginalRequestOutcomeIsUnknown')}</p><div className={css.actions}><button type="button" disabled={!target||inFlight} onClick={()=>void act(()=>flow.reconcile())}>{t('businessImport.checkOriginalRequest')}</button>{state.pending?.phase==='apply'&&<button type="button" disabled={!target||inFlight} onClick={()=>void act(()=>flow.retryApply())}>{t('businessImport.resendOriginalRequest')}</button>}{state.pending?.phase==='stage'&&<button type="button" disabled={!target||inFlight||!file} onClick={()=>void act(()=>readFile(file!,fileGeneration.current))}>{t('businessImport.resendWithOriginalFile')}</button>}</div></div>}
  {state.phase==='recovery-error'&&<p role="alert" className={css.error}>{t('businessImport.theRecoveryRecordCannotBeVerified')}</p>}
  {(localError||state.errorCode)&&<p role="alert" className={css.error}>{localError??(state.errorCode==='teloa/too-late'?t('businessImport.thisBatchIsAlreadyImportedCancelling'):preview&&!state.relationsReady?t('businessImport.relatedRecordsAreUnverifiedGenerateA'):t('businessImport.theOperationIsIncompleteCheckThe2'))}</p>}
  {preview&&!state.relationsReady&&!state.errorCode&&!inFlight&&<p role="alert" className={css.error}>{t('businessImport.relatedRecordsAreUnverifiedOrArchived')}</p>}
  {issues.length>0&&<div className={css.error} role="alert"><p>{t('businessImport.resolveAllIssuesAndPreviewAgain')}</p><ul>{issues.map((issue,index)=><li key={index}><button type="button" data-issue={index} onClick={()=>focusIssue(issue,index)}>{[issue.rowNumber?t('businessImport.row',{value0:issue.rowNumber}):'',issue.column!==undefined?t('businessImport.column2',{value0:issue.column+1}):''].filter(Boolean).join(' · ')}{issue.rowNumber||issue.column!==undefined?'：':''}{issue.message}</button></li>)}</ul></div>}
  <section className={css.step} aria-labelledby={id+'-upload'}><h3 id={id+'-upload'}>{t('businessImport.1UploadATable')}</h3><label className={css.upload}>{t('businessImport.csvOrXlsxFile')}<input aria-label={t('businessImport.csvOrXlsxFile')} type="file" accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={!target||inFlight||state.phase==='recovery-error'||unknown&&state.pending?.phase!=='stage'} onChange={event=>{const selected=event.target.files?.[0],generation=++fileGeneration.current;setFile(selected);if(selected&&!unknown)void act(()=>readFile(selected,generation))}}/></label>
   {state.draft&&<p className={css.note}>{t('businessImport.fileSaved')}：{state.draft.file.name}</p>}
   {state.phase==='selecting-sheet'&&state.workbook&&<div className={css.sheetPicker} role="group" aria-label={t('businessImport.chooseAWorksheet')}><p className={css.note}>{t('businessImport.chooseTheWorksheetToImport')}</p><div className={css.sheetChoices}>{state.workbook.sheets.map(sheet=><button type="button" key={sheet.sheetId} disabled={!file||!target||inFlight} onClick={()=>void act(()=>selectSheet(sheet))}>{sheet.name}</button>)}</div></div>}
   <div className={css.actions}>{!xlsx&&<label>{t('businessImport.delimiter')}<select aria-label={t('businessImport.delimiter')} value={delimiter} disabled={blocked} onChange={event=>{setDelimiter(event.target.value as typeof delimiter);setConfirmed(false)}}><option value="">{t('businessImport.choose')}</option><option value=",">{t('businessImport.comma')}</option><option value=";">{t('businessImport.semicolon')}</option><option value={'\t'}>{t('businessImport.tab')}</option></select></label>}<button type="button" disabled={blocked||!state.draft||!effectiveDelimiter} onClick={()=>void act(()=>flow.inspect(xlsx?undefined:delimiter as BusinessImportMapping['delimiter']))}>{t('businessImport.readHeadersAndSample')}</button></div>
   {inspection?.complete&&<><p className={css.note}>{t('businessImport.readAllDataRowsOnlyThe',{value0:inspection.dataRows??'—',value1:inspection.sampleRows.length,value2:inspection.sampleRowsOmitted??'—'})}</p><div className={css.tableWrap} tabIndex={0} aria-label={t('businessImport.originalSampleTable')}><table><thead><tr><th>{t('businessImport.row2')}</th>{inspection.columns.map(column=><th key={column.column}>{t('businessImport.column2',{value0:column.column+1})}<span>{column.header||t('businessImport.emptyHeader')}</span></th>)}</tr></thead><tbody>{inspection.sampleRows.map(row=><tr key={row.rowNumber} data-source-row={row.rowNumber} tabIndex={-1}><th>{row.rowNumber}</th>{row.cells.map((value,index)=><td key={index}>{cell(rawCell(value))}{typeof value!=='string'&&<small>{({blank:t('businessImport.blank'),string:t('businessImport.text'),number:t('businessImport.number'),boolean:t('businessImport.boolean')})[value.kind]}</small>}</td>)}</tr>)}</tbody></table></div></>}
  </section>
  <section className={css.step} aria-labelledby={id+'-map'}><h3 id={id+'-map'}>{t('businessImport.2ChoosePrimaryKeyAndField')}</h3><p className={css.note}>{t('businessImport.columnNumbersDistinguishDuplicateOrEmpty')}</p>
   <div className={css.mapping}>{form.primaryKey.map((value,index)=><div key={index}>{columnInput(t('businessImport.primaryKeyColumn',{value0:index+1}),value,next=>change({...form,primaryKey:form.primaryKey.map((item,i)=>i===index?next:item)}))}{index>0&&<button type="button" disabled={blocked} onClick={()=>change({...form,primaryKey:form.primaryKey.filter((_,i)=>i!==index)})}>{t('businessImport.removeKeyColumn')}</button>}</div>)}{form.primaryKey.length<3&&<button type="button" disabled={blocked||!inspection?.canMap} onClick={()=>change({...form,primaryKey:[...form.primaryKey,blank()]})}>{t('businessImport.addKeyColumn')}</button>}{columnInput(t('businessImport.titleColumn'),form.title,next=>change({...form,title:next}))}{columnInput(t('businessImport.summaryColumnOptional'),form.summary,next=>change({...form,summary:next}))}
   {definition.fields.map(field=>{const value=form.fields[field.name]??{...blank(),currency:'',currencyColumn:blank()},set=(next:typeof value)=>change({...form,fields:{...form.fields,[field.name]:next}});return <div key={field.name}>{columnInput(field.label+t('businessImport.sourceColumn'),value,next=>set({...value,...next}))}{field.type==='money'&&<><label>{field.label+t('businessImport.currency')}<select aria-label={field.label+t('businessImport.currency')} disabled={blocked||value.column===''} value={value.currency} onChange={event=>set({...value,currency:event.target.value})}><option value="">{t('businessImport.chooseCurrencyExplicitly')}</option>{field.currencies.map(currency=><option key={currency} value={currency}>{currency}</option>)}<option value="column">{t('businessImport.separateCurrencyColumn')}</option></select></label>{value.currency==='column'&&columnInput(field.label+t('businessImport.currencySourceColumn'),value.currencyColumn,next=>set({...value,currencyColumn:next}))}</>}</div>})}</div>
   <button type="button" disabled={blocked||!inspection?.canMap||!mapping||inspection.format==='teloa.business-import-inspection/v1'&&delimiter!==inspection.delimiter} onClick={()=>void act(()=>flow.preview(mapping!))}>{t('businessImport.previewAllRows')}</button>
  </section>
  <section className={css.step} aria-labelledby={id+'-confirm'}><h3 id={id+'-confirm'}>{t('businessImport.3ReviewAllRowsAndConfirm')}</h3>
   {preview&&<><p className={css.note}>{t('businessImport.allNormalizedRows',{value0:preview.rows.length})}</p><p className={css.note}>{t('businessImport.originalValueComparisonsUseTheComplete')}</p><div className={css.tableWrap} tabIndex={0} aria-label={t('businessImport.allNormalizedResults')}><table><thead><tr><th>{t('businessImport.row2')}</th><th>{t('businessImport.primaryKey')}</th><th>{t('businessImport.title')}</th><th>{t('businessImport.summary')}</th>{definition.fields.map(field=><th key={field.name}>{field.label}</th>)}</tr></thead><tbody>{preview.rows.map(row=>{const sample=inspection?.sampleRows.find(sample=>sample.rowNumber===row.rowNumber);return <tr key={row.rowNumber} data-preview-row={row.rowNumber} tabIndex={-1}><th>{row.rowNumber}</th><td>{sample&&<small>{cell(JSON.stringify(preview.mapping.primaryKey.map(key=>rawCell(sample.cells[key.column]!))))} {t('businessImport.normalized')}</small>}{cell(JSON.stringify(row.primaryKey))}</td><td>{cell(row.operation.title)}</td><td>{cell(row.operation.summary)}</td>{definition.fields.map(field=>{const raw=row.operation.fields.find(value=>value.name===field.name)?.value??'',mapped=preview.mapping.fields.find(value=>value.field===field.name);return <td key={field.name}>{sample&&mapped&&field.type!=='reference'&&field.type!=='multi-reference'&&<small>{cell(sample.cells[mapped.value.column]===undefined?'':rawCell(sample.cells[mapped.value.column]!))} {t('businessImport.normalized')}</small>}{cell(normalized(field,raw,state,t('businessImport.relationUnverified'),t('businessImport.archived')))}</td>})}</tr>})}</tbody></table></div></>}
   {state.receipt?<div className={css.notice} role="status"><p>{t('businessImport.importedBatchRecords',{value0:state.receipt.created})}</p>{state.receipt.canonicalRequestId!==state.receipt.requestId&&<p>{t('businessImport.thisFileMatchesAnExistingFixed')}</p>}</div>:<><label className={css.check}><input type="checkbox" checked={confirmed} disabled={blocked||!preview?.canApply||!state.relationsReady||!mapping} onChange={event=>setConfirmed(event.target.checked)}/>{t('businessImport.iReviewedEveryRowAndConfirm')}</label><button type="button" className={css.primary} disabled={blocked||!confirmed||!preview?.canApply||!state.relationsReady||!mapping||confirmDelimiterMismatch} onClick={()=>void act(()=>flow.apply())}>{state.phase==='applying'?t('businessImport.importing'):t('businessImport.confirmImport')}</button></>}
  </section>
  {state.phase==='cancelled'?<div className={css.notice}><p>{t('businessImport.draftCancelledItsFileAndMapping')}</p><button type="button" disabled={!target||inFlight} onClick={()=>void act(()=>flow.resume())}>{t('businessImport.resumeDraft')}</button></div>:state.draft&&state.phase!=='applied'&&<button type="button" disabled={blocked} onClick={()=>void act(()=>flow.cancel())}>{t('businessImport.cancelThisDraft')}</button>}
 </section>
}
