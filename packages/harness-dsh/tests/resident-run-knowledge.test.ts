import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {taskDefinition,type SavedArtifactVersion} from '@teloa/contract'
import {ResourceService,type CompletionVerifierInput,type TaskExecutionScope} from '@teloa/backend'
import {createFixedRunKnowledgeRead,type FixedRunKnowledgeRead} from '../../backend/src/capabilities/fixed-run-knowledge-read.ts'
import {readResidentRunKnowledge} from '../src/resident-work-runtime.ts'
import {taskKnowledgeAuthorization} from '../src/task-run-dsh.ts'
import {createTaskCompletionVerifiers} from '../src/task-completion-verifiers.ts'

type Transaction=Parameters<ResourceService['executionKnowledgeInTransaction']>[0]
const owner='resident-knowledge-owner',at='2026-10-29T00:00:00.000Z'
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
function fixture(){
 const id=randomUUID(),runId=randomUUID(),taskId=randomUUID(),artifactId=randomUUID(),text='原执行固定的包知识正文。'
 const fixed={id,version:1,title:'包知识',sourceId:'industry_'+randomUUID(),sourceVersion:sha(text),scopeIds:['general'],text}
 const resource={id,owner_id:owner,revision:1,status:'active',spec:{title:fixed.title,sourceId:fixed.sourceId,sourceVersion:fixed.sourceVersion,scopeIds:['general']},created_at:new Date(at),updated_at:new Date(at)}
 let sourceReads=0,runExists=true
 // 只替换外部数据库和来源存储；实际 ResourceService、固定能力核验与完成验证器均保留。
 const db={query:async(sql:string,params:unknown[]=[])=>{
  if(sql.startsWith('select * from teloa_resources'))return {rows:params[0]===id?[resource]:[],rowCount:params[0]===id?1:0}
  if(sql.includes('to_regclass'))return {rows:[{present:'present'}],rowCount:1}
  if(sql.startsWith('select 1 from teloa_employee_knowledge_source_retirements')){
   assert.deepEqual(params,[owner,fixed.sourceId,fixed.sourceVersion]);return {rows:[{}],rowCount:1}
  }
  if(sql.startsWith('select 1 from teloa_task_runs')){
   const found=runExists&&JSON.stringify(params)===JSON.stringify([owner,runId,id,fixed.sourceId,fixed.sourceVersion])
   return {rows:found?[{}]:[],rowCount:found?1:0}
  }
  throw Error('未预期的数据库访问：'+sql)
 }} as unknown as Transaction
 const resources=new ResourceService({} as ConstructorParameters<typeof ResourceService>[0],{
  list:async()=>({schema:'teloa.reference-list/v1',references:[]}),
  read:async(sourceId,sourceVersion)=>{assert.equal(sourceId,fixed.sourceId);assert.equal(sourceVersion,fixed.sourceVersion);sourceReads++;return {schema:'teloa.reference/v1',id:sourceId,title:fixed.title,source:'fixed-package',version:sourceVersion,bytes:Buffer.byteLength(text),text}},
 },{id:randomUUID,now:()=>at})
 const capability=createFixedRunKnowledgeRead(owner,runId,[fixed])
 const target:TaskExecutionScope={taskId,taskVersion:2,sessionId:'fixed-session',linkVersion:1,scope:'general',knowledgeIds:[id],fixedKnowledgeRead:capability}
 const authorization=(read:FixedRunKnowledgeRead=capability)=>taskKnowledgeAuthorization(owner,{...target,fixedKnowledgeRead:read},['general'])
 const input:CompletionVerifierInput={ownerId:owner,task:{...taskDefinition({title:'资料版本小结',goal:'核对原执行资料',scope:'general'}),id:taskId,ownerId:owner,version:3,contentVersion:1,state:'waiting',assigneeRoleId:id,assigneeRoleVersion:1,createdAt:at,updatedAt:at},run:{id:runId,taskId,roleId:id,taskVersion:2,roleVersion:1,linkVersion:1,sessionId:target.sessionId,nativeRequestId:randomUUID(),state:'ended',evidence:{state:'ended',turn:0,messageSeq:1,endSeq:3,reason:'completed'},stopRequestedAt:null,allowedTools:[],skills:[],knowledge:[fixed],memory:[],inputText:'固定原执行输入',createdAt:at},policy:{kind:'verified',verifier:'material-version-summary',verifierVersion:1,authorizationVersion:1},candidate:{runId,terminalEventSeq:3,artifactIds:[],receiptIds:[]},lineage:{schema:'teloa.work-lineage/v1',ownerId:owner,rootTaskId:taskId,definition:null,parentRunId:null,definitionControlId:null,roundControlId:id,controlGeneration:1,budgetAccountId:randomUUID()},db}
 return {id,runId,taskId,artifactId,fixed,db,resources,authorization,input,sourceReads:()=>sourceReads,removeRun:()=>{runExists=false}}
}

test('常驻执行回读保留固定能力，包移除后的原资料仍可核对检索进展',async()=>{
 const f=fixture()
 const contents=await readResidentRunKnowledge(f.resources,f.db,f.authorization(),[f.id])
 assert.deepEqual(contents,[f.fixed]);assert.equal(f.sourceReads(),1)
})

test('常驻完成核验沿原执行固定能力读取包旧文，保存真实版本小结',async()=>{
 const f=fixture(),saved:SavedArtifactVersion[]=[]
 const verify=createTaskCompletionVerifiers({
  material:async(input,source)=>(await readResidentRunKnowledge(f.resources,input.db,f.authorization(),[source.resourceId]))[0]!,
  saveMaterialSummaryArtifact:async(input,delivery)=>{
   const artifact:SavedArtifactVersion={artifactId:f.artifactId,ownerId:owner,number:1,source:{kind:'task',id:input.task.id,scope:input.task.scope,version:'3',title:input.task.title},content:delivery.content,createdAt:at}
   saved.push(artifact);return {receiptId:delivery.requestId,artifact}
  },
 })['material-version-summary']
 const result=await verify(f.input)
 assert.equal(result.verified,true);assert.deepEqual(result.artifact,{id:f.artifactId,version:1})
 assert.equal(saved.length,1);assert.ok(saved[0]!.content.sections[0]!.text.includes('原执行固定的包知识正文。'))
})

test('缺失、伪造、其他执行或已不存在执行的能力不能回读包旧文',async()=>{
 const f=fixture(),valid=f.authorization(),{fixedKnowledgeRead:_,...missing}=valid
 await assert.rejects(readResidentRunKnowledge(f.resources,f.db,missing,[f.id]),{code:'teloa/not-found'})
 await assert.rejects(readResidentRunKnowledge(f.resources,f.db,f.authorization({runId:f.runId} as unknown as FixedRunKnowledgeRead),[f.id]),{code:'teloa/not-found'})
 await assert.rejects(readResidentRunKnowledge(f.resources,f.db,f.authorization(createFixedRunKnowledgeRead(owner,randomUUID(),[f.fixed])),[f.id]),{code:'teloa/not-found'})
 f.removeRun()
 await assert.rejects(readResidentRunKnowledge(f.resources,f.db,valid,[f.id]),{code:'teloa/not-found'})
 assert.equal(f.sourceReads(),0)
})
