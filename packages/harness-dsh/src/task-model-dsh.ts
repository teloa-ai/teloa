import {BlockList,isIP} from 'node:net'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {SessionStore} from '@deepseek-ai/dsh-session'
import {createUserMessage,type ContextFormed,type LlmCallConfig} from '@deepseek-ai/dsh-llm'
import {TaskRunPresetError,type TaskRun} from '@teloa/backend'
import {WorkError,isRecord,readModelReference,readModelRecovery,readTaskRunModelPolicy,type ModelReference,type ModelRecovery,type RoleRuntimeConfig,type TaskRunModelPolicy} from '@teloa/contract'
import {readSessionEvents} from './session-events.ts'
import type {SettingsPort} from './local-models-route.ts'
import {installTaskModelRouting,type TaskModelRoutingPorts} from './task-model-routing.ts'

const local=new BlockList()
local.addSubnet('127.0.0.0',8);local.addSubnet('0.0.0.0',8)
local.addAddress('::1','ipv6');local.addAddress('::','ipv6')
/** 原生设置已授权的地址分类，不发请求、不读取或导出凭据。 */
export function remoteModelAddress(value:unknown):boolean{
 if(typeof value!=='string')return false
 try{
  const url=new URL(value),host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase().replace(/\.$/,'')
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||host==='localhost'||host.endsWith('.localhost'))return false
  const kind=isIP(host)
  return !kind||!local.check(host,kind===4?'ipv4':'ipv6')
 }catch{return false}
}
export function isDshRemoteModel(ctx:Context,model:ModelReference):boolean{
 const directory=ctx.llm.listConfigurableProviders().find(row=>row.provider===model.provider)
 // 未提供可读配置地址的适配器不猜；当前接入范围为官方 pi-ai 与官方 DeepSeek（DSH 0.1.7-rc.1 `llm-deepseek`）。
 if(!directory||directory.settingsNs!=='llm-pi-ai'&&directory.settingsNs!=='llm-deepseek')return false
 const settings=Reflect.get(ctx,'settings') as Pick<SettingsPort,'describe'>|undefined
 const descriptor=settings?.describe().find(row=>row.ns===directory.settingsNs)
 let profile:unknown=descriptor?.value
 for(const key of directory.settingsPath)profile=isRecord(profile)?profile[key]:undefined
 if(isRecord(profile)){
  if(profile.baseURL!==undefined)return remoteModelAddress(profile.baseURL)
 }
 // 官方 DeepSeek（provider `deepseek-official`）未配置 baseURL 时使用适配器固定的官方公网端点。
 if(directory.settingsNs==='llm-deepseek')return true
 // 官方目录内建路由使用适配器维护的云端地址；自定义路由必须提供可核对的地址。
 return directory.declared===false&&model.provider!=='ollama'
}
export async function resolveTaskModelPolicy(ctx:Context,runtime:RoleRuntimeConfig|undefined,signal:AbortSignal):Promise<TaskRunModelPolicy>{
 signal.throwIfAborted()
 try{
  const selected=(await ctx.sessionController.modelCatalog()).default
  signal.throwIfAborted()
  // 未配置全局默认不妨碍显式岗位模型；空目录不是模型故障。
  const defaultModel=selected?.provider&&selected.model?readModelReference(selected):undefined
  const primary=runtime?.model??defaultModel
  if(!primary)throw Error('missing')
  // 终审 I-1（2026-09-27 设计约束）：只认岗位明确配置的远程备用；未选备用即不兜底，不得拿全局默认云端模型外发任务上下文。
  const fallback=runtime?.fallbackModel
  if(fallback){
   if(!isDshRemoteModel(ctx,fallback))throw Error('not-remote')
   await ctx.llm.resolveCallConfig(fallback as LlmCallConfig,signal)
   signal.throwIfAborted()
  }
  return readTaskRunModelPolicy({primary,...(fallback?{fallback}:{})})
 }catch{
  signal.throwIfAborted()
  throw new TaskRunPresetError('teloa/preset-unavailable','model-resolve','任务模型配置不可用，请核对首选模型和远程备用模型。')
 }
}

export const taskModelRecoverySource='plugin:teloa.model-recovery' as const
declare module '@deepseek-ai/dsh-llm' {interface MessageSourceMap {'plugin:teloa.model-recovery':{kind:typeof taskModelRecoverySource;runId:string;recovery:ModelRecovery}&ContextFormed}}
const reasons:Record<ModelRecovery['reason'],string>={TIMEOUT:'请求超时',TRANSPORT:'连接失败',SERVER:'模型服务异常',RATE_LIMIT:'模型服务限流',NO_ADAPTER:'模型提供方不可用',UNKNOWN_MODEL:'模型不可用'}
/** 原生 notice 可见、可持久化、能进入下一次请求的上下文；不伪造用户消息或助手回复。 */
export async function recordTaskModelRecovery(ctx:Context,agent:Agent,runId:string,recovery:ModelRecovery):Promise<void>{
 const previous=readSessionEvents(agent.session).some(event=>event.type==='user/message'&&event.data.source.kind===taskModelRecoverySource&&event.data.source.runId===runId)
 if(!previous){
  const summary=`${reasons[recovery.reason]}，已切换到 ${recovery.to.model}`
  agent.session.append('user/message',createUserMessage({source:{kind:taskModelRecoverySource,form:'notice',summary,runId,recovery},content:[{type:'text',text:`${summary}（${recovery.to.provider}）。沿用当前任务、上下文和已完成的工具结果继续执行；系统提示中原模型名称已失效。`}]}),{surfaceOp:'append'})
 }
 const sessions=Reflect.get(ctx,'sessions') as unknown as SessionStore
 if(!await sessions.flush(agent.session))throw new TaskRunPresetError('teloa/session-unavailable','model-resolve','模型切换记录尚未持久化，已停止继续请求。')
}

/** send 与宿主恢复后的 pre-step 共用同一登记；重装不能把已切备用的任务重新切回首选。 */
export function createTaskModelRouting(ctx:Context,prepareRequest?:TaskModelRoutingPorts['prepareRequest']){
 const installed=new WeakMap<Agent,{runId:string;policy:string;routing:ReturnType<typeof installTaskModelRouting>;imagesAdmitted:boolean;dispose:()=>void}>()
 return (agent:Agent,run:Pick<TaskRun,'id'|'sessionId'|'modelPolicy'>)=>{
  // Skill 守卫按根 Run 授权子 Agent；模型选择则必须尊重子 Agent 自己的原生配置。
  if(!run.modelPolicy||agent.session.id!==run.sessionId)return undefined
  const policy=readTaskRunModelPolicy(run.modelPolicy),fingerprint=JSON.stringify(policy),previous=installed.get(agent)
  if(previous){if(previous.runId!==run.id||previous.policy!==fingerprint)throw new WorkError('teloa/version-conflict','执行会话的模型策略已变化。');return previous}
  const events=readSessionEvents(agent.session)
  const notices=events.flatMap(event=>event.type==='user/message'&&event.data.source.kind===taskModelRecoverySource&&event.data.source.runId===run.id?[readModelRecovery(event.data.source.recovery)]:[])
  const recovered=notices[0]
  if(notices.length>1||recovered&&(JSON.stringify(recovered.from)!==JSON.stringify(policy.primary)||JSON.stringify(recovered.to)!==JSON.stringify(policy.fallback)))throw new WorkError('teloa/storage-corrupt','模型恢复记录与本次执行不一致。')
  const state={runId:run.id,policy:fingerprint,imagesAdmitted:false,routing:undefined as unknown as ReturnType<typeof installTaskModelRouting>,dispose:()=>{}}
  state.routing=installTaskModelRouting(agent,policy,{
   ...(prepareRequest?{prepareRequest}:{}),
   isRemote:async(model,signal)=>{signal.throwIfAborted();return isDshRemoteModel(ctx,model)},
   requiresImages:()=>state.imagesAdmitted||readSessionEvents(agent.session).some(event=>event.type==='user/message'&&event.data.content.some(part=>part.type==='image')),
   recordRecovery:recovery=>recordTaskModelRecovery(ctx,agent,run.id,recovery),
  },recovered)
  state.dispose=()=>{state.routing.dispose();installed.delete(agent)}
  installed.set(agent,state)
  agent.ctx.effect(()=>state.dispose)
  return state
 }
}
