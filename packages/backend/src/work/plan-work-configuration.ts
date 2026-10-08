import {isDeepStrictEqual} from 'node:util'
import type {PoolClient,Pool} from 'pg'
import {WorkError,taskDefinition,type RoleWorkAuthorization} from '@teloa/contract'
import {readPlanWorkConfiguration,readPlanWorkDefinition} from '@teloa/contract'
import {workObject,workUuid} from '@teloa/contract'
import {readStoredPlan,receiptPlan,type PersistentPlan} from './plans.ts'
import {readStoredRole} from './roles.ts'
import {readStoredRoleWorkDelegation} from './role-delegations.ts'
import {RoleWorkEligibilityService} from './role-work-eligibility.ts'
import {authorizeOwnerWork,type OwnerWorkAuthority} from './twin-execution-consents.ts'

/** 由原 PlanService 的本人专用入口调用；授权及控制身份全部来自真实服务端记录。 */
export async function configurePlanWork(pool:Pool,clock:{id:()=>string;now:()=>string},authority:OwnerWorkAuthority|undefined,owner:string,input:unknown):Promise<PersistentPlan>{
 const v=workObject(input,['requestId','planId','expectedVersion','expectedConfigVersion','configuration',...(input&&typeof input==='object'&&Object.hasOwn(input,'fields')?['fields']:[])]),configuration=readPlanWorkConfiguration(v.configuration)
 const edit=v.fields===undefined?undefined:workObject(v.fields,['title','goal','dataScope','delivery'])
 if(edit){taskDefinition({title:edit.title,goal:edit.goal,scope:'general'});for(const key of ['dataScope','delivery'])if(typeof edit[key]!=='string'||!edit[key].trim()||edit[key].length>8000)throw new WorkError('teloa/invalid-input','长期工作目标或交付字段不正确。')}
 if(!workUuid(v.requestId)||!workUuid(v.planId)||!Number.isSafeInteger(v.expectedVersion)||Number(v.expectedVersion)<1||!Number.isSafeInteger(v.expectedConfigVersion)||Number(v.expectedConfigVersion)<1||!authority||!owner.trim())throw new WorkError('teloa/forbidden','请本人确认长期工作定义。')
 if(configuration.budget.money!==null)throw new WorkError('teloa/invalid-input','当前没有可靠金额计价，请使用轮次和 token 上限。')
 const db=await pool.connect()
 try{await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/plan-work/'+owner+'/'+v.requestId])
  const prior=(await db.query('select * from teloa_plan_changes where owner_id=$1 and request_id=$2',[owner,v.requestId])).rows[0]
  if(prior){if(!isDeepStrictEqual(prior.request_spec,v))throw new WorkError('teloa/conflict','原长期定义请求已保存其他设置。');const result=receiptPlan(prior.result);if(result.id!==v.planId||result.ownerId!==owner||result.version!==Number(v.expectedVersion)+1||result.configVersion!==Number(v.expectedConfigVersion)+1||!result.workDefinition||edit&&Object.entries(edit).some(([key,value])=>result[key as 'title']!==(value as string).trim())||!isDeepStrictEqual(readPlanWorkConfiguration({completion:result.workDefinition.completion,triggers:result.workDefinition.triggers,budget:result.workDefinition.budget,overlap:result.workDefinition.overlap,missed:result.workDefinition.missed,safeRecovery:result.workDefinition.safeRecovery}),configuration))throw new WorkError('teloa/storage-corrupt','长期定义回执不匹配。');await db.query('commit');return result}
  const observed=(await db.query('select * from teloa_plans where owner_id=$1 and id=$2',[owner,v.planId])).rows[0];if(!observed)throw new WorkError('teloa/forbidden','计划不存在或不属于本人。')
  const role=readStoredRole((await db.query('select * from teloa_roles where owner_id=$1 and id=$2 for share',[owner,observed.role_id])).rows[0]),plan=readStoredPlan((await db.query('select * from teloa_plans where owner_id=$1 and id=$2 for update',[owner,v.planId])).rows[0])
  if(plan.version!==v.expectedVersion||plan.configVersion!==v.expectedConfigVersion)throw new WorkError('teloa/version-conflict','计划版本已变化，请重新核对。')
  if(plan.state!=='paused'||plan.source.kind==='system-digest')throw new WorkError('teloa/conflict','请先暂停原计划并完成当前工作，再配置长期定义。')
  if((await db.query("select 1 from teloa_plan_occurrences o left join teloa_tasks t on t.owner_id=o.owner_id and t.request_id=o.task_request_id where o.owner_id=$1 and o.plan_id=$2 and (t.id is not null and t.state not in ('completed','cancelled')) limit 1",[owner,plan.id])).rowCount)throw new WorkError('teloa/conflict','当前计划仍有未结束的工作。')
  const rows=(await db.query("select * from teloa_role_work_delegations where owner_id=$1 and role_id=$2 and role_version=$3 and state='active' for share",[owner,role.id,role.version])).rows
  if(rows.length!==1)throw new WorkError('teloa/forbidden','长期工作需要当前角色版本唯一且明确的本人委托。')
  const delegation=readStoredRoleWorkDelegation(rows[0]),authorization:RoleWorkAuthorization={kind:'delegation',delegationId:delegation.id,delegationVersion:delegation.version}
  if(!delegation.allowedTools.length||configuration.safeRecovery&&!delegation.safeRecovery)throw new WorkError('teloa/forbidden','请先确认所需工具与安全恢复的委托范围。')
  const admission=await new RoleWorkEligibilityService(pool).authorize(owner,{roleId:role.id,expectedRoleVersion:role.version,scope:plan.scope,inputSchema:'teloa.task-run-input/v2',authorization,groupId:null},db)
  for(const trigger of configuration.triggers){
   if(trigger.kind==='schedule'){if(!isDeepStrictEqual(trigger.schedule,plan.trigger))throw new WorkError('teloa/invalid-input','长期定义时间必须与原计划日程一致。');continue}
   if(trigger.eventKind==='material-version'){if(!delegation.knowledgeIds.includes(trigger.sourceId)||!(await db.query("select 1 from teloa_resources where owner_id=$1 and id=$2 and status='active'",[owner,trigger.sourceId])).rowCount)throw new WorkError('teloa/forbidden','资料事件未包含在本人当前委托中。')}
   else if(trigger.eventKind==='group-message'){if(!delegation.groupIds.includes(trigger.sourceId))throw new WorkError('teloa/forbidden','群事件未包含在本人委托中。');await new RoleWorkEligibilityService(pool).authorize(owner,{roleId:role.id,expectedRoleVersion:role.version,scope:plan.scope,inputSchema:'teloa.task-run-input/v2',authorization,groupId:trigger.sourceId},db)}
   else if(trigger.eventKind==='child-completed'){if(!(await db.query('select 1 from teloa_task_runs where owner_id=$1 and id=$2 and role_id=$3',[owner,trigger.sourceId,role.id])).rowCount)throw new WorkError('teloa/forbidden','子工作来源不属于当前负责角色。')}
   else if(!(await db.query('select 1 from teloa_security_actions a join teloa_tasks t on t.id=a.task_id and t.owner_id=a.owner_id where a.owner_id=$1 and a.id=$2 and t.assignee_role_id=$3',[owner,trigger.sourceId,role.id])).rowCount)throw new WorkError('teloa/forbidden','审批来源不属于当前负责角色。')
  }
  const oldBinding=(await db.query('select * from teloa_work_plan_bindings where owner_id=$1 and plan_id=$2 and config_version=$3',[owner,plan.id,plan.configVersion])).rows[0]
  if(plan.workDefinition&&(!oldBinding||oldBinding.definition_control_id!==plan.workDefinition.definitionControlId||oldBinding.budget_account_id!==plan.workDefinition.budgetAccountId))throw new WorkError('teloa/storage-corrupt','长期定义控制或累计额度绑定损坏。')
  const lease=await authorizeOwnerWork(authority,owner,{requestId:v.requestId,roleId:role.id,operation:'confirm'}),now=clock.now(),configVersion=plan.configVersion+1,controlId=clock.id(),budgetId=oldBinding?.budget_account_id??clock.id()
  // 原日程首次升级也保留累计账户，不借新定义版本清空已经消耗的额度。
  if(oldBinding){await db.query('update teloa_work_budget_accounts set policy=$3,version=version+1 where owner_id=$1 and id=$2',[owner,budgetId,JSON.stringify(configuration.budget)]);await db.query("update teloa_work_controls set state='ended',generation=generation+1,version=version+1,updated_at=$3 where owner_id=$1 and id=$2",[owner,oldBinding.definition_control_id,now])}
  else await db.query('insert into teloa_work_budget_accounts(id,owner_id,policy,created_at) values($1,$2,$3,$4)',[budgetId,owner,JSON.stringify(configuration.budget),now])
  await db.query("insert into teloa_work_controls(id,owner_id,kind,root_task_id,budget_account_id,state,generation,created_at,updated_at) values($1,$2,'definition',null,$3,'active',1,$4,$4)",[controlId,owner,budgetId,now])
  await db.query('insert into teloa_work_plan_bindings(owner_id,plan_id,config_version,definition_control_id,budget_account_id,created_at) values($1,$2,$3,$4,$5,$6)',[owner,plan.id,configVersion,controlId,budgetId,now])
  const workDefinition=readPlanWorkDefinition({schema:'teloa.plan-work/v2',definitionVersion:configVersion,definitionControlId:controlId,budgetAccountId:budgetId,authorization,...configuration})
  const edited=edit?Object.fromEntries(Object.entries(edit).map(([key,value])=>[key,(value as string).trim()])):{}
  const saved=readStoredPlan((await db.query('update teloa_plans set work_definition=$3,definition=jsonb_set(definition||$8::jsonb,\'{completionPolicy}\',$4::jsonb),version=version+1,config_version=$5,role_version=$6,updated_at=$7 where owner_id=$1 and id=$2 returning *',[owner,plan.id,JSON.stringify(workDefinition),JSON.stringify(configuration.completion),configVersion,role.version,now,JSON.stringify(edited)])).rows[0])
  await db.query('insert into teloa_plan_changes(owner_id,request_id,plan_id,request_spec,result,created_at) values($1,$2,$3,$4,$5,$6)',[owner,v.requestId,plan.id,JSON.stringify(v),JSON.stringify(saved),now])
  lease.assertCurrent();admission.assertCurrent();await db.query('commit');return saved
 }catch(error){await db.query('rollback');throw error}finally{db.release()}
}
