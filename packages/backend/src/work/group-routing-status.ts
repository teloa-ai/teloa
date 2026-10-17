import type {Pool} from 'pg'
import {WorkError,groupRoutingStatusInput,isGroupMention,isGroupRoutingDecision,isGroupRoutingStatusView,type GroupMessageHintCode,type GroupMessagePhase,type GroupRecipientStatus,type GroupRoutingDecision,type GroupRoutingStatusView} from '@teloa/contract'
import {groupRoutingRetryable} from './group-routing-attempts.ts'
import {readGroupRunPublication} from './group-run-publication.ts'

const ownerId=(value:string):void=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const corrupt=()=>new WorkError('teloa/storage-corrupt','群消息处理状态记录损坏，已停止读取。')

type Recipient=GroupRecipientStatus&{hint:GroupMessageHintCode|null}
/** 已派出接收者的聚合顺序：需要核对与等待本人的状态优先于已完成，部分不可用不掩盖正在处理的员工。 */
const phaseRank:readonly GroupMessagePhase[]=['unknown','awaiting-approval','stopping','paused','publication-blocked','running','queued','delivering','awaiting-review','blocked','stopped','completed','unavailable']

/** 原工作的真实事实：原 Task 状态、本轮工作控制状态，以及挂在原 Run 会话/原 Task 上仍待本人决定的原生审批。 */
type WorkFacts={taskState?:string;control?:string;approval:boolean}
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

function messageLevel(decision:GroupRoutingDecision,mentionAll:boolean):{phase:GroupMessagePhase;hint:GroupMessageHintCode|null}|undefined{
 if(decision.kind==='archived')return {phase:'blocked',hint:'group-archived'}
 if(decision.kind==='relay-stopped')return {phase:'blocked',hint:null}
 if(decision.respond.length)return undefined
 if(decision.withdrawn?.length)return {phase:'unavailable',hint:'not-authorized'}
 if(decision.kind==='no-candidate')return {phase:'unavailable',hint:'target-unavailable'}
 if(decision.kind==='blocked')return {phase:'unavailable',hint:mentionAll&&decision.candidateIds.length?'mention-all-denied':'target-unavailable'}
 if(decision.kind==='degraded')return {phase:'routing-failed',hint:'route-unavailable'}
 if(decision.kind==='parse-failed')return {phase:'routing-failed',hint:'route-invalid'}
 // 明确不需要文字回应：只有表情回应时算已处理，完全不选人时是已记录。
 return {phase:decision.reactions.length?'completed':'recorded',hint:null}
}

/**
 * 追加：已保存→排队（原运行结束后续办）；续办中/已送达→看续办 Run 与原工作事实。
 * 停止：只在原工作控制真正收敛时显示已停止，否则停止处理中；拒绝给出原因，不显示「无需处理」。
 */
function workInputPhase(input:Record<string,unknown>,run:Record<string,unknown>|undefined,resultMessageId:string|null,facts:WorkFacts):{phase:GroupMessagePhase;hint:GroupMessageHintCode|null}{
 if(input.state==='rejected')return {phase:'blocked',hint:input.operation==='stop'?'work-stopped':'source-changed'}
 if(input.operation==='stop'){
  if(facts.control==='ended'||facts.control==='stopped')return {phase:'stopped',hint:'work-stopped'}
  return input.state==='unknown'?{phase:'unknown',hint:'delivery-unknown'}:{phase:'stopping',hint:null}
 }
 if(input.state==='unknown'&&!run)return {phase:'unknown',hint:'delivery-unknown'}
 if(!run)return {phase:'queued',hint:null}
 return recipientPhase({state:input.state==='unknown'?'unknown':'settled'},run,resultMessageId,facts,'work')
}

/** 结构化点名对象：重试覆盖优先，其次本条 @，再次引用的员工；全员与语义选人没有逐位点名对象。 */
function namedTargets(decision:GroupRoutingDecision,message:Record<string,unknown>,override:unknown):string[]{
 if(decision.kind!=='direct'&&decision.kind!=='blocked')return []
 if(Array.isArray(override))return override.filter(isGroupMention).map(item=>item.roleId)
 if(message.mention_all===true)return []
 const mentions=(Array.isArray(message.mention_snapshot)?message.mention_snapshot:[]).filter(isGroupMention).map(item=>item.roleId)
 if(mentions.length)return mentions
 return message.reply_author&&message.reply_author!=='self'?[String(message.reply_author)]:[]
}

/**
 * 本人消息的处理状态投影（规格 §5、§6.6）：从持久消息、唤醒、当前路由尝试、逐接收者投递、Run 与已发布回帖读取。
 * 一次请求固定若干条批量查询，不随消息条数放大；员工消息不出状态，未知底层错误只映射到闭集提示码。
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
   const messages=(await client.query(`select m.id,m.mention_snapshot,m.mention_all,reply.author_id as reply_author from teloa_group_messages m
    left join teloa_group_messages reply on reply.id=m.reply_to_message_id and reply.owner_id=m.owner_id and reply.group_id=m.group_id
    where m.owner_id=$1 and m.group_id=$2 and m.id=any($3::uuid[]) and m.author_id='self' order by m.created_at,m.id`,[owner,request.groupId,[...new Set(request.messageIds)]])).rows
   if(!messages.length){await client.query('commit');return {items:[]}}
   const selfIds=messages.map(row=>String(row.id))
   const originals=new Map((await client.query('select message_id,decision from teloa_group_routing_decisions where owner_id=$1 and message_id=any($2::uuid[])',[owner,selfIds])).rows.map(row=>[String(row.message_id),row.decision]))
   const attempts=new Map((await client.query(`select distinct on (message_id) message_id,attempt_version,decision,override_recipients from teloa_group_routing_attempts
    where owner_id=$1 and message_id=any($2::uuid[]) order by message_id,attempt_version desc`,[owner,selfIds])).rows.map(row=>[String(row.message_id),row]))
   const wakes=new Map((await client.query('select message_id,state from teloa_group_routing_wakes where owner_id=$1 and message_id=any($2::uuid[])',[owner,selfIds])).rows.map(row=>[String(row.message_id),String(row.state)]))
   const outbox=(await client.query('select * from teloa_group_routing_outbox where owner_id=$1 and message_id=any($2::uuid[]) order by created_at,role_id',[owner,selfIds])).rows
   const inputs=(await client.query('select message_id,task_id,operation,state,run_id from teloa_group_work_inputs where owner_id=$1 and message_id=any($2::uuid[]) order by created_at',[owner,selfIds])).rows
   const runIds=[...new Set([...outbox,...inputs].flatMap(row=>row.run_id?[String(row.run_id)]:[]))]
   const runs=new Map((runIds.length?(await client.query('select id,state,session_id,task_id,evidence,group_publication from teloa_task_runs where owner_id=$1 and id=any($2::uuid[])',[owner,runIds])).rows:[]).map(row=>[String(row.id),row]))
   // 原工作事实：Task 状态、本轮工作控制、安全动作与宿主提供的未决原生审批；业务草稿的旧状态不构成审批事实。
   const taskIds=[...new Set([...outbox,...inputs].flatMap(row=>row.task_id?[String(row.task_id)]:[]))]
   const facts=new Map<string,WorkFacts>(taskIds.map(id=>[id,{approval:false}]))
   if(taskIds.length){
    for(const row of (await client.query('select id,state from teloa_tasks where owner_id=$1 and id=any($2::uuid[])',[owner,taskIds])).rows)facts.get(String(row.id))!.taskState=String(row.state)
    for(const row of (await client.query('select l.task_id,c.state from teloa_task_work_lineage l join teloa_work_controls c on c.owner_id=l.owner_id and c.id=l.round_control_id where l.owner_id=$1 and l.task_id=any($2::uuid[])',[owner,taskIds])).rows)facts.get(String(row.task_id))!.control=String(row.state)
    const active=[...runs.values()].filter(run=>run.state==='active'&&facts.has(String(run.task_id)))
    if(this.nativeApprovals&&active.length){
     const waiting=await this.nativeApprovals(active.map(run=>String(run.session_id)))
     for(const run of active)if(waiting.has(String(run.session_id)))facts.get(String(run.task_id))!.approval=true
    }
    if((await client.query("select to_regclass('teloa_security_actions') as relation")).rows[0]?.relation)
     for(const row of (await client.query("select distinct task_id from teloa_security_actions where owner_id=$1 and task_id=any($2::uuid[]) and state='pending_approval'",[owner,taskIds])).rows)facts.get(String(row.task_id))!.approval=true
   }
   const factsOf=(taskId:unknown)=>taskId?facts.get(String(taskId))??{approval:false}:{approval:false}
   const results=new Map<string,string>()
   if(runIds.length)for(const row of (await client.query('select id,run_id from teloa_group_messages where owner_id=$1 and group_id=$2 and run_id=any($3::uuid[]) order by created_at,id',[owner,request.groupId,runIds])).rows)if(!results.has(String(row.run_id)))results.set(String(row.run_id),String(row.id))
   const roleIds=new Set<string>(outbox.map(row=>String(row.role_id)))
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
    const delivered=outbox.some(item=>item.message_id===messageId)
    const view=(phase:GroupMessagePhase,hintCode:GroupMessageHintCode|null,recipients:Recipient[]):GroupRoutingStatusView=>{
     const value={messageId,attemptVersion:version,phase,recipients:recipients.map(({hint,...item})=>item),hintCode,canRetry:!group.archived&&groupRoutingRetryable(decision,delivered)}
     if(!isGroupRoutingStatusView(value))throw corrupt()
     return value
    }
    // 还没有终态决策：唤醒待处理即「正在安排」，否则只是「已收到」（旧消息没有唤醒行）。
    if(decision===null)return view(wakes.has(messageId)&&wakes.get(messageId)!=='settled'?'routing':'received',null,[])
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
    if(input){const fixed=workInputPhase(input,input.run_id?runs.get(String(input.run_id)):undefined,input.run_id?results.get(String(input.run_id))??null:null,factsOf(input.task_id));return view(fixed.phase,fixed.hint,[...dispatched,...unavailable])}
    // 判断为追加或停止，却没有可核对的登记回执（目标已不在本群候选中）：明确不能处理，不显示「无需处理」。
    if((decision.intent==='continue'||decision.intent==='stop')&&!decision.respond.length)return view('blocked','source-changed',unavailable)
    const level=messageLevel(decision,row.mention_all===true)
    if(level)return view(level.phase,level.hint,unavailable)
    const lead=phaseRank.find(phase=>dispatched.some(item=>item.phase===phase))??'queued'
    // 后序阶段等本人授予交接成果时，即使前序仍待确认，也要让本人看到需要先授予资料。
    return view(lead,dispatched.find(item=>item.phase===lead&&item.hint)?.hint??dispatched.find(item=>item.hint==='resource-required')?.hint??null,[...dispatched,...unavailable])
   })
   return {items}
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
}
