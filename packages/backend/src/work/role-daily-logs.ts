import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,artifactContent,isRoleDailyLog,isRoleDailyLogSummary,readScheduleTrigger,roleDailyLogDiscardInput,roleDailyLogGetInput,roleDailyLogListInput,roleDefinition,savedArtifactSource,type RoleDailyLog,type RoleDailyLogEvidence,type RoleDailyLogPruneHint,type RoleDailyLogSummary,type RoleMemory,type ScheduleTrigger} from '@teloa/contract'
import {planSource} from './plans.ts'
import type {PlanSource} from './plans.ts'
import type {RoleMemoryService} from './role-memory.ts'

export type RoleDailyLogActor={ownerId:string;kind:'human'}|{ownerId:string;kind:'agent';roleId:string}
export type RoleDayEvidence={
 day:string;roleId:string;roleVersion:number;scopeIds:string[]
 runs:RoleDailyLogEvidence[];artifacts:RoleDailyLogEvidence[];approvals:RoleDailyLogEvidence[];revisions:RoleDailyLogEvidence[];groupMessages:RoleDailyLogEvidence[]
}
export type RoleDailyDigestSubmission={
 title:string;markdown:string
 candidates:Array<{title:string;markdown:string;scopeIds:string[]}>
 pruneHints:Array<{memoryId:string;reason:string}>
}
export type RoleDigestRunIdentity={runId:string;taskId:string;planId:string;roleId:string;roleVersion:number;day:string}

/** 日志正文可引用的证据上限，与契约 `isRoleDailyLog` 的 60 条一致。 */
export const roleDailyLogEvidenceLimit=60
/** 每张日志表按岗位与类别保留最近 60 个自然日。 */
export const roleDailyLogRetentionDays=60
/** `role-daily-log/list` 的回包上限，与保留天数各自独立。 */
export const roleDailyLogListLimit=60
/** 一次小结最多三条候选与三条剪枝建议，超出整次拒绝。 */
export const roleDailyDigestProposalLimit=3
/** 日志正文按 UTF-8 字节计，与契约 `isRoleDailyLog` 同口径。 */
export const roleDailyLogMarkdownBytes=16000
/** 记忆候选正文上限，与 `role-memory.ts` 的 `markdown()` 同口径。 */
const roleMemoryMarkdownBytes=128*1024

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const scope=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
/** 与契约 `role-daily-log.ts` 的 `day()` 逐字同判据（契约没有导出它）：正则加一次 ISO 往返。 */
const isDay=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)===value
const invalid=()=>new WorkError('teloa/invalid-input','每日日志请求包含未知字段或格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','每日日志记录损坏，已停止读取。')
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid()
 return value as Record<string,unknown>
}
const text=(value:unknown,max:number):string=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw invalid();return value.trim()}
/** 日志正文：先去首尾空白，再按 UTF-8 字节判上限——契约判的是字节，按字符判会让中文正文先插库再被判损坏。 */
const logMarkdown=(value:unknown):string=>{
 const trimmed=text(value,roleDailyLogMarkdownBytes)
 if(Buffer.byteLength(trimmed,'utf8')>roleDailyLogMarkdownBytes)throw invalid()
 return trimmed
}
/** 候选正文：与 `role-memory.ts` 的 `markdown()` 逐字同口径，先归一再判字节与往返，保证候选不会在日志落库后才被拒。 */
const memoryMarkdown=(value:unknown):string=>{
 if(typeof value!=='string')throw invalid()
 const normalized=value.replace(/^\ufeff/,'').replace(/\r\n?/g,'\n'),bytes=Buffer.from(normalized,'utf8')
 if(!normalized.trim()||bytes.length>roleMemoryMarkdownBytes||bytes.toString('utf8')!==normalized)throw invalid()
 return normalized
}
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const principal=(value:RoleDailyLogActor):RoleDailyLogActor=>{
 if(!value||typeof value.ownerId!=='string'||!value.ownerId.trim()||value.ownerId.length>128||!['human','agent'].includes(value.kind)||value.kind==='agent'&&!uuid(value.roleId))throw new WorkError('teloa/forbidden','需要可核验的本人或员工身份。')
 return value
}
/** 证据标题固定 200 字上限（契约判据），拼接后过长时截到上限，不丢条目。 */
const label=(value:string):string=>value.length>200?value.slice(0,200):value
const logColumns=['id','owner_id','role_id','role_version','kind',"to_char(day,'YYYY-MM-DD') as day",'state','run_id','title','markdown','scope_ids','evidence','prune_hints','created_at','discarded_at'] as const
const selectLog=(extra:readonly string[]=[]):string=>'select '+[...extra,...logColumns].join(',')+' from teloa_role_daily_logs'

function readLog(row:Record<string,unknown>|undefined):RoleDailyLog{
 if(!row)throw corrupt()
 const value={
  id:row.id,ownerId:row.owner_id,roleId:row.role_id,roleVersion:row.role_version,kind:row.kind,day:row.day,state:row.state,
  runId:row.run_id===undefined?null:row.run_id,title:row.title,markdown:row.markdown,
  scopeIds:row.scope_ids,evidence:row.evidence,pruneHints:row.prune_hints,
  createdAt:stamp(row.created_at),discardedAt:row.discarded_at===null||row.discarded_at===undefined?null:stamp(row.discarded_at)
 }
 if(!isRoleDailyLog(value))throw corrupt()
 return value
}

function submission(value:unknown):RoleDailyDigestSubmission{
 const row=exact(value,['title','markdown','candidates','pruneHints'])
 if(!Array.isArray(row.candidates)||!Array.isArray(row.pruneHints))throw invalid()
 // 超额整次拒绝，不截断：截断等于服务端替模型挑。
 if(row.candidates.length>roleDailyDigestProposalLimit||row.pruneHints.length>roleDailyDigestProposalLimit)throw invalid()
 const candidates=row.candidates.map(item=>{
  const candidate=exact(item,['title','markdown','scopeIds'])
  if(!Array.isArray(candidate.scopeIds)||!candidate.scopeIds.length||candidate.scopeIds.length>30||!candidate.scopeIds.every(scope)||new Set(candidate.scopeIds).size!==candidate.scopeIds.length)throw invalid()
  return {title:text(candidate.title,120),markdown:memoryMarkdown(candidate.markdown),scopeIds:[...candidate.scopeIds as string[]]}
 })
 const pruneHints=row.pruneHints.map(item=>{
  const hint=exact(item,['memoryId','reason']);if(!uuid(hint.memoryId))throw invalid()
  return {memoryId:hint.memoryId as string,reason:text(hint.reason,2000)}
 })
 if(new Set(pruneHints.map(hint=>hint.memoryId)).size!==pruneHints.length)throw invalid()
 return {title:text(row.title,120),markdown:logMarkdown(row.markdown),candidates,pruneHints}
}

/** 同一次运行重放不会重复建候选：请求身份由 owner + 运行 + 日期 + 序号派生。 */
function derivedRequestId(ownerId:string,identity:RoleDigestRunIdentity,index:number):string{
 const digest=createHash('sha256').update('teloa-daily-digest/v1'+ownerId+identity.runId+identity.day+index).digest('hex')
 const variant=((parseInt(digest.slice(16,17),16)&0x3)|0x8).toString(16)
 return `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-${variant}${digest.slice(17,20)}-${digest.slice(20,32)}`
}

export async function initializeRoleDailyLogs(pool:Pool):Promise<void>{await pool.query(`
 create unique index if not exists teloa_roles_owner_identity on teloa_roles(id,owner_id);
 create table if not exists teloa_role_daily_logs(
  id uuid not null,owner_id text not null,role_id uuid not null,role_version integer not null check(role_version>0),
  kind text not null check(kind in ('daily-digest','habit-digest')),day date not null,
  state text not null check(state in ('kept','discarded')),run_id uuid,
  title text not null,markdown text not null,
  scope_ids jsonb not null check(jsonb_typeof(scope_ids)='array'),
  evidence jsonb not null check(jsonb_typeof(evidence)='array'),
  prune_hints jsonb not null check(jsonb_typeof(prune_hints)='array'),
  request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  created_at timestamptz not null,discarded_at timestamptz,
  primary key(owner_id,id),unique(owner_id,request_id),unique(owner_id,role_id,kind,day),
  foreign key(role_id,owner_id) references teloa_roles(id,owner_id),
  check((kind='habit-digest' and run_id is null) or (kind='daily-digest' and run_id is not null)),
  check((state='kept' and discarded_at is null) or (state='discarded' and discarded_at is not null))
 );
 create index if not exists teloa_role_daily_logs_order on teloa_role_daily_logs(owner_id,role_id,day desc,id);
 create table if not exists teloa_role_daily_log_changes(
  owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  log_id uuid not null,result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null,
  primary key(owner_id,request_id),foreign key(owner_id,log_id) references teloa_role_daily_logs(owner_id,id)
 );
 create or replace function teloa_reject_role_daily_log_change_mutation() returns trigger language plpgsql as $$ begin raise exception 'role daily log changes are immutable'; end $$;
 drop trigger if exists teloa_role_daily_log_changes_immutable on teloa_role_daily_log_changes;
 create trigger teloa_role_daily_log_changes_immutable before update or delete on teloa_role_daily_log_changes for each row execute function teloa_reject_role_daily_log_change_mutation();
`)}

type ScopedEvidence={item:RoleDailyLogEvidence;scope?:string}

export class RoleDailyLogService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 readonly memory:Pick<RoleMemoryService,'remember'>
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},memory:Pick<RoleMemoryService,'remember'>){this.pool=pool;this.identity=identity;this.memory=memory}

 private async role(db:Pick<Pool,'query'>,ownerId:string,roleId:string,lock=false):Promise<{version:number;state:string;scopes:string[]}>{
  const row=(await db.query('select version,state,definition from teloa_roles where owner_id=$1 and id=$2'+(lock?' for share':''),[ownerId,roleId])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','员工不存在或不属于当前本人。')
  let scopes:string[];try{scopes=roleDefinition(row.definition).scopes}catch{throw corrupt()}
  return {version:Number(row.version),state:String(row.state),scopes}
 }

 /**
  * 闸的唯一真源：run → task → plan_task_links → plan_occurrences → plans.source。
  * 任一跳断链、来源不是本岗位的 `system-digest`、或领取身份读不出日期，一律返回 null（拒），不放行。
  */
 async digestRun(ownerId:string,input:{runId:string}):Promise<RoleDigestRunIdentity|null>{
  if(typeof ownerId!=='string'||!ownerId.trim()||!input||!uuid(input.runId))return null
  const row=(await this.pool.query(`select r.id as run_id,r.task_id,r.role_id,r.role_version,o.occurrence_id,o.scheduled_at,p.id as plan_id,p.source,p.definition
   from teloa_task_runs r
   join teloa_plan_task_links l on l.task_id=r.task_id and l.owner_id=r.owner_id
   join teloa_plan_occurrences o on o.id=l.claim_id and o.owner_id=r.owner_id
   join teloa_plans p on p.id=o.plan_id and p.owner_id=r.owner_id
   where r.owner_id=$1 and r.id=$2`,[ownerId,input.runId])).rows[0]
  if(!row)return null
  let plan:PlanSource;try{plan=planSource(row.source)}catch{return null}
  if(plan.kind!=='system-digest'||plan.roleId!==row.role_id)return null
  // 定时领取的 occurrenceId 形如 2026-09-21T23:30[Asia/Singapore]，日期直接取前十位；
  // 立即运行（plans/trigger）领取的形如 manual:<taskRequestId>，不带日期，改按领取时刻折算成计划时区的当天。
  // 两条路径的日期都由服务端的领取记录固定，模型不能传参选别的天。
  let day=String(row.occurrence_id).slice(0,10)
  if(!isDay(day)){
   if(!(row.scheduled_at instanceof Date))return null
   // 时区白名单的唯一真源是契约 `readScheduleTrigger`，本文件不另抄一份。
   let timezone:ScheduleTrigger['timezone']
   try{timezone=readScheduleTrigger((row.definition as Record<string,unknown>).trigger).timezone}catch{return null}
   day=String((await this.pool.query("select to_char(($1::timestamptz at time zone $2)::date,'YYYY-MM-DD') as day",[row.scheduled_at,timezone])).rows[0]?.day)
  }
  if(!isDay(day))return null
  return {runId:row.run_id,taskId:row.task_id,planId:row.plan_id,roleId:row.role_id,roleVersion:Number(row.role_version),day}
 }

 /** 任一类读不出即抛 `teloa/storage-corrupt`，不以空数组糊弄；五类全空抛 `teloa/source-unavailable`。 */
 async dayEvidence(ownerId:string,identity:RoleDigestRunIdentity):Promise<RoleDayEvidence>{
  const plan=(await this.pool.query('select definition from teloa_plans where owner_id=$1 and id=$2',[ownerId,identity.planId])).rows[0]
  if(!plan)throw new WorkError('teloa/forbidden','持续计划不存在或不属于当前本人。')
  if(!isDay(identity.day))throw invalid()
  // 时区白名单的唯一真源是契约 `readScheduleTrigger`，本文件不另抄一份。
  let timezone:ScheduleTrigger['timezone']
  try{timezone=readScheduleTrigger((plan.definition as Record<string,unknown>).trigger).timezone}catch{throw corrupt()}
  const bounds=(await this.pool.query('select ($1::date)::timestamp at time zone $2 as from_at,(($1::date)+interval \'1 day\')::timestamp at time zone $2 as to_at',[identity.day,timezone])).rows[0]
  const from=bounds?.from_at,to=bounds?.to_at
  if(!(from instanceof Date)||!(to instanceof Date))throw corrupt()
  const read=async<T>(work:()=>Promise<T>):Promise<T>=>{try{return await work()}catch(error){if(error instanceof WorkError)throw error;throw corrupt()}}

  const runRows=await read(async()=>(await this.pool.query(`select r.id,t.definition->>'title' as title,t.definition->>'scope' as scope
   from teloa_task_runs r join teloa_tasks t on t.id=r.task_id
   where r.owner_id=$1 and r.role_id=$2 and r.created_at>=$3 and r.created_at<$4 order by r.created_at,r.id`,[ownerId,identity.roleId,from,to])).rows)
  const runs:ScopedEvidence[]=runRows.map(row=>{
   if(!uuid(row.id)||typeof row.title!=='string'||!row.title.trim()||!scope(row.scope))throw corrupt()
   return {item:{kind:'run' as const,id:row.id as string,version:1,title:label('运行：'+row.title)},scope:row.scope}
  })
  const runIds=runs.map(entry=>entry.item.id)

  const artifactRows=await read(async()=>(await this.pool.query(`select artifact_id,number,source,content from teloa_artifact_versions
   where owner_id=$1 and source->>'kind'='run' and source->>'id'=any($2::text[]) order by artifact_id,number`,[ownerId,runIds])).rows)
  const artifacts=latest(artifactRows.map(row=>{
   let title:string,fixed:string
   try{title=artifactContent(row.content).title;fixed=savedArtifactSource(row.source).scope}catch{throw corrupt()}
   if(!uuid(row.artifact_id)||!Number.isSafeInteger(row.number)||Number(row.number)<1||!scope(fixed))throw corrupt()
   return {item:{kind:'artifact' as const,id:row.artifact_id as string,version:Number(row.number),title:label(title)},scope:fixed}
  }))

  const present=await read(async()=>(await this.pool.query('select name from unnest($1::text[]) as name where to_regclass(name) is not null',[['teloa_security_approvals','teloa_security_actions']])).rows.length)
  if(present!==2)throw corrupt()
  // 审批的时间窗判在 `teloa_security_approvals.created_at` 上（决定发生的时刻），不看发起动作或所属运行的时刻。
  const approvalRows=await read(async()=>(await this.pool.query(`select distinct a.id,a.decision,a.frozen,s.title,s.scope_id
   from teloa_security_approvals a
   join teloa_security_actions s on s.id=a.action_id and s.owner_id=a.owner_id
   join teloa_task_runs r on r.task_id=s.task_id and r.owner_id=s.owner_id
   where a.owner_id=$1 and r.role_id=$2 and a.created_at>=$3 and a.created_at<$4 order by a.id`,[ownerId,identity.roleId,from,to])).rows)
  const approvals:ScopedEvidence[]=approvalRows.map(row=>{
   const frozen=row.frozen
   if(!uuid(row.id)||!['approved','rejected'].includes(String(row.decision))||typeof row.title!=='string'||!row.title.trim()||!scope(row.scope_id))throw corrupt()
   if(!frozen||typeof frozen!=='object'||Array.isArray(frozen))throw corrupt()
   return {item:{kind:'approval' as const,id:row.id as string,version:1,title:label((row.decision==='approved'?'允许：':'拒绝：')+row.title)},scope:row.scope_id}
  })

  const revisionRows=await read(async()=>(await this.pool.query(`select v.artifact_id,v.number,v.source,v.content from teloa_artifact_versions v
   where v.owner_id=$1 and v.created_at>=$3 and v.created_at<$4 and v.source->>'kind'<>'run'
   and exists(select 1 from teloa_artifact_versions f join teloa_task_runs r on r.id::text=f.source->>'id' and r.owner_id=f.owner_id
    where f.owner_id=v.owner_id and f.artifact_id=v.artifact_id and f.number=1 and f.source->>'kind'='run' and r.role_id=$2)
   order by v.artifact_id,v.number`,[ownerId,identity.roleId,from,to])).rows)
  // 只记指针不记正文：正文一律不取。
  const revisions=latest(revisionRows.map(row=>{
   let title:string,fixed:string
   try{title=artifactContent(row.content).title;fixed=savedArtifactSource(row.source).scope}catch{throw corrupt()}
   if(!uuid(row.artifact_id)||!Number.isSafeInteger(row.number)||Number(row.number)<1||!scope(fixed))throw corrupt()
   return {item:{kind:'revision' as const,id:row.artifact_id as string,version:Number(row.number),title:label(title)},scope:fixed}
  }))

  const messageRows=await read(async()=>(await this.pool.query(`select m.id,m.root_id,t.definition->>'scope' as scope
   from teloa_group_messages m left join teloa_tasks t on t.id=m.task_id
   where m.owner_id=$1 and m.author_id=$2 and m.created_at>=$3 and m.created_at<$4 order by m.created_at,m.id`,[ownerId,identity.roleId,from,to])).rows)
  const groupMessages:ScopedEvidence[]=messageRows.map(row=>{
   if(!uuid(row.id))throw corrupt()
   if(row.scope!==null&&row.scope!==undefined&&!scope(row.scope))throw corrupt()
   return {item:{kind:'group-message' as const,id:row.id as string,version:1,title:label('群回帖 · 话题 '+String(row.root_id??row.id).slice(0,8))},...(scope(row.scope)?{scope:row.scope}:{})}
  })

  const all=[...runs,...artifacts,...approvals,...revisions,...groupMessages]
  if(!all.length)throw new WorkError('teloa/source-unavailable','今天没有可核对的工作证据，本次小结不产出。')
  // 先切到 60 条，再从留下的条目汇出范围：范围必须和日志里真正引用到的证据一致。
  const kept=all.slice(0,roleDailyLogEvidenceLimit),keys=new Set(kept.map(entry=>entry.item.kind+'\0'+entry.item.id))
  const pick=(list:ScopedEvidence[])=>list.filter(entry=>keys.has(entry.item.kind+'\0'+entry.item.id)).map(entry=>entry.item)
  const scopeIds=[...new Set(kept.flatMap(entry=>entry.scope?[entry.scope]:[]))].sort().slice(0,30)
  return {day:identity.day,roleId:identity.roleId,roleVersion:identity.roleVersion,scopeIds,runs:pick(runs),artifacts:pick(artifacts),approvals:pick(approvals),revisions:pick(revisions),groupMessages:pick(groupMessages)}
 }

 /** 一个请求身份落一条日志；候选与剪枝建议先全部核对，任一不成立整次拒绝，库里零残留。 */
 async submitDigest(ownerId:string,identity:RoleDigestRunIdentity,requestId:string,value:unknown):Promise<{log:RoleDailyLog;candidates:RoleMemory[]}>{
  if(typeof ownerId!=='string'||!ownerId.trim()||ownerId.length>128)throw new WorkError('teloa/forbidden','需要可核验的本人身份。')
  if(!uuid(requestId))throw invalid()
  const spec=submission(value)
  // 闸的唯一真源是 digestRun：调用方给的身份必须与当场重算的结果一致，不信任传进来的岗位、计划与日期。
  // 深比跑在写事务之外（digestRun 走 this.pool，不在下面那条连接的快照里），所以分两级：
  // 入口只复判 runId／roleId／day 这三个不随本人改计划而变的维度，保证回执命中时候选一定补得齐；
  // 未在回执路径复判的维度只有 plans.source 指向的计划身份，后果上限是本人自己多落一条自己的日志，
  // 越不到别人的岗位、也越不到别的日期。首次落库路径在事务里做全量深比。
  const who=identity&&typeof identity==='object'?await this.digestRun(ownerId,{runId:identity.runId}):null
  if(!who||who.runId!==identity.runId||who.roleId!==identity.roleId||who.day!==identity.day)
   throw new WorkError('teloa/forbidden','本次小结的运行身份与计划来源不一致。')
  const db=await this.pool.connect()
  let log:RoleDailyLog
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['role-daily-log-submit',ownerId,requestId])])
   // 回执在证据之前判：重放补建候选不能被当天证据的波动切断。
   const previous=(await db.query(selectLog(['request_spec=$3::jsonb as same'])+' where owner_id=$1 and request_id=$2',[ownerId,requestId,JSON.stringify(spec)])).rows[0]
   if(previous){
    if(!previous.same)throw new WorkError('teloa/conflict','同一请求不能提交不同的每日小结。')
    log=readLog(previous)
   }else{
    // 首次落库才做全量深比：计划身份与岗位版本必须与当场重算的结果逐字相同。
    if(who.taskId!==identity.taskId||who.planId!==identity.planId||who.roleVersion!==identity.roleVersion)
     throw new WorkError('teloa/forbidden','本次小结的运行身份与计划来源不一致。')
    // 同一天只有一条小结：先拿当天锁再判，两个不同请求身份并发时只有一个能落，另一个拿到明确的冲突而不是数据库原生报错。
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['role-daily-log-day',ownerId,who.roleId,who.day])])
    if((await db.query("select 1 from teloa_role_daily_logs where owner_id=$1 and role_id=$2 and kind='daily-digest' and day=$3::date",[ownerId,who.roleId,who.day])).rows[0])
     throw new WorkError('teloa/conflict','今天已经写过小结。')
    const role=await this.role(db,ownerId,who.roleId,true)
    if(role.version!==who.roleVersion)throw new WorkError('teloa/version-conflict','员工版本已变化，本次小结不产出。')
    if(role.state==='retired')throw new WorkError('teloa/conflict','已退役员工不能新增记忆候选。')
    const evidence=await this.dayEvidence(ownerId,who)
    const pruneHints:RoleDailyLogPruneHint[]=[]
    for(const hint of spec.pruneHints){
     const stored=(await db.query('select role_id,state,state_version from teloa_role_memories where owner_id=$1 and id=$2',[ownerId,hint.memoryId])).rows[0]
     if(!stored||stored.role_id!==who.roleId||stored.state!=='confirmed')throw new WorkError('teloa/invalid-input','剪枝建议指向的记忆不存在、不属于本员工或不是已确认记忆。')
     pruneHints.push({memoryId:hint.memoryId,memoryStateVersion:Number(stored.state_version),reason:hint.reason})
    }
    for(const candidate of spec.candidates)
     if(!candidate.scopeIds.every(item=>role.scopes.includes(item)&&evidence.scopeIds.includes(item)))throw new WorkError('teloa/forbidden','候选范围必须同时属于当前员工与当日证据范围。')
    const list=[...evidence.runs,...evidence.artifacts,...evidence.approvals,...evidence.revisions,...evidence.groupMessages]
    const id=this.identity.id(),now=this.identity.now()
    if(!uuid(id)||!Number.isFinite(Date.parse(now)))throw corrupt()
    await db.query(`insert into teloa_role_daily_logs(id,owner_id,role_id,role_version,kind,day,state,run_id,title,markdown,scope_ids,evidence,prune_hints,request_id,request_spec,created_at,discarded_at)
     values($1,$2,$3,$4,'daily-digest',$5::date,'kept',$6,$7,$8,$9,$10,$11,$12,$13,$14,null)`,
     [id,ownerId,who.roleId,who.roleVersion,who.day,who.runId,spec.title,spec.markdown,JSON.stringify(evidence.scopeIds),JSON.stringify(list),JSON.stringify(pruneHints),requestId,JSON.stringify(spec),now])
    await this.prune(db,ownerId,who.roleId,'daily-digest')
    log=readLog((await db.query(selectLog()+' where owner_id=$1 and id=$2',[ownerId,id])).rows[0])
   }
   await db.query('commit')
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
  const candidates:RoleMemory[]=[]
  for(const [index,candidate] of spec.candidates.entries())
   // source 由服务端派生，入参里没有 source 字段，模型不可自选来源类别。
   candidates.push(await this.memory.remember({ownerId,kind:'agent',roleId:who.roleId},{
    requestId:derivedRequestId(ownerId,who,index),roleId:who.roleId,expectedRoleVersion:who.roleVersion,
    title:candidate.title,markdown:candidate.markdown,
    source:{kind:'daily-digest',id:log.id,version:1},visibility:{kind:'role',scopeIds:candidate.scopeIds}
   }))
  return {log,candidates}
 }

 /** 分身只保存观察事实；固定请求号使重试幂等，私有范围不进入员工运行。 */
 async rememberHabit(log:RoleDailyLog):Promise<RoleMemory|undefined>{
  if(log.kind!=='habit-digest'||log.state!=='kept')return undefined
  return this.memory.remember({ownerId:log.ownerId,kind:'human'},{
   requestId:log.id,roleId:log.roleId,expectedRoleVersion:log.roleVersion,
   title:log.title,markdown:log.markdown,source:{kind:'habit-digest',id:log.id,version:1},visibility:{kind:'private',scopeIds:[]}
  })
 }

 /** C1 用：确定性汇总写一条 habit-digest（runId 为 null），复用调用方的事务连接。 */
 async writeHabitLog(db:PoolClient,ownerId:string,value:{roleId:string;roleVersion:number;day:string;title:string;markdown:string;evidence:RoleDailyLogEvidence[];requestId:string}):Promise<RoleDailyLog>{
  if(typeof ownerId!=='string'||!ownerId.trim()||ownerId.length>128)throw new WorkError('teloa/forbidden','需要可核验的本人身份。')
  if(!value||!uuid(value.roleId)||!Number.isSafeInteger(value.roleVersion)||value.roleVersion<1||!isDay(value.day)||!uuid(value.requestId)||!Array.isArray(value.evidence)||value.evidence.length>roleDailyLogEvidenceLimit)throw invalid()
  const title=text(value.title,120),markdown=logMarkdown(value.markdown)
  const spec={kind:'habit-digest',roleId:value.roleId,roleVersion:value.roleVersion,day:value.day,title,markdown,evidence:value.evidence}
  const previous=(await db.query(selectLog(['request_spec=$3::jsonb as same'])+' where owner_id=$1 and request_id=$2',[ownerId,value.requestId,JSON.stringify(spec)])).rows[0]
  if(previous){
   if(!previous.same)throw new WorkError('teloa/conflict','同一请求不能写入不同的习惯小结。')
   return readLog(previous)
  }
  const role=await this.role(db,ownerId,value.roleId,true)
  if(role.version!==value.roleVersion)throw new WorkError('teloa/version-conflict','员工版本已变化，习惯小结不写入。')
  const id=this.identity.id(),now=this.identity.now()
  if(!uuid(id)||!Number.isFinite(Date.parse(now)))throw corrupt()
  await db.query(`insert into teloa_role_daily_logs(id,owner_id,role_id,role_version,kind,day,state,run_id,title,markdown,scope_ids,evidence,prune_hints,request_id,request_spec,created_at,discarded_at)
   values($1,$2,$3,$4,'habit-digest',$5::date,'kept',null,$6,$7,'[]'::jsonb,$8,'[]'::jsonb,$9,$10,$11,null)`,
   [id,ownerId,value.roleId,value.roleVersion,value.day,title,markdown,JSON.stringify(value.evidence),value.requestId,JSON.stringify(spec),now])
  await this.prune(db,ownerId,value.roleId,'habit-digest')
  return readLog((await db.query(selectLog()+' where owner_id=$1 and id=$2',[ownerId,id])).rows[0])
 }

 /**
  * 60 天淘汰：落库成功后在同一事务里删掉更早的日志。
  * 留过丢弃回执的日志有意不淘汰——回执表不可变，连带删除会让整次提交失败；
  * 淘汰集合只增不减，本人明确丢弃过的那一天永远留一行可查的痕迹。
  */
 private async prune(db:Pick<Pool,'query'>,ownerId:string,roleId:string,kind:'daily-digest'|'habit-digest'):Promise<void>{
  await db.query(`delete from teloa_role_daily_logs l where l.owner_id=$1 and l.role_id=$2 and l.kind=$3
   and l.day<(select min(day) from (select day from teloa_role_daily_logs where owner_id=$1 and role_id=$2 and kind=$3 order by day desc limit ${roleDailyLogRetentionDays}) recent)
   and not exists(select 1 from teloa_role_daily_log_changes c where c.owner_id=l.owner_id and c.log_id=l.id)`,[ownerId,roleId,kind])
 }

 async list(actor:RoleDailyLogActor,input:unknown):Promise<{items:RoleDailyLogSummary[]}>{
  const who=principal(actor);if(who.kind!=='human')throw new WorkError('teloa/forbidden','每日日志目录只对本人开放。')
  const row=roleDailyLogListInput(input)
  await this.role(this.pool,who.ownerId,row.roleId)
  const rows=(await this.pool.query(`select id,kind,to_char(day,'YYYY-MM-DD') as day,state,title,created_at from teloa_role_daily_logs
   where owner_id=$1 and role_id=$2 order by day desc,id limit ${roleDailyLogListLimit}`,[who.ownerId,row.roleId])).rows
  return {items:rows.map(item=>{
   const value={id:item.id,kind:item.kind,day:item.day,state:item.state,title:item.title,createdAt:stamp(item.created_at)}
   if(!isRoleDailyLogSummary(value))throw corrupt()
   return value
  })}
 }

 async get(actor:RoleDailyLogActor,input:unknown):Promise<{log:RoleDailyLog}>{
  const who=principal(actor);if(who.kind!=='human')throw new WorkError('teloa/forbidden','每日日志只对本人开放。')
  const row=roleDailyLogGetInput(input)
  await this.role(this.pool,who.ownerId,row.roleId)
  const stored=(await this.pool.query(selectLog()+' where owner_id=$1 and id=$2 and role_id=$3',[who.ownerId,row.logId,row.roleId])).rows[0]
  if(!stored)throw new WorkError('teloa/forbidden','每日日志不存在或不属于当前本人。')
  return {log:readLog(stored)}
 }

 /** 丢弃只改日志状态；由它提升或确认的记忆不受影响，只是来源变成不可核对。 */
 async discard(actor:RoleDailyLogActor,input:unknown):Promise<{log:RoleDailyLog}>{
  const who=principal(actor);if(who.kind!=='human')throw new WorkError('teloa/forbidden','只有本人可以丢弃每日日志。')
  const row=roleDailyLogDiscardInput(input),spec={action:'discard',logId:row.logId,expectedState:row.expectedState},db=await this.pool.connect()
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['role-daily-log-discard',who.ownerId,row.requestId])])
   const previous=(await db.query('select *,request_spec=$3::jsonb as same from teloa_role_daily_log_changes where owner_id=$1 and request_id=$2',[who.ownerId,row.requestId,JSON.stringify(spec)])).rows[0]
   if(previous){
    if(!previous.same)throw new WorkError('teloa/conflict','同一请求不能执行不同的日志决定。')
    if(!isRoleDailyLog(previous.result)||previous.result.ownerId!==who.ownerId||previous.result.id!==previous.log_id||previous.result.state!=='discarded')throw corrupt()
    await db.query('commit');return {log:previous.result}
   }
   const stored=(await db.query(selectLog()+' where owner_id=$1 and id=$2 for update',[who.ownerId,row.logId])).rows[0]
   if(!stored)throw new WorkError('teloa/forbidden','每日日志不存在或不属于当前本人。')
   const current=readLog(stored)
   if(current.state!==row.expectedState)throw new WorkError('teloa/version-conflict','每日日志状态已变化，请刷新后核对。')
   const now=this.identity.now()
   await db.query("update teloa_role_daily_logs set state='discarded',discarded_at=$3 where owner_id=$1 and id=$2",[who.ownerId,current.id,now])
   const log=readLog((await db.query(selectLog()+' where owner_id=$1 and id=$2',[who.ownerId,current.id])).rows[0])
   await db.query('insert into teloa_role_daily_log_changes(owner_id,request_id,request_spec,log_id,result,created_at) values($1,$2,$3,$4,$5,$6)',[who.ownerId,row.requestId,JSON.stringify(spec),current.id,JSON.stringify(log),now])
   await db.query('commit');return {log}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}

/** 同一成果当日多个版本只留最后一条：证据的唯一键是 `kind+id`。 */
function latest(items:ScopedEvidence[]):ScopedEvidence[]{
 const map=new Map<string,ScopedEvidence>()
 for(const entry of items){const kept=map.get(entry.item.id);if(!kept||kept.item.version<entry.item.version)map.set(entry.item.id,entry)}
 return [...map.values()]
}
