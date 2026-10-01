import {readRunSkills,type RunSkill} from '@teloa/backend'
import {createHash} from 'node:crypto'
import {basename,dirname,join} from 'node:path'
import type {SkillDefinition} from '@deepseek-ai/dsh-skill'
import type {ManagedRunSkill,NativeSkillMetadata,SkillInstallation,SkillInstallSourceBundle,SkillInstallSourceInput,TaskRunSkillDatabase} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import type {ManagedSkillFiles} from './managed-skill-files.ts'
import {FileSystemSkillProvider} from '@deepseek-ai/dsh-skill-filesystem'
import type {Agent} from '@deepseek-ai/dsh-agent'

export type ManagedRunSkillResolver=(skill:SkillDefinition,signal:AbortSignal,database?:TaskRunSkillDatabase)=>Promise<ManagedRunSkill|undefined>
export type ManagedRunSkillPorts={
 managedFiles:Pick<ManagedSkillFiles,'root'|'path'|'verify'>
 getInstallation:(installationId:string,database?:TaskRunSkillDatabase)=>Promise<SkillInstallation>
 readSource:(source:SkillInstallSourceInput,database?:TaskRunSkillDatabase)=>Promise<SkillInstallSourceBundle>
}

const uuid=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const stable=(value:unknown):string=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)
const corrupt=()=>new WorkError('teloa/storage-corrupt','受管技能执行身份或完整文件快照不一致。')
const sourceInput=(installation:SkillInstallation):SkillInstallSourceInput=>installation.source.kind==='atomic'
 ?{kind:'atomic',contentId:installation.source.contentId}
 :{kind:'industry',loadId:installation.source.loadId,itemInstanceId:installation.source.itemInstanceId}
const nativeOf=(skill:SkillDefinition):NativeSkillMetadata=>({
 name:skill.name,
 description:skill.description,
 modelInvocable:skill.invocation.modelInvocable,
 userInvocable:skill.invocation.userInvocable,
 bodyHash:createHash('sha256').update(skill.content).digest('hex'),
})

/** 仅在真实获胜 Skill 精确来自受管根时固定安装；路径从宿主根反推，不接受 UI 输入。 */
export function createManagedRunSkillResolver(owner:string,ports:ManagedRunSkillPorts):ManagedRunSkillResolver{
 return async(skill,signal,database)=>{
  signal.throwIfAborted()
  if(skill.provider!=='teloa-market')return undefined
  const base=skill.resourceBase
  if(skill.source!=='custom'||typeof skill.path!=='string'||base?.kind!=='directory'||dirname(base.path)!==ports.managedFiles.root)throw corrupt()
  const installationId=basename(base.path).toLowerCase()
  if(!uuid(installationId)||skill.path!==join(base.path,'SKILL.md')||skill.path!==ports.managedFiles.path(installationId))throw corrupt()
  const installation=await ports.getInstallation(installationId,database)
  signal.throwIfAborted()
  if(installation.id!==installationId||installation.ownerId!==owner||installation.state!=='installed'||stable(installation.native)!==stable(nativeOf(skill)))throw corrupt()
  const bundle=await ports.readSource(sourceInput(installation),database)
  signal.throwIfAborted()
  if(bundle.ownerId!==owner||bundle.entryPath!=='SKILL.md'||bundle.bundleHash!==installation.bundleHash||stable(bundle.source)!==stable(installation.source))throw corrupt()
  await ports.managedFiles.verify(installationId,bundle,installation.native)
  signal.throwIfAborted()
  const files=bundle.files.map(file=>({path:file.path,hash:file.hash,size:file.bytes.byteLength})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
  return {installationId,bundleHash:bundle.bundleHash,files}
 }
}

/** 已固定执行按安装身份核验；不重新解析全局同名赢家，也不因后续停用改写历史能力。 */
export function createManagedRunSkillVerifier(owner:string,ports:ManagedRunSkillPorts){return async(value:RunSkill,signal:AbortSignal):Promise<NativeSkillMetadata>=>{
 signal.throwIfAborted()
 const skill=readRunSkills([value])[0]!,managed=skill.managed,base=skill.resourceBase
 if(!managed||skill.provider!=='teloa-market'||skill.source!=='custom'||base?.kind!=='directory'||base.path!==join(ports.managedFiles.root,managed.installationId))throw corrupt()
 const installation=await ports.getInstallation(managed.installationId)
 signal.throwIfAborted()
 if(installation.id!==managed.installationId||installation.ownerId!==owner||installation.state!=='installed'||installation.bundleHash!==managed.bundleHash||installation.native.name!==skill.name||installation.native.description!==skill.description||installation.native.bodyHash!==skill.sha256)throw corrupt()
 const bundle=await ports.readSource(sourceInput(installation))
 signal.throwIfAborted()
 if(bundle.ownerId!==owner||bundle.entryPath!=='SKILL.md'||bundle.bundleHash!==managed.bundleHash||stable(bundle.source)!==stable(installation.source))throw corrupt()
 const files=bundle.files.map(file=>({path:file.path,hash:file.hash,size:file.bytes.byteLength})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
 if(stable(files)!==stable(managed.files))throw corrupt()
 await ports.managedFiles.verify(installation.id,bundle,installation.native)
 signal.throwIfAborted()
 return {...installation.native}
}}

/** 按安装身份读取原生定义，不经过全局同名选择；用于行业任务准备和固定运行复核。 */
export async function resolveManagedRunSkillsByInstallation(owner:string,agent:Pick<Agent,'ctx'|'session'>,installationIds:readonly string[],signal:AbortSignal,ports:ManagedRunSkillPorts,database?:TaskRunSkillDatabase):Promise<RunSkill[]>{
 signal.throwIfAborted()
 if(!Array.isArray(installationIds)||installationIds.length>30||new Set(installationIds).size!==installationIds.length||installationIds.some(id=>!uuid(id)))throw corrupt()
 if(!installationIds.length)return []
 const entries=[]
 for(const installationId of installationIds){
  signal.throwIfAborted()
  const installation=await ports.getInstallation(installationId,database)
  if(installation.id!==installationId||installation.ownerId!==owner||installation.state!=='installed')throw corrupt()
  const bundle=await ports.readSource(sourceInput(installation),database)
  signal.throwIfAborted()
  if(bundle.ownerId!==owner||bundle.entryPath!=='SKILL.md'||bundle.bundleHash!==installation.bundleHash||stable(bundle.source)!==stable(installation.source))throw corrupt()
  await ports.managedFiles.verify(installation.id,bundle,installation.native)
  const directory=join(ports.managedFiles.root,installation.id),path=ports.managedFiles.path(installation.id)
  entries.push({installation,bundle,directory,path})
 }
 const controller=new AbortController(),provider=new FileSystemSkillProvider(agent.ctx,{signal:controller.signal,invalidate:()=>{}},{providerName:'teloa-market',includeDefaultRoots:false,customSkillDirs:entries.map(entry=>entry.directory),watch:false,watchFollowSymlinks:false})
 try{
  const lookup={cwd:agent.session.header.cwd,scope:agent,signal},output=await provider.list(lookup),candidates=Array.isArray(output)?output:output.candidates
  if(!Array.isArray(output)&&!output.complete)throw corrupt()
  const resolved=[]
  for(const entry of entries){
   signal.throwIfAborted()
   const matches=candidates.filter(candidate=>candidate.path===entry.path&&candidate.resourceBase?.kind==='directory'&&candidate.resourceBase.path===entry.directory),candidate=matches[0]
   if(matches.length!==1||!candidate||candidate.provider!=='teloa-market'||candidate.source!=='custom')throw corrupt()
   const skill=await provider.get(candidate,lookup),native=entry.installation.native
   if(!skill||skill.name!==native.name||skill.description!==native.description||skill.provider!=='teloa-market'||skill.source!=='custom'||skill.path!==entry.path||skill.resourceBase?.kind!=='directory'||skill.resourceBase.path!==entry.directory||skill.invocation.modelInvocable!==native.modelInvocable||skill.invocation.userInvocable!==native.userInvocable||createHash('sha256').update(skill.content).digest('hex')!==native.bodyHash)throw corrupt()
   const files=entry.bundle.files.map(file=>({path:file.path,hash:file.hash,size:file.bytes.byteLength})).sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0)
   resolved.push({name:skill.name,provider:skill.provider,source:skill.source,description:skill.description,content:skill.content,sha256:native.bodyHash,resourceBase:{kind:'directory' as const,path:entry.directory},managed:{installationId:entry.installation.id,bundleHash:entry.installation.bundleHash,files}})
  }
  return readRunSkills(resolved)
 }finally{controller.abort();await provider.dispose()}
}
