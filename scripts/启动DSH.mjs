import { spawn } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { access, chmod, mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createRequire } from 'node:module'
import { basename, dirname, resolve, sep } from 'node:path'
import { projectRoot, verifyDshPackages } from './核对DSH依赖.mjs'
import { findStartupUrl, guardTeloaReadiness } from './核对宿主就绪.mjs'
import { stripCredentialEnv, warnRemoved } from './runtime/credential-env.mjs'
import { imCredentialFields } from '../packages/contract/src/im-channels.ts'
// 与安装适配器、装配期复验共用同一份事实来源；这个模块不依赖契约链，启动路径上足够轻。
import { pendingBundleConflicts, pendingBundleRefusal, readJsonFile, suppressPendingBundles, withProfileLock, writeProfileManifest } from '../packages/harness-dsh/src/pending-plugins.ts'
import { bundledSourceConflicts, bundledSourceRefusal, bundledSourcesToRegister, migrateBundledExtensions, officialBundledSpecs } from '../packages/harness-dsh/src/bundled-extensions-profile.ts'
import { bundledModuleConflicts, repairBundledModuleLinks, withOptionalNativeDependencies, optionalNativeBundleSpecs, managedAutoReviewModuleSpec } from './runtime/profile.mjs'

const formalPort = 3100
const formalDshHome = resolve(projectRoot,'.runtime/dsh')
const formalRuntimeRoot = resolve(projectRoot,'.runtime/teloa')
const formalWorkspaceRoot = resolve(formalRuntimeRoot,'workspace')
const acceptance = process.env.TELOA_BROWSER_ACCEPTANCE === '1'
const port = Number(process.env.TELOA_DSH_PORT || formalPort)
const dshHome = resolve(process.env.TELOA_DSH_HOME || formalDshHome)
const runtimeRoot = resolve(process.env.TELOA_RUNTIME_ROOT || formalRuntimeRoot)
// 工作区默认落在运行目录里，不是仓库根：宿主以它为 cwd，沙箱写范围与原生终端的初始目录随之收敛。
const workspaceRoot = resolve(process.env.TELOA_WORKSPACE_ROOT || resolve(runtimeRoot,'workspace'))
const profileName = process.env.TELOA_DSH_PROFILE || 'teloa'
const profileDir = resolve(dshHome,'profiles',profileName)
const profileManifestPath = resolve(profileDir,'package.json')
const webBundles = ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']
const allowedChecks = ['--help','--version','--dump-config','--dump-default-config']
const args = process.argv.slice(2)
// 凭据形变量与带口令 URL 不进宿主（规格 §4 启动器）；凭据验收开关只随浏览器验收宿主透传。只打印变量名。
const { env: launchEnv, removed: removedEnv } = stripCredentialEnv(process.env)
// 只在起服务时提示：--version 等检查分支的 stderr 被安装准备逐字核对，不能有额外输出
if(!args.length)warnRemoved(removedEnv,Object.values(imCredentialFields).flat().map(field=>field.key))
const childEnv={
  // 源码仓库启动的宿主是开发机：这里不设置 TELOA_USAGE_STATS，宿主缺省即不发送使用统计；
  // 正式发行入口（npm CLI、容器）才显式设置 on。
  ...launchEnv,
  DSH_HOME:dshHome,
  // 宿主的 cwd 已经是工作区，仓库内的路径（组合补丁里的参考 MCP 入口）只能按这个绝对路径解析。
  TELOA_PROJECT_ROOT:projectRoot,
  TELOA_RUNTIME_ROOT:runtimeRoot,
  TELOA_WORKSPACE_ROOT:workspaceRoot,
  TELOA_DSH_PROFILE:profileName,
}

function assertAcceptanceIsolation() {
  // IM 验收桩渠道只允许在隔离验收宿主里开启（评审 H4）；正式宿主连 --version 也拒绝。
  if(process.env.TELOA_IM_STUB_PORT!==undefined&&!acceptance)throw Error('TELOA_IM_STUB_PORT 只允许在浏览器验收环境使用（TELOA_BROWSER_ACCEPTANCE=1）。')
  if(!acceptance)return
  const complete=process.env.TELOA_DSH_HOME&&process.env.TELOA_RUNTIME_ROOT&&process.env.TELOA_WORKSPACE_ROOT&&process.env.TELOA_DSH_PROFILE&&process.env.TELOA_DSH_PORT
  const isolated=complete&&dshHome!==formalDshHome&&runtimeRoot!==formalRuntimeRoot&&workspaceRoot!==formalWorkspaceRoot&&profileName!=='teloa'&&port!==formalPort
  if(!isolated)throw Error('浏览器验收必须使用独立的 profile、运行目录与端口。请通过验收启动器运行。')
}

// 与宿主内的 canonicalizePath 同一做法：取最长已存在祖先的真实路径再拼回尚未创建的尾段。
// 工作区目录此刻可能还没建出来，而软链祖先会让字符串比较判不出“同一个目录”。
function canonical(path) {
  const absolute=resolve(path),tail=[]
  let current=absolute
  for(;;){
    try{ return resolve(realpathSync(current),...tail) }catch{}
    const parent=dirname(current)
    if(parent===current)return absolute
    tail.unshift(basename(current));current=parent
  }
}
/** `child` 是否严格位于 `parent` 之下（同一路径不算）。两侧都应当已是规范路径。 */
function within(parent,child) {
  return child.startsWith(parent.endsWith(sep)?parent:parent+sep)
}
/**
 * 工作区就是会话的沙箱写范围与原生终端的初始目录，判据与宿主内的
 * workspaceRefusedForRepository 逐字相同：等于本程序所在目录或其上级一律拒绝；
 * 落在该目录内时只允许运行目录 `.runtime/` 之下（正式与验收工作区都在其中），
 * packages/、config/ 这类源码目录会让沙箱与终端直接写在本程序自己的代码上；
 * 目录之外的位置是用户自己的，照常允许。诊断只给固定文案：路径本身不进输出。
 */
function assertWorkspaceIsolation() {
  const workspace=canonical(workspaceRoot),repository=canonical(projectRoot)
  const refused=workspace===repository||within(workspace,repository)
    ||within(repository,workspace)&&!within(resolve(repository,'.runtime'),workspace)
  if(refused)throw Error('工作区不能落在本程序所在目录及其上级，也不能落在该目录内运行目录之外的位置；请改用专用工作区后重新启动。')
}

async function exists(path) {
  try { await access(path); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
function run(command,args,stdio='inherit') {
  return new Promise((done,fail)=>{
    const child=spawn(process.execPath,[command,...args],{cwd:projectRoot,env:childEnv,stdio})
    child.once('error',fail)
    child.once('exit',(code,signal)=>code===0?done():fail(Error('DSH '+(signal?'被 '+signal+' 中止':'退出码 '+code))))
  })
}
async function ensureProfile(command,checking) {
  await mkdir(resolve(dshHome,'profiles'),{recursive:true})
  if(!await exists(profileManifestPath)){
    if(await exists(profileDir))throw Error(profileName+' profile 目录已存在但缺少 package.json；请先核对该不完整目录，启动器不会覆盖。')
    // 由当前 DSH 自带模板原子生成，避免在升级时复制一份会过期的 profile 结构。
    await run(command,['--profile',profileName,'--from-default-profile','web','--dump-config'],['ignore','ignore','inherit'])
  }
  const profile=JSON.parse(await readFile(profileManifestPath,'utf8'))
  const manifest=profile.dsh?.profile
  if(!manifest||!Array.isArray(manifest.bundles))throw Error(profileName+' profile 缺少 dsh.profile.bundles。')
  if(webBundles.some((bundle,index)=>manifest.bundles[index]!==bundle))throw Error(profileName+' profile 未以当前 DSH web bundle 顺序开头，拒绝按旧结构启动。')
  // rc1 不读取 patchReload。Teloa 组合关闭实际 hmr 行，装配时复验行与服务事实；
  // 配置与插件变更由官方管理器标为需要重启，启动器不再写入失效安全字段。
  // 市场插件装进 profile 之后并不自动进入组合：本人点过"启用"才加回 bundles。
  // 上游 reconcilePlugins 会在任何一次 dsh plugin add 之后把它们补回去（包括 pnpm setup:dsh 那一条），
  // 所以起宿主之前先自愈一遍——把待启用清单里的包从 bundles 摘掉，只朝"更安全"的方向改盘。
  // 压制本身读不出清单或写不回去，才按原判据拒绝；压制成功之后交集理应已经清空。
  await suppressPendingBundles(profileDir)
  const pendingInBundles=await pendingBundleConflicts(profileDir)
  if(pendingInBundles.length)throw Error(pendingBundleRefusal)
  // 容器（构建期才跑 setup:dsh，profile 在 app-data 卷）与源码升级不会重新登记随附扩展：缺登记或来源不是本程序目录就以官方值补登记，
  // 不进 bundles。与 npm 路径同一做法：锁内直接改写 profile 依赖，随后由下方原子改链补齐 node_modules 链接，不经包管理器——
  // 容器里 profile 是构建期以 root 装的，node 用户运行 pnpm 会撞上 root 的 store，离线时也装不了。
  // 只对已跑过 setup 的 profile 做——首次 --dump-config 生成模板时由 setup:dsh 统一登记。
  // --dump-config 等检查分支不补登记、不迁移：它们的 stderr 被安装准备逐字核对，构建期镜像里也不能留下迁移记录。
  // 补登记与迁移失败只告警，不阻断启动；来源核对失败仍拒绝启动。
  if(!checking&&profile.dependencies?.['@teloa/bundle']!==undefined){
    try{
      await withProfileLock(profileDir,async()=>{
        const missing=await bundledSourcesToRegister(profileDir,projectRoot)
        const manifest=await readJsonFile(profileManifestPath)
        const next=withOptionalNativeDependencies(manifest,{...optionalNativeBundleSpecs(projectRoot),...missing})
        if(JSON.stringify(next)!==JSON.stringify(manifest))await writeProfileManifest(profileDir,next)
      })
    }catch(error){console.warn('[teloa] 官方扩展补登记未完成，本次按现状启动：'+(error instanceof Error?error.message:String(error)))}
  }
  if(!checking){
    try{await migrateBundledExtensions(profileDir,runtimeRoot,projectRoot)}
    catch(error){console.warn('[teloa] 官方扩展迁移未完成，本次按现状启动：'+(error instanceof Error?error.message:String(error)))}
  }
  if((await bundledSourceConflicts(profileDir,projectRoot)).length)throw Error(bundledSourceRefusal)
  // 纵深防御：上游先按安装锚点解析组合包，锚点解析失败时会退回 profile 的 node_modules。
  // 随附包链接缺失、悬空或被换到别处时，与 npm 路径同一原子改链函数在锁内改回本程序目录，再按同一判据核对。
  const bundledSpecs=officialBundledSpecs(projectRoot)
  await withProfileLock(profileDir,async()=>repairBundledModuleLinks(profileDir,{...bundledSpecs,...managedAutoReviewModuleSpec(await readJsonFile(profileManifestPath),optionalNativeBundleSpecs(projectRoot))}))
  if((await bundledModuleConflicts(profileDir,bundledSpecs)).length)throw Error(bundledSourceRefusal)
}
// 就绪自检的进程级回归需要一个可控的假宿主；只接受本仓库 tests 目录下的 .mjs，
// 不能指向仓库外的路径或任意可执行文件，正式启动路径不受影响。
function resolveHostCommand(command) {
  const stub=process.env.TELOA_DSH_STUB_HOST?.trim()
  if(!stub)return command
  const path=resolve(projectRoot,stub)
  // 字符串前缀判断在 tests/ 下放一个指向仓库外的软链就能绕过；比较前先取真实路径，
  // 与同文件的 canonical() 同一推理。目标不存在时 realpathSync 直接抛出，一并拒绝。
  let real
  try{real=realpathSync(path)}catch{throw Error('桩宿主只能是本仓库 tests 目录下的 .mjs 脚本。')}
  if(!real.startsWith(resolve(projectRoot,'tests')+sep)||!real.endsWith('.mjs'))throw Error('桩宿主只能是本仓库 tests 目录下的 .mjs 脚本。')
  return path
}
async function checkPort() {
  await new Promise((done,fail)=>{
    const server=createServer()
    server.once('error',()=>fail(Error('端口 '+port+' 不可用；未停止其他服务。')))
    server.listen(port,'127.0.0.1',()=>server.close(done))
  })
}

try {
  assertAcceptanceIsolation()
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('DSH 端口必须是 1 到 65535 之间的整数。')
  if (args.some(arg=>!allowedChecks.includes(arg))) throw Error('启动器仅接受 --help、--version、--dump-config 或 --dump-default-config；服务 profile 与端口由当前环境配置。')
  verifyDshPackages()
  if (!args.length) await checkPort()
  const manifestPath=createRequire(resolve(projectRoot,'package.json')).resolve('@deepseek-ai/dsh/package.json')
  const command=resolve(dirname(manifestPath),'lib/bin.js')
  await ensureProfile(command,args.length>0)
  const commandArgs=['--profile',profileName,...(args.length?args:['--no-open','--host','127.0.0.1','--port',String(port)])]
  // 只有真正起服务时才管道 stdout：--dump-config 等检查分支的 stdout 被 准备DSH插件.mjs 逐字读取，
  // 不能改动；服务分支则要边原样转发边找出那一行带令牌的启动地址。
  const serving=!args.length
  // 宿主在工作区里运行：sandbox-policy 的 workspaceRoot 取 process.cwd()，这样兜底写范围自然落在工作区。
  // DSH 命令、profile、DSH_HOME 与仓库内路径一律按 projectRoot 的绝对路径解析，不受 cwd 影响。
  // 检查分支不起服务，也就不该建目录或改 cwd；它们留在仓库根上运行。
  if(serving){
    assertWorkspaceIsolation()
    // 收敛纵深：历史版本用不带 mode 的 mkdir 建过运行目录，实测残留 0755。只改目录自身的权限位，
    // 不递归改内部文件——postgres.env/database.json/.credentials.yaml 各自已经是 0600。
    if(await exists(runtimeRoot))await chmod(runtimeRoot,0o700)
    await mkdir(workspaceRoot,{recursive:true,mode:0o700})
  }
  const hostCommand=resolveHostCommand(command)
  const child=spawn(process.execPath,[hostCommand,...commandArgs],{cwd:serving?workspaceRoot:projectRoot,env:childEnv,stdio:serving?['inherit','pipe','inherit']:'inherit'})
  let readinessFailed=false,cancelling=false
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{cancelling=true;child.kill(signal)})
  child.once('error',error=>{console.error(error.message);process.exitCode=1})
  child.once('exit',(code,signal)=>{process.exitCode=readinessFailed?1:(code ?? (signal?1:0))})
  if(serving){
    let buffered='',found=false,settle
    const expectedHost='127.0.0.1:'+port
    const startupUrl=new Promise((done,fail)=>{settle={done,fail}})
    const deadline=setTimeout(()=>{if(!found){found=true;buffered='';settle.fail(Error('宿主在 120 秒内没有打印启动地址。'))}},120000)
    deadline.unref()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data',chunk=>{
      process.stdout.write(chunk)
      if(found)return
      buffered+=chunk
      // 只扫已经收完的整行：地址被 chunk 从中间截断时，半截令牌同样匹配正则，
      // 拿它去自检会把一台健康宿主判成未就绪并杀掉。
      const end=buffered.lastIndexOf('\n')+1
      if(!end)return
      const complete=buffered.slice(0,end)
      buffered=buffered.slice(end)
      // 只认本启动器自己指定的 --host/--port，宿主内其他插件打印的地址一律略过继续等。
      const url=findStartupUrl(complete,expectedHost)
      if(!url)return
      found=true;buffered='';clearTimeout(deadline);settle.done(url)
    })
    child.once('exit',()=>{if(!found){found=true;buffered='';clearTimeout(deadline);settle.fail(Error('宿主在打印启动地址前已退出。'))}})
    // 用户在地址出现前按下 Ctrl-C 属于取消，不是自检失败：不打诊断消息，退出码交回信号语义。
    // 桩宿主的挂载状态在进程起来那一刻就定了，没有装配空窗；真跑用例不必等满真实宿主的挂载窗口。
    // 判据取"实际是否换成了桩"，不再直接读环境变量：变量被拒绝时仍然会走真实宿主的完整窗口。
    const stubbed=hostCommand!==command
    const failed=await guardTeloaReadiness({child,startupUrl,...(stubbed?{mountTimeout:1000}:{}),report:message=>{if(!cancelling)console.error(message)}})
    // 子进程若抢在自检结论之前就以 0 退出，exit 回调已经写过退出码，这里必须再压一次。
    if(failed&&!cancelling){readinessFailed=true;process.exitCode=1}
  }
} catch(error) { console.error(error.message);process.exitCode=1 }
