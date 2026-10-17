import {createRequire} from 'node:module'
import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {SubagentProvider,ResolvedSubagentStartRequest,SubagentRun} from '@deepseek-ai/dsh-subagent'
import type {SubprocessSpawnSpec} from '@deepseek-ai/dsh-subprocess'
import {WorkError} from '@teloa/contract'
import {isPlatformModelProvider,preparePlatformLaunch,type PlatformEngine,type PlatformModelAccess,type PlatformLaunch} from './platform-model-connection.ts'

type NativeConfig={providerName?:string;model?:string;env?:Record<string,string>;permissionMode?:string;disposeGraceMs?:number}
type NativeModule={apply:(ctx:Context,config:NativeConfig)=>void;Config:(config:unknown)=>unknown}
type Options={engine:PlatformEngine;native:NativeConfig;runtimeRoot:string;access:PlatformModelAccess}
const unavailable=()=>new WorkError('teloa/dependency-unavailable','平台模型执行适配尚未就绪，请核对扩展状态。')
const platformProviders=new WeakSet<SubagentProvider>()
export function isPlatformNativeProvider(provider:SubagentProvider):boolean{return platformProviders.has(provider)}
const blocked=/KEY|PASSWORD|SECRET|TOKEN|^HOME$|^USERPROFILE$|^XDG_|^CODEX_|^CLAUDE_|^ANTHROPIC_|^OPENAI_|^AWS_|^GOOGLE_|^GCLOUD_|^AZURE_|^DSH_|^NODE_OPTIONS$|^NODE_EXTRA_CA_CERTS$/i
const clean=(env:NodeJS.ProcessEnv|undefined)=>Object.fromEntries(Object.entries(env??{}).filter(([key,value])=>value!==undefined&&!blocked.test(key))) as Record<string,string>
function platformEnvironment(env:NodeJS.ProcessEnv|undefined,launch:PlatformLaunch):NodeJS.ProcessEnv{
 const result:NodeJS.ProcessEnv={...env}
 // 官方 subprocess 会再次合并 ambient env；保留 SDK 的删除项并显式删除个人路由开关。
 for(const name of new Set([...Object.keys(process.env),...Object.keys(env??{})]))if(blocked.test(name))result[name]=undefined
 return {...result,...launch.env}
}

/** 只接管官方公开 apply 的注册口；进程、协议、结果与资源释放仍完全由官方提供方执行。 */
function capture(ctx:Context,native:NativeModule,config:NativeConfig,launch?:PlatformLaunch):SubagentProvider{
 let captured:SubagentProvider|undefined
 const subprocess=ctx.subprocess
 const registration={registerProvider(provider:SubagentProvider){if(captured)throw unavailable();captured=provider;return ()=>{}}}
 const nativeContext=new Proxy(ctx,{get(target,key){
  if(key==='subagents')return registration
  if(key==='subprocess'&&launch)return {spawn(spec:SubprocessSpawnSpec){
   // SDK 公开生成的 argv 保留；平台模式明确关闭用户、项目与本地设置来源。
   const argv=[...spec.argv]
   if(launch.env.CLAUDE_CONFIG_DIR){
    if(argv.includes('--setting-sources')||argv.includes('--settings'))throw unavailable()
    argv.push('--setting-sources','')
   }
   return subprocess.spawn({...spec,argv,env:platformEnvironment(spec.env,launch)})
  }}
  return Reflect.get(target,key,target)
 }})
 native.apply(nativeContext,native.Config(config) as NativeConfig)
 if(!captured?.start||captured.prepareContinuable!==undefined)throw unavailable()
 return captured
}

export function createPlatformNativeProvider(ctx:Context,native:NativeModule,options:Options):SubagentProvider{
 const base=capture(ctx,native,{env:{},disposeGraceMs:3000,...options.native})
 const provider:SubagentProvider={
  name:base.name,capabilities:base.capabilities,inheritsParentContext:base.inheritsParentContext,
  async start(request:ResolvedSubagentStartRequest):Promise<SubagentRun>{
   if(!isPlatformModelProvider(request.parent.session.requestContext()?.provider))return base.start!(request)
   const lease=await options.access.acquire(options.engine,request.signal)
   const launch=await preparePlatformLaunch(lease,options.runtimeRoot,request.signal)
   const controller=new AbortController(),signal=AbortSignal.any([request.signal,controller.signal])
   let run:SubagentRun|undefined,disposal:Promise<void>|undefined
   const cancel=()=>{controller.abort();void run?.dispose().catch(()=>{})}
   const unsubscribe=options.access.subscribe(cancel)
   const dispose=()=>disposal??=(async()=>{try{if(run)await run.dispose()}finally{unsubscribe();await launch.dispose()}})()
   try{
    const provider=capture(ctx,native,{...options.native,providerName:base.name,model:launch.model,disposeGraceMs:options.native.disposeGraceMs??3000,env:{...clean(options.native.env),...launch.env}},launch)
    await launch.assertCurrent();signal.throwIfAborted()
    run=await provider.start!({...request,signal})
    if(signal.aborted){await dispose();signal.throwIfAborted()}
    const result=run.result.finally(dispose)
    return {id:run.id,result,dispose}
   }catch(error){await dispose();throw error}
  },
 }
 platformProviders.add(provider)
 return provider
}

export const name='teloa-platform-native-provider'
export const inject=['subagents','subprocess','settings','credentials','loader','teloaPlatformModels']
export const Config=z.object({engine:z.union([z.const('codex'),z.const('claude-code')]),native:z.any().default({})})

/** 可选包仍从当前官方 profile 解析；不检查 PATH、不安装第二份 CLI。 */
export async function apply(ctx:Context,config:{engine:PlatformEngine;native:NativeConfig}){
 const profile=ctx.get('profileContext') as {dir?:string}|undefined
 const platform=ctx.get('teloaPlatformModels') as {access:PlatformModelAccess;runtimeRoot:string}|undefined
 if(!profile?.dir||!platform)throw unavailable()
 const packageName=config.engine==='codex'?'@deepseek-ai/dsh-subagent-codex':'@deepseek-ai/dsh-subagent-claude-code'
 const require=createRequire(join(profile.dir,'package.json'))
 const manifest=JSON.parse(await readFile(require.resolve(packageName+'/package.json'),'utf8'))
 if(manifest.name!==packageName||manifest.version!=='0.2.1-rc.2')throw unavailable()
 const native=await ctx.loader.import(require.resolve(packageName)) as NativeModule
 ctx.subagents.registerProvider(createPlatformNativeProvider(ctx,native,{engine:config.engine,native:config.native,runtimeRoot:platform.runtimeRoot,access:platform.access}))
}
