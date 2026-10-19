import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isGroupOwnerRequest,type GroupOwnerRequest} from '@teloa/contract'
import {readStoredTaskRun,readRunGroupContinuation} from './task-runs.ts'

type Database=Pick<PoolClient,'query'>
const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
/** 仅沿同群可信回帖的冻结输入追溯本人来源，不读最新Task目标，不把员工生成文字升级为指令。 */
export async function readGroupOwnerRequest(db:Database,owner:string,groupId:string,messageId:string,pool:Pool):Promise<GroupOwnerRequest>{
 const checked=new Set<string>()
 const own=async(id:string,expected?:GroupOwnerRequest):Promise<GroupOwnerRequest>=>{
  const row=(await db.query('select author_id,text from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,groupId,id])).rows[0]
  if(!row||row.author_id!=='self'||typeof row.text!=='string')throw new WorkError('teloa/forbidden','交接所需的本人原消息不可核实。')
  const result={messageId:id,text:row.text,sha256:digest(row.text)}
  if(expected&&(expected.text!==result.text||expected.sha256!==result.sha256))throw new WorkError('teloa/storage-corrupt','交接的本人固定目标摘要不一致。')
  return result
 }
 for(let hop=0;hop<16;hop++){
  if(checked.has(messageId))throw new WorkError('teloa/storage-corrupt','交接来源循环，不能确认本人原目标。')
  checked.add(messageId)
  const message=(await db.query('select author_id from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,groupId,messageId])).rows[0]
  if(message?.author_id==='self')return own(messageId)
  const {readTrustedGroupMessageRunSource}=await import('./group-routing-outbox.ts')
  const source=await readTrustedGroupMessageRunSource(db,owner,{groupId,messageId},pool)
  if(!source)throw new WorkError('teloa/forbidden','员工工作交接缺少可信原运行来源。')
  const raw=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,source.runId])).rows[0]
  const run=readStoredTaskRun(raw)
  const inherited=run.groupContext?.ownerRequest
  if(inherited&&!isGroupOwnerRequest(inherited))throw new WorkError('teloa/storage-corrupt','交接本人来源不完整。')
  const input=JSON.parse(run.inputText) as Record<string,unknown>
  if(input.groupContinuation!==undefined){
   const continuation=readRunGroupContinuation(input.groupContinuation)
   const current=await own(continuation.messageId,{messageId:continuation.messageId,text:continuation.text,sha256:digest(continuation.text)})
   const previous=inherited??(run.groupContext?await readGroupOwnerRequest(db,owner,groupId,run.groupContext.source.messageId,pool):undefined)
   if(previous){
    const prior=[...(previous.priorRequests??[]),{messageId:previous.messageId,text:previous.text,sha256:previous.sha256}].filter(item=>item.messageId!==current.messageId)
    const unique=[...new Map(prior.map(item=>[item.messageId,item])).values()]
    if(unique.length>16)throw new WorkError('teloa/conflict','本人追加来源超过本轮固定上限，请核对原工作。')
    return {...current,...(unique.length?{priorRequests:await Promise.all(unique.map(item=>own(item.messageId,item)))}:{})}
   }
   return current
  }
  if(inherited){await Promise.all((inherited.priorRequests??[]).map(item=>own(item.messageId,item)));return {...await own(inherited.messageId,inherited),...(inherited.priorRequests?{priorRequests:inherited.priorRequests}:{})}}
  if(!run.groupContext)break
  messageId=run.groupContext.source.messageId
 }
 throw new WorkError('teloa/forbidden','无法确认本次交接沿用的本人原目标，请核对原工作来源。')
}
