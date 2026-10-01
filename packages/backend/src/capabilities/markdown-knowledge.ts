import {createHash} from 'node:crypto'
import {constants} from 'node:fs'
import {link,lstat,mkdir,open,realpath,unlink,type FileHandle} from 'node:fs/promises'
import {dirname,join} from 'node:path'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isKnowledgeItem,isKnowledgeVersion,isKnowledgeVersionSummary,isPasteKnowledge,isRecord,knowledgeCategories,resourceId,resourceScopes,resourceVersion,type KnowledgeCategory,type KnowledgeItem,type KnowledgeVersion,type KnowledgeVersionSummary,type PasteKnowledge} from '@teloa/contract'
import {authorizeResourceActor,type ResourceActor} from './resources.ts'
import {attachKnowledgePage,initializeKnowledgeTree} from './knowledge-tree.ts'

/** 粘贴知识单份上限，与检索单来源上限一致；进岗位/任务全文另受 256 KiB 合计约束（resources.ts）。 */
const maxBytes=2*1024*1024
const bad=()=>new WorkError('teloa/invalid-input','粘贴知识请求格式不正确或包含未知字段。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','知识内容仓记录损坏，已停止读取。')
const unavailable=()=>new WorkError('teloa/storage-unavailable','知识内容仓当前不可用。')
const stable=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw bad();return value as Record<string,unknown>}
const iso=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const topicList=(value:unknown):string[]=>{
 if(!Array.isArray(value)||value.length>20)throw bad()
 const topics=value.map(topic=>typeof topic==='string'?topic.trim():'')
 if(topics.some(topic=>!topic||topic.length>80)||new Set(topics).size!==topics.length)throw bad()
 return topics
}
type PasteRequestSpec={workspaceId:string;title:string;category:KnowledgeCategory;topics:string[];scopeIds:string[];contentHash:string;directory?:{parentId:string|null;position:number|null;expectedDirectoryRevision:number}}
const sameRequest=(value:unknown,expected:PasteRequestSpec)=>{
 try{
  const row=exact(value,expected.directory?['workspaceId','title','category','topics','scopeIds','contentHash','directory']:['workspaceId','title','category','topics','scopeIds','contentHash'])
  if(row.workspaceId!==expected.workspaceId||row.title!==expected.title||row.category!==expected.category||row.contentHash!==expected.contentHash||JSON.stringify(row.topics)!==JSON.stringify(expected.topics)||JSON.stringify(row.scopeIds)!==JSON.stringify(expected.scopeIds))return false
  if(!expected.directory)return true
  const directory=exact(row.directory,['parentId','position','expectedDirectoryRevision'])
  return directory.parentId===expected.directory.parentId&&directory.position===expected.directory.position&&directory.expectedDirectoryRevision===expected.directory.expectedDirectoryRevision
 }catch{throw corrupt()}
}
type RevisionRequestSpec={operation:'revise';knowledgeId:string;expectedVersion:number;contentHash:string}|{operation:'restore';knowledgeId:string;expectedVersion:number;version:number}
const sameRevisionRequest=(value:unknown,expected:RevisionRequestSpec):boolean=>{
 try{
  const keys=expected.operation==='revise'?['operation','knowledgeId','expectedVersion','contentHash']:['operation','knowledgeId','expectedVersion','version']
  const row=exact(value,keys)
  return row.operation===expected.operation&&row.knowledgeId===expected.knowledgeId&&row.expectedVersion===expected.expectedVersion&&(expected.operation==='revise'?row.contentHash===expected.contentHash:row.version===expected.version)
 }catch{throw corrupt()}
}

export function normalizePasteMarkdown(value:unknown):string{
 if(typeof value!=='string')throw bad()
 const markdown=value.replace(/^\ufeff/,'').replace(/\r\n?/g,'\n')
 const bytes=Buffer.from(markdown,'utf8')
 if(!markdown.trim()||bytes.length>maxBytes||bytes.toString('utf8')!==markdown)throw bad()
 return markdown
}

type Stored={item:KnowledgeItem;version:KnowledgeVersion;path:string}
type DirectoryAnchor={path:string;canonical:string;device:number;inode:number;handle:FileHandle}
type Published={target:string;created:boolean;anchors:DirectoryAnchor[]}
function itemRow(row:Record<string,unknown>,requireHead=false):KnowledgeItem{
 const item={id:row.id,ownerId:row.owner_id,sourceId:row.source_id,sourceType:row.source_type,workspaceId:row.workspace_id,title:row.title,category:row.category,topics:row.topics,scopeIds:row.scope_ids,currentVersion:row.current_version,status:row.status,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at)}
 if(!isKnowledgeItem(item)||(requireHead&&(row.head_number!==item.currentVersion||row.head_source_id!==item.sourceId)))throw corrupt();return item
}
function versionRow(row:Record<string,unknown>):KnowledgeVersionSummary{
 const version={knowledgeId:row.id,ownerId:row.owner_id,sourceId:row.version_source_id,sourceType:row.source_type,version:row.number,contentHash:row.content_hash,bytes:row.bytes,createdAt:iso(row.version_created_at)}
 if(!isKnowledgeVersionSummary(version))throw corrupt();return version
}
function stored(row:Record<string,unknown>,markdown:string):Stored{
 const item=itemRow(row),version={...versionRow(row),markdown}
 if(!isKnowledgeVersion(version)||typeof row.markdown_path!=='string'||version.sourceId!==item.sourceId)throw corrupt()
 return {item,version,path:row.markdown_path}
}

export async function initializeMarkdownKnowledge(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_knowledge_sources(
  id uuid not null,owner_id text not null,source_type text not null check(source_type='paste'),created_at timestamptz not null,
  primary key(owner_id,id)
 );
 create table if not exists teloa_knowledge_items(
  id uuid not null,owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  source_id uuid not null,workspace_id text not null,title text not null,
  category text not null check(category in ('business-context','policy','sop','criteria','reference','template-asset','system-data-guide')),
  topics jsonb not null check(jsonb_typeof(topics)='array'),scope_ids jsonb not null check(jsonb_typeof(scope_ids)='array'),
  current_version integer not null check(current_version>0),status text not null check(status='active'),created_at timestamptz not null,updated_at timestamptz not null,
  primary key(owner_id,id),unique(owner_id,request_id),foreign key(owner_id,source_id) references teloa_knowledge_sources(owner_id,id)
 );
 create table if not exists teloa_knowledge_versions(
  owner_id text not null,knowledge_id uuid not null,source_id uuid not null,number integer not null check(number>0),
  content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),bytes integer not null check(bytes>0 and bytes<=2097152),markdown_path text not null,created_at timestamptz not null,
  primary key(owner_id,knowledge_id,number),unique(owner_id,knowledge_id,content_hash),
  foreign key(owner_id,knowledge_id) references teloa_knowledge_items(owner_id,id),foreign key(owner_id,source_id) references teloa_knowledge_sources(owner_id,id)
 );
 alter table teloa_knowledge_versions drop constraint if exists teloa_knowledge_versions_owner_id_knowledge_id_content_hash_key;
 create table if not exists teloa_knowledge_revision_requests(
  owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  operation text not null check(operation in ('revise','restore')),knowledge_id uuid not null,published_version integer not null check(published_version>1),result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null,
  primary key(owner_id,request_id),foreign key(owner_id,knowledge_id,published_version) references teloa_knowledge_versions(owner_id,knowledge_id,number)
 );
 alter table teloa_knowledge_items add column if not exists category text;
 alter table teloa_knowledge_items add column if not exists topics jsonb;
 update teloa_knowledge_items set category='reference' where category is null;
 update teloa_knowledge_items set topics='[]'::jsonb where topics is null;
 update teloa_knowledge_items set request_spec=request_spec||jsonb_build_object('category',category)
  where jsonb_typeof(request_spec)='object' and not(request_spec?'category');
 update teloa_knowledge_items set request_spec=request_spec||jsonb_build_object('topics',topics)
  where jsonb_typeof(request_spec)='object' and not(request_spec?'topics');
 alter table teloa_knowledge_items alter column category set default 'reference';
 alter table teloa_knowledge_items alter column category set not null;
 alter table teloa_knowledge_items alter column topics set default '[]'::jsonb;
 alter table teloa_knowledge_items alter column topics set not null;
 do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='teloa_knowledge_items'::regclass and conname='teloa_knowledge_items_category_check') then
   alter table teloa_knowledge_items add constraint teloa_knowledge_items_category_check check(category in ('business-context','policy','sop','criteria','reference','template-asset','system-data-guide'));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='teloa_knowledge_items'::regclass and conname='teloa_knowledge_items_topics_check') then
   alter table teloa_knowledge_items add constraint teloa_knowledge_items_topics_check check(jsonb_typeof(topics)='array');
  end if;
 end $$;
 do $$ declare definition text; begin
  -- 旧库正文上限为 131072；按上下限数值比对（不依赖定义文本的括号与条件顺序），不是目标才替换，重复启动不改动。
  -- 并发启动的串行依赖上面那条对 teloa_knowledge_versions 的 alter table：它先拿到表的排他锁，
  -- 后到的宿主等前者提交后再进这里，读到的已是新定义。删改那条语句时要为这里另加 lock table。
  select pg_get_constraintdef(oid) into definition from pg_constraint where conrelid='teloa_knowledge_versions'::regclass and conname='teloa_knowledge_versions_bytes_check';
  if definition is null or definition !~ '\\mbytes > 0\\M' or coalesce(substring(definition from 'bytes <= (\\d+)'),'')<>'2097152' or definition ~ '\\m(OR|NOT)\\M' then
   alter table teloa_knowledge_versions drop constraint if exists teloa_knowledge_versions_bytes_check;
   alter table teloa_knowledge_versions add constraint teloa_knowledge_versions_bytes_check check(bytes>0 and bytes<=2097152);
  end if;
 end $$;
 create or replace function teloa_reject_knowledge_version_mutation() returns trigger language plpgsql as $$
 begin raise exception 'knowledge versions are immutable'; end $$;
 drop trigger if exists teloa_knowledge_versions_immutable on teloa_knowledge_versions;
 create trigger teloa_knowledge_versions_immutable before update or delete on teloa_knowledge_versions
 for each row execute function teloa_reject_knowledge_version_mutation();
 create or replace function teloa_reject_knowledge_revision_request_mutation() returns trigger language plpgsql as $$
 begin raise exception 'knowledge revision requests are immutable'; end $$;
 drop trigger if exists teloa_knowledge_revision_requests_immutable on teloa_knowledge_revision_requests;
 create trigger teloa_knowledge_revision_requests_immutable before update or delete on teloa_knowledge_revision_requests
 for each row execute function teloa_reject_knowledge_revision_request_mutation();
 `);await initializeKnowledgeTree(pool) }

const selectItem=`select i.*,s.source_type,v.number as head_number,v.source_id as head_source_id
 from teloa_knowledge_items i join teloa_knowledge_sources s on s.owner_id=i.owner_id and s.id=i.source_id
 left join teloa_knowledge_versions v on v.owner_id=i.owner_id and v.knowledge_id=i.id and v.number=i.current_version`
const selectStored=`select i.*,s.source_type,v.source_id as version_source_id,v.number,v.content_hash,v.bytes,v.markdown_path,v.created_at as version_created_at
 from teloa_knowledge_items i join teloa_knowledge_sources s on s.owner_id=i.owner_id and s.id=i.source_id
 join teloa_knowledge_versions v on v.owner_id=i.owner_id and v.knowledge_id=i.id`

export class MarkdownKnowledgeService{
 private readonly pool:Pool
 private readonly root:string
 private readonly workspaceId:string
 private readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,root:string,workspaceId:string,identity:{id:()=>string;now:()=>string}){if(!stable(workspaceId))throw bad();this.pool=pool;this.root=root;this.workspaceId=workspaceId;this.identity=identity}
 private relative(knowledgeId:string,hash:string){return ['workspaces',this.workspaceId,'knowledge',knowledgeId,'versions',hash+'.md'].join('/')}
 private async anchorDirectory(path:string,canonical:string,missingIsCorrupt:boolean):Promise<DirectoryAnchor>{
  let entry:Awaited<ReturnType<typeof lstat>>
  try{entry=await lstat(path)}catch(error){const code=(error as NodeJS.ErrnoException).code;if((missingIsCorrupt&&code==='ENOENT')||code==='ELOOP'||code==='ENOTDIR')throw corrupt();throw unavailable()}
  if(entry.isSymbolicLink()||!entry.isDirectory())throw corrupt()
  let handle:FileHandle
  try{handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_DIRECTORY)}catch(error){const code=(error as NodeJS.ErrnoException).code;if(code==='ELOOP'||code==='ENOTDIR'||(missingIsCorrupt&&code==='ENOENT'))throw corrupt();throw unavailable()}
  try{
   const current=await handle.stat(),resolved=await realpath(path)
   if(!current.isDirectory()||current.dev!==entry.dev||current.ino!==entry.ino||resolved!==canonical)throw corrupt()
   return {path,canonical,device:current.dev,inode:current.ino,handle}
  }catch(error){await handle.close().catch(()=>{});if(error instanceof WorkError)throw error;const code=(error as NodeJS.ErrnoException).code;if(code==='ENOENT'||code==='ELOOP'||code==='ENOTDIR')throw corrupt();throw unavailable()}
 }
 private async verifyAnchors(anchors:DirectoryAnchor[]):Promise<void>{
  // Node 没有 openat；持续持有目录句柄，并在每次按路径操作前后核对 inode 与规范路径，避免把一次性检查当成安全边界。
  for(const anchor of anchors){
   try{
    const entry=await lstat(anchor.path),current=await anchor.handle.stat(),resolved=await realpath(anchor.path)
    if(entry.isSymbolicLink()||!entry.isDirectory()||!current.isDirectory()||entry.dev!==anchor.device||entry.ino!==anchor.inode||current.dev!==anchor.device||current.ino!==anchor.inode||resolved!==anchor.canonical)throw corrupt()
   }catch(error){if(error instanceof WorkError)throw error;const code=(error as NodeJS.ErrnoException).code;if(code==='ENOENT'||code==='ELOOP'||code==='ENOTDIR')throw corrupt();throw unavailable()}
  }
 }
 private async closeAnchors(anchors:DirectoryAnchor[]):Promise<boolean>{const results=await Promise.allSettled([...anchors].reverse().map(anchor=>anchor.handle.close()));return results.every(result=>result.status==='fulfilled')}
 private async openDirectoryChain(relativeDirectory:string,create:boolean):Promise<DirectoryAnchor[]>{
  const parts=relativeDirectory.split('/')
  if(parts.some(part=>!stable(part)))throw corrupt()
  const anchors:DirectoryAnchor[]=[]
  try{
   const rootEntry=await lstat(this.root).catch(error=>{throw (error as NodeJS.ErrnoException).code==='ELOOP'?corrupt():unavailable()})
   if(rootEntry.isSymbolicLink())throw corrupt()
   if(!rootEntry.isDirectory())throw unavailable()
   const rootCanonical=await realpath(this.root).catch(()=>{throw unavailable()})
   anchors.push(await this.anchorDirectory(this.root,rootCanonical,false))
   let path=this.root,canonical=rootCanonical
   for(const part of parts){
    path=join(path,part);canonical=join(canonical,part)
    await this.verifyAnchors(anchors)
    let created=false
    try{await lstat(path)}catch(error){
     const code=(error as NodeJS.ErrnoException).code
     if(code!=='ENOENT')throw code==='ELOOP'||code==='ENOTDIR'?corrupt():unavailable()
     if(!create)throw corrupt()
     await this.verifyAnchors(anchors)
     try{await mkdir(path,{mode:0o700});created=true}catch(mkdirError){if((mkdirError as NodeJS.ErrnoException).code!=='EEXIST')throw unavailable()}
    }
    const anchor=await this.anchorDirectory(path,canonical,true)
    anchors.push(anchor);await this.verifyAnchors(anchors)
    if(created){
     try{await anchors[anchors.length-2]!.handle.sync();await anchor.handle.sync()}catch{throw unavailable()}
     await this.verifyAnchors(anchors)
    }
   }
   return anchors
  }catch(error){await this.closeAnchors(anchors);throw error}
 }
 private async syncDirectory(anchors:DirectoryAnchor[]):Promise<void>{try{await this.verifyAnchors(anchors);await anchors.at(-1)!.handle.sync();await this.verifyAnchors(anchors)}catch(error){if(error instanceof WorkError)throw error;throw unavailable()}}
 private async readContent(relative:string,expectedHash:string,expectedBytes:number):Promise<string>{
  const anchors=await this.openDirectoryChain(dirname(relative),false)
  const name=relative.split('/').at(-1)
  if(name!==expectedHash+'.md'){await this.closeAnchors(anchors);throw corrupt()}
  let file:Awaited<ReturnType<typeof open>>
  try{await this.verifyAnchors(anchors);file=await open(join(anchors.at(-1)!.canonical,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);await this.verifyAnchors(anchors)}catch(error){await this.closeAnchors(anchors);if(error instanceof WorkError)throw error;if(['ENOENT','ELOOP','ENOTDIR','EISDIR'].includes(String((error as NodeJS.ErrnoException).code)))throw corrupt();throw unavailable()}
  let result:string|undefined,failure:unknown
  try{
   const info=await file.stat()
   if(!info.isFile()||info.size<=0||info.size>maxBytes||info.size!==expectedBytes)throw corrupt()
   const bytes=Buffer.alloc(info.size+1);let offset=0
   while(offset<bytes.length){const read=await file.read(bytes,offset,bytes.length-offset,offset);if(read.bytesRead===0)break;offset+=read.bytesRead}
   if(offset!==info.size)throw corrupt()
   const fixed=bytes.subarray(0,offset),markdown=fixed.toString('utf8')
   let normalized:string;try{normalized=normalizePasteMarkdown(markdown)}catch{throw corrupt()}
   if(digest(fixed)!==expectedHash||Buffer.from(markdown,'utf8').compare(fixed)!==0||normalized!==markdown)throw corrupt()
   await this.verifyAnchors(anchors);result=markdown
  }catch(error){failure=error instanceof WorkError?error:unavailable()}
  try{await file.close()}catch{if(!failure)failure=unavailable()}
  if(!await this.closeAnchors(anchors)&&!failure)failure=unavailable()
  if(failure)throw failure
  return result!
 }
 private async writeContent(relative:string,bytes:Buffer):Promise<Published>{
  const suffix=this.identity.id()
  if(!resourceId(suffix))throw corrupt()
  const name=relative.split('/').at(-1),hash=digest(bytes)
  if(name!==hash+'.md')throw corrupt()
  const anchors=await this.openDirectoryChain(dirname(relative),true),target=join(anchors.at(-1)!.canonical,name),temporary=target+'.'+suffix+'.tmp'
  let keepAnchors=false,createdTarget=false
  try{
   await this.verifyAnchors(anchors)
   let exists=true
   try{await lstat(target)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')exists=false;else throw error}
   if(exists){if(await this.readContent(relative,hash,bytes.length)!==bytes.toString('utf8'))throw corrupt();keepAnchors=true;return {target,created:false,anchors}}
   const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
   try{await this.verifyAnchors(anchors);await file.writeFile(bytes);await file.sync();await this.verifyAnchors(anchors)}finally{await file.close()}
   let created=false
   await this.verifyAnchors(anchors)
   try{await link(temporary,target);created=true;createdTarget=true}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(await this.readContent(relative,hash,bytes.length)!==bytes.toString('utf8'))throw corrupt()}
   await this.verifyAnchors(anchors);await this.syncDirectory(anchors)
   await unlink(temporary);await this.syncDirectory(anchors)
   keepAnchors=true;return {target,created,anchors}
  }catch(error){if(error instanceof WorkError)throw error;throw unavailable()}
  finally{
   if(!keepAnchors){
    if(createdTarget)await this.verifyAnchors(anchors).then(()=>unlink(target)).then(()=>this.syncDirectory(anchors)).catch(()=>{})
    await this.verifyAnchors(anchors).then(()=>unlink(temporary)).then(()=>this.syncDirectory(anchors)).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof WorkError))throw unavailable()})
    await this.closeAnchors(anchors)
   }
  }
 }
 private async cleanupPublished(value:Published):Promise<void>{if(!value.created)return;try{await this.verifyAnchors(value.anchors);await unlink(value.target).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error});await this.syncDirectory(value.anchors)}catch{throw unavailable()}}
 private async byRequest(client:PoolClient,ownerId:string,requestId:string):Promise<Record<string,unknown>|undefined>{
  const row=(await client.query(selectStored+' where i.owner_id=$1 and i.request_id=$2 and v.number=i.current_version',[ownerId,requestId])).rows[0]
  if(row)return row
  if((await client.query('select 1 from teloa_knowledge_items where owner_id=$1 and request_id=$2',[ownerId,requestId])).rowCount)throw corrupt()
  return undefined
 }
 async createPaste(actor:ResourceActor,input:unknown):Promise<PasteKnowledge>{
  const row=exact(input,['requestId','title','category','topics','scopeIds','markdown','parentId','expectedDirectoryRevision','position'])
  if(!resourceId(row.requestId)||typeof row.title!=='string'||!row.title.trim()||row.title.length>200||!knowledgeCategories.includes(row.category as KnowledgeCategory)||!resourceScopes(row.scopeIds))throw bad()
  const hasDirectory=row.parentId!==undefined||row.expectedDirectoryRevision!==undefined||row.position!==undefined
  if(hasDirectory&&(!resourceVersion(row.expectedDirectoryRevision)||(row.parentId!==undefined&&!stable(row.parentId))||(row.position!==undefined&&(!Number.isSafeInteger(row.position)||Number(row.position)<0))))throw bad()
  const title=row.title.trim(),category=row.category as KnowledgeCategory,topics=topicList(row.topics),scopeIds=[...row.scopeIds].sort(),markdown=normalizePasteMarkdown(row.markdown),bytes=Buffer.from(markdown,'utf8'),contentHash=digest(bytes)
  authorizeResourceActor(actor,actor.ownerId,scopeIds,true)
  const directory=hasDirectory?{parentId:(row.parentId as string|undefined)??null,position:(row.position as number|undefined)??null,expectedDirectoryRevision:row.expectedDirectoryRevision as number}:undefined
  const requestSpec:PasteRequestSpec={workspaceId:this.workspaceId,title,category,topics,scopeIds,contentHash,...(directory?{directory}:{})},client=await this.pool.connect().catch(()=>{throw unavailable()})
  let published:Published|undefined,commitStarted=false
  try{
   await client.query('begin')
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['paste-knowledge',actor.ownerId,row.requestId])])
   const existing=await this.byRequest(client,actor.ownerId,row.requestId)
   if(existing){
    if(!sameRequest(existing.request_spec,requestSpec))throw new WorkError('teloa/conflict','同一请求 ID 不能创建另一份粘贴知识。')
    const item=itemRow(existing),summary=versionRow(existing),path=existing.markdown_path
    if(item.workspaceId!==this.workspaceId||summary.sourceId!==item.sourceId||typeof path!=='string'||path!==this.relative(item.id,summary.contentHash))throw corrupt()
    const saved=stored(existing,await this.readContent(path,summary.contentHash,summary.bytes))
    commitStarted=true;await client.query('commit');return {item:saved.item,version:saved.version}
   }
   const knowledgeId=this.identity.id(),sourceId=this.identity.id(),now=this.identity.now(),relative=this.relative(knowledgeId,contentHash)
   if(!resourceId(knowledgeId)||!resourceId(sourceId)||!Number.isFinite(Date.parse(now)))throw corrupt()
   published=await this.writeContent(relative,bytes)
   await client.query('insert into teloa_knowledge_sources values($1,$2,$3,$4)',[sourceId,actor.ownerId,'paste',now])
   await client.query(`insert into teloa_knowledge_items(id,owner_id,request_id,request_spec,source_id,workspace_id,title,category,topics,scope_ids,current_version,status,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'active',$11,$11)`,[knowledgeId,actor.ownerId,row.requestId,JSON.stringify(requestSpec),sourceId,this.workspaceId,title,category,JSON.stringify(topics),JSON.stringify(scopeIds),now])
   await client.query('insert into teloa_knowledge_versions values($1,$2,$3,1,$4,$5,$6,$7)',[actor.ownerId,knowledgeId,sourceId,contentHash,bytes.length,relative,now])
   await attachKnowledgePage(client,{ownerId:actor.ownerId,workspaceId:this.workspaceId,knowledgeId,title,now,...(directory?{expectedDirectoryRevision:directory.expectedDirectoryRevision,...(directory.parentId?{parentId:directory.parentId}:{}),...(directory.position===null?{}:{position:directory.position})}:{})})
   const result=stored((await this.byRequest(client,actor.ownerId,row.requestId))!,markdown)
   commitStarted=true;await client.query('commit');return {item:result.item,version:result.version}
  }catch(error){await client.query('rollback').catch(()=>{});if(published&&!commitStarted)await this.cleanupPublished(published);if(error instanceof WorkError)throw error;throw unavailable()}finally{if(published)await this.closeAnchors(published.anchors);client.release()}
 }
 private sameItemIdentity(left:KnowledgeItem,right:KnowledgeItem):boolean{
  return left.id===right.id&&left.ownerId===right.ownerId&&left.sourceId===right.sourceId&&left.sourceType===right.sourceType&&left.workspaceId===right.workspaceId&&left.title===right.title&&left.category===right.category&&JSON.stringify(left.topics)===JSON.stringify(right.topics)&&JSON.stringify(left.scopeIds)===JSON.stringify(right.scopeIds)&&left.status===right.status&&left.createdAt===right.createdAt
 }
 private async revisionResult(client:PoolClient,actor:ResourceActor,row:Record<string,unknown>):Promise<PasteKnowledge>{
  if(!resourceId(row.request_id)||!resourceId(row.knowledge_id)||!resourceVersion(row.published_version)||!['revise','restore'].includes(String(row.operation)))throw corrupt()
  if(!isRecord(row.result)||Object.keys(row.result).length!==1||!Object.hasOwn(row.result,'item'))throw corrupt()
  const snapshot=row.result.item
  if(!isKnowledgeItem(snapshot)||snapshot.ownerId!==actor.ownerId||snapshot.workspaceId!==this.workspaceId||snapshot.id!==row.knowledge_id||snapshot.currentVersion!==row.published_version)throw corrupt()
  const current=await this.item(client,actor,snapshot.id)
  if(current.currentVersion<snapshot.currentVersion||!this.sameItemIdentity(current,snapshot))throw corrupt()
  const storedRow=(await client.query(selectStored+' where i.owner_id=$1 and i.id=$2 and v.number=$3',[actor.ownerId,snapshot.id,snapshot.currentVersion])).rows[0]
  if(!storedRow)throw corrupt()
  const summary=versionRow(storedRow),relative=storedRow.markdown_path
  if(typeof relative!=='string'||summary.sourceId!==snapshot.sourceId||relative!==this.relative(snapshot.id,summary.contentHash))throw corrupt()
  const value={item:snapshot,version:{...summary,markdown:await this.readContent(relative,summary.contentHash,summary.bytes)}}
  if(!isPasteKnowledge(value)||value.item.updatedAt!==value.version.createdAt)throw corrupt()
  return value
 }
 private async appendVersion<T>(actor:ResourceActor,requestId:string,spec:RevisionRequestSpec,source:{kind:'markdown';markdown:string}|{kind:'version';version:number},within:(client:PoolClient,value:PasteKnowledge)=>Promise<T>):Promise<{knowledge:PasteKnowledge;value:T}>{
  authorizeResourceActor(actor,actor.ownerId,[],true)
  const client=await this.pool.connect().catch(()=>{throw unavailable()})
  let published:Published|undefined,commitStarted=false
  try{
   await client.query('begin')
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['knowledge-revision',actor.ownerId,requestId])])
   const prior=(await client.query('select * from teloa_knowledge_revision_requests where owner_id=$1 and request_id=$2 for update',[actor.ownerId,requestId])).rows[0] as Record<string,unknown>|undefined
   if(prior){
    if(!sameRevisionRequest(prior.request_spec,spec)||prior.operation!==spec.operation||prior.knowledge_id!==spec.knowledgeId)throw new WorkError('teloa/conflict','同一请求 ID 不能发布另一份知识版本。')
    const knowledge=await this.revisionResult(client,actor,prior),value=await within(client,knowledge);commitStarted=true;await client.query('commit');return {knowledge,value}
   }
   const item=await this.item(client,actor,spec.knowledgeId,true)
   if(item.sourceType!=='paste')throw new WorkError('teloa/conflict','在线同步来源保持只读；请先创建本地校正版。')
   if(item.currentVersion!==spec.expectedVersion)throw new WorkError('teloa/version-conflict','知识当前版本已变化，请重新读取后编辑。')
   let markdown:string
   if(source.kind==='markdown')markdown=source.markdown
   else{
    const historical=(await client.query(selectStored+' where i.owner_id=$1 and i.id=$2 and v.number=$3',[item.ownerId,item.id,source.version])).rows[0]
    if(!historical)throw new WorkError('teloa/not-found','知识固定版本不存在。')
    const summary=versionRow(historical),relative=historical.markdown_path
    if(typeof relative!=='string'||summary.sourceId!==item.sourceId||relative!==this.relative(item.id,summary.contentHash))throw corrupt()
    markdown=await this.readContent(relative,summary.contentHash,summary.bytes)
   }
   const bytes=Buffer.from(markdown,'utf8'),contentHash=digest(bytes)
   if(spec.operation==='revise'&&spec.contentHash!==contentHash)throw corrupt()
   const next=item.currentVersion+1,relative=this.relative(item.id,contentHash),now=this.identity.now()
   if(!Number.isFinite(Date.parse(now)))throw corrupt()
   published=await this.writeContent(relative,bytes)
   await client.query('insert into teloa_knowledge_versions(owner_id,knowledge_id,source_id,number,content_hash,bytes,markdown_path,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)',[item.ownerId,item.id,item.sourceId,next,contentHash,bytes.length,relative,now])
   await client.query('update teloa_knowledge_items set current_version=$3,updated_at=$4 where owner_id=$1 and id=$2',[item.ownerId,item.id,next,now])
   const saved=stored((await client.query(selectStored+' where i.owner_id=$1 and i.id=$2 and v.number=$3',[item.ownerId,item.id,next])).rows[0],markdown),value={item:saved.item,version:saved.version}
   if(!isPasteKnowledge(value))throw corrupt()
   await client.query('insert into teloa_knowledge_revision_requests(owner_id,request_id,request_spec,operation,knowledge_id,published_version,result,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)',[item.ownerId,requestId,JSON.stringify(spec),spec.operation,item.id,next,JSON.stringify({item:value.item}),now])
   const result=await within(client,value)
   commitStarted=true;await client.query('commit');return {knowledge:value,value:result}
  }catch(error){await client.query('rollback').catch(()=>{});if(published&&!commitStarted)await this.cleanupPublished(published);if(error instanceof WorkError)throw error;throw unavailable()}finally{if(published)await this.closeAnchors(published.anchors);client.release()}
 }
 async reviseWithTransaction<T>(actor:ResourceActor,input:unknown,within:(client:PoolClient,value:PasteKnowledge)=>Promise<T>):Promise<{knowledge:PasteKnowledge;value:T}>{
  const row=exact(input,['requestId','knowledgeId','expectedVersion','markdown'])
  if(!resourceId(row.requestId)||!resourceId(row.knowledgeId)||!resourceVersion(row.expectedVersion))throw bad()
  const markdown=normalizePasteMarkdown(row.markdown),contentHash=digest(Buffer.from(markdown,'utf8')),spec:RevisionRequestSpec={operation:'revise',knowledgeId:(row.knowledgeId as string).toLowerCase(),expectedVersion:row.expectedVersion as number,contentHash}
  return this.appendVersion(actor,(row.requestId as string).toLowerCase(),spec,{kind:'markdown',markdown},within)
 }
 async restoreWithTransaction<T>(actor:ResourceActor,input:unknown,within:(client:PoolClient,value:PasteKnowledge)=>Promise<T>):Promise<{knowledge:PasteKnowledge;value:T}>{
  const row=exact(input,['requestId','knowledgeId','version','expectedVersion'])
  if(!resourceId(row.requestId)||!resourceId(row.knowledgeId)||!resourceVersion(row.version)||!resourceVersion(row.expectedVersion))throw bad()
  const spec:RevisionRequestSpec={operation:'restore',knowledgeId:(row.knowledgeId as string).toLowerCase(),expectedVersion:row.expectedVersion as number,version:row.version as number}
  return this.appendVersion(actor,(row.requestId as string).toLowerCase(),spec,{kind:'version',version:spec.version},within)
 }
 async revise(actor:ResourceActor,input:unknown):Promise<PasteKnowledge>{
  return (await this.reviseWithTransaction(actor,input,async()=>undefined)).knowledge
 }
 async restore(actor:ResourceActor,input:unknown):Promise<PasteKnowledge>{
  return (await this.restoreWithTransaction(actor,input,async()=>undefined)).knowledge
 }
 async list(actor:ResourceActor,input:unknown):Promise<KnowledgeItem[]>{
  authorizeResourceActor(actor);exact(input,[])
  let rows:Record<string,unknown>[]
  try{rows=(await this.pool.query(selectItem+' where i.owner_id=$1 and i.workspace_id=$2 order by i.created_at desc,i.id',[actor.ownerId,this.workspaceId])).rows}catch(error){if(error instanceof WorkError)throw error;throw unavailable()}
  const values=rows.map(value=>itemRow(value,true))
  return values.filter(item=>item.scopeIds.every(scope=>actor.scopeIds.includes(scope)))
 }
 private async item(client:PoolClient,actor:ResourceActor,knowledgeId:string,lock=false):Promise<KnowledgeItem>{
  let row:Record<string,unknown>|undefined
  if(lock){
   row=(await client.query(`select i.*,s.source_type from teloa_knowledge_items i join teloa_knowledge_sources s on s.owner_id=i.owner_id and s.id=i.source_id where i.id=$1 and i.owner_id=$2 and i.workspace_id=$3 for update of i`,[knowledgeId,actor.ownerId,this.workspaceId])).rows[0]
   if(row){const head=(await client.query('select number,source_id from teloa_knowledge_versions where owner_id=$1 and knowledge_id=$2 and number=$3',[actor.ownerId,knowledgeId,row.current_version])).rows[0];row={...row,head_number:head?.number,head_source_id:head?.source_id}}
  }else row=(await client.query(selectItem+' where i.id=$1 and i.owner_id=$2 and i.workspace_id=$3',[knowledgeId,actor.ownerId,this.workspaceId])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','知识不存在或不属于当前本人及工作空间。')
  const item=itemRow(row,true);authorizeResourceActor(actor,item.ownerId,item.scopeIds);return item
 }
 async listVersions(actor:ResourceActor,input:unknown):Promise<KnowledgeVersionSummary[]>{
  authorizeResourceActor(actor);const row=exact(input,['knowledgeId']);if(!resourceId(row.knowledgeId))throw bad()
  const client=await this.pool.connect().catch(()=>{throw unavailable()})
  try{await client.query('begin isolation level repeatable read read only');const item=await this.item(client,actor,row.knowledgeId as string)
   const rows=(await client.query(selectStored+' where i.owner_id=$1 and i.id=$2 order by v.number',[item.ownerId,item.id])).rows
   if(rows.length!==item.currentVersion)throw corrupt()
   const versions=rows.map(versionRow);if(versions.some((version,index)=>version.sourceId!==item.sourceId||version.version!==index+1))throw corrupt()
   await client.query('commit');return versions
  }catch(error){await client.query('rollback').catch(()=>{});if(error instanceof WorkError)throw error;throw unavailable()}finally{client.release()}
 }
 async readVersion(actor:ResourceActor,input:unknown):Promise<KnowledgeVersion>{
  authorizeResourceActor(actor);const row=exact(input,['knowledgeId','version']);if(!resourceId(row.knowledgeId)||!resourceVersion(row.version))throw bad()
  const client=await this.pool.connect().catch(()=>{throw unavailable()})
  try{await client.query('begin isolation level repeatable read read only');const item=await this.item(client,actor,row.knowledgeId as string)
   const value=(await client.query(selectStored+' where i.owner_id=$1 and i.id=$2 and v.number=$3',[item.ownerId,item.id,row.version])).rows[0]
   if(!value)throw new WorkError('teloa/not-found','知识固定版本不存在。')
   const summary=versionRow(value),relative=value.markdown_path
   if(typeof relative!=='string'||item.workspaceId!==this.workspaceId||summary.sourceId!==item.sourceId||relative!==this.relative(item.id,summary.contentHash))throw corrupt()
   const version={...summary,markdown:await this.readContent(relative,summary.contentHash,summary.bytes)}
   if(!isKnowledgeVersion(version))throw corrupt();await client.query('commit');return version
  }catch(error){await client.query('rollback').catch(()=>{});if(error instanceof WorkError)throw error;throw unavailable()}finally{client.release()}
 }
}
