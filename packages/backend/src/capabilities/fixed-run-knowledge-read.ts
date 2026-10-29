import {WorkError} from '@teloa/contract'
import type {PoolClient} from 'pg'

declare const fixedRunKnowledgeRead:unique symbol
/** 仅进程内传递；JSON、模型参数和任意 runId 都不能构造此能力。 */
export type FixedRunKnowledgeRead={readonly [fixedRunKnowledgeRead]:true}
type Reference={id:string;sourceId:string;sourceVersion:string}
const issued=new WeakMap<object,{ownerId:string;runId:string;references:readonly Reference[]}>()
/** 仅 TaskRunService 在核验真实执行轨迹和当前授权后签发；不从包入口导出。 */
export function createFixedRunKnowledgeRead(ownerId:string,runId:string,references:readonly Reference[]):FixedRunKnowledgeRead{
 const capability=Object.freeze({}) as FixedRunKnowledgeRead
 issued.set(capability,{ownerId,runId,references:Object.freeze(references.map(ref=>Object.freeze({id:ref.id,sourceId:ref.sourceId,sourceVersion:ref.sourceVersion})))})
 return capability
}
export function authorizeFixedRunKnowledgeRead(capability:FixedRunKnowledgeRead|undefined,ownerId:string,resourceId:string|undefined,sourceId:string,sourceVersion:string):string{
 const fixed=capability&&issued.get(capability)
 if(!fixed||fixed.ownerId!==ownerId||!fixed.references.some(ref=>ref.id===resourceId&&ref.sourceId===sourceId&&ref.sourceVersion===sourceVersion))throw new WorkError('teloa/not-found','旧正文仅允许原执行读取自己的固定快照。')
 return fixed.runId
}
export async function assertFixedRunKnowledgeReadInTransaction(db:Pick<PoolClient,'query'>,capability:FixedRunKnowledgeRead|undefined,ownerId:string,resourceId:string|undefined,sourceId:string,sourceVersion:string):Promise<void>{
 const runId=authorizeFixedRunKnowledgeRead(capability,ownerId,resourceId,sourceId,sourceVersion)
 if((await db.query("select to_regclass('teloa_task_runs') as present")).rows[0]?.present==null)throw new WorkError('teloa/not-found','原执行固定快照不存在。')
 const found=(await db.query(`select 1 from teloa_task_runs r where r.owner_id=$1 and r.id=$2 and exists(select 1 from jsonb_array_elements(r.role_knowledge) k where k->>'id'=$3 and lower(k->>'sourceId')=$4 and k->>'sourceVersion'=$5) limit 1`,[ownerId,runId,resourceId,sourceId.toLowerCase(),sourceVersion])).rowCount
 if(!found)throw new WorkError('teloa/not-found','旧正文仅允许原执行读取自己的固定快照。')
}
