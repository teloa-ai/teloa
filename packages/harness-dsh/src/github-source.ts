import {createHash} from 'node:crypto'
import {WorkError,isRecord,isGithubRepositoryName} from '@teloa/contract'

export const githubSourceEndpoints=['market/github/resolve'] as const
type Operations={resolve:(owner:string,input:unknown)=>Promise<unknown>}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OWNER=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const invalid=()=>new WorkError('teloa/invalid-input','GitHub 来源传输格式不正确或包含未知字段。')
const bad=()=>new WorkError('teloa/invalid-host-response','GitHub 来源服务返回无效内容。')
const exact=(value:unknown,keys:readonly string[])=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
const date=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const safePath=(value:unknown):value is string=>typeof value==='string'&&value===value.normalize('NFC')&&!!value&&value.length<=500&&!value.startsWith('/')&&!value.split('/').some(part=>!part||part==='.'||part==='..')&&!/[\:?%#\u0000-\u001f\u007f]/.test(value)

function input(value:unknown){
 const row=exact(value,['requestId','owner','repo','ref','path'])
 if(row.path!==undefined&&(!safePath(row.path)||row.path.length>300||row.path.endsWith('/')))throw invalid()
 if(typeof row.requestId!=='string'||!UUID.test(row.requestId)||typeof row.owner!=='string'||!OWNER.test(row.owner)||row.owner.includes('--')||!isGithubRepositoryName(row.repo)||typeof row.ref!=='string'||row.ref.length<1||row.ref.length>200||!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(row.ref)||row.ref.includes('..')||row.ref.includes('//')||row.ref.includes('@{')||row.ref.endsWith('/')||row.ref.endsWith('.')||row.ref.split('/').some(part=>!part||part.startsWith('.')||part.endsWith('.lock')))throw invalid()
 return {requestId:row.requestId.toLowerCase(),owner:row.owner,repo:row.repo,ref:row.ref,...(row.path===undefined?{}:{path:row.path as string})}
}

function output(value:unknown,expected:ReturnType<typeof input>,owner:string){
 try{
  if(!isRecord(value)||Object.keys(value).some(key=>!['requestId','ownerId','stage','provenance','trust','files','createdAt','updatedAt'].includes(key))||value.requestId!==expected.requestId||value.ownerId!==owner||value.stage!=='ready'||!date(value.createdAt)||!date(value.updatedAt)||value.updatedAt<value.createdAt)throw bad()
  const source=value.provenance
  if(!isRecord(source)||Object.keys(source).some(key=>!['kind','owner','repo','requestedRef','resolvedCommit','archiveHash','path'].includes(key))||source.path!==expected.path||source.kind!=='github'||source.owner!==expected.owner||source.repo!==expected.repo||source.requestedRef!==expected.ref||typeof source.resolvedCommit!=='string'||!/^[0-9a-f]{40}$/.test(source.resolvedCommit)||typeof source.archiveHash!=='string'||!/^[0-9a-f]{64}$/.test(source.archiveHash))throw bad()
  if(!Array.isArray(value.files)||value.files.length<1||value.files.length>500)throw bad()
  let total=0,prior='';const paths=new Set<string>(),folded=new Set<string>()
  const files=value.files.map(item=>{
   if(!isRecord(item)||Object.keys(item).some(key=>!['path','hash','bytes'].includes(key))||!safePath(item.path)||typeof item.hash!=='string'||!/^[0-9a-f]{64}$/.test(item.hash)||!(item.bytes instanceof Uint8Array)||item.bytes.byteLength>2*1024*1024||paths.has(item.path)||folded.has(item.path.toLocaleLowerCase('en-US'))||!!prior&&prior>=item.path)throw bad()
   total+=item.bytes.byteLength;if(total>20*1024*1024||createHash('sha256').update(item.bytes).digest('hex')!==item.hash)throw bad()
   paths.add(item.path);folded.add(item.path.toLocaleLowerCase('en-US'));prior=item.path
   return {path:item.path,hash:item.hash,base64:Buffer.from(item.bytes).toString('base64')}
  })
  if(value.trust!==undefined&&(!isRecord(value.trust)||value.trust.publisher!==expected.owner||!isRecord(value.trust.repository)||value.trust.repository.host!=='github.com'||value.trust.repository.owner!==expected.owner||value.trust.repository.repo!==expected.repo||!isRecord(value.trust.signature)||value.trust.signature.status!=='unverified'))throw bad()
  return {requestId:expected.requestId,ownerId:'self' as const,stage:'ready' as const,provenance:{kind:'github' as const,owner:source.owner,repo:source.repo,requestedRef:source.requestedRef,resolvedCommit:source.resolvedCommit,archiveHash:source.archiveHash,...(expected.path===undefined?{}:{path:expected.path})},...(value.trust?{trust:value.trust}:{}),files,createdAt:value.createdAt,updatedAt:value.updatedAt}
 }catch(error){if(error instanceof WorkError)throw error;throw bad()}
}

/** 认证后的工作台专用 RPC；只固定来源字节，不写市场内容或安装状态。 */
export function createGithubSourceHandler(owner:string,get:()=>Promise<Operations>){
 return async(endpoint:string,payload:unknown)=>{
  if(endpoint!=='market/github/resolve')throw new WorkError('teloa/not-found','未提供此 GitHub 来源接口。')
  const request=input(payload),service=await get()
  return output(await service.resolve(owner,request),request,owner)
 }
}
