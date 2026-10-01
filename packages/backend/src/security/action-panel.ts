import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord,taskInput,readSecurityAction,readSecurityActionPanel,type SecurityAction,type SecurityPrincipal,type SecurityActionDefinitionCatalog,type SecurityActionPanel} from '@teloa/contract'
import {readStoredSecurityAction,readSecurityBusinessChain,securityPrincipal,securityStorageError} from './actions.ts'
import {readStoredSecurityApproval} from './approvals.ts'
import {readStoredSecurityExecution} from './action-executions.ts'
import {securityEndpointAllowedTargets,securityParamFingerprint,securityTargetFingerprint} from './action-authorization.ts'
import {businessTaskSourceDigest} from '../work/business-task-source-digest.ts'

export interface SecurityActionReadinessPort{ready(tool:string,signal:AbortSignal):Promise<{ready:true}|{ready:false;reason:string}>}
const same=(a:Record<string,unknown>,b:Record<string,unknown>)=>securityParamFingerprint(a)===securityParamFingerprint(b)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
export function securityActionReadId(input:unknown,key:'taskId'|'actionId'):string{
 const row=taskInput(input,[key]);if(!uuid(row[key]))throw new WorkError('teloa/invalid-input','安全动作读取身份不正确。');return row[key].toLowerCase()
}

/** 单个一致快照；损坏关联仍参与读取，不能被 owner JOIN 条件静默过滤。 */
export async function readSecurityActionGraph(db:PoolClient,principal:SecurityPrincipal,catalog:SecurityActionDefinitionCatalog){
 const rows=(await db.query(`select a.* from teloa_security_actions a
  where a.owner_id=$1
   or exists(select 1 from teloa_tasks t where t.id=a.task_id and t.owner_id=$1)
   or exists(select 1 from teloa_business_task_sources s where s.task_id=a.task_id and s.owner_id=$1)
  order by a.updated_at desc,a.id asc`,[principal.ownerId])).rows
 const actions=rows.map(readStoredSecurityAction),byId=new Map(actions.map(action=>[action.id,action])),ids=actions.map(action=>action.id)
 if(byId.size!==actions.length||actions.some(action=>action.ownerId!==principal.ownerId))throw securityStorageError()
 const chains=new Map<string,Awaited<ReturnType<typeof readSecurityBusinessChain>>>()
 for(const taskId of new Set(actions.map(action=>action.taskId))){
  try{chains.set(taskId,await readSecurityBusinessChain(db,principal,taskId,false))}catch{throw securityStorageError()}
 }
 const related=[principal.ownerId,ids]
 const approvalRows=(await db.query('select * from teloa_security_approvals where owner_id=$1 or action_id=any($2::uuid[]) order by created_at,id',related)).rows
 const approvals=approvalRows.map(readStoredSecurityApproval)
 // 到期时刻只从已经查出来的 approvalRows 里取，不多查一次库；它不进 SecurityApproval 契约类型，
 // 所以只能走这条旁路（规格 §3.2 a：加进契约会打断 record_digest 与 result_snapshot 两处不可变事实）。
 const approvalExpiry=new Map<string,string>()
 for(const row of approvalRows){
  if(!(row.expires_at instanceof Date))throw securityStorageError()
  approvalExpiry.set(String(row.action_id),row.expires_at.toISOString())
 }
 const executionRows=(await db.query('select * from teloa_security_action_executions where owner_id=$1 or action_id=any($2::uuid[]) order by created_at,operation_id',related)).rows
 const receipts=(await db.query('select * from teloa_security_action_execution_receipts where operation_id=any($1::uuid[])',[executionRows.map(row=>row.operation_id)])).rows
 const usedReceipts=new Set<string>()
 const executions=executionRows.map(row=>{
  const own=receipts.filter(receipt=>receipt.operation_id===row.operation_id),kinds=new Set<string>()
  for(const receipt of own){if(!['acceptance','effect'].includes(receipt.kind)||kinds.has(receipt.kind))throw securityStorageError();kinds.add(receipt.kind);usedReceipts.add(receipt.operation_id+':'+receipt.kind)}
  return readStoredSecurityExecution({...row,acceptance_receipt:own.find(receipt=>receipt.kind==='acceptance')?.receipt??null,effect_receipt:own.find(receipt=>receipt.kind==='effect')?.receipt??null})
 })
 if(usedReceipts.size!==receipts.length||new Set(executions.map(e=>e.actionId)).size!==executions.length)throw securityStorageError()
 for(const action of actions){
  if(action.ownerId!==principal.ownerId||action.proposerId!==principal.approverId)throw securityStorageError()
  const row=rows.find(row=>row.id===action.id)!
  const {source,snapshot}=chains.get(action.taskId)!
  if(row.scope_id!==source.reference.scope||row.source_id!==source.sourceId||row.object_type!==source.reference.type||row.object_id!==source.reference.id||row.object_version!==source.reference.version||row.object_snapshot_hash!==source.reference.snapshotHash||row.source_snapshot_digest!==businessTaskSourceDigest(source))throw securityStorageError()
  try{
   const authorized=catalog.require(action.tool).authorize(snapshot,action.targetSet,action.params)
   if(authorized.tool!==action.tool||authorized.riskTier!==action.riskTier||authorized.reversible!==action.reversible||authorized.playbookVersion!==action.playbookVersion||!same(authorized.params,action.params)||securityTargetFingerprint(authorized.targetSet)!==securityTargetFingerprint(action.targetSet))throw securityStorageError()
  }catch{throw securityStorageError()}
  if(action.frozen&&(action.frozen.paramFingerprint!==securityParamFingerprint(action.params)||action.frozen.targetFingerprint!==securityTargetFingerprint(action.targetSet)||action.frozen.objectSnapshotHash!==row.object_snapshot_hash||action.frozen.sourceSnapshotDigest!==row.source_snapshot_digest))throw securityStorageError()
  const ownApprovals=approvals.filter(a=>a.actionId===action.id),ownExecutions=executions.filter(e=>e.actionId===action.id)
  if(ownApprovals.length>1||(['approved','rejected','executing','effect_unknown','succeeded','failed'].includes(action.state)&&ownApprovals.length!==1)||(['proposed','pending_approval'].includes(action.state)&&ownApprovals.length!==0)||(['executing','effect_unknown','succeeded','failed'].includes(action.state)?ownExecutions.length!==1:ownExecutions.length!==0))throw securityStorageError()
  const approval=ownApprovals[0]
  if(approval&&(approval.actionVersion>=action.version||(action.state==='rejected'?approval.decision!=='rejected':approval.decision!=='approved')||action.state==='approved'&&approval.actionVersion!==action.version-1))throw securityStorageError()
  if(action.supersedesActionId){
   const old=byId.get(action.supersedesActionId);if(!old||old.id===action.id||old.taskId!==action.taskId||!['rejected','withdrawn','failed'].includes(old.state)||old.createdAt>action.createdAt)throw securityStorageError()
   const ancestry=new Set([action.id]);let cursor:SecurityAction|undefined=old
   while(cursor){if(ancestry.has(cursor.id))throw securityStorageError();ancestry.add(cursor.id);cursor=cursor.supersedesActionId?byId.get(cursor.supersedesActionId):undefined}
  }
 }
 for(const approval of approvals)if(approval.ownerId!==principal.ownerId||approval.approverId!==principal.approverId||!byId.has(approval.actionId))throw securityStorageError()
 for(let i=0;i<executions.length;i++){
  const execution=executions[i]!,row=executionRows[i]!
  if(execution.ownerId!==principal.ownerId||!byId.has(execution.actionId))throw securityStorageError()
  const request=(await db.query('select * from teloa_security_requests where owner_id=$1 and request_id=$2',[principal.ownerId,row.request_id])).rows[0]
  const audit=(await db.query('select * from teloa_security_action_execution_audit where operation_id=$1 and revision=$2',[execution.operationId,execution.revision])).rows
  if(!request||!isRecord(request.request_spec)||request.command!=='execute'||request.request_spec.command!=='execute'||request.request_spec.actionId!==execution.actionId||request.request_spec.approverId!==principal.approverId||request.request_spec.expectedActionVersion!==execution.approvalVersion+1||securityParamFingerprint(request.request_spec)!==row.request_spec_digest||audit.length!==1||audit[0].owner_id!==principal.ownerId||audit[0].result_digest!==securityParamFingerprint(execution)||audit[0].result_digest!==securityParamFingerprint(audit[0].result_snapshot))throw securityStorageError()
 }
 const ackRows=(await db.query('select * from teloa_security_action_attention_acknowledgements where owner_id=$1 or action_id=any($2::uuid[])',related)).rows,acknowledged=new Set<string>()
 for(const row of ackRows){
  const action=byId.get(row.action_id)
  if(!action||acknowledged.has(action.id)||action.state!=='failed'||row.owner_id!==principal.ownerId||row.approver_id!==principal.approverId||row.action_version!==action.version)throw securityStorageError()
  try{if(!same(readSecurityAction(row.result_snapshot),action))throw securityStorageError()}catch{throw securityStorageError()}
  const request=(await db.query('select * from teloa_security_requests where owner_id=$1 and request_id=$2',[principal.ownerId,row.request_id])).rows[0]
  if(!request||request.command!=='acknowledge-failure'||!same(request.request_spec,{command:'acknowledge-failure',approverId:principal.approverId,actionId:action.id,expectedActionVersion:action.version}))throw securityStorageError()
  acknowledged.add(action.id)
 }
 // 共用合同复核 owner、六值、批准、dispatch 和两侧状态关联。
 try{for(const taskId of new Set(actions.map(a=>a.taskId)))readSecurityActionPanel({taskId,actions:actions.filter(a=>a.taskId===taskId),approvals:approvals.filter(a=>byId.get(a.actionId)?.taskId===taskId),executions:executions.filter(e=>byId.get(e.actionId)?.taskId===taskId),proposal:{tools:[]}})}catch{throw securityStorageError()}
 return {actions,approvals,executions,acknowledged,approvalExpiry}
}

export async function securityReadSnapshot<T>(pool:Pool,signal:AbortSignal,read:(db:PoolClient)=>Promise<T>):Promise<T>{
 signal.throwIfAborted();const db=await pool.connect()
 try{await db.query('begin isolation level repeatable read read only');const result=await read(db);signal.throwIfAborted();await db.query('commit');return result}
 catch(error){await db.query('rollback');throw error}finally{db.release()}
}

export class SecurityActionPanelService{
 private readonly pool:Pool
 private readonly catalog:SecurityActionDefinitionCatalog
 private readonly readiness:SecurityActionReadinessPort
 constructor(pool:Pool,catalog:SecurityActionDefinitionCatalog,readiness:SecurityActionReadinessPort){this.pool=pool;this.catalog=catalog;this.readiness=readiness}
 async list(principal:SecurityPrincipal,input:unknown,signal:AbortSignal):Promise<SecurityActionPanel>{
  securityPrincipal(principal);const taskId=securityActionReadId(input,'taskId')
  const panel=await securityReadSnapshot(this.pool,signal,async db=>{
   const {snapshot}=await readSecurityBusinessChain(db,principal,taskId,false),definition=this.catalog.require('security.endpoint.isolate'),graph=await readSecurityActionGraph(db,principal,this.catalog)
   const actions=graph.actions.filter(action=>action.taskId===taskId),ids=new Set(actions.map(action=>action.id))
   // 来源与既有动作图已完整核验；仅固定对象缺少可授权终端属于能力不适用。
   let allowedTargets:string[]=[]
   try{allowedTargets=securityEndpointAllowedTargets(snapshot)}catch(error){if(!(error instanceof WorkError)||error.code!=='teloa/forbidden')throw error}
   return readSecurityActionPanel({taskId,actions,approvals:graph.approvals.filter(a=>ids.has(a.actionId)),executions:graph.executions.filter(e=>ids.has(e.actionId)),proposal:{tools:allowedTargets.length?[{tool:definition.tool,allowedTargets}]:[]}})
  })
  // 当前合同不携带 readiness；独立 Attention 表达 adapter-unavailable。
  await this.readiness.ready('security.endpoint.isolate',signal);signal.throwIfAborted();return panel
 }
}
