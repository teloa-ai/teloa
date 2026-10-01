import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,businessDefinitionCanonicalBody,businessDefinitionKinds,businessScopeKeyRule,isBusinessScopeKey,readBusinessDefinitionBody,taskInput,type BusinessDefinitionKind} from '@teloa/contract'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {authorizeConversationMutation,conversationMutationRequestId} from './conversation-mutation.ts'
import {readBusinessDefinitionCatalog,readBusinessDefinitionDraft} from './business-definitions.ts'

export const businessDefinitionToolNames=['teloa_business_definitions_directory','teloa_business_definitions_draft'] as const
export type BusinessDefinitionToolsPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>
 readTaskPolicy:TaskToolPolicyReader
 directory:(scope:string)=>Promise<unknown>
 handler:(endpoint:string,payload:unknown)=>Promise<unknown>
}
const names=new Set<string>(businessDefinitionToolNames)
const scopeOf=(value:unknown):string=>{
 if(!isBusinessScopeKey(value)||value==='general')throw new WorkError('teloa/invalid-input','需要明确的业务范围：'+businessScopeKeyRule+'，不能是通用工作（general）。')
 return value
}
function argumentsOf(name:string,args:unknown){
 const row=taskInput(args,name===businessDefinitionToolNames[0]?['scope']:['scope','kind','definition']),scope=scopeOf(row.scope)
 if(name===businessDefinitionToolNames[0])return {scope}
 if(!businessDefinitionKinds.includes(row.kind as BusinessDefinitionKind))throw new WorkError('teloa/invalid-input','业务定义种类不在白名单内。')
 const kind=row.kind as BusinessDefinitionKind,definition=readBusinessDefinitionBody(kind,row.definition)
 if(definition.domain!==scope)throw new WorkError('teloa/invalid-input','定义所属范围与目标范围不一致。')
 return {scope,kind,definition}
}

/** 两道会话闸分别在前置与正文执行；目录只读声明，草案不提供生效与回退通路。 */
export function registerBusinessDefinitionTools(ctx:Context,ports:BusinessDefinitionToolsPorts){
 const authorize=(exec:Parameters<typeof ctx.tools.execute>[0])=>authorizeConversationMutation({owner:ports.owner,conversation:ports.conversation,readTaskPolicy:ports.readTaskPolicy,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal})
 const definitions=[
  {name:businessDefinitionToolNames[0],description:'读取本人业务范围的对象类型、字段与现有视图和动作定义。不返回对象取值、存档或试算结果。先核对字段名称再定制。',parameters:{scope:{type:'string',required:true}}},
  {name:businessDefinitionToolNames[1],description:'将一份业务定义保存为待确认草案，支持 source-mapping / widget / dashboard。只允许本人普通会话；保存不会生效，需要本人在业务页预览并确认。',parameters:{scope:{type:'string',required:true},kind:{type:'string',enum:[...businessDefinitionKinds],required:true},definition:{type:'object',required:true,additionalProperties:true}}},
 ] as const
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  const authorization=await authorize(exec),input=argumentsOf(definition.name,args)
  if(definition.name===businessDefinitionToolNames[0])return JSON.stringify(readBusinessDefinitionCatalog(await ports.directory(input.scope),input.scope))
  if(!('kind' in input)||!input.definition)throw new WorkError('teloa/invalid-input','缺少业务定义正文。')
  // 请求身份按「同一条指令 + 声明种类 + 声明 id」派生：同一声明重放仍替换同一份草案；看板设计一条指令要存多份组件与看板草案，
  // 不同声明各得一份（只按指令派生时，后存的会把前一份草案整行替换掉）。总条数仍受每范围待确认草案上限约束。
  const requestId=conversationMutationRequestId(authorization,[businessDefinitionToolNames[1],input.kind,input.definition.id].join('\0'))
  const result=readBusinessDefinitionDraft(await ports.handler('business-definitions/draft',{...input,requestId}),input.scope)
  // 回执正文与本次声明按规范化正文比对：chart.spec 这类透传对象在规范化正文里按键名排序，按对象字面量逐字比会把合法回执误判为不一致。
  if(result.ownerId!==ports.owner||result.requestId!==requestId||result.kind!==input.kind||result.localId!==input.definition.id||result.semver!==input.definition.version||result.status!=='draft'||businessDefinitionCanonicalBody(readBusinessDefinitionBody(result.kind,JSON.parse(result.body)))!==businessDefinitionCanonicalBody(input.definition))throw new WorkError('teloa/invalid-host-response','业务定义草案的返回结果与本次请求不一致。')
  return JSON.stringify(result)
 }}))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!names.has(exec.name))return next()
  try{await authorize(exec);argumentsOf(exec.name,exec.arguments)}catch(error){return {kind:'deny',reason:error instanceof Error?error.message:'无法核对业务定制身份。'}}
  const decision=await next()
  if(decision.kind==='deny'||exec.name!==businessDefinitionToolNames[1])return decision
  return {kind:'ask',reason:'确认把这份业务定义存成草案？草案不会生效，需要你在业务页预览并确认。'}
 })
}
