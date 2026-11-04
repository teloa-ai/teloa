import {createHash} from 'node:crypto'
import {posix,win32,resolve} from 'node:path'
import {AsyncLocalStorage} from 'node:async_hooks'
import type {Context} from '@deepseek-ai/cordis'
import {FsError,type FileSystem,type FsTarget} from '@deepseek-ai/dsh-fs'
import * as officialFileTools from '@deepseek-ai/dsh-tool-fs'
import * as officialPresent from '@deepseek-ai/dsh-tool-present'
import type {ToolExecution,ToolDefinition} from '@deepseek-ai/dsh-tools'
import {artifactFileMaxBytes,artifactFilePath,isWorkspaceFileRule,workspaceFileToolNames,workspacePathAllowed,workspacePathSchema,hasWorkspacePaths,type TaskToolArgumentRule} from '@teloa/contract'
import type {TaskToolPolicy,TaskToolPolicyReader} from './task-tool-guard.ts'

type FileName=typeof workspaceFileToolNames[number]
type ScopedFileOptions={cwd:string;authorize:(name:FileName|undefined,signal:AbortSignal,path?:string)=>Promise<void>;protectedPath:(path:string)=>boolean;rejectSymlinks?:boolean;verifyRead?:(path:string,bytes:Uint8Array)=>void}
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
  if(options.rejectSymlinks){const lexical=paths.relative(paths.resolve(options.cwd),paths.resolve(options.cwd,path)).split(paths.sep).join('/');if(!artifactFilePath(lexical)||lexical.split('/').some(p=>!p||p==='.'||p==='..'))throw denied();const parts=lexical.split('/');for(let i=1;i<=parts.length;i++){const entry=await fs.lstat(paths.join(options.cwd,...parts.slice(0,i)),{cwd:options.cwd},signal);if(entry&&entry.type!=='file'&&entry.type!=='directory')throw denied('限定文件范围不允许符号链接。')}}
  await options.authorize(name,signal,relative);signal.throwIfAborted();return target
 }
 const checked=async(target:FsTarget,name:FileName|undefined,signal?:AbortSignal)=>{
  const fresh=await check(target.displayPath,name,signal)
  if(fresh.targetKey!==target.targetKey)throw denied('文件目标已变化，请重新读取后再试。')
  const info=await fs.stat(fresh,signal)
  if(info&&info.type!=='file')throw denied('员工文件工具只能处理当前工作目录内的普通文件。')
  await options.authorize(name,signal??new AbortController().signal);signal?.throwIfAborted()
  return fresh
 }
 const relativePath=(target:FsTarget)=>paths.relative(rootPath,fs.processPath(target)).split(paths.sep).join('/');
 const overrides:Partial<FileSystem>={
  resolve:async(path,opts)=>{
   // 官方工具传入的 cwd 必须仍为根工作目录，不能由子会话或沙箱参数换成别处。
   if(opts?.cwd&&resolve(opts.cwd)!==resolve(options.cwd))throw denied()
   return check(path,undefined,opts?.signal)
  },
  stat:async(target,signal)=>{const info=await fs.stat(await checked(target,undefined,signal),signal);await options.authorize(undefined,signal??new AbortController().signal);signal?.throwIfAborted();return info},
  readText:async(target,signal)=>{const fresh=await checked(target,'read',signal),text=await fs.readText(fresh,signal);await checked(fresh,'read',signal);options.verifyRead?.(relativePath(fresh),Buffer.from(text,'utf8'));return text},
  readBytes:async(target,signal,maxBytes)=>{const fresh=await checked(target,'read',signal),bytes=await fs.readBytes(fresh,signal,maxBytes);await checked(fresh,'read',signal);options.verifyRead?.(relativePath(fresh),bytes);return bytes},
  readByteRange:async(target,range,signal)=>{const fresh=await checked(target,'read',signal);if(options.verifyRead){if(!Number.isSafeInteger(range.offset)||range.offset<0||!Number.isSafeInteger(range.length)||range.length<0)throw denied();const all=await fs.readBytes(fresh,signal,artifactFileMaxBytes);await checked(fresh,'read',signal);options.verifyRead(relativePath(fresh),all);return all.subarray(range.offset,range.offset+range.length)}const bytes=await fs.readByteRange(fresh,range,signal);await checked(fresh,'read',signal);return bytes},
  streamText:async(target,signal)=>{
   const fresh=await checked(target,'read',signal);if(options.verifyRead){const bytes=await fs.readBytes(fresh,signal,artifactFileMaxBytes);await checked(fresh,'read',signal);options.verifyRead(relativePath(fresh),bytes);return {async *[Symbol.asyncIterator](){yield Buffer.from(bytes).toString('utf8')}}}const stream=await fs.streamText(fresh,signal)
   return {async *[Symbol.asyncIterator](){for await(const chunk of stream){await checked(fresh,'read',signal);yield chunk}}}
  },
  writeText:async(target,content,expected,signal)=>{const fresh=await checked(target,'write',signal),result=await fs.writeText(fresh,content,expected,signal,{mode:'workspace-write',workspaceRoot:rootPath});await check(fresh.displayPath,'write',signal);return result},
  editText:async(target,edit,expected,signal)=>fs.editText(await checked(target,'edit',signal),edit,expected,signal,{mode:'workspace-write',workspaceRoot:rootPath}),
  listDir:async()=>{throw denied('员工文件授权不包含目录枚举。')},
  watch:async()=>{throw denied('员工文件授权不包含目录监视。')},
  lstat:async(path,opts,signal)=>{await check(path,undefined,signal);const info=await fs.lstat(path,{cwd:options.cwd},signal);await options.authorize(undefined,signal??new AbortController().signal);signal?.throwIfAborted();return info},
 }
 return new Proxy(fs,{get(target,key){if(Object.hasOwn(overrides,key))return Reflect.get(overrides,key);const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})
}

function scopedFileDefinition(definition:ToolDefinition,policy:TaskToolPolicy,_cwd:string):ToolDefinition{
 const restriction=workspacePathSchema(policy.argumentRules??[],definition.name)
 if(!restriction)return definition
 const parameters=definition.parameters as {type:'object';properties:Record<string,object>}
 return {...definition,parameters:{...parameters,properties:{...parameters.properties,file_path:{...parameters.properties.file_path,...restriction}}} as ToolDefinition['parameters']}
}
function fileAllowed(policy:TaskToolPolicy,name:FileName,path?:string):boolean{const has=(op:FileName)=>policy.allowedTools.includes(op)&&!!policy.argumentRules?.some(rule=>rule.name===op&&isWorkspaceFileRule(rule)&&(path===undefined||workspacePathAllowed(rule,path)));return has(name)&&(name!=='edit'||!hasWorkspacePaths(policy.argumentRules)||has('read')&&has('write'))}
export type TaskRunWorkspaceFileAccess={
 check:(exec:ToolExecution,root:{id:string;header:{cwd?:string};snapshotEvents?:()=>readonly {type:string;data:any}[]},policy:TaskToolPolicy)=>Promise<string|undefined>
 recheck:(exec:ToolExecution)=>Promise<void>
}
/** 以公开 scoped-tool 与隔离服务 API 原样装配官方实现，不复制文件工具或放开其他会话。 */
export function createTaskRunWorkspaceFileAccess(ctx:Context,cwd:string,readPolicy:TaskToolPolicyReader,protectedPath:(path:string)=>boolean):TaskRunWorkspaceFileAccess{
 const mounts=new WeakMap<NonNullable<ToolExecution['agent']>,{rootId:string;requestId:string;definitions:Map<string,ToolDefinition>}>()
 const checkedCalls=new WeakMap<ToolExecution,{rootId:string;requestId:string;definition:ToolDefinition;permission:FileName;presentation?:{paths:string[];targets:FsTarget[];authorize:ScopedFileOptions['authorize'];verifyRead:NonNullable<ScopedFileOptions['verifyRead']>;argumentsJSON:string}}>()
 const presentMounts=new WeakMap<NonNullable<ToolExecution['agent']>,{rootId:string;requestId:string;definition:ToolDefinition}>()
 const executingPresent=new AsyncLocalStorage<ToolExecution>()
 const written=new Map<string,string>()
 const recoverWritten=(root:{id:string;snapshotEvents?:()=>readonly {type:string;data:any}[]},requestId:string)=>{
  const prefix=root.id+'\0'+requestId+'\0'
  for(const key of written.keys())if(key.startsWith(prefix))written.delete(key)
  const events=root.snapshotEvents?.()??[]
  let start=-1
  for(let i=events.length-1;i>=0;i--){const event=events[i]!;if(event.type==='user/message'&&event.data.source?.kind==='user'&&event.data.source.rpcId===requestId){start=i;break}}
  if(start<0)return
  const calls=new Map<string,{turn:number;path:string;content:string}>()
  for(const event of events.slice(start+1)){
   if(event.type==='tool/call'){
    calls.delete(event.data.callId)
    if(event.data.name!=='write')continue
    try{const args=typeof event.data.arguments==='string'?JSON.parse(event.data.arguments):event.data.arguments;if(typeof args?.file_path==='string'&&typeof args.content==='string')calls.set(event.data.callId,{turn:event.data.turn,path:args.file_path,content:args.content})}catch{}
   }
   if(event.type!=='tool/result')continue
   const message=event.data.message,call=calls.get(message?.toolCallId)
   if(!call||message.isError||message.source?.kind!=='tool'||message.source.callId!==message.toolCallId||event.data.turn!==call.turn)continue
   const path=posix.relative(cwd,resolve(cwd,call.path))
   if(artifactFilePath(path))written.set(prefix+path,createHash('sha256').update(call.content).digest('hex'))
  }
 }

 const authorizePresentation=async(exec:ToolExecution,path?:string)=>{
  const checked=checkedCalls.get(exec)
  if(!checked?.presentation)throw denied('文件交付不属于已核对的当前运行。')
  await checked.presentation.authorize('read',exec.signal,path)
  exec.signal.throwIfAborted()
  if(ctx.tools.get(exec.name,exec.agent)!==checked.definition||JSON.stringify(exec.arguments)!==checked.presentation.argumentsJSON)throw denied('确认期间交付参数或工具已变化。')
 }
 return {
  async check(exec,root,policy){
   try{
    const agent=exec.agent,requestId=policy.nativeRequestId
    if(!agent||!requestId||!root.header.cwd||resolve(root.header.cwd)!==resolve(cwd)||!agent.session.header.cwd||resolve(agent.session.header.cwd)!==resolve(cwd))throw denied('员工文件调用必须绑定本次运行的默认工作目录。')
    if(exec.name==='present'){
     if(policy.textOnly||!fileAllowed(policy,'read')&&!(hasWorkspacePaths(policy.argumentRules)&&fileAllowed(policy,'write')))throw denied('文件交付需要当前任务的工作目录读取授权。')
     if(!ctx.tools.get('present',agent))throw denied('官方文件交付工具尚未就绪。')
     const source=ctx.agentPresets.serviceFor(agent,'fs')??ctx.fs,workingDirectory=ctx.agentPresets.serviceFor(agent,'workingDirectory')??ctx.workingDirectory
     if(resolve(await workingDirectory.ensure(agent,exec.signal))!==resolve(cwd))throw denied('交付文件必须使用本次运行获准的工作目录。')
     recoverWritten(root,requestId)
     const authorize=async(_name:FileName|undefined,signal:AbortSignal,path?:string)=>{
      const current=await readPolicy(root.id,signal)
      if(root.header.cwd!==cwd||agent.session.header.cwd!==cwd||!current||current.textOnly||current.nativeRequestId!==requestId||current.stopRequested)throw denied('员工文件读取授权已变化，请重新准备执行。')
      if(fileAllowed(current,'read',path))return
      if(!hasWorkspacePaths(current.argumentRules)||!fileAllowed(current,'write',path)||path!==undefined&&!written.has(root.id+'\0'+requestId+'\0'+path))throw denied('交付文件没有本次运行的成功写入回执或读取授权。')
     }
     const verifyRead=(path:string,bytes:Uint8Array)=>{if(fileAllowed(policy,'read',path))return;const expected=written.get(root.id+'\0'+requestId+'\0'+path);if(!expected||createHash('sha256').update(bytes).digest('hex')!==expected)throw denied('成果已变化，不能沿用本次运行的写入回执交付。')}
     const fs=await createScopedWorkspaceFileSystem(source,{cwd,authorize,protectedPath,rejectSymlinks:hasWorkspacePaths(policy.argumentRules)})
     let mount=presentMounts.get(agent)
     if(mount&&(mount.rootId!==root.id||mount.requestId!==requestId))throw denied('文件交付能力不属于当前运行。')
     if(!mount){
      const bodyFS=await createScopedWorkspaceFileSystem(source,{cwd,protectedPath,rejectSymlinks:hasWorkspacePaths(policy.argumentRules),...(hasWorkspacePaths(policy.argumentRules)?{verifyRead:(path:string,bytes:Uint8Array)=>{const exec=executingPresent.getStore(),checked=exec&&checkedCalls.get(exec);if(!checked?.presentation)throw denied();checked.presentation.verifyRead(path,bytes)}}:{}),authorize:async(name,_signal,path)=>{
       if(name!==undefined&&name!=='read')throw denied('文件交付不能写入或编辑文件。')
       const current=executingPresent.getStore()
       if(!current||current.agent!==agent)throw denied('文件交付 I/O 缺少当前工具调用身份。')
       await authorizePresentation(current,path)
      }})
      await agent.ctx.plugin({name:'teloa-run-present',inject:['fs','tools','sessionProjections','workingDirectory'],apply(scope:Context){
       const realm=scope.isolate('fs');realm.provide('fs',bodyFS)
       const registry=scope.tools,tools=new Proxy(registry,{get(target,key){
        if(key==='register')return (definition:ToolDefinition)=>target.register({...definition,execute:(args,exec)=>executingPresent.run(exec,async()=>{
         await authorizePresentation(exec)
         const result=await definition.execute(args,exec)
         await authorizePresentation(exec)
         return result
        })})
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
       }})
       officialPresent.apply(realm.extend({tools,workingDirectory}),{maxFiles:8})
      }})
      const definition=ctx.tools.get('present',agent)
      if(!definition)throw denied('受限官方文件交付工具尚未就绪。')
      mount={rootId:root.id,requestId,definition};presentMounts.set(agent,mount)
     }
     const definition=mount.definition
     if(ctx.tools.get('present',agent)!==definition)throw denied('文件交付工具已变化，请重新准备执行。')
     const args=exec.arguments as {files?:unknown},argumentsJSON=JSON.stringify(exec.arguments)
     if(typeof argumentsJSON!=='string'||!Array.isArray(args?.files)||args.files.length===0||args.files.length>8)throw denied('文件交付只能声明 1 至 8 个当前工作目录中的已有文件。')
     const targets:FsTarget[]=[],paths:string[]=[]
     for(const file of args.files){
      if(!file||typeof file.path!=='string')throw denied('交付文件路径不正确。')
      const target=await fs.resolve(file.path,{cwd,signal:exec.signal}),entry=await fs.lstat(file.path,{cwd},exec.signal)
      if(entry?.type!=='file'||(await fs.stat(target,exec.signal))?.type!=='file')throw denied('只能交付当前工作目录中的已有普通文件。')
      if(!fileAllowed(policy,'read',posix.relative(cwd,resolve(cwd,file.path))))verifyRead(posix.relative(cwd,resolve(cwd,file.path)),await fs.readBytes(target,exec.signal,artifactFileMaxBytes));targets.push(target);paths.push(file.path)
     }
     // 官方实现真正使用 Agent 专属受限 FS，原 pending 和 deliverables/presented 事件不另造。
     checkedCalls.set(exec,{rootId:root.id,requestId,definition,permission:'read',presentation:{paths,targets,authorize,verifyRead,argumentsJSON}})
     return
    }
    if(hasWorkspacePaths(policy.argumentRules)){const path=String((exec.arguments as Record<string,unknown>).file_path),flavor=/^[A-Za-z]:[\\/]/.test(cwd)?win32:posix,relative=flavor.relative(cwd,flavor.resolve(cwd,path)).split(flavor.sep).join('/');if(!fileAllowed(policy,exec.name as FileName,relative))throw denied('文件超出本次操作明确授权的路径。')}
    let mount=mounts.get(agent)
    if(mount&&(mount.rootId!==root.id||mount.requestId!==requestId))throw denied('员工文件权限不属于当前运行。')
    if(!mount){
     const source=ctx.agentPresets.serviceFor(agent,'fs')??ctx.fs
     const authorize=async(name:FileName|undefined,signal:AbortSignal,path?:string)=>{
      if(root.header.cwd!==cwd||agent.session.header.cwd!==cwd)throw denied('当前工作目录已变化。')
      const current=await readPolicy(root.id,signal)
      if(!current||current.nativeRequestId!==requestId||current.stopRequested||!(name?[name]:workspaceFileToolNames).some(tool=>fileAllowed(current,tool,path)))throw denied('员工文件授权已变化，请重新准备执行。')
     }
     const fs=await createScopedWorkspaceFileSystem(source,{cwd,authorize,protectedPath,rejectSymlinks:hasWorkspacePaths(policy.argumentRules)})
     // 变体生命周期归属当前 Agent；父级工具、其他员工和本人会话不受影响。
     const names=workspaceFileToolNames.filter(name=>policy.allowedTools.includes(name)&&policy.argumentRules?.some(rule=>rule.name===name&&isWorkspaceFileRule(rule)))
     agent.ctx.plugin({name:'teloa-run-workspace-files',inject:['fs','tools','systemPrompt'],apply(scope:Context){
      const realm=scope.isolate('fs');realm.provide('fs',fs)
      // 官方工具套件还可注册 read_image；scoped 注册不受 tools.restrict 的全局掩码约束，
      // 因而在公开 register 接口处只装配本 Run 明确授权的三个文件名字。
      const registry=scope.tools,tools=new Proxy(registry,{get(target,key){if(key==='register')return (definition:ToolDefinition)=>names.includes(definition.name as FileName)?target.register(scopedFileDefinition(definition,policy,cwd)):()=>{};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value}})
      realm.extend({tools}).plugin(officialFileTools,{})
     }})
     const definitions=new Map<string,ToolDefinition>()
     for(const name of names){const definition=ctx.tools.get(name,agent);if(!definition)throw denied('官方文件工具尚未就绪。');definitions.set(name,definition)}
     mount={rootId:root.id,requestId,definitions};mounts.set(agent,mount)
    }
    const definition=mount.definitions.get(exec.name)
    if(!definition||ctx.tools.get(exec.name,agent)!==definition)throw denied('文件工具已变化，请重新准备执行。')
    checkedCalls.set(exec,{rootId:root.id,requestId,definition,permission:exec.name as FileName})
    const fs=ctx.agentPresets.serviceFor(agent,'fs')??ctx.fs
    // 第一轮核验供审批展示；实际 I/O 仍由上面的独立 FS 服务再次复核。
    const target=await fs.resolve(String((exec.arguments as Record<string,unknown>).file_path),{cwd,signal:exec.signal}),base=await fs.resolve('.',{cwd,signal:exec.signal})
    const paths=/^[A-Za-z]:[\\/]|^\\\\/.test(fs.processPath(base))?win32:posix
    if(hasWorkspacePaths(policy.argumentRules)&&!fileAllowed(policy,exec.name as FileName,paths.relative(fs.processPath(base),fs.processPath(target)).split(paths.sep).join('/')))throw denied('文件真实目标超出本次操作授权路径。')
    if(!fs.contains(base,target)||!artifactFilePath(paths.relative(fs.processPath(base),fs.processPath(target)).split(paths.sep).join('/'))||protectedPath(fs.processPath(target)))throw denied()
   }catch(error){return error instanceof Error?error.message:'无法核对员工文件范围。'}
  },
  async recheck(exec){
   const checked=checkedCalls.get(exec)
   if(!checked)return
   const policy=await readPolicy(checked.rootId,exec.signal)
   if(!policy||policy.textOnly||policy.nativeRequestId!==checked.requestId||policy.stopRequested||!checked.presentation&&!fileAllowed(policy,checked.permission)||ctx.tools.get(exec.name,exec.agent)!==checked.definition)throw denied('确认期间员工文件授权或工具已变化。')
   if(checked.presentation){
    const {paths,targets,authorize,argumentsJSON}=checked.presentation,agent=exec.agent!
    if(JSON.stringify(exec.arguments)!==argumentsJSON)throw denied('确认期间交付文件已变化。')
    // Context 的服务是上下文代理；按当前提供方和公开 FsTarget 身份复核，不比较代理对象引用。
    const fs=await createScopedWorkspaceFileSystem(ctx.agentPresets.serviceFor(agent,'fs')??ctx.fs,{cwd,authorize,protectedPath,rejectSymlinks:hasWorkspacePaths(policy.argumentRules)})
    for(const [index,path] of paths.entries()){
     const target=await fs.resolve(path,{cwd,signal:exec.signal}),entry=await fs.lstat(path,{cwd},exec.signal)
     if(target.targetKey!==targets[index]!.targetKey||entry?.type!=='file'||(await fs.stat(target,exec.signal))?.type!=='file')throw denied('交付文件已变化或不再是普通文件。')
    }
    const workingDirectory=ctx.agentPresets.serviceFor(agent,'workingDirectory')??ctx.workingDirectory
    if(resolve(await workingDirectory.ensure(agent,exec.signal))!==resolve(cwd))throw denied('确认期间交付工作目录已变化。')
    await authorizePresentation(exec)
   }
  },
 }
}
