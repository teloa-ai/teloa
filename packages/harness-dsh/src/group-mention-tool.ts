import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError} from '@teloa/contract'
import {resolveSessionLineage,type LineageSession} from './subagent-lineage.ts'
import type {GroupAttachRunContext} from './group-attach-tool.ts'

export const groupMentionToolName='teloa_group_mention'
type Ports={context:(sessionId:string,signal:AbortSignal)=>Promise<GroupAttachRunContext|undefined>;declare:(sessionId:string,nativeRequestId:string,signal:AbortSignal)=>Promise<void>}
type Execution={agent?:{session:LineageSession};signal:AbortSignal}
const denied=()=>new WorkError('teloa/forbidden','无法核对当前运行的群内发言授权。')
/** 只登记原运行对本人的提醒意图，发布与身份仍由宿主确认，不接受姓名或其他目标。 */
export function registerGroupMentionTool(ctx:Context,ports:Ports){
 const authorize=async(args:unknown,exec:Execution)=>{
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).length!==1||Reflect.get(args,'target')!=='self')throw new WorkError('teloa/invalid-input','提及只接受本次群工作所属本人。')
  exec.signal.throwIfAborted()
  if(!exec.agent)throw denied()
  let sessionId:string
  try{sessionId=resolveSessionLineage(ctx,exec.agent.session).root.id}catch{throw denied()}
  let context:GroupAttachRunContext|undefined
  try{context=await ports.context(sessionId,exec.signal)}catch{throw denied()}
  if(!context?.canPost)throw denied()
  return {sessionId,nativeRequestId:context.nativeRequestId}
 }
 ctx.tools.register(defineTool({name:groupMentionToolName,
  description:'在本次群工作的最终回复里提及本人，提醒其阅读原消息。需要本人关注或补充意见时使用；只登记本次运行的提醒意图，运行成功回群时才出现。不是审批、任务创建或授权，不发额外消息；正文里写 @姓名 不会形成提及。',
  parameters:{target:{type:'string',enum:['self'],required:true}},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  execute:async(args,exec)=>{
   const target=await authorize(args,exec)
   try{await ports.declare(target.sessionId,target.nativeRequestId,exec.signal)}catch(error){if(error instanceof WorkError||exec.signal.aborted)throw error;throw new WorkError('teloa/dependency-unavailable','未能保存本轮提及，请稍后重试。')}
   return JSON.stringify({mentionSelf:true})
  },
 }))
 ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(exec.name!==groupMentionToolName)return next()
  try{await authorize(exec.arguments,exec)}catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法核对当前运行的群内发言授权。'}}
  return next()
 })
}
