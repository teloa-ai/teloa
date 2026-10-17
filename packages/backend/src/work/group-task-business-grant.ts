import {createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import {WorkError,isBusinessScopeKey,isGroupTaskSource,roleSupportsScope} from '@teloa/contract'
import {groupTaskSourceDigest} from './group-task-source-digest.ts'
import {readStoredRole} from './roles.ts'
import {readGroupAgentGrant} from './group-agent-grants.ts'

/** 群明确工作的业务读取与修改草稿受限授权；fingerprint 覆盖全部判据，审批前后任一变化即失效。 */
export type GroupTaskBusinessGrant={ownerId:string;sessionId:string;runId:string;nativeRequestId:string;taskId:string;taskVersion:number;scope:string;groupId:string;roleId:string;fingerprint:string}

const deny=(message:string)=>new WorkError('teloa/forbidden',message)

/**
 * 只为业务读取与修改草稿（准备、读取、采用）建立的群任务受限授权（规格 §4.2、§6.7）。
 * 依据真实 Run 与原群来源，不读模型自报：Run 仍在原生处理且未要求停止；任务来源是本群 v2 明确工作（reply 不行）且来源摘要未变、
 * 原消息仍在；群未归档，工作目标是业务群本身或通用群中显式固定的单一业务；员工原业务范围、本群授权和原工作控制仍有效。
 * 工具是否已授予由调用方按 Run 冻结的 allowed_tools 另行核对；本人业务权限闸、搭建、导入与记录直写不经此处放开。
 * 在采用事务内调用时用同一 db 加共享锁读取，提交前再读一次即可发现停止、撤权或来源变化。
 * 采用事务内另传 admission：复用 TaskRunService.executionAdmissionInTransaction，在同一事务里按 岗位→Run→Task 锁定并复核当前岗位状态与版本
 * （工具授予变更须经暂停与版本变化）、本人执行授权、群许可/委托与停止；与下面的宿主事实一起在落库前判定。
 */
export async function readGroupTaskBusinessGrant(db:Pick<PoolClient,'query'>,owner:string,sessionId:string,admission?:(runId:string)=>Promise<{assertCurrent:()=>void}>):Promise<GroupTaskBusinessGrant>{
 // 采用事务先按 岗位→Run→Task 的既有顺序取得执行准入，再加共享锁读其余事实，不反转锁序。
 const hint=admission?(await db.query("select id from teloa_task_runs where owner_id=$1 and session_id=$2 order by (state not in ('ended','withdrawn','configuration_failed')) desc,created_at desc,id desc limit 1",[owner,sessionId])).rows[0]:undefined
 if(admission&&!hint)throw deny('这项工作已结束或已要求停止，不能再修改业务记录。')
 const lease=admission?await admission(String(hint.id)):undefined
 const run=(await db.query(`select id,task_id,task_state_version,role_id,state,stop_requested_at,native_request_id from teloa_task_runs where owner_id=$1 and session_id=$2
  order by (state not in ('ended','withdrawn','configuration_failed')) desc,created_at desc,id desc limit 1 for share`,[owner,sessionId])).rows[0]
 if(!run||!['accepted','active'].includes(String(run.state))||run.stop_requested_at!==null)throw deny('这项工作已结束或已要求停止，不能再修改业务记录。')
 if(hint&&String(hint.id)!==String(run.id))throw deny('原工作运行已变化，不能修改业务记录。')
 const sourceRow=(await db.query('select group_id,message_id,source_snapshot,snapshot_digest from teloa_group_task_sources where owner_id=$1 and task_id=$2 for share',[owner,run.task_id])).rows[0]
 if(!sourceRow)throw deny('只有群内明确交办的工作可以准备业务修改。')
 const source=sourceRow.source_snapshot
 if(!isGroupTaskSource(source)||source.schema!=='teloa.group-task-source/v2'||source.taskId!==String(run.task_id)||source.ownerId!==owner||source.groupId!==String(sourceRow.group_id)||source.messageId!==String(sourceRow.message_id))throw deny('群工作来源记录不完整，不能修改业务记录。')
 if(source.executionMode!=='work')throw deny('交流回应不能修改业务记录。')
 if(groupTaskSourceDigest(source)!==sourceRow.snapshot_digest)throw deny('群工作来源已变化，不能修改业务记录。')
 if(!(await db.query('select 1 from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,sourceRow.group_id,sourceRow.message_id])).rows[0])throw deny('交办原消息已失效，不能修改业务记录。')
 const group=(await db.query("select version,archived,definition->>'scope' as scope from teloa_groups where owner_id=$1 and id=$2 for share",[owner,sourceRow.group_id])).rows[0]
 const scope=source.businessTarget?.scope??String(group?.scope??'')
 if(!group||group.archived===true||group.version!==source.groupVersion||!isBusinessScopeKey(scope)||scope==='general'||group.scope!==scope&&group.scope!=='general')throw deny('群工作缺少仍然有效的固定目标业务。')
 const task=(await db.query("select version,state,assignee_role_id,definition->>'scope' as scope from teloa_tasks where owner_id=$1 and id=$2 for share",[owner,run.task_id])).rows[0]
 if(!task||task.state!=='running'||task.scope!==scope||String(task.assignee_role_id)!==String(run.role_id)||task.version!==run.task_state_version)throw deny('原工作已变化，不能修改业务记录。')
 const roleRow=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2 for share',[owner,run.role_id])).rows[0]
 if(!roleRow)throw deny('原工作负责人不再属于本人。')
 const role=readStoredRole(roleRow)
 if(role.state!=='active'||!roleSupportsScope(role.scopes,scope)||source.createdAssignee?.roleId!==role.id||source.createdAssignee.roleVersion!==role.version)throw deny('原工作负责人已不能执行该业务。')
 if(!(await db.query('select 1 from teloa_group_members where owner_id=$1 and group_id=$2 and role_id=$3 for share',[owner,sourceRow.group_id,role.id])).rows[0])throw deny('原工作负责人已不在本群。')
 const grantRow=(await db.query('select * from teloa_group_agent_grants where owner_id=$1 and group_id=$2 and role_id=$3 order by grant_version desc limit 1 for share',[owner,sourceRow.group_id,run.role_id])).rows[0]
 const grant=grantRow?readGroupAgentGrant(grantRow):undefined
 if(!grant||grant.state!=='active'||!grant.canAutoRun||grant.groupVersion!==group.version||grant.roleVersion!==role.version)throw deny('员工在本群的授权已撤回，不能修改业务记录。')
 const control=(await db.query('select c.id,c.state,c.generation from teloa_task_work_lineage l join teloa_work_controls c on c.owner_id=l.owner_id and c.id=l.round_control_id where l.owner_id=$1 and l.task_id=$2 for share of c',[owner,run.task_id])).rows[0]
 if(!control||control.state!=='active')throw deny('原工作已暂停或停止，不能修改业务记录。')
 lease?.assertCurrent()
 const facts={ownerId:owner,sessionId,runId:String(run.id),nativeRequestId:String(run.native_request_id),taskId:String(run.task_id),taskVersion:Number(run.task_state_version),scope,groupId:String(sourceRow.group_id),roleId:String(run.role_id)}
 const fingerprint=createHash('sha256').update(JSON.stringify(['teloa.group-task-business/v1',facts,sourceRow.snapshot_digest,grant.grantVersion,String(control.id),control.generation])).digest('hex')
 return {...facts,fingerprint}
}
