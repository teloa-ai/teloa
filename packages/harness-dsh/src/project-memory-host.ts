import {createHash} from 'node:crypto'
import {combineWorkAccessLeases,ProjectMemoryExtractionService,type ProjectContextService,type ProjectRuntimeService,type ProjectExtractionEvent,type ProjectMemoryExtractionOptions,type ProjectMemoryExtractionPorts,type WorkBudgetService,type WorkAccessLease} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
type Pool=ProjectContextService['pool']
type PoolClient=Parameters<ProjectContextService['readInTransaction']>[0]

export type ProjectMemoryHostMessage={ownerId:string;sessionId:string;messageId:string;sequence:number;text:string;actor:'owner'|'assistant'|'runtime';available:boolean;projectId:string|null;bindingVersion:number;settingsVersion:number;memoryMode:'enabled'|'off';derivedSourceIds?:string[]}
export type ProjectMemoryContextSource={kind:'rule'|'memory'|'share'|'resource'|'personal'|'role';id:string;version:number;hash:string}
export type ProjectMemoryContextSourceStatus='available'|'revised'|'withdrawn'|'unavailable'
export type ProjectMemoryVerifiedEvidence={sourceId:string;ownerId:string;sessionId:string;messageId:string;receiptId:string;version:number;text:string;assertion:string;available:boolean;kind:'tool'|'artifact'}
export type ProjectMemoryHostOptions={owner:string;pool:Pool;identity:{id:()=>string;now:()=>string};runtime:ProjectRuntimeService;context:ProjectContextService;loadMessage:(owner:string,sessionId:string,messageId:string,db?:PoolClient)=>Promise<ProjectMemoryHostMessage|null>;loadVerifiedEvidence?:(owner:string,sourceId:string,db?:PoolClient)=>Promise<ProjectMemoryVerifiedEvidence|null>;entryAvailable?:(db:PoolClient,owner:string,input:{entryId:string;entryVersion:number})=>Promise<boolean>;contextSourceStatus?:(db:PoolClient,owner:string,source:ProjectMemoryContextSource,event:ProjectExtractionEvent)=>Promise<ProjectMemoryContextSourceStatus>;generateAuthorized:(event:ProjectExtractionEvent,signal?:AbortSignal)=>Promise<unknown>;beforePublish?:(event:ProjectExtractionEvent,signal?:AbortSignal)=>Promise<void>;resultCurrent?:(event:ProjectExtractionEvent)=>void;finished?:ProjectMemoryExtractionPorts['finished'];report?:(code:string)=>void;worker?:ProjectMemoryExtractionOptions&{pollMs?:number}}
const normalized=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('en-US')
const failureCode=(error:unknown)=>error instanceof WorkError?error.code:'teloa/unavailable'
const stableId=(value:unknown)=>{const h=createHash('sha256').update(JSON.stringify(value)).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`}
export const projectMemoryMessageSourceId=(message:Pick<ProjectMemoryHostMessage,'sessionId'|'messageId'|'sequence'>)=>JSON.stringify([message.sessionId,message.messageId,message.sequence])
export const projectMemoryContextSourceId=(source:ProjectMemoryContextSource)=>JSON.stringify(['project-context',source.kind,source.id,source.version,source.hash])
export function readProjectMemoryContextSource(value:string):ProjectMemoryContextSource|null{
 try{const row:unknown=JSON.parse(value);if(!Array.isArray(row)||row.length!==5||row[0]!=='project-context'||!['rule','memory','share','resource','personal','role'].includes(row[1])||typeof row[2]!=='string'||!row[2]||!Number.isSafeInteger(row[3])||row[3]<1||typeof row[4]!=='string'||!/^[a-f0-9]{64}$/.test(row[4]))return null;return {kind:row[1] as ProjectMemoryContextSource['kind'],id:row[2],version:row[3] as number,hash:row[4]}}catch{return null}
}
/** 返回修订失配与实际撤回的不同状态；固定分享核分享修订，不跟随源条目新值。 */
export async function projectMemoryContextSourceStatus(options:ProjectMemoryHostOptions,db:PoolClient,source:ProjectMemoryContextSource,event:ProjectExtractionEvent):Promise<ProjectMemoryContextSourceStatus>{
 const {owner,runtime,context}=options
 try{
  if(source.kind==='rule'||source.kind==='memory'){
   const row=(await db.query('select e.project_id,e.kind,e.state,e.version,r.hash from teloa_project_context_entries e join teloa_projects p on p.id=e.project_id and p.owner_id=$1 left join teloa_project_context_revisions r on r.entry_id=e.id and r.version=$3 where e.id=$2',[owner,source.id,source.version])).rows[0]
   if(!row||row.kind!==source.kind)return 'unavailable'
   await context.readInTransaction(db,owner,row.project_id)
   if(row.state==='withdrawn')return 'withdrawn'
   if(options.entryAvailable&&!await options.entryAvailable(db,owner,{entryId:source.id,entryVersion:source.version}))return 'unavailable'
   return row.version===source.version&&row.hash===source.hash?'available':'revised'
  }
  if(source.kind==='share'){
   const row=(await db.query('select s.*,e.state,r.hash from teloa_project_context_shares s join teloa_project_context_entries e on e.id=s.entry_id join teloa_project_context_revisions r on r.entry_id=s.entry_id and r.version=s.entry_version where s.id=$1',[source.id])).rows[0]
   if(!row)return 'unavailable'
   await context.readInTransaction(db,owner,row.source_project_id);await context.readInTransaction(db,owner,row.target_project_id)
   if(row.revoked||row.state==='withdrawn')return 'withdrawn'
   if(options.entryAvailable&&!await options.entryAvailable(db,owner,{entryId:row.entry_id,entryVersion:row.entry_version}))return 'unavailable'
   return row.entry_version===source.version&&row.hash===source.hash?'available':'revised'
  }
  if(source.kind==='personal'){
   const row=(await db.query('select version,state,markdown from teloa_personal_memory_entries where owner_id=$1 and id=$2',[owner,source.id])).rows[0]
   if(!row)return 'unavailable';if(row.state==='withdrawn')return 'withdrawn'
   return row.version===source.version&&createHash('sha256').update(row.markdown).digest('hex')===source.hash?'available':'revised'
  }
  const actor=await runtime.ports.inspect(owner,event.sessionId)
  if(source.kind==='resource'){
   const scopes=[actor.scope,...actor.scopes??[]],row=await runtime.ports.resource?.(db,owner,source.id,scopes)
   if(!row)return 'unavailable'
   return row.id===source.id&&row.version===source.version&&row.hash===source.hash?'available':'revised'
  }
  if(options.contextSourceStatus)return options.contextSourceStatus(db,owner,source,event)
  const role=(await runtime.ports.optionalMemories?.(db,owner,actor,'',false)??[]).find(row=>row.kind==='role'&&row.id===source.id)
  return !role?'unavailable':role.version===source.version&&role.hash===source.hash?'available':'revised'
 }catch(error){if(error instanceof WorkError&&['teloa/not-found','teloa/forbidden'].includes(error.code))return 'unavailable';throw error}
}
function sourceIdentity(value:string):{sessionId:string;messageId:string;sequence:number}|null{
 try{const row:unknown=JSON.parse(value);if(!Array.isArray(row)||row.length!==3||typeof row[0]!=='string'||typeof row[1]!=='string'||!Number.isSafeInteger(row[2])||row[2]<0)return null;return {sessionId:row[0],messageId:row[1],sequence:row[2] as number}}catch{return null}
}
function readable(owner:string,message:ProjectMemoryHostMessage|null):message is ProjectMemoryHostMessage{return !!message&&message.ownerId===owner&&message.available&&message.actor==='owner'&&Number.isSafeInteger(message.sequence)&&message.sequence>=0}
const verifiedKey=(source:ProjectMemoryVerifiedEvidence)=>JSON.stringify(['verified-result',source.sourceId,source.version,createHash('sha256').update(JSON.stringify([source.text,source.assertion,source.receiptId,source.kind])).digest('hex')])
function verifiedIdentity(value:string):string|null{try{const data:unknown=JSON.parse(value);return Array.isArray(data)&&data.length===4&&data[0]==='verified-result'&&typeof data[1]==='string'?data[1]:null}catch{return null}}
function verifiedEvidence(owner:string,message:ProjectMemoryHostMessage,source:ProjectMemoryVerifiedEvidence|null){return !!source&&source.ownerId===owner&&source.available&&source.sessionId===message.sessionId&&source.messageId===message.messageId&&typeof source.receiptId==='string'&&!!source.receiptId.trim()&&Number.isSafeInteger(source.version)&&source.version>0&&['tool','artifact'].includes(source.kind)&&typeof source.assertion==='string'&&!!source.assertion.trim()&&typeof source.text==='string'&&source.text.includes(source.assertion)}
const verificationEventSource=(message:ProjectMemoryHostMessage,keys:string[])=>JSON.stringify(['project-verification',projectMemoryMessageSourceId(message),createHash('sha256').update(JSON.stringify(keys)).digest('hex')])
const proposalEvidence=(source:ProjectMemoryVerifiedEvidence)=>({id:'verified:'+createHash('sha256').update(source.sourceId).digest('hex').slice(0,32),kind:'verified' as const,text:source.text,assertion:source.assertion,verificationSourceId:verifiedKey(source)})
/** 每次最多核128个已使用来源；采纳仍继承原证据，独立新修订不随旧来源撤回。 */
export async function refreshProjectMemorySources(options:ProjectMemoryHostOptions,service:ProjectMemoryExtractionService,input:{projectIds?:string[];cursor?:string},signal?:AbortSignal):Promise<{cursor:string|null;checked:number;forgotten:number}>{
 const {owner,pool}=options,cursor=input.cursor??''
 const rows=(await pool.query('select distinct on(s.source_id) s.source_id,e.event from teloa_project_extraction_events e cross join lateral unnest(e.source_ids) s(source_id) where e.owner_id=$1 and ($2::uuid[] is null or e.project_id=any($2::uuid[])) and s.source_id>$3 and not exists(select 1 from teloa_project_extraction_forgotten_sources f where f.owner_id=e.owner_id and f.source_id=s.source_id) order by s.source_id,e.event_id limit 128',[owner,input.projectIds??null,cursor])).rows as Array<{source_id:string;event:ProjectExtractionEvent}>
 let forgotten=0
 for(const {source_id:key,event} of rows){
  signal?.throwIfAborted();const db=await pool.connect();let status:ProjectMemoryContextSourceStatus='available'
  try{
   const contextSource=readProjectMemoryContextSource(key),receiptId=verifiedIdentity(key)
   if(contextSource)status=await projectMemoryContextSourceStatus(options,db,contextSource,event)
   else if(receiptId){
    const proof=await options.loadVerifiedEvidence?.(owner,receiptId,db)??null
    status=!proof||!proof.available||proof.ownerId!==owner||proof.sessionId!==event.sessionId||proof.messageId!==event.messageId?'unavailable':verifiedKey(proof)===key?'available':'revised'
   }else{
    let identity=sourceIdentity(key)
    if(!identity){try{const parts:unknown=JSON.parse(key);if(Array.isArray(parts)&&parts[0]==='project-verification'&&typeof parts[1]==='string')identity=sourceIdentity(parts[1])}catch{/* 非消息身份不从文本推断权限。 */}}
    if(identity){
     const message=await options.loadMessage(owner,identity.sessionId,identity.messageId,db)
     status=!readable(owner,message)?'unavailable':message.memoryMode==='off'?'withdrawn':projectMemoryMessageSourceId(message)===JSON.stringify([identity.sessionId,identity.messageId,identity.sequence])?'available':'revised'
    }
   }
  }catch(error){if(error instanceof WorkError&&['teloa/not-found','teloa/forbidden'].includes(error.code))status='unavailable';else throw error}finally{db.release()}
  if(status==='withdrawn'||status==='unavailable'){await service.forgetSource(owner,{sourceId:key},signal);forgotten++}
 }
 return {cursor:rows.length===128?rows.at(-1)!.source_id:null,checked:rows.length,forgotten}
}
/** 只消费宿主核实的原 append 本人消息，不搜索聊天历史或从自主回复制造事实。 */
export function createProjectMemoryHost(options:ProjectMemoryHostOptions):{service:ProjectMemoryExtractionService;ingest:(input:{sessionId:string;messageId:string;verifiedSourceIds?:string[]},recovery?:{retryOnTransient?:boolean})=>Promise<{eventId:string;status:string}|null>;schedule:()=>void;dispose:()=>void}{
 const {owner,pool,runtime,context}=options,controller=new AbortController(),pollMs=options.worker?.pollMs??1000
 if(!owner.trim()||owner.length>128||!Number.isSafeInteger(pollMs)||pollMs<25||pollMs>60000)throw new WorkError('teloa/invalid-input','项目提炼宿主配置不正确。')
 let closed=false,timer:ReturnType<typeof setTimeout>|null=null,running=false
 const load=async(sessionId:string,messageId:string,db?:PoolClient)=>{try{return await options.loadMessage(owner,sessionId,messageId,db)}catch(error){if(error instanceof WorkError&&['teloa/not-found','teloa/forbidden'].includes(error.code))return null;throw error}}
 const ports:ProjectMemoryExtractionPorts={
  ...(options.finished?{finished:options.finished}:{}),
  readPolicy:async(db,actor,event)=>{
   if(actor!==owner)return null
   const row=(await db.query('select m.project_id,m.version,m.memory_mode,p.definition from teloa_project_conversation_memberships m join teloa_projects p on p.id=m.project_id and p.owner_id=m.owner_id where m.owner_id=$1 and m.session_id=$2 for update of m,p',[owner,event.sessionId])).rows[0]
   if(!row||row.project_id!==event.projectId)return null
   const sourceActor=await runtime.ports.inspect(owner,event.sessionId)
   if(sourceActor.sessionId!==event.sessionId||sourceActor.scope!==row.definition.scope&&(sourceActor.kind==='ordinary'||!sourceActor.scopes?.includes(row.definition.scope)))return null
   await context.readInTransaction(db,owner,row.project_id)
   const settings=(await db.query('select version,automatic from teloa_project_runtime_settings where project_id=$1 for update',[row.project_id])).rows[0]
   return {projectId:row.project_id,bindingVersion:row.version,policyVersion:(settings?.version??0)+1,memoryEnabled:row.memory_mode==='enabled',automatic:settings?.automatic??'decisions',...row.definition.state==='archived'?{blocked:'archived' as const}:{}}
  },
  sourceAvailable:async(db,actor,event)=>{
   if(actor!==owner)return false
   const message=await load(event.sessionId,event.messageId,db)
   if(!readable(owner,message)||message.sessionId!==event.sessionId||message.messageId!==event.messageId||message.projectId!==event.projectId||message.bindingVersion!==event.bindingVersion||message.settingsVersion+1!==event.policyVersion)return false
   const expected={id:'message:'+message.sequence,...readProjectMemoryAssertion(message.text),text:message.text},actual=event.evidence[0]!
   if(actual.id!==expected.id||actual.kind!==expected.kind||actual.text!==expected.text||actual.assertion!==expected.assertion||actual.correction||actual.verificationSourceId)return false
   const verified=event.derivedSourceIds.filter(id=>verifiedIdentity(id)!==null).sort()
   if(event.sourceId!==(verified.length?verificationEventSource(message,verified):projectMemoryMessageSourceId(message))||event.evidence.length!==verified.length+1)return false
   for(const key of verified){
    const source=await options.loadVerifiedEvidence?.(owner,verifiedIdentity(key)!,db)??null
    if(!verifiedEvidence(owner,message,source)||verifiedKey(source!)!==key)return false
    const proof=proposalEvidence(source!)
    if(!event.evidence.some(e=>e.id===proof.id&&e.kind==='verified'&&e.text===proof.text&&e.assertion===proof.assertion&&e.verificationSourceId===key))return false
   }
   const derived=[...new Set([...(message.derivedSourceIds??[]),...verified,...verified.length?[projectMemoryMessageSourceId(message)]:[]])].sort()
   if(JSON.stringify(derived)!==JSON.stringify(event.derivedSourceIds))return false
   const seen=new Set<string>(),pending=[...derived]
   while(pending.length){
    const id=pending.shift()!;if(seen.has(id))continue;seen.add(id);if(seen.size>1024)return false
    if(verifiedIdentity(id)!==null)continue
    const contextSource=readProjectMemoryContextSource(id)
    if(contextSource){if(await projectMemoryContextSourceStatus({...options,entryAvailable:(db,actor,input)=>service.entryAvailableInTransaction(db,actor,input)},db,contextSource,event)!=='available')return false;continue}
    const identity=sourceIdentity(id);if(!identity)return false
    const ancestor=await load(identity.sessionId,identity.messageId,db)
    if(!readable(owner,ancestor)||ancestor.sequence!==identity.sequence||ancestor.memoryMode==='off'||projectMemoryMessageSourceId(ancestor)!==id)return false
    pending.push(...ancestor.derivedSourceIds??[])
   }
   return message.memoryMode==='enabled'||!message.derivedSourceIds?.length
  },
  generate:async(event,signal)=>{const current=AbortSignal.any([controller.signal,...signal?[signal]:[]]);current.throwIfAborted();await options.beforePublish?.(event,current);current.throwIfAborted();return options.generateAuthorized(event,current)},
  readCurrent:async(db,actor,input)=>{
   if(actor!==owner)throw new WorkError('teloa/forbidden','项目记忆不属于本人。')
   const detail=await context.readInTransaction(db,owner,input.projectId),entry=detail.entries.find(e=>e.state==='active'&&e.kind===input.kind&&normalized(e.topic)===normalized(input.topic))
   return {contextVersion:detail.version,...(entry?{entry:{id:entry.id,version:entry.version,kind:entry.kind,topic:entry.topic,markdown:entry.markdown!}}:{})}
  },
  save:async(db,actor,input,signal)=>{
   if(actor!==owner)throw new WorkError('teloa/forbidden','项目记忆不属于本人。')
   const old=await ports.readCurrent(db,actor,input)
   if(old.contextVersion!==input.expectedContextVersion||input.entryId&&(old.entry?.id!==input.entryId||old.entry.version!==input.expectedEntryVersion))throw new WorkError('teloa/version-conflict','项目条目已改变，请核对原来源。')
   if(input.intent==='automatic'){
    controller.signal.throwIfAborted()
    const event=(await db.query('select event from teloa_project_extraction_events where owner_id=$1 and event_id=$2',[owner,input.eventId])).rows[0]?.event as ProjectExtractionEvent|undefined
    if(!event)throw new WorkError('teloa/not-found','提炼原事件不可用。')
    // 此处只能同步核固定原许可；异步DB核验在generate前进行，不能另占本人事务锁。
    options.resultCurrent?.(event)
   }
   const receipt=await context.mutateInTransaction(db,owner,{requestId:input.requestId,projectId:input.projectId,expectedVersion:input.expectedContextVersion,change:{kind:'save-entry',entryId:input.entryId??null,entryKind:input.kind,topic:input.topic,markdown:input.markdown}},signal)
   const saved=await ports.readCurrent(db,actor,input)
   if(!saved.entry)throw new WorkError('teloa/storage-corrupt','项目记忆提交回执缺少真实条目。')
   return {entryId:saved.entry.id,entryVersion:saved.entry.version,contextVersion:receipt.version}
  },
  withdraw:async(db,actor,input,signal)=>{
   if(actor!==owner)throw new WorkError('teloa/forbidden','项目记忆不属于本人。')
   const current=await context.readInTransaction(db,owner,input.projectId),entry=current.entries.find(e=>e.id===input.entryId&&e.state==='active')
   if(!entry||entry.version!==input.expectedEntryVersion)throw new WorkError('teloa/version-conflict','项目条目已改变，请核对撤回范围。')
   await context.mutateInTransaction(db,owner,{requestId:input.requestId,projectId:input.projectId,expectedVersion:current.version,change:{kind:'withdraw-entry',entryId:entry.id}},signal)
  },
 }
 const {pollMs:_poll,...worker}=options.worker??{},service=new ProjectMemoryExtractionService(pool,options.identity,ports,worker)
 function schedule(){if(closed||timer||running)return;timer=setTimeout(()=>{timer=null;void work()},pollMs);timer.unref()}
 async function work(){
  if(closed||running)return;running=true
  try{const result=await service.drain(owner,controller.signal);if(result.failed)options.report?.('teloa/extraction-pending')}catch(error){if(!closed)options.report?.(failureCode(error))}finally{running=false;schedule()}
 }
 schedule()
 return {service,schedule,dispose(){closed=true;controller.abort();if(timer)clearTimeout(timer);timer=null},async ingest(input,recovery){
  if(closed)return null
  try{
   const message=await load(input.sessionId,input.messageId)
   if(!readable(owner,message)||message.sessionId!==input.sessionId||message.messageId!==input.messageId||!message.projectId)return null
   if(input.verifiedSourceIds&&(!Array.isArray(input.verifiedSourceIds)||input.verifiedSourceIds.length>8||input.verifiedSourceIds.some(id=>typeof id!=='string'||!id.trim()||id.length>512)))throw new WorkError('teloa/invalid-input','本轮核实证据数量超过上限或来源无效。')
   const receipts:ProjectMemoryVerifiedEvidence[]=[]
   for(const id of [...new Set(input.verifiedSourceIds??[])].sort()){const receipt=await options.loadVerifiedEvidence?.(owner,id)??null;if(!verifiedEvidence(owner,message,receipt)||receipt?.sourceId!==id)return null;receipts.push(receipt!)}
   const keys=receipts.map(verifiedKey).sort(),sourceId=keys.length?verificationEventSource(message,keys):projectMemoryMessageSourceId(message),event:ProjectExtractionEvent={eventId:stableId(['teloa/project-memory-event',owner,sourceId,message.projectId,message.bindingVersion,message.settingsVersion]),projectId:message.projectId,sessionId:message.sessionId,messageId:message.messageId,sourceId,derivedSourceIds:[...new Set([...(message.derivedSourceIds??[]),...keys,...keys.length?[projectMemoryMessageSourceId(message)]:[]])].sort(),bindingVersion:message.bindingVersion,policyVersion:message.settingsVersion+1,evidence:[{id:'message:'+message.sequence,...readProjectMemoryAssertion(message.text),text:message.text},...receipts.map(proposalEvidence)]}
   const receipt=await service.enqueue(owner,event);schedule();return receipt
  }catch(error){options.report?.(failureCode(error));if(recovery?.retryOnTransient&&error instanceof WorkError&&error.details?.retryable===true)throw error;return null}
 }}
}
export function readProjectMemoryAssertion(text:string):{kind:'decision'|'rule';assertion?:string}{
 const value=text.trim()
 const complex=(content:string)=>/[，,;；]|顺便|另外|然后|同时|并且|以及|\b(?:and then|also)\b|[。.!！]\s*\S/iu.test(content)
 if(!value||/[\r\n`>“”「」『』"]/u.test(value)||/[？?]$/.test(value))return {kind:'decision'}
 const future=/^(?:以后(?:都|一律|始终|每次)|从现在(?:开始|起)|from now on\b)[，,:：\s]*(.+)$/iu.exec(value)
 if(future&&/[\p{L}\p{N}]/u.test(future[1]!)&&!complex(future[1]!))return {kind:'rule',assertion:value}
 const match=/^(?:(?:请)?记住\s*[：:]\s*|(?:决定|确认|已确认)\s*[：:]\s*|(?:please\s+)?remember(?:\s+that\s+|\s*:\s*)|(?:decision|confirmed)\s*:\s*)(.+)$/iu.exec(value)
 if(!match||/^(?:以下|下面|引文|引用|示例|别人说|也许|可能|或许|是否|someone said|quote|example|maybe|perhaps|['‘’])/iu.test(match[1]!))return {kind:'decision'}
 const assertion=match[1]!
 if(complex(assertion))return {kind:'decision'}
 return /^(?:规则|约束|以后(?:都|一律|始终|每次)|从现在(?:开始|起)|from now on\b)/iu.test(assertion)?{kind:'rule',assertion}:{kind:'decision',assertion}
}
export async function withProjectMemoryBudget<T>(options:{owner:string;budgets:WorkBudgetService;modelRequestId:string;provider:string;tokens:number;authorization:WorkAccessLease;signal?:AbortSignal},dispatch:(lease:WorkAccessLease,receipt:{markDispatched:()=>Promise<void>;usage:(tokens:number|null)=>void;providerRequestId:(id:string)=>void})=>Promise<T>):Promise<T>{
 const {owner,budgets,modelRequestId,provider,signal}=options
 if(!Number.isSafeInteger(options.tokens)||options.tokens<1||typeof provider!=='string'||provider!==provider.trim()||!provider||provider.length>256||/[\x00-\x1f]/.test(provider))throw new WorkError('teloa/invalid-input','提炼模型需要真实提供方与有限输出额度。')
 signal?.throwIfAborted();options.authorization.assertCurrent()
 const reservation=await budgets.reserveOwnerMemory(owner,{modelRequestId,tokens:options.tokens}),lease=combineWorkAccessLeases([options.authorization,budgets.lease(owner,reservation)])
 let dispatched=false,entering=false,usage:number|null=null,providerRequestId:string|null=null
 try{
  signal?.throwIfAborted();lease.assertCurrent()
  // 仅由真实SDK受审派发回调标记；进入包装器或未收到delta均不是提供方派发证据。
  const value=await dispatch(lease,{markDispatched:async()=>{if(entering||dispatched)throw new WorkError('teloa/conflict','同一提炼许可不能重复派发。');signal?.throwIfAborted();lease.assertCurrent();entering=true;await budgets.markDispatched(owner,{reservationId:reservation.id});dispatched=true},usage:tokens=>{if(!dispatched)throw new WorkError('teloa/forbidden','提炼调用缺少实际派发回执。');usage=Number.isSafeInteger(tokens)&&Number(tokens)>=0?Math.max(usage??0,tokens!):null},providerRequestId:id=>{if(typeof id!=='string'||!id.trim()||id.length>256||/[\x00-\x1f]/.test(id))throw new WorkError('teloa/invalid-input','提供方操作回执无效。');if(providerRequestId!==null&&providerRequestId!==id)throw new WorkError('teloa/conflict','提供方操作身份已改变。');providerRequestId=id}})
  signal?.throwIfAborted();lease.assertCurrent();return value
 }finally{
  if(dispatched)await budgets.settle(owner,{reservationId:reservation.id,modelRequestId,provider,providerRequestId,tokens:usage,moneyMinorUnits:null,currency:null,receiptId:'memory:'+createHash('sha256').update(modelRequestId).digest('hex')})
  else await budgets.releaseUnaccepted(owner,{reservationId:reservation.id})
 }
}
