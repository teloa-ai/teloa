import {readWorkAttentionPage,taskInput,WorkError,type WorkAttentionPage} from '@teloa/contract'
import type {WorkAttentionQuery} from '@teloa/backend'

type Ports={listWorkAttention:(owner:string,input:WorkAttentionQuery)=>Promise<unknown>}

/** 固定宿主本人，目录只读；取消后不将迟答交回新视图。 */
export function createWorkAttentionHandler(owner:string,get:()=>Promise<Ports>){
 return async(payload:unknown,signal?:AbortSignal):Promise<WorkAttentionPage>=>{
  if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const input=taskInput(payload,['scope','cursor','limit']) as WorkAttentionQuery
  signal?.throwIfAborted()
  const ports=await get()
  signal?.throwIfAborted()
  const result=await ports.listWorkAttention(owner,input)
  signal?.throwIfAborted()
  return readWorkAttentionPage(result)
 }
}
