import {totalmem} from 'node:os'
import {extname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import type {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-subprocess'
import {embeddingDefaultVariant} from '@teloa/contract'
import {securityEnv} from '@teloa/harness-dsh/launch-env'
import {dshHomePath} from '@deepseek-ai/dsh-home-paths'
import {assetsCacheDir,inspectAssets,prepareAssets,variantFiles,type AssetsManifest,type EmbeddingVariant} from './assets.ts'
import {startWorkerEngine} from './engine.ts'
import {memoryPolicy,ortSessionOptions} from './memory-policy.ts'
import {embeddingCatalogId,embeddingCatalogVersion,embeddingProfile,profileHash} from './profile.ts'
import {createRuntimeStage} from './runtime.ts'
import {createEmbeddingProvider,createEmbeddingService,type TeloaEmbeddingService} from './service.ts'
import assetsManifest from '../runtime/assets.json' with {type:'json'}
import {retrievalPreparationDetails} from './preparation-details.ts'

export type {TeloaEmbeddingService} from './service.ts'
export const name='teloa-local-embedding'
/**
 * subprocess：推理子进程由宿主 `ctx.subprocess` 拥有；teloaWork：取宿主运行目录，运行时装在 `runtimeRoot/packages`
 * （与受管 MCP、按需 SDK 同一套 `installManagedPackage` 与启动清扫）。服务 `teloaEmbedding` 供宿主经 `ctx.reflect.get` 发现。
 */
export const inject=['subprocess','teloaWork'] as const
export const embeddingProviderId='qwen3-embedding-0.6b'

declare module '@deepseek-ai/cordis'{interface Context{teloaEmbedding:TeloaEmbeddingService}}

/** 只供测试注入；宿主装载时不传。 */
export type LocalEmbeddingOptions={homePath?:(...segments:string[])=>string;totalmem?:number;env?:Record<string,string|undefined>}

/**
 * 发行默认 fp32（关键决定 9）；int8 只在验收宿主（TELOA_BROWSER_ACCEPTANCE=1）且两个验收开关都打开时供 功能验证 并测。
 * 宿主装载时 env 取 securityEnv(ctx)：只认启动进程层，工作区 .env 写这些名字不生效。
 */
export function selectVariant(env:Readonly<Record<string,string|undefined>>):EmbeddingVariant{
 return env.TELOA_BROWSER_ACCEPTANCE==='1'&&env.TELOA_LOCAL_EMBEDDING_ACCEPTANCE==='1'&&env.TELOA_LOCAL_EMBEDDING_VARIANT==='int8'?'int8':embeddingDefaultVariant
}

/** 启用只检查运行时目录与模型缓存，不下载、不安装、不加载；准备只经界面确认后的端点调用 `prepare`。 */
export function apply(ctx:Context,options:LocalEmbeddingOptions={}):void{
 const work=Reflect.get(ctx,'teloaWork') as {runtimeRoot:string}
 const manifest=assetsManifest as AssetsManifest
 const variant=selectVariant(options.env??securityEnv(ctx))
 const files=variantFiles(manifest,variant)
 const cacheDir=assetsCacheDir(manifest,variant,options.homePath??dshHomePath)
 const runtime=createRuntimeStage(work.runtimeRoot)
 const policy=memoryPolicy(options.totalmem??totalmem())
 const profile=manifest.profile
 const model=files.find(file=>file.path.endsWith('.onnx'))!
 // 开发态从 src/worker.ts（类型剥离）启动，发行包从 lib/worker.js 启动。
 const workerPath=fileURLToPath(new URL('./worker'+extname(fileURLToPath(import.meta.url)),import.meta.url))
 const provider=createEmbeddingProvider({
  preparationDetails:retrievalPreparationDetails(variant,cacheDir,runtime.dir),
  id:embeddingProviderId,catalogId:embeddingCatalogId,catalogVersion:embeddingCatalogVersion,variant,profileHash:profileHash(embeddingProfile(manifest,variant)),
  runtime:{resource:`${runtime.recipe.package}@${runtime.recipe.version}`,source:'registry.npmjs.org',check:runtime.check,install:runtime.install},
  assets:{
   resource:files[0]!.path,
   inspect:()=>inspectAssets(cacheDir,files),
   prepare:(signal,onProgress,source)=>prepareAssets({dir:cacheDir,files,allowedHosts:manifest.allowedHosts,redirectHosts:manifest.redirectHosts,source,mirrors:manifest.mirrors,signal,onProgress}),
  },
  startEngine:signal=>startWorkerEngine({spawn:spec=>ctx.subprocess.spawn(spec),workerPath,cwd:cacheDir,signal,config:{
   runtimeDir:runtime.dir,modelPath:join(cacheDir,model.path),tokenizerPath:join(cacheDir,'tokenizer.json'),tokenizerConfigPath:join(cacheDir,'tokenizer_config.json'),
   maxTokens:profile.maxTokens,appendedTokenId:profile.appendedTokenId,padTokenId:profile.padTokenId,queryInstruction:profile.queryInstruction,documentPrefix:profile.documentPrefix,
   kvLayers:profile.kvLayers,kvHeads:profile.emptyKvShape[1]!,headDim:profile.emptyKvShape[3]!,batchSize:policy.batchSize,dimensions:profile.dimensions,
   // 发行宿主只取清单里该变体的值（缺省空对象）；验收覆盖开关只在独立验收脚本里生效。
   sessionOptions:ortSessionOptions(manifest.sessionOptions?.[variant]),
  }}),
  idleTimeoutMs:policy.idleTimeoutMs,
  totalMemoryBytes:options.totalmem??totalmem(),
  // 日志只记阶段与错误类别，不记路径、下载地址或文本。
  onChange:state=>{if(state.phase==='failed')ctx.logger.warn(`本地检索模型准备失败（${state.download?.reason??'load'}）。`)},
 })
 ctx.effect(()=>()=>provider.dispose())
 ctx.provide('teloaEmbedding',createEmbeddingService([provider]))
}
