import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,readTaskRunFlow,readTaskRunFlowDefinition,readTaskRunFlowTransition,taskRunFlowRequiresFlow,taskRunFlowState,type TaskRunFlow,type TaskRunFlowStep} from '@teloa/contract'
import {authorizeOwnerWork,type OwnerWorkAuthority} from './twin-execution-consents.ts'
import {WorkLineageService} from './work-lineage.ts'
import {bindFlowWait,initializeFlowWaitBindings,readFlowWaitInputs,verifyFlowWait,type FlowWaitPorts,type FlowWaitInput} from './task-run-flow-waits.ts'
import type {WorkAccessLease} from './work-access.ts'
export type TaskRunFlowPorts=FlowWaitPorts&{authority:OwnerWorkAuthority;admit:(db:PoolClient,owner:string,runId:string)=>Promise<WorkAccessLease>}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const actor=(owner:string)=>{if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要本人身份。')}
const corrupt=()=>new WorkError('teloa/storage-corrupt','内部 Flow 记录与固定定义不一致。')

export async function initializeTaskRunFlows(pool:Pool):Promise<void>{
 await pool.query(`
  create unique index if not exists teloa_task_run_owner_identity on teloa_task_runs(id,owner_id);
  create table if not exists teloa_task_run_flows(
   flow_id uuid primary key,owner_id text not null,run_id uuid not null,request_id uuid not null,request_spec jsonb not null,
   definition_version integer not null check(definition_version>0),state text not null check(state in ('active','waiting','failed','completed','compensated')),
   steps jsonb not null check(jsonb_typeof(steps)='array'),created_at timestamptz not null,updated_at timestamptz not null,
   unique(owner_id,request_id),unique(owner_id,run_id),unique(flow_id,run_id,owner_id),
   foreign key(run_id,owner_id) references teloa_task_runs(id,owner_id)
  );
  create unique index if not exists teloa_task_run_flow_owner_identity on teloa_task_run_flows(flow_id,owner_id);
  create table if not exists teloa_task_run_flow_receipts(
   owner_id text not null,request_id uuid not null,flow_id uuid not null,request_spec jsonb not null,result jsonb not null,created_at timestamptz not null,
   primary key(owner_id,request_id),foreign key(flow_id,owner_id) references teloa_task_run_flows(flow_id,owner_id)
  );
  do $$ begin
   if not exists(select 1 from pg_constraint where conrelid='teloa_task_runs'::regclass and conname='teloa_task_runs_flow_v1') then
    alter table teloa_task_runs add constraint teloa_task_runs_flow_v1 foreign key(flow_id,id,owner_id) references teloa_task_run_flows(flow_id,run_id,owner_id) deferrable initially deferred;
   end if;
  end $$;
 `)
 await pool.query('alter table teloa_task_run_flows add column if not exists confirmed_request jsonb')
 await initializeFlowWaitBindings(pool)
}

function definitionOf(flow:TaskRunFlow){return {definitionVersion:flow.definitionVersion,steps:flow.steps.map(({state:_state,attempts:_attempts,outputSummary:_output,waitReason:_reason,startedAt:_started,updatedAt:_updated,completedAt:_completed,...step})=>step)}}
function read(row:Record<string,unknown>):TaskRunFlow{
 let flow:TaskRunFlow
 try{flow=readTaskRunFlow({flowId:row.flow_id,runId:row.run_id,definitionVersion:row.definition_version,state:row.state,steps:row.steps,createdAt:row.created_at instanceof Date?row.created_at.toISOString():row.created_at,updatedAt:row.updated_at instanceof Date?row.updated_at.toISOString():row.updated_at})}catch{throw corrupt()}
 try{
  const fixed=taskInput(row.request_spec,['requestId','runId','definitionVersion','steps'])
  if(fixed.requestId!==row.request_id||fixed.runId!==flow.runId||JSON.stringify(readTaskRunFlowDefinition({definitionVersion:fixed.definitionVersion,steps:fixed.steps}))!==JSON.stringify(definitionOf(flow)))throw Error()
 }catch{throw corrupt()}
 return flow
}

function initialSteps(steps:ReturnType<typeof readTaskRunFlowDefinition>['steps'],now:string):TaskRunFlowStep[]{
 return steps.map(step=>({...step,state:step.kind!=='compensation'&&step.dependsOn.length===0?'ready':'blocked',attempts:0,outputSummary:null,waitReason:null,startedAt:null,updatedAt:now,completedAt:null}))
}

function assertSubagentScopes(run:Record<string,unknown>,steps:ReturnType<typeof readTaskRunFlowDefinition>['steps']){
 let allowedTools:string[],knowledgeIds:string[],skillNames:string[]
 try{
  if(!Array.isArray(run.allowed_tools)||!Array.isArray(run.role_knowledge)||!Array.isArray(run.role_skills))throw Error()
  allowedTools=run.allowed_tools.map(value=>{if(typeof value!=='string')throw Error();return value})
  knowledgeIds=run.role_knowledge.map(value=>{if(!value||typeof value!=='object'||Array.isArray(value)||typeof (value as Record<string,unknown>).id!=='string')throw Error();return (value as Record<string,unknown>).id as string})
  skillNames=run.role_skills.map(value=>{if(!value||typeof value!=='object'||Array.isArray(value)||typeof (value as Record<string,unknown>).name!=='string')throw Error();return (value as Record<string,unknown>).name as string})
 }catch{throw corrupt()}
 for(const step of steps){
  const execution=step.execution;if(!execution)continue
  if(execution.parentSessionId!==run.session_id||execution.agentPresetId!==run.agent_preset_id||execution.allowedTools.some(value=>!allowedTools.includes(value))||execution.knowledgeIds.some(value=>!knowledgeIds.includes(value))||execution.skillNames.some(value=>!skillNames.includes(value)))throw new WorkError('teloa/forbidden','临时子 Agent 只能继承并收窄父 Run 的配置、会话和授权范围。')
 }
}

const dependencyComplete=(step:TaskRunFlowStep)=>step.state==='succeeded'||step.state==='compensated'
function settle(steps:TaskRunFlowStep[],now:string){
 const byId=new Map(steps.map(step=>[step.id,step]))
 let changed:boolean
 do{
  changed=false
  for(const step of steps){
   if(step.state!=='blocked')continue
   const dependencies=step.dependsOn.map(id=>byId.get(id)!)
   if(step.kind==='compensation'){
    const target=byId.get(step.compensates!)!
    if(target.state==='succeeded'||target.state==='cancelled'||target.state==='failed'&&dependencies.some(item=>item.state==='failed'||item.state==='cancelled')){step.state='cancelled';step.updatedAt=now;step.completedAt=now;changed=true}
    else if(target.state==='failed'&&dependencies.every(dependencyComplete)){step.state='ready';step.updatedAt=now;changed=true}
   }else if(dependencies.some(item=>item.state==='failed'||item.state==='cancelled')){step.state='cancelled';step.updatedAt=now;step.completedAt=now;changed=true}
   else if(dependencies.every(dependencyComplete)){step.state='ready';step.updatedAt=now;changed=true}
  }
 }while(changed)
}

export class TaskRunFlowService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly ports:TaskRunFlowPorts|undefined
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},ports?:TaskRunFlowPorts){this.pool=pool;this.identity=identity;this.ports=ports}
 async get(owner:string,input:unknown):Promise<TaskRunFlow|null>{
  actor(owner);const row=taskInput(input,['runId']);if(!uuid(row.runId))throw new WorkError('teloa/invalid-input','运行身份不正确。')
  const run=await this.pool.query('select id from teloa_task_runs where owner_id=$1 and id=$2',[owner,row.runId]);if(!run.rows[0])throw new WorkError('teloa/forbidden','运行不属于本人。')
  const result=await this.pool.query('select * from teloa_task_run_flows where owner_id=$1 and run_id=$2',[owner,row.runId]);return result.rows[0]?read(result.rows[0]):null
 }
 async createConfirmed(owner:string,input:unknown):Promise<TaskRunFlow>{
  const row=taskInput(input,['requestId','runId','definitionVersion','steps','waitBindings']),waits=readFlowWaitInputs(row.waitBindings),definition=readTaskRunFlowDefinition({definitionVersion:row.definitionVersion,steps:row.steps})
  if(definition.steps.some(s=>s.execution)||definition.steps.filter(s=>s.kind==='human_checkpoint'||s.kind==='wait_external').length!==waits.length||waits.some(w=>!definition.steps.some(s=>s.id===w.stepId&&(s.kind==='human_checkpoint'||s.kind==='wait_external'))))throw new WorkError('teloa/invalid-input','请明确绑定等待来源；子执行配置由实际 Run 固定。')
  return this.create(owner,{requestId:row.requestId,runId:row.runId,...definition},{request:{...row,steps:definition.steps,waitBindings:waits},waits})
 }
 async create(owner:string,input:unknown,confirmed?:{request:Record<string,unknown>;waits:FlowWaitInput[]}):Promise<TaskRunFlow>{
  actor(owner);const row=taskInput(input,['requestId','runId','definitionVersion','steps'])
  if(!uuid(row.requestId)||!uuid(row.runId))throw new WorkError('teloa/invalid-input','Flow 请求或运行身份不正确。')
  let definition=readTaskRunFlowDefinition({definitionVersion:row.definitionVersion,steps:row.steps})
  if(!taskRunFlowRequiresFlow(definition))throw new WorkError('teloa/flow-not-required','普通 Run 不创建内部 Flow。')
  let request={requestId:row.requestId,runId:row.runId,...definition},spec=JSON.stringify(request);const db=await this.pool.connect()
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['task-run-flow-request',owner,row.requestId])])
   const previous=await db.query('select *,request_spec=$3::jsonb as same from teloa_task_run_flows where owner_id=$1 and request_id=$2',[owner,row.requestId,spec])
   if(previous.rows[0]){if(confirmed?!isDeepStrictEqual(previous.rows[0].confirmed_request,confirmed.request):!previous.rows[0].same||previous.rows[0].confirmed_request!==null)throw new WorkError('teloa/conflict','同一请求已用于其他内部 Flow。');const fixed=read(previous.rows[0]);await db.query('commit');return fixed}
   if(confirmed&&!this.ports)throw new WorkError('teloa/dependency-unavailable','真实本人 Flow 准入服务尚未接入。')
   const admission=confirmed?await this.ports!.admit(db,owner,row.runId as string):undefined
   const runs=await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for update',[owner,row.runId])
   if(!runs.rows[0])throw new WorkError('teloa/forbidden','运行不属于本人。')
   if(runs.rows[0].flow_id!==null)throw new WorkError('teloa/conflict','本次 Run 已有内部 Flow。')
   if(!['prepared','submitting','accepted','active'].includes(String(runs.rows[0].state)))throw new WorkError('teloa/conflict','当前 Run 生命周期不能创建内部 Flow。')
   const authority=confirmed?await authorizeOwnerWork(this.ports!.authority,owner,{requestId:row.requestId as string,roleId:runs.rows[0].role_id,operation:'confirm'}):undefined
   if(confirmed){const parent=runs.rows[0];if(!parent.agent_preset_id)throw new WorkError('teloa/forbidden','父执行缺少真实运行配置。');const execution={kind:'subagent' as const,parentSessionId:parent.session_id,agentPresetId:parent.agent_preset_id,allowedTools:[...parent.allowed_tools],knowledgeIds:parent.role_knowledge.map((k:any)=>k.id),skillNames:parent.role_skills.map((s:any)=>s.name)};definition={...definition,steps:definition.steps.map(step=>step.kind==='work'||step.kind==='compensation'?{...step,execution}:step)};request={requestId:row.requestId,runId:row.runId,...definition};spec=JSON.stringify(request)}
   assertSubagentScopes(runs.rows[0],definition.steps)
   const flowId=this.identity.id(),now=this.identity.now(),steps=initialSteps(definition.steps,now)
   const saved=await db.query("insert into teloa_task_run_flows(flow_id,owner_id,run_id,request_id,request_spec,definition_version,state,steps,created_at,updated_at) values($1,$2,$3,$4,$5,$6,'active',$7,$8,$8) returning *",[flowId,owner,row.runId,row.requestId,spec,definition.definitionVersion,JSON.stringify(steps),now])
   await db.query('update teloa_task_runs set flow_id=$3 where owner_id=$1 and id=$2 and flow_id is null',[owner,row.runId,flowId])
   const result=read(saved.rows[0])
   if(confirmed){await db.query('update teloa_task_run_flows set confirmed_request=$3 where owner_id=$1 and flow_id=$2',[owner,flowId,JSON.stringify(confirmed.request)]);for(const source of confirmed.waits)await bindFlowWait(db,new WorkLineageService(this.pool,this.identity),owner,result,runs.rows[0],source,row.requestId as string,now)}
   admission?.assertCurrent();authority?.assertCurrent();await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async transitionVerified(owner:string,input:unknown,proof:{reservationId:string}|{eventId:string}):Promise<TaskRunFlow>{return this.transition(owner,input,proof)}
 async rebindWaitConfirmed(owner:string,input:unknown):Promise<TaskRunFlow>{
  actor(owner);const request=taskInput(input,['requestId','runId','flowId','stepId','expectedAttempts','expectedBindingVersion','sourceKind','sourceId']),source=readFlowWaitInputs([{stepId:request.stepId,sourceKind:request.sourceKind,sourceId:request.sourceId}])[0]!
  if(!uuid(request.requestId)||!uuid(request.runId)||!uuid(request.flowId)||!Number.isSafeInteger(request.expectedAttempts)||Number(request.expectedAttempts)<1||!Number.isSafeInteger(request.expectedBindingVersion)||Number(request.expectedBindingVersion)<1)throw new WorkError('teloa/invalid-input','等待来源确认请求不正确。')
  const spec=JSON.stringify({kind:'rebind-wait',...request}),db=await this.pool.connect();try{await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['task-run-flow-transition',owner,request.requestId])]);const prior=(await db.query('select *,request_spec=$3::jsonb as same from teloa_task_run_flow_receipts where owner_id=$1 and request_id=$2',[owner,request.requestId,spec])).rows[0]
   if(prior){if(!prior.same)throw new WorkError('teloa/conflict','原请求已保存其他等待来源。');const result=readTaskRunFlow(prior.result);if(result.flowId!==request.flowId||result.runId!==request.runId)throw corrupt();await db.query('commit');return result}
   if(!this.ports)throw new WorkError('teloa/dependency-unavailable','真实本人 Flow 准入服务尚未接入。');const admission=await this.ports.admit(db,owner,request.runId)
   const raw=(await db.query('select * from teloa_task_run_flows where owner_id=$1 and flow_id=$2 and run_id=$3 for update',[owner,request.flowId,request.runId])).rows[0];if(!raw?.confirmed_request)throw new WorkError('teloa/forbidden','此 Flow 未由本人确认。');const flow=read(raw),step=flow.steps.find(s=>s.id===source.stepId)
   const run=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for update',[owner,flow.runId])).rows[0];if(!run||!['accepted','active'].includes(run.state)||run.flow_id!==flow.flowId||!step||step.state!=='waiting'||step.attempts!==request.expectedAttempts)throw new WorkError('teloa/version-conflict','本次等待或父执行已变化。')
   const version=(await db.query('select max(binding_version) as version from teloa_task_run_flow_waits where owner_id=$1 and flow_id=$2 and step_id=$3',[owner,flow.flowId,source.stepId])).rows[0].version;if(version!==request.expectedBindingVersion)throw new WorkError('teloa/version-conflict','等待来源已变化。')
   const authority=await authorizeOwnerWork(this.ports.authority,owner,{requestId:request.requestId,roleId:run.role_id,operation:'confirm'}),now=this.identity.now();await bindFlowWait(db,new WorkLineageService(this.pool,this.identity),owner,flow,run,source,request.requestId,now);await db.query('insert into teloa_task_run_flow_receipts(owner_id,request_id,flow_id,request_spec,result,created_at) values($1,$2,$3,$4,$5,$6)',[owner,request.requestId,flow.flowId,spec,JSON.stringify(flow),now]);admission.assertCurrent();authority.assertCurrent();await db.query('commit');return flow
  }catch(cause){await db.query('rollback');throw cause}finally{db.release()}
 }
 async completeWait(owner:string,input:{requestId:string;flowId:string;stepId:string;expectedAttempts:number;eventId:string}):Promise<TaskRunFlow>{const {eventId,...request}=input;return this.transitionVerified(owner,{...request,action:'succeed',outputSummary:'可信等待来源已核验'},{eventId})}
 async readWait(owner:string,input:{runId:string;flowId:string;stepId:string;expectedAttempts:number}):Promise<{eventId:string;summary:string}|null>{
  actor(owner);const db=await this.pool.connect();try{await db.query('begin');const row=(await db.query('select * from teloa_task_run_flows where owner_id=$1 and flow_id=$2 and run_id=$3',[owner,input.flowId,input.runId])).rows[0];if(!row||!row.confirmed_request||!this.ports)throw new WorkError('teloa/forbidden','等待 Flow 不属于当前本人或没有可信来源端口。');const flow=read(row),step=flow.steps.find(s=>s.id===input.stepId);if(!step||step.attempts!==input.expectedAttempts||step.state!=='waiting'){await db.query('commit');return null}const binding=(await db.query('select binding from teloa_task_run_flow_waits where owner_id=$1 and flow_id=$2 and step_id=$3 order by binding_version desc limit 1',[owner,flow.flowId,step.id])).rows[0];if(!binding)throw new WorkError('teloa/storage-corrupt','等待步骤缺少已保存来源。');const events=(await db.query("select id from teloa_work_events where owner_id=$1 and event->>'kind'=$2 and event->>'sourceId'=$3 order by created_at desc limit 100",[owner,binding.binding.sourceKind,binding.binding.sourceId])).rows;for(const event of events){try{const summary=await verifyFlowWait(db,owner,flow,step,event.id,this.ports);await db.query('commit');return {eventId:event.id,summary}}catch(cause){if(!cause||typeof cause!=='object'||!('code'in cause)||cause.code!=='teloa/forbidden')throw cause}}await db.query('commit');return null}catch(cause){await db.query('rollback');throw cause}finally{db.release()}
 }
 async waitSources(owner:string,input:unknown){
  actor(owner);const request=taskInput(input,['runId']);if(!uuid(request.runId))throw new WorkError('teloa/invalid-input','运行身份不正确。')
  const row=(await this.pool.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,request.runId])).rows[0];if(!row)throw new WorkError('teloa/forbidden','执行不属于本人。')
  const present=(await this.pool.query("select to_regclass('teloa_security_actions') is not null as present")).rows[0].present
  const bindings=row.flow_id?(await this.pool.query('select distinct on(step_id) step_id,binding_version,binding from teloa_task_run_flow_waits where owner_id=$1 and flow_id=$2 order by step_id,binding_version desc',[owner,row.flow_id])).rows.map(b=>({stepId:b.step_id,version:b.binding_version,sourceKind:b.binding.sourceKind,sourceId:b.binding.sourceId})):[]
  return {materials:row.role_knowledge.map((k:any)=>({id:k.id,title:k.title})),approvals:present?(await this.pool.query("select id,title from teloa_security_actions where owner_id=$1 and task_id=$2 and state in ('proposed','pending_approval','approved') order by created_at",[owner,row.task_id])).rows:[],bindings}
 }
 async transition(owner:string,input:unknown,proof?:{reservationId:string}|{eventId:string}):Promise<TaskRunFlow>{
  actor(owner);const request=readTaskRunFlowTransition(input),spec=JSON.stringify({...request,...(proof?{executionReceipt:proof}:{})}),db=await this.pool.connect()
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['task-run-flow-transition',owner,request.requestId])])
   const previous=await db.query('select *,request_spec=$3::jsonb as same from teloa_task_run_flow_receipts where owner_id=$1 and request_id=$2',[owner,request.requestId,spec])
   if(previous.rows[0]){
    if(!previous.rows[0].same)throw new WorkError('teloa/conflict','同一请求已用于其他 Flow 步骤回执。')
    let result:TaskRunFlow;try{result=readTaskRunFlow(previous.rows[0].result);if(result.flowId!==previous.rows[0].flow_id||result.flowId!==request.flowId)throw Error()}catch{throw corrupt()}
    await db.query('commit');return result
   }
   const hint=(await db.query('select run_id,confirmed_request from teloa_task_run_flows where owner_id=$1 and flow_id=$2',[owner,request.flowId])).rows[0]
   if(hint?.confirmed_request&&!this.ports)throw new WorkError('teloa/dependency-unavailable','真实本人 Flow 准入服务尚未接入。')
   const admission=hint?.confirmed_request&&this.ports?await this.ports.admit(db,owner,hint.run_id):undefined
   const rows=await db.query('select * from teloa_task_run_flows where owner_id=$1 and flow_id=$2 for update',[owner,request.flowId])
   if(!rows.rows[0])throw new WorkError('teloa/forbidden','内部 Flow 不属于本人。')
   const current=read(rows.rows[0])
   const parents=await db.query('select id,owner_id,flow_id,state from teloa_task_runs where id=$1 for update',[current.runId]),parent=parents.rows[0]
   if(!parent||parent.owner_id!==owner||parent.flow_id!==current.flowId)throw corrupt()
   if(!['prepared','submitting','accepted','active'].includes(String(parent.state)))throw new WorkError('teloa/conflict','父 Run 已结束，不能继续推进内部 Flow。')
   const steps=current.steps.map(step=>({...step,dependsOn:[...step.dependsOn],...(step.execution?{execution:{...step.execution,allowedTools:[...step.execution.allowedTools],knowledgeIds:[...step.execution.knowledgeIds],skillNames:[...step.execution.skillNames]}}:{})})),step=steps.find(candidate=>candidate.id===request.stepId)
   if(!step)throw new WorkError('teloa/invalid-input','Flow 步骤不属于固定定义。')
   if(step.attempts!==request.expectedAttempts)throw new WorkError('teloa/version-conflict','Flow 步骤尝试次数已变化，请读取当前状态。')
   const now=this.identity.now()
   if(rows.rows[0].confirmed_request&&request.action==='resume')throw new WorkError('teloa/forbidden','等待步骤只能凭原操作及当前控制世代的真实收据推进。')
   if(request.action==='succeed'){
    const present=(await db.query("select to_regclass('teloa_plan_task_links') is not null as present")).rows[0].present
    const persistent=present&&(await db.query("select 1 from teloa_plan_task_links l join teloa_plan_occurrences o on o.id=l.claim_id join teloa_task_runs r on r.task_id=l.task_id and r.owner_id=l.owner_id where r.owner_id=$1 and r.id=$2 and o.snapshot ? 'workDefinition'",[owner,current.runId])).rowCount
    if(proof&&'eventId'in proof){if(!rows.rows[0].confirmed_request)throw new WorkError('teloa/forbidden','此 Flow 尚未确认真实等待来源。');step.outputSummary=await verifyFlowWait(db,owner,current,step,proof.eventId,this.ports);step.state='running';step.waitReason=null}
    else if(persistent||proof||rows.rows[0].confirmed_request){
     const expected='flow:'+current.flowId+':'+step.id+':'+step.attempts
     const receipt=proof&&'reservationId'in proof&&(await db.query("select * from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and reservation_id=$3 for share",[owner,current.runId,proof.reservationId])).rows[0]
     if(!receipt||!proof||!('reservationId'in proof)||proof.reservationId!==expected||receipt.state!=='ended'||receipt.stop_reason!=='completed'||!receipt.child_session_id||!receipt.ended_at)throw new WorkError('teloa/forbidden','长期工作步骤缺少本次实际执行回执。')
    }
   }
   if(request.action==='start'){
    if(step.state!=='ready')throw new WorkError('teloa/conflict','当前 Flow 步骤不能开始。')
    step.state='running';step.attempts++;step.startedAt=now;step.outputSummary=null;step.waitReason=null;step.completedAt=null
   }else if(request.action==='wait'){
    if(step.state!=='running'||!['wait_external','human_checkpoint'].includes(step.kind))throw new WorkError('teloa/conflict','当前 Flow 步骤不能进入等待。')
    step.state='waiting';step.waitReason=request.waitReason!
   }else if(request.action==='resume'){
    if(step.state!=='waiting')throw new WorkError('teloa/conflict','当前 Flow 步骤不能恢复。')
    step.state='running';step.waitReason=null
   }else if(request.action==='succeed'){
    if(step.state!=='running')throw new WorkError('teloa/conflict','当前 Flow 步骤不能完成。')
    step.state=step.kind==='compensation'?'compensated':'succeeded';step.outputSummary=proof&&'eventId'in proof?step.outputSummary:request.outputSummary!;step.waitReason=null;step.completedAt=now
   }else{
    if(step.state!=='running')throw new WorkError('teloa/conflict','当前 Flow 步骤不能失败。')
    step.state='failed';step.outputSummary=request.outputSummary!;step.waitReason=null;step.completedAt=now
   }
   step.updatedAt=now;settle(steps,now)
   const state=taskRunFlowState(steps),saved=await db.query('update teloa_task_run_flows set state=$3,steps=$4,updated_at=$5 where owner_id=$1 and flow_id=$2 returning *',[owner,current.flowId,state,JSON.stringify(steps),now]),result=read(saved.rows[0])
   await db.query('insert into teloa_task_run_flow_receipts(owner_id,request_id,flow_id,request_spec,result,created_at) values($1,$2,$3,$4,$5,$6)',[owner,request.requestId,current.flowId,spec,JSON.stringify(result),now])
   admission?.assertCurrent();await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}

export {read as readStoredTaskRunFlow}
