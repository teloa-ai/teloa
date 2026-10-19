import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {SessionSeq} from '@deepseek-ai/dsh-session'
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

/** 会话中宿主协议仍需逐字保留的 surface 尾段起点（如交付复核的待校正数据节点）；未登记或返回 undefined 时不限制。 */
const protectedTails=new WeakMap<object,()=>SessionSeq|undefined>()
/**
 * 登记一段在本轮必须保持原样的 surface 尾段：自动压力压缩与溢出恢复只摘要它之前的历史，不把它并入摘要。
 * 返回注销函数，只删除自己登记的那一份。
 */
export function protectCompactionTail(session:object,anchor:()=>SessionSeq|undefined):()=>void{
 protectedTails.set(session,anchor)
 return ()=>{if(protectedTails.get(session)===anchor)protectedTails.delete(session)}
}
/** 原生选区若越过受保护尾段起点，截到它之前的节点；剩余部分为空则如实拒绝，由原生自动触发记为未压缩。 */
function protectedRegion(start:SessionSeq,end:SessionSeq,agent:Agent):[SessionSeq,SessionSeq]{
 const anchor=protectedTails.get(agent.session)?.()
 const nodes=agent.session.surface.nodes,at=anchor===undefined?-1:nodes.indexOf(anchor)
 if(at<0||nodes.indexOf(end)<at)return [start,end]
 if(at===0||nodes.indexOf(start)>=at)throw new Error('compaction: the remaining history is an active host review that must stay verbatim')
 return [start,nodes[at-1]!]
}
/** 原生 backend 的同一选区与摘要算法，只在提交前按受保护尾段截短选区。 */
class ProtectedTailCompaction extends BasicCompactionEngine{
 override compactRegion(...[start,end,agent,signal]:Parameters<BasicCompactionEngine['compactRegion']>):ReturnType<BasicCompactionEngine['compactRegion']>{
  return super.compactRegion(...protectedRegion(start,end,agent),agent,signal)
 }
}

/**
 * rc.1 的配置不可变且没有运行期 policy 回调。只在公开操作边界选择配置，
 * 由隔离的原生 backend 完整执行；主实例保留原生自动触发与溢出重试计数。
 * 不改 config/私有状态，不复制摘要、选区、持久化或恢复算法。
 */
export class LocalModelCompaction extends ProtectedTailCompaction{
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
  const fork=scope.plugin(ProtectedTailCompaction,localCompactionConfig(this.config,target.provider,target.model,capacity,this.useLocalRetentionDefault))
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
