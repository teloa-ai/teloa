import {createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import {WorkError,taskInput,workUuid,type WorkEvent,type TaskRunFlow,type TaskRunFlowStep} from '@teloa/contract'
import {WorkLineageService} from './work-lineage.ts'
import type {WorkEventService} from './work-events.ts'
export type FlowWaitInput={stepId:string;sourceKind:WorkEvent['kind'];sourceId:string}
export type FlowWaitPorts={verifiedSource:WorkEventService['verifiedSourceInTransaction']}
const denied=()=>new WorkError('teloa/forbidden','等待步骤缺少当前原操作、真实来源或控制世代回执。')
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,Object.keys(value as object).sort())).digest('hex')
export async function initializeFlowWaitBindings(db:Pick<PoolClient,'query'>){await db.query(`
 create table if not exists teloa_task_run_flow_waits(owner_id text not null,flow_id uuid not null,step_id text not null,binding_version integer not null check(binding_version>0),request_id uuid not null,binding jsonb not null,binding_hash text not null,created_at timestamptz not null,primary key(owner_id,flow_id,step_id,binding_version),unique(owner_id,request_id,step_id),foreign key(flow_id,owner_id) references teloa_task_run_flows(flow_id,owner_id));
 create or replace function teloa_flow_wait_immutable() returns trigger language plpgsql as $$ begin raise exception 'flow wait source is immutable'; end $$;
 create or replace trigger teloa_task_run_flow_waits_immutable before update or delete on teloa_task_run_flow_waits for each row execute function teloa_flow_wait_immutable();
`)}
export function readFlowWaitInputs(value:unknown):FlowWaitInput[]{if(!Array.isArray(value)||value.length>100)throw denied();const rows=value.map(input=>{const v=taskInput(input,['stepId','sourceKind','sourceId']);if(typeof v.stepId!=='string'||!/^[a-zA-Z0-9][-_a-zA-Z0-9]{0,119}$/.test(v.stepId)||!['approval-result','material-version','group-message','child-completed'].includes(String(v.sourceKind))||!workUuid(v.sourceId))throw denied();return v as FlowWaitInput});if(new Set(rows.map(v=>v.stepId)).size!==rows.length)throw denied();return rows}
export async function bindFlowWait(db:PoolClient,lineages:WorkLineageService,owner:string,flow:TaskRunFlow,run:Record<string,any>,source:FlowWaitInput,requestId:string,now:string){
 const step=flow.steps.find(s=>s.id===source.stepId);if(!step||!['wait_external','human_checkpoint'].includes(step.kind)||step.kind==='human_checkpoint'&&source.sourceKind!=='approval-result'||step.kind==='wait_external'&&source.sourceKind==='approval-result')throw denied()
 const lineage=await lineages.readInTransaction(db,owner,{taskId:run.task_id});if(!lineage)throw denied()
 const control=(await db.query('select state,generation,updated_at from teloa_work_controls where owner_id=$1 and id=$2 for share',[owner,lineage.roundControlId])).rows[0];if(!control||control.state!=='active')throw denied()
 let operationRequestId:string|null=null,baseline:string|null=null
 if(source.sourceKind==='approval-result'){const action=(await db.query('select a.*,q.request_id as original_request_id from teloa_security_actions a join lateral(select request_id from teloa_security_action_requests where owner_id=a.owner_id and result_action_id=a.id order by result_action_version limit 1) q on true where a.owner_id=$1 and a.id=$2 and a.task_id=$3 for share of a',[owner,source.sourceId,run.task_id])).rows[0];if(!action||!['proposed','pending_approval','approved'].includes(action.state))throw denied();if(action.state==='approved'){const approval=(await db.query("select created_at,expires_at from teloa_security_approvals where owner_id=$1 and action_id=$2 and action_version=$3 and decision='approved' for share",[owner,action.id,action.version-1])).rows[0];if(!approval||approval.expires_at.toISOString()<=now||approval.created_at<control.updated_at)throw denied()}operationRequestId=action.original_request_id}
 else if(source.sourceKind==='material-version'){if(!run.role_knowledge.some((r:any)=>r.id===source.sourceId))throw denied();const row=(await db.query("select * from teloa_resources where owner_id=$1 and id=$2 and status='active' for share",[owner,source.sourceId])).rows[0];if(!row)throw denied();baseline=String(row.revision)+':'+row.spec.sourceVersion}
 else if(source.sourceKind==='group-message'){if(JSON.parse(run.input_text).groupContext?.groupId!==source.sourceId)throw denied()}
 else if(source.sourceId!==flow.runId)throw denied()
 const version=Number((await db.query('select coalesce(max(binding_version),0) as version from teloa_task_run_flow_waits where owner_id=$1 and flow_id=$2 and step_id=$3',[owner,flow.flowId,step.id])).rows[0].version)+1
 const binding={flowId:flow.flowId,runId:flow.runId,stepId:step.id,attempt:step.attempts||1,sourceKind:source.sourceKind,sourceId:source.sourceId,roundControlId:lineage.roundControlId,controlGeneration:control.generation,operationRequestId,baseline}
 await db.query('insert into teloa_task_run_flow_waits(owner_id,flow_id,step_id,binding_version,request_id,binding,binding_hash,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)',[owner,flow.flowId,step.id,version,requestId,JSON.stringify(binding),hash(binding),now])
}
export async function verifyFlowWait(db:PoolClient,owner:string,flow:TaskRunFlow,step:TaskRunFlowStep,eventId:string,ports:FlowWaitPorts|undefined){
 if(!ports||!['wait_external','human_checkpoint'].includes(step.kind)||step.state!=='waiting')throw denied()
 const row=(await db.query('select * from teloa_task_run_flow_waits where owner_id=$1 and flow_id=$2 and step_id=$3 order by binding_version desc limit 1 for share',[owner,flow.flowId,step.id])).rows[0];if(!row||hash(row.binding)!==row.binding_hash)throw denied();const b=row.binding
 if(b.flowId!==flow.flowId||b.runId!==flow.runId||b.stepId!==step.id||b.attempt!==step.attempts)throw denied()
 const control=(await db.query('select state,generation from teloa_work_controls where owner_id=$1 and id=$2 for share',[owner,b.roundControlId])).rows[0];if(!control||control.state!=='active'||control.generation!==b.controlGeneration)throw denied()
 const {event,payload}=await ports.verifiedSource(db,owner,eventId)
 if(event.ownerId!==owner||event.kind!==b.sourceKind||event.sourceId!==b.sourceId)throw denied()
 if(event.kind==='approval-result'){if(payload.operationRequestId!==b.operationRequestId||payload.roundControlId!==b.roundControlId||payload.controlGeneration!==b.controlGeneration)throw denied()}
 else if(event.kind==='material-version'){if(event.sourceVersion===b.baseline)throw denied()}
 else if(event.createdAt<row.created_at.toISOString())throw denied()
 return event.kind==='approval-result'?'原操作的本人审批已核验':'已核验所绑定的本机来源事件'
}
