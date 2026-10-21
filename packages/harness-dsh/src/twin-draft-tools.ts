import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type ToolExecution,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,readTwinDraft,readTwinDraftCreate,twinDraftRecord,type DigitalRole,type TwinDraftCreate} from '@teloa/contract'
import {authorizeOrdinaryConversationMutation} from './conversation-mutation.ts'
import {sourceInstructionKey} from './conversation-work-instruction.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {twinDraftToolRequestId} from './twin-drafts.ts'

export const twinDraftProposalToolName='teloa_twin_draft_save'
export type TwinDraftToolPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'ready'|'pending'}>
 readTaskPolicy:TaskToolPolicyReader
 /** 可信 ObjectConversationService 绑定与 RoleService 联查；不可由工具参数指定分身。 */
 roleForSession:(sessionId:string)=>Promise<DigitalRole|null>
 create:(owner:string,input:TwinDraftCreate)=>Promise<unknown>
}
async function authorize(ports:TwinDraftToolPorts,exec:Pick<ToolExecution,'agent'|'signal'>){
 const auth=await authorizeOrdinaryConversationMutation({owner:ports.owner,conversation:ports.conversation,readTaskPolicy:ports.readTaskPolicy,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal},'保存分身代拟稿')
 const source=sourceInstructionKey(ports.owner,exec),role=await ports.roleForSession(auth.sessionId)
 if(!role||role.ownerId!==ports.owner||role.kind!=='twin'||role.state==='retired')throw new WorkError('teloa/forbidden','当前不是本人真实分身会话。')
 return {auth,role,source}
}
/** 模型只能保存候选。采用、退回、发送与执行委托不在这个端口中。 */
export function registerTwinDraftTools(ctx:Context,ports:TwinDraftToolPorts){
 ctx.tools.register(defineTool({
  name:twinDraftProposalToolName,
  description:'把当前分身会话中本人要求代拟的回复保存到代拟工作，供本人逐稿修改、退回或明确采用。原文与分身身份由宿主从真实会话核验；保存不是发送，也不会授予执行或代批权限。依据只填写实际使用的已确认判断力样本固定身份、版本和摘要；没有使用样本时传空数组，不编造。',
  parameters:{title:{type:'string',required:true},body:{type:'string',required:true},basis:{type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{id:{type:'string',required:true},version:{type:'integer',required:true},contentHash:{type:'string',required:true}}}}},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  execute:async(args,exec)=>{
   const row=twinDraftRecord(args,['title','body','basis']),current=await authorize(ports,exec)
   const command=readTwinDraftCreate({requestId:twinDraftToolRequestId(ports.owner,current.auth.sessionId,String(exec.callId)),roleId:current.role.id,expectedRoleVersion:current.role.version,title:row.title,body:row.body,basis:row.basis,source:{kind:'conversation',sessionId:current.source.sessionId,messageId:current.source.messageId,messageSeq:current.source.messageSeq}})
   const verified=await authorize(ports,exec)
   if(JSON.stringify(verified)!==JSON.stringify(current))throw new WorkError('teloa/version-conflict','本人原指令或分身已变化，未自动保存。')
   const draft=readTwinDraft(await ports.create(ports.owner,command))
   if(draft.ownerId!==ports.owner||draft.roleId!==command.roleId||draft.roleVersion!==command.expectedRoleVersion||draft.body!==command.body||draft.title!==command.title||draft.state!=='draft'||draft.source.kind!=='conversation'||draft.source.sessionId!==current.source.sessionId||draft.source.messageId!==current.source.messageId||draft.source.messageSeq!==current.source.messageSeq)throw new WorkError('teloa/invalid-host-response','候选稿回执与真实来源不一致。')
   return JSON.stringify({draft,saved:true,sent:false})
  },
 }))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(exec.name!==twinDraftProposalToolName)return next()
  try{await authorize(ports,exec)}catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法核对本人分身会话。'}}
  return next()
 })
}
