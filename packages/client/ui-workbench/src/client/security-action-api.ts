import {WorkError,isRecord,businessObjectReference,type BusinessObjectReference,readSecurityAction,readSecurityApproval,readSecurityActionExecution,readSecurityActionPanel,securityActionProposalInput,securityActionSubmitInput,securityApprovalDecisionInput,securityObservationInput,type SecurityAction,type SecurityApproval,type SecurityActionExecution,type SecurityActionPanel,type SecurityActionProposalInput,type SecurityActionSubmitInput,type SecurityApprovalDecisionInput,type SecurityObservationInput} from '@teloa/contract'
import type {TaskRequestJournal} from './task-api.js'
import {securitySupersedableStates} from './security-action-presentation.ts'

export const securityActionCommands=['propose','submit','decide','withdraw-submission','withdraw-approval','execute','observe','acknowledge-failure'] as const
export type SecurityActionCommand=typeof securityActionCommands[number]
export const securityAttentionReasons=['approval-required','execution-required','execution-dispatching','external-accepted','effect-unknown','execution-failed','adapter-unavailable','approval-expired'] as const
export type SecurityActionAttention={taskId:string;actionId:string;kind:'security-action';reason:typeof securityAttentionReasons[number]}
export type SecurityActionContext={panel:SecurityActionPanel;taskVersion:number;source:{taskId:string;ownerId:string;sourceId:string;reference:BusinessObjectReference}}
type Inputs={propose:SecurityActionProposalInput;submit:SecurityActionSubmitInput;decide:SecurityApprovalDecisionInput;'withdraw-submission':SecurityActionSubmitInput;'withdraw-approval':SecurityActionSubmitInput;execute:SecurityActionSubmitInput;observe:SecurityObservationInput;'acknowledge-failure':SecurityActionSubmitInput}
type Outputs={propose:SecurityAction;submit:SecurityAction;decide:SecurityApproval;'withdraw-submission':SecurityAction;'withdraw-approval':SecurityAction;execute:SecurityActionExecution;observe:SecurityActionExecution;'acknowledge-failure':SecurityAction}
type Pending={request:Inputs[SecurityActionCommand];context:SecurityActionContext}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const fail=(code:'invalid-host-response'|'invalid-input'|'storage-corrupt'|'conflict'='invalid-host-response'):never=>{throw new WorkError(`teloa/${code}`,'安全动作请求或响应无法核实。')}
const same=(a:unknown,b:unknown):boolean=>{
 if(a===b)return true
 if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>same(v,b[i]))
 if(isRecord(a)&&isRecord(b))return Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&same(a[k],b[k]))
 return false
}
// 版本与观察进度可以前进；已知定义、审批和回执都是不可变事实。
function actionProgress(previous:SecurityAction,next:SecurityAction):void{
 const fixed=({version,state,updatedAt,frozen,...definition}:SecurityAction)=>definition
 if(next.version<previous.version||next.updatedAt<previous.updatedAt||!same(fixed(previous),fixed(next))||previous.frozen!==null&&!same(previous.frozen,next.frozen)||next.version===previous.version&&!same(previous,next))fail()
}
function executionProgress(previous:SecurityActionExecution,next:SecurityActionExecution):void{
 const fixed=({revision,state,updatedAt,acceptanceReceipt,effectReceipt,...definition}:SecurityActionExecution)=>definition
 if(next.revision<previous.revision||next.updatedAt<previous.updatedAt||!same(fixed(previous),fixed(next))||previous.acceptanceReceipt!==null&&!same(previous.acceptanceReceipt,next.acceptanceReceipt)||previous.effectReceipt!==null&&!same(previous.effectReceipt,next.effectReceipt)||next.revision===previous.revision&&!same(previous,next))fail()
}
function executionHistory(known:SecurityActionExecution,response:SecurityActionExecution):void{
 // 幂等观察可返回早于最新 panel 的原回执，比较时间方向但不回写缓存。
 if(response.revision<known.revision)executionProgress(response,known)
 else executionProgress(known,response)
}
const sameTargets=(a:readonly string[],b:readonly string[])=>a.length===b.length&&a.every(v=>b.includes(v))
export function readSecurityActionAttention(value:unknown):SecurityActionAttention[]{
 if(!Array.isArray(value))return fail()
 const rows=value.map((row):SecurityActionAttention=>{
  if(!isRecord(row)||Object.keys(row).length!==4||Object.keys(row).some(k=>!['taskId','actionId','kind','reason'].includes(k))||!uuid(row.taskId)||!uuid(row.actionId)||row.kind!=='security-action'||!securityAttentionReasons.includes(row.reason as SecurityActionAttention['reason']))return fail()
  return {taskId:row.taskId.toLowerCase(),actionId:row.actionId.toLowerCase(),kind:'security-action',reason:row.reason as SecurityActionAttention['reason']}
 })
 if(new Set(rows.map(r=>r.actionId)).size!==rows.length)return fail()
 return rows
}
export type SecurityActionApi=ReturnType<typeof createSecurityActionApi>
export function createSecurityActionApi(call:(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>,journals:Partial<Record<SecurityActionCommand,TaskRequestJournal>>={},owner='local:teloa-owner'){
 const pending=new Map<SecurityActionCommand,Pending>(),broken=new Set<SecurityActionCommand>(),busy=new Set<SecurityActionCommand>(),panels=new Map<string,SecurityActionPanel>()
 const ownAction=(value:unknown,taskId:string,id?:string)=>{
  const row=readSecurityAction(value)
  if(row.ownerId!==owner||row.proposerId!==owner||row.taskId!==taskId||id!==undefined&&row.id!==id)return fail()
  return row
 }
 const ownPanel=(value:unknown)=>{
  const panel=readSecurityActionPanel(value)
  if(panel.actions.some(a=>a.ownerId!==owner||a.proposerId!==owner)||panel.approvals.some(a=>a.ownerId!==owner||a.approverId!==owner)||panel.executions.some(e=>e.ownerId!==owner))return fail()
  if(panel.approvals.some(a=>a.actionVersion>=panel.actions.find(row=>row.id===a.actionId)!.version)||new Set(panel.executions.map(e=>e.actionId)).size!==panel.executions.length)return fail()
  return panel
 }
 const parse=(kind:SecurityActionCommand,value:unknown):Inputs[SecurityActionCommand]=>kind==='propose'?securityActionProposalInput(value):kind==='decide'?securityApprovalDecisionInput(value):kind==='observe'?securityObservationInput(value):securityActionSubmitInput(value)
 const checkedContext=(value:unknown):SecurityActionContext=>{
  if(!isRecord(value)||Object.keys(value).length!==3||!Object.hasOwn(value,'panel')||!isRecord(value.source)||!Number.isSafeInteger(value.taskVersion)||Number(value.taskVersion)<1)return fail('invalid-input')
  const panel=ownPanel(value.panel),source=value.source,reference=businessObjectReference(source.reference)
  if(Object.keys(source).length!==4||source.ownerId!==owner||source.taskId!==panel.taskId||source.sourceId!=='security-alert-http'||reference.scope!=='SOC'||panel.actions.some(a=>a.frozen!==null&&a.frozen.objectSnapshotHash!==reference.snapshotHash))return fail('invalid-input')
  return {panel,taskVersion:Number(value.taskVersion),source:{taskId:panel.taskId,ownerId:owner,sourceId:'security-alert-http',reference}}
 }
 const validate=(kind:SecurityActionCommand,request:Inputs[SecurityActionCommand],context:SecurityActionContext)=>{
  const p=context.panel
  if(kind==='propose'){
   const r=request as SecurityActionProposalInput,allowed=p.proposal.tools.find(tool=>tool.tool==='security.endpoint.isolate'),reason=r.params.reason
   if(r.taskId!==p.taskId||r.expectedTaskVersion!==context.taskVersion||r.tool!=='security.endpoint.isolate'||!allowed||r.targetSet.some(v=>!allowed.allowedTargets.includes(v))||Object.keys(r.params).length!==1||typeof reason!=='string'||!reason.trim()||reason!==reason.trim()||reason.length>1000||/[\x00-\x1f\x7f]/.test(reason)||r.supersedesActionId!==undefined&&!p.actions.some(a=>a.id===r.supersedesActionId&&securitySupersedableStates.includes(a.state as typeof securitySupersedableStates[number])))return fail('invalid-input')
   return
  }
  if(kind==='observe'){
   const r=request as SecurityObservationInput,e=p.executions.find(e=>e.operationId===r.operationId)
   if(!e||e.revision!==r.expectedRevision||!['dispatching','accepted','effect_unknown'].includes(e.state))return fail('invalid-input')
   return
  }
  const r=request as SecurityActionSubmitInput,a=p.actions.find(a=>a.id===r.actionId)
  const state={submit:'proposed',decide:'pending_approval','withdraw-submission':'pending_approval','withdraw-approval':'approved',execute:'approved','acknowledge-failure':'failed'}[kind]
  if(!a||a.version!==r.expectedActionVersion||a.state!==state)return fail('invalid-input')
  if(kind==='decide'&&(request as SecurityApprovalDecisionInput).decision==='approved'&&!(request as SecurityApprovalDecisionInput).impactConfirmed)return fail('invalid-input')
  if(kind==='execute'&&(p.executions.some(e=>e.actionId===a.id)||!p.approvals.some(v=>v.actionId===a.id&&v.decision==='approved'&&v.actionVersion===a.version-1)))return fail('invalid-input')
 }
 /**
  * 未决请求日志现在是同源共享的（`journal-storage.ts`），所以不能只在构造期快照一次：
  * 另一个标签页刚写下 / 刚核对干净的那条记录，本标签页必须当场读到同一个 requestId，
  * 否则两个标签页会各自认定自己持有这条命令（规格 §八 G4）。
  * 只在原文变化时才重解析：`seen` 记住上次读到的原文，自己刚写下的那次不会被重复解析。
  */
 const seen=new Map<SecurityActionCommand,string|null>()
 const reload=(kind:SecurityActionCommand)=>{
  // 没有日志端口就没有共享存储可重读，本进程的内存状态就是全部事实（宿主之外的调用方
  // 与大量用例都这样用）；在途请求用的是本次自己的 entry，此刻重读会把它掀翻，同样不重读。
  const journal=journals[kind]
  if(!journal||busy.has(kind))return
  let raw:string|null
  try{raw=journal.read()??null}catch{broken.add(kind);return}
  if(seen.has(kind)&&seen.get(kind)===raw)return
  seen.set(kind,raw)
  broken.delete(kind);pending.delete(kind)
  if(raw===null)return
  try{
   if(raw.length>1000000)throw Error()
   const row:unknown=JSON.parse(raw)
   if(!isRecord(row)||Object.keys(row).length!==4||row.schema!=='teloa.security-action/v1'||row.command!==kind)throw Error()
   const entry={request:parse(kind,row.request),context:checkedContext(row.context)}
   validate(kind,entry.request,entry.context);pending.set(kind,entry)
  }catch{broken.add(kind)}
 }
 for(const kind of securityActionCommands)reload(kind)
 const validateOutput=(kind:SecurityActionCommand,value:unknown,entry:Pending):Outputs[SecurityActionCommand]=>{
  const {request:r,context:{panel:p}}=entry
  if(kind==='propose'){
   const input=r as SecurityActionProposalInput,a=ownAction(value,p.taskId)
   if(p.actions.some(existing=>existing.id===a.id)||a.state!=='proposed'||a.version!==1||a.title!==input.title||a.goal!==input.goal||a.tool!==input.tool||!sameTargets(a.targetSet,input.targetSet)||!same(a.params,input.params)||a.supersedesActionId!==(input.supersedesActionId??null))return fail()
   return a
  }
  const oldExecution=kind==='observe'?p.executions.find(e=>e.operationId===(r as SecurityObservationInput).operationId):undefined
  const a=p.actions.find(a=>a.id===(oldExecution?.actionId??(r as SecurityActionSubmitInput).actionId))!
  if(kind==='decide'){
   const input=r as SecurityApprovalDecisionInput,approval=readSecurityApproval(value)
   if(approval.ownerId!==owner||approval.approverId!==owner||approval.actionId!==a.id||approval.actionVersion!==input.expectedActionVersion||approval.decision!==input.decision||approval.reason!==input.reason||approval.impactConfirmed!==input.impactConfirmed||!same(approval.frozen,a.frozen))return fail()
   const known=panels.get(p.taskId)?.approvals.find(value=>value.id===approval.id)
   if(known&&!same(known,approval))return fail()
   return approval
  }
  if(kind==='execute'||kind==='observe'){
   const e=readSecurityActionExecution(value),approval=p.approvals.find(v=>v.id===e.approvalId),known=panels.get(p.taskId)?.executions.find(v=>v.actionId===a.id)
   if(known)executionHistory(known,e)
   if(e.ownerId!==owner||e.actionId!==a.id||!approval||approval.actionId!==a.id||approval.decision!=='approved'||!approval.impactConfirmed||e.approvalVersion!==approval.actionVersion||!same(e.frozen,a.frozen)||!same(e.frozen,approval.frozen)||e.dispatch.tool!==a.tool||e.dispatch.playbookVersion!==a.playbookVersion||!sameTargets(e.dispatch.targets,a.targetSet)||!same(e.dispatch.params,a.params))return fail()
   if(oldExecution)executionProgress(oldExecution,e)
   return e
  }
  const output=ownAction(value,p.taskId,a.id),expectedState=kind==='submit'?'pending_approval':kind==='acknowledge-failure'?'failed':'withdrawn',expectedVersion=a.version+(kind==='acknowledge-failure'?0:1)
  actionProgress(a,output)
  const known=panels.get(p.taskId)?.actions.find(value=>value.id===output.id)
  if(known){if(output.version<known.version)actionProgress(output,known);else actionProgress(known,output)}
  if(output.frozen?.objectSnapshotHash!==entry.context.source.reference.snapshotHash||output.state!==expectedState||output.version!==expectedVersion)return fail()
  return output
 }
 const clear=(kind:SecurityActionCommand)=>{try{journals[kind]?.clear();pending.delete(kind);seen.set(kind,null)}catch{return fail('storage-corrupt')}}
 const send=async<K extends SecurityActionCommand>(kind:K,signal?:AbortSignal):Promise<Outputs[K]>=>{
  reload(kind)
  if(broken.has(kind))return fail('storage-corrupt')
  if(busy.has(kind)||!pending.has(kind))return fail('conflict')
  const entry=pending.get(kind)!;busy.add(kind)
  try{
   const record=JSON.stringify({schema:'teloa.security-action/v1',command:kind,...entry})
   try{journals[kind]?.write(record);seen.set(kind,record)}catch{return fail('storage-corrupt')}
   let raw:unknown
   // 只有 RPC 抛出的明确无副作用拒绝可清理；输出解析与存储异常不进入此分支。
   try{raw=await call('security-actions/'+kind,structuredClone(entry.request),signal)}catch(error){
    if(isRecord(error)&&error.rejected===true&&['teloa/invalid-input','teloa/forbidden','teloa/version-conflict','teloa/conflict'].includes(String(error.code)))clear(kind)
    throw error
   }
   const output=validateOutput(kind,raw,entry)
   clear(kind)
   return output as Outputs[K]
  }finally{busy.delete(kind)}
 }
 const write=async<K extends SecurityActionCommand>(kind:K,value:Inputs[K],context:SecurityActionContext,signal?:AbortSignal):Promise<Outputs[K]>=>{
  reload(kind)
  if(broken.has(kind))return fail('storage-corrupt')
  const entry={request:parse(kind,value),context:checkedContext(context)};validate(kind,entry.request,entry.context)
  if(busy.has(kind))return fail('conflict')
  const old=pending.get(kind)
  if(old&&!same(old,entry))return fail('conflict')
  pending.set(kind,old??structuredClone(entry))
  return send(kind,signal)
 }
 return {
  pending:(kind:SecurityActionCommand)=>{reload(kind);const row=pending.get(kind);return row?structuredClone(row):undefined},
  recoveryError:(kind:SecurityActionCommand)=>{reload(kind);return broken.has(kind)?new WorkError('teloa/storage-corrupt','恢复记录损坏。'):undefined},
  discardRecovery(kind:SecurityActionCommand){
   reload(kind)
   // broken 是按命令分本的，丢弃面也必须按命令分本：别的命令的坏记录不该被顺手清掉。
   const had=broken.has(kind)||pending.has(kind)
   try{journals[kind]?.clear()}catch{/* 清不掉不该变成第二道墙 */}
   broken.delete(kind);pending.delete(kind);seen.set(kind,null)
   return had
  },
  recover:send,
  async list(taskId:string,signal?:AbortSignal){
   if(!uuid(taskId))return fail('invalid-input')
   const id=taskId.toLowerCase(),p=ownPanel(await call('security-actions/list',{taskId:id},signal)),old=panels.get(id)
   if(p.taskId!==id)return fail()
   if(old){
    for(const previous of old.actions){const next=p.actions.find(value=>value.id===previous.id);if(!next)return fail();actionProgress(previous,next)}
    for(const previous of old.approvals){const next=p.approvals.find(value=>value.id===previous.id);if(!next||!same(previous,next))return fail()}
    for(const previous of old.executions){const next=p.executions.find(value=>value.operationId===previous.operationId);if(!next)return fail();executionProgress(previous,next)}
   }
   panels.set(id,structuredClone(p));return p
  },
  async get(taskId:string,actionId:string,signal?:AbortSignal){if(!uuid(taskId)||!uuid(actionId))return fail('invalid-input');return ownAction(await call('security-actions/get',{actionId:actionId.toLowerCase()},signal),taskId.toLowerCase(),actionId.toLowerCase())},
  async attention(signal?:AbortSignal){return readSecurityActionAttention(await call('security-actions/attention',{},signal))},
  propose:(r:SecurityActionProposalInput,c:SecurityActionContext,s?:AbortSignal)=>write('propose',r,c,s),
  submit:(r:SecurityActionSubmitInput,c:SecurityActionContext,s?:AbortSignal)=>write('submit',r,c,s),
  decide:(r:SecurityApprovalDecisionInput,c:SecurityActionContext,s?:AbortSignal)=>write('decide',r,c,s),
  withdrawSubmission:(r:SecurityActionSubmitInput,c:SecurityActionContext,s?:AbortSignal)=>write('withdraw-submission',r,c,s),
  withdrawApproval:(r:SecurityActionSubmitInput,c:SecurityActionContext,s?:AbortSignal)=>write('withdraw-approval',r,c,s),
  execute:(r:SecurityActionSubmitInput,c:SecurityActionContext,s?:AbortSignal)=>write('execute',r,c,s),
  observe:(r:SecurityObservationInput,c:SecurityActionContext,s?:AbortSignal)=>write('observe',r,c,s),
  acknowledgeFailure:(r:SecurityActionSubmitInput,c:SecurityActionContext,s?:AbortSignal)=>write('acknowledge-failure',r,c,s),
 }
}
