import type {Pool} from 'pg'
import {WorkError,groupRoutingCandidatesMax,groupRoutingStatusInput,isGroupMention,isGroupRoutingDecision,isGroupRoutingStatusView,type GroupMessageHintCode,type GroupMessagePhase,type GroupRecipientStatus,type GroupRoutingDecision,type GroupRoutingStatusView} from '@teloa/contract'
import {groupRoutingRetryable} from './group-routing-attempts.ts'
import {readTrustedGroupMessageRunSource} from './group-routing-outbox.ts'
import {readGroupRunPublication} from './group-run-publication.ts'
import {readGroupTaskSource} from './group-tasks.ts'

const ownerId=(value:string):void=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const corrupt=()=>new WorkError('teloa/storage-corrupt','群消息处理状态记录损坏，已停止读取。')

type Recipient=GroupRecipientStatus&{hint:GroupMessageHintCode|null}
/** 已派出接收者的聚合顺序：需要核对与等待本人的状态优先于已完成，部分不可用不掩盖正在处理的员工。 */
const phaseRank:readonly GroupMessagePhase[]=['unknown','awaiting-approval','stopping','paused','publication-blocked','running','queued','delivering','awaiting-review','blocked','stopped','completed','unavailable']

/** 原工作的真实事实：原 Task 状态、本轮工作控制状态，以及挂在原 Run 会话/原 Task 上仍待本人决定的原生审批。 */
type WorkFacts={taskState?:string;control?:string;controlId?:string;definitionActive?:boolean;approval:boolean}
/**
 * 单个接收者：只看本尝试的投递行、真实 Run、原生审批、工作控制、原 Task 与已确认贴回原群的回帖，不用员工是否在话题里发过言推断。
 * 交流回应回帖即已回应；明确工作的阶段回帖不冒充整项完成——原 Task 达到完成判据才算完成，否则等本人在原工作里确认。
 */
function recipientPhase(outbox:Record<string,unknown>,run:Record<string,unknown>|undefined,resultMessageId:string|null,facts:WorkFacts={approval:false},mode:'reply'|'work'='reply'):{phase:GroupMessagePhase;hint:GroupMessageHintCode|null}{
 if(outbox.state==='blocked')return {phase:'unavailable',hint:'not-authorized'}
 // 依赖交接等本人授予前序固定成果：可恢复等待，授予后由原投递继续，不是终态。
 if(outbox.state==='waiting'&&outbox.reason==='teloa/resource-required')return {phase:'queued',hint:'resource-required'}
 const state=run?.state
 const evidence=run?.evidence,completed=!!evidence&&typeof evidence==='object'&&'state' in evidence&&evidence.state==='ended'&&'reason' in evidence&&evidence.reason==='completed'
 // 冷恢复可暂停原控制以禁止隐式续跑，但不能抹掉已经确认贴回的回复或已完成工作这一历史事实。
 if(state==='ended'&&completed&&resultMessageId&&(mode==='reply'||facts.taskState==='completed'))return {phase:'completed',hint:null}
 if(facts.control==='ended'||facts.control==='stopped')return {phase:'stopped',hint:'work-stopped'}
 if(facts.control==='ending'||facts.control==='stopping')return {phase:'stopping',hint:null}
 if(facts.control==='paused'||facts.control==='pausing')return {phase:'paused',hint:'work-paused'}
 if(facts.approval)return {phase:'awaiting-approval',hint:null}
 if(state==='ended'){
  if(!completed)return {phase:'blocked',hint:'work-failed'}
  const publication=readGroupRunPublication(run?.group_publication)
  if(!resultMessageId&&!publication)return {phase:'publication-blocked',hint:'result-unconfirmed'}
  if(!resultMessageId&&publication?.state==='blocked')return {phase:'publication-blocked',hint:'result-retained'}
  if(!resultMessageId)return {phase:'delivering',hint:'result-pending'}
  return mode==='work'&&facts.taskState!=='completed'?{phase:'awaiting-review',hint:null}:{phase:'completed',hint:null}
 }
 if(state==='configuration_failed')return {phase:'blocked',hint:'model-configuration'}
 if(state==='withdrawn')return {phase:'stopped',hint:'work-stopped'}
 if(state==='accepted'||state==='active')return {phase:'running',hint:null}
 // 提交结果未知：只能核对原 Run，不能重新选人或派工。
 if(outbox.state==='unknown')return {phase:'unknown',hint:'delivery-unknown'}
 return {phase:'queued',hint:null}
}

/**
 * 员工交接判定失败时提示按原交接重新安排，不建议本人改由 @ 手工派工。
 * 第一尝试的停下由话题里的停下消息与路由副标题说明；显式重试被停下的接力挡住时，这里给出原因与下一步。
 */
function messageLevel(decision:GroupRoutingDecision,mentionAll:boolean,handoff:boolean,retried:boolean):{phase:GroupMessagePhase;hint:GroupMessageHintCode|null}|undefined{
 if(decision.kind==='archived')return {phase:'blocked',hint:'group-archived'}
 if(decision.kind==='relay-stopped')return {phase:'blocked',hint:retried?'relay-stopped':null}
 if(decision.respond.length)return undefined
 if(decision.withdrawn?.length)return {phase:'unavailable',hint:'not-authorized'}
 if(decision.kind==='no-candidate')return {phase:'unavailable',hint:'target-unavailable'}
 // 员工消息没有结构化点名（只走语义判断），编排对它判 blocked 的唯一来源是固定交付缺少必需复核。
 if(decision.kind==='blocked'&&handoff)return {phase:'blocked',hint:'handoff-review-required'}
 if(decision.kind==='blocked')return {phase:'unavailable',hint:mentionAll&&decision.candidateIds.length?'mention-all-denied':'target-unavailable'}
 // 路由模型请求被工作额度拒绝：说明额度原因与下一步（视图另带原因与范围），本人与员工交接同一口径。
 if(decision.kind==='degraded'&&decision.budget)return {phase:'routing-failed',hint:'budget-exhausted'}
 if(decision.kind==='degraded')return {phase:'routing-failed',hint:handoff?'handoff-unavailable':'route-unavailable'}
 if(decision.kind==='parse-failed')return {phase:'routing-failed',hint:handoff?'handoff-invalid':'route-invalid'}
 // 明确不需要文字回应：只有表情回应时算已处理，完全不选人时是已记录。
 return {phase:decision.reactions.length?'completed':'recorded',hint:null}
}

/**
 * 追加：已保存→排队（原运行结束后续办）；续办中/已送达→看续办 Run 与原工作事实。
 * 已保存的续办遇原任务本轮控制暂停：续办不会自行推进（规格 §4.4），如实显示「已暂停」并说明恢复后按这条消息继续，
 * 只有本人经整项恢复确认后才受理；控制已停止或结束时续办不复活，显示已停止。
 * 仍在暂停收敛中、或所属长期定义也未生效时，就地恢复本轮并不能让续办继续，只说明原工作已暂停，不给恢复入口。
 * 停止：只在原工作控制真正收敛时显示已停止，否则停止处理中；拒绝给出原因，不显示「无需处理」。
 */
function workInputPhase(input:Record<string,unknown>,run:Record<string,unknown>|undefined,resultMessageId:string|null,facts:WorkFacts):{phase:GroupMessagePhase;hint:GroupMessageHintCode|null}{
 const stopped=facts.control==='ended'||facts.control==='stopped'
 if(input.state==='rejected')return {phase:'blocked',hint:input.operation==='stop'||stopped?'work-stopped':'source-changed'}
 if(input.operation==='stop'){
  if(facts.control==='ended'||facts.control==='stopped')return {phase:'stopped',hint:'work-stopped'}
  return input.state==='unknown'?{phase:'unknown',hint:'delivery-unknown'}:{phase:'stopping',hint:null}
 }
 if(input.state==='unknown'&&!run)return {phase:'unknown',hint:'delivery-unknown'}
 if(input.state==='reserved'&&!run){
  if(stopped)return {phase:'stopped',hint:'work-stopped'}
  if(facts.control==='ending'||facts.control==='stopping')return {phase:'stopping',hint:null}
  if(facts.control==='paused'&&facts.controlId&&facts.definitionActive!==false)return {phase:'paused',hint:'continue-paused'}
  if(facts.control==='paused'||facts.control==='pausing')return {phase:'paused',hint:'work-paused'}
 }
 if(!run)return {phase:'queued',hint:null}
 return recipientPhase({state:input.state==='unknown'?'unknown':'settled'},run,resultMessageId,facts,'work')
}

/** 结构化点名对象：重试覆盖优先，其次本条 @，再次引用的员工；全员与语义选人没有逐位点名对象。员工消息只走语义判断，没有点名对象。 */
function namedTargets(decision:GroupRoutingDecision,message:Record<string,unknown>,override:unknown):string[]{
 if(decision.kind!=='direct'&&decision.kind!=='blocked'||message.author_id!=='self')return []
 if(Array.isArray(override))return override.filter(isGroupMention).map(item=>item.roleId)
 if(message.mention_all===true)return []
 const mentions=(Array.isArray(message.mention_snapshot)?message.mention_snapshot:[]).filter(isGroupMention).map(item=>item.roleId)
 if(mentions.length)return mentions
 return message.reply_author&&message.reply_author!=='self'?[String(message.reply_author)]:[]
}

/**
 * 群消息的处理状态投影（规格 §5、§6.6）：从持久消息、唤醒、当前路由尝试、逐接收者投递、Run 与已发布回帖读取。
 * 本人消息与员工消息（交接）同一套投影；一次请求固定若干条批量查询，只为判定失败的员工消息逐条核对可信来源，未知底层错误只映射到闭集提示码。
 */
export class GroupRoutingStatusService{
 readonly pool:Pool
 /** 原生审批（官方 approval/asked 尚无 approval/decided）只存在于宿主会话日志；由宿主按 Run 会话提供，后端不读原生日志。 */
 readonly nativeApprovals:((sessionIds:readonly string[])=>Promise<ReadonlySet<string>>)|undefined
 constructor(pool:Pool,nativeApprovals?:(sessionIds:readonly string[])=>Promise<ReadonlySet<string>>){this.pool=pool;this.nativeApprovals=nativeApprovals}

 async status(owner:string,input:unknown):Promise<{items:GroupRoutingStatusView[]}>{
  ownerId(owner)
  const request=groupRoutingStatusInput(input),client=await this.pool.connect()
  try{
   // 同一快照里读消息、尝试、投递与运行，避免各表读到不同时刻拼出不存在的状态。
   await client.query('begin isolation level repeatable read read only')
   const group=(await client.query('select archived from teloa_groups where owner_id=$1 and id=$2',[owner,request.groupId])).rows[0]
   if(!group)throw new WorkError('teloa/forbidden','群不存在或不属于当前本人。')
   const messages=(await client.query(`select m.id,m.author_id,m.mention_snapshot,m.mention_all,reply.author_id as reply_author from teloa_group_messages m
    left join teloa_group_messages reply on reply.id=m.reply_to_message_id and reply.owner_id=m.owner_id and reply.group_id=m.group_id
    where m.owner_id=$1 and m.group_id=$2 and m.id=any($3::uuid[]) order by m.created_at,m.id`,[owner,request.groupId,[...new Set(request.messageIds)]])).rows
   if(!messages.length){await client.query('commit');return {items:[]}}
   const ids=messages.map(row=>String(row.id))
   const originals=new Map((await client.query('select message_id,decision from teloa_group_routing_decisions where owner_id=$1 and message_id=any($2::uuid[])',[owner,ids])).rows.map(row=>[String(row.message_id),row.decision]))
   const attempts=new Map((await client.query(`select distinct on (message_id) message_id,attempt_version,decision,override_recipients from teloa_group_routing_attempts
    where owner_id=$1 and message_id=any($2::uuid[]) order by message_id,attempt_version desc`,[owner,ids])).rows.map(row=>[String(row.message_id),row]))
   const wakes=new Map((await client.query('select message_id,state from teloa_group_routing_wakes where owner_id=$1 and message_id=any($2::uuid[])',[owner,ids])).rows.map(row=>[String(row.message_id),String(row.state)]))
   const outbox=(await client.query('select * from teloa_group_routing_outbox where owner_id=$1 and message_id=any($2::uuid[]) order by created_at,role_id',[owner,ids])).rows
   const inputs=(await client.query('select message_id,task_id,operation,state,run_id from teloa_group_work_inputs where owner_id=$1 and message_id=any($2::uuid[]) order by created_at',[owner,ids])).rows
   // 本人从这条消息明确发起的工作也是真实处理事实；自动路由曾无人可选，不代表后来手动工作不存在。
   // 只按固定来源关联，取当前负责人版本的最新 Run，不从同话题发言猜测，也不写回路由决策或投递行。
   const manual=(await client.query(`select s.*,latest.id as run_id from teloa_group_task_sources s
    join teloa_tasks t on t.owner_id=s.owner_id and t.id=s.task_id
    left join lateral (select r.id from teloa_task_runs r where r.owner_id=s.owner_id and r.task_id=s.task_id
     and r.role_id=t.assignee_role_id and r.role_version=t.assignee_role_version order by r.created_at desc,r.id desc limit 1) latest on true
    where s.owner_id=$1 and s.group_id=$2 and s.message_id=any($3::uuid[])
     and coalesce(s.source_snapshot->>'trigger','manual')='manual' order by s.created_at desc,s.task_id`,[owner,request.groupId,ids])).rows.map(row=>{
     const source=readGroupTaskSource(row);return {message_id:source.messageId,task_id:source.taskId,run_id:row.run_id}
    })
   const runIds=[...new Set([...outbox,...inputs,...manual].flatMap(row=>row.run_id?[String(row.run_id)]:[]))]
   const runs=new Map((runIds.length?(await client.query('select id,state,session_id,task_id,role_id,evidence,group_publication from teloa_task_runs where owner_id=$1 and id=any($2::uuid[])',[owner,runIds])).rows:[]).map(row=>[String(row.id),row]))
   // 原工作事实：Task 状态、本轮工作控制、安全动作与宿主提供的未决原生审批；业务草稿的旧状态不构成审批事实。
   const taskIds=[...new Set([...outbox,...inputs,...manual].flatMap(row=>row.task_id?[String(row.task_id)]:[]))]
   const facts=new Map<string,WorkFacts>(taskIds.map(id=>[id,{approval:false}])),taskRoles=new Map<string,string>()
   if(taskIds.length){
    for(const row of (await client.query('select id,state,assignee_role_id from teloa_tasks where owner_id=$1 and id=any($2::uuid[])',[owner,taskIds])).rows){facts.get(String(row.id))!.taskState=String(row.state);if(typeof row.assignee_role_id==='string')taskRoles.set(String(row.id),row.assignee_role_id)}
    for(const row of (await client.query(`select l.task_id,c.id,c.state,d.state as definition_state from teloa_task_work_lineage l join teloa_work_controls c on c.owner_id=l.owner_id and c.id=l.round_control_id
     left join teloa_work_controls d on d.owner_id=l.owner_id and d.id=l.definition_control_id where l.owner_id=$1 and l.task_id=any($2::uuid[])`,[owner,taskIds])).rows)Object.assign(facts.get(String(row.task_id))!,{control:String(row.state),controlId:String(row.id),definitionActive:row.definition_state===null||row.definition_state==='active'})
    const active=[...runs.values()].filter(run=>run.state==='active'&&facts.has(String(run.task_id)))
    if(this.nativeApprovals&&active.length){
     const waiting=await this.nativeApprovals(active.map(run=>String(run.session_id)))
     for(const run of active)if(waiting.has(String(run.session_id)))facts.get(String(run.task_id))!.approval=true
    }
    if((await client.query("select to_regclass('teloa_security_actions') as relation")).rows[0]?.relation)
     for(const row of (await client.query("select distinct task_id from teloa_security_actions where owner_id=$1 and task_id=any($2::uuid[]) and state='pending_approval'",[owner,taskIds])).rows)facts.get(String(row.task_id))!.approval=true
   }
   // 员工交接只有可信工作来源（原 Run、谱系与预算账户）才能沿原消息重新安排；只核对判定失败、尚无派工的员工消息。
   // 来源核对失败（WorkError）只让这条不可重试，不中断整页状态；预算与控制世代在重试真正判断时由宿主再核。
   const trusted=new Set<string>()
   for(const row of messages){
    const messageId=String(row.id),attempt=attempts.get(messageId),stored:unknown=(attempt?attempt.decision:originals.get(messageId))??null
    if(row.author_id==='self'||!isGroupRoutingDecision(stored)||!groupRoutingRetryable(stored,outbox.some(item=>item.message_id===messageId)))continue
    if(await readTrustedGroupMessageRunSource(client,owner,{groupId:request.groupId,messageId}).catch(error=>{if(error instanceof WorkError)return null;throw error}))trusted.add(messageId)
   }
   const factsOf=(taskId:unknown)=>taskId?facts.get(String(taskId))??{approval:false}:{approval:false}
   const results=new Map<string,string>()
   if(runIds.length)for(const row of (await client.query('select id,run_id from teloa_group_messages where owner_id=$1 and group_id=$2 and run_id=any($3::uuid[]) order by created_at,id',[owner,request.groupId,runIds])).rows)if(!results.has(String(row.run_id)))results.set(String(row.run_id),String(row.id))
   const roleIds=new Set<string>([...outbox.map(row=>String(row.role_id)),...taskRoles.values(),...[...runs.values()].flatMap(run=>typeof run.role_id==='string'?[run.role_id]:[])])
   for(const value of [...originals.values(),...[...attempts.values()].map(row=>row.decision)])if(value&&Array.isArray(value.withdrawn))for(const id of value.withdrawn)roleIds.add(String(id))
   for(const row of messages){
    for(const mention of Array.isArray(row.mention_snapshot)?row.mention_snapshot:[])if(isGroupMention(mention))roleIds.add(mention.roleId)
    if(row.reply_author&&row.reply_author!=='self')roleIds.add(String(row.reply_author))
   }
   for(const row of attempts.values())for(const item of Array.isArray(row.override_recipients)?row.override_recipients:[])if(isGroupMention(item))roleIds.add(item.roleId)
   const names=new Map(roleIds.size?(await client.query("select id,definition->>'name' as name from teloa_roles where owner_id=$1 and id=any($2::uuid[])",[owner,[...roleIds]])).rows.map(row=>[String(row.id),String(row.name??'')]):[])
   await client.query('commit')
   const name=(roleId:string)=>(names.get(roleId)??'').slice(0,200)
   const items=messages.map(row=>{
    const messageId=String(row.id),attempt=attempts.get(messageId),version=attempt?attempt.attempt_version as number:1
    const stored:unknown=(attempt?attempt.decision:originals.get(messageId))??null
    if(stored!==null&&!isGroupRoutingDecision(stored))throw corrupt()
    const decision=stored as GroupRoutingDecision|null
    const explicit:Recipient[]=[]
    for(const item of manual.filter(item=>item.message_id===messageId)){
     const roleId=taskRoles.get(item.task_id);if(!roleId||explicit.some(item=>item.roleId===roleId))continue
     const runId=item.run_id?String(item.run_id):null,resultMessageId=runId?results.get(runId)??null:null,facts=factsOf(item.task_id)
     const fixed=facts.taskState==='cancelled'?{phase:'stopped' as const,hint:'work-stopped' as const}:recipientPhase({state:'settled'},runId?runs.get(runId):undefined,resultMessageId,facts,'work')
     explicit.push({roleId,name:name(roleId),taskId:item.task_id,runId,phase:fixed.phase,resultMessageId,executionMode:'work',hint:fixed.hint})
    }
    const delivered=outbox.some(item=>item.message_id===messageId)
    const view=(phase:GroupMessagePhase,hintCode:GroupMessageHintCode|null,recipients:Recipient[],controlId?:string):GroupRoutingStatusView=>{
     const value={messageId,attemptVersion:version,phase,recipients:recipients.slice(0,groupRoutingCandidatesMax).map(({hint,...item})=>item),hintCode,canRetry:!explicit.length&&!group.archived&&groupRoutingRetryable(decision,delivered)&&(row.author_id==='self'||trusted.has(messageId)),...(hintCode==='budget-exhausted'?{budget:{...decision?.budget}}:{}),...(hintCode==='continue-paused'?{controlId}:{})}
     if(!isGroupRoutingStatusView(value))throw corrupt()
     return value
    }
    // 还没有终态决策：唤醒待处理即「正在安排」，否则只是「已收到」（旧消息没有唤醒行）。
    const explicitView=(others:Recipient[]=[])=>{
     const recipients=[...explicit,...others.filter(item=>!explicit.some(fixed=>fixed.roleId===item.roleId))],lead=phaseRank.find(phase=>recipients.some(item=>item.phase===phase))??'queued'
     return view(lead,recipients.find(item=>item.phase===lead)?.hint??null,recipients)
    }
    if(decision===null)return explicit.length?explicitView():view(wakes.has(messageId)&&wakes.get(messageId)!=='settled'?'routing':'received',null,[])
    const named=[...new Set(namedTargets(decision,row,attempt?.override_recipients))].filter(roleId=>!decision.respond.includes(roleId)).map(roleId=>({roleId,name:name(roleId),taskId:null,runId:null,phase:'unavailable' as const,resultMessageId:null,executionMode:null,hint:'target-unavailable' as const}))
    // 模型等待期间失去资格的接收者：逐位呈现为不可回应（授权变化），不悄悄换人，也不重新赋权。
    const withdrawn=(decision.withdrawn??[]).filter(roleId=>!named.some(item=>item.roleId===roleId)).map(roleId=>({roleId,name:name(roleId),taskId:null,runId:null,phase:'unavailable' as const,resultMessageId:null,executionMode:null,hint:'not-authorized' as const}))
    const unavailable:Recipient[]=[...named,...withdrawn]
    const dispatched:Recipient[]=decision.respond.map(roleId=>{
     const item=outbox.find(entry=>entry.message_id===messageId&&entry.decision_version===version&&entry.role_id===roleId)
     if(!item)return {roleId,name:name(roleId),taskId:null,runId:null,phase:'queued',resultMessageId:null,executionMode:null,hint:null}
     const mode=item.execution_mode==='work'?'work' as const:'reply' as const
     const runId=item.run_id?String(item.run_id):null,resultMessageId=runId?results.get(runId)??null:null,fixed=recipientPhase(item,runId?runs.get(runId):undefined,resultMessageId,factsOf(item.task_id),mode)
     return {roleId,name:name(roleId),taskId:item.task_id?String(item.task_id):null,runId,phase:fixed.phase,resultMessageId,executionMode:mode,hint:fixed.hint}
    })
    // 对原工作的追加／停止优先呈现原工作的真实状态；同一条消息里的简短说明回应作为接收者并列显示，不替代原工作状态。
    const input=inputs.find(item=>String(item.message_id)===messageId)
    if(input){
     const runId=input.run_id?String(input.run_id):null,run=runId?runs.get(runId):undefined,resultMessageId=runId?results.get(runId)??null:null,fixed=workInputPhase(input,run,resultMessageId,factsOf(input.task_id))
     // 续办没有新派工行：接手者来自原Run冻结身份，未准备Run时才取原Task负责人，不能把被引用员工误报为不可回应。
     const roleId=typeof run?.role_id==='string'?run.role_id:taskRoles.get(String(input.task_id))
     const target:Recipient[] =roleId?[{roleId,name:name(roleId),taskId:String(input.task_id),runId,phase:fixed.phase,resultMessageId,executionMode:'work',hint:fixed.hint}]:[]
     return view(fixed.phase,fixed.hint,[...target,...dispatched.filter(item=>item.roleId!==roleId),...unavailable.filter(item=>item.roleId!==roleId)],factsOf(input.task_id).controlId)
    }
    if(explicit.length)return explicitView([...dispatched,...unavailable])
    // 判断为追加或停止，却没有可核对的登记回执（目标已不在本群候选中）：明确不能处理，不显示「无需处理」。
    if((decision.intent==='continue'||decision.intent==='stop')&&!decision.respond.length)return view('blocked','source-changed',unavailable)
    const level=messageLevel(decision,row.mention_all===true,row.author_id!=='self',version>1)
    if(level)return view(level.phase,level.hint,unavailable)
    const lead=phaseRank.find(phase=>dispatched.some(item=>item.phase===phase))??'queued'
    // 后序阶段等本人授予交接成果时，即使前序仍待确认，也要让本人看到需要先授予资料。
    return view(lead,dispatched.find(item=>item.phase===lead&&item.hint)?.hint??dispatched.find(item=>item.hint==='resource-required')?.hint??null,[...dispatched,...unavailable])
   })
   return {items}
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
}
