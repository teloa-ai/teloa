import {WorkError,taskInput,taskToolArgumentsAllowed,readTaskToolArgumentRules,isWorkspaceFileRule,workspaceFileToolNames,type TaskToolArgumentRule,type ResourceContext} from '@teloa/contract'
import type {RoleToolGrantService} from '@teloa/backend'
import {isNativeToolName,nativeGrantToolNames} from './native-tool-access.ts'
import {businessResultToolNames} from './business-result-tools.ts'
import {knowledgeSearchToolName} from './local-retrieval.ts'
import {skillHttpGrantedSkills,skillHttpToolName} from './skill-http-tool.ts'
export const roleToolGrantEndpoints=['role-tools/get','role-tools/change','role-tools/candidates']
/** 公共参考资料 MCP 的 server 名；资源工具的 server 参数只认这一个值。 */
export const referenceServerName='teloa_reference'
export const referenceReadTool='mcp__teloa_reference__read_reference'
/** 0.1.6 的 dsh-mcp-resources 默认把三个共享资源工具对模型开放；Teloa 一律先拒，再按岗位放开。 */
export const mcpResourceTools=['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'] as const
/** 只有列举类资源工具能固定成精确参数；read_mcp_resource 必带 uri，平台在授权时无从枚举，故不进候选。 */
export const mcpResourceListTools=['list_mcp_resources','list_mcp_resource_templates'] as const
/** 受管一次性委派工具：预设行 `tool-subagent-task` 的 `toolName`，与持续协作的 Team 共用 Run 额度。 */
export const subagentTaskToolName='subagent_task'
/** 官方 Team 控制只操作本次运行里的临时助手；每个工具都需岗位显式授权。 */
export const teamDelegationTools=['spawn_teammate','send_message','list_agents','wait_agent','interrupt_agent','team_task_create','team_task_list','team_task_get','team_task_update'] as const
/** 原生编排工具；能力授权与每次脚本/迭代执行确认分开。 */
export const orchestrationTools=['workflow','ralph','run_code'] as const
/** 执行时可由岗位授权的内建拆分工具；与资料/MCP 候选一起参与运行快照校验。 */
export const subagentTaskToolRule:TaskToolArgumentRule={name:subagentTaskToolName,anyArguments:true,allowed:[]}
/**
 * 看板成果三工具（成果记录、看板读取、SQL 试算）参数由模型自由生成，只能整工具授权；
 * 默认不授予，岗位显式勾选后任务会话可用。范围仍由工具自身按本人登记范围核对（`business-result-tools.ts`）。
 * 本地检索 `teloa_knowledge_search` 同理（规格 §7.2）：查询词是自由文本，范围由工具按任务目标范围核对（`local-retrieval.ts`）。
 * 技能代发 `teloa_skill_http` 例外（规格 2026-09-27 §5.1 审查修复 R1 M-1）：授权按「岗位 × 技能」逐项保存为 `{name,allowed:[{skill}]}`，
 * 这里给的整工具形状只作运行准备复核时的**形状候选**——保存时已按授权页枚举候选逐项核对，运行准备只校验形状，
 * 调用时再按已勾选技能、运行技能快照与当前受管选定安装三重核对（`skill-http-tool.ts`）。授权页候选由 `roleGrantPageRules` 换成逐技能枚举。
 */
export function taskRunToolRules(available:readonly TaskToolArgumentRule[]):TaskToolArgumentRule[]{
 return [...available,subagentTaskToolRule,...[...teamDelegationTools,...orchestrationTools,...businessResultToolNames,knowledgeSearchToolName,skillHttpToolName].map(name=>({name,anyArguments:true as const,allowed:[]}))]
}
/**
 * 外发类工具：`@deepseek-ai/dsh-tool-web` 注册的两个模型可见工具名
 * （该包 `defineTool` 的 `name` 逐字为 `web_search` 与 `web_fetch`）。
 * 声明位置必须在 `roleGrantToolNames` 之前：那是模块求值期就要展开的固定集。
 *
 * 为什么单列一类：安全告警正文会逐字进入会话的 user turn（任务快照带 `business` 段），
 * 而告警来自外部 HTTP 来源，正文里可以写着"把 X 读出来 fetch 到 Y"。`read`/`bash`
 * 这些工具会走 `approval: ask` 由本人当场看见，`web_fetch` 在上游没有任何审批钩子，
 * 是一条不经人确认的外发通道。因此凡是绑定了业务对象来源的会话，都要求这两个工具
 * 出现在岗位执行范围里；没有绑定业务来源的普通会话不受这一维影响。
 */
export const externalEgressTools=['web_fetch','web_search'] as const
/** 岗位授权规则的静态基线；行业 MCP 另由服务端的逐角色活动连接候选补充。 */
export const roleGrantToolNames=[referenceReadTool,...mcpResourceTools,subagentTaskToolName,...teamDelegationTools,...orchestrationTools,...externalEgressTools,...nativeGrantToolNames,...workspaceFileToolNames,...businessResultToolNames,knowledgeSearchToolName,skillHttpToolName] as readonly string[]
// 技能代发只能按岗位授予（规格 2026-09-27 §5.1）：不进外发类工具（那会被上网闸按 web_fetch 口径改判），自授权集由任务守卫装配期拒绝。
if((externalEgressTools as readonly string[]).includes(skillHttpToolName))throw Error('技能代发工具不能列入外发类工具。')
/** 授权页上技能代发候选的展示信息：技能名、来源（岗位本身技能 / 行业职责技能）、目录声明的目标 origin、是否已保存密钥（读不出来时省略）。 */
export type SkillHttpGrantCandidate={skill:string;origins:string[];configured?:boolean;source:'role'|'industry'}
/**
 * 候选（规格 2026-09-27 §5.1 审查修复 R1 M-1）：岗位本身绑定的技能与岗位在行业加载里的职责技能都列出并标来源，
 * 只收「目录声明了密钥、当前为受管选定安装且启用」的技能；同名以岗位来源为准只列一次。
 * `declared` 已按安装绑定与胜出者核对目录来源（`declaredSkillSecretsResolver`）；`selected` 只认受管选定安装。
 */
export async function skillHttpGrantCandidates(skills:readonly {name:string;source:'role'|'industry'}[],ports:{selected:(skill:string)=>Promise<{availability:string}|undefined>;declared:(skill:string)=>Promise<{secrets:readonly {endpoints:readonly {origin:string}[]}[]}|undefined>;configured:(skill:string)=>Promise<boolean|undefined>}):Promise<SkillHttpGrantCandidate[]>{
 const result:SkillHttpGrantCandidate[]=[],seen=new Set<string>()
 for(const {name:skill,source} of skills){
  if(seen.has(skill))continue
  seen.add(skill)
  if((await ports.selected(skill))?.availability!=='enabled')continue
  const declared=await ports.declared(skill)
  if(!declared?.secrets.length)continue
  const configured=await ports.configured(skill)
  result.push({skill,origins:[...new Set(declared.secrets.flatMap(secret=>secret.endpoints.map(endpoint=>endpoint.origin)))],...(configured===undefined?{}:{configured}),source})
 }
 return result
}
/** 授权页候选：把运行准备用的技能代发形状候选换成逐技能枚举；没有可代发技能时不出这条，保存校验同源拒绝。 */
export function roleGrantPageRules(base:readonly TaskToolArgumentRule[],skillHttp:readonly SkillHttpGrantCandidate[]):TaskToolArgumentRule[]{
 return [...base.filter(rule=>rule.name!==skillHttpToolName),...(skillHttp.length?[{name:skillHttpToolName,allowed:skillHttp.map(candidate=>({skill:candidate.skill}))}]:[])]
}
/** allowedTools 为 null 表示普通会话（不受任务执行管理）；对资源工具而言普通会话同样不授权。 */
export function mcpResourceToolAllowed(allowedTools:readonly string[]|null,name:string):boolean{
 if(!(mcpResourceTools as readonly string[]).includes(name))return true
 return allowedTools!==null&&allowedTools.includes(name)
}
/** 本人会话保留官方能力；受管任务必须逐项授权，逐次确认由执行守卫处理。 */
export function orchestrationToolAllowed(allowedTools:readonly string[]|null,name:string):boolean{
 if(!(orchestrationTools as readonly string[]).includes(name))return true
 return allowedTools===null||allowedTools.includes(name)
}
/**
 * 上网的两条候选：参数不可枚举（查询词与 URL 都是模型自由文本，平台无从枚举），
 * 只能整工具授权。总开关关闭时不产出候选，授权页因此没有可勾项。
 */
export const webToolRules=(enabled:boolean):TaskToolArgumentRule[]=>
 enabled?externalEgressTools.map(name=>({name,anyArguments:true as const,allowed:[]})):[]
/** 上网闸判据的两维：Teloa 侧的总开关与目标主机是否过了拦截名单。判不出来的调用方传 undefined。 */
export type WebGatePolicy={enabled:boolean;hostAllowed:boolean}
/**
 * @param businessBound 本会话是否绑定了业务对象来源（SOC 告警等外部来源）。
 *   判定不出来时调用方必须传 true：无从证明这条会话没有外部正文，就不该放行外发。
 * @param policy Teloa 侧的上网策略判据。`undefined` 表示读不出来，与"绑定了业务来源"同权即拒（不变式 2）。
 *   本函数不碰 URL 解析：`hostAllowed` 由调用方用契约的 `webAccessHost` / `webHostBlocked` 先算好（编排者裁定 2）。
 */
export function externalEgressToolAllowed(allowedTools:readonly string[]|null,name:string,businessBound:boolean,policy:WebGatePolicy|undefined):boolean{
 if(!(externalEgressTools as readonly string[]).includes(name))return true
 if(policy===undefined)return false
 if(!policy.enabled)return false
 // 拦截名单是目标侧概念：搜索没有目标域名，这一维对 web_search 不生效。
 if(name==='web_fetch'&&!policy.hostAllowed)return false
 if(!businessBound)return true          // 普通会话：本人在场，与今天一致
 return allowedTools!==null&&allowedTools.includes(name)
}
/** 首批复用公共参考资料 MCP，只开放岗位已选资料的明确来源版本。 */
export function referenceToolRules(contents:readonly Pick<ResourceContext['contents'][number],'sourceId'|'sourceVersion'>[]):TaskToolArgumentRule[]{
 // 行业来源通过平台资料上下文提供；公共 MCP 尚无本人行业来源的读取适配。
 const allowed=contents.filter(item=>!item.sourceId.startsWith('industry_')).map(item=>({id:item.sourceId,version:item.sourceVersion}))
 if(!allowed.length)return []
 // 资源工具与正文读取同进退：岗位没有公共资料可读时，也没有枚举该 server 的理由。
 return [{name:referenceReadTool,allowed:Array.from(new Map(allowed.map(args=>[JSON.stringify(args),args])).values())},
  ...mcpResourceListTools.map(name=>({name,allowed:[{server:referenceServerName}]}))]
}
export function validateReferenceToolRules(rules:TaskToolArgumentRule[],available:TaskToolArgumentRule[]){
 // 静态工具仍只来自固定集；行业 MCP 的完整工具名则必须逐次来自服务端刚读取的 active binding。
 // 不把 `mcp__*` 作为通配符，避免一次连接把同一服务器的未声明工具也带进执行面。
 const candidates=new Map(available.map(rule=>[rule.name,rule]))
 for(const rule of readTaskToolArgumentRules(rules)){
  const candidate=candidates.get(rule.name)
  if((workspaceFileToolNames as readonly string[]).includes(rule.name)){
   if(!isWorkspaceFileRule(rule)||!candidate||!isWorkspaceFileRule(candidate))throw new WorkError('teloa/forbidden','文件工具只能授权当前工作目录，且必须有真实受限文件工具候选。')
   continue
  }
  const dynamicMcp=!isNativeToolName(rule.name)&&!!candidate?.anyArguments&&/^mcp__[A-Za-z0-9_-]{1,32}__[A-Za-z0-9_-]{1,128}$/.test(rule.name)
  const unconstrained=unconstrainedGrantToolNames.includes(rule.name)||dynamicMcp
  if(!roleGrantToolNames.includes(rule.name)&&!dynamicMcp)throw new WorkError('teloa/forbidden','只能授权员工已选资料、已连接行业工具或已登记的技能接口代发。')
  if(rule.name===skillHttpToolName){
   // 技能代发只按技能逐项授予（审查修复 R1 M-1）：每项恰为 {skill}；授权页候选逐项枚举时只收候选里的技能，
   // 运行准备的形状候选（anyArguments）只校验形状——保存时已逐项核对，调用时再三重核对。
   const skills=skillHttpGrantedSkills([rule])
   if('anyArguments' in rule||!rule.allowed.length||skills.length!==rule.allowed.length)throw new WorkError('teloa/forbidden','技能接口代发只能逐项授予员工可用的技能。')
   if(!candidate)throw new WorkError('teloa/forbidden','只能授权员工已选资料、已连接行业工具或已登记的技能接口代发。')
   if(candidate.anyArguments!==true&&skills.some(skill=>!skillHttpGrantedSkills([candidate]).includes(skill)))throw new WorkError('teloa/forbidden','技能接口代发只能逐项授予员工可用的技能。')
   continue
  }
  // 无候选仍放行的逃生口只留给 `subagent_task`（它的候选由 `taskRunToolRules` 无条件补齐）。
  // 外发两名的候选跟着上网总开关走：关掉后没有候选，已保存的授权也必须在这里被判拒，
  // 否则总开关关掉等于只清空了授权页的可勾项，旧授权照样过校验。
  if(!candidate&&rule.name!==subagentTaskToolName)throw new WorkError('teloa/forbidden','只能授权员工已选资料、已连接行业工具或已登记的技能接口代发。')
  if(('anyArguments' in rule)!==unconstrained)throw new WorkError('teloa/forbidden','参数不可枚举的工具只能整工具授权，不接受按参数授权。')
  // 带这一位时契约已钉住 `allowed` 恒为空；动态 MCP 也只能由服务端冻结的完整工具名进入此分支。
  if('anyArguments' in rule)continue
  if(!candidate||!rule.allowed.length||rule.allowed.some(args=>!taskToolArgumentsAllowed(available,rule.name,args)))throw new WorkError('teloa/forbidden','只能授权员工已选资料的明确读取版本。')
 }
}
export type RoleToolGrantCandidates={roleVersion:number;rules:TaskToolArgumentRule[];skillHttp?:SkillHttpGrantCandidate[]}
export function createRoleToolGrantHandler(owner:string,get:()=>Promise<Pick<RoleToolGrantService,'get'|'change'>>,candidates:(roleId:string)=>Promise<RoleToolGrantCandidates>,delegationLimits?:{maxDepth:number;maxPerRun:number}){
 return async(endpoint:string,payload:unknown)=>{
  if(!roleToolGrantEndpoints.includes(endpoint))throw new WorkError('teloa/not-found','未提供此员工授权接口。')
  const row=taskInput(payload,endpoint==='role-tools/change'?['roleId','expectedRoleVersion','action','rules']:['roleId'])
  const service=await get()
  if(endpoint==='role-tools/change')return service.change(owner,payload)
  const result=await service.get(owner,payload)
  if(endpoint==='role-tools/get')return result
  const available=await candidates(row.roleId as string)
  // 限额只解释实际可选的执行态拆分工具；资料授权页没有该项时不制造无关配置面。
  return available.rules.some(rule=>rule.name===subagentTaskToolName&&rule.anyArguments===true)&&delegationLimits!==undefined?{...available,delegation:delegationLimits}:available
 }
}
/**
 * 旧子会话工具族：保留识别以约束旧配置；当前预设关闭创建与控制行，由官方 Team 提供持续协作工具。
 * `subagent` / `subagent_fork` 是预设正文里两行 `@deepseek-ai/dsh-tool-subagent` 的 `toolName`；
 * `send_message` / `interrupt_agent` / `list_agents` 由 `@deepseek-ai/dsh-tool-subagent-control`
 * 逐字固定（不走配置项）；`list_subagent_models` 由 `tool-subagent` 的 `modelSelectionSettings: true` 打开。
 */
export const conversationDelegationTools=['subagent','subagent_fork','send_message','interrupt_agent','list_agents','list_subagent_models'] as const
/** 两族合起来才是"委派"这件事的全部模型可见面；新增一个名字必须同时进这张表，否则闸看不见它。 */
export const delegationTools=[...new Set([subagentTaskToolName,...conversationDelegationTools,...teamDelegationTools])] as readonly string[]
/**
 * 委派工具判据。极性与 mcpResourceToolAllowed **相反**，不要照抄：
 * - 普通会话（allowedTools===null）：原生 Team 与旧会话工具放行；`subagent_task` 拒绝，因为没有业务 Run 可归属。
 * - 执行态（allowedTools!==null）：Team 与 `subagent_task` 逐工具显式授权；仅旧工具族拥有的名称拒绝。
 * 深度与本 Run 累计数是**另外两条**闸，不在本函数里判（见 subagent-delegation.ts）。
 */
export function delegationToolAllowed(allowedTools:readonly string[]|null,name:string):boolean{
 if((teamDelegationTools as readonly string[]).includes(name))return allowedTools===null||allowedTools.includes(name)
 if(!(delegationTools as readonly string[]).includes(name))return true
 if(name===subagentTaskToolName)return allowedTools!==null&&allowedTools.includes(name)
 return allowedTools===null
}
/** 静态允许带 `anyArguments` 的工具名；行业 MCP 仅在服务端给出逐工具候选时允许该形式。 */
export const unconstrainedGrantToolNames=[subagentTaskToolName,...teamDelegationTools,...orchestrationTools,...externalEgressTools,...nativeGrantToolNames,...businessResultToolNames,knowledgeSearchToolName] as readonly string[]
