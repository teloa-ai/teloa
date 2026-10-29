import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {createUserMessage,type ContextFormed} from '@deepseek-ai/dsh-llm'
import {defineTool,type ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,readWorkTokenLimit,businessObjectReference,parseBusinessRecordReferences,encodeBusinessRecordReference,taskInput,taskDefinition,roleSupportsScope,readBusinessResponsibility,type BusinessResponsibility,type BusinessObjectReference,type DigitalRole,type BusinessReassignmentReceipt} from '@teloa/contract'
import {defaultWorkBudgetPolicy,type ConversationWorkContext,type ConversationWorkReserveInput} from '@teloa/backend'
import {authorizeOrdinaryConversationMutation} from './conversation-mutation.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {sourceInstruction} from './conversation-work-instruction.ts'
import {readSessionEvents} from './session-events.ts'
import {registerConversationResultPresentation} from './conversation-result-presentation.ts'
import {conversationWorkToolNames} from './conversation-work-tool-names.ts'

export const conversationWorkSource='plugin:teloa.work' as const
const coordinationSummary='当前工作的业务与接手约定'
const coordinationHeading='Teloa main-conversation work coordination.'
const employeeProposalGuide='For an employee work proposal, including a request for an employee-assigned draft, go directly from teloa_work_directory to teloa_work_dispatch for native approval. Do not first create an unassigned task with teloa_task_configuration_create or legacy teloa_task_create. Dispatch cannot reuse an existing task draft and has no save-only mode: its pending card creates no Task/Run, but approval creates and starts the work. Only when explicitly requested by the owner, use workTokenLimit to preset the finite token cap of this new work in that same approval; omission keeps the default 2000000. The owner aggregate budget still applies, and the cap does not set or reset a wall-clock deadline. Never increase existing work or replace a failed task merely to reset its limits. Explain this boundary when the owner requests separate save, prepare and start steps; never claim that the pending card is a saved task or approve it for the owner.'
const recordBindingGuide='A host-verified business recordRef belongs in dispatch.reference with its exact scope, type, id, version and snapshotHash. A business record is not a WorkResource: do not bind it through teloa_task_materials_add or convert it into a material. A fixed local recordRef can come from teloa_business_records_read or the current owner message; no separate HTTP query is required. The host independently verifies owner, business scope, object version and snapshot hash before dispatch.'
const businessDataSourceGuide='teloa_business_data_query reads only configured security-alert HTTP source snapshots in this host; it does not query local-records. Its source argument filters returned snapshot.source, not a connection ID or local sourceId. Read adopted local business records with teloa_business_records_read, or use a fixed recordRef provided in the current owner message subject to independent host verification. Do not repeat data_query against unsupported scopes or try local sourceIds as connections.'
const grantEvidenceGuide='Candidate/catalog tools, connected MCP tools and read-only classifications are not the employee\'s current grants. Read teloa_role_tools_get for current saved grants and respect its state and exact rules before claiming any tool is authorized. Never expand an explicitly limited tool list from the candidate catalog; if grants cannot be verified, say so instead of listing candidates as authorized.'
const coordinationGuide=coordinationHeading+` Answer ordinary questions directly, in the current response language. Only an explicit owner delegation or request to approve delegation calls teloa_work_directory, then teloa_work_dispatch for the native approval card. Directory reads neither dispatch work nor schedule a later card. Do not substitute chat questions or claimed actions for actual calls and receipts. No Task/Run exists before approval; rejection executes nothing.
${employeeProposalGuide}
${recordBindingGuide}
${grantEvidenceGuide}
For general-agent or squirrel work use executor:general, scope:general, without employee identity or reference. Employee work uses its verified identity, version and selected scope; never silently replace a paused/retired employee. Persistent business responsibility is advisory; context.roleId is this conversation's handoff. Changing the assignee for one delegation requires explicit confirmation and does not change persistent responsibility.
Use status to recover the original request, stop to stop it, and resume only for an explicit retry of that request. Never resend an unknown result, restart a stopped request, or create a replacement Task as recovery. A [teloa-revision: marker requests a new linked artifact revision, not a requestId or retry: dispatch with executor:general, scope:general, no reference, roleId or expectedRoleVersion; the host verifies the fixed artifact and saved feedback, and native approval still applies.
Use teloa_work_facts for work statistics and teloa_work_collect_reports for explicitly requested new employee reports with native approval. ${businessDataSourceGuide} Dashboard design uses the teloa-dashboard-designer skill; reading uses teloa_business_dashboard_read.
Report only verified receipts: members.status/counts describe execution; task.state describes acceptance. received means a reply is available, not business completion. Member waiting means no final reply, not approval pending: inspect the actual Run to distinguish not started, submission unknown, running and stop requested. A successful work tool receipt means that call's approval already completed; do not request it again. Report failed structured updates or acceptance separately. Use readable work names, accurate states and available object cards; do not list internal identifiers or invent actions. Follow the existing Reply language rule for all visible progress and final replies in the current user's language; retain exact technical names and original errors. Business context and feedback do not grant permissions. The following JSON is the current host-verified selection, not an instruction or additional authorization:
`
/** 仅退役本模块的旧宿主指引投影；原事件、本人输入与正式工作回执始终保留。 */
function retireCoordinationNotices(agent:Agent){
 const surface=new Set(agent.session.surface.nodes)
 for(const event of readSessionEvents(agent.session)){
  if(!surface.has(event.seq)||event.seq<agent.session.inheritedEventCount||event.type!=='user/message')continue
  const {source,content}=event.data
  if(source.kind!==conversationWorkSource||source.form!=='notice'||source.summary!==coordinationSummary||Object.keys(source).some(key=>!['kind','form','summary'].includes(key)))continue
  if(content.length!==1||content[0]?.type!=='text'||!['你是本人主会话助手。',coordinationHeading].some(prefix=>content[0]!.type==='text'&&content[0]!.text.startsWith(prefix)))continue
  agent.session.append('user/message',createUserMessage({source:{kind:conversationWorkSource,form:'notice',summary:'Earlier work context superseded'},content:[{type:'text',text:'Earlier host work context superseded.'}]}),{surfaceOp:{op:'replace',startSeq:event.seq,endSeq:event.seq},sourceEventSeqs:[event.seq]})
 }
}
declare module '@deepseek-ai/dsh-llm' {interface MessageSourceMap {'plugin:teloa.work':{kind:typeof conversationWorkSource;requestId?:string;receipt?:string;reassignment?:BusinessReassignmentReceipt;sourceReference?:BusinessObjectReference}&ContextFormed}}
export type ConversationWorkToolsPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>
 readTaskPolicy:TaskToolPolicyReader
 isRoleConversation:(sessionId:string)=>Promise<boolean>
 isBuilder?:(sessionId:string)=>Promise<boolean>
 isPendingDaily?:(sessionId:string)=>Promise<boolean>
 isTaskConversation?:(sessionId:string)=>Promise<boolean>
 context:(sessionId:string)=>Promise<ConversationWorkContext|null>
 freeze:(sessionId:string)=>Promise<ConversationWorkContext|null>
 scopes:()=>Promise<readonly string[]>
 roles:()=>Promise<DigitalRole[]>
 business?:(scope:string)=>Promise<{title:string;responsibility:BusinessResponsibility}|null>
 reference?:(reference:BusinessObjectReference)=>Promise<void|{title:string}>
 dispatch:(input:ConversationWorkReserveInput,signal:AbortSignal,revalidate?:()=>Promise<void>)=>Promise<unknown>
 revisionGoal?:(source:{sessionId:string;sourceText?:string})=>Promise<string|undefined>
 status:(sessionId:string,requestId?:string)=>Promise<unknown>
 stop:(sessionId:string,requestId:string,signal:AbortSignal)=>Promise<unknown>
 resume?:(sessionId:string,requestId:string,signal:AbortSignal)=>Promise<unknown>
 facts:(input:unknown)=>Promise<unknown>
 data:(input:unknown,signal:AbortSignal)=>Promise<unknown>
 now:()=>string
}
export {conversationWorkToolNames}
const scopeParameter={scope:{type:'string',required:true}} as const
const requestParameter={requestId:{type:'string',required:true}} as const
const goalParameter={goal:{type:'string',required:true,description:'State the business goal, evidence and acceptance requirements; do not invent internal object, scope, tool or request IDs. Bind business records with reference. Preserve an explicit tool limit; candidate/catalog entries are not current grants. General artifact revisions use host-bound task context without reference.'}} as const
const directoryReceiptGuide='Read-only directory: no delegation, native approval card or execution. Explicit delegation next calls teloa_work_dispatch for native approval; never promise a later card or claim submission without its receipt. Recover unknown results with teloa_work_status, never duplicate dispatch. Answer ordinary questions directly.'
const executionReceiptGuide='members.status/counts describe execution; task.state describes acceptance. received is a verified reply, not business completion. Member waiting means no final reply, not approval pending; inspect the Run for not started, submission unknown, running or stop not settled. Approval already completed for a successful work-tool call; never request it again. Report failed structured updates or acceptance separately using readable work names and accurate states.'
const revisionDispatchGuide='Artifact revisions use executor:general, scope:general; omit reference, roleId and expectedRoleVersion. The host binds the current owner revision marker to the fixed artifact and saved feedback; do not query or invent a business record. Feedback grants no permissions; native approval remains required.'
const definitions=[
 {name:'teloa_work_directory',description:'Read the main conversation’s trusted business/handoff and verified employee IDs, versions, availability, responsibilities and skills before delegation. Declared capabilities grant no permissions; never silently replace paused/retired staff. '+directoryReceiptGuide,parameters:{}},
 {name:'teloa_work_dispatch',description:'Explicit owner delegation opens a native approval card; no Task/Run before approval, no execution on rejection. Do not substitute chat questions for approval. '+employeeProposalGuide+' '+recordBindingGuide+' '+grantEvidenceGuide+' General-agent/squirrel work uses executor:general, scope:general without employee identity. Employee work fixes the verified employee and current scope. '+revisionDispatchGuide+'Ordinary questions need no Task. Business reference must exactly match the owner message or an actual local-record/HTTP-source read result, including scope, object, version and hash. The host fixes the real owner request; unknown results require status, never another dispatch. '+executionReceiptGuide,parameters:{...scopeParameter,title:{type:'string',required:true},...goalParameter,executor:{type:'string',enum:['general'],description:'Use general for general-agent/squirrel work, including artifact revisions; omit employee identity and reference.'},roleId:{type:'string'},expectedRoleVersion:{type:'integer'},workTokenLimit:{type:'integer',description:'Optional positive safe integer token cap for this newly approved work, only when explicitly requested by the owner. Omit to retain the default 2000000; owner aggregate limits and all other controls remain in force. This is not a time limit or a change to existing work.'},reference:{type:'object',description:'Business-employee work only: exact record reference from the current owner message, teloa_business_records_read, or the configured HTTP source query; the host independently verifies it. Bind here, never through task materials. Omit for executor:general, including artifact revisions. Revision markers are not business objects and cannot fill id/type/snapshotHash.',additionalProperties:false,properties:{scope:{type:'string',required:true},type:{type:'string',required:true},id:{type:'string',required:true},version:{type:'integer',required:true},snapshotHash:{type:'string',required:true}}}}},
 {name:'teloa_work_collect_reports',description:'Only an explicit owner request for fresh employee reports opens a native approval card; no Task/Run before approval, no execution on rejection. Do not substitute chat questions for approval. After approval, fix the business roster and start one Task/Run per active employee, retaining paused/retired/failed counts. general is general work; allBusinesses:true requires an explicit cross-business request. Coordination stays general; specialists retain their own business. Use facts to inspect existing work without waking staff. '+executionReceiptGuide,parameters:{...scopeParameter,title:{type:'string',required:true},...goalParameter,allBusinesses:{type:'boolean'}}},
 {name:'teloa_work_status',description:'Read original-conversation requests, real Task/Run states and verified final replies. Without requestId, list all requests in this conversation. Recover lost responses here, never duplicate dispatch. '+executionReceiptGuide,parameters:{requestId:{type:'string'}}},
 {name:'teloa_work_stop',description:'Stop this conversation’s specified request: persist stop intent to block undispatched members, then request actual Runs to stop. waiting means stopping has not settled.',parameters:requestParameter},
 {name:'teloa_work_resume',description:'Only on explicit owner retry, use the original requestId from status to continue the same Task, even across user turns. The host checks whether an ended failed Run permits a new Run; ended alone does not forbid retry, and a new Run is not a new Task. Never replace the Task, assignee or business, restart a stopped request or resend an unknown result; use the current host receipt. A [teloa-revision: marker is a new linked artifact revision, not a requestId or retry: use teloa_work_dispatch with executor:general, scope:general and native approval.',parameters:requestParameter},
 {name:'teloa_work_facts',description:'Read real visible Task/Run/artifact statistics without waking staff or reading private memories/daily logs. Convert from/to to UTC with exactly 3 millisecond digits and Z; timezone retains the owner’s IANA zone. Omitted scope uses the selected business; only no selection means all. Explicit cross-business requests may use allBusinesses:true. general is general work only. partial is not complete; failure is not zero work.',parameters:{scope:{type:'string'},allBusinesses:{type:'boolean'},from:{type:'string',required:true,description:'Inclusive UTC ISO start, e.g. 2026-10-16T16:00:00.000Z. Exactly 3 millisecond digits and Z; +08:00 is invalid.'},to:{type:'string',required:true,description:'Exclusive UTC ISO end, e.g. 2026-10-17T16:00:00.000Z. Exactly 3 millisecond digits and Z; +08:00 is invalid.'},timezone:{type:'string',required:true,description:'Owner’s IANA statistics zone, e.g. Asia/Singapore; from/to must still use UTC.'}}},
 {name:'teloa_business_data_query',description:businessDataSourceGuide+' Results retain provenance, time, fixed object references and pagination. Task counts cannot stand in for alert counts. Missing sources fail; never supply sample data. Page items are not the source total; exhaust nextCursor before claiming complete coverage.',parameters:{...scopeParameter,text:{type:'string'},source:{type:'string',description:'Filter the returned snapshot.source field; not a connection ID, local-records sourceId, or source switch.'},quality:{type:'string',enum:['complete','missing']},observedAfter:{type:'string'},limit:{type:'integer',required:true},cursor:{type:'string'}}},
] as const
const exactKeys:Record<typeof conversationWorkToolNames[number],readonly string[]>={teloa_work_directory:[],teloa_work_dispatch:['scope','title','goal','executor','roleId','expectedRoleVersion','reference','workTokenLimit'],teloa_work_collect_reports:['scope','title','goal','allBusinesses'],teloa_work_status:['requestId'],teloa_work_stop:['requestId'],teloa_work_resume:['requestId'],teloa_work_facts:['scope','allBusinesses','from','to','timezone'],teloa_business_data_query:['scope','text','source','quality','observedAfter','limit','cursor']}
export type ConversationWorkAuthorizationPorts=Pick<ConversationWorkToolsPorts,'owner'|'conversation'|'readTaskPolicy'|'isRoleConversation'|'isBuilder'|'isPendingDaily'|'isTaskConversation'>
export async function authorizeConversationWorkMutation(ports:ConversationWorkAuthorizationPorts,exec:Pick<ToolExecution,'agent'|'signal'>){
 const authorization=await authorizeOrdinaryConversationMutation({...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal},'主会话工作交办')
 if(await ports.isRoleConversation(authorization.sessionId))throw new WorkError('teloa/forbidden','员工身份会话不能冒用本人主助手的交办入口。')
 if(await ports.isTaskConversation?.(authorization.sessionId))throw new WorkError('teloa/forbidden','当前会话属于既有任务，请从任务页继续原工作，不能另起无关交办。')
 if(await ports.isBuilder?.(authorization.sessionId))throw new WorkError('teloa/forbidden','业务搭建会话只能修改配置草案，请从日常业务会话交办正式工作。')
 if(await ports.isPendingDaily?.(authorization.sessionId))throw new WorkError('teloa/binding-pending','日常业务会话尚未完成归属，请先恢复原预约。')
 return authorization
}
async function business(ports:ConversationWorkToolsPorts,scope:string){
 const value=scope==='general'?null:await ports.business?.(scope)??null
 if(!value)return null
 if(typeof value.title!=='string'||!value.title.trim())throw new WorkError('teloa/invalid-host-response','业务名称不可核对。')
 return {title:value.title,responsibility:readBusinessResponsibility(value.responsibility,scope)}
}
/** 只投影本轮真实本人标记；旧历史、模型文字和目录读取本身不构成交办授权。 */
async function currentArtifactRevision(ports:ConversationWorkToolsPorts,exec:Pick<ToolExecution,'agent'|'signal'>,claimed?:readonly ReturnType<typeof createUserMessage>[]){
 if(!exec.agent)return
 if(claimed){
  if(!claimed.some(message=>message.source.kind==='user'&&message.content.some(block=>block.type==='text'&&block.text.includes('[teloa-revision:'))))return
 }else{
  const events=readSessionEvents(exec.agent.session),start=events.filter(event=>event.type==='turn/start').at(-1)?.seq
  if(start===undefined||!events.some(event=>event.seq>start&&event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user'&&event.data.content.some(block=>block.type==='text'&&block.text.includes('[teloa-revision:'))))return
 }
 const sessionId=exec.agent.session.id,users=()=>claimed?.filter(message=>message.source.kind==='user')
 const currentSource=()=>{
  if(!claimed)return sourceInstruction(ports.owner,exec)
  const messages=users()!,events=readSessionEvents(exec.agent!.session),start=events.filter(event=>event.type==='turn/start').at(-1)?.seq
  const persisted=events.filter(event=>start!==undefined&&event.seq>start&&event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user')
  if(start===undefined||start<exec.agent!.session.inheritedEventCount||persisted.length+messages.length!==1||messages.length!==1||messages[0]!.content.some(block=>block.type!=='text'))throw new WorkError('teloa/forbidden','成果修订投影需要本轮唯一本人纯文本输入。')
  // 官方 Loop 的 claimed 输入尚未持久化；只读查询仅需 session/text，不伪造 seq、requestId 或交办身份。
  return {sessionId,sourceText:messages[0]!.content.map(block=>block.type==='text'?block.text:'').join('\n')}
 }
 const source=currentSource(),currentFingerprint=()=>JSON.stringify(claimed?{sessionId:exec.agent?.session.id,turnStart:readSessionEvents(exec.agent!.session).filter(event=>event.type==='turn/start').at(-1)?.seq,source:currentSource(),messages:users()}:currentSource()),fingerprint=currentFingerprint()
 await authorizeConversationWorkMutation(ports,exec)
 if(!ports.revisionGoal)throw new WorkError('teloa/forbidden','成果续改必须核对本人已保存的固定反馈。')
 const goal=await ports.revisionGoal(source)
 if(!goal)throw new WorkError('teloa/forbidden','原成果反馈尚不可核对。')
 await authorizeConversationWorkMutation(ports,exec)
 if(currentFingerprint()!==fingerprint)throw new WorkError('teloa/conflict','读取修订期间本人原指令已变化。')
 return {executor:'general' as const,scope:'general',goal:taskDefinition({scope:'general',title:'成果修订',goal}).goal,receiptNotice:revisionDispatchGuide}
}
async function prepareDispatch(ports:ConversationWorkToolsPorts,exec:ToolExecution,input:Record<string,unknown>){
 const auth=await authorizeConversationWorkMutation(ports,exec),identity=sourceInstruction(ports.owner,exec),kind=exec.name==='teloa_work_dispatch'?'task':'report'
 const fields=taskDefinition({title:input.title,goal:input.goal,scope:input.scope})
 const workTokenLimit=input.workTokenLimit===undefined?undefined:readWorkTokenLimit(input.workTokenLimit)
 if(workTokenLimit!==undefined&&kind!=='task')throw new WorkError('teloa/invalid-input','只有单次交办可以预设本次工作 token 上限。')
 if(input.executor==='general'&&input.reference!==undefined)throw new WorkError('teloa/invalid-input',revisionDispatchGuide)
 const reference=input.reference===undefined?undefined:businessObjectReference(input.reference)
 const selectedRecord=parseBusinessRecordReferences(identity.sourceText??'')[0]
 if(selectedRecord&&(kind!=='task'||!reference||JSON.stringify(reference)!==JSON.stringify(selectedRecord)))throw new WorkError('teloa/invalid-reference','交办对象与本人消息中选择的固定记录不一致；未创建任务。')
 let referenceTitle:string|undefined
 if(reference){
  if(reference.scope!==fields.scope||!ports.reference)throw new WorkError('teloa/invalid-reference','对象来源尚不可核对。')
  const label=await ports.reference(reference)
  if(label!==undefined){if(typeof label.title!=='string'||!label.title.trim()||label.title.length>4096)throw new WorkError('teloa/invalid-host-response','固定对象名称不可核对。');referenceTitle=label.title}
 }
 // 来源历史读取可能等待；其后再取当前业务、角色和负责人，不能沿用等待前的授权。
 const [context,scopes,roles,selectedBusiness]=await Promise.all([ports.context(auth.sessionId),ports.scopes(),ports.roles(),business(ports,fields.scope)])
 if(input.allBusinesses!==undefined&&input.allBusinesses!==true)throw new WorkError('teloa/invalid-input','全部业务只能显式选择 true。')
 if(!scopes.includes(fields.scope)||input.allBusinesses===true&&fields.scope!=='general')throw new WorkError('teloa/forbidden','当前无权交办此业务。')
 if(context&&((context.scopeId!==fields.scope&&!input.allBusinesses)||context.roleId!==null&&(kind==='report'||context.roleId!==input.roleId)))throw new WorkError('teloa/conflict','交办与当前会话业务或指定接手人不一致。')
 if(roles.some(role=>role.ownerId!==ports.owner))throw new WorkError('teloa/invalid-host-response','员工目录混入其他本人记录。')
 const general=kind==='task'&&input.executor==='general'
 if(input.executor!==undefined&&!general||general&&(fields.scope!=='general'||input.roleId!==undefined||input.expectedRoleVersion!==undefined||reference!==undefined||context?.roleId!=null))throw new WorkError('teloa/invalid-input','通用独立工作只能使用本人的 general 会话，不能混入员工或业务对象身份。')
 if(identity.sourceText?.includes('[teloa-revision:')){
  if(!general||!ports.revisionGoal)throw new WorkError('teloa/forbidden','成果续改必须核对本人已保存的固定反馈。')
  const goal=await ports.revisionGoal(identity)
  if(!goal)throw new WorkError('teloa/forbidden','原成果反馈尚不可核对。')
  fields.goal=taskDefinition({...fields,goal}).goal
 }
 const selected=kind==='task'?roles.filter(role=>role.id===input.roleId):roles.filter(role=>role.kind==='employee'&&(input.allBusinesses===true?role.scopes.some(scope=>scopes.includes(scope)):role.scopes.includes(fields.scope)))
 if(kind==='task'&&!general&&(selected.length!==1||selected[0]!.kind!=='employee'||selected[0]!.state!=='active'||selected[0]!.version!==input.expectedRoleVersion||!roleSupportsScope(selected[0]!.scopes,fields.scope)))throw new WorkError('teloa/conflict','本次执行员工的岗位版本、状态或业务权限已变化，请重新核对。')
 exec.signal.throwIfAborted()
 const expectedReportTargets=kind==='report'?selected.map(role=>({roleId:role.id,roleVersion:role.version,name:role.name,scope:input.allBusinesses===true?role.scopes.find(scope=>scopes.includes(scope))!:fields.scope,unavailable:role.state==='active'?null:role.state})).sort((a,b)=>a.roleId.localeCompare(b.roleId)):undefined
 if(expectedReportTargets&&expectedReportTargets.length>1000)throw new WorkError('teloa/invalid-input','汇报名单超过1000人，请缩小范围。')
 const scopeTitles:Record<string,string>=Object.fromEntries(await Promise.all([...new Set(expectedReportTargets?.map(target=>target.scope)??[fields.scope])].sort().map(async scope=>{
  const choice=scope===fields.scope?selectedBusiness:await business(ports,scope)
  return [scope,scope==='general'?'通用工作':choice?.title??scope]
 })))
 const request:ConversationWorkReserveInput={...identity,kind,scope:fields.scope,title:fields.title,goal:fields.goal,...(workTokenLimit===undefined?{}:{workTokenLimit}),...(input.allBusinesses===undefined?{}:{allBusinesses:input.allBusinesses as true}),...(general?{executor:'general' as const}:kind==='task'?{roleId:input.roleId as string,expectedRoleVersion:input.expectedRoleVersion as number,...(selectedBusiness?{responsibility:{version:selectedBusiness.responsibility.version,roleId:selectedBusiness.responsibility.roleId}}:{})}:{}),...(reference?{reference}:{}),...(expectedReportTargets?{expectedReportTargets}:{})}
 const summary={general,workTokenLimit:kind==='task'?workTokenLimit??defaultWorkBudgetPolicy.maxTokens:null,business:selectedBusiness?.title??fields.scope,scope:fields.scope,context,responsibility:selectedBusiness?.responsibility??null,executors:selected.map(role=>({id:role.id,name:role.name,version:role.version,state:role.state,scopes:role.scopes})),expectedReportTargets:expectedReportTargets??null,singleOverride:kind==='task'&&!!selectedBusiness?.responsibility.roleId&&selectedBusiness.responsibility.roleId!==input.roleId,reference:reference??null,title:fields.title,goalAndAcceptance:fields.goal,originalInstruction:identity.sourceText}
 return {request,summary,referenceTitle,scopeTitles,fingerprint:JSON.stringify({request,summary,referenceTitle,scopeTitles})}
}
/** 仅投影已冻结的真实交办；安全身份与校验摘要继续保留在原请求和完整指纹中。 */
function workApprovalDescription({summary:s,referenceTitle,scopeTitles}:Awaited<ReturnType<typeof prepareDispatch>>){
 const objectLabel=s.reference?`${referenceTitle??s.reference.type+' · '+s.reference.id}（v${s.reference.version}）`:undefined
 const readable=(value:string)=>{
  return s.reference?value.split(encodeBusinessRecordReference(s.reference)).join(objectLabel!):value
 }
 const state={draft:'尚未在岗',active:'在岗',paused:'暂停',retired:'已退役'}
 const crossBusiness=!!s.expectedReportTargets&&s.scope==='general'&&s.expectedReportTargets.some(target=>target.scope!=='general')
 const employees=s.executors.map(role=>{
  const target=s.expectedReportTargets?.find(target=>target.roleId===role.id)
  return `${role.name}（${state[role.state]}${crossBusiness&&target?' · '+scopeTitles[target.scope]:''}）`
 }).join('、')||'没有可执行员工'
 const current=s.responsibility?.availability
 const availability=current==='paused'?'暂停':current==='retired'?'已退役':current==='missing'?'不可用':current==='forbidden'?'不在可用范围':undefined
 return [
  `确认交办：${readable(s.title)}`,
  crossBusiness?`跨业务范围：${Object.values(scopeTitles).join('、')}`:`业务：${s.business==='general'?'通用工作':s.business}`,
  s.general?'执行助手：通用 Agent／小松鼠':`执行员工：${employees}`,
  ...(objectLabel?[`工作对象：${objectLabel}`]:[]),
  ...(s.workTokenLimit===null?[]:[`本次工作 token 上限：${s.workTokenLimit.toLocaleString('zh-CN')}。本人累计总额度仍然约束本次执行；此上限不设置或重置工作截止时间。`]),
  `目标与验收要求：\n${readable(s.goalAndAcceptance)}`,
  `本人原指令：\n${readable(s.originalInstruction??'')}`,
  s.singleOverride?'仅本次由指定员工接手，持久业务负责人不变。':'本次交办的持久业务负责人不变。',
  ...(availability?[`原业务负责人当前${availability}。`]:[]),
  '批准后才创建并执行工作；收到员工回复后仍须核对成果。',
 ].join('\n\n')
}
export function registerConversationWorkTools(ctx:Context,ports:ConversationWorkToolsPorts){
 const removePresentation=registerConversationResultPresentation(ctx,ports)
 const prepared=new WeakMap<ToolExecution,Awaited<ReturnType<typeof prepareDispatch>>>()
 for(const definition of definitions)ctx.tools.register(defineTool({...definition,output:{schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]},execute:async(args,exec)=>{
  const auth=await authorizeConversationWorkMutation(ports,exec),input=taskInput(args,exactKeys[definition.name])
  try{
   let value:unknown
   if(definition.name==='teloa_work_directory'){
    const [context,roles,scopes]=await Promise.all([ports.context(auth.sessionId),ports.roles(),ports.scopes()])
    if(roles.some(role=>role.ownerId!==ports.owner))throw new WorkError('teloa/invalid-host-response','员工目录混入其他本人记录。')
    const businesses=await Promise.all(scopes.filter(scope=>scope!=='general').map(async scope=>({scope,...await business(ports,scope)})))
    const artifactRevision=await currentArtifactRevision(ports,exec)
    value={context,scopes,businesses,observedAt:ports.now(),roles:roles.filter(role=>role.kind==='employee').map(role=>({id:role.id,version:role.version,name:role.name,state:role.state,scopes:role.scopes,duty:role.duty,skills:role.skills,dataScope:role.dataScope,executionScope:role.executionScope})),...(artifactRevision?{artifactRevision}:{}),receiptNotice:directoryReceiptGuide}
   }else if(definition.name==='teloa_work_dispatch'||definition.name==='teloa_work_collect_reports'){
    const fixed=prepared.get(exec)
    if(!fixed)throw new WorkError('teloa/conflict','交办尚未完成原生确认。')
    const revalidate=async()=>{
     const current=await prepareDispatch(ports,exec,input)
     if(current.fingerprint!==fixed.fingerprint)throw new WorkError('teloa/conflict','确认期间指令、业务负责人、对象或岗位已变化，请核对原请求。')
     await authorizeConversationWorkMutation(ports,exec)
     const {requestId,sessionId,messageId,messageSeq,sourceText}=fixed.request
     if(JSON.stringify(sourceInstruction(ports.owner,exec))!==JSON.stringify({requestId,sessionId,messageId,messageSeq,sourceText}))throw new WorkError('teloa/conflict','本人原指令已变化。')
     exec.signal.throwIfAborted()
    }
    await revalidate()
    value=await ports.dispatch(fixed.request,exec.signal,revalidate)
    // 把本次已完成的批准事实放在即时回包，避免旧历史的待批准文案压过工具说明。
    if(value&&typeof value==='object'&&!Array.isArray(value))value={...value,approvalState:'approved',receiptNotice:'This delegation approval completed through the native card. '+executionReceiptGuide}
   }else if(definition.name==='teloa_work_status')value=await ports.status(auth.sessionId,input.requestId as string|undefined)
   else if(definition.name==='teloa_work_stop')value=await ports.stop(auth.sessionId,input.requestId as string,exec.signal)
   else if(definition.name==='teloa_work_resume'){
    const identity=sourceInstruction(ports.owner,exec)
    if(identity.sourceText?.includes('[teloa-revision:')){
     // 成果续改是新的关联修订，必须核对持久反馈后走 dispatch 原生确认，不能落入旧任务恢复；反馈正文不进入错误。
     if(!ports.revisionGoal)throw new WorkError('teloa/forbidden','成果续改必须核对本人已保存的固定反馈，不能恢复旧任务。')
     if(!await ports.revisionGoal(identity))throw new WorkError('teloa/forbidden','原成果反馈尚不可核对，不能恢复旧任务。')
     throw new WorkError('teloa/conflict','成果续改是新的关联修订，不是重试原交办；teloa-revision 标记不是工作 requestId。请调用 teloa_work_dispatch 并传 executor:general、scope:general，经原生确认卡批准后再启动。')
    }
    if(!ports.resume)throw new WorkError('teloa/unavailable','原交办恢复尚未就绪。')
    value=await ports.resume(auth.sessionId,input.requestId as string,exec.signal)
   }
   else if(definition.name==='teloa_work_facts'){
    if(input.allBusinesses!==undefined&&input.allBusinesses!==true||input.allBusinesses===true&&input.scope!==undefined)throw new WorkError('teloa/invalid-input','全部业务与单个业务不能同时选择。')
    const {allBusinesses,...query}=input,context=await ports.context(auth.sessionId)
    value=await ports.facts({...query,...(allBusinesses!==true&&query.scope===undefined&&context?{scope:context.scopeId}:{})})
   }
   else value=await ports.data(input,exec.signal)
   exec.signal.throwIfAborted();return JSON.stringify(value)
  }catch(error){if(error instanceof WorkError||exec.signal.aborted)throw error;throw new WorkError('teloa/host-unavailable','工作服务暂不可用，请核对本会话原交办，不要重复发送。')}
 }}))
 const removeGuard=ctx.on('tools/pre-execute',async(exec,next)=>{
  if(!(conversationWorkToolNames as readonly string[]).includes(exec.name))return next()
  let fixed:Awaited<ReturnType<typeof prepareDispatch>>|undefined
  try{await authorizeConversationWorkMutation(ports,exec);const input=taskInput(exec.arguments,exactKeys[exec.name as typeof conversationWorkToolNames[number]]);if(exec.name==='teloa_work_dispatch'||exec.name==='teloa_work_collect_reports'){fixed=await prepareDispatch(ports,exec,input);prepared.set(exec,fixed)}}catch(error){return {kind:'deny' as const,reason:error instanceof WorkError?error.message:'暂时无法核对工作交办身份。'}}
  const decision=await next()
  if(!fixed||decision.kind==='deny'||decision.kind==='cancel')return decision
  const reason=(decision.kind==='ask'&&decision.reason?decision.reason+'\n':'')+workApprovalDescription(fixed)
  if(Buffer.byteLength(reason,'utf8')>131072)return {kind:'deny' as const,reason:'确认内容超过 128 KiB，请缩小交办内容后重试；尚未创建任务。'}
  return {kind:'ask' as const,reason}
 })
 const removeContext=ctx.on('agent/pre-step',async({agent,signal,messages},next)=>{
  const decision=await next()
  if(decision.kind==='reject'||!decision.messages.some(message=>message.source.kind==='user'))return decision
  // 岗位执行和普通原生会话沿用各自身份；只对已绑定的本人主会话补充业务指引。
  let binding:Awaited<ReturnType<typeof ports.conversation>>
  try{binding=await ports.conversation(agent.session.id)}catch(error){if(error instanceof WorkError&&(error.code==='teloa/not-bound'||error.code==='teloa/not-found'||error.code==='teloa/forbidden'))return decision;throw error}
  if(binding.status!=='ready'||binding.ownerId!==ports.owner||agent.session.header.origin==='subagent')return decision
  retireCoordinationNotices(agent)
  if(await ports.readTaskPolicy(agent.session.id,signal)!==null||await ports.isRoleConversation(agent.session.id)||await ports.isTaskConversation?.(agent.session.id)||await ports.isBuilder?.(agent.session.id))return decision
  if(await ports.isPendingDaily?.(agent.session.id))throw new WorkError('teloa/binding-pending','日常业务会话尚未完成归属，请先恢复原预约。')
  const context=await ports.freeze(agent.session.id),responsibility=context?await business(ports,context.scopeId):null
  let artifactRevision:Awaited<ReturnType<typeof currentArtifactRevision>>
  try{artifactRevision=await currentArtifactRevision(ports,{agent,signal},messages)}catch(error){
   // 修订完成后仍允许协调器读取状态和汇报；无效标记不投影旧反馈，交办时继续严格拒绝。
   if(!(error instanceof WorkError&&(error.code==='teloa/forbidden'||error.code==='teloa/version-conflict'||error.code==='teloa/invalid-input')))throw error
  }
  const notice=createUserMessage({source:{kind:conversationWorkSource,form:'notice',summary:coordinationSummary},content:[{type:'text',text:coordinationGuide+JSON.stringify({context:context??{scopeId:null,roleId:null},business:responsibility,...(artifactRevision?{artifactRevision}:{})})}]})
  return {...decision,messages:[...decision.messages,notice]}
 })
 return ()=>{removeGuard();removeContext();removePresentation()}
}
