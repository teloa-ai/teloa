import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {WorkError,readAnalysisSelfAuthorizedTools} from '@teloa/contract'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {leaseRunTools} from './task-run-tool-lease.ts'
import type {TaskRun} from '@teloa/backend'
import {resolveSessionLineage} from './subagent-lineage.ts'
import {filterRunToolAssembly,runToolApplicability,runToolNames} from './task-run-tool-catalog.ts'

export type TaskRunToolScopeReader=(sessionId:string,nativeRequestId:string,signal:AbortSignal)=>Promise<{run:Pick<TaskRun,'sessionId'|'nativeRequestId'|'groupContext'|'inputText'>;digest:boolean}|null>

/** 实际模型组装前恢复根会话text能力，并按可信根Run政策收窄真实子会话的最终工具目录。 */
export function registerTaskRunTextScope(ctx:Context,readPolicy:TaskToolPolicyReader,restrict:(agent:Agent,auxiliary:readonly string[])=>()=>void,readScope?:TaskRunToolScopeReader){
 const children=new WeakMap<Agent,{root:Agent['session'];requestId:string;allowed:ReadonlySet<string>}>()
 return ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{
  const candidate=(context.agent??context.scope) as Agent|undefined
  const child=candidate?.session?.header?.origin==='subagent'
  if(!candidate||typeof candidate.id!=='string'||ctx.agents.get(candidate.id)!==candidate){
   if(child)throw new WorkError('teloa/forbidden','子会话身份或谱系不可核验。')
   return next()
  }
  const signal=AbortSignal.any([AbortSignal.timeout(15000),...(context.signal?[context.signal]:[])])
  if(!child){
   const policy=await readPolicy(candidate.id,signal)
   if(!policy?.textOnly)return next()
   if(!policy.nativeRequestId)throw new WorkError('teloa/forbidden','受限文本工作缺少固定运行身份。')
   const auxiliary=readAnalysisSelfAuthorizedTools(policy.selfAuthorizedTools)
   leaseRunTools(candidate,policy.nativeRequestId,true,()=>restrict(candidate,auxiliary),auxiliary.join(','))
   const result=await next(),current=await readPolicy(candidate.id,signal)
   if(!current?.textOnly||current.stopRequested||current.nativeRequestId!==policy.nativeRequestId||JSON.stringify(readAnalysisSelfAuthorizedTools(current.selfAuthorizedTools))!==JSON.stringify(auxiliary))throw new WorkError('teloa/forbidden','原分析候选能力已变化。')
   return filterRunToolAssembly(result,new Set(auxiliary))
  }
  try{
   const root=resolveSessionLineage(ctx,candidate.session).root,previous=children.get(candidate)
   const assertCurrent=()=>{signal.throwIfAborted();if(ctx.agents.get(candidate.id)!==candidate||resolveSessionLineage(ctx,candidate.session).root!==root)throw Error('changed lineage')}
   const policyAt=async()=>{
    assertCurrent()
    const value=await readPolicy(root.id,signal)
    assertCurrent()
    if(value===null)return null
    if(!Array.isArray(value.allowedTools)||value.allowedTools.some(name=>typeof name!=='string'||!name.trim())||!value.nativeRequestId)throw Error('invalid managed identity')
    return {...value,nativeRequestId:value.nativeRequestId,allowedTools:[...value.allowedTools]}
   }
   const namesFor=async(policy:NonNullable<Awaited<ReturnType<typeof policyAt>>>)=>{
    if(policy.textOnly||policy.stopRequested)return new Set<string>()
    if(!readScope)throw Error('missing managed scope reader')
    const scope=await readScope(root.id,policy.nativeRequestId,signal)
    assertCurrent()
    if(!scope||scope.run.sessionId!==root.id||scope.run.nativeRequestId!==policy.nativeRequestId||typeof scope.digest!=='boolean')throw Error('unknown managed scope')
    return runToolNames(policy.allowedTools,runToolApplicability(scope.run,scope.digest))
   }
   const before=await policyAt()
   if(before===null){
    if(previous)throw Error('managed identity removed')
    const result=await next()
    if(await policyAt()!==null)throw Error('managed identity changed during assembly')
    return result
   }
   if(previous&&(previous.root!==root||previous.requestId!==before.nativeRequestId))throw Error('managed identity replaced')
   const allowed=await namesFor(before),result=await next(),after=await policyAt()
   if(!after||after.nativeRequestId!==before.nativeRequestId)throw Error('managed identity changed during assembly')
   const current=await namesFor(after)
   // 子会话不借用父RPC在自身日志上认租约；每次最终组装只与真实root政策及自身已见范围取交集。
   const committed=children.get(candidate)
   if(committed&&(committed.root!==root||committed.requestId!==before.nativeRequestId))throw Error('managed identity replaced')
   const keep=new Set([...allowed].filter(name=>current.has(name)&&(!committed||committed.allowed.has(name))))
   children.set(candidate,{root,requestId:before.nativeRequestId,allowed:keep})
   return filterRunToolAssembly(result,keep)
  }catch{
   signal.throwIfAborted()
   throw new WorkError('teloa/forbidden','无法核对子会话的受管工具范围或运行身份。')
  }
 })
}
