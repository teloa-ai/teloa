import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {SessionId} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import type {} from '@deepseek-ai/dsh-subagent'
import type {TaskRun,TaskRunRuntimeLinks,TaskRunRuntimeLink} from '@teloa/backend'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
type TaskRunTeamLink=Extract<TaskRunRuntimeLink,{kind:'team'}>
import {WorkError} from '@teloa/contract'
import {readSessionEvents} from './session-events.ts'
import {createTaskRunBackground,taskRunRuntimeId} from './task-run-background.ts'
import {groupRunAppendKey,taskRunTeamContinuations,pendingLegacyTeamMessages} from './task-run-team-records.ts'
import {observeTaskRunTimeline} from './task-run-observation.ts'
import {taskRunExternalContinuations} from './task-run-external-continuations.ts'
import type {TaskRunGoalObservationReader} from './task-tool-guard.ts'
import {subagentReservationId,type SubagentDelegationPorts} from './subagent-delegation.ts'
import type {TaskToolPolicy,TaskToolPolicyReader} from './task-tool-guard.ts'
import {resolveSessionLineage} from './subagent-lineage.ts'
import {readEndedTaskRunSession} from './task-run-cold-session.ts'

/** 取消数据库精确登记的在途子级；身份核对失败不借一般谱系扫描扩大取消范围。 */
export async function stopTaskRunChildren(ctx:Context,run:Pick<TaskRun,'sessionId'>,rows:readonly {childSessionId?:string}[],signal:AbortSignal):Promise<void>{
 const children=rows.flatMap(row=>{
  if(row.childSessionId===undefined)return []
  const child=ctx.agents.get(SessionId(row.childSessionId))
  if(!child)return []
  if(child.id===run.sessionId||resolveSessionLineage(ctx,child.session).root.id!==run.sessionId)throw new WorkError('teloa/forbidden','子会话不属于本次执行，不能取消。')
  return [child]
 })
 signal.throwIfAborted()
 for(const child of children)child.cancel({kind:'parent'})
 await Promise.all(children.map(child=>child.whenIdle()))
}

type ContinuationBinding=Pick<TaskRun,'id'|'sessionId'|'nativeRequestId'|'allowedTools'>
export type TaskRunTeamAccess={authorizeMember:(agent:Agent,policy:TaskToolPolicy,signal:AbortSignal)=>Promise<boolean>;continuations:(root:Agent,requestId:string,events:readonly SessionEvent[],allowedTools:readonly string[])=>Promise<ReadonlySet<string>>}
/** 官方 Team 保存 roster/DAG 并递送到 Inbox；本适配只负责业务授权、共用额度与收口。 */
/** 群追加：某原 Run 会话里宿主持久登记过的追加原生请求身份（待核对或已受理）。 */
export type TaskRunGroupAppends=(sessionId:string)=>Promise<readonly string[]>
export function createTaskRunTeam(ctx:Context,delegation:SubagentDelegationPorts,readPolicy:TaskToolPolicyReader,links:TaskRunRuntimeLinks,goalObservation?:TaskRunGoalObservationReader,groupAppends?:TaskRunGroupAppends){
 // 续接集合 = 获准 Team 通知 ∪ 本 Run 的群追加 ∪ 严格核验的外部完成通知；观察、工具与停止共用。
 const withAppends=async(sessionId:string,base:ReadonlySet<string>):Promise<ReadonlySet<string>>=>{const ids=groupAppends?await groupAppends(sessionId):[];return ids.length?new Set([...base,...ids.map(groupRunAppendKey)]):base}
 const creating=new Set<string>(),admitted=new Set<string>(),bound=new Map<string,Promise<void>>(),settled=new Set<string>()
 const stopping=new Map<string,ContinuationBinding>(),stopFailures=new Set<string>()
 const memberKey=(lead:string,name:string)=>lead+':'+name
 const authorizedChildren=new Map<string,string>()
 const grantsFor=async(runId:string,sessionId:string,requestId:string)=>{
  const rows=(await links.list({runId,kind:'team'})).filter((row):row is TaskRunTeamLink=>row.kind==='team')
  if(rows.some(row=>row.runId!==runId||row.sessionId!==sessionId||row.payload.requestId!==requestId||row.nativeId!==row.payload.reservationId))throw new WorkError('teloa/storage-corrupt','临时助手授权记录与执行不一致。')
  return rows
 }
 const assertGeneration=async(runId:string)=>{
  if((await links.list({runId,kind:'job'})).some(row=>row.kind==='job'&&row.payload.runtimeId!==taskRunRuntimeId))throw new WorkError('teloa/conflict','此执行所属宿主已重启，请核对中断结果；不能自动重放外部动作。')
 }
 const continuationsFor=async(run:ContinuationBinding,events:readonly SessionEvent[],pendingAsUnadmitted=false):Promise<ReadonlySet<string>>=>{
  const base=await withAppends(run.sessionId,taskRunTeamContinuations(events,await grantsFor(run.id,run.sessionId,run.nativeRequestId)))
  try{return new Set([...base,...taskRunExternalContinuations(run,events,await links.list({runId:run.id}),base)])}
  catch(error){
   // 工具/取消不能把尚未进入快照的通知当作许可；驱动保留 pending，不能据旧窗口收口。
   if(pendingAsUnadmitted&&error instanceof WorkError&&error.code==='teloa/execution-pending')return base
   throw error
  }
 }
 const background=createTaskRunBackground(ctx,links,run=>authorizedChildren.get(run.sessionId)===run.id)
 const disposeStopObserver=ctx.on('session/event',(session,event)=>{
  const stop=stopping.get(session.id)
  if(!stop||event.type!=='user/message'||event.surfaceOp!=='append')return
  // 让原生追加事务先退出；取消可能清空 inbox，不能在 append 的发布栅栏内重入。
  void Promise.resolve().then(async()=>{
   const root=ctx.agents.get(session.id)
   if(!root)return
   const events=readSessionEvents(root.session)
   if(observeTaskRunTimeline(events,stop.nativeRequestId,await continuationsFor(stop,events,true),undefined,await goalObservation?.(root.id,events)).authorized&&root.status==='running')root.cancel({kind:'user'})
  }).catch(()=>{stopFailures.add(session.id)})
 })
 const bind=async(grant:TaskRunTeamLink,childId:string)=>{
  if(settled.has(childId))throw new WorkError('teloa/conflict','临时助手已结清，不能重新派发。')
  let pending=bound.get(childId)
  if(!pending){
   pending=(async()=>{
    await delegation.bind({reservationId:grant.payload.reservationId,childSessionId:childId,depth:1})
    authorizedChildren.set(childId,grant.runId)
    await background.start({id:grant.runId,sessionId:childId,nativeRequestId:grant.payload.requestId})
   })()
   bound.set(childId,pending)
   pending.catch(()=>{if(bound.get(childId)===pending)bound.delete(childId)})
  }
  await pending
 }
 const authorizeMember:TaskRunTeamAccess['authorizeMember']=async(agent,policy,signal)=>{
  const membership=ctx.agentTeams.tryMembership(agent)
  if(membership?.role!=='teammate')return false
  if(policy.stopRequested||!policy.nativeRequestId||!policy.allowedTools.includes('spawn_teammate'))throw new WorkError('teloa/forbidden','临时助手没有有效的 Run 授权。')
  const runId=await delegation.runId(membership.root.id,signal)
  if(runId)await assertGeneration(runId)
  const grant=runId?(await grantsFor(runId,membership.root.id,policy.nativeRequestId)).find(item=>item.payload.name===membership.name):undefined
  if(!grant)throw new WorkError('teloa/forbidden','临时助手未登记到本次执行。')
  signal.throwIfAborted()
  try{await bind(grant,agent.id)}catch(error){ctx.agentTeams.interrupt(membership.root,membership.name);throw error}
  signal.throwIfAborted()
  return true
 }
 const disposeWrapper=ctx.on('tools/execute',async(exec,next)=>{
  if(exec.name!=='spawn_teammate'||!exec.agent)return next()
  const membership=ctx.agentTeams.membership(exec.agent),root=membership.root
  const policy=await readPolicy(root.id,exec.signal)
  if(policy===null)return next()
  if(membership.role!=='lead'||delegation.limits.maxDepth<1||policy.stopRequested||!policy.nativeRequestId||!policy.allowedTools.includes('spawn_teammate'))throw new WorkError('teloa/forbidden','本次执行未授权创建临时助手。')
  const name=(exec.arguments as {name?:unknown}).name
  if(typeof name!=='string'||!/^[-a-z0-9]{1,64}$/.test(name)||name==='lead')throw new WorkError('teloa/invalid-input','临时助手名称不正确。')
  const runId=await delegation.runId(root.id,exec.signal)
  if(!runId)throw new WorkError('teloa/forbidden','临时助手缺少受管执行身份。')
  const reservationId=subagentReservationId(root.id,exec.callId)
  const grants=await grantsFor(runId,root.id,policy.nativeRequestId)
  if(grants.some(grant=>grant.payload.reservationId===reservationId||grant.payload.name===name))throw new WorkError('teloa/execution-pending','临时助手创建已有记录，请读取原生成员状态，不要重复创建。')
  const key=memberKey(root.id,name)
  if(admitted.has(reservationId)||creating.has(key))throw new WorkError('teloa/execution-pending','同一助手创建仍在进行，请等待已有回执。')
  admitted.add(reservationId);creating.add(key)
  try{await delegation.reserve({runId,reservationId,limit:delegation.limits.maxPerRun})}catch(error){admitted.delete(reservationId);creating.delete(key);throw error}
  try{
   exec.signal.throwIfAborted()
   const latest=await readPolicy(root.id,exec.signal)
   if(!latest||latest.stopRequested||latest.nativeRequestId!==policy.nativeRequestId||!latest.allowedTools.includes('spawn_teammate'))throw new WorkError('teloa/forbidden','本次执行已停止或授权已变化。')
   const grant:TaskRunTeamLink={runId,kind:'team',nativeId:reservationId,sessionId:root.id,payload:{requestId:policy.nativeRequestId,reservationId,name}}
   await links.put(grant)
   const result=await next()
   const member=ctx.agentTeams.listMembers(root).find(member=>member.role==='teammate'&&member.name===name)
   if(member){
    if(member.status==='failed')await delegation.abandon({reservationId,childSessionId:member.id,depth:1,stopReason:'team-provisioning-failed'})
    else await bind(grant,member.id)
   }else await delegation.release({reservationId})
   return result
  }catch(error){
   const child=ctx.agentTeams.listMembers(root).find(member=>member.role==='teammate'&&member.name===name)
   if(!child)await delegation.release({reservationId})
   else{ctx.agentTeams.interrupt(root,name);await ctx.subagents.drainChildren(root,[child.id])}
   throw error
  }finally{creating.delete(key);admitted.delete(reservationId)}
 })
 const rootFor=(run:TaskRun)=>{
  const root=ctx.agents.get(SessionId(run.sessionId))
  if(!root||ctx.agentTeams.membership(root).role!=='lead')throw new WorkError('teloa/session-unavailable','执行负责人会话暂不可用。')
  return root
 }
 const registered=async(run:TaskRun)=>{
  const root=rootFor(run),grants=await grantsFor(run.id,run.sessionId,run.nativeRequestId)
  return {root,grants,members:ctx.agentTeams.listMembers(root)}
 }
 const coldState=async(run:TaskRun)=>{
  const unavailable=()=>new WorkError('teloa/session-unavailable','执行负责人会话暂不可用。')
  const signal=new AbortController().signal
  const assertBinding=async()=>{
   const policy=await readPolicy(run.sessionId,signal)
   // 终态策略已核验本人固定 Run/nativeRequest；只读历史不能调用要求当前执行状态的 skillScope。
   if(run.state!=='ended'||run.evidence?.state!=='ended'||run.stopRequestedAt!=null||!policy||policy.stopRequested||policy.nativeRequestId!==run.nativeRequestId)throw unavailable()
  }
  await assertBinding()
  // inspect 不激活 Agent。状态读取不能为判断可重试而恢复旧 Inbox、调用模型或重放工具。
  const grants=await grantsFor(run.id,run.sessionId,run.nativeRequestId)
  // 冷 Team 历史不自动续接；有授权记录仍由下面的 interrupted 判据拒绝重试。
  const {session,inbox}=await readEndedTaskRunSession(ctx,run,events=>goalObservation?.(run.sessionId,events)??Promise.resolve(undefined))
  const team=ctx.sessionProjections.stateOf(session,'agentTeam')
  if(!team)throw unavailable()
  await assertBinding()
  // 若别的受管操作已加载负责人，交还原有实时判据；冷恢复只证明从未派发 Team 的结束轮空闲。
  if(ctx.agents.get(SessionId(run.sessionId)))return undefined
  return {outstanding:inbox['next-turn'].length>0||inbox['next-step'].length>0,interrupted:!!team.failure||grants.length>0||team.members.length>0||team.tasks.length>0||team.messages.length>0}
 }
 return {
  authorizeMember,
  async continuations(root:Agent,requestId:string,events:readonly SessionEvent[],allowedTools:readonly string[]):Promise<ReadonlySet<string>>{
   const runId=await delegation.runId(root.id,new AbortController().signal)
   if(runId)await assertGeneration(runId)
   return runId?continuationsFor({id:runId,sessionId:root.id,nativeRequestId:requestId,allowedTools:[...allowedTools]},events,true):withAppends(root.id,new Set())
  },
  async runContinuations(run:TaskRun,events:readonly SessionEvent[]):Promise<ReadonlySet<string>>{
   return continuationsFor(run,events)
  },
  async state(run:TaskRun):Promise<{outstanding:boolean;interrupted:boolean}>{
   if(stopFailures.has(run.sessionId))throw new WorkError('teloa/conflict','停止后的原生通知尚未收口，请核对执行。')
   if(!ctx.agents.get(SessionId(run.sessionId))){const cold=await coldState(run);if(cold)return cold}
   const {root,grants,members}=await registered(run)
   let outstanding=false,interrupted=false
   const children:Array<{grant:TaskRunTeamLink;id:string}>=[]
   for(const grant of grants){
    const member=members.find(member=>member.role==='teammate'&&member.name===grant.payload.name)
    if(creating.has(memberKey(root.id,grant.payload.name))){outstanding=true;continue}
    if(!member){
     interrupted=true
     // 官方 roster 在创建子会话之前落盘；没有 roster 就没有可被重放或取消的 child。
     const reservation=(await delegation.list?.(run.id))?.find(item=>item.reservationId===grant.payload.reservationId)
     if(reservation?.state==='reserved')await delegation.release({reservationId:reservation.reservationId})
     continue
    }
    if(member.status==='failed'){
     interrupted=true
     await delegation.abandon({reservationId:grant.payload.reservationId,childSessionId:member.id,depth:1,stopReason:'team-provisioning-failed'})
     continue
    }
    if(settled.has(member.id))continue
    try{await bind(grant,member.id)}catch(error){
     if(run.stopRequestedAt==null)throw error
     await delegation.abandon({reservationId:grant.payload.reservationId,childSessionId:member.id,depth:1,stopReason:'aborted'})
    }
    const agent=ctx.agents.get(member.id)
    const jobs=await background.state({id:run.id,sessionId:member.id,nativeRequestId:run.nativeRequestId})
    if(!agent){
     // 官方 continuable 成员空闲时会卸载；读持久日志核对结尾，不能把“未加载”冒充崩溃。
     const handle=await ctx.sessionPersistence.open(member.id,'read')
     try{
      const history=(await handle.read()).events,lastTurn=[...history].reverse().find(event=>event.type==='turn/start'||event.type==='turn/end')
      interrupted ||= lastTurn?.type!=='turn/end'||lastTurn.data.reason.kind!=='completed'
     }finally{await handle.close()}
    }
    outstanding ||= member.status==='running'||member.status==='provisioning'||jobs.outstanding||(agent!==undefined&&(agent.inbox.nextTurn.length>0||agent.inbox.nextStep.length>0))
    interrupted ||= jobs.interrupted
    children.push({grant,id:member.id})
   }
   const events=readSessionEvents(root.session)
   const authorizedIds=new Set([root.id,...members.filter(member=>grants.some(grant=>grant.payload.name===member.name)).map(member=>member.id)])
   const pendingMessages=pendingLegacyTeamMessages(events).some(message=>authorizedIds.has(SessionId(message.senderId))&&authorizedIds.has(SessionId(message.targetId)))
   const busyRoot=root.status==='running'||root.inbox.nextTurn.length>0||root.inbox.nextStep.length>0
   if(run.stopRequestedAt==null&&!interrupted){
    outstanding ||= pendingMessages||ctx.agentTeams.listTasks(root).some(task=>task.status==='pending'||task.status==='in_progress')
   }
   if(!outstanding&&!busyRoot){
    for(const child of children){await delegation.settle({childSessionId:child.id,stopReason:run.stopRequestedAt!=null?'aborted':interrupted?'interrupted':'completed'});settled.add(child.id)}
   }
   return {outstanding:outstanding||busyRoot,interrupted}
  },
  async stop(run:TaskRun,signal:AbortSignal):Promise<void>{
   signal.throwIfAborted()
   const {root,grants,members}=await registered(run),ids:SessionId[]=[]
   stopping.set(root.id,{id:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,allowedTools:run.allowedTools})
   for(const grant of grants){
    const member=members.find(member=>member.role==='teammate'&&member.name===grant.payload.name)
    if(!member||member.status==='failed')continue
    // 停止意图之后不新增业务绑定，但原生已创建成员仍须先取消。
    background.bind({id:run.id,sessionId:member.id,nativeRequestId:run.nativeRequestId})
    if(ctx.agents.get(member.id))await background.cancel({id:run.id,sessionId:member.id,nativeRequestId:run.nativeRequestId},signal)
    ctx.agentTeams.interrupt(root,member.name);ids.push(member.id)
   }
   // 官方 continuation owner 撤销精确成员的运行与排队活动；完成后才允许 state 收口。
   await ctx.subagents.drainChildren(root,ids)
   // 官方 continuation 在撤销成员后会唤醒 Lead 的 subagent-settled 轮；它仍属于此次停止。
   const events=readSessionEvents(root.session),continuations=await continuationsFor(run,events,true)
   if(observeTaskRunTimeline(events,run.nativeRequestId,continuations,undefined,await goalObservation?.(root.id,events)).authorized&&root.status==='running')root.cancel({kind:'user'})
  },
  dispose(){disposeWrapper();disposeStopObserver();background.dispose()},
 }
}
