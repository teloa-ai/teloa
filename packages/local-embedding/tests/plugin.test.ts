import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import {mkdir,mkdtemp,readdir,rm,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import {embeddingProfile,profileHash} from '../src/profile.ts'
import {assetsCacheDir,type AssetsManifest} from '../src/assets.ts'
import {retrievalPreparationDetails} from '../src/preparation-details.ts'
import assets from '../runtime/assets.json' with {type:'json'}

test('插件：inject subprocess 与 teloaWork；启用只检查（不 spawn、不安装、不下载），缺缓存为 unprepared；停用撤服务且不动运行时与缓存',async t=>{
 assert.equal(plugin.name,'teloa-local-embedding')
 assert.deepEqual([...plugin.inject],['subprocess','teloaWork'])
 const root=await mkdtemp(join(tmpdir(),'teloa-embed-plugin-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const home=(...segments:string[])=>join(root,'dsh-home',...segments)
 const cache=assetsCacheDir(assets as AssetsManifest,'fp32',home)
 await mkdir(cache,{recursive:true})
 await writeFile(join(cache,'tokenizer.json'),'partial')
 await mkdir(join(root,'runtime','packages','onnxruntime-node@1.30.0'),{recursive:true})
 const spawned:unknown[]=[]
 const ctx=new Context()
 ctx.provide('teloaWork',{runtimeRoot:join(root,'runtime')})
 ctx.provide('subprocess',{spawn:(spec:unknown)=>{spawned.push(spec);throw new Error('不应启动子进程')}})
 const fiber=ctx.plugin(plugin,{homePath:home,totalmem:8*1024**3,env:{}})
 await fiber
 const service=ctx.get('teloaEmbedding') as plugin.TeloaEmbeddingService
 assert.ok(service)
 for(let i=0;i<200&&service.snapshot().providers[0]!.preparation.phase==='checking';i++)await new Promise(done=>setTimeout(done,5))
 assert.deepEqual(service.snapshot(),{providers:[{id:'qwen3-embedding-0.6b',location:'host-local',catalogId:'teloa.model.qwen3-embedding-0-6b',catalogVersion:'1.0.0',profileHash:profileHash(embeddingProfile(assets as AssetsManifest,'fp32')),variant:'fp32',totalMemoryBytes:8*1024**3,memoryRisk:true,preparation:{phase:'unprepared'},preparationDetails:retrievalPreparationDetails('fp32',cache,join(root,'runtime','packages','onnxruntime-node@1.30.0'))}]})
 await assert.rejects(service.embed('qwen3-embedding-0.6b',{kind:'query',texts:['报销']},new AbortController().signal),{code:'teloa/dependency-unavailable'})
 assert.equal(spawned.length,0)
 await fiber.dispose()
 assert.equal(ctx.get('teloaEmbedding'),undefined)
 assert.deepEqual(await readdir(cache),['tokenizer.json'])
 assert.ok(existsSync(join(root,'runtime','packages','onnxruntime-node@1.30.0')))
})

test('验收开关只认启动进程层：工作区 .env 写 ACCEPTANCE=1、VARIANT=int8（连同 TELOA_BROWSER_ACCEPTANCE=1）仍为 fp32',async t=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-embed-env-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const {createLaunchEnvironmentSnapshot}=await import(pathToFileURL(createRequire(new URL('../../harness-dsh/package.json',import.meta.url)).resolve('@deepseek-ai/dsh-launch-environment')).href) as {createLaunchEnvironmentSnapshot:(layers:unknown[])=>unknown}
 const dotenv={TELOA_BROWSER_ACCEPTANCE:'1',TELOA_LOCAL_EMBEDDING_ACCEPTANCE:'1',TELOA_LOCAL_EMBEDDING_VARIANT:'int8'}
 // DSH 启动时会把工作区 .env 合入 process.env：这里同样合入，证明扩展不读 process.env
 const saved=Object.fromEntries(Object.keys(dotenv).map(name=>[name,process.env[name]]))
 Object.assign(process.env,dotenv)
 t.after(()=>{for(const [name,value] of Object.entries(saved))if(value===undefined)delete process.env[name];else process.env[name]=value})
 const mount=async(layers:unknown[])=>{
  const ctx=new Context()
  ctx.provide('launchEnvironment',createLaunchEnvironmentSnapshot(layers))
  ctx.provide('teloaWork',{runtimeRoot:join(root,'runtime')})
  ctx.provide('subprocess',{spawn:()=>{throw new Error('不应启动子进程')}})
  const fiber=ctx.plugin(plugin,{homePath:(...segments:string[])=>join(root,'home',...segments),totalmem:16*1024**3})
  await fiber
  const variant=(ctx.get('teloaEmbedding') as plugin.TeloaEmbeddingService).snapshot().providers[0]!.variant
  await fiber.dispose()
  return variant
 }
 assert.equal(await mount([{source:'process',values:{}},{source:'project-env',path:join(root,'.env'),values:dotenv}]),'fp32')
 // 启动进程层给出（验收宿主）才生效
 assert.equal(await mount([{source:'process',values:dotenv}]),'int8')
})

test('变体选择：默认 fp32（与契约 embeddingDefaultVariant、assets.json defaultVariant 一致）；只有验收宿主下验收开关与 int8 同时打开才用 int8',()=>{
 assert.equal((assets as AssetsManifest).defaultVariant,'fp32')
 assert.equal(plugin.selectVariant({}),'fp32')
 assert.equal(plugin.selectVariant({TELOA_LOCAL_EMBEDDING_VARIANT:'int8'}),'fp32')
 assert.equal(plugin.selectVariant({TELOA_LOCAL_EMBEDDING_ACCEPTANCE:'1'}),'fp32')
 assert.equal(plugin.selectVariant({TELOA_LOCAL_EMBEDDING_ACCEPTANCE:'1',TELOA_LOCAL_EMBEDDING_VARIANT:'int8'}),'fp32','非验收宿主不生效')
 assert.equal(plugin.selectVariant({TELOA_BROWSER_ACCEPTANCE:'1',TELOA_LOCAL_EMBEDDING_ACCEPTANCE:'1',TELOA_LOCAL_EMBEDDING_VARIANT:'int8'}),'int8')
})
