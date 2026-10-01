import type {Context} from '@deepseek-ai/cordis'
import {WorkError,taskInput,readModelOptionsDirectory,type ModelOptionsDirectory} from '@teloa/contract'
import {isDshRemoteModel} from './task-model-dsh.ts'

/** 复用 DSH 0.1.7-rc.1 公开 modelCatalog；不建立第二份可写模型目录。 */
export async function readDshModelOptions(ctx:Context,payload:unknown,signal:AbortSignal):Promise<ModelOptionsDirectory>{
 taskInput(payload,[]);signal.throwIfAborted()
 try{
  const catalog=await ctx.sessionController.modelCatalog();signal.throwIfAborted()
  return readModelOptionsDirectory({
   default:catalog.default?.provider&&catalog.default.model?catalog.default:null,
   groups:catalog.groups.filter(group=>catalog.routableProviders.includes(group.id)).map(group=>({
    id:group.id,name:group.name,remote:isDshRemoteModel(ctx,{provider:group.id,model:group.models[0]?.id??'model'}),
    models:group.models.map(model=>({id:model.id,name:model.name,...(model.reasoning?{reasoning:{efforts:model.reasoning.efforts.map(effort=>({id:effort.id,name:effort.name})),...(model.reasoning.defaultEffort===undefined?{}:{defaultEffort:model.reasoning.defaultEffort})}}:{})})),
   })),
   failures:catalog.failures.map(({id,name})=>({id,name})),
  })
 }catch{signal.throwIfAborted();throw new WorkError('teloa/source-unavailable','暂时无法读取模型目录，请重试。')}
}
