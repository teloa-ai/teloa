import {createHash,randomUUID} from 'node:crypto'
import {ArtifactService,readStoredTask,readStoredConversationWorkRequest,type ProjectRuntimeActor,type TaskRun,type TaskRunService} from '@teloa/backend'
import {WorkError,taskInput,readCompletionCandidate,readTaskCompletionPolicy,readContextUseManifest,readProjectRuntimeSettings} from '@teloa/contract'
import type {ProjectMemoryVerifiedEvidence} from './project-memory-host.ts'

type Db=Parameters<TaskRunService['readVerifiedInTransaction']>[0]
type Ports={owner:string;pool:TaskRunService['pool'];runs:()=>Promise<Pick<TaskRunService,'get'|'conversationParent'>>;inspect:(owner:string,sessionId:string)=>Promise<ProjectRuntimeActor>;resource?:(db:Db,owner:string,id:string,scopes:string[])=>Promise<{id:string;version:number;hash:string}>}
const prefix='project-completion:'
const resourcePrefix='project-resource-use:'
const uuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const denied=()=>new WorkError('teloa/forbidden','已验证工作回执的来源或当前权限不可核验。')
const transactionConflict=(error:unknown)=>!!error&&typeof error==='object'&&['40001','40P01'].includes(String(Reflect.get(error,'code')))
const retryable=(error:unknown)=>transactionConflict(error)||error instanceof WorkError&&error.code==='teloa/dependency-unavailable'&&error.details?.retryable===true
const retryLater=()=>new WorkError('teloa/dependency-unavailable','资料核验遇到并发变化，原回执保留待稍后继续。',{retryable:true})

/** 只消费原确定性结项验证器的正式回执；普通成功工具和模型自报不授予 verified。 */
export function createProjectMemoryVerifiedAdapter(ports:Ports){
 let cursor:{at:string;key:string}|undefined
 const loadVerifiedEvidence=async(owner:string,sourceId:string,db?:Db):Promise<ProjectMemoryVerifiedEvidence|null>=>{
  if(owner!==ports.owner)throw denied()
  const resourceIdentity=sourceId.startsWith(resourcePrefix)?sourceId.slice(resourcePrefix.length).split(':'):null
  if(resourceIdentity?resourceIdentity.length!==2||!resourceIdentity.every(uuid):!sourceId.startsWith(prefix)||!uuid(sourceId.slice(prefix.length)))return null
  // 正式资料读取需要 FOR SHARE 核对固定版本；核验自身不写数据，但不能使用 PG READ ONLY 模式。
  if(!db){
   for(let attempt=0;attempt<2;attempt++){
    const client=await ports.pool.connect()
    try{await client.query('begin isolation level repeatable read');const result=await loadVerifiedEvidence(owner,sourceId,client);await client.query('commit');return result}
    catch(error){await client.query('rollback').catch(()=>{});if(!retryable(error))throw error;if(attempt===1)throw retryLater()}
    finally{client.release()}
   }
   throw retryLater()
  }
  // 调用者的事务只能由调用者重启；把并发冲突交还持久提炼队列，不在失效快照里继续查询。
  try{
  if(resourceIdentity){
   if(!ports.resource)return null
   const [manifestId,resourceId]=resourceIdentity
   const row=(await db.query("select * from teloa_project_context_uses where owner_id=$1 and id=$2 and stage='dispatched' and request_key<>'context-check' and request_key not like 'project-memory:%'",[owner,manifestId])).rows[0]
   if(!row?.project_id||row.memory_mode!=='enabled'||typeof row.prompt_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.prompt_hash))return null
   const manifest=readContextUseManifest({id:row.id,sessionId:row.session_id,messageId:row.message_id,projectId:row.project_id,bindingVersion:row.binding_version,generation:row.generation,memoryMode:row.memory_mode,createdAt:row.created_at.toISOString(),sources:row.sources,omitted:row.omitted})
   const source=manifest.sources.find(source=>source.kind==='resource'&&source.id===resourceId)
   if(!source)return null
   const actor=await ports.inspect(owner,manifest.sessionId)
   if(actor.kind!=='ordinary'&&actor.kind!=='employee')return null
   const project=(await db.query('select definition from teloa_projects where owner_id=$1 and id=$2',[owner,manifest.projectId])).rows[0]
   if(!project||project.definition.state==='archived'||actor.scope!==project.definition.scope&&!actor.scopes?.includes(project.definition.scope))return null
   const setting=(await db.query('select * from teloa_project_runtime_settings where project_id=$1',[manifest.projectId])).rows[0]
   if(!setting)return null
   const settings=readProjectRuntimeSettings({projectId:manifest.projectId,version:setting.version,automatic:setting.automatic,readPersonal:setting.read_personal,resources:setting.resources})
   let matching=false
   for(const ref of settings.resources){try{const current=await ports.resource(db,owner,ref.resourceId,actor.scopes??[actor.scope]);if(current.id===source.id&&current.version===source.version&&current.hash===source.hash){matching=true;break}}catch(error){if(!(error instanceof WorkError)||!['teloa/not-found','teloa/forbidden','teloa/resource-withdrawn','teloa/version-conflict','teloa/source-unavailable'].includes(error.code))throw error}}
   if(!matching)return null
   const assertion=`项目资料《${source.title}》的第 ${source.version} 版已在该项目的会话中使用。`
   const text=JSON.stringify({manifestId:manifest.id,promptHash:row.prompt_hash,resourceId:source.id,resourceVersion:source.version,contentHash:source.hash})+'\n'+assertion
   return {sourceId,ownerId:owner,sessionId:manifest.sessionId,messageId:manifest.messageId,receiptId:manifest.id,version:source.version,text,assertion,available:true,kind:'tool'}
  }
  const receiptId=sourceId.slice(prefix.length)
  const row=(await db.query('select * from teloa_task_transitions where owner_id=$1 and request_id=$2',[owner,receiptId])).rows[0]
  if(!row)return null
  const command=taskInput(row.request_spec,['taskId','requestId','expectedVersion','action','artifact','note','verifiedCompletion'])
  if(command.action!=='complete'||command.requestId!==receiptId||command.taskId!==row.task_id||!command.verifiedCompletion)return null
  const proof=taskInput(command.verifiedCompletion,['candidate','policy','receiptIds']),policy=readTaskCompletionPolicy(proof.policy),candidate=readCompletionCandidate(proof.candidate)
  if(policy.kind!=='verified'||policy.verifierVersion!==1||policy.authorizationVersion!==1||!['system-digest','material-version-summary'].includes(policy.verifier)||!Array.isArray(proof.receiptIds)||!proof.receiptIds.length||!proof.receiptIds.every(id=>typeof id==='string'&&uuid(id)))return null
  const completion=(await db.query('select * from teloa_task_completions where owner_id=$1 and task_id=$2',[owner,row.task_id])).rows[0]
  const artifact=taskInput(command.artifact,['id','version'])
  if(!completion||completion.artifact_id!==artifact.id||completion.artifact_version!==artifact.version)return null
  const taskRow=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2',[owner,row.task_id])).rows[0]
  if(!taskRow)return null;const task=readStoredTask(taskRow)
  if(task.ownerId!==owner||task.state!=='completed'||task.version!==completion.task_version||command.expectedVersion!==task.version-1||JSON.stringify(readTaskCompletionPolicy(task.completionPolicy))!==JSON.stringify(policy))return null
  const runs=await ports.runs(),run=await runs.get(owner,{runId:candidate.runId})
  if(run.taskId!==task.id||run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.evidence.endSeq!==candidate.terminalEventSeq)return null
  const parent=await runs.conversationParent(owner,{runId:run.id});if(!parent)return null
  const parentRow=(await db.query('select * from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[owner,parent.requestId])).rows[0]
  if(!parentRow)return null;const original=readStoredConversationWorkRequest(parentRow)
  if(original.sessionId!==parent.sessionId||original.requestId!==parent.requestId)return null
  const actor=await ports.inspect(owner,parent.sessionId)
  if(actor.scope!==task.scope&&!actor.scopes?.includes(task.scope))return null
  const artifacts=new ArtifactService(ports.pool,{id:randomUUID,now:()=>new Date().toISOString()},async()=>{throw denied()})
  const saved=await artifacts.readVersion(db,owner,completion.artifact_id,completion.artifact_version)
  if(saved.ownerId!==owner||saved.source.kind!=='task'||saved.source.id!==task.id||saved.source.scope!==task.scope)return null
  const assertions:string[]=[]
  if(policy.verifier==='material-version-summary'){
   if(!ports.resource||!run.knowledge.length||saved.content.sections.length!==run.knowledge.length)return null
   for(const fixed of run.knowledge){
    const hash=createHash('sha256').update(fixed.text).digest('hex'),section=saved.content.sections.find(section=>section.id===fixed.id)
    const expected=`资料版本 ${fixed.version}\n来源 ${fixed.sourceId}\n来源摘要 ${hash}\n\n${fixed.text.trim().slice(0,1200)}`
    if(fixed.sourceVersion!==hash||!section||section.title!==fixed.title||section.text!==expected)return null
    const current=await ports.resource(db,owner,fixed.id,actor.scopes??[actor.scope])
    if(current.id!==fixed.id||current.version!==fixed.version||current.hash!==hash)return null
    assertions.push(`已核对资料《${fixed.title}》的第 ${fixed.version} 版，并保存本次资料版本摘要（成果第 ${saved.number} 版）。`)
   }
  }else{
   // system-digest 验证的是正式复盘交付与固定成果关系，不验证摘要里任意自然语言事实。
   if(saved.content.sections.length!==1||saved.content.sections[0]?.id!=='daily-digest')return null
   assertions.push(`已完成《${task.title}》的系统复盘，并保存第 ${saved.number} 版成果。`)
  }
  const assertion=assertions.join('\n')
  if(!assertion||assertion.length>8000)return null
  const text=JSON.stringify({receiptId,verifier:policy.verifier,artifactId:saved.artifactId,artifactVersion:saved.number})+'\n'+assertion
  return {sourceId,ownerId:owner,sessionId:original.sessionId,messageId:original.messageId,receiptId,version:saved.number,text,assertion,available:true,kind:'artifact'}
  }catch(error){if(transactionConflict(error))throw retryLater();throw error}
 }
 const verifiedSources=async(sessionId:string,messageId:string):Promise<string[]>=>{
  const used=(await ports.pool.query("select id,sources from teloa_project_context_uses where owner_id=$1 and session_id=$2 and message_id=$3 and stage='dispatched' and project_id is not null and request_key<>'context-check' and request_key not like 'project-memory:%' order by created_at,id limit 32",[ports.owner,sessionId,messageId])).rows
  const ids:string[]=[]
  for(const use of used)for(const source of use.sources)if(source.kind==='resource'){const id=resourcePrefix+use.id+':'+source.id;if(await loadVerifiedEvidence(ports.owner,id))ids.push(id)}
  const rows=(await ports.pool.query(`select transition.request_id from teloa_task_transitions transition
   join teloa_tasks task on task.owner_id=transition.owner_id and task.id=transition.task_id
   join teloa_conversation_work_requests parent on parent.owner_id=task.owner_id and parent.task_child_request_id=task.request_id
   where transition.owner_id=$1 and parent.session_id=$2 and parent.request_spec->>'messageId'=$3
    and transition.request_spec->>'action'='complete' and transition.request_spec ? 'verifiedCompletion'
   order by transition.created_at,transition.request_id limit 32`,[ports.owner,sessionId,messageId])).rows
  for(const row of rows){const id=prefix+row.request_id;if(await loadVerifiedEvidence(ports.owner,id))ids.push(id)}
  return [...new Set(ids)].slice(0,32)
 }
 const forRun=async(run:TaskRun)=>{
  const rows=(await ports.pool.query("select request_id from teloa_task_transitions where owner_id=$1 and task_id=$2 and request_spec->'verifiedCompletion'->'candidate'->>'runId'=$3 order by created_at,request_id limit 2",[ports.owner,run.taskId,run.id])).rows
  if(rows.length!==1)return null
  const evidence=await loadVerifiedEvidence(ports.owner,prefix+rows[0].request_id)
  return evidence?{sessionId:evidence.sessionId,messageId:evidence.messageId,verifiedSourceIds:[evidence.sourceId]}:null
 }
 const recover=async(signal:AbortSignal,consume:(input:{sessionId:string;messageId:string;verifiedSourceIds:string[]})=>Promise<unknown>)=>{
  const rows=(await ports.pool.query(`select source_id,created_at::text as cursor_at from(
    select 'project-completion:'||request_id::text as source_id,created_at from teloa_task_transitions where owner_id=$1
     and request_spec->>'action'='complete' and request_spec ? 'verifiedCompletion'
    union all select 'project-resource-use:'||uses.id::text||':'||(source->>'id') as source_id,uses.created_at from teloa_project_context_uses uses
     cross join lateral jsonb_array_elements(uses.sources) source where uses.owner_id=$1 and uses.stage='dispatched' and uses.project_id is not null and source->>'kind'='resource'
      and uses.request_key<>'context-check' and uses.request_key not like 'project-memory:%'
   ) receipts where ($2::timestamptz is null or (created_at,source_id)>($2::timestamptz,$3::text))
   order by created_at,source_id limit 32`,[ports.owner,cursor?.at??null,cursor?.key??null])).rows
  for(const row of rows){
   signal.throwIfAborted()
   const evidence=await loadVerifiedEvidence(ports.owner,row.source_id)
   if(evidence)await consume({sessionId:evidence.sessionId,messageId:evidence.messageId,verifiedSourceIds:[evidence.sourceId]})
   signal.throwIfAborted()
   if(typeof row.cursor_at!=='string')throw denied()
   cursor={at:row.cursor_at,key:row.source_id}
  }
 }
 return {loadVerifiedEvidence,verifiedSources,forRun,recover}
}
