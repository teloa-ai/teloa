import type {Context} from '@deepseek-ai/cordis'
import {createHash} from 'node:crypto'
import {defineTool,type ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,taskInput,groupCreateInput,groupChangeInput,groupListInput,groupResourceListInput,groupResourceSaveInput,groupResourceWithdrawInput,isGroup,isGroupMember,isGroupResource,type Group,type GroupMember,type GroupChangeFields,type GroupDefinition,type DigitalRole} from '@teloa/contract'
import {authorizeOrdinaryConversationMutation} from './conversation-mutation.ts'
import {readConversationInstructionIdentity,type ConversationInstructionIdentity} from './conversation-instruction-identity.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'

export const groupToolNames=['teloa_groups_list','teloa_groups_get','teloa_groups_create','teloa_groups_change','teloa_group_resources_list','teloa_group_resources_save','teloa_group_resources_withdraw'] as const
type GroupToolName=typeof groupToolNames[number]
type GroupAuthorization={ownerId:string;sessionId:string;instruction?:ConversationInstructionIdentity}
export type GroupToolsPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>
 readTaskPolicy:TaskToolPolicyReader
 isRoleConversation?:(sessionId:string)=>Promise<boolean>
 isTaskConversation?:(sessionId:string)=>Promise<boolean>
 isBuilder?:(sessionId:string)=>Promise<boolean>
 isPendingDaily?:(sessionId:string)=>Promise<boolean>
 scopes:()=>Promise<readonly string[]>
 roles:()=>Promise<DigitalRole[]>
 /** 与群消息共用宿主密钥闸；命中或凭据读取失败时只拒不改。 */
 admitText:(text:string)=>void
 /** 复用 createGroupHandler，同一个宿主固定本人、群能力与真实持久服务。 */
 route:(endpoint:string,args:unknown)=>Promise<unknown>
}
const names=new Set<string>(groupToolNames)
const mutationNames=new Set<string>(['teloa_groups_create','teloa_groups_change','teloa_group_resources_save','teloa_group_resources_withdraw'])
const groupIdParameter={groupId:{type:'string',required:true}} as const
const versionParameter={expectedVersion:{type:'integer',required:true}} as const
const rulesParameter={type:'object',required:true,additionalProperties:false,properties:{historyVisibleToNewMembers:{type:'boolean',required:true},draftsVisibleInGroup:{type:'boolean',required:true},mentionAllAllowed:{type:'boolean',required:true}}} as const
const memberIdsParameter={type:'array',required:true,items:{type:'string'}} as const
const membersParameter={type:'array',required:true,items:{type:'object',additionalProperties:false,properties:{roleId:{type:'string',required:true},expectedVersion:{type:'integer',required:true}}}} as const
const commonFields={name:{type:'string',required:true},purpose:{type:'string',description:'群协作目的，可选，最多240字；清空时传空字符串。'},announcement:{type:'string',required:true},rules:rulesParameter,memberRoleIds:memberIdsParameter} as const
const definitions=[
 {name:groupToolNames[0],description:'读取本人真实持久群、可用群范围（general 是合法通用工作范围，无需新建业务）和员工目录（id、version、状态与已有范围）。建群或改成员前先核对；业务只是群入口上下文，不能另建独立 SOC 会话。成员可跨业务；成员关系不修改岗位范围。',parameters:{}},
 {name:groupToolNames[1],description:'读取本人群的 canonical id、版本、规则与完整成员。归档群仍可读，改群前先读真实版本。',parameters:groupIdParameter},
 {name:groupToolNames[2],description:'按本人当前明确指令创建真实持久群。fields 必须是完整 name/scope/announcement/rules/memberRoleIds；scope=general 表示通用工作，直接合法，无需登记同名业务，其他范围从目录scopes选择；members 为每位员工的真实 id 与 expectedVersion，须与 memberRoleIds 一一对应。本人由宿主自动加入，不传本人或请求身份。复用现有群服务：符合群范围的新员工默认可回应并自动运行，资料授权为空；不改变员工范围、不自动发送本人消息。业务上下文不是新会话。',parameters:{fields:{type:'object',required:true,additionalProperties:false,properties:{...commonFields,scope:{type:'string',required:true}}},members:membersParameter}},
 {name:groupToolNames[3],description:'按本人当前指令更新同一个持久群，提交读取到的 expectedVersion 和完整 name/announcement/rules/memberRoleIds/pinned/archived。members 固定每位员工版本。archived=true 归档、false 恢复；不删除群、历史或成果，不另建会话。复用成员默认回应/运行及既有授权续签规则，不能借此扩大岗位或资料授权。版本冲突先重新读取，不猜新版本重试。',parameters:{...groupIdParameter,...versionParameter,fields:{type:'object',required:true,additionalProperties:false,properties:{...commonFields,pinned:{type:'boolean',required:true},archived:{type:'boolean',required:true}}},members:membersParameter}},
 {name:groupToolNames[4],description:'读取本人群资料的真实 id、版本和撤回状态，包含撤回的历史元数据；不读取员工私有资料、不扩大资源授权。',parameters:groupIdParameter},
 {name:groupToolNames[5],description:'按本人明确指令保存群资料。新资料 expectedVersion=0，省略 resourceId 由宿主固定身份；修订须传真实 resourceId 与版本。只保存 title/markdown，不授权员工读取资料。归档群不能写，撤回资料不能修订，未知结果先读目录核对原资料。',parameters:{...groupIdParameter,...versionParameter,resourceId:{type:'string'},title:{type:'string',required:true},markdown:{type:'string',required:true}}},
 {name:groupToolNames[6],description:'按本人明确指令撤回指定群资料，必须传真实 resourceId 与 expectedVersion。保留原件历史版本，不能删除群、历史或成果；撤回不是扩展员工授权。',parameters:{...groupIdParameter,...versionParameter,resourceId:{type:'string',required:true}}},
] as const
const invalidResponse=()=>new WorkError('teloa/invalid-host-response','群服务回执与本人、群或本次请求不一致，请先核对原群。')
function readGroup(value:unknown,owner:string,groupId?:string):Group{
 if(!isGroup(value)||value.ownerId!==owner||groupId!==undefined&&value.id!==groupId)throw invalidResponse()
 return value
}
function readSnapshot(value:unknown,owner:string,groupId:string):{group:Group;members:GroupMember[]}{
 try{
  const row=taskInput(value,['group','members']),group=readGroup(row.group,owner,groupId)
  if(!Array.isArray(row.members)||row.members.length<1||row.members.length>31||!row.members.every(isGroupMember)||row.members.some(member=>member.groupId!==group.id)||row.members.filter(member=>member.roleId===null).length!==1||new Set(row.members.map(member=>member.roleId)).size!==row.members.length||(group.memberCount!==undefined&&group.memberCount!==row.members.length))throw invalidResponse()
  return {group,members:row.members}
 }catch{throw invalidResponse()}
}
function readResources(value:unknown,owner:string,groupId:string){
 if(!Array.isArray(value)||!value.every(isGroupResource)||value.some(resource=>resource.ownerId!==owner||resource.groupId!==groupId)||new Set(value.map(resource=>resource.id)).size!==value.length)throw invalidResponse()
 return value
}
function roleDirectory(roles:DigitalRole[],owner:string){
 if(!Array.isArray(roles)||roles.some(role=>role.ownerId!==owner||!Number.isSafeInteger(role.version)||role.version<1)||new Set(roles.map(role=>role.id)).size!==roles.length)throw invalidResponse()
 return roles.map(({id,version,name,kind,state,scopes})=>({id,version,name,kind,state,scopes}))
}
function requiredMembers(value:unknown){
 if(value===undefined)throw new WorkError('teloa/invalid-input','群工具必须提供完整成员名单的真实版本。')
 return value
}
function requireCompleteFields(value:unknown,change=false){
 const row=taskInput(value,change?['name','purpose','announcement','rules','memberRoleIds','pinned','archived']:['name','purpose','scope','announcement','rules','memberRoleIds'])
 if(row.rules===undefined)throw new WorkError('teloa/invalid-input','需要完整群规则，不能由模型省略后隐式开启。')
 return row
}
function requestId(auth:GroupAuthorization,exec:ToolExecution,suffix=''){
 if(typeof exec.callId!=='string'||!exec.callId.trim()||exec.callId.length>512)throw new WorkError('teloa/invalid-input','需要真实稳定的工具调用身份。')
 if(!auth.instruction)throw new WorkError('teloa/forbidden','群写入需要当前真实本人指令。')
 const instruction=auth.instruction,hash=createHash('sha256').update(['teloa-group-tool/v1',auth.ownerId,instruction.sessionId,instruction.messageId,String(instruction.seq),exec.name,exec.callId,suffix].join('\0')).digest('hex')
 return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`
}
function argumentsOf(name:GroupToolName,args:unknown,auth:GroupAuthorization,exec:ToolExecution){
 if(name==='teloa_groups_list')return {endpoint:'groups/list',request:groupListInput(args)}
 if(name==='teloa_groups_get'||name==='teloa_group_resources_list')return {endpoint:name==='teloa_groups_get'?'groups/get':'groups/resources/list',request:groupResourceListInput(args)}
 const fixedRequestId=requestId(auth,exec)
 if(name==='teloa_groups_create'){
  const row=taskInput(args,['fields','members']),request=groupCreateInput({requestId:fixedRequestId,expectedVersion:0,fields:requireCompleteFields(row.fields),expectedMembers:requiredMembers(row.members)})
  return {endpoint:'groups/create',request,members:request.expectedMembers!}
 }
 if(name==='teloa_groups_change'){
  const row=taskInput(args,['groupId','expectedVersion','fields','members']),request=groupChangeInput({requestId:fixedRequestId,groupId:row.groupId,expectedVersion:row.expectedVersion,fields:requireCompleteFields(row.fields,true),expectedMembers:requiredMembers(row.members)})
  return {endpoint:'groups/change',request,members:request.expectedMembers!}
 }
 if(name==='teloa_group_resources_save'){
  const row=taskInput(args,['groupId','resourceId','expectedVersion','title','markdown'])
  if(row.expectedVersion===0&&row.resourceId!==undefined||row.expectedVersion!==0&&row.resourceId===undefined)throw new WorkError('teloa/invalid-input','新资料身份由宿主生成；修订必须指定真实原资料。')
  return {endpoint:'groups/resources/save',request:groupResourceSaveInput({...row,requestId:fixedRequestId,resourceId:row.resourceId??requestId(auth,exec,'new-resource')})}
 }
 const row=taskInput(args,['groupId','resourceId','expectedVersion'])
 return {endpoint:'groups/resources/withdraw',request:groupResourceWithdrawInput({...row,requestId:fixedRequestId})}
}
async function authorize(ports:GroupToolsPorts,exec:ToolExecution):Promise<GroupAuthorization>{
 // 在任何异步授权读或自动审查前固定原指令身份；附件只是内容，不从附件读取或推导授权。
 const instruction=mutationNames.has(exec.name)&&exec.agent?readConversationInstructionIdentity(exec.agent):undefined
 const auth=await authorizeOrdinaryConversationMutation({...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal},'群管理')
 if(await ports.isTaskConversation?.(auth.sessionId)||await ports.isBuilder?.(auth.sessionId))throw new WorkError('teloa/forbidden','群配置不能从受管任务或业务搭建会话改写；可以在本人工作会话或员工原单聊管理。')
 if(await ports.isPendingDaily?.(auth.sessionId))throw new WorkError('teloa/binding-pending','当前工作会话尚未完成归属，请先恢复原预约。')
 if(instruction&&JSON.stringify(instruction)!==JSON.stringify(readConversationInstructionIdentity(exec.agent!)))throw new WorkError('teloa/version-conflict','群管理核对期间本人指令已变化。')
 return {...auth,...(instruction?{instruction}:{})}
}
const sameRules=(a:Group['rules'],b:Group['rules'])=>a.historyVisibleToNewMembers===b.historyVisibleToNewMembers&&a.draftsVisibleInGroup===b.draftsVisibleInGroup&&a.mentionAllAllowed===b.mentionAllAllowed
function sameFields(group:Group,fields:GroupDefinition|GroupChangeFields){
 return group.name===fields.name&&(fields.purpose===undefined||(group.purpose??'')===fields.purpose)&&group.announcement===fields.announcement&&sameRules(group.rules,fields.rules)&&('scope' in fields?group.scope===fields.scope&&!group.pinned&&!group.archived:group.pinned===fields.pinned&&group.archived===fields.archived)
}
function sameMembers(members:readonly GroupMember[],ids:readonly string[]){
 const actual=members.filter(member=>member.roleId!==null).map(member=>member.roleId)
 return actual.length===ids.length&&ids.every(id=>actual.includes(id))
}
async function prepare(ports:GroupToolsPorts,exec:ToolExecution){
 const auth=await authorize(ports,exec),input=argumentsOf(exec.name as GroupToolName,exec.arguments,auth,exec)
 if('fields' in input.request){ports.admitText(input.request.fields.name);ports.admitText(input.request.fields.announcement);if(input.request.fields.purpose!==undefined)ports.admitText(input.request.fields.purpose)}
 if(input.endpoint==='groups/resources/save'){const save=input.request as ReturnType<typeof groupResourceSaveInput>;ports.admitText(save.title);ports.admitText(save.markdown)}
 let snapshot:ReturnType<typeof readSnapshot>|undefined,selectedRoles:ReturnType<typeof roleDirectory>=[]
 if('groupId' in input.request)snapshot=readSnapshot(await ports.route('groups/get',{groupId:input.request.groupId}),ports.owner,input.request.groupId)
 if('fields' in input.request){
  const [scopes,roles]=await Promise.all([ports.scopes(),ports.roles()]),directory=roleDirectory(roles,ports.owner),scope='scope' in input.request.fields?input.request.fields.scope:snapshot!.group.scope
  if(!scopes.includes(scope))throw new WorkError('teloa/forbidden','群所属业务不在本人可用范围内；不会扩大员工岗位范围。')
  selectedRoles=(input.members??[]).map(member=>{
   const role=directory.find(role=>role.id===member.roleId)
   if(!role||role.state!=='active'||role.version!==member.expectedVersion)throw new WorkError('teloa/version-conflict','群成员的归属、状态或岗位版本已变化，请先重新读取目录。')
   return role
  })
  if('groupId' in input.request&&snapshot!.group.version!==input.request.expectedVersion){
   // 只放行可能的原请求重放；真正幂等与请求正文一致性仍由持久服务事务判断。
   if(snapshot!.group.version!==input.request.expectedVersion+1||!sameFields(snapshot!.group,input.request.fields)||!sameMembers(snapshot!.members,input.request.fields.memberRoleIds))throw new WorkError('teloa/version-conflict','群版本已变化，请先核对原群。')
  }
 }
 if(input.endpoint==='groups/resources/save'||input.endpoint==='groups/resources/withdraw'){
  if(snapshot!.group.archived)throw new WorkError('teloa/conflict','已归档群只能读取，请先明确恢复原群。')
  const resources=readResources(await ports.route('groups/resources/list',{groupId:snapshot!.group.id}),ports.owner,snapshot!.group.id)
  const request=input.request as ReturnType<typeof groupResourceSaveInput>|ReturnType<typeof groupResourceWithdrawInput>,resource=resources.find(resource=>resource.id===request.resourceId)
  if(input.endpoint==='groups/resources/save'){
   const save=request as ReturnType<typeof groupResourceSaveInput>
   if(resource&&(resource.withdrawnAt!==null||resource.version!==save.expectedVersion&&!(resource.version===save.expectedVersion+1&&resource.title===save.title))||!resource&&save.expectedVersion!==0)throw new WorkError('teloa/version-conflict','群资料已变化或撤回，请核对原资料。')
  }else if(!resource||resource.version!==request.expectedVersion)throw new WorkError('teloa/version-conflict','群资料版本已变化，请核对原资料。')
 }
 exec.signal.throwIfAborted()
 return {auth,input,snapshot,fingerprint:JSON.stringify({request:input.request,members:input.members,selectedRoles,group:snapshot,source:auth.instruction})}
}
function receipt(auth:GroupAuthorization,name:string,group:Group,extra:Record<string,unknown>={}){
 // sessionId 是可信来源回执；现有群表没有会话绑定字段，不能将它冒充持久绑定。
 return {schema:'teloa.group-result/v1',group,sessionId:auth.sessionId,operation:name,groupId:group.id,groupVersion:group.version,groupName:group.name,...extra}
}

/** 校验在自动审查前与实际执行前各做一次；原生 allow/ask/deny/cancel 原样保留。 */
export function registerGroupTools(ctx:Context,ports:GroupToolsPorts){
 const prepared=new WeakMap<ToolExecution,Awaited<ReturnType<typeof prepare>>>()
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  try{
   const auth=await authorize(ports,exec),input=argumentsOf(definition.name,args,auth,exec)
   let value:unknown
   if(mutationNames.has(definition.name)){
    const fixed=prepared.get(exec),current=await prepare(ports,exec)
    if(!fixed||fixed.fingerprint!==current.fingerprint)throw new WorkError('teloa/version-conflict','审查期间指令、群或成员已变化，请核对原请求。')
    const result=await ports.route(input.endpoint,input.request)
    if('fields' in input.request){
     const group=readGroup(result,ports.owner,'groupId' in input.request?input.request.groupId:undefined)
     if(group.version!==input.request.expectedVersion+1||!sameFields(group,input.request.fields))throw invalidResponse()
     value=receipt(auth,definition.name,group,{requestId:input.request.requestId})
    }else{
     const request=input.request as ReturnType<typeof groupResourceSaveInput>|ReturnType<typeof groupResourceWithdrawInput>
     if(!isGroupResource(result)||result.ownerId!==ports.owner||result.groupId!==request.groupId||result.id!==request.resourceId)throw invalidResponse()
     if(input.endpoint==='groups/resources/save'?(result.version!==request.expectedVersion+1||result.withdrawnAt!==null||result.title!==(request as ReturnType<typeof groupResourceSaveInput>).title):(result.version!==request.expectedVersion||result.withdrawnAt===null))throw invalidResponse()
     value=receipt(auth,definition.name,current.snapshot!.group,{requestId:request.requestId,resource:result})
    }
   }else if(definition.name==='teloa_groups_list'){
    const [groups,scopes,roles]=await Promise.all([ports.route(input.endpoint,input.request),ports.scopes(),ports.roles()])
    if(!Array.isArray(groups)||new Set(groups.map(group=>readGroup(group,ports.owner).id)).size!==groups.length)throw invalidResponse()
    value={groups,scopes,roles:roleDirectory(roles,ports.owner)}
   }else{
    const groupId=(input.request as {groupId:string}).groupId,snapshot=readSnapshot(await ports.route('groups/get',{groupId}),ports.owner,groupId)
    value=definition.name==='teloa_groups_get'?receipt(auth,definition.name,snapshot.group,{members:snapshot.members}):receipt(auth,definition.name,snapshot.group,{resources:readResources(await ports.route(input.endpoint,input.request),ports.owner,groupId)})
   }
   exec.signal.throwIfAborted();return JSON.stringify(value)
  }catch(error){if(error instanceof WorkError||exec.signal.aborted)throw error;throw new WorkError('teloa/host-unavailable','群服务暂不可用，请核对原群与原请求，不要重复创建。')}
 }}))
 return ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!names.has(exec.name))return next()
  try{
   if(mutationNames.has(exec.name))prepared.set(exec,await prepare(ports,exec))
   else argumentsOf(exec.name as GroupToolName,exec.arguments,await authorize(ports,exec),exec)
  }catch(error){return {kind:'deny' as const,reason:error instanceof WorkError?error.message:'暂时无法核对群配置身份。'}}
  return next()
 },{prepend:true})
}
