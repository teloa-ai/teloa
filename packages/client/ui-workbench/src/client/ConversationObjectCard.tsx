import markdownTypography from "./MarkdownTypography.module.css"
import type {WorkProject,WorkTask} from '@teloa/contract'
import {useEffect,useState,useSyncExternalStore} from 'react'
import {Users,Sparkles,ChevronRight} from 'lucide-react'
import {verifyKnowledgeVersionContent,type DigitalRole,type Group,type PageCreateDraftPreview,type PageCreateDraft,type WorkResource,type ResourceDraft,type KnowledgeNode,type KnowledgeVersion} from '@teloa/contract'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {ToolCallViewProps} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {PageCreateApi} from './page-create-api.js'
import type {ManagedMcpConnectionApi,ManagedMcpConnectionRecord} from './mcp-connections-api.js'
import type {ConversationPlanEvents} from './conversation-plans.js'
import {conversationObjectReceipt,conversationTurnObjectReceipts,readConversationSkillResult,readConversationIndustrySkillDetail,type ConversationIndustrySkillDetail,type ConversationObjectReceipt,type ConversationSkillResult} from './conversation-object-receipts.js'
import type {ResourceApi} from './resource-api.js'
import {MarkdownPreview} from './knowledge-markdown.js'
import {ContextDrawer} from './ContextDrawer.js'
import {CustomMcpAppConfirmation,CustomMcpAppSettings} from './CustomMcpAppEntry.js'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {TwinAvatar} from './TwinAvatar.js'
import {twinDisplayName} from './team-presentation.js'
import {usePersonalProfile} from './use-personal-profile.js'
import {useI18n} from './i18n/provider.js'
import {useTemplateShare} from './EmployeeTemplateShare.js'
import {readSharePackage} from './share-package-plan.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ConversationObjectCard.module.css'

export type ConversationCapabilityDetail={id:string;ownerId:string;title:string;version:string|number;state:'available'|'enable-pending'|'active'|'failed'|'disable-pending'|'needs_authorization'|'needs_connection'|'detached';description:string}
export type ConversationObjectCardPorts={
 readProject?:(id:string)=>Promise<WorkProject>
 readTask?:(id:string)=>Promise<WorkTask|undefined>
 openProject?:((project:WorkProject)=>void)|undefined
 openTask?:((id:string)=>void)|undefined
 readRole:(id:string)=>Promise<DigitalRole|undefined>
 readGroup:(id:string)=>Promise<Group>
 drafts:PageCreateApi
 openPlanDraft?:(draft:PageCreateDraft)=>void
 mcp:ManagedMcpConnectionApi
 openRole:(id:string)=>void
 openGroup:(id:string)=>void
 openCapabilities:()=>void
 sessionId?:string
 resources?:ResourceApi
 readSkill?:(installationId:string)=>Promise<unknown>
 readCapability?:(receipt:ConversationObjectReceipt)=>Promise<ConversationCapabilityDetail>
 openResource?:(id:string)=>void
 openResources?:(draftId?:string)=>void
 openIndustrySkill?:(target:{loadId:string;itemInstanceId:string;scope:string})=>void
}
type ObjectEvents={subscribe:(listener:()=>void)=>()=>void;getSnapshot:()=>ConversationPlanEvents}
type Copy=(cn:string,tw:string,en:string)=>string
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
const label=(value:unknown):string=>typeof value==='string'?value.trim().slice(0,300):''
/** 原始定义仅供只读核对；文件编码与凭据没有展示用途。 */
function readableDefinition(value:unknown,hidden:string,key=''):unknown{
 if(/(?:password|secret|token|credential|authorization|cookie|headers|env|api[_-]?key|access[_-]?key|private[_-]?key)|^(?:key|auth)$/i.test(key))return hidden
 if(Array.isArray(value))return value.slice(0,200).map(item=>readableDefinition(item,hidden))
 if(value!==null&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/base64/i.test(key)).map(([key,item])=>[key,readableDefinition(item,hidden,key)]))
 if(typeof value==='string'){
  if(/\b(?:Bearer\s+\S+|sk-(?:live-|test-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})/i.test(value))return hidden
  if(/^https?:\/\//i.test(value))try{const url=new URL(value);url.username='';url.password='';url.search='';url.hash='';return url.toString()}catch{return hidden}
 }
 return value
}
function skillBody(base64:unknown):string|undefined{
 if(typeof base64!=='string'||base64.length>Math.ceil(2*1024*1024/3)*4)return
 try{return new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(base64),character=>character.charCodeAt(0)))}catch{return}
}
function DraftContent({draft,copy}:{draft:PageCreateDraft;copy:Copy}){
 const body=record(JSON.parse(draft.body)),manifest=record(body.manifest),resource=record(body.resource)
 const version=label(body.version)||label(manifest.version)
 const files=Array.isArray(body.files)?body.files.map(record).filter(file=>typeof file.path==='string'):[]
 const instructions=skillBody(files.find(file=>(file.path as string).split('/').at(-1)==='SKILL.md')?.base64)
 const rows:[string,string][]=[[copy('名称','名稱','Name'),label(body.title)||label(manifest.title)||draft.title],[copy('版本','版本','Version'),version]]
 if(draft.entity==='connector')rows.push([copy('连接名称','連線名稱','Connection name'),label(resource.serverName)||label(resource.sourceId)],[copy('业务范围','業務範圍','Business scope'),draft.scope??label(manifest.scope)])
 if(draft.entity==='extension')rows.push([copy('应用','應用程式','App'),label(body.packageName)],[copy('来源','來源','Source'),label(body.registry)])
 return <>
  <dl>{rows.filter(([,value])=>value).map(([name,value])=><div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
  {draft.entity==='skill'&&<>
   <section className={css.files}><h4>{copy('文件清单','檔案清單','Files')}</h4><ul>{files.map(file=><li key={file.path as string}><code>{file.path as string}</code></li>)}</ul></section>
   <details><summary>{copy('查看 SKILL.md 正文','查看 SKILL.md 內文','Read SKILL.md')}</summary><p>{copy('只读查看不会执行指令、脚本或链接。','唯讀檢視不會執行指令、程式或連結。','Read-only viewing does not run instructions, scripts, or links.')}</p>{instructions!==undefined?<pre aria-label={copy('SKILL.md 只读正文','SKILL.md 唯讀內文','SKILL.md read-only content')}>{instructions}</pre>:<p>{copy('正文暂时无法预览，请在「应用」中查看文件。','暫時無法預覽內文，請在「應用程式」中檢視檔案。','Content cannot be previewed. View the file in Apps.')}</p>}</details>
  </>}
  {draft.entity==='connector'&&<p>{copy('此记录保存连接定义；是否接通需以实际连接状态为准。','此記錄儲存連線定義；是否已連線須以實際連線狀態為準。','This record stores the connection definition. Check the actual connection status to confirm connectivity.')}</p>}
  {draft.entity==='extension'&&<p>{copy('此记录不代表应用已启用；请以实际安装和启用状态为准。','此記錄不代表應用程式已啟用；請以實際安裝與啟用狀態為準。','This record does not confirm that the app is enabled. Check its installation and enabled state.')}</p>}
  {draft.entity!=='skill'&&<details><summary>{copy('查看定义','查看定義','View definition')}</summary><pre>{JSON.stringify(readableDefinition(body,copy('[已隐藏]','[已隱藏]','[Hidden]')),null,2)}</pre></details>}
 </>
}
export function ConversationObjectToolCard({block,phase,toolName,inspect,events,...ports}:ToolCallViewProps&ConversationObjectCardPorts&{events:ObjectEvents}){
 const {locale}=useI18n(),zh=locale.startsWith('zh'),hant=/zh-(TW|HK|Hant)/.test(locale),history=useSyncExternalStore(events.subscribe,events.getSnapshot)
 let receipt:ConversationObjectReceipt|undefined
 if(phase==='result'&&!block.isError)try{receipt=conversationObjectReceipt(JSON.parse(block.content.filter(item=>item.type==='text').map(item=>item.text).join('\n')),ports.sessionId)}catch{/* 保留原生详情，不能生成猜测的对象入口。 */}
 if(phase!=='result')return <p role="status">{toolName==='teloa_create_drafts'?(zh?(hant?'正在讀取…':'正在读取…'):'Reading…'):(zh?'正在保存…':'Saving…')}</p>
 if(receipt){const original=receipt,current=conversationTurnObjectReceipts(history.entries,undefined,ports.sessionId).find(row=>row.kind===original.kind&&row.id===original.id);if(current)receipt={...receipt,revision:current.revision}}
 return receipt?<ConversationObjectCard key={receipt.kind+receipt.id} receipt={receipt} {...ports}/>:<p>{toolName==='teloa_create_drafts'&&!block.isError?(zh?(hant?'已讀取草稿目錄。':'已读取草案目录。'):'Draft directory read.'):(zh?'操作结果需要核对。':'Result needs verification.')}{inspect&&<button type="button" onClick={inspect}>{zh?'查看详情':'Details'}</button>}</p>
}
export function ConversationObjectTurnCards({turn,events,...ports}:PropsRuntime<'conversation.chat.turnTail'>&ConversationObjectCardPorts&{events:ObjectEvents}){
 const history=useSyncExternalStore(events.subscribe,events.getSnapshot),receipts=turn.status==='closed'?conversationTurnObjectReceipts(history.entries,turn.turn,ports.sessionId):[],current=new Map(conversationTurnObjectReceipts(history.entries,undefined,ports.sessionId).map(row=>[row.kind+row.id,row.revision]))
 return <>{receipts.map(receipt=><ConversationObjectCard key={receipt.kind+receipt.id} receipt={{...receipt,revision:current.get(receipt.kind+receipt.id)??receipt.revision}} {...ports}/>)}</>
}
export function ConversationObjectCard({receipt,...ports}:{receipt:ConversationObjectReceipt}&ConversationObjectCardPorts){
 const profile=usePersonalProfile()
 const {locale,t}=useI18n(),sharing=useTemplateShare(),zh=locale.startsWith('zh'),hant=/zh-(TW|HK|Hant)/.test(locale),copy=(cn:string,tw:string,en:string)=>zh?(hant?tw:cn):en
 const [detail,setDetail]=useState<{project?:WorkProject;task?:WorkTask;role?:DigitalRole;group?:Group;draftRecord?:PageCreateDraft;draft?:PageCreateDraftPreview;mcp?:ManagedMcpConnectionRecord;skill?:ConversationSkillResult;resource?:WorkResource;resourceDraft?:ResourceDraft;node?:KnowledgeNode;knowledge?:KnowledgeVersion;capability?:ConversationCapabilityDetail;industrySkill?:ConversationIndustrySkillDetail}>(),[error,setError]=useState(''),[retry,setRetry]=useState(0),[previewOpen,setPreviewOpen]=useState(false),[busy,setBusy]=useState(false),[requested,setRequested]=useState(!receipt.draftReference)
 useEffect(()=>{if(receipt.draftReference&&!requested)return;const controller=new AbortController();let live=true;setError('');setDetail(undefined)
  const load=async()=>{
   const own=(ownerId:string)=>{if(ownerId!=='local:teloa-owner')throw Error(copy('对象不属于当前本人。','物件不屬於目前本人。','This object does not belong to the current user.'))}
   const readSkill=async(id:string)=>{if(!ports.readSkill)throw Error(copy('技能详情暂不可用，请重试。','技能詳情暫時無法使用，請重試。','Skill details are unavailable. Retry.'));const value=await ports.readSkill(id),skill=record(value).kind==='industry'?await readConversationIndustrySkillDetail(value):readConversationSkillResult(value);if(skill.skill.installationId!==id||receipt.skillSource&&(skill.skill.id!==receipt.skillSource.resourceId||skill.skill.contentId!==receipt.skillSource.contentId||skill.skill.nativeName!==receipt.skillSource.nativeName))throw Error('技能身份不一致。');return skill}
   if(receipt.kind==='project'){if(!ports.readProject)throw Error(copy('项目详情暂不可用。','專案詳情暫時無法使用。','Project details are unavailable.'));const project=await ports.readProject(receipt.id);own(project.ownerId);if(project.id!==receipt.id||project.scope!==receipt.scope)throw Error(copy('项目身份或业务不一致。','專案身分或業務不一致。','Project identity or business does not match.'));return {project}}
   if(receipt.kind==='task'){if(!ports.readTask)throw Error(copy('任务详情暂不可用。','工作詳情暫時無法使用。','Task details are unavailable.'));const task=await ports.readTask(receipt.id);if(!task)throw Error(copy('任务已不可用。','工作已無法使用。','Task is unavailable.'));own(task.ownerId);if(task.id!==receipt.id||task.scope!==receipt.scope)throw Error(copy('任务身份或业务不一致。','工作身分或業務不一致。','Task identity or business does not match.'));return {task}}
   if(receipt.kind==='role'){const role=await ports.readRole(receipt.id);if(!role||role.id!==receipt.id)throw Error(copy('员工已不可用，请核对目录。','員工已不可用，請核對名錄。','Employee is unavailable.'));own(role.ownerId);return {role}}
   if(receipt.kind==='group'){const group=await ports.readGroup(receipt.id);if(group.id!==receipt.id)throw Error('群身份不一致。');own(group.ownerId);return {group}}
   if(receipt.kind==='mcp')return {mcp:await ports.mcp.get(receipt.id)}
   if(receipt.kind==='skill'){const skill=await readSkill(receipt.id);return 'kind' in skill?{industrySkill:skill}:{skill}}
   if(receipt.kind==='extension'||receipt.kind==='connector'){
    if(!ports.readCapability)throw Error(copy('能力详情暂不可用。','能力詳情暫時無法使用。','Capability details are unavailable.'))
    const capability=await ports.readCapability(receipt);own(capability.ownerId)
    if(capability.id!==receipt.id)throw Error(copy('能力身份不一致。','能力身分不一致。','Capability identity does not match.'))
    return {capability}
   }
   if(receipt.kind==='work-resource'||receipt.kind==='work-resource-draft'||receipt.kind==='knowledge'||receipt.kind==='knowledge-node'){
    if(!ports.resources)throw Error(copy('资料目录暂不可用。','資料目錄暫時無法使用。','The resource directory is unavailable.'))
    if(receipt.kind==='work-resource'){const resource=(await ports.resources.directory()).resources.find(row=>row.id===receipt.id);if(!resource)throw Error(copy('资料已不可用，请核对目录。','資料已無法使用，請核對目錄。','The resource is unavailable. Check the directory.'));own(resource.ownerId);return {resource}}
    if(receipt.kind==='work-resource-draft'){const resourceDraft=(await ports.resources.directory()).drafts.find(row=>row.id===receipt.id);if(!resourceDraft)throw Error(copy('资料草案已不可用，请核对目录。','資料草案已無法使用，請核對目錄。','The resource draft is unavailable. Check the directory.'));own(resourceDraft.ownerId);return {resourceDraft}}
    const tree=await ports.resources.knowledgeTree();own(tree.space.ownerId)
    const node=tree.nodes.find(row=>receipt.kind==='knowledge-node'?row.id===receipt.id:row.type==='page'&&row.knowledgeId===receipt.id)
    if(!node)throw Error(copy('知识节点已不可用，请核对目录。','知識節點已無法使用，請核對目錄。','The knowledge item is unavailable. Check the directory.'))
    if(node.type!=='page')return {node}
    const versions=await ports.resources.listKnowledgeVersions(node.knowledgeId),latest=versions.reduce<typeof versions[number]|undefined>((current,row)=>!current||row.version>current.version?row:current,undefined)
    if(!latest)throw Error(copy('知识版本已不可用。','知識版本已無法使用。','The knowledge version is unavailable.'))
    own(latest.ownerId);if(latest.knowledgeId!==node.knowledgeId)throw Error('知识身份不一致。')
    const knowledge=await ports.resources.readKnowledgeVersion(node.knowledgeId,latest.version);own(knowledge.ownerId);if(knowledge.knowledgeId!==node.knowledgeId||knowledge.version!==latest.version||knowledge.contentHash!==latest.contentHash)throw Error(copy('知识版本身份不一致。','知識版本身分不一致。','Knowledge version identity does not match.'))
    if(!await verifyKnowledgeVersionContent(knowledge))throw Error(copy('知识正文与版本不一致，请重新读取。','知識內文與版本不一致，請重新讀取。','Knowledge content does not match this version. Reload it.'))
    const resource=(await ports.resources.directory()).resources.find(row=>row.ownerId==='local:teloa-owner'&&row.status==='active'&&row.sourceId==='knowledge_'+node.knowledgeId&&row.sourceVersion===knowledge.contentHash)
    return {node,knowledge,...(resource?{resource}:{})}
   }
   const draftRecord=await ports.drafts.read({draftId:receipt.id},controller.signal)
   own(draftRecord.ownerId);if(draftRecord.id!==receipt.id||receipt.draftReference&&(draftRecord.entity!==receipt.draftReference.entity||draftRecord.scope!==receipt.scope))throw Error(copy('草案身份或业务不一致。','草稿身分或業務不一致。','Draft identity or business does not match.'))
   const installed=draftRecord.entity==='skill'&&draftRecord.status==='applied'&&draftRecord.appliedRef?.startsWith('skill:')&&ports.readSkill?await readSkill(draftRecord.appliedRef.slice(6)):undefined
   return {draftRecord,...(installed?('kind' in installed?{industrySkill:installed}:{skill:installed}):{}),...(draftRecord.status==='draft'?{draft:await ports.drafts.preview({draftId:receipt.id},controller.signal)}:{})}
  };let generation=0;const refresh=()=>{const current=++generation;void load().then(value=>{if(live&&current===generation){setDetail(value);setError('')}},cause=>{if(live&&current===generation)setError(localizeWorkError(locale,cause))})};refresh();window.addEventListener('focus',refresh);return()=>{live=false;controller.abort();window.removeEventListener('focus',refresh)}
 },[requested,receipt.kind,receipt.id,receipt.revision,receipt.scope,receipt.draftReference?.entity,receipt.skillSource?.resourceId,receipt.skillSource?.contentId,receipt.skillSource?.nativeName,retry,ports.readRole,ports.readGroup,ports.readProject,ports.readTask,ports.drafts,ports.mcp,ports.resources,ports.readSkill,ports.readCapability,locale])
 useEffect(()=>{
  const draft=detail?.draftRecord
  if(!previewOpen||draft?.entity!=='share'||!sharing)return
  try{
   // 原稿仍从本人的草案端口读取；共同契约核对后直接进入同一分享抽屉，不创建员工或运行工作。
   const pkg=readSharePackage(record(JSON.parse(draft.body)).package)
   sharing.openDraft(pkg);setPreviewOpen(false);setRequested(false);setDetail(undefined)
  }catch(cause){setError(localizeWorkError(locale,cause))}
 },[detail?.draftRecord,previewOpen,sharing,locale])
 const title=detail?.project?.title??detail?.task?.title??detail?.industrySkill?.skill.title??detail?.capability?.title??(detail?.role?.kind==='twin'?twinDisplayName(profile.displayName,t):detail?.role?.name)??detail?.group?.name??detail?.skill?.skill.title??detail?.node?.title??detail?.resource?.title??detail?.resourceDraft?.title??detail?.draftRecord?.title??detail?.mcp?.serverName??receipt.title
 const category=receipt.kind==='project'?copy('项目','專案','Project'):receipt.kind==='task'?copy('任务','工作','Task'):receipt.kind==='extension'||detail?.draftRecord?.entity==='app'||receipt.draftReference?.entity==='app'?copy('应用','應用程式','App'):receipt.kind==='connector'?copy('连接能力','連線能力','Connector'):receipt.kind==='role'?copy('AI 员工','AI 員工','AI employee'):receipt.kind==='group'?copy('协作群','協作群','Group'):receipt.kind==='mcp'?copy('MCP 连接','MCP 連線','MCP connection'):receipt.kind==='skill'||detail?.draftRecord?.entity==='skill'||receipt.draftReference?.entity==='skill'?copy('技能','技能','Skill'):receipt.kind==='work-resource'||receipt.kind==='work-resource-draft'?copy('工作资料','工作資料','Work resource'):receipt.kind==='knowledge'||receipt.kind==='knowledge-node'?copy('知识库','知識庫','Knowledge'):copy('能力草案','能力草案','Draft')
 const resourceScopes=detail?.resource?.scopeIds??detail?.resourceDraft?.scopeIds
 const sub=detail?.project?.goal??detail?.task?.goal??detail?.industrySkill?.skill.description??detail?.capability?.description??detail?.skill?.skill.description??resourceScopes?.map(scope=>scope==='general'?t('business.scope.general'):scope).join(' · ')??(detail?.knowledge?copy('Markdown 知识','Markdown 知識','Markdown knowledge'):undefined)??(detail?.node?copy('知识目录','知識目錄','Knowledge directory'):undefined)??detail?.role?.duty??(detail?.group?detail.group.scope:detail?.draftRecord?detail.draftRecord.entity==='skill'?copy('技能','技能','Skill'):detail.draftRecord.entity==='connector'?copy('连接定义','連線定義','Connection definition'):(detail.draftRecord.entity==='extension'||detail.draftRecord.entity==='app')?copy('应用','應用程式','App'):detail.draftRecord.entity:detail?.mcp?`${detail.mcp.tools?.length??0} ${copy('项工具','項工具','tools')}`:receipt.draftReference&&!requested?copy('原稿','原稿','Original'):copy('正在读取…','正在讀取…','Loading…'))
 const skillState=detail?.industrySkill?.skill.state??detail?.skill?.skill.state
 const capabilityState=detail?.capability?.state
 const capabilityStatus=capabilityState==='active'?copy('已启用','已啟用','Active'):capabilityState==='available'?copy('已停用','已停用','Disabled'):capabilityState==='needs_authorization'?copy('需要本人授权','需要本人授權','Authorization required'):capabilityState==='needs_connection'?copy('等待连接','等待連線','Pending connection'):capabilityState==='detached'?copy('已解除关联','已解除關聯','Detached'):capabilityState==='failed'?copy('启用失败','啟用失敗','Activation failed'):capabilityState==='enable-pending'?copy('正在启用','正在啟用','Enabling'):capabilityState==='disable-pending'?copy('正在停用','正在停用','Disabling'):''
 const draftStatus=detail?.draftRecord?.status??receipt.draftReference?.status
 const state=detail?.project||detail?.task||detail?.knowledge?copy('已保存','已儲存','Saved'):capabilityStatus|| (skillState?(skillState==='enabled'?copy('已启用','已啟用','Enabled'):skillState==='disabled'?copy('已停用','已停用','Disabled'):copy('已保存，未启用','已儲存，未啟用','Saved, not enabled')):detail?.resource?(detail.resource.status==='active'?copy('已提交','已提交','Applied'):copy('已撤回','已撤回','Withdrawn')):detail?.resourceDraft?(detail.resourceDraft.status==='applied'?copy('已提交','已提交','Applied'):copy('待提交','待提交','Draft')):detail?.node?copy('已保存','已儲存','Saved'):detail?.role?(detail.role.state==='active'?copy('在岗','在職','Active'):detail.role.state==='paused'?t('status.paused'):copy('已离职','已離職','Retired')):detail?.group?(detail.group.archived?t('status.archived'):copy('已创建','已建立','Created')):draftStatus?(draftStatus==='applied'?copy('已应用','已套用','Applied'):draftStatus==='discarded'?copy('已丢弃','已捨棄','Discarded'):copy('待应用','待套用','Draft')):detail?.mcp?(detail.mcp.status==='connected'?copy('已连接','已連線','Connected'):detail.mcp.status==='saved'?copy('已保存','已儲存','Saved'):detail.mcp.status==='error'?copy('连接失败','連線失敗','Connection failed'):copy('等待连接','等待連線','Pending connection')):'')
 const closePreview=()=>{setPreviewOpen(false);if(receipt.draftReference){setRequested(false);setDetail(undefined);setError('')}}
 const open=()=>{if(receipt.draftReference){setDetail(undefined);setError('');setRequested(true);setPreviewOpen(true);return}if(detail?.project&&ports.openProject)ports.openProject(detail.project);else if(detail?.task&&ports.openTask)ports.openTask(detail.task.id);else if(receipt.kind==='role')ports.openRole(receipt.id);else if(receipt.kind==='group')ports.openGroup(receipt.id);else if(detail?.industrySkill&&ports.openIndustrySkill)ports.openIndustrySkill({loadId:detail.industrySkill.load.id,itemInstanceId:detail.industrySkill.installation.source.itemInstanceId,scope:detail.industrySkill.load.scope});else if(detail?.resource&&ports.openResource)ports.openResource(detail.resource.id);else if(detail?.resourceDraft&&ports.openResources)ports.openResources(detail.resourceDraft.id);else if(detail?.node&&!detail.knowledge&&ports.openResources)ports.openResources();else setPreviewOpen(true)}
 const mcpAction=async()=>{if(!detail?.mcp||busy)return;setBusy(true);setError('');try{const connection=detail.mcp.status==='connected'?await ports.mcp.disconnect(receipt.id):await ports.mcp.connect(receipt.id);setDetail({mcp:connection})}catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}}
 return <>
  <section className={css.card} aria-label={category+'：'+title} data-object-id={receipt.id}>
   <button type="button" className={css.row} onClick={open} disabled={(!detail&&!receipt.draftReference)||!!error||!!(receipt.draftReference&&requested&&!detail)}>
    <span className={css.icon}>{receipt.kind==='role'?(detail?.role?.kind==='twin'?<TwinAvatar initials={profile.initials} size="sm"/>:<EmployeeAvatar avatarKey={detail?.role?.avatarKey} size="sm"/>):receipt.kind==='group'?<Users size={18}/>:<Sparkles size={18}/>}</span>
    <span className={css.text}><strong>{title}</strong><small>{sub}</small></span><span className={css.state}>{state}</span><ChevronRight size={15}/>
   </button>
   {error&&<p role="alert">{error}<button type="button" onClick={()=>setRetry(value=>value+1)}>{t('common.retry')}</button></p>}
  </section>
  {previewOpen&&receipt.draftReference?.entity!=='share'&&detail?.draftRecord?.entity!=='share'&&(receipt.draftReference||detail?.draftRecord||detail?.skill||detail?.industrySkill)&&<ContextDrawer title={receipt.draftReference?.entity==='skill'||detail?.draftRecord?.entity==='skill'||detail?.skill||detail?.industrySkill?copy('技能详情','技能詳情','Skill details'):copy('草案详情','草案詳情','Draft details')} close={closePreview}><div className={css.preview}>
   {!detail&&(error?<p role="alert">{error}<button type="button" onClick={()=>setRetry(value=>value+1)}>{t('common.retry')}</button></p>:<p role="status">{copy('正在读取…','正在讀取…','Loading…')}</p>)}
   {detail?.draftRecord&&!detail.skill&&!detail.industrySkill&&<>
    <h3>{title}</h3><p>{state}</p><DraftContent draft={detail.draftRecord} copy={copy}/>
    {detail.draftRecord.entity==='plan'&&detail.draftRecord.status==='draft'&&ports.openPlanDraft&&<button type="button" onClick={()=>{ports.openPlanDraft?.(detail.draftRecord!);closePreview()}}>{t('create.plan.review')}</button>}
    {detail.draftRecord.entity==='app'&&detail.draft&&<CustomMcpAppConfirmation key={detail.draftRecord.id+detail.draftRecord.bodyHash} api={ports.mcp} preview={detail.draft} active={previewOpen} apply={async id=>{const draft=detail.draftRecord!;await ports.drafts.settle({requestId:crypto.randomUUID(),draftId:draft.id,expectedBodyHash:draft.bodyHash,outcome:'applied',appliedRef:id});setRetry(value=>value+1)}}/>}
    {detail.draftRecord.entity==='app'&&detail.draftRecord.status==='applied'&&detail.draftRecord.appliedRef&&<CustomMcpAppSettings api={ports.mcp} id={detail.draftRecord.appliedRef} removed={closePreview}/>}
    {detail.draftRecord.entity!=='app'&&<p>{detail.draftRecord.status==='draft'?copy('可以回到此会话继续调整，或要求应用这份草案。','可以返回此會話繼續調整，或要求套用這份草案。','Continue refining or ask to apply this draft in the conversation.'):copy('此记录关联同一份能力定义。','此記錄關聯同一份能力定義。','This record links to the same capability.')}</p>}
   </>}
   {detail?.skill&&<>
    <h3>{title}</h3><p>{detail.skill.skill.description}</p><p>{state} · {detail.skill.skill.version}</p><p>{copy('本人保存的技能。保存新版不会自动发布、启用或切换正在使用的版本。','本人儲存的技能。儲存新版不會自動發佈、啟用或切換正在使用的版本。','A skill saved by you. Saving a new version does not publish or enable it, or switch the active version.')}</p><article className={[css.markdown,markdownTypography.typography].join(" ")} aria-label={copy('技能正文','技能內文','Skill content')}><MarkdownPreview markdown={detail.skill.body} images={false}/></article>{detail.draftRecord&&<details><summary>{copy('创建文件清单','建立檔案清單','Created files')}</summary><DraftContent draft={detail.draftRecord} copy={copy}/></details>}
   </>}
   {detail?.industrySkill&&<>
    <h3>{title}</h3><p>{sub}</p><p>{state} · {detail.industrySkill.skill.version}</p><p>{copy('来自模板','來自範本','From template')}：{detail.industrySkill.load.templateTitle}</p><p>{copy('此技能随原模板维护；查看不会修改正文、启用或切换版本。','此技能隨原範本維護；檢視不會修改內文、啟用或切換版本。','This skill is maintained with its original template. Viewing does not edit content, enable it, or switch versions.')}</p>
   </>}
   {detail&&detail.draftRecord?.entity!=='app'&&<button type="button" onClick={()=>{closePreview();ports.openCapabilities()}}>{copy('打开应用','開啟應用程式','Open Apps')}</button>}
  </div></ContextDrawer>}
  {previewOpen&&detail?.knowledge&&<ContextDrawer title={copy('知识详情','知識詳情','Knowledge details')} close={()=>setPreviewOpen(false)}><div className={css.preview}><h3>{title}</h3><p>{copy('版本','版本','Version')} {detail.knowledge.version} · {copy('已保存，尚未提交为工作资料','已儲存，尚未提交為工作資料','Saved, not applied as a work resource')}</p><article className={[css.markdown,markdownTypography.typography].join(" ")}><MarkdownPreview markdown={detail.knowledge.markdown} images={false}/></article><p>{copy('查看不会加入员工岗位或授予任务读取权限。','檢視不會加入員工崗位或授予任務讀取權限。','Viewing does not add this to an employee or authorize task access.')}</p>{ports.openResources&&<button type="button" onClick={()=>{setPreviewOpen(false);ports.openResources?.()}}>{copy('打开知识库','開啟知識庫','Open knowledge library')}</button>}</div></ContextDrawer>}
  {previewOpen&&detail?.capability&&<ContextDrawer title={category} close={()=>setPreviewOpen(false)}><div className={css.preview}><h3>{title}</h3><p>{detail.capability.description}</p><p>{state} · {copy('版本','版本','Version')} {detail.capability.version}</p><p>{copy('详情按实际配置读取。查看不会启用能力、连接服务或授予权限；可在会话继续提出修改。','詳情按實際設定讀取。檢視不會啟用能力、連線服務或授予權限；可在會話繼續提出修改。','Details reflect the saved configuration. Viewing does not enable capabilities, connect services, or grant permission. Continue changes in this conversation.')}</p><button type="button" onClick={()=>{setPreviewOpen(false);ports.openCapabilities()}}>{copy('打开应用','開啟應用程式','Open Apps')}</button></div></ContextDrawer>}
  {previewOpen&&detail?.mcp&&<ContextDrawer title={copy('MCP 连接','MCP 連線','MCP connection')} close={()=>setPreviewOpen(false)}><div className={css.preview}><h3>{title}</h3><p>{state}</p><p>{copy('保存定义不会自动连接。工具调用仍遵循会话授权与审核。','儲存定義不會自動連線。工具呼叫仍遵循會話授權與審核。','Saving a definition does not connect it. Tool calls follow conversation permissions.')}</p>{detail.mcp.errorMessage&&<p role="alert">{copy('暂时无法连接，请核对服务是否可用。','暫時無法連線，請核對服務是否可用。','Unable to connect. Check that the service is available.')}</p>}<ul>{detail.mcp.tools?.map(tool=><li key={tool.fullName}>{tool.name}</li>)}</ul><button type="button" disabled={busy} onClick={()=>void mcpAction()}>{busy?copy('处理中…','處理中…','Working…'):detail.mcp.status==='connected'?copy('断开连接','中斷連線','Disconnect'):copy('连接','連線','Connect')}</button>{error&&<p role="alert">{error}</p>}</div></ContextDrawer>}
 </>
}
