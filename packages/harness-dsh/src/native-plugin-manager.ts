import {readFile,realpath,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import PluginManager,{type Config,type PluginInfo,type BundleInfo,type ChangeResult,type InstallBundleOptions} from '@deepseek-ai/dsh-plugin-manager'
import {bundledExtensions,isReservedOfficialPackage} from '@teloa/contract'
import {deniedPatchRowIds} from './dsh-plugin-install-adapter.ts'
import {pendingPackageNames,readJsonFile,readPendingPlugins,withProfileLock,writeAtomic} from './pending-plugins.ts'

const requiredModules=new Set(['@teloa/harness-dsh','@teloa/client-ui-workbench','@teloa/harness-dsh/plugin-manager','@teloa/im-gateway','@teloa/local-embedding','@teloa/harness-dsh/credentials','@teloa/harness-dsh/attachment-guard','@teloa/harness-dsh/session-model-scope','@teloa/harness-dsh/tool-resource-provenance'])
const requiredBundles=new Set(['@teloa/bundle','@teloa/im-gateway','@deepseek-ai/dsh-experimental-agent-team-profile'])
const requiredRows=new Set(['teloa-harness-dsh','teloa-ui-workbench','teloa-reference-mcp','teloa-agent-preset','teloa-native-webserver','teloa-native-gateway','teloa-install-runtime','teloa-plugin-manager','teloa-im-gateway','teloa-local-embedding','teloa-credentials','teloa-attachment-guard','teloa-session-model-scope','teloa-tool-resource-provenance','agent-team','tool-agent-team','ui-agent-team'])

/** 原生管理器没有产品级必需行策略；只补这一层，安装、锁、回滚和配置仍由官方实现。 */
export function protectedNativePlugin(row:{patchId?:string;entryId?:string;moduleName:string}):boolean{
 const id=row.patchId??row.entryId?.split(':').at(-1)
 return requiredModules.has(row.moduleName)||(id!==undefined&&(requiredRows.has(id)||deniedPatchRowIds.has(id)))
}
export const pendingNativeBundle=(pending:Readonly<Record<string,string>>,name:string):boolean=>pendingPackageNames(pending).includes(name)
/** 可选官方扩展只经市场「扩展」启停（bundled-extensions/set 核对来源、改 bundles，并在前后复验安全钉的前提下即时套用）；原生页不开热切换，本宿主也不开 hmr。 */
const marketManagedBundles=new Set(bundledExtensions.filter(row=>row.id!=='im-gateway').map(row=>row.packageName.toLowerCase()))
/** 不区分大小写：`@Teloa/im-gateway` 在 macOS/Windows 默认文件系统下解析到同一官方目录。 */
export const marketManagedBundle=(name:string):boolean=>marketManagedBundles.has(name.toLowerCase())
/** `@teloa/` 作用域只随 Teloa 发行；任何从原生扩展管理安装同作用域包的规格都拒收（不区分大小写：macOS 文件系统下 `@Teloa/x` 与官方包落同一目录）。只看规格文本，是第一道闸；别名、tarball 等绕过由安装后核对兜底，真正防线是启动前来源核对。 */
export const reservedInstallSpec=(spec:string):boolean=>/(?:^|[\s:/])@teloa\//i.test(spec.trim())
/** 安装前后 profile 里 `@teloa/` 依赖（不区分大小写）的差异（新增、改写或删除）；非空即回滚。 */
export const teloaDependencyDrift=(before:Record<string,unknown>,after:Record<string,unknown>):string[]=>
 [...new Set([...Object.keys(before),...Object.keys(after)])].filter(name=>isReservedOfficialPackage(name)&&before[name]!==after[name])

type PnpmResult={exitCode:number|null;timedOut?:boolean;output?:string}
type PnpmRun=(args:string[],signal?:AbortSignal,requestId?:string)=>Promise<PnpmResult>
const dependencies=(manifest:Record<string,unknown>):Record<string,unknown>=>typeof manifest.dependencies==='object'&&manifest.dependencies!==null?manifest.dependencies as Record<string,unknown>:{}
const optionalText=(path:string):Promise<string|undefined>=>readFile(path,'utf8').catch((error:unknown)=>{
 if(typeof error==='object'&&error!==null&&'code' in error&&error.code==='ENOENT')return undefined
 throw error
})
/** 本次 `pnpm add` 改动的依赖里，键名或装进 node_modules 的清单 name 落在 `@teloa/` 作用域的那些（别名、tarball 内包名都算）。 */
async function reservedInstallHits(profileDir:string,before:Record<string,unknown>,after:Record<string,unknown>):Promise<string[]>{
 const hits=teloaDependencyDrift(before,after)
 for(const name of Object.keys(after).filter(name=>before[name]!==after[name]&&!hits.includes(name))){
  const manifest=await readJsonFile(join(profileDir,'node_modules',name,'package.json')).catch(()=>({} as Record<string,unknown>))
  if(typeof manifest.name==='string'&&isReservedOfficialPackage(manifest.name))hits.push(name)
 }
 return hits
}
/** 回滚后逐个核对实链：安装前是 `link:` 的必须指回原目标，安装前没有的必须不存在。 */
async function linksRestored(profileDir:string,before:Record<string,unknown>,names:readonly string[]):Promise<boolean>{
 for(const name of names){
  const spec=before[name],actual=await realpath(join(profileDir,'node_modules',name)).catch(()=>undefined)
  if(spec===undefined?actual!==undefined:typeof spec!=='string'||!spec.startsWith('link:')||actual===undefined||actual!==await realpath(resolve(profileDir,spec.slice(5))).catch(()=>undefined))return false
 }
 return true
}

export default class TeloaPluginManager extends PluginManager{
 private readonly profileDir:string
 /** 本次安装被 guardedPnpm 拒收的原因；只在 withProfileLock 内读写。 */
 private reservedInstall:string|undefined=undefined
 constructor(ctx:Context,config:Config){
  super(ctx,config)
  const profile:unknown=Reflect.get(ctx,'profileContext')
  if(!profile||typeof profile!=='object'||!('dir' in profile)||typeof profile.dir!=='string')throw Error('Teloa 原生扩展管理需要受管 profile。')
  this.profileDir=profile.dir
  // 官方 installBundle 在 `pnpm add` 成功后才解析包名、选择并热加载 bundle，没有公开钩子；在实例上包一层 runPnpm，
  // 让 @teloa/ 作用域核对落在选择与热加载之前。官方版本已钉死，形态不符即拒绝构造，宁可没有扩展管理也不放过核对。
  const run:unknown=Reflect.get(this,'runPnpm')
  if(typeof run!=='function')throw Error('Teloa 原生扩展管理与官方扩展管理器版本不符：缺少 runPnpm。')
  Reflect.set(this,'runPnpm',(args:string[],signal?:AbortSignal,requestId?:string)=>this.guardedPnpm((run as PnpmRun).bind(this),args,signal,requestId))
 }
 override async listPlugins():Promise<PluginInfo[]>{
  return (await super.listPlugins()).map(row=>{
   if(!protectedNativePlugin(row))return row
   const {patchId:_patchId,...rest}=row
   return {...rest,readOnlyReason:'management-required'}
  })
 }
 override async listBundles():Promise<BundleInfo[]>{
  const pending=await readPendingPlugins(this.profileDir)
  return (await super.listBundles()).map(bundle=>requiredBundles.has(bundle.name.toLowerCase())||marketManagedBundle(bundle.name)||pendingNativeBundle(pending,bundle.name)?{...bundle,removable:false,readOnlyReason:'management-required'}:bundle)
 }
 override async setBundleEnabled(name:string,enabled:boolean):Promise<ChangeResult>{
  return withProfileLock(this.profileDir,async()=>{
   if(name.toLowerCase()==='@teloa/im-gateway')return this.refused(name,'enable','IM 通道是内置能力；请在设置中管理具体渠道。')
   if(marketManagedBundle(name))return this.refused(name,'enable','该可选官方扩展请到市场「扩展」里启用或停用。')
   if(await this.unregisteredReserved(name))return this.refused(name,'enable','@teloa/ 作用域只接受 profile 里已登记的官方包名。')
   if(requiredBundles.has(name.toLowerCase())&&!enabled)return this.refused(name,'enable','Teloa 必需组件不能在扩展管理中停用。')
   if(enabled&&pendingNativeBundle(await readPendingPlugins(this.profileDir),name))return this.refused(name,'enable','此扩展有待核对的市场安装记录，请从市场的已添加列表完成启用。')
   return super.setBundleEnabled(name,enabled)
  })
 }
 override async installBundle(spec:string,options?:InstallBundleOptions):Promise<ChangeResult>{
  // 官方安装完成后直接选择 bundle，不经 setBundleEnabled；重装还会改掉旧 pending 固定的补丁字节。
  // 与市场安装共用 profile 队列，在解析和执行包管理器前核对；无旧记录时完整保留官方安装语义。
  return withProfileLock(this.profileDir,async()=>{
   if(reservedInstallSpec(spec))return this.refused(spec,'install','@teloa/ 作用域的包只随 Teloa 发行，不能从扩展管理安装。')
   if(Object.keys(await readPendingPlugins(this.profileDir)).length)return this.refused(spec,'install','有待处理的市场安装记录，请先到市场“已添加”完成或处理安装，再添加原生扩展。')
   this.reservedInstall=undefined
   const result=await super.installBundle(spec,options)
   const rejection=this.reservedInstall
   this.reservedInstall=undefined
   return rejection===undefined?result:{...this.refused(spec,'install',rejection),changed:result.changed}
  })
 }
 override async removeBundle(name:string):Promise<ChangeResult>{
  return withProfileLock(this.profileDir,async()=>{
   if(marketManagedBundle(name))return this.refused(name,'remove','该可选官方扩展请到市场「扩展」里停用。')
   if(await this.unregisteredReserved(name))return this.refused(name,'remove','@teloa/ 作用域只接受 profile 里已登记的官方包名。')
   if(requiredBundles.has(name.toLowerCase()))return this.refused(name,'remove','Teloa 必需组件不能在扩展管理中移除。')
   if(pendingNativeBundle(await readPendingPlugins(this.profileDir),name))return this.refused(name,'remove','此扩展有待核对的市场安装记录，请先在市场处理该记录。')
   return super.removeBundle(name)
  })
 }
 /**
  * 规格文本之外的绕过（别名、tarball 内包名）：`pnpm add` 成功后、官方选择与热加载之前核对。
  * 命中即恢复 package.json 与 lock、摘掉命中的 node_modules 条目并按旧 lock 重装，再逐个核对实链；
  * 重装或核对失败时命中条目保持移除（启动前来源与实链核对会拦下或补装），绝不留下指向第三方内容的官方包名。
  * 回滚挡不住包管理器阶段之前已执行的代码；返回失败让官方流程不再选择、不再热加载。
  */
 private async guardedPnpm(run:PnpmRun,args:string[],signal?:AbortSignal,requestId?:string):Promise<PnpmResult>{
  if(args[0]!=='add')return run(args,signal,requestId)
  const manifestPath=join(this.profileDir,'package.json'),lockPath=join(this.profileDir,'pnpm-lock.yaml')
  const saved=[[manifestPath,await optionalText(manifestPath)],[lockPath,await optionalText(lockPath)]] as const
  const before=dependencies(await readJsonFile(manifestPath))
  const result=await run(args,signal,requestId)
  if(result.exitCode!==0||result.timedOut===true)return result
  const hits=await reservedInstallHits(this.profileDir,before,dependencies(await readJsonFile(manifestPath)))
  if(!hits.length)return result
  for(const [path,text] of saved)if(text===undefined)await rm(path,{force:true});else await writeAtomic(path,text)
  const evict=()=>Promise.all(hits.map(name=>rm(join(this.profileDir,'node_modules',name),{recursive:true,force:true})))
  await evict()
  const repaired=await run(['install',saved[1][1]===undefined?'--config.lockfile=false':'--frozen-lockfile'],undefined,requestId)
  const restored=repaired.exitCode===0&&repaired.timedOut!==true&&await linksRestored(this.profileDir,before,hits)
  if(!restored)await evict()
  this.reservedInstall=restored
   ?'安装结果落在 @teloa/ 作用域（'+hits.join('、')+'），已拒收并恢复 package.json、pnpm-lock.yaml 与 node_modules；该作用域只随 Teloa 发行。'
   :'安装结果落在 @teloa/ 作用域（'+hits.join('、')+'），已拒收并恢复 package.json 与 pnpm-lock.yaml，但未能重装依赖目录，已将其移除；重启 Teloa 时会核对来源并补回随附扩展的官方链接，其它官方包缺失请重新运行安装准备。'
  return {...result,exitCode:1,output:this.reservedInstall}
 }
 private async unregisteredReserved(name:string):Promise<boolean>{
  return isReservedOfficialPackage(name)&&!Object.hasOwn(dependencies(await readJsonFile(join(this.profileDir,'package.json'))),name)
 }
 private refused(target:string,stage:'enable'|'remove'|'install',diagnostic:string):ChangeResult{
  return {changed:false,application:'failed',target,stage,error:{code:'management-required',diagnostic}}
 }
}
