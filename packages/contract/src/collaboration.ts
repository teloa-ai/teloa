import {WorkError} from './index.ts'
import {artifactFilePath} from './artifact-files.ts'
import {groupReferenceMaxFiles} from './group-attachments.ts'

export type MessageReferenceKind='group-resource'|'artifact'|'attachment'
export type MessageReference={kind:MessageReferenceKind;id:string;version:number}
export type GroupMention={roleId:string;expectedVersion:number}
/** 群规则只描述群内可见性与提醒边界，不授予资料、审批或执行权限。 */
export type GroupRules={historyVisibleToNewMembers:boolean;draftsVisibleInGroup:boolean;mentionAllAllowed:boolean}
export type GroupDefinition={name:string;scope:string;announcement:string;rules:GroupRules;memberRoleIds:string[]}
export type GroupChangeFields={name:string;announcement:string;rules:GroupRules;memberRoleIds:string[];pinned:boolean;archived:boolean}
export type Group=Omit<GroupDefinition,'memberRoleIds'>&{id:string;ownerId:string;version:number;pinned:boolean;archived:boolean;createdAt:string;updatedAt:string}
/** `roleId: null` 表示由可信服务端主体代表的本人成员。 */
export type GroupMember={groupId:string;roleId:string|null;createdAt:string}
/** 首片只允许可信服务端主体写入 `self` 作者，客户端发送请求没有作者字段。 */
export type GroupHumanMessage={id:string;groupId:string;rootId:string|null;authorId:'self';text:string;references:MessageReference[];mentions:GroupMention[];createdAt:string}
/** AI 员工的群内回传必须保留产生它的任务与已确认运行，不接受浏览器自报作者。 */
export type GroupEmployeeMessage={id:string;groupId:string;rootId:string|null;authorId:string;taskId:string;runId:string;text:string;references:MessageReference[];createdAt:string}
export type GroupMessage=GroupHumanMessage|GroupEmployeeMessage
/** 群资料身份只归属于一个本人群；正文由确切版本读取。 */
export type GroupResource={id:string;groupId:string;ownerId:string;version:number;title:string;withdrawnAt:string|null;createdAt:string;updatedAt:string}
export type GroupResourceVersion={resourceId:string;groupId:string;version:number;title:string;markdown:string;createdAt:string}
/**
 * 群成员身份与群授权是两条独立关系。资料引用固定到不可变版本，避免修订后静默扩大上下文。
 */
export type GroupAgentResourceGrant=MessageReference
export type GroupAgentGrant={groupId:string;roleId:string;groupVersion:number;roleVersion:number;grantVersion:number;state:'active'|'revoked';resources:GroupAgentResourceGrant[];canPost:boolean;canAutoRun:boolean;createdAt:string}
export type GroupAgentGrantStatus='not-granted'|'active'|'revoked'|'invalidated'
export type GroupAgentGrantRead={groupVersion:number;roleVersion:number;grant:GroupAgentGrant|null;status:GroupAgentGrantStatus}
/** 群消息转任务时固定原消息与话题根；后续群内运行只能从这份快照恢复上下文。 */
export type GroupTaskSource={schema:'teloa.group-task-source/v1';taskId:string;ownerId:string;groupId:string;groupVersion:number;messageId:string;rootId:string;messageCreatedAt:string;messageText:string;references:MessageReference[];createdAssignee:{roleId:string;roleVersion:number}|null;trigger:'manual'|'mention'|'routed';createdAt:string}
export type GroupTaskCreateInput={requestId:string;groupId:string;messageId:string;expectedGroupVersion:number;goal:string;assignee?:{roleId:string;expectedVersion:number};trigger?:'manual'|'mention'|'routed'}
export type GroupCreateInput={requestId:string;expectedVersion:0;fields:GroupDefinition}
export type GroupChangeInput={requestId:string;groupId:string;expectedVersion:number;fields:GroupChangeFields}
export type GroupSendInput={requestId:string;groupId:string;expectedVersion:number;text:string;rootId?:string;references?:MessageReference[];mentions?:GroupMention[]}
/** 仅宿主内部使用：从已经确认的任务运行向其原群话题回传。 */
export type GroupRunMessageInput={requestId:string;runId:string;text:string;files?:GroupRunFileClaim[]}
/** 仅宿主内部使用：员工声明本次运行里要贴回群的文件；调用方不能提供引用。 */
export type GroupRunFileClaim={path:string;sha256:string}
export type GroupListInput=Record<string,never>
export type GroupMessageListInput={groupId:string;rootId?:string}
export type GroupResourceListInput={groupId:string}
export type GroupResourceGetInput={groupId:string;resourceId:string;resourceVersion:number}
export type GroupResourceSaveInput={requestId:string;groupId:string;resourceId:string;expectedVersion:number;title:string;markdown:string}
export type GroupResourceWithdrawInput={requestId:string;groupId:string;resourceId:string;expectedVersion:number}
export type GroupAgentGrantGetInput={groupId:string;roleId:string}
export type GroupAgentGrantChangeInput={requestId:string;groupId:string;roleId:string;expectedGroupVersion:number;expectedRoleVersion:number;action:'save'|'revoke';resources:GroupAgentResourceGrant[];canPost:boolean;canAutoRun:boolean}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const version=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))
const fail=():never=>{throw new WorkError('teloa/invalid-input','群协作请求包含未知字段或格式不正确。')}
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
  if(!record(value)||Object.keys(value).some(key=>!keys.includes(key)))fail()
  return value as Record<string,unknown>
}
const text=(value:unknown,max:number):string=>{
  if(typeof value!=='string'||!value.trim()||value.length>max)fail()
  return (value as string).trim()
}
const scope=(value:unknown):string=>{
  const result=text(value,64)
  if(!/^[a-zA-Z0-9_-]+$/.test(result))fail()
  return result
}
/** 已存行可能没有 `rules`；缺省按全部允许回落，避免旧群读取失败。 */
const rules=(value:unknown):GroupRules=>{
  if(value===undefined)return {historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}
  const row=exact(value,['historyVisibleToNewMembers','draftsVisibleInGroup','mentionAllAllowed'])
  if(typeof row.historyVisibleToNewMembers!=='boolean'||typeof row.draftsVisibleInGroup!=='boolean'||typeof row.mentionAllAllowed!=='boolean')fail()
  return {historyVisibleToNewMembers:row.historyVisibleToNewMembers as boolean,draftsVisibleInGroup:row.draftsVisibleInGroup as boolean,mentionAllAllowed:row.mentionAllAllowed as boolean}
}
const roleIds=(value:unknown):string[]=>{
  if(!Array.isArray(value)||value.length>30||value.some(item=>!uuid(item))||new Set(value).size!==value.length)fail()
  return (value as unknown[]).map(item=>item as string)
}

const artifactId=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9-]{36}$/i.test(value)
const attachmentRefId=(value:unknown):value is string=>typeof value==='string'&&value.length>=1&&value.length<=512&&value.trim()===value&&!!value.trim()&&!/^(blob:|data:|https?:|file:)/i.test(value)

export function isMessageReference(value:unknown):value is MessageReference{
  if(!record(value)||Object.keys(value).length!==3)return false
  if(value.kind==='group-resource')return uuid(value.id)&&version(value.version)
  if(value.kind==='artifact')return artifactId(value.id)&&version(value.version)
  return value.kind==='attachment'&&attachmentRefId(value.id)&&value.version===1
}

/**
 * 已存行的引用可能是旧形状 {resourceId,resourceVersion}；按群资料归一化回落，
 * 避免旧消息、旧授权与旧任务来源读取失败（先例：rules()，:62-64）。
 */
const normalizeReference=(value:unknown):unknown=>{
  if(!record(value))return value
  const keys=Object.keys(value)
  // 新形状按固定键序重建：jsonb 回读会按自己的顺序排键，客户端回执核对（JSON 字面比对）不能受键序影响。
  if(keys.length===3&&'kind' in value&&'id' in value&&'version' in value)return {kind:value.kind,id:value.id,version:value.version}
  if(keys.length!==2||!('resourceId' in value)||!('resourceVersion' in value))return value
  return {kind:'group-resource',id:value.resourceId,version:value.resourceVersion}
}

/**
 * 内部工具：读表函数把已存行的整个引用数组归一化后再交给判定器；
 * 非数组原样返回，由判定器拒。不是新增契约面，只是把上面这条归一化规则共享出去，
 * 免得后端四个读表函数各抄一份。
 */
export const normalizeReferences=(value:unknown):unknown=>Array.isArray(value)?value.map(normalizeReference):value

const references=(value:unknown):MessageReference[]=>{
  if(!Array.isArray(value)||value.length>8)fail()
  const rows=(value as unknown[]).map(normalizeReference)
  if(!rows.every(isMessageReference)||new Set((rows as MessageReference[]).map(r=>`${r.kind}:${r.id}`)).size!==rows.length)fail()
  return (rows as MessageReference[]).map(reference=>({...reference}))
}

export function isGroupMention(value:unknown):value is GroupMention{
  return record(value)&&Object.keys(value).length===2&&uuid(value.roleId)&&version(value.expectedVersion)
}

/** 上限 8、roleId 去重、expectedVersion 为正整数；服务端不解析正文里的 @ 文本。 */
const mentions=(value:unknown):GroupMention[]=>{
  if(!Array.isArray(value)||value.length>8||!value.every(isGroupMention)||new Set(value.map(mention=>mention.roleId)).size!==value.length)fail()
  return (value as GroupMention[]).map(mention=>({...mention}))
}

const agentGrantResources=(value:unknown):GroupAgentResourceGrant[]=>{
  if(!Array.isArray(value)||value.length>32)fail()
  const rows=(value as unknown[]).map(normalizeReference)
  if(!rows.every(isMessageReference)||new Set((rows as MessageReference[]).map(r=>`${r.kind}:${r.id}`)).size!==rows.length)fail()
  return (rows as GroupAgentResourceGrant[]).map(reference=>({...reference}))
}

/** 只收路径声明，绝不收引用：员工不能转发本人的附件或别处的成果，类型层面不可达。 */
const groupRunFileClaims=(value:unknown):GroupRunFileClaim[]=>{
  if(!Array.isArray(value)||value.length>groupReferenceMaxFiles)fail()
  const rows=(value as unknown[]).map(item=>{
    const row=exact(item,['path','sha256'])
    if(!artifactFilePath(row.path)||(row.path as string).endsWith('/')||typeof row.sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.sha256))fail()
    return {path:row.path as string,sha256:row.sha256 as string}
  })
  if(new Set(rows.map(row=>`${row.path}\0${row.sha256}`)).size!==rows.length)fail()
  return rows
}

export function groupDefinition(value:unknown):GroupDefinition{
  const row=exact(value,['name','scope','announcement','rules','memberRoleIds'])
  const announcement=row.announcement
  if(typeof announcement!=='string'||announcement.length>4000)fail()
  return {name:text(row.name,80),scope:scope(row.scope),announcement:(announcement as string).trim(),rules:rules(row.rules),memberRoleIds:roleIds(row.memberRoleIds)}
}

export function groupChangeFields(value:unknown):GroupChangeFields{
  const row=exact(value,['name','announcement','rules','memberRoleIds','pinned','archived'])
  const announcement=row.announcement,pinned=row.pinned,archived=row.archived
  if(typeof announcement!=='string'||announcement.length>4000||typeof pinned!=='boolean'||typeof archived!=='boolean')fail()
  return {name:text(row.name,80),announcement:(announcement as string).trim(),rules:rules(row.rules),memberRoleIds:roleIds(row.memberRoleIds),pinned:pinned as boolean,archived:archived as boolean}
}

export function groupCreateInput(value:unknown):GroupCreateInput{
  const row=exact(value,['requestId','expectedVersion','fields'])
  const requestId=row.requestId
  if(!uuid(requestId)||row.expectedVersion!==0)fail()
  return {requestId:requestId as string,expectedVersion:0,fields:groupDefinition(row.fields)}
}

export function groupChangeInput(value:unknown):GroupChangeInput{
  const row=exact(value,['requestId','groupId','expectedVersion','fields'])
  const requestId=row.requestId,groupId=row.groupId,expectedVersion=row.expectedVersion
  if(!uuid(requestId)||!uuid(groupId)||!version(expectedVersion))fail()
  return {requestId:requestId as string,groupId:groupId as string,expectedVersion:expectedVersion as number,fields:groupChangeFields(row.fields)}
}

export function groupSendInput(value:unknown):GroupSendInput{
  const row=exact(value,['requestId','groupId','expectedVersion','text','rootId','references','mentions'])
  const requestId=row.requestId,groupId=row.groupId,expectedVersion=row.expectedVersion,rootId=row.rootId
  if(!uuid(requestId)||!uuid(groupId)||!version(expectedVersion))fail()
  if(rootId!==undefined&&!uuid(rootId))fail()
  const result:GroupSendInput={requestId:requestId as string,groupId:groupId as string,expectedVersion:expectedVersion as number,text:text(row.text,8000)}
  if(rootId!==undefined)result.rootId=rootId as string
  if(row.references!==undefined)result.references=references(row.references)
  if(row.mentions!==undefined)result.mentions=mentions(row.mentions)
  return result
}

export function groupRunMessageInput(value:unknown):GroupRunMessageInput{
  const row=exact(value,['requestId','runId','text','files'])
  if(!uuid(row.requestId)||!uuid(row.runId))fail()
  const result:GroupRunMessageInput={requestId:row.requestId as string,runId:row.runId as string,text:text(row.text,8000)}
  if(row.files!==undefined)result.files=groupRunFileClaims(row.files)
  return result
}

export function groupListInput(value:unknown):GroupListInput{
  exact(value,[])
  return {}
}

export function groupMessageListInput(value:unknown):GroupMessageListInput{
  const row=exact(value,['groupId','rootId'])
  const groupId=row.groupId,rootId=row.rootId
  if(!uuid(groupId)||rootId!==undefined&&!uuid(rootId))fail()
  return rootId===undefined?{groupId:groupId as string}:{groupId:groupId as string,rootId:rootId as string}
}

export function groupResourceListInput(value:unknown):GroupResourceListInput{
  const row=exact(value,['groupId'])
  if(!uuid(row.groupId))fail()
  return {groupId:row.groupId as string}
}

export function groupResourceGetInput(value:unknown):GroupResourceGetInput{
  const row=exact(value,['groupId','resourceId','resourceVersion'])
  if(!uuid(row.groupId)||!uuid(row.resourceId)||!version(row.resourceVersion))fail()
  return {groupId:row.groupId as string,resourceId:row.resourceId as string,resourceVersion:row.resourceVersion as number}
}

export function groupResourceSaveInput(value:unknown):GroupResourceSaveInput{
  const row=exact(value,['requestId','groupId','resourceId','expectedVersion','title','markdown'])
  const requestId=row.requestId,groupId=row.groupId,resourceId=row.resourceId,expectedVersion=row.expectedVersion,markdown=row.markdown
  if(!uuid(requestId)||!uuid(groupId)||!uuid(resourceId)||typeof expectedVersion!=='number'||!Number.isSafeInteger(expectedVersion)||expectedVersion<0||typeof markdown!=='string'||!markdown.trim()||markdown.length>16000)fail()
  return {requestId:requestId as string,groupId:groupId as string,resourceId:resourceId as string,expectedVersion:expectedVersion as number,title:text(row.title,120),markdown:(markdown as string).trim()}
}

export function groupResourceWithdrawInput(value:unknown):GroupResourceWithdrawInput{
  const row=exact(value,['requestId','groupId','resourceId','expectedVersion'])
  if(!uuid(row.requestId)||!uuid(row.groupId)||!uuid(row.resourceId)||!version(row.expectedVersion))fail()
  return {requestId:row.requestId as string,groupId:row.groupId as string,resourceId:row.resourceId as string,expectedVersion:row.expectedVersion as number}
}

export function groupTaskCreateInput(value:unknown):GroupTaskCreateInput{
  const row=exact(value,['requestId','groupId','messageId','expectedGroupVersion','goal','assignee','trigger'])
  if(!uuid(row.requestId)||!uuid(row.groupId)||!uuid(row.messageId)||!version(row.expectedGroupVersion)||typeof row.goal!=='string'||!row.goal.trim()||row.goal.length>8000)fail()
  let assignee:GroupTaskCreateInput['assignee']
  if(row.assignee!==undefined){
    const candidate=exact(row.assignee,['roleId','expectedVersion'])
    if(!uuid(candidate.roleId)||!version(candidate.expectedVersion))fail()
    assignee={roleId:candidate.roleId as string,expectedVersion:candidate.expectedVersion as number}
  }
  if(row.trigger!==undefined&&row.trigger!=='manual'&&row.trigger!=='mention'&&row.trigger!=='routed')fail()
  return {requestId:row.requestId as string,groupId:row.groupId as string,messageId:row.messageId as string,expectedGroupVersion:row.expectedGroupVersion as number,goal:(row.goal as string).trim(),...(assignee?{assignee}:{}),...(row.trigger===undefined?{}:{trigger:row.trigger as 'manual'|'mention'|'routed'})}
}

export function groupAgentGrantGetInput(value:unknown):GroupAgentGrantGetInput{
  const row=exact(value,['groupId','roleId'])
  if(!uuid(row.groupId)||!uuid(row.roleId))fail()
  return {groupId:row.groupId as string,roleId:row.roleId as string}
}

export function groupAgentGrantChangeInput(value:unknown):GroupAgentGrantChangeInput{
  const row=exact(value,['requestId','groupId','roleId','expectedGroupVersion','expectedRoleVersion','action','resources','canPost','canAutoRun'])
  if(!uuid(row.requestId)||!uuid(row.groupId)||!uuid(row.roleId)||!version(row.expectedGroupVersion)||!version(row.expectedRoleVersion)||!['save','revoke'].includes(String(row.action))||typeof row.canPost!=='boolean'||typeof row.canAutoRun!=='boolean')fail()
  const resources=agentGrantResources(row.resources),action=row.action as 'save'|'revoke',canPost=row.canPost as boolean,canAutoRun=row.canAutoRun as boolean
  if(action==='revoke'&&(resources.length>0||canPost||canAutoRun)||action==='save'&&resources.length===0&&!canPost&&!canAutoRun)fail()
  return {requestId:row.requestId as string,groupId:row.groupId as string,roleId:row.roleId as string,expectedGroupVersion:row.expectedGroupVersion as number,expectedRoleVersion:row.expectedRoleVersion as number,action,resources,canPost,canAutoRun}
}

export function isGroupRules(value:unknown):value is GroupRules{
  return record(value)&&Object.keys(value).length===3&&typeof value.historyVisibleToNewMembers==='boolean'&&typeof value.draftsVisibleInGroup==='boolean'&&typeof value.mentionAllAllowed==='boolean'
}

export function isGroup(value:unknown):value is Group{
  if(!record(value)||Object.keys(value).length!==11)return false
  return uuid(value.id)&&typeof value.ownerId==='string'&&!!value.ownerId.trim()&&value.ownerId.length<=128&&version(value.version)&&typeof value.name==='string'&&!!value.name.trim()&&value.name.length<=80&&typeof value.scope==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(value.scope)&&typeof value.announcement==='string'&&value.announcement.length<=4000&&isGroupRules(value.rules)&&typeof value.pinned==='boolean'&&typeof value.archived==='boolean'&&stamp(value.createdAt)&&stamp(value.updatedAt)
}

export function isGroupMember(value:unknown):value is GroupMember{
  return record(value)&&Object.keys(value).length===3&&uuid(value.groupId)&&(value.roleId===null||uuid(value.roleId))&&stamp(value.createdAt)
}

export function isGroupMessage(value:unknown):value is GroupMessage{
  if(!record(value)||!uuid(value.id)||!uuid(value.groupId)||(value.rootId!==null&&!uuid(value.rootId))||value.rootId===value.id||typeof value.text!=='string'||!value.text.trim()||value.text.length>8000||!Array.isArray(value.references)||!value.references.every(isMessageReference)||new Set((value.references as MessageReference[]).map(reference=>`${reference.kind}:${reference.id}`)).size!==value.references.length||value.references.length>8||!stamp(value.createdAt))return false
  if(value.authorId==='self')return Object.keys(value).length===8&&Array.isArray(value.mentions)&&value.mentions.length<=8&&value.mentions.every(isGroupMention)&&new Set((value.mentions as GroupMention[]).map(mention=>mention.roleId)).size===value.mentions.length
  return Object.keys(value).length===9&&uuid(value.authorId)&&uuid(value.taskId)&&uuid(value.runId)
}

export function isGroupTaskSource(value:unknown):value is GroupTaskSource{
  if(!record(value)||Object.keys(value).length!==13||value.schema!=='teloa.group-task-source/v1'||!uuid(value.taskId)||typeof value.ownerId!=='string'||!value.ownerId.trim()||value.ownerId.length>128||!uuid(value.groupId)||!version(value.groupVersion)||!uuid(value.messageId)||!uuid(value.rootId)||!stamp(value.messageCreatedAt)||typeof value.messageText!=='string'||!value.messageText.trim()||value.messageText.length>8000||!Array.isArray(value.references)||!value.references.every(isMessageReference)||new Set((value.references as MessageReference[]).map(reference=>`${reference.kind}:${reference.id}`)).size!==value.references.length||value.references.length>8||value.trigger!=='manual'&&value.trigger!=='mention'&&value.trigger!=='routed'||!stamp(value.createdAt))return false
  const assignee=value.createdAssignee
  return assignee===null||record(assignee)&&Object.keys(assignee).length===2&&uuid(assignee.roleId)&&version(assignee.roleVersion)
}

export function isGroupResource(value:unknown):value is GroupResource{
  return record(value)&&Object.keys(value).length===8&&uuid(value.id)&&uuid(value.groupId)&&typeof value.ownerId==='string'&&!!value.ownerId.trim()&&value.ownerId.length<=128&&version(value.version)&&typeof value.title==='string'&&!!value.title.trim()&&value.title.length<=120&&(value.withdrawnAt===null||stamp(value.withdrawnAt))&&stamp(value.createdAt)&&stamp(value.updatedAt)
}

export function isGroupResourceVersion(value:unknown):value is GroupResourceVersion{
  return record(value)&&Object.keys(value).length===6&&uuid(value.resourceId)&&uuid(value.groupId)&&version(value.version)&&typeof value.title==='string'&&!!value.title.trim()&&value.title.length<=120&&typeof value.markdown==='string'&&!!value.markdown.trim()&&value.markdown.length<=16000&&stamp(value.createdAt)
}

export function isGroupAgentGrant(value:unknown):value is GroupAgentGrant{
  return record(value)&&Object.keys(value).length===10&&uuid(value.groupId)&&uuid(value.roleId)&&version(value.groupVersion)&&version(value.roleVersion)&&version(value.grantVersion)&&['active','revoked'].includes(String(value.state))&&Array.isArray(value.resources)&&value.resources.length<=32&&value.resources.every(isMessageReference)&&new Set((value.resources as GroupAgentResourceGrant[]).map(reference=>`${reference.kind}:${reference.id}`)).size===value.resources.length&&typeof value.canPost==='boolean'&&typeof value.canAutoRun==='boolean'&&stamp(value.createdAt)&&!(value.state==='revoked'&&((value.resources as unknown[]).length>0||value.canPost===true||value.canAutoRun===true))
}

export function isGroupAgentGrantRead(value:unknown):value is GroupAgentGrantRead{
  return record(value)&&Object.keys(value).length===4&&version(value.groupVersion)&&version(value.roleVersion)&&(value.grant===null||isGroupAgentGrant(value.grant))&&['not-granted','active','revoked','invalidated'].includes(String(value.status))&&!(value.status==='not-granted'&&value.grant!==null)&&!(value.status==='active'&&(value.grant===null||value.grant.state!=='active'||value.grant.groupVersion!==value.groupVersion||value.grant.roleVersion!==value.roleVersion))
}
