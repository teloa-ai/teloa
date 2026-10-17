import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type ToolExecution,type ParameterSchemaSpec} from '@deepseek-ai/dsh-tools'
import {WorkError,projectDefinition,projectInput,projectUuid,projectLinkKinds,projectStates,projectOverviewInput,readProject,readProjectDetail,readProjectItem,readProjectOverviewPage,type WorkProject,type ProjectDetail,type ProjectDefinition} from '@teloa/contract'
import {authorizeOrdinaryConversationMutation} from './conversation-mutation.ts'
import {readConversationInstructionIdentity,type ConversationInstructionIdentity} from './conversation-instruction-identity.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'

export const projectToolNames=['teloa_projects_list','teloa_projects_get','teloa_projects_candidates','teloa_projects_create','teloa_projects_change'] as const
type ProjectToolName=typeof projectToolNames[number]
export type ProjectToolsPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>
 readTaskPolicy:TaskToolPolicyReader
 isTaskConversation?:(sessionId:string)=>Promise<boolean>
 isBuilder?:(sessionId:string)=>Promise<boolean>
 isPendingDaily?:(sessionId:string)=>Promise<boolean>
 scopes:()=>Promise<readonly string[]>
 admitText:(text:string)=>void
 /** 使用固定宿主本人身份的 createProjectHandler，保留持久版本及关系校验。 */
 route:(endpoint:string,args:unknown,signal?:AbortSignal,revalidate?:()=>Promise<void>)=>Promise<unknown>
}
export type ProjectToolResult={schema:'teloa.project-result/v1';sessionId:string;operation:ProjectToolName;project:WorkProject;projectId:string;projectVersion:number;projectTitle:string;scope:string;requestId?:string;detail?:ProjectDetail}
type Authorization={ownerId:string;sessionId:string;instruction?:ConversationInstructionIdentity}
const names=new Set<string>(projectToolNames),mutations=new Set<string>(['teloa_projects_create','teloa_projects_change'])
const projectIdParameter={projectId:{type:'string',required:true,description:'从真实项目目录取得的内部身份；不要求本人手填。'}} as const
const relation={type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:projectLinkKinds,required:true},id:{type:'string',required:true}}} as const
const fieldsParameter={type:'object',required:true,additionalProperties:false,properties:{scope:{type:'string',required:true},title:{type:'string',required:true},goal:{type:'string',required:true},dueDate:{oneOf:[{type:'string'},{type:'null'}],required:true},state:{type:'string',enum:projectStates,required:true},links:{type:'array',required:true,items:relation},references:{type:'array',required:true,items:{...relation,properties:{...relation.properties,scope:{type:'string',required:true}}}}}} as const
const definitions=[
 {name:projectToolNames[0],description:'读取本人真实项目总览、业务范围与分页；默认当前非归档项目。state=null 包含历史归档，按 nextCursor 续读完整目录。用标题和业务确认目标，内部身份与版本由工具取得，不要求本人手填。',parameters:{scope:{type:'string'},state:{oneOf:[{type:'string',enum:['current',...projectStates]},{type:'null'}]},cursor:{type:'string'},limit:{type:'integer'}}},
 {name:projectToolNames[1],description:'读取本人原项目完整定义、真实版本、关联、跨业务只读引用与任务进度。修改或归档前先读；保留没有要求变更的字段。来源 sessionId 只证明本次原会话，不建立新项目聊天。',parameters:projectIdParameter},
 {name:projectToolNames[2],description:'按本人已登记业务和类型查真实可关联条目，以标题匹配任务、群、员工、自动化、资料或成果。只读目录；不能授权、执行或迁移对象。跨业务条目仅能放入 references，不能计入本业务进度或 AI 执行上下文。',parameters:{scope:{type:'string',required:true},kind:{type:'string',enum:projectLinkKinds,required:true},query:{type:'string',required:true}}},
 {name:projectToolNames[3],description:'依据当前真实本人指令创建持久项目，提交完整 fields；初始 state 必须 planning，未指定期限为 null，未关联项为 []。业务从本人目录选择，关联身份从 candidates 获取。宿主固定本人、原会话和幂等请求。保存不启动任务、自动化、模型或授权。成功后通过项目回执返回原页面。未知结果先查原项目，不换调用重复创建。',parameters:{fields:fieldsParameter}},
 {name:projectToolNames[4],description:'依据当前真实本人指令修改同一项目，先 get 读取 projectId、expectedVersion 与完整 fields，保留未变字段和真实关联。state=archived 归档，恢复时仅改变 state；归档保留项目历史、任务和成果。所属业务不能改变，版本冲突重新读取并核对本人意图，不猜版本自动覆盖。不启动或停止关联运行、不授权、不另建项目会话；回复只用标题和业务，不显示技术身份。',parameters:{...projectIdParameter,expectedVersion:{type:'integer',required:true,description:'从 get 读取的真实版本，不要求本人手填。'},fields:fieldsParameter}},
] as const
const invalidHost=()=>new WorkError('teloa/invalid-host-response','项目服务回执与本人、原项目或本次请求不一致，请核对原项目。')
function savedProject(value:unknown,owner:string,id?:string):WorkProject{
 try{const project=readProject(value);if(project.ownerId!==owner||id!==undefined&&project.id!==id)throw invalidHost();return project}catch{throw invalidHost()}
}
function definitionOf({scope,title,goal,dueDate,state,links,references}:ProjectDefinition):ProjectDefinition{return projectDefinition({scope,title,goal,dueDate,state,links,references})}
function detail(value:unknown,owner:string,id:string):ProjectDetail{
 try{const result=readProjectDetail(value);savedProject(result.project,owner,id);return result}catch{throw invalidHost()}
}
async function authorize(ports:ProjectToolsPorts,exec:ToolExecution):Promise<Authorization>{
 // 在异步归属核对前固定本人指令，不能将原参数重新绑定到新一轮请求。
 const instruction=mutations.has(exec.name)&&exec.agent?readConversationInstructionIdentity(exec.agent):undefined
 const auth=await authorizeOrdinaryConversationMutation({...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal},'项目管理')
 if(await ports.isTaskConversation?.(auth.sessionId)||await ports.isBuilder?.(auth.sessionId))throw new WorkError('teloa/forbidden','项目配置需要本人原工作会话，不能从受管任务或业务搭建会话改写。')
 if(await ports.isPendingDaily?.(auth.sessionId))throw new WorkError('teloa/binding-pending','当前会话尚未完成归属，请先恢复原会话。')
 if(instruction&&JSON.stringify(instruction)!==JSON.stringify(readConversationInstructionIdentity(exec.agent!)))throw new WorkError('teloa/version-conflict','项目核对期间本人指令已变化。')
 exec.signal.throwIfAborted();return {...auth,...(instruction?{instruction}:{})}
}
function requestId(auth:Authorization,exec:ToolExecution):string{
 if(!auth.instruction)throw new WorkError('teloa/forbidden','项目保存需要当前真实本人指令。')
 if(typeof exec.callId!=='string'||!exec.callId.trim()||exec.callId.length>512)throw new WorkError('teloa/invalid-input','项目保存缺少真实稳定的工具调用身份。')
 const source=auth.instruction,hash=createHash('sha256').update(['teloa-project-tool/v1',auth.ownerId,source.sessionId,source.messageId,String(source.seq),exec.name,exec.callId].join('\0')).digest('hex')
 return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`
}
function completeFields(value:unknown):ProjectDefinition{
 const keys=['scope','title','goal','dueDate','state','links','references'],row=projectInput(value,keys)
 if(keys.some(key=>row[key]===undefined))throw new WorkError('teloa/invalid-input','项目保存需要完整定义，未变更的内容与关联请从原项目保留。')
 return projectDefinition(row)
}
function identity(value:unknown):string{
 if(!projectUuid(value))throw new WorkError('teloa/invalid-input','请选择目录中的真实项目。')
 return value.toLowerCase()
}
function argumentsOf(name:ProjectToolName,args:unknown,auth:Authorization,exec:ToolExecution){
 if(name==='teloa_projects_list'){
  const row=projectInput(args,['scope','state','cursor','limit'])
  return {endpoint:'projects/overview',request:projectOverviewInput({scope:row.scope??null,state:row.state===undefined?'current':row.state,cursor:row.cursor??null,limit:row.limit??50})}
 }
 if(name==='teloa_projects_get'){const row=projectInput(args,['projectId']);return {endpoint:'projects/get',request:{projectId:identity(row.projectId)}}}
 if(name==='teloa_projects_candidates'){
  const row=projectInput(args,['scope','kind','query'])
  if(typeof row.scope!=='string'||!/^[a-zA-Z0-9_-]{1,64}$/.test(row.scope)||!projectLinkKinds.includes(row.kind as typeof projectLinkKinds[number])||typeof row.query!=='string'||row.query.length>120)throw new WorkError('teloa/invalid-input','请按真实业务、条目类型和关键词查询。')
  return {endpoint:'projects/candidates',request:{scope:row.scope,kind:row.kind as typeof projectLinkKinds[number],query:row.query.trim()}}
 }
 if(name==='teloa_projects_create'){
  const row=projectInput(args,['fields']),fields=completeFields(row.fields)
  if(fields.state!=='planning')throw new WorkError('teloa/invalid-input','新项目先保存为规划状态；创建不会启动工作。')
  return {endpoint:'projects/create',request:{requestId:requestId(auth,exec),fields}}
 }
 const row=projectInput(args,['projectId','expectedVersion','fields'])
 if(!Number.isSafeInteger(row.expectedVersion)||Number(row.expectedVersion)<1)throw new WorkError('teloa/invalid-input','请读取原项目的真实版本后修改。')
 return {endpoint:'projects/edit',request:{projectId:identity(row.projectId),expectedVersion:Number(row.expectedVersion),fields:completeFields(row.fields)}}
}
async function prepare(ports:ProjectToolsPorts,exec:ToolExecution){
 const auth=await authorize(ports,exec),input=argumentsOf(exec.name as ProjectToolName,exec.arguments,auth,exec)
 let current:WorkProject|undefined
 if('fields' in input.request){
  const fields=input.request.fields;ports.admitText(fields.title);ports.admitText(fields.goal)
  const scopes=await ports.scopes()
  if(input.endpoint==='projects/create'&&!scopes.includes(fields.scope))throw new WorkError('teloa/forbidden','项目所属业务不在本人可用范围内，请选择已有业务。')
  if('projectId' in input.request){
   current=detail(await ports.route('projects/get',{projectId:input.request.projectId}),ports.owner,input.request.projectId).project
   if(current.scope!==fields.scope)throw new WorkError('teloa/invalid-input','原项目所属业务不能通过修改变更。')
  }
  const previousRefs=new Set(current?.references.map(ref=>ref.scope+':'+ref.kind+':'+ref.id))
  if(fields.references.some(ref=>!previousRefs.has(ref.scope+':'+ref.kind+':'+ref.id)&&!scopes.includes(ref.scope)))throw new WorkError('teloa/forbidden','新增引用不属于本人可用业务；不会扩大资料授权。')
 }
 // 异步服务读取结束后再次检查原指令和取消；关系、归档与幂等由原持久服务裁决。
 const latest=await authorize(ports,exec)
 if(JSON.stringify(auth)!==JSON.stringify(latest))throw new WorkError('teloa/version-conflict','项目核对期间本人指令已变化。')
 return {auth,input,fingerprint:JSON.stringify({auth,input,current})}
}
function receipt(auth:Authorization,name:ProjectToolName,project:WorkProject,extra:{requestId?:string;detail?:ProjectDetail}={}):ProjectToolResult{
 return {schema:'teloa.project-result/v1',sessionId:auth.sessionId,operation:name,project,projectId:project.id,projectVersion:project.version,projectTitle:project.title,scope:project.scope,...extra}
}

/** 原生风险审核及审批不被工具改写；前置预检和实际写入使用同一原指令与项目快照。 */
export function registerProjectTools(ctx:Context,ports:ProjectToolsPorts){
 const prepared=new WeakMap<ToolExecution,Awaited<ReturnType<typeof prepare>>>()
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,parameters:definition.parameters as ParameterSchemaSpec,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  try{
   const auth=await authorize(ports,exec),input=argumentsOf(definition.name,args,auth,exec)
   let result:unknown
   if(mutations.has(definition.name)){
    const fixed=prepared.get(exec),latest=await prepare(ports,exec)
    if(!fixed||fixed.fingerprint!==latest.fingerprint)throw new WorkError('teloa/version-conflict','审核期间本人指令或项目已变化，请重新核对原项目。')
    const request=latest.input.request
    if(!('fields' in request))throw new WorkError('teloa/invalid-input','缺少项目完整定义。')
    const revalidate=async()=>{
     const current=await authorize(ports,exec)
     if(JSON.stringify(latest.auth)!==JSON.stringify(current))throw new WorkError('teloa/version-conflict','项目保存等待期间本人指令已变化。')
     exec.signal.throwIfAborted()
    }
    const saved=await ports.route(latest.input.endpoint,request,exec.signal,revalidate)
    await revalidate()
    const project=savedProject(saved,ports.owner,'projectId' in request?request.projectId:undefined)
    if(project.version!==('expectedVersion' in request?request.expectedVersion+1:1)||JSON.stringify(definitionOf(project))!==JSON.stringify(request.fields))throw invalidHost()
    result=receipt(latest.auth,definition.name,project,'requestId' in request?{requestId:request.requestId}:{})
   }else if(definition.name==='teloa_projects_list'){
    const page=readProjectOverviewPage(await ports.route(input.endpoint,input.request));page.rows.forEach(project=>savedProject(project,ports.owner))
    result={schema:'teloa.project-directory/v1',sessionId:auth.sessionId,...page,scopes:await ports.scopes()}
   }else if(definition.name==='teloa_projects_get'){
    if(!('projectId' in input.request))throw invalidHost()
    const value=detail(await ports.route(input.endpoint,input.request),ports.owner,input.request.projectId)
    result=receipt(auth,definition.name,value.project,{detail:value})
   }else{
    if(!('scope' in input.request)||!('kind' in input.request))throw invalidHost()
    const {scope,kind}=input.request
    if(!(await ports.scopes()).includes(scope))throw new WorkError('teloa/forbidden','只能查询本人已有业务的关联条目。')
    const raw=await ports.route(input.endpoint,input.request)
    if(!Array.isArray(raw))throw invalidHost()
    const items=raw.map(readProjectItem)
    if(items.some(item=>item.kind!==kind||!item.available||item.origin!=='direct')||new Set(items.map(item=>item.id)).size!==items.length)throw invalidHost()
    result={schema:'teloa.project-candidates/v1',sessionId:auth.sessionId,scope,kind,items}
   }
   exec.signal.throwIfAborted();return JSON.stringify(result)
  }catch(error){if(error instanceof WorkError||exec.signal.aborted)throw error;throw new WorkError('teloa/host-unavailable','项目服务暂不可用，请先核对原项目和原请求，避免重复创建。')}
 }}))
 return ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!names.has(exec.name))return next()
  try{if(mutations.has(exec.name))prepared.set(exec,await prepare(ports,exec));else argumentsOf(exec.name as ProjectToolName,exec.arguments,await authorize(ports,exec),exec)}
  catch(error){return {kind:'deny' as const,reason:error instanceof WorkError?error.message:'暂时无法核对本人项目配置。'}}
  return next()
 },{prepend:true})
}
