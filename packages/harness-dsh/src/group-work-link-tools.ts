import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type ParameterSchemaSpec,type ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,taskInput,isGroup,groupWorkLinksGetInput,groupWorkLinksChangeInput,groupWorkLinksCandidatesInput,groupWorkLinkKey,readGroupWorkLinkItem,readGroupWorkLinks,type Group,type GroupWorkLinks,type GroupWorkLinkItem,type GroupWorkLinksChangeInput} from '@teloa/contract'
import {authorizeOrdinaryConversationMutation,authorizeConversationInstructionMutation,assertConversationInstructionMutationAuthorization,conversationInstructionMutationRequestId,type ConversationInstructionMutationAuthorization} from './conversation-mutation.ts'
import {readBusinessScopeLabels} from './business-scopes.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'

export const groupWorkLinkToolNames=['teloa_group_work_directory','teloa_group_work_get','teloa_group_work_candidates','teloa_group_work_change'] as const
type Name=typeof groupWorkLinkToolNames[number]
export type GroupWorkLinkToolsPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>
 readTaskPolicy:TaskToolPolicyReader
 isTaskConversation?:(sessionId:string)=>Promise<boolean>
 isBuilder?:(sessionId:string)=>Promise<boolean>
 isPendingDaily?:(sessionId:string)=>Promise<boolean>
 /** 本人原群目录；不能用其他人的群摘要或模型文字代替。 */
 groups:()=>Promise<unknown>
 /** 原业务标签回包，使用 readBusinessScopeLabels 验证真实显示名与范围。 */
 scopes:()=>Promise<unknown>
 admitText:(text:string)=>void
 /** 固定本人身份的 createGroupWorkLinkHandler，完整传递取消与提交前复核。 */
 route:(endpoint:string,args:unknown,signal?:AbortSignal,revalidate?:()=>Promise<void>)=>Promise<unknown>
}
const names=new Set<string>(groupWorkLinkToolNames),change='teloa_group_work_change'
const groupId={groupId:{type:'string',required:true,description:'从本人群目录取得的 canonical 身份，不要求本人手填。'}} as const
const requiredString={type:'string',required:true} as const
const link={oneOf:[{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['task','project'],required:true},scope:requiredString,id:requiredString}},{type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['business'],required:true},scope:requiredString,type:requiredString,id:requiredString}}]} as const
const definitions=[
 {name:groupWorkLinkToolNames[0],description:'读取本人真实群目录与业务显示名。本人只需描述群名、业务名、工作名称或案件编号；模型按真实目录解析内部身份。同名目标先核对区别，不能猜 UUID；不要求本人手填版本、hash 或技术键。',parameters:{}},
 {name:groupWorkLinkToolNames[1],description:'读取同一个原群的工作关联索引、群版本和关联集合版本。关联可包括多个业务的案件、项目和任务；不可用对象保留不泄露标题的占位。只读对象元数据，不读取业务正文、不扩大员工资料授权，不另建群或会话。修改前先读，保存时保留未要求改变的原关联。',parameters:groupId},
 {name:groupWorkLinkToolNames[2],description:'在本人真实业务中按工作名称或案件编号查询可关联原对象。scope 从 directory 的业务显示名映射，kind=business 是案件或其他业务记录，project/task 是原项目或任务。参数及返回的 canonical 标识只供工具内部使用。候选不等于获准读取正文、发群消息或执行工作。',parameters:{...groupId,scope:requiredString,kind:{type:'string',enum:['business','project','task'],required:true},query:requiredString}},
 {name:groupWorkLinkToolNames[3],description:'按当前真实本人指令保存同一群的完整关联集合。模型先 get 读取 expectedGroupVersion 与 expectedVersion，按 candidates 的原对象标识组合完整 links；追加保留原关联，解除只移除本人明确指定项，全部解除用 []。本人描述名称或案件编号即可，不能让本人填写 UUID、版本或 hash。多业务合法，不改群所属业务、不复制对象、不发消息、不启动任务、不授权读取、不造新会话。宿主固定幂等请求；冲突先重新读取核对意图，未知结果核对原群与原请求，不自动换版本覆盖。成功回执回到 canonical 原群卡，最终回复只说群名与工作名称。',parameters:{...groupId,expectedGroupVersion:{type:'integer',required:true,description:'从 get 取得的真实群版本，只供模型内部使用。'},expectedVersion:{type:'integer',required:true,description:'从 get 取得的真实关联集合版本，空集合初始为 0，不要求本人手填。'},links:{type:'array',required:true,items:link}}},
] as const
const invalidHost=()=>new WorkError('teloa/invalid-host-response','群工作关联回执与本人、原群或本次请求不一致，请先核对原群。')
function checkedGroups(value:unknown,owner:string):Group[]{
 if(!Array.isArray(value)||!value.every(isGroup)||value.some(group=>group.ownerId!==owner)||new Set(value.map(group=>group.id)).size!==value.length)throw invalidHost()
 return value
}
async function group(ports:GroupWorkLinkToolsPorts,id:string):Promise<Group>{
 const found=checkedGroups(await ports.groups(),ports.owner).find(row=>row.id===id)
 if(!found)throw new WorkError('teloa/forbidden','群不存在或不属于当前本人，请核对原群目录。')
 return found
}
function checkedLinks(value:unknown,selected:Group):GroupWorkLinks{
 try{const links=readGroupWorkLinks(value);if(links.groupId!==selected.id||links.groupVersion!==selected.version)throw invalidHost();return links}catch{throw invalidHost()}
}
async function authorize(ports:GroupWorkLinkToolsPorts,exec:ToolExecution,write=false){
 const input={...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal}
 const auth=write?await authorizeConversationInstructionMutation(input):await authorizeOrdinaryConversationMutation(input,'群工作关联')
 if(await ports.isTaskConversation?.(auth.sessionId)||await ports.isBuilder?.(auth.sessionId))throw new WorkError('teloa/forbidden','群工作关联只能在本人原工作会话配置，不能从受管任务或业务搭建会话改写。')
 if(await ports.isPendingDaily?.(auth.sessionId))throw new WorkError('teloa/binding-pending','当前会话尚未完成归属，请先恢复原会话。')
 if(write)assertConversationInstructionMutationAuthorization(auth as ConversationInstructionMutationAuthorization,await authorizeConversationInstructionMutation(input))
 exec.signal.throwIfAborted();return auth
}
async function prepare(ports:GroupWorkLinkToolsPorts,args:unknown,exec:ToolExecution){
 const auth=await authorize(ports,exec,true) as ConversationInstructionMutationAuthorization,row=taskInput(args,['groupId','expectedGroupVersion','expectedVersion','links'])
 const request=groupWorkLinksChangeInput({...row,requestId:conversationInstructionMutationRequestId(auth,change,exec.callId)})
 const [selected,scopeValue]=await Promise.all([group(ports,request.groupId),ports.scopes()]),scopes=readBusinessScopeLabels(scopeValue).items
 const current=checkedLinks(await ports.route('groups/work/get',{groupId:selected.id},exec.signal),selected)
 const existing=new Set(current.items.map(groupWorkLinkKey))
 if(request.links.some(link=>!existing.has(groupWorkLinkKey(link))&&!scopes.some(scope=>scope.scope===link.scope)))throw new WorkError('teloa/forbidden','新增关联不属于本人可用业务，不会扩大资料授权。')
 for(const link of request.links)if(link.kind==='business'){ports.admitText(link.type);ports.admitText(link.id)}
 // 原请求重放是否有效由后端持久回执裁决；不将已提交后的真实新版本改写为猜测版本。
 if(selected.archived&&selected.version===request.expectedGroupVersion)throw new WorkError('teloa/conflict','请先恢复原群，再修改工作关联。')
 assertConversationInstructionMutationAuthorization(auth,await authorize(ports,exec,true) as ConversationInstructionMutationAuthorization)
 return {auth,request,selected,current,fingerprint:JSON.stringify({auth,request,selected,current})}
}
function receipt(sessionId:string,operation:Name,selected:Group,extra:Record<string,unknown>={}){
 return {schema:'teloa.group-result/v1',sessionId,operation,group:selected,groupId:selected.id,groupVersion:selected.version,groupName:selected.name,...extra}
}
function checkedChange(value:unknown,request:GroupWorkLinksChangeInput):GroupWorkLinks{
 try{
  const result=readGroupWorkLinks(value),actual=result.items.map(groupWorkLinkKey).sort(),expected=request.links.map(groupWorkLinkKey).sort()
  if(result.groupId!==request.groupId||result.groupVersion!==request.expectedGroupVersion||result.version!==request.expectedVersion+1||JSON.stringify(actual)!==JSON.stringify(expected))throw invalidHost()
  return result
 }catch{throw invalidHost()}
}

export function registerGroupWorkLinkTools(ctx:Context,ports:GroupWorkLinkToolsPorts){
 const prepared=new WeakMap<ToolExecution,Awaited<ReturnType<typeof prepare>>>()
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,parameters:definition.parameters as ParameterSchemaSpec,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  try{
   const auth=await authorize(ports,exec,definition.name===change)
   let result:unknown
   if(definition.name===change){
    const fixed=prepared.get(exec),latest=await prepare(ports,args,exec)
    if(!fixed||fixed.fingerprint!==latest.fingerprint)throw new WorkError('teloa/version-conflict','审核期间本人指令、原群或工作关联已变化，请核对后重新保存。')
    const revalidate=async()=>{assertConversationInstructionMutationAuthorization(latest.auth,await authorize(ports,exec,true) as ConversationInstructionMutationAuthorization);exec.signal.throwIfAborted()}
    const workLinks=checkedChange(await ports.route('groups/work/change',latest.request,exec.signal,revalidate),latest.request)
    await revalidate()
    result=receipt(auth.sessionId,definition.name,latest.selected,{requestId:latest.request.requestId,workLinks})
   }else if(definition.name==='teloa_group_work_directory'){
    taskInput(args,[]);const [groups,scopes]=await Promise.all([ports.groups(),ports.scopes()])
    result={schema:'teloa.group-work-directory/v1',sessionId:auth.sessionId,groups:checkedGroups(groups,ports.owner),scopes:readBusinessScopeLabels(scopes).items}
   }else if(definition.name==='teloa_group_work_get'){
    const request=groupWorkLinksGetInput(args),selected=await group(ports,request.groupId)
    result=receipt(auth.sessionId,definition.name,selected,{workLinks:checkedLinks(await ports.route('groups/work/get',request,exec.signal),selected)})
   }else{
    const request=groupWorkLinksCandidatesInput(args),selected=await group(ports,request.groupId),scopes=readBusinessScopeLabels(await ports.scopes()).items
    if(!scopes.some(scope=>scope.scope===request.scope))throw new WorkError('teloa/forbidden','只能查询本人可用业务的原工作对象。')
    ports.admitText(request.query)
    const raw=await ports.route('groups/work/candidates',request,exec.signal)
    if(!Array.isArray(raw)||raw.length>100)throw invalidHost()
    let items:GroupWorkLinkItem[]
    try{items=raw.map(readGroupWorkLinkItem)}catch{throw invalidHost()}
    if(items.some(item=>!item.available||item.scope!==request.scope||item.kind!==request.kind)||new Set(items.map(groupWorkLinkKey)).size!==items.length)throw invalidHost()
    result=receipt(auth.sessionId,definition.name,selected,{scope:request.scope,kind:request.kind,items})
   }
   await authorize(ports,exec,definition.name===change);exec.signal.throwIfAborted();return JSON.stringify(result)
  }catch(error){if(error instanceof WorkError||exec.signal.aborted)throw error;throw new WorkError('teloa/host-unavailable','群工作关联服务暂不可用，请核对原群和原请求，避免重复保存。')}
 }}))
 return ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!names.has(exec.name))return next()
  try{
   if(exec.name===change)prepared.set(exec,await prepare(ports,exec.arguments,exec))
   else{await authorize(ports,exec);if(exec.name==='teloa_group_work_directory')taskInput(exec.arguments,[]);else if(exec.name==='teloa_group_work_get')groupWorkLinksGetInput(exec.arguments);else groupWorkLinksCandidatesInput(exec.arguments)}
  }catch(error){return {kind:'deny' as const,reason:error instanceof WorkError?error.message:'暂时无法核对本人群工作关联。'}}
  return next()
 },{prepend:true})
}
