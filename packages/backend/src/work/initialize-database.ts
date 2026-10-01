import {initializeBusinessConversationBindings} from './business-conversation-bindings.ts'
import {initializeBusinessRecords} from './business-records.ts'
import {initializeBusinessRecordImports} from './business-record-imports.ts'
import {initializeBusinessConfigurations} from './business-configuration-store.ts'
import {initializeBusinessDashboardResources} from './business-dashboard-resource.ts'
import type {Pool} from 'pg'
import {initializeResources} from '../capabilities/schema.ts'
import {initializeRoles} from './roles.ts'
import {initializeTasks} from './tasks.ts'
import {initializeProjects} from './projects.ts'
import {initializePlans} from './plans.ts'
import {initializeCollaboration} from './collaboration.ts'
import {initializeGroupAgentGrants} from './group-agent-grants.ts'
import {initializeGroupTasks} from './group-tasks.ts'
import {initializeGroupAttachments} from './group-attachments.ts'
import {initializeGroupReactions} from './group-reactions.ts'
import {initializeGroupRoutingDecisions} from './group-routing-decisions.ts'
import {initializeRoleLifecycle} from './role-lifecycle.ts'
import {initializeHandoffs} from './handoffs.ts'
import {initializeTaskTransitions,initializeTaskCompletions} from './task-transitions.ts'
import {initializeObjectConversations} from './object-conversations.ts'
import {initializeRoleToolGrants} from './role-tool-grants.ts'
import {initializeWebAccessPolicy} from './web-access.ts'
import {initializeRoleMemory} from './role-memory.ts'
import {initializeRoleDailyLogs} from './role-daily-logs.ts'
import {initializeTaskMaterials} from './task-materials.ts'
import {initializeArtifactSnapshots} from './artifact-snapshots.ts'
import {initializeArtifacts} from './artifacts.ts'
import {initializeArtifactFeedback} from './artifact-feedback.ts'
import {initializeMarketContents} from '../market/content-store.ts'
import {initializeSkillInstallations} from '../market/skill-installations.ts'
import {initializePluginInstallations} from '../market/plugin-installations.ts'
import {initializeGithubSources} from '../market/github-source.ts'
import {initializeIndustryLoads} from './industry-loads.ts'
import {initializeIndustryKnowledge} from './industry-knowledge.ts'
import {initializeIndustryRoles} from './industry-roles.ts'
import {initializeIndustryTasks} from './industry-tasks.ts'
import {initializeIndustryPlans} from './industry-plans.ts'
import {initializeIndustryDataSources} from './industry-data-sources.ts'
import {initializeIndustryExecutionTools} from './industry-execution-tools.ts'
import {initializeIndustryMcpConnections} from './industry-mcp-connections.ts'
import {initializeIndustryPlugins} from './industry-plugins.ts'
import {initializePlanOccurrences} from './plan-occurrences.ts'
import {initializeBusinessData} from './business-data.ts'
import {initializeBusinessSnapshotReferences} from './business-snapshot-references.ts'
import {initializeBusinessWarehouse} from './business-warehouse.ts'
import {initializeBusinessSqlRole,type BusinessSqlRoleStatus} from './business-sql-executor.ts'
import {initializeBusinessRuntime} from './business-runtime.ts'
import {initializeBusinessSync} from './business-sync.ts'
import {initializeBusinessSyncRules} from './business-sync-rules.ts'
import {initializeBusinessWidgets} from './business-widgets.ts'
import {initializeBusinessDashboards} from './business-dashboards.ts'
import {initializeBusinessDefinitions} from './business-definition-local.ts'
import {initializePageCreateDrafts} from './page-create-drafts.ts'
import {initializeBusinessTasks} from './business-tasks.ts'
import {initializeSecurityRequests} from '../security/request-journal.ts'
import {initializeSecurityActions} from '../security/actions.ts'
import {initializeSecurityApprovals} from '../security/approvals.ts'
import {initializeSecurityActionExecutions} from '../security/action-executions.ts'
import {initializeTaskRuns} from './task-runs.ts'
import {initializeNotificationDeliveries} from './notification-deliveries.ts'
import {initializePendingRequests} from './pending-requests.ts'
import {initializeConversationWork} from './conversation-work.ts'
import {initializeBusinessResponsibilities} from './business-responsibility.ts'

/**
 * Teloa 全库结构的唯一初始化入口。
 *
 * 为什么要收敛成一处：宿主装配曾把 `initialize*` 逐条摊在 `applyHost` 里，开发库一直有表，
 * 顺序从没在空库上跑过；真到空库首启就接连撞上 `relation "teloa_tasks" does not exist`、
 * `relation "teloa_resources" does not exist`。建表次序是全库属性，只能由一处负责。
 *
 * 排序判据：被外键、复合唯一索引引用的表一律排在引用方之前。各初始化器自身的
 * `if not exists` 幂等性保持不变，因此重复调用是空操作，存量库照常无变化。
 *
 * 返回值：看板只读角色的初始化结果（role / fallback / unavailable 与原因），权限不足时降级、不阻断启动，由装配方交给状态页。
 * options.businessSqlSecretPath：只读角色口令文件（运行目录内，0600）；不给则不做角色工作、状态为 unavailable（如安装期初始化）。
 */
export async function initializeTeloaDatabase(pool:Pool,options:{businessSqlSecretPath?:string}={}):Promise<{businessSqlRole:BusinessSqlRoleStatus}>{
 // 资料与知识底座：`teloa_resources` 被任务材料外键引用，必须最先到位。
 await initializeResources(pool)
 await initializePendingRequests(pool)
 // 岗位是任务、计划、群、岗位记忆的共同外键目标。
 await initializeRoles(pool)
 await initializeTasks(pool)
 await initializeProjects(pool)
 await initializePlans(pool)
 await initializeCollaboration(pool)
 await initializeGroupAgentGrants(pool)
 await initializeGroupTasks(pool)
 // 附件原件仓是本人级的，但 `uploaded_in_group_id` 外键指向群，必须排在群表之后。
 await initializeGroupAttachments(pool)
 // 表情与路由决策的外键都打在 `teloa_group_messages` 的 `unique(id,group_id)` 上，必须排在群协作一族之后。
 await initializeGroupReactions(pool)
 await initializeGroupRoutingDecisions(pool)
 await initializeRoleLifecycle(pool)
 await initializeHandoffs(pool)
 await initializeTaskTransitions(pool)
 await initializeObjectConversations(pool)
 await initializeRoleToolGrants(pool)
 await initializeWebAccessPolicy(pool)
 await initializeTaskMaterials(pool)
 // 成果物：快照表先于成果物表，成果物版本表又被任务完成记录与反馈引用。
 await initializeArtifactSnapshots(pool)
 await initializeArtifacts(pool)
 await initializeArtifactFeedback(pool)
 await initializeTaskCompletions(pool)
 // 市场与安装：技能安装表被行业技能引用与执行技能引用共用。
 await initializeMarketContents(pool)
 await initializeSkillInstallations(pool)
 await initializePluginInstallations(pool)
 await initializeGithubSources(pool)
 // 行业加载：`initializeIndustryLoads` 内部先建业务空间、范围标签与迁移回执，各类实例表再引用加载表。
 await initializeIndustryLoads(pool)
 await initializeIndustryKnowledge(pool)
 await initializeIndustryRoles(pool)
 await initializeIndustryTasks(pool)
 await initializeIndustryPlans(pool)
 await initializeIndustryDataSources(pool)
 await initializeIndustryExecutionTools(pool)
 await initializeIndustryMcpConnections(pool)
 await initializeIndustryPlugins(pool)
 // 计划调度：领取记录与调度状态引用计划表与任务表。
 await initializePlanOccurrences(pool)
 // 业务数据在前：安全动作表外键指向业务对象快照与业务任务来源。
 await initializeBusinessData(pool)
 await initializeBusinessSnapshotReferences(pool)
 await initializeBusinessRecords(pool)
 await initializeBusinessRecordImports(pool)
 // 快照数据仓语义：三个安全转换函数与当前版本 / 保留清理两条索引，依附快照表。
 await initializeBusinessWarehouse(pool)
 // 看板只读角色：授权对象是快照表与安全转换函数，必须排在两者之后；无 createrole 等权限不足时降级为事务只读，不阻断启动。
 const businessSqlRole=await initializeBusinessSqlRole(pool,options.businessSqlSecretPath)
 // 运行状态引用上方已初始化的业务范围；只建表，不替旧业务登记或启用。
 await initializeBusinessRuntime(pool)
 // 同步记录与游标：不被任何外键引用，紧随快照数据仓。
 await initializeBusinessSync(pool)
 await initializeBusinessSyncRules(pool)
 // 组件结果快照（查询审计）与看板刷新请求记录：同样不被外键引用。
 await initializeBusinessWidgets(pool)
 await initializeBusinessDashboards(pool)
 // 会话定制的草案与本地声明版本：不被任何外键引用，按"业务数据在前"的同一条注释归位在这里。
 await initializeBusinessDefinitions(pool)
 await initializeBusinessConfigurations(pool)
 await initializeBusinessDashboardResources(pool)
 await initializeBusinessResponsibilities(pool)
 await initializeBusinessConversationBindings(pool)
 await initializePageCreateDrafts(pool)
 await initializeBusinessTasks(pool)
 await initializeSecurityRequests(pool)
 await initializeSecurityActions(pool)
 await initializeSecurityApprovals(pool)
 await initializeSecurityActionExecutions(pool)
 // 执行在前、通知在后：投递记录同时引用领取记录、计划、任务与执行。
 await initializeTaskRuns(pool)
 await initializeConversationWork(pool)
 // 岗位记忆要给 `teloa_task_runs` 补列，必须排在执行表之后。
 await initializeRoleMemory(pool)
 await initializeRoleDailyLogs(pool)
 await initializeNotificationDeliveries(pool)
 return {businessSqlRole}
}
