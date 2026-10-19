import {createRoleSkillTitleReader} from './capability-skill-runtime.js'
import {createIndustryTeamMaterials} from './industry-team-materials.js'
import {findIndustryTeam,industryTeamSeed,type IndustryTeamSeed} from './industry-team.js'
import {findMarketItem,marketItemId,mergeMarketItems} from './market-item-identity.ts'
import {readPendingMarketContents} from './pending-market-content.ts'
import type {ConversationPlanDirectory} from './conversation-plans.js'
import {employeeVoiceCopy} from './employee-voice-copy.js'
import {AssistantVoiceMessage,AssistantVoiceBusyError,type AssistantVoiceDestination,type AssistantVoiceDraft} from './AssistantVoiceMessage.js'
import {EmployeeVoiceCall,type VoiceCallTarget} from './EmployeeVoiceCall.js'
import type {EmployeeVoiceApi} from './employee-voice-api.js'
import type {AssistantCompanionActivity} from './assistant-companion-activity.js'
import type {AssistantMiniChatPort} from './assistant-mini-chat.js'
import {AssistantCompanion} from './AssistantCompanion.js'
import {browserDialogueOrganization} from './dialogue-organization.js'
import {findAssistantConversation,rememberAssistantConversation,assistantConversationKey,assistantConversationTitle,pendingAssistantCreation} from './assistant-conversation.js'
import assistantAvatar from '../brand/companion/icon.webp'
import {EmployeeConversationHeader} from './EmployeeConversationHeader.js'
import {TwinAvatar} from './TwinAvatar.js'
import {conversationHeaderCopy} from './conversation-header-copy.js'
import {DetailsMenu} from './DetailsMenu.js'
import {leaseNativeSidebarAccessibility} from './native-sidebar-accessibility.js'
import {TemplateShareReceive} from './TemplateShareReceive.js'
import {createShareAcceptance,resolvePublicCatalogEntry} from './template-share-accept.js'
import {ShareDraftDrawer,TemplateShareProvider,type ShareBridge,type TemplateShareSources} from './EmployeeTemplateShare.js'
import type {SharePackage} from './share-package-plan.js'
import {resolveTemplateShareSkills} from './template-share-skill-sources.js'
import {loadCatalogListing} from './market-catalog-api.js'
import type {TemplateShareIntent} from '@teloa/contract'
import {WorkProgressPanel} from './WorkProgressPanel.js'
import type {WorkControlApi} from './work-control-api.js'
import {BusinessDashboardShareForm} from './BusinessDashboardShareForm.js'
import type {BusinessDashboardResourceApi} from './business-dashboard-resource-api.js'
import {BusinessDailyStatus} from './BusinessDailyStatus.js'
import type {BusinessNavigationToken,BusinessBuilderController} from './business-builder-controller.js'
import type {BusinessBuilderApi} from './business-builder-api.js'
import type {BusinessResponsibilityApi} from './business-responsibility-api.js'
import {businessSetupOrigin,businessSetupReturnOrigin,openBusinessSetupDestination,returnToBusinessSetup,type BusinessSetupOrigin} from './business-setup-navigation.js'
import type {BusinessSetupApi,BusinessSetupAction} from './business-setup.js'
import type {ManagedMcpConnectionApi} from './mcp-connections-api.js'
import type {BusinessConfigurationSelection} from './business-configuration-surface.js'
import type {BusinessTaskListApi} from './business-task-list-api.js'
import type {BusinessRecordFlow} from './business-record-flow.js'
import type {BusinessImportFlow} from './business-import-flow.js'
import type {BusinessImportTargetFactory} from './business-import-integration.js'
import type {BusinessConfigurationServices} from './BusinessConfigurationSurface.js'
import {BusinessConfigurationPage} from './BusinessConfigurationPage.js'
import {BusinessBuilderPanel} from './BusinessBuilderPanel.js'
import {BusinessBuilderDirectory,BusinessBuilderSwitchDialog} from './BusinessBuilderDirectory.js'
import type {LocalRetrievalApi} from './local-retrieval-api.js'
import {isIndustryManifest} from './industry-manifest.ts'
import {homeCreationLocation,mayContinueHomeCreation} from './home-creation-navigation.js'
import {ensureHomeObjectContext} from './home-object-context.js'
import type {HomeContextApi} from './home-native-controller.js'
import {homeNativeCopy} from './home-native-copy.js'
import {HomeNativePreparationNotice} from './HomeNativePreparationNotice.js'
import {taskArtifactPort} from './task-artifact-port.js'
import type {RuntimeSettingsSurface} from './runtime-settings-surface.js'
import {StatusLabel} from './StatusLabel.js'
import {SecurityActions} from './SecurityActions.js'
import type {SecurityActionApi,SecurityActionAttention,SecurityActionContext} from './security-action-api.js'
import type {MarketPluginInstallPreview,SecurityActionPanel} from '@teloa/contract'
import {SecurityDecisionActions,SecurityPanelFallback} from './SecurityDecisionActions.js'
import {HandoffDecisionActions} from './HandoffDecisionActions.js'
import {attentionDecisionActionMode,type SecurityDecisionOutcome,type SecurityDecisionSnapshot} from './attention-decision.js'
import {projectTaskSnapshotBusiness,taskSnapshotMessage} from './task-snapshot-projection.js'
import {canResolveHandoff} from './task-handoff-presentation.js'
import {securityActionEvidence} from './security-action-evidence.js'
import type {SkillUpgradeApi} from './skill-upgrade-api.js'
import type {SkillAvailabilityApi} from './skill-availability-api.js'
import {projectSavedPlan,type PlanApi,type SavedPlan} from './plan-api.js'
import type {MarketContentApi} from './market-content-api.js'
import type {IndustryLoadApi,IndustryLoadRecord,IndustryLoadCreateInput,IndustryLoadUnloadInput,IndustryLoadUpgradeInput} from './industry-load-api.js'
import type {IndustryKnowledgeApi,IndustryKnowledgeInstance,IndustryKnowledgeRequest} from './industry-knowledge-api.js'
import type {IndustryDataSourceApi,IndustryDataSourceInstance,IndustryDataSourceInstantiateInput,IndustryDataSourceAuthorizeInput} from './industry-data-source-api.js'
import type {IndustryExecutionToolApi,IndustryExecutionToolInstance,IndustryExecutionToolInstantiateInput,IndustryExecutionToolAuthorizeInput} from './industry-execution-tool-api.js'
import type {IndustryMcpConnectionApi,IndustryMcpConnectionInstance,IndustryMcpConnectionInstantiateInput,IndustryMcpConnectionConnectInput} from './industry-mcp-connection-api.js'
import type {IndustryPluginApi,IndustryPluginInstance,IndustryPluginInstantiateInput,IndustryPluginInstallInput} from './industry-plugin-api.js'
import {mergeIndustryKnowledgeInstances} from './industry-knowledge-state.js'
import type {IndustryRoleApi,IndustryRoleInstance,IndustryRoleRequest} from './industry-role-api.js'
import {mergeIndustryRoleInstances} from './industry-role-state.js'
import {createRoleResourceDirectory} from './role-resource-directory.js'
import {SavedIndustryDirectory} from './SavedIndustryDirectory.js'
import type {IndustryTaskApi,IndustryTaskCreateInput} from './industry-task-api.js'
import type {IndustryPlanApi,IndustryPlanRequest} from './industry-plan-api.js'
import {IndustryPlanSourcePanel} from './IndustryPlanSourcePanel.js'
import type {SkillInstallApi} from './skill-install-api.js'
import {IndustryTaskSourcePanel} from './IndustryTaskSourcePanel.js'
import {mergeSavedIndustryLoad} from './saved-industry-loads.js'
import {RoleToolGrants} from './RoleToolGrants.js'
import type {RoleToolGrantApi} from './role-tool-grant-api.js'
import type {RoleDelegationApi,RoleDelegationRead} from './role-delegation-api.js'
import type {RoleWorkDirectory} from './role-work-directory.js'
import {TaskExecutions} from './TaskExecutions.js'
import {emptyTaskRunChatSource,taskRunSessionTitle,type TaskRunChatPresentationDirectory} from './task-run-chat-presentation.js'
import {AssistantConversationTitleContext} from './TaskRunChatPresentation.js'
import type {TaskRunApi} from './task-run-api.js'
import {TaskKnowledge} from './TaskKnowledge.js'
import type {TaskMaterialApi} from './task-material-api.js'
import type {ObjectConversationApi,SavedObjectLink} from './object-conversation-api.js'
import type {HandoffApi,TaskHandoff} from './handoff-api.js'
import type {RoleLifecycleApi} from './role-lifecycle-api.js'
import type {TaskTransitionApi} from './task-transition-api.js'
import type {PendingRequestApi,PendingRequest} from './pending-request-api.js'
import {PendingRequestReview} from './PendingRequestReview.js'
import {pendingRequestOperation} from './pending-request-copy.js'
import {projectSavedTask,type TaskApi,type TaskAssignee,type TaskAttentionItem} from './task-api.js'
import type {TaskCompletionPort} from './TaskCompletion.js'
import {mergeTaskAttention} from './task-attention-state.js'
import type {WorkAttentionApi} from './work-attention-api.js'
import type {BusinessWorkResultsApi} from './business-work-results-api.js'
import {useWorkAttention} from './use-work-attention.js'
import {WorkAttentionSourceView,type WorkAttentionOriginalSource} from './WorkAttentionSourceView.js'
import type {CreateEntryProps} from './CreateEntry.js'
import {ExtensionCreateEntry} from './ExtensionCreateEntry.js'
import {PageCreateShareConfirmation} from './PageCreateShareConfirmation.js'
import {applyPageCreatedBusinessDefinition} from './page-create-business-definition.js'
import {roleWriteDefinition} from '@teloa/contract'
import type {ArtifactApi} from './artifact-api.js'
import {objectKey,objectRefTarget,type BusinessTarget} from './business-preview.js'
import {businessTaskSourceMissing,shouldLoadBusinessTaskSource,withBusinessTaskSource} from './business-task-presentation.js'
import {shouldLoadGroupTaskSource,withGroupTaskSource} from './group-task-source-presentation.js'
import {ObjectConversations} from './ObjectConversations.js'
import {linkObjectConversation,unlinkObjectConversation,type ConversationObject,type ObjectConversationLink} from './object-conversations.js'
import type {Conversation,BusinessConversationBinding,BusinessObjectReference} from '@teloa/contract'
import type {HomeSkillSelection} from './prompt-preparation.js'
import type { HomeResourceSelection } from './home-resource-selection.js'
import { WorkspaceSearch } from './WorkspaceSearch.js'
import { presentConversations } from './work-presentation.js'
import {latestRoleConversation,roleCanStartConversation} from './role-conversation-selection.js'
import type { WorkspaceSearchResult } from './workspace-search.js'
import {searchableKnowledgeDocuments,type WorkspaceKnowledgeSearchEntry} from './workspace-search-knowledge.js'
import {loadWorkspaceCapabilitySearchDirectory,type WorkspaceCapabilitySearchRow} from './workspace-capability-search.js'
import { BusinessScopeProvider } from './business-scope-context.js'
import { BusinessHome } from './BusinessHome.js'
import type { CompositionTarget } from './industry-composition.js'
import {businessLedgerHomeShown,businessNavStep,businessPageEntryProps,businessPageVisible,businessTargetKey,nextBusinessEntry,openBusinessScopeSteps,openStaffOfScopeSteps,teamFocusScopeAfterView,type BusinessEntry,type BusinessNavSeen,type BusinessNavSignal} from './workbench-business-navigation.js'
import type { BusinessDataMode } from './business-page-mode.js'
import {localizedMarketItemCopy,marketEntryCategory,marketCategoryOf,marketItemGroup,type MarketCategory} from './market-home-presentation.js'
import { businessScopeNames,industryLoadScopeLabels,registeredBusinessScope,type BusinessScopeLabel,type BusinessSpaceRecord } from './business-directory.js'
import type {BusinessSpaceApi} from './business-space-api.js'
import type {BusinessScopeApi} from './business-scope-api.js'
import {activeDetailTarget,artifactDetailTarget,artifactPanelTarget,conversationLedgerNeeded,workbenchDetailSession,type WorkbenchDetailTarget} from './workbench-detail-target.js'
import {detailTargetToTab,tabToDetailTarget,TELOA_RAIL_KINDS,TELOA_TAB_KINDS,type TeloaTabKind,type TeloaTabSecondaryView} from './sidebar-right-tabs.js'
import {notifyTeloaTabHost,publishTeloaTabHost,retractTeloaTabHost,type TeloaTabHost} from './sidebar-right-tab-host.js'
import {CONVERSATION_OVERVIEW_KIND} from './ConversationOverviewTab.js'
import {createRailTabs,type RailTabs} from './sidebar-right-rail.js'
import {EvidenceList} from './EvidenceList.js'
import type {ISidebarRight} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import {leaseNativeFloatVisibility} from './native-float-visibility.js'
import { ArtifactPanel, type OpenArtifacts } from './ArtifactPanel.js'
import {artifactMethodReusePreparation,canPrepareArtifactMethodReuse} from './artifact-method-reuse-preparation.ts'
import type {MethodReuseTarget} from '@teloa/contract'
import { ApprovalNotesProvider } from './ApprovalNotes.js'
import { changeArtifactWork } from './artifact-work.js'
import { artifactListFetchKey,resolveArtifactSource } from './artifact-source.js'
import {saveConversationOverviewFile} from './conversation-overview-artifacts.js'
import type { ArtifactSourceRef } from './artifact-preview.js'
import type { NativeArtifactApi } from './artifact-native.js'
import type { ArtifactFileApi } from './artifact-files.js'
import type { CollaborationScope } from './collaboration-preview.js'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowLeft, ChevronRight, MessageSquare, MoreHorizontal, PanelLeft, Settings2, X } from 'lucide-react'
import { StaffAvatar } from './StaffAvatar.js'
import {WorkbenchHubNavigation,isWorkbenchHubView} from './WorkbenchNavigationChrome.js'
import { WorkNavigation,businessDashboardTitleKey } from './WorkNavigation.js'
import {usePersonalProfile} from './use-personal-profile.js'
import {CapabilityNotice,useApplicationCapability} from './CapabilityNotice.js'
import {applicationPresentation} from './application-presentation.js'
import {businessShortcutKey,personalBusinessShortcuts} from './personal-business-shortcuts.js'
import {aggregateAttentionItems,formalAttentionCount,openAttentionItem,type AttentionItem} from './attention-item.js'
import {localRecoveryItems} from './attention-local-recovery.js'
import {serverRecoveryItems} from './attention-server-recovery.js'
import {readRecoveryGroupDirectory,type RecoveryGroupDirectory} from './attention-recovery-group-directory.js'
import { CreateConversationDialog } from './CreateConversationDialog.js'
import { ConversationScopeDialog } from './ConversationScopeDialog.js'
import { ActionButton } from '@teloa/client-ui-kit'
import type { PropsRuntime, PropsRenderSlots, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { shouldFollowCurrentSession, type createWorkbenchStore, type WorkbenchView } from './store.js'
import {ContextDrawer} from './ContextDrawer.js'
import css from './WorkbenchFrame.module.css'
import twinCss from './TwinProfile.module.css'
import light from './light-actions.module.css'
import tokens from './theme-tokens.module.css'
import {EmployeeComputerPage} from './EmployeeComputerPage.js'
import {employeeComputerTarget,leaveEmployeeComputer} from './employee-computer-navigation.js'
import { registerCapabilitySelection, type CapabilitySelection, type WorkInjected } from './Capabilities.js'
import { viewRootAction } from './workbench-view-root.js'
import { WorkDirectory } from './WorkDirectory.js'
import type { ConversationSearch } from './conversation-search.js'
import type { ConversationManagement } from './conversation-management.js'
import { ResourceManager, type ResourceManagerNavigationState } from './ResourceManager.js'
import {homeConversationPrompt} from './home-work-mode.js'
import type { DigitalRole, GroupRules } from '@teloa/contract'
import type { RoleApi } from './role-api.js'
import type { RoleRuntimeConfigApi } from './role-runtime-config.js'
import type {RoleMemoryApi} from './role-memory-api.js'
import type {RoleDailyLogApi} from './role-daily-log-api.js'
import {publishSettingsPanelVisible} from './AutoDreamSettingsPage.js'
import {marketFunctionKeys,resolveLocalizedMetadata,roleSupportsScope} from '@teloa/contract'
import type { RoleFields,PreviewRole } from './role-preview.js'
import type { ResourceApi } from './resource-api.js'
import type { GroupApi } from './group-api.js'
import type {GroupWorkLinkApi} from './group-work-links-api.js'
import type { GroupAttachmentApi } from './group-attachment-api.js'
import type { GroupReactionApi } from './group-reaction-api.js'
import type { GroupRoutingApi } from './group-routing-api.js'
import {roleConversationIdentities} from './RoleConversationIdentity.js'
import type { BusinessLedgerApi } from './business-ledger-api.js'
import type { BusinessDashboardApi } from './business-dashboard-api.js'
import type { BusinessCustomizationApi } from './business-customization-api.js'
import type { ConnectorProbeApi } from './connector-probe-api.js'
import type {BusinessTaskApi,BusinessTaskRequest} from './business-task-api.js'
import {openSavedBusinessTask} from './business-task-flow.js'
import { WorkHome, type HomeCreationKind } from './WorkHome.js'
import {createConversationGroupDirectory} from './conversation-group-directory.js'
import { CollaborationPage, GroupForm, type GroupPanelPort } from './CollaborationPage.js'
import { emptyCollaboration } from './collaboration-preview.js'
import { changeTaskPreview, emptyTaskPreview } from './task-preview.js'
import { fixedPlanSource, planTemplate, templatePlanFields } from './plan-template.js'
import { ContinuousPage, RolePlans } from './ContinuousPage.js'
import { changeContinuousWork } from './continuous-work.js'
import { TaskPage } from './TaskPage.js'
import type {GroupChannelContext} from './GroupChannelBindings.js'
import type {RoleDailyLogPanelProps} from './RoleDailyLogPanel.js'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import { RoleForm, TeamPage } from './TeamPage.js'
import { rolePeople,roleName } from './role-preview.js'
import { TaskForm } from './TaskPage.js'
import { changeTeamPreview } from './team-preview.js'
import { roleFieldText, twinDisplayName } from './team-presentation.js'
import { planDisplayTitle } from './plan-source-presentation.js'
import { BusinessPage,BusinessDefinitionCreatePreview } from './BusinessPage.js'
import {createBusinessShareApi} from './business-share-flow.js'
import {createBusinessShareSource} from './business-share-source.js'
import { MarketPage, type MarketPageNavigationState } from './MarketPage.js'
import type {GithubSourceApi} from './github-source-api.js'
import type {MarketCatalogApi} from './market-catalog-api.js'
import type {SkillSecretsApi} from './skill-secrets-api.js'
import { marketTargets, checkMarketTarget, MarketTargetCheckError, type MarketTargetRef } from './market-target.js'
import { CapabilityTargetPanel } from './CapabilityTargetPanel.js'
import type {RuntimeExtensionReader} from './runtime-extensions.js'
import type {RuntimeText} from './RuntimeExtensionDetail.js'
import type { TeamCapabilitiesNavigationState } from './TeamCapabilitiesPage.js'
import { emptyMarket, saveMarketIntent, updateMarketIntent, marketPrompt, type MarketState, type MarketItem, type MarketIntent } from './market-preview.js'
import {currentSolutionCatalog} from './market-solution-presentation.js'
import type { PromptPreparation } from './prompt-preparation.js'
import type {PageCreateApi} from './page-create-api.js'
import {PageCreateRevisionContext,pageCreateDraftRevisionText,pageCreateDraftRevisionNavigation} from './page-create-revision-context.js'
import {planDraftConfirmLabel,type PlanDraftApi} from './plan-draft-api.js'
import {CreateEntry} from './CreateEntry.js'
import {ProjectWorkspace} from './ProjectWorkspace.js'
import type {ProjectConversationActions} from './ProjectRuntimePanel.js'
import type {ProjectConversationCreation,ProjectMemoryMode} from './project-runtime-api.js'
import {projectRuntimeCopy} from './project-runtime-copy.js'
import {offerProjectConversationWork,prepareProjectConversation} from './project-conversation-preparation.js'
import {ProjectConversationContext} from './ProjectConversationContext.js'
import {ProjectOverviewPage} from './ProjectOverviewPage.js'
import type {ProjectApi} from './project-api.js'
import {pageCreateAtomicSkillContent} from './page-create-skill-content.js'
import {pageCreateBusinessDomainIndustryItem,pageCreateConnectorIndustryItem} from './page-create-industry-content.js'
import {useI18n} from './i18n/provider.js'
import type {MarketPluginInstallApi} from './market-plugin-install-api.js'
import type {BundledExtensionsApi} from './bundled-extensions-api.js'
import {localizeWorkError} from './i18n/errors.js'
import {browserConversationWorkspacePreferenceStore,resolveConversationWorkspace} from './conversation-workspace-resolution.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'
import {captureWorkbenchNavigationState,persistWorkbenchNavigationState,readDirectoryFilterCategory,reconcileAvailableDirectoryTarget,writeDirectoryFilterCategory,type WorkbenchDirectoryId,type WorkbenchDirectoryNavigation,type WorkbenchDirectoryPatch} from './workbench-navigation-state.js'
import {directoryScroller,directoryScrollTopForEvent,visibleDirectoryPane} from './directory-focus.js'
import type {MainSessionSource} from './main-session.js'
import {blankNewConversation,conversationAtLocation,draftCarry,moveTextDraft,readBlankNewConversation,rememberBlankNewConversation,type DraftInputPort} from './blank-conversation-draft.js'
import {canShowConversationOverview,collapseOverviewWithoutRoom,collapseRightbarForDirectory,defaultRightbarWidth,directoryNeedsRoom,directoryShown,groupPanelReport,readRightbarWidth,resizeRightbarWidth,rightbarCanShow,rightbarDirectoryForOpening,rightbarHandleVisible,rightbarTrackWidth,rightbarWidthRange,stepRightbarWidth,writeRightbarWidth} from './rightbar-width.js'

/** 把手的 aria-controls 要指向第三栏轨道，整个外壳只有一条轨道，用固定 id 即可。 */
const DETAILS_TRACK_ID='teloa-details-track'
const dutyLead=(value:string)=>value.split(/[。.!?！？\n]/)[0]?.trim()??''

type Props = {assistantActivity:AssistantCompanionActivity;assistantChat?:AssistantMiniChatPort;groupWorkLinks?:GroupWorkLinkApi;employeeVoiceApi?:EmployeeVoiceApi;insertAssistantVoiceText?:(draft:AssistantVoiceDraft)=>Promise<void>;groupChannels?:GroupChannelContext;navigationStorage:WorkbenchNavigationStorage} & PropsRuntime<'root'> & PropsRenderSlots<'sidebar'|'main'|'rightbar'|'shell.overlay'|'teloa.workbench.toolbar'|'teloa.conversation'> & PropsStore<ReturnType<typeof createWorkbenchStore>> & WorkInjected & {runtimeSettings:RuntimeSettingsSurface;runtimeExtensions:RuntimeExtensionReader;resolveExtensionText:(text:RuntimeText)=>string;mainSession:MainSessionSource;beginNativeNavigation?:()=>AbortSignal;leaseSidebarToggle?:((toggle:()=>void)=>()=>void);openNativePanel:(id:string)=>void;openLocalModels?:(entryId:string)=>void;setTheme:(value:'light'|'dark')=>void;sidebarRightFace:()=>ISidebarRight|undefined;management:ConversationManagement;conversationSearch:ConversationSearch;planApi:PlanApi;conversationPlans:ConversationPlanDirectory;workControlApi:WorkControlApi;marketContentApi:MarketContentApi;marketCatalogApi:MarketCatalogApi;managedMcpConnectionApi?:ManagedMcpConnectionApi;createBusinessDashboardResources?:(namespace:string,token:BusinessBuilderApi)=>BusinessDashboardResourceApi;createBusinessMcpConnection?:(namespace:string,token:BusinessBuilderApi)=>ManagedMcpConnectionApi;skillSecretsApi:SkillSecretsApi;githubSourceApi:GithubSourceApi;industryLoadApi:IndustryLoadApi;industryKnowledgeApi:IndustryKnowledgeApi;industryDataSourceApi:IndustryDataSourceApi;industryExecutionToolApi:IndustryExecutionToolApi;industryMcpConnectionApi:IndustryMcpConnectionApi;industryPluginApi:IndustryPluginApi;industryRoleApi:IndustryRoleApi;industryTaskApi:IndustryTaskApi;industryPlanApi:IndustryPlanApi;skillInstallApi:SkillInstallApi;marketPluginInstallApi:MarketPluginInstallApi;bundledExtensionsApi:BundledExtensionsApi;skillAvailabilityApi:SkillAvailabilityApi;skillUpgradeApi:SkillUpgradeApi;localRetrievalApi?:LocalRetrievalApi|undefined;resourceApi:ResourceApi;roleApi:RoleApi;roleWorkDirectory:RoleWorkDirectory;memoryApi:RoleMemoryApi;dailyLogApi:RoleDailyLogApi;runtimeConfigApi:RoleRuntimeConfigApi;taskApi:TaskApi;workAttentionApi:WorkAttentionApi;attentionBusinessApi:BusinessWorkResultsApi;workAttentionConnection:{getSnapshot:()=>unknown;subscribe:(listener:()=>void)=>()=>void};projectApi:ProjectApi;taskRunApi:TaskRunApi;taskRunChat?:TaskRunChatPresentationDirectory;securityActionApi:SecurityActionApi;taskMaterialApi:TaskMaterialApi;taskTransitions:TaskTransitionApi;pendingRequestApi:PendingRequestApi;roleLifecycle:RoleLifecycleApi;roleToolGrantApi:RoleToolGrantApi;roleDelegationApi:RoleDelegationApi;handoffApi:HandoffApi;objectConversationApi:ObjectConversationApi;groupApi:GroupApi;groupAttachmentApi:GroupAttachmentApi;groupReactionApi:GroupReactionApi;groupRoutingApi:GroupRoutingApi;businessLedgerApi:BusinessLedgerApi;businessDashboardApi:BusinessDashboardApi;businessCustomizationApi:BusinessCustomizationApi;connectorProbeApi:ConnectorProbeApi;businessTaskApi:BusinessTaskApi;businessSpaceApi:BusinessSpaceApi;businessScopeApi:BusinessScopeApi;businessBuilder?:BusinessBuilderController;createBusinessRecordFlow?:()=>BusinessRecordFlow;createBusinessImportFlow?:(namespace:string,token:BusinessBuilderApi,scope:string,type:string)=>BusinessImportFlow;createBusinessResponsibility?:(namespace:string,token:BusinessBuilderApi)=>BusinessResponsibilityApi;createBusinessTaskList?:(namespace:string,token:BusinessBuilderApi)=>BusinessTaskListApi;createBusinessSetup?:(namespace:string,token:BusinessBuilderApi)=>BusinessSetupApi;insertBusinessRecord?:(reference:BusinessObjectReference,sessionId:string,token:BusinessBuilderApi,mayInsert:()=>boolean)=>Promise<void>;pageCreateApi:PageCreateApi;planDraftApi:PlanDraftApi;preparation:PromptPreparation;sendConversationMessage:(sessionId:string,text:string)=>void;conversationDraftInput:(sessionId:string)=>DraftInputPort|undefined;prepareHomeSession:(signal:AbortSignal)=>Promise<string|undefined>;homeContextApi:HomeContextApi;insertConversationCapabilities:(selection:CapabilitySelection)=>void;nativeArtifacts:NativeArtifactApi;artifactFileApi:ArtifactFileApi;artifactApi:ArtifactApi}
type SidebarProps=PropsRuntime<'sidebar'>&PropsRenderSlots<'sidebar.settings'|'sidebar.workspaces'>
type ConversationContinuation={current:()=>boolean;opened:(sessionId:string)=>void}
type CreationIntent={continuation?:ConversationContinuation;pagePreparation?:true;projectConversation?:ProjectConversationCreation;projectCurrent?:()=>boolean;reject?:(error:unknown)=>void;signal?:AbortSignal;assistant?:boolean;builder?:boolean;daily?:{scope:string;title:string;newConversation?:boolean;record?:BusinessObjectReference};navigationToken?:BusinessNavigationToken;allowDraft?:boolean;object?:ConversationObject;goal?:string;scope?:CollaborationScope;resources?:HomeResourceSelection[];skills?:HomeSkillSelection[];notice?:string;resolve?:(accepted:boolean)=>void}
type RoleScopeIntent={object:ConversationObject;scopes:readonly CollaborationScope[];goal?:string}
export function WorkbenchSidebar({renderSlot}:SidebarProps){
  // 保留工作区 slot 声明权；Teloa 的会话目录继续在工作区主体内呈现。
  return renderSlot('sidebar.settings',{wide:true})
}

/** 与主面板互斥：直接订阅同一外壳状态，隐藏设置时卸载官方管理器而非仅用 CSS 隐藏。 */
function RuntimeSettingsMain({useStore,renderSlot}:Pick<Props,'useStore'|'renderSlot'>){
 const visible=useStore(state=>state.view==='settings'&&state.panelInfo.activePanelId===null)
 return visible?renderSlot('main',{}, {entryKey:'plugins'}):null
}

const noBuilder:ReturnType<BusinessBuilderController['getSnapshot']>={nativeReady:false,sessionKind:null,daily:null,dailyPending:null,api:null,status:'loading' as const,flow:null,namespace:null,checkedSessionId:undefined,error:null}
const noSubscribe=()=>()=>{}
const noBuilderSnapshot=()=>noBuilder
const noBuilderFlowSnapshot=()=>null

const readMarketNavigation=(raw:string|undefined)=>{
 const fields=readDirectoryFilterCategory(raw,{category:'home',mobileLayer:'category',appsMine:'',appsCategory:'all'},{category:['home','employees','teams','apps','intents','resources','industry','dashboard','agent','skill','plugin','connector','model','knowledge','work-template'],mobileLayer:['category','list','detail'],appsMine:['true','false'],appsCategory:['all',...marketFunctionKeys]})
 return {...fields,appsMine:fields.appsMine===''?fields.category==='resources':fields.appsMine==='true'} as Pick<MarketPageNavigationState,'category'|'mobileLayer'|'appsMine'|'appsCategory'>
}

export function WorkbenchFrame({assistantActivity,assistantChat,groupWorkLinks,employeeVoiceApi,insertAssistantVoiceText,groupChannels,navigationStorage,openLocalModels,runtimeSettings,runtimeExtensions,resolveExtensionText,setTheme,sidebarRightFace,mainSession,beginNativeNavigation,leaseSidebarToggle,openNativePanel,useStore,useSessions,actions,renderSlot,work,management,conversationSearch,planApi,conversationPlans,workControlApi,marketContentApi,marketCatalogApi,managedMcpConnectionApi,createBusinessDashboardResources,createBusinessMcpConnection,skillSecretsApi,githubSourceApi,industryLoadApi,industryKnowledgeApi,industryDataSourceApi,industryExecutionToolApi,industryMcpConnectionApi,industryPluginApi,industryRoleApi,industryTaskApi,industryPlanApi,skillInstallApi,marketPluginInstallApi,bundledExtensionsApi,skillAvailabilityApi,skillUpgradeApi,localRetrievalApi,resourceApi,roleApi,roleWorkDirectory,memoryApi,dailyLogApi,runtimeConfigApi,taskApi,workAttentionApi,attentionBusinessApi,workAttentionConnection,projectApi,taskRunApi,taskRunChat,securityActionApi,taskMaterialApi,taskTransitions,pendingRequestApi,roleLifecycle,roleToolGrantApi,roleDelegationApi,handoffApi,objectConversationApi,groupApi,groupAttachmentApi,groupReactionApi,groupRoutingApi,businessLedgerApi,businessDashboardApi,businessCustomizationApi,connectorProbeApi,businessTaskApi,businessSpaceApi,businessScopeApi,businessBuilder,createBusinessRecordFlow,createBusinessImportFlow,createBusinessResponsibility,createBusinessTaskList,createBusinessSetup,insertBusinessRecord,pageCreateApi,planDraftApi,preparation,sendConversationMessage,conversationDraftInput,prepareHomeSession,homeContextApi,insertConversationCapabilities,nativeArtifacts,artifactFileApi,artifactApi}: Props) {
  useLayoutEffect(()=>runtimeSettings.attach(()=> <RuntimeSettingsMain useStore={useStore} renderSlot={renderSlot}/>),[runtimeSettings,useStore,renderSlot])
  const projectConnection=useRef({projectApi,homeContextApi,work,preparation})
  if(projectConnection.current.projectApi!==projectApi||projectConnection.current.homeContextApi!==homeContextApi||projectConnection.current.work!==work||projectConnection.current.preparation!==preparation)projectConnection.current={projectApi,homeContextApi,work,preparation}
  const projectFrameMounted=useRef(true)
  useEffect(()=>{projectFrameMounted.current=true;return()=>{projectFrameMounted.current=false}},[])
  const {locale,t}=useI18n()
  const labels: Record<WorkbenchView,string> = {home:t('navigation.home'),attention:t('navigation.attention'),messages:t('navigation.v2.conversations'),team:t('navigation.v2.colleagues'),spaces:t('navigation.v2.business'),market:t('market.title'),resources:t('navigation.v2.library'),tasks:t('navigation.tasks'),plans:t('navigation.plans'),projects:t('navigation.projects'),settings:t('navigation.v2.settings')}
  const state=useStore(value=>value)
  const attentionGeneration=useSyncExternalStore(listener=>workAttentionConnection.subscribe(listener),()=>workAttentionConnection.getSnapshot())
  const attentionIdentity=useMemo(()=>({work,generation:attentionGeneration}),[work,attentionGeneration])
  const workAttention=useWorkAttention(workAttentionApi,attentionIdentity)
  const [attentionSourceSelection,setAttentionSourceSelection]=useState<{source:WorkAttentionOriginalSource;identity:typeof attentionIdentity}>()
  const attentionOriginalSource=attentionSourceSelection?.identity===attentionIdentity?attentionSourceSelection.source:undefined
  const planDraftConnection=useMemo(()=>({planDraftApi,pageCreateApi,planApi,conversationPlans,attentionIdentity}),[planDraftApi,pageCreateApi,planApi,conversationPlans,attentionIdentity])
  const planDraftEntry=JSON.stringify([state.view,state.detail,state.rolePreview])
  const planDraftFrame=useRef({connection:planDraftConnection,selection:attentionSourceSelection,entry:planDraftEntry})
  planDraftFrame.current={connection:planDraftConnection,selection:attentionSourceSelection,entry:planDraftEntry}
  const [planDraftOpenError,setPlanDraftOpenError]=useState<{connection:typeof planDraftConnection;message:string}>()
  useEffect(()=>{
    let live=true,request=0
    const off=planDraftApi.onOpen(value=>{
      const draft={...value}
      const origin=planDraftFrame.current,sequence=++request
      const current=()=>live&&request===sequence&&planDraftFrame.current.connection===origin.connection&&planDraftFrame.current.selection===origin.selection&&planDraftFrame.current.entry===origin.entry
      setPlanDraftOpenError(undefined)
      void (async()=>{
        if(draft.entity!=='plan'||draft.status!=='draft')throw Object.assign(Error(),{code:'teloa/version-conflict'})
        const read=await pageCreateApi.read({draftId:draft.id})
        if(!current())return
        if(read.ownerId!==draft.ownerId||read.id!==draft.id||read.entity!=='plan'||read.status!=='draft'||read.scope!==draft.scope||read.bodyHash!==draft.bodyHash||read.body!==draft.body)throw Object.assign(Error(),{code:'teloa/version-conflict'})
        setAttentionSourceSelection({source:{kind:'page-create-draft',entity:'plan',draftId:read.id,bodyHash:read.bodyHash,...(read.scope===undefined?{}:{scope:read.scope})},identity:attentionIdentity})
      })().catch(error=>{if(current())setPlanDraftOpenError({connection:origin.connection,message:localizeWorkError(locale,error)})})
    })
    return()=>{live=false;off()}
  },[planDraftConnection])

  useEffect(()=>{
    if(!['home','tasks','attention','spaces','messages'].includes(state.view))return
    void workAttention.reload()
  },[state.view,workAttention.reload])
  const [voiceTarget,setVoiceTarget]=useState<VoiceCallTarget>()
  const currentVoice=useRef<{target:VoiceCallTarget|undefined;ended:boolean}>({target:undefined,ended:false})
  const voiceListeners=useRef(new Set<()=>void>())
  const selectVoiceTarget=(target:VoiceCallTarget|undefined)=>{currentVoice.current={target,ended:false};setVoiceTarget(target);voiceListeners.current.forEach(listener=>listener())}

  const voiceRoleId=voiceTarget?.kind==='role'?voiceTarget.id:undefined
  const voiceOpening=useRef(false)
  const [voiceSelectionReady,setVoiceSelectionReady]=useState(false),[voiceSessionId,setVoiceSessionId]=useState<string>()

  const [computerRoleId,setComputerRoleId]=useState(()=>employeeComputerTarget(location.href))
  const leaveComputer=()=>{history.replaceState(history.state,'',leaveEmployeeComputer(location.href));setComputerRoleId(null)}
  const [nativePanelError,setNativePanelError]=useState<string>()
  const openNativePlugins=()=>{try{openNativePanel('plugins');setNativePanelError(undefined)}catch(cause){setNativePanelError(localizeWorkError(locale,cause))}}
  const openNativeModels=()=>{try{openNativePanel('models');setNativePanelError(undefined)}catch(cause){setNativePanelError(localizeWorkError(locale,cause))}}
  // 广播设置页是否当前可见给 AutoDreamSettings（见其定义处的第三轮修复说明）：承载设置面板的
  // <section> 只用 CSS 隐藏、从不随 view 切换卸载，AutoDreamSettings 拿不到这个信号就没法知道
  // 该不该重新拉取全量计划。
  useEffect(()=>{publishSettingsPanelVisible(state.view==='settings'&&state.panelInfo.activePanelId===null)},[state.view,state.panelInfo.activePanelId])
  const restoredDetailView=state.detail.target?.kind==='directory-object'?state.detail.target.view:undefined
  const restorePending=useRef({tasks:!!state.navigationDirectories.tasks?.selectedId||restoredDetailView==='tasks',team:!!state.navigationDirectories.team?.selectedId||restoredDetailView==='team',market:!!state.navigationDirectories.market?.selectedId||restoredDetailView==='market',spaces:!!state.navigationDirectories.spaces?.category||restoredDetailView==='spaces',plans:!!state.navigationDirectories.plans?.category||restoredDetailView==='plans'})
  const frameRef=useRef<HTMLDivElement>(null)
  const latestState=useRef(state);latestState.current=state
  const navigationDirectory:WorkbenchDirectoryId|undefined=state.view==='attention'?'tasks':(['tasks','team','resources','market','spaces','plans','projects'] as const).find(id=>id===state.view)
  const directoryScrollFrame=useRef<number>(),pendingDirectoryScroll=useRef<{id:WorkbenchDirectoryId;top:number}>()
  const flushDirectoryScroll=(persist=false)=>{
    const pending=pendingDirectoryScroll.current
    if(directoryScrollFrame.current!==undefined){cancelAnimationFrame(directoryScrollFrame.current);directoryScrollFrame.current=undefined}
    if(!pending)return
    pendingDirectoryScroll.current=undefined;actions.rememberDirectory(pending.id,{scrollTop:pending.top})
    if(persist){const snapshot=captureWorkbenchNavigationState(latestState.current);persistWorkbenchNavigationState(navigationStorage,{...snapshot,directories:{...snapshot.directories,[pending.id]:{...snapshot.directories[pending.id],scrollTop:pending.top}}})}
  }
  useEffect(()=>{const pagehide=()=>flushDirectoryScroll(true);window.addEventListener('pagehide',pagehide);return()=>{window.removeEventListener('pagehide',pagehide);flushDirectoryScroll(true)}},[navigationDirectory,actions,navigationStorage])
  useLayoutEffect(()=>{
    if(!navigationDirectory)return
    const top=state.navigationDirectories[navigationDirectory]?.scrollTop
    if(top===undefined)return
    let complete=false,retry:number|undefined
    const deadline=Date.now()+3000
    const restore=()=>{
      const pane=visibleDirectoryPane(frameRef.current)
      if(pane){
        const scroller=directoryScroller(pane)
        const maximum=Math.max(0,scroller.scrollHeight-scroller.clientHeight)
        scroller.scrollTop=Math.min(top,maximum)
        if(maximum>=top)complete=true
      }
      if(!complete&&Date.now()<deadline)retry=window.setTimeout(restore,50)
    }
    const frame=requestAnimationFrame(restore)
    return()=>{cancelAnimationFrame(frame);if(retry!==undefined)window.clearTimeout(retry)}
  },[navigationDirectory,state.taskId,state.roleId,state.resourceTarget,state.capabilityBindingId,state.marketItemId,state.businessTarget,state.continuousTarget,state.detail.open])
  const rememberDirectoryScroll=(event:import('react').UIEvent<HTMLDivElement>)=>{if(!navigationDirectory)return;const pane=visibleDirectoryPane(frameRef.current);if(!pane)return;const top=directoryScrollTopForEvent(pane,event.target);if(top===undefined)return;pendingDirectoryScroll.current={id:navigationDirectory,top};if(directoryScrollFrame.current===undefined)directoryScrollFrame.current=requestAnimationFrame(()=>flushDirectoryScroll())}
  const current=useSyncExternalStore(mainSession.subscribe,mainSession.getSnapshot)
  const builderState=useSyncExternalStore(businessBuilder?.subscribe??noSubscribe,businessBuilder?.getSnapshot??noBuilderSnapshot)
  const builderFlow=builderState.flow
  const dailyValue=useSyncExternalStore(builderState.daily?.subscribe??noSubscribe,builderState.daily?.getSnapshot??noBuilderFlowSnapshot)
  const businessReady=builderState.status==='ready'&&builderState.nativeReady
  const [recordPreparation,setRecordPreparation]=useState<{reference:BusinessObjectReference;title:string;api:BusinessBuilderApi;sessionId?:string}>(),[recordInsertBusy,setRecordInsertBusy]=useState(false),[recordInsertError,setRecordInsertError]=useState(false)
  const recordPreparationRef=useRef(recordPreparation);recordPreparationRef.current=recordPreparation
  useEffect(()=>{setRecordPreparation(current=>current?.api===builderState.api?current:undefined);setRecordInsertError(false)},[builderState.api])
  const [dailyError,setDailyError]=useState<string>(),[dailyBusy,setDailyBusy]=useState(false)
  const dailyRetry=useRef<()=>void>(()=>{})
  useEffect(()=>{setDailyError(undefined);dailyRetry.current=()=>{}},[current,builderState.daily])
  const dailyPending=builderState.dailyPending??(dailyValue?.phase==='pending'?dailyValue.binding:null)
  // 全局归属核对失败由 controller.retry 负责；不能复用旧日常操作的重试闭包。
  const dailyStatus=builderState.error?null:<BusinessDailyStatus busy={dailyBusy||dailyValue?.phase==='creating'||dailyValue?.phase==='loading'} pending={dailyPending} error={dailyError??(dailyValue?.error?localizeWorkError(locale,dailyValue.error):undefined)} disabled={!businessReady} recover={()=>recoverDaily(dailyPending?.requestId)} retry={()=>dailyRetry.current()}/>
  const builderValue=useSyncExternalStore(builderFlow?.subscribe??noSubscribe,builderFlow?.getSnapshot??noBuilderFlowSnapshot)
  const [builderTab,setBuilderTab]=useState<'conversation'|'preview'>('conversation')
  const [builderError,setBuilderError]=useState<string>(),[builderSwitch,setBuilderSwitch]=useState<{token:BusinessNavigationToken;switching:boolean;proceed:()=>void}>()
  const builderVisible=!!builderValue?.binding&&builderValue.binding.kind==='builder'&&(builderValue.binding.sessionId===current||!builderValue.binding.sessionId&&builderState.checkedSessionId===current)&&(state.view==='home'||state.view==='messages'&&state.messageMode==='native')
  useEffect(()=>{setBuilderTab('conversation')},[current])

  const assistantOpening=useRef(false)
  const companionActivity=useSyncExternalStore(assistantActivity.subscribe,assistantActivity.getSnapshot,assistantActivity.getSnapshot)
  const [assistantActive,setAssistantActive]=useState(()=>{try{return navigationStorage.getItem('teloa.assistant-visible/v1')==='true'}catch{return false}})
  const setCompanionActive=(active:boolean)=>{setAssistantActive(active);try{navigationStorage.setItem('teloa.assistant-visible/v1',String(active))}catch{/* 仅偏好不可写时仍允许本页使用。 */}}
  const homeManagement=useSyncExternalStore(management.subscribe,management.getSnapshot)
  const [homeSessionId,setHomeSessionId]=useState<string>(),[homeInputError,setHomeInputError]=useState<'restore'|'location'>(),[homeRetry,setHomeRetry]=useState(0)
  useEffect(()=>{
    if(state.view!=='home'||!homeManagement.ready)return
    if(businessBuilder&&current&&builderState.checkedSessionId!==current)return
    if(businessBuilder&&builderState.error)return
    if((builderState.sessionKind!==null||builderVisible)&&current){setHomeSessionId(current);setHomeInputError(undefined);return}
    const controller=new AbortController()
    setHomeSessionId(undefined);setHomeInputError(undefined)
    void prepareHomeSession(controller.signal).then(id=>{if(!controller.signal.aborted)setHomeSessionId(id)}).catch(cause=>{if(!controller.signal.aborted)setHomeInputError(cause&&typeof cause==='object'&&cause.code==='teloa/home-location-required'?'location':'restore')})
    return()=>controller.abort()
  },[state.view,homeRetry,prepareHomeSession,homeManagement.ready,businessBuilder,current,builderState.checkedSessionId,builderState.sessionKind,builderState.error,builderVisible])

  const title=useSessions(value=>current?value.byId[current]?.displayTitle:undefined)
  const taskChatSource=current&&taskRunChat?taskRunChat.forSession(current):emptyTaskRunChatSource
  const taskChatSnapshot=useSyncExternalStore(taskChatSource.subscribe,taskChatSource.getSnapshot,taskChatSource.getSnapshot)
  useEffect(()=>{if(taskChatSnapshot.status==='idle')void taskChatSource.load()},[taskChatSource,taskChatSnapshot.status])
  const pageSessionTitle=taskRunSessionTitle(title,current,taskChatSnapshot.value)
  const conversationTitle=useSessions(value=>current?value.byId[current]?.title:undefined)
  const binding=useSyncExternalStore(work.subscribe,work.getSnapshot)
  useEffect(()=>{void businessBuilder?.followSession(current)},[current,businessBuilder,builderFlow,binding.sessionId,binding.status])
  const assistantCurrent=!!current&&binding.status==='ready'&&binding.conversation?.sessionId===current&&binding.conversation.purpose==='assistant'
  const [dialogueOrganization]=useState(browserDialogueOrganization)
  const dialoguePreferences=useSyncExternalStore(dialogueOrganization.subscribe,dialogueOrganization.getSnapshot)
  const assistantName=dialoguePreferences.assistantName
  useEffect(()=>{window.addEventListener('storage',dialogueOrganization.refresh);return()=>window.removeEventListener('storage',dialogueOrganization.refresh)},[dialogueOrganization])
  const profile=usePersonalProfile()
  const peopleAllowed=useApplicationCapability('people')
  const [workspaceSearchOpen,setWorkspaceSearchOpen]=useState(false)
  const [workspaceSearchKnowledge,setWorkspaceSearchKnowledge]=useState<WorkspaceKnowledgeSearchEntry[]>([]),[workspaceSearchKnowledgeStatus,setWorkspaceSearchKnowledgeStatus]=useState<'idle'|'loading'|'ready'|'failed'>('idle'),workspaceSearchKnowledgeGeneration=useRef(0)
  const [workspaceSearchCapabilities,setWorkspaceSearchCapabilities]=useState<WorkspaceCapabilitySearchRow[]>([]),[workspaceSearchCapabilityStatus,setWorkspaceSearchCapabilityStatus]=useState<'idle'|'loading'|'ready'|'failed'>('idle'),workspaceSearchCapabilityGeneration=useRef(0)
  const loadWorkspaceSearchKnowledge=async()=>{
    const generation=++workspaceSearchKnowledgeGeneration.current;setWorkspaceSearchKnowledgeStatus('loading')
    try{
      const [directory,sources,tree]=await Promise.all([resourceApi.directory(),resourceApi.sources(),resourceApi.knowledgeTree()])
      if(generation!==workspaceSearchKnowledgeGeneration.current)return
      setWorkspaceSearchKnowledge(searchableKnowledgeDocuments(tree,directory,sources));setWorkspaceSearchKnowledgeStatus('ready')
    }catch{if(generation===workspaceSearchKnowledgeGeneration.current)setWorkspaceSearchKnowledgeStatus('failed')}
  }
  useEffect(()=>{if(workspaceSearchOpen)void loadWorkspaceSearchKnowledge()},[workspaceSearchOpen,resourceApi])
  const loadWorkspaceSearchCapabilities=async()=>{
    const generation=++workspaceSearchCapabilityGeneration.current;setWorkspaceSearchCapabilities([]);setWorkspaceSearchCapabilityStatus('loading')
    const before=work.getSnapshot()
    if(before.status==='ready')await work.readCatalog()
    const current=work.getSnapshot(),snapshot=current.catalogStatus==='ready'?current.capabilities:undefined
    const directory=await loadWorkspaceCapabilitySearchDirectory({skillInstallApi,skillAvailabilityApi,pluginInstallApi:marketPluginInstallApi,...(snapshot?{snapshot}:{})})
    if(generation!==workspaceSearchCapabilityGeneration.current)return
    setWorkspaceSearchCapabilities(directory.rows)
    setWorkspaceSearchCapabilityStatus(directory.failures.length||before.status==='ready'&&current.catalogStatus==='failed'?'failed':'ready')
  }
  useEffect(()=>{if(workspaceSearchOpen)void loadWorkspaceSearchCapabilities()},[workspaceSearchOpen,work,skillInstallApi,skillAvailabilityApi,marketPluginInstallApi])
  const [viewportWidth,setViewportWidth]=useState(()=>window.innerWidth)
  // 群页按群身份上报的群侧栏实际展开状态，以及本人打开目录时发出的收起请求；只用于渲染期让出共享目录，不读写群偏好。
  const [groupPanelOpenId,setGroupPanelOpenId]=useState<string>()
  const [groupPanelCollapse,setGroupPanelCollapse]=useState<GroupPanelPort['collapse']>()
  const reportGroupPanel=useMemo(()=>(groupId:string,open:boolean)=>setGroupPanelOpenId(current=>groupPanelReport(current,groupId,open)),[])
  const groupPanelPort=useMemo<GroupPanelPort>(()=>({report:reportGroupPanel,collapse:groupPanelCollapse}),[reportGroupPanel,groupPanelCollapse])
  useEffect(()=>{const resize=()=>setViewportWidth(window.innerWidth);window.addEventListener('resize',resize);return()=>window.removeEventListener('resize',resize)},[])
  // 第三栏宽度：状态只存用户偏好，轨道实际宽度与 canShow 一律在渲染期从偏好夹出来。
  // 不能把重夹放进 useEffect：DSH RightbarSeat 用 useLayoutEffect 读 canShow，
  // 提交顺序是「子 layout effect 先于父 passive effect」，父组件还没重夹，
  // DSH 已经拿着上一帧的宽度判定放不下并 setExpanded(false)，"夹窄"就变成了"关栏"。
  const [detailsPreferred,setDetailsPreferred]=useState(()=>readRightbarWidth(localStorage,window.innerWidth))
  const [detailsDragging,setDetailsDragging]=useState(false)
  // 右栏按「目录此刻是否占轨道」取宽：窄桌面目录让位时右栏可用让出的空间，本人的目录选择不变。
  const detailsDirectoryOpen=rightbarDirectoryForOpening(viewportWidth,state.directoryOpen)
  const detailsWidth=rightbarTrackWidth(detailsPreferred,viewportWidth,detailsDirectoryOpen)
  const detailsRange=rightbarWidthRange(viewportWidth,detailsDirectoryOpen)
  // 先向原生座位提供可完成的空间方案，避免其子 layout effect 先把刚打开的栏收起。
  const detailsCanShow=rightbarCanShow(viewportWidth,detailsDirectoryOpen,detailsWidth)
  const detailsHandleVisible=rightbarHandleVisible(viewportWidth)
  // 拖拽期间视口或会话目录仍可能变化，闭包锁死开始时的布局会把宽度夹进过期的范围。
  const detailsLayout=useRef({viewportWidth,directoryOpen:detailsDirectoryOpen})
  useEffect(()=>{detailsLayout.current={viewportWidth,directoryOpen:detailsDirectoryOpen}})
  const stopDetailsDrag=useRef<(()=>void)|null>(null)
  useEffect(()=>()=>{stopDetailsDrag.current?.()},[])
  const rememberDetailsWidth=(width:number)=>{setDetailsPreferred(width);writeRightbarWidth(localStorage,width)}
  const dragDetails=(event:import('react').PointerEvent<HTMLButtonElement>)=>{
    if(event.button!==0)return
    // 不写 preventDefault：那会让把手拿不到焦点，接不上键盘调节；拖拽期的选区由 .dragging 抑制。
    const handle=event.currentTarget,startX=event.clientX,startWidth=detailsWidth
    let width=startWidth
    handle.focus()
    // 捕获指针并把监听挂回把手：挂 window 时文档预览的 iframe 会吞掉 pointermove/pointerup，脱手且不解绑。
    handle.setPointerCapture(event.pointerId)
    const move=(moved:PointerEvent)=>{
      const layout=detailsLayout.current
      width=resizeRightbarWidth(startWidth,moved.clientX-startX,layout.viewportWidth,layout.directoryOpen)
      setDetailsPreferred(width)
    }
    const stop=()=>{
      handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',stop);handle.removeEventListener('pointercancel',stop)
      if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId)
      stopDetailsDrag.current=null;setDetailsDragging(false);writeRightbarWidth(localStorage,width)
    }
    handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',stop);handle.addEventListener('pointercancel',stop)
    stopDetailsDrag.current=stop;setDetailsDragging(true)
  }
  const restoreDetailsWidth=()=>{rememberDetailsWidth(defaultRightbarWidth(viewportWidth))}
  const stepDetails=(event:import('react').KeyboardEvent<HTMLButtonElement>)=>{
    // Enter 是双击的键盘等价物：恢复默认宽度。
    if(event.key==='Enter'){event.preventDefault();restoreDetailsWidth();return}
    const next=stepRightbarWidth(detailsWidth,event.key,viewportWidth,detailsDirectoryOpen)
    if(next===null)return
    event.preventDefault();rememberDetailsWidth(next)
  }
  const searchDirectory=useSyncExternalStore(work.subscribe,work.getDirectorySnapshot)
  const searchManagement=useSyncExternalStore(management.subscribe,management.getSnapshot)
  const searchNative=useSessions(value=>value.byId)
  useEffect(()=>{
    let disposed=false,generation=0
    const verify=()=>{
      const token=++generation
      const directory=work.getDirectorySnapshot(),owner=management.getSnapshot()
      if(!owner.ready||directory.status!=='ready'){assistantActivity.invalidate();return}
      void findAssistantConversation({storage:navigationStorage,conversations:directory.rows,archived:owner.archived,read:homeContextApi.read}).then(row=>{
        if(!disposed&&token===generation&&management.getSnapshot()===owner&&work.getDirectorySnapshot()===directory)assistantActivity.setSession(row?.sessionId)
      },()=>{if(!disposed&&token===generation)assistantActivity.invalidate()})
    }
    verify()
    const off=[work.subscribe(verify),management.subscribe(verify),homeContextApi.subscribe(verify)]
    return()=>{disposed=true;generation++;for(const dispose of off)dispose();assistantActivity.invalidate()}
  },[assistantActivity,work,management,navigationStorage,homeContextApi])

  const messageContextMenu=useRef<HTMLDetailsElement>(null)
  const canViewConversationArtifacts=!!current&&binding.status==='ready'&&binding.conversation?.sessionId===current
  const previous=useRef(current)
  const [creating,setCreating]=useState(false)
  const [creationIntent,setCreationIntent]=useState<CreationIntent|null>(null)
  const [roleScopeIntent,setRoleScopeIntent]=useState<RoleScopeIntent|null>(null)
  const [workspaceSelection,setWorkspaceSelection]=useState(false)
  const [creationMode,setCreationMode]=useState<'create'|'chooseWorkspace'>('create')
  const [creationError,setCreationError]=useState<string>()
  const workspacePreferences=useMemo(browserConversationWorkspacePreferenceStore,[])
  const [homeCreation,setHomeCreation]=useState<HomeCreationKind|null>(null)
  const [homeTaskGroupId,setHomeTaskGroupId]=useState<string|null>(null)
  // N13：首页创建窗口外点/Esc/取消只收起，草稿留到下次打开；只有创建成功才清空。
  const [homeTaskDrafts,setHomeTaskDrafts]=useState<Record<string,import('@teloa/contract').TaskDefinition>>({})
  const homeTaskDraftKey=homeTaskGroupId??'home'
  const [homeRoleDraft,setHomeRoleDraft]=useState<RoleFields>()
  const [homeCreationError,setHomeCreationError]=useState<string>()
  const [collaboration]=useState(emptyCollaboration)
  const conversationGroups=useMemo(()=>createConversationGroupDirectory(groupApi),[groupApi])
  const groupDirectorySnapshot=useSyncExternalStore(conversationGroups.subscribe,conversationGroups.getSnapshot)
  const selectedGroupName=groupDirectorySnapshot.items.find(group=>group.id===state.groupTarget?.groupId)?.name
  const [groupCreateScope,setGroupCreateScope]=useState('general'),[groupCreateTeam,setGroupCreateTeam]=useState<IndustryTeamSeed>()
  const [groupCreateRequest,setGroupCreateRequest]=useState(0)
  const [teamMaterialsRequest,setTeamMaterialsRequest]=useState<{groupId:string;serial:number}>(),teamMaterialsSerial=useRef(0)
  const requestTeamMaterials=(groupId:string)=>setTeamMaterialsRequest({groupId,serial:++teamMaterialsSerial.current})
  useEffect(()=>{if(['messages','tasks','plans','attention'].includes(state.view)||homeCreation==='task'||restoredDetailView==='tasks'||restoredDetailView==='plans')void conversationGroups.refresh()},[state.view,homeCreation,restoredDetailView,conversationGroups])
  const closeNarrowDirectory=()=>{if(window.matchMedia('(max-width:740px)').matches)actions.closeSidebar()}
  // 交办弹层与任务详情共用同一份已保存群目录：只列未归档的，范围过滤在 TaskForm 内按主责范围做。
  const savedGroupOptions=groupDirectorySnapshot.items.filter(group=>!group.archived).map(group=>({id:group.id,name:group.name,scope:group.scope}))
  const openSavedGroup=(id:string)=>{setGroupCreateRequest(0);actions.openGroupTopic(id,'');closeNarrowDirectory()}
  const createDirectoryGroup=(scope='general')=>{setGroupCreateTeam(undefined);setGroupCreateScope(scope);actions.openMessages('groups');setGroupCreateRequest(value=>value+1);closeNarrowDirectory()}
  const openGroupTopic=(groupId:string,rootId:string)=>{actions.openGroupTopic(groupId,rootId)}
  const [tasks,setTasks]=useState(emptyTaskPreview)
  const [businessSpace,setBusinessSpace]=useState<BusinessSpaceRecord>()
  const [businessScopeLabels,setBusinessScopeLabels]=useState<BusinessScopeLabel[]>([])
  const [businessDirectoryStatus,setBusinessDirectoryStatus]=useState<'loading'|'ready'|'failed'>('loading')
  const [businessDirectoryError,setBusinessDirectoryError]=useState<string>()
  const businessDirectoryGeneration=useRef(0)
  // 本人空间与业务范围标签一起读；空目录和读取失败各自呈现，不用客户端内置标签伪造正式业务。
  const loadBusinessDirectory=async()=>{
    const generation=++businessDirectoryGeneration.current
    setBusinessDirectoryStatus('loading');setBusinessDirectoryError(undefined)
    try{
      const [space,labels]=await Promise.all([businessSpaceApi.current(),businessScopeApi.list()])
      if(generation!==businessDirectoryGeneration.current)return
      setBusinessSpace(space)
      setBusinessScopeLabels(labels)
      setBusinessDirectoryStatus('ready')
    }catch(error){
      if(generation===businessDirectoryGeneration.current){setBusinessDirectoryError(localizeWorkError(locale,error));setBusinessDirectoryStatus('failed')}
      throw error
    }
  }
  businessBuilder?.configure({location:()=>homeCreationLocation(latestState.current),refreshScopes:loadBusinessDirectory})
  const configurationRecords=useMemo(()=>builderFlow&&createBusinessRecordFlow?createBusinessRecordFlow():undefined,[builderFlow,createBusinessRecordFlow])
  const configurationResponsibility=useMemo(()=>builderState.api&&builderState.namespace&&createBusinessResponsibility?{api:createBusinessResponsibility(builderState.namespace,builderState.api),roles:roleWorkDirectory}:undefined,[builderState.api,builderState.namespace,createBusinessResponsibility,roleWorkDirectory])
  const configurationTaskList=useMemo(()=>builderState.api&&builderState.namespace&&createBusinessTaskList?createBusinessTaskList(builderState.namespace,builderState.api):undefined,[builderState.api,builderState.namespace,createBusinessTaskList])
  const configurationSetup=useMemo(()=>builderState.status==='ready'&&builderState.api&&builderState.namespace&&createBusinessSetup?createBusinessSetup(builderState.namespace,builderState.api):undefined,[builderState.status,builderState.api,builderState.namespace,createBusinessSetup])
  const configurationImports=useMemo<BusinessImportTargetFactory|undefined>(()=>builderState.status==='ready'&&builderState.api&&builderState.namespace&&createBusinessImportFlow?(scope,type)=>createBusinessImportFlow(builderState.namespace!,builderState.api!,scope,type):undefined,[builderState.status,builderState.api,builderState.namespace,createBusinessImportFlow])
  const configurationSelection=useMemo<BusinessConfigurationSelection>(()=>{
    const selected=new Map<string,string>()
    return {
      // 本次会话按页面种类分别记忆（业务内容/统计看板互不覆盖）；持久的目录记忆只保留最近一页，种类不符时由容器忽略。
      get:(scope,kind)=>{const page=latestState.current.navigationDirectories.spaces?.businessPage;return selected.get(scope+'\0'+(kind??''))??(page?.scope===scope?page.pageId:undefined)},
      set:(scope,pageId,kind)=>{selected.set(scope+'\0'+(kind??''),pageId);const current=latestState.current,page=current.navigationDirectories.spaces?.businessPage;if(current.view==='spaces'&&current.businessTarget.scope===scope&&(page?.scope!==scope||page.pageId!==pageId))actions.rememberDirectory('spaces',{businessPage:{scope,pageId}})},
    }
  },[builderState.api,builderState.namespace,actions])
  const [setupOrigin,setSetupOrigin]=useState<BusinessSetupOrigin|null>(null)
  const catalogEntrySerial=useRef(0)
  const marketConfigurationSerial=useRef(0)
  // 类别请求属于本人连接；页面因业务配置重挂载时不能重放已消费请求并清掉新草稿。
  const marketCategoryHandled=useRef({api:marketContentApi,storage:navigationStorage,store:useStore,serial:0})
  if(marketCategoryHandled.current.api!==marketContentApi||marketCategoryHandled.current.storage!==navigationStorage||marketCategoryHandled.current.store!==useStore)marketCategoryHandled.current={api:marketContentApi,storage:navigationStorage,store:useStore,serial:0}
  const pendingMarketCategory=state.marketCategoryRequest.serial>marketCategoryHandled.current.serial?state.marketCategoryRequest:undefined
  const completeMarketCategory=(serial:number)=>{const current=marketCategoryHandled.current;if(current.api===marketContentApi&&current.storage===navigationStorage&&current.store===useStore&&serial===state.marketCategoryRequest.serial)current.serial=serial}
  const marketConfigurationKey=useMemo(()=>++marketConfigurationSerial.current,[builderState.status,builderState.api,builderState.namespace])
  const dashboardResources=useMemo(()=>builderState.status==='ready'&&builderState.api&&builderState.namespace&&createBusinessDashboardResources?createBusinessDashboardResources(builderState.namespace,builderState.api):undefined,[builderState.status,builderState.api,builderState.namespace,createBusinessDashboardResources])
  // 业务配置就绪时沿用按本人与业务代次核验的连接；其余时候用全局受管连接（同样逐次核验连接代次），应用目录不再因未进入业务而失去连接服务。
  const marketMcpConnectionApi=useMemo(()=>createBusinessMcpConnection&&builderState.status==='ready'&&builderState.api&&builderState.namespace?createBusinessMcpConnection(builderState.namespace,builderState.api):managedMcpConnectionApi,[builderState.status,builderState.api,builderState.namespace,createBusinessMcpConnection,managedMcpConnectionApi])
  const [catalogEntryRequest,setCatalogEntryRequest]=useState<{catalogId:string;serial:number}>()
  // 上次保存的旧技术类别在启动时改写一次；之后业务连接变化导致的市场重挂载沿用当时真实所在的类别（例如业务配置打开的连接器目录）。
  const marketStartup=useRef(true)
  useEffect(()=>{
   marketStartup.current=false
   const saved=readMarketNavigation(state.navigationDirectories.market?.category),entry=marketEntryCategory(saved.category)
   if(entry!==saved.category)actions.rememberDirectory('market',{category:writeDirectoryFilterCategory({category:entry,mobileLayer:saved.mobileLayer,appsMine:String(saved.appsMine),appsCategory:saved.appsCategory??'all'})})
  },[])
  const configurationServices:BusinessConfigurationServices|undefined=builderState.api&&configurationRecords?{...(dashboardResources?{share:(scope:string)=><BusinessDashboardShareForm key={marketConfigurationKey+scope} scope={scope} api={dashboardResources} share={businessShareApi} openMarket={actions.openMarket}/>}:{ }),api:builderState.api,records:configurationRecords,importFlow:configurationImports,dashboardApi:businessDashboardApi,selection:configurationSelection,...(configurationSetup?{setup:{api:configurationSetup,open:openBusinessSetup}}:{}),capabilities:{create:true,edit:true,archive:true},...(insertBusinessRecord?{onDispatch:(reference:BusinessObjectReference)=>requestDaily(reference.scope,localizedScopeNames[reference.scope]??reference.scope,false,reference)}:{}),adjust:scope=>requestCreation({builder:true,scope}),talk:(scope,title)=>requestDaily(scope,title),newConversation:(scope,title)=>requestDaily(scope,title,true),actionReady:businessReady&&!dailyBusy,conversationStatus:dailyStatus,...(configurationResponsibility?{responsibility:configurationResponsibility}:{}),...(configurationTaskList?{taskList:{api:configurationTaskList,roleName:(id:string)=>tasks.roles.find(role=>role.id===id&&role.storage==='persistent')?.name,openTask:(id:string)=>actions.openTask(id),openArtifact:(taskId:string,id:string,version:number)=>openArtifacts({kind:'task',id:taskId},{id,version})}}:{})}:undefined
  useEffect(()=>{void loadBusinessDirectory().catch(()=>{})},[businessSpaceApi,businessScopeApi])
  const scopeLabels:readonly BusinessScopeLabel[]=businessScopeLabels
  const localizedScopeNames=businessScopeNames(scopeLabels,{general:t('business.scope.general'),SOC:t('business.scope.soc'),AppSec:t('business.scope.appsec')})
  const [savedIndustryLoads,setSavedIndustryLoads]=useState<IndustryLoadRecord[]>([]),[,refreshIndustryLoadState]=useState(0),savedIndustryLoadsRef=useRef<IndustryLoadRecord[]>([]),[industryLoadError,setIndustryLoadError]=useState<string>(),[industryLoadDirectory,setIndustryLoadDirectory]=useState<'idle'|'loading'|'ready'|'failed'>('idle'),industryLoadGeneration=useRef(0)
  // 分享复用固定内容目录与第二期本地声明目录；加载记录经 ref 读取，避免把已加载范围复制进另一份状态。
  const businessShareApi=useMemo(()=>createBusinessShareApi(createBusinessShareSource({customization:businessCustomizationApi,market:marketContentApi,loads:()=>savedIndustryLoadsRef.current}),marketContentApi),[businessCustomizationApi,marketContentApi])
  const mergeIndustryLoads=(loads:IndustryLoadRecord[])=>{savedIndustryLoadsRef.current=loads;setSavedIndustryLoads(loads);const labels=industryLoadScopeLabels(loads);setTasks(current=>({...current,business:{...current.business,spaces:[...current.business.spaces.filter(label=>!labels.some(saved=>saved.scope===label.scope)),...labels]}}))}
  const mergeIndustryLoad=(row:IndustryLoadRecord)=>mergeIndustryLoads(mergeSavedIndustryLoad(savedIndustryLoadsRef.current,row))
  const loadIndustryLoads=async()=>{const generation=++industryLoadGeneration.current;setIndustryLoadError(undefined);setIndustryLoadDirectory('loading');try{const rows=await industryLoadApi.list();if(generation===industryLoadGeneration.current){mergeIndustryLoads(rows);setIndustryLoadDirectory('ready')}}catch(error){if(generation===industryLoadGeneration.current){setIndustryLoadError(localizeWorkError(locale,error));setIndustryLoadDirectory('failed')}throw error}}
  useEffect(()=>{if(['home','market','spaces','team'].includes(state.view))void loadIndustryLoads().catch(()=>{})},[state.view,industryLoadApi])
  const [industryKnowledge,setIndustryKnowledge]=useState<IndustryKnowledgeInstance[]>([]),industryKnowledgeRef=useRef<IndustryKnowledgeInstance[]>([]),[industryKnowledgeError,setIndustryKnowledgeError]=useState<string>(),[,refreshIndustryKnowledgeState]=useState(0),industryKnowledgeGeneration=useRef(0)
  const mergeIndustryKnowledge=(rows:IndustryKnowledgeInstance[])=>{const next=mergeIndustryKnowledgeInstances(industryKnowledgeRef.current,rows);industryKnowledgeRef.current=next;setIndustryKnowledge(next)}
  const loadIndustryKnowledge=async()=>{const generation=++industryKnowledgeGeneration.current;setIndustryKnowledgeError(undefined);try{const rows=await industryKnowledgeApi.list();if(generation===industryKnowledgeGeneration.current)mergeIndustryKnowledge(rows)}catch(error){if(generation===industryKnowledgeGeneration.current)setIndustryKnowledgeError(localizeWorkError(locale,error));throw error}}
  useEffect(()=>{if(['spaces','team'].includes(state.view))void loadIndustryKnowledge().catch(()=>{})},[state.view,industryKnowledgeApi])
  const instantiateIndustryKnowledge=async(input:IndustryKnowledgeRequest)=>{try{const row=await industryKnowledgeApi.instantiate(input);industryKnowledgeGeneration.current++;mergeIndustryKnowledge([row]);return row}finally{refreshIndustryKnowledgeState(value=>value+1)}}
  const recoverIndustryKnowledge=async()=>{try{const row=await industryKnowledgeApi.recover();industryKnowledgeGeneration.current++;mergeIndustryKnowledge([row]);return row}finally{refreshIndustryKnowledgeState(value=>value+1)}}
  const [industryDataSources,setIndustryDataSources]=useState<IndustryDataSourceInstance[]>([]),industryDataSourcesRef=useRef<IndustryDataSourceInstance[]>([]),[industryDataSourceError,setIndustryDataSourceError]=useState<string>(),[industryDataSourcePartial,setIndustryDataSourcePartial]=useState(false),[,refreshIndustryDataSourceState]=useState(0),industryDataSourceGeneration=useRef(0)
  // 四类实例的合并一律按 revision 回退保护：更低的修订丢弃，等值仍允许覆盖（漂移投影不改修订）。
  const mergeIndustryDataSources=(rows:IndustryDataSourceInstance[])=>{const next=[...industryDataSourcesRef.current];for(const row of rows){const index=next.findIndex(item=>item.id===row.id||item.loadId===row.loadId&&item.itemInstanceId===row.itemInstanceId);if(index>=0&&next[index]!.revision>row.revision)continue;if(index>=0)next[index]=row;else next.push(row)}industryDataSourcesRef.current=next;setIndustryDataSources(next)}
  const loadIndustryDataSources=async()=>{const generation=++industryDataSourceGeneration.current;setIndustryDataSourceError(undefined);setIndustryDataSourcePartial(false);try{const page=await industryDataSourceApi.list();if(generation===industryDataSourceGeneration.current){industryDataSourcesRef.current=page.items;setIndustryDataSources(page.items);setIndustryDataSourcePartial(!!page.errors)}}catch(error){if(generation===industryDataSourceGeneration.current)setIndustryDataSourceError(localizeWorkError(locale,error));throw error}}
  useEffect(()=>{if(['market','spaces'].includes(state.view))void loadIndustryDataSources().catch(()=>{})},[state.view,industryDataSourceApi])
  const instantiateIndustryDataSource=async(input:IndustryDataSourceInstantiateInput)=>{const row=await industryDataSourceApi.instantiate(input);industryDataSourceGeneration.current++;mergeIndustryDataSources([row]);return row}
  const authorizeIndustryDataSource=async(input:IndustryDataSourceAuthorizeInput)=>{try{const row=await industryDataSourceApi.authorize(input);industryDataSourceGeneration.current++;mergeIndustryDataSources([row]);return row}finally{refreshIndustryDataSourceState(value=>value+1)}}
  const recoverIndustryDataSource=async()=>{try{const row=await industryDataSourceApi.recover();industryDataSourceGeneration.current++;mergeIndustryDataSources([row]);return row}finally{refreshIndustryDataSourceState(value=>value+1)}}
  const [industryExecutionTools,setIndustryExecutionTools]=useState<IndustryExecutionToolInstance[]>([]),industryExecutionToolsRef=useRef<IndustryExecutionToolInstance[]>([]),[industryExecutionToolError,setIndustryExecutionToolError]=useState<string>(),[industryExecutionToolPartial,setIndustryExecutionToolPartial]=useState(false),[,refreshIndustryExecutionToolState]=useState(0),industryExecutionToolGeneration=useRef(0)
  const mergeIndustryExecutionTools=(rows:IndustryExecutionToolInstance[])=>{const next=[...industryExecutionToolsRef.current];for(const row of rows){const index=next.findIndex(item=>item.id===row.id||item.loadId===row.loadId&&item.itemInstanceId===row.itemInstanceId);if(index>=0&&next[index]!.revision>row.revision)continue;if(index>=0)next[index]=row;else next.push(row)}industryExecutionToolsRef.current=next;setIndustryExecutionTools(next)}
  const loadIndustryExecutionTools=async()=>{const generation=++industryExecutionToolGeneration.current;setIndustryExecutionToolError(undefined);setIndustryExecutionToolPartial(false);try{const page=await industryExecutionToolApi.list();if(generation===industryExecutionToolGeneration.current){industryExecutionToolsRef.current=page.items;setIndustryExecutionTools(page.items);setIndustryExecutionToolPartial(!!page.errors)}}catch(error){if(generation===industryExecutionToolGeneration.current)setIndustryExecutionToolError(localizeWorkError(locale,error));throw error}}
  useEffect(()=>{if(['market','spaces'].includes(state.view))void loadIndustryExecutionTools().catch(()=>{})},[state.view,industryExecutionToolApi])
  const instantiateIndustryExecutionTool=async(input:IndustryExecutionToolInstantiateInput)=>{const row=await industryExecutionToolApi.instantiate(input);industryExecutionToolGeneration.current++;mergeIndustryExecutionTools([row]);return row}
  const authorizeIndustryExecutionTool=async(input:IndustryExecutionToolAuthorizeInput)=>{try{const row=await industryExecutionToolApi.authorize(input);industryExecutionToolGeneration.current++;mergeIndustryExecutionTools([row]);return row}finally{refreshIndustryExecutionToolState(value=>value+1)}}
  const recoverIndustryExecutionTool=async()=>{try{const row=await industryExecutionToolApi.recover();industryExecutionToolGeneration.current++;mergeIndustryExecutionTools([row]);return row}finally{refreshIndustryExecutionToolState(value=>value+1)}}
  const [industryMcpConnections,setIndustryMcpConnections]=useState<IndustryMcpConnectionInstance[]>([]),industryMcpConnectionsRef=useRef<IndustryMcpConnectionInstance[]>([]),[industryMcpConnectionError,setIndustryMcpConnectionError]=useState<string>(),[industryMcpConnectionPartial,setIndustryMcpConnectionPartial]=useState(false),[,refreshIndustryMcpConnectionState]=useState(0),industryMcpConnectionGeneration=useRef(0)
  const mergeIndustryMcpConnections=(rows:IndustryMcpConnectionInstance[])=>{const next=[...industryMcpConnectionsRef.current];for(const row of rows){const index=next.findIndex(item=>item.id===row.id||item.loadId===row.loadId&&item.itemInstanceId===row.itemInstanceId);if(index>=0&&next[index]!.revision>row.revision)continue;if(index>=0)next[index]=row;else next.push(row)}industryMcpConnectionsRef.current=next;setIndustryMcpConnections(next)}
  const loadIndustryMcpConnections=async()=>{const generation=++industryMcpConnectionGeneration.current;setIndustryMcpConnectionError(undefined);setIndustryMcpConnectionPartial(false);try{const page=await industryMcpConnectionApi.list();if(generation===industryMcpConnectionGeneration.current){industryMcpConnectionsRef.current=page.items;setIndustryMcpConnections(page.items);setIndustryMcpConnectionPartial(!!page.errors)}}catch(error){if(generation===industryMcpConnectionGeneration.current)setIndustryMcpConnectionError(localizeWorkError(locale,error));throw error}}
  useEffect(()=>{if(['market','spaces'].includes(state.view))void loadIndustryMcpConnections().catch(()=>{})},[state.view,industryMcpConnectionApi])
  const instantiateIndustryMcpConnection=async(input:IndustryMcpConnectionInstantiateInput)=>{const row=await industryMcpConnectionApi.instantiate(input);industryMcpConnectionGeneration.current++;mergeIndustryMcpConnections([row]);return row}
  const connectIndustryMcpConnection=async(input:IndustryMcpConnectionConnectInput)=>{try{const row=await industryMcpConnectionApi.connect(input);industryMcpConnectionGeneration.current++;mergeIndustryMcpConnections([row]);return row}finally{refreshIndustryMcpConnectionState(value=>value+1)}}
  const recoverIndustryMcpConnection=async()=>{try{const row=await industryMcpConnectionApi.recover();industryMcpConnectionGeneration.current++;mergeIndustryMcpConnections([row]);return row}finally{refreshIndustryMcpConnectionState(value=>value+1)}}
  const [industryPlugins,setIndustryPlugins]=useState<IndustryPluginInstance[]>([]),industryPluginsRef=useRef<IndustryPluginInstance[]>([]),[industryPluginError,setIndustryPluginError]=useState<string>(),[industryPluginPartial,setIndustryPluginPartial]=useState(false),[industryPluginLoading,setIndustryPluginLoading]=useState(false),[,refreshIndustryPluginState]=useState(0),industryPluginGeneration=useRef(0)
  const mergeIndustryPlugins=(rows:IndustryPluginInstance[])=>{const next=[...industryPluginsRef.current];for(const row of rows){const index=next.findIndex(item=>item.id===row.id||item.loadId===row.loadId&&item.itemInstanceId===row.itemInstanceId);if(index>=0&&next[index]!.revision>row.revision)continue;if(index>=0)next[index]=row;else next.push(row)}industryPluginsRef.current=next;setIndustryPlugins(next)}
  const loadIndustryPlugins=async()=>{const generation=++industryPluginGeneration.current;setIndustryPluginLoading(true);setIndustryPluginError(undefined);setIndustryPluginPartial(false);try{const page=await industryPluginApi.list();if(generation===industryPluginGeneration.current){industryPluginsRef.current=page.items;setIndustryPlugins(page.items);setIndustryPluginPartial(!!page.errors)}}catch(error){if(generation===industryPluginGeneration.current)setIndustryPluginError(localizeWorkError(locale,error));throw error}finally{if(generation===industryPluginGeneration.current)setIndustryPluginLoading(false)}}
  useEffect(()=>{if(['market','spaces'].includes(state.view))void loadIndustryPlugins().catch(()=>{})},[state.view,industryPluginApi])
  const instantiateIndustryPlugin=async(input:IndustryPluginInstantiateInput)=>{const row=await industryPluginApi.instantiate(input);industryPluginGeneration.current++;mergeIndustryPlugins([row]);return row}
  const installIndustryPlugin=async(input:IndustryPluginInstallInput)=>{try{const row=await industryPluginApi.install(input);industryPluginGeneration.current++;mergeIndustryPlugins([row]);return row}finally{refreshIndustryPluginState(value=>value+1)}}
  const recoverIndustryPlugin=async()=>{try{const row=await industryPluginApi.recover();industryPluginGeneration.current++;mergeIndustryPlugins([row]);return row}finally{refreshIndustryPluginState(value=>value+1)}}
  const previewIndustryPlugin=async(instanceId:string)=>industryPluginApi.preview(instanceId)
  const enableIndustryPlugin=async(instanceId:string,preview:MarketPluginInstallPreview)=>{const row=await industryPluginApi.enable(instanceId,preview);industryPluginGeneration.current++;mergeIndustryPlugins([row]);return row}
  const reconcileIndustryPlugin=async(instanceId:string)=>{const row=await industryPluginApi.reconcile(instanceId);industryPluginGeneration.current++;mergeIndustryPlugins([row]);return row}
  const roleResourceApi=useMemo<ResourceApi>(()=>({...resourceApi,directory:()=>createRoleResourceDirectory(resourceApi,industryKnowledgeApi)}),[resourceApi,industryKnowledgeApi])
  const [industryRoles,setIndustryRoles]=useState<IndustryRoleInstance[]>([]),industryRolesRef=useRef<IndustryRoleInstance[]>([]),[industryRoleError,setIndustryRoleError]=useState<string>(),[industryRoleDirectory,setIndustryRoleDirectory]=useState<'idle'|'loading'|'ready'|'failed'>('idle'),[,refreshIndustryRoleState]=useState(0),industryRoleGeneration=useRef(0)
  const mergeIndustryRoles=(rows:IndustryRoleInstance[])=>{const next=mergeIndustryRoleInstances(industryRolesRef.current,rows);industryRolesRef.current=next;setIndustryRoles(next)}
  const loadIndustryRoles=async()=>{const generation=++industryRoleGeneration.current;setIndustryRoleError(undefined);setIndustryRoleDirectory('loading');try{const rows=await industryRoleApi.list();if(generation===industryRoleGeneration.current){mergeIndustryRoles(rows);setIndustryRoleDirectory('ready')}}catch(error){if(generation===industryRoleGeneration.current){setIndustryRoleError(localizeWorkError(locale,error));setIndustryRoleDirectory('failed')}throw error}}
  // 市场页的升级预览要按真实岗位实例判定本地修改，所以它也必须读这份目录：否则首帧会把已建立的岗位判成缺失。
  useEffect(()=>{if(['market','spaces','team'].includes(state.view))void loadIndustryRoles().catch(()=>{})},[state.view,industryRoleApi])
  const roleSkillTitleReader=useMemo(()=>createRoleSkillTitleReader(skillInstallApi,industryLoadApi,industryRoleApi),[work,skillInstallApi,industryLoadApi,industryRoleApi,savedIndustryLoads,industryRoles])
  const instantiateIndustryRole=async(input:IndustryRoleRequest)=>{try{const row=await industryRoleApi.instantiate(input);industryRoleGeneration.current++;mergeIndustryRoles([row]);return row}finally{refreshIndustryRoleState(value=>value+1)}}
  const recoverIndustryRole=async()=>{try{const row=await industryRoleApi.recover();industryRoleGeneration.current++;mergeIndustryRoles([row]);return row}finally{refreshIndustryRoleState(value=>value+1)}}
  // 卸载是一笔跨六类实例的批量写：成功后加载目录与所有实例目录一起重读，任何一处旧数据都会误导后续操作。
  const refreshIndustryDirectories=async()=>{await Promise.all([loadBusinessDirectory(),loadIndustryLoads(),loadIndustryKnowledge(),loadIndustryDataSources(),loadIndustryExecutionTools(),loadIndustryMcpConnections(),loadIndustryPlugins(),loadIndustryRoles()].map(pending=>pending.catch(()=>{})))}
  const unloadIndustryLoad=async(input:IndustryLoadUnloadInput)=>{try{await industryLoadApi.unload(input);await refreshIndustryDirectories()}finally{refreshIndustryLoadState(value=>value+1)}}
  const recoverIndustryLoadUnload=async()=>{try{await industryLoadApi.recoverUnload();await refreshIndustryDirectories()}finally{refreshIndustryLoadState(value=>value+1)}}
  // 升级成功后重读全部行业目录，并直接定位到继任加载的资源视图。
  const upgradeIndustryLoad=async(input:IndustryLoadUpgradeInput)=>{try{const result=await industryLoadApi.upgrade(input);await refreshIndustryDirectories();actions.openIndustryResources({loadId:result.successor.id})}finally{refreshIndustryLoadState(value=>value+1)}}
  const [savedPlans,setSavedPlans]=useState<SavedPlan[]>([]),savedPlansRef=useRef<SavedPlan[]>([]),[savedPlanDirectory,setSavedPlanDirectory]=useState<'loading'|'ready'|'failed'>('loading'),savedPlanLoadGeneration=useRef(0)
  const mergeSavedPlans=(rows:SavedPlan[])=>{
    conversationPlans.merge(rows)
    const next=[...savedPlansRef.current]
    for(const row of rows){const index=next.findIndex(plan=>plan.id===row.id);if(index>=0&&next[index]!.version>row.version)continue;if(index>=0)next[index]=row;else next.push(row)}
    const projected=next.map(projectSavedPlan)
    savedPlansRef.current=next;setSavedPlans(next)
    setTasks(current=>({...current,continuous:{...current.continuous,plans:[...current.continuous.plans.filter(plan=>!projected.some(row=>row.id===plan.id)),...projected]}}))
  }
  const [conversationPlanTarget,setConversationPlanTarget]=useState<import('./continuous-preview.js').ContinuousTarget>()
  useEffect(()=>conversationPlans.subscribe(()=>{const snapshot=conversationPlans.getSnapshot();if(snapshot.status==='ready')mergeSavedPlans([...snapshot.plans])}),[conversationPlans])
  useEffect(()=>conversationPlans.onOpen(id=>setConversationPlanTarget({kind:'plan',id})),[conversationPlans])
  useEffect(()=>{if(state.view!=='messages'&&!conversationPlanTarget)return;const timer=setInterval(()=>{if(!document.hidden)void loadSavedPlans()},10000);return()=>clearInterval(timer)},[state.view,conversationPlanTarget,conversationPlans])
  const [dailySchedules,setDailySchedules]=useState<Record<string,RoleDailyLogPanelProps['schedule']>>({})
  useEffect(()=>{let live=true;setDailySchedules({})
    void Promise.all(savedPlans.filter(plan=>plan.source.kind==='system-digest').map(async plan=>{
      try{const value=await planApi.schedule(plan.id);return [plan.roleId,{state:value.overview?.state??'unknown',nextAt:value.overview?.nextAt??null,trigger:plan.trigger}] as const}
      catch{return [plan.roleId,{state:'unknown' as const}] as const}
    })).then(rows=>{if(live)setDailySchedules(Object.fromEntries(rows))})
    return()=>{live=false}
  },[savedPlans,planApi])
  const loadSavedPlans=async()=>{const generation=++savedPlanLoadGeneration.current;setSavedPlanDirectory('loading');try{const rows=await conversationPlans.refresh();if(generation!==savedPlanLoadGeneration.current)return;mergeSavedPlans(rows);setSavedPlanDirectory('ready')}catch{if(generation===savedPlanLoadGeneration.current)setSavedPlanDirectory('failed')}}
  useEffect(()=>{if(['home','team','plans','attention','spaces','messages'].includes(state.view))void loadSavedPlans()},[state.view,planApi])

  const [securityAttention,setSecurityAttention]=useState<SecurityActionAttention[]>([]),[securityAttentionKnown,setSecurityAttentionKnown]=useState(false),[securityAttentionError,setSecurityAttentionError]=useState<string>(),[securityAttentionLoading,setSecurityAttentionLoading]=useState(false),securityGeneration=useRef(0)
  const [securityFocus,setSecurityFocus]=useState<{taskId:string;actionId:string;revision:number}>()
  // 决策卡要的面板与来源和 SecurityActions 完全同源：先核对任务来源摘要，再读面板。
  const [securityPanels,setSecurityPanels]=useState<Record<string,{panel:SecurityActionPanel;context:SecurityActionContext}>>({})
  const [securityPanelErrors,setSecurityPanelErrors]=useState<Record<string,string>>({})
  // 三拍的终态与错误与面板错误同层：批准之后事项的 kind 从 approval 变成 execution，
  // 用户此刻若正筛着「审批」，卡片当场被筛走、组件卸载——结论留在组件 state 里就没了。
  const [securityDecisionOutcome,setSecurityDecisionOutcome]=useState<Record<string,SecurityDecisionOutcome>>({})
  const decisionOutcomeKey=(taskId:string,actionId:string)=>taskId+'\u0000'+actionId
  const securityPanelsRef=useRef(securityPanels);securityPanelsRef.current=securityPanels
  // 每个任务一枚代次号：面板拉取是并发的（列表扫描、卡内三拍重载、失败重试各走一条），
  // 迟到的旧响应一旦盖住新面板，卡里就会拿着旧 version 去撞 version-conflict。
  const securityPanelLoads=useRef<Record<string,number>>({})
  // 详情页面板写完后，决策卡手里那份面板副本立刻作废：宁可卡片退回“去处理”，
  // 也不让它拿着旧 version 摆出一个早就不成立的阶段。
  const invalidateSecurityAttention=()=>{securityGeneration.current++;setSecurityAttentionKnown(false);setSecurityPanels({});setSecurityPanelErrors({})}
  const loadSecurityAttention=async()=>{
    const generation=++securityGeneration.current;setSecurityAttentionKnown(false);setSecurityAttentionLoading(true);setSecurityAttentionError(undefined)
    try{const rows=await securityActionApi.attention();if(generation!==securityGeneration.current)return undefined;setSecurityAttention(rows);setSecurityAttentionKnown(true);return rows}
    catch(error){if(generation===securityGeneration.current)setSecurityAttentionError(localizeWorkError(locale,error));throw error}
    finally{if(generation===securityGeneration.current)setSecurityAttentionLoading(false)}
  }
  // 会话页带着会话对象详情时也要装载台账：右栏页签的正文就是整张任务页，台账空着它只能画一张空目录，
  // 页签标题也只能退回「任务详情」。刷新恢复正是这一刻——用户直接落在会话页，不经任何装载视图。
  const conversationLedger=conversationLedgerNeeded(state.view,state.messageMode,state.detail)
  useEffect(()=>{if(['home','tasks','attention'].includes(state.view)||conversationLedger)void loadSecurityAttention().catch(()=>{})},[state.view,conversationLedger,securityActionApi])
  const [taskLoading,setTaskLoading]=useState(false),[taskLoadError,setTaskLoadError]=useState<string>(),[taskAttention,setTaskAttention]=useState<TaskAttentionItem[]>([]),[taskAttentionKnown,setTaskAttentionKnown]=useState(false)
  const tasksRef=useRef(tasks);tasksRef.current=tasks
  const taskAttentionRef=useRef(taskAttention);taskAttentionRef.current=taskAttention
  const taskLoadGeneration=useRef(0),taskLoadApi=useRef(taskApi)
  if(taskLoadApi.current!==taskApi){taskLoadApi.current=taskApi;taskLoadGeneration.current++}
  /**
   * 任务 → 它的业务对象来源回执。每次重读任务台账都要重新投一遍，所以来源得留在投影之外：
   * `projectSavedTask` 只认契约 `WorkTask`，把补来的引用写进台账行里会被下一次重读原样抹掉。
   */
  const businessSources=useRef<Record<string,import('./business-task-api.js').BusinessTaskSource>>({})
  /** 同理，群消息任务来源单独记在 `groups/tasks/source` 上，见下方补拉的 useEffect。 */
  const groupTaskSources=useRef<Record<string,import('@teloa/contract').GroupTaskSource|null>>({})
  const projectTask=(row:import('@teloa/contract').WorkTask)=>withGroupTaskSource(withBusinessTaskSource(projectSavedTask(row),businessSources.current[row.id]??null),groupTaskSources.current[row.id])
  const mergeSavedTasks=(rows:import('@teloa/contract').WorkTask[])=>{taskLoadGeneration.current++;setTasks(current=>{const projected=rows.map(projectTask);return {...current,tasks:[...current.tasks.filter(task=>!projected.some(row=>row.id===task.id)),...projected.map(row=>{const old=current.tasks.find(task=>task.id===row.id);return old&&old.version>row.version?old:row})]}});setTaskAttention(current=>mergeTaskAttention(current,rows,tasksRef.current.tasks));queueMicrotask(()=>{void loadTasks()})}
  const loadTasks=async(mayApply:()=>boolean=()=>true)=>{const api=taskApi,generation=++taskLoadGeneration.current;setTaskLoading(true);setTaskLoadError(undefined);try{const snapshot=await api.attention();if(generation!==taskLoadGeneration.current||api!==taskLoadApi.current||!mayApply())return false;const current=tasksRef.current.tasks,currentAttention=taskAttentionRef.current,byId=new Map(snapshot.items.map(item=>[item.task.id,item])),kept=current.filter(task=>task.storage==='persistent'&&(!byId.has(task.id)||task.version>byId.get(task.id)!.task.version)),accepted=snapshot.items.filter(item=>!kept.some(task=>task.id===item.task.id));setTasks(value=>({...value,tasks:[...value.tasks.filter(task=>task.storage!=='persistent'),...kept,...accepted.map(item=>projectTask(item.task))]}));setTaskAttention([...currentAttention.filter(item=>kept.some(task=>task.id===item.task.id&&task.version===item.task.version)),...accepted]);setTaskAttentionKnown(true);return true}catch(error){if(generation===taskLoadGeneration.current&&api===taskLoadApi.current&&mayApply())setTaskLoadError(localizeWorkError(locale,error));return false}finally{if(generation===taskLoadGeneration.current)setTaskLoading(false)}}
  useEffect(()=>{if(['home','team','tasks','attention','spaces'].includes(state.view)||state.view==='messages'&&state.messageMode==='groups'||conversationLedger)void loadTasks()},[state.view,state.messageMode,conversationLedger,taskApi])
  useEffect(()=>{if(!restorePending.current.tasks||!taskAttentionKnown)return;const restored=reconcileAvailableDirectoryTarget({id:state.taskId??undefined},tasks.tasks.filter(task=>task.storage==='persistent').map(task=>task.id),state.detail,'tasks');restorePending.current.tasks=false;actions.reconcileDirectory('tasks',restored.id,restored.detail)},[taskAttentionKnown,tasks.tasks,state.taskId,state.detail,actions])
  /**
   * 持久调查任务的固定输入只能补拉：契约 `WorkTask` 不带业务对象引用，来源单独记在
   * `business-tasks/source` 上，`projectSavedTask` 投不出来。不补就是任务详情的「固定输入」
   * 一栏在持久任务上永远空着，会话关联区也没有业务对象可点。
   * 每个任务至多问一次（含答 null 的），拉不到来源的任务不该被反复追问。
   */
  const businessSourceLoads=useRef<Record<string,true>>({})
  const [businessSourceLoadErrors,setBusinessSourceLoadErrors]=useState<Record<string,string>>({})
  useEffect(()=>{
    for(const task of tasks.tasks){
      if(!shouldLoadBusinessTaskSource(task)||businessSourceLoads.current[task.id])continue
      businessSourceLoads.current[task.id]=true
      void businessTaskApi.source(task.id).then(origin=>{
        setBusinessSourceLoadErrors(current=>{if(!Object.hasOwn(current,task.id))return current;const next={...current};delete next[task.id];return next})
        if(!origin)return
        businessSources.current[origin.taskId]=origin
        setTasks(current=>({...current,tasks:current.tasks.map(row=>row.id===origin.taskId?withBusinessTaskSource(row,origin):row)}))
      }).catch(error=>{
        if(businessTaskSourceMissing(error)){
          setBusinessSourceLoadErrors(current=>{if(!Object.hasOwn(current,task.id))return current;const next={...current};delete next[task.id];return next})
          return
        }
        // 真实失败要进入任务页错误区，同时释放本次占位；用户点“重试”重新加载任务目录后
        // 可以再读一次来源。null / not-found 则保持已读，避免把普通无来源任务反复请求。
        delete businessSourceLoads.current[task.id]
        setBusinessSourceLoadErrors(current=>({...current,[task.id]:localizeWorkError(locale,error)}))
      })
    }
  },[tasks.tasks,businessTaskApi,locale])
  /**
   * 群消息任务的来源同理单独补拉：`groups/tasks/source` 答 null 就是没有群消息来源，
   * 也算问过，不再重复请求；读取失败保持未读，等下次任务台账刷新再试一次。
   */
  const groupSourceLoads=useRef<Record<string,true>>({})
  useEffect(()=>{
    for(const task of tasks.tasks){
      if(!shouldLoadGroupTaskSource(task)||groupSourceLoads.current[task.id])continue
      groupSourceLoads.current[task.id]=true
      void groupApi.taskSource(task.id).then(source=>{
        groupTaskSources.current[task.id]=source
        setTasks(current=>({...current,tasks:current.tasks.map(row=>row.id===task.id?withGroupTaskSource(row,source):row)}))
      }).catch(()=>{
        delete groupSourceLoads.current[task.id]
        setTasks(current=>({...current,tasks:current.tasks.map(row=>row.id===task.id?{...row,groupSourceState:'unavailable'}:row)}))
      })
    }
  },[tasks.tasks,groupApi])
  const createSavedTask=async(fields:import('@teloa/contract').TaskDefinition)=>{const task=await taskApi.create(fields);mergeSavedTasks([task]);return task.id}
  const [,refreshTaskState]=useState(0)
  const [,refreshIndustryTaskState]=useState(0)
  const [,refreshIndustryPlanState]=useState(0)
  const createIndustrySavedPlan=async(input:IndustryPlanRequest)=>{try{const result=await industryPlanApi.create(input);mergeSavedPlans([result.plan]);actions.openPlans({kind:'plan',id:result.plan.id})}finally{refreshIndustryPlanState(x=>x+1)}}
  const recoverIndustrySavedPlan=async()=>{try{const result=await industryPlanApi.recover();mergeSavedPlans([result.plan]);actions.openPlans({kind:'plan',id:result.plan.id})}finally{refreshIndustryPlanState(x=>x+1)}}
  const createIndustrySavedTask=async(input:IndustryTaskCreateInput)=>{try{const result=await industryTaskApi.create(input);mergeSavedTasks([result.task]);actions.openTask(result.task.id);void loadTasks()}finally{refreshIndustryTaskState(value=>value+1)}}
  const recoverIndustrySavedTask=async()=>{try{const result=await industryTaskApi.recover();mergeSavedTasks([result.task]);actions.openTask(result.task.id);void loadTasks()}finally{refreshIndustryTaskState(value=>value+1)}}
  const createBusinessSavedTask=async(input:BusinessTaskRequest)=>openSavedBusinessTask(await businessTaskApi.create(input),mergeSavedTasks,actions.openTask)
  const recoverBusinessSavedTask=async()=>openSavedBusinessTask(await businessTaskApi.recover(),mergeSavedTasks,actions.openTask)
  const [handoffs,setHandoffs]=useState<TaskHandoff[]>([]),[handoffsKnown,setHandoffsKnown]=useState(false),[handoffLoading,setHandoffLoading]=useState(false),[handoffError,setHandoffError]=useState<string>()
  const handoffLoadGeneration=useRef(0)
  const loadHandoffs=async()=>{const generation=++handoffLoadGeneration.current;setHandoffLoading(true);setHandoffError(undefined);try{const rows=await handoffApi.list();if(generation!==handoffLoadGeneration.current)return;setHandoffs(rows);setHandoffsKnown(true)}catch(e){if(generation===handoffLoadGeneration.current)setHandoffError(localizeWorkError(locale,e))}finally{if(generation===handoffLoadGeneration.current)setHandoffLoading(false)}}
  useEffect(()=>{if(['home','tasks','attention'].includes(state.view))void loadHandoffs()},[state.view,handoffApi])
  const refreshAfterHandoffChange=async(result:Awaited<ReturnType<HandoffApi['change']>>)=>{handoffLoadGeneration.current++;mergeSavedTasks([result.task]);await Promise.all([loadTasks(),loadRoles(),loadHandoffs()])}
  const recoverHandoffChange=async()=>{try{await refreshAfterHandoffChange(await handoffApi.recoverChange())}finally{refreshTaskState(value=>value+1)}}
  useEffect(()=>{if(handoffApi.pendingChange())void recoverHandoffChange().catch(()=>{})},[handoffApi])
  const handoffPort={rows:handoffs,known:handoffsKnown&&!handoffError,loading:handoffLoading,error:handoffError??(handoffApi.recoveryMessage()?localizeWorkError(locale,handoffApi.recoveryMessage()):undefined),pending:handoffApi.pending(),changePending:handoffApi.pendingChange(),changeError:handoffApi.changeRecoveryMessage(),load:async()=>{await Promise.all([loadHandoffs(),loadTasks(),loadRoles()])},resolve:async(id:string,request:import('./handoff-api.js').HandoffRequest)=>{try{const result=await handoffApi.resolve(id,request);handoffLoadGeneration.current++;mergeSavedTasks([result.task]);await loadHandoffs()}finally{refreshTaskState(value=>value+1)}},recover:async()=>{try{const result=await handoffApi.recover();handoffLoadGeneration.current++;mergeSavedTasks([result.task]);await loadHandoffs()}finally{refreshTaskState(value=>value+1)}},change:async(taskId:string,expectedTaskVersion:number,target:import('@teloa/contract').TaskHandoffTarget,note:string)=>{try{await refreshAfterHandoffChange(await handoffApi.change(taskId,expectedTaskVersion,target,note))}finally{refreshTaskState(value=>value+1)}},recoverChange:recoverHandoffChange}
  // 核对成果只重渲染外壳，不更换本人连接；保持端口身份，让原版本选择与说明留在 TaskCompletion。
  const taskCompletionOrigin=useRef({artifactApi,taskApi,taskTransitions,mergeSavedTasks,refreshTaskState})
  taskCompletionOrigin.current={artifactApi,taskApi,taskTransitions,mergeSavedTasks,refreshTaskState}
  const taskCompletionPort=useMemo<TaskCompletionPort>(()=>({
    list:id=>artifactApi.list(id,'task'),read:taskApi.completion,
    complete:async(task,ref,note)=>{
      const current=()=>{const latest=taskCompletionOrigin.current;return latest.artifactApi===artifactApi&&latest.taskApi===taskApi&&latest.taskTransitions===taskTransitions?latest:undefined}
      try{const saved=await taskTransitions.change(task.id,task.version,'complete',{artifact:ref,note});current()?.mergeSavedTasks([saved])}
      finally{current()?.refreshTaskState(value=>value+1)}
    },
  }),[artifactApi,taskApi,taskTransitions])
  const taskPersistence={directoryKnown:taskAttentionKnown&&!taskLoadError,attention:{rows:taskAttention,known:taskAttentionKnown&&!taskLoadError&&securityAttentionKnown},handoffs:handoffPort,completion:taskCompletionPort,stateRequest:taskTransitions.pending(),stateError:taskTransitions.recoveryMessage(),recoverState:async()=>{try{mergeSavedTasks([await taskTransitions.recover()])}finally{refreshTaskState(value=>value+1)}},edit:async(task:import('./task-preview.js').PreviewTask,fields:{title:string;goal:string})=>{mergeSavedTasks([await taskApi.edit(task.id,task.version,fields)])},create:createSavedTask,pendingFields:taskApi.pendingFields,load:()=>{void loadTasks()},loading:taskLoading,error:taskLoadError??Object.values(businessSourceLoadErrors)[0]??(taskApi.recoveryMessage()?localizeWorkError(locale,taskApi.recoveryMessage()):undefined)}

  const [roleLoadError,setRoleLoadError]=useState<string>(),[roleLoading,setRoleLoading]=useState(false),[roleDirectoryKnown,setRoleDirectoryKnown]=useState(false)
  const roleWorkAccessRef=useRef<Record<string,RoleDelegationRead>>({}),roleAccessGeneration=useRef(new Map<string,number>()),roleLoadGeneration=useRef(0)
  const mergeRoleWorkAccess=(roleId:string,read:RoleDelegationRead|undefined)=>{
    if(read)roleWorkAccessRef.current[roleId]=read
    else delete roleWorkAccessRef.current[roleId]
    const merge=(current:typeof tasks)=>({...current,roles:current.roles.map(role=>role.id===roleId&&role.storage==='persistent'?{...role,workAccess:read?.roleId===role.id&&read.roleVersion===role.version?read:undefined}:role)})
    tasksRef.current=merge(tasksRef.current)
    setTasks(merge)
  }
  const delegationChanged=(read:RoleDelegationRead)=>{
    // 保存/撤销的可信回执优先于此前仍在途的目录读取，旧许可不能回流覆盖新状态。
    roleAccessGeneration.current.set(read.roleId,(roleAccessGeneration.current.get(read.roleId)??0)+1)
    mergeRoleWorkAccess(read.roleId,read)
  }
  const loadRoleWorkAccess=async(roleId:string)=>{
    const generation=(roleAccessGeneration.current.get(roleId)??0)+1
    roleAccessGeneration.current.set(roleId,generation)
    try{const read=await roleDelegationApi.get(roleId);if(roleAccessGeneration.current.get(roleId)===generation)mergeRoleWorkAccess(roleId,read)}
    catch(error){if(roleAccessGeneration.current.get(roleId)===generation)mergeRoleWorkAccess(roleId,undefined);throw error}
  }
  const mergeRoles=(rows:DigitalRole[])=>{
    const projected=rows.map((row):PreviewRole=>({...row,scopes:row.scopes.map(scope=>{if(!registeredBusinessScope(scope,scopeLabels))throw Error(t('frame.p5.roleScopeUnknown'));return scope as CollaborationScope}),storage:'persistent',memories:[],history:[],workAccess:roleWorkAccessRef.current[row.id]?.roleVersion===row.version?roleWorkAccessRef.current[row.id]:undefined}))
    const merge=(current:typeof tasks)=>{const roles=[...current.roles];for(const row of projected){const index=roles.findIndex(item=>item.id===row.id);if(index>=0){const previous=roles[index]!;if(previous.version>row.version||(previous.version===row.version&&previous.updatedAt&&row.updatedAt&&Date.parse(previous.updatedAt)>Date.parse(row.updatedAt)))continue;}if(index>=0)roles[index]=row;else roles.push(row)}return {...current,roles}}
    // 账号区可能在岗位目录首轮请求完成前就打开默认分身。同步更新 ref，让同一次点击随后创建会话时
    // 能读到刚拉回的默认身份；React 状态仍按正常更新路径提交给界面。
    tasksRef.current=merge(tasksRef.current)
    setTasks(merge)
  }
  const loadRoles=async()=>{
    const generation=++roleLoadGeneration.current
    // 员工范围依赖本人真实业务目录；目录尚未就绪时不把有效成员判成未知范围。
    // 同时作废刷新前的在途请求，目录就绪后由同一入口重新载入。
    if(businessDirectoryStatus!=='ready'){
      setRoleLoading(businessDirectoryStatus==='loading')
      setRoleLoadError(businessDirectoryStatus==='failed'?businessDirectoryError:undefined)
      return
    }
    setRoleLoading(true);setRoleLoadError(undefined)
    try{
      const rows=await roleApi.list()
      if(generation!==roleLoadGeneration.current)return
      mergeRoles(rows);setRoleDirectoryKnown(true)
      const results=await Promise.allSettled(rows.map(role=>loadRoleWorkAccess(role.id)))
      const failure=results.find((result):result is PromiseRejectedResult=>result.status==='rejected')
      if(generation===roleLoadGeneration.current&&failure)setRoleLoadError(localizeWorkError(locale,failure.reason))
    }catch(error){
      if(generation!==roleLoadGeneration.current)return
      for(const roleId of Object.keys(roleWorkAccessRef.current)){roleAccessGeneration.current.set(roleId,(roleAccessGeneration.current.get(roleId)??0)+1);mergeRoleWorkAccess(roleId,undefined)}
      setRoleLoadError(localizeWorkError(locale,error))
    }finally{if(generation===roleLoadGeneration.current)setRoleLoading(false)}
  }
  const roleExecutionAccess=useMemo(()=>Object.fromEntries(tasks.roles.flatMap(role=>role.workAccess?.roleId===role.id&&role.workAccess.roleVersion===role.version?[[role.id,role.workAccess]]:[])),[tasks.roles])
  const refreshRoles=()=>businessDirectoryStatus==='failed'?loadBusinessDirectory().catch(()=>{}):loadRoles()
  const openIndustryRole=async(roleId:string)=>{actions.previewRole(roleId);const rows=await roleApi.list();mergeRoles(rows);if(!rows.some(role=>role.id===roleId))throw Error(t('frame.p5.industryRoleUnavailable'))}
  useEffect(()=>{if(computerRoleId||state.rolePreview||['home','team','tasks','plans','attention','spaces','messages','market'].includes(state.view)||conversationLedger)void loadRoles()},[computerRoleId,state.view,!!state.rolePreview,conversationLedger,roleApi,roleDelegationApi,businessDirectoryStatus,businessDirectoryError,scopeLabels])
  useEffect(()=>{if(!restorePending.current.team||!roleDirectoryKnown)return;const restored=reconcileAvailableDirectoryTarget({id:state.roleId??undefined},tasks.roles.filter(role=>role.storage==='persistent').map(role=>role.id),state.detail,'team');restorePending.current.team=false;actions.reconcileDirectory('team',restored.id,restored.detail)},[roleDirectoryKnown,tasks.roles,state.roleId,state.detail,actions])
  const pendingRoleFields=()=>{const fields=roleApi.pendingFields();return fields?{...fields,scopes:fields.scopes as CollaborationScope[]}:undefined}
  const createSavedRole=async(fields:RoleFields)=>{const row=await roleApi.create(fields);mergeRoles([row]);return row.id}
  // 宿主桥按契约 v1 声明；v2 包与可选投稿见 ShareBridge，契约 v2 合入后改回 TemplateShareBridge。
  const templateShareBridge=typeof window==='undefined'?undefined:window.teloaApplication?.templateShares as ShareBridge|undefined
  const [templateIntent,setTemplateIntent]=useState<TemplateShareIntent|null>(null),[templateReceiveOpen,setTemplateReceiveOpen]=useState(false),[shareDraft,setShareDraft]=useState<SharePackage>()
  useEffect(()=>{
    if(!templateShareBridge)return
    let active=true
    const notify=(intent:TemplateShareIntent|null)=>{if(!active)return;setTemplateIntent(intent);if(intent)setTemplateReceiveOpen(true)}
    void Promise.resolve(templateShareBridge.pending()).then(notify).catch(()=>{})
    const release=templateShareBridge.subscribe(notify)
    return()=>{active=false;release()}
  },[templateShareBridge])
  const templateAcceptance=useMemo(()=>createShareAcceptance(navigationStorage,{
    createRole:async(fields,requestId)=>{const row=await roleApi.create(fields,requestId);mergeRoles([row]);return row.id},
    // v2 复用固定内容 → 加载 → 一键准备：岗位、资料、连接与协调关系都落在同一加载真源，刷新后可从服务读回。
    industry:{
      publicSkill:async({publicId,version})=>{
        const found=resolvePublicCatalogEntry((await loadCatalogListing(marketCatalogApi)).items,publicId,version)
        const {contentId}=await marketCatalogApi.add(found.entry.id,found.artifact?{version:found.entry.version,treeHash:found.artifact.treeHash}:undefined)
        return marketContentApi.hydrate({kind:'skill',contentStorage:{contentId,createdAt:new Date().toISOString(),loaded:true}} as MarketItem)
      },
      target:async()=>{const space=await businessSpaceApi.current();return {kind:'existing',spaceId:space.id,expectedVersion:space.version}},
      importContent:async(item,requestId)=>{const saved=await marketContentApi.importIndustry(item,requestId);const current=marketRef.current;changeMarket({...current,items:mergeMarketItems(current.items,[saved])});return saved},
      load:async request=>{const row=await industryLoadApi.create(request);mergeIndustryLoad(row);await loadBusinessDirectory();return row},
      getLoad:loadId=>industryLoadApi.get(loadId),
      installSkill:async(source,requestId)=>{
        const pending=skillInstallApi.pending()
        if(pending&&pending.requestId!==requestId)return {state:'pending'}
        const input={kind:'industry' as const,...source}
        const saved=pending?await skillInstallApi.recover():await (async()=>{const preview=await skillInstallApi.preview(input);return skillInstallApi.install({requestId,source:input,expectedBundleHash:preview.bundleHash,...(preview.trustHash?{expectedTrustHash:preview.trustHash}:{})})})()
        return saved.state==='installed'?{state:'installed',installationId:saved.id,nativeName:saved.native.name}:{state:'pending'}
      },
      // 分享副本建好后保持暂停、由本人检查后再启用：明确请求 activate:false，不代为上岗。
      prepare:async loadId=>{const readiness=await industryLoadApi.readiness(loadId);if(!readiness.counts.auto)return readiness;const receipt=await industryLoadApi.prepare(loadId,readiness.digest,{activate:false});void loadRoles().catch(()=>{});return receipt.readiness??industryLoadApi.readiness(loadId)},
      roles:async loadId=>{const rows=await industryRoleApi.list();mergeIndustryRoles(rows);return rows.map(row=>({loadId:row.loadId,itemInstanceId:row.itemInstanceId,state:row.state,...(row.role?{roleId:row.role.id}:{})}))},
      team:async seed=>{const saved=await findIndustryTeam(groupApi,seed);return saved?{groupId:saved.group.id}:undefined},
    },
    v1:{
      ...(templateShareBridge?.beginAcceptance&&templateShareBridge.endAcceptance?{beginAcceptance:(input:{requestId:string;shareId?:string})=>templateShareBridge.beginAcceptance!(input),endAcceptance:(input:{acceptanceId:string})=>templateShareBridge.endAcceptance!(input)}:{}),
      target:async()=>{const space=await businessSpaceApi.current();return {kind:'existing',spaceId:space.id,expectedVersion:space.version}},
      importContent:async(item,requestId)=>{const saved=await marketContentApi.importIndustry(item,requestId);const current=marketRef.current;changeMarket({...current,items:mergeMarketItems(current.items,[saved])});return saved},
      load:async request=>{const row=await industryLoadApi.create(request);mergeIndustryLoad(row);await loadBusinessDirectory();return row},
      knowledge:instantiateIndustryKnowledge,
      role:instantiateIndustryRole,
    },
  }),[navigationStorage,roleApi,marketContentApi,marketCatalogApi,skillInstallApi,industryLoadApi,industryKnowledgeApi,industryRoleApi,businessSpaceApi,templateShareBridge,groupApi])
  const teamMaterials=useMemo(()=>createIndustryTeamMaterials({groups:groupApi,loads:industryLoadApi,roles:industryRoleApi,knowledge:industryKnowledgeApi,contents:marketContentApi,storage:navigationStorage}),[groupApi,industryLoadApi,industryRoleApi,industryKnowledgeApi,marketContentApi,navigationStorage])
  const teamConnection=useRef({loads:industryLoadApi,roles:industryRoleApi,groups:groupApi})
  if(teamConnection.current.loads!==industryLoadApi||teamConnection.current.roles!==industryRoleApi||teamConnection.current.groups!==groupApi)teamConnection.current={loads:industryLoadApi,roles:industryRoleApi,groups:groupApi}
  const teamMounted=useRef(true)
  useEffect(()=>{teamMounted.current=true;return()=>{teamMounted.current=false}},[])
  const teamLocation=useRef('')
  teamLocation.current=JSON.stringify([state.view,state.marketMode,state.industryResourceTarget,state.marketItemId,state.messageMode,state.groupTarget,state.roleId,state.detail,state.businessTarget])
  const createIndustryTeam=async(loadId:string,isCurrent:()=>boolean=()=>true)=>{
    const connection=teamConnection.current,location=teamLocation.current
    const current=()=>teamMounted.current&&connection===teamConnection.current&&location===teamLocation.current&&isCurrent()
    const [load,rows]=await Promise.all([connection.loads.get(loadId),connection.roles.list()])
    if(!current())return
    const seed=industryTeamSeed(load,rows.map(row=>({loadId:row.loadId,itemInstanceId:row.itemInstanceId,state:row.state,...(row.role?{roleId:row.role.id}:{})})))
    if(!seed)throw Error(t('templateShare.teamNotReady'))
    const saved=await findIndustryTeam(connection.groups,seed)
    if(!current())return
    mergeIndustryRoles(rows);await loadRoles()
    if(!current())return
    setTemplateReceiveOpen(false)
    if(saved){requestTeamMaterials(saved.group.id);openSavedGroup(saved.group.id);return}
    setGroupCreateTeam(seed);setGroupCreateScope(seed.scope);actions.openMessages('groups');setGroupCreateRequest(value=>value+1);closeNarrowDirectory()
  }
  /** 分享来源：员工绑定的原生技能名解析为真实安装身份与版本；许可已声明的原子正文随包，否则只写成接收方需配置项。 */
  const templateShareSources=useMemo<TemplateShareSources>(()=>({
    skills:(names,selection)=>resolveTemplateShareSkills(names,{skills:skillInstallApi,contents:marketContentApi,loads:industryLoadApi},selection),
    ...(managedMcpConnectionApi?{connections:async()=>(await managedMcpConnectionApi.list()).flatMap(record=>record.tools?.length?[{serverName:record.serverName,title:record.serverName,tools:record.tools.map(tool=>tool.name)}]:[])}:{}),
  }),[skillInstallApi,marketContentApi,industryLoadApi,managedMcpConnectionApi])

  const editSavedRole=async(role:PreviewRole,fields:RoleFields)=>{mergeRoles([await roleApi.edit(role.id,role.version,fields,{name:role.name,...(role.avatarKey?{avatarKey:role.avatarKey}:{})})])}
  const updateSavedRoleProfile=async(role:PreviewRole,fields:Pick<RoleFields,'name'|'avatarKey'>)=>{
    const saved=await roleApi.updateProfile(role.id,role.version,role,fields)
    // 身份资料不提升执行版本；保存前在途的目录即使同一毫秒也不能覆盖可信回执。
    roleLoadGeneration.current++;setRoleLoading(false)
    mergeRoles([saved])
  }

  const [objectLinks,setObjectLinks]=useState<ObjectConversationLink[]>([])
  const [objectConversationDiscarded,setObjectConversationDiscarded]=useState(false)
  const objectPanelTrigger=useRef<HTMLButtonElement|null>(null)
  // 收起对象详情：页内第三栏与原生右栏页签是同一份内容的两种承载，哪种在用就收哪种。
  const restoreObjectPanelFocus=(sessionId:string|undefined)=>requestAnimationFrame(()=>{const trigger=objectPanelTrigger.current;if(sessionId&&work.getSnapshot().sessionId===sessionId&&trigger?.isConnected)trigger.focus()})
  const closeObjectPanel=()=>{closeRailObjectTab();actions.closeDetail();restoreObjectPanelFocus(current)}
  const [conversationObject,setConversationObject]=useState<{object:ConversationObject;sessionId:string;scopeId?:CollaborationScope}|null>(null)
  const [conversationProject,setConversationProject]=useState<{sessionId:string;project:import('@teloa/contract').WorkProject;memoryMode:ProjectMemoryMode}>()
  useEffect(()=>{
    if(voiceSelectionReady&&!voiceSessionId&&conversationObject?.object.kind==='role'&&conversationObject.object.id===voiceRoleId&&work.getSnapshot().sessionId===conversationObject.sessionId)setVoiceSessionId(conversationObject.sessionId)
  },[voiceSelectionReady,voiceSessionId,voiceRoleId,conversationObject,work])
  const resolveConversationObject=(kind:ConversationObject['kind'],id:string):ConversationObject=>{
    // 会话入口可能在目录首轮请求完成前被点击。mergeRoles/mergeSavedTasks 会先同步更新
    // tasksRef，再等待 React 提交界面；这里必须读同一份最新快照，不能退回当前渲染闭包。
    const snapshot=tasksRef.current
    if(kind==='role'){const role=snapshot.roles.find(row=>row.id===id);if(!role)throw Error(t('frame.p5.roleGone'));return {kind,id,title:role.kind==='twin'?twinDisplayName(profile.displayName,t):role.name,version:role.version,canStart:roleCanStartConversation(role.state)}}
    const task=snapshot.tasks.find(row=>row.id===id);if(!task)throw Error(t('frame.p5.taskGone'));return {kind,id,title:task.title,version:task.version,canStart:!['completed','cancelled'].includes(task.state)}
  }
  const objectLinkApi=useRef(objectConversationApi);objectLinkApi.current=objectConversationApi
  const [savedObjectDirectory,setSavedObjectDirectory]=useState({api:objectConversationApi,rows:[] as SavedObjectLink[]})
  const savedObjectLinks=savedObjectDirectory.api===objectConversationApi?savedObjectDirectory.rows:[]
  const persistentObject=(object:ConversationObject)=>object.kind==='task'?tasksRef.current.tasks.some(t=>t.id===object.id&&t.storage==='persistent'):tasksRef.current.roles.some(r=>r.id===object.id&&r.storage==='persistent')
  const mergeObjectLinks=(rows:SavedObjectLink[],mayContinue?:()=>boolean)=>{if(objectLinkApi.current!==objectConversationApi||mayContinue?.()===false)return;setSavedObjectDirectory(current=>{if(objectLinkApi.current!==objectConversationApi||mayContinue?.()===false)return current;const next=current.api===objectConversationApi?[...current.rows]:[];for(const row of rows){const index=next.findIndex(r=>r.kind===row.kind&&r.objectId===row.objectId&&r.sessionId===row.sessionId);if(index<0)next.push(row);else if(next[index]!.version<=row.version)next[index]=row}return {api:objectConversationApi,rows:next}})}
  const changeObjectLink=async(object:ConversationObject,sessionId:string,action:'link'|'unlink',scopeId?:CollaborationScope,mayContinue?:()=>boolean)=>{if(objectLinkApi.current!==objectConversationApi||mayContinue?.()===false)return;const previous=savedObjectLinks.find(r=>r.kind===object.kind&&r.objectId===object.id&&r.sessionId===sessionId);try{mergeObjectLinks([await objectConversationApi.change({kind:object.kind,objectId:object.id,expectedObjectVersion:object.version,sessionId,expectedLinkVersion:previous?.version??0,action,...(action==='link'&&scopeId?{scopeId}:{})})],mayContinue)}finally{if(objectLinkApi.current===objectConversationApi&&mayContinue?.()!==false)refreshTaskState(v=>v+1)}}
  const activeObjectLinks=[...objectLinks,...savedObjectLinks.filter(r=>r.active)]
  const prepareTaskConversation=async(object:ConversationObject,conversation:Conversation,canContinue?:()=>boolean)=>{
    if(canContinue?.()===false)return
    const context=await objectConversationApi.taskContext(object.id,conversation.sessionId,object.version)
    if(canContinue?.()===false)return
    if(!canContinue)await work.openConversation(conversation)
    else if(work.getSnapshot().sessionId!==conversation.sessionId)await work.openSession(conversation.sessionId,undefined,canContinue)
    if(canContinue?.()===false)return
    if(work.getSnapshot().sessionId!==conversation.sessionId)throw Error(t('frame.p5.conversationChangedPrepare'))
    // 业务对象快照是外部告警源的原始内容：只投影分析必需的字段并封顶长度，再用定界符围起来，
    // 前置文案逐字说明界内是数据不是指令。整份 JSON.stringify 既把内部字段交出去，
    // 又让攻击者可以拿超长正文把真正的任务目标挤出上下文。
    const head={
      task:{id:context.task.id,version:context.task.version,title:context.task.title,goal:context.task.goal,scope:context.task.scope},
      role:context.role?{name:context.role.name,version:context.role.version,duty:context.role.duty,dataScope:context.role.dataScope,executionScope:context.role.executionScope}:null,
    }
    const text=taskSnapshotMessage(t('frame.p5.taskSnapshotPrompt'),head,projectTaskSnapshotBusiness(context.business?.object))
    preparation.prepare({id:crypto.randomUUID(),sourceId:object.id,sourceKind:'task',sourceVersion:context.task.version,taskSnapshot:JSON.stringify(context),sessionId:conversation.sessionId,title:context.task.title,text})
    actions.closeDetail();setConversationObject({object,sessionId:conversation.sessionId,scopeId:context.task.scope as CollaborationScope});actions.openMessages('native')
  }
  const objectConversations=(kind:ConversationObject['kind'],id:string)=>{
    const object=resolveConversationObject(kind,id)
    const roleScopes=kind==='role'?tasksRef.current.roles.find(row=>row.id===id)?.scopes:undefined
    const sourceScope=kind==='task'?tasks.tasks.find(row=>row.id===id)?.scope:roleScopes?.length===1?roleScopes[0]:undefined
    return <Fragment key={kind+':'+id}>{objectConversationApi.recoveryMessage()&&<button type="button" onClick={()=>{objectConversationApi.discard();setObjectConversationDiscarded(true)}}>{t('recovery.discard')}</button>}{objectConversationDiscarded&&<p role="status">{t('recovery.discarded')}</p>}<ObjectConversations identity={objectConversationApi} object={object} prepare={kind==='task'&&persistentObject(object)?(conversation,mayContinue)=>prepareTaskConversation(object,conversation,mayContinue):undefined} links={activeObjectLinks} persistence={persistentObject(object)?{load:async mayContinue=>{if(mayContinue?.()===false)return;mergeObjectLinks(await objectConversationApi.list(kind,id),mayContinue)},recover:async mayContinue=>{if(mayContinue?.()===false)return;try{mergeObjectLinks([await objectConversationApi.recover()],mayContinue)}finally{if(objectLinkApi.current===objectConversationApi&&mayContinue?.()!==false)refreshTaskState(v=>v+1)}},pending:!!objectConversationApi.pending(),error:objectConversationApi.recoveryMessage()}:undefined} work={work} management={management} useSessions={useSessions}
      link={(conversation,mayContinue)=>persistentObject(object)?changeObjectLink(resolveConversationObject(kind,id),conversation.sessionId,'link',sourceScope,mayContinue):setObjectLinks(linkObjectConversation(objectLinks,resolveConversationObject(kind,id),conversation,sourceScope))}
      unlink={(conversationId,mayContinue)=>{if(!persistentObject(object)){setObjectLinks(unlinkObjectConversation(objectLinks,object,conversationId));return}const row=savedObjectLinks.find(r=>r.kind===kind&&r.objectId===id&&r.conversationId===conversationId);if(!row)throw Error(t('frame.p5.linkChanged'));return changeObjectLink(resolveConversationObject(kind,id),row.sessionId,'unlink',undefined,mayContinue)}}
      open={async(sessionId:string,mayContinue?:()=>boolean)=>{if(mayContinue?.()===false)return;await work.openSession(sessionId,undefined,mayContinue);if(mayContinue?.()===false)return;if(work.getSnapshot().sessionId!==sessionId)throw Error(t('frame.p5.conversationChangedOpen'));const link=activeObjectLinks.find(row=>row.kind===kind&&row.objectId===id&&row.sessionId===sessionId);const scopeId=link?.scopeId as CollaborationScope|undefined;actions.closeDetail();setConversationObject({object,sessionId,...(scopeId?{scopeId}:{})});actions.openMessages('native');if(window.matchMedia('(max-width:740px)').matches)actions.closeSidebar()}}
      create={()=>roleScopes?requestRoleCreation(object,roleScopes):requestCreation({object,...(sourceScope?{scope:sourceScope}:{})})}/></Fragment>
  }

  const searchableConversations=searchManagement.ready&&searchDirectory.status==='ready'?presentConversations(searchDirectory.rows,Object.values(searchNative)).filter(row=>!searchManagement.archived.includes(row.conversation.sessionId)).map(row=>row.conversation.purpose==='assistant'&&row.title===assistantConversationTitle?{...row,title:assistantName}:row):[]
  const searchableMarketItems=()=>currentSolutionCatalog(marketRef.current.items).filter(item=>marketCategoryOf(item)!=='work-template')
  const workspaceSearchSource={
    conversations:searchableConversations,
    tasks:tasks.tasks.filter(task=>task.storage==='persistent'),
    roles:tasks.roles.filter(role=>role.storage==='persistent'),
    groups:(groupApi.directorySnapshot()?.items??[]).map(group=>({...group,storage:'persistent' as const})),
    spaces:scopeLabels.filter(label=>savedIndustryLoads.some(load=>load.space.scope===label.scope)).map(label=>({...label,storage:'persistent' as const})),
    knowledge:workspaceSearchKnowledge,
    capabilities:workspaceSearchCapabilities,
    plans:savedPlans.map(plan=>({id:plan.id,title:planDisplayTitle(plan.title,plan.source.kind==='system-digest',t),goal:plan.goal,roleName:plan.roleId===null?t('continuous.ownerAgent'):roleName(tasks.roles,plan.roleId,t),state:plan.state})),
    // 市场搜索不另造目录或示例：读取时才取当前市场状态，避免搜索快照把已移除条目带回页面。
    // 「先问问」临时带进来的官方方案只随问答草稿存在，不是本机内容，不进全局搜索
    get market(){return searchableMarketItems().map(item=>({id:item.id,...localizedMarketItemCopy(item,locale),detailKey:marketItemGroup(item)}))},
  }
  const openSearchResult=async(row:WorkspaceSearchResult)=>{
    if(row.kind==='conversation'){
      const found=searchableConversations.find(value=>value.conversation.id===row.id)
      if(!found)throw Error(t('frame.p5.directoryChanged'))
      await work.openConversation(found.conversation)
      if(work.getSnapshot().sessionId!==found.conversation.sessionId)throw Error(t('frame.p5.currentConversationChanged'))
      actions.navigate('messages')
    }else if(row.kind==='task'){
      if(!tasks.tasks.some(value=>value.id===row.id))throw Error(t('frame.p5.taskLeft'))
      actions.openTask(row.id)
    }else if(row.kind==='role'){
      if(!tasks.roles.some(value=>value.id===row.id))throw Error(t('frame.p5.roleLeft'))
      actions.previewRole(row.id)
    }else if(row.kind==='group'){
      if(!groupApi.directorySnapshot()?.items.some(value=>value.id===row.id&&!value.archived))throw Error(t('frame.p5.groupUnavailable'))
      openGroupTopic(row.id,'')
    }else if(row.kind==='knowledge'){
      if(!workspaceSearchKnowledge.some(value=>value.id===row.id))throw Error(t('frame.p5.directoryChanged'))
      actions.openResource(row.id)
    }else if(row.kind==='capability'){
      const found=workspaceSearchCapabilities.find(value=>'capability:'+value.key===row.key&&value.id===row.id)
      if(!found||!row.open||JSON.stringify(found.open)!==JSON.stringify(row.open))throw Error(t('frame.p5.directoryChanged'))
      if(found.open.kind==='installation')actions.openInstallations(found.open.id)
      else{
        actions.openCapabilityCatalog()
        actions.rememberDirectory('capabilities',{category:writeDirectoryFilterCategory({category:found.open.category,mobileLayer:'detail'}),selectedId:found.open.selectedId})
      }
    }else if(row.kind==='plan'){
      if(!savedPlans.some(plan=>plan.id===row.id))throw Error(t('frame.p5.directoryChanged'))
      actions.openPlans({kind:'plan',id:row.id})
    }else if(row.kind==='market'){
      // 点击时以当前市场状态复核，已移除条目不会借搜索快照重新打开。
      if(!searchableMarketItems().some(item=>item.id===row.id))throw Error(t('frame.p5.directoryChanged'))
      actions.openMarket(row.id)
    }else{
      const label=scopeLabels.find(value=>value.scope===row.id)
      if(!label)throw Error(t('frame.p5.spaceLeft'))
      enterBusiness({scope:label.scope,section:'overview'})
    }
  }
  const requestTaskCreationConversation=(scope:CollaborationScope='general',goal?:string)=>requestCreation({scope,goal:goal??t('workbench.create.taskPrompt')})
  const saveHomeGroup=async(value:{name:string;scope:CollaborationScope;announcement:string;memberIds:string[];rules:GroupRules})=>{
    setHomeCreationError(undefined)
    try{
      const saved=await groupApi.create({name:value.name,scope:value.scope,announcement:value.announcement,rules:value.rules,memberRoleIds:value.memberIds.filter(id=>id!=='self')})
      if(!('group' in saved))throw Error(t('frame.p5.groupCreateInvalid'))
      setHomeCreation(null)
      openGroupTopic(saved.group.id,'')
    }catch(error){
      if(groupApi.pending()){setHomeCreation(null);actions.openMessages('groups');return}
      setHomeCreationError(localizeWorkError(locale,error))
    }
  }
  const detailSession=workbenchDetailSession(state.detail,current,state.view==='messages'&&state.messageMode==='native')
  const detailTarget=activeDetailTarget(state.detail,detailSession)
  const artifactTarget=useMemo(()=>artifactPanelTarget(activeDetailTarget({open:true,target:state.detail.target},detailSession)),[state.detail.target,detailSession])
  const artifactOpen=detailTarget?.kind==='artifact'
  const [artifactMounts,setArtifactMounts]=useState<ReadonlyMap<string,HTMLElement>>(()=>new Map())
  const [artifactRailMount,setArtifactRailMount]=useState<HTMLDivElement|null>(null)
  const [groupArtifactSeat,setGroupArtifactSeat]=useState<{groupId:string;token:object}>(),[groupArtifactCollapse,setGroupArtifactCollapse]=useState(0)
  const reportGroupArtifact=useMemo(()=>(token:object,groupId:string,open:boolean)=>{if(open){actions.closeDetail();setGroupArtifactSeat({groupId,token})}else setGroupArtifactSeat(current=>current?.token===token?undefined:current)},[actions])
  // Teloa 不再与原生右栏互斥：原生右栏现在同时承载官方页类型与 Teloa 的对象页签，
  // “同一时刻只显示一种详情”改由 openTab 的 replaceTab 天然保证。
  const detailView=useRef(state.view)
  useLayoutEffect(()=>{if(detailView.current!==state.view){detailView.current=state.view;actions.closeDetail()}},[state.view,actions])
  const nativePanelVisible=state.panelInfo.activePanelId!==null
  const conversationVisible=!nativePanelVisible&&state.view==='messages'&&state.messageMode==='native'
  const nativeMainVisible=nativePanelVisible||conversationVisible||state.view==='home'
  const conversationDirectoryVisible=state.view==='messages'&&state.messageMode==='directory'
  // 右栏页签与页内详情之间的记账（开页、关闭钩子、收起）都交给这份协调器：
  // service face 每次重新取并接受它会抛，关闭钩子按页签身份判断该不该收页内详情。
  const rail=useRef<RailTabs>();rail.current??=createRailTabs(sidebarRightFace,kind=>TELOA_TAB_KINDS.includes(kind as TeloaTabKind))
  const railTabs=rail.current
  // 会话页里迁入原生右栏的页类型；其余仍走页内第三栏。
  const railKinds=useMemo(()=>new Set<TeloaTabKind>(TELOA_RAIL_KINDS),[])
  // 没有当前会话就没有右栏 surface，页签开不进去；这时 railServes 必须为假，否则页内第三栏被抑制、
  // 右栏又接不住，用户点一行什么都不出现。
  const railReady=conversationVisible&&!!current&&railTabs.available()
  const railServes=(kind:TeloaTabKind)=>railReady&&railKinds.has(kind)
  /** 收起当前会话里承载当前详情的那个 Teloa 页签；官方的终端、文件、文档预览一律不动。 */
  const closeRailObjectTab=()=>{if(current)railTabs.closeCurrent(current)}
  // 从会话进入任何员工或分身主页时，旧对象页签已经失去上下文；留着会在返回会话后错误复现。
  useLayoutEffect(()=>{if(state.view==='team')closeRailObjectTab()},[state.view,current])
  /**
   * 会话页打开对象详情：能走原生右栏就开一个页签，开不成就退回页内第三栏。
   * 两条路都先写 state.detail —— 它是刷新恢复的唯一真源，DSH 的页签是内存态。
   */
  const openDetailTab=(target:WorkbenchDetailTarget)=>{
    if(target.kind==='conversation-object'&&target.objectKind==='business')actions.openConversationBusiness(target.sessionId,target.target)
    else if(target.kind==='conversation-object')actions.openConversationObject(target.sessionId,{kind:target.objectKind,id:target.id,...(target.version!==undefined?{version:target.version}:{})})
    else actions.openDetail(target)
    const tab=detailTargetToTab(target)
    // 页签开进的是**当前会话**的 surface，所以记账也记在它名下：tab id 是每个会话自己铸的。
    if(!tab||!current||!railServes(tab.kind))return
    railTabs.open(current,tab.kind,tab.params,target)
  }
  const taskArtifactSources=useMemo(()=>taskArtifactPort(work,id=>artifactApi.taskSessions(id)),[work,artifactApi])
  const artifactReadIntent=useRef(0)
  const openArtifacts:OpenArtifacts=(source,artifact)=>{
    artifactReadIntent.current++
    // 新的持久任务结果预览须能读取原 Run 会话，不随旧会话切换被隐藏。
    const taskResult=source.kind==='task'&&!artifact&&tasks.tasks.some(task=>task.id===source.id&&task.storage==='persistent')
    actions.openArtifacts(source,artifact,conversationVisible&&!taskResult?current:undefined)
    // 任务、群及业务引用都揭示原成果；概况提供座位，外壳继续持有同一份反馈与修订草稿。
    if(conversationVisible&&current){try{sidebarRightFace()?.openTab(CONVERSATION_OVERVIEW_KIND)}catch{/* 右栏未就绪时保留既有详情承载。 */}}
  }
  const closeArtifacts=()=>{artifactReadIntent.current++;setGroupArtifactSeat(undefined);setGroupArtifactCollapse(value=>value+1);actions.closeDetail()}
  const [artifactLoadError,setArtifactLoadError]=useState('')
  const mergeArtifacts=(rows:import('./artifact-preview.js').Artifact[])=>setTasks(previous=>({...previous,artifacts:[...previous.artifacts.filter(old=>!rows.some(row=>row.id===old.id)),...rows.map(row=>{const old=previous.artifacts.find(item=>item.id===row.id);return old&&old.versions.length>row.versions.length?old:row})]}))
  // 拉取键把「任务台账已认出它是持久任务」算进依赖：刷新后详情种子先于台账到位，
  // 只盯来源身份的话首屏这一跳被跳过后就再没有第二次，成果目录会一直空着。
  // 进入任务时就回读已保存成果，不能等到点「整理」后才发现已有稿件。
  const artifactFetchKey=artifactListFetchKey(artifactOpen?artifactTarget:null,tasks.tasks,state.view==='tasks'?state.taskId:undefined)
  useEffect(()=>{if(!artifactFetchKey)return;const [kind,id]=[artifactFetchKey.slice(0,artifactFetchKey.indexOf(' ')) as 'session'|'task',artifactFetchKey.slice(artifactFetchKey.indexOf(' ')+1)];let active=true;setArtifactLoadError('');void artifactApi.list(id,kind).then(rows=>{if(active)mergeArtifacts(rows)}).catch(error=>{if(active)setArtifactLoadError(localizeWorkError(locale,error))});return()=>{active=false}},[artifactFetchKey,artifactApi])
  useEffect(()=>{
    if(!artifactOpen||!artifactFetchKey)return
    const split=artifactFetchKey.indexOf(' '),kind=artifactFetchKey.slice(0,split) as 'session'|'task',id=artifactFetchKey.slice(split+1);let active=true,reading=false
    const timer=setInterval(()=>{if(reading)return;reading=true;void artifactApi.list(id,kind).then(rows=>{if(active)mergeArtifacts(rows)}).catch(()=>{/* 初次读取保留正式错误；轮询不覆盖本人草稿或弹新错误。 */}).finally(()=>{reading=false})},3000)
    return()=>{active=false;clearInterval(timer)}
  },[artifactOpen,artifactFetchKey,artifactApi])
  const artifactConversation=canViewConversationArtifacts&&binding.conversation?{id:current!,title:title?.trim()||conversationTitle?.trim()||binding.conversation.title,scope:binding.conversation.scopeIds[0],bindingId:binding.conversation.id}:undefined
  const artifactSaveOrigin=useRef({api:artifactApi,conversation:artifactConversation,visible:conversationVisible});artifactSaveOrigin.current={api:artifactApi,conversation:artifactConversation,visible:conversationVisible}
  const saveArtifactCommand=async(command:import('./artifact-work.js').ArtifactWorkChange)=>{
    const next=changeArtifactWork(tasks,command,artifactConversation)
    const id=command.type==='create'||command.type==='change'?command.id:command.artifact.id
    const candidate=next.artifacts.find(item=>item.id===id)
    const acceptArtifact=(saved:import('./artifact-preview.js').Artifact)=>{
      if(artifactApi!==artifactSaveOrigin.current.api)throw Object.assign(Error(),{code:'teloa/source-unavailable'})
      mergeArtifacts([saved]);return saved.id
    }
    if(candidate&&(candidate.source.kind==='session'||candidate.source.kind==='task'&&tasks.tasks.some(task=>task.id===candidate.source.id&&task.storage==='persistent'))){
      if(command.type==='change'&&command.change.type==='feedback')return acceptArtifact(await artifactApi.feedback(candidate,command.change.version,command.change.sectionId,command.change.text))
      if(command.type!=='create'&&command.type!=='change')throw Error(t('frame.p5.artifactSaveUnsupported'))
      return acceptArtifact(await artifactApi.save(candidate,command.type==='create'))
    }
    setTasks(next)
  }
  const artifactRevisionConnection=useRef({artifactApi,taskRunApi,homeContextApi,work})
  if(artifactRevisionConnection.current.artifactApi!==artifactApi||artifactRevisionConnection.current.taskRunApi!==taskRunApi||artifactRevisionConnection.current.homeContextApi!==homeContextApi||artifactRevisionConnection.current.work!==work)artifactRevisionConnection.current={artifactApi,taskRunApi,homeContextApi,work}
  const artifactRevisionLifetime=useRef(true)
  useEffect(()=>{artifactRevisionLifetime.current=true;return()=>{artifactRevisionLifetime.current=false}},[])
  const artifactMethodReuseConnection=useRef({artifactApi,taskRunApi,homeContextApi,work,preparation,management})
  if(artifactMethodReuseConnection.current.artifactApi!==artifactApi||artifactMethodReuseConnection.current.taskRunApi!==taskRunApi||artifactMethodReuseConnection.current.homeContextApi!==homeContextApi||artifactMethodReuseConnection.current.work!==work||artifactMethodReuseConnection.current.preparation!==preparation||artifactMethodReuseConnection.current.management!==management)artifactMethodReuseConnection.current={artifactApi,taskRunApi,homeContextApi,work,preparation,management}
  const requestArtifactMethodReuse=async(artifactId:string,version:number,target:MethodReuseTarget,mayContinue?:(afterNavigation?:boolean)=>boolean)=>{
    const connection=artifactMethodReuseConnection.current,intent=artifactReadIntent.current,entry=JSON.stringify(latestState.current.detail.target),location=homeCreationLocation(latestState.current)
    let destination:string|undefined,leavesEntry=false
    const current=()=>{
      if(!artifactRevisionLifetime.current||artifactMethodReuseConnection.current!==connection||artifactReadIntent.current!==intent||mayContinue?.(leavesEntry)===false||!canPrepareArtifactMethodReuse(tasksRef.current.artifacts.find(item=>item.id===artifactId),version))return false
      const now=latestState.current,sameTarget=JSON.stringify(now.detail.target)===entry
      if(destination===undefined)return now.detail.open&&sameTarget&&homeCreationLocation(now)===location
      return work.getSnapshot().sessionId===destination&&(homeCreationLocation(now)===location||leavesEntry&&now.view==='messages'&&now.messageMode==='native')&&(leavesEntry?!now.detail.open||sameTarget:now.detail.open&&sameTarget)
    }
    if(!current())return
    const artifact=tasksRef.current.artifacts.find(item=>item.id===artifactId)!,source=artifact.versions.at(-1)!.source.ref,prompt=artifactMethodReusePreparation(artifact,version,target,t)
    let sessionId=source.kind==='session'?source.id:source.kind==='task'?(await taskRunApi.origin(source.id)).source?.sessionId:undefined
    if(!current())return
    if(sessionId){
      await work.refreshDirectory();if(!current())return
      const directory=work.getDirectorySnapshot()
      if(directory.status!=='ready')throw Error(t('workspaceSearch.conversationsUnavailable'))
      const row=directory.rows.find(item=>item.sessionId===sessionId),context=await homeContextApi.read(sessionId)
      if(!current())return
      // 成果来源不授予岗位会话权限；只复用本人普通会话，不把输入送入 task-run。
      if(!row||row.status!=='ready'||row.purpose==='task-run'||management.getSnapshot().archived.includes(sessionId)||context?.scopeId!=='general'||context.roleId!==null)sessionId=undefined
    }
    if(!sessionId){
      sessionId=(await openPersonalAssistantConversation(undefined,{current,opened:id=>{destination=id;leavesEntry=true}}))?.sessionId
      if(!current())return
    }
    if(!sessionId)return
    if(destination!==sessionId){
      if(await work.openSessionResult(sessionId,undefined,current)!=='opened')return
      destination=sessionId;leavesEntry=true
    }
    if(!current()||work.getSnapshot().sessionId!==sessionId)return
    preparation.prepare({id:crypto.randomUUID(),sessionId,...prompt})
    closeArtifacts();actions.openMessages('native')
  }
  const requestArtifactRevision=async(artifactId:string,version:number,feedbackId:string,mayContinue?:(afterNavigation?:boolean)=>boolean)=>{
    const connection=artifactRevisionConnection.current,intent=artifactReadIntent.current,entry=JSON.stringify(latestState.current.detail.target),location=homeCreationLocation(latestState.current)
    let destination:string|undefined,leavesEntry=false
    const current=()=>{
      if(!artifactRevisionLifetime.current||artifactRevisionConnection.current!==connection||artifactReadIntent.current!==intent||mayContinue?.(leavesEntry)===false)return false
      const now=latestState.current,sameTarget=JSON.stringify(now.detail.target)===entry
      if(destination===undefined)return now.detail.open&&sameTarget&&homeCreationLocation(now)===location
      // 只允许本次已核对的会话切换收起原详情；新的对象、页面或用户会话不继承这个发送意图。
      return work.getSnapshot().sessionId===destination&&(homeCreationLocation(now)===location||leavesEntry&&now.view==='messages'&&now.messageMode==='native')&&(leavesEntry?!now.detail.open||sameTarget:now.detail.open&&sameTarget)
    }
    if(!current())return
    const artifact=tasks.artifacts.find(row=>row.id===artifactId),source=artifact?.versions.find(row=>row.number===version)?.source
    if(!source||source.scope!=='general')throw Object.assign(Error(),{code:'teloa/source-unavailable'})
    let sessionId=source.ref.kind==='task'?(await taskRunApi.origin(source.ref.id)).source?.sessionId:undefined
    if(!current())return
    if(!sessionId&&source.ref.kind==='session'){
      await work.refreshDirectory()
      if(!current())return
      const row=work.getDirectorySnapshot().rows.find(row=>row.sessionId===source.ref.id),context=await homeContextApi.read(source.ref.id)
      if(!current())return
      if(row?.status==='ready'&&row.purpose!=='task-run'&&context?.scopeId==='general'&&context.roleId===null)sessionId=row.sessionId
    }
    if(!sessionId){
      sessionId=(await openPersonalAssistantConversation(undefined,{current,opened:id=>{destination=id;leavesEntry=true}}))?.sessionId
      if(!current())return
    }
    if(!sessionId)throw Object.assign(Error(),{code:'teloa/source-unavailable'})
    if(destination!==sessionId){
      const opened=await work.openSessionResult(sessionId,undefined,current)
      if(opened!=='opened')return
      destination=sessionId
      const target=state.detail.target,bound=target?.kind==='artifact'?(target.sessionId??(target.source.kind==='session'?target.source.id:undefined)):undefined
      leavesEntry=bound!==undefined&&bound!==sessionId
    }
    if(!current()||work.getSnapshot().sessionId!==sessionId)return
    const result=await artifactApi.requestRevision(artifactId,version,feedbackId,sessionId)
    if(!current())return
    if(result.state!=='requested'){if(result.taskId)actions.openTask(result.taskId);return}
    sendConversationMessage(sessionId,t('frame.p5.artifactRevisionPrompt',{revision:'[teloa-revision:'+result.id+']'}))
    closeArtifacts();actions.openMessages('native')
  }
  const openArtifactSource=async(ref:ArtifactSourceRef)=>{if(ref.kind==='task')actions.openTask(ref.id);else if(ref.kind==='run')actions.openPlans({kind:'run',id:ref.id});else if(ref.kind==='session'){await work.openSession(ref.id);actions.openMessages('native')}else enterBusiness({scope:ref.scope as CollaborationScope,section:ref.kind==='object'?'data':'analysis',id:ref.id,...(ref.kind==='object'?{objectType:ref.objectType}:{})})}
  const [market,setMarket]=useState(emptyMarket),marketRef=useRef(market),preparing=useRef(new Map<string,Promise<void>>())
  const targets=marketTargets(tasks.roles.filter(role=>role.storage==='persistent'),collaboration,scopeLabels),targetsRef=useRef(targets)
  targetsRef.current=targets
  const openTarget=(target:MarketTargetRef)=>{if(target.kind==='role')actions.previewRole(target.id);else if(target.kind==='group')openGroupTopic(target.id,'');else enterBusiness({scope:target.scope as CollaborationScope,section:'overview'})}
  useEffect(()=>{for(const intent of market.intents)if(intent.targetRef&&checkMarketTarget(intent.targetRef,targetsRef.current).status!=='current')preparation.invalidate(intent.id)},[tasks.roles,collaboration,market.intents,preparation])
  const configureBinding=(_intentId:string)=>actions.openBinding(null)
  const changeMarket=(next:MarketState)=>{marketRef.current=next;setMarket(next)}
  const confirmPageCreateSkill=async(preview:import('@teloa/contract').PageCreateDraftPreview):Promise<string>=>{
    // 采用前回读正式来源；方法成果撤回或版本变化不能沿用已打开的旧预览。
    const currentPreview=await pageCreateApi.preview({draftId:preview.draft.id})
    if(currentPreview.draft.entity!=='skill'||currentPreview.draft.id!==preview.draft.id||currentPreview.draft.bodyHash!==preview.draft.bodyHash||currentPreview.draft.body!==preview.draft.body)throw Object.assign(Error(),{code:'teloa/version-conflict'})
    const content=await pageCreateAtomicSkillContent(JSON.parse(preview.draft.body))
    const item=await marketContentApi.importAtomic(content,t('create.skill.source'))
    const current=marketRef.current
    changeMarket({...current,items:mergeMarketItems(current.items,[item])})
    if(!item.contentStorage?.contentId)throw Error(t('create.readFailed'))
    return item.contentStorage.contentId
  }
  const openConfirmedPageCreateSkill=(contentId:string)=>{
    const item=marketRef.current.items.find(row=>row.contentStorage?.contentId===contentId)
    actions.openMarket(item?.id)
  }
  const confirmPageCreateConnector=async(scope:string,preview:import('@teloa/contract').PageCreateDraftPreview):Promise<string>=>{
    if(!businessSpace)throw Error(t('create.readFailed'))
    const candidate=await pageCreateConnectorIndustryItem(JSON.parse(preview.draft.body),t('create.connector.source'),scope)
    const item=await marketContentApi.importIndustry(candidate)
    const current=marketRef.current
    changeMarket({...current,items:mergeMarketItems(current.items,[item])})
    // contentHash 是整包内容哈希（导入回包 packageContent.hash，与市场目录 id `directory-<hash>` 同源），不是 teloa.json 单文件的 item.hash——传错后端一律回「固定来源不一致」。
    if(!item.contentStorage?.contentId||!item.packageContent?.hash||!isIndustryManifest(item.manifest))throw Error(t('create.readFailed'))
    const load=await industryLoadApi.create({requestId:crypto.randomUUID(),contentId:item.contentStorage.contentId,contentHash:item.packageContent.hash,target:{kind:'existing',spaceId:businessSpace.id,expectedVersion:businessSpace.version}})
    industryLoadGeneration.current++
    mergeIndustryLoad(load)
    void loadBusinessDirectory().catch(()=>{})
    const resource=item.manifest.resources[0]
    const loadItem=resource&&load.items.find(row=>row.localId===resource.id&&row.kind===resource.kind)
    if(!loadItem)throw Error(t('create.readFailed'))
    if(loadItem.kind==='data-source')await instantiateIndustryDataSource({requestId:crypto.randomUUID(),loadId:load.id,itemInstanceId:loadItem.instanceId})
    else if(loadItem.kind==='mcp')await instantiateIndustryMcpConnection({requestId:crypto.randomUUID(),loadId:load.id,itemInstanceId:loadItem.instanceId})
    else throw Error(t('create.readFailed'))
    return load.id+':'+loadItem.instanceId
  }
  const openConfirmedPageCreateConnector=(value:string)=>{
    const [loadId,itemInstanceId]=value.split(':')
    if(loadId&&itemInstanceId)actions.openIndustryResources({loadId,itemInstanceId})
  }
  const confirmPageCreateBusinessDomain=async(preview:import('@teloa/contract').PageCreateDraftPreview):Promise<string>=>{
    const scope=preview.draft.scope
    if(!businessSpace||!scope)throw Error(t('create.readFailed'))
    const candidate=await pageCreateBusinessDomainIndustryItem(JSON.parse(preview.draft.body),t('create.businessDomain.source'),scope)
    const item=await marketContentApi.importIndustry(candidate)
    const current=marketRef.current
    changeMarket({...current,items:mergeMarketItems(current.items,[item])})
    // 同上：整包内容哈希走 packageContent.hash。
    if(!item.contentStorage?.contentId||!item.packageContent?.hash)throw Error(t('create.readFailed'))
    const load=await industryLoadApi.create({requestId:crypto.randomUUID(),contentId:item.contentStorage.contentId,contentHash:item.packageContent.hash,target:{kind:'existing',spaceId:businessSpace.id,expectedVersion:businessSpace.version}})
    industryLoadGeneration.current++
    mergeIndustryLoad(load)
    await loadBusinessDirectory()
    return load.id
  }
  const finishAttentionSource=(source:WorkAttentionOriginalSource)=>{
    const key=JSON.stringify(source)
    setAttentionSourceSelection(current=>current?.identity===attentionIdentity&&JSON.stringify(current.source)===key?undefined:current)
  }
  const attentionCreation=(source:WorkAttentionOriginalSource):Pick<CreateEntryProps,'onConfirm'|'afterConfirm'|'renderConfirmation'|'renderBusinessPreview'|'confirmLabelKey'>|undefined=>{
    if(source.kind!=='page-create-draft')return undefined
    let creation:Pick<CreateEntryProps,'onConfirm'|'afterConfirm'|'renderConfirmation'|'renderBusinessPreview'|'confirmLabelKey'>
    if(source.entity==='plan'){
      const origin=planDraftFrame.current
      const current=()=>projectFrameMounted.current&&planDraftFrame.current.connection===origin.connection&&planDraftFrame.current.selection===origin.selection&&planDraftFrame.current.entry===origin.entry
      return {
        confirmLabelKey:planDraftConfirmLabel,
        onConfirm:async preview=>{
          if(!current()||preview.draft.entity!=='plan'||preview.draft.id!==source.draftId||preview.draft.bodyHash!==source.bodyHash)throw Object.assign(Error(),{name:'AbortError'})
          const result=await planDraftApi.confirm({draftId:preview.draft.id,expectedBodyHash:preview.draft.bodyHash})
          if(!current())throw Object.assign(Error(),{name:'AbortError'})
          return result.planId
        },
        afterConfirm:planId=>{
          if(!current())return
          const generation=++savedPlanLoadGeneration.current
          setSavedPlanDirectory('loading')
          void conversationPlans.refresh().then(rows=>{
            if(projectFrameMounted.current&&planDraftFrame.current.connection===origin.connection&&generation===savedPlanLoadGeneration.current){mergeSavedPlans(rows);setSavedPlanDirectory('ready')}
          },()=>{
            if(projectFrameMounted.current&&planDraftFrame.current.connection===origin.connection&&generation===savedPlanLoadGeneration.current)setSavedPlanDirectory('failed')
          })
          finishAttentionSource(source)
          actions.openPlans({kind:'plan',id:planId})
        },
      }
    }
    if(source.entity==='role')creation={onConfirm:preview=>createSavedRole(roleWriteDefinition(JSON.parse(preview.draft.body))),afterConfirm:actions.previewRole}
    else if(source.entity==='skill')creation={onConfirm:confirmPageCreateSkill,afterConfirm:openConfirmedPageCreateSkill}
    else if(source.entity==='extension')creation={renderConfirmation:({preview,apply})=><ExtensionCreateEntry preview={preview} api={marketPluginInstallApi} apply={apply}/>}
    else if(source.entity==='share')creation={renderConfirmation:({preview,apply})=><PageCreateShareConfirmation preview={preview} apply={apply} api={pageCreateApi} confirmed={()=>{finishAttentionSource(source);void workAttention.reload()}}/>}
    else if(source.entity==='connector'&&source.scope)creation={onConfirm:preview=>confirmPageCreateConnector(source.scope!,preview),afterConfirm:openConfirmedPageCreateConnector}
    else if(source.entity==='business-domain')creation={onConfirm:confirmPageCreateBusinessDomain,afterConfirm:openConfirmedPageCreateBusinessDomain}
    else if(source.entity==='business-definition'&&source.scope)creation={
      onConfirm:preview=>{if(!preview.businessPreview)throw Error(t('business.custom.readFailed'));return applyPageCreatedBusinessDefinition(businessCustomizationApi,source.scope!,preview.businessPreview)},
      renderBusinessPreview:preview=><BusinessDefinitionCreatePreview preview={preview}/>,
    }
    else return undefined
    return {...creation,afterConfirm:value=>{finishAttentionSource(source);creation.afterConfirm?.(value)}}
  }
  const openConfirmedPageCreateBusinessDomain=(loadId:string)=>{
    const load=savedIndustryLoadsRef.current.find(row=>row.id===loadId)
    if(load)enterBusiness({scope:load.space.scope as CollaborationScope,section:'overview'})
  }
  const updateIntent=(id:string,version:number,purpose:string,visibility:'personal'|'team',withdraw=false)=>{
    const next=updateMarketIntent(marketRef.current,{id,expectedVersion:version,purpose,visibility,action:withdraw?'withdraw':'edit',now:new Date().toISOString()})
    preparation.invalidate(id);changeMarket(next)
  }
  const prepareMarket=(item:MarketItem,given?:MarketIntent):Promise<void>=>{
    let next=marketRef.current
    next={...next,items:mergeMarketItems(next.items,[item])}
    const itemId=marketItemId(item)
    if(!given)next=saveMarketIntent(next,{id:crypto.randomUUID(),itemId,scope:item.scope,target:t('frame.p5.currentWorkspace'),purpose:item.summary,visibility:'personal',now:new Date().toISOString()})
    changeMarket(next)
    const draft=given?next.intents.find(value=>value.id===given.id):next.intents.find(value=>value.itemId===itemId&&value.scope===item.scope&&!value.targetRef&&value.target===t('frame.p5.currentWorkspace')&&value.status==='draft')
    if(!draft||draft.status!=='draft')return Promise.reject(Error(t('frame.p5.sourceDraftUnavailable')))
    if(draft.targetRef){const check=checkMarketTarget(draft.targetRef,targetsRef.current);if(check.status!=='current')return Promise.reject(new MarketTargetCheckError(check))}
    const pending=preparing.current.get(draft.id);if(pending)return pending
    changeMarket({...marketRef.current,intents:marketRef.current.intents.map(value=>value.id===draft.id?{...value,preparation:{status:'pending',message:t('frame.p5.preparingConversation')}}:value)})
    const operation=(async()=>{
      let conversation
      if(draft.sessionId){await work.refreshDirectory();conversation=work.getDirectorySnapshot().rows.find(value=>value.sessionId===draft.sessionId);if(!conversation)throw Error(t('frame.p5.linkedConversationUnavailable'));await work.openConversation(conversation)}
      else conversation=await work.create()
      const latest=marketRef.current.intents.find(value=>value.id===draft.id)
      if(!latest||latest.status!=='draft'||latest.version!==draft.version)throw Error(t('frame.p5.draftChanged'))
      if(latest.targetRef){const check=checkMarketTarget(latest.targetRef,targetsRef.current);if(check.status!=='current')throw new MarketTargetCheckError(check)}
      changeMarket({...marketRef.current,intents:marketRef.current.intents.map(value=>value.id===draft.id?{...value,sessionId:conversation.sessionId,preparation:{status:'ready',message:t('frame.p5.requirementReady')}}:value)})
      preparation.invalidate(draft.id)
      preparation.prepare({id:crypto.randomUUID(),sourceId:draft.id,sourceVersion:draft.version,sessionId:conversation.sessionId,title:item.title,text:marketPrompt(item,draft)})
      if(work.getSnapshot().sessionId===conversation.sessionId)actions.navigate('messages')
      else throw Error(t('frame.p5.preparedElsewhere'))
    })().catch(error=>{
      const latest=marketRef.current.intents.find(value=>value.id===draft.id)
      if(latest?.version===draft.version&&latest.status==='draft')changeMarket({...marketRef.current,intents:marketRef.current.intents.map(value=>value.id===draft.id?{...value,preparation:{status:'failed',message:localizeWorkError(locale,error)}}:value)})
      throw error
    })
    preparing.current.set(draft.id,operation);void operation.finally(()=>preparing.current.delete(draft.id)).catch(()=>{})
    return operation
  }
  const closeCreation=()=>{if(creating)return;const project=creationIntent?.projectConversation;if(project&&!project.preparation&&projectApi.runtime?.creation(project.projectId)?.workspaceResolved!==true)projectApi.runtime?.completeCreation(project.projectId,project.requestId);creationIntent?.resolve?.(false);setCreationIntent(null);setWorkspaceSelection(false);setCreationMode('create');setCreationError(undefined)}
  const artifactRecoveries=artifactApi.recoveryItems()
  const [serverRecoveries,setServerRecoveries]=useState<PendingRequest[]>([]),[serverRecoveryError,setServerRecoveryError]=useState<string>(),[serverRecoveryNotice,setServerRecoveryNotice]=useState<string>(),[recoveringServerRequest,setRecoveringServerRequest]=useState<string>()
  const serverRecoveryGeneration=useRef(0)
  const loadServerRecoveries=async()=>{
    const generation=++serverRecoveryGeneration.current
    try{const rows=await pendingRequestApi.list();if(generation===serverRecoveryGeneration.current){setServerRecoveries(rows);setServerRecoveryError(undefined)}}
    catch(error){if(generation===serverRecoveryGeneration.current)setServerRecoveryError(localizeWorkError(locale,error))}
  }
  useEffect(()=>{void loadServerRecoveries();return pendingRequestApi.subscribe(()=>{void loadServerRecoveries()})},[pendingRequestApi,locale])
  const recoverServerRequest=async(requestId:string)=>{
    if(recoveringServerRequest)return
    setRecoveringServerRequest(requestId);setServerRecoveryNotice(undefined)
    try{
      const result=await pendingRequestApi.recover(requestId)
      await Promise.allSettled([loadTasks(),loadRoles(),loadHandoffs(),loadIndustryLoads(),loadSavedPlans(),loadBusinessDirectory()])
      await loadServerRecoveries()
      if(!result.acknowledged)setServerRecoveryNotice(t('attention.recovery.ackUnknown'))
      return result.acknowledged?undefined:t('attention.recovery.ackUnknown')
    }catch(error){
      // 确定性拒绝可能已经移出服务端目录；网络未知则仍会列出。不能只保留一张过期卡。
      await loadServerRecoveries()
      setServerRecoveryNotice(localizeWorkError(locale,error))
      throw error
    }finally{setRecoveringServerRequest(undefined)}
  }
  const [recoveryArtifacts,setRecoveryArtifacts]=useState<import('./artifact-preview.js').Artifact[]>([])
  const recoveryArtifactKey=artifactRecoveries.map(item=>item.key).join('\0')
  useEffect(()=>{let active=true;const sources=[...new Map(artifactRecoveries.map(item=>[item.source.kind+':'+item.source.id,item.source])).values()];if(!sources.length){setRecoveryArtifacts([]);return}void Promise.all(sources.map(source=>artifactApi.list(source.id,source.kind))).then(rows=>{if(active)setRecoveryArtifacts(rows.flat())},()=>{if(active)setRecoveryArtifacts([])});return()=>{active=false}},[artifactApi,recoveryArtifactKey])
  const materialRequest=taskMaterialApi.pending(),materialTask=materialRequest&&tasks.tasks.find(task=>task.id===materialRequest.taskId&&task.storage==='persistent')
  const groupRequest=groupApi.pending(),groupRecoveryKey=groupRequest&&groupRequest.kind!=='create'?groupRequest.request.requestId:undefined,groupRecoveryGeneration=useRef(0),[recoveryGroupDirectory,setRecoveryGroupDirectory]=useState<RecoveryGroupDirectory>()
  useEffect(()=>{const generation=++groupRecoveryGeneration.current;setRecoveryGroupDirectory(undefined);if(!groupRequest||groupRequest.kind==='create')return;void readRecoveryGroupDirectory(groupApi,groupRequest).then(directory=>{const current=groupApi.pending();if(generation!==groupRecoveryGeneration.current||!directory||!current||current.kind==='create'||current.request.requestId!==directory.requestId)return;if(directory.status==='missing')groupApi.discardInaccessibleRecovery(directory.items);else setRecoveryGroupDirectory(directory)},()=>{if(generation===groupRecoveryGeneration.current)setRecoveryGroupDirectory(undefined)})},[groupApi,groupRecoveryKey])
  const groupDirectory=recoveryGroupDirectory&&recoveryGroupDirectory.requestId===groupRecoveryKey?recoveryGroupDirectory.items:undefined
  const industryRequest=industryLoadApi.pending(),industryItem=industryRequest&&market.items.find(item=>item.contentStorage?.contentId===industryRequest.contentId)
  const skillRequest=skillInstallApi.pending(),skillSource=skillRequest?.source,skillLoad=skillSource?.kind==='industry'?savedIndustryLoads.find(load=>load.id===skillSource.loadId):undefined,industrySkill=skillSource?.kind==='industry'?skillLoad?.items.find(item=>item.instanceId===skillSource.itemInstanceId&&item.kind==='skill'&&item.status==='pending-adapter'):undefined,skillContentId=skillSource?.kind==='atomic'?skillSource.contentId:undefined,skillItem=skillContentId?market.items.find(item=>item.contentStorage?.contentId===skillContentId):undefined
  // 冷启动也必须在「需要你」直接恢复原请求，不依赖先浏览市场来预热目录。
  const pendingMarketKey=JSON.stringify([industryRequest,skillSource?.kind==='atomic'?skillRequest:undefined])
  const missingMarketContentIds=[...new Set([industryRequest?.contentId,skillContentId].filter((id):id is string=>!!id&&!market.items.some(item=>item.contentStorage?.contentId===id)))]
  const missingMarketContentKey=JSON.stringify(missingMarketContentIds)
  const pendingMarketReadGeneration=useRef(0),pendingMarketReadContext=useRef({marketContentApi,industryLoadApi,skillInstallApi,key:pendingMarketKey})
  pendingMarketReadContext.current={marketContentApi,industryLoadApi,skillInstallApi,key:pendingMarketKey}
  const [pendingMarketReadAttempt,retryPendingMarketRead]=useState(0)
  const [pendingMarketReadFailure,setPendingMarketReadFailure]=useState<{api:MarketContentApi;key:string}>()
  const pendingMarketKnown=missingMarketContentIds.length===0&&!(pendingMarketReadFailure?.api===marketContentApi&&pendingMarketReadFailure.key===pendingMarketKey)
  useEffect(()=>{
    const generation=++pendingMarketReadGeneration.current,context=pendingMarketReadContext.current
    const currentKey=()=>{const skill=skillInstallApi.pending();return JSON.stringify([industryLoadApi.pending(),skill?.source.kind==='atomic'?skill:undefined])}
    const isCurrent=()=>generation===pendingMarketReadGeneration.current&&context.marketContentApi===pendingMarketReadContext.current.marketContentApi&&context.industryLoadApi===pendingMarketReadContext.current.industryLoadApi&&context.skillInstallApi===pendingMarketReadContext.current.skillInstallApi&&context.key===pendingMarketReadContext.current.key&&context.key===currentKey()
    setPendingMarketReadFailure(undefined)
    void readPendingMarketContents(marketContentApi,missingMarketContentIds,isCurrent).then(rows=>{
      if(!rows||!isCurrent())return
      const current=marketRef.current,next=mergeMarketItems(current.items,rows)
      changeMarket({...current,items:next})
    }).catch(()=>{if(isCurrent())setPendingMarketReadFailure({api:marketContentApi,key:context.key})})
    return()=>{pendingMarketReadGeneration.current++}
  },[marketContentApi,industryLoadApi,skillInstallApi,pendingMarketKey,missingMarketContentKey,pendingMarketReadAttempt])
  const localRecoveries=localRecoveryItems({taskMaterial:materialRequest&&materialTask?{taskId:materialRequest.taskId,title:materialTask.title,scope:materialTask.scope}:undefined,artifacts:artifactRecoveries,artifactDirectory:recoveryArtifacts,group:groupRequest&&groupRequest.kind!=='create'?{id:groupRequest.request.groupId}:undefined,groupDirectory:groupDirectory??[],industryLoad:industryRequest&&industryItem?{id:industryRequest.requestId,item:industryItem,scope:industryRequest.target.kind==='existing'?savedIndustryLoads.find(load=>load.space.id===industryRequest.target.spaceId)?.space.scope??'general':'general'}:undefined,skillInstall:skillRequest&&skillSource?.kind==='atomic'&&skillItem?{id:skillRequest.requestId,item:skillItem}:skillRequest&&skillSource?.kind==='industry'&&industrySkill?{id:skillRequest.requestId,item:{id:industrySkill.instanceId,title:industrySkill.title},source:skillSource}:undefined})
  const attentionItems=useMemo(()=>aggregateAttentionItems({tasks:tasks.tasks,taskAttention,workAttention:workAttention.items,securityAttention,handoffs,business:tasks.business,continuous:tasks.continuous,savedPlanIds:new Set(savedPlans.map(plan=>plan.id)),bindings:[],localRecoveries,serverRecoveries:serverRecoveryItems(serverRecoveries,t('attention.recovery.serverTitle'),endpoint=>pendingRequestOperation(locale,endpoint))},t),[tasks.tasks,taskAttention,workAttention.items,securityAttention,handoffs,tasks.business,tasks.continuous,savedPlans,localRecoveries,serverRecoveries,t,locale])
  const needCount=formalAttentionCount(attentionItems)
  const attentionStatus={count:needCount,known:pendingMarketKnown&&workAttention.known&&securityAttentionKnown&&handoffsKnown&&!handoffError&&savedPlanDirectory==='ready'&&!serverRecoveryError,incomplete:workAttention.loaded&&!workAttention.known||workAttention.error!==undefined}
  // 「需要你」页与左栏徽标共用这一份重读：任一来源（交接、任务、外部动作、计划、服务端待恢复）读取失败
  // 都会让 attentionStatus.known 变 false，重试就把它们全部再拉一遍，而不是只挑失败的那个。
  const retryAttention=()=>{retryPendingMarketRead(value=>value+1);void Promise.allSettled([workAttention.reload(),loadTasks(),loadHandoffs(),loadSecurityAttention(),loadSavedPlans(),loadServerRecoveries()])}
  // 需要你里点任务类事项在原地选中，保留收件箱与筛选；其它页面进入时仍跳转任务页
  // 决策卡在“需要你”内展开；右侧箭头才进入真实任务详情，避免两种页面混在同一入口。
  const openAttentionTask=(taskId:string)=>actions.openTask(taskId)
  const openAttention=(item:AttentionItem)=>openAttentionItem(item,{openWorkAttention:source=>setAttentionSourceSelection({source,identity:attentionIdentity}),openSecurityAction:(taskId,actionId)=>{setSecurityFocus(current=>({taskId,actionId,revision:(current?.revision??0)+1}));openAttentionTask(taskId)},openTask:openAttentionTask,openArtifact:(source,artifactId,version)=>openArtifacts(source,{id:artifactId,version}),openGroup:id=>openGroupTopic(id,''),openMarket:actions.openMarket,openIndustrySkill:(loadId,itemInstanceId)=>{void loadIndustryLoads().then(()=>{const load=savedIndustryLoadsRef.current.find(item=>item.id===loadId),skill=load?.items.find(candidate=>candidate.instanceId===itemInstanceId&&candidate.kind==='skill'&&candidate.status==='pending-adapter');if(skill)actions.openIndustrySkill(loadId,itemInstanceId)}).catch(()=>{})},openBusiness:enterBusiness,openPlans:actions.openPlans,openBinding:actions.openBinding,openInstallation:actions.openInstallations,openPendingRequest:()=>{}})
  // 只在需要你列表里出现过的安全动作任务上各拉一次，面板没到位时卡片退回“去处理”。
  const loadSecurityPanel=async(taskId:string)=>{
    const generation=(securityPanelLoads.current[taskId]??0)+1
    securityPanelLoads.current[taskId]=generation
    const current=()=>securityPanelLoads.current[taskId]===generation
    try{
      const origin=await businessTaskApi.source(taskId)
      if(!origin||!current())return undefined
      const task=tasksRef.current.tasks.find(row=>row.id===taskId)
      if(!task)return undefined
      const panel=await securityActionApi.list(taskId)
      // 已经有更新的一次拉取在路上：这份事实过期了，既不写面板也不清错误，更不交回给调用方。
      if(!current())return undefined
      const entry={panel,context:{panel,taskVersion:task.version,source:{taskId:origin.taskId,ownerId:origin.ownerId,sourceId:origin.sourceId,reference:origin.reference}}}
      setSecurityPanels(previous=>({...previous,[taskId]:entry}))
      setSecurityPanelErrors(({[taskId]:_dropped,...rest})=>rest)
      return entry
    }catch(cause){
      // 拉失败要留痕：卡片据此显示错误与重试，不装作“这条没有可做的事”。
      // 但迟到的失败不该盖掉更新一次拉取的结果，否则界面在「已是最新」上报一句旧错误。
      if(current())setSecurityPanelErrors(previous=>({...previous,[taskId]:localizeWorkError(locale,cause)}))
      throw cause
    }
  }
  useEffect(()=>{
    const taskIds=[...new Set(attentionItems.flatMap(item=>item.target.kind==='security-action'?[item.target.taskId]:[]))]
    for(const taskId of taskIds)if(!securityPanelsRef.current[taskId])void loadSecurityPanel(taskId).catch(()=>{})
  },[attentionItems])
  const securityDecisionEvidence=(taskId:string,actionId:string)=>{
    const entry=securityPanels[taskId],action=entry?.panel.actions.find(row=>row.id===actionId)
    if(!entry||!action)return []
    return securityActionEvidence(action,entry.panel,{receiptTitle:kind=>t(kind==='acceptance'?'security.acceptance':'security.effect'),approvalTitle:decision=>t(decision==='approved'?'evidence.approvalApproved':'evidence.approvalRejected'),targetState:state=>t('security.target.'+state as 'security.target.succeeded'),goalTitle:t('evidence.actionGoal'),dispatchTitle:t('evidence.dispatch'),dispatchSource:dispatched=>t(dispatched?'evidence.dispatchExecutor':'evidence.dispatchProposal')})
  }
  // 三拍中间那次重载必须把新事实直接交回给发起方：靠组件重渲染取新 props 的话，
  // 卡片一旦被筛走或收起，第三拍就永远等不到。
  const reloadSecurityDecision=async(taskId:string,actionId:string):Promise<SecurityDecisionSnapshot|null>=>{
    const [entry,rows]=await Promise.all([loadSecurityPanel(taskId),loadSecurityAttention()])
    void loadTasks()
    const action=entry?.panel.actions.find(row=>row.id===actionId)
    if(!entry||!action||rows===undefined)return null
    return {action,panel:entry.panel,context:entry.context,attention:rows,known:true}
  }
  const securityDecisionProps=(taskId:string,actionId:string)=>{
    const entry=securityPanels[taskId],action=entry?.panel.actions.find(row=>row.id===actionId)
    if(!entry||!action)return null
    const outcomeKey=decisionOutcomeKey(taskId,actionId)
    return {
      action,panel:entry.panel,context:entry.context,attention:securityAttention,known:securityAttentionKnown,api:securityActionApi,
      panelError:securityPanelErrors[taskId],reload:()=>reloadSecurityDecision(taskId,actionId),
      outcome:securityDecisionOutcome[outcomeKey],
      setOutcome:(next:SecurityDecisionOutcome)=>setSecurityDecisionOutcome(current=>({...current,[outcomeKey]:next})),
    }
  }
  // 卡内“本人接手”走的就是详情页那条 handoffs/resolve，只是把 target 钉死为 self。
  // 没有待处理交接单或任务不在手上时返回 null，卡片退回“去处理”——接手动作需要
  // handoffId 与任务版本，缺一个都不能凭空造。
  // 交接段要等任务被选中后才挂上来，所以下一帧再找锚点；找不到就什么都不做，不硬滚到别处。
  const revealHandoffSection=()=>{requestAnimationFrame(()=>{document.querySelector('[data-teloa-handoff-section]')?.scrollIntoView({block:'nearest'})})}
  const handoffDecisionProps=(taskId:string)=>{
    const row=handoffs.find(item=>item.status==='pending'&&item.taskId===taskId)
    const task=tasks.tasks.find(item=>item.id===taskId&&item.storage==='persistent')
    if(!row||!task)return null
    return {
      canTakeOver:canResolveHandoff(task,row.fromRoleId),
      pending:handoffPort.pending?.taskId===taskId,
      error:handoffPort.error,
      recover:async()=>{await handoffPort.recover();await loadTasks()},
      openSection:()=>{openAttentionTask(taskId);revealHandoffSection()},
      takeOver:async(note:string)=>{await handoffPort.resolve(taskId,{handoffId:row.id,expectedTaskVersion:task.version,target:{kind:'self'},note});await loadTasks()},
    }
  }
  const activePlans=tasks.continuous.plans.filter(plan=>!plan.archived),savedActivePlanIds=new Set(savedPlans.filter(plan=>plan.state!=='archived').map(plan=>plan.id))
  const planStatus={savedPlans:activePlans.filter(plan=>savedActivePlanIds.has(plan.id)).length,examplePlans:0,exampleRuns:0,directory:savedPlanDirectory}
  /**
   * 业务视图分两层：左栏点「业务」回到业务台账首页，打开某个范围（卡片、`openBusiness`、右栏页签）进范围内页。
   * 首页/内页与精确目标一起按本人空间持久化；本人返回首页后刷新不能重开旧内页。
   */
  const businessHome=state.navigationDirectories.spaces?.businessHome!==false
  const businessShortcuts=useSyncExternalStore(personalBusinessShortcuts.subscribe,personalBusinessShortcuts.getSnapshot,personalBusinessShortcuts.getSnapshot)
  /** 每次进入业务范围都换一个 key，确保目录位置从当前正式数据重新计算。 */
  const [businessEntry,setBusinessEntry]=useState<BusinessEntry>({serial:0})
  // 比的是目标的取值而不是对象身份；启动恢复期的 `reconcileBusiness` 真会改值（范围回退、抹掉读不到的 id），
  // 那不是用户「打开了一个范围」，所以恢复副作用调 `reconcileBusiness` 之前先用 `settleBusinessTarget` 把
  // 已见取值推到新值，effect 再跑时就不会把用户从业务台账首页踢进内页。
  const businessTargetSignature=businessTargetKey(state.businessTarget)
  const businessNavSeen=useRef<BusinessNavSeen>({viewSeen:state.view,targetSeen:businessTargetSignature,openRequestSeen:state.businessOpenRequest})
  /**
   * 这一位与两份「已见」取值只由 `businessNavStep` 决定，外壳只报来由、写结果（终审 M4）。
   * 已见取值留在 ref 里同步改：改成 state 会让恢复期「先落定再 reconcile」的顺序落到两次渲染里，把用户踢进内页。
   */
  const applyBusinessNav=(signal:BusinessNavSignal)=>{
    const step=businessNavStep(businessNavSeen.current,signal)
    businessNavSeen.current=step.seen
    if(step.home!==null)actions.rememberDirectory('spaces',{businessHome:step.home})
  }
  // 显式打开先于视图观察消费，外部对象卡与 Frame 内入口共用 store 请求。
  useEffect(()=>{applyBusinessNav({kind:'open-request',request:state.businessOpenRequest})},[state.businessOpenRequest])
  useEffect(()=>{applyBusinessNav({kind:'view',view:state.view})},[state.view])
  /** 顶栏面包屑第二级：回到当前页的列表根（用户 2026-09-20 裁定「顶部这些导航应可以点击」）。 */
  const openViewRoot=(view:WorkbenchView)=>{
    const root=viewRootAction(view)
    if(root.kind==='business-home')applyBusinessNav({kind:'back-home'})
    else if(root.kind==='attention')actions.openAttention()
    else if(root.kind==='plans')actions.openPlans()
    else if(root.kind==='market'){if(marketAppsPage)actions.openMarketCategory('apps');else actions.openMarket()}
    else if(root.kind==='resources')actions.openResources()
    else if(root.kind==='tasks'){actions.selectTask(null);actions.navigate('tasks')}
    else if(root.kind==='team'){actions.selectRole(null);actions.navigate('team')}
    else actions.navigate(root.view)
  }
  useEffect(()=>{applyBusinessNav({kind:'target',target:state.businessTarget})},[businessTargetSignature])
  /**
   * 恢复期改目标：只更新「已见取值」，不把这一位当成「用户打开了一个范围」。
   * 但恢复到的若是一个精确内页位置（非总览，或带着一条对象 id），那正是用户上次停在的地方，
   * 直接进内页——否则精确还原出来的 section/id 会被首页在视觉上丢掉（终审 L4）。
   */
  const settleBusinessTarget=(target:BusinessTarget,home=state.navigationDirectories.spaces?.businessHome)=>{applyBusinessNav({kind:'settle',target,...(home===undefined?{}:{home})})}
  /**
   * 从别处打开一个业务范围/对象：显式进内页，不靠「目标取值变了」这一路兜底——
   * 目标与当前深度相等时（冷启动默认 `{scope:'general',section:'overview'}` 就是常态）那条 effect 会短路，
   * 用户会落在业务台账首页而不是他点开的那一页（终审 H1）。
   */
  const enterBusiness=(target:BusinessTarget)=>actions.openBusiness(target)
  const openBusinessShortcut=(target:Pick<BusinessTarget,'scope'|'section'|'dashboardId'>)=>{setBusinessEntry(current=>nextBusinessEntry(current));enterBusiness(target)}
  const businessShortcutPinned=(target:Pick<BusinessTarget,'scope'|'section'|'dashboardId'>)=>businessShortcuts.some(shortcut=>businessShortcutKey(shortcut.target)===businessShortcutKey({scope:target.scope,section:target.section,...(target.section==='dashboards'&&target.dashboardId?{dashboardId:target.dashboardId}:{})}))
  /**
   * 左栏固定的看板显示看板标题：按固定项涉及的范围各读一次看板列表（只读摘要），读不到就留空、左栏回落显示看板标识。
   * 依赖只取「涉及哪些范围」这一串，不随固定项顺序或其它栏目变化重读。
   */
  const [businessDashboardTitles,setBusinessDashboardTitles]=useState<Readonly<Record<string,string>>>({})
  const pinnedDashboardScopes=[...new Set(businessShortcuts.filter(shortcut=>shortcut.target.dashboardId).map(shortcut=>shortcut.target.scope))].sort().join('\n')
  useEffect(()=>{
    if(!pinnedDashboardScopes)return
    const controller=new AbortController()
    void Promise.all(pinnedDashboardScopes.split('\n').map(scope=>businessDashboardApi.list({scope},controller.signal).then(rows=>rows.map(row=>[businessDashboardTitleKey(scope,row.id),row.localized?.title?resolveLocalizedMetadata(row.localized.title,locale).value:row.title] as const),()=>[]))).then(entries=>{if(!controller.signal.aborted)setBusinessDashboardTitles(Object.fromEntries(entries.flat()))})
    return ()=>controller.abort()
  },[businessDashboardApi,pinnedDashboardScopes,locale])
  /** 从业务首页进入范围内页只读取已接入的数据；示例数据不再是正式产品入口。 */
  const openBusinessScope=(scope:string)=>{
    const steps=openBusinessScopeSteps({scope,mode:'real',businessLoaded:tasks.business.loaded})
    setBusinessEntry(current=>nextBusinessEntry(current))
    enterBusiness(steps.target)
  }
  /** 「再加一类业务」要落在市场的「方案」页签上：市场页的 `kind` 只在挂载读一次持久化目录，靠 store 里这条受控请求现场改。 */
  const openMarketCategory=(category:MarketCategory|'home')=>actions.openMarketCategory(category)
  const [teamFocusScope,setTeamFocusScope]=useState<string|null>(null)
  useEffect(()=>{setTeamFocusScope(current=>teamFocusScopeAfterView(state.view,current))},[state.view])
  /** 业务页「查看同事 →」：切到同事页并把那一队的分区展开滚到眼前（第一期规格 §9.4 在此落地）。 */
  const openStaffOfScope=(scope:string)=>{const steps=openStaffOfScopeSteps(scope);actions.selectRole(steps.selectedRole);setTeamFocusScope(steps.focusScope);actions.navigate(steps.view)}
  /**
   * 业务卡摘要与「这个业务有什么」的每一段落到既有入口：共享的技能与接入去团队能力页（接入走「连接」那一档），
   * 依据资料去资料库，扩展回能力管理，业务自有的东西回这个业务或它的持续计划。不为此新开页面。
   */
  const openComposition=(target:CompositionTarget)=>{
   if(target.kind==='team')openStaffOfScope(target.scope)
   else if(target.kind==='capabilities')actions.openCapabilityCatalog()
   else if(target.kind==='knowledge')actions.openResources()
   else if(target.kind==='connectors'){actions.rememberDirectory('capabilities',{category:writeDirectoryFilterCategory({category:'source',mobileLayer:'list'})});actions.openCapabilityCatalog()}
   else if(target.kind==='extension'){
    const load=savedIndustryLoads.find(load=>load.status==='active'&&load.items.some(item=>item.instanceId===target.instanceId))
    const item=load?.items.find(item=>item.instanceId===target.instanceId)
    actions.rememberDirectory('capabilities',{category:writeDirectoryFilterCategory({category:'extension',mobileLayer:item?'detail':'list'}),selectedId:load&&item?'extension:'+load.templateId+'/'+item.localId:undefined})
    actions.openCapabilityCatalog()
   }
   else if(target.kind==='plans')actions.openPlans({kind:'plans',scope:target.scope})
   else if(target.kind==='market')openMarketCategory(target.category)
   else enterBusiness({scope:target.scope as CollaborationScope,section:'overview'})
  }
  useEffect(()=>{
    if(!restorePending.current.spaces)return
    // 恢复授权以当前本人目录为准；原生 Run 输入与市场方案目录都不能替代它。
    if(businessDirectoryStatus!=='ready')return
    const scopes=scopeLabels.map(label=>label.scope),scope=scopes.includes(state.businessTarget.scope)?state.businessTarget.scope:scopes[0]
    if(!scope){restorePending.current.spaces=false;applyBusinessNav({kind:'back-home'});return}
    if(scope!==state.businessTarget.scope){restorePending.current.spaces=false;const detail=reconcileAvailableDirectoryTarget({id:state.businessTarget.id},[],state.detail,'spaces').detail;const restoredTarget={scope,section:'overview'} as const;settleBusinessTarget(restoredTarget,true);actions.reconcileBusiness(restoredTarget,detail);return}
    if(state.navigationDirectories.spaces?.businessHome===true){restorePending.current.spaces=false;settleBusinessTarget(state.businessTarget,true);return}
    // 固定记录来源由正式配置与记录服务核验，不能从旧预览目录删掉版本或对象。
    if(state.businessTarget.recordReference){restorePending.current.spaces=false;settleBusinessTarget(state.businessTarget);return}
    // 项目由持久化服务自行恢复与报错，不再用空预览数组清除已选项目。
    if(state.businessTarget.section==='projects'){restorePending.current.spaces=false;settleBusinessTarget(state.businessTarget);return}
    // 看板与项目同款：看板页自己按 dashboardId 读取并处理「不存在」，不等沙盒业务数据加载。
    if(['dashboards','employees','groups'].includes(state.businessTarget.section)){restorePending.current.spaces=false;settleBusinessTarget(state.businessTarget);return}
    // 对象清单同款：带对象类型而没有对象标识（含看板下钻的 match 筛选、以及 idColumn 下钻带 `_id` 筛选的那一条），清单页自己按对象类型与筛选读台账，原样落定、不丢 match。
    if(state.businessTarget.section==='data'&&state.businessTarget.objectType&&(state.businessTarget.id===undefined||state.businessTarget.match)){restorePending.current.spaces=false;settleBusinessTarget(state.businessTarget);return}
    // 正式对象页与看板由各自服务核验；只有旧预览目标仍依赖扩展目录和预览数据。
    if(industryLoadDirectory!=='ready')return
    if(state.businessTarget.section!=='overview'&&!tasks.business.loaded)return
    const candidates=state.businessTarget.section==='data'?tasks.business.objects.filter(row=>row.scope===scope&&(!state.businessTarget.objectType||row.type===state.businessTarget.objectType)).map(row=>({id:row.id,objectType:row.type}))
      :state.businessTarget.section==='work'?tasks.business.flows.filter(row=>row.scope===scope).map(row=>({id:row.id}))
      :state.businessTarget.section==='analysis'?tasks.business.runs.filter(row=>row.scope===scope).map(row=>({id:row.id}))
      :state.businessTarget.section==='execution'?tasks.business.operations.filter(row=>row.scope===scope).map(row=>({id:row.id})):[]
    const restored=reconcileAvailableDirectoryTarget({id:state.businessTarget.id},candidates.map(row=>row.id),state.detail,'spaces'),candidate=candidates.find(row=>row.id===restored.id)
    restorePending.current.spaces=false
    const objectType=candidate&&'objectType' in candidate&&typeof candidate.objectType==='string'?candidate.objectType:undefined
    const restoredTarget={scope,section:state.businessTarget.section,...(candidate?{id:candidate.id}:{}),...(objectType?{objectType}:{})}
    settleBusinessTarget(restoredTarget)
    actions.reconcileBusiness(restoredTarget,restored.detail)
  },[businessDirectoryStatus,scopeLabels,industryLoadDirectory,tasks.business,state.businessTarget,state.detail,actions])
  useEffect(()=>{
    if(!restorePending.current.plans)return
    const kind=state.continuousTarget.kind
    if(kind==='plan'&&savedPlanDirectory!=='ready')return
    const ids=kind==='plan'?[...new Set([...savedPlans.filter(plan=>plan.state!=='archived').map(plan=>plan.id),...tasks.continuous.plans.filter(plan=>!plan.archived).map(plan=>plan.id)])]:kind==='run'?tasks.continuous.runs.map(run=>run.id):[]
    const restored=reconcileAvailableDirectoryTarget({id:state.continuousTarget.id},ids,state.detail,'plans')
    restorePending.current.plans=false
    const target=restored.id?{...state.continuousTarget,id:restored.id}:kind==='plan'?{kind:'plans' as const,...(state.continuousTarget.scope?{scope:state.continuousTarget.scope}:{})}:kind==='run'?{kind:'runs' as const,...(state.continuousTarget.scope?{scope:state.continuousTarget.scope}:{})}:state.continuousTarget
    actions.reconcileContinuous(target,restored.detail)
  },[savedPlanDirectory,savedPlans,tasks.continuous,state.continuousTarget,state.detail,actions])
  useEffect(()=>{
    const search=(event:KeyboardEvent)=>{
      if(event.defaultPrevented||event.repeat||!((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k')||event.altKey||event.shiftKey)return
      if(document.querySelector('dialog[open]')||event.target instanceof Element&&event.target.closest('input,textarea,select,[contenteditable="true"]'))return
      event.preventDefault();setWorkspaceSearchOpen(true)
    }
    window.addEventListener('keydown',search)
    return()=>window.removeEventListener('keydown',search)
  },[actions])
  function navigationError(error:unknown,token:BusinessNavigationToken,proceed:()=>void,switching:boolean,daily=false){
    const reason=error&&typeof error==='object'&&'details'in error?(error.details as {reason?:string}|undefined)?.reason:undefined
    if(reason==='draft')setBuilderSwitch({token,switching,proceed})
    else (daily?setDailyError:setBuilderError)(localizeWorkError(locale,error))
  }
  function continueBuilder(row:BusinessConversationBinding){
    setBuilderError(undefined)
    try{const token=businessBuilder!.captureNavigation(),location=homeCreationLocation(latestState.current)
      const run=async()=>{try{if(row.sessionId)await businessBuilder!.open(row.sessionId,false,token);else await businessBuilder!.recover(row.requestId,false,token);if(homeCreationLocation(latestState.current)===location){actions.closeDetail();actions.openMessages('native')}}catch(error){navigationError(error,token,()=>void run(),!!row.sessionId)}};void run()
    }catch(error){setBuilderError(localizeWorkError(locale,error))}
  }
  function recoverBuilder(requestId:string){
    setBuilderError(undefined)
    try{const token=businessBuilder!.captureNavigation(),location=homeCreationLocation(latestState.current)
      const run=async()=>{try{const bound=await businessBuilder!.recover(requestId,false,token);if(bound.sessionId===mainSession.getSnapshot()&&homeCreationLocation(latestState.current)===location){actions.closeDetail();actions.openMessages('native')}}catch(error){navigationError(error,token,()=>void run(),false)}};void run()
    }catch(error){setBuilderError(localizeWorkError(locale,error))}
  }
  function offerRecordPreparation(binding:BusinessConversationBinding|null){
    const selection=recordPreparationRef.current
    if(!selection||selection.api!==businessBuilder?.getSnapshot().api||binding?.kind!=='daily'||!binding.sessionId||binding.scope!==selection.reference.scope||binding.sessionId!==mainSession.getSnapshot())return
    setRecordPreparation({...selection,sessionId:binding.sessionId});setRecordInsertError(false)
  }
  async function bringRecord(){
    const selection=recordPreparationRef.current
    if(recordInsertBusy||!selection?.sessionId||!insertBusinessRecord)return
    setRecordInsertBusy(true);setRecordInsertError(false)
    const location=homeCreationLocation(latestState.current)
    try{await insertBusinessRecord(selection.reference,selection.sessionId,selection.api,()=>recordPreparationRef.current===selection&&homeCreationLocation(latestState.current)===location);if(recordPreparationRef.current===selection)setRecordPreparation(undefined)}
    catch{if(recordPreparationRef.current===selection)setRecordInsertError(true)}
    finally{setRecordInsertBusy(false)}
  }
  function recoverDaily(requestId?:string){
    setDailyError(undefined)
    try{const token=businessBuilder!.captureNavigation(),location=homeCreationLocation(latestState.current)
      const run=async()=>{setDailyBusy(true);try{const bound=await businessBuilder!.recoverDaily(requestId,token);if(bound.sessionId&&mayContinueHomeCreation(location,latestState.current,mainSession.getSnapshot(),bound.sessionId)){offerRecordPreparation(bound);actions.closeDetail();actions.openMessages('native')}}catch(error){navigationError(error,token,()=>void run(),false,true)}finally{setDailyBusy(false)}}
      dailyRetry.current=()=>recoverDaily(requestId);void run()
    }catch(error){setDailyError(localizeWorkError(locale,error))}
  }
  function requestDaily(scope:string,title:string,newConversation=false,record?:BusinessObjectReference){
    if(dailyBusy)return
    if(record&&businessBuilder?.getSnapshot().api){const prior=recordPreparationRef.current,api=businessBuilder.getSnapshot().api!;const selection={reference:record,title,api,...(prior?.api===api&&prior.sessionId&&JSON.stringify(prior.reference)===JSON.stringify(record)?{sessionId:prior.sessionId}:{})};recordPreparationRef.current=selection;setRecordPreparation(selection);setRecordInsertError(false)}
    setDailyError(undefined);setBuilderError(undefined)
    try{const token=businessBuilder!.captureNavigation(),location=homeCreationLocation(latestState.current),options={scope,title,newConversation,...(record?{record}:{})}
      const run=async()=>{setDailyBusy(true);try{
        const needsWorkspace=await businessBuilder!.prepareDaily(options,token)
        if(needsWorkspace){requestCreation({daily:options,scope,navigationToken:token});return}
        const daily=businessBuilder!.getSnapshot().daily?.getSnapshot(),bound=daily?.binding
        if(daily?.phase==='ready'&&bound?.sessionId&&mayContinueHomeCreation(location,latestState.current,mainSession.getSnapshot(),bound.sessionId)){offerRecordPreparation(bound);actions.closeDetail();actions.openMessages('native')}
      }catch(error){navigationError(error,token,()=>void run(),!newConversation,true)}finally{setDailyBusy(false)}}
      dailyRetry.current=()=>requestDaily(scope,title,newConversation,record);void run()
    }catch(error){setDailyError(localizeWorkError(locale,error))}
  }
  async function createWork(workspaceId?:string,intent:CreationIntent|null=creationIntent,automatic=false){
    if(!intent)return
    if(intent.object?.kind==='role'&&!applicationPresentation.can('people'))return
    setCreating(true)
    const creationLocation=homeCreationLocation(latestState.current)
    try {
      if(intent.builder||intent.daily){
        if(!businessBuilder)throw Error(t('business.builder.error'))
        const bound=intent.daily?await businessBuilder.openDaily({...intent.daily,...(workspaceId===undefined?{}:{workspaceId})},intent.navigationToken):await businessBuilder.start({... (workspaceId===undefined?{}:{workspaceId}),...(intent.scope?{scope:intent.scope}:{})},intent.navigationToken)
        setCreationIntent(null);setWorkspaceSelection(false);setCreationError(undefined)
        if(bound.sessionId!==undefined&&mayContinueHomeCreation(creationLocation,latestState.current,mainSession.getSnapshot(),bound.sessionId)&&bound.sessionId===mainSession.getSnapshot()){if(intent.daily)offerRecordPreparation(bound);actions.closeDetail();actions.openMessages('native');actions.closeSidebar();setBuilderTab('conversation')}
        return
      }
      if(intent.object){const object=resolveConversationObject(intent.object.kind,intent.object.id);if(!object.canStart||object.version!==intent.object.version)throw Error(t('frame.p5.sourceObjectChanged'))}
      const pending=homeContextApi.pending()
      const assistantRequest=intent.assistant?pendingAssistantCreation(navigationStorage):undefined
      const recoveringAssistantContext=intent.assistant&&pending?.scopeId==='general'&&pending.roleId===null&&work.getDirectorySnapshot().rows.some(row=>(row.purpose==='assistant'||!!assistantRequest&&row.requestId===assistantRequest.requestId)&&row.sessionId===pending.sessionId)
      if(intent.scope&&!intent.object&&pending&&!recoveringAssistantContext&&(!work.getPendingCreation()||pending.scopeId!==intent.scope))throw Error(homeNativeCopy(locale,'pendingContext'))
      if(intent.projectConversation)projectApi.runtime!.creationWorkspace(intent.projectConversation.projectId,workspaceId)
      const options={
        ...(intent.projectConversation?{requestId:intent.projectConversation.requestId,title:intent.projectConversation.title}:{}),
        ...(workspaceId===undefined?{}:{workspaceId}),...(intent.object?.kind==='role'?{roleId:intent.object.id}:{}),
        mayOpen:()=>!intent.signal?.aborted&&intent.continuation?.current()!==false&&intent.projectCurrent?.()!==false&&homeCreationLocation(latestState.current)===creationLocation,
        beforeOpen:async(row:Conversation)=>{
          if(intent.continuation?.current()===false)return
          if(intent.assistant){await rememberAssistantConversation(row,navigationStorage,homeContextApi);return}
          if(intent.object){
            const object=resolveConversationObject(intent.object.kind,intent.object.id)
            if(persistentObject(object))mergeObjectLinks([await ensureHomeObjectContext(objectConversationApi,object,row.sessionId,intent.scope)])
            return
          }
          if(intent.projectConversation){
            await prepareProjectConversation({api:projectApi,home:homeContextApi,creation:intent.projectConversation,sessionId:row.sessionId,scope:intent.scope!,mayContinue:()=>intent.projectCurrent?.()!==false&&!intent.signal?.aborted&&homeCreationLocation(latestState.current)===creationLocation})
            return
          }
          if(!intent.scope)return
          const existing=await homeContextApi.read(row.sessionId)
          if(existing){if(existing.scopeId!==intent.scope||existing.roleId!==null)throw Error(homeNativeCopy(locale,'differentContext'));return}
          await homeContextApi.set({sessionId:row.sessionId,scopeId:intent.scope,roleId:null,expectedVersion:0})
        },
      }
      const assistantResult=intent.assistant?await work.createAssistantResult(options):undefined
      const conversation=assistantResult?assistantResult.conversation:await work.create(options)
      if(assistantResult?.result==='opened')intent.continuation?.opened(conversation.sessionId)
      if(intent.projectConversation&&!intent.projectConversation.preparation)projectApi.runtime!.completeCreation(intent.projectConversation.projectId,intent.projectConversation.requestId)
      if(intent.scope&&intent.scope!=='general'&&workspaceId)workspacePreferences.write(intent.scope,workspaceId)
      const canContinue=()=>!intent.signal?.aborted&&intent.continuation?.current()!==false&&intent.projectCurrent?.()!==false&&mayContinueHomeCreation(creationLocation,latestState.current,mainSession.getSnapshot(),conversation.sessionId)
      if(!canContinue()){intent.resolve?.(!intent.pagePreparation&&!intent.projectConversation?.preparation);setCreationIntent(null);setWorkspaceSelection(false);setCreationError(undefined);return conversation}
      if(intent.object){
        const object=resolveConversationObject(intent.object.kind,intent.object.id)
        if(!persistentObject(object))setObjectLinks(linkObjectConversation(objectLinks,object,conversation,intent.scope))
        actions.closeDetail();setConversationObject({object,sessionId:conversation.sessionId,...(intent.scope?{scopeId:intent.scope}:{})})
        if(object.kind==='task'&&persistentObject(object))await prepareTaskConversation(object,conversation,canContinue)
      }
      if(intent.projectConversation?.preparation){
        const offered=await offerProjectConversationWork({api:projectApi,preparation,creation:intent.projectConversation,sessionId:conversation.sessionId,scope:intent.scope!,scopeNames:localizedScopeNames,mayContinue:canContinue})
        if(!offered){intent.resolve?.(false);setCreationIntent(null);setWorkspaceSelection(false);setCreationError(undefined);return conversation}
        projectApi.runtime!.completeCreation(intent.projectConversation.projectId,intent.projectConversation.requestId)
      }
      if(intent.goal){
        const {goal,scope}=intent
        preparation.prepare({id:crypto.randomUUID(),sourceId:'home:'+conversation.id,sourceKind:'home',sourceVersion:1,sessionId:conversation.sessionId,title:t('frame.p5.homeGoal'),resources:intent.resources||[],skills:intent.skills||[],text:homeConversationPrompt(goal,scope??'general',localizedScopeNames)})
      }
      intent.resolve?.(true);setCreationIntent(null);setWorkspaceSelection(false);setCreationError(undefined)
      // 只有本次确实打开的空白会话才接替记忆；创建期间离开时不覆盖原草稿会话身份。
      if(plainCreation(intent)&&canContinue()&&mainSession.getSnapshot()===conversation.sessionId)rememberBlankNewConversation(navigationStorage,{sessionId:conversation.sessionId,...(intent.scope?{scope:intent.scope}:{})})
      if(canContinue()&&work.getSnapshot().sessionId===conversation.sessionId){actions.openMessages('native');if(window.matchMedia('(max-width:740px)').matches)actions.closeSidebar()}
      return conversation
    }catch(error){
      if((intent.builder||intent.daily)&&intent.navigationToken){
        setWorkspaceSelection(false);navigationError(error,intent.navigationToken,()=>{void createWork(workspaceId,intent,true).catch(()=>{})},false,!!intent.daily)
      }
      if(automatic&&!intent.builder&&!intent.daily&&intent.projectCurrent?.()!==false){setCreationError(localizeWorkError(locale,error));setWorkspaceSelection(true)}
      // 页内输入继续等待原创建窗的重试或取消；首次失败不能使后续真实成功的回执失效。
      if(!intent.pagePreparation)intent.reject?.(error)
      throw error
    }finally{setCreating(false)}
  }
  function currentPersonalAssistantConversation():Conversation|undefined{
    const conversation=work.getSnapshot().conversation
    if(!conversation||conversation.status!=='ready'||conversation.purpose==='task-run'||conversation.sessionId!==navigationStorage.getItem(assistantConversationKey)||conversation.sessionId!==mainSession.getSnapshot()||management.getSnapshot().archived.includes(conversation.sessionId))return
    return conversation
  }
  async function openPersonalAssistant(cancelSignal?:AbortSignal){await openPersonalAssistantConversation(cancelSignal)}
  async function openPersonalAssistantConversation(cancelSignal?:AbortSignal,continuation?:ConversationContinuation):Promise<Conversation|undefined>{
    if(cancelSignal?.aborted||continuation?.current()===false)return
    if(assistantOpening.current||creating)return currentPersonalAssistantConversation()
    assistantOpening.current=true
    try{
      if(!management.getSnapshot().ready)throw Error(t('workspaceSearch.conversationsUnavailable'))
      // 显式入口取消原生尚未完成的启动恢复，仍保留后续用户导航的取消守卫。
      const navigationSignal=beginNativeNavigation?.()
      const signal=cancelSignal&&navigationSignal?AbortSignal.any([cancelSignal,navigationSignal]):cancelSignal??navigationSignal
      const location=homeCreationLocation(latestState.current),previous=mainSession.getSnapshot()
      const mayOpen=()=>!signal?.aborted&&continuation?.current()!==false&&homeCreationLocation(latestState.current)===location&&mainSession.getSnapshot()===previous
      await work.refreshDirectory(signal)
      if(!mayOpen())return
      const directory=work.getDirectorySnapshot()
      if(directory.status!=='ready')throw Error(t('workspaceSearch.conversationsUnavailable'))
      const conversation=await findAssistantConversation({storage:navigationStorage,conversations:directory.rows,archived:management.getSnapshot().archived,read:homeContextApi.read})
      if(!mayOpen())return
      if(!conversation){await requestCreation({assistant:true,scope:'general',...(continuation?{continuation}:{}),...(signal?{signal}:{})});return cancelSignal?.aborted||continuation?.current()===false?undefined:currentPersonalAssistantConversation()}
      const opened=await work.createAssistantResult({mayOpen,beforeOpen:async row=>{if(continuation?.current()===false)return;await rememberAssistantConversation(row,navigationStorage,homeContextApi);}})
      if(opened.result!=='opened')return
      const original=opened.conversation
      continuation?.opened(original.sessionId)
      if(original.sessionId!==work.getSnapshot().sessionId||original.sessionId!==mainSession.getSnapshot())return
      const stillAtEntry=homeCreationLocation(latestState.current)===location||latestState.current.view==='messages'&&latestState.current.messageMode==='native'
      // DSH 打开成功后会 selectPanel(null)，使自己的导航信号失效；提交后的身份与调用方取消需分别核对。
      if(!cancelSignal?.aborted&&continuation?.current()!==false&&stillAtEntry&&work.getSnapshot().sessionId===original.sessionId&&mainSession.getSnapshot()===original.sessionId){actions.closeDetail();actions.openMessages('native')}
      if(!cancelSignal?.aborted&&continuation?.current()!==false&&stillAtEntry&&work.getSnapshot().sessionId===original.sessionId&&mainSession.getSnapshot()===original.sessionId)return original
    }finally{assistantOpening.current=false}
  }
  async function prepareAssistantVoice(signal?:AbortSignal):Promise<AssistantVoiceDestination>{
    signal?.throwIfAborted()
    // 原会话已在打开前核对目录与上下文；打开后的后台刷新不撤销本次身份回执。
    const original=await openPersonalAssistantConversation(signal)
    signal?.throwIfAborted()
    const sessionId=original?.sessionId
    if(!sessionId||mainSession.getSnapshot()!==sessionId||work.getSnapshot().sessionId!==sessionId)throw Error(employeeVoiceCopy(locale,'failed'))
    const context=await homeContextApi.read(sessionId)
    signal?.throwIfAborted()
    if(!context||context.scopeId!=='general'||context.roleId!==null||context.version<1||mainSession.getSnapshot()!==sessionId)throw Error(employeeVoiceCopy(locale,'failed'))
    return {sessionId,contextVersion:context.version,isCurrent:()=>mainSession.getSnapshot()===sessionId&&work.getSnapshot().sessionId===sessionId,subscribe:mainSession.subscribe}
  }
  async function prepareAssistantVoiceNote(signal:AbortSignal):Promise<AssistantVoiceDestination>{
    const busy=()=>voiceOpening.current||!!currentVoice.current.target&&!currentVoice.current.ended
    if(busy())throw new AssistantVoiceBusyError()
    const destination=await prepareAssistantVoice(signal)
    if(busy())throw new AssistantVoiceBusyError()
    return {...destination,isCurrent:()=>destination.isCurrent()&&!busy(),subscribe:listener=>{
      const off=destination.subscribe(listener);voiceListeners.current.add(listener)
      return ()=>{off();voiceListeners.current.delete(listener)}
    }}
  }
  async function startAssistantCall(){
    if(!employeeVoiceApi||voiceTarget||voiceOpening.current)throw Error(employeeVoiceCopy(locale,'call'))
    voiceOpening.current=true
    try{const target=await prepareAssistantVoice();if(!target.isCurrent())return;setVoiceSelectionReady(false);setVoiceSessionId(target.sessionId);selectVoiceTarget({kind:'assistant',name:assistantName,contextVersion:target.contextVersion})}
    finally{voiceOpening.current=false}
  }
  // 左栏新建的空白会话按身份重开；正文、引用和附件仍由官方输入按会话保存，这里不复制。
  const plainCreation=(intent:CreationIntent)=>Object.keys(intent).every(key=>key==='scope')
  const rememberedBlank=(scope:string|undefined)=>blankNewConversation({entry:readBlankNewConversation(navigationStorage),rows:work.getDirectorySnapshot().rows,archived:management.getSnapshot().archived,blank:id=>(searchNative as Readonly<Record<string,{blank:boolean}|undefined>>)[id]?.blank,scope})
  async function reopenBlankConversation(sessionId:string){
    const location=homeCreationLocation(latestState.current),previous=mainSession.getSnapshot()
    if(previous!==sessionId){
      const signal=beginNativeNavigation?.()
      const result=await work.openSessionResult(sessionId,signal,()=>!signal?.aborted&&homeCreationLocation(latestState.current)===location&&mainSession.getSnapshot()===previous)
      if(result!=='opened')return
    }
    const stillAtEntry=homeCreationLocation(latestState.current)===location||latestState.current.view==='messages'&&latestState.current.messageMode==='native'
    if(stillAtEntry&&work.getSnapshot().sessionId===sessionId&&mainSession.getSnapshot()===sessionId){actions.closeDetail();actions.openMessages('native')}
  }
  /**
   * 「更换执行位置」：同一位置只收起轻窗，不另建会话；空白新建会话换到其他位置时按 DSH 原生顺序带走纯文本草稿，
   * 引用、附件或提交中的输入保留在原会话并说明。已有历史的会话不迁移草稿，原位置与消息不变。从不提交。
   */
  async function changeCreationLocation(workspaceId:string|undefined){
    const intent=creationIntent,source=intent&&plainCreation(intent)?rememberedBlank(intent.scope):undefined
    if(!intent||!source||source.sessionId!==mainSession.getSnapshot()){await createWork(workspaceId,intent);return}
    if(conversationAtLocation(source,workspaceId,management.getSnapshot().workspaces)){setCreationIntent(null);setWorkspaceSelection(false);setCreationError(undefined);await reopenBlankConversation(source.sessionId);return}
    const from=conversationDraftInput(source.sessionId),carry=from&&draftCarry(from.state.getSnapshot())
    if(!from||carry==='structured'||carry==='busy')throw Object.assign(Error('Draft was not carried to the selected location.'),{code:'teloa/draft-not-carried'})
    const created=await createWork(workspaceId,intent)
    if(carry!=='text'||!created||mainSession.getSnapshot()!==created.sessionId)return
    try{const to=conversationDraftInput(created.sessionId);if(!to)throw Error('The new conversation input is not ready.');moveTextDraft(from,to)}
    catch{
      rememberBlankNewConversation(navigationStorage,{sessionId:source.sessionId,...(intent.scope?{scope:intent.scope}:{})})
      await reopenBlankConversation(source.sessionId);from.notify('error',t('conversationDialog.draftKept'))
    }
  }
  function requestCreation(intent:CreationIntent,chooseWorkspace=false){
    if(creating){intent.reject?.(Object.assign(Error('Conversation creation is still in progress.'),{code:'teloa/conflict'}));return}
    // 显式新建先撤销原生旧启动恢复；助手已持有导航信号，不能在这里将它取消。
    // 成功打开也会撤销原生信号，后续继续按当前会话与页面守卫核对，不借该信号判断失败。
    if(!intent.signal)beginNativeNavigation?.()
    if((intent.builder||intent.daily)&&!intent.navigationToken){try{intent={...intent,navigationToken:businessBuilder!.captureNavigation()}}catch(error){setBuilderError(localizeWorkError(locale,error));intent.reject?.(error);return}}
    setCreationMode(chooseWorkspace?'chooseWorkspace':'create')
    const pending=work.getPendingCreation()
    const nativeWorkspaces=management.getSnapshot()
    const preferred=intent.scope&&intent.scope!=='general'?workspacePreferences.read(intent.scope):undefined
    const assistantPending=intent.assistant?pendingAssistantCreation(navigationStorage):undefined
    if(intent.projectConversation?.workspaceResolved){
      setCreationIntent(intent);setCreationError(undefined);setWorkspaceSelection(false)
      return createWork(intent.projectConversation.workspaceId,intent,true).then(()=>{},()=>{})
    }
    const decision=resolveConversationWorkspace({workspaces:nativeWorkspaces.workspaces,registryReady:nativeWorkspaces.ready,scope:intent.scope,preferredWorkspaceId:preferred,recovering:!!pending||!!assistantPending||!!intent.projectConversation?.workspaceId,pendingWorkspaceId:pending?.workspaceId??assistantPending?.workspaceId??intent.projectConversation?.workspaceId,chooseOther:chooseWorkspace})
    if(decision.kind==='select'&&decision.staleWorkspaceId&&intent.scope)workspacePreferences.remove(intent.scope)
    // 再次新建时回到尚未开始的同一空白会话；缺省位置交给 DSH 时不按位置另建。
    const blank=!pending&&plainCreation(intent)?rememberedBlank(intent.scope):undefined
    if(blank&&decision.kind==='create'&&(decision.workspaceId===undefined||conversationAtLocation(blank,decision.workspaceId,nativeWorkspaces.workspaces))){
      setCreationIntent(null);setWorkspaceSelection(false);setCreationError(undefined)
      return reopenBlankConversation(blank.sessionId).catch(()=>{rememberBlankNewConversation(navigationStorage,undefined);requestCreation(intent)})
    }
    setCreationIntent(intent);setCreationError(undefined)
    if(decision.kind==='select'){setWorkspaceSelection(true);return}
    setWorkspaceSelection(false)
    return createWork(decision.workspaceId,intent,true).then(()=>{},()=>{})
  }
  const draftRevisionConnection=useRef({pageCreateApi,work,preparation});draftRevisionConnection.current={pageCreateApi,work,preparation}
  const prepareDraftRevision=async(draft:import('@teloa/contract').PageCreateDraft,signal:AbortSignal)=>{
    const connection=draftRevisionConnection.current,navigationSignal=beginNativeNavigation?.()
    const navigation=pageCreateDraftRevisionNavigation({cancelSignal:signal,...(navigationSignal?{navigationSignal}:{}),current:()=>projectFrameMounted.current&&draftRevisionConnection.current.pageCreateApi===connection.pageCreateApi&&draftRevisionConnection.current.work===connection.work&&draftRevisionConnection.current.preparation===connection.preparation,location:()=>homeCreationLocation(latestState.current),isNativeConversation:()=>latestState.current.view==='messages'&&latestState.current.messageMode==='native',mainSession:mainSession.getSnapshot,boundSession:()=>work.getSnapshot().sessionId})
    if(!navigation.mayOpen()||!pageCreateApi.origin)throw Object.assign(Error(),{code:'teloa/source-unavailable'})
    const origin=await pageCreateApi.origin({draftId:draft.id,expectedBodyHash:draft.bodyHash},navigation.signal)
    if(!navigation.mayOpen())throw Object.assign(Error(),{name:'AbortError'})
    const fresh=await pageCreateApi.read({draftId:draft.id},navigation.signal)
    if(!navigation.mayOpen()||fresh.bodyHash!==draft.bodyHash||fresh.status!=='draft')throw Object.assign(Error(),{code:'teloa/version-conflict'})
    const opened=await work.openSessionResult(origin.sessionId,navigation.signal,navigation.mayOpen)
    if(opened!=='opened'||!navigation.isOpened(origin.sessionId))throw Object.assign(Error(),{code:'teloa/source-unavailable'})
    const sourceId='page-create-revision:'+draft.id
    preparation.invalidate(sourceId)
    preparation.prepare({id:crypto.randomUUID(),sourceId,sourceKind:'home',sourceVersion:1,sessionId:origin.sessionId,title:draft.title,text:pageCreateDraftRevisionText(fresh,t)})
    setAttentionSourceSelection(previous=>previous?.source.kind==='page-create-draft'&&previous.source.draftId===draft.id?undefined:previous)
    actions.closeDetail();actions.openMessages('native')
  }
  /** 页内输入仅在创建回执明确成功后清空；工作区选择与关闭沿用原创建流程。 */
  function preparePageCreation(prompt:{text:string},scope?:CollaborationScope):Promise<void>{
    return new Promise((resolve,reject)=>{
      try{requestCreation({pagePreparation:true,goal:prompt.text,...(scope?{scope}:{}),resolve:accepted=>accepted?resolve():reject(Object.assign(Error('Conversation creation was cancelled.'),{code:'teloa/cancelled'})),reject})}
      catch(error){reject(error)}
    })
  }
  const requestRoleCreation=(object:ConversationObject,scopes:readonly CollaborationScope[],goal?:string)=>{
    if(!applicationPresentation.can('people'))return
    const available=[...new Set(scopes.filter(Boolean))]
    if(available.length>1){setRoleScopeIntent({object,scopes:available,...(goal?{goal}:{})});return}
    return requestCreation({object,...(available[0]?{scope:available[0]}:{}),...(goal?{goal}:{})})
  }
  /**
   * 账号区的“我的分身”是会话快捷入口，不是分身资料页入口。
   * 每次点击都读取真实关联，按原生会话的最近活动时间打开；没有历史时复用既有的新建与工作区选择链路。
   */
  const roleConversationOpening=useRef(new Set<string>())
  const openRoleConversation=async(roleId:string)=>{
    if(roleConversationOpening.current.has(roleId))return true
    roleConversationOpening.current.add(roleId)
    try{
    let role=tasksRef.current.roles.find(item=>item.id===roleId&&item.storage==='persistent')
    if(!role){const rows=await roleApi.list();mergeRoles(rows);role=tasksRef.current.roles.find(item=>item.id===roleId&&item.storage==='persistent')}
    if(!role)throw Error(t('frame.p5.roleGone'))
    const object:ConversationObject={kind:'role',id:role.id,title:role.kind==='twin'?twinDisplayName(profile.displayName,t):role.name,version:role.version,canStart:roleCanStartConversation(role.state)}
    const links=await objectConversationApi.list('role',role.id)
    mergeObjectLinks(links)
    await work.refreshDirectory()
    const recent=latestRoleConversation(presentConversations(work.getDirectorySnapshot().rows,Object.values(searchNative)),links,management.getSnapshot().archived)
    if(!recent){
      if(!object.canStart)return false
      await requestRoleCreation(object,role.scopes)
      return true
    }
    closeRailObjectTab();actions.closeDetail()
    await work.openConversation(recent.conversation)
    if(work.getSnapshot().sessionId!==recent.conversation.sessionId)throw Error(t('frame.p5.conversationChangedOpen'))
    const recentLink=links.find(link=>link.active&&link.sessionId===recent.conversation.sessionId)
    const scopeId=recentLink?.scopeId as CollaborationScope|undefined
    setConversationObject({object,sessionId:recent.conversation.sessionId,...(scopeId?{scopeId}:{})})
    actions.openMessages('native');closeNarrowDirectory()
    return true
    }finally{roleConversationOpening.current.delete(roleId)}
  }
  const openTwinConversation=async()=>{
    let twin=tasksRef.current.roles.find(role=>role.kind==='twin'&&role.storage==='persistent')
    if(!twin){const rows=await roleApi.list();mergeRoles(rows);twin=tasksRef.current.roles.find(role=>role.kind==='twin'&&role.storage==='persistent')}
    if(!twin)throw Error(t('frame.p5.roleGone'))
    return openRoleConversation(twin.id)
  }
  useEffect(()=>{const product=t('app.name'),label=state.view==='messages'&&state.messageMode==='groups'?selectedGroupName||t('navigation.v2.conversations'):assistantCurrent?assistantName:pageSessionTitle;document.title=label?label+' · '+product:product},[pageSessionTitle,t,assistantCurrent,assistantName,state.view,state.messageMode,selectedGroupName])
  // 会话「知识与能力」选择器在原生输入插槽里，拿不到外壳注入；这里登记带入通道，所选技能与资料走既有 preparation.prepare。
  const capabilitySkillSelections=useRef<Record<string,HomeSkillSelection[]>>({})
  useEffect(()=>registerCapabilitySelection(selection=>{capabilitySkillSelections.current[selection.sessionId]=selection.skills;insertConversationCapabilities(selection)}),[insertConversationCapabilities])
  useEffect(()=>{
    const follow=shouldFollowCurrentSession(previous.current,current,state.view)&&(state.view!=='messages'||state.messageMode==='native')
    if(previous.current===current)return
    if(previous.current!==undefined&&state.rolePreview)actions.closeRolePreview(state.rolePreview.request)
    previous.current=current
    actions.retainDetailForSession(current);actions.closeCapabilities()
    if(follow&&!(detailTarget?.kind==='artifact'&&!detailTarget.sessionId&&detailTarget.source.kind!=='session')){actions.navigate('messages');if(window.matchMedia('(max-width:740px)').matches)actions.closeSidebar()}
  },[current,state.view,actions])
  const conversationContextGeneration=useRef(0)
  useEffect(()=>{
    const generation=++conversationContextGeneration.current
    if(!current){setConversationObject(null);return}
    void (async()=>{
      const links=await objectConversationApi.bySession(current)
      if(generation!==conversationContextGeneration.current)return
      mergeObjectLinks(links)
      const link=links.find(row=>row.kind==='role')
      if(!link){setConversationObject(value=>value?.sessionId===current?value:null);return}
      let role=tasksRef.current.roles.find(row=>row.id===link.objectId&&row.storage==='persistent')
      if(!role){const rows=await roleApi.list();if(generation!==conversationContextGeneration.current)return;mergeRoles(rows);role=tasksRef.current.roles.find(row=>row.id===link.objectId&&row.storage==='persistent')}
      if(!role){setConversationObject(value=>value?.sessionId===current?value:null);return}
      const object:ConversationObject={kind:'role',id:role.id,title:role.kind==='twin'?twinDisplayName(profile.displayName,t):role.name,version:role.version,canStart:roleCanStartConversation(role.state)}
      const restoredScope=link.scopeId&&roleSupportsScope(role.scopes,link.scopeId)?link.scopeId as CollaborationScope:role.scopes.length===1?role.scopes[0]:undefined
      setConversationObject({object,sessionId:current,...(restoredScope?{scopeId:restoredScope}:{})})
    })().catch(()=>{if(generation===conversationContextGeneration.current)setConversationObject(value=>value?.sessionId===current?value:null)})
    return()=>{if(generation===conversationContextGeneration.current)conversationContextGeneration.current++}
  },[current,objectConversationApi,roleApi])
  const contextLinked=!!conversationObject&&conversationObject.sessionId===current&&activeObjectLinks.some(link=>link.kind===conversationObject.object.kind&&link.objectId===conversationObject.object.id&&link.sessionId===current)
  const contextTask=contextLinked&&conversationObject?.object.kind==='task'?tasks.tasks.find(task=>task.id===conversationObject.object.id):undefined
  const contextRole=contextLinked&&conversationObject?.object.kind==='role'?tasks.roles.find(role=>role.id===conversationObject.object.id):undefined
  // 原生会话头部那一行岗位身份说明（M8）：只有工作台外壳知道当前会话绑的是哪个岗位，
  // 头部槽位在另一棵 React 树里，靠 RoleConversationIdentity 的模块级小表搭桥。
  useEffect(()=>{
    if(!current||!contextLinked||conversationObject?.object.kind!=='role')return
    const sessionId=current
    roleConversationIdentities.write(sessionId,contextRole?.name??conversationObject.object.title,!builderVisible&&conversationVisible&&!!contextRole)
    return()=>roleConversationIdentities.write(sessionId,undefined)
  },[current,contextLinked,conversationObject,contextRole?.name,builderVisible,conversationVisible])
  const objectTarget=detailTarget?.kind==='conversation-object'?detailTarget:null
  const detailObjectLinked=!!objectTarget&&objectTarget.objectKind!=='business'&&activeObjectLinks.some(link=>link.kind===objectTarget.objectKind&&link.objectId===objectTarget.id&&link.sessionId===current)
  const detailTask=detailObjectLinked&&objectTarget?.objectKind==='task'?tasks.tasks.find(task=>task.id===objectTarget.id):undefined
  const detailRole=detailObjectLinked&&objectTarget?.objectKind==='role'?tasks.roles.find(role=>role.id===objectTarget.id):undefined
  const businessPanel=objectTarget?.objectKind==='business'?objectTarget.target:null
  // 会话页里“开着某个对象详情”与“这份详情画在页内第三栏”是两件事：
  // 三类对象详情都已迁入原生右栏，右栏接得住时页内第三栏不再重复渲染同一份内容，
  // 但“当前上下文里开着对象详情”仍然成立，入口与返回按钮要按它判断。
  const returnOrigin=businessSetupReturnOrigin(setupOrigin,{identity:builderState,view:state.view})
  useEffect(()=>{
    if(!setupOrigin)return
    const identityChanged=builderState.status!=='ready'||builderState.namespace!==setupOrigin.namespace||builderState.api!==setupOrigin.api
    const otherBusiness=state.view==='spaces'&&state.businessTarget.scope!==setupOrigin.target.scope||state.view==='messages'&&businessPanel!==null&&businessPanel.scope!==setupOrigin.target.scope
    if(identityChanged||otherBusiness){setSetupOrigin(null);setCatalogEntryRequest(undefined)}
  },[builderState.status,builderState.namespace,builderState.api,state.view,state.businessTarget.scope,businessPanel?.scope,setupOrigin])
  function openBusinessSetup(scope:string,title:string,target:BusinessSetupAction){
    const identity=businessBuilder?.getSnapshot()??builderState
    const origin=businessSetupOrigin({scope,title,identity,mainTarget:latestState.current.businessTarget,embeddedTarget:latestState.current.view==='spaces'?null:businessPanel})
    if(!origin)return
    setSetupOrigin(origin)
    openBusinessSetupDestination(scope,target,{colleagues:openStaffOfScope,role:actions.previewRole,resources:actions.openResources,category:actions.openMarketCategory,catalogEntry:catalogId=>setCatalogEntryRequest({catalogId,serial:++catalogEntrySerial.current})})
  }
  const returnToSetupBusiness=()=>returnToBusinessSetup(returnOrigin,businessBuilder?.getSnapshot()??builderState,{refresh:()=>setBusinessEntry(current=>nextBusinessEntry(current)),enter:enterBusiness})
  const businessDetailOpen=!builderVisible&&conversationVisible&&!!businessPanel&&contextLinked
  const taskDetailOpen=!builderVisible&&conversationVisible&&!!detailTask,roleDetailOpen=!builderVisible&&conversationVisible&&!!detailRole
  const objectDetailOpen=businessDetailOpen||taskDetailOpen||roleDetailOpen
  const businessEmbedded=businessDetailOpen&&!railServes('teloa.business')
  // 业务台账首页只在主视图这一层出现：右栏页签与页内第三栏的嵌入态永远直接是范围内页。
  const businessLedgerHome=businessLedgerHomeShown({view:state.view,home:businessHome||businessDirectoryStatus!=='ready'||!scopeLabels.some(label=>label.scope===state.businessTarget.scope),embedded:businessEmbedded})
  const taskEmbedded=taskDetailOpen&&!railServes('teloa.task'),roleEmbedded=roleDetailOpen&&!railServes('teloa.role')
  const objectEmbedded=businessEmbedded||taskEmbedded||roleEmbedded
  // 右栏该不该占位，只有 DSH 自己知道：它同时承载官方页类型与 Teloa 的对象页签，
  // 由 syncPresentation 报到 layout.openRightbar/closeRightbar，落在 store 的 rightbar 切片上。
  const nativeRailShown=!builderVisible&&conversationVisible&&state.rightbar.shown
  const groupArtifactShown=!!groupArtifactSeat&&state.view==='messages'&&state.messageMode==='groups'&&groupArtifactSeat?.groupId===state.groupTarget?.groupId
  const artifactRailShown=!builderVisible&&(artifactOpen||!!groupArtifactShown)
  const conversationArtifactMount=nativeRailShown&&current?artifactMounts.get(current):undefined
  const artifactFallbackShown=artifactRailShown&&!conversationArtifactMount
  const railShown=nativeRailShown||artifactRailShown
  const previousArtifactRail=useRef(state.rightbar.shown)
  useLayoutEffect(()=>{
    const wasShown=previousArtifactRail.current;previousArtifactRail.current=state.rightbar.shown
    // 本人或原生空间保护明确收起时，不以备用座位重新展开同一成果。
    if(wasShown&&!state.rightbar.shown&&conversationVisible&&artifactOpen)actions.closeDetail()
  },[state.rightbar.shown,conversationVisible,artifactOpen,actions])
  // 会话目录让位只在渲染期派生，不改写本人的 directoryOpen：概览或群侧栏收起、窗口放宽后原目录回来。
  // 右栏宽度与 canShow 仍在渲染期按 detailsDirectoryOpen 计算，RightbarSeat 子 layout effect 先提交也不会关栏。
  const groupPanelShown=state.view==='messages'&&state.messageMode==='groups'&&!!state.groupTarget&&groupPanelOpenId===state.groupTarget.groupId
  const directoryOccupants={rightbar:railShown,groupPanel:groupPanelShown}
  const directoryVisible=directoryShown(viewportWidth,state.directoryOpen,directoryOccupants)
  // 本人主动要看目录：先收起占位面板（页签、草稿、筛选与群偏好保留），目录不能打开后静默回弹。
  const openDirectoryColumn=()=>{
    if(directoryNeedsRoom(viewportWidth,directoryOccupants)){
      if(artifactRailShown)closeArtifacts()
      if(railShown)try{collapseRightbarForDirectory(sidebarRightFace(),current)}catch{/* 原生座位切换中不可用时保留原状。 */}
      if((groupPanelShown||groupArtifactShown)&&state.groupTarget){const groupId=state.groupTarget.groupId;setGroupPanelCollapse(current=>({groupId,seq:(current?.seq??0)+1}))}
    }
    if(!state.directoryOpen)actions.toggleSidebar()
  }
  const toggleDirectoryColumn=()=>{if(directoryVisible)actions.closeSidebar();else openDirectoryColumn()}
  const nativeDirectoryToggle=useRef(toggleDirectoryColumn);nativeDirectoryToggle.current=toggleDirectoryColumn
  useEffect(()=>leaseSidebarToggle?.(()=>nativeDirectoryToggle.current()),[leaseSidebarToggle])
  const guardOverviewRoom=(sessionId:string)=>{
    if(!conversationVisible||sessionId!==current)return
    try{collapseOverviewWithoutRoom(sidebarRightFace(),sessionId,viewportWidth,detailsCanShow)}catch{/* 原生座位切换中不可用时，下一次提交重新核对。 */}
  }
  // 原生窄窗全屏不会执行 canShow；窗口变化和实际展开报告都须在绘制前收起概况。
  useLayoutEffect(()=>{if(current)guardOverviewRoom(current)})
  // 原生收起右栏会保留页签与 detailTarget；会话头按实际可见性判断下一次是打开还是关闭。
  const contextDetailShown=objectEmbedded||objectDetailOpen&&railShown
  useLayoutEffect(()=>{
    const root=frameRef.current
    if(!root)return
    return leaseNativeSidebarAccessibility(root,{closeLabel:t('market.common.close'),exitFullscreen:panel=>{panel.querySelector<HTMLButtonElement>('[data-sidebar-right-mode="push"]')?.click()},collapsePanel:()=>{const face=sidebarRightFace(),id=mainSession.getSnapshot();if(id&&face?.mounted.getSnapshot()===id&&face.isExpanded()===true)face.toggleExpanded()}})
  },[locale])
  useLayoutEffect(()=>leaseNativeFloatVisibility(typeof document==='undefined'?undefined:document.body,railShown),[railShown])
  const openContextObject=()=>{if(current&&conversationObject&&contextLinked)openDetailTab({kind:'conversation-object',sessionId:current,objectKind:conversationObject.object.kind,id:conversationObject.object.id,...(conversationObject.object.version!==undefined?{version:conversationObject.object.version}:{})})}
  const toggleContextObject=(event:{currentTarget:HTMLButtonElement})=>{
    objectPanelTrigger.current=event.currentTarget
    if(contextDetailShown&&!businessDetailOpen)closeObjectPanel()
    else openContextObject()
  }
  /**
   * 会话页里的业务对象一律进第三栏（原生右栏页签，右栏接不住时退回页内第三栏），不把用户带离对话。
   *
   * 判据不能是 `objectDetailOpen`：那要求此刻**已经**开着任务或岗位详情，于是业务对象永远当不成
   * 会话页上第一个被打开的详情——会话关联区那条入口一点就跳去空间页，页签正文里的「返回目录」
   * 也会连人带页一起离开会话，看着就像页签被关掉了。真正的判据只有「此刻在会话页、且有会话」。
   */
  const openContextBusiness=(target:BusinessTarget)=>{if(conversationVisible&&current)openDetailTab({kind:'conversation-object',sessionId:current,objectKind:'business',target});else enterBusiness(target)}
  const contextPanelTitle=contextTask?t('frame.context.taskDetails'):t('frame.context.roleDetails')
  /** 只有唯一业务范围才给会话显示直达入口；多范围不擅自替用户挑第一个。 */
  const contextScope=conversationObject?.scopeId??contextTask?.scope??(contextRole?.scopes.length===1?contextRole.scopes[0]:undefined)
  const createContextConversation=()=>{
    if(conversationProject&&conversationProject.sessionId===current){void projectConversationActions.create(conversationProject.project,conversationProject.memoryMode,projectRuntimeCopy(locale).newConversation).catch(error=>setServerRecoveryNotice(localizeWorkError(locale,error)));return}
    if(!conversationObject||!contextLinked)return requestCreation({})
    if(conversationObject.object.kind==='role'&&!applicationPresentation.can('people'))return
    const object=resolveConversationObject(conversationObject.object.kind,conversationObject.object.id)
    const roleScopes=object.kind==='role'?contextRole?.scopes:undefined
    if(roleScopes){if(contextScope&&roleScopes.includes(contextScope as CollaborationScope))return requestCreation({object,scope:contextScope as CollaborationScope});return requestRoleCreation(object,roleScopes)}
    requestCreation({object,...(contextScope?{scope:contextScope}:{})})
  }
  const panelTitle=businessEmbedded?t('frame.context.businessDetails'):taskEmbedded?t('frame.context.taskDetails'):t('frame.context.roleDetails')
  const panelHeader=<header className={css.objectPanelHeader}><strong>{panelTitle}</strong>{businessEmbedded&&<button type="button" className={light.back} onClick={openContextObject}><ArrowLeft size={14} aria-hidden/>{t('frame.context.back',{target:contextPanelTitle})}</button>}<button type="button" onClick={closeObjectPanel} aria-label={t('frame.context.close',{target:panelTitle})}><X size={17}/></button></header>
  const industryResources=(filter:{loadId?:string;scope?:string;roleId?:string;templateId?:string;target?:{loadId:string;itemInstanceId:string}}={})=><SavedIndustryDirectory executionAccess={roleExecutionAccess} createTeam={createIndustryTeam} loads={savedIndustryLoads} {...filter} error={industryLoadError} refresh={loadIndustryLoads} openMarket={actions.openMarket} nativeSettings={openNativePlugins} knowledge={{items:industryKnowledge,error:industryKnowledgeError,refresh:loadIndustryKnowledge,pending:industryKnowledgeApi.pending(),recoveryError:industryKnowledgeApi.recoveryMessage(),instantiate:instantiateIndustryKnowledge,recover:recoverIndustryKnowledge}} dataSources={{items:industryDataSources,error:industryDataSourceError,partial:industryDataSourcePartial,refresh:loadIndustryDataSources,pending:industryDataSourceApi.pending(),recoveryError:industryDataSourceApi.recoveryMessage(),instantiate:instantiateIndustryDataSource,authorize:authorizeIndustryDataSource,recover:recoverIndustryDataSource}} executionTools={{items:industryExecutionTools,error:industryExecutionToolError,partial:industryExecutionToolPartial,refresh:loadIndustryExecutionTools,pending:industryExecutionToolApi.pending(),recoveryError:industryExecutionToolApi.recoveryMessage(),instantiate:instantiateIndustryExecutionTool,authorize:authorizeIndustryExecutionTool,recover:recoverIndustryExecutionTool}} mcpConnections={{items:industryMcpConnections,error:industryMcpConnectionError,partial:industryMcpConnectionPartial,refresh:loadIndustryMcpConnections,pending:industryMcpConnectionApi.pending(),recoveryError:industryMcpConnectionApi.recoveryMessage(),instantiate:instantiateIndustryMcpConnection,connect:connectIndustryMcpConnection,recover:recoverIndustryMcpConnection}} plugins={{items:industryPlugins,error:industryPluginError,partial:industryPluginPartial,refresh:loadIndustryPlugins,pending:industryPluginApi.pending(),recoveryError:industryPluginApi.recoveryMessage(),instantiate:instantiateIndustryPlugin,preview:previewIndustryPlugin,install:installIndustryPlugin,enable:enableIndustryPlugin,reconcile:reconcileIndustryPlugin,recover:recoverIndustryPlugin}} roles={{items:industryRoles,error:industryRoleError,refresh:loadIndustryRoles,pending:industryRoleApi.pending(),recoveryError:industryRoleApi.recoveryMessage(),instantiate:instantiateIndustryRole,recover:recoverIndustryRole,open:openIndustryRole}} tasks={{api:industryTaskApi,pending:!!industryTaskApi.pending(),recoveryError:industryTaskApi.recoveryMessage(),create:createIndustrySavedTask,recover:recoverIndustrySavedTask}} plans={{api:industryPlanApi,pending:!!industryPlanApi.pending(),recoveryError:industryPlanApi.recoveryMessage(),create:createIndustrySavedPlan,recover:recoverIndustrySavedPlan,openRole:openIndustryRole}} unload={{pending:!!industryLoadApi.unloadPending(),recoveryError:industryLoadApi.unloadRecoveryMessage(),run:unloadIndustryLoad,recover:recoverIndustryLoadUnload}} skillInstallApi={skillInstallApi} connectors={{probe:connectorProbeApi.probe}} readiness={{read:loadId=>industryLoadApi.readiness(loadId),prepare:async(loadId,digest)=>{const result=await industryLoadApi.prepare(loadId,digest,{activate:false});await refreshIndustryDirectories();return result}}}/>
  const industryResourceFilter=state.industryResourceTarget?.itemInstanceId&&state.industryResourceTarget.loadId?{loadId:state.industryResourceTarget.loadId,target:{loadId:state.industryResourceTarget.loadId,itemInstanceId:state.industryResourceTarget.itemInstanceId}}:state.industryResourceTarget??undefined


  const capabilityNavigation=readDirectoryFilterCategory(state.navigationDirectories.capabilities?.category,{category:'skill',mobileLayer:'category'},{category:['skill','source','method','extension'],mobileLayer:['category','list','detail']}) as Pick<TeamCapabilitiesNavigationState,'category'|'mobileLayer'>
  const resourceNavigation=readDirectoryFilterCategory(state.navigationDirectories.resources?.category,{category:'all',mobileLayer:'directory',libraryView:'recent',browseNodeId:''},{libraryView:['mine','recent','star','local','space'],category:['all','business-context','policy','sop','criteria','reference','template-asset','system-data-guide'],mobileLayer:['directory','detail']}) as Pick<ResourceManagerNavigationState,'category'|'mobileLayer'|'libraryView'|'browseNodeId'>
  const marketNavigation=readMarketNavigation(state.navigationDirectories.market?.category)
  const marketAppsPage=state.view==='market'&&state.marketMode==='catalog'&&marketNavigation.category==='apps'
  // 启动恢复的首次挂载只落回方案 B 主目录；旧技术类别经高级资源或业务配置请求主动进入。
  const marketEntryNavigation=marketStartup.current?{...marketNavigation,category:marketEntryCategory(marketNavigation.category)}:marketNavigation


  /**
   * 任务台账与详情只有这一处装配：页内第三栏与原生右栏的 teloa.task 页签共用它，
   * 两边只在“嵌入、可见、选中、选择回调”上不同，别的事实一份即可。
   */
  const renderTaskPage=(options:{embedded:boolean;visible:boolean;autoFocus?:boolean;selected:string|null;select:(id:string|null)=>void;navigation?:{state:WorkbenchDirectoryNavigation;change:(patch:WorkbenchDirectoryPatch)=>void}})=>
    <TaskPage roleDirectory={{known:roleDirectoryKnown,loading:roleLoading,error:roleLoadError}} createConversation={requestTaskCreationConversation} workProgress={runs=>{const latest=runs.at(-1);return latest?.lineage?<WorkProgressPanel api={workControlApi} rootTaskId={latest.lineage.rootTaskId} budgetAccountId={latest.lineage.budgetAccountId} revision={latest.id+':'+latest.state+':'+latest.taskVersion}/>:null}} groups={savedGroupOptions} openGroup={openSavedGroup} securityActions={task=>task.storage==='persistent'&&task.scope==='SOC'?<SecurityActions key={'security-'+task.id} taskId={task.id} taskVersion={task.version} api={securityActionApi} sourceApi={businessTaskApi} attention={securityAttention} attentionKnown={securityAttentionKnown} focus={securityFocus?.taskId===task.id?securityFocus:undefined} invalidateAttention={invalidateSecurityAttention} changed={async()=>{await Promise.all([loadSecurityAttention(),loadTasks()])}}/>:null} decisionFacts={item=>{
      // 依据行要的对象摘要：安全动作取 goal，任务取目标，交接的原因本来就在 reason 里。
      if(item.target.kind==='security-action'){
        const {taskId,actionId}=item.target,action=securityPanels[taskId]?.panel.actions.find(row=>row.id===actionId)
        return {evidence:securityDecisionEvidence(taskId,actionId),summary:action?.goal,request:action&&{title:action.title,targets:action.targetSet},risk:action&&{riskTier:action.riskTier,reversible:action.reversible,targets:action.targetSet.length}}
      }
      if(item.target.kind==='task'){const taskId=item.target.id;return {evidence:[],summary:tasks.tasks.find(row=>row.id===taskId)?.goal}}
      return {evidence:[]}
    }} decisionActions={item=>{
      const mode=attentionDecisionActionMode(item.target)
      if(mode==='security-action'&&item.target.kind==='security-action'){
        const taskId=item.target.taskId,props=securityDecisionProps(taskId,item.target.actionId)
        // 卡内已经用 attentionNextStepKey 显示过一遍"下一步"（过期/待核对），
        // 这里再传 nextStep=false，免得同一句话在同一张卡里出现两次（N-1）。
        return props?<SecurityDecisionActions {...props} nextStep={false}/>:<SecurityPanelFallback error={securityPanelErrors[taskId]} retry={async()=>{await loadSecurityPanel(taskId)}}/>
      }
      // 交接的两按钮只给真正挂着待处理交接单的事项；同为任务对象的资料、异常、审阅
      // 按规格只有“去处理”，不该因为对象碰巧是任务就长出接手按钮。
      if(mode==='handoff'&&item.kind==='handoff'&&item.target.kind==='task'){const props=handoffDecisionProps(item.target.id);return props?<HandoffDecisionActions {...props}/>:undefined}
      if(item.target.kind==='pending-request'){
        const requestId=item.target.requestId,request=serverRecoveries.find(row=>row.requestId===requestId)
        return request?<PendingRequestReview key={requestId} request={request} api={pendingRequestApi} busy={recoveringServerRequest!==undefined} continueRequest={()=>recoverServerRequest(requestId)} resolveTarget={(key,id)=>{
          if(key==='groupId'){const group=savedGroupOptions.find(row=>row.id===id);return group?{title:group.name,open:()=>openGroupTopic(id,'')}:undefined}
          if(key==='taskId'){const task=tasks.tasks.find(row=>row.id===id&&row.storage==='persistent');return task?{title:task.title,open:()=>actions.openTask(id)}:undefined}
          if(key==='roleId'){const role=tasks.roles.find(row=>row.id===id&&row.storage==='persistent');return role?{title:role.name,open:()=>actions.previewRole(id)}:undefined}
          if(key==='sessionId'){const conversation=work.getDirectorySnapshot().rows.find(row=>row.sessionId===id);return conversation?{title:conversation.title,open:()=>{void work.openConversation(conversation).then(()=>actions.navigate('messages')).catch(error=>setServerRecoveryNotice(localizeWorkError(locale,error)))}}:undefined}
          return undefined
        }}/>:undefined
      }
      return undefined
    }} {...(options.navigation?{navigation:options.navigation}:{})} industrySource={task=>task.storage==='persistent'?<IndustryTaskSourcePanel key={'source-'+task.id} taskId={task.id} api={industryTaskApi}/>:null} executions={(task,onRuns)=>task.storage==='persistent'?<TaskExecutions key={'executions-'+task.id} taskId={task.id} taskVersion={task.version} taskState={task.state} assigned={task.assigneeId!=='self'||task.executor?.kind==='owner'} changed={()=>{void loadTasks()}} api={taskRunApi} controls={workControlApi} onRuns={onRuns} face="timeline" open={async sessionId=>{await work.openSession(sessionId);actions.navigate('messages')}}/>:null} knowledge={task=>task.storage==='persistent'?<TaskKnowledge key={'knowledge-'+task.id+'-'+task.version} face="rail" task={task} api={taskMaterialApi} resources={resourceApi} changed={row=>mergeSavedTasks([row])}/>:null} persistence={taskPersistence} autoFocus={options.autoFocus!==false} embedded={options.embedded} conversations={id=>objectConversations('task',id)} openArtifacts={openArtifacts} openPlans={actions.openPlans} attentionItems={attentionItems} attentionKnown={attentionStatus.known} attentionLoading={workAttention.loading} {...(workAttention.nextCursor?{attentionMore:()=>{void workAttention.more()}}:{})} retryAttention={retryAttention} openAttention={openAttention} visible={options.visible} mode={state.view==='attention'?'attention':'tasks'} state={tasks} selected={options.selected} select={options.select} change={change=>{const task='taskId' in change?tasks.tasks.find(task=>task.id===change.taskId):undefined;if(task?.storage==='persistent'){if(change.type!=='progress'||change.action==='complete')throw Error(t('frame.p5.taskServiceUnsupported'));return taskTransitions.change(task.id,task.version,change.action).then(row=>{mergeSavedTasks([row])}).finally(()=>refreshTaskState(value=>value+1))}setTasks(changeTaskPreview(tasks,change))}} switchMode={()=>actions.navigate(state.view==='attention'?'tasks':'attention')} openSource={source=>openGroupTopic(source.groupId,source.rootId)} team={()=>actions.navigate('team')} openRole={actions.previewRole} openBusiness={openContextBusiness} saveTemplate={task=>actions.saveTemplate({title:task.title,scope:task.scope,description:task.goal})}/>

  /** 岗位目录与详情的唯一装配处：页内第三栏与右栏 teloa.role 页签共用。 */
  const renderTeamPage=(options:{embedded:boolean;visible:boolean;autoFocus?:boolean;selected:string|null;select:(id:string|null)=>void;navigation?:{state:WorkbenchDirectoryNavigation;change:(patch:WorkbenchDirectoryPatch)=>void}})=>
    <TeamPage skillTitleReader={options.visible?roleSkillTitleReader:undefined} phone={employeeVoiceApi?async id=>{if(voiceTarget||voiceOpening.current)throw Error(employeeVoiceCopy(locale,'call'));const role=tasks.roles.find(row=>row.id===id);if(!role)throw Error(employeeVoiceCopy(locale,'failed'));voiceOpening.current=true;setVoiceSelectionReady(false);setVoiceSessionId(undefined);setConversationObject(null);selectVoiceTarget({...role,kind:'role',roleKind:role.kind,initials:profile.initials,name:role.kind==='twin'?twinDisplayName(profile.displayName,t):role.name});try{if(await openRoleConversation(id))setVoiceSelectionReady(true);else selectVoiceTarget(undefined)}catch(error){selectVoiceTarget(undefined);throw error}finally{voiceOpening.current=false}}:undefined} templateSharing={{storage:navigationStorage,bridge:templateShareBridge,receive:()=>setTemplateReceiveOpen(true)}} delegations={roleDelegationApi} roleTools={roleToolGrantApi} delegationChanged={delegationChanged} savedGroups={groupApi} {...(options.navigation?{navigation:options.navigation}:{})} profileName={profile.displayName} profileInitials={profile.initials} pageCreate={{api:pageCreateApi,prepare:(prompt,scope)=>preparePageCreation(prompt,scope),openMarket:()=>actions.openMarket()}} work={work} resourceApi={roleResourceApi} memoryApi={memoryApi} dailyLogApi={dailyLogApi} dailyLogSchedule={id=>dailySchedules[id]} runtimeConfigs={runtimeConfigApi} persistence={{assignmentPending:!!taskApi.pendingAssignee(),recoverAssignment:async()=>{try{const row=await taskApi.recoverCreate();mergeSavedTasks([row]);return row.id}finally{refreshTaskState(value=>value+1)}},assign:async(role,fields)=>{try{const row=await taskApi.create({...fields,groupId:null,skills:[]},{roleId:role.id,expectedVersion:role.version});mergeSavedTasks([row]);return row.id}finally{refreshTaskState(value=>value+1)}},assignConfirmed:async(role,fields)=>{try{const row=await taskApi.createConfirmed({...fields,groupId:null,skills:[]},{roleId:role.id,expectedVersion:role.version});mergeSavedTasks([row]);return row.id}finally{refreshTaskState(value=>value+1)}},lifecycle:{pending:roleLifecycle.pending(),error:roleLoadError??(roleApi.recoveryMessage()?localizeWorkError(locale,roleApi.recoveryMessage()):undefined),change:async(role,action,reason)=>{try{const result=await roleLifecycle.change(role.id,role.version,action,reason);mergeRoles([result.role]);if(result.handoffTaskIds.length){handoffLoadGeneration.current++;setHandoffsKnown(false);await loadHandoffs()}}finally{refreshTaskState(value=>value+1)}},recover:async()=>{try{const result=await roleLifecycle.recover();mergeRoles([result.role]);if(result.handoffTaskIds.length){handoffLoadGeneration.current++;setHandoffsKnown(false);await loadHandoffs()}}finally{refreshTaskState(value=>value+1)}}},pendingFields:pendingRoleFields,create:createSavedRole,edit:editSavedRole,updateProfile:updateSavedRoleProfile,load:()=>{void refreshRoles()},error:roleLoadError??(roleApi.recoveryMessage()?localizeWorkError(locale,roleApi.recoveryMessage()):undefined),loading:roleLoading}} autoFocus={options.autoFocus!==false} embedded={options.embedded} conversations={id=>objectConversations('role',id)} talk={openRoleConversation} plans={id=><RolePlans heading={false} state={tasks} id={id} open={target=>{if(target.kind==='plan')setConversationPlanTarget(target);else actions.openPlans(target)}} savedPlanIds={new Set(savedPlans.map(plan=>plan.id))}/>} capabilities={id=>{const role=tasks.roles.find(row=>row.id===id&&row.storage==='persistent');return <>{role&&<RoleToolGrants role={role} api={roleToolGrantApi} delegations={roleDelegationApi} resources={resourceApi} changed={()=>{void loadRoles()}}/>}{industryResources({roleId:id})}<CapabilityTargetPanel market={()=>actions.openMarket()}/></>}} visible={options.visible} state={tasks} collaboration={collaboration} selected={options.selected} select={options.select} change={change=>{if('roleId' in change&&tasks.roles.some(role=>role.id===change.roleId&&role.storage==='persistent'))throw Error(t('frame.p5.roleServiceUnsupported'));setTasks(changeTeamPreview(tasks,change))}} openTask={actions.openTask} openGroup={id=>openGroupTopic(id,'')} openBusiness={openBusinessScope} resources={()=>actions.openResources()} nativeSettings={openNativePlugins} scopeLabels={scopeLabels} focusScope={teamFocusScope}/>

  /** 空间目录与详情的唯一装配处：页内第三栏与右栏 teloa.business 页签共用。 */
  /** 只统计当前范围里真实启用的已保存自动化；模板加载数不是自动化数。 */
  const businessScopeAutomations=(scope:string)=>savedPlans.filter(plan=>plan.scope===scope&&plan.state==='active').length
  /** 七行里的自动化读真实的持续计划；归档的计划已经不在这个业务里干活，不该被算进来。 */
  const businessCompositionPlans=savedPlans.filter(plan=>plan.state!=='archived')
  /**
   * `entry` 只由主视图传：右栏 `teloa.business` 页签与页内第三栏是另一份页面，
   * 台账首页点卡/「试一试」不该把它们一起换 key 重挂、更不该把它们切进示例沙盒（复审 H1）。
   */
  // 六类条目按 kind 打开原对象；跨业务引用同样只是打开原对象页面，权限由原对象页面自行判定。
  const projectConversationActions:ProjectConversationActions={
    create:async(project,memoryMode:ProjectMemoryMode,title,description)=>{
      if(creating)throw Error(t('project.loading'))
      const runtime=projectApi.runtime
      if(!runtime)throw Error(projectRuntimeCopy(locale).readError)
      const connection=projectConnection.current
      if(!projectFrameMounted.current||connection.projectApi!==projectApi||connection.homeContextApi!==homeContextApi||connection.work!==work||connection.preparation!==preparation)throw Error(projectRuntimeCopy(locale).stale)
      const creation=runtime.reserveCreation(project.id,title,memoryMode,description===undefined?undefined:{text:description,projectVersion:project.version,scope:project.scope})
      return await new Promise<boolean>((resolve,reject)=>{requestCreation({scope:project.scope as CollaborationScope,projectConversation:creation,projectCurrent:()=>projectFrameMounted.current&&projectConnection.current===connection,resolve,reject})})
    },
    open:async(sessionId)=>{
      const signal=beginNativeNavigation?.(),location=homeCreationLocation(latestState.current),previous=mainSession.getSnapshot()
      const mayOpen=()=>!signal?.aborted&&homeCreationLocation(latestState.current)===location&&mainSession.getSnapshot()===previous
      const result=await work.openSessionResult(sessionId,signal,mayOpen)
      if(result==='opened'&&work.getSnapshot().sessionId===sessionId&&mainSession.getSnapshot()===sessionId){actions.closeDetail();actions.openMessages('native');closeNarrowDirectory()}
    },
  }
  const openProjectItem=async(item:import('@teloa/contract').ProjectItem|import('@teloa/contract').ProjectReferenceItem)=>{
    if(!item.available)return
    if(item.kind==='task'){await loadTasks();actions.openTask(item.id)}
    else if(item.kind==='role'){actions.previewRole(item.id);await loadRoles()}
    else if(item.kind==='group')openGroupTopic(item.id,'')
    else if(item.kind==='plan'){await loadSavedPlans();actions.openPlans({kind:'plan',id:item.id})}
    else if(item.kind==='resource')actions.openResource(item.id)
    else {const artifact=await artifactApi.get(item.id);mergeArtifacts([artifact]);openArtifacts(artifact.source,{id:artifact.id,version:item.version??artifact.versions.at(-1)!.number})}
  }
  const renderBusinessPage=(options:{embedded:boolean;visible:boolean;target:BusinessTarget;entry?:BusinessEntry;navigation?:{state:WorkbenchDirectoryNavigation;change:(patch:WorkbenchDirectoryPatch)=>void}})=>
    businessBuilder&&!configurationServices?options.visible?<section role={builderState.status==='failed'?'alert':'status'}><p>{t(builderState.status==='failed'?'business.builder.error':'business.builder.loading')}</p>{builderState.status==='failed'&&<button type="button" onClick={()=>void businessBuilder.retry()}>{t('common.retry')}</button>}</section>:null:
    <BusinessPage workspace={{start:()=>requestDaily(options.target.scope,localizedScopeNames[options.target.scope]??options.target.scope),newConversation:()=>requestDaily(options.target.scope,localizedScopeNames[options.target.scope]??options.target.scope,true),actionReady:businessReady&&!dailyBusy,conversationStatus:dailyStatus,responsibility:configurationResponsibility,groups:groupApi,openGroup:openSavedGroup,createGroup:createDirectoryGroup,talkRole:openRoleConversation,attention:attentionItems,openAttention,tasksKnown:taskAttentionKnown&&!taskLoadError,tasksFailed:!!taskLoadError,rolesKnown:roleDirectoryKnown&&!roleLoadError,rolesFailed:!!roleLoadError,renderRole:(id,close)=>renderTeamPage({embedded:true,visible:true,selected:id,select:next=>{if(next)actions.previewRole(next);else close()}}),attentionKnown:attentionStatus.known,attentionFailed:!!(workAttention.error||taskLoadError||securityAttentionError||handoffError||serverRecoveryError)||savedPlanDirectory==='failed',refresh:()=>{retryAttention();void loadRoles()}}} {...(configurationServices?{configuration:configurationServices}:{})} plugins={industryPlugins} projectApi={projectApi} projectConversations={projectConversationActions} openProjectItem={openProjectItem} key={businessPageEntryProps(options.entry).key} {...businessPageEntryProps(options.entry).props} scopeLabels={scopeLabels} backHome={()=>applyBusinessNav({kind:'back-home'})} openStaff={openStaffOfScope} {...(businessScopeAutomations(options.target.scope)!==undefined?{automations:businessScopeAutomations(options.target.scope)!}:{})} manageIndustryResources={scope=>actions.openIndustryResources({scope})} industryLoads={savedIndustryLoads} dataSources={industryDataSources} businessLedgerApi={businessLedgerApi} businessDashboardApi={businessDashboardApi} colorScheme={state.colorScheme} businessCustomizationApi={businessCustomizationApi} businessShareApi={businessShareApi} pageCreate={{api:pageCreateApi,prepare:prompt=>preparePageCreation(prompt,options.target.scope),openMarket:()=>actions.openMarket(),confirmConnector:confirmPageCreateConnector,openConnector:openConfirmedPageCreateConnector}} businessTaskApi={businessTaskApi} createBusinessTask={createBusinessSavedTask} recoverBusinessTask={recoverBusinessSavedTask} plans={businessCompositionPlans} goComposition={openComposition} isPinned={businessShortcutPinned(options.target)} togglePin={personalBusinessShortcuts.toggle} openFull={()=>businessPanel&&enterBusiness(businessPanel)} embedded={options.embedded} openPlans={scope=>actions.openPlans({kind:'plans',scope})} capabilities={scope=><CapabilityTargetPanel market={()=>actions.openMarket()}/>} visible={options.visible} state={tasks} target={options.target} go={openContextBusiness} openTask={id=>{if(businessDetailOpen&&id===contextTask?.id)openContextObject();else actions.openTask(id)}} openWork={()=>{actions.rememberDirectory('tasks',{category:writeDirectoryFilterCategory({scope:options.target.scope,routed:'all'}),query:undefined,selectedId:undefined});actions.selectTask(null);actions.navigate('tasks')}} openMessages={()=>actions.navigate('messages')} openGroups={()=>actions.openMessages('groups')} openResources={()=>actions.openResources()} market={id=>actions.openMarket(id)}/>

  // —— 原生右栏页签的内容源：DSH 出座位，这里出内容 ——
  const teloaTabTarget=(kind:TeloaTabKind,params:unknown)=>current?tabToDetailTarget(kind,params,current):null
  // 任务的依据来自安全动作那条既有映射；没有依据就不出二级切换条。
  const teloaTabEvidence=(taskId:string)=>attentionItems.flatMap(item=>item.target.kind==='security-action'&&item.target.taskId===taskId?securityDecisionEvidence(taskId,item.target.actionId):[])
  const closeTeloaTabDetail=closeObjectPanel
  const renderTeloaTab=(kind:TeloaTabKind,view:TeloaTabSecondaryView,params:unknown):ReactNode=>{
    const target=teloaTabTarget(kind,params)
    if(target?.kind!=='conversation-object')return null
    // 右栏那份实例不接目录记忆，也不夺焦：它没有目录面，抢了焦点就把用户从对话框里拽走。
    if(target.objectKind==='business')return renderBusinessPage({embedded:true,visible:true,target:target.target})
    if(target.objectKind==='role')return renderTeamPage({embedded:true,visible:true,autoFocus:false,selected:target.id,select:id=>{if(id)actions.selectRole(id);else closeTeloaTabDetail()}})
    const taskId=target.id
    if(view==='evidence')return <EvidenceList entries={teloaTabEvidence(taskId)}/>
    return renderTaskPage({embedded:true,visible:true,autoFocus:false,selected:taskId,select:id=>{if(id)actions.selectTask(id);else closeTeloaTabDetail()}})
  }
  // 座位与外壳分处两棵 React 树：发布一个**稳定**的委托对象，内容每次渲染经 ref 取最新，
  // 通知则只在与页签相关的事实变化时发一次——否则外壳每敲一个字页签正文都要整棵重绘。
  const tabHostLatest=useRef<TeloaTabHost>()
  const tabHostValue:TeloaTabHost={
    overviewRoom:{canShow:()=>canShowConversationOverview(viewportWidth,detailsCanShow),guard:guardOverviewRoom},
    artifactPreview:{
      target:sessionId=>conversationVisible&&sessionId===current&&artifactOpen?artifactTarget:null,
      mount:(sessionId,node)=>{
        setArtifactMounts(previous=>{if(previous.get(sessionId)===node)return previous;const next=new Map(previous);next.set(sessionId,node);return next})
        return()=>setArtifactMounts(previous=>{if(previous.get(sessionId)!==node)return previous;const next=new Map(previous);next.delete(sessionId);return next})
      },
      open:(sessionId,target)=>{if(conversationVisible&&sessionId===current){artifactReadIntent.current++;actions.openDetail(artifactDetailTarget(target.source,target.artifact?.version!==undefined?{id:target.artifact.id,version:target.artifact.version}:undefined,sessionId,target.initialView,target.initialAction))}},
      close:sessionId=>{if(conversationVisible&&sessionId===current){artifactReadIntent.current++;if(artifactOpen)actions.closeDetail()}},
      saveFile:async(sessionId,file,isCurrent)=>{
        const origin=artifactSaveOrigin.current,maySave=()=>artifactSaveOrigin.current.visible&&origin.api===artifactSaveOrigin.current.api&&origin.conversation?.id===sessionId&&origin.conversation.bindingId===artifactSaveOrigin.current.conversation?.bindingId&&mainSession.getSnapshot()===sessionId&&isCurrent()
        if(!maySave())throw Object.assign(Error(),{code:'teloa/source-unavailable'})
        const source=resolveArtifactSource(tasks,{kind:'session',id:sessionId},origin.conversation)
        const saved=await saveConversationOverviewFile(origin.api,source,file,maySave)
        if(origin.api===artifactSaveOrigin.current.api)mergeArtifacts([saved.artifact])
        return {id:saved.id,version:saved.version}
      },
    },
    render:renderTeloaTab,
    hasEvidence:(kind,params)=>{
      const target=teloaTabTarget(kind,params)
      return target?.kind==='conversation-object'&&target.objectKind==='task'&&teloaTabEvidence(target.id).length>0
    },
    label:(kind,params)=>{
      const target=teloaTabTarget(kind,params)
      if(target?.kind!=='conversation-object')return undefined
      if(target.objectKind==='business')return localizedScopeNames[target.target.scope]??target.target.scope
      if(target.objectKind==='role')return tasks.roles.find(row=>row.id===target.id)?.name||t('sidebarRight.tab.role')
      return tasks.tasks.find(row=>row.id===target.id)?.title||t('sidebarRight.tab.task')
    },
    bindTab:(sessionId,kind,tabId)=>railTabs.bindTab(sessionId,kind,tabId),
    // 页签关闭前的收尾：只有这个会话里这个页类型的页签正好承载着当前页内详情时才收，
    // 否则跨 kind 导航（DSH 先跑旧页签的关闭钩子、再提交新页签）会把刚写好的详情抹掉。
    releaseTab:(sessionId,kind)=>{if(railTabs.release(sessionId,kind)){actions.closeDetail();if(sessionId===current)restoreObjectPanelFocus(sessionId)}},
  }
  useLayoutEffect(()=>{tabHostLatest.current=tabHostValue})
  const tabHostDelegate=useMemo<TeloaTabHost>(()=>({
    overviewRoom:{canShow:()=>tabHostLatest.current?.overviewRoom?.canShow()??false,guard:sessionId=>tabHostLatest.current?.overviewRoom?.guard(sessionId)},
    artifactPreview:{
      target:sessionId=>tabHostLatest.current?.artifactPreview?.target(sessionId)??null,
      mount:(sessionId,node)=>tabHostLatest.current?.artifactPreview?.mount(sessionId,node)??(()=>{}),
      open:(sessionId,target)=>tabHostLatest.current?.artifactPreview?.open(sessionId,target),
      close:sessionId=>tabHostLatest.current?.artifactPreview?.close(sessionId),
      saveFile:async(sessionId,file,isCurrent)=>{const save=tabHostLatest.current?.artifactPreview?.saveFile;if(!save)throw Object.assign(Error(),{code:'teloa/source-unavailable'});return save(sessionId,file,isCurrent)},
    },
    render:(kind,view,params)=>tabHostLatest.current?.render(kind,view,params)??null,
    hasEvidence:(kind,params)=>tabHostLatest.current?.hasEvidence(kind,params)??false,
    label:(kind,params)=>tabHostLatest.current?.label(kind,params),
    bindTab:(sessionId,kind,tabId)=>{tabHostLatest.current?.bindTab(sessionId,kind,tabId)},
    releaseTab:(sessionId,kind)=>tabHostLatest.current?.releaseTab(sessionId,kind),
  }),[])
  useEffect(()=>{publishTeloaTabHost(tabHostDelegate);return()=>retractTeloaTabHost(tabHostDelegate)},[tabHostDelegate])
  // 页签正文就是整张任务 / 岗位 / 空间页，它的输入几乎就是整个外壳的状态，
  // 任何人工维护的“相关事实白名单”都必然漏项（漏一项就是页签停在旧事实）。
  // 因此每次提交都通知一次；没有页签挂载时订阅者为空，这一步几乎不花钱，
  // 有页签挂载时它本来就该跟着外壳走。
  useEffect(()=>{notifyTeloaTabHost()})
  // 刷新恢复：DSH 的布局与页签全是内存态，Teloa 这边 state.detail 已落当前导航恢复存储，
  // 由内容插件自己重开一次，跟终端的做法一致；只恢复一次，之后用户自己的开关不被覆盖。
  useEffect(()=>{
    if(!current||!railReady)return
    // 取已按当前会话核对过的目标：落盘的 state.detail 可能属于别的会话，
    // 拿裸值恢复会把 A 会话的对象开进 B 的右栏，还烧掉这一次性的恢复名额。
    const target=detailTarget
    const tab=detailTargetToTab(target)
    railTabs.restoreOnce(current,target&&tab&&railServes(tab.kind)?{kind:tab.kind,params:tab.params,target}:null)
  },[current,railReady,state.detail])

  let assistantRecovery:ReturnType<typeof pendingAssistantCreation>
  try{assistantRecovery=creationIntent?.assistant?pendingAssistantCreation(navigationStorage):undefined}catch{/* 创建入口已呈现恢复错误；渲染不扩大授权。 */}
  const voicePanel=employeeVoiceApi&&voiceTarget&&<div className={tokens.tokens}><EmployeeVoiceCall api={employeeVoiceApi} target={voiceTarget} onEnded={()=>{if(currentVoice.current.target===voiceTarget){currentVoice.current.ended=true;voiceListeners.current.forEach(listener=>listener())}}} sessionId={voiceSessionId} openConversation={id=>{void work.openSession(id).then(()=>{leaveComputer();actions.openMessages('native')}).catch(()=>{})}} dismiss={()=>selectVoiceTarget(undefined)}/></div>
  const openPlanSourceConversation=async(sessionId:string,cancelSignal?:AbortSignal)=>{
    const navigationSignal=beginNativeNavigation?.(),signal=cancelSignal&&navigationSignal?AbortSignal.any([cancelSignal,navigationSignal]):cancelSignal??navigationSignal
    const location=homeCreationLocation(latestState.current),previous=mainSession.getSnapshot()
    const mayOpen=()=>!signal?.aborted&&homeCreationLocation(latestState.current)===location&&mainSession.getSnapshot()===previous
    const result=await work.openSessionResult(sessionId,signal,mayOpen)
    if(result!=='opened'||cancelSignal?.aborted)return
    // 原生成功打开可能撤销自身导航信号；只以本次回执、当前归属与调用方取消判断后续视图。
    const stillAtEntry=homeCreationLocation(latestState.current)===location||latestState.current.view==='messages'&&latestState.current.messageMode==='native'
    if(stillAtEntry&&work.getSnapshot().sessionId===sessionId&&mainSession.getSnapshot()===sessionId){setConversationPlanTarget(undefined);actions.closeDetail();actions.openMessages('native')}
  }
  const renderContinuousPage=(visible:boolean,target:import('./continuous-preview.js').ContinuousTarget,go:(target:import('./continuous-preview.js').ContinuousTarget)=>void,embedded=false)=>{
    const navigate=<Args extends unknown[],Result>(action:(...args:Args)=>Result)=>(...args:Args)=>{if(embedded)setConversationPlanTarget(undefined);return action(...args)}
    return (
<ContinuousPage groups={savedGroupOptions} openConversation={openPlanSourceConversation} prepareConversation={navigate(request=>{const employee=request.roleId?tasks.roles.find(row=>row.id===request.roleId&&row.storage==='persistent'):undefined;const goal=t('workbench.create.planPrompt',{goal:request.goal})+(employee?' '+t('workbench.create.employee',{name:employee.name}):'');if(request.roleId){const object=resolveConversationObject('role',request.roleId);return requestRoleCreation(object,request.scope?[request.scope]:employee?.scopes??[],goal)}return requestCreation({scope:request.scope??'general',goal})})} navigation={{state:state.navigationDirectories.plans??{},change:patch=>actions.rememberDirectory('plans',patch)}} persistence={{api:planApi,controls:workControlApi,resources:resourceApi,plans:savedPlans,merge:mergeSavedPlans,refreshRoles:()=>{void refreshRoles()},industrySource:plan=><IndustryPlanSourcePanel key={'industry-plan-source-'+plan.id} planId={plan.id} api={industryPlanApi}/>}} openArtifacts={navigate(openArtifacts)} seed={state.templatePlanSeed} clearSeed={actions.clearPlanSeed} openMarket={navigate(actions.openMarket)} visible={visible} embedded={embedded} state={tasks} target={target} go={go} change={command=>{const id='planId' in command?command.planId:'id' in command?command.id:undefined;if(savedPlansRef.current.some(plan=>plan.id===id))throw Error(t('frame.p5.planServiceRequired'));const next=changeContinuousWork(tasks,command,marketRef.current);setTasks(next);return next}} openTask={navigate(actions.openTask)} openRole={actions.previewRole} openBusiness={navigate(enterBusiness)} team={navigate(()=>actions.navigate('team'))} attention={navigate(actions.openAttention)}/>
  )
  }
  const rolePreview=state.rolePreview,previewRole=tasks.roles.find(role=>role.id===rolePreview?.id)
  const closeRolePreview=()=>{if(rolePreview)actions.closeRolePreview(rolePreview.request)}
  const rolePreviewDrawer=<ContextDrawer padded={!previewRole} open={!!rolePreview} title={previewRole?.kind==='twin'?twinDisplayName(profile.displayName,t):previewRole?.name??t('navigation.team')} close={closeRolePreview} className={previewRole?.kind==='twin'?(twinCss.detailDrawer??''):''}>
    {rolePreview&&!previewRole?<p role={roleLoading||!roleDirectoryKnown&&!roleLoadError?'status':'alert'}>{roleLoading||!roleDirectoryKnown&&!roleLoadError?t('team.loading'):roleLoadError??t('frame.p5.industryRoleUnavailable')}</p>:null}
    {renderTeamPage({embedded:true,visible:!!rolePreview&&!!previewRole,autoFocus:false,selected:rolePreview?.id??null,select:id=>{if(id)actions.previewRole(id);else closeRolePreview()}})}
  </ContextDrawer>
  if(computerRoleId)return <>{voicePanel}<EmployeeComputerPage role={tasks.roles.find(role=>role.id===computerRoleId&&role.storage==='persistent')} scopes={localizedScopeNames} loading={roleLoading||!roleDirectoryKnown&&!roleLoadError} error={roleLoadError} retry={()=>{void refreshRoles()}} back={()=>{leaveComputer();actions.navigate('team')}} openEmployee={id=>{leaveComputer();actions.openRole(id)}} talk={async id=>{const opened=await openRoleConversation(id);if(opened)leaveComputer();return opened}}/></>
  // 页签正文所需的 React context 必须在 `.details` 轨道祖先层提供：右栏页签的正文由本外壳画，
  // 但它挂在 `.details` 里的座位上，只包 <main> 的 provider 够不着，一渲染就抛。
  return <PageCreateRevisionContext.Provider value={prepareDraftRevision}>{voicePanel}<BusinessScopeProvider labels={scopeLabels}><TemplateShareProvider value={{storage:navigationStorage,bridge:templateShareBridge,publisher:profile.displayName,sources:templateShareSources,receive:()=>setTemplateReceiveOpen(true),openDraft:setShareDraft}}><ApprovalNotesProvider>{conversationPlanTarget&&renderContinuousPage(true,conversationPlanTarget,target=>{if(target.kind==='plan')setConversationPlanTarget(target);else{setConversationPlanTarget(undefined);if(target.kind!=='plans')actions.openPlans(target)}},true)}<div ref={frameRef} onScrollCapture={rememberDirectoryScroll} className={clsx(tokens.tokens,css.frame,state.navOpen&&css.navOpen,state.view==='messages'&&directoryVisible&&(!conversationVisible||!objectEmbedded)&&css.directoryOpen,railShown&&css.detailsOpen,detailsDragging&&css.dragging)}>
    {rolePreviewDrawer}
    <WorkspaceSearch visible={workspaceSearchOpen} source={workspaceSearchSource} conversationStatus={searchDirectory.error?t('error.unknown'):!searchManagement.ready||searchDirectory.status!=='ready'?t('workspaceSearch.conversationsUnavailable'):''} knowledgeStatus={workspaceSearchKnowledgeStatus==='loading'?t('workspaceSearch.knowledgeLoading'):workspaceSearchKnowledgeStatus==='failed'?t('workspaceSearch.knowledgeUnavailable'):''} capabilityStatus={workspaceSearchCapabilityStatus==='loading'?t('workspaceSearch.capabilityLoading'):workspaceSearchCapabilityStatus==='failed'?t('workspaceSearch.capabilityUnavailable'):''} close={()=>setWorkspaceSearchOpen(false)} open={openSearchResult} searchMessages={actions.focusConversationSearch}/>
    <a href="#teloa-main" className={css.skip}>{t('shell.skipToWorkspace')}</a>
    {state.navOpen&&<button className={css.navMask} aria-label={t('shell.navigation.close')} onClick={actions.closeNavigation}/>}
    <AssistantCompanion name={assistantName} startCall={employeeVoiceApi?startAssistantCall:undefined} voiceMessage={employeeVoiceApi&&insertAssistantVoiceText?<AssistantVoiceMessage api={employeeVoiceApi} prepare={prepareAssistantVoiceNote} insert={insertAssistantVoiceText}/>:undefined} activity={companionActivity} storage={navigationStorage} active={assistantActive} setActive={setCompanionActive} openConversation={openPersonalAssistant} chat={assistantChat} openAttention={actions.openAttention} needCount={needCount} attentionKnown={attentionStatus.known}/>
    <WorkNavigation marketApps={state.marketMode==='catalog'&&marketNavigation.category==='apps'} assistantName={assistantName} renameAssistant={dialogueOrganization.renameAssistant} conversationPlans={conversationPlans} openAssistant={openPersonalAssistant} assistantSelected={!builderVisible&&conversationVisible&&!!current&&companionActivity.sessionId===current} assistantActive={assistantActive} setAssistantActive={setCompanionActive} onSearch={()=>{actions.closeNavigation();setWorkspaceSearchOpen(true)}} view={state.view} colorScheme={state.colorScheme} actions={actions} work={work} management={management} useSessions={useSessions} create={options=>requestCreation(state.view==='spaces'?{scope:state.businessTarget.scope}:{},options?.chooseWorkspace)} creating={creating} needCount={needCount} attentionKnown={attentionStatus.known} createTask={()=>requestTaskCreationConversation(state.view==='spaces'?state.businessTarget.scope:'general')} createGroup={createDirectoryGroup} openTwin={async()=>{await openTwinConversation()}} setTheme={setTheme} businessShortcuts={businessShortcuts} businessScopeNames={localizedScopeNames} businessTarget={state.businessTarget} openBusinessShortcut={openBusinessShortcut} unpinBusinessShortcut={personalBusinessShortcuts.unpin} businessDashboardTitles={businessDashboardTitles}/>
    <div className={css.workspace}>
      {returnOrigin&&<div className={css.setupReturn}><button type="button" className={light.back} onClick={returnToSetupBusiness}><ArrowLeft size={14} aria-hidden/>{t('business.setup.return',{title:returnOrigin.title})}</button></div>}
      <header className={css.topbar}>
        <ActionButton className={css.mobileNavigation} aria-label={t('shell.navigation.open')} onClick={actions.toggleNavigation}><PanelLeft size={18}/></ActionButton>
        {!builderVisible&&conversationVisible&&(contextRole||assistantCurrent)
          ? <EmployeeConversationHeader name={contextRole?(contextRole.kind==='twin'?twinDisplayName(profile.displayName,t):contextRole.name):assistantName} avatar={contextRole?(contextRole.kind==='twin'?<TwinAvatar initials={profile.initials}/>:<EmployeeAvatar avatarKey={contextRole.avatarKey} size="md"/>):<img src={assistantAvatar} alt=""/>} topic={assistantCurrent&&(!conversationTitle||conversationTitle===assistantConversationTitle)?conversationHeaderCopy(locale,'main'):conversationTitle||title} {...(contextRole?{viewProfile:toggleContextObject,profileRef:objectPanelTrigger,profileOpen:contextDetailShown&&!businessDetailOpen}:{})}/>
          : <nav className={css.crumbs} aria-label={t('shell.breadcrumbAria')}><button type="button" className={clsx(css.crumb,css.workspaceName)} onClick={()=>actions.navigate('home')}>{profile.displayName}</button><ChevronRight size={12}/><button type="button" className={css.crumb} aria-current="page" onClick={()=>isWorkbenchHubView(state.view)?actions.navigate('home'):openViewRoot(state.view)}><strong>{isWorkbenchHubView(state.view)?t('navigation.home'):marketAppsPage?t('market.apps.title'):labels[state.view]}</strong></button></nav>}
        <div className={css.toolbar}>
          {renderSlot('teloa.workbench.toolbar',{})}
          {state.view==='messages'&&<ActionButton className={css.iconButton} onClick={toggleDirectoryColumn} aria-label={t('shell.conversationDirectory')} title={t('shell.conversationDirectory')} aria-expanded={directoryVisible} icon={<PanelLeft size={17}/>}/> }
          {nativePanelVisible&&<ActionButton className={css.iconButton} aria-label={t('shell.settings')} title={t('shell.settings')} onClick={actions.openDirectory} icon={<Settings2 size={17}/>}/> }
          {conversationVisible&&<DetailsMenu menuRef={messageContextMenu} className={css.messageContext} resetKey={current} closeOnSelect>
            <summary data-teloa-conversation-options aria-label={conversationHeaderCopy(locale,'options')} title={conversationHeaderCopy(locale,'options')}><MoreHorizontal size={17}/></summary>
            <div role="menu">
              <button type="button" role="menuitem" disabled={creating||!!contextRole&&(!peopleAllowed||contextRole.state==='retired')} onClick={()=>{messageContextMenu.current?.removeAttribute('open');createContextConversation()}}>{t('navigation.newConversation')}</button>
              <button type="button" role="menuitem" disabled={!canViewConversationArtifacts} onClick={()=>{messageContextMenu.current?.removeAttribute('open');if(current)openArtifacts({kind:'session',id:current})}}>{t('shell.artifacts')}</button>
            </div>
          </DetailsMenu>}
        </div>
      </header>
      {!builderVisible&&<WorkbenchHubNavigation view={state.view} needCount={needCount} attentionKnown={attentionStatus.known} onSelect={view=>view==='attention'?actions.openAttention():view==='plans'?actions.openPlans({kind:'plans'}):actions.navigate(view)}/>}
      <div className={css.columns}>
        <aside className={css.directory} aria-label={t('frame.directoryAria')}>
          <WorkDirectory organization={dialogueOrganization} conversationPlans={conversationPlans} groups={conversationGroups} roles={tasks.roles} objectApi={objectConversationApi} selectedGroup={state.messageMode==='groups'?state.groupTarget?.groupId:undefined} openGroup={openSavedGroup} createGroup={createDirectoryGroup} onCreateConversation={()=>requestCreation({})} creating={creating} onClose={actions.closeSidebar} focusRequest={state.searchFocusRequest} focusQuery={state.searchFocusQuery} onFocusHandled={actions.completeConversationSearchRequest} onOpened={()=>{actions.openMessages('native');closeNarrowDirectory()}} openResults={sessionId=>{if(work.getDirectorySnapshot().status!=='ready'||!work.getDirectorySnapshot().rows.some(row=>row.sessionId===sessionId&&row.status==='ready'))return;openArtifacts({kind:'session',id:sessionId})}} work={work} management={management} search={conversationSearch} current={conversationVisible?current:undefined} useSessions={useSessions}/>
        </aside>
        <main id="teloa-main" tabIndex={-1} className={clsx(css.main,nativeMainVisible&&css.conversationMain,objectEmbedded&&css.withObjectPanel,builderVisible&&css.withBuilder,builderVisible&&builderTab==='preview'&&css.builderPreviewSelected)}>
          {nativePanelError&&<p role="alert">{nativePanelError}</p>}
          {builderError&&!businessLedgerHome&&<p role="alert">{builderError}</p>}
          {!!builderState.error&&!businessLedgerHome&&(state.view==='messages'||state.view==='home')&&<p role="alert">{t('business.builder.error')} <button type="button" onClick={()=>void businessBuilder?.retry()}>{t('common.retry')}</button></p>}
          {!builderVisible&&conversationVisible&&contextRole&&<CapabilityNotice capability="people"/>}
          {!builderVisible&&conversationVisible&&current&&projectApi.runtime&&<ProjectConversationContext sessionId={current} api={projectApi} resolved={setConversationProject} className={css.objectContext} openProject={project=>openContextBusiness({scope:project.scope as CollaborationScope,section:'projects',id:project.id})} newConversation={(project,mode)=>{void projectConversationActions.create(project,mode,projectRuntimeCopy(locale).newConversation).catch(error=>setServerRecoveryNotice(localizeWorkError(locale,error)))}}/>}
          {!builderVisible&&conversationVisible&&conversationObject&&contextLinked&&(conversationObject.object.kind==='role'&&contextRole
            ? <section className={css.conversationContext} aria-label={t('frame.context.sourceAria')}>
                <span title={roleFieldText(contextRole,'duty',t)}>{dutyLead(roleFieldText(contextRole,'duty',t))}</span>
                {contextScope&&<button type="button" className={css.contextSource} title={t('frame.context.sourceAria')} onClick={()=>openContextBusiness({scope:contextScope,section:'overview'})}>{localizedScopeNames[contextScope]??contextScope}<ChevronRight size={12}/></button>}
                {contextRole.state!=='active'&&<StatusLabel label={t(contextRole.state==='paused'?'role.state.paused':'role.state.retired')} mark={contextRole.state==='paused'?'paused':'retired'} tone="muted"/>}
              </section>
            : <section className={css.objectContext} aria-label={t('frame.context.sourceAria')}>
                <div className={css.contextIdentity}><div className={css.contextTitle}><strong>{t('frame.context.kindTask')} · {contextTask?.title||conversationObject.object.title}</strong></div></div>
                <div className={css.objectActions}>{contextScope&&<button type="button" className={css.contextSource} title={t('frame.context.sourceAria')} onClick={()=>openContextBusiness({scope:contextScope,section:'overview'})}>{localizedScopeNames[contextScope]??contextScope}</button>}{contextTask?.objectRefs?.map(ref=><button key={objectKey(ref)} type="button" aria-label={t('frame.context.openBusinessObject',{title:ref.title})} onClick={()=>openContextBusiness(objectRefTarget(ref))}>{t('frame.context.businessObject',{title:ref.title,version:ref.version})}</button>)}{contextTask&&<button type="button" ref={objectPanelTrigger} aria-expanded={contextDetailShown&&!businessDetailOpen} onClick={toggleContextObject}>{contextPanelTitle}</button>}</div>
              </section>)}
          {recordPreparation&&recordPreparation.api===builderState.api&&recordPreparation.sessionId===current&&conversationVisible&&<section className={css.objectContext} role="region" aria-label={t('business.records.preparedTitle')}>
            <p>{t('business.records.preparedNote',{version:recordPreparation.reference.version})}</p>
            {recordInsertError&&<p role="alert">{t('business.records.prepareBlocked')}</p>}
            <div className={css.objectActions}><button type="button" disabled={recordInsertBusy||!businessReady} onClick={()=>void bringRecord()}>{t('business.records.insertReference')}</button>
            <button type="button" disabled={recordInsertBusy||dailyBusy||!businessReady} onClick={()=>requestDaily(recordPreparation.reference.scope,recordPreparation.title,true,recordPreparation.reference)}>{t('business.records.newForReference')}</button>
            <button type="button" disabled={recordInsertBusy} onClick={()=>setRecordPreparation(undefined)}>{t('business.records.cancel')}</button></div>
          </section>}
          <AssistantConversationTitleContext.Provider key="native-conversation" value={assistantCurrent&&current?{sessionId:current,name:assistantName}:undefined}><div className={clsx(css.nativeConversation,(!nativeMainVisible||nativePanelVisible)&&css.hidden)} aria-label={t('frame.nativeConversationAria')}>{renderSlot('teloa.conversation',{
            content:renderSlot('main',{}, {entryKey:'conversation'}),
            home:state.view==='home',ready:state.view!=='home'||homeSessionId!==undefined&&homeSessionId===current,
            engaged:sessionId=>{if(latestState.current.view==='home'&&mainSession.getSnapshot()===sessionId)actions.openMessages('native')},
            notice:state.view==='home'&&(homeSessionId===undefined||homeSessionId!==current)?<HomeNativePreparationNotice locale={locale} error={homeInputError} retry={()=>setHomeRetry(value=>value+1)} chooseLocation={()=>requestCreation({},true)}/>:undefined,
            overview:<WorkHome assistantName={assistantName} current={current} workTasks={tasks.tasks} colleagues={tasks.roles} conversationLinks={activeObjectLinks} attention={actions.openAttention} attentionStatus={attentionStatus} planStatus={planStatus} management={management} plans={()=>actions.openPlans()} visible={state.view==='home'} work={work} useSessions={useSessions} open={()=>actions.navigate('messages')} openTask={actions.openTask} openTasks={()=>actions.navigate('tasks')}/>,
          })}</div></AssistantConversationTitleContext.Provider>
          {builderState.sessionKind==='daily'&&(state.view==='home'||conversationVisible)&&dailyStatus}
          {builderVisible&&builderFlow&&<section key="business-builder" className={css.builderPreview}><BusinessBuilderPanel flow={builderFlow} renderPage={projection=><BusinessConfigurationPage projection={projection} colorScheme={state.colorScheme}/>} onOpenSaved={result=>openBusinessScope(result.scope)}/></section>}
          {builderVisible&&<div key="business-builder-tabs" className={css.builderTabs} role="tablist" aria-label={t('business.builder.title')}><button type="button" role="tab" aria-selected={builderTab==='conversation'} onClick={()=>setBuilderTab('conversation')}>{t('business.builder.conversation')}</button><button type="button" role="tab" aria-selected={builderTab==='preview'} onClick={()=>setBuilderTab('preview')}>{t('business.builder.previewTab')}</button></div>}
          {nativePanelVisible&&<div className={css.nativeConversation} aria-label={t('teamCapability.runtime.manage')}>{renderSlot('main',{}, {entryKey:state.panelInfo.activePanelId!})}</div>}
          {conversationDirectoryVisible&&<section className={css.conversationLanding} aria-label={t('conversationDirectory.landingTitle')}><MessageSquare size={30} aria-hidden="true"/><h1>{t('conversationDirectory.landingTitle')}</h1></section>}
          <section className={clsx(css.nativeManagement,(state.view!=='settings'||nativePanelVisible)&&css.hidden)} aria-label={t('shell.settings')}>
            {renderSlot('sidebar',{collapsed:false,width:244})}
          </section>
          {state.view==='attention'&&(serverRecoveryError||serverRecoveryNotice)&&<div role="alert">{serverRecoveryError||serverRecoveryNotice}</div>}
          {['home','tasks','attention'].includes(state.view)&&securityAttentionError&&<div role="alert">{t('security.title')}: {securityAttentionError} <button type="button" disabled={securityAttentionLoading} onClick={()=>void loadSecurityAttention().catch(()=>{})}>{t('taskExecution.refresh')}</button></div>}
          <CollaborationPage artifactRail={{mount:artifactRailMount,report:reportGroupArtifact,collapse:groupArtifactCollapse}} artifactOpen={artifactRailShown} work={{refreshTasks:async groupId=>{const api=taskApi,groups=groupApi,current=()=>taskLoadApi.current===api&&teamConnection.current.groups===groups&&latestState.current.view==='messages'&&latestState.current.messageMode==='groups'&&latestState.current.groupTarget?.groupId===groupId;if(!current())return false;return loadTasks(current)},createTask:groupId=>{setHomeTaskGroupId(groupId);setHomeCreationError(undefined);setHomeCreation('task')},tasks:tasks.tasks,links:groupWorkLinks,openLink:item=>{if(item.kind==='task')actions.openTask(item.id);else enterBusiness({scope:item.scope,section:item.kind==='project'?'projects':'data',id:item.id,...(item.kind==='business'?{objectType:item.type}:{})})},renderLink:(item,close)=>item.kind==='task'?renderTaskPage({embedded:true,visible:true,selected:item.id,select:id=>{if(id)actions.selectTask(id);else close()}}):item.kind==='project'?<ProjectWorkspace api={projectApi} conversationActions={projectConversationActions} scope={item.scope} selectedId={item.id} typeName={t('navigation.projects')} scopeLabels={scopeLabels} select={(id,scope)=>enterBusiness({scope:(scope??item.scope) as CollaborationScope,section:'projects',id})} back={close} openItem={openProjectItem}/>:renderBusinessPage({embedded:true,visible:true,target:{scope:item.scope,section:'data',id:item.id,...(item.kind==='business'?{objectType:item.type}:{})}}),openTask:actions.openTask,openRole:actions.previewRole,talkRole:openRoleConversation,renderRole:(id,close)=>renderTeamPage({embedded:true,visible:true,selected:id,select:next=>{if(next)actions.selectRole(next);else close()}}),taskSaved:task=>mergeSavedTasks([task])}} visible={state.view==='messages'&&state.messageMode==='groups'} panel={groupPanelPort} target={state.groupTarget} profileName={profile.displayName} roles={tasks.roles.filter(role=>role.storage==='persistent')} persistence={{templateMaterials:teamMaterials,...(groupChannels?{channels:groupChannels}:{}),preferences:navigationStorage,api:groupApi,attachments:groupAttachmentApi,reactions:groupReactionApi,routing:groupRoutingApi,directory:{teamCreated:requestTeamMaterials,templateMaterialsRequest:teamMaterialsRequest,templateMaterialsHandled:()=>setTeamMaterialsRequest(undefined),refresh:conversationGroups.refresh,open:openDirectoryColumn,select:openSavedGroup,createScope:groupCreateScope,createTeam:groupCreateTeam,createRequest:groupCreateRequest,createHandled:()=>setGroupCreateRequest(0)}}}/>
          <div className={clsx(css.objectHost,taskEmbedded&&css.objectPanel)}>{taskEmbedded&&panelHeader}
          {renderTaskPage({embedded:taskEmbedded,visible:taskEmbedded||state.view==='attention'||state.view==='tasks',selected:taskEmbedded?detailTask!.id:state.taskId,select:id=>{if(taskEmbedded&&!id)closeObjectPanel();else actions.selectTask(id)},navigation:{state:state.navigationDirectories.tasks??{},change:patch=>actions.rememberDirectory('tasks',patch)}})}
          </div>
          <div className={clsx(css.objectHost,roleEmbedded&&css.objectPanel)}>{roleEmbedded&&panelHeader}
          {renderTeamPage({embedded:roleEmbedded,visible:roleEmbedded||state.view==='team',selected:roleEmbedded?detailRole!.id:state.roleId,select:id=>{setTeamFocusScope(null);if(roleEmbedded&&!id)closeObjectPanel();else actions.selectRole(id)},navigation:{state:state.navigationDirectories.team??{},change:patch=>actions.rememberDirectory('team',patch)}})}
          </div>
          <div className={clsx(css.objectHost,businessEmbedded&&css.objectPanel)}>{businessEmbedded&&panelHeader}
          {businessLedgerHome&&<BusinessHome labels={scopeLabels} directory={{status:businessDirectoryStatus,...(businessDirectoryError?{error:businessDirectoryError}:{}),retry:()=>{void loadBusinessDirectory().catch(()=>{})}}} roles={tasks.roles} dataSources={industryDataSources} loads={savedIndustryLoads} plans={businessCompositionPlans} goComposition={openComposition} attention={attentionItems} tasks={tasks.tasks} open={openBusinessScope} openStaff={openStaffOfScope} connect={scope=>actions.openIndustryResources({scope})} creationReady={!businessBuilder||businessReady} addBusiness={()=>requestCreation({builder:true})} market={()=>openMarketCategory('home')} builderDirectory={<>{builderError&&<p role="alert">{builderError}</p>}{!!builderState.error&&<p role="alert">{t('business.builder.error')} <button type="button" onClick={()=>void businessBuilder?.retry()}>{t('common.retry')}</button></p>}{builderFlow&&<BusinessBuilderDirectory flow={builderFlow} ready={businessReady} recover={recoverBuilder} open={continueBuilder}/>}</>}/>}
          {renderBusinessPage({embedded:businessEmbedded,visible:businessPageVisible({embedded:businessEmbedded,view:state.view,ledgerHome:businessLedgerHome}),target:businessEmbedded?businessPanel!:state.businessTarget,entry:businessEntry,navigation:{state:state.navigationDirectories.spaces??{},change:patch=>actions.rememberDirectory('spaces',patch)}})}
          </div>
          {state.view==='projects'&&<ProjectOverviewPage api={projectApi} scopeLabels={scopeLabels} labelsReady={businessDirectoryStatus!=='loading'} scopeName={scope=>localizedScopeNames[scope]??scope} navigation={{state:state.navigationDirectories.projects??{},change:patch=>actions.rememberDirectory('projects',patch)}} open={project=>enterBusiness({scope:project.scope as CollaborationScope,section:'projects',id:project.id})} create={scope=>scope?enterBusiness({scope:scope as CollaborationScope,section:'projects'}):actions.navigate('spaces')} visible={state.view==='projects'}/>}
          {renderContinuousPage(state.view==='plans',state.continuousTarget,actions.openPlans)}
          <div className={css.capabilityCenter} hidden={state.view!=='market'}>
          <MarketPage inCapabilityCenter refreshScopes={loadBusinessDirectory} dashboardResources={dashboardResources} colorScheme={state.colorScheme} openBusiness={openBusinessScope} key={marketConfigurationKey} {...(marketMcpConnectionApi?{managedMcpConnectionApi:marketMcpConnectionApi}:{})} {...(returnOrigin&&catalogEntryRequest?{catalogEntryRequest}:{})} localRetrievalApi={localRetrievalApi} manageIndustryLoad={loadId=>actions.openIndustryResources({loadId})} navigationState={{...marketEntryNavigation,query:state.navigationDirectories.market?.query??'',selectedId:state.navigationDirectories.market?.selectedId}} onNavigationChange={next=>actions.rememberDirectory('market',{query:next.query,category:writeDirectoryFilterCategory({category:next.category,mobileLayer:next.mobileLayer,appsMine:String(next.appsMine??false),appsCategory:next.appsCategory??'all'}),selectedId:next.selectedId})} onCatalogReady={availableIds=>{if(!restorePending.current.market||state.marketMode!=='catalog')return;restorePending.current.market=false;if(!state.marketItemId||availableIds.includes(state.marketItemId))return;const restored=reconcileAvailableDirectoryTarget({id:state.marketItemId},availableIds,state.detail,'market');actions.reconcileDirectory('market',restored.id,restored.detail)}} marketCatalogApi={marketCatalogApi} skillSecretsApi={skillSecretsApi} githubSourceApi={githubSourceApi} skillUpgradeApi={skillUpgradeApi} skillAvailabilityApi={skillAvailabilityApi} skillInstallApi={skillInstallApi} marketPluginInstallApi={marketPluginInstallApi} openLocalRetrieval={()=>{actions.rememberDirectory('resources',{category:writeDirectoryFilterCategory({category:'all',mobileLayer:'directory',libraryView:'local'})});actions.navigate('resources')}} contentApi={marketContentApi} industryReview={{loads:savedIndustryLoads,upgrade:upgradeIndustryLoad,rolesReady:industryRoleDirectory==='ready',rolesFailed:industryRoleDirectory==='failed',refreshRoles:()=>{void loadIndustryRoles().catch(()=>{})},context:{industryRoles,tasks:tasks.tasks.filter(task=>task.storage==='persistent'),plans:tasks.continuous.plans},open:(kind,id)=>{if(kind==='role')actions.previewRole(id);else if(kind==='task')actions.openTask(id);else actions.openPlans({kind:'plan',id})}}} {...(businessSpace?{space:businessSpace}:{})} saveResolved={item=>{const current=marketRef.current;changeMarket({...current,items:mergeMarketItems(current.items,[item])});actions.openMarket(item.id)}} spaces={scopeLabels} industryLoads={{api:industryLoadApi,loads:savedIndustryLoads,error:industryLoadError,save:async(input:IndustryLoadCreateInput)=>{try{const row=await industryLoadApi.create(input);industryLoadGeneration.current++;mergeIndustryLoad(row);void loadBusinessDirectory().catch(()=>{});void loadIndustryLoads().catch(()=>{});actions.openIndustryResources({loadId:row.id})}finally{refreshIndustryLoadState(value=>value+1)}},recover:async()=>{try{const row=await industryLoadApi.recover();industryLoadGeneration.current++;mergeIndustryLoad(row);void loadBusinessDirectory().catch(()=>{});void loadIndustryLoads().catch(()=>{});actions.openIndustryResources({loadId:row.id})}finally{refreshIndustryLoadState(value=>value+1)}}}} planFromTemplate={item=>{const source=findMarketItem(marketRef.current.items,item.id);if(!source)throw Error(t('frame.p5.templateMissing'));const template=planTemplate(source);actions.preparePlan({template,...(template.example?{}:{source:fixedPlanSource(template,source)}),fields:templatePlanFields(template,localizedScopeNames)})}} {...(pendingMarketCategory?{forceCategory:pendingMarketCategory}:{})} onForceCategoryHandled={completeMarketCategory} installations={{visible:state.marketMode==='installations',selected:state.installationId,open:actions.openInstallations,market:actions.openMarket}} industryResources={state.marketMode==='industry-resources'&&industryResourceFilter?industryResources(industryResourceFilter):undefined} visible={state.view==='market'} state={market} itemId={state.marketItemId} intentId={state.marketIntentId} open={actions.openMarket} change={changeMarket} update={updateIntent} prepare={prepareMarket} capabilities={()=>actions.openCapabilityCatalog()} mine={{skillInstallApi:skillInstallApi,pluginDirectory:{loading:industryPluginLoading,error:industryPluginError,partial:industryPluginPartial},runtimeExtensions:runtimeExtensions,resolveExtensionText:resolveExtensionText,plugins:industryPlugins,refreshPlugins:loadIndustryPlugins,configureIndustryResource:target=>actions.openIndustryResources(target),industryLoadsReady:industryLoadDirectory==='ready',navigationState:{...capabilityNavigation,query:state.navigationDirectories.capabilities?.query??'',selectedId:state.navigationDirectories.capabilities?.selectedId},onNavigationChange:next=>actions.rememberDirectory('capabilities',{query:next.query,category:writeDirectoryFilterCategory({category:next.category,mobileLayer:next.mobileLayer}),selectedId:next.selectedId}),industryLoads:savedIndustryLoads,openConversation:()=>actions.navigate('messages'),work:work,nativeSettings:openNativePlugins,pageCreate:{api:pageCreateApi,prepare:prompt=>preparePageCreation(prompt),confirmSkill:confirmPageCreateSkill,openSkill:openConfirmedPageCreateSkill,marketPluginInstallApi:marketPluginInstallApi,openExtensionMarket:()=>openMarketCategory('plugin')},businessNames:localizedScopeNames,go:openComposition}} nativeSettings={openNativePlugins} nativeModels={openNativeModels} {...(openLocalModels?{openLocalModels}:{})} openLocalModel={openNativePlugins} openRole={roleId=>{actions.previewRole(roleId);void loadRoles()}} seed={state.templateSeed} clearSeed={actions.clearTemplateSeed} configureBinding={configureBinding} targets={targets} openTarget={openTarget}/>
          </div>
          <ResourceManager preferenceStorage={navigationStorage} onUseResource={resource=>requestCreation({goal:t('library.prepare',{name:resource.title}),scope:(resource.scopeIds.includes('general')?'general':resource.scopeIds[0]) as CollaborationScope,resources:[{id:resource.id,version:resource.version,title:resource.title}]})} bundledExtensionsApi={bundledExtensionsApi} localRetrievalApi={localRetrievalApi} navigationState={{...resourceNavigation,query:state.navigationDirectories.resources?.query??'',selectedId:state.navigationDirectories.resources?.selectedId}} onNavigationChange={next=>actions.rememberDirectory('resources',{query:next.query,category:writeDirectoryFilterCategory({category:next.category,mobileLayer:next.mobileLayer,libraryView:next.libraryView,browseNodeId:next.browseNodeId??''}),selectedId:next.selectedId})} api={resourceApi} visible={state.view==='resources'} selectedDraftId={state.resourceDraftId} targetResource={state.resourceTarget} clearTarget={actions.clearResourceTarget} openConversation={request=>requestCreation({goal:request.goal,scope:request.scope as CollaborationScope})}/>

        </main>
        <div id={DETAILS_TRACK_ID} role="region" hidden={!conversationVisible&&!artifactRailShown||builderVisible} className={clsx(css.details,artifactRailShown&&css.artifactDetails)} style={{['--teloa-details-width' as string]:detailsWidth+'px'}} aria-label={t('frame.nativeToolDetailsAria')}>
          {railShown&&detailsHandleVisible&&<button type="button" className={css.detailsHandle} role="separator" aria-orientation="vertical" aria-controls={DETAILS_TRACK_ID} aria-valuenow={detailsWidth} aria-valuemin={detailsRange.min} aria-valuemax={detailsRange.max} aria-label={t('rightbar.resize.aria')} title={t('rightbar.resize.title')} onPointerDown={dragDetails} onKeyDown={stepDetails} onDoubleClick={restoreDetailsWidth}/>}
          <div className={css.nativeRail} hidden={artifactFallbackShown}>{renderSlot('rightbar',{width:detailsWidth,viewportWidth,canShow:detailsCanShow})}</div>
          <div ref={setArtifactRailMount} className={css.artifactMount} hidden={!artifactFallbackShown}/>
        </div>
        <ArtifactPanel revisionIdentity={artifactRevisionConnection.current} requestRevision={requestArtifactRevision} methodReuseIdentity={artifactMethodReuseConnection.current} requestMethodReuse={requestArtifactMethodReuse} messageAuthor={artifactTarget?.source.kind==='session'&&artifactTarget.source.id===current?contextRole?.name:undefined} inline portal={conversationArtifactMount??artifactRailMount} open={artifactOpen} taskSources={taskArtifactSources} taskRuns={taskRunApi} recovery={{message:artifactApi.recoveryMessage(),pending:()=>artifactTarget&&(artifactTarget.source.kind==='session'||artifactTarget.source.kind==='task')?artifactApi.pendingFor(artifactTarget.source.id,artifactTarget.source.kind):[],resume:async key=>{const saved=await artifactApi.recover(key);mergeArtifacts([saved]);return {id:saved.id,version:saved.versions.at(-1)!.number}}}} loadError={artifactLoadError} artifactFileApi={artifactFileApi} nativeArtifacts={nativeArtifacts} target={artifactTarget} state={tasks} conversation={artifactConversation} close={closeArtifacts} change={saveArtifactCommand} openSource={openArtifactSource} openTask={actions.openTask}/>
      </div>
    </div>
    {homeCreation==='task'&&<TaskForm persistent groups={savedGroupOptions} onDraft={draft=>setHomeTaskDrafts(current=>({...current,[homeTaskDraftKey]:draft}))} initial={taskApi.pendingFields()??homeTaskDrafts[homeTaskDraftKey]??(homeTaskGroupId?{title:'',goal:'',scope:savedGroupOptions.find(group=>group.id===homeTaskGroupId)?.scope??'general',skills:[],groupId:homeTaskGroupId}:undefined)} close={()=>setHomeCreation(null)} save={async value=>{const id=await createSavedTask(value);setHomeTaskDrafts(current=>{const next={...current};delete next[homeTaskDraftKey];return next});setHomeCreation(null);actions.openTask(id)}}/>}
    {homeCreation==='group'&&<GroupForm people={rolePeople(tasks.roles.filter(role=>role.storage==='persistent'),t)} profileName={profile.displayName} error={homeCreationError} group={undefined} rules={{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}} close={()=>setHomeCreation(null)} save={value=>{void saveHomeGroup(value)}}/>}
    {homeCreation==='role'&&<RoleForm work={work} resourceApi={resourceApi} runtimeConfigs={runtimeConfigApi} initial={pendingRoleFields()??homeRoleDraft} onDraft={setHomeRoleDraft} persistent close={()=>setHomeCreation(null)} save={async fields=>{const id=await createSavedRole(fields);setHomeRoleDraft(undefined);setHomeCreation(null);actions.openRole(id)}}/>}
    {builderSwitch&&<BusinessBuilderSwitchDialog switching={builderSwitch.switching} stay={()=>{setBuilderSwitch(undefined);setCreationIntent(null)}} create={()=>{const intent=builderSwitch;setBuilderSwitch(undefined);try{businessBuilder!.approveNavigation(intent.token);intent.proceed()}catch(error){setBuilderError(localizeWorkError(locale,error))}}}/>}
    {roleScopeIntent&&<ConversationScopeDialog options={roleScopeIntent.scopes.map(id=>({id,label:localizedScopeNames[id]??id}))} name={roleScopeIntent.object.title} close={()=>setRoleScopeIntent(null)} select={scope=>{const intent=roleScopeIntent;setRoleScopeIntent(null);requestCreation({object:intent.object,scope,...(intent.goal?{goal:intent.goal}:{})})}}/>}
    {creationIntent&&workspaceSelection&&<CreateConversationDialog management={management} current={current} initialWorkspaceId={work.getPendingCreation()?.workspaceId??assistantRecovery?.workspaceId} pendingRequestId={assistantRecovery?undefined:work.getPendingCreation()?.requestId} restart={requestId=>work.releaseCreationForNewWork(requestId)} locked={!!work.getPendingCreation()||!!assistantRecovery} busy={creating} goal={creationIntent.goal} notice={creationIntent.notice} initialError={creationError} mode={creationMode} create={async workspaceId=>{if(creationMode==='chooseWorkspace')await changeCreationLocation(workspaceId);else await createWork(workspaceId,creationIntent)}} close={closeCreation} settings={()=>{closeCreation();actions.openDirectory()}}/>}
    <TemplateShareReceive createTeam={createIndustryTeam} openGroup={openSavedGroup} open={templateReceiveOpen} close={()=>setTemplateReceiveOpen(false)} intent={templateIntent} bridge={templateShareBridge} accept={(pkg,choice,intent)=>templateAcceptance.accept(pkg,choice,intent)} savedChoice={pkg=>templateAcceptance.choice(pkg)} openRole={actions.previewRole} configure={loadId=>actions.openIndustryResources({loadId})} openSkill={()=>actions.openCapabilityCatalog()} openConnections={()=>actions.openMarket()} targets={scopeLabels.map(label=>({scope:label.scope,title:label.title}))}/>
    {planDraftOpenError?.connection===planDraftConnection&&<p role="alert">{planDraftOpenError.message}</p>}
    {attentionOriginalSource&&<WorkAttentionSourceView creationIdentity={attentionOriginalSource.kind==='page-create-draft'&&attentionOriginalSource.entity==='plan'?planDraftConnection:undefined} source={attentionOriginalSource} businessWork={attentionBusinessApi} businessDashboard={businessDashboardApi} pageCreate={pageCreateApi} {...(attentionCreation(attentionOriginalSource)?{creation:attentionCreation(attentionOriginalSource)!}:{})} close={()=>{const key=JSON.stringify(attentionOriginalSource);setAttentionSourceSelection(current=>current?.identity===attentionIdentity&&JSON.stringify(current.source)===key?undefined:current)}} changed={()=>{void workAttention.reload()}}/>}
    {shareDraft&&<ShareDraftDrawer pkg={shareDraft} open close={()=>setShareDraft(undefined)}/>}
    <div className={css.overlay} data-shell-overlay>{renderSlot('shell.overlay',{})}</div>
  </div></ApprovalNotesProvider></TemplateShareProvider></BusinessScopeProvider></PageCreateRevisionContext.Provider>
}
