import type {Pool} from 'pg'
import {WorkError,taskInput,businessDefinitionPaths,businessConfigurationFormatV2,type BusinessDefinitionDiffRow} from '@teloa/contract'
import {BusinessConfigurationStore} from './business-configuration-store.ts'
import type {BusinessConfigurationActor,BusinessConfigurationDraftService} from './business-configuration-drafts.ts'
import type {BusinessDefinitionSourceReader} from './business-definition-source.ts'
import {businessConfigurationDependencyHash,issueBusinessConfigurationPreviewReceipt} from './business-configuration-preview-receipt.ts'
import {assertBusinessConfigurationUniqueRecords} from './business-record-constraints.ts'

export type BusinessConfigurationPreview={draftId:string;revision:number;candidateHash:string;baseVersion:number;dependencyHash:string;receipt:string;changes:{rows:BusinessDefinitionDiffRow[];truncated:boolean};issues:[]}
function changes(before:unknown,after:unknown):BusinessConfigurationPreview['changes']{
 const left=businessDefinitionPaths(before),right=businessDefinitionPaths(after),rows:BusinessDefinitionDiffRow[]=[]
 let truncated=false
 for(const path of [...new Set([...left.keys(),...right.keys()])].sort()){
  if(left.get(path)===right.get(path))continue
  if(rows.length===200){truncated=true;continue}
  rows.push({path,before:left.get(path)??null,after:right.get(path)??null})
 }
 return {rows,truncated}
}
/** 同一只读快照读取草案、固定基线和差异；不执行组件、来源或任务。 */
export class BusinessConfigurationPreviewService{
 private readonly pool:Pool
 private readonly drafts:Pick<BusinessConfigurationDraftService,'draftInTransaction'>
 private readonly definitions:Pick<BusinessDefinitionSourceReader,'forConfigurationCandidate'>&Partial<Pick<BusinessDefinitionSourceReader,'forConfigurationCandidateVersioned'>>
 constructor(pool:Pool,drafts:Pick<BusinessConfigurationDraftService,'draftInTransaction'>,definitions:Pick<BusinessDefinitionSourceReader,'forConfigurationCandidate'>&Partial<Pick<BusinessDefinitionSourceReader,'forConfigurationCandidateVersioned'>>,_identity:{now:()=>string}){
  this.pool=pool;this.drafts=drafts;this.definitions=definitions
 }
 async preview(actor:BusinessConfigurationActor,input:unknown):Promise<BusinessConfigurationPreview>{
  const row=taskInput(input,['draftId','expectedRevision'])
  if(typeof row.draftId!=='string'||!Number.isSafeInteger(row.expectedRevision)||Number(row.expectedRevision)<1)throw new WorkError('teloa/invalid-input','业务配置预览请求格式不正确。')
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const draft=await this.drafts.draftInTransaction(db,actor,row.draftId)
   if(draft.status!=='draft'||draft.revision!==row.expectedRevision)throw new WorkError('teloa/version-conflict','业务配置草案已变化，请重新读取。')
   const current=await new BusinessConfigurationStore(this.pool).currentInTransaction(db,actor.ownerId,draft.scope)
   if(draft.baseVersion!==(current?.version??0))throw new WorkError('teloa/version-conflict','业务配置基线已变化，请重新生成草案。')
   if(draft.candidate.format===businessConfigurationFormatV2){
    if(!this.definitions.forConfigurationCandidateVersioned)throw new WorkError('teloa/dependency-unavailable','富字段配置读取尚未接入，草案已保留。')
    await this.definitions.forConfigurationCandidateVersioned(db,actor.ownerId,draft.candidate)
   }else await this.definitions.forConfigurationCandidate(db,actor.ownerId,draft.candidate)
   await assertBusinessConfigurationUniqueRecords(db,actor.ownerId,draft.candidate)
   const before=current?{...current.manifest,definitions:current.leaves.map(leaf=>({kind:leaf.kind,definition:JSON.parse(leaf.body)}))}:undefined
   const dependencyHash=businessConfigurationDependencyHash(current)
   const result:BusinessConfigurationPreview={draftId:draft.id,revision:draft.revision,candidateHash:draft.hash,baseVersion:draft.baseVersion,dependencyHash,receipt:issueBusinessConfigurationPreviewReceipt({ownerId:actor.ownerId,scope:draft.scope,draftId:draft.id,revision:draft.revision,candidateHash:draft.hash,baseVersion:draft.baseVersion,dependencyHash}),changes:changes(before,draft.candidate),issues:[]}
   await db.query('commit')
   return result
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
}
