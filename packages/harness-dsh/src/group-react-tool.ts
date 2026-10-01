import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,groupReactionEmojis,isGroupReactionEmoji,type GroupReactionEmoji} from '@teloa/contract'
import {resolveSessionLineage,type LineageSession} from './subagent-lineage.ts'

export const groupReactToolName='teloa_group_react'

/** 本次运行的群内表态判据；`rootId` 是本话题闸的唯一依据，`runId` 跟着表情行一起落库。 */
export type GroupReactRunContext={canPost:boolean;groupId:string;rootId:string;roleId:string;runId:string}
export type GroupReactToolPorts={
 /** 读不出来必须抛，不得回 undefined：那会与「本来就不是群运行」混成一条路。 */
 context:(sessionId:string,signal:AbortSignal)=>Promise<GroupReactRunContext|undefined>
 /** 本话题判据，只读。 */
 inTopic:(context:GroupReactRunContext,messageId:string,signal:AbortSignal)=>Promise<boolean>
 /** 写入。四道闸已在 authorize() 里全过，这里不再判、不回状态（M5）。 */
 react:(context:GroupReactRunContext,messageId:string,emoji:GroupReactionEmoji,signal:AbortSignal)=>Promise<void>
}

/** 四句固定中文理由：不含会话 id、工具参数、数据库文本或上游异常消息。 */
export const reactGroupOnlyReason='这个工具只能在群任务的运行里使用。'
export const reactPostReason='本员工没有当前群内发言授权，不能在群里加表情。'
export const reactTopicReason='只能给本话题里的消息加表情。'
export const reactUnknownReason='无法核对当前运行的群内发言授权。'

type ReactExecution={agent?:{session:LineageSession};signal:AbortSignal}
type ReactArguments={messageId:string;emoji:GroupReactionEmoji}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)

/**
 * 只收 `{messageId,emoji}` 两个键。给谁加、以哪个岗位身份加、算哪一次运行，全由服务端按本次运行的
 * 会话现读决定——模型在类型层面就够不着这三样。
 */
function readReactArguments(args:unknown):ReactArguments{
 const invalid=():never=>{throw new WorkError('teloa/invalid-input','加表情只接受本话题里的一条群消息 id 与十二个固定表情之一。')}
 if(typeof args!=='object'||args===null||Array.isArray(args)||Object.keys(args).some(key=>!['messageId','emoji'].includes(key)))invalid()
 const row=args as Record<string,unknown>
 if(!uuid(row.messageId)||!isGroupReactionEmoji(row.emoji))invalid()
 return {messageId:row.messageId as string,emoji:row.emoji as GroupReactionEmoji}
}

/**
 * 四道闸全部在这里（M5）：有群执行上下文、本岗位 `canPost` 为真、入参合法、目标消息在本运行来源话题内。
 * 读不出来一律拒（`reactUnknownReason`）：判不出来就放行等于把「员工能在哪条消息上表态」静默放开。
 * 放在 pre-execute 与 execute 两处各跑一次，结论恒等。
 */
async function authorize(ctx:Context,ports:GroupReactToolPorts,exec:ReactExecution,args:unknown):Promise<{context:GroupReactRunContext}&ReactArguments>{
 if(!exec.agent)throw new WorkError('teloa/forbidden',reactUnknownReason)
 if(exec.signal.aborted)throw new WorkError('teloa/forbidden',reactUnknownReason)
 // 子 Agent 自己不持有 Run，按谱系根会话判；谱系断链一律拒，不因为多了一层就放宽。
 let root:LineageSession
 try{root=resolveSessionLineage(ctx,exec.agent.session).root}catch{throw new WorkError('teloa/forbidden',reactUnknownReason)}
 let context:GroupReactRunContext|undefined
 try{context=await ports.context(root.id,exec.signal)}catch{throw new WorkError('teloa/forbidden',reactUnknownReason)}
 if(!context)throw new WorkError('teloa/forbidden',reactGroupOnlyReason)
 if(!context.canPost)throw new WorkError('teloa/forbidden',reactPostReason)
 const {messageId,emoji}=readReactArguments(args)
 let inTopic:boolean
 try{inTopic=await ports.inTopic(context,messageId,exec.signal)}catch{throw new WorkError('teloa/forbidden',reactUnknownReason)}
 if(!inTopic)throw new WorkError('teloa/forbidden',reactTopicReason)
 return {context,messageId,emoji}
}

/**
 * 员工在群里给一条消息加表情。**进自授权集**（见 `index.ts` 里 `registerTaskToolGuard` 的自授权名单）：
 * 它既不是 MCP 资源工具、编排类、委派工具，也不是外发通道，因此过得了那四条装配期断言。
 * 自授权只解决「在群运行里可见」，能不能用完全由本文件的 `authorize()` 判。
 */
export function registerGroupReactTool(ctx:Context,ports:GroupReactToolPorts):void{
 ctx.tools.register(defineTool({
  name:groupReactToolName,
  description:`给本次运行所在话题里的一条群消息加一个表情，用来快速表态（收到、同意、有疑问等），不发消息、不推进任何任务。只能用这十二个固定表情之一：${groupReactionEmojis.join(' ')}。跨话题的消息加不了；同一条消息上重复加同一个表情不会重复计数；不能取消别人的表情。`,
  parameters:{messageId:{type:'string',required:true},emoji:{type:'string',required:true}},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  execute:async(args,exec)=>{
   const {context,messageId,emoji}=await authorize(ctx,ports,exec,args)
   await ports.react(context,messageId,emoji,exec.signal)
   return JSON.stringify({messageId,emoji})
  },
 }))
 ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(exec.name!==groupReactToolName)return next()
  try{await authorize(ctx,ports,exec,exec.arguments)}catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:reactUnknownReason}}
  return next()
 })
}
