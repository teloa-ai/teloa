import type { IndustryLoad } from './industry-load.ts'
import type { IndustryTaskSource } from './industry-task.ts'
import { businessScopeNames } from './business-directory.ts'
import { createArtifact, type Artifact, type ArtifactRef } from './artifact-preview.ts'
import { taskArtifactSource } from './artifact-source.ts'
import { collaborationScopes, type CollaborationScope } from './collaboration-preview.ts'
import { approvalStateKeys, approvalText, decideApproval, localizedText, newApproval, type ApprovalRecord, type ApprovalText, type LocalizedText } from './approval-preview.ts'
import { canReceiveTask, roleName, withRoleExamples, type PreviewRole } from './role-preview.ts'
import { emptyBusinessPreview, type BusinessPreview, type BusinessTarget, type ObjectRef } from './business-preview.ts'
import { emptyContinuous, type ContinuousPreview } from './continuous-preview.ts'
import type {TeloaTranslate} from './i18n/index.ts'

// 仅驱动正式宿主中的界面演示；后端接入时由可信身份、版本检查和审计服务接管。
export const taskStates={ready:'status.ready',running:'status.running',paused:'status.paused',waiting:'status.waiting',blocked:'status.blocked',completed:'status.completed',cancelled:'status.cancelled'} as const
export const attentionKinds={approval:'attention.approval',materials:'attention.materials',connection:'attention.connection',error:'attention.error',review:'attention.review',handoff:'attention.handoff',dispatch:'attention.dispatch',execution:'plan.run.prepared'} as const
export type AttentionKind=keyof typeof attentionKinds
/** `authorId` 缺省表示来源仅从群消息任务来源记录还原，服务端未记录原始作者。 */
export type TaskSource={groupId:string;messageId:string;rootId:string;text:string;authorId?:string;trigger?:'manual'|'mention'|'routed'}
export type TaskHistoryEntry=({message:LocalizedText;text?:never}|{message?:never;text:string})&{actorId:string;at:string}
type Supplement={id:string;source:string;note:string;status:'pending'|'accepted'|'rejected'}
export type PreviewTask={
  storage?:'persistent';id:string;title:string;goal:string;scope:CollaborationScope;object:string;version:number;state:keyof typeof taskStates
  /** 交办时关联的协作群与使用技能；未保存或历史演示任务没有这两项。 */
  groupId?:string|null;skills?:readonly string[]
  need:AttentionKind|null;request:string;authorId:string;assigneeId:string;assigneeHistory:string[];createdAt:string;updatedAt:string
  handoff?:{fromId:string;reason:string;at:string}
  industrySource?:IndustryTaskSource
  objectRefs?:ObjectRef[];businessSource?:BusinessTarget
  planSource?:{planId:string;runId:string;planVersion:number;title:string}
  reviewArtifact?:ArtifactRef;artifact?:ArtifactRef;artifactSource?:ArtifactRef;sourceTaskId?:string;source?:TaskSource;result:string;evidence:string[];history:TaskHistoryEntry[];supplements:Supplement[]
  approvalRequired:boolean;risk:ApprovalText;execution:'not_started';
}
export type PreviewApproval=ApprovalRecord&{taskId:string}
export type TaskPreview={industryLoads:IndustryLoad[];artifacts:Artifact[];tasks:PreviewTask[];approvals:PreviewApproval[];roles:PreviewRole[];business:BusinessPreview;continuous:ContinuousPreview}
export function taskNeeds(task:PreviewTask):AttentionKind[]{return [...new Set([...(task.need?[task.need]:[]),...(task.handoff?['handoff' as const]:[])])]}
export type TaskChange=(
  |{type:'create';id:string;title:string;goal:string;scope:CollaborationScope}
  |{type:'edit';taskId:string;title:string;goal:string}
  |{type:'submit';taskId:string;id:string}
  |{type:'decide';approvalId:string;expectedVersion:number;decision:'approved'|'rejected'|'changes';note:string}
  |{type:'supplement';taskId:string;id:string;source:string;note:string}
  |{type:'verify';taskId:string;supplementId:string;accepted:boolean}
  |{type:'retry';taskId:string;succeeded:boolean}
  |{type:'handoff';taskId:string;assigneeId:string;note:string}
  |{type:'progress';taskId:string;action:'start'|'pause'|'resume'|'cancel'|'complete';result?:string}
)&{now:string}

export const emptyTaskPreview=():TaskPreview=>({industryLoads:[],artifacts:[],tasks:[],approvals:[],roles:[],business:emptyBusinessPreview(),continuous:emptyContinuous()})
const required=(value:string,label:string,max=4000)=>{const text=value.trim();if(!text||text.length>max)throw new Error(label+'不能为空，且不能超过 '+max+' 字。');return text}
function append(task:PreviewTask,message:LocalizedText,now:string):PreviewTask{return {...task,updatedAt:now,history:[...task.history,{message,actorId:'self',at:now}]}}
export function taskHistoryText(entry:TaskHistoryEntry,t:TeloaTranslate):string{
  if(!entry.message)return entry.text
  if(entry.message.key==='task.history.approvalDecision'){
    const decision=entry.message.params?.decision
    const status=typeof decision==='string'&&decision in approvalStateKeys?t(approvalStateKeys[decision as keyof typeof approvalStateKeys]):String(decision??'')
    return t(entry.message.key,{...entry.message.params,status})
  }
  return approvalText(entry.message,t)
}
function createTask(id:string,title:string,goal:string,scope:CollaborationScope,now:string,scopes:Readonly<Record<string,string>>=collaborationScopes):PreviewTask{
  if(!Object.hasOwn(scopes,scope))throw new Error('业务范围无效。')
  return {id:required(id,'编号'),title:required(title,'任务名称',120),goal:required(goal,'目标',8000),scope,object:'通用任务',version:1,state:'ready',need:null,request:'',authorId:'self',assigneeId:'self',assigneeHistory:['self'],createdAt:now,updatedAt:now,result:'',evidence:[],history:[{message:localizedText('task.history.created'),actorId:'self',at:now}],supplements:[],approvalRequired:false,risk:localizedText('task.approval.risk.none'),execution:'not_started'}
}

export function changeTaskPreview(state:TaskPreview,change:TaskChange):TaskPreview{
  if(!Number.isFinite(Date.parse(change.now)))throw new Error('时间无效。')
  if(change.type==='create'){
    if(state.tasks.some(task=>task.id===change.id))throw new Error('任务编号冲突。')
    return {...state,tasks:[...state.tasks,createTask(change.id,change.title,change.goal,change.scope,change.now,businessScopeNames(state.business.spaces))]}
  }
  const approval=change.type==='decide'?state.approvals.find(item=>item.id===change.approvalId):undefined
  const taskId=change.type==='decide'?approval?.taskId:change.taskId
  const task=state.tasks.find(item=>item.id===taskId)
  if(!task)throw new Error('任务或审批不存在。')
  if(change.type==='progress'&&change.action==='complete'&&task.state==='completed'&&task.artifact&&task.result===change.result?.trim())return state
  let next=task,approvals=state.approvals,artifacts=state.artifacts
  const log=(key:Parameters<typeof localizedText>[0],params?:Readonly<Record<string,string|number>>)=>{next=append(next,localizedText(key,params),change.now)}
  if(change.type==='decide'){
    if(!approval)throw new Error('审批不存在。')
    const decided=decideApproval(approval,change,task.version)
    const note=decided.decision!.note
    approvals=approvals.map(item=>item.id===approval.id?decided:item)
    next={...task,state:change.decision==='approved'&&!task.handoff?'ready':'waiting',need:change.decision==='approved'?null:'approval'}
    log('task.history.approvalDecision',{decision:change.decision,note})
  }else if(change.type==='edit'){
    if(task.state==='completed'||task.state==='cancelled')throw new Error('当前状态不能修改任务。')
    const title=required(change.title,'任务名称',120),goal=required(change.goal,'目标',8000)
    if(title===task.title&&goal===task.goal)return state
    next={...task,title,goal,version:task.version+1,...(task.approvalRequired?{need:'approval' as const,state:'waiting' as const}:{})}
    approvals=approvals.map(item=>item.taskId===task.id&&item.status==='pending'?{...item,status:'stale',version:item.version+1}:item)
    log('task.history.edited',{version:next.version})
  }else if(change.type==='submit'){
    if(!task.approvalRequired||task.state==='cancelled'||task.state==='completed')throw new Error('当前任务不需要提交审批。')
    if(approvals.some(item=>item.taskId===task.id&&item.status==='approved'&&item.snapshot.subjectVersion===task.version))throw new Error('当前版本已批准，无需重复提交。')
    if(approvals.some(item=>item.id===change.id))throw new Error('审批编号冲突。')
    if(approvals.some(item=>item.taskId===task.id&&item.status==='pending'&&Date.parse(item.expiresAt)>Date.parse(change.now)))throw new Error('已有待处理审批。')
    approvals=approvals.map(item=>item.taskId===task.id&&item.status==='pending'?{...item,status:'stale',version:item.version+1}:item)
    const draftArtifact=task.reviewArtifact?artifacts.find(item=>item.id===task.reviewArtifact!.id)?.versions.find(item=>item.number===task.reviewArtifact!.version):undefined
    if(task.reviewArtifact&&!draftArtifact)throw Error('审批稿件版本不可用，未提交。')
    approvals=[...approvals,{...newApproval(required(change.id,'审批编号'),{...(task.reviewArtifact&&draftArtifact?{artifact:{...task.reviewArtifact},artifactText:draftArtifact.sections.map(section=>section.title+'\n'+section.text).join('\n\n')} :{}),subjectVersion:task.version,subjectLabel:localizedText('task.approval.subject'),title:task.title,goal:task.goal,object:task.object==='通用任务'?localizedText('task.approval.object.general'):task.object,result:task.result,evidence:task.evidence,risk:task.risk,effect:localizedText('task.approval.effect')},change.now),taskId:task.id}]
    next={...task,state:'waiting',need:'approval'};log('task.history.submitted',{version:task.version})
  }else if(change.type==='supplement'){
    if(task.need!=='materials')throw new Error('当前任务没有资料缺口。')
    if(task.supplements.some(item=>item.id===change.id))throw new Error('补充记录编号冲突。')
    next={...task,supplements:[...task.supplements,{id:change.id,source:required(change.source,'资料来源'),note:required(change.note,'补充说明'),status:'pending'}]};log('task.history.supplemented')
  }else if(change.type==='verify'){
    const supplement=task.supplements.find(item=>item.id===change.supplementId)
    if(task.need!=='materials'||!supplement||supplement.status!=='pending')throw new Error('没有待核验的补充资料。')
    next={...task,need:change.accepted?null:'materials',state:change.accepted?(task.handoff?'waiting':'ready'):task.state,supplements:task.supplements.map(item=>item.id===supplement.id?{...item,status:change.accepted?'accepted':'rejected'}:item),evidence:change.accepted?[...task.evidence,supplement.source+'：'+supplement.note]:task.evidence}
    log(change.accepted?'task.history.materialAccepted':'task.history.materialRejected')
  }else if(change.type==='retry'){
    if(task.need!=='error')throw new Error('当前任务没有待处理异常。')
    next={...task,need:change.succeeded?null:'error',state:change.succeeded?(task.handoff?'waiting':'ready'):'blocked'};log(change.succeeded?'task.history.retrySucceeded':'task.history.retryFailed')
  }else if(change.type==='handoff'){
    if(!taskNeeds(task).includes('handoff'))throw new Error('当前任务不需要交接。')
    if(!canReceiveTask(state.roles.find(role=>role.id===change.assigneeId),task.scope)||change.assigneeId===(task.handoff?.fromId||task.assigneeId))throw new Error('请选择在岗、同业务的接续员工；分身先代拟。')
    const {handoff,...remaining}=task
    const need=task.need==='handoff'?null:task.need
    next={...remaining,assigneeId:change.assigneeId,assigneeHistory:[...new Set([...task.assigneeHistory,task.assigneeId,change.assigneeId])],need,state:need?'waiting':'ready'};log('task.history.handoff',{assignee:roleName(state.roles,change.assigneeId),note:required(change.note,'交接说明')})
  }else if(change.type==='progress'){
    if(taskNeeds(task).includes('handoff'))throw new Error('先完成交接。')
    const assignee=state.roles.find(role=>role.id===task.assigneeId)
    if(task.assigneeId!=='self'&&(!assignee||assignee.state==='retired'))throw new Error('负责员工不可接续，请先安排交接。')
    if((change.action==='start'||change.action==='resume')&&assignee&&!canReceiveTask(assignee,task.scope))throw new Error('员工暂停新任务或业务范围不匹配，暂时不能接续。')
    if(task.approvalRequired)throw new Error('审批任务需走决定与独立执行流程。')
    if(task.need)throw new Error('先处理当前资料缺口或异常。')
    const allowed={start:['ready'],pause:['running'],resume:['paused'],cancel:['ready','running','paused','blocked','waiting'],complete:['running']} as const
    if(!(allowed[change.action] as readonly string[]).includes(task.state))throw new Error('当前状态不能执行此操作。')
    const states={start:'running',pause:'paused',resume:'running',cancel:'cancelled',complete:'completed'} as const
    next={...task,state:states[change.action],result:change.action==='complete'?required(change.result||'','结果'):task.result}
    log(`task.history.progress.${change.action}` as Parameters<typeof localizedText>[0])
    if(change.action==='complete'){
      const artifact=createArtifact({id:'task-result:'+task.id,source:taskArtifactSource(next),title:task.title,sections:[{id:'result',title:'完成结果',text:next.result}],note:'记录任务完成结果',primary:true,now:change.now})
      if(artifacts.some(item=>item.id===artifact.id))throw Error('产物编号冲突，任务未完成。')
      artifacts=[...artifacts,artifact];next={...next,artifact:{id:artifact.id,version:1}}
    }
  }
  return {...state,tasks:state.tasks.map(item=>item.id===next.id?next:item),approvals,artifacts}
}

export function withTaskExamples(state:TaskPreview,now:string):TaskPreview{
  let next={...state,roles:withRoleExamples(state.roles,now)}
  const samples=[
    {id:'preview-review',title:'核对文件服务器隔离建议',goal:'核实 srv-file-02 的异常访问后，决定是否授权隔离该主机。',scope:'SOC' as const,object:'案件 SOC-0042 · srv-file-02',need:'approval' as const,request:'核对当前目标和影响范围，再决定。',risk:'高风险 · 隔离将中断这台主机的业务连接。',result:'发现异常批量访问，建议由本人核对影响后授权隔离；尚未执行。'},
    {id:'preview-material',title:'补充资产责任人与等级',goal:'核对 srv-file-02 的责任人和资产等级，再继续判断。',scope:'SOC' as const,object:'案件 SOC-0043',need:'materials' as const,request:'请补充资产责任人或资产记录来源。'},
    {id:'preview-error',title:'恢复代码仓库读取',goal:'读取 gateway 的依赖变更，核对回归范围。',scope:'AppSec' as const,object:'审计工单 APP-0018',need:'error' as const,request:'代码仓库连接认证过期。修复连接后重新读取，不能用旧缓存作结论。'},
    {id:'preview-handoff',title:'接续公共方案的来源核对',goal:'保留原研究记录，由接任者补齐来源与版本。',scope:'general' as const,object:'研究任务 RESEARCH-001',need:'handoff' as const,request:'原员工已退役。先选择接任者，保留原作者和待完成工作。'},
  ]
  for(const sample of samples){
    if(next.tasks.some(task=>task.id===sample.id))continue
    let task=createTask(sample.id,sample.title,sample.goal,sample.scope,now)
    const assigneeId=sample.id==='preview-handoff'?'retired-researcher':sample.scope==='AppSec'?'appsec':'investigator'
    const assignee=next.roles.find(role=>role.id===assigneeId)!
    task={...task,object:sample.object,need:sample.need,request:sample.request,state:sample.need==='error'?'blocked':'waiting',authorId:assigneeId,assigneeId,assigneeHistory:[assigneeId],...(assignee.state==='retired'?{handoff:{fromId:assigneeId,reason:'历史示例工作等待接续',at:now}}:{}),approvalRequired:sample.need==='approval',risk:sample.risk?localizedText('task.approval.risk.highInterruption'):task.risk,result:sample.result||'',evidence:['示例来源 · v1 · 仅用于界面核对'],history:[{message:localizedText('task.history.sampleWaiting'),actorId:assigneeId,at:now}]}
    next={...next,tasks:[...next.tasks,task]}
    if(task.approvalRequired)next=changeTaskPreview(next,{type:'submit',taskId:task.id,id:'preview-approval',now})
  }
  return next
}
