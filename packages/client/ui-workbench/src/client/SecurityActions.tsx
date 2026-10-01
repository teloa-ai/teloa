import {useEffect,useRef,useState} from 'react'
import type {SecurityAction,SecurityActionPanel} from '@teloa/contract'
import type {BusinessTaskApi} from './business-task-api.js'
import {securityActionCommands,type SecurityActionApi,type SecurityActionAttention,type SecurityActionCommand} from './security-action-api.js'
import {securityActionControls,securityExecutionPresentation} from './security-action-presentation.js'
import {securityDecisionStage,securityJournalLocks} from './attention-decision.js'
import {SecurityDecisionForm} from './SecurityDecisionForm.js'
import {SecurityExecutionGate} from './SecurityExecutionGate.js'
import {EvidenceList} from './EvidenceList.js'
import {securityActionEvidence} from './security-action-evidence.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './SecurityActions.module.css'

type Decision={decision:'approved'|'rejected';reason:string;impactConfirmed:boolean}
type CardProps={action:SecurityAction;panel:SecurityActionPanel;attention:readonly SecurityActionAttention[];known:boolean;busy:boolean;disabled:boolean;disabledCommands?:readonly SecurityActionCommand[];focus?:number|undefined;run:(kind:Exclude<SecurityActionCommand,'propose'>,action:SecurityAction,decision?:Decision)=>Promise<void>;repropose:(action:SecurityAction)=>void}
export function SecurityActionCard({action,panel,attention,known,busy,disabled,disabledCommands=[],focus,run,repropose}:CardProps){
 const {t,dateTime}=useI18n(),details=useRef<HTMLDetailsElement>(null)
 useEffect(()=>{if(focus!==undefined&&details.current){details.current.open=true;details.current.querySelector('summary')?.focus();details.current.scrollIntoView({block:'nearest'})}},[focus])
 const controls=securityActionControls(action,panel,attention,known),execution=panel.executions.find(e=>e.actionId===action.id),locked=(kind:SecurityActionCommand)=>busy||disabled||disabledCommands.includes(kind)
 // 执行段与需要你决策卡同一扇门：三行核对 + 不可逆逐字抄目标名。面板不再自己摆一个只判锁的“执行”。
 const stage=securityDecisionStage(action,panel,attention,known)
 return <details ref={details} className={css.action} data-security-action-id={action.id} open={action.state==='pending_approval'}>
  <summary><strong>{action.title}</strong><span>{t('security.action.'+action.state)}</span></summary>
  {/* goal、派发参数、审批意见与两张回执一律只由下面的依据区承担：它们本就是“要逐字核对的事实”，
      在面板里再抄一遍只会让人分不清哪份是准的。这里只留依据区不表达的结构化字段。 */}
  <dl className={css.facts}>
   <div><dt>{t('security.targets')}</dt><dd>{action.targetSet.join(', ')}</dd></div>
   <div><dt>{t('security.frozen')}</dt><dd>{action.tool} · {t('security.risk.'+action.riskTier)} · {t('security.reversible.'+action.reversible)} · {action.playbookVersion}</dd></div>
   <div><dt>{t('task.detail.version',{version:action.version})}</dt><dd>{action.id} · {action.proposerId} · {dateTime(action.updatedAt)}</dd></div>
  </dl>
  {action.frozen?<details><summary>{t('security.frozen')}</summary><dl className={css.facts}>{Object.entries(action.frozen).map(([key,value])=><div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl></details>:<p className={css.muted}>{t('security.unfrozen')}</p>}
  <EvidenceList compact entries={securityActionEvidence(action,panel,{receiptTitle:kind=>t(kind==='acceptance'?'security.acceptance':'security.effect'),approvalTitle:decision=>t(decision==='approved'?'evidence.approvalApproved':'evidence.approvalRejected'),targetState:state=>t('security.target.'+state),goalTitle:t('evidence.actionGoal'),dispatchTitle:t('evidence.dispatch'),dispatchSource:dispatched=>t(dispatched?'evidence.dispatchExecutor':'evidence.dispatchProposal')})}/>
  {execution&&<div className={css.receipt}><strong>{t(securityExecutionPresentation(execution).status)}</strong><p>{execution.operationId} · v{execution.revision}</p></div>}
  {controls.decide&&<SecurityDecisionForm key={action.id+':'+action.version} draftKey={JSON.stringify([action.ownerId,action.id,action.version])} combined={false} locked={locked('decide')} classes={{form:css.form,check:css.check,actions:css.buttons}}
   approve={reason=>void run('decide',action,{decision:'approved',reason,impactConfirmed:true})}
   reject={reason=>void run('decide',action,{decision:'rejected',reason,impactConfirmed:false})}/>}
  {stage.stage==='execute'&&<SecurityExecutionGate action={action} panel={panel} stage={stage} classes={{checks:css.facts,actions:css.buttons}} locked={locked('execute')} execute={()=>void run('execute',action)}/>}
  <div className={css.buttons}>
   {controls.submit&&<button type="button" disabled={locked('submit')} onClick={()=>void run('submit',action)}>{t('security.submit')}</button>}
   {controls.withdrawSubmission&&<button type="button" disabled={locked('withdraw-submission')} onClick={()=>void run('withdraw-submission',action)}>{t('security.withdraw')}</button>}
   {controls.withdrawApproval&&<button type="button" disabled={locked('withdraw-approval')} onClick={()=>void run('withdraw-approval',action)}>{t('security.withdraw')}</button>}
   {controls.observe&&<button type="button" disabled={locked('observe')} onClick={()=>void run('observe',action)}>{t('security.observe')}</button>}
   {controls.acknowledge&&<button type="button" disabled={locked('acknowledge-failure')} onClick={()=>void run('acknowledge-failure',action)}>{t('security.acknowledge')}</button>}
   {controls.repropose&&<button type="button" disabled={locked('propose')} onClick={()=>repropose(action)}>{t('security.repropose')}</button>}
  </div>
 </details>
}
type Props={taskId:string;taskVersion:number;api:SecurityActionApi;sourceApi:BusinessTaskApi;attention:readonly SecurityActionAttention[];attentionKnown:boolean;focus?:{actionId:string;revision:number}|undefined;invalidateAttention:()=>void;changed:()=>Promise<void>}
export function SecurityActions({taskId,taskVersion,api,sourceApi,attention,attentionKnown,focus,invalidateAttention,changed}:Props){
 const {locale,t}=useI18n(),[panel,setPanel]=useState<SecurityActionPanel>(),[source,setSource]=useState<Awaited<ReturnType<BusinessTaskApi['source']>>>(),[verified,setVerified]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),lock=useRef(false),generation=useRef(0)
 const [title,setTitle]=useState(''),[goal,setGoal]=useState(''),[reason,setReason]=useState(''),[targets,setTargets]=useState<string[]>([]),[supersedes,setSupersedes]=useState<string>(),form=useRef<HTMLFormElement>(null),proposal=useRef<HTMLDetailsElement>(null)
 const [discardedCommands,setDiscardedCommands]=useState<SecurityActionCommand[]>([])
 const load=async(signal?:AbortSignal)=>{
  const version=++generation.current;setVerified(false)
  try{
   const origin=await sourceApi.source(taskId)
   if(version!==generation.current||signal?.aborted)return
   setSource(origin)
   if(!origin){setPanel(undefined);return}
   const next=await api.list(taskId,signal)
   if(version!==generation.current||signal?.aborted)return
   if(next.actions.some(action=>action.frozen!==null&&action.frozen.objectSnapshotHash!==origin.reference.snapshotHash))throw Object.assign(Error('来源摘要不一致。'),{code:'teloa/invalid-host-response'})
   setPanel(next);setVerified(true);setError(undefined)
  }catch(cause){if(version===generation.current&&!signal?.aborted){setVerified(false);setError(localizeWorkError(locale,cause))}throw cause}
 }
 useEffect(()=>{const abort=new AbortController();void load(abort.signal).catch(()=>{});return()=>{generation.current++;abort.abort()}},[taskId,taskVersion,api,sourceApi,locale])
 const act=async(work:()=>Promise<unknown>,affectedTaskId=taskId)=>{
  if(lock.current)return
  lock.current=true;setBusy(true);setError(undefined);setVerified(false);generation.current++;invalidateAttention()
  let failure:unknown
  try{await work()}catch(cause){failure=cause}
  // 写回执从不直接覆盖较新面板；成功、拒绝与未知结果都重新核对服务端事实。
  try{await Promise.all([load(),changed()])}catch(cause){failure??=cause}
  if(failure){if(affectedTaskId===taskId)setVerified(false);setError(localizeWorkError(locale,failure))}
  lock.current=false;setBusy(false)
 }
 const run=async(kind:Exclude<SecurityActionCommand,'propose'>,action:SecurityAction,decision?:Decision)=>{
  if(!panel||!source)return
  const context={panel,taskVersion,source:{taskId:source.taskId,ownerId:source.ownerId,sourceId:source.sourceId,reference:source.reference}},request={requestId:crypto.randomUUID(),actionId:action.id,expectedActionVersion:action.version}
  await act(()=>{
   if(kind==='decide')return api.decide({...request,...decision!},context)
   if(kind==='observe'){const execution=panel.executions.find(e=>e.actionId===action.id)!;return api.observe({requestId:request.requestId,operationId:execution.operationId,expectedRevision:execution.revision},context)}
   if(kind==='withdraw-submission')return api.withdrawSubmission(request,context)
   if(kind==='withdraw-approval')return api.withdrawApproval(request,context)
   if(kind==='acknowledge-failure')return api.acknowledgeFailure(request,context)
   return api[kind](request,context)
  })
 }
 if(source===null&&!error)return null
 // journal 锁语义与需要你决策卡同出一处：同任务的未决写保留因果保护，其它任务只占用它原来的命令 journal。
 const locks=securityJournalLocks(api,securityActionCommands,taskId,{busy,verified})
 const pending=locks.pendingKinds,broken=locks.brokenKinds,blocked=locks.blocked,disabledCommands=locks.disabledCommands,proposalBlocked=locks.locked('propose')
 const allowed=panel?.proposal.tools.find(tool=>tool.tool==='security.endpoint.isolate')?.allowedTargets??[]
 const validReason=reason.trim().length>0&&reason.trim().length<=1000&&!/[\x00-\x1f\x7f]/.test(reason)
 return <section className={css.root} aria-label={t('security.title')}>
  <header><h3>{t('security.title')}</h3><button type="button" disabled={busy} onClick={()=>void act(async()=>{})}>{t('taskExecution.refresh')}</button></header>
  {source&&<p className={css.muted}>{source.reference.type} · {source.reference.id} · v{source.reference.version} · {source.reference.snapshotHash}</p>}
  {(!verified||!attentionKnown)&&<p role="status">{t('security.unverified')}</p>}
  {error&&<p role="alert">{error}</p>}{broken.map(kind=><p role="alert" key={kind}>{t('security.command.'+kind)}: {localizeWorkError(locale,api.recoveryError(kind))} {t('recovery.nextStep')} <button type="button" onClick={()=>{api.discardRecovery(kind);setDiscardedCommands(current=>[...current,kind])}}>{t('recovery.discard')}</button></p>)}
  {discardedCommands.length>0&&<p role="status">{t('recovery.discarded')}</p>}
  {pending.length>0&&<p role="status">{t('security.pending')}</p>}
  <div className={css.buttons}>{pending.map(kind=>{const saved=api.pending(kind)!;return <button key={kind} type="button" disabled={busy} onClick={()=>void act(async()=>{await api.recover(kind);if(saved.context.panel.taskId!==taskId)await api.list(saved.context.panel.taskId)},saved.context.panel.taskId)}>{t('security.recover')} · {t('security.command.'+kind)} · {saved.context.panel.taskId}</button>})}</div>
  {panel&&<>
   {!panel.actions.length&&<p className={css.muted}>{t('security.empty')}</p>}
   {panel.actions.map(action=><SecurityActionCard key={action.id} action={action} panel={panel} attention={attention} known={verified&&attentionKnown} busy={busy} disabled={blocked} disabledCommands={disabledCommands} focus={focus?.actionId===action.id?focus.revision:undefined} run={run} repropose={action=>{if(proposal.current)proposal.current.open=true;setSupersedes(action.id);setTitle(action.title);setGoal(action.goal);setReason(String(action.params.reason??''));setTargets(action.targetSet.filter(v=>allowed.includes(v)));form.current?.querySelector('input')?.focus();form.current?.scrollIntoView({block:'nearest'})}}/>)}
   {allowed.length>0&&<details ref={proposal}><summary>{t('security.propose')}</summary><form ref={form} className={css.form} onSubmit={event=>{event.preventDefault();if(proposalBlocked||!source||!validReason||!targets.length)return;void act(async()=>{await api.propose({requestId:crypto.randomUUID(),taskId,expectedTaskVersion:taskVersion,title:title.trim(),goal:goal.trim(),tool:'security.endpoint.isolate',targetSet:targets,params:{reason:reason.trim()},...(supersedes?{supersedesActionId:supersedes}:{})},{panel,taskVersion,source:{taskId:source.taskId,ownerId:source.ownerId,sourceId:source.sourceId,reference:source.reference}});setTitle('');setGoal('');setReason('');setTargets([]);setSupersedes(undefined)})}}>
    <h4>{t(supersedes?'security.repropose':'security.propose')}</h4>
    <label>{t('task.form.title')}<input required maxLength={120} value={title} onChange={event=>setTitle(event.target.value)}/></label>
    <label>{t('task.form.goalScope')}<textarea required maxLength={8000} value={goal} onChange={event=>setGoal(event.target.value)}/></label>
    <fieldset disabled={proposalBlocked}><legend>{t('security.targets')}</legend>{allowed.map(target=><label key={target} className={css.check}><input type="checkbox" checked={targets.includes(target)} onChange={event=>setTargets(current=>event.target.checked?[...current,target]:current.filter(v=>v!==target))}/>{target}</label>)}</fieldset>
    <label>{t('security.reason')}<textarea required maxLength={1000} value={reason} onChange={event=>setReason(event.target.value)}/></label>
    <button type="submit" disabled={proposalBlocked||!title.trim()||!goal.trim()||!validReason||!targets.length}>{t('security.propose')}</button>
   </form></details>}
  </>}
 </section>
}
