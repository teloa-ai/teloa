import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import {WorkError,roleContextText,type DigitalRole,type EmployeeMentionReference,type TaskToolArgumentRule} from '@teloa/contract'
import {roleAssignmentText} from './role-conversation-context.ts'
import {withEmployeeSystemPrompt} from './employee-system-prompt.ts'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {readSessionEvents} from './session-events.ts'

export type EmployeeMentionSelection={reference:EmployeeMentionReference;role:DigitalRole;sessionId:string;scopeId:string;assertCurrent:()=>Promise<void>}
export type EmployeeMentionMaterial={knowledge:string;experience:string;allowedTools:readonly string[];argumentRules:readonly TaskToolArgumentRule[];assertCurrent:()=>Promise<void>}
export type EmployeeMentionContextPorts={
 /** 只认同父原生工作会话，排除Task/Run、subagent、岗位专属和builder会话。 */
 applies:(sessionId:string)=>Promise<boolean>
 resolve:(sessionId:string,userText:string)=>Promise<EmployeeMentionSelection|null>
 /** 复用指定知识/适用经验/技能和角色grant读口，返回角色与当前actor权限交集。缺端口不能退回主助手能力。 */
 material:(selection:EmployeeMentionSelection,query:string,signal?:AbortSignal)=>Promise<EmployeeMentionMaterial>
 scopeTitle?:(scopeId:string)=>Promise<string|null>
}
const coordination=new Set(['teloa_work_dispatch','teloa_work_status','teloa_work_stop','teloa_work_resume'])
// 父会话只沟通与交接；真实执行继续原Task/Run，不在无Run的会话复制工具授权链。
function parentToolVisible(selection:EmployeeMentionSelection,name:string):boolean{
 return coordination.has(name)&&(name!=='teloa_work_dispatch'||selection.role.state==='active')||name==='teloa_tools_load'||name==='skill'&&selection.role.skills.length>0
}
const mentionSections=new Set(['teloa/employee-mention','teloa/role-identity','teloa/role-knowledge','teloa/role-experience'])
/** 只替换本来源的当前模型 surface，原审计事件与已显示答复不改写。 */
function refreshEmployeeMentionSurface(agent:Agent):void{
 const nodes=new Set(agent.session.surface.nodes)
 for(const event of readSessionEvents(agent.session)){
  if(!nodes.has(event.seq)||event.type!=='user/message'||event.data.source.kind!=='runtime-context'||event.data.source.form!=='snapshot')continue
  const sections=event.data.source.sections,marker=sections.find(section=>section.name==='teloa/employee-mention')
  if(!marker)continue
  // 普通岗位/Task 快照没有这个宿主来源标记，不能因同名 section 而清除。
  let source:unknown;try{source=JSON.parse(marker.text)}catch{continue}
  if(!source||typeof source!=='object'||Reflect.get(source,'schema')!=='teloa.employee-mention/v1'||Reflect.get(source,'boundTo')!=='current-owner-message')continue
  const retained=sections.filter(section=>!mentionSections.has(section.name))
  agent.session.append('user/message',createUserMessage({source:{kind:'runtime-context',form:'snapshot',sections:retained},content:[{type:'text',text:'Earlier employee runtime materials removed from the model surface.\n\n'+retained.map(section=>section.text).join('\n\n')}]}),{surfaceOp:{op:'replace',startSeq:event.seq,endSeq:event.seq},sourceEventSeqs:[event.seq]})
 }
}
export function employeeMentionToolAllowed(selection:EmployeeMentionSelection,_material:EmployeeMentionMaterial,name:string,args:unknown):boolean{
 if(name==='teloa_work_dispatch'){
  const input=args as {roleId?:unknown;expectedRoleVersion?:unknown;scope?:unknown;executor?:unknown}|null
  return selection.role.state==='active'&&!!input&&typeof input==='object'&&input.executor===undefined&&(input.roleId===undefined||input.roleId===selection.role.id)&&(input.expectedRoleVersion===undefined||input.expectedRoleVersion===selection.role.version)&&(input.scope===undefined||input.scope===selection.scopeId)
 }
 if(coordination.has(name)){
  const input=args as {scope?:unknown;allBusinesses?:unknown}|null
  return !!input&&typeof input==='object'&&input.allBusinesses!==true&&(input.scope===undefined||input.scope===selection.scopeId)
 } // 正常工具仍核本人权限和当前业务，继续/停止还须核原target。
 if(name==='teloa_tools_load')return true // 仅发现，不放行发现后的实际工具。
 if(name==='skill')return !!args&&typeof args==='object'&&'name'in args&&selection.role.skills.includes(String(args.name))
 return false
}
/** 同父会话的每轮真实员工来源；不改永久岗位关联、不创建Task、不自行批准工具。 */
export function registerEmployeeMentionContext(ctx:Context,ports:EmployeeMentionContextPorts){
 const texts=new Map<string,string>(),claimed=new WeakMap<Agent,{turn:number;text:string}>(),checks=new WeakMap<Agent,()=>Promise<void>>(),loaded=new WeakMap<Agent,{selection:EmployeeMentionSelection;material:EmployeeMentionMaterial}>()
 const current=async(sessionId:string)=>!texts.has(sessionId)||!await ports.applies(sessionId)?null:ports.resolve(sessionId,texts.get(sessionId)!)
 const offClaim=ctx.on('agent/inbox/claimed',({agent,message,turn})=>{
  if(agent.session.header.origin!=='subagent'&&message.source.kind==='user'){
   const text=message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'),previous=claimed.get(agent)
   const current={turn,text:previous?.turn===turn?previous.text+'\n'+text:text}
   claimed.set(agent,current);texts.set(agent.session.id,current.text);loaded.delete(agent);checks.delete(agent)
  }
 })
 const load=async(agent:Agent,signal?:AbortSignal)=>{
  const cached=loaded.get(agent)
  if(cached){signal?.throwIfAborted();await cached.selection.assertCurrent();await cached.material.assertCurrent();return cached}
  const selection=await current(agent.session.id);if(!selection)return null
  signal?.throwIfAborted();await selection.assertCurrent()
  const material=await ports.material(selection,texts.get(agent.session.id)!,signal)
  await material.assertCurrent();await selection.assertCurrent();signal?.throwIfAborted()
  const found={selection,material};loaded.set(agent,found);return found
 }
 const offContext=ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{
  const agent=context.agent
  if(!agent)return next()
  // 在下一次 prompt 读取历史之前撤回旧材料；材料已撤回而本轮准备失败时也不留旧正文。
  refreshEmployeeMentionSurface(agent)
  if(agent.session.header.origin==='subagent'||!await ports.applies(agent.session.id))return next()
  const result=await next()
  checks.delete(agent)
  const found=await load(agent,context.signal)
  if(!found)return {...result,contexts:[...result.contexts,{name:'teloa/employee-mention',text:'Current turn has no selected employee. Retain the parent conversation identity; earlier mentions are history, not this turn\'s routing or permissions.'}]}
  const {selection,material}=found,{role,scopeId}=selection
  if(result.contexts.some(row=>['teloa/employee-mention','teloa/role-identity','teloa/role-knowledge','teloa/role-experience'].includes(row.name))||['teloa_employee_mention','teloa_employee_identity','teloa_employee_knowledge','teloa_employee_experience'].some(name=>Object.hasOwn(result.variables,name)))throw new WorkError('teloa/conflict','员工上下文来源重叠，请核对原会话，不能覆盖另一员工。')
  const methods=await roleAssignmentText(agent,role,scopeId,ports.scopeTitle,context.signal)
  const check=async()=>{await selection.assertCurrent();await material.assertCurrent()};await check();checks.set(agent,check)
  const selected=withEmployeeSystemPrompt(result,'employee')
  const identity=roleContextText(role)+(methods?'\n\n'+methods:'')
  return {...selected,tools:selected.tools.filter(tool=>parentToolVisible(selection,tool.name)),contexts:[...selected.contexts,
   {name:'teloa/employee-mention',text:'{{teloa_employee_mention}}'},
   {name:'teloa/role-identity',text:'{{teloa_employee_identity}}'},
   {name:'teloa/role-knowledge',text:'{{teloa_employee_knowledge}}'},
   {name:'teloa/role-experience',text:'{{teloa_employee_experience}}'}],variables:{...selected.variables,
    teloa_employee_mention:JSON.stringify({schema:'teloa.employee-mention/v1',roleId:role.id,roleVersion:role.version,name:role.name,scopeId,state:role.state,boundTo:'current-owner-message',instruction:'Answer as the verified selected employee in this parent conversation, using only the supplied authorized role knowledge and experience. This parent supports conversation, bound-skill/tool discovery and verified work handoff only. Actual files, code, connector, HTTP and native execution must use normal teloa_work_dispatch approval and a distinct Task/Run child; return progress, approvals and results to this parent. Discovery is not execution permission. Never claim a discovered tool ran. A mention grants no tools, delegation or role editing. Do not silently reassign an existing task. Display readable employee names, not internal reference markers.'}),
    teloa_employee_identity:identity,teloa_employee_knowledge:material.knowledge,teloa_employee_experience:material.experience}}
 })
 const offStream=ctx.on('llm/stream',async function*(options,next){const agent=options.sessionId?ctx.agents.get(options.sessionId):undefined;if(agent)await checks.get(agent)?.();options.signal?.throwIfAborted();yield* next()},{global:true})
 const assertTool=async(exec:{agent?:Agent|undefined;name:string;arguments:unknown;signal:AbortSignal})=>{
  if(!exec.agent)return
  const found=await load(exec.agent,exec.signal);if(!found)return
  const {selection,material}=found
  if(!employeeMentionToolAllowed(selection,material,exec.name,exec.arguments))throw new WorkError('teloa/forbidden','当前员工会话仅支持沟通、发现与正常工作交接；文件、代码、连接器及其他实际执行请通过交办建立独立任务，@员工不会扩大权限。')
 }
 const offPre=ctx.on('tools/pre-execute',async(exec,next)=>{try{await assertTool(exec)}catch(error){return {kind:'deny' as const,reason:error instanceof Error?error.message:'员工权限暂不可核对。'}}return next()},{global:true,prepend:true})
 const offExecute=ctx.on('tools/execute',async(exec,next)=>{await assertTool(exec);return next()},{global:true,prepend:true})
 return {current,dispose:()=>{offClaim();offContext();offStream();offPre();offExecute();texts.clear()}}
}
