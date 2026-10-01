import {applyMarkdownCommand,type MarkdownCommand} from './knowledge-markdown-core.js'
import {ComposerPopover} from './ComposerPopover.js'
import menuCss from './ComposerPopover.module.css'
import {StaffAvatar} from './StaffAvatar.js'
import {Fragment,useEffect,useId,useMemo,useRef,useState} from 'react'
import {Bold,Italic,Link,List,ListOrdered,Quote,Code,CaseSensitive,SendHorizontal,LoaderCircle,Check,Bot,Info,Archive,ArrowLeft,ArrowUp,AtSign,CheckCheck,Download,FileText,MessageSquare,Paperclip,Pin,Plus,RefreshCw,Search,Smile,Users,X} from 'lucide-react'
import clsx from 'clsx'
import {MarkdownText,type MarkdownLabels} from '@deepseek-ai/dsh-client-ui-primitives'
import {groupAttachmentExtensions,groupAttachmentFileMediaTypes,groupAttachmentImageMediaTypes,groupAttachmentMaxBytesFor,groupReactionMessageIdsMax,groupReferenceMaxFiles,groupRoutingMessageIdsMax} from '@teloa/contract'
import type {Group,GroupAgentGrant,GroupAgentGrantRead,GroupAttachment,GroupChangeFields,GroupDefinition,GroupMention,GroupMessage,GroupReactionEmoji,GroupReactionSummary,GroupResource,GroupRoutingDecisionView,GroupRules,MessageReference} from '@teloa/contract'
import type {GroupAttachmentApi,OpenedAttachment,PendingAttachment} from './group-attachment-api.js'
import {GroupReactionBar} from './GroupReactionBar.js'
import type {GroupReactionApi} from './group-reaction-api.js'
import type {GroupRoutingApi} from './group-routing-api.js'
import {groupRoutingPending} from './group-routing-view.js'
import {openDialog} from './dialog-focus.js'
import {closeDirectoryDetailOnEscape} from './directory-focus.js'
import {returnPanelFocus} from './panel-focus.js'
import {GroupEmojiPicker} from './GroupReactionBar.js'
import type {GroupApi,GroupSnapshot,GroupTaskRecord} from './group-api.js'
import {useBusinessScopes} from './business-scope-context.js'
import type {PreviewRole} from './role-preview.js'
import {groupMentionCandidates,groupMentionLabel,groupMentionQuery,groupTaskAssignees,visibleSavedGroups} from './saved-collaboration-state.js'
import {savedCollaborationDrafts,type GroupDraftEntry} from './saved-collaboration-drafts.js'
import {twinDisplayName} from './team-presentation.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {scheduleGroupMessageRefresh} from './group-message-refresh.js'
import css from './CollaborationPage.module.css'

export type SavedConversationDirectory={refresh:()=>Promise<void>;open:()=>void;select:(id:string)=>void;createRequest:number;createHandled:()=>void}
type Props={directory?:SavedConversationDirectory|undefined;visible:boolean;api:GroupApi;attachments?:GroupAttachmentApi|undefined;reactions?:GroupReactionApi|undefined;routing?:GroupRoutingApi|undefined;openArtifact?:((artifactId:string)=>void)|undefined;target:{groupId:string;rootId:string}|null;roles:PreviewRole[];profileName:string}
type FormState={kind:'create'}|{kind:'change';snapshot:GroupSnapshot;addMembers?:boolean}
type ResourceForm={resource:GroupResource|undefined;markdown:string}
type AgentGrantForm={role:PreviewRole;read:GroupAgentGrantRead}
type GroupTaskForm={message:GroupMessage;trigger?:'mention'}
/** 只读稳定错误码，不读任何服务端文案。 */
const forbidden=(cause:unknown)=>!!cause&&typeof cause==='object'&&'code' in cause&&(cause as {code?:unknown}).code==='teloa/forbidden'
/** 一条 attachment 引用的取字节状态；group-resource 引用不进这张表，呈现照旧。 */
type OpenedReference={state:'loading'}|{state:'ready';opened:OpenedAttachment}|{state:'failed'}
/** 成果卡的元数据状态（标题／版本／文件清单，不含字节）。 */
type ArtifactSummaryState={state:'loading'}|{state:'ready';title:string;files:{snapshotId:string}[]}|{state:'failed'}
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
export function SavedCollaborationPage({visible,api,attachments,reactions,routing,openArtifact,target,roles,profileName,directory:conversationDirectory}:Props){
 const {locale,t,time}=useI18n()
 const scopes=useBusinessScopes()
 const scopeLabel=(value:string)=>Object.hasOwn(scopes,value)?scopes[value as keyof typeof scopes]:value
 const [directory,setDirectory]=useState<Group[]|undefined>(),[directoryError,setDirectoryError]=useState<string>(),[loading,setLoading]=useState(false)
 const [selected,setSelected]=useState<string>(),[snapshot,setSnapshot]=useState<GroupSnapshot>(),[messages,setMessages]=useState<GroupMessage[]|undefined>(),[resources,setResources]=useState<GroupResource[]|undefined>(),[topic,setTopic]=useState<GroupMessage[]|undefined>(),[rootId,setRootId]=useState<string>()
 const [query,setQuery]=useState(''),[scope,setScope]=useState<string>('all'),[archived,setArchived]=useState(false),[error,setError]=useState<string>(),[form,setForm]=useState<FormState>(),[resourceForm,setResourceForm]=useState<ResourceForm>(),[agentGrantForm,setAgentGrantForm]=useState<AgentGrantForm>(),[taskForm,setTaskForm]=useState<GroupTaskForm>(),[agentGrants,setAgentGrants]=useState<Record<string,GroupAgentGrantRead>>({}),[info,setInfo]=useState(false),[drafts,setDrafts]=useState<Record<string,string>>({}),[referenceDrafts,setReferenceDrafts]=useState<Record<string,MessageReference[]>>({}),[discarded,setDiscarded]=useState(false)
 const [mentionDrafts,setMentionDrafts]=useState<Record<string,GroupMention[]>>({}),[mentionAllDrafts,setMentionAllDrafts]=useState<Record<string,boolean>>({}),[mentionAllNotices,setMentionAllNotices]=useState<Record<string,boolean>>({})
 const [attachmentDrafts,setAttachmentDrafts]=useState<Record<string,PendingAttachment[]>>({}),[attachmentError,setAttachmentError]=useState<Record<string,string|undefined>>({}),[groupFiles,setGroupFiles]=useState<GroupAttachment[]|undefined>(),[withdrawTarget,setWithdrawTarget]=useState<GroupAttachment>()
 const [sending,setSending]=useState(false),sendLock=useRef(false)
 const [sendFailure,setSendFailure]=useState<{groupId:string;key:string;message:string}>()
 const [openedReferences,setOpenedReferences]=useState<Record<string,OpenedReference>>({}),[imageView,setImageView]=useState<OpenedAttachment>()
 // 表情汇总与路由决策都按「本群当前可见的消息身份」整批取回；两者都是叠在消息上的只读投影，不进任何写口。
 const [reactionItems,setReactionItems]=useState<GroupReactionSummary[]>([]),[routingDecisions,setRoutingDecisions]=useState<GroupRoutingDecisionView[]>([])
 // 成果卡先只取标题／版本／文件清单（describeArtifact，不取字节）；每个文件的字节等展开/单文件默认展开时才懒取（openArtifactFile）。
 const [artifactSummaries,setArtifactSummaries]=useState<Record<string,ArtifactSummaryState>>({}),[artifactFiles,setArtifactFiles]=useState<Record<string,ArtifactFileState>>({})
 const selectedGroup=useRef<string|undefined>(undefined),selectedRoot=useRef<string|undefined>(undefined),viewGeneration=useRef(0)
 const selectRoot=(value:string|undefined)=>{selectedRoot.current=value;setRootId(value)}
 const mainLog=useRef<HTMLDivElement>(null),topicLog=useRef<HTMLDivElement>(null),panelRef=useRef<HTMLElement>(null)
 const panelOpener=useRef<HTMLElement|null>(null),panelWasOpen=useRef(false)
 // 待发送附件的原始 File 只活在本次挂载里：失败重试要拿它重发同一个 requestId，草稿存储只存可序列化的那份状态。
 const pendingFiles=useRef(new Map<string,File>()),openedBlobs=useRef<OpenedAttachment[]>([]),requestedReferences=useRef(new Set<string>()),imageDialog=useRef<HTMLDialogElement>(null),imageCloseButton=useRef<HTMLButtonElement>(null),imageOpener=useRef<HTMLElement|null>(null)
 // 建过的 blob 地址只有这一个释放口：换群、卸载都从这里走，别处不许单独 revoke。
 const releaseOpenedBlobs=()=>{for(const item of openedBlobs.current)item.revoke();openedBlobs.current=[];requestedReferences.current.clear()}
 const refreshDirectory=async()=>{if(conversationDirectory){await conversationDirectory.refresh();return}setLoading(true);setDirectoryError(undefined);try{setDirectory((await api.list()).items)}catch(cause){setDirectoryError(localizeWorkError(locale,cause))}finally{setLoading(false)}}
 const readAgentGrants=async(next:GroupSnapshot)=>{const generation=viewGeneration.current;const entries=await Promise.all(next.members.flatMap(member=>member.roleId?[api.agentGrant(next.group.id,member.roleId).then(read=>[member.roleId,read] as const)]:[]));if(generation===viewGeneration.current)setAgentGrants(Object.fromEntries(entries))}
 // 群文件目录按群读；没有接入附件面（attachments 未传）时这一段整体不跑，界面也不出现附件入口。
 const readGroupFiles=async(id:string)=>{if(!attachments)return;try{const files=await attachments.list(id);if(selectedGroup.current===id)setGroupFiles(files)}catch(cause){if(selectedGroup.current===id)setError(localizeWorkError(locale,cause))}}
 /**
  * 表情汇总与路由决策按消息身份并发取回。两口各自 catch：读不回来只是这一轮没有新的表情或折叠行，
  * 绝不能把群目录刷新整体拖垮（也不读服务端文案，失败就保持上一轮的投影）。
  *
  * 契约两口各自封顶 200 条，超了在契约层就被拒。所以这里自己先截：**话题的消息全部优先**
  * （折叠行只在话题面板里看得见，截掉话题就等于这个功能没有），主目录只要最新的那一段——
  * 群聊超过 200 条时，旧消息的表情本来也已经滚出视线。
  */
 const readMessageOverlays=async(id:string,main:readonly GroupMessage[],replies:readonly GroupMessage[])=>{
  const generation=viewGeneration.current
  const cap=Math.min(groupReactionMessageIdsMax,groupRoutingMessageIdsMax)
  const replyIds=[...new Set(replies.map(message=>message.id))].slice(0,cap)
  const taken=new Set(replyIds),room=cap-replyIds.length
  // 主目录按「从新往旧」补满剩下的名额：先去重去掉话题里已经有的，再取尾。
  const ids=[...replyIds,...(room>0?[...new Set(main.map(message=>message.id))].filter(id=>!taken.has(id)).slice(-room):[])]
  if(!ids.length)return
  const [reactionRows,routingRows]=await Promise.all([reactions?.list(id,ids).catch(()=>undefined),routing?.list(id,ids).catch(()=>undefined)])
  if(generation!==viewGeneration.current)return
  if(reactionRows)setReactionItems(reactionRows)
  if(routingRows)setRoutingDecisions(routingRows)
 }
 const loadGroup=async(id:string,focusRoot?:string)=>{const generation=++viewGeneration.current;selectedGroup.current=id;setSelected(id);setSnapshot(undefined);setMessages(undefined);setResources(undefined);setAgentGrants({});setTopic(undefined);selectRoot(focusRoot);setInfo(false);setError(undefined);setGroupFiles(undefined);releaseOpenedBlobs();setOpenedReferences({});setArtifactSummaries({});setArtifactFiles({});setAttachmentError({});setReactionItems([]);setRoutingDecisions([]);const draftEntry=savedCollaborationDrafts.readGroupDraftEntry(id);setDrafts(draftEntry.drafts);setReferenceDrafts(draftEntry.referenceDrafts);setMentionDrafts(draftEntry.mentionDrafts);const readPending=Object.fromEntries(Object.entries(draftEntry.attachmentDrafts).map(([draftKey,items])=>[draftKey,normalizeReadPending(items)]));for(const [draftKey,items] of Object.entries(readPending))savedCollaborationDrafts.writeGroupAttachmentDrafts(id,draftKey,items);setAttachmentDrafts(readPending);setMentionAllDrafts({});setMentionAllNotices({});try{const [next,main,materials]=await Promise.all([api.get(id),api.messages(id),api.resources(id)]);if(generation!==viewGeneration.current)return;setSnapshot(next);setMessages(main.items);setResources(materials.items);void readAgentGrants(next).catch(cause=>{if(generation===viewGeneration.current)setError(localizeWorkError(locale,cause))});void readGroupFiles(id);const replies=focusRoot?(await api.messages(id,focusRoot)).items:[];if(generation!==viewGeneration.current)return;if(focusRoot)setTopic(replies);void readMessageOverlays(id,main.items,replies)}catch(cause){if(generation===viewGeneration.current)setError(localizeWorkError(locale,cause))}}
 /**
  * 4 秒轮询的唯一重读口：群、消息目录、群资料与当前话题一次并发取回，再按取回的真实消息身份
  * 取一次表情与路由决策（教训 b：话题面板以前不在这条闭环里，同事的回帖在界面上根本不出现）。
  */
 const reloadSelected=async(id=selected)=>{
  if(!id)return
  const generation=viewGeneration.current,currentRoot=selectedRoot.current
  try{
   const [next,main,materials,replies]=await Promise.all([api.get(id),api.messages(id),api.resources(id),currentRoot?api.messages(id,currentRoot):Promise.resolve(undefined)])
   if(generation!==viewGeneration.current||selectedGroup.current!==id)return
   setSnapshot(next);setMessages(main.items);setResources(materials.items)
   void readAgentGrants(next).catch(cause=>{if(generation===viewGeneration.current)setError(localizeWorkError(locale,cause))})
   if(replies)setTopic(replies.items)
   void readMessageOverlays(id,main.items,replies?.items??[])
  }catch(cause){if(generation===viewGeneration.current)setError(localizeWorkError(locale,cause))}
 }
 useEffect(()=>{if(visible&&!conversationDirectory)void refreshDirectory()},[visible,api,!!conversationDirectory])
 useEffect(()=>{if(conversationDirectory?.createRequest){setForm({kind:'create'});conversationDirectory.createHandled()}},[conversationDirectory?.createRequest])
 useEffect(()=>{if(target&&visible)void loadGroup(target.groupId,target.rootId||undefined)},[target?.groupId,target?.rootId,visible])
 // 数字员工完成原生运行后由宿主经过服务端闸门写入群消息；已打开的群只重读真实目录，
 // 不依据客户端推断生成结果，更不会把没有新消息误报为授权拒绝。
 useEffect(()=>{
  if(!visible||!selected||messages===undefined)return
  return scheduleGroupMessageRefresh(()=>reloadSelected(selected))
 },[visible,selected,messages,rootId,topic,api])
 // 消息里的 attachment 引用逐条取一次字节；取不到（撤回、读失败）一律落灰卡，不读服务端文案也不猜原因。
 // group-resource 引用不走这里，呈现照旧；artifact 引用走下面单独一段（先取标题/文件清单，字节按需懒取）。
 useEffect(()=>{
  const activeGroup=snapshot?.group
  if(!attachments||!activeGroup)return
  const wanted=new Map([...(messages??[]),...(topic??[])].flatMap(message=>message.references).filter(reference=>reference.kind==='attachment').map(reference=>[referenceKey(reference),reference] as const))
  for(const [key,reference] of wanted){
   if(requestedReferences.current.has(key))continue
   requestedReferences.current.add(key)
   setOpenedReferences(current=>({...current,[key]:{state:'loading'}}))
   void attachments.openReference(reference,activeGroup.id).then(value=>{
    if('kind' in value){setOpenedReferences(current=>({...current,[key]:{state:'failed'}}));return}
    openedBlobs.current.push(value)
    setOpenedReferences(current=>({...current,[key]:{state:'ready',opened:value}}))
   },()=>setOpenedReferences(current=>({...current,[key]:{state:'failed'}})))
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
 useEffect(()=>()=>releaseOpenedBlobs(),[])
 useEffect(()=>{
  if(imageView){openDialog(imageDialog.current,imageCloseButton.current);return}
  if(imageOpener.current){returnPanelFocus(imageOpener.current,document);imageOpener.current=null}
 },[imageView])
 useEffect(()=>{if(mainLog.current)mainLog.current.scrollTop=mainLog.current.scrollHeight},[messages?.length,selected])
 useEffect(()=>{if(topicLog.current)topicLog.current.scrollTop=topicLog.current.scrollHeight},[topic?.length,rootId])
 const group=snapshot?.group
 const mentionCandidates=snapshot?groupMentionCandidates(snapshot.members,roles):[]
 const rows=visibleSavedGroups(directory??[],query,scope,archived)
 const roots=(messages??[]).filter(message=>message.rootId===null)
 const repliesByRoot=new Map<string,GroupMessage[]>()
 for(const message of messages??[])if(message.rootId){const replies=repliesByRoot.get(message.rootId)??[];replies.push(message);repliesByRoot.set(message.rootId,replies)}
 // 成果授权的候选只来自本群消息里已经出现过的成果引用：授权粒度就是那一个固定版本。
 const artifactReferences=[...new Map([...(messages??[]),...(topic??[])].flatMap(message=>message.references).filter(reference=>reference.kind==='artifact').map(reference=>[referenceKey(reference),reference] as const)).values()]
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
 const refreshAfterWrite=async(value:GroupSnapshot|GroupMessage|GroupResource|GroupAgentGrant|GroupTaskRecord)=>{if('task' in value){await refreshDirectory();return}if('group' in value){if(value.group.id!==selected)conversationDirectory?.select(value.group.id);setSnapshot(value);setSelected(value.group.id);setMessages((await api.messages(value.group.id)).items)}else if(selectedGroup.current===value.groupId)await reloadSelected(value.groupId);await refreshDirectory()}
 const recover=async()=>{
  if(sendLock.current)return
  sendLock.current=true;setSending(true);setSendFailure(undefined);setError(undefined)
  const request=api.pending(),sent=request?.kind==='send'?request.request:undefined
  const key=sent?.rootId??'main',draft=sent?savedCollaborationDrafts.readGroupDraftEntry(sent.groupId):undefined
  const matches=sent&&draft&&draft.drafts[key]===sent.text&&JSON.stringify(draft.referenceDrafts[key]??[])===JSON.stringify(sent.references??[])&&JSON.stringify(draft.mentionDrafts[key]??[])===JSON.stringify(sent.mentions??[])&&(draft.attachmentDrafts[key]??[]).every(item=>item.state==='ready'&&sent.references?.some(ref=>ref.kind==='attachment'&&ref.id===item.attachmentId))
  try{
   const saved=await api.recover()
   if(matches&&sent&&draft)clearSentDraft(sent.groupId,key,draft)
   await refreshAfterWrite(saved)
  }catch(cause){if(sent)setSendFailure({groupId:sent.groupId,key,message:localizeWorkError(locale,cause)});else setError(localizeWorkError(locale,cause))}
  finally{sendLock.current=false;setSending(false)}
 }
 const save=async(fields:GroupDefinition|GroupChangeFields,expected=group)=>{setError(undefined);try{const value='scope' in fields?await api.create(fields):await api.change(expected!.id,expected!.version,fields);setForm(undefined);setArchived(false);setQuery('');setScope('all');await refreshAfterWrite(value)}catch(cause){setError(localizeWorkError(locale,cause))}}
 const organize=async(patch:Partial<Pick<GroupChangeFields,'pinned'|'archived'>>)=>{if(!group||!snapshot)return;await save({name:group.name,announcement:group.announcement,rules:group.rules,memberRoleIds:snapshot.members.flatMap(member=>member.roleId?[member.roleId]:[]),pinned:patch.pinned??group.pinned,archived:patch.archived??group.archived})}
 // 只清理已发出的那份草稿；回包或目录刷新期间的新输入不属于上一条消息。
 const clearSentDraft=(groupId:string,key:string,sent:GroupDraftEntry)=>{
  if(!savedCollaborationDrafts.clearGroupSentDraft(groupId,key,sent))return
  for(const item of sent.attachmentDrafts[key]??[])pendingFiles.current.delete(item.key)
  if(selectedGroup.current!==groupId)return
  setDrafts(current=>({...current,[key]:''}));setReferenceDrafts(current=>({...current,[key]:[]}));setMentionDrafts(current=>({...current,[key]:[]}));setAttachmentDrafts(current=>({...current,[key]:[]}));setMentionAllDrafts(current=>({...current,[key]:false}))
 }
 // 同一时刻只提交一条消息；未知结果保留原请求，核对成功前不覆盖为另一条消息。
 const sendMessage=async(root:string|undefined,all=false)=>{
  if(!group||sendLock.current||api.pending())return
  const key=root??'main',text=drafts[key]??''
  if(group.archived||!text.trim()||(attachmentDrafts[key]??[]).some(item=>item.state==='uploading'))return
  const sentDraft={drafts,referenceDrafts,mentionDrafts,attachmentDrafts},picks=all?[]:mentionDrafts[key]??[]
  sendLock.current=true;setSending(true);setSendFailure(undefined);setError(undefined)
  try{
   const saved=await api.send(group.id,group.version,text,root,referenceDrafts[key],picks.length?picks:undefined)
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
 const toggleReference=(key:string,resource:GroupResource)=>setReferenceDrafts(current=>{const references=current[key]??[],match=(reference:MessageReference)=>reference.kind==='group-resource'&&reference.id===resource.id,picked=references.some(match),next=picked?references.filter(reference=>!match(reference)):[...references,{kind:'group-resource',id:resource.id,version:resource.version} as MessageReference];if(group)savedCollaborationDrafts.writeGroupReferenceDrafts(group.id,key,next);return {...current,[key]:next}})
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
 const addAttachments=(key:string,files:readonly File[])=>{
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
 const retryAttachment=(key:string,item:PendingAttachment)=>{const file=pendingFiles.current.get(item.key);if(!file)return;setKeyError(key,undefined);patchPending(key,item.key,({message,...rest})=>({...rest,state:'uploading'}));void uploadAttachment(key,item,file)}
 const removeAttachment=(key:string,item:PendingAttachment)=>{
  pendingFiles.current.delete(item.key)
  patchPending(key,item.key,null)
  if(item.attachmentId&&group){const next=(referenceDrafts[key]??[]).filter(reference=>!(reference.kind==='attachment'&&reference.id===item.attachmentId));savedCollaborationDrafts.writeGroupReferenceDrafts(group.id,key,next);setReferenceDrafts(current=>({...current,[key]:next}))}
 }
 const withdrawAttachment=async(attachment:GroupAttachment)=>{if(!attachments||!group)return;setError(undefined);try{await attachments.withdraw(attachment.attachmentId,crypto.randomUUID());setWithdrawTarget(undefined);await readGroupFiles(group.id)}catch(cause){setError(localizeWorkError(locale,cause))}}
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
 const openResource=async(resource?:GroupResource)=>{if(!group)return;setError(undefined);try{const value=resource?await api.resource(group.id,resource.id,resource.version):undefined;setResourceForm({resource,markdown:value?.markdown??''})}catch(cause){setError(localizeWorkError(locale,cause))}}
 const saveResource=async(title:string,markdown:string)=>{if(!group||!resourceForm)return;setError(undefined);try{await api.saveResource(group.id,resourceForm.resource?.id??crypto.randomUUID(),resourceForm.resource?.version??0,title,markdown);setResourceForm(undefined);await reloadSelected()}catch(cause){setError(localizeWorkError(locale,cause))}}
 const withdrawResource=async(resource:GroupResource)=>{if(!group)return;setError(undefined);try{await api.withdrawResource(group.id,resource.id,resource.version);await reloadSelected()}catch(cause){setError(localizeWorkError(locale,cause))}}
 const saveAgentGrant=async(role:PreviewRole,selectedResources:MessageReference[],canPost:boolean,canAutoRun:boolean)=>{if(!group)return;setError(undefined);try{await refreshAfterWrite(await api.changeAgentGrant(group.id,role.id,group.version,role.version,'save',selectedResources,canPost,canAutoRun));setAgentGrantForm(undefined)}catch(cause){setError(localizeWorkError(locale,cause))}}
 // 撤销恒定不带资料、不给发言权、也不给自动运行权；本期只落位不接线，这里不读 canAutoRun 决定任何执行分支。
 const revokeAgentGrant=async(role:PreviewRole)=>{if(!group)return;setError(undefined);try{await refreshAfterWrite(await api.changeAgentGrant(group.id,role.id,group.version,role.version,'revoke',[],false,false))}catch(cause){setError(localizeWorkError(locale,cause))}}
 const createTask=async(message:GroupMessage,goal:string,assignee?:{roleId:string;expectedVersion:number},trigger?:'mention')=>{if(!group)return;setError(undefined);try{await refreshAfterWrite(await api.createTask(group.id,message.id,group.version,goal,assignee,trigger));setTaskForm(undefined)}catch(cause){setError(localizeWorkError(locale,cause))}}
 // 界面上只出现岗位名，绝不出现 roleId；历史成员按既有词条兜底。
 const roleNames=Object.fromEntries(roles.map(role=>[role.id,role.name]))
 /** 表情翻转用回执里的整条消息汇总原地换掉本地投影，不等下一轮轮询；失败由表情条自己落 group.reaction.failed。 */
 const toggleReaction=async(messageId:string,emoji:GroupReactionEmoji)=>{
  if(!group||!reactions)return
  const items=await reactions.toggle(group.id,messageId,emoji)
  setReactionItems(current=>[...current.filter(item=>item.messageId!==messageId),...items])
 }
 const reactionBar=(message:GroupMessage)=>group&&reactions?<GroupReactionBar messageId={message.id} items={reactionItems.filter(item=>item.messageId===message.id)} archived={group.archived} onToggle={emoji=>toggleReaction(message.id,emoji)} roleNames={roleNames}/>:null
 /**
  * 折叠行与停下副标题：都从 groups/routing/list 的决策视图纯派生（规格 §3.4），不读运行状态。
  * 一位直接显示名字，两位以上折叠成通用文案、展开后列名字；触发消息超过 30 分钟一律不再显示。
  */
 const routingRow=(message:GroupMessage)=>{
  const decision=routingDecisions.find(item=>item.messageId===message.id)
  if(!decision)return null
  const waiting=groupRoutingPending(decision,topic??[],Date.now())
  const named=waiting.map(roleId=>roleNames[roleId]??t('collaboration.message.historicalMember'))
  return <>
   {named.length===1&&<p className={css.hint} role="status">{t('group.routing.pendingNamed',{name:named[0]!})}</p>}
   {named.length>1&&<div role="status"><details className={css.hint}><summary>{t('group.routing.pending')}</summary><ul>{waiting.map((roleId,index)=><li key={roleId}>{named[index]}</li>)}</ul></details></div>}
   {decision.kind==='relay-stopped'&&<p className={css.hint} role="status">{t('group.routing.stoppedHint')}</p>}
  </>
 }
 const openTopic=async(message:GroupMessage)=>{if(!group)return;const generation=++viewGeneration.current;selectRoot(message.id);setInfo(false);setTopic(undefined);try{const replies=await api.messages(group.id,message.id);if(generation===viewGeneration.current)setTopic(replies.items)}catch(cause){if(generation===viewGeneration.current)setError(localizeWorkError(locale,cause))}}
 const panelOpen=!!(group&&(rootId||info))
 const closePanel=()=>{++viewGeneration.current;selectRoot(undefined);setInfo(false)}
 // 侧栏打开时把焦点交给它自己，关闭时还给打开它的按钮；面板始终是 aside，不借用原生 dialog 语义。
 useEffect(()=>{
  if(panelOpen&&!panelWasOpen.current){
   panelOpener.current=document.activeElement instanceof HTMLElement?document.activeElement:null
   panelRef.current?.focus({preventScroll:true})
  }else if(!panelOpen&&panelWasOpen.current){
   returnPanelFocus(panelOpener.current,document)
   panelOpener.current=null
  }
  panelWasOpen.current=panelOpen
 },[panelOpen])
 if(!visible)return null
 return <section className={clsx(css.page,conversationDirectory&&css.sharedDirectory)} aria-label={t('collaboration.saved.title')}>
   {!conversationDirectory&&<div className={css.preview}><strong>{t('collaboration.saved.title')}</strong><span>{t('collaboration.saved.description')}</span><button type="button" className={css.replyButton} disabled={loading} onClick={()=>void refreshDirectory()}><RefreshCw size={13}/>{t(loading?'collaboration.state.loading':'collaboration.action.refresh')}</button></div>}
   {(error||directoryError||notice)&&<div className={css.error} role="alert"><span>{notice?localizeWorkError(locale,notice):(error??directoryError)}{notice&&' '+t('recovery.nextStep')}</span>{!notice&&<button type="button" aria-label={t('collaboration.action.closeError')} onClick={()=>{setError(undefined);setDirectoryError(undefined)}}><X size={15}/></button>}{notice&&<button type="button" onClick={discardRecovery}>{t('recovery.discard')}</button>}</div>}
   {discarded&&<p role="status">{t('recovery.discarded')}</p>}
   {pending&&!group&&<div className={css.routeNotice} role="status"><span>{t('collaboration.pending.description')}</span><button type="button" onClick={()=>void recover()}>{t('collaboration.action.recover')}</button></div>}
   {reactionPending&&<div className={css.routeNotice} role="status"><span>{t('collaboration.pending.description')}</span><button type="button" aria-label={t('team.detail.recoverMemory')} disabled={recoveringReaction} onClick={()=>void recoverReaction()}>{t('collaboration.action.recover')}</button><button type="button" onClick={()=>{reactions?.discard();setDiscarded(true)}}>{t('recovery.discard')}</button></div>}
   <div className={clsx(css.layout,group&&css.hasSelection,group&&(rootId||info)&&css.withPanel)}>
    {!conversationDirectory&&<aside className={css.directory} aria-label={t('collaboration.directory.aria')}><header><div><h2>{t('collaboration.directory.title')}</h2><span>{t('collaboration.directory.subtitle')}</span></div><button type="button" className={css.iconButton} aria-label={t('collaboration.action.new')} onClick={()=>setForm({kind:'create'})}><Plus size={17}/></button></header>
     <label className={css.search}><Search size={14}/><input aria-label={t('collaboration.search.aria')} value={query} placeholder={t('collaboration.search.placeholder')} onChange={event=>setQuery(event.target.value)}/></label>
     <select className={css.scope} aria-label={t('collaboration.scope.aria')} value={scope} onChange={event=>setScope(event.target.value)}><option value="all">{t('collaboration.scope.all')}</option>{Object.entries(scopes).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select>
     <div className={css.tabs} aria-label={t('collaboration.directory.categories')}><button type="button" aria-pressed={!archived} onClick={()=>setArchived(false)}>{t('collaboration.directory.inbox')}</button><button type="button" aria-pressed={archived} onClick={()=>setArchived(true)}>{t('collaboration.directory.archived')}</button></div>
     <div className={css.groupList}>{directory===undefined&&!directoryError?<p className={css.hint} role="status">{t('collaboration.directory.loading')}</p>:rows.map(item=><button type="button" key={item.id} className={css.groupRow} aria-current={selected===item.id?'page':undefined} onClick={()=>void loadGroup(item.id)}><span className={css.mailRow}><span className={css.avatar} aria-hidden="true"><Users size={18}/></span><span className={css.mailBody}><span className={css.rowTop}><span>{t('collaboration.directory.group')}{item.pinned&&<Pin size={10}/>}</span><time dateTime={item.updatedAt}>{time(item.updatedAt)}</time></span><strong>{item.name}</strong></span></span><small>{item.announcement||t('collaboration.directory.noAnnouncement')}</small><em>{scopeLabel(item.scope)} · {t('collaboration.directory.savedRecord')}</em></button>)}
      {directory!==undefined&&!directoryError&&rows.length===0&&<p className={css.hint}>{t(directory.length===0?'collaboration.directory.empty':'collaboration.directory.noMatch')}</p>}</div>
    </aside>}
    <div className={css.discussion}>{!group?<div className={css.empty}><CheckCheck size={27}/><h1>{t(target?'collaboration.empty.locating':'collaboration.empty.title')}</h1><p>{t(target?'collaboration.empty.targetDescription':'collaboration.empty.description')}</p>{!target&&<button type="button" className={css.primary} onClick={()=>setForm({kind:'create'})}><Plus size={16}/>{t('collaboration.action.new')}</button>}</div>:<>
      <header className={css.groupHeader}><div className={css.heading}><button className={clsx(css.iconButton,css.mobileBack)} type="button" aria-label={t('collaboration.action.back')} onClick={()=>{if(conversationDirectory)conversationDirectory.open();else{setSelected(undefined);setSnapshot(undefined);setMessages(undefined)}}}><ArrowLeft size={18}/></button><span className={css.avatar} aria-hidden="true"><Users size={18}/></span><div><h1>{group.name}</h1><span>{scopeLabel(group.scope)}</span></div><button type="button" className={css.memberCountButton} aria-label={t('collaboration.settings.aria')} onClick={()=>setForm({kind:'change',snapshot:snapshot!})}><Users size={17}/>{t('collaboration.members.savedCount',{count:snapshot?.members.length??0})}</button></div><div className={css.actions}><button type="button" disabled={group.archived||!!pending} onClick={()=>setForm({kind:'change',snapshot:snapshot!,addMembers:true})}><Plus size={14}/>{t('collaboration.form.addMembers')}</button><button type="button" aria-label={t('collaboration.action.resources')} onClick={()=>{++viewGeneration.current;setInfo(value=>!value);selectRoot(undefined)}}><FileText size={14}/>{t('collaboration.action.resources')}</button>{conversationDirectory&&<button type="button" onClick={()=>{void reloadSelected();void refreshDirectory()}}><RefreshCw size={14}/>{t('collaboration.action.refresh')}</button>}<button type="button" disabled={!!pending} onClick={()=>void organize({pinned:!group.pinned})}><Pin size={14}/>{t(group.pinned?'collaboration.action.unpin':'collaboration.action.pin')}</button><button type="button" disabled={!!pending} onClick={()=>void organize({archived:!group.archived})}><Archive size={14}/>{t(group.archived?'collaboration.action.restore':'collaboration.action.archive')}</button><span>{t('collaboration.approval.boundary')}</span></div></header>
      {group.announcement&&<div className={css.announcement}><Pin size={15}/><span>{group.announcement}</span></div>}
      <div ref={mainLog} className={css.transcript} aria-label={t('collaboration.messages.aria')}>{messages===undefined?<p className={css.hint} role="status">{t('collaboration.messages.loading')}</p>:roots.length===0?<div className={css.empty}><CheckCheck size={27}/><h2>{t('collaboration.messages.start')}</h2><p>{t('collaboration.messages.startDescription')}</p></div>:roots.map(message=><Fragment key={message.id}><SavedMessage message={message} roleNames={roleNames} replies={repliesByRoot.get(message.id)??[]} openTopic={()=>void openTopic(message)} createTask={()=>setTaskForm({message})} reactions={reactionBar(message)} opened={openedReferences} artifactSummaries={artifactSummaries} artifactFiles={artifactFiles} openArtifactFile={openArtifactFile} attachmentBytes={attachmentBytes} openImage={openImage} openArtifact={openArtifact}/></Fragment>)}</div>
      <SavedComposer sending={sending} sendBlocked={!!pending} sendError={sendFailure?.groupId===group.id&&sendFailure.key==='main'?sendFailure.message:undefined} recoverPending={!rootId&&!!pending?()=>void recover():undefined} group={group} text={drafts.main??''} setText={value=>editDraftText('main',value)} references={referenceDrafts.main??[]} resources={(resources??[]).filter(resource=>resource.withdrawnAt===null)} toggleReference={resource=>toggleReference('main',resource)} attachmentsEnabled={!!attachments} pending={attachmentDrafts.main??[]} addFiles={files=>addAttachments('main',files)} retryAttachment={item=>retryAttachment('main',item)} removeAttachment={item=>removeAttachment('main',item)} attachmentError={attachmentError.main} hasPendingFile={item=>pendingFiles.current.has(item.key)} mentions={mentionDrafts.main??[]} candidates={mentionCandidates} draftKey="main" commitMention={(role,nextText)=>commitMention('main',role,nextText)} commitMentionAll={nextText=>commitMentionAll('main',nextText)} removeMention={roleId=>removeMention('main',roleId)} mentionAllAllowed={group.rules.mentionAllAllowed} mentionAll={!!mentionAllDrafts.main} allNotice={!!mentionAllNotices.main} send={()=>void send(undefined)} sendAll={()=>void sendMentionAll(undefined)}/>
    </>}</div>
    {group&&(rootId||info)&&<aside ref={panelRef} tabIndex={-1} onKeyDown={event=>closeDirectoryDetailOnEscape(event,closePanel)} className={css.panel} aria-label={t(rootId?'collaboration.panel.topic':'collaboration.panel.context')}><header><strong>{t(rootId?'collaboration.panel.topic':'collaboration.panel.context')}</strong><button type="button" className={css.iconButton} aria-label={t('collaboration.panel.close')} onClick={closePanel}><X size={18}/></button></header>{rootId?<><div ref={topicLog} className={css.topicMessages}>{topic===undefined?<p className={css.hint} role="status">{t('collaboration.topic.loading')}</p>:topic.map(message=><Fragment key={message.id}><SavedMessage message={message} roleNames={roleNames} createTask={()=>setTaskForm({message})} reactions={reactionBar(message)} opened={openedReferences} artifactSummaries={artifactSummaries} artifactFiles={artifactFiles} openArtifactFile={openArtifactFile} attachmentBytes={attachmentBytes} openImage={openImage} openArtifact={openArtifact}/>{routingRow(message)}</Fragment>)}</div>{currentRoot&&<SavedComposer sending={sending} sendBlocked={!!pending} sendError={sendFailure?.groupId===group.id&&sendFailure.key===currentRoot.id?sendFailure.message:undefined} recoverPending={pending?()=>void recover():undefined} group={group} text={drafts[currentRoot.id]??''} setText={value=>editDraftText(currentRoot.id,value)} references={referenceDrafts[currentRoot.id]??[]} resources={(resources??[]).filter(resource=>resource.withdrawnAt===null)} toggleReference={resource=>toggleReference(currentRoot.id,resource)} attachmentsEnabled={!!attachments} pending={attachmentDrafts[currentRoot.id]??[]} addFiles={files=>addAttachments(currentRoot.id,files)} retryAttachment={item=>retryAttachment(currentRoot.id,item)} removeAttachment={item=>removeAttachment(currentRoot.id,item)} attachmentError={attachmentError[currentRoot.id]} hasPendingFile={item=>pendingFiles.current.has(item.key)} mentions={mentionDrafts[currentRoot.id]??[]} candidates={mentionCandidates} draftKey={currentRoot.id} commitMention={(role,nextText)=>commitMention(currentRoot.id,role,nextText)} commitMentionAll={nextText=>commitMentionAll(currentRoot.id,nextText)} removeMention={roleId=>removeMention(currentRoot.id,roleId)} mentionAllAllowed={group.rules.mentionAllAllowed} mentionAll={!!mentionAllDrafts[currentRoot.id]} allNotice={!!mentionAllNotices[currentRoot.id]} send={()=>void send(currentRoot.id)} sendAll={()=>void sendMentionAll(currentRoot.id)}/>}</>:<div className={css.info}>
      <p className={css.relationshipIntro}>{t('collaboration.context.intro')}</p>
      <div className={css.relationships}>
       <section className={css.relationshipCard}><header><h3>{t('collaboration.access.members.title')}</h3><span>{t('collaboration.state.saved')}</span></header><p>{t('collaboration.access.members.description')}</p><div className={css.memberList}>{snapshot?.members.map(member=>{const role=roles.find(item=>item.id===member.roleId),name=member.roleId===null?t('collaboration.message.self'):role?.name??t('collaboration.message.historicalMember'),detail=member.roleId===null?t('collaboration.message.selfRole'):role?.duty??member.roleId;return <div className={css.member} key={member.roleId??'self'}>{role?.kind==='employee'?<StaffAvatar initial={name.slice(0,1)} seed={role.id} size="md"/>:<span className={clsx(css.avatar,css.human)}>{name.slice(0,1)}</span>}<span><strong>{name}</strong><small>{detail}</small></span></div>})}</div><button type="button" className={css.secondary} onClick={()=>setForm({kind:'change',snapshot:snapshot!})}>{t('collaboration.action.editGroup')}</button></section>
       <section className={css.relationshipCard}><header><h3>{t('collaboration.access.materials.title')}</h3><span>{t('collaboration.state.saved')}</span></header><h4 className={css.sectionTitle}>{t('collaboration.access.resources.title')}</h4><p>{t('collaboration.access.resources.description')}</p><p className={css.boundary}>{t('collaboration.resources.savedHint')}</p><div className={css.resourceList}>{resources===undefined?<p className={css.hint} role="status">{t('collaboration.state.loading')}</p>:resources.length===0?<p className={css.hint}>{t('collaboration.resources.savedEmpty')}</p>:resources.map(resource=><div className={css.resource} key={resource.id}><div><strong>{resource.title}</strong><small>{t('collaboration.resources.versionLabel',{version:resource.version})}{resource.withdrawnAt!==null&&' · '+t('collaboration.resources.unavailable')}</small></div>{resource.withdrawnAt===null&&<span><button type="button" className={css.replyButton} disabled={group.archived||!!pending} onClick={()=>void openResource(resource)}>{t('collaboration.resources.edit')}</button><button type="button" className={css.replyButton} disabled={group.archived||!!pending} onClick={()=>void withdrawResource(resource)}>{t('collaboration.resources.withdrawSaved')}</button></span>}</div>)}</div><button type="button" className={css.secondary} disabled={group.archived||!!pending} onClick={()=>void openResource()}>{t('collaboration.resources.new')}</button>{attachments&&<><h4 className={css.sectionTitle}>{t('collaboration.attachment.section')}</h4><p className={css.boundary}>{t('collaboration.attachment.sectionHint')}</p><div className={css.resourceList}>{groupFiles===undefined?<p className={css.hint} role="status">{t('collaboration.state.loading')}</p>:groupFiles.length===0?<p className={css.hint}>{t('collaboration.attachment.sectionEmpty')}</p>:[...groupFiles].sort((left,right)=>right.createdAt.localeCompare(left.createdAt)).map(file=><div className={css.resource} key={file.attachmentId}><div><strong>{file.name}</strong><small>{t('collaboration.attachment.size',{size:byteLabel(file.bytes),type:file.mime})}{' · '}<time dateTime={file.createdAt}>{time(file.createdAt)}</time></small></div><span><button type="button" className={css.replyButton} disabled={group.archived||!!pending} onClick={()=>setWithdrawTarget(file)}>{t('collaboration.attachment.withdraw')}</button></span></div>)}</div></>}</section>
       <section className={css.relationshipCard}><header><h3>{t('collaboration.agentGrant.title')}</h3><span>{t('collaboration.state.saved')}</span></header><p>{t('collaboration.agentGrant.description')}</p><div className={css.memberList}>{snapshot?.members.flatMap(member=>member.roleId?[member]:[]).map(member=>{const role=roles.find(item=>item.id===member.roleId);if(!role)return null;const read=agentGrants[role.id];return <div className={css.member} key={role.id}><StaffAvatar initial={role.name.slice(0,1)} seed={role.id} size="md"/><span><strong>{role.name}</strong><small>{t(`collaboration.agentGrant.status.${read?.status??'not-granted'}`)}</small></span><span><button type="button" className={css.replyButton} disabled={!read||group.archived||!!pending} onClick={()=>read&&setAgentGrantForm({role,read})}>{t('collaboration.agentGrant.configure')}</button>{read?.status==='active'&&<button type="button" className={css.replyButton} disabled={!!pending} onClick={()=>void revokeAgentGrant(role)}>{t('collaboration.agentGrant.revoke')}</button>}</span></div>})}</div></section>
       <section className={css.relationshipCard}><header><h3>{t('collaboration.access.capabilities.title')}</h3><span>{t('collaboration.state.pendingIntegration')}</span></header><p>{t('collaboration.access.capabilities.description')}</p></section>
       <section className={css.relationshipCard}><header><h3>{t('collaboration.access.permissions.title')}</h3><span>{t('collaboration.access.runtimeVerified')}</span></header><p>{t('collaboration.access.permissions.description')}</p><dl className={css.permissionFacts}><div><dt>{t('collaboration.field.businessScope')}</dt><dd>{scopeLabel(group.scope)}</dd></div><div><dt>{t('collaboration.field.groupPosting')}</dt><dd>{t('collaboration.value.selfOnly')}</dd></div><div><dt>{t('collaboration.field.approvalExecution')}</dt><dd>{t('collaboration.value.notGranted')}</dd></div></dl></section>
      </div>
     </div>}</aside>}
   </div>
   {form&&<SavedGroupForm form={form} roles={roles} profileName={profileName} close={()=>setForm(undefined)} save={fields=>save(fields,form.kind==='change'?form.snapshot.group:undefined)} error={error}/>}
   {resourceForm&&<SavedResourceForm form={resourceForm} close={()=>setResourceForm(undefined)} save={saveResource} error={error}/>}
   {taskForm&&group&&snapshot&&<SavedGroupTaskForm form={taskForm} members={snapshot.members} roles={roles} grants={agentGrants} scope={group.scope} close={()=>setTaskForm(undefined)} create={(goal,assignee)=>void createTask(taskForm.message,goal,assignee,taskForm.trigger)} error={error}/>}
   {agentGrantForm&&group&&<SavedAgentGrantForm form={agentGrantForm} resources={(resources??[]).filter(resource=>resource.withdrawnAt===null)} attachments={groupFiles??[]} artifacts={artifactReferences} close={()=>setAgentGrantForm(undefined)} save={(selectedResources,canPost,canAutoRun)=>void saveAgentGrant(agentGrantForm.role,selectedResources,canPost,canAutoRun)} error={error}/>}
   {withdrawTarget&&<SavedAttachmentWithdrawForm attachment={withdrawTarget} close={()=>setWithdrawTarget(undefined)} confirm={()=>void withdrawAttachment(withdrawTarget)} error={error}/>}
   {imageView&&<dialog ref={imageDialog} className={css.imageDialog} aria-label={t('collaboration.attachment.dialogTitle',{name:imageView.name})} onCancel={closeImage}><header><h2>{imageView.name}</h2><button ref={imageCloseButton} type="button" className={css.iconButton} aria-label={t('collaboration.attachment.close')} onClick={closeImage}><X size={18}/></button></header><img className={css.fullImage} src={imageView.blobUrl} alt={imageView.name}/></dialog>}
 </section>
}

type MessageViewProps={opened:Record<string,OpenedReference>;artifactSummaries:Record<string,ArtifactSummaryState>;artifactFiles:Record<string,ArtifactFileState>;openArtifactFile:(reference:MessageReference,snapshotId:string)=>void;attachmentBytes:(attachmentId:string)=>number|undefined;openImage:(opened:OpenedAttachment,anchor:HTMLElement|null)=>void;openArtifact?:((artifactId:string)=>void)|undefined}

/** 摘录只输出纯文本，不加载图片或生成可点击链接。 */
export function groupReplyExcerpt(text:string):string{
 return text.replace(/^```[^\n]*$/gm,'').replace(/!?\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+\.\s+)/gm,'').replace(/\*\*([^*]+)\*\*|__([^_]+)__/g,(_match,bold,under)=>bold??under).replace(/`([^`]+)`/g,'$1').replace(/\s+/g,' ').trim().slice(0,180)
}

export function GroupReplyPreview({replies,roleNames,open}:{replies:GroupMessage[];roleNames:Record<string,string>;open:()=>void}){
 const {t,time,dateTime}=useI18n()
 const ordered=[...replies].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id)),latest=ordered.at(-1)
 if(!latest)return null
 const author=(message:GroupMessage)=>'runId' in message?roleNames[message.authorId]??t('collaboration.message.historicalMember'):t('collaboration.message.self')
 const participants=[...new Map([...ordered].reverse().map(message=>['runId' in message?'role:'+message.authorId:'self',message])).values()]
 const excerpt=groupReplyExcerpt(latest.text)||t('collaboration.reply.sharedReference')
 return <button type="button" className={css.threadPreview} onClick={open}>
  <span className={css.threadMeta}><span className={css.threadAvatars} aria-hidden="true">{participants.slice(0,3).map(message=><span key={'runId' in message?message.authorId:'self'} title={author(message)}>{'runId' in message?<StaffAvatar initial={author(message).slice(0,1)} seed={message.authorId} size="sm"/>:<span className={clsx(css.avatar,css.human)}>{author(message).slice(0,1)}</span>}</span>)}{participants.length>3&&<span className={css.extraAuthors}>+{participants.length-3}</span>}</span><strong>{t('collaboration.reply.count',{count:ordered.length})}</strong><time dateTime={latest.createdAt} title={dateTime(latest.createdAt)}>{time(latest.createdAt)}</time></span>
  <span className={css.threadExcerpt}><strong>{author(latest)}</strong><span>{excerpt}</span></span>
 </button>
}

/**
 * 本人与同事的消息共用这一套渲染：引用按 kind 分流，员工消息也只读呈现，
 * 没有任何「加引用」「改引用」入口（规格 §6.5）。
 * 同事那一条的作者名取群成员名（`roleNames` 按 `authorId`（即 roleId）查），头像取这个名字的首字；
 * 查不到的按「历史成员」兜底。「受管回传」仍是名字右侧那个小标记，不再有通用标签当名字用。
 */
function SavedMessage({message,replies,openTopic,createTask,reactions,roleNames,opened,artifactSummaries,artifactFiles,openArtifactFile,attachmentBytes,openImage,openArtifact}:{message:GroupMessage;replies?:GroupMessage[];openTopic?:()=>void;createTask?:()=>void;reactions?:React.ReactNode;roleNames?:Record<string,string>}&MessageViewProps){const {t,time,locale}=useI18n();const employee='runId' in message,name=employee?roleNames?.[message.authorId]??t('collaboration.message.historicalMember'):t('collaboration.message.self'),role=t(employee?'collaboration.message.employeeRole':'collaboration.message.selfRole');const resourceReferences=message.references.filter(reference=>reference.kind==='group-resource'),fileReferences=message.references.filter(reference=>reference.kind!=='group-resource')
 // labels 引用按 locale 稳定一份；MarkdownText 文档要求新身份会丢弃流式渲染缓存。
 const markdownLabels=useMemo<MarkdownLabels>(()=>({code:{copyLabel:t('collaboration.markdown.code.copyLabel'),copiedLabel:t('collaboration.markdown.code.copiedLabel')},footnotes:t('collaboration.markdown.footnotes')}),[locale])
 return <article className={css.message} data-teloa-message="true">{employee?<StaffAvatar initial={name.slice(0,1)} seed={message.authorId} size="md"/>:<span className={clsx(css.avatar,css.human)}>{name.slice(0,1)}</span>}<div><header><strong>{name}</strong>{employee?<span role="img" aria-label={t('team.form.employee')} title={t('team.form.employee')}><Bot size={13} aria-hidden="true"/></span>:<span>{role}</span>}<time dateTime={message.createdAt}>{time(message.createdAt)}</time></header><div className={css.markdown}><MarkdownText text={message.text} labels={markdownLabels}/></div>{employee&&<details className={css.messageSource}><summary><Info size={12} aria-hidden="true"/>{t('collaboration.message.sourceDetails')}</summary><p>{t('collaboration.message.runSource',{runId:message.runId.slice(0,8)})}</p></details>}{resourceReferences.length>0&&<p className={css.hint}>{t('collaboration.message.references',{references:resourceReferences.map(reference=>reference.id.slice(0,8)+' · v'+reference.version).join(', ')})}</p>}{fileReferences.length>0&&<div className={css.referenceCards}>{fileReferences.map(reference=><SavedReferenceCard key={referenceKey(reference)} reference={reference} opened={opened[referenceKey(reference)]} artifactSummary={artifactSummaries[referenceKey(reference)]} artifactFiles={artifactFiles} openArtifactFile={openArtifactFile} bytes={reference.kind==='attachment'?attachmentBytes(reference.id):undefined} openImage={openImage} openArtifact={openArtifact}/>)}</div>}{reactions&&<div className={css.reactions}>{reactions}</div>}{openTopic&&!!replies?.length&&<GroupReplyPreview replies={replies} roleNames={roleNames??{}} open={openTopic}/>}{(openTopic||createTask)&&<div className={css.messageActions}>{openTopic&&!replies?.length&&<button type="button" className={css.replyButton} onClick={openTopic}><MessageSquare size={13}/>{t('collaboration.reply.action')}</button>}{createTask&&<button type="button" className={css.replyButton} onClick={createTask}>{t('collaboration.task.create')}</button>}</div>}</div></article>}

/**
 * 一条 attachment 引用的呈现：图片内嵌缩略图并可点开大图，文件（含 GIF、SVG、HTML）只给下载不预览，
 * 取不到字节一律灰卡且不给下载。图片地址只会是 blob:，正文一路按文本渲染，不走任何原始 HTML 注入口。
 * artifact 引用另走 SavedArtifactCard：成果可能关联多个文件，标题/版本/文件清单与逐个文件的字节分两步取。
 */
function SavedReferenceCard({reference,opened,artifactSummary,artifactFiles,openArtifactFile,bytes,openImage,openArtifact}:{reference:MessageReference;opened:OpenedReference|undefined;artifactSummary:ArtifactSummaryState|undefined;artifactFiles:Record<string,ArtifactFileState>;openArtifactFile:(reference:MessageReference,snapshotId:string)=>void;bytes:number|undefined;openImage:(opened:OpenedAttachment,anchor:HTMLElement|null)=>void;openArtifact?:((artifactId:string)=>void)|undefined}){
 const {t}=useI18n()
 if(reference.kind==='artifact')return <SavedArtifactCard reference={reference} summary={artifactSummary} files={artifactFiles} openArtifactFile={openArtifactFile} openImage={openImage} openArtifact={openArtifact}/>
 if(!opened||opened.state==='loading')return <div className={css.referenceCard}><span className={css.hint} role="status">{t('collaboration.state.loading')}</span></div>
 if(opened.state==='failed')return <div className={clsx(css.referenceCard,css.referenceUnavailable)}><span>{t('collaboration.attachment.withdrawn')}</span></div>
 const file=opened.opened,preview=imageMime(file.mime)
 const thumbnail=<button type="button" className={css.thumbnail} aria-label={t('collaboration.attachment.open',{name:file.name})} onClick={event=>openImage(file,event.currentTarget)}><img src={file.blobUrl} alt={file.name}/></button>
 const download=<a className={css.replyButton} href={file.blobUrl} download={file.name}><Download size={13}/>{t('collaboration.attachment.download',{name:file.name})}</a>
 if(preview)return <div className={css.referenceCard}>{thumbnail}</div>
 return <div className={clsx(css.referenceCard,css.fileRow)}><FileText size={15}/><span className={css.fileName}>{file.name}</span>{bytes!==undefined&&<small>{t('collaboration.attachment.size',{size:byteLabel(bytes),type:file.mime})}</small>}{download}</div>
}

/**
 * 成果卡：标题/版本/文件清单来自 describeArtifact（不含字节）；只关联一个文件时默认展开（沿用旧体验，
 * 一打开就能看/下载），关联多个文件时默认收起，用户点开 <details> 才逐个懒取字节（onToggle 触发
 * openArtifactFile），避免一次性把整份成果的所有文件都拉下来。图片内嵌缩略图，SVG／HTML 只给下载。
 * 字节还没取到（含收起未展开）的文件行先按 snapshotId 前 8 位占位；取字节失败的行灰显且不给下载。
 */
function SavedArtifactCard({reference,summary,files,openArtifactFile,openImage,openArtifact}:{reference:MessageReference;summary:ArtifactSummaryState|undefined;files:Record<string,ArtifactFileState>;openArtifactFile:(reference:MessageReference,snapshotId:string)=>void;openImage:(opened:OpenedAttachment,anchor:HTMLElement|null)=>void;openArtifact?:((artifactId:string)=>void)|undefined}){
 const {t}=useI18n()
 if(!summary||summary.state==='loading')return <div className={css.referenceCard}><span className={css.hint} role="status">{t('collaboration.state.loading')}</span></div>
 if(summary.state==='failed')return <div className={clsx(css.referenceCard,css.referenceUnavailable)}><span>{t('collaboration.reference.artifactUnavailable')}</span></div>
 return <details className={clsx(css.referenceCard,css.artifactCard)} open={summary.files.length<=1} onToggle={event=>{if((event.target as HTMLDetailsElement).open)for(const file of summary.files)openArtifactFile(reference,file.snapshotId)}}>
  <summary><strong>{t('collaboration.reference.artifactCard',{title:summary.title,version:reference.version,count:summary.files.length})}</strong></summary>
  {summary.files.map(file=>{
   const state=files[artifactFileKey(reference,file.snapshotId)],placeholder=file.snapshotId.slice(0,8)
   if(!state||state.state==='loading')return <div key={file.snapshotId} className={css.fileRow}><FileText size={15}/><span className={css.fileName}>{placeholder}</span></div>
   if(state.state==='failed')return <div key={file.snapshotId} className={clsx(css.fileRow,css.referenceUnavailable)}><FileText size={15}/><span className={css.fileName}>{placeholder}</span></div>
   const item=state.opened,preview=imageMime(item.mime)
   if(preview)return <button key={file.snapshotId} type="button" className={css.thumbnail} aria-label={t('collaboration.attachment.open',{name:item.name})} onClick={event=>openImage(item,event.currentTarget)}><img src={item.blobUrl} alt={item.name}/></button>
   return <div key={file.snapshotId} className={css.fileRow}><FileText size={15}/><span className={css.fileName}>{item.name}</span><a className={css.replyButton} href={item.blobUrl} download={item.name}><Download size={13}/>{t('collaboration.attachment.download',{name:item.name})}</a></div>
  })}
  {openArtifact&&<button type="button" className={css.replyButton} onClick={()=>openArtifact(reference.id)}>{t('collaboration.reference.openArtifact')}</button>}
 </details>
}

/** 撤回确认：正文逐字给出「已存的字节不会被删除。」这一句，不改写、不省略。 */
function SavedAttachmentWithdrawForm({attachment,close,confirm,error}:{attachment:GroupAttachment;close:()=>void;confirm:()=>void;error:string|undefined}){
 const {t}=useI18n(),dialog=useRef<HTMLDialogElement>(null)
 useEffect(()=>openDialog(dialog.current),[])
 return <dialog ref={dialog} className={css.dialog} aria-label={t('collaboration.attachment.withdraw')} onCancel={close}><form onSubmit={event=>{event.preventDefault();confirm()}}><header><h2>{t('collaboration.attachment.withdraw')}</h2><button type="button" className={css.iconButton} aria-label={t('collaboration.form.close')} onClick={close}><X size={18}/></button></header><p className={css.hint}>{attachment.name}</p><p className={css.boundary}>{t('collaboration.attachment.withdrawConfirm')}</p>{error&&<p role="alert">{error}</p>}<footer><button type="button" className={css.secondary} onClick={close}>{t('collaboration.form.cancel')}</button><button type="submit" className={css.primary}>{t('collaboration.attachment.withdraw')}</button></footer></form></dialog>
}

/**
 * 正文 @ 触发的提及（Slack/飞书式）：在行首或空白后敲「@」就地弹候选浮层，选中把「@过滤词」替换成 @名字 标记。
 * 客户端绝不解析正文 @ 文本推断 roleId——提及只由这里的选择动作产生；正文标记被删掉时由 setText 一侧按 token 同步摘除。
 */
function SavedComposer({sending,sendBlocked,sendError,recoverPending,group,text,setText,references,resources,toggleReference,attachmentsEnabled,pending,addFiles,retryAttachment,removeAttachment,attachmentError,hasPendingFile,mentions,candidates,draftKey,commitMention,commitMentionAll,removeMention,mentionAllAllowed,mentionAll,allNotice,send,sendAll}:{sending:boolean;sendBlocked:boolean;sendError:string|undefined;recoverPending:(()=>void)|undefined;group:Group;text:string;setText:(value:string)=>void;references:MessageReference[];resources:GroupResource[];toggleReference:(resource:GroupResource)=>void;attachmentsEnabled:boolean;pending:PendingAttachment[];addFiles:(files:readonly File[])=>void;retryAttachment:(item:PendingAttachment)=>void;removeAttachment:(item:PendingAttachment)=>void;attachmentError:string|undefined;hasPendingFile:(item:PendingAttachment)=>boolean;mentions:GroupMention[];candidates:PreviewRole[];draftKey:string;commitMention:(role:PreviewRole,nextText:string)=>void;commitMentionAll:(nextText:string)=>void;removeMention:(roleId:string)=>void;mentionAllAllowed:boolean;mentionAll:boolean;allNotice:boolean;send:()=>void;sendAll:()=>void}){
 const {t}=useI18n()
 const [mentionQuery,setMentionQuery]=useState<{start:number;query:string}|undefined>(),[activeOption,setActiveOption]=useState(0)
 const [dragging,setDragging]=useState(false)
 const [focused,setFocused]=useState(false),[formatting,setFormatting]=useState(true)
 const [emojiOpener,setEmojiOpener]=useState<HTMLElement|null>(null)
 const [referencesOpen,setReferencesOpen]=useState(false),[referenceQuery,setReferenceQuery]=useState('')
 const referenceAnchor=useRef<HTMLButtonElement>(null),referenceId=useId()
 useEffect(()=>{setReferencesOpen(false);setReferenceQuery('')},[group.id,draftKey])
 const emojiOpen=!!emojiOpener
 const fileInput=useRef<HTMLInputElement>(null),dragDepth=useRef(0),textareaRef=useRef<HTMLTextAreaElement>(null)
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
 const canSend=!group.archived&&!!text.trim()&&!attachmentsBlocked&&!sending&&!sendBlocked
 const submit=()=>{if(canSend){if(mentionAll)sendAll();else send()}}
 const dropEnabled=attachmentsEnabled&&!group.archived
 // 回形针、拖放与粘贴三条入口进同一个判据。
 const pick=(files:FileList|null|undefined)=>{const list=files?[...files]:[];if(list.length)addFiles(list)}
 // 拖过子元素时浏览器会连发 dragleave/dragenter；按进入计数归零才收高亮，否则提示行会反复出现，
 // role=status 的朗读也跟着抖。
 const endDrag=()=>{dragDepth.current=0;setDragging(false)}
 const labelOf=(role:PreviewRole)=>groupMentionLabel(role,candidates)
 const allLabel=t('group.mention.all'),allToken='@'+t('group.mention.allName')
 const needle=(mentionQuery?.query??'').toLocaleLowerCase()
 const options:Array<PreviewRole|'all'>=mentionQuery?[
  ...(mentionAllAllowed&&t('group.mention.allName').toLocaleLowerCase().startsWith(needle)?['all' as const]:[]),
  ...candidates.filter(role=>labelOf(role).toLocaleLowerCase().startsWith(needle)),
 ]:[]
 const active=activeOption<options.length?activeOption:0
 const optionId=(option:PreviewRole|'all')=>'mention-'+draftKey+'-'+(option==='all'?'all':option.id)
 const blocked=(option:PreviewRole|'all')=>option==='all'?mentions.length>0:mentionAll||(mentions.length>=8&&!mentions.some(item=>item.roleId===option.id))
 const closeOptions=()=>{setMentionQuery(undefined);setActiveOption(0)}
 const choose=(option:PreviewRole|'all')=>{
  if(!mentionQuery||blocked(option))return
  const token=option==='all'?allToken:'@'+labelOf(option)
  const nextText=text.slice(0,mentionQuery.start)+token+' '+text.slice(mentionQuery.start+1+mentionQuery.query.length)
  if(option==='all')commitMentionAll(nextText);else commitMention(option,nextText)
  closeOptions()
 }
 // 表情/@ 按钮都在光标处插入，光标位置以 textareaRef 为准；测试环境里没有真实 DOM，退回正文末尾。
 const caret=()=>textareaRef.current?.selectionStart??text.length
 const closeEmoji=()=>{const previous=emojiOpener;setEmojiOpener(null);returnPanelFocus(previous,document)}
 const insertEmoji=(emoji:GroupReactionEmoji)=>{const cursor=caret();setText(text.slice(0,cursor)+emoji+text.slice(cursor))}
 // 已有空白时不再补空格，照规格 §6.3 之外的 T13 步骤段「@ 按钮」判据。
 const insertMentionTrigger=()=>{
  const cursor=caret(),before=text.slice(0,cursor),after=text.slice(cursor)
  const insertion=(before.length>0&&!/\s$/.test(before)?' ':'')+'@'
  const nextText=before+insertion+after,nextCursor=cursor+insertion.length
  setText(nextText)
  setMentionQuery(groupMentionQuery(nextText,nextCursor))
  setActiveOption(0)
  const el=textareaRef.current
  if(el)requestAnimationFrame(()=>{el.focus();el.setSelectionRange(nextCursor,nextCursor)})
 }
 const onKeyDown=(event:React.KeyboardEvent<HTMLTextAreaElement>)=>{
  if((event.metaKey||event.ctrlKey)&&!event.altKey&&!(event.nativeEvent as KeyboardEvent).isComposing){const command=({b:'bold',i:'italic',e:'code'} as const)[event.key.toLowerCase() as 'b'|'i'|'e'];if(command){event.preventDefault();format(command);return}}

  // 表情浮层开着时，Enter 归浮层（浮层自带键盘处理）；两种浮层都没开才谈发送。
  if(emojiOpen)return
  if(!mentionQuery||options.length===0){
   // 中文输入法用回车确认候选词时 isComposing 为真，绝不能当成发送。
   if(event.key==='Enter'&&!event.shiftKey&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!(event.nativeEvent as KeyboardEvent).isComposing){
    event.preventDefault()
    // 与 onSubmit 同一判据：@全员的草稿必须走 sendAll()，否则回车发出去的那条不带全员提示。
    submit()
   }
   return
  }
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeOptions();return}
  if(event.key==='ArrowDown'){event.preventDefault();setActiveOption((active+1)%options.length);return}
  if(event.key==='ArrowUp'){event.preventDefault();setActiveOption((active+options.length-1)%options.length);return}
  if(event.key==='Enter'||event.key==='Tab'){const option=options[active];if(!option)return;event.preventDefault();choose(option)}
 }
 return <form className={clsx(css.composer,dragging&&css.composerDropping)} aria-busy={sending}
  onDragEnter={event=>{event.preventDefault();if(!dropEnabled)return;dragDepth.current+=1;setDragging(true)}}
  onDragOver={event=>event.preventDefault()}
  onDragLeave={()=>{if(!dropEnabled)return;dragDepth.current=Math.max(0,dragDepth.current-1);if(dragDepth.current===0)setDragging(false)}}
  onDrop={event=>{event.preventDefault();endDrag();if(dropEnabled)pick(event.dataTransfer?.files)}}
  onPaste={event=>{if(!dropEnabled)return;const files=event.clipboardData?.files;if(files&&files.length){event.preventDefault();pick(files)}}}
  onSubmit={event=>{event.preventDefault();submit()}}>
  {formatting&&<div className={css.formatToolbar} role="toolbar" aria-label={t('knowledge.ui.073')}>{formatTools.map(([command,key,Icon])=><button key={command} type="button" title={t(key)} aria-label={t(key)} disabled={group.archived} onMouseDown={event=>event.preventDefault()} onClick={()=>format(command)}><Icon size={17}/></button>)}</div>}
  {mentions.length>0&&<div className={css.mentionChips}>{mentions.map(mention=>{const role=candidates.find(item=>item.id===mention.roleId);return <span key={mention.roleId} className={css.mentionChip}>{role?labelOf(role):mention.roleId}<button type="button" aria-label={t('collaboration.form.close')} onClick={()=>removeMention(mention.roleId)}><X size={11}/></button></span>})}</div>}
  <div className={css.mentionAnchor}>
   <textarea ref={textareaRef} aria-label={t('collaboration.composer.aria')} rows={1} maxLength={8000} disabled={group.archived} value={text} placeholder={group.archived?t('collaboration.composer.archived'):t('collaboration.composer.placeholder',{name:group.name})} aria-activedescendant={options.length>0?optionId(options[active]!):undefined} onKeyDown={onKeyDown} onFocus={()=>setFocused(true)} onBlur={()=>{closeOptions();setFocused(false)}} onChange={event=>{const value=event.target.value;setText(value);setMentionQuery(groupMentionQuery(value,event.target.selectionStart??value.length));setActiveOption(0)}}/>
   {options.length>0&&<ul className={css.mentionOptions} role="listbox" aria-label={t('group.mention.pick')}>{options.map((option,index)=><li key={optionId(option)} id={optionId(option)} role="option" aria-selected={index===active} aria-disabled={blocked(option)} className={index===active?css.mentionOptionActive:undefined} onMouseDown={event=>{event.preventDefault();choose(option)}}>{option==='all'?allLabel:labelOf(option)}</li>)}</ul>}
  </div>
  {attachmentsEnabled&&(references.length>0||pending.length>0)&&<div className={css.attachmentChips}>
   {references.flatMap(reference=>{const resource=reference.kind==='group-resource'?resources.find(item=>item.id===reference.id):undefined;return resource?[<span key={'resource:'+resource.id} className={css.attachmentChip}>{resource.title}<button type="button" aria-label={t('collaboration.attachment.remove',{name:resource.title})} disabled={group.archived} onClick={()=>toggleReference(resource)}><X size={11}/></button></span>]:[]})}
   {pending.map(item=><span key={item.key} {...(item.state==='failed'?{role:'alert'}:{})} className={clsx(css.attachmentChip,item.state==='failed'&&css.attachmentChipFailed)}>{item.name}{item.state==='uploading'&&<small>{t('collaboration.attachment.uploading')}</small>}{item.state==='failed'&&<button type="button" className={css.replyButton} onClick={()=>{if(hasPendingFile(item)){retryAttachment(item);return}removeAttachment(item);fileInput.current?.click()}}>{t('collaboration.attachment.retry')}</button>}<button type="button" aria-label={t('collaboration.attachment.remove',{name:item.name})} onClick={()=>removeAttachment(item)}><X size={11}/></button></span>)}
  </div>}
  {dragging&&<p className={css.hint} role="status">{t('collaboration.attachment.dropHint')}</p>}
  {attachmentError&&<p className={css.hint} role="alert">{attachmentError}</p>}
  {pending.length>0&&<p className={css.hint} role="status">{t('collaboration.attachment.pending',{count:pending.length})}</p>}
  {mentions.length>=8&&<p className={css.hint} role="status">{t('group.mention.limit')}</p>}
  {sendError&&<p className={css.hint} role="alert">{sendError}</p>}
  {recoverPending&&!sending&&<div className={css.composerRecovery} role="status"><span>{t('collaboration.pending.description')}</span><button type="button" className={css.replyButton} onClick={recoverPending}>{t('collaboration.action.recover')}</button></div>}
  {sending&&<p className={css.hint} role="status">{t('collaboration.composer.sending')}</p>}
  {allNotice&&<p className={css.hint} role="status">{t('group.mention.allNotice')}</p>}
  <footer>
   {attachmentsEnabled&&<><input ref={fileInput} type="file" multiple className={css.fileInput} tabIndex={-1} aria-hidden="true" onChange={event=>{pick(event.target.files);event.target.value=''}}/><button type="button" className={clsx(css.toolButton,css.addAttachment)} aria-label={t('collaboration.attachment.add')} title={t('collaboration.attachment.add')} disabled={group.archived} onClick={()=>fileInput.current?.click()}><Plus size={19}/></button></>}
   <button type="button" className={css.toolButton} title={t('knowledge.ui.073')} aria-label={t('knowledge.ui.073')} aria-pressed={formatting} onClick={()=>setFormatting(value=>!value)}><CaseSensitive size={19}/></button>
   <div className={css.emojiAnchor}>
    <button type="button" className={css.toolButton} aria-label={t('collaboration.composer.emoji')} title={t('collaboration.composer.emoji')} disabled={group.archived} onClick={(event:React.MouseEvent<HTMLButtonElement>)=>setEmojiOpener(event.currentTarget)}><Smile size={15}/></button>
    {emojiOpener&&<GroupEmojiPicker labelKey="collaboration.composer.emoji" onPick={emoji=>{insertEmoji(emoji);closeEmoji()}} onClose={closeEmoji}/>}
   </div>
   <button type="button" className={css.toolButton} aria-label={t('collaboration.composer.mention')} title={t('collaboration.composer.mention')} disabled={group.archived} onClick={insertMentionTrigger}><AtSign size={15}/></button>
   <button ref={referenceAnchor} type="button" className={css.toolButton} title={t('collaboration.composer.references')} aria-label={t('collaboration.composer.references')} aria-haspopup="dialog" aria-expanded={referencesOpen} aria-controls={referencesOpen?referenceId:undefined} disabled={group.archived} onClick={()=>setReferencesOpen(value=>!value)}><FileText size={16}/></button>
   {referencesOpen&&<ComposerPopover anchor={referenceAnchor} id={referenceId} label={t('collaboration.composer.references')} width={320} close={()=>setReferencesOpen(false)}><div className={css.groupReferenceMenu}>
    <header className={menuCss.contextHeader}><strong>{t('collaboration.composer.references')}</strong><button type="button" aria-label={t('collaboration.form.close')} onClick={()=>{setReferencesOpen(false);referenceAnchor.current?.focus()}}><X size={16}/></button></header>
    <input aria-label={t('homeResource.search')} placeholder={t('homeResource.search')} value={referenceQuery} onChange={event=>setReferenceQuery(event.target.value)}/>
    {resources.filter(resource=>resource.title.toLocaleLowerCase().includes(referenceQuery.trim().toLocaleLowerCase())).map(resource=>{const selected=references.some(reference=>reference.kind==='group-resource'&&reference.id===resource.id);return <button type="button" key={resource.id} title={t(selected?'collaboration.resources.remove':'collaboration.resources.reference')+' · '+resource.title} aria-pressed={selected} disabled={group.archived} onClick={()=>toggleReference(resource)}><FileText size={15}/><span>{resource.title}<small>{t('collaboration.resources.versionLabel',{version:resource.version})}</small></span>{selected?<Check size={15}/>:<Plus size={15}/>}</button>})}
    {!resources.some(resource=>resource.title.toLocaleLowerCase().includes(referenceQuery.trim().toLocaleLowerCase()))&&<p>{t('capabilities.picker.empty',{category:t('navigation.resources')})}</p>}
   </div></ComposerPopover>}
   {focused&&!!text.trim()&&<span className={css.composerHint} role="status">{t('collaboration.composer.enterHint')}</span>}
   {group.archived&&<small>{t('collaboration.composer.archived')}</small>}
   <button type="submit" className={css.send} disabled={!canSend} aria-label={t('collaboration.composer.send')} title={t('collaboration.composer.send')}>{sending?<LoaderCircle size={18}/>:<SendHorizontal size={18}/>} </button>
  </footer>
 </form>
}

export function SavedGroupForm({form,roles,profileName,close,save,error}:{form:FormState;roles:PreviewRole[];profileName:string;close:()=>void;save:(fields:GroupDefinition|GroupChangeFields)=>void|Promise<void>;error:string|undefined}){
 const {t}=useI18n()
 const scopes=useBusinessScopes(),existing=form.kind==='change'?form.snapshot:undefined
 const dialog=useRef<HTMLDialogElement>(null),nameInput=useRef<HTMLInputElement>(null),tabId=useId(),backdropStart=useRef(false)
 const [name,setName]=useState(existing?.group.name??''),[scope,setScope]=useState(existing?.group.scope??'general'),[announcement,setAnnouncement]=useState(existing?.group.announcement??''),[members,setMembers]=useState(existing?.members.flatMap(member=>member.roleId?[member.roleId]:[])??[])
 const [rules,setRules]=useState<GroupRules>(existing?.group.rules??{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true})
 const addOnly=form.kind==='change'&&!!form.addMembers
 const [tab,setTab]=useState<'info'|'members'|'rules'>('info'),[query,setQuery]=useState(''),[choosing,setChoosing]=useState(addOnly),[picked,setPicked]=useState<string[]>([]),[busy,setBusy]=useState(false)
 const memberSearch=useRef<HTMLInputElement>(null),isPicker=!existing||choosing
 const tabs=['info','members','rules'] as const,tabButtons=useRef<Partial<Record<typeof tab,HTMLButtonElement|null>>>({})
 const labels={info:'collaboration.form.tab.info',members:'collaboration.form.tab.members',rules:'collaboration.form.tab.rules'} as const
 // 群成员不限业务范围。已入群但暂停的同事仍显示，保持其成员关系；新增候选只取在岗同事。
 const existingIds=new Set(existing?.members.flatMap(member=>member.roleId?[member.roleId]:[])??[])
 const candidates=roles.filter(role=>role.state==='active'||existingIds.has(role.id)).sort((a,b)=>Number(existingIds.has(b.id))-Number(existingIds.has(a.id)))
 const candidateScopeLabel=(role:PreviewRole)=>role.scopes.map(value=>Object.hasOwn(scopes,value)?scopes[value as keyof typeof scopes]:value).join(' · ')
 const roleName=(role:PreviewRole)=>role.kind==='twin'?twinDisplayName(profileName,t):role.name
 const filtered=candidates.filter(role=>(isPicker?(!existing||!members.includes(role.id)):members.includes(role.id))).filter(role=>[roleName(role),role.duty,candidateScopeLabel(role)].some(value=>value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())))
 useEffect(()=>openDialog(dialog.current,addOnly?memberSearch.current:nameInput.current),[])
 useEffect(()=>{if(choosing||(!existing&&tab==='members'))memberSearch.current?.focus()},[choosing,tab])
 const title=t(choosing?'collaboration.form.addMembers':existing?'collaboration.form.edit':'collaboration.action.new')
 const startAdding=()=>{setPicked([]);setQuery('');setChoosing(true)}
 const leavePicker=()=>{setChoosing(false);setQuery('');setPicked([])}
 const submit=async()=>{
  if(busy)return
  if(!existing&&tab==='info'){if(name.trim())setTab('members');return}
  if(choosing&&!addOnly){setMembers(current=>[...new Set([...current,...picked])]);leavePicker();return}
  if(!name.trim()||(!addOnly&&members.length<1)||(addOnly&&!picked.length))return
  setBusy(true)
  try{if(existing)await save({name,announcement,rules,memberRoleIds:addOnly?[...members,...picked]:members,pinned:existing.group.pinned,archived:existing.group.archived});else await save({name,scope,announcement:'',rules,memberRoleIds:members})}finally{setBusy(false)}
 }
 const moveTab=(event:React.KeyboardEvent<HTMLButtonElement>,index:number)=>{
  const next=event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:undefined
  if(next===undefined)return
  event.preventDefault();setTab(tabs[next]!);tabButtons.current[tabs[next]!]?.focus()
 }
 const panelProps=(key:typeof tab)=>existing&&!choosing?{role:'tabpanel',id:tabId+'-'+key,'aria-labelledby':tabId+'-tab-'+key,hidden:tab!==key}:{hidden:key==='members'?(!choosing&&tab!=='members'):choosing||tab!==key}
 const initialRules=existing?.group.rules??{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
 const dirty=name!==(existing?.group.name??'')||scope!==(existing?.group.scope??'general')||announcement!==(existing?.group.announcement??'')||members.length!==existingIds.size||members.some(id=>!existingIds.has(id))||picked.length>0||rules.historyVisibleToNewMembers!==initialRules.historyVisibleToNewMembers||rules.draftsVisibleInGroup!==initialRules.draftsVisibleInGroup||rules.mentionAllAllowed!==initialRules.mentionAllAllowed
 const onBackdrop=(event:React.MouseEvent<HTMLDialogElement>)=>{
  if(event.target!==event.currentTarget)return false
  const box=event.currentTarget.getBoundingClientRect()
  return event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom
 }
 // 按下和松开都在遮罩上才算点外部；编辑中的草稿和在途保存不能被误点丢弃。
 return <dialog ref={dialog} className={clsx(css.dialog,css.groupDialog)} aria-label={title} onCancel={event=>{if(busy)event.preventDefault();else close()}} onPointerDown={event=>{backdropStart.current=onBackdrop(event)}} onPointerCancel={()=>{backdropStart.current=false}} onClick={event=>{const outside=backdropStart.current&&onBackdrop(event);backdropStart.current=false;if(outside&&!dirty&&!busy)close()}}>
  <form onSubmit={event=>{event.preventDefault();void submit()}}>
   <header><h2>{title}</h2><button type="button" className={css.iconButton} aria-label={t('collaboration.form.close')} disabled={busy} onClick={close}><X size={18}/></button></header>
   {existing&&!choosing&&<div className={css.settingsTabs} role="tablist" aria-label={title}>{tabs.map((key,index)=><button key={key} ref={node=>{tabButtons.current[key]=node}} type="button" role="tab" id={tabId+'-tab-'+key} aria-controls={tabId+'-'+key} aria-selected={tab===key} tabIndex={tab===key?0:-1} onClick={()=>setTab(key)} onKeyDown={event=>moveTab(event,index)}>{t(labels[key])}{key==='members'&&<span>{members.length+1}</span>}</button>)}</div>}
   {!existing&&<ol className={css.createSteps} aria-label={title}><li aria-current={tab==='info'?'step':undefined}>1 · {t('collaboration.form.tab.info')}</li><li aria-current={tab==='members'?'step':undefined}>2 · {t('collaboration.form.selectMembers')}</li></ol>}
   {error&&<p className={css.groupFormError} role="alert">{error}</p>}
   <div className={css.groupFormBody}>
    <section {...panelProps('info')} className={css.groupInfoFields}>
     <label>{t('collaboration.form.name')}<input ref={nameInput} required maxLength={80} value={name} onChange={event=>setName(event.target.value)}/></label>
     {existing?<label>{t('collaboration.form.announcement')}<textarea maxLength={4000} value={announcement} onChange={event=>setAnnouncement(event.target.value)} placeholder={t('collaboration.form.announcementPlaceholder')}/></label>:<label>{t('collaboration.form.scope')}<select value={scope} onChange={event=>setScope(event.target.value)}>{Object.entries(scopes).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>}
    </section>
    <section {...panelProps('members')}>
     {existing&&!choosing&&<div className={css.memberToolbar}><strong>{t('collaboration.members.savedCount',{count:members.length+1})}</strong><button type="button" className={css.secondary} onClick={startAdding}><Plus size={15}/>{t('collaboration.form.addMembers')}</button></div>}
     <label className={css.memberSearch}><Search size={16}/><input ref={memberSearch} aria-label={t('collaboration.form.searchMembers')} placeholder={t('collaboration.form.searchMembers')} value={query} onChange={event=>setQuery(event.target.value)}/></label>
     {isPicker&&(choosing?picked:members).length>0&&<div className={css.selectedMembers}>{(choosing?picked:members).map(id=>{const role=roles.find(item=>item.id===id);return <button type="button" key={id} onClick={()=>choosing?setPicked(current=>current.filter(value=>value!==id)):setMembers(current=>current.filter(value=>value!==id))} aria-label={t('collaboration.form.removeMember',{name:role?roleName(role):id})}>{role?roleName(role):id}<X size={12}/></button>})}</div>}
     <fieldset className={css.groupMembers}><legend>{t(isPicker?'collaboration.form.selectMembers':'collaboration.form.members')}</legend>
      {!choosing&&<div className={css.groupMemberChoice}><span className={css.avatar} aria-hidden="true">{profileName.slice(0,1)}</span><span className={css.memberIdentity}><strong>{profileName}</strong><small>{t('collaboration.message.selfRole')}</small></span><CheckCheck size={16} aria-hidden="true"/></div>}
      {filtered.map(role=><label key={role.id} className={css.groupMemberChoice}>{role.kind==='employee'?<StaffAvatar initial={roleName(role).slice(0,1)} seed={role.id} size="md"/>:<span className={clsx(css.avatar,css.human)} aria-hidden="true">{roleName(role).slice(0,1)}</span>}<span className={css.memberIdentity}><strong>{roleName(role)}<small className={css.memberScope}>{candidateScopeLabel(role)}</small></strong><small>{role.kind==='twin'?t('collaboration.member.twin'):role.duty}</small></span>{isPicker?<input type="checkbox" checked={(choosing?picked:members).includes(role.id)} disabled={role.state!=='active'||(!(choosing?picked:members).includes(role.id)&&members.length+(choosing?picked.length:0)>=30)} onChange={event=>{const update=(current:string[])=>event.target.checked?[...new Set([...current,role.id])]:current.filter(id=>id!==role.id);if(choosing)setPicked(update);else setMembers(update)}}/>:<button type="button" className={css.replyButton} disabled={role.state!=='active'||members.length<2} aria-label={t('collaboration.form.removeMember',{name:roleName(role)})} onClick={()=>setMembers(current=>current.filter(id=>id!==role.id))}><X size={15}/></button>}</label>)}
      {!filtered.length&&<p className={css.hint}>{t(query.trim()?'collaboration.form.noMemberMatch':'collaboration.form.noCandidates')}</p>}
     </fieldset>
     {!existing&&<p className={css.boundary}>{t('collaboration.form.memberLimit')}</p>}
     {!existing&&<p className={css.boundary}>{t('collaboration.form.memberBoundary')}</p>}
    </section>
    {existing&&<section {...panelProps('rules')}><div className={css.groupRules}>{([['historyVisibleToNewMembers','collaboration.form.rule.history'],['draftsVisibleInGroup','collaboration.form.rule.drafts'],['mentionAllAllowed','collaboration.form.rule.mentionAll']] as const).map(([key,label])=><label className={css.groupRule} key={key}><span>{t(label)}</span><input type="checkbox" checked={rules[key]} onChange={event=>setRules(current=>({...current,[key]:event.target.checked}))}/></label>)}</div><p className={css.boundary}>{t('collaboration.form.ruleBoundary')}</p></section>}
   </div>
   <footer><button type="button" className={css.secondary} disabled={busy} onClick={()=>{if(choosing&&!addOnly)leavePicker();else if(!existing&&tab==='members')setTab('info');else close()}}>{t(choosing&&!addOnly||!existing&&tab==='members'?'collaboration.form.back':'collaboration.form.cancel')}</button><button type="submit" className={css.primary} disabled={busy||!name.trim()||(choosing?picked.length<1:tab==='info'&&!existing?false:members.length<1)}>{t(choosing?(addOnly?'collaboration.form.addMembers':'collaboration.form.confirmSelection'):existing?'collaboration.form.saveSettings':tab==='info'?'collaboration.form.next':'collaboration.action.new')}</button></footer>
  </form>
 </dialog>
}

function SavedResourceForm({form,close,save,error}:{form:ResourceForm;close:()=>void;save:(title:string,markdown:string)=>void;error:string|undefined}){
 const {t}=useI18n(),dialog=useRef<HTMLDialogElement>(null),titleInput=useRef<HTMLInputElement>(null)
 const [title,setTitle]=useState(form.resource?.title??''),[markdown,setMarkdown]=useState(form.markdown)
 useEffect(()=>openDialog(dialog.current,titleInput.current),[])
 return <dialog ref={dialog} className={css.dialog} aria-label={t(form.resource?'collaboration.resources.edit':'collaboration.resources.new')} onCancel={close}><form onSubmit={event=>{event.preventDefault();save(title,markdown)}}><header><h2>{t(form.resource?'collaboration.resources.edit':'collaboration.resources.new')}</h2><button type="button" className={css.iconButton} aria-label={t('collaboration.form.close')} onClick={close}><X size={18}/></button></header><p className={css.hint}>{t('collaboration.resources.savedHint')}</p>{error&&<p role="alert">{error}</p>}<label>{t('collaboration.resources.titleField')}<input ref={titleInput} required maxLength={120} value={title} onChange={event=>setTitle(event.target.value)}/></label><label>{t('collaboration.resources.bodyField')}<textarea required maxLength={16000} value={markdown} onChange={event=>setMarkdown(event.target.value)}/></label><footer><button type="button" className={css.secondary} onClick={close}>{t('collaboration.form.cancel')}</button><button type="submit" className={css.primary}>{t('collaboration.resources.save')}</button></footer></form></dialog>
}

/** 可读引用按 kind 分三组，粒度到单个固定版本；撤销授权恒定清空整份清单（revokeAgentGrant 恒定传空数组）。 */
function SavedAgentGrantForm({form,resources,attachments,artifacts,close,save,error}:{form:AgentGrantForm;resources:GroupResource[];attachments:GroupAttachment[];artifacts:MessageReference[];close:()=>void;save:(resources:MessageReference[],canPost:boolean,canAutoRun:boolean)=>void;error:string|undefined}){
 const {t}=useI18n(),dialog=useRef<HTMLDialogElement>(null)
 // 候选是「本群此刻还能授权的那几条固定版本」：资料改版、附件被撤回、成果引用被移出消息之后，
 // 旧授权里那几条已经不在任何一组里显示了。初始勾选与候选取交集、候选变化时再对账一次，
 // 免得界面上看不见的授权被这次保存原样重存回去。
 const candidateKeys=new Set([
  ...resources.map(resource=>referenceKey({kind:'group-resource',id:resource.id,version:resource.version})),
  ...attachments.map(attachment=>referenceKey({kind:'attachment',id:attachment.attachmentId,version:attachment.version})),
  ...artifacts.map(referenceKey),
 ])
 const granted=form.read.grant?.state==='active'?form.read.grant.resources:[]
 const [selected,setSelected]=useState<MessageReference[]>(granted.filter(item=>candidateKeys.has(referenceKey(item)))),[canPost,setCanPost]=useState(form.read.grant?.state==='active'?form.read.grant.canPost:false),[canAutoRun,setCanAutoRun]=useState(form.read.grant?.state==='active'?form.read.grant.canAutoRun:false)
 useEffect(()=>openDialog(dialog.current),[])
 const candidateSignature=[...candidateKeys].sort().join('|')
 useEffect(()=>{setSelected(current=>{const next=current.filter(item=>candidateKeys.has(referenceKey(item)));return next.length===current.length?current:next})},[candidateSignature])
 // 三键齐全：同一份原件的两个固定版本是两条不同的授权，不能靠 kind+id 就判成同一条。
 const picked=(reference:MessageReference)=>selected.some(item=>referenceKey(item)===referenceKey(reference))
 const toggle=(reference:MessageReference)=>setSelected(current=>current.some(item=>referenceKey(item)===referenceKey(reference))?current.filter(item=>referenceKey(item)!==referenceKey(reference)):[...current,reference])
 return <dialog ref={dialog} className={css.dialog} aria-label={t('collaboration.agentGrant.configure')} onCancel={close}><form onSubmit={event=>{event.preventDefault();save(selected,canPost,canAutoRun)}}><header><h2>{t('collaboration.agentGrant.configure')}</h2><button type="button" className={css.iconButton} aria-label={t('collaboration.form.close')} onClick={close}><X size={18}/></button></header><p className={css.hint}>{t('collaboration.agentGrant.formHint',{name:form.role.name})}</p>{error&&<p role="alert">{error}</p>}<h4 className={css.sectionTitle}>{t('collaboration.agentGrant.resources')}</h4><fieldset><legend>{t('collaboration.grant.section.resources')}</legend>{resources.length?resources.map(resource=><label key={resource.id} className={css.memberChoice}><input type="checkbox" checked={picked({kind:'group-resource',id:resource.id,version:resource.version})} onChange={()=>toggle({kind:'group-resource',id:resource.id,version:resource.version})}/><span>{resource.title}</span><small>{t('collaboration.resources.versionLabel',{version:resource.version})}</small></label>):<p className={css.hint}>{t('collaboration.resources.savedEmpty')}</p>}</fieldset><fieldset><legend>{t('collaboration.grant.section.attachments')}</legend>{attachments.length?attachments.map(attachment=><label key={attachment.attachmentId} className={css.memberChoice}><input type="checkbox" checked={picked({kind:'attachment',id:attachment.attachmentId,version:attachment.version})} onChange={()=>toggle({kind:'attachment',id:attachment.attachmentId,version:attachment.version})}/><span>{attachment.name}</span><small>{t('collaboration.attachment.size',{size:byteLabel(attachment.bytes),type:attachment.mime})}</small></label>):<p className={css.hint}>{t('collaboration.attachment.sectionEmpty')}</p>}</fieldset><fieldset><legend>{t('collaboration.grant.section.artifacts')}</legend>{artifacts.length?artifacts.map(reference=><label key={reference.id+':'+reference.version} className={css.memberChoice}><input type="checkbox" checked={picked(reference)} onChange={()=>toggle(reference)}/><span>{reference.id.slice(0,8)}</span><small>{t('collaboration.resources.versionLabel',{version:reference.version})}</small></label>):<p className={css.hint}>{t('collaboration.grant.section.artifactsEmpty')}</p>}</fieldset><label className={css.memberChoice}><input type="checkbox" checked={canPost} onChange={event=>setCanPost(event.target.checked)}/><span>{t('collaboration.agentGrant.canPost')}</span></label><p className={css.hint}>{t('collaboration.grant.canPost.attachmentNote')}</p><label className={css.memberChoice}><input type="checkbox" checked={canAutoRun} onChange={event=>setCanAutoRun(event.target.checked)}/><span>{t('group.grant.canAutoRun')}</span></label><p className={css.hint}>{t('group.grant.canAutoRunHint')}</p><p className={css.boundary}>{t('collaboration.agentGrant.runtimeBoundary')}</p><footer><button type="button" className={css.secondary} onClick={close}>{t('collaboration.form.cancel')}</button><button type="submit" className={css.primary} disabled={!canPost&&!canAutoRun&&selected.length===0}>{t('collaboration.form.save')}</button></footer></form></dialog>
}


function SavedGroupTaskForm({form,members,roles,grants,scope,close,create,error}:{form:GroupTaskForm;members:GroupSnapshot['members'];roles:PreviewRole[];grants:Record<string,GroupAgentGrantRead>;scope:string;close:()=>void;create:(goal:string,assignee?:{roleId:string;expectedVersion:number})=>void;error:string|undefined}){
 const {t}=useI18n(),dialog=useRef<HTMLDialogElement>(null),goalInput=useRef<HTMLTextAreaElement>(null)
 // 用户裁定 B：群成员不限业务范围，但负责人必须支持本群范围才能接任务（tasks.ts:107），候选按范围过滤。
 const candidates=groupTaskAssignees(members,roles,scope)
 // 提及触发时把第一位被提及的同事预填为负责人、目标留空，逼用户明确写目标；手工建任务仍照旧默认带原文。
 // 被提及的同事若不支持本群范围，不在候选里，负责人留空——不能预填一个选不中的值。
 const mentionRoleId=form.trigger==='mention'&&'mentions' in form.message?form.message.mentions[0]?.roleId:undefined
 const mentionAssignable=!!mentionRoleId&&candidates.some(role=>role.id===mentionRoleId)
 const [goal,setGoal]=useState(form.trigger==='mention'?'':form.message.text),[assigneeId,setAssigneeId]=useState(mentionAssignable?mentionRoleId!:'')
 useEffect(()=>openDialog(dialog.current,goalInput.current),[])
 const assignee=candidates.find(role=>role.id===assigneeId)
 // 群内发言授权读的是已经拉好的 groups/agent-grants/get 结果；还没读到时不猜测状态。
 const grant=assignee?grants[assignee.id]:undefined
 return <dialog ref={dialog} className={css.dialog} aria-label={t('collaboration.task.create')} onCancel={close}><form onSubmit={event=>{event.preventDefault();create(goal,assignee?{roleId:assignee.id,expectedVersion:assignee.version}:undefined)}}><header><h2>{t('collaboration.task.create')}</h2><button type="button" className={css.iconButton} aria-label={t('collaboration.form.close')} onClick={close}><X size={18}/></button></header>{form.trigger==='mention'&&<><p className={css.boundary}>{t('group.mention.formOpened')}</p><p className={css.boundary}>{t('group.mention.readyOnly')}</p></>}<p className={css.hint}>{t('collaboration.task.formHint')}</p><p className={css.boundary}>{form.message.text}</p>{error&&<p role="alert">{error}</p>}<label>{t('collaboration.task.goal')}<textarea ref={goalInput} required maxLength={8000} value={goal} onChange={event=>setGoal(event.target.value)}/></label><label>{t('collaboration.task.assignee')}<select value={assigneeId} onChange={event=>setAssigneeId(event.target.value)}><option value="">{t('collaboration.task.unassigned')}</option>{candidates.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</select></label><p className={css.hint}>{t('group.task.scopeHint')}</p>{!assignee&&<p className={css.hint}>{t('collaboration.task.assigneeHint')}</p>}{grant&&grant.status!=='active'&&<p className={css.hint}>{t('collaboration.task.grantMissing')}</p>}<p className={css.boundary}>{t('collaboration.task.boundary')}</p><footer><button type="button" className={css.secondary} onClick={close}>{t('collaboration.form.cancel')}</button><button type="submit" className={css.primary}>{t('collaboration.task.create')}</button></footer></form></dialog>
}
