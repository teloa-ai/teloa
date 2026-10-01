import {createHash} from 'node:crypto'
import {credentialKey,type CredentialProvider} from '@deepseek-ai/dsh-credentials'
import {WorkError,assertSecretGroupsConsistent,isRecord,normalizedHeaderName,skillSecretBindingSlot,type MarketCatalogSkillSecret,type MarketCatalogText} from '@teloa/contract'
import {isCredentialStoreLocked} from './credentials/store-state.ts'

/**
 * 技能密钥（规格 §3、§7）：只经 ctx.credentials 的记录半边存取，键 teloa-skill/<技能名>，记录 api-key + env。
 * 共享密钥组（规格 2026-09-27 §4.5）：条目声明 secretGroup 时整组共用一条记录，键 teloa-skill-group/<组>，指纹为组指纹；端点载荷仍按技能名。
 * 写只走 modifyRecord（写前 describeRecord().writable）；读只在调用当下 readRecord，不缓存；回包与审计永不含值。
 * 三个端点为浏览器专用（index.ts 与 credential-store/* 同一位置分发），模型工具、IM、CLI 不可达。
 * 存储锁定（CredentialStoreLocked）按既有口径回 teloa/storage-unavailable，不当作「没有凭据」。
 */
export const skillSecretEndpoints=['skill-secrets/describe','skill-secrets/save','skill-secrets/delete'] as const
export type SkillSecretCredentialPort=Pick<CredentialProvider,'readRecord'|'describeRecord'|'modifyRecord'|'deleteRecord'>
export type SkillSecretAuditEvent={event:'skill-secret.save'|'skill-secret.delete';skill:string;envVarNames:string[];group?:string}
/** describe 回包：vars 附带每个变量声明的注入位置与目标地址（目录公开信息，不含值），供设置页如实显示「此密钥将发往何处」。 */
export type SkillSecretsState={skill:string;binding:string|null;writable:boolean;reconfirm:boolean;vars:{envVarName:string;label:MarketCatalogSkillSecret['label'];required:boolean;configured:boolean;target:MarketCatalogSkillSecret['target'];name?:string;endpoints:MarketCatalogSkillSecret['endpoints']}[];group?:{id:string;members:string[]}}

const invalid=(message:string)=>new WorkError('teloa/invalid-input',message)
const readOnly=()=>new WorkError('teloa/dependency-unavailable','密钥存储当前只读，无法保存或删除技能密钥。')
/** 凭据存储调用：锁定按既有 teloa/storage-unavailable 处理；其余原样抛出。 */
async function viaStore<T>(run:()=>Promise<T>):Promise<T>{
 try{return await run()}catch(error){if(isCredentialStoreLocked(error))throw new WorkError('teloa/storage-unavailable','密钥存储已锁定，请到设置页处理后重试');throw error}
}
const skillName=/^[a-z][a-z0-9-]{0,63}$/
const secretValue=/^[\x21-\x7e]{8,4096}$/
export const skillSecretKey=(skill:string)=>credentialKey('teloa-skill',skill)
export const skillSecretGroupKey=(group:string)=>credentialKey('teloa-skill-group',group)
const sha256=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const byName=(a:MarketCatalogSkillSecret,b:MarketCatalogSkillSecret)=>a.envVarName<b.envVarName?-1:1
/** 生效声明的存储指纹：有组用组指纹，否则单技能指纹（含指引）。 */
export const resolvedSkillSecretBinding=(d:ResolvedSkillSecrets)=>d.group?.binding??skillSecretBinding(d.secrets,d.httpGuide)
/**
 * 声明指纹包含全部声明字段（含必填性、展示名称与方法），集合顺序归一；不含密钥值或保存状态。
 * 向后兼容（规格 2026-09-27 §4.4）：allowHeaders 只在声明给出时追加进该项元组，httpGuide 只在给出时追加到末尾——无新字段的声明指纹与旧版逐字节相同。
 */
export const skillSecretBinding=(secrets:readonly MarketCatalogSkillSecret[],httpGuide?:MarketCatalogText)=>{
 const rows:unknown[]=[...secrets].sort(byName).map(s=>[s.envVarName,s.label['zh-CN'],s.label.en,s.required,s.target,s.name??'',[...s.endpoints].sort((a,b)=>a.origin<b.origin?-1:1).map(ep=>[ep.origin,[...ep.pathPrefixes].sort()]),[...s.methods].sort(),...(s.allowHeaders===undefined?[]:[[...s.allowHeaders].sort()])])
 if(httpGuide!==undefined)rows.push(['guide',httpGuide['zh-CN'],httpGuide.en])
 return sha256(rows)
}
/** 目录内同组条目（OfficialCatalogService.skillSecretGroupMembers 同形）。 */
export type SkillSecretGroupMembers={entryId:string;skill:string;secrets:MarketCatalogSkillSecret[];httpGuide?:MarketCatalogText}[]
/**
 * 组指纹（规格 §4.5）：组级字段（变量五元组、origin 集合）+ 各变量在全组的方法并集与附加头并集 + 各条目调用指引（按条目 id 排序）。
 * 不含路径前缀：组密钥的信任边界是 origin，前缀仍在每次调用时按该技能的声明逐条强制。成员来自目录而非安装。
 */
export function skillSecretGroupBinding(members:SkillSecretGroupMembers):string{
 const vars=new Map<string,{secret:MarketCatalogSkillSecret;origins:Set<string>;methods:Set<string>;headers:Set<string>}>()
 for(const member of members)for(const secret of member.secrets){
  const row=vars.get(secret.envVarName)??{secret,origins:new Set<string>(),methods:new Set<string>(),headers:new Set<string>()}
  for(const endpoint of secret.endpoints)row.origins.add(endpoint.origin)
  for(const method of secret.methods)row.methods.add(method)
  for(const header of secret.allowHeaders??[])row.headers.add(normalizedHeaderName(header))
  vars.set(secret.envVarName,row)
 }
 const rows=[...vars.values()].sort((a,b)=>byName(a.secret,b.secret)).map(({secret:s,origins,methods,headers})=>[s.envVarName,s.label['zh-CN'],s.label.en,s.required,s.target,s.name??'',[...origins].sort(),[...methods].sort(),[...headers].sort()])
 const guides=[...members].sort((a,b)=>a.entryId<b.entryId?-1:1).flatMap(m=>m.httpGuide?[[m.entryId,m.httpGuide['zh-CN'],m.httpGuide.en]]:[])
 return sha256(['teloa-skill-group',rows,guides])
}
const exactKeys=(value:unknown,keys:readonly string[],label:string):Record<string,unknown>=>{
 if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid(`${label}只允许 ${keys.join('、')}。`)
 return value
}

/** 生效声明：密钥声明 + 条目调用指引 + 共享密钥组（id、目录内同组技能名、组指纹）。 */
export type ResolvedSkillSecrets={secrets:MarketCatalogSkillSecret[];httpGuide?:MarketCatalogText;group?:{id:string;members:string[];binding:string}}
/** 声明来源：按技能名回该技能当前生效的目录声明（见 declaredSkillSecretsResolver）；无声明回 undefined。 */
export type DeclaredSkillSecrets=(skill:string)=>Promise<ResolvedSkillSecrets|undefined>
type SecretsCatalog={skillEntryIdsByName:(name:string)=>string[];getSkillSecretsByEntry:(entryId:string)=>MarketCatalogSkillSecret[];getSkillSecretMetaByEntry:(entryId:string)=>{httpGuide?:MarketCatalogText;secretGroup?:string};skillSecretGroupMembers:(group:string)=>SkillSecretGroupMembers}
const inconsistentGroup=()=>invalid('该技能的共享密钥说明不一致，请更新目录后重试')
/**
 * 条目 → 生效声明：有组时按目录内全部同组条目复核一致性（快照与上游缓存版本错位即 fail-closed）并计算组指纹。
 * 代发、密钥页、加载提示与安装确认卡（market-session-tools）共用，保证卡片指纹与存储指纹同源。
 */
export function resolveSkillSecretsEntry(catalog:Pick<SecretsCatalog,'getSkillSecretMetaByEntry'|'skillSecretGroupMembers'>,entryId:string,secrets:MarketCatalogSkillSecret[]):ResolvedSkillSecrets{
 const meta=catalog.getSkillSecretMetaByEntry(entryId)
 const resolved:ResolvedSkillSecrets={secrets,...(meta.httpGuide?{httpGuide:meta.httpGuide}:{})}
 const group=meta.secretGroup
 if(group===undefined)return resolved
 const members=catalog.skillSecretGroupMembers(group)
 if(!members.some(member=>member.entryId===entryId))throw inconsistentGroup()
 try{assertSecretGroupsConsistent(members.map(member=>({id:member.entryId,secretGroup:group,secrets:member.secrets})))}catch{throw inconsistentGroup()}
 return {...resolved,group:{id:group,members:[...new Set(members.map(member=>member.skill))].sort(),binding:skillSecretGroupBinding(members)}}
}
/** 安装绑定三态（与 @teloa/backend InstalledSkillBinding 同形）。 */
export type SkillBinding={installed:false}|{installed:true;entryId?:string}
/**
 * 运行时解析来源（Task 4 复审 L-6）：同名技能里真正胜出的必须就是受管选定安装本身（provider teloa-market 且 SKILL.md 路径一致）。
 * 项目级 .agents/skills、.dsh/skills、用户级或插件同名技能遮蔽受管安装时为 false——模型加载的是未审内容，不得按目录声明注入。
 */
export const isManagedSkillWinner=(skill:{provider:string;path?:string|null|undefined}|undefined,managedPath:string)=>skill?.provider==='teloa-market'&&typeof skill.path==='string'&&skill.path===managedPath
/**
 * 技能名 → 生效声明（审查 R1 M-1 / R2 N-1）：一律看安装绑定，同名单条目也不例外——绑定到目录条目即用该条目声明；
 * 绑定到 GitHub/上传/行业等非目录来源、未安装或不确定（绑定条目不在同名集合内）一律无声明，不注入任何目录密钥（fail-closed）。
 * 三态绑定之外再核对运行时解析来源（active，L-6）：胜出者不是受管选定安装（被同名技能遮蔽）同样无声明。
 * 确认卡按被添加条目 id 走同一 getSkillSecretsByEntry；GitHub 候选无声明，与其安装后的注入结果一致。
 */
export function declaredSkillSecretsResolver(catalog:SecretsCatalog,binding:(skill:string)=>Promise<SkillBinding>,active:(skill:string)=>Promise<boolean>,stable:<T>(operation:()=>Promise<T>)=>Promise<T>):DeclaredSkillSecrets{
 // 复用安装维护队列：来源绑定与胜出者必须属于同一次选定状态，不能在两次读取之间切源。
 return skill=>stable(async()=>{
  const ids=catalog.skillEntryIdsByName(skill)
  if(ids.length===0)return undefined
  const bound=await binding(skill)
  if(!bound.installed||bound.entryId===undefined||!ids.includes(bound.entryId))return undefined
  if(!(await active(skill)))return undefined
  const secrets=catalog.getSkillSecretsByEntry(bound.entryId)
  return secrets.length?resolveSkillSecretsEntry(catalog,bound.entryId,secrets):undefined
 })
}

export function createSkillSecretStore(credentials:SkillSecretCredentialPort,declared:DeclaredSkillSecrets,audit:(event:SkillSecretAuditEvent)=>void){
 const nameOf=(skill:unknown):string=>{if(typeof skill!=='string'||!skillName.test(skill))throw invalid('技能名格式不正确。');return skill}
 const resolved=async(skill:string)=>{const d=await declared(skill);return d?.secrets.length?d:undefined}
 /** 有组时键与指纹都用组的；未分组仍按技能名。 */
 const keyOf=(skill:string,d:ResolvedSkillSecrets)=>d.group?skillSecretGroupKey(d.group.id):skillSecretKey(skill)
 const bindingOf=resolvedSkillSecretBinding
 const groupField=(d:ResolvedSkillSecrets)=>d.group?{group:d.group.id}:{}
 async function declaredOf(skill:unknown):Promise<{skill:string;d:ResolvedSkillSecrets}>{
  const name=nameOf(skill),d=await resolved(name)
  if(!d)throw invalid('该技能没有写明需要密钥。')
  return {skill:name,d}
 }
 async function storedEnv(key:ReturnType<typeof skillSecretKey>):Promise<Record<string,string>>{
  const record=await viaStore(()=>credentials.readRecord(key))
  return record?.kind==='api-key'&&record.env?{...record.env}:{}
 }
 const isStale=(env:Record<string,string>,binding:string)=>Object.keys(env).some(k=>k!==skillSecretBindingSlot)&&env[skillSecretBindingSlot]!==binding
 /** 当前生效的不是声明密钥的目录安装（未安装、非目录来源、被同名技能遮蔽）时回 vars:[]，界面显示「需先安装」；不读记录。 */
 async function describe(skill:unknown):Promise<SkillSecretsState>{
  const name=nameOf(skill),d=await resolved(name),info=await viaStore(()=>credentials.describeRecord(d?keyOf(name,d):skillSecretKey(name)))
  if(!d)return {skill:name,binding:null,writable:info.writable,reconfirm:false,vars:[]}
  const env=info.configured?await storedEnv(keyOf(name,d)):{},binding=bindingOf(d)
  return {skill:name,binding,writable:info.writable,reconfirm:isStale(env,binding),vars:d.secrets.map(s=>({envVarName:s.envVarName,label:s.label,required:s.required,configured:typeof env[s.envVarName]==='string'&&env[s.envVarName]!.length>0,target:s.target,...(s.name===undefined?{}:{name:s.name}),endpoints:structuredClone(s.endpoints)})),...(d.group?{group:{id:d.group.id,members:[...d.group.members]}}:{})}
 }
 async function save(payload:unknown):Promise<SkillSecretsState>{
  const row=exactKeys(payload,['skill','values','expectedBinding'],'保存密钥参数'),name=nameOf(row.skill)
  if(typeof row.expectedBinding!=='string'||!/^[a-f0-9]{64}$/.test(row.expectedBinding))throw invalid('缺少有效的技能密钥说明校验值，请重新打开密钥页。')
  const conflict=()=>new WorkError('teloa/version-conflict','技能的密钥说明已变化，请核对新目标后重新填写并保存。')
  const confirmedDeclaration=async()=>{
   const d=await resolved(name)
   if(!d||bindingOf(d)!==row.expectedBinding)throw conflict()
   return d
  }
  const d=await confirmedDeclaration()
  if(!isRecord(row.values)||!Object.keys(row.values).length)throw invalid('至少填写一项密钥。')
  const names=new Set(d.secrets.map(s=>s.envVarName)),values:Record<string,string>={}
  for(const [name,value] of Object.entries(row.values)){
   if(!names.has(name))throw invalid(`变量 ${name} 未在技能说明中写明。`)
   if(typeof value!=='string'||!secretValue.test(value))throw invalid('密钥须为 8 到 4096 个可见字符，不含空白。')
   values[name]=value
  }
  const key=keyOf(name,d)
  if(!(await viaStore(()=>credentials.describeRecord(key))).writable)throw readOnly()
  const binding=bindingOf(d)
  await viaStore(()=>credentials.modifyRecord(key,async current=>{
   // 凭据提供方可能排队等待文件锁；进入实际修改回调时再次核对（含组指纹与存储键），过期请求不得写入。
   if(keyOf(name,await confirmedDeclaration())!==key)throw conflict()
   const prior=current?.kind==='api-key'&&current.env?current.env:{}
   // 旧值只在记录指纹与当前声明一致时沿用；声明（目标）已变则全部作废，只写本次提交的变量，其余变量须本人逐个重新保存。
   const kept=prior[skillSecretBindingSlot]===binding?prior:{}
   const env=Object.fromEntries(Object.entries({...kept,...values}).filter(([name])=>names.has(name)))
   return {kind:'api-key',env:{...env,[skillSecretBindingSlot]:binding}}
  }))
  audit({event:'skill-secret.save',skill:name,envVarNames:Object.keys(values),...groupField(d)})
  return describe(name)
 }
 /** 有组时删除作用于整组记录（页内确认框列出受影响技能）。 */
 async function remove(payload:unknown):Promise<SkillSecretsState>{
  const row=exactKeys(payload,['skill'],'删除密钥参数'),{skill,d}=await declaredOf(row.skill),key=keyOf(skill,d)
  if(!(await viaStore(()=>credentials.describeRecord(key))).writable)throw readOnly()
  await viaStore(()=>credentials.deleteRecord(key))
  audit({event:'skill-secret.delete',skill,envVarNames:d.secrets.map(s=>s.envVarName),...groupField(d)})
  return describe(skill)
 }
 async function readForUse(skill:string):Promise<{secrets:MarketCatalogSkillSecret[];values:Record<string,string>;stale:boolean;group?:string}>{
  const {skill:name,d}=await declaredOf(skill),env=await storedEnv(keyOf(name,d)),values:Record<string,string>={}
  for(const s of d.secrets){const value=env[s.envVarName];if(typeof value==='string'&&value)values[s.envVarName]=value}
  return {secrets:d.secrets,values,stale:isStale(env,bindingOf(d)),...groupField(d)}
 }
 async function handle(endpoint:string,payload:unknown):Promise<unknown>{
  if(endpoint==='skill-secrets/describe')return describe(exactKeys(payload,['skill'],'查询密钥参数').skill)
  if(endpoint==='skill-secrets/save')return save(payload)
  if(endpoint==='skill-secrets/delete')return remove(payload)
  throw new WorkError('teloa/not-found','未提供此技能密钥接口。')
 }
 return {describe,save,remove,readForUse,handle}
}
