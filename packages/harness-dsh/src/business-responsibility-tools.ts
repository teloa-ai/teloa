import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type ToolExecution,type ParameterSchemaSpec} from '@deepseek-ai/dsh-tools'
import {WorkError,taskInput,roleSupportsScope,readBusinessResponsibility,readBusinessResponsibilitySet,type DigitalRole,type BusinessResponsibilitySet} from '@teloa/contract'
import {authorizeBusinessConversation,type BusinessConversationAuthorizationPorts} from './business-conversation-authorization.ts'
import {readConversationInstructionIdentity} from './conversation-instruction-identity.ts'
import {readBusinessResponsibilityResult,type BusinessResponsibilityServices} from './business-responsibility.ts'
export const businessResponsibilityToolNames=['teloa_business_responsibility_read','teloa_business_responsibility_set'] as const
export type BusinessResponsibilityToolsPorts=BusinessConversationAuthorizationPorts&{
 responsibility:BusinessResponsibilityServices['responsibility']
 roles:(owner:string)=>Promise<DigitalRole[]>
}
const [read,set]=businessResponsibilityToolNames,names=new Set<string>(businessResponsibilityToolNames)
const originalNotice='这是完整原请求的固定结果，不代表负责人当前可执行；当前岗位状态请另读 current。空回执不能证明没有在途请求，不能换指令重复设置。'
const invalid=()=>new WorkError('teloa/invalid-input','负责人工具参数不正确；请先读取当前负责人及真实员工目录。')
const bad=()=>new WorkError('teloa/invalid-host-response','业务负责人或员工目录身份不一致。')
function json(value:unknown,max=262144){const body=JSON.stringify(value);if(Buffer.byteLength(body)>max)throw new WorkError('teloa/invalid-input','业务负责人内容超过大小上限，请缩小读取范围。');return body}
function fixedRequest(owner:string,instruction:ReturnType<typeof readConversationInstructionIdentity>){const h=createHash('sha256').update(JSON.stringify(['teloa.business-responsibility-set/v1',owner,instruction.sessionId,instruction.messageId,instruction.seq])).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`}
function input(args:unknown,scope:string,requestId:string){const row=taskInput(args,['expectedVersion','role']);return readBusinessResponsibilitySet({...row,scope,requestId})}
function query(args:unknown,scope:string){
 const row=taskInput(args,['mode','cursor','request'])
 if(row.mode===undefined||row.mode==='current'){
  taskInput(args,['mode','cursor']);if(row.cursor!==undefined&&(!Number.isSafeInteger(row.cursor)||Number(row.cursor)<0))throw invalid()
  return {mode:'current',cursor:row.cursor===undefined?0:Number(row.cursor)} as const
 }
 if(row.mode!=='receipt')throw invalid()
 taskInput(args,['mode','request']);const original=taskInput(row.request,['requestId','expectedVersion','role'])
 return {mode:'receipt',request:readBusinessResponsibilitySet({...original,scope})} as const
}
/** 只管理业务关联；没有Task/Run/派发端口，不改变会话接手偏好。 */
export function registerBusinessResponsibilityTools(ctx:Context,ports:BusinessResponsibilityToolsPorts){
 const authorize=async(exec:Pick<ToolExecution,'agent'|'signal'>)=>({...await authorizeBusinessConversation(ports,exec,'业务负责人'),instruction:readConversationInstructionIdentity(exec.agent!)})
 type Authorized=Awaited<ReturnType<typeof authorize>>
 const same=(a:Authorized,b:Authorized)=>{if(a.fingerprint!==b.fingerprint||JSON.stringify(a.instruction)!==JSON.stringify(b.instruction))throw new WorkError('teloa/conflict','确认期间本人指令或当前业务归属已变化，请重新读取。')}
 const roles=async(current:Authorized)=>{
  const rows=await ports.roles(ports.owner)
  if(!Array.isArray(rows)||new Set(rows.map(row=>row.id)).size!==rows.length)throw bad()
  return rows.filter(row=>{
   if(row.ownerId!==ports.owner||typeof row.id!=='string'||typeof row.name!=='string'||!row.name.trim()||!Number.isSafeInteger(row.version)||row.version<1||!['employee','twin'].includes(row.kind)||!['active','paused','retired'].includes(row.state)||!Array.isArray(row.scopes))throw bad()
   return row.kind==='employee'
  }).map(row=>({id:row.id,name:row.name,version:row.version,state:row.state,supportsScope:roleSupportsScope(row.scopes,current.scope)}))
 }
 const receipt=async(current:Authorized,request:BusinessResponsibilitySet)=>{
  const value=await ports.responsibility.receipt(current.actor,request)
  return value===null?null:readBusinessResponsibilityResult(value,request)
 }
 const prepare=async(current:Authorized,request:BusinessResponsibilitySet)=>{
  const prior=await receipt(current,request)
  if(prior!==null)return {replay:true as const,result:prior}
  const [value,choices]=await Promise.all([ports.responsibility.read(current.actor,{scope:current.scope}),roles(current)])
  const before=readBusinessResponsibility(value,current.scope)
  if(before.version!==request.expectedVersion)throw new WorkError('teloa/version-conflict','业务负责人已变化，请重新读取。')
  const selected=request.role?choices.find(role=>role.id===request.role!.id):null
  if(request.role){
   if(!selected||!selected.supportsScope)throw new WorkError('teloa/forbidden','选定员工不存在或不支持当前业务。')
   if(selected.version!==request.role.expectedVersion)throw new WorkError('teloa/version-conflict','选定员工版本已变化，请重新核对。')
   if(selected.state!=='active')throw new WorkError('teloa/conflict','选定员工已暂停或退役，不能设置为负责人。')
  }
  const previous=before.roleId?choices.find(role=>role.id===before.roleId):null
  const summary={business:current.title,before:{...before,...(previous?{name:previous.name}:{})},after:selected??'清空负责人',note:'只设置业务关联，不自动派任务、不修改岗位权限或旧会话接手偏好。'}
  return {replay:false as const,fingerprint:JSON.stringify({before,selected,previous}),summary}
 }
 const approved=new WeakMap<ToolExecution,{current:Authorized;prepared?:Awaited<ReturnType<typeof prepare>>}>()
 const definitions:ReadonlyArray<{name:typeof businessResponsibilityToolNames[number];description:string;parameters:ParameterSchemaSpec}>=[
  {name:read,description:'读取当前本人业务的持久负责人和员工目录（mode=current默认，cursor整数每页32）。mode=receipt只核对完整原request:{requestId,expectedVersion,role:null|{id,expectedVersion}}；不接受scope/owner/session。不设置负责人、不派任务。旧回执不能代表当前岗位可执行，空回执不能作为换请求重复设置的依据。',parameters:{mode:{type:'string',enum:['current','receipt']},cursor:{type:'integer'},request:{type:'object',additionalProperties:true}}},
  {name:set,description:'经本人原生确认设置或清空当前业务的持久负责人。先read核真实版本和员工id；只接expectedVersion和role:null|{id,expectedVersion}，不接scope/requestId。只保存业务关联，不改会话偏好、不扩大岗位权限、不派任务。同一本人指令固定一个请求；结果未知用read receipt核完整原请求，不换指令重设。',parameters:{expectedVersion:{type:'integer',required:true},role:{oneOf:[{type:'null'},{type:'object',additionalProperties:true}],required:true}}},
 ]
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  const fixed=approved.get(exec),current=await authorize(exec)
  if(!fixed)throw new WorkError('teloa/conflict','缺少本次原生工具授权。')
  same(fixed.current,current)
  if(definition.name===read){
   const selected=query(args,current.scope)
   let result:unknown
   if(selected.mode==='receipt')result={requestId:selected.request.requestId,result:await receipt(current,selected.request),note:originalNotice}
   else{
    const [value,choices]=await Promise.all([ports.responsibility.read(current.actor,{scope:current.scope}),roles(current)])
    result={responsibility:readBusinessResponsibility(value,current.scope),roles:choices.slice(selected.cursor,selected.cursor+32),...(selected.cursor+32<choices.length?{nextCursor:selected.cursor+32}:{})}
   }
   same(current,await authorize(exec));return json(result)
  }
  const request=input(args,current.scope,fixedRequest(ports.owner,current.instruction)),prepared=await prepare(current,request)
  if(!fixed.prepared)throw new WorkError('teloa/conflict','缺少负责人确认。')
  if(!prepared.replay&&(fixed.prepared.replay||prepared.fingerprint!==fixed.prepared.fingerprint))throw new WorkError('teloa/conflict','确认期间负责人或选定员工发生变化，请重新读取。')
  same(current,await authorize(exec))
  if(prepared.replay)return json({requestId:request.requestId,result:prepared.result,note:originalNotice})
  try{return json({requestId:request.requestId,result:readBusinessResponsibilityResult(await ports.responsibility.set(current.actor,request),request),note:originalNotice})}
  catch(error){if(exec.signal.aborted||error instanceof WorkError&&['teloa/forbidden','teloa/invalid-input','teloa/conflict','teloa/version-conflict'].includes(error.code))throw error;const {scope:_,...original}=request;throw new WorkError('teloa/host-unavailable','设置结果尚未确认，请用read receipt核对完整原request='+json(original)+'；不要换指令重复设置。')}
 }}))
 return ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!names.has(exec.name))return next()
  let fixed:{current:Authorized;prepared?:Awaited<ReturnType<typeof prepare>>}
  try{
   const current=await authorize(exec)
   if(exec.name===read){query(exec.arguments,current.scope);fixed={current}}
   else fixed={current,prepared:await prepare(current,input(exec.arguments,current.scope,fixedRequest(ports.owner,current.instruction)))}
   same(current,await authorize(exec));approved.set(exec,fixed)
  }catch(error){return {kind:'deny' as const,reason:error instanceof WorkError?error.message:'无法核对业务负责人。'}}
  const decision=await next()
  if(decision.kind==='deny'||decision.kind==='cancel'||!fixed.prepared||fixed.prepared.replay)return decision
  const reason=(decision.kind==='ask'&&decision.reason?decision.reason+'\n':'')+'确认设置业务负责人？'+JSON.stringify(fixed.prepared.summary)
  if(Buffer.byteLength(reason)>131072)return {kind:'deny' as const,reason:'确认内容超过128KiB，请缩小内容后重试；没有设置负责人。'}
  return {kind:'ask' as const,reason}
 })
}
