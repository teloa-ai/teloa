import {TaskRunModels} from './TaskRunModels.js'
import {TaskRunFlowSetup} from './TaskRunFlowSetup.js'
import type {TaskRunFlow} from '@teloa/contract'
import {useEffect,useRef,useState} from 'react'
import {ArrowUpRight,RefreshCw} from 'lucide-react'
import type {TaskRunApi,RunView} from './task-run-api.js'
import {scheduleTaskRunRefresh} from './task-run-refresh.js'
import {taskRunContextSections} from './task-run-context-presentation.js'
import {taskRunControls,taskRunStopWaitSeconds,taskRunPhaseKeys,taskRunReasonKeys} from './task-run-presentation.js'
import {taskRunFlowPresentation} from './task-run-flow-presentation.js'
import {taskRunSubagentPresentation} from './task-run-subagent-presentation.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'
import {isWorkspaceFileRule} from '@teloa/contract'

export {taskRunPhaseKeys,taskRunReasonKeys} from './task-run-presentation.js'
const phases=taskRunPhaseKeys,reasons=taskRunReasonKeys
const terminal=(state:RunView['state'])=>['ended','withdrawn','configuration_failed'].includes(state)
const configurationStages={'model-resolve':'taskExecution.stage.resolve','preset-resolve':'taskExecution.stage.resolve','session-create':'taskExecution.stage.create','session-receipt':'taskExecution.stage.receipt','session-inspect':'taskExecution.stage.inspect'} as const

function TaskRunFlowDetails({run,api}:{run:RunView;api:TaskRunApi}){
 const {locale,t}=useI18n()
 const [view,setView]=useState<ReturnType<typeof taskRunFlowPresentation>>(),[loading,setLoading]=useState(false),[error,setError]=useState<string>()
 const [flow,setFlow]=useState<TaskRunFlow>()
 const load=()=>{if(loading)return;setLoading(true);setError(undefined);api.flow(run).then(flow=>{if(flow){setFlow(flow);setView(taskRunFlowPresentation(flow))}},reason=>setError(localizeWorkError(locale,reason))).finally(()=>setLoading(false))}
 return <details onToggle={event=>{if(event.currentTarget.open&&!view&&!error)load()}}><summary>{t('taskExecution.flow.open')}</summary>
  {loading&&<small role="status">{t('taskExecution.flow.loading')}</small>}{error&&<p role="alert">{error}</p>}
  {view&&<section className={css.runContext} aria-label={t('taskExecution.flow.aria')}><header className={css.detailHeader}><strong>{t(view.stateKey)}</strong><span>{t('taskExecution.flow.definition',{version:view.definitionVersion})}</span><span>{t('taskExecution.flow.progress',{completed:view.completed,total:view.total})}</span><button type="button" disabled={loading} onClick={load}><RefreshCw size={12}/>{t('taskExecution.flow.refresh')}</button></header><ol className={css.history}>{view.steps.map(step=><li key={step.id}><div className={css.detailHeader}><strong>{step.title}</strong><span className={css.badge}>{t(step.stateKey)}</span><small>{t('taskExecution.flow.attempts',{kind:t(step.kindKey),count:step.attempts})}</small></div>{step.dependencies.length>0&&<small>{t('taskExecution.flow.dependencies',{items:step.dependencies.join(', ')})}</small>}<p>{step.inputSummary}</p>{step.outputSummary&&<p>{t('taskExecution.flow.output',{output:step.outputSummary})}</p>}{step.waitReason&&<p><strong>{t('taskExecution.flow.waitReason')}</strong>{step.waitReason}</p>}</li>)}</ol></section>}
  {flow&&!terminal(run.state)&&<TaskRunFlowSetup runId={run.id} api={api.flowRequests} flow={flow} changed={load}/>}
 </details>
}

export function TaskExecutions({taskId,taskVersion,taskState,assigned,api,open,changed,face,onRuns}:{taskId:string;taskVersion:number;taskState:string;assigned:boolean;changed:()=>void;api:TaskRunApi;open:(sessionId:string)=>Promise<void>;face?:'timeline';onRuns?:(rows:RunView[],verified:boolean)=>void}){
 const {locale,t,dateTime}=useI18n()
 const [rows,setRows]=useState<RunView[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>(),lock=useRef(false)
 const [loaded,setLoaded]=useState(false)
 const acceptRows=(value:RunView[])=>{setRows(value);setLoaded(true)}
 const canPrepare=assigned&&['ready','paused','blocked'].includes(taskState)&&!rows.some(row=>!terminal(row.state))
 // 每次渲染重新取时刻：常规轮询每次发布新快照都会重渲染，「已等待 N 秒」随之推进。
 const now=Date.now()
 const lastProgress=useRef(''),onRunsRef=useRef(onRuns);onRunsRef.current=onRuns
 useEffect(()=>{const signature=rows.map(row=>row.id+':'+row.state).join('|');if(signature!==lastProgress.current){lastProgress.current=signature;changed()}},[rows,changed])
 // 重读中或失败时撤回已确认状态；父级保留最后快照，不能把初始空数组当成从未执行。
 useEffect(()=>{onRunsRef.current?.(rows,loaded&&!busy&&!error)},[rows,loaded,busy,error])
 const act=async(work:()=>Promise<void>)=>{if(lock.current)return;lock.current=true;setBusy(true);setError(undefined);setNotice(undefined);try{await work()}catch(e){setError(localizeWorkError(locale,e))}finally{lock.current=false;setBusy(false)}}
 // 依赖带上 taskState：任务由 ready 变为 running 时重新拉取，否则挂载时的空态永远不会自愈。
 useEffect(()=>{let active=true;setLoaded(false);setRows([]);setBusy(true);api.list(taskId).then(value=>{if(active){acceptRows(value)}},e=>{if(active)setError(localizeWorkError(locale,e))}).finally(()=>{if(active)setBusy(false)});return()=>{active=false}},[taskId,taskState,api,locale])
 useEffect(()=>{if(busy||error)return;return scheduleTaskRunRefresh(rows,api,updated=>{acceptRows(updated);if(updated.every(row=>terminal(row.state)||row.state==='prepared'))setNotice(undefined)},e=>setError(localizeWorkError(locale,e)),undefined,()=>api.list(taskId))},[rows,api,busy,error,locale,taskId])
 const refresh=<button type="button" disabled={busy} onClick={()=>void act(async()=>acceptRows(await api.list(taskId)))}><RefreshCw size={14}/>{t('taskExecution.refresh')}</button>
 return <section className={css.block} aria-label={t('taskExecution.aria')} title={face==='timeline'?t('taskExecution.boundary'):undefined}>
  {face!=='timeline'&&<header><h3>{t('taskExecution.title')}</h3>{refresh}</header>}
  <div className={css.buttons}>{face==='timeline'&&refresh}<button type="button" data-teloa-focus="prepare" disabled={busy||!canPrepare||!!api.pending()||!!api.recoveryMessage()} onClick={()=>void act(async()=>{await api.prepare(taskId,taskVersion);acceptRows(await api.list(taskId))})}>{t(['paused','blocked'].includes(taskState)?'taskExecution.prepareNext':'taskExecution.prepare')}</button>{api.pending()?.taskId===taskId&&<button type="button" disabled={busy} onClick={()=>void act(async()=>{await api.recoverPrepare();acceptRows(await api.list(taskId))})}>{t('taskExecution.recoverPrepare')}</button>}{(api.pending()||api.recoveryMessage())&&<button type="button" onClick={()=>{api.discard();setError(undefined);setNotice(t('recovery.discarded'))}}>{t('recovery.discard')}</button>}</div>
  {api.recoveryMessage()&&<p role="alert">{localizeWorkError(locale,api.recoveryMessage())} {t('recovery.nextStep')}</p>}
  {api.pending()&&api.pending()?.taskId!==taskId&&<p>{t('taskExecution.otherPending')}</p>}
  {notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}{busy&&<small role="status">{t('taskExecution.loading')}</small>}
  {!busy&&!error&&!rows.length&&<p className={css.muted}>{t('taskExecution.empty')}</p>}
  {face!=='timeline'&&rows.length>0&&<p className={css.muted}>{t('taskExecution.boundary')}</p>}
  {rows.map(row=>{const stopWait=taskRunStopWaitSeconds(row,now);return <div className={css.record} key={row.id}>
   <header className={css.detailHeader}><strong>{row.roleName}</strong><span className={css.badge}>{stopWait===undefined?t(row.reason?(reasons[row.reason]??'taskExecution.reason.ended'):phases[row.state]):t('taskExecution.phase.stopping',{seconds:stopWait})}</span>{row.contextTokenEstimate!==undefined&&<small>{t('taskExecution.contextTokenEstimate',{tokens:String(row.contextTokenEstimate)})}</small>}<time className={css.muted} dateTime={row.createdAt}>{dateTime(row.createdAt)}</time></header>
   <TaskRunModels run={row}/>
   {row.state==='configuration_failed'?<section className={css.runContext} aria-label={t('taskExecution.configAria')}><h4>{t('taskExecution.configTitle')}</h4><p>{t('taskExecution.configStage',{stage:t(configurationStages[row.configurationError!.stage])})}</p><p>{t('taskExecution.configBoundary')}</p><small>{t('taskExecution.fixedConfig',{config:row.agentPresetId??t('taskExecution.configMissing')})}</small></section>:<>
    <details open={row.state==='prepared'}><summary>{t('taskExecution.review')}</summary><p>{row.goal}</p><TaskRunModels run={row} planned/><small>{t('taskExecution.taskRoleVersion',{task:row.taskVersion,role:row.roleVersion})}</small><p>{t('taskExecution.fixedConfig',{config:row.agentPresetId??t('taskExecution.historyConfigMissing')})}</p>{taskRunContextSections(row).map(section=><section className={css.runContext} key={section.key} aria-label={t(section.titleKey)}><h4>{t(section.titleKey)}</h4><dl>{section.facts.map(fact=><div key={fact.labelKey}><dt>{t(fact.labelKey)}</dt><dd>{fact.value}</dd></div>)}</dl>{section.requirements.length>0&&<><strong>{t(section.key==='industry'?'taskExecution.fixedInputs':'taskExecution.requiredMaterials')}</strong><ul>{section.requirements.map((item,index)=><li key={index}><span>{item.labelKey?t(item.labelKey):item.label}</span>: {item.value}</li>)}</ul></>}{section.skills.length>0&&<p>{t('taskExecution.declaredSkills',{skills:section.skills.map(skill=>`${skill.title} · v${skill.version}`).join(', ')})}</p>}<small>{section.notice}</small></section>)}{row.skills.length>0&&<p>{t('taskExecution.fixedSkills',{skills:row.skills.map(skill=>skill.name+' · '+skill.sha256.slice(0,8)).join(', ')})}</p>}{row.skills.some(skill=>skill.managed)&&<ul>{row.skills.filter(skill=>skill.managed).map(skill=><li key={skill.name}>{t('taskExecution.managedSkill',{name:skill.name,installation:skill.managed!.installationId,count:skill.managed!.files.length,hash:skill.managed!.bundleHash.slice(0,12)})}</li>)}</ul>}{row.knowledge.length>0&&<p>{t('taskExecution.fixedKnowledge',{items:row.knowledge.map(item=>item.title+' · v'+item.version).join(', ')})}</p>}{(row.toolRules??[]).length>0?<div><p>{t('taskExecution.toolGrant')}</p><ul>{row.toolRules!.flatMap(rule=>isWorkspaceFileRule(rule)?[<li key={rule.name}>{t(rule.name==='read'?'roleGrant.files.read':rule.name==='write'?'roleGrant.files.write':'roleGrant.files.edit')}</li>]:rule.allowed.map(args=><li key={rule.name+JSON.stringify(args)}>{t('taskExecution.toolVersion',{id:String(args.id),version:String(args.version).slice(0,8)})}</li>))}</ul></div>:<p>{t('taskExecution.noTools')}</p>}</details>
    {row.flowId?<TaskRunFlowDetails run={row} api={api}/>:['prepared','accepted','active'].includes(row.state)&&row.lineage&&<TaskRunFlowSetup runId={row.id} api={api.flowRequests} changed={()=>void act(async()=>acceptRows(await api.list(taskId)))}/>}
    {row.subagents?.length?<details><summary>{t('subagent.run.title')}</summary><ol className={css.history}>{taskRunSubagentPresentation(row.subagents).map(item=><li key={item.number}><div className={css.detailHeader}><strong>{t('subagent.run.item',{number:String(item.number)})}</strong><span className={css.badge}>{t(item.stateKey)}</span></div>{item.startedAt&&<small>{t('subagent.run.startedAt',{time:dateTime(item.startedAt)})}</small>}{item.endedAt&&<small>{t('subagent.run.endedAt',{time:dateTime(item.endedAt)})}</small>}{item.tokenEstimate!==undefined&&<small>{t('subagent.run.tokenEstimate',{tokens:String(item.tokenEstimate)})}</small>}{item.outcomeKey&&<p>{t(item.outcomeKey)}</p>}{item.stateKey==='subagent.run.state.started'&&<small>{t('subagent.run.started.notice')}</small>}{item.recoveryId&&item.stateKey==='subagent.run.state.reserved'&&<div className={css.buttons}><small>{t('subagent.run.recovery.notice')}</small><button type="button" disabled={busy} onClick={()=>void act(async()=>{const saved=await api.recoverSubagent(row,row.subagents![item.number-1]!);setRows(current=>current.map(entry=>entry.id===saved.id?saved:entry))})}>{t('subagent.run.recovery.action')}</button></div>}</li>)}</ol></details>:null}
    {row.webAccess?.length?<details><summary>{t('webAccess.run.title')}</summary><ol className={css.history}>{[...row.webAccess].sort((a,b)=>a.at.localeCompare(b.at)).map((entry,index)=><li key={entry.at+':'+index}><div className={css.detailHeader}><strong>{t(entry.kind==='search'?'webAccess.run.search':'webAccess.run.fetch')}</strong><time className={css.muted} dateTime={entry.at}>{dateTime(entry.at)}</time></div><p>{entry.value}</p><button type="button" onClick={()=>{void navigator.clipboard.writeText(entry.value).catch(()=>{})}}>{t('webAccess.run.copy')}</button></li>)}</ol></details>:null}
    <div className={css.buttons}>{taskRunControls(row.state).includes('open')&&<button type="button" disabled={busy} onClick={()=>void act(()=>open(row.sessionId))}>{t('taskExecution.open')}<ArrowUpRight size={14}/></button>}{taskRunControls(row.state).includes('start')&&<button type="button" disabled={busy} onClick={()=>void act(async()=>{try{const saved=await api.start(row);setRows(current=>current.map(item=>item.id===saved.id?saved:item))}catch(e){acceptRows(await api.list(taskId));throw e}})}>{t('taskExecution.start')}</button>}{taskRunControls(row.state).includes('withdraw')&&<button type="button" disabled={busy} onClick={()=>void act(async()=>{const saved=await api.withdraw(row);setRows(current=>current.map(item=>item.id===saved.id?saved:item))})}>{t('taskExecution.withdraw')}</button>}{taskRunControls(row.state).includes('stop')&&<button type="button" disabled={busy||stopWait!==undefined} onClick={()=>void act(async()=>{const saved=await api.stop(row);setNotice(saved.state==='ended'?undefined:t('taskExecution.stopPending'));setRows(current=>current.map(item=>item.id===saved.id?saved:item))})}>{t('taskExecution.stop')}</button>}{taskRunControls(row.state).includes('reconcile')&&<button type="button" disabled={busy} onClick={()=>void act(async()=>{const saved=await api.reconcile(row);if(saved.state==='ended')setNotice(undefined);setRows(current=>current.map(item=>item.id===saved.id?saved:item))})}>{t('taskExecution.reconcile')}</button>}</div>
   </>}
  </div>})}
 </section>
}
