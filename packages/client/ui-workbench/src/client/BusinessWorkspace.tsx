import {useEffect,useState,type ReactNode} from 'react'
import {ArrowLeft,ArrowUpRight,BarChart3,MessageSquare,MessageSquarePlus,Plus,RefreshCw,Settings2,Users,Pin,PinOff} from 'lucide-react'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import type {BusinessDashboardSummary,Group} from '@teloa/contract'
import type {GroupApi} from './group-api.js'
import type {BusinessDashboardApi} from './business-dashboard-api.js'
import type {BusinessTarget} from './business-preview.js'
import type {TaskPreview,PreviewTask} from './task-preview.js'
import {taskStates} from './task-preview.js'
import {attentionReasonText,type AttentionItem} from './attention-item.js'
import {businessWorkspaceProjection,businessWorkspaceGroups,businessWorkspaceSections,businessWorkspaceSection} from './business-workspace-presentation.js'
import {businessWorkspaceText} from './business-workspace-copy.js'
import {ContextDrawer} from './ContextDrawer.js'
import {BusinessTeamCollaboration} from './BusinessTeamCollaboration.js'
import type {TeamCollaborationServices} from './business-team-collaboration.js'
import {BusinessTeamOrganization} from './BusinessTeamOrganization.js'
import type {BusinessResponsibilityProps} from './BusinessResponsibility.js'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {BusinessDashboardPage} from './BusinessDashboardPage.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessWorkspace.module.css'
import {businessDashboardReadFailure} from './business-dashboard-errors.js'
import type {BusinessBuilderApi} from './business-builder-api.js'
import type {BusinessConfigurationPageProjectionVersioned} from '@teloa/contract'
import {readBusinessConfigurationSavedPage} from './business-configuration-surface.js'
import {BusinessSavedRecordPreview,BusinessConfigurationPage} from './BusinessConfigurationPage.js'
import {BusinessConfigurationDetails,type BusinessConfigurationServices} from './BusinessConfigurationSurface.js'

export type BusinessWorkspaceServices={collaboration?:Omit<TeamCollaborationServices,'groups'|'records'>|undefined;start?:(()=>void)|undefined;newConversation?:(()=>void)|undefined;actionReady?:boolean|undefined;conversationStatus?:ReactNode;responsibility?:Omit<BusinessResponsibilityProps,'scope'>|undefined;groups:GroupApi;openGroup:(id:string)=>void;createGroup:(scope:string)=>void;talkRole:(id:string)=>Promise<unknown>;attention:readonly AttentionItem[];openAttention:(item:AttentionItem)=>void;tasksKnown:boolean;tasksFailed:boolean;rolesKnown:boolean;rolesFailed:boolean;renderRole:(id:string,close:()=>void)=>ReactNode;attentionKnown:boolean;attentionFailed:boolean;refresh:()=>void}
type Props={recordChanges?:ReactNode;services:BusinessWorkspaceServices;scope:string;title:string;target:BusinessTarget;state:TaskPreview;go:(target:BusinessTarget)=>void;back:()=>void;start:()=>void;configure:()=>void;staff:()=>void;openTask:(id:string)=>void;openWork:()=>void;dashboardApi:BusinessDashboardApi;configurationApi?:ConfigurationApi|undefined;configurationServices?:BusinessConfigurationServices|undefined;colorScheme:'light'|'dark';children:ReactNode;embedded?:boolean|undefined;openFull?:(()=>void)|undefined;pinned?:boolean|undefined;togglePin?:((target:Pick<BusinessTarget,'scope'|'section'|'dashboardId'>)=>void)|undefined}
type Directory<T>={status:'loading'}|{status:'failed';failure?:ReturnType<typeof businessDashboardReadFailure>}|{status:'ready';items:T[]}
type ConfigurationApi=Pick<BusinessBuilderApi,'current'|'page'>
type SummaryProps={scope:string;revision:number;dashboardApi:BusinessDashboardApi;configurationApi?:ConfigurationApi|undefined;configurationServices?:BusinessConfigurationServices|undefined;colorScheme:'light'|'dark';go:(target:BusinessTarget)=>void;open:()=>void;notice:(status:'loading'|'failed',failure?:ReturnType<typeof businessDashboardReadFailure>)=>ReactNode;empty:ReactNode}
type ConfiguredSummary={status:'loading'}|{status:'legacy'}|{status:'failed'}|{status:'empty'}|{status:'ready';api:ConfigurationApi;page:BusinessConfigurationPageProjectionVersioned;current:NonNullable<Awaited<ReturnType<BusinessBuilderApi['current']>>>}

/** 旧业务（没有整体配置）：沿用旧看板服务，内嵌第一张看板。 */
function LegacyDashboardSummary({scope,revision,dashboardApi,colorScheme,go,open,notice,empty}:SummaryProps){
 const [dashboards,setDashboards]=useState<Directory<BusinessDashboardSummary>>({status:'loading'})
 useEffect(()=>{
  const controller=new AbortController();setDashboards({status:'loading'})
  void dashboardApi.list({scope},controller.signal).then(items=>{if(!controller.signal.aborted)setDashboards({status:'ready',items})},error=>{if(!controller.signal.aborted)setDashboards({status:'failed',failure:businessDashboardReadFailure(error,'business.dashboards.readFailed')})})
  return()=>controller.abort()
 },[dashboardApi,scope,revision])
 if(dashboards.status!=='ready')return <>{notice(dashboards.status,dashboards.status==='failed'?dashboards.failure:undefined)}</>
 return dashboards.items[0]?<BusinessDashboardPage key={dashboards.items[0].id} scope={scope} dashboardId={dashboards.items[0].id} api={dashboardApi} colorScheme={colorScheme} back={open} go={go}/>:<>{empty}</>
}

/**
 * 总览统计摘要：由整体配置管理的业务与「统计看板」分区同源，读取正式配置的看板页（首页是看板则用首页，否则第一张看板页），
 * 只渲染页面内容，不重复完整页头部与导航，也不改写用户在分区里记住的页面。current===null 才交回旧看板服务。
 */
function DashboardSummary(props:SummaryProps){
 const {configurationApi,scope,revision}=props
 const [state,setState]=useState<ConfiguredSummary>({status:configurationApi?'loading':'legacy'})
 useEffect(()=>{
  if(!configurationApi){setState({status:'legacy'});return}
  const controller=new AbortController(),{signal}=controller
  setState({status:'loading'})
  void (async()=>{
   const current=await configurationApi.current({scope},signal)
   if(signal.aborted)return
   if(current===null){setState({status:'legacy'});return}
   if(current.scope!==scope)throw Error('正式业务配置与当前业务不一致。')
   const dashboards=current.manifest.pages.filter(page=>page.kind==='dashboard')
   const pageId=(dashboards.find(page=>page.id===current.manifest.homePageId)??dashboards[0])?.id
   if(!pageId){setState({status:'empty'});return}
   const page=await readBusinessConfigurationSavedPage(configurationApi,scope,current,pageId,signal)
   if(!signal.aborted)setState({status:'ready',api:configurationApi,page,current})
  })().catch(()=>{if(!signal.aborted)setState({status:'failed'})})
  return()=>controller.abort()
 },[configurationApi,scope,revision])
 if(state.status==='legacy')return <LegacyDashboardSummary {...props}/>
 if(state.status==='loading'||state.status==='failed')return <>{props.notice(state.status)}</>
 if(state.status==='empty')return <>{props.empty}</>
 if(state.api!==configurationApi||state.page.scope!==scope)return <>{props.notice('loading')}</>
 const services=props.configurationServices?.api===configurationApi?props.configurationServices:undefined
 return <BusinessConfigurationPage projection={state.page} colorScheme={props.colorScheme} go={props.go} {...(services?{recordFlow:services.records,taskList:services.taskList}:{})} recordSource={{api:configurationApi,current:state.current}}/>
}

/** 不同业务入口引用同一平台对象；换业务时重建，异步旧回包不能落到新范围。 */
export function BusinessWorkspace({services,scope,title,target,state,go,back,start,configure,staff,openTask,openWork,dashboardApi,configurationApi,configurationServices,colorScheme,children,recordChanges,embedded,openFull,pinned,togglePin}:Props){
 const {t,locale,number,dateTime}=useI18n(),text=(key:Parameters<typeof businessWorkspaceText>[1])=>businessWorkspaceText(locale,key)
 const section=businessWorkspaceSection(scope,target.section),tabs=businessWorkspaceSections(scope),hasBusinessData=scope!=='general'
 const rows=businessWorkspaceProjection(scope,state.tasks,state.roles,services.attention)
 useEffect(()=>{if(section!==target.section)go({scope,section})},[scope,section,target.section,go])
 const [groups,setGroups]=useState<Directory<Group>>({status:'loading'}),[revision,setRevision]=useState(0),[chatError,setChatError]=useState(false),[profileId,setProfileId]=useState<string>()
 const [configurationSettings,setConfigurationSettings]=useState<{scope:string;open:boolean}>()
 useEffect(()=>setConfigurationSettings(undefined),[scope])
 const openSettings=()=>configurationServices?setConfigurationSettings({scope,open:true}):configure()
 useEffect(()=>{
  let active=true;setGroups({status:'loading'})
  void services.groups.list().then(value=>{if(active)setGroups({status:'ready',items:businessWorkspaceGroups(value.items,scope)})},()=>{if(active)setGroups({status:'failed'})})
  return()=>{active=false}
 },[services.groups,scope,revision])
 const [collaborationEnabled,setCollaborationEnabled]=useState(false)
 useEffect(()=>{let active=true;setCollaborationEnabled(false);if(!hasBusinessData||!services.collaboration||groups.status!=='ready')return
  void Promise.all(groups.items.map(group=>services.groups.resources(group.id))).then(values=>{if(active)setCollaborationEnabled(values.some(value=>value.items.some(resource=>resource.title==='AI 团队协作交付'&&!resource.withdrawnAt)))},()=>{if(active)setCollaborationEnabled(false)});return()=>{active=false}
 },[scope,hasBusinessData,services.collaboration?.tasks,services.groups,groups,revision])
 const openRole=(id:string)=>setProfileId(id)
 const navigate=(section:BusinessTarget['section'])=>go({scope,section})
 const reload=()=>{services.refresh();setRevision(value=>value+1)}
 const loading=(known:boolean,count:number)=>known?number(count):'—'
 const notice=(status:'loading'|'failed',failure?:ReturnType<typeof businessDashboardReadFailure>)=><div className={css.notice} role={status==='failed'?'alert':'status'}>{failure?t(failure.key,'params' in failure?failure.params:undefined):text(status==='failed'?'failed':'loading')}{status==='failed'&&(!failure||failure.retryable)&&<button type="button" onClick={reload}>{text('retry')}</button>}</div>
 const taskRows=(tasks:readonly PreviewTask[])=><div className={css.tableWrap}><table className={css.table}><thead><tr><th>{text('task')}</th><th>{text('employee')}</th><th>{text('state')}</th><th>{text('updated')}</th></tr></thead><tbody>{tasks.map(task=>{const role=state.roles.find(role=>role.id===task.assigneeId);return <tr key={task.id}><td><button type="button" onClick={()=>openTask(task.id)}>{task.title}<ArrowUpRight size={13}/></button></td><td>{role?<button type="button" onClick={()=>openRole(role.id)}><EmployeeAvatar avatarKey={role.avatarKey} size="sm"/>{role.name}</button>:text('unassigned')}</td><td><span className={css.status} data-state={task.state}>{t(taskStates[task.state])}</span></td><td>{dateTime(task.updatedAt,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</td></tr>})}</tbody></table></div>
 /** 平铺名单：员工、在岗/暂停、当前工作、对话各占一列；任务未知时只显示未知，不推断空闲。 */
 const currentWork=(roleId:string)=>{
  if(!services.tasksKnown){const label=text(services.tasksFailed?'failed':'loading');return <span className={css.none} title={label}><span aria-hidden="true">—</span><span className={css.srOnly}>{label}</span></span>}
  const work=rows.current.filter(task=>task.assigneeId===roleId)
  return work[0]?<button type="button" className={css.workLink} title={work[0].title} onClick={()=>openTask(work[0]!.id)}><span>{work[0].title}</span>{work.length>1&&<small>{text('workCount').replace('{count}',number(work.length))}</small>}<ArrowUpRight size={13}/></button>:<span className={css.none} title={text('noWork')}><span aria-hidden="true">—</span><span className={css.srOnly}>{text('noWork')}</span></span>
 }
 const employees=(compact=false)=><>{!services.rolesKnown?notice(services.rolesFailed?'failed':'loading'):rows.roles.length?<>{!compact&&!services.tasksKnown&&services.tasksFailed&&notice('failed')}<ul className={css.roster}><li role="presentation" aria-hidden="true" className={css.rosterLabels}><span>{text('employees')}</span><span>{text('state')}</span><span>{text('work')}</span><span>{text('talk')}</span></li>{(compact?rows.roles.slice(0,4):rows.roles).map(role=><li className={css.member} key={role.id}><button type="button" className={css.identity} title={role.duty||undefined} onClick={()=>openRole(role.id)}><EmployeeAvatar avatarKey={role.avatarKey} size="md"/><span><strong>{role.name}</strong>{role.duty&&<small>{role.duty}</small>}</span></button><span className={css.status} data-state={role.state}>{text(role.state==='paused'?'paused':'working')}</span><div className={css.memberWork}>{currentWork(role.id)}</div><ToolbarIconButton className={css.talk} label={`${text('talk')} · ${role.name}`} icon={MessageSquare} onClick={()=>{setChatError(false);void services.talkRole(role.id).catch(()=>setChatError(true))}}/></li>)}</ul></>:<div className={css.empty}><Users size={22}/><strong>{text('emptyStaff')}</strong><button type="button" onClick={staff}>{text('manageStaff')}</button></div>}{chatError&&<p className={css.notice} role="alert">{text('failed')} <button type="button" onClick={staff}>{text('manageStaff')}</button></p>}</>
 const groupList=groups.status!=='ready'?notice(groups.status):groups.items.length?<div className={css.groupList}>{groups.items.map(group=><button type="button" key={group.id} onClick={()=>services.openGroup(group.id)}><span className={css.groupIcon}><Users size={18}/></span><span><strong>{group.name}</strong><small>{group.announcement||title} · {dateTime(group.updatedAt,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</small></span><ArrowUpRight size={15}/></button>)}</div>:<div className={css.empty}><Users size={22}/><strong>{text('emptyGroups')}</strong><button type="button" onClick={()=>services.createGroup(scope)}><Plus size={14}/>{text('createGroup')}</button></div>
 const active=tabs.some(value=>value===section)?section:section==='work'?'overview':'data'
 const overview=({collaboration,review,reviewCount=0,reviewKnown=true,reviewFailed=false}:{collaboration?:ReactNode;review?:ReactNode;reviewCount?:number;reviewKnown?:boolean;reviewFailed?:boolean}={})=><>{recordChanges}
   <div className={css.metrics}>{([{key:'current',count:rows.current.length,known:services.tasksKnown,action:openWork},{key:'attention',count:rows.attention.length+reviewCount,known:services.attentionKnown&&reviewKnown,action:()=>document.getElementById(`business-attention-${scope}`)?.scrollIntoView({block:'nearest'})},{key:'completed',count:rows.completed.length,known:services.tasksKnown,action:()=>navigate('work')},{key:'active',count:rows.roles.filter(role=>role.state==='active').length,known:services.rolesKnown,action:()=>navigate('employees')}] as const).map(metric=><button type="button" key={metric.key} onClick={metric.action}><span>{text(metric.key)}<ArrowUpRight size={13}/></span><strong>{loading(metric.known,metric.count)}</strong></button>)}</div>
   {collaboration}<section className={css.panel}><header><h2>{text('progress')}</h2><button type="button" onClick={()=>navigate('employees')}>{text('all')}<ArrowUpRight size={13}/></button></header>{employees(true)}</section>
   <div className={css.columns}><section className={css.panel}><header><h2>{text('work')}</h2><button type="button" onClick={openWork}>{text('all')}<ArrowUpRight size={13}/></button></header>{!services.tasksKnown?notice(services.tasksFailed?'failed':'loading'):rows.current.length?taskRows(rows.current.slice(0,8)):<div className={css.empty}><strong>{text('emptyWork')}</strong><button type="button" onClick={start}><Plus size={14}/>{text('start')}</button></div>}</section><section className={css.panel} id={`business-attention-${scope}`}><header><h2>{text('attention')}</h2></header>{review}{!reviewKnown?notice(reviewFailed?'failed':'loading'):!services.attentionKnown?notice(services.attentionFailed?'failed':'loading'):rows.attention.length||reviewCount?<><div className={css.groupList}>{rows.attention.slice(0,6).map(item=><button type="button" key={item.id} onClick={()=>services.openAttention(item)}><span><strong>{item.title}</strong><small>{attentionReasonText(item.reason,key=>t(key))}</small></span><ArrowUpRight size={14}/></button>)}</div></>:<div className={css.empty}><span>{text('emptyAttention')}</span></div>}</section></div>
   {hasBusinessData&&<section className={css.panel}><header><h2>{text('dashboards')}</h2><button type="button" onClick={()=>navigate('dashboards')}>{text('all')}<ArrowUpRight size={13}/></button></header><DashboardSummary scope={scope} revision={revision} dashboardApi={dashboardApi} configurationApi={configurationApi} configurationServices={configurationServices} colorScheme={colorScheme} go={go} open={()=>navigate('dashboards')} notice={notice} empty={<div className={css.empty}><BarChart3 size={22}/><strong>{text('dashboardEmpty')}</strong><button type="button" onClick={()=>navigate('dashboards')}>{text('prepareDashboard')}</button></div>}/></section>}
</>
 return <section className={css.workspace} aria-label={title}><div className={css.scroll}><div className={css.container}>
  <header className={css.header}><div>{!embedded&&<button type="button" className={css.back} onClick={back}><ArrowLeft size={14}/>{t('business.scope.backHome')}</button>}<h1>{title}</h1></div><div className={css.actions}><button type="button" className={css.primary} disabled={services.actionReady===false} onClick={start}><Plus size={15}/>{text('start')}</button>{services.newConversation&&<ToolbarIconButton label={text('newConversation')} icon={MessageSquarePlus} disabled={services.actionReady===false} onClick={services.newConversation}/>}<button type="button" aria-label={text('createGroup')} title={text('createGroup')} onClick={()=>services.createGroup(scope)}><Users size={16}/></button>{hasBusinessData&&<button type="button" aria-label={text('configure')} title={text('configure')} onClick={openSettings}><Settings2 size={16}/></button>}<button type="button" aria-label={text('refresh')} title={text('refresh')} onClick={reload}><RefreshCw size={16}/></button>{togglePin&&!embedded&&<button type="button" aria-label={t(pinned?'navigation.shortcut.unpin':'navigation.shortcut.pin')} title={t(pinned?'navigation.shortcut.unpin':'navigation.shortcut.pin')} aria-pressed={pinned} onClick={()=>togglePin({scope,section:target.section,...(target.dashboardId?{dashboardId:target.dashboardId}:{})})}>{pinned?<PinOff size={16}/>:<Pin size={16}/>}</button>}{embedded&&openFull&&<ToolbarIconButton label={t('business.scope.openFull')} icon={ArrowUpRight} onClick={openFull}/>}</div></header>
  <nav className={css.tabs} aria-label={t('business.configuration.pages')}>{tabs.map(section=><button type="button" key={section} aria-current={active===section?'page':undefined} onClick={()=>navigate(section)}>{text(section)}</button>)}</nav>
  {section==='overview'?<>{services.conversationStatus}{hasBusinessData&&collaborationEnabled&&services.collaboration&&groups.status==='ready'?<BusinessTeamCollaboration title={title} scope={scope} groups={groups.items} api={{...services.collaboration,groups:services.groups,records:configurationServices?.records.api}} roles={rows.roles} revision={revision} openRole={openRole} openGroup={services.openGroup} openTask={openTask} openArtifact={configurationServices?.taskList?.openArtifact} go={go} renderRecord={configurationServices?((record,close)=><BusinessSavedRecordPreview key={JSON.stringify([record.type,record.id,record.version,record.snapshotHash])} record={record} api={configurationServices.api} flow={configurationServices.records} taskList={configurationServices.taskList} go={go} close={close}/>):undefined} renderOverview={overview}/>:overview()}
  </>:section==='employees'?<section className={`${css.panel} ${css.plain}`}><header><h2>{services.rolesKnown?text('staffCount').replace('{count}',number(rows.roles.length)):text('employees')}</h2><div className={css.teamActions}>{services.rolesKnown&&rows.roles.length>0&&<BusinessTeamOrganization scope={scope} title={title} roles={rows.roles} responsibility={hasBusinessData?services.responsibility:undefined} openRole={openRole}/>}<button type="button" onClick={staff}>{text('manageStaff')}<ArrowUpRight size={13}/></button></div></header>{employees()}</section>:section==='groups'?<section className={css.panel}><header><h2>{text('groups')}</h2><button type="button" aria-label={text('createGroup')} onClick={()=>services.createGroup(scope)}><Plus size={16}/></button></header>{groupList}</section>:section==='work'?<section className={css.panel}><header><h2>{text('history')}</h2></header>{!services.tasksKnown?notice(services.tasksFailed?'failed':'loading'):rows.completed.length?taskRows(rows.completed):<div className={css.empty}>{text('idle')}</div>}</section>:children}
 </div></div>{configurationServices&&configurationSettings?.scope===scope&&<BusinessConfigurationDetails key={scope} scope={scope} services={configurationServices} open={configurationSettings.open} close={()=>setConfigurationSettings({scope,open:false})} legacy={configure} includeShare/>} {profileId&&<ContextDrawer title={state.roles.find(role=>role.id===profileId)?.name??text('employees')} close={()=>setProfileId(undefined)}>{services.renderRole(profileId,()=>setProfileId(undefined))}</ContextDrawer>}</section>
}
