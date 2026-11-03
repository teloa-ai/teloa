import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,artifactContent,isRecord,readScheduleTrigger,roleDefinition,savedArtifactSource,type RoleDailyLogEvidence,type ScheduleTrigger} from '@teloa/contract'
import {BusinessScopeService} from './business-scopes.ts'
import {ArtifactMessageStore} from './artifact-messages.ts'
import {GroupAgentGrantService} from './group-agent-grants.ts'
import {readGroupMessageBody} from './group-message-body.ts'
import {readStoredTask} from './tasks.ts'
import {readSecurityActionGraph} from '../security/action-panel.ts'
import {createSecurityEndpointIsolateDefinition} from '../security/action-authorization.ts'
import {readArtifactRunSources} from './artifact-run-sources.ts'

export type RoleDayEvidence={
 day:string;timezone:ScheduleTrigger['timezone'];roleId:string;roleVersion:number;scopeIds:string[]
 runs:RoleDailyLogEvidence[];artifacts:RoleDailyLogEvidence[];approvals:RoleDailyLogEvidence[];revisions:RoleDailyLogEvidence[];groupMessages:RoleDailyLogEvidence[]
 /** 仅供本轮模型阅读的来源数据；持久日志仍只存上面的固定版本指针。 */
 contents?:Array<RoleDailyLogEvidence&{text:string;sha256:string;truncated:boolean;artifactId?:string}>
}
export type RoleDayEvidenceIdentity={planId:string;roleId:string;roleVersion:number;day:string}
/** 与日志契约的 60 条上限一致；调度预检和模型读取共用同一证据选择。 */
export const roleDailyLogEvidenceLimit=60
export const hasRoleDayEvidence=(value:RoleDayEvidence):boolean=>[value.runs,value.artifacts,value.approvals,value.revisions,value.groupMessages].some(items=>items.length>0)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const scope=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const isDay=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)===value
const invalid=()=>new WorkError('teloa/invalid-input','每日日志请求包含未知字段或格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','每日日志记录损坏，已停止读取。')
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const label=(value:string):string=>value.length>200?value.slice(0,200):value

/**
 * 运行证据必须让模型分辨完成/中止/失败与未完成：终态只取自 `teloa_task_runs.state` 与
 * `evidence.reason`，不把“有运行”当成“已完成”。非 ended 一律标未完成。
 */
function runTerminalLabel(state:unknown,evidence:unknown):string{
 if(state!=='ended')return '未完成'
 const reason=isRecord(evidence)&&evidence.state==='ended'?evidence.reason:undefined
 if(reason==='completed')return '完成'
 if(reason==='aborted')return '中止'
 if(reason==='error')return '失败'
 if(reason==='stopped')return '已停止'
 return typeof reason==='string'&&reason.trim()?`结束：${reason.trim().slice(0,20)}`:'结束'
}

type ScopedEvidence={item:RoleDailyLogEvidence;scope?:string;text?:string}
type ArtifactBody=ReturnType<typeof artifactContent>
type ArtifactSection=ArtifactBody['sections'][number]
type SectionChange={id:string;kind:'added'|'removed'|'modified';before:ArtifactSection|null;after:ArtifactSection|null}
/** 只比较已核对的固定版本字段，不解释业务含义；不可读基准不能推出“没有修改”。 */
function compareArtifactBody(current:ArtifactBody,baseline:ArtifactBody|null,baselineVersion:number|null){
 if(!baseline)return {status:'unavailable' as const,baselineVersion:null,bodyChanged:null,noteChanged:null,sectionOrderChanged:null,sectionChanges:[] as SectionChange[]}
 const before=new Map(baseline.sections.map(section=>[section.id,section])),after=new Map(current.sections.map(section=>[section.id,section]))
 const sectionChanges:SectionChange[]=[]
 for(const [id,section] of before){
  const next=after.get(id)
  if(!next)sectionChanges.push({id,kind:'removed',before:section,after:null})
  else if(section.title!==next.title||section.text!==next.text)sectionChanges.push({id,kind:'modified',before:section,after:next})
 }
 for(const [id,section] of after)if(!before.has(id))sectionChanges.push({id,kind:'added',before:null,after:section})
 // 增删已单独列出；顺序只比较两版共有段落，纯重排也属于正文变化。
 const sectionOrderChanged=JSON.stringify([...before.keys()].filter(id=>after.has(id)))!==JSON.stringify([...after.keys()].filter(id=>before.has(id)))
 return {status:'compared' as const,baselineVersion,bodyChanged:sectionChanges.length>0||sectionOrderChanged,noteChanged:current.note!==baseline.note,sectionOrderChanged,sectionChanges}
}
/** 短来源先满足，剩余预算均分给长来源；摘要始终对应完整来源。 */
const dayEvidenceContentBytes=64*1024
function evidenceContents(items:ScopedEvidence[]):NonNullable<RoleDayEvidence['contents']>{
 const buffers=items.map(({text=''})=>Buffer.from(text,'utf8')),limits=new Map<number,number>()
 const order=buffers.map((bytes,index)=>({bytes,index})).sort((a,b)=>a.bytes.length-b.bytes.length)
 let remaining=dayEvidenceContentBytes
 for(const [position,{bytes,index}] of order.entries()){
  let end=Math.min(bytes.length,Math.floor(remaining/(order.length-position)))
  // 不截在中文或 emoji 的多字节字符中间。
  while(end>0&&end<bytes.length&&(bytes[end]!&0xc0)===0x80)end--
  limits.set(index,end);remaining-=end
 }
 return items.map(({item},index)=>{
  const bytes=buffers[index]!,end=limits.get(index)!
  return {...item,...(item.kind==='artifact'||item.kind==='revision'?{artifactId:item.id}:{}),text:bytes.subarray(0,end).toString('utf8'),sha256:createHash('sha256').update(bytes).digest('hex'),truncated:end<bytes.length}
 })
}

/** 日结只能消费业务工作，不能把自己或此前的小结再次蒸馏。所有证据复用同一来源排除条件。 */
const dayWorkSources=`system_tasks as (
 select l.task_id from teloa_plan_task_links l
 join teloa_plan_occurrences o on o.owner_id=l.owner_id and o.id=l.claim_id
 join teloa_plans p on p.owner_id=o.owner_id and p.id=o.plan_id
 where l.owner_id=$1 and p.source->>'kind'='system-digest'
), system_runs as (
 select r.* from teloa_task_runs r where r.owner_id=$1 and r.task_id in(select task_id from system_tasks)
), work_runs as (
 select r.* from teloa_task_runs r where r.owner_id=$1 and r.task_id not in(select task_id from system_tasks)
)`


export async function readRoleEvidenceRole(db:Pick<Pool,'query'>,ownerId:string,roleId:string,lock=false):Promise<{version:number;state:string;scopes:string[]}>{
  const row=(await db.query('select version,state,definition from teloa_roles where owner_id=$1 and id=$2'+(lock?' for share':''),[ownerId,roleId])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','员工不存在或不属于当前本人。')
  let scopes:string[];try{scopes=roleDefinition(row.definition).scopes}catch{throw corrupt()}
  return {version:Number(row.version),state:String(row.state),scopes}
}


/** 五类来源共用权限、版本、正文校验；健康的空日返回空证据，读取失败仍抛错。 */
export async function readRoleDayEvidence(pool:Pool,db:PoolClient,ownerId:string,identity:RoleDayEvidenceIdentity,now:()=>string):Promise<RoleDayEvidence>{
 try{
  const plan=(await db.query('select definition from teloa_plans where owner_id=$1 and id=$2',[ownerId,identity.planId])).rows[0]
  if(!plan)throw new WorkError('teloa/forbidden','持续计划不存在或不属于当前本人。')
  if(!isDay(identity.day))throw invalid()
  // 时区白名单的唯一真源是契约 `readScheduleTrigger`，本文件不另抄一份。
  let timezone:ScheduleTrigger['timezone']
  try{timezone=readScheduleTrigger((plan.definition as Record<string,unknown>).trigger).timezone}catch{throw corrupt()}
  const bounds=(await db.query('select ($1::date)::timestamp at time zone $2 as from_at,(($1::date)+interval \'1 day\')::timestamp at time zone $2 as to_at',[identity.day,timezone])).rows[0]
  const from=bounds?.from_at,to=bounds?.to_at
  if(!(from instanceof Date)||!(to instanceof Date))throw corrupt()
  const read=async<T>(work:()=>Promise<T>):Promise<T>=>{try{return await work()}catch(error){if(error instanceof WorkError)throw error;throw corrupt()}}
  const role=await readRoleEvidenceRole(db,ownerId,identity.roleId)
  if(role.version!==identity.roleVersion)throw new WorkError('teloa/version-conflict','员工版本已变化，本次小结不产出。')
  if(role.state==='retired')throw new WorkError('teloa/forbidden','已退役员工不能读取每日小结证据。')
  // 缺失权限目录是读取失败，不能使用旧装配的空目录兼容语义来跳过工作日。
  if(role.scopes.some(value=>value!=='general')&&!(await db.query("select to_regclass('teloa_business_scopes') as name")).rows[0]?.name)throw corrupt()
  const allowedScopes:string[]=[],businessScopes=new BusinessScopeService(db)
  for(const value of role.scopes)if((await businessScopes.attentionScopes(ownerId,{scope:value})).scopeIds.includes(value))allowedScopes.push(value)
  const verifiedTasks=new Set<string>()
  const verifyTasks=async(ids:readonly string[])=>{
   const missing=[...new Set(ids)].filter(id=>!verifiedTasks.has(id));if(!missing.length)return
   const rows=(await db.query('select * from teloa_tasks where owner_id=$1 and id=any($2::uuid[])',[ownerId,missing])).rows
   if(rows.length!==missing.length)throw corrupt()
   for(const row of rows){
    try{const task=readStoredTask(row);if(task.ownerId!==ownerId)throw corrupt();verifiedTasks.add(task.id)}
    catch{throw new WorkError('teloa/storage-corrupt','每日小结的任务来源记录损坏，已停止读取。',{sourceKind:'task',sourceId:row.id})}
   }
  }

  const runRows=await read(async()=>(await db.query(`with ${dayWorkSources}
   select r.id,r.task_id,r.state,r.evidence,r.created_at,t.definition->>'title' as title,t.definition->>'scope' as scope
   from work_runs r join teloa_tasks t on t.id=r.task_id
   where r.owner_id=$1 and t.owner_id=$1 and r.role_id=$2 and r.created_at>=$3 and r.created_at<$4
   and t.definition->>'scope'=any($5::text[]) order by r.created_at,r.id`,[ownerId,identity.roleId,from,to,allowedScopes])).rows)
  await verifyTasks(runRows.map(row=>row.task_id as string))
  const runs:ScopedEvidence[]=runRows.map(row=>{
   if(!uuid(row.id)||typeof row.title!=='string'||!row.title.trim()||!scope(row.scope))throw corrupt()
   return {item:{kind:'run' as const,id:row.id as string,version:1,title:label('运行（'+runTerminalLabel(row.state,row.evidence)+'）：'+row.title)},scope:row.scope,text:JSON.stringify({createdAt:stamp(row.created_at),state:row.state,evidence:row.evidence??null})}
  })

  // 产出时间独立于运行时间；正式成果保留 task/session 来源，生产回执不改写原来源。
  // task/session 无精确生产回执时只接受唯一员工归属，不能把同一任务的他人正文归给当前员工。
  const artifactRows=await read(async()=>(await db.query(`with ${dayWorkSources}, authorized_artifacts as (
   select v.*,
   exists(select 1 from teloa_artifact_revision_producers p join work_runs r on r.owner_id=p.owner_id and r.id=p.run_id
    where p.owner_id=v.owner_id and p.artifact_id=v.artifact_id and p.number=v.number and r.role_id is not null) as employee_produced
   from teloa_artifact_versions v join teloa_artifact_versions f on f.owner_id=v.owner_id and f.artifact_id=v.artifact_id and f.number=1
   where v.owner_id=$1 and v.source->>'scope'=any($5::text[]) and f.source->>'scope'=any($5::text[])
   and not exists(select 1 from teloa_artifact_withdrawals w where w.owner_id=v.owner_id and w.artifact_id=v.artifact_id)
   and not exists(select 1 from system_runs r where
    (v.source->>'kind'='run' and v.source->>'id'=r.id::text) or
    (v.source->>'kind'='task' and v.source->>'id'=r.task_id::text) or
    (v.source->>'kind'='session' and v.source->>'id'=r.session_id))
   and (
    exists(select 1 from teloa_artifact_revision_producers p join work_runs r on r.owner_id=p.owner_id and r.id=p.run_id
     where p.owner_id=v.owner_id and p.artifact_id=v.artifact_id and p.number=v.number and r.role_id=$2)
    or ((not exists(select 1 from teloa_artifact_revision_producers p where p.owner_id=v.owner_id and p.artifact_id=v.artifact_id and p.number=v.number)
     or exists(select 1 from teloa_artifact_revision_producers p join work_runs r on r.owner_id=p.owner_id and r.id=p.run_id
      where p.owner_id=v.owner_id and p.artifact_id=v.artifact_id and p.number=v.number and r.role_id is null)) and (
    exists(select 1 from work_runs r where r.owner_id=v.owner_id and r.role_id=$2 and
     ((v.source->>'kind'='run' and r.id::text=v.source->>'id') or (f.source->>'kind'='run' and r.id::text=f.source->>'id')))
    or (v.source->>'kind'='task'
     and exists(select 1 from work_runs r where r.owner_id=v.owner_id and r.task_id::text=v.source->>'id' and r.role_id=$2)
     and not exists(select 1 from work_runs r where r.owner_id=v.owner_id and r.task_id::text=v.source->>'id' and r.role_id is distinct from $2::uuid))
    or (v.source->>'kind'='session'
     and exists(select 1 from teloa_object_conversations c where c.owner_id=v.owner_id and c.session_id=v.source->>'id' and c.kind='role' and c.object_id=$2 and c.active=true)
     and not exists(select 1 from teloa_object_conversations c where c.owner_id=v.owner_id and c.session_id=v.source->>'id' and c.kind='role' and c.object_id<>$2 and c.active=true))
   )))
  ) select v.*,f.source as first_source,b.number as base_number,b.source as base_source,b.content as base_content,
    p.task_id as producer_task_id,p.run_id as producer_run_id,bp.task_id as base_producer_task_id,bp.run_id as base_producer_run_id
   from authorized_artifacts v
   join teloa_artifact_versions f on f.owner_id=v.owner_id and f.artifact_id=v.artifact_id and f.number=1
   left join teloa_artifact_revision_producers p on p.owner_id=v.owner_id and p.artifact_id=v.artifact_id and p.number=v.number
   left join teloa_artifact_revision_requests q on q.owner_id=p.owner_id and q.id=p.revision_id
   left join authorized_artifacts b on b.owner_id=v.owner_id and b.artifact_id=v.artifact_id and b.number=coalesce(q.base_version,v.number-1)
   left join teloa_artifact_revision_producers bp on bp.owner_id=b.owner_id and bp.artifact_id=b.artifact_id and bp.number=b.number
   where v.created_at>=$3 and v.created_at<$4 order by v.artifact_id,v.number`,[ownerId,identity.roleId,from,to,allowedScopes])).rows)
  // 成果保留原 source，精确生产者另存；首版/可读基准和 producer 都是当前成果的必要关联。
  const artifactSources=artifactRows.flatMap(row=>[row.source,row.first_source,...(row.base_source?[row.base_source]:[])].map(savedArtifactSource))
  const producers=artifactRows.flatMap(row=>[{taskId:row.producer_task_id,runId:row.producer_run_id},{taskId:row.base_producer_task_id,runId:row.base_producer_run_id}]).filter(value=>value.runId!==null)
  const artifactRunIds=[...new Set([...artifactSources.filter(source=>source.kind==='run').map(source=>source.id),...producers.map(value=>value.runId as string)])]
  const artifactRuns=artifactRunIds.length?(await db.query('select id,task_id from teloa_task_runs where owner_id=$1 and id=any($2::uuid[])',[ownerId,artifactRunIds])).rows:[]
  if(artifactRuns.length!==artifactRunIds.length)throw corrupt()
  if(producers.some(value=>!uuid(value.taskId)||artifactRuns.find(run=>run.id===value.runId)?.task_id!==value.taskId))throw corrupt()
  await verifyTasks([...artifactSources.filter(source=>source.kind==='task').map(source=>source.id),...artifactRuns.map(row=>row.task_id as string)])
  const artifactEntries:ScopedEvidence[]=await read(async()=>{
   const entries:ScopedEvidence[]=[]
   const body=async(content:ArtifactBody,historicalMessages:Map<string,{snapshotId:string;sha256:string;text:string}>)=>{
    // 原消息只作历史产出溯源；版本正文以 sections 为准，不遍历原生会话。
    for(const snapshotId of content.messageSnapshotIds??[])if(!historicalMessages.has(snapshotId)){
     const message=await new ArtifactMessageStore(db).read(ownerId,snapshotId)
     historicalMessages.set(snapshotId,{snapshotId,sha256:createHash('sha256').update(message.text).digest('hex'),text:message.text})
    }
    return {sections:content.sections,note:content.note,attachmentSnapshotIds:content.snapshotIds,historicalMessageSnapshotIds:content.messageSnapshotIds??[]}
   }
   for(const row of artifactRows){
    const content=artifactContent(row.content),source=savedArtifactSource(row.source)
    if(!uuid(row.artifact_id)||!Number.isSafeInteger(row.number)||Number(row.number)<1||!scope(source.scope))throw corrupt()
    const kind=row.number>1&&source.kind!=='run'&&!row.employee_produced?'revision':'artifact'
    const historicalMessages=new Map<string,{snapshotId:string;sha256:string;text:string}>(),current=await body(content,historicalMessages)
    const baseContent=kind==='revision'&&row.base_number?artifactContent(row.base_content):null,baseVersion=baseContent?Number(row.base_number):null
    const baseline=baseContent?{version:baseVersion,...await body(baseContent,historicalMessages)}:null
    entries.push({item:{kind,id:row.artifact_id,version:Number(row.number),title:label(content.title)},scope:source.scope,text:JSON.stringify({version:Number(row.number),...current,...(kind==='revision'?{comparison:compareArtifactBody(content,baseContent,baseVersion),baseline,baselineUnavailable:baseline===null}:{}),historicalMessages:[...historicalMessages.values()]})})
   }
   return entries
  })
  const artifacts=latest(artifactEntries.filter(entry=>entry.item.kind==='artifact'))
  const revisions=latest(artifactEntries.filter(entry=>entry.item.kind==='revision'))

  const present=await read(async()=>(await db.query('select name from unnest($1::text[]) as name where to_regclass(name) is not null',[['teloa_security_approvals','teloa_security_actions']])).rows.length)
  if(present!==2)throw corrupt()
  // 审批的时间窗判在 `teloa_security_approvals.created_at` 上（决定发生的时刻），不看发起动作或所属运行的时刻。
  const approvalRows=await read(async()=>(await db.query(`with ${dayWorkSources}
   select distinct a.id,a.action_id,a.decision,a.reason,a.created_at,a.frozen,s.title,s.scope_id
   from teloa_security_approvals a
   join teloa_security_actions s on s.id=a.action_id and s.owner_id=a.owner_id
   join work_runs r on r.task_id=s.task_id and r.owner_id=s.owner_id
   where a.owner_id=$1 and r.role_id=$2 and a.created_at>=$3 and a.created_at<$4 and s.scope_id=any($5::text[]) order by a.id`,[ownerId,identity.roleId,from,to,allowedScopes])).rows)
  // 先限定当天本岗位来源，再复用正式固定图；历史决定不重判当前执行许可。
  let verifiedApprovals=new Map<string,{decision:string;reason:string;createdAt:string}>()
  if(approvalRows.length){
   try{
    const definition=createSecurityEndpointIsolateDefinition(),catalog={require(tool:string){if(tool!==definition.tool)throw corrupt();return definition}}
    const graph=await readSecurityActionGraph(db,{ownerId,approverId:ownerId,scopeIds:allowedScopes},catalog,[...new Set(approvalRows.map(row=>row.action_id as string))])
    verifiedApprovals=new Map(graph.approvals.map(approval=>[approval.id,approval]))
   }catch{throw new WorkError('teloa/storage-corrupt','每日小结的审批来源记录损坏，已停止读取。',{sourceKind:'approval',sourceIds:approvalRows.map(row=>row.id)})}
  }
  const approvals:ScopedEvidence[]=approvalRows.map(row=>{
   const frozen=row.frozen
   if(!uuid(row.id)||!['approved','rejected'].includes(String(row.decision))||typeof row.title!=='string'||!row.title.trim()||!scope(row.scope_id))throw corrupt()
   if(!frozen||typeof frozen!=='object'||Array.isArray(frozen)||typeof row.reason!=='string'||!row.reason.trim())throw corrupt()
   const verified=verifiedApprovals.get(row.id as string)
   if(!verified||verified.decision!==row.decision||verified.reason!==row.reason||verified.createdAt!==stamp(row.created_at))throw corrupt()
   return {item:{kind:'approval' as const,id:row.id as string,version:1,title:label((row.decision==='approved'?'允许：':'拒绝：')+row.title)},scope:row.scope_id,text:JSON.stringify({decision:verified.decision,reason:verified.reason,createdAt:verified.createdAt})}
  })

  const candidateMessageRows=await read(async()=>(await db.query(`with ${dayWorkSources}
   select m.id,m.group_id,m.author_id,m.root_id,m.text,m.full_text,m.full_text_meta,m.created_at,m.run_id,r.task_id,g.definition->>'scope' as scope
   from teloa_group_messages m join teloa_groups g on g.id=m.group_id and g.owner_id=m.owner_id
   join work_runs r on r.owner_id=m.owner_id and r.id=m.run_id
   where m.owner_id=$1 and m.author_id=$2 and m.created_at>=$3 and m.created_at<$4
   and not exists(select 1 from jsonb_array_elements(m.reference_snapshot) ref join teloa_artifact_withdrawals w on w.owner_id=m.owner_id and w.artifact_id::text=ref->>'id' where ref->>'kind'='artifact')
   and g.definition->>'scope'=any($5::text[]) order by m.created_at,m.id`,[ownerId,identity.roleId,from,to,allowedScopes])).rows)
  const inputSources=await readArtifactRunSources(db,ownerId,candidateMessageRows.map(row=>row.run_id as string))
  const withdrawn=new Set((await db.query('select artifact_id from teloa_artifact_withdrawals where owner_id=$1 and artifact_id=any($2::uuid[])',[ownerId,[...new Set(inputSources.map(source=>source.artifactId))]])).rows.map(row=>row.artifact_id))
  const unavailableRuns=new Set(inputSources.filter(source=>withdrawn.has(source.artifactId)).map(source=>source.runId))
  const messageRows=candidateMessageRows.filter(row=>!unavailableRuns.has(row.run_id))
  await verifyTasks(messageRows.map(row=>row.task_id as string))
  const grants=new GroupAgentGrantService(pool,now),groupAccess=new Map<string,boolean>()
  const messageText=(row:Record<string,unknown>):string=>{
   if(row.full_text_meta!==null&&row.full_text_meta!==undefined)return readGroupMessageBody(row).text
   if(row.full_text!==null&&row.full_text!==undefined||typeof row.text!=='string'||!row.text.trim())throw corrupt()
   return row.text
  }
  const groupMessages:ScopedEvidence[]=await read(async()=>Promise.all(messageRows.map(async row=>{
   if(!uuid(row.id)||typeof row.text!=='string'||!row.text.trim())throw corrupt()
   if(row.scope!==null&&row.scope!==undefined&&!scope(row.scope))throw corrupt()
   let root:null|{id:string;text:string}=null
   if(row.root_id){
    if(!groupAccess.has(row.group_id)){
     try{groupAccess.set(row.group_id,(await grants.getInTransaction(db,ownerId,{groupId:row.group_id,roleId:identity.roleId})).status==='active')}
     catch(error){if(!(error instanceof WorkError)||error.code!=='teloa/forbidden')throw error;groupAccess.set(row.group_id,false)}
    }
    if(groupAccess.get(row.group_id)){
     // 仅取同本人、同群的精确话题根；不读取其他回帖或原生群历史。
     const stored=(await db.query('select id,group_id,author_id,text,full_text,full_text_meta from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3 and root_id is null',[ownerId,row.group_id,row.root_id])).rows[0]
     if(!stored)throw corrupt()
     root={id:stored.id,text:messageText(stored)}
    }
   }
   return {item:{kind:'group-message' as const,id:row.id as string,version:1,title:label('群回帖 · 话题 '+String(row.root_id??row.id).slice(0,8))},...(scope(row.scope)?{scope:row.scope}:{}),text:JSON.stringify({rootId:row.root_id??row.id,text:messageText(row),root,rootUnavailable:!!row.root_id&&!root,createdAt:stamp(row.created_at)})}
  })))

  // 各类交替入选，不能让大量运行挤掉全部成果、审批和本人修订；总上限仍为 60。
  const categories=[runs,artifacts,approvals,revisions,groupMessages],kept:ScopedEvidence[]=[]
  for(let index=0;kept.length<roleDailyLogEvidenceLimit&&categories.some(items=>items[index]);index++){
   for(const items of categories)if(items[index]&&kept.length<roleDailyLogEvidenceLimit)kept.push(items[index]!)
  }
  const keys=new Set(kept.map(entry=>entry.item.kind+'\0'+entry.item.id))
  const pick=(list:ScopedEvidence[])=>list.filter(entry=>keys.has(entry.item.kind+'\0'+entry.item.id)).map(entry=>entry.item)
  const scopeIds=[...new Set(kept.flatMap(entry=>entry.scope?[entry.scope]:[]))].sort().slice(0,30)
  return {day:identity.day,timezone,roleId:identity.roleId,roleVersion:identity.roleVersion,scopeIds,runs:pick(runs),artifacts:pick(artifacts),approvals:pick(approvals),revisions:pick(revisions),groupMessages:pick(groupMessages),contents:evidenceContents(kept)}
 }catch(error){if(error instanceof WorkError)throw error;throw corrupt()}
}

/** 同一成果当日多个版本只留最后一条：证据的唯一键是 `kind+id`。 */
function latest(items:ScopedEvidence[]):ScopedEvidence[]{
 const map=new Map<string,ScopedEvidence>()
 for(const entry of items){const kept=map.get(entry.item.id);if(!kept||kept.item.version<entry.item.version)map.set(entry.item.id,entry)}
 return [...map.values()]
}
