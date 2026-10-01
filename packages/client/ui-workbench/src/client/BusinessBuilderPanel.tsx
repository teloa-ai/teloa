import {useRef,useState,useSyncExternalStore,type ReactNode} from 'react'
import {Check,FileText,RefreshCw} from 'lucide-react'
import type {BusinessConfigurationApplyResult,BusinessConfigurationPageProjectionVersioned as BusinessConfigurationPageProjection} from '@teloa/contract'
import type {BusinessBuilderFlow} from './business-builder-flow.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessBuilderPanel.module.css'
export type BusinessBuilderPanelProps={flow:BusinessBuilderFlow;renderPage:(projection:BusinessConfigurationPageProjection)=>ReactNode;onOpenSaved?:(result:BusinessConfigurationApplyResult)=>void}
const identities=new WeakMap<BusinessBuilderFlow,number>();let nextIdentity=0
/** 外层仅订阅目标身份；更换本人、宿主或草案时卸载局部页面选择与在途展示。 */
export function BusinessBuilderPanel(props:BusinessBuilderPanelProps){
 const state=useSyncExternalStore(props.flow.subscribe,props.flow.getSnapshot,props.flow.getSnapshot)
 let identity=identities.get(props.flow);if(identity===undefined){identity=++nextIdentity;identities.set(props.flow,identity)}
 return <Panel key={JSON.stringify([identity,state.binding?.sessionId,state.draft?.id])} {...props}/>
}
function Panel({flow,renderPage,onOpenSaved}:BusinessBuilderPanelProps){
 const {t}=useI18n(),state=useSyncExternalStore(flow.subscribe,flow.getSnapshot,flow.getSnapshot)
 const [selected,setSelected]=useState<string>(),[busy,setBusy]=useState(false),[failure,setFailure]=useState<unknown>(),running=useRef(false)
 const previous=useRef<{projection:BusinessConfigurationPageProjection;title:string}>()
 const draft=state.draft,pages=draft?.candidate.pages??[],title=draft?.candidate.title??state.binding?.title??t('business.builder.title')
 const pageId=selected&&pages.some(page=>page.id===selected)?selected:draft?.candidate.homePageId??pages[0]?.id
 let pendingSave=false,pendingCreation=false,journalError:unknown
 try{pendingSave=!!flow.pendingSave();pendingCreation=!!flow.pendingCreation()}catch(error){journalError=error}
 const serverPending=!!state.binding&&!state.binding.sessionId
 const canRecoverCreation=pendingCreation||serverPending
 // recovering 也表示刚加载持久意图；它本身不证明有网络操作在途。
 const inFlight=busy||['creating','saving'].includes(state.phase)||(state.phase==='recovering'&&!pendingSave&&!canRecoverCreation)
 const locked=inFlight||pendingSave||!!journalError||state.phase==='unknown'
 const preview=state.preview,validPreview=!!draft&&draft.status==='draft'&&pages.length>0&&!!preview&&preview.draftId===draft.id&&preview.revision===draft.revision&&preview.candidateHash===draft.hash&&preview.baseVersion===draft.baseVersion
 const projection=state.page,current=!!projection&&projection.mode==='preview'&&projection.draftId===draft?.id&&projection.revision===draft.revision&&projection.configurationHash===draft.hash
 if(projection&&current&&state.pageStatus==='ready'&&previous.current?.projection!==projection)previous.current={projection,title}
 const displayed=previous.current,stale=!!displayed&&(busy||state.pageStatus!=='ready'||!current||projection?.page.definition.id!==pageId)
 const error=failure??journalError??state.error
 const errorCode=error&&typeof error==='object'&&'code'in error?error.code:undefined
 const errorKey=errorCode==='teloa/forbidden'?'business.builder.forbidden':errorCode==='teloa/version-conflict'?'business.builder.conflict':errorCode==='teloa/invalid-input'?'business.builder.invalid':'business.builder.error'
 const act=async(operation:()=>Promise<unknown>)=>{
  if(running.current)return
  running.current=true;setBusy(true);setFailure(undefined)
  try{await operation()}catch(error){setFailure(error)}finally{running.current=false;setBusy(false)}
 }
 // 读取顺序与修订核验都沿 Flow；过时读取不会继续索取另一个版本的页面。
 const refresh=()=>act(async()=>{
  const fresh=await flow.refreshDraft(),latest=flow.getSnapshot().draft
  if(!latest||fresh.id!==latest.id||fresh.revision!==latest.revision||fresh.hash!==latest.hash)return
  if(!fresh.candidate.pages.length)return
  const checked=await flow.preview(),after=flow.getSnapshot().draft
  if(!after||after.id!==fresh.id||after.revision!==fresh.revision||after.hash!==fresh.hash||checked.revision!==fresh.revision)return
  const next=pageId&&fresh.candidate.pages.some(page=>page.id===pageId)?pageId:fresh.candidate.homePageId??fresh.candidate.pages[0]!.id
  setSelected(next);await flow.page(next)
 })
 const select=(id:string)=>{if(locked)return;setSelected(id);void act(()=>flow.page(id))}
 return <section className={css.panel} aria-label={t('business.builder.panel')}>
  <header className={css.header}><div><p className={css.eyebrow}>{t('business.builder.title')}</p><h2>{title}</h2><p>{t(state.phase==='saved'||draft?.status==='applied'?'business.builder.savedNote':'business.builder.draftNote')}</p></div><button type="button" onClick={()=>void refresh()} disabled={locked||!draft}><RefreshCw size={16} aria-hidden="true"/>{t('business.builder.refresh')}</button></header>
  {inFlight&&<p className={css.notice} role="status">{t(state.phase==='saving'?'business.builder.saving':state.phase==='recovering'?'business.builder.checking':state.phase==='creating'?'business.builder.creating':'business.builder.loading')}</p>}
  {!!error&&!pendingSave&&<p className={css.error} role="alert">{t(errorKey)}</p>}
  {(pendingSave||state.phase==='unknown')&&<div className={css.notice} role="status"><p>{t('business.builder.unknown')}</p><button type="button" disabled={inFlight||!!journalError} onClick={()=>void act(()=>flow.recoverSave())}>{t('business.builder.check')}</button></div>}
  {canRecoverCreation&&!pendingSave&&<div className={css.notice}><p>{t('business.builder.creationPending')}</p><button type="button" disabled={inFlight||!!journalError} onClick={()=>void act(()=>flow.recoverCreation(pendingCreation?undefined:state.binding?.requestId))}>{t('business.builder.restore')}</button></div>}
  {pages.length>0&&<nav className={css.navigation} aria-label={t('business.builder.pages')}>{pages.map(page=><button type="button" key={page.id} aria-pressed={pageId===page.id} disabled={locked} onClick={()=>select(page.id)}>{page.title}</button>)}</nav>}
  {displayed?<div className={css.preview} aria-busy={inFlight||state.pageStatus==='loading'}>{stale&&<p className={css.stale} role="status">{t('business.builder.previous',{business:displayed.title,page:displayed.projection.page.definition.title})}</p>}<div className={stale?css.old:undefined}>{renderPage(displayed.projection)}</div></div>:<div className={css.empty}><FileText size={28} aria-hidden="true"/><h3>{t(state.result?'business.builder.saved':pages.length?'business.builder.previewReady':'business.builder.empty')}</h3><p>{t(state.result?'business.builder.savedNote':pages.length?'business.builder.refreshNote':'business.builder.describe')}</p></div>}
  {state.result?<footer className={css.success}><div><Check size={18} aria-hidden="true"/><span>{t('business.builder.saved')}</span></div>{onOpenSaved&&<button type="button" className={css.primary} onClick={()=>onOpenSaved(state.result!)}>{t('business.builder.open')}</button>}</footer>:!pendingSave&&state.phase!=='unknown'&&<footer className={css.footer}><p>{t('business.builder.saveNote')}</p><button type="button" className={css.primary} disabled={locked||!validPreview||!current||state.pageStatus!=='ready'||projection?.page.definition.id!==pageId||!!error} onClick={()=>void act(()=>flow.save())}>{t('business.builder.save')}</button></footer>}
 </section>
}
