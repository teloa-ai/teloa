import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type ToolExecution} from '@deepseek-ai/dsh-tools'
import {createUserMessage,type ContextFormed} from '@deepseek-ai/dsh-llm'
import {WorkError,taskInput,readBusinessWorkCursor,readBusinessResultCursor} from '@teloa/contract'
import type {BusinessObjectWorkLinkService} from '@teloa/backend'
import {authorizeBusinessConversation,type BusinessConversationAuthorizationPorts} from './business-conversation-authorization.ts'
import {readConversationInstructionIdentity} from './conversation-instruction-identity.ts'
type Ports=BusinessConversationAuthorizationPorts&{objectWork:Pick<BusinessObjectWorkLinkService,'bySession'|'bySessionPage'|'read'|'publish'|'resultsPage'>}
const noticeSource='plugin:teloa.business-work' as const
declare module '@deepseek-ai/dsh-llm'{interface MessageSourceMap{'plugin:teloa.business-work':{kind:typeof noticeSource}&ContextFormed}}
const id=(value:unknown)=>{const h=createHash('sha256').update(JSON.stringify(['teloa.business-work-result/v1',value])).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`}
export function registerBusinessWorkTools(ctx:Context,ports:Ports){
 const authorize=(exec:Pick<ToolExecution,'agent'|'signal'>)=>authorizeBusinessConversation(ports,exec,'对象工作结果')
 const fixed=new WeakMap<ToolExecution,string>()
 for(const name of ['teloa_business_work_read','teloa_business_work_result'] as const)ctx.tools.register(defineTool({name,description:name==='teloa_business_work_read'?'分页读取当前本人业务会话的固定对象工作及结果。无workLinkId时返回工作items及nextCursor；指定workLinkId时返回该工作的结果items及nextCursor。同slot按revision降序；必须沿nextCursor续读目标slot，不能把尚未读取当作无结果。cursor原样传回。不扩大业务或文件权限。':'保存当前工作分析摘要与既有本人会话成果版本，不修改业务事实或记录。workLinkId从work_read读取，slot默认summary，expectedRevision从同slot最新结果读取，无结果时0。state只表示这份工作的进展。记录修改另用change_prepare准备持久草稿。',parameters:name==='teloa_business_work_read'?{workLinkId:{type:'string'},cursor:{type:'object',additionalProperties:true}}:{workLinkId:{type:'string',required:true},slot:{type:'string'},expectedRevision:{type:'integer',required:true},summary:{type:'string',required:true},state:{type:'string',required:true,enum:['working','completed','blocked']},artifactVersions:{type:'array',items:{type:'object',additionalProperties:true}}},output:{schema:{type:'string'} as const,render:(_a:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  const current=await authorize(exec);if(fixed.get(exec)!==current.fingerprint)throw new WorkError('teloa/forbidden','当前业务授权已变化。')
  const sessionId=exec.agent!.session.id
  if(name==='teloa_business_work_read'){
   const row=taskInput(args,['workLinkId','cursor'])
   if(row.workLinkId===undefined){const page=await ports.objectWork.bySessionPage(current.actor,{scope:current.scope,sessionId,cursor:readBusinessWorkCursor(row.cursor)});return JSON.stringify({...page,items:await Promise.all(page.items.map(async work=>({work,results:await ports.objectWork.resultsPage(current.actor,{workLinkId:work.id})})))})}
   const work=await ports.objectWork.read(current.actor,{workLinkId:row.workLinkId as string});if(work.sessionId!==sessionId||work.reference.scope!==current.scope)throw new WorkError('teloa/forbidden','工作不属于当前会话。')
   return JSON.stringify(await ports.objectWork.resultsPage(current.actor,{workLinkId:work.id,cursor:readBusinessResultCursor(row.cursor)}))
  }
  const row=taskInput(args,['workLinkId','slot','expectedRevision','summary','state','artifactVersions']),source=readConversationInstructionIdentity(exec.agent!)
  const work=await ports.objectWork.read(current.actor,{workLinkId:row.workLinkId as string});if(work.sessionId!==sessionId||work.reference.scope!==current.scope)throw new WorkError('teloa/forbidden','成果不属于当前对象工作。')
  return JSON.stringify(await ports.objectWork.publish(current.actor,{...row,slot:row.slot??'summary',requestId:id({...source,workLinkId:row.workLinkId,slot:row.slot??'summary'})},{...source,fingerprint:current.fingerprint}))
 }}))
 const remove=ctx.on('tools/pre-execute',async(exec,next)=>{if(!['teloa_business_work_read','teloa_business_work_result'].includes(exec.name))return next();try{fixed.set(exec,(await authorize(exec)).fingerprint);return next()}catch(e){return {kind:'deny' as const,reason:e instanceof WorkError?e.message:'对象工作暂不可核验。'}}})
 const removeContext=ctx.on('agent/pre-step',async({agent,signal},next)=>{
  const decision=await next();if(decision.kind==='reject'||!decision.messages.some(message=>message.source.kind==='user'))return decision
  let current:Awaited<ReturnType<typeof authorize>>
  try{current=await authorize({agent,signal})}catch(e){if(e instanceof WorkError&&['teloa/not-bound','teloa/not-found','teloa/forbidden'].includes(e.code))return decision;throw e}
  const works=await ports.objectWork.bySession(current.actor,{scope:current.scope,sessionId:agent.session.id});if(!works.length)return decision
  const notice=createUserMessage({source:{kind:noticeSource,form:'notice',summary:'当前对象工作'},content:[{type:'text',text:'当前原生会话关联以下固定对象工作：'+JSON.stringify(works)+'. 先用 teloa_business_work_read 读取结果版本；分析摘要和已保存成果版本用 teloa_business_work_result 保存。记录修改先用 teloa_business_change_prepare 保存草稿，不把准备当执行；本人要求采用后用 teloa_business_change_apply 经原生审批。工作完成不表示业务成交、付款、发布或告警解除。对象变化时按最新来源重新开始工作，不覆盖旧成果。'}]})
  return {...decision,messages:[...decision.messages,notice]}
 })
 return ()=>{remove();removeContext()}
}
