import type {Context} from '@deepseek-ai/cordis'
import type {PromptAssembly} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import {workPromptModules,selectWorkPromptModules,renderWorkRuntimeContext} from './work-prompts/runtime-context.ts'

export {workBehaviorVersion,workPromptModules} from './work-prompts/runtime-context.ts'
export const name='teloa-work-behavior'
export const inject=['systemPrompt']
export interface Config{enabled?:boolean}
export const Config=z.object({enabled:z.boolean().default(true)})

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
