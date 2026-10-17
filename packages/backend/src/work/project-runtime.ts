import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,projectInput} from '@teloa/contract'
import {projectRuntimeSettingsInput,projectMembershipInput,projectRuntimeUuid,projectRuntimeSession,projectRuntimeVersion,readProjectRuntimeSettings,readProjectMembership,readContextUseManifest,type ProjectRuntimeSettings,type ProjectConversationMembership,type ProjectContextUseSource,type ProjectContextUseManifest,type ProjectMemoryMode} from '@teloa/contract'
import {BusinessScopeService} from './business-scopes.ts'
import {ProjectContextService,subscribeProjectContextChanges} from './project-context.ts'
import {ProjectPersonalMemoryService,subscribePersonalMemoryChanges} from './project-personal-memory.ts'

export type ProjectRuntimeActor={sessionId:string;title:string;scope:string;submitted:boolean;running:boolean;pending?:boolean;bindable?:boolean;kind:'ordinary'|'employee'|'task'|'subagent';roleId?:string;scopes?:string[];parentSessionId?:string;parentMessageId?:string;goal?:string}
export type ProjectRuntimeResourceContent={id:string;title:string;version:number;hash:string;markdown:string;scopeIds:string[];sourceId?:string}
export type ProjectRuntimePorts={
 inspect(owner:string,sessionId:string):Promise<ProjectRuntimeActor>
 sessions?(owner:string):Promise<Array<{sessionId:string;title:string}>>
 resource?(db:PoolClient,owner:string,id:string,scopes:string[]):Promise<ProjectRuntimeResourceContent>
 optionalMemories?(db:PoolClient,owner:string,actor:ProjectRuntimeActor,query:string,readPersonal:boolean):Promise<Array<ProjectRuntimeResourceContent&{kind:'personal'|'role'}>>
 memoryAvailable?(db:PoolClient,owner:string,input:{entryId:string;entryVersion:number}):Promise<boolean>
 maxContextChars?:number
}
export type ProjectRuntimePrepared={binding:ProjectConversationMembership&{contextVersion:number;settingsVersion:number};manifestId:string;text:string;sources:ProjectContextUseSource[];reset:boolean;providerSessionId:string}
type SourceState={mandatory?:string;optional?:Record<string,string>}
type MembershipRow={owner_id:string;session_id:string;project_id:string|null;version:number;memory_mode:ProjectMemoryMode;generation:number;title:string;fingerprint:string;source_state:SourceState;inherited_sources:ProjectContextUseSource[]|null;context_version:number;settings_version:number;reset_pending:boolean}
const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
const stale=()=>new WorkError('teloa/version-conflict','项目上下文已更新，请按当前可用背景继续。')
const missing=()=>new WorkError('teloa/not-found','项目或会话不存在或不可访问。')
const watchers=new WeakMap<Pool,Set<(owner:string,sessionId?:string,projectIds?:readonly string[])=>void>>()
const invalidate=(pool:Pool,owner:string,sessionId?:string,projectIds?:readonly string[])=>{for(const fn of watchers.get(pool)??[])fn(owner,sessionId,projectIds)}
const ownerKey=(value:string)=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。');return value}
function membership(row:MembershipRow):ProjectConversationMembership{return readProjectMembership({sessionId:row.session_id,projectId:row.project_id,version:row.version,memoryMode:row.memory_mode,generation:row.generation,title:row.title})}

export async function initializeProjectRuntime(pool:Pool){await pool.query(`
 create table if not exists teloa_project_runtime_settings(
  project_id uuid primary key references teloa_projects(id),version integer not null check(version>0),automatic text not null check(automatic in('decisions','verified','paused')),
  read_personal boolean not null,resources jsonb not null check(jsonb_typeof(resources)='array')
 );
 create table if not exists teloa_project_conversation_memberships(
  owner_id text not null,session_id text not null,project_id uuid references teloa_projects(id),version integer not null check(version>0),
  memory_mode text not null check(memory_mode in('enabled','off')),generation integer not null check(generation>0),scope text not null,title text not null,
  fingerprint text not null default '',source_state jsonb not null default '{}',inherited_sources jsonb,context_version integer not null default 0,settings_version integer not null default 0,reset_pending boolean not null default true,
  primary key(owner_id,session_id)
 );
 create index if not exists teloa_project_membership_project on teloa_project_conversation_memberships(project_id,owner_id);
 alter table teloa_project_conversation_memberships add column if not exists source_state jsonb not null default '{}';
 alter table teloa_project_conversation_memberships add column if not exists inherited_sources jsonb;
 create table if not exists teloa_project_runtime_requests(owner_id text not null,request_id uuid not null,spec jsonb not null,receipt jsonb not null,primary key(owner_id,request_id));
 create table if not exists teloa_project_context_uses(
  id uuid primary key,owner_id text not null,session_id text not null,message_id text not null,project_id uuid references teloa_projects(id),binding_version integer not null,
  generation integer not null,memory_mode text not null,settings_version integer not null default 0,sources jsonb not null,omitted jsonb not null,created_at timestamptz not null,
  stage text not null default 'prepared' check(stage in('prepared','dispatched','failed')),prompt_hash text,request_key text not null,
  unique(owner_id,session_id,message_id,generation,request_key)
 );
`)}

/** 正文仍沿 B1 修订保存；此服务只维护归属、策略和实际输入身份。 */
export class ProjectRuntimeService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly ports:ProjectRuntimePorts
 private readonly tokens=new WeakMap<ProjectRuntimePrepared,{owner:string;epoch:number;sessionEpoch:number;projectEpoch:number}>()
 private readonly epochs=new Map<string,number>();private readonly sessionEpochs=new Map<string,number>();private readonly projectEpochs=new Map<string,number>();private readonly close:()=>void
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},ports:ProjectRuntimePorts){
  this.pool=pool;this.identity=identity;this.ports=ports
  const fn=(owner:string,sessionId?:string,projectIds?:readonly string[])=>{if(sessionId){const key=owner+'\0'+sessionId;this.sessionEpochs.set(key,(this.sessionEpochs.get(key)??0)+1)}else if(projectIds){for(const id of projectIds){const key=owner+'\0'+id;this.projectEpochs.set(key,(this.projectEpochs.get(key)??0)+1)}}else this.epochs.set(owner,(this.epochs.get(owner)??0)+1)}
  if(!watchers.has(pool))watchers.set(pool,new Set());watchers.get(pool)!.add(fn)
  const release=subscribeProjectContextChanges(pool,(owner,ids)=>fn(owner,undefined,ids))
  const releasePersonal=subscribePersonalMemoryChanges(pool,owner=>fn(owner))
  this.close=()=>{release();releasePersonal();watchers.get(pool)?.delete(fn)}
 }
 dispose(){this.close()}
 invalidate(owner:string,sessionId?:string){invalidate(this.pool,owner,sessionId)}
 private async tx<T>(owner:string,run:(db:PoolClient)=>Promise<T>){ownerKey(owner);const db=await this.pool.connect();try{await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/project-context',owner])]);const value=await run(db);await db.query('commit');return value}catch(error){await db.query('rollback');throw error}finally{db.release()}}
 private async project(db:PoolClient,owner:string,id:string){
  const row=(await db.query('select id,definition,version from teloa_projects where owner_id=$1 and id=$2',[owner,id])).rows[0]
  if(!row||!await BusinessScopeService.registered(db,owner,row.definition.scope))throw missing()
  return row as {id:string;definition:{scope:string;title:string;goal:string;state:string};version:number}
 }
 private async settingsIn(db:PoolClient,id:string):Promise<ProjectRuntimeSettings>{
  const row=(await db.query('select * from teloa_project_runtime_settings where project_id=$1',[id])).rows[0]
  return readProjectRuntimeSettings(row?{projectId:id,version:row.version,automatic:row.automatic,readPersonal:row.read_personal,resources:row.resources}:{projectId:id,version:0,automatic:'decisions',readPersonal:false,resources:[]})
 }
 async settings(owner:string,input:unknown){const r=projectInput(input,['projectId']),id=projectRuntimeUuid(r.projectId);return this.tx(owner,async db=>{await this.project(db,owner,id);return this.settingsIn(db,id)})}
 async configure(owner:string,input:unknown,signal?:AbortSignal){
  const value=projectRuntimeSettingsInput(input);signal?.throwIfAborted()
  return this.tx(owner,async db=>{
   const project=await this.project(db,owner,value.projectId);if(project.definition.state==='archived')throw new WorkError('teloa/conflict','请先恢复项目再修改记忆策略。')
   const previous=(await db.query('select spec,receipt from teloa_project_runtime_requests where owner_id=$1 and request_id=$2',[owner,value.requestId])).rows[0]
   if(previous){if(JSON.stringify(projectRuntimeSettingsInput(previous.spec))!==JSON.stringify(value))throw stale();return readProjectRuntimeSettings(previous.receipt)}
   const current=await this.settingsIn(db,value.projectId);if(current.version!==value.expectedVersion)throw stale()
   for(const source of value.resources){if(!this.ports.resource)throw new WorkError('teloa/unavailable','项目资料读取尚未连接。');await this.ports.resource(db,owner,source.resourceId,[project.definition.scope])}
   const next={projectId:value.projectId,version:current.version+1,automatic:value.automatic,readPersonal:value.readPersonal,resources:value.resources}
   await db.query('insert into teloa_project_runtime_settings values($1,$2,$3,$4,$5) on conflict(project_id) do update set version=$2,automatic=$3,read_personal=$4,resources=$5',[next.projectId,next.version,next.automatic,next.readPersonal,JSON.stringify(next.resources)])
   await db.query('insert into teloa_project_runtime_requests values($1,$2,$3,$4)',[owner,value.requestId,JSON.stringify(value),JSON.stringify(next)])
   signal?.throwIfAborted();invalidate(this.pool,owner,undefined,[value.projectId]);return next
  })
 }
 async bind(owner:string,input:unknown,signal?:AbortSignal){
  ownerKey(owner);const value=projectMembershipInput(input),actor=await this.ports.inspect(owner,value.sessionId)
  if(actor.sessionId!==value.sessionId||actor.kind!=='ordinary'||actor.bindable===false)throw new WorkError('teloa/forbidden','此会话不能由项目成员入口修改归属。')
  if(actor.running||actor.pending)throw new WorkError('teloa/conflict','会话仍在运行或已有受理任务，请等待当前工作结束。')
  return this.tx(owner,async db=>{
   const old=(await db.query('select * from teloa_project_conversation_memberships where owner_id=$1 and session_id=$2 for update',[owner,value.sessionId])).rows[0] as MembershipRow|undefined
   const replay=(await db.query('select spec,receipt from teloa_project_runtime_requests where owner_id=$1 and request_id=$2',[owner,value.requestId])).rows[0]
   if(replay){if(JSON.stringify(projectMembershipInput(replay.spec))!==JSON.stringify(value))throw stale();return readProjectMembership(replay.receipt)}
   if((old?.version??0)!==value.expectedVersion)throw stale()
   if(actor.submitted&&(old?.memory_mode??'enabled')!==value.memoryMode)throw new WorkError('teloa/conflict','已有消息的会话请新建会话选择记忆模式。')
   if(value.projectId){const project=await this.project(db,owner,value.projectId);if(project.definition.scope!==actor.scope||project.definition.state==='archived')throw new WorkError('teloa/forbidden','会话和项目业务范围不一致，或项目已归档。')}
   const version=(old?.version??0)+1,generation=(old?.generation??0)+1
   await db.query(`insert into teloa_project_conversation_memberships(owner_id,session_id,project_id,version,memory_mode,generation,scope,title) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(owner_id,session_id) do update set project_id=$3,version=$4,memory_mode=$5,generation=$6,scope=$7,title=$8,fingerprint='',reset_pending=true`,[owner,value.sessionId,value.projectId,version,value.memoryMode,generation,actor.scope,actor.title])
   const result={sessionId:value.sessionId,projectId:value.projectId,version,memoryMode:value.memoryMode,generation,title:actor.title}
   await db.query('insert into teloa_project_runtime_requests values($1,$2,$3,$4)',[owner,value.requestId,JSON.stringify(value),JSON.stringify(result)])
   signal?.throwIfAborted();invalidate(this.pool,owner,value.sessionId);return result
  })
 }
 async getBinding(owner:string,sessionId:string){ownerKey(owner);projectRuntimeSession(sessionId);const row=(await this.pool.query('select * from teloa_project_conversation_memberships where owner_id=$1 and session_id=$2',[owner,sessionId])).rows[0] as MembershipRow|undefined;return row?membership(row):null}
 async members(owner:string,input:unknown){const r=projectInput(input,['projectId']),id=projectRuntimeUuid(r.projectId);return this.tx(owner,async db=>{await this.project(db,owner,id);const rows=(await db.query('select * from teloa_project_conversation_memberships where owner_id=$1 and project_id=$2 order by session_id',[owner,id])).rows as MembershipRow[];return {rows:rows.map(membership)}})}
 async conversations(owner:string,input:unknown){const r=projectInput(input,['projectId']),id=projectRuntimeUuid(r.projectId),settings=await this.settings(owner,{projectId:id}),rows=[];void settings
  const db=await this.pool.connect();try{const project=await this.project(db,owner,id);for(const item of await this.ports.sessions?.(owner)??[]){try{const actor=await this.ports.inspect(owner,item.sessionId),binding=await this.getBinding(owner,item.sessionId);if(actor.kind==='ordinary'&&actor.bindable!==false&&!actor.running&&!actor.pending&&actor.scope===project.definition.scope&&binding?.projectId!==id)rows.push({sessionId:item.sessionId,title:actor.title,bindingVersion:binding?.version??0})}catch{/* 无权或已失效会话不列出。 */}}return {rows}}finally{db.release()}
 }
 /** 只从宿主核实的父会话继承，模型和工作台不能自行调用。 */
 private async inheritIn(db:PoolClient,owner:string,actor:ProjectRuntimeActor,parentSessionId:string,parentMessageId:string|undefined){
  if(!parentMessageId)return undefined
  const parent=(await db.query("select project_id,memory_mode,sources from teloa_project_context_uses where owner_id=$1 and session_id=$2 and message_id=$3 and stage='dispatched' and request_key<>'context-check' and request_key not like 'project-memory:%' order by created_at,id limit 1",[owner,parentSessionId,parentMessageId])).rows[0] as (Pick<MembershipRow,'project_id'|'memory_mode'>&{sources:ProjectContextUseSource[]})|undefined
  if(!parent)return undefined
  const project=parent.project_id?await this.project(db,owner,parent.project_id):null
  if(project&&!this.actorAllowed(actor,project.definition.scope))throw new WorkError('teloa/forbidden','派生工作的执行者不能读取项目业务。')
  await db.query(`insert into teloa_project_conversation_memberships(owner_id,session_id,project_id,version,memory_mode,generation,scope,title,inherited_sources) values($1,$2,$3,1,$4,1,$5,$6,$7) on conflict(owner_id,session_id) do nothing`,[owner,actor.sessionId,parent.project_id,parent.memory_mode,actor.scope,actor.title,JSON.stringify(parent.sources)])
  return (await db.query('select * from teloa_project_conversation_memberships where owner_id=$1 and session_id=$2',[owner,actor.sessionId])).rows[0] as MembershipRow
 }
 private actorAllowed(actor:ProjectRuntimeActor,scope:string){return actor.scope===scope||(actor.kind!=='ordinary'&&actor.scopes?.includes(scope)===true)}
 async prepare(owner:string,input:{sessionId:string;messageId:string;query:string;requestId?:string;purpose?:'input'|'extraction'|'check';parentSessionId?:string;parentMessageId?:string;signal?:AbortSignal}):Promise<ProjectRuntimePrepared|null>{
  ownerKey(owner);projectRuntimeSession(input.sessionId);if(!input.messageId||input.messageId.length>128||typeof input.query!=='string')throw new WorkError('teloa/invalid-input','项目上下文缺少真实消息身份。')
  if(input.requestId!==undefined&&(typeof input.requestId!=='string'||!input.requestId||input.requestId.length>256||/[\x00-\x1f]/.test(input.requestId))||input.purpose!==undefined&&!['input','extraction','check'].includes(input.purpose))throw new WorkError('teloa/invalid-input','项目输入请求身份不正确。')
  const actor=await this.ports.inspect(owner,input.sessionId);if(actor.sessionId!==input.sessionId)throw missing();input.signal?.throwIfAborted()
  const prepared=await this.tx(owner,async db=>{
   let row=(await db.query('select * from teloa_project_conversation_memberships where owner_id=$1 and session_id=$2 for update',[owner,input.sessionId])).rows[0] as MembershipRow|undefined
   const parentSessionId=actor.parentSessionId??(actor.kind==='subagent'||actor.kind==='task'?input.parentSessionId:undefined)
   if(!row&&parentSessionId)row=await this.inheritIn(db,owner,actor,parentSessionId,actor.parentMessageId??input.parentMessageId)
   if(!row)return null
   if(row.reset_pending&&row.project_id===null&&!actor.goal&&/^(?:继续|接着|继续吧|continue|go on)[。.!！\s]*$/iu.test(input.query)&&(await db.query("select 1 from teloa_project_context_uses where owner_id=$1 and session_id=$2 and stage='dispatched' limit 1",[owner,row.session_id])).rowCount)throw new WorkError('teloa/invalid-input','会话已移出项目，请重新说明需要继续的具体任务。')
   const sourceAllowed=(kind:ProjectContextUseSource['kind'],id:string,version:number,contentHash:string)=>actor.kind!=='subagent'||kind!=='personal'&&row!.inherited_sources?.some(s=>s.kind===kind&&s.id===id&&s.version===version&&s.hash===contentHash)===true
   const original=(await db.query("select project_id,binding_version from teloa_project_context_uses where owner_id=$1 and session_id=$2 and message_id=$3 and request_key<>'context-check' and request_key not like 'project-memory:%' order by created_at,id limit 1",[owner,input.sessionId,input.messageId])).rows[0]
   if(original&&(original.project_id!==row.project_id||original.binding_version!==row.version))throw new WorkError('teloa/conflict','原消息归属于此前的项目，请在当前项目重新提出任务。')
   const project=row.project_id?await this.project(db,owner,row.project_id):null
   if(project?.definition.state==='archived'&&input.purpose!=='check'&&input.purpose!=='extraction'&&!original&&(actor.kind==='ordinary'||actor.kind==='employee'))throw new WorkError('teloa/conflict','项目已归档，请先恢复项目再开始新工作。')
   if(project&&!this.actorAllowed(actor,project.definition.scope))throw new WorkError('teloa/forbidden','当前执行者不能读取项目业务。')
   const settings=row.project_id?await this.settingsIn(db,row.project_id):null
   const data=row.project_id?await new ProjectContextService(this.pool,this.identity).readInTransaction(db,owner,row.project_id,row.memory_mode==='enabled'):null
   const sources:ProjectContextUseSource[]=[],texts:Array<{source:ProjectContextUseSource;markdown:string}>=[],omitted:Array<{reason:string}>=[],resourceStates:string[]=[],optionalStates:Record<string,string>={},requiredStates:string[]=[]
   const render=(rows:Array<{source:ProjectContextUseSource;markdown:string}>)=>renderContext(rows,row!.memory_mode,project?.definition.state==='archived'?'paused':settings?.automatic??'decisions')
   const add=(kind:ProjectContextUseSource['kind'],id:string,version:number,title:string,markdown:string,contentHash=hash(markdown))=>{const source={kind,id,version,title,hash:contentHash};texts.push({source,markdown});sources.push(source)}
   if(project){add('project',project.id,project.version,project.definition.title,project.definition.goal);if(data!.brief)add('brief',project.id,data!.version,'项目简报',data!.brief)}
   if(actor.goal)add('project','task:'+actor.sessionId,1,'本次工作目标',actor.goal)
   for(const entry of data?.entries??[])if(entry.state==='active'&&entry.kind==='rule'){if(await this.ports.memoryAvailable?.(db,owner,{entryId:entry.id,entryVersion:entry.version})===false){entry.state='withdrawn';entry.markdown=null;entry.hash=null;omitted.push({reason:'自动规则的原始依据已失效'});continue}add('rule',entry.id,entry.version,entry.topic,entry.markdown!,entry.hash!)}
   const budget=this.ports.maxContextChars??32000
   for(const ref of settings?.resources??[]){
    try{
     if(!this.ports.resource)throw new WorkError('teloa/unavailable','项目资料读取尚未连接。')
     const resource=await this.ports.resource(db,owner,ref.resourceId,actor.scopes??[actor.scope]);if(resource.scopeIds.some(scope=>!this.actorAllowed(actor,scope)))throw new WorkError('teloa/forbidden','执行者无权读取所选资料。')
     resourceStates.push(resource.id+':'+resource.version+':'+resource.hash)
     if(ref.required){requiredStates.push(resource.id+':'+resource.version+':'+resource.hash);add('resource',resource.id,resource.version,resource.title,resource.markdown,resource.hash)}
     else{optionalStates['resource:'+ref.resourceId]=resource.id+':'+resource.version+':'+resource.hash
      if(sourceAllowed('resource',resource.id,resource.version,resource.hash)&&relevance(input.query,resource.title+' '+resource.markdown)>0&&render([...texts,{source:{kind:'resource',id:resource.id,version:resource.version,title:resource.title,hash:resource.hash},markdown:resource.markdown}]).length<=budget)add('resource',resource.id,resource.version,resource.title,resource.markdown,resource.hash)
      else omitted.push({reason:'按需资料未命中或超过本轮可选输入预算'})
     }
    }catch(error){resourceStates.push(ref.resourceId+':unavailable');if(ref.required)throw error;optionalStates['resource:'+ref.resourceId]='unavailable';omitted.push({reason:'按需资料当前不可用'})}
   }
   if(render(texts).length>budget)throw new WorkError('teloa/invalid-input','必要项目背景超过当前输入预算，请缩小必读范围。')
   if(row.memory_mode==='enabled'){
    const optional:Array<{kind:'memory'|'share'|'role'|'personal';id:string;version:number;title:string;markdown:string;hash:string;score:number}>=[]
    for(const entry of data?.entries??[])if(entry.state==='active'&&entry.kind==='memory'&&sourceAllowed('memory',entry.id,entry.version,entry.hash!)){if(await this.ports.memoryAvailable?.(db,owner,{entryId:entry.id,entryVersion:entry.version})===false){omitted.push({reason:'自动记忆的原始依据已失效'});continue}optionalStates['memory:'+entry.id]=entry.version+':'+entry.hash;optional.push({kind:'memory',id:entry.id,version:entry.version,title:entry.topic,markdown:entry.markdown!,hash:entry.hash!,score:relevance(input.query,entry.topic+' '+entry.markdown!)})}
    for(const share of data?.shares??[])if(share.targetProjectId===row.project_id&&share.status==='active'){
     const source=await this.project(db,owner,share.sourceProjectId);if(!this.actorAllowed(actor,source.definition.scope)){omitted.push({reason:'共享来源不在当前执行者业务范围'});continue}
     if(await this.ports.memoryAvailable?.(db,owner,{entryId:share.entryId,entryVersion:share.entryVersion})===false){omitted.push({reason:'共享记忆的原始依据已失效'});continue}
     if(sourceAllowed('share',share.id,share.entryVersion,share.hash!)){optionalStates['share:'+share.id]=share.entryVersion+':'+share.hash;optional.push({kind:'share',id:share.id,version:share.entryVersion,title:share.topic!,markdown:share.markdown!,hash:share.hash!,score:relevance(input.query,share.topic+' '+share.markdown!)})}
    }
    const other=[...await this.ports.optionalMemories?.(db,owner,actor,'',false)??[]]
    if(settings?.readPersonal&&actor.kind!=='subagent'){const personal=await new ProjectPersonalMemoryService(this.pool,this.identity).readInTransaction(db,owner);for(const entry of personal.entries)other.push({kind:'personal',id:entry.id,version:entry.version,title:entry.topic,markdown:entry.markdown,hash:hash(entry.markdown),scopeIds:[]})}
    for(const entry of other){
     if(entry.kind==='personal'&&!settings?.readPersonal||entry.scopeIds.some(scope=>!this.actorAllowed(actor,scope))||!sourceAllowed(entry.kind,entry.id,entry.version,entry.hash))continue
     optionalStates[entry.kind+':'+entry.id]=entry.version+':'+entry.hash
     optional.push({kind:entry.kind,id:entry.id,version:entry.version,title:entry.title,markdown:entry.markdown,hash:entry.hash,score:relevance(input.query,entry.title+' '+entry.markdown)})
    }
    const selected=new Set<string>()
    for(const entry of optional.sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id))){const key=entry.hash;if(entry.score<=0){omitted.push({reason:'可选记忆与当前问题不相关'});continue}if(selected.has(key))continue;const source={kind:entry.kind,id:entry.id,version:entry.version,title:entry.title,hash:entry.hash};if(render([...texts,{source,markdown:entry.markdown}]).length>budget){omitted.push({reason:'可选记忆超过本轮输入预算'});continue}selected.add(key);add(entry.kind,entry.id,entry.version,entry.title,entry.markdown,entry.hash)}
   }else omitted.push({reason:'本会话不读写长期记忆'})
   const contextVersion=data?.version??0,settingsVersion=settings?.version??0
   const sourceState:SourceState={mandatory:hash(JSON.stringify({projectId:row.project_id,goal:project?.definition.goal??null,brief:data?.brief??'',rules:data?.entries.filter(e=>e.kind==='rule'&&e.state==='active').map(e=>[e.id,e.version,e.hash]),requiredStates:requiredStates.sort(),memoryMode:row.memory_mode,actor:{scope:actor.scope,roleId:actor.roleId??null,scopes:[...(actor.scopes??[])].sort(),goal:actor.goal??null}})),optional:Object.fromEntries(Object.entries(optionalStates).sort(([a],[b])=>a.localeCompare(b)))}
   const fingerprint=hash(JSON.stringify({sourceState,contextVersion,settingsVersion,resourceStates:resourceStates.sort()}))
   let generation=row.generation,reset=row.reset_pending
   if(row.fingerprint!==fingerprint){const clean=!!row.fingerprint&&(row.source_state?.mandatory!==sourceState.mandatory||Object.entries(row.source_state?.optional??{}).some(([key,value])=>sourceState.optional?.[key]!==value));if(clean)generation++;reset=reset||clean||!row.fingerprint;await db.query('update teloa_project_conversation_memberships set fingerprint=$3,generation=$4,context_version=$5,settings_version=$6,reset_pending=$7,source_state=$8 where owner_id=$1 and session_id=$2',[owner,row.session_id,fingerprint,generation,contextVersion,settingsVersion,reset,sourceState]);invalidate(this.pool,owner,row.session_id)}
   // 客户端 rpcId 永远不能占用内部检查/提炼命名空间。
   const requestKey=input.purpose==='check'?'context-check':input.purpose==='extraction'?'project-memory:'+(input.requestId??input.messageId):'input:'+(input.requestId??input.messageId)
   // 同代次历史回复、工具和摘要仍可能携带此前背景；来源清单保留完整依赖。
   const prior=(await db.query("select sources from teloa_project_context_uses where owner_id=$1 and session_id=$2 and generation=$3 and stage='dispatched' and request_key<>'context-check' and request_key not like 'project-memory:%'",[owner,row.session_id,generation])).rows
   const sourceKeys=new Set(sources.map(s=>JSON.stringify([s.kind,s.id,s.version,s.hash])))
   for(const previous of prior)for(const source of previous.sources as ProjectContextUseSource[]){const key=JSON.stringify([source.kind,source.id,source.version,source.hash]);if(!sourceKeys.has(key)){sources.push(source);sourceKeys.add(key)}}
   if(sources.length>500){generation++;reset=true;sources.splice(0,sources.length,...texts.map(t=>t.source));await db.query('update teloa_project_conversation_memberships set generation=$3,reset_pending=true where owner_id=$1 and session_id=$2',[owner,row.session_id,generation]);invalidate(this.pool,owner,row.session_id)}
   const use=requestKey==='context-check'?{id:this.identity.id()}:(await db.query(`insert into teloa_project_context_uses(id,owner_id,session_id,message_id,project_id,binding_version,generation,memory_mode,sources,omitted,created_at,request_key,settings_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict(owner_id,session_id,message_id,generation,request_key) do update set sources=excluded.sources,omitted=excluded.omitted returning id`,[this.identity.id(),owner,input.sessionId,input.messageId,row.project_id,row.version,generation,row.memory_mode,JSON.stringify(sources),JSON.stringify(omitted.slice(0,500)),this.identity.now(),requestKey,settingsVersion])).rows[0]
   input.signal?.throwIfAborted()
   return {binding:{...membership({...row,generation}),contextVersion,settingsVersion},manifestId:use.id,text:render(texts),sources,reset,providerSessionId:'teloa-project-'+hash(owner+'\0'+row.session_id+'\0'+generation).slice(0,40)}
  })
  if(prepared)this.tokens.set(prepared,{owner,epoch:this.epochs.get(owner)??0,sessionEpoch:this.sessionEpochs.get(owner+'\0'+input.sessionId)??0,projectEpoch:this.projectEpochs.get(owner+'\0'+prepared.binding.projectId)??0})
  return prepared
 }
 assertPreparedCurrentSync(owner:string,prepared:ProjectRuntimePrepared){const token=this.tokens.get(prepared);if(!token||token.owner!==owner||token.epoch!==(this.epochs.get(owner)??0)||token.sessionEpoch!==(this.sessionEpochs.get(owner+'\0'+prepared.binding.sessionId)??0)||token.projectEpoch!==(this.projectEpochs.get(owner+'\0'+prepared.binding.projectId)??0))throw stale()}
 async assertCurrent(owner:string,input:{sessionId:string;projectId:string|null;bindingVersion:number;generation:number;contextVersion:number;settingsVersion:number;signal?:AbortSignal}){
  input.signal?.throwIfAborted();const fresh=await this.prepare(owner,{sessionId:input.sessionId,messageId:'context-check',query:'',purpose:'check',...(input.signal?{signal:input.signal}:{})})
  if(!fresh||fresh.binding.projectId!==input.projectId||fresh.binding.version!==input.bindingVersion||fresh.binding.generation!==input.generation||fresh.binding.contextVersion!==input.contextVersion||fresh.binding.settingsVersion!==input.settingsVersion)throw stale()
 }
 async ackGeneration(owner:string,input:{sessionId:string;generation:number}){ownerKey(owner);const r=await this.pool.query('update teloa_project_conversation_memberships set reset_pending=false where owner_id=$1 and session_id=$2 and generation=$3',[owner,input.sessionId,input.generation]);if(r.rowCount!==1)throw stale()}
 async messageSnapshot(owner:string,sessionId:string,messageId:string,db?:PoolClient){ownerKey(owner);const row=(await (db??this.pool).query("select * from teloa_project_context_uses where owner_id=$1 and session_id=$2 and message_id=$3 and stage='dispatched' and request_key<>'context-check' and request_key not like 'project-memory:%' order by created_at,id limit 1",[owner,sessionId,messageId])).rows[0];return row?{projectId:row.project_id as string|null,bindingVersion:row.binding_version as number,generation:row.generation as number,settingsVersion:row.settings_version as number,memoryMode:row.memory_mode as ProjectMemoryMode,sources:row.sources as ProjectContextUseSource[]}:null}
 async recordUsed(owner:string,input:{manifestId:string;promptHash:string;generation:number;stage?:'prepared'|'dispatched'|'failed';signal?:AbortSignal}){
  ownerKey(owner);projectRuntimeUuid(input.manifestId);if(!/^[a-f0-9]{64}$/.test(input.promptHash))throw new WorkError('teloa/invalid-input','模型输入摘要无效。');input.signal?.throwIfAborted()
  await this.tx(owner,async db=>{const use=(await db.query('select * from teloa_project_context_uses where id=$1 and owner_id=$2',[input.manifestId,owner])).rows[0];if(!use||use.generation!==input.generation)throw stale();const binding=(await db.query('select * from teloa_project_conversation_memberships where owner_id=$1 and session_id=$2',[owner,use.session_id])).rows[0];if(!binding||binding.generation!==input.generation||binding.version!==use.binding_version)throw stale();await db.query('update teloa_project_context_uses set prompt_hash=$3,stage=$4 where id=$1 and owner_id=$2',[input.manifestId,owner,input.promptHash,input.stage??'dispatched'])})
 }
 async uses(owner:string,input:unknown){const r=projectInput(input,['projectId','sessionId']),id=projectRuntimeUuid(r.projectId);if(r.sessionId!==undefined)projectRuntimeSession(r.sessionId);return this.tx(owner,async db=>{await this.project(db,owner,id);const rows=(await db.query("select * from teloa_project_context_uses where owner_id=$1 and project_id=$2 and stage='dispatched' and ($3::text is null or session_id=$3) order by created_at desc,id desc limit 100",[owner,id,r.sessionId??null])).rows;const data=await new ProjectContextService(this.pool,this.identity).readInTransaction(db,owner,id)
   const actors=new Map<string,ProjectRuntimeActor|null>(),roles=new Map<string,ProjectRuntimeResourceContent[]>(),personal=rows.some(row=>(row.sources as ProjectContextUseSource[]).some(s=>s.kind==='personal'))?await new ProjectPersonalMemoryService(this.pool,this.identity).readInTransaction(db,owner):{entries:[]},manifests:ProjectContextUseManifest[]=[]
   for(const row of rows){
    const sources:ProjectContextUseSource[]=[]
    for(const source of row.sources as ProjectContextUseSource[]){
     let unavailable=(source.kind==='rule'||source.kind==='memory')&&!data.entries.some(e=>e.id===source.id&&e.state==='active')||source.kind==='share'&&!data.shares.some(e=>e.id===source.id&&e.status==='active')
     if(!unavailable&&(source.kind==='rule'||source.kind==='memory'))unavailable=await this.ports.memoryAvailable?.(db,owner,{entryId:source.id,entryVersion:source.version})===false
     if(!unavailable&&source.kind==='share'){const share=data.shares.find(e=>e.id===source.id)!;unavailable=await this.ports.memoryAvailable?.(db,owner,{entryId:share.entryId,entryVersion:share.entryVersion})===false}
     if(source.kind==='personal')unavailable=!personal.entries.some(e=>e.id===source.id&&e.version===source.version&&hash(e.markdown)===source.hash)
     if(source.kind==='resource'||source.kind==='role'){
      if(!actors.has(row.session_id)){try{actors.set(row.session_id,await this.ports.inspect(owner,row.session_id))}catch{actors.set(row.session_id,null)}}
      const actor=actors.get(row.session_id)
      if(!actor)unavailable=true
      else try{
       if(source.kind==='resource'){if(!this.ports.resource)unavailable=true;else{const resource=await this.ports.resource(db,owner,source.id,actor.scopes??[actor.scope]);unavailable=resource.scopeIds.some(scope=>!this.actorAllowed(actor,scope))}}
       else{if(!roles.has(row.session_id))roles.set(row.session_id,await this.ports.optionalMemories?.(db,owner,actor,'',false)??[]);unavailable=!roles.get(row.session_id)!.some(e=>e.id===source.id&&e.version===source.version&&e.hash===source.hash&&e.scopeIds.every(scope=>this.actorAllowed(actor,scope)))}
      }catch{unavailable=true}
     }
     sources.push(unavailable?{...source,title:'已失效来源'}:source)
    }
    manifests.push(readContextUseManifest({id:row.id,sessionId:row.session_id,messageId:row.message_id,projectId:row.project_id,bindingVersion:row.binding_version,generation:row.generation,memoryMode:row.memory_mode,createdAt:row.created_at.toISOString(),sources,omitted:row.omitted}))
   }
   return {rows:manifests}
  })}
 async history(owner:string,input:unknown){
  const r=projectInput(input,['projectId','cursor','limit']),id=projectRuntimeUuid(r.projectId),limit=r.limit===undefined?50:projectRuntimeVersion(r.limit,1)
  if(limit>100||r.cursor!==undefined&&r.cursor!==null&&(typeof r.cursor!=='string'||!/^[es]:[a-f0-9-]{36}$/.test(r.cursor)))throw new WorkError('teloa/invalid-input','项目历史分页格式不正确。')
  return this.tx(owner,async db=>{
   await this.project(db,owner,id)
   const all=(await db.query(`select key from(select 'e:'||id::text key from teloa_project_context_entries where project_id=$1 and state='withdrawn' union all select 's:'||s.id::text from teloa_project_context_shares s join teloa_project_context_entries e on e.id=s.entry_id where (s.source_project_id=$1 or s.target_project_id=$1) and (s.revoked or e.state='withdrawn')) h where ($2::text is null or key>$2) order by key limit $3`,[id,r.cursor??null,limit+1])).rows.map(x=>x.key as string)
   const keys=all.slice(0,limit),entryIds=keys.filter(x=>x.startsWith('e:')).map(x=>x.slice(2)),shareIds=keys.filter(x=>x.startsWith('s:')).map(x=>x.slice(2))
   const entries=(await db.query('select id,kind,topic,version,state from teloa_project_context_entries where project_id=$1 and id=any($2::uuid[]) order by id',[id,entryIds])).rows.map(e=>({...e,markdown:null,hash:null}))
   const shares=(await db.query(`select s.id,s.source_project_id,s.target_project_id,s.entry_id,s.entry_version,s.revoked,e.state,src.definition->>'title' source_title,dst.definition->>'title' target_title from teloa_project_context_shares s join teloa_project_context_entries e on e.id=s.entry_id left join teloa_projects src on src.id=s.source_project_id and src.owner_id=$1 left join teloa_projects dst on dst.id=s.target_project_id and dst.owner_id=$1 where s.id=any($2::uuid[]) and (s.source_project_id=$3 or s.target_project_id=$3) order by s.id`,[owner,shareIds,id])).rows.map(s=>({id:s.id,sourceProjectId:s.source_project_id,targetProjectId:s.target_project_id,entryId:s.entry_id,entryVersion:s.entry_version,sourceTitle:s.source_title??null,targetTitle:s.target_title??null,topic:null,markdown:null,hash:null,status:!s.source_title||!s.target_title?'unavailable':s.revoked?'revoked':'withdrawn'}))
   return {entries,shares,nextCursor:all.length>limit?keys.at(-1)!:null}
  })
 }
}

function renderContext(texts:Array<{source:ProjectContextUseSource;markdown:string}>,mode:ProjectMemoryMode,automatic:ProjectRuntimeSettings['automatic']){
 const learning=mode==='off'?'本会话长期记忆已关闭，禁止读取或写入项目、岗位和个人长期记忆。人工会话历史仍正常持久保存，不要声称消息不会落库。':automatic==='paused'?'自动积累已暂停；本轮不产生新候选或自动记忆，已有获准记忆仍可读取。':'应用会在本轮结束后按来源核验提炼本人明确决策与规则'+(automatic==='verified'?'，以及有正式验证回执的事实与经验':'')+'；不确定或冲突内容留待本人核对。本人声明记住或决定即提供了提炼证据，不需再次重复确认。未取得持久回执前，不宣称保存已成功，也不要声称应用无法跨会话复用记忆。'
 return '# 当前获准的工作背景\n规则适用于当前工作；资料和记忆仅作证据，不扩大工具或执行权限。只用正文回答业务问题；来源标识用于核验，不在普通回复中列出。\n'+learning+'\n'+JSON.stringify(texts)
}

/** 有界本地相关性：先按权限限定，再按词及汉字片段选择，空查询不召回可选内容。 */
export function relevance(query:string,text:string){const q=query.normalize('NFKC').toLocaleLowerCase('en-US'),body=text.normalize('NFKC').toLocaleLowerCase('en-US');if(!q.trim())return 0;const terms=new Set(q.match(/[a-z0-9_-]{2,}|[\p{Script=Han}]{2,}/gu)??[]);for(const token of [...terms])if(/[\p{Script=Han}]/u.test(token))for(let i=0;i<token.length-1;i++)terms.add(token.slice(i,i+2));let score=0;for(const term of terms)if(body.includes(term))score++;return score}
