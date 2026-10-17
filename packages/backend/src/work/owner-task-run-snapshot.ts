import {readArtifactRevisionContext,type ArtifactRevisionContext} from './artifact-revision-requests.ts'
import {isDeepStrictEqual} from 'node:util'
import {WorkError,taskInput,taskRunStopRequestedAt,readWorkExecutor,readTaskRunModelPolicy,readTaskToolArgumentRules,type WorkTask,type TaskRunModelPolicy,type TaskToolArgumentRule,type WorkLineage} from '@teloa/contract'
import {readWorkLineage} from './work-lineage.ts'
import {runEvidence} from './task-run-evidence.ts'
import {readRunKnowledge,type RunKnowledge} from './task-run-knowledge.ts'
import type {OwnerExecutor} from './owner-work-authority.ts'
import type {TaskRun} from './task-runs.ts'
import {readRunPlanContext,runPlanContextHash,type RunPlanContext} from './task-run-plan-context.ts'
const canonical=(key:string,value:unknown)=>key!==''&&value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value
export function ownerRunInput(task:WorkTask,executor:OwnerExecutor,lineage:WorkLineage,allowedTools:readonly string[],agentPresetId?:string,modelPolicy?:TaskRunModelPolicy,argumentRules?:TaskToolArgumentRule[],knowledge:RunKnowledge[]=[],artifactRevision?:ArtifactRevisionContext,planContext?:RunPlanContext):string{
 return JSON.stringify({schema:'teloa.task-run-input/v3',executor,lineage,...(artifactRevision?{artifactRevision}:{}),...(planContext?{planContext}:{}),task:{id:task.id,version:task.version,title:task.title,goal:task.goal,scope:task.scope},allowedTools,...(agentPresetId?{agentPresetId}:{}),...(modelPolicy?{modelPolicy}:{}),...(argumentRules?{tools:argumentRules}:{}),knowledge},canonical)
}
/** 本人分支独立严格解码，不放宽已有岗位快照 reader。 */
export function readOwnerTaskRun(row:Record<string,unknown>):TaskRun{
 try{
  const id=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  const positive=(value:unknown)=>Number.isSafeInteger(value)&&(value as number)>0
  const executor=readWorkExecutor(row.owner_executor)
  if(executor.kind!=='owner'||row.role_id!==null||row.role_version!==null||![row.id,row.task_id,row.request_id,row.native_request_id].every(id)||!positive(row.task_version)||!(positive(row.link_version)||row.state==='configuration_failed'&&row.link_version===0)||typeof row.session_id!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(row.session_id)||!['prepared','submitting','accepted','active','ended','withdrawn','configuration_failed'].includes(String(row.state))||typeof row.input_text!=='string'||!(row.created_at instanceof Date))throw Error()
  if(row.task_state_version!=null&&(!positive(row.task_state_version)||(row.task_state_version as number)<=(row.task_version as number)))throw Error()
  const snapshot=taskInput(JSON.parse(row.input_text),['schema','executor','lineage','task','allowedTools','agentPresetId','modelPolicy','tools','knowledge','artifactRevision','planContext']),task=taskInput(snapshot.task,['id','version','title','goal','scope'])
  const spec=taskInput(row.request_spec,['requestId','taskId','expectedTaskVersion','executor','sessionId','expectedLinkVersion'])
  if(snapshot.schema!=='teloa.task-run-input/v3'||!isDeepStrictEqual(readWorkExecutor(snapshot.executor),executor)||!isDeepStrictEqual(readWorkExecutor(spec.executor),executor)||spec.requestId!==row.request_id||spec.taskId!==row.task_id||spec.expectedTaskVersion!==row.task_version||spec.sessionId!==row.session_id||spec.expectedLinkVersion!==row.link_version||task.id!==row.task_id||task.version!==row.task_version||task.scope!=='general'||[task.title,task.goal].some(value=>typeof value!=='string'||!value.trim()))throw Error()
  if(snapshot.artifactRevision!==undefined)readArtifactRevisionContext(snapshot.artifactRevision)
  const lineage=readWorkLineage(snapshot.lineage)
  if(lineage.ownerId!==row.owner_id)throw Error()
  const allowedTools=row.allowed_tools
  if(!Array.isArray(allowedTools)||allowedTools.length>256||allowedTools.some(value=>typeof value!=='string'||!/^[-a-zA-Z0-9_.]{1,128}$/.test(value))||new Set(allowedTools).size!==allowedTools.length||!isDeepStrictEqual(allowedTools,snapshot.allowedTools))throw Error()
  const argumentRules=row.tool_argument_rules==null?undefined:readTaskToolArgumentRules(row.tool_argument_rules)
  if(!isDeepStrictEqual(argumentRules,snapshot.tools)||argumentRules?.some(rule=>!allowedTools.includes(rule.name)))throw Error()
  const knowledge=readRunKnowledge(snapshot.knowledge)
  if(!isDeepStrictEqual(knowledge,row.role_knowledge)||!isDeepStrictEqual(row.role_skills,[])||!isDeepStrictEqual(row.role_memory,[])||[row.industry_context_hash,row.business_context_hash,row.group_context_hash].some(value=>value!=null))throw Error()
  const planContext=readRunPlanContext(snapshot.planContext)
  if(planContext?(row.plan_context_hash!==runPlanContextHash(planContext)||planContext.reportGroup!==undefined||planContext.event!==undefined||lineage.definition?.planId!==executor.grantId||lineage.definition.definitionVersion!==executor.grantVersion||planContext.goal!==task.goal):row.plan_context_hash!=null||executor.grantVersion!==1)throw Error()
  const agentPresetId=snapshot.agentPresetId
  if(agentPresetId!==undefined&&(typeof agentPresetId!=='string'||!/^[-a-z0-9]{1,120}$/.test(agentPresetId))||(row.agent_preset_id??undefined)!==agentPresetId)throw Error()
  const modelPolicy=snapshot.modelPolicy===undefined?undefined:readTaskRunModelPolicy(snapshot.modelPolicy),evidence=row.evidence==null?null:runEvidence(row.evidence)
  if(['prepared','submitting','withdrawn','configuration_failed'].includes(String(row.state))?evidence!==null:evidence?.state!==row.state)throw Error()
  if((row.state==='configuration_failed')!==(row.configuration_error!=null))throw Error()
  if(row.configuration_error!=null){const failure=taskInput(row.configuration_error,['code','stage','message','actualAgentPresetId']);if(typeof failure.code!=='string'||!/^teloa\/[a-z0-9-]+$/.test(failure.code)||typeof failure.message!=='string'||!failure.message.trim()||failure.message.length>1000||!['model-resolve','preset-resolve','session-create','session-receipt','session-inspect'].includes(String(failure.stage)))throw Error()}
  const stopRequestedAt=taskRunStopRequestedAt(row.stop_requested_at==null?null:(row.stop_requested_at as Date).toISOString())
  return {id:row.id as string,taskId:row.task_id as string,taskVersion:row.task_version as number,roleId:null,roleVersion:null,executor,linkVersion:row.link_version as number,sessionId:row.session_id,nativeRequestId:row.native_request_id as string,state:row.state as string,evidence,stopRequestedAt,allowedTools,skills:[],knowledge,memory:[],inputText:row.input_text,createdAt:row.created_at.toISOString(),lineage,...(agentPresetId?{agentPresetId:agentPresetId as string}:{}),...(modelPolicy?{modelPolicy}:{}),...(argumentRules?{argumentRules}:{}),...(row.configuration_error?{configurationError:row.configuration_error as NonNullable<TaskRun['configurationError']>}:{}),...(row.flow_id?{flowId:row.flow_id as string}:{})}
 }catch{throw new WorkError('teloa/storage-corrupt','本人执行快照与固定来源不一致。')}
}
