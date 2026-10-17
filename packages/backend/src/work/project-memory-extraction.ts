import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError} from '@teloa/contract'

export type ProjectExtractionEvidence={id:string;kind:'decision'|'rule'|'verified'|'untrusted'|'assistant';text:string;assertion?:string;verificationSourceId?:string;correction?:{entryId:string;entryVersion:number}}
export type ProjectExtractionEvent={eventId:string;projectId:string;sessionId:string;messageId:string;sourceId:string;derivedSourceIds:string[];bindingVersion:number;policyVersion:number;evidence:ProjectExtractionEvidence[]}
export type ProjectExtractionPolicy={projectId:string;bindingVersion:number;policyVersion:number;memoryEnabled:boolean;automatic:'decisions'|'verified'|'paused';blocked?:'archived'}
export type ProjectExtractionProposal={kind:'rule'|'memory';topic:string;markdown:string;evidence:Array<{evidenceId:string;quote:string}>}
export type ProjectExtractionCurrent={contextVersion:number;entry?:{id:string;version:number;kind:'rule'|'memory';topic:string;markdown:string}}
export type ProjectExtractionSave={requestId:string;projectId:string;kind:'rule'|'memory';topic:string;markdown:string;expectedContextVersion:number;entryId?:string;expectedEntryVersion?:number;eventId:string;intent:'automatic'|'explicit';evidence:ProjectExtractionProposal['evidence']}
export type ProjectExtractionSaved={entryId:string;entryVersion:number;contextVersion:number}
export interface ProjectMemoryExtractionPorts{
 readPolicy(db:PoolClient,owner:string,event:ProjectExtractionEvent):Promise<ProjectExtractionPolicy|null>
 sourceAvailable(db:PoolClient,owner:string,event:ProjectExtractionEvent):Promise<boolean>
 generate(event:ProjectExtractionEvent,signal?:AbortSignal):Promise<unknown>
 readCurrent(db:PoolClient,owner:string,input:{projectId:string;kind:'rule'|'memory';topic:string}):Promise<ProjectExtractionCurrent>
 save(db:PoolClient,owner:string,input:ProjectExtractionSave,signal?:AbortSignal):Promise<ProjectExtractionSaved>
 withdraw(db:PoolClient,owner:string,input:{requestId:string;projectId:string;entryId:string;expectedEntryVersion:number},signal?:AbortSignal):Promise<void>
 finished?(owner:string,eventId:string,status:ProjectExtractionStatus):Promise<void>|void
}
export type ProjectExtractionEvaluation={automatic:boolean;reason:'supported'|'unverified'|'conflict';correction?:{entryId:string;entryVersion:number}}
export type ProjectExtractionStatus='queued'|'processing'|'completed'|'discarded'|'failed'
export type ProjectExtractionCandidate={id:string;eventId:string;projectId:string;proposal:ProjectExtractionProposal;alternatives:ProjectExtractionProposal[];status:'candidate'|'conflict'|'applied'|'rejected'|'withdrawn';reason:string;saved:ProjectExtractionSaved|null;source?:{sessionId:string;messageId:string};evidence?:Array<Pick<ProjectExtractionEvidence,'kind'|'text'>>}
export type ProjectExtractionFailure={eventId:string;projectId:string;status:'failed';attempts:number;errorCode:string;canRetry:boolean}
export type ProjectMemoryExtractionOptions={maxEvents?:number;maxAttempts?:number;modelTimeoutMs?:number;leaseMs?:number;retryDelayMs?:number}
type EventRow={event_id:string;event:ProjectExtractionEvent;status:ProjectExtractionStatus;attempts:number;lease_token:string|null;body_hash:string}
type CandidateRow={id:string;event_id:string;project_id:string;proposal:ProjectExtractionProposal;alternatives:ProjectExtractionProposal[];status:ProjectExtractionCandidate['status'];reason:string;saved:ProjectExtractionSaved|null;resolution_spec:unknown}
const invalid=()=>new WorkError('teloa/invalid-input','项目记忆来源或提议格式不正确。')
const conflict=()=>new WorkError('teloa/conflict','项目记忆来源或候选已改变，请核对后重试。')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const text=(value:unknown,max=512):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max&&!value.includes('\0')
const version=(value:unknown,min=1):value is number=>Number.isSafeInteger(value)&&Number(value)>=min
const record=(value:unknown,keys:string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value as Record<string,unknown>}
const topicKey=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('en-US')
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)])):value
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const stableId=(parts:unknown[])=>{const h=hash(parts);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`}
const sources=(event:ProjectExtractionEvent)=>[event.sourceId,...event.derivedSourceIds]
const currentPolicy=(event:ProjectExtractionEvent,policy:ProjectExtractionPolicy|null,allowArchived=false):policy is ProjectExtractionPolicy=>!!policy&&policy.projectId===event.projectId&&policy.bindingVersion===event.bindingVersion&&policy.policyVersion===event.policyVersion&&policy.memoryEnabled&&policy.automatic!=='paused'&&(!policy.blocked||allowArchived&&policy.blocked==='archived')
const candidate=(row:CandidateRow):ProjectExtractionCandidate=>({id:row.id,eventId:row.event_id,projectId:row.project_id,proposal:row.proposal,alternatives:row.alternatives,status:row.status,reason:row.reason,saved:row.saved})

function readEvent(value:unknown):ProjectExtractionEvent{
 const r=record(value,['eventId','projectId','sessionId','messageId','sourceId','derivedSourceIds','bindingVersion','policyVersion','evidence'])
 if(!uuid(r.eventId)||!uuid(r.projectId)||!text(r.sessionId,256)||!text(r.messageId,256)||!text(r.sourceId)||!version(r.bindingVersion)||!version(r.policyVersion)||!Array.isArray(r.derivedSourceIds)||r.derivedSourceIds.length>1024||r.derivedSourceIds.some(x=>!text(x))||!Array.isArray(r.evidence)||!r.evidence.length||r.evidence.length>32)throw invalid()
 const ids=new Set<string>(),evidence=r.evidence.map(value=>{
  const e=record(value,['id','kind','text','assertion','verificationSourceId','correction'])
  if(!text(e.id,128)||ids.has(e.id)||!['decision','rule','verified','untrusted','assistant'].includes(String(e.kind))||!text(e.text,16000)||e.assertion!==undefined&&(!text(e.assertion,8000)||!e.text.includes(e.assertion))||e.verificationSourceId!==undefined&&!text(e.verificationSourceId))throw invalid()
  ids.add(e.id)
  if(e.correction!==undefined){const c=record(e.correction,['entryId','entryVersion']);if(!uuid(c.entryId)||!version(c.entryVersion)||!['decision','rule'].includes(String(e.kind)))throw invalid()}
  return e as ProjectExtractionEvidence
 })
 const event={eventId:r.eventId,projectId:r.projectId,sessionId:r.sessionId,messageId:r.messageId,sourceId:r.sourceId,derivedSourceIds:[...new Set(r.derivedSourceIds as string[])].sort(),bindingVersion:r.bindingVersion,policyVersion:r.policyVersion,evidence} as ProjectExtractionEvent
 if(Buffer.byteLength(JSON.stringify(event))>256*1024)throw invalid()
 return event
}

/** 模型只提议；自动生效正文逐字对应宿主已核实的本人断言或结果断言。 */
export function evaluateProjectExtraction(event:ProjectExtractionEvent,proposal:ProjectExtractionProposal,policy:ProjectExtractionPolicy):ProjectExtractionEvaluation{
 if(!currentPolicy(event,policy))return {automatic:false,reason:'unverified'}
 const cited=proposal.evidence.map(ref=>({ref,source:event.evidence.find(e=>e.id===ref.evidenceId)}))
 if(!cited.length||cited.some(({ref,source})=>!source||!source.text.includes(ref.quote)))return {automatic:false,reason:'unverified'}
 const allowed=cited.filter(({ref,source})=>source?.assertion===proposal.markdown&&ref.quote.includes(source.assertion)&&source.text.includes(source.assertion)&&(
  proposal.kind==='rule'?source.kind==='rule':source.kind==='decision'||source.kind==='verified'&&policy.automatic==='verified'&&!!source.verificationSourceId&&sources(event).includes(source.verificationSourceId)
 ))
 if(!allowed.length)return {automatic:false,reason:'unverified'}
 const corrections=allowed.map(({source})=>source?.correction).filter((c):c is NonNullable<ProjectExtractionEvidence['correction']>=>!!c)
 if(corrections.some(c=>JSON.stringify(c)!==JSON.stringify(corrections[0])))return {automatic:false,reason:'conflict'}
 return {automatic:true,reason:'supported',...(corrections[0]?{correction:corrections[0]}:{})}
}
export function readProjectExtractionProposals(event:ProjectExtractionEvent,value:unknown):ProjectExtractionProposal[]{
 if(!Array.isArray(value)||value.length>16)throw invalid()
 return value.map(value=>{
  const r=record(value,['kind','topic','markdown','evidence'])
  if(!['rule','memory'].includes(String(r.kind))||!text(r.topic,120)||r.topic!==r.topic.trim()||!text(r.markdown,8000)||!Array.isArray(r.evidence)||!r.evidence.length||r.evidence.length>16)throw invalid()
  const refs=r.evidence.map(value=>{const ref=record(value,['evidenceId','quote']);if(!text(ref.evidenceId,128)||!text(ref.quote,8000)||!event.evidence.find(e=>e.id===ref.evidenceId)?.text.includes(ref.quote))throw invalid();return {evidenceId:ref.evidenceId,quote:ref.quote}})
  return {kind:r.kind,topic:r.topic,markdown:r.markdown,evidence:refs} as ProjectExtractionProposal
 })
}

export async function initializeProjectMemoryExtraction(pool:Pool){
 await pool.query(`
  create table if not exists teloa_project_extraction_events(
   owner_id text not null,event_id uuid not null,project_id uuid not null,source_id text not null,source_ids text[] not null,binding_version integer not null,policy_version integer not null,
   event jsonb not null,body_hash text not null,status text not null check(status in ('queued','processing','completed','discarded','failed')),attempts integer not null default 0,
   lease_token uuid,lease_until timestamptz,next_attempt_at timestamptz not null,created_at timestamptz not null,primary key(owner_id,event_id),unique(owner_id,project_id,source_id,binding_version,policy_version)
  );
  create index if not exists teloa_project_extraction_drain on teloa_project_extraction_events(owner_id,status,next_attempt_at);
  alter table teloa_project_extraction_events add column if not exists error_code text;
  create table if not exists teloa_project_extraction_candidates(
   owner_id text not null,id uuid not null,event_id uuid not null,project_id uuid not null,kind text not null,topic_key text not null,proposal jsonb not null,alternatives jsonb not null default '[]',
   status text not null check(status in ('candidate','conflict','applied','rejected','withdrawn')),reason text not null,saved jsonb,resolution_request_id uuid,resolution_spec jsonb,
   created_at timestamptz not null,primary key(owner_id,id),foreign key(owner_id,event_id) references teloa_project_extraction_events(owner_id,event_id),unique(owner_id,event_id,kind,topic_key)
  );
  create unique index if not exists teloa_project_extraction_resolution on teloa_project_extraction_candidates(owner_id,resolution_request_id) where resolution_request_id is not null;
  create table if not exists teloa_project_extraction_forgotten_sources(owner_id text not null,source_id text not null,created_at timestamptz not null,primary key(owner_id,source_id));
  create table if not exists teloa_project_extraction_retries(owner_id text not null,request_id uuid not null,event_id uuid not null,project_id uuid not null,primary key(owner_id,request_id),foreign key(owner_id,event_id) references teloa_project_extraction_events(owner_id,event_id));
 `)
}

/** 持久事件只处理本轮新增证据；无独立 provider、向量库或全历史扫描。 */
export class ProjectMemoryExtractionService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly ports:ProjectMemoryExtractionPorts
 private readonly options:Required<ProjectMemoryExtractionOptions>
 private readonly checkingEntries=new WeakMap<PoolClient,Set<string>>()
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},ports:ProjectMemoryExtractionPorts,options:ProjectMemoryExtractionOptions={}){
  this.pool=pool;this.identity=identity;this.ports=ports
  this.options={maxEvents:options.maxEvents??4,maxAttempts:options.maxAttempts??3,modelTimeoutMs:options.modelTimeoutMs??5000,leaseMs:options.leaseMs??30000,retryDelayMs:options.retryDelayMs??1000}
  for(const [key,value] of Object.entries(this.options))if(!version(value)||value>({maxEvents:16,maxAttempts:5,modelTimeoutMs:60000,leaseMs:120000,retryDelayMs:60000}[key]??0))throw invalid()
  if(this.options.leaseMs<=this.options.modelTimeoutMs)throw invalid()
 }
 private owner(owner:string){if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
 private now(){const value=this.identity.now();if(!Number.isFinite(Date.parse(value)))throw invalid();return value}
 private async transaction<T>(owner:string,action:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect()
  try{await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/project-context',owner])]);const result=await action(db);await db.query('commit');return result}catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 private async sourceAvailable(db:PoolClient,owner:string,event:ProjectExtractionEvent){
  return !(await db.query('select 1 from teloa_project_extraction_forgotten_sources where owner_id=$1 and source_id=any($2::text[])',[owner,sources(event)])).rowCount&&await this.ports.sourceAvailable(db,owner,event)
 }
 /** 自动保存与采纳候选的确切派生修订继承来源约束；本人独立编辑的新修订不继承旧来源。 */
 async entryAvailableInTransaction(db:PoolClient,owner:string,input:{entryId:string;entryVersion:number}):Promise<boolean>{
  this.owner(owner);if(!uuid(input.entryId)||!version(input.entryVersion))throw invalid()
  let checking=this.checkingEntries.get(db);if(!checking){checking=new Set();this.checkingEntries.set(db,checking)}
  const key=JSON.stringify([owner,input.entryId,input.entryVersion]);if(checking.has(key)||checking.size>=1024)return false
  checking.add(key)
  try{
   const rows=(await db.query("select c.status,e.event from teloa_project_extraction_candidates c join teloa_project_extraction_events e on e.owner_id=c.owner_id and e.event_id=c.event_id where c.owner_id=$1 and c.saved->>'entryId'=$2 and (c.saved->>'entryVersion')::integer=$3",[owner,input.entryId,input.entryVersion])).rows as Array<{status:ProjectExtractionCandidate['status'];event:ProjectExtractionEvent}>
   if(!rows.length)return true
   for(const row of rows)if(row.status==='applied'&&await this.sourceAvailable(db,owner,row.event))return true
   return false
  }finally{checking.delete(key);if(!checking.size)this.checkingEntries.delete(db)}
 }
 private async eligible(db:PoolClient,owner:string,event:ProjectExtractionEvent,allowArchived=false){
  const policy=await this.ports.readPolicy(db,owner,event)
  const disabled=policy?.projectId===event.projectId&&policy.bindingVersion===event.bindingVersion&&!policy.memoryEnabled
  const banned=!!(await db.query('select 1 from teloa_project_extraction_forgotten_sources where owner_id=$1 and source_id=any($2::text[])',[owner,sources(event)])).rowCount
  // 不入队的关闭记忆来源及已撤回内容的后续派生身份，也保留禁再提炼标记。
  if(banned||disabled&&await this.ports.sourceAvailable(db,owner,event))await db.query('insert into teloa_project_extraction_forgotten_sources values($1,$2,$3) on conflict do nothing',[owner,event.sourceId,this.now()])
  return !banned&&currentPolicy(event,policy,allowArchived)&&await this.ports.sourceAvailable(db,owner,event)?policy:null
 }
 async enqueue(owner:string,input:ProjectExtractionEvent):Promise<{eventId:string;status:ProjectExtractionStatus}>{
  this.owner(owner);const event=readEvent(input),{eventId:_,...body}=event,bodyHash=hash(body)
  return this.transaction(owner,async db=>{
   const replay=(await db.query('select event_id,status,body_hash from teloa_project_extraction_events where owner_id=$1 and (event_id=$2 or (project_id=$3 and source_id=$4 and binding_version=$5 and policy_version=$6))',[owner,event.eventId,event.projectId,event.sourceId,event.bindingVersion,event.policyVersion])).rows
   if(replay.length){if(replay.length!==1||replay[0].body_hash!==bodyHash)throw conflict();return {eventId:replay[0].event_id,status:replay[0].status}}
   if(!await this.eligible(db,owner,event,true))return {eventId:event.eventId,status:'discarded'}
   const now=this.now()
   await db.query("insert into teloa_project_extraction_events(owner_id,event_id,project_id,source_id,source_ids,binding_version,policy_version,event,body_hash,status,next_attempt_at,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$10)",[owner,event.eventId,event.projectId,event.sourceId,sources(event),event.bindingVersion,event.policyVersion,event,bodyHash,now])
   return {eventId:event.eventId,status:'queued'}
  })
 }
 private async claim(owner:string):Promise<EventRow|null>{
  return this.transaction(owner,async db=>{
   const now=this.now()
   await db.query("update teloa_project_extraction_events set status='failed',lease_token=null,lease_until=null where owner_id=$1 and status='processing' and lease_until<=$2 and attempts>=$3",[owner,now,this.options.maxAttempts])
   const row=(await db.query("select * from teloa_project_extraction_events where owner_id=$1 and attempts<$3 and ((status='queued' and next_attempt_at<=$2) or (status='processing' and lease_until<=$2)) order by created_at,event_id limit 1 for update skip locked",[owner,now,this.options.maxAttempts])).rows[0] as EventRow|undefined
   if(!row)return null
   const token=this.identity.id(),lease=new Date(Date.parse(now)+this.options.leaseMs).toISOString()
   return (await db.query("update teloa_project_extraction_events set status='processing',attempts=attempts+1,lease_token=$3,lease_until=$4 where owner_id=$1 and event_id=$2 returning *",[owner,row.event_id,token,lease])).rows[0] as EventRow
  })
 }
 private async generate(event:ProjectExtractionEvent,signal?:AbortSignal){
  const bounded=AbortSignal.any([AbortSignal.timeout(this.options.modelTimeoutMs),...(signal?[signal]:[])])
  bounded.throwIfAborted()
  let onAbort:()=>void=()=>{}
  try{return await Promise.race([this.ports.generate(structuredClone(event),bounded),new Promise<never>((_,reject)=>{onAbort=()=>reject(bounded.reason);bounded.addEventListener('abort',onAbort,{once:true})})])}finally{bounded.removeEventListener('abort',onAbort)}
 }
 private async deferArchived(db:PoolClient,owner:string,row:EventRow){
  const next=new Date(Date.parse(this.now())+5000).toISOString()
  await db.query("update teloa_project_extraction_events set status='queued',attempts=greatest(attempts-1,0),lease_token=null,lease_until=null,next_attempt_at=$4,error_code=null where owner_id=$1 and event_id=$2 and status='processing' and lease_token=$3",[owner,row.event_id,row.lease_token,next])
 }
 private async finalize(owner:string,row:EventRow,proposals:ProjectExtractionProposal[],signal?:AbortSignal):Promise<'completed'|'discarded'|'queued'>{
  return this.transaction(owner,async db=>{
   const stored=(await db.query('select * from teloa_project_extraction_events where owner_id=$1 and event_id=$2 for update',[owner,row.event_id])).rows[0] as EventRow
   if(stored.status!=='processing'||stored.lease_token!==row.lease_token)return 'discarded'
   const policy=await this.eligible(db,owner,row.event,true)
   if(!policy){await db.query("update teloa_project_extraction_events set status='discarded',lease_token=null,lease_until=null where owner_id=$1 and event_id=$2",[owner,row.event_id]);return 'discarded'}
   if(policy.blocked==='archived'){await this.deferArchived(db,owner,row);return 'queued'}
   signal?.throwIfAborted()
   const groups=new Map<string,ProjectExtractionProposal[]>()
   for(const proposal of proposals){const key=JSON.stringify([proposal.kind,topicKey(proposal.topic)]),group=groups.get(key)??[];if(!group.some(p=>JSON.stringify(p)===JSON.stringify(proposal)))group.push(proposal);groups.set(key,group)}
   for(const group of groups.values()){
    const proposal=group[0]!,id=stableId(['teloa/project-extraction',owner,row.event_id,proposal.kind,topicKey(proposal.topic)]),evaluation=evaluateProjectExtraction(row.event,proposal,policy),current=await this.ports.readCurrent(db,owner,{projectId:row.event.projectId,kind:proposal.kind,topic:proposal.topic})
    const ambiguous=group.some(p=>p.markdown!==proposal.markdown),old=current.entry,matches=old?.markdown===proposal.markdown
    const correction=evaluation.correction,canCorrect=!!old&&correction?.entryId===old.id&&correction.entryVersion===old.version
    const hasConflict=ambiguous||evaluation.reason==='conflict'||!!old&&!matches&&!canCorrect||!!correction&&!canCorrect
    let status:ProjectExtractionCandidate['status']=hasConflict?'conflict':'candidate',reason=hasConflict?'conflict':evaluation.reason,saved:ProjectExtractionSaved|null=null
    if(!hasConflict&&evaluation.automatic){
     if(matches)saved={entryId:old!.id,entryVersion:old!.version,contextVersion:current.contextVersion}
     else saved=await this.ports.save(db,owner,{requestId:stableId(['teloa/project-extraction-save',id]),projectId:row.event.projectId,kind:proposal.kind,topic:old?.topic??proposal.topic,markdown:proposal.markdown,expectedContextVersion:current.contextVersion,...(old?{entryId:old.id,expectedEntryVersion:old.version}:{}),eventId:row.event_id,intent:'automatic',evidence:proposal.evidence},signal)
     status='applied'
    }
    await db.query('insert into teloa_project_extraction_candidates(owner_id,id,event_id,project_id,kind,topic_key,proposal,alternatives,status,reason,saved,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(owner_id,event_id,kind,topic_key) do nothing',[owner,id,row.event_id,row.event.projectId,proposal.kind,topicKey(proposal.topic),proposal,JSON.stringify(group.slice(1)),status,reason,saved,this.now()])
   }
   signal?.throwIfAborted()
   await db.query("update teloa_project_extraction_events set status='completed',lease_token=null,lease_until=null where owner_id=$1 and event_id=$2",[owner,row.event_id]);return 'completed'
  })
 }
 async drain(owner:string,signal?:AbortSignal){
  this.owner(owner);const result={processed:0,completed:0,discarded:0,failed:0}
  for(let i=0;i<this.options.maxEvents&&!signal?.aborted;i++){
   const row=await this.claim(owner);if(!row)break;result.processed++
   let status:ProjectExtractionStatus='processing'
   try{
    const allowed=await this.transaction(owner,async db=>{const policy=await this.eligible(db,owner,row.event,true);if(policy?.blocked==='archived'){await this.deferArchived(db,owner,row);return 'deferred'}return policy?'ready':'invalid'})
    if(allowed==='deferred'){status='queued';continue}
    if(allowed==='invalid'){status=await this.finalize(owner,row,[],signal);if(status!=='queued')result[status]++;continue}
    const proposals=readProjectExtractionProposals(row.event,await this.generate(row.event,signal))
    status=await this.finalize(owner,row,proposals,signal);if(status!=='queued')result[status]++
   }catch(error){
    const code=error instanceof WorkError&&/^teloa\/[a-z][a-z0-9-]{0,60}$/.test(error.code)?error.code:'teloa/dependency-unavailable'
    const recovery=await this.transaction(owner,async db=>{
     const policy=await this.eligible(db,owner,row.event,true)
     if(policy?.blocked==='archived'){await this.deferArchived(db,owner,row);return {status:'queued' as const,deferred:true}}
     const next=new Date(Date.parse(this.now())+this.options.retryDelayMs*row.attempts).toISOString(),status=row.attempts>=this.options.maxAttempts?'failed' as const:'queued' as const
     await db.query("update teloa_project_extraction_events set status=$4,lease_token=null,lease_until=null,next_attempt_at=$5,error_code=$6 where owner_id=$1 and event_id=$2 and status='processing' and lease_token=$3",[owner,row.event_id,row.lease_token,status,next,code]);return {status,deferred:false}
    })
    status=recovery.status;if(!recovery.deferred)result.failed++
   }finally{try{await this.ports.finished?.(owner,row.event_id,status)}catch{/* 观察/缓存退役失败不改变原事件提交或原工作结果。 */}}
  }
  return result
 }
 async listCandidates(owner:string,input:{projectId:string}):Promise<ProjectExtractionCandidate[]>{
  this.owner(owner);if(!uuid(input?.projectId))throw invalid()
  return this.transaction(owner,async db=>{
   const rows=(await db.query("select c.*,e.event from teloa_project_extraction_candidates c join teloa_project_extraction_events e on e.owner_id=c.owner_id and e.event_id=c.event_id where c.owner_id=$1 and c.project_id=$2 and c.status in ('candidate','conflict') order by c.created_at,c.id limit 100",[owner,input.projectId])).rows as Array<CandidateRow&{event:ProjectExtractionEvent}>
   const values:ProjectExtractionCandidate[]=[]
   for(const row of rows){const policy=await this.ports.readPolicy(db,owner,row.event);if(policy?.projectId===input.projectId&&policy.bindingVersion===row.event.bindingVersion&&policy.memoryEnabled&&await this.sourceAvailable(db,owner,row.event))values.push({...candidate(row),source:{sessionId:row.event.sessionId,messageId:row.event.messageId},evidence:row.event.evidence.map(({kind,text})=>({kind,text}))})}
   return values
  })
 }
 async listFailures(owner:string,input:{projectId:string}):Promise<ProjectExtractionFailure[]>{
  this.owner(owner);record(input,['projectId']);if(!uuid(input.projectId))throw invalid()
  return this.transaction(owner,async db=>{
   const rows=(await db.query("select event_id,project_id,attempts,error_code,event from teloa_project_extraction_events where owner_id=$1 and project_id=$2 and status='failed' order by created_at,event_id limit 100",[owner,input.projectId])).rows as Array<EventRow&{project_id:string;error_code:string|null}>,values:ProjectExtractionFailure[]=[]
   for(const row of rows){const policy=await this.ports.readPolicy(db,owner,row.event);if(policy?.projectId!==input.projectId||!await this.sourceAvailable(db,owner,row.event))continue;values.push({eventId:row.event_id,projectId:row.project_id,status:'failed',attempts:row.attempts,errorCode:row.error_code??'teloa/dependency-unavailable',canRetry:currentPolicy(row.event,policy)})}
   return values
  })
 }
 async retryEvent(owner:string,input:{eventId:string;requestId:string;expectedProjectId:string}):Promise<{eventId:string;status:ProjectExtractionStatus}>{
  this.owner(owner);record(input,['eventId','requestId','expectedProjectId']);if(!uuid(input.eventId)||!uuid(input.requestId)||!uuid(input.expectedProjectId))throw invalid()
  return this.transaction(owner,async db=>{
   const row=(await db.query('select * from teloa_project_extraction_events where owner_id=$1 and event_id=$2 for update',[owner,input.eventId])).rows[0] as EventRow&{project_id:string}|undefined
   if(!row||row.project_id!==input.expectedProjectId)throw conflict()
   const replay=(await db.query('select event_id,project_id from teloa_project_extraction_retries where owner_id=$1 and request_id=$2',[owner,input.requestId])).rows[0]
   if(replay){if(replay.event_id!==input.eventId||replay.project_id!==input.expectedProjectId)throw conflict();return {eventId:row.event_id,status:row.status}}
   if(row.status!=='failed'||!await this.eligible(db,owner,row.event))throw conflict()
   await db.query("update teloa_project_extraction_events set status='queued',attempts=0,error_code=null,next_attempt_at=$3 where owner_id=$1 and event_id=$2",[owner,row.event_id,this.now()])
   await db.query('insert into teloa_project_extraction_retries values($1,$2,$3,$4)',[owner,input.requestId,row.event_id,row.project_id]);return {eventId:row.event_id,status:'queued'}
  })
 }
 async resolveCandidate(owner:string,input:{candidateId:string;action:'accept'|'reject';expectedContextVersion:number;requestId:string;expectedProjectId?:string},signal?:AbortSignal):Promise<ProjectExtractionCandidate>{
  this.owner(owner);record(input,['candidateId','action','expectedContextVersion','requestId','expectedProjectId']);if(!uuid(input.candidateId)||!uuid(input.requestId)||!['accept','reject'].includes(input.action)||!version(input.expectedContextVersion,0)||input.expectedProjectId!==undefined&&!uuid(input.expectedProjectId))throw invalid()
  return this.transaction(owner,async db=>{
   const replay=(await db.query('select c.*,e.event from teloa_project_extraction_candidates c join teloa_project_extraction_events e on e.owner_id=c.owner_id and e.event_id=c.event_id where c.owner_id=$1 and c.resolution_request_id=$2',[owner,input.requestId])).rows[0] as CandidateRow&{event:ProjectExtractionEvent}|undefined
   if(replay){if(input.expectedProjectId!==undefined&&replay.project_id!==input.expectedProjectId||hash(replay.resolution_spec)!==hash(input)||replay.status==='withdrawn'||!await this.sourceAvailable(db,owner,replay.event))throw conflict();return candidate(replay)}
   const row=(await db.query('select c.*,e.event from teloa_project_extraction_candidates c join teloa_project_extraction_events e on e.owner_id=c.owner_id and e.event_id=c.event_id where c.owner_id=$1 and c.id=$2 for update of c',[owner,input.candidateId])).rows[0] as CandidateRow&{event:ProjectExtractionEvent}|undefined
   if(!row)throw new WorkError('teloa/not-found','项目记忆候选不存在或不可访问。')
   if(input.expectedProjectId!==undefined&&row.project_id!==input.expectedProjectId)throw conflict()
   if(!['candidate','conflict'].includes(row.status))throw conflict()
   const policy=await this.ports.readPolicy(db,owner,row.event)
   if(!policy||policy.projectId!==row.project_id||policy.bindingVersion!==row.event.bindingVersion||!await this.sourceAvailable(db,owner,row.event))throw conflict()
   let saved:ProjectExtractionSaved|null=null
   if(input.action==='accept'){
    const p=row.proposal,current=await this.ports.readCurrent(db,owner,{projectId:row.project_id,kind:p.kind,topic:p.topic})
    if(current.contextVersion!==input.expectedContextVersion)throw new WorkError('teloa/version-conflict','项目上下文已改变，请核对候选后重试。')
    signal?.throwIfAborted()
    if(current.entry?.markdown===p.markdown)saved={entryId:current.entry.id,entryVersion:current.entry.version,contextVersion:current.contextVersion}
    else saved=await this.ports.save(db,owner,{requestId:input.requestId,projectId:row.project_id,kind:p.kind,topic:current.entry?.topic??p.topic,markdown:p.markdown,expectedContextVersion:current.contextVersion,...(current.entry?{entryId:current.entry.id,expectedEntryVersion:current.entry.version}:{}),eventId:row.event_id,intent:'explicit',evidence:p.evidence},signal)
   }
   signal?.throwIfAborted()
   return candidate((await db.query('update teloa_project_extraction_candidates set status=$3,saved=$4,resolution_request_id=$5,resolution_spec=$6 where owner_id=$1 and id=$2 returning *',[owner,row.id,input.action==='accept'?'applied':'rejected',saved,input.requestId,input])).rows[0])
  })
 }
 async forgetSource(owner:string,input:{sourceId:string},signal?:AbortSignal){
  this.owner(owner);record(input,['sourceId']);if(!text(input.sourceId))throw invalid()
  return this.transaction(owner,async db=>{
   signal?.throwIfAborted()
   const affected=(await db.query('with recursive affected(source_id) as (select $2::text union select e.source_id from teloa_project_extraction_events e join affected a on a.source_id=any(e.source_ids) where e.owner_id=$1) select source_id from affected',[owner,input.sourceId])).rows.map(row=>row.source_id as string)
   await db.query('insert into teloa_project_extraction_forgotten_sources(owner_id,source_id,created_at) select $1,source_id,$3 from unnest($2::text[]) source_id on conflict do nothing',[owner,affected,this.now()])
   const rows=(await db.query("select c.* from teloa_project_extraction_candidates c join teloa_project_extraction_events e on e.owner_id=c.owner_id and e.event_id=c.event_id where c.owner_id=$1 and e.source_ids&&$2::text[] and c.status<>'withdrawn'",[owner,affected])).rows as CandidateRow[]
   const events=await db.query("update teloa_project_extraction_events set status='discarded',lease_token=null,lease_until=null where owner_id=$1 and source_ids&&$2::text[] and status<>'discarded'",[owner,affected])
   await db.query("update teloa_project_extraction_candidates set status='withdrawn' where owner_id=$1 and id=any($2::uuid[])",[owner,rows.map(row=>row.id)])
   let withdrawnEntries=0;const handled=new Set<string>()
   for(const row of rows){
    if(!row.saved||handled.has(row.saved.entryId))continue;handled.add(row.saved.entryId)
    const other=(await db.query("select e.event from teloa_project_extraction_candidates c join teloa_project_extraction_events e on e.owner_id=c.owner_id and e.event_id=c.event_id where c.owner_id=$1 and c.status='applied' and c.saved->>'entryId'=$2 and (c.saved->>'entryVersion')::integer=$3",[owner,row.saved.entryId,row.saved.entryVersion])).rows as Array<{event:ProjectExtractionEvent}>
    let supported=false;for(const value of other)if(await this.sourceAvailable(db,owner,value.event)){supported=true;break}
    if(supported)continue
    const current=await this.ports.readCurrent(db,owner,{projectId:row.project_id,kind:row.proposal.kind,topic:row.proposal.topic})
    if(current.entry?.id===row.saved.entryId&&current.entry.version===row.saved.entryVersion){await this.ports.withdraw(db,owner,{requestId:stableId(['teloa/project-extraction-forget',owner,input.sourceId,current.entry.id,current.entry.version]),projectId:row.project_id,entryId:current.entry.id,expectedEntryVersion:current.entry.version},signal);withdrawnEntries++}
   }
   signal?.throwIfAborted();return {events:events.rowCount??0,candidates:rows.length,withdrawnEntries}
  })
 }
}
