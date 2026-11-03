import {WorkError} from './work-error.ts'
import {readModelReference,sameModelRoute,type ModelReference} from './model-policy.ts'
import type {RoleRuntimeConfig} from './roles.ts'

export const modelOptionEndpoints=['model-options/list'] as const
export type ModelOption={id:string;name:string;reasoning?:{efforts:{id:string;name:string}[];defaultEffort?:string}}
export type ModelOptionsDirectory={default:ModelReference|null;groups:{id:string;name:string;remote:boolean;credentialMissing?:true;models:ModelOption[]}[];failures:{id:string;name:string}[]}
export type RoleModelField='model'|'fallbackModel'
export function modelOption(directory:ModelOptionsDirectory|undefined,reference:ModelReference|undefined){
 const group=directory?.groups.find(group=>group.id===reference?.provider)
 const model=group?.models.find(model=>model.id===reference?.model)
 return group&&model?{group,model}:undefined
}
export function roleModelIssue(field:RoleModelField,runtime:RoleRuntimeConfig|undefined,directory:ModelOptionsDirectory|undefined):'missing'|'credential'|'effort'|'remote'|'same'|undefined{
 const reference=runtime?.[field]
 if(!reference||!directory)return undefined
 const found=modelOption(directory,reference)
 if(!found)return 'missing'
 if(found.group.credentialMissing)return 'credential'
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
const invalid=()=>new WorkError('teloa/source-invalid','模型目录格式不正确。')
const record=(value:unknown,keys:string[]):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid()
 return value as Record<string,unknown>
}
const label=(value:unknown):string=>{if(typeof value!=='string'||!value.trim()||value.length>512||/[\x00-\x1f\x7f]/.test(value))throw invalid();return value}
const rows=<T>(value:unknown,read:(row:unknown)=>T&{id:string},max=10000):T[]=>{
 if(!Array.isArray(value)||value.length>max)throw invalid()
 const result=value.map(read);if(new Set(result.map(row=>row.id)).size!==result.length)throw invalid();return result
}
/** 白名单投影的目录只含显示名与选择能力，不接受地址、密钥或服务错误原文。 */
export function readModelOptionsDirectory(value:unknown):ModelOptionsDirectory{
 const root=record(value,['default','groups','failures'])
 return {default:root.default===null?null:readModelReference(root.default),groups:rows(root.groups,value=>{
  const group=record(value,['id','name','remote','models','credentialMissing']),id=readModelReference({provider:group.id,model:'model'}).provider
  if(typeof group.remote!=='boolean'||group.credentialMissing!==undefined&&group.credentialMissing!==true)throw invalid()
  return {id,name:label(group.name),remote:group.remote,...(group.credentialMissing===true?{credentialMissing:true as const}:{}),models:rows(group.models,value=>{
   const model=record(value,['id','name','reasoning']),modelId=readModelReference({provider:id,model:model.id}).model
   if(model.reasoning===undefined)return {id:modelId,name:label(model.name)}
   const reasoning=record(model.reasoning,['efforts','defaultEffort']),efforts=rows(reasoning.efforts,value=>{
    const effort=record(value,['id','name']);return {id:readModelReference({provider:id,model:modelId,reasoningEffort:effort.id}).reasoningEffort!,name:label(effort.name)}
   },128)
   if(reasoning.defaultEffort!==undefined&&!efforts.some(effort=>effort.id===reasoning.defaultEffort))throw invalid()
   return {id:modelId,name:label(model.name),reasoning:{efforts,...(reasoning.defaultEffort===undefined?{}:{defaultEffort:reasoning.defaultEffort as string})}}
  })}
 },1000),failures:rows(root.failures,value=>{const row=record(value,['id','name']);return {id:readModelReference({provider:row.id,model:'model'}).provider,name:label(row.name)}},1000)}
}
