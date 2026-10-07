import {readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {totalmem} from 'node:os'
import {WorkError,bundledExtensions,embeddingDefaultVariant,embeddingMemoryRisk,readBundledExtensionSetInput,taskInput,type BundledExtensionId,type BundledExtensionState,type BundledExtensionView} from '@teloa/contract'
import {configuredImChannels,bundledRowIds,bundledSourceMismatch,setBundledExtensionLocked} from './bundled-extensions-profile.ts'
import {BundledHotApplyError,bundledHotApplyWorkError,type BundledHotApplyResult} from './bundled-extensions-apply.ts'
import {profileBundles,readJsonFile,withProfileLock,writeAtomic} from './pending-plugins.ts'

export function bundledExtensionState(input:{inBundles:boolean;atStart:boolean;loaded:boolean}):BundledExtensionState{
 if(input.inBundles)return input.loaded?'active':input.atStart?'failed':'enable-pending'
 return input.loaded?'disable-pending':'available'
}
/**
 * loaded：本进程里该扩展是否已挂接（按包名：IM 通道即 teloaWork.extensionAttached，本地检索即 teloaEmbedding 已提供）；bundlesAtStart：装配期读到的 bundles。
 * apply：即时启停（bundled-extensions-apply.ts）；调用时已持有 profile 锁、bundles 已写成目标状态。缺省即不支持热套用，一律重启生效。
 */
export type BundledExtensionDeps={profileDir:string;programRoot:string;runtimeRoot:string;bundlesAtStart:readonly string[];loaded:(packageName:string)=>boolean;version:(packageName:string)=>Promise<string>
 apply?:(change:{packageName:string;rowId:string;enabled:boolean})=>Promise<BundledHotApplyResult>
 /** 宿主物理内存（测试注入；缺省 os.totalmem()）：本地中文检索一行据此给出 memoryRisk。 */
 totalMemoryBytes?:number}

export function createBundledExtensionHandler(deps:BundledExtensionDeps){
 // 本进程应当已加载的扩展：装配期 bundles，加上热套用成功启用的（停用成功即移出）。只有在这里面的扩展，挂接才算数。
 const expected=new Set(deps.bundlesAtStart)
 const view=async(id:BundledExtensionId):Promise<BundledExtensionView>=>{
  const entry=bundledExtensions.find(row=>row.id===id)!
  let bundles:string[]
  try{bundles=profileBundles(await readJsonFile(join(deps.profileDir,'package.json')))}
  catch{throw new WorkError('teloa/storage-unavailable','DSH profile 清单暂时不可读，无法核对官方扩展状态。')}
  return {id:entry.id,packageName:entry.packageName,version:await deps.version(entry.packageName),
   // loaded 同时要求本进程应当已加载（装配期在组合里或热套用启用成功）：IM 在挂接窗口外本就被封锁，这里再防一层。
   state:bundledExtensionState({inBundles:bundles.includes(entry.packageName),atStart:expected.has(entry.packageName),loaded:expected.has(entry.packageName)&&deps.loaded(entry.packageName)}),
   // 读不了只影响停用确认里的数量提示，按 0 显示，不作授权依据；渠道数只对 IM 通道有意义。
   configuredChannels:entry.id==='im-gateway'?await configuredImChannels(deps.runtimeRoot).catch(()=>0):0,
   // 启用前扩展尚未加载，按发行默认变体判断；准备确认卡另以扩展快照里的实际变体为准。
   ...(entry.id==='local-embedding'?{memoryRisk:embeddingMemoryRisk({totalMemoryBytes:deps.totalMemoryBytes??totalmem(),variant:embeddingDefaultVariant})}:{})}
 }
 return async(endpoint:string,payload:unknown):Promise<unknown>=>{
  if(endpoint==='bundled-extensions/list'){taskInput(payload,[]);return Promise.all(bundledExtensions.map(row=>view(row.id)))}
  if(endpoint==='bundled-extensions/set'){
   const input=readBundledExtensionSetInput(payload)
   if(input.extensionId==='im-gateway'&&!input.enabled)throw new WorkError('teloa/forbidden','IM 通道是内置能力；请在设置中停用具体渠道。')
   const entry=bundledExtensions.find(row=>row.id===input.extensionId)!
   // 同一把 profile 锁串行：并发点击、原生扩展管理与市场安装逐个进行，写盘与热套用之间不会插进别的改动。
   await withProfileLock(deps.profileDir,async()=>{
    const manifestPath=join(deps.profileDir,'package.json')
    let before:string
    try{before=await readFile(manifestPath,'utf8');await setBundledExtensionLocked(deps.profileDir,deps.programRoot,entry.packageName,input.enabled)}
    catch(error){
     if(error instanceof Error&&error.message===bundledSourceMismatch)throw new WorkError('teloa/forbidden',bundledSourceMismatch)
     throw new WorkError('teloa/storage-unavailable','DSH profile 清单写入失败，官方扩展状态未改变。')
    }
    if(!deps.apply)return
    let result:BundledHotApplyResult
    try{result=await deps.apply({packageName:entry.packageName,rowId:bundledRowIds[entry.packageName]!,enabled:input.enabled})}
    catch(error){
     // 运行中组合已由 apply 恢复到调用前那一代；这里把 bundles 也恢复原样，下次启动与本次调用前一致。
     await writeAtomic(manifestPath,before).catch(()=>{})
     if(error instanceof BundledHotApplyError)throw bundledHotApplyWorkError(error)
     throw new WorkError('teloa/dependency-unavailable','即时'+(input.enabled?'启用':'停用')+'没有完成，官方扩展状态未改变。')
    }
    if(result==='applied'){if(input.enabled)expected.add(entry.packageName);else expected.delete(entry.packageName)}
   })
   return view(input.extensionId)
  }
  throw new WorkError('teloa/not-found','未提供此官方扩展接口。')
 }
}
