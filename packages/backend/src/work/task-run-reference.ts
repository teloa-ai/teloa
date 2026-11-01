import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord,readTaskReferenceCitationPath,taskReferenceCitationPath,type TaskReferenceCitation,type ResourceReference} from '@teloa/contract'
import type {TaskRunService,TaskRun,TaskExecutionScope} from './task-runs.ts'
import type {RunKnowledge} from './task-run-knowledge.ts'

export const taskReferenceReadTool='mcp__teloa_reference__read_reference'
/** 与组合资料目录相同的私有来源命名空间；公共资料仍由原stdio MCP读取。 */
export const isTaskKnowledgeReferenceId=(id:unknown):id is string=>typeof id==='string'&&(id.startsWith('local_material_')||id.startsWith('knowledge_'))
export type TaskReferenceReadPort=(db:PoolClient,run:TaskRun,target:TaskExecutionScope,references:readonly ResourceReference[],signal:AbortSignal)=>Promise<readonly RunKnowledge[]>
export type TaskReferenceResult={schema:'teloa.reference/v1';id:string;title:string;version:string;source:string;bytes:number;text:string;references:ResourceReference[];citationPath?:string}
type Ports={pool:Pick<Pool,'connect'>;runs:Pick<TaskRunService,'sessionRun'|'executionScopeInTransaction'|'toolPolicy'>;read:TaskReferenceReadPort}
const denied=()=>new WorkError('teloa/forbidden','此运行未选择或未授权读取该资料的固定版本。')

/** owner/session仅由宿主可信调用身份提供；模型只提供原sourceId/hash。 */
export async function readTaskRunReference(ports:Ports,owner:string,sessionId:string,input:unknown,signal:AbortSignal):Promise<TaskReferenceResult>{
 if(!isRecord(input)||Object.keys(input).length!==2||!Object.hasOwn(input,'id')||!Object.hasOwn(input,'version')||!isTaskKnowledgeReferenceId(input.id)||input.id.length>128||typeof input.version!=='string'||!/^[a-f0-9]{64}$/.test(input.version))throw new WorkError('teloa/invalid-input','资料读取需要原来源ID及完整固定版本。')
 let db:PoolClient|undefined
 try{
  signal.throwIfAborted()
  const run=await ports.runs.sessionRun(owner,{sessionId})
  if(!run||run.sessionId!==sessionId)throw denied()
  const selected=run.knowledge.filter(item=>item.sourceId===input.id&&item.sourceVersion===input.version)
  if(!selected.length)throw denied()
  db=await ports.pool.connect();await db.query('begin')
  const target=await ports.runs.executionScopeInTransaction(db,owner,{runId:run.id})
  if(target.sessionId!==sessionId||target.taskId!==run.taskId)throw denied()
  const policy=await ports.runs.toolPolicy(owner,{sessionId},db)
  const rule=policy?.argumentRules?.find(item=>item.name===taskReferenceReadTool)
  if(!policy||policy.nativeRequestId!==run.nativeRequestId||policy.stopRequested||policy.textOnly||!policy.allowedTools.includes(taskReferenceReadTool)||!rule||rule.anyArguments===true||!rule.allowed.some(args=>Object.keys(args).length===2&&args.id===input.id&&args.version===input.version))throw denied()
  const references=selected.map(item=>({id:item.id,version:item.version}))
  const current=await ports.read(db,run,target,references,signal)
  if(current.length!==selected.length||current.some((item,index)=>item.id!==selected[index]!.id||item.version!==selected[index]!.version||item.sourceId!==input.id||item.sourceVersion!==input.version||createHash('sha256').update(item.text).digest('hex')!==input.version))throw new WorkError('teloa/version-conflict','资料固定来源已变化，请核对原版本后重新准备。')
  signal.throwIfAborted();const content=current[0]!
  await db.query('commit');signal.throwIfAborted()
  // 仅返回已选来源的opaque ID，不把本人本机路径交给公共MCP或模型。
  return {schema:'teloa.reference/v1',id:content.sourceId,title:content.title,version:content.sourceVersion,source:content.sourceId,bytes:Buffer.byteLength(content.text),text:content.text,references,citationPath:taskReferenceCitationPath({taskId:run.taskId,resourceId:content.id,resourceVersion:content.version,sourceVersion:content.sourceVersion})}
 }catch(error){
  if(db)await db.query('rollback').catch(()=>{})
  signal.throwIfAborted()
  if(error instanceof WorkError)throw error
  throw new WorkError('teloa/storage-unavailable','暂时无法读取本次运行选择的资料，请稍后核对。')
 }finally{db?.release()}
}

/** 本人来源页的只读入口；不调用工具许可，也不使结束的运行恢复可执行状态。 */
export async function readTaskRunReferenceCitation(ports:{pool:Pick<Pool,'connect'>;runs:Pick<TaskRunService,'sessionRun'|'citationScopeInTransaction'>;read:TaskReferenceReadPort},owner:string,input:unknown,signal:AbortSignal):Promise<TaskReferenceCitation>{
 if(!isRecord(input)||Object.keys(input).length!==2||typeof input.sessionId!=='string'||!input.sessionId||input.sessionId.length>128||/[\x00-\x20\x7f/\\]/.test(input.sessionId))throw denied()
 const fixed=readTaskReferenceCitationPath(input.path);if(!fixed)throw denied()
 let db:PoolClient|undefined
 try{
  signal.throwIfAborted()
  const run=await ports.runs.sessionRun(owner,{sessionId:input.sessionId})
  if(!run||run.sessionId!==input.sessionId||run.taskId!==fixed.taskId||!['accepted','active','ended'].includes(run.state)||!run.evidence||run.stopRequestedAt!==null)throw denied()
  const selected=run.knowledge.find(item=>item.id===fixed.resourceId&&item.version===fixed.resourceVersion&&item.sourceVersion===fixed.sourceVersion)
  if(!selected)throw denied()
  db=await ports.pool.connect();await db.query('begin')
  const target=await ports.runs.citationScopeInTransaction(db,owner,run.id)
  if(target.taskId!==run.taskId||target.sessionId!==run.sessionId||target.knowledgeIds!==undefined&&target.knowledgeIds!==null&&!target.knowledgeIds.includes(selected.id))throw denied()
  const rows=await ports.read(db,run,target,[{id:selected.id,version:selected.version}],signal),content=rows[0]
  if(rows.length!==1||!content||content.id!==selected.id||content.version!==selected.version||content.sourceId!==selected.sourceId||content.sourceVersion!==selected.sourceVersion||content.title!==selected.title||createHash('sha256').update(content.text).digest('hex')!==selected.sourceVersion)throw new WorkError('teloa/version-conflict','引用资料已撤回或固定版本已变化。')
  signal.throwIfAborted();await db.query('commit');signal.throwIfAborted()
  return {...fixed,sessionId:run.sessionId,sourceId:content.sourceId,title:content.title,text:content.text,citationPath:input.path as string}
 }catch(error){
  if(db)await db.query('rollback').catch(()=>{})
  signal.throwIfAborted();if(error instanceof WorkError)throw error
  throw new WorkError('teloa/source-unavailable','此引用来源暂不可用，请返回原会话重新核对。')
 }finally{db?.release()}
}
