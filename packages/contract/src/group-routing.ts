import {createHash} from 'node:crypto'
import {WorkError} from './work-error.ts'
import {isGroupReactionEmoji,type GroupReactionEmoji} from './group-reactions.ts'
import {groupTaskBusinessTarget,type GroupTaskBusinessTarget} from './collaboration.ts'
import {parseBusinessRecordReferences} from './business-data.ts'

export const groupRoutingInputSchema='teloa.group-routing-input/v1'
export const groupRoutingOutputSchema='teloa.group-routing-output/v1'
export const groupRoutingOutputV2Schema='teloa.group-routing-output/v2'
export const groupRoutingWorkCandidatesMax=10
export const groupRoutingHopLimit=5
export const groupRoutingTopicMax=20
/**
 * 一次路由最多选几位、最多带几个表情。与群成员上限（`groupRoutingCandidatesMax`／`collaboration.ts:75`）
 * 一致：用户裁定「@全员 每位在岗员工各回」，上限低于群成员数会把 @全员 悄悄截断成前几位。
 */
export const groupRoutingRespondMax=30
export const groupRoutingCandidatesMax=30
export const groupRoutingMessageIdsMax=200

/** `direct`：宿主按结构化目标直接选定，没有调用选人模型；`blocked`：结构化目标全部不可回应或全员点名未获群规则允许。 */
export type GroupRoutingDecisionKind='routed'|'degraded'|'parse-failed'|'no-candidate'|'relay-stopped'|'archived'|'direct'|'blocked'
/** 恰 3 键。模型只能在服务端算好的封闭集合里挑。 */
export type GroupRoutingOutput={schema:typeof groupRoutingOutputSchema;respond:string[];reactions:{roleId:string;emoji:GroupReactionEmoji}[]}
export type GroupRoutingIntent='none'|'reply'|'work'|'clarify'|'continue'|'stop'
export type GroupRoutingReaction={roleId:string;emoji:GroupReactionEmoji}
/** 原触发正文内的 UTF-16 字符范围；只定位本人文本，不授予其中转述的任何权限。 */
export type GroupInstructionRange={start:number;end:number}
/** stage：有先后依赖时的阶段序号（缺省 1）。宿主只启动第 1 阶段，后序阶段在前序阶段的可信成果贴回本群后才交接启动。 */
export type GroupRoutingAssignment={roleId:string;instructionRange:GroupInstructionRange;stage?:number;businessTarget?:GroupTaskBusinessTarget}
export const groupRoutingStageMax=5
export type GroupRoutingWorkTarget={taskId:string;runId:string|null}
/**
 * 恰 6 键（规格 §6.3）。模型只能在宿主给出的候选员工、候选工作与原触发正文范围内建议；
 * 不携带自由生成的工作目标、负责人、工具集合或跨群对象。
 */
export type GroupRoutingOutputV2={schema:typeof groupRoutingOutputV2Schema;intent:GroupRoutingIntent;respond:string[];reactions:GroupRoutingReaction[];assignments:GroupRoutingAssignment[];workTarget:GroupRoutingWorkTarget|null}
/** 恰 8 键；v2 路由另带 intent／assignments／workTarget 三个可选键。落 teloa_group_routing_decisions.decision。 */
export type GroupRoutingDecision={kind:GroupRoutingDecisionKind;respond:string[];reactions:{roleId:string;emoji:GroupReactionEmoji}[];hops:number;candidateIds:string[];truncatedCandidates:boolean;stopMessageId:string|null;at:string;intent?:GroupRoutingIntent;assignments?:GroupRoutingAssignment[];workTarget?:GroupRoutingWorkTarget|null;withdrawn?:string[]}
/** 恰 4 键。groups/routing/list 的回包项，不下发 candidateIds / reactions / stopMessageId。 */
export type GroupRoutingDecisionView={messageId:string;kind:GroupRoutingDecisionKind;respond:string[];hops:number}
/** 恰 2 键。 */
export type GroupRoutingListInput={groupId:string;messageIds:string[]}

const decisionKinds:readonly GroupRoutingDecisionKind[]=['routed','degraded','parse-failed','no-candidate','relay-stopped','archived','direct','blocked']

const fail=():never=>{throw new WorkError('teloa/invalid-input','群内路由请求包含未知字段或格式不正确。')}
const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!record(value)||Object.keys(value).some(key=>!keys.includes(key)))fail()
 return value as Record<string,unknown>
}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))
const kind=(v:unknown):v is GroupRoutingDecisionKind=>(decisionKinds as readonly string[]).includes(v as string)
const roleIds=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=groupRoutingRespondMax&&v.every(uuid)&&new Set(v).size===v.length
const reactionPairs=(v:unknown):v is GroupRoutingDecision['reactions']=>{
 if(!Array.isArray(v)||v.length>groupRoutingRespondMax)return false
 if(!v.every(item=>record(item)&&Object.keys(item).length===2&&uuid(item.roleId)&&isGroupReactionEmoji(item.emoji)))return false
 return new Set(v.map(item=>item.roleId+'\0'+item.emoji)).size===v.length
}

/** 照 auto-dream-plans.ts:14-17：版本位固定 5、变体位固定 a。 */
const shape=(parts:readonly string[]):string=>{
 const d=createHash('sha256').update(parts.join('\0')).digest('hex')
 return `${d.slice(0,8)}-${d.slice(8,12)}-5${d.slice(13,16)}-a${d.slice(17,20)}-${d.slice(20,32)}`
}
export const groupRoutedTaskRequestId=(owner:string,groupId:string,messageId:string,roleId:string)=>shape(['teloa/group-routed-task/v1',owner,groupId,messageId,roleId])
export const groupRoutedReactionRequestId=(owner:string,messageId:string,roleId:string,emoji:string)=>shape(['teloa/group-routed-reaction/v1',owner,messageId,roleId,emoji])
/** round 是必需分量（H2）：本话题已有的 relay-stopped 决策条数 + 1。 */
export const groupRelayStopRequestId=(owner:string,groupId:string,rootId:string,round:number)=>shape(['teloa/group-relay-stop/v1',owner,groupId,rootId,String(round)])
/** H6：每群每天一条会话。day 是 'YYYY-MM-DD'。 */
export const groupRoutingSessionId=(owner:string,groupId:string,day:string)=>'group-routing-'+shape(['teloa/group-routing-session/v1',owner,groupId,day])
export const groupRoutingRequestId=(owner:string,groupId:string,messageId:string)=>shape(['teloa/group-routing-request/v1',owner,groupId,messageId])
/**
 * 原消息重试的尝试世代（规格 §5）：第一尝试沿原身份公式，重试使用带尝试版本的新身份——
 * 解析失败的 RPC 结果不会被重试永远重复读到，旧尝试迟到的回答也落不到新尝试上。
 */
export const groupRoutingAttemptRequestId=(owner:string,groupId:string,messageId:string,attempt:number)=>attempt===1?groupRoutingRequestId(owner,groupId,messageId):shape(['teloa/group-routing-request/v2',owner,groupId,messageId,String(attempt)])
/** 一条本人消息对同一任务的追加／停止回执身份（随尝试世代变化）；续办新 Run 的准备身份由回执身份派生。 */
export const groupWorkInputRequestId=(owner:string,messageId:string,taskId:string,attempt:number)=>shape(['teloa/group-work-input/v1',owner,messageId,taskId,String(attempt)])
/** 向活动 Run 即时追加的原生请求身份：由回执身份派生，重放与恢复只认这一个身份。 */
export const groupRunAppendRequestId=(owner:string,requestId:string)=>shape(['teloa/group-run-append/v1',owner,requestId])
export const groupWorkContinuationRunRequestId=(owner:string,requestId:string)=>shape(['teloa/group-work-continuation-run/v1',owner,requestId])
export const groupRoutedAttemptTaskRequestId=(owner:string,groupId:string,messageId:string,roleId:string,attempt:number)=>attempt===1?groupRoutedTaskRequestId(owner,groupId,messageId,roleId):shape(['teloa/group-routed-task/v2',owner,groupId,messageId,roleId,String(attempt)])

/** 只剥一层围栏。不做正则扫描、不做「尽力而为」修补——模型说的任何别的话都被整段丢弃。 */
function unfence(text:string):string{
 const body=text.trim()
 if(!body.startsWith('```'))return body
 const head=body.indexOf('\n')
 if(head<0||!body.endsWith('```'))return body
 return body.slice(head+1,body.length-3).trim()
}

/** 严格解析：剥一层围栏 → JSON.parse → 三键精确 → schema 逐字 → respond/reactions 全部落回 candidateIds 与 12 个 emoji。任一不符抛 teloa/invalid-input。 */
export function groupRoutingOutput(value:unknown,candidateIds:readonly string[]):GroupRoutingOutput{
 const allowed=new Set(candidateIds)
 let parsed:unknown
 try{parsed=JSON.parse(unfence(String(value)))}catch{throw fail()}
 if(!record(parsed)||Object.keys(parsed).length!==3)throw fail()
 if(parsed.schema!==groupRoutingOutputSchema)throw fail()
 const respond=parsed.respond
 if(!Array.isArray(respond)||respond.length>groupRoutingRespondMax)throw fail()
 if(!respond.every(id=>typeof id==='string'&&allowed.has(id)))throw fail()
 if(new Set(respond).size!==respond.length)throw fail()
 const reactions=parsed.reactions
 if(!Array.isArray(reactions)||reactions.length>groupRoutingRespondMax)throw fail()
 if(!reactions.every(item=>record(item)&&Object.keys(item).length===2&&typeof item.roleId==='string'&&allowed.has(item.roleId)&&isGroupReactionEmoji(item.emoji)))throw fail()
 if(new Set(reactions.map(item=>item.roleId+'\0'+item.emoji)).size!==reactions.length)throw fail()
 return {schema:groupRoutingOutputSchema,respond:respond as string[],reactions:reactions as GroupRoutingOutput['reactions']}
}

const intents:readonly GroupRoutingIntent[]=['none','reply','work','clarify','continue','stop']
const range=(v:unknown,length=Number.MAX_SAFE_INTEGER):v is GroupInstructionRange=>record(v)&&Object.keys(v).length===2&&Number.isSafeInteger(v.start)&&Number.isSafeInteger(v.end)&&(v.start as number)>=0&&(v.start as number)<(v.end as number)&&(v.end as number)<=length
const stage=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=1&&(v as number)<=groupRoutingStageMax
const validBusinessTarget=(value:unknown)=>{try{groupTaskBusinessTarget(value);return true}catch{return false}}
const assignmentList=(v:unknown):v is GroupRoutingAssignment[]=>Array.isArray(v)&&v.length<=groupRoutingRespondMax&&v.every(item=>record(item)&&Object.keys(item).length===2+Number(Object.hasOwn(item,'stage'))+Number(Object.hasOwn(item,'businessTarget'))&&uuid(item.roleId)&&range(item.instructionRange)&&(!Object.hasOwn(item,'stage')||stage(item.stage))&&(!Object.hasOwn(item,'businessTarget')||validBusinessTarget(item.businessTarget)))&&new Set(v.map(item=>(item as GroupRoutingAssignment).roleId)).size===v.length&&contiguousStages(v as GroupRoutingAssignment[])
/** 阶段必须从 1 开始且连续，不能只有后序阶段而没有当前阶段。 */
function contiguousStages(items:readonly GroupRoutingAssignment[]):boolean{const stages=[...new Set(items.map(item=>item.stage??1))].sort((a,b)=>a-b);return stages.every((value,index)=>value===index+1)}
const workTarget=(v:unknown):v is GroupRoutingWorkTarget|null=>v===null||record(v)&&Object.keys(v).length===2&&uuid(v.taskId)&&(v.runId===null||uuid(v.runId))
export function isGroupRoutingDecision(value:unknown):value is GroupRoutingDecision{
 if(!record(value))return false
 const extended=['intent','assignments','workTarget'].filter(key=>Object.hasOwn(value,key)).length,withdrawn=Object.hasOwn(value,'withdrawn')
 if(extended!==0&&extended!==3||Object.keys(value).length!==8+extended+Number(withdrawn))return false
 // 模型等待期间失去资格、被宿主在定案前撤下的接收者：只用于准确呈现失效对象，不再参与派发。
 if(withdrawn&&(!roleIds(value.withdrawn)||(value.withdrawn as string[]).length===0||(value.withdrawn as string[]).some(id=>(value.respond as unknown[]).includes(id))))return false
 if(extended&&(!intents.includes(value.intent as GroupRoutingIntent)||!assignmentList(value.assignments)||!workTarget(value.workTarget)||(value.assignments as GroupRoutingAssignment[]).some(item=>!(value.respond as unknown[]).includes(item.roleId))))return false
 if(!kind(value.kind)||!roleIds(value.respond)||!reactionPairs(value.reactions))return false
 if(!Number.isSafeInteger(value.hops)||(value.hops as number)<0)return false
 const candidates=value.candidateIds
 if(!Array.isArray(candidates)||candidates.length>groupRoutingCandidatesMax||!candidates.every(uuid)||new Set(candidates).size!==candidates.length)return false
 if(typeof value.truncatedCandidates!=='boolean')return false
 return (value.stopMessageId===null||uuid(value.stopMessageId))&&stamp(value.at)
}

export function isGroupRoutingDecisionView(value:unknown):value is GroupRoutingDecisionView{
 if(!record(value)||Object.keys(value).length!==4)return false
 if(!uuid(value.messageId)||!kind(value.kind)||!roleIds(value.respond))return false
 return Number.isSafeInteger(value.hops)&&(value.hops as number)>=0
}

export function groupRoutingListInput(value:unknown):GroupRoutingListInput{
 const row=exact(value,['groupId','messageIds'])
 if(!uuid(row.groupId))fail()
 const messageIds=row.messageIds
 if(!Array.isArray(messageIds)||messageIds.length<1||messageIds.length>groupRoutingMessageIdsMax||!messageIds.every(uuid)||new Set(messageIds).size!==messageIds.length)fail()
 return {groupId:row.groupId as string,messageIds:(messageIds as string[]).slice()}
}

/** 群消息处理状态闭集（规格 §6）。只由持久消息、路由尝试、outbox、Task/Run 与已发布回帖投影，不由员工是否发过言推断。 */
export const groupMessagePhases=['received','routing','queued','running','awaiting-approval','awaiting-review','delivering','publication-blocked','completed','recorded','routing-failed','unavailable','blocked','unknown','paused','stopping','stopped'] as const
export type GroupMessagePhase=typeof groupMessagePhases[number]
export const groupMessageHintCodes=['route-unavailable','route-invalid','target-unavailable','mention-all-denied','not-authorized','resource-required','model-configuration','group-changed','source-changed','delivery-unknown','work-paused','work-stopped','group-archived','result-pending','result-retained','result-unconfirmed','over-budget','work-failed'] as const
export type GroupMessageHintCode=typeof groupMessageHintCodes[number]
/** 恰 7 键。空身份一律 null，不伪造标识；executionMode 区分交流回应（reply：回帖即已回应）与明确工作（work：原任务完成判据才算完成）。 */
export type GroupRecipientStatus={roleId:string;name:string;taskId:string|null;runId:string|null;phase:GroupMessagePhase;resultMessageId:string|null;executionMode:'reply'|'work'|null}
/** 恰 6 键。groups/routing/status 的回包项。 */
export type GroupRoutingStatusView={messageId:string;attemptVersion:number;phase:GroupMessagePhase;recipients:GroupRecipientStatus[];hintCode:GroupMessageHintCode|null;canRetry:boolean}
/** 沿原 messageId 重试安排；不重新保存正文。`overrideRecipients` 是本人显式选择接收者，只写新尝试快照。 */
export type GroupRoutingRetryInput={requestId:string;groupId:string;messageId:string;expectedAttempt:number;expectedGroupVersion:number;overrideRecipients?:{roleId:string;expectedVersion:number}[]}

const phase=(v:unknown):v is GroupMessagePhase=>(groupMessagePhases as readonly string[]).includes(v as string)
const hint=(v:unknown):v is GroupMessageHintCode=>(groupMessageHintCodes as readonly string[]).includes(v as string)
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>0

export function isGroupRecipientStatus(value:unknown):value is GroupRecipientStatus{
 return record(value)&&Object.keys(value).length===7&&(value.executionMode===null||value.executionMode==='reply'||value.executionMode==='work')&&uuid(value.roleId)&&typeof value.name==='string'&&value.name.length<=200&&(value.taskId===null||uuid(value.taskId))&&(value.runId===null||uuid(value.runId))&&!(value.runId!==null&&value.taskId===null)&&phase(value.phase)&&(value.resultMessageId===null||uuid(value.resultMessageId))
}

export function isGroupRoutingStatusView(value:unknown):value is GroupRoutingStatusView{
 if(!record(value)||Object.keys(value).length!==6||!uuid(value.messageId)||!positive(value.attemptVersion)||!phase(value.phase)||!(value.hintCode===null||hint(value.hintCode))||typeof value.canRetry!=='boolean')return false
 const recipients=value.recipients
 return Array.isArray(recipients)&&recipients.length<=groupRoutingCandidatesMax&&recipients.every(isGroupRecipientStatus)&&new Set(recipients.map(item=>(item as GroupRecipientStatus).roleId)).size===recipients.length
}

/** 与 list 同形状：同一批消息身份，各自封顶 200 条。 */
export const groupRoutingStatusInput=groupRoutingListInput

export function groupRoutingRetryInput(value:unknown):GroupRoutingRetryInput{
 const row=exact(value,['requestId','groupId','messageId','expectedAttempt','expectedGroupVersion','overrideRecipients'])
 if(!uuid(row.requestId)||!uuid(row.groupId)||!uuid(row.messageId)||!positive(row.expectedAttempt)||!positive(row.expectedGroupVersion))fail()
 const result:GroupRoutingRetryInput={requestId:row.requestId as string,groupId:row.groupId as string,messageId:row.messageId as string,expectedAttempt:row.expectedAttempt as number,expectedGroupVersion:row.expectedGroupVersion as number}
 if(row.overrideRecipients!==undefined){
  const list=row.overrideRecipients
  if(!Array.isArray(list)||list.length<1||list.length>8||!list.every(item=>record(item)&&Object.keys(item).length===2&&uuid(item.roleId)&&positive(item.expectedVersion))||new Set(list.map(item=>(item as {roleId:string}).roleId)).size!==list.length)fail()
  result.overrideRecipients=(list as {roleId:string;expectedVersion:number}[]).map(item=>({roleId:item.roleId,expectedVersion:item.expectedVersion}))
 }
 return result
}

/** UTF-16 范围不能切开代理对：起点不落在低代理项上，终点前一位不落在高代理项上。 */
function wholeCharacters(text:string,item:GroupInstructionRange):boolean{
 const low=(index:number)=>/[\uDC00-\uDFFF]/.test(text[index]??''),high=(index:number)=>/[\uD800-\uDBFF]/.test(text[index]??'')
 return !low(item.start)&&!high(item.end-1)
}

/**
 * v2 严格解析（规格 §6.3）：剥一层围栏 → 六键精确 → schema 逐字 → 意图闭集 → respond/reactions 落回候选 →
 * work 的 assignments 是 respond 的无重复子集、每位恰一个原文范围且不切开代理对 → continue/stop 的 workTarget 精确匹配候选工作。
 * 其余意图不接受分工或工作目标。任一不符抛 teloa/invalid-input。
 */
export function groupRoutingOutputV2(value:unknown,candidateIds:readonly string[],workCandidates:readonly GroupRoutingWorkTarget[],sourceText:string,businessCandidates:readonly {roleId:string;scopes:readonly string[]}[]=[]):GroupRoutingOutputV2{
 const allowed=new Set(candidateIds)
 let parsed:unknown
 try{parsed=JSON.parse(unfence(String(value)))}catch{throw fail()}
 if(!record(parsed)||Object.keys(parsed).length!==6||parsed.schema!==groupRoutingOutputV2Schema||!intents.includes(parsed.intent as GroupRoutingIntent))throw fail()
 const intent=parsed.intent as GroupRoutingIntent
 const base=groupRoutingOutput(JSON.stringify({schema:groupRoutingOutputSchema,respond:parsed.respond,reactions:parsed.reactions}),candidateIds)
 const assignments=parsed.assignments
 if(!assignmentList(assignments))throw fail()
 if(intent!=='work'&&assignments.length||assignments.some(item=>!allowed.has(item.roleId)||!base.respond.includes(item.roleId)||!range(item.instructionRange,sourceText.length)||!wholeCharacters(sourceText,item.instructionRange)))throw fail()
 if(intent==='work'&&!assignments.length)throw fail()
 for(const assignment of assignments)if(assignment.businessTarget){
  const target=groupTaskBusinessTarget(assignment.businessTarget)
  if(!businessCandidates.some(candidate=>candidate.roleId===assignment.roleId&&candidate.scopes.includes(target.scope)))throw fail()
  if(target.object&&!parseBusinessRecordReferences(sourceText).some(object=>JSON.stringify(object)===JSON.stringify(target.object)))throw fail()
 }
 const target=parsed.workTarget
 if(!workTarget(target))throw fail()
 if(intent==='continue'||intent==='stop'){
  if(!target||!workCandidates.some(item=>item.taskId===target.taskId&&item.runId===target.runId))throw fail()
 }else if(target!==null)throw fail()
 return {schema:groupRoutingOutputV2Schema,intent,respond:base.respond,reactions:base.reactions,assignments:assignments.map(item=>({roleId:item.roleId,instructionRange:{start:item.instructionRange.start,end:item.instructionRange.end},...((item.stage??1)>1?{stage:item.stage!}:{}),...(item.businessTarget?{businessTarget:groupTaskBusinessTarget(item.businessTarget)}:{})})),workTarget:target?{taskId:target.taskId,runId:target.runId}:null}
}
