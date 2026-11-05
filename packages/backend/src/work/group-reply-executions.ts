import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,groupDefinition,isGroupMessage,isMessageReference,normalizeReferences,type DigitalRole,type GroupMessage,type GroupOwnerRequest,type MessageReference,type WorkLineage} from '@teloa/contract'
import {lockRoleWorkRole,assertRoleWorkRole} from './twin-execution-consents.ts'
import {readRoleWorkGroupGrant} from './role-delegations.ts'
import {authorizeRoleTaskAssignment} from './role-task-authorization.ts'
import {readGroupAuthorizedReferences,type RunGroupFilePorts} from './task-run-group-context.ts'
import {readGroupConversationTopic,type RunGroupTopic} from './group-topic.ts'
import {ArtifactAvailabilityService} from './artifact-availability.ts'
import {readGroupOwnerRequest} from './group-owner-request.ts'
import {groupMessageBodySnapshot,groupMessageTextHash} from './group-message-body.ts'

export type GroupReplySnapshot={schema:'teloa.group-reply-input/v1';ownerId:string;groupId:string;groupVersion:number;grantVersion:number;messageId:string;rootId:string;contextMode:'main'|'thread';role:DigitalRole;references:MessageReference[];context:Awaited<ReturnType<typeof readGroupAuthorizedReferences>>;topic:RunGroupTopic|undefined;source:{text:string;createdAt:string;authorId:string};ownerRequest:GroupOwnerRequest;lineage:WorkLineage|null}
export type GroupReplyExecution={id:string;sessionId:string;nativeRequestId:string;state:'prepared'|'submitting'|'accepted'|'active'|'ended'|'unknown'|'withdrawn'|'configuration_failed';snapshot:GroupReplySnapshot;inputSha256:string;nativeInputSha256?:string;nativeMessageId?:string;noVision?:true;evidence?:{turn:number;messageSeq:number;endSeq:number;reason:string};text?:string;resultMessageId?:string;stopRequestId?:string;reason?:string}
export const groupReplySessionId=(id:string):string=>'group-reply-'+id
export const isGroupReplySession=(id:string):boolean=>/^group-reply-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)
/** jsonb 会重排键；输入和摘要采用同一规范序列化，冷读不改变原请求内容。 */
export function groupReplyCanonical(value:unknown):string{
 const sort=(v:unknown):unknown=>Array.isArray(v)?v.map(sort):v!==null&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,sort(x)])):v
 return JSON.stringify(sort(JSON.parse(JSON.stringify(value))))
}
const hash=(v:unknown)=>createHash('sha256').update(groupReplyCanonical(v)).digest('hex')
export const groupReplyContentHash=hash
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const fail=()=>new WorkError('teloa/storage-corrupt','群回复执行来源不完整，不能继续或发布。')

/** 回复执行保存在原 outbox；业务 Task/Run 与个人会话目录都不写入。 */
export class GroupReplyExecutionService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly files:RunGroupFilePorts|undefined;readonly hostGeneration:(()=>number)|undefined
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},files?:RunGroupFilePorts,hostGeneration?:()=>number){this.pool=pool;this.identity=identity;this.files=files;this.hostGeneration=hostGeneration}
 private async transaction<T>(fn:(db:PoolClient)=>Promise<T>):Promise<T>{const db=await this.pool.connect();try{await db.query('begin');const value=await fn(db);await db.query('commit');return value}catch(error){await db.query('rollback');throw error}finally{db.release()}}
 private async row(db:Pick<Pool,'query'>,owner:string,id:string,lock=false){
  if(!owner?.trim()||owner.length>128||!uuid(id))throw new WorkError('teloa/invalid-input','群回复身份不正确。')
  const row=(await db.query(`select * from teloa_group_routing_outbox where owner_id=$1 and id=$2${lock?' for update':''}`,[owner,id])).rows[0]
  if(!row||row.execution_mode!=='reply'||row.task_id!==null||row.run_id!==null)throw new WorkError('teloa/forbidden','这条回复不是当前本人的普通群交流。')
  return row
 }
 private read(row:Record<string,unknown>):GroupReplyExecution|null{
  if(row.reply_execution==null)return null
  const value=row.reply_execution as GroupReplyExecution,s=value.snapshot
  if(value.id!==row.id||value.sessionId!==groupReplySessionId(String(row.id))||value.nativeRequestId!==row.request_id||!s||s.schema!=='teloa.group-reply-input/v1'||s.ownerId!==row.owner_id||s.groupId!==row.group_id||s.groupVersion!==row.group_version||s.messageId!==row.message_id||s.role?.id!==row.role_id||s.role.version!==row.role_version||value.inputSha256!==hash(s)||!['prepared','submitting','accepted','active','ended','unknown','withdrawn','configuration_failed'].includes(value.state))throw fail()
  if(value.evidence&&(!Number.isSafeInteger(value.evidence.turn)||!Number.isSafeInteger(value.evidence.messageSeq)||!Number.isSafeInteger(value.evidence.endSeq)||value.evidence.endSeq<=value.evidence.messageSeq))throw fail()
  if(value.state==='ended'&&(!value.evidence||typeof value.text!=='string'||!value.text.trim()))throw fail()
  return value
 }
 async get(owner:string,id:string):Promise<GroupReplyExecution|null>{return this.read(await this.row(this.pool,owner,id))}
 async handles(owner:string,id:string):Promise<boolean>{const row=(await this.pool.query('select execution_mode,task_id,run_id from teloa_group_routing_outbox where owner_id=$1 and id=$2',[owner,id])).rows[0];return row?.execution_mode==='reply'&&row.task_id===null&&row.run_id===null}
 async block(owner:string,id:string,reason:string):Promise<void>{await this.transaction(async db=>{const row=await this.row(db,owner,id,true),fixed=this.read(row);if(!fixed||fixed.resultMessageId)return;const next={...fixed,...(fixed.state==='ended'?{}:{state:'withdrawn'}),reason};await db.query("update teloa_group_routing_outbox set reply_execution=$3,state='blocked',reason=$4,next_attempt_at=null where owner_id=$1 and id=$2",[owner,id,JSON.stringify(next),reason])})}
 private async current(db:PoolClient,owner:string,row:Record<string,unknown>,fixed?:GroupReplyExecution){
  const generation=this.hostGeneration?.()
  if(generation!==undefined&&(await db.query('select generation from teloa_work_control_hosts where owner_id=$1 for share',[owner])).rows[0]?.generation!==generation)throw new WorkError('teloa/forbidden','原回复宿主已经退役，不能取得新的执行权。')
  const role=await lockRoleWorkRole(db,owner,String(row.role_id));assertRoleWorkRole(role,Number(row.role_version))
  const group=(await db.query('select * from teloa_groups where owner_id=$1 and id=$2 for share',[owner,row.group_id])).rows[0]
  if(!group||group.archived||group.version!==row.group_version)throw new WorkError('teloa/version-conflict','群设置已变化，原回复不能扩大范围。')
  const scope=groupDefinition(group.definition).scope,grant=await readRoleWorkGroupGrant(db,owner,role,String(row.group_id),scope,true)
  if(!grant.canPost)throw new WorkError('teloa/forbidden','员工没有当前群发言授权。')
  const permission=await authorizeRoleTaskAssignment(db,this.pool,owner,role,scope,String(row.group_id))
  const source=(await db.query('select * from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3 for share',[owner,row.group_id,row.message_id])).rows[0]
  if(!source||typeof source.text!=='string')throw fail()
  const references=normalizeReferences(source.reference_snapshot)
  if(!Array.isArray(references)||!references.every(isMessageReference))throw fail()
  const context=await readGroupAuthorizedReferences(db,owner,String(row.group_id),scope,grant,references.map(r=>[r,'群消息引用'] as const),this.files)
  if(fixed&&(fixed.snapshot.grantVersion!==grant.grantVersion||!isDeepStrictEqual(fixed.snapshot.role,role)||!isDeepStrictEqual(fixed.snapshot.context,context)||!isDeepStrictEqual(fixed.snapshot.references,references)||fixed.snapshot.source.text!==source.text))throw new WorkError('teloa/version-conflict','岗位、群授权或固定资料已变化，原回复保留但不继续执行。')
  const lineage=fixed?.snapshot.lineage??row.lineage as WorkLineage|null
  if(lineage){
   const ids=[lineage.roundControlId,...(lineage.definitionControlId?[lineage.definitionControlId]:[])],controls=(await db.query('select id,state,generation from teloa_work_controls where owner_id=$1 and id=any($2::uuid[]) for share',[owner,ids])).rows
   if(controls.length!==ids.length||controls.some(c=>c.state!=='active'))throw new WorkError('teloa/forbidden','原工作已暂停或停止，不能继续群回复。')
   const generations=controls.map(c=>({id:c.id,generation:c.generation})).sort((a,b)=>String(a.id).localeCompare(String(b.id)))
   if(row.dispatch_control_snapshot!=null&&!isDeepStrictEqual(row.dispatch_control_snapshot,generations))throw new WorkError('teloa/forbidden','原工作执行世代已变化。')
   if(row.dispatch_control_snapshot==null)await db.query('update teloa_group_routing_outbox set dispatch_control_snapshot=$3 where owner_id=$1 and id=$2',[owner,row.id,JSON.stringify(generations)])
  }
  permission.assertCurrent();return {role,group,grant,source,references,context,lineage,assertCurrent:permission.assertCurrent}
 }
 async authorize(owner:string,id:string){return this.transaction(async db=>{const row=await this.row(db,owner,id),fixed=this.read(row);if(!fixed||['withdrawn','configuration_failed'].includes(fixed.state)||row.state==='blocked')throw new WorkError('teloa/forbidden','当前群回复已停止或不可执行。');return (await this.current(db,owner,row,fixed)).assertCurrent})}
 async prepare(owner:string,id:string,displayName=''):Promise<GroupReplyExecution>{return this.transaction(async db=>{
  const row=await this.row(db,owner,id,true),prior=this.read(row)
  if(prior)return prior
  if(row.state!=='leased')throw new WorkError('teloa/version-conflict','原群回复尚未取得投递租约。')
  const c=await this.current(db,owner,row),mode=c.source.root_id===null?'main':'thread',topic=await readGroupConversationTopic(db,owner,{groupId:String(row.group_id),messageId:String(row.message_id),replyToMessageId:c.source.reply_to_message_id as string|null,mode,roleId:c.role.id,displayName})
  const ownerRequest=await readGroupOwnerRequest(db,owner,String(row.group_id),String(row.message_id),this.pool)
  const snapshot:GroupReplySnapshot={schema:'teloa.group-reply-input/v1',ownerId:owner,groupId:String(row.group_id),groupVersion:Number(row.group_version),grantVersion:c.grant.grantVersion,messageId:String(row.message_id),rootId:String(c.source.root_id??c.source.id),contextMode:mode,role:c.role,references:c.references,context:c.context,topic,source:{text:c.source.text as string,createdAt:(c.source.created_at as Date).toISOString(),authorId:String(c.source.author_id)},ownerRequest,lineage:c.lineage}
  const execution:GroupReplyExecution={id,sessionId:groupReplySessionId(id),nativeRequestId:String(row.request_id),state:'prepared',snapshot,inputSha256:hash(snapshot)}
  await new ArtifactAvailabilityService(this.pool,this.identity.now).bindInputInTransaction(db,owner,{sessionId:execution.sessionId,references:c.references.filter(r=>r.kind==='artifact').map(r=>({artifactId:r.id,version:r.version})),groupMessageIds:[...new Set([snapshot.messageId,...(topic?.messages.flatMap(m=>m.messageId?[m.messageId]:[])??[])])]})
  c.assertCurrent();await db.query('update teloa_group_routing_outbox set reply_execution=$3 where owner_id=$1 and id=$2',[owner,id,JSON.stringify(execution)])
  return execution
 })}
 async submitting(owner:string,id:string,leaseGeneration:number,content:{nativeInputSha256:string;noVision?:true}):Promise<boolean>{return this.transaction(async db=>{
  const row=await this.row(db,owner,id,true),fixed=this.read(row)
  if(!fixed||fixed.state!=='prepared')return false
  if(row.lease_generation!==leaseGeneration||row.state!=='leased'||!(row.next_attempt_at instanceof Date)||row.next_attempt_at.toISOString()<=this.identity.now())throw new WorkError('teloa/version-conflict','群回复租约已变化。')
  if(!/^[a-f0-9]{64}$/.test(content.nativeInputSha256)||content.noVision!==undefined&&content.noVision!==true)throw fail()
  await this.current(db,owner,row,fixed)
  await db.query("update teloa_group_routing_outbox set reply_execution=$3,state='unknown' where owner_id=$1 and id=$2",[owner,id,JSON.stringify({...fixed,state:'submitting',...content})]);return true
 })}
 /** 发布前固定真实 UserMessage 身份；第二个同 rpcId 的新消息也不能获得发送许可。 */
 async admitNativeInput(owner:string,id:string,messageId:string,contentSha256:string):Promise<void>{await this.transaction(async db=>{
  const row=await this.row(db,owner,id,true),fixed=this.read(row)
  if(!fixed||fixed.state!=='submitting'||!messageId||messageId.length>128||fixed.nativeInputSha256!==contentSha256||fixed.nativeMessageId!==undefined&&fixed.nativeMessageId!==messageId)throw new WorkError('teloa/forbidden','群回复原生输入与固定预约不一致。')
  await this.current(db,owner,row,fixed)
  if(!fixed.nativeMessageId)await db.query('update teloa_group_routing_outbox set reply_execution=$3 where owner_id=$1 and id=$2',[owner,id,JSON.stringify({...fixed,nativeMessageId:messageId})])
 })}
 /** 未知提交永不退回 prepared；恢复只读原请求，禁止重复 prompt。 */
 async observe(owner:string,id:string,observation:{state:'accepted'|'active'|'unknown'|'configuration_failed';reason?:string}|{state:'ended';evidence:NonNullable<GroupReplyExecution['evidence']>;text:string}):Promise<GroupReplyExecution>{return this.transaction(async db=>{
  const row=await this.row(db,owner,id,true),fixed=this.read(row);if(!fixed)throw fail()
  if(fixed.state==='withdrawn'||fixed.state==='ended')return fixed
  if(fixed.state==='prepared'&&observation.state!=='configuration_failed')throw fail()
  if(observation.state==='ended'&&(!fixed.nativeMessageId||!fixed.nativeInputSha256||observation.evidence.reason!=='completed'||!observation.text.trim()))throw fail()
  const next={...fixed,...observation};await db.query("update teloa_group_routing_outbox set reply_execution=$3,state=case when $4='configuration_failed' then 'blocked' else 'unknown' end,next_attempt_at=$5::timestamptz+interval '2 seconds' where owner_id=$1 and id=$2",[owner,id,JSON.stringify(next),next.state,this.identity.now()]);return next
 })}
 async stop(owner:string,input:{requestId:string;groupId:string;replyExecutionId:string}):Promise<GroupReplyExecution>{return this.transaction(async db=>{
  if(!uuid(input.requestId)||!uuid(input.groupId)||!uuid(input.replyExecutionId))throw new WorkError('teloa/invalid-input','停止群回复需要有效身份。')
  const row=await this.row(db,owner,input.replyExecutionId,true),fixed=this.read(row);if(!fixed||row.group_id!==input.groupId)throw fail()
  if(fixed.stopRequestId&&fixed.stopRequestId!==input.requestId) return fixed
  if(fixed.resultMessageId)return fixed
  const next={...fixed,state:'withdrawn' as const,stopRequestId:input.requestId};await db.query("update teloa_group_routing_outbox set reply_execution=$3,state='settled',next_attempt_at=null where owner_id=$1 and id=$2",[owner,fixed.id,JSON.stringify(next)]);return next
 })}
 async publish(owner:string,id:string):Promise<GroupMessage>{return this.transaction(async db=>{
  const row=await this.row(db,owner,id,true),fixed=this.read(row);if(!fixed||fixed.state!=='ended'||fixed.evidence?.reason!=='completed'||!fixed.text)throw fail()
  const prior=(await db.query('select * from teloa_group_messages where owner_id=$1 and request_id=$2',[owner,fixed.nativeRequestId])).rows[0]
  const s=fixed.snapshot,text=fixed.text,body=groupMessageBodySnapshot(text),spec={kind:'teloa.group-reply-message/v1',replyExecutionId:id,text:{chars:text.length,sha256:groupMessageTextHash(text)}}
  if(prior){if(prior.reply_execution_id!==id||!isDeepStrictEqual(prior.request_spec,spec))throw fail();return this.message(prior,fixed)}
  await this.current(db,owner,row,fixed)
  const saved=(await db.query(`insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,reply_execution_id,text,reference_snapshot,created_at,full_text,full_text_meta)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,[this.identity.id(),owner,s.groupId,fixed.nativeRequestId,JSON.stringify(spec),s.rootId,s.role.id,id,body.preview,JSON.stringify(s.references),this.identity.now(),body.body,body.summary?JSON.stringify(body.summary):null])).rows[0]
  const next={...fixed,resultMessageId:String(saved.id)}
  await db.query("update teloa_group_routing_outbox set reply_execution=$3,state='settled',next_attempt_at=null where owner_id=$1 and id=$2",[owner,id,JSON.stringify(next)])
  await db.query("insert into teloa_group_routing_wakes(owner_id,message_id,group_id,state,created_at) values($1,$2,$3,'pending',$4) on conflict(owner_id,message_id) do nothing",[owner,saved.id,s.groupId,this.identity.now()])
  return this.message(saved,next)
 })}
 private message(row:Record<string,unknown>,fixed:GroupReplyExecution):GroupMessage{
  const s=fixed.snapshot,value={id:row.id,groupId:row.group_id,rootId:row.root_id,authorId:row.author_id,replyExecutionId:fixed.id,text:row.text,references:row.reference_snapshot,createdAt:(row.created_at as Date).toISOString(),contextMode:s.contextMode,replyToMessageId:s.messageId,author:{name:s.role.name,kind:s.role.kind,version:s.role.version},...(row.full_text_meta?{fullText:row.full_text_meta}:{})}
  if(!isGroupMessage(value))throw fail();return value
 }
}

/** 固定作者及原生完成证明；历史阅读不重新授予执行权限。 */
export async function readTrustedGroupReplySource(db:Pick<Pool,'query'>,owner:string,input:{groupId:string;messageId:string}):Promise<GroupReplyExecution|null>{
 const row=(await db.query('select m.*,o.reply_execution from teloa_group_messages m join teloa_group_routing_outbox o on o.owner_id=m.owner_id and o.id=m.reply_execution_id where m.owner_id=$1 and m.group_id=$2 and m.id=$3',[owner,input.groupId,input.messageId])).rows[0]
 if(!row)return null
 const fixed=row.reply_execution as GroupReplyExecution,s=fixed?.snapshot
 if(!fixed||fixed.id!==row.reply_execution_id||fixed.sessionId!==groupReplySessionId(fixed.id)||fixed.nativeRequestId!==row.request_id||!fixed.nativeMessageId||!fixed.nativeInputSha256||fixed.state!=='ended'||fixed.resultMessageId!==row.id||fixed.evidence?.reason!=='completed'||s?.ownerId!==owner||s.groupId!==input.groupId||s.role.id!==row.author_id||fixed.inputSha256!==hash(s)||row.task_id!==null||row.run_id!==null||fixed.text!==(row.full_text??row.text))throw fail()
 return fixed
}
