import type {TaskCompletionPolicy} from '@teloa/contract'
import type {AttentionKind,PreviewTask} from './task-preview.js'
import type {TaskAttention} from './task-api.js'
import type {TaskAttentionReasonKey} from './task-attention-presentation.js'
import type {TeloaTranslate} from './i18n/index.js'
import {describeTaskProgress} from './task-detail-presentation.ts'

/** 状态框主按钮指向的页内锚点：与时间线／属性栏的 `data-teloa-anchor` 取值一致。 */
export type TaskStatusAnchor='run'|'approval'|'completion'|'handoff'|'owner'|'attention'|'artifact'
/**
 * 主／副按钮的动作数据。`anchor` 由 `focusObjectAnchor(root,anchor,focus)` 定位——
 */
export type TaskStatusAction=
 |{kind:'anchor';anchor:TaskStatusAnchor;focus?:'prepare'}
 |{kind:'progress';action:'pause'|'resume'}
 |{kind:'open-artifact'}
export type TaskStatusButton={label:string;action:TaskStatusAction}
export type TaskStatusBoxModel={tone:'info'|'warn'|'good'|'muted';sentence:string;hint:string;reasonKey?:TaskAttentionReasonKey;primary?:TaskStatusButton;secondary?:TaskStatusButton}
export type TaskStatusInput={
 completionPolicy?:TaskCompletionPolicy;state:PreviewTask['state'];needs:readonly AttentionKind[]
 attention:TaskAttention|null|undefined        // 持久任务的服务端关注；沙盒任务传 undefined
 assigned:boolean                               // task.assigneeId!=='self'
 ownerName:string;runCount:number
 completion:{artifactVersion:number}|null       // 结项记录（TaskCompletion 的 onRecord）
 t:TeloaTranslate
}

const failedReasonKeys={'execution-failed':'task.attention.reason.executionFailed','execution-configuration-failed':'task.attention.reason.executionConfigurationFailed'} as const
const sandboxNeeds:readonly AttentionKind[]=['materials','connection','error','dispatch']
const anchor=(label:string,target:TaskStatusAnchor,focus?:'prepare'):TaskStatusButton=>({label,action:{kind:'anchor',anchor:target,...(focus?{focus}:{})}})

/** 任务状态框映射：自上而下第一条命中即返回，关注原因优先于状态。 */
export function taskStatusBox(input:TaskStatusInput):TaskStatusBoxModel{
 const {state,needs,attention,t}=input
 const progress=describeTaskProgress(input.state,input.needs,input.t,input.completionPolicy)
 const base={sentence:progress.title,hint:progress.description}
 const reason=attention?.reason
 if(needs.includes('approval')||needs.includes('execution'))return {...base,tone:'warn',primary:anchor(t('task.status.action.approve'),'approval')}
 if(needs.includes('handoff'))return {...base,tone:'warn',primary:anchor(t('task.status.action.assign'),'handoff')}
 if(reason==='execution-failed'||reason==='execution-configuration-failed')return {...base,tone:'warn',reasonKey:failedReasonKeys[reason],primary:anchor(t('task.status.action.rePrepare'),'run','prepare')}
 if(reason==='execution-completed'||needs.includes('review'))return {...base,tone:'warn',...(reason==='execution-completed'?{reasonKey:'task.attention.reason.executionCompleted' as const}:{}),primary:anchor(t('task.status.action.review'),'completion'),secondary:anchor(t('task.status.action.viewRun'),'run')}
 if(reason==='task-waiting')return {...base,tone:'warn',reasonKey:'task.attention.reason.taskWaiting',primary:anchor(t('task.status.action.viewRun'),'run')}
 if(sandboxNeeds.some(need=>needs.includes(need)))return {...base,tone:'warn',primary:anchor(t('attention.action.go'),'attention')}
 if(state==='blocked')return {...base,tone:'warn',...(reason==='task-blocked'?{reasonKey:'task.attention.reason.taskBlocked' as const}:{}),primary:anchor(t('task.status.action.handleBlock'),'run')}
 if(state==='ready'&&!input.assigned)return {...base,tone:'info',sentence:t('task.status.unassigned'),primary:anchor(t('task.status.action.assign'),'owner')}
 if(state==='ready')return {...base,tone:'info',primary:anchor(t('taskExecution.prepare'),'run','prepare')}
 if(state==='running')return {...base,tone:'info',sentence:input.runCount>0?t('task.status.running',{count:input.runCount,owner:input.ownerName}):progress.title,primary:anchor(t('task.status.action.viewRun'),'run'),secondary:{label:t('task.detail.action.pause',{demo:''}),action:{kind:'progress',action:'pause'}}}
 if(state==='paused')return {...base,tone:'muted',primary:{label:t('task.detail.action.resume',{demo:''}),action:{kind:'progress',action:'resume'}}}
 if(state==='completed')return {...base,tone:'good',sentence:input.completion?t('task.status.completed',{version:input.completion.artifactVersion}):progress.title,primary:{label:t('taskCompletion.view'),action:{kind:'open-artifact'}}}
 if(state==='cancelled')return {...base,tone:'muted'}
 return {...base,tone:'info',primary:anchor(t('task.status.action.viewRun'),'run')}
}
