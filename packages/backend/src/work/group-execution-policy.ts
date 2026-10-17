import type {PoolClient} from 'pg'
import {WorkError,isGroupTaskSource,type GroupExecutionMode,type TaskToolArgumentRule} from '@teloa/contract'

/**
 * 群执行策略（规格 §4.2）。意图分类只说明用户想做什么，不决定工具权限：
 * - reply：交流回应恒为空外部工具集合与空参数规则——正文、已授权资料快照与岗位记忆由宿主在准备阶段提供，
 *   表情由路由服务应用；需要查询来源或产生文件时应按 work 判断或向本人核对。
 * - work：只保留员工原有效授权，不新增任何工具。
 * 同一结果冻结进 Run 的 allowed_tools，供执行快照、工具调用守卫与子级输入准入共用，不靠目标文字约束。
 */
export function resolveGroupExecutionPolicy(input:{executionMode:GroupExecutionMode;roleAllowedTools:readonly string[];argumentRules:readonly TaskToolArgumentRule[]}):{allowedTools:string[];argumentRules:TaskToolArgumentRule[]}{
 if(input.executionMode==='reply')return {allowedTools:[],argumentRules:[]}
 const allowed=new Set(input.roleAllowedTools)
 return {allowedTools:[...allowed],argumentRules:input.argumentRules.filter(rule=>allowed.has(rule.name)).map(rule=>({...rule}))}
}

/** 路由派工的执行策略与尝试世代。本批群路由派出的都是交流回应；明确工作意图的接入由工作批次扩展。 */
export const groupRoutedExecution=(attemptVersion:number):{executionMode:GroupExecutionMode;routingAttemptVersion:number}=>({executionMode:'reply',routingAttemptVersion:attemptVersion})

/** 任务的群执行策略：只认 v2 群来源；v1 与非群任务回 null，沿原授权路径，不回改历史运行。 */
export async function readGroupTaskExecutionMode(db:Pick<PoolClient,'query'>,owner:string,taskId:string):Promise<GroupExecutionMode|null>{
 const row=(await db.query('select source_snapshot from teloa_group_task_sources where owner_id=$1 and task_id=$2',[owner,taskId])).rows[0]
 const source=row?.source_snapshot
 if(!source||typeof source!=='object'||(source as {schema?:unknown}).schema!=='teloa.group-task-source/v2')return null
 if(!isGroupTaskSource(source)||source.schema!=='teloa.group-task-source/v2'||source.taskId!==taskId||source.ownerId!==owner)throw new WorkError('teloa/storage-corrupt','群任务执行策略记录损坏，已停止准备执行。')
 return source.executionMode
}
