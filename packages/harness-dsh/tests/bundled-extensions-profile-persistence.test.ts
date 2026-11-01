import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,writeFile,symlink,realpath,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {PluginPackages,createRuntimeResolution,loadProfileDirectory,mountRootInclude,readProfilePatches} from '@deepseek-ai/dsh-app-boot'
import {createBundledExtensionHandler} from '../src/bundled-extensions.ts'
import {hostBundledHotApplyPorts,hotApplyBundledExtension} from '../src/bundled-extensions-apply.ts'
import {bundledSourceConflicts} from '../src/bundled-extensions-profile.ts'

const require=createRequire(import.meta.url)
const bootRequire=createRequire(require.resolve('@deepseek-ai/dsh-app-boot'))
const {Loader}=await import(bootRequire.resolve('@deepseek-ai/cordis-plugin-loader'))
class MemoryLoader extends Loader {
 constructor(ctx:Context,config:{baseUrl:string}){super(ctx,config)}
 write(){}
}
const embedding='@teloa/local-embedding'

/** 真实 SDK Loader/Include、profile 解析与公开 set；扩展仅提供内存标记，不启动模型、联网或数据库。 */
async function fixture(t:TestContext,enabled:boolean){
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-bundled-persistence-')))
 const home=join(root,'home'),profileDir=join(home,'profiles/teloa'),programRoot=join(root,'program'),anchor=join(root,'installation/package.json')
 for(const p of [profileDir,join(root,'installation'),join(profileDir,'node_modules/@teloa')])await mkdir(p,{recursive:true})
 await writeFile(anchor,JSON.stringify({name:'fixture-installation',private:true,dependencies:{}}))
 for(const [name,directory,rows] of [
  ['@teloa/bundle','bundle',[{id:'fixture-pin',name:'cordis:pin'}]],
  [embedding,'local-embedding',[{id:'teloa-local-embedding',name:embedding}]],
 ] as const){
  const path=join(programRoot,'packages',directory)
  await mkdir(path,{recursive:true})
  await writeFile(join(path,'package.json'),JSON.stringify({name,version:'1.0.0',type:'module',engines:{dsh:'0.2.1-rc.2'},exports:{'.':'./index.mjs','./package.json':'./package.json'},dsh:{bundle:{patch:'./cordis.patch.yml'}}}))
  await writeFile(join(path,'cordis.patch.yml'),JSON.stringify([{insert:rows}]))
  await writeFile(join(path,'index.mjs'),`import {existsSync} from 'node:fs';export default function(ctx){if(existsSync(${JSON.stringify(join(root,'fail-embedding'))}))throw Error('fixture activation rejected');ctx.provide('fixtureEmbedding',true)}\n`)
  await symlink(path,join(profileDir,'node_modules',name))
 }
 const bundles=['@teloa/bundle',...(enabled?[embedding]:[])]
 const originalManifest={name:'fixture',private:true,dependencies:{'@teloa/bundle':'link:'+join(programRoot,'packages/bundle'),[embedding]:'link:'+join(programRoot,'packages/local-embedding')},dsh:{profile:{bundles}},fixtureOwnerNote:'保留本人其余字段'}
 await writeFile(join(profileDir,'package.json'),JSON.stringify(originalManifest))
 const basePath=join(profileDir,'cordis.yml'),patchPath=join(profileDir,'cordis.patch.yml')
 const base='# 本人的原始基础配置；运行时组合不得烘焙到这里。\n[]\n',patch='# 本人的显式覆盖层\n[]\n'
 await writeFile(basePath,base);await writeFile(patchPath,patch)
 const ctx=new Context()
 t.after(async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})})
 ctx.provide('profileContext',{name:'teloa',dir:profileDir,home,patchPath,installAnchor:anchor,cwd:profileDir,startedBundles:bundles,overlays:[],telemetryDisabledEnv:undefined})
 const resolution=await createRuntimeResolution({installAnchor:anchor,home,profile:loadProfileDirectory('dsh',profileDir,anchor)})
 await ctx.plugin(PluginPackages,{resolution})
 await ctx.plugin(MemoryLoader,{baseUrl:pathToFileURL(profileDir+'/').href})
 ctx.loader.builtins.pin={apply(){}}
 await mountRootInclude(ctx,basePath,readProfilePatches('dsh',ctx.profileContext))
 await ctx.loader.await()
 const loaded=()=>ctx.get('fixtureEmbedding' as never)===true
 let rejectPostCheck=false,checks=0
 const ports=hostBundledHotApplyPorts(ctx,{verify:async()=>{assert.deepEqual(await bundledSourceConflicts(profileDir,programRoot),[]);if(rejectPostCheck&&++checks===2)throw Error('fixture safety recheck rejected')},loaded:()=>loaded(),warn:message=>assert.fail(message)})
 assert.ok(ports.current(),'夹具须暴露真实根 Include，不得退回仅重启生效')
 const handler=createBundledExtensionHandler({profileDir,programRoot,runtimeRoot:join(root,'runtime'),bundlesAtStart:bundles,loaded:()=>loaded(),version:async()=>'1.0.0',apply:change=>hotApplyBundledExtension(ports,change)})
 const unchanged=async(expectedPatch=patch)=>{
  // Loader 将写盘排入队列；等完整生命周期后检查真实文件，不只检查套用返回值。
  await ctx.loader.await();await new Promise<void>(resolve=>setTimeout(resolve,20))
  assert.equal(await readFile(basePath,'utf8'),base,'公开热切换不得把生成的插件树写回本人 cordis.yml')
  assert.equal(await readFile(patchPath,'utf8'),expectedPatch)
  const manifest=JSON.parse(await readFile(join(profileDir,'package.json'),'utf8'))
  assert.deepEqual({...manifest,dsh:{...manifest.dsh,profile:{...manifest.dsh.profile,bundles:[]}}},{...originalManifest,dsh:{profile:{bundles:[]}}})
 }
 const set=async(value:boolean)=>{
  const current=(await handler('bundled-extensions/list',{}) as {id:string;version:string;state:string}[]).find(row=>row.id==='local-embedding')!
  const result=await handler('bundled-extensions/set',{extensionId:'local-embedding',enabled:value,expected:{version:current.version,state:current.state}}) as {state:string}
  assert.equal(result.state,value?'active':'available')
  assert.equal(loaded(),value)
  await unchanged()
 }
 assert.equal(loaded(),enabled)
 await unchanged()
 return {set,unchanged,ctx,handler,root,profileDir,patchPath,loaded,rejectPostCheck:()=>{rejectPostCheck=true}}
}

test('官方默认 profile：公开启用/停用/再启用只保存 bundles，原 base 与 patch 字节保持',async t=>{
 const f=await fixture(t,false)
 await f.set(true);await f.set(false);await f.set(true)
})

test('已启用官方可选扩展：公开停用/恢复不把卸载标记与展开组合写入原 base',async t=>{
 const f=await fixture(t,true)
 await f.set(false);await f.set(true)
})

test('非目标的旧 import-failed 条目不顺带重试，公开启用诚实回待重启并保留 base',async t=>{
 const f=await fixture(t,false),path=join(f.root,'previously-missing.mjs')
 await f.ctx.loader.create({name:pathToFileURL(path).href})
 await f.ctx.loader.await()
 await writeFile(path,"export default function(ctx){ctx.provide('fixtureUnrelatedStarted',true)}\n")
 const result=await f.handler('bundled-extensions/set',{extensionId:'local-embedding',enabled:true,expected:{version:'1.0.0',state:'available'}}) as {state:string}
 assert.equal(result.state,'enable-pending')
 assert.equal(f.loaded(),false)
 assert.equal(f.ctx.get('fixtureUnrelatedStarted' as never),undefined)
 await f.unchanged()
})

test('非目标条目仍在等待注入时不热重组，不能仅凭已有 uid 当作运行正常',async t=>{
 const f=await fixture(t,false),path=join(f.root,'pending-service.mjs')
 await writeFile(path,"export const inject=['fixtureNeverAvailable'];export function apply(ctx){throw Error('pending fixture must never start')}\n")
 const pendingId=await f.ctx.loader.create({name:pathToFileURL(path).href})
 await f.ctx.loader.await()
 const pending=f.ctx.loader.resolve(pendingId)
 assert.ok(pending.fiber?.uid)
 assert.notEqual(pending.fiber?.state,2)
 const result=await f.handler('bundled-extensions/set',{extensionId:'local-embedding',enabled:true,expected:{version:'1.0.0',state:'available'}}) as {state:string}
 assert.equal(result.state,'enable-pending')
 assert.equal(f.loaded(),false)
 await f.unchanged()
})

test('新目标激活失败正常回滚 bundles 和运行代，不写回生成 base 或改 patch',async t=>{
 const f=await fixture(t,false),before=await readFile(join(f.profileDir,'package.json'),'utf8')
 await writeFile(join(f.root,'fail-embedding'),'only this owned fixture fails')
 await assert.rejects(f.handler('bundled-extensions/set',{extensionId:'local-embedding',enabled:true,expected:{version:'1.0.0',state:'available'}}),{code:'teloa/dependency-unavailable'})
 assert.equal(await readFile(join(f.profileDir,'package.json'),'utf8'),before)
 assert.equal(f.loaded(),false)
 await f.unchanged()
})

test('停用后安全复验失败正常回滚原启用配置和真实运行代，base 与 patch 仍是原输入',async t=>{
 const f=await fixture(t,true),before=await readFile(join(f.profileDir,'package.json'),'utf8')
 f.rejectPostCheck()
 await assert.rejects(f.handler('bundled-extensions/set',{extensionId:'local-embedding',enabled:false,expected:{version:'1.0.0',state:'active'}}),{code:'teloa/forbidden'})
 assert.equal(await readFile(join(f.profileDir,'package.json'),'utf8'),before)
 assert.equal(f.loaded(),true)
 await f.unchanged()
})

for(const [title,rows] of [
 ['额外插件',[{insert:[{id:'foreign',name:'cordis:pin'}]}]],
 ['禁用原行',[{id:'fixture-pin',disabled:true}]],
 ['修改原行配置',[{id:'fixture-pin',config:{foreign:true}}]],
] as const)test(`${title}不搭便车热套用，保留本人 patch 原字节`,async t=>{
  const f=await fixture(t,false),patch=JSON.stringify(rows)
  await writeFile(f.patchPath,patch)
  const result=await f.handler('bundled-extensions/set',{extensionId:'local-embedding',enabled:true,expected:{version:'1.0.0',state:'available'}}) as {state:string}
  assert.equal(result.state,'enable-pending')
  assert.equal(f.loaded(),false)
  await f.unchanged(patch)
})
