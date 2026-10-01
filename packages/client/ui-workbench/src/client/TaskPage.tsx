import {TaskHandoffs,type HandoffPort} from './TaskHandoffs.js'
import type {TaskCompletionPort} from './TaskCompletion.js'
import {TaskDetail} from './TaskDetail.js'
import {TaskList} from './TaskList.js'
import {taskObjectLabel} from './task-list-presentation.js'
import type {EvidenceEntry,TaskDefinition} from '@teloa/contract'
import {roleSupportsScope} from '@teloa/contract'
import type {ReactNode} from 'react'
import {AttentionDecisionCard,type AttentionRiskFacts,type DecisionRequest} from './AttentionDecisionCard.js'
import {readExpandedAttention,toggleExpandedAttention,writeExpandedAttention} from './attention-decision.js'
import { readTaskInputs,editTaskInputs,clearTaskInputs,reviewTaskInputs,type TaskInputDrafts } from './task-inputs.js'
import { closeDirectoryDetailOnEscape,useDirectoryFocus } from './directory-focus.js'
import { openDialog } from './dialog-focus.js'
import type { OpenArtifacts } from './ArtifactPanel.js'
import type { ContinuousTarget } from './continuous-preview.js'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AlertCircle, ArrowUpRight, CheckCheck, CheckSquare, MessageSquare, Plus, Search, X } from 'lucide-react'
import clsx from 'clsx'
import type { CollaborationScope } from './collaboration-preview.js'
import { useBusinessScopes } from './business-scope-context.js'
import { attentionKinds, taskNeeds, taskStates, type AttentionKind, type PreviewTask, type TaskChange, type TaskPreview, type TaskSource } from './task-preview.js'
import type {TaskAssignee,TaskAttentionItem} from './task-api.js'
import type {RunView} from './task-run-api.js'
import {taskAttentionDescription} from './task-attention-presentation.js'
import {attentionPersistenceKey,attentionReasonText,attentionSourceKey,type AttentionItem} from './attention-item.js'
import {resolveHomeWorkAssignee,type HomeWorkAssigneeOption} from './home-work-assignee.js'
import { roleName, type PreviewRole } from './role-preview.js'
import type { BusinessTarget } from './business-preview.js'
import {personalProfile} from './personal-profile.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'
import directoryCss from './DirectoryPane.module.css'
import {DirectoryFilterPopover} from './DirectoryFilterPopover.js'
import {currentAttentionKinds,exampleDirectoryMode,visibleCurrentAttentionDirectory,visibleRoleDirectory,visibleTaskDirectory,type ExampleDirectoryMode} from './example-directory-presentation.js'
import {readDirectoryFilterCategory,writeDirectoryFilterCategory,type WorkbenchDirectoryNavigation,type WorkbenchDirectoryPatch} from './workbench-navigation-state.js'

export type TaskGroupOption={id:string;name:string;scope:string}
type Props={groups?:readonly TaskGroupOption[]|undefined;openGroup?:((id:string)=>void)|undefined;navigation?:{state:WorkbenchDirectoryNavigation;change:(patch:WorkbenchDirectoryPatch)=>void};securityActions?:(task:PreviewTask)=>ReactNode;decisionActions?:(item:AttentionItem)=>ReactNode;decisionFacts?:(item:AttentionItem)=>{evidence:readonly EvidenceEntry[];summary?:string|undefined;request?:DecisionRequest|undefined;risk?:AttentionRiskFacts|undefined};industrySource?:(task:PreviewTask)=>ReactNode;executions?:(task:PreviewTask,onRuns:(rows:RunView[],verified:boolean)=>void)=>ReactNode;knowledge?:(task:PreviewTask)=>ReactNode;persistence?:{directoryKnown?:boolean;attention:{rows:TaskAttentionItem[];known:boolean};handoffs:HandoffPort;completion:TaskCompletionPort;stateRequest:{taskId:string;action:string;expectedVersion:number}|undefined;stateError:unknown;recoverState:()=>Promise<void>;edit:(task:PreviewTask,fields:{title:string;goal:string})=>Promise<void>;create:(fields:TaskDefinition)=>Promise<string>;pendingFields:()=>TaskDefinition|undefined;load:()=>void;loading:boolean;error:string|undefined};embedded?:boolean;autoFocus?:boolean;conversations:(id:string)=>ReactNode;openArtifacts:OpenArtifacts;openPlans:(target?:ContinuousTarget)=>void;attentionItems:AttentionItem[];attentionKnown?:boolean;retryAttention?:()=>void;openAttention:(item:AttentionItem)=>void;visible:boolean;mode:'attention'|'tasks';state:TaskPreview;selected:string|null;select:(id:string|null)=>void;change:(change:TaskChange)=>void|Promise<void>;switchMode:()=>void;openSource:(source:TaskSource)=>void;team:()=>void;openRole:(id:string)=>void;openBusiness:(target:BusinessTarget)=>void;saveTemplate:(task:PreviewTask)=>void}
// 「使用技能」是一行可再编辑的自由输入，不是展示用列表：回填与解析共用顿号分隔符。
// 这里不能换成 Intl 列表格式——en 的「and」会在下次提交时被切成一项技能。
const skillSeparator='\u3001'
const person=(id:string,roles:PreviewRole[]=[],t?:Parameters<typeof roleName>[2])=>roleName(roles,id,t)

export function TaskPage({groups,openGroup,navigation,securityActions,decisionActions,decisionFacts,industrySource,executions,knowledge,persistence,embedded=false,autoFocus=true,conversations,openArtifacts,openPlans,attentionItems,attentionKnown=true,retryAttention,openAttention,visible,mode,state,selected,select,change,openSource,team,openRole,openBusiness,saveTemplate}:Props){
  const {locale,t,dateTime}=useI18n()
  const collaborationScopes=useBusinessScopes()
  const taskStateLabel=(value:keyof typeof taskStates)=>t(taskStates[value])
  const attentionLabel=(value:AttentionKind)=>t(attentionKinds[value])
  const attention=mode==='attention'
  const currentAttention=visibleCurrentAttentionDirectory(attentionItems)
  const restoredFilters=readDirectoryFilterCategory(navigation?.state.category,{scope:'all',routed:'all'},{scope:['all',...Object.keys(collaborationScopes)],routed:['all','formal']})
  const [query,setQuery]=useState(navigation?.state.query??''),[scope,setScope]=useState<CollaborationScope|'all'>(restoredFilters.scope as CollaborationScope|'all')
  const [routedFilter,setRoutedFilter]=useState<'all'|'formal'>(restoredFilters.routed as 'all'|'formal')
  const lastNavigation=useRef({category:navigation?.state.category,query:navigation?.state.query})
  const receivingNavigation=useRef<{category:string;query:string}|null>(null)
  const [attentionTab,setAttentionTab]=useState<'all'|AttentionKind>('all')
  const [recovering,setRecovering]=useState(false),[recoverError,setRecoverError]=useState<string>()
  const [newTask,setNewTask]=useState(false),[inputs,setInputs]=useState<TaskInputDrafts>({})
  const [fullDetail,setFullDetail]=useState(false)
  const [expandedAttention,setExpandedAttention]=useState<string|null>(null)
  // 刷新后只恢复仍在列表里的那条；事项办完消失时，state 与 sessionStorage 一起清掉，
  // 免得留下一个指向空气的记忆，下次进来又去找一条不存在的卡片。
  // 存储写入留在更新函数外：setState 的更新函数必须是纯的，StrictMode 会跑两遍。
  useEffect(()=>{
    const next=expandedAttention!==null&&currentAttention.some(item=>item.id===expandedAttention)?expandedAttention:readExpandedAttention(sessionStorage,currentAttention)
    if(next===expandedAttention)return
    writeExpandedAttention(sessionStorage,next)
    setExpandedAttention(next)
  },[currentAttention,expandedAttention])
  const toggleAttention=(id:string)=>{
    const next=toggleExpandedAttention(expandedAttention,id)
    writeExpandedAttention(sessionStorage,next)
    setExpandedAttention(next)
  }
  const [directoryMode,setDirectoryMode]=useState<ExampleDirectoryMode>(()=>exampleDirectoryMode(!!persistence))
  const directoryFocus=useDirectoryFocus(visible,selected??undefined,autoFocus)
  useEffect(()=>{
    if(!navigation)return
    const next={category:navigation.state.category,query:navigation.state.query}
    if(next.category===lastNavigation.current.category&&next.query===lastNavigation.current.query)return
    lastNavigation.current=next
    const filters=readDirectoryFilterCategory(next.category,{scope:'all',routed:'all'},{scope:['all',...Object.keys(collaborationScopes)],routed:['all','formal']})
    receivingNavigation.current={category:writeDirectoryFilterCategory(filters),query:next.query??''}
    setQuery(next.query??'')
    setScope(filters.scope as CollaborationScope|'all')
    setRoutedFilter(filters.routed as 'all'|'formal')
  },[navigation?.state.category,navigation?.state.query,collaborationScopes])
  useEffect(()=>{
    if(!visible||attention||!navigation)return
    const category=writeDirectoryFilterCategory({scope,routed:routedFilter})
    if(receivingNavigation.current){
      if(category===receivingNavigation.current.category&&query===receivingNavigation.current.query)receivingNavigation.current=null
      return
    }
    if(category===navigation.state.category&&query===(navigation.state.query??''))return
    lastNavigation.current={category,query}
    navigation.change({query,category})
  },[visible,attention,navigation,query,scope,routedFilter])
  const overviewScroll=useRef(0)
  useEffect(()=>{
    // 台账和目录使用不同滚动面，返回入口时恢复台账位置。
    if(visible&&!selected)directoryFocus.ref.current?.parentElement?.scrollTo({top:overviewScroll.current})
  },[visible,selected])
  useEffect(()=>{const item=state.tasks.find(task=>task.id===selected);setDirectoryMode(item?item.storage==='persistent'?'saved':'sandbox':exampleDirectoryMode(!!persistence))},[selected,state.tasks,!!persistence])
  if(!visible)return null
  const isSandbox=directoryMode==='sandbox'
  const directoryTasks=visibleTaskDirectory(state.tasks,directoryMode)
  const directoryRoles=visibleRoleDirectory(state.roles,directoryMode)
  const realAttention=(task:PreviewTask)=>task.storage==='persistent'?persistence?.attention.rows.find(item=>item.task.id===task.id&&item.task.version===task.version):undefined
  const pendingHandoff=(task:PreviewTask)=>persistence?.handoffs.rows.find(item=>item.status==='pending'&&item.taskId===task.id)
  const securityNeeds=(task:PreviewTask)=>attentionItems.filter(item=>item.target.kind==='security-action'&&item.target.taskId===task.id)
  const needsFor=(task:PreviewTask):AttentionKind[]=>task.storage==='persistent'?[...securityNeeds(task).map(item=>item.kind),...(realAttention(task)?.attention?[realAttention(task)!.attention!.kind]:[]),...(pendingHandoff(task)?['handoff' as const]:[])]:taskNeeds(task)
  const rowReason=(item:PreviewTask):'approval'|'error'|'review'|'blocked'|null=>{const reason=realAttention(item)?.attention?.reason;return securityNeeds(item).length?'approval':reason==='execution-failed'||reason==='execution-configuration-failed'?'error':reason==='execution-completed'||reason==='task-waiting'?'review':item.state==='blocked'?'blocked':null}
  const rows=directoryTasks.filter(task=>(scope==='all'||task.scope===scope)&&[task.title,task.id,taskObjectLabel(task,t)].some(value=>value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))
  // “需要你”始终先呈现决策队列；打开对象时再显式进入真实任务页。
  // 这样刷新恢复的任务选择不会把决策队列悄悄替换成旧任务详情。
  const task=attention?undefined:directoryTasks.find(item=>item.id===selected)
  const actualAttention=task?realAttention(task)?.attention:undefined
  const sourceNames=Object.fromEntries((['security-action','task','handoff','business','plan','binding','installation','local-recovery','server-recovery'] as const).map(source=>[source,t(attentionSourceKey(source))]))
  const reasonText=(item:AttentionItem)=>attentionReasonText(item.reason,key=>t(key))
  const visibleAttention=attention?currentAttention:[]
  const attentionKindsInView=currentAttentionKinds(visibleAttention)
  const effectiveAttentionTab=attentionTab==='all'||attentionKindsInView.includes(attentionTab)?attentionTab:'all'
  const matchedAttention=visibleAttention.filter(item=>effectiveAttentionTab==='all'||item.kind===effectiveAttentionTab)
  // 展开中的事项在切换类型后仍保留，避免用户读到一半失去上下文。
  const activeAttention=expandedAttention===null||matchedAttention.some(item=>item.id===expandedAttention)
    ?matchedAttention
    :visibleAttention.filter(item=>item.id===expandedAttention||matchedAttention.some(row=>row.id===item.id))
  const directoryItems=attention?activeAttention.map(item=>{const persistenceKey=attentionPersistenceKey(item.persistence),occurred=item.persistence==='local-recovery'?t('attention.recovery.localTime'):item.occurredAt?dateTime(item.occurredAt,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):t('security.timeUnknown');return {id:item.id,title:item.title,description:reasonText(item),meta:[persistenceKey?t(persistenceKey):'',sourceNames[item.source],collaborationScopes[item.scope as CollaborationScope]??item.scope,occurred].filter(Boolean).join(' · '),kind:item.kind,label:attentionLabel(item.kind),action:()=>openAttention(item),taskId:item.target.kind==='task'?item.target.id:item.target.kind==='security-action'?item.target.taskId:undefined,source:item as AttentionItem|undefined,occurred}}):rows.map(item=>{const actual=realAttention(item)?.attention,description=actual?taskAttentionDescription(actual.reason,t):pendingHandoff(item)?.reason||item.request||item.result||item.goal,needs=needsFor(item);return {id:item.id,title:item.title,description,meta:(collaborationScopes[item.scope]??item.scope)+' · '+taskObjectLabel(item,t)+' · '+person(item.assigneeId,directoryRoles,t),kind:needs[0],label:needs.map(attentionLabel).join(' · ')||taskStateLabel(item.state),action:()=>select(item.id),taskId:item.id,source:undefined as AttentionItem|undefined,occurred:''}})
  const scopeLabel=scope==='all'?t('common.allBusiness'):collaborationScopes[scope]??scope
  const routedCount=rows.filter(item=>item.source?.trigger==='routed').length
  const directoryKnown=isSandbox||!persistence||(persistence.directoryKnown??persistence.attention.known)
  const hasTaskFilters=query.trim().length>0||scope!=='all'||routedFilter!=='all'
  const showTaskFilters=directoryTasks.length>0||hasTaskFilters
  const resetDirectory=()=>{setQuery('');setScope('all');setRoutedFilter('all');select(null)}
  return <section data-task-directory-mode={directoryMode} className={clsx(css.page,css.alignedPage,isSandbox&&css.sandboxMode,embedded&&css.embeddedPage,css.overviewPage,task&&css.selectedPage,task&&fullDetail&&css.fullDetail)} onScroll={event=>{if(!task&&event.target===event.currentTarget)overviewScroll.current=event.currentTarget.scrollTop}} aria-label={t(attention?'navigation.attention':'navigation.tasks')}>

    {!isSandbox&&persistence?.stateRequest&&<div className={css.preview}><span>{t('task.attention.unverified')} · {state.tasks.find(task=>task.id===persistence.stateRequest!.taskId)?.title||persistence.stateRequest.taskId} · v{persistence.stateRequest.expectedVersion}</span><button type="button" disabled={recovering} onClick={async()=>{setRecovering(true);setRecoverError(undefined);try{await persistence.recoverState()}catch(error){setRecoverError(localizeWorkError(locale,error))}finally{setRecovering(false)}}}>{t('task.attention.recover')}</button></div>}{!isSandbox&&(recoverError!==undefined||persistence?.stateError!==undefined)&&<p role="alert">{recoverError??localizeWorkError(locale,persistence?.stateError)}</p>}
    {!attention&&<header className={css.pageHeader}><div><span className={css.eyebrow}>{t('work.overview.items')}</span><h1>{t('navigation.tasks')}</h1>{directoryKnown&&<p>{t('work.overview.count',{count:String(directoryTasks.length)})}</p>}</div><div className={css.buttons}><button type="button" onClick={()=>setNewTask(true)}>{t('team.action.assign')}<Plus size={15}/></button></div></header>}
    {!isSandbox&&persistence?.error&&<div role="alert" className={css.loadNotice}><AlertCircle size={18} aria-hidden="true"/><div>{!attention&&!directoryKnown&&<strong>{t('task.directory.loadFailed')}</strong>}<p>{persistence.error}</p></div><button type="button" disabled={persistence.loading} onClick={persistence.load}>{t('task.directory.retry')}</button></div>}
    {!attention&&!directoryKnown&&!persistence?.error&&<div role="status" className={css.loadNotice}><p>{t('task.directory.loading')}</p></div>}
    {!task&&attention&&!attentionKnown&&<div role="status" className={css.preview}><span>{t('attention.partial')}</span><button type="button" onClick={()=>retryAttention?.()}>{t('attention.partial.retry')}</button></div>}
    {!task&&attention&&<header className={clsx(css.pageHeader,css.attentionHeader)}><div><span className={css.eyebrow}>{t('attention.v2.eyebrow')}</span><h1>{t('navigation.v2.attention')}</h1><p>{t('attention.v2.description')}</p></div><span className={css.attentionCount}>{t(attentionKnown?'attention.v2.count':'attention.count.partial',{count:String(visibleAttention.length)})}</span></header>}
    <div {...directoryFocus} className={clsx(css.layout,task&&css.hasSelection,css.overviewLayout,attention&&css.attentionLayout)}>
      <aside data-teloa-pane="directory" tabIndex={-1} className={clsx(css.directory,directoryCss.pane)} aria-label={t(attention?'task.directory.attention':'task.directory.all')}>
        {attention&&visibleAttention.length>0?<nav className={clsx(css.tabs,css.attentionTabs)} aria-label={t('attention.v2.filter')}><button type="button" aria-current={effectiveAttentionTab==='all'?'page':undefined} onClick={()=>setAttentionTab('all')}>{t('common.all')} <span>{visibleAttention.length}</span></button>{attentionKindsInView.map(value=><button type="button" key={value} aria-current={effectiveAttentionTab===value?'page':undefined} onClick={()=>setAttentionTab(value)}>{attentionLabel(value)} <span>{visibleAttention.filter(item=>item.kind===value).length}</span></button>)}</nav>:!attention&&showTaskFilters?<><label className={clsx(css.search,directoryCss.search)}><Search size={16}/><input aria-label={t('task.search')} placeholder={t('task.search')} value={query} onChange={event=>setQuery(event.target.value)}/></label><div className={directoryCss.filterBar}><span className={directoryCss.filterSummary}>{scopeLabel}</span><DirectoryFilterPopover label={t('task.scopeFilter')}><div className={directoryCss.filterPanel}><fieldset><legend>{t('task.scopeFilter')}</legend><label><input type="radio" name="task-scope" aria-label={t('common.allBusiness')} checked={scope==='all'} onChange={()=>setScope('all')}/><span>{t('common.allBusiness')}</span></label>{Object.entries(collaborationScopes).map(([id,label])=><label key={id}><input type="radio" name="task-scope" aria-label={label} checked={scope===id} onChange={()=>setScope(id as CollaborationScope)}/><span>{label}</span></label>)}</fieldset><fieldset><legend>{t('task.list.routed',{count:String(routedCount)})}</legend><label><input type="radio" name="task-routed" aria-label={t('task.list.filter.all')} checked={routedFilter==='all'} onChange={()=>setRoutedFilter('all')}/><span>{t('task.list.filter.all')}</span></label><label><input type="radio" name="task-routed" aria-label={t('task.list.filter.formal')} checked={routedFilter==='formal'} onChange={()=>setRoutedFilter('formal')}/><span>{t('task.list.filter.formal')}</span></label></fieldset></div></DirectoryFilterPopover></div></>:null}
        <div className={clsx(css.rows,directoryCss.rows,!task&&attention&&css.attentionList)}>
    {!attention&&!isSandbox&&persistence&&<TaskHandoffs api={persistence.handoffs} tasks={directoryTasks} roles={directoryRoles} selected={null} select={select}/>}
          {!attention&&rows.length>0?<TaskList rows={rows.map(item=>({task:item,attention:{kinds:needsFor(item),reason:rowReason(item)},ownerName:person(item.assigneeId,directoryRoles,t),scopeLabel:collaborationScopes[item.scope]??item.scope,unverified:!realAttention(item)}))} filter={routedFilter} selected={selected} select={select} stateLabel={taskStateLabel} attentionLabel={attentionLabel} stamp={at=>dateTime(at,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}/>:directoryItems.map(item=>{
            // 只有需要你列表里的事项能原地展开；另一支照旧是一次点击就进详情。
            const decision=!task?item.source:undefined
            const body=<>{!task&&<span className={clsx(css.attentionIcon,directoryCss.leadingIcon)}>{item.kind==='approval'?<CheckCheck size={17}/>:item.kind==='error'?<AlertCircle size={17}/>:<MessageSquare size={17}/>}</span>}<span className={clsx(css.rowContent,directoryCss.rowBody)}><span className={clsx(css.rowTitle,directoryCss.title)}><strong title={item.title}>{item.title}</strong><span className={clsx(css.badge,item.kind?css.warn:css.info)}>{item.label}</span></span>{!decision&&<span className={clsx(css.rowDescription,directoryCss.summary)}>{item.description}</span>}<small className={directoryCss.metadata}>{item.meta}</small></span></>
            const rowClass=clsx(css.row,directoryCss.row,!task&&css.attentionRow),current=!attention&&item.taskId===selected?'page':undefined
            if(!decision)return <button type="button" key={item.id} data-teloa-entry={item.taskId} className={rowClass} aria-current={current} onClick={item.action}>{body}</button>
            // 展开与“打开对象”是两件事，就给两个并列的按钮：Tab 先落在展开上，再落在箭头上。
            const cardId='teloa-attention-card-'+item.id.replace(/[^\w-]/g,'-'),facts=expandedAttention===item.id?decisionFacts?.(decision):undefined
            return <div key={item.id} className={clsx(css.attentionRowWrap,expandedAttention===item.id&&css.attentionRowOpen)}>
              <div className={css.attentionRowLine}>
                <button type="button" data-teloa-entry={item.taskId} className={rowClass} aria-current={current} aria-expanded={expandedAttention===item.id} aria-controls={expandedAttention===item.id?cardId:undefined} onClick={()=>toggleAttention(item.id)}>{body}</button>
                <button type="button" data-teloa-attention-arrow className={css.attentionJump} aria-label={t('attention.openObject',{title:decision.title})} onClick={()=>openAttention(decision)}><ArrowUpRight size={16}/></button>
              </div>
              {expandedAttention===item.id&&<AttentionDecisionCard id={cardId} item={decision} sourceName={sourceNames[decision.source]!} scopeName={collaborationScopes[decision.scope as CollaborationScope]??decision.scope} occurred={item.occurred} summary={facts?.summary} request={facts?.request} risk={facts?.risk} evidence={facts?.evidence??[]} actions={decisionActions?.(decision)??<button type="button" onClick={()=>openAttention(decision)}>{t('attention.action.go')}</button>}/>}
            </div>
          })}
          {directoryItems.length===0&&(attention?attentionKnown:directoryKnown)&&<div className={css.empty}><CheckSquare size={27}/><h2>{t(attention?(visibleAttention.length?'task.empty.noMatch':'attention.empty.none'):(directoryTasks.length?'task.empty.noMatch':'task.empty.none'))}</h2><p>{t(attention?(visibleAttention.length?'task.empty.noMatchDescription':'attention.empty.description'):(directoryTasks.length?'task.empty.noMatchDescription':'task.empty.description'))}</p>{!attention&&hasTaskFilters?<button type="button" onClick={resetDirectory}>{t('task.filter.reset')}</button>:!attention&&<button type="button" onClick={()=>setNewTask(true)}>{t('team.action.assign')}<Plus size={15}/></button>}</div>}
        </div>
      </aside>
      {task?<TaskDetail presentation={!embedded?{full:fullDetail,toggle:()=>setFullDetail(value=>!value)}:undefined} groups={groups} openGroup={openGroup} attentionNeeds={needsFor(task)} attention={actualAttention} attentionReason={actualAttention?taskAttentionDescription(actualAttention.reason,t):pendingHandoff(task)?.reason} securityItems={securityNeeds(task)} securityActions={securityActions?.(task)} industrySource={industrySource?.(task)} executions={onRuns=>executions?.(task,onRuns)??null} knowledge={task.storage==='persistent'?knowledge?.(task):null} handoffs={!isSandbox&&persistence?<TaskHandoffs api={persistence.handoffs} tasks={directoryTasks} roles={directoryRoles} selected={selected} select={select}/>:null} handoffRows={persistence?.handoffs.rows??[]} completion={isSandbox?undefined:persistence?.completion} editSaved={isSandbox?undefined:persistence?.edit} conversations={conversations} draft={readTaskInputs(inputs,task)} patch={fields=>setInputs(current=>editTaskInputs(current,task,fields))} clear={fields=>setInputs(current=>clearTaskInputs(current,task.id,fields))} review={()=>setInputs(current=>reviewTaskInputs(current,task))} openArtifacts={openArtifacts} openPlans={openPlans} key={task.id} task={task} approvals={state.approvals.filter(item=>item.taskId===task.id)} artifacts={state.artifacts} change={change} back={()=>select(null)} backHidden={embedded} openSource={openSource} roles={directoryRoles} team={team} openRole={openRole} business={state.business} openBusiness={openBusiness} saveTemplate={saveTemplate}/>:null}
    </div>
    {newTask&&<TaskForm groups={groups} persistent={!!persistence&&!isSandbox} initial={isSandbox?undefined:persistence?.pendingFields()} close={()=>setNewTask(false)} save={async value=>{const id=persistence&&!isSandbox?await persistence.create(value):crypto.randomUUID();if(!persistence||isSandbox)change({type:'create',id,title:value.title,goal:value.goal,scope:value.scope,now:new Date().toISOString()});setNewTask(false);select(id)}}/>}
  </section>
}

export function TaskForm({task,initial,persistent=false,review=false,assignees,initialAssigneeId='self',groups,close,save}:{task?:PreviewTask;initial?:TaskDefinition|undefined;persistent?:boolean;review?:boolean;assignees?:HomeWorkAssigneeOption[];initialAssigneeId?:string;groups?:readonly TaskGroupOption[]|undefined;close:()=>void;save:(value:{title:string;goal:string;scope:CollaborationScope;groupId:string|null;skills:string[]},assignee?:TaskAssignee)=>void|Promise<void>}){
  const {locale,t}=useI18n()
  const profile=useSyncExternalStore(personalProfile.subscribe,personalProfile.getSnapshot,personalProfile.getSnapshot)
  const collaborationScopes=useBusinessScopes()
  const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null)
  const initialScope=(task?.scope||initial?.scope||'general') as CollaborationScope
  const [title,setTitle]=useState(task?.title||initial?.title||''),[goal,setGoal]=useState(task?.goal||initial?.goal||''),[scope,setScope]=useState<CollaborationScope>(initialScope),[assigneeId,setAssigneeId]=useState(assignees?.some(role=>role.id===initialAssigneeId&&roleSupportsScope(role.scopes,initialScope))?initialAssigneeId:'self'),[error,setError]=useState<string>()
  useEffect(()=>openDialog(dialog.current,input.current),[])
  const [saving,setSaving]=useState(false)
  // 「使用技能」照原型是一行自由输入：按顿号、逗号或空白切分，去重与长度由契约读取器把关。
  const [skillText,setSkillText]=useState((task?.skills??initial?.skills??[]).join(skillSeparator))
  const [groupId,setGroupId]=useState(task?.groupId??initial?.groupId??'')
  const skills=skillText.split(/[、,，;；\s]+/).map(item=>item.trim()).filter(Boolean)
  const availableAssignees=assignees?.filter(role=>roleSupportsScope(role.scopes,scope))??[]
  const availableGroups=(groups??[]).filter(group=>group.scope===scope)
  const ownerName=assigneeId==='self'?profile.displayName:availableAssignees.find(role=>role.id===assigneeId)?.name??profile.displayName
  const heading=t(task?'task.form.headingEdit':review?'task.form.headingReview':'task.form.headingCreate')
  return <dialog ref={dialog} className={clsx(css.dialog,css.alignedDialog)} aria-label={heading} onCancel={event=>{if(saving)event.preventDefault();else close()}}><form className={css.form} onSubmit={async event=>{event.preventDefault();if(saving)return;setSaving(true);try{await save({title,goal,scope,groupId:groupId||null,skills},assignees?resolveHomeWorkAssignee(assignees,assigneeId,scope):undefined)}catch(error){setError(localizeWorkError(locale,error))}finally{setSaving(false)}}}><header><h2>{heading}</h2><button type="button" aria-label={t('task.form.close')} disabled={saving} onClick={close}><X size={18}/></button></header><p>{t(review?'task.form.reviewDescription':persistent?'task.form.localDescription':'task.form.demoDescription')}{task?.approvalRequired?t('task.form.approvalInvalidated'):''}</p>{error&&<p role="alert">{error}</p>}<label>{t('task.form.businessScope')}<select disabled={!!task||saving} value={scope} onChange={event=>{const next=event.target.value as CollaborationScope;setScope(next);if(assigneeId!=='self'&&!assignees?.some(role=>role.id===assigneeId&&roleSupportsScope(role.scopes,next)))setAssigneeId('self');if(groupId&&!(groups??[]).some(group=>group.id===groupId&&group.scope===next))setGroupId('')}}>{Object.entries(collaborationScopes).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>{!task&&<label>{t('task.form.skills')}<input disabled={saving} maxLength={1300} value={skillText} onChange={event=>setSkillText(event.target.value)}/></label>}<label>{t('task.form.title')}<input disabled={saving} ref={input} required maxLength={120} value={title} onChange={event=>setTitle(event.target.value)}/></label><label>{t('task.form.goal')}<textarea disabled={saving} required rows={4} maxLength={8000} placeholder={t('task.form.goalPlaceholder')} value={goal} onChange={event=>setGoal(event.target.value)}/></label>{assignees&&<label>{t('task.form.owner')}<select disabled={saving} value={assigneeId} onChange={event=>setAssigneeId(event.target.value)}><option value="self">{t('task.form.self',{name:profile.displayName})}</option>{availableAssignees.map(role=><option key={role.id} value={role.id}>{t('task.form.digitalWorker',{name:role.name})}</option>)}</select></label>}{!task&&<label>{t('task.form.group')}<select disabled={saving} value={groupId} onChange={event=>setGroupId(event.target.value)}><option value="">{t('task.form.groupNone')}</option>{availableGroups.map(group=><option key={group.id} value={group.id}>{group.name}</option>)}</select></label>}{!task&&<p className={css.muted}>{t('task.form.ownerPreview',{name:ownerName})}</p>}<footer className={css.buttons}><button type="button" disabled={saving} onClick={close}>{t('task.form.cancel')}</button><button type="submit" disabled={saving||!title.trim()||!goal.trim()}>{t(saving?'task.form.saving':task?(persistent?'task.form.saveGoal':'task.form.saveDemoGoal'):'task.form.createTask')}</button></footer></form></dialog>
}
