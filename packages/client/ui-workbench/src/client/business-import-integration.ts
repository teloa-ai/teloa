import {builderJournalKey} from './business-builder-controller.ts'
import type {BusinessBuilderApi} from './business-builder-api.js'
import {createBusinessImportApi} from './business-import-api.ts'
import {BusinessImportFlow} from './business-import-flow.ts'
import {createBusinessRecordApi} from './business-record-api.ts'
type Wire={ok:true;value:unknown}|{ok:false;error:{code:string;message:string}}
type Ports={ownerId:string;identity:()=>{status:string;namespace:string|null;api:BusinessBuilderApi|null};generation:()=>object|undefined;storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>;call:(endpoint:string,input:unknown,signal?:AbortSignal)=>Promise<Wire>}
export type BusinessImportTargetFactory=(scope:string,type:string)=>BusinessImportFlow
/** 当前代次缓存稿件；卸载或身份变化仅销毁实例，不删除跨刷新恢复所需的原请求。 */
export function createBusinessImportFlowFactory(ports:Ports){
 const flows=new Set<BusinessImportFlow>();let disposed=false
 const invalidate=()=>{for(const flow of flows)if(!flow.isCurrent()){flow.dispose();flows.delete(flow)}}
 const forTarget=(namespace:string,token:BusinessBuilderApi,scope:string,type:string)=>{
  const prefix='teloa.business-builder/v1/personal-space/',space=namespace.slice(prefix.length),generation=ports.generation(),identity=ports.identity()
  if(disposed||!ports.ownerId||!namespace.startsWith(prefix)||builderJournalKey(space)!==namespace||!generation||identity.status!=='ready'||identity.namespace!==namespace||identity.api!==token)throw Error('本人业务空间和连接尚未确认。')
  invalidate()
  for(const flow of flows)if(flow.scope===scope&&flow.type===type)return flow
  const isCurrent=()=>{const now=ports.identity();return !disposed&&ports.generation()===generation&&now.status==='ready'&&now.namespace===namespace&&now.api===token}
  const call=async(endpoint:string,input:unknown,signal?:AbortSignal)=>{
   if(!isCurrent()||signal?.aborted)throw Error('本人业务连接已变化。')
   const result=await ports.call(endpoint,input,signal)
   if(!isCurrent()||signal?.aborted)throw Error('本人业务连接已变化。')
   if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code})
   return result.value
  }
  const key=namespace+'/imports/'+encodeURIComponent(JSON.stringify([ports.ownerId,scope,type])),storage=ports.storage
  const flow=new BusinessImportFlow({api:createBusinessImportApi(call),records:createBusinessRecordApi(call),ownerId:ports.ownerId,personalSpaceId:space,scope,type,isCurrent,journal:{
   read:()=>storage.getItem(key),
   write:value=>{storage.setItem(key,value);if(storage.getItem(key)!==value)throw Error('导入恢复记录未可靠保存。')},
   clear:()=>{storage.removeItem(key);if(storage.getItem(key)!==null)throw Error('导入恢复记录未可靠清除。')},
  }})
  flows.add(flow);return flow
 }
 return {forTarget,invalidate,dispose:()=>{disposed=true;for(const flow of flows)flow.dispose();flows.clear()}}
}
