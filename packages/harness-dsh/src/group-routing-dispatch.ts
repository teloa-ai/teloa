import type {Context} from '@deepseek-ai/cordis'
import {WorkError,groupDefinition,roleSupportsScope,groupRelayStopRequestId,groupRoutedReactionRequestId,groupRoutedTaskRequestId,groupRoutingCandidatesMax,groupRoutingHopLimit,groupRoutingRespondMax,roleDefinition,type GroupReactionEmoji,type GroupRoutingDecision,type GroupTaskCreateInput} from '@teloa/contract'
import {workAccess,authorizeRoleTaskAssignment,readStoredRole,groupRelayStopText,groupRoutedTaskGoal,groupRunConfigFailedText,readRunGroupTopic,type GroupRoutingDecisionService,type RunGroupContext,type RunGroupTopicMessage} from '@teloa/backend'
import {askGroupRouting,type GroupRoutingAsk,type GroupRoutingCandidate} from './group-routing.ts'
import {drainGroupRoutingOutbox,type GroupRoutingOutboxPorts} from './group-routing-outbox-driver.ts'
import {readTrustedGroupMessageRunSource,type GroupRoutingOutboxService} from '@teloa/backend'

/** 最小可查询接口：只要有 `query(text,values)` 就够，不为此专门依赖 `pg`（先例 `business-definitions.ts:60`）。 */
type Queryable={query(text:string,values:readonly unknown[]):Promise<{rows:Record<string,unknown>[]}>}
/** 话题锁回调里那个真实连接的类型：从决策服务的签名上取，同样不引 `pg`。 */
type PoolClient=Parameters<Parameters<GroupRoutingDecisionService['withTopicLock']>[3]>[0]

/** 触发消息的只读投影。`mentions` 只对本人消息有值：员工消息（`GroupEmployeeMessage` 9 键）没有这个键。 */
export type GroupRoutingMessage={groupId:string;rootId:string;authorKind:'self'|'role';authorId:string;authorName:string;text:string;createdAt:string;mentions:string[]}

export type GroupRoutingDispatchPorts={
 /** 新宿主必须装配。历史调用可保留旧投递方式，已有决策不会凭当前岗位版本补造待办。 */
 delivery?:GroupRoutingOutboxPorts&{outbox:GroupRoutingOutboxPorts['outbox']&Pick<GroupRoutingOutboxService,'recordRecipients'>}
 /**
  * 话题锁与决策表的唯一真源。段 A 与段 C 各用 `withTopicLock` 包一次；
  * 模型调用（段 B）与建任务（段 D）都在锁外（H7/H8）。
  */
 decisions:Pick<GroupRoutingDecisionService,'identity'|'withTopicLock'|'claimed'|'isStopMessage'|'relayGateOpen'|'relayStopRounds'|'hops'|'record'>
 /** C2：群的版本与归档位。 */
 group:(owner:string,groupId:string,db:PoolClient)=>Promise<{version:number;archived:boolean;name:string}|undefined>
 /**
  * C2：触发消息本身。**不收 db**：话题锁的键要用这条消息的 `groupId`/`rootId`，必须在取锁之前读出来；
  * 群消息行写下之后不再被任何生产路径 update/delete，锁外读是安全的。
  */
 message:(owner:string,messageId:string)=>Promise<GroupRoutingMessage|undefined>
 /** C2：候选。SQL 必须带 `role_id is not null`（M15）。带出 `roleVersion` 供建任务做 `expectedVersion`。 */
 candidates:(owner:string,groupId:string,db:PoolClient)=>Promise<GroupRoutingCandidate[]>
 topic:(owner:string,groupId:string,rootId:string,db:PoolClient)=>Promise<RunGroupTopicMessage[]>
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

type Carried={version:number;name:string;hops:number;candidates:GroupRoutingCandidate[];truncatedCandidates:boolean;topic:RunGroupTopicMessage[]}

/**
 * 决策行恒是终态、恒一次写成：这里只是把八个键补齐，没有任何「先插占位再回写」的路径。
 * `now` 从决策服务的 `identity` 上取——`decision.at` 与那一行的 `created_at` 必须出自同一把时钟，
 * 这个助手函数自己去摸全局时钟会让两者在测试与回放里对不上。
 */
function decisionOf(now:()=>string,kind:GroupRoutingDecision['kind'],hops:number,fields:Partial<GroupRoutingDecision>):GroupRoutingDecision{
 return {kind,respond:[],reactions:[],hops,candidateIds:[],truncatedCandidates:false,stopMessageId:null,at:now(),...fields}
}

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
 const {groupId,rootId}=trigger
 // 段 A：锁内只跑 SQL 与（触顶时）一条系统消息，读完就提交释放锁。
 const carried=await ports.decisions.withTopicLock(owner,groupId,rootId,async(db):Promise<Carried|undefined>=>{
  if(await ports.decisions.claimed(db,owner,messageId))return undefined
  if(await ports.decisions.isStopMessage(db,owner,groupId,messageId))return undefined
  const group=await ports.group(owner,groupId,db)
  if(!group)return undefined
  if(group.archived){
   await ports.decisions.record(db,owner,{groupId,messageId,decision:decisionOf(now,'archived',await ports.decisions.hops(db,owner,groupId,rootId,messageId),{})})
   return undefined
  }
  // H2：停下之后在本人真正插话之前一律不放行——不写决策、不调模型。
  if(!await ports.decisions.relayGateOpen(db,owner,groupId,rootId,messageId))return undefined
  const hops=await ports.decisions.hops(db,owner,groupId,rootId,messageId)
  if(hops>groupRoutingHopLimit){
   // 轮次必须在写本轮决策之前读：写完再读会把本轮也数进去，同一话题第二次触顶就提示不出来。
   const round=await ports.decisions.relayStopRounds(db,owner,groupId,rootId)+1
   // 全文件唯一一处「锁内再取一条连接」：停下消息要与这条决策同生共死，所以只能在锁内发。
   // 它自己是一次独立事务（`collaboration.send` 的 `['teloa/group-send',owner,requestId]` 是另一把键，不会自锁），
   // 代价是段 A 短暂占两条连接——规格 §2.7「连接池影响」那一段说的就是这一处。
   const stop=await ports.sendSystem(owner,{requestId:groupRelayStopRequestId(owner,groupId,rootId,round),groupId,expectedVersion:group.version,text:groupRelayStopText,rootId},signal)
   await ports.decisions.record(db,owner,{groupId,messageId,decision:decisionOf(now,'relay-stopped',hops,{stopMessageId:stop.id})})
   return undefined
  }
  const {candidates,truncatedCandidates}=limitCandidates(await ports.candidates(owner,groupId,db))
  if(!candidates.length){
   await ports.decisions.record(db,owner,{groupId,messageId,decision:decisionOf(now,'no-candidate',hops,{})})
   return undefined
  }
  return {version:group.version,name:group.name,hops,candidates,truncatedCandidates,topic:await ports.topic(owner,groupId,rootId,db)}
 })
 if(!carried){if(ports.delivery)await drainGroupRoutingOutbox(owner,ports.delivery,signal,{messageId});return}
 const admission=await workAccess.authorize({kind:'capability',capability:'groups',ownerId:owner,sessionId:null,objectId:groupId,operation:'run'})
 admission.assertCurrent();signal.throwIfAborted()
 const candidateIds=carried.candidates.map(candidate=>candidate.roleId)
 // 段 B：锁已释放。三态直接映成 decision.kind，不在这里重新判别通道故障与解析失败。
 const ask:GroupRoutingAsk={groupId,groupName:carried.name,messageId,rootId,trigger:{...trigger,mentions:[...trigger.mentions]},topic:carried.topic,candidates:carried.candidates,hops:carried.hops}
 const answered=await askGroupRouting(ctx,owner,ask,signal)
 admission.assertCurrent();signal.throwIfAborted()
 const shared={candidateIds,truncatedCandidates:carried.truncatedCandidates}
 const decision=answered.kind==='ok'
  ?decisionOf(now,'routed',carried.hops,{...shared,respond:answered.output.respond.filter(roleId=>candidateIds.includes(roleId)).slice(0,groupRoutingRespondMax),reactions:answered.output.reactions.filter(reaction=>candidateIds.includes(reaction.roleId)).map(reaction=>({...reaction}))})
  :decisionOf(now,answered.kind==='degraded'?'degraded':'parse-failed',carried.hops,{...shared,respond:degradedRespond(trigger.mentions,candidateIds)})
 // 段 C：并发的两条触发都会跑完段 B，但只有一条能 insert 成功，另一条整条退出、不建任务。
 const written=await ports.decisions.withTopicLock(owner,groupId,rootId,async db=>{
  admission.assertCurrent()
  if(await ports.decisions.claimed(db,owner,messageId))return undefined
  // 模型等待期间可能撤销本人同意、群授权或改变岗位。先重核当前资格，不能让旧候选接单或加表情。
  const current=await ports.candidates(owner,groupId,db),group=await ports.group(owner,groupId,db)
  const eligible=new Set(group&&!group.archived&&group.version===carried.version
   ?current.filter(item=>carried.candidates.some(prior=>prior.roleId===item.roleId&&prior.roleVersion===item.roleVersion)).map(item=>item.roleId):[])
  const fixed={...decision,respond:decision.respond.filter(roleId=>eligible.has(roleId)),reactions:decision.reactions.filter(reaction=>eligible.has(reaction.roleId))}
  // 「收到」只给仍可接单的岗位；它与决策同事务落库，独立于模型的表情输出。
  const acknowledged:{roleId:string;emoji:GroupReactionEmoji}[]=fixed.kind==='routed'
   ?fixed.respond.filter(roleId=>!fixed.reactions.some(reaction=>reaction.roleId===roleId)).map(roleId=>({roleId,emoji:routedAckEmoji})):[]
  const recorded=await ports.decisions.record(db,owner,{groupId,messageId,decision:fixed})
  if(!recorded)return undefined
  // 每位接收者的稳定请求与终态决策同事务：提交前失败没有孤儿，提交后退出可由恢复worker补派。
  if(ports.delivery)await ports.delivery.outbox.recordRecipients(db,owner,{groupId,messageId,decision:recorded,decisionVersion:1})
  // 表情与决策同一个事务：决策行写不进去（并发撞主键）时一个表情都不该落表，否则库里会留下
  // 「没有决策却有路由表情」的孤儿行。代价是一次 insert 加至多 30 条 upsert 都压在这把锁里——
  // 都是毫秒级的本地写，换来的是两张表恒一致。
  for(const reaction of [...fixed.reactions,...acknowledged])await ports.applyReaction(db,owner,{groupId,messageId,roleId:reaction.roleId,emoji:reaction.emoji,requestId:groupRoutedReactionRequestId(owner,messageId,reaction.roleId,reaction.emoji)})
  admission.assertCurrent()
  return recorded
 })
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
  const requestId=groupRoutedTaskRequestId(owner,groupId,messageId,roleId)
  try{
   const {taskId}=await ports.createTask(owner,{requestId,groupId,messageId,expectedGroupVersion:carried.version,goal:groupRoutedTaskGoal,assignee:{roleId,expectedVersion:candidate.roleVersion},trigger:'routed'},signal)
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

/** 群的版本、归档位与群名（模型输入只用得到群名）。 */
export async function readRoutingGroup(owner:string,groupId:string,db:Queryable):Promise<{version:number;archived:boolean;name:string}|undefined>{
 // 投影不先持群锁；候选读口按 role→group 固定行，避免和本人编辑群、岗位的锁序相反。
 const row=(await db.query('select definition,version,archived from teloa_groups where id=$1 and owner_id=$2',[groupId,owner])).rows[0]
 if(!row)return undefined
 if(!Number.isSafeInteger(row.version)||typeof row.archived!=='boolean')throw new WorkError('teloa/storage-corrupt','群版本或归档状态损坏。')
 return {version:row.version as number,archived:row.archived as boolean,name:groupDefinition(row.definition).name}
}

/**
 * 触发消息。`authorName` 口径与话题投影逐字同一套（`group-topic.ts`）：本人恒「本人」，
 * 员工取岗位名、岗位行读不到时用 roleId 顶名。
 */
export async function readRoutingMessage(owner:string,messageId:string,db:Queryable):Promise<GroupRoutingMessage|undefined>{
 const row=(await db.query('select group_id,root_id,author_id,text,created_at,mention_snapshot from teloa_group_messages where owner_id=$1 and id=$2',[owner,messageId])).rows[0]
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
  authorName:self?'本人':fixed?.roleName??(named?.name as string|undefined)??author,
  text:String(row.text),
  createdAt:createdAt.toISOString(),
  mentions,
 }
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
  candidates.push({roleId:String(row.id),roleVersion:row.version as number,name:definition.name,duty:definition.duty,...responsibility})
 }
 return candidates
}

/**
 * 话题投影：直接用后端那一份（`readRunGroupTopic`），不在宿主侧另写一套截断与显示名规则。
 * 那个函数只读 `groupContext` 的 `groupId` 与 `source.rootId` 两处，这里按这两个键现折一份入参。
 */
export async function readRoutingTopic(owner:string,groupId:string,rootId:string,db:PoolClient):Promise<RunGroupTopicMessage[]>{
 return (await readRunGroupTopic(db,owner,{groupId,source:{rootId}} as unknown as RunGroupContext))?.messages??[]
}
