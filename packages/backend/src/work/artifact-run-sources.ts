import type {PoolClient} from 'pg'
import {savedArtifactSource,WorkError} from '@teloa/contract'

type Db=Pick<PoolClient,'query'>
type Run={id:string;task_id:string;task_version:number;session_id:string;created_at:Date}
export type ArtifactRunSource={runId:string;artifactId:string;version?:number}
const corrupt=()=>new WorkError('teloa/storage-corrupt','成果与运行的固定来源记录损坏，已停止读取。')
const time=(value:unknown):number=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.getTime()}
/** 官方Task来源是保存时的状态版本，不是Run的起始版本。旧任意版本串只能回退到保存时间边界。 */
function taskStateVersion(value:string):number|undefined{
 const match=/^([1-9][0-9]*) · (.+)$/.exec(value)
 if(!match)return
 const version=Number(match[1]),stamp=Date.parse(match[2]!)
 if(!Number.isSafeInteger(version)||!Number.isFinite(stamp)||new Date(stamp).toISOString()!==match[2])return
 return version
}
/**
 * 回溯实际历史输入，不把同Task所有未来Run视为同一成果来源。
 * 精确生产回执/原生来源/已登记输入优先；没有生产回执的旧Task来源只覆盖保存时已存在的历史。
 */
export async function readArtifactRunSources(db:Db,owner:string,runIds:readonly string[]):Promise<ArtifactRunSource[]>{
 if(!runIds.length)return []
 const runs=(await db.query('select id,task_id,task_version,session_id,created_at from teloa_task_runs where owner_id=$1 and id=any($2::uuid[])',[owner,[...new Set(runIds)]])).rows as Run[]
 const result=new Map<string,ArtifactRunSource>(),add=(run:Run,artifactId:string,version?:number)=>{
  const ref={runId:run.id,artifactId,...(version===undefined?{}:{version})};result.set(JSON.stringify([run.id,artifactId,version??null]),ref)
 }
 const tasks=[...new Set(runs.map(run=>run.task_id))],sessions=[...new Set(runs.map(run=>run.session_id))]
 const versions=(await db.query(`select v.artifact_id,v.number,v.source,v.created_at,p.run_id as producer_run_id
  from teloa_artifact_versions v left join teloa_artifact_revision_producers p on p.owner_id=v.owner_id and p.artifact_id=v.artifact_id and p.number=v.number
  where v.owner_id=$1 and ((v.source->>'kind'='run' and v.source->>'id'=any($2::text[]))
   or (v.source->>'kind'='task' and v.source->>'id'=any($3::text[]))
   or (v.source->>'kind'='session' and v.source->>'id'=any($4::text[])) or p.run_id=any($2::uuid[]))
  order by v.artifact_id,v.number`,[owner,runs.map(run=>run.id),tasks,sessions])).rows
 for(const row of versions){
  let source:ReturnType<typeof savedArtifactSource>;try{source=savedArtifactSource(row.source)}catch{throw corrupt()}
  const savedAt=time(row.created_at),stateVersion=source.kind==='task'?taskStateVersion(source.version):undefined
  for(const run of runs){
   if(!Number.isSafeInteger(run.task_version)||run.task_version<1)throw corrupt()
   const exact=row.producer_run_id===run.id||source.kind==='run'&&source.id===run.id||source.kind==='session'&&source.id===run.session_id
   // 回执已经给出精确生产者时不再按Task扩大范围。旧Task保存通常晚于原Run，故用<=而非版本相等。
   const historicalTask=source.kind==='task'&&source.id===run.task_id&&!row.producer_run_id&&time(run.created_at)<=savedAt&&(stateVersion===undefined||run.task_version<=stateVersion)
   if(exact||historicalTask)add(run,row.artifact_id,row.number)
  }
 }
 const bindings=(await db.query('select session_id,artifact_id from teloa_artifact_input_sources where owner_id=$1 and session_id=any($2::text[])',[owner,sessions])).rows
 for(const binding of bindings)for(const run of runs)if(run.session_id===binding.session_id)add(run,binding.artifact_id)
 return [...result.values()].sort((a,b)=>a.runId.localeCompare(b.runId)||a.artifactId.localeCompare(b.artifactId)||(a.version??0)-(b.version??0))
}
