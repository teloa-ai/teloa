import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {GoalView,GoalRef} from '@deepseek-ai/dsh-goal'
import type {TaskRunGoalService,TaskRun,WorkAccessLease,WorkStagnationState} from '@teloa/backend'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {SessionId} from '@deepseek-ai/dsh-session'
import {WorkError} from '@teloa/contract'
import type {GoalObservationContext,GoalRunBinding} from '@teloa/contract'
import type {createNativeWorkInput} from './native-work-input.ts'
import {createNativeGoalAdmission} from './native-goal-admission.ts'
import {observeTaskRunTimeline} from './task-run-observation.ts'
import {readSessionEvents} from './session-events.ts'
import type {GoalInputCandidate} from './native-producer-admission.ts'
import {nativeInputIdentity} from './native-input-access.ts'
import type {GoalContinuationReceipt} from '@teloa/contract'

type BindingRun=Pick<TaskRun,'id'|'sessionId'|'nativeRequestId'>
type Service=Pick<TaskRunGoalService,'findRun'|'authorizeMutation'|'bind'|'updateRef'|'reserve'|'acquire'|'confirm'|'markUnknown'|'read'>&Partial<Pick<TaskRunGoalService,'withdrawUnpublished'>>
export type TaskRunGoalStagnationPort={readStagnation:(input:{runId:string;goalId:string})=>Promise<WorkStagnationState>;recordProgressRound:(input:{runId:string;goalId:string;revision:number;round:number})=>Promise<WorkStagnationState>;consumeStagnationAllowance:(input:{runId:string;goalId:string;controlGeneration:number;round:number})=>Promise<boolean>}
/** 唯一官方 Goal 适配。恢复只读 disarmed Goal；不主动 resume、不根据普通任务目标字符串建 Goal。 */
export function createTaskRunGoal(ctx:Context,service:Service,owner:string,options:{nativeInput:Pick<ReturnType<typeof createNativeWorkInput>,'withNewInput'>;hostGeneration:()=>number;requireStagnation?:boolean;stagnation?:TaskRunGoalStagnationPort;/** 冷只读使用官方严格 fold；缺席不猜测旧 Goal 完成。 */foldGoal?:typeof import('@deepseek-ai/dsh-goal').foldGoal}){
 let closed=false
 const pending=new Map<string,Promise<void>>(),failed=new Set<string>()
 const liveGoal=(agent:Agent):GoalView|undefined=>ctx.goals.get(agent)
 const exact=(agent:Agent)=>{if(closed||ctx.agents.get(agent.id)!==agent||ctx.sessions.get(agent.session.id)!==agent.session)throw new WorkError('teloa/forbidden','Goal 所属宿主或会话已变化。')}
 const reconcileReceipts=async(agent:Agent,receipts:readonly GoalContinuationReceipt[],withdrawAbsent=false)=>{
  exact(agent);if(!await ctx.sessions.flush(agent.session))throw new WorkError('teloa/unavailable','Goal 完整日志尚未持久化，保持受理待核对。')
  exact(agent);const events=readSessionEvents(agent.session)
  for(const receipt of receipts){
   if(!['reserved','unknown'].includes(receipt.state))continue
   const matches=events.filter(event=>event.type==='agent/inbox/spliced'&&agent.session.isOwnSeq(event.seq)&&event.data.inserted.some(message=>message.id===receipt.messageId))
   if(!matches.length){if(withdrawAbsent&&service.withdrawUnpublished)await service.withdrawUnpublished(owner,receipt.nativeRequestId);continue}
   const event=matches[0]!
   if(matches.length!==1||event.type!=='agent/inbox/spliced'||event.data.inserted.length!==1)throw new WorkError('teloa/storage-corrupt','Goal 消息身份对应多个或混合原生受理事件。')
   const message=event.data.inserted[0]!,source=message.source as unknown as Record<string,unknown>
   if(source.kind!=='goal'||source.goalId!==receipt.goalId||source.revision!==receipt.revision||source.round!==receipt.round||Object.keys(source).some(key=>!['kind','goalId','revision','round'].includes(key))||nativeInputIdentity(message).payloadSha256!==receipt.payloadSha256)throw new WorkError('teloa/storage-corrupt','Goal 受理载荷与原票据矛盾，保持未知。')
   // 实际 append 已持久、只有确认回包失败：同一个 seq 幂等补确认，绝不再送消息。
   await service.confirm(owner,{nativeRequestId:receipt.nativeRequestId,acceptedSeq:event.seq})
  }
 }
 const synchronize=async(run:BindingRun,goal:Pick<GoalView,'id'|'revision'>):Promise<GoalRunBinding>=>{
  const stored=await service.read(owner,{runId:run.id})
  if(!stored.binding)return service.bind(owner,{runId:run.id,goalId:goal.id,revision:goal.revision,hostGeneration:options.hostGeneration()})
  if(stored.binding.goalId!==goal.id)throw new WorkError('teloa/conflict','本次执行已有另一项持久 Goal；请创建新的执行。')
  if(stored.binding.revision!==goal.revision)return service.updateRef(owner,{runId:run.id,goalId:goal.id,previousRevision:stored.binding.revision,revision:goal.revision})
  return stored.binding
 }
 const changed=ctx.on('goal/changed',({agent,change})=>{
  const goal=change.goal
  if(!goal)return
  const prior=pending.get(agent.id)??Promise.resolve()
  const next=prior.catch(()=>{}).then(async()=>{exact(agent);const run=await service.findRun(owner,agent.id);if(run)await synchronize(run,goal)})
  pending.set(agent.id,next)
  next.then(()=>failed.delete(agent.id),()=>{failed.add(agent.id);try{ctx.goals.disarm(agent)}catch{/* 拒绝继续排队；不猜测持久结局。 */}})
 })
 const currentCandidate=(candidate:GoalInputCandidate,binding:GoalRunBinding)=>{exact(candidate.agent);const goal=liveGoal(candidate.agent);if(binding.ownerId!==owner||binding.sessionId!==candidate.agent.id||binding.hostGeneration!==options.hostGeneration()||!goal||goal.id!==binding.goalId||goal.revision!==binding.revision||goal.phase!=='active'||goal.activation!=='armed'||goal.roundsStarted+1!==candidate.round)throw new WorkError('teloa/forbidden','Goal 当前准入已失效。')}
 const checkProgress=async(candidate:GoalInputCandidate,run:BindingRun,binding:GoalRunBinding)=>{
  if(!options.stagnation){if(options.requireStagnation)throw new WorkError('teloa/unavailable','持久工作进展检查尚未装配，不能自动续轮。');return}
  currentCandidate(candidate,binding)
  if(candidate.round===1)return
  const source={runId:run.id,goalId:binding.goalId},stored=await service.read(owner,{runId:run.id});let state=await options.stagnation.readStagnation(source)
  for(let round=state.lastRound+1;round<candidate.round;round++){
   const accepted=stored.continuations.filter(receipt=>receipt.goalId===binding.goalId&&receipt.round===round&&receipt.state==='accepted')
   if(accepted.length!==1)throw new WorkError('teloa/execution-pending','此前 Goal 本轮受理仍不可核验，不能自动推进下一轮。')
   state=await options.stagnation.recordProgressRound({...source,revision:accepted[0]!.revision,round})
  }
  currentCandidate(candidate,binding)
  if(!state.shouldWait)return
  if(options.stagnation.consumeStagnationAllowance&&await options.stagnation.consumeStagnationAllowance({...source,controlGeneration:binding.controlGeneration,round:candidate.round})){currentCandidate(candidate,binding);return}
  const lease=await service.authorizeMutation(owner,run.id);lease.assertCurrent();currentCandidate(candidate,binding)
  ctx.goals.block(candidate.agent,{id:binding.goalId as GoalRef['id'],revision:binding.revision},{code:'work-stagnation',message:state.reason??'连续多轮没有新的可信业务进展，等待本人调整目标或资料。'})
  await pending.get(run.sessionId)
  throw new WorkError('teloa/conflict','连续多轮没有新的可信业务进展，Goal 已停用并等待本人处理。')
 }
 const admit=createNativeGoalAdmission(ctx,options.nativeInput,{
  async resolve(candidate){exact(candidate.agent);await pending.get(candidate.agent.id);if(failed.has(candidate.agent.id))throw new WorkError('teloa/unavailable','Goal 绑定尚未落定。');const run=await service.findRun(owner,candidate.agent.id);if(!run)throw new WorkError('teloa/forbidden','自动 Goal 只允许当前获准 Run。');const goal=liveGoal(candidate.agent);if(!goal||goal.id!==candidate.goal.id||goal.revision!==candidate.goal.revision)throw new WorkError('teloa/version-conflict','Goal 已变化。');const binding=await synchronize(run,goal);await checkProgress(candidate,run,binding);return binding},
  reserve:input=>service.reserve(owner,input),acquire:input=>service.acquire(owner,input),confirm:input=>service.confirm(owner,input),unknown:requestId=>service.markUnknown(owner,requestId),
  assertCurrent:currentCandidate,
  assertContinuationCurrent(candidate,binding){exact(candidate.agent);const goal=liveGoal(candidate.agent);if(binding.ownerId!==owner||binding.sessionId!==candidate.agent.id||binding.hostGeneration!==options.hostGeneration()||!goal||goal.id!==binding.goalId||goal.revision<binding.revision||goal.phase!=='complete'&&(goal.phase!=='active'||goal.activation!=='armed'))throw new WorkError('teloa/forbidden','Goal 已受理续作的宿主、控制或归属已失效。')},
 })
 const observation=async(run:BindingRun,events?:readonly SessionEvent[]):Promise<GoalObservationContext|undefined>=>{
  await pending.get(run.sessionId)
  let stored=await service.read(owner,{runId:run.id});if(!stored.binding)return undefined
  const attached=ctx.agents.get(SessionId(run.sessionId))
  if(attached&&stored.continuations.some(receipt=>receipt.state==='unknown')){await reconcileReceipts(attached,stored.continuations);stored=await service.read(owner,{runId:run.id});if(!stored.binding)return undefined}
  const agent=ctx.agents.get(SessionId(run.sessionId)),folded=!agent&&events?options.foldGoal?.(events):undefined,goal=agent?liveGoal(agent):folded?.goal
  if(!goal||goal.id!==stored.binding.goalId||goal.revision!==stored.binding.revision)throw new WorkError('teloa/unavailable','Goal 当前状态不可核验，保持执行未收口。')
  const own=new Set(stored.continuations.map(r=>r.messageId)),queued=[...(agent?.inbox.nextTurn??[]),...(agent?.inbox.nextStep??[])].some(message=>own.has(message.id))
  return {binding:stored.binding,continuations:stored.continuations,goalPhase:goal.phase,activation:agent?liveGoal(agent)!.activation:'disarmed',pendingRound:queued||stored.continuations.some(r=>r.state==='reserved'||r.state==='unknown'),childrenOutstanding:false}
 }
 const stop=async(run:BindingRun):Promise<void>=>{
  const current=await observation(run);if(!current)return
  const agent=ctx.agents.get(SessionId(run.sessionId));if(!agent)return
  exact(agent);ctx.goals.disarm(agent)
  const goal=liveGoal(agent)
  if(goal?.id===current.binding.goalId&&goal.phase==='active')ctx.goals.pause(agent,{id:goal.id,revision:goal.revision} satisfies GoalRef)
  // 只移除持久登记的本 Run Goal 排队项；他人消息和其他 Goal 均保留。
  for(const receipt of current.continuations)if([...agent.inbox.nextTurn,...agent.inbox.nextStep].some(message=>message.id===receipt.messageId))agent.inbox.remove(receipt.messageId as any)
  await pending.get(run.sessionId)
  // 完整本机历史里的缺席才证明未派发；已受理 receipt 不转为 withdrawn，也不丢掉原接受 seq。
  await reconcileReceipts(agent,current.continuations,true)
 }
 const resume=async(run:BindingRun,recoveryLease:WorkAccessLease):Promise<void>=>{
  if(typeof recoveryLease?.assertCurrent!=='function')throw new WorkError('teloa/forbidden','需要本次本人恢复的真实控制票据。')
  const agent=ctx.agents.get(SessionId(run.sessionId));if(!agent)throw new WorkError('teloa/unavailable','请先恢复精确检查点和本机会话，再启用 Goal。')
  exact(agent);const stored=await service.read(owner,{runId:run.id}),goal=liveGoal(agent)
  if(!stored.binding||!goal||stored.binding.goalId!==goal.id||stored.binding.revision!==goal.revision||goal.phase==='complete'||goal.activation!=='disarmed')throw new WorkError('teloa/version-conflict','Goal 恢复来源、状态或版本已变化。')
  const current=await service.authorizeMutation(owner,run.id);exact(agent);current.assertCurrent();recoveryLease.assertCurrent()
  // 官方 resume 同步升 revision；changed 在 Goal followup 准入前落当前 host/control binding。
  ctx.goals.resume(agent,{id:goal.id,revision:goal.revision})
  await pending.get(run.sessionId)
  if(failed.has(run.sessionId))throw new WorkError('teloa/unavailable','恢复后的 Goal 绑定尚未落定，已保持停用。')
 }
 const tools=ctx.on('tools/execute',async(exec,next)=>{
  if(!exec.agent||!['get_goal','create_goal','update_goal'].includes(exec.name))return next()
  const run=await service.findRun(owner,exec.agent.id)
  if(!run){
   // 普通会话尚无持久 Goal 续轮准入；变更体前拒绝，不能先创建成功再卡在自动续轮。
   if(exec.name!=='get_goal')throw new WorkError('teloa/forbidden','自动 Goal 目前需要本人确认的任务执行，请从任务入口开始。')
   return next()
  }
  exact(exec.agent)
  const events=readSessionEvents(exec.agent.session),context=await observation(run)
  if(!observeTaskRunTimeline(events,run.nativeRequestId,undefined,undefined,context).authorized)throw new WorkError('teloa/forbidden','Goal 工具不属于当前已受理执行轮。')
  const lease=await service.authorizeMutation(owner,run.id);exact(exec.agent);lease.assertCurrent()
  const result=await next()
  await pending.get(run.sessionId)
  if(failed.has(run.sessionId))throw new WorkError('teloa/unavailable','Goal 变更的执行绑定尚未落定。')
  return result
 })
 return Object.freeze({admit,observation,stop,resume,async observationForSession(sessionId:string,events:readonly SessionEvent[]){const run=await service.findRun(owner,sessionId);return run?observation(run,events):undefined},close(){closed=true;changed();tools()}})
}
