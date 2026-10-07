import {posix,win32,resolve} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import {FsError,type FileSystem,type FsTarget} from '@deepseek-ai/dsh-fs'
import * as officialFileTools from '@deepseek-ai/dsh-tool-fs'
import type {ToolExecution,ToolDefinition} from '@deepseek-ai/dsh-tools'
import {artifactFilePath,isWorkspaceFileRule,workspaceFileToolNames,type TaskToolArgumentRule} from '@teloa/contract'
import type {TaskToolPolicy,TaskToolPolicyReader} from './task-tool-guard.ts'

type FileName=typeof workspaceFileToolNames[number]
type ScopedFileOptions={cwd:string;authorize:(name:FileName|undefined,signal:AbortSignal)=>Promise<void>;protectedPath:(path:string)=>boolean}
const denied=(reason='文件不在员工获准的当前工作目录范围内。')=>new FsError(reason,'FS_SANDBOX_DENIED')

/** 只发布真实存在的官方文件工具；文件权限不借用原生浏览器或任意参数授权。 */
export async function workspaceFileToolRules(ctx:Context,agent?:ToolExecution['agent']):Promise<TaskToolArgumentRule[]>{
 try{
  const fs=agent?ctx.agentPresets.serviceFor(agent,'fs')??ctx.fs:ctx.fs
  if(fs.sandboxMode===undefined)return []
  const rules=(scope?:Parameters<Context['tools']['get']>[1])=>workspaceFileToolNames.filter(name=>ctx.tools.get(name,scope)!==undefined).map(name=>({name,allowed:[],workspaceFiles:'default-workspace' as const}))
  if(agent)return rules(agent)
  // 新员工没有 Agent：借用官方默认预设的只读 lease，不为发现权限候选创建会话。
  const registry=ctx.get('agentPresets')
  if(registry?.acquireScope){const lease=await registry.acquireScope();try{return rules(lease.key)}finally{await lease[Symbol.asyncDispose]()}}
  return rules()
 }catch{return []}
}

/**
 * 官方文件工具使用的窄 FS 服务。在每次实际 I/O 前复核授权与真实目标，变更仍走官方
 * workspace-write 和 observation-policy。继承 DSH fs-sandbox 的可信代码威胁模型：
 * 这不是内核边界，不声称消除 containment 复核与系统调用之间的祖先链接替换竞态。
 */
export async function createScopedWorkspaceFileSystem(fs:FileSystem,options:ScopedFileOptions):Promise<FileSystem>{
 if(fs.sandboxMode===undefined)throw denied('当前文件提供方没有受限写入能力，员工文件权限不可用。')
 const root=await fs.resolve('.',{cwd:options.cwd}),rootPath=fs.processPath(root)
 const paths=/^[A-Za-z]:[\\/]|^\\\\/.test(rootPath)?win32:posix
 const check=async(path:string,name:FileName|undefined,signal=new AbortController().signal)=>{
  signal.throwIfAborted();await options.authorize(name,signal)
  if(!path.trim()||path.length>1024||/[\x00-\x1f\x7f]/.test(path)||path.split(/[\\/]/).includes('..'))throw denied()
  const currentRoot=await fs.resolve('.',{cwd:options.cwd,signal})
  if(currentRoot.targetKey!==root.targetKey)throw denied('当前工作目录身份已变化，请重新准备执行。')
  const target=await fs.resolve(path,{cwd:options.cwd,signal})
  const relative=paths.relative(rootPath,fs.processPath(target)).split(paths.sep).join('/')
  if(!fs.contains(root,target)||!artifactFilePath(relative))throw denied()
  if(options.protectedPath(fs.processPath(target)))throw denied('文件属于本机凭据保护范围，已拒绝。')
  signal.throwIfAborted();return target
 }
 const checked=async(target:FsTarget,name:FileName|undefined,signal?:AbortSignal)=>{
  const fresh=await check(target.displayPath,name,signal)
  if(fresh.targetKey!==target.targetKey)throw denied('文件目标已变化，请重新读取后再试。')
  const info=await fs.stat(fresh,signal)
  if(info&&info.type!=='file')throw denied('员工文件工具只能处理当前工作目录内的普通文件。')
  return fresh
 }
 const overrides:Partial<FileSystem>={
  resolve:async(path,opts)=>{
   // 官方工具传入的 cwd 必须仍为根工作目录，不能由子会话或沙箱参数换成别处。
   if(opts?.cwd&&resolve(opts.cwd)!==resolve(options.cwd))throw denied()
   return check(path,undefined,opts?.signal)
  },
  stat:async(target,signal)=>fs.stat(await checked(target,undefined,signal),signal),
  readText:async(target,signal)=>{const fresh=await checked(target,'read',signal),text=await fs.readText(fresh,signal);await checked(fresh,'read',signal);return text},
  readBytes:async(target,signal,maxBytes)=>{const fresh=await checked(target,'read',signal),bytes=await fs.readBytes(fresh,signal,maxBytes);await checked(fresh,'read',signal);return bytes},
  readByteRange:async(target,range,signal)=>{const fresh=await checked(target,'read',signal),bytes=await fs.readByteRange(fresh,range,signal);await checked(fresh,'read',signal);return bytes},
  streamText:async(target,signal)=>{
   const fresh=await checked(target,'read',signal),stream=await fs.streamText(fresh,signal)
   return {async *[Symbol.asyncIterator](){for await(const chunk of stream){await checked(fresh,'read',signal);yield chunk}}}
  },
  writeText:async(target,content,expected,signal)=>fs.writeText(await checked(target,'write',signal),content,expected,signal,{mode:'workspace-write',workspaceRoot:rootPath}),
  editText:async(target,edit,expected,signal)=>fs.editText(await checked(target,'edit',signal),edit,expected,signal,{mode:'workspace-write',workspaceRoot:rootPath}),
  listDir:async()=>{throw denied('员工文件授权不包含目录枚举。')},
  watch:async()=>{throw denied('员工文件授权不包含目录监视。')},
  lstat:async(path,opts,signal)=>{await check(path,undefined,signal);return fs.lstat(path,{cwd:options.cwd},signal)},
 }
 return new Proxy(fs,{get(target,key){if(Object.hasOwn(overrides,key))return Reflect.get(overrides,key);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})
}

export type TaskRunWorkspaceFileAccess={
 check:(exec:ToolExecution,root:{id:string;header:{cwd?:string}},policy:TaskToolPolicy)=>Promise<string|undefined>
 recheck:(exec:ToolExecution)=>Promise<void>
}
/** 以公开 scoped-tool 与隔离服务 API 原样装配官方实现，不复制文件工具或放开其他会话。 */
export function createTaskRunWorkspaceFileAccess(ctx:Context,cwd:string,readPolicy:TaskToolPolicyReader,protectedPath:(path:string)=>boolean):TaskRunWorkspaceFileAccess{
 const mounts=new WeakMap<NonNullable<ToolExecution['agent']>,{rootId:string;requestId:string;definitions:Map<string,ToolDefinition>}>()
 const checkedCalls=new WeakMap<ToolExecution,{rootId:string;requestId:string;definition:ToolDefinition}>()
 return {
  async check(exec,root,policy){
   try{
    const agent=exec.agent,requestId=policy.nativeRequestId
    if(!agent||!requestId||!root.header.cwd||resolve(root.header.cwd)!==resolve(cwd)||!agent.session.header.cwd||resolve(agent.session.header.cwd)!==resolve(cwd))throw denied('员工文件调用必须绑定本次运行的默认工作目录。')
    let mount=mounts.get(agent)
    if(mount&&(mount.rootId!==root.id||mount.requestId!==requestId))throw denied('员工文件权限不属于当前运行。')
    if(!mount){
     const source=ctx.agentPresets.serviceFor(agent,'fs')??ctx.fs
     const authorize=async(name:FileName|undefined,signal:AbortSignal)=>{
      if(root.header.cwd!==cwd||agent.session.header.cwd!==cwd)throw denied('当前工作目录已变化。')
      const current=await readPolicy(root.id,signal)
      if(!current||current.nativeRequestId!==requestId||current.stopRequested||!(name?[name]:workspaceFileToolNames).some(tool=>current.allowedTools.includes(tool)&&current.argumentRules?.some(rule=>rule.name===tool&&isWorkspaceFileRule(rule))))throw denied('员工文件授权已变化，请重新准备执行。')
     }
     const fs=await createScopedWorkspaceFileSystem(source,{cwd,authorize,protectedPath})
     // 变体生命周期归属当前 Agent；父级工具、其他员工和本人会话不受影响。
     const names=workspaceFileToolNames.filter(name=>policy.allowedTools.includes(name)&&policy.argumentRules?.some(rule=>rule.name===name&&isWorkspaceFileRule(rule)))
     agent.ctx.plugin({name:'teloa-run-workspace-files',inject:['fs','tools','systemPrompt'],apply(scope:Context){
      const realm=scope.isolate('fs');realm.provide('fs',fs)
      // 官方工具套件还可注册 read_image；scoped 注册不受 tools.restrict 的全局掩码约束，
      // 因而在公开 register 接口处只装配本 Run 明确授权的三个文件名字。
      const registry=scope.tools,tools=new Proxy(registry,{get(target,key){if(key==='register')return (definition:ToolDefinition)=>names.includes(definition.name as FileName)?target.register(definition):()=>{};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})
      realm.extend({tools}).plugin(officialFileTools,{})
     }})
     const definitions=new Map<string,ToolDefinition>()
     for(const name of names){const definition=ctx.tools.get(name,agent);if(!definition)throw denied('官方文件工具尚未就绪。');definitions.set(name,definition)}
     mount={rootId:root.id,requestId,definitions};mounts.set(agent,mount)
    }
    const definition=mount.definitions.get(exec.name)
    if(!definition||ctx.tools.get(exec.name,agent)!==definition)throw denied('文件工具已变化，请重新准备执行。')
    checkedCalls.set(exec,{rootId:root.id,requestId,definition})
    const fs=ctx.agentPresets.serviceFor(agent,'fs')??ctx.fs
    // 第一轮核验供审批展示；实际 I/O 仍由上面的独立 FS 服务再次复核。
    const target=await fs.resolve(String((exec.arguments as Record<string,unknown>).file_path),{cwd,signal:exec.signal}),base=await fs.resolve('.',{cwd,signal:exec.signal})
    const paths=/^[A-Za-z]:[\\/]|^\\\\/.test(fs.processPath(base))?win32:posix
    if(!fs.contains(base,target)||!artifactFilePath(paths.relative(fs.processPath(base),fs.processPath(target)).split(paths.sep).join('/'))||protectedPath(fs.processPath(target)))throw denied()
   }catch(error){return error instanceof Error?error.message:'无法核对员工文件范围。'}
  },
  async recheck(exec){
   const checked=checkedCalls.get(exec)
   if(!checked)return
   const policy=await readPolicy(checked.rootId,exec.signal)
   if(!policy||policy.nativeRequestId!==checked.requestId||policy.stopRequested||!policy.allowedTools.includes(exec.name)||!policy.argumentRules?.some(rule=>rule.name===exec.name&&isWorkspaceFileRule(rule))||ctx.tools.get(exec.name,exec.agent)!==checked.definition)throw denied('确认期间员工文件授权或工具已变化。')
  },
 }
}
