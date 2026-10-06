import {createDashboardMarketJournal} from './business-dashboard-market-journal.js'
import {createBusinessDashboardResourceApi} from './business-dashboard-resource-api.js'
import {insertBusinessRecordInput} from './business-record-input.js'
import {businessRecordReferenceSource} from './business-record-reference-source.js'
import type {BusinessObjectReference} from '@teloa/contract'
import {BusinessBuilderController,readBuilderSwitchSnapshot,watchBusinessBuilderRevisions} from './business-builder-controller.js'
import {retainNativeInputs} from './native-input-retention.js'
import {createBusinessBuilderApi} from './business-builder-api.js'
import {createBusinessResponsibilityApi} from './business-responsibility-api.js'
import {createBusinessTaskListApi} from './business-task-list-api.js'
import {createBusinessSetupReader,createGenerationGuardedCall} from './business-setup-navigation.js'
import {createManagedMcpConnectionApi} from './mcp-connections-api.js'
import {createBusinessRecordApi} from './business-record-api.js'
import {createBusinessImportFlowFactory} from './business-import-integration.js'
import {createLocalRetrievalApi} from './local-retrieval-api.js'
import {createLocalModelsApi,createLocalModelsFocus} from './local-models-api.js'
import {HomeWorkRequestCard} from './HomeWorkRequestCard.js'
import {HomeWorkRequestsDock} from './HomeWorkRequestsDock.js'
import {HomeSubmissionJournal,isDeterministicPromptRejection,type HomeSubmissionMonitor} from './home-native-submission.js'
import {HomeSubmissionNotice} from './HomeSubmissionNotice.js'
import {homeNativeCopy} from './home-native-copy.js'
import {insertHomeCapabilities} from './home-native-capabilities.js'
import type {CapabilitySelection} from './Capabilities.js'
import {HomeNativeConversation} from './HomeNativeConversation.js'
import {HomeComposerContext} from './HomeComposerContext.js'
import {HomeNativeController,createHomeContextApi} from './home-native-controller.js'
import {readHomeNativeBlank} from './home-native-readiness.js'
import {createInitialNativeSessionCoordinator} from './initial-native-session.js'
import {SessionBrowserStopNotice} from './SessionBrowserStopNotice.js'
import {createSessionBrowserStopReader,sessionBrowserStopBindingReady} from './session-browser-stop.js'
import {createRuntimeSettingsSurface} from './runtime-settings-surface.js'
import {createSettingsNavigation} from './settings-navigation.js'
import {createWorkbenchLayout} from './workbench-layout.js'
import {createRuntimeExtensionReader} from './runtime-extensions.js'
import {createPendingReceiptRpc} from './pending-receipt-rpc.js'
import {createSecurityActionApi,securityActionCommands} from './security-action-api.js'
import {createSkillUpgradeApi} from './skill-upgrade-api.js'
import {createSkillAvailabilityApi} from './skill-availability-api.js'
import {createPlanApi} from './plan-api.js'
import {createMarketContentApi} from './market-content-api.js'
import {createGithubSourceApi} from './github-source-api.js'
import {createMarketCatalogApi} from './market-catalog-api.js'
import type {MarketCatalogApi} from './market-catalog-api.js'
import {createMarketReviewsApi} from './market-reviews-api.js'
import {createIndustryLoadApi} from './industry-load-api.js'
import {createIndustryKnowledgeApi} from './industry-knowledge-api.js'
import {createIndustryDataSourceApi} from './industry-data-source-api.js'
import {createIndustryExecutionToolApi} from './industry-execution-tool-api.js'
import {createIndustryMcpConnectionApi} from './industry-mcp-connection-api.js'
import {createIndustryPluginApi} from './industry-plugin-api.js'
import {createIndustryRoleApi} from './industry-role-api.js'
import {createIndustryTaskApi} from './industry-task-api.js'
import {createIndustryPlanApi} from './industry-plan-api.js'
import {createSkillInstallApi} from './skill-install-api.js'
import {createMarketPluginInstallApi} from './market-plugin-install-api.js'
import {readSavedPlan} from './plan-api.js'
import {createRoleToolGrantApi} from './role-tool-grant-api.js'
import {createWebAccessApi} from './web-access-api.js'
import {createTaskRunApi} from './task-run-api.js'
import {createTaskMaterialApi} from './task-material-api.js'
import {createObjectConversationApi} from './object-conversation-api.js'
import {createHandoffApi} from './handoff-api.js'
import {createRoleLifecycleApi} from './role-lifecycle-api.js'
import {createRoleMemoryApi} from './role-memory-api.js'
import {createRoleDailyLogApi} from './role-daily-log-api.js'
import {createTaskTransitionApi} from './task-transition-api.js'
import {createPendingRequestApi} from './pending-request-api.js'
import {createTaskApi} from './task-api.js'
import {createProjectApi} from './project-api.js'
import { nativePreparedInput } from './native-prepared-input.js'
import { RoleConversationIdentity } from './RoleConversationIdentity.js'
import {readSessionRoleIdentity} from './session-role-identity.js'
import { isCopyAttempt } from './copy-recovery.js'
import { SettingsBrand } from './SettingsBrand.js'
import brandMark from '../brand/teloa-mark.svg'
import { installSettingsShell } from './settings-integration.js'
import { AboutSettings } from './AboutSettings.js'
import { installTeloaFeedback } from './TeloaFeedbackIntegration.js'
import { PersonalProfileSettings } from './PersonalProfileSettings.js'
import {CredentialStoreSettings} from './CredentialStoreSettings.js'
import {createCredentialStoreApi} from './credential-store-api.js'
import {createSkillSecretsApi} from './skill-secrets-api.js'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { installConversationBrand } from './conversation-brand.js'
import { ConversationBrand } from './ConversationBrand.js'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {mainSessionSource,isNativeChildSession,observeMainSessionBinding} from './main-session.js'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { isConversation, isCapabilitySnapshot, isSkillCatalog } from '@teloa/contract'
import { BindingClient } from './binding-client.js'
import { ConversationManagement, ForkRejectedError, managementAvailability } from './conversation-management.js'
import {followConversationDirectory} from './conversation-directory-follow.js'
import { ConversationSearch } from './conversation-search.js'
import type { IWorkspaces, WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { BindingStatus, Capabilities, CapabilitiesToolCard } from './Capabilities.js'
import { WorkbenchFrame, WorkbenchSidebar } from './WorkbenchFrame.js'
import {AutoDreamSettingsPage,createAutoDreamSettingApi} from './AutoDreamSettingsPage.js'
import {createAutoDreamRecentApi} from './auto-dream-recent-api.js'
import { createJournalStorage } from './journal-storage.js'
import { createWorkbenchStore, type WorkbenchActions } from './store.js'
import { ThemePresenter } from './theme-presenter.js'
import { createRoleApi } from './role-api.js'
import { createRoleRuntimeConfigApi } from './role-runtime-config.js'
import { createGroupApi } from './group-api.js'
import {createImChannelsApi} from './im-channels-api.js'
import {createBundledExtensionsApi} from './bundled-extensions-api.js'
import { createGroupAttachmentApi } from './group-attachment-api.js'
import { createGroupReactionApi } from './group-reaction-api.js'
import { createGroupRoutingApi } from './group-routing-api.js'
import { createBusinessLedgerApi } from './business-ledger-api.js'
import { createBusinessDashboardApi } from './business-dashboard-api.js'
import { createBusinessCustomizationApi,readBusinessDefinitionPreview } from './business-customization-api.js'
import { createConnectorProbeApi } from './connector-probe-api.js'
import { createBusinessSpaceApi } from './business-space-api.js'
import { createBusinessScopeApi } from './business-scope-api.js'
import { configureEdition, createEditionApi } from './edition.js'
import {applicationPresentation} from './application-presentation.js'
import {createSessionCapabilityPresentation} from './session-capability-presentation.js'
import {SessionCapabilityNotice} from './SessionCapabilityNotice.js'
import {createBusinessTaskApi} from './business-task-api.js'
import {createPageCreateApi} from './page-create-api.js'
import {readPageCreateAtomicSkillBody} from './page-create-skill-content.js'
import { createResourceApi } from './resource-api.js'
import { resourceSource } from './resource-source.js'
import { ResourceDraftCard } from './ResourceManager.js'
import {KnowledgeSaveReceiptCard} from './KnowledgeSaveReceiptCard.js'
import { ResourceRecovery } from './ResourceRecovery.js'
import { ResourceHistory } from './ResourceHistory.js'
import { PromptPreparation } from './prompt-preparation.js'
import { PreparedPromptCard } from './PreparedPromptCard.js'
import { createNativeArtifactApi } from './native-artifact-api.js'
import {createArtifactApi} from './artifact-api.js'
import { createArtifactFileApi } from './artifact-files.js'
import { unwrapWorkRpcResult } from './work-rpc-result.js'
import {ProducedFileCards} from './ProducedFileCards.js'
import {previewProducedFileNatively} from './produced-file-preview.js'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import {WORK_CONTEXT_INJECT,requireSidebarRight} from './sidebar-right-service.js'
import {TELOA_RAIL_KINDS,TELOA_TAB_IDS,teloaTabDefinition,type TeloaRailKind,type TeloaTabSecondaryView} from './sidebar-right-tabs.js'
import {teloaTabHost} from './sidebar-right-tab-host.js'
import {SidebarRightTabBody} from './SidebarRightTabBody.js'
import {SidebarRightTabTitle} from './SidebarRightTabTitle.js'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import {createElement, type ComponentProps} from 'react'
import {installTeloaI18n, type TeloaI18n} from './i18n/index.js'
import {I18nProvider} from './i18n/provider.js'
import {attachWorkbenchNavigationPersistence,loadWorkbenchNavigationState,writeDirectoryFilterCategory} from './workbench-navigation-state.js'
import {createWorkbenchNavigationStorage} from './workbench-navigation-storage.js'

/** 已迁入原生右栏的页类型各自的页签标题词条。 */
const RAIL_TAB_TITLE_KEYS:Readonly<Record<TeloaRailKind,'sidebarRight.tab.task'|'sidebarRight.tab.role'|'sidebarRight.tab.business'>>=
  {'teloa.task':'sidebarRight.tab.task','teloa.role':'sidebarRight.tab.role','teloa.business':'sidebarRight.tab.business'}

declare module '@deepseek-ai/dsh-client-ui-slots'{interface SlotMap{'teloa.workbench.toolbar':{kind:'list';scope:'root'}}}

export const name = 'teloa-ui-workbench'
export const inject = ['slots','theme','connection','locale','remote','remote.pluginManager','remote.agentPresets','uiSession']

export async function apply(ctx: Context): Promise<void> {
  const releasePresentation=await applicationPresentation.configure(window.teloaApplication)
  ctx.effect(()=>releasePresentation)
  const navigationStorage=createWorkbenchNavigationStorage(applicationPresentation.getNavigationStorageScope(),window)
  ctx.effect(()=>{
    const original=Array.from(document.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'))
    const snapshots=original.map(link=>({link,href:link.getAttribute('href'),type:link.getAttribute('type'),sizes:link.getAttribute('sizes')}))
    const icons=original.length?original:[document.head.appendChild(document.createElement('link'))]
    for(const icon of icons){icon.rel='icon';icon.href=brandMark;icon.type='image/svg+xml';icon.setAttribute('sizes','any')}
    return ()=>{
      if(!original.length){icons[0]?.remove();return}
      for(const {link,...attributes} of snapshots)for(const [key,value] of Object.entries(attributes)){
        if(value===null)link.removeAttribute(key);else link.setAttribute(key,value)
      }
    }
  },'teloa: 浏览器品牌图标')
  let i18n: TeloaI18n|undefined
  ctx.effect(()=>{
    const installed=installTeloaI18n(ctx.locale)
    i18n=installed.runtime
    return ()=>{i18n=undefined;installed.dispose()}
  },'teloa: 产品语言与词典')
  const requireI18n=()=>{
    if(!i18n)throw Error('Teloa 语言底座尚未挂载。')
    return i18n
  }
  const runtimeSettings=createRuntimeSettingsSurface()
  const settingsNavigation=createSettingsNavigation()
  installTeloaFeedback(ctx,requireI18n)
  const runtimeExtensions=createRuntimeExtensionReader(async()=>{
    const [bundles,plugins]=await Promise.all([ctx.remote.pluginManager.listBundles(),ctx.remote.pluginManager.listPlugins()])
    if(!bundles.ok||!plugins.ok)throw Error('运行扩展清单暂时不可用。')
    return {bundles:bundles.value,plugins:plugins.value}
  })
  ctx.effect(()=>{
    const refresh=()=>{if(runtimeExtensions.getSnapshot().status!=='idle')void runtimeExtensions.refresh()}
    const offChanged=ctx.remote.$on('plugin-manager/changed',refresh),offReset=ctx.on('connection/reset',refresh)
    return ()=>{offChanged();offReset();runtimeExtensions.dispose()}
  },'teloa: 运行扩展只读投影')
  let actions: WorkbenchActions|undefined
  const requireActions = () => {
    if (!actions) throw Error('Teloa 外壳尚未挂载，无法操作面板。')
    return actions
  }
  ctx.effect(()=>installConversationBrand(ctx.locale),'teloa: 欢迎文案适配')
  const brandTheme={subscribe:(notify:()=>void)=>ctx.on('theme/change',notify),getSnapshot:()=>ctx.theme.getTheme().active.colorScheme}
  ctx.slots.inject('settings.header',()=>ctx.slots.register({name:'settings.header',priority:-100,inject:()=>({theme:brandTheme})},SettingsBrand))
  ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'teloa-about',order:100,label:()=>requireI18n().t('settings.about'),inject:()=>({theme:brandTheme})},AboutSettings))
  ctx.slots.inject('settings.general.item',()=>ctx.slots.register({name:'settings.general.item',id:'teloa-personal-profile',order:-100},PersonalProfileSettings))
  ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'teloa-auto-dream',order:7,label:()=>requireI18n().t('autoDream.name'),inject:()=>({api:autoDreamSettingApi,recent:autoDreamRecentApi,openRole:(id:string)=>requireActions().openRole(id)})},AutoDreamSettingsPage))
  ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'teloa-credential-store',order:8,label:()=>requireI18n().t('credentialStore.title'),inject:()=>({api:credentialStoreApi})},CredentialStoreSettings))
  ctx.slots.inject('sidebar',()=>ctx.slots.register({
    name:'sidebar',
    children:{
      'sidebar.settings':{kind:'single',scope:'root'},
      // 工作区选择器依赖此公开声明链，会话目录仍由 Teloa 呈现。
      'sidebar.workspaces':{kind:'single',scope:'root'},
      'sidebar.panellist':{kind:'list',scope:'root'},
    },
  },WorkbenchSidebar))
  let workContext:Context|undefined
  const requireWorkContext=()=>{if(!workContext)throw Error('原生会话服务正在连接，请稍后重试。');return workContext}
  const initialSessionLifetime=new AbortController()
  let resolveInitialContext!:()=>void,rejectInitialContext!:(error:unknown)=>void
  const initialContext=new Promise<void>((resolve,reject)=>{resolveInitialContext=resolve;rejectInitialContext=reject})
  void initialContext.catch(()=>{})
  ctx.effect(()=>()=>{initialSessionLifetime.abort();rejectInitialContext(initialSessionLifetime.signal.reason)},'teloa: 初始原生会话归属')
  // 每次用都重新取右栏控制面，并接受它会抛：右栏插件可能未装、未就绪，或在开页时拒绝。
  const sidebarRightFace=()=>requireSidebarRight(workContext)
  const mainSession=mainSessionSource(ctx.uiSession)
  // 未决请求日志统一走同源共享存储：关掉标签页不再丢记录，多个标签页读到同一个 requestId
  // （规格 §八 G4，键名逐字沿用不新开）。普通 Web 导航仍属于当前标签页；
  // 原生宿主提供本人/安装范围后，导航及首页待用身份可跨窗口恢复。
  const journal=(key:string)=>createJournalStorage(key,localStorage)
  // 根类型检查同时看到 host/client 同名服务；浏览器运行域只取其公开 RPC 调用面。
  const connection=Reflect.get(ctx,'connection') as unknown as ConnectionHandle
  let receiptChanged=()=>{}
  const callWithReceipt=createPendingReceiptRpc((endpoint,payload,signal)=>connection.rpc.call('/teloa',endpoint,payload,signal),()=>receiptChanged())
  const call=async(endpoint:string,payload:unknown,signal?:AbortSignal)=>{
    return unwrapWorkRpcResult(await callWithReceipt(endpoint,payload,signal))
  }
  const securityActionApi=createSecurityActionApi(async(endpoint,payload,signal)=>{const result=await callWithReceipt(endpoint,payload,signal);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},Object.fromEntries(securityActionCommands.map(command=>{const key='teloa.security-action.'+command+'/v1';return [command,journal(key)]})),'local:teloa-owner')
  const taskRunApi=createTaskRunApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.task-run-prepare/v1'))
  const taskMaterialApi=createTaskMaterialApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.task-material-add/v1'))
  // 群命令的结果不明时必须保留原 requestId；服务端未显式声明无副作用，客户端不擅自释放恢复记录。
  const groupApi=createGroupApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code,details:result.error.details});return result.value},journal('teloa.group-command/v1'),undefined,'local:teloa-owner')
  // 群附件四个端点都自带 requestId（上传/撤回由调用方给定并在重试时原样重用），幂等靠后端回执，因此不接恢复记录三件套。
  const groupAttachmentApi=createGroupAttachmentApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},undefined,'local:teloa-owner')
  // 表情 toggle 自带 requestId 幂等重放（同 web-access-api 先例），接恢复记录三件套；路由决策纯只读，不接。
  const groupReactionApi=createGroupReactionApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.group-reaction/v1'))
  const groupRoutingApi=createGroupRoutingApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value})
  // 台账只读：没有请求体要留底，因此不接恢复记录三件套。
  const businessLedgerApi=createBusinessLedgerApi(call)
  // 看板与同步：读侧只读；刷新与立即同步自带 requestId、宿主按它幂等，同样不接恢复记录三件套。
  const businessDashboardApi=createBusinessDashboardApi(call)
  const businessCustomizationApi=createBusinessCustomizationApi(async(endpoint,payload,signal)=>{const result=await callWithReceipt(endpoint,payload,signal);if(!result.ok)throw Object.assign(Error(result.error.message),{code:result.error.code,details:result.error.details});return result.value})
  // 连接器「测试连接」：只读探针，没有待核对的请求体要留底，因此与台账读取同样不接 RecoveryGate 三件套。
  const connectorProbeApi=createConnectorProbeApi(call)
  // 改名自带 requestId，宿主侧幂等；读取空间与范围标签都是只读，不留恢复记录。
  const businessSpaceApi=createBusinessSpaceApi(call)
  const businessScopeApi=createBusinessScopeApi(call)
  // 版本在装配时读一次；读不到按个人版处理，不阻塞界面。
  void configureEdition(createEditionApi(call))
  const businessTaskApi=createBusinessTaskApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.business-task/v1'),'local:teloa-owner')
  const pageCreateApi=createPageCreateApi(async(endpoint,payload,signal)=>{const result=await callWithReceipt(endpoint,payload,signal);if(!result.ok)throw Object.assign(Error(result.error.message),{code:result.error.code});return result.value},{businessPreview:readBusinessDefinitionPreview,skill:readPageCreateAtomicSkillBody})
  const homeContextApi=createHomeContextApi(call,localStorage)
  const isHomeAssistantContext=async(id:string,signal?:AbortSignal)=>{const value=await call('work-context/eligibility',{sessionId:id},signal);if(!value||typeof value!=='object'||!('sessionId'in value)||value.sessionId!==id||!('eligible'in value)||typeof value.eligible!=='boolean')throw Error('会话身份核对失败。');return value.eligible}
  const localRetrievalApi=createLocalRetrievalApi(call)
  const resourceApi=createResourceApi(call)
  const artifactApi=createArtifactApi(call,journal('teloa.artifact-save/v1'))
  const taskTransitions=createTaskTransitionApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.task-transition/v1'))
  const pendingRequestApi=createPendingRequestApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value})
  receiptChanged=pendingRequestApi.notify
  const roleLifecycle=createRoleLifecycleApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.role-lifecycle/v1'))
  const memoryApi=createRoleMemoryApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.role-memory-command/v1'))
  const planApi=createPlanApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.plan-command/v1'))
  const dailyLogApi=createRoleDailyLogApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.role-daily-log-command/v1'))
  // Auto Dream 的开关与时间以全部 system-digest 计划为载体，复用既有 planApi（plan-api.ts 已在 a035c00 认得
  // system-digest：list()/change()/update() 都有逐字段回执核对与 Journal 恢复，映射逻辑见 createAutoDreamSettingApi）。
  const autoDreamSettingApi=createAutoDreamSettingApi(planApi)
  // 凭据存储状态与历史明文副本：删除必须由本人在设置页确认；不留恢复记录（删除按清单 id 幂等，结果不明时重读状态即可）。
  const credentialStoreApi=createCredentialStoreApi((endpoint,payload)=>call(endpoint,payload))
  const marketContentApi=createMarketContentApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.market-content-import/v1'),()=>crypto.randomUUID(),journal('teloa.market-import-github/v1'))
  const marketCatalogCall=async(endpoint:string,payload:unknown)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value}
  const marketCatalogApi:MarketCatalogApi={...createMarketCatalogApi(marketCatalogCall),reviews:createMarketReviewsApi(marketCatalogCall)}
  const skillSecretsApi=createSkillSecretsApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value})
  const githubSourceApi=createGithubSourceApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.github-source/v1'))
  // 卸载被在途执行阻断时，宿主的结构化阻塞项随错误一起回传，界面据此列出先要收尾的执行。
  const industryLoadApi=createIndustryLoadApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code,details:result.error.details});return result.value},journal('teloa.industry-load-create/v1'),journal('teloa.industry-load-unload/v1'),journal('teloa.industry-load-upgrade/v1'))
  const industryKnowledgeApi=createIndustryKnowledgeApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.industry-knowledge/v1'))
  const industryDataSourceApi=createIndustryDataSourceApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.industry-data-source-authorize/v1'))
  const industryExecutionToolApi=createIndustryExecutionToolApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.industry-execution-tool-authorize/v1'))
  const industryMcpConnectionApi=createIndustryMcpConnectionApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.industry-mcp-connect/v1'))
  const industryPluginApi=createIndustryPluginApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.industry-plugin-install/v1'))
  const industryRoleApi=createIndustryRoleApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.industry-role/v1'))
  const industryTaskApi=createIndustryTaskApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.industry-task/v1'))
  const industryPlanApi=createIndustryPlanApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.industry-plan/v1'),readSavedPlan)
  const skillInstallApi=createSkillInstallApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.skill-install/v1'))
  const marketPluginInstallApi=createMarketPluginInstallApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.market-plugin-install/v1'))
  const skillUpgradeApi=createSkillUpgradeApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.skill-upgrade/v1'))
  const skillAvailabilityApi=createSkillAvailabilityApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.skill-availability/v1'))
  const roleToolGrantApi=createRoleToolGrantApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.role-tools/v1'))
  const webAccessApi=createWebAccessApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.web-access/v1'))
  // 凭据保存（im/channels/save）不进恢复记录；其余写命令按 requestId 登记待核对，恢复记录只含标识字段。
  const imChannelsApi=createImChannelsApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code,details:result.error.details});return result.value},journal('teloa.im-channels/v1'))
  const bundledExtensionsApi=createBundledExtensionsApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code,details:result.error.details});return result.value})
  // 运行环境中的网页策略要用这份单例：installSettingsShell 调用因此下移到这里，callWithReceipt/journal
  // 都已就绪；ctx.inject 系依赖解析，不受调用先后影响，与它之前紧跟着的其余 slot 注册没有次序依赖。
  const localModelsApi=createLocalModelsApi(call),localModelsFocus=createLocalModelsFocus()
  const openLocalModels=(entryId:string)=>{localModelsFocus.set(entryId);settingsNavigation.select('teloa-local-models');requireActions().openDirectory()}
  installSettingsShell(ctx,{open:()=>requireActions().openDirectory(),close:()=>requireActions().closeSettings(),selection:settingsNavigation},(key,params)=>requireI18n().t(key,params),webAccessApi,runtimeSettings,{api:imChannelsApi,roles:async()=>(await roleApi.list()).map(role=>({id:role.id,name:role.name})),groups:async()=>(await groupApi.list()).items.map(group=>({id:group.id,name:group.name})),extension:{read:async()=>(await bundledExtensionsApi.list()).find(row=>row.id==='im-gateway'),enable:()=>bundledExtensionsApi.set('im-gateway',true),openMarket:()=>{const bound=requireActions();bound.rememberDirectory('market',{category:writeDirectoryFilterCategory({category:'plugin',mobileLayer:'list'})});bound.closeSettings();bound.openMarketCategory('plugin')}}},{api:localModelsApi,focus:localModelsFocus})
  const handoffApi=createHandoffApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.handoff/v1'),journal('teloa.handoff-change/v1'))
  const objectConversationApi=createObjectConversationApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.object-conversation/v1'))
  const taskApi=createTaskApi(call,journal('teloa.task-create/v1'))
  const projectApi=createProjectApi(call,journal('teloa.project-create/v1'))
  const roleApi=createRoleApi(async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code});return result.value},journal('teloa.role-create/v1'))
  const autoDreamRecentApi=createAutoDreamRecentApi({roles:()=>roleApi.list(),dailyLogs:id=>dailyLogApi.list(id)})
  const runtimeConfigApi=createRoleRuntimeConfigApi(async()=>{
    const result=await ctx.remote.agentPresets.list()
    if(!result.ok)throw Error(result.error.message)
    return result.value
  },()=>call('model-options/list',{}))
  const preparation=new PromptPreparation()
  const bindingBlocks=new Map<string,string>(),contextBlocks=new Map<string,string>(),submissionBlocks=new Map<string,string>(),businessBlocks=new Map<string,string>(),capabilityBlocks=new Map<string,string>()
  const sessionCapabilities=createSessionCapabilityPresentation((sessionId,signal)=>call('session-capabilities/read',{sessionId},signal))
  ctx.effect(()=>()=>sessionCapabilities.dispose(),'teloa: 会话能力投影释放')
  const syncComposerBlock=(sessionId:string)=>{
    const reason=businessBlocks.get(sessionId)??bindingBlocks.get(sessionId)??contextBlocks.get(sessionId)??submissionBlocks.get(sessionId)??capabilityBlocks.get(sessionId)
    const blocks=requireWorkContext().conversation.blocks,id=brandString<SessionId>(sessionId)
    if(blocks.storeFor(id).getSnapshot()?.reason!==reason)blocks.set(id,reason?{reason}:undefined)
  }
  const homeContextBlock=(sessionId:string,reason:string|undefined)=>{if(reason)contextBlocks.set(sessionId,reason);else contextBlocks.delete(sessionId);syncComposerBlock(sessionId)}
  const work=new BindingClient({
    list:async signal=>{
      const value=await call('conversations/list',{},signal)
      if(!Array.isArray(value)||!value.every(isConversation))throw Error('工作服务返回的目录格式不正确。')
      return value
    },
    read:async(sessionId)=>{
      const value=await call('conversations/read',{sessionId})
      if(!isConversation(value)||value.sessionId!==sessionId)throw Error('工作服务返回的会话格式不正确。')
      if(sessionCapabilities.getSnapshot().sessionId===sessionId)void sessionCapabilities.refresh()
      return value
    },
    ensure:async(sessionId)=>{
      const value=await call('conversations/ensure',{sessionId})
      if(!isConversation(value))throw Error('工作服务返回的绑定格式不正确。')
      if(sessionCapabilities.getSnapshot().sessionId===sessionId)void sessionCapabilities.refresh()
      return value
    },
    isNativeChild:sessionId=>isNativeChildSession(requireWorkContext().sessions,brandString<SessionId>(sessionId)),
    homeSkills:async signal=>{const value=await call('capabilities/home-skills',{},signal);if(!isSkillCatalog(value))throw Error('首页技能目录格式不正确。');return value},
    catalog:async(sessionId)=>{
      const value=await call('capabilities/read',{sessionId})
      if(!isCapabilitySnapshot(value))throw Error('工作服务返回的能力目录格式不正确。')
      return value
    },
    block:(sessionId,reason)=>{if(reason)bindingBlocks.set(sessionId,reason);else bindingBlocks.delete(sessionId);syncComposerBlock(sessionId)},
    create:async({requestId,title,workspaceId,roleId})=>{
      const value=await call('conversations/create',{requestId,title:title??'新工作会话',...(workspaceId===undefined?{}:{workspaceId}),...(roleId===undefined?{}:{roleId})})
      if(!isConversation(value))throw Error('工作服务返回的创建结果格式不正确。')
      return value
    },
    adopt:(sessionId,workspaceId)=>requireWorkContext().sessions.create({sessionId:brandString<SessionId>(sessionId),...(workspaceId===undefined?{}:{workspaceId:brandString<WorkspaceId>(workspaceId)})}),
    open:sessionId=>requireWorkContext().uiWorkspace.openSession(brandString<SessionId>(sessionId)),
    current:mainSession.getSnapshot,
  })
  ctx.effect(()=>followConversationDirectory({
    state:connection.state,generation:connection.generation,
    watch:(revision,signal)=>call('conversations/watch',revision===undefined?{}:{revision},signal),
    refresh:async signal=>{await work.refreshDirectory(signal);return work.getDirectorySnapshot().status==='ready'},
  }),'teloa: 会话目录失效订阅')
  // 输入恢复 dock 和业务切换共用同一 monitor；只核对原生回执，不重发正文。
  const homeSubmissionMonitors=new Map<string,{monitor:HomeSubmissionMonitor;update:()=>void}>()
  const homeSubmissionMonitor=(sessionId:SessionId):HomeSubmissionMonitor=>{
    const cached=homeSubmissionMonitors.get(sessionId)
    if(cached){cached.update();return cached.monitor}
    const child=requireWorkContext()
    const journal=new HomeSubmissionJournal(localStorage,sessionId)
        const update=()=>{
          const binding=child.sessions.binding(sessionId)
          if(!binding)return
          const snapshot=binding.session.getSnapshot(),input=child.conversation.input.for(binding.ctx).state.getSnapshot()
          const receipts=binding.eventSource.getSnapshot().entries.flatMap(entry=>{
            const event=entry.event
            if(event.type!=='user/message'||event.surfaceOp!=='append'||event.data.source.kind!=='user'||!('rpcId' in event.data.source))return []
            return [event.data.source.rpcId]
          })
          for(const item of input.queue)if(item.source.kind==='user'&&'rpcId' in item.source)receipts.push(item.source.rpcId)
          const failure=snapshot.promptError?.op==='send'?snapshot.promptError.error:undefined
          const rejected=failure!==undefined&&isDeterministicPromptRejection(failure.code)
          journal.observe(snapshot.pendingSubmissions.map(row=>row.requestId),receipts,!rejected&&(failure!==undefined||connectionState.getSnapshot()!=='connected'),rejected)
          if(journal.getSnapshot())submissionBlocks.set(sessionId,homeNativeCopy(requireI18n().getSnapshot().locale,'unknown'));else submissionBlocks.delete(sessionId)
          syncComposerBlock(sessionId)
        }
        const connectionState=(Reflect.get(child,'connection') as unknown as ConnectionHandle).state
        const monitor:HomeSubmissionMonitor={
          getSnapshot:journal.getSnapshot,subscribe:journal.subscribe,
          attach:()=>{
            const binding=child.sessions.binding(sessionId)
            if(!binding)return ()=>{}
            const off=[binding.session.subscribe(update),binding.eventSource.subscribe(update),child.conversation.input.for(binding.ctx).state.subscribe(update),connectionState.subscribe(update)]
            const onStorage=(event:StorageEvent)=>{if(event.key==='teloa.home-submission/'+sessionId)update()}
            window.addEventListener('storage',onStorage)
            update();return()=>{window.removeEventListener('storage',onStorage);for(const dispose of off)dispose()}
          },
          check:async()=>{await Promise.all([child.sessions.refresh(),child.sessions.refreshProjections(sessionId)]);update()},
        }
    homeSubmissionMonitors.set(sessionId,{monitor,update});update();return monitor
  }
  const businessBuilderApi=createBusinessBuilderApi(async(endpoint,payload,signal)=>{
    const result=await callWithReceipt(endpoint,payload,signal)
    if(!result.ok)throw Object.assign(Error(result.error.message),{code:result.error.code,details:result.error.details})
    return result.value
  })
  const businessNativeListeners=new Set<()=>void>()
  const businessBuilder=new BusinessBuilderController({
    api:businessBuilderApi,work,storage:localStorage,id:()=>crypto.randomUUID(),
    identity:async()=>(await businessSpaceApi.current()).id,
    subscribeNative:listener=>{businessNativeListeners.add(listener);return()=>businessNativeListeners.delete(listener)},
    contextCall:async(endpoint,payload)=>{const result=await callWithReceipt(endpoint,payload);if(!result.ok)throw Object.assign(Error(result.error.message),{code:result.error.code,details:result.error.details});return result.value},
    switching:{read:()=>{
      const child=workContext,sessionId=mainSession.getSnapshot(),selected=work.getSnapshot()
      const native=sessionId?child?.sessions.binding(sessionId):undefined
      return readBuilderSwitchSnapshot({connected:connection.state.getSnapshot()==='connected',generationReady:connection.generation.getSnapshot()!==undefined,selectionReady:child?.sessions.list.getSnapshot().phase==='ready',mainSessionId:sessionId,bindingSessionId:selected.sessionId,bindingReady:selected.status==='ready'&&selected.conversation?.sessionId===sessionId,input:native?child!.conversation.input.for(native.ctx).state.getSnapshot():undefined,pendingSubmissions:native?.session.getSnapshot().pendingSubmissions??[],monitor:native?homeSubmissionMonitor(sessionId!):undefined})
    }},
    block:(sessionId,reason)=>{if(reason)businessBlocks.set(sessionId,requireI18n().t(reason==='daily-pending'?'business.daily.bindingPending':reason==='builder-pending'?'business.builder.bindingPending':'business.builder.bindingChecking'));else businessBlocks.delete(sessionId);if(workContext)syncComposerBlock(sessionId)},
    watch:(id,changed)=>{
      const binding=requireWorkContext().sessions.binding(brandString<SessionId>(id))
      if(!binding)return ()=>{}
      return watchBusinessBuilderRevisions(binding.eventSource,changed)
    },
  })
  const createBusinessResponsibility=(namespace:string,token:typeof businessBuilderApi)=>{
    const prefix='teloa.business-builder/v1/personal-space/'
    if(!namespace.startsWith(prefix))throw Error('本人业务空间身份尚未确认。')
    return createBusinessResponsibilityApi(async(endpoint,payload)=>{
      const result=await callWithReceipt(endpoint,payload)
      if(!result.ok)throw Object.assign(Error(result.error.message),{rejected:true,code:result.error.code})
      return result.value
    },{storage:localStorage,personalSpaceId:namespace.slice(prefix.length),isCurrent:()=>{const current=businessBuilder.getSnapshot();return current.status==='ready'&&current.namespace===namespace&&current.api===token}})
  }
  const createBusinessTaskList=(namespace:string,token:typeof businessBuilderApi)=>createBusinessTaskListApi(async(endpoint,payload,signal)=>{
    const current=businessBuilder.getSnapshot()
    if(current.status!=='ready'||current.namespace!==namespace||current.api!==token)throw Error('业务连接已变化。')
    const result=await callWithReceipt(endpoint,payload,signal)
    const latest=businessBuilder.getSnapshot()
    if(latest.status!=='ready'||latest.namespace!==namespace||latest.api!==token)throw Error('业务连接已变化。')
    if(!result.ok)throw Object.assign(Error(result.error.message),{code:result.error.code})
    return result.value
  },'local:teloa-owner')
  const createBusinessDashboardResources=(namespace:string,token:typeof businessBuilderApi)=>createBusinessDashboardResourceApi(createGenerationGuardedCall(()=>connection.state.getSnapshot()==='connected'?connection.generation.getSnapshot():undefined,marketCatalogCall,()=>{const current=businessBuilder.getSnapshot();return current.status==='ready'&&current.namespace===namespace&&current.api===token}),createDashboardMarketJournal(localStorage,namespace))
  const createBusinessMcpConnection=(namespace:string,token:typeof businessBuilderApi)=>createManagedMcpConnectionApi(createGenerationGuardedCall(()=>connection.state.getSnapshot()==='connected'?connection.generation.getSnapshot():undefined,marketCatalogCall,()=>{const current=businessBuilder.getSnapshot();return current.status==='ready'&&current.namespace===namespace&&current.api===token}))
  const createBusinessSetup=(namespace:string,token:typeof businessBuilderApi)=>createBusinessSetupReader({namespace,token,identity:businessBuilder.getSnapshot,generation:()=>connection.state.getSnapshot()==='connected'?connection.generation.getSnapshot():undefined,ports:{responsibility:createBusinessResponsibility(namespace,token),roles:roleApi,resources:resourceApi,skills:signal=>work.readHomeSkills(signal),connections:createBusinessMcpConnection(namespace,token)}})
  const insertBusinessRecord=async(reference:BusinessObjectReference,sessionId:string,token:typeof businessBuilderApi,mayInsert:()=>boolean)=>{
    const identity=businessBuilder.getSnapshot(),child=requireWorkContext(),id=brandString<SessionId>(sessionId),binding=child.sessions.binding(id)
    if(!binding||identity.status!=='ready'||identity.api!==token||identity.sessionKind!=='daily'||identity.checkedSessionId!==sessionId)throw Error('当前业务会话尚未就绪。')
    const input=child.conversation.input.for(binding.ctx)
    const isCurrent=()=>{const now=businessBuilder.getSnapshot();return mayInsert()&&now.status==='ready'&&now.api===token&&now.namespace===identity.namespace&&now.sessionKind==='daily'&&now.checkedSessionId===sessionId&&mainSession.getSnapshot()===sessionId&&child.sessions.binding(id)===binding}
    const api=createBusinessRecordApi(async(endpoint,payload,signal)=>{if(!isCurrent())throw Error('业务会话已变化。');const result=await callWithReceipt(endpoint,payload,signal);if(!isCurrent())throw Error('业务会话已变化。');if(!result.ok)throw Object.assign(Error(result.error.message),{code:result.error.code});return result.value})
    await insertBusinessRecordInput(reference,sessionId,{switching:businessBuilder.ports.switching,isCurrent,state:input.state,
      verify:async()=>{const daily=await token.bySession({sessionId});if(!isCurrent()||daily?.kind!=='daily'||daily.sessionId!==sessionId||daily.scope!==reference.scope)throw Error('记录与当前业务会话不一致。');return api.get({scope:reference.scope,type:reference.type,id:reference.id,version:reference.version})},
      insert:request=>binding.ctx.bail(binding.ctx,'slash/input-insert-reference',request),
    });if(isCurrent())input.focus()
  }
  const createBusinessRecordFlow=()=>{
    const generation=connection.generation.getSnapshot()
    const api=createBusinessRecordApi(async(endpoint,payload,signal)=>{
      if(!generation||connection.generation.getSnapshot()!==generation)throw Error('业务连接已变化。')
      const result=await callWithReceipt(endpoint,payload,signal)
      if(connection.generation.getSnapshot()!==generation)throw Error('业务连接已变化。')
      if(!result.ok)throw Object.assign(Error(result.error.message),{code:result.error.code,details:result.error.details})
      return result.value
    })
    return businessBuilder.createRecordFlow(api)
  }
  // 与宿主配置服务的固定 owner 一致；空间身份来自已核定的 current Personal Space。
  const businessImports=createBusinessImportFlowFactory({ownerId:'local:teloa-owner',identity:businessBuilder.getSnapshot,generation:()=>connection.state.getSnapshot()==='connected'?connection.generation.getSnapshot():undefined,storage:{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value),removeItem:key=>localStorage.removeItem(key)},call:callWithReceipt})
  const createBusinessImportFlow=businessImports.forTarget
  ctx.effect(()=>{
    const off=[businessBuilder.subscribe(businessImports.invalidate),connection.generation.subscribe(businessImports.invalidate),connection.state.subscribe(businessImports.invalidate)]
    return()=>{for(const dispose of off)dispose();businessImports.dispose()}
  },'teloa: 业务导入本人空间与连接生命周期')

  /**
   * 岗位会话身份引导语的自动发送口（规格 §7.3 支 A，裁定 H9）。
   * 核实结论：原生输入门面 `SessionInput` 本身就公开了 `setDraft` 与 `submit` 两个动作
   *（dsh-client-ui-conversation `contract/input.d.ts` 的 `SessionInput`；`conversation.input`
   * 是 `SessionInputResolver`，见 `service.d.ts:27`），因此不需要在 `prompt-preparation.ts`
   * 上补可选 `submit`。只有在目标会话的输入框确实是一份空白草稿时才写入并提交——
   * 本人已经打上的字、已挂的附件、正在提交的那一刻，一律不覆盖，宁可不发。
   */
  const sendConversationMessage=(sessionId:string,text:string):void=>{
    const child=requireWorkContext()
    const scope=child.sessions.scope(brandString<SessionId>(sessionId))
    if(!scope)throw Error('目标会话作用域不可用。')
    const input=child.conversation.input.for(scope)
    const before=input.state.getSnapshot()
    if(before.phase!=='plain'||before.draft||before.attachmentIds.length)throw Error('原生输入已有内容，未自动发送。')
    input.setDraft(text)
    if(input.state.getSnapshot().draft!==text)throw Error('原生输入未接受这条消息，未自动发送。')
    input.submit()
  }
  const capabilityInsertions=new Set<string>()
  const insertConversationCapabilities=(selection:CapabilitySelection)=>{
    const child=requireWorkContext(),scope=child.sessions.scope(brandString<SessionId>(selection.sessionId))
    if(!scope||mainSession.getSnapshot()!==selection.sessionId)throw Error('会话已切换，请回到来源输入后选择。')
    if(capabilityInsertions.has(selection.sessionId))throw Error('正在添加引用，请稍候。')
    const input=child.conversation.input.for(scope)
    capabilityInsertions.add(selection.sessionId)
    void insertHomeCapabilities(selection,{
      state:input.state,
      verify:async()=>{
        const [resources]=await Promise.all([resourceApi.candidates(selection.sessionId,new AbortController().signal),work.readCatalog()])
        const binding=work.getSnapshot()
        if(mainSession.getSnapshot()!==selection.sessionId||binding.sessionId!==selection.sessionId||binding.status!=='ready'||binding.catalogStatus!=='ready'||!binding.capabilities)throw Error('目标会话或能力目录已变化，请重新选择。')
        for(const resource of selection.resources)if(!resources.some(row=>row.id===resource.id&&row.version===resource.version))throw Error(resource.title+'：资料版本或读取权限已变化。')
        for(const skill of selection.skills){const candidates=binding.capabilities.skills.filter(row=>row.name===skill.name);if(candidates.length!==1||!candidates[0]!.userInvocable||candidates[0]!.source!==skill.source||candidates[0]!.provider!==skill.provider)throw Error(skill.name+'：技能来源或使用权限已变化。')}
      },
      text:request=>scope.bail(scope,'slash/input-insert-text',request),
      reference:request=>scope.bail(scope,'slash/input-insert-reference',request),
    }).then(()=>input.focus(),error=>input.notify('error',error instanceof Error?error.message:'无法添加引用。')).finally(()=>capabilityInsertions.delete(selection.sessionId))
  }
  const management=new ConversationManagement(()=>work.getDirectorySnapshot().rows)
  const homeSession=new HomeNativeController({
    storage:navigationStorage,identity:()=>crypto.randomUUID(),
    refresh:()=>requireWorkContext().sessions.refresh(),
    isBlank:id=>{const child=requireWorkContext();return readHomeNativeBlank(child.sessions,brandString<SessionId>(id),binding=>child.conversation.input.for(binding.ctx).state.getSnapshot().queue.some(item=>item.source.kind==='user'&&'rpcId'in item.source))},
    create:async id=>{
      const child=requireWorkContext(),sessionId=brandString<SessionId>(id)
      if(!child.sessions.list.getSnapshot().byId[sessionId]){
        const available=management.getSnapshot().workspaces
        const selected=mainSession.getSnapshot()
        const previous=available.find(row=>selected&&row.sessionIds.includes(selected))
        const key='teloa.home-native-workspace/'+id
        const remembered=navigationStorage.getItem(key)
        const workspaceId=remembered??previous?.workspaceId??(available.length===1?available[0]!.workspaceId:undefined)
        if(!workspaceId)throw Error('请先在新建会话中选择执行位置。')
        navigationStorage.setItem(key,workspaceId)
        const created=await child.sessions.create({sessionId,workspaceId:brandString<WorkspaceId>(workspaceId)})
        if(created!==sessionId)throw Error('待用会话身份不一致。')
      }
      const binding=await call('conversations/adopt',{sessionId:id,requestId:id,title:child.sessions.list.getSnapshot().byId[sessionId]?.title||'通用工作会话'})
      if(!isConversation(binding)||binding.sessionId!==id)throw Error('待用会话绑定未确认。')
      await work.refreshDirectory()
      return id
    },
  })
  let initialSessionPrepared=false
  const initialSession=createInitialNativeSessionCoordinator(async()=>{
    await initialContext
    return {current:mainSession,sessions:()=>requireWorkContext().sessions,isBlank:async(id:SessionId)=>{const child=requireWorkContext();return readHomeNativeBlank(child.sessions,id,binding=>child.conversation.input.for(binding.ctx).state.getSnapshot().queue.some(item=>item.source.kind==='user'&&'rpcId'in item.source))}}
  },initialSessionLifetime.signal)
  ctx.on('teloa/initial-native-session/register',initialSession.register)
  const prepareHomeSession=async(signal:AbortSignal)=>{
    const lifetime=AbortSignal.any([signal,initialSessionLifetime.signal])
    if(!initialSessionPrepared){
      const proof=await initialSession.prepare(lifetime)
      lifetime.throwIfAborted()
      if(proof&&await homeSession.claimPrepared(proof.sessionId,proof.assertCurrent,proof.explicit)){initialSessionPrepared=true;return proof.sessionId}
      initialSessionPrepared=true
    }
    const id=await homeSession.prepare()
    if(signal.aborted)return
    requireWorkContext().uiWorkspace.openSession(brandString<SessionId>(id))
    requireActions().navigate('home')
    return id
  }

  const conversationSearch=new ConversationSearch(async(query,signal)=>{
    const result=await requireWorkContext().sessions.search(query,signal)
    if(!result.ok)throw Error(result.error.message)
    return result.value
  },()=>work.getDirectorySnapshot().rows.filter(row=>row.status==='ready').map(row=>row.sessionId))
  ctx.effect(()=>()=>conversationSearch.clear(),'teloa: 会话搜索清理')
  ctx.inject(['sessions','workspaces','connection'],child=>{
    const sessions=child.sessions,workspaces=child.workspaces as unknown as IWorkspaces
    const nativeConnection=Reflect.get(child,'connection') as unknown as ConnectionHandle
    return management.attach({
      state:()=>({...managementAvailability(nativeConnection.state.getSnapshot(),sessions.list.getSnapshot().phase,workspaces.list.getSnapshot()),archived:workspaces.list.getSnapshot().archivedSessionIds,workspaces:workspaces.list.getSnapshot().items}),
      subscribe:listener=>{const offSessions=sessions.list.subscribe(listener),offWorkspaces=workspaces.list.subscribe(listener),offConnection=nativeConnection.state.subscribe(listener);return ()=>{offSessions();offWorkspaces();offConnection()}},
      summary:id=>{const state=sessions.list.getSnapshot(),sessionId=brandString<SessionId>(id);return state.ids.includes(sessionId)?state.byId[sessionId]:undefined},
      rename:async(id,title)=>sessions.using(brandString<SessionId>(id),{source:'workspaceOperation'},async reference=>{const result=await reference.binding.session.rename(title);if(!result.ok)throw Error(result.error.message)}),
      move:async(workspaceId,id,before)=>{await workspaces.insertSessionBefore(brandString<WorkspaceId>(workspaceId),brandString<SessionId>(id),before===undefined?undefined:brandString<SessionId>(before))},
      archive:id=>workspaces.archiveSession(brandString<SessionId>(id)),
      // 宿主在调用 DSH 前落盘；断线后的重试不能重新调用非幂等 fork。
      fork:async id=>{const value=await call('copies/create',{sourceSessionId:id,requestId:crypto.randomUUID()});if(!isCopyAttempt(value))throw Error('副本创建记录格式错误。');if(value.state==='rejected')throw new ForkRejectedError('来源会话暂不支持创建副本，未创建。');if(value.state!=='ready'||!value.childSessionId)throw Error('副本结果仍待核对。');return value.childSessionId},
      copyHistory:async()=>{const value=await call('copies/list',{});if(!Array.isArray(value)||!value.every(isCopyAttempt))throw Error('副本历史返回格式错误。');return value},
      releaseCopy:async requestId=>{const value=await call('copies/release',{requestId,acceptPossibleDuplicate:true});if(!isCopyAttempt(value))throw Error('副本记录返回格式错误。');return value},
      resolveCopy:async(requestId,childSessionId)=>{const value=await call('copies/resolve',{requestId,childSessionId});if(!isCopyAttempt(value))throw Error('副本恢复记录格式错误。');return value},
      adopt:async(sessionId,requestId,title)=>{const value=await call('conversations/adopt',{sessionId,requestId,title});if(!isConversation(value))throw Error('会话接入返回格式错误。');await work.refreshDirectory();return value},
      ensure:async id=>{const summary=sessions.list.getSnapshot().byId[brandString<SessionId>(id)];const title=('副本 · '+(summary?.title?.trim()||summary?.displayTitle?.trim()||'工作会话')).slice(0,200);const value=await call('conversations/adopt',{sessionId:id,requestId:crypto.randomUUID(),title});if(!isConversation(value))throw Error('副本绑定返回格式错误。');await work.refreshDirectory();return value},
    })
  })
  const nativeArtifacts=createNativeArtifactApi({
    ready:sessionId=>requireWorkContext().sessions.using(brandString<SessionId>(sessionId),{source:'controllerOperation'},async reference=>{await reference.ready}),
    binding:sessionId=>{
      const child=requireWorkContext(),snapshot=work.getSnapshot()
      if(snapshot.status!=='ready'||snapshot.sessionId!==sessionId||snapshot.conversation?.sessionId!==sessionId||mainSession.getSnapshot()!==sessionId)throw Error('会话已切换或工作绑定不可用，请回到来源会话后重试。')
      const binding=child.sessions.binding(brandString<SessionId>(sessionId))
      if(!binding)throw Error('原生会话绑定不可用。')
      return binding
    },
    imageUrl:(sessionId,image)=>{
      type NativeRef=Parameters<UiConversation['imageUrl']>[1]
      return requireWorkContext().uiConversation.imageUrl(brandString<SessionId>(sessionId),{...image.attachment,attachmentId:brandString<NativeRef['attachmentId']>(image.attachment.attachmentId)})
    },
  })
  const artifactFileApi=createArtifactFileApi(call,sessionId=>{
    const snapshot=work.getSnapshot()
    if(snapshot.status!=='ready'||snapshot.sessionId!==sessionId||snapshot.conversation?.sessionId!==sessionId||mainSession.getSnapshot()!==sessionId)throw Error('会话已切换或绑定不可用，请回到来源会话后读取文件。')
  })
  ctx.effect(()=>{
    const handle=createWorkbenchStore(ctx.theme.getTheme().active.colorScheme,loadWorkbenchNavigationState(navigationStorage))
    const instance=handle.create()
    const disposeNavigationPersistence=attachWorkbenchNavigationPersistence(instance,navigationStorage)
    const store={...handle,create:()=>instance}
    const panelInfo={getSnapshot:()=>instance.getSnapshot().panelInfo,subscribe:(listener:()=>void)=>instance.subscribe(listener)}
    const layout=createWorkbenchLayout(instance.actions,id=>ctx.slots.entries('main').some(entry=>entry.options.key===id),settingsNavigation,panelInfo)
    const retainMainPanels=()=>instance.actions.retainMainPanels(ctx.slots.entries('main').flatMap(entry=>entry.options.key===undefined?[]:[entry.options.key]))
    const disposePanelInfo=ctx.slots.provideRoot({hooks:{panelInfo:layout.panelInfo}})
    const disposeService=ctx.reflect.provide('layout',layout)
    const runtime=requireI18n()
    const LocalizedWorkbenchFrame=(props:ComponentProps<typeof WorkbenchFrame>)=>createElement(I18nProvider,{runtime},createElement(WorkbenchFrame,props))
    const disposeRoot=ctx.slots.register({
      name:'root',
      children:{
        sidebar:{kind:'single',scope:'root'},
        main:{kind:'keyed',scope:'root'},
        rightbar:{kind:'single',scope:'root'},
        'shell.overlay':{kind:'list',scope:'root'},
        'teloa.workbench.toolbar':{kind:'list',scope:'root'},
        'teloa.conversation':{kind:'single',scope:'session-maybe'},
      },
      store,
      inject:(bound: WorkbenchActions)=>{actions=bound;return {navigationStorage,openLocalModels,runtimeSettings,runtimeExtensions,resolveExtensionText:ctx.locale.resolveText.bind(ctx.locale),setTheme:(value:'light'|'dark')=>ctx.theme.setTheme(value),sidebarRightFace,mainSession,openNativePanel:(id:string)=>layout.selectPanel(brandString<MainPanelId>(id)),work,management,conversationSearch,planApi,marketContentApi,marketCatalogApi,createBusinessDashboardResources,createBusinessMcpConnection,skillSecretsApi,githubSourceApi,industryLoadApi,industryKnowledgeApi,industryDataSourceApi,industryExecutionToolApi,industryMcpConnectionApi,industryPluginApi,industryRoleApi,industryTaskApi,industryPlanApi,skillInstallApi,marketPluginInstallApi,bundledExtensionsApi,skillAvailabilityApi,skillUpgradeApi,localRetrievalApi,resourceApi,roleApi,memoryApi,dailyLogApi,runtimeConfigApi,taskApi,projectApi,taskRunApi,securityActionApi,taskMaterialApi,taskTransitions,pendingRequestApi,roleLifecycle,roleToolGrantApi,handoffApi,objectConversationApi,groupApi,groupAttachmentApi,groupReactionApi,groupRoutingApi,businessLedgerApi,businessDashboardApi,businessCustomizationApi,connectorProbeApi,businessTaskApi,businessSpaceApi,businessScopeApi,businessBuilder,createBusinessRecordFlow,createBusinessImportFlow,createBusinessResponsibility,createBusinessTaskList,createBusinessSetup,insertBusinessRecord,pageCreateApi,preparation,sendConversationMessage,prepareHomeSession,homeContextApi,insertConversationCapabilities,nativeArtifacts,artifactFileApi,artifactApi}},
    },LocalizedWorkbenchFrame)
    const disposePanels=ctx.slots.subscribe('main',retainMainPanels)
    retainMainPanels()
    return ()=>{disposeNavigationPersistence();layout.dispose();disposePanels();disposeRoot();disposePanelInfo();disposeService();actions=undefined}
  },'teloa: layout 服务与原生子 slot')
  ctx.effect(()=>{
    const presenter=new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off=ctx.on('theme/change',snapshot=>{presenter.apply(snapshot);actions?.setColorScheme(snapshot.active.colorScheme)})
    return ()=>{off();presenter.dispose()}
  },'teloa: DSH 主题投影')
  // root 必须先提供 layout，再等待依赖 layout 的原生 conversation；避免硬注入成环。
  ctx.inject([...WORK_CONTEXT_INJECT],child=>{
    child.slots.inject('conversation.chat.turnTail',()=>child.slots.register({
      name:'conversation.chat.turnTail',id:'teloa-produced-files',order:-100,
      inject:sessionId=>{
        const binding=child.sessions.binding(sessionId)
        return {preview:(path:string)=>previewProducedFileNatively({
          // 主会话和侧栏子会话可同时保留；动作必须仍属于注入时的同一原生实例。
          sessionAvailable:()=>binding!==undefined&&child.sessions.binding(sessionId)===binding,
          workspaceCwd:()=>child.sessions.list.getSnapshot().byId[sessionId]?.cwd,
          openResource:address=>child.sidebarRight.openResource(address),
        },sessionId,path)}
      },
    },ProducedFileCards))
    // 会话页的第三栏承载交给原生右栏：Teloa 只负责内容与关闭前的收尾，
    // 布局、页签条、分栏、浮动、全屏全部白拿。目录页的页内三栏不迁（无会话即无 surface）。
    child.inject(['sidebarRightTabs'],rail=>{
      // type-import 只证明类型存在，不证明服务在场；运行期再复证一次结构，装不上就整体跳过，
      // 会话页仍退回 Teloa 自己的页内第三栏。
      const registry=rail.sidebarRightTabs as {register?:unknown}|undefined
      const controller=rail.sidebarRight as {registerCloseHandler?:unknown;openTab?:unknown}|undefined
      if(typeof registry?.register!=='function'||typeof controller?.registerCloseHandler!=='function'||typeof controller?.openTab!=='function')return
      const runtime=requireI18n()
      const LocalizedTabBody=(props:ComponentProps<typeof SidebarRightTabBody>)=>createElement(I18nProvider,{runtime},createElement(SidebarRightTabBody,props))
      for(const kind of TELOA_RAIL_KINDS){
        rail.effect(()=>{
          try{return rail.sidebarRightTabs.register(teloaTabDefinition(kind,()=>requireI18n().t(RAIL_TAB_TITLE_KEYS[kind])))}
          catch{return ()=>{}}
        },'teloa: 右栏页类型')
        rail.effect(()=>rail.slots.inject('sidebar.right.pane.tab',()=>rail.slots.register({
          name:'sidebar.right.pane.tab',
          key:TELOA_TAB_IDS[kind],
          inject:()=>({
            kind,
            render:(view:TeloaTabSecondaryView,params:unknown)=>teloaTabHost()?.render(kind,view,params)??null,
            hasEvidence:(params:unknown)=>teloaTabHost()?.hasEvidence(kind,params)??false,
          }),
        },LocalizedTabBody)),'teloa: 右栏对象正文')
        rail.effect(()=>rail.slots.inject('sidebar.right.pane.tab.title',()=>rail.slots.register({
          name:'sidebar.right.pane.tab.title',
          key:TELOA_TAB_IDS[kind],
          inject:()=>({label:(params:unknown)=>teloaTabHost()?.label(kind,params)}),
        },SidebarRightTabTitle)),'teloa: 右栏对象标题')
        // 关闭钩子同步执行，抛错即保留页签。按（会话, 页签身份）收尾：replaceTab 时 DSH 先跑这里、再提交新页签，
        // 不比对身份就会把刚写好的详情抹掉；钩子按 kind 全局注册，会话得靠 DSH 传进来的这一个参数分辨。
        rail.effect(()=>rail.sidebarRight.registerCloseHandler(kind,(sessionId,tab)=>{if(tab.kind===kind)teloaTabHost()?.releaseTab(sessionId,kind)}),'teloa: 右栏对象关闭钩子')
      }
    })
    child.slots.inject('conversation.hero.brand.mark',()=>child.slots.register({name:'conversation.hero.brand.mark',inject:()=>({theme:brandTheme})},ConversationBrand))
    // 服务必须从声明了依赖的子上下文捕获；外层布局上下文无权读取它们。
    workContext=child
    resolveInitialContext()
    child.effect(()=>{
      let previous:string|undefined
      const syncCapabilityBlock=()=>{
        const state=sessionCapabilities.getSnapshot(),current=mainSession.getSnapshot()
        if(previous&&previous!==state.sessionId){capabilityBlocks.delete(previous);syncComposerBlock(previous)}
        previous=state.sessionId
        if(!current||state.sessionId!==current)return
        const copy=state.status==='checking'?'application.capability.checking':state.status==='unavailable'?'application.capability.unavailable':state.deniedCapability?'application.capability.'+(applicationPresentation.getCapabilitySnapshot().reason??'unavailable'):undefined
        if(copy)capabilityBlocks.set(current,requireI18n().t(copy));else capabilityBlocks.delete(current)
        syncComposerBlock(current)
      }
      const selected=()=>sessionCapabilities.select(mainSession.getSnapshot())
      const off=[sessionCapabilities.subscribe(syncCapabilityBlock),mainSession.subscribe(selected),connection.state.subscribe(()=>{void applicationPresentation.refresh();void sessionCapabilities.refresh()}),requireI18n().subscribe(syncCapabilityBlock)]
      selected()
      return()=>{for(const dispose of off)dispose();sessionCapabilities.select(undefined);capabilityBlocks.clear();if(previous&&workContext)syncComposerBlock(previous)}
    },'teloa: 同源会话能力与输入只读投影')
    child.effect(()=>retainNativeInputs({
      sessions:child.sessions,current:mainSession,
      owner:{getSnapshot:()=>businessBuilder.getSnapshot().namespace,subscribe:businessBuilder.subscribe},
      input:binding=>child.conversation.input.for(binding.ctx).state,
      monitor:binding=>homeSubmissionMonitor(binding.sessionId),
    }),'teloa: 保留原生待发送输入作用域')
    // 身份读取可能先于原生上下文装配；已有检查阻止在真实 blocks 服务出现后立即重放。
    for(const sessionId of businessBlocks.keys())syncComposerBlock(sessionId)
    child.effect(()=>{
      const refresh=()=>void businessBuilder.connect(connection.generation.getSnapshot())
      let active:ReturnType<typeof child.sessions.binding>,offInput:Array<()=>void>=[]
      const notify=()=>{for(const listener of businessNativeListeners)listener()}
      const native=()=>{
        const id=mainSession.getSnapshot(),binding=id?child.sessions.binding(id):undefined
        if(binding!==active){for(const dispose of offInput)dispose();offInput=[];active=binding
          if(binding){const input=child.conversation.input.for(binding.ctx);offInput=[binding.session.subscribe(notify),input.state.subscribe(notify),homeSubmissionMonitor(id!).subscribe(notify)]}
        }
        notify()
      }
      const selected=()=>{void businessBuilder.followSession(mainSession.getSnapshot());native()}
      const off=[connection.generation.subscribe(()=>{refresh();native()}),connection.state.subscribe(native),mainSession.subscribe(selected),child.sessions.list.subscribe(native),work.subscribe(native),()=>{for(const dispose of offInput)dispose()}];refresh();native()
      return()=>{for(const dispose of off)dispose();businessBuilder.dispose();homeSubmissionMonitors.clear()}
    },'teloa: 业务搭建本人空间与连接生命周期')
    child.slots.inject('conversation.input.dock',()=>child.slots.register({
      name:'conversation.input.dock',id:'teloa-submission-recovery',order:-110,
      inject:sessionId=>{
        return {monitor:homeSubmissionMonitor(sessionId)}
      },
    },HomeSubmissionNotice))

    child.slots.inject('teloa.conversation',()=>child.slots.register({
      name:'teloa.conversation',
      inject:sessionId=>{
        const binding=sessionId?child.sessions.binding(sessionId):undefined
        const input=binding?child.conversation.input.for(binding.ctx).state:undefined
        return {isHomeDraft:()=>!!sessionId&&homeSession.owns(sessionId),accept:()=>{if(sessionId)homeSession.accept(sessionId)},acceptance:{
          getSnapshot:()=>!!binding&&(binding.eventSource.getSnapshot().entries.some(entry=>entry.event.type==='user/message'&&entry.event.surfaceOp==='append'&&entry.event.data.source.kind==='user')||!!input?.getSnapshot().queue.some(item=>item.source.kind==='user'&&'rpcId'in item.source)),
          subscribe:(listener:()=>void)=>{const off=[binding?.eventSource.subscribe(listener),input?.subscribe(listener)];return()=>{for(const dispose of off)dispose?.()}},
        }}
      },
    },HomeNativeConversation))
    child.slots.inject('conversation.input.left',()=>child.slots.register({
      name:'conversation.input.left',id:'teloa-work-context',order:80,
      inject:()=>({api:homeContextApi,work,isNativeChild:(id:string)=>isNativeChildSession(child.sessions,brandString<SessionId>(id)),isAssistantContext:isHomeAssistantContext,block:homeContextBlock,roles:async()=> (await roleApi.list()).filter(role=>role.state==='active'&&role.kind==='employee').map(role=>({id:role.id,name:role.name,version:role.version,scopes:role.scopes}))}),
    },HomeComposerContext))
    child.slots.inject('conversation.input.dock',()=>child.slots.register({
      name:'conversation.input.dock',id:'teloa-work-requests',order:-105,
      inject:sessionId=>({work,call,isAssistantContext:isHomeAssistantContext,openTask:(id:string)=>requireActions().openTask(id),subscribeActivity:(listener:()=>void)=>child.sessions.binding(sessionId)?.eventSource.subscribe(listener)??(()=>{})}),
    },HomeWorkRequestsDock))

    child.effect(()=>{const off=observeMainSessionBinding(mainSession,child.sessions,work);return ()=>{off();workContext=undefined}},'teloa: 原生会话绑定同步')
    child.slots.inject('conversation.input.left',()=>child.slots.register({name:'conversation.input.left',id:'teloa-capabilities',order:90,inject:()=>({work,i18n:requireI18n(),openResources:()=>requireActions().openResources(),openTeamCapabilities:()=>requireActions().navigate('capabilities')})},Capabilities))
    child.slots.inject('conversation.input.dock',()=>child.slots.register({name:'conversation.input.dock',id:'teloa-binding',order:-100,inject:()=>({work,i18n:requireI18n()})},BindingStatus))
    child.slots.inject('conversation.input.dock',()=>child.slots.register({name:'conversation.input.dock',id:'teloa-session-capability',order:-98,inject:()=>({reader:sessionCapabilities,i18n:requireI18n()})},SessionCapabilityNotice))
    child.slots.inject('conversation.input.dock',()=>child.slots.register({
      name:'conversation.input.dock',id:'teloa-browser-stop',order:-95,
      inject:sessionId=>({i18n:requireI18n(),reader:createSessionBrowserStopReader(
        ()=>call('session-browser/status',{sessionId}),
        listener=>{
          const binding=child.sessions.binding(sessionId)
          const connectionState=(Reflect.get(child,'connection') as unknown as ConnectionHandle).state
          const off=[binding?.eventSource.subscribe(listener),binding?.session.subscribe(listener),connectionState.subscribe(listener),work.subscribe(listener),child.sessions.list.subscribe(listener)]
          return()=>{for(const dispose of off)dispose?.()}
        },
        ()=>sessionBrowserStopBindingReady(sessionId,work.getSnapshot(),child.sessions.list.getSnapshot().byId[sessionId]!==undefined,isNativeChildSession(child.sessions,sessionId)),
      )}),
    },SessionBrowserStopNotice))
    child.slots.inject('conversation.input.dock',()=>child.slots.register({name:'conversation.input.dock',id:'teloa-market-preparation',order:-80,inject:(sessionId)=>({work,preparation,resourceApi,resourceInput:nativePreparedInput(()=>{
      const snapshot=work.getSnapshot()
      if(snapshot.status!=='ready'||snapshot.sessionId!==sessionId||mainSession.getSnapshot()!==sessionId)throw Error('目标会话已切换或尚未就绪。')
      const scope=child.sessions.scope(sessionId)
      if(!scope)throw Error('目标会话作用域不可用。')
      return {state:child.conversation.input.for(scope).state,running:child.sessions.list.getSnapshot().byId[sessionId]?.running??true,text:request=>scope.bail(scope,'slash/input-insert-text',request),reference:request=>scope.bail(scope,'slash/input-insert-reference',request)}
    }),validateTask:async(row:import('./prompt-preparation.js').PreparedPrompt)=>{const current=await objectConversationApi.taskContext(row.sourceId,row.sessionId,row.sourceVersion);if(JSON.stringify(current)!==row.taskSnapshot){preparation.invalidate(row.sourceId);throw Error('任务、负责员工或会话关联已变化，请返回任务重新准备。')}},openSource:(id:string,kind?:'home'|'task')=>kind==='task'?requireActions().openTask(id):kind==='home'?requireActions().navigate('home'):requireActions().openMarket(undefined,id)})},PreparedPromptCard))
    child.slots.inject('conversation.input.dock',()=>child.slots.register({name:'conversation.input.dock',id:'teloa-resource-recovery',order:-90,inject:()=>({api:resourceApi,work})},ResourceRecovery))
    child.slots.inject('conversation.session.header.utilities',()=>child.slots.register({name:'conversation.session.header.utilities',id:'teloa-resource-history',order:80,inject:()=>({api:resourceApi,work})},ResourceHistory))
    child.slots.inject('conversation.session.header.utilities',()=>child.slots.register({name:'conversation.session.header.utilities',id:'teloa-role-identity',order:70,inject:()=>({readIdentity:(sessionId:string)=>readSessionRoleIdentity(sessionId,{links:id=>objectConversationApi.bySession(id),roles:()=>roleApi.list()})})},RoleConversationIdentity))
    for(const key of ['teloa_work_dispatch','teloa_work_collect_reports','teloa_work_status','teloa_work_stop','teloa_work_resume'])child.slots.inject('tool.call.toolview',()=>child.slots.register({name:'tool.call.toolview',key,inject:()=>({call,openTask:(id:string)=>requireActions().openTask(id)})},HomeWorkRequestCard))
    child.slots.inject('tool.call.toolview',()=>child.slots.register({name:'tool.call.toolview',key:'teloa_capabilities',inject:()=>({work,i18n:requireI18n()})},CapabilitiesToolCard))
    for(const key of ['teloa_resources_create','teloa_resources_update'])child.slots.inject('tool.call.toolview',()=>child.slots.register({name:'tool.call.toolview',key,inject:()=>({openResourceDraft:(id:string)=>requireActions().openResources(id)})},ResourceDraftCard))
    child.slots.inject('tool.call.toolview',()=>child.slots.register({name:'tool.call.toolview',key:'teloa_knowledge_save_message',inject:()=>({openResources:(resourceId?:string)=>resourceId?requireActions().openResource(resourceId):requireActions().openResources()})},KnowledgeSaveReceiptCard))
  })
  ctx.inject(['inputTriggers'],child=>{
    const triggers=Reflect.get(child,'inputTriggers') as InputTriggerServiceContract
    child.effect(()=>triggers.registerSource(resourceSource(resourceApi)),'teloa: 原生知识库引用来源')
    child.effect(()=>triggers.registerSource(businessRecordReferenceSource()),'teloa: 原生业务记录引用来源')
  })
}
