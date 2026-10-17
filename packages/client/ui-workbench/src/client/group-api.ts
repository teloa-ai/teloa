import {groupAgentGrantChangeInput,groupAgentGrantGetInput,groupTaskCreateInput,groupChangeInput,groupCreateInput,groupListInput,groupMessageListInput,groupResourceGetInput,groupResourceListInput,groupResourceSaveInput,groupResourceWithdrawInput,groupSendInput,isGroup,isGroupAgentGrant,isGroupAgentGrantRead,isGroupTaskSource,isGroupMember,isGroupMessage,isGroupResource,isGroupResourceVersion,type Group,type GroupAgentGrant,type GroupMention,type GroupTaskSource,type WorkTask,type GroupAgentGrantRead,type GroupChangeFields,type GroupCreateInput,type GroupMember,type GroupMessage,type GroupResource,type GroupResourceVersion,type GroupSendInput,type MessageReference} from '@teloa/contract'
import {groupMentionsInput,readGroupAttention,readGroupMentionsPage} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'
import {groupReadingInput,groupMarkReadInput,readGroupReadingState} from '@teloa/contract'
import {groupMessagePageInput,groupMessageSearchInput,readGroupMessagePage,readGroupMessageSearchResult,type GroupMessagePageInput} from '@teloa/contract'
import {groupTaskBusinessTarget,type GroupTaskBusinessTarget} from '@teloa/contract'
import {readSavedTask} from './task-api.ts'
import {WorkError,groupMessageBodyInput,isGroupMessageBody,isGroupMessageBodySummary,type GroupMessageBody,type GroupMessageBodySummary} from '@teloa/contract'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
export type GroupRequestJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
export type GroupSnapshot={group:Group;members:GroupMember[]}
export type GroupDirectory={items:Group[]}
export type GroupMessageDirectory={items:GroupMessage[]}
export type GroupResourceDirectory={items:GroupResource[]}
export type GroupTaskRecord={task:WorkTask;source:GroupTaskSource}
type GroupCommand={kind:'create';request:GroupCreateInput}|{kind:'change';request:ReturnType<typeof groupChangeInput>}|{kind:'send';request:GroupSendInput}|{kind:'save-resource';request:ReturnType<typeof groupResourceSaveInput>}|{kind:'withdraw-resource';request:ReturnType<typeof groupResourceWithdrawInput>}|{kind:'agent-grant';request:ReturnType<typeof groupAgentGrantChangeInput>}|{kind:'task';request:ReturnType<typeof groupTaskCreateInput>}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const stamp=(value:string)=>new Date(value).toISOString()===value
const exact=(value:unknown,keys:readonly string[],label:string):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw Error(label)
 return value as Record<string,unknown>
}
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right)
const clone=<T>(value:T):T=>structuredClone(value)
// 贴密钥闸拒收（details.reason='secret-in-message'）：宿主保证未登记、未落库、未派发，同样按无副作用释放，恢复记录不留原文。
const secretRejected=(error:object)=>'details' in error&&!!error.details&&typeof error.details==='object'&&(error.details as {reason?:unknown}).reason==='secret-in-message'
const noSideEffect=(error:unknown)=>!!error&&typeof error==='object'&&'rejected' in error&&(error as {rejected?:unknown}).rejected===true&&(('noSideEffect' in error&&(error as {noSideEffect?:unknown}).noSideEffect===true)||secretRejected(error))

function savedGroup(value:unknown,label:string,ownerId='self'):Group{
 try{
  if(!isGroup(value)||value.ownerId!==ownerId||!stamp(value.createdAt)||!stamp(value.updatedAt)||value.updatedAt<value.createdAt)throw Error()
  return clone(value)
 }catch{throw Error(label)}
}

function snapshot(value:unknown,label='群详情格式不正确。',ownerId='self'):GroupSnapshot{
 try{
  const row=exact(value,['group','members'],label),candidate=row.group
  const group=savedGroup(candidate,label,ownerId)
  if(!Array.isArray(row.members)||row.members.length<1||row.members.length>31)throw Error()
  const members=row.members.map(member=>{if(!isGroupMember(member)||member.groupId!==group.id||!stamp(member.createdAt))throw Error();return clone(member)})
  const identities=members.map(member=>member.roleId??'self')
  if(identities.filter(identity=>identity==='self').length!==1||new Set(identities).size!==identities.length||(group.memberCount!==undefined&&group.memberCount!==members.length))throw Error()
  return {group,members}
 }catch{throw Error(label)}
}

function groupOrder(left:Group,right:Group):number{
 return Number(right.pinned)-Number(left.pinned)||right.updatedAt.localeCompare(left.updatedAt)||left.id.localeCompare(right.id)
}

function messageOrder(left:GroupMessage,right:GroupMessage):number{return left.createdAt.localeCompare(right.createdAt)||left.id.localeCompare(right.id)}

function groupDirectory(value:unknown,ownerId='self'):Group[]{
 try{
  if(!Array.isArray(value)||value.length>1000)throw Error()
  const items=value.map(item=>savedGroup(item,'群目录格式不正确。',ownerId))
  if(items.some((item,index)=>index>0&&groupOrder(items[index-1]!,item)>=0))throw Error()
  if(new Set(items.map(item=>item.id)).size!==items.length)throw Error()
  return items
 }catch{throw Error('群目录格式不正确。')}
}

function messageDirectory(value:unknown,groupId:string,rootId:string|undefined):GroupMessage[]{
 try{
  if(!Array.isArray(value)||value.length>10000)throw Error()
  const items=value.map(item=>{if(!isGroupMessage(item)||item.groupId!==groupId||!stamp(item.createdAt))throw Error();return clone(item)})
  if(rootId===undefined){
   const roots=new Set(items.filter(item=>item.rootId===null).map(item=>item.id))
   if(items.some(item=>item.rootId!==null&&!roots.has(item.rootId))||items.some((item,index)=>index>0&&messageOrder(items[index-1]!,item)>=0))throw Error()
  }else{
   // 话题读取返回根消息本身，再返回其回复；根消息的 rootId 仍然是 null。
   if(items.length===0||items[0]!.id!==rootId||items[0]!.rootId!==null||items.slice(1).some(item=>item.rootId!==rootId))throw Error()
   const replies=items.slice(1)
   if(replies.some((item,index)=>index>0&&messageOrder(replies[index-1]!,item)>=0))throw Error()
  }
  if(new Set(items.map(item=>item.id)).size!==items.length)throw Error()
  return items
 }catch{throw Error('群消息目录格式不正确。')}
}

function savedResource(value:unknown,label:string,ownerId='self'):GroupResource{
 try{
  if(!isGroupResource(value)||value.ownerId!==ownerId||!stamp(value.createdAt)||!stamp(value.updatedAt)||value.updatedAt<value.createdAt)throw Error()
  return clone(value)
 }catch{throw Error(label)}
}

function resourceDirectory(value:unknown,groupId:string,ownerId='self'):GroupResource[]{
 try{
  if(!Array.isArray(value)||value.length>10000)throw Error()
  const items=value.map(item=>{const resource=savedResource(item,'群资料目录格式不正确。',ownerId);if(resource.groupId!==groupId)throw Error();return resource})
  if(new Set(items.map(item=>item.id)).size!==items.length)throw Error()
  return items
 }catch{throw Error('群资料目录格式不正确。')}
}

function resourceVersion(value:unknown,groupId:string,resourceId:string,version:number):GroupResourceVersion{
 try{
  if(!isGroupResourceVersion(value)||value.groupId!==groupId||value.resourceId!==resourceId||value.version!==version||!stamp(value.createdAt))throw Error()
  return clone(value)
 }catch{throw Error('群资料版本格式不正确。')}
}

function agentGrantRead(value:unknown,groupId:string,roleId:string):GroupAgentGrantRead{
 try{
  if(!isGroupAgentGrantRead(value)||value.grant!==null&&(!isGroupAgentGrant(value.grant)||value.grant.groupId!==groupId||value.grant.roleId!==roleId))throw Error()
  return clone(value)
 }catch{throw Error('群员工授权状态格式不正确。')}
}

function matchingMembers(snapshotValue:GroupSnapshot,roleIds:readonly string[]):boolean{
 const expected=new Set(['self',...roleIds]),actual=new Set(snapshotValue.members.map(member=>member.roleId??'self'))
 return expected.size===actual.size&&[...expected].every(id=>actual.has(id))
}

function matchingGroup(snapshotValue:GroupSnapshot,fields:GroupChangeFields|GroupCreateInput['fields'],version:number,creating=false):boolean{
 const group=snapshotValue.group
 const scope='scope' in fields?fields.scope:group.scope
 return (!creating||same(group.source,'source'in fields?fields.source:undefined))&&(!(creating||fields.coordinatorRoleId!==undefined)||group.coordinatorRoleId===(fields.coordinatorRoleId??undefined))&&group.version===version&&group.name===fields.name&&group.scope===scope&&(fields.purpose===undefined||(group.purpose??'')===fields.purpose)&&group.announcement===fields.announcement&&group.pinned===('pinned' in fields?fields.pinned:false)&&group.archived===('archived' in fields?fields.archived:false)&&matchingMembers(snapshotValue,fields.memberRoleIds)
}

function command(value:unknown):GroupCommand{
 const row=exact(value,['kind','request'],'群协作恢复记录不可读取或已损坏，写入已暂停。')
 if(row.kind==='create')return {kind:'create',request:groupCreateInput(row.request)}
 if(row.kind==='change')return {kind:'change',request:groupChangeInput(row.request)}
 if(row.kind==='send')return {kind:'send',request:groupSendInput(row.request)}
 if(row.kind==='save-resource')return {kind:'save-resource',request:groupResourceSaveInput(row.request)}
 if(row.kind==='withdraw-resource')return {kind:'withdraw-resource',request:groupResourceWithdrawInput(row.request)}
 if(row.kind==='agent-grant')return {kind:'agent-grant',request:groupAgentGrantChangeInput(row.request)}
 if(row.kind==='task')return {kind:'task',request:groupTaskCreateInput(row.request)}
 throw Error('群协作恢复记录不可读取或已损坏，写入已暂停。')
}

export type GroupApi=ReturnType<typeof createGroupApi>
export function createGroupApi(call:Call,journal?:GroupRequestJournal,newId:()=>string=()=>crypto.randomUUID(),ownerId='self'){
 let pending:GroupCommand|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false,directory:GroupDirectory|undefined,directoryGeneration=0
 const groups=new Map<string,GroupSnapshot>(),groupGenerations=new Map<string,number>(),messageDirectories=new Map<string,GroupMessageDirectory>(),messageGenerations=new Map<string,number>(),resourceDirectories=new Map<string,GroupResourceDirectory>(),resourceGenerations=new Map<string,number>(),resourceVersions=new Map<string,GroupResourceVersion>(),resourceVersionGenerations=new Map<string,number>()
 try{
  const raw=journal?.read()
  if(raw){if(raw.length>30000)throw Error();const saved=exact(JSON.parse(raw),['schema','command'],'群协作恢复记录不可读取或已损坏，写入已暂停。');if(saved.schema!=='teloa.groups/v1')throw Error();pending=command(saved.command)}
 }catch{recoveryError=recoveryStorageError()}
 const clear=()=>{journal?.clear();pending=undefined}
 const persist=()=>journal?.write(JSON.stringify({schema:'teloa.groups/v1',command:pending}))
 const send=async():Promise<GroupSnapshot|GroupMessage|GroupResource|GroupAgentGrant|GroupTaskRecord>=>{
  if(recoveryError)throw recoveryError
  if(!pending)throw Error('没有待核对的群协作请求。')
  if(busy)throw Error('群协作请求正在核对。')
  busy=true
  try{
   persist()
   const current=pending
   if(current.kind==='create'){
    const saved=savedGroup(await call('groups/create',current.request),'群创建回执格式不正确。',ownerId)
    const result=snapshot(await call('groups/get',{groupId:saved.id}),'群详情格式不正确。',ownerId)
    if(result.group.id!==saved.id||result.group.version!==saved.version)throw Error('群创建详情与回执不一致，已保留恢复请求。')
    if(!matchingGroup(result,current.request.fields,1,true))throw Error('群创建回执与原请求不一致，已保留恢复请求。')
    clear();return result
   }
   if(current.kind==='change'){
    const saved=savedGroup(await call('groups/change',current.request),'群变更回执格式不正确。',ownerId)
    const result=snapshot(await call('groups/get',{groupId:saved.id}),'群详情格式不正确。',ownerId)
    if(result.group.id!==saved.id||result.group.version!==saved.version)throw Error('群变更详情与回执不一致，已保留恢复请求。')
    if(result.group.id!==current.request.groupId||!matchingGroup(result,{...current.request.fields,scope:result.group.scope},current.request.expectedVersion+1))throw Error('群变更回执与原请求不一致，已保留恢复请求。')
    clear();return result
   }
   if(current.kind==='save-resource'){
    const result=savedResource(await call('groups/resources/save',current.request),'群资料保存回执格式不正确。',ownerId)
    const expected=current.request.expectedVersion===0?1:current.request.expectedVersion+1
    if(result.id!==current.request.resourceId||result.groupId!==current.request.groupId||result.version!==expected||result.title!==current.request.title||result.withdrawnAt!==null)throw Error('群资料保存回执与原请求不一致，已保留恢复请求。')
    clear();return result
   }
   if(current.kind==='withdraw-resource'){
    const result=savedResource(await call('groups/resources/withdraw',current.request),'群资料撤回回执格式不正确。',ownerId)
    if(result.id!==current.request.resourceId||result.groupId!==current.request.groupId||result.version!==current.request.expectedVersion||result.withdrawnAt===null)throw Error('群资料撤回回执与原请求不一致，已保留恢复请求。')
    clear();return result
   }
   if(current.kind==='task'){
    const response=exact(await call('groups/tasks/create',current.request),['task','source'],'群消息任务回执格式不正确。')
    const task=readSavedTask(response.task),source=response.source
    const target=isGroupTaskSource(source)&&source.schema==='teloa.group-task-source/v2'?source.businessTarget:undefined
    if((target===undefined)!==(current.request.businessTarget===undefined)||target&&(task.scope!==target.scope||!same(groupTaskBusinessTarget(target),current.request.businessTarget)))throw Error('群任务业务目标回执与原请求不一致，已保留恢复请求。')
    if(!isGroupTaskSource(source)||source.ownerId!==ownerId||source.taskId!==task.id||source.groupId!==current.request.groupId||source.messageId!==current.request.messageId||source.groupVersion!==current.request.expectedGroupVersion||source.trigger!==(current.request.trigger??'manual')||source.createdAssignee?.roleId!==(current.request.assignee?.roleId??undefined)||source.createdAssignee?.roleVersion!==(current.request.assignee?.expectedVersion??undefined)||task.goal!==current.request.goal||task.assigneeRoleId!==(current.request.assignee?.roleId??null)||task.assigneeRoleVersion!==(current.request.assignee?.expectedVersion??null))throw Error('群消息任务回执与原请求不一致，已保留恢复请求。')
    clear();return {task,source:clone(source)}
   }
   if(current.kind==='agent-grant'){
    const result=await call('groups/agent-grants/change',current.request)
    if(!isGroupAgentGrant(result)||result.groupId!==current.request.groupId||result.roleId!==current.request.roleId||result.groupVersion!==current.request.expectedGroupVersion||result.roleVersion!==current.request.expectedRoleVersion||result.state!==(current.request.action==='save'?'active':'revoked')||!same(result.resources,current.request.resources)||result.canPost!==current.request.canPost||result.canAutoRun!==current.request.canAutoRun||current.request.expectedGrantVersion!==undefined&&result.grantVersion!==current.request.expectedGrantVersion+1)throw Error('群员工授权回执与原请求不一致，已保留恢复请求。')
    clear();return clone(result)
   }
   const result=await call('groups/messages/send',current.request)
   if(!isGroupMessage(result)||result.groupId!==current.request.groupId||result.rootId!==(current.request.rootId??null)||result.text!==current.request.text||!same(result.references,current.request.references??[])||!('mentions' in result)||!same(result.mentions,current.request.mentions??[])||result.replyToMessageId!==current.request.replyToMessageId||(result.mentionAll===true)!==(current.request.mentionAll===true))throw Error('群消息回执与原请求不一致，已保留恢复请求。')
   clear();return clone(result)
  }catch(error){const rejectedCas=pending?.kind==='agent-grant'&&pending.request.expectedGrantVersion!==undefined&&!!error&&typeof error==='object'&&'rejected'in error&&error.rejected===true&&'code'in error&&error.code==='teloa/version-conflict';if(noSideEffect(error)||rejectedCas)clear();throw error}finally{busy=false}
 }
 const queued=<T extends GroupCommand>(next:T):Promise<GroupSnapshot|GroupMessage|GroupResource|GroupAgentGrant|GroupTaskRecord>=>{
  if(recoveryError)return Promise.reject(recoveryError)
  if(pending&&!same(pending,next))return Promise.reject(Error('请先核对未完成的群协作请求，不能覆盖为其他操作。'))
  pending??=next
  return send()
 }
 const topicKey=(groupId:string,rootId:string|undefined)=>JSON.stringify([groupId,rootId??null])
 return {
  pending:()=>pending?clone(pending):undefined,
  recoveryMessage:()=>recoveryError,
  discardInaccessibleRecovery:(items?:readonly Group[])=>{
   const current=pending
   if(!current||current.kind==='create'||!items||items.some(item=>item.id===current.request.groupId&&!item.archived))return false
   clear()
   return true
  },
  /** 与 discardInaccessibleRecovery 同形状的别名，供统一的丢弃入口调用；不改变 discardInaccessibleRecovery 本身的语义。 */
  discard(){const had=pending!==undefined||recoveryError!==undefined;clear();recoveryError=undefined;return had},
  recover:send,
  directorySnapshot:()=>directory?clone(directory):undefined,
  groupSnapshot:(groupId:string)=>groups.has(groupId)?clone(groups.get(groupId)!):undefined,
  messagesSnapshot:(groupId:string,rootId?:string)=>messageDirectories.has(topicKey(groupId,rootId))?clone(messageDirectories.get(topicKey(groupId,rootId))!):undefined,
  resourcesSnapshot:(groupId:string)=>resourceDirectories.has(groupId)?clone(resourceDirectories.get(groupId)!):undefined,
  resourceSnapshot:(groupId:string,resourceId:string,version:number)=>{
   const key=JSON.stringify([groupId,resourceId,version])
   return resourceVersions.has(key)?clone(resourceVersions.get(key)!):undefined
  },
  async list():Promise<GroupDirectory>{
   const generation=++directoryGeneration,items=groupDirectory(await call('groups/list',groupListInput({})),ownerId)
   const result={items}
   if(generation===directoryGeneration)directory=clone(result)
   return result
  },
  async get(groupId:string):Promise<GroupSnapshot>{
   if(!uuid(groupId))throw Error('群身份格式不正确。')
   const generation=(groupGenerations.get(groupId)??0)+1;groupGenerations.set(groupId,generation)
   const result=snapshot(await call('groups/get',{groupId}),'群详情格式不正确。',ownerId)
   if(result.group.id!==groupId)throw Error('群详情与目标身份不一致。')
   if(groupGenerations.get(groupId)===generation)groups.set(groupId,clone(result))
   return result
  },
  async messages(groupId:string,rootId?:string):Promise<GroupMessageDirectory>{
   if(!uuid(groupId)||rootId!==undefined&&!uuid(rootId))throw Error('群消息读取参数不正确。')
   const key=topicKey(groupId,rootId),generation=(messageGenerations.get(key)??0)+1;messageGenerations.set(key,generation)
   const input=groupMessageListInput({groupId,...(rootId===undefined?{}:{rootId})})
   const items=messageDirectory(await call('groups/messages/list',input),groupId,rootId)
   const result={items}
   if(messageGenerations.get(key)===generation)messageDirectories.set(key,clone(result))
   return result
  },
  async reading(groupId:string,rootId?:string){
   const input=groupReadingInput({groupId,...(rootId===undefined?{}:{rootId})}),result=readGroupReadingState(await call('groups/reading/get',input))
   if(result.groupId!==groupId||result.rootId!==(rootId??null))throw new WorkError('teloa/invalid-host-response','群阅读位置与目标不一致。')
   return result
  },
  async attention(){return readGroupAttention(await call('groups/attention',{}))},
  async mentions(groupId:string,unreadOnly=false,before?:string,rootId?:string){
   const input=groupMentionsInput({groupId,unreadOnly,...(before?{before}:{}),...(rootId?{rootId}:{})}),result=readGroupMentionsPage(await call('groups/mentions/list',input))
   if(result.groupId!==groupId||result.rootId!==(rootId??null)||result.unreadOnly!==unreadOnly||result.items.length>input.limit)throw new WorkError('teloa/invalid-host-response','群提及与原目标不一致。')
   return result
  },
  async messagePage(groupId:string,rootId?:string,options:Partial<Omit<GroupMessagePageInput,'groupId'|'rootId'>>={}){
   const input=groupMessagePageInput({groupId,...(rootId===undefined?{}:{rootId}),...options}),result=readGroupMessagePage(await call('groups/messages/page',input))
   if(result.groupId!==groupId||result.rootId!==(rootId??null)||result.items.length>input.limit+(rootId?1:0)||result.topics.some(topic=>!result.items.some(row=>row.id===topic.rootId)&&!input.topicRoots?.includes(topic.rootId)))throw new WorkError('teloa/invalid-host-response','群消息窗口与目标不一致。')
   return result
  },
  async searchMessages(groupId:string,query:string,rootId?:string,before?:string){
   const input=groupMessageSearchInput({groupId,query,...(rootId===undefined?{}:{rootId}),...(before===undefined?{}:{before})}),result=readGroupMessageSearchResult(await call('groups/messages/search',input))
   if(result.groupId!==groupId||result.rootId!==(rootId??null)||result.query!==input.query||result.items.length>input.limit)throw new WorkError('teloa/invalid-host-response','群正文检索与原查询不一致。')
   return result
  },
  async markRead(groupId:string,messageId:string,rootId?:string){
   const input=groupMarkReadInput({groupId,messageId,...(rootId===undefined?{}:{rootId})}),result=readGroupReadingState(await call('groups/reading/mark',input))
   if(result.groupId!==groupId||result.rootId!==(rootId??null))throw new WorkError('teloa/invalid-host-response','群阅读位置与目标不一致。')
   return result
  },
  async resources(groupId:string):Promise<GroupResourceDirectory>{
   if(!uuid(groupId))throw Error('群身份格式不正确。')
   const generation=(resourceGenerations.get(groupId)??0)+1;resourceGenerations.set(groupId,generation)
   const items=resourceDirectory(await call('groups/resources/list',groupResourceListInput({groupId})),groupId,ownerId)
   const result={items}
   if(resourceGenerations.get(groupId)===generation)resourceDirectories.set(groupId,clone(result))
   return result
  },
  async messageBody(groupId:string,messageId:string,expected:GroupMessageBodySummary):Promise<GroupMessageBody>{
   const input=groupMessageBodyInput({groupId,messageId})
   if(!isGroupMessageBodySummary(expected))throw new WorkError('teloa/invalid-input','群消息全文身份不正确。')
   const summary={...expected}
   const value=await call('groups/messages/body',input)
   if(!isGroupMessageBody(value)||value.groupId!==groupId||value.messageId!==messageId||value.chars!==summary.chars||value.sha256!==summary.sha256)throw new WorkError('teloa/source-unavailable','群消息全文与原消息不一致。')
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value.text))),byte=>byte.toString(16).padStart(2,'0')).join('')
   if(hash!==summary.sha256)throw new WorkError('teloa/source-unavailable','群消息全文与原消息不一致。')
   return clone(value)
  },
  async resource(groupId:string,resourceId:string,version:number):Promise<GroupResourceVersion>{
   if(!uuid(groupId)||!uuid(resourceId)||!Number.isSafeInteger(version)||version<1)throw Error('群资料读取参数不正确。')
   const key=JSON.stringify([groupId,resourceId,version]),generation=(resourceVersionGenerations.get(key)??0)+1;resourceVersionGenerations.set(key,generation)
   const result=resourceVersion(await call('groups/resources/get',groupResourceGetInput({groupId,resourceId,resourceVersion:version})),groupId,resourceId,version)
   if(resourceVersionGenerations.get(key)===generation)resourceVersions.set(key,clone(result))
   return result
  },
  async agentGrant(groupId:string,roleId:string):Promise<GroupAgentGrantRead>{
   if(!uuid(groupId)||!uuid(roleId))throw Error('群或员工身份格式不正确。')
   return agentGrantRead(await call('groups/agent-grants/get',groupAgentGrantGetInput({groupId,roleId})),groupId,roleId)
  },
  /** 任务详情按需核对是否有群消息来源；不是群消息任务时回落 null，不视为错误。 */
  async taskSource(taskId:string):Promise<GroupTaskSource|null>{
   if(!uuid(taskId))throw Error('任务身份格式不正确。')
   const result=await call('groups/tasks/source',{taskId})
   if(result===null)return null
   if(!isGroupTaskSource(result)||result.ownerId!==ownerId||result.taskId!==taskId)throw Error('群消息任务来源格式不正确。')
   return clone(result)
  },
  create(fields:GroupCreateInput['fields']):Promise<GroupSnapshot>{return queued({kind:'create',request:groupCreateInput({requestId:pending?.kind==='create'?pending.request.requestId:newId(),expectedVersion:0,fields})}) as Promise<GroupSnapshot>},
  change(groupId:string,expectedVersion:number,fields:GroupChangeFields):Promise<GroupSnapshot>{return queued({kind:'change',request:groupChangeInput({requestId:pending?.kind==='change'?pending.request.requestId:newId(),groupId,expectedVersion,fields})}) as Promise<GroupSnapshot>},
  /** `relation` 是引用回复与结构化全员意图；只描述回应对象，不授予权限。省略时请求与旧客户端逐字一致。 */
  send(groupId:string,expectedVersion:number,text:string,rootId?:string,references?:MessageReference[],mentions?:GroupMention[],relation:{replyToMessageId?:string|undefined;mentionAll?:boolean|undefined}={}):Promise<GroupMessage>{return queued({kind:'send',request:groupSendInput({requestId:pending?.kind==='send'?pending.request.requestId:newId(),groupId,expectedVersion,text,...(rootId===undefined?{}:{rootId}),...(references===undefined?{}:{references}),...(mentions===undefined?{}:{mentions}),...(relation.replyToMessageId===undefined?{}:{replyToMessageId:relation.replyToMessageId}),...(relation.mentionAll?{mentionAll:true}:{})})}) as Promise<GroupMessage>},
  saveResource(groupId:string,resourceId:string,expectedVersion:number,title:string,markdown:string):Promise<GroupResource>{return queued({kind:'save-resource',request:groupResourceSaveInput({requestId:pending?.kind==='save-resource'?pending.request.requestId:newId(),groupId,resourceId,expectedVersion,title,markdown})}) as Promise<GroupResource>},
  withdrawResource(groupId:string,resourceId:string,expectedVersion:number):Promise<GroupResource>{return queued({kind:'withdraw-resource',request:groupResourceWithdrawInput({requestId:pending?.kind==='withdraw-resource'?pending.request.requestId:newId(),groupId,resourceId,expectedVersion})}) as Promise<GroupResource>},
  changeAgentGrant(groupId:string,roleId:string,expectedGroupVersion:number,expectedRoleVersion:number,action:'save'|'revoke',resources:MessageReference[],canPost:boolean,canAutoRun:boolean,expectedGrantVersion?:number):Promise<GroupAgentGrant>{return queued({kind:'agent-grant',request:groupAgentGrantChangeInput({requestId:pending?.kind==='agent-grant'?pending.request.requestId:newId(),groupId,roleId,expectedGroupVersion,expectedRoleVersion,action,resources,canPost,canAutoRun,...(expectedGrantVersion===undefined?{}:{expectedGrantVersion})})}) as Promise<GroupAgentGrant>},
  createTask(groupId:string,messageId:string,expectedGroupVersion:number,goal:string,assignee?:{roleId:string;expectedVersion:number},trigger?:'manual'|'mention',businessTarget?:GroupTaskBusinessTarget):Promise<GroupTaskRecord>{return queued({kind:'task',request:groupTaskCreateInput({requestId:pending?.kind==='task'?pending.request.requestId:newId(),groupId,messageId,expectedGroupVersion,goal,...(assignee?{assignee}:{}),...(trigger===undefined?{}:{trigger}),...(businessTarget?{businessTarget}:{})})}) as Promise<GroupTaskRecord>},
 }
}
