import {groupWorkLinksGetInput,groupWorkLinksChangeInput,groupWorkLinksCandidatesInput,readGroupWorkLinks,readGroupWorkLinkItem,groupWorkLinkKey,type GroupWorkLink,type GroupWorkLinksChangeInput} from '@teloa/contract'
import type {GroupRequestJournal} from './group-api.js'
type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
export type GroupWorkLinkApi=ReturnType<typeof createGroupWorkLinkApi>
export function createGroupWorkLinkApi(call:Call,journal?:GroupRequestJournal,newId:()=>string=()=>crypto.randomUUID()){
 let pending:GroupWorkLinksChangeInput|undefined,recoveryError:Error|undefined,busy=false
 let revision=0;const listeners=new Set<()=>void>()
 const publish=()=>{revision++;for(const listener of listeners){try{listener()}catch{/* 视图订阅不能改变已核验的保存结果。 */}}}
 try{const raw=journal?.read();if(raw)pending=groupWorkLinksChangeInput(JSON.parse(raw))}catch{recoveryError=Error('群关联恢复记录损坏，请先核对原群。')}
 const clear=()=>{journal?.clear();pending=undefined;recoveryError=undefined}
 const save=async()=>{
  if(recoveryError)throw recoveryError
  if(!pending||busy)throw Error('请先等待当前群关联保存完成。')
  busy=true;const request=structuredClone(pending)
  try{
   journal?.write(JSON.stringify(request));const result=readGroupWorkLinks(await call('groups/work/change',request))
   if(result.groupId!==request.groupId||result.groupVersion!==request.expectedGroupVersion||result.version!==request.expectedVersion+1||JSON.stringify(result.items.map(groupWorkLinkKey).sort())!==JSON.stringify(request.links.map(groupWorkLinkKey).sort()))throw Error('群关联保存回执与原请求不一致，请核对原群。')
   clear();publish();return result
  }catch(error){if(error&&typeof error==='object'&&'rejected'in error&&error.rejected===true&&'code'in error&&['teloa/version-conflict','teloa/forbidden','teloa/invalid-input','teloa/not-found','teloa/conflict'].includes(String(error.code)))clear();throw error}finally{busy=false}
 }
 return {
  subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}},revision:()=>revision,
  pending:()=>pending?structuredClone(pending):undefined,recoveryError:()=>recoveryError,recover:save,discard:clear,
  async get(groupId:string){const result=readGroupWorkLinks(await call('groups/work/get',groupWorkLinksGetInput({groupId})));if(result.groupId!==groupId)throw Error('群关联详情与目标不一致。');return result},
  async candidates(groupId:string,scope:string,kind:GroupWorkLink['kind'],query:string){
   const input=groupWorkLinksCandidatesInput({groupId,scope,kind,query}),result=await call('groups/work/candidates',input)
   if(!Array.isArray(result)||result.length>100)throw Error('关联工作候选格式不正确。')
   const rows=result.map(readGroupWorkLinkItem);if(rows.some(row=>!row.available||row.scope!==input.scope||row.kind!==input.kind)||new Set(rows.map(groupWorkLinkKey)).size!==rows.length)throw Error('关联工作候选与请求范围不一致。');return rows
  },
  change(groupId:string,expectedGroupVersion:number,expectedVersion:number,links:GroupWorkLink[]){
   if(recoveryError)return Promise.reject(recoveryError)
   const request=groupWorkLinksChangeInput({requestId:pending?.requestId??newId(),groupId,expectedGroupVersion,expectedVersion,links})
   if(pending&&JSON.stringify(pending)!==JSON.stringify(request))return Promise.reject(Error('上次关联结果尚未核对，请先恢复原请求。'))
   pending??=request;return save()
  },
 }
}
