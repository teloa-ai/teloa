import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,readSecurityAction,securityActionProposalInput,securityActionSubmitInput,securityActionWithdrawInput,securityFailureAcknowledgementInput,securityActionStates,securityActionTransitions,type SecurityPrincipal,type SecurityAction,type SecurityActionDefinitionCatalog,type SecurityActionFrozenValues,type SecurityActionSubmitInput,type SecurityActionProposalInput} from '@teloa/contract'
import {readStoredTask} from '../work/tasks.ts'
import {readBusinessTaskSource} from '../work/business-tasks.ts'
import {businessTaskSourceDigest} from '../work/business-task-source-digest.ts'
import {readBusinessObjectSnapshot} from '../work/business-data.ts'
import {securityParamFingerprint,securityTargetFingerprint} from './action-authorization.ts'
import {SecurityRequestJournal,type SecurityIdentity,type SecurityRequestCommand} from './request-journal.ts'

export interface SecurityExecutionExistsReader{existsForAction(db:PoolClient,ownerId:string,actionId:string):Promise<boolean>}
export const securityFrozenColumns=['frozen_task_definition_digest','frozen_source_snapshot_digest','frozen_object_snapshot_hash','frozen_playbook_version','frozen_param_fingerprint','frozen_target_fingerprint'] as const
const frozenKeys=['taskDefinitionDigest','sourceSnapshotDigest','objectSnapshotHash','playbookVersion','paramFingerprint','targetFingerprint'] as const
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const text=(v:unknown):v is string=>typeof v==='string'&&!!v&&v===v.trim()&&v.length<=128&&!/[\x00-\x1f\x7f]/.test(v)
export const securityStorageError=()=>new WorkError('teloa/storage-corrupt','安全动作记录或结果绑定损坏，已停止读取。')
export function securityPrincipal(principal:SecurityPrincipal):void{
 if(!principal||!text(principal.ownerId)||!text(principal.approverId)||!Array.isArray(principal.scopeIds)||new Set(principal.scopeIds).size!==principal.scopeIds.length||principal.scopeIds.some(scope=>!text(scope))||!principal.scopeIds.includes('SOC'))throw new WorkError('teloa/forbidden','需要有效本人身份与 SOC 授权范围。')
}
export function securityRequestSpec(command:SecurityRequestCommand,principal:SecurityPrincipal,input:{requestId:string}):Record<string,unknown>{
 const {requestId:_,...content}=input
 return {command,approverId:principal.approverId,...content}
}
export async function initializeSecurityActions(pool:Pool):Promise<void>{
 const db=await pool.connect()
 try{await db.query('begin')
  await db.query(`create table if not exists teloa_security_action_transitions(from_state text not null,to_state text not null,primary key(from_state,to_state));
   create table if not exists teloa_security_actions(
    id uuid primary key,owner_id text not null,task_id uuid not null,
    scope_id text not null check(scope_id='SOC'),source_id text not null check(source_id='security-alert-http'),object_type text not null,object_id text not null,object_version integer not null check(object_version>0),
    object_snapshot_hash text not null check(object_snapshot_hash~'^[a-f0-9]{64}$'),source_snapshot_digest text not null check(source_snapshot_digest~'^[a-f0-9]{64}$'),
    version integer not null check(version>0),state text not null check(state in (${securityActionStates.map(s=>`'${s}'`).join(',')})),
    title text not null,goal text not null,tool text not null,risk_tier text not null check(risk_tier in ('low','med','high')),reversible text not null check(reversible in ('readonly','reversible','irreversible')),
    playbook_version text not null,target_set jsonb not null check(jsonb_typeof(target_set)='array' and jsonb_array_length(target_set)>0),params jsonb not null check(jsonb_typeof(params)='object'),supersedes_action_id uuid,proposer_id text not null,
    frozen_task_definition_digest text check(frozen_task_definition_digest~'^sha256:[a-f0-9]{64}$'),frozen_source_snapshot_digest text check(frozen_source_snapshot_digest~'^[a-f0-9]{64}$'),frozen_object_snapshot_hash text check(frozen_object_snapshot_hash~'^[a-f0-9]{64}$'),frozen_playbook_version text,frozen_param_fingerprint text check(frozen_param_fingerprint~'^sha256:[a-f0-9]{64}$'),frozen_target_fingerprint text check(frozen_target_fingerprint~'^sha256:[a-f0-9]{64}$'),
    created_at timestamptz not null,updated_at timestamptz not null check(updated_at>=created_at),unique(id,owner_id),
    foreign key(task_id,owner_id) references teloa_tasks(id,owner_id),foreign key(task_id) references teloa_business_task_sources(task_id),
    foreign key(owner_id,scope_id,object_type,object_id,object_version) references teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version),
    foreign key(supersedes_action_id,owner_id) references teloa_security_actions(id,owner_id),
    check((state='proposed' and num_nonnulls(${securityFrozenColumns.join(',')})=0) or (state<>'proposed' and num_nonnulls(${securityFrozenColumns.join(',')})=6)),
    check(frozen_playbook_version is null or frozen_playbook_version=playbook_version)
   );
   create or replace function teloa_guard_security_action() returns trigger language plpgsql as $$ begin
    if new.state is distinct from old.state and not exists(select 1 from teloa_security_action_transitions where from_state=old.state and to_state=new.state) then raise exception '非法的安全动作状态转移'; end if;
    if old.frozen_task_definition_digest is not null and (to_jsonb(new)-array['state','version','updated_at']) is distinct from (to_jsonb(old)-array['state','version','updated_at']) then raise exception '安全动作定义与来源已经冻结'; end if;
    if old.frozen_task_definition_digest is null and row(${securityFrozenColumns.map(c=>'new.'+c).join(',')}) is distinct from row(${securityFrozenColumns.map(c=>'old.'+c).join(',')}) and not(old.state='proposed' and new.state='pending_approval' and num_nonnulls(${securityFrozenColumns.map(c=>'new.'+c).join(',')})=6) then raise exception '安全动作六值仅可在提交时冻结'; end if;
    return new;
   end $$;
   create or replace trigger teloa_guard_security_action before update on teloa_security_actions for each row execute function teloa_guard_security_action();
   create table if not exists teloa_security_action_requests(
    owner_id text not null,request_id uuid not null,result_action_id uuid not null,result_action_version integer not null check(result_action_version>0),result_snapshot jsonb not null check(jsonb_typeof(result_snapshot)='object'),primary key(owner_id,request_id),
    foreign key(owner_id,request_id) references teloa_security_requests(owner_id,request_id),foreign key(result_action_id,owner_id) references teloa_security_actions(id,owner_id)
   );
   create table if not exists teloa_security_action_audit(
    owner_id text not null,request_id uuid not null,action_id uuid not null,event text not null,created_at timestamptz not null,unique(owner_id,request_id,event),
    foreign key(owner_id,request_id) references teloa_security_requests(owner_id,request_id),foreign key(action_id,owner_id) references teloa_security_actions(id,owner_id)
   )`)
  for(const [from,targets] of Object.entries(securityActionTransitions))for(const target of targets)await db.query('insert into teloa_security_action_transitions(from_state,to_state) values($1,$2) on conflict do nothing',[from,target])
  const actual=(await db.query('select from_state,to_state from teloa_security_action_transitions')).rows.map(r=>`${r.from_state}->${r.to_state}`).sort()
  const expected=Object.entries(securityActionTransitions).flatMap(([from,targets])=>targets.map(target=>`${from}->${target}`)).sort()
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw securityStorageError()
  await db.query('commit')
 }catch(error){await db.query('rollback');throw error}finally{db.release()}
}

export function readStoredSecurityAction(row:Record<string,unknown>):SecurityAction{
 try{
  const values=securityFrozenColumns.map(column=>row[column]),frozen=values.every(v=>v===null)?null:Object.fromEntries(frozenKeys.map((key,i)=>[key,values[i]]))
  if(row.scope_id!=='SOC'||row.source_id!=='security-alert-http'||typeof row.object_type!=='string'||!row.object_type||typeof row.object_id!=='string'||!row.object_id||!Number.isSafeInteger(row.object_version)||Number(row.object_version)<1||typeof row.source_snapshot_digest!=='string'||!/^[a-f0-9]{64}$/.test(row.source_snapshot_digest)||typeof row.object_snapshot_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.object_snapshot_hash))throw Error()
  return readSecurityAction({id:row.id,ownerId:row.owner_id,taskId:row.task_id,version:row.version,state:row.state,title:row.title,goal:row.goal,tool:row.tool,riskTier:row.risk_tier,reversible:row.reversible,playbookVersion:row.playbook_version,targetSet:row.target_set,params:row.params,supersedesActionId:row.supersedes_action_id,frozen,proposerId:row.proposer_id,createdAt:(row.created_at as Date).toISOString(),updatedAt:(row.updated_at as Date).toISOString()})
 }catch{throw securityStorageError()}
}

/** 已有 Action 先锁 Action，再锁 task → source → object，所有写路径顺序相同。 */
export async function lockSecurityAction(db:PoolClient,principal:SecurityPrincipal,actionId:string):Promise<{action:SecurityAction;row:Record<string,unknown>}>{
 const row=(await db.query('select * from teloa_security_actions where id=$1 and owner_id=$2 for update',[actionId,principal.ownerId])).rows[0]
 if(!row)throw new WorkError('teloa/forbidden','安全动作不存在或不属于本人。')
 return {action:readStoredSecurityAction(row),row}
}
export function requireSecurityActionVersion(action:SecurityAction,version:number):void{if(action.version!==version)throw new WorkError('teloa/version-conflict','安全动作版本已变化，请重新核对。')}

export async function readSecurityBusinessChain(db:PoolClient,principal:SecurityPrincipal,taskId:string,lock=true){
 const suffix=lock?' for share':''
 const taskRow=(await db.query('select * from teloa_tasks where id=$1 and owner_id=$2'+suffix,[taskId,principal.ownerId])).rows[0]
 if(!taskRow)throw new WorkError('teloa/forbidden','任务不存在或不属于本人。')
 const task=readStoredTask(taskRow)
 if(task.scope!=='SOC')throw new WorkError('teloa/forbidden','安全动作仅支持 SOC 任务。')
 const sourceRow=(await db.query('select * from teloa_business_task_sources where task_id=$1 and owner_id=$2'+suffix,[taskId,principal.ownerId])).rows[0]
 if(!sourceRow)throw new WorkError('teloa/forbidden','任务没有固定业务来源。')
 const snapshotRow=(await db.query('select * from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 and object_version=$5'+suffix,[principal.ownerId,sourceRow.scope_id,sourceRow.object_type,sourceRow.object_id,sourceRow.object_version])).rows[0]
 if(!snapshotRow)throw securityStorageError()
 const source=readBusinessTaskSource({...sourceRow,task_request_id:taskRow.request_id,task_request_spec:taskRow.request_spec,business_snapshot:snapshotRow.snapshot,business_snapshot_hash:snapshotRow.snapshot_hash,business_source_id:snapshotRow.source_id})
 if(source.reference.scope!==task.scope||source.sourceId!=='security-alert-http')throw new WorkError('teloa/forbidden','安全动作必须来自固定的 HTTP 安全告警。')
 return {task,source,snapshot:{...readBusinessObjectSnapshot(snapshotRow.snapshot,'SOC'),snapshotHash:source.reference.snapshotHash}}
}

export async function recomputeSecurityActionFrozen(db:PoolClient,principal:SecurityPrincipal,row:Record<string,unknown>,catalog:SecurityActionDefinitionCatalog):Promise<SecurityActionFrozenValues>{
 const action=readStoredSecurityAction(row),{task,source,snapshot}=await readSecurityBusinessChain(db,principal,action.taskId)
 if(row.scope_id!==source.reference.scope||row.source_id!==source.sourceId||row.object_type!==source.reference.type||row.object_id!==source.reference.id||row.object_version!==source.reference.version||row.object_snapshot_hash!==source.reference.snapshotHash||row.source_snapshot_digest!==businessTaskSourceDigest(source))throw new WorkError('teloa/version-conflict','安全动作的固定来源已变化。')
 const authorized=catalog.require(action.tool).authorize(snapshot,action.targetSet,action.params)
 if(authorized.tool!==action.tool||authorized.riskTier!==action.riskTier||authorized.reversible!==action.reversible||authorized.playbookVersion!==action.playbookVersion||securityParamFingerprint(authorized.params)!==securityParamFingerprint(action.params)||securityTargetFingerprint(authorized.targetSet)!==securityTargetFingerprint(action.targetSet))throw new WorkError('teloa/version-conflict','安全动作服务端声明已变化，请重新提议。')
 return {taskDefinitionDigest:securityParamFingerprint({id:task.id,title:task.title,goal:task.goal,scope:task.scope}),sourceSnapshotDigest:businessTaskSourceDigest(source),objectSnapshotHash:source.reference.snapshotHash,playbookVersion:authorized.playbookVersion,paramFingerprint:securityParamFingerprint(authorized.params),targetFingerprint:securityTargetFingerprint(authorized.targetSet)}
}
export function requireSecurityFrozenBaseline(current:SecurityActionFrozenValues,baseline:SecurityActionFrozenValues|null):void{
 if(baseline===null||frozenKeys.some(key=>current[key]!==baseline[key]))throw new WorkError('teloa/version-conflict','安全动作冻结六值已变化，请撤回原批准并重新提议。')
}
export async function appendSecurityActionAudit(db:PoolClient,ownerId:string,requestId:string,actionId:string,event:SecurityRequestCommand,createdAt:string):Promise<void>{
 await db.query('insert into teloa_security_action_audit(owner_id,request_id,action_id,event,created_at) values($1,$2,$3,$4,$5)',[ownerId,requestId,actionId,event,createdAt])
}
export async function saveSecurityActionResult(db:PoolClient,requestId:string,action:SecurityAction):Promise<void>{
 await db.query('insert into teloa_security_action_requests(owner_id,request_id,result_action_id,result_action_version,result_snapshot) values($1,$2,$3,$4,$5)',[action.ownerId,requestId,action.id,action.version,JSON.stringify(action)])
}
type ActionReplay={command:'propose';request:SecurityActionProposalInput}|{command:'submit'|'withdraw-submission'|'withdraw-approval'|'acknowledge-failure';request:SecurityActionSubmitInput}
async function replayAction(db:PoolClient,principal:SecurityPrincipal,replay:ActionReplay):Promise<SecurityAction>{
 const {command,request}=replay,owner=principal.ownerId
 const row=(await db.query('select * from teloa_security_action_requests where owner_id=$1 and request_id=$2',[owner,request.requestId])).rows[0]
 try{
  if(!row)throw Error()
  const action=readSecurityAction(row.result_snapshot)
  if(action.ownerId!==owner||action.id!==row.result_action_id||action.version!==row.result_action_version)throw Error()
  if(replay.command==='propose'){
   const proposal=replay.request
   if(action.taskId!==proposal.taskId||action.title!==proposal.title||action.goal!==proposal.goal||action.tool!==proposal.tool||action.supersedesActionId!==(proposal.supersedesActionId??null)||action.proposerId!==principal.approverId||action.state!=='proposed'||action.version!==1)throw Error()
  }else{
   const expectedState=command==='submit'?'pending_approval':command==='acknowledge-failure'?'failed':'withdrawn'
   const expectedVersion=replay.request.expectedActionVersion+(command==='acknowledge-failure'?0:1)
   if(action.id!==replay.request.actionId||action.state!==expectedState||action.version!==expectedVersion)throw Error()
  }
  // 请求结果列本身不是生成身份的证据；原事件还须指向同一个服务端 Action。
  const audit=(await db.query('select action_id,created_at from teloa_security_action_audit where owner_id=$1 and request_id=$2 and event=$3',[owner,request.requestId,command])).rows[0]
  if(!audit||audit.action_id!==action.id||!(audit.created_at instanceof Date)||!Number.isFinite(audit.created_at.getTime())||command!=='acknowledge-failure'&&audit.created_at.toISOString()!==action.updatedAt)throw Error()
  const currentRow=(await db.query('select * from teloa_security_actions where owner_id=$1 and id=$2 for share',[owner,action.id])).rows[0]
  if(!currentRow)throw Error()
  const current=readStoredSecurityAction(currentRow)
  if(current.version<action.version||current.updatedAt<action.updatedAt)throw Error()
  // 状态、版本和更新时间会推进；定义永久固定，提交后的六值也永久固定。
  const historicalDefinition={...action,version:current.version,state:current.state,updatedAt:current.updatedAt,frozen:command==='propose'?current.frozen:action.frozen}
  if(securityParamFingerprint(historicalDefinition)!==securityParamFingerprint(current))throw Error()
  return action
 }catch{throw securityStorageError()}
}
async function replayAcknowledgement(db:PoolClient,principal:SecurityPrincipal,request:SecurityActionSubmitInput):Promise<SecurityAction>{
 const row=(await db.query('select * from teloa_security_action_attention_acknowledgements where owner_id=$1 and request_id=$2',[principal.ownerId,request.requestId])).rows[0]
 try{
  if(!row)throw Error()
  const action=readSecurityAction(row.result_snapshot)
  if(action.ownerId!==principal.ownerId||action.id!==row.action_id||action.id!==request.actionId||action.version!==row.action_version||action.version!==request.expectedActionVersion||action.state!=='failed'||row.approver_id!==principal.approverId||!(row.created_at instanceof Date)||!Number.isFinite(row.created_at.getTime()))throw Error()
  const bound=await replayAction(db,principal,{command:'acknowledge-failure',request})
  if(securityParamFingerprint(action)!==securityParamFingerprint(bound))throw Error()
  return action
 }catch{throw securityStorageError()}
}

export class SecurityActionService{
 private readonly pool:Pool
 private readonly identity:SecurityIdentity
 private readonly catalog:SecurityActionDefinitionCatalog
 private readonly journal:SecurityRequestJournal
 private readonly executions:SecurityExecutionExistsReader
 constructor(pool:Pool,identity:SecurityIdentity,catalog:SecurityActionDefinitionCatalog,journal:SecurityRequestJournal,executions:SecurityExecutionExistsReader){this.pool=pool;this.identity=identity;this.catalog=catalog;this.journal=journal;this.executions=executions}
 async propose(principal:SecurityPrincipal,input:unknown):Promise<SecurityAction>{
  securityPrincipal(principal);const request=securityActionProposalInput(input)
  return this.journal.transaction(async db=>{
   const now=this.identity.now()
   if(await this.journal.reserve(db,principal.ownerId,request.requestId,'propose',securityRequestSpec('propose',principal,request),now))return replayAction(db,principal,{command:'propose',request})
   if(request.supersedesActionId){const {action}=await lockSecurityAction(db,principal,request.supersedesActionId);if(action.taskId!==request.taskId||!['rejected','withdrawn','failed'].includes(action.state))throw new WorkError('teloa/conflict','仅能接续本人同任务的拒绝、撤回或失败动作。')}
   const {task,source,snapshot}=await readSecurityBusinessChain(db,principal,request.taskId)
   if(task.version!==request.expectedTaskVersion)throw new WorkError('teloa/version-conflict','任务版本已变化，请重新核对。')
   const authorized=this.catalog.require(request.tool).authorize(snapshot,request.targetSet,request.params)
   const action=readSecurityAction({id:this.identity.id(),ownerId:principal.ownerId,taskId:task.id,version:1,state:'proposed',title:request.title,goal:request.goal,...authorized,supersedesActionId:request.supersedesActionId??null,frozen:null,proposerId:principal.approverId,createdAt:now,updatedAt:now})
   const saved=(await db.query(`insert into teloa_security_actions(id,owner_id,task_id,scope_id,source_id,object_type,object_id,object_version,object_snapshot_hash,source_snapshot_digest,version,state,title,goal,tool,risk_tier,reversible,playbook_version,target_set,params,supersedes_action_id,proposer_id,created_at,updated_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'proposed',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21) returning *`,[action.id,action.ownerId,action.taskId,source.reference.scope,source.sourceId,source.reference.type,source.reference.id,source.reference.version,source.reference.snapshotHash,businessTaskSourceDigest(source),action.title,action.goal,action.tool,action.riskTier,action.reversible,action.playbookVersion,JSON.stringify(action.targetSet),JSON.stringify(action.params),action.supersedesActionId,action.proposerId,now])).rows[0]
   const result=readStoredSecurityAction(saved);await saveSecurityActionResult(db,request.requestId,result);await appendSecurityActionAudit(db,principal.ownerId,request.requestId,result.id,'propose',now);return result
  })
 }
 async get(principal:SecurityPrincipal,input:unknown):Promise<SecurityAction>{
  securityPrincipal(principal);const request=taskInput(input,['actionId']);if(!uuid(request.actionId))throw new WorkError('teloa/invalid-input','动作身份不正确。')
  const row=(await this.pool.query('select * from teloa_security_actions where id=$1 and owner_id=$2',[request.actionId,principal.ownerId])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','安全动作不存在或不属于本人。');return readStoredSecurityAction(row)
 }
 async list(principal:SecurityPrincipal,input:unknown):Promise<SecurityAction[]>{
  securityPrincipal(principal);const request=taskInput(input,['taskId']);if(!uuid(request.taskId))throw new WorkError('teloa/invalid-input','任务身份不正确。')
  const task=(await this.pool.query('select * from teloa_tasks where id=$1 and owner_id=$2',[request.taskId,principal.ownerId])).rows[0]
  if(!task||readStoredTask(task).scope!=='SOC')throw new WorkError('teloa/forbidden','任务不存在或不属于 SOC 本人范围。')
  return (await this.pool.query('select * from teloa_security_actions where task_id=$1 and owner_id=$2 order by created_at,id',[request.taskId,principal.ownerId])).rows.map(readStoredSecurityAction)
 }
 async submit(principal:SecurityPrincipal,input:unknown):Promise<SecurityAction>{return this.mutate(principal,securityActionSubmitInput(input),'submit')}
 async withdrawSubmission(principal:SecurityPrincipal,input:unknown):Promise<SecurityAction>{return this.mutate(principal,securityActionWithdrawInput(input),'withdraw-submission')}
 async withdrawApproval(principal:SecurityPrincipal,input:unknown):Promise<SecurityAction>{return this.mutate(principal,securityActionWithdrawInput(input),'withdraw-approval')}
 async acknowledgeFailure(principal:SecurityPrincipal,input:unknown):Promise<SecurityAction>{return this.mutate(principal,securityFailureAcknowledgementInput(input),'acknowledge-failure')}
 private async mutate(principal:SecurityPrincipal,request:SecurityActionSubmitInput,command:'submit'|'withdraw-submission'|'withdraw-approval'|'acknowledge-failure'):Promise<SecurityAction>{
  securityPrincipal(principal)
  return this.journal.transaction(async db=>{
   const now=this.identity.now()
   if(await this.journal.reserve(db,principal.ownerId,request.requestId,command,securityRequestSpec(command,principal,request),now))return command==='acknowledge-failure'?replayAcknowledgement(db,principal,request):replayAction(db,principal,{command,request})
   const {action,row}=await lockSecurityAction(db,principal,request.actionId);requireSecurityActionVersion(action,request.expectedActionVersion)
   const expected={'submit':'proposed','withdraw-submission':'pending_approval','withdraw-approval':'approved','acknowledge-failure':'failed'}[command]
   if(action.state!==expected)throw new WorkError('teloa/conflict','当前安全动作状态不允许此操作。')
   if(command==='withdraw-approval'&&await this.executions.existsForAction(db,principal.ownerId,action.id))throw new WorkError('teloa/conflict','已有执行意图，不能撤回批准。')
   let result:SecurityAction
   if(command==='submit'){
    const frozen=await recomputeSecurityActionFrozen(db,principal,row,this.catalog)
    result=readStoredSecurityAction((await db.query(`update teloa_security_actions set state='pending_approval',version=version+1,updated_at=$2,${securityFrozenColumns.map((c,i)=>`${c}=$${i+3}`).join(',')} where id=$1 returning *`,[action.id,now,...frozenKeys.map(k=>frozen[k])])).rows[0])
   }else if(command==='acknowledge-failure'){
    if((await db.query('select 1 from teloa_security_action_attention_acknowledgements where owner_id=$1 and action_id=$2 and action_version=$3',[principal.ownerId,action.id,action.version])).rows[0])throw new WorkError('teloa/conflict','该失败动作已经确认，请核对原记录。')
    await db.query('insert into teloa_security_action_attention_acknowledgements(owner_id,request_id,action_id,action_version,approver_id,result_snapshot,created_at) values($1,$2,$3,$4,$5,$6,$7)',[principal.ownerId,request.requestId,action.id,action.version,principal.approverId,JSON.stringify(action),now]);result=action
   }else result=readStoredSecurityAction((await db.query("update teloa_security_actions set state='withdrawn',version=version+1,updated_at=$2 where id=$1 returning *",[action.id,now])).rows[0])
   await saveSecurityActionResult(db,request.requestId,result);await appendSecurityActionAudit(db,principal.ownerId,request.requestId,action.id,command,now);return result
  })
 }
}
