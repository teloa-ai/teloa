import type {PoolClient} from 'pg'
import {WorkError,groupDefinition,taskInput,type DigitalRole} from '@teloa/contract'
import {readGroupAgentGrant} from './group-agent-grants.ts'

export type PlanGroupReport={groupId:string;groupVersion:number;grantVersion:number}
export function readPlanGroupReport(value:unknown):PlanGroupReport{
 const row=taskInput(value,['groupId','groupVersion','grantVersion'])
 if(typeof row.groupId!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.groupId)||![row.groupVersion,row.grantVersion].every(v=>Number.isSafeInteger(v)&&Number(v)>0))throw new WorkError('teloa/storage-corrupt','计划汇报群的固定权限记录损坏。')
 return {groupId:row.groupId,groupVersion:Number(row.groupVersion),grantVersion:Number(row.grantVersion)}
}

/** 汇报目标只授权发布本轮成果，不读取群历史，也不增加员工的数据或工具权限。 */
export async function authorizePlanGroupReport(db:PoolClient,owner:string,groupId:string|undefined|null,role:DigitalRole,scope:string,expected?:PlanGroupReport):Promise<PlanGroupReport|undefined>{
 if(!groupId)return undefined
 const group=(await db.query('select * from teloa_groups where id=$1 and owner_id=$2 for share',[groupId,owner])).rows[0]
 if(!group||group.archived||role.state!=='active')throw new WorkError('teloa/forbidden','汇报群或负责员工当前不可用。')
 const definition=groupDefinition(group.definition)
 if(definition.scope!=='general'&&definition.scope!==scope)throw new WorkError('teloa/forbidden','汇报群不支持本计划的业务范围。')
 if(!(await db.query('select 1 from teloa_group_members where group_id=$1 and owner_id=$2 and role_id=$3 for share',[groupId,owner,role.id])).rowCount)throw new WorkError('teloa/forbidden','负责员工不再是汇报群成员。')
 const stored=(await db.query('select * from teloa_group_agent_grants where group_id=$1 and role_id=$2 and owner_id=$3 order by grant_version desc limit 1 for share',[groupId,role.id,owner])).rows[0]
 if(!stored)throw new WorkError('teloa/forbidden','负责员工没有汇报群的发言许可。')
 const grant=readGroupAgentGrant(stored)
 if(grant.state!=='active'||!grant.canPost)throw new WorkError('teloa/forbidden','负责员工没有汇报群的发言许可。')
 if(grant.groupVersion!==group.version||grant.roleVersion!==role.version)throw new WorkError('teloa/version-conflict','汇报群的原权限已变化，请重新核对。')
 const current={groupId,groupVersion:grant.groupVersion,grantVersion:grant.grantVersion}
 if(expected&&JSON.stringify(current)!==JSON.stringify(expected))throw new WorkError('teloa/version-conflict','本次计划的汇报权限已变化，原结果保留但不发布。')
 return current
}
