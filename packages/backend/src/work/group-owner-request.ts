import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isGroupOwnerRequest,type GroupOwnerRequest,type GroupTaskSource} from '@teloa/contract'
import {readStoredTaskRun,readRunGroupContinuation} from './task-runs.ts'
import {readGroupWorkOwnerMessages} from './group-work-inputs.ts'

type Database=Pick<PoolClient,'query'>
type OwnerMessage=Omit<GroupOwnerRequest,'priorRequests'>
const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
const messages=(value:GroupOwnerRequest):OwnerMessage[]=>[...(value.priorRequests??[]),{messageId:value.messageId,text:value.text,sha256:value.sha256}]
function merge(...parts:readonly OwnerMessage[][]):OwnerMessage[]{
 const result=new Map<string,OwnerMessage>()
 for(const item of parts.flat()){
  const previous=result.get(item.messageId)
  if(previous&&(previous.text!==item.text||previous.sha256!==item.sha256))throw new WorkError('teloa/storage-corrupt','本人固定来源摘要不一致。')
  result.set(item.messageId,item)
 }
 return [...result.values()]
}
function assertSelection(available:readonly OwnerMessage[],selected:readonly OwnerMessage[]):void{
 const indices=new Map(available.map((item,index)=>[item.messageId,{item,index}]))
 let last=-1
 for(const item of selected){
  const found=indices.get(item.messageId)
  if(!found||found.index<=last||found.item.text!==item.text||found.item.sha256!==item.sha256)throw new WorkError('teloa/forbidden','群运行的本人来源不属于固定原任务。')
  last=found.index
 }
}
function request(chain:readonly OwnerMessage[]):GroupOwnerRequest{
 const current=chain.at(-1)
 if(!current)throw new WorkError('teloa/forbidden','无法确认本人原工作来源。')
 const prior=chain.slice(0,-1)
 if(prior.length>16)throw new WorkError('teloa/conflict','本人追加来源超过本轮固定上限，请核对原工作。')
 return {...current,...(prior.length?{priorRequests:prior}:{})}
}
/** 只沿可信回帖的 source Run 固定版本追溯；旧链可为完整可信链的有序选择，不读群历史或最新 Task 目标。 */
async function readChain(db:Database,owner:string,groupId:string,messageId:string,pool:Pool):Promise<OwnerMessage[]>{
 const checked=new Set<string>()
 const own=async(id:string,expected?:OwnerMessage):Promise<OwnerMessage>=>{
  const row=(await db.query('select author_id,text from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,groupId,id])).rows[0]
  if(!row||row.author_id!=='self'||typeof row.text!=='string')throw new WorkError('teloa/forbidden','交接所需的本人原消息不可核实。')
  const result={messageId:id,text:row.text,sha256:digest(row.text)}
  if(expected&&(expected.text!==result.text||expected.sha256!==result.sha256))throw new WorkError('teloa/storage-corrupt','交接的本人固定目标摘要不一致。')
  return result
 }
 const read=async(id:string):Promise<OwnerMessage[]>=>{
  if(checked.has(id)||checked.size>=16)throw new WorkError('teloa/storage-corrupt','交接来源循环或超过追溯上限，不能确认本人原目标。')
  checked.add(id)
  const message=(await db.query('select author_id from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,groupId,id])).rows[0]
  if(message?.author_id==='self')return [await own(id)]
  const {readTrustedGroupMessageRunSource}=await import('./group-routing-outbox.ts')
  const source=await readTrustedGroupMessageRunSource(db,owner,{groupId,messageId:id},pool)
  if(!source){
   const {readTrustedGroupReplySource}=await import('./group-reply-executions.ts'),reply=await readTrustedGroupReplySource(db,owner,{groupId,messageId:id})
   if(!reply)throw new WorkError('teloa/forbidden','员工工作交接缺少可信原执行来源。')
   const previous=await read(reply.snapshot.messageId),fixed=messages(reply.snapshot.ownerRequest)
   await Promise.all(fixed.map(item=>own(item.messageId,item)));assertSelection(previous,fixed);return previous
  }
  const raw=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,source.runId])).rows[0],run=readStoredTaskRun(raw)
  if(!run.groupContext)throw new WorkError('teloa/forbidden','无法确认本次交接沿用的本人原目标，请核对原工作来源。')
  const inherited=run.groupContext.ownerRequest
  if(inherited&&!isGroupOwnerRequest(inherited))throw new WorkError('teloa/storage-corrupt','交接本人来源不完整。')
  const previous=await read(run.groupContext.source.messageId),additional=await readGroupWorkOwnerMessages(db,owner,groupId,run.taskId,run.taskVersion)
  const input=JSON.parse(run.inputText) as Record<string,unknown>
  // 历史 Run 已固定的续办仍是可信来源；新 Run 的同 Task ledger 负责补齐中间限制。
  const continuation=input.groupContinuation===undefined?undefined:readRunGroupContinuation(input.groupContinuation)
  const current=continuation?await own(continuation.messageId,{messageId:continuation.messageId,text:continuation.text,sha256:digest(continuation.text)}):undefined
  const all=merge(previous,additional,current?[current]:[])
  const complete=current?[...all.filter(item=>item.messageId!==current.messageId),current]:all
  if(inherited){await Promise.all(messages(inherited).map(item=>own(item.messageId,item)));assertSelection(complete,messages(inherited))}
  return complete
 }
 return read(messageId)
}
/** 新交接冻结完整本人来源，仍使用原有 current/priorRequests 协议及上限。 */
export async function readGroupOwnerRequest(db:Database,owner:string,groupId:string,messageId:string,pool:Pool):Promise<GroupOwnerRequest>{
 return request(await readChain(db,owner,groupId,messageId,pool))
}

/** 新 prepare 构建完整链；旧 Run 精确回验自身选择，不向旧 input/hash 补入后来修复的条目。 */
export async function readGroupRunOwnerRequest(db:Database,owner:string,source:GroupTaskSource,taskVersion:number,pool:Pool,frozen?:{ownerRequest:GroupOwnerRequest|undefined}):Promise<GroupOwnerRequest|undefined>{
 if(source.schema!=='teloa.group-task-source/v2'){
  if(frozen?.ownerRequest!==undefined)throw new WorkError('teloa/storage-corrupt','群运行的本人来源与原工作不一致。')
  return undefined
 }
 // 尚无 ownerRequest 的旧来源/旧 Run 保留原形态，不借新代码补造旧权限或改写旧 hash。
 if(frozen&&frozen.ownerRequest===undefined){if(source.ownerRequest!==undefined)throw new WorkError('teloa/storage-corrupt','群运行缺少固定本人来源。');return undefined}
 const complete=merge(await readChain(db,owner,source.groupId,source.messageId,pool),await readGroupWorkOwnerMessages(db,owner,source.groupId,source.taskId,taskVersion))
 if(source.ownerRequest)assertSelection(complete,messages(source.ownerRequest))
 if(!frozen)return request(complete)
 const fixed=frozen.ownerRequest
 if(!isGroupOwnerRequest(fixed))throw new WorkError('teloa/storage-corrupt','群运行的本人来源不完整。')
 const selected=messages(fixed)
 assertSelection(complete,selected)
 if(source.ownerRequest)assertSelection(selected,messages(source.ownerRequest))
 return {messageId:fixed.messageId,text:fixed.text,sha256:fixed.sha256,...(fixed.priorRequests?{priorRequests:fixed.priorRequests.map(item=>({...item}))}:{})}
}
