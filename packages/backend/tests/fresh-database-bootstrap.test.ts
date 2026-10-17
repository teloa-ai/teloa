import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import type {Pool as PoolType} from 'pg'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {BusinessScopeService,BusinessSpaceService,initializeTeloaDatabase} from '../src/index.ts'

let container:StartedPostgreSqlContainer,pool:PoolType
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 // 全新容器即空库：这里刻意不调用任何单个初始化器，首启路径必须自己把表建全。
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

/** 2026-10-12核对统一初始化链与静态DDL的完整表清单；期待不在测试运行时从被测实现推导。 */
const expectedTables=[
 "teloa_artifact_revision_producers",
 "teloa_artifact_revision_requests",
 "teloa_method_reuse_requests",
 "teloa_business_dashboard_data_revisions",
 "teloa_business_data_changes",
 "teloa_business_task_result_heads",
 "teloa_business_task_result_receipts",
 "teloa_group_routing_outbox",
 "teloa_group_routing_wakes",
 "teloa_group_run_sources",
 "teloa_group_work_link_requests",
 "teloa_group_work_links",
 "teloa_memory_installation",
 "teloa_owner_routing_budget_accounts",
 "teloa_owner_work_budgets",
 "teloa_plan_schedule_coalesces",
 "teloa_plan_work_events",
 "teloa_role_experience_indexes",
 "teloa_role_memory_views",
 "teloa_role_work_delegation_requests",
 "teloa_role_work_delegations",
 "teloa_task_configuration_requests",
 "teloa_task_draft_requests",
 "teloa_task_run_flow_waits",
 "teloa_task_run_goal_continuations",
 "teloa_task_run_goal_revisions",
 "teloa_task_run_goals",
 "teloa_task_work_lineage",
 "teloa_twin_execution_consent_requests",
 "teloa_twin_execution_consents",
 "teloa_work_budget_accounts",
 "teloa_work_budget_changes",
 "teloa_work_budget_reservations",
 "teloa_work_control_hosts",
 "teloa_work_control_progress",
 "teloa_work_control_requests",
 "teloa_work_controls",
 "teloa_work_events",
 "teloa_work_plan_bindings",
 "teloa_work_progress",
 "teloa_work_progress_receipts",
 "teloa_work_progress_rounds",
 "teloa_work_recovery_requests",
 "teloa_work_recovery_tickets",
 "teloa_work_retries",
 "teloa_work_retry_claims",
 "teloa_work_retry_receipts",
 "teloa_work_stagnation",
 "teloa_work_stagnation_allowances",
 "teloa_artifact_feedback",
 "teloa_artifact_files",
 "teloa_artifact_message_snapshots",
 "teloa_artifact_messages",
 "teloa_artifact_snapshots",
 "teloa_artifact_versions",
 "teloa_artifacts",
 "teloa_attachment_requests",
 "teloa_attachments",
 "teloa_business_configuration_drafts",
 "teloa_business_configuration_heads",
 "teloa_business_configuration_receipts",
 "teloa_business_configuration_versions",
 "teloa_business_conversation_bindings",
 "teloa_business_dashboard_migrations",
 "teloa_business_dashboard_preparations",
 "teloa_business_dashboard_refreshes",
 "teloa_business_definition_drafts",
 "teloa_business_local_definition_heads",
 "teloa_business_local_definitions",
 "teloa_business_object_snapshots",
 "teloa_business_record_batches",
 "teloa_business_record_heads",
 "teloa_business_record_import_drafts",
 "teloa_business_record_import_receipts",
 "teloa_business_record_import_source_keys",
 "teloa_business_record_receipts",
 "teloa_business_responsibilities",
 "teloa_business_responsibility_requests",
 "teloa_business_runtime",
 "teloa_business_runtime_requests",
 "teloa_business_scopes",
 "teloa_business_snapshot_references",
 "teloa_business_space_edits",
 "teloa_business_space_migrations",
 "teloa_business_spaces",
 "teloa_business_sync_cursors",
 "teloa_business_sync_object_ids",
 "teloa_business_sync_rule_requests",
 "teloa_business_sync_rules",
 "teloa_business_sync_runs",
 "teloa_business_task_action_sources",
 "teloa_business_task_sources",
 "teloa_business_widget_results",
 "teloa_conversation_knowledge_operations",
 "teloa_conversation_work_context_requests",
 "teloa_conversation_work_contexts",
 "teloa_conversation_work_frozen_sessions",
 "teloa_conversation_work_requests",
 "teloa_github_source_files",
 "teloa_github_source_requests",
 "teloa_group_agent_grants",
 "teloa_group_change_requests",
 "teloa_group_members",
 "teloa_group_messages",
 "teloa_group_reactions",
 "teloa_group_read_cursors",
 "teloa_group_resource_requests",
 "teloa_group_resource_versions",
 "teloa_group_resources",
 "teloa_group_routing_decisions",
 "teloa_group_task_sources",
 "teloa_groups",
 "teloa_handoff_resolutions",
 "teloa_industry_data_source_authorize_requests",
 "teloa_industry_data_source_create_requests",
 "teloa_industry_data_source_instances",
 "teloa_industry_execution_tool_authorize_requests",
 "teloa_industry_execution_tool_create_requests",
 "teloa_industry_execution_tool_instances",
 "teloa_industry_knowledge_instances",
 "teloa_industry_knowledge_requests",
 "teloa_industry_load_items",
 "teloa_industry_load_request_repairs",
 "teloa_industry_load_requests",
 "teloa_industry_load_unload_requests",
 "teloa_industry_load_upgrade_requests",
 "teloa_industry_loads",
 "teloa_industry_mcp_connect_requests",
 "teloa_industry_mcp_create_requests",
 "teloa_industry_mcp_instances",
 "teloa_industry_plan_sources",
 "teloa_industry_plugin_create_requests",
 "teloa_industry_plugin_install_requests",
 "teloa_industry_plugin_instances",
 "teloa_industry_role_instances",
 "teloa_industry_role_requests",
 "teloa_industry_task_sources",
 "teloa_industry_upgrade_plans",
 "teloa_knowledge_directory_operations",
 "teloa_knowledge_items",
 "teloa_knowledge_nodes",
 "teloa_knowledge_resource_revisions",
 "teloa_knowledge_revision_requests",
 "teloa_knowledge_sources",
 "teloa_knowledge_spaces",
 "teloa_knowledge_versions",
 "teloa_market_contents",
 "teloa_market_files",
 "teloa_market_imports",
 "teloa_message_snapshots",
 "teloa_notification_deliveries",
 "teloa_object_conversation_requests",
 "teloa_object_conversations",
 "teloa_page_create_drafts",
 "teloa_pending_request_registry",
 "teloa_plan_changes",
 "teloa_plan_occurrences",
 "teloa_plan_schedule_skips",
 "teloa_plan_schedule_state",
 "teloa_plan_scheduler_acks",
 "teloa_plan_scheduler_status",
 "teloa_plan_task_links",
 "teloa_plans",
 "teloa_plugin_install_requests",
 "teloa_plugin_installations",
 "teloa_project_edits",
 "teloa_project_migrations",
 "teloa_projects",
 "teloa_resource_drafts",
 "teloa_resource_reads",
 "teloa_resources",
 "teloa_retrieval_chunks",
 "teloa_retrieval_enrollments",
 "teloa_retrieval_indexes",
 "teloa_role_daily_log_changes",
 "teloa_role_daily_logs",
 "teloa_role_edits",
 "teloa_role_memories",
 "teloa_role_memory_changes",
 "teloa_role_memory_creations",
 "teloa_role_memory_versions",
 "teloa_role_tool_grants",
 "teloa_role_transitions",
 "teloa_roles",
 "teloa_security_action_attention_acknowledgements",
 "teloa_security_action_audit",
 "teloa_security_action_execution_audit",
 "teloa_security_action_execution_receipts",
 "teloa_security_action_execution_requests",
 "teloa_security_action_execution_transitions",
 "teloa_security_action_executions",
 "teloa_security_action_observation_audit",
 "teloa_security_action_observation_requests",
 "teloa_security_action_requests",
 "teloa_security_action_transitions",
 "teloa_security_actions",
 "teloa_security_approval_requests",
 "teloa_security_approvals",
 "teloa_security_requests",
 "teloa_skill_install_availability",
 "teloa_skill_install_availability_migrations",
 "teloa_skill_install_maintenance_requests",
 "teloa_skill_install_requests",
 "teloa_skill_install_usages",
 "teloa_skill_installations",
 "teloa_skill_selection_migrations",
 "teloa_skill_selection_requests",
 "teloa_skill_selections",
 "teloa_task_completions",
 "teloa_task_edits",
 "teloa_task_handoff_changes",
 "teloa_task_handoffs",
 "teloa_task_material_requests",
 "teloa_task_materials",
 "teloa_task_run_flow_receipts",
 "teloa_task_run_flows",
 "teloa_task_run_runtime_links",
 "teloa_task_run_skill_refs",
 "teloa_task_run_subagents",
 "teloa_task_run_web_access",
 "teloa_task_runs",
 "teloa_task_transitions",
 "teloa_tasks",
 "teloa_web_access_policy",
 // 4a1ed0d：本地业务工作与已批准记录变更（business-change-sets / business-object-work-links / business-sync 成果引用）。
 "teloa_business_change_requests",
 "teloa_business_change_sets",
 "teloa_business_object_work_links",
 "teloa_business_work_requests",
 "teloa_business_work_results",
 "teloa_business_task_result_references",
 // 925ead8：项目上下文注入、来源可溯记忆提炼、个人记忆与项目运行时（project-context / project-memory-extraction / project-personal-memory / project-runtime）。
 "teloa_project_contexts",
 "teloa_project_context_entries",
 "teloa_project_context_requests",
 "teloa_project_context_revisions",
 "teloa_project_context_shares",
 "teloa_project_context_uses",
 "teloa_project_conversation_memberships",
 "teloa_project_extraction_candidates",
 "teloa_project_extraction_events",
 "teloa_project_extraction_forgotten_sources",
 "teloa_project_extraction_retries",
 "teloa_project_runtime_requests",
 "teloa_project_runtime_settings",
 "teloa_personal_memory_entries",
 "teloa_personal_memory_requests",
 "teloa_personal_memory_stores",
 // fda1c9b：群原消息重试尝试历史、群任务交接资料与群对原工作的追加/停止回执（group-routing-attempts / group-tasks / group-work-inputs）。
 "teloa_group_routing_attempts",
 "teloa_group_task_handoffs",
 "teloa_group_work_inputs"
].sort()
const tableNames=async():Promise<string[]>=>
 (await pool.query("select table_name from information_schema.tables where table_schema='public' and table_name like 'teloa\\_%' order by table_name")).rows.map(row=>row.table_name as string)

const tableIdentities=async()=>
 (await pool.query("select c.relname,c.oid from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname")).rows.filter(row=>String(row.relname).startsWith('teloa_'))

test('空库首启一次建全结构，重跑是无操作',async()=>{
 await initializeTeloaDatabase(pool)
 const first=await tableNames()
 const identities=await tableIdentities()
 assert.deepEqual(first,expectedTables,`首启须建立完整新旧结构，缺表或额外表均需显式核对；缺失 ${JSON.stringify(expectedTables.filter(name=>!first.includes(name)))}；额外 ${JSON.stringify(first.filter(name=>!expectedTables.includes(name)))}`)
 assert.ok(first.includes('teloa_task_run_subagents'),'首启必须建立执行态子任务登记表')
 assert.ok(first.includes('teloa_task_run_runtime_links'),'首启必须建立原生后台工作与 Team 的业务关联表')
 assert.ok(first.includes('teloa_projects')&&first.includes('teloa_project_edits'),'首启必须建立项目及编辑回执表')
 // 两张一次性迁移标记表：项目 references 回填（references-backfill-v1）与看板结果按时间范围分份（widget-results-time-range-v1）。
 assert.ok(first.includes('teloa_project_migrations'),'首启必须建立项目迁移标记表')
 assert.ok(first.includes('teloa_business_dashboard_migrations'),'首启必须建立看板迁移标记表')
 for(const name of ['teloa_conversation_work_contexts','teloa_conversation_work_context_requests','teloa_conversation_work_requests'])assert.ok(first.includes(name),'首启必须建立会话交办表：'+name)
 assert.ok(first.includes('teloa_web_access_policy'),'首启必须建立上网总开关与拦截名单表')
 // 运行内上网记录表的复合外键依赖 `teloa_task_run_owner_identity`，它只在 `initializeTaskRuns` 的链上建出。
 assert.ok(first.includes('teloa_task_run_web_access'),'首启必须建立运行内上网记录表')
 assert.ok(first.includes('teloa_group_resources'),'首启必须建立群共享资料目录表')
 assert.ok(first.includes('teloa_group_resource_versions'),'首启必须建立群共享资料版本表')
 assert.ok(first.includes('teloa_group_resource_requests'),'首启必须建立群共享资料请求回执表')
 assert.ok(first.includes('teloa_pending_request_registry'),'首启必须建立待恢复请求目录表')
 assert.ok(first.includes('teloa_attachments'),'首启必须建立本人级附件原件仓')
 assert.ok(first.includes('teloa_attachment_requests'),'首启必须建立附件上传回执表')
 // 这两张表的外键打在 `teloa_group_messages` 的 `unique(id,group_id)` 上，只在群协作一族之后才建得出来。
 assert.ok(first.includes('teloa_group_reactions'),'首启必须建立群消息表情表')
 assert.ok(first.includes('teloa_group_routing_decisions'),'首启必须建立群内路由决策表')
 // 重试历史只增、追加回执身份与终态不可改由触发器兜底；未结回执按 v2 状态集索引，旧索引已退役。
 const groupGuards=async()=>({
  triggers:(await pool.query("select tgname from pg_trigger where not tgisinternal and tgrelid in ('teloa_group_routing_attempts'::regclass,'teloa_group_work_inputs'::regclass) order by tgname")).rows.map(row=>row.tgname as string),
  indexes:(await pool.query("select indexname from pg_indexes where schemaname='public' and indexname like 'teloa\\_group\\_work\\_inputs\\_open%' order by indexname")).rows.map(row=>row.indexname as string)
 })
 assert.deepEqual(await groupGuards(),{triggers:['teloa_group_routing_attempts_append_only','teloa_group_work_inputs_guard'],indexes:['teloa_group_work_inputs_open_v2']})
 // 快照数据仓的四个安全转换函数随首启建出（改写器产物以 public. 限定名调用它们）。
 const functions=async()=>(await pool.query("select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname like 'teloa\\_safe\\_%' order by proname")).rows.map(row=>row.proname as string)
 assert.deepEqual(await functions(),['teloa_safe_boolean','teloa_safe_duration_seconds','teloa_safe_numeric','teloa_safe_timestamptz'])
 // 幂等：第二次不报错，也不改变结构。
 await initializeTeloaDatabase(pool)
 assert.deepEqual(await tableNames(),first)
 assert.deepEqual(await tableIdentities(),identities,'重复初始化不得以同名新表替换已有结构')
 assert.deepEqual(await groupGuards(),{triggers:['teloa_group_routing_attempts_append_only','teloa_group_work_inputs_guard'],indexes:['teloa_group_work_inputs_open_v2']})
 assert.deepEqual(await functions(),['teloa_safe_boolean','teloa_safe_duration_seconds','teloa_safe_numeric','teloa_safe_timestamptz'])
})

test('首启之后本人空间与内置范围标签可直接使用',async()=>{
 await initializeTeloaDatabase(pool)
 const ownerId='local:fresh-bootstrap'
 const spaces=new BusinessSpaceService(pool,{id:randomUUID,now:()=>new Date().toISOString()})
 const personal=await spaces.ensurePersonal(ownerId)
 assert.equal(personal.name,'我的工作空间')
 assert.equal(personal.kind,'personal')
 assert.deepEqual(await spaces.ensurePersonal(ownerId),personal)
 const labels=await new BusinessScopeService(pool).list(ownerId)
 assert.deepEqual(labels.map(label=>[label.scope,label.title,label.kind]),[['general','通用工作','builtin']],'新装只从通用工作开始，SOC/AppSec 不再预登记')
})
