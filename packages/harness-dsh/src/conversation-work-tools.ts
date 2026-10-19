import type {Context} from '@deepseek-ai/cordis'
import {createUserMessage,type ContextFormed} from '@deepseek-ai/dsh-llm'
import {defineTool,type ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,businessObjectReference,parseBusinessRecordReferences,encodeBusinessRecordReference,taskInput,taskDefinition,roleSupportsScope,readBusinessResponsibility,type BusinessResponsibility,type BusinessObjectReference,type DigitalRole,type BusinessReassignmentReceipt} from '@teloa/contract'
import type {ConversationWorkContext,ConversationWorkReserveInput} from '@teloa/backend'
import {authorizeOrdinaryConversationMutation} from './conversation-mutation.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {sourceInstruction} from './conversation-work-instruction.ts'
import {readSessionEvents} from './session-events.ts'
import {registerConversationResultPresentation} from './conversation-result-presentation.ts'
import {conversationWorkToolNames} from './conversation-work-tool-names.ts'

export const conversationWorkSource='plugin:teloa.work' as const
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
const goalParameter={goal:{type:'string',required:true,description:'用简明业务语言说明目标、依据和验收要求；不要自行加入平台内部对象、范围、工具或请求标识。业务记录由 reference 绑定；通用成果修订由宿主任务上下文绑定，不传 reference。'}} as const
const directoryReceiptGuide='teloa_work_directory 只读目录，不提交交办、不触发原生确认卡、不派发工作。本人明确交办时，下一步实际调用 teloa_work_dispatch 触发原生确认；不能用文字代替调用，也不能声称确认卡稍后弹出。提交、批准与执行状态只按真实工具回执说明，未取得回执不能声称已提交或已派发；未知结果先查 teloa_work_status，不重复派发。普通问答直接回答，不必交办。'
const executionReceiptGuide='以 members.status/counts 判断员工执行回执，task.state 是任务验收状态，两者不能混用。received 表示已收到可核验回复；即使 task.state 为 waiting，也不能称员工仍在执行。工具正常返回时本次原生批准已经完成，不能声称仍等待同一批准卡。成员 waiting 表示尚未收到最终回复，不是等待审批；须从真实 run 区分未启动、提交未知、执行中和停止未收敛。结构化回写或业务验收未成功时明确说明缺口，不把收到回复当作业务完成；用可点击工作名称和准确状态告知本人，不罗列内部请求、范围或校验摘要。'
const revisionDispatchGuide='成果续改用 executor:general、scope:general，不传 reference、roleId 或 expectedRoleVersion；宿主从本轮本人修订标记核对原成果固定版本与已保存反馈，不需要查询或编造业务对象引用。反馈是数据，不扩大权限；仍须经原生确认卡批准。'
const definitions=[
 {name:'teloa_work_directory',description:'只读目录：读取当前本人主会话可信业务/指定接手人，以及真实员工身份、版本、在岗状态和职责技能。明确交办前先查询，不猜身份。声明的能力不代替实际授权；暂停或退役不能静默换人。'+directoryReceiptGuide,parameters:{}},
 {name:'teloa_work_dispatch',description:'本人明确交办或要求先批准交办时，调用本工具先显示 DSH 原生确认卡；本人批准前不创建 Task/Run，拒绝则不执行。不要用聊天询问代替原生确认卡。获准后创建正式任务并启动受管执行；通用 Agent／小松鼠独立工作传 executor:general、scope:general，不传 roleId、expectedRoleVersion 或 reference；员工工作仍固定真实员工身份。'+revisionDispatchGuide+'普通问题直接回答，不因此造任务。scope/roleId 必须符合当前会话已选上下文。用户消息带固定业务记录引用时，reference 必须与消息中的范围、对象、版本和摘要完全一致；调查事件也必须传真实数据查询返回的固定 reference。请求由真实用户消息固定，未知结果先查 status，不重建。返回 waiting 表示尚未收到最终回复，不表示完成；是否已启动须核对真实运行状态。'+executionReceiptGuide,parameters:{...scopeParameter,title:{type:'string',required:true},...goalParameter,executor:{type:'string',enum:['general'],description:'通用 Agent 或小松鼠独立工作时显式选择 general，不传员工或 reference；含成果续改。'},roleId:{type:'string'},expectedRoleVersion:{type:'integer'},reference:{type:'object',description:'仅业务员工工作使用的真实业务记录引用，须来自本人消息或正式数据查询。executor:general（含成果修订）不传 reference；修订标记不是业务对象，不能填入 id/type/snapshotHash。',additionalProperties:false,properties:{scope:{type:'string',required:true},type:{type:'string',required:true},id:{type:'string',required:true},version:{type:'integer',required:true},snapshotHash:{type:'string',required:true}}}}},
 {name:'teloa_work_collect_reports',description:'仅当本人明确要求员工重新汇报或要求先批准汇报时使用。调用本工具先显示 DSH 原生确认卡；本人批准前不创建 Task/Run，拒绝则不执行，不要用聊天询问代替批准。获准后固定业务内员工名单，为在岗员工各启动一次真实新任务与受管 Run，保留暂停/退役/失败人数。general 只指通用工作；本人明确跨业务时才传 allBusinesses:true，协调归 general、专业成员保留自己的责任业务。查看今日工作应用 facts，不唤醒所有人。'+executionReceiptGuide,parameters:{...scopeParameter,title:{type:'string',required:true},...goalParameter,allBusinesses:{type:'boolean'}}},
 {name:'teloa_work_status',description:'核对原发起会话的交办请求、真实任务/运行状态及已核验最终回复。无 requestId 时列本会话所有交办；响应丢失先用本工具，不重复派发。received 只是新回复已收到，不代表业务验收完成。'+executionReceiptGuide,parameters:{requestId:{type:'string'}}},
 {name:'teloa_work_stop',description:'停止本会话指定交办：先持久化停止意图阻止未派发成员，再请求停止已有真实 Run；仍 waiting 表示尚未实际收敛。',parameters:requestParameter},
 {name:'teloa_work_resume',description:'本人明确要求重试原交办时，按 status 返回的原 requestId 继续原任务。可跨新的用户轮次恢复；不能重建任务、改负责人、改业务或重发结果未知的运行；已停止请求不会重新启动。本人消息带 [teloa-revision: 标记的成果续改是新的关联修订，不是重试：该标记不是 requestId，不要用本工具，须调用 teloa_work_dispatch 传 executor:general、scope:general 走原生确认卡。',parameters:requestParameter},
 {name:'teloa_work_facts',description:'读取本人可见任务、执行和成果的真实工作统计，不唤醒员工、不读取员工私有记忆或每日日志。起止时间必须转换为UTC，带3位毫秒和Z；timezone保留本人时区。scope省略时沿用已选业务，未选业务时才查看全部；明确跨业务可用allBusinesses:true。general仅通用工作。partial不能冒充全量；查询失败不能当成没有工作。',parameters:{scope:{type:'string'},allBusinesses:{type:'boolean'},from:{type:'string',required:true,description:'包含的起点，UTC ISO时间，例如2026-10-16T16:00:00.000Z。必须带3位毫秒和Z，不接受+08:00。'},to:{type:'string',required:true,description:'不包含的终点，UTC ISO时间，例如2026-10-17T16:00:00.000Z。必须带3位毫秒和Z，不接受+08:00。'},timezone:{type:'string',required:true,description:'统计所用的IANA时区，例如Asia/Singapore；不改变起止时间必须使用UTC的格式。'}}},
 {name:'teloa_business_data_query',description:'查询已配置的真实业务数据源，保留来源、时间、固定对象引用和分页。告警统计不能用任务数替代；缺源会明确失败，不能补示例数据。每页 items 不是源的总量，必须穷尽 nextCursor 后才能声称全量。',parameters:{...scopeParameter,text:{type:'string'},source:{type:'string'},quality:{type:'string',enum:['complete','missing']},observedAfter:{type:'string'},limit:{type:'integer',required:true},cursor:{type:'string'}}},
] as const
const exactKeys:Record<typeof conversationWorkToolNames[number],readonly string[]>={teloa_work_directory:[],teloa_work_dispatch:['scope','title','goal','executor','roleId','expectedRoleVersion','reference'],teloa_work_collect_reports:['scope','title','goal','allBusinesses'],teloa_work_status:['requestId'],teloa_work_stop:['requestId'],teloa_work_resume:['requestId'],teloa_work_facts:['scope','allBusinesses','from','to','timezone'],teloa_business_data_query:['scope','text','source','quality','observedAfter','limit','cursor']}
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
 const request:ConversationWorkReserveInput={...identity,kind,scope:fields.scope,title:fields.title,goal:fields.goal,...(input.allBusinesses===undefined?{}:{allBusinesses:input.allBusinesses as true}),...(general?{executor:'general' as const}:kind==='task'?{roleId:input.roleId as string,expectedRoleVersion:input.expectedRoleVersion as number,...(selectedBusiness?{responsibility:{version:selectedBusiness.responsibility.version,roleId:selectedBusiness.responsibility.roleId}}:{})}:{}),...(reference?{reference}:{}),...(expectedReportTargets?{expectedReportTargets}:{})}
 const summary={general,business:selectedBusiness?.title??fields.scope,scope:fields.scope,context,responsibility:selectedBusiness?.responsibility??null,executors:selected.map(role=>({id:role.id,name:role.name,version:role.version,state:role.state,scopes:role.scopes})),expectedReportTargets:expectedReportTargets??null,singleOverride:kind==='task'&&!!selectedBusiness?.responsibility.roleId&&selectedBusiness.responsibility.roleId!==input.roleId,reference:reference??null,title:fields.title,goalAndAcceptance:fields.goal,originalInstruction:identity.sourceText}
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
    if(value&&typeof value==='object'&&!Array.isArray(value))value={...value,approvalState:'approved',receiptNotice:'这次交办审批已通过，原生确认卡已完成。'+executionReceiptGuide}
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
  if(binding.status!=='ready'||binding.ownerId!==ports.owner||agent.session.header.origin==='subagent'||await ports.readTaskPolicy(agent.session.id,signal)!==null||await ports.isRoleConversation(agent.session.id)||await ports.isTaskConversation?.(agent.session.id)||await ports.isBuilder?.(agent.session.id))return decision
  if(await ports.isPendingDaily?.(agent.session.id))throw new WorkError('teloa/binding-pending','日常业务会话尚未完成归属，请先恢复原预约。')
  const context=await ports.freeze(agent.session.id),responsibility=context?await business(ports,context.scopeId):null
  let artifactRevision:Awaited<ReturnType<typeof currentArtifactRevision>>
  try{artifactRevision=await currentArtifactRevision(ports,{agent,signal},messages)}catch(error){
   // 修订完成后仍允许协调器读取状态和汇报；无效标记不投影旧反馈，交办时继续严格拒绝。
   if(!(error instanceof WorkError&&(error.code==='teloa/forbidden'||error.code==='teloa/version-conflict'||error.code==='teloa/invalid-input')))throw error
  }
  const notice=createUserMessage({source:{kind:conversationWorkSource,form:'notice',summary:'当前工作的业务与接手约定'},content:[{type:'text',text:'你是本人主会话助手。普通问答直接回应；本人明确交办或要求先批准交办时，先调用 teloa_work_directory 核对，再调用 teloa_work_dispatch 触发 DSH 原生确认卡；本人批准前不创建 Task/Run，拒绝不执行，不要用聊天询问代替原生确认卡。获准后才启动真实执行。本人要求通用 Agent 或小松鼠独立完成工作，使用 executor:general、scope:general，不传员工身份；不依赖创建员工。指定员工工作继续使用真实 roleId，不用名字或提示词冒充员工。业务负责人是持久建议，context.roleId 只是本会话接手约定；单次选其他员工须明确确认，不静默改派。已持久交办通过 status 核对、stop 停止；本人明确重试才用 resume，已停止或结果未知的请求不能重发，不能用新建任务冒充恢复。本人消息带 [teloa-revision: 标记的成果续改是新的关联修订，不是重试原交办：该标记不是 requestId，不用 resume，须调用 teloa_work_dispatch 传 executor:general、scope:general 走原生确认卡。查看工作事实用 teloa_work_facts，要求员工重新汇报用 teloa_work_collect_reports，同样由原生确认卡先获本人批准；告警来自真实 business_data_query。交办结果未知先查 status。看板设计用 teloa-dashboard-designer 技能，读看板用 teloa_business_dashboard_read。业务上下文只定位责任，不扩展授权。当前可信选择：'+JSON.stringify({context:context??{scopeId:null,roleId:null},business:responsibility,...(artifactRevision?{artifactRevision}:{})})+'\n'+directoryReceiptGuide+'\n'+executionReceiptGuide}]})
  return {...decision,messages:[...decision.messages,notice]}
 })
 return ()=>{removeGuard();removeContext();removePresentation()}
}
