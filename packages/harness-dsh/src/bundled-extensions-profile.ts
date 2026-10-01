/**
 * 随附官方扩展在 DSH profile 一侧的唯一读写点（启停、来源核对、升级迁移）。
 * 与 pending-plugins.ts 一样不依赖 `@teloa/contract`：启动脚本按类型剥离直接导入。
 */
import {readFile,realpath} from 'node:fs/promises'
import {isAbsolute,join,resolve} from 'node:path'
import {profileBundles,readJsonFile,rewriteProfileBundlesLocked,withProfileLock,writeAtomic} from './pending-plugins.ts'

export const IM_GATEWAY_PACKAGE='@teloa/im-gateway'
export const LOCAL_EMBEDDING_PACKAGE='@teloa/local-embedding'
const TELOA_BUNDLE='@teloa/bundle'
export const BUNDLED_EXTENSIONS_FILE='teloa-官方扩展.json'
const MIGRATION_KEY='im-gateway-optional-v1'
/** 无原型对象：`toString`、`constructor` 这类名字不会从原型链上查到。 */
const directories:Readonly<Record<string,string>>=Object.assign(Object.create(null) as Record<string,string>,{[IM_GATEWAY_PACKAGE]:'packages/im-gateway',[LOCAL_EMBEDDING_PACKAGE]:'packages/local-embedding'})
/** 各随附包 bundle 补丁插入的那一行 id（与 packages/<包>/cordis.patch.yml 一致）；即时启停只接受恰好这一行 `{id,name}` 的变化。 */
export const bundledRowIds:Readonly<Record<string,string>>=Object.assign(Object.create(null) as Record<string,string>,{[IM_GATEWAY_PACKAGE]:'teloa-im-gateway',[LOCAL_EMBEDDING_PACKAGE]:'teloa-local-embedding'})
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)

export const bundledSourceMismatch='官方扩展来源与本程序随附的目录不一致，已拒绝启用。'
export const bundledSourceRefusal='DSH profile 里的官方扩展来源不是本程序随附的目录，宿主拒绝启动；请重新运行安装准备后再启动。'
const markerUnreadable='DSH profile 的官方扩展迁移记录不可读，已停止；请核对该文件后重试。'

async function officialSource(profileDir:string,manifest:Record<string,unknown>,packageName:string,programRoot:string):Promise<boolean>{
 const directory=directories[packageName]
 const dependencies=record(manifest.dependencies)?manifest.dependencies:{}
 const spec=dependencies[packageName]
 if(directory===undefined||typeof spec!=='string'||!spec.startsWith('link:'))return false
 const target=spec.slice('link:'.length)
 try{return await realpath(isAbsolute(target)?target:resolve(profileDir,target))===await realpath(join(programRoot,directory))}
 catch{return false}
}

/** 调用方必须已经持有 `withProfileLock`。启用前核对来源；停用不核对（只朝更安全的方向改）。 */
export async function setBundledExtensionLocked(profileDir:string,programRoot:string,packageName:string,enabled:boolean):Promise<void>{
 if(directories[packageName]===undefined)throw Error(bundledSourceMismatch)
 if(enabled&&!await officialSource(profileDir,await readJsonFile(join(profileDir,'package.json')),packageName,programRoot))throw Error(bundledSourceMismatch)
 await rewriteProfileBundlesLocked(profileDir,bundles=>enabled?withBundledExtension(bundles,packageName):bundles.filter(name=>name!==packageName))
}
/**
 * 插在 `@teloa/bundle` 之后、任何第三方 bundle 之前（找不到才追加到末尾）：装配按 bundles 顺序进行，
 * IM 必须先于第三方拿到 `teloaWork` 的一次性挂接权，与它原先随 `@teloa/bundle` 装配时的顺序一致。
 */
function withBundledExtension(bundles:string[],packageName:string):string[]{
 if(bundles.includes(packageName))return bundles
 const index=bundles.indexOf(TELOA_BUNDLE)
 return index<0?[...bundles,packageName]:[...bundles.slice(0,index+1),packageName,...bundles.slice(index+1)]
}
export function setBundledExtension(profileDir:string,programRoot:string,packageName:string,enabled:boolean):Promise<void>{
 return withProfileLock(profileDir,()=>setBundledExtensionLocked(profileDir,programRoot,packageName,enabled))
}

/** 与契约 `isReservedOfficialPackage` 同一判定（本文件不依赖契约）：`@teloa/` 作用域，不区分大小写。 */
const reservedScope=(name:string):boolean=>/^@teloa\//i.test(name)
/** 允许出现在组合里的 `@teloa/` 包：组合本体、原生能力两个可选组合（scripts/runtime/profile.mjs 的 optionalNativeBundleSpecs），以及随附扩展（directories）。 */
const officialBundles=new Set([TELOA_BUNDLE,'@teloa/native-browser','@teloa/native-computer'])
/**
 * 已进组合、但来源不是本程序随附目录的官方扩展，以及白名单之外的 `@teloa/` 包；非空即拒绝启动。
 * 保留作用域按白名单放行：大小写变体（如 `@Teloa/im-gateway`，macOS/Windows 默认文件系统下与官方目录是同一处）
 * 与手改出来的 `@teloa/evil` 一律算冲突。
 */
export async function bundledSourceConflicts(profileDir:string,programRoot:string):Promise<string[]>{
 const manifest=await readJsonFile(join(profileDir,'package.json'))
 const result:string[]=[]
 for(const name of profileBundles(manifest)){
  if(directories[name]!==undefined){if(!await officialSource(profileDir,manifest,name,programRoot))result.push(name)}
  else if(reservedScope(name)&&!officialBundles.has(name))result.push(name)
 }
 return result
}

/**
 * profile node_modules 里存在的随附包必须解析到本程序目录（与启动器 scripts/runtime/profile.mjs 的 bundledModuleConflicts 同一判据）。
 * 宿主进程内的即时启停在调用官方热套用前后各跑一次。
 */
export async function bundledModuleConflicts(profileDir:string,programRoot:string):Promise<string[]>{
 const real=async(path:string)=>{try{return await realpath(path)}catch(error){if(record(error)&&error.code==='ENOENT')return undefined;throw error}}
 const result:string[]=[]
 for(const [name,directory] of Object.entries(directories)){
  const linked=await real(join(profileDir,'node_modules',name))
  if(linked!==undefined&&linked!==await real(join(programRoot,directory)))result.push(name)
 }
 return result
}

/** 随附包的官方登记值：绝对 `link:` 指向本程序目录。 */
export function officialBundledSpecs(programRoot:string):Record<string,string>{
 return Object.fromEntries(Object.entries(directories).map(([name,directory])=>[name,'link:'+join(programRoot,directory)]))
}
/** 缺登记、或登记值不是本程序目录的随附包及其官方值；启动器据此以官方值覆盖补登记（不进 bundles）。 */
export async function bundledSourcesToRegister(profileDir:string,programRoot:string):Promise<Record<string,string>>{
 const manifest=await readJsonFile(join(profileDir,'package.json'))
 const result:Record<string,string>={}
 for(const [name,spec] of Object.entries(officialBundledSpecs(programRoot)))if(!await officialSource(profileDir,manifest,name,programRoot))result[name]=spec
 return result
}

/** 已配置的 IM 渠道数。只有文件不存在算 0；其它读错（EACCES、EISDIR、JSON 损坏、形状不对）抛出，迁移据此推迟。不作授权依据。 */
export async function configuredImChannels(runtimeRoot:string):Promise<number>{
 let text:string
 try{text=await readFile(join(runtimeRoot,'im-gateway','channels.json'),'utf8')}
 catch(error){if(record(error)&&error.code==='ENOENT')return 0;throw error}
 const value:unknown=JSON.parse(text)
 if(!record(value)||!Array.isArray(value.channels))throw Error('IM 渠道文件格式不正确。')
 return value.channels.length
}

/**
 * 升级迁移：IM 通道曾是 `@teloa/bundle` 的默认行。配置过渠道的本人升级后视为已启用；
 * 只迁一次（标记在 profile 目录，0600），此后本人的停用选择不再被改回。
 * 随附来源尚未登记进 profile、或渠道文件读不了时推迟，不写标记；调用方捕获异常只告警，不阻断启动。
 * 先写标记再启用：标记写失败就不启用（宁可漏掉自动启用，本人可在市场手动启用），
 * 也不能留下「已启用却没标记」的状态，否则下次启动会把本人的停用改回来。
 */
export function migrateBundledExtensions(profileDir:string,runtimeRoot:string,programRoot:string):Promise<'enabled'|'skipped'|'deferred'>{
 return withProfileLock(profileDir,async()=>{
  const markerPath=join(profileDir,BUNDLED_EXTENSIONS_FILE)
  let marker:Record<string,unknown>={}
  try{marker=await readJsonFile(markerPath)}
  catch(error){if(!(record(error)&&error.code==='ENOENT'))throw Error(markerUnreadable)}
  if(marker[MIGRATION_KEY]!==undefined)return 'skipped'
  if(!await officialSource(profileDir,await readJsonFile(join(profileDir,'package.json')),IM_GATEWAY_PACKAGE,programRoot))return 'deferred'
  let count:number
  try{count=await configuredImChannels(runtimeRoot)}catch{return 'deferred'}
  const enable=count>0
  await writeAtomic(markerPath,JSON.stringify({...marker,[MIGRATION_KEY]:enable?'enabled':'skipped'},null,2)+'\n',0o600)
  if(enable)await setBundledExtensionLocked(profileDir,programRoot,IM_GATEWAY_PACKAGE,true)
  return enable?'enabled':'skipped'
 })
}
