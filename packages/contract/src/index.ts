export * from './tasks.ts'
export * from './projects.ts'
export * from './task-runs.ts'
export * from './business-data.ts'
export * from './business-spaces.ts'
export * from './business-scopes.ts'
export * from './roles.ts'
export * from './model-policy.ts'
export * from './collaboration.ts'
export * from './group-attachments.ts'
export * from './group-reactions.ts'
export * from './group-routing.ts'
export * from './web-access.ts'
export * from './resource-history.ts'
export * from './artifact-files.ts'
export * from './resources.ts'
export * from './task-materials.ts'
export * from './task-handoffs.ts'
export * from './knowledge.ts'
export * from './conversation-changes.ts'
export * from './session-capabilities.ts'
export * from './resource-recovery.ts'
export * from './work-error.ts'
export * from './security-actions.ts'
export * from './industry-definitions.ts'
export * from './business-definitions.ts'
export * from './role-conversation-prompt.ts'
export * from './business-views-v2.ts'
export {businessObjectTypeFormatV2,businessObjectTypeV2LegacyShape,readBusinessObjectTypeDefinitionV2,readBusinessObjectTypeDefinitionVersioned,type BusinessObjectTypeDefinitionV2} from './business-definitions-v2.ts'
export * from './business-rich-fields.ts'
export * from './business-record-constraints.ts'
export * from './industry-update-compare.ts'
import { isWorkResource,type WorkResource } from './resources.ts'

export type Conversation = {
  id: string
  ownerId: string
  title: string
  scopeIds: ['general']
  version: 1
  status: 'pending' | 'ready' | 'failed'
  requestedSessionId: string
  sessionId: string
  createdAt: string
  requestId?: string
  /** 创建时固定的工作区；不是当前归属，旧记录可缺省。 */
  requestedWorkspaceId?: string
  /** 服务端运行编排用途；普通会话缺省。 */
  purpose?: 'task-run'
  /** 运行专用预约首次派生后固定，客户端不得提交或改写。 */
  run?: {taskId:string;taskVersion:number;roleId:string;roleVersion:number;agentPresetId:string}
}

export type CapabilitySnapshot = {
  schema: 'teloa.capabilities/v1'
  conversation: Conversation
  observedAt: string
  skills: {name:string;description:string;source:string;provider:string;modelInvocable:boolean;userInvocable:boolean}[]
  knowledge: {status:'not-connected'} | {status:'ready';resources:WorkResource[]} | {status:'unavailable';message:string}
  connections: {status:'not-connected'} | {status:'observed';tools:{name:string;description:string}[]}
  writes: {status:'not-implemented'} | {status:'draft-only'}
}

const record=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v)
export function isConversation(value:unknown):value is Conversation {
  if(!record(value))return false
  if(value.requestedWorkspaceId!==undefined&&!id(value.requestedWorkspaceId))return false
  if(value.requestId!==undefined&&(typeof value.requestId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.requestId)))return false
  const run=value.run
  const validRun=record(run)&&id(run.taskId)&&Number.isSafeInteger(run.taskVersion)&&Number(run.taskVersion)>0&&id(run.roleId)&&Number.isSafeInteger(run.roleVersion)&&Number(run.roleVersion)>0&&typeof run.agentPresetId==='string'&&/^[a-z0-9][-a-z0-9]{0,119}$/.test(run.agentPresetId)
  if(value.purpose==='task-run'?!validRun||value.requestId===undefined||value.requestedSessionId!==value.sessionId:value.purpose!==undefined||value.run!==undefined||value.status==='failed')return false
  return id(value.id)&&id(value.sessionId)&&id(value.requestedSessionId)&&typeof value.ownerId==='string'&&value.ownerId.length>0&&typeof value.title==='string'&&value.title.trim().length>0&&value.title.length<=200&&Array.isArray(value.scopeIds)&&value.scopeIds.length===1&&value.scopeIds[0]==='general'&&value.version===1&&['ready','pending','failed'].includes(String(value.status))&&typeof value.createdAt==='string'&&Number.isFinite(Date.parse(value.createdAt))
}
export function isCapabilitySnapshot(value:unknown):value is CapabilitySnapshot {
  if(!record(value)||value.schema!=='teloa.capabilities/v1'||!isConversation(value.conversation)||typeof value.observedAt!=='string'||!Number.isFinite(Date.parse(value.observedAt))||!Array.isArray(value.skills))return false
  const connections=value.connections
  const validConnections=record(connections)&&(connections.status==='not-connected'||(connections.status==='observed'&&Array.isArray(connections.tools)&&connections.tools.every(tool=>record(tool)&&typeof tool.name==='string'&&/^mcp__[A-Za-z0-9_-]+__.+$/.test(tool.name)&&typeof tool.description==='string')))
  const knowledge=value.knowledge
  const validKnowledge=record(knowledge)&&(knowledge.status==='not-connected'||(knowledge.status==='unavailable'&&typeof knowledge.message==='string')||(knowledge.status==='ready'&&Array.isArray(knowledge.resources)&&knowledge.resources.every(isWorkResource)))
  return isSkillCatalog(value.skills)&&validKnowledge&&validConnections&&record(value.writes)&&['not-implemented','draft-only'].includes(String(value.writes.status))
}

export * from './artifacts.ts'
export function isSkillCatalog(value:unknown):value is CapabilitySnapshot['skills']{
 return Array.isArray(value)&&value.every(skill=>record(skill)&&['name','description','source','provider'].every(k=>typeof skill[k]==='string')&&typeof skill.modelInvocable==='boolean'&&typeof skill.userInvocable==='boolean')
}

export * from './artifact-messages.ts'

export {readTaskToolArgumentRules,taskToolArgumentsAllowed,type TaskToolArgumentRule} from './task-tool-arguments.ts'

export {readScheduleTrigger,nextScheduleOccurrence,scheduleTimezones,type ScheduleTrigger} from './plan-schedule.ts'
export * from './work-flows.ts'
export * from './role-memory.ts'
export * from './role-daily-log.ts'
export * from './localized-metadata.ts'
export * from './market-plugin-installation.ts'
export * from './market-catalog.ts'
export * from './market-index.ts'
export * from './semver-range.ts'
export * from './market-index-signature.ts'
export * from './evidence.ts'
export * from './page-create.ts'
export * from './business-field-parse.ts'
export * from './business-sync-schedule.ts'
export * from './business-source-mapping.ts'
export * from './business-chart-spec.ts'
export * from './business-dashboards.ts'

export * from './pending-requests.ts'
export * from './usage-stats.ts'
export * from './market-reviews.ts'
export * from './im-channels.ts'
export * from './secret-shape.ts'
export * from './bundled-extensions.ts'
export * from './local-models.ts'
export * from './model-options.ts'
export * from './industry-model-dependencies.ts'
export * from './local-retrieval.ts'
export * from './retrieval-preparation.ts'

export * from './business-runtime.ts'
export * from './business-configuration.ts'
export * from './business-configuration-v2.ts'
export * from './business-dashboard-resource.ts'
export * from './business-records.ts'

export * from './business-conversations.ts'

export * from './business-configuration-page.ts'
export {readBusinessResponsibilityRead,readBusinessResponsibilitySet,readBusinessResponsibility,type BusinessResponsibilityRead,type BusinessResponsibilitySet,type BusinessResponsibility} from './business-responsibility.ts'
export * from './business-reassignment.ts'
export * from './business-record-import.ts'

export {
 readBusinessImportSheetV2,
 readBusinessImportSourceV2,
 readBusinessImportPolicyV2,
 readBusinessImportCellV2,
 readBusinessImportRowV2,
 readBusinessImportTableV2,
 readBusinessImportMappingV2,
 readBusinessImportWorkbookInputV2,
 readBusinessImportWorkbookV2,
 readBusinessImportStageInputV2,
 readBusinessImportInspectInputV2,
 readBusinessImportPreviewInputV2,
 readBusinessImportInspectionV2,
 readBusinessImportPreviewV2,
 readBusinessImportReceiptV2,
 readBusinessImportDraftV2,
 readBusinessImportAnyDraft,
 readBusinessImportAnyReceipt,
 readBusinessImportAnyInspection,
 readBusinessImportAnyStageInput,
 readBusinessImportAnyInspectInput,
 readBusinessImportAnyPreviewInput,
 readBusinessImportAnyStageReceiptResponse,
 readBusinessImportAnyReceiptResponse
} from './business-record-import-xlsx.ts'
export type {
 BusinessImportSheetV2,
 BusinessImportSourceV2,
 BusinessImportPolicyV2,
 BusinessImportCellV2,
 BusinessImportRowV2,
 BusinessImportTableV2,
 BusinessImportMappingV2,
 BusinessImportWorkbookInputV2,
 BusinessImportWorkbookV2,
 BusinessImportStageInputV2,
 BusinessImportInspectInputV2,
 BusinessImportPreviewInputV2,
 BusinessImportInspectionV2,
 BusinessImportPreviewV2,
 BusinessImportReceiptV2,
 BusinessImportDraftV2,
 BusinessImportXlsxPort,
 BusinessImportAnyDraft,
 BusinessImportAnyReceipt,
 BusinessImportAnyInspection,
 BusinessImportAnyStageInput,
 BusinessImportAnyInspectInput,
 BusinessImportAnyPreviewInput
} from './business-record-import-xlsx.ts'
export {productEventNames,sanitizeProductEvent,type ProductEventName,type ProductAnalyticsEvent} from './product-analytics.ts'
