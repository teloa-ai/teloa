import {ToolbarIconButton} from './ToolbarIconButton.js'
import {TaskRunModels} from './TaskRunModels.js'
import {TaskRunFlowSetup} from './TaskRunFlowSetup.js'
import {taskRunOriginCopy,requiresOriginalTaskRequest} from './task-run-origin-copy.js'
import type {TaskRunOrigin} from '@teloa/contract'
import type {TaskRunFlow} from '@teloa/contract'
import {useCallback,useContext,useEffect,useRef,useState} from 'react'
import {ArrowUpRight,RefreshCw} from 'lucide-react'
import type {TaskRunApi,RunView} from './task-run-api.js'
import type {WorkControlApi} from './work-control-api.js'
import type {WorkControl,RecoveryCandidate} from '@teloa/contract'
import type {PlanWorkMessageKey} from './i18n/locales/plan-work.js'
import {TaskRunPreparationContext} from './task-run-preparation-context.js'
import {scheduleTaskRunRefresh} from './task-run-refresh.js'
import {taskRunContextSections} from './task-run-context-presentation.js'
import {taskRunControls,taskRunStopWaitSeconds,taskRunPhaseKeys,taskRunReasonKeys,taskRunTone} from './task-run-presentation.js'
import {taskRunFlowPresentation} from './task-run-flow-presentation.js'
import {taskRunSubagentPresentation} from './task-run-subagent-presentation.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'
import {StatusPill,type StatusPillTone} from './StatusPill.js'
import detail from './TaskExecutions.module.css'
import {isWorkspaceFileRule} from '@teloa/contract'

export {taskRunPhaseKeys,taskRunReasonKeys} from './task-run-presentation.js'
const phases=taskRunPhaseKeys,reasons=taskRunReasonKeys
/** 编排步骤与子代理状态键 → 胶囊语气；等你核对或触发才算阻塞（warn），失败才用红。 */
const stepTones:Readonly<Record<string,StatusPillTone>>={
 'taskExecution.flow.step.blocked':'warn','taskExecution.flow.step.trigger':'warn','taskExecution.flow.step.waiting':'warn','taskExecution.flow.step.ready':'neutral','taskExecution.flow.step.running':'info',
 'taskExecution.flow.step.succeeded':'good','taskExecution.flow.step.failed':'danger','taskExecution.flow.step.cancelled':'muted','taskExecution.flow.step.compensated':'muted',
 'subagent.run.state.reserved':'neutral','subagent.run.state.started':'info','subagent.run.state.ended':'muted','subagent.run.state.abandoned':'muted',
}
const terminal=(state:RunView['state'])=>['ended','withdrawn','configuration_failed'].includes(state)
const configurationStages={'model-resolve':'taskExecution.stage.resolve','preset-resolve':'taskExecution.stage.resolve','session-create':'taskExecution.stage.create','session-receipt':'taskExecution.stage.receipt','session-inspect':'taskExecution.stage.inspect'} as const

function TaskRunFlowDetails({run,api}:{run:RunView;api:TaskRunApi}){
 const {locale,t}=useI18n()
 const [view,setView]=useState<ReturnType<typeof taskRunFlowPresentation>>(),[loading,setLoading]=useState(false),[error,setError]=useState<string>()
 const [flow,setFlow]=useState<TaskRunFlow>()
 const load=()=>{if(loading)return;setLoading(true);setError(undefined);api.flow(run).then(flow=>{if(flow){setFlow(flow);setView(taskRunFlowPresentation(flow))}},reason=>setError(localizeWorkError(locale,reason))).finally(()=>setLoading(false))}
 return <details onToggle={event=>{if(event.currentTarget.open&&!view&&!error)load()}}><summary>{t('taskExecution.flow.open')}</summary>
  {loading&&<small role="status">{t('taskExecution.flow.loading')}</small>}{error&&<p role="alert">{error}</p>}
  {view&&<section className={css.runContext} aria-label={t('taskExecution.flow.aria')}><header className={css.detailHeader}><strong>{t(view.stateKey)}</strong><span>{t('taskExecution.flow.definition',{version:view.definitionVersion})}</span><span>{t('taskExecution.flow.progress',{completed:view.completed,total:view.total})}</span><ToolbarIconButton label={t('taskExecution.flow.refresh')} icon={RefreshCw} disabled={loading} onClick={load}/></header><ol className={css.history}>{view.steps.map(step=><li key={step.id}><div className={css.detailHeader}><strong>{step.title}</strong><StatusPill tone={stepTones[step.stateKey]??'neutral'}>{t(step.stateKey)}</StatusPill><small>{t('taskExecution.flow.attempts',{kind:t(step.kindKey),count:step.attempts})}</small></div>{step.dependencies.length>0&&<small>{t('taskExecution.flow.dependencies',{items:step.dependencies.join(', ')})}</small>}<p>{step.inputSummary}</p>{step.outputSummary&&<p>{t('taskExecution.flow.output',{output:step.outputSummary})}</p>}{step.waitReason&&<p><strong>{t('taskExecution.flow.waitReason')}</strong>{step.waitReason}</p>}</li>)}</ol></section>}
  {flow&&!terminal(run.state)&&<TaskRunFlowSetup runId={run.id} api={api.flowRequests} flow={flow} changed={load}/>}
 </details>
}

type RunControl={kind:'active'}|{kind:'loading'}|{kind:'blocked';hint:PlanWorkMessageKey;error?:string}|{kind:'paused';control:WorkControl;candidates:RecoveryCandidate[]}
const loadingControl:RunControl={kind:'loading'}
/** 仅核对原本轮控制及完整候选；展示读取不恢复、不启动、不修改冻结谱系。 */
async function readRunControl(api:WorkControlApi,run:RunView):Promise<RunControl>{
 const lineage=run.lineage
 if(!lineage)return {kind:'blocked',hint:'planWork.runRecovery.changed'}
 const control=await api.get(lineage.roundControlId)
 if(control.id!==lineage.roundControlId||control.ownerId!==lineage.ownerId||control.scope!=='round')return {kind:'blocked',hint:'planWork.runRecovery.foreign'}
 if(control.generation<lineage.controlGeneration)return {kind:'blocked',hint:'planWork.runRecovery.changed'}
 if(lineage.definitionControlId){const definition=await api.get(lineage.definitionControlId);if(definition.id!==lineage.definitionControlId||definition.ownerId!==lineage.ownerId||definition.scope!=='definition')return {kind:'blocked',hint:'planWork.runRecovery.foreign'};if(definition.state!=='active')return {kind:'blocked',hint:'planWork.runRecovery.definition'}}
 if(control.pendingRunIds.length||control.unknownOperationIds.length)return {kind:'blocked',hint:'planWork.runRecovery.unknown'}
 if(control.state==='active')return {kind:'active'}
 if(control.state!=='paused')return {kind:'blocked',hint:'planWork.runRecovery.notReady'}
 const candidates=await api.inspect(control.id)
 if(candidates.some(candidate=>candidate.reason==='unknown'))return {kind:'blocked',hint:'planWork.runRecovery.unknown'}
 if(candidates.length!==1)return {kind:'blocked',hint:candidates.length?'planWork.runRecovery.other':'planWork.runRecovery.changed'}
 const candidate=candidates[0]!
 if(candidate.controlId!==control.id||candidate.expectedGeneration!==control.generation||candidate.runId!==run.id||candidate.nativeRequestId!==run.nativeRequestId)return {kind:'blocked',hint:'planWork.runRecovery.changed'}
 if(candidate.reason!=='unaccepted'||run.state!=='prepared')return {kind:'blocked',hint:'planWork.runRecovery.notReady'}
 return {kind:'paused',control,candidates}
}
type TaskExecutionsProps={taskId:string;taskVersion:number;taskState:string;assigned:boolean;changed:()=>void;api:TaskRunApi;controls?:WorkControlApi|undefined;open:(sessionId:string)=>Promise<void>;face?:'timeline';onRuns?:(rows:RunView[],verified:boolean)=>void}
export function TaskExecutions(props:TaskExecutionsProps){
 // 切换任务或版本时保留 API 恢复记录，运行面局部状态按原身份隔离；旧请求不能写入新视图。
 const origin=useRef({api:props.api,controls:props.controls,epoch:0})
 if(origin.current.api!==props.api||origin.current.controls!==props.controls)origin.current={api:props.api,controls:props.controls,epoch:origin.current.epoch+1}
 return <TaskExecutionsPanel key={JSON.stringify([props.taskId,props.taskVersion,origin.current.epoch])} {...props}/>
}
function TaskExecutionsPanel({taskId,taskVersion,taskState,assigned,api,controls,open,changed,face,onRuns}:TaskExecutionsProps){
 const {locale,t,dateTime}=useI18n()
 const publishPreparation=useContext(TaskRunPreparationContext),mounted=useRef(true)
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 const [rows,setRows]=useState<RunView[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>(),lock=useRef(false)
 const [loaded,setLoaded]=useState(false),[origin,setOrigin]=useState<TaskRunOrigin>(),[originError,setOriginError]=useState(false)
 const [controlRevision,setControlRevision]=useState(0),[controlSnapshot,setControlSnapshot]=useState<{rows:RunView[];views:Record<string,RunControl>}>({rows:[],views:{}})
 const refreshControl=useCallback(()=>setControlRevision(value=>value+1),[])
 useEffect(()=>{let live=true;const prepared=rows.filter(row=>row.state==='prepared'&&row.lineage);setControlSnapshot({rows,views:Object.fromEntries(prepared.map(row=>[row.id,loadingControl]))});if(controls)void Promise.all(prepared.map(async row=>{let view:RunControl;try{view=await readRunControl(controls,row)}catch(cause){view={kind:'blocked',hint:'planWork.runRecovery.unavailable',error:localizeWorkError(locale,cause)}}return [row.id,view] as const})).then(views=>{if(live)setControlSnapshot({rows,views:Object.fromEntries(views)})});return()=>{live=false}},[rows,controls,controlRevision,locale])
 const controlFor=(row:RunView):RunControl|undefined=>controls&&row.lineage&&row.state==='prepared'?(controlSnapshot.rows===rows?controlSnapshot.views[row.id]??loadingControl:loadingControl):undefined
 const pendingRecoveryFor=(row:RunView)=>{const pending=controls?.pending();return pending?.kind==='resume'&&row.lineage&&pending.controlId===row.lineage.roundControlId&&pending.candidateRunIds.length===1&&pending.candidateRunIds[0]===row.id?pending:undefined}
 const currentTask=useRef(taskId);currentTask.current=taskId
 const verifiedOrigin=origin?.taskId===taskId?origin:undefined,parentSource=verifiedOrigin?.source
 const refreshOrigin=async()=>{const captured=taskId;try{const value=await api.origin(captured);if(mounted.current&&currentTask.current===captured){setOrigin(value);setOriginError(false)}}catch{if(mounted.current&&currentTask.current===captured){setOrigin(undefined);setOriginError(true)}}}
 const openParent=async()=>{
  if(!parentSource)return
  const captured=taskId,fresh=await api.origin(captured)
  if(!mounted.current||currentTask.current!==captured)return
  const source=fresh.source
  if(!source||source.sessionId!==parentSource.sessionId||source.requestId!==parentSource.requestId||source.messageId!==parentSource.messageId||source.messageSeq!==parentSource.messageSeq){setOrigin(undefined);setOriginError(true);return}
  await open(source.sessionId)
 }

 const acceptRows=(value:RunView[])=>{if(mounted.current){setRows(value);setLoaded(true)}}
 const canPrepare=verifiedOrigin?.source===null&&assigned&&['ready','paused','blocked'].includes(taskState)&&!rows.some(row=>!terminal(row.state))
 // 每次渲染重新取时刻：常规轮询每次发布新快照都会重渲染，「已等待 N 秒」随之推进。
 const now=Date.now()
 const lastProgress=useRef(''),onRunsRef=useRef(onRuns);onRunsRef.current=onRuns
 useEffect(()=>{const signature=rows.map(row=>row.id+':'+row.state).join('|');if(signature!==lastProgress.current){lastProgress.current=signature;changed()}},[rows,changed])
 // 重读中或失败时撤回已确认状态；父级保留最后快照，不能把初始空数组当成从未执行。
 useEffect(()=>{onRunsRef.current?.(rows,loaded&&!busy&&!error)},[rows,loaded,busy,error])
 const act=async(work:()=>Promise<void>)=>{if(lock.current||!mounted.current)return;lock.current=true;setBusy(true);setError(undefined);setNotice(undefined);try{await work()}catch(e){if(mounted.current){if(requiresOriginalTaskRequest(e)){setError(taskRunOriginCopy(locale,'boundary'));await refreshOrigin()}else setError(localizeWorkError(locale,e))}}finally{lock.current=false;if(mounted.current)setBusy(false)}}
 const resumeRun=(row:RunView,expected:Extract<RunControl,{kind:'paused'}>)=>void act(async()=>{
  if(!controls||verifiedOrigin?.source!==null||controls.pending()||controls.recoveryMessage())throw Error(t('planWork.unknown'))
  const fresh=await readRunControl(controls,row)
  // 明确恢复后继续核对原控制并提交；离页只隔离界面更新，不撤回已确认动作。
  if(fresh.kind!=='paused'||fresh.control.version!==expected.control.version||fresh.control.generation!==expected.control.generation||JSON.stringify(fresh.candidates)!==JSON.stringify(expected.candidates)){if(mounted.current){refreshControl();setError(t('planWork.runRecovery.changed'))}return}
  await controls.resume(fresh.control,fresh.candidates.map(candidate=>candidate.runId))
  if(mounted.current){acceptRows(await api.list(taskId));refreshControl()}
 })
 const recoverControl=(row:RunView)=>void act(async()=>{if(!controls||!pendingRecoveryFor(row))throw Error(t('planWork.runRecovery.changed'));await controls.recover();if(mounted.current){acceptRows(await api.list(taskId));refreshControl()}})
 const prepareDisabled=busy||!canPrepare||!!api.pending()||!!api.recoveryMessage()
 const showPrepare=!parentSource&&(canPrepare||!rows.length||!!api.pending()||!!api.recoveryMessage())
 const prepareRef=useRef<()=>void>(()=>{})
 prepareRef.current=()=>{if(!prepareDisabled)void act(async()=>{const prepared=await api.prepare(taskId,taskVersion);if(!mounted.current)return;acceptRows([prepared,...rows.filter(row=>row.id!==prepared.id)]);acceptRows(await api.list(taskId))})}
 const prepare=useCallback(()=>prepareRef.current(),[])
 const preparedRow=rows.find(row=>row.state==='prepared'&&row.lineage),preparedControl=preparedRow?controlFor(preparedRow):undefined
 const recoveryPending=!!(preparedRow&&pendingRecoveryFor(preparedRow)),controlUnavailable=!!controls&&(!!controls.pending()||!!controls.recoveryMessage())
 const resumeAvailable=verifiedOrigin?.source===null&&!controlUnavailable
 const controlNotice=preparedControl&&(preparedControl.kind!=='active'||controlUnavailable)?{tone:preparedControl.kind==='paused'?'muted' as const:'warn' as const,sentence:t(preparedControl.kind==='paused'?'planWork.runRecovery.paused':preparedControl.kind==='loading'?'planWork.runRecovery.loading':'planWork.runRecovery.unavailable'),hint:t(recoveryPending?'planWork.unknown':controlUnavailable?'planWork.unknown':preparedControl.kind==='paused'?'planWork.runRecovery.boundary':preparedControl.kind==='blocked'?preparedControl.hint:'planWork.runRecovery.loading'),actionLabel:t(recoveryPending?'planWork.recover':preparedControl.kind==='paused'&&resumeAvailable?'planWork.runRecovery.resumeStart':'planWork.runRecovery.check'),disabled:busy||preparedControl.kind==='loading',act:()=>{if(preparedRow&&recoveryPending)recoverControl(preparedRow);else if(preparedRow&&preparedControl.kind==='paused'&&resumeAvailable)resumeRun(preparedRow,preparedControl);else refreshControl()}}:undefined
 useEffect(()=>{publishPreparation?.({taskId,taskVersion,disabled:prepareDisabled,prepare,...(controlNotice?{control:controlNotice}:{})});return()=>publishPreparation?.(null)},[publishPreparation,taskId,taskVersion,prepareDisabled,prepare,preparedControl,busy,recoveryPending,controlUnavailable,resumeAvailable,locale])
 // 依赖带上 taskState：任务由 ready 变为 running 时重新拉取，否则挂载时的空态永远不会自愈。
 useEffect(()=>{let active=true;setLoaded(false);setRows([]);setOrigin(undefined);setOriginError(false);setError(undefined);setBusy(true);void api.origin(taskId).then(value=>{if(active)setOrigin(value)},()=>{if(active)setOriginError(true)});api.list(taskId).then(value=>{if(active){acceptRows(value)}},e=>{if(active)setError(localizeWorkError(locale,e))}).finally(()=>{if(active)setBusy(false)});return()=>{active=false}},[taskId,taskState,api,locale])
 useEffect(()=>{if(busy||error)return;return scheduleTaskRunRefresh(rows,api,updated=>{acceptRows(updated);if(updated.every(row=>terminal(row.state)||row.state==='prepared'))setNotice(undefined)},e=>setError(localizeWorkError(locale,e)),undefined,()=>api.list(taskId))},[rows,api,busy,error,locale,taskId])
 const refresh=<ToolbarIconButton label={t('taskExecution.refresh')} icon={RefreshCw} disabled={busy} onClick={()=>void act(async()=>{await refreshOrigin();acceptRows(await api.list(taskId))})}/>
 return <section className={detail.executions} aria-label={t('taskExecution.aria')} title={face==='timeline'?t('taskExecution.boundary'):undefined}>
  {face!=='timeline'&&<header><h3>{t('taskExecution.title')}</h3>{refresh}</header>}
  <div className={css.buttons}>{face==='timeline'&&refresh}{showPrepare&&<button type="button" data-teloa-focus="prepare" disabled={prepareDisabled} onClick={prepare}>{t(['paused','blocked'].includes(taskState)?'taskExecution.prepareNext':'taskExecution.prepare')}</button>}{verifiedOrigin?.source===null&&api.pending()?.taskId===taskId&&<button type="button" disabled={busy} onClick={()=>void act(async()=>{await api.recoverPrepare();acceptRows(await api.list(taskId))})}>{t('taskExecution.recoverPrepare')}</button>}{(api.pending()||api.recoveryMessage())&&<button type="button" onClick={()=>{api.discard();setError(undefined);setNotice(t('recovery.discarded'))}}>{t('recovery.discard')}</button>}</div>
  {parentSource&&<div><p>{parentSource.title}</p><p className={css.muted}>{taskRunOriginCopy(locale,parentSource.stopped?'stopped':'boundary')}</p><button type="button" disabled={busy} onClick={()=>void act(openParent)}>{taskRunOriginCopy(locale,'open')}<ArrowUpRight size={14}/></button></div>}
  {originError&&<p role="alert">{taskRunOriginCopy(locale,'unavailable')}</p>}
  {api.recoveryMessage()&&<p role="alert">{localizeWorkError(locale,api.recoveryMessage())} {t('recovery.nextStep')}</p>}
  {api.pending()&&api.pending()?.taskId!==taskId&&<p>{t('taskExecution.otherPending')}</p>}
  {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}{busy&&<small role="status">{t('taskExecution.loading')}</small>}
  {!busy&&!error&&!rows.length&&<p className={css.muted}>{t('taskExecution.empty')}</p>}
  {face!=='timeline'&&rows.length>0&&<p className={css.muted}>{t('taskExecution.boundary')}</p>}
  {rows.map(row=>{const stopWait=taskRunStopWaitSeconds(row,now),workControl=controlFor(row);return <div className={detail.run} key={row.id} data-teloa-run-id={row.id}>
   <header className={css.detailHeader}><strong>{row.roleName}</strong><StatusPill tone={taskRunTone(row,stopWait!==undefined)}>{stopWait===undefined?t(row.reason?(reasons[row.reason]??'taskExecution.reason.ended'):phases[row.state]):t('taskExecution.phase.stopping',{seconds:stopWait})}</StatusPill>{row.contextTokenEstimate!==undefined&&<small>{t('taskExecution.contextTokenEstimate',{tokens:String(row.contextTokenEstimate)})}</small>}<time className={css.muted} dateTime={row.createdAt}>{dateTime(row.createdAt)}</time></header>
   <TaskRunModels run={row}/>
   {row.deliveryCheck?.state==='review-required'&&<p role="alert">{t('error.deliveryReviewRequired')}</p>}
   {row.deliveryCheck?.state==='unknown'&&<p className={css.muted} role="status">{t('taskCompletion.verificationWaiting.title')}</p>}
   {row.state!=='configuration_failed'&&<div className={detail.actions}>{taskRunControls(row.state).includes('open')&&<button type="button" disabled={busy} onClick={()=>void act(()=>open(row.sessionId))}>{t('taskExecution.open')}<ArrowUpRight size={14}/></button>}{taskRunControls(row.state).includes('start')&&verifiedOrigin?.source===null&&(!workControl||workControl.kind==='active')&&!controlUnavailable&&<button type="button" disabled={busy} onClick={()=>void act(async()=>{try{const saved=await api.start(row);setRows(current=>current.map(item=>item.id===saved.id?saved:item))}catch(e){acceptRows(await api.list(taskId));throw e}})}>{t('taskExecution.start')}</button>}{workControl?.kind==='paused'&&verifiedOrigin?.source===null&&!controlUnavailable&&<button type="button" data-teloa-focus="resume" disabled={busy} onClick={()=>resumeRun(row,workControl)}>{t('planWork.runRecovery.resumeStart')}</button>}{workControl&&workControl.kind!=='active'&&workControl.kind!=='paused'&&<button type="button" disabled={busy||workControl.kind==='loading'} onClick={refreshControl}>{t('planWork.runRecovery.check')}</button>}{pendingRecoveryFor(row)&&<button type="button" disabled={busy} onClick={()=>recoverControl(row)}>{t('planWork.recover')}</button>}{taskRunControls(row.state).includes('withdraw')&&<button type="button" disabled={busy} onClick={()=>void act(async()=>{const saved=await api.withdraw(row);setRows(current=>current.map(item=>item.id===saved.id?saved:item))})}>{t('taskExecution.withdraw')}</button>}{taskRunControls(row.state).includes('stop')&&<button type="button" disabled={busy||stopWait!==undefined} onClick={()=>void act(async()=>{const saved=await api.stop(row);setNotice(saved.state==='ended'?undefined:t('taskExecution.stopPending'));setRows(current=>current.map(item=>item.id===saved.id?saved:item))})}>{t('taskExecution.stop')}</button>}{taskRunControls(row.state).includes('reconcile')&&<button type="button" disabled={busy} onClick={()=>void act(async()=>{const saved=await api.reconcile(row);if(saved.state==='ended')setNotice(undefined);setRows(current=>current.map(item=>item.id===saved.id?saved:item))})}>{t('taskExecution.reconcile')}</button>}</div>}
    {workControl&&workControl.kind!=='active'&&<p role="status">{t(workControl.kind==='paused'?'planWork.runRecovery.boundary':workControl.kind==='blocked'?workControl.hint:'planWork.runRecovery.loading')}</p>}
    {workControl?.kind==='blocked'&&workControl.error&&<p role="alert">{workControl.error}</p>}
   {row.state==='configuration_failed'?<section className={css.runContext} aria-label={t('taskExecution.configAria')}><h4>{t('taskExecution.configTitle')}</h4><p>{t('taskExecution.configStage',{stage:t(configurationStages[row.configurationError!.stage])})}</p><p>{parentSource?taskRunOriginCopy(locale,'config'):t('taskExecution.configBoundary')}</p><small>{t('taskExecution.fixedConfig',{config:row.agentPresetId??t('taskExecution.configMissing')})}</small></section>:<>
    <details open={row.state==='prepared'}><summary>{t('taskExecution.review')}</summary><div className={detail.reviewBody} tabIndex={0}><p>{row.goal}</p><TaskRunModels run={row} planned/><small>{row.executor?.kind==='owner'?t('artifact.revision.ownerVersion',{task:row.taskVersion}):t('taskExecution.taskRoleVersion',{task:row.taskVersion,role:row.roleVersion??''})}</small><p>{t('taskExecution.fixedConfig',{config:row.agentPresetId??t('taskExecution.historyConfigMissing')})}</p>{taskRunContextSections(row).map(section=><section className={css.runContext} key={section.key} aria-label={t(section.titleKey)}><h4>{t(section.titleKey)}</h4><dl>{section.facts.map(fact=><div key={fact.labelKey}><dt>{t(fact.labelKey)}</dt><dd>{fact.value}</dd></div>)}</dl>{section.requirements.length>0&&<><strong>{t(section.key==='industry'?'taskExecution.fixedInputs':'taskExecution.requiredMaterials')}</strong><ul>{section.requirements.map((item,index)=><li key={index}><span>{item.labelKey?t(item.labelKey):item.label}</span>: {item.value}</li>)}</ul></>}{section.skills.length>0&&<p>{t('taskExecution.declaredSkills',{skills:section.skills.map(skill=>`${skill.title} · v${skill.version}`).join(', ')})}</p>}<small>{section.notice}</small></section>)}{row.skills.length>0&&<p>{t('taskExecution.fixedSkills',{skills:row.skills.map(skill=>skill.name+' · '+skill.sha256.slice(0,8)).join(', ')})}</p>}{row.skills.some(skill=>skill.managed)&&<ul>{row.skills.filter(skill=>skill.managed).map(skill=><li key={skill.name}>{t('taskExecution.managedSkill',{name:skill.name,installation:skill.managed!.installationId,count:skill.managed!.files.length,hash:skill.managed!.bundleHash.slice(0,12)})}</li>)}</ul>}{row.knowledge.length>0&&<p>{t('taskExecution.fixedKnowledge',{items:row.knowledge.map(item=>item.title+' · v'+item.version).join(', ')})}</p>}{(row.toolRules??[]).length>0?<div><p>{t('taskExecution.toolGrant')}</p><ul>{row.toolRules!.flatMap(rule=>isWorkspaceFileRule(rule)?[<li key={rule.name}>{t(rule.name==='read'?'roleGrant.files.read':rule.name==='write'?'roleGrant.files.write':'roleGrant.files.edit')}</li>]:rule.allowed.map(args=><li key={rule.name+JSON.stringify(args)}>{t('taskExecution.toolVersion',{id:String(args.id),version:String(args.version).slice(0,8)})}</li>))}</ul></div>:<p>{t('taskExecution.noTools')}</p>}</div></details>
    {row.flowId?<TaskRunFlowDetails run={row} api={api}/>:['prepared','accepted','active'].includes(row.state)&&row.lineage&&<TaskRunFlowSetup runId={row.id} api={api.flowRequests} changed={()=>void act(async()=>acceptRows(await api.list(taskId)))}/>}
    {row.subagents?.length?<details><summary>{t('subagent.run.title')}</summary><ol className={css.history}>{taskRunSubagentPresentation(row.subagents).map(item=><li key={item.number}><div className={css.detailHeader}><strong>{t('subagent.run.item',{number:String(item.number)})}</strong><StatusPill tone={stepTones[item.stateKey]??'neutral'}>{t(item.stateKey)}</StatusPill></div>{item.startedAt&&<small>{t('subagent.run.startedAt',{time:dateTime(item.startedAt)})}</small>}{item.endedAt&&<small>{t('subagent.run.endedAt',{time:dateTime(item.endedAt)})}</small>}{item.tokenEstimate!==undefined&&<small>{t('subagent.run.tokenEstimate',{tokens:String(item.tokenEstimate)})}</small>}{item.outcomeKey&&<p>{t(item.outcomeKey)}</p>}{item.stateKey==='subagent.run.state.started'&&<small>{t('subagent.run.started.notice')}</small>}{item.recoveryId&&item.stateKey==='subagent.run.state.reserved'&&<div className={css.buttons}><small>{t('subagent.run.recovery.notice')}</small><button type="button" disabled={busy} onClick={()=>void act(async()=>{const saved=await api.recoverSubagent(row,row.subagents![item.number-1]!);setRows(current=>current.map(entry=>entry.id===saved.id?saved:entry))})}>{t('subagent.run.recovery.action')}</button></div>}</li>)}</ol></details>:null}
    {row.webAccess?.length?<details><summary>{t('webAccess.run.title')}</summary><ol className={css.history}>{[...row.webAccess].sort((a,b)=>a.at.localeCompare(b.at)).map((entry,index)=><li key={entry.at+':'+index}><div className={css.detailHeader}><strong>{t(entry.kind==='search'?'webAccess.run.search':'webAccess.run.fetch')}</strong><time className={css.muted} dateTime={entry.at}>{dateTime(entry.at)}</time></div><p>{entry.value}</p><button type="button" onClick={()=>{void navigator.clipboard.writeText(entry.value).catch(()=>{})}}>{t('webAccess.run.copy')}</button></li>)}</ol></details>:null}
   </>}
  </div>})}
 </section>
}
