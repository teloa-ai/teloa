import {usablePersonalName} from '@teloa/contract'
import type {Context} from '@deepseek-ai/cordis'
import {WorkError,groupDefinition,roleSupportsScope,groupRelayStopRequestId,groupRoutedReactionRequestId,groupRoutedAttemptTaskRequestId,groupWorkInputRequestId,resolveGroupDirectRecipients,groupRoutingCandidatesMax,groupRoutingHopLimit,groupRoutingRespondMax,roleDefinition,type GroupReactionEmoji,type GroupRoutingDecision,type GroupTaskCreateInput} from '@teloa/contract'
import {workAccess,groupRoutedExecution,readGroupConversationTopic,authorizeRoleTaskAssignment,readStoredRole,groupRelayStopText,groupRoutedTaskGoal,groupRunConfigFailedText,readRunGroupTopic,type GroupRoutingAttemptService,type GroupRoutingDecisionService,type GroupWorkInputService,type RunGroupContext,type RunGroupTopicMessage} from '@teloa/backend'
import {askGroupRouting,type GroupRoutingAsk,type GroupRoutingCandidate,type GroupRoutingWorkCandidate} from './group-routing.ts'
import {drainGroupRoutingOutbox,type GroupRoutingOutboxPorts} from './group-routing-outbox-driver.ts'
import {readTrustedGroupMessageRunSource,groupQuotedTaskSql,type GroupRoutingOutboxService} from '@teloa/backend'

/** 最小可查询接口：只要有 `query(text,values)` 就够，不为此专门依赖 `pg`（先例 `business-definitions.ts:60`）。 */
type Queryable={query(text:string,values:readonly unknown[]):Promise<{rows:Record<string,unknown>[]}>}
/** 话题锁回调里那个真实连接的类型：从决策服务的签名上取，同样不引 `pg`。 */
type PoolClient=Parameters<Parameters<GroupRoutingDecisionService['withTopicLock']>[3]>[0]

/**
 * 触发消息的只读投影。`mentions` 只对本人消息有值：员工消息（`GroupEmployeeMessage` 9 键）没有这个键。
 * `mentionAll` 与 `replyAuthorRoleId` 是宿主读出的消息关系：引用对象的作者由宿主按同群同本人读取，客户端不能自报。
 */
export type GroupRoutingMessage={groupId:string;rootId:string;authorKind:'self'|'role';authorId:string;authorName:string;text:string;createdAt:string;mentions:string[];mentionAll?:boolean;replyAuthorRoleId?:string|null}

export type GroupRoutingDispatchPorts={
 /** 新宿主必须装配。历史调用可保留旧投递方式，已有决策不会凭当前岗位版本补造待办。 */
 delivery?:GroupRoutingOutboxPorts&{outbox:GroupRoutingOutboxPorts['outbox']&Pick<GroupRoutingOutboxService,'recordRecipients'>}
 /**
  * 话题锁与决策表的唯一真源。段 A 与段 C 各用 `withTopicLock` 包一次；
  * 模型调用（段 B）与建任务（段 D）都在锁外（H7/H8）。
  */
 decisions:Pick<GroupRoutingDecisionService,'identity'|'withTopicLock'|'claimed'|'isStopMessage'|'relayGateOpen'|'relayStopMessageId'|'relayStopRounds'|'hops'|'record'>
 /** 原消息重试的尝试世代。未装配时只有第一尝试，与旧宿主行为一致。 */
 attempts?:Pick<GroupRoutingAttemptService,'pending'|'settle'>
 /** 本群候选工作（continue/stop 的唯一目标来源）与追加回执；未装配时没有追加与停止。 */
 workCandidates?:(owner:string,groupId:string,messageId:string,db:PoolClient)=>Promise<RoutingWorkCandidate[]>
 workInputs?:Pick<GroupWorkInputService,'reserveInTransaction'>
 drainWorkInputs?:(owner:string,signal:AbortSignal)=>Promise<void>
 /** C2：群的版本与归档位；`mentionAllAllowed` 缺省按群规则缺省（允许）。 */
 group:(owner:string,groupId:string,db:PoolClient)=>Promise<{version:number;archived:boolean;name:string;mentionAllAllowed?:boolean;coordinatorRoleId?:string}|undefined>
 /**
  * C2：触发消息本身。**不收 db**：话题锁的键要用这条消息的 `groupId`/`rootId`，必须在取锁之前读出来；
  * 群消息行写下之后不再被任何生产路径 update/delete，锁外读是安全的。
  */
 message:(owner:string,messageId:string)=>Promise<GroupRoutingMessage|undefined>
 /** 宿主核实员工固定交付已完成必需复核；false只阻断接力，未知错误保留待核对。 */
 sourceReviewed?:(owner:string,messageId:string,signal:AbortSignal)=>Promise<boolean>
 /** C2：候选。SQL 必须带 `role_id is not null`（M15）。带出 `roleVersion` 供建任务做 `expectedVersion`。 */
 candidates:(owner:string,groupId:string,db:PoolClient)=>Promise<GroupRoutingCandidate[]>
 /** 传入触发消息时读连续上下文（主群近期＋当前话题、触发水位与引用锚点）；旧调用只读本话题。 */
 topic:(owner:string,groupId:string,rootId:string,db:PoolClient,messageId?:string)=>Promise<RunGroupTopicMessage[]>
 /** 段 D，锁外。 */
 createTask:(owner:string,input:GroupTaskCreateInput,signal:AbortSignal)=>Promise<{taskId:string}>
 prepare:(owner:string,input:{requestId:string;taskId:string;expectedTaskVersion:number},signal:AbortSignal)=>Promise<{runId:string}>
 /** 回执带上运行状态：配置不可用时这一位永远不会回帖，编排必须记一行而不是当成已经发出去了。 */
 start:(owner:string,runId:string,signal:AbortSignal)=>Promise<{state:string}>
 /** 段 A 的 `relay-stopped` 分支，锁内。 */
 sendSystem:(owner:string,input:{requestId:string;groupId:string;expectedVersion:number;text:string;rootId:string},signal:AbortSignal)=>Promise<{id:string}>
 /** 段 C，锁内。`run_id` 恒为空：路由直接落表，不绑任何一次运行。 */
 applyReaction:(db:PoolClient,owner:string,params:{groupId:string;messageId:string;roleId:string;emoji:GroupReactionEmoji;requestId:string})=>Promise<void>
}

/**
 * 路由建出来的群任务恒是刚建的那一版：`groups/tasks/create` 落的任务版本固定为 1（`group-tasks.ts` 的
 * insert 不带版本入参），一键 prepare 的 `expectedTaskVersion` 因此也只能是 1。写成常量是为了让它有名字，
 * 不是为了可配——改这个值只会让 prepare 判 `teloa/version-conflict`。
 */
const routedTaskCreatedVersion=1
/**
 * 「收到」那一枚。被选中的员工从建任务到回帖之间隔着一整次运行，这段时间群里本来零反馈；
 * 这枚表情在段 C 随决策同事务落库，于是本人在运行还没跑起来时就能看到有人接了。
 */
const routedAckEmoji:GroupReactionEmoji='👀'
/** 建任务与建运行撞上的这两码一律吞掉不重试：语义是「这条消息已经有人处理了」（规格 §3.2）。 */
const settledCodes=['teloa/conflict','teloa/version-conflict']
const settled=(error:unknown):boolean=>error instanceof WorkError&&settledCodes.includes(error.code)

/** `assigneeRoleId` 只供宿主做续办互斥（原任务负责人即续办接收者），不进模型输入。 */
type RoutingWorkCandidate=GroupRoutingWorkCandidate&{version:number;assigneeRoleId?:string|null}
type Carried={work:RoutingWorkCandidate[];version:number;name:string;coordinatorRoleId?:string;hops:number;candidates:GroupRoutingCandidate[];truncatedCandidates:boolean;topic:RunGroupTopicMessage[];mentionAllAllowed:boolean;attempt:number;override:string[]|null}

/**
 * 决策行恒是终态、恒一次写成：这里只是把八个键补齐，没有任何「先插占位再回写」的路径。
 * `now` 从决策服务的 `identity` 上取——`decision.at` 与那一行的 `created_at` 必须出自同一把时钟，
 * 这个助手函数自己去摸全局时钟会让两者在测试与回放里对不上。
 */
function decisionOf(now:()=>string,kind:GroupRoutingDecision['kind'],hops:number,fields:Partial<GroupRoutingDecision>):GroupRoutingDecision{
 return {kind,respond:[],reactions:[],hops,candidateIds:[],truncatedCandidates:false,stopMessageId:null,at:now(),...fields}
}

/**
 * 路由选人只看意图与分工，不需要上游正文的完整依据；为控制每次选人调用的成本，
 * 路由可见面沿用后端 `groupRoutingTopicTextMaxChars`（1000）的较小预算。
 * 执行员工的连续上下文由后端 `readRunGroupTopic` 用 4000 预算（GRP-03），两处预算不同是有意的。
 */
const routingTopicTextMaxChars=1000
/** 候选超过 30 位时按岗位名字典序截前 30（同名再按 roleId 定序），并在决策里记 `truncatedCandidates`。 */
function limitCandidates(all:readonly GroupRoutingCandidate[]):{candidates:GroupRoutingCandidate[];truncatedCandidates:boolean}{
 if(all.length<=groupRoutingCandidatesMax)return {candidates:[...all],truncatedCandidates:false}
 const ordered=[...all].sort((left,right)=>left.name===right.name?(left.roleId<right.roleId?-1:1):left.name<right.name?-1:1)
 return {candidates:ordered.slice(0,groupRoutingCandidatesMax),truncatedCandidates:true}
}

/** 退化口径（规格 §2.10）：只认落在候选集里的 @，保序去重、截前 8；没有 @ 就一个字都不回。 */
function degradedRespond(mentions:readonly string[],candidateIds:readonly string[]):string[]{
 const allowed=new Set(candidateIds),picked:string[]=[]
 for(const roleId of mentions)if(allowed.has(roleId)&&!picked.includes(roleId))picked.push(roleId)
 return picked.slice(0,groupRoutingRespondMax)
}

/**
 * 一条新群消息落库后的全部编排（规格 §2.7 的四段）。
 *
 * - **段 A（锁内）**：五种不触发、跳数、候选、群版本；命中终态分支就在这一段里一次性写完决策。
 * - **段 B（锁外）**：一次模型调用。秒级，绝不压着话题锁。
 * - **段 C（锁内）**：再核一次决策行，一次性写终态决策，随后按 `reactions` 落表。
 * - **段 D（锁外）**：逐位「建任务 → prepare → start」；版本漂移的两码吞掉不重试。
 *
 * 调用点一律 fire-and-forget：路由失败绝不影响发消息或员工回帖本身。
 */
export async function dispatchGroupRouting(ctx:Context,owner:string,messageId:string,ports:GroupRoutingDispatchPorts,signal:AbortSignal):Promise<void>{
 const now=()=>ports.decisions.identity.now()
 const trigger=await ports.message(owner,messageId)
 if(!trigger)return
 const sourceReviewed=trigger.authorKind!=='role'||!ports.sourceReviewed||await ports.sourceReviewed(owner,messageId,signal)
 const {groupId,rootId}=trigger
 // 终态只写一次：第一尝试写原决策行，显式重试写对应尝试行；同一函数供段 A 的终态分支与段 C 共用。
 const record=(db:PoolClient,attempt:number,decision:GroupRoutingDecision)=>attempt===1?ports.decisions.record(db,owner,{groupId,messageId,decision}):ports.attempts?ports.attempts.settle(db,owner,{messageId,attemptVersion:attempt,decision}):Promise.resolve(undefined)
 // 本消息此刻待定案的尝试：没有原决策即第一尝试；已有原决策时只认仍待定案的显式重试，旧尝试迟到不会重开。
 const open=async(db:PoolClient):Promise<{attempt:number;override:string[]|null}|undefined>=>{
  if(!await ports.decisions.claimed(db,owner,messageId))return {attempt:1,override:null}
  const pending=await ports.attempts?.pending(db,owner,messageId)
  return pending?{attempt:pending.attemptVersion,override:pending.overrideRecipients?.map(item=>item.roleId)??null}:undefined
 }
 // 段 A：锁内只跑 SQL 与（触顶时）一条系统消息，读完就提交释放锁。
 const carried=await ports.decisions.withTopicLock(owner,groupId,rootId,async(db):Promise<Carried|undefined>=>{
  const opened=await open(db)
  if(!opened)return undefined
  const {attempt}=opened
  if(!sourceReviewed){await record(db,attempt,decisionOf(now,'blocked',await ports.decisions.hops(db,owner,groupId,rootId,messageId),{}));return undefined}
  if(await ports.decisions.isStopMessage(db,owner,groupId,messageId))return undefined
  const group=await ports.group(owner,groupId,db)
  if(!group)return undefined
  if(group.archived){
   await record(db,attempt,decisionOf(now,'archived',await ports.decisions.hops(db,owner,groupId,rootId,messageId),{}))
   return undefined
  }
  // H2：停下之后在本人真正插话之前一律不放行——第一尝试不写决策、不调模型。
  // 显式重试已登记待定案尝试，静默跳过会让它永远停在「正在安排」：闸门只按触发位置之前的插话开启，
  // 原消息此后不可能再被放行，因此定案为不可重试的 relay-stopped，并引用本话题原停下消息（不另发停下消息）。
  if(!await ports.decisions.relayGateOpen(db,owner,groupId,rootId,messageId)){
   if(attempt>1)await record(db,attempt,decisionOf(now,'relay-stopped',await ports.decisions.hops(db,owner,groupId,rootId,messageId),{stopMessageId:await ports.decisions.relayStopMessageId(db,owner,groupId,rootId)}))
   return undefined
  }
  const hops=await ports.decisions.hops(db,owner,groupId,rootId,messageId)
  if(hops>groupRoutingHopLimit){
   // 轮次必须在写本轮决策之前读：写完再读会把本轮也数进去，同一话题第二次触顶就提示不出来。
   const round=await ports.decisions.relayStopRounds(db,owner,groupId,rootId)+1
   // 全文件唯一一处「锁内再取一条连接」：停下消息要与这条决策同生共死，所以只能在锁内发。
   // 它自己是一次独立事务（`collaboration.send` 的 `['teloa/group-send',owner,requestId]` 是另一把键，不会自锁），
   // 代价是段 A 短暂占两条连接——规格 §2.7「连接池影响」那一段说的就是这一处。
   const stop=await ports.sendSystem(owner,{requestId:groupRelayStopRequestId(owner,groupId,rootId,round),groupId,expectedVersion:group.version,text:groupRelayStopText,rootId},signal)
   await record(db,attempt,decisionOf(now,'relay-stopped',hops,{stopMessageId:stop.id}))
   return undefined
  }
  // 发言员工不能回应自己；先排除作者，再按原候选上限截取，不让作者占用其他员工的位置。
  const all=await ports.candidates(owner,groupId,db)
  const {candidates,truncatedCandidates}=limitCandidates(trigger.authorKind==='role'?all.filter(candidate=>candidate.roleId!==trigger.authorId):all)
  // 本人对原工作的追加／停止不依赖员工仍可接新回应：候选为空但本群有原工作时仍判断控制意图（规格 §4.4）。
  const work=trigger.authorKind==='self'&&ports.workCandidates?await ports.workCandidates(owner,groupId,messageId,db):[]
  if(!candidates.length&&!work.length){
   await record(db,attempt,decisionOf(now,'no-candidate',hops,{}))
   return undefined
  }
  const coordinatorRoleId=group.coordinatorRoleId&&candidates.some(candidate=>candidate.roleId===group.coordinatorRoleId)?group.coordinatorRoleId:undefined
  return {version:group.version,name:group.name,...(coordinatorRoleId?{coordinatorRoleId}:{}),hops,candidates,truncatedCandidates,topic:await ports.topic(owner,groupId,rootId,db,messageId),work,mentionAllAllowed:group.mentionAllAllowed!==false,attempt,override:opened.override}
 })
 if(!carried){if(ports.delivery)await drainGroupRoutingOutbox(owner,ports.delivery,signal,{messageId});return}
 const admission=await workAccess.authorize({kind:'capability',capability:'groups',ownerId:owner,sessionId:null,objectId:groupId,operation:'run'})
 admission.assertCurrent();signal.throwIfAborted()
 const candidateIds=carried.candidates.map(candidate=>candidate.roleId)
 const shared={candidateIds,truncatedCandidates:carried.truncatedCandidates}
 // 结构化目标（规格 §3.2）：本人全员请求 → 结构化 @ → 引用回复的员工，宿主直接选定，不增加一次选人模型调用；
 // 显式重试的「选择接收者」只作用于本次尝试。被点名者不可回应时记 blocked，不悄悄换成别的员工。
 const direct=trigger.authorKind==='self'
  ?resolveGroupDirectRecipients({mentionIds:carried.override??trigger.mentions,replyAuthorRoleId:carried.override?null:trigger.replyAuthorRoleId??null,candidateIds,mentionAll:!carried.override&&trigger.mentionAll===true,mentionAllAllowed:carried.mentionAllAllowed})
  :{mode:'semantic' as const,recipientIds:[],unavailableIds:[]}
 let decision:GroupRoutingDecision
 // 点名对象全部不可回应、且本群没有可控制的原工作时直接 blocked；有原工作时仍要判断是否是对原工作的停止/追加。
 if(direct.mode==='blocked'&&!carried.work.length)decision=decisionOf(now,'blocked',carried.hops,{...shared})
 else{
  // 段 B：锁已释放。结构化目标时接收者已由宿主固定，模型只在这几位里判断意图与原文分工，不选人；
  // 语义选人时在全部候选里判断。三态直接映成 decision.kind，不在这里重新判别通道故障与解析失败。
  const fixed=direct.mode==='direct'?direct.recipientIds.slice(0,groupRoutingRespondMax):direct.mode==='blocked'?[]:null
  // 明确引用的是宿主持久关联，不只是排序提示；避免同题旧误建任务凭标题抢走原任务续办。
  // 同一候选集合同时用于模型输入与结果读取器，选择非引用工作会被拒绝，不由宿主猜测改写模型结论。
  const quotedWork=carried.work.filter(item=>item.quoted),controlWork=quotedWork.length?quotedWork:carried.work
  const ask:GroupRoutingAsk={groupId,groupName:carried.name,...(carried.coordinatorRoleId?{coordinatorRoleId:carried.coordinatorRoleId}:{}),messageId,rootId,trigger:{...trigger,mentions:[...trigger.mentions]},topic:carried.topic,candidates:fixed?carried.candidates.filter(candidate=>fixed.includes(candidate.roleId)):carried.candidates,hops:carried.hops,attempt:carried.attempt,work:controlWork.map(({taskId,runId,title,state,quoted})=>({taskId,runId,title,state,...(quoted?{quoted:true}:{})}))}
  const answered=await askGroupRouting(ctx,owner,ask,signal)
  admission.assertCurrent();signal.throwIfAborted()
  const control=(intent:string)=>intent==='continue'||intent==='stop'
  if(answered.kind==='ok'){
   // 本人引用了宿主核实的唯一原工作，模型却把同一负责人判成新 work（实跑：质检退回要求修订被判成新工作）：
   // 引用是本人对对象的明确选择，按原工作续办，不另建同题任务；接手者不同或多人分工时沿用模型结论。
   const quoted=quotedWork.length===1?quotedWork[0]!:undefined
   const sameOwnerWork=!!quoted?.assigneeRoleId&&answered.output.intent==='work'&&answered.output.assignments.length>0&&answered.output.assignments.every(item=>item.roleId===quoted.assigneeRoleId)
   const output=sameOwnerWork?{...answered.output,intent:'continue' as const,assignments:[],workTarget:{taskId:quoted!.taskId,runId:quoted!.runId}}:answered.output
   // 需要回应时使用宿主确认的全部接收者；记录型（none）与对原工作的控制不强制开回复任务。
   const chosen=output.respond.filter(roleId=>candidateIds.includes(roleId)&&(!fixed||fixed.includes(roleId))).slice(0,groupRoutingRespondMax)
   // 对原工作的追加／停止已有接收者（原任务负责人）：同一员工不再另开交流回应任务，续办成功与否都只走原任务回执；
   // 其余员工的回应、普通交流与真正的交接不受影响。目标不在本群候选工作里时沿用原判断。
   const owned=control(output.intent)&&output.workTarget?carried.work.find(item=>item.taskId===output.workTarget!.taskId&&item.runId===output.workTarget!.runId)?.assigneeRoleId??null:null
   const respond=(fixed&&output.intent!=='none'&&!control(output.intent)?fixed:chosen).filter(roleId=>roleId!==owned)
   const kind=direct.mode==='blocked'&&!control(output.intent)?'blocked':fixed&&direct.mode==='direct'?'direct':!carried.candidates.length&&!control(output.intent)?'no-candidate':'routed'
   decision=kind==='blocked'||kind==='no-candidate'?decisionOf(now,kind,carried.hops,{...shared}):decisionOf(now,kind,carried.hops,{...shared,respond,reactions:output.reactions.filter(reaction=>respond.includes(reaction.roleId)||candidateIds.includes(reaction.roleId)).map(reaction=>({...reaction})),intent:output.intent,assignments:output.assignments.filter(item=>respond.includes(item.roleId)),workTarget:output.workTarget})
  }else{
   // 模型有回但结构非法（实跑两例：work 却带同一引用 workTarget；work 却 assignments 为空）：意图读不出来，就不能按固定接收者
   // 或 @ 退化成交流回应——那会把续办或交接默默降级成一条交流任务，且 respond 非空的决策不可重试。一律记 parse-failed、respond 为空，
   // 本人看到失败后沿原消息重试；宿主不把非法结构猜成工作或续办。
   // 通道故障（degraded）时：本人实际引用了原工作成果（宿主按持久消息关联核实）同样只记失败；没有引用原工作才沿用原退化口径。
   const quotedWork=carried.work.some(item=>item.quoted)
   // 路由模型请求被工作额度拒绝时，退化决策带上原因与范围，群消息状态据此说明额度与下一步，而非通用「无法判断」。
   const budget=answered.kind==='degraded'&&answered.budget?{budget:{...answered.budget}}:{}
   decision=direct.mode==='blocked'?decisionOf(now,'blocked',carried.hops,{...shared})
    :answered.kind==='parse-failed'||quotedWork?decisionOf(now,answered.kind==='degraded'?'degraded':'parse-failed',carried.hops,{...shared,...budget})
    :fixed?decisionOf(now,'direct',carried.hops,{...shared,respond:fixed})
    :!carried.candidates.length?decisionOf(now,'no-candidate',carried.hops,{...shared})
    :decisionOf(now,'degraded',carried.hops,{...shared,...budget,respond:degradedRespond(trigger.mentions,candidateIds)})
  }
 }
 // 段 C：并发的两条触发都会跑完段 B，但只有一条能 insert 成功，另一条整条退出、不建任务。
 const written=await ports.decisions.withTopicLock(owner,groupId,rootId,async db=>{
  admission.assertCurrent()
  // 只认段 A 打开的那一次尝试仍待定案：并发重入、旧尝试迟到或期间又有新重试都整条退出。
  if((await open(db))?.attempt!==carried.attempt)return undefined
  // 模型等待期间可能撤销本人同意、群授权或改变岗位。先重核当前资格，不能让旧候选接单或加表情。
  const current=await ports.candidates(owner,groupId,db),group=await ports.group(owner,groupId,db)
  const eligible=new Set(group&&!group.archived&&group.version===carried.version
   ?current.filter(item=>carried.candidates.some(prior=>prior.roleId===item.roleId&&prior.roleVersion===item.roleVersion)).map(item=>item.roleId):[])
  // 前序接手者失效时，依赖其成果的后序也失效；不重编号为第一阶段，否则会绕过依赖提前启动。
  const missingStage=Math.min(...(decision.assignments??[]).filter(item=>!eligible.has(item.roleId)).map(item=>item.stage??1))
  const dependent=new Set((decision.assignments??[]).filter(item=>(item.stage??1)>missingStage).map(item=>item.roleId))
  const available=(roleId:string)=>eligible.has(roleId)&&!dependent.has(roleId)
  // 撤权同步收敛：respond、reactions 与 assignments 一起保留可用接手者，前序与失去依赖的后序都持久呈现失效。
  const withdrawn=decision.respond.filter(roleId=>!available(roleId))
  const fixed:GroupRoutingDecision={...decision,respond:decision.respond.filter(available),reactions:decision.reactions.filter(reaction=>available(reaction.roleId)),...(decision.assignments?{assignments:decision.assignments.filter(item=>available(item.roleId))}:{}),...(withdrawn.length?{withdrawn}:{})}
  // GRP-04：员工回帖再次触发的派工不得与同一话题里仍在占用中的岗位重复。实测中接力后序（waiting）与运行中的
  // 审校已覆盖同一职责，员工回帖的语义路由又派了第二个任务/第二条近重复回复。这里只收窄本轮派工，
  // 不改写其他已确认决策；被收窄的接收者不建任务、不发放回执，消息状态按「已记录」呈现。
  const busyRoles=trigger.authorKind==='role'&&ports.delivery?.outbox.activeRolesInRoot
   ?new Set(await ports.delivery.outbox.activeRolesInRoot(owner,{groupId,messageId}))
   :new Set<string>()
  const dispatched:GroupRoutingDecision=busyRoles.size?{...fixed,respond:fixed.respond.filter(id=>!busyRoles.has(id)),reactions:fixed.reactions.filter(reaction=>!busyRoles.has(reaction.roleId)),...(fixed.assignments?{assignments:fixed.assignments.filter(item=>!busyRoles.has(item.roleId))}:{})}:fixed
  // 「收到」只给仍可接单的岗位；它与决策同事务落库，独立于模型的表情输出。
  const acknowledged:{roleId:string;emoji:GroupReactionEmoji}[]=dispatched.kind==='routed'||dispatched.kind==='direct'
   ?dispatched.respond.filter(roleId=>!dispatched.reactions.some(reaction=>reaction.roleId===roleId)).map(roleId=>({roleId,emoji:routedAckEmoji})):[]
  const recorded=await record(db,carried.attempt,dispatched)
  if(!recorded)return undefined
  // 每位接收者的稳定请求与终态决策同事务：提交前失败没有孤儿，提交后退出可由恢复worker补派。
  if(ports.delivery)await ports.delivery.outbox.recordRecipients(db,owner,{groupId,messageId,decision:recorded,decisionVersion:carried.attempt})
  // 表情与决策同一个事务：决策行写不进去（并发撞主键）时一个表情都不该落表，否则库里会留下
  // 「没有决策却有路由表情」的孤儿行。代价是一次 insert 加至多 30 条 upsert 都压在这把锁里——
  // 都是毫秒级的本地写，换来的是两张表恒一致。
  for(const reaction of [...dispatched.reactions,...acknowledged])await ports.applyReaction(db,owner,{groupId,messageId,roleId:reaction.roleId,emoji:reaction.emoji,requestId:groupRoutedReactionRequestId(owner,messageId,reaction.roleId,reaction.emoji)})
  // 对原工作的追加／停止：目标只能是段 A 读出的本群候选，版本取当时读到的那一版；回执与终态决策同事务登记。
  const target=(recorded.intent==='continue'||recorded.intent==='stop')&&recorded.workTarget?carried.work.find(item=>item.taskId===recorded.workTarget!.taskId&&item.runId===recorded.workTarget!.runId):undefined
  if(target&&ports.workInputs&&trigger.authorKind==='self'){
   // 登记失败（版本变化、取消）由服务持久记为拒绝回执；其余异常让整笔定案回滚，由唤醒按原身份重试，不定案成「无需处理」。
   await ports.workInputs.reserveInTransaction(db,owner,{requestId:groupWorkInputRequestId(owner,messageId,target.taskId,carried.attempt),groupId,messageId,taskId:target.taskId,expectedTaskVersion:target.version,operation:recorded.intent as 'continue'|'stop'})
  }
  admission.assertCurrent()
  return recorded
 })
 if(written&&ports.drainWorkInputs)await ports.drainWorkInputs(owner,signal)
 if(ports.delivery){await drainGroupRoutingOutbox(owner,ports.delivery,signal,{messageId});return}
 if(!written)return
 // 段 D：锁外。一位没建成不影响别的几位；两码吞掉不重试，其余只记一行。
 // 日志带上消息与岗位：一条群消息可能同时派给多位，只记错误码的话分不清是哪一位没建起来。
 // 原因只透传 WorkError 的固定文案（代码里的常量，不含群消息正文与模型输出），否则只有错误码根本定位不到是哪一道闸。
 const report=(code:string,roleId:string,reason=''):void=>{try{ctx.logger.warn('Teloa 群内路由建任务未完成：%s（消息 %s，员工 %s）%s',code,messageId,roleId,reason?' '+reason:'')}catch{}}
 for(const roleId of written.respond){
  const candidate=carried.candidates.find(item=>item.roleId===roleId)
  if(!candidate)continue
  // 建任务与建运行共用同一个确定性身份：一位员工对一条触发消息只可能有这一条任务、这一次运行。
  const requestId=groupRoutedAttemptTaskRequestId(owner,groupId,messageId,roleId,carried.attempt)
  try{
   const {taskId}=await ports.createTask(owner,{requestId,groupId,messageId,expectedGroupVersion:carried.version,goal:groupRoutedTaskGoal,assignee:{roleId,expectedVersion:candidate.roleVersion},trigger:'routed',...groupRoutedExecution(carried.attempt)},signal)
   const {runId}=await ports.prepare(owner,{requestId,taskId,expectedTaskVersion:routedTaskCreatedVersion},signal)
   const {state}=await ports.start(owner,runId,signal)
   // 运行配置不可用时这一位永远回不了帖，界面上的「员工正在回复…」只能等 30 分钟兜底。
   // 只记一行不够：warn 日志默认不落盘，本人在群里只会看到自己的消息石沉大海——所以再在话题里说一句。
   // 这条系统消息走 `sendSystem`（`CollaborationService.send` 直连），不经 `groups/messages/send` 那个
   // 触发点，因此它自己不会再引一轮路由——与停下消息同一条免触发口径。
   // requestId 复用这一位在本条触发消息上的任务身份：群消息的 request_id 与任务的各在各的表，同一个值
   // 不会撞；契约里没有第二个派生式可用，而这句提示本就该「每位每条触发消息至多一条」。
   if(state==='configuration_failed'){
    report('teloa/run-configuration-failed',roleId)
    // 提示单独包一层：`expectedVersion` 是段 A 的旧快照，群在这期间改过名/成员会 version-conflict，
    // 外层 `settled()` 会把它当「已建过」静默 continue——通知发不出去必须留痕，不能跟任务建立共用那套短路。
    try{await ports.sendSystem(owner,{requestId,groupId,expectedVersion:carried.version,text:groupRunConfigFailedText(candidate.name),rootId},signal)}
    catch(noticeError){report(noticeError instanceof WorkError?noticeError.code:'teloa/dependency-unavailable',roleId)}
   }
   // 到 start 为止：后续的 reconcile 与回帖由既有运行观察循环接手（`task-run-monitor` → `TaskRunDriver.reconcile`），
   // 路由编排不再跟着这次运行走，否则一条群消息的触发点会变成一条长驻的观察循环。
  }catch(error){
   if(settled(error))continue
   report(error instanceof WorkError?error.code:'teloa/dependency-unavailable',roleId,error instanceof WorkError?error.message:'')
  }
 }
}

/**
 * 本群候选工作：本人名下、属于本群的未取消任务，最多 10 项；带当前版本与最近一次运行身份。
 * 「属于本群」按三条持久关联取并集，缺一条都会让原任务从 work 里消失、模型只能判成交流：
 * - 群消息交办来源 `teloa_group_task_sources`；
 * - 任务定义自带的关联群 `definition.groupId`（草稿、配置、计划领取写入）；
 * - 本条本人消息实际引用的员工回帖所属任务：员工消息的 `task_id` 由宿主运行发布写入、引用受同群外键约束，
 *   引用本人自己的交办消息时取它唯一派生的群任务（`groupQuotedTaskSql`），
 *   因此这条关联不能由客户端自报、不能跨群，也不能借引用把别的任务抬进本群。
 * 引用项标 `quoted` 并排最前。这是 continue/stop 的唯一目标来源，模型不能指向其他群或别人的对象。
 */
export async function readRoutingWorkCandidates(owner:string,groupId:string,messageId:string,db:Queryable):Promise<RoutingWorkCandidate[]>{
 const rows=(await db.query(`with quoted as (
   select ${groupQuotedTaskSql} as task_id from teloa_group_messages m
    join teloa_group_messages reply on reply.id=m.reply_to_message_id and reply.group_id=m.group_id and reply.owner_id=m.owner_id
    where m.owner_id=$1 and m.group_id=$2 and m.id=$3),
  sources as (
   select s.task_id from teloa_group_task_sources s where s.owner_id=$1 and s.group_id=$2
   union select t.id from teloa_tasks t where t.owner_id=$1 and lower(t.definition->>'groupId')=lower($4)
   union select q.task_id from quoted q where q.task_id is not null)
  select t.id,t.version,t.state,t.assignee_role_id,t.definition->>'title' as title,
   (select r.id from teloa_task_runs r where r.owner_id=t.owner_id and r.task_id=t.id order by r.created_at desc,r.id desc limit 1) as run_id,
   exists(select 1 from quoted q where q.task_id=t.id) as quoted
  from sources join teloa_tasks t on t.id=sources.task_id and t.owner_id=$1
  where t.state<>'cancelled'
  order by quoted desc,t.updated_at desc,t.id limit 10`,[owner,groupId,messageId,groupId])).rows
 return rows.map(row=>({taskId:String(row.id),runId:row.run_id===null?null:String(row.run_id),title:String(row.title??''),state:String(row.state),version:row.version as number,assigneeRoleId:typeof row.assignee_role_id==='string'?row.assignee_role_id:null,...(row.quoted===true?{quoted:true as const}:{})}))
}

/** 群的版本、归档位与群名（模型输入只用得到群名）。 */
export async function readRoutingGroup(owner:string,groupId:string,db:Queryable):Promise<{version:number;archived:boolean;name:string;mentionAllAllowed:boolean;coordinatorRoleId?:string}|undefined>{
 // 投影不先持群锁；候选读口按 role→group 固定行，避免和本人编辑群、岗位的锁序相反。
 const row=(await db.query('select definition,version,archived from teloa_groups where id=$1 and owner_id=$2',[groupId,owner])).rows[0]
 if(!row)return undefined
 if(!Number.isSafeInteger(row.version)||typeof row.archived!=='boolean')throw new WorkError('teloa/storage-corrupt','群版本或归档状态损坏。')
 const definition=groupDefinition(row.definition)
 return {version:row.version as number,archived:row.archived as boolean,name:definition.name,mentionAllAllowed:definition.rules.mentionAllAllowed,...(definition.coordinatorRoleId?{coordinatorRoleId:definition.coordinatorRoleId}:{})}
}

/**
 * 触发消息。`authorName` 口径与话题投影逐字同一套（`group-topic.ts`）：用户取当前资料姓名（缺失时用「用户」），
 * 员工取岗位名、岗位行读不到时用 roleId 顶名。
 */
export async function readRoutingMessage(owner:string,messageId:string,db:Queryable,displayName=''):Promise<GroupRoutingMessage|undefined>{
 const row=(await db.query('select group_id,root_id,author_id,text,created_at,mention_snapshot,reply_to_message_id,mention_all from teloa_group_messages where owner_id=$1 and id=$2',[owner,messageId])).rows[0]
 if(!row)return undefined
 const author=String(row.author_id),self=author==='self'
 const createdAt=row.created_at
 if(!(createdAt instanceof Date)||!Number.isFinite(createdAt.getTime()))throw new WorkError('teloa/storage-corrupt','群消息发送时间损坏。')
 const snapshot=Array.isArray(row.mention_snapshot)?row.mention_snapshot:[]
 // 先判类型再取值：`String(undefined)` 会造出 'undefined' 这种能进候选比对的假 roleId。
 const mentioned=snapshot.filter((mention):mention is {roleId:string}=>!!mention&&typeof mention==='object'&&typeof (mention as {roleId?:unknown}).roleId==='string')
 const mentions=self?[...new Set(mentioned.map(mention=>mention.roleId))]:[]
 const fixed=self?null:await readTrustedGroupMessageRunSource(db as Parameters<typeof readTrustedGroupMessageRunSource>[0],owner,{groupId:String(row.group_id),messageId})
 const named=self||fixed?undefined:(await db.query("select definition->>'name' as name from teloa_roles where owner_id=$1 and id=$2",[owner,author])).rows[0]
 return {
  groupId:String(row.group_id),
  // 根消息自己就是话题根：`root_id` 为空时用它自己的 id。
  rootId:row.root_id===null?messageId:String(row.root_id),
  authorKind:self?'self':'role',
  authorId:self?'self':author,
  authorName:self?(usablePersonalName(displayName)||'用户'):fixed?.roleName??(named?.name as string|undefined)??author,
  text:String(row.text),
  createdAt:createdAt.toISOString(),
  mentions,
  mentionAll:self&&row.mention_all===true,
  // 引用作者只按同一本人、同一群读取；引用本人消息只是上下文锚点，不指定员工。
  replyAuthorRoleId:self&&row.reply_to_message_id?await replyAuthor(db,owner,String(row.group_id),String(row.reply_to_message_id)):null,
 }
}

async function replyAuthor(db:Queryable,owner:string,groupId:string,replyTo:string):Promise<string|null>{
 const author=(await db.query('select author_id from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,groupId,replyTo])).rows[0]?.author_id
 return typeof author==='string'&&author!=='self'?author:null
}

/**
 * 候选：本群成员（**`role_id is not null`**，M15）∩ 在岗角色 ∩ 群授权 `active`
 * ∩ `canAutoRun` ∩ `canPost` ∩ 岗位支持本群范围（契约判据 `roleSupportsScope`：通用工作群对任何范围的员工都开放）。
 * 授权取该 `(group,role)` 的**最新一版**再判 `active`——已撤销的不会被更早的 active 行复活。
 * Twin 还须本人当前委托和执行回执通过共享准入服务；未装配 pool 的历史读口不放行 Twin。
 */
export async function readRoutingCandidates(owner:string,groupId:string,db:PoolClient,pool?:GroupRoutingDecisionService['pool']):Promise<GroupRoutingCandidate[]>{
 // 与群、岗位编辑共用 role→group 锁序；按 id 取全体成员锁，结果仍保留原成员显示顺序。
 await db.query(`select roles.id from teloa_group_members members join teloa_roles roles on roles.id=members.role_id and roles.owner_id=members.owner_id
  where members.group_id=$1 and members.owner_id=$2 and members.role_id is not null order by roles.id for share of roles`,[groupId,owner])
 const groupRow=(await db.query('select definition,version,archived from teloa_groups where id=$1 and owner_id=$2 for share',[groupId,owner])).rows[0]
 if(!groupRow||groupRow.archived)return []
 const scope=groupDefinition(groupRow.definition).scope
 const rows=(await db.query(`select roles.* from teloa_group_members members
  join teloa_roles roles on roles.id=members.role_id and roles.owner_id=members.owner_id
  join lateral (select * from teloa_group_agent_grants candidate where candidate.group_id=members.group_id and candidate.owner_id=members.owner_id and candidate.role_id=members.role_id order by candidate.grant_version desc limit 1) grants on true
  where members.group_id=$1 and members.owner_id=$2 and members.role_id is not null
   and roles.state='active' and grants.state='active' and grants.can_post and grants.can_auto_run
   and grants.group_version=$3 and grants.role_version=roles.version
  order by members.created_at,members.member_key`,[groupId,owner,groupRow.version])).rows
 const candidates:GroupRoutingCandidate[]=[]
 for(const row of rows){
  const definition=roleDefinition(row.definition)
  if(!roleSupportsScope(definition.scopes,scope))continue
  if(definition.kind==='twin'){
   if(!pool)continue
   try{(await authorizeRoleTaskAssignment(db,pool,owner,readStoredRole(row),scope,groupId)).assertCurrent()}
   catch(error){
    if(error instanceof WorkError&&['teloa/forbidden','teloa/conflict','teloa/version-conflict','teloa/invalid-input'].includes(error.code))continue
    throw error
   }
  }
  const responsibility=definition.responsibility??{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}
  candidates.push({roleId:String(row.id),roleVersion:row.version as number,name:definition.name,duty:definition.duty,scopes:[...definition.scopes],...responsibility})
 }
 return candidates
}

/**
 * 话题投影：直接用后端那一份（`readRunGroupTopic`），不在宿主侧另写一套截断与显示名规则。
 * 那个函数只读 `groupContext` 的 `groupId` 与 `source.rootId` 两处，这里按这两个键现折一份入参。
 */
export async function readRoutingTopic(owner:string,groupId:string,rootId:string,db:PoolClient,messageId?:string,displayName=''):Promise<RunGroupTopicMessage[]>{
 if(messageId){
  // 本人路由可见面（roleId=null）：与执行员工同一选择器；引用原消息作为锚点保留。
  const replyTo=(await db.query('select reply_to_message_id from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,groupId,messageId])).rows[0]?.reply_to_message_id
  return (await readGroupConversationTopic(db,owner,{groupId,messageId,replyToMessageId:typeof replyTo==='string'?replyTo:null,mode:rootId===messageId?'main':'thread',roleId:null,displayName,textMaxChars:routingTopicTextMaxChars}))?.messages??[]
 }
 return (await readRunGroupTopic(db,owner,{groupId,source:{rootId}} as unknown as RunGroupContext,displayName))?.messages??[]
}
