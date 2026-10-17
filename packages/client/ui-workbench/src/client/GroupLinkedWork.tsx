import {ToolbarIconButton} from './ToolbarIconButton.js'
import {useEffect,useRef,useState,useSyncExternalStore} from 'react'
import {Plus,Search,X} from 'lucide-react'
import {groupWorkLinkKey,readGroupWorkLink,type Group,type GroupRoutingStatusView,type GroupWorkLink,type GroupWorkLinkItem,type GroupWorkLinks} from '@teloa/contract'
import type {PreviewTask} from './task-preview.js'
import type {GroupWorkLinkApi} from './group-work-links-api.js'
import {ContextDrawer} from './ContextDrawer.js'
import {useBusinessScopes} from './business-scope-context.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {isCompletedGroupReply} from './group-task-source-presentation.js'
export {isCompletedGroupReply} from './group-task-source-presentation.js'
import css from './CollaborationPage.module.css'
import picker from './GroupLinkedWork.module.css'

const linkKinds=['business','project','task'] as const
/** 通用范围没有业务记录（契约拒绝 business+general），首屏默认搜任务；业务范围默认搜业务记录。 */
const defaultKind=(scope:string):GroupWorkLink['kind']=>scope==='general'?'task':'business'

/** 列表与数量的同一来源：显式关联、仅在项目侧的关联，以及来源于本群但未显式关联的派生任务。 */
export function groupLinkedWorkRows(detail:GroupWorkLinks|undefined,tasks:readonly PreviewTask[],messageStatuses:readonly GroupRoutingStatusView[]=[]){
 const linked=detail?.items??[],projectLinks=detail?.projectLinks??[],projectOnly=projectLinks.filter(project=>!linked.some(item=>groupWorkLinkKey(item)===groupWorkLinkKey(project)))
 return {linked,projectLinks,projectOnly,displayLinks:[...linked,...projectOnly],implicit:tasks.filter(task=>!linked.some(link=>link.kind==='task'&&link.id===task.id)&&!isCompletedGroupReply(task,messageStatuses,detail?.groupId))}
}

/** 概览页签与员工负责事项使用的真实计数；未读到时返回 undefined，不以 0 冒充。 */
export function groupLinkedWorkSummary(detail:GroupWorkLinks|undefined,tasks:readonly PreviewTask[],messageStatuses:readonly GroupRoutingStatusView[]=[]):{count:number;taskIds:string[]}|undefined{
 if(!detail)return
 const {displayLinks,implicit}=groupLinkedWorkRows(detail,tasks,messageStatuses)
 // 数量与列表同源（含不可用行）；负责事项只取可打开的任务，不可用任务不推断负责人。
 return {count:displayLinks.length+implicit.length,taskIds:[...new Set([...displayLinks.flatMap(item=>item.kind==='task'&&item.available?[item.id]:[]),...implicit.map(task=>task.id)])]}
}

export function GroupLinkedWork({profileName,group,api,tasks,taskDirectory=tasks,messageStatuses=[],roles=[],open,openRole,createTask,blocked=false,summarize}:{profileName?:string;group:Group;api:GroupWorkLinkApi;tasks:readonly PreviewTask[];taskDirectory?:readonly PreviewTask[];messageStatuses?:readonly GroupRoutingStatusView[]|undefined;roles?:readonly {id:string;name:string}[];open:(item:GroupWorkLinkItem)=>void;openRole?:((id:string)=>void)|undefined;createTask?:((id:string)=>void)|undefined;blocked?:boolean;summarize?:((value:{count:number;taskIds:readonly string[]}|undefined)=>void)|undefined}){
 const {locale,t}=useI18n(),scopes=useBusinessScopes(),generation=useRef(0),copy=(cn:string,tw:string,en:string)=>locale.startsWith('zh')?(/zh-(TW|HK|Hant)/.test(locale)?tw:cn):en
 const identity=useRef({groupId:group.id,api}),mounted=useRef(true)
 if(identity.current.groupId!==group.id||identity.current.api!==api)identity.current={groupId:group.id,api}
 const savedRevision=useSyncExternalStore(api.subscribe,api.revision,api.revision)
 const [discarded,setDiscarded]=useState(false)
 const [detail,setDetail]=useState<GroupWorkLinks>(),[error,setError]=useState(''),[editing,setEditing]=useState(false),[selection,setSelection]=useState<GroupWorkLinkItem[]>(),[formBase,setFormBase]=useState<GroupWorkLinks>(),[scope,setScope]=useState(group.scope),[kind,setKind]=useState<GroupWorkLink['kind']>(()=>defaultKind(group.scope)),[query,setQuery]=useState(''),[candidates,setCandidates]=useState<GroupWorkLinkItem[]>(),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0),[filter,setFilter]=useState('all')
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useEffect(()=>{setSelection(undefined);setFormBase(undefined);setEditing(false);setScope(group.scope);setKind(defaultKind(group.scope));setCandidates(undefined);setDiscarded(false);setBusy(false);setFilter('all')},[group.id,api])
 useEffect(()=>{
  const captured=++generation.current;setDetail(undefined);setError('')
  void api.get(group.id).then(value=>{if(captured===generation.current)setDetail(value)},cause=>{if(captured===generation.current)setError(localizeWorkError(locale,cause))})
  return()=>{if(captured===generation.current)generation.current++}
 // 原群刷新也重读外部项目关系；项目变化不会增加群自己的版本。
 },[group,api,revision,savedRevision])
 // 候选始终来自原对象服务，切换范围时清空旧结果（undefined 表示读取中）；迟到的候选不能落到另一个群。
 useEffect(()=>{
  if(!editing)return
  let live=true;setCandidates(undefined)
  void api.candidates(group.id,scope,kind,query).then(rows=>{if(live)setCandidates(rows)},cause=>{if(live)setError(localizeWorkError(locale,cause))})
  return()=>{live=false}
 },[editing,group.id,scope,kind,query,api])
 useEffect(()=>()=>{generation.current++},[])
 const {linked,projectLinks,projectOnly,displayLinks,implicit}=groupLinkedWorkRows(detail,tasks,messageStatuses),pending=api.pending(),pendingHere=pending?.groupId===group.id
 // 计数随同一份读取上报给概览页签；回调每次渲染都可能是新函数，只按计数内容变化通知。
 const summary=groupLinkedWorkSummary(detail,tasks,messageStatuses),summaryKey=summary?summary.count+':'+summary.taskIds.join(','):'',reportSummary=useRef(summarize);reportSummary.current=summarize
 useEffect(()=>{reportSummary.current?.(summary)},[group.id,summaryKey])
 const label=(item:GroupWorkLinkItem)=>item.title??copy('原对象已不可用','原物件已無法使用','Original work is unavailable')
 const category=(value:GroupWorkLink['kind'])=>value==='task'?copy('任务','工作','Task'):value==='project'?copy('项目','專案','Project'):copy('业务记录','業務記錄','Business record')
 const stateLabel=(state:string|null)=>state?({planning:copy('筹备中','籌備中','Planning'),running:copy('进行中','進行中','Running'),review:copy('待审阅','待審閱','In review'),ready:copy('待开始','待開始','Ready'),completed:copy('已完成','已完成','Completed'),paused:copy('已暂停','已暫停','Paused'),waiting:copy('等待中','等候中','Waiting'),blocked:copy('受阻','受阻','Blocked'),available:copy('可用','可用','Available')} as Record<string,string>)[state]??state:''
 // 筛选只作用于同一份读取结果，按实际出现的工作类型分组；业务类型没有本地化名称来源，不按原始标识细分。
 const filterCounts=new Map<GroupWorkLink['kind'],number>();for(const kind of [...displayLinks.map(item=>item.kind),...implicit.map(()=>'task' as const)])filterCounts.set(kind,(filterCounts.get(kind)??0)+1)
 const filterOptions=linkKinds.flatMap(kind=>filterCounts.has(kind)?[[kind,filterCounts.get(kind)!] as const]:[])
 const activeFilter=filterCounts.has(filter as GroupWorkLink['kind'])?filter:'all',shown=(kind:string)=>activeFilter==='all'||activeFilter===kind
 useEffect(()=>{if(detail&&filter!==activeFilter)setFilter('all')},[detail,filter,activeFilter])
 const assignee=(task:PreviewTask|undefined)=>task?(task.assigneeId==='self'?(profileName||t('collaboration.message.self')):roles.find(role=>role.id===task.assigneeId)?.name??copy('员工不可用','員工無法使用','Employee unavailable')):undefined
 const owner=(task:PreviewTask|undefined)=>{const name=assignee(task);if(!task||!name)return;return <small className={css.hint}>{openRole&&roles.some(role=>role.id===task.assigneeId)?<button type="button" className={css.memberName} aria-label={copy('查看'+name+'的档案：'+task.title,'查看'+name+'的檔案：'+task.title,'View '+name+'’s profile: '+task.title)} onClick={()=>openRole(task.assigneeId)}>{name}</button>:name}</small>}
 const save=async(recover=false)=>{
  if(!detail||busy)return;const captured=identity.current,current=()=>mounted.current&&captured===identity.current;setBusy(true);setError('')
  // 保存通知会触发同一原群的读取刷新；它不能使自己的成功失效。切群或换服务仍拒绝迟到回调。
  try{const base=formBase??detail,saved=recover?await api.recover():await api.change(group.id,base.groupVersion,base.version,(selection??linked).map(item=>readGroupWorkLink({kind:item.kind,scope:item.scope,id:item.id,...(item.kind==='business'?{type:item.type}:{})})));if(current()){setDetail(saved);setSelection(undefined);setFormBase(undefined);setEditing(false)}}
  catch(cause){if(current())setError(localizeWorkError(locale,cause))}finally{if(current())setBusy(false)}
 }
 return <section className={css.workSummary}>
  <header><div className={picker.linkActions}>
   {filterOptions.length>1&&<select className={picker.listFilter} aria-label={copy('筛选关联工作','篩選關聯工作','Filter linked work')} value={activeFilter} onChange={event=>setFilter(event.target.value)}><option value="all">{copy('全部关联工作','全部關聯工作','All linked work')}</option>{filterOptions.map(([kind,count])=><option key={kind} value={kind}>{category(kind)+' · '+count}</option>)}</select>}
   <button type="button" className={css.iconButton} disabled={blocked||busy||!detail||!!pending} aria-label={copy('关联工作','關聯工作','Link work')} title={copy('关联已有工作','關聯已有工作','Link existing work')} onClick={()=>{setSelection(value=>value??linked);setFormBase(value=>value??detail);setEditing(true)}}><Plus size={17}/></button>
  </div></header>
  {error&&<p role="alert">{error}<button type="button" onClick={()=>setRevision(value=>value+1)}>{t('common.retry')}</button></p>}
  {!detail&&!error&&<p role="status" className={css.hint}>{copy('正在读取关联工作…','正在讀取關聯工作…','Loading linked work…')}</p>}
  {api.recoveryError()&&<div role="alert"><p>{localizeWorkError(locale,api.recoveryError())}</p><p>{t('recovery.nextStep')}</p><button type="button" onClick={()=>{try{api.discard();setDiscarded(true);setRevision(value=>value+1)}catch(cause){setError(localizeWorkError(locale,cause))}}}>{t('recovery.discard')}</button></div>}
  {discarded&&<p role="status">{t('recovery.discarded')}</p>}
  {pendingHere&&<p>{copy('上次关联结果待核对','上次關聯結果待核對','Previous save needs verification')} <button type="button" disabled={busy||!detail} onClick={()=>void save(true)}>{copy('恢复原请求','復原原請求','Recover original request')}</button></p>}
  <div className={css.workRows}>{displayLinks.filter(item=>shown(item.kind)).map(item=><article key={groupWorkLinkKey(item)} className={css.workRow}>
   <div className={css.workMeta}><span>{category(item.kind)} · {scopes[item.scope]??item.scope}</span><span>{stateLabel(item.state)}</span></div>
   <button type="button" className={css.objectName} disabled={!item.available} aria-label={item.kind==='task'&&assignee(taskDirectory.find(task=>task.id===item.id))?label(item)+' · '+assignee(taskDirectory.find(task=>task.id===item.id)):label(item)} onClick={()=>open(item)}>{label(item)}</button>
   {item.kind==='task'&&owner(taskDirectory.find(task=>task.id===item.id))}
   {item.kind==='business'&&<small className={css.hint}>{item.id}</small>}
   {projectLinks.some(project=>groupWorkLinkKey(project)===groupWorkLinkKey(item))&&<small className={css.hint}>{copy('在项目中关联','在專案中關聯','Linked from project')}</small>}
  </article>)}{(shown('task')?implicit:[]).map(task=><article key={task.id} className={css.workRow}><div className={css.workMeta}><span>{category('task')} · {scopes[task.scope]??task.scope}</span><span>{stateLabel(task.state)}</span></div><button type="button" className={css.objectName} aria-label={task.title+' · '+assignee(task)} onClick={()=>open({kind:'task',scope:task.scope,id:task.id,title:task.title,state:task.state,available:true,objectVersion:task.version??1})}>{task.title}</button>{owner(task)}</article>)}</div>
  {detail&&displayLinks.length+implicit.length===0&&<p className={css.hint}>{copy('关联案件、项目或任务，围绕同一件事协作。','關聯案件、專案或工作，圍繞同一件事協作。','Link cases, projects or tasks to collaborate around the same work.')}</p>}
  {editing&&<ContextDrawer title={copy('关联工作','關聯工作','Link work')} close={()=>setEditing(false)}><div className={picker.picker}>
   {detail&&formBase&&(detail.version!==formBase.version||detail.groupVersion!==formBase.groupVersion)&&<p role="status" className={picker.notice}><span>{copy('原关联已更新，当前选择已保留。','原關聯已更新，目前選取已保留。','The original links changed. Your selection is preserved.')}</span><button type="button" disabled={busy||!!pending} onClick={()=>{setSelection(detail.items);setFormBase(detail)}}>{copy('载入最新关联','載入最新關聯','Load latest links')}</button></p>}
   <div className={picker.search}><Search size={16} aria-hidden="true"/><input aria-label={copy('搜索原工作','搜尋原工作','Search original work')} placeholder={copy('搜索名称或案件编号','搜尋名稱或案件編號','Search name or case number')} value={query} disabled={busy} onChange={event=>setQuery(event.target.value)}/></div>
   <div className={picker.filters}>
    <div role="group" aria-label={copy('类型','類型','Type')} className={picker.types}>{linkKinds.map(value=><button type="button" key={value} aria-pressed={kind===value} disabled={busy} onClick={()=>setKind(value)}>{category(value)}</button>)}</div>
    {Object.keys(scopes).length>1&&<select className={picker.scope} aria-label={copy('业务空间','業務空間','Business space')} disabled={busy} value={scope} onChange={event=>setScope(event.target.value)}>{Object.entries(scopes).map(([id,name])=><option key={id} value={id}>{name}</option>)}</select>}
   </div>
   <section className={picker.section}><header><h3>{copy('已选','已選','Selected')}</h3><span>{selection?.length??0}</span></header>
    {(selection??[]).map(item=><div className={picker.row} key={groupWorkLinkKey(item)}><span><strong>{label(item)}</strong><small>{category(item.kind)} · {scopes[item.scope]??item.scope}</small></span><button type="button" className={picker.remove} aria-label={copy('移除关联：','移除關聯：','Unlink: ')+label(item)} disabled={busy} onClick={()=>setSelection(rows=>(rows??[]).filter(row=>groupWorkLinkKey(row)!==groupWorkLinkKey(item)))}><X size={15}/></button></div>)}
   </section>
   {!!projectOnly.length&&<section className={picker.section}><header><h3>{copy('来自项目','來自專案','From projects')}</h3><span>{projectOnly.length} · {copy('在原项目中调整','在原專案中調整','Manage in the project')}</span></header>
    {projectOnly.map(item=><button type="button" key={groupWorkLinkKey(item)} className={picker.link} disabled={!item.available} onClick={()=>open(item)}>{label(item)}</button>)}
   </section>}
   <section className={picker.section}><header><h3>{copy('可关联','可關聯','Available')}</h3>{candidates&&<span>{candidates.length}</span>}</header>
    {(candidates??[]).map(item=>{const selected=selection?.some(row=>groupWorkLinkKey(row)===groupWorkLinkKey(item))??false,fromProject=projectLinks.some(project=>groupWorkLinkKey(project)===groupWorkLinkKey(item));return <label className={picker.candidate} key={groupWorkLinkKey(item)}><input type="checkbox" disabled={busy||fromProject&&!selected||(selection?.length??0)>=100&&!selected} checked={selected||fromProject} onChange={event=>setSelection(rows=>event.target.checked?[...(rows??[]),item]:(rows??[]).filter(row=>groupWorkLinkKey(row)!==groupWorkLinkKey(item)))}/><span><strong>{label(item)}</strong><small>{fromProject?copy('已由项目关联','已由專案關聯','Linked from project'):category(item.kind)+' · '+stateLabel(item.state)}</small></span></label>})}
    {candidates?.length===0&&<p className={picker.empty}>{copy('没有匹配的工作','沒有符合的工作','No matching work')}</p>}
   </section>
   {error&&<p role="alert">{error}</p>}
   <footer className={picker.footer}>
    {createTask&&<ToolbarIconButton label={t('collaboration.task.create')} icon={Plus} disabled={busy||blocked||!!pending} onClick={()=>{setEditing(false);createTask(group.id)}}/>}
    <span className={picker.spacer}/>
    <button type="button" className={css.secondary} onClick={()=>setEditing(false)}>{t('collaboration.form.cancel')}</button>
    <button type="button" className={css.primary} disabled={busy||blocked||!!pending&&!pendingHere||!detail} onClick={()=>void save(pendingHere)}>{busy?copy('保存中…','儲存中…','Saving…'):pendingHere?copy('恢复原请求','復原原請求','Recover original request'):copy('保存关联','儲存關聯','Save links')}</button>
   </footer>
  </div></ContextDrawer>}
 </section>
}
