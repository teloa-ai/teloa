import type {TaskRun} from '@teloa/backend'
import {WorkError,readRunAnalysisScope} from '@teloa/contract'

/** 新 scope 必须经持久后端读口复核；对象上出现一个键不构成零工具准入。 */
export async function verifiedAnalysisRun(run:TaskRun,signal:AbortSignal,verify?:((run:TaskRun,signal:AbortSignal)=>Promise<boolean>)):Promise<boolean>{
 if(run.analysisScope===undefined)return false
 const scope=readRunAnalysisScope(run.analysisScope)
 if(scope.taskId!==run.taskId||scope.taskVersion!==run.taskVersion||scope.roleId!==run.roleId||scope.roleVersion!==run.roleVersion||(scope.kind==='source-derived'?scope.groupId!==run.groupContext?.groupId:run.groupContext!==undefined)||run.allowedTools.length||run.textCapability)throw new WorkError('teloa/storage-corrupt','分析范围与原运行的身份或零工具快照不一致。')
 signal.throwIfAborted()
 if(!verify||await verify(run,signal)!==true)throw new WorkError('teloa/forbidden','分析工作的可信来源读口未完成复核，不能发送。')
 signal.throwIfAborted();return true
}
