import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {PoolClient} from 'pg'
import {WorkError,readWorkControl,plannedRestartResumeRequestId,type WorkControl,type WorkLineage} from '@teloa/contract'

type Snapshot={id:string;generation:number}[]
type Restart={ownerId:string;restartId:string;hostGeneration:number;createdAt:string;outcome:string}
type Resume={ownerId:string;requestId:string;controlId:string;spec:{requestId:string;controlId:string;expectedVersion:number;candidateRunIds:string[]};result:WorkControl;createdAt:string;planBasis:unknown}
type Step={restart:Restart;resume:Resume}
type Chain={controlId:string;steps:Step[]}
export type GroupDeliveryControlRebinding={schema:'teloa.group-delivery-control-rebinding/v1';ownerId:string;taskId:string;originalSnapshot:Snapshot;confirmedSnapshot:Snapshot;chains:Chain[]}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const conflict=()=>new WorkError('teloa/conflict','原工作控制代次变化缺少连续、已完成的官方升级恢复证明，不能继续旧派工。')
const sha256=(text:string)=>createHash('sha256').update(text).digest('hex')
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw conflict();return value.toISOString()}
function snapshot(value:unknown):Snapshot{
 if(!Array.isArray(value)||!value.length||value.some(item=>!item||Object.keys(item).length!==2||!uuid(item.id)||!positive(item.generation))||new Set(value.map(item=>item.id)).size!==value.length)throw conflict()
 const sorted=[...value].sort((a,b)=>a.id.localeCompare(b.id));if(!isDeepStrictEqual(sorted,value))throw conflict()
 return sorted.map(item=>({id:item.id,generation:item.generation}))
}
function resumeRecord(row:Record<string,any>):Resume{
 const spec=row.spec
 if(!uuid(row.request_id)||!uuid(row.control_id)||!spec||Object.keys(spec).length!==4||spec.requestId!==row.request_id||spec.controlId!==row.control_id||!positive(spec.expectedVersion)||!Array.isArray(spec.candidateRunIds)||spec.candidateRunIds.some((id:unknown)=>!uuid(id))||new Set(spec.candidateRunIds).size!==spec.candidateRunIds.length||!isDeepStrictEqual([...spec.candidateRunIds].sort(),spec.candidateRunIds))throw conflict()
 let result:WorkControl;try{result=readWorkControl(row.result)}catch{throw conflict()}
 if(result.ownerId!==row.owner_id||result.id!==row.control_id||result.state!=='active'||result.pendingRunIds.length||result.unknownOperationIds.length||result.version!==spec.expectedVersion+1)throw conflict()
 return {ownerId:row.owner_id,requestId:row.request_id,controlId:row.control_id,spec,result,createdAt:stamp(row.created_at),planBasis:row.plan_basis}
}

/** 校验已冻结的历史证明，不因之后的控制/升级变化而改写已受理的原回执。 */
export function assertGroupDeliveryControlRebinding(value:GroupDeliveryControlRebinding,owner:string,taskId:string,original:unknown,current:unknown):void{
 const from=snapshot(original),to=snapshot(current)
 if(value?.schema!=='teloa.group-delivery-control-rebinding/v1'||value.ownerId!==owner||value.taskId!==taskId||!isDeepStrictEqual(value.originalSnapshot,from)||!isDeepStrictEqual(value.confirmedSnapshot,to)||!Array.isArray(value.chains)||!isDeepStrictEqual(from.map(row=>row.id),to.map(row=>row.id)))throw conflict()
 const changed=from.filter((row,index)=>row.generation!==to[index]!.generation)
 if(!changed.length||!isDeepStrictEqual(value.chains.map(row=>row.controlId),changed.map(row=>row.id)))throw conflict()
 for(const chain of value.chains){
  const start=from.find(row=>row.id===chain.controlId)!,end=to.find(row=>row.id===chain.controlId)!
  let generation=start.generation,version:number|undefined,host=0,endedAt=''
  if(!Array.isArray(chain.steps)||!chain.steps.length)throw conflict()
  for(const step of chain.steps){
   const {restart,resume}=step,result=readWorkControl(resume.result),spec=resume.spec
   if(restart.ownerId!==owner||!uuid(restart.restartId)||restart.outcome!=='resumed'||!positive(restart.hostGeneration)||restart.hostGeneration<=host||!Number.isFinite(Date.parse(restart.createdAt))||!Number.isFinite(Date.parse(resume.createdAt))||restart.createdAt<endedAt||resume.createdAt<restart.createdAt||resume.ownerId!==owner||resume.controlId!==chain.controlId||resume.requestId!==plannedRestartResumeRequestId(restart.restartId,chain.controlId,sha256)||spec.requestId!==resume.requestId||spec.controlId!==chain.controlId||!positive(spec.expectedVersion)||!Array.isArray(spec.candidateRunIds)||spec.candidateRunIds.some(id=>!uuid(id))||new Set(spec.candidateRunIds).size!==spec.candidateRunIds.length||result.id!==chain.controlId||result.ownerId!==owner||result.state!=='active'||result.pendingRunIds.length||result.unknownOperationIds.length||result.generation!==generation+2||result.version<result.generation||result.version!==spec.expectedVersion+1||version!==undefined&&result.version!==version+3||generation===1&&result.version!==4)throw conflict()
   generation=result.generation;version=result.version;host=restart.hostGeneration;endedAt=resume.createdAt
  }
  if(generation!==end.generation)throw conflict()
 }
}

/** 只读原正式台账；每一段都必须是 active→本次重启暂停→确定性正式恢复。没有证据便拒绝。 */
export async function readGroupDeliveryControlRebinding(db:PoolClient,owner:string,taskId:string,lineage:WorkLineage,original:unknown,current:unknown):Promise<GroupDeliveryControlRebinding|undefined>{
 const from=snapshot(original),to=snapshot(current)
 if(!isDeepStrictEqual(from.map(row=>row.id),to.map(row=>row.id)))throw conflict()
 if(isDeepStrictEqual(from,to))return undefined
 const host=(await db.query('select generation from teloa_work_control_hosts where owner_id=$1 for share',[owner])).rows[0]
 if(!positive(host?.generation))throw conflict()
 const chains:Chain[]=[]
 for(const [index,start] of from.entries()){
  const end=to[index]!;if(start.generation===end.generation)continue
  if(end.generation<=start.generation||(end.generation-start.generation)%2!==0)throw conflict()
  const control=(await db.query('select * from teloa_work_controls where owner_id=$1 and id=$2 for share',[owner,start.id])).rows[0],progress=(await db.query('select * from teloa_work_control_progress where owner_id=$1 and control_id=$2 for share',[owner,start.id])).rows[0]
  if(!control||control.state!=='active'||control.pause_origin!==null||control.generation!==end.generation||!positive(control.version)||control.budget_account_id!==lineage.budgetAccountId||control.kind==='round'&&control.root_task_id!==lineage.rootTaskId||control.kind!=='round'&&control.kind!=='definition'||!progress||progress.generation!==end.generation||progress.pending_run_ids.length||progress.unknown_operation_ids.length)throw conflict()
  const plans=(await db.query('select * from teloa_work_control_planned_restarts where owner_id=$1 and results ? $2 order by host_generation,restart_id for share',[owner,start.id])).rows
  const resumes=(await db.query('select * from teloa_work_recovery_requests where owner_id=$1 and control_id=$2 order by created_at,request_id for share',[owner,start.id])).rows.map(resumeRecord)
  const relevant=resumes.filter(row=>row.result.generation>start.generation&&row.result.generation<=end.generation),steps:Step[]=[]
  for(let generation=start.generation+2;generation<=end.generation;generation+=2){
   const matches=relevant.filter(row=>row.result.generation===generation);if(matches.length!==1)throw conflict()
   const resume=matches[0]!,matchesPlan=plans.filter(row=>uuid(row.restart_id)&&plannedRestartResumeRequestId(row.restart_id,start.id,sha256)===resume.requestId)
   if(matchesPlan.length!==1)throw conflict()
   const plan=matchesPlan[0]!
   if(plan.results[start.id]!=='resumed'||!positive(plan.host_generation)||resume.result.scope!==control.kind)throw conflict()
   steps.push({restart:{ownerId:owner,restartId:plan.restart_id,hostGeneration:plan.host_generation,createdAt:stamp(plan.created_at),outcome:plan.results[start.id]},resume})
  }
  const first=steps[0]!,last=steps.at(-1)!
  if(last.resume.result.version!==control.version||last.restart.hostGeneration!==host.generation||plans.some(row=>row.host_generation>=first.restart.hostGeneration&&row.host_generation<=host.generation&&!steps.some(step=>step.restart.restartId===row.restart_id)))throw conflict()
  const ordinary=(await db.query('select result from teloa_work_control_requests where owner_id=$1 and control_id=$2 for share',[owner,start.id])).rows
  for(const row of ordinary){let result:WorkControl;try{result=readWorkControl(row.result)}catch{throw conflict()}if(result.generation>start.generation&&result.generation<=end.generation)throw conflict()}
  chains.push({controlId:start.id,steps})
 }
 const proof:GroupDeliveryControlRebinding={schema:'teloa.group-delivery-control-rebinding/v1',ownerId:owner,taskId,originalSnapshot:from,confirmedSnapshot:to,chains}
 assertGroupDeliveryControlRebinding(proof,owner,taskId,from,to);return proof
}
