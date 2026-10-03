import {isDeepStrictEqual} from 'node:util'
import {readRunKnowledge,readRunSkills,TaskRunPresetError} from '@teloa/backend'
import {resolveDshRoleSkills} from './role-skills-dsh.ts'
import type {Context} from '@deepseek-ai/cordis'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import type {WorkspaceId} from '@deepseek-ai/dsh-workspace'
import type {RunGroupFile,TaskExecutionScope,TaskRun,TaskRunSkillDatabase} from '@teloa/backend'
import type {TaskRunRuntimeLinks} from '@teloa/backend'
import {WorkError,groupAttachmentImageMediaTypes,groupPromptImageBytes,groupPromptImageCount} from '@teloa/contract'
import {observeTaskRun,settledStopSeq,type StopFreeze} from './task-run-observation.ts'
import {createTaskRunBackground,taskRunRuntimeId} from './task-run-background.ts'
import type {TaskRunPorts} from './task-run-driver.ts'
import type {ManagedRunSkillResolver} from './managed-run-skills.ts'
import type {ReadManagedSkillAvailability} from './role-skills-dsh.ts'
import {readSessionEvents} from './session-events.ts'
import {readModelVision,visionAllowsImages,type ModelVision} from './model-vision.ts'
import {selfAuthorizedToolNames} from './self-authorized-tools.ts'
import {skillHttpGrantedSkills,skillHttpToolName} from './skill-http-tool.ts'
import {skillSecretHint} from './skill-secret-hint.ts'
import type {ResolvedSkillSecrets} from './skill-secrets.ts'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {createNativeWorkInput} from './native-work-input.ts'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'
import {createTaskModelRouting,resolveTaskModelPolicy} from './task-model-dsh.ts'
import type {ModelReference} from '@teloa/contract'
import {readNativeReassignmentInspection,withNativeResourceInspection,type NativeAbortInspection,type NativeResourceFacts} from './business-reassignment-native.ts'

export type DshTaskNativeInput=Pick<ReturnType<typeof createNativeWorkInput>,'withNewInput'>

export type ExactManagedSkillLoader=(sessionId:string,installationIds:readonly string[],signal:AbortSignal,database?:TaskRunSkillDatabase)=>Promise<TaskRun['skills']>

/** 送进 `sessionController.prompt` 的图片部件；形状与上游 `PromptContentPart` 的 image 分支逐字一致。 */
type PromptImageMediaType=typeof groupAttachmentImageMediaTypes[number]
type PromptImagePart={type:'image';mediaType:PromptImageMediaType;data:string;name:string}
type PromptTextPart={type:'text';text:string}

export type GroupPromptPorts={
 /** 已落盘附件的图片字节读口（T1 的窄端口）。 */
 readAttachmentImageBytes:(ref:{attachmentId:string;mediaType:string;bytes:number;width:number;height:number})=>Promise<Uint8Array>
 /** 成果图片只按本人、固定版本和 Run 快照事实回读，不经过附件仓。 */
 readArtifactImageBytes:(ref:{artifactId:string;version:number;sha256:string;mediaType:string;bytes:number;name:string})=>Promise<Uint8Array>
 /** 本轮图片没能交给模型时登记一次；回帖由发布器前置固定文案，模型自陈不可信。 */
 markNoVision:(sessionId:string,nativeRequestId:string)=>void
}
export type DshTaskRunPorts=TaskRunPorts&{groupPrompt?:GroupPromptPorts;ensureModels:(agent:Agent,run:TaskRun)=>void;reassignmentInspection:(run:Pick<TaskRun,'id'|'taskId'|'sessionId'|'nativeRequestId'>,signal:AbortSignal)=>Promise<NativeAbortInspection>;withReassignmentInspection:<T>(run:Pick<TaskRun,'id'|'taskId'|'sessionId'|'nativeRequestId'>,signal:AbortSignal,work:(inspection:NativeAbortInspection,resources:NativeResourceFacts|undefined,signal:AbortSignal)=>Promise<T>)=>Promise<T>}
/** 按 Run 快照里的 roleId 补读岗位自身范围的窄端口；找不到岗位回 undefined，由调用方退回任务范围。 */
export type ReadRoleScopes=(owner:string,roleId:string,signal:AbortSignal)=>Promise<readonly string[]|undefined>

/**
 * `attachment` 与 `artifact` 中 mime 在图片白名单里的引用能进 image part：
 * GIF 落 `image/gif`、SVG/HTML 落 `application/octet-stream`，都天然被这条挡在外面（编排者裁定 1）；
 * 张数与合计字节都按引用顺序取前缀，超出的算「未进模型」，不跳过大图去凑后面的小图。
 */
export function pickPromptImages(files:readonly RunGroupFile[]):{picked:RunGroupFile[];skipped:number}{
 const eligible=files.filter(file=>(groupAttachmentImageMediaTypes as readonly string[]).includes(file.mime))
 const picked:RunGroupFile[]=[]
 let total=0
 for(const file of eligible){
  if(picked.length>=groupPromptImageCount||total+file.bytes>groupPromptImageBytes)break
  picked.push(file);total+=file.bytes
 }
 return {picked,skipped:eligible.length-picked.length}
}

/**
 * 运行正文之后附一个只含本机日期与时区名的 text 部件（DSH 系统提示与 Teloa 的任务载荷都不带日期，模型只能把「分诊时间」
 * 「最后核对」留空）。只到「日」、不到时分秒：日内多次运行共用同一段前缀，不破坏提示缓存；
 * 时区名给出来是让模型知道这个日期按谁的当地时间算。
 */
export function runDateLine(now=new Date()):string{
 const timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone
 const date=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now)
 return `本次运行日期：${date}（时区 ${timeZone}）`
}

const browserToolPrefix='mcp__playwright-mcp__',browserCloseTool=browserToolPrefix+'browser_close'
/**
 * 发送前用 DSH 公开的 `tools.restrict` 把本次运行没授权的全局工具从该会话的工具列表里拿掉：从前守卫只在
 * 模型真调用时拒绝，工具仍摆在列表里，模型会先试 skill/bash/write 各一两次再转正文，每次白花数秒。
 * 保留三类名字：授权清单、自授权工具（守卫对它们不看清单）、授权了浏览器时的 browser_close（停止后的
 * 浏览器收尾由宿主自己调用它）。`allow` 只列当前可见的名字——restrict 对未知名会抛；`run_code` 是保留传输名，
 * 不能出现在过滤里。这只是收窄可见面，`registerTaskToolGuard` 仍是最终闸；运行会话专用一次，限制随 agent 生命周期走。
 * 回的是撤掉这次收窄的 disposer：只在请求确定没交给原生时由发送方调用（见 `send`）。
 */
export function restrictRunTools(agent:Pick<Agent,'ctx'>,allowedTools:readonly string[]):()=>void{
 const keep=new Set<string>([...allowedTools,...selfAuthorizedToolNames])
 if(allowedTools.some(name=>name.startsWith(browserToolPrefix)))keep.add(browserCloseTool)
 const visible=agent.ctx.tools.schemas(agent).map(schema=>schema.name)
 return agent.ctx.tools.restrict({allow:visible.filter(name=>name!=='run_code'&&keep.has(name))})
}

/**
 * 任务会话的代发调用提示（规格 2026-09-27 §5.3）：任务会话不开放 `skill` 工具，加载提示不会出现，改由发送时追加一个 text 部件。
 * 只在本次运行授权了 teloa_skill_http 时，对运行快照里「本人已勾选、受管安装且目录声明了密钥」的技能逐条输出 `skillSecretHint`；
 * 部件不进 `inputText`，历史运行输入的逐字核对不受影响。
 */
export async function skillHttpRunHint(run:Pick<TaskRun,'allowedTools'|'skills'|'argumentRules'>,declared:(skill:string)=>Promise<ResolvedSkillSecrets|undefined>):Promise<string|undefined>{
 if(!run.allowedTools?.includes(skillHttpToolName))return undefined
 const granted=skillHttpGrantedSkills(run.argumentRules),hints:string[]=[]
 for(const skill of run.skills??[]){
  if(skill.provider!=='teloa-market'||!skill.managed||!granted.includes(skill.name))continue
  const resolved=await declared(skill.name)
  if(resolved?.secrets.length)hints.push(skillSecretHint(skill.name,resolved.secrets,resolved.httpGuide))
 }
 return hints.length?hints.join('\n'):undefined
}

/** 上游在图片被拒时给的码；只用来选「去图重发」这条路，不进任何回包。 */
const attachmentInvalidCode='session/attachment-invalid'
const rejectedImages=(error:unknown):boolean=>typeof error==='object'&&error!==null&&'code' in error&&(error as {code:unknown}).code===attachmentInvalidCode

/**
 * 能力事实只从 `ctx.llm.resolveModelInfo` 取（`modelCatalog`／`agentPresets` 都不带 `inputModalities`）。
 * provider/model 先取该会话已发请求的固定头，缺了才回落部署默认值；任何一步读不出来都按 `'unknown'`。
 */
async function readRunModelVision(ctx:Context,sessionId:string,signal:AbortSignal,fixed?:ModelReference):Promise<ModelVision>{
 try{
  const resolved=await ctx.sessionController.resolveAgent(brandString<SessionId>(sessionId))
  const header='error' in resolved?undefined:resolved.agent.session.requestHeader()?.config
  const selection=fixed??header??(await ctx.sessionController.modelCatalog()).default
  if(typeof selection?.provider!=='string'||typeof selection.model!=='string')return 'unknown'
  return readModelVision(await ctx.llm.resolveModelInfo(selection.provider,selection.model,signal))
 }catch{return 'unknown'}
}

/**
 * 普通会话仍是 general；仅服务端核验后的任务关联可以提供执行知识范围。
 * 通用范围（`general`）任务里读**岗位自己声明的知识**时并上岗位自身范围（编排者裁定 2026-09-21，
 * 承接「通用群对所有员工开放」）：general 不绑业务数据，岗位知识本就是岗位范围内已获准的资料，
 * 在通用任务里读同样只是读自己的东西，没有跨范围放大。业务范围任务一字不变，仍只有 `[target.scope]`。
 * 这里要的是范围**集合**而不是判据，所以不用契约的 `roleSupportsScope`，保持独立小函数。
 */
export function taskKnowledgeAuthorization(ownerId:string,target:TaskExecutionScope,roleScopes?:readonly string[]){
 // 资源主体范围有上限（契约 `resourceScopes`：≤16 条、每条 ≤64 字符），岗位 scopes 上限却是 30 条：并集越界时
 // 退回 `[target.scope]`——最坏也只是改前的行为，不能让「岗位声明得多」把通用任务从能跑变成 forbidden。
 const union=target.scope==='general'&&roleScopes?.length?[...new Set(['general',...roleScopes])]:[target.scope]
 const scopeIds=union.length>16||union.some(scope=>scope.length>64)?[target.scope]:union
 return {actor:{ownerId,kind:'agent' as const,scopeIds:[...scopeIds]},targetScopes:[...scopeIds]}
}

export async function resolveDshTaskPreset(ctx:Context,agentPresetId:string|undefined,signal:AbortSignal):Promise<string>{
 signal.throwIfAborted()
 try{const preset=await ctx.agentPresets.resolve(agentPresetId);if(preset.broken!==undefined)throw Error('broken');signal.throwIfAborted();return preset.id}
 catch{signal.throwIfAborted();throw new TaskRunPresetError('teloa/preset-unavailable','preset-resolve',agentPresetId===undefined?'无法解析当前默认运行配置。':'员工运行配置不存在或不可组合。')}
}

export async function prepareDshTaskSession(ctx:Context,sessionId:string,agentPresetId:string|undefined,signal:AbortSignal,workspaceId?:WorkspaceId):Promise<string>{
 const fixedPresetId=await resolveDshTaskPreset(ctx,agentPresetId,signal)
 let receipt:{sessionId:string;agentPreset?:string}
 try{receipt=await ctx.sessionController.create({sessionId:brandString<SessionId>(sessionId),agentPreset:fixedPresetId,...(workspaceId===undefined?{}:{workspaceId})})}
 catch{
  let actualPreset:string|undefined
  try{const actual=await ctx.sessionController.inspect(brandString<SessionId>(sessionId),signal);if(typeof actual.meta.agentPreset==='string'&&/^[-a-z0-9]+$/.test(actual.meta.agentPreset))actualPreset=actual.meta.agentPreset}catch{}
  throw new TaskRunPresetError('teloa/preset-unavailable','session-create','运行配置不存在、不可组合或原生会话暂不可用。',actualPreset)
 }
 const actualReceipt=typeof receipt.agentPreset==='string'&&/^[-a-z0-9]+$/.test(receipt.agentPreset)?receipt.agentPreset:undefined
 if(receipt.sessionId!==sessionId||receipt.agentPreset!==fixedPresetId)throw new TaskRunPresetError('teloa/preset-unavailable','session-receipt','原生会话创建回执与固定运行配置不一致。',actualReceipt)
 signal.throwIfAborted()
 let actual:{meta:{id?:string;agentPreset?:string}}
 try{actual=await ctx.sessionController.inspect(brandString<SessionId>(sessionId),signal)}catch{throw new TaskRunPresetError('teloa/preset-unavailable','session-inspect','无法读取原生会话运行配置。')}
 const actualPreset=typeof actual.meta.agentPreset==='string'&&/^[-a-z0-9]+$/.test(actual.meta.agentPreset)?actual.meta.agentPreset:undefined
 if(actual.meta.id!==sessionId||actual.meta.agentPreset!==fixedPresetId)throw new TaskRunPresetError('teloa/preset-unavailable','session-inspect','原生会话实际运行配置与固定快照不一致。',actualPreset)
 return fixedPresetId
}

/** 公开 SessionController 解析身份；有固定模型时经附件准入 + Agent 队列发送，SessionStore 落盘。 */
export function dshTaskRunPorts(ctx:Context,owner:string,inspect:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:string}>,loadKnowledge?:TaskRunPorts['loadKnowledge'],resolveManaged?:ManagedRunSkillResolver,readManagedAvailability?:ReadManagedSkillAvailability,ensureRunSkills?:(run:TaskRun,signal:AbortSignal)=>Promise<void>,loadExactManaged?:ExactManagedSkillLoader,readRoleScopes?:ReadRoleScopes,runtimeLinks?:TaskRunRuntimeLinks,prepareModel?:Parameters<typeof createTaskModelRouting>[1],declaredSkillSecrets?:(skill:string)=>Promise<ResolvedSkillSecrets|undefined>,nativeInput?:DshTaskNativeInput):DshTaskRunPorts{
 const store=Reflect.get(ctx,'sessions') as unknown as SessionStore
 const ensureModels=createTaskModelRouting(ctx,prepareModel)
 if(Reflect.get(ctx,'jobs')&&!runtimeLinks)throw new WorkError('teloa/dependency-unavailable','后台工作关联存储未配置。')
 const background=runtimeLinks?createTaskRunBackground(ctx,runtimeLinks):undefined
 if(background)ctx.effect(()=>background.dispose)
 // 停止后日志 seq 的冻结计时。只为「已请求停止」的记录建条目，收口或恢复运行即清除。
 const stopFreeze=new Map<string,StopFreeze>()
 // 只串行同一固定请求的本地模型代发；结束即释放，不保存另一份受理状态。
 const sending=new Map<string,Promise<void>>()
 const serialize=async(key:string,operation:()=>Promise<void>)=>{
  const previous=sending.get(key)
  let release!:()=>void
  const pending=new Promise<void>(done=>{release=done})
  sending.set(key,pending)
  try{await previous;await operation()}finally{release();if(sending.get(key)===pending)sending.delete(key)}
 }
 // 与 rc.2 Controller.prompt 的三处可信回执判定一致；插件来源不能冒充用户请求。
 const accepted=(agent:Agent,requestId:string)=>{
  const matches=(message:{source:{kind:string}})=>message.source.kind==='user'&&'rpcId' in message.source&&Reflect.get(message.source,'rpcId')===requestId
  return agent.inbox.nextTurn.some(matches)||agent.inbox.nextStep.some(matches)||readSessionEvents(agent.session).some(event=>event.type==='user/message'&&(!nativeInput||agent.session.isOwnSeq(event.seq))&&matches(event.data))
 }
 const validateTarget=(run:Pick<TaskRun,'sessionId'>&Partial<Pick<TaskRun,'taskId'|'taskVersion'|'linkVersion'>>,target:TaskExecutionScope)=>{
  if(run.taskId!==target.taskId||run.sessionId!==target.sessionId)throw new WorkError('teloa/forbidden','执行任务或会话关联身份不匹配。')
  if(run.taskVersion!==target.taskVersion||run.linkVersion!==target.linkVersion)throw new WorkError('teloa/version-conflict','执行任务或会话关联版本已变化。')
 }
 const validateBinding=async(run:Pick<TaskRun,'sessionId'>)=>{
  const binding=await inspect(run.sessionId)
  if(binding.ownerId!==owner||binding.sessionId!==run.sessionId||binding.status!=='ready')throw new WorkError('teloa/forbidden','执行会话身份未就绪。')
 }
 const resolve=async(run:Pick<TaskRun,'sessionId'>)=>{
  await validateBinding(run)
  const resolved=await ctx.sessionController.resolveAgent(brandString<SessionId>(run.sessionId))
  if('error' in resolved)throw new WorkError('teloa/session-unavailable','执行会话暂不可用。')
  return resolved.agent
 }
 const exactManaged=async(sessionId:string,installationIds:readonly string[],signal:AbortSignal,database?:TaskRunSkillDatabase)=>{
  if(!installationIds.length)return []
  if(!loadExactManaged)throw new WorkError('teloa/skill-unavailable','受管技能精确版本执行能力未配置。')
  return readRunSkills(await loadExactManaged(sessionId,installationIds,signal,database))
 }
 const loadSkills=async(sessionId:string,names:readonly string[],signal:AbortSignal,database?:TaskRunSkillDatabase,industryInstallationIds:readonly string[]=[])=>{
  const ordinary=names.length?await resolveDshRoleSkills(ctx,owner,sessionId,names,inspect,signal,resolveManaged,database,readManagedAvailability):[]
  signal.throwIfAborted()
  return readRunSkills([...ordinary,...await exactManaged(sessionId,industryInstallationIds,signal,database)])
 }
 const reloadSkills=async(run:Pick<TaskRun,'sessionId'|'skills'>,signal:AbortSignal)=>{
  const expected=readRunSkills(run.skills),ordinaryNames=expected.filter(skill=>!skill.managed).map(skill=>skill.name),installationIds=expected.flatMap(skill=>skill.managed?[skill.managed.installationId]:[])
  const ordinary=ordinaryNames.length?await resolveDshRoleSkills(ctx,owner,run.sessionId,ordinaryNames,inspect,signal,resolveManaged,undefined,readManagedAvailability):[]
  signal.throwIfAborted()
  const managed=await exactManaged(run.sessionId,installationIds,signal)
  const ordinaryByName=new Map(ordinary.map(skill=>[skill.name,skill])),managedById=new Map(managed.flatMap(skill=>skill.managed?[[skill.managed.installationId,skill] as const]:[]))
  if(ordinary.length!==ordinaryNames.length||ordinaryByName.size!==ordinary.length||ordinaryNames.some(name=>!ordinaryByName.has(name))||managed.length!==installationIds.length||managedById.size!==managed.length||installationIds.some(id=>!managedById.has(id)))throw new WorkError('teloa/version-conflict','员工技能已变化，请重新核对执行准备。')
  return readRunSkills(expected.map(skill=>skill.managed?managedById.get(skill.managed.installationId):ordinaryByName.get(skill.name)))
 }
 const resolvePreset=async(agentPresetId:string|undefined,signal:AbortSignal)=>{
  if(agentPresetId==='cordis')throw new TaskRunPresetError('teloa/preset-unavailable','preset-resolve','创造模式仅供本人会话使用，不能用于员工运行。')
  const resolved=await resolveDshTaskPreset(ctx,agentPresetId,signal)
  if(resolved!=='cordis')return resolved
  if(agentPresetId!==undefined)throw new TaskRunPresetError('teloa/preset-unavailable','preset-resolve','创造模式仅供本人会话使用，不能用于员工运行。')
  return resolveDshTaskPreset(ctx,'teloa-standard',signal)
 }
 const prepareSession=async(sessionId:string,agentPresetId:string|undefined,signal:AbortSignal)=>prepareDshTaskSession(ctx,sessionId,await resolvePreset(agentPresetId,signal),signal)
 const checkAgent=async(run:Pick<TaskRun,'sessionId'>&Partial<Pick<TaskRun,'id'|'modelPolicy'|'taskId'|'taskVersion'|'linkVersion'|'agentPresetId'|'roleId'|'skills'|'knowledge'|'inputText'>>,signal:AbortSignal,target?:TaskExecutionScope,resolved?:Agent)=>{
  if(target)validateTarget(run,target)
  signal.throwIfAborted();const agent=resolved??await resolve(run);signal.throwIfAborted()
  if(run.agentPresetId==='cordis'||agent.session.header?.agentPreset==='cordis')throw new WorkError('teloa/forbidden','创造模式仅供本人会话使用，不能用于员工运行。')
  if(run.agentPresetId!==undefined&&agent.session.header.agentPreset!==run.agentPresetId)throw new WorkError('teloa/version-conflict','原生会话运行配置与本次执行快照不一致。')
  if(run.knowledge?.length){
   if(!loadKnowledge||!target)throw new WorkError('teloa/conflict','知识资料读取缺少可信任务关联。')
   // 复核必须和运行准备读到同一份资料：通用范围任务里主体范围要并上岗位自身范围，否则准备得起来的
   // 运行会在这里（start 前与 send 前各一次）被判 forbidden。`TaskRun` 快照只带 roleId，岗位范围
   // 经窄读口补齐；读不到岗位就不传，退回 `[target.scope]`（编排者裁定 2026-09-21）。
   // 只有通用范围任务才需要岗位范围（业务范围任务下游一律丢弃），别让每条业务任务都白读一次岗位表。
   // `run.knowledge` 里混着任务材料 id：材料在准备时已按任务范围固定，这里放大不会引入新资源，只影响错误码归类。
   const roleScopes=target.scope==='general'&&run.roleId!==undefined?await readRoleScopes?.(owner,run.roleId,signal):undefined
   signal.throwIfAborted()
   const current=readRunKnowledge(await loadKnowledge(target,run.knowledge.map(item=>item.id),signal,roleScopes))
   if(JSON.stringify(current)!==JSON.stringify(run.knowledge))throw new WorkError('teloa/version-conflict','员工知识资料已变化，请撤销后重新准备。')
  }
  if(run.skills?.length){
   const current=await reloadSkills({sessionId:run.sessionId,skills:run.skills},signal)
   if(JSON.stringify(current)!==JSON.stringify(run.skills))throw new WorkError('teloa/version-conflict','员工技能已变化，请重新核对执行准备。')
  }
  if(agent.status!=='idle'||(agent.inbox.nextTurn.length>0||agent.inbox.nextStep.length>0)||readSessionEvents(agent.session).some(event=>event.type==='turn/start'||event.type==='user/message'))throw new WorkError('teloa/conflict','请为本次执行创建新的空闲会话，不能占用已有对话。')
  return agent
 }
 const ports:DshTaskRunPorts={
  resolvePreset,
  prepareSession,
  ensureModels:(agent,run)=>{ensureModels(agent,run)},
  prepareModels:(runtime,signal)=>resolveTaskModelPolicy(ctx,runtime,signal),
  check:async(run,signal,target)=>{
   const agent=await checkAgent(run,signal,target)
   if(run.modelPolicy&&run.id){
    try{await ensureModels(agent,{id:run.id,sessionId:run.sessionId,modelPolicy:run.modelPolicy})?.routing.resolve(signal)}catch{signal.throwIfAborted();throw new TaskRunPresetError('teloa/preset-unavailable','model-resolve','任务模型暂不可用，请核对模型配置后重试。')}
   }
  },
  ...(loadKnowledge?{loadKnowledge}:{}),
  loadSkills,
  send:async(input,signal,inputTarget)=>{
   if(!inputTarget)throw new WorkError('teloa/conflict','执行发送缺少可信任务关联。')
   // 服务端 Run 快照在第一次 await 前复制，等待许可不能移植请求或任务关联身份。
   const run=Object.freeze(structuredClone(input)),target=Object.freeze(structuredClone(inputTarget))
   if(typeof run.nativeRequestId!=='string'||!run.nativeRequestId)throw new WorkError('teloa/forbidden','执行请求身份未就绪。')
   const context=Object.freeze({producer:'task-run' as const,identity:JSON.stringify([owner,run.id,run.taskId,run.taskVersion,run.linkVersion,run.sessionId,run.nativeRequestId])})
   const operation=async()=>{
    validateTarget(run,target)
    signal.throwIfAborted()
    // 排队或历史中同 rpcId 已受理时只回原回执，不读新附件或重新申请工作许可。
    const agent=await resolve(run)
    signal.throwIfAborted()
    const session=agent.session
    if(nativeInput&&(agent.id!==run.sessionId||session.id!==run.sessionId||ctx.agents.get(agent.id)!==agent||store.get(agent.id)!==session))throw new WorkError('teloa/forbidden','执行会话与固定请求身份不一致。')
    if(accepted(agent,run.nativeRequestId))return
    // 收窄与发送都用核对过的那一个 agent，不再另解析一次。
    await checkAgent(run,signal,target,agent)
    await ensureRunSkills?.(run,signal)
    signal.throwIfAborted()
    await background?.start(run)
    // 测试替身的 agent 可能没有 ctx；真实 Agent 一定有。收窄失败原样上抛，不让「看起来能跑」掩盖装配问题。
    const lift=agent.ctx?restrictRunTools(agent,run.allowedTools):undefined
    const modelState=ensureModels(agent,run),routing=modelState?.routing
    // 请求确定没交给原生就失败（取消、读图失败等）时撤掉收窄，会话不带着这次运行的限制留下；
    // 一旦调到 prompt，原生可能已接下这一轮（上层按「需核对、不重发」处理），收窄必须保留。
    let handedOff=false
    const request={sessionId:brandString<SessionId>(run.sessionId),requestId:brandString<SessionRequestId>(run.nativeRequestId),mode:'queue' as const}
    const prompt=async(content:(PromptTextPart|PromptImagePart)[])=>{
     if(!routing){handedOff=true;return ctx.sessionController.prompt({...request,content},signal)}
     // rc.2 Controller.prompt 按全局默认的会话缓存做模型/图片准入，且没有局部选模参数。
     // Run 独占空会话且载荷只有可信文字/已授权图片；复用官方附件准入与 Agent 队列，不复制 loop。
     // 纯文本也必须经过同一准入：凭据防泄漏闸挂在此公开接口上。
     const admitted=await ctx.attachments.admitPromptContent(content)
     signal.throwIfAborted()
     const ready=()=>{
      signal.throwIfAborted()
      if(ctx.agents.get(agent.id)!==agent||agent.session!==session||agent.status!=='idle'||agent.inbox.nextTurn.length||agent.inbox.nextStep.length||readSessionEvents(session).some(event=>event.type==='turn/start'||event.type==='user/message'))throw new WorkError('teloa/conflict','执行会话在发送前已变化，请核对原运行。')
     }
     ready()
     const message=createUserMessage({source:{kind:'user',rpcId:run.nativeRequestId},content:admitted})
     const submit=()=>{
      ready()
      const startSeq=session.seq
      let committed=false
      try{agent.followup(message)}catch(error){
       // 官方 append 后的通知派发仍可抛错；只认本次目标的 own 新事件及完整候选。
       try{committed=readSessionEvents(session).some(event=>event.seq>=startSeq&&session.isOwnSeq(event.seq)&&event.type==='agent/inbox/spliced'&&event.data.target==='next-turn'&&event.data.inserted.some(input=>isDeepStrictEqual(input,message)))}catch{}
       if(!committed)throw error
       // 此回执只确认已受理；官方 append 与 wakeDriver 非原子，不补唤醒或再次投递。
      }finally{handedOff=committed||accepted(agent,run.nativeRequestId)}
     }
     if(nativeInput)await nativeInput.withNewInput(agent,message,context,submit,signal)
     else submit()
     return {accepted:true as const}
    }
    try{
     signal.throwIfAborted()
     // 日期单独一个 text 部件：固定输入是后端冻结的 JSON 快照，往正文里追加会让它不再可整段解析。
     const dateLine:PromptTextPart={type:'text',text:runDateLine()}
     // 代发提示读取失败只降级为不带提示（与技能加载提示同一口径），不阻断本次发送；警告只记错误类别。
     const hint=declaredSkillSecrets?await skillHttpRunHint(run,declaredSkillSecrets).catch((error:unknown)=>{ctx.logger.warn(JSON.stringify({event:'skill-secret.hint-skipped',runId:run.id,error:error instanceof Error?error.name:'Error'}));return undefined}):undefined
     signal.throwIfAborted()
     const hintParts:PromptTextPart[]=hint?[{type:'text',text:hint}]:[]
     const textOnly:PromptTextPart[]=[{type:'text',text:run.inputText},...hintParts,dateLine]
     await routing?.resolve(signal)
     const group=ports.groupPrompt
     const {picked,skipped}=group?pickPromptImages(run.groupContext?.files??[]):{picked:[],skipped:0}
     // 没有可进模型的图片就走从前那条路：普通运行不因本期改动多一次能力查询。
     if(!group||!picked.length){await prompt(textOnly);return}
     const vision=await readRunModelVision(ctx,run.sessionId,signal,routing?.current())
     signal.throwIfAborted()
     // 明确声明没有视觉能力时一张都不发；无视觉那句由宿主在回帖时前置，不让模型自己交代。
     if(!visionAllowsImages(vision)&&vision!=='unknown'){
      group.markNoVision(run.sessionId,run.nativeRequestId)
      await prompt(textOnly);return
     }
     const images:PromptImagePart[]=[]
     for(const file of picked){
      const bytes=file.kind==='attachment'
       ?await group.readAttachmentImageBytes({attachmentId:file.id,mediaType:file.mime,bytes:file.bytes,width:file.width??0,height:file.height??0})
       :await group.readArtifactImageBytes({artifactId:file.id,version:file.version,sha256:file.sha256,mediaType:file.mime,bytes:file.bytes,name:file.name})
      signal.throwIfAborted()
      // mime 已被 pickPromptImages 按白名单收窄；这里只是把它落回字面量联合，不做任何放宽。
      images.push({type:'image',mediaType:file.mime as PromptImageMediaType,data:Buffer.from(bytes).toString('base64'),name:file.name})
     }
     const text=skipped?`${run.inputText}\n\n本轮还有 ${skipped} 张已授权图片未进模型。`:run.inputText
     if(modelState)modelState.imagesAdmitted=true
     try{await prompt([{type:'text',text},...hintParts,dateLine,...images])}
     catch(error){
      // 能力查不到时可用性优先：先发图，被原生以 session/attachment-invalid 拒了再去图重发。
      // 声明支持却被拒是另一回事，原样上抛，不掩盖不一致。
      if(vision!=='unknown'||!rejectedImages(error))throw error
      group.markNoVision(run.sessionId,run.nativeRequestId)
      if(modelState)modelState.imagesAdmitted=false
      await prompt(textOnly)
     }
    }catch(error){if(!handedOff){lift?.();modelState?.dispose()}throw error}
   }
   if(run.modelPolicy)await serialize(JSON.stringify([run.sessionId,run.nativeRequestId]),operation)
   else await operation()
  },
  stop:async(run,signal)=>{
   signal.throwIfAborted()
   const agent=await resolve(run)
   signal.throwIfAborted()
   await background?.cancel(run,signal)
   const events=readSessionEvents(agent.session),observed=observeTaskRun(events,run.nativeRequestId,await ports.continuations?.(run,readSessionEvents(agent.session)))
   if(observed.state==='ended')return
   if(observed.state!=='active'||(agent.inbox.nextTurn.length>0||agent.inbox.nextStep.length>0))throw new WorkError('teloa/conflict','尚未确认原请求正在执行，或会话仍有排队消息，请先核对执行会话。')
   let turnStart=0
   for(let index=0;index<events.length;index++)if(events[index]!.type==='turn/start')turnStart=index
   const mixed=events.slice(turnStart).some(event=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user'&&event.seq!==observed.messageSeq)
   if(mixed)throw new WorkError('teloa/conflict','本轮已混入其他请求，请在原生会话中处理。')
   // 日志上轮次未闭合 ≠ agent 真有活跃活动。上游契约写明：无活跃活动时取消是 no-op，
   // 也不会为后续工作预置取消——那样的"成功"只会伪装成已停止，所以这里回一个可分辨的冲突。
   if(agent.status!=='running')throw new WorkError('teloa/conflict','这次执行已经没有在跑的动作，等待原生收口。')
   // cancel 是同步方法；身份判定与取消之间不让出执行权，防止误停后续轮次。
   // 回执只承诺"请求已递交"（收敛要等原生到达静止），保留它是为了让这次递交有据可查。
   const receipt=ctx.sessionController.cancel({sessionId:brandString<SessionId>(run.sessionId)})
   if(!receipt.accepted)throw new WorkError('teloa/conflict','原生会话没有接受这次停止请求，请在原生会话中核对。')
  },
  // 宿主的 running 一直是现成可读的，只是从前没人消费。这里把它连同日志 seq 的冻结判定
  // 一起交给上层：running 供有界重发判断「还值不值得再喊一次停」，settledSeq 供 reconcile 收口。
  stopState:async run=>{
   const agent=await resolve(run),running=(await background?.state(run))?.outstanding??agent.status==='running'
   return {running,settledSeq:settledStopSeq(stopFreeze,run.id,running,readSessionEvents(agent.session).length-1,Date.now())}
  },
  ...(background?{backgroundState:async(run:TaskRun)=>{await validateBinding(run);return background.state(run)}}:{}),
  reassignmentInspection:async(run,signal)=>readNativeReassignmentInspection({get:id=>store.get(brandString<SessionId>(id)),flush:session=>store.flush(session),inspect:id=>ctx.sessionController.inspect(brandString<SessionId>(id))},run,signal),
  withReassignmentInspection:async(run,signal,work)=>withNativeResourceInspection(ctx.agents.get(brandString<SessionId>(run.sessionId)),{get:id=>store.get(brandString<SessionId>(id)),flush:session=>store.flush(session),inspect:id=>ctx.sessionController.inspect(brandString<SessionId>(id))},run,runtimeLinks,taskRunRuntimeId,Reflect.get(ctx,'jobs'),signal,work),
  events:async run=>{
   await validateBinding(run)
   const attached=store.get(brandString<SessionId>(run.sessionId))
   if(attached){
    const snapshot=readSessionEvents(attached)
    if(!await store.flush(attached))throw new WorkError('teloa/session-unavailable','执行日志尚无持久化提供方，不能确认结果。')
    return snapshot
   }
   // RC.1 的公开 inspect 可冷读持久完整日志，不恢复 Agent 或触发新一轮。
   const snapshot=await ctx.sessionController.inspect(brandString<SessionId>(run.sessionId))
   if(snapshot.meta.id!==run.sessionId)throw new WorkError('teloa/forbidden','执行日志与固定会话身份不一致。')
   return [...snapshot.events]
  },
 }
 return ports
}
