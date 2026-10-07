import {createRequire} from 'node:module'
import {join,dirname,delimiter,basename} from 'node:path'
import {pathToFileURL} from 'node:url'
import {mkdir,chmod,lstat,realpath,rename,rm,symlink} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'

export const nativeTeamBundle='@deepseek-ai/dsh-experimental-agent-team-profile'
export const nativeVoiceBundle='@deepseek-ai/dsh-experimental-voice-input-bundle'
/** 官方完整 Team 与内置 IM 默认加载；Teloa 保留岗位预设和渠道授权。 */
export function withTeloaRequiredBundles(bundles){
 const result=[...new Set(bundles)].filter(name=>name!==nativeTeamBundle&&name!=='@teloa/im-gateway')
 const index=result.indexOf('@teloa/bundle')
 if(index<0)return [...result,nativeTeamBundle,'@teloa/bundle','@teloa/im-gateway']
 result.splice(index,0,nativeTeamBundle)
 result.splice(index+2,0,'@teloa/im-gateway')
 return result
}

/** 原生语音首次装配与旧 profile 升级默认启用；同份清单记录完成，之后保留本人停用选择。 */
export function withTeloaProfileDefaults(manifest){
 const metadata=manifest.teloa??{}
 if(typeof metadata!=='object'||Array.isArray(metadata))throw Error('DSH profile 的 Teloa 默认能力标记格式不正确。')
 const dsh=manifest.dsh??{},profile=dsh.profile??{}
 const bundles=withTeloaRequiredBundles(profile.bundles??[])
 if(metadata.voiceInputDefaultV1!==true&&!bundles.includes(nativeVoiceBundle))bundles.splice(bundles.indexOf('@teloa/im-gateway')+1,0,nativeVoiceBundle)
 return {...manifest,teloa:{...metadata,voiceInputDefaultV1:true},dsh:{...dsh,profile:{...profile,bundles}}}
}

/** 只登记官方插件页可发现的 Web 可选组合；SSH 生成器永不进入此目录。 */
export function optionalNativeBundleSpecs(programRoot){
 const require=createRequire(join(programRoot,'packages/harness-dsh/package.json'))
 const autoReview=dirname(require.resolve('@deepseek-ai/dsh-experimental-auto-review/package.json'))
 return {
  '@teloa/native-browser':'link:'+join(programRoot,'packages/native-browser'),
  '@teloa/native-computer':'link:'+join(programRoot,'packages/native-computer'),
  '@deepseek-ai/dsh-experimental-auto-review':'link:'+autoReview,
  // IM 是内置默认能力；先登记固定来源，再由 withTeloaRequiredBundles 装配。
  '@teloa/im-gateway':'link:'+join(programRoot,'packages/im-gateway'),
  // 本地中文检索：同为随附官方扩展，登记可发现但不进组合；推理运行时与模型只在本人确认准备后下载。
  '@teloa/local-embedding':'link:'+join(programRoot,'packages/local-embedding'),
 }
}

/** 依赖可发现与 bundle 启用是两件事；启用选择与第三方来源归用户。
 *  `@teloa/` 随附包例外：官方值覆盖旧值——npm 每版本换程序目录（home/releases/<version>），旧 link 会让来源核对失败、宿主起不来。 */
export function withOptionalNativeDependencies(manifest,specs){
 const official=Object.fromEntries(Object.entries(specs).filter(([name])=>name.startsWith('@teloa/')))
 const review='@deepseek-ai/dsh-experimental-auto-review',previous=manifest.dependencies?.[review]
 // 仅跟随随附的 pnpm 或发行 .teloa-store 源链接；本人选定的 registry/file/其他 link 保持原样。
 const bundledReview=typeof previous==='string'&&previous.startsWith('link:')&&(
  previous.includes('/node_modules/.pnpm/@deepseek-ai+dsh-experimental-auto-review@')&&previous.endsWith('/node_modules/'+review)||
  /\/node_modules\/\.teloa-store\/[a-f0-9]{24}\/node_modules\/@deepseek-ai\/dsh-experimental-auto-review$/.test(previous))
 if(bundledReview&&specs[review])official[review]=specs[review]
 return {...manifest,dependencies:{...specs,...manifest.dependencies,...official}}
}

/** 只修复已明确登记为当前随附源的 Auto Review 链接，不接管本人选择的来源。 */
export function managedAutoReviewModuleSpec(manifest,specs){
 const name='@deepseek-ai/dsh-experimental-auto-review'
 return specs[name]&&manifest.dependencies?.[name]===specs[name]?{[name]:specs[name]}:{}
}

/** realpath；路径不存在（含悬空链接）时为 undefined。 */
async function realpathOrUndefined(path){
 try{return await realpath(path)}catch(error){if(error.code==='ENOENT')return undefined;throw error}
}
/**
 * npm 模式下本人装过市场插件后，profile 的 node_modules 会留着指向旧 releases/<version> 的随附包链接；
 * 源码/容器模式下原生扩展管理拒收冒名安装时可能把随附包链接移除。npm 与源码/容器启动器（scripts/启动DSH.mjs）共用本函数。
 * 缺失、悬空或指向别处的符号链接以官方目录原子重建（先建临时链接再 rename 覆盖）；实体目录等无法修正的不动，交给随后的核对拒绝。
 * 改链失败时清掉临时链接，以固定文案（不含路径）抛出。只处理随附包（officialBundledSpecs），第三方包不动。调用方须已持有 profile 锁。
 */
export async function repairBundledModuleLinks(profileDir,specs){
 for(const [name,spec] of Object.entries(specs)){
  const target=spec.slice('link:'.length),link=join(profileDir,'node_modules',name)
  let entry
  try{entry=await lstat(link)}catch(error){if(error.code!=='ENOENT')throw error}
  const official=await realpathOrUndefined(target)
  if(official===undefined||entry!==undefined&&!entry.isSymbolicLink())continue
  if(entry!==undefined&&await realpathOrUndefined(link)===official)continue
  await mkdir(dirname(link),{recursive:true})
  const temporary=join(dirname(link),'.'+basename(link)+'-'+randomUUID())
  try{await symlink(target,temporary);await rename(temporary,link)}
  catch(error){
   await rm(temporary,{force:true})
   throw Error('DSH profile 里的官方扩展链接无法修正，宿主拒绝启动；请重新运行安装准备后再启动。',{cause:error})
  }
 }
}
/** profile node_modules 里存在的随附包必须解析到本程序目录；源码/容器启动器 scripts/启动DSH.mjs 用同一判据。 */
export async function bundledModuleConflicts(profileDir,specs){
 const result=[]
 for(const [name,spec] of Object.entries(specs)){
  const linked=await realpathOrUndefined(join(profileDir,'node_modules',name))
  if(linked!==undefined&&linked!==await realpathOrUndefined(spec.slice('link:'.length)))result.push(name)
 }
 return result
}

export function runtimeEnvironment(layout,environment=process.env){
 const allowed=['PATH','HOME','USER','LOGNAME','SHELL','TMPDIR','TMP','TEMP','LANG','LC_ALL','LC_CTYPE','TZ','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy',
  // 使用统计排除变量：CI / 验收 / 开发环境里用 npm 版 teloa 启动也不上报（宿主据此优先于 on 排除）。
  'CI','TELOA_BROWSER_ACCEPTANCE','NODE_ENV',
  // 凭据存储档位与主密钥来源（规格 §3.4）：显式密钥文件、systemd 凭据目录，以及 Linux 桌面 Secret Service 所需的 D-Bus 两项。
  // 凭据验收开关（TELOA_CREDENTIALS_KEYRING、TELOA_CREDENTIALS_KEY_DIR）任何情况下都不透传：验收只走源码启动器。
  'TELOA_CREDENTIALS_KEY_FILE','TELOA_CREDENTIALS_STORE','CREDENTIALS_DIRECTORY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR']
 const result=Object.fromEntries(allowed.filter(key=>environment[key]!==undefined).map(key=>[key,environment[key]]))
 // `<REF>_FILE` 指向密钥文件，值只是路径：宿主按分层读取文件内容，不把密钥放进进程环境。
 for(const [key,value] of Object.entries(environment))if(/^[A-Z][A-Z0-9_]*_FILE$/.test(key)&&value!==undefined)result[key]=value
 // npm 发行宿主显式开启使用统计与在线市场；外部显式值（如 off）及宿主的 CI / 验收 / 开发排除规则优先。
 return {...result,TELOA_USAGE_STATS:environment.TELOA_USAGE_STATS??'on',TELOA_MARKET_REMOTE:environment.TELOA_MARKET_REMOTE??'on',PATH:join(layout.programRoot,'node_modules/.bin')+delimiter+(result.PATH??''),DSH_HOME:layout.dshHome,TELOA_PROJECT_ROOT:layout.programRoot,TELOA_RUNTIME_ROOT:layout.runtimeRoot,TELOA_WORKSPACE_ROOT:layout.workspaceRoot,TELOA_DSH_PROFILE:layout.profileName}
}

export async function prepareRuntimeProfile(layout){
 for(const directory of [layout.dshHome,layout.runtimeRoot,layout.workspaceRoot]){
  await mkdir(directory,{recursive:true,mode:0o700})
 }
 const require=createRequire(join(layout.programRoot,'package.json'))
 const sdk=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
 const profileDir=join(layout.dshHome,'profiles',layout.profileName)
 sdk.initProfile(profileDir,sdk.PROFILE_TEMPLATES.web.bundles)
 await chmod(profileDir,0o700)
 const pending=await import(pathToFileURL(join(layout.programRoot,'packages/harness-dsh/lib/pending-plugins.js')).href)
 const bundled=await import(pathToFileURL(join(layout.programRoot,'packages/harness-dsh/lib/bundled-extensions-profile.js')).href)
 const bundledSpecs=bundled.officialBundledSpecs(layout.programRoot)
 await pending.withProfileLock(profileDir,async()=>{
  const manifest=await pending.readJsonFile(join(profileDir,'package.json'))
  const optional=optionalNativeBundleSpecs(layout.programRoot)
  const next=withTeloaProfileDefaults(withOptionalNativeDependencies(manifest,optional))
  if(JSON.stringify(next)!==JSON.stringify(manifest))await pending.writeProfileManifest(profileDir,next)
  await repairBundledModuleLinks(profileDir,{...bundledSpecs,...managedAutoReviewModuleSpec(next,optional)})
 })
 await pending.suppressPendingBundles(profileDir)
 if((await pending.pendingBundleConflicts(profileDir)).length)throw Error(pending.pendingBundleRefusal)
 // 依赖已在上面的锁内被 withOptionalNativeDependencies 改写为当前程序目录；迁移失败只告警。
 try{await bundled.migrateBundledExtensions(profileDir,layout.runtimeRoot,layout.programRoot)}
 catch(error){console.warn('[teloa] 官方扩展迁移未完成，本次按现状启动：'+(error instanceof Error?error.message:String(error)))}
 if((await bundled.bundledSourceConflicts(profileDir,layout.programRoot)).length||(await bundledModuleConflicts(profileDir,bundledSpecs)).length)throw Error(bundled.bundledSourceRefusal)
 return profileDir
}

export function launchRuntime(layout,{port}){
 const require=createRequire(join(layout.programRoot,'package.json'))
 const executable=join(require.resolve('@deepseek-ai/dsh/package.json'),'../lib/bin.js')
 return spawn(process.execPath,[executable,'--profile',layout.profileName,'--no-open','--host','127.0.0.1','--port',String(port)],{cwd:layout.workspaceRoot,env:runtimeEnvironment(layout),stdio:['ignore','pipe','pipe']})
}
