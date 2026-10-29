import type {Context} from '@deepseek-ai/cordis'
import {employeeKnowledgeReferenceOrigins,removedEmployeeKnowledgeReferences,isPublicReferenceSourceId,type RunKnowledge,type TaskRunService} from '@teloa/backend'
import {isRecord,taskToolArgumentsAllowed,WorkError,type TaskToolArgumentRule} from '@teloa/contract'
import {referenceReadTool,referenceServerName,mcpResourceListTools} from './role-tool-grants.ts'

export type EmployeeReferenceAlias={id:string;version:string;resource:RunKnowledge}
/** 只为同一逻辑文档的员工副本派生原公共引用别名，不读取原文或新增任何来源。 */
export async function employeeReferenceAliases(db:Pick<Parameters<TaskRunService['readVerifiedInTransaction']>[0],'query'>,owner:string,roleId:string,contents:readonly RunKnowledge[]):Promise<EmployeeReferenceAlias[]>{
 const ids=contents.map(item=>item.id),origins=await employeeKnowledgeReferenceOrigins(db,owner,roleId,ids),changed=origins.filter((id,index)=>id!==ids[index])
 if(!changed.length)return []
 const rows=(await db.query('select id,spec from teloa_resources where owner_id=$1 and id=any($2::uuid[])',[owner,changed])).rows
 return contents.flatMap((resource,index)=>{
  if(origins[index]===resource.id)return []
  const row=rows.find(row=>row.id===origins[index]),spec=row?.spec
  if(!isRecord(spec)||typeof spec.sourceId!=='string'||!isPublicReferenceSourceId(spec.sourceId)||typeof spec.sourceVersion!=='string')return []
  return [{id:spec.sourceId,version:spec.sourceVersion,resource}]
 })
}
/** 原 read_reference 已经授权的逻辑文档在派发时读本轮冻结的员工版本；不向MCP发送私有资料。 */
export function registerEmployeeReferenceAliases(ctx:Context,ports:{read:(sessionId:string,signal:AbortSignal)=>Promise<{aliases:EmployeeReferenceAlias[];rules:readonly TaskToolArgumentRule[]}|null>}){
 return ctx.on('tools/execute',async(exec,next)=>{
  if(exec.name!==referenceReadTool||!exec.agent)return next()
  const context=await ports.read(exec.agent.session.id,exec.signal)
  if(!context)return next()
  if(!isRecord(exec.arguments)||Object.keys(exec.arguments).some(key=>key!=='id'&&key!=='version'))throw new WorkError('teloa/invalid-input','固定资料别名参数不正确。')
  if(!taskToolArgumentsAllowed(context.rules,referenceReadTool,exec.arguments))throw new WorkError('teloa/forbidden','资料别名超出本次执行的固定授权。')
  const args=exec.arguments,alias=context.aliases.find(row=>row.id===args.id&&row.version===args.version)
  if(!alias)return next()
  exec.signal.throwIfAborted()
  const resource=alias.resource,value={schema:'teloa.reference/v1',id:resource.sourceId,title:resource.title,source:'employee-knowledge:'+resource.id,version:resource.sourceVersion,bytes:Buffer.byteLength(resource.text),text:resource.text,logicalReference:{id:alias.id,version:alias.version},resourceId:resource.id,resourceVersion:resource.version}
  const content=[{type:'text' as const,text:JSON.stringify(value)}]
  return {isError:false as const,value:{content,structuredContent:value},content}
 })
}

/** 只收窄已由当前包明确移除的逻辑文档；其余失配仍交原授权校验拒绝。 */
export async function narrowEmployeeReferenceRules(db:Pick<Parameters<TaskRunService['readVerifiedInTransaction']>[0],'query'>,owner:string,roleId:string,originIds:readonly string[],rules:readonly TaskToolArgumentRule[],contents:readonly RunKnowledge[]):Promise<TaskToolArgumentRule[]>{
 const removed=await removedEmployeeKnowledgeReferences(db,owner,roleId,originIds)
 if(!removed.length)return [...rules]
 const rows=(await db.query('select spec from teloa_resources where owner_id=$1 and id=any($2::uuid[])',[owner,removed])).rows
 const references=rows.flatMap(row=>isRecord(row.spec)&&typeof row.spec.sourceId==='string'&&isPublicReferenceSourceId(row.spec.sourceId)&&typeof row.spec.sourceVersion==='string'?[{id:row.spec.sourceId,version:row.spec.sourceVersion}]:[])
 const retained=[...contents.filter(row=>isPublicReferenceSourceId(row.sourceId)).map(row=>({id:row.sourceId,version:row.sourceVersion})),...(await employeeReferenceAliases(db,owner,roleId,contents)).map(row=>({id:row.id,version:row.version}))]
 const removedReferences=references.filter(ref=>!retained.some(keep=>keep.id===ref.id&&keep.version===ref.version))
 const hasPublic=retained.length>0
 return rules.flatMap(rule=>{
  if(rule.anyArguments===true)return [rule]
  if(rule.name===referenceReadTool){const allowed=rule.allowed.filter(args=>!removedReferences.some(ref=>ref.id===args.id&&ref.version===args.version));return allowed.length?[{...rule,allowed}]:[]}
  if(references.length&&!hasPublic&&(mcpResourceListTools as readonly string[]).includes(rule.name)){const allowed=rule.allowed.filter(args=>args.server!==referenceServerName);return allowed.length?[{...rule,allowed}]:[]}
  return [rule]
 })
}
