import {useEffect,useMemo,useSyncExternalStore} from 'react'
import type {BusinessObjectReference} from '@teloa/contract'
import type {BusinessTaskListApi,BusinessTaskListItem} from './business-task-list-api.js'
import {BusinessTaskListController,type BusinessTaskListState} from './business-task-list.js'
import {taskStates} from './task-preview.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessTaskList.module.css'

export type BusinessTaskListProps={
 api:BusinessTaskListApi
 scope:string
 object?:{type:string;id:string}
 /** 只从当前已授权岗位目录解析显示名；缺失时保留真实岗位 ID。 */
 roleName?:(roleId:string)=>string|undefined
 openTask:(taskId:string)=>void
 openArtifact?:(taskId:string,artifactId:string,version:number)=>void
 openSource?:(reference:BusinessObjectReference)=>void
}
/** 仅正式业务页挂载；预览不传 API、不挂载本组件。 */
export function BusinessTaskList({api,scope,object,roleName,openTask,openArtifact,openSource}:BusinessTaskListProps){
 const type=object?.type,id=object?.id,hasObject=object!==undefined
 const controller=useMemo(()=>new BusinessTaskListController(api,{scope,...(object!==undefined?{object:{...object}}:{})}),[api,scope,type,id,hasObject])
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot)
 useEffect(()=>{void controller.refresh();return()=>controller.dispose()},[controller])
 return <BusinessTaskListView state={state} object={!!object} {...(roleName?{roleName}:{})} openTask={openTask} {...(openArtifact?{openArtifact}:{})} {...(openSource?{openSource}:{})} refresh={()=>void controller.refresh()} more={()=>void controller.more()}/>
}

type ViewProps=Pick<BusinessTaskListProps,'roleName'|'openTask'|'openArtifact'|'openSource'>&{state:BusinessTaskListState;object:boolean;refresh:()=>void;more:()=>void}
function progressKey(item:BusinessTaskListItem){
 if(item.completion)return 'business.tasks.progress.accepted' as const
 const run=item.progress
 if(!run)return 'business.tasks.progress.none' as const
 if(run.state==='ended')return run.reason==='completed'&&item.task.state==='waiting'?'business.tasks.progress.review' as const:'business.tasks.progress.failed' as const
 if(run.state==='active')return run.stopRequestedAt?'business.tasks.progress.stopping' as const:'business.tasks.progress.running' as const
 if(run.state==='withdrawn')return 'business.tasks.progress.stopped' as const
 if(run.state==='configuration_failed')return 'business.tasks.progress.failed' as const
 return 'business.tasks.progress.pending' as const
}
/** 目录文案及状态、负责人、通用动作统一使用当前语言词条。 */
export function BusinessTaskListView({state,object,roleName,openTask,openArtifact,openSource,refresh,more}:ViewProps){
 const {t,dateTime}=useI18n(),busy=state.phase==='loading'||state.loadingMore,title=t(object?'business.tasks.objectTitle':'business.tasks.title')
 return <section className={css.card} aria-label={title} aria-busy={busy}>
  <header className={css.header}><h2>{title}</h2><button type="button" disabled={busy} onClick={refresh}>{t('taskExecution.refresh')}</button></header>
  <p className={css.hint}>{t('business.tasks.description')}</p>
  {state.phase==='loading'&&<p role="status">{t('taskExecution.loading')}</p>}
  {state.phase==='failed'&&<div role="alert"><p>{t('business.tasks.failed')}</p><button type="button" onClick={refresh}>{t('business.records.retry')}</button></div>}
  {state.phase==='ready'&&state.items.length===0&&<p className={css.hint}>{t('business.tasks.empty')}</p>}
  {state.phase==='ready'&&state.items.length>0&&<ul className={css.list}>{state.items.map(item=><li key={item.task.id} className={css.row}>
   <div className={css.details}><h3>{item.task.title}</h3><dl><div><dt>{t('task.form.owner')}</dt><dd>{item.task.assigneeRoleId?(roleName?.(item.task.assigneeRoleId)||item.task.assigneeRoleId):t('task.status.unassigned')}</dd></div><div><dt>{t('task.status.aria')}</dt><dd>{t(taskStates[item.task.state])}</dd></div><div><dt>{t('business.tasks.progress.label')}</dt><dd>{t(progressKey(item))}</dd></div>{item.completion&&<div><dt>{t('business.tasks.artifact.label')}</dt><dd>{item.completion.title} · {t('business.tasks.artifact.version',{version:item.completion.version})}</dd></div>}<div><dt>{t('task.detail.updatedTime')}</dt><dd><time dateTime={item.task.updatedAt}>{dateTime(item.task.updatedAt)}</time></dd></div></dl></div>
   <div className={css.actions}><button type="button" onClick={()=>item.completion&&openArtifact?openArtifact(item.task.id,item.completion.artifactId,item.completion.version):openTask(item.task.id)}>{t(item.completion&&openArtifact?'business.tasks.artifact.open':'business.tasks.openTask')}</button>{item.source&&openSource&&<button type="button" onClick={()=>openSource(item.source!.reference)}>{t('business.tasks.openSource')}</button>}</div>
  </li>)}</ul>}
  {state.phase==='ready'&&state.nextCursor&&<button type="button" disabled={busy} onClick={more}>{state.loadingMore?t('taskExecution.loading'):t('business.tasks.more')}</button>}
 </section>
}
