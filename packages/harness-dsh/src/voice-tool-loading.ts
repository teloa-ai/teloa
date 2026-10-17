import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {ToolSchema} from '@deepseek-ai/dsh-llm'
import type {PromptAssembly} from '@deepseek-ai/dsh-system-prompt'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {WorkError} from '@teloa/contract'
import {getToolResourceProvenance} from './tool-resource-provenance.ts'
import {refineWorkBehavior} from './work-behavior.ts'

export const voiceToolsName='teloa_voice_tools'
const contextName='teloa:voice-tool-directory'
const immediate=new Set(['teloa_work_stop'])
type State={turn:number;available:Map<string,ToolSchema>;loaded:Set<string>;exposed:Set<string>}
const terms=(text:string)=>{
 const words=text.toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]+/gu)??[]
 return [...new Set(words.flatMap(word=>/^[a-z0-9]+$/.test(word)?[word]:Array.from({length:Math.max(1,word.length-1)},(_,at)=>word.slice(at,at+2))))]
}
function search(available:Map<string,ToolSchema>,query:string):string[]{
 const words=terms(query),rows=[...available.values()].map(tool=>({tool,name:tool.name.toLowerCase(),text:(tool.name+' '+tool.description).toLowerCase()}))
 const frequencies=new Map(words.map(word=>[word,rows.filter(row=>row.text.includes(word)).length]))
 return rows.map(row=>({name:row.tool.name,score:(query.toLowerCase().includes(row.name)?100:0)+words.reduce((sum,word)=>sum+(row.text.includes(word)?(row.name.includes(word)?4:1)*Math.log(1+rows.length/(frequencies.get(word)!+1)):0),0)/Math.sqrt(1+row.tool.description.length/256)})).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).slice(0,6).map(row=>row.name)
}
/** 只延后完整参数的加载；每次装配重新取原许可工具集，不注册或执行任何业务能力。 */
export function createVoiceToolLoading(ctx:Context){
 const states=new WeakMap<Agent,State>()
 let closed=false
 // 加载结果只在下一次正式装配后可执行，模型不能靠猜名字跳过工作规则的恢复。
 const offGuard=ctx.tools.guard(exec=>{
  const state=exec.agent&&states.get(exec.agent)
  if(state&&!exec.parent&&!state.exposed.has(exec.name)){
   if(state.available.has(exec.name)){
    state.loaded.add(exec.name)
    return '该工具尚未加载，本次未执行。已定位本会话原有许可参数，请下一步读取完整参数与工作规则后再调用；无需另查目录。'
   }
   return '请先加载该工具，并在下一步读取正式参数与工作规则后再调用。'
  }
 })
 const registration=getToolResourceProvenance(ctx).wrapContext(ctx,{kind:'plugin',providerId:'@teloa/harness-dsh',name:'Teloa'})
 const off=registration.tools.register(defineTool({
  name:voiceToolsName,
  description:'按操作目标搜索并加载当前会话已允许的工具参数，供下一步调用。例如query="web search"、"读取文件"、"员工权限"；宿主已提及准确工具名时用names指定，最多8个，不再模糊搜索。只加载参数，不执行业务操作或新增授权。普通聊天无需调用。',
  parameters:{query:{type:'string',description:'简短的动作词，可同时用中英文，例如网页搜索 web search。'},names:{type:'array',items:{type:'string'}}},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  execute:async({names,query},exec)=>{
   const state=exec.agent&&states.get(exec.agent)
   if(closed||!state)throw new WorkError('teloa/forbidden','当前原会话不在语音工具加载阶段。')
   exec.signal.throwIfAborted()
   if(names!==undefined&&(names.length<1||names.length>8)||query!==undefined&&(!query.trim()||query.length>256)||names===undefined&&query===undefined)throw new WorkError('teloa/invalid-input','请提供简短操作目标或1到8个准确工具名。')
   const selected=names?[...new Set(names)]:search(state.available,query!)
   if(selected.some(name=>!state.available.has(name)||name===voiceToolsName))throw new WorkError('teloa/forbidden','工具不在本轮原会话许可目录中。')
   for(const name of selected)state.loaded.add(name)
   return JSON.stringify({loaded:selected.map(name=>({name,description:state.available.get(name)!.description})),next:selected.length?'下一步使用这些工具的完整参数；实际操作仍按原权限、审批与执行规则。':'未找到。可换用更直接的操作词或中英文同义词再搜索；不能猜测工具参数或宣称已执行。'})
  },
 }))
 return Object.freeze({
  refine(agent:Agent,assembly:PromptAssembly,input:Readonly<{voice:boolean;turn?:number}>):PromptAssembly{
   const available=assembly.tools.filter(tool=>tool.name!==voiceToolsName)
   const contexts=assembly.contexts.filter(context=>context.name!==contextName)
   // 没有加载端口（例如角色显式限制工具名）时完整保留原工具，不能把员工能力切掉。
   const discovery=assembly.tools.find(tool=>tool.name===voiceToolsName)
   if(closed||!input.voice||input.turn===undefined||!discovery){states.delete(agent);return {...assembly,contexts,tools:available}}
   let state=states.get(agent)
   if(!state||state.turn!==input.turn){state={turn:input.turn,available:new Map(),loaded:new Set(),exposed:new Set()};states.set(agent,state)}
   state.available=new Map(available.map(tool=>[tool.name,tool]))
   for(const name of state.loaded)if(!state.available.has(name))state.loaded.delete(name)
   contexts.push({name:contextName,interpolate:false,text:[
    '# 当前语音轮次的工具加载',
    '普通聊天直接自然回答，不必查工具。需要实际操作时，先用 '+voiceToolsName+' 按操作目标搜索，再在下一步使用已加载的正式工具。可用中英文动作词查询，例如 web search、读取文件、员工权限。未找到时可换同义词，不能猜未加载的参数，不把加载成功说成工作完成。只搜索本会话原有许可，权限、审批和工作执行规则不变。',
   ].join('\n')})
   const tools=assembly.tools.filter(tool=>tool.name===voiceToolsName||immediate.has(tool.name)||state!.loaded.has(tool.name))
   state.exposed=new Set(tools.map(tool=>tool.name))
   // 官方tool:<name>说明随参数一起延后；身份、权限和未知插件规则一律保留。
   const deferred=(name:string)=>{const tool=name.match(/^tool:([^:]+)(?::.*)?$/)?.[1];return !!tool&&state!.available.has(tool)&&!state!.exposed.has(tool)}
   const sections=assembly.sections.filter(section=>!deferred(section.name))
   const activeContexts=contexts.filter(context=>!deferred(context.name))
   // 首步只能聊天、查参数或停止原工作；开始实际操作前恢复完整的适用工作规则。
   return refineWorkBehavior({...assembly,sections,contexts:activeContexts,tools},!state.loaded.size)
  },
  dispose(){if(closed)return;closed=true;offGuard();off()},
 })
}
