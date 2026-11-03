import {createHash} from 'node:crypto'
import {SessionId} from '@deepseek-ai/dsh-session'
import {SessionPersistenceNotFoundError,type SessionPersistence} from '@deepseek-ai/dsh-session-persistence'
import type {HostConnectionHandle} from '@deepseek-ai/dsh-client-connection'

export const SESSION_DIAGNOSTIC_PATH='/api/teloa/session-diagnostic'
export const SESSION_DIAGNOSTIC_SCHEMA='teloa.session-diagnostic/v1'
type Row=Record<string,unknown>
type LineageNode={session:{header:unknown};descendants:readonly LineageNode[]}
export type SessionDiagnosticQuery={traceSession:(id:SessionId,signal?:AbortSignal)=>Promise<{target:{header:unknown};complete:boolean;descendants:readonly LineageNode[]}>}
export type SessionDiagnosticPorts={
 authorizeRoot:(id:string,signal:AbortSignal)=>Promise<void|{conversationId?:unknown;requestId?:unknown;taskId?:unknown;roleId?:unknown;runId?:unknown;nativeRequestId?:unknown}>
 flush:(id:string,signal:AbortSignal)=>Promise<void>
 persistence:Pick<SessionPersistence,'open'>
 query:SessionDiagnosticQuery|undefined
 toolNames?:ReadonlySet<string>
 limits?:{events?:number;sessions?:number;bytes?:number}
}
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const nativeSessionId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const sha256=/^[a-f0-9]{64}$/
const record=(value:unknown):Row|undefined=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Row:undefined
const integer=(value:unknown):number|undefined=>Number.isSafeInteger(value)&&Number(value)>=0?Number(value):undefined
const id=(value:unknown):string|undefined=>typeof value!=='string'||!value||value.length>256?undefined:uuid.test(value)?value:'sha256:'+createHash('sha256').update(value).digest('hex')
const eventTypes=new Set(['turn/start','turn/end','step/start','step/end','user/message','developer/message','system/message','assistant/message','assistant/attempt','tool/call','tool/result','request/context','request/header','session/end-seed','approval/asked','approval/decided','agent/inbox/spliced'])
const states=new Set(['pending','queued','running','started','completed','complete','failed','cancelled','canceled','stopped','blocked','waiting','ready','accepted','rejected','approved','denied','error','aborted','ended','succeeded','unknown','start','end'])
const rootCorrelationKeys=['conversationId','requestId','taskId','roleId','runId','nativeRequestId'] as const
const numericKeys=['turn','step','attempt','version','taskVersion','roleVersion','sourceSeq','headerSeq'] as const
const mimeTypes=new Set(['text/plain','text/markdown','application/pdf','application/json','image/png','image/jpeg','image/webp','image/gif'])
const failure=(code:string)=>Object.assign(Error(),{code})

/** 只读取已知结构位置；未知对象、正文、参数、结果、路径和异常一律不复制。 */
export function diagnosticEvent(value:unknown,sessionId:string,toolNames:ReadonlySet<string>=new Set()):Row{
 const event=record(value)??{},known=typeof event.type==='string'&&eventTypes.has(event.type)
 const result:Row={kind:'event',sessionId,type:known?event.type:'unknown'}
 const seq=integer(event.seq),timestamp=integer(event.time)
 if(seq!==undefined)result.seq=seq
 if(timestamp!==undefined)result.time=timestamp
 if(!known){result.payload='omitted';return result}
 const data=record(event.data)??{},correlation:Row={},numbers:Row={}
 if(Array.isArray(event.sourceEventSeqs)){result.sourceEventSeqs=event.sourceEventSeqs.slice(0,64).filter(value=>integer(value)!==undefined);if(event.sourceEventSeqs.length>64)result.sourceEventsLimited=true}
 const preserve=(key:string,value:unknown)=>{const safe=id(value);if(safe!==undefined)correlation[key]=safe}
 const messages:Row[]=[]
 const message=(value:unknown,label:string)=>{
  const entry=record(value);if(!entry)return
  messages.push(entry);preserve(label+'.id',entry.id)
  const source=record(entry.source)
  if(source?.kind==='user')preserve(label+'.source.rpcId',source.rpcId)
  if(source?.kind==='tool')preserve(label+'.source.callId',source.callId)
  if(event.type==='tool/result')preserve(label+'.toolCallId',entry.toolCallId)
 }
 if(event.type==='user/message')message(data,'message')
 else if(['assistant/message','developer/message','system/message','tool/result'].includes(String(event.type)))message(data.message,'message')
 else if(event.type==='agent/inbox/spliced'&&Array.isArray(data.inserted)){if(data.inserted.length>32)result.messageIdentitiesLimited=true;for(const [index,value] of data.inserted.slice(0,32).entries())message(value,'inserted.'+index)}
 if(event.type==='tool/call'){
  preserve('callId',data.callId)
  const name=data.name
  if(typeof name==='string'&&/^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/.test(name)&&toolNames.has(name))result.toolName=name
  else result.toolName='omitted'
 }
 if(event.type==='approval/asked'||event.type==='approval/decided')preserve('approvalId',data.id)
 for(const key of numericKeys){const safe=integer(data[key]);if(safe!==undefined)numbers[key]=safe}
 if(Object.keys(correlation).length)result.correlation=correlation
 if(Object.keys(numbers).length)result.position=numbers
 const state:Row={}
 for(const key of ['state','status','phase','reason'] as const)if(typeof data[key]==='string'&&states.has(data[key]))state[key]=data[key]
 if(Object.keys(state).length)result.state=state
 if(event.type==='tool/result'){
  const message=record(data.message)
  if(message)result.outcome=message.isError===true?'failed':message.isError===undefined||message.isError===false?'completed':'unknown'
 }
 if(event.type==='assistant/message'&&data.interrupted===true)result.interrupted=true
 const attachments:Row[]=[]
 for(const message of messages){
  const content=message.content
  if(!Array.isArray(content))continue
  if(content.length>64)result.attachmentDescriptorsLimited=true
  for(const value of content.slice(0,64)){
   const block=record(value)
   if(block?.type!=='image'&&block?.type!=='file')continue
   if(attachments.length===8){result.attachmentDescriptorsLimited=true;break}
   const ref=record(block.ref)??block,descriptor:Row={kind:block.type,name:'omitted',body:'not-read'}
   const bytes=integer(ref.bytes);if(bytes!==undefined)descriptor.bytes=bytes
   if(typeof ref.sha256==='string'&&sha256.test(ref.sha256))descriptor.sha256=ref.sha256
   if(typeof ref.mime==='string'&&mimeTypes.has(ref.mime))descriptor.mime=ref.mime
   attachments.push(descriptor)
  }
 }
 if(attachments.length)result.attachments=attachments
 result.payload='omitted'
 return result
}

function limitsOf(value:SessionDiagnosticPorts['limits']){
 const bounded=(value:number|undefined,fallback:number,min:number,max:number)=>value===undefined?fallback:Number.isSafeInteger(value)&&value>=min&&value<=max?value:(()=>{throw failure('invalid-limit')})()
 return {events:bounded(value?.events,10000,1,10000),sessions:bounded(value?.sessions,64,1,64),bytes:bounded(value?.bytes,2*1024*1024,4096,2*1024*1024)}
}
const diagnosticHeaders=(sessionId:string)=>({'content-type':'application/x-ndjson; charset=utf-8','content-disposition':`attachment; filename="teloa-session-diagnostic-${sessionId}.ndjson"`,'cache-control':'no-store','x-content-type-options':'nosniff'})
const errorResponse=(status:number,code:string)=>new Response(JSON.stringify({error:code}),{status,headers:{'content-type':'application/json','cache-control':'no-store'}})

/** 仅挂载在 Connection 的 owner-only Fetch registry；不另开 HTTP 公开路径。 */
export function registerSessionDiagnosticExport(connection:Pick<HostConnectionHandle,'fetch'>,ports:SessionDiagnosticPorts):()=>Promise<void>{
 return connection.fetch.register({path:SESSION_DIAGNOSTIC_PATH,methods:['GET','HEAD'],requestBody:'buffered',fetch:request=>createSessionDiagnosticResponse(ports,request)})
}

export async function createSessionDiagnosticResponse(ports:SessionDiagnosticPorts,request:Request):Promise<Response>{
 request.signal.throwIfAborted()
 if(!['GET','HEAD'].includes(request.method))return errorResponse(405,'method-not-allowed')
 const params=new URL(request.url).searchParams,requestedRoot=params.get('sessionId')
 if(!requestedRoot||!nativeSessionId(requestedRoot)||params.getAll('sessionId').length!==1||[...params.keys()].some(key=>key!=='sessionId'))return errorResponse(400,'invalid-request')
 const root=requestedRoot
 const signalController=new AbortController(),signal=signalController.signal
 const abort=()=>signalController.abort(request.signal.reason)
 request.signal.addEventListener('abort',abort,{once:true})
 const handles=new Set<Awaited<ReturnType<SessionPersistence['open']>>>()
 const close=async(handle:Awaited<ReturnType<SessionPersistence['open']>>)=>{if(handles.delete(handle))await handle.close()}
 const closeAll=async()=>{for(const handle of [...handles])await close(handle);request.signal.removeEventListener('abort',abort)}
 try{
  const authorized=await ports.authorizeRoot(root,signal);signal.throwIfAborted()
  const correlation:Row={}
  for(const key of rootCorrelationKeys){const safe=id(record(authorized)?.[key]);if(safe!==undefined)correlation[key]=safe}
  if(request.method==='GET')await ports.flush(root,signal)
  const handle=await ports.persistence.open(SessionId(root),'read',{signal});handles.add(handle)
  signal.throwIfAborted()
  if(handle.header.id!==root||handle.header.origin==='subagent')throw failure('teloa/forbidden')
  if(request.method==='HEAD'){await closeAll();return new Response(null,{headers:diagnosticHeaders(root)})}
  if(!ports.query)throw failure('diagnostic/unavailable')
  const query=ports.query
  const lineage=await query.traceSession(SessionId(root),signal);signal.throwIfAborted()
  if(record(lineage.target.header)?.id!==root)throw failure('diagnostic/invalid-lineage')
  const limits=limitsOf(ports.limits),encoder=new TextEncoder(),reasons=new Set<string>(),toolNames=ports.toolNames??new Set<string>()
  if(!lineage.complete)reasons.add('lineage-partial')
  let bytes=0,sessions=0,events=0,unknownEvents=0,omittedBranches=0,lineageNodes=1,stopped=false
  const encode=(row:Row)=>encoder.encode(JSON.stringify(row)+'\n')
  const bounded=(row:Row)=>{
   const value=encode(row)
   // 为结尾的计数、限制与失败说明预留空间；达到上限时仍有可解析的终态。
   if(bytes+value.byteLength>limits.bytes-2048){reasons.add('byte-limit');stopped=true;return undefined}
   bytes+=value.byteLength;return value
  }
  async function* stored(idValue:string,expectedParent:string|undefined,existing?:typeof handle):AsyncGenerator<Uint8Array>{
   signal.throwIfAborted()
   if(sessions>=limits.sessions){reasons.add('session-limit');stopped=true;return}
   if(!nativeSessionId(idValue))throw failure('diagnostic/invalid-lineage')
   if(!existing)await ports.flush(idValue,signal)
   const stored=existing??await ports.persistence.open(SessionId(idValue),'read',{signal});handles.add(stored)
   try{
    signal.throwIfAborted()
    const header=stored.header
    if(header.id!==idValue||expectedParent!==undefined&&(header.origin!=='subagent'||header.parentSession!==expectedParent))throw failure('diagnostic/invalid-lineage')
    const row:Row={kind:'session',sessionId:idValue,origin:expectedParent===undefined?'root':'subagent'}
    const parent=nativeSessionId(header.parentSession)?header.parentSession:id(header.parentSession),createdAt=integer(header.createdAt),version=integer(header.version)
    if(parent)row.parentSessionId=parent
    if(createdAt!==undefined)row.createdAt=createdAt
    if(version!==undefined)row.version=version
    const line=bounded(row);if(!line)return;yield line;sessions++
    let offset=0
    for(;;){
     signal.throwIfAborted()
     const length=Math.min(128,limits.events-events+1),read=await stored.read(offset,length,{signal});signal.throwIfAborted()
     if(!read.events.length)break
     for(const source of read.events){
      if(events>=limits.events){reasons.add('event-limit');stopped=true;return}
      const event=diagnosticEvent(source,idValue,toolNames),line=bounded(event)
      if(!line)return
      if(event.type==='unknown')unknownEvents++
      events++;yield line
     }
     offset+=read.events.length
     if(read.events.length<length)break
    }
   }finally{await close(stored)}
  }
  const seen=new Set([root])
  async function* descendants(nodes:readonly LineageNode[],parent:string):AsyncGenerator<Uint8Array>{
   for(const node of nodes){
    signal.throwIfAborted();if(stopped)return
    if(lineageNodes>=limits.sessions){reasons.add('session-limit');stopped=true;return}
    lineageNodes++
    const header=record(node.session.header),child=header?.id
    if(!nativeSessionId(child)||seen.has(child))throw failure('diagnostic/invalid-lineage')
    seen.add(child)
    // 用户 fork 或查询中的其他分支不是本次授权子代理范围，不靠名字/事件引用接入。
    if(header?.origin!=='subagent'||header.parentSession!==parent){omittedBranches++;continue}
    yield* stored(child,parent)
    if(!stopped)yield* descendants(node.descendants,child)
   }
  }
  async function* lines():AsyncGenerator<Uint8Array>{
   try{
    const manifest=bounded({kind:'manifest',schema:SESSION_DIAGNOSTIC_SCHEMA,rootSessionId:root,correlation,scope:'root-and-authorized-subagents',limits,policy:{payloads:'omitted',paths:'omitted',attachmentBodies:'not-read',unknownIds:'sha256',toolNames:'registered-schema-only'}})
    if(manifest)yield manifest
    yield* stored(root,undefined,handle)
    if(!stopped)yield* descendants(lineage.descendants,root)
   }catch(error){signal.throwIfAborted();reasons.add('read-failed')}
   finally{await closeAll()}
   signal.throwIfAborted()
   const summary=encode({kind:'summary',schema:SESSION_DIAGNOSTIC_SCHEMA,complete:reasons.size===0,truncated:reasons.size>0,reasons:[...reasons],sessions,lineageNodes,events,unknownEvents,omittedBranches,attachmentBodyReads:0})
   if(bytes+summary.byteLength>limits.bytes)throw failure('diagnostic/output-limit')
   yield summary
  }
  const iterator=lines()
  const stream=new ReadableStream<Uint8Array>({
   async pull(controller){try{const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(next.value)}catch(error){await closeAll();controller.error(error)}},
   async cancel(reason){signalController.abort(reason);try{await iterator.return(undefined)}finally{await closeAll()}},
  },{highWaterMark:64*1024,size:chunk=>chunk.byteLength})
  return new Response(stream,{headers:diagnosticHeaders(root)})
 }catch(error){
  await closeAll();request.signal.throwIfAborted()
  const code=record(error)?.code
  if(code==='teloa/forbidden')return errorResponse(403,'forbidden')
  if(error instanceof SessionPersistenceNotFoundError||code==='teloa/not-found'||code==='teloa/not-bound'||code==='session/not-found')return errorResponse(404,'session-not-found')
  return errorResponse(code==='diagnostic/unavailable'?503:500,'diagnostic-unavailable')
 }
}
