import test from 'node:test'
import assert from 'node:assert/strict'
const stamp='2026-09-30T00:00:00.000Z',hash='a'.repeat(64),fileHash='ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb'
const namespace='teloa.business-builder/v1/personal-space/11111111-1111-4111-8111-111111111111',draftId='22222222-2222-4222-8222-222222222222',file={name:'客户.csv',bytes:1,dataBase64:'YQ=='}
const mapping={delimiter:',' as const,headerRow:1,primaryKey:[{column:0,trim:false}],title:{column:1,trim:false},fields:[]}
const definition={format:'teloa.business-object-type/v1' as const,domain:'sales',id:'customer',version:'1.0.0',sourceId:'records',title:'客户',unit:'条',lead:'',fields:[]}
async function fixture(){
 const {createBusinessImportFlowFactory}=await import('../src/client/business-import-integration.ts')
 const rows=new Map<string,string>(),calls:{method:string;input:any}[]=[],token={} as any;let generation:object|undefined={},identity={status:'ready',namespace,api:token},draft:any,receipt:any=null,failStage=false,rejectApply=false,release:undefined|(()=>void),holdApply=false
 const storage={getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value)},removeItem:(key:string)=>{rows.delete(key)}}
 const call=async(method:string,input:any)=>{calls.push({method,input});let value:any;switch(method){
  case 'business-imports/stage':draft={format:'teloa.business-record-import/v1',id:draftId,stageRequestId:input.requestId,ownerId:'local:teloa-owner',scope:input.scope,type:input.type,sourceIdentity:hash,revision:1,status:'ready',file:{attachmentId:'attachment',name:input.name,bytes:input.bytes,sha256:fileHash},createdAt:stamp,updatedAt:stamp};if(failStage)throw Error('lost');value=draft;break
  case 'business-imports/stage-receipt':case 'business-imports/get':value=draft;break
  case 'business-imports/inspect':value={format:'teloa.business-import-inspection/v1',draftId,scope:draft.scope,type:draft.type,fileHash,revision:draft.revision,delimiter:input.delimiter,parserVersion:'csv-v1',headerRow:1,columns:[{column:0,header:'编号'},{column:1,header:'名称'}],sampleRows:[{rowNumber:2,cells:['001','客户一']}],sampleRowsOmitted:0,dataRows:1,issues:[],complete:true,canMap:true};break
  case 'business-imports/preview':draft={...draft,status:'previewed',revision:draft.revision+1,mapping:input.mapping,preview:{revision:draft.revision+1,digest:hash,schemaFingerprint:hash,writeSchemaFingerprint:hash,configurationVersion:1,sourceIdentity:hash,sourcePolicyDigest:hash,contentKey:hash,mapping:input.mapping,rows:[{rowNumber:2,primaryKey:['001'],operation:{operation:'create',type:draft.type,title:'客户一',summary:'',fields:[]}}],issues:[],canApply:true}};value=draft;break
  case 'business-imports/apply':if(rejectApply)return {ok:false as const,error:{code:'teloa/version-conflict',message:'请重新预览'}};if(holdApply)await new Promise<void>(resolve=>{release=resolve});receipt={requestId:input.requestId,canonicalRequestId:input.requestId,draftId,scope:draft.scope,type:draft.type,fileHash,previewDigest:input.previewDigest,sourceIdentity:hash,sourcePolicyDigest:hash,contentKey:hash,created:1,references:[{scope:draft.scope,type:draft.type,id:'33333333-3333-4333-8333-333333333333',version:1,snapshotHash:hash}],appliedAt:stamp};value=receipt;break
  case 'business-imports/receipt':value=receipt;break
  default:throw Error('unexpected '+method)
 }return {ok:true as const,value}}
 const ports={ownerId:'local:teloa-owner',identity:()=>identity,generation:()=>generation,storage,call},factory=createBusinessImportFlowFactory(ports),flow=factory.forTarget(namespace,token,'sales','customer');flow.configure(definition)
 return {factory,flow,ports,rows,calls,token,storage,set generation(value:object|undefined){generation=value},set identity(value:typeof identity){identity=value},set failStage(value:boolean){failStage=value},set rejectApply(value:boolean){rejectApply=value},set holdApply(value:boolean){holdApply=value},release:()=>release?.(),fresh:()=>createBusinessImportFlowFactory(ports)}
}
test('import_target_factory_reuses_current_target_and_restores_original_journal_after_new_generation',async()=>{
 const x=await fixture();assert.equal(x.factory.forTarget(namespace,x.token,'sales','customer'),x.flow);assert.notEqual(x.factory.forTarget(namespace,x.token,'sales','contact'),x.flow);x.failStage=true;await x.flow.stage(file);assert.equal(x.flow.getSnapshot().phase,'unknown');assert.equal(x.rows.size,1);assert.equal([...x.rows.values()][0]!.includes('dataBase64'),false)
 x.generation={};x.factory.invalidate();assert.equal(x.flow.isCurrent(),false);const restored=x.factory.forTarget(namespace,x.token,'sales','customer');assert.notEqual(restored,x.flow);await restored.reconcile();assert.equal(restored.getSnapshot().phase,'ready');assert.equal(x.calls.filter(c=>c.method.endsWith('/stage')).length,1);x.factory.dispose();assert.equal(restored.isCurrent(),false);assert.equal(x.rows.size,1)
})
test('import_factory_has_no_unchecked_space_owner_or_memory_storage_fallback',async()=>{
 const x=await fixture();assert.throws(()=>x.factory.forTarget('teloa.business-builder/v1/personal-space/display-name',x.token,'sales','customer'));assert.throws(()=>x.factory.forTarget(namespace,{} as typeof x.token,'sales','customer'));x.identity={status:'loading',namespace,api:x.token};assert.throws(()=>x.factory.forTarget(namespace,x.token,'sales','customer'))
 const y=await fixture();y.storage.setItem=()=>{throw Error('quota')};await y.flow.stage(file);assert.equal(y.flow.getSnapshot().phase,'recovery-error');assert.equal(y.calls.length,0)
 const z=await fixture();z.storage.getItem=()=>{throw Error('blocked')};const unavailable=z.fresh().forTarget(namespace,z.token,'sales','customer');assert.equal(unavailable.getSnapshot().phase,'recovery-error')
})
test('trusted_false_wire_preserves_explicit_rejection_without_changing_other_api_adapters',async()=>{
 const x=await fixture();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping);x.rejectApply=true;await x.flow.apply();assert.equal(x.flow.getSnapshot().phase,'error');assert.equal(x.flow.getSnapshot().errorCode,'teloa/version-conflict');assert.equal(JSON.parse([...x.rows.values()][0]!).request.phase,'apply-rejected')
})
test('late_apply_from_disposed_generation_cannot_clear_the_restored_original_journal',async()=>{
 const x=await fixture();await x.flow.stage(file);await x.flow.inspect(',');await x.flow.preview(mapping);x.holdApply=true;const sending=x.flow.apply();await new Promise(resolve=>setImmediate(resolve));const raw=[...x.rows.values()][0];x.generation={};x.factory.invalidate();const restored=x.factory.forTarget(namespace,x.token,'sales','customer');assert.equal(restored.getSnapshot().phase,'unknown');x.release();await sending;assert.equal([...x.rows.values()][0],raw);assert.notEqual(x.flow.getSnapshot().phase,'applied');await restored.reconcile();assert.equal(restored.getSnapshot().phase,'applied');assert.equal(x.rows.size,0)
})
