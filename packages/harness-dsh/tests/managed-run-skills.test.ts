import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {SkillRegistry,type SkillDefinition} from '@deepseek-ai/dsh-skill'
import type {FileSystem} from '@deepseek-ai/dsh-fs'
import type {SkillInstallSourceBundle,SkillInstallation,TaskRunSkillDatabase} from '@teloa/backend'
import {ManagedSkillFiles} from '../src/managed-skill-files.ts'
import {inspectNativeSkillDirectory,registerManagedSkills} from '../src/managed-skills-native.ts'
import {createManagedRunSkillResolver,createManagedRunSkillVerifier} from '../src/managed-run-skills.ts'
import {resolveDshRoleSkills} from '../src/role-skills-dsh.ts'

const hostRequire=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const {LocalFileSystem}=await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/dsh-fs-local')).href) as {
  LocalFileSystem:new(ctx:Context,config:{cwd:string})=>FileSystem
}
const id='12345678-1234-4234-8234-123456789012'
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const fixedSource={kind:'atomic' as const,contentId:'22345678-1234-4234-8234-123456789012',contentHash:'a'.repeat(64),resourceId:'managed-review',resourceVersion:'1.0.0'}

async function setup(t:TestContext){
 const temporary=await realpath(await mkdtemp(join(tmpdir(),'teloa-run-skill-'))),ctx=new Context(),managedRoot=join(temporary,'managed')
 t.after(async()=>{await ctx.fiber.dispose();await rm(temporary,{recursive:true,force:true})})
 await ctx.plugin(SkillRegistry);await ctx.plugin(LocalFileSystem,{cwd:temporary});await mkdir(managedRoot)
 let nativeManager!:ReturnType<typeof registerManagedSkills>
 const files=new ManagedSkillFiles(managedRoot,directory=>inspectNativeSkillDirectory(ctx,directory),path=>nativeManager.invalidate(path))
 nativeManager=registerManagedSkills(ctx,managedRoot);t.after(()=>nativeManager.dispose())
 const skillText='---\nname: managed-review\ndescription: 核对固定附件\nuser-invocable: false\n---\n\n读取 references/source.txt 后核对。\n'
 const attachment='固定附件正文'
 const bundleFiles=[
  {path:'SKILL.md',bytes:new TextEncoder().encode(skillText)},
  {path:'references/source.txt',bytes:new TextEncoder().encode(attachment)},
 ].map(file=>({...file,hash:sha(file.bytes)}))
 const bundle:SkillInstallSourceBundle={ownerId:'owner',source:fixedSource,entryPath:'SKILL.md',files:bundleFiles,bundleHash:sha(JSON.stringify(bundleFiles.map(file=>[file.path,file.hash])))}
 const native=await files.inspect(bundle)
 const installation:SkillInstallation={id,ownerId:'owner',source:fixedSource,bundleHash:bundle.bundleHash,native,state:'installed',version:2,createdAt:'2026-09-12T00:00:00.000Z',updatedAt:'2026-09-12T00:00:01.000Z'}
 await files.publish(id,bundle,native)
 const database={query:async()=>{throw Error('测试哨兵不执行查询')}} as unknown as TaskRunSkillDatabase
 const calls:{get:unknown[];read:unknown[];verify:number}={get:[],read:[],verify:0}
 const resolver=createManagedRunSkillResolver('owner',{
  managedFiles:{root:files.root,path:value=>files.path(value),verify:async(...args)=>{calls.verify++;return files.verify(...args)}},
  getInstallation:async(value,db)=>{calls.get.push([value,db]);return installation},
  readSource:async(value,db)=>{calls.read.push([value,db]);return bundle},
 })
 const agent={session:{header:{cwd:temporary}}}
 const host={sessionController:{resolveAgent:async()=>({agent})},agentPresets:{serviceFor:()=>ctx.skills},skills:ctx.skills} as unknown as Context
 return {temporary,managedRoot,ctx,files,bundle,installation,resolver,agent,host,database,calls}
}

test('真实会话获胜的受管 provider 固定安装身份并逐文件复验，沿用 prepare 的同一数据库连接',async t=>{
 const f=await setup(t),signal=new AbortController().signal
 const result=await resolveDshRoleSkills(f.host,'owner','session',['managed-review'],async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),signal,f.resolver,f.database)
 assert.deepEqual(result[0]?.managed,{installationId:id,bundleHash:f.bundle.bundleHash,files:[
  {path:'SKILL.md',hash:f.bundle.files[0]!.hash,size:f.bundle.files[0]!.bytes.byteLength},
  {path:'references/source.txt',hash:f.bundle.files[1]!.hash,size:f.bundle.files[1]!.bytes.byteLength},
 ]})
 assert.equal(result[0]?.provider,'teloa-market');assert.equal(result[0]?.source,'custom')
 assert.deepEqual(result[0]?.resourceBase,{kind:'directory',path:join(f.managedRoot,id)})
 assert.deepEqual(f.calls.get,[[id,f.database]]);assert.deepEqual(f.calls.read,[[{kind:'atomic',contentId:fixedSource.contentId},f.database]]);assert.equal(f.calls.verify,1)
 await writeFile(join(f.managedRoot,id,'references/source.txt'),'附件被改动')
 await assert.rejects(resolveDshRoleSkills(f.host,'owner','session',['managed-review'],async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),signal,f.resolver),{code:'teloa/storage-corrupt'})
})

test('只有完整受管原生身份可附加 managed，provider 声称受管时禁止缺失身份降级',async t=>{
 const f=await setup(t),signal=new AbortController().signal
 const actual=await f.ctx.skills.get('managed-review',{cwd:f.temporary,scope:f.agent})
 assert.ok(actual)
 const ordinary={...actual,provider:'filesystem'} as SkillDefinition
 assert.equal(await f.resolver(ordinary,signal),undefined)
 const remove=f.ctx.skills.register({name:'managed-review',description:'会话中获胜的普通 Skill',source:'runtime',content:'普通正文'})
 const resolved=await resolveDshRoleSkills(f.host,'owner','session',['managed-review'],async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),signal,f.resolver)
 assert.equal(resolved[0]?.provider,'runtime');assert.equal('managed' in resolved[0]!,false)
 remove()
 for(const changed of [
  {...actual,source:'project-agents'},
  {...actual,path:join(f.managedRoot,'other','SKILL.md')},
  {...actual,resourceBase:{kind:'directory' as const,path:join(f.managedRoot,'other')}},
  {...actual,path:undefined},
 ])await assert.rejects(f.resolver(changed as SkillDefinition,signal),{code:'teloa/storage-corrupt'})
 assert.equal(f.calls.get.length,0,'路径身份不完整时不能按 name 猜安装记录')
})

test('安装记录、固定来源、原生正文及 flags 任一不一致都拒绝生成受管快照',async t=>{
 const f=await setup(t),signal=new AbortController().signal,actual=await f.ctx.skills.get('managed-review',{cwd:f.temporary})
 assert.ok(actual)
 const base={managedFiles:{root:f.files.root,path:(value:string)=>f.files.path(value),verify:(...args:Parameters<ManagedSkillFiles['verify']>)=>f.files.verify(...args)},readSource:async()=>f.bundle}
 for(const installation of [
  {...f.installation,ownerId:'other'},
  {...f.installation,state:'preparing' as const},
  {...f.installation,bundleHash:'b'.repeat(64)},
  {...f.installation,native:{...f.installation.native,name:'other-name'}},
  {...f.installation,native:{...f.installation.native,userInvocable:true}},
 ]){
  const resolver=createManagedRunSkillResolver('owner',{...base,getInstallation:async()=>installation})
  await assert.rejects(resolver(actual,signal),{code:'teloa/storage-corrupt'})
 }
 const resolver=createManagedRunSkillResolver('owner',{...base,getInstallation:async()=>f.installation,readSource:async()=>({...f.bundle,source:{...fixedSource,resourceVersion:'2.0.0'}})})
 await assert.rejects(resolver(actual,signal),{code:'teloa/storage-corrupt'})
})


test('执行恢复按固定安装验证旧完整附件，不使用当前目录或启用状态',async t=>{
 const f=await setup(t),signal=new AbortController().signal
 const [skill]=await resolveDshRoleSkills(f.host,'owner','session',['managed-review'],async()=>({ownerId:'owner',sessionId:'session',status:'ready'}),signal,f.resolver)
 assert.ok(skill)
 let reads=0
 const verify=createManagedRunSkillVerifier('owner',{managedFiles:f.files,getInstallation:async value=>{assert.equal(value,id);reads++;return f.installation},readSource:async()=>f.bundle})
 assert.deepEqual(await verify(skill,signal),f.installation.native);assert.equal(reads,1)
 await assert.rejects(verify({...skill,managed:{...skill.managed!,bundleHash:'b'.repeat(64)}},signal),{code:'teloa/storage-corrupt'})
 const wrong=createManagedRunSkillVerifier('other',{managedFiles:f.files,getInstallation:async()=>f.installation,readSource:async()=>f.bundle})
 await assert.rejects(wrong(skill,signal),{code:'teloa/storage-corrupt'})
 await writeFile(join(f.managedRoot,id,'references/source.txt'),'恢复前附件被改动')
 await assert.rejects(verify(skill,signal),{code:'teloa/storage-corrupt'})
})
