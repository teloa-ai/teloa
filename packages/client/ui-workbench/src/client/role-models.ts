import {sameModelRoute,type ModelReference,type ModelOptionsDirectory,type RoleRuntimeConfig} from '@teloa/contract'

export type RoleModelLoadState={status:'idle'|'loading'|'ready'|'error';directory?:ModelOptionsDirectory}
export type RoleModelField='model'|'fallbackModel'
export const modelOptionValue=(model:ModelReference)=>JSON.stringify([model.provider,model.model])
export function modelOption(directory:ModelOptionsDirectory|undefined,reference:ModelReference|undefined){
 const group=directory?.groups.find(group=>group.id===reference?.provider)
 const model=group?.models.find(model=>model.id===reference?.model)
 return group&&model?{group,model}:undefined
}
export function roleModelLabel(reference:ModelReference,directory?:ModelOptionsDirectory):string{
 const option=modelOption(directory,reference)
 return `${option?.model.name??reference.model} · ${option?.group.name??reference.provider}${reference.reasoningEffort?` · ${option?.model.reasoning?.efforts.find(row=>row.id===reference.reasoningEffort)?.name??reference.reasoningEffort}`:''}`
}
export function roleModelIssue(field:RoleModelField,runtime:RoleRuntimeConfig|undefined,directory:ModelOptionsDirectory|undefined):'missing'|'effort'|'remote'|'same'|undefined{
 const reference=runtime?.[field]
 if(!reference||!directory)return undefined
 const found=modelOption(directory,reference)
 if(!found)return 'missing'
 if(reference.reasoningEffort&&!found.model.reasoning?.efforts.some(effort=>effort.id===reference.reasoningEffort))return 'effort'
 if(field==='fallbackModel'){
  if(!found.group.remote)return 'remote'
  const primary=runtime?.model??directory.default
  if(primary&&sameModelRoute(primary,reference))return 'same'
 }
 return undefined
}
/** 其他字段的编辑不擦除失效模型；明确改选的模型必须来自本次读取的原生目录。 */
export function roleModelsCanSave(initial:RoleRuntimeConfig|undefined,runtime:RoleRuntimeConfig|undefined,directory:ModelOptionsDirectory|undefined):boolean{
 const changed=(['model','fallbackModel'] as const).filter(field=>JSON.stringify(initial?.[field])!==JSON.stringify(runtime?.[field]))
 if(!changed.length)return true
 if(!runtime?.model&&!runtime?.fallbackModel)return true
 return !!directory&&!roleModelIssue('model',runtime,directory)&&!roleModelIssue('fallbackModel',runtime,directory)
}
export function patchRoleModel(runtime:RoleRuntimeConfig|undefined,field:RoleModelField,model:ModelReference|undefined):RoleRuntimeConfig|undefined{
 const next={...runtime};if(model)next[field]=model;else delete next[field]
 return Object.keys(next).length?next:undefined
}
/** select 的值只在已读取目录内解析，不能从 DOM 注入新路由。 */
export function findRoleModel(directory:ModelOptionsDirectory,value:string):ModelReference|undefined{
 for(const group of directory.groups)for(const model of group.models){const ref={provider:group.id,model:model.id};if(modelOptionValue(ref)===value)return ref}
 return undefined
}
