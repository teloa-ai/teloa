import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,groupAttachmentImageMediaTypes,groupAttachmentListInput,groupAttachmentReadInput,groupAttachmentTotalBytes,groupAttachmentUploadInput,groupAttachmentWithdrawInput,isGroupAttachment,isGroupAttachmentBytes,type GroupAttachment,type GroupAttachmentBytes,type GroupAttachmentKind} from '@teloa/contract'

/** `groups/attachments/list` 的回包上限（本人级原件仓，只按上传所在群归类）。 */
export const groupAttachmentListLimit=200

/**
 * 字节的唯一出入口。服务层只经这三个方法碰原件字节，不直接 import 宿主的 `ctx.attachments`；
 * 真端口由 `packages/harness-dsh/src/attachments.ts` 的 `AttachmentPorts` 适配，单测里注入内存桩。
 */
export type GroupAttachmentBytePorts={
 saveImage:(dataBase64:string,mime:string,name:string)=>Promise<{attachmentId:string;bytes:number;width:number;height:number;mediaType:string}>
 saveFile:(dataBase64:string,name:string)=>Promise<{attachmentId:string;bytes:number;name:string}>
 readBytes:(row:{attachmentId:string;kind:GroupAttachmentKind;mime:string;bytes:number;name:string;width:number|null;height:number|null})=>Promise<Uint8Array>
}

function ownerId(value:string):void{
 if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')
}

const corrupt=()=>new WorkError('teloa/storage-corrupt','附件记录损坏，已停止读取。')
/** 不存在、不属本人、已撤回三种情形回同一句话：分辨它们等于开一个存在性探测口（规格 §4.5）。 */
const invisible=()=>new WorkError('teloa/forbidden','附件不存在、已撤回或不属于当前本人。')

function stamp(value:unknown):string{
 if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt()
 return value.toISOString()
}

export function readGroupAttachment(row:Record<string,unknown>):GroupAttachment{
 try{
  const value={
   attachmentId:row.attachment_id,ownerId:row.owner_id,version:row.version,kind:row.kind,mime:row.mime,
   // bytes 是 bigint 列，pg 按字符串回；判定器要的是安全整数。
   bytes:typeof row.bytes==='string'?Number(row.bytes):row.bytes,
   sha256:row.sha256,name:row.name,
   width:row.width===undefined?null:row.width,height:row.height===undefined?null:row.height,
   uploadedInGroupId:row.uploaded_in_group_id===undefined?null:row.uploaded_in_group_id,
   state:row.state,createdAt:stamp(row.created_at),
   withdrawnAt:row.withdrawn_at===null||row.withdrawn_at===undefined?null:stamp(row.withdrawn_at)
  }
  if(!isGroupAttachment(value))throw Error('invalid attachment')
  return value
 }catch(error){
  // 只有「行读不出」才是损坏；上游已经判过的 WorkError（如时间戳损坏）原样上抛，不被这层吞成另一条。
  if(error instanceof WorkError)throw error
  throw corrupt()
 }
}

export async function initializeGroupAttachments(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_attachments (
  attachment_id text not null check(length(attachment_id) between 1 and 512),
  owner_id text not null,
  version integer not null check(version=1),
  -- 首次上传这份字节的请求，只作溯源；幂等回执在 teloa_attachment_requests，不由这两列承担
  request_id uuid not null,
  request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  kind text not null check(kind in ('image','file')),
  mime text not null,
  bytes bigint not null check(bytes>=0),
  sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
  name text not null check(length(name) between 1 and 120),
  width integer, height integer,
  -- 只用于侧栏归类与「在哪个群上传的」这句展示，不是授权判据
  uploaded_in_group_id uuid,
  state text not null check(state in ('active','withdrawn')),
  created_at timestamptz not null,
  withdrawn_at timestamptz,
  primary key(owner_id,attachment_id),
  unique(owner_id,request_id),
  -- 复合外键 set null 会把 owner_id 一并置空，而 owner_id 是 not null：前提是群只归档不删
  -- （全仓没有 delete from teloa_groups）。哪天真要删群，这里得改成 PG15 的列清单形式
  -- on delete set null (uploaded_in_group_id)。
  foreign key(uploaded_in_group_id,owner_id) references teloa_groups(id,owner_id) on delete set null,
  check((kind='image')=(width is not null and height is not null)),
  check((state='withdrawn')=(withdrawn_at is not null))
 );
 create index if not exists teloa_attachments_group on teloa_attachments(owner_id,uploaded_in_group_id,created_at desc);
 -- 上传幂等的唯一真源：新插入、去重命中、复活三条路径都先查这张表再往里落一行。
 create table if not exists teloa_attachment_requests(
  owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  attachment_id text not null,result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null,
  primary key(owner_id,request_id),foreign key(owner_id,attachment_id) references teloa_attachments(owner_id,attachment_id)
 );
 create or replace function teloa_reject_attachment_request_mutation() returns trigger language plpgsql as $$ begin raise exception 'attachment upload receipts are immutable'; end $$;
 drop trigger if exists teloa_attachment_requests_immutable on teloa_attachment_requests;
 create trigger teloa_attachment_requests_immutable before update or delete on teloa_attachment_requests for each row execute function teloa_reject_attachment_request_mutation();
`)}

/** 供 T6 的 `assertReferences` / `assertResources` 的 attachment 分支调用：属本人且在用才回行。 */
export async function readActiveAttachment(client:PoolClient,owner:string,attachmentId:string):Promise<GroupAttachment|undefined>{
 const found=await client.query("select * from teloa_attachments where owner_id=$1 and attachment_id=$2 and state='active' for share",[owner,attachmentId])
 return found.rows[0]?readGroupAttachment(found.rows[0]):undefined
}

export class GroupAttachmentService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 readonly ports:GroupAttachmentBytePorts

 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},ports:GroupAttachmentBytePorts){this.pool=pool;this.identity=identity;this.ports=ports}

 async upload(owner:string,input:unknown):Promise<GroupAttachment>{
  ownerId(owner)
  const request=groupAttachmentUploadInput(input)
  const uploaded=Buffer.from(request.dataBase64,'base64')
  /*
   * 摘要一律对上传的原字节自己重算，不取 attachmentId：文件的 attachmentId 恰好是原字节摘要，
   * 但图片的 attachmentId 覆盖的是宿主归一化之后的字节，拿 id 当 sha256 会在图片上给出错误承诺。
   */
  const sha256=createHash('sha256').update(uploaded).digest('hex')
  const kind:GroupAttachmentKind=(groupAttachmentImageMediaTypes as readonly string[]).includes(request.mime)?'image':'file'
  const spec=JSON.stringify({groupId:request.groupId,mime:request.mime,name:request.name,sha256})
  const client=await this.pool.connect()
  try{
   await client.query('begin')
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/attachment-upload',owner,request.requestId])])
   // 幂等只看回执表：新插入、去重命中、复活三条路径落的都是同一张表，去重与复活因此也能重放。
   const prior=await client.query('select *,request_spec=$3::jsonb as same_request from teloa_attachment_requests where owner_id=$1 and request_id=$2',[owner,request.requestId,spec])
   if(prior.rows[0]){
    if(!prior.rows[0].same_request)throw new WorkError('teloa/conflict','同一附件上传请求不能更换内容。')
    const result=prior.rows[0].result
    if(!isGroupAttachment(result)||result.ownerId!==owner)throw new WorkError('teloa/storage-corrupt','附件上传回执损坏，已停止重试。')
    await client.query('commit')
    return result
   }
   await this.assertGroupWritable(client,owner,request.groupId,request.expectedVersion)
   /*
    * 写序：先落字节、再落元数据行。字节落了而行失败可接受——原件仓内容寻址且永不删除，
    * 重放同一份字节拿到的仍是同一个 attachmentId。
    */
   let attachmentId:string,bytes:number,mime:string,name:string,width:number|null,height:number|null
   if(kind==='image'){
    const receipt=await this.ports.saveImage(request.dataBase64,request.mime,request.name)
    // mime 取回执：宿主会把 PNG/JPEG 归一化重编码，客户端声明的 MIME 到这里已经不算数。
    attachmentId=receipt.attachmentId;bytes=receipt.bytes;mime=receipt.mediaType;name=request.name;width=receipt.width;height=receipt.height
   }else{
    const receipt=await this.ports.saveFile(request.dataBase64,request.name)
    // 文件的 name 必须取回执：宿主清洗过的叶名进落盘路径，读回时要与落盘时逐字一致。
    attachmentId=receipt.attachmentId;bytes=receipt.bytes;mime=request.mime;name=receipt.name;width=null;height=null
   }
   // 额度与去重判据只在同一本人内互相影响，用 owner 级锁把同一本人的上传串成一条线，
   // 总量查询因此不必再锁行（锁行既拦不住并发插入，又会把只读的求和变成写冲突源）。
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/attachment-quota',owner])])
   const existing=await client.query('select * from teloa_attachments where owner_id=$1 and attachment_id=$2 for update',[owner,attachmentId])
   const now=this.identity.now()
   let row=existing.rows[0]
   // 去重命中在用行时整段跳过：这一次一个字节都没新增，不过总量闸，uploaded_in_group_id 也保留首次的值不覆盖。
   if(row?.state!=='active'){
    // 总量只算在用的行：撤回不回收磁盘，但回收额度。复活与新插入都会让在用总量长 bytes，都要过闸。
    const total=await client.query("select coalesce(sum(bytes),0) as total from teloa_attachments where owner_id=$1 and state='active'",[owner])
    if(Number(total.rows[0].total)+bytes>groupAttachmentTotalBytes)throw new WorkError('teloa/conflict','附件总量已达上限，请先撤回不再需要的附件。')
    /*
     * 已撤回的复活（编排者对计划第 9 条的追加口径）：state 置回 active、清 withdrawn_at，
     * created_at 与 uploaded_in_group_id 按这次上传刷新，version 仍恒 1——字节自始至终没删过。
     * name 与 mime 有意不刷新：它们是这份字节首次落盘时宿主给的事实，重传同样的字节不会产生新事实。
     */
    row=row
     ?(await client.query("update teloa_attachments set state='active',withdrawn_at=null,created_at=$3,uploaded_in_group_id=$4 where owner_id=$1 and attachment_id=$2 and state='withdrawn' returning *",[owner,attachmentId,now,request.groupId])).rows[0]
     :(await client.query("insert into teloa_attachments(attachment_id,owner_id,version,request_id,request_spec,kind,mime,bytes,sha256,name,width,height,uploaded_in_group_id,state,created_at,withdrawn_at) values($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13,null) on conflict(owner_id,attachment_id) do nothing returning *",[attachmentId,owner,request.requestId,spec,kind,mime,bytes,sha256,name,width,height,request.groupId,now])).rows[0]
    // owner 锁之下这一步不该落空；真落空说明有人绕过锁在并发写同一行，回可重试的 conflict，别谎称损坏。
    if(!row)throw new WorkError('teloa/conflict','同一份附件正在上传，请稍后重试。')
   }
   const attachment=readGroupAttachment(row)
   await client.query('insert into teloa_attachment_requests(owner_id,request_id,request_spec,attachment_id,result,created_at) values($1,$2,$3,$4,$5,$6)',[owner,request.requestId,spec,attachment.attachmentId,JSON.stringify(attachment),now])
   await client.query('commit')
   return attachment
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }

 async list(owner:string,input:unknown):Promise<GroupAttachment[]>{
  ownerId(owner)
  const request=groupAttachmentListInput(input),client=await this.pool.connect()
  try{
   await client.query('begin')
   const found=await client.query('select id from teloa_groups where id=$1 and owner_id=$2 for share',[request.groupId,owner])
   if(!found.rows[0])throw new WorkError('teloa/forbidden','群不存在或不属于当前本人。')
   const rows=await client.query("select * from teloa_attachments where owner_id=$1 and uploaded_in_group_id=$2 and state='active' order by created_at desc,attachment_id limit $3",[owner,request.groupId,groupAttachmentListLimit])
   await client.query('commit')
   return rows.rows.map(readGroupAttachment)
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }

 async read(owner:string,input:unknown):Promise<GroupAttachmentBytes>{
  ownerId(owner)
  const request=groupAttachmentReadInput(input),client=await this.pool.connect()
  let attachment:GroupAttachment
  try{
   await client.query('begin')
   const found=await client.query("select * from teloa_attachments where owner_id=$1 and attachment_id=$2 and state='active' for share",[owner,request.attachmentId])
   if(!found.rows[0])throw invisible()
   attachment=readGroupAttachment(found.rows[0])
   await client.query('commit')
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
  const bytes=await this.ports.readBytes({attachmentId:attachment.attachmentId,kind:attachment.kind,mime:attachment.mime,bytes:attachment.bytes,name:attachment.name,width:attachment.width,height:attachment.height})
  const mismatch=()=>new WorkError('teloa/storage-corrupt','附件字节与记录不一致，已停止读取。')
  if(bytes.length!==attachment.bytes)throw mismatch()
  const digest=createHash('sha256').update(bytes).digest('hex')
  /*
   * 判据是「读回字节的摘要 ≠ 落盘时记录的归一化字节摘要」：文件类落盘即上传原字节，行里的 sha256 就是那个摘要；
   * 图片类落盘的是归一化之后的字节，表里没有另存它的摘要，改取内容寻址的 attachmentId（它恰好覆盖落盘字节，见 :109-113）。
   * 附件仓若给出非内容寻址的 id，图片就只剩长度可比——那是改动前就有的口径，不在这里悄悄收紧。
   */
  const stored=attachment.kind==='file'?attachment.sha256:/^sha256:[a-f0-9]{64}$/.test(attachment.attachmentId)?attachment.attachmentId.slice('sha256:'.length):undefined
  if(stored!==undefined&&digest!==stored)throw mismatch()
  // 回包的 sha256 是本次实际回传字节的摘要（与元数据行的上传原字节摘要在图片上必然不等），客户端因此能按回包自校验。
  const value={attachmentId:attachment.attachmentId,version:1 as const,mime:attachment.mime,bytes:attachment.bytes,sha256:digest,name:attachment.name,dataBase64:Buffer.from(bytes).toString('base64')}
  if(!isGroupAttachmentBytes(value))throw mismatch()
  return value
 }

 async withdraw(owner:string,input:unknown):Promise<GroupAttachment>{
  ownerId(owner)
  const request=groupAttachmentWithdrawInput(input),client=await this.pool.connect()
  try{
   await client.query('begin')
   // requestId 在撤回这条路上只作串行化：撤回本身幂等（只置状态），没有需要重放的回执。
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/attachment-withdraw',owner,request.requestId])])
   const found=await client.query('select * from teloa_attachments where owner_id=$1 and attachment_id=$2 for update',[owner,request.attachmentId])
   if(!found.rows[0])throw invisible()
   // 撤回只置状态：行不删、字节不删（用户裁定 Q3）；已撤回再撤回回当前行，不报错。
   const updated=found.rows[0].state==='active'
    ?(await client.query("update teloa_attachments set state='withdrawn',withdrawn_at=$3 where owner_id=$1 and attachment_id=$2 and state='active' returning *",[owner,request.attachmentId,this.identity.now()])).rows[0]
    :found.rows[0]
   const attachment=readGroupAttachment(updated)
   await client.query('commit')
   return attachment
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }

 /** 上传只要群可写：非本人群 forbidden、版本不符 version-conflict、已归档 conflict（照 `collaboration.ts` 的 `send`）。 */
 private async assertGroupWritable(client:PoolClient,owner:string,groupId:string,expectedVersion:number):Promise<void>{
  const found=await client.query('select version,archived from teloa_groups where id=$1 and owner_id=$2 for share',[groupId,owner])
  if(!found.rows[0])throw new WorkError('teloa/forbidden','群不存在或不属于当前本人。')
  if(found.rows[0].version!==expectedVersion)throw new WorkError('teloa/version-conflict','群设置已变化，请刷新后再上传。')
  if(found.rows[0].archived)throw new WorkError('teloa/conflict','已归档群不能上传附件。')
 }
}
