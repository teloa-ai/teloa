import {BusinessConfigurationSurface,type BusinessConfigurationServices} from './BusinessConfigurationSurface.js'
import type {IndustryPluginInstance} from './industry-plugin-api.js'
import { useBusinessScopes } from './business-scope-context.js'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowLeft, ArrowRight, Clock, Database, ChevronDown, ChevronRight, ListTodo, Pin, PinOff, Users } from 'lucide-react'
import { type CollaborationScope } from './collaboration-preview.js'
import { projectTypeLabel, type BusinessTarget } from './business-preview.js'
import { taskStates, type TaskPreview } from './task-preview.js'
import type {BusinessLedgerApi} from './business-ledger-api.js'
import type {BusinessCustomizationApi} from './business-customization-api.js'
import {BusinessCustomization} from './BusinessCustomization.js'
import type {BusinessShareApi} from './business-share-flow.js'
import {BusinessShareForm} from './BusinessShareForm.js'
import {CreateEntry} from './CreateEntry.js'
import type {BusinessDefinitionPreview,BusinessLedger,BusinessLedgerBlock,BusinessLedgerObject} from '@teloa/contract'
import {BusinessLedgerSurface} from './BusinessLedger.js'
import type {BusinessDashboardApi} from './business-dashboard-api.js'
import {BusinessDashboardPage} from './BusinessDashboardPage.js'
import {BusinessDashboardList} from './BusinessDashboardList.js'
import {businessSectionAwayFromLedger} from './business-page-mode.js'
import {businessCompletedTasks} from './business-current-presentation.js'
import type {IndustryLoadRecord} from './industry-load-api.js'
import type {IndustryDataSourceInstance} from './industry-data-source-api.js'
import type {BusinessScopeLabel} from './business-directory.js'
import {projectIndustryWorkspace,type IndustryWorkspaceProjection} from './industry-workspace-projection.js'
import {businessHomeSources,businessHomeStaff} from './business-home-presentation.js'
import {COMPOSITION_EMPTY_KEYS,COMPOSITION_ROWS,COMPOSITION_STATE_KEYS,composeFromWorkspace,connectorModeLabel,type CompositionSection,type CompositionTarget} from './industry-composition.js'
import base from './TaskPage.module.css'
import css from './BusinessPage.module.css'
import projectionCss from './IndustryWorkspaceSummary.module.css'
import {useI18n} from './i18n/provider.js'
import {ProjectWorkspace} from './ProjectWorkspace.js'
import type {ProjectApi} from './project-api.js'
import {BusinessTaskActionPanel,persistentBusinessTaskAssignees} from './business-task-presentation.js'
import {businessTaskSupports,type BusinessTaskApi,type BusinessTaskRequest,type BusinessTaskResult} from './business-task-api.js'
import type {PageCreateApi} from './page-create-api.js'
import {BusinessMoreMenu,type BusinessMoreAction} from './BusinessMoreMenu.js'

type Props={configuration?:BusinessConfigurationServices;plugins?:readonly IndustryPluginInstance[];projectApi:ProjectApi;openProjectItem:(item:import('@teloa/contract').ProjectItem|import('@teloa/contract').ProjectReferenceItem)=>void|Promise<void>;scopeLabels?:readonly BusinessScopeLabel[];embedded?:boolean;openFull?:()=>void;automations?:number;plans?:readonly {scope:string;state:string;title:string}[];goComposition?:(target:CompositionTarget)=>void;backHome:()=>void;openStaff:(scope:string)=>void;manageIndustryResources:(scope:string)=>void;industryLoads:readonly IndustryLoadRecord[];dataSources:readonly IndustryDataSourceInstance[];visible:boolean;state:TaskPreview;target:BusinessTarget;go:(target:BusinessTarget)=>void;openTask:(id:string)=>void;openWork:()=>void;openMessages:()=>void;openGroups:()=>void;openResources:()=>void;market:(id?:string)=>void;capabilities:(scope:CollaborationScope)=>ReactNode;openPlans:(scope:CollaborationScope)=>void;businessLedgerApi:BusinessLedgerApi;businessCustomizationApi:BusinessCustomizationApi;businessShareApi:BusinessShareApi;pageCreate:{api:PageCreateApi;prepare:(prompt:{sourceId:string;title:string;text:string})=>void;openMarket:()=>void;confirmConnector:(scope:string,preview:import('@teloa/contract').PageCreateDraftPreview)=>Promise<string>;openConnector:(value:string)=>void};businessTaskApi:BusinessTaskApi;createBusinessTask:(request:BusinessTaskRequest)=>Promise<BusinessTaskResult>;recoverBusinessTask:()=>Promise<BusinessTaskResult>;isPinned?:boolean;togglePin?:(target:Pick<BusinessTarget,'scope'|'section'|'dashboardId'>)=>void;businessDashboardApi:BusinessDashboardApi;colorScheme:'light'|'dark'}
const sectionKeys={work:'business.section.work',analysis:'business.section.analysis',execution:'business.section.execution',dashboards:'business.section.dashboards'} as const
const industryReadinessKeys={
 role:'market.industry.directory.needsSetup',
 knowledge:'market.industry.directory.contentRegistered',
 skill:'market.industry.directory.needsReview',
 mcp:'market.industry.directory.needsReview',
 plugin:'market.industry.directory.needsReview',
 'work-template':'market.industry.directory.contentRegistered',
 plan:'market.industry.directory.contentRegistered',
 'data-source':'market.industry.directory.needsSetup',
 'execution-tool':'market.industry.directory.needsSetup',
 // 三类业务定制声明今天走不到这张列表（投影里没有目录落点就整项跳过），这三行只为让这张表对 12 类保持穷尽：
 // 少一类就编译不过，而不是在界面上落一个 undefined。声明是纯内容、登记完即可读，故与知识、任务模板同一句。
 'object-type':'market.industry.directory.contentRegistered',
 'business-view':'market.industry.directory.contentRegistered',
 'business-action':'market.industry.directory.contentRegistered',
} as const

/** 建任务只认固定快照引用：对象类型来自声明的块，其余三项逐字来自台账里那一条对象。 */
function BusinessTaskCreateForm({reference,actionId,roles,api,create,onPendingChange}:{reference:{scope:string;type:string;id:string;version:number;snapshotHash:string};actionId:string;roles:TaskPreview['roles'];api:BusinessTaskApi;create:(request:BusinessTaskRequest)=>Promise<BusinessTaskResult>;onPendingChange:()=>void}){
 const {t}=useI18n()
 const [goal,setGoal]=useState(''),[assignee,setAssignee]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const candidates=persistentBusinessTaskAssignees(roles,reference.scope)
 const submit=async(event:React.FormEvent)=>{event.preventDefault();setBusy(true);setError('');try{await create({requestId:crypto.randomUUID(),reference,goal,actionId,...(assignee?{assignee:{roleId:assignee,expectedVersion:candidates.find(role=>role.id===assignee)!.version}}:{})})}catch{setError(t('business.task.failed'))}finally{setBusy(false);onPendingChange()}}
 return <section className={css.realDataDetail} aria-label={t('business.task.create')}><header><div><span>{t('business.real.pinnedSnapshotPrefix')} {reference.type}</span><h3>{t('business.task.create')}</h3></div></header><p>{t('business.task.description')}</p>{error&&<p className={base.error} role="alert">{error}{api.pending()&&<> {t('business.task.recoverable')}</>}</p>}<form className={base.form} onSubmit={event=>void submit(event)}><label>{t('business.task.goal')}<textarea required rows={3} maxLength={8000} value={goal} placeholder={t('business.task.goalPlaceholder')} onChange={event=>setGoal(event.target.value)}/></label><label>{t('business.task.assignee')}<select value={assignee} onChange={event=>setAssignee(event.target.value)}><option value="">{t('business.task.self')}</option>{candidates.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</select>{!candidates.length&&<small>{t('business.task.noAgent')}</small>}</label><footer className={base.buttons}><button type="submit" disabled={busy||!goal.trim()}>{t('business.task.create')}</button></footer></form></section>
}

function BusinessTaskRecovery({pending,recover,onPendingChange,onError}:{pending:BusinessTaskRequest|undefined;recover:()=>Promise<BusinessTaskResult>;onPendingChange:()=>void;onError:(message:string)=>void}){
 const {t}=useI18n()
 const [busy,setBusy]=useState(false)
 if(!pending)return null
 const resume=async()=>{setBusy(true);onError('');try{await recover()}catch{onError(t('business.task.failed'))}finally{setBusy(false);onPendingChange()}}
 return <section className={css.realDataDetail} aria-label={t('business.task.recover')}><p>{t('business.task.recoveryPending',{type:pending.reference.type,id:pending.reference.id,version:pending.reference.version})}</p><div className={base.buttons}><button type="button" disabled={busy} onClick={()=>void resume()}>{t('business.task.recover')}</button></div></section>
}

/**
 * 真实模式下其余分栏还没有自己的面：照原型 `业务视图.jsx` 的真实模式空态，只说一句差在哪儿、
 * 给一个直接动作（接入数据源），不摆「运营视图」「可读适配器」这类系统词（终审 B6）。
 * 台账那两档（概览与对象目录）自己带五档空态，不再经这里。
 * 动作里的来源名词与首页同一条口径：范围目录只在有效模板声明唯一时给出，
 * 否则回落通用名词。文案始终通过 `{noun}` 参数化，不在这里判断行业。
 */
function BusinessConnectionGuide({connect,sourceNoun}:{connect:()=>void;sourceNoun?:string}){
 const {t}=useI18n(),noun=sourceNoun??t('business.source.noun')
 return <section className={css.connectionGuide} aria-label={t('business.connection.guideAria')}><div><span className={css.kicker}>{t('business.connection.kicker')}</span><h2>{t('business.connection.guideTitle')}</h2><p>{t('business.connection.guideDescription')}</p></div><div className={css.guideAction}><button type="button" onClick={connect}>{t('business.connection.connect',{noun})}</button></div></section>
}

/**
 * 「这个业务有什么」：七行按共享分类模块的固定顺序摆开，每项一句状态词加一个「去配置」。
 * 行标签、副标、状态词与两条空态句全部来自共享模块与词表，这里既不判断行业也不拼中文。
 * 接入源与业务看板空着时各说自己那一句；其余行没有内容就整行不摆。
 */
function BusinessComposition({sections,go}:{sections:readonly CompositionSection[];go:(target:CompositionTarget)=>void}){
 const {t}=useI18n()
 return <details className={css.composition}><summary>{t('business.composition.panel')}<ChevronDown size={13}/></summary><div className={css.compositionRows}>{COMPOSITION_ROWS.map(row=>{
  const section=sections.find(item=>item.id===row.id),empty=COMPOSITION_EMPTY_KEYS[row.id]
  // 看板行可能只有视图、一条对象类型都没有：那也按空态句说话，不摆一个空列表。
  if(!section?.items.length&&!empty)return null
  return <section key={row.id}><h3>{t(row.label)}<small>{t(row.question)}</small></h3>{section?.items.length
   ?<ul>{section.items.map(item=>{const label=connectorModeLabel(item,t);return <li key={item.id}><span>{item.title}{label&&<small>{label}</small>}</span><em>{t(COMPOSITION_STATE_KEYS[item.state])}</em><button type="button" onClick={()=>go(item.go)}>{t('business.composition.configure')}</button></li>})}</ul>
   :<p>{t(empty!)}</p>}</section>
 })}</div></details>
}

/** 历史任务属于次级入口；台账首屏只回答本范围有哪些对象与当前处境。 */
function BusinessHistory({scope,tasks,openTask}:{scope:string;tasks:TaskPreview['tasks'];openTask:(id:string)=>void}){
 const {t}=useI18n(),done=businessCompletedTasks(tasks,scope)
 return <section className={css.current} aria-label={t('business.done.title')}><header className={css.currentHeader}><div><span className={css.kicker}>{t('business.done.eyebrow')}</span><h2>{t('business.done.title')}</h2><p>{t('business.done.description')}</p></div></header>{done.length?<div className={css.currentList}>{done.map(task=><button type="button" key={task.id} onClick={()=>openTask(task.id)}><span className={css.rowIcon}><ListTodo size={17}/></span><span><strong>{task.title}</strong><small>{task.object}</small></span><span className={css.state}>{t(taskStates[task.state])}</span><ChevronRight size={16}/></button>)}</div>:<div className={base.empty}><h3>{t('business.done.empty.title')}</h3><p>{t('business.done.empty.description')}</p></div>}</section>
}

function IndustryResourceDeclarations({rows,label,openPlans}:{rows:readonly IndustryWorkspaceProjection[];label:string;openPlans:(()=>void)|undefined}){
 const {t}=useI18n()
 if(!rows.length)return null
 return <section className={css.industryDeclarations} aria-label={label}><header><div><span className={css.kicker}>{t('business.industry.resources.title')}</span><h2>{label}</h2></div><strong>{rows.length} {t('business.industry.registeredCountSuffix')}</strong></header><div>{rows.map(row=><article key={row.instanceId}><div><h3>{row.title}</h3><p>{row.status==='active'?t('business.industry.ready'):t(industryReadinessKeys[row.kind])}</p></div><span>{row.required?t('business.industry.required'):t('business.industry.optional')}</span><details><summary>{t('business.industry.sourceAndPinnedVersion')}</summary><dl><dt>{t('business.industry.template')}</dt><dd>{row.source.templateTitle} · {row.source.templateId} · v{row.source.templateVersion}</dd><dt>{t('business.industry.resourceInstance')}</dt><dd>{row.instanceId}</dd><dt>{t('business.industry.resourceVersion')}</dt><dd>v{row.version}</dd><dt>{t('business.industry.pinnedContent')}</dt><dd>{row.source.contentHash}</dd></dl></details></article>)}</div>{openPlans&&<button type="button" onClick={openPlans}>{t('business.industry.openContinuousWork')}</button>}<p>{t('business.industry.registrationNotice')}</p></section>
}

function IndustryWorkspaceSummary({resources,sources,manage}:{resources:readonly IndustryWorkspaceProjection[];sources:readonly IndustryLoadRecord[];manage:()=>void}){
 const {t}=useI18n()
 const loaded=sources.filter(source=>source.items.some(item=>item.status!=='skipped'))
 if(!loaded.length&&!resources.length)return null
 return <section className={projectionCss.projection} aria-label={t('business.industry.sourceAndPinnedVersion')}><header><div><span className={css.kicker}>{t('business.industry.projection.eyebrow')}</span><h2>{t('business.industry.sourceAndPinnedVersion')}</h2></div><div className={projectionCss.headerActions}><strong>{resources.length} {t('business.industry.registeredCountSuffix')}</strong><button type="button" onClick={manage}>{t('business.industry.resources.title')}</button></div></header><div className={projectionCss.sources}>{sources.map(source=>{
   const count=source.items.filter(item=>item.status!=='skipped').length
   if(!count)return null
   return <article key={source.id}><div><strong>{source.templateTitle}</strong><small>v{source.templateVersion} · {count} {t('business.industry.itemCountSuffix')}</small></div><details><summary>{t('business.industry.pinnedContent')}</summary><dl><dt>{t('business.industry.template')}</dt><dd>{source.templateId}</dd><dt>{t('business.industry.pinnedContent')}</dt><dd>{source.contentHash}</dd></dl></details></article>
  })}</div></section>
}

export function BusinessPage(props:Props){
 const configuration=props.configuration
 // 已有对象下钻携带真实类型/id/match，继续交台账数据入口，不能按正式首页重新选页。
 if(props.target.section==='data'&&props.target.objectType&&!props.target.recordReference)return <LegacyBusinessPage {...props}/>
 if(!configuration||props.target.scope==='general'||!['overview','data','dashboards'].includes(props.target.section))return <LegacyBusinessPage {...props}/>
 if(!props.visible)return null
 return <BusinessConfigurationSurface scope={props.target.scope} recordReference={props.target.recordReference} services={configuration} colorScheme={props.colorScheme} backHome={props.backHome} go={props.go} {...(props.embedded===undefined?{}:{embedded:props.embedded})} {...(props.openFull?{openFull:props.openFull}:{})} legacy={()=><LegacyBusinessPage {...props}/>}/>
}

function LegacyBusinessPage({plugins,projectApi,openProjectItem,scopeLabels,embedded=false,openFull,automations,plans,goComposition,backHome,openStaff,manageIndustryResources,industryLoads,dataSources,visible,state,target,go,openTask,openWork,openMessages,openGroups,openResources,market,capabilities,openPlans,businessLedgerApi,businessCustomizationApi,businessShareApi,pageCreate,businessTaskApi,createBusinessTask,recoverBusinessTask,isPinned=false,togglePin,businessDashboardApi,colorScheme}:Props){
  const {t,number}=useI18n()
  const collaborationScopes=useBusinessScopes()
  const sourceNoun=scopeLabels?.find(label=>label.scope===target.scope)?.sourceNoun
  const [taskError,setTaskError]=useState(''),[,refreshPending]=useState(0),[ledgerRevision,setLedgerRevision]=useState(0)
  const [ledger,setLedger]=useState<BusinessLedger|undefined>(undefined)
  // 低频配置不挤占首页，统一从「更多」按需展开。
  const [ledgerTool,setLedgerTool]=useState<'resources'|'definition'|'connector'|'customization'|'share'|null>(null)
  const scroll=useRef<HTMLDivElement>(null),positions=useRef<Record<string,number>>({})
  const routeKey=JSON.stringify([target.scope,target.section,target.id,target.objectType,target.dashboardId])
  useLayoutEffect(()=>{if(visible&&scroll.current)scroll.current.scrollTop=positions.current[routeKey]||0},[visible,routeKey])
  /**
   * 「这个业务有什么」的看板行要说真实台账里的事实（有没有数据、缺不缺字段、来源接没接上），
   * 所以这一层自己读一次整个范围的台账：台账那块在 `BusinessLedgerSurface` 里读，且会被 `objectType` 收窄成一类，
   * 拿它的结果当面板数据会漏块，因此宁可在这里按范围读一次全量。刷新键与台账工具一致（`ledgerRevision`），
   * 一个范围一次请求，不随分栏或选中的对象重来。读不出来就保持 undefined，面板照旧按加载声明回落。
   */
  useEffect(()=>{
   if(!visible)return
   const controller=new AbortController()
   void businessLedgerApi.read({scope:target.scope},controller.signal).then(
    value=>{if(!controller.signal.aborted)setLedger(value)},
    ()=>{if(!controller.signal.aborted)setLedger(undefined)},
   )
   return ()=>controller.abort()
  },[businessLedgerApi,target.scope,ledgerRevision,visible])
  if(!visible)return null
  const navigate=(next:BusinessTarget)=>go(next)
  const section=(section:BusinessTarget['section'],id?:string,dashboardId?:string)=>navigate({scope:target.scope,section,...(id?{id}:{}),...(dashboardId?{dashboardId}:{})})
  const pinTarget={scope:target.scope,section:target.section,...(target.section==='dashboards'&&target.dashboardId?{dashboardId:target.dashboardId}:{})}
  const toggleLedgerTool=(tool:NonNullable<typeof ledgerTool>)=>{section('overview');setLedgerTool(current=>current===tool?null:tool)}
  const chooseMore=(action:BusinessMoreAction,scope:string)=>{
   if(scope!==target.scope)return
   if(action==='work')openWork()
   else if(action==='completed')section('work')
   else if(action==='dashboards')section('dashboards')
   else if(action==='automations')openPlans(scope)
   else toggleLedgerTool(action==='adjustment'?'definition':action==='connector'?'connector':action==='sources'?'resources':action==='manual-definition'?'customization':'share')
  }
  const pendingBusinessTask=businessTaskApi.pending()
  const businessTaskPanel=(reference?:{scope:string;type:string;id:string;version:number;snapshotHash:string},actionId?:string)=><BusinessTaskActionPanel pending={!!pendingBusinessTask} error={taskError?<p className={base.error} role="alert">{taskError}{pendingBusinessTask&&<> {t('business.task.recoverable')}</>}</p>:null} recovery={<BusinessTaskRecovery pending={pendingBusinessTask} recover={recoverBusinessTask} onError={setTaskError} onPendingChange={()=>refreshPending(value=>value+1)}/>} creation={reference&&actionId?<BusinessTaskCreateForm reference={reference} actionId={actionId} roles={state.roles} api={businessTaskApi} create={createBusinessTask} onPendingChange={()=>refreshPending(value=>value+1)}/>:null}/>
  /**
   * 动作入口只采信服务端计算的能力位，并把当前范围带到创建请求里。
   * 换行业声明时客户端不维护白名单，服务端仍会复核范围和已登记的定义。
   */
  const ledgerObjectActions=(selectedItem:BusinessLedgerObject,objectType:string,block:BusinessLedgerBlock)=>
    businessTaskSupports(target.scope,block)?businessTaskPanel({scope:target.scope,type:objectType,id:selectedItem.id,version:selectedItem.version,snapshotHash:selectedItem.snapshotHash},block.defaultAction!.actionId):null
  const applyPageCreatedDefinition=async(preview:BusinessDefinitionPreview):Promise<string>=>{
   const directory=await businessCustomizationApi.directory({scope:target.scope})
   const current=directory.entries.find(entry=>entry.kind===preview.draft.kind&&entry.localId===preview.draft.localId)?.current?.version??0
   const entry=await businessCustomizationApi.apply({requestId:crypto.randomUUID(),draftId:preview.draft.id,expectedDefinitionHash:preview.draft.definitionHash,expectedCurrentVersion:current,previewReceipt:preview.receipt})
   setLedgerRevision(value=>value+1)
   return entry.kind+':'+entry.localId+':'+String(entry.current?.version??0)
  }
  const renderPageCreatedDefinition=(preview:BusinessDefinitionPreview)=><section className={css.createPreview} aria-label={t('business.custom.title')}><h4>{t('business.custom.preview.diff')}</h4><dl>{preview.diff.map(row=><div key={row.path}><dt>{row.path}</dt><dd><del>{row.before??'—'}</del><ins>{row.after??'—'}</ins></dd></div>)}</dl><h4>{t('business.custom.preview.impact')}</h4><p>{preview.impact.objectType}{preview.impact.fields.length?' · '+preview.impact.fields.join(', '):''}</p>{preview.trialUnavailable&&<p className={base.muted}>{t('business.custom.trialUnavailable')}</p>}</section>
  const workspaceResources=projectIndustryWorkspace(industryLoads,{scope:target.scope}),dataDeclarations=workspaceResources.filter(row=>row.destination==='business-data'),executionDeclarations=workspaceResources.filter(row=>row.destination==='business-execution'),workspaceSources=industryLoads.filter(load=>load.space.scope===target.scope)
  // 面板与业务台账首页卡的摘要读同一份七行；台账还没回话（或换了范围、上一份还是旧范围的）时按加载声明说话。
  const compositionSections=composeFromWorkspace({plugins,scope:target.scope,loads:industryLoads,roles:state.roles,...(ledger?{ledger}:{}),...(plans?{plans}:{})})
  const projectTypeName=projectTypeLabel(target.scope,t)
  const ledgerVisible=target.section==='overview'||target.section==='data'
  return <section className={clsx(base.page,css.page,embedded&&css.embeddedPage)} aria-label={t('business.scope.pageAria')}>
    <div className={css.content} ref={scroll} onScroll={event=>{positions.current[routeKey]=event.currentTarget.scrollTop}}><div className={css.container}>
      <header className={css.pageHeader}><div>{!embedded&&<button type="button" className={css.backHome} onClick={backHome}><ArrowLeft size={14}/>{t('business.scope.backHome')}</button>}<h1>{collaborationScopes[target.scope]||target.scope}</h1></div>{!embedded&&togglePin&&<button type="button" className={css.pinShortcut} aria-pressed={isPinned} onClick={()=>togglePin(pinTarget)}>{isPinned?<PinOff size={14}/>:<Pin size={14}/>} {t(isPinned?'navigation.shortcut.unpin':pinTarget.dashboardId?'business.dashboards.pin':'navigation.shortcut.pin')}</button>}{embedded&&openFull&&<button type="button" className={css.openFull} onClick={openFull}>{t('business.scope.openFull')}</button>}</header>
      <section className={css.scopeBar} aria-label={t('business.scope.barAria')}><dl className={css.scopeStats}><div className={css.scopeStat}><dt><Database size={14}/>{t('business.scope.stat.sources')}</dt><dd>{t('business.scope.stat.sourcesValue',{n:number(businessHomeSources(dataSources,target.scope))})}</dd></div><div className={css.scopeStat}><dt><Users size={14}/>{t('business.scope.stat.staff')}</dt><dd>{t('business.scope.stat.staffValue',{n:number(businessHomeStaff(state.roles,target.scope).length)})}</dd></div>{automations!==undefined&&<div className={css.scopeStat}><dt><Clock size={14}/>{t('business.scope.stat.automations')}</dt><dd>{t('business.scope.stat.automationsValue',{n:number(automations)})}</dd></div>}</dl>{goComposition&&<BusinessComposition sections={compositionSections} go={goComposition}/>}{!embedded&&<button type="button" className={css.scopeStaff} onClick={()=>openStaff(target.scope)}>{t('business.home.staff')}<ArrowRight size={14}/></button>}{!embedded&&<button type="button" className={css.scopeStaff} aria-pressed={target.section==='projects'} onClick={()=>section('projects')}>{projectTypeName}</button>}<BusinessMoreMenu scope={target.scope} choose={chooseMore}/></section>
      <div className={css.viewBody}>
      {target.section==='execution'&&<IndustryResourceDeclarations rows={executionDeclarations} label={t('business.industry.loadedExecutionToolDeclarations')} openPlans={undefined}/>}
      {businessSectionAwayFromLedger(target.section)&&<button type="button" className={css.backLedger} onClick={()=>section('overview')}><ArrowLeft size={14}/>{t('business.section.backLedger')}</button>}
      {target.section==='projects'&&<ProjectWorkspace key={target.scope} api={projectApi} scope={target.scope} {...(target.id?{selectedId:target.id}:{})} typeName={projectTypeName} scopeLabels={scopeLabels??[]} select={(id,scope)=>navigate({scope:(scope??target.scope) as CollaborationScope,section:'projects',id})} back={()=>section('projects')} openItem={openProjectItem}/>}
      {target.section==='overview'&&<>{ledgerTool==='resources'&&<><IndustryWorkspaceSummary resources={workspaceResources} sources={workspaceSources} manage={()=>manageIndustryResources(target.scope)}/>{dataDeclarations.length>0&&<IndustryResourceDeclarations rows={dataDeclarations} label={t('business.industry.loadedDataSourceDeclarations')} openPlans={undefined}/>} {workspaceResources.length>0&&<section className={css.workEnvironment} aria-label={t('business.capabilities.bindingsAria')}>{capabilities(target.scope)}</section>}</>} {ledgerTool==='definition'&&<CreateEntry entity="business-definition" titleKey="create.title.businessDefinition" scope={target.scope} api={pageCreate.api} prepare={pageCreate.prepare} openMarket={pageCreate.openMarket} onConfirm={preview=>{if(!preview.businessPreview)throw Error(t('business.custom.readFailed'));return applyPageCreatedDefinition(preview.businessPreview)}} renderBusinessPreview={renderPageCreatedDefinition}/>} {ledgerTool==='connector'&&<CreateEntry entity="connector" titleKey="create.title.connector" scope={target.scope} api={pageCreate.api} prepare={pageCreate.prepare} openMarket={pageCreate.openMarket} onConfirm={preview=>pageCreate.confirmConnector(target.scope,preview)} afterConfirm={pageCreate.openConnector}/>} {ledgerTool==='customization'&&<BusinessCustomization scope={target.scope} api={businessCustomizationApi} changed={()=>setLedgerRevision(value=>value+1)} colorScheme={colorScheme}/>} {ledgerTool==='share'&&<BusinessShareForm scope={target.scope} api={businessShareApi} openMarket={market}/>}</>}
      {ledgerVisible&&<BusinessLedgerSurface refreshKey={ledgerRevision} scope={target.scope} {...(target.objectType?{objectType:target.objectType}:{})} {...(target.id?{objectId:target.id}:{})} {...(target.match?{match:target.match}:{})} api={businessLedgerApi} go={navigate} connect={()=>manageIndustryResources(target.scope)} objectActions={ledgerObjectActions} empty={<div className={base.empty} aria-label={t('business.ledger.title')}><h2>{t('business.ledger.empty.types')}</h2><p>{t('business.ledger.empty.typesHint')}</p><button type="button" onClick={()=>manageIndustryResources(target.scope)}>{t('business.home.connect',{noun:sourceNoun??t('business.source.noun')})}</button></div>}/>}
      {target.section==='work'&&<BusinessHistory scope={target.scope} tasks={state.tasks} openTask={openTask}/>}
      {target.section==='dashboards'&&(target.dashboardId
       ?<BusinessDashboardPage key={JSON.stringify([target.scope,target.dashboardId])} scope={target.scope} dashboardId={target.dashboardId} api={businessDashboardApi} ledger={ledger} colorScheme={colorScheme} back={()=>section('dashboards')} go={navigate}/>
       :<BusinessDashboardList scope={target.scope} api={businessDashboardApi} customization={businessCustomizationApi} open={id=>section('dashboards',undefined,id)} openDrafts={()=>toggleLedgerTool('customization')}/>)}
      {target.section!=='overview'&&target.section!=='data'&&target.section!=='work'&&target.section!=='projects'&&target.section!=='dashboards'&&<BusinessConnectionGuide {...(sourceNoun===undefined?{}:{sourceNoun})} connect={()=>manageIndustryResources(target.scope)}/>}
      </div>
    </div></div>
  </section>
}
