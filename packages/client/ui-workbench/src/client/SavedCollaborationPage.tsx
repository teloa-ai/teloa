import {groupWorkResourceCandidates,type GroupWorkResourcePort} from './group-work-resources.js'
import type {WorkResource} from '@teloa/contract'
import {twinDraftCopy} from './i18n/locales/twin-drafts.js'
import markdownTypography from "./MarkdownTypography.module.css"
import {IndustryTeamMaterials} from './IndustryTeamMaterials.js'
import {mergeTeamMaterialReferences,type IndustryTeamMaterialsPort} from './industry-team-materials.js'
import type {IndustryTeamSeed} from './industry-team.ts'
import {CapabilityFields,CapabilityNotice,useApplicationCapability} from './CapabilityNotice.js'
import {applicationPresentation} from './application-presentation.js'
import {applyMarkdownCommand,type MarkdownCommand} from './knowledge-markdown-core.js'
import {ContextDrawer} from './ContextDrawer.js'
import {GroupAttachmentPreview} from './GroupAttachmentPreview.js'
import {GroupMaterialsPanel} from './GroupMaterialsPanel.js'
import {GroupResourcePreview} from './GroupResourcePreview.js'
import {GroupMessageBodyPreview} from './GroupMessageBodyPreview.js'
import type {GroupMessageBodySummary} from '@teloa/contract'
import {GroupMembersPanel} from './GroupMembersPanel.js'
import {GroupMentions} from './GroupMentions.js'
import memberCss from './GroupMembersPanel.module.css'
import {WorkArtifactCard} from './WorkArtifactCard.js'
import {GroupLinkedWork,isCompletedGroupReply} from './GroupLinkedWork.js'
import {GroupWorkResults,type GroupResultSummary} from './GroupWorkResults.js'
import {GroupArtifactPreview} from './GroupArtifactPreview.js'
import {groupHasSharedArtifactReference,groupSharedResults} from './group-result-index.js'
import type {GroupWorkLinkApi} from './group-work-links-api.js'
import type {GroupWorkLinkItem} from '@teloa/contract'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {TwinAvatar} from './TwinAvatar.js'
import {personalAvatarInitials} from './personal-profile.js'
import {Fragment,useEffect,useId,useMemo,useRef,useState,type Dispatch,type SetStateAction,type ReactNode} from 'react'
import {Bold,Italic,Link,List,ListOrdered,Quote,Code,CaseSensitive,SendHorizontal,LoaderCircle,Check,Bot,Info,Archive,ArrowLeft,ArrowUp,AtSign,CheckCheck,Download,FileText,MessageSquare,Paperclip,Pin,Plus,ListPlus,ListTree,Megaphone,MoreHorizontal,RefreshCw,Reply,Search,Smile,UserRound,Users,X} from 'lucide-react'
import clsx from 'clsx'
import {MarkdownText,type MarkdownLabels} from '@deepseek-ai/dsh-client-ui-primitives'
import {roleSupportsScope,groupAttachmentExtensions,groupAttachmentFileMediaTypes,groupAttachmentImageMediaTypes,groupAttachmentMaxBytesFor,groupReactionMessageIdsMax,groupReferenceMaxFiles,groupRoutingMessageIdsMax} from '@teloa/contract'
import type {Group,GroupAgentGrant,GroupAgentGrantRead,GroupAttachment,GroupChangeFields,GroupDefinition,GroupMention,GroupMessage,GroupReactionEmoji,GroupReactionSummary,GroupResource,GroupRoutingDecisionView,GroupRoutingStatusView,GroupRules,MessageReference,WorkTask} from '@teloa/contract'
import type {GroupAttachmentApi,OpenedAttachment,PendingAttachment} from './group-attachment-api.js'
import {GroupReactionBar} from './GroupReactionBar.js'
import type {GroupReactionApi} from './group-reaction-api.js'
import type {GroupRoutingApi} from './group-routing-api.js'
import {groupRoutingPending} from './group-routing-view.js'
import {groupMainMessages,groupMessageOverlayIds,groupMessageStatusIds,groupProgressStatuses,mergeGroupMessageStatuses} from './group-message-overlays.js'
import {parseBusinessRecordReferences,type GroupTaskBusinessTarget} from '@teloa/contract'
import {GroupMessageStatus,GroupProgressStatus} from './GroupMessageStatus.js'
import {GroupWorkResumeDrawer,type GroupWorkResumeControls} from './GroupWorkResume.js'
import {openDialog} from './dialog-focus.js'
import {closeDirectoryDetailOnEscape} from './directory-focus.js'
import {returnPanelFocus} from './panel-focus.js'
import {GroupEmojiPicker} from './GroupReactionBar.js'
import {GroupChannelBindings,type GroupChannelContext} from './GroupChannelBindings.js'
import type {GroupApi,GroupSnapshot,GroupTaskRecord} from './group-api.js'
import {useBusinessScopes} from './business-scope-context.js'
import {taskStates,type PreviewTask} from './task-preview.js'
import type {PreviewRole} from './role-preview.js'
import {groupMentionCandidates,groupMentionLabel,groupMentionQuery,groupTaskAssignees,groupMessageIdentity,visibleSavedGroups} from './saved-collaboration-state.js'
import {savedCollaborationDrafts,type GroupDraftEntry} from './saved-collaboration-drafts.js'
import {twinDisplayName} from './team-presentation.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {scheduleGroupMessageRefresh} from './group-message-refresh.js'
import {useGroupReading} from './use-group-reading.js'
import {loadGroupMessageWindow,readGroupMessageWindow} from './group-message-window.js'
import type {GroupMessageSearchResult,GroupTopicSummary} from '@teloa/contract'
import css from './CollaborationPage.module.css'
import {DetailsMenu} from './DetailsMenu.js'
import {initialGroupPanel,readGroupPanelPreference,readGroupPanelViewport,writeGroupPanelPreference} from './group-panel-preference.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'

export type SavedConversationDirectory={teamCreated?:((groupId:string)=>void)|undefined;templateMaterialsRequest?:{groupId:string;serial:number}|undefined;templateMaterialsHandled?:(()=>void)|undefined;refresh:()=>Promise<void>;open:()=>void;select:(id:string)=>void;createScope?:string|undefined;createTeam?:IndustryTeamSeed|undefined;createRequest:number;createHandled:()=>void}
export type GroupWorkContext={prepareTwinDraft?:((group:Group,message:GroupMessage)=>void)|undefined;refreshTasks?:((groupId:string)=>Promise<boolean|void>|void)|undefined;tasks:readonly PreviewTask[];openTask:(id:string)=>void;controls?:GroupWorkResumeControls|undefined;openRole:(id:string)=>void;talkRole?:((id:string)=>Promise<boolean>)|undefined;renderRole?:((id:string,close:()=>void,visible?:boolean)=>ReactNode)|undefined;links?:GroupWorkLinkApi|undefined;openLink?:((item:GroupWorkLinkItem)=>void)|undefined;renderLink?:((item:GroupWorkLinkItem,close:()=>void)=>ReactNode)|undefined;createTask?:((groupId:string)=>void)|undefined;taskSaved?:((task:WorkTask)=>void)|undefined}
type Props={workResources?:GroupWorkResourcePort|undefined;artifactRail?:GroupArtifactRailPort|undefined;templateMaterials?:IndustryTeamMaterialsPort|undefined;preferences?:WorkbenchNavigationStorage|undefined;channels?:GroupChannelContext|undefined;creationForms?:{items:GroupCreationForm[];change:Dispatch<SetStateAction<GroupCreationForm[]>>}|undefined;work?:GroupWorkContext|undefined;directory?:SavedConversationDirectory|undefined;visible:boolean;api:GroupApi;attachments?:GroupAttachmentApi|undefined;reactions?:GroupReactionApi|undefined;routing?:GroupRoutingApi|undefined;target:{groupId:string;rootId:string;messageId?:string}|null;roles:PreviewRole[];profileName:string;panel?:GroupPanelPort|undefined}
/** 群侧栏呈现端口：按群身份上报实际展开状态；collapse 是工作台在本人打开目录时发出的收起请求。 */
export type GroupArtifactRailPort={mount:HTMLElement|null;report:(token:object,groupId:string,open:boolean)=>void;collapse:number}
export type GroupPanelPort={report:(groupId:string,open:boolean)=>void;collapse:{groupId:string;seq:number}|undefined}
type GroupCreationDraft={name:string;coordinatorRoleId?:string;purpose?:string;scope:string;members:string[];rules:GroupRules;tab:'info'|'members'|'rules';query:string}
type FormState={kind:'create';scope?:string|undefined;team?:IndustryTeamSeed;draft?:GroupCreationDraft}|{kind:'change';snapshot:GroupSnapshot;addMembers?:boolean}
const creationKey=(form:Extract<FormState,{kind:'create'}>)=>form.team?'industry:'+form.team.source.loadId:form.scope??'general'
/**
 * 员工不能获得本群授权的真实原因：与服务端保存群授权的前置判据同口径、同次序（`group-agent-grants.ts`：先核对岗位是否支持本群业务，
 * 再核对是否在岗）；只用于说明原因，不改变任何授权或路由判定。
 */
type GroupGrantBlock='scope'|'inactive'
const groupGrantBlock=(role:{scopes:readonly string[];state:string},scope:string|undefined):GroupGrantBlock|undefined=>
 scope!==undefined&&!roleSupportsScope(role.scopes,scope)?'scope':role.state!=='active'?'inactive':undefined
const groupGrantBlocks=(roles:readonly PreviewRole[],scope:string)=>Object.fromEntries(roles.flatMap(role=>{const block=groupGrantBlock(role,scope);return block?[[role.id,block] as const]:[]})) as Record<string,GroupGrantBlock>
export type GroupCreationForm=Extract<FormState,{kind:'create'}>
type ResourceForm={groupId:string;resource:GroupResource|undefined;markdown:string}
type AgentGrantForm={role:PreviewRole;read:GroupAgentGrantRead}
type GroupTaskForm={message:GroupMessage;trigger?:'mention'}
type GroupTaskDraft={goal:string;targetScope:string;selectedObject:string;assigneeId:string}
type GroupSearch={text:string;result?:GroupMessageSearchResult|undefined;failed?:boolean|undefined}
const groupTaskDraftKey=(form:GroupTaskForm)=>JSON.stringify([form.message.groupId,form.message.id,form.trigger??'manual'])
/** 只读稳定错误码，不读任何服务端文案。 */
const forbidden=(cause:unknown)=>!!cause&&typeof cause==='object'&&'code' in cause&&(cause as {code?:unknown}).code==='teloa/forbidden'
/** 一条 attachment 引用的取字节状态；group-resource 引用不进这张表，呈现照旧。 */
type OpenedReference={state:'loading'}|{state:'ready';opened:OpenedAttachment}|{state:'failed'}
/** 成果卡的元数据状态（标题／版本／文件清单，不含字节）。 */
type ArtifactSummaryState=GroupResultSummary
/** 成果卡展开后逐个文件懒取的字节状态；key 是 referenceKey(reference)+':'+snapshotId。 */
type ArtifactFileState={state:'loading'}|{state:'ready';opened:OpenedAttachment}|{state:'failed'}
const referenceKey=(reference:MessageReference)=>reference.kind+':'+reference.id+':'+reference.version
const artifactFileKey=(reference:MessageReference,snapshotId:string)=>referenceKey(reference)+':'+snapshotId
/** 只有这三种栅格图内嵌；SVG／HTML 读回口径也守，一律只给下载。 */
const imageMime=(mime:string)=>(groupAttachmentImageMediaTypes as readonly string[]).includes(mime)
const acceptedMime=(mime:string)=>imageMime(mime)||(groupAttachmentFileMediaTypes as readonly string[]).includes(mime)
const extensionMatches=(mime:string,name:string)=>{const allowed=(groupAttachmentExtensions as Record<string,readonly string[]|undefined>)[mime];return !!allowed&&allowed.some(extension=>name.toLowerCase().endsWith(extension))}
/**
 * 待发送附件的原始 File 只挂在发起它的那次挂载的 pendingFiles ref 上；草稿仓是纯内存的模块级单例
 * （saved-collaboration-drafts.ts），跨挂载存活但不跨刷新。因此读回草稿时凡是 uploading 行一律落成
 * failed：它的字节已经没人握着了，装作还在传只会让发送按钮被恒锁，failed 至少给出重试与移除两条路。
 */
const normalizeReadPending=(items:readonly PendingAttachment[]):PendingAttachment[]=>items.map(item=>item.state==='uploading'?{...item,state:'failed' as const}:item)
/** 只作显示，不参与任何判据；单位照仓库既有写法用 KiB／MiB。 */
const byteLabel=(bytes:number)=>bytes<1024?bytes+' B':bytes<1024*1024?(bytes/1024).toFixed(1)+' KiB':(bytes/(1024*1024)).toFixed(1)+' MiB'

/** 已保存的个人版群协作。示例数据不会进入这个组件。 */
export function SavedCollaborationPage({workResources,artifactRail,templateMaterials,preferences,channels,creationForms,work,visible,api,attachments,reactions,routing,target,roles,profileName,directory:conversationDirectory,panel:panelPort}:Props){
 const {locale,t,time}=useI18n()
 const allowed=useApplicationCapability('groups')

 const scopes=useBusinessScopes()
 const scopeLabel=(value:string)=>Object.hasOwn(scopes,value)?scopes[value as keyof typeof scopes]:value
 const [directory,setDirectory]=useState<Group[]|undefined>(),[directoryError,setDirectoryError]=useState<string>(),[loading,setLoading]=useState(false)
 const [selected,setSelected]=useState<string>(),[snapshot,setSnapshot]=useState<GroupSnapshot>(),[messages,setMessages]=useState<GroupMessage[]|undefined>(),[resources,setResources]=useState<GroupResource[]|undefined>(),[topic,setTopic]=useState<GroupMessage[]|undefined>(),[rootId,setRootId]=useState<string>()
 const [resourceFormOpen,setResourceFormOpen]=useState(false)
 const [workResourceRows,setWorkResourceRows]=useState<readonly WorkResource[]>(),[workResourceError,setWorkResourceError]=useState(false),[workResourceRetry,setWorkResourceRetry]=useState(0)
 useEffect(()=>{let active=true;setWorkResourceRows(undefined);setWorkResourceError(false);if(visible&&snapshot?.group&&workResources)void workResources.api.directory().then(page=>{if(active)setWorkResourceRows(page.resources)},()=>{if(active)setWorkResourceError(true)});return()=>{active=false}},[visible,snapshot?.group.id,workResources?.api,workResources?.identity,workResourceRetry])
 const workResourceOptions=snapshot?.group?groupWorkResourceCandidates(workResourceRows??[],snapshot.group.scope):[]
 const [templateMaterialsOpen,setTemplateMaterialsOpen]=useState(false),[templateMaterialsReadRequest,setTemplateMaterialsReadRequest]=useState(0),templateMaterialRoot=useRef('main'),templateMaterialsInteraction=useRef(0)
 const [readFailures,setReadFailures]=useState<readonly ('group'|'messages'|'resources'|'topic')[]>([])
 const [query,setQuery]=useState(''),[scope,setScope]=useState<string>('all'),[archived,setArchived]=useState(false),[error,setError]=useState<string>(),[form,setForm]=useState<FormState>(),[resourceForm,setResourceForm]=useState<ResourceForm>(),[agentGrantForm,setAgentGrantForm]=useState<AgentGrantForm>(),[taskForm,setTaskForm]=useState<GroupTaskForm>(),[agentGrants,setAgentGrants]=useState<Record<string,GroupAgentGrantRead>>({}),[info,setInfo]=useState(false),[drafts,setDrafts]=useState<Record<string,string>>({}),[referenceDrafts,setReferenceDrafts]=useState<Record<string,MessageReference[]>>({}),[discarded,setDiscarded]=useState(false)
 const taskDrafts=useRef(new Map<string,GroupTaskDraft>())
 const [searches,setSearches]=useState<Record<string,GroupSearch>>({}),[searchBusy,setSearchBusy]=useState<string>(),[historyBusy,setHistoryBusy]=useState<string>(),[focusedMessage,setFocusedMessage]=useState<{groupId:string;rootId?:string;messageId:string;latest?:boolean}>()
 const searchReads=useRef(new Map<string,number>())
 const [mentionDrafts,setMentionDrafts]=useState<Record<string,GroupMention[]>>({}),[mentionAllDrafts,setMentionAllDrafts]=useState<Record<string,boolean>>({}),[mentionAllNotices,setMentionAllNotices]=useState<Record<string,boolean>>({})
 const [attachmentDrafts,setAttachmentDrafts]=useState<Record<string,PendingAttachment[]>>({}),[attachmentError,setAttachmentError]=useState<Record<string,string|undefined>>({}),[groupFiles,setGroupFiles]=useState<GroupAttachment[]|undefined>(),[withdrawTarget,setWithdrawTarget]=useState<GroupAttachment>(),[resumeTarget,setResumeTarget]=useState<{controlId:string;taskId:string|null}>()
 const [groupFormOpen,setGroupFormOpen]=useState(false),[contextTab,setContextTab]=useState<'members'|'work'>('work')
 const [panelKind,setPanelKind]=useState<'overview'|'materials'|'members'>('overview')
 const groupMenu=useRef<HTMLDetailsElement>(null),attachmentInputs=useRef(new Map<string,HTMLInputElement>())
 const [attachmentPreview,setAttachmentPreview]=useState<{groupId:string;file:GroupAttachment}>()
 const [resourcePreview,setResourcePreview]=useState<{groupId:string;reference:MessageReference&{kind:'group-resource'}}>()
 const [bodyPreview,setBodyPreview]=useState<{groupId:string;messageId:string;summary:GroupMessageBodySummary;authorName:string;groupName:string}>()
 const [localCreateForms,setLocalCreateForms]=useState<GroupCreationForm[]>([])
 const createForms=creationForms?.items??localCreateForms,setCreateForms=creationForms?.change??setLocalCreateForms
 const openGroupForm=(value:FormState)=>{
  if(value.kind==='create'){
   // 新建群默认跨业务协作（底层 general），不随当前业务入口自动归属；业务专属由本人在表单里主动选择。
   // 所有入口共用同一份未提交草稿，本人已选的范围、成员随草稿恢复，重新打开不被入口业务覆盖。
   const scoped={...value,scope:value.team?.scope??'general'}
   setCreateForms(current=>current.some(row=>creationKey(row)===creationKey(scoped))?current:[...current,scoped])
   setForm(scoped);setGroupFormOpen(true);setError(undefined);return
  }
  // 重开同一对象恢复原编辑基线；轮询的新版本留给保存时冲突核对，不能悄悄覆盖草稿。
  setForm(current=>current?.kind==='change'&&current.snapshot.group.id===value.snapshot.group.id&&!!current.addMembers===!!value.addMembers?current:value)
  setGroupFormOpen(true)
 }
 const [sending,setSending]=useState(false),sendLock=useRef(false)
 const [sendFailure,setSendFailure]=useState<{groupId:string;key:string;message:string}>()
 const [openedReferences,setOpenedReferences]=useState<Record<string,OpenedReference>>({}),[imageView,setImageView]=useState<OpenedAttachment>()
 // 表情汇总与路由决策都按「本群当前可见的消息身份」整批取回；两者都是叠在消息上的只读投影，不进任何写口。
 const [reactionItems,setReactionItems]=useState<GroupReactionSummary[]>([]),[routingDecisions,setRoutingDecisions]=useState<GroupRoutingDecisionView[]>([])
 // 本人消息的真实处理状态与按输入入口保存的引用回复目标（规格 §3.2、§5）。
 const [messageStatuses,setMessageStatuses]=useState<GroupRoutingStatusView[]>([]),[replyDrafts,setReplyDrafts]=useState<Record<string,string>>({}),[retrying,setRetrying]=useState<Record<string,'pending'|'failed'>>({})
 // 成果卡先只取标题／版本／文件清单（describeArtifact，不取字节）；每个文件的字节等展开/单文件默认展开时才懒取（openArtifactFile）。
 const [artifactSummaries,setArtifactSummaries]=useState<Record<string,ArtifactSummaryState>>({}),[artifactFiles,setArtifactFiles]=useState<Record<string,ArtifactFileState>>({})
 const selectedGroup=useRef<string|undefined>(undefined),selectedRoot=useRef<string|undefined>(undefined),viewGeneration=useRef(0),groupReadGeneration=useRef(0),overlayReadGeneration=useRef(0)
 const visibleRef=useRef(visible);visibleRef.current=visible
 const [artifactPreview,setArtifactPreview]=useState<{groupId:string;root:string|undefined;generation:number;reference:{kind:'artifact';id:string;version:number}}>()
 const sharedMessages=useRef<readonly GroupMessage[]>([]);sharedMessages.current=[...(messages??[]),...(topic??[])]
 const previewIsCurrent=()=>!!artifactPreview&&visibleRef.current&&artifactPreview.generation===viewGeneration.current&&selectedGroup.current===artifactPreview.groupId&&selectedRoot.current===artifactPreview.root&&groupHasSharedArtifactReference(artifactPreview.groupId,sharedMessages.current,artifactPreview.reference)
 const openCurrentArtifact=attachments?(id:string,version:number)=>{
  const groupId=selectedGroup.current,reference={kind:'artifact' as const,id,version}
  if(!visibleRef.current||!groupId||selected!==groupId||snapshot?.group.id!==groupId||rootId!==selectedRoot.current||!groupHasSharedArtifactReference(groupId,sharedMessages.current,reference))throw Object.assign(Error(),{code:'teloa/forbidden'})
  setArtifactPreview({groupId,root:selectedRoot.current,generation:viewGeneration.current,reference})
 }:undefined
 // 切群、话题或隐藏时失效，普通目录刷新不会重开已关闭的预览。
 useEffect(()=>{if(artifactPreview&&!previewIsCurrent())setArtifactPreview(undefined)},[selected,rootId,visible,messages,topic,artifactPreview])
 const artifactSeatToken=useRef<object>({}),previewOpen=!!artifactPreview&&previewIsCurrent()
 useEffect(()=>{const report=artifactRail?.report;if(!report)return;const token=artifactSeatToken.current,groupId=selected??'';report(token,groupId,previewOpen);return()=>report(token,groupId,false)},[artifactRail?.report,selected,previewOpen])
 useEffect(()=>{setArtifactPreview(undefined)},[artifactRail?.collapse])
 const selectRoot=(value:string|undefined)=>{selectedRoot.current=value;setRootId(value)}
 const mainLog=useRef<HTMLDivElement>(null),topicLog=useRef<HTMLDivElement>(null),panelRef=useRef<HTMLElement>(null)
 const panelOpener=useRef<HTMLElement|null>(null),panelWasOpen=useRef(false),panelRestored=useRef(false)
 // 待发送附件的原始 File 只活在本次挂载里：失败重试要拿它重发同一个 requestId，草稿存储只存可序列化的那份状态。
 const pendingFiles=useRef(new Map<string,File>()),openedBlobs=useRef<OpenedAttachment[]>([]),requestedReferences=useRef(new Set<string>()),imageDialog=useRef<HTMLDialogElement>(null),imageCloseButton=useRef<HTMLButtonElement>(null),imageOpener=useRef<HTMLElement|null>(null)
 const attachmentGeneration=useRef(0),attachmentConnection=useRef(attachments);attachmentConnection.current=attachments
 // 换群、卸载释放本页持有的地址；附件 API 在可信撤回后也会幂等释放同附件的地址。
 const releaseOpenedBlobs=()=>{attachmentGeneration.current++;for(const item of openedBlobs.current)item.revoke();openedBlobs.current=[];requestedReferences.current.clear()}
 useEffect(()=>{releaseOpenedBlobs();setOpenedReferences({})},[attachments])
 useEffect(()=>attachments?.subscribeWithdrawal?.(attachmentId=>{
  const key=referenceKey({kind:'attachment',id:attachmentId,version:1}),previous=openedReferences[key]
  setOpenedReferences(current=>({...current,[key]:{state:'failed'}}))
  if(previous?.state==='ready')setImageView(current=>current?.blobUrl===previous.opened.blobUrl?undefined:current)
  setAttachmentPreview(current=>current?.file.attachmentId===attachmentId?undefined:current)
  setGroupFiles(current=>current?.filter(file=>file.attachmentId!==attachmentId))
 }),[attachments,openedReferences])
 const refreshDirectory=async()=>{if(conversationDirectory){await conversationDirectory.refresh();return}setLoading(true);setDirectoryError(undefined);try{setDirectory((await api.list()).items)}catch(cause){setDirectoryError(localizeWorkError(locale,cause))}finally{setLoading(false)}}
 const readAgentGrants=async(next:GroupSnapshot)=>{const generation=viewGeneration.current;const entries=await Promise.all(next.members.flatMap(member=>member.roleId?[api.agentGrant(next.group.id,member.roleId).then(read=>[member.roleId,read] as const)]:[]));if(generation===viewGeneration.current)setAgentGrants(Object.fromEntries(entries))}
 const readMessages=(id:string,root?:string)=>{
  const cached=readGroupMessageWindow(api,id,root),after=cached?.items.at(-1)?.id,roots=(cached?.items??[]).filter(row=>row.rootId===null),bounds=mainLog.current?.getBoundingClientRect()
  const visibleRoots=!root&&bounds?Array.from(mainLog.current!.querySelectorAll<HTMLElement>('[data-teloa-message-id]')).filter(node=>{const rect=node.getBoundingClientRect();return rect.bottom>bounds.top&&rect.top<bounds.bottom}).flatMap(node=>roots.some(row=>row.id===node.dataset.teloaMessageId)?[node.dataset.teloaMessageId!]:[]):[]
  return loadGroupMessageWindow(api,id,root,{...(after?{after}:{}),...(!root?{topicRoots:[...new Set([...visibleRoots.slice(0,25),...roots.slice(-25).map(row=>row.id)])]}:{})})
 }
 // 群文件目录按群读；没有接入附件面（attachments 未传）时这一段整体不跑，界面也不出现附件入口。
 const readGroupFiles=async(id:string)=>{if(!attachments)return;try{const files=await attachments.list(id);if(selectedGroup.current===id)setGroupFiles(files)}catch(cause){if(selectedGroup.current===id)setError(localizeWorkError(locale,cause))}}
 /**
  * 表情汇总与路由决策按消息身份并发取回。两口各自 catch：读不回来只是这一轮没有新的表情或折叠行，
  * 绝不能把群目录刷新整体拖垮（也不读服务端文案，失败就保持上一轮的投影）。
  *
  * 主群与当前话题各保留最新/可见窗口，话题根始终保留。工作状态只读本人消息，独立跟踪在途工作；
  * 每批仍遵守契约上限，不随历史消息量无限扩大表情/路由读取。
  */
 const derivedWorkReads=useRef({api,seen:new Map<string,string>()}),workRef=useRef(work);workRef.current=work
 if(derivedWorkReads.current.api!==api)derivedWorkReads.current={api,seen:new Map()}
 const readMessageOverlays=async(id:string,main:readonly GroupMessage[],replies:readonly GroupMessage[])=>{
  const owner=derivedWorkReads.current
  const generation=viewGeneration.current,reading=++overlayReadGeneration.current
  const cap=Math.min(groupReactionMessageIdsMax,groupRoutingMessageIdsMax)
  const shown=(log:HTMLDivElement|null)=>{
   if(!log)return []
   const bounds=log.getBoundingClientRect()
   return Array.from(log.querySelectorAll<HTMLElement>('[data-teloa-message-id]')).filter(node=>{const rect=node.getBoundingClientRect();return rect.bottom>bounds.top&&rect.top<bounds.bottom}).flatMap(node=>node.dataset.teloaMessageId?[node.dataset.teloaMessageId]:[])
  }
  const visibleIds={main:shown(mainLog.current),topic:shown(topicLog.current)}
  const ids=groupMessageOverlayIds(main,replies,cap,visibleIds)
  const activeWork=(work?.tasks??[]).flatMap(task=>task.storage==='persistent'&&task.state!=='completed'&&task.state!=='cancelled'&&task.source?.groupId===id?[task.source.messageId]:[])
  const statusIds=groupMessageStatusIds(main,replies,groupRoutingMessageIdsMax,messageStatuses,activeWork,visibleIds)
  const statusRead=Promise.all(Array.from({length:Math.ceil(statusIds.length/groupRoutingMessageIdsMax)},async(_,index)=>{
   const batch=statusIds.slice(index*groupRoutingMessageIdsMax,(index+1)*groupRoutingMessageIdsMax)
   const rows=await routing?.status?.(id,batch).catch(()=>undefined)
   return rows?{ids:batch,rows}:undefined
  }))
  const [reactionRows,routingRows,statusBatches]=await Promise.all([ids.length?reactions?.list(id,ids).catch(()=>undefined):undefined,ids.length?routing?.list(id,ids).catch(()=>undefined):undefined,statusRead])
  if(generation!==viewGeneration.current||reading!==overlayReadGeneration.current||selectedGroup.current!==id||!visibleRef.current)return
  if(reactionRows)setReactionItems(reactionRows)
  if(routingRows)setRoutingDecisions(routingRows)
  const successful=statusBatches.flatMap(batch=>batch?[batch]:[])
  const latestStatuses=mergeGroupMessageStatuses(messageStatuses,statusIds,successful.flatMap(batch=>batch.ids),successful.flatMap(batch=>batch.rows))
  if(routing?.status)setMessageStatuses(latestStatuses)
  // 只在真实派生任务/回帖发生变化时重读父台账；相同轮询、空态及失败不刷全目录。
  const facts=[...latestStatuses.flatMap(row=>row.recipients.flatMap(recipient=>recipient.taskId?[JSON.stringify([row.messageId,row.attemptVersion,recipient.roleId,recipient.taskId,recipient.runId,recipient.phase,recipient.resultMessageId])]:[])),...[...main,...replies].flatMap(message=>'taskId'in message?[JSON.stringify([message.id,message.taskId,message.runId])]:[])].sort()
  const fingerprint=JSON.stringify([...new Set(facts)])
  if(facts.length&&owner===derivedWorkReads.current&&owner.seen.get(id)!==fingerprint&&workRef.current?.refreshTasks){
   owner.seen.set(id,fingerprint)
   try{const applied=await workRef.current.refreshTasks(id);if(applied===false&&owner.seen.get(id)===fingerprint)owner.seen.delete(id)}catch{if(owner.seen.get(id)===fingerprint)owner.seen.delete(id)}
  }
 }
 // 群身份是读取的前提；消息或资料单口失败不抹掉已核验的成员与其他成功内容。
 const readGroupContents=async(id:string,generation:number,focusRoot?:string,focusMessage?:string)=>{
  const reading=++groupReadGeneration.current
  const [identity,main,materials,replies]=await Promise.allSettled([api.get(id),focusMessage&&!focusRoot?loadGroupMessageWindow(api,id,undefined,{around:focusMessage}):readMessages(id),api.resources(id),focusRoot?(focusMessage?loadGroupMessageWindow(api,id,focusRoot,{around:focusMessage}):readMessages(id,focusRoot)):Promise.resolve(undefined)])
  if(reading!==groupReadGeneration.current||generation!==viewGeneration.current||selectedGroup.current!==id||!visibleRef.current)return
  if(identity.status==='rejected'){setReadFailures(current=>[...new Set([...current,'group' as const])]);setError(localizeWorkError(locale,identity.reason));return}
  const next=identity.value,failed:('messages'|'resources'|'topic')[]=[]
  setSnapshot(next)
  if(main.status==='fulfilled')setMessages(main.value.items);else failed.push('messages')
  if(materials.status==='fulfilled')setResources(materials.value.items);else failed.push('resources')
  if(replies.status==='fulfilled'){if(replies.value)setTopic(replies.value.items)}else failed.push('topic')
  setReadFailures(failed)
  if(focusMessage){const focused=focusRoot?replies:main;if(focused.status==='fulfilled'&&focused.value?.items.some(message=>message.id===focusMessage&&message.groupId===id&&(message.rootId??undefined)===focusRoot))setFocusedMessage({groupId:id,...(focusRoot?{rootId:focusRoot}:{}),messageId:focusMessage});else{setError(localizeWorkError(locale,Object.assign(Error(),{code:'teloa/source-unavailable'})));return}}
  const failure=[main,materials,replies].find(row=>row.status==='rejected')
  if(failure?.status==='rejected')setError(localizeWorkError(locale,failure.reason))
  else if(readFailures.length)setError(undefined)
  void readAgentGrants(next).catch(cause=>{if(generation===viewGeneration.current)setError(localizeWorkError(locale,cause))})
  void readGroupFiles(id)
  await readMessageOverlays(id,main.status==='fulfilled'?main.value.items:(messages??[]).filter(message=>message.groupId===id),replies.status==='fulfilled'?replies.value?.items??[]:(topic??[]).filter(message=>message.groupId===id&&(message.id===focusRoot||message.rootId===focusRoot)))
 }
 const initialGroupRead=useRef<Promise<void>>()
 const loadGroup=async(id:string,focusRoot?:string,focusMessage?:string)=>{const generation=++viewGeneration.current;selectedGroup.current=id;setSelected(id);setSnapshot(undefined);setResourcePreview(undefined);setBodyPreview(undefined);setAttachmentPreview(undefined);setMessages(undefined);setResources(undefined);setReadFailures([]);setAgentGrants({});setTopic(undefined);selectRoot(focusRoot);const panel=focusRoot?{open:false,kind:'overview' as const,tab:'work' as const}:initialGroupPanel(readGroupPanelPreference(preferences,id),readGroupPanelViewport());panelRestored.current=panel.open;auxiliaryOpener.current=null;setInfo(panel.open);setPanelKind(panel.kind);setContextTab(panel.tab);setError(undefined);setGroupFiles(undefined);releaseOpenedBlobs();setOpenedReferences({});setArtifactSummaries({});setArtifactFiles({});setAttachmentError({});setReactionItems([]);setRoutingDecisions([]);setMessageStatuses([]);setRetrying({});const draftEntry=savedCollaborationDrafts.readGroupDraftEntry(id);setDrafts(draftEntry.drafts);setReplyDrafts(draftEntry.replyDrafts);setReferenceDrafts(draftEntry.referenceDrafts);setMentionDrafts(draftEntry.mentionDrafts);const readPending=Object.fromEntries(Object.entries(draftEntry.attachmentDrafts).map(([draftKey,items])=>[draftKey,normalizeReadPending(items)]));for(const [draftKey,items] of Object.entries(readPending))savedCollaborationDrafts.writeGroupAttachmentDrafts(id,draftKey,items);setAttachmentDrafts(readPending);setMentionAllDrafts({});setMentionAllNotices({});const reading=readGroupContents(id,generation,focusRoot,focusMessage);initialGroupRead.current=reading;await reading}
 /**
  * 4 秒轮询的唯一重读口：群、消息目录、群资料与当前话题一次并发取回，再按取回的真实消息身份
  * 取一次表情与路由决策（教训 b：话题面板以前不在这条闭环里，同事的回帖在界面上根本不出现）。
  */
 const reloadSelected=async(id=selected)=>{
  if(!id)return
  const generation=viewGeneration.current,currentRoot=selectedRoot.current
  await readGroupContents(id,generation,currentRoot)
 }
 const refreshSelected=useRef(reloadSelected);refreshSelected.current=reloadSelected
 useEffect(()=>{if(visible&&!conversationDirectory)void refreshDirectory()},[visible,api,!!conversationDirectory])
 useEffect(()=>{if(conversationDirectory?.createRequest){if(applicationPresentation.can('groups'))openGroupForm({kind:'create',scope:conversationDirectory.createScope,...(conversationDirectory.createTeam?{team:conversationDirectory.createTeam}:{})});conversationDirectory.createHandled()}},[conversationDirectory?.createRequest])
 useEffect(()=>{if(target&&visible)void loadGroup(target.groupId,target.rootId||undefined,target.messageId)},[target?.groupId,target?.rootId,target?.messageId,visible,api])
 // 数字员工完成原生运行后由宿主经过服务端闸门写入群消息；已打开的群只重读真实目录，
 // 不依据客户端推断生成结果，更不会把没有新消息误报为授权拒绝。
 useEffect(()=>{
  if(!visible||!selected)return
  return scheduleGroupMessageRefresh(async()=>{await initialGroupRead.current;if(selectedGroup.current===selected)await refreshSelected.current(selected)})
 },[visible,selected,api])
 // 消息里的 attachment 引用逐条取一次字节；取不到（撤回、读失败）一律落灰卡，不读服务端文案也不猜原因。
 // group-resource 引用不走这里，呈现照旧；artifact 引用走下面单独一段（先取标题/文件清单，字节按需懒取）。
 useEffect(()=>{
  const activeGroup=snapshot?.group
  if(!attachments||!activeGroup)return
  const generation=attachmentGeneration.current,current=()=>generation===attachmentGeneration.current&&attachmentConnection.current===attachments&&selectedGroup.current===activeGroup.id&&visibleRef.current
  const wanted=new Map([...(messages??[]),...(topic??[])].flatMap(message=>message.references).filter(reference=>reference.kind==='attachment').map(reference=>[referenceKey(reference),reference] as const))
  for(const [key,reference] of wanted){
   if(requestedReferences.current.has(key))continue
   requestedReferences.current.add(key)
   setOpenedReferences(current=>({...current,[key]:{state:'loading'}}))
   void attachments.openReference(reference,activeGroup.id).then(value=>{
    if(!current()){if(!('kind'in value))value.revoke();return}
    if('kind' in value){setOpenedReferences(current=>({...current,[key]:{state:'failed'}}));return}
    openedBlobs.current.push(value)
    setOpenedReferences(current=>({...current,[key]:{state:'ready',opened:value}}))
   },()=>{if(current())setOpenedReferences(current=>({...current,[key]:{state:'failed'}}))})
  }
 },[attachments,snapshot?.group.id,messages,topic])
 // 成果卡只先取标题／版本／文件清单（describeArtifact，不取字节）。只关联一个文件时沿用旧体验直接把
 // 字节也取来（默认展开，跟以前单文件成果卡一样一打开就能看/下载）；关联多个文件时把字节留给用户点开
 // 卡片展开时再逐个懒取（见 openArtifactFile 与 SavedReferenceCard 的 details/onToggle），不过量取网。
 useEffect(()=>{
  if(!attachments)return
  const wanted=new Map([...(messages??[]),...(topic??[])].flatMap(message=>message.references).filter(reference=>reference.kind==='artifact').map(reference=>[referenceKey(reference),reference] as const))
  for(const [key,reference] of wanted){
   if(artifactSummaries[key])continue
   setArtifactSummaries(current=>({...current,[key]:{state:'loading'}}))
   void attachments.describeArtifact({kind:'artifact',id:reference.id,version:reference.version}).then(summary=>{
    setArtifactSummaries(current=>({...current,[key]:{state:'ready',title:summary.title,files:summary.files}}))
    if(summary.files.length===1)void openArtifactFile(reference,summary.files[0]!.snapshotId)
   },()=>setArtifactSummaries(current=>({...current,[key]:{state:'failed'}})))
  }
 },[attachments,messages,topic,artifactSummaries])
 // 本组件建过的每个 blob 地址都在卸载时释放；没有第二处 createObjectURL。
 useEffect(()=>()=>{++viewGeneration.current;releaseOpenedBlobs()},[])
 useEffect(()=>{
  if(imageView){openDialog(imageDialog.current,imageCloseButton.current);return}
  if(imageOpener.current){returnPanelFocus(imageOpener.current,document);imageOpener.current=null}
 },[imageView])
 const group=snapshot?.group
 const chooseTemplateMaterials=(open:boolean)=>{++templateMaterialsInteraction.current;if(group&&conversationDirectory?.templateMaterialsRequest?.groupId===group.id)conversationDirectory.templateMaterialsHandled?.();setTemplateMaterialsOpen(open)}
 // 切群只关闭旧对象的设置，保留原编辑基线和子表单草稿；新群不能消费旧群抽屉。
 useEffect(()=>{setGroupFormOpen(false);setTemplateMaterialsOpen(false);setResumeTarget(undefined)},[selected])
 useEffect(()=>{
  const request=conversationDirectory?.templateMaterialsRequest
  if(!visible||!request||request.groupId!==group?.id||!snapshot||!group.source||!templateMaterials)return
  let active=true
  const interaction=templateMaterialsInteraction.current
  const finish=(open:boolean)=>{if(!active||interaction!==templateMaterialsInteraction.current||!visibleRef.current||selectedGroup.current!==request.groupId)return;if(open){templateMaterialRoot.current='main';setTemplateMaterialsReadRequest(value=>value+1);setTemplateMaterialsOpen(true)}conversationDirectory?.templateMaterialsHandled?.()}
  // 自动入口先核对真实来源；合法空集不打断群协作，损坏来源仍交原资料抽屉显示错误。
  void templateMaterials.load(snapshot).then(value=>finish(value.documents.length>0),()=>finish(true))
  return()=>{active=false}
 },[visible,conversationDirectory?.templateMaterialsRequest?.serial,group?.id,group?.version,templateMaterials,api])
 const groupFormMatches=form?.kind==='change'&&form.snapshot.group.id===group?.id
 const mentionCandidates=snapshot?groupMentionCandidates(snapshot.members,roles):[]
 const rows=visibleSavedGroups(directory??[],query,scope,archived)
 const mainMessages=useMemo(()=>groupMainMessages(messages??[]),[messages])
 const mainReading=useGroupReading({api,groupId:group?.id,active:visible&&group?.id===selected&&!readFailures.includes('group')&&!readFailures.includes('messages'),messages:messages===undefined?undefined:mainMessages,log:mainLog})
 const topicReading=useGroupReading({api,groupId:group?.id,rootId,active:visible&&!!rootId&&!info&&group?.id===selected&&!readFailures.includes('group')&&!readFailures.includes('topic'),messages:topic,log:topicLog})
 const mainWindow=group?readGroupMessageWindow(api,group.id):undefined,topicWindow=group&&rootId?readGroupMessageWindow(api,group.id,rootId):undefined
 const topicSummaries=new Map((mainWindow?.topics??[]).map(row=>[row.rootId,row]))
 const loadHistory=async(root:string|undefined,cursor:string,direction:'before'|'after')=>{
  if(!group||historyBusy)return
  const id=group.id,generation=viewGeneration.current;setHistoryBusy(JSON.stringify([id,root??null]));setError(undefined)
  if(direction==='before')(root?topicReading:mainReading).preserve?.()
  try{const result=await loadGroupMessageWindow(api,id,root,{[direction]:cursor});if(generation===viewGeneration.current&&selectedGroup.current===id){if(root===undefined)setMessages(result.items);else if(selectedRoot.current===root)setTopic(result.items)}}
  catch(cause){if(generation===viewGeneration.current)setError(localizeWorkError(locale,cause))}finally{setHistoryBusy(undefined)}
 }
 const historyButton=(root:string|undefined,cursor:string,direction:'before'|'after')=><button type="button" className={css.historyButton} disabled={!!historyBusy} onClick={()=>void loadHistory(root,cursor,direction)}>{t(direction==='before'?'group.messages.older':'group.messages.newer')}</button>
 const returnToLatest=async(root?:string)=>{
  if(!group)return
  const reading=root?topicReading:mainReading
  if(!api.messagePage){reading.latest();return}
  const id=group.id,generation=viewGeneration.current;setHistoryBusy(JSON.stringify([id,root??null]))
  try{const result=await loadGroupMessageWindow(api,id,root);if(generation!==viewGeneration.current||selectedGroup.current!==id||root&&selectedRoot.current!==root)return;if(root)setTopic(result.items);else setMessages(result.items);const last=result.items.at(-1);if(last)setFocusedMessage({groupId:id,...(root?{rootId:root}:{}),messageId:last.id,latest:true})}
  catch(cause){if(generation===viewGeneration.current)setError(localizeWorkError(locale,cause))}finally{setHistoryBusy(undefined)}
 }
 useEffect(()=>{
  if(!focusedMessage||focusedMessage.groupId!==group?.id||focusedMessage.rootId&&focusedMessage.rootId!==rootId)return
  const log=focusedMessage.rootId?topicLog.current:mainLog.current,node=Array.from(log?.querySelectorAll<HTMLElement>('[data-teloa-message-id]')??[]).find(node=>node.dataset.teloaMessageId===focusedMessage.messageId)
  if(!node)return
  const frame=requestAnimationFrame(()=>{if(focusedMessage.latest)(focusedMessage.rootId?topicReading:mainReading).latest();else{node.scrollIntoView({block:'center'});node.focus({preventScroll:true});(focusedMessage.rootId?topicReading:mainReading).onScroll()}setFocusedMessage(undefined)})
  return()=>cancelAnimationFrame(frame)
 },[focusedMessage,group?.id,rootId,messages,topic])
 const search=group?searches[group.id]:undefined
 const searchMessages=async(more=false)=>{
  if(!group||!api.searchMessages)return
  const id=group.id,current=searches[id],query=(current?.text??'').trim(),before=more&&current?.result?.query===query?current.result.next:undefined
  if(!query||more&&!before)return
  const generation=(searchReads.current.get(id)??0)+1;searchReads.current.set(id,generation);setSearchBusy(id)
  try{const result=await api.searchMessages(id,query,undefined,before??undefined);if(searchReads.current.get(id)===generation)setSearches(values=>({...values,[id]:{text:values[id]?.text??query,result:more&&current?.result?{...result,items:[...current.result.items,...result.items]}:result}}))}
  catch{if(searchReads.current.get(id)===generation)setSearches(values=>({...values,[id]:{...values[id]!,failed:true}}))}
  finally{if(searchReads.current.get(id)===generation)setSearchBusy(current=>current===id?undefined:current)}
 }
 const locateMessage=async(item:GroupMessageSearchResult['items'][number],reportFailure=true)=>{
  if(!group)return false
  const id=group.id,generation=++viewGeneration.current,root=item.rootId??undefined;setHistoryBusy(JSON.stringify([id,root??null]));setError(undefined)
  try{const result=await loadGroupMessageWindow(api,id,root,{around:item.message.id});if(generation!==viewGeneration.current||selectedGroup.current!==id)return false;selectRoot(root);setInfo(false);if(root)setTopic(result.items);else setMessages(result.items);setFocusedMessage({groupId:id,...(root?{rootId:root}:{}),messageId:item.message.id});return true}
  catch(cause){if(reportFailure&&generation===viewGeneration.current)setError(localizeWorkError(locale,cause));return false}finally{setHistoryBusy(undefined)}
 }
 const readingNotice=(reading:ReturnType<typeof useGroupReading>,root?:string)=><>{reading.away&&reading.unread!==undefined&&reading.unread>0&&<div className={css.readingNotice} role="status"><button type="button" onClick={()=>void returnToLatest(root)}>{t('group.reading.latest',{count:reading.unread})}</button></div>}{reading.failed&&<div className={css.readingNotice} role="status"><span>{t('group.reading.failed')}</span><button type="button" onClick={reading.retry}>{t('group.reading.retry')}</button></div>}</>
 const mainMessageIds=new Set(mainMessages.map(message=>message.id)),messageById=new Map((messages??[]).map(message=>[message.id,message]))
 const inlineReply=(message:GroupMessage)=>{
  const original=messageById.get(message.replyToMessageId??message.rootId??'')
  if(!original)return undefined
  return {name:groupMessageIdentity(original,roleNames,t).name,excerpt:groupReplyExcerpt(original.text),open:()=>{
   const node=Array.from(mainLog.current?.querySelectorAll<HTMLElement>('[data-teloa-message-id]')??[]).find(node=>node.dataset.teloaMessageId===original.id)
   if(node){node.scrollIntoView({block:'center'});node.focus({preventScroll:true})}else void openTopic({id:original.rootId??original.id})
  }}
 }
 const repliesByRoot=new Map<string,GroupMessage[]>()
 for(const message of messages??[])if(message.rootId&&!mainMessageIds.has(message.id)){const replies=repliesByRoot.get(message.rootId)??[];replies.push(message);repliesByRoot.set(message.rootId,replies)}
 // 成果授权的候选只来自本群消息里已经出现过的成果引用：授权粒度就是那一个固定版本。
 const artifactReferences=[...new Map([...(messages??[]),...(topic??[])].flatMap(message=>message.references).filter(reference=>reference.kind==='artifact').map(reference=>[referenceKey(reference),reference] as const)).values()]
 const relatedTasks=group?[...new Map((work?.tasks??[]).filter(task=>task.storage==='persistent'&&(task.groupId===group.id||task.source?.groupId===group.id)).map(task=>[task.id,task])).values()]:[]
 const currentRoot=rootId?(topic??[]).find(message=>message.id===rootId):undefined
 const recovery=api.recoveryMessage(),pending=api.pending()
 // 表情写口自己也有一份未决请求与恢复记录（group-reaction-api 的 pending/recoveryMessage/recover/discard）。
 // 不接它，断线留下的那次翻转就永远卡在那里：既不重放也不丢弃，之后每次点表情都只会撞「请先核对未完成的群表情请求」。
 const reactionRecovery=reactions?.recoveryMessage(),reactionPending=reactions?.pending()
 const notice=recovery??reactionRecovery
 const discardRecovery=()=>{if(recovery)api.discard();if(reactionRecovery)reactions?.discard();setDiscarded(true)}
 const [recoveringReaction,setRecoveringReaction]=useState(false)
 /** 核对未完成的表情请求：成功就用回执把这条消息的表情汇总原地换掉，失败只落错误条，不清本地记录。 */
 const recoverReaction=async()=>{
  if(!reactions||!reactionPending)return
  setError(undefined);setRecoveringReaction(true)
  try{const items=await reactions.recover();setReactionItems(current=>[...current.filter(item=>item.messageId!==reactionPending.messageId),...items])}
  catch(cause){setError(localizeWorkError(locale,cause))}
  finally{setRecoveringReaction(false)}
 }
 const refreshAfterWrite=async(value:GroupSnapshot|GroupMessage|GroupResource|GroupAgentGrant|GroupTaskRecord)=>{if('task' in value){work?.taskSaved?.(value.task);await refreshDirectory();return}if('group' in value){if(value.group.id!==selected)conversationDirectory?.select(value.group.id);setSnapshot(value);setSelected(value.group.id);setMessages((await readMessages(value.group.id)).items)}else if(selectedGroup.current===value.groupId)await reloadSelected(value.groupId);await refreshDirectory()}
 const recover=async()=>{
  if(sendLock.current)return
  sendLock.current=true;setSending(true);setSendFailure(undefined);setError(undefined)
  const request=api.pending(),sent=request?.kind==='send'?request.request:undefined
  const key=sent?.rootId??'main',draft=sent?savedCollaborationDrafts.readGroupDraftEntry(sent.groupId):undefined
  const matches=sent&&draft&&draft.drafts[key]===sent.text&&JSON.stringify(draft.referenceDrafts[key]??[])===JSON.stringify(sent.references??[])&&JSON.stringify(draft.mentionDrafts[key]??[])===JSON.stringify(sent.mentions??[])&&draft.replyDrafts[key]===sent.replyToMessageId&&(draft.attachmentDrafts[key]??[]).every(item=>item.state==='ready'&&sent.references?.some(ref=>ref.kind==='attachment'&&ref.id===item.attachmentId))
  try{
   const saved=await api.recover()
   if(matches&&sent&&draft)clearSentDraft(sent.groupId,key,draft)
   await refreshAfterWrite(saved)
  }catch(cause){if(sent)setSendFailure({groupId:sent.groupId,key,message:localizeWorkError(locale,cause)});else setError(localizeWorkError(locale,cause))}
  finally{sendLock.current=false;setSending(false)}
 }
 const save=async(fields:GroupDefinition|GroupChangeFields,expected=group)=>{if(!applicationPresentation.can('groups'))return;setError(undefined);try{const value='scope' in fields?await api.create(fields):await api.change(expected!.id,expected!.version,fields);setForm(undefined);setGroupFormOpen(false);if('scope' in fields){setCreateForms(current=>current.filter(draft=>creationKey(draft)!==(form?.kind==='create'?creationKey(form):'general')));setArchived(false);setQuery('');setScope('all');if(fields.source)conversationDirectory?.teamCreated?.(value.group.id)}await refreshAfterWrite(value)}catch(cause){setError(localizeWorkError(locale,cause))}}
 const organize=async(patch:Partial<Pick<GroupChangeFields,'pinned'|'archived'>>)=>{if(!group||!snapshot)return;await save({name:group.name,announcement:group.announcement,rules:group.rules,memberRoleIds:snapshot.members.flatMap(member=>member.roleId?[member.roleId]:[]),pinned:patch.pinned??group.pinned,archived:patch.archived??group.archived})}
 // 只清理已发出的那份草稿；回包或目录刷新期间的新输入不属于上一条消息。
 const clearSentDraft=(groupId:string,key:string,sent:GroupDraftEntry)=>{
  if(!savedCollaborationDrafts.clearGroupSentDraft(groupId,key,sent))return
  for(const item of sent.attachmentDrafts[key]??[])pendingFiles.current.delete(item.key)
  if(selectedGroup.current!==groupId)return
  setDrafts(current=>({...current,[key]:''}));setReferenceDrafts(current=>({...current,[key]:[]}));setMentionDrafts(current=>({...current,[key]:[]}));setAttachmentDrafts(current=>({...current,[key]:[]}));setMentionAllDrafts(current=>({...current,[key]:false}));setReplyDrafts(({[key]:_sent,...rest})=>rest)
 }
 // 同一时刻只提交一条消息；未知结果保留原请求，核对成功前不覆盖为另一条消息。
 const sendMessage=async(root:string|undefined,all=false)=>{
  if(!group||sendLock.current||api.pending()||!applicationPresentation.can('groups'))return
  const key=root??'main',text=drafts[key]??''
  if(group.archived||!text.trim()||(attachmentDrafts[key]??[]).some(item=>item.state==='uploading'))return
  const sentDraft={drafts,referenceDrafts,mentionDrafts,attachmentDrafts,replyDrafts},picks=all?[]:mentionDrafts[key]??[]
  sendLock.current=true;setSending(true);setSendFailure(undefined);setError(undefined)
  try{
   const saved=await api.send(group.id,group.version,text,root,referenceDrafts[key],picks.length?picks:undefined,{replyToMessageId:replyDrafts[key],mentionAll:all})
   clearSentDraft(group.id,key,sentDraft)
   await refreshAfterWrite(saved)
   if(selectedGroup.current!==group.id)return
   if(all)setMentionAllNotices(current=>({...current,[key]:true}))
   if(!all&&!routing&&'mentions' in saved&&saved.mentions.length>0)setTaskForm({message:saved,trigger:'mention'})
  }catch(cause){setSendFailure({groupId:group.id,key,message:picks.length&&forbidden(cause)?t('group.mention.notMember'):localizeWorkError(locale,cause)})}
  finally{sendLock.current=false;setSending(false)}
 }
 const send=(root:string|undefined)=>sendMessage(root)
 const sendMentionAll=(root:string|undefined)=>sendMessage(root,true)
 // 引用只记对象 id 与选中时的固定 version（群资料 GroupResource、本群已共享的 attachment 原件）；候选里只能加入（已引用项禁用），
 // 撤销只走待发送区标签，资料面板沿用切换。已共享文件复用原 attachment 引用，不重新上传。
 const changeReference=(key:string,reference:MessageReference,picked:boolean)=>setReferenceDrafts(current=>{const references=current[key]??[],match=(item:MessageReference)=>item.kind===reference.kind&&item.id===reference.id;if(references.some(match)===picked)return current;const next=picked?[...references,reference]:references.filter(item=>!match(item));if(group)savedCollaborationDrafts.writeGroupReferenceDrafts(group.id,key,next);return {...current,[key]:next}})
 const toggleReference=(key:string,resource:GroupResource)=>changeReference(key,{kind:'group-resource',id:resource.id,version:resource.version},!(referenceDrafts[key]??[]).some(reference=>reference.kind==='group-resource'&&reference.id===resource.id))
 // 输入框候选只列本群上传且仍有效的文件；别的群带进来的、已撤回的都不列，也不代表授予任何员工权限。
 const sharedGroupFiles=(groupFiles??[]).filter(file=>file.state==='active'&&!!group&&file.uploadedInGroupId===group.id)
 const patchPending=(key:string,pendingKey:string,patch:((item:PendingAttachment)=>PendingAttachment)|null)=>{
  if(!group)return
  const current=savedCollaborationDrafts.readGroupDraftEntry(group.id).attachmentDrafts,list=current[key]??[]
  const next=patch===null?list.filter(item=>item.key!==pendingKey):list.map(item=>item.key===pendingKey?patch(item):item)
  savedCollaborationDrafts.writeGroupAttachmentDrafts(group.id,key,next)
  if(selectedGroup.current===group.id)setAttachmentDrafts({...current,[key]:next})
 }
 // 上传成功才把 {kind:'attachment',id,version} 加进这一条消息的引用；失败的行留在待发送区等重试，不进引用。
 const uploadAttachment=async(key:string,item:PendingAttachment,file:File)=>{
  if(!attachments||!group)return
  try{
   const saved=await attachments.upload(group.id,group.version,file,item.requestId)
   if(!savedCollaborationDrafts.readGroupDraftEntry(group.id).attachmentDrafts[key]?.some(row=>row.key===item.key))return
   patchPending(key,item.key,({message,...rest})=>({...rest,state:'ready',attachmentId:saved.attachmentId,bytes:saved.bytes}))
   const current=savedCollaborationDrafts.readGroupDraftEntry(group.id).referenceDrafts
   const next=[...(current[key]??[]),{kind:'attachment',id:saved.attachmentId,version:saved.version} as MessageReference]
   savedCollaborationDrafts.writeGroupReferenceDrafts(group.id,key,next)
   if(selectedGroup.current===group.id)setReferenceDrafts({...current,[key]:next})
   await readGroupFiles(group.id)
  }catch(cause){patchPending(key,item.key,item=>({...item,state:'failed',message:localizeWorkError(locale,cause)}))}
 }
 // 三条入口（回形针、拖放、粘贴）共用这一段判据：类型、扩展名、单件上限（图片与文件分两档，同契约）、一条消息最多 8 项。
 const setKeyError=(key:string,message:string|undefined)=>setAttachmentError(current=>({...current,[key]:message}))
 const addAttachments=(key:string,files:readonly File[])=>{if(!applicationPresentation.can('groups'))return;
  if(!attachments||!group)return
  setKeyError(key,undefined)
  let room=groupReferenceMaxFiles-(referenceDrafts[key]??[]).length-(attachmentDrafts[key]??[]).filter(item=>item.state!=='ready').length
  for(const file of files){
   if(room<=0){setKeyError(key,t('collaboration.attachment.tooMany'));break}
   if(!acceptedMime(file.type)){setKeyError(key,t('collaboration.attachment.unsupported'));continue}
   if(!extensionMatches(file.type,file.name)){setKeyError(key,t('collaboration.attachment.nameMismatch'));continue}
   if(file.size>groupAttachmentMaxBytesFor(file.type)){setKeyError(key,t(imageMime(file.type)?'collaboration.attachment.imageTooLarge':'collaboration.attachment.fileTooLarge'));continue}
   const item:PendingAttachment={key:crypto.randomUUID(),name:file.name,mime:file.type,state:'uploading',requestId:crypto.randomUUID()}
   room-=1
   pendingFiles.current.set(item.key,file)
   setAttachmentDrafts(current=>{const next=[...(current[key]??[]),item];savedCollaborationDrafts.writeGroupAttachmentDrafts(group.id,key,next);return {...current,[key]:next}})
   void uploadAttachment(key,item,file)
  }
 }
 /** 重试原样重用同一个 requestId，由后端幂等回执兜住重复上传。 */
 const retryAttachment=(key:string,item:PendingAttachment)=>{if(!applicationPresentation.can('groups'))return;const file=pendingFiles.current.get(item.key);if(!file)return;setKeyError(key,undefined);patchPending(key,item.key,({message,...rest})=>({...rest,state:'uploading'}));void uploadAttachment(key,item,file)}
 const removeAttachment=(key:string,item:PendingAttachment)=>{
  pendingFiles.current.delete(item.key)
  patchPending(key,item.key,null)
  if(item.attachmentId&&group){const next=(referenceDrafts[key]??[]).filter(reference=>!(reference.kind==='attachment'&&reference.id===item.attachmentId));savedCollaborationDrafts.writeGroupReferenceDrafts(group.id,key,next);setReferenceDrafts(current=>({...current,[key]:next}))}
 }
 const withdrawAttachment=async(attachment:GroupAttachment)=>{if(!attachments||!group||group.archived)return;setError(undefined);try{await attachments.withdraw(attachment.attachmentId,crypto.randomUUID());setWithdrawTarget(undefined);await readGroupFiles(group.id)}catch(cause){setError(localizeWorkError(locale,cause))}}
 const attachmentBytes=(attachmentId:string)=>groupFiles?.find(file=>file.attachmentId===attachmentId)?.bytes
 const openImage=(opened:OpenedAttachment,anchor:HTMLElement|null)=>{imageOpener.current=anchor;setImageView(opened)}
 // 成果卡里单个文件的懒取入口：已经在取或已取过（无论成败）都不重复打网；成功的 blob 记进 openedBlobs 供卸载时统一释放。
 const openArtifactFile=async(reference:MessageReference,snapshotId:string)=>{
  if(!attachments)return
  const key=artifactFileKey(reference,snapshotId)
  let already=false
  setArtifactFiles(current=>{if(current[key]){already=true;return current}return {...current,[key]:{state:'loading'}}})
  if(already)return
  try{
   const opened=await attachments.openArtifactFile({kind:'artifact',id:reference.id,version:reference.version},snapshotId)
   openedBlobs.current.push(opened)
   setArtifactFiles(current=>({...current,[key]:{state:'ready',opened}}))
  }catch{
   setArtifactFiles(current=>({...current,[key]:{state:'failed'}}))
  }
 }
 const closeImage=()=>{imageDialog.current?.close();setImageView(undefined)}
 const mentionToken=(role:PreviewRole)=>'@'+groupMentionLabel(role,mentionCandidates)
 const mentionAllToken='@'+t('group.mention.allName')
 const writeDraftText=(key:string,value:string)=>{if(group)savedCollaborationDrafts.writeGroupDraftText(group.id,key,value);setDrafts(current=>({...current,[key]:value}))}
 const writeMentions=(key:string,next:GroupMention[])=>{if(group)savedCollaborationDrafts.writeGroupMentionDrafts(group.id,key,next);setMentionDrafts(current=>({...current,[key]:next}))}
 /**
  * 正文改动后按 token 字符串对账：某位同事的 @token 不再出现在正文里，就把这条提及摘掉。
  * 只做「删」这一个方向——正文里出现的 @文本一律不解析成 roleId，提及只能由候选里的选择动作产生。
  */
 const editDraftText=(key:string,value:string)=>{
  writeDraftText(key,value)
  const existing=mentionDrafts[key]??[]
  const kept=existing.filter(item=>{const role=mentionCandidates.find(candidate=>candidate.id===item.roleId);return !!role&&value.includes(mentionToken(role))})
  if(kept.length!==existing.length)writeMentions(key,kept)
  if(mentionAllDrafts[key]&&!value.includes(mentionAllToken))setMentionAllDrafts(current=>({...current,[key]:false}))
 }
 // 候选里选中一位：正文替换成 @名字 标记，同时把这位加进提及列表（版本取自成员目录里的在岗同事）。
 const commitMention=(key:string,role:PreviewRole,nextText:string)=>{
  const existing=mentionDrafts[key]??[]
  if(!existing.some(item=>item.roleId===role.id)){if(existing.length>=8)return;writeMentions(key,[...existing,{roleId:role.id,expectedVersion:role.version}])}
  writeDraftText(key,nextText)
 }
 const commitMentionAll=(key:string,nextText:string)=>{writeDraftText(key,nextText);setMentionAllDrafts(current=>({...current,[key]:true}))}
 const removeMention=(key:string,roleId:string)=>{
  writeMentions(key,(mentionDrafts[key]??[]).filter(item=>item.roleId!==roleId))
  const role=mentionCandidates.find(candidate=>candidate.id===roleId)
  // token 必须紧跟空格/行尾/标点才算真正结束，否则「@员工甲」会把「@员工甲乙」的前缀一起删掉。
  if(role){const escaped=mentionToken(role).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');writeDraftText(key,(drafts[key]??'').replace(new RegExp(escaped+'(?=\\s|$|[，。！？、,.!?;:；：])\\s?','g'),''))}
 }
 const openResource=async(resource?:GroupResource)=>{if(!group)return;setError(undefined);if(resourceForm?.groupId===group.id&&resourceForm.resource?.id===resource?.id){setResourceFormOpen(true);return}const groupId=group.id;try{const value=resource?await api.resource(groupId,resource.id,resource.version):undefined;if(selectedGroup.current!==groupId)return;setResourceForm({groupId,resource,markdown:value?.markdown??''});setResourceFormOpen(true)}catch(cause){setError(localizeWorkError(locale,cause))}}
 const saveResource=async(title:string,markdown:string)=>{if(!applicationPresentation.can('groups')||!resourceForm||group?.archived)return;const editing=resourceForm;setError(undefined);try{await api.saveResource(editing.groupId,editing.resource?.id??crypto.randomUUID(),editing.resource?.version??0,title,markdown);setResourceForm(undefined);setResourceFormOpen(false);if(selectedGroup.current===editing.groupId)await reloadSelected()}catch(cause){setError(localizeWorkError(locale,cause))}}
 const withdrawResource=async(resource:GroupResource)=>{if(!group||group.archived)return;setError(undefined);try{await api.withdrawResource(group.id,resource.id,resource.version);await reloadSelected()}catch(cause){setError(localizeWorkError(locale,cause))}}
 const saveAgentGrant=async(role:PreviewRole,selectedResources:MessageReference[],canPost:boolean,canAutoRun:boolean)=>{if(!applicationPresentation.can('groups'))return;if(!group||group.archived)return;setError(undefined);try{await refreshAfterWrite(await api.changeAgentGrant(group.id,role.id,group.version,role.version,'save',selectedResources,canPost,canAutoRun));setAgentGrantForm(undefined);setGroupFormOpen(true)}catch(cause){setError(localizeWorkError(locale,cause))}}
 // 撤销恒定不带资料、不给发言权、也不给自动运行权；本期只落位不接线，这里不读 canAutoRun 决定任何执行分支。
 const revokeAgentGrant=async(role:PreviewRole)=>{if(!group||group.archived)return;setError(undefined);try{await refreshAfterWrite(await api.changeAgentGrant(group.id,role.id,group.version,role.version,'revoke',[],false,false))}catch(cause){setError(localizeWorkError(locale,cause))}}
 const createTask=async(message:GroupMessage,goal:string,assignee?:{roleId:string;expectedVersion:number},trigger?:'mention',businessTarget?:GroupTaskBusinessTarget)=>{if(!applicationPresentation.can('groups'))return;if(!group||group.archived)return;const key=groupTaskDraftKey({message,...(trigger?{trigger}:{})});setError(undefined);try{await refreshAfterWrite(await api.createTask(group.id,message.id,group.version,goal,assignee,trigger,businessTarget));taskDrafts.current.delete(key);setTaskForm(current=>current&&groupTaskDraftKey(current)===key?undefined:current)}catch(cause){setError(localizeWorkError(locale,cause))}}
 // 界面上只出现岗位名，绝不出现 roleId；历史成员按既有词条兜底。
 const roleNames:Record<string,string>={self:profileName,...Object.fromEntries(roles.map(role=>[role.id,role.kind==='twin'?twinDisplayName(profileName,t):role.name]))}
 // 分身头像用本人姓名缩写（不从「某某的分身」截首字），透传给消息与话题预览。
 const twinInitials=personalAvatarInitials(profileName)
 const roleAvatars=Object.fromEntries(roles.map(role=>[role.id,role]))
 /** 表情翻转用回执里的整条消息汇总原地换掉本地投影，不等下一轮轮询；失败由表情条自己落 group.reaction.failed。 */
 const toggleReaction=async(messageId:string,emoji:GroupReactionEmoji)=>{
  if(!group||!reactions||!applicationPresentation.can('groups'))return
  const items=await reactions.toggle(group.id,messageId,emoji)
  setReactionItems(current=>[...current.filter(item=>item.messageId!==messageId),...items])
 }
 const reactionBar=(message:GroupMessage)=>group&&reactions?<GroupReactionBar messageId={message.id} items={reactionItems.filter(item=>item.messageId===message.id)} archived={group.archived||!allowed} onToggle={emoji=>toggleReaction(message.id,emoji)} roleNames={roleNames}/>:null
 /**
  * 折叠行与停下副标题：都从 groups/routing/list 的决策视图纯派生（规格 §3.4），不读运行状态。
  * 一位直接显示名字，两位以上折叠成通用文案、展开后列名字；触发消息超过 30 分钟一律不再显示。
  */
 /** 引用回复目标按输入入口保存；关闭预览只清它，正文、附件与手动 @ 都保留。 */
 const writeReply=(key:string,messageId:string|undefined)=>{if(!group)return;savedCollaborationDrafts.writeGroupReplyDraft(group.id,key,messageId);setReplyDrafts(({[key]:_previous,...rest})=>messageId?{...rest,[key]:messageId}:rest)}
 const replyPreview=(key:string)=>{
  const target=replyDrafts[key],message=target?[...(topic??[]),...(messages??[])].find(item=>item.id===target):undefined
  if(!message)return undefined
  const identity=groupMessageIdentity(message,roleNames,t),employee='runId' in message,mentioned=(mentionDrafts[key]??[]).map(item=>roleNames[item.roleId]??t('collaboration.message.historicalMember'))
  // 显式 @ 与引用对象不同时显示实际接收者；引用本人消息只是上下文锚点。
  const recipient=mentionAllDrafts[key]?t('group.mention.all'):mentioned.length?mentioned.join('、'):employee?identity.name:null
  return {name:identity.name,excerpt:groupReplyExcerpt(message.text)||t('collaboration.reply.sharedReference'),recipient}
 }
 const retryRouting=async(status:GroupRoutingStatusView)=>{
  if(!group||!routing||!applicationPresentation.can('groups')||retrying[status.messageId]==='pending')return
  setRetrying(current=>({...current,[status.messageId]:'pending'}))
  try{
   await routing.retry({requestId:crypto.randomUUID(),groupId:group.id,messageId:status.messageId,expectedAttempt:status.attemptVersion,expectedGroupVersion:group.version})
   setRetrying(({[status.messageId]:_done,...rest})=>rest)
   await reloadSelected(group.id)
  }catch{setRetrying(current=>({...current,[status.messageId]:'failed'}))}
 }
 const statusRow=(message:GroupMessage)=>{
  const status=messageStatuses.find(item=>item.messageId===message.id)
  return status&&group?<GroupMessageStatus status={status} message={message} decision={routingDecisions.find(item=>item.messageId===message.id)} archived={group.archived||!allowed} retrying={retrying[status.messageId]==='pending'} retryFailed={retrying[status.messageId]==='failed'} retry={()=>void retryRouting(status)} openTask={work?.openTask} resume={work?.controls&&status.controlId&&!group.archived&&allowed?(controlId=>setResumeTarget({controlId,taskId:status.recipients.find(item=>item.executionMode==='work'&&item.phase==='paused'&&item.taskId)?.taskId??null})):undefined}/>:null
 }
 // 输入框上方的聚合进行中状态只看本会话可见的本人消息与已派出接手者的员工交接，换群残留的投影按消息身份自然排除（N46）。
 const progressRow=(list:readonly GroupMessage[])=>{
  const statuses=groupProgressStatuses(list,messageStatuses)
  return <GroupProgressStatus statuses={statuses} avatar={person=>roleAvatars[person.roleId]?.kind==='twin'?<TwinAvatar initials={twinInitials} size="sm"/>:roleAvatars[person.roleId]?<EmployeeAvatar avatarKey={roleAvatars[person.roleId]?.avatarKey} size="sm"/>:<span className={clsx(css.avatar,css.human)}>{(roleNames[person.roleId]??person.name).slice(0,1)}</span>}/>
 }
 const routingRow=(message:GroupMessage)=>{
  const decision=routingDecisions.find(item=>item.messageId===message.id)
  if(!decision)return null
  // 有真实处理状态的本人消息不再按「员工是否发过言」推断等待，只保留接力停下提示。
  if(messageStatuses.some(item=>item.messageId===message.id))return decision.kind==='relay-stopped'?<p className={css.hint} role="status">{t('group.routing.stoppedHint')}</p>:null
  const waiting=groupRoutingPending(decision,topic??[],Date.now())
  const named=waiting.map(roleId=>roleNames[roleId]??t('collaboration.message.historicalMember'))
  return <>
   {named.length===1&&<p className={css.hint} role="status">{t('group.routing.pendingNamed',{name:named[0]!})}</p>}
   {named.length>1&&<div role="status"><details className={css.hint}><summary>{t('group.routing.pending')}</summary><ul>{waiting.map((roleId,index)=><li key={roleId}>{named[index]}</li>)}</ul></details></div>}
   {decision.kind==='relay-stopped'&&<p className={css.hint} role="status">{t('group.routing.stoppedHint')}</p>}
  </>
 }
 const openTopic=async(message:Pick<GroupMessage,'id'>)=>{if(!group)return;const generation=++viewGeneration.current;panelRestored.current=false;selectRoot(message.id);setInfo(false);setTopic(undefined);try{const replies=await readMessages(group.id,message.id);if(generation===viewGeneration.current)setTopic(replies.items)}catch(cause){if(generation===viewGeneration.current)setError(localizeWorkError(locale,cause))}}
 const panelOpen=!!(group&&(rootId||info)&&!(artifactRail&&previewOpen))
 const auxiliaryOpener=useRef<HTMLElement|null>(null)
 const openPanel=(kind:typeof panelKind)=>{panelRestored.current=false;auxiliaryOpener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setPanelKind(kind);setInfo(true);if(group)writeGroupPanelPreference(preferences,group.id,{kind,tab:contextTab})}
 const closePanel=()=>{if(info){setInfo(false);if(group)writeGroupPanelPreference(preferences,group.id,{kind:'closed',tab:contextTab});requestAnimationFrame(()=>returnPanelFocus(auxiliaryOpener.current,document));return}++viewGeneration.current;selectRoot(undefined)}
 const previewResource=(reference:MessageReference)=>{if(!group||reference.kind!=='group-resource')return;setResourcePreview({groupId:group.id,reference:{...reference,kind:'group-resource'}})}
 const resourcePreviewIsCurrent=()=>!!resourcePreview&&visibleRef.current&&selectedGroup.current===resourcePreview.groupId&&snapshot?.group.id===resourcePreview.groupId
 const previewMessageBody=(message:GroupMessage)=>{if(!group||message.groupId!==group.id||!('runId' in message)||!message.fullText)return;setBodyPreview({groupId:group.id,messageId:message.id,summary:{...message.fullText},authorName:groupMessageIdentity(message,roleNames,t).name,groupName:group.name})}
 const bodyPreviewIsCurrent=()=>!!bodyPreview&&visibleRef.current&&selectedGroup.current===bodyPreview.groupId&&snapshot?.group.id===bodyPreview.groupId&&[...(messages??[]),...(topic??[])].some(message=>message.id===bodyPreview.messageId&&'runId' in message&&message.fullText?.sha256===bodyPreview.summary.sha256&&message.fullText.chars===bodyPreview.summary.chars)
 const attachmentPreviewIsCurrent=()=>!!attachmentPreview&&visibleRef.current&&selectedGroup.current===attachmentPreview.groupId&&snapshot?.group.id===attachmentPreview.groupId&&!!groupFiles?.some(file=>file.attachmentId===attachmentPreview.file.attachmentId&&file.version===attachmentPreview.file.version&&file.state==='active')
 const registerAttachmentInput=(key:string,node:HTMLInputElement|null)=>{if(node)attachmentInputs.current.set(key,node);else attachmentInputs.current.delete(key)}
 // 侧栏打开时把焦点交给它自己，关闭时还给打开它的按钮；面板始终是 aside，不借用原生 dialog 语义。
 useEffect(()=>{
  // 进入群时自动恢复或默认展开的面板不抢输入焦点；切群时焦点已在别处也不被拉回。
  if(panelOpen&&!panelWasOpen.current){
   if(panelRestored.current)panelRestored.current=false
   else{
    panelOpener.current=document.activeElement instanceof HTMLElement?document.activeElement:null
    panelRef.current?.focus({preventScroll:true})
   }
  }else if(!panelOpen&&panelWasOpen.current){
   const active=document.activeElement
   if(!active||active===document.body||panelRef.current?.contains(active))returnPanelFocus(panelOpener.current,document)
   panelOpener.current=null
  }
  panelWasOpen.current=panelOpen
 },[panelOpen])
 const permissions=group?<section className={css.relationshipCard}><header><h3>{t('collaboration.agentGrant.title')}</h3><span>{t('collaboration.state.saved')}</span></header><p>{t('collaboration.agentGrant.description')}</p><div className={css.memberList}>{snapshot?.members.flatMap(member=>member.roleId?[member]:[]).map(member=>{const role=roles.find(item=>item.id===member.roleId);if(!role)return null;const read=agentGrants[role.id];return <div className={css.member} key={role.id}>{role.kind==='employee'?<EmployeeAvatar avatarKey={role.avatarKey} size="md"/>:<span className={clsx(css.avatar,css.human)}>{role.name.slice(0,1)}</span>}<span>{work?<button type="button" className={css.memberName} onClick={()=>work.openRole(role.id)}>{role.name}</button>:<strong>{role.name}</strong>}<small>{t(`collaboration.agentGrant.status.${read?.status??'not-granted'}`)}</small>{read?.status==='active'&&read.grant&&<><small>{t(read.grant.canPost?'collaboration.context.postingAllowed':'collaboration.context.postingDenied')} · {t(read.grant.canAutoRun?'collaboration.context.autoAllowed':'collaboration.context.autoDenied')}</small><small>{t('collaboration.context.resourceCount',{count:read.grant.resources.length})}</small></>}</span><span><button type="button" className={css.replyButton} disabled={!allowed||!read||group.archived||!!pending} onClick={()=>{if(read){setGroupFormOpen(false);setAgentGrantForm({role,read})}}}>{t('collaboration.agentGrant.configure')}</button>{read?.status==='active'&&<button type="button" className={css.replyButton} disabled={group.archived||!!pending} onClick={()=>void revokeAgentGrant(role)}>{t('collaboration.agentGrant.revoke')}</button>}</span></div>})}</div></section>:undefined
 const materialsContent=group?<>{group.source&&templateMaterials&&<button type="button" className={css.iconButton} aria-label={t('group.templateMaterials.title')} title={t('group.templateMaterials.title')} disabled={!allowed||group.archived} onClick={()=>{templateMaterialRoot.current=rootId??'main';chooseTemplateMaterials(true)}}><FileText size={17}/></button>}<GroupMaterialsPanel groupId={group.id} resources={resources} readFailed={readFailures.includes('resources')} files={attachments?groupFiles:[]} blocked={!allowed||group.archived||!!pending} references={referenceDrafts[rootId??'main']??[]} preview={resource=>previewResource({kind:'group-resource',id:resource.id,version:resource.version})} edit={resource=>void openResource(resource)} create={()=>void openResource()} reference={resource=>{toggleReference(rootId??'main',resource);if(rootId)setInfo(false)}} withdraw={resource=>void withdrawResource(resource)} addAttachment={attachments?()=>{setInfo(false);requestAnimationFrame(()=>attachmentInputs.current.get(rootId??'main')?.click())}:undefined} withdrawAttachment={file=>setWithdrawTarget(file)} previewAttachment={file=>setAttachmentPreview({groupId:group.id,file})} openMembers={()=>openPanel('members')}/></>:undefined
 // 群侧栏实际展开状态上报工作台，只用于渲染期让出共享目录；切群、隐藏或卸载时撤回本群的报告。
 const reportPanel=panelPort?.report,panelGroupId=group?.id,panelShown=visible&&panelOpen
 useEffect(()=>{if(!reportPanel||!panelGroupId)return;reportPanel(panelGroupId,panelShown);return()=>reportPanel(panelGroupId,false)},[reportPanel,panelGroupId,panelShown])
 // 本人主动打开目录时只收起当前群侧栏：页签、筛选、草稿与本群偏好都不改写；重新挂载不重放旧请求。
 const collapseRequest=panelPort?.collapse,seenCollapse=useRef(collapseRequest?.seq)
 useEffect(()=>{
  if(!collapseRequest||collapseRequest.seq===seenCollapse.current)return
  seenCollapse.current=collapseRequest.seq
  if(collapseRequest.groupId!==selectedGroup.current)return
  if(info)setInfo(false)
  if(rootId){++viewGeneration.current;selectRoot(undefined)}
 },[collapseRequest])
 if(!visible)return null
 return <section className={clsx(css.page,conversationDirectory&&css.sharedDirectory)} aria-label={t('collaboration.saved.title')}>
   <CapabilityNotice capability="groups"/>
   {!conversationDirectory&&<div className={css.preview}><strong>{t('collaboration.saved.title')}</strong><button type="button" className={css.replyButton} disabled={loading} onClick={()=>void refreshDirectory()}><RefreshCw size={13}/>{t(loading?'collaboration.state.loading':'collaboration.action.refresh')}</button></div>}
   {(error||directoryError||notice)&&<div className={css.error} role="alert"><span>{notice?localizeWorkError(locale,notice):(error??directoryError)}{notice&&' '+t('recovery.nextStep')}</span>{!notice&&selected&&<button type="button" aria-label={t('collaboration.action.refresh')} title={t('collaboration.action.refresh')} onClick={()=>{setError(undefined);void (group?reloadSelected():loadGroup(selected,selectedRoot.current));void refreshDirectory()}}><RefreshCw size={15}/></button>}{!notice&&<button type="button" aria-label={t('collaboration.action.closeError')} onClick={()=>{setError(undefined);setDirectoryError(undefined)}}><X size={15}/></button>}{notice&&<button type="button" onClick={discardRecovery}>{t('recovery.discard')}</button>}</div>}
   {discarded&&<p role="status">{t('recovery.discarded')}</p>}
   {pending&&!group&&<div className={css.routeNotice} role="status"><span>{t('collaboration.pending.description')}</span><button type="button" onClick={()=>void recover()}>{t('collaboration.action.recover')}</button></div>}
   {reactionPending&&<div className={css.routeNotice} role="status"><span>{t('collaboration.pending.description')}</span><button type="button" aria-label={t('team.detail.recoverMemory')} disabled={recoveringReaction} onClick={()=>void recoverReaction()}>{t('collaboration.action.recover')}</button><button type="button" onClick={()=>{reactions?.discard();setDiscarded(true)}}>{t('recovery.discard')}</button></div>}
   <div className={clsx(css.layout,group&&css.hasSelection,panelOpen&&css.withPanel)}>
    {!conversationDirectory&&<aside className={css.directory} aria-label={t('collaboration.directory.aria')}><header><div><h2>{t('collaboration.directory.title')}</h2></div><button type="button" className={css.iconButton} aria-label={t('collaboration.action.new')} disabled={!allowed} onClick={()=>openGroupForm({kind:'create'})}><Plus size={17}/></button></header>
     <label className={css.search}><Search size={14}/><input aria-label={t('collaboration.search.aria')} value={query} placeholder={t('collaboration.search.placeholder')} onChange={event=>setQuery(event.target.value)}/></label>
     <select className={css.scope} aria-label={t('collaboration.scope.aria')} value={scope} onChange={event=>setScope(event.target.value)}><option value="all">{t('collaboration.scope.all')}</option>{Object.entries(scopes).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select>
     <div className={css.tabs} aria-label={t('collaboration.directory.categories')}><button type="button" aria-pressed={!archived} onClick={()=>setArchived(false)}>{t('collaboration.directory.inbox')}</button><button type="button" aria-pressed={archived} onClick={()=>setArchived(true)}>{t('collaboration.directory.archived')}</button></div>
     <div className={css.groupList}>{directory===undefined&&!directoryError?<p className={css.hint} role="status">{t('collaboration.directory.loading')}</p>:rows.map(item=><button type="button" key={item.id} className={css.groupRow} aria-current={selected===item.id?'page':undefined} onClick={()=>void loadGroup(item.id)}><span className={css.mailRow}><span className={css.avatar} aria-hidden="true"><Users size={18}/></span><span className={css.mailBody}><span className={css.rowTop}><span>{t('collaboration.directory.group')}{item.pinned&&<Pin size={10}/>}</span><time dateTime={item.updatedAt}>{time(item.updatedAt)}</time></span><strong>{item.name}</strong></span></span><small>{item.purpose||item.announcement||t('collaboration.directory.group')}</small><em>{scopeLabel(item.scope)}{item.memberCount!==undefined&&" · "+t('collaboration.members.savedCount',{count:item.memberCount})}</em></button>)}
      {directory!==undefined&&!directoryError&&rows.length===0&&<p className={css.hint}>{t(directory.length===0?'collaboration.directory.empty':'collaboration.directory.noMatch')}</p>}</div>
    </aside>}
    <div className={css.discussion}>{!group?<div className={css.empty}><CheckCheck size={27}/><h1>{t(target?'collaboration.empty.locating':'collaboration.empty.title')}</h1><p>{t(target?'collaboration.empty.targetDescription':'collaboration.empty.description')}</p>{!target&&<button type="button" className={css.primary} disabled={!allowed} onClick={()=>openGroupForm({kind:'create'})}><Plus size={16}/>{t('collaboration.action.new')}</button>}</div>:<>
      <header className={css.groupHeader}><div className={css.heading}><button className={clsx(css.iconButton,css.mobileBack)} type="button" aria-label={t('collaboration.action.back')} onClick={()=>{if(conversationDirectory)conversationDirectory.open();else{setSelected(undefined);setSnapshot(undefined);setMessages(undefined)}}}><ArrowLeft size={18}/></button><button type="button" className={clsx(css.avatar,css.groupAvatar)} aria-label={t('collaboration.settings.aria')} title={t('collaboration.settings.aria')} onClick={()=>openGroupForm({kind:'change',snapshot:snapshot!})}><Users size={18} aria-hidden/></button><div><h1><button type="button" className={css.groupTitle} title={t("collaboration.settings.aria")} onClick={()=>openGroupForm({kind:"change",snapshot:snapshot!})}>{group.name}</button></h1><span className={css.groupContext}>{scopeLabel(group.scope)}{group.purpose&&" · "+group.purpose}{group.pinned&&<em>{t("collaboration.action.pin")}</em>}{group.archived&&<em>{t("status.archived")}</em>}</span></div></div>
       <div className={css.actions}>{typeof api.searchMessages==='function'&&<form className={css.messageSearch} role="search" onSubmit={event=>{event.preventDefault();void searchMessages()}}><input aria-label={t('group.messages.search')} placeholder={t('group.messages.search')} value={search?.text??''} maxLength={240} onChange={event=>{const text=event.target.value;searchReads.current.set(group.id,(searchReads.current.get(group.id)??0)+1);setSearches(values=>({...values,[group.id]:{...values[group.id],text}}));setSearchBusy(undefined)}}/><button type="submit" className={css.iconButton} aria-label={t('group.messages.find')} disabled={searchBusy===group.id||!search?.text.trim()}><Search size={16}/></button></form>}<button type="button" className={css.labelButton} title={t('collaboration.members.savedCount',{count:snapshot?.members.length??0})} aria-label={t('collaboration.members.savedCount',{count:snapshot?.members.length??0})} aria-expanded={panelOpen&&info&&panelKind==='members'} onClick={()=>openPanel('members')}><Users size={15} aria-hidden/><span className={css.headerLabel} aria-hidden>{t('collaboration.members.savedCount',{count:snapshot?.members.length??0})}</span></button><button type="button" className={css.labelButton} title={t('collaboration.view.materials')} aria-label={t('collaboration.view.materials')} aria-expanded={panelOpen&&info&&panelKind==='materials'} onClick={()=>openPanel('materials')}><FileText size={15} aria-hidden/><span className={css.headerLabel} aria-hidden>{t('collaboration.view.materials')}</span></button><button type="button" className={css.labelButton} aria-label={t('overview.title')} title={t('overview.title')} aria-expanded={panelOpen&&info&&panelKind==='overview'} onClick={()=>{if(info&&panelKind==='overview')closePanel();else openPanel('overview')}}><ListTree size={15} aria-hidden/><span className={css.headerLabel} aria-hidden>{t('overview.title')}</span></button>
        <DetailsMenu menuRef={groupMenu} resetKey={group.id} className={css.groupMore}><summary aria-label={t('group.header.more')} title={t('group.header.more')}><MoreHorizontal size={18}/></summary><div role="menu"><button type="button" role="menuitem" aria-label={t('collaboration.settings.aria')} disabled={!allowed||!!pending} onClick={()=>{groupMenu.current?.removeAttribute('open');openGroupForm({kind:'change',snapshot:snapshot!})}}>{t('collaboration.settings.aria')}</button><button type="button" role="menuitem" disabled={!allowed||group.archived||!!pending||!work?.createTask} onClick={()=>{groupMenu.current?.removeAttribute('open');work?.createTask?.(group.id)}}>{t('group.header.newTask')}</button><button type="button" role="menuitem" disabled={!allowed||!!pending} onClick={()=>{groupMenu.current?.removeAttribute('open');void organize({pinned:!group.pinned})}}>{t(group.pinned?'collaboration.action.unpin':'collaboration.action.pin')}</button><button type="button" role="menuitem" disabled={!allowed||!!pending} onClick={()=>{groupMenu.current?.removeAttribute('open');void organize({archived:!group.archived})}}>{t(group.archived?'collaboration.action.restore':'collaboration.action.archive')}</button></div></DetailsMenu>
       </div></header>
      {group.announcement&&<details className={css.announcement} key={group.id}><summary><Megaphone size={14} aria-hidden/><strong>{t('collaboration.form.announcement')}</strong><span>{group.announcement}</span></summary><p>{group.announcement}</p></details>}
      {typeof api.attention==='function'&&typeof api.mentions==='function'&&<GroupMentions key={group.id} api={api} groupId={group.id} active={visible} locate={item=>locateMessage(item,false)} author={item=>groupMessageIdentity(item.message,roleNames,t).name} time={time}/>}
      {(search?.result||search?.failed)&&<section className={css.messageSearchResults} aria-label={t('group.messages.results')}><header><strong>{search.result?.query??search.text}</strong><button type="button" className={css.iconButton} aria-label={t('group.messages.closeSearch')} onClick={()=>{searchReads.current.set(group.id,(searchReads.current.get(group.id)??0)+1);setSearchBusy(undefined);setSearches(values=>({...values,[group.id]:{text:values[group.id]?.text??''}}))}}><X size={15}/></button></header>{search.failed?<p role="alert">{t('group.messages.searchFailed')}<button type="button" onClick={()=>void searchMessages()}>{t('collaboration.action.refresh')}</button></p>:search.result?.items.length===0?<p role="status">{t('group.messages.noResults')}</p>:search.result?.items.map(item=><button type="button" key={item.message.id} disabled={!!historyBusy} onClick={()=>void locateMessage(item)}><span>{groupMessageIdentity(item.message,roleNames,t).name} · {time(item.message.createdAt)} · {t(item.rootId?'collaboration.panel.topic':'collaboration.view.discussion')}</span><strong>{groupReplyExcerpt(item.excerpt)||t('collaboration.reply.sharedReference')}</strong></button>)}{search.result?.next&&<button type="button" disabled={searchBusy===group.id} onClick={()=>void searchMessages(true)}>{t('group.messages.moreResults')}</button>}</section>}
            <div className={css.discussionBody} role="region" aria-label={t('collaboration.view.discussion')}>
      <div ref={mainLog} onScroll={mainReading.onScroll} className={css.transcript} aria-label={t('collaboration.messages.aria')}>{mainWindow?.older&&historyButton(undefined,mainWindow.older,'before')}{messages===undefined?<p className={css.hint} role="status">{t(readFailures.includes('messages')?'collaboration.messages.readFailed':'collaboration.messages.loading')}</p>:mainMessages.length===0?<div className={css.empty}><CheckCheck size={27}/><h2>{t('collaboration.messages.start')}</h2><p>{t('collaboration.messages.startDescription')}</p></div>:mainMessages.map((message,index)=><Fragment key={message.id}><GroupMessageTimeSeparator message={message} previous={mainMessages[index-1]}/><SavedMessage workResources={workResourceRows??[]} openWorkResource={workResources?.open} prepareTwinDraft={work?.prepareTwinDraft?()=>work.prepareTwinDraft!(group,message):undefined} openBody={previewMessageBody} twinInitials={twinInitials} resources={resources??[]} openResource={previewResource} openRole={work?.openRole} archived={group.archived} message={message} inlineReply={inlineReply(message)} roleNames={roleNames} roleAvatars={roleAvatars} summary={topicSummaries.get(message.id)} replies={repliesByRoot.get(message.id)??[]} openTopic={()=>void openTopic({id:message.rootId??message.id})} createTask={()=>setTaskForm({message})} reactions={reactionBar(message)} opened={openedReferences} artifactSummaries={artifactSummaries} artifactFiles={artifactFiles} openArtifactFile={openArtifactFile} attachmentBytes={attachmentBytes} openImage={openImage} openArtifact={openCurrentArtifact}/>{statusRow(message)}{mainWindow?.gaps.includes(message.id)&&historyButton(undefined,message.id,'after')}</Fragment>)}</div>
      {readingNotice(mainReading)}{messages!==undefined&&progressRow(messages)}
      <SavedComposer workResources={workResourceOptions} workResourceError={workResourceError} retryWorkResources={()=>setWorkResourceRetry(value=>value+1)} onAttachmentInput={node=>registerAttachmentInput('main',node)} sending={sending} sendBlocked={!!pending||readFailures.includes('group')||readFailures.includes('messages')} sendError={sendFailure?.groupId===group.id&&sendFailure.key==='main'?sendFailure.message:undefined} recoverPending={!rootId&&!!pending?()=>void recover():undefined} group={group} text={drafts.main??''} setText={value=>editDraftText('main',value)} references={referenceDrafts.main??[]} resources={(resources??[]).filter(resource=>resource.withdrawnAt===null)} files={sharedGroupFiles} addReference={reference=>changeReference('main',reference,true)} removeReference={reference=>changeReference('main',reference,false)} attachmentsEnabled={!!attachments} pending={attachmentDrafts.main??[]} addFiles={files=>addAttachments('main',files)} retryAttachment={item=>retryAttachment('main',item)} removeAttachment={item=>removeAttachment('main',item)} attachmentError={attachmentError.main} hasPendingFile={item=>pendingFiles.current.has(item.key)} mentions={mentionDrafts.main??[]} candidates={mentionCandidates} draftKey="main" commitMention={(role,nextText)=>commitMention('main',role,nextText)} commitMentionAll={nextText=>commitMentionAll('main',nextText)} removeMention={roleId=>removeMention('main',roleId)} mentionAllAllowed={group.rules.mentionAllAllowed} mentionAll={!!mentionAllDrafts.main} allNotice={!!mentionAllNotices.main} send={()=>void send(undefined)} sendAll={()=>void sendMentionAll(undefined)} reply={replyPreview('main')} cancelReply={()=>writeReply('main',undefined)}/>
      </div>
    </>}</div>
    {group&&<aside ref={panelRef} tabIndex={-1} hidden={!panelOpen} onKeyDown={event=>closeDirectoryDetailOnEscape(event,closePanel)} className={css.panel} aria-label={t(rootId&&!info?'collaboration.panel.topic':panelKind==='materials'?'collaboration.view.materials':panelKind==='members'?'group.panel.members':'overview.title')}><header><div className={css.panelIdentity}><strong>{t(rootId&&!info?'collaboration.panel.topic':panelKind==='materials'?'collaboration.view.materials':panelKind==='members'?'group.panel.members':'overview.title')}</strong><small title={group.name}>{group.name}</small></div><button type="button" className={css.iconButton} aria-label={t('collaboration.panel.close')} onClick={closePanel}><X size={18}/></button></header><div className={css.topicBody} hidden={info||!rootId}><div ref={topicLog} onScroll={topicReading.onScroll} className={css.topicMessages}>{topicWindow?.older&&rootId&&historyButton(rootId,topicWindow.older,'before')}{topic===undefined?<p className={css.hint} role="status">{t('collaboration.topic.loading')}</p>:topic.map((message,index)=><Fragment key={message.id}><GroupMessageTimeSeparator message={message} previous={topic[index-1]}/><SavedMessage workResources={workResourceRows??[]} openWorkResource={workResources?.open} prepareTwinDraft={work?.prepareTwinDraft?()=>work.prepareTwinDraft!(group,message):undefined} openBody={previewMessageBody} twinInitials={twinInitials} resources={resources??[]} openResource={previewResource} openRole={work?.openRole} archived={group.archived} message={message} roleNames={roleNames} roleAvatars={roleAvatars} createTask={()=>setTaskForm({message})} quote={currentRoot&&allowed&&!group.archived?()=>writeReply(currentRoot.id,message.id):undefined} reactions={reactionBar(message)} opened={openedReferences} artifactSummaries={artifactSummaries} artifactFiles={artifactFiles} openArtifactFile={openArtifactFile} attachmentBytes={attachmentBytes} openImage={openImage} openArtifact={openCurrentArtifact}/>{statusRow(message)}{routingRow(message)}{topicWindow?.gaps.includes(message.id)&&rootId&&historyButton(rootId,message.id,'after')}</Fragment>)}</div>{readingNotice(topicReading,rootId)}{currentRoot&&topic!==undefined&&progressRow(topic)}{currentRoot&&<SavedComposer workResources={workResourceOptions} workResourceError={workResourceError} retryWorkResources={()=>setWorkResourceRetry(value=>value+1)} onAttachmentInput={node=>registerAttachmentInput(currentRoot.id,node)} sending={sending} sendBlocked={!!pending||readFailures.includes('group')||readFailures.includes('messages')} sendError={sendFailure?.groupId===group.id&&sendFailure.key===currentRoot.id?sendFailure.message:undefined} recoverPending={pending?()=>void recover():undefined} group={group} text={drafts[currentRoot.id]??''} setText={value=>editDraftText(currentRoot.id,value)} references={referenceDrafts[currentRoot.id]??[]} resources={(resources??[]).filter(resource=>resource.withdrawnAt===null)} files={sharedGroupFiles} addReference={reference=>changeReference(currentRoot.id,reference,true)} removeReference={reference=>changeReference(currentRoot.id,reference,false)} attachmentsEnabled={!!attachments} pending={attachmentDrafts[currentRoot.id]??[]} addFiles={files=>addAttachments(currentRoot.id,files)} retryAttachment={item=>retryAttachment(currentRoot.id,item)} removeAttachment={item=>removeAttachment(currentRoot.id,item)} attachmentError={attachmentError[currentRoot.id]} hasPendingFile={item=>pendingFiles.current.has(item.key)} mentions={mentionDrafts[currentRoot.id]??[]} candidates={mentionCandidates} draftKey={currentRoot.id} commitMention={(role,nextText)=>commitMention(currentRoot.id,role,nextText)} commitMentionAll={nextText=>commitMentionAll(currentRoot.id,nextText)} removeMention={roleId=>removeMention(currentRoot.id,roleId)} mentionAllAllowed={group.rules.mentionAllAllowed} mentionAll={!!mentionAllDrafts[currentRoot.id]} allNotice={!!mentionAllNotices[currentRoot.id]} send={()=>void send(currentRoot.id)} sendAll={()=>void sendMentionAll(currentRoot.id)} reply={replyPreview(currentRoot.id)} cancelReply={()=>writeReply(currentRoot.id,undefined)}/>}</div><div className={css.info} hidden={!info}>
      <div hidden={panelKind!=='materials'}>{materialsContent}</div><div hidden={panelKind!=='overview'&&panelKind!=='members'}><SavedGroupOverview group={group} membersOnly={panelKind==='members'} grants={agentGrants} configureGrant={id=>{const role=roles.find(item=>item.id===id),read=agentGrants[id];if(role&&read&&allowed&&!group.archived&&!pending){setGroupFormOpen(false);setAgentGrantForm({role,read})}}} tasks={relatedTasks} messageStatuses={messageStatuses} roles={roles} members={snapshot?.members.map(member=>member.roleId??'self')??[]} work={work} profileName={profileName} tab={panelKind==='members'?'members':contextTab} changeTab={value=>{setContextTab(value);setPanelKind('overview');writeGroupPanelPreference(preferences,group.id,{kind:'overview',tab:value})}} blocked={!allowed||group.archived||!!pending} addMembers={()=>openGroupForm({kind:'change',snapshot:snapshot!,addMembers:true})} results={<GroupWorkResults groupId={group.id} rows={groupSharedResults(group.id,[...(messages??[]),...(topic??[])])} summaries={artifactSummaries} roleNames={roleNames} openArtifact={openCurrentArtifact} openMessage={message=>void openTopic({id:message.rootId??message.id})}/>}/></div>
     </div></aside>}
   </div>
   {createForms.map(draft=><SavedGroupForm key={'create:'+creationKey(draft)} open={groupFormOpen&&form?.kind==='create'&&creationKey(form)===creationKey(draft)} form={draft} roles={roles} profileName={profileName} draftChanged={next=>setCreateForms(current=>current.map(row=>creationKey(row)===creationKey(draft)?{...row,draft:next}:row))} close={()=>setGroupFormOpen(false)} save={fields=>save(fields)} error={form?.kind==='create'&&creationKey(form)===creationKey(draft)?error:undefined}/>)}
   {form?.kind==='change'&&<SavedGroupForm key={form.snapshot.group.id+':'+form.snapshot.group.version+':'+String(!!form.addMembers)} open={groupFormOpen&&groupFormMatches} form={form} permissions={groupFormMatches?permissions:undefined} channels={groupFormMatches&&group&&<GroupChannelBindings groupId={group.id} context={channels}/>} roles={roles} profileName={profileName} close={()=>setGroupFormOpen(false)} save={fields=>save(fields,form.snapshot.group)} error={error}/>}
   {group?.source&&snapshot&&templateMaterials&&<IndustryTeamMaterials key={group.id} open={templateMaterialsOpen} readRequest={templateMaterialsReadRequest} group={snapshot} port={templateMaterials} references={referenceDrafts[templateMaterialRoot.current]??[]} isCurrent={()=>visibleRef.current&&selectedGroup.current===group.id} close={()=>chooseTemplateMaterials(false)} ready={(refs)=>{const key=templateMaterialRoot.current,current=savedCollaborationDrafts.readGroupDraftEntry(group.id).referenceDrafts,next=mergeTeamMaterialReferences(current[key]??[],refs);savedCollaborationDrafts.writeGroupReferenceDrafts(group.id,key,next);setReferenceDrafts({...current,[key]:next});chooseTemplateMaterials(false);void reloadSelected(group.id)}}/>}
   {resourceForm&&<SavedResourceForm key={resourceForm.groupId+':'+(resourceForm.resource?.id??'new')+':'+(resourceForm.resource?.version??0)} open={resourceFormOpen} readOnly={!!group?.archived} form={resourceForm} close={()=>setResourceFormOpen(false)} discard={()=>{setResourceForm(undefined);setResourceFormOpen(false)}} save={saveResource} error={error}/>}
   {taskForm&&group&&snapshot&&<SavedGroupTaskForm key={groupTaskDraftKey(taskForm)} form={taskForm} groupName={group.name} draft={taskDrafts.current.get(groupTaskDraftKey(taskForm))} saveDraft={draft=>taskDrafts.current.set(groupTaskDraftKey(taskForm),draft)} members={snapshot.members} roles={roles} grants={agentGrants} scope={group.scope} close={()=>setTaskForm(undefined)} create={(goal,assignee,businessTarget)=>void createTask(taskForm.message,goal,assignee,taskForm.trigger,businessTarget)} error={error}/>}
   {agentGrantForm&&group&&<SavedAgentGrantForm workResources={workResourceOptions.filter(resource=>[...(messages??[]),...(topic??[])].some(message=>message.references.some(ref=>ref.kind==='work-resource'&&ref.id===resource.id&&ref.version===resource.version)))} form={agentGrantForm} resources={(resources??[]).filter(resource=>resource.withdrawnAt===null)} attachments={groupFiles??[]} artifacts={artifactReferences} artifactSummaries={artifactSummaries} scope={group.scope} openRole={work?id=>{setAgentGrantForm(undefined);work.openRole(id)}:undefined} close={()=>{setAgentGrantForm(undefined);setGroupFormOpen(true)}} save={(selectedResources,canPost,canAutoRun)=>void saveAgentGrant(agentGrantForm.role,selectedResources,canPost,canAutoRun)} error={error}/>}
   {resumeTarget&&work?.controls&&group&&<GroupWorkResumeDrawer key={resumeTarget.controlId} controlId={resumeTarget.controlId} controls={work.controls} close={()=>setResumeTarget(undefined)} resumed={()=>void reloadSelected(group.id)} openTask={resumeTarget.taskId?()=>work.openTask(resumeTarget.taskId!):undefined}/>}
   {withdrawTarget&&<SavedAttachmentWithdrawForm attachment={withdrawTarget} close={()=>setWithdrawTarget(undefined)} confirm={()=>void withdrawAttachment(withdrawTarget)} error={error}/>}
   {imageView&&<dialog ref={imageDialog} className={css.imageDialog} aria-label={t('collaboration.attachment.dialogTitle',{name:imageView.name})} onCancel={closeImage}><header><h2>{imageView.name}</h2><button ref={imageCloseButton} type="button" className={css.iconButton} aria-label={t('collaboration.attachment.close')} onClick={closeImage}><X size={18}/></button></header><img className={css.fullImage} src={imageView.blobUrl} alt={imageView.name}/></dialog>}
   {attachments&&attachmentPreview&&attachmentPreviewIsCurrent()&&<GroupAttachmentPreview key={attachmentPreview.groupId+attachmentPreview.file.attachmentId} file={attachmentPreview.file} api={attachments} isCurrent={attachmentPreviewIsCurrent} close={()=>setAttachmentPreview(undefined)}/>}
   {resourcePreview&&resourcePreviewIsCurrent()&&<GroupResourcePreview key={JSON.stringify(resourcePreview)} groupId={resourcePreview.groupId} reference={resourcePreview.reference} api={api} isCurrent={resourcePreviewIsCurrent} close={()=>setResourcePreview(undefined)}/>}
   {bodyPreview&&bodyPreviewIsCurrent()&&<GroupMessageBodyPreview key={JSON.stringify(bodyPreview)} {...bodyPreview} api={api} isCurrent={bodyPreviewIsCurrent} close={()=>setBodyPreview(undefined)}/>}
   {attachments&&group&&artifactPreview&&previewIsCurrent()&&<GroupArtifactPreview key={JSON.stringify(artifactPreview)} inline={!!artifactRail} portal={artifactRail?.mount} groupId={group.id} rows={groupSharedResults(group.id,sharedMessages.current)} summaries={artifactSummaries} roleNames={roleNames} openArtifact={openCurrentArtifact} openMessage={message=>void openTopic({id:message.rootId??message.id})} api={attachments} reference={artifactPreview.reference} isCurrent={previewIsCurrent} close={()=>setArtifactPreview(undefined)}/>}
 </section>
}

type GroupWorkProps={group:Group;tasks:readonly PreviewTask[];messageStatuses?:readonly GroupRoutingStatusView[]|undefined;roles:readonly PreviewRole[];work:GroupWorkContext|undefined;profileName:string;blocked:boolean}
/** 关联工作的真实数量与其中的任务身份；未读到或读取失败时为 undefined，不能显示为 0。 */
export type GroupWorkSummary={count:number;taskIds:readonly string[]}

export function SavedGroupWork({group,tasks,messageStatuses=[],roles,work,profileName,blocked,summarize}:GroupWorkProps&{summarize?:((value:GroupWorkSummary|undefined)=>void)|undefined}){
 const {t}=useI18n()
 if(work?.links&&work.openLink)return <GroupLinkedWork profileName={profileName} roles={roles} group={group} api={work.links} taskDirectory={work.tasks} tasks={tasks} messageStatuses={messageStatuses} open={work.openLink} openRole={work.openRole} createTask={work.createTask} blocked={blocked} summarize={summarize}/>
 const visibleTasks=tasks.filter(task=>!isCompletedGroupReply(task,messageStatuses,group.id))
 const roleName=(id:string)=>{const role=roles.find(item=>item.id===id);return id==='self'?profileName:role?.kind==='twin'?twinDisplayName(profileName,t):role?.name??t('collaboration.message.historicalMember')}
 // 标题与数量由概览页签承担，这里只保留工具行。
 return <section className={css.workSummary}>
  {work?.createTask&&<header><span/><button type="button" className={css.iconButton} aria-label={t('collaboration.task.create')} title={t('collaboration.task.create')} disabled={blocked} onClick={()=>work.createTask?.(group.id)}><Plus size={17}/></button></header>}
  <div className={css.workRows}>{visibleTasks.map(task=><article className={css.workRow} key={task.id}>
   <div className={css.workMeta}><span>{t('collaboration.view.task')}</span><span>{t(taskStates[task.state])}</span></div>
   <button type="button" className={css.objectName} disabled={!work} onClick={()=>work?.openTask(task.id)}>{task.title}</button>
   <div className={css.workOwner}>{task.assigneeId!=='self'&&roles.some(role=>role.id===task.assigneeId)&&work?<button type="button" className={css.memberName} onClick={()=>work.openRole(task.assigneeId)}>{roleName(task.assigneeId)}</button>:<span>{roleName(task.assigneeId)}</span>}{task.need&&<span>{t('attention.'+task.need)}</span>}</div>
  </article>)}</div>
  {visibleTasks.length===0&&<p className={css.hint}>{t('collaboration.context.workEmpty')}</p>}
 </section>
}

/**
 * 工作概览只呈现关联工作与参与员工的轻量概况；对话、授权与成员管理只在头部成员面板（membersOnly）。
 * 两个页签的数量都来自真实读取：关联工作含显式、项目侧与派生任务；负责事项只按已知任务与员工映射计数。
 */
export function SavedGroupOverview({tab,changeTab,members,addMembers,results,membersOnly=false,grants,configureGrant,...props}:GroupWorkProps&{tab:'work'|'members';changeTab:(value:'work'|'members')=>void;members:readonly string[];addMembers:()=>void;results?:ReactNode;membersOnly?:boolean;grants?:Readonly<Record<string,GroupAgentGrantRead>>|undefined;configureGrant?:((id:string)=>void)|undefined}){
 const {t}=useI18n(),id=useId(),buttons=useRef<Partial<Record<typeof tab,HTMLButtonElement|null>>>({})
 const [reported,setReported]=useState<{groupId:string;value:GroupWorkSummary|undefined}>()
 const tabs=['work','members'] as const
 const move=(event:React.KeyboardEvent<HTMLButtonElement>,index:number)=>{const next=event.key==='ArrowRight'||event.key==='ArrowLeft'?1-index:event.key==='Home'?0:event.key==='End'?1:undefined;if(next===undefined)return;event.preventDefault();changeTab(tabs[next]!);buttons.current[tabs[next]!]?.focus()}
 const linked=!!(props.work?.links&&props.work.openLink)
 const visibleTasks=props.tasks.filter(task=>!isCompletedGroupReply(task,props.messageStatuses??[],props.group.id))
 const summary:GroupWorkSummary|undefined=linked?(reported?.groupId===props.group.id?reported.value:undefined):{count:visibleTasks.length,taskIds:visibleTasks.map(task=>task.id)}
 const participants=members.filter(member=>member!=='self'),taskDirectory=props.work?.tasks??props.tasks
 const assigned=(roleId:string)=>summary?summary.taskIds.filter(taskId=>taskDirectory.find(task=>task.id===taskId)?.assigneeId===roleId).length:undefined
 const counts={work:summary?.count,members:participants.length}
 const roleName=(roleId:string,role:PreviewRole|undefined)=>role?.kind==='twin'?twinDisplayName(props.profileName,t):role?.name??t('collaboration.message.historicalMember')
 return <div className={css.overview}>
  {!membersOnly&&<div className={css.contextTabs} role="tablist" aria-label={t('collaboration.context.open')}>{tabs.map((key,index)=><button key={key} ref={node=>{buttons.current[key]=node}} type="button" role="tab" id={id+'-tab-'+key} aria-controls={id+'-'+key} aria-selected={tab===key} tabIndex={tab===key?0:-1} onClick={()=>changeTab(key)} onKeyDown={event=>move(event,index)}>{t(key==='work'?'collaboration.context.work':'collaboration.view.participants')}{counts[key]!==undefined&&<> <span>{counts[key]}</span></>}</button>)}</div>}
  <div role="tabpanel" id={id+'-work'} aria-labelledby={id+'-tab-work'} hidden={membersOnly||tab!=='work'}><SavedGroupWork {...props} summarize={value=>setReported({groupId:props.group.id,value})}/>{results}</div>
  {membersOnly?<GroupMembersPanel groupId={props.group.id} grantBlocks={groupGrantBlocks(props.roles,props.group.scope)} members={members} roles={props.roles} tasks={props.tasks} profileName={props.profileName} blocked={props.blocked} addMembers={addMembers} openRole={props.work?.openRole} talkRole={props.work?.talkRole} grants={grants} configureGrant={configureGrant}/>:<div role="tabpanel" id={id+'-members'} aria-labelledby={id+'-tab-members'} hidden={tab!=='members'}>
   <div className={memberCss.rows}>{participants.map(roleId=>{const role=props.roles.find(item=>item.id===roleId),name=roleName(roleId,role),count=assigned(roleId),person=<>{role?.kind==='employee'?<EmployeeAvatar avatarKey={role.avatarKey} size="md"/>:role?.kind==='twin'?<TwinAvatar initials={personalAvatarInitials(props.profileName)}/>:<span className={memberCss.human} aria-hidden>{name.slice(0,1)}</span>}<span className={memberCss.identity}><strong>{name}</strong>{count!==undefined&&<small>{count?t('collaboration.view.employeeWork',{count}):t('collaboration.view.employeeNoWork')}</small>}</span></>;return <article className={memberCss.row} key={roleId}>{role&&props.work?<button type="button" className={memberCss.person} aria-label={name} onClick={()=>props.work?.openRole(roleId)}>{person}</button>:<div className={memberCss.person}>{person}</div>}</article>})}</div>
   {!participants.length&&<p className={memberCss.empty}>{t('collaboration.view.employeesEmpty')}</p>}
  </div>}
 </div>
}

type MessageViewProps={opened:Record<string,OpenedReference>;artifactSummaries:Record<string,ArtifactSummaryState>;artifactFiles:Record<string,ArtifactFileState>;openArtifactFile:(reference:MessageReference,snapshotId:string)=>void;attachmentBytes:(attachmentId:string)=>number|undefined;openImage:(opened:OpenedAttachment,anchor:HTMLElement|null)=>void;openArtifact?:((artifactId:string,version:number,isCurrent?:()=>boolean)=>void|Promise<void>)|undefined}

/** 摘录只输出纯文本，不加载图片或生成可点击链接。 */
export function groupReplyExcerpt(text:string):string{
 return text.replace(/^```[^\n]*$/gm,'').replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm,'').replace(/\*\*([^*]+)\*\*|__([^_]+)__/g,(_match,bold,under)=>bold??under).replace(/`([^`]+)`/g,'$1').replace(/\s+/g,' ').trim().slice(0,180)
}

export function GroupReplyPreview({replies,count,participantsCount,roleNames,roleAvatars={},twinInitials='',open}:{count?:number|undefined;participantsCount?:number|undefined;twinInitials?:string|undefined;replies:GroupMessage[];roleNames:Record<string,string>;roleAvatars?:Record<string,PreviewRole>;open:()=>void}){
 const {t,time,dateTime}=useI18n()
 const ordered=[...replies].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)),latest=ordered.at(-1)
 if(!latest)return null
 const author=(message:GroupMessage)=>groupMessageIdentity(message,roleNames,t).name
 const participants=[...new Map([...ordered].reverse().map(message=>['runId' in message?'role:'+message.authorId:'self',message])).values()]
 return <button type="button" className={css.threadPreview} onClick={open} aria-label={t('collaboration.reply.count',{count:count??ordered.length})}>
  <span className={css.threadMeta}><span className={css.threadAvatars} aria-hidden="true">{participants.slice(0,3).map(message=><span key={'runId' in message?message.authorId:'self'} title={author(message)}>{groupMessageIdentity(message,roleNames,t).kind==='twin'?<TwinAvatar initials={twinInitials} size="sm"/>:'runId' in message?<EmployeeAvatar avatarKey={roleAvatars[message.authorId]?.avatarKey} size="sm"/>:<span className={clsx(css.avatar,css.human)}>{author(message).slice(0,1)}</span>}</span>)}{(participantsCount??participants.length)>3&&<span className={css.extraAuthors}>+{(participantsCount??participants.length)-3}</span>}</span><strong>{t('collaboration.reply.count',{count:count??ordered.length})}</strong><time dateTime={latest.createdAt} title={dateTime(latest.createdAt)}>{time(latest.createdAt)}</time></span>
 </button>
}

/** 主群与话题只按当前可见消息分段；时间不参与消息顺序或分页。 */
function GroupMessageTimeSeparator({message,previous}:{message:GroupMessage;previous?:GroupMessage|undefined}){
 const {date,dateTime,time}=useI18n(),newDate=!previous||date(previous.createdAt)!==date(message.createdAt)
 if(!newDate&&previous&&Date.parse(message.createdAt)-Date.parse(previous.createdAt)<5*60*1000)return null
 const fullTime=dateTime(message.createdAt,{dateStyle:'medium',timeStyle:'medium'})
 return <div className={clsx(css.messageTime,newDate&&css.messageDate)} role="separator" aria-label={fullTime}><time dateTime={message.createdAt} title={fullTime}>{newDate?dateTime(message.createdAt,{dateStyle:'medium',timeStyle:'short'}):time(message.createdAt)}</time></div>
}

/**
 * 本人与同事的消息共用这一套渲染：引用按 kind 分流，员工消息也只读呈现，
 * 没有任何「加引用」「改引用」入口（规格 §6.5）。
 * 同事那一条的作者名取群成员名（`roleNames` 按 `authorId`（即 roleId）查），员工头像复用原员工的形象，分身与本人使用名字首字；
 * 查不到的按「历史成员」兜底。「受管回传」仍是名字右侧那个小标记，不再有通用标签当名字用。
 */
function SavedMessage({workResources=[],openWorkResource,prepareTwinDraft,summary,openBody,resources=[],openResource,archived=false,message,inlineReply,replies,openRole,openTopic,createTask,quote,reactions,roleNames,roleAvatars={},opened,artifactSummaries,artifactFiles,openArtifactFile,attachmentBytes,openImage,openArtifact,twinInitials=''}:{workResources?:readonly WorkResource[];openWorkResource?:GroupWorkResourcePort['open']|undefined;prepareTwinDraft?:(()=>void)|undefined;summary?:GroupTopicSummary|undefined;twinInitials?:string|undefined;openBody?:((message:GroupMessage)=>void)|undefined;resources?:readonly GroupResource[];openResource?:((reference:MessageReference)=>void)|undefined;archived?:boolean;openRole?:((id:string)=>void)|undefined;message:GroupMessage;inlineReply?:{name:string;excerpt:string;open:()=>void}|undefined;replies?:GroupMessage[];openTopic?:()=>void;createTask?:()=>void;quote?:(()=>void)|undefined;reactions?:React.ReactNode;roleNames?:Record<string,string>;roleAvatars?:Record<string,PreviewRole>}&MessageViewProps){const {t,dateTime,locale}=useI18n()
 const allowed=useApplicationCapability('groups')
const employee='runId' in message,own=message.authorId==='self'&&!employee,identity=groupMessageIdentity(message,roleNames??{},t),name=identity.name,role=t(identity.kind==='twin'?'collaboration.member.twin':employee?'collaboration.message.employeeRole':'collaboration.message.selfRole');const resourceReferences=message.references.filter(reference=>reference.kind==='group-resource'),workReferences=message.references.filter(reference=>reference.kind==='work-resource'),fileReferences=message.references.filter(reference=>reference.kind==='attachment'||reference.kind==='artifact')
 // labels 引用按 locale 稳定一份；MarkdownText 文档要求新身份会丢弃流式渲染缓存。
 const markdownLabels=useMemo<MarkdownLabels>(()=>({code:{copyLabel:t('collaboration.markdown.code.copyLabel'),copiedLabel:t('collaboration.markdown.code.copiedLabel')},footnotes:t('collaboration.markdown.footnotes')}),[locale])
 const fullTime=dateTime(message.createdAt,{dateStyle:'medium',timeStyle:'medium'})
 const canOpenRole=employee&&roleAvatars[message.authorId]?.kind==='employee'&&!!openRole
 const avatar=identity.kind==='twin'?<TwinAvatar initials={twinInitials}/>:employee?<EmployeeAvatar avatarKey={roleAvatars[message.authorId]?.avatarKey} size="md"/>:<span className={clsx(css.avatar,css.human)}>{name.slice(0,1)}</span>
 return <article className={clsx(css.message,own&&css.ownMessage)} data-teloa-message="true" data-teloa-message-id={message.id} aria-label={name} title={fullTime} tabIndex={-1}>{canOpenRole?<button type="button" className={css.employeeAvatarButton} aria-label={name} onClick={()=>openRole?.(message.authorId)}>{avatar}</button>:avatar}<div><header>{canOpenRole?<button type="button" className={css.messageAuthor} aria-label={name} onClick={()=>openRole?.(message.authorId)}>{name}</button>:<strong>{name}</strong>}{employee?<span role="img" aria-label={identity.kind==='twin'?t('collaboration.member.twin'):t('team.form.employee')} title={identity.kind==='twin'?t('collaboration.member.twin'):t('team.form.employee')}><Bot size={13} aria-hidden="true"/></span>:<span>{role}</span>}{employee&&message.mentionSelf&&<span>{t('group.mentions.you')}</span>}<time dateTime={message.createdAt} title={fullTime}>{dateTime(message.createdAt,{hour:'2-digit',minute:'2-digit'})}</time></header>{inlineReply&&<button type="button" className={css.messageReplyContext} onClick={inlineReply.open}><Reply size={12} aria-hidden/><span>{t('group.reply.preview',{name:inlineReply.name})}</span><span>{inlineReply.excerpt}</span></button>}<div className={[css.markdown,markdownTypography.typography].join(" ")}><MarkdownText text={message.text} labels={markdownLabels}/></div>{employee&&<details className={css.messageSource}><summary><Info size={12} aria-hidden="true"/>{t('collaboration.message.sourceDetails')}</summary><p>{t('collaboration.message.runSource',{runId:message.runId.slice(0,8)})}</p></details>}{resourceReferences.length>0&&<div className={css.referenceCards}>{resourceReferences.map(reference=><WorkArtifactCard key={referenceKey(reference)} label={resources.find(row=>row.id===reference.id)?.title??t('collaboration.view.materials')} detail={<>{t('collaboration.view.materials')} · v{reference.version}</>} onPreview={openResource?()=>openResource(reference):undefined}/>)}</div>}{workReferences.length>0&&<div className={css.referenceCards}>{workReferences.map(reference=><WorkArtifactCard key={referenceKey(reference)} label={workResources.find(row=>row.id===reference.id)?.title??t('group.mention.sectionLibrary')} detail={<>{t('group.mention.sectionLibrary')} · v{reference.version}</>} onPreview={openWorkResource?()=>openWorkResource({...reference,kind:'work-resource'}):undefined}/>)}</div>}{fileReferences.length>0&&<div className={css.referenceCards}>{fileReferences.map(reference=><SavedReferenceCard key={referenceKey(reference)} reference={reference} opened={opened[referenceKey(reference)]} artifactSummary={artifactSummaries[referenceKey(reference)]} artifactFiles={artifactFiles} openArtifactFile={openArtifactFile} bytes={reference.kind==='attachment'?attachmentBytes(reference.id):undefined} openImage={openImage} openArtifact={openArtifact}/>)}</div>}{openTopic&&!!(summary?.count??replies?.length)&&<GroupReplyPreview count={summary?.count} participantsCount={summary?.participants} replies={summary?.replies??replies??[]} roleNames={roleNames??{}} roleAvatars={roleAvatars} twinInitials={twinInitials} open={openTopic}/>}{(reactions||openTopic||createTask||quote||prepareTwinDraft||employee&&message.fullText&&openBody)&&<div className={css.messageActions}>{employee&&message.fullText&&openBody&&<button type="button" className={css.statusIconButton} aria-label={t('group.message.readFullText')} title={t('group.message.readFullText')} onClick={()=>openBody(message)}><FileText size={16} aria-hidden/></button>}{reactions}{openTopic&&!(summary?.count??replies?.length)&&<button type="button" className={css.replyButton} onClick={openTopic}><MessageSquare size={13}/>{t('collaboration.reply.action')}</button>}{quote&&<button type="button" className={css.replyButton} onClick={quote}><Reply size={13}/>{t('group.reply.action')}</button>}{prepareTwinDraft&&<button type="button" className={css.replyButton} disabled={!allowed} onClick={prepareTwinDraft}>{twinDraftCopy(locale,'prepareReply')}</button>}{createTask&&<button type="button" className={css.replyButton} aria-label={t('collaboration.task.create')} title={t('collaboration.task.create')} disabled={!allowed||archived} onClick={createTask}><ListPlus size={14} aria-hidden/>{t('collaboration.task.create')}</button>}</div>}</div></article>}

/**
 * 一条 attachment 引用的呈现：图片内嵌缩略图并可点开大图，文件（含 GIF、SVG、HTML）只给下载不预览，
 * 取不到字节一律灰卡且不给下载。图片地址只会是 blob:，正文一路按文本渲染，不走任何原始 HTML 注入口。
 * artifact 引用另走 SavedArtifactCard：成果可能关联多个文件，标题/版本/文件清单与逐个文件的字节分两步取。
 */
function SavedReferenceCard({reference,opened,artifactSummary,artifactFiles,openArtifactFile,bytes,openImage,openArtifact}:{reference:MessageReference;opened:OpenedReference|undefined;artifactSummary:ArtifactSummaryState|undefined;artifactFiles:Record<string,ArtifactFileState>;openArtifactFile:(reference:MessageReference,snapshotId:string)=>void;bytes:number|undefined;openImage:(opened:OpenedAttachment,anchor:HTMLElement|null)=>void;openArtifact?:((artifactId:string,version:number)=>void|Promise<void>)|undefined}){
 const {t}=useI18n()
 if(reference.kind==='artifact')return <SavedArtifactCard reference={reference} summary={artifactSummary} files={artifactFiles} openArtifactFile={openArtifactFile} openImage={openImage} openArtifact={openArtifact}/>
 if(!opened||opened.state==='loading')return <div className={css.referenceCard}><span className={css.hint} role="status">{t('collaboration.state.loading')}</span></div>
 if(opened.state==='failed')return <div className={clsx(css.referenceCard,css.referenceUnavailable)}><span>{t('collaboration.attachment.withdrawn')}</span></div>
 const file=opened.opened,preview=imageMime(file.mime)
 const thumbnail=<button type="button" className={css.thumbnail} aria-label={t('collaboration.attachment.open',{name:file.name})} onClick={event=>openImage(file,event.currentTarget)}><img src={file.blobUrl} alt={file.name}/></button>
 const download=<a className={css.replyButton} href={file.blobUrl} download={file.name} title={t('collaboration.attachment.download',{name:file.name})}><Download size={13}/>{t('collaboration.attachment.download',{name:file.name})}</a>
 if(preview)return <div className={css.referenceCard}>{thumbnail}</div>
 return <div className={clsx(css.referenceCard,css.fileRow)}><FileText size={15}/><span className={css.fileName}>{file.name}</span>{bytes!==undefined&&<small>{t('collaboration.attachment.size',{size:byteLabel(bytes),type:file.mime})}</small>}{download}</div>
}

/**
 * 成果卡：标题/版本/文件清单来自 describeArtifact（不含字节）；只关联一个文件时默认展开（沿用旧体验，
 * 一打开就能看/下载），关联多个文件时默认收起，用户点开 <details> 才逐个懒取字节（onToggle 触发
 * openArtifactFile），避免一次性把整份成果的所有文件都拉下来。图片内嵌缩略图，SVG／HTML 只给下载。
 * 字节还没取到（含收起未展开）的文件行先按 snapshotId 前 8 位占位；取字节失败的行灰显且不给下载。
 */
function SavedArtifactCard({reference,summary,files,openArtifactFile,openImage,openArtifact}:{reference:MessageReference;summary:ArtifactSummaryState|undefined;files:Record<string,ArtifactFileState>;openArtifactFile:(reference:MessageReference,snapshotId:string)=>void;openImage:(opened:OpenedAttachment,anchor:HTMLElement|null)=>void;openArtifact?:((artifactId:string,version:number)=>void|Promise<void>)|undefined}){
 const {locale,t}=useI18n(),[opening,setOpening]=useState(false),[openError,setOpenError]=useState('')
 if(!summary||summary.state==='loading')return <div className={css.referenceCard}><span className={css.hint} role="status">{t('collaboration.state.loading')}</span></div>
 if(summary.state==='failed')return <div className={clsx(css.referenceCard,css.referenceUnavailable)}><span>{t('collaboration.reference.artifactUnavailable')}</span></div>
 const preview=()=>{if(!openArtifact||opening)return;setOpening(true);setOpenError('');void Promise.resolve().then(()=>openArtifact(reference.id,reference.version)).catch(cause=>setOpenError(localizeWorkError(locale,cause))).finally(()=>setOpening(false))}
 return <div className={css.sharedArtifact}>
  <WorkArtifactCard label={summary.title} detail={<>{t('collaboration.view.results')} · v{reference.version}</>} onPreview={openArtifact&&!opening?preview:undefined}/>
  {openError&&<p role="alert">{openError}</p>}
  {summary.files.length>0&&<details className={clsx(css.referenceCard,css.artifactCard)} open={summary.files.length===1} onToggle={event=>{if(event.currentTarget.open)for(const file of summary.files)openArtifactFile(reference,file.snapshotId)}}>
   <summary>{t('collaboration.reference.artifactCard',{title:summary.title,version:reference.version,count:summary.files.length})}</summary>
   {summary.files.map(file=>{
    const state=files[artifactFileKey(reference,file.snapshotId)]
    if(!state||state.state==='loading')return <p key={file.snapshotId} role="status" className={css.hint}>{t('collaboration.state.loading')}</p>
    if(state.state==='failed')return <p key={file.snapshotId} className={css.hint}>{t('collaboration.reference.artifactUnavailable')}</p>
    const item=state.opened
    if(imageMime(item.mime))return <button key={file.snapshotId} type="button" className={css.thumbnail} aria-label={t('collaboration.attachment.open',{name:item.name})} onClick={event=>openImage(item,event.currentTarget)}><img src={item.blobUrl} alt={item.name}/></button>
    return <div key={file.snapshotId} className={css.fileRow}><FileText size={15}/><span className={css.fileName}>{item.name}</span><a className={css.replyButton} href={item.blobUrl} download={item.name}><Download size={13}/>{t('collaboration.attachment.download',{name:item.name})}</a></div>
   })}
  </details>}
 </div>
}

/** 撤回确认：正文逐字给出「已存的字节不会被删除。」这一句，不改写、不省略。 */
function SavedAttachmentWithdrawForm({attachment,close,confirm,error}:{attachment:GroupAttachment;close:()=>void;confirm:()=>void;error:string|undefined}){
 const {t}=useI18n()
 return <ContextDrawer title={t('collaboration.attachment.withdraw')} close={close} className={clsx(css.dialog,css.lightDrawer)}><form onSubmit={event=>{event.preventDefault();confirm()}}><p className={css.hint}>{attachment.name}</p><p className={css.boundary}>{t('collaboration.attachment.withdrawConfirm')}</p>{error&&<p role="alert">{error}</p>}<footer><button type="button" className={css.secondary} onClick={close}>{t('collaboration.form.cancel')}</button><button type="submit" className={css.primary}>{t('collaboration.attachment.withdraw')}</button></footer></form></ContextDrawer>
}

/**
 * 正文 @ 触发的提及（Slack/飞书式）：在行首或空白后敲「@」就地弹候选浮层，选中把「@过滤词」替换成 @名字 标记。
 * 客户端绝不解析正文 @ 文本推断 roleId——提及只由这里的选择动作产生；正文标记被删掉时由 setText 一侧按 token 同步摘除。
 */
/** 输入框上方同一份候选里的一行：@全员、在岗员工、本群未撤回资料，或本群已共享的文件/图片；id 前缀各不相同，同名也不混淆。 */
type ComposerOption={kind:'all'}|{kind:'role';role:PreviewRole}|{kind:'resource';resource:GroupResource}|{kind:'work-resource';resource:WorkResource}|{kind:'file';file:GroupAttachment}
/** 候选对应的固定版本引用：资料记 GroupResource id+version，文件复用原 attachment id+version（不重新上传）。 */
const optionReference=(option:ComposerOption&{kind:'resource'|'work-resource'|'file'}):MessageReference=>option.kind==='resource'||option.kind==='work-resource'?{kind:option.kind==='resource'?'group-resource':'work-resource',id:option.resource.id,version:option.resource.version}:{kind:'attachment',id:option.file.attachmentId,version:option.file.version}

function SavedComposer({workResources,workResourceError,retryWorkResources,onAttachmentInput,sending,sendBlocked,sendError,recoverPending,group,text,setText,references,resources,files,addReference,removeReference,attachmentsEnabled,pending,addFiles,retryAttachment,removeAttachment,attachmentError,hasPendingFile,mentions,candidates,draftKey,commitMention,commitMentionAll,removeMention,mentionAllAllowed,mentionAll,allNotice,send,sendAll,reply,cancelReply}:{workResources:readonly WorkResource[];workResourceError:boolean;retryWorkResources:()=>void;onAttachmentInput?:((node:HTMLInputElement|null)=>void)|undefined;sending:boolean;sendBlocked:boolean;sendError:string|undefined;recoverPending:(()=>void)|undefined;group:Group;text:string;setText:(value:string)=>void;references:MessageReference[];resources:GroupResource[];files:GroupAttachment[];addReference:(reference:MessageReference)=>void;removeReference:(reference:MessageReference)=>void;attachmentsEnabled:boolean;pending:PendingAttachment[];addFiles:(files:readonly File[])=>void;retryAttachment:(item:PendingAttachment)=>void;removeAttachment:(item:PendingAttachment)=>void;attachmentError:string|undefined;hasPendingFile:(item:PendingAttachment)=>boolean;mentions:GroupMention[];candidates:PreviewRole[];draftKey:string;commitMention:(role:PreviewRole,nextText:string)=>void;commitMentionAll:(nextText:string)=>void;removeMention:(roleId:string)=>void;mentionAllAllowed:boolean;mentionAll:boolean;allNotice:boolean;send:()=>void;sendAll:()=>void;reply?:{name:string;excerpt:string;recipient:string|null}|undefined;cancelReply?:(()=>void)|undefined}){
 const {t}=useI18n()
 const allowed=useApplicationCapability('groups')

 const [mentionQuery,setMentionQuery]=useState<{start:number;query:string}|undefined>(),[activeOption,setActiveOption]=useState(0)
 const [dragging,setDragging]=useState(false)
 const [focused,setFocused]=useState(false),[formatting,setFormatting]=useState(false)
 const [emojiOpener,setEmojiOpener]=useState<HTMLElement|null>(null)
 // 引用图标打开的「只列资料」候选；与正文 @ 共用同一份列表、同一套键盘与关闭规则，切群/切话题即收起。
 const [resourceLauncher,setResourceLauncher]=useState(false)
 useEffect(()=>{setResourceLauncher(false);caretGeneration.current++},[group.id,draftKey])
 const emojiOpen=!!emojiOpener
 const fileInput=useRef<HTMLInputElement|null>(null),dragDepth=useRef(0),textareaRef=useRef<HTMLTextAreaElement>(null),caretGeneration=useRef(0)
 useEffect(()=>{
  const node=textareaRef.current;if(!node)return
  const resize=()=>{node.style.height='0px';node.style.height=Math.max(42,Math.min(160,node.scrollHeight))+'px'}
  resize();let width=node.clientWidth
  const observer=new ResizeObserver(()=>{if(node.clientWidth===width)return;width=node.clientWidth;resize()})
  observer.observe(node);return()=>observer.disconnect()
 },[text])
 const formatTools=[['bold','knowledge.ui.060',Bold],['italic','knowledge.ui.061',Italic],['link','knowledge.ui.064',Link],['ordered-list','knowledge.ui.066',ListOrdered],['unordered-list','knowledge.ui.065',List],['quote','knowledge.ui.062',Quote],['code','knowledge.ui.063',Code]] as const
 const format=(command:MarkdownCommand)=>{
  if(group.archived)return
  const node=textareaRef.current,placeholder=t(command==='link'?'knowledge.markdown.placeholder.link':command==='unordered-list'||command==='ordered-list'?'knowledge.markdown.placeholder.listItem':'knowledge.markdown.placeholder.text')
  const edit=applyMarkdownCommand(text,node?.selectionStart??text.length,node?.selectionEnd??text.length,command,placeholder)
  if(edit.value.length>8000)return
  setText(edit.value);setMentionQuery(undefined)
  if(node)requestAnimationFrame(()=>{node.focus();node.setSelectionRange(edit.selectionStart,edit.selectionEnd)})
 }
 const attachmentsBlocked=pending.some(item=>item.state==='uploading')
 const canSend=allowed&&!group.archived&&!!text.trim()&&!attachmentsBlocked&&!sending&&!sendBlocked
 const submit=()=>{if(canSend&&applicationPresentation.can('groups')){if(mentionAll)sendAll();else send()}}
 const dropEnabled=allowed&&attachmentsEnabled&&!group.archived
 // 回形针、拖放与粘贴三条入口进同一个判据。
 const pick=(files:FileList|null|undefined)=>{const list=files?[...files]:[];if(list.length)addFiles(list)}
 // 拖过子元素时浏览器会连发 dragleave/dragenter；按进入计数归零才收高亮，否则提示行会反复出现，
 // role=status 的朗读也跟着抖。
 const endDrag=()=>{dragDepth.current=0;setDragging(false)}
 const labelOf=(role:PreviewRole)=>groupMentionLabel(role,candidates)
 const allLabel=t('group.mention.all'),allToken='@'+t('group.mention.allName')
 const needle=(mentionQuery?.query??'').toLocaleLowerCase()
 // 员工按名字前缀过滤（与既有提及一致）；资料按标题包含过滤（与会话 @ 资料候选一致）。
 // 群资料与资料库原件保持各自 kind；资料库候选已按 active/本群业务过滤，选中只写本条草稿，不授予员工权限。
 // 引用图标只是把同一份候选切成「只列资料/文件」：仍以正文里的 @token 作查询词，继续输入沿用过滤，token 被删掉才退出。
 const roleOptions:ComposerOption[]=mentionQuery&&!resourceLauncher?[
  ...(mentionAllAllowed&&t('group.mention.allName').toLocaleLowerCase().startsWith(needle)?[{kind:'all' as const}]:[]),
  ...candidates.filter(role=>labelOf(role).toLocaleLowerCase().startsWith(needle)).map(role=>({kind:'role' as const,role})),
 ]:[]
 const matchesNeedle=(title:string)=>title.toLocaleLowerCase().includes(needle)
 const resourceOptions:ComposerOption[]=mentionQuery?resources.filter(resource=>matchesNeedle(resource.title)).map(resource=>({kind:'resource' as const,resource})):[]
 const fileOptions:ComposerOption[]=mentionQuery?files.filter(file=>matchesNeedle(file.name)).map(file=>({kind:'file' as const,file})):[]
 const libraryOptions:ComposerOption[]=mentionQuery?workResources.filter(resource=>matchesNeedle(resource.title)).map(resource=>({kind:'work-resource' as const,resource})):[]
 const options=[...roleOptions,...resourceOptions,...libraryOptions,...fileOptions]
 const active=activeOption<options.length?activeOption:0
 const optionId=(option:ComposerOption)=>option.kind==='resource'||option.kind==='work-resource'?option.kind+'-'+draftKey+'-'+option.resource.id:option.kind==='file'?'file-'+draftKey+'-'+option.file.attachmentId:'mention-'+draftKey+'-'+(option.kind==='all'?'all':option.role.id)
 // 已在本条引用里（含刚上传完成、已进引用的待发附件）就视为已引用，避免同一原件重复两次。
 const referenced=(reference:MessageReference)=>references.some(item=>item.kind===reference.kind&&item.id===reference.id)
 // 引用上限与附件共用一条消息 8 项（contract groupReferenceMaxFiles），上传中的附件也占位。
 const referenceRoom=groupReferenceMaxFiles-references.length-pending.filter(item=>item.state!=='ready').length
 const blocked=(option:ComposerOption)=>option.kind==='all'?mentions.length>0:option.kind==='role'?mentionAll||(mentions.length>=8&&!mentions.some(item=>item.roleId===option.role.id)):referenced(optionReference(option))||referenceRoom<=0
 const closeOptions=()=>{setMentionQuery(undefined);setResourceLauncher(false);setActiveOption(0)}
 // 选一次就关闭候选并把光标还给输入框；资料/文件不写进正文（纯文本输入框没有行内引用块），只去掉 @过滤词，引用落在待发送区标签。
 // 焦点同步归还（不等下一帧，后台/无头窗口里 rAF 可能迟到）；光标位置等 React 写回新正文后再落。
 const focusCaret=(position:number,value:string)=>{const el=textareaRef.current;if(!el)return;const generation=++caretGeneration.current;el.focus({preventScroll:true});requestAnimationFrame(()=>{if(generation===caretGeneration.current&&el===textareaRef.current&&el.isConnected&&document.activeElement===el&&el.value===value)el.setSelectionRange(position,position)})}
 const choose=(option:ComposerOption)=>{
  if(blocked(option))return
  if(!mentionQuery)return
  if(option.kind==='resource'||option.kind==='work-resource'||option.kind==='file'){
   const nextText=text.slice(0,mentionQuery.start)+text.slice(mentionQuery.start+1+mentionQuery.query.length)
   setText(nextText)
   addReference(optionReference(option))
   closeOptions();focusCaret(mentionQuery.start,nextText)
   return
  }
  const token=option.kind==='all'?allToken:'@'+labelOf(option.role)
  const nextText=text.slice(0,mentionQuery.start)+token+' '+text.slice(mentionQuery.start+1+mentionQuery.query.length)
  if(option.kind==='all')commitMentionAll(nextText);else commitMention(option.role,nextText)
  closeOptions()
 }
 // 表情/@ 按钮都在光标处插入，光标位置以 textareaRef 为准；测试环境里没有真实 DOM，退回正文末尾。
 const caret=()=>textareaRef.current?.selectionStart??text.length
 const closeEmoji=()=>{const previous=emojiOpener;setEmojiOpener(null);returnPanelFocus(previous,document)}
 const insertEmoji=(emoji:GroupReactionEmoji)=>{const cursor=caret();setText(text.slice(0,cursor)+emoji+text.slice(cursor))}
 // @ 按钮与引用图标都在光标处插入 @ 触发符（已有空白时不再补空格，照规格 §6.3 之外的 T13 步骤段「@ 按钮」判据）；
 // 引用图标额外进入只列资料/文件模式。再点已打开的引用图标只收起候选，正文里的查询词原样保留。
 const insertTrigger=(resourceOnly:boolean)=>{
  if(resourceOnly&&resourceLauncher){closeOptions();return}
  const cursor=caret(),before=text.slice(0,cursor),after=text.slice(cursor)
  const insertion=(before.length>0&&!/\s$/.test(before)?' ':'')+'@'
  const nextText=before+insertion+after,nextCursor=cursor+insertion.length
  setText(nextText)
  setMentionQuery(groupMentionQuery(nextText,nextCursor));setResourceLauncher(resourceOnly)
  setActiveOption(0)
  focusCaret(nextCursor,nextText)
 }
 const onKeyDown=(event:React.KeyboardEvent<HTMLTextAreaElement>)=>{
  // 新的键盘/指针输入取消旧选项留下的延迟光标回包，后台动画帧不能把后续打字挪到旧位置。
  caretGeneration.current++
  const composing=!!(event.nativeEvent as KeyboardEvent|undefined)?.isComposing
  if((event.metaKey||event.ctrlKey)&&!event.altKey&&!composing){const command=({b:'bold',i:'italic',e:'code'} as const)[event.key.toLowerCase() as 'b'|'i'|'e'];if(command){event.preventDefault();format(command);return}}
  if(composing)return

  // 表情浮层开着时，Enter 归浮层（浮层自带键盘处理）；两种浮层都没开才谈发送。
  if(emojiOpen)return
  // 候选可见（含图标打开的空态）时 Esc 一律收起、回车归候选，不落到发送分支。
  const menuOpen=options.length>0||resourceLauncher
  if(menuOpen&&event.key==='Escape'){event.preventDefault();event.stopPropagation();closeOptions();return}
  if(options.length===0){
   if(resourceLauncher&&event.key==='Enter'&&!composing){event.preventDefault();return}
   // 中文输入法用回车确认候选词时 isComposing 为真，绝不能当成发送。
   if(event.key==='Enter'&&!event.shiftKey&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!composing){
    event.preventDefault()
    // 与 onSubmit 同一判据：@全员的草稿必须走 sendAll()，否则回车发出去的那条不带全员提示。
    submit()
   }
   return
  }
  if(event.key==='ArrowDown'){event.preventDefault();setActiveOption((active+1)%options.length);return}
  if(event.key==='ArrowUp'){event.preventDefault();setActiveOption((active+options.length-1)%options.length);return}
  // 候选开着时输入法确认候选词的回车同样不算选中：留给输入法，既不选也不发。
  if(event.key==='Enter'&&composing)return
  if(event.key==='Enter'||event.key==='Tab'){const option=options[active];if(!option)return;event.preventDefault();choose(option)}
 }
 return <form className={clsx(css.composer,dragging&&css.composerDropping)} aria-busy={sending}
  onDragEnter={event=>{event.preventDefault();if(!dropEnabled)return;dragDepth.current+=1;setDragging(true)}}
  onDragOver={event=>event.preventDefault()}
  onDragLeave={()=>{if(!dropEnabled)return;dragDepth.current=Math.max(0,dragDepth.current-1);if(dragDepth.current===0)setDragging(false)}}
  onDrop={event=>{event.preventDefault();endDrag();if(dropEnabled)pick(event.dataTransfer?.files)}}
  onPaste={event=>{if(!dropEnabled)return;const files=event.clipboardData?.files;if(files&&files.length){event.preventDefault();pick(files)}}}
  onSubmit={event=>{event.preventDefault();submit()}}>
  {formatting&&<div className={css.formatToolbar} role="toolbar" aria-label={t('knowledge.ui.073')}>{formatTools.map(([command,key,Icon])=><button key={command} type="button" title={t(key)} aria-label={t(key)} disabled={!allowed||group.archived} onMouseDown={event=>event.preventDefault()} onClick={()=>format(command)}><Icon size={17}/></button>)}</div>}
  {reply&&<div className={css.replyPreview} role="group" aria-label={t('group.reply.preview',{name:reply.name})}><div><strong>{t('group.reply.preview',{name:reply.name})}</strong><span>{reply.excerpt}</span><small>{reply.recipient?t('group.reply.recipient',{name:reply.recipient}):t('group.reply.anchor')}</small></div>{cancelReply&&<button type="button" className={css.iconButton} aria-label={t('group.reply.cancel')} onClick={cancelReply}><X size={14}/></button>}</div>}
  {mentions.length>0&&<div className={css.mentionChips}>{mentions.map(mention=>{const role=candidates.find(item=>item.id===mention.roleId);return <span key={mention.roleId} className={css.mentionChip}>{role?labelOf(role):mention.roleId}<button type="button" aria-label={t('collaboration.form.close')} onClick={()=>removeMention(mention.roleId)}><X size={11}/></button></span>})}</div>}
  <div className={css.mentionAnchor}>
   <textarea ref={textareaRef} aria-label={t('collaboration.composer.aria')} rows={1} maxLength={8000} disabled={!allowed||group.archived} value={text} placeholder={group.archived?t('collaboration.composer.archived'):t('collaboration.composer.placeholder',{name:group.name})} aria-activedescendant={options.length>0?optionId(options[active]!):undefined} onKeyDown={onKeyDown} onMouseDown={()=>caretGeneration.current++} onFocus={()=>setFocused(true)} onBlur={()=>{caretGeneration.current++;closeOptions();setFocused(false)}} onChange={event=>{caretGeneration.current++;const value=event.target.value,query=groupMentionQuery(value,event.target.selectionStart??value.length);setText(value);setMentionQuery(query);if(!query)setResourceLauncher(false);setActiveOption(0)}}/>
   {(options.length>0||resourceLauncher)&&<ul id={'composer-options-'+draftKey} className={css.mentionOptions} role="listbox" onMouseDown={event=>event.preventDefault()} aria-label={t(resourceLauncher||roleOptions.length===0?'collaboration.composer.references':resources.length>0||workResources.length>0||files.length>0?'group.mention.pickAny':'group.mention.pick')}>
    {options.map((option,index)=>{const sectionOf=(item:ComposerOption)=>item.kind==='resource'?'group.mention.sectionResources':item.kind==='work-resource'?'group.mention.sectionLibrary':item.kind==='file'?'group.mention.sectionFiles':'group.mention.sectionEmployees',previous=options[index-1],section=!previous||sectionOf(previous)!==sectionOf(option)?t(sectionOf(option)):undefined
     return <Fragment key={optionId(option)}>{section&&<li role="presentation" className={css.mentionSection}>{section}</li>}<li id={optionId(option)} role="option" aria-selected={index===active} aria-disabled={blocked(option)} className={clsx(index===active&&css.mentionOptionActive,option.kind!=='all'&&option.kind!=='role'&&css.mentionResource)} onMouseDown={event=>{event.preventDefault();choose(option)}}>{option.kind==='all'?allLabel:option.kind==='role'?labelOf(option.role):option.kind==='resource'||option.kind==='work-resource'?<><FileText size={13} aria-hidden="true"/><span>{option.resource.title}</span><small>{referenced(optionReference(option))?t('group.mention.referenced'):t('collaboration.resources.versionLabel',{version:option.resource.version})}</small></>:<><Paperclip size={13} aria-hidden="true"/><span>{option.file.name}</span>{referenced(optionReference(option))&&<small>{t('group.mention.referenced')}</small>}</>}</li></Fragment>})}
    {resourceLauncher&&options.length===0&&<li role="presentation" className={css.mentionSection}>{t(resources.length===0&&workResources.length===0&&files.length===0?'collaboration.attachment.sectionEmpty':'group.materials.noMatch')}</li>}
   </ul>}
  </div>
  {(references.length>0||pending.length>0)&&<div className={css.attachmentChips}>
   {references.flatMap(reference=>{
    // 刚上传完成的附件由下面的待发送行呈现，不重复出一枚标签；已共享文件与群资料各自按原件名称出标签，移除只走这里。
    if(reference.kind==='attachment'&&pending.some(item=>item.attachmentId===reference.id))return []
    // 撤回或尚未读到名称时也保留标签与移除动作，不能留下不可见却占用引用名额的草稿。
    const title=reference.kind==='group-resource'?resources.find(item=>item.id===reference.id)?.title:reference.kind==='work-resource'?workResources.find(item=>item.id===reference.id)?.title:reference.kind==='attachment'?files.find(item=>item.attachmentId===reference.id)?.name:undefined
    const name=title??t(reference.kind==='attachment'?'group.mention.sectionFiles':reference.kind==='work-resource'?'group.mention.sectionLibrary':'group.mention.sectionResources')
    return [<span key={reference.kind+':'+reference.id} className={css.attachmentChip}>{name}{title===undefined&&' · v'+reference.version}<button type="button" aria-label={t('collaboration.attachment.remove',{name})} disabled={!allowed||group.archived} onClick={()=>removeReference(reference)}><X size={11}/></button></span>]})}
   {pending.map(item=><span key={item.key} {...(item.state==='failed'?{role:'alert'}:{})} className={clsx(css.attachmentChip,item.state==='failed'&&css.attachmentChipFailed)}>{item.name}{item.state==='uploading'&&<small>{t('collaboration.attachment.uploading')}</small>}{item.state==='failed'&&<button type="button" className={css.replyButton} onClick={()=>{if(hasPendingFile(item)){retryAttachment(item);return}removeAttachment(item);fileInput.current?.click()}}>{t('collaboration.attachment.retry')}</button>}<button type="button" aria-label={t('collaboration.attachment.remove',{name:item.name})} onClick={()=>removeAttachment(item)}><X size={11}/></button></span>)}
  </div>}
  {dragging&&<p className={css.hint} role="status">{t('collaboration.attachment.dropHint')}</p>}
  {workResourceError&&<p className={css.hint} role="alert">{t('group.library.unavailable')} <button type="button" onClick={retryWorkResources}>{t('common.retry')}</button></p>}
  {attachmentError&&<p className={css.hint} role="alert">{attachmentError}</p>}
  {pending.length>0&&<p className={css.hint} role="status">{t('collaboration.attachment.pending',{count:pending.length})}</p>}
  {mentions.length>=8&&<p className={css.hint} role="status">{t('group.mention.limit')}</p>}
  {referenceRoom<=0&&(resourceOptions.length>0||libraryOptions.length>0||fileOptions.length>0)&&<p className={css.hint} role="status">{t('collaboration.attachment.tooMany')}</p>}
  {sendError&&<p className={css.hint} role="alert">{sendError}</p>}
  {recoverPending&&!sending&&<div className={css.composerRecovery} role="status"><span>{t('collaboration.pending.description')}</span><button type="button" className={css.replyButton} onClick={recoverPending}>{t('collaboration.action.recover')}</button></div>}
  {sending&&<p className={css.hint} role="status">{t('collaboration.composer.sending')}</p>}
  {allNotice&&<p className={css.hint} role="status">{t('group.mention.allNotice')}</p>}
  <footer>
   {attachmentsEnabled&&<><input ref={node=>{fileInput.current=node;onAttachmentInput?.(node)}} type="file" multiple className={css.fileInput} tabIndex={-1} aria-hidden="true" onChange={event=>{pick(event.target.files);event.target.value=''}}/><button type="button" className={clsx(css.toolButton,css.addAttachment)} aria-label={t('collaboration.attachment.add')} title={t('collaboration.attachment.add')} disabled={!allowed||group.archived} onClick={()=>fileInput.current?.click()}><Plus size={19}/></button></>}
   <button type="button" className={css.toolButton} title={t('knowledge.ui.073')} aria-label={t('knowledge.ui.073')} aria-pressed={formatting} onClick={()=>setFormatting(value=>!value)}><CaseSensitive size={19}/></button>
   <div className={css.emojiAnchor}>
    <button type="button" className={css.toolButton} aria-label={t('collaboration.composer.emoji')} title={t('collaboration.composer.emoji')} disabled={!allowed||group.archived} onClick={(event:React.MouseEvent<HTMLButtonElement>)=>setEmojiOpener(event.currentTarget)}><Smile size={15}/></button>
    {emojiOpener&&<GroupEmojiPicker labelKey="collaboration.composer.emoji" onPick={emoji=>{insertEmoji(emoji);closeEmoji()}} onClose={closeEmoji}/>}
   </div>
   <button type="button" className={css.toolButton} aria-label={t('collaboration.composer.mention')} title={t('collaboration.composer.mention')} disabled={!allowed||group.archived} onClick={()=>insertTrigger(false)}><AtSign size={15}/></button>
   <button type="button" className={css.toolButton} title={t('collaboration.composer.references')} aria-label={t('collaboration.composer.references')} aria-haspopup="listbox" aria-expanded={resourceLauncher} aria-controls={resourceLauncher?'composer-options-'+draftKey:undefined} disabled={!allowed||group.archived} onMouseDown={event=>event.preventDefault()} onClick={()=>insertTrigger(true)}><FileText size={16}/></button>
   {focused&&!!text.trim()&&<span className={css.composerHint} role="status">{t('collaboration.composer.enterHint')}</span>}
   {group.archived&&<small>{t('collaboration.composer.archived')}</small>}
   <button type="submit" className={css.send} disabled={!canSend} aria-label={t('collaboration.composer.send')} title={t('collaboration.composer.send')}>{sending?<LoaderCircle size={18}/>:<SendHorizontal size={18}/>} </button>
  </footer>
 </form>
}

export function SavedGroupForm({open=true,permissions,channels,form,roles,profileName,close,save,error,draftChanged}:{open?:boolean;permissions?:ReactNode;channels?:ReactNode;form:FormState;roles:PreviewRole[];profileName:string;close:()=>void;save:(fields:GroupDefinition|GroupChangeFields)=>void|Promise<void>;error:string|undefined;draftChanged?:((draft:GroupCreationDraft)=>void)|undefined}){
 const {t}=useI18n()
 const allowed=useApplicationCapability('groups')

 const scopes=useBusinessScopes(),existing=form.kind==='change'?form.snapshot:undefined
 const nameInput=useRef<HTMLInputElement>(null),tabId=useId()
 const draft=form.kind==='create'?form.draft:undefined,team=form.kind==='create'?form.team:undefined
 const [name,setName]=useState(existing?.group.name??draft?.name??team?.name??''),[purpose,setPurpose]=useState(existing?.group.purpose??draft?.purpose??''),[scope,setScope]=useState(existing?.group.scope??draft?.scope??team?.scope??'general'),[announcement,setAnnouncement]=useState(existing?.group.announcement??''),[members,setMembers]=useState(existing?.members.flatMap(member=>member.roleId?[member.roleId]:[])??draft?.members??team?.memberRoleIds??[])
 const [coordinatorRoleId,setCoordinatorRoleId]=useState(existing?.group.coordinatorRoleId??draft?.coordinatorRoleId??team?.coordinatorRoleId??'')
 const [rules,setRules]=useState<GroupRules>(existing?.group.rules??draft?.rules??{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true})
 const addOnly=form.kind==='change'&&!!form.addMembers
 const [tab,setTab]=useState<'info'|'members'|'rules'|'permissions'|'channels'>(draft?.tab??'info'),[query,setQuery]=useState(draft?.query??''),[choosing,setChoosing]=useState(addOnly),[picked,setPicked]=useState<string[]>([]),[busy,setBusy]=useState(false)
 // 父页在业务导航期间仍保留草稿；正文卸载后按原来源范围恢复，而非继承另一个业务。
 useEffect(()=>{draftChanged?.({name,purpose,scope,members,...(coordinatorRoleId?{coordinatorRoleId}:{}),rules,tab:tab==='permissions'||tab==='channels'?'info':tab,query})},[name,purpose,scope,members,coordinatorRoleId,rules,tab,query])
 const memberSearch=useRef<HTMLInputElement>(null),formBody=useRef<HTMLDivElement>(null),addButton=useRef<HTMLButtonElement>(null),parentMembers=useRef<{query:string;scroll:number}>(),isPicker=!existing||choosing
 const readOnly=!!existing?.group.archived
 const tabs:(typeof tab)[]=['info','members','rules',...(permissions?['permissions' as const]:[]),...(channels?['channels' as const]:[])],tabButtons=useRef<Partial<Record<typeof tab,HTMLButtonElement|null>>>({})
 const labels={info:'collaboration.form.tab.info',members:'collaboration.form.tab.members',rules:'collaboration.form.tab.rules',permissions:'collaboration.form.tab.permissions',channels:'collaboration.form.tab.channels'} as const
 // 成员关系与执行资格分开：暂停同事可以入群，发言仍由服务端在岗与授权闸门判定。
 const existingIds=new Set(existing?.members.flatMap(member=>member.roleId?[member.roleId]:[])??[])
 const candidates=roles.filter(role=>(role.state!=='retired'||existingIds.has(role.id))&&(!team||team.memberRoleIds.includes(role.id))).sort((a,b)=>Number(existingIds.has(b.id))-Number(existingIds.has(a.id)))
 const candidateScopeLabel=(role:PreviewRole)=>role.scopes.map(value=>Object.hasOwn(scopes,value)?scopes[value as keyof typeof scopes]:value).join(' · ')
 const roleName=(role:PreviewRole)=>role.kind==='twin'?twinDisplayName(profileName,t):role.name
 const filtered=candidates.filter(role=>(isPicker?(!existing||!members.includes(role.id)):members.includes(role.id))).filter(role=>[roleName(role),role.duty,candidateScopeLabel(role)].some(value=>value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))
 useEffect(()=>{if(choosing||(!existing&&tab==='members'))memberSearch.current?.focus()},[choosing,tab])
 const title=t(choosing?'collaboration.form.addMembers':existing?'collaboration.form.edit':'collaboration.action.new')
 const startAdding=()=>{parentMembers.current={query,scroll:formBody.current?.scrollTop??0};setPicked([]);setQuery('');setChoosing(true)}
 const leavePicker=()=>{setChoosing(false);setQuery(parentMembers.current?.query??'');setPicked([]);requestAnimationFrame(()=>{if(formBody.current)formBody.current.scrollTop=parentMembers.current?.scroll??0;addButton.current?.focus({preventScroll:true})})}
 const submit=async()=>{
  if(busy||readOnly||!applicationPresentation.can('groups'))return
  if(!existing&&tab==='info'){if(name.trim())setTab('members');return}
  if(choosing&&!addOnly){setMembers(current=>[...new Set([...current,...picked])]);leavePicker();return}
  if(!name.trim()||(!addOnly&&members.length<1)||(addOnly&&!picked.length))return
  setBusy(true)
  try{if(existing)await save({name,...(purpose.trim()||existing.group.purpose!==undefined?{purpose}:{}),announcement,rules,memberRoleIds:addOnly?[...members,...picked]:members,pinned:existing.group.pinned,archived:existing.group.archived,...(existing.group.coordinatorRoleId||coordinatorRoleId?{coordinatorRoleId:members.includes(coordinatorRoleId)?coordinatorRoleId:null}:{})});else await save({name,...(purpose.trim()?{purpose}:{}),scope,announcement:'',rules,memberRoleIds:members,...(team?{source:team.source}:{}),...(coordinatorRoleId&&members.includes(coordinatorRoleId)?{coordinatorRoleId}:{})})}finally{setBusy(false)}
 }
 const moveTab=(event:React.KeyboardEvent<HTMLButtonElement>,index:number)=>{
  const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:undefined
  if(next===undefined)return
  event.preventDefault();setTab(tabs[next]!);tabButtons.current[tabs[next]!]?.focus()
 }
 const panelProps=(key:typeof tab)=>existing&&!choosing?{role:'tabpanel',id:tabId+'-'+key,'aria-labelledby':tabId+'-tab-'+key,hidden:tab!==key}:{hidden:key==='members'?(!choosing&&tab!=='members'):choosing||tab!==key}
 return <ContextDrawer open={open} title={title} close={close} canClose={!busy} initialFocus={addOnly?memberSearch:nameInput} className={clsx(css.dialog,css.groupDialog)}>
  <form onKeyDown={event=>{if(event.key==='Escape'&&choosing&&!addOnly){event.preventDefault();event.stopPropagation();leavePicker()}}} onSubmit={event=>{event.preventDefault();void submit()}}>
   {existing&&!choosing&&<div className={css.settingsTabs} role="tablist" aria-label={title}>{tabs.map((key,index)=><button key={key} ref={node=>{tabButtons.current[key]=node}} type="button" role="tab" id={tabId+'-tab-'+key} aria-controls={tabId+'-'+key} aria-selected={tab===key} tabIndex={tab===key?0:-1} onClick={()=>setTab(key)} onKeyDown={event=>moveTab(event,index)}>{t(labels[key])}{key==='members'&&<span>{members.length+1}</span>}</button>)}</div>}
   {!existing&&<ol className={css.createSteps} aria-label={title}><li aria-current={tab==='info'?'step':undefined}>1 · {t('collaboration.form.tab.info')}</li><li aria-current={tab==='members'?'step':undefined}>2 · {t('collaboration.form.selectMembers')}</li></ol>}
   <p className={css.groupFormNotice}>{t('collaboration.context.draftRetained')}</p>
   {error&&<p className={css.groupFormError} role="alert">{error}</p>}
   <CapabilityNotice capability="groups"/><CapabilityFields capability="groups"><div ref={formBody} className={css.groupFormBody}>
    <section {...panelProps('info')} className={css.groupInfoFields}>
     <label>{t('collaboration.form.name')}<input ref={nameInput} required readOnly={readOnly} maxLength={80} value={name} onChange={event=>setName(event.target.value)}/></label>
     <label>{t('group.settings.purpose')}<input readOnly={readOnly} maxLength={240} value={purpose} onChange={event=>setPurpose(event.target.value)}/></label>
     {existing?<label>{t('collaboration.form.announcement')}<textarea readOnly={readOnly} maxLength={4000} value={announcement} onChange={event=>setAnnouncement(event.target.value)} placeholder={t('collaboration.form.announcementPlaceholder')}/></label>:<label>{t('collaboration.form.scope')}<select disabled={!!team} value={scope} onChange={event=>setScope(event.target.value)}>{Object.entries(scopes).map(([id,label])=><option key={id} value={id}>{id==='general'?t('group.scope.crossBusiness'):label}</option>)}</select><small className={css.hint}>{t(scope==='general'?'group.scope.crossBusinessHint':'group.scope.dedicatedHint')}</small></label>}
     {existing&&<div className={css.groupScope}><span>{t('collaboration.form.scope')}</span><strong>{Object.hasOwn(scopes,scope)?scopes[scope]:scope}</strong></div>}
    </section>
    <section {...panelProps('members')}>
     {existing&&!choosing&&<div className={css.memberToolbar}><strong>{t('collaboration.members.savedCount',{count:members.length+1})}</strong><button ref={addButton} type="button" className={css.secondary} disabled={readOnly} onClick={startAdding}><Plus size={15}/>{t('collaboration.form.addMembers')}</button></div>}
     <label className={css.memberSearch}><Search size={16}/><input ref={memberSearch} aria-label={t('collaboration.form.searchMembers')} placeholder={t('collaboration.form.searchMembers')} value={query} onChange={event=>setQuery(event.target.value)}/></label>
     {isPicker&&!team&&(choosing?picked:members).length>0&&<div className={css.selectedMembers}>{(choosing?picked:members).map(id=>{const role=roles.find(item=>item.id===id);return <button type="button" key={id} onClick={()=>choosing?setPicked(current=>current.filter(value=>value!==id)):setMembers(current=>current.filter(value=>value!==id))} aria-label={t('collaboration.form.removeMember',{name:role?roleName(role):id})}>{role?roleName(role):id}<X size={12}/></button>})}</div>}
     <fieldset className={css.groupMembers}><legend>{t(isPicker?'collaboration.form.selectMembers':'collaboration.form.members')}</legend>
      {!choosing&&<div className={css.groupMemberChoice}><span className={css.avatar} aria-hidden="true">{profileName.slice(0,1)}</span><span className={css.memberIdentity}><strong>{profileName}</strong><small>{t('collaboration.message.selfRole')}</small></span><CheckCheck size={16} aria-hidden="true"/></div>}
      {filtered.map(role=><label key={role.id} className={css.groupMemberChoice}>{role.kind==='employee'?<EmployeeAvatar avatarKey={role.avatarKey} size="md"/>:<TwinAvatar initials={personalAvatarInitials(profileName)}/>}<span className={css.memberIdentity}><strong>{roleName(role)}<small className={css.memberScope}>{candidateScopeLabel(role)}</small></strong><small>{role.kind==='twin'?t('collaboration.member.twin'):role.duty}{role.state==='paused'?' · '+t('role.state.paused'):''}</small>{groupGrantBlock(role,scope)==='scope'&&<small>{t('group.members.notServingHint')}</small>}</span>{isPicker?<input type="checkbox" checked={(choosing?picked:members).includes(role.id)} disabled={readOnly||role.state==='retired'||!!team||(!(choosing?picked:members).includes(role.id)&&members.length+(choosing?picked.length:0)>=30)} onChange={event=>{const update=(current:string[])=>event.target.checked?[...new Set([...current,role.id])]:current.filter(id=>id!==role.id);if(choosing)setPicked(update);else setMembers(update)}}/>:<button type="button" className={css.replyButton} disabled={readOnly||members.length<2} aria-label={t('collaboration.form.removeMember',{name:roleName(role)})} onClick={()=>setMembers(current=>current.filter(id=>id!==role.id))}><X size={15}/></button>}</label>)}
      {!filtered.length&&<p className={css.hint}>{t(query.trim()?'collaboration.form.noMemberMatch':'collaboration.form.noCandidates')}</p>}
     </fieldset>
     {(existing||team)&&<label>{t('templateShare.coordinator')}<select aria-label={t('templateShare.coordinator')} disabled={readOnly||!!team} value={members.includes(coordinatorRoleId)?coordinatorRoleId:''} onChange={event=>setCoordinatorRoleId(event.target.value)}><option value="">{t('templateShare.noCoordinator')}</option>{members.map(id=>{const role=roles.find(row=>row.id===id);return <option key={id} value={id}>{role?roleName(role):id}{role?.state==='paused'?' · '+t('role.state.paused'):''}</option>})}</select></label>}
     {!existing&&<p className={css.boundary}>{t('collaboration.form.memberLimit')}</p>}
     {!existing&&<p className={css.boundary}>{t('collaboration.form.memberBoundary')}</p>}
     {team&&members.some(id=>roles.some(role=>role.id===id&&role.state==='paused'))&&<p className={css.boundary}>{t('templateShare.paused')}</p>}
    </section>
    {existing&&<section {...panelProps('rules')}><div className={css.groupRules}>{([['historyVisibleToNewMembers','collaboration.form.rule.history'],['draftsVisibleInGroup','collaboration.form.rule.drafts'],['mentionAllAllowed','collaboration.form.rule.mentionAll']] as const).map(([key,label])=><label className={css.groupRule} key={key}><span>{t(label)}</span><input type="checkbox" disabled={readOnly} checked={rules[key]} onChange={event=>setRules(current=>({...current,[key]:event.target.checked}))}/></label>)}</div><p className={css.boundary}>{t('collaboration.form.ruleBoundary')}</p></section>}
    {existing&&permissions&&<section {...panelProps('permissions')}>{permissions}</section>}
    {existing&&channels&&<section {...panelProps('channels')}>{channels}</section>}
   </div>
   </CapabilityFields><footer><button type="button" className={css.secondary} disabled={busy} onClick={()=>{if(choosing&&!addOnly)leavePicker();else if(!existing&&tab==='members')setTab('info');else close()}}>{t(choosing&&!addOnly||!existing&&tab==='members'?'collaboration.form.back':'collaboration.form.cancel')}</button><button type="submit" className={css.primary} disabled={!allowed||readOnly||busy||!name.trim()||(choosing?picked.length<1:tab==='info'&&!existing?false:members.length<1)}>{t(choosing?(addOnly?'collaboration.form.addMembers':'collaboration.form.confirmSelection'):existing?'collaboration.form.saveSettings':tab==='info'?'collaboration.form.next':'collaboration.action.new')}</button></footer>
  </form>
 </ContextDrawer>
}

export function SavedResourceForm({open=true,readOnly=false,form,close,discard,save,error}:{open?:boolean;readOnly?:boolean;form:ResourceForm;close:()=>void;discard:()=>void;save:(title:string,markdown:string)=>void|Promise<void>;error:string|undefined}){
 const {t}=useI18n()
 const allowed=useApplicationCapability('groups')
 const titleInput=useRef<HTMLInputElement>(null)
 const [title,setTitle]=useState(form.resource?.title??''),[markdown,setMarkdown]=useState(form.markdown),[busy,setBusy]=useState(false)
 return <ContextDrawer open={open} canClose={!busy} title={t(readOnly?'collaboration.context.materials':form.resource?'collaboration.resources.edit':'collaboration.resources.new')} close={close} className={clsx(css.dialog,css.lightDrawer)} initialFocus={titleInput}><form onSubmit={event=>{event.preventDefault();if(busy||readOnly||!applicationPresentation.can('groups'))return;setBusy(true);void Promise.resolve(save(title,markdown)).finally(()=>setBusy(false))}}><CapabilityNotice capability="groups"/><CapabilityFields capability="groups"><p className={css.hint}>{t('collaboration.resources.savedHint')}</p><p className={css.hint}>{t('collaboration.context.draftRetained')}</p>{error&&<p role="alert">{error}</p>}<label>{t('collaboration.resources.titleField')}<input ref={titleInput} required readOnly={readOnly} maxLength={120} value={title} onChange={event=>setTitle(event.target.value)}/></label><label>{t('collaboration.resources.bodyField')}<textarea required readOnly={readOnly} maxLength={16000} value={markdown} onChange={event=>setMarkdown(event.target.value)}/></label></CapabilityFields><footer><button type="button" className={css.secondary} disabled={busy} onClick={readOnly?close:discard}>{t(readOnly?'collaboration.panel.close':'collaboration.resources.discardDraft')}</button><button type="submit" className={css.primary} disabled={!allowed||readOnly||busy}>{t('collaboration.resources.save')}</button></footer></form></ContextDrawer>
}

/** 可读引用按 kind 分三组，粒度到单个固定版本；撤销授权恒定清空整份清单（revokeAgentGrant 恒定传空数组）。 */
function SavedAgentGrantForm({form,workResources,resources,attachments,artifacts,artifactSummaries,scope,openRole,close,save,error}:{form:AgentGrantForm;workResources:readonly WorkResource[];resources:GroupResource[];attachments:GroupAttachment[];artifacts:MessageReference[];artifactSummaries:Record<string,ArtifactSummaryState>;scope?:string|undefined;openRole?:((id:string)=>void)|undefined;close:()=>void;save:(resources:MessageReference[],canPost:boolean,canAutoRun:boolean)=>void;error:string|undefined}){
 const {t}=useI18n()
 const allowed=useApplicationCapability('groups')
 // 候选是「本群此刻还能授权的那几条固定版本」：资料改版、附件被撤回、成果引用被移出消息之后，
 // 旧授权里那几条已经不在任何一组里显示了。初始勾选与候选取交集、候选变化时再对账一次，
 // 免得界面上看不见的授权被这次保存原样重存回去。
 const candidateKeys=new Set([
  ...resources.map(resource=>referenceKey({kind:'group-resource',id:resource.id,version:resource.version})),
  ...workResources.map(resource=>referenceKey({kind:'work-resource',id:resource.id,version:resource.version})),
  ...attachments.map(attachment=>referenceKey({kind:'attachment',id:attachment.attachmentId,version:attachment.version})),
  ...artifacts.map(referenceKey),
 ])
 const granted=form.read.grant?.state==='active'?form.read.grant.resources:[]
 const [selected,setSelected]=useState<MessageReference[]>(granted.filter(item=>candidateKeys.has(referenceKey(item)))),[canPost,setCanPost]=useState(form.read.grant?.state==='active'?form.read.grant.canPost:false),[canAutoRun,setCanAutoRun]=useState(form.read.grant?.state==='active'?form.read.grant.canAutoRun:false)
 const candidateSignature=[...candidateKeys].sort().join('|')
 useEffect(()=>{setSelected(current=>{const next=current.filter(item=>candidateKeys.has(referenceKey(item)));return next.length===current.length?current:next})},[candidateSignature])
 // 三键齐全：同一份原件的两个固定版本是两条不同的授权，不能靠 kind+id 就判成同一条。
 const picked=(reference:MessageReference)=>selected.some(item=>referenceKey(item)===referenceKey(reference))
 const artifactTitle=(reference:MessageReference)=>{const summary=artifactSummaries[referenceKey(reference)];return summary?.state==='ready'?summary.title:t(summary?.state==='failed'?'collaboration.reference.artifactUnavailable':'collaboration.state.loading')}
 const toggle=(reference:MessageReference)=>setSelected(current=>current.some(item=>referenceKey(item)===referenceKey(reference))?current.filter(item=>referenceKey(item)!==referenceKey(reference)):[...current,reference])
 // 服务端只给服务本群业务的在岗员工保存授权：不满足时不展示必然保存失败的表单，说明原因并进入原员工档案；不扩大任何业务范围。
 const block=groupGrantBlock(form.role,scope)
 if(block)return <ContextDrawer title={t('collaboration.agentGrant.configure')} close={close} padded className={clsx(css.dialog,css.lightDrawer)}><p className={css.boundary} role="status">{t(block==='scope'?'group.grant.notServing':'group.grant.inactive',{name:form.role.name})}</p><footer>{openRole&&<button type="button" className={css.iconButton} aria-label={t('group.grant.openProfile')} title={t('group.grant.openProfile')} onClick={()=>openRole(form.role.id)}><UserRound size={18} aria-hidden/></button>}</footer></ContextDrawer>
 return <ContextDrawer title={t('collaboration.agentGrant.configure')} close={close} className={clsx(css.dialog,css.lightDrawer)}><form onSubmit={event=>{event.preventDefault();if(!applicationPresentation.can('groups'))return;save(selected,canPost,canAutoRun)}}><CapabilityNotice capability="groups"/><CapabilityFields capability="groups"><p className={css.hint}>{t('collaboration.agentGrant.formHint',{name:form.role.name})}</p>{error&&<p role="alert">{error}</p>}<h4 className={css.sectionTitle}>{t('collaboration.agentGrant.resources')}</h4><fieldset><legend>{t('collaboration.grant.section.resources')}</legend>{resources.length?resources.map(resource=><label key={resource.id} className={css.memberChoice}><input type="checkbox" checked={picked({kind:'group-resource',id:resource.id,version:resource.version})} onChange={()=>toggle({kind:'group-resource',id:resource.id,version:resource.version})}/><span>{resource.title}</span><small>{t('collaboration.resources.versionLabel',{version:resource.version})}</small></label>):<p className={css.hint}>{t('collaboration.resources.savedEmpty')}</p>}</fieldset><fieldset><legend>{t('group.mention.sectionLibrary')}</legend>{workResources.length?workResources.map(resource=><label key={resource.id+':'+resource.version} className={css.memberChoice}><input type="checkbox" checked={picked({kind:'work-resource',id:resource.id,version:resource.version})} onChange={()=>toggle({kind:'work-resource',id:resource.id,version:resource.version})}/><span>{resource.title}</span><small>v{resource.version}</small></label>):<p className={css.hint}>{t('collaboration.resources.savedEmpty')}</p>}</fieldset><fieldset><legend>{t('collaboration.grant.section.attachments')}</legend>{attachments.length?attachments.map(attachment=><label key={attachment.attachmentId} className={css.memberChoice}><input type="checkbox" checked={picked({kind:'attachment',id:attachment.attachmentId,version:attachment.version})} onChange={()=>toggle({kind:'attachment',id:attachment.attachmentId,version:attachment.version})}/><span>{attachment.name}</span><small>{t('collaboration.attachment.size',{size:byteLabel(attachment.bytes),type:attachment.mime})}</small></label>):<p className={css.hint}>{t('collaboration.attachment.sectionEmpty')}</p>}</fieldset><fieldset><legend>{t('collaboration.grant.section.artifacts')}</legend>{artifacts.length?artifacts.map(reference=><label key={reference.id+':'+reference.version} className={css.memberChoice}><input type="checkbox" checked={picked(reference)} onChange={()=>toggle(reference)}/><span>{artifactTitle(reference)}</span><small>{t('collaboration.resources.versionLabel',{version:reference.version})}</small></label>):<p className={css.hint}>{t('collaboration.grant.section.artifactsEmpty')}</p>}</fieldset><label className={css.memberChoice}><input type="checkbox" checked={canPost} onChange={event=>setCanPost(event.target.checked)}/><span>{t('collaboration.agentGrant.canPost')}</span></label><p className={css.hint}>{t('collaboration.grant.canPost.attachmentNote')}</p><label className={css.memberChoice}><input type="checkbox" checked={canAutoRun} onChange={event=>setCanAutoRun(event.target.checked)}/><span>{t('group.grant.canAutoRun')}</span></label><p className={css.hint}>{t('group.grant.canAutoRunHint')}</p>{form.role.kind==='twin'&&<p className={css.boundary}>{t('roleDelegation.requiresDelegation')}</p>}<p className={css.boundary}>{t('collaboration.agentGrant.runtimeBoundary')}</p></CapabilityFields><footer><button type="button" className={css.secondary} onClick={close}>{t('collaboration.form.cancel')}</button><button type="submit" className={css.primary} disabled={!allowed||!canPost&&!canAutoRun&&selected.length===0}>{t('collaboration.form.save')}</button></footer></form></ContextDrawer>
}


function SavedGroupTaskForm({form,groupName,members,roles,grants,scope,draft:savedDraft,saveDraft,close,create,error}:{form:GroupTaskForm;groupName:string;members:GroupSnapshot['members'];roles:PreviewRole[];grants:Record<string,GroupAgentGrantRead>;scope:string;draft?:GroupTaskDraft|undefined;saveDraft?:((draft:GroupTaskDraft)=>void)|undefined;close:()=>void;create:(goal:string,assignee?:{roleId:string;expectedVersion:number},businessTarget?:GroupTaskBusinessTarget)=>void;error:string|undefined}){
 const {t}=useI18n()
 const allowed=useApplicationCapability('groups')
 const goalInput=useRef<HTMLTextAreaElement>(null)
 const scopes=useBusinessScopes()
 const sourceObjects=useMemo(()=>{try{return parseBusinessRecordReferences(form.message.text)}catch{return []}},[form.message.text])
 const objectId=(object:{scope:string;type:string;id:string;version:number})=>JSON.stringify([object.scope,object.type,object.id,object.version])
 const initialScope=scope==='general'&&sourceObjects.length===1?sourceObjects[0]!.scope:scope
 const mentionRoleId=form.trigger==='mention'&&'mentions' in form.message?form.message.mentions[0]?.roleId:undefined
 const sourceRoleId=mentionRoleId??('runId' in form.message?form.message.authorId:undefined)
 const [draft,setDraft]=useState<GroupTaskDraft>(()=>savedDraft??{goal:form.trigger==='mention'?'':form.message.text,targetScope:initialScope,selectedObject:sourceObjects.length===1?objectId(sourceObjects[0]!):'',assigneeId:sourceRoleId&&groupTaskAssignees(members,roles,initialScope).some(role=>role.id===sourceRoleId)?sourceRoleId:''})
 const {targetScope,selectedObject,goal,assigneeId}=draft
 const change=(patch:Partial<GroupTaskDraft>)=>{const next={...draft,...patch};setDraft(next);saveDraft?.(next)}
 // 通用群承担交流；任务负责人按本人选定的目标业务过滤，不能继承整群所有员工的业务权限。
 const candidates=groupTaskAssignees(members,roles,targetScope)
 // 只预选明确提及或原消息的当前适任员工，不从正文或候选数量猜测；草稿优先保留。
 const assignee=candidates.find(role=>role.id===assigneeId)
 const object=sourceObjects.find(object=>object.scope===targetScope&&objectId(object)===selectedObject)
 const businessTarget=targetScope==='general'?undefined:{scope:targetScope,...(object?{object}:{})}
 // 群内发言授权读的是已经拉好的 groups/agent-grants/get 结果；还没读到时不猜测状态。
 const grant=assignee?grants[assignee.id]:undefined
 return <ContextDrawer title={t('collaboration.task.create')} close={close} className={clsx(css.dialog,css.lightDrawer,css.taskDrawer)} initialFocus={goalInput}>
  <form onSubmit={event=>{event.preventDefault();if(!applicationPresentation.can('groups')||businessTarget&&!assignee)return;create(goal,assignee?{roleId:assignee.id,expectedVersion:assignee.version}:undefined,businessTarget)}}>
   <CapabilityNotice capability="groups"/><CapabilityFields capability="groups">
    {error&&<p role="alert">{error}</p>}
    <p className={css.taskContext}><span>{groupName}</span><span>·</span><span>{scopes[targetScope]??targetScope}</span>{assignee&&<strong>{assignee.name}</strong>}</p>
    <label>{t('collaboration.task.goal')}<textarea ref={goalInput} rows={6} placeholder={t('group.task.goalExample')} required maxLength={8000} value={goal} onChange={event=>change({goal:event.target.value})}/></label>
    {grant&&grant.status!=='active'&&<p className={css.hint} role="status">{t('collaboration.task.grantMissing')}</p>}
    {businessTarget&&!assignee&&<p className={css.hint} role="status">{t('group.task.ownerRequired')}</p>}
    <details className={css.taskDetails}><summary>{t(businessTarget&&!assignee?'group.task.chooseAssignee':'group.task.adjust')}</summary>
     {scope==='general'&&<label>{t('group.task.business')}<select aria-label={t('group.task.business')} value={targetScope} onChange={event=>{const next=event.target.value;change({targetScope:next,selectedObject:'',assigneeId:assignee&&roleSupportsScope(assignee.scopes,next)?assigneeId:''})}}>{Object.entries(scopes).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>}
     {sourceObjects.some(object=>object.scope===targetScope)&&<label>{t('group.task.object')}<select aria-label={t('group.task.object')} value={selectedObject} onChange={event=>change({selectedObject:event.target.value})}><option value="">{t('group.task.noObject')}</option>{sourceObjects.filter(object=>object.scope===targetScope).map(object=><option key={objectId(object)} value={objectId(object)}>{object.type} · {object.id} · v{object.version}</option>)}</select></label>}
     <label>{t('collaboration.task.assignee')}<select aria-label={t('collaboration.task.assignee')} required={!!businessTarget} value={assigneeId} onChange={event=>{change({assigneeId:event.target.value});if(event.target.value)event.currentTarget.closest('details')?.removeAttribute('open')}}><option value="">{t('collaboration.task.unassigned')}</option>{candidates.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
     <p className={css.hint}>{t('group.task.targetHint')}</p><p className={css.hint}>{t('group.task.executionCheck')}</p>{!assignee&&<p className={css.hint}>{t('collaboration.task.assigneeHint')}</p>}
    </details>
   </CapabilityFields><footer><span className={css.taskCreateHint}>{t('collaboration.task.boundary')}</span><button type="button" className={css.secondary} onClick={close}>{t('collaboration.form.cancel')}</button><button type="submit" className={css.primary} disabled={!allowed||!!businessTarget&&!assignee}>{t('collaboration.task.create')}</button></footer>
  </form>
 </ContextDrawer>
}
