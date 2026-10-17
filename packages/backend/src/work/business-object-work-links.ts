import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,readBusinessWorkLink,readBusinessWorkResultPublish,readBusinessRecordReceipt,readBusinessRecordGet,businessObjectReference,readBusinessWorkCursor,readBusinessResultCursor,type BusinessWorkCursor,type BusinessResultCursor,type BusinessWorkPage,type BusinessObjectWorkLink,type BusinessWorkResultVersion} from '@teloa/contract'
import {businessObjectSnapshotHash,readBusinessObjectSnapshot} from './business-data.ts'
import type {BusinessChangeSetOrigin} from './business-change-sets.ts'
type Actor={ownerId:string;scopeIds:string[]}
type Ports={authorizeSession:(db:PoolClient,actor:Actor,scope:string,sessionId:string)=>Promise<void>}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export async function initializeBusinessObjectWork(pool:Pool){await pool.query(`create table if not exists teloa_business_object_work_links(
 owner_id text not null,id text not null,scope_id text not null,object_type text not null,object_id text not null,object_version integer not null,document jsonb not null,primary key(owner_id,id),
 foreign key(owner_id,scope_id,object_type,object_id,object_version) references teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version));
 create table if not exists teloa_business_work_results(owner_id text not null,work_link_id text not null,slot text not null,revision integer not null check(revision>0),document jsonb not null,primary key(owner_id,work_link_id,slot,revision),foreign key(owner_id,work_link_id) references teloa_business_object_work_links(owner_id,id));
 create table if not exists teloa_business_work_requests(owner_id text not null,request_id text not null,request_hash text not null,document jsonb not null,primary key(owner_id,request_id));`)}
/** 普通工作只保存分析与成果引用；任务分析继续读取原成果回执。 */
export class BusinessObjectWorkLinkService{
 private readonly pool:Pool;private readonly identity:{id:()=>string;now:()=>string};private readonly ports:Ports
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},ports:Ports){this.pool=pool;this.identity=identity;this.ports=ports}
 private authorize(actor:Actor,scope:string){if(!actor?.ownerId||!actor.scopeIds?.includes(scope))throw new WorkError('teloa/forbidden','当前本人无权访问这项业务工作。')}
 private async tx<T>(run:(db:PoolClient)=>Promise<T>){const db=await this.pool.connect();try{await db.query('begin');const result=await run(db);await db.query('commit');return result}catch(e){await db.query('rollback');throw e}finally{db.release()}}
 private async request<T>(db:PoolClient,actor:Actor,id:string,hash:string,run:()=>Promise<T>):Promise<T>{
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['business-work',actor.ownerId,id])])
  const prior=(await db.query('select request_hash,document from teloa_business_work_requests where owner_id=$1 and request_id=$2',[actor.ownerId,id])).rows[0]
  if(prior){if(prior.request_hash!==hash)throw new WorkError('teloa/conflict','原请求已经保存其他工作或成果。');return prior.document}
  const result=await run();await db.query('insert into teloa_business_work_requests values($1,$2,$3,$4)',[actor.ownerId,id,hash,JSON.stringify(result)]);return result
 }
 private async get(db:PoolClient,actor:Actor,id:string,lock=false):Promise<BusinessObjectWorkLink>{readBusinessRecordReceipt({requestId:id});const row=(await db.query('select document from teloa_business_object_work_links where owner_id=$1 and id=$2'+(lock?' for update':''),[actor.ownerId,id])).rows[0];if(!row)throw new WorkError('teloa/not-found','业务工作不存在。');this.authorize(actor,row.document.reference.scope);return row.document}
 async link(actor:Actor,value:unknown):Promise<BusinessObjectWorkLink>{const input=readBusinessWorkLink(value),ref=input.reference;this.authorize(actor,ref.scope)
  return this.tx(async db=>{await this.ports.authorizeSession(db,actor,ref.scope,input.sessionId);return this.request(db,actor,input.requestId,digest(input),async()=>{
   const row=(await db.query('select snapshot,snapshot_hash from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 and object_version=$5 for key share',[actor.ownerId,ref.scope,ref.type,ref.id,ref.version])).rows[0]
   if(!row||row.snapshot_hash!==ref.snapshotHash||businessObjectSnapshotHash(readBusinessObjectSnapshot(row.snapshot,ref.scope))!==ref.snapshotHash||row.snapshot.deletedAt)throw new WorkError('teloa/version-conflict','关联对象来源已失效。')
   const result={id:this.identity.id(),reference:ref,sessionId:input.sessionId,title:input.title,createdAt:this.identity.now()};await db.query('insert into teloa_business_object_work_links values($1,$2,$3,$4,$5,$6,$7)',[actor.ownerId,result.id,ref.scope,ref.type,ref.id,ref.version,JSON.stringify(result)]);return result
  })})
 }
 async listPage(actor:Actor,input:{scope:string;type:string;id:string;cursor?:BusinessWorkCursor|undefined}):Promise<BusinessWorkPage<BusinessObjectWorkLink,BusinessWorkCursor>>{
  const target=readBusinessRecordGet({scope:input.scope,type:input.type,id:input.id});this.authorize(actor,target.scope);const cursor=readBusinessWorkCursor(input.cursor)
  return this.workPage((await this.pool.query(`select document from teloa_business_object_work_links where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4
   and ($5::text is null or (document->>'createdAt',id)<($5,$6)) order by document->>'createdAt' desc,id desc limit 21`,[actor.ownerId,target.scope,target.type,target.id,cursor?.at??null,cursor?.id??null])).rows)
 }
 async list(actor:Actor,input:{scope:string;type:string;id:string}){return (await this.listPage(actor,input)).items}
 private workPage(rows:{document:BusinessObjectWorkLink}[]):BusinessWorkPage<BusinessObjectWorkLink,BusinessWorkCursor>{const items=rows.slice(0,20).map(r=>r.document),last=items.at(-1);return {items,...(rows.length>20&&last?{nextCursor:{at:last.createdAt,id:last.id}}:{})}}
 async bySessionPage(actor:Actor,input:{scope:string;sessionId:string;cursor?:BusinessWorkCursor|undefined}):Promise<BusinessWorkPage<BusinessObjectWorkLink,BusinessWorkCursor>>{this.authorize(actor,input.scope);const cursor=readBusinessWorkCursor(input.cursor);return this.workPage((await this.pool.query(`select document from teloa_business_object_work_links where owner_id=$1 and scope_id=$2 and document->>'sessionId'=$3 and ($4::text is null or (document->>'createdAt',id)<($4,$5)) order by document->>'createdAt' desc,id desc limit 21`,[actor.ownerId,input.scope,input.sessionId,cursor?.at??null,cursor?.id??null])).rows)}
 async bySession(actor:Actor,input:{scope:string;sessionId:string}){return (await this.bySessionPage(actor,input)).items}
 async publish(actor:Actor,value:unknown,source:BusinessChangeSetOrigin):Promise<BusinessWorkResultVersion>{const input=readBusinessWorkResultPublish(value)
  return this.tx(async db=>{const link=await this.get(db,actor,input.workLinkId,true);if(source?.sessionId!==link.sessionId||!source.messageId||!Number.isSafeInteger(source.seq)||source.seq<1)throw new WorkError('teloa/forbidden','成果需要原工作会话的真实指令。')
   await this.ports.authorizeSession(db,actor,link.reference.scope,link.sessionId)
   return this.request(db,actor,input.requestId,digest({input,source}),async()=>{
    const ref=link.reference,current=(await db.query('select object_version,snapshot_hash from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 order by object_version desc limit 1',[actor.ownerId,ref.scope,ref.type,ref.id])).rows[0]
    if(!current||current.object_version!==ref.version||current.snapshot_hash!==ref.snapshotHash)throw new WorkError('teloa/version-conflict','原业务对象已更新，请基于当前来源开始工作。')
    const revision=(await db.query('select coalesce(max(revision),0)::int revision from teloa_business_work_results where owner_id=$1 and work_link_id=$2 and slot=$3',[actor.ownerId,link.id,input.slot])).rows[0].revision
    if(revision!==input.expectedRevision)throw new WorkError('teloa/version-conflict','已有更新成果，请读取固定版本后继续。')
    for(const artifact of input.artifactVersions){const stored=(await db.query('select source from teloa_artifact_versions where owner_id=$1 and artifact_id=$2 and number=$3',[actor.ownerId,artifact.artifactId,artifact.number])).rows[0];if(!stored||stored.source.kind!=='session'||stored.source.id!==source.sessionId)throw new WorkError('teloa/forbidden','成果版本不属于原本人工作会话。')}
    const result:BusinessWorkResultVersion={workLinkId:link.id,slot:input.slot,revision:revision+1,digest:digest({input,source,reference:link.reference}),summary:input.summary,state:input.state,source:{sessionId:source.sessionId,messageId:source.messageId,seq:source.seq},artifactVersions:input.artifactVersions,createdAt:this.identity.now()}
    await db.query('insert into teloa_business_work_results values($1,$2,$3,$4,$5)',[actor.ownerId,link.id,input.slot,result.revision,JSON.stringify(result)]);return result
   })
  })
 }
 async resultsPage(actor:Actor,input:{workLinkId:string;cursor?:BusinessResultCursor|undefined}):Promise<BusinessWorkPage<BusinessWorkResultVersion,BusinessResultCursor>>{const cursor=readBusinessResultCursor(input.cursor);return this.tx(async db=>{await this.get(db,actor,input.workLinkId);const rows=(await db.query(`select document,slot,revision from teloa_business_work_results where owner_id=$1 and work_link_id=$2 and ($3::text is null or slot>$3 or (slot=$3 and revision<$4)) order by slot,revision desc limit 21`,[actor.ownerId,input.workLinkId,cursor?.slot??null,cursor?.revision??null])).rows,items=rows.slice(0,20).map(r=>r.document),last=rows[19];return {items,...(rows.length>20?{nextCursor:{slot:last.slot,revision:last.revision}}:{})}})}
 async results(actor:Actor,input:{workLinkId:string}){return (await this.resultsPage(actor,input)).items}
 async read(actor:Actor,input:{workLinkId:string}){return this.tx(db=>this.get(db,actor,input.workLinkId))}
 async taskResults(actor:Actor,input:{scope:string;type:string;id:string}){const target=readBusinessRecordGet(input);this.authorize(actor,target.scope)
  return (await this.pool.query(`select run_id,mapping_id,execution from teloa_business_task_result_receipts where owner_id=$1 and execution->'reference'->>'scope'=$2 and execution->'reference'->>'type'=$3 and execution->'reference'->>'id'=$4 order by execution->>'createdAt' desc,run_id limit 100`,[actor.ownerId,target.scope,target.type,target.id])).rows.map(r=>({runId:r.run_id,mappingId:r.mapping_id,taskId:r.execution.taskId,sessionId:r.execution.sessionId,reference:businessObjectReference(r.execution.reference),resultReferences:(r.execution.resultReferences??[]).map(businessObjectReference),createdAt:r.execution.createdAt}))
 }
}
