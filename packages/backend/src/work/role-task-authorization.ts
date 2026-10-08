import type {Pool,PoolClient} from 'pg'
import {WorkError,roleSupportsScope,type DigitalRole,type RoleWorkAuthorization} from '@teloa/contract'
import {assertRoleWorkRole,readStoredTwinExecutionConsent} from './twin-execution-consents.ts'
import {readStoredRoleWorkDelegation,readRoleWorkGroupGrant} from './role-delegations.ts'
import {readRoleToolGrant} from './role-tool-grants.ts'
import {RoleWorkEligibilityService} from './role-work-eligibility.ts'

/** 调用方先持有角色行锁；只读取当前本人真实委托和回执，从不创建或续签执行许可。 */
export async function readCurrentTwinDelegationAuthorization(db:PoolClient,owner:string,role:DigitalRole,scope:string,groupId:string|null=null):Promise<RoleWorkAuthorization>{
 if(role.ownerId!==owner||role.kind!=='twin'||!roleSupportsScope(role.scopes,scope))throw new WorkError('teloa/forbidden','分身不属于本人当前工作范围。')
 assertRoleWorkRole(role,role.version)
 const rows=(await db.query("select * from teloa_role_work_delegations where owner_id=$1 and role_id=$2 and role_version=$3 and state='active' for share",[owner,role.id,role.version])).rows
 if(rows.length!==1)throw new WorkError(rows.length?'teloa/storage-corrupt':'teloa/forbidden','需要当前版本唯一且明确的本人执行委托。')
 const delegation=readStoredRoleWorkDelegation(rows[0])
 if(delegation.ownerId!==owner||delegation.roleId!==role.id||delegation.roleVersion!==role.version||delegation.state!=='active'||delegation.scope!==scope||!delegation.allowedTools.length||groupId!==null&&!delegation.groupIds.includes(groupId))throw new WorkError('teloa/forbidden','分身尚未获得本次工作范围与工具的明确委托。')
 const stored=(await db.query('select * from teloa_role_tool_grants where role_id=$1 order by role_version desc limit 1 for share',[role.id])).rows[0]
 const tools=stored?readRoleToolGrant(stored):null
 if(!tools||tools.state!=='active'||tools.roleVersion>role.version||delegation.allowedTools.some(name=>!tools.rules.some(rule=>rule.name===name)))throw new WorkError('teloa/forbidden','分身委托工具已失效，请本人重新核对。')
 const authorization:RoleWorkAuthorization={kind:'delegation',delegationId:delegation.id,delegationVersion:delegation.version}
 const consentRows=(await db.query("select * from teloa_twin_execution_consents where owner_id=$1 and role_id=$2 and role_version=$3 and execution_authorization=$4::jsonb and state='active' for share",[owner,role.id,role.version,JSON.stringify(authorization)])).rows
 if(consentRows.length!==1)throw new WorkError(consentRows.length?'teloa/storage-corrupt':'teloa/forbidden','请本人明确确认分身当前执行范围。')
 const consent=readStoredTwinExecutionConsent(consentRows[0])
 if(consent.ownerId!==owner||consent.roleId!==role.id||consent.roleVersion!==role.version||consent.state!=='active'||JSON.stringify(consent.authorization)!==JSON.stringify(authorization))throw new WorkError('teloa/storage-corrupt','分身执行回执与当前委托不一致。')
 return authorization
}

/** 员工沿旧任务授权；Twin 的目标变更固定当前 delegation，不能把原 self 授权搬给分身。 */
export async function authorizeRoleTaskAssignment(db:PoolClient,pool:Pool,owner:string,role:DigitalRole,scope:string,groupId:string|null=null):Promise<{authorization:RoleWorkAuthorization|null;assertCurrent:()=>void}>{
 if(role.ownerId!==owner||role.state!=='active'||!roleSupportsScope(role.scopes,scope))throw new WorkError('teloa/conflict','需要支持该业务的在岗同事接任。')
 if(role.kind==='employee')return {authorization:null,assertCurrent(){}}
 const authorization=await readCurrentTwinDelegationAuthorization(db,owner,role,scope,groupId)
 const admission=await new RoleWorkEligibilityService(pool).authorize(owner,{roleId:role.id,expectedRoleVersion:role.version,scope,inputSchema:'teloa.task-run-input/v2',authorization,groupId},db)
 return {authorization,assertCurrent:admission.assertCurrent}
}

/** 开启群自动Run之前允许已有群 grant 为 false；真正运行仍必须再通过 requireAutoRun=true。 */
export async function authorizeTwinGroupActivation(db:PoolClient,pool:Pool,owner:string,role:DigitalRole,scope:string,groupId:string):Promise<{authorization:RoleWorkAuthorization;assertCurrent:()=>void}>{
 const authorization=await readCurrentTwinDelegationAuthorization(db,owner,role,scope,groupId)
 await readRoleWorkGroupGrant(db,owner,role,groupId,scope,false)
 const admission=await new RoleWorkEligibilityService(pool).authorize(owner,{roleId:role.id,expectedRoleVersion:role.version,scope,inputSchema:'teloa.task-run-input/v2',authorization,groupId:null},db)
 return {authorization,assertCurrent:admission.assertCurrent}
}
