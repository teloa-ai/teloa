import type {SecurityAction,SecurityActionPanel} from '@teloa/contract'
import type {AttentionItem,AttentionKind,AttentionTarget} from './attention-item.js'
import type {SecurityActionApi,SecurityActionAttention,SecurityActionCommand,SecurityActionContext} from './security-action-api.js'
import {securityActionControls} from './security-action-presentation.ts'
import type {MessageKey} from './i18n/messages.js'

export const ATTENTION_EXPANDED_KEY='teloa.attention-expanded/v1'
export type AttentionDecisionRowKey='source'|'basis'|'next'|'risk'
export type AttentionDecisionActionMode='security-action'|'handoff'|'open'

/** 同一时间只展开一条：点别的换过去，点自己收起。 */
export function toggleExpandedAttention(current:string|null,id:string):string|null{return current===id?null:id}

/** 事项消失时展开态一并作废，避免刷新后恢复到一条已经不在列表里的卡片。 */
export function readExpandedAttention(storage:Pick<Storage,'getItem'>,items:readonly AttentionItem[]):string|null{
 let id:string|null=null
 try{id=storage.getItem(ATTENTION_EXPANDED_KEY)}catch{return null}
 return id!==null&&items.some(item=>item.id===id)?id:null
}

export function writeExpandedAttention(storage:Pick<Storage,'setItem'|'removeItem'>,id:string|null):void{
 // 存储不可用时展开仍然生效，只是刷新后不恢复。
 try{if(id===null)storage.removeItem(ATTENTION_EXPANDED_KEY);else storage.setItem(ATTENTION_EXPANDED_KEY,id)}catch{/* 记忆丢失可接受 */}
}

const nextStepKeys:Record<AttentionKind,MessageKey>={
 approval:'attention.next.approval',materials:'attention.next.materials',connection:'attention.next.connection',error:'attention.next.error',
 review:'attention.next.review',handoff:'attention.next.handoff',dispatch:'attention.next.dispatch',execution:'attention.next.execution',
}
// 过期与三种"执行中尚未核对"的安全事项都落 kind:'review'（attention-item.ts 的映射表没有单独给它们分类），
// 但通用的 review 文案（核对交付内容与依据……）与卡内另外呈现的过期/核对段落直接矛盾。
// 这里按具体 security reason 覆写，让"下一步"只说一件真事，不再有两处并列却互相矛盾的文案。
const SECURITY_REASON_PREFIX='security.attention.'
// 键改按 SecurityActionAttention['reason'] 约束：写错一个字母编译就红，不会像裸 string 那样
// 静默落回通用 review 文案（N-3，复发同一缺陷 I-1）。
const securityNextStepOverrides:Partial<Record<SecurityActionAttention['reason'],MessageKey>>={
 'approval-expired':'security.expired.nextStep',
 'execution-dispatching':'attention.next.observePending',
 'external-accepted':'attention.next.observePending',
 'effect-unknown':'attention.next.observePending',
}
export function attentionNextStepKey(item:Pick<AttentionItem,'kind'|'reason'>):MessageKey{
 if(item.reason.kind==='message'&&item.reason.key.startsWith(SECURITY_REASON_PREFIX)){
  const override=securityNextStepOverrides[item.reason.key.slice(SECURITY_REASON_PREFIX.length) as SecurityActionAttention['reason']]
  if(override!==undefined)return override
 }
 return nextStepKeys[item.kind]
}

export function attentionDecisionActionMode(target:AttentionTarget):AttentionDecisionActionMode{
 if(target.kind==='security-action')return 'security-action'
 if(target.kind==='task')return 'handoff'
 return 'open'
}

export type SecurityDecisionStage=
 |{stage:'decide';needsReason:true;needsImpact:true;combined:boolean}
 |{stage:'expired';canWithdraw:boolean}
 |{stage:'approved';canWithdraw:boolean}
 |{stage:'execute';irreversible:boolean;confirmTarget:string|null;canWithdraw:boolean}
 |{stage:'observe';operationId:string;expectedRevision:number}
 |{stage:'acknowledge'}
 |{stage:'wait'}

/**
 * 卡内审批分两段，理由在契约里：decide 之后动作版本加一、attention 才会回 execution-required，
 * 所以“批准并执行”必须是 decide → 重载 → execute 三拍。低中风险且可逆的动作把这三拍
 * 包在一个按钮里；高风险或不可逆的保持两次显式点击。
 * 不可逆动作一律要逐字抄目标名才能执行，多目标也不例外——目标越多，误点的代价越大，
 * 让人把整份清单按顺序抄一遍正是要逼他把清单看完。
 */
export function securityDecisionStage(action:SecurityAction,panel:SecurityActionPanel,attention:readonly SecurityActionAttention[],known:boolean):SecurityDecisionStage{
 const controls=securityActionControls(action,panel,attention,known)
 if(controls.decide){
  const combined=action.riskTier!=='high'&&action.reversible!=='irreversible'
  return {stage:'decide',needsReason:true,needsImpact:true,combined}
 }
 // 过期排在执行之前判：批准一旦过期，服务端已经不会再接受派发，卡内不能还摆一个能点的执行按钮。
 if(controls.expired)return {stage:'expired',canWithdraw:controls.withdrawApproval}
 if(controls.execute){
  const irreversible=action.reversible==='irreversible'
  return {stage:'execute',irreversible,confirmTarget:irreversible?action.targetSet.join(', '):null,canWithdraw:controls.withdrawApproval}
 }
 // 执行器不可用等情况没有 execution-required，但已批准的事实和撤回入口不能消失。
 // 只消费已核对目录；这条分支不提供执行能力，仍由上面的执行门独立判定。
 if(known&&controls.withdrawApproval)return {stage:'approved',canWithdraw:true}
 if(controls.observe){
  // observe 的操作身份与版本必须从面板里取：客户端不能自己编一个 revision，
  // 服务端的 observeWithJournal 会按 expectedRevision 核对，编错就是一次白白的 conflict。
  const execution=panel.executions.find(row=>row.actionId===action.id)!
  return {stage:'observe',operationId:execution.operationId,expectedRevision:execution.revision}
 }
 if(controls.acknowledge)return {stage:'acknowledge'}
 return {stage:'wait'}
}

export type SecurityExecutionChecks={executorReady:boolean;targetsAllowed:boolean;targets:readonly string[]}

/**
 * 规格要求执行前把三件事摆在眼前：目标集清单、执行器是否就绪、目标是否在授权范围内。
 * 两个判据都只读面板自己的提议能力表——这是客户端手上唯一能核对"这台执行器现在认不认
 * 这个工具、这批目标"的事实，比让人凭印象点"执行"强。
 */
export function securityExecutionChecks(action:SecurityAction,panel:SecurityActionPanel):SecurityExecutionChecks{
 const tool=panel.proposal.tools.find(row=>row.tool===action.tool)
 return {
  executorReady:tool!==undefined,
  targetsAllowed:tool!==undefined&&action.targetSet.every(target=>tool.allowedTargets.includes(target)),
  targets:action.targetSet,
 }
}

/**
 * 逐字比对目标名：只放过逗号后的空格与首尾空白，顺序、数量、大小写一个都不放过。
 * 宽到“随便哪个目标名都算数”就等于没有这道关。
 */
export function confirmTargetMatches(input:string,confirmTarget:string):boolean{
 const parts=(value:string)=>value.trim().split(',').map(part=>part.trim())
 const expected=parts(confirmTarget),actual=parts(input)
 return expected.length===actual.length&&expected.every((value,index)=>value===actual[index])
}

/**
 * 三拍的终态与错误。必须由外壳按 (任务, 动作) 持有：批准之后事项的 kind 从 approval 变成
 * execution，用户此刻若正筛着「审批」，卡片当场被筛走、组件卸载——把结论留在组件 state 里，
 * 重新展开时它就一句话都不剩。
 */
export type SecurityDecisionOutcome={awaitingExecute:boolean;error?:string}

export type SecurityJournalLocks<K extends SecurityActionCommand>={
 pendingKinds:readonly K[];brokenKinds:readonly K[]
 /** 本任务有未决的写：整块锁住。 */
 held:boolean
 /** 同名命令已被占用或损坏：这一条一定发不出去。 */
 disabledCommands:readonly K[]
 /** 与具体命令无关的整块封锁（忙 / held / 面板副本已知过期）。 */
 blocked:boolean
 locked:(kind:K)=>boolean
}

/**
 * journal 锁语义的唯一出处：需要你决策卡与任务详情面板同用一份，免得两个入口一边能点一边不能点。
 * - `held`：同一任务的因果链不能被并发的第二次写打断，所以本任务有未决的写就整块锁住；
 * - `disabledCommands`：`write()` 对同名命令的任何未决或损坏条目都直接 conflict，所以按命令逐条锁；
 *   别的任务占着同名 journal 时本卡其它命令照常可用。
 * - `verified`：面板副本已知过期（拉取失败、来源摘要不一致、最近一次重载失败）时一律不许写——
 *   不能让人对着可能已经不成立的阶段下手。
 */
export function securityJournalLocks<K extends SecurityActionCommand>(
 api:Pick<SecurityActionApi,'pending'|'recoveryError'>,
 commands:readonly K[],
 taskId:string,
 gate:{busy:boolean;verified:boolean},
):SecurityJournalLocks<K>{
 const pendingKinds=commands.filter(kind=>api.pending(kind)!==undefined)
 const brokenKinds=commands.filter(kind=>api.recoveryError(kind)!==undefined)
 const held=pendingKinds.some(kind=>api.pending(kind)!.context.panel.taskId===taskId)
 const disabledCommands=commands.filter(kind=>pendingKinds.includes(kind)||brokenKinds.includes(kind))
 const blocked=gate.busy||held||!gate.verified
 return {pendingKinds,brokenKinds,held,disabledCommands,blocked,locked:kind=>blocked||disabledCommands.includes(kind)}
}

export type SecurityDecisionSnapshot={
 action:SecurityAction;panel:SecurityActionPanel;context:SecurityActionContext
 attention:readonly SecurityActionAttention[];known:boolean
}

/**
 * “批准并执行”的三拍全部串在这一个 Promise 里，不靠组件重渲染推进：批准之后事项的 kind
 * 会从 approval 变成 execution，用户此刻若正筛着“审批”，卡片当场就被筛走、组件卸载——
 * 靠 useEffect 接力的写法会让第三拍永远发不出去，而且不留一句话。
 * 重载后动作不再停在“待执行”（attention 还没回、别处已经执行、执行前检查没过）就停在
 * 'approved' 交回调用方提示，绝不拿旧版本硬试。
 */
export async function approveAndExecute(
 snapshot:SecurityDecisionSnapshot,
 api:Pick<SecurityActionApi,'decide'|'execute'>,
 reason:string,
 reload:()=>Promise<SecurityDecisionSnapshot|null>,
 requestId:()=>string,
):Promise<'approved'|'executed'>{
 const {action,context}=snapshot
 await api.decide({requestId:requestId(),actionId:action.id,expectedActionVersion:action.version,decision:'approved',reason,impactConfirmed:true},context)
 // 重载失败不能把已经落地的批准说成失败，退回 'approved' 让卡片提示“已批准 · 待执行”。
 const next=await reload().catch(()=>null)
 if(next===null)return 'approved'
 const stage=securityDecisionStage(next.action,next.panel,next.attention,next.known)
 const checks=securityExecutionChecks(next.action,next.panel)
 if(stage.stage!=='execute'||!checks.executorReady||!checks.targetsAllowed)return 'approved'
 await api.execute({requestId:requestId(),actionId:next.action.id,expectedActionVersion:next.action.version},next.context)
 // 执行成功后还要再重载一次：否则卡片停在"已批准 · 待执行"、"执行"仍可点，
 // 再点一次就拿着已经用过的版本去撞 version-conflict。
 await reload().catch(()=>{})
 return 'executed'
}
