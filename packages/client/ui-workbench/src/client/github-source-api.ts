import {isGithubRepositoryName} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'
type Call=(method:string,payload:unknown)=>Promise<unknown>
export type GithubSourceJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
/** `path` 存在时宿主只按固定提交读取该子目录（用于导入单个 Skill）。 */
export type GithubSourceInput={owner:string;repo:string;ref:string;path?:string}
export type GithubSourceRequest=GithubSourceInput&{requestId:string}
export type GithubSourceProvenance={kind:'github';owner:string;repo:string;requestedRef:string;resolvedCommit:string;archiveHash:string;path?:string}
export type GithubSourceFile={path:string;hash:string;bytes:Uint8Array}
export type GithubSourceReceipt={requestId:string;ownerId:'self';stage:'ready';provenance:GithubSourceProvenance;trust?:MarketTrust;files:GithubSourceFile[];createdAt:string;updatedAt:string}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,OWNER=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const MAX_FILE=2*1024*1024,MAX_TOTAL=20*1024*1024,MAX_BASE64=4*Math.ceil(MAX_FILE/3)
const uuid=(value:unknown):value is string=>typeof value==='string'&&UUID.test(value),hash=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const exact=(value:unknown,keys:readonly string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error();return value as Record<string,unknown>}
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const safePath=(value:unknown):value is string=>typeof value==='string'&&value===value.normalize('NFC')&&!!value&&value.length<=500&&!value.startsWith('/')&&!value.split('/').some(part=>!part||part==='.'||part==='..')&&!/[\\:?%#\u0000-\u001f\u007f]/.test(value)

function source(value:unknown):GithubSourceInput{
 try{
  const row=exact(value,['owner','repo','ref','path'])
  if(row.path!==undefined&&(!safePath(row.path)||row.path.length>300||row.path.endsWith('/')))throw Error('path 子目录不合法。')
  if(typeof row.owner!=='string'||!OWNER.test(row.owner)||row.owner.includes('--'))throw Error('owner 标识不合法。')
  if(!isGithubRepositoryName(row.repo))throw Error('repo 标识不合法。')
  if(typeof row.ref!=='string'||row.ref.length<1||row.ref.length>200||!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(row.ref)||row.ref.includes('..')||row.ref.includes('//')||row.ref.includes('@{')||row.ref.endsWith('/')||row.ref.endsWith('.')||row.ref.split('/').some(part=>!part||part.startsWith('.')||part.endsWith('.lock')))throw Error('ref 不合法。')
  return {owner:row.owner,repo:row.repo,ref:row.ref,...(row.path===undefined?{}:{path:row.path as string})}
 }catch(error){if(error instanceof Error&&/(owner|repo|ref|path)/.test(error.message))throw error;throw Error('GitHub 来源输入格式不正确。')}
}
function request(value:unknown):GithubSourceRequest{try{const row=exact(value,['requestId','owner','repo','ref','path']);if(!uuid(row.requestId))throw Error();return {requestId:row.requestId.toLowerCase(),...source({owner:row.owner,repo:row.repo,ref:row.ref,...(row.path===undefined?{}:{path:row.path})})}}catch(error){if(error instanceof Error&&/(owner|repo|ref)/.test(error.message))throw error;throw Error('GitHub 来源 requestId 或请求格式不正确。')}}
const same=(left:GithubSourceRequest,right:GithubSourceInput)=>left.owner===right.owner&&left.repo===right.repo&&left.ref===right.ref&&left.path===right.path
const digest=async(value:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',Uint8Array.from(value))),byte=>byte.toString(16).padStart(2,'0')).join('')
const encode=(value:Uint8Array)=>{let result='';for(let at=0;at<value.length;at+=0x8000)result+=String.fromCharCode(...value.subarray(at,at+0x8000));return btoa(result)}
function decode(value:unknown):Uint8Array{
 if(typeof value!=='string'||value.length>MAX_BASE64||value.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw Error('GitHub 来源文件字节格式不正确。')
 let raw:string;try{raw=atob(value)}catch{throw Error('GitHub 来源文件字节格式不正确。')}
 const bytes=Uint8Array.from(raw,char=>char.charCodeAt(0));if(bytes.byteLength>MAX_FILE||encode(bytes)!==value)throw Error('GitHub 来源文件字节格式不正确。');return bytes
}
async function receipt(value:unknown,expected:GithubSourceRequest):Promise<GithubSourceReceipt>{
 try{
  const row=exact(value,['requestId','ownerId','stage','provenance','trust','files','createdAt','updatedAt'])
  if(row.requestId!==expected.requestId||row.ownerId!=='self'||row.stage!=='ready'||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt)throw Error('GitHub 来源回执身份、阶段或时间不一致。')
  const fixed=exact(row.provenance,['kind','owner','repo','requestedRef','resolvedCommit','archiveHash','path'])
  if(fixed.kind!=='github'||fixed.owner!==expected.owner||fixed.repo!==expected.repo||fixed.requestedRef!==expected.ref||fixed.path!==expected.path||typeof fixed.resolvedCommit!=='string'||!/^[0-9a-f]{40}$/.test(fixed.resolvedCommit)||!hash(fixed.archiveHash))throw Error('GitHub 固定 provenance 与原请求不一致。')
  if(!Array.isArray(row.files)||row.files.length<1||row.files.length>500)throw Error('GitHub 来源文件目录格式不正确。')
  const files:GithubSourceFile[]=[],paths=new Set<string>(),folded=new Set<string>();let total=0,prior=''
  for(const item of row.files){const file=exact(item,['path','hash','base64']);if(!safePath(file.path)||!hash(file.hash)||paths.has(file.path)||folded.has(file.path.toLocaleLowerCase('en-US'))||prior&&prior>=file.path)throw Error('GitHub 来源文件路径、顺序或重复关系不正确。');const bytes=decode(file.base64);total+=bytes.byteLength;if(total>MAX_TOTAL)throw Error('GitHub 来源文件总大小超过限制。');if(await digest(bytes)!==file.hash)throw Error('GitHub 来源文件摘要与字节不一致。');files.push({path:file.path,hash:file.hash,bytes});paths.add(file.path);folded.add(file.path.toLocaleLowerCase('en-US'));prior=file.path}
  if(row.trust!==undefined&&(!row.trust||typeof row.trust!=='object'||Array.isArray(row.trust)||Reflect.get(row.trust,'publisher')!==expected.owner||Reflect.get(Reflect.get(row.trust,'signature')??{},'status')!=='unverified'))throw Error('GitHub 来源信任声明与仓库身份不一致。')
  return {requestId:expected.requestId,ownerId:'self',stage:'ready',provenance:{kind:'github',owner:fixed.owner,repo:fixed.repo,requestedRef:fixed.requestedRef,resolvedCommit:fixed.resolvedCommit,archiveHash:fixed.archiveHash,...(expected.path===undefined?{}:{path:expected.path})},...(row.trust?{trust:row.trust as MarketTrust}:{}),files,createdAt:row.createdAt,updatedAt:row.updatedAt}
 }catch(error){if(error instanceof Error&&error.message.startsWith('GitHub '))throw error;throw Error('GitHub 来源回执格式不正确。')}
}
function noSideEffect(error:unknown):boolean{return !!error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict'].includes(String(error.code))}

export type GithubSourceApi=ReturnType<typeof createGithubSourceApi>
export function createGithubSourceApi(call:Call,journal?:GithubSourceJournal,newId:()=>string=()=>crypto.randomUUID()){
 let pending:GithubSourceRequest|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{const raw=journal?.read();if(raw){if(raw.length>1000)throw Error();const saved=exact(JSON.parse(raw),['schema','request']);if(saved.schema!=='teloa.github-source/v1')throw Error();pending=request(saved.request)}}catch{recoveryError=recoveryStorageError()}
 const send=async()=>{if(recoveryError)throw recoveryError;if(!pending)throw Error('没有待核对的 GitHub 来源请求。');if(busy)throw Error('GitHub 来源正在核对。');busy=true;try{journal?.write(JSON.stringify({schema:'teloa.github-source/v1',request:pending}));const result=await receipt(await call('market/github/resolve',pending),pending);journal?.clear();pending=undefined;return result}catch(error){if(noSideEffect(error)){journal?.clear();pending=undefined}throw error}finally{busy=false}}
 return {pending:()=>pending?structuredClone(pending):undefined,recoveryMessage:()=>recoveryError,
  /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discard(){const had=pending!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined;return had},
  recover:send,async resolve(value:GithubSourceInput){if(recoveryError)throw recoveryError;const normalized=source(value);if(pending&&!same(pending,normalized))throw Error('请先恢复原 GitHub 来源请求，再获取其他来源。');if(!pending){const requestId=newId();if(!uuid(requestId))throw Error('GitHub 来源 requestId 不正确。');pending={requestId:requestId.toLowerCase(),...normalized}}return send()}}
}
import type {MarketTrust} from './market-preview.ts'
