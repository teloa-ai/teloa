import {WorkError,isRecord,readBusinessChangeSetApply,readBusinessRecordReceipt,readBusinessRecordBatch,readBusinessRecordSnapshot,businessObjectReference,readBusinessWorkCursor,readBusinessResultCursor,type BusinessWorkCursor,type BusinessResultCursor,type BusinessWorkPage,type BusinessChangeSet,type BusinessObjectReference,type BusinessObjectWorkLink,type BusinessWorkResultVersion} from '@teloa/contract'
type Call=(endpoint:string,input:unknown,signal?:AbortSignal)=>Promise<unknown>
export type BusinessWorkNavigation={namespace?:string|undefined;storage?:Pick<Storage,'getItem'|'setItem'|'removeItem'>;start?:(reference:BusinessObjectReference,title:string)=>Promise<string>;resume:(sessionId:string)=>Promise<unknown>;send:(sessionId:string,text:string)=>Promise<unknown>}
const bad=()=>new WorkError('teloa/invalid-host-response','业务工作回包与当前对象不一致。')
export function readBusinessChangeSetResponse(value:unknown,scope?:string):BusinessChangeSet{
 if(!isRecord(value)||value.schema!=='teloa.business-change-set/v1'||Object.keys(value).some(k=>!['schema','id','scope','revision','digest','state','sessionId','batch','preview','createdAt','updatedAt','receipt'].includes(k))||!['draft','awaiting-approval','applied','rejected','stale'].includes(String(value.state))||typeof value.sessionId!=='string'||!value.sessionId||scope!==undefined&&value.scope!==scope||!isRecord(value.preview)||typeof value.preview.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(value.preview.fingerprint)||!Array.isArray(value.preview.operations)||!Array.isArray(value.preview.targets)||!Array.isArray(value.preview.definitions))throw bad()
 readBusinessChangeSetApply({changeSetId:value.id,expectedRevision:value.revision,expectedDigest:value.digest})
 const batch=readBusinessRecordBatch(value.batch);if(batch.scope!==value.scope||batch.operations.length!==value.preview.operations.length)throw bad()
 for(const target of value.preview.targets)readBusinessRecordSnapshot(target,batch.scope)
 for(const op of value.preview.operations){if(!isRecord(op)||typeof op.type!=='string'||typeof op.title!=='string')throw bad();if(op.before)readBusinessRecordSnapshot(op.before,batch.scope)}
 if(value.state==='applied'){
  if(!isRecord(value.receipt)||value.receipt.requestId!==batch.requestId||value.receipt.scope!==batch.scope||!Array.isArray(value.receipt.items)||value.receipt.items.length!==batch.operations.length)throw bad()
  value.receipt.items.forEach((raw,index)=>{const result=readBusinessRecordSnapshot(raw,batch.scope),op=batch.operations[index]!;if(result.type!==op.type||result.version!==(op.operation==='create'?1:op.expectedVersion+1)||op.operation!=='create'&&result.id!==op.id)throw bad()})
 }
 return value as BusinessChangeSet
}
export function createBusinessWorkResultsApi(call:Call,navigation?:BusinessWorkNavigation){
 const pending=new Map<string,string>()
 const storage=navigation?.storage??{getItem:(key:string)=>pending.get(key)??null,setItem:(key:string,value:string)=>{pending.set(key,value)},removeItem:(key:string)=>{pending.delete(key)}}
 return {
  enabled:navigation!==undefined,
  async listChanges(scope:string,signal?:AbortSignal,options:{history?:boolean;cursor?:BusinessWorkCursor|undefined}={}){const value=await call('business-changes/list',{scope,...options},signal);if(!isRecord(value)||!Array.isArray(value.items)||value.items.length>20)throw bad();return {items:value.items.map(v=>readBusinessChangeSetResponse(v,scope)),...(value.nextCursor===undefined?{}:{nextCursor:readBusinessWorkCursor(value.nextCursor)!})}},
  async getChangeSet(changeSetId:string,signal?:AbortSignal){readBusinessRecordReceipt({requestId:changeSetId});const value=readBusinessChangeSetResponse(await call('business-changes/get',{changeSetId},signal));if(value.id!==changeSetId)throw bad();return value},
  async rejectChangeSet(input:{changeSetId:string;expectedRevision:number},signal?:AbortSignal){readBusinessChangeSetApply({...input,expectedDigest:'a'.repeat(64)});const value=readBusinessChangeSetResponse(await call('business-changes/reject',input,signal));if(value.id!==input.changeSetId||value.revision!==input.expectedRevision||value.state!=='rejected')throw bad();return value},
  async requestApply(input:unknown,sessionId:string){const value=readBusinessChangeSetApply(input),intent=await call('business-changes/intent',value);if(!isRecord(intent)||Object.keys(intent).length!==2||intent.sessionId!==sessionId||typeof intent.text!=='string'||!intent.text||intent.text.length>4000)throw bad();if(!navigation)throw new WorkError('teloa/unavailable','原生工作入口尚未就绪。');await navigation.resume(sessionId);await navigation.send(sessionId,intent.text)},
  async list(input:{scope:string;type:string;id:string;cursor?:BusinessWorkCursor|undefined},signal?:AbortSignal){const value=await call('business-work/list',{scope:input.scope,type:input.type,id:input.id,...(input.cursor?{cursor:readBusinessWorkCursor(input.cursor)}:{})},signal);if(!isRecord(value)||!Array.isArray(value.items)||value.items.length>20||!Array.isArray(value.taskResults)||value.taskResults.length>100)throw bad();for(const work of value.items){if(!isRecord(work)||typeof work.id!=='string'||typeof work.sessionId!=='string'||typeof work.title!=='string'||typeof work.createdAt!=='string')throw bad();readBusinessRecordReceipt({requestId:work.id});const ref=businessObjectReference(work.reference);if(ref.scope!==input.scope||ref.type!==input.type||ref.id!==input.id)throw bad()}
   if(value.nextCursor!==undefined)readBusinessWorkCursor(value.nextCursor)
   return value as BusinessWorkPage<BusinessObjectWorkLink,BusinessWorkCursor>&{taskResults:{taskId:string;runId:string;sessionId:string;mappingId:string;reference:BusinessObjectReference;resultReferences:BusinessObjectReference[];createdAt:string}[]}},
  async results(workLinkId:string,signal?:AbortSignal,cursor?:BusinessResultCursor){const value=await call('business-work/results',{workLinkId,...(cursor?{cursor:readBusinessResultCursor(cursor)}:{})},signal);if(!isRecord(value)||!Array.isArray(value.items)||value.items.length>20)throw bad();for(const r of value.items){if(!isRecord(r)||r.workLinkId!==workLinkId||typeof r.slot!=='string'||!Number.isSafeInteger(r.revision)||Number(r.revision)<1||typeof r.summary!=='string'||!['working','completed','blocked'].includes(String(r.state))||!Array.isArray(r.artifactVersions)||!isRecord(r.source)||typeof r.source.sessionId!=='string'||typeof r.createdAt!=='string')throw bad()}if(value.nextCursor!==undefined)readBusinessResultCursor(value.nextCursor);return value as BusinessWorkPage<BusinessWorkResultVersion,BusinessResultCursor>},
  async startWork(reference:BusinessObjectReference,title:string){
   const ref=businessObjectReference(reference);if(!navigation?.start)throw new WorkError('teloa/unavailable','原生工作入口尚未就绪。')
   if(navigation.storage&&!navigation.namespace)throw new WorkError('teloa/forbidden','本人工作空间尚未确认，未创建工作。')
   const key='teloa.business-work-link/v1/'+(navigation.namespace??'memory')+'/'+JSON.stringify([ref,title]),saved=storage.getItem(key)
   let request:{requestId:string;reference:BusinessObjectReference;sessionId:string;title:string}
   if(saved!==null){
    let value:unknown;try{value=JSON.parse(saved)}catch{throw bad()}
    if(!isRecord(value)||Object.keys(value).length!==4||typeof value.sessionId!=='string'||!value.sessionId||value.title!==title||JSON.stringify(businessObjectReference(value.reference))!==JSON.stringify(ref))throw bad()
    readBusinessRecordReceipt({requestId:value.requestId});request=value as typeof request
    await navigation.resume(request.sessionId)
   }else{
    request={requestId:crypto.randomUUID(),reference:ref,sessionId:await navigation.start(ref,title),title}
    const bytes=JSON.stringify(request);storage.setItem(key,bytes);if(storage.getItem(key)!==bytes)throw new WorkError('teloa/conflict','原工作恢复信息未能可靠保存。')
   }
   const work=await call('business-work/link',request)
   if(!isRecord(work)||work.sessionId!==request.sessionId||JSON.stringify(businessObjectReference(work.reference))!==JSON.stringify(ref))throw bad()
   if(storage.getItem(key)!==JSON.stringify(request))throw new WorkError('teloa/conflict','原工作恢复信息已变化。')
   storage.removeItem(key);if(storage.getItem(key)!==null)throw new WorkError('teloa/conflict','原工作恢复信息尚未确认清除。')
   return work as BusinessObjectWorkLink
  },
  async openWork(work:BusinessObjectWorkLink){if(!navigation)throw new WorkError('teloa/unavailable','原生工作入口尚未就绪。');await call('business-work/open',{scope:work.reference.scope,sessionId:work.sessionId});await navigation.resume(work.sessionId)},
 }
}
export type BusinessWorkResultsApi=ReturnType<typeof createBusinessWorkResultsApi>
