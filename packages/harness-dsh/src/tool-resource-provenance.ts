import type {Context,Fiber} from '@deepseek-ai/cordis'
import type {ToolDefinition,ToolExecution,ToolExecutionResult,ToolExecutionToken} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {RecordedToolResourceUse,RecordedNestedToolResourceUse,ToolResourceUseSnapshot} from '@teloa/contract'
import {readSessionEvents} from './session-events.ts'
export type {ToolResourceUseSnapshot} from '@teloa/contract'

type JsonValue=Extract<ToolExecutionResult,{isError:false}>['value']
export type ToolResourceSource={readonly kind:'mcp'|'plugin'|'skill'|'web';readonly providerId:string;readonly name:string;readonly rawToolName?:string;readonly state?:'used'|'read'|'injected'}
export type ToolResourceSourceResolver=ToolResourceSource|((definition:ToolDefinition,args:unknown,value:unknown)=>ToolResourceSource|undefined)
export type ToolRecordedResourceUse=RecordedToolResourceUse
export type ToolRecordedNestedResourceUse=RecordedNestedToolResourceUse
declare module '@deepseek-ai/cordis'{
 interface Context{teloaToolResourceProvenance:ToolResourceProvenance}
}
export const name='teloa-tool-resource-provenance'
export const inject=['tools']
/** 公开依赖门控：预设注册器必须在来源监听就绪后才能加载首次工具定义。 */
export function apply(ctx:Context):void{
 ctx.provide('teloaToolResourceProvenance',getToolResourceProvenance(ctx))
}
type Executed={readonly definition:ToolDefinition;readonly args:object;readonly use:ToolRecordedResourceUse}
type RootUse={readonly exec:ToolExecution;readonly parentCallSeq?:number;readonly rows:ToolRecordedNestedResourceUse[];readonly tokens:Set<ToolExecutionToken>;readonly snapshotted:Set<string>}
const controllers=new WeakMap<Context,ToolResourceProvenance>()
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const object=(value:unknown):value is object=>typeof value==='object'&&value!==null
const nonempty=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0
const mergeMeta=(native:JsonValue|undefined,extra:Record<string,JsonValue>):JsonValue=>record(native)?{...native,...extra}:native===undefined?extra:{teloaNativeMeta:native,...extra}

function useOf(definition:ToolDefinition,resolver:ToolResourceSourceResolver,args:unknown,value:unknown):ToolRecordedResourceUse|undefined{
 let source:ToolResourceSource|undefined
 try{source=typeof resolver==='function'?resolver(definition,args,value):resolver}catch{return undefined}
 if(!source||!nonempty(source.providerId)||!nonempty(source.name)||!['mcp','plugin','skill','web'].includes(source.kind)||(source.rawToolName!==undefined&&!nonempty(source.rawToolName)))return undefined
 const state=source.state??(source.kind==='skill'?'read':'used')
 if(source.kind==='skill'?state!=='read'&&state!=='injected':state!=='used')return undefined
 return {schema:'teloa.resource-use/v1',kind:source.kind,providerId:source.providerId,name:source.name,toolName:definition.name,state,...(source.rawToolName!==undefined?{rawToolName:source.rawToolName}:{})}
}
function nestedSearch(exec:Readonly<ToolExecution>,result:Readonly<ToolExecutionResult>):Pick<ToolRecordedNestedResourceUse,'queries'|'sources'|'truncated'|'answer'>{
 if(result.isError||!record(exec.arguments)||!Array.isArray(exec.arguments.queries)||!exec.arguments.queries.length||!exec.arguments.queries.every(nonempty)||!record(result.value)||!Array.isArray(result.value.sources)||typeof result.value.truncated!=='boolean')return {}
 const sources:Array<{url:string;title?:string;snippet?:string;publishedAt?:string}>=[]
 for(const item of result.value.sources){
  if(!record(item)||!nonempty(item.url)||['title','snippet','publishedAt'].some(key=>item[key]!==undefined&&typeof item[key]!=='string'))return {}
  sources.push({url:item.url,...(typeof item.title==='string'?{title:item.title}:{}),...(typeof item.snippet==='string'?{snippet:item.snippet}:{}),...(typeof item.publishedAt==='string'?{publishedAt:item.publishedAt}:{})})
 }
 return {queries:[...new Set(exec.arguments.queries)],sources,truncated:result.value.truncated,...(typeof result.value.content==='string'?{answer:result.value.content}:{})}
}

/** 记录实际执行的定义身份；注册表、同名工具与执行结果不会共用来源猜测。 */
export class ToolResourceProvenance {
 private readonly executed=new Map<ToolExecutionToken,Executed>()
 private readonly byArguments=new WeakMap<object,Executed>()
 private readonly rootArguments=new WeakMap<object,RootUse>()
 private readonly roots=new Map<ToolExecutionToken,RootUse>()
 private readonly restores=new Map<ToolDefinition,()=>void>()
 private readonly wrappedDefinitions=new WeakSet<ToolDefinition>()
 private readonly pluginSources=new WeakMap<Fiber,ToolResourceSourceResolver>()
 private readonly entryModules=new WeakMap<NonNullable<Fiber['entry']>,string>()
 private readonly snapshotSinks=new Set<(row:ToolResourceUseSnapshot)=>Promise<void>>()
 private readonly stop:readonly (()=>void)[]
 private readonly ctx:Context
 private disposed=false
 constructor(ctx:Context){
  this.ctx=ctx
  this.stop=[ctx.on('loader/patch-context',(entry,next)=>{
   next()
   // Loader 完成 import 后、建立 fiber 前走此入口；活跃 fiber 的配置编辑不改归属。
   if(entry.fiber?.uid||entry.options.group||!nonempty(entry.options.name)||['cordis:group','cordis:include','@teloa/harness-dsh'].includes(entry.options.name))return
   this.entryModules.set(entry,entry.options.name)
  }),ctx.on('internal/plugin',fiber=>{
   if(fiber.uid===null)this.pluginSources.delete(fiber)
  }),ctx.on('internal/get',(owner,name,_error,next)=>{
   const tools=next()
   if(name!=='tools'||!owner.fiber.runtime)return tools
   let source=this.pluginSources.get(owner.fiber)
   const provider=owner.fiber.entry?this.entryModules.get(owner.fiber.entry):undefined
   if(!source&&provider){
    source=provider==='@deepseek-ai/dsh-tool-skill'?(_definition,_args,value)=>record(value)&&nonempty(value.provider)&&nonempty(value.name)?{kind:'skill',providerId:value.provider,name:value.name,state:'read'}:undefined:{kind:provider==='@deepseek-ai/dsh-tool-web'?'web':'plugin',providerId:provider,name:owner.fiber.runtime.name||provider}
    this.pluginSources.set(owner.fiber,source)
   }
   if(!source)return tools
   // 来源取正在贡献工具的实际 Loader Entry，不从可用插件清单或工具名称推导。
   return this.wrapTools(tools,source,true)
  }),ctx.on('tools/execute',async(exec,next)=>{
   if(exec.parent===undefined&&exec.name==='run_code'&&object(exec.arguments)){
    const definition=ctx.tools.get(exec.name,exec.agent)
    if(definition){
     this.instrumentTransport(definition)
     const call=exec.agent?readSessionEvents(exec.agent.session).filter(event=>event.type==='tool/call'&&event.data.name===exec.name&&event.data.callId===exec.callId).at(-1):undefined
     const root:RootUse={exec,...(call?{parentCallSeq:call.seq}:{}),rows:[],tokens:new Set([exec.token]),snapshotted:new Set()}
     this.roots.set(exec.token,root);this.rootArguments.set(exec.arguments,root)
    }
   }else if(exec.parent!==undefined){
    const root=this.roots.get(exec.parent)
    if(root&&root.exec.agent===exec.agent&&root.exec.rootCallId===exec.rootCallId){this.roots.set(exec.token,root);root.tokens.add(exec.token)}
   }
   return next()
  }),ctx.on('tools/result',(exec,result)=>{
   const executed=this.executed.get(exec.token),root=this.roots.get(exec.token)
   if(executed&&!result.isError&&exec.parent!==undefined&&root&&root.exec.agent===exec.agent&&root.exec.rootCallId===exec.rootCallId){
    root.rows.push({...executed.use,callId:exec.callId,rootCallId:exec.rootCallId,...(executed.use.kind==='web'?nestedSearch(exec,result):{})})
   }
   if(executed){this.executed.delete(exec.token);if(this.byArguments.get(executed.args)===executed)this.byArguments.delete(executed.args)}
   if(root?.exec.token===exec.token){for(const token of root.tokens)this.roots.delete(token);if(object(exec.arguments))this.rootArguments.delete(exec.arguments)}
   return undefined
  }),ctx.on('tools/ptc-dispatch-log',async(dispatch,next)=>{
   const content=await next(),root=this.roots.get(dispatch.exec.token)
   if(!this.snapshotSinks.size||dispatch.isError||!dispatch.agent||root?.exec!==dispatch.exec||root.parentCallSeq===undefined||root.exec.agent!==dispatch.agent)return content
   const use=root.rows.find(row=>row.callId===dispatch.subCallId&&row.rootCallId===dispatch.exec.rootCallId&&row.toolName===dispatch.name)
   const start=readSessionEvents(dispatch.agent.session).filter(event=>event.type==='tool/ptc-dispatch-start'&&event.seq>root.parentCallSeq!&&event.data.parentCallId===dispatch.exec.callId&&event.data.rootCallId===dispatch.exec.rootCallId&&event.data.subCallId===dispatch.subCallId&&event.data.name===dispatch.name).at(-1)
   if(!use||!start||root.snapshotted.has(dispatch.subCallId))return content
   root.snapshotted.add(dispatch.subCallId)
   const snapshot:ToolResourceUseSnapshot={schema:'teloa.resource-use-snapshot/v1',sessionId:dispatch.agent.session.id,parentCallSeq:root.parentCallSeq,startSeq:start.seq,parentCallId:dispatch.exec.callId,use}
   const outcomes=await Promise.allSettled([...this.snapshotSinks].map(async sink=>sink(structuredClone(snapshot))))
   if(outcomes.some(result=>result.status==='rejected'))ctx.logger.warn('Teloa 工具来源记录保存失败；原生调用结果保留。')
   return content
  })]
  ctx.effect(()=>()=>this.dispose(),'Teloa 工具资源来源')
 }
 private instrument(definition:ToolDefinition,resolver:ToolResourceSourceResolver,target:ToolDefinition):void{
  const execute=target.execute,presentationMeta=target.output.presentationMeta
  const wrappedExecute:ToolDefinition['execute']=async(args,exec)=>{
   const value=await execute.call(target,args,exec),use=useOf(definition,resolver,args,value)
   if(!this.disposed&&use&&object(args)&&typeof exec.token==='symbol'){
    const executed:Executed={definition:target,args,use};this.executed.set(exec.token,executed);this.byArguments.set(args,executed)
   }
   return value
  }
  const wrappedMeta:NonNullable<ToolDefinition['output']['presentationMeta']>=(args,value)=>{
   const native=presentationMeta?.call(target.output,args,value),executed=object(args)?this.byArguments.get(args):undefined
   return !this.disposed&&executed?.definition===target?mergeMeta(native,{teloaResourceUse:executed.use}):native??{}
  }
  target.execute=wrappedExecute;target.output.presentationMeta=wrappedMeta
  this.wrappedDefinitions.add(target)
  if(target===definition)this.restores.set(target,()=>{if(target.execute===wrappedExecute)target.execute=execute;if(target.output.presentationMeta===wrappedMeta){if(presentationMeta)target.output.presentationMeta=presentationMeta;else delete target.output.presentationMeta}})
 }
 wrapDefinition(definition:ToolDefinition,source:ToolResourceSourceResolver):ToolDefinition{
  const wrapped={...definition,output:{...definition.output}}
  this.instrument(definition,source,wrapped)
  return wrapped
 }
 /** 固定模块先按明确注册对象核实，再装配；不会按名称替换当前 scoped 定义。 */
 instrumentExisting(definition:ToolDefinition,source:ToolResourceSourceResolver):void{
  if(!this.restores.has(definition))this.instrument(definition,source,definition)
 }
 wrapContext(ctx:Context,source:ToolResourceSourceResolver):Context{
  return ctx.extend({tools:this.wrapTools(ctx.tools,source)})
 }
 private wrapTools(tools:Context['tools'],source:ToolResourceSourceResolver,preserveExplicit=false):Context['tools']{
  const register:typeof tools.register=definition=>tools.register(preserveExplicit&&this.wrappedDefinitions.has(definition)?definition:this.wrapDefinition(definition,source))
  return new Proxy(tools,{get:(target,prop)=>prop==='register'?register:Reflect.get(target,prop)})
 }
 /** 仅传出已成功的真实 PTC 子调用；保存失败不改变工具结果或模型正文。 */
 onNestedUse(sink:(row:ToolResourceUseSnapshot)=>Promise<void>):()=>void{
  this.snapshotSinks.add(sink)
  return ()=>{this.snapshotSinks.delete(sink)}
 }
 private instrumentTransport(definition:ToolDefinition):void{
  if(this.restores.has(definition))return
  const presentationMeta=definition.output.presentationMeta
  const wrappedMeta:NonNullable<ToolDefinition['output']['presentationMeta']>=(args,value)=>{
   const native=presentationMeta?.call(definition.output,args,value),root=object(args)?this.rootArguments.get(args):undefined
   const rows=root?.rows.map(({queries,sources,...row})=>({...row,...(queries?{queries:[...queries]}:{}),...(sources?{sources:sources.map(source=>({...source}))}:{})}))
   return rows?.length?mergeMeta(native,{teloaResourceUses:rows}):native??{}
  }
  definition.output.presentationMeta=wrappedMeta
  this.restores.set(definition,()=>{if(definition.output.presentationMeta===wrappedMeta){if(presentationMeta)definition.output.presentationMeta=presentationMeta;else delete definition.output.presentationMeta}})
 }
 dispose():void{
  if(this.disposed)return
  this.disposed=true
  for(const stop of this.stop)stop()
  for(const restore of this.restores.values())restore()
  this.restores.clear();this.executed.clear();this.roots.clear();this.snapshotSinks.clear();controllers.delete(this.ctx.root)
 }
}
export function getToolResourceProvenance(ctx:Context):ToolResourceProvenance{
 const owner=ctx.root,existing=controllers.get(owner)
 if(existing)return existing
 const controller=new ToolResourceProvenance(ctx);controllers.set(owner,controller);return controller
}
