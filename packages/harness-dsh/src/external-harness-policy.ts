import {createHash} from 'node:crypto'
import {realpath} from 'node:fs/promises'
import {isDeepStrictEqual} from 'node:util'
import type {Context} from '@deepseek-ai/cordis'
import {SessionId} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-working-directory'
import {workAccess,type WorkAccess} from '@teloa/backend'
import {WorkError,readTaskToolArgumentRules,type TaskToolArgumentRule} from '@teloa/contract'
import type {TaskToolPolicyReader,TaskSessionBusinessBindingReader} from './task-tool-guard.ts'
import type {ExternalHarnessPorts} from './external-harness-admission.ts'
import {sourceInstructionKey,type ConversationWorkSourceKey} from './conversation-work-instruction.ts'
import {readSessionEvents} from './session-events.ts'
import {externalHarnessTools} from './external-harness-admission.ts'
import {validateReferenceToolRules} from './role-tool-grants.ts'

/** 仅由宿主本人策略构造调用；工具可见性不等于执行许可，原 external admission 仍逐次核对。 */
export function ownerExternalHarnessToolRules(availableNames:readonly string[],workspaceRoot:string):TaskToolArgumentRule[]{
 return readTaskToolArgumentRules(externalHarnessTools.filter(name=>availableNames.includes(name)).map(name=>({name,allowed:[],externalHarness:'owner-general',workspaceRoot})))
}
/** 本人计划的冻结外部范围须与当前固定目录逐值相等；员工规则仍使用原验证器。 */
export function validateOwnerToolRules(rules:readonly TaskToolArgumentRule[],available:TaskToolArgumentRule[]):void{
 const parsed=readTaskToolArgumentRules(rules)
 for(const rule of parsed.filter(rule=>externalHarnessTools.includes(rule.name))){
  const current=available.find(candidate=>candidate.name===rule.name)
  if(!current||!isDeepStrictEqual(current,rule))throw new WorkError('teloa/forbidden','本人外部引擎的工具或工作目录已变化，请重新核对。')
 }
 validateReferenceToolRules(parsed.filter(rule=>!externalHarnessTools.includes(rule.name)),available)
}

export type ExternalHarnessInstructionWork=Readonly<{
 ownerId:string
 request:Readonly<ConversationWorkSourceKey&{kind:'task'|'report';executor?:'general';title:string;stoppedAt:string|null}>
 taskId:string|null
 runId:string|null
}>
export type ExternalHarnessInstructionWorkReader=(source:Readonly<ConversationWorkSourceKey>,signal:AbortSignal)=>Promise<ExternalHarnessInstructionWork|null>

function mainInstruction(owner:string,exec:Parameters<typeof sourceInstructionKey>[1]){
 const agent=exec.agent
 if(!agent)throw new WorkError('teloa/forbidden','当前没有可核验的本人会话。')
 const session=agent.session,events=readSessionEvents(session),start=events.filter(event=>event.type==='turn/start').at(-1)?.seq
 if(start===undefined||start<session.inheritedEventCount)throw new WorkError('teloa/forbidden','当前没有可核验的本人轮次。')
 const messages=events.filter(event=>event.type==='user/message').filter(event=>event.seq>start)
 if(messages.some(event=>event.data.source.kind==='user'))return {turnStart:start,source:sourceInstructionKey(owner,exec)}
 const visible=new Set(session.surface.nodes)
 if(!messages.length||messages.some(event=>event.surfaceOp!=='append'||!visible.has(event.seq)))throw new WorkError('teloa/forbidden','当前原生续作通知不可核验。')
 // 没有公开的原始本人 key 读口时，保留原生完成通知续作能力；不把通知或最近历史猜成本人新指令。
 return {turnStart:start,source:null,noticeSeqs:messages.map(event=>event.seq)}
}

/** 当前官方外部提供方不能继承岗位工具/资料范围；本人通用会话另需逐次原生审批。 */
export function createExternalHarnessAuthorizer(ctx:Context,ports:{owner:string;runtimeId:string;readPolicy:TaskToolPolicyReader;readBusinessBinding:TaskSessionBusinessBindingReader;readInstructionWork:ExternalHarnessInstructionWorkReader;ownerRun?:(sessionId:string,provider:'codex'|'claude-code',signal:AbortSignal)=>Promise<{runId:string;nativeRequestId:string;assertCurrent:()=>void}|null>;access?:Pick<WorkAccess,'readSessionCapabilities'|'authorizeSessionCapabilities'>}):ExternalHarnessPorts['authorize']{
 const access=ports.access??workAccess,denied=(message:string)=>new WorkError('teloa/forbidden',message)
 return async input=>{
  input.signal.throwIfAborted()
  const agent=ctx.agents.get(SessionId(input.sessionId))
  if(!agent||agent.session.header.parentSession!==undefined)throw denied('请在本人的通用会话中使用外部引擎。')
  const taskPolicy=await ports.readPolicy(input.sessionId,input.signal),ownerRun=taskPolicy===null?null:await ports.ownerRun?.(input.sessionId,input.provider,input.signal)
  if(taskPolicy!==null&&(!ownerRun||taskPolicy.nativeRequestId!==ownerRun.nativeRequestId)||await ports.readBusinessBinding(input.sessionId,input.signal))throw denied('外部引擎目前不能继承本任务的岗位与资料范围，请使用受管子任务，或在本人通用会话中发起。')
  const instruction=taskPolicy===null?mainInstruction(ports.owner,{agent}):undefined,source=instruction?.source
  const assertSource=()=>{
   if(instruction&&JSON.stringify(mainInstruction(ports.owner,{agent}))!==JSON.stringify(instruction))throw denied('本人原指令或原生续作通知已变化，请从当前消息核对工作。')
  }
  if(source){
   const handed=await ports.readInstructionWork(source,input.signal)
   input.signal.throwIfAborted();assertSource()
   if(handed){
    const request=handed.request
    if(handed.ownerId!==ports.owner||!request||(['requestId','sessionId','messageId','messageSeq'] as const).some(key=>request[key]!==source[key]))throw denied('原交办与当前本人指令不一致，请核对原工作。')
    if(request.kind==='task'&&request.executor==='general'&&(handed.taskId!==null||handed.runId!==null||request.stoppedAt!==null))throw new WorkError('teloa/conflict',request.stoppedAt!==null?'原交办「'+request.title+'」已请求停止，不能从本条消息重新执行。请核对原任务停止状态；另有工作请明确发送新指令。':'「'+request.title+'」已交给独立执行，请核对原任务或读取原交办状态，不能在主会话再次执行同一工作。',{reason:'instruction-already-handed-off',requestId:request.requestId,taskId:handed.taskId,runId:handed.runId,title:request.title,stoppedAt:request.stoppedAt,nextTool:'teloa_work_status'})
   }
  }
  const capabilities=await access.readSessionCapabilities(ports.owner,input.sessionId)
  if(capabilities.status!=='ready'||capabilities.requiredCapabilities?.length!==1||capabilities.requiredCapabilities[0]!=='general-agent')throw denied('当前会话包含受管业务范围，请使用原任务的受管子任务。')
  const session=agent.session,preset=ctx.permissionPresets.current(session),policy=ctx.permissionPresets.resolve(preset)
  const mode=ctx.sandboxPolicy.resolve({session}).mode
  if(preset==='auto'||!['read-only','workspace-write'].includes(mode)||policy.sandbox!==mode||policy.approval!=='ask')throw denied('请使用可人工审批的安全模式，再确认本次外部引擎的独立执行范围。')
  const lease=await access.authorizeSessionCapabilities(input.sessionId,'subagent')
  const workspaceRoot=await realpath(await ctx.workingDirectory.ensure(agent,input.signal))
  const assertCurrent=()=>{
   input.signal.throwIfAborted();lease.assertCurrent();ownerRun?.assertCurrent()
   assertSource()
   if(ctx.agents.get(agent.id)!==agent||agent.session!==session||ctx.sessions.get(agent.id)!==session||ctx.permissionPresets.current(session)!==preset||ctx.sandboxPolicy.resolve({session}).mode!==mode)throw denied('外部引擎启动前的会话权限已变化，请重新发起。')
  }
  assertCurrent()
  const digest=createHash('sha256').update(JSON.stringify([ports.runtimeId,input.sessionId,input.callId,input.provider])).digest('hex')
  // 普通会话只沿原生 catalog/通知留痕，不创建假的业务 Run。
  return Object.freeze({runId:ownerRun?.runId??null,requestId:ownerRun?.nativeRequestId??digest,reservationId:'external:'+digest,runtimeId:ports.runtimeId,workspaceRoot,provider:input.provider,assertCurrent})
 }
}
