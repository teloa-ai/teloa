import {planLifecycle} from './status-presentation.js'
import {StatusLabel} from './StatusLabel.js'
import {nextScheduleOccurrence} from '@teloa/contract'
import { closeDirectoryDetailOnEscape,useDirectoryFocus } from './directory-focus.js'
import type { OpenArtifacts } from './ArtifactPanel.js'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, CalendarClock, Search, X } from 'lucide-react'
import clsx from 'clsx'
import type { CollaborationScope } from './collaboration-preview.js'
import { useBusinessScopes } from './business-scope-context.js'
import { canReceiveTask, roleName, type PreviewRole } from './role-preview.js'
import { planBlock, planNotificationPolicies, triggerLabel, visiblePlanRuns, type ContinuousChange, type ContinuousPlan, type ContinuousTarget, type PlanFields, type PlanNotificationPolicy, type PlanRun } from './continuous-preview.js'
import { PlanTemplateOrigin } from './PlanTemplateOrigin.js'
import { PlanExecutionHistory, PlanExecutionRecord } from './PlanExecutionHistory.js'
import { PlanSkipHistory } from './PlanSkipHistory.js'
import { PlanExecutionDirectory } from './PlanExecutionDirectory.js'
import { ObjectPageHeader } from './ObjectPageHeader.js'
import { StatusBox } from './StatusBox.js'
import { EventTimeline } from './EventTimeline.js'
import { PropertyRail, type PropertyRow } from './PropertyRail.js'
import { focusObjectAnchor } from './object-page-anchor.js'
import type { TimelineEvent } from './object-timeline.js'
import { planStatusBox, type PlanStatusAction, type PlanStatusButton } from './plan-status-box.js'
import { planTimelineEvents } from './plan-timeline-events.js'
import type { PlanExecutionHistoryPage } from './plan-execution-history.js'
import type { PlanSkipHistoryPage } from './plan-skip-history.js'
import { taskStates } from './task-preview.js'
import type { PlanTemplate, TemplatePlanSeed } from './plan-template.js'
import type { PlanScheduleSummary } from './plan-schedule-summary.js'
import type { TaskPreview } from './task-preview.js'
import type { BusinessTarget } from './business-preview.js'
import { persistentPlanCreation, persistentPlanUpdate } from './continuous-persistence.js'
import type { PlanAction, PlanApi, PlanSource, SavedPlan } from './plan-api.js'
import { describeSavedPlanSource } from './plan-source-presentation.js'
import { continuousDirectoryMode, visiblePreviewPlans, type ContinuousDirectoryMode } from './continuous-directory-presentation.js'
import css from './TaskPage.module.css'
import own from './ContinuousPage.module.css'
import objectCss from './ObjectPage.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {readDirectoryFilterCategory,writeDirectoryFilterCategory,type WorkbenchDirectoryNavigation,type WorkbenchDirectoryPatch} from './workbench-navigation-state.js'

type PlanPersistence={api:PlanApi;plans:SavedPlan[];merge:(rows:SavedPlan[])=>void;refreshRoles:()=>void;industrySource:(plan:SavedPlan)=>ReactNode}
type Props={navigation?:{state:WorkbenchDirectoryNavigation;change:(patch:WorkbenchDirectoryPatch)=>void};persistence?:PlanPersistence;openArtifacts:OpenArtifacts;seed:TemplatePlanSeed|null;clearSeed:()=>void;openMarket:(id:string)=>void;visible:boolean;state:TaskPreview;target:ContinuousTarget;go:(target:ContinuousTarget)=>void;change:(change:ContinuousChange)=>TaskPreview;openTask:(id:string)=>void;openRole:(id:string)=>void;openBusiness:(target:BusinessTarget)=>void;team:()=>void;attention:()=>void}
type Draft={input:string;occurrenceId:string;result:string;output:string;note:string;roleId:string}
type PlanDraft={id:string;revision?:number;fields:PlanFields;template?:PlanTemplate;source?:PlanSource}
const emptyDraft:Draft={input:'',occurrenceId:'',result:'',output:'',note:'',roleId:''}

export function ContinuousPage({navigation,persistence,openArtifacts,seed,clearSeed,openMarket,visible,state,target,go,change,openTask,openRole,openBusiness,team,attention}:Props){
  const {locale,t,dateTime}=useI18n()
  const triggerText=(trigger:PlanFields['trigger'])=>triggerLabel(trigger,t)
  const states={running:t('status.running'),completed:t('status.completed'),failed:t('status.failed'),stale:t('status.stale')} as const
  const stamp=(value:string)=>dateTime(value,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
  const collaborationScopes=useBusinessScopes()
  const restoredFilters=readDirectoryFilterCategory(navigation?.state.category,{scope:'all',planStatus:'all',runStatus:'all'},{scope:['all',...Object.keys(collaborationScopes)],planStatus:['all','enabled','paused','archived'],runStatus:['all','running','completed','failed','stale']})
  const [query,setQuery]=useState(navigation?.state.query??''),[scope,setScope]=useState<CollaborationScope|'all'>(restoredFilters.scope as CollaborationScope|'all'),[planStatus,setPlanStatus]=useState(restoredFilters.planStatus),[runStatus,setRunStatus]=useState(restoredFilters.runStatus),[error,setError]=useState(''),[directoryError,setDirectoryError]=useState('')
  const [drafts,setDrafts]=useState<Record<string,Draft>>({}),[forms,setForms]=useState<Record<string,PlanDraft>>({}),[editing,setEditing]=useState<string|null>(null)
  const [loading,setLoading]=useState(!!persistence),[recovering,setRecovering]=useState(false),[reload,setReload]=useState(0),[discarded,setDiscarded]=useState(false)
  const [directoryMode,setDirectoryMode]=useState<ContinuousDirectoryMode>(()=>continuousDirectoryMode(!!persistence))
  useEffect(()=>{if(!visible)return;navigation?.change({query,category:writeDirectoryFilterCategory({scope,planStatus,runStatus})})},[visible,navigation,query,scope,planStatus,runStatus])
  const persistenceRef=useRef(persistence);persistenceRef.current=persistence
  useEffect(()=>{
    const current=persistenceRef.current;if(!visible||!current)return
    let active=true;setLoading(true);setDirectoryError('')
    try{persistenceRef.current?.refreshRoles()}catch(cause){setDirectoryError(localizeWorkError(locale,cause))}
    void current.api.list().then(rows=>{if(active)persistenceRef.current?.merge(rows)},cause=>{if(active)setDirectoryError(localizeWorkError(locale,cause))}).finally(()=>{if(active)setLoading(false)})
    return()=>{active=false}
  },[visible,persistence?.api,reload,locale])
  useEffect(()=>{if(!visible||!seed)return;setDirectoryMode(seed.template.example?'sandbox':continuousDirectoryMode(!!persistence));const key='template:'+seed.template.key;setForms(current=>current[key]?current:{...current,[key]:{id:crypto.randomUUID(),fields:structuredClone(seed.fields),template:structuredClone(seed.template),...(seed.source?{source:structuredClone(seed.source)}:{})}});setEditing(key);clearSeed()},[visible,seed,clearSeed,persistence])
  useEffect(()=>{if(visible&&target.kind==='plan'&&persistence?.plans.some(plan=>plan.id===target.id))setDirectoryMode('saved')},[visible,target.kind,target.id,persistence?.plans])
  const createButton=useRef<HTMLButtonElement>(null),detailScroll=useRef<HTMLElement>(null),positions=useRef<Record<string,number>>({})
  const routeKey=JSON.stringify(target)
  useLayoutEffect(()=>{if(visible&&detailScroll.current)detailScroll.current.scrollTop=positions.current[routeKey]||0},[visible,routeKey])
  const directoryFocus=useDirectoryFocus(visible,target.id)
  if(!visible)return null
  const value=state.continuous,isSandbox=directoryMode==='sandbox',isRuns=target.kind==='runs'||target.kind==='run'
  const status=isRuns?runStatus:planStatus,setStatus=isRuns?setRunStatus:setPlanStatus
  const savedPlanIds=new Set(persistence?.plans.map(plan=>plan.id)??[])
  const previewPlans=visiblePreviewPlans(value.plans,savedPlanIds,directoryMode)
  const plan=target.kind==='plan'?previewPlans.find(plan=>plan.id===target.id):undefined,run=isSandbox&&target.kind==='run'?value.runs.find(run=>run.id===target.id):undefined
  const savedPlan=plan?persistence?.plans.find(saved=>saved.id===plan.id):undefined
  const currentScope=target.scope||scope
  const hasFilters=!!query.trim()||currentScope!=='all'||status!=='all'||!!target.roleId
  const showFilters=(isRuns?value.runs.length:previewPlans.length)>0||hasFilters
  const resetFilters=()=>{setQuery('');setScope('all');setStatus('all');go({kind:isRuns?'runs':'plans'})}
  const matches=(itemScope:CollaborationScope,...texts:string[])=>(currentScope==='all'||currentScope===itemScope)&&texts.some(text=>text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const plans=previewPlans.filter(item=>(!target.roleId||item.fields.roleId===target.roleId)&&matches(item.fields.scope,item.fields.title,item.id,item.fields.goal)&&(status==='all'||status==='archived'&&item.archived||status==='enabled'&&planLifecycle(item)==='active'||status==='paused'&&planLifecycle(item)==='paused'))
  const runs=isSandbox?value.runs.filter(item=>(!target.roleId||item.actor.id===target.roleId)&&matches(item.snapshot.fields.scope,item.snapshot.fields.title,item.id,item.result)&&(status==='all'||item.state===status)).map(item=>({key:'plan:'+item.id,title:item.snapshot.fields.title,meta:'v'+item.snapshot.version+' · '+item.actor.name,scope:item.snapshot.fields.scope,state:item.state,at:item.createdAt,open:()=>navigate({kind:'run',id:item.id})})).sort((a,b)=>b.at.localeCompare(a.at)||a.key.localeCompare(b.key)):[]
  function navigate(next:ContinuousTarget){setError('');go({...next,...(target.scope?{scope:target.scope}:{}),...(target.roleId?{roleId:target.roleId}:{})})}
  const act=(command:ContinuousChange)=>{try{const next=change(command);setError('');return next}catch(error){setError(localizeWorkError(locale,error));return null}}
  const draftKey=run?'run:'+run.id:plan?'plan:'+plan.id:''
  const draft=drafts[draftKey]||emptyDraft
  const patch=(value:Partial<Draft>)=>setDrafts(current=>({...current,[draftKey]:{...(current[draftKey]||emptyDraft),...value}}))
  const edit=(plan?:ContinuousPlan)=>{
    const key=plan?.id||'new'
    if(!forms[key]){
      const business=target.scope||(scope==='all'?'general':scope),role=state.roles.find(role=>canReceiveTask(role,business)&&((!persistence||isSandbox)||role.storage==='persistent')&&(!target.roleId||role.id===target.roleId))
      setForms(current=>({...current,[key]:plan?{id:plan.id,revision:plan.revision,fields:structuredClone(plan.fields),...(plan.template?{template:structuredClone(plan.template)}:{})}:{id:crypto.randomUUID(),fields:{title:'',scope:business,goal:'',dataScope:t('continuous.default.dataScope'),delivery:t('continuous.default.delivery'),roleId:role?.id||'',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}}}}))
    }
    setEditing(key)
  }
  return <section className={clsx(css.page,own.workPage,!target.id&&!isRuns&&own.overview,!!target.id&&own.detailPage,isSandbox&&own.sandboxMode)} data-continuous-mode={directoryMode} aria-label={t('navigation.plans')}>
    {persistence?.api.recoveryMessage()&&<><p role="alert" className={css.error}>{localizeWorkError(locale,persistence.api.recoveryMessage())} {t('recovery.nextStep')}</p><button type="button" onClick={()=>{persistence.api.discard();setDiscarded(true)}}>{t('recovery.discard')}</button>{discarded&&<p role="status">{t('recovery.discarded')}</p>}</>}
    {persistence?.api.pending()&&(()=>{const pending=persistence.api.pending()!;return <div className={clsx(css.preview,own.planPreview)}><span>{t(pending.kind==='trigger'?'continuous.recovery.triggerPending':'continuous.recovery.pending')}</span><button type="button" disabled={recovering} onClick={()=>{setRecovering(true);setError('');const recovered=pending.kind==='trigger'?persistence.api.recoverTrigger().then(result=>{openTask(result.taskId)}):persistence.api.recover().then(row=>{persistence.merge([row]);go({kind:'plan',id:row.id})});void recovered.catch(cause=>setError(localizeWorkError(locale,cause))).finally(()=>{setRecovering(false);persistence.refreshRoles()})}}>{t(recovering?'continuous.recovery.checking':'continuous.recovery.action')}</button></div>})()}
    <header className={css.pageHeader}><div><h1>{t('navigation.plans')}</h1><p>{t('continuous.v2.description')}</p></div><div className={css.buttons}><button type="button" onClick={()=>navigate({kind:isRuns?'plans':'runs'})}>{t(isRuns?'continuous.tab.plans':'continuous.tab.runs')}</button><button type="button" onClick={attention}>{t('task.action.viewAttention')}</button><button ref={createButton} type="button" onClick={()=>edit()}>{t(isSandbox?'continuous.action.createSandbox':'continuous.action.create')}</button></div></header>
    {directoryError&&<p className={clsx(css.error,own.directoryError)} role="alert">{directoryError}<button type="button" disabled={loading} onClick={()=>setReload(value=>value+1)}>{t('continuous.loading.retry')}</button></p>}
    {error&&<p className={clsx(css.error,own.directoryError)} role="alert">{error}<button type="button" onClick={()=>setError('')}>{t('common.closeError')}</button></p>}
    {target.kind==='runs'&&persistence&&!isSandbox?<PlanExecutionDirectory api={persistence.api} plans={persistence.plans} roles={state.roles} scopes={collaborationScopes} {...(target.scope?{fixedScope:target.scope}:{})} {...(target.roleId?{fixedRoleId:target.roleId}:{})} openPlans={()=>navigate({kind:'plans'})} openTask={openTask}/>:<div {...directoryFocus} className={clsx(css.layout,own.workLayout,(plan||run||target.id)&&css.hasSelection)}>
      <aside data-teloa-pane="directory" tabIndex={-1} className={css.directory} aria-label={t('continuous.directory')}>
        {showFilters&&<div className={own.directoryFilters}>
        <label className={css.search}><Search size={16}/><input aria-label={t('continuous.search')} value={query} onChange={event=>setQuery(event.target.value)} placeholder={t('continuous.search')}/></label>
        <select aria-label={t('common.allBusiness')} value={currentScope} onChange={event=>{setScope(event.target.value as typeof scope);const {scope:previousScope,...remaining}=target;go(remaining)}}><option value="all">{t('common.allBusiness')}</option>{Object.entries(collaborationScopes).map(([id,label])=><option value={id} key={id}>{label}</option>)}</select>
        <select aria-label={t('common.allStatus')} value={status} onChange={event=>setStatus(event.target.value)}><option value="all">{t('common.allStatus')}</option>{isRuns?Object.entries(states).map(([id,label])=><option key={id} value={id}>{label}</option>):<><option value="enabled">{t('status.enabled')}</option><option value="paused">{t('status.paused')}</option><option value="archived">{t('status.archived')}</option></>}</select>
        {hasFilters&&<button type="button" className={own.resetFilters} onClick={resetFilters}>{t('task.filter.reset')}</button>}
        </div>}
        {target.roleId&&<p className={css.muted}>{roleName(state.roles,target.roleId,t)}</p>}
        <div className={css.rows}>{isRuns?runs.map(item=><button type="button" key={item.key} data-teloa-entry={item.key} className={css.row} onClick={item.open} aria-current={item.key==='plan:'+run?.id?'page':undefined}><span className={css.rowMeta}>{collaborationScopes[item.scope]??item.scope}<span>{states[item.state]}</span></span><strong>{item.title}</strong><small>{item.meta} · {stamp(item.at)}</small></button>):plans.map(item=>{const saved=persistence?.plans.find(row=>row.id===item.id),lifecycle=saved?.state??planLifecycle(item);return <button type="button" key={item.id} data-teloa-entry={item.id} className={css.row} onClick={()=>navigate({kind:'plan',id:item.id})} aria-current={item.id===plan?.id?'page':undefined}><span className={css.rowMeta}>{collaborationScopes[item.fields.scope]??item.fields.scope}<StatusLabel label={t(lifecycle==='archived'?'status.archived':lifecycle==='active'?'status.enabled':'status.paused')} mark={lifecycle==='active'?'enabled':lifecycle==='paused'?'paused':'retired'} tone={lifecycle==='active'?'good':'muted'}/></span><strong>{item.fields.title}</strong><small>{triggerText(item.fields.trigger)} · v{item.version}{isSandbox&&<> · {t('continuous.sandbox.title')}</>}</small></button>})}
          {!isSandbox&&loading&&<p role="status">{t('continuous.loading')}</p>}
          {(isSandbox||!loading&&!directoryError)&&(isRuns?runs.length===0:plans.length===0)&&<div className={css.empty}><CalendarClock size={28}/><h2>{t(hasFilters?'continuous.empty.noMatch':isRuns?'continuous.empty.runs':'continuous.empty.automation')}</h2><p>{t(hasFilters?'continuous.empty.changeFilters':isRuns?'continuous.empty.runs':'continuous.empty.setup')}</p></div>}
        </div>
      </aside>
      <article data-teloa-pane="detail" tabIndex={-1} ref={detailScroll} onScroll={event=>{positions.current[routeKey]=event.currentTarget.scrollTop}} className={css.detail} aria-label={t(run?'continuous.detail.runTitle':plan?'continuous.detail.planTitle':'continuous.detail.infoTitle')} onKeyDown={event=>closeDirectoryDetailOnEscape(event,()=>navigate({kind:isRuns?'runs':'plans'}))}>
        <button type="button" onClick={()=>navigate({kind:isRuns?'runs':'plans'})}><ArrowLeft size={16}/>{t('continuous.detail.back')}</button>
        {plan?<PlanDetail key={plan.id} industrySource={savedPlan&&persistence?.industrySource(savedPlan)} openMarket={openMarket} plan={plan} saved={savedPlan} scheduleApi={savedPlan?persistence?.api:undefined} persist={savedPlan&&persistence?async(action,note)=>{try{setError('');persistence.merge([await persistence.api.change(savedPlan.id,savedPlan.version,action,note)]);return true}catch(cause){setError(localizeWorkError(locale,cause));return false}}:undefined} state={state} draft={draft} patch={patch} act={act} edit={()=>edit(plan)} go={navigate} openTask={openTask} openRole={openRole} team={team}/>:run?<RunDetail openArtifacts={openArtifacts} openMarket={openMarket} run={run} state={state} draft={draft} patch={patch} act={act} go={navigate} openTask={openTask} openRole={openRole}/>:<div className={css.empty}><CalendarClock size={34}/><h2>{t(target.id?'error.notFound':'continuous.directory')}</h2><p>{t(target.id?'error.notFound':'continuous.saved.description')}</p><div className={css.buttons}><button type="button" onClick={()=>edit()}>{t(isSandbox?'continuous.action.createSandbox':'continuous.action.create')}</button>{target.scope&&<button type="button" onClick={()=>openBusiness({scope:target.scope!,section:'analysis'})}>{t('navigation.spaces')}</button>}</div></div>}
      </article>
    </div>}
    {editing&&forms[editing]&&(()=>{const form=forms[editing]!,saved=persistence?.plans.find(plan=>plan.id===form.id),persistent=!!persistence&&!isSandbox;return <PlanForm persistent={persistent} fallbackFocus={()=>createButton.current?.focus()} openMarket={id=>{setEditing(null);openMarket(id)}} draft={form} roles={state.roles} close={()=>setEditing(null)} patch={fields=>setForms(current=>({...current,[editing]:{...current[editing]!,fields}}))} reload={form.revision!==undefined?()=>{const plan=value.plans.find(item=>item.id===form.id);if(plan)setForms(current=>({...current,[editing]:{id:plan.id,revision:plan.revision,fields:structuredClone(plan.fields),...(plan.template?{template:structuredClone(plan.template)}:{})}}))}:undefined} save={async()=>{let id=form.id;if(persistent&&saved){const updated=await persistence.api.update(saved,persistentPlanUpdate(form.fields,saved));persistence.merge([updated])}else if(persistent){const creation=persistentPlanCreation(form.fields,form.template,state.roles,form.source),created=await persistence.api.create(creation.fields,creation.source);persistence.merge([created]);id=created.id}else{change({type:'save',id:form.id,...(form.revision===undefined?{}:{expectedRevision:form.revision}),fields:form.fields,...(form.template?{template:form.template}:{}),now:new Date().toISOString()})}setForms(current=>{const next={...current};delete next[editing];return next});setEditing(null);navigate({kind:'plan',id})}}/>})()}
  </section>
}

type DetailProps={openMarket:Props['openMarket'];state:TaskPreview;draft:Draft;patch:(patch:Partial<Draft>)=>void;act:(change:ContinuousChange)=>TaskPreview|null;go:Props['go'];openRole:Props['openRole']}
const notificationPolicyKeys={always:'continuous.form.notification.always',attention:'continuous.form.notification.attention',failure:'continuous.form.notification.failure',silent:'continuous.form.notification.silent'} as const
// 与 PlanExecutionHistory.tsx 内私有的 runStates 同表；那份是私有常量，这里复制一份供时间线事件取运行状态文案。
const runStateKeys={prepared:'plan.run.prepared',submitting:'plan.run.submitting',accepted:'plan.run.accepted',active:'plan.run.active',ended:'plan.run.ended',withdrawn:'plan.run.withdrawn',configuration_failed:'plan.run.configurationFailed'} as const
function localizedTrigger(t:ReturnType<typeof useI18n>['t'],trigger:PlanFields['trigger']){return triggerLabel(trigger,t)}

function PlanDetail({industrySource,openMarket,plan,saved,scheduleApi,persist,state,draft,patch,act,go,edit,openTask,openRole,team}:DetailProps&{industrySource:ReactNode;plan:ContinuousPlan;saved:SavedPlan|undefined;scheduleApi:PlanApi|undefined;persist:((action:PlanAction,note?:string)=>Promise<boolean>)|undefined;edit:()=>void;openTask:Props['openTask'];team:()=>void}){
  const {locale,t,dateTime}=useI18n()
  const stamp=(value:string)=>dateTime(value,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
  const states={running:t('status.running'),completed:t('status.completed'),failed:t('status.failed'),stale:t('status.stale')} as const
  const collaborationScopes=useBusinessScopes()
  const [busy,setBusy]=useState(false)
  const [triggerError,setTriggerError]=useState('')
  const [scheduleReload,setScheduleReload]=useState(0)
  const [scheduleState,setScheduleState]=useState<{key:string;value?:PlanScheduleSummary;error:string;loading:boolean}>({key:'',error:'',loading:false})
  const root=useRef<HTMLDivElement>(null)
  const persisted=!!saved
  const block=planBlock(plan,state.roles,t),runs=visiblePlanRuns(state.continuous.runs,plan.id,persisted)
  const candidates=state.roles.filter(role=>canReceiveTask(role,plan.fields.scope)&&role.id!==plan.fields.roleId)
  const revision={planId:plan.id,expectedRevision:plan.revision}
  const scheduleKey=saved?saved.id+':'+saved.version:''
  const currentSchedule=scheduleState.key===scheduleKey?scheduleState:undefined
  const [skipPage,setSkipPage]=useState<PlanSkipHistoryPage>()
  const [executionPage,setExecutionPage]=useState<PlanExecutionHistoryPage>()
  useEffect(()=>{
    if(!saved||!scheduleApi){setScheduleState({key:'',error:'',loading:false});return}
    const key=saved.id+':'+saved.version
    let active=true
    setScheduleState(current=>({key,...(current.key===key&&current.value?{value:current.value}:{}),error:'',loading:true}))
    void scheduleApi.schedule(saved.id).then(value=>{if(active)setScheduleState({key,value,error:'',loading:false})},cause=>{if(active)setScheduleState({key,error:localizeWorkError(locale,cause),loading:false})})
    return()=>{active=false}
  },[scheduleApi,saved?.id,saved?.version,scheduleReload])
  const runPersistent=async(action:PlanAction,note?:string)=>{if(!persist)return;setBusy(true);try{await persist(action,note)}finally{setBusy(false)}}
  const triggerPersistent=async()=>{if(!saved||!scheduleApi)return;setBusy(true);setTriggerError('');try{const result=await scheduleApi.trigger(saved,new Date().toISOString());setScheduleReload(value=>value+1);openTask(result.taskId)}catch(cause){setTriggerError(localizeWorkError(locale,cause))}finally{setBusy(false)}}
  const lifecycle=saved?saved.state:planLifecycle(plan)
  const resumeBlocked=!plan.enabled&&!!planBlock({...plan,enabled:true},state.roles)
  const model=planStatusBox({plan:saved??{state:lifecycle,trigger:plan.fields.trigger},schedule:currentSchedule?.value,skips:skipPage?.items??[],latestExecution:executionPage?.items[0]??null,stamp,t})
  const detail=!saved&&!plan.archived?block||t('continuous.detail.status.sandbox'):model.detail
  const openAnchor=(anchor:string)=>{const node=root.current?.querySelector<HTMLDetailsElement>(`details[data-teloa-anchor="${anchor}"]`);if(node)node.open=true;focusObjectAnchor(root.current,anchor,'note')}
  const runPlanAction=(action:PlanStatusAction)=>{
    if(action.kind==='open-task')openTask(action.taskId)
    else if(action.kind==='trigger'){if(saved)void triggerPersistent();else openAnchor('trigger-demo')}
    else if(saved)void runPersistent(action.kind==='pause'?'pause':'enable')
    else act({type:'enabled',...revision,enabled:action.kind==='resume',now:new Date().toISOString()})
  }
  const statusAction=(button:PlanStatusButton)=>({label:busy&&button.action.kind!=='open-task'?t(button.action.kind==='trigger'?'continuous.detail.triggering':'continuous.common.saving'):button.label,onSelect:()=>runPlanAction(button.action),disabled:busy||button.action.kind==='resume'&&resumeBlocked})
  const roleLabel=t('continuous.detail.responsibleRole',{role:''}).replace(/[:：]\s*$/,'')
  const health=currentSchedule?.value?.health??null
  const templateOrigin=plan.template&&<PlanTemplateOrigin template={plan.template} open={openMarket}/>
  const faces=saved&&scheduleApi?{
    executions:<PlanExecutionHistory face="timeline" planId={saved.id} planVersion={saved.version} api={scheduleApi} openTask={openTask} onPage={setExecutionPage}/>,
    execution:(item:import('./plan-execution-history.js').PlanExecutionHistoryItem)=><PlanExecutionRecord item={item} openTask={openTask} compact/>,
    skips:<PlanSkipHistory face="timeline" planId={saved.id} planVersion={saved.version} api={scheduleApi} openTask={openTask} onPage={setSkipPage}/>,
    source:<>{industrySource}<SavedPlanSource source={saved.source}/></>,
  }:undefined
  const createdAt=plan.history[0]?.at
  const sandboxEvents:TimelineEvent[]=[
    ...runs.map(run=>({id:'run:'+run.id,kind:'trigger' as const,at:run.createdAt,title:t('continuous.detail.runVersion',{state:states[run.state],version:run.snapshot.version}),meta:run.actor.name+(run.retryOf?t('continuous.detail.retrySuffix'):''),actions:<button type="button" onClick={()=>go({kind:'run',id:run.id})}>{run.result||run.input}</button>})),
    ...plan.history.map((entry,index)=>({id:'change:'+index,kind:'change' as const,at:entry.at,title:entry.text,foldKey:'change'})),
    ...(plan.template&&createdAt?[{id:'source',kind:'source' as const,at:createdAt,title:t('plan.timeline.source',{label:plan.template.title}),detail:<PlanTemplateOrigin template={plan.template} open={openMarket}/>}]:[]),
  ]
  const events=saved&&faces?planTimelineEvents({plan:saved,executions:executionPage?.items??[],skips:skipPage?.items??[],sourceLabel:describeSavedPlanSource(saved.source,t).label,faces,stamp,t,taskStateLabel:state=>t(taskStates[state]),runStateLabel:state=>t(runStateKeys[state])}):sandboxEvents
  const rows:PropertyRow[]=[
    {id:'trigger',label:t('continuous.detail.trigger'),value:localizedTrigger(t,plan.fields.trigger)},
    {id:'notification',label:t('continuous.form.notificationPolicy'),value:plan.fields.notificationPolicy?t(notificationPolicyKeys[plan.fields.notificationPolicy]):t('continuous.detail.notification.review')},
    {id:'dataScope',label:t('continuous.detail.dataScope'),value:plan.fields.dataScope},
    {id:'delivery',label:t('continuous.detail.delivery'),value:plan.fields.delivery},
    {id:'role',label:roleLabel,value:roleName(state.roles,plan.fields.roleId,t),onOpen:()=>openRole(plan.fields.roleId),openLabel:roleLabel},
    {id:'version',label:t('plan.execution.config',{version:plan.version}),value:t('plan.execution.revision',{version:plan.revision}),detail:<p>{t('continuous.detail.planId',{id:plan.id})}</p>},
    {id:'source',label:t('continuous.source.title'),value:saved?describeSavedPlanSource(saved.source,t).label:plan.template?plan.template.title:'—',...(faces?{detail:faces.source}:templateOrigin?{detail:templateOrigin}:{})},
    {id:'health',label:t('plan.rail.health'),value:health===null?t('plan.schedule.healthUnknown'):health.health==='healthy'?t('plan.schedule.healthy',{time:stamp(health.lastSuccessAt??health.lastAttemptAt)}):t('plan.schedule.failed',{code:health.failureCode??'—',time:stamp(health.lastAttemptAt)}),...(health?{detail:<p className={css.muted}>{t('plan.rail.healthAt',{time:stamp(health.lastAttemptAt)})}</p>}:{})},
  ]
  return <div ref={root}>
    <ObjectPageHeader backHidden title={plan.fields.title} {...(plan.archived?{}:{onEditTitle:edit,editTitleLabel:t('continuous.detail.edit')})} status={{mark:lifecycle==='active'?'enabled':lifecycle==='paused'?'paused':'retired',label:t(lifecycle==='archived'?'status.archived':lifecycle==='active'?'status.enabled':'status.paused'),tone:lifecycle==='active'?'good':'muted'}} badges={[{id:'scope',label:collaborationScopes[plan.fields.scope]??plan.fields.scope}]} owner={{label:roleLabel,name:roleName(state.roles,plan.fields.roleId,t),onOpen:()=>openRole(plan.fields.roleId)}} menuLabel={t('plan.menu.more')} menu={[
      {id:'edit',label:t('continuous.detail.edit'),onSelect:edit,disabled:plan.archived||!persisted&&!!plan.handoff},
      {id:'toggle',label:(plan.enabled?t('continuous.detail.pause'):t('continuous.detail.resume'))+(persisted?'':t('continuous.common.demoSuffix')),onSelect:()=>runPlanAction({kind:plan.enabled?'pause':'resume'}),disabled:busy||plan.archived||resumeBlocked},
      {id:'archive',label:t('continuous.detail.archive'),onSelect:()=>openAnchor('archive'),disabled:plan.archived||saved?.source.kind==='system-digest'},
    ]}/>
    <p className={own.planGoal}>{plan.fields.goal}</p>
    <div className={own.planBody}><div>
      <StatusBox ariaLabel={t('plan.status.aria')} tone={model.tone} sentence={model.sentence} {...(model.hint?{hint:model.hint,hintLabel:t('task.status.hint')}:{})} {...(model.primary?{primary:statusAction(model.primary)}:{})} {...(model.secondary?{secondary:statusAction(model.secondary)}:{})}>
        {detail&&<p className={css.muted}>{detail}</p>}
        {triggerError&&<p className={css.error} role="alert">{triggerError}<button type="button" onClick={()=>setTriggerError('')}>{t('common.closeError')}</button></p>}
        {currentSchedule?.error&&<p className={css.error} role="alert">{currentSchedule.error}<button type="button" disabled={currentSchedule.loading} onClick={()=>setScheduleReload(value=>value+1)}>{t('plan.schedule.retry')}</button></p>}
      </StatusBox>
      <EventTimeline ariaLabel={t('plan.timeline.aria')} events={events} emptyText={t('plan.timeline.empty')} foldLabel={(kind,count,foldKey)=>kind==='skip'?t('plan.timeline.fold.skip',{count,reason:t(foldKey.endsWith('previous-pending')?'plan.schedule.skipPending':'plan.schedule.skipRunning')}):t('task.timeline.fold.change',{count})} expandLabel={t('task.timeline.expand')} collapseLabel={t('task.timeline.collapse')} stamp={stamp}/>
    {!plan.archived&&!persisted&&<><details className={css.block} open={!!plan.handoff}><summary>{plan.handoff?t('continuous.detail.handoff.waiting'):t('continuous.detail.handoff.title')}</summary><p>{plan.handoff?.reason||t('continuous.detail.handoff.explanation')}</p>{candidates.length?<form className={css.form} onSubmit={event=>{event.preventDefault();act({type:'handoff',...revision,roleId:draft.roleId,note:draft.note,now:new Date().toISOString()})}}><label>{t('continuous.detail.handoff.role')}<select value={draft.roleId} onChange={event=>patch({roleId:event.target.value})}><option value="">{t('continuous.detail.handoff.selectRole')}</option>{candidates.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</select></label><label>{t('continuous.detail.handoff.note')}<textarea required maxLength={8000} value={draft.note} onChange={event=>patch({note:event.target.value})}/></label><button type="submit" disabled={!draft.note.trim()||!candidates.some(role=>role.id===draft.roleId)}>{t('continuous.detail.handoff.saveDemo')}</button></form>:<><p>{t('continuous.detail.handoff.noCandidate')}</p><button type="button" onClick={team}>{t('continuous.detail.handoff.configure')}</button></>}</details>
    <details className={css.block} data-teloa-anchor="trigger-demo"><summary>{t('continuous.detail.triggerDemo')}</summary><p>{t('continuous.detail.occurrenceExplanation')}</p><form className={css.form} onSubmit={event=>{event.preventDefault();const next=act({type:'trigger',planId:plan.id,id:crypto.randomUUID(),occurrenceId:draft.occurrenceId,input:draft.input,now:new Date().toISOString()});const run=next?.continuous.runs.find(run=>run.planId===plan.id&&run.occurrenceId===draft.occurrenceId.trim()&&!run.retryOf);if(run)go({kind:'run',id:run.id})}}><label>{t('continuous.detail.occurrenceId')}<input data-teloa-focus="note" required maxLength={240} value={draft.occurrenceId} onChange={event=>patch({occurrenceId:event.target.value})}/></label><button type="button" onClick={()=>patch({occurrenceId:crypto.randomUUID()})}>{t('continuous.detail.newOccurrenceId')}</button><label>{t('continuous.detail.inputNote')}<textarea required rows={3} maxLength={8000} value={draft.input} onChange={event=>patch({input:event.target.value})} placeholder={t('continuous.detail.inputPlaceholder')}/></label><button type="submit" disabled={!!block||!draft.occurrenceId.trim()||!draft.input.trim()}>{t('continuous.detail.triggerRunDemo')}</button></form></details></>}
    {!plan.archived&&saved?.source.kind!=='system-digest'&&<details className={css.block} data-teloa-anchor="archive"><summary>{t('continuous.detail.archive')}</summary><p>{t('continuous.detail.archiveExplanation')}</p><form className={css.form} onSubmit={event=>{event.preventDefault();if(saved)void runPersistent('archive',draft.note);else act({type:'archive',...revision,note:draft.note,now:new Date().toISOString()})}}><label>{t('continuous.detail.archiveNote')}<textarea data-teloa-focus="note" required maxLength={persisted?4000:8000} value={draft.note} onChange={event=>patch({note:event.target.value})}/></label><button type="submit" disabled={busy||!draft.note.trim()}>{busy?t('continuous.detail.archiving'):persisted?t('continuous.detail.archiveSaved'):t('continuous.detail.archiveDemo')}</button></form></details>}
    </div><PropertyRail ariaLabel={t('plan.rail.aria')} rows={rows} expandLabel={t('task.timeline.expand')} collapseLabel={t('task.timeline.collapse')}/></div>
  </div>
}
function SavedPlanSource({source}:{source:PlanSource}){
 const {t}=useI18n()
 const display=describeSavedPlanSource(source,t)
 return <section className={css.block} aria-label={t('continuous.source.title')}><h3>{t('continuous.source.title')}</h3><p><strong>{display.label}</strong> · {display.summary}</p>{display.kind==='market-content'&&<><p>{t('continuous.source.resource')}<code className={objectCss.mono}>{display.resourceId}</code> · v{display.resourceVersion}</p><p>{t('continuous.source.fixedContent')}<code className={objectCss.mono}>{display.contentId}</code></p><p>{t('continuous.source.contentHash')}<code className={objectCss.mono}>{display.contentHash}</code></p></>}</section>
}
function RunDetail({openArtifacts,openMarket,run,state,draft,patch,act,go,openTask,openRole}:DetailProps&{openArtifacts:OpenArtifacts;run:PlanRun;openTask:Props['openTask']}){
  const {t,dateTime}=useI18n()
  const stamp=(value:string)=>dateTime(value,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
  const states={running:t('status.running'),completed:t('status.completed'),failed:t('status.failed'),stale:t('status.stale')} as const
  const child=state.continuous.runs.find(item=>item.retryOf===run.id),plan=state.continuous.plans.find(item=>item.id===run.planId)
  const block=!plan?t('continuous.run.originalUnavailable'):plan.version!==run.snapshot.version?t('continuous.run.versionChanged'):planBlock(plan,state.roles,t)
  return <><h2>{run.snapshot.fields.title}</h2><div className={css.metadata}><span>{states[run.state]}</span><span>{t('continuous.run.version',{version:run.snapshot.version})}</span><span>{stamp(run.createdAt)}</span><button type="button" onClick={()=>openRole(run.actor.id)}>{t('continuous.run.author',{name:run.actor.name})}</button></div><div className={css.buttons}><button type="button" onClick={()=>go({kind:'plan',id:run.planId})}>{t('continuous.run.backToPlan')}</button>{run.retryOf&&<button type="button" onClick={()=>go({kind:'run',id:run.retryOf!})}>{t('continuous.run.viewOriginal')}</button>}{child&&<button type="button" onClick={()=>go({kind:'run',id:child.id})}>{t('continuous.run.viewRetry')}</button>}</div>
    {run.snapshot.template&&<PlanTemplateOrigin template={run.snapshot.template} open={openMarket}/>}
    <section className={css.block}><h3>{t('continuous.run.input')}</h3><p>{run.input}</p><details><summary>{t('continuous.run.fixedConfig')}</summary><p>{run.snapshot.fields.goal}</p><p>{t('continuous.detail.dataScope')}: {run.snapshot.fields.dataScope}</p><p>{t('continuous.detail.delivery')}: {run.snapshot.fields.delivery}</p><p>{localizedTrigger(t,run.snapshot.fields.trigger)}</p><p>{t('continuous.detail.occurrenceId')}: {run.occurrenceId}</p><p>{t('continuous.run.id')}: {run.id}</p></details></section>
    {run.state==='running'?<section className={css.block}><h3>{t('continuous.run.recordDemo')}</h3><p>{t('continuous.run.recordExplanation')}</p><div className={css.form}><label>{t('continuous.run.resultNote')}<textarea required rows={3} maxLength={8000} value={draft.result} onChange={event=>patch({result:event.target.value})}/></label><label>{t('continuous.run.output')}<textarea rows={5} maxLength={16000} value={draft.output} onChange={event=>patch({output:event.target.value})}/></label><div className={css.buttons}>{(['completed','failed'] as const).map(outcome=><button key={outcome} type="button" disabled={!draft.result.trim()} onClick={()=>act({type:'finish',runId:run.id,expectedRevision:run.revision,outcome,result:draft.result,output:draft.output,now:new Date().toISOString()})}>{outcome==='completed'?t('continuous.run.completeDemo'):t('continuous.run.failDemo')}</button>)}</div></div></section>:<section className={css.block}><h3>{t('continuous.run.resultAndOutput')}</h3><p>{run.result}</p>{run.output&&<blockquote>{run.output}</blockquote>}<button type="button" onClick={()=>openArtifacts({kind:'run',id:run.id},run.artifact)}>{t('continuous.run.viewOutput')}</button></section>}
    {run.state==='failed'&&!child&&!run.resolution&&<section className={css.block}><h3>{t('continuous.run.handleFailure')}</h3><p>{block||t('continuous.run.retryExplanation')}</p><button type="button" disabled={!!block} onClick={()=>{const next=act({type:'retry',runId:run.id,id:crypto.randomUUID(),now:new Date().toISOString()}),child=next?.continuous.runs.find(item=>item.retryOf===run.id);if(child)go({kind:'run',id:child.id})}}>{t('continuous.run.retryDemo')}</button><form className={css.form} onSubmit={event=>{event.preventDefault();act({type:'resolve',runId:run.id,expectedRevision:run.revision,note:draft.note,now:new Date().toISOString()})}}><label>{t('continuous.run.resolveNote')}<textarea required maxLength={8000} value={draft.note} onChange={event=>patch({note:event.target.value})} placeholder={t('continuous.run.resolvePlaceholder')}/></label><button type="submit" disabled={!draft.note.trim()}>{t('continuous.run.resolve')}</button></form></section>}
    {run.resolution&&<section className={css.block}><h3>{t('continuous.run.resolved')}</h3><p>{run.resolution.note}</p><small>{stamp(run.resolution.at)}</small></section>}
    {run.state==='completed'&&<section className={css.block}><h3>{t('continuous.run.followUp')}</h3><p>{t('continuous.run.followExplanation')}</p>{run.taskId?<button type="button" onClick={()=>openTask(run.taskId!)}>{t('continuous.run.viewTask')}</button>:<button type="button" onClick={()=>{const id=crypto.randomUUID(),next=act({type:'follow',runId:run.id,id,now:new Date().toISOString()}),taskId=next?.continuous.runs.find(item=>item.id===run.id)?.taskId;if(taskId)openTask(taskId)}}>{t('continuous.run.createTask')}</button>}</section>}
  </>
}

function PlanForm({persistent,fallbackFocus,openMarket,draft,roles,patch,close,save,reload}:{persistent:boolean;fallbackFocus:()=>void;openMarket:Props['openMarket'];draft:PlanDraft;roles:PreviewRole[];patch:(fields:PlanFields)=>void;close:()=>void;save:()=>void|Promise<void>;reload:(()=>void)|undefined}){
  const {locale,t}=useI18n()
  const collaborationScopes=useBusinessScopes()
  const ref=useRef<HTMLDialogElement>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  useEffect(()=>{const node=ref.current,previous=document.activeElement instanceof HTMLElement?document.activeElement:null;node?.showModal();node?.querySelector<HTMLInputElement>('input')?.focus();return()=>{node?.close();if(previous?.isConnected&&previous!==document.body&&previous.getClientRects().length)previous.focus();else fallbackFocus()}},[])
  const fields=draft.fields,set=(next:Partial<PlanFields>)=>patch({...fields,...next}),trigger=fields.trigger
  const candidates=roles.filter(role=>canReceiveTask(role,fields.scope)&&(!persistent||role.storage==='persistent'))
  return <dialog className={css.dialog} ref={ref} aria-label={draft.revision?t('continuous.form.editTitle'):t('continuous.form.createTitle')} onCancel={event=>{if(busy)event.preventDefault();else close()}}><form className={css.form} onSubmit={event=>{event.preventDefault();if(busy)return;setBusy(true);setError('');void Promise.resolve().then(save).catch(error=>setError(localizeWorkError(locale,error))).finally(()=>setBusy(false))}}><header><h2>{draft.revision?t('continuous.form.editTitle'):t('continuous.form.createTitle')}</h2><button type="button" aria-label={t('continuous.form.closeAria')} disabled={busy} onClick={close}><X size={18}/></button></header><p>{persistent?t('continuous.form.savedExplanation'):t('continuous.form.sandboxExplanation')}</p>{error&&<p role="alert">{error}</p>}{draft.template&&<PlanTemplateOrigin template={draft.template} open={openMarket}/>}<label>{t('continuous.form.name')}<input required maxLength={120} disabled={busy} value={fields.title} onChange={event=>set({title:event.target.value})}/></label><label>{t('continuous.form.scope')}<select disabled={busy||persistent||!!draft.template&&(!!draft.template.industry||draft.template.scope!=='general')} value={fields.scope} onChange={event=>set({scope:event.target.value as CollaborationScope,...(draft.revision?{}:{roleId:''})})}>{Object.entries(collaborationScopes).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label><label>{t('continuous.form.role')}<select disabled={busy||!!draft.revision} value={fields.roleId} onChange={event=>set({roleId:event.target.value})}><option value="">{t(persistent?'continuous.form.selectSavedRole':'continuous.form.selectRole')}</option>{roles.filter(role=>candidates.includes(role)||role.id===fields.roleId).map(role=><option key={role.id} value={role.id} disabled={!candidates.includes(role)}>{role.name}</option>)}</select></label>{!candidates.length&&<p>{t(persistent?'continuous.form.noSavedRole':'continuous.form.noRole')}</p>}<label>{t('continuous.detail.goal')}<textarea required rows={3} maxLength={8000} disabled={busy} value={fields.goal} onChange={event=>set({goal:event.target.value})}/></label><label>{t('continuous.detail.dataScope')}<textarea required rows={2} maxLength={8000} disabled={busy} value={fields.dataScope} onChange={event=>set({dataScope:event.target.value})}/></label><label>{t('continuous.detail.delivery')}<textarea required rows={2} maxLength={8000} disabled={busy} value={fields.delivery} onChange={event=>set({delivery:event.target.value})}/></label><label>{t('continuous.form.notificationPolicy')}<select required aria-label={t('continuous.form.notificationPolicy')} disabled={busy} value={fields.notificationPolicy??''} onChange={event=>set({notificationPolicy:event.target.value as PlanNotificationPolicy})}><option value="">{t('continuous.form.review')}</option>{planNotificationPolicies.map(policy=><option key={policy} value={policy}>{t(notificationPolicyKeys[policy])}</option>)}</select></label><p>{t('continuous.detail.notification.explanation')}</p><label>{t('continuous.detail.trigger')}<select disabled={busy} value={trigger.kind} onChange={event=>set({trigger:event.target.value==='event'?{kind:'event',source:'',event:''}:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}})}><option value="schedule">{t('continuous.form.schedule')}</option>{!persistent&&<option value="event">{t('continuous.form.event')}</option>}</select></label>
    {trigger.kind==='schedule'?<><div className={own.fields}><label>{t('continuous.form.cadence')}<select disabled={busy} value={trigger.cadence} onChange={event=>set({trigger:{...trigger,cadence:event.target.value as 'daily'|'weekly'}})}><option value="daily">{t('continuous.form.daily')}</option><option value="weekly">{t('continuous.form.weekly')}</option></select></label>{trigger.cadence==='weekly'&&<label>{t('continuous.form.weekday')}<select disabled={busy} value={trigger.weekday} onChange={event=>set({trigger:{...trigger,weekday:Number(event.target.value)}})}>{(['monday','tuesday','wednesday','thursday','friday','saturday','sunday'] as const).map((day,index)=><option key={day} value={index+1}>{t(`continuous.form.weekday.${day}`)}</option>)}</select></label>}<label>{t('continuous.form.time')}<input required type="time" disabled={busy} value={trigger.time} onChange={event=>set({trigger:{...trigger,time:event.target.value}})}/></label></div><label>{t('continuous.form.timezone')}<select disabled={busy} value={trigger.timezone} onChange={event=>set({trigger:{...trigger,timezone:event.target.value}})}><option>Asia/Singapore</option><option>Asia/Shanghai</option><option>UTC</option></select></label><SchedulePreview trigger={trigger}/></>:<><label>{t('continuous.form.eventSource')}<input required maxLength={240} disabled={busy} value={trigger.source} onChange={event=>set({trigger:{...trigger,source:event.target.value}})} placeholder={t('continuous.form.eventSourcePlaceholder')}/></label><label>{t('continuous.form.eventCondition')}<textarea required rows={2} maxLength={1000} disabled={busy} value={trigger.event} onChange={event=>set({trigger:{...trigger,event:event.target.value}})} placeholder={t('continuous.form.eventConditionPlaceholder')}/></label>{persistent&&<p role="alert">{t('continuous.form.eventUnavailable')}</p>}</>}
    {reload&&<details><summary>{t('continuous.form.revisionConflict')}</summary><p>{t('continuous.form.revisionExplanation',{revision:draft.revision??''})}</p><button type="button" onClick={()=>{reload();setError('')}}>{t('continuous.form.reload')}</button></details>}<footer className={css.buttons}><button type="button" disabled={busy} onClick={close}>{t('continuous.form.closeDraft')}</button><button type="submit" disabled={busy||!fields.title.trim()||!fields.goal.trim()||!fields.notificationPolicy||!candidates.some(role=>role.id===fields.roleId)||persistent&&trigger.kind==='event'}>{busy?t('continuous.common.saving'):persistent?t('continuous.form.save'):t('continuous.form.saveDemo')}</button></footer></form></dialog>
}

export function RolePlans({state,id,open,savedPlanIds}:{state:TaskPreview;id:string;open:Props['go'];savedPlanIds?:ReadonlySet<string>}){
  const {t}=useI18n()
  const plans=state.continuous.plans.filter(plan=>plan.fields.roleId===id&&(!savedPlanIds||savedPlanIds.has(plan.id)))
  return <section className={css.block}><h3>{t('navigation.plans')}</h3><p>{t('continuous.rolePlans.count',{count:plans.filter(plan=>!plan.archived).length})}</p><div className={own.list}>{plans.map(plan=><button key={plan.id} type="button" onClick={()=>open({kind:'plan',id:plan.id,roleId:id})}><strong>{plan.fields.title}</strong><StatusLabel label={t(planLifecycle(plan)==='archived'?'status.archived':planLifecycle(plan)==='active'?'status.enabled':'status.paused')} mark={planLifecycle(plan)==='active'?'enabled':planLifecycle(plan)==='paused'?'paused':'retired'} tone={planLifecycle(plan)==='active'?'good':'muted'}/>{plan.enabled&&!plan.archived&&planBlock(plan,state.roles,t)&&<small>{planBlock(plan,state.roles,t)}</small>}</button>)}</div><div className={css.buttons}><button type="button" onClick={()=>open({kind:'plans',roleId:id})}>{t('continuous.rolePlans.manage')}</button><button type="button" onClick={()=>open({kind:'runs',roleId:id})}>{t('continuous.rolePlans.viewRuns')}</button></div><p className={css.muted}>{t('continuous.rolePlans.explanation')}</p></section>
}

function SchedulePreview({trigger}:{trigger:unknown}){
 const {dateTime,t}=useI18n()
 try{
  const next=nextScheduleOccurrence(trigger,new Date().toISOString()),timezone=(trigger as {timezone:string}).timezone
  const text=dateTime(next.at,{timeZone:timezone,dateStyle:'medium',timeStyle:'short'})
  return <p className={own.notice} aria-label={t('continuous.schedulePreview.aria')}>{t('continuous.schedulePreview.text',{time:text,timezone})}</p>
 }catch{return <p className={own.notice}>{t('continuous.schedulePreview.invalid')}</p>}
}
