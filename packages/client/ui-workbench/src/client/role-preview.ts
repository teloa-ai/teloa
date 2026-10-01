import type { CollaborationScope } from './collaboration-preview.js'
import type {TeloaTranslate} from './i18n/index.js'
import {roleSupportsScope,type RoleRuntimeConfig} from '@teloa/contract'
export type {RoleRuntimeConfig} from '@teloa/contract'

export const roleStates={active:'role.state.active',paused:'role.state.paused',retired:'role.state.retired'} as const
export type RoleMemory={id:string;title:string;text:string;source:string;scope:'role'|'private';status:'candidate'|'confirmed'|'withdrawn';version:number;createdAt:string;updatedAt:string}
export type RoleResponsibility={triggers:string[];autonomousActions:string[];confirmationPoints:string[];escalationRules:string[];deliveryChecks:string[]}
export type PreviewRole={storage?:'persistent';id:string;name:string;kind:'employee'|'twin';scopes:CollaborationScope[];state:keyof typeof roleStates;version:number;duty:string;dataScope:string;executionScope:string;skills:string[];knowledge:string[];responsibility?:RoleResponsibility;runtimeConfig?:RoleRuntimeConfig;memories:RoleMemory[];history:{text:string;actorId:string;at:string}[];draft?:{body:string;version:number;editorId:string;updatedAt:string};retirementReason?:string}
export type RoleFields=Pick<PreviewRole,'name'|'kind'|'scopes'|'duty'|'dataScope'|'executionScope'|'skills'|'knowledge'|'responsibility'|'runtimeConfig'>
export type TeamChange=(
  |{type:'create';id:string;fields:RoleFields}
  |({type:'edit';roleId:string;expectedVersion:number}&Omit<RoleFields,'kind'>)
  |{type:'lifecycle';roleId:string;expectedVersion:number;action:'pause'|'resume'|'retire';reason:string}
  |{type:'assign';roleId:string;id:string;title:string;goal:string;scope:CollaborationScope}
  |{type:'memory-add';roleId:string;id:string;title:string;text:string;source:string}
  |{type:'memory-decide';roleId:string;memoryId:string;expectedVersion:number;action:'confirm'|'withdraw'}
  |{type:'draft';roleId:string;expectedVersion:number;body:string}
)&{now:string}

export const canReceiveTask=(role:PreviewRole|undefined,scope:CollaborationScope)=>!!role&&role.kind==='employee'&&role.state==='active'&&roleSupportsScope(role.scopes,scope)
export const roleName=(roles:readonly Pick<PreviewRole,'id'|'name'>[],id:string,t?:TeloaTranslate)=>id==='self'?(t?t('role.preview.self'):'我'):roles.find(role=>role.id===id)?.name||(t?t('role.preview.formerMember'):'历史成员')
export const rolePeople=(roles:readonly PreviewRole[],t?:TeloaTranslate)=>[{id:'self',name:t?t('role.preview.self'):'我',kind:'human' as const,state:'active' as const},...roles.map(role=>({id:role.id,name:role.name,kind:role.kind==='twin'?'draft' as const:'digital' as const,state:role.state}))]

export function withRoleExamples(roles:PreviewRole[],now:string):PreviewRole[]{
  const samples:{id:string;name:string;scope:CollaborationScope;duty:string;skills:string[];knowledge:string[];kind?:'twin';retired?:boolean}[]=[
    {id:'researcher',name:'研究助理',scope:'general',duty:'整理明确提供的资料，核对来源与版本，形成可审阅的建议。',skills:['资料整理','来源核验','报告撰写'],knowledge:['团队协作约定']},
    {id:'investigator',name:'调查岗',scope:'SOC',duty:'关联告警、核验证据、形成调查建议；资料缺失和高风险处置回流本人。',skills:['告警调查','证据核验','调查报告'],knowledge:['SOC 调查手册','资产与告警词典']},
    {id:'reviewer',name:'安全复核岗',scope:'SOC',duty:'独立检查证据来源、时效与结论缺口，必要时接续同业务调查。',skills:['证据复核','判据检查'],knowledge:['判据库','历史复核样本']},
    {id:'appsec',name:'应用安全审计岗',scope:'AppSec',duty:'核对指定提交中的代码与依赖风险，提供位置、依据和修复建议。',skills:['代码审计','依赖风险检查'],knowledge:['研发安全规范']},
    {id:'designer',name:'设计助理',scope:'general',duty:'按 Brief 和获准素材制作候选稿，保留版本并交付审阅。',skills:['品牌核对','稿件审阅'],knowledge:['品牌规范','当前需求 Brief']},
    {id:'twin',name:'我的分身',scope:'general',kind:'twin',duty:'按本人确认的偏好整理资料、代拟回复和判断建议。正式批准由本人完成。',skills:['交班代拟','判断建议'],knowledge:['本人明确提供的工作偏好']},
    {id:'retired-researcher',name:'原研究岗',scope:'general',retired:true,duty:'保留原研究工作与来源，后续工作由接任员工继续。',skills:['来源核验'],knowledge:['历史研究记录']},
  ]
  const added=samples.filter(sample=>!roles.some(role=>role.id===sample.id)).map((sample):PreviewRole=>({id:sample.id,name:sample.name,kind:sample.kind||'employee',scopes:[sample.scope],state:sample.retired?'retired':'active',version:1,duty:sample.duty,dataScope:sample.kind==='twin'?'本人可见且明确提供的资料；私人偏好不自动共享。':'仅分配给这位员工的工作项、资料与关联证据。',executionScope:sample.kind==='twin'?'仅代拟；不能代批、冒充本人或直接外发。':'获准范围内查询、核验与代拟。外发、改判和生产写操作分别授权。',skills:sample.skills,knowledge:sample.knowledge,memories:[],history:[{text:'载入同事界面示例',actorId:'self',at:now}],...(sample.retired?{retirementReason:'历史示例员工已退役，保留原身份。'}:{})}))
  return [...roles,...added]
}
