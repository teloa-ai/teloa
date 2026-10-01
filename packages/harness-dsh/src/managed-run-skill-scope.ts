import {createHash} from 'node:crypto'
import {isAbsolute,join,resolve} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {Agent} from '@deepseek-ai/dsh-agent'
import {isSkillName,type SkillCandidate,type SkillDefinition,type SkillProvider,type SkillProviderControl,type SkillViewOptions} from '@deepseek-ai/dsh-skill'
import {FileSystemSkillProvider} from '@deepseek-ai/dsh-skill-filesystem'
import {readRunSkills,type NativeSkillMetadata,type RunSkill,type TaskRun} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import {resolveSessionLineage} from './subagent-lineage.ts'

export type ManagedRunSkillScopeBinding=Pick<TaskRun,'id'|'sessionId'|'skills'>
export type ManagedRunSkillScopeVerifier=(skill:RunSkill,signal:AbortSignal)=>Promise<NativeSkillMetadata>
export type ManagedRunSkillScopeAgent=Pick<Agent,'ctx'|'session'>
export type ManagedRunSkillScopeOptions={managedRoot:string;verify:ManagedRunSkillScopeVerifier}

type Entry={skill:RunSkill;directory:string;path:string;native?:NativeSkillMetadata;candidate?:SkillCandidate}
type Binding={
 agent:ManagedRunSkillScopeAgent
 runId:string
 sessionId:string
 digest:string
 entries:Entry[]
 state:'loading'|'ready'|'failed'|'closing'
 generation:number
 control:SkillProviderControl
 provider:FileSystemSkillProvider
 unregister:()=>void
 lifecycle:AbortController
 operations:Set<Promise<unknown>>
 loading:Promise<void>|null
 closing:Promise<void>|null
}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hex=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
const unavailable=()=>new WorkError('teloa/host-unavailable','执行技能作用域当前不可用。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','固定执行技能与原生目录不一致。')
const conflict=()=>new WorkError('teloa/conflict','该执行会话已固定到其他执行或技能快照。')
const absolute=(path:string)=>{if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))throw corrupt();return resolve(path)}
const fixed=(value:unknown)=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item)
const sameNative=(left:NativeSkillMetadata,right:NativeSkillMetadata)=>left.name===right.name&&left.description===right.description&&left.modelInvocable===right.modelInvocable&&left.userInvocable===right.userInvocable&&left.bodyHash===right.bodyHash
const validNative=(value:NativeSkillMetadata,entry:Entry)=>isSkillName(value.name)&&value.name===entry.skill.name&&typeof value.description==='string'&&!!value.description&&value.description===entry.skill.description&&typeof value.modelInvocable==='boolean'&&typeof value.userInvocable==='boolean'&&hex(value.bodyHash)&&value.bodyHash===entry.skill.sha256
const expectedCandidate=(candidate:SkillCandidate,entry:Entry,native:NativeSkillMetadata)=>candidate.name===entry.skill.name&&candidate.description===native.description&&candidate.invocation.modelInvocable===native.modelInvocable&&candidate.invocation.userInvocable===native.userInvocable&&candidate.provider==='teloa-market'&&candidate.source==='custom'&&candidate.path===entry.path&&candidate.resourceBase?.kind==='directory'&&candidate.resourceBase.path===entry.directory
const expectedDefinition=(skill:SkillDefinition,entry:Entry,native:NativeSkillMetadata)=>skill.name===entry.skill.name&&skill.description===native.description&&skill.invocation.modelInvocable===native.modelInvocable&&skill.invocation.userInvocable===native.userInvocable&&skill.provider==='teloa-market'&&skill.source==='custom'&&skill.path===entry.path&&skill.resourceBase?.kind==='directory'&&skill.resourceBase.path===entry.directory&&skill.content===entry.skill.content&&sha(skill.content)===entry.skill.sha256

/**
 * 为一个受管执行会话在原生 SkillRegistry 的 agent 层固定安装。
 * 全局选择与后续启停不会改写已经固定的执行；失败项继续用同名 tombstone 阻断回退。
 */
export function createManagedRunSkillScope(ctx:Context,options:ManagedRunSkillScopeOptions){
 const root=absolute(options.managedRoot)
 if(typeof options.verify!=='function'||!ctx.get('skills'))throw unavailable()
 const byAgent=new WeakMap<object,Binding>(),active=new Set<Binding>()
 let closing=false,disposal:Promise<void>|undefined

 const tombstone=(entry:Entry,locators:WeakMap<SkillCandidate,{entry:Entry;candidate:SkillCandidate|null;generation:number}>):SkillCandidate=>{
  const candidate:SkillCandidate={name:entry.skill.name,description:entry.skill.description||'固定执行技能当前不可用。',invocation:{modelInvocable:false,userInvocable:false},source:'custom',provider:'teloa-market',resourceBase:{kind:'directory',path:entry.directory},rank:300,locator:entry.skill.managed!.installationId,path:entry.path}
  locators.set(candidate,{entry,candidate:null,generation:0});return candidate
 }
 const track=<T>(binding:Binding,operation:Promise<T>):Promise<T>=>{
  binding.operations.add(operation)
  void operation.then(()=>{binding.operations.delete(operation)},()=>{binding.operations.delete(operation)})
  return operation
 }
 const fail=(binding:Binding)=>{
  if(binding.state==='closing')return
  binding.state='failed';binding.generation++;binding.control.invalidate()
 }
 const close=(binding:Binding):Promise<void>=>{
  binding.closing??=Promise.resolve().then(async()=>{
   if(binding.state!=='closing'){
    binding.state='closing';binding.generation++
    binding.lifecycle.abort(unavailable())
    binding.unregister()
   }else if(!binding.lifecycle.signal.aborted)binding.lifecycle.abort(unavailable())
   await Promise.allSettled([...binding.operations])
   byAgent.delete(binding.agent);active.delete(binding)
   await binding.provider.dispose()
  })
  return binding.closing
 }
 const create=(agent:ManagedRunSkillScopeAgent,run:ManagedRunSkillScopeBinding,skills:RunSkill[],digest:string):Binding=>{
  const registry=agent.ctx.get('skills')
  if(!registry)throw unavailable()
  const entries=skills.filter(skill=>skill.provider==='teloa-market').map(skill=>{
   const managed=skill.managed,base=skill.resourceBase
   if(!managed||skill.source!=='custom'||base?.kind!=='directory')throw corrupt()
   const directory=join(root,managed.installationId),path=join(directory,'SKILL.md')
   if(base.path!==directory)throw corrupt()
   return {skill,directory,path}
  })
  let binding!:Binding,provider!:FileSystemSkillProvider,control!:SkillProviderControl
  const locators=new WeakMap<SkillCandidate,{entry:Entry;candidate:SkillCandidate|null;generation:number}>()
  const wrapped:SkillProvider={
   name:'teloa-market',
   list:async()=>{
    if(binding.state!=='ready')return {candidates:binding.entries.map(entry=>tombstone(entry,locators)),complete:false}
    const generation=binding.generation
    return binding.entries.map(entry=>{
     const candidate={...entry.candidate!}
     locators.set(candidate,{entry,candidate:entry.candidate!,generation})
     return candidate
    })
   },
   get(candidate,lookup){
    const locator=locators.get(candidate)
    if(!locator?.candidate||binding.state!=='ready'||locator.generation!==binding.generation)return Promise.resolve(undefined)
    const generation=binding.generation,entry=locator.entry,native=entry.native!
    const operation=(async()=>{
     try{
      const signal=lookup.signal?AbortSignal.any([lookup.signal,binding.lifecycle.signal]):binding.lifecycle.signal
      const scopedLookup:SkillViewOptions={...lookup,signal}
      const verified=await options.verify(entry.skill,signal)
      if(binding.state!=='ready'||generation!==binding.generation)return undefined
      if(!sameNative(verified,native)){fail(binding);return undefined}
      const skill=await provider.get(locator.candidate!,scopedLookup)
      if(binding.state!=='ready'||generation!==binding.generation)return undefined
      if(!skill||!expectedDefinition(skill,entry,native)){fail(binding);return undefined}
      return skill
     }catch(error){
      lookup.signal?.throwIfAborted()
      if(binding.state==='closing'||binding.control.signal.aborted||binding.lifecycle.signal.aborted)return undefined
      fail(binding);return undefined
     }
    })()
    return track(binding,operation)
   },
  }
  const unregister=registry.registerProvider(providerControl=>{
   control=providerControl
   provider=new FileSystemSkillProvider(agent.ctx,providerControl,{providerName:'teloa-market',includeDefaultRoots:false,customSkillDirs:entries.map(entry=>entry.directory),watch:false,watchFollowSymlinks:false})
   return wrapped
  })
  binding={agent,runId:run.id,sessionId:run.sessionId,digest,entries,state:'loading',generation:1,control,provider,unregister,lifecycle:new AbortController(),operations:new Set(),loading:null,closing:null}
  control.signal.addEventListener('abort',()=>{
   void close(binding)
  },{once:true})
  byAgent.set(agent,binding);active.add(binding)
  return binding
 }
 const load=async(binding:Binding,signal:AbortSignal)=>{
  signal.throwIfAborted()
  if(!binding.entries.length){if(binding.state==='closing'||closing)throw unavailable();binding.state='ready';binding.generation++;binding.control.invalidate();return}
  const lookup:SkillViewOptions={cwd:binding.agent.session.header.cwd,scope:binding.agent,signal}
  const output=await binding.provider.list(lookup),candidates=Array.isArray(output)?output:output.candidates
  const resolved:Entry[]=[]
  for(const entry of binding.entries){
   signal.throwIfAborted()
   const native=await options.verify(entry.skill,signal)
   if(!validNative(native,entry))throw corrupt()
   const matches=candidates.filter(candidate=>candidate.path===entry.path&&candidate.resourceBase?.kind==='directory'&&candidate.resourceBase.path===entry.directory),candidate=matches[0]
   if(matches.length!==1||!candidate||!expectedCandidate(candidate,entry,native))throw corrupt()
   const definition=await binding.provider.get(candidate,lookup)
   signal.throwIfAborted()
   if(!definition||!expectedDefinition(definition,entry,native))throw corrupt()
   resolved.push({...entry,native:{...native},candidate})
  }
  if(binding.state==='closing'||closing)throw unavailable()
  binding.entries=resolved;binding.state='ready';binding.generation++;binding.control.invalidate()
 }
 const reverify=async(binding:Binding,signal:AbortSignal)=>{
  for(const entry of binding.entries){
   signal.throwIfAborted()
   const native=await options.verify(entry.skill,signal)
   if(!entry.native||!validNative(native,entry)||!sameNative(native,entry.native))throw corrupt()
  }
  if(binding.state==='closing'||closing)throw unavailable()
  binding.state='ready';binding.generation++;binding.control.invalidate()
 }
 const callerWait=<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>=>{
  signal.throwIfAborted()
  return new Promise<T>((resolve,reject)=>{
   const abort=()=>reject(signal.reason instanceof Error?signal.reason:new Error('operation aborted'))
   signal.addEventListener('abort',abort,{once:true})
   void operation.then(value=>{signal.removeEventListener('abort',abort);resolve(value)},error=>{signal.removeEventListener('abort',abort);reject(error)})
  })
 }
 const ensure=async(agent:ManagedRunSkillScopeAgent,run:ManagedRunSkillScopeBinding,signal:AbortSignal)=>{
  signal.throwIfAborted()
  if(closing||!agent||typeof agent!=='object'||!agent.ctx||!agent.session||!uuid(run.id)||typeof run.sessionId!=='string'||!run.sessionId)throw unavailable()
  // 绑定装在实际调用方的 scope，但固定快照归属于根 Run；只比较子会话 id 会把合法继承全部拒绝。
  // 这里独立核对谱系，避免绕过 pre-step 直接 ensure 时把别的 Run 快照装进当前会话。
  let sessionId:string
  try{sessionId=resolveSessionLineage(ctx,agent.session).root.id}catch{throw new WorkError('teloa/forbidden','无法核对执行技能作用域的会话归属。')}
  if(sessionId!==run.sessionId)throw new WorkError('teloa/forbidden','执行技能作用域会话身份不一致。')
  const skills=readRunSkills(run.skills),digest=fixed(skills)
  let binding=byAgent.get(agent)
  if(binding&&(binding.runId!==run.id||binding.sessionId!==run.sessionId||binding.digest!==digest))throw conflict()
  binding??=create(agent,run,skills,digest)
  if(binding.state==='closing')throw unavailable()
  if(!binding.loading){
   const current=binding
   const wasReady=current.state==='ready'
   current.state='loading'
   current.generation++;current.control.invalidate()
   const operation=(wasReady?reverify(current,current.lifecycle.signal):load(current,current.lifecycle.signal)).catch(error=>{fail(current);throw error})
   current.loading=track(current,operation)
   void current.loading.then(()=>{current.loading=null},()=>{current.loading=null})
  }
  const loading=binding.loading
  if(!loading)throw unavailable()
  await callerWait(loading,signal)
 }
 const dispose=()=>{
  if(!disposal){closing=true;disposal=Promise.all([...active].map(close)).then(()=>{})}
  return disposal
 }
 ctx.effect(()=>dispose,'Teloa 固定执行技能作用域')
 return {ensure,dispose}
}
