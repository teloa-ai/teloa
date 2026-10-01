import { WorkError } from './work-error.ts'
import {readModelReference,sameModelRoute,type ModelReference,type TaskRunModelPolicy} from './model-policy.ts'
export type RoleResponsibility={triggers:string[];autonomousActions:string[];confirmationPoints:string[];escalationRules:string[];deliveryChecks:string[]}
export type RoleRuntimeConfig={agentPresetId?:string;model?:ModelReference;fallbackModel?:ModelReference}
export type RoleDefinition={name:string;kind:'employee'|'twin';scopes:string[];duty:string;dataScope:string;executionScope:string;skills:string[];knowledge:string[];responsibility?:RoleResponsibility;runtimeConfig?:RoleRuntimeConfig}
export type WritableRoleDefinition=RoleDefinition&{responsibility:RoleResponsibility}
/** 能力名称是声明；不代表已安装、可用或获得授权。 */
export type DigitalRole=RoleDefinition&{id:string;ownerId:string;version:number;state:'active'|'paused'|'retired';createdAt:string;updatedAt:string}
export function roleInput(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new WorkError('teloa/invalid-input','员工请求包含未知字段或格式不正确。')
 return value as Record<string,unknown>
}
export function readRoleRuntimeConfig(value:unknown):RoleRuntimeConfig{
 const source=roleInput(value,['agentPresetId','model','fallbackModel'])
 if(!Object.keys(source).length||source.agentPresetId!==undefined&&(typeof source.agentPresetId!=='string'||! /^[a-z0-9][-a-z0-9]{0,119}$/.test(source.agentPresetId)))throw new WorkError('teloa/invalid-input','员工运行配置不合法。')
 const model=source.model===undefined?undefined:readModelReference(source.model),fallbackModel=source.fallbackModel===undefined?undefined:readModelReference(source.fallbackModel)
 if(model&&fallbackModel&&sameModelRoute(model,fallbackModel))throw new WorkError('teloa/invalid-input','备用模型不能与首选模型相同。')
 const result={...(source.agentPresetId===undefined?{}:{agentPresetId:source.agentPresetId as string}),...(model?{model}:{}),...(fallbackModel?{fallbackModel}:{})}
 if(!Object.keys(result).length)throw new WorkError('teloa/invalid-input','员工运行配置不合法。')
 return result
}
/** 岗位明确指定的模型不能在准备或回读时被默认选择悄悄替换。 */
export function assertRoleModelPolicy(runtime:RoleRuntimeConfig|undefined,policy:TaskRunModelPolicy):void{
 if(runtime?.model&&JSON.stringify(runtime.model)!==JSON.stringify(policy.primary)||runtime?.fallbackModel&&JSON.stringify(runtime.fallbackModel)!==JSON.stringify(policy.fallback))throw new WorkError('teloa/invalid-input','任务模型与员工明确选择不一致。')
}
export function roleDefinition(value:unknown):RoleDefinition{
 const row=roleInput(value,['name','kind','scopes','duty','dataScope','executionScope','skills','knowledge','responsibility','runtimeConfig'])
 const fail=():never=>{throw new WorkError('teloa/invalid-input','员工职责、范围或能力声明不合法。')}
 const text=(v:unknown,max:number):string=>typeof v==='string'&&v.trim().length>0&&v.length<=max?v.trim():fail()
 const list=(v:unknown,ids=false):string[]=>{
  if(!Array.isArray(v)||v.length>30||(ids&&!v.length))return fail()
  const items=v.map(item=>text(item,128));if(ids&&items.some(item=>!/^[-a-zA-Z0-9_]+$/.test(item)))return fail()
  return [...new Set(items)]
 }
 if(row.kind!=='employee'&&row.kind!=='twin')return fail()
 let responsibility:RoleResponsibility|undefined
 if(row.responsibility!==undefined){
  const source=roleInput(row.responsibility,['triggers','autonomousActions','confirmationPoints','escalationRules','deliveryChecks'])
  const entries=(value:unknown):string[]=>{
   if(!Array.isArray(value)||value.length>30)return fail()
   return [...new Set(value.map(item=>text(item,1000)))]
  }
  responsibility={triggers:entries(source.triggers),autonomousActions:entries(source.autonomousActions),confirmationPoints:entries(source.confirmationPoints),escalationRules:entries(source.escalationRules),deliveryChecks:entries(source.deliveryChecks)}
 }
 let runtimeConfig:RoleRuntimeConfig|undefined
 if(row.runtimeConfig!==undefined){
  runtimeConfig=readRoleRuntimeConfig(row.runtimeConfig)
 }
 return {name:text(row.name,80),kind:row.kind,scopes:list(row.scopes,true),duty:text(row.duty,4000),dataScope:text(row.dataScope,4000),executionScope:text(row.executionScope,4000),skills:list(row.skills),knowledge:list(row.knowledge),...(responsibility?{responsibility}:{}),...(runtimeConfig?{runtimeConfig}:{})}
}
/** 新建和编辑必须显式提交完整职责；运行配置允许保持未固定。 */
export function roleWriteDefinition(value:unknown):WritableRoleDefinition{
 const definition=roleDefinition(value)
 if(!definition.responsibility)throw new WorkError('teloa/invalid-input','新建或修改员工时需要提交完整结构化职责。')
 return definition as WritableRoleDefinition
}
