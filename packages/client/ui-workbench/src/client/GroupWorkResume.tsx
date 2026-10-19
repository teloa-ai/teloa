import {useEffect,useRef,useState} from 'react'
import clsx from 'clsx'
import type {RecoveryInspection,WorkControl} from '@teloa/contract'
import {ContextDrawer} from './ContextDrawer.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import type {WorkControlApi} from './work-control-api.js'
import css from './CollaborationPage.module.css'

export type GroupWorkResumeControls=Pick<WorkControlApi,'get'|'inspect'|'resume'|'recover'|'pending'|'recoveryMessage'|'discard'>
type Check={kind:'loading'}|{kind:'ready';control:WorkControl;candidates:RecoveryInspection[]}|{kind:'active'|'ended'|'unknown'|'pending'|'stuck'|'failed';error?:string}

/**
 * 只读核对：不属于本轮、或仍有结果未知的操作时不给恢复按钮；读取本身不恢复、不派发。
 * 上次对同一控制的恢复请求结果未知时，只能按原请求核对（不另发新请求）。
 */
async function check(controls:GroupWorkResumeControls,controlId:string):Promise<Check>{
 const pending=controls.pending()
 if(pending?.kind==='resume'&&pending.controlId===controlId&&!controls.recoveryMessage())return {kind:'pending'}
 if(pending||controls.recoveryMessage())return {kind:'unknown'}
 const control=await controls.get(controlId)
 if(control.scope!=='round')return {kind:'failed'}
 if(control.state==='active')return {kind:'active'}
 if(control.state==='stopping'||control.state==='stopped')return {kind:'ended'}
 if(control.state!=='paused'||control.pendingRunIds.length||control.unknownOperationIds.length)return {kind:'unknown'}
 const candidates=await controls.inspect(control.id)
 if(candidates.some(item=>item.reason==='unknown'))return {kind:'unknown'}
 // 服务端判定不会接受的候选（已受理却没有可接续的待办）：确认必然被拒，先如实说明要在工作详情里停止那次执行。
 return candidates.some(item=>item.resumable===false)?{kind:'stuck'}:{kind:'ready',control,candidates}
}

/**
 * 群里本人续办被原任务本轮控制暂停挡住时，在原群就地走既有整项恢复（work-recovery/resume）。
 * 恢复必须本人在这里明确确认：确认前重读控制与候选，版本、世代或候选有变就只刷新不提交；
 * 宿主仍逐项核对角色、授权与工作额度，不扩大原授权。关闭抽屉不恢复，也不撤回已保存的继续要求。
 */
export function GroupWorkResumeDrawer({controlId,controls,close,resumed,openTask}:{controlId:string;controls:GroupWorkResumeControls;close:()=>void;resumed:()=>void;openTask?:(()=>void)|undefined}){
 const {locale,t}=useI18n()
 const [state,setState]=useState<Check>({kind:'loading'}),[busy,setBusy]=useState(false),[notice,setNotice]=useState<string>(),[discarded,setDiscarded]=useState(false),live=useRef(true)
 const load=()=>check(controls,controlId).catch((cause:unknown):Check=>({kind:'failed',error:localizeWorkError(locale,cause)}))
 useEffect(()=>{live.current=true;void load().then(next=>{if(live.current)setState(next)});return()=>{live.current=false}},[controlId,controls])
 // 按原请求核对：成功即视为已恢复；原请求被拒时记录已清除，重新读取当前状态。
 const recover=async()=>{
  if(state.kind!=='pending'||busy)return
  setBusy(true);setNotice(undefined)
  try{await controls.recover();if(live.current){resumed();close()}}
  catch(cause){if(live.current){setNotice(localizeWorkError(locale,cause));setState(await load())}}
  finally{if(live.current)setBusy(false)}
 }
 const confirm=async()=>{
  if(state.kind!=='ready'||busy)return
  setBusy(true);setNotice(undefined)
  try{
   const fresh=await check(controls,controlId)
   if(fresh.kind!=='ready'||fresh.control.version!==state.control.version||fresh.control.generation!==state.control.generation||JSON.stringify(fresh.candidates)!==JSON.stringify(state.candidates)){if(live.current){setState(fresh);setNotice(t('group.resume.changed'))}return}
   await controls.resume(fresh.control,fresh.candidates.map(item=>item.runId))
   if(live.current){resumed();close()}
  }catch(cause){if(live.current){setNotice(localizeWorkError(locale,cause));setState(await load())}}
  finally{if(live.current)setBusy(false)}
 }
 // 本机控制恢复记录损坏时就地给出路：丢弃这条记录后重新核对，不恢复、不派发，也不撤回已保存的继续要求。
 const discard=()=>{
  try{controls.discard()}catch(cause){setNotice(localizeWorkError(locale,cause));return}
  setNotice(undefined);setDiscarded(true);setState({kind:'loading'});void load().then(next=>{if(live.current)setState(next)})
 }
 const recovery=controls.recoveryMessage()
 const message=recovery?localizeWorkError(locale,recovery)+' '+t('recovery.nextStep'):state.kind==='loading'?t('group.resume.loading'):state.kind==='ready'?t('group.resume.body'):state.kind==='failed'?state.error??t('group.resume.unknown'):t(`group.resume.${state.kind}`)
 return <ContextDrawer title={t('group.resume.title')} close={close} canClose={!busy} className={clsx(css.dialog,css.lightDrawer)}>
  <form onSubmit={event=>{event.preventDefault();void confirm()}}>
   <p className={css.boundary} role={recovery?'alert':state.kind==='loading'?'status':undefined}>{message}</p>
   {discarded&&<p role="status">{t('recovery.discarded')}</p>}
   {state.kind==='ready'&&state.candidates.length>0&&<p className={css.hint}>{t('group.resume.runs',{count:state.candidates.length})}</p>}
   {notice&&<p role="alert">{notice}</p>}
   <footer>
    {openTask&&state.kind!=='ready'&&state.kind!=='pending'&&state.kind!=='loading'&&<button type="button" className={css.secondary} onClick={()=>{close();openTask()}}>{t('group.status.openWork')}</button>}
    {recovery&&<button type="button" className={css.secondary} disabled={busy} onClick={discard}>{t('recovery.discard')}</button>}
    <button type="button" className={css.secondary} disabled={busy} onClick={close}>{t('collaboration.form.cancel')}</button>
    {state.kind==='ready'&&<button type="submit" className={css.primary} disabled={busy}>{t(busy?'group.resume.resuming':'group.resume.confirm')}</button>}
    {state.kind==='pending'&&<button type="button" className={css.primary} disabled={busy} onClick={()=>void recover()}>{t(busy?'group.resume.checking':'group.resume.check')}</button>}
   </footer>
  </form>
 </ContextDrawer>
}
