import {stat,opendir,realpath} from 'node:fs/promises'
import {isAbsolute,relative,sep,join} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,resourceScopes} from '@teloa/contract'
import {authorizeConversationBusinessScope} from './business-scope-context.ts'
import type {BusinessConversationAuthorizationPorts} from './business-conversation-authorization.ts'
import {resolveSessionLineage} from './subagent-lineage.ts'

export type BusinessFileBoundary={path:string;scopeIds:string[]}
export type BusinessScopeFileGuardPorts={
 authorization:BusinessConversationAuthorizationPorts
 /** Task/固定岗位仍用原运行授权，不借普通父会话权限。 */
 applies:(sessionId:string,signal:AbortSignal)=>Promise<boolean>
 boundaries:()=>Promise<readonly BusinessFileBoundary[]>
}
const reads=new Set(['read','read_file','read_text_file','read_image','read_multiple_files','write','edit'])
const searches=new Set(['glob','grep','search','ls','list_directory','list_files'])
const commands=/^(?:bash|pwsh|shell|python|node|exec|execute_code|run_code|run_script|ptc|job_start|job_submit)$/
const denied=()=>new WorkError('teloa/forbidden','当前文件操作可能读取其他业务专属资料。请使用当前业务资料入口，或明确切换到获准的业务。')
const unsafe=()=>new WorkError('teloa/forbidden','通用命令无法核验当前业务的资料读取范围。请使用当前业务资料入口，或在原授权任务中执行。')
const contains=(parent:string,child:string)=>{const path=relative(parent,child);return path===''||path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path)}
const kind=(name:string)=>{const leaf=name.split('__').at(-1)!;return reads.has(leaf)?'read':searches.has(leaf)?'search':commands.test(leaf)?'command':undefined}
async function inode(path:string):Promise<string|undefined>{
 try{const value=await stat(path,{bigint:true});return value.dev+':'+value.ino}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error}
}
/** 仅检查目录与链接元数据；不能有界核验时拒绝搜索，不让原生rg先读正文。 */
async function assertSearchLinks(root:string,protectedPaths:readonly string[],signal:AbortSignal):Promise<void>{
 const pending=[root],visited=new Set<string>();let count=0
 while(pending.length){
  signal.throwIfAborted();const path=await realpath(pending.pop()!)
  if(visited.has(path))continue
  visited.add(path)
  if(protectedPaths.some(file=>contains(path,file)))throw denied()
  for await(const entry of await opendir(path)){
   signal.throwIfAborted();if(++count>4096)throw denied()
   const child=join(path,entry.name)
   if(entry.isDirectory())pending.push(child)
   else if(entry.isSymbolicLink()){
    const target=await realpath(child)
    if(protectedPaths.some(file=>target===file||contains(target,file)))throw denied()
    if((await stat(target)).isDirectory())pending.push(target)
   }
  }
 }
}

/** 在正常ToolRuntime执行前核验真实登记、所选业务与规范目标；不预读或事后裁掉越界正文。 */
export function registerBusinessScopeFileGuard(ctx:Context,ports:BusinessScopeFileGuardPorts):()=>void{
 const checked=new WeakMap<ToolExecution,string>()
 const check=async(exec:ToolExecution):Promise<string|undefined>=>{
  const operation=kind(exec.name)
  if(!operation||!exec.agent)return undefined
  const {root}=resolveSessionLineage(ctx,exec.agent.session)
  if(!await ports.applies(root.id,exec.signal))return undefined
  const agent=ctx.agents.get(root.id)
  if(!agent)throw denied()
  const lease=await authorizeConversationBusinessScope(ports.authorization,{agent,signal:exec.signal})
  // 未选择具体业务保留原本人工作目录授权；这不把general资料scope变成共享授权。
  await lease.assertCurrent()
  if(!lease.scope)return JSON.stringify([root.id,lease.fingerprint])
  const scopes=lease.actor.scopeIds,entries=await ports.boundaries()
  const blocked=entries.filter(row=>{
   if(!isAbsolute(row.path)||!resourceScopes(row.scopeIds))throw denied()
   return row.scopeIds.some(scope=>!scopes.includes(scope))
  })
  await lease.assertCurrent()
  const fingerprint=JSON.stringify([root.id,lease.fingerprint,entries])
  if(!blocked.length)return fingerprint
  // 任意命令/代码不能靠解析cat字符串证明安全；原Task明确文件授权不走本分支。
  if(operation==='command')throw unsafe()
  const args=exec.arguments as Record<string,unknown>|undefined
  const path=args?.file_path??args?.path??(operation==='search'?'.':undefined)
  if(typeof path!=='string'||!path.trim()||path.includes('\0'))throw denied()
  const fs=ctx.agentPresets?.serviceFor(exec.agent,'fs')??ctx.fs
  const cwd=await ctx.workingDirectory.ensure(exec.agent,exec.signal)
  const target=await fs.resolve(path,{cwd,signal:exec.signal}),processPath=fs.processPath(target)
  const search=(await fs.stat(target,exec.signal))?.type==='directory',protectedPaths:string[]=[]
  for(const entry of blocked){
   const mapped=fs.processPathFromHostPath(entry.path)
   // 此执行世界不能映射宿主资料时，不猜测其他提供方的路径授权。
   if(mapped===undefined)throw denied()
   const protectedTarget=await fs.resolve(mapped,{cwd,signal:exec.signal}),protectedPath=fs.processPath(protectedTarget)
   if(target.targetKey===protectedTarget.targetKey||search&&contains(processPath,protectedPath))throw denied()
   // 本机硬链接是同一正文；不以另一个文件名绕过登记归属。
   if(mapped===entry.path){
    const targetInode=await inode(processPath),protectedInode=await inode(protectedPath);if(targetInode!==undefined&&targetInode===protectedInode)throw denied()
    if(search){if((await stat(protectedPath)).nlink!==1)throw denied();protectedPaths.push(protectedPath)}
   }else if(search)throw denied()
  }
  if(search)await assertSearchLinks(processPath,protectedPaths,exec.signal)
  await lease.assertCurrent()
  return JSON.stringify([fingerprint,target.targetKey])
 }
 const verify=async(exec:ToolExecution)=>{
  try{return await check(exec)}catch(error){if(error instanceof WorkError||exec.signal.aborted)throw error;throw denied()}
 }
 const pre=ctx.on('tools/pre-execute',async(exec,next)=>{
  try{const snapshot=await verify(exec);if(snapshot!==undefined)checked.set(exec,snapshot)}
  catch(error){return{kind:'deny' as const,reason:error instanceof Error?error.message:'业务资料读取范围暂不可核验。'}}
  return next()
 },{global:true,prepend:true})
 const execute=ctx.on('tools/execute',async(exec,next)=>{
  const prior=checked.get(exec)
  if(prior===undefined)return next()
  // 审批后、实际工具调用前及回包前都核当前来源；审计原事件保持不变。
  if(await verify(exec)!==prior)throw denied()
  const result=await next()
  if(await verify(exec)!==prior)throw denied()
  return result
 },{global:true,prepend:true})
 return()=>{execute();pre()}
}
