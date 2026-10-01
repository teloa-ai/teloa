import test from 'node:test'
import assert from 'node:assert/strict'
import type {TestContext} from 'node:test'
import {mkdir,mkdtemp,realpath,rm,symlink,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {managedPackageAllowlist,managedPackageDir,managedPackageLock} from '@teloa/harness-dsh/managed-package-install'
import {createRuntimeStage,readRuntimeRecipe,runtimeInstallTimeoutMs} from '../src/runtime.ts'
import {resolveRuntimeEntry} from '../src/inference.ts'
import recipeFile from '../runtime/onnxruntime.json' with {type:'json'}

async function tempRoot(t:TestContext){
 const dir=await mkdtemp(join(tmpdir(),'teloa-embed-runtime-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 return dir
}

test('runtime/onnxruntime.json 与 managedPackageAllowlist 条目完全一致；偏离的配方被拒',()=>{
 const entry=managedPackageAllowlist.find(row=>row.package==='onnxruntime-node')
 assert.deepEqual(recipeFile,entry)
 assert.deepEqual(readRuntimeRecipe(recipeFile),entry)
 for(const bad of [{...recipeFile,integrity:'sha512-'+'A'.repeat(86)+'=='},{...recipeFile,version:'1.29.0'},{...recipeFile,extra:1},{package:'onnxruntime-node',version:'1.30.0'},null])
  assert.throws(()=>readRuntimeRecipe(bad),/运行时配方/,JSON.stringify(bad))
})

test('运行时阶段：安装按 installManagedPackage(root, recipe, npm, 随附 lock, 600000) 调用；检查只核对不安装',async()=>{
 const calls:unknown[][]=[]
 const checks:unknown[][]=[]
 const recipe=readRuntimeRecipe(recipeFile)
 const stage=createRuntimeStage('/runtime-root',{
  install:async(...args)=>{calls.push(args);return managedPackageDir(args[0],args[1])},
  installed:async(...args)=>{checks.push(args);return false},
 })
 assert.equal(await stage.check(),false)
 assert.equal(calls.length,0)
 assert.deepEqual(checks,[['/runtime-root',recipe,managedPackageLock(recipe)]])
 assert.equal(await stage.install(),managedPackageDir('/runtime-root',recipe))
 assert.equal(runtimeInstallTimeoutMs,600_000)
 assert.deepEqual(calls,[['/runtime-root',recipe,'npm',managedPackageLock(recipe),600_000]])
 assert.equal(stage.dir,join('/runtime-root','packages','onnxruntime-node@1.30.0'))
})

test('resolveRuntimeEntry：只从受管目录解析 onnxruntime-node，解析结果逃出目录则拒绝',async t=>{
 const root=await tempRoot(t)
 const dir=join(root,'packages','onnxruntime-node@1.30.0')
 const pkg=join(dir,'node_modules','onnxruntime-node')
 await mkdir(join(pkg,'dist'),{recursive:true})
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:'onnxruntime-node',version:'1.30.0',main:'dist/index.js'}))
 await writeFile(join(pkg,'dist','index.js'),'module.exports={}')
 assert.equal(resolveRuntimeEntry(dir),await realpath(join(pkg,'dist','index.js')))
 assert.throws(()=>resolveRuntimeEntry(join(root,'missing')),/运行时/)
 // 受管目录里的包是指向别处的符号链接：拒绝
 const outside=join(root,'outside')
 await mkdir(join(outside,'dist'),{recursive:true})
 await writeFile(join(outside,'package.json'),JSON.stringify({name:'onnxruntime-node',version:'1.30.0',main:'dist/index.js'}))
 await writeFile(join(outside,'dist','index.js'),'module.exports={}')
 const linked=join(root,'linked')
 await mkdir(join(linked,'node_modules'),{recursive:true})
 await symlink(outside,join(linked,'node_modules','onnxruntime-node'))
 assert.throws(()=>resolveRuntimeEntry(linked),/运行时/)
})
