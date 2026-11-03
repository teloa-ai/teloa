import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {errorRecoveryNotice,stoppedContinuationNotice,type TaskRunSourceFollowup} from '@teloa/contract'
import type {TaskRun} from '../src/work/task-runs.ts'
import {sourceFollowupCandidate,verifySourceFollowup,sourceFollowupStoppedProof,sourceFollowupPlanAdmission,assertSourceFollowupPlanAdmission,type SourceFollowupPlanAdmission} from '../src/work/task-run-source-followups.ts'
import {PlanOccurrenceService,type PlanOccurrence} from '../src/work/plan-occurrences.ts'
import {workEventDigest} from '../src/work/work-event-digest.ts'
import {readPlanWorkDefinition,readRunPlanEventContext} from '@teloa/contract'
import {businessTaskSourceUpdateRunRequestId} from '../src/work/business-task-source-updates.ts'
import {businessObjectSnapshotHash} from '../src/work/business-data.ts'

function fixture(){
 const owner='owner',taskId=randomUUID(),runId=randomUUID(),sessionId='original-session',roleId=randomUUID(),updateId=randomUUID(),eventId=randomUUID(),planId=randomUUID(),nativeRequestId=randomUUID(),stamp='2026-11-02T00:00:00.000Z'
 const snapshot={scope:'SOC',type:'alert',id:'AL-01',version:3,title:'固定来源',source:'fixture',observedAt:stamp,receivedAt:stamp,quality:'complete' as const,summary:'',fields:[{label:'状态',value:'new'}]},reference={scope:'SOC',type:'alert',id:'AL-01',version:3,snapshotHash:businessObjectSnapshotHash(snapshot)}
 const evidence={state:'ended' as const,turn:2,messageSeq:3,endSeq:4,reason:'error' as const},inputText=JSON.stringify({businessContext:{updates:[{...snapshot,snapshotHash:reference.snapshotHash}]}})
 const original={id:runId,taskId,roleId,roleVersion:4,taskVersion:8,linkVersion:1,sessionId,nativeRequestId,state:'ended',evidence,stopRequestedAt:null,agentPresetId:'worker',roleSnapshot:{id:roleId},inputText} as TaskRun
 const update={id:updateId,owner_id:owner,task_id:taskId,run_id:runId,plan_id:planId,state:'accepted',reason:null,scope_id:'SOC',object_type:'alert',object_id:'AL-01',object_version:3,task_version:8,event_id:eventId,snapshot_hash:reference.snapshotHash}
 const stored={id:runId,owner_id:owner,task_id:taskId,task_version:8,request_id:businessTaskSourceUpdateRunRequestId(owner,updateId),session_id:sessionId,role_id:roleId,role_version:4,native_request_id:nativeRequestId,agent_preset_id:'worker',state:'ended',evidence,stop_requested_at:null,input_text:inputText}
 let maxVersion=3,pending=false,foreign=false;let binding:TaskRunSourceFollowup|undefined;const storedRuns=new Map<string,Record<string,unknown>>(),confirmations=new Map<string,TaskRunSourceFollowup>(),pendingRuns=new Set<string>(),flows=new Set<string>()
 const sql:string[]=[]
 const db={query:async(query:string,params:unknown[])=>{
  sql.push(query);assert(/^select\b/i.test(query.trim()),'candidate/verify must not rewrite source ledger or original Run')
  if(foreign||params[0]!==owner)return {rows:[]}
  if(query.includes('teloa_task_run_runtime_links'))return {rows:[]}
  if(query.includes('teloa_work_budget_reservations'))return {rows:pending||pendingRuns.has(String(params[1]))?[{unresolved:true}]:[]}
  if(query.includes('teloa_task_run_flows')&&flows.has(String(params[1])))return {rows:[{unresolved:true}]}
  if(query.includes('teloa_task_run_subagents')||query.includes('teloa_task_run_flows')||query.includes('teloa_task_run_goal_continuations')||query.includes('teloa_security_action_executions'))return {rows:[]}
  if(query.includes('teloa_task_run_source_followups')){const value=confirmations.get(String(params[1]))??binding;return {rows:value?[{request_id:value.requestId,original_run_id:value.originalRunId,source_update_id:value.sourceUpdateId,binding:value}]:[]}}
  if(query.includes('teloa_business_task_source_updates u join'))return {rows:[{...update,snapshot}]}
  if(query.includes('teloa_business_task_source_updates'))return {rows:params[2]===runId?[update]:[]}
  if(query.includes('teloa_business_task_sources'))return {rows:[{scope_id:'SOC',object_type:'alert',object_id:'AL-01',object_version:1}]}
  if(query.includes('max(object_version)'))return {rows:[{version:maxVersion}]}
  if(query.startsWith('select request_id'))return {rows:[{request_id:businessTaskSourceUpdateRunRequestId(owner,updateId)}]}
  if(query.includes('teloa_task_runs'))return {rows:params[1]===runId?[stored]:storedRuns.has(String(params[1]))?[storedRuns.get(String(params[1]))]:[]}
  throw Error('unexpected SQL shape '+query)
 }}
 return {owner,original,update,stored,sql,db,reference,setPending:(v:boolean)=>pending=v,setMax:(v:number)=>maxVersion=v,setForeign:()=>foreign=true,setBinding:(v:TaskRunSourceFollowup)=>binding=v,storedRuns,confirmations,pendingRuns,flows,snapshot,stamp}
}

test('明确失败续办固定原Run/error/input与v3来源，原update不改绑；未知额度/更高版本/异owner拒绝',async()=>{
 const f=fixture(),before=structuredClone({run:f.stored,update:f.update}),candidate=await sourceFollowupCandidate(f.db as never,f.owner,f.original,9)
 assert.equal(candidate.kind,'error-recovery');assert.equal(candidate.sourceUpdateId,f.update.id);assert.equal(candidate.sessionId,f.original.sessionId)
 const {schema:_schema,expectedTaskVersion:_version,runId:_run,...rest}=candidate
 const binding:TaskRunSourceFollowup={...rest,schema:'teloa.task-run-source-followup/v1',requestId:randomUUID(),taskVersion:9,originalRunId:f.original.id,instruction:'按固定来源完成尚未完成的核对，不重复旧动作。',confirmedAt:'2026-11-02T00:00:00.000Z',notice:errorRecoveryNotice}
 f.setBinding(binding)
 const fresh={...f.original,id:randomUUID(),nativeRequestId:randomUUID(),taskVersion:9,state:'prepared',evidence:null,sourceFollowup:binding}
 assert.deepEqual(await verifySourceFollowup(f.db as never,f.owner,fresh),f.stored)
 assert.deepEqual({run:f.stored,update:f.update},before)
 f.stored.evidence={...f.stored.evidence,reason:'completed'} as never;await assert.rejects(verifySourceFollowup(f.db as never,f.owner,fresh),{code:'teloa/conflict'});f.stored.evidence=before.run.evidence
 for(const invalid of [{...f.original,state:'active'},{...f.original,stopRequestedAt:'2026-11-02T01:00:00.000Z'},{...f.original,state:'submission_unknown',evidence:null}])await assert.rejects(sourceFollowupCandidate(f.db as never,f.owner,invalid,9),{code:'teloa/conflict'})
 f.setPending(true);await assert.rejects(sourceFollowupCandidate(f.db as never,f.owner,f.original,9),{code:'teloa/conflict'});f.setPending(false)
 f.setMax(4);await assert.rejects(sourceFollowupCandidate(f.db as never,f.owner,f.original,9),{code:'teloa/conflict'});f.setMax(3)
 f.setForeign();await assert.rejects(sourceFollowupCandidate(f.db as never,'other-owner',f.original,9),{code:'teloa/conflict'})
 assert.ok(f.sql.every(s=>!/^\s*(update|insert|delete)/i.test(s)))
})


async function correction(f:ReturnType<typeof fixture>,parent:TaskRun,taskVersion:number){
 const candidate=await sourceFollowupCandidate(f.db as never,f.owner,parent,taskVersion),{schema:_schema,expectedTaskVersion:_v,runId:_id,...rest}=candidate
 const binding:TaskRunSourceFollowup={...rest,schema:'teloa.task-run-source-followup/v1',requestId:randomUUID(),taskVersion,originalRunId:parent.id,instruction:'按同一固定来源完成剩余工作，不重放旧请求。',confirmedAt:f.stamp,notice:errorRecoveryNotice}
 const id=randomUUID(),nativeRequestId=randomUUID(),evidence={state:'ended' as const,turn:taskVersion,messageSeq:taskVersion*2,endSeq:taskVersion*2+1,reason:'error'},inputText=JSON.stringify({sourceFollowup:binding,businessContext:{updates:[{...f.snapshot,snapshotHash:f.reference.snapshotHash}]}})
 const run={...parent,id,nativeRequestId,taskVersion,evidence,inputText,sourceFollowup:binding}
 f.confirmations.set(id,binding);f.storedRuns.set(id,{id,owner_id:f.owner,task_id:run.taskId,session_id:run.sessionId,role_id:run.roleId,role_version:run.roleVersion,native_request_id:nativeRequestId,agent_preset_id:run.agentPresetId,state:run.state,evidence,stop_requested_at:null,input_text:inputText,task_version:taskVersion,request_id:binding.requestId,request_spec:{sourceFollowup:binding}})
 return run
}

test('纠错再次失败只沿持久确认链回到同一原来源；不改原update锚与旧error',async()=>{
 const f=fixture(),before=structuredClone({root:f.stored,update:f.update}),first=await correction(f,f.original,9),second=await correction(f,first,10),candidate=await sourceFollowupCandidate(f.db as never,f.owner,second,11)
 assert.equal(candidate.kind,'error-recovery');assert.equal(candidate.runId,second.id);assert.equal(candidate.originalNativeRequestId,second.nativeRequestId);assert.equal(candidate.sourceUpdateId,f.update.id);assert.equal(candidate.sourceTaskVersion,8);assert.deepEqual(candidate.reference,f.reference)
 assert.deepEqual(await verifySourceFollowup(f.db as never,f.owner,second),f.storedRuns.get(first.id));assert.deepEqual({root:f.stored,update:f.update},before);assert.ok(f.sql.every(query=>/^select\b/i.test(query)))
})

test('派生纠错拒缺确认、跨SID/Role、未知额度、Flow、在途/stop和更高源版本',async()=>{
 const f=fixture(),first=await correction(f,f.original,9),binding=f.confirmations.get(first.id)!
 f.confirmations.delete(first.id);await assert.rejects(sourceFollowupCandidate(f.db as never,f.owner,first,10),{code:'teloa/conflict'});f.confirmations.set(first.id,binding)
 const session=f.stored.session_id;f.stored.session_id='foreign';await assert.rejects(sourceFollowupCandidate(f.db as never,f.owner,first,10),{code:'teloa/conflict'});f.stored.session_id=session
 const version=f.stored.role_version;f.stored.role_version=5;await assert.rejects(sourceFollowupCandidate(f.db as never,f.owner,first,10),{code:'teloa/conflict'});f.stored.role_version=version
 f.pendingRuns.add(f.original.id);await assert.rejects(sourceFollowupCandidate(f.db as never,f.owner,first,10),{code:'teloa/conflict'});f.pendingRuns.clear()
 f.flows.add(f.original.id);await assert.rejects(sourceFollowupCandidate(f.db as never,f.owner,first,10),{code:'teloa/conflict'});f.flows.clear()
 for(const run of [{...first,state:'active'},{...first,stopRequestedAt:f.stamp},{...first,state:'submission_unknown',evidence:null},{...first,sourceFollowup:{...binding,kind:'result-verification' as const}}])await assert.rejects(sourceFollowupCandidate(f.db as never,f.owner,run,10),{code:'teloa/conflict'})
 f.setMax(4);await assert.rejects(sourceFollowupCandidate(f.db as never,f.owner,first,10),{code:'teloa/conflict'})
})

test('实际停止的error仅形成stopped-continuation新意图；旧stop/error/input/update不写，停止或费用变化拒绝',async()=>{
 const f=fixture();f.original.stopRequestedAt=f.stamp;f.stored.stop_requested_at=f.stamp as never
 const before=structuredClone({run:f.stored,update:f.update}),candidate=await sourceFollowupCandidate(f.db as never,f.owner,f.original,9)
 assert.equal(candidate.kind,'stopped-continuation');assert.equal(candidate.originalStopRequestedAt,f.stamp)
 assert.ok(sourceFollowupStoppedProof(f.original));assert.equal(sourceFollowupStoppedProof({...f.original}),undefined,'对象复制或RPC字段不能伪造进程内资格')
 const {schema:_schema,expectedTaskVersion:_version,runId:_run,...rest}=candidate
 const binding:TaskRunSourceFollowup={...rest,schema:'teloa.task-run-source-followup/v1',requestId:randomUUID(),taskVersion:9,originalRunId:f.original.id,instruction:'按固定来源完成剩余核对，不重放旧输入。',confirmedAt:f.stamp,notice:stoppedContinuationNotice}
 f.setBinding(binding)
 const fresh={...f.original,id:randomUUID(),nativeRequestId:randomUUID(),taskVersion:9,state:'prepared',stopRequestedAt:null,evidence:null,sourceFollowup:binding}
 assert.deepEqual(await verifySourceFollowup(f.db as never,f.owner,fresh),f.stored)
 assert.deepEqual({run:f.stored,update:f.update},before)
 f.stored.stop_requested_at='2026-11-03T01:00:00.000Z' as never;await assert.rejects(verifySourceFollowup(f.db as never,f.owner,fresh),{code:'teloa/conflict'});f.stored.stop_requested_at=f.stamp as never
 f.setPending(true);await assert.rejects(sourceFollowupCandidate(f.db as never,f.owner,f.original,9),{code:'teloa/conflict'});f.setPending(false)
 f.flows.add(f.original.id);await assert.rejects(sourceFollowupCandidate(f.db as never,f.owner,f.original,9),{code:'teloa/conflict'});f.flows.clear()
 f.setMax(4);await assert.rejects(sourceFollowupCandidate(f.db as never,f.owner,f.original,9),{code:'teloa/conflict'})
 assert.ok(f.sql.every(query=>/^select\b/i.test(query)))
})

test('已有error-recovery后被停止：新续办沿原持久链和同Task/SID，不把停止改成普通重试',async()=>{
 const f=fixture(),first=await correction(f,f.original,9),stored=f.storedRuns.get(first.id)!
 first.stopRequestedAt=f.stamp;stored.stop_requested_at=f.stamp
 const before=structuredClone({root:f.stored,stopped:stored,update:f.update}),candidate=await sourceFollowupCandidate(f.db as never,f.owner,first,10)
 assert.equal(candidate.kind,'stopped-continuation');assert.equal(candidate.runId,first.id)
 assert.equal(candidate.sourceUpdateId,f.update.id);assert.equal(candidate.sessionId,f.original.sessionId);assert.equal(candidate.sourceTaskVersion,8)
 const {schema:_schema,expectedTaskVersion:_v,runId:_id,...rest}=candidate
 const binding:TaskRunSourceFollowup={...rest,schema:'teloa.task-run-source-followup/v1',requestId:randomUUID(),taskVersion:10,originalRunId:first.id,instruction:'这是本人新的续办要求，不重放旧请求。',confirmedAt:f.stamp,notice:stoppedContinuationNotice}
 const next={...first,id:randomUUID(),nativeRequestId:randomUUID(),taskVersion:10,state:'prepared',stopRequestedAt:null,evidence:null,sourceFollowup:binding};f.confirmations.set(next.id,binding)
 assert.deepEqual(await verifySourceFollowup(f.db as never,f.owner,next),stored)
 assert.deepEqual({root:f.stored,stopped:stored,update:f.update},before)
})

/** 真实准入判断配只读事务替身；不创建 PG、运行实例或模型。 */
function pausedPlanFixture(){
 const f=fixture(),occurrenceId=randomUUID(),controlId=randomUUID(),eventId=randomUUID()
 const fields={title:'固定告警核对',goal:'核对固定来源',scope:'SOC',dataScope:'固定来源',delivery:'核对结论',roleId:f.original.roleId!,trigger:{kind:'schedule' as const,cadence:'daily' as const,weekday:1,time:'09:00',timezone:'Asia/Singapore' as const},notificationPolicy:'attention' as const,completionPolicy:{kind:'manual' as const}}
 const work=readPlanWorkDefinition({schema:'teloa.plan-work/v3',definitionVersion:2,definitionControlId:controlId,budgetAccountId:randomUUID(),authorization:{kind:'delegation',delegationId:randomUUID(),delegationVersion:1},completion:{kind:'manual'},triggers:[{kind:'local-event',eventKind:'business-object-version',sourceRef:{kind:'business-object-type',scope:'SOC',type:'alert'},coalesce:'latest'}],budget:{money:null,maxTokens:100,maxRetries:0,maxElapsedMs:1000,maxConcurrent:1,maxGoalRounds:1,stagnationRounds:1},overlap:'independent',missed:'coalesce',safeRecovery:false})
 const originalObject={...f.snapshot,version:1},hash=businessObjectSnapshotHash(originalObject),payload={active:true,data:{object:{...originalObject,snapshotHash:hash}}}
 const event=readRunPlanEventContext({event:{schema:'teloa.work-event/v2',id:eventId,ownerId:f.owner,sourceEventId:randomUUID(),kind:'business-object-version',sourceRef:{kind:'business-object',scope:'SOC',type:'alert',id:'AL-01'},sourceVersion:'1',basisHash:hash,createdAt:f.stamp},controlGeneration:1,data:payload.data})
 const claim={id:occurrenceId,ownerId:f.owner,planId:f.update.plan_id,planVersion:2,configVersion:2,occurrenceId:'event:'+eventId,fields,source:{kind:'manual'},roleVersion:4,workDefinition:work,event} as PlanOccurrence
 const plan={id:claim.planId,owner_id:f.owner,definition:fields,source:{kind:'manual'},notification_policy:'attention',role_id:f.original.roleId,role_version:4,scope:'SOC',version:14,config_version:2,state:'paused',archived_reason:null,archived_at:null,created_at:new Date(f.stamp),updated_at:new Date(f.stamp),work_definition:work}
 const control={id:controlId,state:'active',generation:23},role={state:'active',version:4},basis={planId:claim.planId,planVersion:14,configVersion:2,state:'paused'}
 const receipt={request_id:randomUUID(),created_at:new Date('2026-11-02T00:00:01.000Z'),plan_basis:basis}
 let receiptPresent=true,tickets:Record<string,unknown>[]=[],extraRuns:Record<string,unknown>[]=[],eventValid=true
 f.original.stopRequestedAt=f.stamp;f.stored.stop_requested_at=f.stamp as never
 f.original.inputText=JSON.stringify({...JSON.parse(f.original.inputText),planContext:{occurrenceId}});f.stored.input_text=f.original.inputText
 const db={query:async(q:string,p:unknown[]=[])=>{
  const rows=(items:Record<string,unknown>[])=>{f.sql.push(q);assert.match(q,/^select\b/);return {rows:items,rowCount:items.length}}
  if(q.includes('teloa_plan_work_events'))return rows([{present:true}])
  if(q.startsWith('select * from teloa_roles'))return rows([role])
  if(q.includes('select * from teloa_plans'))return rows([plan])
  if(q.includes('select id,state,generation from teloa_work_controls'))return rows([control])
  if(q.includes('select task_id from teloa_plan_task_links'))return rows([{task_id:f.original.taskId}])
  if(q.includes("to_regclass('teloa_work_recovery_requests')"))return rows([{requests:true,tickets:true}])
  if(q.includes('from teloa_work_recovery_requests'))return rows(receiptPresent&&p[2]===23?[receipt]:[])
  if(q.startsWith('select id,state,created_at from teloa_task_runs'))return rows([{id:f.original.id,state:'ended',created_at:new Date(f.stamp)},...extraRuns])
  if(q.includes('from teloa_work_recovery_tickets'))return rows(tickets)
  if(q.includes('select event,payload,payload_hash'))return rows([{event:event.event,payload,payload_hash:eventValid?workEventDigest(payload):'0'.repeat(64)}])
  if(q.startsWith('select snapshot_hash'))return rows([{snapshot_hash:hash}])
  if(q.includes("to_regclass('teloa_business_task_source_updates')"))return rows([{relation:true}])
  if(q.startsWith('select 1 from teloa_business_task_source_updates'))return rows([{present:true}])
  return f.db.query(q,p)
 }}
 const service=new PlanOccurrenceService({} as never,{id:randomUUID})
 // 单元核对真实的公共执行上下文所调用的共享准入器，不用测试镜像实现替代判断。
 const gate=(singleOwner?:SourceFollowupPlanAdmission,verification:'live'|'stored'='live')=>(service as unknown as {verifyBusinessEvent:(db:unknown,owner:string,claim:PlanOccurrence,verification:'live'|'stored',proof?:SourceFollowupPlanAdmission)=>Promise<void>}).verifyBusinessEvent(db,f.owner,claim,verification,singleOwner)
 return {...f,db,claim,plan,control,role,basis,gate,setReceipt:(v:boolean)=>receiptPresent=v,setTickets:(v:Record<string,unknown>[])=>tickets=v,setExtraRuns:(v:Record<string,unknown>[])=>extraRuns=v,setEventValid:(v:boolean)=>eventValid=v}
}

test('暂停自动计划：同事务已核停止候选可单次准入，普通/伪造/异事务及变造对象不能借用',async()=>{
 const f=pausedPlanFixture(),before=structuredClone({plan:f.plan,run:f.stored,update:f.update})
 await assert.rejects(f.gate(),{code:'teloa/version-conflict'});await assert.rejects(f.gate(undefined,'stored'),{code:'teloa/version-conflict'})
 const candidate=await sourceFollowupCandidate(f.db as never,f.owner,f.original,9),proof=sourceFollowupPlanAdmission(f.original)!
 assert.equal(candidate.kind,'stopped-continuation');assert.ok(proof);await f.gate(proof)
 assert.equal(sourceFollowupPlanAdmission({...f.original}),undefined)
 await assert.rejects(f.gate({...proof}),{code:'teloa/conflict'})
 for(const [db,owner,task,occurrence,role,version]of [[{},f.owner,f.original.taskId,f.claim.id,f.original.roleId,4],[f.db,'other',f.original.taskId,f.claim.id,f.original.roleId,4],[f.db,f.owner,randomUUID(),f.claim.id,f.original.roleId,4],[f.db,f.owner,f.original.taskId,randomUUID(),f.original.roleId,4],[f.db,f.owner,f.original.taskId,f.claim.id,randomUUID(),4],[f.db,f.owner,f.original.taskId,f.claim.id,f.original.roleId,5]]as const)assert.throws(()=>assertSourceFollowupPlanAdmission(proof,db as never,owner,task,occurrence,role,version),{code:'teloa/conflict'})
 f.original.stopRequestedAt=null;assert.equal(sourceFollowupPlanAdmission(f.original),undefined);await assert.rejects(f.gate(proof),{code:'teloa/conflict'});f.original.stopRequestedAt=f.stamp
 assert.deepEqual({plan:f.plan,run:f.stored,update:f.update},before);assert.ok(f.sql.every(q=>/^select\b/.test(q)))
})

test('持久本人确认在新Run prepared/发送阶段均可重核，仍不启用计划、不改旧stop或派生binding',async()=>{
 const f=pausedPlanFixture(),candidate=await sourceFollowupCandidate(f.db as never,f.owner,f.original,9),{schema:_schema,expectedTaskVersion:_v,runId:_id,...rest}=candidate
 const following:TaskRunSourceFollowup={...rest,schema:'teloa.task-run-source-followup/v1',requestId:randomUUID(),taskVersion:9,originalRunId:f.original.id,instruction:'本人明确继续这一条固定来源，不启用自动计划。',confirmedAt:f.stamp,notice:stoppedContinuationNotice}
 f.setBinding(following)
 const run={...f.original,id:randomUUID(),nativeRequestId:randomUUID(),taskVersion:9,state:'prepared',stopRequestedAt:null,evidence:null,sourceFollowup:following}
 const before=structuredClone({plan:f.plan,old:f.stored,following})
 for(const state of ['prepared','submitting','accepted','active']){run.state=state;await verifySourceFollowup(f.db as never,f.owner,run);const proof=sourceFollowupPlanAdmission(run);assert.ok(proof);await f.gate(proof)}
 run.stopRequestedAt=f.stamp as never;await verifySourceFollowup(f.db as never,f.owner,run);assert.equal(sourceFollowupPlanAdmission(run),undefined,'旧确认不能借已停止的新Run取得发送资格');run.stopRequestedAt=null
 f.confirmations.set(run.id,{...following,instruction:'不同确认'});await assert.rejects(verifySourceFollowup(f.db as never,f.owner,run),{code:'teloa/conflict'});assert.equal(sourceFollowupPlanAdmission(run),undefined)
 assert.deepEqual({plan:f.plan,old:f.stored,following},before)
})

test('暂停单次续办仍拒配置/原件变化、归档、员工失效、控制暂停/换代、未知及其他在途',async()=>{
 const f=pausedPlanFixture();await sourceFollowupCandidate(f.db as never,f.owner,f.original,9);const proof=sourceFollowupPlanAdmission(f.original)!
 const mutations:Array<()=>()=>void>=[
  ()=>{f.plan.config_version=3;return()=>{f.plan.config_version=2}},
  ()=>{f.plan.definition={...f.plan.definition,goal:'另一个目标'};return()=>{f.plan.definition={...f.plan.definition,goal:'核对固定来源'}}},
  ()=>{f.plan.state='archived';f.plan.archived_reason='本人归档' as never;f.plan.archived_at=new Date(f.stamp) as never;return()=>{f.plan.state='paused';f.plan.archived_reason=null;f.plan.archived_at=null}},
  ()=>{f.role.state='paused';return()=>{f.role.state='active'}},
  ()=>{f.role.version=5;return()=>{f.role.version=4}},
  ()=>{f.control.state='paused';return()=>{f.control.state='active'}},
  ()=>{f.control.generation=24;return()=>{f.control.generation=23}},
  ()=>{f.plan.version=15;return()=>{f.plan.version=14}},
  ()=>{f.basis.planVersion=13;return()=>{f.basis.planVersion=14}},
  ()=>{f.setReceipt(false);return()=>f.setReceipt(true)},
  ()=>{f.setExtraRuns([{id:randomUUID(),state:'active',created_at:new Date(f.stamp)}]);return()=>f.setExtraRuns([])},
  ()=>{f.setTickets([{run_id:f.original.id,state:'unknown'}]);return()=>f.setTickets([])},
  ()=>{f.setEventValid(false);return()=>f.setEventValid(true)},
 ]
 for(const mutate of mutations){const undo=mutate();await assert.rejects(f.gate(proof));undo();await f.gate(proof)}
 f.setPending(true);await assert.rejects(sourceFollowupCandidate(f.db as never,f.owner,f.original,9),{code:'teloa/conflict'});assert.equal(sourceFollowupPlanAdmission(f.original),undefined);await assert.rejects(f.gate(proof),{code:'teloa/conflict'})
})
