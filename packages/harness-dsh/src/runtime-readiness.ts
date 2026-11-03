import {WorkError,taskInput} from '@teloa/contract'

export const runtimeReadinessEndpoint='runtime/readiness'
type ReadinessPorts={database:()=>Promise<void>;conversations:()=>Promise<unknown>}

/** 就绪只核真实数据库和本地目录存储；历史运行的完整证明仍在业务读口核验。 */
export function createRuntimeReadinessHandler(owner:string,ports:ReadinessPorts){
 return async(payload:unknown,signal:AbortSignal)=>{
  if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','缺少可信主体。')
  taskInput(payload,[]);signal.throwIfAborted()
  await ports.database();signal.throwIfAborted()
  await ports.conversations();signal.throwIfAborted()
  return {schema:'teloa.runtime-readiness/v1',ready:true} as const
 }
}
