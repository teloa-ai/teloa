import {createHash} from 'node:crypto'
import {constants,type BigIntStats} from 'node:fs'
import {lstat,open,realpath} from 'node:fs/promises'
import {isAbsolute,join,resolve,win32} from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,resourceId,resourceScopes,taskInput} from '@teloa/contract'
import type {ReferenceInfo} from '@teloa/mcp-reference/catalog'
import type {ResourceActor,ResourceSourceContext} from './resources.ts'

export type SourceReference=ReferenceInfo
export type AuthorizedLocalMaterialPorts={authorize:(actor:ResourceActor,scopeIds:readonly string[],operation:'register'|'read',requestId?:string,client?:PoolClient)=>Promise<{workspaceRoot:string;assertCurrent:()=>void;isProtectedPath:(absolutePath:string)=>boolean}>}
type ApprovedRoot=Awaited<ReturnType<AuthorizedLocalMaterialPorts['authorize']>>&{key:string}
type Definition={id:string;owner:string;title:string;path:string;scopes:string[];root:string;rootKey:string}
const maxBytes=128*1024,sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const denied=()=>new WorkError('teloa/forbidden','本机资料需要本人登记、当前工作目录许可及安全的 Markdown 原件。')
const invalid=()=>new WorkError('teloa/invalid-input','请指定当前工作文件夹内的相对 Markdown 路径、标题与业务范围。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','本机资料登记或回执损坏。')
const rootKey=(path:string,state:BigIntStats)=>sha(path+'\0'+state.dev+'\0'+state.ino)
const fileKey=(state:BigIntStats)=>[state.dev,state.ino,state.size,state.mtimeNs,state.ctimeNs].join(':')
const relativeMarkdown=(path:unknown):path is string=>typeof path==='string'&&path.length>0&&path.length<=1024&&!isAbsolute(path)&&!win32.isAbsolute(path)&&!/[\\\x00-\x1f\x7f]/.test(path)&&path.split('/').every(part=>part.length>0&&part!=='.'&&part!=='..'&&!part.startsWith('.'))&&/\.(md|markdown)$/i.test(path)
const assertLease=(value:Pick<ApprovedRoot,'assertCurrent'>)=>{try{if(value.assertCurrent()!==undefined)throw denied()}catch{throw denied()}}
function principal(value:ResourceSourceContext|undefined):ResourceActor{
 const actor=value?.actor
 if(!actor||typeof actor.ownerId!=='string'||!actor.ownerId.trim()||!['human','agent'].includes(actor.kind)||!resourceScopes(actor.scopeIds))throw denied()
 return actor
}
function definition(row:Record<string,unknown>):Definition{
 if(!resourceId(row.id)||typeof row.owner_id!=='string'||!row.owner_id||typeof row.title!=='string'||!row.title.trim()||!relativeMarkdown(row.relative_path)||!resourceScopes(row.scope_ids)||typeof row.workspace_root!=='string'||!isAbsolute(row.workspace_root)||typeof row.workspace_key!=='string'||!/^[0-9a-f]{64}$/.test(row.workspace_key))throw corrupt()
 return {id:row.id,owner:row.owner_id,title:row.title,path:row.relative_path,scopes:row.scope_ids,root:row.workspace_root,rootKey:row.workspace_key}
}

export async function initializeAuthorizedLocalMaterials(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_authorized_local_materials(
  id uuid primary key,owner_id text not null,title text not null,relative_path text not null,
  scope_ids jsonb not null check(jsonb_typeof(scope_ids)='array'),workspace_root text not null,workspace_key text not null,
  created_at timestamptz not null,unique(owner_id,workspace_key,relative_path)
 );
 create table if not exists teloa_authorized_local_material_requests(
  owner_id text not null,request_id uuid not null,material_id uuid not null references teloa_authorized_local_materials(id),
  request_spec jsonb not null,result jsonb not null,primary key(owner_id,request_id)
 );
`)}

/** 不枚举工作目录：只有本人登记的原件成为来源；模型只能按既有资料范围读取。 */
export class AuthorizedLocalMaterialCatalog{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly ports:AuthorizedLocalMaterialPorts|undefined
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},ports?:AuthorizedLocalMaterialPorts){this.pool=pool;this.identity=identity;this.ports=ports}
 private async approve(actor:ResourceActor,scopes:readonly string[],operation:'register'|'read',requestId?:string,client?:PoolClient):Promise<ApprovedRoot>{
  if(!this.ports||scopes.some(scope=>!actor.scopeIds.includes(scope)))throw denied()
  try{
   const lease=await this.ports.authorize(actor,scopes,operation,requestId,client)
   if(!lease||typeof lease.workspaceRoot!=='string'||!isAbsolute(lease.workspaceRoot)||typeof lease.assertCurrent!=='function'||typeof lease.isProtectedPath!=='function')throw denied()
   assertLease(lease)
   const path=resolve(lease.workspaceRoot),state=await lstat(path,{bigint:true})
   if(path!==lease.workspaceRoot||!state.isDirectory()||state.isSymbolicLink()||await realpath(path)!==path)throw denied()
   assertLease(lease);return {...lease,workspaceRoot:path,key:rootKey(path,state)}
  }catch{throw denied()}
 }
 private async load(item:Definition,root:ApprovedRoot):Promise<SourceReference&{text:string}>{
  if(item.root!==root.workspaceRoot||item.rootKey!==root.key)throw denied()
  try{
   const path=join(root.workspaceRoot,item.path),protectedPath=root.isProtectedPath(path)
   if(typeof protectedPath!=='boolean'||protectedPath)throw denied()
   const check=async()=>{
    assertLease(root)
    const state=await lstat(root.workspaceRoot,{bigint:true})
    if(!state.isDirectory()||state.isSymbolicLink()||rootKey(root.workspaceRoot,state)!==root.key||await realpath(root.workspaceRoot)!==root.workspaceRoot)throw denied()
    let current=root.workspaceRoot
    const parts=item.path.split('/')
    for(let i=0;i<parts.length;i++){
     current=join(current,parts[i]!);const entry=await lstat(current,{bigint:true})
     if(entry.isSymbolicLink()||(i===parts.length-1?!entry.isFile()||entry.nlink!==1n:!entry.isDirectory()))throw denied()
    }
    if(await realpath(path)!==path||root.isProtectedPath(path)!==false)throw denied()
    assertLease(root)
   }
   await check()
   const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
   try{
    const before=await handle.stat({bigint:true})
    if(!before.isFile()||before.nlink!==1n||before.size>BigInt(maxBytes))throw denied()
    const buffer=Buffer.alloc(maxBytes+1);let size=0
    while(size<buffer.length){const result=await handle.read(buffer,size,buffer.length-size,null);if(result.bytesRead===0)break;size+=result.bytesRead}
    if(size>maxBytes)throw denied()
    const bytes=buffer.subarray(0,size),text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes)
    await check()
    if(fileKey(await handle.stat({bigint:true}))!==fileKey(before)||fileKey(await lstat(path,{bigint:true}))!==fileKey(before))throw denied()
    assertLease(root)
    return {id:'local_material_'+item.id,title:item.title,source:item.path,version:sha(bytes),bytes:size,text}
   }finally{await handle.close()}
  }catch{throw denied()}
 }
 async register(actor:ResourceActor,input:unknown):Promise<SourceReference>{
  principal({actor});if(actor.kind!=='human')throw denied()
  const row=taskInput(input,['requestId','title','path','scopeIds'])
  if(!resourceId(row.requestId)||typeof row.title!=='string'||!row.title.trim()||row.title.length>200||!relativeMarkdown(row.path)||!resourceScopes(row.scopeIds))throw invalid()
  const requestId=row.requestId.toLowerCase(),spec={title:row.title.trim(),path:row.path,scopeIds:[...row.scopeIds].sort()},db=await this.pool.connect()
  try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/local-material/'+actor.ownerId+'/'+requestId])
   const root=await this.approve(actor,spec.scopeIds,'register',requestId,db),prior=(await db.query('select * from teloa_authorized_local_material_requests where owner_id=$1 and request_id=$2',[actor.ownerId,requestId])).rows[0]
   if(prior){
    if(!isDeepStrictEqual(prior.request_spec,spec))throw new WorkError('teloa/conflict','同一登记请求不能更换原件、标题或业务范围。')
    const item=definition((await db.query('select * from teloa_authorized_local_materials where owner_id=$1 and id=$2',[actor.ownerId,prior.material_id])).rows[0]??{}),saved=prior.result
    await this.load(item,root)
    if(!saved||saved.id!=='local_material_'+item.id||saved.title!==item.title||saved.source!==item.path||!/^[0-9a-f]{64}$/.test(saved.version)||!Number.isSafeInteger(saved.bytes)||saved.bytes<0||saved.bytes>maxBytes||Object.keys(saved).sort().join(',')!=='bytes,id,source,title,version')throw corrupt()
    assertLease(root);await db.query('commit');return saved
   }
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/local-material-path/'+actor.ownerId+'/'+root.key+'/'+spec.path])
   const existing=(await db.query('select * from teloa_authorized_local_materials where owner_id=$1 and workspace_key=$2 and relative_path=$3',[actor.ownerId,root.key,spec.path])).rows[0]
   let item:Definition
   if(existing){item=definition(existing);if(item.title!==spec.title||!isDeepStrictEqual(item.scopes,spec.scopeIds))throw new WorkError('teloa/conflict','原件已登记；请沿现有资料调整显示标题和范围。')}
   else{
    const id=this.identity.id();if(!resourceId(id))throw corrupt()
    item={id,owner:actor.ownerId,title:spec.title,path:spec.path,scopes:spec.scopeIds,root:root.workspaceRoot,rootKey:root.key}
   }
   const {text:_,...result}=await this.load(item,root)
   if(!existing)await db.query('insert into teloa_authorized_local_materials(id,owner_id,title,relative_path,scope_ids,workspace_root,workspace_key,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)',[item.id,item.owner,item.title,item.path,JSON.stringify(item.scopes),item.root,item.rootKey,this.identity.now()])
   await db.query('insert into teloa_authorized_local_material_requests(owner_id,request_id,material_id,request_spec,result) values($1,$2,$3,$4,$5)',[actor.ownerId,requestId,item.id,JSON.stringify(spec),JSON.stringify(result)])
   assertLease(root);await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async list(context?:ResourceSourceContext):Promise<{schema:'teloa.reference-list/v1';references:SourceReference[]}>{
  const actor=principal(context),root=await this.approve(actor,actor.scopeIds,'read',undefined,context?.client),db=context?.client??this.pool
  const rows=(await db.query('select * from teloa_authorized_local_materials where owner_id=$1 and workspace_key=$2 order by created_at,id',[actor.ownerId,root.key])).rows,references:SourceReference[]=[]
  for(const row of rows){const item=definition(row);if(item.scopes.some(scope=>!actor.scopeIds.includes(scope)||context?.scopeIds&&!context.scopeIds.includes(scope)))continue
   const lease=await this.approve(actor,item.scopes,'read',undefined,context?.client),{text:_,...info}=await this.load(item,lease);references.push(info)
  }
  assertLease(root);return {schema:'teloa.reference-list/v1',references}
 }
 private async readCurrent(id:string,context?:ResourceSourceContext):Promise<SourceReference&{text:string}>{
  const actor=principal(context),uuid=id.startsWith('local_material_')?id.slice('local_material_'.length):''
  if(!resourceId(uuid))throw denied()
  const row=(await (context?.client??this.pool).query('select * from teloa_authorized_local_materials where owner_id=$1 and id=$2',[actor.ownerId,uuid])).rows[0]
  if(!row)throw denied()
  const item=definition(row)
  if(item.scopes.some(scope=>!actor.scopeIds.includes(scope)||context?.scopeIds&&!context.scopeIds.includes(scope)))throw denied()
  const root=await this.approve(actor,item.scopes,'read',undefined,context?.client),value=await this.load(item,root)
  assertLease(root);return value
 }
 /** 长期职责只查自己已授权的原件；不因同业务范围的其他登记读取正文或扩大授权。 */
 async current(id:string,context?:ResourceSourceContext):Promise<SourceReference>{
  const {text:_,...info}=await this.readCurrent(id,context);return info
 }
 async read(id:string,version:string,context?:ResourceSourceContext):Promise<SourceReference&{schema:'teloa.reference/v1';text:string}>{
  const value=await this.readCurrent(id,context)
  if(value.version!==version)throw new WorkError('teloa/version-conflict','本机资料已变化，请读取当前版本后继续。')
  return {schema:'teloa.reference/v1',...value}
 }
}
