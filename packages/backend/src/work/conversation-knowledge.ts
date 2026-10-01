import {createHash} from 'node:crypto'
import type {Pool} from 'pg'
import {WorkError,isKnowledgeSaveReceipt,isRecord,parseConversationKnowledgeCommand,resourceId,resourceVersion,type ConversationKnowledgeCommand,type KnowledgeItem,type KnowledgeSaveReceipt,type PasteKnowledge,type ResourceDraft,type WorkResource} from '@teloa/contract'
import {authorizeResourceActor,type ResourceActor} from '../capabilities/resources.ts'
import {normalizePasteMarkdown} from '../capabilities/markdown-knowledge.ts'
import {markdownKnowledgeReferenceId} from '../capabilities/markdown-knowledge-catalog.ts'

type KnowledgePort={createPaste(actor:ResourceActor,input:unknown):Promise<PasteKnowledge>;list(actor:ResourceActor,input:unknown):Promise<KnowledgeItem[]>;readVersion(actor:ResourceActor,input:unknown):Promise<PasteKnowledge['version']>}
type ResourcePort={create(actor:ResourceActor,input:unknown):Promise<ResourceDraft>;apply(actor:ResourceActor,input:unknown):Promise<WorkResource>;findDraft(actor:ResourceActor,input:unknown):Promise<ResourceDraft|null>;getResource(actor:ResourceActor,input:unknown):Promise<WorkResource>}
type Stage='prepared'|'knowledge-saved'|'resource-applying'|'active'|'failed'
type Operation={ownerId:string;requestId:string;commandHash:string;commandSpec:CommandSpec;stage:Stage;failedStage?:Exclude<Stage,'active'|'failed'>;knowledgeId?:string;knowledgeVersion?:number;contentHash?:string;resourceDraftId?:string;resourceId?:string;receipt?:KnowledgeSaveReceipt;error?:{code:string;message:string}}
type CommandSpec={schema:'teloa.conversation-knowledge-operation/v1';origin:ConversationKnowledgeCommand['origin'];subject:Omit<ConversationKnowledgeCommand['subject'],'markdown'>&{contentHash:string};target:ConversationKnowledgeCommand['target']}

const unavailable=()=>new WorkError('teloa/storage-unavailable','工作资料保存状态当前不可用，请沿用原请求核对。')
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const childRequest=(requestId:string,label:string)=>{const value=hash(['teloa-conversation-knowledge-child/v1',requestId,label].join('\0'));return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`}
const needsRecovery=(error:unknown)=>!(error instanceof WorkError)||['teloa/storage-unavailable','teloa/host-unavailable'].includes(error.code)
const safeError=(error:unknown)=>error instanceof WorkError?{code:error.code,message:error.message}:{code:'teloa/storage-unavailable',message:'保存结果尚未确认，请核对后恢复。'}
const corrupt=()=>new WorkError('teloa/storage-corrupt','工作资料保存操作记录损坏。')
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new WorkError('teloa/storage-corrupt','工作资料保存操作记录损坏。');return value}
function storedSpec(value:unknown,requestId:string):CommandSpec{
 const row=exact(value,['schema','origin','subject','target']),subject=exact(row.subject,['sessionId','messageId','seq','role','at','selectionHash','contentHash'])
 if(row.schema!=='teloa.conversation-knowledge-operation/v1'||typeof subject.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(subject.contentHash))throw new WorkError('teloa/storage-corrupt','工作资料保存操作记录损坏。')
 let command:ConversationKnowledgeCommand
 try{command=parseConversationKnowledgeCommand({schema:'teloa.conversation-knowledge-command/v1',requestId,origin:row.origin,subject:{sessionId:subject.sessionId,messageId:subject.messageId,seq:subject.seq,role:subject.role,at:subject.at,selectionHash:subject.selectionHash,markdown:'# 固定正文'},target:row.target})}catch{throw new WorkError('teloa/storage-corrupt','工作资料保存操作记录损坏。')}
 return {schema:'teloa.conversation-knowledge-operation/v1',origin:command.origin,subject:{sessionId:command.subject.sessionId,messageId:command.subject.messageId,seq:command.subject.seq,role:command.subject.role,at:command.subject.at,selectionHash:command.subject.selectionHash,contentHash:subject.contentHash},target:command.target}
}
function storedError(value:unknown):{code:string;message:string}|undefined{
 if(value===null||value===undefined)return undefined
 if(!isRecord(value)||Object.keys(value).some(key=>!['code','message'].includes(key))||typeof value.code!=='string'||!/^teloa\/[a-z0-9-]+$/.test(value.code)||typeof value.message!=='string'||!value.message)return undefined
 return {code:value.code,message:value.message}
}

function operationRow(row:Record<string,unknown>):Operation{
 if(typeof row.owner_id!=='string'||!row.owner_id||!resourceId(row.request_id)||typeof row.command_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.command_hash)||!row.command_spec||typeof row.command_spec!=='object'||!['prepared','knowledge-saved','resource-applying','active','failed'].includes(String(row.stage)))throw corrupt()
 if(row.failed_stage!==null&&row.failed_stage!==undefined&&!['prepared','knowledge-saved','resource-applying'].includes(String(row.failed_stage)))throw corrupt()
 const failedStage=['prepared','knowledge-saved','resource-applying'].includes(String(row.failed_stage))?row.failed_stage as Exclude<Stage,'active'|'failed'>:undefined
 const commandSpec=storedSpec(row.command_spec,row.request_id),error=storedError(row.error)
 if(hash(JSON.stringify(commandSpec))!==row.command_hash||(row.error!==null&&row.error!==undefined&&!error)||(row.receipt!==null&&row.receipt!==undefined&&!isKnowledgeSaveReceipt(row.receipt)))throw corrupt()
 const value:Operation={ownerId:row.owner_id,requestId:row.request_id,commandHash:row.command_hash,commandSpec,stage:row.stage as Stage,...(failedStage?{failedStage}:{}),...(typeof row.knowledge_id==='string'?{knowledgeId:row.knowledge_id}:{}),...(typeof row.knowledge_version==='number'?{knowledgeVersion:row.knowledge_version}:{}),...(typeof row.content_hash==='string'?{contentHash:row.content_hash}:{}),...(typeof row.resource_draft_id==='string'?{resourceDraftId:row.resource_draft_id}:{}),...(typeof row.resource_id==='string'?{resourceId:row.resource_id}:{}),...(row.receipt&&isKnowledgeSaveReceipt(row.receipt)?{receipt:row.receipt}:{}),...(error?{error}:{})}
 const hasKnowledge=resourceId(value.knowledgeId)&&resourceVersion(value.knowledgeVersion)&&typeof value.contentHash==='string'&&/^[a-f0-9]{64}$/.test(value.contentHash)&&value.contentHash===commandSpec.subject.contentHash
 const hasDraft=resourceId(value.resourceDraftId),hasResource=resourceId(value.resourceId)
 const noKnowledge=value.knowledgeId===undefined&&value.knowledgeVersion===undefined&&value.contentHash===undefined
 const noProjection=value.resourceDraftId===undefined&&value.resourceId===undefined
 if(value.stage==='prepared'&&(!noKnowledge||!noProjection||value.receipt||value.failedStage))throw corrupt()
 if(value.stage==='knowledge-saved'&&(!hasKnowledge||!noProjection||value.receipt||value.failedStage))throw corrupt()
 if(value.stage==='resource-applying'&&(!hasKnowledge||!hasDraft||hasResource||value.receipt||value.failedStage))throw corrupt()
 if(value.stage==='active'&&(!hasKnowledge||!hasDraft||!hasResource||!value.receipt||value.error||value.failedStage))throw corrupt()
 if(value.stage==='failed'&&(!value.failedStage||!value.error||value.receipt||(value.failedStage==='prepared'&&(!noKnowledge||!noProjection))||(value.failedStage==='knowledge-saved'&&(!hasKnowledge||!noProjection))||(value.failedStage==='resource-applying'&&(!hasKnowledge||!hasDraft||hasResource))))throw corrupt()
 if(value.receipt&&(value.receipt.requestId!==value.requestId||value.receipt.title!==commandSpec.target.title||value.receipt.category!==commandSpec.target.category||JSON.stringify(value.receipt.topics)!==JSON.stringify(commandSpec.target.topics)||value.receipt.source.sessionId!==commandSpec.subject.sessionId||value.receipt.source.messageId!==commandSpec.subject.messageId||value.receipt.source.seq!==commandSpec.subject.seq||value.receipt.source.selectionHash!==commandSpec.subject.selectionHash||value.receipt.status!=='active'||value.receipt.knowledge.id!==value.knowledgeId||value.receipt.knowledge.version!==value.knowledgeVersion||value.receipt.knowledge.contentHash!==value.contentHash||value.receipt.resource.id!==value.resourceId))throw corrupt()
 return value
}

export class ConversationKnowledgeService{
 private readonly pool:Pool
 private readonly knowledge:KnowledgePort
 private readonly resources:ResourcePort
 private readonly now:()=>string
 constructor(pool:Pool,knowledge:KnowledgePort,resources:ResourcePort,now:()=>string){this.pool=pool;this.knowledge=knowledge;this.resources=resources;this.now=now}
 private spec(command:ConversationKnowledgeCommand,markdown:string):{spec:CommandSpec;digest:string}{
  const spec:CommandSpec={schema:'teloa.conversation-knowledge-operation/v1',origin:command.origin,subject:{sessionId:command.subject.sessionId,messageId:command.subject.messageId,seq:command.subject.seq,role:command.subject.role,at:command.subject.at,selectionHash:command.subject.selectionHash,contentHash:hash(markdown)},target:command.target}
  return {spec,digest:hash(JSON.stringify(spec))}
 }
 private async prepare(ownerId:string,command:ConversationKnowledgeCommand,markdown:string):Promise<Operation>{
  const {spec,digest}=this.spec(command,markdown),now=this.now()
  try{
   await this.pool.query(`insert into teloa_conversation_knowledge_operations(owner_id,request_id,command_hash,command_spec,stage,created_at,updated_at) values($1,$2,$3,$4,'prepared',$5,$5) on conflict(owner_id,request_id) do nothing`,[ownerId,command.requestId,digest,JSON.stringify(spec),now])
   const row=(await this.pool.query('select * from teloa_conversation_knowledge_operations where owner_id=$1 and request_id=$2',[ownerId,command.requestId])).rows[0]
   if(!row)throw unavailable();const operation=operationRow(row)
   if(operation.commandHash!==digest)throw new WorkError('teloa/conflict','同一请求 ID 不能保存另一条消息或改变资料分类与范围。')
   return operation
  }catch(error){if(error instanceof WorkError)throw error;throw unavailable()}
 }
 private base(operation:Operation){const spec=operation.commandSpec;return {schema:'teloa.knowledge-save-receipt/v1' as const,requestId:operation.requestId,title:spec.target.title,category:spec.target.category,topics:[...spec.target.topics],workspaceId:'default' as const,scopeIds:['general'] as ['general'],source:{sessionId:spec.subject.sessionId,messageId:spec.subject.messageId,seq:spec.subject.seq,selectionHash:spec.subject.selectionHash}}}
 private async read(ownerId:string,requestId:string):Promise<Operation>{
  let row:Record<string,unknown>|undefined
  try{row=(await this.pool.query('select * from teloa_conversation_knowledge_operations where owner_id=$1 and request_id=$2',[ownerId,requestId])).rows[0]}catch{throw unavailable()}
  if(!row)throw unavailable()
  return operationRow(row)
 }
 private async transition(ownerId:string,requestId:string,expected:Exclude<Stage,'active'|'failed'>,patch:{stage:Stage;failedStage?:Exclude<Stage,'active'|'failed'>;knowledgeId?:string;knowledgeVersion?:number;contentHash?:string;resourceDraftId?:string;resourceId?:string;receipt?:KnowledgeSaveReceipt;error?:{code:string;message:string}}):Promise<Operation>{
  const fields=['stage=$4','updated_at=$5','receipt=$6','error=$7','failed_stage=$8'],values:unknown[]=[ownerId,requestId,expected,patch.stage,this.now(),patch.receipt?JSON.stringify(patch.receipt):null,patch.error?JSON.stringify(patch.error):null,patch.failedStage??null]
  const add=(column:string,value:unknown)=>{values.push(value);fields.push(column+'=$'+values.length)}
  if(patch.knowledgeId)add('knowledge_id',patch.knowledgeId);if(patch.knowledgeVersion)add('knowledge_version',patch.knowledgeVersion);if(patch.contentHash)add('content_hash',patch.contentHash);if(patch.resourceDraftId)add('resource_draft_id',patch.resourceDraftId);if(patch.resourceId)add('resource_id',patch.resourceId)
  try{
   const row=(await this.pool.query('update teloa_conversation_knowledge_operations set '+fields.join(',')+' where owner_id=$1 and request_id=$2 and stage=$3 returning *',values)).rows[0] as Record<string,unknown>|undefined
   return row?operationRow(row):this.read(ownerId,requestId)
  }catch(error){if(error instanceof WorkError)throw error;throw unavailable()}
 }
 private receipt(operation:Operation):KnowledgeSaveReceipt{
  if(operation.stage==='active')return operation.receipt!
  if(operation.stage==='failed')return {...this.base(operation),status:'failed',stage:operation.failedStage!,error:operation.error!}
  return {...this.base(operation),status:'needs-recovery',stage:operation.stage}
 }
 private async active(actor:ResourceActor,operation:Operation):Promise<KnowledgeSaveReceipt>{
  if(operation.stage!=='active')throw corrupt()
  const receipt=operation.receipt!
  if(receipt.status!=='active')throw corrupt()
  let item:KnowledgeItem|undefined,version:PasteKnowledge['version'],resource:WorkResource
  try{
   const [items,fixed,current]=await Promise.all([this.knowledge.list(actor,{}),this.knowledge.readVersion(actor,{knowledgeId:operation.knowledgeId,version:operation.knowledgeVersion}),this.resources.getResource(actor,{resourceId:operation.resourceId})])
   item=items.find(row=>row.id===operation.knowledgeId);version=fixed;resource=current
  }catch(error){if(error instanceof WorkError&&['teloa/storage-unavailable','teloa/host-unavailable'].includes(error.code))throw error;throw corrupt()}
  const spec=operation.commandSpec.target,sourceId=markdownKnowledgeReferenceId(operation.knowledgeId!)
  if(!item||item.ownerId!==actor.ownerId||item.workspaceId!==spec.workspaceId||item.status!=='active'||item.currentVersion!==operation.knowledgeVersion||item.title!==spec.title||item.category!==spec.category||JSON.stringify(item.topics)!==JSON.stringify(spec.topics)||JSON.stringify(item.scopeIds)!==JSON.stringify(spec.scopeIds)||version.ownerId!==actor.ownerId||version.knowledgeId!==item.id||version.sourceId!==item.sourceId||version.version!==operation.knowledgeVersion||version.contentHash!==operation.contentHash||resource.ownerId!==actor.ownerId||resource.status!=='active'||resource.title!==spec.title||resource.sourceId!==sourceId||resource.sourceVersion!==operation.contentHash||JSON.stringify(resource.scopeIds)!==JSON.stringify(spec.scopeIds)||resource.id!==operation.resourceId||resource.version!==receipt.resource.version)throw corrupt()
  return receipt
 }
 private async resolved(actor:ResourceActor,operation:Operation):Promise<KnowledgeSaveReceipt>{return operation.stage==='active'?this.active(actor,operation):this.receipt(operation)}
 async get(actor:ResourceActor,input:unknown):Promise<KnowledgeSaveReceipt|null>{
  authorizeResourceActor(actor,actor.ownerId,[],true);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='requestId')||!resourceId((input as {requestId?:unknown}).requestId))throw new WorkError('teloa/invalid-input','工作资料恢复请求格式不正确。')
  let row;try{row=(await this.pool.query('select * from teloa_conversation_knowledge_operations where owner_id=$1 and request_id=$2',[actor.ownerId,(input as {requestId:string}).requestId])).rows[0]}catch{throw unavailable()}
  if(!row)return null;return this.resolved(actor,operationRow(row))
 }
 async save(actor:ResourceActor,input:unknown):Promise<KnowledgeSaveReceipt>{
  authorizeResourceActor(actor,actor.ownerId,['general'],true)
  let command:ConversationKnowledgeCommand;try{command=parseConversationKnowledgeCommand(input)}catch{throw new WorkError('teloa/invalid-input','会话工作资料命令格式不正确或包含未知字段。')}
  const markdown=normalizePasteMarkdown(command.subject.markdown);let operation=await this.prepare(actor.ownerId,command,markdown)
  if(operation.stage==='active'||operation.stage==='failed')return this.resolved(actor,operation)
  try{
   const saved=await this.knowledge.createPaste(actor,{requestId:command.requestId,title:command.target.title,category:command.target.category,topics:command.target.topics,scopeIds:command.target.scopeIds,markdown})
   if(saved.item.ownerId!==actor.ownerId||saved.item.workspaceId!=='default'||saved.item.title!==command.target.title||saved.item.category!==command.target.category||JSON.stringify(saved.item.topics)!==JSON.stringify(command.target.topics)||JSON.stringify(saved.item.scopeIds)!==JSON.stringify(command.target.scopeIds)||saved.version.contentHash!==operation.commandSpec.subject.contentHash)throw new WorkError('teloa/storage-corrupt','知识保存结果与会话命令不一致。')
   if(operation.stage==='prepared')operation=await this.transition(actor.ownerId,command.requestId,'prepared',{stage:'knowledge-saved',knowledgeId:saved.item.id,knowledgeVersion:saved.version.version,contentHash:saved.version.contentHash})
   if(operation.stage==='active'||operation.stage==='failed')return this.resolved(actor,operation)
   if(operation.knowledgeId!==saved.item.id||operation.knowledgeVersion!==saved.version.version||operation.contentHash!==saved.version.contentHash)throw corrupt()
   const draft=await this.resources.create(actor,{requestId:childRequest(command.requestId,'resource'),title:saved.item.title,sourceId:markdownKnowledgeReferenceId(saved.item.id),sourceVersion:saved.version.contentHash,scopeIds:saved.item.scopeIds})
   if(operation.stage==='knowledge-saved')operation=await this.transition(actor.ownerId,command.requestId,'knowledge-saved',{stage:'resource-applying',resourceDraftId:draft.id})
   if(operation.stage==='active'||operation.stage==='failed')return this.resolved(actor,operation)
   if(operation.resourceDraftId!==draft.id)throw corrupt()
   const resource=draft.status==='applied'&&draft.resourceId?await this.resources.getResource(actor,{resourceId:draft.resourceId}):await this.resources.apply(actor,{draftId:draft.id,expectedVersion:draft.version})
   if(resource.ownerId!==actor.ownerId||resource.sourceId!==markdownKnowledgeReferenceId(saved.item.id)||resource.sourceVersion!==saved.version.contentHash||resource.status!=='active')throw new WorkError('teloa/storage-corrupt','工作资料投影结果与知识版本不一致。')
   const receipt:KnowledgeSaveReceipt={...this.base(operation),status:'active',knowledge:{id:saved.item.id,version:saved.version.version,contentHash:saved.version.contentHash},resource:{id:resource.id,version:resource.version}}
   operation=await this.transition(actor.ownerId,command.requestId,'resource-applying',{stage:'active',knowledgeId:saved.item.id,knowledgeVersion:saved.version.version,contentHash:saved.version.contentHash,resourceDraftId:draft.id,resourceId:resource.id,receipt})
   return this.resolved(actor,operation)
  }catch(error){
   const failure=safeError(error),status=needsRecovery(error)?'needs-recovery' as const:'failed' as const
   if(operation.stage==='active'||operation.stage==='failed')return this.resolved(actor,operation)
   let current:Operation
   try{current=await this.transition(actor.ownerId,command.requestId,operation.stage,{stage:status==='failed'?'failed':operation.stage,...(status==='failed'?{failedStage:operation.stage}:{}),error:failure})}
   catch(transitionError){
    if(transitionError instanceof WorkError&&transitionError.code==='teloa/storage-corrupt')throw transitionError
    return {...this.base(operation),status:'needs-recovery',stage:operation.stage}
   }
   return this.resolved(actor,current)
  }
 }
}
