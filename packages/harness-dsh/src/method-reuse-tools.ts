import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision,type ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,isRecord,taskInput,methodReuseBasisHash,readMethodReuseSource,readMethodReuseAcceptedSource,pageCreateCanonicalBody,readWorkBudgetPolicy,type WorkBudgetPolicy,type MethodReuseSource,type MethodReuseAcceptedSource,type MethodReuseTarget,type SavedArtifactVersion,type PageCreateDraft} from '@teloa/contract'
import {authorizeConversationInstructionMutation,assertConversationInstructionMutationAuthorization,conversationInstructionMutationRequestId,type ConversationInstructionMutationAuthorization} from './conversation-mutation.ts'
import {assertSkillCreatorLoaded,type BuiltinSkillCreator} from './builtin-skill-creator.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {readSessionEvents} from './session-events.ts'
import {skillDraftBody,skillDraftParameters} from './page-create-tools.ts'
import {planDraftGuide} from './plan-draft-guide.ts'
import {planDraftBody,methodPlanDraftParameters} from './plan-draft-parameters.ts'

export const methodReuseToolNames=['teloa_method_source','teloa_method_reuse'] as const
type SourceInput={artifactId:string;version?:number}
type PreparedInput={requestId:string;source:MethodReuseSource;acceptedSource:MethodReuseAcceptedSource;target:MethodReuseTarget;body:unknown}
export type MethodReuseToolsPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>
 readTaskPolicy:TaskToolPolicyReader
 skillCreator:BuiltinSkillCreator|null
  defaultPlanBudget?:()=>Promise<WorkBudgetPolicy>
 source:(input:SourceInput,signal:AbortSignal)=>Promise<{source:MethodReuseSource;artifact:SavedArtifactVersion}>
 /** 同次创建器正文；正式服务再核成果/认可来源并与原草稿同事务保存。 */
 prepare:(input:PreparedInput,signal:AbortSignal,assertCurrent:()=>Promise<void>)=>Promise<PageCreateDraft>
}
const bad=()=>new WorkError('teloa/invalid-input','请使用固定成果版本及原创建器正文准备方法草稿。')
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
function sourceInput(value:unknown):SourceInput{
 const row=taskInput(value,['artifactId','version'])
 if(!uuid(row.artifactId)||row.version!==undefined&&(!Number.isSafeInteger(row.version)||Number(row.version)<1))throw bad()
 return {artifactId:row.artifactId,...(row.version===undefined?{}:{version:Number(row.version)})}
}
async function reuseInput(value:unknown,defaultPlanBudget:MethodReuseToolsPorts['defaultPlanBudget']){
 const row=taskInput(value,['target','source','skill','plan'])
 if(row.target!=='skill'&&row.target!=='plan')throw bad()
 if(row.target==='skill'?!Object.hasOwn(row,'skill')||Object.hasOwn(row,'plan'):!Object.hasOwn(row,'plan')||Object.hasOwn(row,'skill'))throw bad()
 const target=row.target as MethodReuseTarget,source=readMethodReuseSource(row.source)
 let plan=row.plan
 if(target==='plan'&&isRecord(plan)&&plan.kind!=='configure-work'&&isRecord(plan.work)&&!Object.hasOwn(plan.work,'budget')){
  if(!defaultPlanBudget)throw new WorkError('teloa/dependency-unavailable','当前本人默认工作额度暂不可读取，请稍后重新准备草稿。')
  plan={...plan,work:{...plan.work,budget:readWorkBudgetPolicy(await defaultPlanBudget())}}
 }
 const body=target==='skill'?skillDraftBody(row.skill):planDraftBody(plan)
 if(!isRecord(body))throw bad()
 pageCreateCanonicalBody(body)
 return {target,source,body}
}
function acceptedSource(exec:ToolExecution,authorization:ConversationInstructionMutationAuthorization):MethodReuseAcceptedSource{
 if(!exec.agent)throw bad()
 const event=readSessionEvents(exec.agent.session).find(event=>event.seq===authorization.instruction.seq)
 if(!event||event.type!=='user/message'||event.surfaceOp!=='append'||event.data.source.kind!=='user'||event.data.id!==authorization.instruction.messageId||!('rpcId'in event.data.source))throw new WorkError('teloa/forbidden','方法采用需要原生本人消息的稳定来源。')
 return readMethodReuseAcceptedSource({sessionId:authorization.sessionId,messageId:event.data.id,messageSeq:event.seq,requestId:event.data.source.rpcId})
}

/** 原本人会话准备方法，不提供安装、采用、启用或替换版本的模型捷径。 */
export function registerMethodReuseTools(ctx:Context,ports:MethodReuseToolsPorts){
 const checked=new WeakMap<object,ConversationInstructionMutationAuthorization>()
 const authorize=(exec:ToolExecution)=>authorizeConversationInstructionMutation({owner:ports.owner,conversation:ports.conversation,readTaskPolicy:ports.readTaskPolicy,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal})
 const creator=(exec:ToolExecution,target:MethodReuseTarget)=>{
  if(target!=='skill')return
  if(!ports.skillCreator||!exec.agent)throw new WorkError('teloa/dependency-unavailable','请先在本次本人会话加载技能创建器，再保存方法。')
  assertSkillCreatorLoaded(exec.agent.session,ports.skillCreator)
 }
 const definitions=[
  {name:'teloa_method_source' as const,description:'只读本人指定成果的固定版本、正文与复用摘要。准备方法前先调用，不猜basisHash，不扫描其他成果；结果可读不代表本人认可、已创建技能或已启用计划。',parameters:{artifactId:{type:'string',required:true},version:{type:'integer'}}},
  {name:'teloa_method_reuse' as const,description:'将本人已认可、来源有效的成果准备成原创建器草稿。先用teloa_method_source取得source及正文。target=skill须先加载/teloa-skill-creator，再传完整skill对象（id/title/version/categories/files，SKILL.md包含frontmatter、输入要求、步骤、验证、输出、失败与审批边界）；target=plan传原计划草稿plan对象。source逐字取只读回执（artifactId/version/basisHash及可选taskId）。本人认可及启用意图由宿主从真实原消息或人工验收核对，不接受工具自报。默认只保存暂停草稿，不安装、不替换选定技能版本、不启用或执行；结果中的原稿可在同一创建器核对确认。不能从一次局部成果声称整个流程已可靠。',parameters:{target:{type:'string',enum:['skill','plan'],required:true},source:{type:'object',additionalProperties:false,required:true,properties:{artifactId:{type:'string',required:true},version:{type:'integer',required:true},basisHash:{type:'string',required:true},taskId:{type:'string'}}},skill:skillDraftParameters,plan:methodPlanDraftParameters}},
 ] as const
 const execute=(name:typeof methodReuseToolNames[number])=>async(args:unknown,exec:ToolExecution)=>{
  const authorization=await authorize(exec)
  assertConversationInstructionMutationAuthorization(checked.get(exec),authorization)
  const current=async()=>{exec.signal.throwIfAborted();assertConversationInstructionMutationAuthorization(authorization,await authorize(exec));exec.signal.throwIfAborted()}
  if(name==='teloa_method_source'){
   const input=sourceInput(args),result=await ports.source(input,exec.signal)
   await current()
   const source=readMethodReuseSource(result.source),artifact=result.artifact
   if(artifact.ownerId!==ports.owner||artifact.artifactId!==input.artifactId||source.artifactId!==input.artifactId||artifact.number!==source.version||input.version!==undefined&&source.version!==input.version||await methodReuseBasisHash(artifact)!==source.basisHash)throw new WorkError('teloa/invalid-host-response','成果来源回执与指定版本不一致。')
   await current()
   return JSON.stringify({source,artifact,sourceRole:'method-draft-provenance'})
  }
  const input=await reuseInput(args,ports.defaultPlanBudget);creator(exec,input.target)
  const accepted=acceptedSource(exec,authorization),requestId=conversationInstructionMutationRequestId(authorization,name,exec.callId)
  await current()
  const draft=await ports.prepare({...input,acceptedSource:accepted,requestId},exec.signal,current)
  await current()
  if(draft.ownerId!==ports.owner||draft.requestId!==requestId||draft.entity!==input.target)throw new WorkError('teloa/invalid-host-response','方法草稿回执与原请求不一致。')
  return JSON.stringify(draft)
 }
 const output={schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]}
 // 两个参数表保留各自泛型，不能把不同工具的必填字段合成一份联合 schema。
 ctx.tools.register(defineTool({...definitions[0],output,execute:execute(definitions[0].name)}))
 ctx.tools.register(defineTool({...definitions[1],description:definitions[1].description+planDraftGuide,output,execute:execute(definitions[1].name)}))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!(methodReuseToolNames as readonly string[]).includes(exec.name))return next()
  try{
   const authorization=await authorize(exec)
   if(exec.name==='teloa_method_source')sourceInput(exec.arguments)
   else{const input=await reuseInput(exec.arguments,ports.defaultPlanBudget);creator(exec,input.target);acceptedSource(exec,authorization)}
   checked.set(exec,authorization)
  }catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法核对方法复用的原本人来源。'}}
  return next()
 },{prepend:true})
}
