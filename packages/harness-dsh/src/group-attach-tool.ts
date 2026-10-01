import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,artifactFilePath,groupReferenceMaxFiles,type GroupRunFileClaim} from '@teloa/contract'
import {resolveSessionLineage,type LineageSession} from './subagent-lineage.ts'

export const groupAttachToolName='teloa_group_attach'

/** 本次运行的群内发言判据；`nativeRequestId` 是登记表的第二把钥匙，登记与取用必须同一对。 */
export type GroupAttachRunContext={canPost:boolean;nativeRequestId:string}
export type GroupAttachToolPorts={
 /** 读不出来必须抛，不得回 undefined：那会与「本来就不是群运行」混成一条路。 */
 context:(sessionId:string,signal:AbortSignal)=>Promise<GroupAttachRunContext|undefined>
}

/**
 * 员工声明的贴回意图只记在内存里：不搬字节、不写库。读取、定版与提交都在运行结束后的
 * `GroupRunMessageService.post` 事务里，本表只回答「这次运行声明了哪几个文件」。
 */
export type GroupRunClaimRegistry={
 claims:(sessionId:string,nativeRequestId:string)=>GroupRunFileClaim[]
 /** 本轮图片没能交给模型：回帖由发布器前置固定文案，不由模型自陈。 */
 noVision:(sessionId:string,nativeRequestId:string)=>boolean
 markNoVision:(sessionId:string,nativeRequestId:string)=>void
 clear:(sessionId:string,nativeRequestId:string)=>void
}

/** 三句固定中文理由：不含会话 id、工具参数、数据库文本或上游异常消息。 */
const attachGroupOnlyReason='这个工具只能在群任务的运行里使用。'
const attachPostReason='本员工没有当前群内发言授权，不能把文件贴回群。'
const attachUnknownReason='无法核对当前运行的群内发言授权。'

/** 登记表的异常路径兜底上限；正常路径由 `session/disposed` 与回帖后的 `clear` 清掉。 */
const claimEntryLimit=512

type ClaimEntry={files:GroupRunFileClaim[];noVision:boolean}
type AttachExecution={agent?:{session:LineageSession};signal:AbortSignal}

const entryKey=(sessionId:string,nativeRequestId:string):string=>`${sessionId}\0${nativeRequestId}`

/**
 * 与契约 `groupRunFileClaims`（`contract/src/collaboration.ts`）的单条判据逐字取齐：
 * 只收 `{path,sha256}` 两个键。模型给不出 `source`/`artifactId` —— 贴哪一份成果由服务端按
 * 本次运行的会话现读核对，类型层面就不可达。回帖时整组还会再过一次那个解析器。
 */
function readClaim(args:unknown):GroupRunFileClaim{
 const invalid=():never=>{throw new WorkError('teloa/invalid-input','声明的文件路径或摘要不正确，只接受本次运行工作目录里的相对路径与 64 位小写摘要。')}
 if(typeof args!=='object'||args===null||Array.isArray(args)||Object.keys(args).some(key=>!['path','sha256'].includes(key)))invalid()
 const row=args as Record<string,unknown>
 if(!artifactFilePath(row.path)||(row.path as string).endsWith('/')||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256))invalid()
 return {path:row.path as string,sha256:row.sha256 as string}
}

/**
 * 只在「有群执行上下文」且「本岗位 canPost 为真」的运行里放行。
 * 读不出来一律拒（`attachUnknownReason`）：判不出来就退回「随便登记」等于把声明面静默放开。
 */
async function authorize(ctx:Context,ports:GroupAttachToolPorts,exec:AttachExecution):Promise<{sessionId:string;nativeRequestId:string}>{
 if(!exec.agent)throw new WorkError('teloa/forbidden',attachUnknownReason)
 if(exec.signal.aborted)throw new WorkError('teloa/forbidden',attachUnknownReason)
 // 子 Agent 自己不持有 Run，按谱系根会话判；谱系断链一律拒，不因为多了一层就放宽。
 let root:LineageSession
 try{root=resolveSessionLineage(ctx,exec.agent.session).root}catch{throw new WorkError('teloa/forbidden',attachUnknownReason)}
 let context:GroupAttachRunContext|undefined
 try{context=await ports.context(root.id,exec.signal)}catch{throw new WorkError('teloa/forbidden',attachUnknownReason)}
 if(!context)throw new WorkError('teloa/forbidden',attachGroupOnlyReason)
 if(!context.canPost)throw new WorkError('teloa/forbidden',attachPostReason)
 return {sessionId:root.id,nativeRequestId:context.nativeRequestId}
}

/**
 * 登记员工本次运行要贴回群的文件。**进自授权集**（见 `index.ts` 里 `registerTaskToolGuard` 的自授权名单）：
 * 它只登记意图，既不是 MCP 资源工具、编排类、委派工具，也不是外发通道，因此不过岗位清单与参数范围这两道闸。
 * 许可完全由本文件的 `authorize()`（有 `groupContext` 且 `canPost` 才放行）与服务端 `post`（canPost ＋ 本次运行的成果）承担。
 */
export function registerGroupAttachTool(ctx:Context,ports:GroupAttachToolPorts):GroupRunClaimRegistry{
 const entries=new Map<string,ClaimEntry>()
 const entryOf=(key:string):ClaimEntry=>{
  const found=entries.get(key)
  if(found)return found
  const created:ClaimEntry={files:[],noVision:false}
  entries.set(key,created)
  if(entries.size>claimEntryLimit){const oldest=entries.keys().next();if(!oldest.done&&oldest.value!==key)entries.delete(oldest.value)}
  return created
 }
 const registry:GroupRunClaimRegistry={
  claims:(sessionId,nativeRequestId)=>entries.get(entryKey(sessionId,nativeRequestId))?.files.map(claim=>({...claim}))??[],
  noVision:(sessionId,nativeRequestId)=>entries.get(entryKey(sessionId,nativeRequestId))?.noVision??false,
  markNoVision:(sessionId,nativeRequestId)=>{entryOf(entryKey(sessionId,nativeRequestId)).noVision=true},
  clear:(sessionId,nativeRequestId)=>{entries.delete(entryKey(sessionId,nativeRequestId))},
 }
 ctx.tools.register(defineTool({
  name:groupAttachToolName,
  description:'声明本次运行产出的一个文件，运行结束后由平台把它定版成本任务的成果并贴回原群。只接受本次运行工作目录里的相对路径与该文件当前内容的 sha256；不能声明来源、成果身份或别处的文件。一次运行最多声明 8 个文件，重复声明同一路径与摘要不重复计数。',
  parameters:{path:{type:'string',required:true},sha256:{type:'string',required:true}},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  execute:async(args,exec)=>{
   const claim=readClaim(args)
   const {sessionId,nativeRequestId}=await authorize(ctx,ports,exec)
   const entry=entryOf(entryKey(sessionId,nativeRequestId))
   const duplicate=entry.files.some(existing=>existing.path===claim.path&&existing.sha256===claim.sha256)
   if(!duplicate){
    if(entry.files.length>=groupReferenceMaxFiles)throw new WorkError('teloa/conflict','本次运行最多声明 8 个要贴回群的文件。')
    entry.files.push(claim)
   }
   return JSON.stringify({declared:entry.files.length,duplicate})
  },
 }))
 ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(exec.name!==groupAttachToolName)return next()
  try{await authorize(ctx,ports,exec)}catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:attachUnknownReason}}
  return next()
 })
 // 登记跟着会话结束走；回帖成功后的 clear 是正常路径，这条只是没有回帖时的兜底。
 ctx.on('session/disposed',session=>{
  const prefix=`${String(session.id)}\0`
  for(const key of [...entries.keys()])if(key.startsWith(prefix))entries.delete(key)
 })
 return registry
}
