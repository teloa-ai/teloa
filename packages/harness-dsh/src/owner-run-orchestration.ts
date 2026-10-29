import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {WorkError} from '@teloa/contract'
import {orchestrationTools} from './role-tool-grants.ts'
import {presetOrchestrationToolNames} from './native-tool-access.ts'

/** 本人 Task 的编排能力必须同时存在于选定预设和当前专属 Agent，不能把形状校验全集当作实际授权面。 */
export async function captureOwnerRunOrchestration(ctx:Context,agent:Agent,presetId:string,signal:AbortSignal):Promise<{names:string[];assertCurrent:()=>void}>{
 const unavailable=()=>new WorkError('teloa/version-conflict','本人执行会话或预设的编排工具已变化，请重新准备。')
 const actual=()=>orchestrationTools.filter(name=>ctx.tools.get(name,agent)!==undefined)
 const before=actual()
 const assertCurrent=()=>{
  signal.throwIfAborted()
  if(ctx.agents.get(agent.id)!==agent||agent.session.header.agentPreset!==presetId||JSON.stringify(actual())!==JSON.stringify(before))throw unavailable()
 }
 assertCurrent()
 const preset=await presetOrchestrationToolNames(ctx,orchestrationTools,presetId)
 assertCurrent()
 return {names:preset.filter(name=>before.includes(name as typeof orchestrationTools[number])),assertCurrent}
}
