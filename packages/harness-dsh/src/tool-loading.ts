import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {ToolSchema} from '@deepseek-ai/dsh-llm'
import type {PromptAssembly} from '@deepseek-ai/dsh-system-prompt'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {WorkError} from '@teloa/contract'
import {getToolResourceProvenance} from './tool-resource-provenance.ts'
import {refineWorkBehavior} from './work-behavior.ts'
import {readSessionEvents} from './session-events.ts'
import {hasTaskModelRouting} from './task-model-routing.ts'
import {knowledgeSearchToolName} from './local-retrieval.ts'
import {skillHttpToolName} from './skill-http-tool.ts'
import {selfAuthorizedToolNames} from './self-authorized-tools.ts'
import {conversationWorkToolNames} from './conversation-work-tool-names.ts'

/** 统一的工具加载器：普通会话与语音轮次共用同一个名字、目录与守卫。 */
export const toolLoaderName='teloa_tools_load'
const legacyLoaderNames=new Set(['teloa_voice_tools'])
const voiceContextName='teloa:voice-tool-directory'
const voiceImmediate=new Set(['teloa_work_stop'])
// 已关联原稿状态上下文（saved-draft-context.ts）以本工具可见为前提；加载新建类工具时一并展开，保持原稿状态连续。
const savedDraftAnchor='teloa_create_drafts'
const deliveryReviewTool='teloa_submit_review_plan'

/** 延迟加载的平台管理类目录；只用于加载器描述与搜索，不决定授权。 */
const categories:readonly Readonly<{label:string;hint:string;pattern:RegExp}>[]=[
 {label:'新建与草案',hint:'新建员工、技能、方法等草案，修订、预览与应用',pattern:/^teloa_(?:create|method)_/},
 {label:'市场与行业',hint:'市场搜索、安装、评价发布，行业方案与模型准备',pattern:/^teloa_(?:market|industry)_|^teloa_(?:mcp_connect|model_prepare)$/},
 {label:'员工与团队',hint:'员工目录、创建编辑、在岗状态、工具授权',pattern:/^teloa_(?:employees|role_tools)_/},
 {label:'能力与连接管理',hint:'技能安装编辑启停、扩展、自定义MCP、连接实例',pattern:/^teloa_(?:skills?|extensions|mcp|connector)_/},
 {label:'群管理',hint:'群目录、建群改群、群资料、群员工授权、群工作关联',pattern:/^teloa_groups?_/},
 {label:'项目',hint:'项目列表、创建与变更',pattern:/^teloa_projects_/},
 {label:'计划',hint:'定时计划查看、创建与修改',pattern:/^teloa_plans_/},
 {label:'任务配置与资料',hint:'任务配置、任务资料',pattern:/^teloa_task_/},
 {label:'资料库',hint:'资料库文件夹、版本、保存与工作资料',pattern:/^teloa_(?:library|resources)_|^teloa_knowledge_(?!search$)/},
 {label:'业务搭建',hint:'业务定义、搭建与升级',pattern:/^teloa_business_(?:definitions|builder)_/},
 {label:'业务记录与成果',hint:'业务记录读写、成果登记、变更、导入、职责',pattern:/^teloa_business_|^teloa_work_supersede$/},
]
const otherCategory={label:'其他平台工具',hint:'其余平台管理操作'}
const categoryOf=(name:string)=>categories.find(row=>row.pattern.test(name))??otherCategory

let coreNames:ReadonlySet<string>|undefined
/** 常驻核心：原生/预设/MCP/技能等非 teloa_ 工具全部常驻；teloa_ 只保留会话工作、能力查询、知识检索与技能 HTTP。 */
export function isCoreTool(name:string):boolean{
 if(!name.startsWith('teloa_'))return true
 coreNames??=new Set<string>([...conversationWorkToolNames,'teloa_capabilities',knowledgeSearchToolName,skillHttpToolName,deliveryReviewTool,toolLoaderName])
 return coreNames.has(name)
}
/** 只在受管任务运行中可用的自授权工具：其闸要求本会话有已受理的固定运行，加载器可见即说明不是运行会话（运行会话由 restrictRunTools 收窄，不含加载器）。 */
const runOnlyToolNames=():ReadonlySet<string>=>new Set<string>(selfAuthorizedToolNames)

const terms=(text:string)=>{
 const words=text.toLowerCase().match(/[a-z0-9]+|[\p{Script=Han}]+/gu)??[]
 return [...new Set(words.flatMap(word=>/^[a-z0-9]+$/.test(word)?[word]:Array.from({length:Math.max(1,word.length-1)},(_,at)=>word.slice(at,at+2))))]
}
function search(available:ReadonlyMap<string,ToolSchema>,query:string):string[]{
 const words=terms(query),rows=[...available.values()].map(tool=>{const category=categoryOf(tool.name);return {tool,name:tool.name.toLowerCase(),text:(tool.name+' '+tool.description+' '+category.label+' '+category.hint).toLowerCase()}})
 const frequencies=new Map(words.map(word=>[word,rows.filter(row=>row.text.includes(word)).length]))
 return rows.map(row=>({name:row.tool.name,score:(query.toLowerCase().includes(row.name)?100:0)+words.reduce((sum,word)=>sum+(row.text.includes(word)?(row.name.includes(word)?4:1)*Math.log(1+rows.length/(frequencies.get(word)!+1)):0),0)/Math.sqrt(1+row.tool.description.length/256)})).filter(row=>row.score>0).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).slice(0,6).map(row=>row.name)
}
const sectionTool=(name:string)=>name.match(/^tool:([^:]+)(?::.*)?$/)?.[1]

type Sections=PromptAssembly['sections']
type Contexts=PromptAssembly['contexts']
type Pass={available:ReadonlyMap<string,ToolSchema>;sections:Sections;contexts:Contexts}
type State={
 /** 普通会话已加载名单：同一会话只增不减，冷恢复从会话历史重建。 */
 session?:Set<string>
 voice?:{turn:number;loaded:Set<string>;persist:boolean}|undefined
 mode?:'session'|'voice'|undefined
 available:ReadonlyMap<string,ToolSchema>
 hidden:ReadonlySet<string>
 exposed:ReadonlySet<string>
}
const loadInto=(target:Set<string>,name:string)=>{target.add(name);if(name.startsWith('teloa_create_'))target.add(savedDraftAnchor)}

/** 从本会话历史恢复已加载名单：历史中实际调用过的平台工具与加载器回执里的工具。只影响可见性，曝光时仍取本轮许可目录交集。 */
function restoreLoaded(agent:Agent):Set<string>{
 const loaded=new Set<string>(),loaderCalls=new Set<string>()
 for(const event of readSessionEvents(agent.session)){
  if(event.type==='tool/call'){
   const {name,callId,arguments:args}=event.data as {name:string;callId:string;arguments:string}
   if(name===toolLoaderName||legacyLoaderNames.has(name)){
    loaderCalls.add(callId)
    try{const value=JSON.parse(args) as {names?:unknown};if(Array.isArray(value?.names))for(const row of value.names)if(typeof row==='string')loadInto(loaded,row)}catch{}
   }else if(name.startsWith('teloa_'))loadInto(loaded,name)
  }else if(event.type==='tool/result'){
   const message=event.data.message as {toolCallId:string;isError?:boolean;content:readonly {type:string;text?:string}[]}
   if(message.isError||!loaderCalls.has(message.toolCallId))continue
   for(const block of message.content)if(block.type==='text'&&typeof block.text==='string'){
    try{const value=JSON.parse(block.text) as {loaded?:unknown};if(Array.isArray(value?.loaded))for(const row of value.loaded)if(row&&typeof row==='object'&&typeof Reflect.get(row,'name')==='string')loadInto(loaded,Reflect.get(row,'name') as string)}catch{}
   }
  }
 }
 return loaded
}

function directoryText(available:ReadonlyMap<string,ToolSchema>):string{
 const labels=new Map<string,string>()
 for(const name of available.keys())if(!isCoreTool(name)){const category=categoryOf(name);labels.set(category.label,category.hint)}
 if(!labels.size)return ''
 const ordered=[...categories,otherCategory].filter(row=>labels.has(row.label))
 return '\n可加载类别：'+ordered.map(row=>row.label+'（'+row.hint+'）').join('；')+'。'
}

type SessionOptions=Readonly<{isRoutingSession?:(sessionId:string)=>boolean}>

function createEngine(ctx:Context){
 const states=new WeakMap<Agent,State>()
 const passes=new WeakMap<ToolSchema,Pass>()
 let closed=false,sessionHooks=0
 const stateOf=(agent:Agent)=>{let state=states.get(agent);if(!state){state={available:new Map(),hidden:new Set(),exposed:new Set()};states.set(agent,state)}return state}
 const idle=(state:State|undefined)=>{if(state){state.mode=undefined;state.exposed=new Set()}}
 // 普通会话：本会话许可目录内、仅未展开参数的工具，按名称直接调用时补加载并照常执行（参数仍由工具自身校验）；
 // 语音轮次仍先加载后调用。守卫只能拒绝，不能放行其他闸已拒绝的调用，许可目录外的工具一律不执行。
 const offGuard=ctx.tools.guard(exec=>{
  const state=exec.agent&&states.get(exec.agent)
  if(!state?.mode||exec.parent||state.exposed.has(exec.name))return
  if(state.mode==='voice'){
   if(state.available.has(exec.name)){
    loadInto(state.voice!.loaded,exec.name);if(state.voice!.persist&&state.session)loadInto(state.session,exec.name)
    return '该工具尚未加载，本次未执行。已定位本会话原有许可参数，请下一步读取完整参数与工作规则后再调用；无需另查目录。'
   }
   return '请先加载该工具，并在下一步读取正式参数与工作规则后再调用。'
  }
  if(state.available.has(exec.name)){loadInto(state.session!,exec.name);return}
  if(state.hidden.has(exec.name))return exec.name+' 只适用于受管任务运行，当前会话不可用，本次未执行。'
 })
 const registration=getToolResourceProvenance(ctx).wrapContext(ctx,{kind:'plugin',providerId:'@teloa/harness-dsh',name:'Teloa'})
 const off=registration.tools.register(defineTool({
  name:toolLoaderName,
  description:'按操作目标加载当前会话已允许、但尚未展开参数的平台工具，供下一步调用。query用简短中英文动作词，例如"新建员工"、"market install"、"读取项目"；已知准确工具名时用names指定，最多8个。只加载参数，不执行业务操作或新增授权；普通问答和已可见的工具无需调用。',
  parameters:{query:{type:'string',description:'简短的动作词，可同时用中英文，例如网页搜索 web search。'},names:{type:'array',items:{type:'string'}}},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  execute:async({names,query},exec)=>{
   const state=exec.agent&&states.get(exec.agent)
   if(closed||!state?.mode)throw new WorkError('teloa/forbidden','当前原会话不在工具加载阶段。')
   exec.signal.throwIfAborted()
   if(names!==undefined&&(names.length<1||names.length>8)||query!==undefined&&(!query.trim()||query.length>256)||names===undefined&&query===undefined)throw new WorkError('teloa/invalid-input','请提供简短操作目标或1到8个准确工具名。')
   const catalog=state.available
   const selected=names?[...new Set(names)]:search(new Map([...catalog].filter(([name])=>!state.exposed.has(name))),query!)
   if(selected.some(name=>!catalog.has(name)||name===toolLoaderName))throw new WorkError('teloa/forbidden','工具不在本会话许可目录中。')
   for(const name of selected){
    if(state.mode==='voice'){loadInto(state.voice!.loaded,name);if(state.voice!.persist&&state.session)loadInto(state.session,name)}
    else loadInto(state.session!,name)
   }
   return JSON.stringify({loaded:selected.map(name=>({name,description:catalog.get(name)!.description})),next:selected.length?'下一步使用这些工具的完整参数；实际操作仍按原权限、审批与执行规则。':'未找到。可换用更直接的操作词或中英文同义词再搜索；不能猜测工具参数或宣称已执行。'})
  },
 }))

 /** 普通会话：首步只广告常驻核心与加载器，已加载工具在同一会话内持续可见。 */
 function refineSession(agent:Agent,assembly:PromptAssembly,options:SessionOptions):PromptAssembly{
  const discovery=assembly.tools.find(tool=>tool.name===toolLoaderName)
  // 加载器不可见说明已被任务运行等收窄（restrict），不叠加；同一次装配已处理过则原样返回。
  if(!discovery){idle(states.get(agent));return assembly}
  if(passes.has(discovery))return assembly
  // 本轮已由语音收窄（宿主钩子晚于按 Agent 的语音钩子登记、成为外层时）：语音已按原许可目录处理，不能把收窄结果当作目录覆盖。
  if(assembly.contexts.some(context=>context.name===voiceContextName))return assembly
  const eligible=!closed&&agent.session.header.origin!=='subagent'&&!options.isRoutingSession?.(agent.id)&&!hasTaskModelRouting(agent)&&!assembly.tools.some(tool=>tool.name==='run_code')
  if(!eligible){idle(states.get(agent));return {...assembly,tools:assembly.tools.filter(tool=>tool!==discovery)}}
  const state=stateOf(agent),hidden=runOnlyToolNames()
  const available=new Map(assembly.tools.filter(tool=>tool!==discovery&&!hidden.has(tool.name)).map(tool=>[tool.name,tool]))
  const loaded=state.session??=restoreLoaded(agent)
  const loader={...discovery,description:discovery.description+directoryText(available)}
  const tools=assembly.tools.flatMap(tool=>tool===discovery?[loader]:!hidden.has(tool.name)&&(isCoreTool(tool.name)||loaded.has(tool.name))?[tool]:[])
  const exposed=new Set(tools.map(tool=>tool.name))
  // 官方 tool:<name> 说明随参数一起延后；其余身份、权限与上下文保持原样。
  const deferred=(name:string)=>{const tool=sectionTool(name);return !!tool&&(available.has(tool)||hidden.has(tool))&&!exposed.has(tool)}
  passes.set(loader,{available,sections:assembly.sections.filter(row=>deferred(row.name)),contexts:assembly.contexts.filter(row=>deferred(row.name))})
  state.mode='session';state.available=available;state.hidden=hidden;state.exposed=exposed
  return refineWorkBehavior({...assembly,tools,sections:assembly.sections.filter(row=>!deferred(row.name)),contexts:assembly.contexts.filter(row=>!deferred(row.name))})
 }

 /** 语音轮次：首步只暴露加载器与停止，加载按轮次重置；普通会话已处理时以其许可目录为底。 */
 function refineVoice(agent:Agent,assembly:PromptAssembly,input:Readonly<{voice:boolean;turn?:number}>):PromptAssembly{
  const discovery=assembly.tools.find(tool=>tool.name===toolLoaderName)
  const pass=discovery&&passes.get(discovery)
  const contexts=assembly.contexts.filter(context=>context.name!==voiceContextName)
  // 没有加载端口（例如角色显式限制工具名）时完整保留原工具，不能把员工能力切掉。
  if(closed||!input.voice||input.turn===undefined||!discovery){
   const state=states.get(agent)
   if(state)state.voice=undefined
   if(pass)return {...assembly,contexts}
   idle(state)
   // 普通会话加载已安装、但宿主钩子在外层尚未处理时保留加载器，交由其收窄。
   if(sessionHooks)return {...assembly,contexts}
   return {...assembly,contexts,tools:assembly.tools.filter(tool=>tool.name!==toolLoaderName)}
  }
  const state=stateOf(agent)
  if(!state.voice||state.voice.turn!==input.turn)state.voice={turn:input.turn,loaded:new Set(),persist:false}
  const voice=state.voice
  voice.persist=!!pass
  const available=pass?pass.available:new Map(assembly.tools.filter(tool=>tool.name!==toolLoaderName).map(tool=>[tool.name,tool]))
  for(const name of voice.loaded)if(!available.has(name))voice.loaded.delete(name)
  const keep=(name:string)=>voiceImmediate.has(name)||voice.loaded.has(name)
  const tools=pass?[discovery,...[...available.values()].filter(tool=>keep(tool.name))]:assembly.tools.filter(tool=>tool.name===toolLoaderName||keep(tool.name))
  const exposed=new Set(tools.map(tool=>tool.name))
  contexts.push({name:voiceContextName,interpolate:false,text:[
   '# 当前语音轮次的工具加载',
   '普通聊天直接自然回答，不必查工具。需要实际操作时，先用 '+toolLoaderName+' 按操作目标搜索，再在下一步使用已加载的正式工具。可用中英文动作词查询，例如 web search、读取文件、员工权限。未找到时可换同义词，不能猜未加载的参数，不把加载成功说成工作完成。只搜索本会话原有许可，权限、审批和工作执行规则不变。',
  ].join('\n')})
  const deferred=(name:string)=>{const tool=sectionTool(name);return !!tool&&available.has(tool)&&!exposed.has(tool)}
  // 普通会话装配已延后的说明，在语音加载对应工具后补回。
  const restored=<T extends {name:string}>(rows:readonly T[])=>rows.filter(row=>{const tool=sectionTool(row.name);return !!tool&&exposed.has(tool)})
  const sections=[...assembly.sections.filter(section=>!deferred(section.name)),...pass?restored(pass.sections):[]]
  const activeContexts=[...contexts.filter(context=>!deferred(context.name)),...pass?restored(pass.contexts):[]]
  state.mode='voice';state.available=available;state.hidden=new Set();state.exposed=exposed
  // 首步只能聊天、查参数或停止原工作；开始实际操作前恢复完整的适用工作规则。
  return refineWorkBehavior({...assembly,sections,contexts:activeContexts,tools},!voice.loaded.size)
 }
 return {refineSession,refineVoice,attachSession(){sessionHooks++;let detached=false;return ()=>{if(!detached){detached=true;sessionHooks--}}},dispose(){if(closed)return;closed=true;offGuard();off()}}
}

type Engine=ReturnType<typeof createEngine>
const engines=new WeakMap<object,{engine:Engine;refs:number}>()
/** 同一宿主只登记一个加载器与守卫；语音与普通会话各持一份引用，最后一份释放时注销。 */
export function acquireToolLoading(ctx:Context):Readonly<{engine:Engine;release:()=>void}>{
 const root=ctx.root
 let entry=engines.get(root)
 if(!entry){entry={engine:createEngine(ctx),refs:0};engines.set(root,entry)}
 const current=entry
 current.refs++
 let released=false
 return Object.freeze({engine:current.engine,release(){if(released)return;released=true;if(--current.refs===0){if(engines.get(root)===current)engines.delete(root);current.engine.dispose()}}})
}

/**
 * 宿主级普通会话按需加载：本人普通会话、业务会话、员工直接对话与项目会话首步只广告常驻核心工具。
 * 任务运行（restrict 后不含加载器）、交付复核（只留回执工具）、子 Agent 与 PTC 原样跳过；群路由会话按注入的判定排除，不建立加载状态，误调工具仍由路由守卫拒绝。
 * 与按 Agent 登记的语音钩子不依赖登记先后：语音已收窄的装配不再覆盖，语音外轮次保留加载器交由本钩子处理。
 * 必须先于项目运行上下文登记：其外层快照的系统提示须是收窄后的版本。
 */
export function installSessionToolLoading(ctx:Context,options:SessionOptions={}):()=>void{
 const {engine,release}=acquireToolLoading(ctx),detach=engine.attachSession()
 const off=ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{
  const result=await next(),agent=context.agent
  return agent?engine.refineSession(agent,result,options):result
 },{prepend:true})
 let disposed=false
 return ()=>{if(disposed)return;disposed=true;off();detach();release()}
}
