import {BusinessDashboardResourceService,BusinessConfigurationStore,BusinessConfigurationDraftService,BusinessConfigurationService,BusinessConfigurationPreviewService,BusinessConfigurationPageService,BusinessConversationBindingService,BusinessResponsibilityService,BusinessRecordService,BusinessRecordImportService,parseBusinessImportCsv,BusinessRuntimeService,BusinessSnapshotReferenceService} from '@teloa/backend'
import {businessDashboardResourceEndpoints,createBusinessDashboardResourceHandler} from './business-dashboard-resource.ts'
import {businessBuilderEndpoints,createBusinessBuilderHandler} from './business-builder.ts'
import {registerBusinessBuilderTools} from './business-builder-tools.ts'
import {registerBusinessRecordTools} from './business-record-tools.ts'
import {registerBusinessImportTools} from './business-import-tools.ts'
import {createBusinessImportFilePort} from './business-import-files.ts'
import {createBusinessImportXlsxPort} from './business-import-xlsx.ts'
import {businessImportEndpoints,createBusinessImportHandler} from './business-import-handler.ts'
import {businessResponsibilityEndpoints,createBusinessResponsibilityHandler} from './business-responsibility.ts'
import {registerBusinessResponsibilityTools} from './business-responsibility-tools.ts'
import type {BusinessConversationAuthorizationPorts} from './business-conversation-authorization.ts'
import {createTaskRunModelReader} from './task-run-model-status.ts'
import {officialCatalogModelEntry,type TaskRunSkillDatabase} from '@teloa/backend'
import {createHostIndustryModelProbe} from './industry-model-readiness.ts'
import {withPresetReadScope} from './preset-read-scope.ts'
export {SecurityActionHttpAdapter,type SecurityActionHttpOptions} from './security-action-http-adapter.ts'
import {SecurityActionHttpAdapter} from './security-action-http-adapter.ts'
import {SecurityActionExecutionDriver} from './security-action-execution.ts'
import {createSecurityActionDefinitionCatalog} from './security-action-definitions.ts'
import {createSecurityActionHandler,securityActionEndpoints} from './security-actions.ts'
import {SecurityRequestJournal,SecurityActionService,SecurityApprovalService,SecurityActionExecutionService,PgSecurityExecutionExistsReader,SecurityActionPanelService,SecurityActionAttentionService,PendingRequestService,isPendingRequestEndpoint} from '@teloa/backend'
export {createSecurityActionDefinitionCatalog} from './security-action-definitions.ts'
export {createSecurityActionHandler,securityActionEndpoints,readSecurityActionAttention} from './security-actions.ts'
import {createSkillUpgradePreviewHandler,skillUpgradePreviewEndpoints} from './skill-upgrade-preview.ts'
import {SkillUpgradePreviewService} from '@teloa/backend'
import {createSkillSelectionHandler,skillSelectionEndpoints} from './skill-selections.ts'
import {SkillSelectionService} from '@teloa/backend'
import {createManagedAvailabilitySync} from './managed-skill-availability-sync.ts'
import {createSkillAvailabilityHandler,skillAvailabilityEndpoints} from './skill-availability.ts'
import {SkillAvailabilityService,readInstalledSkillBinding,readRoleIndustrySkillNames,readSkillAvailabilityByName,resolveIndustryRunSkillBindings} from '@teloa/backend'
import {createManagedRunSkillResolver,createManagedRunSkillVerifier,type ManagedRunSkillPorts} from './managed-run-skills.ts'
import {createManagedRunSkillScope} from './managed-run-skill-scope.ts'
import {registerManagedRunSkillPreStep} from './managed-run-skill-pre-step.ts'
import {SkillInstallationService,SkillInstallSource,readInstalledSkillInstallation} from '@teloa/backend'
import {ManagedSkillFiles} from './managed-skill-files.ts'
import {inspectNativeSkillDirectory,registerManagedSkills} from './managed-skills-native.ts'
import {createSkillInstallationsHandler,skillInstallationEndpoints} from './skill-installations.ts'
import {createPlanRuntime} from './plan-runtime.ts'
import {runtimeAdmission} from './runtime-admission.ts'
import type {} from './native-input-provider.ts'
import {startPlanScheduler} from './plan-scheduler.ts'
import {createAutoDreamHabitTick} from './auto-dream-habit-tick.ts'
import {createPlanScheduleHandler,planScheduleEndpoints} from './plan-schedule.ts'
import {createPlanHandler,planEndpoints} from './plans.ts'
import {registerPlanTools,authorizePlanManagement} from './plan-tools.ts'
import {registerConversationWorkTools} from './conversation-work-tools.ts'
import {ConversationWorkDispatch} from './conversation-work-dispatch.ts'
import {publishConversationWorkStatus} from './conversation-work-publisher.ts'
import {readTaskRunGroupResult} from './task-run-group-result.ts'
import {ConversationWorkService,WorkFactsService,workRequestChildId} from '@teloa/backend'
import {registerIndustryPlanTools} from './industry-plan-tools.ts'
import {registerSkillInstallTools} from './skill-install-tools.ts'
import {registerMarketSessionTools} from './market-session-tools.ts'
import {createSkillHttpAuthorizer,createSkillRateLimiter,registerSkillHttpTool,type SkillHttpAuditEvent} from './skill-http-tool.ts'
import {registerSkillSecretHint} from './skill-secret-hint.ts'
import {hasActiveUserInstruction} from './conversation-mutation.ts'
import {registerMarketReviewTools} from './market-review-tools.ts'
import {selfAuthorizedToolNames} from './self-authorized-tools.ts'
export {selfAuthorizedToolNames} from './self-authorized-tools.ts'
import {registerBusinessDefinitionTools} from './business-definition-tools.ts'
import {registerKnowledgeTools} from './knowledge-tools.ts'
import {readSkillInstallDirectory} from './skill-install-directory.ts'
import type {IndustryLoadPage,IndustryRoleInstance} from '@teloa/backend'
import {readRunKnowledge} from '@teloa/backend'
import type {TaskExecutionScope,TaskRun} from '@teloa/backend'
import {ConversationKnowledgeService,PlanService,MarketContentStore,RoleToolGrantService,RoleService as GrantRoleReader} from '@teloa/backend'
import {createMarketContentHandler,marketContentEndpoints,encodeReceipt as encodeMarketReceipt} from './market-content.ts'
import {createMarketCatalogHandler,marketCatalogEndpoints} from './market-catalog.ts'
import {credentialKey,type CredentialProvider} from '@deepseek-ai/dsh-credentials'
import {createMarketReviewsHandler,marketReviewEndpoints} from './market-reviews.ts'
import {createResourceInstallReporter,createSignalActivity,detectExclusion,registerUsageActivity} from './usage-stats.ts'
import {createSolutionRoleResolver,withResourceInstallReport,withSolutionRoleReport} from './market-install-report.ts'
import {createMarketRanking} from './market-ranking.ts'
import {createRoleToolGrantHandler,roleGrantPageRules,roleToolGrantEndpoints,referenceToolRules,skillHttpGrantCandidates,taskRunToolRules,validateReferenceToolRules,webToolRules,type SkillHttpGrantCandidate} from './role-tool-grants.ts'
import {createWebAccessHandler,webAccessEndpoints} from './web-access.ts'
import {monitorTaskRuns} from './task-run-monitor.ts'
import {readSessionEvents,projectSessionEvent} from './session-events.ts'
import {TaskRunDriver} from './task-run-driver.ts'
import {createTaskRunGroupPublisher} from './task-run-group-publisher.ts'
import {ObjectConversationService} from '@teloa/backend'
import {readRunGroupArtifactImageBytes,TaskRunService,TaskRunSubagentService,TaskRunRuntimeLinkService,type TaskRunRuntimeLinks} from '@teloa/backend'
import {isTextOnlyTaskRun} from './task-run-background.ts'
import {WebAccessPolicyService,TaskRunWebAccessService} from '@teloa/backend'
import {registerTaskToolGuard,type TaskToolPolicyReader} from './task-tool-guard.ts'
import {registerNativeAutoReviewGuard} from './native-auto-review-guard.ts'
import {guardDecision,protectedRootsFor,redactRunMessage,registerCredentialGuards} from './credential-guards.ts'
import {knownSecretValues} from './credentials/known-values.ts'
import {checkPromptSecrets,groupMessageSecretGate,storedSecretSource} from './prompt-secret-gate.ts'
import {isNativeToolName,nativeToolRules} from './native-tool-access.ts'
import {createTaskRunTeam,stopTaskRunChildren} from './task-run-team.ts'
import {createTaskRunOrchestration} from './task-run-orchestration.ts'
import {createTaskRunBrowser,attachTaskRunBrowser} from './task-run-browser.ts'
import {assertRoutingGuardRegisteredFirst,registerGroupRoutingGuard} from './group-routing-guard.ts'
import {assertRoutingPreset,isRoutingSession} from './group-routing.ts'
import {dispatchGroupRouting,readRoutingCandidates,readRoutingGroup,readRoutingMessage,readRoutingTopic,type GroupRoutingDispatchPorts} from './group-routing-dispatch.ts'
import {readSubagentDelegationLimits} from './subagent-delegation.ts'
import {registerTaskSubagentTool} from './task-subagent-tool.ts'
import {createTaskRunHandler,taskRunEndpoints} from './task-runs.ts'
import {createTaskRunFlowHandler,taskRunFlowEndpoints} from './task-run-flows.ts'
import {TaskRunFlowService} from '@teloa/backend'
import {NotificationDeliveryService} from '@teloa/backend'
import {NotificationDeliveryDriver,createLocalNotificationAdapter,createBroadcastNotificationAdapter} from './notification-deliveries.ts'
import {createTaskMaterialHandler,createTaskMaterialKnowledgeLoader,taskMaterialEndpoints} from './task-materials.ts'
import {dshTaskRunPorts,prepareDshTaskSession,taskKnowledgeAuthorization} from './task-run-dsh.ts'
import {resolveDshManagedRoleSkills} from './role-skills-dsh.ts'
import {TaskTransitions} from '@teloa/backend'
import {TaskMaterialService} from '@teloa/backend'
import {readNativeArtifactMessage} from './native-artifact-message.ts'
import {createRoleHandler,roleEndpoints} from './roles.ts'
import {createRoleMemoryHandler,registerRoleMemoryTools,roleMemoryEndpoints} from './role-memory.ts'
import {createRoleDailyLogHandler,registerRoleDailyDigestTools,roleDailyLogEndpoints} from './role-daily-log.ts'
import {createGroupHandler,groupEndpoints} from './groups.ts'
import {createGroupAgentGrantHandler,groupAgentGrantEndpoints} from './group-agent-grants.ts'
import {createGroupTaskHandler,groupTaskEndpoints} from './group-tasks.ts'
import {createGroupAttachmentHandler,createGroupAttachmentUploadRoute,groupAttachmentEndpoints,groupAttachmentUploadEndpoint,toBackendBytePorts} from './group-attachments.ts'
import {groupAttachToolName,registerGroupAttachTool} from './group-attach-tool.ts'
import {registerGroupReactTool} from './group-react-tool.ts'
import {createAttachmentPorts} from './attachments.ts'
import {createTaskHandler,taskEndpoints} from './tasks.ts'
import {createProjectHandler,projectEndpoints} from './projects.ts'
import {ProjectService} from '@teloa/backend'
import {createTaskAttentionHandler} from './task-attention.ts'
import {TaskAttentionService,IndustryLoadService,createIndustryLoadSource} from '@teloa/backend'
import {createIndustryLoadsHandler,industryLoadEndpoints} from './industry-loads.ts'
import {createIndustryPrepareHandler,industryPrepareEndpoints} from './industry-prepare.ts'
import {createIndustryKnowledgeHandler,industryKnowledgeEndpoints} from './industry-knowledge.ts'
import {createIndustryDataSourceHandler,industryDataSourceEndpoints} from './industry-data-sources.ts'
import {createIndustryDataSourceReadiness} from './industry-data-source-readiness.ts'
import {createIndustryExecutionToolHandler,industryExecutionToolEndpoints} from './industry-execution-tools.ts'
import {createIndustryMcpConnectionHandler,industryMcpConnectionEndpoints} from './industry-mcp-connections.ts'
import {createIndustryPluginHandler,guardDshPluginInstall,industryPluginEndpoints} from './industry-plugins.ts'
import {createIndustryMcpReadiness} from './industry-mcp-readiness.ts'
import {createManagedMcpConnectionHandler,managedMcpConnectionEndpoints,registerManagedMcpWriteApproval} from './managed-mcp-connections.ts'
import {installManagedPackage,sweepManagedPackageStaging} from './managed-package-install.ts'
import {createImAttachWindow,createTeloaWorkService,type TeloaWorkService} from './teloa-work-service.ts'
import {createBundledExtensionHandler} from './bundled-extensions.ts'
import {IM_GATEWAY_PACKAGE,LOCAL_EMBEDDING_PACKAGE,bundledModuleConflicts,bundledSourceConflicts,bundledSourceRefusal,officialBundledSpecs} from './bundled-extensions-profile.ts'
import {BundledHotApplyUnsupported,hotApplyBundledExtension,hostBundledHotApplyPorts} from './bundled-extensions-apply.ts'
import {profileBundles,readJsonFile} from './pending-plugins.ts'
import {acceptanceOAuthFixture} from './managed-mcp-acceptance.ts'
import {securityEnv,warnIgnoredLaunchEnv} from './launch-env.ts'
import {createConnectorHandler,connectorEndpoints} from './connectors.ts'
import {IndustryDataSourceService,IndustryDataSourceSource,IndustryExecutionToolService,IndustryExecutionToolSource,IndustryMcpConnectionService,IndustryMcpConnectionSource,IndustryPluginService,IndustryPluginSource,projectPluginState,IndustryKnowledgeService,IndustryReferenceCatalog,IndustryRoleService,IndustryRoleSource,ConnectorProbeService} from '@teloa/backend'
import {createIndustryRolesHandler,industryRoleEndpoints} from './industry-roles.ts'
import {IndustryTaskService,IndustryWorkSource} from '@teloa/backend'
import {createIndustryTasksHandler,industryTaskEndpoints} from './industry-tasks.ts'
import {IndustryPlanService,IndustryPlanSource} from '@teloa/backend'
import {createIndustryPlansHandler,industryPlanEndpoints} from './industry-plans.ts'
import { RoleService,TaskService,RoleLifecycleService,HandoffService,CollaborationService,GroupAgentGrantService,GroupAttachmentService,GroupTaskService,GroupRunMessageService,readRunGroupContext,type RunGroupFilePorts } from '@teloa/backend'
import {readRunGroupTopic} from '@teloa/backend'
import {GroupReactionService,GroupRoutingDecisionService} from '@teloa/backend'
import {readHomeSkills} from './home-skills.ts'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile as readTextFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionHeader, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-file-reference'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ConversationService, FileConversationRepository, CopyService, FileCopyRepository, CopyRejectedError, CopyPendingError, sessionInput } from '@teloa/backend'
import { WorkError,roleSupportsScope,taskInput,groupRoutedReactionRequestId,isRecord,officialExtensionPackages,readPageCreateAtomicSkillDraft,readTaskHandoffChangeInput,imChannelEndpoints,bundledExtensionEndpoints,retrievalEndpoints,localModelEndpoints,modelOptionEndpoints,type CapabilitySnapshot } from '@teloa/contract'
import { registerResources,resourceEndpoints } from './resources.ts'
import { createCredentialStoreHandler,credentialStoreEndpoints } from './credential-store.ts'
import {createSkillSecretStore,declaredSkillSecretsResolver,isManagedSkillWinner,skillSecretEndpoints} from './skill-secrets.ts'
import { registerSkillContextDedup } from './skill-context.ts'
import {registerRoleConversationContext} from './role-conversation-context.ts'
import { createArtifactFileReader,artifactFileEndpoints } from './artifact-files.ts'
import {createArtifactHandler,artifactEndpoints} from './artifacts.ts'
import {readDshModelOptions} from './model-options.ts'
import {createLocalModelsHandler} from './local-models.ts'
import {installLocalModelRequests} from './local-model-request.ts'
import {OllamaClient} from './ollama-client.ts'
import {RoleMemoryService,RoleDailyLogService,AutoDreamHabitService,readAutoDreamSetting} from '@teloa/backend'

export {SecurityActionExecutionDriver,type SecurityActionAdapter} from './security-action-execution.ts'
import {BusinessDataService} from '@teloa/backend'
import {createBusinessDataHandler,businessDataEndpoints} from './business-data.ts'
import {BusinessScopeService,BusinessSpaceService,readEdition} from '@teloa/backend'
import {createBusinessSpaceHandler,businessSpaceEndpoints} from './business-spaces.ts'
import {createBusinessScopeHandler,businessScopeEndpoints} from './business-scopes.ts'
import {BusinessLedgerService,BusinessDefinitionSourceReader,BusinessLocalDefinitionService,BusinessDefinitionPreviewService,PageCreateDraftService,PageCreatePreviewService,type BusinessLocalDraftInput} from '@teloa/backend'
import {createBusinessDefinitionHandler,businessDefinitionEndpoints,activeSourceIds} from './business-definitions.ts'
import {BusinessWarehouseService,BusinessSyncService,BusinessWidgetService,BusinessDashboardService,BusinessSqlExecutor,businessSqlPoolConfig,businessDataPortSyncSource,type BusinessSyncSourceResolver} from '@teloa/backend'
import {createBusinessDashboardHandler,businessDashboardEndpoints,businessSyncRuleWriteEndpoint,businessSyncRuntimeEndpoints} from './business-dashboards.ts'
import {createBusinessSyncTick} from './business-sync-scheduler.ts'
import {createMcpSyncSource} from './business-mcp-sync-source.ts'
import {registerBusinessResultTools} from './business-result-tools.ts'
import {registerLocalRetrieval,type EmbeddingServiceLike} from './local-retrieval.ts'
import {createPageCreateDraftHandler,pageCreateDraftEndpoints} from './page-create-drafts.ts'
import {registerPageCreateTools} from './page-create-tools.ts'
import {builtinSkillCreatorName,prepareBuiltinSkill,prepareBuiltinSkillCreator,registerBuiltinSkill,registerBuiltinSkillCreator,type BuiltinSkillCreator} from './builtin-skill-creator.ts'
import {builtinDashboardDesignerName} from './builtin-dashboard-designer.ts'
import {SecurityAlertHttpSource} from './security-alert-source.ts'
import {BusinessTaskService} from '@teloa/backend'
import {createBusinessTaskHandler,businessTaskEndpoints,readRunBusinessTaskContext} from './business-tasks.ts'
import {GithubImportService,GithubSourceService,OfficialCatalogService,officialCatalogBuiltin,loadOfficialUpstreamIndex,OfficialCatalogRemote,type GithubHttpPort} from '@teloa/backend'
import {detectMarketRemoteExclusion,MARKET_INDEX_PUBLIC_KEY,TELOA_APP_VERSION} from './market-remote.ts'
import {createGithubSourceHandler,githubSourceEndpoints} from './github-source.ts'
import {PluginInstallationService} from '@teloa/backend'
import {createMarketPluginInstallationHandler,marketPluginInstallationEndpoints} from './market-plugin-installations.ts'
import {DshPluginInstallAdapter,readActiveDshPluginRefs} from './dsh-plugin-install-adapter.ts'
import {codeOf,reconcileInterruptedPluginInstallations} from './plugin-startup-reconcile.ts'
import {resolveTeloaDshHome,resolveTeloaDshProfile,resolveTeloaRuntime,resolveTeloaWorkspaceRoot,workspaceRefusedForRepository} from './runtime-paths.ts'
import {assertCompositionSafety,readCompositionRows,readProfileFacts} from './composition-safety.ts'
import {registerTeloaLogFile} from './teloa-log.ts'

import {initializeTeloaDatabase} from '@teloa/backend'

export const name='teloa-harness-dsh'
// 子 Agent 的执行态工具闸需要沿会话谱系读取父 Agent；未声明此依赖时，
// 子会话首轮会在运行时因 Cordis 拒绝读取 `agents` 而失败。
// 模型目录和固定 Run 策略直接读取 llm；真实兄弟服务不能靠根 Context 桩隐式访问。
export const inject=['llm','connection','sessions','sessionController','workspaceRegistry','tools','skills','agentPresets','agents','subagents','agentTeams','sessionPersistence','jobs','permissionPresets','sandboxPolicy','tokenMeter','fs','fileReferences','attachments','webServer','settings','credentials']
const projectRoot=fileURLToPath(new URL('../../../',import.meta.url))
const owner='local:teloa-owner'
const conversationWorkContextEndpoints=['work-context/read','work-context/set','work-context/eligibility','work-requests/list','work-requests/status','work-requests/stop','work-requests/resume'] as const
export const handoffEndpoints=['handoffs/list','handoffs/resolve','handoffs/change'] as const
const endpointSet=new Set([...conversationWorkContextEndpoints,...projectEndpoints,...securityActionEndpoints,...businessSpaceEndpoints,...businessScopeEndpoints,...businessDataEndpoints,...businessBuilderEndpoints,...businessDashboardResourceEndpoints,...businessImportEndpoints,...businessResponsibilityEndpoints,...businessDefinitionEndpoints,...businessDashboardEndpoints,...pageCreateDraftEndpoints,...businessTaskEndpoints,...githubSourceEndpoints,...marketPluginInstallationEndpoints,...skillUpgradePreviewEndpoints,...skillSelectionEndpoints,...skillAvailabilityEndpoints,...skillInstallationEndpoints,...industryPlanEndpoints,...industryTaskEndpoints,...industryRoleEndpoints,...industryKnowledgeEndpoints,...industryDataSourceEndpoints,...industryExecutionToolEndpoints,...industryMcpConnectionEndpoints,...connectorEndpoints,...industryPluginEndpoints,...managedMcpConnectionEndpoints,...industryLoadEndpoints,...industryPrepareEndpoints,'tasks/attention',...planScheduleEndpoints,...planEndpoints,...marketContentEndpoints,...marketCatalogEndpoints,...roleToolGrantEndpoints,...webAccessEndpoints,...taskMaterialEndpoints,...taskRunEndpoints,...taskRunFlowEndpoints,'tasks/context','object-conversations/list','object-conversations/session','object-conversations/change','conversations/create','conversations/read','conversations/ensure','conversations/adopt','conversations/list','copies/create','copies/list','copies/resolve','copies/release','capabilities/read','capabilities/home-skills','roles/lifecycle',...handoffEndpoints,...resourceEndpoints,...artifactEndpoints,...artifactFileEndpoints,...roleEndpoints,...roleMemoryEndpoints,...roleDailyLogEndpoints,...groupEndpoints,...groupAgentGrantEndpoints,...groupTaskEndpoints,...groupAttachmentEndpoints,...taskEndpoints,...imChannelEndpoints,...bundledExtensionEndpoints,...retrievalEndpoints,...localModelEndpoints,...modelOptionEndpoints,'requests/pending/list','requests/pending/recover','requests/pending/ack'])

type HandoffPort=Pick<HandoffService,'list'|'resolve'|'change'>
export function createHandoffHandler(ownerId:string,get:()=>Promise<HandoffPort>):(endpoint:string,payload:unknown)=>Promise<unknown>{
 return async(endpoint:string,payload:unknown)=>{
  if(!(handoffEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此交接接口。')
  const service=await get()
  if(endpoint==='handoffs/list')return service.list(ownerId,payload)
  if(endpoint==='handoffs/resolve')return service.resolve(ownerId,payload)
  return service.change(ownerId,readTaskHandoffChangeInput(payload))
 }
}

async function* githubResponseBody(body:ReadableStream<Uint8Array>|null){
 if(!body)return
 const reader=body.getReader()
 try{while(true){const next=await reader.read();if(next.done)return;yield next.value}}
 finally{reader.releaseLock()}
}
const githubHttp:GithubHttpPort={request:async request=>{
 const response=await fetch(request.url,{method:request.method,headers:request.headers,redirect:request.redirect,signal:request.signal})
 // 只转发大小与限流相关头：content-length 供上限预检，x-ratelimit-*/retry-after 让后端在 403/429 时给出含重置时间的可定位错误。
 const headers:Record<string,string|undefined>={'content-length':response.headers.get('content-length')??undefined,'retry-after':response.headers.get('retry-after')??undefined}
 response.headers.forEach((value,name)=>{if(name.startsWith('x-ratelimit-'))headers[name]=value})
 return {status:response.status,headers,body:githubResponseBody(response.body)}
}}

/** inspect 只证明身份存在；Teloa 普通会话入口还要排除由 subagent 路由拥有的身份。 */
export async function inspectOrdinarySession(inspect:(sessionId:SessionId)=>Promise<{meta:SessionHeader}>,sessionId:SessionId):Promise<void> {
  const {meta}=await inspect(sessionId)
  if(meta.origin==='subagent')throw new WorkError('teloa/session-not-adoptable','子 Agent 会话不能作为普通工作会话接入。')
}

const hostApplications=new WeakMap<Context,{root:string;ready:Promise<void>}>()
export function apply(ctx:Context,options:{projectRoot?:string}={}):Promise<void> {
  const root=resolve(options.projectRoot??projectRoot),existing=hostApplications.get(ctx)
  if(existing)return existing.root===root?existing.ready:Promise.reject(new WorkError('teloa/conflict','同一宿主不能切换工作目录。'))
  const ready=applyHost(ctx,root).catch(error=>{hostApplications.delete(ctx);throw error})
  hostApplications.set(ctx,{root,ready});return ready
}

async function applyHost(ctx:Context,projectRoot:string):Promise<void> {
  const industryModelProbe=createHostIndustryModelProbe(ctx,officialCatalogModelEntry)
  // 安全敏感 TELOA_* 只认启动时继承的进程环境：DSH 已把工作区 .env（模型可写）合入 process.env（launch-env.ts）。
  const trusted=securityEnv(ctx)
  warnIgnoredLaunchEnv(ctx)
  registerTeloaLogFile(ctx,resolve(resolveTeloaRuntime(projectRoot,trusted),'harness.log'))
  // 不接受无效环境变量的静默降级：拆分上限是执行边界，宿主应在装配时停止。
  const subagentDelegationLimits=readSubagentDelegationLimits(trusted)
  // 构建期钉住的遥测、沙箱、审批、工具与权限预设，在装配期按实际生效的组合树再核一遍：
  // profile 的 bundles 尾部可以追加第三方 bundle，其补丁最后生效，能把这几行逐项改回去。
  // 不符即在这里抛出，下面的 /teloa 通道就不会注册，启动器的就绪自检随之判定业务不可用。
  // 官方宿主 HMR 必须关闭，否则用户补丁可在本次复验之后改回已核验的配置。
  // 待启用插件同理：上游 reconcile 会在任何一次 dsh plugin add 之后把它们补回 bundles，
  // 本人没点过启用的代码就会在这次启动被 import —— 复验一并拒绝。
  // 原生预设可以被后续补丁覆盖；直接复验 Loader 内声明与完整 config.plugins，
  // 不用磁盘原文代替实际生效的工具面。
  assertCompositionSafety(ctx,await readProfileFacts(resolveTeloaDshHome(projectRoot),resolveTeloaDshProfile(trusted)))
  registerSkillContextDedup(ctx)
  const runtimeRoot=resolveTeloaRuntime(projectRoot,trusted)
  // 设置 → 凭据存储（规格 §0-1、§0-3）：档位与锁定状态、历史明文副本清单。处理器只挂在 /teloa 连接上（见下），模型工具与进程内调用口够不到。
  const credentialProvider=ctx.credentials as unknown as {status?:()=>{tier:'keyring'|'file'|'plaintext'|null;fault:string|null};livePlaintextPath?:()=>string|undefined;quarantinedPlaintextPaths?:()=>string[];paths?:{dshHome:string}}
  const realOr=(path:string)=>{try{return realpathSync(path)}catch{return path}}
  const credentialStoreHandler=createCredentialStoreHandler({
    status:()=>credentialProvider.status?.()??{tier:null,fault:'store-unavailable'},
    runtimeRoot,
    dshHome:()=>credentialProvider.paths?.dshHome??resolveTeloaDshHome(projectRoot),
    files:()=>credentialProvider.quarantinedPlaintextPaths?.()??[],
    // 工作区是用户项目文件，其中同名文件不是 Teloa 的副本
    skip:()=>[resolveTeloaWorkspaceRoot(projectRoot,trusted)],
    // 在用的明文存储（明文档、锁定或尚未迁移成功时的 .credentials.yaml）与受管 MCP 旧目录（迁移失败时仍在用）不进清单；传入的是 realpath
    exclude:path=>{const live=credentialProvider.livePlaintextPath?.();return (live!==undefined&&path===realOr(live))||dirname(path)===realOr(resolve(runtimeRoot,'mcp','credentials'))},
  })
  // 使用统计活动信号：排除环境（含未设置 TELOA_USAGE_STATS=on）不发送
  const signalActivity=createSignalActivity(runtimeRoot,()=>({CI:process.env.CI,NODE_ENV:process.env.NODE_ENV,...trusted}),()=>trusted)
  const reportResourceInstall=createResourceInstallReporter(runtimeRoot,()=>({CI:process.env.CI,NODE_ENV:process.env.NODE_ENV,...trusted}),()=>trusted)
  const workspaceRoot=resolveTeloaWorkspaceRoot(projectRoot,trusted)
  const repository=new FileConversationRepository(resolve(runtimeRoot,'conversations.json'))
  // 启动时主动校验；损坏存储不得表现为一个正常的空工作台。
  await repository.read()
  // 工作区不再是仓库根，装配期自己建出来；0o700 与运行目录里其余状态一致。
  await mkdir(workspaceRoot,{recursive:true,mode:0o700})
  const workspace=await ctx.workspaceRegistry.create(workspaceRoot,'Teloa')
  // 工作区设置仍可登记任意目录（包括历史上登记过仓库根的那条），收敛的是"能不能拿它开会话"。
  // 这里只提示，不动登记：删除登记会连带丢掉该工作区下已有会话的归属。文案固定，不带路径。
  if(ctx.workspaceRegistry.list().some(item=>workspaceRefusedForRepository(item.path,projectRoot)))
    ctx.logger.warn('Teloa 工作区登记中存在不能用于新建会话的目录（本程序所在目录及其上级，或该目录内运行目录之外的位置）；请在工作区设置里改用专用工作区。')
  const service=new ConversationService(repository,{
    create:async(sessionId,workspaceId,agentPresetId,signal)=>{
      const target=workspaceId===undefined?workspace.id:brandString<WorkspaceId>(workspaceId)
      const registered=ctx.workspaceRegistry.get(target)
      if(!registered)throw new WorkError('teloa/workspace-unavailable','所选工作区已不可用，请核对原工作区；未改用其他目录。')
      // 这类工作区会把沙箱写范围与原生终端一起放到本程序自己的代码或运行状态上。
      if(workspaceRefusedForRepository(registered.path,projectRoot))throw new WorkError('teloa/forbidden','所选工作区不能用于新建会话：本程序所在目录及其上级、以及该目录内运行目录之外的位置都不可用；请改用专用工作区。')
      if(agentPresetId!==undefined){await prepareDshTaskSession(ctx,sessionId,agentPresetId,signal??AbortSignal.timeout(30_000),target);return sessionId}
      return (await ctx.sessionController.create({workspaceId:target,sessionId:brandString<SessionId>(sessionId)})).sessionId
    },
    inspect:async(sessionId)=>inspectOrdinarySession(id=>ctx.sessionController.inspect(id),brandString<SessionId>(sessionId)),
  },{id:randomUUID,now:()=>new Date().toISOString()},async(actor,roleId)=>{
    const {pool,identity,plans}=await autoDreamPlans()
    return (await new RoleService(pool,identity,{plans}).list(actor,{})).find(role=>role.id===roleId)
  })
  // 根类型检查同时加载 Host/Client 的 sessions 声明，在接入边界明确 Host 服务类型。
  const sessionStore=Reflect.get(ctx,'sessions') as unknown as SessionStore
  const copies=new CopyService(new FileCopyRepository(resolve(runtimeRoot,'copies.json')),{ 
    fork:async source=>{
      let child:string|undefined
      try{
        child=(await ctx.sessionController.fork({sessionId:brandString<SessionId>(source)})).sessionId
        const session=sessionStore.get(brandString<SessionId>(child))
        if(!session)throw Error('副本尚未在原生宿主中就绪。')
        if(!await sessionStore.flush(session))throw Error('原生历史持久化服务尚未就绪。')
        return child
      }catch(error){
        const code=error&&typeof error==='object'&&'code' in error?error.code:undefined
        const details=error&&typeof error==='object'&&'details' in error?error.details:undefined
        if(code==='session/workspace-attach-failed'&&details&&typeof details==='object'&&'sessionId' in details&&typeof details.sessionId==='string')child=details.sessionId
        if(child)throw new CopyPendingError(child,'副本身份已知，原生持久化或工作区状态仍待核对。')
        if(code==='session/fork-unavailable'||code==='session/not-found'||code==='gateway/bad-request')throw new CopyRejectedError('原生会话尚不支持创建副本。')
        throw error
      }
    },
    inspect:async child=>{
      const session=sessionStore.get(brandString<SessionId>(child))
      if(session)if(!await sessionStore.flush(session))throw Error('原生历史持久化服务尚未就绪。')
      const {meta}=await ctx.sessionController.inspect(brandString<SessionId>(child))
      return {...(meta.origin?{origin:meta.origin}:{}),...(meta.parentSession?{parentSession:meta.parentSession}:{})}
    },
  },{now:()=>new Date().toISOString()},async source=>{await service.bySession(owner,source);await inspectOrdinarySession(id=>ctx.sessionController.inspect(id),brandString<SessionId>(source))})
  await copies.list(owner,{})
  const resources=registerResources(ctx,projectRoot,owner,service,async sessionId=>{
    const resolved=await ctx.sessionController.resolveAgent(brandString<SessionId>(sessionId))
    if('error' in resolved)throw new WorkError('teloa/session-unavailable','原生会话历史暂不可用。')
    return resolved.agent.session
  })
  const database=await resources.database()
  // 业务读取与群附件共用 DSH 已挂载的附件仓，须先于懒服务及调度闭包就绪。
  const attachmentPorts=createAttachmentPorts(Reflect.get(ctx,'attachments'))
  // 上游条目索引预热（非阻塞：未加载或失败时上游来源列表报「来源暂时无法读取」，界面可重试）
  void loadOfficialUpstreamIndex()
  // 在线签名索引（market.teloa.ai）：本期默认关闭，TELOA_MARKET_REMOTE=on 才拉取；验签或结构失败整份拒绝、保留快照，只记一条告警。
  const marketRemoteExclusion=detectMarketRemoteExclusion({CI:process.env.CI,NODE_ENV:process.env.NODE_ENV,...trusted})
  if(marketRemoteExclusion)ctx.logger.info('Teloa 在线市场索引未启用（%s）。',marketRemoteExclusion)
  else{
    const marketRemote=new OfficialCatalogRemote({publicKey:MARKET_INDEX_PUBLIC_KEY,teloaVersion:TELOA_APP_VERSION,log:(level,message)=>{if(level==='info')ctx.logger.info('Teloa 在线市场索引：%s',message);else ctx.logger.warn('Teloa 在线市场索引未采用：%s',message)}})
    marketRemote.start()
    resources.beforeDatabaseClose(()=>marketRemote.stop())
  }
  // 全库结构只在这里初始化一次；建表次序由 `initializeTeloaDatabase` 统一负责，装配代码不再逐条摊开。
  // 看板只读角色按库与 schema 派生（同集群多宿主各用各的），登录口令按角色存运行目录（0600），不进日志与回包；执行器以该角色直接登录专用连接池。
  const businessSqlSecretPath=resolve(runtimeRoot,'business-sql-reader.json')
  const {businessSqlRole}=await initializeTeloaDatabase(database.pool,{businessSqlSecretPath})
  if(businessSqlRole.mode!=='role')ctx.logger.warn('Teloa 看板查询以 %s 模式运行：%s',businessSqlRole.mode,businessSqlRole.reason??'')
  // harness 不直接依赖 pg：用应用池的构造器建执行器专用池（同一 pg 版本）；错误只记码，关闭宿主时结束。
  const BusinessSqlPool=database.pool.constructor as new(config:Awaited<ReturnType<typeof businessSqlPoolConfig>>)=>typeof database.pool
  const businessSqlPool=new BusinessSqlPool(await businessSqlPoolConfig(database.pool.options,businessSqlRole,businessSqlSecretPath))
  businessSqlPool.on('error',error=>ctx.logger.warn('Teloa 看板查询连接异常：%s',(error as {code?:unknown}).code??'unknown'))
  ctx.effect(()=>()=>{void businessSqlPool.end().catch(()=>{})},'Teloa 看板查询专用连接池')
  const businessSqlExecutor=new BusinessSqlExecutor(businessSqlPool,{now:()=>new Date().toISOString()},businessSqlRole.mode,undefined,businessSqlRole.schema)
  // 默认签发只在建群与改成员那一笔跑；更早建的群一行授权都没有，群里发消息恒判 no-candidate（2026-09-21 用户裁定补签）。
  // 只补默认签发上线前建的群，且对已有授权行一律跳过，稳定态返回 0。
  // 这只是启动期的一次性修补：它整体失败不该挡住宿主装配，失败只记告警，后面的装配照常往下走。
  try{
    const backfilled=await new CollaborationService(database.pool,{id:randomUUID,now:()=>new Date().toISOString()}).backfillDefaultGrants(owner,(groupId,code)=>ctx.logger.warn('Teloa 既有群补签默认授权跳过一个群：%s（%s）',groupId,code))
    ctx.logger.info('Teloa 既有群补签默认授权：%d 条',backfilled)
  }catch(error){ctx.logger.warn('Teloa 既有群补签默认授权未完成，本次跳过：%o',error)}
  const pendingRequests=new PendingRequestService(database.pool)
  // 分身属于个人空间的默认身份，不经招聘流程；已有记录会被复用以保留代拟稿和判断力样本。
  await new RoleService(database.pool,{id:randomUUID,now:()=>new Date().toISOString()}).ensurePersonalTwin(owner)
  const securityIdentity={id:randomUUID,now:()=>new Date().toISOString()},securityPrincipal={ownerId:owner,approverId:owner,scopeIds:['SOC']}
  Object.freeze(securityPrincipal.scopeIds);Object.freeze(securityPrincipal)
  const securityCatalog=createSecurityActionDefinitionCatalog(),securityJournal=new SecurityRequestJournal(database.pool)
  const securityApprovals=new SecurityApprovalService(database.pool,securityIdentity,securityCatalog,securityJournal)
  const securityExecutions=new SecurityActionExecutionService(database.pool,securityIdentity,securityApprovals,securityJournal)
  const securityActions=new SecurityActionService(database.pool,securityIdentity,securityCatalog,securityJournal,new PgSecurityExecutionExistsReader())
  // 启动器会剔除凭据形变量，令牌改由 TELOA_SECURITY_ACTION_TOKEN_FILE 指向文件提供。
  const securityActionToken=trusted.TELOA_SECURITY_ACTION_TOKEN||(trusted.TELOA_SECURITY_ACTION_TOKEN_FILE?readFileSync(trusted.TELOA_SECURITY_ACTION_TOKEN_FILE,'utf8').trim():undefined)
  const securityAdapter=new SecurityActionHttpAdapter({...(trusted.TELOA_SECURITY_ACTION_URL?{baseUrl:trusted.TELOA_SECURITY_ACTION_URL}:{}),...(securityActionToken?{token:securityActionToken}:{})})
  const securityDriver=new SecurityActionExecutionDriver(securityExecutions,[securityAdapter]),securityReadiness={ready:securityDriver.readiness.bind(securityDriver)}
  const securityActionHandler=createSecurityActionHandler(securityPrincipal,{actions:securityActions,approvals:securityApprovals,driver:securityDriver,panel:new SecurityActionPanelService(database.pool,securityCatalog,securityReadiness),attention:new SecurityActionAttentionService(database.pool,securityCatalog,securityReadiness,securityIdentity.now)})
  const securityAlertSource=new SecurityAlertHttpSource(resolve(runtimeRoot,'security-alert-source.json'))
  const businessDataHandler=createBusinessDataHandler(owner,async()=>new BusinessDataService((await resources.database()).pool,securityAlertSource),'security-alert-http')
  // 台账主体范围：按本人实际登记的范围集合给（`BusinessScopeService.list`），不再拿内置常量冒充「已登记」——
  // 历史范围与第三方模板的 domain 都要能读到台账（复审 MEDIUM-3）；排除 general，声明层对它一律拒绝，读了也是空块。
  const businessScopeIds=async()=>(await new BusinessScopeService((await resources.database()).pool).list(owner)).map(item=>item.scope).filter(scope=>scope!=='general')
  // 同步来源：SOC 告警端口登记为 business-data-port；mcp-tool 走受管 MCP 只读工具直调（受管连接在下方装配后接上）。
  // 「来源没接上」一律带 details.sourceState:'disconnected'：预览据此回 trialUnavailable:'source-disconnected'，与真正的调用失败（pull-failed）分开。
  let businessMcpSource:BusinessSyncSourceResolver=async()=>{throw new WorkError('teloa/source-unavailable','受管 MCP 连接尚未就绪。',{sourceState:'disconnected'})}
  const businessSyncSources:BusinessSyncSourceResolver=async mapping=>{
   if(mapping.source.kind==='mcp-tool')return businessMcpSource(mapping)
   if(mapping.source.kind==='business-data-port'&&mapping.source.sourceId===securityAlertSource.id&&securityAlertSource.scopes.some(scope=>scope===mapping.domain))return businessDataPortSyncSource(securityAlertSource)
   throw new WorkError('teloa/source-unavailable','数据源映射的来源未登记，无法拉取。',{sourceState:'disconnected'})
  }
  const businessDefinitionServices=async()=>{
   const {pool}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
   // 模板目录不接本地读口，避免「回到模板」误把当前本地版本当作模板。
   const templates=new BusinessDefinitionSourceReader(market,loads,{activeSourceIds})
   const local=new BusinessLocalDefinitionService(pool,identity,async(db,ownerId,scope)=>{
    const versions=new Map<string,string>()
    for(const bundle of await templates.forScope(db,ownerId,scope))for(const [kind,records] of [['object-type',bundle.objectTypes],['view',bundle.views],['action',bundle.actions]] as const)for(const record of records)versions.set(kind+'\0'+record.definition.id,record.definition.version)
    return versions
   })
   const store=new BusinessConfigurationStore(pool),drafts=new BusinessConfigurationDraftService(pool,identity)
   const definitions=new BusinessDefinitionSourceReader(market,loads,{activeSourceIds},local,store),executions=new IndustryExecutionToolService(pool,identity,loads,new IndustryExecutionToolSource(market,loads),securityReadiness),ledger=new BusinessLedgerService(pool,identity,definitions,async(db,ownerId,action)=>{
    const target=action.definition.target
    if(target.kind!=='execution-tool')return false
    const load=await loads.getInTransaction(db,ownerId,{loadId:action.source.loadId}),item=load.items.find(candidate=>candidate.localId===target.localId)
    if(!item||item.kind!=='execution-tool'||item.status!=='pending-adapter')return false
    try{return (await executions.activeBindingForItemInTransaction(db,ownerId,{loadId:load.id,itemInstanceId:item.instanceId,tool:target.tool}))!==null}
    catch(error){if(error instanceof WorkError&&(error.code==='teloa/source-unavailable'||error.code==='teloa/dependency-unavailable'))return false;throw error}
   })
   const warehouse=new BusinessWarehouseService(pool,identity),widgets=new BusinessWidgetService(pool,identity,businessSqlExecutor,ledger),references=new BusinessSnapshotReferenceService(pool,identity)
   const records=new BusinessRecordService(pool,identity,{definitions,warehouse,references})
   // CSV 读取复用官方附件仓，导入与普通记录共享同一事务原语及固定来源引用。
   const imports=new BusinessRecordImportService(pool,identity,{definitions,store,records,references,files:createBusinessImportFilePort(attachmentPorts),xlsx:createBusinessImportXlsxPort(),tables:{parse:(bytes,mapping,signal)=>parseBusinessImportCsv(bytes,mapping.delimiter,signal)}})
   return {pool,local,definitions,ledger,store,drafts,imports,responsibility:new BusinessResponsibilityService(pool),configuration:new BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime:new BusinessRuntimeService(pool,identity),spaces:new BusinessSpaceService(pool,identity)}),configurationPreview:new BusinessConfigurationPreviewService(pool,drafts,definitions,identity),pages:new BusinessConfigurationPageService(pool,identity,{drafts,store,definitions,executor:businessSqlExecutor}),records,preview:new BusinessDefinitionPreviewService(pool,identity,local,definitions,ledger,{widgets,resolveSource:businessSyncSources}),warehouse,widgets,executor:businessSqlExecutor,sync:new BusinessSyncService(pool,identity,definitions,warehouse,businessSyncSources),dashboards:new BusinessDashboardService(pool,identity,definitions,widgets)}
  }
  const businessDefinitionHandler=createBusinessDefinitionHandler(owner,businessScopeIds,async()=>(await businessDefinitionServices()).ledger,businessDefinitionServices)
  const businessImportHandler=createBusinessImportHandler(owner,businessScopeIds,businessDefinitionServices)
  const businessDashboardHandler=createBusinessDashboardHandler(owner,businessScopeIds,async()=>{const {pool,dashboards,sync}=await businessDefinitionServices();return {dashboards,sync,rules:sync.rules,runtime:new BusinessRuntimeService(pool,{now:()=>new Date().toISOString()})}})
  const pageCreateServices=async()=>{
   const {pool}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()}
   // 页内 Skill 草案只接受契约规定的可序列化文本文件；确认前后复用同一正文形状。
   const drafts=new PageCreateDraftService(pool,identity,{skill:readPageCreateAtomicSkillDraft})
   const business=await businessDefinitionServices()
   // 扩展草案的权限预览复用既有插件安装服务的 npm 预览（同一份 permissionSummary、同一 registry），不省略权限那一步。
   const extensionPreview={preview:async(source:{registry:'npm';packageName:string;version:string},signal?:AbortSignal)=>{
    const plugins=new PluginInstallationService(pool,identity,new DshPluginInstallAdapter({dshHome,profile:dshProfile,registry:'https://registry.npmjs.org',dshCommand:resolve(projectRoot,'node_modules/.bin/dsh'),activePluginRefs,ownerId:owner,...(signal?{signal}:{})}))
    const result=await plugins.preview(owner,{source})
    return {permissionSummary:result.permissionSummary}
   }}
   return {drafts,preview:new PageCreatePreviewService(pool,identity,drafts,business.preview,extensionPreview,{skill:readPageCreateAtomicSkillDraft})}
  }
  const pageCreateDraftHandler=createPageCreateDraftHandler(owner,businessScopeIds,pageCreateServices)
  const businessTaskService=async()=>{const pool=(await resources.database()).pool,identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),definitions=(await businessDefinitionServices()).definitions,executions=new IndustryExecutionToolService(pool,identity,loads,new IndustryExecutionToolSource(market,loads),securityReadiness);return new BusinessTaskService(pool,identity,new TaskService(pool,identity),{definitions,loads,works:new IndustryWorkSource(market,loads,industryModelProbe),executions})}
  const businessTaskHandler=createBusinessTaskHandler(owner,businessScopeIds,async()=>businessTaskService())
  // 版本配置在装配时读一次：取值读不懂就不要启动，省得后面把许可错误当成正常的个人版。
  const edition=readEdition()
  // 迁移里重复加载需暂停其行业计划，因此把计划服务作为端口接入；未接入时遇到带在效计划的重复加载会以 dependency-unavailable 显式失败
  const businessSpaceIdentity={id:randomUUID,now:()=>new Date().toISOString()}
  const businessSpaces=new BusinessSpaceService(database.pool,businessSpaceIdentity,new PlanService(database.pool,businessSpaceIdentity,new MarketContentStore(database.pool,businessSpaceIdentity)))
  // 空库首启即引导本人空间；幂等，重启不会再建。
  await businessSpaces.ensurePersonal(owner)
  const businessSpaceHandler=createBusinessSpaceHandler(owner,async()=>businessSpaces,()=>edition)
  const businessScopeHandler=createBusinessScopeHandler(owner,async()=>new BusinessScopeService((await resources.database()).pool))
  const readArtifactFile=createArtifactFileReader(async sessionId=>{
    const binding=await service.bySession(owner,sessionId)
    if(binding.status!=='ready')throw new WorkError('teloa/not-bound','工作会话尚未就绪。')
    const resolved=await ctx.sessionController.resolveAgent(brandString<SessionId>(sessionId))
    if('error' in resolved)throw new WorkError('teloa/session-unavailable','原生会话不可用，无法读取文件。')
    const agent=resolved.agent,fs=ctx.agentPresets.serviceFor(agent,'fs')??ctx.fs,references=ctx.agentPresets.serviceFor(agent,'fileReferences')??ctx.fileReferences
    const cwd=agent.session.header.cwd
    if(!cwd)throw new WorkError('teloa/file-scope','当前会话没有工作目录，无法读取文件。')
    return {sessionId:agent.session.id,cwd,fs,list:(query,signal)=>references.list(agent,query,signal)}
  },()=>new Date().toISOString())
  const readExecutionKnowledge=async(target:TaskExecutionScope,ids:readonly string[],signal?:AbortSignal,roleScopes?:readonly string[],database?:TaskRunSkillDatabase)=>{
    const binding=await service.bySession(owner,target.sessionId)
    if(binding.sessionId!==target.sessionId||binding.status!=='ready')throw new WorkError('teloa/forbidden','执行会话身份未就绪。')
    const authorization=taskKnowledgeAuthorization(owner,target,roleScopes)
    const resourcesService=(await resources.database()).service
    return database?resourcesService.executionKnowledgeInTransaction(database,authorization.actor,authorization.targetScopes,ids,signal):resourcesService.executionKnowledge(authorization.actor,authorization.targetScopes,ids,signal)
  }
  // 复核路径上只有 Run 快照的 roleId，岗位自身范围从这里补读（与 roleDailyLog 的 role 读口同写法）。
  // 找不到岗位回 undefined，调用方退回任务范围；这里不抛，读不到岗位不该把整次复核连坐拒掉。
  const readRoleScopes=async(actor:string,roleId:string,signal?:AbortSignal)=>{
    signal?.throwIfAborted()
    const {pool,identity,plans}=await autoDreamPlans()
    return (await new RoleService(pool,identity,{plans}).list(actor,{})).find(role=>role.id===roleId)?.scopes
  }
  const taskMaterialService=async()=>new TaskMaterialService((await resources.database()).pool,{id:randomUUID,now:()=>new Date().toISOString()})
  // 添加任务知识前按已固定的知识加上这一份做体积预检：超过整段进提示词上限的资料在这里就拒，不等到执行准备。
  const taskMaterialHandler=createTaskMaterialHandler(owner,taskMaterialService,async(taskId,resourceId)=>{
    const materials=await (await taskMaterialService()).list(owner,{taskId})
    await (await resources.database()).service.checkFullTextBudget(await resources.human(),[...materials.map(material=>material.resourceId),resourceId],'task')
  })
  const loadTaskKnowledge=createTaskMaterialKnowledgeLoader(owner,taskMaterialService,async(target,references,db,signal)=>{
    const binding=await service.bySession(owner,target.sessionId)
    if(binding.sessionId!==target.sessionId||binding.status!=='ready')throw new WorkError('teloa/forbidden','执行会话身份未就绪。')
    const authorization=taskKnowledgeAuthorization(owner,target)
    return (await resources.database()).service.executionKnowledgeReferencesInTransaction(db,authorization.actor,authorization.targetScopes,references,signal)
  })
  const industryTaskService=async()=>{const {pool}=await resources.database();const identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market));return new IndustryTaskService(pool,identity,new IndustryWorkSource(market,loads,industryModelProbe),new TaskService(pool,identity))}
  const industryTasksHandler=createIndustryTasksHandler(owner,industryTaskService)
  const industryPlanService=async()=>{const {pool}=await resources.database();const identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market));return new IndustryPlanService(pool,identity,new IndustryPlanSource(market,loads,new IndustryWorkSource(market,loads,industryModelProbe)),new PlanService(pool,identity,market))}
  const industryPlansHandler=createIndustryPlansHandler(owner,industryPlanService)
  const managedFiles=new ManagedSkillFiles(resolve(runtimeRoot,'skills'),directory=>inspectNativeSkillDirectory(ctx,directory),path=>managedNative.invalidate(path))
  await managedFiles.ready()
  const fixedSkillSource=async(db?:TaskRunSkillDatabase)=>{
    const {pool}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
    return db?new SkillInstallSource({get:(actor,input)=>market.getInTransaction(db,actor,input)},{get:(actor,input)=>loads.getInTransaction(db,actor,input)},industryModelProbe):new SkillInstallSource(market,loads,industryModelProbe)
  }
  const skillAvailabilityService=async()=>new SkillAvailabilityService((await resources.database()).pool,{now:()=>new Date().toISOString()},{verify:async(db,actor,installation)=>{
    const {pool}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
    const source=installation.source,reader=new SkillInstallSource({get:(owner,input)=>market.getInTransaction(db,owner,input)},{get:(owner,input)=>loads.getInTransaction(db,owner,input)},industryModelProbe)
    const bundle=await reader.read(actor,source.kind==='atomic'?{kind:'atomic',contentId:source.contentId}:{kind:'industry',loadId:source.loadId,itemInstanceId:source.itemInstanceId})
    const fixed=(value:unknown):string=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)
    if(bundle.ownerId!==actor||fixed(bundle.source)!==fixed(installation.source)||bundle.bundleHash!==installation.bundleHash)throw new WorkError('teloa/storage-corrupt','恢复来源与固定安装不一致。')
    await managedFiles.verify(installation.id,bundle,installation.native)
  }})
  const readManagedAvailability=async()=>(await(await skillAvailabilityService()).selectedDirectory(owner)).map(({installation,availability,selectionVersion})=>({installationId:installation.id,installationState:installation.state,installationVersion:installation.version,availability:availability.availability,availabilityVersion:availability.version,selectionVersion,native:installation.native}))
  const managedNative=registerManagedSkills(ctx,managedFiles.root,{initial:await readManagedAvailability(),verifyUsable:async installationId=>{
    const {pool}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),source=new SkillInstallSource(market,loads,industryModelProbe)
    const installation=await new SkillInstallationService(pool,identity,source,managedFiles).get(owner,{installationId})
    await source.assertModelsReady(owner,installation.source)
  }})
  const availabilitySync=createManagedAvailabilitySync({deny:()=>managedNative.denyWhileRefreshing(),read:readManagedAvailability,replace:snapshot=>managedNative.replaceAvailability(snapshot)})
  const skillAvailabilityHandler=createSkillAvailabilityHandler(owner,async()=>{
    const service=await skillAvailabilityService()
    return {get:service.get.bind(service),preview:service.preview.bind(service),change:(actor,input)=>availabilitySync.change(()=>service.change(actor,input))}
  })
  const skillInstallationService=async()=>{const {pool}=await resources.database();const identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market));return new SkillInstallationService(pool,identity,new SkillInstallSource(market,loads,industryModelProbe),managedFiles)}
  const skillUpgradePreviewHandler=createSkillUpgradePreviewHandler(owner,async()=>{
    const {pool}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
    return new SkillUpgradePreviewService(await skillAvailabilityService(),new SkillInstallSource(market,loads,industryModelProbe),managedFiles)
  })
  const skillSelectionHandler=createSkillSelectionHandler(owner,async()=>{
    const service=new SkillSelectionService((await resources.database()).pool,{now:()=>new Date().toISOString()})
    return {get:service.get.bind(service),preview:service.preview.bind(service),change:(actor,input)=>availabilitySync.change(()=>service.change(actor,input))}
  })
  const skillInstallationsHandler=createSkillInstallationsHandler(owner,async()=>{
    const service=await skillInstallationService()
    return {get:service.get.bind(service),list:service.list.bind(service),preview:service.preview.bind(service),install:(actor,input)=>availabilitySync.change(()=>service.install(actor,input))}
  },async installationId=>{
    await availabilitySync.refresh()
    const installed=await(await skillInstallationService()).get(owner,{installationId})
    if(installed.state!=='installed')throw new WorkError('teloa/conflict','安装尚未完成，请先核对原请求。')
    const {pool}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
    const source=installed.source,bundle=await new SkillInstallSource(market,loads,industryModelProbe).read(owner,source.kind==='atomic'?{kind:'atomic',contentId:source.contentId}:{kind:'industry',loadId:source.loadId,itemInstanceId:source.itemInstanceId})
    if(bundle.bundleHash!==installed.bundleHash)throw new WorkError('teloa/storage-corrupt','安装来源与固定内容不一致。')
    await managedFiles.verify(installed.id,bundle,installed.native)
    // 遮蔽判定必须按会话真正的视角来看：原生文件 provider 的项目级根目录由 cwd 选出，
    // 而会话的 cwd 是默认工作区而不是仓库根。用仓库根去看会扫到一份没有会话使用的目录。
    const observation=await withPresetReadScope(ctx.agentPresets,scope=>managedNative.observe(installed.native.name,{cwd:workspaceRoot,scope},{path:managedFiles.path(installed.id),bodyHash:installed.native.bodyHash,modelInvocable:installed.native.modelInvocable,userInvocable:installed.native.userInvocable}))
    const current=observation.current?{name:observation.current.name,description:observation.current.description,modelInvocable:observation.current.modelInvocable,userInvocable:observation.current.userInvocable,bodyHash:observation.current.bodyHash,provider:observation.current.provider,source:observation.current.source}:null
    return {installationId,scope:'default-workspace',state:observation.state,...(observation.reason?{reason:observation.reason}:{}),current}
  })

  const roleMemoryService=async()=>new RoleMemoryService((await resources.database()).pool,{id:randomUUID,now:()=>new Date().toISOString()})
  const roleMemoryHandler=createRoleMemoryHandler(owner,roleMemoryService)
  // 小结闸在每次工具调用上问一次判定，构造按连接池缓存：换了连接池（数据库重连）才重建。
  let roleDailyLogCache:{pool:unknown;service:RoleDailyLogService}|undefined
  const roleDailyLogService=async()=>{
   const {pool}=await resources.database()
   if(roleDailyLogCache?.pool!==pool)roleDailyLogCache={pool,service:new RoleDailyLogService(pool,{id:randomUUID,now:()=>new Date().toISOString()},await roleMemoryService())}
   return roleDailyLogCache.service
  }
  // 分身的习惯观察同样按连接池缓存构造：读目录时惰性生成当天那一条，生成失败由处理器吞掉。
  let autoDreamHabitCache:{pool:unknown;service:AutoDreamHabitService}|undefined
  const autoDreamHabitService=async()=>{
   const {pool}=await resources.database()
   if(autoDreamHabitCache?.pool!==pool)autoDreamHabitCache={pool,service:new AutoDreamHabitService(pool,{id:randomUUID,now:()=>new Date().toISOString()},await roleDailyLogService(),readAutoDreamSetting)}
   return autoDreamHabitCache.service
  }
  const roleDailyLogHandler=createRoleDailyLogHandler(owner,roleDailyLogService,async()=>({
   role:async roleId=>{const {pool,identity,plans}=await autoDreamPlans();return (await new RoleService(pool,identity,{plans}).list(owner,{})).find(role=>role.id===roleId)},
   ensureForDay:async(actor,role,nowIso)=>(await autoDreamHabitService()).ensureForDay(actor,role,nowIso),
  }))
  // 行业 MCP 的凭据和实际服务器由 DSH 全局连接配置持有；这里仅在同一 DB 事务内复核角色关联的 active binding。
  const industryMcpToolRules=async(db:Parameters<IndustryMcpConnectionService['activeToolRulesForRoleInTransaction']>[0],actor:string,roleId:string)=>{
   const identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore((await resources.database()).pool,identity),loads=new IndustryLoadService((await resources.database()).pool,identity,createIndustryLoadSource(market)),source=new IndustryMcpConnectionSource(market,loads)
   const rules=await new IndustryMcpConnectionService((await resources.database()).pool,identity,loads,source,createIndustryMcpReadiness(()=>ctx.tools.schemas(),identity.now)).activeToolRulesForRoleInTransaction(db,actor,roleId)
   // 原生保留名只能由真实 provider 与已注册 Agent scope 产生，不能被行业 MCP 同名声明代授。
   return rules.filter(rule=>!isNativeToolName(rule.name))
  }
  // 上网的总开关与拦截名单是本人一处设置；授权候选与执行面的闸都从这一个读口取，不各读一份。
  // 调用方已持有连接（运行准备与授权保存都在事务里）时必须把它传进来：在事务内再从池里取第二条
  // 连接，六个并发运行准备就会把 `max:6` 的池占满互等到超时。执行面的闸不在事务里，走 pool 那一支。
  const webAccessPolicy=async(db?:Parameters<WebAccessPolicyService['getInTransaction']>[0])=>{
    const service=new WebAccessPolicyService((await resources.database()).pool,()=>new Date().toISOString())
    return db?service.getInTransaction(db,owner):service.get(owner,{})
  }
  const runService=async()=>new TaskRunService((await resources.database()).pool,{id:randomUUID,now:()=>new Date().toISOString()},(actor,id)=>service.bySession(actor,id),{allowedTools:[],runReservation:(actor,id)=>service.isTaskRunReserved(actor,id),roleMemory:(db,actor,target,role)=>(roleMemoryService()).then(memory=>memory.confirmedForRun(db,actor,target,role)),groupContext:(db,actor,task,role)=>readRunGroupContext(db,actor,task,role,runGroupFilePorts),groupTopic:(db,actor,groupContext)=>readRunGroupTopic(db,actor,groupContext),businessContext:async(db,actor,task)=>readRunBusinessTaskContext(actor,task,async(who,input)=>{const identity={id:randomUUID,now:()=>new Date().toISOString()},pool=(await resources.database()).pool,market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),definitions=(await businessDefinitionServices()).definitions;return new BusinessTaskService(pool,identity,new TaskService(pool,identity),{definitions,loads,works:new IndustryWorkSource(market,loads,industryModelProbe)}).executionContextInTransaction(db,who,input)}),industryContext:async(db,actor,taskId)=>(await industryTaskService()).executionContextInTransaction(db,actor,taskId),planContext:async(db,actor,taskId)=>{const context=await planRuntime.executionContext(db,actor,taskId),work=await(await industryPlanService()).executionContextInTransaction(db,actor,taskId);if(work&&!context)throw new WorkError('teloa/storage-corrupt','行业计划工作依据缺少真实调度关联。');return context?{...context,...(work?{work}:{})}:undefined},industrySkills:(db,actor,taskId,roleId)=>resolveIndustryRunSkillBindings(db,actor,taskId,roleId,industryModelProbe),roleGrants:{
    // validate 与 recheck 都是**运行准备**路径上对岗位已保存的 argumentRules 的核对（不是授权页），
    // 两处一律恒当总开关开着算候选——`webToolRules(true)`。总开关只由派发前的 `task-tool-guard`
    // 闸 ① 执行（逐字理由「设置中已关闭网页搜索与读取。」），不能让这里的候选缺失把同一运行的其余工具
    // 一并连坐拒绝（见 D-1）；关掉总开关后带上网授权的员工必须照样准备得起运行，只是跑不出外发。
    // 授权页候选与保存校验仍跟着总开关走，那一支在下面的 `grantRules` 里，与这里两条互不相干。
    validate:async(rules,knowledge,context)=>validateReferenceToolRules(rules,taskRunToolRules([...referenceToolRules(knowledge),...await industryMcpToolRules(context.db,context.owner,context.role.id),...getManagedMcpToolRules().filter((rule:{name:string})=>!isNativeToolName(rule.name)),...webToolRules(true),...nativeToolRules(ctx)])),
    recheck:async(run,target,context)=>{
      const current=readRunKnowledge(await readExecutionKnowledge(target,run.knowledge.map(item=>item.id),undefined,context.role.scopes,context.db))
      if(JSON.stringify(current)!==JSON.stringify(run.knowledge))throw new WorkError('teloa/version-conflict','执行资料已变化，请重新准备。')
      validateReferenceToolRules(run.argumentRules??[],taskRunToolRules([...referenceToolRules(current),...await industryMcpToolRules(context.db,context.owner,context.role.id),...getManagedMcpToolRules().filter((rule:{name:string})=>!isNativeToolName(rule.name)),...webToolRules(true),...nativeToolRules(ctx,ctx.agents.get(brandString<SessionId>(run.sessionId)))]))
    },
  }})
  const subagentDelegation={
    limits:subagentDelegationLimits,
    list:async(runId:string)=>new TaskRunSubagentService((await resources.database()).pool,{now:()=>new Date().toISOString()}).list(owner,runId),
    runId:async(sessionId:string,signal:AbortSignal)=>{
      signal.throwIfAborted()
      const run=await (await runService()).skillScope(owner,{sessionId})
      signal.throwIfAborted()
      return run?.id
    },
    reserve:async(input:{runId:string;reservationId:string;limit:number})=>{
      const service=new TaskRunSubagentService((await resources.database()).pool,{now:()=>new Date().toISOString()})
      await service.reserve(owner,input)
    },
    release:async(input:{reservationId:string})=>{await new TaskRunSubagentService((await resources.database()).pool,{now:()=>new Date().toISOString()}).release(owner,input)},
    bind:async(input:{reservationId:string;childSessionId:string;depth:number})=>{
      const child=await new TaskRunSubagentService((await resources.database()).pool,{now:()=>new Date().toISOString()}).bind(owner,input)
      const run=await (await runService()).get(owner,{runId:child.runId})
      taskBrowser.bind({id:run.id,sessionId:input.childSessionId,nativeRequestId:run.nativeRequestId})
    },
    settle:async(input:{childSessionId:string;stopReason:string;tokenEstimate?:number})=>{await new TaskRunSubagentService((await resources.database()).pool,{now:()=>new Date().toISOString()}).settle(owner,input)},
    abandon:async(input:{reservationId:string;childSessionId:string;depth:number;stopReason:string})=>{await new TaskRunSubagentService((await resources.database()).pool,{now:()=>new Date().toISOString()}).abandon(owner,input)},
  }
  // 群内路由会话不绑任何 Run，在 registerTaskToolGuard 眼里就是一条普通会话（下面上网闸的
  // 'no-run' 分支逐字「普通会话没有 Run 作用域，放行且不记录」），工具因此本来是放行的。
  // 先于任务闸注册：tools/pre-execute 是链式的，先注册的先判——顺序决定拿到哪一句固定理由、
  // 以及任务闸的策略读口要不要白查一次库，不决定是否被拒（判据是会话 id 的结构，不是登记表）。
  registerGroupRoutingGuard(ctx,isRoutingSession)
  // H3 装配期核一次默认预设：对不上就记一行 error 并停用群内路由，绝不让路由跑在没被组合安全钉
  // 覆盖的预设上。核对本身不阻塞装配，失败也不拖垮宿主（读不出结论时不下结论、下次再核）。
  void assertRoutingPreset(ctx,AbortSignal.timeout(30_000))
  const readTaskToolPolicy:TaskToolPolicyReader=async(sessionId,signal)=>{
    signal.throwIfAborted()
    return (await runService()).toolPolicy(owner,{sessionId})
  }
  const runtimeLinks:TaskRunRuntimeLinks={
   list:async input=>new TaskRunRuntimeLinkService((await resources.database()).pool).list(owner,input),
   put:async input=>new TaskRunRuntimeLinkService((await resources.database()).pool).put(owner,input),
  }
  const taskTeam=createTaskRunTeam(ctx,subagentDelegation,readTaskToolPolicy,runtimeLinks)
  const taskBrowser=createTaskRunBrowser(ctx,runtimeLinks,readTaskToolPolicy)
  const taskOrchestration=createTaskRunOrchestration(ctx,subagentDelegation,readTaskToolPolicy,runtimeLinks,{timeoutMs:600_000,maxRounds:6})
  resources.beforeDatabaseClose(taskOrchestration.dispose)
  resources.beforeDatabaseClose(taskTeam.dispose)
  resources.beforeDatabaseClose(taskBrowser.dispose)
  registerNativeAutoReviewGuard(ctx,readTaskToolPolicy)
  // 凭据读取面的守卫与脱敏（规格 §4，抬门槛不是边界）：全局 prepend，扫全部工具参数；已存值取不到时只按前缀形态脱敏。
  let knownUnavailable=false
  const safeKnown=():readonly string[]=>{try{return knownSecretValues(ctx.credentials)}catch{if(!knownUnavailable){knownUnavailable=true;ctx.logger.warn('凭据提供方不可用，脱敏只按前缀形态')}return []}}
  const credentialRoots=()=>protectedRootsFor({providerPaths:(ctx.credentials as unknown as {protectedPaths?:()=>string[]}|undefined)?.protectedPaths?.()??[],runtimeRoot,projectRoot,env:process.env})
  registerCredentialGuards(ctx,{roots:credentialRoots,known:safeKnown})
  registerTaskToolGuard(ctx,readTaskToolPolicy,
  // teloa_group_attach 同进自授权集：它只登记意图，既不是 MCP 资源工具、编排类、委派工具，也不是外发通道，
  // 因此过得了上面那三条装配期断言。真正的许可核对在服务端 post（canPost ＋ 本次运行的成果），
  // 加上它自己的 tools/pre-execute 闸（有 groupContext 且 canPost 才放行）——自授权只是让它在群运行里可见。
  // teloa_group_react 同理：它只在群运行里给本话题的消息加一个固定表情，同样不属于那四类，
  // 许可全部由它自己的 authorize()（群上下文 ＋ canPost ＋ 本话题）承担。
  [...selfAuthorizedToolNames],async(sessionId,signal)=>{
    // 外发闸只在 web_fetch / web_search 这两个工具上问一次，不在每次工具调用上查库。
    signal.throwIfAborted()
    const pool=(await resources.database()).pool,identity={id:randomUUID,now:()=>new Date().toISOString()}
    return new BusinessTaskService(pool,identity,new TaskService(pool,identity)).hasBusinessSource(owner,sessionId)
  },subagentDelegation,{
    // 上网闸只在 web_fetch / web_search 这两个工具上问一次，不在每次工具调用上查库（与上面的外发绑定读口同一取法）。
    // 故意不缓存这个读口：本人在设置里关掉总开关或加一条拦截域名，下一次外发就按新策略判，不必重启宿主、不必等任何失效窗口。
    policy:async signal=>{signal.throwIfAborted();return webAccessPolicy()},
    record:async(sessionId,entry,signal)=>{
      signal.throwIfAborted()
      // runId 的解析复用子任务委派那条已验证过的路（上面 subagentDelegation.runId 同一取法）。
      const run=await (await runService()).skillScope(owner,{sessionId})
      signal.throwIfAborted()
      if(!run)return 'no-run'                       // 普通会话没有 Run 作用域，放行且不记录
      await new TaskRunWebAccessService((await resources.database()).pool,{now:()=>new Date().toISOString()}).append(owner,run.id,entry)
      return 'written'
    },
  },taskTeam,taskBrowser.cleanup,taskOrchestration)
  assertRoutingGuardRegisteredFirst(ctx)
  resources.beforeDatabaseClose(registerTaskSubagentTool(ctx,subagentDelegation))
  registerRoleMemoryTools(ctx,{
    owner,
    run:sessionId=>(runService()).then(service=>service.skillScope(owner,{sessionId})),
    scope:runId=>(runService()).then(service=>service.executionScope(owner,{runId})),
    create:(actor,input)=>(roleMemoryService()).then(service=>service.create(actor,input)),
  })
  // 两个每日小结工具与岗位记忆候选同属自授权集：每次运行都可见，能不能用由它们自己的闸判定。
  registerRoleDailyDigestTools(ctx,{
    owner,
    run:sessionId=>(runService()).then(service=>service.skillScope(owner,{sessionId})),
    digestRun:runId=>(roleDailyLogService()).then(service=>service.digestRun(owner,{runId})),
    evidence:identity=>(roleDailyLogService()).then(service=>service.dayEvidence(owner,identity)),
    submit:(identity,requestId,value)=>(roleDailyLogService()).then(service=>service.submitDigest(owner,identity,requestId,value)),
  })
  /**
   * 员工声明贴回文件的工具。自授权只解决「在群运行里可见」，能不能用由这里的闸判：
   * 有群执行上下文且本岗位 canPost 为真才放行，其余一律拒。登记表只记意图，
   * 字节读取、核对与定版都在运行结束后的 `post` 事务里。
   */
  const groupAttachClaims=registerGroupAttachTool(ctx,{context:async(sessionId,signal)=>{
    signal.throwIfAborted()
    const run=await(await runService()).skillScope(owner,{sessionId})
    if(!run?.groupContext||run.sessionId!==sessionId||!['accepted','active'].includes(run.state))return undefined
    signal.throwIfAborted()
    const read=await new GroupAgentGrantService((await resources.database()).pool,()=>new Date().toISOString()).get(owner,{groupId:run.groupContext.groupId,roleId:run.groupContext.roleId})
    const grant=read.grant
    const canPost=read.status==='active'&&grant!==null&&grant.grantVersion===run.groupContext.grantVersion&&grant.canPost
    return {canPost,nativeRequestId:run.nativeRequestId}
  }})
  /**
   * 员工给群消息加表情的工具。前两道闸与上面贴回文件那把完全同口径（群执行上下文 ＋ 现读 grant 的 canPost），
   * 再一道是本话题：目标消息必须落在本次运行来源消息所在的那个话题里，跨话题一律拒。
   * 四道闸（群运行、canPost、入参、本话题）都在工具自己的 authorize() 里判完，`react` 端口只负责写。
   */
  registerGroupReactTool(ctx,{
    context:async(sessionId,signal)=>{
      signal.throwIfAborted()
      const run=await(await runService()).skillScope(owner,{sessionId})
      if(!run?.groupContext||run.sessionId!==sessionId||!['accepted','active'].includes(run.state))return undefined
      signal.throwIfAborted()
      const read=await new GroupAgentGrantService((await resources.database()).pool,()=>new Date().toISOString()).get(owner,{groupId:run.groupContext.groupId,roleId:run.groupContext.roleId})
      const grant=read.grant
      const canPost=read.status==='active'&&grant!==null&&grant.grantVersion===run.groupContext.grantVersion&&grant.canPost
      return {canPost,groupId:run.groupContext.groupId,rootId:run.groupContext.source.rootId,roleId:run.groupContext.roleId,runId:run.id}
    },
    inTopic:async(context,messageId,signal)=>{
      signal.throwIfAborted()
      const {pool}=await resources.database(),db=await pool.connect()
      try{return await new GroupReactionService(pool,{now:()=>new Date().toISOString()}).inTopic(db,owner,context.groupId,context.rootId,messageId)}finally{db.release()}
    },
    // requestId 由 (本人,消息,岗位,表情) 确定性派生：与表情行的主键一一对应，重放落同一行，不会撞 unique(owner_id,request_id)。
    react:async(context,messageId,emoji,signal)=>{
      signal.throwIfAborted()
      const {pool}=await resources.database(),db=await pool.connect()
      try{await new GroupReactionService(pool,{now:()=>new Date().toISOString()}).applyRole(db,owner,{groupId:context.groupId,messageId,roleId:context.roleId,emoji,runId:context.runId,requestId:groupRoutedReactionRequestId(owner,messageId,context.roleId,emoji)})}finally{db.release()}
    },
  })
  const conversationKnowledge=new ConversationKnowledgeService(database.pool,database.knowledge,database.service,()=>new Date().toISOString())
  registerKnowledgeTools(ctx,{
    owner,conversation:id=>service.bySession(owner,id),
    readTaskPolicy:async(id,signal)=>{signal.throwIfAborted();return (await runService()).toolPolicy(owner,{sessionId:id})},
    knowledge:conversationKnowledge,
  })
  const managedRunSkillPorts:ManagedRunSkillPorts={
    managedFiles,
    getInstallation:async(id,db)=>{
      const installation=db?await readInstalledSkillInstallation(db,owner,id):await(await skillInstallationService()).get(owner,{installationId:id})
      await(await fixedSkillSource(db)).assertModelsReady(owner,installation.source)
      return installation
    },
    readSource:async(source,db)=>(await fixedSkillSource(db)).read(owner,source),
  }
  const resolveManagedRunSkill=createManagedRunSkillResolver(owner,managedRunSkillPorts)
  const runSkillScopes=createManagedRunSkillScope(ctx,{managedRoot:managedFiles.root,verify:createManagedRunSkillVerifier(owner,managedRunSkillPorts)})
  resources.beforeDatabaseClose(()=>runSkillScopes.dispose())
  // 受管 MCP 连接器：从官方目录快照按 catalogId 查询连接器条目。store 方法（import/findByIdentity）
  // 在 getConnectorEntry 路径中不被调用，传入 noop 对象仅为满足 OfficialCatalogService 构造签名。
  const officialCatalogForMcp=new OfficialCatalogService({} as unknown as MarketContentStore)
  // 模型二期：本机 Ollama 七端点。路由写入只经 DSH settings / credentials（dsh-base 组合必带，已入 inject）；地址只由本人在设置里填写。
  // 拉取 / 接入 / 移除只从认证后的工作台 RPC 到达；teloaWork.invoke 白名单不含这些端点，会话工具（功能验证）只拿 pullFacts / startPull。
  const localModelsHandler=createLocalModelsHandler({runtimeRoot,catalog:()=>officialCatalogForMcp.listLocalModelEntries(),settings:Reflect.get(ctx,'settings') as Parameters<typeof createLocalModelsHandler>[0]['settings'],credentials:Reflect.get(ctx,'credentials') as Parameters<typeof createLocalModelsHandler>[0]['credentials'],client:address=>new OllamaClient(address),logger:ctx.logger})
  resources.beforeDatabaseClose(()=>localModelsHandler.dispose())
  installLocalModelRequests(ctx,localModelsHandler)
  registerManagedRunSkillPreStep(ctx,async(sessionId,signal)=>{
    signal.throwIfAborted()
    const run=await(await runService()).skillScope(owner,{sessionId})
    if(!run)return undefined
    if(run.state==='prepared'||run.state==='withdrawn'||run.state==='configuration_failed')throw new WorkError('teloa/forbidden','本会话的执行尚未提交、已撤销或运行配置失败，请从任务中核对执行。')
    return run
  },(agent,run,signal)=>{runPorts.ensureModels(agent,run);return runSkillScopes.ensure(agent,{id:run.id,sessionId:run.sessionId,skills:run.skills},signal)})
  const runPorts=dshTaskRunPorts(ctx,owner,id=>service.bySession(owner,id),readExecutionKnowledge,resolveManagedRunSkill,async(name,db)=>{
    if(db)return (await readSkillAvailabilityByName(db,owner,name))?.availability
    const client=await(await resources.database()).pool.connect()
    try{return (await readSkillAvailabilityByName(client,owner,name))?.availability}finally{client.release()}
  },async(run,signal)=>{
    const resolved=await ctx.sessionController.resolveAgent(brandString<SessionId>(run.sessionId))
    signal.throwIfAborted()
    if('error' in resolved)throw new WorkError('teloa/session-unavailable','运行技能作用域的会话不可用。')
    if(resolved.agent.session.id!==run.sessionId)throw new WorkError('teloa/forbidden','运行技能作用域与固定会话不一致。')
    await runSkillScopes.ensure(resolved.agent,{id:run.id,sessionId:run.sessionId,skills:run.skills},signal)
  },(sessionId,installationIds,signal,database)=>resolveDshManagedRoleSkills(ctx,owner,sessionId,installationIds,id=>service.bySession(owner,id),signal,managedRunSkillPorts,database),readRoleScopes,runtimeLinks,(config,signal)=>localModelsHandler.prepareRequest(config,signal),name=>declaredSkillSecrets(name),ctx.get('teloaNativeInput')?.input)
  // 手动执行与自动化都经执行驱动启动：被原生宿主接受即记一次当日活动
  runPorts.onAccepted=()=>signalActivity()
  runPorts.stableStart=availabilitySync.stable
  runPorts.continuations=taskTeam.runContinuations
  const backgroundState=runPorts.backgroundState
  runPorts.backgroundState=async run=>{
   // get 的 Run 不附子级投影；例外须补读全量登记，不能把仅 outstanding 为空当作从未派发。
   const fixed=isTextOnlyTaskRun(run)?{...run,subagents:await subagentDelegation.list(run.id)}:run
   const background=await backgroundState?.(fixed)
   // 固定空权限与全关联核对已排除 Team/编排；冷读结果无需恢复负责人 Agent。
   if(background?.ownerOnly===true)return background
   const team=await taskTeam.state(run),orchestration=await taskOrchestration.state(run)
   return {outstanding:background?.outstanding===true||team.outstanding||orchestration.outstanding,interrupted:background?.interrupted===true||team.interrupted||orchestration.interrupted}
  }
  runPorts.stopChildren=async(run,signal)=>{
   const children=await new TaskRunSubagentService((await resources.database()).pool,{now:()=>new Date().toISOString()}).outstanding(owner,run.id)
   const stopped=await Promise.allSettled([taskOrchestration.stop(run,signal),taskTeam.stop(run,signal),stopTaskRunChildren(ctx,run,children,signal)])
   const failed=stopped.find(result=>result.status==='rejected')
   if(failed?.status==='rejected')throw failed.reason
  }
  attachTaskRunBrowser(runPorts,taskBrowser)
  // 两类已授权图片各走原件窄读口；能不能发由 task-run-dsh 按模型视觉能力三态判。
  runPorts.groupPrompt={
   readAttachmentImageBytes:ref=>attachmentPorts.readImageBytes(ref),
   readArtifactImageBytes:async ref=>{
    const client=await(await resources.database()).pool.connect()
    try{
     await client.query('begin isolation level repeatable read read only')
     const bytes=await readRunGroupArtifactImageBytes(client,owner,{kind:'artifact',id:ref.artifactId,version:ref.version,sha256:ref.sha256,mime:ref.mediaType,bytes:ref.bytes,name:ref.name})
     await client.query('commit')
     return bytes
    }catch(error){await client.query('rollback');throw error}finally{client.release()}
   },
   markNoVision:(sessionId,nativeRequestId)=>groupAttachClaims.markNoVision(sessionId,nativeRequestId),
  }
  runPorts.publishGroupResult=createTaskRunGroupPublisher({
   post:async input=>{
    const signal=new AbortController().signal
    // 声明登记时已过 tools/pre-execute 守卫；贴出前按会话 cwd 再判一次，防登记后把文件换成指向凭据的链接。
    const refuseProtectedClaim=async(sessionId:string,path:string)=>{
     const resolved=await ctx.sessionController.resolveAgent(brandString<SessionId>(sessionId))
     const cwd='error' in resolved?undefined:resolved.agent.session.header.cwd
     if(!cwd||guardDecision({path},{toolName:groupAttachToolName,cwd,roots:credentialRoots(),known:[],env:process.env,home:homedir()}))throw new WorkError('teloa/file-scope','该文件属于本机凭据或无法核对，未贴进群。')
    }
    const artifacts={
     // 员工声明的文件走既有 `artifacts/files/read` 那条路：三道路径闸与四个位置码原样生效。
     readClaimedFile:async(sessionId:string,claim:{path:string;sha256:string})=>{
      await refuseProtectedClaim(sessionId,claim.path)
      const file=await readArtifactFile('artifacts/files/read',{sessionId,path:claim.path},signal)
      if(!('contentBase64' in file))throw new WorkError('teloa/file-unavailable','未返回文件快照。')
      return file
     },
     report:(code:string)=>ctx.logger.warn('Teloa 员工声明的文件未贴出：%s',code),
    }
    return new GroupRunMessageService((await resources.database()).pool,{id:randomUUID,now:()=>new Date().toISOString()},artifacts,runGroupFilePorts).post(owner,redactRunMessage(input,safeKnown))
   },
   run:(sessionId,nativeRequestId)=>({files:groupAttachClaims.claims(sessionId,nativeRequestId),noVision:groupAttachClaims.noVision(sessionId,nativeRequestId)}),
   clear:(sessionId,nativeRequestId)=>groupAttachClaims.clear(sessionId,nativeRequestId),
   // 员工回帖也是一条新群消息：接力由同一道路由判断接手，服务端不解析正文里的 @。
   route:messageId=>{void runtimeAdmission.defer(()=>dispatchGroupRouting(ctx,owner,messageId,groupRoutingDispatchPorts,new AbortController().signal)).catch(error=>ctx.logger.warn('Teloa 群内路由未完成：%s',codeOf(error,'teloa/dependency-unavailable')))},
   report:code=>ctx.logger.warn('Teloa 员工群内回传未写入：%s',code),
  })
  runPorts.subagentState=async(run,signal)=>{
   signal.throwIfAborted()
   const subagents=await new TaskRunSubagentService((await resources.database()).pool,{now:()=>new Date().toISOString()}).outstanding(owner,run.id)
   signal.throwIfAborted()
   return subagents.length?'outstanding':'none'
  }
  // 广播适配器：本机日志为 primary，IM 通道插件经 teloaWork.notifications.addAdapter 追加。
  const notificationBroadcast=createBroadcastNotificationAdapter(createLocalNotificationAdapter(ctx.logger),ctx.logger)
  const notificationDriver=new NotificationDeliveryDriver(new NotificationDeliveryService(database.pool,{id:randomUUID,now:()=>new Date().toISOString()}),notificationBroadcast,{now:()=>new Date().toISOString(),limit:50})
  const deliverNotifications=(actor:string,signal:AbortSignal)=>runtimeAdmission.run(()=>notificationDriver.deliver(actor,signal))
  const planRuntime=createPlanRuntime({owner,getPool:async()=>(await resources.database()).pool,conversations:service,getRunService:runService,runPorts,loadTaskKnowledge,deliverNotifications,reportNotification:code=>ctx.logger.warn('Teloa 通知投递待恢复：%s',code)})
  resources.beforeDatabaseClose(startPlanScheduler({
    recover:(now,signal)=>runtimeAdmission.run(()=>planRuntime.coordinator.recover(now,signal)),
    tick:(now,signal)=>runtimeAdmission.run(()=>planRuntime.coordinator.tick(now,signal)),
    report:(phase,code)=>ctx.logger.warn('Teloa 调度状态待核对：%s（%s）',phase,code),
  }))
  const habitTick=createAutoDreamHabitTick({
   observe:async(now,signal)=>{
    const {pool}=await resources.database()
    const identity={id:randomUUID,now:()=>now},plans=new PlanService(pool,identity,new MarketContentStore(pool,identity))
    const roles=await new RoleService(pool,identity,{plans}).list(owner,{})
    for(const role of roles){
     if(signal.aborted)return
     if(role.kind==='twin'&&role.state==='active')await (await autoDreamHabitService()).ensureForDay(owner,role,now)
    }
   },
   report:code=>ctx.logger.warn('Teloa 分身观察待恢复：%s',code),
  })
  resources.beforeDatabaseClose(startPlanScheduler({recover:async()=>{},tick:(now,signal)=>runtimeAdmission.run(()=>habitTick(now,signal)),report:(_phase,code)=>ctx.logger.warn('Teloa 分身观察待恢复：%s',code)}))
  const planScheduleHandler=createPlanScheduleHandler(owner,{isAvailable:()=>true,overview:planRuntime.readPorts.overview,getStatus:planRuntime.readPorts.status,executionHistory:planRuntime.readPorts.executionHistory,skipHistory:planRuntime.readPorts.skipHistory})
  const taskRunHandler=createTaskRunHandler(owner,runService,runPorts,loadTaskKnowledge,{conversations:service,links:new ObjectConversationService(database.pool,(actor,id)=>service.bySession(actor,id),()=>new Date().toISOString())},{listMany:(actor,runIds)=>new TaskRunSubagentService(database.pool,{now:()=>new Date().toISOString()}).listMany(actor,runIds),recover:(actor,input)=>new TaskRunSubagentService(database.pool,{now:()=>new Date().toISOString()}).recover(actor,input)},{estimate:async sessionId=>{
   try{
    const agent=ctx.agents.get(brandString<SessionId>(sessionId)),meter=Reflect.get(ctx,'tokenMeter') as {measure?:(session:unknown)=>{totalTokens?:unknown}}|undefined,total=agent===undefined?undefined:meter?.measure?.(agent.session).totalTokens
    return typeof total==='number'&&Number.isSafeInteger(total)&&total>=0&&total<=2147483647?total:undefined
   }catch{return undefined}
  }},{listMany:(actor,runIds)=>new TaskRunWebAccessService(database.pool,{now:()=>new Date().toISOString()}).listMany(actor,runIds)},createTaskRunModelReader(ctx,runPorts.continuations))
  const taskRunFlowHandler=createTaskRunFlowHandler(owner,async()=>new TaskRunFlowService((await resources.database()).pool,{id:randomUUID,now:()=>new Date().toISOString()}))
  let deliverConversationWork:()=>Promise<void>=async()=>{}
  resources.beforeDatabaseClose(monitorTaskRuns({
    list:async()=>(await runService()).outstanding(owner),
    reconcile:id=>runtimeAdmission.run(async()=>new TaskRunDriver(await runService(),runPorts).reconcile(owner,{runId:id})),
    deliver:async()=>{await deliverNotifications(owner,new AbortController().signal);await deliverConversationWork()},
    report:(id,code)=>ctx.logger.warn('Teloa 执行观察待恢复：%s（%s）',id,code),
    // 停止请求有落点之后，这条循环才有升级依据：已请求停止却仍在执行的记录按退避重发取消，
    // 最多 5 次。超过上限只剩记录上的停止时间可看，不伪造终态。
    // 「仍在执行」必须按宿主自报的 running 判：宿主已经不在跑时重发只是 no-op，那种局面由
    // reconcile 凭 seq 冻结收口（见 task-run-driver.ts），再喊停只会白白刷错误。
    resendStop:{
      needed:async observed=>{
        const run=observed as TaskRun
        if(run?.stopRequestedAt===null||run?.state!=='active')return false
        return runPorts.stopState?(await runPorts.stopState(run)).running:true
      },
      send:id=>runtimeAdmission.run(async()=>{await new TaskRunDriver(await runService(),runPorts).stop(owner,{runId:id},new AbortController().signal)}),
      limit:5,
      backoff:{initialMs:2000,maxMs:300000,now:()=>Date.now()},
    },
  }))
  // 会话事件的订阅式增量投影（规格 §八 G5）：上游把同步读整体标了 @deprecated，
  // 读口收进 session-events.ts 之后由这条订阅喂养——事件落库后原样接到投影尾部，
  // 于是正常路径上一次整表快照都不用读。漏收或错位会被投影自己判出来并回落重建，
  // 所以这条订阅只影响开销、不影响正确性。
  ctx.on('session/event',(session,event)=>{projectSessionEvent(session,event)})
  // 安全执行的后台恢复：recover() 本身是 GET-first + 同 body 重放，外部效果恰好一次
  // （security-action-http-adapter.test.ts:130 已证），所以后台调用不新增外部风险，
  // 它只是把"等用户点观察"换成"宿主自己去核对一次"。必须注册进 beforeDatabaseClose，
  // 否则 host-shutdown.test.ts:6 的"等回填结束才关库"对这条新循环不成立。
  resources.beforeDatabaseClose(monitorTaskRuns({
    list:()=>securityExecutions.outstanding(securityPrincipal),
    reconcile:id=>runtimeAdmission.run(()=>securityDriver.recover(securityPrincipal,id,new AbortController().signal)),
    report:(id,code)=>ctx.logger.warn('Teloa 安全执行恢复待核对：%s（%s）',id,code),
    // 恒失败的记录必须退避：recover() 查不到既有回执时会按同 body 重放 POST，
    // 而库里的一分钟冷却推不动（markUnknown 对已是 effect_unknown 的记录不写库）。
    // 2 秒起步与本循环的 tick 同形，5 分钟封顶——真实 EDR 的速率限制窗口一般在这个量级以内，
    // 封顶之后仍按 5 分钟周期重试，不放弃这条待恢复执行。
    backoff:{initialMs:2000,maxMs:300000,now:()=>Date.now()},
  }))
  const artifactHandler=createArtifactHandler(owner,{readMessage:async expected=>{const resolved=await ctx.sessionController.resolveAgent(brandString<SessionId>(expected.sessionId));if('error' in resolved)throw new WorkError('teloa/session-unavailable','原生会话不可用。');return readNativeArtifactMessage(expected.sessionId,readSessionEvents(resolved.agent.session),expected)},pool:async()=>(await resources.database()).pool,conversation:sessionId=>service.bySession(owner,sessionId),readFile:async(sessionId,path,signal)=>{const file=await readArtifactFile('artifacts/files/read',{sessionId,path},signal);if(!('contentBase64' in file))throw new WorkError('teloa/file-unavailable','未返回文件快照。');return file},id:randomUUID,now:()=>new Date().toISOString()})
  // 卸载要在同一事务里暂停该加载创建的持续计划，因此这里的加载服务必须带上持续计划端口。
  // 升级按 `use-template` 重放岗位模板字段要用到岗位服务，而岗位服务本身又依赖加载服务：
  // 端口做成延迟取值，两者才能互指；升级之外的路径一次都不会读到它。
  const industryLoadsHandler=createIndustryLoadsHandler(owner,async()=>{
   const {pool,service:resourceService}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity)
   const loads:IndustryLoadService=new IndustryLoadService(pool,identity,createIndustryLoadSource(market),new PlanService(pool,identity,market),{applyTemplateInTransaction:async(db,ownerId,input)=>industryRoles.applyTemplateInTransaction(db,ownerId,input)})
   const knowledge=new IndustryKnowledgeService(pool,identity,loads,new IndustryReferenceCatalog(pool,market,loads),resourceService)
   const industryRoles:IndustryRoleService=new IndustryRoleService(pool,identity,loads,new IndustryRoleSource(market,loads),knowledge,new RoleService(pool,identity,{plans:new PlanService(pool,identity,market)}))
   return loads
  })
  const industryKnowledgeHandler=createIndustryKnowledgeHandler(owner,async()=>{const {pool,service:resourceService}=await resources.database();const identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market));return new IndustryKnowledgeService(pool,identity,loads,new IndustryReferenceCatalog(pool,market,loads),resourceService)})
  const industryDataSourceHandler=createIndustryDataSourceHandler(owner,async()=>{const {pool}=await resources.database();const identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),source=new IndustryDataSourceSource(market,loads);return new IndustryDataSourceService(pool,identity,loads,source,createIndustryDataSourceReadiness([securityAlertSource],identity.now))})
  const industryExecutionToolHandler=createIndustryExecutionToolHandler(owner,async()=>{const {pool}=await resources.database();const identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),source=new IndustryExecutionToolSource(market,loads);return new IndustryExecutionToolService(pool,identity,loads,source,securityReadiness)})
  const industryMcpConnectionHandler=createIndustryMcpConnectionHandler(owner,async()=>{const {pool}=await resources.database();const identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),source=new IndustryMcpConnectionSource(market,loads);return new IndustryMcpConnectionService(pool,identity,loads,source,createIndustryMcpReadiness(()=>ctx.tools.schemas(),identity.now))})
  // 三类连接的"测试连接"共用一个只读端点：读取层各自新建互不共享状态，就绪端口原样复用推进路径已在用的那三个。
  const connectorHandler=createConnectorHandler(owner,async()=>{
   const {pool}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
   /**
    * 探针整条路径跑在 `repeatable read read only` 事务里，而市场固定内容的缺省读口会发 `select … for share`，
    * 两者在 Postgres 里不能共存（25006）——2026-09-16 隔离宿主验收时三类连接器的「测试连接」因此全部回
    * `teloa/host-unavailable`。只给探针这三份读取层换一个不取锁的市场读口；登记 / 连接 / 授权那三条写路径
    * 上的同名读取层逐字不动，仍按缺省取锁（与 `BusinessDefinitionSourceReader` 的同一条裁定，复审 MEDIUM-6）。
    */
   type MarketRead=MarketContentStore['getInTransaction']
   const unlockedMarket={getInTransaction:(client:Parameters<MarketRead>[0],actor:Parameters<MarketRead>[1],input:unknown)=>market.getInTransaction(client,actor,input,false)}
   const dataSourceSource=new IndustryDataSourceSource(unlockedMarket,loads),mcpSource=new IndustryMcpConnectionSource(unlockedMarket,loads),executionToolSource=new IndustryExecutionToolSource(unlockedMarket,loads)
   return new ConnectorProbeService(pool,identity,{
    'data-source':{read:(db,ownerId,input)=>dataSourceSource.read(db,ownerId,input),ready:createIndustryDataSourceReadiness([securityAlertSource],identity.now).ready},
    mcp:{read:(db,ownerId,input)=>mcpSource.read(db,ownerId,input),ready:createIndustryMcpReadiness(()=>ctx.tools.schemas(),identity.now).ready},
    'execution-tool':{read:(db,ownerId,input)=>executionToolSource.read(db,ownerId,input),ready:securityReadiness.ready},
   })
  })
  // 技能密钥：只经 ctx.credentials 记录半边存取；声明来自官方目录（快照 + 上游缓存）；审计事件不含值。
  // 技能密钥声明一律按当前安装绑定的目录条目 id 取（审查 R1 M-1 / R2 N-1）：非目录来源或未安装不注入；确认卡、代发、密钥页、加载提示同一来源。
  const selectedManagedSkill=async(name:string)=>{const client=await(await resources.database()).pool.connect();try{return await readSkillAvailabilityByName(client,owner,name)}finally{client.release()}}
  // L-6：三态绑定之外核对运行时解析来源——按会话视角（默认工作区）胜出的同名技能须是受管选定安装本身，被遮蔽即无声明；
  // 停用的受管安装不参与运行（代发可见性另拒），仍允许在密钥页预先填写。
  // 绑定查询与胜出者核对共用 availabilitySync.stable；维护不能在两次读取之间切换选定安装。
  const declaredSkillSecrets=declaredSkillSecretsResolver(officialCatalogForMcp,async name=>{const client=await(await resources.database()).pool.connect();try{return await readInstalledSkillBinding(client,owner,name)}finally{client.release()}},async name=>{
    const selected=await selectedManagedSkill(name)
    if(!selected)return false
    if(selected.availability==='disabled')return true
    return isManagedSkillWinner(await withPresetReadScope(ctx.agentPresets,scope=>ctx.skills.get(name,{cwd:workspaceRoot,scope})),managedFiles.path(selected.installationId))
  },availabilitySync.stable)
  const skillSecretStore=createSkillSecretStore(ctx.credentials,declaredSkillSecrets,event=>ctx.logger.info(JSON.stringify(event)))
  // 市场二期：连接器上报的版本只取宿主官方目录（验收夹具连接器不在其中，也不会上报）
  // 连接器与 AI 员工的上报版本取本地目录快照，不取客户端载荷
  const catalogEntryVersion=(kind:'connector'|'role',id:string)=>kind==='connector'?officialCatalogForMcp.getConnectorEntry(id)?.version:officialCatalogForMcp.getRoleEntry(id)?.version
  // 市场二期：安装量榜单只保留宿主本地目录快照中仍存在的条目（已下架或不存在的剔除）
  const marketRanking=createMarketRanking(()=>({CI:process.env.CI,NODE_ENV:process.env.NODE_ENV,...trusted}),undefined,id=>officialCatalogForMcp.hasEntry(id),()=>trusted)
  // OAuth 回调路由 /oauth/callback 挂在宿主 HTTP 服务上（inject 含 webServer），令牌刷新定时器每分钟一次；关停时一并撤回
  // 仅浏览器验收宿主（TELOA_BROWSER_ACCEPTANCE=1）且验收脚本给出本机假 MCP 地址时：追加两条夹具连接器并放行环回授权服务器
  const oauthAcceptance=acceptanceOAuthFixture(trusted)
  const {handler:managedMcpConnectionBase,restoreConnections:restoreMcpConnections,getManagedMcpToolRules,dispose:disposeMcpConnections,callTool:callManagedMcpTool,isReadOnlyTool:isManagedMcpReadOnlyTool,isConnected:isManagedMcpConnected,writeToolLabel:managedMcpWriteToolLabel}=createManagedMcpConnectionHandler(ctx,runtimeRoot,id=>{
   const fixture=oauthAcceptance?.entry(id)
   if(fixture)return fixture
   // stdio 配方随条目带上工件里的完整 lock，安装按它 npm ci 并逐条核对
   const entry=officialCatalogForMcp.getConnectorEntry(id)
   return entry&&{...entry,packageLock:officialCatalogForMcp.getConnectorPackageLock(id)}
  },undefined,oauthAcceptance?.createOAuthManager)
  const managedMcpConnectionHandler=withResourceInstallReport(managedMcpConnectionBase,reportResourceInstall,catalogEntryVersion)
  resources.beforeDatabaseClose(disposeMcpConnections)
  // 目录声明的写工具在个人会话与执行态调用前都弹官方审批卡
  registerManagedMcpWriteApproval(ctx,managedMcpWriteToolLabel)
  businessMcpSource=createMcpSyncSource(input=>callManagedMcpTool(input.serverName,input.tool,input.arguments,input.signal??AbortSignal.timeout(60_000)),{connected:isManagedMcpConnected,readOnly:isManagedMcpReadOnlyTool})
  const mcpConnectionRestore=runtimeAdmission.run(()=>restoreMcpConnections()).catch(error=>ctx.logger.warn('受管 MCP 连接恢复未完成：%s',codeOf(error,'teloa/dependency-unavailable')))
  resources.beforeDatabaseClose(()=>mcpConnectionRestore)
  // 业务同步与看板刷新：同步来源与受管 MCP 已就绪后才起调度。周期以分钟计，每 30 秒看一次到期项即可（到期判定要逐范围读声明）；
  // 单飞、停机检测、取消与错误上报全部由 startPlanScheduler 承担，关闭宿主时先停调度再关库。
  const businessSyncTick=createBusinessSyncTick({owner,services:async()=>{const {sync,dashboards}=await businessDefinitionServices();return {sync,dashboards}},scopeIds:businessScopeIds,logger:ctx.logger})
  const businessSyncTimer=(work:()=>void)=>{const timer=setTimeout(work,30_000);timer.unref?.();return ()=>clearTimeout(timer)}
  resources.beforeDatabaseClose(startPlanScheduler({recover:async()=>{},tick:(now,signal)=>runtimeAdmission.run(()=>businessSyncTick(now,signal)),report:(_phase,code)=>ctx.logger.warn('Teloa 业务同步待恢复：%s',code)},()=>new Date().toISOString(),businessSyncTimer))
  const industryRolesBase=createIndustryRolesHandler(owner,async()=>{const {pool,service:resourceService}=await resources.database();const identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),knowledge=new IndustryKnowledgeService(pool,identity,loads,new IndustryReferenceCatalog(pool,market,loads),resourceService);return new IndustryRoleService(pool,identity,loads,new IndustryRoleSource(market,loads),knowledge,new RoleService(pool,identity,{plans:new PlanService(pool,identity,market)}))})
  // 方案附带的 AI 员工：查证函数在下方定义，调用发生在建岗之后，所以用箭头函数延迟取用
  const industryRolesHandler=withSolutionRoleReport(industryRolesBase,reportResourceInstall,(loadId,roleId,day)=>solutionRoleEntry(loadId,roleId,day),()=>detectExclusion()===undefined)
  const taskAttentionHandler=createTaskAttentionHandler(owner,async()=>new TaskAttentionService((await resources.database()).pool))
  const projectHandler=createProjectHandler(owner,async()=>new ProjectService((await resources.database()).pool,{id:randomUUID,now:()=>new Date().toISOString()}))
  const taskHandler=createTaskHandler(owner,async()=>new TaskService((await resources.database()).pool,{id:randomUUID,now:()=>new Date().toISOString()}),async()=>new TaskTransitions((await resources.database()).pool,{id:randomUUID,now:()=>new Date().toISOString()}))
  const objectConversations=async()=>new ObjectConversationService((await resources.database()).pool,(actor,sessionId)=>service.bySession(actor,sessionId),()=>new Date().toISOString())
  ctx.effect(()=>ctx.provide('teloaSessionModelScope',{isIdentityLinked:async(sessionId:string)=>(await (await objectConversations()).bySession(owner,{sessionId})).some(link=>link.kind==='role')}))
  const handleObjectConversations=async(endpoint:string,payload:unknown)=>{
    const {pool}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()},links=await objectConversations()
    if(endpoint==='tasks/context'){
      const context=await links.taskContext(owner,payload),business=await new BusinessTaskService(pool,identity,new TaskService(pool,identity)).context({ownerId:owner,scopeIds:[...await businessScopeIds()]},{taskId:context.task.id})
      return {...context,business}
    }
    return endpoint==='object-conversations/list'?links.list(owner,payload):endpoint==='object-conversations/session'?links.bySession(owner,payload):links.change(owner,payload)
  }
  const handleHandoffs=createHandoffHandler(owner,async()=>new HandoffService((await resources.database()).pool,{id:randomUUID,now:()=>new Date().toISOString()}))
  // 员工在岗自动带一条 Auto Dream 每日小结计划：暂停、复岗、退役都要在同一条岗位事务里带上计划端口。
  const autoDreamPlans=async()=>{const {pool}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()};return {pool,identity,plans:new PlanService(pool,identity,new MarketContentStore(pool,identity))}}
  const changeRoleLifecycle=async(payload:unknown)=>{const {pool,identity,plans}=await autoDreamPlans();return new RoleLifecycleService(pool,identity,{plans}).change(owner,payload)}
  // 技能代发候选（规格 2026-09-27 §5.1，审查修复 R1 M-1）：暂停的AI 员工的岗位技能与行业职责技能（标来源）里，
  // 「目录声明密钥、受管选定且启用」的逐项列出供本人勾选；是否已保存密钥读不出时省略。已持连接（保存事务）时复用它读行业关系。
  const roleIndustrySkills=async(roleId:string,db?:Parameters<typeof readRoleIndustrySkillNames>[0])=>{
    if(db)return readRoleIndustrySkillNames(db,owner,roleId)
    const client=await(await resources.database()).pool.connect();try{return await readRoleIndustrySkillNames(client,owner,roleId)}finally{client.release()}
  }
  const skillHttpGrants=async(role:import('@teloa/contract').DigitalRole,db?:Parameters<typeof readRoleIndustrySkillNames>[0]):Promise<SkillHttpGrantCandidate[]>=>role.state==='paused'&&role.kind==='employee'?skillHttpGrantCandidates([...role.skills.map(name=>({name,source:'role' as const})),...(await roleIndustrySkills(role.id,db)).map(name=>({name,source:'industry' as const}))],{
    selected:selectedManagedSkill,
    declared:declaredSkillSecrets,
    configured:async name=>{try{const state=await skillSecretStore.describe(name);return state.vars.length>0&&!state.reconfirm&&state.vars.every(item=>!item.required||item.configured)}catch{return undefined}},
  }):[]
  const grantRules=async(role:import('@teloa/contract').DigitalRole,activeDb?:Parameters<IndustryMcpConnectionService['activeToolRulesForRoleInTransaction']>[0],skillHttp?:SkillHttpGrantCandidate[])=>{
    const database=await resources.database()
    const build=async(db:Parameters<IndustryMcpConnectionService['activeToolRulesForRoleInTransaction']>[0])=>[
      // 只读资料的来源与版本，不读正文：超大资料不应让整个授权页读不出来。
      ...referenceToolRules(await database.service.executionKnowledgeRoleReferencesInTransaction(db,{ownerId:owner,kind:'agent',scopeIds:role.scopes},role.scopes,role.knowledge)),
      ...await industryMcpToolRules(db,owner,role.id),
      // 受管 MCP 连接的工具：在线时即进入候选，默认不授予；原生保留名过滤同行业 MCP。
      ...getManagedMcpToolRules().filter((rule:{name:string})=>!isNativeToolName(rule.name)),
      // 工具授权只能在暂停的AI 员工上编辑；候选沿用同一前置条件，避免界面给出必然被服务端拒绝的选项。
      // 技能代发换成逐技能枚举（roleGrantPageRules）：没有可代发技能即无此候选，保存同源拒绝。
      ...(role.state==='paused'&&role.kind==='employee'?roleGrantPageRules(taskRunToolRules(nativeToolRules(ctx)),skillHttp??await skillHttpGrants(role,db)):[]),
      // 上网的两条候选同此前置条件，并跟着总开关走：关掉时授权页没有可勾项，保存校验也一并拒。
      ...(role.state==='paused'&&role.kind==='employee'?webToolRules((await webAccessPolicy(db)).enabled):[]),
    ]
    if(activeDb)return build(activeDb)
    const db=await database.pool.connect();try{return await build(db)}finally{db.release()}
  }
  const roleGrantHandler=createRoleToolGrantHandler(owner,async()=>new RoleToolGrantService((await resources.database()).pool,()=>new Date().toISOString(),async(db,actor,role,rules)=>{
    if(actor!==owner)throw new WorkError('teloa/forbidden','员工不属于当前本人。')
    validateReferenceToolRules(rules,await grantRules(role,db))
  }),async roleId=>{
    const role=(await new GrantRoleReader((await resources.database()).pool,{id:randomUUID,now:()=>new Date().toISOString()}).list(owner,{})).find(role=>role.id===roleId)
    if(!role)throw new WorkError('teloa/forbidden','员工不属于当前本人。')
    const skillHttp=await skillHttpGrants(role)
    return {roleVersion:role.version,rules:await grantRules(role,undefined,skillHttp),...(skillHttp.length?{skillHttp}:{})}
  },subagentDelegationLimits)
  const webAccessHandler=createWebAccessHandler(owner,async()=>new WebAccessPolicyService((await resources.database()).pool,()=>new Date().toISOString()))
  const planHandler=createPlanHandler(owner,async()=>{
   const {pool}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()},plans=new PlanService(pool,identity,new MarketContentStore(pool,identity))
   return {
    list:(actor,input)=>plans.list(actor,input),get:(actor,input)=>plans.get(actor,input),create:(actor,input)=>plans.create(actor,input),change:(actor,input)=>plans.change(actor,input),
    trigger:async(actor,input,signal)=>{if(actor!==owner)throw new WorkError('teloa/forbidden','持续计划立即运行不属于当前本人。');return planRuntime.trigger(input,signal)},
   }
  })
  const marketContentHandler=createMarketContentHandler(owner,async()=>{
    const {pool}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity)
    const githubImport=new GithubImportService(market,{read:(ownerId,input)=>new GithubSourceService(pool,{now:identity.now},githubHttp).read(ownerId,input)})
    return {import:(actor,input)=>market.import(actor,input),importGithub:(actor,input)=>githubImport.importIndustry(actor,input),importGithubSkill:(actor,input)=>githubImport.importSkill(actor,input),get:(actor,input)=>market.get(actor,input),getImport:(actor,input)=>market.getImport(actor,input),list:(actor,input)=>market.list(actor,input)}
  })
  const marketCatalogHandler=withResourceInstallReport(createMarketCatalogHandler(owner,async()=>{
    const {pool,service:resourceService}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity)
    const loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),knowledge=new IndustryKnowledgeService(pool,identity,loads,new IndustryReferenceCatalog(pool,market,loads),resourceService)
    const industryRoles=new IndustryRoleService(pool,identity,loads,new IndustryRoleSource(market,loads),knowledge,new RoleService(pool,identity,{plans:new PlanService(pool,identity,market)}))
    const catalog=new OfficialCatalogService(market,undefined,{catalogRoleIds:(ownerId,entries)=>industryRoles.catalogRoleIds(ownerId,entries)},githubHttp)
    return {list:(actor,request)=>catalog.list(actor,request as Parameters<typeof catalog.list>[1]),add:(actor,input)=>catalog.add(actor,input),solutionPackage:(_actor,input)=>catalog.solutionPackage(input.entryId),
     addRole:async(actor,input)=>{if(actor.kind!=='human'||!actor.ownerId)throw new WorkError('teloa/forbidden','当前主体无权添加官方目录条目。');return industryRoles.createFromCatalog(actor.ownerId,input,catalog.roleEntryForAdd(input.entryId))}}
  },encodeMarketReceipt,marketRanking),reportResourceInstall,catalogEntryVersion)
  const solutionRoleEntry=createSolutionRoleResolver({
    load:loadId=>industryLoadsHandler('industry-loads/get',{loadId}),
    content:contentId=>marketContentHandler('market-content/get',{contentId}),
    roleEntry:id=>officialCatalogForMcp.getRoleEntry(id),
  })
  // 市场评价（规格 2026-09-25-市场三期评分评论 §4.4）：应用令牌只存 ctx.credentials（加密存储）记录 teloa-market/account；
  // 地址覆盖与开关只取启动环境（trusted），工作区 .env 不能把带令牌的请求引到别处。
  const marketCredentials=ctx.credentials as unknown as Pick<CredentialProvider,'readRecord'|'modifyRecord'|'deleteRecord'>
  const marketAccountKey=credentialKey('teloa-market','account')
  const marketReviewsHandler=createMarketReviewsHandler({getEnv:()=>({CI:process.env.CI,NODE_ENV:process.env.NODE_ENV,...trusted}),appVersion:TELOA_APP_VERSION,store:{
    read:async()=>{const record=await marketCredentials.readRecord(marketAccountKey);return record?.kind==='api-key'&&typeof record.key==='string'?record.key:undefined},
    write:async token=>{await marketCredentials.modifyRecord(marketAccountKey,async()=>({kind:'api-key',key:token}))},
    remove:async()=>{await marketCredentials.deleteRecord(marketAccountKey)},
  }})
  registerUsageActivity(ctx,signalActivity)
  const githubSourceHandler=createGithubSourceHandler(owner,async()=>new GithubSourceService((await resources.database()).pool,{now:()=>new Date().toISOString()},githubHttp))
  const dshHome=resolveTeloaDshHome(projectRoot),dshProfile=resolveTeloaDshProfile(trusted),activePluginRefs=await readActiveDshPluginRefs(dshHome,dshProfile)
  // 装配期读一次 bundles：作为「本进程应当已加载」的起点（即时启停成功后由处理器增减），并决定装配期是否开放 IM 挂接窗口。读不到按空处理，不影响启动。
  const bundlesAtStart=await readJsonFile(join(dshHome,'profiles',dshProfile,'package.json')).then(profileBundles,()=>[] as string[])
  let bundledExtensionLoaded=(_packageName:string)=>false
  // IM 通道挂接窗口（审查 L6 放宽）：装配期（仅当本次启动的 bundles 含 IM；首次挂接或本人第一次启停即关闭）与本人启用 IM 时那一次热套用期间。
  // 装配期窗口不能按宿主就绪关闭：teloaWork 在本函数末尾才提供，常晚于宿主就绪，启动时已启用的 IM 要在那之后才挂接。
  const imAttachWindow=createImAttachWindow({startup:bundlesAtStart.includes(IM_GATEWAY_PACKAGE),rowPresent:()=>(readCompositionRows(ctx)??[]).some(row=>row.id==='teloa-im-gateway'&&row.name===IM_GATEWAY_PACKAGE&&!row.disabled)})
  const bundledProfileDir=join(dshHome,'profiles',dshProfile)
  // 即时启停（方案 A）：不开 hmr 监听，只在本人点启用/停用时调一次官方 reconcileProfilePatches；前后用装配期同一套函数复验。
  const bundledHotApply=hostBundledHotApplyPorts(ctx,{
    verify:async()=>{
      if((await bundledSourceConflicts(bundledProfileDir,projectRoot)).length||(await bundledModuleConflicts(bundledProfileDir,projectRoot)).length)throw Error(bundledSourceRefusal)
      assertCompositionSafety(ctx,await readProfileFacts(dshHome,dshProfile))
    },
    loaded:packageName=>bundledExtensionLoaded(packageName),
    window:async(packageName,enabled,operation)=>{
      if(packageName!==IM_GATEWAY_PACKAGE||!enabled)return operation()
      // 失败时撤掉窗口内的任何持有者：若有其它进程内插件抢在 IM 之前挂接，IM 自己会挂接失败，回滚不会替我们清掉那个持有者。
      // 找不到根 Include 时 reconcile 尚未动手，现有持有者（例如装配期挂上的 IM）不能被撤。
      return imAttachWindow.during(async()=>{try{return await operation()}catch(error){if(!(error instanceof BundledHotApplyUnsupported))teloaWork.revokeExtension();throw error}})
    },
    warn:message=>ctx.logger.warn(message),
  })
  const bundledExtensionHandler=createBundledExtensionHandler({profileDir:bundledProfileDir,programRoot:projectRoot,runtimeRoot,bundlesAtStart,loaded:packageName=>bundledExtensionLoaded(packageName),
    version:async packageName=>String((await readJsonFile(join(officialBundledSpecs(projectRoot)[packageName]!.slice('link:'.length),'package.json'))).version),
    // 本人对 IM 的第一次启停起，挂接只认热套用窗口；其它随附扩展的启停不影响 IM 的装配期窗口。
    apply:change=>{if(change.packageName===IM_GATEWAY_PACKAGE)imAttachWindow.closeStartup();return hotApplyBundledExtension(bundledHotApply,change)}})
  const marketPluginInstallationHandler=createMarketPluginInstallationHandler(owner,async signal=>new PluginInstallationService((await resources.database()).pool,{id:randomUUID,now:()=>new Date().toISOString()},new DshPluginInstallAdapter({dshHome,profile:dshProfile,registry:'https://registry.npmjs.org',dshCommand:resolve(projectRoot,'node_modules/.bin/dsh'),activePluginRefs,ownerId:owner,...(signal?{signal}:{})})))
  // 启动核对必须在任何 withProfileLock 回调之外发起：observe() 命中"待启用但已入组合"分支时
  // 会自己去拿同一把 profile 锁，而这把锁不可重入（pending-plugins.ts:37）。
  const pluginStartupReconcile=runtimeAdmission.run(async()=>{
   const service=new PluginInstallationService((await resources.database()).pool,{id:randomUUID,now:()=>new Date().toISOString()},new DshPluginInstallAdapter({dshHome,profile:dshProfile,registry:'https://registry.npmjs.org',dshCommand:resolve(projectRoot,'node_modules/.bin/dsh'),activePluginRefs,ownerId:owner}))
   await reconcileInterruptedPluginInstallations({
    list:()=>service.outstanding(owner),
    reconcile:id=>service.reconcile(owner,{installationId:id}),
    report:(id,code)=>ctx.logger.warn('Teloa 扩展安装启动核对待处理：%s（%s）',id,code),
   })
  }).catch(error=>ctx.logger.warn('Teloa 扩展安装启动核对未完成：%s',codeOf(error,'teloa/dependency-unavailable')))
  resources.beforeDatabaseClose(()=>pluginStartupReconcile)
  const industryPluginHandler=createIndustryPluginHandler(owner,async signal=>{const {pool}=await resources.database();const identity={id:randomUUID,now:()=>new Date().toISOString()},market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market)),source=new IndustryPluginSource(market,loads),plugins=new PluginInstallationService(pool,identity,new DshPluginInstallAdapter({dshHome,profile:dshProfile,registry:'https://registry.npmjs.org',dshCommand:resolve(projectRoot,'node_modules/.bin/dsh'),activePluginRefs,ownerId:owner,...(signal?{signal}:{})}));return new IndustryPluginService(pool,identity,loads,source,{preview:(o,s)=>guardDshPluginInstall(()=>plugins.preview(o,{source:s})),install:(o,spec)=>guardDshPluginInstall(()=>plugins.install(o,spec)),reconcile:(o,installationId)=>guardDshPluginInstall(()=>plugins.reconcile(o,{installationId})),find:(o,s)=>guardDshPluginInstall(async()=>{const {items}=await plugins.list(o,{});return items.find(item=>item.preview.source.packageName===s.packageName&&item.preview.source.version===s.version&&projectPluginState(item.state)!=='failed')??null})})})
  const roleHandler=createRoleHandler(owner,async()=>{const {pool,identity,plans}=await autoDreamPlans();return new RoleService(pool,identity,{plans})},async ids=>(await resources.database()).service.checkFullTextBudget(await resources.human(),ids,'role'))
  // 群聊提交前密钥闸（规格 §6）：只拒不改，检测出错按拒收；消息不落库、不派发。缺凭据提供方只跳过已存值比对。
  // 群处理器内一道（IM 经 teloaWork.invoke 直达）；浏览器经 /teloa 的写命令在待恢复登记之前再过一道（invokeTeloaEndpoint）。
  // 已存值来源与群聊闸、会话发表评价闸共用
  const storedSecrets=storedSecretSource(()=>ctx.credentials,message=>ctx.logger.warn(message))
  const groupSecretGate=groupMessageSecretGate(storedSecrets)
  // 群协作的十三个读写口不在同一个服务上：既有十个仍是 CollaborationService，表情两个与路由决策一个
  // 各有自己的表与服务，在这里折成一个提供方，分发仍只有 groupHandler 一处。
  const groupHandler=createGroupHandler(owner,async()=>{
    const {pool}=await resources.database(),identity={id:randomUUID,now:()=>new Date().toISOString()}
    const collaboration=new CollaborationService(pool,identity),reactions=new GroupReactionService(pool,{now:identity.now}),routing=new GroupRoutingDecisionService(pool,{now:identity.now})
    return {
      list:(actor,input)=>collaboration.list(actor,input),get:(actor,input)=>collaboration.get(actor,input),create:(actor,input)=>collaboration.create(actor,input),change:(actor,input)=>collaboration.change(actor,input),
      messages:(actor,input)=>collaboration.messages(actor,input),
      // 本人发的每一条群消息落库之后同样过一次路由；fire-and-forget，路由不可用不能让群说不了话。
      send:async(actor,input)=>{
        const message=await collaboration.send(actor,input)
        void runtimeAdmission.defer(()=>dispatchGroupRouting(ctx,actor,message.id,groupRoutingDispatchPorts,new AbortController().signal)).catch(error=>ctx.logger.warn('Teloa 群内路由未完成：%s',codeOf(error,'teloa/dependency-unavailable')))
        return message
      },
      resources:(actor,input)=>collaboration.resources(actor,input),resource:(actor,input)=>collaboration.resource(actor,input),saveResource:(actor,input)=>collaboration.saveResource(actor,input),withdrawResource:(actor,input)=>collaboration.withdrawResource(actor,input),
      reactions:(actor,input)=>reactions.list(actor,input),toggleReaction:(actor,input)=>reactions.toggle(actor,input),routing:(actor,input)=>routing.list(actor,input),
    }
  },groupSecretGate)
  const groupAgentGrantHandler=createGroupAgentGrantHandler(owner,async()=>new GroupAgentGrantService((await resources.database()).pool,()=>new Date().toISOString()))
  const groupTaskHandler=createGroupTaskHandler(owner,async()=>{const pool=(await resources.database()).pool,identity={id:randomUUID,now:()=>new Date().toISOString()};return new GroupTaskService(pool,identity,new TaskService(pool,identity))})
  // 「谁该回」路由的全部端口。建任务与一键 prepare/start 复用既有分发口（`plan-dispatch-dsh.ts:8,30` 同一条路），
  // 话题锁与决策行归 GroupRoutingDecisionService；宿主这里不另起第二条编排、不自己解析正文里的 @。
  const groupRoutingDispatchPorts:GroupRoutingDispatchPorts={
    decisions:new GroupRoutingDecisionService(database.pool,{now:()=>new Date().toISOString()}),
    group:readRoutingGroup,
    message:async(actor,messageId)=>readRoutingMessage(actor,messageId,(await resources.database()).pool),
    candidates:readRoutingCandidates,
    topic:readRoutingTopic,
    // 三个写端口都再核一次本人：这三条路由绕开了浏览器 RPC 的 owner 固定，身份只能在这里自证。
    createTask:async(actor,input)=>{
      if(actor!==owner)throw new WorkError('teloa/forbidden','群内路由建任务不属于当前本人。')
      const created=await groupTaskHandler('groups/tasks/create',input)
      if(!created||!('task' in created))throw new WorkError('teloa/invalid-host-response','群消息任务回包格式不正确。')
      return {taskId:created.task.id}
    },
    prepare:async(actor,input,signal)=>{
      if(actor!==owner)throw new WorkError('teloa/forbidden','群内路由准备执行不属于当前本人。')
      const run=await taskRunHandler('task-runs/prepare',input,signal)
      if(Array.isArray(run))throw new WorkError('teloa/invalid-host-response','运行准备回包格式不正确。')
      return {runId:run.id}
    },
    start:async(actor,runId,signal)=>{
      if(actor!==owner)throw new WorkError('teloa/forbidden','群内路由启动执行不属于当前本人。')
      const run=await taskRunHandler('task-runs/start',{runId},signal)
      if(Array.isArray(run))throw new WorkError('teloa/invalid-host-response','运行启动回包格式不正确。')
      return {state:run.state}
    },
    sendSystem:async(actor,input)=>({id:(await new CollaborationService((await resources.database()).pool,{id:randomUUID,now:()=>new Date().toISOString()}).send(actor,{requestId:input.requestId,groupId:input.groupId,expectedVersion:input.expectedVersion,rootId:input.rootId,text:input.text})).id}),
    applyReaction:(db,actor,params)=>new GroupReactionService(database.pool,{now:()=>new Date().toISOString()}).applyRole(db,actor,{...params,runId:null}),
  }
  // 运行上下文里的文本类附件要现读正文；只改一个键名走同一处适配，不再写第二份按 kind 的分流。
  // 文件类按 maxBytes 只读前段（文本正文只要前 groupFileTextMaxBytes 字节）；图片仍整张读，交给同一处按 kind 分流的适配。
  const runGroupFilePorts:RunGroupFilePorts={readAttachmentBytes:(file,maxBytes)=>file.kind==='image'?toBackendBytePorts(attachmentPorts).readBytes({attachmentId:file.attachmentId,kind:file.kind,mime:file.mediaType,bytes:file.bytes,name:file.name,width:file.width,height:file.height}):attachmentPorts.readFileBytes({attachmentId:file.attachmentId,name:file.name,bytes:file.bytes},undefined,maxBytes)}
  const groupAttachmentHandler=createGroupAttachmentHandler(owner,async signal=>{
    // 后端服务方法不收 signal，取消只能沿字节端口下传：因此字节端口按每次 RPC 现折一份。
    const service=new GroupAttachmentService((await resources.database()).pool,{id:randomUUID,now:()=>new Date().toISOString()},toBackendBytePorts(attachmentPorts,signal))
    return {upload:(actor,input)=>service.upload(actor,input),list:(actor,input)=>service.list(actor,input),read:(actor,input)=>service.read(actor,input),withdraw:(actor,input)=>service.withdraw(actor,input)}
  })
  const hostTimezone=Intl.DateTimeFormat().resolvedOptions().timeZone
  const workLinks=new ObjectConversationService(database.pool,(actor,id)=>service.bySession(actor,id),()=>new Date().toISOString())
  registerRoleConversationContext(ctx,{
    owner,
    conversation:sessionId=>service.bySession(owner,sessionId),
    requestedRoleId:sessionId=>service.requestedRoleId(owner,sessionId),
    links:sessionId=>workLinks.bySession(owner,{sessionId}),
    role:roleId=>new RoleService(database.pool,{id:randomUUID,now:()=>new Date().toISOString()}).get(owner,roleId),
  })
  const isTaskConversation=async(sessionId:string)=>{
   if(!(await workLinks.bySession(owner,{sessionId})).some(link=>link.kind==='task'))return false
   return !(await database.pool.query('select 1 from teloa_conversation_work_requests where owner_id=$1 and session_id=$2 limit 1',[owner,sessionId])).rowCount
  }
  const conversationWorkEligibility=async(sessionId:string)=>{
   const binding=await service.bySession(owner,sessionId),resolved=await ctx.sessionController.resolveAgent(brandString<SessionId>(sessionId))
   if('error' in resolved)throw new WorkError('teloa/session-unavailable','当前会话尚不可读取。')
   const reason=binding.status!=='ready'?'pending':resolved.agent.session.header.origin==='subagent'?'subagent':await service.isTaskRunReserved(owner,sessionId)?'task-run':(await workLinks.bySession(owner,{sessionId})).some(link=>link.kind==='role')?'role':await isTaskConversation(sessionId)?'task':await isBuilderConversation(sessionId)?'builder':null
   return {sessionId,eligible:reason===null,reason}
  }
  const conversationWork:ConversationWorkService=new ConversationWorkService(database.pool,()=>new Date().toISOString(),async(actor,sessionId)=>{
   const binding=await service.bySession(actor,sessionId),resolved=await ctx.sessionController.resolveAgent(brandString<SessionId>(sessionId))
   if('error' in resolved)throw new WorkError('teloa/session-unavailable','当前会话尚不可读取。')
   if(resolved.agent.session.header.origin==='subagent'||await service.isTaskRunReserved(actor,sessionId)||(await workLinks.bySession(actor,{sessionId})).some(link=>link.kind==='role')||await isTaskConversation(sessionId))throw new WorkError('teloa/forbidden','此会话不能改用本人主会话交办上下文。')
   return {...binding,submitted:readSessionEvents(resolved.agent.session).some(event=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user')}
  },(actor,sessionId)=>businessBindings.prepareWorkGuard(actor,sessionId),async(db,actor)=>['general',...(await new BusinessScopeService(db).list(actor)).map(item=>item.scope).filter(scope=>scope!=='general')],database.dispatchLocks)
  const businessBindings:BusinessConversationBindingService=new BusinessConversationBindingService(database.pool,{id:randomUUID,now:()=>new Date().toISOString()},{drafts:new BusinessConfigurationDraftService(database.pool,{id:randomUUID,now:()=>new Date().toISOString()}),conversations:service,contexts:conversationWork,visibleSessions:async signal=>{const {items}=await ctx.sessionController.list({},signal??new AbortController().signal),archived=new Set(ctx.workspaceRegistry.archivedSessionIds);return items.filter(item=>!archived.has(item.sessionId))}})
  const businessBuilderServices=async()=>{
   const business=await businessDefinitionServices()
   return {...business,preview:business.configurationPreview,bindings:businessBindings}
  }
  // 仅检查真实会话与预约索引；isBuilder 不读取日常 context，避免 inspect 反向递归。
  const isBuilderConversation=async(sessionId:string):Promise<boolean>=>(await businessBuilderServices()).bindings.isBuilder(owner,sessionId)
  const businessBuilderHandler=createBusinessBuilderHandler(owner,businessScopeIds,businessBuilderServices)
  const businessDashboardResourceHandler=createBusinessDashboardResourceHandler(owner,businessScopeIds,async()=>{
   const business=await businessDefinitionServices(),market=new MarketContentStore(business.pool,{id:randomUUID,now:()=>new Date().toISOString()})
   return new BusinessDashboardResourceService(business.pool,{market,drafts:business.drafts,configuration:business.configuration,preview:business.configurationPreview,pages:business.pages})
  })
  const businessResponsibilityHandler=createBusinessResponsibilityHandler(owner,businessScopeIds,businessDefinitionServices)
  const businessBuilderActor=async()=>({ownerId:owner,scopeIds:await businessScopeIds()})
  resources.beforeDatabaseClose(registerBusinessBuilderTools(ctx,{
   owner,conversation:id=>service.bySession(owner,id),readTaskPolicy:async(id,signal)=>{signal.throwIfAborted();return (await runService()).toolPolicy(owner,{sessionId:id})},
   isRoleConversation:async sessionId=>(await workLinks.bySession(owner,{sessionId})).some(link=>link.kind==='role'),isTaskConversation,
   binding:async sessionId=>(await businessBuilderServices()).bindings.bySession(await businessBuilderActor(),{sessionId}),
   draft:async draftId=>(await businessBuilderServices()).drafts.get(await businessBuilderActor(),{draftId}),
   revise:async input=>(await businessBuilderServices()).drafts.revise(await businessBuilderActor(),input),
   upgradeFormat:async input=>(await businessBuilderServices()).drafts.upgradeFormat(await businessBuilderActor(),input),
   reviseReceipt:async input=>(await businessBuilderServices()).drafts.reviseReceipt(await businessBuilderActor(),input),
  }))
  const businessConversationAuthorization:BusinessConversationAuthorizationPorts={
   owner,conversation:id=>service.bySession(owner,id),readTaskPolicy:async(id,signal)=>{signal.throwIfAborted();return (await runService()).toolPolicy(owner,{sessionId:id})},
   isRoleConversation:async sessionId=>(await workLinks.bySession(owner,{sessionId})).some(link=>link.kind==='role'),isTaskConversation,
   binding:async sessionId=>businessBindings.bySession(await businessBuilderActor(),{sessionId}),
   context:sessionId=>conversationWork.context(owner,{sessionId}),
   scopes:async()=>(await new BusinessScopeService((await resources.database()).pool).list(owner)).filter(item=>item.scope!=='general').map(({scope,title})=>({scope,title})),
  }
  const stopBusinessResponsibilityTools=registerBusinessResponsibilityTools(ctx,{
   ...businessConversationAuthorization,
   roles:async actor=>{if(actor!==owner)throw new WorkError('teloa/forbidden','员工目录不属于当前本人。');const {pool,identity,plans}=await autoDreamPlans();return new RoleService(pool,identity,{plans}).list(owner,{})},
   responsibility:{read:async(actor,input)=>(await businessDefinitionServices()).responsibility.read(actor,input),set:async(actor,input)=>(await businessDefinitionServices()).responsibility.set(actor,input),receipt:async(actor,input)=>(await businessDefinitionServices()).responsibility.receipt(actor,input)},
  })
  resources.beforeDatabaseClose(()=>{stopBusinessResponsibilityTools()})
  resources.beforeDatabaseClose(registerBusinessRecordTools(ctx,{
   ...businessConversationAuthorization,
   definitions:async(actor,scope)=>{
    // 即时授权在checkout前完成；审批不持连接，定义只从已采用来源读取。
    if(actor.ownerId!==owner||actor.scopeIds.length!==1||actor.scopeIds[0]!==scope||!(await businessScopeIds()).includes(scope))throw new WorkError('teloa/forbidden','当前本人未获准读取该业务的记录定义。')
    const {pool,definitions}=await businessDefinitionServices(),db=await pool.connect()
    try{await db.query('begin isolation level repeatable read read only');const result=await definitions.forScopeVersioned(db,owner,scope);await db.query('commit');return result}
    catch(error){await db.query('rollback');throw error}finally{db.release()}
   },
   records:{
    list:async(actor,input)=>(await businessDefinitionServices()).records.list(actor,input),
    get:async(actor,input)=>(await businessDefinitionServices()).records.get(actor,input),
    batch:async(actor,input,source)=>(await businessDefinitionServices()).records.batch(actor,input,source),
    batchReceipt:async(actor,input)=>(await businessDefinitionServices()).records.batchReceipt(actor,input),
    recentBatches:async(actor,input)=>(await businessDefinitionServices()).records.recentBatches(actor,input),
   },
  }))
  resources.beforeDatabaseClose(registerBusinessImportTools(ctx,{
   ...businessConversationAuthorization,
   imports:{
    get:async(actor,input)=>(await businessDefinitionServices()).imports.get(actor,input),
    receipt:async(actor,input)=>(await businessDefinitionServices()).imports.receipt(actor,input),
    apply:async(actor,input,signal)=>(await businessDefinitionServices()).imports.apply(actor,input,signal),
   },
  }))
  const businessWorkSelection=async(scope:string)=>{
   if(!(await businessScopeIds()).includes(scope))throw new WorkError('teloa/forbidden','当前本人无权读取此业务。')
   const {pool,store,responsibility}=await businessDefinitionServices(),db=await pool.connect()
   try{
    await db.query('begin isolation level repeatable read')
    const current=await store.currentInTransaction(db,owner,scope)
    const result=current?{title:current.manifest.title,responsibility:await responsibility.readInTransaction(db,{ownerId:owner,scopeIds:[scope]},{scope})}:null
    await db.query('commit');return result
   }catch(error){await db.query('rollback');throw error}finally{db.release()}
  }
  const authorizeWorkResultScopes=async(scopes:readonly string[])=>{
   const current=['general',...await businessScopeIds()]
   if(scopes.some(scope=>!current.includes(scope)))throw new WorkError('teloa/forbidden','当前本人已无权读取交办中的业务结果，原请求保留待核对。')
  }
  const workDispatch=new ConversationWorkDispatch({
   authorize:authorizeWorkResultScopes,
   owner,requests:conversationWork,tasks:new TaskService(database.pool,{id:randomUUID,now:()=>new Date().toISOString()}),
   boundTasks:{
    request:async identity=>{
     const request=await conversationWork.get(owner,{sessionId:identity.sessionId,requestId:identity.requestId})
     if(!request)throw new WorkError('teloa/not-found','原交办不存在。')
     return request.reference?(await businessTaskService()).requestForConversation({ownerId:owner,scopeIds:[...await businessScopeIds()]},identity):new TaskService(database.pool,{id:randomUUID,now:()=>new Date().toISOString()}).requestForConversation(owner,identity)
    },
    create:async identity=>{
     const request=await conversationWork.get(owner,{sessionId:identity.sessionId,requestId:identity.requestId})
     if(!request)throw new WorkError('teloa/not-found','原交办不存在。')
     return request.reference?(await(await businessTaskService()).createForConversation({ownerId:owner,scopeIds:[...await businessScopeIds()]},identity)).task:new TaskService(database.pool,{id:randomUUID,now:()=>new Date().toISOString()}).createForConversation(owner,identity)
    },
   },
   materials:async(requestId,task,references,signal)=>{
    const materials=new TaskMaterialService(database.pool,{id:randomUUID,now:()=>new Date().toISOString()}),existing=await materials.list(owner,{taskId:task.id})
    for(const reference of references){
     signal.throwIfAborted();const previous=existing.find(item=>item.resourceId===reference.id)
     if(previous){if(previous.resourceVersion!==reference.version||!previous.available)throw new WorkError('teloa/version-conflict','原任务资料版本已变化，请核对后继续。');continue}
     task=(await materials.add(owner,{requestId:workRequestChildId(requestId,'material',reference.id),taskId:task.id,expectedTaskVersion:task.version,resourceId:reference.id,expectedResourceVersion:reference.version})).task
    }
    return task
   },
   link:input=>workLinks.change(owner,{requestId:input.requestId,kind:'task',objectId:input.taskId,expectedObjectVersion:input.expectedTaskVersion,sessionId:input.sessionId,expectedLinkVersion:0,action:'link'}),
   runs:async taskId=>(await runService()).list(owner,{taskId}),
   run:async(endpoint,payload,signal,parentIdentity)=>{const value=await taskRunHandler(endpoint,payload,signal,parentIdentity);if(Array.isArray(value))throw new WorkError('teloa/invalid-host-response','本次交办没有返回唯一执行。');return value},
   result:async run=>{const events=await runPorts.events(run);return readTaskRunGroupResult(events.slice(0,run.evidence?.state==='ended'?run.evidence.endSeq+1:0),run.nativeRequestId,await runPorts.continuations?.(run,events))},
   revalidate:async(request,target,signal)=>{
    signal.throwIfAborted()
    const scopes=['general',...await businessScopeIds()]
    if(!scopes.includes(request.scope)||!scopes.includes(target.scope))throw new WorkError('teloa/forbidden','当前本人已无权派发此业务。')
    const {pool,identity,plans}=await autoDreamPlans(),role=(await new RoleService(pool,identity,{plans}).list(owner,{})).find(item=>item.id===target.roleId)
    if(!role||role.ownerId!==owner||role.kind!=='employee'||role.state!=='active'||role.version!==target.roleVersion||!roleSupportsScope(role.scopes,target.scope))throw new WorkError('teloa/version-conflict','原接手员工的状态、版本或业务授权已变化，请先核对原交办。')
    signal.throwIfAborted()
   },
   publish:(status,lockSignal)=>publishConversationWorkStatus(ctx,status,async()=>{lockSignal.throwIfAborted();await conversationWork.get(owner,{sessionId:status.sessionId,requestId:status.requestId});await authorizeWorkResultScopes([status.scope,...status.members.map(member=>member.scope)]);lockSignal.throwIfAborted()},lockSignal),
   report:(requestId,code)=>ctx.logger.warn('Teloa 工作结果待回流：%s（%s）',requestId,code),
   now:()=>new Date().toISOString(),
  })
  deliverConversationWork=()=>runtimeAdmission.run(()=>workDispatch.deliver())
  resources.beforeDatabaseClose(registerConversationWorkTools(ctx,{
   owner,conversation:id=>service.bySession(owner,id),readTaskPolicy:async(id,signal)=>{signal.throwIfAborted();return (await runService()).toolPolicy(owner,{sessionId:id})},
   isRoleConversation:async sessionId=>(await workLinks.bySession(owner,{sessionId})).some(link=>link.kind==='role'),
   isTaskConversation,isBuilder:isBuilderConversation,isPendingDaily:sessionId=>businessBindings.isPendingDaily(owner,sessionId),
   context:sessionId=>conversationWork.context(owner,{sessionId}),freeze:sessionId=>conversationWork.freeze(owner,{sessionId}),
   roles:async()=>{const {pool,identity,plans}=await autoDreamPlans();return new RoleService(pool,identity,{plans}).list(owner,{})},scopes:async()=>['general',...await businessScopeIds()],
   business:businessWorkSelection,reference:async reference=>{await (await businessTaskService()).reference(await businessBuilderActor(),reference)},
   dispatch:(input,signal,revalidate)=>workDispatch.dispatch(input,signal,revalidate),status:(sessionId,requestId)=>requestId===undefined?workDispatch.list(sessionId):workDispatch.status(sessionId,requestId),stop:(sessionId,requestId,signal)=>workDispatch.stop(sessionId,requestId,signal),resume:(sessionId,requestId,signal)=>workDispatch.resume(sessionId,requestId,signal),
   facts:async input=>new WorkFactsService(database.pool,()=>new Date().toISOString()).read({ownerId:owner,scopeIds:['general',...await businessScopeIds()]},input),
   data:(input,signal)=>businessDataHandler('business-data/query',input,signal),now:()=>new Date().toISOString(),
  }))
  registerPlanTools(ctx,{
    owner,conversation:id=>service.bySession(owner,id),
    readTaskPolicy:async(id,signal)=>{signal.throwIfAborted();return (await runService()).toolPolicy(owner,{sessionId:id})},
    planHandler,scheduleHandler:planScheduleHandler,
    roles:{list:async(actor,input)=>{if(actor!==owner)throw new WorkError('teloa/forbidden','员工目录不属于当前本人。');return roleHandler('roles/list',input)}},
    now:()=>new Date().toISOString(),
    timezone:()=>hostTimezone==='Asia/Singapore'||hostTimezone==='Asia/Shanghai'?hostTimezone:'UTC',
  })


  registerIndustryPlanTools(ctx,{
    owner,conversation:id=>service.bySession(owner,id),
    readTaskPolicy:async(id,signal)=>{signal.throwIfAborted();return (await runService()).toolPolicy(owner,{sessionId:id})},
    handler:industryPlansHandler,
    directory:async()=>{
      const [loads,roles]=await Promise.all([industryLoadsHandler('industry-loads/list',{}),industryRolesHandler('industry-roles/list',{})])
      return {items:(loads as IndustryLoadPage).items.flatMap(load=>load.items.filter(item=>item.kind==='plan'&&item.status==='pending-adapter').map(item=>({loadId:load.id,itemInstanceId:item.instanceId,title:item.title,scope:load.space.scope,spaceName:load.space.name,roles:load.relations.filter(link=>link.kind==='role-work'&&link.to===item.instanceId).map(link=>{const instance=(roles as {items:IndustryRoleInstance[]}).items.find(role=>role.loadId===load.id&&role.itemInstanceId===link.from),role=instance?.role;return {itemInstanceId:link.from,name:role?.name??load.items.find(candidate=>candidate.instanceId===link.from)?.title,status:instance?.state??'not-instantiated',...(role?{roleId:role.id,version:role.version}:{}),eligible:!!role&&role.state==='active'&&role.kind==='employee'&&role.scopes.includes(load.space.scope)}})})))}
    },
  })

  registerSkillInstallTools(ctx,{
    owner,conversation:id=>service.bySession(owner,id),
    readTaskPolicy:async(id,signal)=>{signal.throwIfAborted();return (await runService()).toolPolicy(owner,{sessionId:id})},
    handler:skillInstallationsHandler,
    directory:()=>readSkillInstallDirectory({owner,marketContentHandler,industryLoadsHandler,skillInstallationsHandler}),
  })

  // 会话内安装：八个工具全部经既有 handler，不新增端点；连接器条目读口与受管 MCP 同一份目录。
  // 方案一键准备：只经既有 handler 读写；子请求 requestId 由宿主派生（规格 2026-09-26-方案一键准备 §4）。
  const industryPrepareHandler=createIndustryPrepareHandler(owner,async()=>({
    models:industryModelProbe,
    modelTitle:id=>officialCatalogModelEntry(id)?.model.title['zh-CN']??id,
    loads:(endpoint,payload)=>industryLoadsHandler(endpoint,payload),
    knowledge:(endpoint,payload)=>industryKnowledgeHandler(endpoint,payload),
    roles:(endpoint,payload)=>industryRolesHandler(endpoint,payload),
    skills:(endpoint,payload)=>skillInstallationsHandler(endpoint,payload),
    mcp:(endpoint,payload,signal)=>industryMcpConnectionHandler(endpoint,payload,signal),
    dataSources:(endpoint,payload,signal)=>industryDataSourceHandler(endpoint,payload,signal),
    executionTools:(endpoint,payload,signal)=>industryExecutionToolHandler(endpoint,payload,signal),
    plugins:(endpoint,payload,signal)=>industryPluginHandler(endpoint,payload,signal),
    lifecycle:payload=>changeRoleLifecycle(payload),
    audit:entry=>ctx.logger.info('Teloa 方案一键准备：%o',entry),
  }))
  registerMarketSessionTools(ctx,{
    owner,conversation:id=>service.bySession(owner,id),
    readTaskPolicy:async(id,signal)=>{signal.throwIfAborted();return (await runService()).toolPolicy(owner,{sessionId:id})},
    // teloaWork 在 applyHost 末尾 provide；按次读取，IM 通道未装载时没有 IM 会话。
    isImSession:sessionId=>(ctx.get('teloaWork') as TeloaWorkService|undefined)?.imSessions.has(sessionId)??false,
    catalog:marketCatalogHandler,github:githubSourceHandler,content:marketContentHandler,skills:skillInstallationsHandler,mcp:managedMcpConnectionHandler,
    connectorEntry:id=>officialCatalogForMcp.getConnectorEntry(id),
    skillSecrets:id=>officialCatalogForMcp.getSkillSecretsByEntry(id),
    skillSecretMeta:id=>officialCatalogForMcp.getSkillSecretMetaByEntry(id),
    skillSecretGroupMembers:group=>officialCatalogForMcp.skillSecretGroupMembers(group),
    industryLoads:industryLoadsHandler,
    industryPrepare:(endpoint,payload)=>industryPrepareHandler(endpoint,payload,undefined,'session'),
    currentSpace:async()=>await businessSpaceHandler('business-spaces/current',{}) as {id:string;name:string;version:number},
    bundledExtensions:bundledExtensionHandler,
    localModels:localModelsHandler,
  })
  // 技能密钥宿主代发（规格 §5）：端口写法与 registerMarketSessionTools 同源；可见性照 role-skills-dsh.ts:20-25 与 :725-729。
  const skillHttpAuthPorts={owner,conversation:(id:string)=>service.bySession(owner,id),readTaskPolicy:async(id:string,signal:AbortSignal)=>{signal.throwIfAborted();return (await runService()).toolPolicy(owner,{sessionId:id})}}
  // 技能密钥审计一行一条 JSON；工具本体与调用时授权（deny caller）共用这一个出口。
  const skillHttpAudit=(event:SkillHttpAuditEvent)=>ctx.logger.info(JSON.stringify(event))
  registerSkillHttpTool(ctx,{
    skillVisible:(exec,name,signal)=>availabilitySync.stable(async()=>{
      if(!exec.agent)return false
      const selected=await selectedManagedSkill(name)
      if(!selected||selected.availability==='disabled')return false
      const agent=exec.agent,skills=ctx.agentPresets.serviceFor(agent,'skills')??ctx.skills
      // L-6：会话视角下胜出者须是受管选定安装本身；被项目/用户/插件同名技能遮蔽即不可见，不注入。
      return isManagedSkillWinner(await skills.get(name,{cwd:agent.session.header.cwd,scope:agent,signal}),managedFiles.path(selected.installationId))
    }),
    readForUse:name=>skillSecretStore.readForUse(name),
    allow:createSkillRateLimiter(),
    webPolicy:()=>webAccessPolicy(),
    audit:skillHttpAudit,
    // 调用时授权两条放行路径（规格 2026-09-27 §5.2）：本人普通会话（原有路径）；任务执行会话按岗位授权 + 本人逐项勾选的技能 + 运行技能快照 + 当前受管选定安装。
    authorize:createSkillHttpAuthorizer({
      agents:ctx.agents,
      isRouting:isRoutingSession,
      policy:readTaskToolPolicy,
      run:async(sessionId,signal)=>{signal.throwIfAborted();return (await runService()).skillScope(owner,{sessionId})},
      selectedInstallation:async name=>(await selectedManagedSkill(name))?.installationId,
      ordinary:async exec=>{
        const sessionId=await authorizePlanManagement(skillHttpAuthPorts,exec,'技能接口')
        if(!exec.agent||!hasActiveUserInstruction(exec.agent.session))throw new WorkError('teloa/forbidden','当前会话没有可核验的活跃用户指令。')
        return sessionId
      },
      audit:skillHttpAudit,
    }),
    // 非 GET 逐次确认（规格 2026-09-27 §4.6）：权限模式读法与 task-tool-guard.ts 编排工具同式。
    approvalPolicy:exec=>{const approval=ctx.get('approval');return approval&&exec.agent?approval.overrideOf(exec.agent.session)??approval.config.policy??'ask':undefined},
  })
  // 技能加载提示（规格 §6）：skill 工具成功结果后，对已安装且启用、且目录声明了密钥的技能追加一行引导。
  registerSkillSecretHint(ctx,{
    declared:declaredSkillSecrets,
    enabled:async name=>{const client=await(await resources.database()).pool.connect();try{return (await readSkillAvailabilityByName(client,owner,name))?.availability==='enabled'}finally{client.release()}},
    warn:(skill,error)=>ctx.logger.warn(JSON.stringify({event:'skill-secret.hint-skipped',skill,error:error instanceof Error?error.name:'Error'})),
  })
  // 会话内浏览/搜索评价与发表评价（规格 §13）：发表一律原生确认卡，正文过主干贴密钥闸；账号授权仍只在市场页
  registerMarketReviewTools(ctx,{
    owner,conversation:id=>service.bySession(owner,id),
    readTaskPolicy:async(id,signal)=>{signal.throwIfAborted();return (await runService()).toolPolicy(owner,{sessionId:id})},
    reviews:(endpoint,payload)=>marketReviewsHandler(endpoint,payload),
    checkSecrets:texts=>checkPromptSecrets(texts,storedSecrets),
    // IM 发起的会话（私聊与群聊）不能发表：teloaWork 在 applyHost 末尾 provide，按次读取
    isImSession:sessionId=>(ctx.get('teloaWork') as TeloaWorkService|undefined)?.imSessions.has(sessionId)??false,
  })

  registerBusinessDefinitionTools(ctx,{
    owner,conversation:id=>service.bySession(owner,id),
    readTaskPolicy:async(id,signal)=>{signal.throwIfAborted();return (await runService()).toolPolicy(owner,{sessionId:id})},
    // 这个私有写口不在 endpointSet 中；浏览器 RPC 无法将它当作任意模型管理端点使用。
    handler:async(endpoint,payload)=>{
      if(endpoint!=='business-definitions/draft')throw new WorkError('teloa/not-found','未提供此业务声明工具接口。')
      const scopeIds=await businessScopeIds(),{local}=await businessDefinitionServices()
      return local.draft({ownerId:owner,scopeIds},payload as BusinessLocalDraftInput)
    },
    directory:async scope=>{
      if(!(await businessScopeIds()).includes(scope))throw new WorkError('teloa/forbidden','当前主体未获准读取此业务范围。')
      const {pool,definitions}=await businessDefinitionServices(),db=await pool.connect()
      try{
        await db.query('begin isolation level repeatable read read only')
        const bundles=await definitions.forScope(db,owner,scope)
        const result={scope,objectTypes:bundles.flatMap(bundle=>bundle.objectTypes.map(item=>item.definition)),views:bundles.flatMap(bundle=>bundle.views.map(item=>item.definition)),actions:bundles.flatMap(bundle=>bundle.actions.map(item=>item.definition))}
        await db.query('commit')
        return result
      }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
    },
  })
  // AI 员工成果与看板读取工具：任务会话只读看板、试算 SQL、按 role-result 映射记录成果；没有刷新、同步与声明写口。
  registerBusinessResultTools(ctx,{
    owner,conversation:id=>service.bySession(owner,id),
    readTaskPolicy:async(id,signal)=>{signal.throwIfAborted();return (await runService()).toolPolicy(owner,{sessionId:id})},
    readBusinessScope:async(id,signal)=>{signal.throwIfAborted();const pool=(await resources.database()).pool,identity={id:randomUUID,now:()=>new Date().toISOString()};return new BusinessTaskService(pool,identity,new TaskService(pool,identity)).businessSourceScope(owner,id)},
    services:async()=>{const {pool,sync,dashboards,widgets,definitions}=await businessDefinitionServices();return {pool,sync,dashboards,widgets,definitions}},
    scopeIds:businessScopeIds,
  })
  const ordinaryTaskPolicy=async(id:string,signal:AbortSignal)=>{signal.throwIfAborted();return (await runService()).toolPolicy(owner,{sessionId:id})}
  // 端侧中文检索（规格 §7）：公开工具 teloa_knowledge_search、界面端点 retrieval/*、retrieval-model/* 与启动对账。
  // 模型服务只经公开 ctx.reflect 发现（与上面 bundledExtensionLoaded 同一读口）：扩展停用时工具报 dependency-unavailable 并给启用引导，不引入扩展源码。
  // 本人普通会话在模型就绪后默认可用；受管任务按岗位整工具授权（task-tool-guard 清单闸），主体与目标范围沿 readExecutionKnowledge 同一条 taskKnowledgeAuthorization。
  const retrievalPausePath=resolve(runtimeRoot,'retrieval-auto-paused.json')
  const localRetrieval=registerLocalRetrieval(ctx,{
   owner,conversation:id=>service.bySession(owner,id),readTaskPolicy:ordinaryTaskPolicy,
   taskAuthorization:async(sessionId,signal)=>{
    signal.throwIfAborted()
    const runs=await runService(),run=await runs.skillScope(owner,{sessionId})
    if(!run||run.sessionId!==sessionId)throw new WorkError('teloa/forbidden','执行会话身份未就绪。')
    const target=await runs.executionScope(owner,{runId:run.id})
    signal.throwIfAborted()
    return taskKnowledgeAuthorization(owner,target,await readRoleScopes(owner,run.roleId,signal))
   },
   // 本人主体覆盖其全部已登记业务范围（与 resources.ts 的 human() 同一口径）；只供界面端点，模型工具拿不到。
   humanActor:async()=>({ownerId:owner,kind:'human',scopeIds:[...new Set(['general',...await businessScopeIds()])]}),
   retrieval:async()=>(await resources.database()).retrieval,
   embedding:()=>ctx.reflect.get('teloaEmbedding') as EmbeddingServiceLike|undefined,
   admit:work=>runtimeAdmission.run(work),
   log:(level,message)=>{if(level==='warn')ctx.logger.warn('%s',message);else ctx.logger.info('%s',message)},
   // 本人「停止整理」的选择存在运行目录里，跨重启保留；文件存在即表示已停止。
   autoPause:{
    read:async()=>{try{return JSON.parse(await readTextFile(retrievalPausePath,'utf8'))?.paused===true}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}},
    write:async paused=>{if(paused)await writeFile(retrievalPausePath,JSON.stringify({paused:true})+'\n',{mode:0o600});else await rm(retrievalPausePath,{force:true})},
   },
  })
  resources.beforeDatabaseClose(localRetrieval.dispose)
  // 启动对账只在进程内调用（清理失效索引与其他配置的索引），不暴露为 RPC；失败只记告警，不挡装配。
  const retrievalReconcile=runtimeAdmission.run(()=>localRetrieval.reconcile()).catch(error=>ctx.logger.warn('Teloa 本地检索启动对账未完成：%s',codeOf(error,'teloa/dependency-unavailable')))
  resources.beforeDatabaseClose(()=>retrievalReconcile)
  // 内置技能创建器：字节来自随发行固定的官方目录快照，只登记到本人普通会话；准备失败时技能草案一律拒绝，不静默退回。
  let skillCreator:BuiltinSkillCreator|null=null
  try{
   const builtin=officialCatalogBuiltin(builtinSkillCreatorName)
   skillCreator=await prepareBuiltinSkillCreator(ctx,{runtimeRoot,treeHash:builtin.treeHash,files:builtin.files})
   registerBuiltinSkillCreator(ctx,skillCreator,{owner,conversation:id=>service.bySession(owner,id),readTaskPolicy:ordinaryTaskPolicy})
  }catch(error){ctx.logger.error('Teloa 内置技能创建器不可用，技能草案将被拒绝：%o',error)}
  // 内置「看板设计」技能：同一套物化与登记，只到本人普通会话；准备失败只记日志，业务声明草案工具照常可用。
  try{
   const builtin=officialCatalogBuiltin(builtinDashboardDesignerName)
   registerBuiltinSkill(ctx,await prepareBuiltinSkill(ctx,{name:builtinDashboardDesignerName,runtimeRoot,treeHash:builtin.treeHash,files:builtin.files}),{owner,conversation:id=>service.bySession(owner,id),readTaskPolicy:ordinaryTaskPolicy})
  }catch(error){ctx.logger.error('Teloa 内置看板设计技能不可用：%o',error)}
  registerPageCreateTools(ctx,{
   owner,conversation:id=>service.bySession(owner,id),skillCreator,
   readTaskPolicy:ordinaryTaskPolicy,
   directory:async input=>{
    const scopes=[...await businessScopeIds()]
    // 新的一类业务的范围键在加载后才登记（0df1b3a 后端同一口径）：这一实体读目录只回已登记清单并标明该键是否已被占用，不按「已获准范围」拦。
    if(input.entity==='business-domain')return {entity:input.entity,scopes,...(input.scope===undefined?{}:{exists:scopes.includes(input.scope)})}
    if(input.scope!==undefined&&!scopes.includes(input.scope))throw new WorkError('teloa/forbidden','当前主体未获准读取此业务范围。')
    // 这个目录只提供模型生成草案前所需的身份与名称，不拿对象内容、草案正文或授权状态去凑“上下文”。
    if(input.entity==='business-definition')return {entity:input.entity,scopes}
    if(input.entity==='role'){
     const rows=await roleHandler('roles/list',{})
     if(!Array.isArray(rows)||rows.some(row=>typeof row!=='object'||row===null||typeof (row as {id?:unknown}).id!=='string'||typeof (row as {name?:unknown}).name!=='string'||typeof (row as {kind?:unknown}).kind!=='string'))throw new WorkError('teloa/invalid-host-response','员工目录返回格式不正确。')
     return {entity:input.entity,roles:rows.map(row=>{const value=row as {id:string;name:string;kind:string};return {id:value.id,name:value.name,kind:value.kind}})}
    }
    if(input.entity==='skill'){
     const directory=await readSkillInstallDirectory({owner,marketContentHandler,industryLoadsHandler,skillInstallationsHandler})
     return {entity:input.entity,skills:[...directory.atomic.map(item=>({id:item.source.contentId,title:item.title,version:item.version,source:'atomic'})),...directory.industry.map(item=>({id:item.source.itemInstanceId,title:item.title,version:item.version,source:'industry',scope:item.space.name}))]}
    }
    if(input.entity==='connector'){
     const loads=await industryLoadsHandler('industry-loads/list',{}) as IndustryLoadPage
     return {entity:input.entity,scopes,connectors:loads.items.flatMap(load=>load.items.filter(item=>item.kind==='data-source'||item.kind==='mcp').map(item=>({loadId:load.id,instanceId:item.instanceId,kind:item.kind,title:item.title,version:item.version,status:item.status,scope:load.space.scope})))}
    }
    return {entity:input.entity,extensions:officialExtensionPackages.map(item=>({packageName:item.packageName,version:item.version,keywords:[...item.keywords]}))}
   },
   draft:async input=>{
    const scopeIds=await businessScopeIds(),{drafts}=await pageCreateServices()
    return drafts.draft({ownerId:owner,scopeIds:[...scopeIds]},input)
   },
  })

  const readCapabilities=async(sessionId:string,signal?:AbortSignal):Promise<CapabilitySnapshot>=>{
    const conversation=await service.bySession(owner,sessionId)
    const resolved=await ctx.sessionController.resolveAgent(brandString<SessionId>(sessionId))
    if('error' in resolved)throw new WorkError('teloa/session-unavailable','原生会话尚不可用，无法读取当前能力。')
    const {agent}=resolved
    const skills=ctx.agentPresets.serviceFor(agent,'skills')??ctx.skills
    const catalog=await skills.list({cwd:agent.session.header.cwd,scope:agent,signal})
    const tools=ctx.agentPresets.serviceFor(agent,'tools')??ctx.tools
    const mcpTools=tools.schemas(agent).filter(tool=>tool.name.startsWith('mcp__')).map(tool=>({name:tool.name,description:tool.description}))
    let knowledge:CapabilitySnapshot['knowledge']
    try{knowledge={status:'ready',resources:await resources.candidates(sessionId)}}catch(error){knowledge={status:'unavailable',message:error instanceof WorkError?error.message:'工作资料暂不可用。'}}
    return {
      schema:'teloa.capabilities/v1',conversation,observedAt:new Date().toISOString(),
      // 内置技能创建器只为本人会话服务，不作为可管理、可分配的技能出现在能力目录里。
      skills:catalog.filter(skill=>skill.provider!=='teloa-builtin').map(skill=>({name:skill.name,description:skill.description,source:skill.source,provider:skill.provider,modelInvocable:skill.invocation.modelInvocable,userInvocable:skill.invocation.userInvocable})),
      knowledge,connections:{status:'observed',tools:mcpTools},writes:{status:'draft-only'},
    }
  }
  // Connection 保证请求已认证；本切片只有本地 profile 的一位操作者。
  const connection=Reflect.get(ctx,'connection') as HostConnectionHandle
  const dispatchTeloaEndpoint=async(endpoint:string,payload:unknown,signal:AbortSignal)=>{
    if(!endpointSet.has(endpoint)||endpoint==='requests/pending/list'||endpoint==='requests/pending/recover'||endpoint==='requests/pending/ack')throw new WorkError('teloa/not-found','未提供此工作接口。')
    // 扩展端点（im/*）由 IM 通道插件经 teloaWork.attachExtension 挂接；端点名来自契约，宿主装配期即知。
    // 浏览器经 /teloa 调 im/* 写端点仍走 invokeTeloaEndpoint（reserve pending → dispatch → markResponseReady；im/channels/save 携带凭据原值，不在待恢复白名单，直接派发），
    // 只有 teloaWork.invoke 绕过 pending 登记（评审 H3）。
    const extension=teloaWork.dispatchExtension(endpoint,payload,signal)
    if(extension)return extension
    if((imChannelEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/dependency-unavailable','IM 通道服务未就绪。')
    if((bundledExtensionEndpoints as readonly string[]).includes(endpoint))return bundledExtensionHandler(endpoint,payload)
    if((retrievalEndpoints as readonly string[]).includes(endpoint))return localRetrieval.handle(endpoint,payload,signal)
    if((localModelEndpoints as readonly string[]).includes(endpoint))return localModelsHandler.handle(endpoint,payload,signal)
    if((modelOptionEndpoints as readonly string[]).includes(endpoint))return readDshModelOptions(ctx,payload,signal)
    if(endpoint==='work-context/read')return conversationWork.context(owner,payload)
    if(endpoint==='work-context/set')return conversationWork.setContext(owner,payload)
    if(endpoint==='work-context/eligibility'){const input=taskInput(payload,['sessionId']);return conversationWorkEligibility(input.sessionId as string)}
    if(endpoint==='work-requests/list'){const input=taskInput(payload,['sessionId']);return workDispatch.list(input.sessionId as string)}
    if(endpoint==='work-requests/status'||endpoint==='work-requests/stop'){const input=taskInput(payload,['sessionId','requestId']);return endpoint==='work-requests/status'?workDispatch.status(input.sessionId as string,input.requestId as string):workDispatch.stop(input.sessionId as string,input.requestId as string,signal)}
    if(endpoint==='work-requests/resume'){const input=taskInput(payload,['sessionId','requestId']);return workDispatch.resume(input.sessionId as string,input.requestId as string,signal)}
    return (projectEndpoints as readonly string[]).includes(endpoint)?await projectHandler(endpoint,payload):(securityActionEndpoints as readonly string[]).includes(endpoint)?await securityActionHandler(endpoint,payload,signal):(businessSpaceEndpoints as readonly string[]).includes(endpoint)?await businessSpaceHandler(endpoint,payload):(businessScopeEndpoints as readonly string[]).includes(endpoint)?await businessScopeHandler(endpoint,payload):(businessDataEndpoints as readonly string[]).includes(endpoint)?await businessDataHandler(endpoint,payload,signal):(businessBuilderEndpoints as readonly string[]).includes(endpoint)?await businessBuilderHandler(endpoint,payload,signal):(businessDashboardResourceEndpoints as readonly string[]).includes(endpoint)?await businessDashboardResourceHandler(endpoint,payload,signal):(businessImportEndpoints as readonly string[]).includes(endpoint)?await businessImportHandler(endpoint,payload,signal):(businessResponsibilityEndpoints as readonly string[]).includes(endpoint)?await businessResponsibilityHandler(endpoint,payload,signal):(businessDefinitionEndpoints as readonly string[]).includes(endpoint)?await businessDefinitionHandler(endpoint,payload,signal):(businessDashboardEndpoints as readonly string[]).includes(endpoint)?await businessDashboardHandler(endpoint,payload,signal):(pageCreateDraftEndpoints as readonly string[]).includes(endpoint)?await pageCreateDraftHandler(endpoint,payload,signal):(businessTaskEndpoints as readonly string[]).includes(endpoint)?await businessTaskHandler(endpoint,payload):(githubSourceEndpoints as readonly string[]).includes(endpoint)?await githubSourceHandler(endpoint,payload):(marketPluginInstallationEndpoints as readonly string[]).includes(endpoint)?await marketPluginInstallationHandler(endpoint,payload,signal):(skillUpgradePreviewEndpoints as readonly string[]).includes(endpoint)?await skillUpgradePreviewHandler(endpoint,payload):(skillSelectionEndpoints as readonly string[]).includes(endpoint)?await skillSelectionHandler(endpoint,payload):(skillAvailabilityEndpoints as readonly string[]).includes(endpoint)?await skillAvailabilityHandler(endpoint,payload):(skillInstallationEndpoints as readonly string[]).includes(endpoint)?await skillInstallationsHandler(endpoint,payload):(industryPlanEndpoints as readonly string[]).includes(endpoint)?await industryPlansHandler(endpoint,payload):(industryTaskEndpoints as readonly string[]).includes(endpoint)?await industryTasksHandler(endpoint,payload):(industryRoleEndpoints as readonly string[]).includes(endpoint)?await industryRolesHandler(endpoint,payload):(industryKnowledgeEndpoints as readonly string[]).includes(endpoint)?await industryKnowledgeHandler(endpoint,payload):(industryDataSourceEndpoints as readonly string[]).includes(endpoint)?await industryDataSourceHandler(endpoint,payload,signal):(industryExecutionToolEndpoints as readonly string[]).includes(endpoint)?await industryExecutionToolHandler(endpoint,payload,signal):(industryMcpConnectionEndpoints as readonly string[]).includes(endpoint)?await industryMcpConnectionHandler(endpoint,payload,signal):(managedMcpConnectionEndpoints as readonly string[]).includes(endpoint)?await managedMcpConnectionHandler(endpoint,payload):(connectorEndpoints as readonly string[]).includes(endpoint)?await connectorHandler(endpoint,payload,signal):(industryPluginEndpoints as readonly string[]).includes(endpoint)?await industryPluginHandler(endpoint,payload,signal):(industryPrepareEndpoints as readonly string[]).includes(endpoint)?await industryPrepareHandler(endpoint,payload,signal):(industryLoadEndpoints as readonly string[]).includes(endpoint)?await industryLoadsHandler(endpoint,payload):endpoint==='tasks/attention'?await taskAttentionHandler(payload):(planScheduleEndpoints as readonly string[]).includes(endpoint)?await planScheduleHandler(endpoint,payload):(planEndpoints as readonly string[]).includes(endpoint)?await planHandler(endpoint,payload,signal):(marketContentEndpoints as readonly string[]).includes(endpoint)?await marketContentHandler(endpoint,payload):(marketCatalogEndpoints as readonly string[]).includes(endpoint)?await marketCatalogHandler(endpoint,payload):roleToolGrantEndpoints.includes(endpoint)?await roleGrantHandler(endpoint,payload):(webAccessEndpoints as readonly string[]).includes(endpoint)?await webAccessHandler(endpoint,payload):(groupAgentGrantEndpoints as readonly string[]).includes(endpoint)?await groupAgentGrantHandler(endpoint,payload):(groupTaskEndpoints as readonly string[]).includes(endpoint)?await groupTaskHandler(endpoint,payload):(groupAttachmentEndpoints as readonly string[]).includes(endpoint)?await groupAttachmentHandler(endpoint,payload,signal):(taskMaterialEndpoints as readonly string[]).includes(endpoint)?await taskMaterialHandler(endpoint,payload):taskRunEndpoints.includes(endpoint)?await taskRunHandler(endpoint,payload,signal):(taskRunFlowEndpoints as readonly string[]).includes(endpoint)?await taskRunFlowHandler(endpoint,payload,signal):(endpoint==='tasks/context'||endpoint==='object-conversations/list'||endpoint==='object-conversations/session'||endpoint==='object-conversations/change')?await handleObjectConversations(endpoint,payload):artifactEndpoints.includes(endpoint)?await artifactHandler(endpoint,payload,signal):(handoffEndpoints as readonly string[]).includes(endpoint)?await handleHandoffs(endpoint,payload):endpoint==='roles/lifecycle'?await changeRoleLifecycle(payload):(roleMemoryEndpoints as readonly string[]).includes(endpoint)?await roleMemoryHandler(endpoint,payload):(roleDailyLogEndpoints as readonly string[]).includes(endpoint)?await roleDailyLogHandler(endpoint,payload):taskEndpoints.includes(endpoint)?await taskHandler(endpoint,payload):roleEndpoints.includes(endpoint)?await roleHandler(endpoint,payload):(groupEndpoints as readonly string[]).includes(endpoint)?await groupHandler(endpoint,payload):artifactFileEndpoints.includes(endpoint)?await readArtifactFile(endpoint,payload,signal):resourceEndpoints.includes(endpoint)?await resources.handle(endpoint,payload)
        :endpoint==='conversations/create'?await service.create(owner,payload)
        :endpoint==='conversations/read'?await service.bySession(owner,sessionInput(payload))
        :endpoint==='conversations/ensure'?await service.ensure(owner,payload)
        :endpoint==='conversations/adopt'?await service.adopt(owner,payload)
        :endpoint==='copies/create'?await copies.create(owner,payload)
        :endpoint==='copies/list'?await copies.list(owner,payload)
        :endpoint==='copies/resolve'?await copies.resolve(owner,payload)
        :endpoint==='copies/release'?await copies.release(owner,payload)
        :endpoint==='conversations/list'?await service.list(owner,payload)
        // 首页列的是"默认工作区里能用到什么"，取的目录必须与会话实际的 cwd 一致，否则首页与会话各看一份。
        :endpoint==='capabilities/home-skills'?await readHomeSkills(payload,async()=>withPresetReadScope(ctx.agentPresets,scope=>ctx.skills.list({cwd:workspaceRoot,scope,signal})))
        :await readCapabilities(sessionInput(payload),signal)

  }
  // 上次进程崩溃留下的受管安装临时目录，启动时清扫（失败不影响启动）。
  void sweepManagedPackageStaging(runtimeRoot).catch(()=>ctx.logger.warn('受管安装临时目录清扫失败。'))
  // 受管 MCP 包装在 runtimeRoot/mcp/packages，同一套临时目录命名
  void sweepManagedPackageStaging(resolve(runtimeRoot,'mcp')).catch(()=>ctx.logger.warn('受管安装临时目录清扫失败。'))
  // dispatch 直连 dispatchTeloaEndpoint（评审 H3）；packages.install 按随附 lock 受管安装并逐条核对，返回包目录。
  const teloaWork=createTeloaWorkService({owner,runtimeRoot,dispatch:dispatchTeloaEndpoint,broadcast:notificationBroadcast,install:recipe=>installManagedPackage(runtimeRoot,recipe),attachAllowed:imAttachWindow.allowed})
  // IM 通道以挂接扩展端点为准；本地检索以服务 teloaEmbedding 已提供为准（公开的 ctx.reflect 发现，不引入扩展源码）。
  bundledExtensionLoaded=packageName=>packageName===IM_GATEWAY_PACKAGE?teloaWork.extensionAttached():packageName===LOCAL_EMBEDDING_PACKAGE?ctx.reflect.get('teloaEmbedding')!==undefined:false
  const requestIdOf=(payload:unknown):string=>{
    if(!isRecord(payload)||typeof payload.requestId!=='string')throw new WorkError('teloa/invalid-input','待恢复命令必须带请求身份。')
    return payload.requestId.toLowerCase()
  }
  const deterministicRequestError=new Set(['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict','teloa/source-unavailable'])
  // AI 员工条目建岗不带 requestId：后端按（本人, 条目, 版本）派生幂等身份，重放即回 existing，因此不进待恢复目录。
  const catalogRoleAdd=(endpoint:string,payload:unknown)=>endpoint==='market-catalog/add'&&isRecord(payload)&&payload.kind==='role'
  const invokeTeloaEndpoint=async(endpoint:string,payload:unknown,signal:AbortSignal)=>{
    // 贴密钥闸先于任何持久化：被拒原文不进待恢复表；旧登记或恢复重放的同一请求被拒即删除。
    if(endpoint==='groups/messages/send'&&isRecord(payload)&&typeof payload.text==='string'){
      try{groupSecretGate(payload.text)}
      catch(error){
        if(typeof payload.requestId==='string')await pendingRequests.discard(owner,payload.requestId).catch(()=>{})
        throw error
      }
    }
    if(!isPendingRequestEndpoint(endpoint)||catalogRoleAdd(endpoint,payload))return dispatchTeloaEndpoint(endpoint,payload,signal)
    const requestId=requestIdOf(payload),now=()=>new Date().toISOString()
    await pendingRequests.reserve(owner,endpoint,payload,now())
    try{
      const value=await dispatchTeloaEndpoint(endpoint,payload,signal)
      // 执行成功不代表浏览器收到结果。所有白名单命令都等待收讫确认，
      // 网络丢回包时保留服务端快照；只有已产出成功结果的请求才允许 ack。
      await pendingRequests.markResponseReady(owner,requestId,now())
      return value
    }
    catch(error){
      if(error instanceof WorkError&&deterministicRequestError.has(error.code))await pendingRequests.reject(owner,requestId,error.code,now())
      throw error
    }
  }
  // 群附件上传走 /api 下的专用流式路由（先判长、按本人串行、边读边计数），鉴权与 /teloa 同一个 admit()。
  connection.fetch.register(createGroupAttachmentUploadRoute(groupAttachmentHandler,error=>ctx.logger.warn('Teloa 群附件上传失败：%s',error instanceof Error?(error.stack??error.message):String(error))))
  connection.rpc.handle('/teloa',async(endpoint,payload,signal)=>{
    try {
      // /teloa 的 HTTP 桥会先把整包请求体缓冲进内存：上传不再从这里进，只认专用路由。
      if(endpoint===groupAttachmentUploadEndpoint)throw new WorkError('teloa/not-found','群附件上传须经专用上传通道。')
      // 只读当前 live Agent 的收尾事实，不恢复冷会话、不从历史失败推断当前浏览器仍被隔离。
      if(endpoint==='session-browser/status'){
       const sessionId=sessionInput(payload)
       await service.bySession(owner,sessionId)
       return {ok:true,value:taskBrowser.sessionState(sessionId)}
      }
      // 凭据存储端点只在本人浏览器连接上分发：不进 endpointSet，dispatchTeloaEndpoint 与 teloaWork.invoke 均不可达。
      if((credentialStoreEndpoints as readonly string[]).includes(endpoint))return {ok:true,value:await credentialStoreHandler(endpoint,payload)}
      // 技能密钥端点同样只在本人浏览器连接上分发，不进 endpointSet（AI 会话工具、IM、CLI 不可达）。
      if((skillSecretEndpoints as readonly string[]).includes(endpoint))return {ok:true,value:await skillSecretStore.handle(endpoint,payload)}
      // 市场评价端点同样只在本人浏览器连接上分发：连接、发表、删除评价不可经 dispatchTeloaEndpoint、teloaWork.invoke（IM/插件）或待恢复重放到达；会话内发表另经原生确认卡。
      if((marketReviewEndpoints as readonly string[]).includes(endpoint))return {ok:true,value:await marketReviewsHandler(endpoint,payload)}
      // 周期规则启用属本人持续授权，只在已认证浏览器连接处理；公共端点和扩展调用均不能到达。
      if(endpoint===businessSyncRuleWriteEndpoint||(businessSyncRuntimeEndpoints as readonly string[]).includes(endpoint))return {ok:true,value:await businessDashboardHandler(endpoint,payload,signal)}
      if(!endpointSet.has(endpoint))throw new WorkError('teloa/not-found','未提供此工作接口。')
      const value=endpoint==='requests/pending/list'?await pendingRequests.list(owner):endpoint==='requests/pending/ack'?await (async()=>{
        if(!isRecord(payload)||typeof payload.requestId!=='string'||Object.keys(payload).some(key=>key!=='requestId'))throw new WorkError('teloa/invalid-input','确认待核对请求只能提交请求身份。')
        await pendingRequests.acknowledge(owner,payload.requestId,new Date().toISOString())
        return {requestId:payload.requestId.toLowerCase()}
      })():endpoint==='requests/pending/recover'?await (async()=>{
        if(!isRecord(payload)||typeof payload.requestId!=='string'||Object.keys(payload).some(key=>key!=='requestId'))throw new WorkError('teloa/invalid-input','恢复待核对请求只能提交请求身份。')
        const request=await pendingRequests.readForRecovery(owner,payload.requestId)
        const value=await invokeTeloaEndpoint(request.endpoint,request.payload,signal)
        await pendingRequests.markResponseReady(owner,request.requestId,new Date().toISOString())
        return value
      })():await invokeTeloaEndpoint(endpoint,payload,signal)
      return {ok:true,value,...(isPendingRequestEndpoint(endpoint)&&!catalogRoleAdd(endpoint,payload)?{receipt:{requestId:requestIdOf(payload).toLowerCase()}}:{})}
    }catch(error){
      const cause=error instanceof Error?(error.stack??error.message):String(error)
      ctx.logger.warn('Teloa 公共会话请求失败：%s（%s）',endpoint,cause)
      // 结构化附加事实（例如卸载阻塞项）原样回传：只有 WorkError 才可能带，其余一律为空。
      return {ok:false,error:{code:error instanceof WorkError?error.code:'teloa/host-unavailable',message:error instanceof WorkError?error.message:'工作服务暂不可用，请重试；详细原因已记录在宿主日志。',details:error instanceof WorkError&&error.details?error.details:{}}}
    }
  })
  ctx.tools.register(defineTool({
    name:'teloa_capabilities',
    description:'查询当前 Teloa 工作会话的已绑定范围、DSH 实际技能与 MCP 工具目录。只读，注册不等于连接健康或本轮已使用，不提供安装、授权或写操作。',
    parameters:{},
    output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
    execute:async(_args,exec)=>{
      if(!exec.agent)throw new WorkError('teloa/not-bound','能力查询需要真实 Agent 会话上下文。')
      return JSON.stringify(await readCapabilities(exec.agent.session.id,exec.signal))
    },
  }))
  ctx.provide('teloaWork',teloaWork)
}
