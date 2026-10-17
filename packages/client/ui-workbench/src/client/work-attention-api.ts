import {WorkError,readWorkAttentionPage,workAttentionPageLimit,type WorkAttentionPage} from '@teloa/contract'

export type WorkAttentionQuery={scope?:string;cursor?:string;limit?:number}
export type WorkAttentionApi=ReturnType<typeof createWorkAttentionApi>
type Call=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max

/** 原真源的只读分页；不持久化另一份待办，也不在读取时批准、忽略或落定任何对象。 */
export function createWorkAttentionApi(call:Call){
 return {
  async list(query:WorkAttentionQuery={},signal?:AbortSignal):Promise<WorkAttentionPage>{
   if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(key=>!['scope','cursor','limit'].includes(key))||query.scope!==undefined&&!text(query.scope,120)||query.cursor!==undefined&&!text(query.cursor,512)||query.limit!==undefined&&(!Number.isSafeInteger(query.limit)||query.limit<1||query.limit>workAttentionPageLimit))throw new WorkError('teloa/invalid-input','需要你目录的查询格式不正确。')
   const payload={...(query.scope===undefined?{}:{scope:query.scope}),...(query.cursor===undefined?{}:{cursor:query.cursor}),...(query.limit===undefined?{}:{limit:query.limit})}
   return readWorkAttentionPage(await call('work-attention',payload,signal))
  },
 }
}
