import {createRequire} from 'node:module'
import {join,basename} from 'node:path'
import {tmpdir} from 'node:os'
import {realpath,stat} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import {command} from './process.ts'
import {findInstalledPackage,verifyRelease} from './releases.ts'

export type DiagnosticCheck={name:string;ok:boolean;message:string;remedy?:string}
type SandboxResult={backend:string;enforcement:string}
type EnvironmentOptions={releaseRoot:string;workspace?:string}
type Probes={nodeVersion:string;platform:string;run:typeof command;sandbox:(options:EnvironmentOptions)=>Promise<SandboxResult>}
class ProbePreparationError extends Error{
 reason:'release'|'workspace'
 constructor(reason:'release'|'workspace'){super('诊断准备失败。');this.reason=reason}
}

export function npmCheck(value:string):DiagnosticCheck{
 const version=value.trim(),parts=/^(\d+)\.(\d+)\.(\d+)$/.exec(version)
 const ok=!!parts&&Number(parts[1])===11&&(Number(parts[2])>12||Number(parts[2])===12&&Number(parts[3])>=1)
 return {name:'npm',ok,message:parts?version:'未能读取有效版本',...(!ok?{remedy:'安装与升级需要 npm 11.12.1 或更新的 11.x；先用 npm --version 核对，切换后重新运行 doctor。'}:{})}
}

/** 复用随发行包固定的真实沙箱提供者；只执行 exit 0，不改配置、权限或用户文件。 */
export async function probeSandbox(options:EnvironmentOptions):Promise<SandboxResult>{
 let context:any,provider:any
 try{
  await verifyRelease(options.releaseRoot)
  const directory=await findInstalledPackage('@deepseek-ai/dsh-sandbox-local',options.releaseRoot)
  const require=createRequire(join(directory,'package.json'))
  const {LocalSandboxProvider}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-sandbox-local')).href)
  const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href)
  context=new Context()
  provider=new LocalSandboxProvider(context,{runnerCommand:[],runnerFailureSignatures:[],probeTimeoutMs:2000})
 }catch{if(context)await context.fiber.dispose();throw new ProbePreparationError('release')}
 try{
  // 未初始化时只检验临时目录；安装后使用实际工作目录，目录缺失也不能判通过。
  let workspaceRoot:string
  try{workspaceRoot=await realpath(options.workspace??tmpdir());if(!(await stat(workspaceRoot)).isDirectory())throw Error('不是目录。')}catch{throw new ProbePreparationError('workspace')}
  const confined=await provider.confine(['/bin/sh','-c','exit 0'],{mode:'workspace-write',workspaceRoot})
  const result=await command(confined.argv[0],confined.argv.slice(1),{timeout:5000})
  if(result.code!==0)throw Error('受限终端探针失败。')
  return {backend:basename(confined.argv[0]),enforcement:confined.enforcement}
 }finally{await context.fiber.dispose()}
}

export async function collectEnvironment(options:EnvironmentOptions,overrides:Partial<Probes>={}):Promise<DiagnosticCheck[]>{
 const probes:Probes={nodeVersion:process.versions.node,platform:process.platform,run:command,sandbox:probeSandbox,...overrides}
 const [major,minor]=probes.nodeVersion.split('.').map(Number)
 const nodeOk=major===24||major===22&&minor!>=19
 const checks:DiagnosticCheck[]=[{name:'Node',ok:nodeOk,message:probes.nodeVersion,...(!nodeOk?{remedy:'使用 Node 24，或 Node 22.19 及以上的 22.x。'}:{})}]
 try{const result=await probes.run('npm',['--version'],{timeout:5000});checks.push(npmCheck(result.code===0?result.stdout:''))}catch{checks.push(npmCheck(''))}
 const remedy=probes.platform==='linux'
  ?'检查 bubblewrap 是否能创建用户命名空间，或使用支持 Landlock 的 Linux 内核；容器和模拟环境可能不具备条件。不要关闭沙箱来绕过检查。'
  :'检查系统沙箱及发行依赖；macOS 需要可运行的 sandbox-exec。不要关闭沙箱来绕过检查。'
 if(!['linux','darwin'].includes(probes.platform))checks.push({name:'终端沙箱',ok:false,message:'此平台尚未验收。',remedy:'当前验收目标为 macOS ARM64 和 Linux x64 glibc；请查阅平台支持说明。'})
 else try{
  const sandbox=await probes.sandbox(options),ok=sandbox.enforcement==='full'
  checks.push({name:'终端沙箱',ok,message:sandbox.backend+(ok?'：受限命令可执行。':'：仅部分强制执行，不能确认完整隔离。'),...(!ok?{remedy}:{})})
 }catch(error){
  if(error instanceof ProbePreparationError)checks.push(error.reason==='release'
   ?{name:'终端沙箱',ok:false,message:'无法核对或加载发行依赖，尚未执行沙箱探针。',remedy:'核对发行包与运行依赖完整性，使用完整且经过核对的安装包后重试；不需要先调整内核。'}
   :{name:'终端沙箱',ok:false,message:'工作目录不存在或无法读取，尚未执行沙箱探针。',remedy:'恢复原工作目录并确认当前用户可访问；不要用空目录冒充原工作文件。'})
  else checks.push({name:'终端沙箱',ok:false,message:'无法执行受限命令；Web 就绪不代表本机终端任务可用。',remedy})
 }
 return checks
}
