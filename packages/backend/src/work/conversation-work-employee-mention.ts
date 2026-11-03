import {WorkError,roleSupportsScope,singleEmployeeMention,type DigitalRole,type EmployeeMentionReference} from '@teloa/contract'

export type EmployeeMentionPorts={
 owner:string
 role:(roleId:string)=>Promise<DigitalRole|null>
 /** 来自正常会话归属/工作上下文；不能由引用里的文本指定业务。 */
 context:(sessionId:string)=>Promise<{sessionId:string;scopeId:string;eligible:boolean;fingerprint:string;availableScopes?:readonly string[]}>
}
export type EmployeeMentionSelection={reference:EmployeeMentionReference;role:DigitalRole;sessionId:string;scopeId:string;assertCurrent:()=>Promise<void>}
const changed=()=>new WorkError('teloa/version-conflict','所选员工、版本或当前业务已变化；原文已保留，请重新选择员工。')
/** 通用入口只推导本人已获准的唯一岗位业务；明确选中的业务从不自动切换。 */
export function employeeMentionEffectiveScope(scope:string,roleScopes:readonly string[],availableScopes?:readonly string[]):string{
 if(scope!=='general'||roleScopes.includes('general')){
  if(!roleSupportsScope(roleScopes,scope))throw new WorkError('teloa/forbidden','这位员工不支持当前业务；请选择本业务的员工。')
  return scope
 }
 if(!availableScopes)throw new WorkError('teloa/forbidden','当前员工业务授权尚未核对；请先使用会话的业务选择确定范围。')
 const choices=[...new Set(roleScopes.filter(value=>value!=='general'&&availableScopes.includes(value)))]
 if(!choices.length)throw new WorkError('teloa/forbidden','这位员工当前没有本人可用的业务；请选择其他员工或核对业务访问范围。')
 if(choices.length>1)return 'general' // 沟通不要求先选业务；只有派活时补必需范围。
 return choices[0]!
}
/** 只读派发来源。选择不是委托/工具授权；正式 Task/Run 仍走既有审批与服务。 */
export async function resolveConversationEmployeeMention(ports:EmployeeMentionPorts,sessionId:string,text:string):Promise<EmployeeMentionSelection|null>{
 const reference=singleEmployeeMention(text);if(!reference)return null
 const read=async()=>{
  const context=await ports.context(sessionId),role=await ports.role(reference.roleId)
  if(context.sessionId!==sessionId||!context.eligible||typeof context.fingerprint!=='string'||!context.fingerprint)throw new WorkError('teloa/forbidden','当前会话不能切换为员工沟通，请回到原工作台会话。')
  if(!role||role.ownerId!==ports.owner||role.id!==reference.roleId||role.kind!=='employee')throw new WorkError('teloa/forbidden','所选员工不属于当前本人或已经不可用。')
  if(role.version!==reference.roleVersion)throw changed()
  if(role.state==='retired')throw new WorkError('teloa/conflict','这位员工已离职，不能接收新消息；原历史仍可查看。')
  const scopeId=employeeMentionEffectiveScope(context.scopeId,role.scopes,context.availableScopes)
  return {role,context,scopeId}
 }
 const observed=await read(),original={role:structuredClone(observed.role),context:{...observed.context},scopeId:observed.scopeId}
 return {reference,role:original.role,sessionId,scopeId:original.scopeId,assertCurrent:async()=>{
  const current=await read();if(current.scopeId!==original.scopeId||current.context.scopeId!==original.context.scopeId||current.context.fingerprint!==original.context.fingerprint||current.role.state!==original.role.state)throw changed()
 }}
}
/** 必须在正常审批完成后的真正 execute 前再次调用，不能仅在 preview 调用。 */
export async function bindEmployeeMentionDispatch(selection:EmployeeMentionSelection,input:{roleId?:string;expectedRoleVersion?:number;scope?:string;executor?:string}){
 await selection.assertCurrent()
 if(selection.role.state!=='active')throw new WorkError('teloa/conflict','这位员工已暂停；可以沟通，暂不能交办新工作。')
 if(selection.scopeId==='general'&&!selection.role.scopes.includes('general'))throw new WorkError('teloa/conflict','这位员工支持多个可用业务；请先使用会话的业务选择确定本次工作范围，原文已保留。')
 if(input.executor!==undefined||input.roleId!==undefined&&input.roleId!==selection.role.id||input.expectedRoleVersion!==undefined&&input.expectedRoleVersion!==selection.role.version||input.scope!==undefined&&input.scope!==selection.scopeId)throw new WorkError('teloa/forbidden','本轮交办须使用本人所选员工及当前业务，不能隐式换人或扩大范围。')
 return {roleId:selection.role.id,expectedRoleVersion:selection.role.version,scope:selection.scopeId}
}
/** 继续/停止旧任务只核原真实目标；@另一员工不构成转派许可。 */
export async function assertEmployeeMentionExistingTarget(selection:EmployeeMentionSelection,target:{roleId:string|null;roleVersion:number|null;scope:string},operation:'continue'|'stop'='continue'){
 await selection.assertCurrent()
 if(target.roleId!==selection.role.id||target.scope!==selection.scopeId||operation==='continue'&&target.roleVersion!==selection.role.version)throw new WorkError('teloa/conflict','原任务属于另一位员工、版本或业务；@员工不会自动转派，请先核对原任务。')
}
/** 仅固定本人原指令中的精确员工引用可覆盖本次接手偏好；业务范围与持久负责人不变。 */
export function employeeMentionOverridesPreference(input:{kind:'task'|'report';executor?:'general';scope:string;roleId?:string;expectedRoleVersion?:number;sourceText?:string},contextScope:string,available?:{role:Pick<DigitalRole,'kind'|'scopes'>;scopes:readonly string[]}):boolean{
 if(input.kind!=='task'||input.executor!==undefined||input.sourceText===undefined)return false
 const selected=singleEmployeeMention(input.sourceText)
 if(!selected||selected.roleId!==input.roleId||selected.roleVersion!==input.expectedRoleVersion)return false
 if(input.scope===contextScope){
  if(contextScope==='general'&&available?.role.kind==='employee'&&!available.role.scopes.includes('general'))throw new WorkError('teloa/conflict','员工工作需要明确业务；请使用会话的业务选择确定范围。')
  return true
 }
 return contextScope==='general'&&available?.role.kind==='employee'&&employeeMentionEffectiveScope(contextScope,available.role.scopes,available.scopes)===input.scope
}
