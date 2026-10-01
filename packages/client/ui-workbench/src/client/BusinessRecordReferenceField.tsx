import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import {businessObjectReference} from '@teloa/contract'
import type {BusinessRecordApi} from './business-record-api.js'
import type {BusinessTarget} from './business-preview.js'
import {BusinessReferenceReader,readBusinessReference,readBusinessReferencePage,businessReferenceSelection,businessMultiReferenceChange,type BusinessReferenceField,type BusinessReferenceRecord,type BusinessReferenceState} from './business-record-reference.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessRecordPage.module.css'
function useReference(api:BusinessRecordApi,scope:string,type:string,value:string){
 const reader=useMemo(()=>new BusinessReferenceReader(api,{scope,type,id:value}),[api,scope,type,value])
 const state=useSyncExternalStore(reader.subscribe,reader.getSnapshot,reader.getSnapshot)
 useEffect(()=>{void reader.read();return()=>reader.dispose()},[reader])
 return {state,reader}
}
const stateKey=(state:BusinessReferenceState)=>'business.records.reference.'+state.status
type ValueProps={api:BusinessRecordApi;scope:string;field:BusinessReferenceField;value:string;go?:((target:BusinessTarget)=>void)|undefined;retryable?:boolean}
export function BusinessRecordReferenceValue(props:ValueProps){
 const {t}=useI18n(),ids=businessReferenceSelection(props.field,props.value)
 if(!ids)return <span>{t('business.records.reference.unavailable')}</span>
 if(!ids.length)return <>—</>
 if(props.field.type!=='multi-reference')return <ReferenceValue {...props}/>
 return <span className={css.referenceValues}>{ids.map(id=><span key={id}><ReferenceValue {...props} value={id}/></span>)}</span>
}
function ReferenceValue({api,scope,field,value,go,retryable=true}:ValueProps){
 const {t}=useI18n(),{state,reader}=useReference(api,scope,field.referenceType!,value)
 const open=async()=>{const record=await reader.read();if(record)go?.({scope:record.scope,section:'data',objectType:record.type,id:record.id,recordReference:businessObjectReference({scope:record.scope,type:record.type,id:record.id,version:record.version,snapshotHash:record.snapshotHash})})}
 if(state.status==='empty')return <>—</>
 if(state.status==='ready')return go?<button type="button" className={css.referenceLink} onClick={()=>void open()}>{state.record.title}</button>:<>{state.record.title}</>
 return <span role={state.status==='loading'?'status':undefined}>{t(stateKey(state))}{retryable&&state.status!=='loading'&&<button type="button" onClick={()=>void reader.read()}>{t('business.records.retry')}</button>}</span>
}
type InputProps={id:string;required:boolean;'aria-invalid':boolean;'aria-describedby':string|undefined}
export function BusinessRecordReferenceField({api,scope,field,value,change,disabled,inputProps,onChoosing}:{api:BusinessRecordApi;scope:string;field:BusinessReferenceField;value:string;change:(value:string)=>void;disabled:boolean;inputProps:InputProps;onChoosing?:((choosing:boolean)=>void)|undefined}){
 // 类型/API切换时候选及在途选择随子组件一起卸载；不共享身份缓存。
 const apiKeys=useMemo(()=>({}),[api])
 return <ReferencePicker key={JSON.stringify([scope,field.type,field.referenceType])} api={api} apiKey={apiKeys} scope={scope} field={field} value={value} change={change} disabled={disabled} inputProps={inputProps} onChoosing={onChoosing}/>
}
function ReferencePicker({api,apiKey,scope,field,value,change,disabled,inputProps,onChoosing}:{api:BusinessRecordApi;apiKey:object;scope:string;field:BusinessReferenceField;value:string;change:(value:string)=>void;disabled:boolean;inputProps:InputProps;onChoosing?:((choosing:boolean)=>void)|undefined}){
 const {t}=useI18n(),type=field.referenceType!,multi=field.type==='multi-reference',ids=businessReferenceSelection(field,value),{state,reader}=useReference(api,scope,type,multi?'':value)
 const [items,setItems]=useState<BusinessReferenceRecord[]>([]),[cursor,setCursor]=useState<string>(),[loading,setLoading]=useState(true),[error,setError]=useState<BusinessReferenceState>(),[choosing,setChoosing]=useState(false),[selectionError,setSelectionError]=useState<'required'|'limit'|'unavailable'>(),[refresh,setRefresh]=useState(0)
 const pending=useRef<AbortController>(),choice=useRef<AbortController>(),seen=useRef(new Set<string>()),disabledRef=useRef(disabled),valueRef=useRef(value)
 disabledRef.current=disabled;valueRef.current=value
 const load=async(more=false)=>{
  pending.current?.abort();const request=new AbortController();pending.current=request;setLoading(true);setError(undefined)
  if(!more){seen.current.clear();setItems([]);setCursor(undefined)}
  try{const page=await readBusinessReferencePage(api,scope,type,request.signal,more?cursor:undefined);if(request.signal.aborted)return
   if(page.nextCursor&&seen.current.has(page.nextCursor))throw Object.assign(Error('关联分页重复。'),{code:'teloa/invalid-host-response'})
   if(page.nextCursor)seen.current.add(page.nextCursor)
   setItems(previous=>more?[...new Map([...previous,...page.items].map(record=>[record.id,record])).values()]:page.items);setCursor(page.nextCursor)
  }catch(error){if(!request.signal.aborted)setError({status:'failed'})}finally{if(!request.signal.aborted)setLoading(false)}
 }
 useEffect(()=>{void load();return()=>{pending.current?.abort();choice.current?.abort()}},[apiKey])
 useEffect(()=>{choice.current?.abort();setChoosing(false);onChoosing?.(false)},[value,disabled])
 useEffect(()=>{onChoosing?.(choosing)},[choosing])
 useEffect(()=>()=>{onChoosing?.(false)},[])
 const updateMulti=(id:string,action:'add'|'remove'|'clear')=>{
  if(disabledRef.current||field.type!=='multi-reference')return
  try{const next=businessMultiReferenceChange(field,valueRef.current,id,action);setSelectionError(undefined);change(next)}
  catch{setSelectionError(!ids?'unavailable':action!=='add'&&field.required&&(action==='clear'||ids.length===1)?'required':'limit')}
 }
 const choose=async(id:string)=>{
  choice.current?.abort();if(disabledRef.current)return
  if(!id){if(!multi)change('');return}
  const original=valueRef.current,request=new AbortController();choice.current=request;setChoosing(true);onChoosing?.(true)
  const result=await readBusinessReference(api,{scope,type,id},request.signal)
  if(request.signal.aborted||valueRef.current!==original)return
  setChoosing(false);onChoosing?.(false)
  if(result.status==='ready'&&!disabledRef.current){setError(undefined);if(multi)updateMulti(result.record.id,'add');else change(result.record.id)}else setError(result)
 }
 const selected=state.status==='ready'?state.record:undefined
 const options=items.filter(record=>!ids?.includes(record.id))
 return <div className={css.referenceField}>
  <select {...inputProps} value={multi?'':value} required={multi?false:inputProps.required} disabled={disabled||choosing||multi&&!ids} aria-busy={loading||choosing} onChange={event=>void choose(event.target.value)}>
   <option value="">{t('business.records.choose')}</option>
   {!multi&&value&&<option value={value}>{selected?.title??t(stateKey(state))}</option>}
   {options.map(record=><option key={record.id} value={record.id}>{record.title}</option>)}
  </select>
  {!multi&&value&&state.status!=='ready'&&state.status!=='empty'&&<small role="status">{t(stateKey(state))}</small>}
  {multi&&ids&&<ul className={css.referenceSelections} aria-label={t('business.records.reference.selected')}>{ids.map(id=><li key={JSON.stringify([id,refresh])}><SelectedReference api={api} scope={scope} field={field} value={id} disabled={disabled||choosing} remove={()=>updateMulti(id,'remove')}/></li>)}</ul>}
  {multi&&!ids&&<small role="alert">{t('business.records.reference.unavailable')}</small>}
  {multi&&<small>{t('business.records.reference.multiHint')}</small>}
  {selectionError&&<small className={css.fieldError} role="alert">{t(selectionError==='required'?'business.records.reference.required':selectionError==='limit'?'business.records.reference.limit':'business.records.reference.unavailable')}</small>}
  {error&&<small role="alert">{t(stateKey(error))}</small>}
  {!loading&&!error&&!items.length&&<small role="status">{t('business.records.reference.none')}</small>}
  {loading&&<small role="status">{t('business.records.reference.loading')}</small>}
  <div className={css.actions}>
   {value&&<button type="button" disabled={disabled||choosing} onClick={()=>multi?updateMulti('','clear'):void choose('')}>{t('business.records.reference.clear')}</button>}
   <button type="button" disabled={disabled||loading||choosing} onClick={()=>{void load();void reader.read();setRefresh(previous=>previous+1)}}>{t(error?'business.records.retry':'business.records.refresh')}</button>
   {cursor&&<button type="button" disabled={disabled||loading||choosing} onClick={()=>void load(true)}>{t('business.records.more')}</button>}
  </div>
 </div>
}

function SelectedReference({api,scope,field,value,disabled,remove}:{api:BusinessRecordApi;scope:string;field:BusinessReferenceField;value:string;disabled:boolean;remove:()=>void}){
 const {t}=useI18n(),{state}=useReference(api,scope,field.referenceType!,value),title=state.status==='ready'?state.record.title:t(stateKey(state))
 return <><span role={state.status==='loading'?'status':undefined}>{title}</span><button type="button" disabled={disabled} aria-label={t('business.records.reference.remove',{title})} onClick={remove}>{t('business.records.reference.removeAction')}</button></>
}
