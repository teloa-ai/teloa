import {useEffect,useId,useMemo,useRef,useState,useSyncExternalStore,type FormEvent} from 'react'
import {Archive,ArrowLeft,FileText,Plus,RefreshCw} from 'lucide-react'
import {businessObjectReference,type BusinessObjectReference,parseBooleanValue,parseDurationSeconds,readBusinessRichFieldValue,encodeBusinessRichFieldValue,type BusinessRichFieldDefinition,type BusinessRichMoneyFieldDefinition,type BusinessRichMultiEnumFieldDefinition,type BusinessObjectSnapshot,type BusinessObjectFieldDefinition,type BusinessConfigurationPageProjectionVersioned as BusinessConfigurationPageProjection,type BusinessConfigurationPageContent,type BusinessConfigurationPageContentV2} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import {durationText,localizedBusinessFieldLabel,localizedBusinessFieldValue,localizedBusinessObjectType} from './business-definition-localization.js'
import {BusinessRecordFlow,businessDurationInput,businessDurationValue,businessMoneyInput,businessMoneyValue,businessRichRecordDisplay,type BusinessDurationUnit,type BusinessRecordCapabilities,type BusinessRecordSession} from './business-record-flow.js'
import {BusinessTaskList,type BusinessTaskListProps} from './BusinessTaskList.js'
import {BusinessRecordReferenceField,BusinessRecordReferenceValue} from './BusinessRecordReferenceField.js'
import type {BusinessRecordApi} from './business-record-api.js'
import type {BusinessImportTargetFactory} from './business-import-integration.js'
import {BusinessImportPanel} from './BusinessImportPanel.js'
import type {BusinessTarget} from './business-preview.js'
import css from './BusinessRecordPage.module.css'
type RecordField=BusinessObjectFieldDefinition|BusinessRichFieldDefinition
type RecordPage=Extract<BusinessConfigurationPageContent|BusinessConfigurationPageContentV2,{kind:'records'}>
export type BusinessRecordTaskList=Pick<BusinessTaskListProps,'api'|'roleName'|'openTask'|'openArtifact'|'openSource'>
export type BusinessRecordPageProps={importFlow?:BusinessImportTargetFactory|undefined;go?:((target:BusinessTarget)=>void)|undefined;recordReference?:BusinessObjectReference|undefined;taskList?:BusinessRecordTaskList|undefined;projection:BusinessConfigurationPageProjection;flow?:BusinessRecordFlow;capabilities?:BusinessRecordCapabilities;onDispatch?:((reference:BusinessObjectReference)=>void)|undefined}
// flow 随本人或宿主变化；实例切换时连同详情、分页和在途回包一并隔离。
const flowKeys=new WeakMap<BusinessRecordFlow,number>()
let nextFlowKey=0
function flowKey(flow:BusinessRecordFlow){let key=flowKeys.get(flow);if(key===undefined){key=++nextFlowKey;flowKeys.set(flow,key)}return key}
const noCapabilities={create:false,edit:false,archive:false}
/** 候选与正式页面共用展示；候选路径不挂载任何持有 records API 的组件。 */
export function BusinessRecordPage({projection,flow,importFlow,capabilities=noCapabilities,onDispatch,taskList,recordReference,go}:BusinessRecordPageProps){
 const {t}=useI18n()
 if(projection.page.kind!=='records')return null
 if(projection.mode==='preview')return <section className={css.page}><RecordHeader page={projection.page}/><p className={css.badge}>{t('business.records.preview')}</p><EmptyRecordPage preview/></section>
 if(!flow)return <section className={css.page}><RecordHeader page={projection.page}/><p role="alert">{t('business.records.unavailable')}</p></section>
 return <SavedRecords key={JSON.stringify([flowKey(flow),projection.scope,projection.page.objectType.id,recordReference])} page={projection.page} scope={projection.scope} flow={flow} importFlow={importFlow} capabilities={capabilities} onDispatch={onDispatch} taskList={taskList} recordReference={recordReference} go={go}/>
}
function RecordHeader({page,children}:{page:RecordPage;children?:React.ReactNode}){
 const {locale}=useI18n()
 return <header className={css.header}><div><h2>{page.definition.title}</h2><p>{localizedBusinessObjectType(page.objectType,locale).lead}</p></div>{children}</header>
}
function EmptyRecordPage({preview=false,onCreate}:{preview?:boolean;onCreate?:()=>void}){
 const {t}=useI18n()
 return <div className={css.empty}><FileText size={28} aria-hidden="true"/><h3>{t(preview?'business.records.previewTitle':'business.records.empty')}</h3>{(preview||onCreate)&&<p>{t(preview?'business.records.previewNote':'business.records.emptyNote')}</p>}{onCreate&&<button type="button" className={css.primary} onClick={onCreate}><Plus size={16} aria-hidden="true"/>{t('business.records.first')}</button>}</div>
}
function SavedRecords({page,scope,flow,importFlow,capabilities,onDispatch,taskList,recordReference,go}:{importFlow:BusinessRecordPageProps['importFlow'];go:BusinessRecordPageProps['go'];recordReference:BusinessRecordPageProps['recordReference'];taskList:BusinessRecordPageProps['taskList'];page:RecordPage;scope:string;flow:BusinessRecordFlow;capabilities:BusinessRecordCapabilities;onDispatch:BusinessRecordPageProps['onDispatch']}){
 const {t,locale,dateTime}=useI18n(),definition=page.objectType,session=flow.forTarget(scope,definition.id),state=useSyncExternalStore(session.subscribe,session.getSnapshot,session.getSnapshot)
 const [items,setItems]=useState<BusinessObjectSnapshot[]>([]),[cursor,setCursor]=useState<string>(),[loading,setLoading]=useState(true),[readError,setReadError]=useState(false),[selected,setSelected]=useState<BusinessObjectSnapshot>(),[current,setCurrent]=useState<BusinessObjectSnapshot>(),[detailLoading,setDetailLoading]=useState(false),[detailError,setDetailError]=useState(false),[historyVersion,setHistoryVersion]=useState('1')
 const [fixedSelection,setFixedSelection]=useState(!!recordReference)
 const listGeneration=useRef(0),detailGeneration=useRef(0),alive=useRef(true),listAbort=useRef<AbortController>(),detailAbort=useRef<AbortController>()
 const rights={create:capabilities.create&&page.definition.allowCreate,edit:capabilities.edit&&page.definition.allowEdit,archive:capabilities.archive&&page.definition.allowArchive}
 const [importOpen,setImportOpen]=useState(false)
 const importing=useMemo(()=>{if(!rights.create||!importFlow)return;try{return importFlow(scope,definition.id)}catch{return}},[importFlow,scope,definition.id,rights.create])
 // configure 不触发网络；保存时再次核对最新定义与实际能力，旧表单不会悄悄换字段。
 useEffect(()=>{session.configure(definition,rights)},[session,definition,rights.create,rights.edit,rights.archive])
 useEffect(()=>()=>{alive.current=false;listGeneration.current++;detailGeneration.current++;listAbort.current?.abort();detailAbort.current?.abort()},[])
 const load=async(more=false)=>{
  const generation=++listGeneration.current;listAbort.current?.abort();const abort=new AbortController();listAbort.current=abort
  setLoading(true);setReadError(false)
  try{
   const data=await flow.api.list({scope,type:definition.id,limit:20,...(more&&cursor?{cursor}:{})},abort.signal)
   if(!alive.current||generation!==listGeneration.current)return
   if(data.sourceId!==definition.sourceId)throw Error('来源不一致')
   setItems(previous=>more?[...new Map([...previous,...data.items].map(item=>[item.id,item])).values()]:data.items);setCursor(data.nextCursor)
  }catch{if(alive.current&&generation===listGeneration.current)setReadError(true)}
  finally{if(alive.current&&generation===listGeneration.current)setLoading(false)}
 }
 useEffect(()=>{alive.current=true;setItems([]);setCursor(undefined);void load()},[flow,scope,definition.id,definition.sourceId])
 useEffect(()=>{
  if(!importing)return
  let requestId=importing.getSnapshot().receipt?.requestId
  return importing.subscribe(()=>{const next=importing.getSnapshot().receipt?.requestId;if(next&&next!==requestId){requestId=next;if(alive.current&&importing.isCurrent())void load()}})
 },[importing,flow,scope,definition.id,definition.sourceId])
 useEffect(()=>{
  if(!state.result)return
  // 同类型原保存可以结算并刷新目录，但不能替换仍在查看的固定来源。
  if(recordReference&&fixedSelection){void load();return}
  detailGeneration.current++;detailAbort.current?.abort();setDetailLoading(false);setDetailError(false)
  setSelected(state.result);setCurrent(state.result);setFixedSelection(false);setHistoryVersion(String(Math.max(1,state.result.version-1)));void load()
 },[state.result])
 const read=async(item:BusinessObjectSnapshot,version?:number)=>{
  const generation=++detailGeneration.current;detailAbort.current?.abort();const abort=new AbortController();detailAbort.current=abort
  setDetailLoading(true);setDetailError(false)
  try{
   const result=await flow.api.get({scope,type:definition.id,id:item.id,...(version===undefined?{}:{version})},abort.signal)
   if(!alive.current||generation!==detailGeneration.current)return
   setSelected(result);if(version===undefined){setCurrent(result);setFixedSelection(false)}
  }catch{if(alive.current&&generation===detailGeneration.current)setDetailError(true)}
  finally{if(alive.current&&generation===detailGeneration.current)setDetailLoading(false)}
 }
 // 导航来源只读指定历史快照；哈希不符时绝不展示其他版本来替代。
 const readReference=async()=>{
  const generation=++detailGeneration.current;detailAbort.current?.abort();const abort=new AbortController();detailAbort.current=abort
  setSelected(undefined);setCurrent(undefined);setFixedSelection(true);setDetailLoading(true);setDetailError(false)
  try{
   const reference=businessObjectReference(recordReference)
   if(reference.scope!==scope||reference.type!==definition.id)throw Error('来源不一致')
   const result=await flow.api.get({scope,type:reference.type,id:reference.id,version:reference.version},abort.signal)
   if(!alive.current||generation!==detailGeneration.current)return
   if(result.scope!==reference.scope||result.type!==reference.type||result.id!==reference.id||result.version!==reference.version||result.snapshotHash!==reference.snapshotHash)throw Error('来源不一致')
   setSelected(result)
  }catch{if(alive.current&&generation===detailGeneration.current)setDetailError(true)}
  finally{if(alive.current&&generation===detailGeneration.current)setDetailLoading(false)}
 }
 useEffect(()=>{if(recordReference)void readReference()},[])
 const open=(item:BusinessObjectSnapshot)=>{setFixedSelection(false);setSelected(item);setCurrent(item);setHistoryVersion(String(Math.max(1,item.version-1)));void read(item)}
 const busy=['saving','unknown','retryable','recovery-error'].includes(state.phase),historical=fixedSelection||!!selected&&!!current&&selected.version!==current.version
 const fields=page.definition.fields.map(name=>definition.fields.find(field=>field.name===name)).filter((field):field is RecordField=>!!field)
 const start=(kind:'create'|'edit'|'archive')=>{session.configure(definition,rights);if(kind==='create')session.create();else if(selected)session[kind](selected)}
 return <section className={css.page} aria-label={page.definition.title}>
  <RecordHeader page={page}><div className={css.actions}><button type="button" disabled={loading} onClick={()=>void load()}><RefreshCw size={15} aria-hidden="true"/>{t('business.records.refresh')}</button>{rights.create&&importFlow&&<button type="button" disabled={busy||!!state.form||!importing?.isCurrent()} onClick={()=>setImportOpen(true)}>{locale==='en'?'Import a table':'导入表格'}</button>}{rights.create&&<button type="button" className={css.primary} disabled={busy||!!state.form||importOpen} onClick={()=>start('create')}><Plus size={16} aria-hidden="true"/>{t('business.records.new')}</button>}</div></RecordHeader>
  {rights.create&&importFlow&&!importing&&<p className={css.error} role="alert">{locale==='en'?'Your business connection is unverified. Table import is unavailable.':'本人业务连接尚未确认，暂不能导入表格。'}</p>}
  {importOpen&&importing&&rights.create&&<div><div className={css.actions}><button type="button" onClick={()=>setImportOpen(false)}>{locale==='en'?'Close import':'关闭导入'}</button></div><BusinessImportPanel flow={importing} scope={scope} type={definition.id} definition={definition}/></div>}
  {state.phase==='recovery-error'&&<p className={css.error} role="alert">{t(state.pending?'business.records.storageError.pending':'business.records.storageError')}</p>}
  {state.phase==='saved'&&<p className={css.success} role="status">{t(state.result?.deletedAt?'business.records.archived':'business.records.saved')}</p>}
  {state.form&&<RecordEditor session={session} definition={definition} api={flow.api} scope={scope} go={go}/>}
  {readError&&<p className={css.error} role="alert">{t('business.records.readError')} <button type="button" disabled={loading} onClick={()=>void load()}>{t('business.records.retry')}</button></p>}
  {loading&&<p className={css.notice} role="status">{t('business.records.loading')}</p>}
  {!loading&&!readError&&!items.length&&<EmptyRecordPage {...(rights.create&&!state.form&&!busy&&!importOpen?{onCreate:()=>start('create')}:{})}/>}
  {!!items.length&&<div className={css.list} aria-busy={loading}>{items.map(item=><button type="button" key={item.id} className={css.record} onClick={()=>open(item)} aria-pressed={selected?.id===item.id}><span className={css.recordHeading}><strong>{item.title}</strong><small>{dateTime(item.observedAt)}</small></span>{item.summary&&<span className={css.summary}>{item.summary}</span>}<span className={css.fieldStrip}>{fields.slice(0,4).map(field=><span key={field.name}><small>{localizedBusinessFieldLabel(field,locale)}</small><span>{(field.type==='reference'||field.type==='multi-reference')?<BusinessRecordReferenceValue key={listGeneration.current} api={flow.api} scope={scope} field={field} value={item.fields.find(value=>value.label===field.from)?.value??''} retryable={false}/>:displayValue(field,item,locale,t)}</span></span>)}</span></button>)}</div>}
  {cursor&&<div className={css.more}><button type="button" disabled={loading} onClick={()=>void load(true)}>{t('business.records.more')}</button></div>}
  {!selected&&detailLoading&&<p role="status">{t('business.records.loading')}</p>}
  {!selected&&detailError&&<p className={css.error} role="alert">{t('business.records.readError')} <button type="button" onClick={()=>void readReference()}>{t('business.records.retry')}</button></p>}
  {selected&&<section className={css.detail} aria-label={selected.title}>
   <header className={css.header}><div><span className={css.badge}>{t('business.records.version',{version:selected.version})}{selected.deletedAt&&<> · {t('business.records.archived')}</>}{selected.source!=='本地记录'&&<> · {t('business.records.syncedReadOnly')}</>}</span><h3>{selected.title}</h3><small>{dateTime(selected.observedAt)}</small></div><button type="button" onClick={()=>{detailGeneration.current++;detailAbort.current?.abort();setSelected(undefined);setCurrent(undefined);setDetailLoading(false);setDetailError(false)}}>{t('business.records.close')}</button></header>
   {detailLoading&&<p role="status">{t('business.records.loading')}</p>}
   {detailError&&<p className={css.error} role="alert">{t('business.records.readError')} <button type="button" onClick={()=>void (fixedSelection?readReference():read(selected,historical?selected.version:undefined))}>{t('business.records.retry')}</button></p>}
   {selected.summary&&<p className={css.summary}>{selected.summary}</p>}
   <RecordFacts key={listGeneration.current} definition={definition} snapshot={selected} api={flow.api} scope={scope} go={go}/>
   {historical&&<p className={css.notice}>{t('business.records.historyNote')}</p>}
   <div className={css.actions}>
    {onDispatch&&<button type="button" disabled={busy||!!state.form||detailLoading||detailError} onClick={()=>onDispatch(businessObjectReference({scope:selected.scope,type:selected.type,id:selected.id,version:selected.version,snapshotHash:selected.snapshotHash}))}>{t('business.records.dispatch')}</button>}
    {!historical&&!selected.deletedAt&&selected.source==='本地记录'&&rights.edit&&<button type="button" disabled={busy||!!state.form||detailLoading||detailError} onClick={()=>start('edit')}>{t('business.records.edit')}</button>}
    {!historical&&!selected.deletedAt&&selected.source==='本地记录'&&rights.archive&&<button type="button" disabled={busy||!!state.form||detailLoading||detailError} onClick={()=>start('archive')}><Archive size={15} aria-hidden="true"/>{t('business.records.archive')}</button>}
    {historical&&<button type="button" disabled={detailLoading} onClick={()=>void read(selected)}><ArrowLeft size={15} aria-hidden="true"/>{t('business.records.current')}</button>}
   </div>
   {taskList&&!detailLoading&&!detailError&&<BusinessTaskList {...taskList} scope={scope} object={{type:selected.type,id:selected.id}}/>}
   {current&&current.version>1&&<form className={css.history} onSubmit={event=>{event.preventDefault();const version=Number(historyVersion);if(Number.isSafeInteger(version)&&version>=1&&version<current.version)void read(current,version)}}><label>{t('business.records.historyVersion')}<input type="number" min={1} max={current.version-1} step={1} required value={historyVersion} onChange={event=>setHistoryVersion(event.target.value)}/></label><button type="submit" disabled={detailLoading}>{t('business.records.history')}</button></form>}
  </section>}
 </section>
}
type Translate=ReturnType<typeof useI18n>['t']
function displayValue(field:RecordField,snapshot:BusinessObjectSnapshot,locale:string,t:Translate){
 const value=snapshot.fields.find(item=>item.label===field.from)?.value
 if(value===undefined||value===''||field.type==='reference'||field.type==='multi-reference')return '—'
 if('format'in field)return businessRichRecordDisplay(field,value,locale.startsWith('zh')?'、':', ')
 if(field.type==='boolean'){const boolean=parseBooleanValue(value);if(boolean!==undefined)return t(boolean?'business.records.yes':'business.records.no')}
 if(field.type==='datetime'&&Number.isFinite(Date.parse(value)))return new Intl.DateTimeFormat(locale,{dateStyle:'medium',timeStyle:'short'}).format(new Date(value))
 if(field.type==='duration'){const seconds=parseDurationSeconds(value);if(seconds!==undefined)return durationText(seconds,(n,options)=>new Intl.NumberFormat(locale,options).format(n))}
 return localizedBusinessFieldValue(field,value,locale)
}
function RecordFacts({definition,snapshot,api,scope,go}:{api:BusinessRecordApi;scope:string;go:BusinessRecordPageProps['go'];definition:RecordPage['objectType'];snapshot:BusinessObjectSnapshot}){
 const {locale,t}=useI18n()
 return <dl className={css.facts}>{definition.fields.map(field=><div key={field.name}><dt>{localizedBusinessFieldLabel(field,locale)}</dt><dd>{(field.type==='reference'||field.type==='multi-reference')?<BusinessRecordReferenceValue api={api} scope={scope} field={field} value={snapshot.fields.find(value=>value.label===field.from)?.value??''} go={go}/>:displayValue(field,snapshot,locale,t)}</dd></div>)}</dl>
}
function datetimeInput(value:string){
 const date=new Date(value);if(!value||!Number.isFinite(date.getTime()))return ''
 const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);return local.toISOString().slice(0,23)
}
function RecordEditor({session,definition,api,scope,go}:{api:BusinessRecordApi;scope:string;go:BusinessRecordPageProps['go'];session:BusinessRecordSession;definition:RecordPage['objectType']}){
 const {t,locale}=useI18n(),state=useSyncExternalStore(session.subscribe,session.getSnapshot,session.getSnapshot),form=state.form!,id=useId(),formRef=useRef<HTMLFormElement>(null)
 // 表单与未知原请求始终使用打开时的定义；新声明只用于保存闸和最新版本比较。
 const editingDefinition=form.definition
 const [referenceChoices,setReferenceChoices]=useState<Record<string,boolean>>({}),choosingReference=Object.values(referenceChoices).some(Boolean)
 const busy=['saving','unknown','retryable','recovery-error'].includes(state.phase),blocked=busy||state.phase==='schema-changed'||state.phase==='conflict'
 useEffect(()=>{formRef.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus()},[form.kind,form.base?.id])
 useEffect(()=>{formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()},[state.errors])
 const submit=async(event:FormEvent)=>{event.preventDefault();if(!choosingReference)await session.save()}
 const title=form.kind==='create'?'business.records.new':form.kind==='edit'?'business.records.edit':'business.records.archive'
 return <form ref={formRef} className={css.editor} onSubmit={event=>void submit(event)} aria-label={t(title)} noValidate>
  <h3>{t(title)}</h3>
  {form.kind==='archive'?<><p><strong>{form.title}</strong></p><p>{t('business.records.archiveNote')}</p></>:<fieldset disabled={blocked}><div className={css.formGrid}>
   <label className={css.full}>{t('business.records.title')} <span aria-hidden="true">*</span><input required maxLength={240} value={form.title} onChange={event=>session.change('title',event.target.value)} aria-invalid={!!state.errors.$title} aria-describedby={state.errors.$title?id+'-title-error':undefined}/>{state.errors.$title&&<span id={id+'-title-error'} className={css.fieldError}>{t(state.errors.$title==='required'?'business.records.required':'business.records.invalid')}</span>}</label>
   <label className={css.full}>{t('business.records.summary')}<textarea rows={2} maxLength={4000} value={form.summary} onChange={event=>session.change('summary',event.target.value)} aria-invalid={!!state.errors.$summary}/></label>
   {editingDefinition.fields.map(field=>{
    const value=form.values[field.name]??'',error=state.errors[field.name],hint=field.type==='duration'?'business.records.durationHint':field.type==='datetime'?'business.records.datetimeHint':field.type==='number'&&error?'business.records.numberHint':undefined,fieldId=id+'-'+field.name
    const unique=editingDefinition.format==='teloa.business-object-type/v2'&&editingDefinition.constraints?.uniqueFields.includes(field.name)
    const common={id:fieldId,required:field.required,'aria-invalid':!!error,'aria-describedby':[hint?fieldId+'-hint':'',unique?fieldId+'-unique':'',error?fieldId+'-error':''].filter(Boolean).join(' ')||undefined}
    const change=(value:string)=>session.changeField(field.name,value)
    return <div key={field.name} className={css.field}>{field.type==='multi-enum'?<span id={fieldId+'-label'}>{localizedBusinessFieldLabel(field,locale)}{field.required&&<span aria-hidden="true"> *</span>}</span>:<label htmlFor={fieldId}>{localizedBusinessFieldLabel(field,locale)}{field.required&&<span aria-hidden="true"> *</span>}</label>}
     {field.type==='multi-enum'?<MultiEnumField field={field} value={value} change={change} inputProps={common}/>:field.type==='money'?<MoneyField field={field} value={value} change={change} inputProps={common}/>:field.type==='enum'?<select {...common} value={value} onChange={event=>change(event.target.value)}><option value="">{t('business.records.choose')}</option>{field.values?.map(item=><option key={item} value={item}>{localizedBusinessFieldValue(field,item,locale)}</option>)}</select>:field.type==='boolean'?<select {...common} value={parseBooleanValue(value)===undefined?'':String(parseBooleanValue(value))} onChange={event=>change(event.target.value)}><option value="">{t('business.records.choose')}</option><option value="true">{t('business.records.yes')}</option><option value="false">{t('business.records.no')}</option></select>:field.type==='duration'?<DurationField value={value} change={change} label={localizedBusinessFieldLabel(field,locale)} inputProps={common}/>:(field.type==='reference'||field.type==='multi-reference')?<BusinessRecordReferenceField api={api} scope={scope} field={field} value={value} change={change} disabled={blocked} inputProps={common} onChoosing={choosing=>setReferenceChoices(previous=>previous[field.name]===choosing?previous:{...previous,[field.name]:choosing})}/>:field.type==='datetime'?<input {...common} type="datetime-local" step="0.001" value={datetimeInput(value)} onChange={event=>{const local=event.target.value;change(local&&Number.isFinite(Date.parse(local))?new Date(local).toISOString():'')}}/>:<input {...common} type="text" inputMode={field.type==='number'?'decimal':undefined} maxLength={2000} value={value} onChange={event=>change(event.target.value)}/>}
     {unique&&<small id={fieldId+'-unique'}>{t(field.type==='multi-reference'?'business.records.uniqueReference':'business.records.unique')}</small>}
     {hint&&<small id={fieldId+'-hint'}>{t(hint)}</small>}{error&&<span id={fieldId+'-error'} className={css.fieldError}>{t(error==='required'?'business.records.required':error==='unique'?'business.records.uniqueError':'business.records.invalid')}</span>}
    </div>
   })}
  </div></fieldset>}
  {state.phase==='unknown'&&<p className={css.error} role="alert">{t('business.records.unknown')}</p>}
  {state.phase==='retryable'&&<p className={css.notice} role="status">{t('business.records.retryable')}</p>}
  {state.phase==='conflict'&&<p className={css.error} role="alert">{t('business.records.conflict')}</p>}
  {(state.phase==='schema-changed'||state.errorCode==='teloa/schema-changed')&&<p className={css.error} role="alert">{t(state.errorCode==='teloa/schema-changed'&&state.pending?'business.records.pendingSchema':'business.records.schemaChanged')}</p>}
  {state.phase==='error'&&<p className={css.error} role="alert">{t('business.records.failed')}</p>}
  {state.errorCode&&state.phase==='retryable'&&state.errorCode!=='teloa/schema-changed'&&<p className={css.error} role="alert">{t('business.records.failed')}</p>}
  {state.comparison&&<section className={css.comparison}><h4>{t('business.records.latest',{version:state.comparison.version})}</h4><strong>{state.comparison.title}</strong><p>{state.comparison.summary}</p><RecordFacts definition={definition} snapshot={state.comparison} api={api} scope={scope} go={go}/>{state.comparison.deletedAt?<p>{t('business.records.archived')}</p>:<button type="button" onClick={()=>session.useComparedVersion()}>{t('business.records.continue')}</button>}</section>}
  <footer className={css.actions}>
   {!busy&&<button type="button" onClick={()=>session.cancel()}>{t('business.records.cancel')}</button>}
   {(state.phase==='unknown'||state.phase==='recovery-error'&&!!state.pending)&&<button type="button" onClick={()=>void session.recover()}>{t('business.records.recover')}</button>}
   {state.phase==='retryable'&&<><button type="button" onClick={()=>void session.recover()}>{t('business.records.recover')}</button><button type="button" onClick={()=>void session.retry()}>{t('business.records.retrySave')}</button></>}
   {state.phase==='conflict'&&<button type="button" disabled={state.comparing} onClick={()=>void session.compare()}>{t('business.records.compare')}</button>}
   {!['unknown','retryable','conflict','recovery-error'].includes(state.phase)&&<button type="submit" className={css.primary} disabled={blocked||choosingReference}>{t(state.phase==='saving'?'business.records.saving':form.kind==='archive'?'business.records.archive':'business.records.save')}</button>}
  </footer>
 </form>
}

type FieldInputProps={id:string;required:boolean;'aria-invalid':boolean;'aria-describedby':string|undefined}
function MoneyField({field,value,change,inputProps}:{field:BusinessRichMoneyFieldDefinition;value:string;change:(value:string)=>void;inputProps:FieldInputProps}){
 const {t}=useI18n(),[draft,setDraft]=useState(()=>businessMoneyInput(field,value)),lastSent=useRef(value)
 useEffect(()=>{if(value!==lastSent.current){setDraft(businessMoneyInput(field,value));lastSent.current=value}},[field,value])
 const update=(amount:string,currency:string)=>{setDraft({amount,currency});const next=businessMoneyValue(field,currency,amount);lastSent.current=next;change(next)}
 return <><span className={css.moneyInput}><input {...inputProps} type="text" inputMode="decimal" maxLength={24} value={draft.amount} onChange={event=>update(event.target.value,draft.currency)}/><select aria-label={field.label+' · '+t('business.records.currency')} value={draft.currency} onChange={event=>{const currency=event.target.value;if(draft.raw!==undefined)setDraft({...draft,currency});else update(draft.amount,currency)}}>{field.currencies.map(currency=><option key={currency} value={currency}>{currency}</option>)}</select></span>{draft.raw!==undefined&&<small className={css.preserved}>{t('business.records.preservedValue')} <code>{draft.raw}</code></small>}</>
}
function MultiEnumField({field,value,change,inputProps}:{field:BusinessRichMultiEnumFieldDefinition;value:string;change:(value:string)=>void;inputProps:FieldInputProps}){
 const {t}=useI18n(),[tooLong,setTooLong]=useState(false);let selected:string[]=[],preserved=false
 try{const parsed=readBusinessRichFieldValue({...field,required:false},value);if(parsed?.type==='multi-enum')selected=parsed.values}catch{preserved=true}
 const update=(option:string,checked:boolean)=>{
  const next=checked?[...selected,option]:selected.filter(item=>item!==option)
  let encoded:string
  try{encoded=next.length?encodeBusinessRichFieldValue(field,next):''}catch{setTooLong(true);return}
  setTooLong(false);change(encoded)
 }
 return <><div id={inputProps.id} role="group" aria-labelledby={inputProps.id+'-label'} aria-describedby={[inputProps['aria-describedby'],tooLong?inputProps.id+'-limit':undefined].filter(Boolean).join(' ')||undefined} aria-invalid={inputProps['aria-invalid']||tooLong} className={css.multiEnum}>{field.values.map(option=><label key={option}><input type="checkbox" checked={selected.includes(option)} onChange={event=>update(option,event.target.checked)}/><span>{option}</span></label>)}</div>{tooLong&&<small id={inputProps.id+'-limit'} className={css.fieldError} role="alert">{t('business.records.selectionTooLong')}</small>}{preserved&&<small className={css.preserved}>{t('business.records.preservedValue')} <code>{value}</code></small>}</>
}
function DurationField({value,change,label,inputProps}:{value:string;change:(value:string)=>void;label:string;inputProps:FieldInputProps}){
 const {t}=useI18n(),[draft,setDraft]=useState(()=>businessDurationInput(value)),lastSent=useRef(value)
 useEffect(()=>{if(value!==lastSent.current){setDraft(businessDurationInput(value));lastSent.current=value}},[value])
 const update=(amount:string,unit:BusinessDurationUnit)=>{
  setDraft({amount,unit});const next=businessDurationValue(amount,unit);lastSent.current=next;change(next)
 }
 const unitKeys={second:'business.records.seconds',minute:'business.records.minutes',hour:'business.records.hours',day:'business.records.days'} as const
 return <><span className={css.durationInput}><input {...inputProps} type="text" inputMode="decimal" maxLength={2000} aria-label={label} value={draft.amount} onChange={event=>update(event.target.value,draft.unit)}/><select aria-label={label+' · '+t('business.records.unit')} value={draft.unit} onChange={event=>{const unit=event.target.value as BusinessDurationUnit;if(draft.raw!==undefined)setDraft({...draft,unit});else update(draft.amount,unit)}}>{(Object.keys(unitKeys) as BusinessDurationUnit[]).map(unit=><option key={unit} value={unit}>{t(unitKeys[unit])}</option>)}</select></span>{draft.raw!==undefined&&<small className={css.preserved}>{t('business.records.preservedDuration')} <code>{draft.raw}</code></small>}</>
}
