import {WorkError,readRoleWorkAuthorization,type DigitalRole,type RoleWorkAuthorization,type RunRoleSnapshot,type TwinExecutionConsent} from '@teloa/contract'
export {readRoleWorkAuthorization,readRunRoleSnapshot} from '@teloa/contract'

export function createRunRoleSnapshot(role:DigitalRole,authorization:RoleWorkAuthorization,consent:TwinExecutionConsent|null=null,agentPresetId=role.runtimeConfig?.agentPresetId):RunRoleSnapshot{
 if(role.state!=='active'||!role.responsibility)throw new WorkError('teloa/conflict','请先确认负责角色的完整职责，再开始工作。')
 if(role.kind==='twin'&&(!consent||consent.ownerId!==role.ownerId||consent.roleId!==role.id||consent.roleVersion!==role.version||consent.state!=='active'||JSON.stringify(consent.authorization)!==JSON.stringify(authorization)))throw new WorkError('teloa/forbidden','请本人确认分身的执行范围。')
 return {schema:'teloa.run-role/v2',id:role.id,version:role.version,kind:role.kind,name:role.name,scopes:[...role.scopes],duty:role.duty,dataScope:role.dataScope,executionScope:role.executionScope,skills:[...role.skills],knowledge:[...role.knowledge],responsibility:structuredClone(role.responsibility),...(role.runtimeConfig||agentPresetId?{runtimeConfig:{...role.runtimeConfig,...(agentPresetId?{agentPresetId}:{})}}:{}),authorization:readRoleWorkAuthorization(authorization),twinConsent:consent?{id:consent.id,version:consent.version}:null}
}
