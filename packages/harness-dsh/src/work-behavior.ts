import type {Context} from '@deepseek-ai/cordis'
import type {PromptAssembly} from '@deepseek-ai/dsh-system-prompt'
import {renderContextSnapshot} from '@deepseek-ai/dsh-system-prompt'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-experimental-agent-team'
import z from '@deepseek-ai/schemastery'
import {workPromptModules,selectWorkPromptModules,renderWorkRuntimeContext} from './work-prompts/runtime-context.ts'
import {productIdentityText} from './work-prompts/product-identity.ts'
import {readSessionEvents} from './session-events.ts'

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

/** 只退休本模块的旧静态正文；权限、岗位、其他快照字段与原始事件均保留。 */
function retireHistoricalProductContext(agent:Agent,assembly:PromptAssembly):void{
 const visible=new Set(agent.session.surface.nodes)
 const snapshots=readSessionEvents(agent.session).filter(event=>visible.has(event.seq)&&event.type==='user/message'&&event.data.source.kind==='runtime-context'&&event.data.source.form==='snapshot')
 const owned=(section:{name:string;text:string})=>section.name==='teloa:product-identity'&&/^# Teloa (?:identity and usage|产品与用量事实)\n/.test(section.text)
 const old=snapshots.filter(event=>event.type==='user/message'&&event.data.source.kind==='runtime-context'&&event.data.source.form==='snapshot'&&event.data.source.sections.some(owned))
 if(!old.length)return
 const latest=snapshots.at(-1)
 if(old.length===1&&latest&&old[0]===latest&&latest.type==='user/message'&&latest.data.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')===renderContextSnapshot(assembly))return
 const replacements=[]
 for(const event of old){
  if(event.type!=='user/message'||event.data.source.kind!=='runtime-context'||event.data.source.form!=='snapshot')continue
  const sections=event.data.source.sections.filter(section=>!owned(section))
  const before=event.data.source.sections.map(section=>section.text).join('\n\n'),after=sections.map(section=>section.text).join('\n\n')
  // 只修改具名正文唯一对应的块，保留官方或插件的原包装；未知形状整批不动。
  const matches=event.data.content.flatMap((block,index)=>block.type==='text'&&block.text.includes(before)?[index]:[])
  if(!before||matches.length!==1)return
  const index=matches[0]!,block=event.data.content[index]!
  if(block.type!=='text'||block.text.split(before).length!==2)return
  const content=event.data.content.map((row,i)=>i===index&&row.type==='text'?{...row,text:row.text.replace(before,()=>after)}:row)
  replacements.push({seq:event.seq,message:createUserMessage({source:{...event.data.source,sections},content})})
 }
 // 改写旧 runtime 节点会更新原生 retained 指针，因此本轮变化时连旧 latest 一起退休，交由原生补唯一 current。
 for(const replacement of replacements)agent.session.append('user/message',replacement.message,{surfaceOp:{op:'replace',startSeq:replacement.seq,endSeq:replacement.seq},sourceEventSeqs:[replacement.seq]})
}

export function apply(ctx:Context,config:Config={}):void{
 if(config.enabled===false)return
 if(config.productOnly){
  // 官方 complete persona 会替换全部 section；required 上下文仍由原生装配保留。
  ctx.systemPrompt.context({name:'teloa:product-identity',order:0,text:productIdentityText,required:true,interpolate:false})
  ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{
   const result=await next();context.signal?.throwIfAborted()
   if(context.agent)retireHistoricalProductContext(context.agent,result)
   return result
  },{prepend:true})
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
