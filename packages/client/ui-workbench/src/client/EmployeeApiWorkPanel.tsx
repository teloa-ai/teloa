import {useEffect,useRef,useState} from 'react'
import type {EmployeeApiWorkApi,EmployeeWorkView} from './employee-api-work-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'

type Props={taskId:string;api:EmployeeApiWorkApi;open:(sessionId:string)=>Promise<void>;openTask:(taskId:string)=>void}
/** 每个任务有独立的输入和操作代次，旧任务迟到的回包不能写入新任务。 */
export function EmployeeApiWorkPanel(props:Props){return <EmployeeApiWorkPanelContent key={props.taskId} {...props}/>}
function EmployeeApiWorkPanelContent({taskId,api,open,openTask}:Props){
 const {locale}=useI18n(),c=(cn:string,en:string)=>locale.startsWith('zh')?cn:en
 const [loaded,setLoaded]=useState<{api:EmployeeApiWorkApi;view:EmployeeWorkView|null}>(),[failure,setFailure]=useState<{api:EmployeeApiWorkApi;kind:'read'|'action';cause?:unknown}>(),[text,setText]=useState(''),[busy,setBusy]=useState(false)
 const [,changed]=useState(0)
 const generation=useRef(0),locked=useRef(false),latest=useRef(api);latest.current=api
 const actionError=(cause:unknown)=>{
  const code=cause&&typeof cause==='object'&&'code'in cause?cause.code:undefined,details=cause&&typeof cause==='object'&&'details'in cause?cause.details:undefined,reason=details&&typeof details==='object'&&'reason'in details?details.reason:undefined
  if(code==='teloa/dependency-unavailable'&&reason==='employee-api-model-unavailable')return c('原工作使用的模型或模型认证暂不可用。请核对模型设置后，点击「核对上次续办」恢复同一请求。','The original model or its credentials are unavailable. Check model settings, then recover the previous submission using the same request.')
  if(code==='teloa/dependency-unavailable'&&reason==='employee-api-permission-mode-unavailable')return c('原工作使用的执行权限档位暂不可用。请核对宿主配置后恢复同一续办请求。','The original permission mode is unavailable. Check the host configuration, then recover the same follow-up request.')
  if(code==='teloa/conflict'&&reason==='employee-api-work-busy')return c('原工作仍在执行，请刷新并等待本轮结束后再续办。','The original work is still running. Refresh and wait for this round to end before continuing.')
  if(code==='teloa/conflict'&&reason==='employee-api-concurrency-limit')return c('原集成已达到并发额度，请等待已有工作结束后再续办。','The integration has reached its concurrency limit. Wait for existing work to end before continuing.')
  return localizeWorkError(locale,cause)
 }
 const view=loaded?.api===api?loaded.view:undefined,error=failure?.api===api?(failure.kind==='read'?c('暂时无法核对原 API 工作，请刷新重试。','Unable to check the original API work. Refresh to retry.'):actionError(failure.cause)):undefined
 useEffect(()=>{const current=++generation.current;locked.current=false;setBusy(false);setText('');setLoaded(undefined);setFailure(undefined);void api.read(taskId).then(row=>{if(current===generation.current)setLoaded({api,view:row})},()=>{if(current===generation.current)setFailure({api,kind:'read'})});return()=>{generation.current++}},[api,taskId])
 useEffect(()=>{if(typeof api.subscribe!=='function')return;const unsubscribe=api.subscribe(()=>changed(value=>value+1));return()=>{if(typeof unsubscribe==='function')unsubscribe()}},[api])
 const act=async(fn:(current:()=>boolean)=>Promise<void>)=>{if(locked.current)return;const token=generation.current,current=()=>token===generation.current&&latest.current===api;locked.current=true;setBusy(true);setFailure(undefined);try{await fn(current)}catch(cause){if(current())setFailure({api,kind:'action',cause})}finally{if(current()){locked.current=false;setBusy(false)}}}
 const refresh=()=>act(async current=>{const row=await api.read(taskId);if(current())setLoaded({api,view:row})})
 const pending=api.pending(),ownsPending=pending?.taskId===taskId
 if(view===null&&!ownsPending&&!api.fault())return null
 const states={queued:c('排队中','Queued'),running:c('执行中','Running'),waiting:c('等待条件或审批','Waiting for a condition or approval'),succeeded:c('已交付','Delivered'),failed:c('执行失败','Failed'),cancel_requested:c('正在停止','Stopping'),cancelled:c('已停止','Stopped')}
 const reasons:Record<string,string>={execution_tools_required:c('员工没有可用的执行工具。请在员工权限中保存所需工具，恢复在岗并重新授权后继续。','The employee needs execution tools. Save the required employee permissions, activate the employee and renew the integration grant before continuing.'),execution_forbidden:c('员工执行权限或业务范围未通过核对。请检查员工、业务和执行委托。','Employee execution or business access was denied. Check the employee, business scope and delegation.'),execution_configuration_changed:c('员工配置已变化。请核对最新配置并重新授权。','Employee configuration changed. Review it and renew the integration grant.'),execution_paused:c('本轮执行已暂停，或宿主重启后正在保护原运行。请打开本轮原会话，核对运行状态并按页面指引恢复；不要重复创建工作或提交新轮次。','This round is paused or protected after a host restart. Open this round’s original conversation, review its run and resume as instructed there. Do not create duplicate work or submit a new round.'),dispatch_unavailable:c('宿主暂时无法派发，正在按原请求重试；请核对模型、连接与宿主状态。不要重复创建。','Dispatch is temporarily unavailable. The same request will retry. Check model, connection and host readiness; do not create duplicate work.')}
 return <section className={css.block} aria-label={c('原 API 工作','Original API work')}>
  <h3>{c('原 API 工作','Original API work')}</h3>
  {error&&<p role="alert">{error}</p>}
  {view?<><p role="status">{view.work.title} · {c('第','Round ')}{view.work.round}{c('轮','')} · {states[view.work.state]}</p>{view.work.error&&<p role="status">{reasons[view.work.error]??c('本轮条件未满足，请核对运行记录与配置后重试。','This round needs attention. Review its run records and configuration.')}</p>}
   <p>{c('从这里继续同一个 API 工作，保留历轮任务和成果；每轮使用独立执行会话。运行中的原会话用于核对轨迹，后续轮次仍需通过原工作受理。','Continue the same API work and retain earlier tasks and results. Each round has a dedicated execution conversation; submit follow-up input through the original work.')}</p>
   <div className={css.buttons}><button type="button" disabled={busy} onClick={()=>void refresh()}>{c('刷新原工作','Refresh work')}</button>{view.sessionId&&<button type="button" disabled={busy} onClick={()=>void act(()=>open(view.sessionId!))}>{c('打开本轮原会话','Open this round’s conversation')}</button>}{view.currentTaskId!==taskId&&<button type="button" onClick={()=>openTask(view.currentTaskId)}>{c('打开最新轮次任务','Open latest round task')}</button>}</div>
   {view.canContinue&&!pending&&!api.fault()&&<form className={css.form} onSubmit={event=>{event.preventDefault();if(!text.trim())return;void act(async current=>{const next=await api.continue(view,text);if(current()){setLoaded({api,view:next});setText('')}})}}><label>{c('继续原工作','Continue original work')}<textarea rows={3} maxLength={6000} required disabled={busy} value={text} onChange={event=>setText(event.target.value)}/></label><button type="submit" disabled={busy||!text.trim()}>{busy?c('正在受理…','Submitting…'):c('提交后续轮次','Submit follow-up round')}</button></form>}
   {!view.canContinue&&['succeeded','failed','cancelled'].includes(view.work.state)&&<p>{c('原集成已失效或没有续办权限，请在员工对外调用中核对授权。','The original integration is inactive or lacks permission to continue. Review its employee integration grant.')}</p>}
  </>:view===undefined&&!error&&<p role="status">{c('正在核对原 API 工作…','Checking original API work…')}</p>}
  {ownsPending&&pending&&<><p role="status">{busy?c('正在核对原工作请求；原输入已保留，请稍候。','Checking the original work request. Your input is preserved; please wait.'):c('上次续办的结果待核对。保留原输入，按同一请求恢复，不会重复创建。','The previous submission needs reconciliation. Recover the same request to avoid duplicate work.')}</p><label>{c('上次续办输入','Previous follow-up input')}<textarea readOnly rows={3} value={pending.input}/></label><button type="button" disabled={busy} onClick={()=>void act(async current=>{const next=await api.recover();if(current()){setLoaded({api,view:next});setText('')}})}>{c('核对上次续办','Recover previous submission')}</button></>}
  {pending&&!ownsPending&&<><p role="status">{c('另一项 API 工作的续办结果待核对，请先打开原任务恢复同一请求。','Another API work has an unresolved submission. Open its task to recover the same request first.')}</p><button type="button" disabled={busy} onClick={()=>openTask(pending.taskId)}>{c('打开待核对的原任务','Open task with pending submission')}</button></>}
  {api.fault()&&<p role="alert">{c('续办恢复记录无法读取。请保留现场并核对原工作，暂不创建新轮次。','The recovery record is unreadable. Review the original work before submitting another round.')}</p>}
  {error&&!view&&<button type="button" disabled={busy} onClick={()=>void refresh()}>{c('重试读取','Retry')}</button>}
 </section>
}
