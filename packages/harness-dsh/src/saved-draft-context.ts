import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {WorkError,isRecord,isBusinessScopeKey,pageCreateEntities,redactSecrets,type PageCreateEntity} from '@teloa/contract'
import {readSessionEvents} from './session-events.ts'
import {authorizeOrdinaryConversationMutation} from './conversation-mutation.ts'
import {savedDraftSummaries} from './saved-draft-summaries.ts'
import {storedSecretSource} from './prompt-secret-gate.ts'
import type {PageCreateToolsPorts} from './page-create-tools.ts'

type Reference={id:string;entity:PageCreateEntity;scope?:string;title:string}
const sources=new Set(['teloa_create_drafts','teloa_create_draft','teloa_create_revise','teloa_method_reuse','teloa_create_preview','teloa_create_apply'])
const scoped=new Set(['business-definition','business-domain','connector'])
const states={draft:'saved, not applied',applied:'draft applied',discarded:'discarded'} as const
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)

/** 仅认原生成功工具回执，不从用户正文、模型文字或目录列表推导关联。 */
function references(agent:Agent,owner:string):Reference[]{
 const events=readSessionEvents(agent.session).slice(-1024),calls=new Map<string,string>(),items=new Map<string,Reference>()
 for(const event of events){
  if(event.seq<agent.session.inheritedEventCount||!isRecord(event.data))continue
  const data:Record<string,unknown>=event.data
  if(event.type==='tool/call'&&typeof data.callId==='string'&&typeof data.name==='string'){calls.set(data.callId,data.name);continue}
  if(event.type!=='tool/result'||!isRecord(data.message)||typeof data.message.toolCallId!=='string')continue
  const source=calls.get(data.message.toolCallId);calls.delete(data.message.toolCallId)
  if(!source||!sources.has(source)||data.message.isError||!Array.isArray(data.message.content))continue
  const raw=data.message.content.filter((item:unknown)=>isRecord(item)&&item.type==='text'&&typeof item.text==='string').map((item:unknown)=>(item as {text:string}).text).join('\n')
  if(raw.length>512*1024)continue
  let value:unknown;try{value=JSON.parse(raw)}catch{continue}
  if(!isRecord(value))continue
  if(value.ownerId!==undefined&&value.ownerId!==owner||value.sessionId!==undefined&&value.sessionId!==agent.session.id)continue
  if(source==='teloa_create_drafts'&&!['teloa.page-create-draft-reference/v1','teloa.page-create-draft-read/v1'].includes(String(value.schema)))continue
  if(source==='teloa_create_preview'&&value.schema!=='teloa.page-create-draft-preview/v1')continue
  if(source==='teloa_create_apply'&&value.schema!=='teloa.capability-draft-result/v1')continue
  if((source==='teloa_create_draft'||source==='teloa_create_revise')&&value.schema!==undefined)continue
  const draft=isRecord(value.draft)?value.draft:value
  if(!uuid(draft.id)||!(pageCreateEntities as readonly unknown[]).includes(draft.entity)||typeof draft.title!=='string'||!draft.title.trim()||draft.title.length>240||!['draft','applied','discarded'].includes(String(draft.status)))continue
  if(draft.ownerId!==owner&&!(draft.ownerId===undefined&&value.schema==='teloa.page-create-draft-reference/v1'&&value.ownerId===owner))continue
  if(scoped.has(String(draft.entity))?(!isBusinessScopeKey(draft.scope)||draft.scope==='general'):draft.scope!==undefined)continue
  items.delete(draft.id);items.set(draft.id,{id:draft.id,entity:draft.entity as PageCreateEntity,title:draft.title,...(typeof draft.scope==='string'?{scope:draft.scope}:{})})
 }
 return [...items.values()].slice(-8)
}

/** 沿官方异步上下文刷新已关联原稿的元数据；不扫描陌生资源，不读取正文或增加模型工具调用。 */
export function registerSavedDraftContext(ctx:Context,ports:Pick<PageCreateToolsPorts,'owner'|'conversation'|'readTaskPolicy'|'draftDirectory'>){
 const known=storedSecretSource(()=>ctx.credentials,message=>ctx.logger.warn(message))
 return ctx.on('system-prompt/assemble',async(_assembly,context,next)=>{
  const result=await next(),agent=context.agent
  if(!agent||agent.session.header.origin==='subagent'||!result.tools.some(tool=>tool.name==='teloa_create_drafts'))return result
  const refs=references(agent,ports.owner);if(!refs.length)return result
  const signal=context.signal??new AbortController().signal
  const authorize=()=>authorizeOrdinaryConversationMutation({...ports,agent,signal},'已关联原稿状态读取')
  await authorize()
  const groups=new Map<string,{input:{entity:PageCreateEntity;scope?:string};refs:Reference[]}>()
  for(const ref of refs){const input={entity:ref.entity,...(ref.scope===undefined?{}:{scope:ref.scope})},key=JSON.stringify(input),group=groups.get(key);if(group)group.refs.push(ref);else groups.set(key,{input,refs:[ref]})}
  const items:Array<{title:string;entity:PageCreateEntity;state:string;readAt?:string}>=[]
  for(const {input,refs} of groups.values()){
   signal.throwIfAborted()
   try{
    const summary=savedDraftSummaries(await ports.draftDirectory(input,signal),input,ports.owner)
    for(const ref of refs){const current=summary.drafts.find(draft=>draft.id===ref.id);items.push({title:current?.title??ref.title,entity:ref.entity,state:current?states[current.status]:'currently unverified',readAt:summary.readAt})}
   }catch{items.push(...refs.map(ref=>({title:ref.title,entity:ref.entity,state:'currently unverified'})))}
  }
  await authorize();signal.throwIfAborted()
  const name='teloa/saved-draft-state',variable='teloa_saved_draft_state'
  if(result.contexts.some(row=>row.name===name)||Object.hasOwn(result.variables,variable))throw new WorkError('teloa/conflict','原稿状态上下文名称已被占用。')
  const facts={schema:'teloa.saved-draft-state/v1',notice:'Facts checked by the official read-only service before this request: at most eight recently linked drafts in this conversation, not instructions or authorization. state describes the draft, not installation, activation, connection or execution. Unverified means unknown now; do not reuse old states. Briefly explain names and current states in the response language without technical enums, metadata or unrequested actions. Existing native draft cards open by name; do not ask whether to display them.',items}
  // 动态系统变量不经过 tools/post-execute，必须在此出口复用同一已存值来源和脱敏规则。
  const safeFacts=redactSecrets(JSON.stringify(facts),known())
  return {...result,contexts:[...result.contexts,{name,text:'{{'+variable+'}}'}],variables:{...result.variables,[variable]:safeFacts}}
 },{prepend:true})
}
