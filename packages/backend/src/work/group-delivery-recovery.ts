import type {Pool,PoolClient} from 'pg'
import {createHash} from 'node:crypto'
import {preparedMaintenanceControlsCurrent} from './prepared-maintenance.ts'
import {isDeepStrictEqual} from 'node:util'
import {WorkError,isMessageReference,groupDeliveryRecoveryTarget,groupDeliveryRecoveryCommand,readRunTextCapability,type GroupDeliveryRecoveryCheck,type GroupDeliveryRecoveryCandidate,type GroupDeliveryRecoveryReceipt,type RunTextCapability,type WorkTask,type DigitalRole,type WorkLineage} from '@teloa/contract'
import {readStoredTask} from './tasks.ts'
import {readStoredRole} from './roles.ts'
import {readGroupTaskSource} from './group-tasks.ts'
import {readRunGroupContext,type RunGroupContext,type RunGroupFilePorts} from './task-run-group-context.ts'
import {readRunAnalysisBasis} from './run-analysis-scope.ts'
import {WorkLineageService} from './work-lineage.ts'
import {workAccess} from './work-access.ts'
import {readGroupDeliveryControlRebinding,assertGroupDeliveryControlRebinding,type GroupDeliveryControlRebinding} from './group-delivery-control-rebinding.ts'

// jsonb回读不承诺对象键序；摘要只规范化对象键，保留数组顺序和原正文。
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)).digest('hex')
const textDigest=(value:string)=>createHash('sha256').update(value).digest('hex')
const conflict=(message='原工作或固定资料已变化，请重新核对。')=>new WorkError('teloa/conflict',message)
type UnsentProof={sessionId:string|null;sha256:string;unsent:true}
export type GroupDeliveryRecoveryHost={assertUnsent:(input:{ownerId:string;requestId:string;taskId:string;roleId:string;roleVersion:number},signal?:AbortSignal)=>Promise<UnsentProof>}

/** 独立审计只追加。原blocked整行在恢复前冻结，不通过SQL手工修复，也不覆盖失败事实。 */
export async function initializeGroupDeliveryRecovery(pool:Pick<Pool,'query'>):Promise<void>{await pool.query(`
 create table if not exists teloa_group_delivery_recoveries(
  id uuid primary key,owner_id text not null,request_id uuid not null,item_id uuid not null,
  task_id uuid not null,dispatch_request_id uuid not null,request_spec jsonb not null,
  original_blocked jsonb not null,basis jsonb not null,basis_sha256 text not null,
  capability jsonb not null,receipt jsonb not null,created_at timestamptz not null,
  unique(owner_id,request_id),unique(owner_id,item_id)
 );
 -- 原56每个item仅有一次确认。只替换这个唯一约束，不改任何旧审计行或历史回执。
 do $$ declare old_constraint record; begin
  for old_constraint in select conname from pg_constraint where conrelid='teloa_group_delivery_recoveries'::regclass and contype='u'
   and conkey=array[(select attnum from pg_attribute where attrelid='teloa_group_delivery_recoveries'::regclass and attname='owner_id'),(select attnum from pg_attribute where attrelid='teloa_group_delivery_recoveries'::regclass and attname='item_id')]::smallint[]
  loop execute format('alter table teloa_group_delivery_recoveries drop constraint %I',old_constraint.conname); end loop;
  if exists(select 1 from pg_index i where i.indrelid='teloa_group_delivery_recoveries'::regclass and i.indisunique and i.indpred is null and i.indexprs is null and i.indnkeyatts=2 and
   (select array_agg(a.attname order by k.position) from unnest(i.indkey::smallint[]) with ordinality k(attnum,position) join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum where k.position<=i.indnkeyatts)=array['owner_id','item_id']::name[])
  then raise exception '旧item单例唯一索引尚未替换，保持原审计不继续初始化'; end if;
  if not exists(select 1 from pg_constraint where conrelid='teloa_group_delivery_recoveries'::regclass and conname='teloa_group_delivery_reconfirmation_basis') then
   alter table teloa_group_delivery_recoveries add constraint teloa_group_delivery_reconfirmation_basis check(not(basis ? 'reconfirmation') or coalesce(
    jsonb_typeof(basis->'reconfirmation')='object' and basis#>>'{reconfirmation,previousRecoveryId}' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
    and basis#>>'{reconfirmation,previousBasisSha256}' ~ '^[a-f0-9]{64}$' and basis#>>'{reconfirmation,previousReceiptSha256}' ~ '^[a-f0-9]{64}$' and jsonb_typeof(basis#>'{reconfirmation,previousControls}')='array',false));
  end if;
 end $$;
 create unique index if not exists teloa_group_delivery_initial_item on teloa_group_delivery_recoveries(owner_id,item_id) where not(basis ? 'reconfirmation');
 create unique index if not exists teloa_group_delivery_single_successor on teloa_group_delivery_recoveries(owner_id,item_id,(basis#>>'{reconfirmation,previousRecoveryId}')) where basis ? 'reconfirmation';
 create index if not exists teloa_group_delivery_task_history on teloa_group_delivery_recoveries(owner_id,task_id);
 create table if not exists teloa_group_delivery_recovery_rejections(
  owner_id text not null,request_id uuid not null,request_spec jsonb not null,
  receipt jsonb not null,created_at timestamptz not null,primary key(owner_id,request_id)
 );
 create or replace function teloa_group_delivery_recovery_immutable() returns trigger language plpgsql as $$ begin
  raise exception 'teloa_group_delivery_recoveries is append-only';
 end $$;
 drop trigger if exists teloa_group_delivery_recovery_immutable on teloa_group_delivery_recoveries;
 create trigger teloa_group_delivery_recovery_immutable before update or delete on teloa_group_delivery_recoveries for each row execute function teloa_group_delivery_recovery_immutable();
 drop trigger if exists teloa_group_delivery_recovery_rejections_immutable on teloa_group_delivery_recovery_rejections;
 create trigger teloa_group_delivery_recovery_rejections_immutable before update or delete on teloa_group_delivery_recovery_rejections for each row execute function teloa_group_delivery_recovery_immutable();
`)}

export function textCapabilityMaterials(context:RunGroupContext):RunTextCapability['materials']{
 return context.materials.map(item=>({id:item.resourceId,version:item.resourceVersion,sha256:textDigest(item.markdown)})).sort((a,b)=>a.id.localeCompare(b.id))
}
export function assertRunTextContext(capability:RunTextCapability,owner:string,task:Pick<WorkTask,'id'|'version'>,role:Pick<DigitalRole,'id'|'version'|'skills'|'knowledge'>,context:RunGroupContext|undefined):void{
 if(capability.ownerId!==owner||capability.taskId!==task.id||capability.taskVersion!==task.version||capability.roleId!==role.id||capability.roleVersion!==role.version||!context||context.groupId!==capability.groupId||context.groupVersion!==capability.groupVersion||context.source.messageId!==capability.sourceMessageId||context.files.length||context.workResources?.length||!isDeepStrictEqual(textCapabilityMaterials(context),capability.materials))throw conflict('受限文本能力只允许本人确认的原工作与固定群资料，不能替换来源或扩大范围。')
}

type RecoveryRow=Record<string,any>
type Reconfirmation={previousRecoveryId:string;previousBasisSha256:string;previousReceiptSha256:string;previousControls:{id:string;state:'active';generation:number}[]}
type Basis={analysis?:true;outbox:Record<string,unknown>;task:WorkTask;role:DigitalRole;context:RunGroupContext;sourceDigest:string;group:Record<string,unknown>;controls:Record<string,unknown>[];unsent:UnsentProof;controlRebinding?:GroupDeliveryControlRebinding;reconfirmation?:Reconfirmation;previousConfirmedAt?:string;initialBlocked?:Record<string,unknown>}
function basisValue(b:Basis){return {...(b.analysis?{analysis:true}:{}),outbox:b.outbox,task:b.task,role:b.role,context:b.context,sourceDigest:b.sourceDigest,group:b.group,controls:b.controls,unsent:b.unsent,...(b.controlRebinding?{controlRebinding:b.controlRebinding}:{}),...(b.reconfirmation?{reconfirmation:b.reconfirmation}:{})}}
const controlSnapshot=(controls:Record<string,unknown>[])=>controls.map(control=>({id:control.id,generation:control.generation}))
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
function readReconfirmation(value:unknown):Reconfirmation{
 const r=value as Reconfirmation
 if(!r||Object.keys(r).length!==4||!uuid(r.previousRecoveryId)||!/^[a-f0-9]{64}$/.test(r.previousBasisSha256)||!/^[a-f0-9]{64}$/.test(r.previousReceiptSha256)||!Array.isArray(r.previousControls)||!r.previousControls.length||r.previousControls.some(control=>!control||Object.keys(control).length!==3||!uuid(control.id)||control.state!=='active'||!Number.isSafeInteger(control.generation)||control.generation<1))throw Error('重新确认前驱损坏')
 return r
}
function fixedIntent(row:RecoveryRow){const {state,attempts,next_attempt_at,lease_generation,reason,dispatch_control_snapshot,...fixed}=row;return JSON.parse(JSON.stringify(fixed)) as Record<string,unknown>}

type AnalysisApproval=Omit<RunTextCapability,'schema'|'kind'>&{schema:'teloa.group-analysis-confirmation/v1';kind:'analysis';files:NonNullable<GroupDeliveryRecoveryCandidate['files']>}
type RecoveryApproval=RunTextCapability|AnalysisApproval
function readApproval(value:unknown):RecoveryApproval{
 if((value as {kind?:string})?.kind!=='analysis')return readRunTextCapability(value)
 const v=value as AnalysisApproval,{files,...common}=v
 // 通用身份字段沿同样的严格校验；保存的仍是独立 analysis schema，不生成 text 能力。
 const checked=readRunTextCapability({...common,schema:'teloa.run-text-capability/v1',kind:'text'})
 if(v.schema!=='teloa.group-analysis-confirmation/v1'||!Array.isArray(files)||files.length>8||files.some(f=>!f||!['attachment','artifact'].includes(f.kind)||!isMessageReference({kind:f.kind,id:f.id,version:f.version})||typeof f.title!=='string'||!f.title.trim()||!Number.isSafeInteger(f.version)||f.version<1||!Number.isSafeInteger(f.bytes)||f.bytes<0||!/^[a-f0-9]{64}$/.test(f.sha256)||typeof f.mime!=='string'||Object.keys(f).sort().join(',')!=='bytes,id,kind,mime,sha256,title,version'))throw conflict('原分析确认的固定资料不可核对。')
 return {...checked,schema:v.schema,kind:'analysis',files}
}
function approvalFiles(context:RunGroupContext):AnalysisApproval['files']{return context.files.map(f=>({kind:f.kind,id:f.id,title:f.name,version:f.version,sha256:f.sha256,bytes:f.bytes,mime:f.mime}))}
function assertApprovalContext(cap:RecoveryApproval,owner:string,task:WorkTask,role:DigitalRole,context:RunGroupContext|undefined):void{
 if(cap.kind==='text'){assertRunTextContext(cap,owner,task,role,context);return}
 if(!context||cap.ownerId!==owner||cap.taskId!==task.id||cap.taskVersion!==task.version||cap.roleId!==role.id||cap.roleVersion!==role.version||cap.groupId!==context.groupId||cap.groupVersion!==context.groupVersion||cap.sourceMessageId!==context.source.messageId||!context.ownerRequest||context.workResources?.length||!isDeepStrictEqual(cap.materials,textCapabilityMaterials(context))||!isDeepStrictEqual(cap.files,approvalFiles(context)))throw conflict('原分析确认的来源或固定资料已变化。')
}
/** 这是原确认的历史受理回执，不能把损坏JSON当新授权，也不重新排队。 */
function readRecoveryReceipt(row:Record<string,any>,owner:string,command:ReturnType<typeof groupDeliveryRecoveryCommand>):GroupDeliveryRecoveryReceipt{
 try{
  const cap=readApproval(row.capability),receipt=row.receipt as GroupDeliveryRecoveryReceipt
  const expected:GroupDeliveryRecoveryReceipt={schema:'teloa.group-delivery-recovery-receipt/v1',requestId:command.requestId,recoveryId:cap.approvalId,itemId:command.itemId,groupId:command.groupId,messageId:command.messageId,taskId:cap.taskId,dispatchRequestId:row.dispatch_request_id,state:'pending',capability:cap.kind,confirmedAt:cap.confirmedAt}
  groupDeliveryRecoveryCommand({...command,requestId:row.dispatch_request_id})
  const reconfirmation=row.basis?.reconfirmation===undefined?undefined:readReconfirmation(row.basis.reconfirmation),current=row.basis?.outbox
  if(digest(row.basis)!==row.basis_sha256||!reconfirmation&&!isDeepStrictEqual(row.original_blocked,current)||reconfirmation&&(!row.basis.analysis&&!row.basis.controlRebinding||!['pending','blocked'].includes(current?.state))||row.basis?.sourceDigest!==cap.sourceDigest||current?.owner_id!==owner||current?.group_id!==command.groupId||current?.message_id!==command.messageId||current?.id!==command.itemId||current?.task_id!==cap.taskId||current?.role_id!==cap.roleId||current?.role_version!==cap.roleVersion||current?.request_id!==row.dispatch_request_id||current?.run_id!==null||row.created_at?.toISOString()!==cap.confirmedAt)throw Error()
  if(cap.kind!==command.capability||!!row.basis.analysis!==(cap.kind==='analysis'))throw Error()
  assertApprovalContext(cap,owner,row.basis.task,row.basis.role,row.basis.context)
  if(row.basis.controlRebinding)assertGroupDeliveryControlRebinding(row.basis.controlRebinding,owner,cap.taskId,reconfirmation?controlSnapshot(reconfirmation.previousControls):row.original_blocked.dispatch_control_snapshot,controlSnapshot(row.basis.controls))
  if(row.owner_id!==owner||row.request_id!==command.requestId||row.id!==cap.approvalId||row.item_id!==command.itemId||row.task_id!==cap.taskId||row.basis_sha256!==command.expectedBasisSha256||cap.ownerId!==owner||cap.groupId!==command.groupId||cap.sourceMessageId!==command.messageId||cap.roleId!==command.roleId||row.original_blocked?.task_id!==cap.taskId||row.original_blocked?.request_id!==row.dispatch_request_id||row.original_blocked?.id!==command.itemId||row.original_blocked?.state!=='blocked'||!isDeepStrictEqual(receipt,expected))throw Error()
  return expected
 }catch{throw new WorkError('teloa/storage-corrupt','原恢复受理回执与本人原工作不一致，请保留原请求核对。')}
}

/** 线性、不可变的确认链；不用created_at或UUID排序猜当前授权，历史回执不授予当前派发权。 */
async function recoveryHistory(db:PoolClient,owner:string,taskId:string):Promise<{head:RecoveryRow;root:RecoveryRow;rows:RecoveryRow[]}|undefined>{
 const rows=(await db.query('select * from teloa_group_delivery_recoveries where owner_id=$1 and task_id=$2 for share',[owner,taskId])).rows as RecoveryRow[]
 if(!rows.length)return undefined
 try{
  for(const row of rows)readRecoveryReceipt(row,owner,groupDeliveryRecoveryCommand(row.request_spec))
  const roots=rows.filter(row=>row.basis.reconfirmation===undefined);if(roots.length!==1)throw Error()
  const root=roots[0]!,seen=new Set<string>();let head=root
  while(true){
   if(seen.has(head.id))throw Error();seen.add(head.id)
   const next=rows.filter(row=>row.basis.reconfirmation?.previousRecoveryId===head.id);if(next.length>1)throw Error()
   if(!next.length)break
   const row=next[0]!,r=readReconfirmation(row.basis.reconfirmation),previous=readApproval(head.capability),current=readApproval(row.capability)
   if(row.item_id!==root.item_id||row.task_id!==taskId||row.dispatch_request_id!==root.dispatch_request_id||r.previousBasisSha256!==head.basis_sha256||r.previousReceiptSha256!==digest(head.receipt)||!isDeepStrictEqual(r.previousControls,head.basis.controls)||!isDeepStrictEqual(row.original_blocked,root.original_blocked)||!isDeepStrictEqual(fixedIntent(row.basis.outbox),fixedIntent(head.basis.outbox))||!isDeepStrictEqual({...previous,approvalId:current.approvalId,confirmedAt:current.confirmedAt},current))throw Error()
   for(const key of ['task','role','context','sourceDigest','group'])if(!isDeepStrictEqual(row.basis[key],head.basis[key]))throw Error()
   head=row
  }
  if(seen.size!==rows.length)throw Error()
  return {head,root,rows}
 }catch{throw new WorkError('teloa/storage-corrupt','原工作确认历史缺失、分支或内容不一致，已保留原请求。')}
}

export class GroupDeliveryRecoveryService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 readonly host:GroupDeliveryRecoveryHost
 readonly files:RunGroupFilePorts|undefined
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},host:GroupDeliveryRecoveryHost,files?:RunGroupFilePorts){this.pool=pool;this.identity=identity;this.host=host;this.files=files}
 private async transaction<T>(fn:(db:PoolClient)=>Promise<T>):Promise<T>{const db=await this.pool.connect();try{await db.query('begin');const result=await fn(db);await db.query('commit');return result}catch(error){await db.query('rollback');throw error}finally{db.release()}}
 private async basis(db:PoolClient,owner:string,target:ReturnType<typeof groupDeliveryRecoveryTarget>,signal?:AbortSignal):Promise<Basis>{
  signal?.throwIfAborted()
  if(!owner||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const rows=(await db.query("select * from teloa_group_routing_outbox where owner_id=$1 and group_id=$2 and message_id=$3 and role_id=$4 order by decision_version desc limit 1 for update",[owner,target.groupId,target.messageId,target.roleId])).rows,outbox=rows[0]
  if(!outbox||!['pending','blocked'].includes(outbox.state)||outbox.run_id!==null||outbox.task_id===null||outbox.execution_mode!=='work'||outbox.business_target?.object!==undefined||outbox.state==='blocked'&&!['teloa/conflict','teloa/role-run-no-execution-tools','teloa/forbidden'].includes(String(outbox.reason)))throw conflict('这项工作不能使用文本恢复；请先核对原执行结果。')
  const taskRow=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2 for share',[owner,outbox.task_id])).rows[0],roleRow=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2 for share',[owner,target.roleId])).rows[0]
  if(!taskRow||!roleRow)throw conflict()
  const task=readStoredTask(taskRow),role=readStoredRole(roleRow)
  if(taskRow.request_id!==outbox.request_id||task.version!==1||task.contentVersion!==1||task.state!=='ready'||task.assigneeRoleId!==role.id||task.assigneeRoleVersion!==outbox.role_version||role.version!==outbox.role_version||role.state!=='active'||role.kind!=='employee')throw conflict('原任务负责人、版本或执行范围已变化，不能借文本恢复替换原安排。')
  if((await db.query('select 1 from teloa_task_runs where owner_id=$1 and (task_id=$2 or request_id=$3) limit 1',[owner,task.id,outbox.request_id])).rows.length)throw conflict('原工作已有运行记录，只能核对原运行，不能重新准备。')
  const history=await recoveryHistory(db,owner,task.id),previous=history?.head
  if(!previous&&outbox.state!=='blocked')throw conflict('原工作仍在正常排队，无需再次确认。')
  if(previous&&(previous.item_id!==outbox.id||!isDeepStrictEqual(fixedIntent(outbox),fixedIntent(previous.basis.outbox))))throw conflict('原派工安排已经变化，不能沿旧确认重新安排。')
  // 该入口只修复缺少执行能力的原工作；已有岗位工具不能借此被静默变更。
  const tool=(await db.query('select * from teloa_role_tool_grants where role_id=$1 order by role_version desc limit 1 for share',[role.id])).rows[0]
  if(tool?.state==='active'&&Array.isArray(tool.rules)&&tool.rules.length)throw conflict('员工已有执行工具，请核对原执行能力后继续。')
  const sourceRow=(await db.query('select * from teloa_group_task_sources where owner_id=$1 and task_id=$2 for share',[owner,task.id])).rows[0]
  if(!sourceRow)throw conflict();const source=readGroupTaskSource(sourceRow)
  const message=(await db.query('select * from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3 for share',[owner,target.groupId,target.messageId])).rows[0]
  const analysis=message?.author_id!=='self'||outbox.business_target!==null||source.references.some(ref=>ref.kind!=='group-resource')
  if(!message||!analysis&&message.author_id!=='self'||source.messageId!==target.messageId||source.groupId!==target.groupId||source.schema!=='teloa.group-task-source/v2'||source.executionMode!=='work'||!analysis&&source.references.some(ref=>ref.kind!=='group-resource')||!isDeepStrictEqual(source.references,message.reference_snapshot))throw conflict('只能沿本人原消息已明确引用的固定群资料恢复。')
  const group=(await db.query('select * from teloa_groups where owner_id=$1 and id=$2 for share',[owner,target.groupId])).rows[0]
  if(!group||group.archived||group.version!==outbox.group_version||group.version!==source.groupVersion)throw conflict('群设置已经变化，请重新核对原工作。')
  const context=await readRunGroupContext(db,owner,task,role,this.files,this.pool,[],{kind:'prepare',taskVersion:task.version})
  if(!context||context.workResources?.length||!analysis&&(context.files.length||context.materials.length!==source.references.length))throw conflict('当前资料不是可核对的完整固定文本，暂不能使用文本能力。')
  const lineage=await new WorkLineageService(this.pool,this.identity).readInTransaction(db,owner,{taskId:task.id})
  if(!lineage||!isDeepStrictEqual(lineage,outbox.lineage))throw conflict('原工作控制归属已经变化。')
  if(analysis){const grant=(await db.query('select * from teloa_group_agent_grants where owner_id=$1 and group_id=$2 and role_id=$3 order by grant_version desc limit 1 for share',[owner,target.groupId,role.id])).rows[0];if(!grant?.can_auto_run||!grant.can_post)throw conflict('原员工当前没有本群执行与交付许可。');if(!await readRunAnalysisBasis(db,this.pool,owner,task,role,context,lineage))throw conflict('原工作不符合固定资料只读分析范围。')}else if(outbox.business_target!==null||outbox.reason==='teloa/forbidden'&&!previous)throw conflict()
  const ids=[lineage.roundControlId,...(lineage.definitionControlId?[lineage.definitionControlId]:[])],controls=(await db.query('select id,state,generation from teloa_work_controls where owner_id=$1 and id=any($2::uuid[]) order by id for share',[owner,ids])).rows
  const snapshot=controls.map(row=>({id:row.id,generation:row.generation}))
  if(controls.length!==ids.length||controls.some(row=>row.state!=='active'))throw conflict('原工作已暂停或结束，不能恢复旧派工。')
  if(previous){
   const current={task,role,context,sourceDigest:String(sourceRow.snapshot_digest),group}
   for(const key of ['task','role','context','sourceDigest','group'] as const)if(digest(current[key])!==digest(previous.basis[key]))throw conflict('原任务、员工、资料或授权已经变化，不能沿旧范围再次确认。')
  }
  const reconfirmation:Reconfirmation|undefined=previous?{previousRecoveryId:previous.id,previousBasisSha256:previous.basis_sha256,previousReceiptSha256:digest(previous.receipt),previousControls:previous.basis.controls}:undefined
  const controlRebinding=analysis?undefined:await readGroupDeliveryControlRebinding(db,owner,task.id,lineage,reconfirmation?controlSnapshot(reconfirmation.previousControls):outbox.dispatch_control_snapshot,snapshot)
  if(reconfirmation&&!controlRebinding&&(!analysis||isDeepStrictEqual(controlSnapshot(reconfirmation.previousControls),snapshot)))throw conflict('原确认仍属当前代次，请核对原派工状态；无需重复确认。')
  const unsent=await this.host.assertUnsent({ownerId:owner,requestId:String(outbox.request_id),taskId:task.id,roleId:role.id,roleVersion:role.version},signal)
  if(unsent.unsent!==true||!/^[a-f0-9]{64}$/.test(unsent.sha256))throw conflict('无法证明原执行尚未提交，已保留现场。')
  signal?.throwIfAborted();return {...(analysis?{analysis:true as const}:{}),outbox,task,role,context,sourceDigest:String(sourceRow.snapshot_digest),group,controls,unsent,...(controlRebinding?{controlRebinding}:{}),...(reconfirmation?{reconfirmation,previousConfirmedAt:String(previous!.receipt.confirmedAt),initialBlocked:history!.root.original_blocked}:{})}
 }
 async inspect(owner:string,input:unknown,signal?:AbortSignal):Promise<GroupDeliveryRecoveryCandidate>{
  const target=groupDeliveryRecoveryTarget(input)
  return this.transaction(async db=>{const b=await this.basis(db,owner,target,signal),candidate:GroupDeliveryRecoveryCandidate={schema:'teloa.group-delivery-recovery-candidate/v1',target,itemId:String(b.outbox.id),taskId:b.task.id,taskTitle:b.task.title,basisSha256:digest(basisValue(b)),materials:b.context.materials.map(item=>({id:item.resourceId,title:item.title,version:item.resourceVersion,sha256:textDigest(item.markdown)})),...(b.analysis?{files:approvalFiles(b.context)}:{}),reason:b.analysis?(b.reconfirmation?'analysis-capability-reconfirmation-required':'analysis-capability-required'):(b.reconfirmation?'text-capability-reconfirmation-required':'text-capability-required'),...(b.controlRebinding?{controlRebinding:{kind:'planned-restart' as const,restartCount:new Set(b.controlRebinding.chains.flatMap(chain=>chain.steps.map(step=>step.restart.restartId))).size}}:{}),...(b.reconfirmation?{reconfirmation:{previousRecoveryId:b.reconfirmation.previousRecoveryId,previousConfirmedAt:b.previousConfirmedAt!}}:{})};return candidate})
 }
 private async prior(db:PoolClient,owner:string,command:ReturnType<typeof groupDeliveryRecoveryCommand>):Promise<GroupDeliveryRecoveryCheck|undefined>{
  const accepted=(await db.query('select * from teloa_group_delivery_recoveries where owner_id=$1 and request_id=$2',[owner,command.requestId])).rows[0],rejected=(await db.query('select * from teloa_group_delivery_recovery_rejections where owner_id=$1 and request_id=$2',[owner,command.requestId])).rows[0]
  if(accepted&&rejected)throw new WorkError('teloa/storage-corrupt','原恢复请求同时存在冲突回执，请保留原请求核对。')
  const row=accepted??rejected
  if(!row)return undefined
  if(!isDeepStrictEqual(row.request_spec,command))throw conflict('同一恢复请求不能改为另一项工作。')
  if(accepted){const history=await recoveryHistory(db,owner,accepted.task_id);if(!history?.rows.some(row=>row.id===accepted.id))throw new WorkError('teloa/storage-corrupt','历史确认缺少原工作链。');return {schema:'teloa.group-delivery-recovery-check/v1',state:'accepted',receipt:readRecoveryReceipt(accepted,owner,command)}}
  try{
   const reason=rejected.receipt?.reason
   if(!['teloa/conflict','teloa/forbidden','teloa/version-conflict'].includes(reason))throw Error()
   const value:Extract<GroupDeliveryRecoveryCheck,{state:'not-accepted'}>={schema:'teloa.group-delivery-recovery-check/v1',state:'not-accepted',command,recordedAt:rejected.created_at.toISOString(),reason}
   if(rejected.owner_id!==owner||rejected.request_id!==command.requestId||!isDeepStrictEqual(value,rejected.receipt))throw Error()
   return value
  }catch{throw new WorkError('teloa/storage-corrupt','原请求未受理回执损坏，请保留原请求核对。')}
 }
 /** 只读核对；没有行仅表示未观察，不把可能迟到的原请求当成确定未受理。 */
 async receipt(owner:string,input:unknown,signal?:AbortSignal):Promise<GroupDeliveryRecoveryCheck>{
  if(!owner||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const command=groupDeliveryRecoveryCommand(input)
  return this.transaction(async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['group-delivery-recovery',owner,command.requestId])]);signal?.throwIfAborted()
   return await this.prior(db,owner,command)??{schema:'teloa.group-delivery-recovery-check/v1',state:'unobserved',command}
  })
 }
 async recover(owner:string,input:unknown,signal?:AbortSignal):Promise<GroupDeliveryRecoveryReceipt>{
  if(!owner||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const command=groupDeliveryRecoveryCommand(input),spec=JSON.stringify(command)
  const result=await this.transaction<{receipt?:GroupDeliveryRecoveryReceipt;denial?:WorkError}>(async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['group-delivery-recovery',owner,command.requestId])])
   const prior=await this.prior(db,owner,command)
   if(prior?.state==='accepted')return {receipt:prior.receipt}
   if(prior?.state==='not-accepted')return {denial:new WorkError(prior.reason,'原恢复请求已明确未受理，请重新核对原工作；不能重用已结束的请求。')}
   await db.query('savepoint recovery_admission')
   try{
   const b=await this.basis(db,owner,command,signal),basis=basisValue(b)
   if(command.capability!==(b.analysis?'analysis':'text')||b.outbox.id!==command.itemId||digest(basis)!==command.expectedBasisSha256)throw conflict('原工作或资料在确认前变化，请重新核对；没有恢复或重新发送。')
   const admission=await workAccess.authorize({kind:'capability',capability:'people',ownerId:owner,sessionId:null,objectId:b.role.id,operation:'create'});admission.assertCurrent()
   const id=this.identity.id(),now=this.identity.now(),capability=readApproval({schema:b.analysis?'teloa.group-analysis-confirmation/v1':'teloa.run-text-capability/v1',kind:b.analysis?'analysis':'text',...(b.analysis?{files:approvalFiles(b.context)}:{}),approvalId:id,ownerId:owner,taskId:b.task.id,taskVersion:b.task.version,roleId:b.role.id,roleVersion:b.role.version,groupId:command.groupId,groupVersion:b.context.groupVersion,sourceMessageId:command.messageId,sourceDigest:b.sourceDigest,materials:textCapabilityMaterials(b.context),confirmedAt:now})
   const receipt:GroupDeliveryRecoveryReceipt={schema:'teloa.group-delivery-recovery-receipt/v1',requestId:command.requestId,recoveryId:id,itemId:command.itemId,groupId:command.groupId,messageId:command.messageId,taskId:b.task.id,dispatchRequestId:String(b.outbox.request_id),state:'pending',capability:capability.kind,confirmedAt:now}
   await db.query('insert into teloa_group_delivery_recoveries(id,owner_id,request_id,item_id,task_id,dispatch_request_id,request_spec,original_blocked,basis,basis_sha256,capability,receipt,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',[id,owner,command.requestId,command.itemId,b.task.id,b.outbox.request_id,spec,JSON.stringify(b.initialBlocked??b.outbox),JSON.stringify(basis),command.expectedBasisSha256,JSON.stringify(capability),JSON.stringify(receipt),now])
   // 仅本人本次确认事务重绑定；旧snapshot仍冻结在append-only审计，后续派发的严格代次闸不变。
   const nextSnapshot=b.analysis?controlSnapshot(b.controls):b.controlRebinding?.confirmedSnapshot??b.outbox.dispatch_control_snapshot
   const changed=await db.query("update teloa_group_routing_outbox set state='pending',reason=null,next_attempt_at=null,lease_generation=lease_generation+1,dispatch_control_snapshot=$7::jsonb where owner_id=$1 and id=$2 and state=$8 and task_id=$3 and run_id is null and request_id=$4 and lease_generation=$5 and dispatch_control_snapshot=$6::jsonb returning id",[owner,command.itemId,b.task.id,b.outbox.request_id,b.outbox.lease_generation,JSON.stringify(b.outbox.dispatch_control_snapshot),JSON.stringify(nextSnapshot),b.outbox.state])
   if(changed.rowCount!==1)throw conflict('原派工已变化，本次恢复没有生效。')
   signal?.throwIfAborted();admission.assertCurrent();return {receipt}
   }catch(error){
    if(!(error instanceof WorkError)||!['teloa/conflict','teloa/forbidden','teloa/version-conflict'].includes(error.code))throw error
    // 先回滚所有准备/队列写入，再提交独立负回执；外层提交后才向RPC抛出明确拒绝。
    await db.query('rollback to savepoint recovery_admission')
    const recordedAt=this.identity.now(),negative:Extract<GroupDeliveryRecoveryCheck,{state:'not-accepted'}>={schema:'teloa.group-delivery-recovery-check/v1',state:'not-accepted',command,recordedAt,reason:error.code as 'teloa/conflict'|'teloa/forbidden'|'teloa/version-conflict'}
    await db.query('insert into teloa_group_delivery_recovery_rejections(owner_id,request_id,request_spec,receipt,created_at) values($1,$2,$3,$4,$5)',[owner,command.requestId,spec,JSON.stringify(negative),recordedAt])
    return {denial:error}
   }
  })
  if(result.denial)throw result.denial
  if(!result.receipt)throw new WorkError('teloa/storage-corrupt','原恢复请求没有可核对回执。')
  return result.receipt
 }
}

/** Run准备只认正式恢复审计里的本人选择，不把模型或任意inputText中的text字样当授权。 */
export async function authorizedRunTextCapability(db:PoolClient,owner:string,task:WorkTask,role:DigitalRole,context:RunGroupContext|undefined,lineage:WorkLineage,continuation=false):Promise<RunTextCapability|undefined>{
 if(!(await db.query("select to_regclass('teloa_group_delivery_recoveries') as relation")).rows[0]?.relation)return undefined
 const row=(await recoveryHistory(db,owner,task.id))?.head
 if(!row)return undefined
 const approved=readApproval(row.capability)
 if(approved.approvalId!==row.id||approved.taskId!==task.id||approved.ownerId!==owner||approved.taskVersion!==task.version&&!continuation)throw conflict('原确认与当前工作版本不一致。')
 const fixedSource=(await db.query('select snapshot_digest from teloa_group_task_sources where owner_id=$1 and task_id=$2 for share',[owner,task.id])).rows[0]
 if(fixedSource?.snapshot_digest!==approved.sourceDigest)throw conflict('原群任务固定来源已经变化。')
 if(approved.kind==='analysis'){
  assertApprovalContext({...approved,taskVersion:task.version},owner,task,role,context)
  if(!isDeepStrictEqual(row.basis.outbox.lineage,lineage)||!continuation&&!isDeepStrictEqual((await db.query('select id,state,generation from teloa_work_controls where owner_id=$1 and id=any($2::uuid[]) order by id for share',[owner,row.basis.controls.map((c:{id:string})=>c.id)])).rows,row.basis.controls))throw conflict('本人分析确认后工作控制已经变化，请重新核对。')
  return undefined
 }
 if(approved.approvalId!==row.id||approved.taskId!==task.id||approved.ownerId!==owner||approved.taskVersion!==task.version&&!continuation)throw conflict('受限文本能力与当前原工作版本不一致。')
 const source=(await db.query('select snapshot_digest from teloa_group_task_sources where owner_id=$1 and task_id=$2 for share',[owner,task.id])).rows[0]
 if(source?.snapshot_digest!==approved.sourceDigest)throw conflict('原群任务固定来源已经变化。')
 const current=readRunTextCapability({...approved,taskVersion:task.version});assertRunTextContext(current,owner,task,role,context);await assertRunTextControlsCurrent(db,owner,current,lineage,undefined,continuation);return current
}

/** 文本授权以不可变本人确认依据为准，不能随新租约跟到新代次。 */
export async function assertRunTextControlsCurrent(db:PoolClient,owner:string,capability:RunTextCapability,lineage:WorkLineage|undefined,runId?:string,trustedContinuation=false):Promise<void>{
 const history=await recoveryHistory(db,owner,capability.taskId),row=history?.rows.find(row=>row.id===capability.approvalId)
 if(!row)throw new WorkError('teloa/storage-corrupt','受限文本执行缺少本人确认的控制依据。')
 readRecoveryReceipt(row,owner,groupDeliveryRecoveryCommand(row.request_spec))
 if(history!.head.id!==capability.approvalId)throw conflict('原文本确认已有本人明确的新确认，旧能力不能重新执行。')
 if(!lineage||row.task_id!==capability.taskId||!isDeepStrictEqual(row.basis.outbox.lineage,lineage))throw conflict('受限文本执行的原工作控制归属已变化。')
 const ids=[lineage.roundControlId,...(lineage.definitionControlId?[lineage.definitionControlId]:[])].sort(),expected=row.basis.controls
 if(!Array.isArray(expected)||!isDeepStrictEqual(expected.map((control:Record<string,unknown>)=>control.id),ids)||expected.some((control:Record<string,unknown>)=>control.state!=='active'))throw new WorkError('teloa/storage-corrupt','受限文本确认的原控制快照不可核对。')
 const current=(await db.query('select id,state,generation from teloa_work_controls where owner_id=$1 and id=any($2::uuid[]) order by id for share',[owner,ids])).rows
 if(!isDeepStrictEqual(current,expected)&&!await preparedMaintenanceControlsCurrent(db,owner,runId,capability,current,trustedContinuation))throw conflict('本人确认后工作控制已变化；原文本能力不能自动沿用到新代次，请重新核对原工作。')
}

/** 历史Run仍可读；只验正式审计原件，不把当前授权变化改写成旧Run的历史。 */
export async function verifyRunTextCapability(db:PoolClient,owner:string,capability:RunTextCapability):Promise<void>{
 const row=(await db.query('select capability from teloa_group_delivery_recoveries where owner_id=$1 and id=$2',[owner,capability.approvalId])).rows[0]
 if(!row)throw new WorkError('teloa/storage-corrupt','受限文本运行缺少本人原确认审计。')
 const approved=readRunTextCapability(row.capability)
 if(approved.taskVersion>capability.taskVersion||!isDeepStrictEqual({...approved,taskVersion:capability.taskVersion},capability))throw new WorkError('teloa/storage-corrupt','受限文本运行与本人原确认不一致。')
}
