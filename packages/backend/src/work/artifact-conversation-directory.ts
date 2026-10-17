import {isDeepStrictEqual} from 'node:util'
import type {Pool} from 'pg'
import {WorkError,type SavedArtifactSource} from '@teloa/contract'
import type {ArtifactService} from './artifacts.ts'
import {taskArtifactSource} from './artifact-task-source.ts'
import {BusinessScopeService} from './business-scopes.ts'

type DirectoryArtifact=Awaited<ReturnType<ArtifactService['listTask']>>[number]
type DirectoryPorts=Pick<ArtifactService,'listSource'|'listTask'>
const corrupt=()=>new WorkError('teloa/storage-corrupt','会话成果关联无法核对。')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)

/** 仅沿当前会话的有效任务关联读取；来源关联也可展示成果，不因此变为执行上下文。 */
export async function listConversationArtifacts(pool:Pool,owner:string,source:SavedArtifactSource,artifacts:DirectoryPorts):Promise<{sessionId:string;artifacts:DirectoryArtifact[]}>{
 if(!owner.trim()||source.kind!=='session'||!/^[\w-]{1,128}$/.test(source.id)||!source.version)throw new WorkError('teloa/invalid-input','需要已核对的会话成果来源。')
 const links=async()=>{
  const rows=(await pool.query("select * from teloa_object_conversations where owner_id=$1 and session_id=$2 and kind='task' and active=true order by object_id",[owner,source.id])).rows
  const seen=new Set<string>()
  return rows.map(row=>{
   if(row.owner_id!==owner||row.session_id!==source.id||row.conversation_id!==source.version||row.kind!=='task'||row.active!==true||!uuid(row.object_id)||!Number.isSafeInteger(row.version)||row.version<1||!Number.isSafeInteger(row.object_version)||row.object_version<1||typeof row.source_only!=='boolean'||seen.has(row.object_id))throw corrupt()
   seen.add(row.object_id)
   return {taskId:row.object_id,version:row.version,objectVersion:row.object_version,sourceOnly:row.source_only,scope:row.scope_id??null}
  })
 }
 // 与业务待办的精确只读范围校验一致，不以旧内置名称或缺表当作业务授权。
 const authorize=async(scope:string)=>{
  if(!(await new BusinessScopeService(pool).attentionScopes(owner,{scope})).scopeIds.includes(scope))throw new WorkError('teloa/forbidden','当前本人已无权读取关联成果的业务。')
 }
 const before=await links(),sources:SavedArtifactSource[]=[source]
 await authorize(source.scope)
 const candidates:DirectoryArtifact[]=[...await artifacts.listSource(owner,source)]
 for(const link of before){
  const task=await taskArtifactSource(pool,owner,link.taskId,false)
  if(link.scope!==null&&link.scope!==task.scope)throw corrupt()
  await authorize(task.scope);sources.push(task)
  candidates.push(...await artifacts.listTask(owner,task))
 }
 const selected=new Map<string,DirectoryArtifact>(),scopes=new Set(sources.map(item=>item.scope))
 for(const item of candidates){
  if(item.ownerId!==owner||!uuid(item.artifactId)||!Number.isSafeInteger(item.number)||item.number<1||!['session','task'].includes(item.source.kind))throw corrupt()
  scopes.add(item.source.scope)
  const prior=selected.get(item.artifactId)
  if(prior&&(prior.source.kind!==item.source.kind||prior.source.id!==item.source.id||prior.source.scope!==item.source.scope))throw corrupt()
  if(prior?.number===item.number&&(!isDeepStrictEqual(prior.content,item.content)||!isDeepStrictEqual(prior.source,item.source)||prior.createdAt!==item.createdAt))throw corrupt()
  if(!prior||item.number>prior.number)selected.set(item.artifactId,item)
 }
 // 生产回执仅授予该版本的关联；不能借后续任务把成果提升到别处的新版本。
 // 读取期间解除关联、改变任务业务或撤回业务访问时，整次目录不返回旧正文。
 if(!isDeepStrictEqual(before,await links()))throw new WorkError('teloa/version-conflict','会话成果关联已变化，请刷新后重试。')
 for(const task of sources.slice(1))if((await taskArtifactSource(pool,owner,task.id,false)).scope!==task.scope)throw new WorkError('teloa/version-conflict','关联任务的业务已变化，请刷新后重试。')
 for(const scope of scopes)await authorize(scope)
 return {sessionId:source.id,artifacts:[...selected.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||a.artifactId.localeCompare(b.artifactId))}
}
