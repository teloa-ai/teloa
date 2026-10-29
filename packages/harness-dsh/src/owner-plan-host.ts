import {isDeepStrictEqual} from 'node:util'
import {realpath} from 'node:fs/promises'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {SessionId,SessionSeq} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import {combineWorkAccessLeases,workAccess,readOwnerPlanPolicy,readStoredTaskRun,readStoredConversationWorkContext,type OwnerPlanAuthority,type OwnerPlanSource,type TaskRun} from '@teloa/backend'
import {WorkError,readMethodReuseSource,readMethodReuseAcceptedSource,readModelReference,readOwnerPlanFields,readPlanWorkConfiguration,readTaskRunModelPolicy,workUuid,type MethodReuseIntent,type TaskToolArgumentRule} from '@teloa/contract'
import {nativeToolRules} from './native-tool-access.ts'
import {workspaceFileToolRules} from './workspace-file-access.ts'
import {taskRunToolRules,webToolRules} from './role-tool-grants.ts'
import {resolveTaskModelPolicy} from './task-model-dsh.ts'
import {resolveDshTaskPreset} from './task-run-dsh.ts'
import {readSessionEvents} from './session-events.ts'
import {ownerExternalHarnessToolRules} from './external-harness-policy.ts'
import {skillHttpGrantedSkills,skillHttpToolName} from './skill-http-tool.ts'
import {captureOwnerRunOrchestration} from './owner-run-orchestration.ts'
type PoolClient=Parameters<OwnerPlanAuthority['verifySource']>[0]

type Ports={
 owner:string
 /** 调用方已经持有事务；此端口不得另取连接或写方法采用账本。 */
 verifySource:(db:PoolClient,owner:string,source:OwnerPlanSource)=>Promise<{intent:MethodReuseIntent}>
 conversation:(owner:string,sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:string;purpose?:string}>
 sourceRun?:(db:PoolClient,owner:string,source:OwnerPlanSource)=>Promise<TaskRun|undefined>
}
const denied=()=>new WorkError('teloa/forbidden','本人计划需要原有效来源、通用范围及明确确认。')
const unavailable=()=>new WorkError('teloa/dependency-unavailable','原成果的执行模型或运行配置尚不可核对，请在原会话补充后继续。')
const changed=()=>new WorkError('teloa/version-conflict','原会话的模型、工具或运行配置已变化，请重新核对。')
/** 人工认可没有本人消息时，只读确定生产回执或唯一源 Run；不按时间挑最新执行。 */
export async function readOwnerPlanSourceRun(db:PoolClient,owner:string,source:OwnerPlanSource):Promise<TaskRun|undefined>{
 if(!source.taskId)throw unavailable()
 const registered=(await db.query("select to_regclass('teloa_artifact_revision_producers') as relation")).rows[0]?.relation
 const producers=registered?(await db.query('select run_id from teloa_artifact_revision_producers where owner_id=$1 and artifact_id=$2 and number=$3 and task_id=$4 for share',[owner,source.artifactId,source.version,source.taskId])).rows:[]
 if(producers.length>1)throw new WorkError('teloa/storage-corrupt','原成果生产回执重复。')
 const rows=producers[0]?(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 and task_id=$3 for share',[owner,producers[0].run_id,source.taskId])).rows:(await db.query('select * from teloa_task_runs where owner_id=$1 and task_id=$2 limit 2 for share',[owner,source.taskId])).rows
 if(rows.length!==1)throw unavailable()
 const run=readStoredTaskRun(rows[0]!)
 if(run.taskId!==source.taskId||run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.stopRequestedAt!==null)throw unavailable()
 return run
}
function sourceValue(input:OwnerPlanSource):OwnerPlanSource{
 const {kind,acceptedSource,...reference}=input
 if(kind!=='method-reuse')throw denied()
 const source=readMethodReuseSource(reference)
 if(!acceptedSource&&!source.taskId)throw denied()
 return {kind,...source,...(acceptedSource?{acceptedSource:readMethodReuseAcceptedSource(acceptedSource)}:{})}
}
/** 本人计划只冻结真实授权：技能接口代发按真实逐技能授权展开为逐项 {skill}，形状候选（anyArguments）不等于勾选任何技能，不冻结。 */
function ownerGrantedTools(allowedTools:readonly string[],argumentRules:readonly TaskToolArgumentRule[]|undefined){
 const skills=skillHttpGrantedSkills(argumentRules),rules=argumentRules?.flatMap(rule=>rule.name!==skillHttpToolName?[rule]:skills.length?[{name:skillHttpToolName,allowed:skills.map(skill=>({skill}))}]:[])
 return {allowedTools:allowedTools.filter(name=>name!==skillHttpToolName||skills.length>0),...(rules?{argumentRules:rules}:{})}
}
/** 认证浏览器确认链的宿主端口；不注册模型工具，不自行创建、启用或启动计划。 */
export function createOwnerPlanHost(ctx:Context,ports:Ports):OwnerPlanAuthority{
 const actor=(value:string)=>{if(!ports.owner||value!==ports.owner)throw denied()}
 const sourceAgent=async(sessionId:string,signal:AbortSignal,ordinary:boolean)=>{
  const binding=await ports.conversation(ports.owner,sessionId)
  if(binding.ownerId!==ports.owner||binding.sessionId!==sessionId||binding.status!=='ready'||ordinary&&binding.purpose==='task-run')throw denied()
  const resolved=await ctx.sessionController.resolveAgent(SessionId(sessionId));signal.throwIfAborted()
  if('error'in resolved)throw unavailable()
  const agent=resolved.agent
  if(agent.session.id!==sessionId||agent.session.header.origin==='subagent'||ctx.agents.get(SessionId(sessionId))!==agent)throw denied()
  return agent
 }
 const modelOf=(agent:Agent)=>{
  const selection=ctx.sessionProjections.stateOf(agent.session,'modelSelection'),header=agent.session.requestHeader()
  if(!selection)throw unavailable()
  const selected=selection.pending??(header?{provider:header.config.provider,model:header.config.model,...(header.adapterDefaults?.reasoningEffort===true||header.config.reasoningEffort===undefined?{}:{reasoningEffort:header.config.reasoningEffort})}:null)
  if(!selected)throw unavailable()
  return readModelReference(selected)
 }
 const verifySource:OwnerPlanAuthority['verifySource']=async(db,owner,input)=>{
  actor(owner);const source=sourceValue(input)
  await ports.verifySource(db,owner,source)
  if(source.acceptedSource){
   const sessionId=source.acceptedSource.sessionId,row=(await db.query('select * from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2 for share',[owner,sessionId])).rows[0]
   if(row){const context=readStoredConversationWorkContext(row);if(context.scopeId!=='general'||context.roleId!==null)throw denied()}
   if((await db.query("select kind from teloa_object_conversations where owner_id=$1 and session_id=$2 and active=true and source_only=false and kind='role' for share",[owner,sessionId])).rows.length)throw denied()
  }
  // 真实来源及版本由同事务读取和行锁保留；商业准入仍使用现有能力闸。
  return combineWorkAccessLeases([await workAccess.authorize({kind:'capability',capability:'general-agent',ownerId:owner,sessionId:source.acceptedSource?.sessionId??null,objectId:source.artifactId,operation:'run'}),{assertCurrent:()=>{
   const accepted=source.acceptedSource
   if(!accepted)return
   // 冷源刚由正式 reader 核过；只有载入 Agent 才能修改原生 surface，最终同步闸再核它。
   const live=ctx.agents.get(SessionId(accepted.sessionId))
   if(!live)return
   const seq=SessionSeq(accepted.messageSeq),event=readSessionEvents(live.session).find(item=>item.seq===seq)
   if(live.session.header.origin==='subagent'||!live.session.isOwnSeq(seq)||![...live.session.surface.nodes].includes(seq)||!event||event.type!=='user/message'||event.surfaceOp!=='append'||event.data.id!==accepted.messageId||event.data.source.kind!=='user'||!('rpcId'in event.data.source)||event.data.source.rpcId!==accepted.requestId)throw changed()
  }}])
 }
 return {
  verifySource,
  capture:async(owner,input,db)=>{
   actor(owner);const fields=readOwnerPlanFields(input.fields),configuration=readPlanWorkConfiguration(input.configuration),source=sourceValue(input.source)
   if(!workUuid(input.requestId)||!['save-paused','create-and-enable'].includes(input.intent)||fields.scope!=='general'||fields.roleId!==null||fields.groupId!=null||configuration.budget.money!==null)throw denied()
   const sourceLease=await verifySource(db,owner,source),signal=AbortSignal.timeout(30_000)
   const run=source.acceptedSource?undefined:await(ports.sourceRun??readOwnerPlanSourceRun)(db,owner,source)
   if(!source.acceptedSource&&(!run||run.taskId!==source.taskId||run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.stopRequestedAt!==null||!run.modelPolicy||!run.agentPresetId))throw unavailable()
   const sessionId=source.acceptedSource?.sessionId??run!.sessionId,agent=await sourceAgent(sessionId,signal,source.acceptedSource!==undefined),presetId=run?.agentPresetId??agent.session.header.agentPreset
   if(!presetId||presetId==='cordis'||agent.session.header.agentPreset!==presetId)throw denied()
   const selected=run?.modelPolicy?readTaskRunModelPolicy(run.modelPolicy):readTaskRunModelPolicy({primary:modelOf(agent)})
   const current=()=>{
    sourceLease.assertCurrent()
    if(ctx.agents.get(SessionId(sessionId))!==agent||agent.session.header.agentPreset!==presetId||agent.session.header.origin==='subagent'||!run&&!isDeepStrictEqual(modelOf(agent),selected.primary))throw changed()
   }
   current()
   if(await resolveDshTaskPreset(ctx,presetId,signal)!==presetId)throw changed()
   const orchestration=await captureOwnerRunOrchestration(ctx,agent,presetId,signal)
   const rules=[...taskRunToolRules([...nativeToolRules(ctx,agent),...await workspaceFileToolRules(ctx,agent),...webToolRules(true)],orchestration.names),...ownerExternalHarnessToolRules(['subagent_codex','subagent_claude_code'].filter(name=>ctx.tools.get(name,agent)!==undefined),await realpath(await ctx.workingDirectory.ensure(agent,signal)))]
   current();orchestration.assertCurrent()
   // 只读取原路由身份；显式备用仍由原模型策略读口验证，绝不猜全局默认备用。
   const modelPolicy=readTaskRunModelPolicy(await resolveTaskModelPolicy(ctx,{model:selected.primary,...(selected.fallback?{fallbackModel:selected.fallback}:{})},signal))
   current();orchestration.assertCurrent()
   const policy=readOwnerPlanPolicy({...(run?.executor?.kind==='owner'?ownerGrantedTools(run.allowedTools,run.argumentRules):ownerGrantedTools(rules.map(rule=>rule.name),rules)),modelPolicy,agentPresetId:presetId})
   const definitions=policy.allowedTools.map(name=>[name,ctx.tools.get(name,agent)] as const)
   const admission=combineWorkAccessLeases([sourceLease,await workAccess.authorize({kind:'capability',capability:'automation',ownerId:owner,sessionId:source.acceptedSource?.sessionId??null,objectId:input.requestId,operation:'create'}),{assertCurrent:()=>{current();orchestration.assertCurrent();if(definitions.some(([name,definition])=>ctx.tools.get(name,agent)!==definition))throw changed()}}])
   admission.assertCurrent();return {policy,admission}
  },
  authorize:async(owner,input)=>{
   actor(owner);const source=sourceValue(input.source)
   if(!workUuid(input.requestId)||!workUuid(input.planId)||!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<1||!Number.isSafeInteger(input.expectedConfigVersion)||input.expectedConfigVersion<1||!['enable','configure'].includes(input.operation))throw denied()
   // 来源、计划版本、control 和额度仍由调用方同事务的 verifyOwnerPlan 复核。
   return workAccess.authorize({kind:'capability',capability:'automation',ownerId:owner,sessionId:source.acceptedSource?.sessionId??null,objectId:input.planId,operation:input.operation==='enable'?'resume':'edit'})
  },
 }
}
