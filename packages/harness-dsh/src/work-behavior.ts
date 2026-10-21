import type {Context} from '@deepseek-ai/cordis'
import type {PromptAssembly} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import z from '@deepseek-ai/schemastery'
import {workPromptModules,selectWorkPromptModules,renderWorkRuntimeContext} from './work-prompts/runtime-context.ts'
import {productIdentityText} from './work-prompts/product-identity.ts'

export {workBehaviorVersion,workPromptModules} from './work-prompts/runtime-context.ts'
export const name='teloa-work-behavior'
export const inject=['systemPrompt']
export interface Config{enabled?:boolean;productOnly?:boolean}
export const Config=z.object({enabled:z.boolean().default(true),productOnly:z.boolean().default(false)})

/** 完整文本出口用于检查；实际请求按当轮能力选择正文。 */
export const workBehaviorText=workPromptModules.map(module=>module.text).join('\n\n')

/** 工具目录再次收窄时同步规则；只重算本插件的正文，保留宿主身份、权限和其他上下文。 */
export function refineWorkBehavior(assembly:PromptAssembly,coreOnly=false):PromptAssembly{
 const selected=selectWorkPromptModules(assembly.tools)
 const modules=coreOnly?selected.filter(module=>module===workPromptModules[0]):selected
 return {
  ...assembly,
  sections:assembly.sections.map(section=>section.name==='teloa:work-behavior'
   ?{...section,text:modules.map(module=>module.text).join('\n\n')}:section),
  contexts:assembly.contexts.map(context=>context.name==='teloa:work-behavior-runtime'
   ?{...context,text:renderWorkRuntimeContext(modules)}:context),
 }
}

export function apply(ctx:Context,config:Config={}):void{
 if(config.enabled===false)return
 if(config.productOnly){
  // 官方 complete persona 会替换全部 section；required 上下文仍由原生装配保留。
  ctx.systemPrompt.context({name:'teloa:product-identity',order:0,text:productIdentityText,required:true,interpolate:false})
  // 发送前 refreshContext 会重读原生 provider；独立 required 分类与原 Team 事实一同刷新，不覆盖其路由正文。
  ctx.systemPrompt.context({name:'teloa:team-routing-metadata',order:ctx.systemPrompt.getContextOrder('TEAM_IDENTITY')-1,required:true,interpolate:false,text:({agent})=>{
   if(!agent||!ctx.get('agentTeams')?.tryMembership(agent)||!agent.ctx.tools.get('list_agents',agent))return ''
   return 'Internal collaboration routing metadata: team:identity is not your user-facing identity. Introduce yourself using the trusted Teloa assistant, personal twin or employee context. Preserve native Team names and tool-routing instructions; they grant no additional authority.'
  }})
  return
 }
 ctx.systemPrompt.section({
  name:'teloa:work-behavior',
  order:ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')+100,
  text:'',interpolate:false,
 })
 ctx.systemPrompt.context({name:'teloa:work-behavior-runtime',order:115,text:''})
 // 先完成下游权限过滤，再填充本插件的 section/context，不改原生事实和工具。
 ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{
  const result=await next()
  return refineWorkBehavior(result)
 },{prepend:true})
}
