import {taskStatusMark} from './status-presentation.js'
import {canEditTaskGoal,taskGoalText} from './group-task-source-presentation.js'
import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react'
import {ArrowUpRight,ChevronRight,FileText,UserRound,X,Maximize2,Minimize2} from 'lucide-react'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import {TaskCompletion,type TaskCompletionPort} from './TaskCompletion.js'
import {taskInputsStale,assertTaskInputsCurrent,hasTaskInputs,type TaskInputFields,type TaskInputDraft} from './task-inputs.js'
import {closeDirectoryDetailOnEscape} from './directory-focus.js'
import type {OpenArtifacts} from './ArtifactPanel.js'
import type {ContinuousTarget} from './continuous-preview.js'
import {useBusinessScopes} from './business-scope-context.js'
import {attentionKinds,taskNeeds,taskStates,type AttentionKind,type PreviewApproval,type PreviewTask,type TaskChange,type TaskSource} from './task-preview.js'
import type {TaskAttention,TaskCompletionRecord} from './task-api.js'
import type {AttentionItem} from './attention-item.js'
import {canReceiveTask,roleName,type PreviewRole,type RoleDirectoryState} from './role-preview.js'
import {ApprovalCard} from './ApprovalCard.js'
import {objectRefTarget,type BusinessPreview,type BusinessTarget} from './business-preview.js'
import {shouldShowHandoffForm} from './task-detail-presentation.js'
import type {RunView} from './task-run-api.js'
import {TaskRunPreparationContext,type TaskRunPreparation} from './task-run-preparation-context.js'
import type {TaskHandoff} from './handoff-api.js'
import type {Artifact} from './artifact-preview.js'
import type {TimelineEventKind} from './object-timeline.js'
import {ObjectPageHeader,type ObjectMenuItem} from './ObjectPageHeader.js'
import {StatusBox,type StatusBoxAction} from './StatusBox.js'
import {EventTimeline} from './EventTimeline.js'
import {DetailText,TaskDetailSection,TaskFact} from './TaskDetailSection.js'
import {detailDensityCopy,quietTerminalStatus} from './detail-density-copy.js'
import clsx from 'clsx'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {TwinAvatar} from './TwinAvatar.js'
import {twinDisplayName} from './team-presentation.js'
import {usePersonalProfile} from './use-personal-profile.js'
import {focusObjectAnchor} from './object-page-anchor.js'
import {taskStatusBox,type TaskStatusAction,type TaskStatusButton} from './task-status-box.js'
import {taskCompletionVisible,taskTimelineEvents,type TaskTimelineFaces} from './task-timeline-events.js'
import {TaskForm,type TaskGroupOption} from './TaskPage.js'
import {useI18n} from './i18n/provider.js'
import {isTaskWorkOutstandingError,localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'
import {StatusPill} from './StatusPill.js'
import detailCss from './TaskDetail.module.css'
import light from './light-actions.module.css'

const person=(id:string,roles:readonly PreviewRole[]=[],t?:Parameters<typeof roleName>[2],directory?:RoleDirectoryState)=>roleName(roles,id,t,directory)
const foldKeys={run:'task.timeline.fold.run',change:'task.timeline.fold.change',artifact:'task.timeline.fold.artifact',knowledge:'task.timeline.fold.knowledge',approval:'task.timeline.fold.approval'} as const
const foldKey=(kind:TimelineEventKind)=>kind in foldKeys?foldKeys[kind as keyof typeof foldKeys]:'task.timeline.fold.change'

export type TaskDetailProps={workProgress?:((runs:RunView[])=>ReactNode)|undefined;
 roleDirectory?:RoleDirectoryState|undefined
 presentation?:{full:boolean;toggle:()=>void}|undefined
 groups?:readonly TaskGroupOption[]|undefined;openGroup?:((id:string)=>void)|undefined
 attentionNeeds:AttentionKind[];attention:TaskAttention|null|undefined;attentionReason:string|undefined
 securityItems:readonly AttentionItem[]
 securityActions:ReactNode;industrySource:ReactNode
 executions:(onRuns:(rows:RunView[],verified:boolean)=>void)=>ReactNode
 knowledge:ReactNode;handoffs:ReactNode;handoffRows:readonly TaskHandoff[]
 completion?:TaskCompletionPort|undefined;editSaved?:((task:PreviewTask,fields:{title:string;goal:string})=>Promise<void>)|undefined
 conversations:(id:string)=>ReactNode
 draft:TaskInputDraft;patch:(fields:Partial<TaskInputFields>)=>void;clear:(fields:readonly (keyof TaskInputFields)[])=>void;review:()=>void
 openArtifacts:OpenArtifacts;openPlans:(target?:ContinuousTarget)=>void
 task:PreviewTask;approvals:PreviewApproval[];artifacts:readonly Artifact[];change:(change:TaskChange)=>void|Promise<void>;back:()=>void;backHidden:boolean
 openSource:(source:TaskSource)=>void;roles:PreviewRole[];team:()=>void;openRole:(id:string)=>void;business:BusinessPreview;openBusiness:(target:BusinessTarget)=>void;saveTemplate:(task:PreviewTask)=>void;repeatTask?:((task:PreviewTask)=>void)|undefined
}

/** 任务详情：概要、进度、交付、活动；配置与追溯信息按需展开，执行内容面保持稳定挂载。 */
export function TaskDetail(props:TaskDetailProps):JSX.Element{
  const {groups,openGroup,attentionNeeds,attention,attentionReason,securityItems,securityActions,industrySource,executions,knowledge,handoffs,handoffRows,completion,editSaved,conversations,draft,patch,clear,review,openArtifacts,openPlans,task,approvals,artifacts,change,back,backHidden,openSource,roles,team,openRole,business,openBusiness,saveTemplate}=props
  const {locale,t,dateTime,list}=useI18n()
  const profile=usePersonalProfile()
  const stamp=(value:string)=>dateTime(value,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
  const collaborationScopes=useBusinessScopes()
  const root=useRef<HTMLElement>(null)
  const [errorSnapshot,setErrorSnapshot]=useState<{identity:string;message:string;untilWorkSettled:boolean;runState:string}>(),[editing,setEditing]=useState(false),[handoffExpanded,setHandoffExpanded]=useState(false)
  // N13（可选）：编辑窗口外点/Esc 只收起，未保存的标题与目标留到下次打开；保存成功后清空。
  const [editDraft,setEditDraft]=useState<{title:string;goal:string}>()
  const [editBase,setEditBase]=useState<PreviewTask>()
  const openGoalEditor=()=>{if(!editDraft)setEditBase(task);setEditing(true)}
  const runIdentity=JSON.stringify([task.id,task.version]),currentRunIdentity=useRef(runIdentity);currentRunIdentity.current=runIdentity
  const setError=(message?:string,cause?:unknown)=>{if(currentRunIdentity.current===runIdentity)setErrorSnapshot(message?{identity:runIdentity,message,untilWorkSettled:isTaskWorkOutstandingError(cause),runState}:undefined)}
  const roleDirectory=task.storage==='persistent'?props.roleDirectory:undefined
  const [runSnapshot,setRunSnapshot]=useState<{identity:string;rows:RunView[];loaded:boolean}>({identity:runIdentity,rows:[],loaded:false}),[record,setRecord]=useState<TaskCompletionRecord|null>(null)
  const runs=runSnapshot.identity===runIdentity?runSnapshot.rows:[],runsLoaded=runSnapshot.identity===runIdentity&&runSnapshot.loaded
  const workSettled=runsLoaded&&runs.every(row=>['ended','withdrawn','configuration_failed'].includes(row.state))
  const runState=JSON.stringify(runs.map(row=>[row.id,row.state]))
  // 只在失败之后核实运行收口时清旧提示；既有终态不能吞掉新的服务端拒绝。
  const obsoleteError=errorSnapshot?.identity===runIdentity&&errorSnapshot.untilWorkSettled&&workSettled&&errorSnapshot.runState!==runState
  const error=errorSnapshot?.identity===runIdentity&&!obsoleteError?errorSnapshot.message:undefined
  useEffect(()=>{if(obsoleteError)setErrorSnapshot(current=>current===errorSnapshot?undefined:current)},[obsoleteError,errorSnapshot])
  const acceptRuns=useCallback((rows:RunView[],verified:boolean)=>{if(currentRunIdentity.current===runIdentity)setRunSnapshot(previous=>({identity:runIdentity,rows:verified?rows:previous.identity===runIdentity?previous.rows:[],loaded:verified}))},[runIdentity])
  const [preparation,setPreparation]=useState<TaskRunPreparation|null>(null)
  const currentPreparation=preparation?.taskId===task.id&&preparation.taskVersion===task.version?preparation:undefined
  const {source,materialNote,assignee,handoffNote,result}=draft.fields
  const linkedGroup=task.groupId?groups?.find(group=>group.id===task.groupId):undefined
  const sourceGroup=task.source?groups?.find(group=>group.id===task.source!.groupId):undefined
  const stale=taskInputsStale(draft,task),closed=['completed','cancelled'].includes(task.state),inputBlocked=stale||closed
  const operation=useRef(false),[operating,setOperating]=useState(false)
  const act=(action:TaskChange)=>{try{
    if(action.type==='supplement'||action.type==='handoff'||action.type==='progress'&&action.action==='complete')assertTaskInputsCurrent(draft,task)
    change(action)
    if(action.type==='supplement')clear(['source','materialNote'])
    if(action.type==='handoff')clear(['assignee','handoffNote'])
    if(action.type==='progress'&&action.action==='complete')clear(['result'])
    setError(undefined);return true
  }catch(error){setError(localizeWorkError(locale,error),error);return false}}
  const progress=async(action:TaskChange)=>{if(task.storage!=='persistent')return act(action);if(operation.current)return;operation.current=true;setOperating(true);try{await change(action);setError(undefined)}catch(error){setError(localizeWorkError(locale,error),error)}finally{operation.current=false;setOperating(false)}}
  const latest=approvals.at(-1)
  const operations=business.operations.filter(op=>op.taskId===task.id)
  const needs=attentionNeeds,responsible=roles.find(role=>role.id===task.assigneeId)
  const candidates=roles.filter(role=>canReceiveTask(role,task.scope)&&role.id!==(task.handoff?.fromId||task.assigneeId))
  const pendingHandoff=handoffRows.find(item=>item.status==='pending'&&item.taskId===task.id)
  const supplementKeys={pending:'task.detail.supplement.pending',accepted:'task.detail.supplement.accepted',rejected:'task.detail.supplement.rejected'} as const
  const operationKeys={pending:'task.detail.operation.pending',approved:'task.detail.operation.approved',rejected:'task.detail.operation.rejected',changes:'task.detail.operation.changes',stale:'task.detail.operation.stale',executing:'task.detail.operation.executing',unknown:'task.detail.operation.unknown',partial:'task.detail.operation.partial',verified:'task.detail.operation.verified'} as const
  const actionKeys={start:'task.detail.action.start',pause:'task.detail.action.pause',resume:'task.detail.action.resume',cancel:'task.detail.action.cancel'} as const
  // 交给员工或本人生成式执行的任务，暂停/继续属于运行控制，不能伪装成任务台账状态；否则必然被服务端拒绝。
  const runManagedTask=task.storage==='persistent'&&(task.assigneeId!=='self'||task.executor?.kind==='owner')
  const demo=task.storage==='persistent'?'':t('task.detail.demoSuffix')
  const openTaskArtifact=(ref:Parameters<OpenArtifacts>[1])=>openArtifacts({kind:'task',id:task.id},ref)
  // 菜单选中后页头会把焦点交还给 ··· 触发按钮，锚点定位放到下一帧才不会被抢回。
  const jump=(anchor:string,focus?:string)=>{requestAnimationFrame(()=>focusObjectAnchor(root.current,anchor,focus))}
  const run=(action:TaskStatusAction)=>{
    if(action.kind==='anchor'){
      focusObjectAnchor(root.current,action.anchor,action.focus)
      if(action.anchor==='run'&&action.focus==='prepare')currentPreparation?.prepare()
    }
    else if(action.kind==='progress')void progress({type:'progress',taskId:task.id,action:action.action,now:new Date().toISOString()})
    else record?openTaskArtifact({id:record.artifactId,version:record.artifactVersion}):openTaskArtifact(task.artifact)
  }
  const statusAction=(button:TaskStatusButton):StatusBoxAction=>({label:button.label,onSelect:()=>run(button.action),disabled:operating||button.action.kind==='anchor'&&button.action.anchor==='run'&&button.action.focus==='prepare'&&(!currentPreparation||currentPreparation.disabled)})

  const menuItems:ObjectMenuItem[]=[
    ...(!closed&&canEditTaskGoal(task)?[{id:'edit',label:t('task.detail.editGoal'),onSelect:openGoalEditor}]:[]),
    // 本人任务与沙盒仍从菜单开始；交给同事的持久任务由运行面准备与启动。
    ...(['start','pause','resume','cancel'] as const).filter(action=>action==='start'?(task.storage!=='persistent'||task.assigneeId==='self'&&task.executor?.kind!=='owner')&&task.state==='ready'&&!needs.length&&!task.approvalRequired:action==='pause'?!runManagedTask&&task.state==='running':action==='resume'?!runManagedTask&&task.state==='paused':!closed).map(action=>({id:action,label:t(actionKeys[action],{demo}),disabled:operating||(action==='start'||action==='resume')&&responsible?.state==='paused',onSelect:()=>void progress({type:'progress',taskId:task.id,action,now:new Date().toISOString()})})),
    ...(props.repeatTask?[{id:'repeat',label:t('task.detail.repeat'),onSelect:()=>props.repeatTask?.(task)}]:[]),
    ...(!closed?[{id:'handoff',label:t('task.detail.expandHandoff'),onSelect:()=>jump(pendingHandoff||task.storage!=='persistent'&&taskNeeds(task).includes('handoff')?'handoff':'owner')}]:[]),
    {id:'evidence',label:t('task.menu.evidence'),onSelect:()=>jump('evidence')},
  ]

  const sourceLabel=task.source?sourceGroup?.name??t('task.rail.source.group'):task.planSource?task.planSource.title:task.objectRefs?.[0]?.title??(task.businessSource?t('task.rail.source.business'):task.industrySource?task.industrySource.title:t('task.rail.source.local'))
  const openSourceRow=task.source?()=>openSource(task.source!):task.planSource?()=>openPlans({kind:'plan',id:task.planSource!.planId}):task.businessSource?()=>openBusiness(task.businessSource!):undefined
  // 群原消息优先占用来源行；旧计划缺少名称时，仍保留上下文里的计划入口。
  const planSourceInSummary=!!task.planSource&&!task.source&&typeof task.planSource.title==='string'&&task.planSource.title.trim().length>0
  const ownerName=responsible?.kind==='twin'?twinDisplayName(profile.displayName,t):person(task.assigneeId,roles,t,roleDirectory)
  const ownerAvatar=responsible?.kind==='employee'?<EmployeeAvatar avatarKey={responsible.avatarKey} size="sm"/>:responsible?.kind==='twin'?<TwinAvatar initials={profile.initials} size="sm"/>:<UserRound size={16} aria-hidden="true"/>
  const taskArtifacts=artifacts.filter(artifact=>artifact.source.kind==='task'&&artifact.source.id===task.id||artifact.produced?.some(producer=>producer.taskId===task.id)||artifact.revisions?.some(revision=>revision.taskId===task.id))
  const artifactRef=record?{id:record.artifactId,version:record.artifactVersion}:task.artifact
  const knownArtifact=artifactRef?taskArtifacts.find(artifact=>artifact.id===artifactRef.id&&artifact.versions.some(version=>version.number===artifactRef.version)):undefined
  const modeId=responsible?.runtimeConfig?.agentPresetId

  const model=taskStatusBox({state:task.state,...(task.completionPolicy?{completionPolicy:task.completionPolicy}:{}),needs,attention,assigned:task.assigneeId!=='self'||task.executor?.kind==='owner',ownerName,runCount:runs.length,completion:record?{artifactVersion:record.artifactVersion}:null,t})
  // 沙盒没有运行记录面，不能提供指向不存在区域的操作。
  const runPrepared=runs.some(row=>!['ended','withdrawn','configuration_failed'].includes(row.state))
  let primary=model.primary
  if(primary?.action.kind==='anchor'&&primary.action.anchor==='run'){
    if(task.storage!=='persistent')primary=undefined
    else if(primary.action.focus==='prepare'&&runPrepared)primary={label:t('task.status.action.viewRun'),action:{kind:'anchor',anchor:'run'}}
  }
  // 交给员工/本人执行的任务，暂停/继续只能走运行控制；compact 状态卡不能把台账级 continue 再暴露成必失败按钮。
  if(runManagedTask&&primary?.action.kind==='progress'&&(primary.action.action==='pause'||primary.action.action==='resume'))primary=runs.length?{label:t('task.status.action.viewRun'),action:{kind:'anchor',anchor:'run'}}:undefined
  const secondary=runManagedTask&&model.secondary?.action.kind==='progress'&&(model.secondary.action.action==='pause'||model.secondary.action.action==='resume')?undefined:model.secondary
  const executionsNode=<TaskRunPreparationContext.Provider value={setPreparation}>{executions(acceptRuns)}</TaskRunPreparationContext.Provider>
  // 「完成任务」的下拉只列当前任务版本的成果；纯文字交付没有成果版本时下拉为空、按钮永久禁用。
  // 这里先把入口说清楚：先去成果面板把本轮文字结果保存成当前版本的成果，再回到结项面板选择版本。
  const completionArtifactCandidates=completion?artifacts.flatMap(row=>row.versions.filter(v=>(v.source.ref.kind==='task'&&v.source.ref.id===task.id&&v.source.version===`${task.version} · ${task.updatedAt}`)||row.produced?.some(p=>p.taskId===task.id&&p.taskVersion===task.version&&p.version===v.number))):[]
  const completionNeedsArtifact=!!completion&&taskCompletionVisible(task)&&task.state==='waiting'&&runsLoaded&&workSettled&&completionArtifactCandidates.length===0
  // 空工具目录的运行不能交给模型空转：启动已被宿主拒绝，这里给出可操作的员工工具授权入口。
  const missingToolRun=runsLoaded?runs.find(row=>row.state==='prepared'&&row.executor?.kind!=='owner'&&(row.toolRules??[]).length===0):undefined
  const sandboxHandoff=task.storage!=='persistent'&&taskNeeds(task).includes('handoff')?<section className={css.handoffPanel} data-teloa-handoff-section aria-label={t('task.detail.handoffWork')}><header><div><span className={css.sectionEyebrow}>{t('task.detail.taskAttention')}</span><h3>{t('task.detail.arrangeSuccessor')}</h3></div><StatusPill tone="warn">{t('task.detail.handoffPending')}</StatusPill></header><p>{task.handoff?.reason||task.request}</p><p className={css.muted}>{t('task.detail.handoffDescription')}</p>{candidates.length?<><button type="button" aria-expanded={handoffExpanded} onClick={()=>setHandoffExpanded(value=>!value)}>{t(handoffExpanded?'task.detail.collapseHandoff':'task.detail.expandHandoff')}</button>{shouldShowHandoffForm(true,handoffExpanded)&&<form className={css.form} aria-label={t('task.detail.handoffForm')} onSubmit={event=>{event.preventDefault();act({type:'handoff',taskId:task.id,assigneeId:assignee,note:handoffNote,now:new Date().toISOString()})}}><label>{t('task.detail.successorRole')}<select disabled={closed} value={assignee} onChange={event=>patch({assignee:event.target.value})}><option value="">{t('task.detail.successorPlaceholder')}</option>{candidates.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</select></label><label>{t('task.detail.handoffNote')}<textarea required maxLength={4000} rows={3} disabled={closed} value={handoffNote} onChange={event=>patch({handoffNote:event.target.value})}/></label><button type="submit" disabled={inputBlocked||!handoffNote.trim()||!candidates.some(role=>role.id===assignee)}>{t('task.detail.confirmDemoHandoff')}</button></form>}</>:<><p>{t('task.detail.noSuccessor')}</p><button type="button" onClick={team}>{t('task.detail.configureSuccessor')}</button></>}</section>:null
  const faces:TaskTimelineFaces={
    executions:executionsNode,
    securityAction:<button type="button" onClick={()=>jump('approval')}>{t('task.status.action.approve')}</button>,
    completion:completion?<TaskCompletion face="timeline" task={task} api={completion} open={ref=>openArtifacts({kind:'task',id:task.id},ref)} onRecord={setRecord}/>:null,
    handoffAction:<button type="button" onClick={()=>jump('handoff')}>{t('task.detail.expandHandoff')}</button>,
    knowledge,
    need:task.need&&task.need!=='approval'&&task.need!=='handoff'?<section className={css.actionPanel} aria-label={t(attentionKinds[task.need])}><h4>{t(attentionKinds[task.need])}</h4><p>{task.request}</p>
      {task.need==='materials'&&<form className={css.form} onSubmit={event=>{event.preventDefault();act({type:'supplement',taskId:task.id,id:crypto.randomUUID(),source,note:materialNote,now:new Date().toISOString()})}}><label>{t('task.detail.materialSource')}<input required maxLength={4000} disabled={closed} value={source} onChange={event=>patch({source:event.target.value})} placeholder={t('task.detail.materialPlaceholder')}/></label><label>{t('task.detail.supplementNote')}<textarea required maxLength={4000} rows={3} disabled={closed} value={materialNote} onChange={event=>patch({materialNote:event.target.value})}/></label><button type="submit" disabled={inputBlocked||!source.trim()||!materialNote.trim()}>{t('task.detail.saveSupplement')}</button></form>}
      {task.need==='error'&&<><p className={css.muted}>{t('task.detail.connectionDescription')}</p><div className={css.buttons}><button type="button" onClick={()=>act({type:'retry',taskId:task.id,succeeded:false,now:new Date().toISOString()})}>{t('task.detail.retryFailed')}</button><button type="button" onClick={()=>act({type:'retry',taskId:task.id,succeeded:true,now:new Date().toISOString()})}>{t('task.detail.retrySucceeded')}</button></div></>}
    </section>:null,
    supplements:task.supplements.length>0?<section className={css.block}>{task.supplements.map(item=><div className={css.record} key={item.id}><strong>{item.source}</strong><p>{item.note}</p><span>{t(supplementKeys[item.status])}</span>{item.status==='pending'&&task.need==='materials'&&<div className={css.buttons}><button type="button" onClick={()=>act({type:'verify',taskId:task.id,supplementId:item.id,accepted:false,now:new Date().toISOString()})}>{t('task.detail.verifyRejected')}</button><button type="button" onClick={()=>act({type:'verify',taskId:task.id,supplementId:item.id,accepted:true,now:new Date().toISOString()})}>{t('task.detail.verifyAccepted')}</button></div>}</div>)}</section>:null,
    source:task.source?<section className={css.block}><blockquote>{task.source.text}</blockquote><div className={css.buttons}><button type="button" className={light.link} onClick={()=>task.source&&openSource(task.source)}>{t('task.detail.returnSource')}<ArrowUpRight size={13} aria-hidden/></button></div>{task.source.authorId&&<small>{t('task.detail.originalAuthor',{author:person(task.source.authorId,roles,t,roleDirectory)})}</small>}</section>:null,
    approval:<>{latest&&<ApprovalCard openArtifact={ref=>openArtifacts({kind:'task',id:task.id},ref)} key={latest.id} approval={latest} onDecide={command=>act({type:'decide',...command})}/>}
      {task.approvalRequired&&task.need==='approval'&&(!latest||latest.status!=='pending'||Date.parse(latest.expiresAt)<=Date.now())&&<button type="button" onClick={()=>act({type:'submit',taskId:task.id,id:crypto.randomUUID(),now:new Date().toISOString()})}>{t('task.detail.submitCurrent',{version:task.version})}</button>}</>,
    approvalHistory:<>{approvals.slice(0,-1).map(item=><ApprovalCard openArtifact={ref=>openArtifacts({kind:'task',id:task.id},ref)} key={item.id} approval={item} onDecide={command=>act({type:'decide',...command})}/>)}</>,
  }
  const events=taskTimelineEvents({task,roles,runs,runsLoaded,record,materials:[],artifacts,approvals,securityItems,handoffs:handoffRows,completionVisible:taskCompletionVisible(task),faces,t})

  const sourceDetail=task.objectRefs?.length||task.planSource||task.industrySource||industrySource?<>
    {task.objectRefs?.length?<section className={css.block}><header><h3>{t('task.detail.businessSourceVersion')}</h3>{task.businessSource&&<button type="button" className={light.link} onClick={()=>openBusiness(task.businessSource!)}>{t('task.detail.returnBusinessSource')}<ArrowUpRight size={13} aria-hidden/></button>}</header><div className={css.buttons}>{task.objectRefs.map(ref=><button key={JSON.stringify([ref.scope,ref.type,ref.id,ref.version])} type="button" onClick={()=>openBusiness(objectRefTarget(ref))}>{t('task.detail.inputVersion',{title:ref.title,version:ref.version})}</button>)}</div></section>:null}
    {task.planSource&&<section className={css.block}><h3>{t('task.detail.planSource')}</h3><p>{t('task.detail.configVersion',{title:task.planSource.title,version:task.planSource.planVersion})}</p><div className={css.buttons}><button type="button" className={light.link} onClick={()=>openPlans({kind:'run',id:task.planSource!.runId})}>{t('task.detail.openSourceRun')}<ArrowUpRight size={13} aria-hidden/></button>{!planSourceInSummary&&<button type="button" className={light.link} onClick={()=>openPlans({kind:'plan',id:task.planSource!.planId})}>{t('task.detail.openPlan')}<ArrowUpRight size={13} aria-hidden/></button>}</div></section>}
    {task.industrySource&&<section className={css.block}><h3>{t('task.detail.industryTemplate',{title:task.industrySource.title})}</h3><p>{t('task.detail.industryVersionDescription',{version:task.industrySource.version})}</p><p>{task.industrySource.method}</p><dl>{task.industrySource.requirements.map((requirement,index)=><div key={index}><dt>{requirement}</dt><dd>{task.industrySource!.inputs[index]}</dd></div>)}</dl><p>{t('task.detail.delivery',{output:task.industrySource.output})}</p>{task.industrySource.skills.length>0&&<p>{t('task.detail.declaredSkills',{skills:list(task.industrySource.skills.map(skill=>skill.title+' · '+skill.version))})}</p>}</section>}
    {industrySource}
  </>:undefined
  // 分层呈现：只改变显示层级，不改变状态、动作或数据。无动作的终态不再重复页头已有的大状态卡；审批、失败、等待输入仍走状态卡。
  const quietStatus=quietTerminalStatus({state:task.state,needs,hasControl:!!currentPreparation?.control,hasAttention:!!attention})
  const resultEmpty=!task.result&&!taskArtifacts.length&&!artifactRef&&!task.artifactSource&&!task.evidence.length
  const density=(key:Parameters<typeof detailDensityCopy>[1])=>detailDensityCopy(locale,key)
  const statusChildren=<>
        {attentionReason&&<p className={css.muted} data-teloa-attention-reason aria-label={t('task.detail.attentionReason')}>{attentionReason}</p>}
        {error&&<div className={css.error} role="alert">{error}<button type="button" onClick={()=>setError(undefined)} aria-label={t('task.detail.closeError')}><X size={15}/></button></div>}
        <TaskInputNotice draft={draft} task={task} roles={roles} roleDirectory={roleDirectory} review={review}/>
        {responsible?.state==='paused'&&<p className={css.muted}>{t('task.detail.pausedRole')}</p>}
        {missingToolRun&&<section className={detailCss.section} role="alert" data-teloa-anchor="run-tools-missing">
          <p>{t('taskExecution.configTitle')}：{t('taskExecution.noTools')}</p>
          <p>{t('roleDelegation.noTools')}{t('taskExecution.withdrawThenPrepare')}</p>
          {responsible&&<button type="button" className={light.link} onClick={()=>openRole(responsible.id)}>{t('market.industry.planForm.openRole',{title:ownerName})}</button>}
        </section>}
        {completionNeedsArtifact&&<section className={detailCss.section} role="status" data-teloa-anchor="completion">
          <p>{t('taskCompletion.confirm')}：{t('taskCompletion.description')}</p>
          <button type="button" className={light.link} onClick={()=>openArtifacts({kind:'task',id:task.id})}>{t('artifact.panel.text.041')}</button>
        </section>}
        {task.state==='running'&&task.storage!=='persistent'&&!needs.length&&!task.approvalRequired&&<form className={css.form} onSubmit={event=>{event.preventDefault();act({type:'progress',taskId:task.id,action:'complete',result,now:new Date().toISOString()})}}><label>{t('task.detail.result')}<textarea required rows={3} maxLength={4000} value={result} onChange={event=>patch({result:event.target.value})}/></label><button type="submit" disabled={inputBlocked||!result.trim()}>{t('task.detail.completeResult')}</button></form>}
  </>
  return <article data-teloa-pane="detail" tabIndex={-1} ref={root} className={css.detail} aria-label={t('task.detail.aria')} onKeyDown={event=>closeDirectoryDetailOnEscape(event,back)}>
    <div className={detailCss.heading}><ObjectPageHeader compact trailing={props.presentation&&<ToolbarIconButton className={css.presentationToggle} label={t(props.presentation.full?'task.detail.compact':'task.detail.full')} icon={props.presentation.full?Minimize2:Maximize2} aria-pressed={props.presentation.full} onClick={props.presentation.toggle}/>} back={back} backHidden={backHidden} backLabel={t('task.detail.back')} title={task.title} {...(closed||!canEditTaskGoal(task)?{}:{onEditTitle:openGoalEditor})} editTitleLabel={t('task.detail.editGoal')} status={{mark:taskStatusMark(task.state),label:t(taskStates[task.state]),tone:needs.length?'warn':task.state==='completed'?'good':task.state==='cancelled'?'muted':'info'}} menuLabel={t('task.menu.more')} menu={menuItems}/></div>
    <div className={detailCss.layout}><div className={detailCss.columns}>
    <div className={clsx(css.goalLine,detailCss.slotGoal)}><span className={css.sectionEyebrow}>{t('task.detail.goal')}</span><DetailText markdown text={taskGoalText(task,t)} expandLabel={density('goalExpand')} collapseLabel={density('goalCollapse')}/></div>
    {quietStatus?<div className={clsx(detailCss.quietStatus,detailCss.slotStatus)}>{statusChildren}</div>:<div className={clsx(detailCss.statusPanel,detailCss.slotStatus)}>
      <StatusBox ariaLabel={t('task.status.aria')} tone={currentPreparation?.control?.tone??model.tone} sentence={currentPreparation?.control?.sentence??model.sentence} hint={currentPreparation?.control?.hint??model.hint} hintLabel={t('task.status.hint')} {...(currentPreparation?.control?{primary:{label:currentPreparation.control.actionLabel,disabled:currentPreparation.control.disabled,onSelect:()=>{focusObjectAnchor(root.current,'run','resume');currentPreparation.control?.act()}}}:primary?{primary:statusAction(primary)}:{})} {...(secondary?{secondary:statusAction(secondary)}:{})}>
        {statusChildren}
      </StatusBox>
    </div>}
    <dl className={clsx(detailCss.facts,detailCss.slotFacts)} aria-label={t('task.detail.summary')}>
      <TaskFact label={t('task.detail.currentOwnerLabel')}><div className={detailCss.ownerActions}>{responsible?<button type="button" className={detailCss.link} onClick={()=>openRole(responsible.id)}>{ownerAvatar}<span className={detailCss.ownerName} title={ownerName}>{ownerName}</span></button>:<>{ownerAvatar}<span>{ownerName}</span></>}</div></TaskFact>
      <TaskFact label={t('task.rail.scope')}>{collaborationScopes[task.scope]??task.scope}</TaskFact>
      <TaskFact label={t('task.rail.source')} wide>{openSourceRow?<button type="button" className={detailCss.link} onClick={openSourceRow}>{sourceLabel}<ChevronRight size={14} aria-hidden="true"/></button>:sourceLabel}</TaskFact>
      {linkedGroup&&linkedGroup.id!==task.source?.groupId&&<TaskFact label={t('task.detail.group')} wide>{openGroup?<button type="button" className={detailCss.link} onClick={()=>openGroup(linkedGroup.id)}>{linkedGroup.name}<ChevronRight size={14} aria-hidden="true"/></button>:linkedGroup.name}</TaskFact>}
    </dl>
    <div className={detailCss.slotProgress}>{runsLoaded&&props.workProgress?.(runs)}</div>
    <section className={clsx(detailCss.resultBlock,resultEmpty&&detailCss.resultCompact,detailCss.slotResult)} aria-label={t('task.detail.artifact')} data-teloa-anchor="artifact">
      <header><h3>{t('task.detail.artifact')}</h3>{(taskArtifacts.length>0||!!artifactRef||!!task.result||task.storage==='persistent'&&runsLoaded&&runs.some(row=>row.state==='ended'))&&<button type="button" className={detailCss.link} onClick={()=>openTaskArtifact(artifactRef)}>{t('task.detail.viewArtifacts')}<ChevronRight size={14} aria-hidden="true"/></button>}</header>
      {task.result&&<p>{task.result}</p>}
      <ul className={detailCss.resultList}>{taskArtifacts.map(artifact=>{
        const version=(artifact.id===artifactRef?.id?artifact.versions.find(row=>row.number===artifactRef.version):undefined)??artifact.versions.at(-1)
        return version?<li key={artifact.id}><button type="button" className={detailCss.link} onClick={()=>openTaskArtifact({id:artifact.id,version:version.number})}><FileText size={16} aria-hidden="true"/><span>{version.title}</span></button><small>v{version.number}</small></li>:null
      })}{artifactRef&&!knownArtifact&&<li><button type="button" className={detailCss.link} onClick={()=>openTaskArtifact(artifactRef)}><FileText size={16} aria-hidden="true"/>{t('task.detail.viewArtifacts')}</button><small>v{artifactRef.version}</small></li>}</ul>
      {task.artifactSource&&<button type="button" className={detailCss.link} onClick={()=>openArtifacts({kind:'task',id:task.sourceTaskId||task.id},task.artifactSource)}>{t('task.detail.openSourceArtifact',{version:task.artifactSource.version})}<ChevronRight size={14} aria-hidden="true"/></button>}
      {task.evidence.length>0&&<div className={detailCss.evidence}><strong>{t('task.detail.evidenceTitle')}</strong>{task.evidence.map((item,index)=><p key={index}>{item}</p>)}</div>}
    </section>
    {/* 活动承载运行面、审批、补充资料与交接表单：有待办或未结束的任务默认展开；无待办的终态默认收起，锚点跳转仍按折叠协议展开。 */}
    <div className={detailCss.slotActivity}><TaskDetailSection title={t('task.detail.activity')} defaultOpen={!quietStatus}>
        <EventTimeline ariaLabel={t('task.timeline.aria')} events={events} emptyText={t('task.timeline.empty')} foldLabel={(kind,count)=>t(foldKey(kind),{count})} expandLabel={t('task.timeline.expand')} collapseLabel={t('task.timeline.collapse')} stamp={stamp}/>
    </TaskDetailSection></div>
    <div className={detailCss.slotSide}>
    <div className={detailCss.slotContext}><TaskDetailSection title={t('task.detail.context')}>
      {knowledge&&<section className={detailCss.section} data-teloa-anchor="knowledge"><h3>{t('taskKnowledge.title')}</h3>{knowledge}</section>}
      <div data-teloa-anchor="conversations">{conversations(task.id)}</div>
      {task.skills&&task.skills.length>0&&<dl className={detailCss.facts}><TaskFact label={t('task.detail.skills')}>{list([...task.skills])}</TaskFact></dl>}
      {sourceDetail}
    </TaskDetailSection></div>
    <div className={detailCss.actionGroup} data-teloa-anchor="owner"><div data-teloa-anchor="handoff">{handoffs??sandboxHandoff}</div></div>
    {securityActions&&<div className={detailCss.actionGroup} data-teloa-anchor="approval">{securityActions}</div>}
    <div className={detailCss.slotConfig}><TaskDetailSection title={t('task.detail.configuration')} anchor="evidence">
      <dl className={detailCss.facts}>
        <TaskFact label={t('task.rail.runtime')}>{responsible?<button type="button" className={detailCss.link} onClick={()=>openRole(responsible.id)}>{modeId==='teloa-standard'?t('task.detail.standardMode'):modeId??t('task.rail.runtimeRole')}<ChevronRight size={14} aria-hidden="true"/></button>:t('task.rail.runtimeRole')}</TaskFact>
        <TaskFact label={t('task.detail.creator')}>{person(task.authorId,roles,t,roleDirectory)}</TaskFact>
        <TaskFact label={t('task.detail.createdTime')}>{stamp(task.createdAt)}</TaskFact>
        <TaskFact label={t('task.detail.updatedTime')}>{stamp(task.updatedAt)}</TaskFact>
        <TaskFact label={t('task.detail.versionLabel')}>v{task.version}</TaskFact>
        <TaskFact label={t('task.detail.idLabel')}><span className={detailCss.mono}>{task.id}</span></TaskFact>
        {task.source&&<TaskFact label={t('task.detail.messageIdLabel')}><span className={detailCss.mono}>{task.source.messageId}</span></TaskFact>}
      </dl>
      {task.storage!=='persistent'&&(task.approvalRequired||operations.length>0)&&<section className={detailCss.section}><h3>{t('task.detail.executionOutcome')}</h3>{operations.length?operations.map(op=><div className={css.record} key={op.id}><strong>{op.title} · {t(operationKeys[op.state])}</strong><p>{t('task.detail.verifiedTargets',{verified:op.targets.filter(target=>target.state==='verified').length,total:op.targets.length})}</p><button type="button" className={light.link} onClick={()=>openBusiness({scope:op.scope,section:'execution',id:op.id})}>{t('task.detail.openOperation')}<ArrowUpRight size={13} aria-hidden/></button></div>):<p>{t('task.detail.noOperation')}</p>}</section>}
    </TaskDetailSection></div>
    </div>
    </div></div>
    {editing&&canEditTaskGoal(task)&&<TaskForm persistent={task.storage==='persistent'} task={editDraft?{...(editBase??task),...editDraft}:editBase??task} onDraft={fields=>setEditDraft({title:fields.title,goal:fields.goal})} close={()=>setEditing(false)} save={async value=>{if(task.storage==='persistent'){if(!editSaved)throw Error(t('error.storageUnavailable'));await editSaved(editBase??task,{title:value.title,goal:value.goal})}else change({type:'edit',taskId:task.id,title:value.title,goal:value.goal,now:new Date().toISOString()});setEditDraft(undefined);setEditBase(undefined);setEditing(false)}}/>}
  </article>
}

export function TaskInputNotice({draft,task,roles,roleDirectory,review}:{draft:TaskInputDraft;task:PreviewTask;roles:PreviewRole[];roleDirectory?:RoleDirectoryState|undefined;review:()=>void}){
  const {t}=useI18n()
  if(!hasTaskInputs(draft))return null
  const stale=taskInputsStale(draft,task),closed=['completed','cancelled'].includes(task.state)
  const labels:Record<keyof TaskInputFields,'task.detail.result'|'task.detail.materialSource'|'task.detail.supplementNote'|'task.detail.successorRole'|'task.detail.handoffNote'>={result:'task.detail.result',source:'task.detail.materialSource',materialNote:'task.detail.supplementNote',assignee:'task.detail.successorRole',handoffNote:'task.detail.handoffNote'}
  return <section className={css.block} aria-label={t('task.detail.unsubmittedInputsAria')}>
    {stale&&<><p role="status">{t('task.detail.draftStale')}</p>{canEditTaskGoal(task)?<><p>{t('task.detail.draftOldGoal',{version:draft.version,goal:draft.goal})}</p><p>{t('task.detail.draftCurrentGoal',{version:task.version,goal:task.goal})}</p></>:<p>{t('task.detail.versionLabel')} v{draft.version} <ChevronRight size={12} aria-hidden="true"/> v{task.version}</p>}<p>{t('task.detail.draftOldAssignee',{owner:person(draft.assigneeId,roles,t,roleDirectory)})} · {t('task.detail.draftCurrentAssignee',{owner:person(task.assigneeId,roles,t,roleDirectory)})}</p>{!closed&&<button type="button" onClick={review}>{t('task.detail.reviewCurrent')}</button>}</>}
    {closed&&<p>{t('task.detail.closedDraft')}</p>}
    <details><summary>{t('task.detail.draftDetails')}</summary>{Object.entries(draft.fields).filter(([,value])=>value!=='').map(([key,value])=><div key={key}><h4>{t(labels[key as keyof TaskInputFields])}</h4><p>{key==='assignee'?person(value,roles,t,roleDirectory):value}</p></div>)}</details>
  </section>
}
