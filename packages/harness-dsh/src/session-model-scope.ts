import {AsyncLocalStorage} from 'node:async_hooks'

/** 仅包围一次官方 selectModel 调用；并发普通会话不共享这次选择的副作用边界。 */
const sessionSelection=new AsyncLocalStorage<string|undefined>()
export const sessionModelSelectionScope={
 run:<T>(sessionId:string|undefined,operation:()=>T):T=>sessionSelection.run(sessionId,operation),
 active:():boolean=>sessionSelection.getStore()!==undefined,
}

/** 会话是否关联分身/员工身份：关联的会话选模只作用于该会话，不写全局默认。 */
export type SessionModelScope={isIdentityLinked:(sessionId:string)=>Promise<boolean>}
declare module '@deepseek-ai/cordis'{
 interface Context{teloaSessionModelScope:SessionModelScope}
}
