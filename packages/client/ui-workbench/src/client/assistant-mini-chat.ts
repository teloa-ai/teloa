import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionId} from '@deepseek-ai/dsh-session/types'
import type {SessionEventLikeEntry,SessionSnapshot} from '@deepseek-ai/dsh-api-session-controller/client'
import {nativeArtifactMessages} from './native-artifact-api.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {interface SessionReferenceSourceMap {assistantMiniChat:unknown}}
type Source<T>={getSnapshot():T;subscribe(listener:()=>void):()=>void}
type Block={readonly type:string;readonly text?:string}
type QueuedMessage={readonly id:string;readonly source:{readonly kind:string};readonly content:readonly Block[]}
type ChatState=Pick<SessionSnapshot,'sessionId'|'pendingSubmissions'|'running'|'removed'|'openState'|'loadingOlder'|'lastAgentError'|'subagent'>
/** 只使用 DSH 公开 ISession 动词；与原生输入框默认发送同一条 beginSubmission→prompt 链。 */
export type AssistantMiniChatBinding={
 readonly sessionId:SessionId
 readonly session:Source<ChatState>&{
  beginSubmission(input:{mode:'queue';text:string;attachments:readonly []}):{readonly requestId:string;abandon():void}
  prompt(content:{type:'text';text:string}[],mode:'queue',signal?:AbortSignal,requestId?:string):Promise<{readonly ok:boolean}>
  loadOlder():Promise<void>
 }
 readonly eventSource:Source<{readonly entries:readonly SessionEventLikeEntry[];readonly hasMore:boolean}>
 readonly ctx:unknown
}
type Reference<B>={readonly binding:B;readonly ready:Promise<B>;release():void}
export type AssistantMiniChatServices<B extends AssistantMiniChatBinding=AssistantMiniChatBinding>={
 sessions:{list:Source<{readonly phase:string;readonly ids:readonly string[]}>;binding(id:SessionId):B|undefined;retain(id:SessionId,options:{source:'assistantMiniChat'}):Reference<B>}
 connection:Source<string>
 /** 原生输入只读排队与打开完整会话时的草稿交接；不调用 setDraft/submit。 */
 input:{for(ctx:B['ctx']):{readonly state:Source<{readonly queue:readonly QueuedMessage[]}>};requestDraftInitialization(binding:B,options:{prompt:string}):'applied'|'preserved'|'blocked'}
 /** 原生输入框阻断原因同样阻断小窗发送，不绕开现有输入门禁。 */
 blocks:{storeFor(id:SessionId):Source<{readonly reason:string}|undefined>}
 /** 原助手会话不在主视图时，按原生输入同源的会话能力分类与权益单独核对；reason 为已本地化的阻断原因。 */
 capability:Source<{readonly sessionId:string|undefined;readonly status:string;readonly reason?:string|undefined}>&{select(id:string|undefined):void}
 status:Source<ReadonlyMap<SessionId,{readonly pendingInteraction?:unknown}>>
}
export type AssistantMiniChatMessage={readonly key:string;readonly role:'user'|'assistant';readonly text:string;readonly state:'sent'|'sending'|'queued'|'streaming'|'interrupted';readonly images:number}
export type AssistantMiniChatPhase='closed'|'checking'|'missing'|'offline'|'loading'|'ready'|'unavailable'
export type AssistantMiniChatSnapshot={
 readonly phase:AssistantMiniChatPhase
 readonly sessionId?:string
 readonly messages:readonly AssistantMiniChatMessage[]
 readonly running:boolean
 /** 原会话正等待审批或选择；在完整会话中处理，小窗不代为决定。 */
 readonly waiting:boolean
 readonly hasMore:boolean
 readonly loadingOlder:boolean
 readonly block?:string
 readonly agentFailed:boolean
 readonly draft:string
 readonly sending:boolean
 readonly sendFailed:boolean
}
export type AssistantMiniChatHandoff='applied'|'preserved'|'blocked'|'unavailable'|'empty'
export type AssistantMiniChatPort={
 subscribe(listener:()=>void):()=>void
 getSnapshot():AssistantMiniChatSnapshot
 open():void
 /** 只释放小窗读取引用；不取消、不停止原会话工作。 */
 close():void
 setDraft(text:string):void
 send():Promise<boolean>
 loadOlder():Promise<void>
 /** 把小窗草稿交给同一原会话的原生输入；原生已有草稿时保留双方内容。 */
 handoffDraft():AssistantMiniChatHandoff
}
type Identity=Source<{readonly status:string;readonly sessionId?:string|undefined}>

const textOf=(content:readonly Block[])=>content.flatMap(block=>block.type==='text'&&typeof block.text==='string'?[block.text]:[]).join('\n')
const rpcOf=(source:object)=>'rpcId' in source&&typeof source.rpcId==='string'?source.rpcId:undefined

/** 原会话的持久消息、流式回复、本地回显与排队按原生顺序合成；工具卡留在完整会话。 */
export function projectAssistantMiniChatMessages(sessionId:string,entries:readonly SessionEventLikeEntry[],pending:ChatState['pendingSubmissions'],queue:readonly QueuedMessage[]):AssistantMiniChatMessage[]{
 const durable=nativeArtifactMessages(sessionId,entries),ids=new Set(durable.map(row=>row.messageId)),admitted=new Set<string>(),attempts=new Map<string,Map<number,string>>()
 for(const entry of entries){
  if(entry.type==='transient'){
   const {attemptId,chunk}=entry.event.data
   if(chunk.type!=='text-delta')continue
   const blocks=attempts.get(attemptId)??new Map<number,string>();blocks.set(chunk.index,(blocks.get(chunk.index)??'')+chunk.text);attempts.set(attemptId,blocks)
  }else if(entry.event.type==='user/message'&&entry.event.surfaceOp==='append'){const rpc=rpcOf(entry.event.data.source);if(rpc)admitted.add(rpc)}
 }
 const queued=queue.filter(item=>item.source.kind==='user'&&!ids.has(item.id))
 for(const item of queued){const rpc=rpcOf(item.source);if(rpc)admitted.add(rpc)}
 const rows:AssistantMiniChatMessage[]=durable.map(row=>({key:row.messageId+':'+row.seq,role:row.role,text:row.text,state:row.interrupted?'interrupted':'sent',images:row.images.length}))
 for(const [attemptId,blocks] of attempts){const text=[...blocks.entries()].sort(([a],[b])=>a-b).map(([,value])=>value).join('\n\n');if(text.trim())rows.push({key:'live:'+attemptId,role:'assistant',text,state:'streaming',images:0})}
 const echoes=pending.filter(row=>!admitted.has(row.requestId))
 for(const row of echoes)if(row.placement!=='queued')rows.push({key:'pending:'+row.requestId,role:'user',text:row.text,state:'sending',images:row.attachments.length})
 for(const row of echoes)if(row.placement==='queued')rows.push({key:'pending:'+row.requestId,role:'user',text:row.text,state:'queued',images:row.attachments.length})
 for(const item of queued)rows.push({key:'queue:'+item.id,role:'user',text:textOf(item.content),state:'queued',images:item.content.filter(block=>block.type==='image').length})
 return rows
}

/**
 * 小松鼠小窗的原主聊桥接：身份只取已核验的助手会话，读取用独立引用，发送复用原生会话宿主。
 * 不选中会话、不新建助手或会话、不改变原生输入框草稿。
 */
export function createAssistantMiniChat(identity:Identity){
 const listeners=new Set<()=>void>(),drafts=new Map<string,string>()
 let services:AssistantMiniChatServices|undefined,reference:Reference<AssistantMiniChatBinding>|undefined,queue:Source<{readonly queue:readonly QueuedMessage[]}>|undefined
 let opened=false,ready=false,openFailed=false,sending=false,sendFailed=false,selected:string|undefined,epoch=0,syncing=false,offBinding:(()=>void)[]=[]
 const empty={messages:[],running:false,waiting:false,hasMore:false,loadingOlder:false,agentFailed:false}
 let snapshot:AssistantMiniChatSnapshot={...empty,phase:'closed',draft:'',sending:false,sendFailed:false}
 const publish=(next:AssistantMiniChatSnapshot)=>{snapshot=next;for(const listener of [...listeners])listener()}
 const current=()=>{
  const id=selected,binding=reference?.binding
  return id&&services&&binding&&ready&&services.sessions.binding(brandString<SessionId>(id))===binding?{id,binding,services}:undefined
 }
 const clearBinding=()=>{epoch++;for(const off of offBinding)off();offBinding=[];if(reference)services?.capability.select(undefined);reference?.release();reference=undefined;queue=undefined;ready=false}
 const read=()=>{
  const id=selected,base={...empty,draft:id?drafts.get(id)??'':'',sending,sendFailed,...(id?{sessionId:id}:{})}
  if(!opened){publish({...base,phase:'closed'});return}
  if(!id){publish({...base,phase:identity.getSnapshot().status==='idle'?'missing':'checking'});return}
  if(!services||services.connection.getSnapshot()!=='connected'){publish({...base,phase:'offline'});return}
  const list=services.sessions.list.getSnapshot()
  if(openFailed||list.phase==='ready'&&!list.ids.includes(id)){publish({...base,phase:'unavailable'});return}
  const live=current()
  if(list.phase!=='ready'||!live){publish({...base,phase:'loading'});return}
  const state=live.binding.session.getSnapshot()
  if(state.sessionId!==id||live.binding.sessionId!==id||state.removed||state.subagent!==null||state.openState==='error'){publish({...base,phase:'unavailable'});return}
  const gate=live.services.capability.getSnapshot()
  // 能力分类尚未针对本会话给出结论前不呈现可发送状态。
  if(state.openState!=='open'||gate.sessionId!==id||gate.status==='idle'){publish({...base,phase:'loading'});return}
  const window=live.binding.eventSource.getSnapshot(),sid=brandString<SessionId>(id),block=live.services.blocks.storeFor(sid).getSnapshot()?.reason??gate.reason
  publish({...base,phase:'ready',
   messages:projectAssistantMiniChatMessages(id,window.entries,state.pendingSubmissions,queue?.getSnapshot().queue??[]),
   running:state.running,waiting:live.services.status.getSnapshot().get(sid)?.pendingInteraction!==undefined,
   hasMore:window.hasMore,loadingOlder:state.loadingOlder,agentFailed:!state.running&&!!state.lastAgentError,...(block?{block}:{})})
 }
 const sync=()=>{
  if(syncing)return
  syncing=true
  try{
   const id=identity.getSnapshot().sessionId
   if(id!==selected){clearBinding();selected=id;sendFailed=false;openFailed=false}
   const list=services?.sessions.list.getSnapshot()
   // 发送进行中保留引用直到宿主回执；关闭只影响读取。
   if(!(opened||sending)||!id||!services||openFailed||services.connection.getSnapshot()!=='connected'||list?.phase!=='ready'||!list.ids.includes(id)){clearBinding();read();return}
   const sid=brandString<SessionId>(id)
   if(reference&&services.sessions.binding(sid)===reference.binding){read();return}
   clearBinding()
   const token=epoch,owner=services,next=owner.sessions.retain(sid,{source:'assistantMiniChat'})
   reference=next;offBinding=[next.binding.session.subscribe(sync),next.binding.eventSource.subscribe(sync),owner.blocks.storeFor(sid).subscribe(sync)];owner.capability.select(id);read()
   void next.ready.then(binding=>{
    if(token!==epoch||reference!==next||services!==owner||owner.sessions.binding(sid)!==binding||binding!==next.binding)return
    try{queue=owner.input.for(binding.ctx).state;offBinding.push(queue.subscribe(sync))}catch{queue=undefined}
    ready=true;read()
   },()=>{if(token===epoch&&reference===next){clearBinding();openFailed=true;read()}})
  }catch{clearBinding();read()}finally{syncing=false}
 }
 const port:AssistantMiniChatPort={
  subscribe:listener=>{listeners.add(listener);return()=>{listeners.delete(listener)}},
  getSnapshot:()=>snapshot,
  open:()=>{opened=true;if(openFailed){openFailed=false;clearBinding()}sync()},
  close:()=>{opened=false;sync()},
  setDraft:text=>{if(!selected||sending)return;if(text)drafts.set(selected,text);else drafts.delete(selected);read()},
  async send(){
   const live=current(),text=live?(drafts.get(live.id)??'').trim():''
   if(!live||!text||sending||snapshot.phase!=='ready'||snapshot.block)return false
   const {id,binding}=live
   sending=true;sendFailed=false;read()
   let ok=false
   try{
    const handle=binding.session.beginSubmission({mode:'queue',text,attachments:[]})
    try{ok=(await binding.session.prompt([{type:'text',text}],'queue',undefined,handle.requestId)).ok}catch{handle.abandon()}
   }catch{ok=false}
   sending=false
   // 发送期间输入锁定；只有宿主接纳后才清空小窗草稿，失败保留原文。
   if(ok)drafts.delete(id);else sendFailed=selected===id
   sync()
   return ok
  },
  async loadOlder(){
   const live=current()
   if(!live||snapshot.phase!=='ready'||!snapshot.hasMore||snapshot.loadingOlder)return
   try{await live.binding.session.loadOlder()}catch{/* 失败由原生 loadingOlder/openState 呈现。 */}
  },
  handoffDraft(){
   const id=selected,text=id?drafts.get(id)??'':''
   if(!text.trim())return 'empty'
   const live=current()
   if(!live||sending)return 'unavailable'
   try{
    const result=live.services.input.requestDraftInitialization(live.binding,{prompt:text})
    if(result==='applied'){drafts.delete(live.id);read()}
    return result
   }catch{return 'unavailable'}
  },
 }
 return {...port,
  /** 由持有 DSH 会话服务的子上下文挂接；返回值在上下文释放时调用。 */
  attach<B extends AssistantMiniChatBinding>(next:AssistantMiniChatServices<B>){
   clearBinding();services=next as unknown as AssistantMiniChatServices
   const off=[identity.subscribe(sync),next.sessions.list.subscribe(sync),next.connection.subscribe(sync),next.status.subscribe(sync),next.capability.subscribe(sync)]
   sync()
   return()=>{for(const dispose of off)dispose();if(services===(next as unknown as AssistantMiniChatServices)){clearBinding();services=undefined;read()}}
  },
 }
}
export type AssistantMiniChat=ReturnType<typeof createAssistantMiniChat>
