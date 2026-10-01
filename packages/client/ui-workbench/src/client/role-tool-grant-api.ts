import {taskInput,readTaskToolArgumentRules,type TaskToolArgumentRule} from '@teloa/contract'
import type {RoleRequestJournal} from './role-api.ts'
import {isSkillHttpRule,isSubagentDelegationRule,skillHttpToolName,type SkillHttpGrantCandidate,type SubagentDelegationLimits} from './role-tool-grant-presentation.ts'
import {recoveryStorageError} from './recovery-error.ts'
type Command={roleId:string;expectedRoleVersion:number;action:'save'|'revoke';rules:TaskToolArgumentRule[]}
export type Grant={roleId:string;roleVersion:number;state:'active'|'revoked';rules:TaskToolArgumentRule[];createdAt:string}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v)
const version=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>0
const httpsOrigin=(v:unknown):v is string=>{if(typeof v!=='string')return false;try{const url=new URL(v);return url.protocol==='https:'&&url.origin===v}catch{return false}}
/** 技能代发候选的展示信息：技能名、来源（岗位 / 行业职责）、目录声明的 https origin、可选的是否已保存密钥；多余字段或形状不对一律拒收。 */
function skillHttpCandidates(value:unknown):SkillHttpGrantCandidate[]{
 if(!Array.isArray(value)||!value.length)throw Error()
 return value.map(item=>{const r=taskInput(item,['skill','origins','configured','source']);if(typeof r.skill!=='string'||!/^[a-z][a-z0-9-]{0,63}$/.test(r.skill)||!Array.isArray(r.origins)||!r.origins.length||!r.origins.every(httpsOrigin)||r.configured!==undefined&&typeof r.configured!=='boolean'||r.source!=='role'&&r.source!=='industry')throw Error();return {skill:r.skill,origins:[...r.origins as string[]],...(r.configured===undefined?{}:{configured:r.configured as boolean}),source:r.source}})
}
function command(value:unknown):Command{const r=taskInput(value,['roleId','expectedRoleVersion','action','rules']);if(!uuid(r.roleId)||!version(r.expectedRoleVersion)||r.action!=='save'&&r.action!=='revoke')throw Error('授权请求格式不正确。');const rules=readTaskToolArgumentRules(r.rules);if(r.action==='revoke'&&rules.length||r.action==='save'&&!rules.length)throw Error('授权范围不正确。');return {roleId:r.roleId,expectedRoleVersion:r.expectedRoleVersion,action:r.action,rules}}
function grant(value:unknown):Grant{const r=taskInput(value,['roleId','roleVersion','state','rules','createdAt']);if(!uuid(r.roleId)||!version(r.roleVersion)||r.state!=='active'&&r.state!=='revoked'||typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt)))throw Error('授权回执不正确。');const rules=readTaskToolArgumentRules(r.rules);if(r.state==='revoked'&&rules.length)throw Error('撤销回执仍含授权。');return {roleId:r.roleId,roleVersion:r.roleVersion,state:r.state,rules,createdAt:r.createdAt}}
export type RoleToolGrantApi=ReturnType<typeof createRoleToolGrantApi>
export function createRoleToolGrantApi(call:(endpoint:string,payload:unknown)=>Promise<unknown>,journal:RoleRequestJournal){
 let pending:Command|undefined,error:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{const raw=journal.read();if(raw){const r=taskInput(JSON.parse(raw),['schema','request']);if(r.schema!=='teloa.role-tools/v1')throw Error();pending=command(r.request)}}catch{error=recoveryStorageError()}
 const send=async()=>{
  if(error)throw error;if(busy||!pending)throw Error('没有可核对的授权请求，或正在保存。');busy=true
  try{
   journal.write(JSON.stringify({schema:'teloa.role-tools/v1',request:pending}))
   const result=grant(await call('role-tools/change',pending))
   if(result.roleId!==pending.roleId||result.roleVersion!==pending.expectedRoleVersion+1||result.state!==(pending.action==='save'?'active':'revoked')||JSON.stringify(result.rules)!==JSON.stringify(pending.rules))throw Error('授权结果与原请求不一致。')
   journal.clear();pending=undefined;return result
  }catch(e){if(e&&typeof e==='object'&&'rejected'in e&&e.rejected===true&&'code'in e&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String(e.code))){journal.clear();pending=undefined}throw e}finally{busy=false}
 }
 return {pending:()=>pending?command(pending):undefined,recoveryMessage:()=>error,
  /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discard(){const had=pending!==undefined||error!==undefined;try{journal.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;error=undefined;return had},
  recover:send,
  async change(value:Command){if(error)throw error;const next=command(value);if(pending&&JSON.stringify(next)!==JSON.stringify(pending))throw Error('请先核对未完成授权。');pending??=next;return send()},
  async get(roleId:string){const r=taskInput(await call('role-tools/get',{roleId}),['roleVersion','grant']);if(!version(r.roleVersion))throw Error('员工版本不正确。');const g=r.grant===null?null:grant(r.grant);if(g&&(g.roleId!==roleId||g.roleVersion>r.roleVersion))throw Error('员工授权身份不一致。');return {roleVersion:r.roleVersion,grant:g}},
  async candidates(roleId:string){
   const r=taskInput(await call('role-tools/candidates',{roleId}),['roleVersion','rules','delegation','skillHttp'])
   if(!version(r.roleVersion))throw Error('员工版本不正确。')
   const rules=readTaskToolArgumentRules(r.rules),delegationRule=rules.find(isSubagentDelegationRule)
   let delegation:SubagentDelegationLimits|undefined
   if(r.delegation!==undefined){
    const limits=taskInput(r.delegation,['maxDepth','maxPerRun'])
    if(!Number.isSafeInteger(limits.maxDepth)||(limits.maxDepth as number)<0||!version(limits.maxPerRun))throw Error('任务拆分限额格式不正确。')
    delegation={maxDepth:limits.maxDepth as number,maxPerRun:limits.maxPerRun as number}
   }
   // 限额没有随候选一同到达时，不能把整工具授权渲染成可保存选项，避免给本人展示一项无法解释的权限。
   if((delegationRule!==undefined)!==(delegation!==undefined)||rules.some(rule=>rule.name==='subagent_task'&&!isSubagentDelegationRule(rule)))throw Error('任务拆分授权候选格式不正确。')
   // 技能代发：逐技能规则与展示信息必须逐项一一对应（同序、不重复），否则不能把一项看不清对象的权限渲染成可保存选项。
   let skillHttp:SkillHttpGrantCandidate[]|undefined
   try{if(r.skillHttp!==undefined)skillHttp=skillHttpCandidates(r.skillHttp)}catch{throw Error('技能接口代发授权候选格式不正确。')}
   const skillHttpRule=rules.find(rule=>rule.name===skillHttpToolName)
   const listed=skillHttp?.map(item=>item.skill)??[],allowed=skillHttpRule?.allowed.map(args=>args.skill)??[]
   if((skillHttpRule!==undefined)!==(skillHttp!==undefined)||skillHttpRule&&!isSkillHttpRule(skillHttpRule)||new Set(listed).size!==listed.length||JSON.stringify(listed)!==JSON.stringify(allowed))throw Error('技能接口代发授权候选格式不正确。')
   return {roleVersion:r.roleVersion,rules,...(delegation===undefined?{}:{delegation}),...(skillHttp===undefined?{}:{skillHttp})}
  }
 }
}
