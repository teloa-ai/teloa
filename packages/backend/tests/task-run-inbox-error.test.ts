import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {TaskRunService,type TaskRun} from '../src/work/task-runs.ts'
import {withAcceptedInboxErrorFence,type AcceptedInboxErrorFence} from '../src/work/task-run-inbox-error.ts'
import {runEvidence,mergeRunEvidence,type AcceptedInboxErrorEvidence,type AcceptedInboxFailureEvidence} from '../src/work/task-run-evidence.ts'
import {readTaskRunOwnerSettlement} from '../src/work/task-run-runtime-links.ts'

const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
/** 真实record事务/CAS及opaque资格；存储ports只模拟本例行，不代替PG/完整readVerified验收。 */
function fixture(reason:'error'|'interrupted'='error'){
 const owner='synthetic-owner',runtimeId=randomUUID(),controlId=randomUUID(),roleId=randomUUID()
 let run={id:randomUUID(),taskId:randomUUID(),roleId,taskVersion:1,roleVersion:1,sessionId:'synthetic-session',nativeRequestId:randomUUID(),inputText:'合成输入',state:'accepted',evidence:{state:'accepted'},stopRequestedAt:null,createdAt:new Date(0).toISOString(),lineage:{roundControlId:controlId,definitionControlId:null,controlGeneration:1}} as unknown as TaskRun
 const task={state:'running',version:2,roleId};let ownerProof:unknown=null,reserved=true,callbacks=0,fail='',effect=false,race=false,released=true
 let snapshot:{run:TaskRun;task:typeof task;ownerProof:unknown;reserved:boolean}|undefined
 const ticket={session_id:run.sessionId,native_request_id:run.nativeRequestId,input_sha256:hash(run.inputText),runtime_id:runtimeId,state:'accepted',settled_at:new Date(2)}
 const control={id:controlId,state:'active',generation:1,unknown_operation_ids:[] as string[]}
 const link={kind:'job',session_id:run.sessionId,native_id:'owner:'+runtimeId+':'+run.sessionId,payload:{record:'owner',runtimeId,requestId:run.nativeRequestId}}
 const raw=()=>({...run,task_state_version:2})
 const query=async(sql:string,params:unknown[]=[])=>{
  if(sql==='begin'){released=false;snapshot={run:structuredClone(run),task:{...task},ownerProof:structuredClone(ownerProof),reserved};return {rows:[],rowCount:0}}
  if(sql==='rollback'){if(snapshot){run=snapshot.run;Object.assign(task,snapshot.task);ownerProof=snapshot.ownerProof;reserved=snapshot.reserved}return {rows:[],rowCount:0}}
  if(sql==='commit'){if(fail==='commit')throw Error('commit');snapshot=undefined;return {rows:[],rowCount:0}}
  if(fail==='read'&&sql.startsWith('select * from teloa_task_runs'))throw Error('read')
  if(sql.startsWith('select * from teloa_task_runs'))return {rows:params[0]===owner&&params[1]===run.id?[raw()]:[],rowCount:1}
  if(sql.startsWith('select * from teloa_task_run_submissions'))return {rows:[ticket],rowCount:1}
  if(sql.startsWith('select * from teloa_task_run_runtime_links'))return {rows:[link],rowCount:1}
  if(sql.startsWith('select generation,unknown_operation_ids'))return {rows:[control],rowCount:1}
  if(sql.startsWith('select id,state,generation'))return {rows:[control],rowCount:1}
  if(sql.includes('union all select 1'))return {rows:effect?[{present:1}]:[],rowCount:effect?1:0}
  if(sql.startsWith('select 1 from teloa_task_run_subagents')||sql.startsWith('select 1 from teloa_task_run_runtime_links'))return {rows:[],rowCount:0}
  if(sql.startsWith('update teloa_tasks')){if(task.state==='running'&&task.version===params[2]&&task.roleId===params[5]){task.state=String(params[3]);task.version++;return {rows:[],rowCount:1}}return {rows:[],rowCount:0}}
  if(sql.startsWith('update teloa_task_runs')){if(fail==='write')throw Error('write');run={...run,state:params[2] as string,evidence:JSON.parse(params[3] as string)};return {rows:[raw()],rowCount:1}}
  if(sql.startsWith('update teloa_task_run_runtime_links')){ownerProof=JSON.parse(params[3] as string);return {rows:[],rowCount:1}}
  if(sql.startsWith('select 1 from teloa_work_budget_reservations'))return {rows:race?[{unknown:true}]:[],rowCount:race?1:0}
  if(sql.startsWith('update teloa_work_budget_reservations')){assert(sql.includes("b.state='reserved'"));reserved=false;return {rows:[],rowCount:1}}
  throw Error('未声明SQL：'+sql)
 }
 const service=new TaskRunService({connect:async()=>({query,release(){released=true}})} as never,{id:randomUUID,now:()=>new Date(100).toISOString()},async()=>{throw Error('不能恢复或创建原生会话')},{allowedTools:[],onSettled:async()=>{assert.equal(released,true,'hook必须在释放原poolclient后');callbacks++}})
 Reflect.defineProperty(service,'readVerified',{value:async(_db:unknown,actor:string,row:Record<string,unknown>)=>{assert.equal(actor,owner);return {...run,state:row.state,evidence:row.evidence}}})
 const evidence:AcceptedInboxErrorEvidence={state:'ended',turn:1,messageSeq:6,endSeq:9,reason:'error',inputAnchor:{kind:'accepted-inbox-error',acceptedSeq:6,turnStartSeq:7,consumedSeq:8,messageId:randomUUID(),payloadSha256:hash('完整native载荷'),inputSha256:hash(run.inputText),prefixSha256:hash('完整原生日志'),errorSha256:hash('实际error')}}
 const {errorSha256:_error,kind:_kind,...anchor}=evidence.inputAnchor
 const fixed:AcceptedInboxFailureEvidence=reason==='error'?evidence:{...evidence,reason:'interrupted',inputAnchor:{kind:'accepted-inbox-interrupted',...anchor,resumeSealSeq:evidence.endSeq+1,reasonSha256:hash('实际interrupted')}}
 const input:AcceptedInboxErrorFence={runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,runtimeId,inputSha256:hash(run.inputText),endedAt:new Date(reason==='error'?9:10).toISOString(),evidence:fixed,...reason==='interrupted'?{issuer:{kind:'stopped-session-writer-maintenance',originalRuntimeId:runtimeId,maintenanceRuntimeId:randomUUID(),physicalSha256:hash('真实writer最终物理字节')}}:{}}
 let current=true
 const record=()=>withAcceptedInboxErrorFence(input,()=>{if(!current)throw Error('fence changed')},f=>service.recordAcceptedInboxFailure(owner,f))
 return {service,record,input,owner,task,ticket,control,link,evidence,run:()=>run,ownerProof:()=>ownerProof,reserved:()=>reserved,callbacks:()=>callbacks,fail:(s:string)=>fail=s,effect:()=>effect=true,race:()=>race=true,stale:()=>current=false}
}

test('149 真service原子记录error/Task blocked/owner回执/仅未派发额度，原票据和stop不改',async()=>{
 const f=fixture(),ticket=structuredClone(f.ticket),control=structuredClone(f.control)
 const result=await f.record();assert.equal(result.state,'ended');assert.equal(result.evidence?.state==='ended'&&result.evidence.reason,'error')
 assert.equal(f.task.state,'blocked');assert.equal(f.task.version,3);assert.equal(f.callbacks(),1)
 assert.deepEqual(f.ticket,ticket);assert.deepEqual(f.control,control);assert.equal(f.reserved(),false)
 assert.equal(Reflect.get(f.ownerProof() as object,'prefixSha256'),f.evidence.inputAnchor.prefixSha256)
 await f.record();assert.equal(f.task.version,3)
 await assert.rejects(f.service.record(f.owner,{runId:result.id,sessionId:result.sessionId,nativeRequestId:result.nativeRequestId,evidence:f.evidence}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.recordAcceptedInboxFailure(f.owner,structuredClone(f.input)),{code:'teloa/conflict'})
})
test('149 foreign/无真实accepted/unknown/控制代次漂移保持accepted和Task原状态',async()=>{
 for(const alter of [(f:ReturnType<typeof fixture>)=>{f.ticket.state='dispatching'},(f:ReturnType<typeof fixture>)=>{f.ticket.runtime_id=randomUUID()},(f:ReturnType<typeof fixture>)=>{f.ticket.input_sha256=hash('更换输入')},(f:ReturnType<typeof fixture>)=>{f.control.generation++},(f:ReturnType<typeof fixture>)=>{f.control.unknown_operation_ids=['unknown']},(f:ReturnType<typeof fixture>)=>{f.link.session_id='foreign'},(f:ReturnType<typeof fixture>)=>f.effect(),(f:ReturnType<typeof fixture>)=>f.stale()]){
  const f=fixture();alter(f);await assert.rejects(f.record());assert.equal(f.run().state,'accepted');assert.equal(f.task.state,'running');assert.equal(f.callbacks(),0)
 }
})
test('149 read/write/commit错误回滚且fence finally失效；Task CAS漂移不覆盖人工状态',async()=>{
 for(const failure of ['read','write','commit']){const f=fixture();f.fail(failure);await assert.rejects(f.record(),new RegExp(failure));assert.equal(f.run().state,'accepted');assert.equal(f.task.state,'running');assert.equal(f.ownerProof(),null);assert.equal(f.reserved(),true);assert.equal(f.callbacks(),0);f.fail('');await f.record();assert.equal(f.run().state,'ended')}
 const race=fixture();race.race();await assert.rejects(race.record(),{code:'teloa/conflict'});assert.equal(race.run().state,'accepted');assert.equal(race.task.state,'running');assert.equal(race.reserved(),true)
 const f=fixture();f.task.version++;f.task.state='paused';await f.record();assert.equal(f.task.version,3);assert.equal(f.task.state,'paused')
})
test('149 data10 reader保留旧证据；新marker仅error且固定accepted序号，不能跨锚点合并',()=>{
 const f=fixture();assert.deepEqual(runEvidence(f.evidence),f.evidence)
 const reordered={...f.evidence,inputAnchor:Object.fromEntries(Object.entries(f.evidence.inputAnchor).reverse())};assert.deepEqual(mergeRunEvidence(f.evidence,runEvidence(reordered)),f.evidence)
 const old={state:'ended' as const,turn:1,messageSeq:6,endSeq:9,reason:'error'};assert.deepEqual(runEvidence(old),old)
 for(const bad of [{...f.evidence,reason:'completed'},{...f.evidence,messageSeq:7},{...f.evidence,inputAnchor:{...f.evidence.inputAnchor,consumedSeq:9}},{...f.evidence,inputAnchor:{...f.evidence.inputAnchor,extra:'user'}}])assert.throws(()=>runEvidence(bad))
 assert.throws(()=>mergeRunEvidence(old,f.evidence));assert.throws(()=>mergeRunEvidence(f.evidence,old))
 assert.deepEqual(mergeRunEvidence({state:'accepted'},f.evidence),f.evidence)
})

test('149 冷维护issuer明确独立来源，原ticket/runtime不替换；暂停新代只记error而不恢复控制',async()=>{
 const f=fixture();f.control.state='paused';f.control.generation++
 const control=structuredClone(f.control),originalRuntimeId=f.ticket.runtime_id,maintenanceRuntimeId=randomUUID()
 const issuer={kind:'stopped-session-writer-maintenance' as const,originalRuntimeId,maintenanceRuntimeId,physicalSha256:hash('原物理v4文件')}
 const result=await withAcceptedInboxErrorFence({...f.input,issuer},()=>{},fence=>f.service.recordAcceptedInboxFailure(f.owner,fence))
 assert.equal(result.state,'ended');assert.equal(f.task.state,'blocked');assert.deepEqual(f.control,control);assert.equal(f.ticket.runtime_id,originalRuntimeId)
 const receipt=readTaskRunOwnerSettlement(f.ownerProof())
 assert.equal(receipt.schema,'teloa.task-run-owner-settlement/v2');assert.deepEqual(receipt.source,issuer)
 assert.throws(()=>readTaskRunOwnerSettlement({...receipt,schema:'teloa.task-run-owner-settlement/v1'}))
 assert.throws(()=>readTaskRunOwnerSettlement({...receipt,source:{...issuer,originalRuntimeId:randomUUID()}}))
 const live=f.ownerProof() as object;assert.throws(()=>readTaskRunOwnerSettlement({...live,evidence:{...f.evidence,reason:'completed'}}))
 const resumed=fixture();resumed.control.generation++
 await assert.rejects(withAcceptedInboxErrorFence({...resumed.input,issuer:{...issuer,originalRuntimeId:resumed.ticket.runtime_id}},()=>{},fence=>resumed.service.recordAcceptedInboxFailure(resumed.owner,fence)),{code:'teloa/conflict'})
 assert.equal(resumed.run().state,'accepted');assert.equal(resumed.task.state,'running')
})


test('152 interrupted受理锚保留turn/end，封口与owner前缀含seed，仅释放未派发reserved',async()=>{
 const f=fixture('interrupted'),originalTicket=structuredClone(f.ticket),originalControl=structuredClone(f.control),e=f.input.evidence
 assert.equal(e.reason,'interrupted');assert.deepEqual(runEvidence(e),e)
 const result=await f.record();assert.equal(result.evidence?.state==='ended'&&result.evidence.reason,'interrupted');assert.equal(result.evidence?.state==='ended'&&result.evidence.endSeq,9)
 const owner=readTaskRunOwnerSettlement(f.ownerProof());assert.equal(owner.prefixLength,11);assert.equal(owner.evidence.endSeq,9);assert.equal(owner.evidence.inputAnchor?.kind,'accepted-inbox-interrupted')
 assert.equal(f.reserved(),false);assert.equal(f.task.state,'blocked');assert.deepEqual(f.ticket,originalTicket);assert.deepEqual(f.control,originalControl)
 const frozenProof=structuredClone(f.ownerProof());await f.record();assert.equal(f.task.version,3);assert.deepEqual(f.ownerProof(),frozenProof)
 for(const bad of [{...e,reason:'error'},{...e,inputAnchor:{...e.inputAnchor,resumeSealSeq:9}},{...e,inputAnchor:{...e.inputAnchor,resumeSealSeq:11}},{...e,inputAnchor:{...e.inputAnchor,reasonSha256:'bad'}},{...e,inputAnchor:{...e.inputAnchor,errorSha256:hash('伪error')}}])assert.throws(()=>runEvidence(bad))
 assert.throws(()=>readTaskRunOwnerSettlement({...owner,prefixLength:10}))
 for(const failure of ['unknown','foreign','commit']){const bad=fixture('interrupted');if(failure==='unknown')bad.effect();else if(failure==='foreign')bad.ticket.runtime_id=randomUUID();else bad.fail('commit');await assert.rejects(bad.record());assert.equal(bad.run().state,'accepted');assert.equal(bad.reserved(),true);assert.equal(bad.ownerProof(),null)}
})
