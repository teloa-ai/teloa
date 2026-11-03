import {createHash,randomUUID} from 'node:crypto'
import {credentialKey} from '@deepseek-ai/dsh-credentials'
import {isRecord,readSkillSecrets,WorkError,type MarketCatalogSkillSecret} from '@teloa/contract'
import {skillSecretBinding,viaSkillSecretStore,type SkillSecretCredentialPort,type SkillSecretsState,type ResolvedSkillSecrets} from './skill-secrets.ts'

/** 本人授权只属于当前固定非目录安装；不接受资源包或发布者自报的授权。 */
export type OwnedSkillIdentity={owner:string;installationId:string;bundleHash:string;contentHash:string;bodyHash:string;version:string}
export type OwnedSkillState=SkillSecretsState&{owner:{installation:string;installationId:string;version:string;authorized:boolean|null}}
export const ownedSkillSecretEndpoints=['skill-secrets/authorize-owned','skill-secrets/delete-owned','skill-secrets/revoke-owned'] as const
const policySlot='TELOA_OWNER_SKILL_POLICY',bindingSlot='TELOA_OWNER_SKILL_BINDING'
const hex=/^[a-f0-9]{64}$/,name=/^[a-z][a-z0-9-]{0,63}$/,value=/^[\x21-\x7e]{8,4096}$/
const hash=(data:unknown)=>createHash('sha256').update(JSON.stringify(data)).digest('hex')
const invalid=()=>new WorkError('teloa/invalid-input','请核对技能密钥目标、参数及本人确认。')
const changed=()=>new WorkError('teloa/version-conflict','技能安装或密钥授权已变化，请重新打开详情并确认。')
const exact=(data:unknown,keys:string[])=>{if(!isRecord(data)||Object.keys(data).some(k=>!keys.includes(k)))throw invalid();return data}
type Policy={installation:string;secrets:MarketCatalogSkillSecret[];nonce:string;binding:string}

export type OwnedSkillRequest={assertCurrent:()=>void}
/** 可信调用元数据来自RPC peer与signal，不来自载荷；逻辑提交后不再用取消抹去已接受的修改。 */
export function createOwnedSkillRequest(signal:AbortSignal,peer:unknown,browserPeer:()=>unknown):OwnedSkillRequest{
 const assertCurrent=()=>{signal.throwIfAborted();if(peer===undefined||peer===null||peer!==browserPeer())throw new WorkError('teloa/forbidden','本人浏览器连接已变化，请核对当前页面。')}
 assertCurrent();return {assertCurrent}
}

export function createOwnedSkillSecrets(ports:{owner:string;credentials:SkillSecretCredentialPort;current:(skill:string)=>Promise<OwnedSkillIdentity|undefined>;audit:(event:{event:string;skill:string})=>void}){
 const key=(skill:string)=>{
  const digest=hash([ports.owner,skill])
  // SDK键段须以字母开头；旧的合法键保持不变，数字开头此前无法写入。
  return credentialKey('teloa-owned-skill',/^[a-z]/.test(digest)?digest:'s-'+digest)
 }
 const skillOf=(v:unknown)=>{if(typeof v!=='string'||!name.test(v))throw invalid();return v}
 const installation=(id:OwnedSkillIdentity)=>{
  if(!ports.owner||id.owner!==ports.owner||!id.installationId||![id.bundleHash,id.contentHash,id.bodyHash].every(v=>hex.test(v)))throw changed()
  return hash(['teloa-owned-skill/v1',id.owner,id.installationId,id.bundleHash,id.contentHash,id.bodyHash,id.version])
 }
 const readSecrets=(v:unknown,skill:string)=>{
  try{const secrets=readSkillSecrets(v,skill);if(secrets.some(s=>s.envVarName===policySlot||s.envVarName===bindingSlot))throw invalid();return secrets}catch{throw invalid()}
 }
 const readPolicy=(env:Record<string,string>|undefined,skill:string,expected:string):Policy|undefined=>{
  if(!env?.[policySlot])return
  let data:Record<string,unknown>
  try{data=exact(JSON.parse(env[policySlot]!),['installation','secrets','nonce','binding'])}catch{throw changed()}
  // 安装或版本变化后旧授权不生效；不会把旧值绑定到新代码。
  if(data.installation!==expected)return
  if(typeof data.nonce!=='string'||!/^[a-f0-9-]{36}$/.test(data.nonce))throw changed()
  const secrets=readSecrets(data.secrets,skill),binding=hash([expected,skillSecretBinding(secrets),data.nonce])
  if(data.binding!==binding||env[bindingSlot]!==binding)throw changed()
  return {installation:expected,secrets,nonce:data.nonce,binding}
 }
 const envOf=(record:Awaited<ReturnType<SkillSecretCredentialPort['readRecord']>>)=>record?.kind==='api-key'?record.env:undefined
 const current=async(skill:string,read=()=>ports.current(skill))=>{const id=await read();return id?installation(id):undefined}
 const writable=async(skill:string)=>{if(!(await viaSkillSecretStore(()=>ports.credentials.describeRecord(key(skill)))).writable)throw new WorkError('teloa/dependency-unavailable','密钥存储当前只读，请到设置中处理后重试。')}
 async function describe(input:unknown,read?:()=>Promise<OwnedSkillIdentity|undefined>):Promise<OwnedSkillState|undefined>{
  const skill=skillOf(input),id=read?await read():await ports.current(skill),expected=id?installation(id):undefined
  if(!expected||!id)return
  const info=await viaSkillSecretStore(()=>ports.credentials.describeRecord(key(skill)))
  if(!info.writable)return {skill,binding:null,writable:false,reconfirm:false,vars:[],owner:{installation:expected,installationId:id.installationId,version:id.version,authorized:null}}
  const env=envOf(await viaSkillSecretStore(()=>ports.credentials.readRecord(key(skill)))),p=readPolicy(env,skill,expected)
  if(await current(skill,read)!==expected)throw changed()
  return {skill,binding:p?.binding??null,writable:true,reconfirm:false,vars:p?.secrets.map(s=>({envVarName:s.envVarName,label:s.label,required:s.required,configured:!!env?.[s.envVarName],target:s.target,...(s.name?{name:s.name}:{}),endpoints:structuredClone(s.endpoints)}))??[],owner:{installation:expected,installationId:id.installationId,version:id.version,authorized:!!p}}
 }
 async function authorize(payload:unknown,request:OwnedSkillRequest){
  request.assertCurrent()
  const row=exact(payload,['skill','expectedInstallation','expectedBinding','secrets','confirmed']),skill=skillOf(row.skill),expected=await current(skill)
  if(!expected||row.expectedInstallation!==expected||row.confirmed!==true||row.expectedBinding!==null&&(typeof row.expectedBinding!=='string'||!hex.test(row.expectedBinding)))throw changed()
  const secrets=readSecrets(row.secrets,skill),nonce=randomUUID(),binding=hash([expected,skillSecretBinding(secrets),nonce]),p:Policy={installation:expected,secrets,nonce,binding}
  await writable(skill)
  await viaSkillSecretStore(()=>ports.credentials.modifyRecord(key(skill),async record=>{
   request.assertCurrent()
   const actual=await current(skill)
   request.assertCurrent()
   if(actual!==expected)throw changed()
   const env=envOf(record),prior=readPolicy(env,skill,expected)
   if((prior?.binding??null)!==row.expectedBinding)throw changed()
   // 目标或参数变化不继承任何旧值；明确授权本身从不接收密钥。
   request.assertCurrent()
   return {kind:'api-key',env:{[policySlot]:JSON.stringify(p),[bindingSlot]:binding}}
  }))
  // modifyRecord已接受后保留正常回执，不因页面关闭自动重做或回滚。
  ports.audit({event:'skill-secret.owner-authorize',skill})
  return describe(skill)
 }
 async function save(payload:unknown,request:OwnedSkillRequest){
  request.assertCurrent()
  const row=exact(payload,['skill','expectedBinding','values']),skill=skillOf(row.skill),expected=await current(skill)
  if(!expected||typeof row.expectedBinding!=='string'||!hex.test(row.expectedBinding)||!isRecord(row.values)||!Object.keys(row.values).length)throw invalid()
  const submitted={...row.values}
  await writable(skill)
  await viaSkillSecretStore(()=>ports.credentials.modifyRecord(key(skill),async record=>{
   request.assertCurrent()
   const actual=await current(skill)
   request.assertCurrent()
   if(actual!==expected)throw changed()
   const env=envOf(record),p=readPolicy(env,skill,expected)
   if(!p||p.binding!==row.expectedBinding)throw changed()
   const allowed=new Set(p.secrets.map(s=>s.envVarName)),values:Record<string,string>={}
   for(const [k,v]of Object.entries(submitted)){if(!allowed.has(k)||typeof v!=='string'||!value.test(v))throw invalid();values[k]=v}
   request.assertCurrent()
   return {kind:'api-key',env:{...env,...values}}
  }))
  // modifyRecord已接受后保留正常回执，不因页面关闭自动重做或回滚。
  ports.audit({event:'skill-secret.save',skill})
  return describe(skill)
 }
 async function clear(payload:unknown,revoke:boolean,request:OwnedSkillRequest){
  request.assertCurrent()
  const row=exact(payload,['skill','expectedInstallation','expectedBinding','confirmed']),skill=skillOf(row.skill),expected=await current(skill)
  if(!expected||row.confirmed!==true||row.expectedInstallation!==expected)throw changed()
  await writable(skill)
  await viaSkillSecretStore(()=>ports.credentials.modifyRecord(key(skill),async record=>{
   request.assertCurrent()
   const actual=await current(skill)
   request.assertCurrent()
   if(actual!==expected)throw changed()
   const p=readPolicy(envOf(record),skill,expected)
   if(!p||p.binding!==row.expectedBinding)throw changed()
   request.assertCurrent()
   return {kind:'api-key',env:revoke?{}:{[policySlot]:JSON.stringify(p),[bindingSlot]:p.binding}}
  }))
  // modifyRecord已接受后保留正常回执，不因页面关闭自动重做或回滚。
  ports.audit({event:revoke?'skill-secret.owner-revoke':'skill-secret.delete',skill})
  return describe(skill)
 }
 async function resolve(skill:string,read?:()=>Promise<OwnedSkillIdentity|undefined>):Promise<ResolvedSkillSecrets|undefined>{
  skillOf(skill);const expected=await current(skill,read)
  if(!expected)return
  const p=readPolicy(envOf(await viaSkillSecretStore(()=>ports.credentials.readRecord(key(skill)))),skill,expected)
  if(await current(skill,read)!==expected)throw changed()
  return p?{secrets:p.secrets}:undefined
 }
 async function readForUse(skill:string){
  skillOf(skill);const expected=await current(skill)
  if(!expected)throw changed()
  const env=envOf(await viaSkillSecretStore(()=>ports.credentials.readRecord(key(skill)))),p=readPolicy(env,skill,expected)
  if(!p||await current(skill)!==expected)throw changed()
  return {secrets:p.secrets,values:Object.fromEntries(p.secrets.flatMap(s=>env?.[s.envVarName]?[[s.envVarName,env[s.envVarName]!]]:[])),stale:false}
 }
 return {describe,authorize,save,remove:(payload:unknown,request:OwnedSkillRequest)=>clear(payload,false,request),revoke:(payload:unknown,request:OwnedSkillRequest)=>clear(payload,true,request),resolve,readForUse}
}
