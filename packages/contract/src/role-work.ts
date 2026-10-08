import {WorkError} from './work-error.ts'
import {roleInput,roleWriteDefinition} from './roles.ts'
import type {DigitalRole,RoleResponsibility,RoleRuntimeConfig} from './roles.ts'

/** 仅可信服务端来源绑定；内容版本独立于运行状态记账版本。 */
export type RoleWorkAuthorization={kind:'task';taskId:string;taskContentVersion:number}|{kind:'delegation';delegationId:string;delegationVersion:number}
export type TwinExecutionConsent={schema:'teloa.twin-execution-consent/v1';id:string;ownerId:string;roleId:string;roleVersion:number;version:number;authorization:RoleWorkAuthorization;state:'active'|'revoked';createdAt:string}
export type RoleWorkDelegation={id:string;ownerId:string;roleId:string;roleVersion:number;version:number;state:'active'|'pausing'|'paused'|'ending'|'ended';scope:string;allowedTools:string[];knowledgeIds:string[];memoryViewId:string|null;groupIds:string[];safeRecovery:boolean;createdAt:string;updatedAt:string}
export type RoleMemoryView={id:string;ownerId:string;roleId:string;roleVersion:number;groupId:string;version:number;entries:{memoryId:string;memoryVersion:number;contentSha256:string}[];createdAt:string}
export type RunRoleSnapshot={schema:'teloa.run-role/v2';id:string;version:number;kind:DigitalRole['kind'];name:string;scopes:string[];duty:string;dataScope:string;executionScope:string;skills:string[];knowledge:string[];responsibility:RoleResponsibility;runtimeConfig?:RoleRuntimeConfig;authorization:RoleWorkAuthorization;twinConsent:{id:string;version:number}|null}
export type WorkBudgetPolicy={maxGoalRounds:number;maxTokens:number;maxElapsedMs:number;maxConcurrent:number;maxRetries:number;stagnationRounds:number;money:{currency:string;maxMinorUnits:number}|null}

const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>0
export function readRoleWorkAuthorization(value:unknown):RoleWorkAuthorization{
 const a=roleInput(value,['kind','taskId','taskContentVersion','delegationId','delegationVersion'])
 if(a.kind==='task'&&Object.keys(a).length===3&&uuid(a.taskId)&&positive(a.taskContentVersion))return {kind:'task',taskId:a.taskId.toLowerCase(),taskContentVersion:a.taskContentVersion}
 if(a.kind==='delegation'&&Object.keys(a).length===3&&uuid(a.delegationId)&&positive(a.delegationVersion))return {kind:'delegation',delegationId:a.delegationId.toLowerCase(),delegationVersion:a.delegationVersion}
 throw new WorkError('teloa/invalid-input','工作授权身份或版本不正确。')
}
export function readRunRoleSnapshot(value:unknown):RunRoleSnapshot{
 const r=roleInput(value,['schema','id','version','kind','name','scopes','duty','dataScope','executionScope','skills','knowledge','responsibility','runtimeConfig','authorization','twinConsent'])
 if(r.schema!=='teloa.run-role/v2'||!uuid(r.id)||!positive(r.version))throw new WorkError('teloa/invalid-input','执行职责快照不正确。')
 const {schema,id,version,authorization,twinConsent,...definition}=r,role=roleWriteDefinition(definition)
 let receipt:RunRoleSnapshot['twinConsent']=null
 if(twinConsent!==null){const c=roleInput(twinConsent,['id','version']);if(!uuid(c.id)||!positive(c.version))throw new WorkError('teloa/invalid-input','分身执行回执不正确。');receipt={id:c.id,version:c.version}}
 if(role.kind==='twin'?receipt===null:receipt!==null)throw new WorkError('teloa/invalid-input','执行身份与本人授权回执不一致。')
 return {schema:'teloa.run-role/v2',id,version,kind:role.kind,name:role.name,scopes:role.scopes,duty:role.duty,dataScope:role.dataScope,executionScope:role.executionScope,skills:role.skills,knowledge:role.knowledge,responsibility:role.responsibility,...(role.runtimeConfig?{runtimeConfig:role.runtimeConfig}:{}),authorization:readRoleWorkAuthorization(authorization),twinConsent:receipt}
}
