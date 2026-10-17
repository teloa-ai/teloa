import type {Context} from '@deepseek-ai/cordis'
import {WorkError,taskInput,readModelOptionsDirectory,type ModelOptionsDirectory} from '@teloa/contract'
import {isDshRemoteModel} from './task-model-dsh.ts'

/** 管理界面沿同一个官方目录保留缺密钥名称，只有状态标记，不接受密钥或地址。 */
export async function readDshModelOptions(ctx:Context,payload:unknown,signal:AbortSignal):Promise<ModelOptionsDirectory>{
 taskInput(payload,[]);signal.throwIfAborted()
 try{
  const {catalog,missingCredentialProviders}=await ctx.teloaModelCatalog.read(signal);signal.throwIfAborted()
  const missing=new Set(missingCredentialProviders)
  return readModelOptionsDirectory({
   default:catalog.default?.provider&&catalog.default.model?catalog.default:null,
   groups:catalog.groups.filter(group=>catalog.routableProviders.includes(group.id)).map(group=>({
    id:group.id,name:group.name,remote:isDshRemoteModel(ctx,{provider:group.id,model:group.models[0]?.id??'model'}),...(missing.has(group.id)?{credentialMissing:true}:{}),
    models:group.models.map(model=>({id:model.id,name:model.name,...(model.reasoning?{reasoning:{efforts:model.reasoning.efforts.map(effort=>({id:effort.id,name:effort.name})),...(model.reasoning.defaultEffort===undefined?{}:{defaultEffort:model.reasoning.defaultEffort})}}:{})})),
   })),
   failures:catalog.failures.map(({id,name})=>({id,name})),
  })
 }catch{signal.throwIfAborted();throw new WorkError('teloa/source-unavailable','暂时无法读取模型目录，请重试。')}
}
