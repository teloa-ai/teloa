import type {PromptAssembly} from '@deepseek-ai/dsh-system-prompt'
import core from './core.ts'
import tools from './tools.ts'
import planning from './planning.ts'
import memory from './memory.ts'
import skills from './skills.ts'
import collaboration from './collaboration.ts'
import background from './background.ts'
import artifacts from './artifacts.ts'
import projects from './projects.ts'
import {selfAuthorizedToolNames} from '../self-authorized-tools.ts'

export const workBehaviorVersion='2026-10-15.fact-language.v3'
export const workPromptModules=[core,tools,planning,memory,skills,collaboration,background,artifacts,projects] as const
type WorkPromptModule=typeof workPromptModules[number]
type ToolSchema=PromptAssembly['tools'][number]

/** 只用当轮权限过滤后的目录选择规则；工具可见不代表已获执行授权。 */
export function selectWorkPromptModules(catalog:readonly ToolSchema[]):readonly WorkPromptModule[]{
 const names=catalog.map(tool=>tool.name)
 const has=(pattern:RegExp)=>names.some(name=>pattern.test(name))
 const agentMessage=catalog.some(tool=>{
  if(tool.name!=='send_message')return false
  const properties=tool.parameters.properties
  return !!properties&&typeof properties==='object'&&Object.hasOwn(properties,'message')
   &&(Object.hasOwn(properties,'target')||Object.hasOwn(properties,'agent_id'))
 })
 const selected=new Set<string>([core.id,planning.id,artifacts.id])
 // 自授权工具只登记意图或写受限记录，不足以引入平台对象、文件、命令与浏览器的泛化说明。
 if(names.some(name=>!(selfAuthorizedToolNames as readonly string[]).includes(name)))selected.add(tools.id)
 if(has(/^(?:memory(?:_|$)|teloa_role_memory_propose$|skill_(?:create|update|write)$|teloa_create_draft$)/))selected.add(memory.id)
 if(has(/^(?:skill(?:_|$)|teloa_skills_|teloa_create_(?:draft|directory)$|mcp(?:__|_)|connector(?:_|$))/))selected.add(skills.id)
 if(agentMessage||has(/^(?:subagent(?:_|$)|workflow(?:_|$)|ralph(?:_|$)|teloa_work_(?:dispatch|collect_reports|directory|status|stop|resume)$|spawn_(?:agent|teammate)$|interrupt_agent$|list_agents$|wait_agent$)/))selected.add(collaboration.id)
 if(has(/^(?:job(?:_|$)|schedule(?:_|$)|notification(?:_|$)|notify(?:_|$)|watch(?:_|$))/))selected.add(background.id)
 if(has(/^teloa_projects_/))selected.add(projects.id)
 return workPromptModules.filter(module=>selected.has(module.id))
}

/** 身份、岗位、模式、权限、时间与目录继续由既有原生上下文提供。 */
export function renderWorkRuntimeContext(modules:readonly WorkPromptModule[]):string{
 return '# 当前工作行为适用范围\n'+JSON.stringify({
  behavior_version:workBehaviorVersion,
  modules:modules.map(module=>module.id),
  capability_basis:'visible-tool-catalog',
  grants_permissions:false,
 })
}
