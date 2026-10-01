import type {Context} from '@deepseek-ai/cordis'
import {WorkError,roleContextText,type DigitalRole} from '@teloa/contract'

type Binding={id:string;ownerId:string;sessionId:string;status:'ready';purpose?:'task-run'}
type Link={kind:'role'|'task';objectId:string;conversationId:string;sessionId:string;scopeId:string|null;active:boolean}
export type RoleContextPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<Binding>
 requestedRoleId:(sessionId:string)=>Promise<string|null>
 links:(sessionId:string)=>Promise<readonly Link[]>
 role:(roleId:string)=>Promise<DigitalRole|null>
}

/** DSH rc.1 的官方异步 prompt waterfall；岗位正文只进入 runtime context，不改 tools。 */
export function registerRoleConversationContext(ctx:Context,ports:RoleContextPorts):()=>void{
 return ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{
  const result=await next(),agent=context.agent
  if(!agent||agent.session.header.origin==='subagent')return result
  const sessionId=agent.session.id
  context.signal?.throwIfAborted()
  let binding:Binding
  try{binding=await ports.conversation(sessionId)}catch(error){
   if(!(error instanceof WorkError)||error.code!=='teloa/not-bound')throw error
   if((await ports.links(sessionId)).some(link=>link.kind==='role'&&link.active))throw new WorkError('teloa/storage-corrupt','岗位关联缺少本人会话绑定。')
   return result
  }
  if(binding.ownerId!==ports.owner||binding.sessionId!==sessionId||binding.status!=='ready')throw new WorkError('teloa/forbidden','岗位会话归属无法核对。')
  if(binding.purpose==='task-run')return result
  const requestedRoleId=await ports.requestedRoleId(sessionId)
  const roleLinks=(await ports.links(sessionId)).filter(link=>link.kind==='role'&&link.active)
  context.signal?.throwIfAborted()
  if(roleLinks.length>1)throw new WorkError('teloa/storage-corrupt','同一会话存在多个岗位关联。')
  const link=roleLinks[0]
  if(!link){
   if(requestedRoleId!==null)throw new WorkError('teloa/conflict','岗位会话关联已变化，请重新选择会话。')
   return result
  }
  if(requestedRoleId!==null&&requestedRoleId!==link.objectId)throw new WorkError('teloa/conflict','岗位会话与原请求身份不一致。')
  if(link.sessionId!==sessionId||link.conversationId!==binding.id)throw new WorkError('teloa/storage-corrupt','岗位关联的会话身份不匹配。')
  const role=await ports.role(link.objectId)
  context.signal?.throwIfAborted()
  if(!role||role.ownerId!==ports.owner||role.id!==link.objectId)throw new WorkError('teloa/forbidden','当前主体不能使用该员工身份。')
  if(role.state==='retired'||link.scopeId!==null&&!role.scopes.includes(link.scopeId))throw new WorkError('teloa/conflict','员工状态或业务范围已变化，请重新核对。')
  if(result.contexts.some(row=>row.name==='teloa/role-identity')||Object.hasOwn(result.variables,'teloa_role_identity'))throw new WorkError('teloa/conflict','岗位上下文名称已被占用。')
  // 官方 renderContextSections 会对 contexts.text 做 {{name}} 插值；正文作为变量值只替换一次，保留岗位原文中的 {{...}}。
  return {...result,contexts:[...result.contexts,{name:'teloa/role-identity',text:'{{teloa_role_identity}}'}],variables:{...result.variables,teloa_role_identity:roleContextText(role)}}
 })
}
