import {isWorkspaceFileRule,type TaskToolArgumentRule} from '@teloa/contract'

export const subagentTaskToolName='subagent_task'
export type SubagentDelegationLimits={maxDepth:number;maxPerRun:number}

/**
 * 同一条资料授权可有相同参数；选择键必须带工具名，才不会把两项授权错误地绑在一起。
 */
export function roleToolGrantSelectionKey(rule:TaskToolArgumentRule,args:Record<string,string|number|boolean|null>=rule.allowed[0]??{}):string{
 return rule.name+'\u0000'+JSON.stringify(Object.fromEntries(Object.keys(args).sort().map(key=>[key,args[key]])))
}

export function isSubagentDelegationRule(rule:TaskToolArgumentRule):boolean{
 return rule.name===subagentTaskToolName&&rule.anyArguments===true&&rule.allowed.length===0
}

/**
 * 技能代发（规格 2026-09-27 §5.1，审查修复 R1 M-1）：按「岗位 × 技能」逐项授权，规则形如 `{name,allowed:[{skill}]}`；
 * 展示信息（技能名、来源、目标 origin、是否已保存密钥）随候选逐项到达。
 */
export const skillHttpToolName='teloa_skill_http'
export type SkillHttpGrantCandidate={skill:string;origins:string[];configured?:boolean;source:'role'|'industry'}
/** 有限参数不是都指向正文版本；目录工具只接受服务端约定的固定参考服务。 */
export function roleToolGrantArgumentKind(rule:TaskToolArgumentRule,args:Record<string,string|number|boolean|null>):'resource'|'catalog'|'templates'|undefined{
 if(rule.name==='mcp__teloa_reference__read_reference'&&Object.keys(args).length===2&&typeof args.id==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(args.id)&&typeof args.version==='string'&&/^[a-f0-9]{64}$/.test(args.version))return 'resource'
 if(Object.keys(args).length===1&&args.server==='teloa_reference'){
  if(rule.name==='list_mcp_resources')return 'catalog'
  if(rule.name==='list_mcp_resource_templates')return 'templates'
 }
 return undefined
}
/** 无法解释的有限参数留在界面供核对，但不能新增或随旧勾选静默保存。 */
export function selectableRoleToolGrantRules(rules:readonly TaskToolArgumentRule[]):TaskToolArgumentRule[]{
 return rules.flatMap(rule=>{
  if(rule.anyArguments===true||isWorkspaceFileRule(rule)||isSkillHttpRule(rule))return [rule]
  const allowed=rule.allowed.filter(args=>roleToolGrantArgumentKind(rule,args)!==undefined)
  return allowed.length?[{name:rule.name,allowed}]:[]
 })
}
export function isSkillHttpRule(rule:TaskToolArgumentRule):boolean{
 return rule.name===skillHttpToolName&&rule.anyArguments!==true&&rule.allowed.length>0&&rule.allowed.every(args=>Object.keys(args).length===1&&typeof args.skill==='string')
}

export const webToolNames=['web_search','web_fetch'] as const
export function isWebToolRule(rule:TaskToolArgumentRule):boolean{
 return (webToolNames as readonly string[]).includes(rule.name)&&rule.anyArguments===true&&rule.allowed.length===0
}

/**
 * 只有服务端候选明确给出的规则才能写回；这里不生成工具名或默认限额，避免客户端越过岗位授权边界。
 */
export function selectedRoleToolGrantRules(rules:readonly TaskToolArgumentRule[],selected:ReadonlySet<string>):TaskToolArgumentRule[]{
 return rules.flatMap(rule=>{
  if(isWorkspaceFileRule(rule))return selected.has(roleToolGrantSelectionKey(rule))?[{name:rule.name,allowed:[],workspaceFiles:'default-workspace' as const}]:[]
  if(rule.anyArguments===true)return selected.has(roleToolGrantSelectionKey(rule))?[{name:rule.name,allowed:[],anyArguments:true}]:[]
  const allowed=rule.allowed.filter(args=>selected.has(roleToolGrantSelectionKey(rule,args)))
  return allowed.length?[{name:rule.name,allowed}]:[]
 })
}

/** 回显完整现有选择；候选只决定能否继续保存，不能把未变更授权默默当作未勾选。 */
export function roleToolGrantSelectedKeys(rules:readonly TaskToolArgumentRule[]):string[]{
 return rules.flatMap(rule=>rule.anyArguments===true||isWorkspaceFileRule(rule)?[roleToolGrantSelectionKey(rule)]:rule.allowed.map(args=>roleToolGrantSelectionKey(rule,args)))
}
