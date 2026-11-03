import {randomUUID,createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import type {TaskRun} from '../../src/work/task-runs.ts'
import {businessTaskSourceUpdateRunRequestId} from '../../src/work/business-task-source-updates.ts'
export function unpublishedFollowupFixture(){
 const owner=randomUUID(),now=new Date().toISOString(),run:TaskRun={id:randomUUID(),taskId:randomUUID(),roleId:randomUUID(),taskVersion:4,roleVersion:3,linkVersion:1,sessionId:'source-existing',nativeRequestId:randomUUID(),state:'withdrawn',evidence:null,stopRequestedAt:now,allowedTools:[],skills:[],knowledge:[],memory:[],agentPresetId:'worker',roleSnapshot:{} as never,inputText:'',createdAt:now}
 const reference={scope:'business_'+randomUUID().replaceAll('-',''),type:'source-alert',id:'AL01',version:2,snapshotHash:'a'.repeat(64)}
 run.inputText=JSON.stringify({businessContext:{updates:[reference]}})
 const update={id:randomUUID(),owner_id:owner,task_id:run.taskId,run_id:run.id,task_version:run.taskVersion,state:'needs-user',reason:'teloa/run-not-accepted',scope_id:reference.scope,object_type:reference.type,object_id:reference.id,object_version:reference.version,snapshot_hash:reference.snapshotHash,event_id:randomUUID(),plan_id:randomUUID()}
 const receipt={schema:'teloa.task-run-unpublished-cancellation/v1',requestId:randomUUID(),identity:{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,inputSha256:createHash('sha256').update(run.inputText).digest('hex')},runtimeId:randomUUID(),attemptIds:[randomUUID()],latestAttemptId:'',logCut:-1,logSha256:createHash('sha256').update('[]').digest('hex'),stopRequestedAt:now,cancelledAt:now};receipt.latestAttemptId=receipt.attemptIds[0]!
 const saved={request_id:receipt.requestId,receipt,audit:null},attempt={attempt_id:receipt.latestAttemptId,runtime_id:receipt.runtimeId,state:'not-published',settled_at:new Date(now),session_id:run.sessionId,native_request_id:run.nativeRequestId,input_sha256:receipt.identity.inputSha256}
 const mutations={effect:false,current:true,receipt:true,sourceVersion:2,unknownBudget:false}
 const query=async(sql:string,_params?:unknown[])=>{
  let rows:unknown[]=[]
  if(sql.startsWith('select id from teloa_task_runs'))rows=mutations.current?[{id:run.id}]:[]
  else if(sql.startsWith('select request_id,receipt,audit'))rows=mutations.receipt?[saved]:[]
  else if(sql.startsWith('select * from teloa_task_run_submissions'))rows=[attempt]
  else if(sql.startsWith('select * from teloa_business_task_source_updates'))rows=[update]
  else if(sql.startsWith('select request_id from teloa_task_runs'))rows=[{request_id:businessTaskSourceUpdateRunRequestId(owner,update.id)}]
  else if(sql.startsWith('select s.*'))rows=[{scope_id:reference.scope,object_type:reference.type,object_id:reference.id,object_version:1}]
  else if(sql.startsWith('select max(object_version)'))rows=[{version:mutations.sourceVersion}]
  else if(sql.startsWith('select 1 from teloa_work_budget_reservations')&&mutations.unknownBudget)rows=[{one:1}]
  else if(sql.startsWith('select 1 from teloa_task_run_flows')&&mutations.effect)rows=[{one:1}]
  return {rows,rowCount:rows.length}
 }
 return {db:{query} as unknown as PoolClient,owner,run,receipt,attempt,update,mutations}
}
