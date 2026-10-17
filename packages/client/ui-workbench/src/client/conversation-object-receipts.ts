import {conversationProjectToolNames,conversationProjectReceipt} from './conversation-project-receipts.js'
import {conversationTaskConfigurationToolNames,conversationTaskConfigurationReceipt} from './conversation-task-configuration-receipts.js'
import {isBusinessScopeKey,isGroup,isKnowledgeItem,isKnowledgeVersionSummary,isKnowledgeTreeMutation,isWorkResource,isResourceDraft,pageCreateEntities,type PageCreateDraft} from '@teloa/contract'
import {readSavedRole} from './role-api.ts'
import {readPageCreateDraft} from './page-create-api.ts'
import {readPageCreateAtomicSkillBody} from './page-create-skill-content.ts'
import {readManagedMcpConnectionRecord} from './mcp-connections-api.ts'
import type {ConversationPlanEvents} from './conversation-plans.ts'
import {createSkillInstallApi,type SkillInstallationRecord} from './skill-install-api.ts'
import {createSkillAvailabilityApi,type SkillAvailability} from './skill-availability-api.ts'
import {createIndustryLoadApi,type IndustryLoadRecord} from './industry-load-api.ts'

export const conversationObjectToolNames=[...conversationProjectToolNames,...conversationTaskConfigurationToolNames,'teloa_employees_create','teloa_employees_profile','teloa_employees_update','teloa_employees_lifecycle','teloa_groups_create','teloa_groups_change','teloa_group_work_change','teloa_group_resources_save','teloa_group_resources_withdraw','teloa_create_draft','teloa_create_revise','teloa_method_reuse','teloa_create_drafts','teloa_create_preview','teloa_create_apply','teloa_mcp_save','teloa_mcp_connection_connect','teloa_mcp_disconnect','teloa_mcp_update','teloa_resources_create','teloa_resources_update','teloa_library_create_folder','teloa_library_rename','teloa_library_move','teloa_library_save','teloa_library_apply','teloa_library_withdraw','teloa_library_revise','teloa_library_restore','teloa_skill_get','teloa_skill_edit','teloa_skill_availability_preview','teloa_skill_availability_change','teloa_skill_selection_get','teloa_skill_selection_change','teloa_extensions_set','teloa_role_tools_get','teloa_role_tools_change','teloa_group_agent_grant_get','teloa_group_agent_grant_change','teloa_connector_instances_get','teloa_connector_instances_authorize','teloa_connector_probe'] as const
export type ConversationObjectReceipt={kind:'project'|'task'|'role'|'group'|'draft'|'mcp'|'knowledge'|'knowledge-node'|'work-resource'|'work-resource-draft'|'skill'|'extension'|'connector';id:string;title:string;revision:string;scope?:string;connectorKind?:'data-source'|'execution-tool'|'mcp';skillSource?:{resourceId:string;contentId:string;nativeName:string};draftReference?:Pick<PageCreateDraft,'entity'|'status'>}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const owner='local:teloa-owner'
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
function knowledgeMetadata(value:unknown){
 if(!record(value)||!isKnowledgeItem(value.item)||!isKnowledgeVersionSummary(value.version))return
 const {item,version}=value
 if(version.knowledgeId!==item.id||version.ownerId!==item.ownerId||version.sourceId!==item.sourceId||version.sourceType!==item.sourceType||version.version!==item.currentVersion)return
 return {item,version}
}
export type ConversationSkillResult={schema:'teloa.skill-result/v1';sessionId:string;operation:'get'|'edit';skill:{id:string;nativeName:string;ownerId:string;installationId:string;contentId:string;title:string;description:string;version:string;state:'saved'|'enabled'|'disabled';availability:'enabled'|'disabled';selected:boolean;private:true};body:string;selection:{installationId:string;version:number};expectedBundleHash:string}
/** 只接受真实服务的本人技能快照；保存新版不等于已选定或启用。 */
export function readConversationSkillResult(value:unknown):ConversationSkillResult{
 if(!record(value)||value.schema!=='teloa.skill-result/v1'||typeof value.sessionId!=='string'||!['get','edit'].includes(String(value.operation))||!record(value.skill)||!record(value.selection)||!uuid(value.selection.installationId)||!Number.isSafeInteger(value.selection.version)||Number(value.selection.version)<1||typeof value.expectedBundleHash!=='string'||!/^[a-f0-9]{64}$/.test(value.expectedBundleHash)||typeof value.body!=='string'||new TextEncoder().encode(value.body).length>2*1024*1024)throw Error('技能详情回包格式不正确。')
 const skill=value.skill
 if(skill.ownerId!==owner||!uuid(skill.installationId)||!uuid(skill.contentId)||typeof skill.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(skill.id)||typeof skill.nativeName!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.nativeName)||typeof skill.title!=='string'||!skill.title.trim()||typeof skill.description!=='string'||!skill.description.trim()||typeof skill.version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(skill.version)||!['enabled','disabled'].includes(String(skill.availability))||typeof skill.selected!=='boolean'||skill.selected!==(value.selection.installationId===skill.installationId)||skill.state!==(skill.selected?skill.availability:'saved')||skill.private!==true)throw Error('技能详情的身份或状态不一致。')
 return value as unknown as ConversationSkillResult
}
export type ConversationIndustrySkillDetail={kind:'industry';installation:SkillInstallationRecord&{source:Exclude<SkillInstallationRecord['source'],{kind:'atomic'}>};load:IndustryLoadRecord;availability:SkillAvailability;selection:{ownerId:string;nativeName:string;installationId:string;version:number;updatedAt:string};skill:{installationId:string;contentId:string;id:string;nativeName:string;title:string;description:string;version:string;state:'saved'|'enabled'|'disabled'}}
/** 行业技能只读原安装及固定方案；不走原子技能正文编辑接口。 */
export async function readConversationIndustrySkillDetail(value:unknown):Promise<ConversationIndustrySkillDetail>{
 if(!record(value)||value.kind!=='industry'||!record(value.installation)||!uuid(value.installation.id)||!record(value.load)||!record(value.selection))throw Error('行业技能详情格式不正确。')
 const installation=await createSkillInstallApi(async()=>value.installation).get(value.installation.id),source=installation.source
 if(installation.ownerId!==owner||installation.state!=='installed'||source.kind==='atomic')throw Error('行业技能安装身份不一致。')
 const load=await createIndustryLoadApi(async()=>value.load).get(source.loadId),availability=await createSkillAvailabilityApi(async()=>value.availability).get(installation.id),selection=value.selection
 if(selection.ownerId!==owner||selection.nativeName!==installation.native.name||!uuid(selection.installationId)||!Number.isSafeInteger(selection.version)||Number(selection.version)<1||typeof selection.updatedAt!=='string'||new Date(selection.updatedAt).toISOString()!==selection.updatedAt||Object.keys(selection).some(key=>!['ownerId','nativeName','installationId','version','updatedAt'].includes(key)))throw Error('行业技能选择身份不一致。')
 const item=load.items.find(row=>row.instanceId===source.itemInstanceId)
 if(load.ownerId!==owner||availability.ownerId!==owner||load.contentId!==source.contentId||load.contentHash!==source.contentHash||load.scope!==load.space.scope||!item||item.kind!=='skill'||item.localId!==source.resourceId||item.version!==source.resourceVersion)throw Error('行业技能与原方案的归属、范围或固定版本不一致。')
 const state=selection.installationId===installation.id?availability.availability:'saved'
 return {kind:'industry',installation:{...installation,source},load,availability,selection:selection as ConversationIndustrySkillDetail['selection'],skill:{installationId:installation.id,contentId:source.contentId,id:source.resourceId,nativeName:installation.native.name,title:item.title,description:installation.native.description,version:source.resourceVersion,state}}
}
export function conversationObjectReceipt(value:unknown,sessionId?:string):ConversationObjectReceipt|undefined{
 try{
  if(!record(value))return
  if(sessionId!==undefined&&typeof value.sessionId==='string'&&value.sessionId!==sessionId)return
  if(value.schema==='teloa.page-create-draft-read/v1'){
   const keys=['schema','ownerId','sessionId','draft','readAt','next']
   if(Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key))||value.ownerId!==owner||typeof value.sessionId!=='string'||!value.sessionId||typeof value.readAt!=='string'||new Date(value.readAt).toISOString()!==value.readAt||!record(value.next)||Object.keys(value.next).length!==2||value.next.kind!=='open-original')return
   const draft=readPageCreateDraft(value.draft,{skill:readPageCreateAtomicSkillBody})
   if(draft.ownerId!==owner||value.next.title!==draft.title)return
   return {kind:'draft',id:draft.id,title:draft.title,revision:draft.updatedAt+':'+draft.status,...(draft.scope===undefined?{}:{scope:draft.scope})}
  }
  if(value.schema==='teloa.page-create-draft-reference/v1'){
   // 仅接受本人正式检索的单一原稿引用；不能从助手文字、目录或正文猜入口。
   if(value.ownerId!==owner||typeof value.sessionId!=='string'||!value.sessionId||Object.keys(value).some(key=>!['schema','ownerId','sessionId','draft','next'].includes(key))||value.next!==undefined&&typeof value.next!=='string'||!record(value.draft))return
   const draft=value.draft,keys=['id','entity','title','status','bodyHash','createdAt','updatedAt'],optional=['scope','appliedRef']
   if(keys.some(key=>!Object.hasOwn(draft,key))||Object.keys(draft).some(key=>!keys.includes(key)&&!optional.includes(key))||!uuid(draft.id)||!(pageCreateEntities as readonly unknown[]).includes(draft.entity)||typeof draft.title!=='string'||!draft.title.trim()||draft.title!==draft.title.trim()||draft.title.length>240||typeof draft.bodyHash!=='string'||!/^[a-f0-9]{64}$/.test(draft.bodyHash)||!['draft','applied','discarded'].includes(String(draft.status)))return
   if(['business-definition','business-domain','connector'].includes(String(draft.entity))?(!isBusinessScopeKey(draft.scope)||draft.scope==='general'):draft.scope!==undefined)return
   if(typeof draft.createdAt!=='string'||new Date(draft.createdAt).toISOString()!==draft.createdAt||typeof draft.updatedAt!=='string'||new Date(draft.updatedAt).toISOString()!==draft.updatedAt||draft.updatedAt<draft.createdAt||(draft.status==='applied')!==(typeof draft.appliedRef==='string'&&!!draft.appliedRef.trim())||draft.status!=='applied'&&draft.appliedRef!==undefined)return
   return {kind:'draft',id:draft.id,title:draft.title,revision:draft.updatedAt+':'+draft.status,...(typeof draft.scope==='string'?{scope:draft.scope}:{}),draftReference:{entity:draft.entity as PageCreateDraft['entity'],status:draft.status as PageCreateDraft['status']}}
  }
  if(value.schema==='teloa.capability-result/v1'){
   const resource=value.resource
   if(typeof value.sessionId!=='string'||!value.sessionId||!(conversationObjectToolNames as readonly unknown[]).includes(value.operation)||!record(value.value)||!record(resource)||resource.ownerId!==owner||typeof resource.title!=='string'||!resource.title.trim()||typeof resource.state!=='string'||!resource.state||typeof resource.version!=='string'&&!(Number.isSafeInteger(resource.version)&&Number(resource.version)>0))return
   const revision=String(resource.version)+':'+resource.state
   if(resource.kind==='skill'&&String(value.operation).startsWith('teloa_skill_')){
    if(!uuid(resource.installationId)||!uuid(resource.contentId)||typeof resource.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(resource.id)||typeof resource.nativeName!=='string'||!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(resource.nativeName)||!['saved','enabled','disabled'].includes(resource.state))return
    return {kind:'skill',id:resource.installationId,title:resource.title,revision:resource.contentId+':'+revision,skillSource:{resourceId:resource.id,contentId:resource.contentId,nativeName:resource.nativeName}}
   }
   if(resource.kind==='role-tools'&&String(value.operation).startsWith('teloa_role_tools_')&&uuid(resource.id))return {kind:'role',id:resource.id,title:resource.title,revision}
   if(resource.kind==='group-agent-grant'&&String(value.operation).startsWith('teloa_group_agent_grant_')&&uuid(resource.id)&&resource.groupId===resource.id&&uuid(resource.roleId))return {kind:'group',id:resource.id,title:resource.title,revision}
   if(resource.kind==='extension'&&value.operation==='teloa_extensions_set'&&['im-gateway','local-embedding'].includes(String(resource.id))&&['available','enable-pending','active','failed','disable-pending'].includes(resource.state)&&value.value.id===resource.id&&value.value.version===resource.version&&value.value.state===resource.state)return {kind:'extension',id:String(resource.id),title:resource.title,revision}
   if(resource.kind==='connector'&&String(value.operation).startsWith('teloa_connector_')&&uuid(resource.id)&&['data-source','execution-tool','mcp'].includes(String(resource.connectorKind))&&['active','detached',resource.connectorKind==='mcp'?'needs_connection':'needs_authorization'].includes(resource.state))return {kind:'connector',id:resource.id,title:resource.title,revision,connectorKind:resource.connectorKind as NonNullable<ConversationObjectReceipt['connectorKind']>}
   return
  }
  if(value.schema==='teloa.skill-result/v1'){
   const result=readConversationSkillResult(value),skill=result.skill
   if(!result.sessionId)return
   return {kind:'skill',id:skill.installationId,title:skill.title,revision:skill.contentId+':'+skill.version+':'+skill.state}
  }
  if(value.schema==='teloa.library-result/v1'){
   if(value.ownerId!==owner||typeof value.sessionId!=='string'||!value.sessionId||value.sourceSession!==value.sessionId)return
   const revision=record(value.revision)?value.revision:undefined,knowledge=knowledgeMetadata(value.knowledge)??knowledgeMetadata(revision?.knowledge)
   if(revision&&(!knowledge||!isWorkResource(revision.resource)||revision.resource.ownerId!==knowledge.item.ownerId||revision.resource.status!=='active'||revision.resource.title!==knowledge.item.title||revision.resource.sourceId!=='knowledge_'+knowledge.item.id.toLowerCase()||revision.resource.sourceVersion!==knowledge.version.contentHash||JSON.stringify(revision.resource.scopeIds)!==JSON.stringify(knowledge.item.scopeIds)))return
   const canonical=value.kind==='knowledge'&&knowledge?{id:knowledge.item.id,title:knowledge.item.title,ownerId:knowledge.item.ownerId,version:knowledge.item.currentVersion,state:revision?'active':'saved',revision:knowledge.version.contentHash}:value.kind==='knowledge-node'&&isKnowledgeTreeMutation(value.mutation)?{id:value.mutation.node.id,title:value.mutation.node.title,ownerId:value.mutation.space.ownerId,version:value.mutation.space.directoryRevision,state:'active',revision:value.mutation.node.updatedAt}:value.kind==='work-resource-draft'&&isResourceDraft(value.draft)?{id:value.draft.id,title:value.draft.title,ownerId:value.draft.ownerId,version:value.draft.version,state:value.draft.status,revision:value.draft.updatedAt}:value.kind==='work-resource'&&isWorkResource(value.resource)?{id:value.resource.id,title:value.resource.title,ownerId:value.resource.ownerId,version:value.resource.version,state:value.resource.status,revision:value.resource.updatedAt}:undefined
   if(!canonical||canonical.ownerId!==owner||value.id!==canonical.id||value.title!==canonical.title||value.version!==canonical.version||value.state!==canonical.state)return
   return {kind:value.kind as ConversationObjectReceipt['kind'],id:canonical.id,title:canonical.title,revision:canonical.version+':'+canonical.revision+':'+canonical.state}
  }
  if(value.schema==='teloa.employee-result/v1'){
   const role=readSavedRole(value.role)
   if(role.ownerId!=='local:teloa-owner'||role.kind!=='employee')return
   return {kind:'role',id:role.id,title:role.name,revision:role.version+':'+role.updatedAt}
  }
  if(value.schema==='teloa.group-result/v1'&&isGroup(value.group)&&value.group.ownerId==='local:teloa-owner')return {kind:'group',id:value.group.id,title:value.group.name,revision:value.group.version+':'+value.group.updatedAt}
  if(value.schema==='teloa.mcp-result/v1'){
   const connection=readManagedMcpConnectionRecord(value.connection)
   return {kind:'mcp',id:connection.id,title:connection.serverName,revision:connection.updatedAt+':'+connection.status}
  }
  const project=conversationProjectReceipt(value,sessionId),task=conversationTaskConfigurationReceipt(value,sessionId)
  if(project)return project
  if(task)return task
  const candidate=value.schema==='teloa.page-create-draft-preview/v1'||value.schema==='teloa.capability-draft-result/v1'?value.draft:value
  const draft=readPageCreateDraft(candidate,{skill:readPageCreateAtomicSkillBody})
  if(draft.ownerId!=='local:teloa-owner')return
  return {kind:'draft',id:draft.id,title:draft.title,revision:draft.updatedAt+':'+draft.status}
 }catch{/* 损坏与非当前对象回执只保留原生工具详情，不产生入口。 */}
}

/** 只读取当前轮匹配工具调用的成功结果；同对象的多次修改显示最后一次回执。 */
export function conversationTurnObjectReceipts(entries:ConversationPlanEvents['entries'],turn?:number,sessionId?:string):ConversationObjectReceipt[]{
 const calls=new Set<string>(),objects=new Map<string,ConversationObjectReceipt>()
 for(const {event} of entries){
  if(!record(event.data)||turn!==undefined&&event.data.turn!==turn)continue
  const data=event.data
  if(event.type==='tool/call'&&(conversationObjectToolNames as readonly unknown[]).includes(data.name)&&typeof data.callId==='string')calls.add(data.callId)
  if(event.type!=='tool/result'||data.error||!record(data.message)||data.message.isError||typeof data.message.toolCallId!=='string'||!calls.has(data.message.toolCallId)||!Array.isArray(data.message.content))continue
  try{const result=conversationObjectReceipt(JSON.parse(data.message.content.filter(record).filter(item=>item.type==='text').map(item=>item.text).join('\n')),sessionId);if(result)objects.set(result.kind+':'+result.id,result)}catch{/* 不接受助手文字、未知工具及无法核验的工具结果。 */}
 }
 return [...objects.values()]
}
