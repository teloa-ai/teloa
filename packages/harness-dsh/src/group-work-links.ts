import {WorkError,groupWorkLinksGetInput,groupWorkLinksChangeInput,groupWorkLinksCandidatesInput} from '@teloa/contract'
import type {GroupWorkLinkService} from '@teloa/backend'
export const groupWorkLinkEndpoints=['groups/work/get','groups/work/change','groups/work/candidates'] as const
export function createGroupWorkLinkHandler(owner:string,get:()=>Promise<Pick<GroupWorkLinkService,'get'|'change'|'candidates'>>){
 return async(endpoint:string,input:unknown,signal?:AbortSignal,revalidate?:()=>Promise<void>)=>{
  signal?.throwIfAborted()
  if(endpoint==='groups/work/get'){groupWorkLinksGetInput(input);return (await get()).get(owner,input)}
  if(endpoint==='groups/work/candidates'){groupWorkLinksCandidatesInput(input);return (await get()).candidates(owner,input)}
  if(endpoint==='groups/work/change'){groupWorkLinksChangeInput(input);return (await get()).change(owner,input,signal,revalidate)}
  throw new WorkError('teloa/not-found','未提供此群关联接口。')
 }
}
