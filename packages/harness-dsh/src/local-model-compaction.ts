import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {BasicCompactionEngine,type BasicCompactionConfig} from '@deepseek-ai/dsh-compaction-basic'
import type {LocalModelRequestPorts} from './local-model-request.ts'

declare module '@deepseek-ai/cordis'{
 interface Context{teloaLocalModelRequests:LocalModelRequestPorts}
}

/** 只生成官方精确模型配置；云端默认值和显式摘要目标保持原样。 */
export function localCompactionConfig(config:BasicCompactionEngine['config'],provider:string,model:string,capacity:number,useLocalRetentionDefault=true):BasicCompactionConfig{
 const policy=config.modelPolicies.find(row=>row.provider===provider&&row.model===model)
 const budget=Math.max(1,Math.min(4096,Math.floor(capacity/8)))
 const summaryProvider=policy?.summarizationProvider??config.summarizationProvider
 const summaryModel=policy?.summarizationModel??config.summarizationModel
 const inheritsTarget=!summaryProvider||(summaryProvider===provider&&summaryModel===model)
 const local={...policy,provider,model,
  // 小窗口提前留出下一条消息的空间；长尾消息不能把整个可压缩区都锁住。
  ...(useLocalRetentionDefault&&policy?.retainRatio===undefined&&policy?.retainTokens===undefined?{retainTokens:0}:{}),
  headroomTokens:Math.min(policy?.headroomTokens??config.headroomTokens,Math.max(1,Math.min(8192,Math.floor(capacity/4)))),
  maxTokens:inheritsTarget?Math.min(policy?.maxTokens??config.maxTokens,budget):policy?.maxTokens??config.maxTokens,
 }
 return {...config,auto:false,modelPolicies:[...config.modelPolicies.filter(row=>row!==policy).map(row=>({...row})),local]}
}

/**
 * rc.1 的配置不可变且没有运行期 policy 回调。只在公开操作边界选择配置，
 * 由隔离的原生 backend 完整执行；主实例保留原生自动触发与溢出重试计数。
 * 不改 config/私有状态，不复制摘要、选区、持久化或恢复算法。
 */
export class LocalModelCompaction extends BasicCompactionEngine{
 private readonly useLocalRetentionDefault:boolean
 constructor(ctx:Context,config:BasicCompactionConfig={}){
  super(ctx,config)
  this.useLocalRetentionDefault=config.retainRatio===undefined&&config.retainTokens===undefined
 }
 private async withLocal<T>(agent:Agent,signal:AbortSignal|undefined,run:(engine:BasicCompactionEngine)=>Promise<T>,native:()=>Promise<T>):Promise<T>{
  const target=agent.session.requestHeader()?.config
  if(target?.provider!=='ollama')return native()
  const ports=this.ctx.get('teloaLocalModelRequests')
  if(!ports)return native()
  const abort=signal??new AbortController().signal
  const capacity=await ports.requestCapacity(target,abort,true)
  if(capacity===null)return native()
  abort.throwIfAborted()
  const scope=this.ctx.isolate('compaction')
  const fork=scope.plugin(BasicCompactionEngine,localCompactionConfig(this.config,target.provider,target.model,capacity,this.useLocalRetentionDefault))
  try{
   await fork
   abort.throwIfAborted()
   const engine=scope.get('compaction')
   if(!(engine instanceof BasicCompactionEngine))throw Error('原生本地模型压缩服务未就绪。')
   return await run(engine)
  }finally{await fork.dispose()}
 }
 override compactIfNeeded(...args:Parameters<BasicCompactionEngine['compactIfNeeded']>):ReturnType<BasicCompactionEngine['compactIfNeeded']>{
  return this.withLocal(args[0],args[2],engine=>engine.compactIfNeeded(...args),()=>super.compactIfNeeded(...args))
 }
 override compactRegion(...args:Parameters<BasicCompactionEngine['compactRegion']>):ReturnType<BasicCompactionEngine['compactRegion']>{
  return this.withLocal(args[2],args[3],engine=>engine.compactRegion(...args),()=>super.compactRegion(...args))
 }
 override compactNow(...args:Parameters<BasicCompactionEngine['compactNow']>):ReturnType<BasicCompactionEngine['compactNow']>{
  return this.withLocal(args[0],args[1],engine=>engine.compactNow(...args),()=>super.compactNow(...args))
 }
}
export default LocalModelCompaction
