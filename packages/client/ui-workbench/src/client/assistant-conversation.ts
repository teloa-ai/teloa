import type {Conversation} from '@teloa/contract'
import type {HomeContextApi,HomeWorkContext} from './home-native-controller.js'
import type {WorkbenchNavigationStorage} from './workbench-navigation-state.js'

export const assistantConversationTitle='Teloa 小松鼠助手'
export const assistantConversationKey='teloa.personal-assistant-session/v1'
const creationKey='teloa.personal-assistant-creation/v1'
type AssistantCreation={requestId:string;workspaceId?:string}
export function pendingAssistantCreation(storage:WorkbenchNavigationStorage):AssistantCreation|undefined{
 const value=storage.getItem(creationKey)
 if(!value)return
 const row=JSON.parse(value) as AssistantCreation
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(row.requestId)||row.workspaceId!==undefined&&typeof row.workspaceId!=='string')throw Error('助手创建记录无法读取，请核对浏览器存储后重试。')
 return row
}
export function beginAssistantCreation(storage:WorkbenchNavigationStorage,workspaceId:string|undefined):AssistantCreation{
 const pending=pendingAssistantCreation(storage)
 if(pending&&pending.workspaceId!==workspaceId)throw Error('助手创建仍待恢复，请使用原工作区重试。')
 const request=pending??{requestId:crypto.randomUUID(),...(workspaceId===undefined?{}:{workspaceId})}
 storage.setItem(creationKey,JSON.stringify(request))
 if(pendingAssistantCreation(storage)?.requestId!==request.requestId)throw Error('助手创建记录未保存，请重试。')
 return request
}
const unavailable=()=>Error('助手原会话已归档或范围发生变化，请到会话目录核对原会话。')
const personal=(row:HomeWorkContext|null,id:string)=>row?.sessionId===id&&row.scopeId==='general'&&row.roleId===null

/** 不以当前选中的会话作为个人助理；目录与上下文都必须来自同一本人宿主。 */
export async function findAssistantConversation({storage,conversations,archived,read}:{storage:WorkbenchNavigationStorage;conversations:readonly Conversation[];archived:readonly string[];read:HomeContextApi['read']}):Promise<Conversation|undefined>{
 const canonical=conversations.find(row=>row.purpose==='assistant')
 if(canonical){
  if(canonical.status==='pending')return undefined
  const context=await read(canonical.sessionId)
  if(canonical.status!=='ready'||archived.includes(canonical.sessionId)||context!==null&&!personal(context,canonical.sessionId))throw unavailable()
  storage.setItem(assistantConversationKey,canonical.sessionId)
  return canonical
 }
 const saved=storage.getItem(assistantConversationKey)
 if(saved){
  const row=conversations.find(value=>value.sessionId===saved)
  if(!row||row.status!=='ready'||row.purpose==='task-run'||archived.includes(saved)||!personal(await read(saved),saved))throw unavailable()
  return row
 }
 // 新标签页可从原目录认回已创建的助理，不再制造一套历史。
 for(const row of [...conversations].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))){
  if(row.title!==assistantConversationTitle||row.status!=='ready'||row.purpose==='task-run'||archived.includes(row.sessionId))continue
  if(personal(await read(row.sessionId),row.sessionId)){storage.setItem(assistantConversationKey,row.sessionId);return row}
 }
 return undefined
}

/** 创建回包可能未知：复用 BindingClient 原 requestId，只在上下文回执核实后登记。 */
export async function rememberAssistantConversation(row:Conversation,storage:WorkbenchNavigationStorage,api:Pick<HomeContextApi,'read'|'set'>):Promise<void>{
 if(row.status!=='ready'||row.purpose==='task-run')throw unavailable()
 const existing=await api.read(row.sessionId)
 const context=existing??await api.set({sessionId:row.sessionId,scopeId:'general',roleId:null,expectedVersion:0})
 if(!personal(context,row.sessionId))throw unavailable()
 storage.setItem(assistantConversationKey,row.sessionId)
 if(row.purpose==='assistant'){storage.removeItem(creationKey);return}
 const pending=pendingAssistantCreation(storage)
 if(pending?.requestId===row.requestId)storage.removeItem(creationKey)
}
