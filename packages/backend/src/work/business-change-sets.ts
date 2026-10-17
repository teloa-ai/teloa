import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,readBusinessChangeSetPrepare,readBusinessChangeSetApply,readBusinessRecordReceipt,readBusinessWorkCursor,type BusinessWorkCursor,type BusinessWorkPage,type BusinessChangeSet} from '@teloa/contract'
import type {BusinessRecordService,BusinessRecordBatchSource} from './business-records.ts'
type Actor={ownerId:string;scopeIds:string[]}
export type BusinessChangeSetOrigin=BusinessRecordBatchSource&{fingerprint:string}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const error=(code:'teloa/forbidden'|'teloa/conflict'|'teloa/not-found'|'teloa/version-conflict',message:string)=>new WorkError(code,message)
export async function initializeBusinessChangeSets(pool:Pool){
 await pool.query(`create table if not exists teloa_business_change_sets(owner_id text not null,id text not null,scope_id text not null,document jsonb not null,origin jsonb not null,primary key(owner_id,id));
 create table if not exists teloa_business_change_requests(owner_id text not null,request_id text not null,request_hash text not null,document jsonb not null,primary key(owner_id,request_id));`)
}
/** 草稿与记录共用一个事务；此服务没有可从 RPC 反序列化的批准字段。 */
export class BusinessChangeSetService{
 private readonly pool:Pool
 private readonly identity:{id:()=>string;now:()=>string}
 private readonly records:BusinessRecordService
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},records:BusinessRecordService){this.pool=pool;this.identity=identity;this.records=records}
 private async transaction<T>(run:(db:PoolClient)=>Promise<T>){const db=await this.pool.connect();try{await db.query('begin');const result=await run(db);await db.query('commit');return result}catch(e){await db.query('rollback');throw e}finally{db.release()}}
 private authorize(actor:Actor,scope:string){if(!actor?.ownerId||!actor.scopeIds?.includes(scope))throw error('teloa/forbidden','当前本人无权访问这份业务修改。')}
 private async row(db:PoolClient,actor:Actor,id:string,lock=false){
  const {requestId}=readBusinessRecordReceipt({requestId:id}),row=(await db.query('select document,origin from teloa_business_change_sets where owner_id=$1 and id=$2'+(lock?' for update':''),[actor.ownerId,requestId])).rows[0]
  if(!row)throw error('teloa/not-found','业务修改草稿不存在。');this.authorize(actor,row.document.scope)
  return row as {document:BusinessChangeSet;origin:BusinessChangeSetOrigin}
 }
 private async save(db:PoolClient,actor:Actor,draft:BusinessChangeSet,origin:BusinessChangeSetOrigin){await db.query('insert into teloa_business_change_sets values($1,$2,$3,$4,$5) on conflict(owner_id,id) do update set document=excluded.document,origin=excluded.origin',[actor.ownerId,draft.id,draft.scope,JSON.stringify(draft),JSON.stringify(origin)])}
 async prepare(actor:Actor,value:unknown,origin:BusinessChangeSetOrigin):Promise<BusinessChangeSet>{
  const input=readBusinessChangeSetPrepare(value);this.authorize(actor,input.scope)
  if(!origin?.sessionId||!origin.messageId||!Number.isSafeInteger(origin.seq)||origin.seq<1||!origin.fingerprint)throw error('teloa/forbidden','需要真实的本人业务指令来源。')
  const requestHash=hash({input,origin})
  return this.transaction(async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['business-change',actor.ownerId,input.requestId])])
   const prior=(await db.query('select request_hash,document from teloa_business_change_requests where owner_id=$1 and request_id=$2',[actor.ownerId,input.requestId])).rows[0]
   if(prior){if(prior.request_hash!==requestHash)throw error('teloa/conflict','同一指令已准备另一份修改。');return prior.document}
   const existing=input.changeSetId?await this.row(db,actor,input.changeSetId,true):undefined
   if(existing&&(existing.document.scope!==input.scope||existing.document.revision!==input.expectedRevision||existing.document.state==='applied'))throw error('teloa/version-conflict','草稿已改变或已采用，请重新读取。')
   const batch={scope:input.scope,requestId:existing?.document.batch.requestId??this.identity.id(),operations:input.operations}
   const preview=await this.records.previewBatchInTransaction(db,actor,batch),id=existing?.document.id??this.identity.id(),revision=(existing?.document.revision??0)+1,now=this.identity.now()
   const document:BusinessChangeSet={schema:'teloa.business-change-set/v1',id,scope:input.scope,revision,digest:hash({id,revision,batch,preview,origin}),state:'draft',sessionId:origin.sessionId,batch,preview,createdAt:existing?.document.createdAt??now,updatedAt:now}
   if(Buffer.byteLength(JSON.stringify(document))>131072)throw new WorkError('teloa/invalid-input','完整预览超过 128 KiB，请缩小修改批次。')
   await this.save(db,actor,document,origin)
   await db.query('insert into teloa_business_change_requests values($1,$2,$3,$4)',[actor.ownerId,input.requestId,requestHash,JSON.stringify(document)]);return document
  })
 }
 async get(actor:Actor,input:{changeSetId:string}):Promise<BusinessChangeSet>{
  return this.transaction(async db=>{const row=await this.row(db,actor,input.changeSetId,true),origin=row.origin
   const document=row.document.state==='awaiting-approval'?{...row.document,state:'draft' as const}:row.document
   if(document!==row.document)await this.save(db,actor,document,origin)
   if(!['draft','awaiting-approval','stale'].includes(document.state))return document
   try{if((await this.records.previewBatchInTransaction(db,actor,document.batch)).fingerprint===document.preview.fingerprint)return document}catch(e){if(!(e instanceof WorkError)||!['teloa/version-conflict','teloa/conflict','teloa/invalid-input'].includes(e.code))throw e}
   const stale={...document,state:'stale' as const};await this.save(db,actor,stale,origin);return stale
  })
 }
 async listPage(actor:Actor,input:{scope:string;sessionId?:string;history?:boolean;cursor?:BusinessWorkCursor|undefined}):Promise<BusinessWorkPage<BusinessChangeSet,BusinessWorkCursor>>{
  this.authorize(actor,input.scope);const cursor=readBusinessWorkCursor(input.cursor)
  const rows=(await this.pool.query(`select document from teloa_business_change_sets where owner_id=$1 and scope_id=$2
   and (($3::boolean and document->>'state' in ('applied','rejected')) or (not $3::boolean and document->>'state' not in ('applied','rejected')))
   and ($4::text is null or document->>'sessionId'=$4) and ($5::text is null or (document->>'updatedAt',id)<($5,$6))
   order by document->>'updatedAt' desc,id desc limit 21`,[actor.ownerId,input.scope,input.history===true,input.sessionId??null,cursor?.at??null,cursor?.id??null])).rows
  const items:BusinessChangeSet[]=rows.slice(0,20).map(r=>r.document.state==='awaiting-approval'?{...r.document,state:'draft'}:r.document),last=items.at(-1)
  return {items,...(rows.length>20&&last?{nextCursor:{at:last.updatedAt,id:last.id}}:{})}
 }
 async reject(actor:Actor,input:{changeSetId:string;expectedRevision:number}):Promise<BusinessChangeSet>{
  return this.transaction(async db=>{const {document,origin}=await this.row(db,actor,input.changeSetId,true)
   if(document.revision!==input.expectedRevision)throw error('teloa/version-conflict','草稿版本已改变。');if(document.state==='applied')throw error('teloa/conflict','已采用的修改不能通过拒绝撤销。')
   const result={...document,state:'rejected' as const,updatedAt:this.identity.now()};await this.save(db,actor,result,origin);return result
  })
 }
 private check(document:BusinessChangeSet,input:{expectedRevision:number;expectedDigest:string}){if(document.revision!==input.expectedRevision||document.digest!==input.expectedDigest||document.state==='stale')throw error('teloa/version-conflict','修改内容或来源已改变，请重新准备并审阅。');if(document.state==='rejected')throw error('teloa/conflict','这份修改已被拒绝。')}
 async apply(actor:Actor,value:unknown,authorize:(db:PoolClient,origin:BusinessChangeSetOrigin)=>Promise<string>):Promise<BusinessChangeSet>{
  const input=readBusinessChangeSetApply(value)
  return this.transaction(async db=>{const {document,origin}=await this.row(db,actor,input.changeSetId,true);this.check(document,input)
   if(document.state==='applied')return document
   if(typeof authorize!=='function'||await authorize(db,origin)!==origin.fingerprint)throw error('teloa/forbidden','原生批准或当前业务授权不一致。')
   const receipt=await this.records.batchInTransaction(db,actor,document.batch,{sessionId:origin.sessionId,messageId:origin.messageId,seq:origin.seq},{scope:document.scope,guards:document.preview.definitions,previewFingerprint:document.preview.fingerprint,receiptPolicy:'new-only'})
   const result={...document,state:'applied' as const,receipt,updatedAt:this.identity.now()};await this.save(db,actor,result,origin)
   // 落库过程中停止或撤销时，在提交前重新核验；失败沿同一事务回滚。
   if(await authorize(db,origin)!==origin.fingerprint)throw error('teloa/forbidden','采用提交前的本人授权已变化。')
   return result
  })
 }
}
