import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type ToolExecution,type ParameterSchemaSpec} from '@deepseek-ai/dsh-tools'
import {WorkError,taskInput,industryUpdateCanonical,readBusinessImportGetInput,readBusinessImportApplyInput,readBusinessImportReceiptInput,readBusinessImportAnyDraft,readBusinessImportAnyReceipt,type BusinessImportApplyInput,type BusinessImportAnyDraft} from '@teloa/contract'
import type {BusinessRecordImportService} from '@teloa/backend'
import {authorizeBusinessConversation,type BusinessConversationAuthorizationPorts} from './business-conversation-authorization.ts'
import {readConversationInstructionIdentity,type ConversationInstructionIdentity} from './conversation-instruction-identity.ts'

export const businessImportToolNames=['teloa_business_import_read','teloa_business_import_apply'] as const
export type BusinessImportToolsPorts=BusinessConversationAuthorizationPorts&{
 imports:Pick<BusinessRecordImportService,'get'|'receipt'|'apply'>
}
const [read,apply]=businessImportToolNames,names=new Set<string>(businessImportToolNames)
const approvalBytes=131072,responseBytes=1048576
const unknownNotice='回执只表示原固定批次；created是原批次记录数，不表示再次新增。未读到回执不能证明未受理，仍须保留未知状态，不能换本人指令或请求重复导入。'
const bad=()=>new WorkError('teloa/invalid-host-response','业务导入草案或回执与原请求、本人或业务不一致。')
const conflict=()=>new WorkError('teloa/conflict','确认期间本人指令、业务归属或完整导入预览已变化，请重新读取。')
function json(value:unknown){const result=JSON.stringify(value);if(Buffer.byteLength(result,'utf8')>responseBytes)throw new WorkError('teloa/invalid-input','业务导入回包超过大小上限，不能截断后认定结果。');return result}
/** 不使用工具调用ID或参数派生身份；同一本人指令固定为同一个导入请求。 */
function requestId(owner:string,instruction:ConversationInstructionIdentity){
 const hash=createHash('sha256').update(industryUpdateCanonical(['teloa.business-import-apply/v1',owner,instruction.sessionId,instruction.messageId,instruction.seq])).digest('hex')
 return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`
}
function applyInput(args:unknown,id:string){const row=taskInput(args,['draftId','previewRevision','previewDigest']);return readBusinessImportApplyInput({...row,requestId:id})}
function readQuery(args:unknown,scope:string){
 const row=taskInput(args,['mode','draftId','requestId'])
 if(row.mode==='get'){taskInput(args,['mode','draftId']);return {mode:'get' as const,input:readBusinessImportGetInput({draftId:row.draftId})}}
 if(row.mode==='receipt'){taskInput(args,['mode','requestId']);return {mode:'receipt' as const,input:readBusinessImportReceiptInput({requestId:row.requestId,scope})}}
 throw new WorkError('teloa/invalid-input','请明确读取导入草案get或原固定请求receipt。')
}

/** 仅用公开工具审批；字段、关联及固定来源的最终判断仍在同一apply事务内完成。 */
export function registerBusinessImportTools(ctx:Context,ports:BusinessImportToolsPorts):()=>void{
 const authorize=async(exec:Pick<ToolExecution,'agent'|'signal'>)=>({...await authorizeBusinessConversation(ports,exec,'业务表格导入'),instruction:readConversationInstructionIdentity(exec.agent!)})
 type Authorized=Awaited<ReturnType<typeof authorize>>
 const same=(before:Authorized,after:Authorized)=>{if(before.fingerprint!==after.fingerprint||industryUpdateCanonical(before.instruction)!==industryUpdateCanonical(after.instruction))throw conflict()}
 const get=async(current:Authorized,input:{draftId:string})=>{
  const value=readBusinessImportAnyDraft(await ports.imports.get(current.actor,input))
  if(value.ownerId!==current.actor.ownerId||value.scope!==current.scope||value.id!==input.draftId)throw bad()
  return value
 }
 const receipt=async(current:Authorized,id:string)=>{
  const raw=await ports.imports.receipt(current.actor,{requestId:id,scope:current.scope})
  if(raw===undefined)return null
  const value=readBusinessImportAnyReceipt(raw)
  if(value.scope!==current.scope||value.requestId!==id)throw bad()
  return value
 }
 const checkReceipt=(value:unknown,current:Authorized,input:BusinessImportApplyInput,draft:BusinessImportAnyDraft)=>{
  const result=readBusinessImportAnyReceipt(value),preview=draft.preview!
  if(result.requestId!==input.requestId||result.draftId!==input.draftId||result.previewDigest!==input.previewDigest||result.scope!==current.scope||result.type!==draft.type||result.fileHash!==draft.file.sha256||result.sourceIdentity!==draft.sourceIdentity||result.sourcePolicyDigest!==preview.sourcePolicyDigest||result.contentKey!==preview.contentKey||result.created!==preview.rows.length)throw bad()
  if(draft.format==='teloa.business-record-import/v2'){
   if(!('format' in result)||!('rawCellsDigest' in preview)||industryUpdateCanonical(result.source)!==industryUpdateCanonical(draft.source)||industryUpdateCanonical(result.policy)!==industryUpdateCanonical(draft.policy)||result.rawCellsDigest!==preview.rawCellsDigest)throw bad()
  }else if('format' in result)throw bad()
  return result
 }
 const prepare=async(current:Authorized,input:BusinessImportApplyInput)=>{
  const prior=await receipt(current,input.requestId)
  if(prior&&(prior.draftId!==input.draftId||prior.previewDigest!==input.previewDigest))throw new WorkError('teloa/conflict','同一本人指令已经固定另一导入请求，请先核对原回执。')
  const draft=await get(current,{draftId:input.draftId}),preview=draft.preview
  if(!preview||!preview.canApply||!['previewed','applied'].includes(draft.status)||preview.revision!==input.previewRevision||preview.digest!==input.previewDigest)throw conflict()
  if(prior)checkReceipt(prior,current,input,draft)
  const summary={business:current.title,scope:draft.scope,type:draft.type,draftId:draft.id,requestId:input.requestId,file:draft.file,...(draft.format==='teloa.business-record-import/v2'?{source:draft.source,policy:draft.policy}:{}),preview,status:draft.status,...(prior?{receipt:prior}:{}),note:'以下为完整固定批次；确认仅采用本地导入，不覆盖已有记录、不操作外部来源。字段定义及关联目标在写入事务中再次核验。'}
  // 保存完整事实而非只相信客户端digest；包含全部行、映射、schema和目标身份。
  return {draft,fingerprint:industryUpdateCanonical(draft),summary}
 }
 const approved=new WeakMap<ToolExecution,{current:Authorized;prepared?:Awaited<ReturnType<typeof prepare>>}>()
 const definitions:ReadonlyArray<{name:typeof businessImportToolNames[number];description:string;parameters:ParameterSchemaSpec}>=[
  {name:read,description:'读取当前本人正式业务的CSV或XLSX导入草案（mode=get,draftId）或原固定回执（mode=receipt,requestId），XLSX保留准确文件和工作表。不得猜工作表。不接owner/scope/原始行/附件ID。冷恢复只查原requestId，不恢复原Agent；空回执不能证明未受理，不得换请求重复导入。',parameters:{mode:{type:'string',enum:['get','receipt'],required:true},draftId:{type:'string'},requestId:{type:'string'}}},
  {name:apply,description:'经本人原生确认完整批次后原子采用CSV或XLSX导入预览，XLSX确认准确文件和工作表。只接draftId/previewRevision/previewDigest；先read get核全部行和业务。不得传owner/scope/requestId/原始行/附件ID。自动allow仍要求原生ask，最多128KiB完整确认，不截行。同一本人指令固定一批；结果未知先read receipt核原请求，不换指令重写。',parameters:{draftId:{type:'string',required:true},previewRevision:{type:'integer',required:true},previewDigest:{type:'string',required:true}}},
 ]
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  const fixed=approved.get(exec),current=await authorize(exec)
  if(!fixed)throw new WorkError('teloa/conflict','缺少本次原生导入工具授权。')
  same(fixed.current,current)
  if(definition.name===read){
   const query=readQuery(args,current.scope)
   const result=query.mode==='get'?{draft:await get(current,query.input)}:{requestId:query.input.requestId,result:await receipt(current,query.input.requestId),note:unknownNotice}
   same(current,await authorize(exec));return json(result)
  }
  const input=applyInput(args,requestId(current.actor.ownerId,current.instruction)),prepared=await prepare(current,input)
  if(!fixed.prepared||fixed.prepared.fingerprint!==prepared.fingerprint)throw conflict()
  same(fixed.current,await authorize(exec));exec.signal.throwIfAborted()
  try{
   const result=await ports.imports.apply(current.actor,input,exec.signal)
   return json({requestId:input.requestId,result:checkReceipt(result,current,input,prepared.draft),note:unknownNotice})
  }catch(error){
   if(exec.signal.aborted||error instanceof WorkError&&['teloa/forbidden','teloa/invalid-input','teloa/conflict','teloa/version-conflict','teloa/not-found'].includes(error.code))throw error
   throw new WorkError('teloa/host-unavailable','导入结果尚未确认，请用teloa_business_import_read的mode=receipt核原requestId='+input.requestId+'；保留原草案和冻结输入，不换本人指令重复导入。')
  }
 }}))
 return ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!names.has(exec.name))return next()
  let fixed:{current:Authorized;prepared?:Awaited<ReturnType<typeof prepare>>}
  try{
   const current=await authorize(exec)
   if(exec.name===read){readQuery(exec.arguments,current.scope);fixed={current}}
   else fixed={current,prepared:await prepare(current,applyInput(exec.arguments,requestId(current.actor.ownerId,current.instruction)))}
   same(current,await authorize(exec));approved.set(exec,fixed)
  }catch(error){return {kind:'deny' as const,reason:error instanceof WorkError?error.message:'无法核对本人业务的完整导入预览。'}}
  const decision=await next()
  if(decision.kind==='deny'||decision.kind==='cancel'||!fixed.prepared)return decision
  const reason=(decision.kind==='ask'&&decision.reason?decision.reason+'\n':'')+'确认采用以下完整业务导入批次？'+JSON.stringify(fixed.prepared.summary)
  if(Buffer.byteLength(reason,'utf8')>approvalBytes)return {kind:'deny' as const,reason:'确认内容超过128KiB，请缩小批次后重试；不能截断确认，尚未导入任何记录。'}
  return {kind:'ask' as const,reason}
 })
}
