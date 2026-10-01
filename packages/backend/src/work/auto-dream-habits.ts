import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,type DigitalRole,type RoleDailyLog,type RoleDailyLogEvidence,type ScheduleTrigger} from '@teloa/contract'
import {roleDailyLogEvidenceLimit,roleDailyLogMarkdownBytes,type RoleDailyLogService} from './role-daily-logs.ts'

/**
 * C1 四类可观察操作的内部标记。与 `RoleDailyLogEvidence.kind`（落库枚举）不是同一件事——
 * 群里的纠正落库为 `group-message`，交办文案的反复模式是纯统计，不落成单条证据指针。
 */
export type HabitObservationSource='approval'|'revision'|'assignment'|'group-correction'

const corrupt=()=>new WorkError('teloa/storage-corrupt','习惯观察证据读取失败，已停止生成。')
/** 证据标题固定 200 字上限，与契约 `roleDailyLogEvidence` 判据一致。 */
const label=(value:string):string=>value.length>200?value.slice(0,200):value

/** 同一位分身同一天的观察身份恒定：重放不会建出第二条，调用方不需要另传请求号。 */
function habitRequestId(ownerId:string,roleId:string,day:string):string{
 const digest=createHash('sha256').update('teloa-habit-digest/v1'+ownerId+roleId+day).digest('hex')
 const variant=((parseInt(digest.slice(16,17),16)&0x3)|0x8).toString(16)
 return `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-${variant}${digest.slice(17,20)}-${digest.slice(20,32)}`
}

/** `trigger.time`/`timezone` 决定「当天」的切分点：本地时刻早于触发时刻，则生成前一天的观察。 */
function observationDay(nowIso:string,trigger:ScheduleTrigger):string{
 const epoch=Date.parse(nowIso)
 if(!Number.isFinite(epoch))throw corrupt()
 const formatter=new Intl.DateTimeFormat('en-US',{timeZone:trigger.timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
 const parts=Object.fromEntries(formatter.formatToParts(epoch).filter(part=>part.type!=='literal').map(part=>[part.type,part.value])) as Record<'year'|'month'|'day'|'hour'|'minute',string>
 const localDate=`${parts.year}-${parts.month}-${parts.day}`,localTime=`${parts.hour}:${parts.minute}`
 if(localTime>=trigger.time)return localDate
 const shifted=new Date(localDate+'T00:00:00.000Z');shifted.setUTCDate(shifted.getUTCDate()-1)
 return shifted.toISOString().slice(0,10)
}

type PhraseCount={phrase:string;count:number}
type AssignmentStats={count:number;phrases:PhraseCount[];shortest:number;median:number;longest:number;alwaysHasAcceptance:boolean}
/** 确定性统计：不做语义归纳、不调模型。片段按标点与空白切分，长度 2–12 字，出现 ≥2 次才计入，按次数降序取前 5。 */
function assignmentStats(goals:string[]):AssignmentStats{
 const counts=new Map<string,number>()
 for(const goal of goals){
  const fragments=goal.split(/[\s,.，。；;：:！!？?、"'“”‘’「」『』()（）[\]{}—－\-·/\\|]+/u).map(item=>item.trim()).filter(item=>item.length>=2&&item.length<=12)
  for(const fragment of fragments)counts.set(fragment,(counts.get(fragment)??0)+1)
 }
 const phrases=[...counts.entries()].filter(([,count])=>count>=2).map(([phrase,count])=>({phrase,count})).sort((a,b)=>b.count-a.count||a.phrase.localeCompare(b.phrase)).slice(0,5)
 const lengths=goals.map(goal=>goal.length).sort((a,b)=>a-b)
 const mid=Math.floor(lengths.length/2)
 const median=lengths.length?(lengths.length%2?lengths[mid]!:Math.round((lengths[mid-1]!+lengths[mid]!)/2)):0
 const alwaysHasAcceptance=goals.length>0&&goals.every(goal=>goal.includes('验收')||goal.includes('标准')||goal.includes('完成的标志'))
 return {count:goals.length,phrases,shortest:lengths[0]??0,median,longest:lengths[lengths.length-1]??0,alwaysHasAcceptance}
}

function renderMarkdown(sections:{approvals:string[];revisions:string[];assignment:string[];corrections:string[]}):string{
 const block=(title:string,lines:string[],empty:string)=>`## ${title}\n${lines.length?lines.join('\n'):'- '+empty}`
 return [
  block('放行与拒绝',sections.approvals,'当天没有放行或拒绝记录。'),
  block('对成果的修订',sections.revisions,'当天没有修订记录。'),
  block('交办文案',sections.assignment,'当天没有新建任务。'),
  block('群里的纠正',sections.corrections,'当天没有需要纠正员工回帖的记录。')
 ].join('\n\n')
}

/** 按 UTF-8 字节裁到上限，回退到不落在多字节字符中间的边界，不产出非法 UTF-8。 */
function truncateToBytes(value:string,maxBytes:number):string{
 if(maxBytes<=0)return ''
 const buffer=Buffer.from(value,'utf8')
 if(buffer.length<=maxBytes)return value
 let end=maxBytes
 while(end>0&&(buffer[end]!&0xc0)===0x80)end--
 return buffer.subarray(0,end).toString('utf8')
}

/** 正文即使只剩 60 条指针仍可能超字节上限（单条理由过长）：按段落尾部整段丢弃，仍超再按字节裁切，最后追加固定提示。 */
function fitMarkdownBytes(body:string,maxBytes:number):string{
 if(Buffer.byteLength(body,'utf8')<=maxBytes)return body
 const note='\n\n（当天记录较多，正文过长，已截断。）',budget=Math.max(0,maxBytes-Buffer.byteLength(note,'utf8'))
 const paragraphs=body.split('\n\n')
 while(paragraphs.length>1&&Buffer.byteLength(paragraphs.join('\n\n'),'utf8')>budget)paragraphs.pop()
 let candidate=paragraphs.join('\n\n')
 if(Buffer.byteLength(candidate,'utf8')>budget)candidate=truncateToBytes(candidate,budget)
 return candidate+note
}

/**
 * C1：服务端按天做一次纯事实汇总，零模型参与，因此模型投毒面为零。
 * 输入集合穷举、封闭：本人的放行/拒绝及理由、本人对员工成果的修订（只记指针不记正文）、
 * 本人交办文案的确定性统计、本人在群里对员工回帖的纠正。
 * 不含原生会话日志、不含员工的运行日志、不含工具调用参数、不含外部连接返回。要扩输入必须先改规格。
 */
export class AutoDreamHabitService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 readonly logs:Pick<RoleDailyLogService,'writeHabitLog'|'get'|'rememberHabit'>
 readonly setting:(db:PoolClient,ownerId:string)=>Promise<{enabled:boolean;trigger:ScheduleTrigger}|undefined>
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},logs:Pick<RoleDailyLogService,'writeHabitLog'|'get'|'rememberHabit'>,setting:(db:PoolClient,ownerId:string)=>Promise<{enabled:boolean;trigger:ScheduleTrigger}|undefined>){
  this.pool=pool;this.identity=identity;this.logs=logs;this.setting=setting
 }

 /**
  * 后台周期检查与分身目录读取共用此入口。
  * 开关关闭、设置缺失或当天来源全空时不生成；已有日志则补齐自动保存，返回 undefined。
  */
 async ensureForDay(ownerId:string,twin:DigitalRole,nowIso:string):Promise<RoleDailyLog|undefined>{
  if(typeof ownerId!=='string'||!ownerId.trim())return undefined
  if(!twin||twin.kind!=='twin'||twin.ownerId!==ownerId)return undefined
  if(typeof nowIso!=='string'||!Number.isFinite(Date.parse(nowIso)))return undefined
  const db=await this.pool.connect()
  try{
   const setting=await this.setting(db,ownerId)
   if(!setting||!setting.enabled)return undefined
   const day=observationDay(nowIso,setting.trigger)
   // 惰性生成可能被同一本人的两个标签页并发触发：同一把事务锁把「查当天已有 → 取证据 → 写日志」串行化，
   // 第二个到达的调用在锁释放后重新看到第一个已经落的行，直接返回 undefined，不会撞 unique 约束的原生异常。
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['role-daily-log-habit',ownerId,twin.id,day])])
   const already=(await db.query("select id from teloa_role_daily_logs where owner_id=$1 and role_id=$2 and kind='habit-digest' and day=$3::date",[ownerId,twin.id,day])).rows[0]
   if(already){
    await db.query('commit')
    const {log}=await this.logs.get({ownerId,kind:'human'},{roleId:twin.id,logId:already.id})
    await this.logs.rememberHabit(log)
    return undefined
   }
   const bounds=(await db.query("select ($1::date)::timestamp at time zone $2 as from_at,(($1::date)+interval '1 day')::timestamp at time zone $2 as to_at",[day,setting.trigger.timezone])).rows[0]
   const from=bounds?.from_at,to=bounds?.to_at
   if(!(from instanceof Date)||!(to instanceof Date))throw corrupt()
   const read=async<T>(work:()=>Promise<T>):Promise<T>=>{try{return await work()}catch(error){if(error instanceof WorkError)throw error;throw corrupt()}}

   // 安全审批表是可选模块；本装配里既然要读放行/拒绝，两张表必须都在，缺一律当损坏处理，不回落成空数组。
   const present=await read(async()=>(await db.query('select name from unnest($1::text[]) as name where to_regclass(name) is not null',[['teloa_security_approvals','teloa_security_actions']])).rows.length)
   if(present!==2)throw corrupt()
   const approvalRows=await read(async()=>(await db.query(`select a.id,a.decision,a.reason,s.object_type
    from teloa_security_approvals a join teloa_security_actions s on s.id=a.action_id and s.owner_id=a.owner_id
    where a.owner_id=$1 and a.created_at>=$2 and a.created_at<$3 order by a.created_at,a.id`,[ownerId,from,to])).rows)
   for(const row of approvalRows)if(!['approved','rejected'].includes(String(row.decision))||typeof row.reason!=='string'||!row.reason.trim()||typeof row.object_type!=='string'||!row.object_type.trim())throw corrupt()

   // 与 T5 证据第 4 类同一判据，但不按单个岗位过滤：习惯观察看的是本人跨全部员工的修订习惯。
   const revisionRows=await read(async()=>(await db.query(`select v.artifact_id,max(v.number) as number,count(*)::int as versions
    from teloa_artifact_versions v
    where v.owner_id=$1 and v.created_at>=$2 and v.created_at<$3 and v.source->>'kind'<>'run'
    and exists(select 1 from teloa_artifact_versions f join teloa_task_runs r on r.id::text=f.source->>'id' and r.owner_id=f.owner_id
     where f.owner_id=v.owner_id and f.artifact_id=v.artifact_id and f.number=1 and f.source->>'kind'='run')
    group by v.artifact_id order by v.artifact_id`,[ownerId,from,to])).rows)
   for(const row of revisionRows)if(!Number.isSafeInteger(row.number)||Number(row.number)<1||!Number.isSafeInteger(row.versions)||Number(row.versions)<1)throw corrupt()

   // 交办文案只取本人直接创建、不经持续计划领取的任务：计划自动生成的任务不算本人的交办习惯。
   const taskRows=await read(async()=>(await db.query(`select t.definition->>'goal' as goal
    from teloa_tasks t
    where t.owner_id=$1 and t.created_at>=$2 and t.created_at<$3
    and not exists(select 1 from teloa_plan_task_links l where l.task_id=t.id)
    order by t.created_at,t.id`,[ownerId,from,to])).rows)
   const goals=taskRows.map(row=>{if(typeof row.goal!=='string'||!row.goal.trim())throw corrupt();return row.goal as string})

   const messageRows=await read(async()=>(await db.query(`select m.id,coalesce(m.root_id,m.id) as thread
    from teloa_group_messages m
    where m.owner_id=$1 and m.author_id='self' and m.created_at>=$2 and m.created_at<$3
    and exists(select 1 from teloa_group_messages c where c.owner_id=m.owner_id
     and coalesce(c.root_id,c.id)=coalesce(m.root_id,m.id) and c.author_id<>'self' and c.created_at<m.created_at)
    order by m.created_at,m.id`,[ownerId,from,to])).rows)
   for(const row of messageRows)if(typeof row.id!=='string')throw corrupt()

   if(!approvalRows.length&&!revisionRows.length&&!goals.length&&!messageRows.length){await db.query('commit');return undefined}

   const stats=assignmentStats(goals)
   const assignmentLines=goals.length?[
    `- 当天新建任务 ${stats.count} 条。`,
    `- 重复短语：${stats.phrases.length?stats.phrases.map(item=>`${item.phrase}（${item.count} 次）`).join('、'):'无重复短语。'}`,
    `- 长度：最短 ${stats.shortest} 字、中位 ${stats.median} 字、最长 ${stats.longest} 字。`,
    `- 是否每次都写验收标准：${stats.alwaysHasAcceptance?'是':'否'}。`
   ]:[]

   // 指针与正文行必须出自同一份「保留 60 条」集合：先按 kind 打标签合并、按限额切一刀，再从切完的集合各自取行，
   // 不能像证据数组那样单独切，否则正文行数不受限、可能把 `writeHabitLog` 的 16000 字节上限撑爆。
   type Kept={evidence:RoleDailyLogEvidence;line:string}
   const approvalEntries:Array<Kept&{section:'approvals'}>=approvalRows.map(row=>({
    section:'approvals',
    evidence:{kind:'approval',id:row.id as string,version:1,title:label(`${row.decision==='approved'?'允许':'拒绝'}：${row.object_type}`)},
    line:`- ${row.decision==='approved'?'允许':'拒绝'} · 类别 ${row.object_type}：${row.reason}`
   }))
   const revisionEntries:Array<Kept&{section:'revisions'}>=revisionRows.map(row=>({
    section:'revisions',
    evidence:{kind:'revision',id:row.artifact_id as string,version:Number(row.number),title:label(`修订：本日新增 ${row.versions} 版`)},
    line:`- 成果 ${String(row.artifact_id).slice(0,8)}：本日新增 ${row.versions} 版`
   }))
   const correctionEntries:Array<Kept&{section:'corrections'}>=messageRows.map(row=>({
    section:'corrections',
    evidence:{kind:'group-message',id:row.id as string,version:1,title:label('群回帖 · 话题 '+String(row.thread).slice(0,8))},
    line:`- 群回帖 · 话题 ${String(row.thread).slice(0,8)}`
   }))
   const combined=[...approvalEntries,...revisionEntries,...correctionEntries]
   const kept=combined.slice(0,roleDailyLogEvidenceLimit)
   const linesOf=(section:'approvals'|'revisions'|'corrections')=>kept.filter(item=>item.section===section).map(item=>item.line)
   const approvalLines=linesOf('approvals'),revisionLines=linesOf('revisions'),correctionLines=linesOf('corrections')
   const evidence:RoleDailyLogEvidence[]=kept.map(item=>item.evidence)

   let body=renderMarkdown({approvals:approvalLines,revisions:revisionLines,assignment:assignmentLines,corrections:correctionLines})
   if(combined.length>kept.length)body+=`\n\n（当天记录较多，仅保留前 ${roleDailyLogEvidenceLimit} 条。）`
   body=fitMarkdownBytes(body,roleDailyLogMarkdownBytes)

   const log=await this.logs.writeHabitLog(db,ownerId,{roleId:twin.id,roleVersion:twin.version,day,title:'习惯观察 · '+day,markdown:body,evidence,requestId:habitRequestId(ownerId,twin.id,day)})
   await db.query('commit')
   await this.logs.rememberHabit(log)
   return log
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}
