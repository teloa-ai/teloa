import {readLocalModelAddressInput,readLocalModelPullRequest,readLocalModelTargetNameInput,readLocalModelNameInput,readLocalModelsOverview,readPullJobView,type LocalModelsOverview,type PullJobView} from '@teloa/contract'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
export type LocalModelPullRequest=Omit<ReturnType<typeof readLocalModelPullRequest>,'requestId'>
export type LocalModelsApi=ReturnType<typeof createLocalModelsApi>
/** 未知提交结果保留同一请求身份；重试不能再次启动下载。读取状态后可见宿主里的真实作业。 */
export function createLocalModelsApi(call:Call,newId:()=>string=()=>crypto.randomUUID()){
 const pending=new Map<string,string>()
 const mutate=async<T>(endpoint:string,input:Record<string,unknown>,readInput:(value:unknown)=>unknown,readOutput:(value:unknown)=>T):Promise<T>=>{
  const key=endpoint+JSON.stringify(input),requestId=pending.get(key)??newId()
  pending.set(key,requestId)
  try{const value=readOutput(await call(endpoint,readInput({...input,requestId})));pending.delete(key);return value}
  catch(error){if(error&&typeof error==='object'&&('code'in error||'rejected'in error))pending.delete(key);throw error}
 }
 return {
  async overview():Promise<LocalModelsOverview>{return readLocalModelsOverview(await call('local-models/overview',{}))},
  address(baseURL:string|null){return mutate('local-models/address',{baseURL},readLocalModelAddressInput,readLocalModelsOverview)},
  pull(input:LocalModelPullRequest){return mutate('local-models/pull',{entryId:input.entryId,version:input.version,variant:input.variant,acknowledgeRestrictions:input.acknowledgeRestrictions,expectedAddress:input.expectedAddress},readLocalModelPullRequest,readPullJobView)},
  async pullStatus():Promise<PullJobView|null>{const value=await call('local-models/pull-status',{});return value===null?null:readPullJobView(value)},
  pullCancel(name:string){return mutate('local-models/pull-cancel',{name},readLocalModelNameInput,readPullJobView)},
  remove(name:string,expectedAddress:string){return mutate('local-models/remove',{name,expectedAddress},readLocalModelTargetNameInput,readLocalModelsOverview)},
  attach(name:string,expectedAddress:string){return mutate('local-models/attach',{name,expectedAddress},readLocalModelTargetNameInput,readLocalModelsOverview)},
 }
}

/** 市场 → 设置的定位状态，不放在路由地址或会话草稿里。 */
export function createLocalModelsFocus(){
 let snapshot:{entryId:string;serial:number}|undefined
 const listeners=new Set<()=>void>()
 return {getSnapshot:()=>snapshot,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},set:(entryId:string)=>{snapshot={entryId,serial:(snapshot?.serial??0)+1};for(const listener of listeners)listener()}}
}
export type LocalModelsFocus=ReturnType<typeof createLocalModelsFocus>

export function formatBytes(value:number|null):string{
 if(value===null)return '—'
 if(value<1024)return `${value} B`
 const units=['KiB','MiB','GiB','TiB'],power=Math.min(4,Math.floor(Math.log(value)/Math.log(1024)))
 return `${Number((value/1024**power).toFixed(1))} ${units[power-1]}`
}
