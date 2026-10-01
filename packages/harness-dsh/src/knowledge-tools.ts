import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,isKnowledgeSaveReceipt,isRecord,parseSaveKnowledgeMessageToolInput,resourceId,type ConversationKnowledgeCommand,type KnowledgeSaveReceipt} from '@teloa/contract'
import type {ResourceActor} from '@teloa/backend'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {authorizeConversationMutation,conversationMutationRequestId,type ConversationMutationAuthorization} from './conversation-mutation.ts'
import {readNativePlainTextMessage,type NativePlainTextMessage} from './native-artifact-message.ts'
import {readSessionEvents} from './session-events.ts'

export const knowledgeToolNames=['teloa_knowledge_candidates','teloa_knowledge_save_message','teloa_knowledge_status'] as const
type MutationSession=Parameters<typeof readNativePlainTextMessage>[0]
export type KnowledgeToolsPorts={
 owner:string;conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>;readTaskPolicy:TaskToolPolicyReader
 knowledge:{save(actor:ResourceActor,input:unknown):Promise<KnowledgeSaveReceipt>;get(actor:ResourceActor,input:unknown):Promise<KnowledgeSaveReceipt|null>}
}
const names=new Set<string>(knowledgeToolNames)
const empty=(value:unknown)=>{if(!isRecord(value)||Object.keys(value).length)throw new WorkError('teloa/invalid-input','此工作资料查询不接受参数。')}
const statusInput=(value:unknown)=>{if(!isRecord(value)||Object.keys(value).some(key=>key!=='requestId')||!resourceId(value.requestId))throw new WorkError('teloa/invalid-input','工作资料恢复参数格式不正确。');return {requestId:value.requestId}}
const authorize=(ports:KnowledgeToolsPorts,exec:{agent?:{session:MutationSession&{header:{origin?:string}}};signal:AbortSignal})=>authorizeConversationMutation({owner:ports.owner,conversation:ports.conversation,readTaskPolicy:ports.readTaskPolicy,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal})
const actor=(authorization:ConversationMutationAuthorization):ResourceActor=>({ownerId:authorization.ownerId,kind:'human',scopeIds:['general']})
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right)
const invalidReceipt=()=>new WorkError('teloa/invalid-host-response','工作资料保存服务返回无效或身份不一致的回执。')
function commandReceipt(value:unknown,command:ConversationKnowledgeCommand):KnowledgeSaveReceipt{
 if(!isKnowledgeSaveReceipt(value)||value.requestId!==command.requestId||value.title!==command.target.title||value.category!==command.target.category||!same(value.topics,command.target.topics)||value.workspaceId!==command.target.workspaceId||!same(value.scopeIds,command.target.scopeIds)||value.source.sessionId!==command.subject.sessionId||value.source.messageId!==command.subject.messageId||value.source.seq!==command.subject.seq||value.source.selectionHash!==command.subject.selectionHash)throw invalidReceipt()
 return value
}
function statusReceipt(value:unknown,requestId:string):KnowledgeSaveReceipt|null{
 if(value===null)return null
 if(!isKnowledgeSaveReceipt(value)||value.requestId!==requestId)throw invalidReceipt()
 return value
}

export function nativePlainTextCandidates(session:MutationSession,authorization:ConversationMutationAuthorization){
 const visible=session.surface?new Set(session.surface.nodes):undefined,result:NativePlainTextMessage[]=[]
 for(const event of [...readSessionEvents(session)].reverse()){
  if(result.length>=12)break
  if(event.seq<session.inheritedEventCount||event.type!=='user/message'&&event.type!=='assistant/message'||event.surfaceOp!=='append'||visible&&!visible.has(event.seq))continue
  if(event.type==='user/message'&&event.data.source.kind!=='user'||event.type==='assistant/message'&&event.data.interrupted===true)continue
  const message=event.type==='user/message'?event.data:event.data.message
  if(message.id===authorization.instruction.messageId&&event.seq===authorization.instruction.seq)continue
  try{result.push(readNativePlainTextMessage(session,{messageId:message.id,seq:event.seq}))}catch{}
 }
 return result.map(({markdown,...row})=>({...row,preview:markdown.replace(/\s+/g,' ').trim().slice(0,160)}))
}

export function registerKnowledgeTools(ctx:Context,ports:KnowledgeToolsPorts){
 const output={schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]}
 ctx.tools.register(defineTool({name:'teloa_knowledge_candidates',description:'列出当前本人普通会话中可保存的近期完整纯文本消息，不包含本轮用户的保存指令。先提供资料正文，再单独发一条保存指令。若列表为空，请说明当前没有可保存的历史消息，不要等待或重复查询。返回消息指针、摘要和选择摘要；不会返回或保存完整正文。',parameters:{},output,execute:async(args,exec)=>{empty(args);const authorization=await authorize(ports,exec);return JSON.stringify({schema:'teloa.knowledge-candidates/v1',items:nativePlainTextCandidates(exec.agent!.session,authorization)})}}))
 ctx.tools.register(defineTool({name:'teloa_knowledge_save_message',description:'把当前本人普通会话中的一条完整纯文本消息保存为通用范围工作资料。先用候选工具取得可信消息指针；主分类必须来自用户意图，不会扩大范围或自动关联员工。',parameters:{message:{type:'object',required:true,additionalProperties:false,properties:{messageId:{type:'string',required:true},seq:{type:'integer',required:true},selectionHash:{type:'string',required:true}}},title:{type:'string',required:true},category:{type:'string',enum:['business-context','policy','sop','criteria','reference','template-asset','system-data-guide'],required:true},topics:{type:'array',items:{type:'string'},required:true}},output,execute:async(args,exec)=>{
  const input=parseSaveKnowledgeMessageToolInput(args),authorization=await authorize(ports,exec),subject=readNativePlainTextMessage(exec.agent!.session,input.message)
  if(subject.sessionId!==authorization.sessionId)throw new WorkError('teloa/forbidden','保存对象不属于当前会话。')
  const command:ConversationKnowledgeCommand={schema:'teloa.conversation-knowledge-command/v1',requestId:conversationMutationRequestId(authorization,'teloa_knowledge_save_message'),origin:{sessionId:authorization.sessionId,messageId:authorization.instruction.messageId,seq:authorization.instruction.seq,selectionHash:authorization.instruction.selectionHash},subject,target:{workspaceId:'default',title:input.title,category:input.category,topics:input.topics,scopeIds:['general']}}
  return JSON.stringify(commandReceipt(await ports.knowledge.save(actor(authorization),command),command))
 }}))
 ctx.tools.register(defineTool({name:'teloa_knowledge_status',description:'按稳定 requestId 核对一次会话工作资料保存操作的真实回执。结果未知时使用原 requestId，不要创建新请求。',parameters:{requestId:{type:'string',required:true}},output,execute:async(args,exec)=>{const input=statusInput(args),authorization=await authorize(ports,exec),receipt=statusReceipt(await ports.knowledge.get(actor(authorization),input),input.requestId);return JSON.stringify({schema:'teloa.knowledge-status/v1',requestId:input.requestId,receipt})}}))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!names.has(exec.name))return next()
  try{const authorization=await authorize(ports,exec);if(exec.name==='teloa_knowledge_candidates')empty(exec.arguments);else if(exec.name==='teloa_knowledge_status')statusInput(exec.arguments);else{const input=parseSaveKnowledgeMessageToolInput(exec.arguments);readNativePlainTextMessage(exec.agent!.session,input.message);if(authorization.sessionId!==exec.agent!.session.id)throw new WorkError('teloa/forbidden','目标会话不一致。')}}catch(error){return {kind:'deny',reason:error instanceof Error?error.message:'无法核对工作资料保存边界。'}}
  return next()
 })
}
