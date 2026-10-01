import type {ReactNode} from 'react'
import {sortTimeline,type TimelineEvent} from './object-timeline.ts'
import {attentionKinds,taskHistoryText,taskNeeds,type PreviewApproval,type PreviewTask} from './task-preview.ts'
import {roleName,type PreviewRole} from './role-preview.ts'
import type {RunView} from './task-run-api.js'
import type {TaskHandoff} from './handoff-api.js'
import type {TaskCompletionRecord} from './task-api.js'
import type {TaskMaterial} from './task-material-api.js'
import type {Artifact} from './artifact-preview.js'
import type {AttentionItem} from './attention-item.js'
import type {TeloaTranslate} from './i18n/index.js'
import {taskRunPhaseKeys,taskRunReasonKeys} from './task-run-presentation.ts'

export type TaskTimelineFaces={executions:ReactNode;securityAction:ReactNode;completion:ReactNode;handoffAction:ReactNode;knowledge:ReactNode;need:ReactNode;supplements:ReactNode;source:ReactNode;approval:ReactNode;approvalHistory:ReactNode}
export type TaskTimelineInput={
 task:PreviewTask;roles:readonly PreviewRole[]
 runs:readonly RunView[];runsLoaded?:boolean;record:TaskCompletionRecord|null;materials:readonly TaskMaterial[]
 artifacts:readonly Artifact[];approvals:readonly PreviewApproval[]
 securityItems:readonly AttentionItem[];handoffs:readonly TaskHandoff[]
 /** TaskCompletion.tsx:14 的可见性守卫在页面侧用 taskCompletionVisible 复算后传入。 */
 completionVisible:boolean
 faces:TaskTimelineFaces;t:TeloaTranslate
}

/** TaskCompletion.tsx:14 守卫的纯函数版，供 completionVisible 与测试共用。 */
export function taskCompletionVisible(task:Pick<PreviewTask,'storage'|'state'|'assigneeId'>):boolean{
 return task.storage==='persistent'&&(task.state==='completed'||(task.assigneeId==='self'?task.state==='running':task.state==='waiting'))
}

/**
 * 把运行、审批、成果、结项、接任、来源、知识、变更、待办九类记录映射成统一事件；at 一律沿用宿主给的
 * UTC ISO 字串，最后交给 sortTimeline 倒序。安全动作和交接表单常驻页面管理区；
 * 时间线只挂定位按钮，关注项增删不能销毁未提交草稿或恢复状态。
 *
 * 给页面接线的提醒：runs / record / materials 来自内容面子组件的只读回调（onRuns / onRecord / onMaterials），
 * 子组件的取数 effect 没把回调放进依赖，页面传回调时必须用 useCallback 稳住引用，否则每次重渲染都会
 * 重新上报并触发一轮多余的重算。
 */
export function taskTimelineEvents(input:TaskTimelineInput):TimelineEvent[]{
 const {task,roles,runs,record,materials,artifacts,approvals,securityItems,handoffs,completionVisible,faces,t}=input
 const events:TimelineEvent[]=[]
 if(runs.length===0&&task.storage==='persistent'){
  const closed=task.state==='completed'||task.state==='cancelled'
  const ready=input.runsLoaded===true&&!closed
  events.push({id:'run:current',kind:'run',at:task.updatedAt,title:t(ready?'task.timeline.runReady':'taskExecution.title'),pending:ready,detail:faces.executions,anchor:'run'})
 }else{
  const runEvents=sortTimeline(runs.map(run=>({
   id:'run:'+run.id,kind:'run' as const,at:run.createdAt,
   title:t('task.timeline.run',{role:run.roleName,phase:t(run.reason?taskRunReasonKeys[run.reason]??'taskExecution.reason.ended':taskRunPhaseKeys[run.state])}),
  })))
  // 运行内容面包含取数与写入恢复状态：固定身份并留在顶层，不能随最新记录或历史折叠重新挂载。
  runEvents.forEach((event,index)=>events.push(index===0?{...event,id:'run:current',detail:faces.executions,anchor:'run'}:{...event,foldKey:'run'}))
 }
 securityItems.filter(item=>item.target.kind==='security-action'&&item.target.taskId===task.id).forEach(item=>{
  events.push({id:'approval:'+item.id,kind:'approval',at:item.occurredAt||task.updatedAt,title:t('task.timeline.approval'),foldKey:'approval',pending:true,actions:faces.securityAction})
 })
 const latestApproval=approvals.at(-1)
 if(latestApproval)events.push({id:'approval:'+latestApproval.id,kind:'approval',at:latestApproval.submittedAt,title:t('task.timeline.approval'),pending:latestApproval.status==='pending',detail:faces.approval,anchor:'approval'})
 approvals.slice(0,-1).forEach((item,index)=>{
  events.push({id:'approval:'+item.id,kind:'approval',at:item.submittedAt,title:t('task.timeline.approval'),foldKey:'approval',...(index===0?{detail:faces.approvalHistory}:{})})
 })
 for(const artifact of artifacts){
  if(artifact.source.kind!=='task'||artifact.source.id!==task.id)continue
  for(const version of artifact.versions)events.push({id:'artifact:'+artifact.id+':'+version.number,kind:'artifact',at:version.at,title:t('task.timeline.artifact',{version:version.number,title:version.title}),foldKey:'artifact',anchor:'artifact'})
 }
 if(task.state==='completed'){
  events.push({id:'completion',kind:'completion',at:record?.completedAt??task.updatedAt,title:record?t('task.timeline.completion',{version:record.artifactVersion}):t('taskCompletion.record'),detail:faces.completion,anchor:'completion'})
 }else if(completionVisible){
  events.push({id:'completion:pending',kind:'completion',at:task.updatedAt,title:t('task.timeline.completionPending'),pending:true,detail:faces.completion,anchor:'completion'})
 }
 const taskHandoffs=handoffs.filter(item=>item.taskId===task.id)
 taskHandoffs.filter(item=>item.status==='pending').forEach(item=>{
  events.push({id:'handoff:'+item.id,kind:'handoff',at:item.createdAt,title:t('task.timeline.handoffPending',{from:roleName(roles,item.fromRoleId,t)}),pending:true,actions:faces.handoffAction})
 })
 for(const item of taskHandoffs){
  if(item.status==='resolved')events.push({id:'handoff:'+item.id,kind:'handoff',at:item.createdAt,title:t('task.timeline.handoffResolved',{from:roleName(roles,item.fromRoleId,t)}),foldKey:'handoff'})
 }
 if(task.source)events.push({id:'source',kind:'source',at:task.createdAt,title:t('task.timeline.source'),detail:faces.source})
 materials.forEach((item,index)=>{
  events.push({id:'knowledge:'+item.id,kind:'knowledge',at:item.createdAt,title:t('task.timeline.knowledge',{title:item.title,version:item.resourceVersion}),foldKey:'knowledge',...(index===0?{detail:faces.knowledge}:{})})
 })
 task.history.forEach((entry,index)=>{
  events.push({id:'change:'+index,kind:'change',at:entry.at,title:taskHistoryText(entry,input.t),foldKey:'change',meta:roleName(roles,entry.actorId,t)})
 })
 if(task.storage!=='persistent'&&task.need&&task.need!=='approval'&&task.need!=='handoff'){
  events.push({id:'attention:need',kind:'attention',at:task.updatedAt,title:t('task.timeline.attention',{kind:t(attentionKinds[task.need])}),pending:true,detail:faces.need,anchor:'attention'})
 }
 if(task.storage!=='persistent'&&taskNeeds(task).includes('handoff')){
  events.push({id:'attention:handoff',kind:'attention',at:task.handoff?.at??task.updatedAt,title:t('task.timeline.attention',{kind:t('attention.handoff')}),pending:true,actions:faces.handoffAction})
 }
 if(task.supplements.length>0)events.push({id:'change:supplements',kind:'change',at:task.updatedAt,title:t('task.detail.supplements'),detail:faces.supplements})
 return sortTimeline(events)
}
