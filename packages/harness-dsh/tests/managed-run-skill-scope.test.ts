import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {SkillRegistry} from '@deepseek-ai/dsh-skill'
import {FileSystemSkillProvider} from '@deepseek-ai/dsh-skill-filesystem'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {FileSystem} from '@deepseek-ai/dsh-fs'
import type {NativeSkillMetadata,RunSkill} from '@teloa/backend'
import {createManagedRunSkillScope} from '../src/managed-run-skill-scope.ts'
import {registerManagedRunSkillPreStep} from '../src/managed-run-skill-pre-step.ts'
import {createUserMessage} from '@deepseek-ai/dsh-llm'

const hostRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const {LocalFileSystem}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-fs-local')).href) as {
 LocalFileSystem:new(ctx:Context,config:{cwd:string})=>FileSystem
}
const skillRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh-skill'))
const {createScope}=await import(pathToFileURL(skillRequire.resolve('@deepseek-ai/dsh-scope')).href) as {
 createScope:(ctx:Context,key:object,options?:{parent:object})=>{ctx:Context;dispose:()=>Promise<void>}
}
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const bundleHash=(files:readonly {path:string;hash:string}[])=>sha(JSON.stringify(files.map(file=>[file.path,file.hash])))
const oldId='12345678-1234-4234-8234-123456789012'

async function writeSkill(root:string,directoryName:string,body:string,flags=''){
 const directory=join(root,directoryName),skillText=`---\nname: fixed-method\ndescription: 固定方法\n${flags}---\n\n${body}\n`,attachment='固定附件：'+body
 await mkdir(join(directory,'references'),{recursive:true})
 await writeFile(join(directory,'SKILL.md'),skillText)
 await writeFile(join(directory,'references/source.txt'),attachment)
 return {directory,skillText,attachment,body}
}

async function setup(t:TestContext){
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-run-skill-scope-'))),ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 await ctx.plugin(SkillRegistry);await ctx.plugin(LocalFileSystem,{cwd:root})
 const managedRoot=join(root,'managed'),globalRoot=join(root,'global')
 await mkdir(managedRoot,{recursive:true});await mkdir(globalRoot,{recursive:true})
 const old=await writeSkill(managedRoot,oldId,'旧版正文'),newer=await writeSkill(globalRoot,'new-version','全局新版正文')
 let globalProvider!:FileSystemSkillProvider
 const unregister=ctx.skills.registerProvider(control=>{
  globalProvider=new FileSystemSkillProvider(ctx,control,{providerName:'teloa-market',includeDefaultRoots:false,customSkillDirs:[globalRoot],watch:false})
  return globalProvider
 })
 t.after(async()=>{unregister();await globalProvider.dispose()})
 const rawFiles=[
  {path:'SKILL.md',bytes:new TextEncoder().encode(old.skillText)},
  {path:'references/source.txt',bytes:new TextEncoder().encode(old.attachment)},
 ].map(file=>({...file,hash:sha(file.bytes),size:file.bytes.byteLength}))
 const managed={installationId:oldId,bundleHash:bundleHash(rawFiles),files:rawFiles.map(({path,hash,size})=>({path,hash,size}))}
 const skill:RunSkill={name:'fixed-method',provider:'teloa-market',source:'custom',description:'固定方法',content:old.body,sha256:sha(old.body),resourceBase:{kind:'directory',path:old.directory},managed}
 const native:NativeSkillMetadata={name:skill.name,description:skill.description,modelInvocable:true,userInvocable:true,bodyHash:skill.sha256}
 const verify=async(value:RunSkill,signal:AbortSignal)=>{
  signal.throwIfAborted();assert.equal(value.managed?.installationId,oldId)
  const names:string[]=[]
  async function walk(directory:string,prefix=''){
   for(const entry of await readdir(directory,{withFileTypes:true})){
    const relative=prefix?prefix+'/'+entry.name:entry.name
    if(entry.isDirectory())await walk(join(directory,entry.name),relative)
    else names.push(relative)
   }
  }
  await walk(old.directory);names.sort()
  assert.deepEqual(names,value.managed!.files.map(file=>file.path))
  for(const expected of value.managed!.files){const bytes=await readFile(join(old.directory,expected.path));assert.equal(bytes.byteLength,expected.size);assert.equal(sha(bytes),expected.hash)}
  signal.throwIfAborted();return native
 }
 function agent(sessionId='session-'+randomUUID()){
  const target={} as {ctx:Context;session:{id:string;header:{cwd:string}}},scope=createScope(ctx,target)
  Object.assign(target,{ctx:scope.ctx,session:{id:sessionId,header:{cwd:root}}})
  t.after(()=>scope.dispose())
  return target as unknown as Agent
 }
 return {root,ctx,managedRoot,old,newer,skill,native,verify,agent}
}

test('agent scope 固定旧安装并覆盖全局新版，同 run ensure 幂等且不影响默认 scope',async t=>{
 const value=await setup(t),agent=value.agent(),run={id:randomUUID(),sessionId:agent.session.id,skills:[value.skill]}
 assert.equal((await value.ctx.skills.get('fixed-method',{cwd:value.root}))?.content,'全局新版正文')
 const manager=createManagedRunSkillScope(value.ctx,{managedRoot:value.managedRoot,verify:value.verify})
 t.after(()=>manager.dispose())
 await manager.ensure(agent,run,new AbortController().signal)
 await manager.ensure(agent,run,new AbortController().signal)
 const listed=(await value.ctx.skills.list({cwd:value.root,scope:agent})).find(skill=>skill.name==='fixed-method')
 assert.equal(listed?.provider,'teloa-market')
 assert.deepEqual(listed?.invocation,{modelInvocable:true,userInvocable:true})
 const fixed=await value.ctx.skills.get('fixed-method',{cwd:value.root,scope:agent})
 assert.equal(fixed?.content,'旧版正文');assert.equal(fixed?.path,join(value.old.directory,'SKILL.md'))
 assert.deepEqual(fixed?.resourceBase,{kind:'directory',path:value.old.directory})
 assert.equal((await value.ctx.skills.get('fixed-method',{cwd:value.root}))?.content,'全局新版正文')
 await assert.rejects(manager.ensure(agent,{...run,id:randomUUID()},new AbortController().signal),{code:'teloa/conflict'})
})

test('子 Agent pre-step 经真实固定 Skill scope 读取父 Run 旧版，拒绝伪造归属与断链',async t=>{
 const value=await setup(t),parent=value.agent(),child=value.agent(),run={id:randomUUID(),sessionId:parent.session.id,skills:[value.skill]}
 Object.assign(child.session.header,{origin:'subagent',parentSession:parent.session.id,delegationDepth:1})
 let online=true
 value.ctx.provide('agents',{get:(id:string)=>online&&id===parent.session.id?parent:undefined} as never)
 const manager=createManagedRunSkillScope(value.ctx,{managedRoot:value.managedRoot,verify:value.verify})
 t.after(()=>manager.dispose())
 registerManagedRunSkillPreStep(value.ctx,async id=>{assert.equal(id,parent.session.id);return run},(agent,binding,signal)=>manager.ensure(agent,binding,signal))
 const messages=[createUserMessage({source:{kind:'user'},content:[]})]
 const enter=()=>value.ctx.waterfall('agent/pre-step',{agent:child,messages,turn:1,step:1,signal:new AbortController().signal},async()=>({kind:'enter' as const,messages}))
 assert.equal((await enter()).kind,'enter')
 assert.equal((await value.ctx.skills.get('fixed-method',{cwd:value.root,scope:child}))?.content,'旧版正文')
 assert.equal((await value.ctx.skills.get('fixed-method',{cwd:value.root}))?.content,'全局新版正文')
 await assert.rejects(manager.ensure(child,{...run,sessionId:child.session.id},new AbortController().signal),{code:'teloa/forbidden'})
 online=false
 await assert.rejects(enter,/subagent parent unavailable/)
 await assert.rejects(manager.ensure(child,run,new AbortController().signal),{code:'teloa/forbidden'})
})

test('固定目录缺失或完整文件复验失败时保留同名 tombstone，禁止回退全局新版',async t=>{
 const value=await setup(t),agent=value.agent(),run={id:randomUUID(),sessionId:agent.session.id,skills:[value.skill]}
 await writeFile(join(value.old.directory,'references/source.txt'),'已被改动')
 const manager=createManagedRunSkillScope(value.ctx,{managedRoot:value.managedRoot,verify:value.verify})
 t.after(()=>manager.dispose())
 await assert.rejects(manager.ensure(agent,run,new AbortController().signal))
 const listed=(await value.ctx.skills.list({cwd:value.root,scope:agent})).find(skill=>skill.name==='fixed-method')
 assert.equal(listed?.provider,'teloa-market')
 assert.deepEqual(listed?.invocation,{modelInvocable:false,userInvocable:false})
 assert.equal(await value.ctx.skills.get('fixed-method',{cwd:value.root,scope:agent}),undefined)
 assert.equal((await value.ctx.skills.get('fixed-method',{cwd:value.root}))?.content,'全局新版正文')
})

test('ready scope 每次 ensure 重新复验完整附件，变化后立即闭门',async t=>{
 const value=await setup(t),agent=value.agent(),run={id:randomUUID(),sessionId:agent.session.id,skills:[value.skill]}
 const manager=createManagedRunSkillScope(value.ctx,{managedRoot:value.managedRoot,verify:value.verify})
 t.after(()=>manager.dispose())
 await manager.ensure(agent,run,new AbortController().signal)
 await writeFile(join(value.old.directory,'references/source.txt'),'ensure 之间发生变化')
 await assert.rejects(manager.ensure(agent,run,new AbortController().signal))
 const listed=(await value.ctx.skills.list({cwd:value.root,scope:agent})).find(skill=>skill.name==='fixed-method')
 assert.deepEqual(listed?.invocation,{modelInvocable:false,userInvocable:false})
 assert.equal(await value.ctx.skills.get('fixed-method',{cwd:value.root,scope:agent}),undefined)
})

test('get 复验返回的 native 发生变化时令 scope 失败并撤下可调用目录',async t=>{
 const value=await setup(t),agent=value.agent(),run={id:randomUUID(),sessionId:agent.session.id,skills:[value.skill]}
 let changed=false
 const manager=createManagedRunSkillScope(value.ctx,{managedRoot:value.managedRoot,verify:async(skill,signal)=>{
  const native=await value.verify(skill,signal)
  return changed?{...native,userInvocable:false}:native
 }})
 t.after(()=>manager.dispose())
 await manager.ensure(agent,run,new AbortController().signal)
 changed=true
 assert.equal(await value.ctx.skills.get('fixed-method',{cwd:value.root,scope:agent}),undefined)
 const listed=(await value.ctx.skills.list({cwd:value.root,scope:agent})).find(skill=>skill.name==='fixed-method')
 assert.deepEqual(listed?.invocation,{modelInvocable:false,userInvocable:false})
})

test('无关损坏安装不阻断固定旧运行，空 managed 快照不扫描目录',async t=>{
 const value=await setup(t),unrelated=join(value.managedRoot,randomUUID(),'SKILL.md')
 await mkdir(join(unrelated,'..'),{recursive:true});await writeFile(unrelated,'---\nname: unrelated\ndescription: 坏目录\n---\n正文')
 const original=value.ctx.fs.readText.bind(value.ctx.fs);let unrelatedReads=0
 value.ctx.fs.readText=async(file,signal)=>{if(file.displayPath===unrelated){unrelatedReads++;throw Error('无关目录拒读')}return original(file,signal)}
 const manager=createManagedRunSkillScope(value.ctx,{managedRoot:value.managedRoot,verify:value.verify}),agent=value.agent(),run={id:randomUUID(),sessionId:agent.session.id,skills:[value.skill]}
 t.after(()=>manager.dispose())
 await manager.ensure(agent,run,new AbortController().signal)
 assert.equal(unrelatedReads,0,'固定 scope 只把本次 installation 目录交给原生 provider')
 assert.equal((await value.ctx.skills.get('fixed-method',{cwd:value.root,scope:agent}))?.content,'旧版正文')
 let reads=0;value.ctx.fs.readText=async(file,signal)=>{reads++;return original(file,signal)}
 const emptyAgent=value.agent(),plain:RunSkill={name:'plain-method',provider:'plain',source:'runtime',description:'普通技能',content:'普通正文',sha256:sha('普通正文')}
 await manager.ensure(emptyAgent,{id:randomUUID(),sessionId:emptyAgent.session.id,skills:[plain]},new AbortController().signal)
 assert.equal(reads,0)
})

test('get 异步复验期间 dispose 后拒绝迟到旧正文',async t=>{
 const value=await setup(t),agent=value.agent(),run={id:randomUUID(),sessionId:agent.session.id,skills:[value.skill]}
 let unblock!:()=>void,started!:()=>void,block=false
 const waiting=new Promise<void>(resolve=>{unblock=resolve}),seen=new Promise<void>(resolve=>{started=resolve})
 const manager=createManagedRunSkillScope(value.ctx,{managedRoot:value.managedRoot,verify:async(skill,signal)=>{
  if(block){started();await waiting}return value.verify(skill,signal)
 }})
 await manager.ensure(agent,run,new AbortController().signal)
 block=true
 await value.ctx.skills.list({cwd:value.root,scope:agent})
 const loading=value.ctx.skills.get('fixed-method',{cwd:value.root,scope:agent})
 await seen
 let finished=false
 const disposed=manager.dispose().then(()=>{finished=true})
 await new Promise<void>(resolve=>setImmediate(resolve))
 assert.equal(finished,false,'dispose 必须等待已经进入 verifier 的 get')
 unblock();await disposed
 assert.equal(await loading,undefined)
 assert.equal((await value.ctx.skills.get('fixed-method',{cwd:value.root}))?.content,'全局新版正文')
})

test('dispose 主动取消在途 get 复验并等待作用域完整退出',async t=>{
 const value=await setup(t),agent=value.agent(),run={id:randomUUID(),sessionId:agent.session.id,skills:[value.skill]}
 let started!:()=>void,block=false
 const seen=new Promise<void>(resolve=>{started=resolve})
 const manager=createManagedRunSkillScope(value.ctx,{managedRoot:value.managedRoot,verify:async(skill,signal)=>{
  if(block){
   started()
   await new Promise<void>((resolve,reject)=>{
    if(signal.aborted){reject(signal.reason);return}
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true})
   })
  }
  return value.verify(skill,signal)
 }})
 await manager.ensure(agent,run,new AbortController().signal)
 block=true
 await value.ctx.skills.list({cwd:value.root,scope:agent})
 const loading=value.ctx.skills.get('fixed-method',{cwd:value.root,scope:agent})
 await seen
 await manager.dispose()
 assert.equal(await loading,undefined)
 assert.equal((await value.ctx.skills.get('fixed-method',{cwd:value.root}))?.content,'全局新版正文')
})

test('宿主重建后可从同一固定 run 重新 ensure，不依赖旧 manager 内存',async t=>{
 const value=await setup(t),runId=randomUUID(),firstAgent=value.agent('persisted-session'),run={id:runId,sessionId:'persisted-session',skills:[value.skill]}
 const first=createManagedRunSkillScope(value.ctx,{managedRoot:value.managedRoot,verify:value.verify})
 await first.ensure(firstAgent,run,new AbortController().signal)
 assert.equal((await value.ctx.skills.get('fixed-method',{cwd:value.root,scope:firstAgent}))?.content,'旧版正文')
 await first.dispose()
 const resumed=value.agent('persisted-session'),second=createManagedRunSkillScope(value.ctx,{managedRoot:value.managedRoot,verify:value.verify})
 t.after(()=>second.dispose())
 await second.ensure(resumed,run,new AbortController().signal)
 assert.equal((await value.ctx.skills.get('fixed-method',{cwd:value.root,scope:resumed}))?.content,'旧版正文')
})

test('共享 loading 不借一个调用方取消中止其他 ensure，dispose 会中止并等待内部加载',async t=>{
 const value=await setup(t),agent=value.agent(),run={id:randomUUID(),sessionId:agent.session.id,skills:[value.skill]}
 let unblock!:()=>void,started!:()=>void,calls=0
 const waiting=new Promise<void>(resolve=>{unblock=resolve}),seen=new Promise<void>(resolve=>{started=resolve})
 const manager=createManagedRunSkillScope(value.ctx,{managedRoot:value.managedRoot,verify:async(skill,signal)=>{calls++;started();await waiting;signal.throwIfAborted();return value.verify(skill,signal)}})
 t.after(()=>manager.dispose())
 const firstController=new AbortController(),first=manager.ensure(agent,run,firstController.signal),second=manager.ensure(agent,run,new AbortController().signal)
 await seen;firstController.abort(new Error('caller cancelled'));unblock()
 await assert.rejects(first,/caller cancelled/);await second
 assert.equal(calls,1,'并发 ensure 必须共享内部复验，但调用方取消只退出自己')
 assert.equal((await value.ctx.skills.get('fixed-method',{cwd:value.root,scope:agent}))?.content,'旧版正文')
})
