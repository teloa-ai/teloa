import {useEffect,useRef,useState} from 'react'
import type {RoleMemory as SavedRoleMemory} from '@teloa/contract'
import type {RoleMemoryApi,RoleMemoryEditDraft} from './role-memory-api.js'
import {ContextDrawer} from './ContextDrawer.js'
import {applicationPresentation} from './application-presentation.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'

type Origin={api:RoleMemoryApi;ownerId:string;roleId:string;id:string;epoch:number}
type OpenEdit={origin:Origin;draft:RoleMemoryEditDraft}
/** 持久记忆的本人编辑入口。草稿与未决请求由本人连接的 API 保留，收起窗口没有写入。 */
export function RoleMemory({memory,api,disabled=false,onSaved}:{memory:SavedRoleMemory;api:RoleMemoryApi;disabled?:boolean;onSaved:(memory:SavedRoleMemory)=>void}){
 const {t,locale}=useI18n(),origin=useRef<Origin>({api,ownerId:memory.ownerId,roleId:memory.roleId,id:memory.id,epoch:0}),mounted=useRef(true),focus=useRef<HTMLTextAreaElement>(null)
 const latest=useRef({memory,onSaved});latest.current={memory,onSaved}
 const [opened,setOpened]=useState<OpenEdit>(),[busy,setBusy]=useState(false),[error,updateError]=useState(''),[storageError,setStorageError]=useState(false),[history,setHistory]=useState<SavedRoleMemory>(),[reading,setReading]=useState(false),errorOrigin=useRef(origin.current)
 const [,refreshPending]=useState(0)
 if(origin.current.api!==api||origin.current.ownerId!==memory.ownerId||origin.current.roleId!==memory.roleId||origin.current.id!==memory.id)origin.current={api,ownerId:memory.ownerId,roleId:memory.roleId,id:memory.id,epoch:origin.current.epoch+1}
 const view=opened?.origin===origin.current?opened:undefined,currentView=useRef(view);currentView.current=view
 const setError=(value:string)=>{errorOrigin.current=origin.current;updateError(value)},visibleError=errorOrigin.current===origin.current?error:''
 const readOnly=disabled||memory.state==='withdrawn'
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 const current=(target:OpenEdit)=>mounted.current&&target.origin===origin.current&&currentView.current===target
 const close=()=>{if(!busy){setOpened(undefined);setError('');setHistory(undefined)}}
 const finish=(promise:Promise<SavedRoleMemory>,target:OpenEdit)=>{
  setBusy(true);setError('')
  void promise.then(saved=>{if(current(target)){if(saved.content.version>=latest.current.memory.content.version&&saved.stateVersion>=latest.current.memory.stateVersion)latest.current.onSaved(saved);setOpened(previous=>previous===target?undefined:previous);setHistory(undefined)}},cause=>{if(current(target))setError(localizeWorkError(locale,cause))}).finally(()=>{if(current(target))setBusy(false)})
 }
 useEffect(()=>{
  if(!view)return
  const pending=api.pending(),flight=api.inFlight()
  if(flight&&pending?.endpoint==='role-memory/edit'&&pending.target.id===memory.id&&pending.target.ownerId===memory.ownerId&&pending.target.roleId===memory.roleId)finish(flight,view)
  else if(flight){const settled=()=>{if(current(view))refreshPending(value=>value+1)};void flight.then(settled,settled)}
 },[view])
 const open=()=>{
  try{const draft=readOnly?{target:memory,value:{title:memory.title,markdown:memory.content.markdown}}:api.editDraft(memory);setOpened({origin:origin.current,draft});setBusy(false);setReading(false);setError('');setHistory(undefined);setStorageError(!readOnly&&!!api.draftError())}catch(cause){setError(localizeWorkError(locale,cause))}
 }
 const change=(value:RoleMemoryEditDraft['value'])=>{
  if(!view)return
  // 先保留输入，再尝试持久化；配额失败不能使界面或本连接退回旧值。
  view.draft.value=value;setOpened({...view,draft:{...view.draft,value}})
  try{api.updateEditDraft(memory.id,value);setStorageError(false)}catch{setStorageError(true)}
 }
 const pending=api.pending(),ownPending=pending?.endpoint==='role-memory/edit'&&pending.target.id===memory.id&&pending.target.ownerId===memory.ownerId&&pending.target.roleId===memory.roleId
 const stale=view&&(view.draft.target.content.version!==memory.content.version||view.draft.target.stateVersion!==memory.stateVersion)
 const readPrevious=async()=>{
  if(!view||reading)return
  const target=view,version=(history?.content.version??memory.content.version)-1
  if(version<1)return
  setReading(true);setError('')
  try{const previous=await api.readVersion(memory,version);if(current(target))setHistory(previous)}catch(cause){if(current(target))setError(localizeWorkError(locale,cause))}finally{if(mounted.current&&target.origin===origin.current)setReading(false)}
 }
 return <>
  {memory.content.editedBy==='self'&&<small>{t('roleMemory.edit.bySelf',{version:memory.content.version})}</small>}
  <button type="button" onClick={open}>{t(readOnly?'roleMemory.edit.review':'roleMemory.edit.action')}</button>
  {!view&&visibleError&&<p role="alert">{visibleError}</p>}
  {view&&<ContextDrawer title={t(readOnly?'roleMemory.edit.review':'roleMemory.edit.action')} close={close} canClose={!busy} initialFocus={focus}>
   <form className={css.form} onSubmit={event=>{event.preventDefault();if(readOnly||busy||pending||!applicationPresentation.can('people'))return;finish(api.edit(view.draft.target,view.draft.value),view)}}>
    <p>{t('roleMemory.edit.source',{title:view.draft.target.sourceTitle,version:view.draft.target.source.version})}</p><p>{t('roleMemory.edit.note')}</p>
    {visibleError&&<p role="alert">{visibleError}</p>}{storageError&&<p role="alert">{t('roleMemory.edit.storage')}</p>}{stale&&<p>{t('roleMemory.edit.stale')}</p>}
    {pending&&<p>{t('roleMemory.edit.unknown')}</p>}
    <label>{t('roleMemory.edit.title')}<input aria-label={t('roleMemory.edit.title')} required maxLength={120} disabled={readOnly||busy||ownPending} value={view.draft.value.title} onChange={event=>change({...view.draft.value,title:event.target.value})}/></label>
    <label>{t('roleMemory.edit.body')}<textarea ref={focus} aria-label={t('roleMemory.edit.body')} rows={8} required maxLength={131072} disabled={readOnly||busy||ownPending} value={view.draft.value.markdown} onChange={event=>change({...view.draft.value,markdown:event.target.value})}/></label>
    {memory.content.version>1&&<section><button type="button" disabled={reading||(history?.content.version??memory.content.version)<=1} onClick={()=>void readPrevious()}>{t('roleMemory.edit.previous')}</button>{history&&<><h3>{t('roleMemory.edit.history',{version:history.content.version})}</h3><p>{history.title}</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{history.content.markdown}</pre><button type="button" onClick={()=>setHistory(undefined)}>{t('roleMemory.edit.current')}</button></>}</section>}
    <footer className={css.buttons}>
     <button type="button" disabled={busy} onClick={close}>{t('team.form.cancel')}</button>
     {!readOnly&&<button type="button" disabled={busy||!!pending} onClick={()=>{try{api.discardEditDraft(memory.id);close()}catch(cause){setError(localizeWorkError(locale,cause))}}}>{t('roleMemory.edit.discard')}</button>}
     {ownPending&&<button type="button" disabled={busy} onClick={()=>finish(api.recover(),view)}>{t('dailyLog.recover')}</button>}
     {!readOnly&&<button type="submit" disabled={disabled||busy||!!pending||!view.draft.value.title.trim()||!view.draft.value.markdown.trim()}>{t('roleMemory.edit.save')}</button>}
    </footer>
   </form>
  </ContextDrawer>}
 </>
}
