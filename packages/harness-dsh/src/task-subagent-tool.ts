import type {Context} from '@deepseek-ai/cordis'
import {defineTool} from '@deepseek-ai/dsh-tools'
import {SessionId} from '@deepseek-ai/dsh-session'
import {WorkError} from '@teloa/contract'
import {resolveSessionLineage} from './subagent-lineage.ts'
import {subagentReservationId,type SubagentDelegationPorts} from './subagent-delegation.ts'
import {subagentTaskToolName} from './role-tool-grants.ts'

type ChildResult={output:readonly {type:string;text?:string}[];stopReason:string;diagnostic?:string}
type ChildRun={id:string;result:Promise<ChildResult>;dispose:()=>Promise<void>}
type SubagentHost={subagents:{start:(provider:string,input:{label:string;prompt:{type:'text';text:string}[];parent:unknown;signal:AbortSignal;maxDepth:number})=>Promise<ChildRun>}}
type TokenMeterHost={agents?:{get:(id:SessionId)=>{session:unknown}|undefined};tokenMeter?:{measure:(session:unknown)=>{totalTokens:unknown}}}

const outputText=(output:readonly {type:string;text?:string}[])=>output.filter(block=>block.type==='text'&&typeof block.text==='string').map(block=>block.text).join('')
const outcomeError=(result:ChildResult)=>{
 switch(result.stopReason){
  case 'completed':return undefined
  case 'aborted':return '子 Agent 已取消。'
  case 'error':return '子 Agent 执行失败。'
  case 'max-tokens':return '子 Agent 达到令牌上限后结束。'
  case 'refusal':return '子 Agent 拒绝了这项工作。'
  default:return '子 Agent 未正常结束。'
 }
}
const reportFailure=()=>new WorkError('teloa/conflict','无法为本次子任务登记归属或已达数量上限，请核对任务执行范围。')
/** 这是结束时的上下文令牌估算快照，不是计费口径；计量不可用不能阻断任务结项。 */
function tokenEstimate(ctx:Context,childSessionId:string):number|undefined{
 try{
  const host=ctx as unknown as TokenMeterHost,agent=host.agents?.get(SessionId(childSessionId)),total=agent===undefined?undefined:host.tokenMeter?.measure(agent.session).totalTokens
  return typeof total==='number'&&Number.isSafeInteger(total)&&total>=0&&total<=2147483647?total:undefined
 }catch{return undefined}
}

/**
 * 执行态拆分必须由本工具掌握“预留 id → 返回的 child session id”这条直接映射。
 * 不依赖生命周期事件反推父调用，因此同一轮可并发创建多个子 Agent 而不混淆归属。
 */
export function registerTaskSubagentTool(ctx:Context,ports:SubagentDelegationPorts):()=>void{
 const host=ctx as unknown as SubagentHost
 return ctx.tools.register(defineTool({
  name:subagentTaskToolName,
  description:'将当前受管任务拆成一个独立、一次性的子任务。子 Agent 完成后返回结果；只能用于员工已授权的任务执行，不创建长期驻留会话。',
  parameters:{description:{type:'string',required:true,description:'子任务的简短名称。'},prompt:{type:'string',required:true,description:'完整、可独立执行的子任务说明。'}},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  isConcurrencySafe:()=>true,
  execute:async(args,exec)=>{
   const parent=exec.agent
   if(!parent)throw new WorkError('teloa/not-bound','子任务需要真实 Agent 会话上下文。')
   const lineage=resolveSessionLineage(ctx,parent.session),runId=await ports.runId(lineage.root.id,exec.signal)
   if(runId===undefined)throw reportFailure()
   // Run 身份读取是异步的；若期间已取消，不能写入一条随后必然释放的预留记录。
   exec.signal.throwIfAborted()
   const reservationId=subagentReservationId(lineage.root.id,String(exec.callId)),depth=lineage.depth+1
   let reserved=false,child:ChildRun|undefined,settled=false
   try{
    await ports.reserve({runId,reservationId,limit:ports.limits.maxPerRun});reserved=true
    exec.signal.throwIfAborted()
    child=await host.subagents.start('spawn',{label:args.description,prompt:[{type:'text',text:args.prompt}],parent,signal:exec.signal,maxDepth:ports.limits.maxDepth})
    await ports.bind({reservationId,childSessionId:child.id,depth})
    const result=await child.result
    const estimate=tokenEstimate(ctx,child.id)
    await ports.settle({childSessionId:child.id,stopReason:result.stopReason,...(estimate===undefined?{}:{tokenEstimate:estimate})});settled=true
    const failure=outcomeError(result)
    // 子会话诊断来自上游运行时，不能透传给父会话或页面；固定结局足以让父任务决定重试或收口。
    if(failure!==undefined)throw new WorkError('teloa/conflict',failure)
    return outputText(result.output)
   }catch(error){
    if(child===undefined&&reserved){try{await ports.release({reservationId})}catch{throw reportFailure()}}
    if(child!==undefined&&!settled){try{await ports.abandon({reservationId,childSessionId:child.id,depth,stopReason:'tool-settlement-failed'})}catch{throw reportFailure()}}
    throw error
  }finally{
   // 结果已经结算后，子会话的本地清理失败不能改写父任务的真实结局。
   if(child!==undefined){try{await child.dispose()}catch{ctx.logger.warn('Teloa 子 Agent 清理失败，已保留已结算结果。')}}
  }
  },
 }))
}
