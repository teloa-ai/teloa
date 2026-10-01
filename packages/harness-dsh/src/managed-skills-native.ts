import {createHash} from 'node:crypto'
import {dirname,isAbsolute,join,resolve} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import {isSkillName,type SkillCandidate,type SkillDefinition,type SkillProvider,type SkillProviderControl,type SkillResourceBase,type SkillViewOptions} from '@deepseek-ai/dsh-skill'
import {FileSystemSkillProvider} from '@deepseek-ai/dsh-skill-filesystem'
import {WorkError} from '@teloa/contract'

export type NativeSkillIdentity={name:string;description:string;modelInvocable:boolean;userInvocable:boolean;bodyHash:string}
export type ManagedSkillAvailabilitySnapshot=readonly {
  installationId:string
  installationState:'preparing'|'installed'
  installationVersion:number
  availability:'enabled'|'disabled'
  availabilityVersion:number
  selectionVersion?:number
  native:NativeSkillIdentity
}[]
export type NativeSkillObservation={
  state:'available'|'shadowed'|'missing'|'disabled'
  reason?:'different-source'|'content-changed'
  current:(NativeSkillIdentity&{provider:string;source:string;path:string|null;resourceBase:SkillResourceBase|null})|null
}
export type ExpectedNativeSkill={path:string;bodyHash:string;modelInvocable:boolean;userInvocable:boolean}
const invalid=()=>new WorkError('teloa/invalid-input','技能入口缺失、格式无效或实际目录身份不一致。')
const unavailable=()=>new WorkError('teloa/host-unavailable','原生技能目录暂不可完整核对，请重试。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','受管技能可用状态快照损坏或发生版本倒退。')
const absolute=(path:string)=>{if(typeof path!=='string'||!isAbsolute(path)||path.includes('\0'))throw invalid();return resolve(path)}
const identity=(skill:SkillDefinition):NativeSkillIdentity=>({name:skill.name,description:skill.description,modelInvocable:skill.invocation.modelInvocable,userInvocable:skill.invocation.userInvocable,bodyHash:createHash('sha256').update(skill.content).digest('hex')})
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
const version=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const sameNative=(left:NativeSkillIdentity,right:NativeSkillIdentity)=>left.name===right.name&&left.description===right.description&&left.modelInvocable===right.modelInvocable&&left.userInvocable===right.userInvocable&&left.bodyHash===right.bodyHash
type SnapshotItem=ManagedSkillAvailabilitySnapshot[number]
type FixedSnapshotItem=SnapshotItem&{selectionVersion:number;path:string;directory:string}
const cloneSnapshot=(root:string,snapshot:ManagedSkillAvailabilitySnapshot)=>{
  if(!Array.isArray(snapshot))throw corrupt()
  const byId=new Map<string,FixedSnapshotItem>(),names=new Set<string>()
  for(const item of snapshot){
    const native=item?.native
    if(!item||typeof item!=='object'||!uuid(item.installationId)||!['preparing','installed'].includes(item.installationState)||!version(item.installationVersion)||!['enabled','disabled'].includes(item.availability)||!version(item.availabilityVersion)||(item.selectionVersion!==undefined&&!version(item.selectionVersion))||!native||!isSkillName(native.name)||typeof native.description!=='string'||!native.description||typeof native.modelInvocable!=='boolean'||typeof native.userInvocable!=='boolean'||typeof native.bodyHash!=='string'||!/^[a-f0-9]{64}$/.test(native.bodyHash)||byId.has(item.installationId)||names.has(native.name))throw corrupt()
    const directory=join(root,item.installationId),path=join(directory,'SKILL.md')
    byId.set(item.installationId,{installationId:item.installationId,installationState:item.installationState,installationVersion:item.installationVersion,availability:item.availability,availabilityVersion:item.availabilityVersion,selectionVersion:item.selectionVersion??1,native:{...native},directory,path})
    names.add(native.name)
  }
  return byId
}
const assertForwardSnapshot=(current:ReadonlyMap<string,FixedSnapshotItem>,next:ReadonlyMap<string,FixedSnapshotItem>)=>{
  const byName=new Map([...next.values()].map(item=>[item.native.name,item]))
  for(const before of current.values()){
    const after=byName.get(before.native.name)
    if(!after||after.selectionVersion<before.selectionVersion)throw corrupt()
    if(after.installationId!==before.installationId){if(after.selectionVersion===before.selectionVersion||after.installationState!=='installed')throw corrupt();continue}
    if(!sameNative(before.native,after.native)||after.installationVersion<before.installationVersion||after.availabilityVersion<before.availabilityVersion||(after.installationVersion===before.installationVersion&&after.installationState!==before.installationState)||(after.availabilityVersion===before.availabilityVersion&&after.availability!==before.availability)||(before.installationState==='installed'&&after.installationState!=='installed'))throw corrupt()
  }
}
const expectedCandidate=(candidate:SkillCandidate,item:FixedSnapshotItem)=>candidate.name===item.native.name&&candidate.description===item.native.description&&candidate.invocation.modelInvocable===item.native.modelInvocable&&candidate.invocation.userInvocable===item.native.userInvocable&&candidate.provider==='teloa-market'&&candidate.source==='custom'&&candidate.path===item.path&&candidate.resourceBase?.kind==='directory'&&candidate.resourceBase.path===item.directory
const expectedDefinition=(skill:SkillDefinition,item:FixedSnapshotItem)=>skill.provider==='teloa-market'&&skill.source==='custom'&&skill.path===item.path&&skill.resourceBase?.kind==='directory'&&skill.resourceBase.path===item.directory&&sameNative(identity(skill),item.native)

/** 只借用原生文件解析器；不注册临时内容，也不绕过上下文已有的 ctx.fs。 */
export async function inspectNativeSkillDirectory(ctx:Context,absoluteDirectory:string):Promise<NativeSkillIdentity>{
  const directory=absolute(absoluteDirectory),path=join(directory,'SKILL.md'),controller=new AbortController()
  const provider=new FileSystemSkillProvider(ctx,{signal:controller.signal,invalidate:()=>{}},{providerName:'teloa-market-inspect',includeDefaultRoots:false,customSkillDirs:[dirname(directory)],watch:false,watchFollowSymlinks:false})
  try{
    const observation=await provider.list({})
    if(!Array.isArray(observation)&&!observation.complete)throw unavailable()
    const candidates=Array.isArray(observation)?observation:observation.candidates
    const matches=candidates.filter(candidate=>candidate.path===path&&candidate.resourceBase?.kind==='directory'&&candidate.resourceBase.path===directory)
    if(matches.length!==1)throw invalid()
    const candidate=matches[0]!,skill=await provider.get(candidate,{})
    if(!skill||skill.name!==candidate.name||skill.path!==path||skill.resourceBase?.kind!=='directory'||skill.resourceBase.path!==directory||skill.provider!=='teloa-market-inspect')throw invalid()
    return identity(skill)
  }finally{controller.abort();await provider.dispose()}
}

/** 在既有注册表增加受管来源；不新增注册表、工具或 preset，不代替任何执行授权。 */
export function registerManagedSkills(ctx:Context,managedRoot:string,options?:{initial:ManagedSkillAvailabilitySnapshot;verifyUsable?:(installationId:string)=>Promise<void>}){
  const root=absolute(managedRoot),registry=ctx.get('skills')
  if(!registry)throw unavailable()
  let authoritative=options?cloneSnapshot(root,options.initial):undefined
  let provider!:FileSystemSkillProvider,control!:SkillProviderControl,closing=false,refreshing=false,generation=0,disposal:Promise<void>|undefined
  const locators=new WeakMap<SkillCandidate,{item:FixedSnapshotItem;candidate:SkillCandidate|null;generation:number;enabled:boolean}>(),unhealthy=new Set<string>()
  const tombstone=(item:FixedSnapshotItem,candidate:SkillCandidate|null):SkillCandidate=>{
    const result:SkillCandidate={name:item.native.name,description:item.native.description,invocation:{modelInvocable:false,userInvocable:false},source:'custom',provider:'teloa-market',resourceBase:{kind:'directory',path:item.directory},rank:candidate?.rank??300,locator:candidate?.locator??item.installationId,path:item.path}
    locators.set(result,{item,candidate,generation,enabled:false})
    return result
  }
  const wrapped:SkillProvider={
    name:'teloa-market',
    async list(lookup){
      const fixed=authoritative,listedGeneration=generation
      if(fixed===undefined)return provider.list(lookup)
      if(refreshing)return [...fixed.values()].map(item=>tombstone(item,null))
      let output:Awaited<ReturnType<FileSystemSkillProvider['list']>>
      try{output=await provider.list(lookup)}catch(error){lookup.signal?.throwIfAborted();return {candidates:[...fixed.values()].map(item=>tombstone(item,null)),complete:false}}
      if(listedGeneration!==generation||refreshing)return {candidates:[...authoritative!.values()].map(item=>tombstone(item,null)),complete:false}
      const candidates=Array.isArray(output)?output:output.candidates,complete=Array.isArray(output)||output.complete
      const byPath=new Map<string,SkillCandidate[]>()
      for(const candidate of candidates){
        if(typeof candidate.path!=='string')continue
        const existing=byPath.get(candidate.path)??[];existing.push(candidate);byPath.set(candidate.path,existing)
      }
      let valid=complete
      const visible:SkillCandidate[]=[]
      for(const item of fixed.values()){
        const matches=byPath.get(item.path)??[],candidate=matches.length===1?matches[0]!:null
        const enabled=item.installationState==='installed'&&item.availability==='enabled'&&candidate!==null&&expectedCandidate(candidate,item)&&!unhealthy.has(item.installationId)
        if(item.installationState==='installed'&&item.availability==='enabled'&&!enabled)valid=false
        if(!enabled){visible.push(tombstone(item,candidate));continue}
        const result={...candidate}
        locators.set(result,{item,candidate,generation,enabled:true});visible.push(result)
      }
      return valid?visible:{candidates:visible,complete:false}
    },
    async get(candidate,lookup){
      const fixed=authoritative
      if(fixed===undefined)return provider.get(candidate,lookup)
      const locator=locators.get(candidate)
      if(!locator?.enabled||!locator.candidate||refreshing||locator.generation!==generation)return undefined
      const before=fixed.get(locator.item.installationId)
      if(!before||before.installationState!=='installed'||before.availability!=='enabled'||before.installationVersion!==locator.item.installationVersion||before.availabilityVersion!==locator.item.availabilityVersion)return undefined
      // 原生注册表只缓存候选，get 每次取正文。动态模型前置条件在此重验，失败明确回传而非回退同名技能。
      await options?.verifyUsable?.(before.installationId)
      let skill:SkillDefinition|undefined
      try{skill=await provider.get(locator.candidate,lookup)}catch{lookup.signal?.throwIfAborted();unhealthy.add(before.installationId);control.invalidate();return undefined}
      const after=authoritative?.get(before.installationId)
      if(refreshing||locator.generation!==generation||!after||after.installationState!=='installed'||after.availability!=='enabled'||after.installationVersion!==before.installationVersion||after.availabilityVersion!==before.availabilityVersion)return undefined
      if(!skill||!expectedDefinition(skill,after)){unhealthy.add(after.installationId);control.invalidate();return undefined}
      return skill
    },
  }
  const unregister=registry.registerProvider(providerControl=>{
    // 文件 provider 与状态包装共享同一失效控制，任何一侧变化都会清理获胜候选缓存。
    control=providerControl
    provider=new FileSystemSkillProvider(ctx,providerControl,{providerName:'teloa-market',includeDefaultRoots:false,customSkillDirs:[root],watchFollowSymlinks:false})
    return wrapped
  })
  const dispose=()=>{
    if(!disposal){closing=true;unregister();disposal=provider.dispose()}
    return disposal
  }
  ctx.effect(()=>dispose,'Teloa 受管技能原生目录')
  return {
    invalidate(path:string){if(!closing){const target=absolute(path);for(const item of authoritative?.values()??[])if(target===item.path||target.startsWith(item.directory+'/'))unhealthy.delete(item.installationId);provider.observeHostMutation(target)}},
    denyWhileRefreshing(){if(closing||authoritative===undefined)throw unavailable();refreshing=true;generation++;control.invalidate()},
    replaceAvailability(snapshot:ManagedSkillAvailabilitySnapshot){
      if(closing)throw unavailable()
      const next=cloneSnapshot(root,snapshot)
      if(authoritative)assertForwardSnapshot(authoritative,next)
      authoritative=next;refreshing=false;generation++;unhealthy.clear();control.invalidate()
    },
    async observe(name:string,options:SkillViewOptions,expected:ExpectedNativeSkill):Promise<NativeSkillObservation>{
      if(closing)throw unavailable()
      if(!isSkillName(name)||absolute(expected.path)!==expected.path||!/^[a-f0-9]{64}$/.test(expected.bodyHash)||typeof expected.modelInvocable!=='boolean'||typeof expected.userInvocable!=='boolean')throw invalid()
      const managed=[...(authoritative?.values()??[])].find(item=>item.path===expected.path&&item.native.name===name)
      if(managed?.availability==='disabled')return {state:'disabled',current:null}
      if(refreshing&&managed)throw unavailable()
      // 原生注册表会跳过读取失败的 provider；不完整目录不能据此投影为“未安装”。
      const snapshot=await registry.snapshot(options)
      if(!snapshot.complete||closing)throw unavailable()
      const skill=await registry.get(name,options)
      if(closing)throw unavailable()
      if(!skill)return {state:'missing',current:null}
      const current={...identity(skill),provider:skill.provider,source:skill.source,path:skill.path??null,resourceBase:skill.resourceBase??null}
      const sameSource=current.provider==='teloa-market'&&current.path===expected.path&&current.resourceBase?.kind==='directory'&&current.resourceBase.path===dirname(expected.path)
      if(!sameSource)return {state:'shadowed',reason:'different-source',current}
      if(current.bodyHash!==expected.bodyHash||current.modelInvocable!==expected.modelInvocable||current.userInvocable!==expected.userInvocable)return {state:'shadowed',reason:'content-changed',current}
      return {state:'available',current}
    },
    dispose,
  }
}
