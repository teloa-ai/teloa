import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {readHabitRevisionEvidence} from './auto-dream-habits.ts'
import type {Pool,PoolClient} from 'pg'
import {WorkError,roleMemorySource,roleMemoryPreference,artifactContent,type RoleMemoryPreference,type DigitalRole,type RoleMemory,type RoleMemorySource} from '@teloa/contract'

type Db=Pick<PoolClient,'query'>
const schema='teloa.preference-candidate/v1' as const
type Kind=RoleMemoryPreference['kind']
type Against=NonNullable<RoleMemoryPreference['against']>
export type PreferenceProposal=RoleMemoryPreference
export type PreferenceMetadata={schema:typeof schema;kind:Kind;scope:string;taskId?:string;source:RoleMemorySource;basis:{kind:'owner-input'|'owner-confirmation'|'habit-observation'|'owner-revision';quote:string;quoteHash:string;taskId?:string;taskVersion?:number;messageId?:string;memoryId?:string;version?:number;contentHash?:string;evidenceId?:string;logId?:string;originTaskId?:string;originScope?:string;artifactId?:string};against?:Against;ownerEdit?:{requestId:string}}
export type PreferenceContext=PreferenceMetadata|{schema:'teloa.habit-observation/v1';kind:'observation';source:RoleMemorySource}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
const bad=()=>new WorkError('teloa/invalid-input','偏好候选需要明确类型、适用业务、本人依据；一次性例外需绑定本次任务，更正或反例需绑定原记忆版本。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','偏好来源或版本记录损坏，已停止读取。')
function object(v:unknown,keys:readonly string[]):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw bad();return v as Record<string,unknown>}


/** 只解析显式 preference 参数，正文始终是用户 Markdown。 */
export function preferenceProposal(value:unknown):PreferenceProposal|undefined{return value===undefined?undefined:roleMemoryPreference(value)}

/** 只回读已绑定 Run 的本人输入；不从日志指针扩展读取正文，也不接受员工/工具输出为本人意图。 */
export async function validatePreference(db:Db,actor:{ownerId:string;kind:'human'|'agent'},role:DigitalRole,source:RoleMemorySource,proposal:PreferenceProposal,body:string):Promise<PreferenceMetadata>{
 if(role.kind!=='twin'||role.ownerId!==actor.ownerId||!role.scopes.includes(proposal.scope))throw new WorkError('teloa/forbidden','个人偏好只属于当前本人分身及已授权业务。')
 let basis:PreferenceMetadata['basis'],taskId=proposal.taskId
 if(proposal.basis.kind==='owner-confirmation'){
  if(actor.kind!=='human'||proposal.taskId!==undefined||proposal.kind==='one-off'||proposal.kind==='counterexample')throw new WorkError('teloa/forbidden','本人声明只能由本人提交；一次性例外必须有原任务依据。')
  basis={kind:'owner-confirmation',quote:body.slice(0,8000),quoteHash:hash(body.slice(0,8000))}
 }else{
  if(source.kind!=='run'||source.version!==1)throw new WorkError('teloa/forbidden','偏好提议只能引用当前分身运行中的本人输入。')
  const r=(await db.query('select task_id,task_version,role_id,role_version,input_text,role_memory from teloa_task_runs where owner_id=$1 and id=$2 for share',[actor.ownerId,source.id])).rows[0]
  if(!r||r.role_id!==role.id||r.role_version!==role.version)throw new WorkError('teloa/forbidden','偏好依据不属于当前分身运行。')
  let input:Record<string,any>;try{input=JSON.parse(r.input_text)}catch{throw corrupt()}
  if(input.task?.id!==r.task_id||input.task?.version!==r.task_version||input.task?.scope!==proposal.scope||typeof input.task?.goal!=='string')throw new WorkError('teloa/forbidden','偏好适用范围与固定任务不一致。')
  if(proposal.against){
   const a=proposal.against,frozen=Array.isArray(r.role_memory)?r.role_memory.find((m:Record<string,unknown>)=>m.id===a.memoryId&&m.version===a.version&&m.contentHash===a.contentHash):undefined
   const selected=frozen&&Array.isArray(input.memory?.contents)&&input.memory.contents.some((m:unknown)=>isDeepStrictEqual(m,frozen))
   // 同 Run 的提议回执也已通过可信工具返回；本人后来编辑的新版本不会凭同一 ID 被隐式带入。
   const ownReceipt=selected?true:!!(await db.query(`select 1 from teloa_role_memory_creations where owner_id=$1 and memory_id=$2
    and result->'source'->>'kind'='run' and result->'source'->>'id'=$3 and result->'proposedBy'->>'kind'='role'
    and result->'proposedBy'->>'roleId'=$4 and (result->'proposedBy'->>'roleVersion')::int=$5
    and (result->'content'->>'version')::int=$6 and result->'content'->>'contentHash'=$7`,[actor.ownerId,a.memoryId,source.id,role.id,role.version,a.version,a.contentHash])).rows[0]
   if(!ownReceipt)throw new WorkError('teloa/forbidden','更正或反例的原记忆版本不在本次获准上下文或本轮提议回执中。')
  }
  if(proposal.basis.kind==='habit-observation'){
   const b=proposal.basis,frozen=Array.isArray(r.role_memory)?r.role_memory.find((m:Record<string,unknown>)=>m.id===b.memoryId):undefined
   if(!frozen||frozen.version!==b.version||frozen.contentHash!==b.contentHash||frozen.visibility?.kind!=='private'||!Array.isArray(input.memory?.contents)||!input.memory.contents.some((m:unknown)=>isDeepStrictEqual(m,frozen)))throw new WorkError('teloa/forbidden','习惯依据不在本次运行已获准的固定上下文中。')
   const origin=roleMemorySource(frozen.source)
   if(origin.kind!=='habit-digest'||typeof frozen.markdown!=='string'||hash(frozen.markdown)!==b.contentHash)throw new WorkError('teloa/forbidden','偏好依据必须是已核验的私有习惯观察。')
   const saved=(await db.query(`select m.role_id,m.state,m.current_version,m.source_snapshot,v.markdown,v.content_hash from teloa_role_memories m
    join teloa_role_memory_versions v on v.owner_id=m.owner_id and v.memory_id=m.id and v.number=$3
    where m.owner_id=$1 and m.id=$2 for share of m`,[actor.ownerId,b.memoryId,b.version])).rows[0]
   const log=(await db.query('select role_id,state,kind,markdown,evidence from teloa_role_daily_logs where owner_id=$1 and id=$2 for share',[actor.ownerId,origin.id])).rows[0]
   if(!saved||saved.role_id!==role.id||saved.state!=='confirmed'||saved.current_version!==b.version||saved.content_hash!==b.contentHash||!isDeepStrictEqual(saved.source_snapshot?.source,origin)||!log||log.role_id!==role.id||log.state!=='kept'||log.kind!=='habit-digest'||saved.markdown!==log.markdown||saved.markdown!==frozen.markdown||!Array.isArray(log.evidence)||!log.evidence.some((e:Record<string,unknown>)=>e.kind==='approval'&&e.id===b.evidenceId&&e.version===1))throw new WorkError('teloa/version-conflict','习惯依据已修改、撤回或不属于当前分身。')
   // 只核对已展示在固定观察中的理由，不拉取指针背后的新正文，也不把词频作为偏好证据。
   const decision=(await db.query('select a.reason,s.task_id,s.scope_id from teloa_security_approvals a join teloa_security_actions s on s.owner_id=a.owner_id and s.id=a.action_id where a.owner_id=$1 and a.id=$2',[actor.ownerId,b.evidenceId])).rows[0]
   if(!decision||decision.reason!==b.quote||!saved.markdown.includes(b.quote))throw new WorkError('teloa/forbidden','偏好依据必须是固定观察里可回溯的本人决定理由，不能来自统计或工具输出。')
   if(decision.scope_id!==proposal.scope)throw new WorkError('teloa/forbidden','审批观察的源业务必须与偏好适用业务一致；跨业务要求须由本人重新明确声明。')
   if(proposal.kind==='one-off'||proposal.kind==='counterexample'){
    if(taskId!==undefined&&taskId!==decision.task_id)throw new WorkError('teloa/forbidden','一次性决定不能转移到另一任务。')
    taskId=decision.task_id
   }
   basis={kind:'habit-observation',quote:b.quote,quoteHash:hash(b.quote),taskId:r.task_id,taskVersion:r.task_version,memoryId:b.memoryId,version:b.version,contentHash:b.contentHash,evidenceId:b.evidenceId,logId:origin.id,originTaskId:decision.task_id,originScope:decision.scope_id}
  }else if(proposal.basis.kind==='owner-revision'){
   const b=proposal.basis,files=input.groupContext?.files
   const file=Array.isArray(files)?files.find((f:Record<string,unknown>)=>f.kind==='artifact'&&f.id===b.artifactId&&f.version===b.version&&typeof f.text==='string'&&f.text.includes(b.quote)):undefined
   if(!file)throw new WorkError('teloa/forbidden','修订依据必须是本次已获准上下文中实际展示的成果固定版本，不能追读观察指针。')
   const v=(await db.query(`select v.content,v.source,v.created_at,a.current_version from teloa_artifact_versions v join teloa_artifacts a on a.owner_id=v.owner_id and a.id=v.artifact_id
    where v.owner_id=$1 and v.artifact_id=$2 and v.number=$3 and not exists(select 1 from teloa_artifact_withdrawals w where w.owner_id=v.owner_id and w.artifact_id=v.artifact_id) for share of a`,[actor.ownerId,b.artifactId,b.version])).rows[0]
   if(!v||v.current_version!==b.version||v.source.scope!==proposal.scope||!(v.created_at instanceof Date)||!artifactContent(v.content).sections.some(s=>s.text.includes(b.quote)))throw new WorkError('teloa/version-conflict','本人修订版本已变化、撤回或与获准业务不一致。')
   // 复用四源事实链的员工初版/本人修订归属判据；只读取已展示版本的正文，不自动获取其它来源。
   const origins=await readHabitRevisionEvidence(db as PoolClient,actor.ownerId,v.created_at,new Date(v.created_at.getTime()+1))
   if(!origins.some(o=>o.artifact_id===b.artifactId&&o.number===b.version))throw new WorkError('teloa/forbidden','员工或工具生成的成果不能冒充本人修订。')
   if(taskId!==undefined&&taskId!==r.task_id)throw new WorkError('teloa/forbidden','修订产生的本次例外不能转移到另一任务。')
   if(proposal.kind==='one-off'||proposal.kind==='counterexample')taskId=r.task_id
   basis={kind:'owner-revision',quote:b.quote,quoteHash:hash(b.quote),taskId:r.task_id,taskVersion:r.task_version,artifactId:b.artifactId,version:b.version,contentHash:file.sha256}
  }else{
  if(taskId!==undefined&&taskId!==r.task_id)throw new WorkError('teloa/forbidden','一次性要求只能绑定本次本人任务。')
  let text:string,messageId:string|undefined
  if(input.groupContext){
   const g=input.groupContext,requests=[g.ownerRequest,...(g.ownerRequest?.priorRequests??[]),g.source].filter(Boolean)
   const frozen=requests.find((m:Record<string,unknown>)=>typeof m.text==='string'&&m.text.includes(proposal.basis.kind==='owner-input'?proposal.basis.quote:''))
   const id=frozen?.messageId,groupId=g.groupId
   const m=uuid(id)&&uuid(groupId)?(await db.query("select id,text from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3 and author_id='self' for share",[actor.ownerId,groupId,id])).rows[0]:undefined
   if(!m||m.text!==frozen.text||frozen.sha256!==undefined&&frozen.sha256!==hash(m.text))throw new WorkError('teloa/forbidden','员工或工具回帖及未获准本人消息不能作为偏好依据。')
   if((proposal.kind==='one-off'||proposal.kind==='counterexample')&&m.id!==g.source?.messageId){
    const current=(await db.query("select 1 from teloa_group_work_inputs where owner_id=$1 and task_id=$2 and message_id=$3 and operation='continue' and state='continued' and task_version<=$4",[actor.ownerId,r.task_id,m.id,r.task_version])).rows[0]
    if(!current)throw new WorkError('teloa/forbidden','原任务的一次性要求不能经员工接力转移到派生任务。')
   }
   text=frozen.text;messageId=m.id
  }else{
   const lineage=(await db.query("select 1 from teloa_task_work_lineage where owner_id=$1 and task_id=$2 and source->>'kind'='owner-task' and source->>'taskId'=$2::text",[actor.ownerId,r.task_id])).rows[0]
   if(!lineage)throw new WorkError('teloa/forbidden','员工接力或工具产物不能升级为本人偏好。')
   text=input.task.goal
  }
  if(!text.includes(proposal.basis.quote))throw new WorkError('teloa/forbidden','偏好引用不在已授权的本人输入中。')
  if(proposal.kind==='one-off'||proposal.kind==='counterexample')taskId=r.task_id
  basis={kind:'owner-input',quote:proposal.basis.quote,quoteHash:hash(proposal.basis.quote),taskId:r.task_id,taskVersion:r.task_version,...(messageId?{messageId}:{})}
  }
 }
 await assertPreferenceRelationCurrent(db,actor.ownerId,role.id,proposal)
 return {schema,kind:proposal.kind,scope:proposal.scope,...(taskId?{taskId}:{}),source,basis,...(proposal.against?{against:proposal.against}:{})}
}

export async function assertPreferenceRelationCurrent(db:Db,owner:string,roleId:string,value:Pick<PreferenceProposal,'against'|'scope'>):Promise<void>{
 if(!value.against)return
 const other=(await db.query('select role_id,state,current_version from teloa_role_memories where owner_id=$1 and id=$2 for share',[owner,value.against.memoryId])).rows[0]
 if(!other||other.role_id!==roleId||other.state!=='confirmed'||other.current_version!==value.against.version)throw new WorkError('teloa/version-conflict','更正或反例的原记忆版本已变化。')
 const version=(await db.query('select content_hash from teloa_role_memory_versions where owner_id=$1 and memory_id=$2 and number=$3',[owner,value.against.memoryId,value.against.version])).rows[0]
 if(version?.content_hash!==value.against.contentHash)throw new WorkError('teloa/version-conflict','更正或反例的原记忆摘要已变化。')
 const previous=await readPreference(db,owner,value.against.memoryId,value.against.version,value.against.contentHash)
 if(!previous||!['preference','correction'].includes(previous.kind)||previous.scope!==value.scope)throw new WorkError('teloa/forbidden','更正或反例必须对应同一本人和业务的长期偏好。')
 if((await preferenceEffects(db,owner,roleId)).some(effect=>effect.kind==='correction'&&effect.against?.memoryId===value.against!.memoryId&&effect.against.version===value.against!.version&&effect.against.contentHash===value.against!.contentHash))throw new WorkError('teloa/version-conflict','原偏好已被本人明确更正，请引用当前记忆版本。')
}

export async function initializePreferenceMetadata(pool:Pool):Promise<void>{await pool.query(`create table if not exists teloa_role_memory_preference_versions(
 owner_id text not null,memory_id uuid not null,number integer not null,content_hash text not null,metadata jsonb not null,
 primary key(owner_id,memory_id,number),foreign key(owner_id,memory_id,number) references teloa_role_memory_versions(owner_id,memory_id,number));
 create or replace trigger teloa_role_memory_preference_versions_immutable before update or delete on teloa_role_memory_preference_versions for each row execute function teloa_reject_role_memory_version_mutation();`)}
export async function writePreference(db:Db,owner:string,id:string,version:number,contentHash:string,metadata:PreferenceMetadata):Promise<void>{await db.query('insert into teloa_role_memory_preference_versions values($1,$2,$3,$4,$5)',[owner,id,version,contentHash,JSON.stringify(metadata)])}
export function readPreferenceContext(value:unknown):PreferenceContext{
 try{
  const r=object(value,['schema','kind','scope','taskId','source','basis','against','ownerEdit'])
  const s=roleMemorySource(r.source)
  if(r.schema==='teloa.habit-observation/v1'&&r.kind==='observation'&&Object.keys(r).length===3&&s.kind==='habit-digest')return value as PreferenceContext
  const b=object(r.basis,['kind','quote','quoteHash','taskId','taskVersion','messageId','memoryId','version','contentHash','evidenceId','logId','originTaskId','originScope','artifactId'])
  const basis=b.kind==='habit-observation'?{kind:b.kind,quote:b.quote,memoryId:b.memoryId,version:b.version,contentHash:b.contentHash,evidenceId:b.evidenceId}:b.kind==='owner-input'?{kind:b.kind,quote:b.quote}:b.kind==='owner-revision'?{kind:b.kind,quote:b.quote,artifactId:b.artifactId,version:b.version}:{kind:b.kind}
  preferenceProposal({schema:r.schema,kind:r.kind,scope:r.scope,...(r.taskId?{taskId:r.taskId}:{}),basis,...(r.against?{against:r.against}:{})})??(()=>{throw bad()})()
  if((r.kind==='one-off'||r.kind==='counterexample')&&!uuid(r.taskId))throw bad()
  if(typeof b.quote!=='string'||b.quoteHash!==hash(b.quote)||(b.kind==='owner-input'||b.kind==='habit-observation'||b.kind==='owner-revision')&&(!uuid(b.taskId)||!positive(b.taskVersion))||b.messageId!==undefined&&!uuid(b.messageId))throw bad()
  if(b.kind==='habit-observation'&&(!uuid(b.logId)||!uuid(b.originTaskId)||typeof b.originScope!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(b.originScope)))throw bad()
  if(b.kind==='owner-revision'&&(typeof b.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(b.contentHash)))throw bad()
  if(r.ownerEdit!==undefined&&!uuid(object(r.ownerEdit,['requestId']).requestId))throw bad()
  return value as PreferenceMetadata
 }catch{throw corrupt()}
}
export async function readPreference(db:Db,owner:string,id:string,version:number,contentHash:string):Promise<PreferenceMetadata|undefined>{
 const row=(await db.query('select content_hash,metadata from teloa_role_memory_preference_versions where owner_id=$1 and memory_id=$2 and number=$3',[owner,id,version])).rows[0]
 if(!row)return
 if(row.content_hash!==contentHash)throw corrupt()
 const metadata=readPreferenceContext(row.metadata);if(metadata.kind==='observation')throw corrupt();return metadata
}

export async function preferenceBasisAvailable(db:Db,owner:string,roleId:string,value:PreferenceMetadata):Promise<boolean>{
 const b=value.basis
 if(b.kind==='owner-revision')return !!(await db.query(`select 1 from teloa_artifacts a where a.owner_id=$1 and a.id=$2 and a.current_version=$3
  and not exists(select 1 from teloa_artifact_withdrawals w where w.owner_id=a.owner_id and w.artifact_id=a.id) for share of a`,[owner,b.artifactId,b.version])).rows[0]
 if(b.kind!=='habit-observation')return true
 const row=(await db.query(`select m.role_id,m.state,m.current_version,m.source_snapshot,v.content_hash,l.state as log_state,l.role_id as log_role
  from teloa_role_memories m join teloa_role_memory_versions v on v.owner_id=m.owner_id and v.memory_id=m.id and v.number=$3
  join teloa_role_daily_logs l on l.owner_id=m.owner_id and l.id=$4
  where m.owner_id=$1 and m.id=$2 for share of m,l`,[owner,b.memoryId,b.version,b.logId])).rows[0]
 return !!row&&row.role_id===roleId&&row.log_role===roleId&&row.state==='confirmed'&&row.current_version===b.version&&row.content_hash===b.contentHash&&row.log_state==='kept'&&row.source_snapshot?.source?.kind==='habit-digest'&&row.source_snapshot.source.id===b.logId
}

async function preferenceEffects(db:Db,owner:string,roleId:string):Promise<PreferenceMetadata[]>{
 return (await db.query(`select p.metadata from teloa_role_memory_preference_versions p join teloa_role_memories m on m.owner_id=p.owner_id and m.id=p.memory_id
  where p.owner_id=$1 and m.role_id=$2 and (exists(select 1 from teloa_role_memory_changes c where c.owner_id=p.owner_id and c.memory_id=p.memory_id and c.result->>'state'='confirmed' and (c.result->'content'->>'version')::int=p.number)
  or exists(select 1 from teloa_role_memory_edits e where e.owner_id=p.owner_id and e.memory_id=p.memory_id and e.result->>'state'='confirmed' and e.result_version=p.number))`,[owner,roleId])).rows.map(row=>readPreferenceContext(row.metadata)).filter((item):item is PreferenceMetadata=>item.kind!=='observation')
}
/** 只认本人已确认的固定关系；确认事务可额外预估本次已核验的关系。撤回更正不恢复旧版。 */
export async function effectivePreferenceMemories(db:Db,owner:string,roleId:string,memories:RoleMemory[],target?:{scope:string;taskId?:string},pendingConfirmation?:PreferenceMetadata):Promise<RoleMemory[]>{
 if(!memories.length)return []
 const effects=[...await preferenceEffects(db,owner,roleId),...(pendingConfirmation?[pendingConfirmation]:[])]
 const result:RoleMemory[]=[]
 for(const memory of memories){
  const meta=await readPreference(db,owner,memory.id,memory.content.version,memory.content.contentHash)
  if(meta&&!await preferenceBasisAvailable(db,owner,roleId,meta))continue
  if(target&&meta&&(meta.scope!==target.scope||meta.taskId!==undefined&&meta.taskId!==target.taskId))continue
  if(effects.some(effect=>effect.against?.memoryId===memory.id&&effect.against.version===memory.content.version&&effect.against.contentHash===memory.content.contentHash&&(effect.kind==='correction'||effect.kind==='counterexample'&&target?.taskId!==undefined&&effect.taskId===target.taskId)))continue
  result.push(memory)
 }
 return result
}
