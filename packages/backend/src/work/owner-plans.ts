import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,readOwnerPlanFields,readPlanWorkConfiguration,readPlanWorkDefinition,workObject,workUuid,type OwnerPlanFields,type PlanWorkConfiguration} from '@teloa/contract'
import {readMethodReuseSource,readMethodReuseAcceptedSource} from '@teloa/contract'
import {workAccess,combineWorkAccessLeases} from './work-access.ts'
import {makeOwnerPlanGrant,readOwnerPlanGrant,type OwnerPlanAuthority,type OwnerPlanSource} from './owner-plan-authority.ts'
import type {PersistentPlan} from './plans.ts'
import {ownerWorkLease,revokeOwnerWorkLeases} from './owner-work-epochs.ts'
const denied=()=>new WorkError('teloa/forbidden','需要本人确认计划的固定来源及执行范围。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','本人计划身份、来源或授权记录不一致。')
const stamp=(v:unknown)=>{if(!(v instanceof Date)||!Number.isFinite(v.getTime()))throw corrupt();return v.toISOString()}
export function readOwnerPlanSource(value:unknown):OwnerPlanSource{
 if(!value||typeof value!=='object')throw denied()
 const {kind,acceptedSource,...source}=value as Record<string,unknown>
 if(kind!=='method-reuse')throw denied()
 const fixed=readMethodReuseSource(source)
 if(!Object.hasOwn(value,'acceptedSource')&&!fixed.taskId)throw denied()
 return {kind,...fixed,...(Object.hasOwn(value,'acceptedSource')?{acceptedSource:readMethodReuseAcceptedSource(acceptedSource)}:{})}
}
function readCreate(value:unknown){
 const v=workObject(value,['requestId','fields','source','configuration','intent'])
 if(!workUuid(v.requestId)||!['save-paused','create-and-enable'].includes(String(v.intent)))throw denied()
 const fields=readOwnerPlanFields(v.fields),source=readOwnerPlanSource(v.source),configuration=readPlanWorkConfiguration(v.configuration)
 assertConfiguration(fields,configuration)
 return {requestId:v.requestId,fields,source,configuration,intent:v.intent as 'save-paused'|'create-and-enable'}
}
function assertConfiguration(fields:OwnerPlanFields,configuration:PlanWorkConfiguration){
 if(configuration.triggers.length!==1||configuration.triggers[0]?.kind!=='schedule'||!isDeepStrictEqual(configuration.triggers[0].schedule,fields.trigger)||configuration.budget.money!==null)throw new WorkError('teloa/forbidden','本人计划须使用原日程和明确的累计工作额度。')
 if(fields.completionPolicy&&!isDeepStrictEqual(fields.completionPolicy,configuration.completion))throw new WorkError('teloa/invalid-input','计划结项策略与工作定义不一致。')
}
export function readStoredOwnerPlan(row:Record<string,unknown>):PersistentPlan{
 try{
  const fields=readOwnerPlanFields(row.definition),source=readOwnerPlanSource(row.source),grant=readOwnerPlanGrant(row.owner_grant,source)
  if(!workUuid(row.id)||typeof row.owner_id!=='string'||!row.owner_id||row.role_id!==null||row.role_version!==null||row.scope!=='general'||row.notification_policy!==fields.notificationPolicy||!Number.isSafeInteger(row.version)||Number(row.version)<1||!Number.isSafeInteger(row.config_version)||Number(row.config_version)<1||!['paused','active','archived'].includes(String(row.state)))throw corrupt()
  const workDefinition=readPlanWorkDefinition(row.work_definition),executor={kind:'owner' as const,grantId:row.id,grantVersion:Number(row.config_version)}
  if(!isDeepStrictEqual(workDefinition.authorization,executor)||workDefinition.definitionVersion!==row.config_version||!isDeepStrictEqual(workDefinition.completion,fields.completionPolicy))throw corrupt()
  assertConfiguration(fields,workDefinition)
  if(row.request_id!==undefined||row.request_spec!==undefined){
   if(!workUuid(row.request_id))throw corrupt()
   const original=readCreate({requestId:row.request_id,...row.request_spec as object})
   const {schema,definitionVersion,definitionControlId,budgetAccountId,authorization,...configuration}=workDefinition
   if(!isDeepStrictEqual(original.source,source)||row.config_version===1&&(!isDeepStrictEqual({...original.fields,completionPolicy:original.configuration.completion},fields)||!isDeepStrictEqual(original.configuration,configuration)))throw corrupt()
  }
  const archived=row.state==='archived'
  if(archived?typeof row.archived_reason!=='string'||!row.archived_reason.trim()||row.archived_at===null:row.archived_reason!==null||row.archived_at!==null)throw corrupt()
  return {...fields,executor,roleVersion:null,id:row.id,ownerId:row.owner_id,source,workDefinition,ownerGrant:grant,version:Number(row.version),configVersion:Number(row.config_version),state:row.state as PersistentPlan['state'],archivedReason:archived?row.archived_reason as string:null,archivedAt:archived?stamp(row.archived_at):null,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)}
 }catch{throw corrupt()}
}
export async function createOwnerPlan(pool:Pool,clock:{id:()=>string;now:()=>string},authority:OwnerPlanAuthority|undefined,owner:string,input:unknown):Promise<PersistentPlan>{
 if(!owner||!authority)throw denied()
 const value=readCreate(input),{requestId,...spec}=value,db=await pool.connect()
 try{await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['plan-create',owner,requestId])])
  const prior=(await db.query('select * from teloa_plans where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0]
  if(prior){
   if(!isDeepStrictEqual(prior.request_spec,spec))throw new WorkError('teloa/conflict','原请求已保存不同计划。')
   const {receiptPlan}=await import('./plans.ts'),result=receiptPlan(prior.owner_create_result)
   if(result.id!==prior.id||result.ownerId!==owner||result.version!==1||result.configVersion!==1||result.roleId!==null||result.state!==(value.intent==='create-and-enable'?'active':'paused')||!isDeepStrictEqual(result.source,value.source))throw corrupt()
   await db.query('commit');return result
  }
  const sourceLease=await authority.verifySource(db,owner,value.source),captured=await authority.capture(owner,value,db),grant=makeOwnerPlanGrant(value.source,captured.policy)
  const admission=combineWorkAccessLeases([sourceLease,captured.admission,await workAccess.authorize({kind:'capability',capability:'automation',ownerId:owner,sessionId:value.source.acceptedSource?.sessionId??null,objectId:requestId,operation:'create'})])
  const id=clock.id(),controlId=clock.id(),budgetId=clock.id(),now=clock.now(),executor={kind:'owner',grantId:id,grantVersion:1}
  await db.query('insert into teloa_work_budget_accounts(id,owner_id,policy,created_at) values($1,$2,$3,$4)',[budgetId,owner,JSON.stringify(value.configuration.budget),now])
  await db.query("insert into teloa_work_controls(id,owner_id,kind,root_task_id,budget_account_id,state,generation,created_at,updated_at) values($1,$2,'definition',null,$3,'active',1,$4,$4)",[controlId,owner,budgetId,now])
  const work=readPlanWorkDefinition({schema:'teloa.plan-work/v3',definitionVersion:1,definitionControlId:controlId,budgetAccountId:budgetId,authorization:executor,...value.configuration})
  const saved=(await db.query("insert into teloa_plans(id,owner_id,request_id,request_spec,definition,source,notification_policy,role_id,role_version,scope,version,config_version,state,archived_reason,archived_at,created_at,updated_at,work_definition,owner_grant) values($1,$2,$3,$4,$5,$6,$7,null,null,'general',1,1,$8,null,null,$9,$9,$10,$11) returning *",[id,owner,requestId,JSON.stringify(spec),JSON.stringify({...value.fields,completionPolicy:value.configuration.completion}),JSON.stringify(value.source),value.fields.notificationPolicy,value.intent==='create-and-enable'?'active':'paused',now,JSON.stringify(work),JSON.stringify(grant)])).rows[0]
  await db.query('insert into teloa_work_plan_bindings(owner_id,plan_id,config_version,definition_control_id,budget_account_id,created_at) values($1,$2,1,$3,$4,$5)',[owner,id,controlId,budgetId,now])
  admission.assertCurrent();const result=readStoredOwnerPlan(saved)
  await db.query('update teloa_plans set owner_create_result=$3 where owner_id=$1 and id=$2',[owner,id,JSON.stringify(result)])
  admission.assertCurrent();await db.query('commit');return result
 }catch(error){await db.query('rollback');throw error}finally{db.release()}
}
/** reconfigure 仅供暂停后的明确本人重配置：原定义控制可为 active 或 paused（随后由新 active 定义替换）；其余路径只认 active。 */
export async function verifyOwnerPlan(db:PoolClient,owner:string,plan:PersistentPlan,authority:OwnerPlanAuthority|undefined,allowPaused=false,reconfigure=false){
 if(reconfigure&&!allowPaused)throw denied()
 const controlStates=reconfigure?['active','paused']:['active']
 if(plan.roleId!==null||!plan.executor||!plan.ownerGrant||plan.source.kind!=='method-reuse'||!authority||plan.state!==(allowPaused?'paused':'active')||!plan.workDefinition||!isDeepStrictEqual(plan.executor,plan.workDefinition.authorization))throw denied()
 const source=await authority.verifySource(db,owner,plan.source),control=(await db.query('select * from teloa_work_controls where owner_id=$1 and id=$2 for share',[owner,plan.workDefinition.definitionControlId])).rows[0]
 const binding=(await db.query('select * from teloa_work_plan_bindings where owner_id=$1 and plan_id=$2 and config_version=$3',[owner,plan.id,plan.configVersion])).rows[0]
 const account=(await db.query('select policy from teloa_work_budget_accounts where owner_id=$1 and id=$2 for share',[owner,plan.workDefinition.budgetAccountId])).rows[0]
 if(!control||!controlStates.includes(control.state)||control.kind!=='definition'||control.budget_account_id!==plan.workDefinition.budgetAccountId||!binding||binding.definition_control_id!==control.id||binding.budget_account_id!==control.budget_account_id||!account||!isDeepStrictEqual(account.policy,plan.workDefinition.budget))throw denied()
 return combineWorkAccessLeases([source,ownerWorkLease(owner,plan.id),await workAccess.authorize({kind:'capability',capability:'general-agent',ownerId:owner,sessionId:plan.source.acceptedSource?.sessionId??null,objectId:plan.id,operation:'run'}),await workAccess.authorize({kind:'capability',capability:'automation',ownerId:owner,sessionId:plan.source.acceptedSource?.sessionId??null,objectId:plan.id,operation:'run'})])
}
/** 暂停、归档沿原变更回执；启用只能由本人专用入口取得新确认，普通调用不升级授权。 */
export async function changeOwnerPlan(db:PoolClient,clock:{now:()=>string},authority:OwnerPlanAuthority|undefined,owner:string,input:unknown,confirmed:boolean):Promise<PersistentPlan>{
 const v=workObject(input,['requestId','planId','expectedVersion','action',...(input&&typeof input==='object'&&Object.hasOwn(input,'note')?['note']:[])])
 if(!workUuid(v.requestId)||!workUuid(v.planId)||!Number.isSafeInteger(v.expectedVersion)||Number(v.expectedVersion)<1||!['enable','pause','archive'].includes(String(v.action))||v.note!==undefined&&(typeof v.note!=='string'||!v.note.trim()||v.note.length>4000)||v.action==='archive'&&v.note===undefined)throw denied()
 const {requestId,...spec}=v
 await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['plan-change',owner,requestId])])
 const prior=(await db.query('select * from teloa_plan_changes where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0]
 if(prior){
  if(prior.plan_id!==v.planId||!isDeepStrictEqual(prior.request_spec,spec))throw new WorkError('teloa/conflict','原本人计划操作已记录不同内容。')
  const {receiptPlan}=await import('./plans.ts'),result=receiptPlan(prior.result)
  if(result.id!==v.planId||result.ownerId!==owner||result.version!==Number(v.expectedVersion)+1||result.state!==(v.action==='enable'?'active':v.action==='pause'?'paused':'archived'))throw corrupt()
  return result
 }
 const row=(await db.query('select * from teloa_plans where owner_id=$1 and id=$2 for update',[owner,v.planId])).rows[0]
 if(!row)throw denied()
 const plan=readStoredOwnerPlan(row)
 if(plan.roleId!==null||plan.source.kind!=='method-reuse')throw denied()
 if(plan.version!==v.expectedVersion)throw new WorkError('teloa/version-conflict','原计划版本已变化，请重新核对。')
 if(plan.state==='archived'||v.action==='enable'&&plan.state!=='paused'||v.action==='pause'&&plan.state!=='active')throw new WorkError('teloa/conflict','当前计划状态不能执行此操作。')
 let lease
 if(v.action==='enable'){
  if(!confirmed||!authority)throw denied()
  const approval=await authority.authorize(owner,{requestId:v.requestId,planId:plan.id,expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,operation:'enable',source:plan.source})
  lease=combineWorkAccessLeases([approval,await verifyOwnerPlan(db,owner,plan,authority,true)])
 }
 const now=clock.now(),saved=readStoredOwnerPlan((await db.query('update teloa_plans set state=$3,version=version+1,archived_reason=$4,archived_at=$5,updated_at=$6 where owner_id=$1 and id=$2 returning *',[owner,plan.id,v.action==='enable'?'active':v.action==='pause'?'paused':'archived',v.action==='archive'?String(v.note).trim():null,v.action==='archive'?now:null,now])).rows[0])
 await db.query('insert into teloa_plan_changes(owner_id,request_id,plan_id,request_spec,result,created_at) values($1,$2,$3,$4,$5,$6)',[owner,requestId,plan.id,JSON.stringify(spec),JSON.stringify(saved),now])
 if(v.action!=='enable')revokeOwnerWorkLeases(owner,plan.id)
 lease?.assertCurrent();return saved
}
export async function configureOwnerPlan(pool:Pool,clock:{id:()=>string;now:()=>string},authority:OwnerPlanAuthority|undefined,owner:string,input:unknown):Promise<PersistentPlan>{
 const v=workObject(input,['requestId','planId','expectedVersion','expectedConfigVersion','configuration',...(input&&typeof input==='object'&&Object.hasOwn(input,'fields')?['fields']:[])])
 if(!workUuid(v.requestId)||!workUuid(v.planId)||!Number.isSafeInteger(v.expectedVersion)||!Number.isSafeInteger(v.expectedConfigVersion)||!authority)throw denied()
 const configuration=readPlanWorkConfiguration(v.configuration),db=await pool.connect()
 try{await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/plan-work/'+owner+'/'+v.requestId])
  const prior=(await db.query('select * from teloa_plan_changes where owner_id=$1 and request_id=$2',[owner,v.requestId])).rows[0]
  if(prior){if(!isDeepStrictEqual(prior.request_spec,v))throw new WorkError('teloa/conflict','原请求已保存其他定义。');const {receiptPlan}=await import('./plans.ts'),result=receiptPlan(prior.result);if(result.id!==v.planId||result.ownerId!==owner||result.version!==Number(v.expectedVersion)+1||result.configVersion!==Number(v.expectedConfigVersion)+1)throw corrupt();await db.query('commit');return result}
  const raw=(await db.query('select * from teloa_plans where owner_id=$1 and id=$2 for update',[owner,v.planId])).rows[0],plan=readStoredOwnerPlan(raw)
  if(plan.roleId!==null||plan.source.kind!=='method-reuse'||!plan.workDefinition)throw denied()
  if(plan.version!==v.expectedVersion||plan.configVersion!==v.expectedConfigVersion)throw new WorkError('teloa/version-conflict','计划版本已变化。')
  if(plan.state!=='paused'||(await db.query("select 1 from teloa_plan_occurrences o join teloa_tasks t on t.owner_id=o.owner_id and t.request_id=o.task_request_id where o.owner_id=$1 and o.plan_id=$2 and t.state not in ('completed','cancelled') limit 1",[owner,plan.id])).rowCount)throw new WorkError('teloa/conflict','请先暂停计划并结束原工作。')
  const original=readOwnerPlanFields(raw.definition),edit=v.fields===undefined?{}:workObject(v.fields,['title','goal','dataScope','delivery',...(v.fields&&typeof v.fields==='object'&&Object.hasOwn(v.fields,'groupId')?['groupId']:[])]),fields=readOwnerPlanFields({...original,...edit,completionPolicy:configuration.completion})
  assertConfiguration(fields,configuration)
  const approval=await authority.authorize(owner,{requestId:v.requestId,planId:plan.id,expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,operation:'configure',source:plan.source})
  const captured=await authority.capture(owner,{requestId:v.requestId,fields,source:plan.source,configuration,intent:'save-paused'},db)
  const sourceLease=await verifyOwnerPlan(db,owner,plan,authority,true,true),lease=combineWorkAccessLeases([approval,captured.admission]),configVersion=plan.configVersion+1,controlId=clock.id(),now=clock.now()
  sourceLease.assertCurrent()
  await db.query('update teloa_work_budget_accounts set policy=$3,version=version+1 where owner_id=$1 and id=$2',[owner,plan.workDefinition.budgetAccountId,JSON.stringify(configuration.budget)])
  await db.query("update teloa_work_controls set state='ended',generation=generation+1,version=version+1,updated_at=$3 where owner_id=$1 and id=$2",[owner,plan.workDefinition.definitionControlId,now])
  await db.query("insert into teloa_work_controls(id,owner_id,kind,root_task_id,budget_account_id,state,generation,created_at,updated_at) values($1,$2,'definition',null,$3,'active',1,$4,$4)",[controlId,owner,plan.workDefinition.budgetAccountId,now])
  const definition=readPlanWorkDefinition({schema:'teloa.plan-work/v3',definitionVersion:configVersion,definitionControlId:controlId,budgetAccountId:plan.workDefinition.budgetAccountId,authorization:{kind:'owner',grantId:plan.id,grantVersion:configVersion},...configuration})
  await db.query('insert into teloa_work_plan_bindings(owner_id,plan_id,config_version,definition_control_id,budget_account_id,created_at) values($1,$2,$3,$4,$5,$6)',[owner,plan.id,configVersion,controlId,definition.budgetAccountId,now])
  const result=readStoredOwnerPlan((await db.query('update teloa_plans set definition=$3,work_definition=$4,owner_grant=$5,version=version+1,config_version=$6,updated_at=$7 where owner_id=$1 and id=$2 returning *',[owner,plan.id,JSON.stringify(fields),JSON.stringify(definition),JSON.stringify(makeOwnerPlanGrant(plan.source,captured.policy)),configVersion,now])).rows[0])
  await db.query('insert into teloa_plan_changes(owner_id,request_id,plan_id,request_spec,result,created_at) values($1,$2,$3,$4,$5,$6)',[owner,v.requestId,plan.id,JSON.stringify(v),JSON.stringify(result),now])
  sourceLease.assertCurrent();revokeOwnerWorkLeases(owner,plan.id)
  lease.assertCurrent();await db.query('commit');return result
 }catch(error){await db.query('rollback');throw error}finally{db.release()}
}
