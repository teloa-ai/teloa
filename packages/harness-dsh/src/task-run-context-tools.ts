import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type ToolExecution,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,retrievalCitationPath} from '@teloa/contract'
import {loadRunSkill,readRunKnowledgeSegment,runContextMode,runContextToolNames,type TaskRun} from '@teloa/backend'

/** 可信会话身份来自宿主；模型只提供固定资源身份，不接受 runId、owner 或范围。 */
export type RunContextReader=(sessionId:string,signal:AbortSignal)=>Promise<TaskRun|null>
const knowledgeCitationGuide='引用实际读到且支持结论的片段时，以返回的 citationPath 原值作为 Markdown 链接目标，以实际资料标题作链接文字，并保留资源版本和来源版本。仅写标题或版本不能替代可打开的引用；未读资料不能当作已引用。不要猜测、改写链接或用本机路径代替。'
export function registerTaskRunContextTools(ctx:Context,read:RunContextReader){
 const current=async(exec:Pick<ToolExecution,'agent'|'signal'>)=>{
  if(!exec.agent||exec.agent.session.header.origin==='subagent')throw new WorkError('teloa/forbidden','按需资源只供当前任务的负责人会话读取。')
  exec.signal.throwIfAborted()
  const run=await read(exec.agent.session.id,exec.signal)
  exec.signal.throwIfAborted()
  if(!run||run.sessionId!==exec.agent.session.id||run.contextMode!==runContextMode||!['submitting','accepted','active'].includes(run.state)||run.stopRequestedAt!==null)throw new WorkError('teloa/forbidden','当前会话没有有效的按需资源运行。')
  return run
 }
 const value=(name:string,run:TaskRun,args:unknown)=>name==='teloa_skill_load'?loadRunSkill(run.skills,args):readRunKnowledgeSegment(run.knowledge,args)
 const output={schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]}
 ctx.tools.register(defineTool({name:'teloa_skill_load',description:'按本次运行目录的 name 和 sha256 加载一份完整固定 Skill 方法。先选择适用于任务的 Skill，再读取正文后执行；发现其他领域线索时再补充。不能读取未绑定 Skill，不扩大工具权限。',parameters:{name:{type:'string',required:true},sha256:{type:'string',required:true}},output,execute:async(args,exec)=>JSON.stringify(value('teloa_skill_load',await current(exec),args))}))
 ctx.tools.register(defineTool({name:'teloa_knowledge_read',description:'读取本次运行绑定资料的固定版本片段。目录或检索结果给出 resourceId、resourceVersion、sourceVersion；offset 为规范化换行后的 UTF-16 位置，默认 0，length 默认 2000、最大 4000。用检索 chars 定位，或 nextOffset 继续相邻内容。返回总长度、原文位置及固定来源链接；不会读取整份资料或未绑定资源。'+knowledgeCitationGuide,parameters:{resourceId:{type:'string',required:true},resourceVersion:{type:'integer',required:true},sourceVersion:{type:'string',required:true},offset:{type:'integer'},length:{type:'integer'}},output,execute:async(args,exec)=>{
  const result=readRunKnowledgeSegment((await current(exec)).knowledge,args)
  return JSON.stringify({...result,...(result.excerpt?{citationPath:retrievalCitationPath(exec.agent!.session.id,result),notice:result.notice+' '+knowledgeCitationGuide}:{})})
 }}))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!(runContextToolNames as readonly string[]).includes(exec.name))return next()
  try{value(exec.name,await current(exec),exec.arguments)}catch(error){return {kind:'deny',reason:error instanceof Error?error.message:'无法核对本次运行资源。'}}
  return next()
 })
}
