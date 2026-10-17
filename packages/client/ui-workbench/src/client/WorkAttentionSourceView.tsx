import {useEffect,useMemo,useRef,useState} from 'react'
import {WorkError,type BusinessChangeSet,type PageCreateDraft,type WorkAttentionSource} from '@teloa/contract'
import {BusinessChangeSetPreview} from './BusinessChangeSetPreview.js'
import {BusinessSyncControls} from './BusinessSyncControls.js'
import {ContextDrawer} from './ContextDrawer.js'
import {CreateEntry,type CreateEntryProps} from './CreateEntry.js'
import {businessWorkCopy} from './business-work-copy.js'
import type {BusinessWorkResultsApi} from './business-work-results-api.js'
import type {BusinessDashboardApi} from './business-dashboard-api.js'
import type {PageCreateApi} from './page-create-api.js'
import {createFailureKey} from './page-create-presentation.js'
import {useI18n} from './i18n/provider.js'
import css from './WorkAttentionSourceView.module.css'

export type WorkAttentionOriginalSource=Exclude<WorkAttentionSource,{kind:'task'}>
export type WorkAttentionSourceViewProps={
 source:WorkAttentionOriginalSource
 close:()=>void
 changed:()=>void
 businessWork?:BusinessWorkResultsApi
 businessDashboard?:BusinessDashboardApi
 pageCreate?:PageCreateApi
 /** 直接复用当前对象原有的确认链；没有真实落点时只查看或丢弃。 */
 creation?:Pick<CreateEntryProps,'onConfirm'|'afterConfirm'|'renderConfirmation'|'renderBusinessPreview'|'confirmLabelKey'>
 /** 确认服务或本人连接变化时销毁旧操作，不能借新入口落定旧回执。 */
 creationIdentity?:unknown
 openOriginal?:(source:WorkAttentionOriginalSource)=>void
}

const conflict=()=>new WorkError('teloa/conflict','原来源已变化，请返回原对象核对。')
function sameChange(source:Extract<WorkAttentionSource,{kind:'business-change-set'}>,draft:BusinessChangeSet):BusinessChangeSet{
 if(draft.id!==source.changeSetId||draft.scope!==source.scope||draft.revision!==source.revision||draft.digest!==source.digest||draft.state==='applied'||draft.state==='rejected')throw conflict()
 return draft
}
function sameDraft(source:Extract<WorkAttentionSource,{kind:'page-create-draft'}>,draft:PageCreateDraft):void{
 if(draft.id!==source.draftId||draft.entity!==source.entity||draft.scope!==source.scope||draft.bodyHash!==source.bodyHash||draft.status!=='draft')throw conflict()
}

/** 同一来源普通重绘不重挂载；切对象或正式API时销毁旧读取与原对象操作状态。 */
export function WorkAttentionSourceView(props:WorkAttentionSourceViewProps){
 const sourceKey=JSON.stringify(props.source),origin=useRef({sourceKey,businessWork:props.businessWork,businessDashboard:props.businessDashboard,pageCreate:props.pageCreate,creationIdentity:props.creationIdentity,key:0})
 if(origin.current.sourceKey!==sourceKey||origin.current.businessWork!==props.businessWork||origin.current.businessDashboard!==props.businessDashboard||origin.current.pageCreate!==props.pageCreate||origin.current.creationIdentity!==props.creationIdentity)origin.current={sourceKey,businessWork:props.businessWork,businessDashboard:props.businessDashboard,pageCreate:props.pageCreate,creationIdentity:props.creationIdentity,key:origin.current.key+1}
 return <SourceContent key={origin.current.key} {...props}/>
}

function SourceContent({source,close,changed,businessWork,businessDashboard,pageCreate,creation,openOriginal}:WorkAttentionSourceViewProps){
 const {t,locale}=useI18n(),copy=businessWorkCopy(locale),sourceKey=JSON.stringify(source)
 const [ready,setReady]=useState<{kind:'change';draft:BusinessChangeSet}|{kind:'sync'|'draft'}>(),[failure,setFailure]=useState<ReturnType<typeof createFailureKey>>(),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false)
 const alive=useRef(true),callbacks=useRef({close,changed});callbacks.current={close,changed}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const currentClose=()=>{if(alive.current)callbacks.current.close()},currentChanged=()=>{if(alive.current)callbacks.current.changed()}
 useEffect(()=>{
  const abort=new AbortController()
  setReady(undefined);setFailure(undefined)
  void (async()=>{
   if(source.kind==='business-change-set'){
    if(!businessWork)throw Error('原业务读取入口尚未接入。')
    const draft=sameChange(source,await businessWork.getChangeSet(source.changeSetId,abort.signal))
    if(!abort.signal.aborted)setReady({kind:'change',draft})
   }else if(source.kind==='business-sync'){
    if(!businessDashboard)throw Error('原同步入口尚未接入。')
    const statuses=await businessDashboard.syncStatus({scope:source.scope},abort.signal),status=statuses.find(row=>row.mappingId===source.mappingId)
    if(status?.lastRun?.id!==source.runId||status.lastRun.status!=='failed')throw conflict()
    if(!abort.signal.aborted)setReady({kind:'sync'})
   }else{
    if(!pageCreate)throw Error('原草案读取入口尚未接入。')
    sameDraft(source,await pageCreate.read({draftId:source.draftId},abort.signal))
    if(!abort.signal.aborted)setReady({kind:'draft'})
   }
  })().catch(error=>{if(!abort.signal.aborted)setFailure(createFailureKey(error))})
  return()=>abort.abort()
 },[sourceKey,businessWork,businessDashboard,pageCreate,revision])
 const guardedWork=useMemo(()=>{
  if(!businessWork||source.kind!=='business-change-set')return undefined
  return {...businessWork,getChangeSet:async(id:string,signal?:AbortSignal)=>{
   if(id!==source.changeSetId)throw conflict()
   try{return sameChange(source,await businessWork.getChangeSet(id,signal))}catch(error){if(alive.current&&!signal?.aborted)setFailure(createFailureKey(error));throw error}
  }}
 },[businessWork,sourceKey])
 const guardedDashboard=useMemo(()=>businessDashboard?{...businessDashboard,syncRun:async(...args:Parameters<BusinessDashboardApi['syncRun']>)=>{
  if(source.kind!=='business-sync'||args[0].scope!==source.scope||args[0].mappingId!==source.mappingId)throw conflict()
  const result=await businessDashboard.syncRun(...args);currentChanged();return result
 }}:undefined,[businessDashboard,sourceKey])
 const guardedDrafts=useMemo(()=>pageCreate?{...pageCreate,preview:async(...args:Parameters<PageCreateApi['preview']>)=>{
  try{const result=await pageCreate.preview(...args);if(source.kind!=='page-create-draft')throw conflict();sameDraft(source,result.draft);return result}catch(error){if(alive.current&&!args[1]?.aborted)setFailure(createFailureKey(error));throw error}
 },settle:async(...args:Parameters<PageCreateApi['settle']>)=>{
  if(source.kind!=='page-create-draft'||args[0].draftId!==source.draftId||args[0].expectedBodyHash!==source.bodyHash)throw conflict()
  const result=await pageCreate.settle(...args);if(args[0].outcome==='discarded'){currentChanged();currentClose()}return result
 }}:undefined,[pageCreate,sourceKey])
 if(ready?.kind==='change'&&!failure&&guardedWork)return <BusinessChangeSetPreview draft={ready.draft} api={guardedWork} close={currentClose} changed={currentChanged}/>
 const title=source.kind==='business-change-set'?copy.review:source.kind==='business-sync'?t('business.dashboards.sync.title'):t('create.drafts.title')
 return <ContextDrawer title={title} close={currentClose} canClose={!busy}>
  <div className={css.body}>
  {failure?<><p role="alert">{t(failure)}</p><button type="button" onClick={()=>setRevision(value=>value+1)}>{t('create.retry')}</button>{openOriginal&&<button type="button" onClick={()=>openOriginal(source)}>{locale==='zh-CN'?'查看原对象':locale.startsWith('zh')?'查看原物件':'Open original object'}</button>}</>:!ready?<p role="status">{t('create.preview.loading')}</p>:ready.kind==='sync'&&source.kind==='business-sync'&&guardedDashboard?<BusinessSyncControls scope={source.scope} mappingId={source.mappingId} api={guardedDashboard}/>:ready.kind==='draft'&&source.kind==='page-create-draft'&&guardedDrafts?<CreateEntry entity={source.entity} {...(source.scope===undefined?{}:{scope:source.scope})} api={guardedDrafts} embedded hideSentence focusDraft={{draftId:source.draftId,bodyHash:source.bodyHash}} onBusyChange={setBusy} prepare={()=>{throw Error('原草案详情不新建会话。')}} {...creation} afterConfirm={appliedRef=>{if(!alive.current)return;creation?.afterConfirm?.(appliedRef);currentChanged()}}/>:null}
  </div>
 </ContextDrawer>
}
