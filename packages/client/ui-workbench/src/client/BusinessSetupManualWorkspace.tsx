import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {WorkError} from '@teloa/contract'
import type {BusinessBuilderController} from './business-builder-controller.js'
import type {BusinessBuilderApi} from './business-builder-api.js'
import type {BusinessBuilderFlow} from './business-builder-flow.js'
import {ContextDrawer} from './ContextDrawer.js'
import {BusinessSetupManualEditor} from './BusinessSetupManualEditor.js'
import {BusinessSetupHistoryPanel} from './BusinessSetupHistoryPanel.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessSetupManualEditor.module.css'

type Props={controller:BusinessBuilderController;api:BusinessBuilderApi;scope:string;close:()=>void;review:(flow:BusinessBuilderFlow)=>void}
const changed=()=>new WorkError('teloa/conflict','本人、业务或原搭建目标已变化，请从原入口恢复。')
const identities=new WeakMap<object,number>();let nextIdentity=0
function identityOf(value:object){let id=identities.get(value);if(id===undefined){id=++nextIdentity;identities.set(value,id)}return id}
/** 独立于主视图的手动抽屉；自己发起的会话导航不卸载它，关闭/本人变化立即失效后续导航。 */
export function BusinessSetupManualWorkspace(props:Props){return <Workspace key={identityOf(props.controller)+':'+identityOf(props.api)+':'+props.scope} {...props}/>}
function Workspace({controller,api,scope,close,review}:Props){
 const {t}=useI18n(),[tab,setTab]=useState<'edit'|'history'>('edit'),[flow,setFlow]=useState<BusinessBuilderFlow>(),[error,setError]=useState(false),[busy,setBusy]=useState(true)
 const identity=useRef(controller.getSnapshot()),alive=useRef(true),started=useRef(false),operation=useRef<Promise<BusinessBuilderFlow>>(),restoring=useRef<{version:number;hash:string;draftId?:string;started?:boolean}>()
 const current=()=>alive.current&&identity.current.api===api&&controller.getSnapshot().api===api&&controller.getSnapshot().namespace===identity.current.namespace
 const closeWorkspace=()=>{alive.current=false;close()}
 const ready=()=>{
  if(!current())throw changed()
  const next=controller.getSnapshot().flow,state=next?.getSnapshot()
  if(!next||controller.getSnapshot().checkedSessionId!==state?.binding?.sessionId||controller.getSnapshot().sessionKind!=='builder'||state?.draft?.scope!==scope||state.draft.status!=='draft'||!state.binding?.sessionId||state.binding.draftId!==state.draft.id)throw changed()
  return next
 }
 const start=async()=>{
  if(!current())throw changed()
  const original=controller.getSnapshot().flow,pending=original?.pendingCreation()
  const token=controller.captureNavigation(current)
  if(pending){if(pending.scope!==scope)throw changed();await controller.recover(pending.requestId,false,token)}
  else{if(started.current)throw changed();started.current=true;await controller.start({scope},token)}
  return ready()
 }
 const ensure=async()=>{
  if(!current()||!identity.current.namespace)throw changed()
  const original=controller.getSnapshot().flow,state=original?.getSnapshot()
  if(state?.draft?.scope===scope&&state.draft.status==='draft'&&state.binding?.sessionId&&controller.getSnapshot().checkedSessionId===state.binding.sessionId&&controller.getSnapshot().sessionKind==='builder')return ready()
  const directory=await api.setupPlans({scope});if(!current())throw changed()
  if(directory.items[0]){await controller.open(directory.items[0].sessionId,false,controller.captureNavigation(current));return ready()}
  // 尚未保存完整方案的原生 builder 仍拥有输入 journal；不能只查 revision>=1 的聚合目录。
  let cursor:string|undefined;const seen=new Set<string>()
  do{
   const builders=await api.list({kind:'builder',scope,limit:32,...(cursor?{cursor}:{})});if(!current())throw changed()
   const originalDraft=builders.items.find(item=>item.draft?.scope===scope&&item.draft.status==='draft'&&item.binding.kind==='builder')
   if(originalDraft){const token=controller.captureNavigation(current);if(originalDraft.binding.sessionId)await controller.open(originalDraft.binding.sessionId,false,token);else await controller.recover(originalDraft.binding.requestId,false,token);return ready()}
   cursor=builders.nextCursor;if(cursor){if(seen.has(cursor))throw changed();seen.add(cursor)}
  }while(cursor)
  return start()
 }
 const load=async()=>{
  if(operation.current)return operation.current
  setBusy(true);setError(false)
  const pending=ensure();operation.current=pending
  try{const next=await pending;if(current())setFlow(next);return next}catch(error){if(current())setError(true);throw error}finally{if(operation.current===pending)operation.current=undefined;if(current())setBusy(false)}
 }
 useEffect(()=>{alive.current=true;void load().catch(()=>{});return()=>{alive.current=false}},[controller,api,scope])
 const restore=async(version:number,hash:string)=>{
  if(!current()||operation.current)throw changed()
  if(restoring.current&&(restoring.current.version!==version||restoring.current.hash!==hash))throw changed()
  restoring.current??={version,hash}
  const previous=controller.getSnapshot().flow,state=previous?.getSnapshot()
  let next:BusinessBuilderFlow
  if(restoring.current.draftId){next=ready();if(next.getSnapshot().draft?.id!==restoring.current.draftId)throw changed()}
  else if(previous&&state?.draft?.scope===scope&&state.draft.status==='draft'&&state.draft.revision===1&&!state.setupPlan){const snapshot=await previous.readManual();if(previous.readManualInput(snapshot)){if(!restoring.current.started){started.current=false;restoring.current.started=true}next=await start()}else next=previous;restoring.current.draftId=next.getSnapshot().draft!.id}
  else{if(!restoring.current.started){started.current=false;restoring.current.started=true}next=await start();restoring.current.draftId=next.getSnapshot().draft!.id}
  if(!current())throw changed()
  await next.restoreConfiguration(version,hash)
  if(current()){review(next);closeWorkspace()}
 }
 const reviewed=()=>{if(flow&&current())review(flow)}
 if(typeof document==='undefined')return null
 return createPortal(<ContextDrawer title={t('business.manual.title')} close={closeWorkspace} padded><div className={css.editor}>
  <nav className={css.actions} aria-label={t('business.manual.title')}><button aria-pressed={tab==='edit'} onClick={()=>setTab('edit')}>{t('business.manual.editTab')}</button><button aria-pressed={tab==='history'} onClick={()=>setTab('history')}>{t('business.history.title')}</button></nav>
  {tab==='edit'?<>{busy&&<p role="status">{t('business.manual.loading')}</p>}{error&&<p role="alert">{t('business.manual.error')}</p>}{error&&<button disabled={busy} onClick={()=>void load().catch(()=>{})}>{t('business.manual.reload')}</button>}{flow&&<BusinessSetupManualEditor key={flow.getSnapshot().draft?.id} flow={flow} current={current} onClose={closeWorkspace} onReview={reviewed}/>}</>:<BusinessSetupHistoryPanel api={api} scope={scope} current={current} onRestore={restore}/>}
 </div></ContextDrawer>,document.body)
}
