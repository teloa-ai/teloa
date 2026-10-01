import type {Context} from '@deepseek-ai/cordis'
import type {AgentDefaultModelConfig} from '@deepseek-ai/dsh-agent-default-model'
import type {SessionController,SessionSelectModelRequest} from '@deepseek-ai/dsh-api-session-controller'
import type {ModelSelection} from '@deepseek-ai/dsh-agent'
import {sessionModelSelectionScope} from './session-model-scope.ts'

export const inject=['sessionController','agentDefaultModel']

/**
 * rc.1 的选模没有仅当前会话参数或保存默认前事件。保留原生 Host/Client 双端插件及配置行，
 * 在两个公开方法外加生命周期内的固定包装；不替换原生验证、缓存、图片锁、日志或发送流程。
 * AsyncLocalStorage 隔离每次调用，绝不临时换掉全局服务来处理并发请求。
 */
export function apply(ctx:Context):void{
 const controller=ctx.sessionController,defaults=ctx.agentDefaultModel
 ctx.effect(()=>{
  const select=controller.selectModel,save=defaults.saveSelection
  const pending=new Set<ReturnType<SessionController['selectModel']>>()
  function selectModel(this:SessionController,request:SessionSelectModelRequest){
   const task=(async()=>{
    const scope=ctx.get('teloaSessionModelScope')
    // 归属服务缺席或失败都只收紧（不写全局默认）；缺席属装配问题，记日志便于排查。
    let identityLinked=true
    if(!scope)ctx.logger.warn('会话归属服务未就绪，本次模型选择不改写全局默认。')
    else try{identityLinked=await scope.isIdentityLinked(request.sessionId)}
    catch{ctx.logger.warn('会话归属暂不可核对，本次模型选择不改写全局默认。')}
    return sessionModelSelectionScope.run(identityLinked?request.sessionId:undefined,()=>select.call(this,request))
   })()
   pending.add(task)
   void task.then(()=>pending.delete(task),()=>pending.delete(task))
   return task
  }
  async function saveSelection(this:AgentDefaultModelConfig,next:ModelSelection):Promise<void>{
   if(!sessionModelSelectionScope.active())await save.call(this,next)
  }
  controller.selectModel=selectModel
  defaults.saveSelection=saveSelection
  return async()=>{
   // 先等在途选择离开原生保存点；否则卸载会使已开始的分身请求误写全局默认。
   while(pending.size)await Promise.allSettled([...pending])
   if(controller.selectModel===selectModel)controller.selectModel=select
   if(defaults.saveSelection===saveSelection)defaults.saveSelection=save
  }
 })
}
