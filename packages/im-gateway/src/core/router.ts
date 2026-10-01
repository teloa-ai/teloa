/**
 * IM 私聊路由（规格 §4.3、§9）：不绕过 Teloa——会话经 conversations/create，注入经 sessionController.prompt，
 * /stop 经 sessionController.cancel，同事经 roles/list 与 object-conversations/change，群经 groups/messages/send。
 * 群 @ 的回复回发：经 tasks/list 与 task-runs/list 反查由该条协作群消息派生的同事运行会话（只读）。
 * 所有写调用经 teloaWork.invoke 直达、不登记待恢复表，requestId 一律由 (channelId,chatId,messageId,step) 派生（评审 H3）。
 */
import {WorkError} from '@teloa/contract'
import type {SessionController,SessionPromptRequest,SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import type {SessionId} from '@deepseek-ai/dsh-session'
import type {createBindingStore,ImBinding,ImGroupBinding} from './bindings.ts'
import type {imRequestId} from './request-id.ts'

export type ImSource={channelId:string;chatId:string;messageId:string}

export type RouterDeps={
 /** teloaWork 子集。 */
 work:{invoke(endpoint:string,payload:unknown,signal:AbortSignal):Promise<unknown>}
 sessionController:Pick<SessionController,'prompt'|'cancel'>
 bindings:ReturnType<typeof createBindingStore>
 requestId:typeof imRequestId
 /** 渠道显示名（Telegram／Slack／飞书），用于注入正文的来源行。 */
 label:(channelId:string)=>string
 /** 插件释放时中止：在途与后续 invoke、prompt 一并取消。 */
 signal?:AbortSignal
 /** 向宿主登记 IM 发起的会话（终审 I-3）：宿主据此拒绝该会话调用只允许在工作台确认的工具。 */
 markImSession?:(sessionId:string)=>void
}

type Role={id:string;name:string;version:number}

const titleMax=200
const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const stateLabels:Record<string,string>={ready:'待开始',running:'进行中',paused:'已暂停',waiting:'待确认',blocked:'受阻',completed:'已完成',cancelled:'已取消'}

export function createRouter(deps:RouterDeps){
 const signal=()=>deps.signal??new AbortController().signal
 const invoke=(endpoint:string,payload:unknown)=>deps.work.invoke(endpoint,payload,signal())
 const title=(binding:ImBinding)=>`IM 私聊 · ${binding.displayName}`.slice(0,titleMax)

 /** 会话已登记且就绪（conversations/read 对未绑定、未就绪一律抛错）。 */
 const isReady=async(sessionId:string|undefined):Promise<boolean>=>{
  if(sessionId===undefined)return false
  try{const row=await invoke('conversations/read',{sessionId});return isRecord(row)&&row.status==='ready'}
  catch{return false}
 }
 const create=async(payload:Record<string,unknown>):Promise<string>=>{
  const row=await invoke('conversations/create',payload)
  if(!isRecord(row)||typeof row.sessionId!=='string')throw new WorkError('teloa/dependency-unavailable','会话创建未返回会话身份。')
  return row.sessionId
 }
 const listRoles=async():Promise<Role[]>=>{
  const rows=await invoke('roles/list',{})
  if(!Array.isArray(rows))return []
  return rows.flatMap(row=>isRecord(row)&&typeof row.id==='string'&&row.state!=='retired'?[{id:row.id,name:String(row.name??''),version:Number(row.version)}]:[])
 }

 /** fresh：/new 新开，不复用已登记的旧会话。 */
 const ensure=async(binding:ImBinding,source:ImSource,fresh:boolean):Promise<{sessionId:string;label:string}>=>{
  const result=await pick(binding,source,fresh)
  deps.markImSession?.(result.sessionId)
  return result
 }
 const pick=async(binding:ImBinding,source:ImSource,fresh:boolean):Promise<{sessionId:string;label:string}>=>{
  const {channelId,imUserId}=binding
  const id=(step:string)=>deps.requestId(source.channelId,source.chatId,source.messageId,step)
  if(binding.target.kind==='assistant'){
   if(!fresh&&await isReady(binding.assistantSessionId))return {sessionId:binding.assistantSessionId!,label:'助理'}
   const sessionId=await create({requestId:id('conv'),title:title(binding)})
   await deps.bindings.change(channelId,imUserId,{assistantSessionId:sessionId})
   return {sessionId,label:'助理'}
  }
  const roleId=binding.target.roleId
  const role=(await listRoles()).find(row=>row.id===roleId)
  if(!role)throw new WorkError('teloa/not-found','默认同事已不存在，请用 /同事 重新选择。')
  const remember=async(sessionId:string)=>{
   await deps.bindings.change(channelId,imUserId,{roleSessionIds:{...binding.roleSessionIds,[roleId]:sessionId}})
   return {sessionId,label:role.name}
  }
  // 只复用本绑定自己的同事会话：工作台里已关联的会话不接管（否则工作台对话会外发到 IM、两个 IM 绑定会串线）。
  const known=binding.roleSessionIds?.[roleId]
  if(!fresh&&await isReady(known))return {sessionId:known!,label:role.name}
  const sessionId=await create({requestId:id('conv'),title:title(binding),roleId})
  await invoke('object-conversations/change',{requestId:id('link'),kind:'role',objectId:roleId,expectedObjectVersion:role.version,sessionId,expectedLinkVersion:0,action:'link'})
  return remember(sessionId)
 }

 return {
  ensureTargetSession:(binding:ImBinding,source:ImSource)=>ensure(binding,source,false),
  async newSession(binding:ImBinding,source:ImSource):Promise<string>{
   return (await ensure(binding,source,true)).sessionId
  },
  async prompt(sessionId:string,text:string,source:ImSource):Promise<void>{
   const request:SessionPromptRequest={
    requestId:deps.requestId(source.channelId,source.chatId,source.messageId,'prompt') as SessionRequestId,
    sessionId:sessionId as SessionId,
    mode:'queue',
    content:[{type:'text',text:`（来自 IM：${deps.label(source.channelId)}）\n${text}`}],
   }
   await deps.sessionController.prompt(request,signal())
  },
  stop(sessionId:string):{accepted:true}{
   return deps.sessionController.cancel({sessionId} as Parameters<SessionController['cancel']>[0])
  },
  listRoles,
  /** 群发言：一期只传 requestId/groupId/expectedVersion/text/mentions 五键；路由由宿主 send 内的 route 端口触发。回协作群消息 id 与发送时刻（回包不全时为 undefined）。 */
  async sendGroup(group:ImGroupBinding,text:string,mentions:readonly {roleId:string;expectedVersion:number}[],source:ImSource):Promise<{messageId:string;since:string}|undefined>{
   const detail=await invoke('groups/get',{groupId:group.groupId})
   const expectedVersion=isRecord(detail)&&isRecord(detail.group)?detail.group.version:undefined
   if(typeof expectedVersion!=='number')throw new WorkError('teloa/dependency-unavailable','群详情未返回版本。')
   const unique=[...new Map(mentions.map(m=>[m.roleId,{roleId:m.roleId,expectedVersion:m.expectedVersion}])).values()].slice(0,8)
   const sent=await invoke('groups/messages/send',{requestId:deps.requestId(source.channelId,source.chatId,source.messageId,'group'),groupId:group.groupId,expectedVersion,text,mentions:unique})
   return isRecord(sent)&&typeof sent.id==='string'&&typeof sent.createdAt==='string'?{messageId:sent.id,since:sent.createdAt}:undefined
  },
  /**
   * 由某条协作群消息派生的同事运行会话：tasks/list 取本协作群或未挂群（群内直接回应建的任务 groupId 为 null，群只记在运行的 groupContext）、不早于该消息的任务 → task-runs/list，
   * 只认 groupContext 的协作群与来源消息都对得上的运行（群内路由为每位回应同事各建一条任务与运行）。
   */
  async groupRunSessions(trigger:{groupId:string;messageId:string;since:string}):Promise<{sessionId:string;name:string}[]>{
   const tasks=await invoke('tasks/list',{})
   const matched=(Array.isArray(tasks)?tasks:[]).flatMap(task=>isRecord(task)&&typeof task.id==='string'&&(task.groupId===trigger.groupId||task.groupId===null)&&typeof task.createdAt==='string'&&task.createdAt>=trigger.since?[{taskId:task.id,roleId:task.assigneeRoleId}]:[])
   const found:{sessionId:string;roleId:unknown}[]=[]
   for(const {taskId,roleId} of matched){
    const runs=await invoke('task-runs/list',{taskId})
    for(const run of Array.isArray(runs)?runs:[]){
     const context=isRecord(run)&&isRecord(run.groupContext)?run.groupContext:undefined
     if(context&&typeof run.sessionId==='string'&&context.groupId===trigger.groupId&&isRecord(context.source)&&context.source.messageId===trigger.messageId)found.push({sessionId:run.sessionId,roleId})
    }
   }
   if(!found.length)return []
   // 回发带同事名：按任务负责同事取名（含已退役，回复可能早于退役）；取不到名时回「同事」。
   const roles=await invoke('roles/list',{})
   const names=new Map((Array.isArray(roles)?roles:[]).flatMap(row=>isRecord(row)&&typeof row.id==='string'&&typeof row.name==='string'&&row.name?[[row.id,row.name] as const]:[]))
   return found.map(({sessionId,roleId})=>({sessionId,name:(typeof roleId==='string'?names.get(roleId):undefined)??'同事'}))
  },
  async tasksSummary():Promise<string>{
   const rows=await invoke('tasks/list',{})
   const lines=(Array.isArray(rows)?rows:[]).slice(0,10).flatMap(row=>isRecord(row)?[`[${stateLabels[String(row.state)]??String(row.state)}] ${String(row.title??'')}`]:[])
   return lines.length?lines.join('\n'):'暂无任务。'
  },
  async attentionSummary():Promise<string>{
   const [tasks,security]=await Promise.all([invoke('tasks/attention',{}),invoke('security-actions/attention',{})])
   const taskCount=isRecord(tasks)&&Array.isArray(tasks.items)?tasks.items.filter(item=>isRecord(item)&&item.attention!==null).length:0
   const securityCount=Array.isArray(security)?security.length:0
   return `需要你处理：任务 ${taskCount} 项，安全动作 ${securityCount} 项。请到工作台处理。`
  },
 }
}

export type ImRouter=ReturnType<typeof createRouter>
