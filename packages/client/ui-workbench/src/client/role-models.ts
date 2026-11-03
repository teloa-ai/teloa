import {modelOption,type RoleModelField,type ModelReference,type ModelOptionsDirectory,type RoleRuntimeConfig} from '@teloa/contract'
export {modelOption,roleModelIssue,roleModelsCanSave,type RoleModelField} from '@teloa/contract'

export type RoleModelLoadState={status:'idle'|'loading'|'ready'|'error';directory?:ModelOptionsDirectory}
export const modelOptionValue=(model:ModelReference)=>JSON.stringify([model.provider,model.model])
export function roleModelLabel(reference:ModelReference,directory?:ModelOptionsDirectory):string{
 const option=modelOption(directory,reference)
 return `${option?.model.name??reference.model} · ${option?.group.name??reference.provider}${reference.reasoningEffort?` · ${option?.model.reasoning?.efforts.find(row=>row.id===reference.reasoningEffort)?.name??reference.reasoningEffort}`:''}`
}
export function patchRoleModel(runtime:RoleRuntimeConfig|undefined,field:RoleModelField,model:ModelReference|undefined):RoleRuntimeConfig|undefined{
 const next={...runtime};if(field==='model')delete next.fallbackModel;if(model)next[field]=model;else delete next[field]
 return Object.keys(next).length?next:undefined
}
/** select 的值只在已读取目录内解析，不能从 DOM 注入新路由。 */
export function findRoleModel(directory:ModelOptionsDirectory,value:string):ModelReference|undefined{
 for(const group of directory.groups)if(!group.credentialMissing)for(const model of group.models){const ref={provider:group.id,model:model.id};if(modelOptionValue(ref)===value)return ref}
 return undefined
}
