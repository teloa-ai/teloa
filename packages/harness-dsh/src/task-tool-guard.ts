import {taskToolArgumentsAllowed,type TaskToolArgumentRule} from './task-tool-arguments.ts'
import type {Context} from '@deepseek-ai/cordis'
import type {PreToolDecision,ToolDefinition,ToolExecution} from '@deepseek-ai/dsh-tools'
import {isNativeToolName,nativeToolCallIssue,nativeToolNeedsApproval} from './native-tool-access.ts'
import {observeTaskRunTimeline} from './task-run-observation.ts'
import {readSessionEvents} from './session-events.ts'
import {resolveSessionLineage} from './subagent-lineage.ts'
import type {SubagentDelegationPorts} from './subagent-delegation.ts'
import type {TaskRunTeamAccess} from './task-run-team.ts'
import type {TaskBrowserCleanupAccess} from './task-run-browser.ts'
import type {TaskRunOrchestrationAccess} from './task-run-orchestration.ts'
import {delegationToolAllowed,delegationTools,teamDelegationTools,externalEgressToolAllowed,externalEgressTools,mcpResourceToolAllowed,mcpResourceTools,orchestrationToolAllowed,orchestrationTools,subagentTaskToolName,type WebGatePolicy} from './role-tool-grants.ts'
import {WorkError,webAccessHost,webHostBlocked,type WebAccessKind} from '@teloa/contract'
import {skillHttpGrantedSkills,skillHttpToolName} from './skill-http-tool.ts'
import {workspaceFileToolNames,isWorkspaceFileRule} from '@teloa/contract'
import type {TaskRunWorkspaceFileAccess} from './workspace-file-access.ts'
import type {GoalObservationContext} from '@teloa/contract'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
export type TaskRunGoalObservationReader=(sessionId:string,events:readonly SessionEvent[])=>Promise<GoalObservationContext|undefined>

export type TaskToolPolicy={allowedTools:readonly string[];nativeRequestId?:string;argumentRules?:readonly TaskToolArgumentRule[];stopRequested?:boolean}
/** null 仅表示该会话不受任务执行管理；岗位暂停应返回空清单，不能降级为 null。 */
export type TaskToolPolicyReader=(sessionId:string,signal:AbortSignal)=>Promise<TaskToolPolicy|null>
/**
 * 本会话是否绑定了业务对象来源（SOC 告警等外部 HTTP 来源的固定快照）。
 * 绑定过就意味着外部正文可能已经逐字进入这条会话的 user turn。
 * 省略本读口，或读口抛出、判定不出来，一律按"绑定了"处理 —— 外发通道 fail-closed。
 */
export type TaskSessionBusinessBindingReader=(sessionId:string,signal:AbortSignal)=>Promise<boolean>
/** 上网闸的两个端口：策略读口与派发前的记录写口。缺省即「判不出来」，一律 fail-closed。 */
export type WebAccessGatePorts={
 policy:(signal:AbortSignal)=>Promise<{enabled:boolean;blocked:readonly string[]}>
 /** 返回 'no-run' 表示这条会话没有 Run 作用域（普通会话），按编排者裁定 4 放行且不记录。 */
 record:(sessionId:string,entry:{kind:WebAccessKind;value:string},signal:AbortSignal)=>Promise<'written'|'no-run'>
}

/** 复用 DSH 公开前置守卫，保留框架既有审批链；不凭工具名称前缀授予权限。 */
export function registerTaskToolGuard(ctx:Context,readPolicy:TaskToolPolicyReader,selfAuthorizedTools:readonly string[]=[],readBusinessBinding?:TaskSessionBusinessBindingReader,delegation?:SubagentDelegationPorts,webAccess?:WebAccessGatePorts,team?:TaskRunTeamAccess,browserCleanup?:TaskBrowserCleanupAccess,orchestration?:TaskRunOrchestrationAccess,workspaceFiles?:TaskRunWorkspaceFileAccess,goalObservation?:TaskRunGoalObservationReader){
 const selfAuthorized=new Set(selfAuthorizedTools)
 // 自授权分支在资源工具闸之前返回，装配期就堵死这条绕过路径，避免日后扩充自授权集时静默放开。
 if(mcpResourceTools.some(name=>selfAuthorized.has(name)))throw Error('自授权工具不能包含 MCP 资源工具。')
 // 同理：编排类工具（workflow/ralph/run_code）若混进自授权集，会绕过下面的显式拒绝闸。
 if(orchestrationTools.some(name=>selfAuthorized.has(name)))throw Error('自授权工具不能包含编排类工具。')
 if(selfAuthorized.has(subagentTaskToolName))throw Error('自授权工具不能包含执行态委派工具。')
 if(teamDelegationTools.some(name=>selfAuthorized.has(name)))throw Error('自授权工具不能包含 Team 委派工具。')
 // 同理：外发类工具（web_fetch/web_search）若混进自授权集，会绕过业务来源会话的外发闸。
 if(externalEgressTools.some(name=>selfAuthorized.has(name)))throw Error('自授权工具不能包含外发类工具。')
 if(selfAuthorizedTools.some(isNativeToolName))throw Error('自授权工具不能包含原生浏览器、电脑或后台工具。')
 // 技能代发只能由本人按岗位授予（规格 2026-09-27 §5.1）；AI 员工不能自授。
 if(selfAuthorized.has(skillHttpToolName))throw Error('自授权工具不能包含技能代发工具。')
 if(workspaceFileToolNames.some(name=>selfAuthorized.has(name)))throw Error('自授权工具不能包含工作目录文件工具。')
 const removeFileGuard=ctx.on('tools/execute',async(exec,next)=>{await workspaceFiles?.recheck(exec);return next()})
 // 官方 monotonic guard 在审批结束后执行：确认期间卸载、换 provider 或替换工具不能执行旧定义。
 const checkedNative=new WeakMap<ToolExecution,ToolDefinition>()
 const checkedCleanup=new WeakSet<ToolExecution>()
 const checkedOrchestration=new WeakMap<ToolExecution,{definition:ToolDefinition;rootId:string;policy:TaskToolPolicy|null}>()
 const removeNativeGuard=ctx.tools.guard(exec=>{
  const definition=checkedNative.get(exec)
  if(definition===undefined)return
  return (checkedCleanup.has(exec)?browserCleanup?.issue(exec):undefined)??nativeToolCallIssue(ctx,exec)??(ctx.tools.get(exec.name,exec.agent)!==definition?'原生工具已变更，请重新确认后再试。':undefined)
 })
 // 异步岗位复核必须位于确认之后、工具体之前；同步 monotonic guard 不能读取最新业务授权。
 const removeOrchestrationGuard=ctx.on('tools/execute',async(exec,next)=>{
  const checked=checkedOrchestration.get(exec)
  if(!checked)return next()
  exec.signal.throwIfAborted()
  if(ctx.tools.get(exec.name,exec.agent)!==checked.definition)throw Error('编排工具已变更，请重新确认后再试。')
  const policy=await readPolicy(checked.rootId,exec.signal)
  if(checked.policy===null?policy!==null:policy===null||policy.nativeRequestId!==checked.policy.nativeRequestId||policy.stopRequested||!policy.allowedTools.includes(exec.name))throw Error('本次编排授权已变化，请重新确认后再试。')
  if(policy?.argumentRules!==undefined&&!taskToolArgumentsAllowed(policy.argumentRules,exec.name,exec.arguments))throw Error('编排参数已超出本次任务授权。')
  exec.signal.throwIfAborted()
  return next()
 })
 const removePreExecute=ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!exec.agent)return next()
  if(exec.signal.aborted)return {kind:'deny',reason:'本次工具调用已取消。'}
  let policy:TaskToolPolicy|null,policySessionId:string,lineage:{root:typeof exec.agent.session;depth:number},teamMember=false,orchestrationChild=false,cleanup=false
  let authorizationStage='lineage'
  try{
   // 谱系上溯与岗位记忆、Run Skill 作用域共用一份实现；抛错落到下面既有的 catch，仍回同一句固定理由。
   lineage=resolveSessionLineage(ctx,exec.agent.session)
   policySessionId=lineage.root.id
   authorizationStage='read-policy'
   policy=await readPolicy(policySessionId,exec.signal)
   authorizationStage='cleanup'
   cleanup=await browserCleanup?.consume(exec,policy)??false
   if(cleanup)checkedCleanup.add(exec)
   if(policy?.stopRequested===true&&!cleanup)return {kind:'deny',reason:'本次执行已请求停止，不能继续调用工具。'}
   if(policy!==null&&(!Array.isArray(policy.allowedTools)||policy.allowedTools.some(name=>typeof name!=='string'||!name.trim())))throw Error('invalid policy')
   authorizationStage='team-membership'
   if(policy!==null&&Reflect.get(ctx,'agentTeams')?.tryMembership(exec.agent)?.role==='teammate'){
    // 收尾不是继续派发 Team：私有 receipt 和持久化关联已核对已登记 child，不能要求停止后仍有 spawn 授权。
    if(!cleanup&&(!team||!await team.authorizeMember(exec.agent,policy,exec.signal)))throw Error('unregistered teammate')
    teamMember=true
   }
   authorizationStage='orchestration'
   if(policy!==null&&!teamMember&&!cleanup&&orchestration)orchestrationChild=await orchestration.authorizeChild(exec.agent,policy,exec.signal)
   if(policy?.nativeRequestId!==undefined&&!cleanup){
    // 请求身份属于策略根会话；子级首条消息由驱动写入且没有 rpcId，拿它核对必然全拒。
    // 混入请求也只看同一份根会话事件，子级消息不参与；根调用方仍核对自己的会话。
    authorizationStage='session-events'
    const requestId=policy.nativeRequestId,events=readSessionEvents(lineage.root)
    const root=ctx.agents.get(lineage.root.id)
    authorizationStage='team-continuations'
    const continuations=root?await team?.continuations(root,requestId,events):undefined
    authorizationStage='goal-observation'
    const goal=await goalObservation?.(lineage.root.id,events)
    authorizationStage='turn-observation'
    const observed=observeTaskRunTimeline(events,requestId,continuations,undefined,goal)
    if(!teamMember&&!orchestrationChild&&observed.observation.state!=='active')return {kind:'deny',reason:'当前工具调用不属于获准执行的原生轮次。'}
    let start=events.length-1
    while(start>=0&&events[start]!.type!=='turn/start')start--
    const mixed=events.slice(start+1).some(event=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user'&&(!('rpcId' in event.data.source)||event.data.source.rpcId!==requestId))
    if(mixed)return {kind:'deny',reason:'本轮混入其他请求，请在独立执行会话中重试。'}
    if(!teamMember&&!orchestrationChild&&!observed.authorized)return {kind:'deny',reason:'当前工具调用不属于获准执行的原生轮次。'}
   }
  }catch(error){
   // 仅记录固定阶段和错误分类；原异常正文、工具参数及会话内容不进入日志。
   const code=error instanceof WorkError?error.code:error instanceof TypeError?'type-error':error instanceof SyntaxError?'syntax-error':'teloa/unavailable'
   ctx.logger.warn('Teloa 任务工具授权待核对：%s/%s',authorizationStage,code)
   return {kind:'deny',reason:'无法核对任务执行权限，请先恢复授权服务。'}
  }
  if(exec.signal.aborted)return {kind:'deny',reason:'本次工具调用已取消。'}
  if(policy!==null&&exec.name==='plugin_manager')return {kind:'deny',reason:'受管任务不能修改 Teloa 的扩展，请由本人在创造模式中操作。'}
  if(orchestrationChild&&orchestration?.ownsStructuredOutput(exec))return next()
  if(selfAuthorized.has(exec.name)){
   if(teamMember||orchestrationChild)return {kind:'deny',reason:'临时助手不能借用负责人的员工记忆或群身份，请通过团队消息交回结果。'}
   if(policy===null||policy.nativeRequestId===undefined)return {kind:'deny',reason:'当前会话没有可核验的运行工具授权。'}
   return next()
  }
  // 上游把 MCP 资源工具做成共享工具，普通会话也能看见；这条闸让它和其他工具一样只认岗位授权清单。
  if(!mcpResourceToolAllowed(policy===null?null:policy.allowedTools,exec.name))return {kind:'deny',reason:'MCP 资源工具未在员工执行范围内授权。'}
  // 本人会话可选官方能力；受管执行仍需显式岗位授权和子任务归属适配。
  if(!orchestrationToolAllowed(policy===null?null:policy.allowedTools,exec.name))return {kind:'deny',reason:'编排类工具未在员工执行范围内授权。'}
  if(policy!==null&&(exec.name==='workflow'||exec.name==='ralph')&&!orchestration)return {kind:'deny',reason:'本次执行未装配原生编排授权。'}
  // 委派会创建新的执行主体，执行态一次性拆分由同名 Teloa 工具在取得子会话身份后精确登记。
  if((delegationTools as readonly string[]).includes(exec.name)){
   if(policy!==null&&(teamDelegationTools as readonly string[]).includes(exec.name)&&team===undefined)return {kind:'deny',reason:'本次执行未装配受管 Team 授权。'}
   if(!delegationToolAllowed(policy===null?null:policy.allowedTools,exec.name))return {kind:'deny',reason:'当前会话不能使用此委派工具，请核对员工执行范围。'}
   if(exec.name===subagentTaskToolName){
    if(delegation===undefined)return {kind:'deny',reason:'无法核对本次子任务执行范围，请稍后重试。'}
    if(lineage.depth>=delegation.limits.maxDepth)return {kind:'deny',reason:'已达到本次任务允许的拆分层数上限。'}
   }
  }
  // 绑定了业务对象来源的会话里，外部告警正文已经逐字进过 user turn，而 web_fetch / web_search
  // 在上游没有任何审批钩子，是一条不经人确认的外发通道；判定不出来时按"绑定了"拒绝。
  if((externalEgressTools as readonly string[]).includes(exec.name)){
   let businessBound=true
   if(readBusinessBinding!==undefined){
    try{businessBound=await readBusinessBinding(policySessionId,exec.signal)}catch{businessBound=true}
   }
   if(exec.signal.aborted)return {kind:'deny',reason:'本次工具调用已取消。'}
   // 策略读不到就让 gate 为 undefined：externalEgressToolAllowed 会 fail-closed，理由回落到既有那一句。
   let gate:WebGatePolicy|undefined,entry:{kind:WebAccessKind;value:string}|undefined
   if(webAccess!==undefined){
    try{
     const policyRow=await webAccess.policy(exec.signal)
     const host=exec.name==='web_fetch'?webAccessHost((exec.arguments as Record<string,unknown>).url):null
     // web_search 没有目标域名，hostAllowed 恒真；web_fetch 解析不出主机名即判假（fail-closed，上游也会拒）。
     gate={enabled:policyRow.enabled,hostAllowed:exec.name!=='web_fetch'||(host!==null&&!webHostBlocked(policyRow.blocked,host))}
     // 原文整段交给写口：截断只由后端按**码点**做一次（`web-access.ts` 的 `truncate`）。
     // 这里再按 UTF-16 码元切一刀会从中间劈开代理对，把合法字符变成孤立的半个码点。
     entry=exec.name==='web_fetch'
      ?{kind:'fetch',value:String((exec.arguments as Record<string,unknown>).url)}
      :{kind:'search',value:JSON.stringify((exec.arguments as Record<string,unknown>).queries??null)}
    }catch{gate=undefined}
   }
   // ①②先出各自的固定理由；③兜住 gate===undefined 与授权不足，逐字回既有那一句。
   if(gate!==undefined&&!gate.enabled)return {kind:'deny',reason:'设置中已关闭网页搜索与读取。'}
   if(gate!==undefined&&exec.name==='web_fetch'&&!gate.hostAllowed)return {kind:'deny',reason:'目标网站在拦截名单里。'}
   if(!externalEgressToolAllowed(policy===null?null:policy.allowedTools,exec.name,businessBound,gate))return {kind:'deny',reason:'本会话关联了外部业务来源，联网工具未在员工执行范围内授权。'}
   // ④岗位清单与参数范围这两道既有闸必须先于写记录判完：记录的语义是「一次已放行的外发」
   // （契约 `web-access.ts:5`），未授权的执行态会话不该先落账再被拒——那张表只追加，删不掉。
   // 判据与下面两行逐字同一份；这里先判一次，放行后下面再判一次，结论恒等。
   if(policy!==null&&!policy.allowedTools.includes(exec.name))return {kind:'deny',reason:'当前任务未授权使用此工具，请核对员工执行范围。'}
   if(policy?.argumentRules!==undefined&&!taskToolArgumentsAllowed(policy.argumentRules,exec.name,exec.arguments))return {kind:'deny',reason:'工具参数超出本次任务授权的数据范围或版本。'}
   // ⑤派发前写记录：写不进就没有对价，按不变式 2 拒绝；普通会话（'no-run'）放行且不记录。
   // web_fetch 的重定向目标由 DSH `web-fetch-http` 复判（组合钉已钉死 maxRedirects:3），本闸只判首跳 URL。
   if(webAccess!==undefined&&entry!==undefined){
    try{await webAccess.record(policySessionId,entry,exec.signal)}
    catch{return {kind:'deny',reason:'无法记录本次上网，已取消该工具调用。'}}
   }
  }
  if(policy!==null&&!cleanup&&!policy.allowedTools.includes(exec.name))return {kind:'deny',reason:'当前任务未授权使用此工具，请核对员工执行范围。'}
  // 技能代发按「岗位 × 技能」授权（审查修复 R1 M-1）：参数里只有 skill 对应授权记录，地址与请求体由工具自身按声明核对。
  if(policy?.argumentRules!==undefined&&(exec.name===skillHttpToolName?!skillHttpGrantedSkills(policy.argumentRules).includes(String((exec.arguments as Record<string,unknown>|undefined)?.skill)):!taskToolArgumentsAllowed(policy.argumentRules,exec.name,exec.arguments)))return {kind:'deny',reason:'工具参数超出本次任务授权的数据范围或版本。'}
  if(policy!==null&&(workspaceFileToolNames as readonly string[]).includes(exec.name)){
   if(!workspaceFiles||!policy.argumentRules?.some(rule=>rule.name===exec.name&&isWorkspaceFileRule(rule)))return {kind:'deny',reason:'当前任务未装配受限工作目录文件授权。'}
   const issue=await workspaceFiles.check(exec,lineage.root,policy)
   if(issue!==undefined)return {kind:'deny',reason:issue}
  }
  if((orchestrationTools as readonly string[]).includes(exec.name)){
   const definition=ctx.tools.get(exec.name,exec.agent)
   if(!definition)return {kind:'deny',reason:'当前运行模式未提供此编排工具。'}
   checkedOrchestration.set(exec,{definition,rootId:policySessionId,policy})
   const decision=await next()
   const approval=ctx.get('approval')
   const permissions=ctx.get('permissionPresets')
   // DSH 0.2 Auto 使用 ask + 模型审查，不能把 ask 当作必然由本人批准。
   if((decision.kind==='allow'||decision.kind==='ask')&&(permissions?.current(exec.agent.session)==='auto'||approval&&(approval.overrideOf(exec.agent.session)??approval.config.policy??'ask')==='never'))return {kind:'deny',reason:'当前权限模式不会请求人工确认；请切换到允许人工确认的权限模式后再执行脚本或迭代任务。'}
   return decision.kind==='allow'?{kind:'ask',reason:'请确认本次脚本或迭代执行；员工授权不会代替逐次确认。'}:decision
  }
  if(policy!==null&&isNativeToolName(exec.name)){
   const issue=nativeToolCallIssue(ctx,exec)
   if(issue!==undefined)return {kind:'deny',reason:issue}
   const definition=ctx.tools.get(exec.name,exec.agent)
   if(definition===undefined)return {kind:'deny',reason:'原生工具已断开，请重新启用后再试。'}
   checkedNative.set(exec,definition)
   const decision=await next()
   if(cleanup){browserCleanup!.decision(exec,decision);return decision}
   if(decision.kind!=='allow'||!nativeToolNeedsApproval(exec.name))return decision
   return {kind:'ask',reason:'请确认本次浏览器或电脑操作；员工授权不会代替逐次确认。'}
  }
  return next()
 })
 return ()=>{removePreExecute();removeNativeGuard();removeOrchestrationGuard();removeFileGuard()}
}
