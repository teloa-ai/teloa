import test from 'node:test'
import assert from 'node:assert/strict'
import type {TestContext} from 'node:test'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {feishuSdkRecipe,loadFeishuSdk} from '../src/channels/feishu-sdk.ts'
import {createAdapter} from '../src/channels/index.ts'
import {managedPackageAllowlist} from '../../harness-dsh/src/managed-package-install.ts'

async function tempDir(t:TestContext):Promise<string>{
 const dir=await mkdtemp(join(tmpdir(),'teloa-feishu-sdk-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 return dir
}

/** 与 1.74.0 lib/index.js 同形的最小导出：三个类 + 数值枚举 Domain（Feishu=0、Lark=1）。 */
const sdkBody='exports.Client=class{};exports.EventDispatcher=class{};exports.WSClient=class{};exports.Domain={Feishu:0,Lark:1,0:"Feishu",1:"Lark"};'

async function fakeInstall(dir:string,body:string){
 const pkg=join(dir,'node_modules','@larksuiteoapi','node-sdk')
 await mkdir(join(pkg,'lib'),{recursive:true})
 await writeFile(join(pkg,'package.json'),JSON.stringify({name:'@larksuiteoapi/node-sdk',version:'1.74.0',main:'./lib/index.js'}))
 await writeFile(join(pkg,'lib','index.js'),body)
}

test('feishuSdkRecipe 三字段逐字钉住版本与 integrity，且与 harness-dsh 受管安装白名单一致',()=>{
 assert.deepEqual({...feishuSdkRecipe},{package:'@larksuiteoapi/node-sdk',version:'1.74.0',integrity:'sha512-K2WoGy6x97u2kPPSFsu0v9X8CY+0q4OwO3rhXiOSRXYjGS7ovydFpEH07AS5VYcBnbQCoc5sGezo0IEGVViuoA=='})
 assert.ok(managedPackageAllowlist.some(entry=>entry.package===feishuSdkRecipe.package&&entry.version===feishuSdkRecipe.version&&entry.integrity===feishuSdkRecipe.integrity))
})

test('loadFeishuSdk(空目录) → teloa/dependency-unavailable「未安装」',async t=>{
 const dir=await tempDir(t)
 await assert.rejects(loadFeishuSdk(dir),(err:unknown)=>(err as {code?:string}).code==='teloa/dependency-unavailable'&&/未安装/.test((err as Error).message))
})

test('loadFeishuSdk：安装目录内的 CJS 包可加载并返回其导出',async t=>{
 const dir=await tempDir(t)
 await fakeInstall(dir,sdkBody+'exports.marker=42\n')
 const sdk=await loadFeishuSdk(dir) as unknown as {marker:number;Client:unknown}
 assert.equal(sdk.marker,42)
 assert.equal(typeof sdk.Client,'function')
})

test('loadFeishuSdk：导出缺 Client/EventDispatcher/WSClient 视为损坏 → teloa/dependency-unavailable',async t=>{
 const dir=await tempDir(t)
 await fakeInstall(dir,'exports.Client=class{}\n')
 await assert.rejects(loadFeishuSdk(dir),{code:'teloa/dependency-unavailable'})
})

test('loadFeishuSdk：缺 Domain 或 Domain 不是官方两值（Feishu=0、Lark=1）视为损坏 → teloa/dependency-unavailable',async t=>{
 for(const domain of ['',"exports.Domain={Feishu:'https://evil.example',Lark:1};","exports.Domain={Feishu:0};"]){
  const dir=await tempDir(t)
  await fakeInstall(dir,'exports.Client=class{};exports.EventDispatcher=class{};exports.WSClient=class{};'+domain+'\n')
  await assert.rejects(loadFeishuSdk(dir),{code:'teloa/dependency-unavailable'},domain)
 }
})

test('createAdapter：lark 与 feishu 都走飞书适配器（须带 loadSdk），id 各为自身种类；缺 loadSdk 时同样报未安装',()=>{
 const deps={env:async()=>({}),log:{info(){},warn(){}},now:()=>new Date(0),loadSdk:async()=>{throw new Error('unused')}}
 assert.equal(createAdapter('feishu',deps).id,'feishu')
 const lark=createAdapter('lark',deps)
 assert.deepEqual([lark.id,lark.label],['lark','Lark'])
 assert.throws(()=>createAdapter('lark',{env:deps.env,log:deps.log,now:deps.now}),{code:'teloa/dependency-unavailable'})
})
