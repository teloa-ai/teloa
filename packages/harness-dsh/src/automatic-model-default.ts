import type {Context} from '@deepseek-ai/cordis'
import type {ModelSelection} from '@deepseek-ai/dsh-agent'
import {ReasoningEffortId} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'
import type {ModelCatalogReadiness,ModelCatalogReader} from './model-catalog-readiness.ts'
import {readSessionEvents} from './session-events.ts'

/** 只在旧默认确实不可用、且只有一个已配置凭据的提供商时初始化，不猜未知认证。 */
export function configuredModelDefault(state:ModelCatalogReadiness):ModelSelection|undefined{
 const {catalog,missingCredentialProviders,configuredCredentialProviders=[]}=state,current=catalog.default
 if(current&&!missingCredentialProviders.includes(current.provider)&&catalog.groups.some(group=>group.id===current.provider&&group.models.some(model=>model.id===current.model)))return
 const groups=catalog.groups.filter(group=>configuredCredentialProviders.includes(group.id)&&catalog.routableProviders.includes(group.id)&&group.models.length>0)
 if(groups.length!==1)return
 const group=groups[0]!,model=group.models[0]!
 return {provider:group.id,model:model.id,...(model.reasoning?.defaultEffort?{reasoningEffort:ReasoningEffortId(model.reasoning.defaultEffort)}:{})}
}

/** 配置变更只初始化默认与未发送的草稿，不发模型请求，也不改已有工作或本人显式选模。 */
export function createAutomaticModelDefault(ctx:Context,reader:ModelCatalogReader){
 let pending:Promise<void>|undefined,disposed=false,again=false
 const reconcile=async()=>{
  const state=await reader.read(),selected=configuredModelDefault(state)
  if(disposed||!selected)return
  // 元数据读取期间本人可能已选择其他默认；迟到的自动选择不能覆盖它。
  if(JSON.stringify(ctx.agentDefaultModel.currentSelection())!==JSON.stringify(state.catalog.default))return
  await ctx.agentDefaultModel.saveSelection(selected)
  if(disposed||JSON.stringify(ctx.agentDefaultModel.currentSelection())!==JSON.stringify(selected))return
  for(const agent of ctx.agents.list()){
   if(agent.status!=='idle'||agent.session.header.origin==='subagent'||/^(task-run-|group-routing-)/.test(agent.session.id))continue
   const selection=ctx.sessionProjections.stateOf(agent.session,'modelSelection')
   if(!selection||selection.pending||readSessionEvents(agent.session).some(event=>event.type==='request/header'||event.type==='user/message'&&event.data.source.kind==='user'))continue
   await ctx.sessionController.selectModel({sessionId:SessionId(agent.session.id),...selected})
  }
 }
 const refresh=():Promise<void>=>{
  if(pending){again=true;return pending}
  return pending=(async()=>{do{again=false;await reconcile()}while(again&&!disposed)})().finally(()=>{pending=undefined})
 }
 const changed=()=>{void refresh().catch(()=>{if(!disposed)ctx.logger.warn('默认模型初始化暂未完成，请在模型选择器核对。')})}
 const off=[ctx.on('llm/adapters-updated',changed),ctx.on('credentials/reference-updated',changed)]
 return {refresh,dispose:()=>{disposed=true;for(const dispose of off)dispose()}}
}
