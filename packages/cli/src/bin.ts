import {readFile,mkdir,stat} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {homedir} from 'node:os'
import {pathToFileURL} from 'node:url'
import {randomUUID} from 'node:crypto'
import {resolveLayout,programRoot,canonical,exactVersion} from './layout.ts'
import {readInstall,writeInstall,withInstallLock} from './state.ts'
import {stageRelease,verifyRelease} from './releases.ts'
import {prepareDatabase,assertLocalDocker} from './database.ts'
import {startService,stopService,serviceStatus,openService,portAvailable,sleep,controlRequest} from './service.ts'
import {redactLog} from './diagnostics.ts'
import {collectEnvironment,type DiagnosticCheck} from './environment.ts'
import {command} from './process.ts'
import {assertMaintenanceStopped,createBackup,dshEnvBackupNotice,dshEnvRestoreNotice,restoreBackup} from './maintenance.ts'
import {upgradeInstall,unregisterInstall} from './upgrade.ts'
import type {InstallState} from './contracts.ts'

const optionsByCommand:Record<string,string[]>={up:['workspace','port','no-open','database-config'],status:['json'],open:['print-url'],stop:[],restart:['no-open'],logs:['follow'],doctor:['json'],backup:['output'],restore:['from','database-config'],upgrade:['to'],uninstall:[],credentials:['action','confirm']}
const booleanOptions=new Set(['no-open','json','print-url','follow','help','confirm'])
const argumentError=(message:string)=>Object.assign(Error(message),{exitCode:2})
export function parseArguments(args:string[]):{command:string;options:Record<string,string|true>}{
 if(!args.length||args.length===1&&args[0]==='--help')return {command:'help',options:{}}
 if(args.length===1&&args[0]==='--version')return {command:'version',options:{}}
 const command=args[0]!,options:Record<string,string|true>={}
 if(!(command in optionsByCommand))throw argumentError('未知命令；请运行 teloa --help。')
 for(let index=1;index<args.length;index++){
  const option=args[index]!.slice(2)
  if(!args[index]!.startsWith('--')||!['home','help',...optionsByCommand[command]!].includes(option)||option in options)throw argumentError('命令参数无效或重复：'+args[index])
  if(booleanOptions.has(option))options[option]=true
  else{
   const value=args[++index]
   if(!value||value.startsWith('--'))throw argumentError('参数 --'+option+' 缺少值。')
   options[option]=value
  }
 }
 if(options.port&&(!/^\d+$/.test(String(options.port))||Number(options.port)<1||Number(options.port)>65535))throw argumentError('端口必须在 1–65535 之间。')
 if(!options.help){
  if(command==='backup'&&!options.output)throw argumentError('备份需要 --output 新目录参数。')
  if(command==='restore'&&(!options.from||!options.home))throw argumentError('恢复需要 --from 备份目录与 --home 新目标参数。')
  if(command==='upgrade'&&(!options.to||!exactVersion(String(options.to))))throw argumentError('升级必须通过 --to 指定确切版本。')
  // 对外只开放回滚与重置；轮换按用户裁定不对外提供（仅保留为内部维护能力）。
  if(command==='credentials'&&!['export-plaintext','reset'].includes(String(options.action)))throw argumentError('--action 只接受 export-plaintext、reset。')
  if(command==='credentials'&&options.confirm!==true)throw argumentError('该操作需要 --confirm。')
 }
 return {command:options.help?'help':command,options}
}
export async function collectDiagnostics(state:InstallState|null){
 const checks:DiagnosticCheck[]=await collectEnvironment({releaseRoot:state?.layout.releaseRoot??programRoot,...(state?{workspace:state.layout.workspaceRoot}:{})})
 if(!state)return {status:{app:'not-installed'},checks}
 const status=await serviceStatus(state)
 const add=(name:string,ok:boolean,message:string,remedy:string)=>checks.push({name,ok,message,...(!ok?{remedy}:{})})
 for(const [name,path] of Object.entries({home:state.layout.home,runtime:state.layout.runtimeRoot,workspace:state.layout.workspaceRoot})){
  const remedy=name==='workspace'?'恢复原工作目录，并确认当前用户可访问；不要创建空目录冒充原文件。':'核对安装目录是否存在，且仅当前用户可访问；不要公开配置或凭据。'
  try{const info=await stat(path);add(name,info.isDirectory()&&(name==='workspace'||(info.mode&0o077)===0),path,remedy)}catch{add(name,false,'目录不存在或不可读取',remedy)}
 }
 try{
  await verifyRelease(state.layout.releaseRoot)
  const check=await import(pathToFileURL(join(state.layout.releaseRoot,'scripts/核对DSH依赖.mjs')).href)
  const packages=check.verifyDshPackages();add('运行依赖',true,String(packages.length)+' 个固定 DSH 依赖通过核对','')
 }catch{add('运行依赖',false,'发行文件或依赖核对失败；请核对已安装版本。','使用完整且经过核对的发行包，不要手动替换运行依赖。')}
 if(state.database.kind==='docker')try{await assertLocalDocker();add('Docker',true,'本机 Docker 可连接','')}catch(error){add('Docker',false,(error as Error).message,'启动本机 Docker 引擎并检查当前 context；不要切换为远程 Docker。')}
 add('数据库',status.database==='ready',status.database,'检查本机专用数据库及受保护的连接配置，不要删除数据卷或重建原库。')
 add('应用',status.app==='ready',status.app,state.phase==='maintenance'?'安装处于维护状态，请按升级恢复点恢复到新目录。':'确认无需恢复后运行 teloa up；启动失败时查看脱敏日志 teloa logs。')
 if(status.app==='ready')add('运行中工作检查',status.activeWork>=0,status.activeWork<0?'无法读取；停止、升级和备份会拒绝执行':String(status.activeWork)+' 项','先排查服务日志并确认活动任务状态，不要绕过停止保护。')
 for(const tool of ['git','sh'])try{const result=await command(tool,tool==='sh'?['-c','exit 0']:['--version']);add(tool,result.code===0,result.code===0?'PATH 中可用':'不可运行','安装或修复 '+tool+' 并检查 PATH 后重试。')}catch{add(tool,false,'PATH 中缺少此工具','安装或修复 '+tool+' 并检查 PATH 后重试。')}
 return {status,checks}
}
export async function main(args=process.argv.slice(2)):Promise<void>{
 const parsed=parseArguments(args),options=parsed.options
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8').catch(()=>readFile(join(programRoot,'packages/cli/package.json'),'utf8')))
 if(parsed.command==='version'){console.log(pkg.version);return}
 if(parsed.command==='help'){
  console.log('Teloa — 本机 AI 员工团队\n\n用法：teloa <命令> [--home <目录>]\n\n  up       启动 Web；可指定 --workspace、--port、--database-config、--no-open\n  status   查看状态；--json 输出结构化结果\n  open     打开浏览器；--print-url 显式输出本机登录链接\n  stop     空闲时停止本安装，保留数据\n  restart  重启；有运行中工作时拒绝\n  logs     查看脱敏日志；--follow 持续读取\n  doctor   只读诊断；--json 输出结构化结果\n  backup   停止后备份；--output <新的备份目录>\n  restore  恢复到新安装；--from <备份目录> --home <新目录>\n  upgrade  停止后显式升级；--to <确切版本>\n  uninstall 停止并注销服务，保留全部数据\n  credentials 停止后凭据维护；--action export-plaintext（回滚到上一版前导出明文）或 reset（主密钥丢失时重置），须加 --confirm\n\n默认使用 ~/.teloa 与独立 Docker PostgreSQL。已有数据库通过 0600 权限的 JSON 配置文件提供 connectionString；模型密钥在 Web 中配置。\n\n  --help / --version')
  return
 }
 if(parsed.command!=='doctor'&&!((process.versions.node.startsWith('22.')&&Number(process.versions.node.split('.')[1])>=19)||process.versions.node.startsWith('24.')))throw argumentError('需要 Node 22.19+ 或 Node 24。')
 if(parsed.command==='restore'){
  const restored=await restoreBackup(String(options.from),String(options.home),options['database-config']?{kind:'existing',configFile:await canonical(String(options['database-config']))}:{kind:'docker'})
  console.log('已恢复至 '+restored.layout.home+'；应用已停止，自动化已暂停。\n工作文件未包含在备份中；会话保留原工作目录：'+restored.layout.workspaceRoot+'\n核对目录与数据后再运行 teloa up。\n'+(restored.credentials.imported.length?'旧备份中的明文凭据已导入加密存储，未放回原路径：'+restored.credentials.imported.join('、')+'。':'凭据未随备份迁移；启动后请在设置中重新录入模型密钥与连接授权。')+(restored.credentials.failed.length?'\n以下旧凭据未导入（格式无法识别，或是写入中断留下的残留，已丢弃），请在设置中重新录入：'+restored.credentials.failed.join('、')+'。':'')+'\n'+dshEnvRestoreNotice(restored.layout.dshHome));return
 }
 const initial=await resolveLayout({home:String(options.home??join(homedir(),'.teloa')),version:pkg.version,...(options.workspace?{workspace:String(options.workspace)}:{})})
 const mutable=['up','stop','restart','backup','upgrade','uninstall','credentials'].includes(parsed.command)
 const act=async()=>{
  let state=await readInstall(initial)
  if(parsed.command==='doctor'){
   const result=await collectDiagnostics(state)
   console.log(options.json?JSON.stringify(result):(state?'':'尚未初始化；以下为环境预检，不启动应用或数据库。\n')+result.checks.map(check=>(check.ok?'通过':'检查')+' '+check.name+'：'+check.message+(check.remedy?'\n  建议：'+check.remedy:'')).join('\n'))
   if(result.checks.some(check=>!check.ok))process.exitCode=1
   return
  }
  if(parsed.command==='up'){
   if(state){
    if(state.phase==='maintenance')throw Error('安装处于未完成的维护状态，拒绝启动；请使用原备份恢复到新目录。')
    if(options.workspace&&await canonical(String(options.workspace))!==state.layout.workspaceRoot||options.port&&Number(options.port)!==state.port||options['database-config']&&(state.database.kind!=='existing'||await canonical(String(options['database-config']))!==state.database.configFile))throw Error('参数与已有安装配置冲突；不会改变正在使用的目录、端口或数据库。')
    const status=await serviceStatus(state)
    if(status.app==='unknown')throw Error('现有服务失联，拒绝接管。请运行 doctor。')
    if(status.app==='ready'){console.log('Teloa 已运行：http://127.0.0.1:'+state.port);if(!options['no-open'])await openService(state,{printUrl:false});return}
    if(status.app==='starting'){await startService(state);console.log('Teloa 已就绪：http://127.0.0.1:'+state.port);if(!options['no-open'])await openService(state,{printUrl:false});return}
   }else{
    await portAvailable(Number(options.port??3100))
    await stageRelease(programRoot,initial)
    state={schema:'teloa.install/v1',id:randomUUID(),version:pkg.version,layout:initial,port:Number(options.port??3100),database:options['database-config']?{kind:'existing',configFile:await canonical(String(options['database-config']))}:{kind:'docker'},phase:'prepared'}
    await mkdir(initial.workspaceRoot,{recursive:true,mode:0o700});await writeInstall(state)
   }
   if((await serviceStatus(state)).app==='failed')await controlRequest(state,'stop')
   await prepareDatabase(state)
   const result=await startService(state)
   console.log('Teloa 已就绪：http://127.0.0.1:'+result.port+'\n在 Web 中配置自己的模型密钥。')
   if(!options['no-open'])await openService(state,{printUrl:false})
   return
  }
  if(!state){if(parsed.command==='status'){console.log(options.json?JSON.stringify({app:'not-installed'}):'尚未初始化；运行 teloa up。');return}throw Error('尚未初始化；请先运行 teloa up。')}
  if(parsed.command==='credentials'){
   assertMaintenanceStopped(await serviceStatus(state),state.phase)
   const tools=await import(pathToFileURL(join(state.layout.releaseRoot,'packages/harness-dsh/lib/credentials/maintenance.js')).href)
   console.log(await tools.runCredentialMaintenance(String(options.action),{dshHome:state.layout.dshHome}));return
  }
  if(parsed.command==='backup'){
   await createBackup(state,String(options.output))
   console.log('备份已保存：'+await canonical(String(options.output))+'\n含数据库、会话与资料；凭据不随备份，恢复后需重新录入。备份未加密，请存放在受保护的位置。工作文件不包含在内。\n'+dshEnvBackupNotice);return
  }
  if(parsed.command==='upgrade'){
   const next=await upgradeInstall(state,String(options.to));console.log('当前版本：'+next.version+'；原数据备份路径记录在实例的 upgrade.json。');return
  }
  if(parsed.command==='uninstall'){
   await unregisterInstall(state);console.log('本安装服务已注销，数据库、工作文件、会话、模型配置与保留版本均保留。\n如需移除 npm 命令，请另行使用 npm uninstall。');return
  }
  if(parsed.command==='status'){const result=await serviceStatus(state);console.log(options.json?JSON.stringify(result):'应用 '+result.app+' · 数据库 '+result.database+' · 版本 '+result.version+' · 端口 '+result.port);return}
  if(parsed.command==='open')return openService(state,{printUrl:options['print-url']===true})
  if(parsed.command==='stop'||parsed.command==='restart'){
   if(parsed.command==='restart'&&state.phase==='maintenance')throw Error('安装处于维护状态，拒绝重启；请用备份恢复到新目录。')
   await stopService(state)
   if(parsed.command==='restart'){await prepareDatabase(state);await startService(state);if(!options['no-open'])await openService(state,{printUrl:false})}
   console.log(parsed.command==='stop'?'本安装已停止，数据保留。':'Teloa 已重启。');return
  }
  if(parsed.command==='logs'){
   const path=join(state.layout.instanceRoot,'service.log');let previous=''
   do{
    const text=await readFile(path,'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw Error('服务日志不可读取。')})
    const addition=text.startsWith(previous)?text.slice(previous.length):text
    if(addition)process.stdout.write(redactLog(previous?addition:addition.split('\n').slice(-200).join('\n')))
    previous=text
    if(!options.follow)break
    await sleep(1000)
   }while(true)
  }
 }
 if(mutable)await withInstallLock(initial.home,act);else await act()
}
