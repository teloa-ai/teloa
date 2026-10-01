import type {SecurityActionAttention} from './security-action-api.js'
import type {BusinessPreview,BusinessTarget} from './business-preview.js'
import type {BindingFailure} from './capability-work.js'
import type {ContinuousPreview,ContinuousTarget} from './continuous-preview.js'
import type {TaskHandoff} from './handoff-api.js'
import type {TaskAttentionItem} from './task-api.js'
import type {PreviewTask} from './task-preview.js'

export type AttentionKind='approval'|'materials'|'connection'|'error'|'review'|'handoff'|'dispatch'|'execution'
export type AttentionPersistence='saved'|'local-recovery'|'server-recovery'|'example'
export type AttentionSource='security-action'|'task'|'handoff'|'business'|'plan'|'binding'|'installation'|'local-recovery'|'server-recovery'
export type AttentionReasonKey=
  |`security.attention.${SecurityActionAttention['reason']}`
  |'task.attention.reason.taskBlocked'
  |'task.attention.reason.executionFailed'
  |'task.attention.reason.executionConfigurationFailed'
  |'task.attention.reason.executionCompleted'
  |'task.attention.reason.taskWaiting'
  |'attention.recovery.taskMaterial'
  |'attention.recovery.artifact'
  |'attention.recovery.group'
  |'attention.recovery.industryLoad'
  |'attention.recovery.skillInstall'
  |'attention.recovery.serverRequest'
  |`task.detail.operation.${BusinessPreview['operations'][number]['state']}`
export type AttentionReason={kind:'message';key:AttentionReasonKey}|{kind:'text';text:string}
export type InstallationSelection=`skill:${string}`|`plugin:${string}`
export type AttentionTarget=
  |{kind:'security-action';taskId:string;actionId:string}
  |{kind:'task';id:string}
  |{kind:'artifact';source:{kind:'session'|'task';id:string};artifactId:string;version:number}
  |{kind:'group';id:string}
  |{kind:'market';itemId:string}
  |{kind:'industry-skill';loadId:string;itemInstanceId:string}
  |{kind:'business';target:BusinessTarget}
  |ContinuousTarget
  |{kind:'binding';id:string;version:number}
  |{kind:'installation';selection:InstallationSelection}
  |{kind:'pending-request';requestId:string}

export type AttentionItem={
  id:string
  kind:AttentionKind
  source:AttentionSource
  persistence:AttentionPersistence
  target:AttentionTarget
  title:string
  reason:AttentionReason
  scope:string
  occurredAt:string
}

export type AttentionSnapshot={
  securityAttention?:readonly SecurityActionAttention[]
  tasks:readonly PreviewTask[]
  taskAttention:readonly TaskAttentionItem[]
  handoffs:readonly TaskHandoff[]
  business:BusinessPreview
  continuous:ContinuousPreview
  savedPlanIds:ReadonlySet<string>
  bindings:readonly BindingFailure[]
  localRecoveries?:readonly AttentionLocalRecovery[]
  serverRecoveries?:readonly AttentionServerRecovery[]
}

export type AttentionLocalRecovery=Omit<AttentionItem,'persistence'>
export type AttentionServerRecovery=Omit<AttentionItem,'persistence'>

export type AttentionActions={
  openSecurityAction?:(taskId:string,actionId:string)=>void
  openTask:(id:string)=>void
  openArtifact:(source:{kind:'session'|'task';id:string},artifactId:string,version:number)=>void
  openGroup:(id:string)=>void
  openMarket:(itemId:string)=>void
  openIndustrySkill:(loadId:string,itemInstanceId:string)=>void
  openBusiness:(target:BusinessTarget)=>void
  openPlans:(target:ContinuousTarget)=>void
  openBinding:(id:string,version?:number)=>void
  openInstallation:(selection:InstallationSelection)=>void
  openPendingRequest?:(requestId:string)=>void
}

const sourceKeys={'security-action':'security.title',task:'attention.source.task',handoff:'attention.source.handoff',business:'attention.source.business',plan:'attention.source.plan',binding:'attention.source.binding',installation:'attention.source.installation','local-recovery':'attention.source.localRecovery','server-recovery':'attention.source.serverRecovery'} as const
export const attentionSourceKey=(source:AttentionSource)=>sourceKeys[source]
export const attentionPersistenceKey=(persistence:AttentionPersistence)=>persistence==='example'?'attention.persistence.example' as const:persistence==='server-recovery'?'attention.persistence.serverRecovery' as const:undefined

export function attentionReasonText(reason:AttentionReason,t:(key:AttentionReasonKey)=>string):string{return reason.kind==='message'?t(reason.key):reason.text}

const priorities:Record<AttentionKind,number>={approval:0,materials:1,connection:2,error:3,review:4,handoff:5,dispatch:6,execution:7}
const compare=(a:AttentionItem,b:AttentionItem)=>priorities[a.kind]-priorities[b.kind]||Date.parse(b.occurredAt)-Date.parse(a.occurredAt)||a.id.localeCompare(b.id)
const taskReasonKeys:Record<NonNullable<TaskAttentionItem['attention']>['reason'],AttentionReasonKey>={
  'task-blocked':'task.attention.reason.taskBlocked',
  'execution-failed':'task.attention.reason.executionFailed',
  'execution-configuration-failed':'task.attention.reason.executionConfigurationFailed',
  'execution-completed':'task.attention.reason.executionCompleted',
  'task-waiting':'task.attention.reason.taskWaiting',
}
const operationReasonKeys:Record<BusinessPreview['operations'][number]['state'],AttentionReasonKey>={pending:'task.detail.operation.pending',approved:'task.detail.operation.approved',rejected:'task.detail.operation.rejected',changes:'task.detail.operation.changes',stale:'task.detail.operation.stale',executing:'task.detail.operation.executing',unknown:'task.detail.operation.unknown',partial:'task.detail.operation.partial',verified:'task.detail.operation.verified'}

export function aggregateAttentionItems(snapshot:AttentionSnapshot):AttentionItem[]{
  const items:AttentionItem[]=[]
  for(const row of snapshot.securityAttention??[]){
    const task=snapshot.taskAttention.find(item=>item.task.id===row.taskId)?.task??snapshot.tasks.find(task=>task.id===row.taskId)
    items.push({id:'security-action:'+row.actionId,kind:row.reason==='approval-required'?'approval':row.reason==='execution-required'?'execution':row.reason==='adapter-unavailable'?'connection':row.reason==='execution-failed'?'error':'review',source:'security-action',persistence:'saved',target:{kind:'security-action',taskId:row.taskId,actionId:row.actionId},title:task?.title??row.taskId,reason:{kind:'message',key:'security.attention.'+row.reason as AttentionReasonKey},scope:task?.scope??'SOC',occurredAt:task?.updatedAt??''})
  }
  for(const row of snapshot.taskAttention){
    if(!row.attention)continue
    items.push({id:'task:'+row.task.id,kind:row.attention.kind,source:'task',persistence:'saved',target:{kind:'task',id:row.task.id},title:row.task.title,reason:{kind:'message',key:taskReasonKeys[row.attention.reason]},scope:row.task.scope,occurredAt:row.task.updatedAt})
  }
  for(const row of snapshot.handoffs){
    if(row.status!=='pending')continue
    const task=snapshot.taskAttention.find(item=>item.task.id===row.taskId)?.task
    items.push({id:'task:'+row.taskId,kind:'handoff',source:'handoff',persistence:'saved',target:{kind:'task',id:row.taskId},title:task?.title??row.taskId,reason:{kind:'text',text:row.reason},scope:task?.scope??'general',occurredAt:row.createdAt})
  }
  for(const task of snapshot.tasks){
    if(task.storage==='persistent')continue
    const kinds=[...(task.need?[task.need]:[]),...(task.handoff?['handoff' as const]:[])]
    for(const kind of new Set(kinds))items.push({id:'task:'+task.id,kind,source:kind==='handoff'?'handoff':'task',persistence:'example',target:{kind:'task',id:task.id},title:task.title,reason:{kind:'text',text:kind==='handoff'?(task.handoff?.reason??task.goal):(task.request||task.result||task.goal)},scope:task.scope,occurredAt:kind==='handoff'?(task.handoff?.at??task.updatedAt):task.updatedAt})
  }
  for(const run of snapshot.business.runs.filter(run=>run.state==='failed'||run.state==='completed'&&run.findings>0&&!run.taskId)){
    items.push({id:'business:analysis:'+run.id,kind:run.state==='failed'?'error':'dispatch',source:'business',persistence:'example',target:{kind:'business',target:{scope:run.scope,section:'analysis',id:run.id}},title:run.title,reason:{kind:'text',text:run.result},scope:run.scope,occurredAt:run.createdAt})
  }
  for(const operation of snapshot.business.operations.filter(operation=>['pending','unknown','partial','changes','stale'].includes(operation.state))){
    items.push({id:'business:operation:'+operation.id,kind:operation.state==='pending'?'approval':'error',source:'business',persistence:'example',target:{kind:'business',target:{scope:operation.scope,section:'execution',id:operation.id}},title:operation.title,reason:{kind:'message',key:operationReasonKeys[operation.state]},scope:operation.scope,occurredAt:operation.history.at(-1)!.at})
  }
  for(const plan of snapshot.continuous.plans.filter(plan=>plan.handoff&&!plan.archived)){
    items.push({id:'plan:plan:'+plan.id,kind:'handoff',source:'plan',persistence:snapshot.savedPlanIds.has(plan.id)?'saved':'example',target:{kind:'plan',id:plan.id},title:plan.fields.title,reason:{kind:'text',text:plan.handoff!.reason},scope:plan.fields.scope,occurredAt:plan.history.at(-1)!.at})
  }
  for(const run of snapshot.continuous.runs.filter(run=>run.state==='failed'&&!run.resolution&&!snapshot.continuous.runs.some(child=>child.retryOf===run.id))){
    items.push({id:'plan:run:'+run.id,kind:'error',source:'plan',persistence:snapshot.savedPlanIds.has(run.planId)?'saved':'example',target:{kind:'run',id:run.id},title:run.snapshot.fields.title,reason:{kind:'text',text:run.result},scope:run.snapshot.fields.scope,occurredAt:run.finishedAt??run.createdAt})
  }
  for(const row of snapshot.bindings)items.push({id:'binding:'+row.bindingId+':v'+row.version,kind:'error',source:'binding',persistence:'example',target:{kind:'binding',id:row.bindingId,version:row.version},title:row.title+' · v'+row.version,reason:{kind:'text',text:row.message},scope:row.scope,occurredAt:row.at})
  for(const recovery of snapshot.localRecoveries??[])items.push({...recovery,persistence:'local-recovery'})
  for(const recovery of snapshot.serverRecoveries??[])items.push({...recovery,persistence:'server-recovery'})
  const unique=new Map<string,AttentionItem>()
  for(const item of items){const current=unique.get(item.id);if(!current||compare(item,current)<0)unique.set(item.id,item)}
  return [...unique.values()].sort(compare)
}

export function formalAttentionCount(items:readonly AttentionItem[]):number{return items.filter(item=>item.persistence!=='example').length}

export function openAttentionItem(item:AttentionItem,actions:AttentionActions):void{
  const target=item.target
  if(target.kind==='security-action'){if(actions.openSecurityAction)actions.openSecurityAction(target.taskId,target.actionId);else throw Error('缺少外部动作打开入口。')}
  else if(target.kind==='task')actions.openTask(target.id)
  else if(target.kind==='artifact')actions.openArtifact(target.source,target.artifactId,target.version)
  else if(target.kind==='group')actions.openGroup(target.id)
  else if(target.kind==='market')actions.openMarket(target.itemId)
  else if(target.kind==='industry-skill')actions.openIndustrySkill(target.loadId,target.itemInstanceId)
  else if(target.kind==='business')actions.openBusiness(target.target)
  else if(target.kind==='binding')actions.openBinding(target.id,target.version)
  else if(target.kind==='installation')actions.openInstallation(target.selection)
  else if(target.kind==='pending-request')actions.openPendingRequest?.(target.requestId)
  else actions.openPlans(target)
}
