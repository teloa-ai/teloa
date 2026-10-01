import {useState} from 'react'
import type {SecurityAction,SecurityActionPanel} from '@teloa/contract'
import type {SecurityActionApi,SecurityActionAttention,SecurityActionCommand,SecurityActionContext} from './security-action-api.js'
import {approveAndExecute,securityDecisionStage,securityJournalLocks,type SecurityDecisionOutcome,type SecurityDecisionSnapshot} from './attention-decision.js'
import {SecurityDecisionForm} from './SecurityDecisionForm.js'
import {SecurityExecutionGate} from './SecurityExecutionGate.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './AttentionDecisionCard.module.css'

type Props={
 action:SecurityAction;panel:SecurityActionPanel;context:SecurityActionContext
 attention:readonly SecurityActionAttention[];known:boolean;api:SecurityActionApi
 panelError:string|undefined;reload:()=>Promise<SecurityDecisionSnapshot|null>
 /** 三拍终态与错误由外壳持有；卡片只显示，卸载重挂后仍然看得见。 */
 outcome:SecurityDecisionOutcome|undefined;setOutcome:(next:SecurityDecisionOutcome)=>void
 /**
  * 决策卡内已经用 attentionNextStepKey 写过同一句"下一步"（AttentionDecisionCard 的下一步行），
  * 这里的过期/待核对提示会与它重复。任务详情面板没有那一行，默认 true 原样显示；
  * 卡内装配（WorkbenchFrame）传 false 免得同一句话在同一张卡里出现两次。
  */
 nextStep?:boolean
}

// 卡内只会写这五条命令，journal 也只可能卡在这五条上。
const cardCommands=['decide','execute','withdraw-approval','observe','acknowledge-failure'] as const
const commandKey=(kind:SecurityActionCommand)=>('security.command.'+kind) as 'security.command.decide'

/** 面板没拉到时卡片不装作什么都好：把错误摆出来，给一个重试。 */
export function SecurityPanelFallback({error,retry}:{error:string|undefined;retry:()=>Promise<void>}){
 const {locale,t}=useI18n()
 const [busy,setBusy]=useState(false),[failure,setFailure]=useState<string>()
 return <div className={css.decision}>
  <p role={error===undefined&&failure===undefined?'status':'alert'}>{failure??error??t('security.unverified')}</p>
  <div className={css.actions}>
   <button type="button" disabled={busy} onClick={()=>void(async()=>{
    if(busy)return
    setBusy(true);setFailure(undefined)
    try{await retry()}catch(cause){setFailure(localizeWorkError(locale,cause))}finally{setBusy(false)}
   })()}>{t('common.retry')}</button>
  </div>
 </div>
}

/**
 * 卡内审批：影响确认 + 审核意见必填，不弹“确定吗”。低中风险可逆的一个按钮里做完
 * decide → 重载 → execute；高风险或不可逆的停在“已批准 · 待执行”，第二段才执行。
 * 写之前先看 journal：同任务有未决的写就只给“恢复”，不另造 requestId 去撞 conflict。
 */
export function SecurityDecisionActions({action,panel,context,attention,known,api,panelError,reload,outcome,setOutcome,nextStep=true}:Props){
 const {locale,t}=useI18n()
 const [busy,setBusy]=useState(false)
 const [discardedCommands,setDiscardedCommands]=useState<SecurityActionCommand[]>([])
 // 审核意见按本人、动作和版本保留在会话内；影响确认只留当前表单，重新打开必须再核对。
 // 已经落地的事实（已批准待执行、写失败的原因）一律由外壳持有。
 const awaitingExecute=outcome?.awaitingExecute===true,error=outcome?.error
 const stage=securityDecisionStage(action,panel,attention,known)
 // journal 锁语义与任务详情面板同出一处；面板副本最近一次重载失败（panelError）就当作未核对，一律不许写。
 const {pendingKinds,brokenKinds,locked}=securityJournalLocks(api,cardCommands,panel.taskId,{busy,verified:panelError===undefined})
 const run=async(work:()=>Promise<unknown>,reloadAfter=true)=>{
  if(busy)return
  setBusy(true);setOutcome({awaitingExecute})
  try{await work();if(reloadAfter)await reload()}
  catch(cause){setOutcome({awaitingExecute,error:localizeWorkError(locale,cause)});await reload().catch(()=>{})}
  finally{setBusy(false)}
 }
 const request=()=>({requestId:crypto.randomUUID(),actionId:action.id,expectedActionVersion:action.version})
 const journal=<>
  {/* 面板副本还在、但最近一次重载失败：旧阶段可能已经不成立，必须当面说出来。 */}
  {panelError!==undefined&&<>
   <p role="alert">{panelError}</p>
   <div className={css.actions}><button type="button" disabled={busy} onClick={()=>void run(async()=>{})}>{t('common.retry')}</button></div>
  </>}
  {brokenKinds.map(kind=><p role="alert" key={kind}>{t(commandKey(kind))}: {localizeWorkError(locale,api.recoveryError(kind))} {t('recovery.nextStep')} <button type="button" onClick={()=>{api.discardRecovery(kind);setDiscardedCommands(current=>[...current,kind])}}>{t('recovery.discard')}</button></p>)}
  {discardedCommands.length>0&&<p role="status">{t('recovery.discarded')}</p>}
  {pendingKinds.length>0&&<>
   <p role="status">{t('security.pending')}</p>
   <div className={css.actions}>{pendingKinds.map(kind=>{
    const savedTaskId=api.pending(kind)!.context.panel.taskId
    // 未决的写可能属于别的任务，恢复后要把那条任务的面板也重新核对一遍。
    return <button key={kind} type="button" disabled={busy} onClick={()=>void run(async()=>{await api.recover(kind);if(savedTaskId!==panel.taskId)await api.list(savedTaskId)})}>{t('security.recover')} · {t(commandKey(kind))} · {savedTaskId}</button>
   })}</div>
  </>}
 </>
 if(stage.stage==='wait')return <div className={css.decision}>
  {journal}
  {error!==undefined&&<p role="alert">{error}</p>}
  <p role="status">{t(awaitingExecute?'attention.security.approvedPending':'attention.security.wait')}</p>
 </div>
 return <div className={css.decision}>
  {journal}
  {error!==undefined&&<p role="alert">{error}</p>}
  {stage.stage==='decide'&&<>
   {awaitingExecute&&<p role="status">{t('attention.security.approvedPending')}</p>}
   <SecurityDecisionForm key={action.id+':'+action.version} draftKey={JSON.stringify([action.ownerId,action.id,action.version])} combined={stage.combined} locked={locked('decide')} classes={{form:css.decision,check:css.check,actions:css.actions}}
    approve={reason=>void run(async()=>{
     if(!stage.combined){await api.decide({...request(),decision:'approved',reason,impactConfirmed:true},context);return}
     // 三拍串在 approveAndExecute 里，卡片被筛走或收起都不影响它把 execute 发出去。
     setOutcome({awaitingExecute:await approveAndExecute({action,panel,context,attention,known},api,reason,reload,()=>crypto.randomUUID())==='approved'})
    },!stage.combined)}
    reject={reason=>void run(()=>api.decide({...request(),decision:'rejected',reason,impactConfirmed:false},context))}/>
  </>}
  {(stage.stage==='expired'||stage.stage==='approved')&&<>
   {(stage.stage==='approved'||nextStep)&&<p role="status">{t(stage.stage==='approved'?'attention.security.approvedPending':'security.expired.nextStep')}</p>}
   {stage.canWithdraw&&<div className={css.actions}>
    <button type="button" disabled={locked('withdraw-approval')} onClick={()=>void run(()=>api.withdrawApproval(request(),context))}>{t('security.withdraw')}</button>
   </div>}
  </>}
  {stage.stage==='execute'&&<>
   <p role="status">{t('attention.security.approvedPending')}</p>
   <SecurityExecutionGate action={action} panel={panel} stage={stage} classes={{checks:css.checks,actions:css.actions}} locked={locked('execute')} execute={()=>void run(()=>api.execute(request(),context))}/>
   {stage.canWithdraw&&<div className={css.actions}>
    <button type="button" disabled={locked('withdraw-approval')} onClick={()=>void run(()=>api.withdrawApproval(request(),context))}>{t('security.withdraw')}</button>
   </div>}
  </>}
  {stage.stage==='observe'&&<>
   {nextStep&&<p role="status">{t('attention.next.observePending')}</p>}
   <div className={css.actions}>
    <button type="button" disabled={locked('observe')} onClick={()=>void run(()=>api.observe({requestId:crypto.randomUUID(),operationId:stage.operationId,expectedRevision:stage.expectedRevision},context))}>{t('attention.security.observe')}</button>
   </div>
  </>}
  {stage.stage==='acknowledge'&&<div className={css.actions}>
   <button type="button" disabled={locked('acknowledge-failure')} onClick={()=>void run(()=>api.acknowledgeFailure({requestId:crypto.randomUUID(),actionId:action.id,expectedActionVersion:action.version},context))}>{t('attention.security.acknowledge')}</button>
  </div>}
 </div>
}
