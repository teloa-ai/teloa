import {createHash} from 'node:crypto'
import {artifactContent,type ArtifactContent,type SavedArtifactVersion} from '@teloa/contract'
import type {CompletionVerifier,CompletionVerifierInput,CompletionVerification,RoleDailyLogCompletionEvidence} from '@teloa/backend'

/** 只由实际读取/正式成果回执生产方登记；浏览器候选和模型自报文字不是收据。 */
export type MaterialSummaryReceipt={id:string;ownerId:string;runId:string;roleId:string;roleVersion:number;artifactId:string;artifactVersion:number;artifactHash:string;sources:Array<{resourceId:string;resourceVersion:number;sourceId:string;sourceVersion:string;contentHash:string}>}
export type MaterialVersionSummaryDelivery={requestId:string;content:ArtifactContent;sources:MaterialSummaryReceipt['sources']}
export type TaskCompletionVerifierPorts={
 digest?:(input:CompletionVerifierInput)=>Promise<RoleDailyLogCompletionEvidence|null>
 saveDigestArtifact?:(input:CompletionVerifierInput,evidence:RoleDailyLogCompletionEvidence)=>Promise<{id:string;version:number}>
 materialReceipts?:(input:CompletionVerifierInput)=>Promise<MaterialSummaryReceipt[]>
 material?:(input:CompletionVerifierInput,source:MaterialSummaryReceipt['sources'][number])=>Promise<{id:string;version:number;sourceId:string;sourceVersion:string;text:string}>
 artifact?:(input:CompletionVerifierInput,id:string,version:number)=>Promise<SavedArtifactVersion>
 /** 服务端生成的固定版本摘要经实际 ArtifactService.createInTransaction 保存，返回其创建回执身份。 */
 saveMaterialSummaryArtifact?:(input:CompletionVerifierInput,delivery:MaterialVersionSummaryDelivery)=>Promise<{receiptId:string;artifact:SavedArtifactVersion}>
}
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
const refuse=(reason:string):CompletionVerification=>({verified:false,reason,receiptIds:[]})
export function materialVersionSummaryRequestId(ownerId:string,runId:string):string{
 const digest=sha(JSON.stringify(['teloa-material-version-summary/v1',ownerId,runId]))
 return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`
}
const versionMatches=(source:MaterialSummaryReceipt['sources'][number],current:{id:string;version:number;sourceId:string;sourceVersion:string;text:string})=>current.id===source.resourceId&&current.version===source.resourceVersion&&current.sourceId===source.sourceId&&current.sourceVersion===source.sourceVersion&&sha(current.text)===source.contentHash

/** 第一批只读检查是确定性的版本与正文摘录；真实来源和生成摘要均随正式成果回执固定。 */
async function saveMaterialVersionSummary(input:CompletionVerifierInput,ports:TaskCompletionVerifierPorts):Promise<CompletionVerification>{
 if(!ports.material||!ports.saveMaterialSummaryArtifact)return refuse('material-verifier-unavailable')
 if(!input.run.knowledge.length)return refuse('material-source-missing')
 const requestId=materialVersionSummaryRequestId(input.ownerId,input.run.id),sources:MaterialSummaryReceipt['sources']=[],sections:ArtifactContent['sections']=[]
 for(const fixed of input.run.knowledge){
  const source={resourceId:fixed.id,resourceVersion:fixed.version,sourceId:fixed.sourceId,sourceVersion:fixed.sourceVersion,contentHash:sha(fixed.text)}
  if(source.sourceVersion!==source.contentHash||sources.some(item=>item.resourceId===source.resourceId)||!fixed.text.trim()||!versionMatches(source,await ports.material(input,source)))return refuse('material-version-mismatch')
  sources.push(source);sections.push({id:fixed.id,title:fixed.title,text:`资料版本 ${fixed.version}\n来源 ${fixed.sourceId}\n来源摘要 ${source.contentHash}\n\n${fixed.text.trim().slice(0,1200)}`})
 }
 if(input.candidate.receiptIds.some(id=>id!==requestId&&!sources.some(source=>source.resourceId===id)))return refuse('material-receipt-mismatch')
 const content=artifactContent({title:input.task.title,sections,snapshotIds:[],note:'本轮已授权资料的固定版本与正文摘录。'}),saved=await ports.saveMaterialSummaryArtifact(input,{requestId,content,sources}),artifact=saved.artifact
 if(saved.receiptId!==requestId||artifact.ownerId!==input.ownerId||artifact.source.kind!=='task'||artifact.source.id!==input.task.id||artifact.source.scope!==input.task.scope||sha(JSON.stringify(artifact.content))!==sha(JSON.stringify(content))||input.candidate.artifactIds.some(id=>id!==artifact.artifactId))return refuse('artifact-summary-mismatch')
 return {verified:true,reason:null,receiptIds:[requestId,...sources.map(source=>source.resourceId)],artifact:{id:artifact.artifactId,version:artifact.number}}
}

/** 只判断已经约定的机器交付条件；不宣称评价任意报告的业务质量。端口缺席一律等待。 */
export function createTaskCompletionVerifiers(ports:TaskCompletionVerifierPorts):Record<'system-digest'|'material-version-summary',CompletionVerifier>{
 return {
  'system-digest':async input=>{
   if(!ports.digest||!ports.saveDigestArtifact)return refuse('digest-verifier-unavailable')
   const evidence=await ports.digest(input)
   if(!evidence||evidence.log.kind!=='daily-digest'||evidence.log.state!=='kept'||evidence.log.ownerId!==input.ownerId||evidence.log.runId!==input.run.id||evidence.log.roleId!==input.run.roleId||evidence.log.roleVersion!==input.run.roleVersion||evidence.identity.taskId!==input.task.id||evidence.identity.runId!==input.run.id||evidence.identity.roleId!==input.run.roleId||evidence.identity.roleVersion!==input.run.roleVersion||evidence.identity.day!==evidence.log.day||evidence.contentHash!==sha(evidence.log.markdown)||!evidence.receiptIds.length)return refuse('digest-delivery-unverified')
   if(input.candidate.receiptIds.some(id=>!evidence.receiptIds.includes(id)))return refuse('digest-receipt-mismatch')
   const artifact=await ports.saveDigestArtifact(input,evidence)
   return {verified:true,reason:null,receiptIds:evidence.receiptIds,artifact}
  },
  'material-version-summary':async input=>{
   if(ports.saveMaterialSummaryArtifact)return saveMaterialVersionSummary(input,ports)
   if(!ports.materialReceipts||!ports.material||!ports.artifact)return refuse('material-verifier-unavailable')
   const receipts=await ports.materialReceipts(input)
   if(receipts.length!==1)return refuse('material-receipt-missing')
   const receipt=receipts[0]!
   if(receipt.ownerId!==input.ownerId||receipt.runId!==input.run.id||receipt.roleId!==input.run.roleId||receipt.roleVersion!==input.run.roleVersion||!input.candidate.receiptIds.includes(receipt.id)||!input.candidate.artifactIds.includes(receipt.artifactId)||!receipt.sources.length)return refuse('material-receipt-mismatch')
   const unique=new Set<string>()
   for(const source of receipt.sources){
    if(unique.has(source.resourceId))return refuse('material-receipt-mismatch');unique.add(source.resourceId)
    const fixed=input.run.knowledge.find(item=>item.id===source.resourceId)
    if(!fixed||fixed.version!==source.resourceVersion||fixed.sourceId!==source.sourceId||fixed.sourceVersion!==source.sourceVersion||source.contentHash!==source.sourceVersion||sha(fixed.text)!==source.contentHash)return refuse('material-version-mismatch')
    const current=await ports.material(input,source)
    if(!versionMatches(source,current))return refuse('material-version-mismatch')
   }
   const artifact=await ports.artifact(input,receipt.artifactId,receipt.artifactVersion)
   if(artifact.ownerId!==input.ownerId||artifact.artifactId!==receipt.artifactId||artifact.number!==receipt.artifactVersion||artifact.source.kind!=='task'||artifact.source.id!==input.task.id||artifact.source.scope!==input.task.scope||sha(JSON.stringify(artifact.content))!==receipt.artifactHash)return refuse('artifact-summary-mismatch')
   return {verified:true,reason:null,receiptIds:[receipt.id],artifact:{id:artifact.artifactId,version:artifact.number}}
  },
 }
}
