import type {PoolClient} from 'pg'
import {projectDefinition,WorkError,type WorkTask} from '@teloa/contract'
import {readGroupTaskSource} from './group-tasks.ts'
import {readStoredGroupWorkLinks} from './group-work-links.ts'
import type {TaskRun} from './task-runs.ts'

/** 同一注意目录快照内批量核对交流回帖；不结项内部 Task，也不消除明确关联的工作。 */
export async function completedGroupReplies(db:PoolClient,owner:string,candidates:readonly {task:WorkTask;run:TaskRun}[]):Promise<ReadonlySet<string>>{
 const done=new Set<string>()
 if(!candidates.length)return done
 // 这些表按功能初始化；旧安装或仅使用普通任务时，缺少回帖事实就保留原注意项。
 const tables=(await db.query("select to_regclass('teloa_group_task_sources') as sources,to_regclass('teloa_group_routing_outbox') as outbox,to_regclass('teloa_group_messages') as messages,to_regclass('teloa_group_work_links') as links,to_regclass('teloa_projects') as projects")).rows[0]
 if(!tables?.sources||!tables.outbox||!tables.messages)return done
 const byId=new Map(candidates.map(value=>[value.task.id,value]))
 const sources=(await db.query('select * from teloa_group_task_sources where owner_id=$1 and task_id=any($2::uuid[])',[owner,[...byId.keys()]])).rows.map(readGroupTaskSource).filter(source=>{
  const value=byId.get(source.taskId)
  return value&&source.schema==='teloa.group-task-source/v2'&&source.trigger==='routed'&&source.executionMode==='reply'&&value.task.contentVersion===1&&source.createdAssignee?.roleId===value.task.assigneeRoleId&&source.createdAssignee?.roleVersion===value.task.assigneeRoleVersion&&value.run.roleId===source.createdAssignee.roleId&&value.run.roleVersion===source.createdAssignee.roleVersion
 })
 if(!sources.length)return done
 const sourceById=new Map(sources.map(source=>[source.taskId,source]))
 const explicit=new Set<string>()
 if(tables.links){
  const matches=sources.map(source=>JSON.stringify([{kind:'task',id:source.taskId,scope:byId.get(source.taskId)!.task.scope}]))
  for(const row of (await db.query('select version,links from teloa_group_work_links where owner_id=$1 and links @> any($2::jsonb[])',[owner,matches])).rows)
   for(const link of readStoredGroupWorkLinks(row).links)if(link.kind==='task')explicit.add(link.id)
 }
 if(tables.projects){
  const matches=sources.map(source=>JSON.stringify([{kind:'task',id:source.taskId}]))
  for(const row of (await db.query("select definition from teloa_projects where owner_id=$1 and (definition->'links' @> any($2::jsonb[]) or definition->'references' @> any($2::jsonb[]))",[owner,matches])).rows){
   let project:ReturnType<typeof projectDefinition>
   try{project=projectDefinition(row.definition)}catch{throw new WorkError('teloa/storage-corrupt','项目记录损坏，请检查原记录。')}
   for(const link of [...project.links.map(link=>({...link,scope:project.scope})),...project.references])if(link.kind==='task'&&byId.get(link.id)?.task.scope===link.scope)explicit.add(link.id)
  }
 }
 const publications=(await db.query(`select o.task_id,o.run_id,o.role_id,o.role_version,o.group_id,o.message_id,o.decision_version
  from teloa_group_routing_outbox o join teloa_group_messages m
  on m.owner_id=o.owner_id and m.group_id=o.group_id and m.task_id=o.task_id and m.run_id=o.run_id and m.author_id=o.role_id::text
  where o.owner_id=$1 and o.task_id=any($2::uuid[]) and o.execution_mode='reply' and o.state<>'blocked'`,[owner,[...sourceById.keys()]])).rows
 for(const row of publications){
  const source=sourceById.get(row.task_id),value=byId.get(row.task_id)
  if(source&&source.schema==='teloa.group-task-source/v2'&&value&&!explicit.has(row.task_id)&&row.run_id===value.run.id&&row.role_id===value.task.assigneeRoleId&&row.role_version===value.task.assigneeRoleVersion&&row.group_id===source.groupId&&row.message_id===source.messageId&&row.decision_version===source.routingAttemptVersion)done.add(row.task_id)
 }
 return done
}
