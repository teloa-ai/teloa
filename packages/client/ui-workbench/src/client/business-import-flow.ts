import {
 industryUpdateCanonical,readBusinessImportStageInput,readBusinessImportStageReceiptInput,readBusinessImportApplyInput,readBusinessImportRevisionInput,
 readBusinessImportMapping,readBusinessImportDraft,readBusinessImportReceipt,readBusinessRichFieldValue,
 readBusinessImportAnyDraft,readBusinessImportAnyReceipt,readBusinessImportAnyStageInput,readBusinessImportMappingV2,readBusinessImportSourceV2,readBusinessImportPolicyV2,
 type BusinessImportDraft,type BusinessImportInspection,type BusinessImportPreview,type BusinessImportMapping,type BusinessImportStageInput,
 type BusinessImportStageReceiptInput,type BusinessImportApplyInput,type BusinessImportRevisionInput,type BusinessImportReceipt,
 type BusinessObjectTypeDefinition,type BusinessObjectTypeDefinitionV2,
 type BusinessImportAnyDraft,type BusinessImportAnyInspection,type BusinessImportAnyReceipt,type BusinessImportAnyStageInput,type BusinessImportWorkbookV2,type BusinessImportSourceV2,type BusinessImportMappingV2,type BusinessImportPreviewV2,
} from '@teloa/contract'
import {businessImportApplyRejectedCode,type BusinessImportApi} from './business-import-api.ts'
import type {BusinessRecordApi} from './business-record-api.js'
export type BusinessImportDefinition=BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2
export type BusinessImportJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
type StageRequest={phase:'stage';input:BusinessImportStageReceiptInput&{name:string;bytes:number};inputDigest:string;fileHash:string;source?:BusinessImportSourceV2;policy?:BusinessImportWorkbookV2['policy']}
type ApplyRequest={phase:'apply';input:BusinessImportApplyInput;draft:BusinessImportAnyDraft}
type RevisionRequest={phase:'cancel'|'resume';input:BusinessImportRevisionInput;draft:BusinessImportAnyDraft}
type Pending=StageRequest|ApplyRequest|RevisionRequest
type RejectedApply={phase:'apply-rejected';input:BusinessImportApplyInput;draft:BusinessImportAnyDraft;errorCode:string}
type SavedRequest=Pending|RejectedApply
export type BusinessImportPhase='idle'|'ready'|'previewed'|'cancelled'|'applied'|'checking-workbook'|'selecting-sheet'|'staging'|'inspecting'|'previewing'|'applying'|'cancelling'|'resuming'|'reconciling'|'unknown'|'error'|'recovery-error'
export type BusinessImportRelation={id:string;type:string;title:string;archived:boolean}
export type BusinessImportState={phase:BusinessImportPhase;workbook?:BusinessImportWorkbookV2|undefined;draft?:BusinessImportAnyDraft|undefined;inspection?:BusinessImportAnyInspection|undefined;mapping?:BusinessImportMapping|BusinessImportMappingV2|undefined;preview?:BusinessImportPreview|BusinessImportPreviewV2|undefined;receipt?:BusinessImportAnyReceipt|undefined;pending?:Pending|undefined;errorCode?:string|undefined;relations:Record<string,BusinessImportRelation>;relationsReady:boolean}
export type BusinessImportPorts={api:BusinessImportApi;records?:Pick<BusinessRecordApi,'get'>;ownerId:string;personalSpaceId:string;scope:string;type:string;journal:BusinessImportJournal;isCurrent:()=>boolean;id?:()=>string}
const code=(error:unknown)=>error&&typeof error==='object'&&'code'in error?String(error.code):'teloa/transport-unknown'
const invalid=()=>Object.assign(Error('导入回包与原业务或请求不一致。'),{code:'teloa/invalid-host-response'})
const locked=(state:BusinessImportState)=>['checking-workbook','staging','inspecting','previewing','applying','cancelling','resuming','reconciling','unknown','recovery-error'].includes(state.phase)
const exact=(value:unknown,keys:string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))throw invalid();return value as Record<string,unknown>}
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const same=(a:unknown,b:unknown)=>industryUpdateCanonical(a)===industryUpdateCanonical(b)
function freeze<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const item of Object.values(value))freeze(item);Object.freeze(value)}return value}
async function sha(bytes:Uint8Array){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as Uint8Array<ArrayBuffer>))].map(b=>b.toString(16).padStart(2,'0')).join('')}
async function stageEvidence(input:BusinessImportAnyStageInput){const {requestId:_,...body}=input;return {inputDigest:await sha(new TextEncoder().encode(industryUpdateCanonical(body))),fileHash:await sha(Uint8Array.from(atob(input.dataBase64),c=>c.charCodeAt(0)))}}
/** 一实例固定实际本人、Personal Space、业务及 API 代次；展示名不参与归属。 */
export class BusinessImportFlow{
 readonly scope:string;readonly type:string
 private readonly ports:BusinessImportPorts
 private definition?:BusinessImportDefinition
 private definitionGeneration=0
 private refreshRequired=false
 private state:BusinessImportState={phase:'idle',relations:{},relationsReady:true}
 private readonly listeners=new Set<()=>void>()
 private controller?:AbortController
 private disposed=false
 private ownedJournal:string|null=null
 constructor(ports:BusinessImportPorts){
  this.ports={...ports};this.scope=ports.scope;this.type=ports.type
  try{
   if(!ports.ownerId||!ports.personalSpaceId)throw invalid()
   const raw=ports.journal.read();this.ownedJournal=raw;if(raw===null)return
   // 覆盖契约 50×50 字段的最坏 JSON 转义，不另缩小合法预览正文。
   if(raw.length>32_000_000)throw invalid()
   const row=exact(JSON.parse(raw),['format','ownerId','personalSpaceId','scope','type','request'])
   if(row.format!=='teloa.business-import-request/v1'&&row.format!=='teloa.business-import-request/v2'||row.ownerId!==ports.ownerId||row.personalSpaceId!==ports.personalSpaceId||row.scope!==this.scope||row.type!==this.type)throw invalid()
   const request=row.request as SavedRequest
   if(request.phase==='stage'){
    const v2=row.format==='teloa.business-import-request/v2',r=exact(request,v2?['phase','input','inputDigest','fileHash','source','policy']:['phase','input','inputDigest','fileHash']),input=exact(r.input,['requestId','scope','type','name','bytes'])
    const target=readBusinessImportStageReceiptInput({requestId:input.requestId,scope:input.scope,type:input.type})
    if(target.scope!==this.scope||target.type!==this.type||typeof input.name!=='string'||!Number.isSafeInteger(input.bytes)||Number(input.bytes)<0||Number(input.bytes)>2_097_152||!hash(r.inputDigest)||!hash(r.fileHash))throw invalid()
    readBusinessImportStageInput({...target,name:input.name,bytes:0,dataBase64:''})
    const source=v2?readBusinessImportSourceV2(r.source):undefined,policy=v2?readBusinessImportPolicyV2(r.policy):undefined
    const pending:StageRequest={phase:'stage',input:{...target,name:input.name,bytes:Number(input.bytes)},inputDigest:r.inputDigest,fileHash:r.fileHash,...(source&&policy?{source,policy}:{})};this.state={...this.state,phase:'unknown',pending}
   }else{
    const rejected=request.phase==='apply-rejected',r=exact(request,rejected?['phase','input','draft','errorCode']:['phase','input','draft']),draft=this.target(readBusinessImportAnyDraft(r.draft))
    if((row.format==='teloa.business-import-request/v2')!==(draft.format==='teloa.business-record-import/v2'))throw invalid()
    const input=r.phase==='apply'||rejected?readBusinessImportApplyInput(r.input):r.phase==='cancel'||r.phase==='resume'?readBusinessImportRevisionInput(r.input):(()=>{throw invalid()})()
    if(input.draftId!==draft.id||(r.phase==='apply'||rejected)&&(!draft.preview||'previewRevision'in input&&(input.previewRevision!==draft.preview.revision||input.previewDigest!==draft.preview.digest)))throw invalid()
    if(rejected){if(!businessImportApplyRejectedCode({rejected:true,code:r.errorCode}))throw invalid();this.refreshRequired=true;this.state={...this.state,phase:'error',draft,mapping:draft.mapping,relationsReady:false,errorCode:String(r.errorCode)};return}
    const pending={phase:r.phase,input,draft} as ApplyRequest|RevisionRequest
    this.state={...this.state,phase:'unknown',pending,draft,mapping:draft.mapping,preview:draft.preview,relationsReady:false}
   }
  }catch{this.state={...this.state,phase:'recovery-error',errorCode:'teloa/recovery-storage-unavailable'}}
 }
 getSnapshot=()=>freeze(this.state)
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener)}}
 isCurrent=()=>!this.disposed&&this.ports.isCurrent()
 dispose(){this.disposed=true;this.controller?.abort();this.listeners.clear()}
 private update(patch:Partial<BusinessImportState>){if(!this.isCurrent())return;this.state={...this.state,...patch};for(const listener of this.listeners)listener()}
 configure(definition:BusinessImportDefinition){
  if(definition.domain!==this.scope||definition.id!==this.type)throw invalid()
  const changed=this.definition&&industryUpdateCanonical(this.definition)!==industryUpdateCanonical(definition);this.definition=freeze(structuredClone(definition))
  if(changed){this.definitionGeneration++;if(!locked(this.state)||this.state.phase==='previewing')this.update({preview:undefined,relations:{},relationsReady:false,errorCode:'teloa/schema-changed'})}
 }
 private assertEditable(){if(!this.isCurrent()||locked(this.state))throw Object.assign(Error('导入在途或结果未知，请先核对原请求。'),{code:'teloa/conflict'})}
 private target(draft:BusinessImportAnyDraft){if(draft.ownerId!==this.ports.ownerId||draft.scope!==this.scope||draft.type!==this.type)throw invalid();return draft}
 private acceptTarget(draft:BusinessImportAnyDraft,signal:AbortSignal){if(!this.isCurrent()||signal.aborted)throw invalid();return this.target(draft)}
 private checkImmutableDraft(previous:BusinessImportAnyDraft,current:BusinessImportAnyDraft){
  if(previous.id!==current.id||previous.format!==current.format||previous.stageRequestId!==current.stageRequestId||previous.sourceIdentity!==current.sourceIdentity||!same(previous.file,current.file))throw invalid()
  if(previous.format==='teloa.business-record-import/v2'&&current.format==='teloa.business-record-import/v2'&&(!same(previous.source,current.source)||!same(previous.policy,current.policy)))throw invalid()
 }
 private checkStage(draft:BusinessImportAnyDraft,request:StageRequest,signal:AbortSignal){this.acceptTarget(draft,signal);if(draft.stageRequestId!==request.input.requestId||draft.file.name!==request.input.name||draft.file.bytes!==request.input.bytes||draft.file.sha256!==request.fileHash||(draft.format==='teloa.business-record-import/v2')!==!!request.source)throw invalid();if(draft.format==='teloa.business-record-import/v2'&&(!same(draft.source,request.source)||!same(draft.policy,request.policy)))throw invalid()}
 private persist(request:SavedRequest){
  if(!this.isCurrent())throw invalid()
  if(this.ports.journal.read()!==this.ownedJournal)throw Object.assign(Error('恢复记录已由另一个页面更新。'),{code:'teloa/recovery-storage-unavailable'})
  const raw=JSON.stringify({format:request.phase==='stage'?request.source?'teloa.business-import-request/v2':'teloa.business-import-request/v1':request.draft.format==='teloa.business-record-import/v2'?'teloa.business-import-request/v2':'teloa.business-import-request/v1',ownerId:this.ports.ownerId,personalSpaceId:this.ports.personalSpaceId,scope:this.scope,type:this.type,request})
  try{this.ports.journal.write(raw);this.ownedJournal=raw}catch{throw Object.assign(Error('恢复记录暂时无法保存。'),{code:'teloa/recovery-storage-unavailable'})}
 }
 private clearJournal(draft:BusinessImportAnyDraft){
  if(!this.isCurrent())return
  if(this.ports.journal.read()!==this.ownedJournal)throw invalid()
  if(this.ownedJournal!==null){const request=JSON.parse(this.ownedJournal).request as SavedRequest;if(request.phase==='stage'?request.input.requestId!==draft.stageRequestId:request.input.draftId!==draft.id)throw invalid()}
  this.ports.journal.clear();this.ownedJournal=null
 }
 private async operation(phase:BusinessImportPhase,run:(signal:AbortSignal)=>Promise<void>,unknown=false){
  if(!this.isCurrent())return
  this.controller?.abort();const controller=new AbortController();this.controller=controller;this.update({phase,errorCode:undefined})
  try{await run(controller.signal)}catch(error){if(this.isCurrent()&&this.controller===controller){const errorCode=code(error);this.update({phase:errorCode==='teloa/recovery-storage-unavailable'?'recovery-error':unknown?'unknown':'error',errorCode})}}
 }
 private adopt(draft:BusinessImportAnyDraft){
  this.target(draft);this.refreshRequired=false
  if(draft.status==='applied'&&draft.receipt){this.clearJournal(draft);this.update({phase:'applied',draft,mapping:draft.mapping,preview:draft.preview,receipt:draft.receipt,pending:undefined,errorCode:undefined});return}
  this.update({phase:draft.status,draft,mapping:draft.mapping,preview:draft.status==='previewed'?draft.preview:undefined,pending:undefined,errorCode:undefined,relations:{},relationsReady:!draft.preview})
 }
 async inspectWorkbook(file:Omit<BusinessImportStageInput,'requestId'|'scope'|'type'>){
  this.assertEditable()
  await this.operation('checking-workbook',async signal=>{
   const workbook=await this.ports.api.workbook({...file,scope:this.scope,type:this.type},signal)
   if(!this.isCurrent()||signal.aborted)return
   this.update({phase:'selecting-sheet',workbook,draft:undefined,inspection:undefined,mapping:undefined,preview:undefined,receipt:undefined})
  })
 }
 async stage(file:Omit<BusinessImportStageInput,'requestId'|'scope'|'type'>,source?:BusinessImportSourceV2){
  this.assertEditable()
  if(source){const workbook=this.state.workbook;if(!workbook||!workbook.sheets.some(sheet=>same(sheet,source.sheet)))throw invalid()}
  const input=readBusinessImportAnyStageInput({...file,requestId:(this.ports.id??(()=>crypto.randomUUID()))(),scope:this.scope,type:this.type,...(source?{format:'teloa.business-import-stage/v2',source}:{})})
  // 先锁住哈希计算期间的双击，网络发送前必须完成 journal。
  await this.operation('staging',async signal=>{
   const evidence=await stageEvidence(input);if(!this.isCurrent()||signal.aborted)return
   if(source&&(this.state.workbook?.fileHash!==evidence.fileHash||this.state.workbook?.bytes!==input.bytes)){this.update({phase:'selecting-sheet',errorCode:'teloa/file-changed'});return}
   const metadata={requestId:input.requestId,scope:input.scope,type:input.type,name:input.name,bytes:input.bytes},request:StageRequest={phase:'stage',input:metadata,...evidence,...(source?{source,policy:this.state.workbook!.policy}:{})}
   this.update({pending:request,draft:undefined,preview:undefined,inspection:undefined,mapping:undefined,receipt:undefined});this.persist(request)
   const draft=await this.ports.api.stage(input,signal,value=>this.checkStage(value,request,signal));if(!this.isCurrent()||signal.aborted)return;this.adopt(draft)
  },true)
 }
 async retryStage(file:Omit<BusinessImportStageInput,'requestId'|'scope'|'type'>){
  const pending=this.state.pending;if(pending?.phase!=='stage'||this.state.phase!=='unknown'||!this.isCurrent())throw invalid()
  const input=readBusinessImportAnyStageInput({...file,requestId:pending.input.requestId,scope:pending.input.scope,type:pending.input.type,...(pending.source?{format:'teloa.business-import-stage/v2',source:pending.source}:{})})
  this.update({phase:'staging',errorCode:undefined})
  let evidence:Awaited<ReturnType<typeof stageEvidence>>
  try{evidence=await stageEvidence(input)}catch(error){this.update({phase:'unknown',errorCode:code(error)});throw error}
  if(!this.isCurrent())return
  if(evidence.inputDigest!==pending.inputDigest||evidence.fileHash!==pending.fileHash){this.update({phase:'unknown'});throw invalid()}
  await this.operation('staging',async signal=>{this.persist(pending);const draft=await this.ports.api.stage(input,signal,value=>this.checkStage(value,pending,signal));if(!this.isCurrent()||signal.aborted)return;this.adopt(draft)},true)
 }
 async get(draftId:string){
  this.assertEditable();await this.operation('reconciling',async signal=>{const draft=await this.ports.api.get({draftId},signal,value=>{this.acceptTarget(value,signal)});if(!this.isCurrent()||signal.aborted)return;this.adopt(draft)})
 }
 private async currentDraft(signal:AbortSignal){
  const previous=this.state.draft;if(!previous||!this.refreshRequired)return previous
  const draft=await this.ports.api.get({draftId:previous.id},signal,value=>{this.acceptTarget(value,signal);this.checkImmutableDraft(previous,value)})
  if(!this.isCurrent()||signal.aborted)return
  this.refreshRequired=false
  if(draft.status==='applied'){this.adopt(draft);return draft}
  this.update({draft,inspection:this.state.inspection?{...this.state.inspection,revision:draft.revision}:undefined,preview:undefined,relationsReady:false});return draft
 }
 async inspect(delimiter?:BusinessImportMapping['delimiter']){
  this.assertEditable();if(!this.state.draft)throw invalid()
  await this.operation('inspecting',async signal=>{
   const draft=await this.currentDraft(signal);if(!draft||!this.isCurrent()||signal.aborted)return;if(draft.status==='cancelled'||draft.status==='applied')return this.adopt(draft)
   const inspection=await this.ports.api.inspect(draft.format==='teloa.business-record-import/v2'?{draftId:draft.id,expectedRevision:draft.revision,format:'teloa.business-import-inspect/v2'}:{draftId:draft.id,expectedRevision:draft.revision,delimiter:delimiter!},signal)
   if(!this.isCurrent()||signal.aborted)return
   if(inspection.scope!==this.scope||inspection.type!==this.type||inspection.fileHash!==draft.file.sha256)throw invalid()
   this.update({phase:draft.status,inspection,preview:undefined,relations:{},relationsReady:true})
  })
 }
 changeMapping(mapping:BusinessImportMapping|BusinessImportMappingV2|undefined){
  this.assertEditable();const inspection=this.state.inspection;if(!inspection?.canMap)throw invalid()
  if(mapping===undefined){this.update({mapping:undefined,preview:undefined,relations:{},relationsReady:false,phase:'ready'});return}
  const value=inspection.format==='teloa.business-import-inspection/v2'?readBusinessImportMappingV2(mapping,inspection.columns.length):readBusinessImportMapping(mapping,inspection.columns.length)
  if(inspection.format==='teloa.business-import-inspection/v1'&&'delimiter'in value&&value.delimiter!==inspection.delimiter)throw invalid()
  this.update({mapping:value,preview:undefined,relations:{},relationsReady:false,errorCode:undefined,phase:'ready'})
 }
 async preview(mapping:BusinessImportMapping|BusinessImportMappingV2=this.state.mapping!){
  this.assertEditable();const inspection=this.state.inspection
  if(!this.state.draft||this.state.draft.status==='cancelled'||this.state.draft.status==='applied'||!inspection?.canMap)throw invalid()
  const value=inspection.format==='teloa.business-import-inspection/v2'?readBusinessImportMappingV2(mapping,inspection.columns.length):readBusinessImportMapping(mapping,inspection.columns.length)
  if(inspection.format==='teloa.business-import-inspection/v1'&&'delimiter'in value&&value.delimiter!==inspection.delimiter)throw invalid()
  const generation=this.definitionGeneration
  await this.operation('previewing',async signal=>{
   const draft=await this.currentDraft(signal);if(!draft||!this.isCurrent()||signal.aborted)return;if(draft.status==='cancelled'||draft.status==='applied')return this.adopt(draft)
   if(this.state.inspection?.revision!==draft.revision)throw invalid()
   const request=draft.format==='teloa.business-record-import/v2'?{draftId:draft.id,expectedRevision:draft.revision,format:'teloa.business-import-preview-input/v2' as const,mapping:readBusinessImportMappingV2(value,inspection.columns.length)}:{draftId:draft.id,expectedRevision:draft.revision,mapping:readBusinessImportMapping(value,inspection.columns.length)}
   const result=this.target(await this.ports.api.preview(request,signal));if(!this.isCurrent()||signal.aborted)return
   this.checkImmutableDraft(draft,result)
   // 宿主草案版本已前进，但旧定义的规范结果不能成为可确认预览。
   if(generation!==this.definitionGeneration){this.update({phase:'ready',draft:result,mapping:value,inspection:{...inspection,revision:result.revision},preview:undefined,relationsReady:false,errorCode:'teloa/schema-changed'});return}
   this.adopt(result);this.update({phase:'previewing',inspection:{...inspection,revision:result.revision}});await this.resolveRelations(signal,generation)
   if(this.isCurrent()&&!signal.aborted)this.update(generation===this.definitionGeneration?{phase:result.status}:{phase:'ready',preview:undefined,relationsReady:false,errorCode:'teloa/schema-changed'})
  })
 }
 private async resolveRelations(signal:AbortSignal,generation:number){
  const preview=this.state.preview,definition=this.definition;if(!preview||!definition)return
  const targets=new Map<string,{id:string;type:string}>()
  for(const row of preview.rows)for(const field of definition.fields){
   if(field.type!=='reference'&&field.type!=='multi-reference')continue
   const raw=row.operation.fields.find(value=>value.name===field.name)?.value;if(!raw)continue
   const parsed=field.type==='multi-reference'?readBusinessRichFieldValue(field,raw):undefined
   const ids=field.type==='reference'?[raw]:parsed?.type==='multi-reference'?parsed.ids:[]
   for(const id of ids)targets.set(JSON.stringify([field.referenceType,id]),{type:field.referenceType!,id})
  }
  const relations:Record<string,BusinessImportRelation>={}
  if(targets.size&&!this.ports.records)throw Object.assign(Error('关联记录尚未核对。'),{code:'teloa/relation-unavailable'})
  for(const [key,target] of targets){
   const record=await this.ports.records!.get({scope:this.scope,...target},signal);if(!this.isCurrent()||signal.aborted||generation!==this.definitionGeneration)return
   if(record.scope!==this.scope||record.type!==target.type||record.id!==target.id)throw invalid()
   if(record.quality==='missing')throw Object.assign(Error('关联记录快照缺失，不能确认导入。'),{code:'teloa/relation-unavailable'})
   relations[key]={...target,title:record.title,archived:!!record.deletedAt}
  }
  if(!this.isCurrent()||signal.aborted||generation!==this.definitionGeneration)return
  this.update({relations,relationsReady:Object.values(relations).every(record=>!record.archived)})
 }
 async apply(){
  this.assertEditable();const {draft,preview,relationsReady}=this.state
  if(!draft||!preview?.canApply||!relationsReady||draft.status!=='previewed')return
  const pending:ApplyRequest={phase:'apply',draft,input:{requestId:(this.ports.id??(()=>crypto.randomUUID()))(),draftId:draft.id,previewRevision:preview.revision,previewDigest:preview.digest}}
  await this.sendApply(pending)
 }
 private finishApply(value:BusinessImportAnyReceipt,pending:ApplyRequest){
  const receipt=readBusinessImportAnyReceipt(value),preview=pending.draft.preview!
  if(receipt.requestId!==pending.input.requestId||receipt.draftId!==pending.draft.id||receipt.scope!==this.scope||receipt.type!==this.type||receipt.fileHash!==pending.draft.file.sha256||receipt.previewDigest!==pending.input.previewDigest||receipt.sourceIdentity!==pending.draft.sourceIdentity||receipt.sourcePolicyDigest!==preview.sourcePolicyDigest||receipt.contentKey!==preview.contentKey||receipt.created!==preview.rows.length)throw invalid()
  if((pending.draft.format==='teloa.business-record-import/v2')!==('format'in receipt))throw invalid()
  if(pending.draft.format==='teloa.business-record-import/v2'&&'format'in receipt&&(!same(pending.draft.source,receipt.source)||!same(pending.draft.policy,receipt.policy)||!('format'in preview)||!same(preview.rawCellsDigest,receipt.rawCellsDigest)))throw invalid()
  const applied=readBusinessImportAnyDraft({...pending.draft,status:'applied',revision:pending.draft.revision+1,receipt,updatedAt:receipt.appliedAt>pending.draft.updatedAt?receipt.appliedAt:pending.draft.updatedAt})
  this.clearJournal(pending.draft);this.update({phase:'applied',receipt,draft:applied,pending:undefined,errorCode:undefined})
 }
 private async sendApply(pending:ApplyRequest){
  const previouslyUnknown=this.state.phase==='unknown'
  await this.operation('applying',async signal=>{
   this.update({pending});this.persist(pending)
   let receipt:BusinessImportAnyReceipt
   try{receipt=await this.ports.api.apply(pending.input,signal)}catch(error){
    if(!this.isCurrent()||signal.aborted)return
    const errorCode=businessImportApplyRejectedCode(error);if(!errorCode||previouslyUnknown)throw error
    // 仍保留原正文及明确拒绝事实；刷新不会将已拒绝的请求重新当成传输未知。
    this.persist({phase:'apply-rejected',input:pending.input,draft:pending.draft,errorCode});this.refreshRequired=true
    this.update({phase:'error',pending:undefined,preview:undefined,relationsReady:false,errorCode});return
   }
   if(!this.isCurrent()||signal.aborted)return;this.finishApply(receipt,pending)
  },true)
 }
 async retryApply(){const pending=this.state.pending;if(this.state.phase!=='unknown'||pending?.phase!=='apply'||!this.isCurrent())throw invalid();await this.sendApply(pending)}
 async cancel(){
  if(this.state.phase==='applied'){this.update({errorCode:'teloa/too-late'});return}
  this.assertEditable();const draft=this.state.draft;if(!draft)return
  await this.revise('cancel')
 }
 async resume(){this.assertEditable();const draft=this.state.draft;if(!draft||draft.status!=='cancelled')return;await this.revise('resume')}
 private async revise(phase:'cancel'|'resume'){
  await this.operation(phase==='cancel'?'cancelling':'resuming',async signal=>{
   const draft=await this.currentDraft(signal);if(!draft||!this.isCurrent()||signal.aborted)return
   if(draft.status==='applied'){this.update({errorCode:'teloa/too-late'});return}
   const pending:RevisionRequest={phase,draft,input:{requestId:(this.ports.id??(()=>crypto.randomUUID()))(),draftId:draft.id,expectedRevision:draft.revision}}
   this.update({pending});this.persist(pending);const result=await this.ports.api[phase](pending.input,signal);if(!this.isCurrent()||signal.aborted)return
   this.checkImmutableDraft(draft,result)
   const inspection=this.state.inspection;this.adopt(result);this.update({inspection:inspection?{...inspection,revision:result.revision}:undefined,...(result.status==='applied'?{errorCode:'teloa/too-late'}:{})})
  },true)
 }
 async stageReceipt(){return this.reconcile()}
 async reconcile(){
  if(!this.isCurrent()||this.state.phase==='recovery-error'||this.state.phase!=='unknown'||!this.state.pending)return
  const pending=this.state.pending
  await this.operation('reconciling',async signal=>{
   if(pending.phase==='stage'){
    const {requestId,scope,type}=pending.input,draft=await this.ports.api.stageReceipt({requestId,scope,type},signal,value=>this.checkStage(value,pending,signal));if(!this.isCurrent()||signal.aborted)return
    if(draft===null){this.update({phase:'unknown'});return}this.adopt(draft)
   }else if(pending.phase==='apply'){
    const receipt=await this.ports.api.receipt({requestId:pending.input.requestId,scope:this.scope},signal);if(!this.isCurrent()||signal.aborted)return
    if(receipt===null){this.update({phase:'unknown'});return}this.finishApply(receipt,pending)
   }else{
    const draft=await this.ports.api.get({draftId:pending.input.draftId},signal,value=>{this.acceptTarget(value,signal);this.checkImmutableDraft(pending.draft,value)});if(!this.isCurrent()||signal.aborted)return
    if(draft.status!=='applied'&&draft.revision<pending.input.expectedRevision||draft.revision===pending.input.expectedRevision&&(pending.phase==='cancel'?draft.status!=='cancelled':draft.status!=='ready')){this.update({phase:'unknown'});return}
    this.adopt(draft);this.update({inspection:undefined,...(draft.status==='applied'?{errorCode:'teloa/too-late'}:{})})
   }
  },true)
 }
}
