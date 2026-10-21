import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,groupDefinition,readTwinDraft,readTwinDraftAdoption,readTwinDraftCreate,readTwinDraftCommand,readTwinDraftSourceInput,twinDraftRecord,twinDraftUuid,type TwinDraft,type TwinDraftSource,type TwinDraftSourceInput,type TwinDraftCreate,type TwinDraftRevise,type TwinDraftReturn,type TwinDraftBasis,type TwinDraftAdoption,type DigitalRole} from '@teloa/contract'
import type {CollaborationService} from './collaboration.ts'
import {readStoredRole} from './roles.ts'
import {readGroupMessageBody} from './group-message-body.ts'
import {RoleMemoryService} from './role-memory.ts'
import {workAccess} from './work-access.ts'

type Identity={id:()=>string;now:()=>string}
export type TwinDraftPorts={groups:Pick<CollaborationService,'sendInTransaction'>;admitText?:(text:string)=>void;conversation?:(owner:string,input:Extract<TwinDraftSourceInput,{kind:'conversation'}>,db:PoolClient)=>Promise<{label:string;text:string}>}
const hash=(body:string)=>createHash('sha256').update(body).digest('hex')
const fail=(code:'teloa/forbidden'|'teloa/version-conflict'|'teloa/conflict'|'teloa/source-unavailable',message:string):never=>{throw new WorkError(code,message)}
export async function initializeTwinDrafts(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_twin_drafts(
  owner_id text not null,id uuid not null,role_id uuid not null,revision integer not null check(revision>0),snapshot jsonb not null,
  primary key(owner_id,id),foreign key(role_id) references teloa_roles(id));
 create table if not exists teloa_twin_draft_revisions(
  owner_id text not null,draft_id uuid not null,revision integer not null,snapshot jsonb not null,primary key(owner_id,draft_id,revision),
  foreign key(owner_id,draft_id) references teloa_twin_drafts(owner_id,id));
 create table if not exists teloa_twin_draft_requests(
  owner_id text not null,request_id uuid not null,operation text not null,spec jsonb not null,result jsonb not null,
  primary key(owner_id,request_id));
 create or replace function teloa_twin_draft_append_only() returns trigger language plpgsql as $$ begin raise exception '代拟稿修订与请求回执不可修改或删除'; end $$;
 create or replace trigger teloa_twin_draft_revisions_immutable before update or delete on teloa_twin_draft_revisions for each row execute function teloa_twin_draft_append_only();
 create or replace trigger teloa_twin_draft_requests_immutable before update or delete on teloa_twin_draft_requests for each row execute function teloa_twin_draft_append_only();`)
}
export class TwinDraftService{
 readonly pool:Pool
 readonly identity:Identity
 readonly ports:TwinDraftPorts
 constructor(pool:Pool,identity:Identity,ports:TwinDraftPorts){this.pool=pool;this.identity=identity;this.ports=ports}
 private owner(owner:string){if(typeof owner!=='string'||!owner.trim()||owner.length>128)fail('teloa/forbidden','需要可信本人身份。')}
 private async transaction<T>(run:(db:PoolClient)=>Promise<T>):Promise<T>{const db=await this.pool.connect();try{await db.query('begin');const result=await run(db);await db.query('commit');return result}catch(error){await db.query('rollback');throw error}finally{db.release()}}
 private stored(value:unknown,owner?:string,roleId?:string,id?:string):TwinDraft{try{const d=readTwinDraft(value);if(d.bodyHash!==hash(d.body)||d.source.bodyHash!==hash(d.source.text)||owner!==undefined&&d.ownerId!==owner||roleId!==undefined&&d.roleId!==roleId||id!==undefined&&d.id!==id)throw Error();return d}catch{throw new WorkError('teloa/storage-corrupt','代拟稿与固定身份或正文摘要不一致。')}}
 private async role(db:PoolClient,owner:string,id:string,version?:number):Promise<DigitalRole>{
  const row=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2 for share',[owner,id])).rows[0]
  if(!row)fail('teloa/forbidden','分身不属于当前本人。')
  const role=readStoredRole(row)
  if(role.kind!=='twin')fail('teloa/forbidden','只有本人的分身可以保存代拟稿。')
  if(version!==undefined&&(role.version!==version||role.state==='retired'))fail('teloa/version-conflict','分身身份或职责已变化，请复核保留的草稿。')
  return role
 }
 private async source(db:PoolClient,owner:string,input:TwinDraftSourceInput):Promise<TwinDraftSource>{
  const ref=readTwinDraftSourceInput(input)
  if(ref.kind==='provided')return {...ref,bodyHash:hash(ref.text)}
  if(ref.kind==='conversation'){
   if(!this.ports.conversation)fail('teloa/source-unavailable','原会话核验服务尚未接入。')
   const current=await this.ports.conversation!(owner,ref,db)
   return {...ref,...current,bodyHash:hash(current.text)}
  }
  const group=(await db.query('select * from teloa_groups where owner_id=$1 and id=$2 for share',[owner,ref.groupId])).rows[0]
  const message=(await db.query('select * from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3 for share',[owner,ref.groupId,ref.messageId])).rows[0]
  if(!group||!message)fail('teloa/forbidden','原消息不属于当前本人群。')
  const text=message.full_text_meta?readGroupMessageBody(message).text:String(message.text)
  return {...ref,label:groupDefinition(group.definition).name,text,bodyHash:hash(text),groupVersion:group.version,rootId:message.root_id??null}
 }
 private sourceInput(source:TwinDraftSource):TwinDraftSourceInput{
  return source.kind==='group'?{kind:'group',groupId:source.groupId,messageId:source.messageId}:source.kind==='conversation'?{kind:'conversation',sessionId:source.sessionId,messageId:source.messageId,messageSeq:source.messageSeq}:{kind:'provided',label:source.label,text:source.text}
 }
 private async basis(db:PoolClient,owner:string,role:DigitalRole,entries:TwinDraftCreate['basis']):Promise<TwinDraftBasis[]>{
  if(!entries.length)return []
  await db.query('select id from teloa_role_memories where owner_id=$1 and role_id=$2 and id=any($3::uuid[]) order by id for share',[owner,role.id,entries.map(e=>e.id)])
  const known=await new RoleMemoryService(this.pool,this.identity).confirmedForRun(db,owner,{scope:role.scopes[0]!,groupId:null,memoryViewId:null},role,Number.MAX_SAFE_INTEGER)
  return entries.map(entry=>{const current=known.find(m=>m.id===entry.id);if(!current)throw new WorkError('teloa/version-conflict','判断力样本已撤回或来源不可用，请复核依据。');if(current.version!==entry.version||current.contentHash!==entry.contentHash)fail('teloa/version-conflict','判断力样本版本已变化，请复核依据。');return {...entry,title:current.title}})
 }
 private async prior(db:PoolClient,owner:string,requestId:string,operation:string,spec:unknown){
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/twin-draft',owner,requestId])])
  const row=(await db.query('select * from teloa_twin_draft_requests where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0]
  if(!row)return undefined
  if(row.operation!==operation||!isDeepStrictEqual(row.spec,spec))fail('teloa/conflict','同一代拟稿请求不能更换正文、版本或操作。')
  return row.result
 }
 private async record(db:PoolClient,owner:string,requestId:string,operation:string,spec:unknown,result:unknown){await db.query('insert into teloa_twin_draft_requests values($1,$2,$3,$4,$5)',[owner,requestId,operation,JSON.stringify(spec),JSON.stringify(result)])}
 private async save(db:PoolClient,draft:TwinDraft){
  this.stored(draft)
  await db.query('insert into teloa_twin_drafts values($1,$2,$3,$4,$5) on conflict(owner_id,id) do update set revision=excluded.revision,snapshot=excluded.snapshot',[draft.ownerId,draft.id,draft.roleId,draft.revision,JSON.stringify(draft)])
  await db.query('insert into teloa_twin_draft_revisions values($1,$2,$3,$4)',[draft.ownerId,draft.id,draft.revision,JSON.stringify(draft)])
 }
 async list(owner:string,input:unknown){
  this.owner(owner);const r=twinDraftRecord(input,['roleId']);if(!twinDraftUuid(r.roleId))throw new WorkError('teloa/invalid-input','分身身份不正确。')
  return this.transaction(async db=>{const role=await this.role(db,owner,r.roleId as string);return {ownerId:owner,roleId:role.id,roleVersion:role.version,drafts:(await db.query("select id,snapshot from teloa_twin_drafts where owner_id=$1 and role_id=$2 order by snapshot->>'updatedAt' desc,id",[owner,role.id])).rows.map(r=>this.stored(r.snapshot,owner,role.id,r.id))}})
 }
 async get(owner:string,input:unknown):Promise<TwinDraft>{
  this.owner(owner);const r=twinDraftRecord(input,['draftId']);if(!twinDraftUuid(r.draftId))throw new WorkError('teloa/invalid-input','代拟稿身份不正确。')
  const row=(await this.pool.query('select role_id,snapshot from teloa_twin_drafts where owner_id=$1 and id=$2',[owner,r.draftId])).rows[0];if(!row)fail('teloa/forbidden','代拟稿不属于当前本人。');return this.stored(row.snapshot,owner,row.role_id,r.draftId as string)
 }
 async create(owner:string,input:unknown):Promise<TwinDraft>{
  this.owner(owner);const command=readTwinDraftCreate(input)
  return this.transaction(async db=>{
   const prior=await this.prior(db,owner,command.requestId,'create',command);if(prior)return this.stored(prior,owner,command.roleId)
   const role=await this.role(db,owner,command.roleId,command.expectedRoleVersion)
   const admission=await workAccess.authorize({kind:'capability',capability:'people',ownerId:owner,sessionId:null,objectId:role.id,operation:'edit'})
   const source=await this.source(db,owner,command.source),basis=await this.basis(db,owner,role,command.basis),now=this.identity.now()
   const draft:TwinDraft={schema:'teloa.twin-draft/v1',id:this.identity.id(),ownerId:owner,roleId:role.id,roleVersion:role.version,revision:1,state:'draft',title:command.title,body:command.body,bodyHash:hash(command.body),source,basis,createdAt:now,updatedAt:now}
   admission.assertCurrent();await this.save(db,draft);await this.record(db,owner,command.requestId,'create',command,draft);admission.assertCurrent();return draft
  })
 }
 private async change(owner:string,input:unknown,operation:'revise'|'return'|'adopt'):Promise<TwinDraft|TwinDraftAdoption>{
  this.owner(owner);const command=readTwinDraftCommand(input,operation==='revise'?'body':operation==='return'?'reason':null)
  return this.transaction(async db=>{
   const prior=await this.prior(db,owner,command.requestId,operation,command);if(prior){if(operation==='adopt'){const result=readTwinDraftAdoption(prior);this.stored(result.draft,owner,undefined,command.draftId);if(result.receipt.requestId!==command.requestId)throw new WorkError('teloa/storage-corrupt','采用回执身份损坏。');return result}return this.stored(prior,owner,undefined,command.draftId)}
   // 先锁 Role，再锁稿件；群发送沿原服务取群锁，避免另一连接等待本事务。
   const hint=(await db.query('select role_id from teloa_twin_drafts where owner_id=$1 and id=$2',[owner,command.draftId])).rows[0]
   if(!hint)fail('teloa/forbidden','代拟稿不属于当前本人。')
   const role=await this.role(db,owner,hint.role_id,command.expectedRoleVersion)
   const row=(await db.query('select snapshot from teloa_twin_drafts where owner_id=$1 and id=$2 for update',[owner,command.draftId])).rows[0],current=this.stored(row.snapshot,owner,role.id,command.draftId)
   if(current.revision!==command.expectedRevision||current.bodyHash!==command.expectedBodyHash||current.roleVersion!==role.version||['sent','prepared'].includes(current.state))fail('teloa/version-conflict','代拟稿或分身版本已变化，请核对当前稿；原输入已保留。')
   const admission=await workAccess.authorize({kind:'capability',capability:'people',ownerId:owner,sessionId:null,objectId:role.id,operation:'edit'}),now=this.identity.now()
   let next:TwinDraft={...current,revision:current.revision+1,updatedAt:now},result:TwinDraft|TwinDraftAdoption
   if(operation==='return'){next={...next,state:'returned',returnReason:(command as TwinDraftReturn).reason};result=next}
   else{
    const source=await this.source(db,owner,this.sourceInput(current.source))
    if(source.bodyHash!==current.source.bodyHash)fail('teloa/version-conflict','原文已变化，不能自动采用新来源。')
    const basis=await this.basis(db,owner,role,current.basis)
    if(operation==='revise'){const body=(command as TwinDraftRevise).body;const {returnReason:_,...kept}=next;next={...kept,state:'draft',body,bodyHash:hash(body),source,basis};result=next}
    else{
     if(current.state!=='draft')fail('teloa/conflict','退回稿请先修改并保存后再采用。')
     if(source.kind==='provided')fail('teloa/source-unavailable','本人提供的文字没有可信发送渠道，请复制后自行发送。')
     if(source.kind==='group'){
      if(source.groupVersion!==current.source.groupVersion)fail('teloa/version-conflict','群设置已变化，请修改并保存以复核目标版本。')
      if(!this.ports.admitText)fail('teloa/source-unavailable','群消息内容核验尚未接入，未发送。')
      this.ports.admitText!(current.body)
      const message=await this.ports.groups.sendInTransaction(db,owner,{requestId:command.requestId,groupId:source.groupId,expectedVersion:source.groupVersion,text:current.body,...(source.rootId?{rootId:source.rootId}:{}),replyToMessageId:source.messageId})
      if(message.authorId!=='self'||message.groupId!==source.groupId||message.text!==current.body||message.rootId!==(source.rootId??null)||message.replyToMessageId!==source.messageId)throw new WorkError('teloa/invalid-host-response','群消息回执与原稿目标或本人正文不一致，采用已回滚。')
      next={...next,state:'sent'}
      result={draft:next,receipt:{requestId:command.requestId,draftId:next.id,revision:next.revision,bodyHash:next.bodyHash,decidedAt:now,result:{kind:'group-message',groupId:source.groupId,messageId:message.id,authorId:'self'}}}
     }else if(source.kind==='conversation'){next={...next,state:'prepared'};result={draft:next,receipt:{requestId:command.requestId,draftId:next.id,revision:next.revision,bodyHash:next.bodyHash,decidedAt:now,result:{kind:'conversation-draft',sessionId:source.sessionId}}}}
     else throw new WorkError('teloa/source-unavailable','来源没有可信发送渠道。')
    }
   }
   admission.assertCurrent();await this.save(db,next);await this.record(db,owner,command.requestId,operation,command,result);admission.assertCurrent();return result
  })
 }
 revise(owner:string,input:unknown){return this.change(owner,input,'revise') as Promise<TwinDraft>}
 return(owner:string,input:unknown){return this.change(owner,input,'return') as Promise<TwinDraft>}
 adopt(owner:string,input:unknown){return this.change(owner,input,'adopt') as Promise<TwinDraftAdoption>}
 async receipt(owner:string,input:unknown):Promise<TwinDraftAdoption|null>{
  this.owner(owner);const r=twinDraftRecord(input,['requestId']);if(!twinDraftUuid(r.requestId))throw new WorkError('teloa/invalid-input','采用请求身份不正确。')
  const row=(await this.pool.query("select result from teloa_twin_draft_requests where owner_id=$1 and request_id=$2 and operation='adopt'",[owner,r.requestId])).rows[0]
  if(!row)return null
  const result=readTwinDraftAdoption(row.result);this.stored(result.draft,owner);if(result.receipt.requestId!==r.requestId)throw new WorkError('teloa/storage-corrupt','采用回执身份损坏。');return result
 }
}
