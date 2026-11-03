import {WorkError,readTaskRunMemorySelection} from '@teloa/contract'
import type {TaskRun,TaskRunSkillDatabase} from '@teloa/backend'

/** 两处经验适配共用原Run的固定选择；只读且同时绑定主体、会话与原生请求。 */
export async function taskRunHasExplicitMemorySelection(db:Pick<TaskRunSkillDatabase,'query'>,owner:string,run:Pick<TaskRun,'id'|'sessionId'|'nativeRequestId'>):Promise<boolean>{
 const rows=(await db.query('select request_spec from teloa_task_runs where owner_id=$1 and id=$2 and session_id=$3 and native_request_id=$4',[owner,run.id,run.sessionId,run.nativeRequestId])).rows
 const spec=rows[0]?.request_spec
 if(rows.length!==1||!spec||typeof spec!=='object'||Array.isArray(spec))throw new WorkError('teloa/forbidden','本次执行的经验选择无法核对。')
 return readTaskRunMemorySelection(spec.selectedMemoryIds)!==undefined
}
