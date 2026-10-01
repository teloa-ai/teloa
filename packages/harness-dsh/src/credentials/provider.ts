import {Service,type Context} from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {randomBytes} from 'node:crypto'
import {constants,readdirSync,unwatchFile,watchFile} from 'node:fs'
import {chmod,lstat,open as openFile,readdir,readFile,rename,stat,unlink,type FileHandle} from 'node:fs/promises'
import {homedir} from 'node:os'
import {basename,isAbsolute,join} from 'node:path'
import {withFileLock,writeFileAtomic} from '@deepseek-ai/dsh-atomic-write'
import {resolveDshHome} from '@deepseek-ai/dsh-home-paths'
import {launchEnvironmentOf,type LaunchEnvironmentSnapshot} from '@deepseek-ai/dsh-launch-environment'
import {CredentialProvider,credentialRef,parseCredentialKey,type CredentialInfo,type CredentialKey,type CredentialRecord,type CredentialRecordEntry,type CredentialRecordInfo,type CredentialRef,type ResolvedCredential} from '@deepseek-ai/dsh-credentials'
import {parseCredentialsDocument} from '@deepseek-ai/dsh-credentials-local'
import {EnvelopeError,open,seal} from './envelope.ts'
import {defaultKeyDir,loadNativeKeyring,type Env,type KeyringPort} from './key-sources.ts'
import {clearStaleLock,CredentialStoreLocked,lockWait,readOptional,resolveStore,storePaths,StoreFault,type LockReason,type ResolvedStore,type StorePaths,type StorePreference,type StoreTier} from './store-state.ts'
import {secretValuesOf} from './known-values.ts'
import {processLayerEnv} from '../launch-env.ts'

/**
 * Teloa 凭据提供方（规格 2026-09-26-凭据存储加固 §3）：官方 CredentialProvider 的加密实现。
 * 文档用官方 parseCredentialsDocument 解析与校验、以 JSON 写出（JSON 是合法 YAML），回滚后官方插件可直接读回。
 * 锁定时照常激活、只读服务最后一次读好的快照、拒绝一切落盘写入；绝不写明文、绝不重建空文件。
 */
type Doc={refs:Map<string,string>;records:Map<string,CredentialRecord>}
export type CredentialStoreStatus={tier:StoreTier|null;fault:LockReason|null}
export type ProviderDeps={keyring?:KeyringPort|undefined;keyDir?:string;env?:Env}
type Config={dshHome?:string;store?:StorePreference}

export function renderDocument(doc:Doc):string{
 return JSON.stringify({version:1,refs:Object.fromEntries(doc.refs),records:Object.fromEntries(doc.records)},null,2)+'\n'
}
const canonical=(value:unknown):string=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)
const sameDocument=(a:Doc,b:Doc):boolean=>canonical({refs:Object.fromEntries(a.refs),records:Object.fromEntries(a.records)})===canonical({refs:Object.fromEntries(b.refs),records:Object.fromEntries(b.records)})
/**
 * 锁定时唯一放行的记录：官方 dsh-client-connection 激活必须 modifyRecord 这条浏览器会话签名密钥（32 字节随机，
 * 缺失即重新生成，代价只是旧浏览器 cookie 失效），写不进去宿主 Web 连接就起不来、用户也看不到锁定报错。
 * 锁定期间它只进进程内覆盖层：不落盘、不解锁存储，停用即丢弃；存储恢复后由正常路径重新生成并持久化。
 */
const volatileRecordKeys=new Set(['client-connection/browser-session'])
/**
 * 档位与主密钥来源只认启动时继承的进程环境（快照的 `process` 层）。DSH 会把工作区 `.env` 与 `$DSH_HOME/.env`
 * 合入 `process.env`，模型与克隆来的仓库都能写工作区 `.env`：让它们参与决策，就能把已加密存储锁死，或换成自己知道的主密钥。
 * `HOME`/`USERPROFILE`/`XDG_*` 属于 DSH 的 bootstrap 名，`.env` 本就设不了。
 */
const keySourceNames=['TELOA_BROWSER_ACCEPTANCE','TELOA_CREDENTIALS_KEYRING','TELOA_CREDENTIALS_KEY_DIR','TELOA_CREDENTIALS_KEY_FILE','CREDENTIALS_DIRECTORY','TELOA_RUNTIME_ROOT','XDG_CONFIG_HOME','APPDATA']
export function keySourceEnv(launch:LaunchEnvironmentSnapshot):Env{
 return processLayerEnv(launch,keySourceNames)
}
const quarantinePrefix='.credentials.yaml.quarantine-'
/** `dsh-atomic-write` 的临时名 `${filename}.<12 位十六进制>.tmp`：官方插件与明文档写 `.credentials.yaml` 时崩溃留下的明文残留。 */
const legacyTempPattern=/^\.credentials\.yaml\.[0-9a-f]+\.tmp$/
/** 原位覆写同长度零字节并落盘（不先截断：截断后再写落在新分配的块上，原明文块原样留在磁盘）。 */
async function wipe(handle:FileHandle,size:number):Promise<void>{
 if(size>0)await handle.write(Buffer.alloc(size),0,size,0)
 await handle.sync()
}
async function readSecretFile(path:string):Promise<string|undefined>{try{const text=(await readFile(path,'utf8')).replace(/\r?\n$/,'');return text.length?text:undefined}catch{return undefined}}

export default class TeloaCredentialProvider extends CredentialProvider{
 static Config=z.object({dshHome:z.string(),store:z.union([z.const('auto'),z.const('keyring'),z.const('file')]).default('auto')})
 readonly paths:StorePaths
 private readonly preference:StorePreference
 private readonly deps:ProviderDeps
 private keyDir=''
 private state:ResolvedStore={mode:'locked',reason:'store-unavailable'}
 private fault:LockReason|undefined='store-unavailable'
 private text:string|undefined
 private refs=new Map<string,string>()
 private records=new Map<string,CredentialRecord>()
 private operations:Promise<void>=Promise.resolve()
 private closed=false
 private loaded=false
 private readonly volatile=new Map<string,CredentialRecord>()
 private quarantined:string[]=[]

 constructor(ctx:Context,config:Config={},deps:ProviderDeps={}){
  super(ctx)
  this.paths=storePaths(resolveDshHome(config.dshHome))
  this.preference=config.store??'auto'
  this.deps=deps
 }

 async *[Service.init](){
  yield async()=>{this.closed=true;await this.operations;this.volatile.clear()}
  // 运行标记：宿主停止前凭据维护命令据此拒绝执行（功能验证）；写失败不影响激活。
  // 不跟随符号链接（否则能借它截断本用户任意文件），也不写硬链接（链接数大于 1 时截断会波及另一路径）：打开时不带 O_TRUNC，
  // 核对句柄是链接数为 1 的普通文件后才截断写入。停用时只删本进程写的标记（同一 DSH_HOME 上可能有后起的宿主）。
  const marker=join(this.paths.dshHome,'.credentials.host.pid'),pid=String(process.pid)
  const written=await openFile(marker,constants.O_WRONLY|constants.O_CREAT|(constants.O_NOFOLLOW??0),0o600)
   .then(async handle=>{
    try{
     const info=await handle.stat()
     if(!info.isFile()||info.nlink!==1)return false
     await handle.truncate(0);await handle.write(pid+'\n',0);return true
    }finally{await handle.close()}
   },()=>false)
  if(written)yield async()=>{if((await readFile(marker,'utf8').catch(()=>'')).trim()===pid)await unlink(marker).catch(()=>{})}
  // 激活过程的任何异常（原生钥匙串加载、锁等待超时、meta 写入失败、目录不可写）都转为锁定，插件照常激活，宿主不因凭据整体起不来。
  try{
   const env=this.deps.env??keySourceEnv(launchEnvironmentOf(this.ctx))
   this.keyDir=this.deps.keyDir??defaultKeyDir(env,process.platform,homedir())
   const keyring='keyring' in this.deps?this.deps.keyring:await loadNativeKeyring(env)
   this.state=await resolveStore(this.paths,this.preference,{keyring,env,keyDir:this.keyDir})
  }catch{this.state={mode:'locked',reason:'store-unavailable'}}
  await this.scanQuarantined()
  await this.wipeLegacyTemps().catch(()=>{this.ctx.logger.warn('credentials: plaintext temp files were not cleaned up (failed)')})
  if(this.state.mode==='locked'){this.fault=this.state.reason;this.ctx.logger.error('credentials: store locked (%s); stored credentials are unavailable and writes are refused',this.state.reason);return}
  this.fault=undefined
  if(this.state.mode==='plaintext')this.ctx.logger.warn('credentials: no system keyring or key file is available; credentials stay in an owner-only plaintext file')
  try{await this.migrateLegacy();await this.reconcile();this.loaded=true}
  catch(error){this.fault=error instanceof StoreFault?error.reason:error instanceof EnvelopeError?'document-corrupt':'store-unavailable';this.ctx.logger.error('credentials: initial read failed (%s); writes are refused',this.fault);return}
  const watched=this.dataPath()
  const listener=()=>{if(!this.closed)void this.enqueue(()=>this.refresh()).catch(error=>this.ctx.logger.error(error))}
  watchFile(watched,{interval:1000},listener)
  yield ()=>unwatchFile(watched,listener)
 }

 status():CredentialStoreStatus{return {tier:this.state.mode==='locked'?null:this.state.meta.tier,fault:this.fault??null}}
 /**
  * 受守卫保护的路径：凭据文件三件、钥匙串账户登记、运行标记、`$DSH_HOME/.env`（凭据分层来源）、DSH_HOME 下现有的全部 `.credentials.*`
  * （`.bak-*`、隔离、原子写残留、锁与接管互斥文件）、密钥文件与默认密钥目录。不含整个 DSH_HOME（关键决定 8）。
  * 每次工具调用现列一遍目录：改名链接指向运行中新出现的副本也按真实位置拦下。
  */
 protectedPaths():string[]{
  const siblings=(()=>{try{return readdirSync(this.paths.dshHome).filter(name=>name.startsWith('.credentials.')).map(name=>join(this.paths.dshHome,name))}catch{return []}})()
  return [...new Set([this.paths.encrypted,this.paths.legacy,this.paths.meta,this.paths.keyringAccounts,join(this.paths.dshHome,'.credentials.host.pid'),join(this.paths.dshHome,'.env'),...siblings,this.keyDir,...(this.state.mode==='encrypted'&&this.state.meta.keyFile?[this.state.meta.keyFile]:[]),...this.quarantined])].filter(Boolean)
 }
 /** 被隔离的明文文件（`.credentials.yaml.quarantine-*`）：常驻警告，进入历史明文副本清单，由本人确认删除。 */
 quarantinedPlaintextPaths():string[]{return [...this.quarantined]}
 /**
  * 启动清理原子写崩溃残留的明文 `.credentials.yaml.<hex>.tmp`：在明文写锁内原位覆写零字节并落盘后删除。
  * 符号链接只删链接本身、不跟随；硬链接（链接数大于 1）拒绝擦除并保留，否则会波及另一路径。日志只记个数。
  */
 private async wipeLegacyTemps():Promise<void>{
  const names=(await readdir(this.paths.dshHome).catch(()=>[] as string[])).filter(name=>legacyTempPattern.test(name))
  if(!names.length)return
  let kept=0
  await clearStaleLock(this.paths.legacy)
  await withFileLock(this.paths.legacy,async()=>{
   for(const name of names){
    const path=join(this.paths.dshHome,name)
    try{
     if((await lstat(path)).isSymbolicLink()){await unlink(path);continue}
     const handle=await openFile(path,constants.O_RDWR|constants.O_NONBLOCK|(constants.O_NOFOLLOW??0))
     let wiped=false
     try{const info=await handle.stat();if(info.isFile()&&info.nlink===1){await wipe(handle,info.size);wiped=true}}finally{await handle.close()}
     if(wiped)await unlink(path);else kept++
    }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')kept++}
   }
  },{waitMs:2_000})
  if(kept)this.ctx.logger.warn('credentials: %d plaintext temp file(s) could not be wiped safely and were kept',kept)
 }
 private async scanQuarantined():Promise<void>{
  const names=await readdir(this.paths.dshHome).catch(()=>[] as string[])
  this.quarantined=names.filter(name=>name.startsWith(quarantinePrefix)).sort().map(name=>join(this.paths.dshHome,name))
  if(this.quarantined.length)this.ctx.logger.warn('credentials: %d quarantined plaintext credential file(s) remain in the harness home and were not imported; review them in settings and delete',this.quarantined.length)
 }
 /**
  * 仍在用的明文文件：明文档的存储本身，或加密档尚未迁移成功（锁定、迁移失败）时待迁移的旧文件；历史副本清单须排除它。
  * 加密档已读好时返回 undefined：此后 DSH_HOME 里再出现的 `.credentials.yaml`（如 DSH 首启自动生成后残留）只是历史明文副本。
  */
 livePlaintextPath():string|undefined{return this.state.mode==='encrypted'&&this.loaded?undefined:this.paths.legacy}
 secretValues():string[]{return [...new Set([...this.refs.values(),...[...this.records,...this.volatileEntries()].flatMap(([key,record])=>secretValuesOf(key,record))])]}
 /** 覆盖层只在存储不可写时生效。 */
 private volatileEntries():[string,CredentialRecord][]{return this.fault===undefined?[]:[...this.volatile]}

 async resolve(ref:CredentialRef):Promise<ResolvedCredential|undefined>{
  const env=launchEnvironmentOf(this.ctx)
  const inherited=env.getFrom(ref,['process'])
  if(inherited&&inherited.value.length>0)return {value:inherited.value,source:'env'}
  const pointer=env.getFrom(`${ref}_FILE`,['process'])
  if(pointer&&isAbsolute(pointer.value)){const value=await readSecretFile(pointer.value);if(value!==undefined)return {value,source:'env-file'}}
  const stored=this.refs.get(ref)
  if(stored!==undefined)return {value:stored,source:'file'}
  const user=env.getFrom(ref,['user-env'])
  return user&&user.value.length>0?{value:user.value,source:user.source}:undefined
 }
 async describe(ref:CredentialRef):Promise<CredentialInfo>{
  const resolved=await this.resolve(ref),writable=this.fault===undefined&&!this.shadowed(ref)
  return resolved?{configured:true,source:resolved.source,writable}:{configured:false,writable}
 }
 async set(ref:CredentialRef,value:string):Promise<void>{
  if(value.length===0)throw new Error(`credentials: an empty value cannot be stored for "${ref}"; use unset`)
  this.assertUnshadowed(ref)
  await this.edit(`set ${ref}`,async doc=>{doc.refs.set(ref,value);return {next:doc,result:undefined}})
 }
 async unset(ref:CredentialRef):Promise<void>{
  this.assertUnshadowed(ref)
  await this.edit(`unset ${ref}`,async doc=>doc.refs.delete(ref)?{next:doc,result:undefined}:{result:undefined})
 }
 /** 没有读好过的快照时，记录“不存在”与“读不到”不可混淆：抛锁定错误（关键决定 7）。 */
 private assertReadable():void{if(!this.loaded)throw new CredentialStoreLocked(this.fault??'store-unavailable')}
 readRecord(key:CredentialKey):Promise<CredentialRecord|undefined>{
  const held=this.fault===undefined?undefined:this.volatile.get(key)
  if(held)return Promise.resolve(held)
  try{this.assertReadable()}catch(error){return Promise.reject(error)};return Promise.resolve(this.records.get(key))}
 describeRecord(key:CredentialKey):Promise<CredentialRecordInfo>{
  const held=this.fault===undefined?undefined:this.volatile.get(key)
  if(held)return Promise.resolve({configured:true,kind:held.kind,writable:false})
  if(!this.loaded)return Promise.resolve({configured:false,writable:false})
  const stored=this.records.get(key)
  return Promise.resolve(stored?{configured:true,kind:stored.kind,writable:this.fault===undefined}:{configured:false,writable:this.fault===undefined})
 }
 /** 没有读好的快照时仍抛锁定错误：只列覆盖层会让调用方把“读不到”当成“没有”。 */
 listRecords():Promise<readonly CredentialRecordEntry[]>{try{this.assertReadable()}catch(error){return Promise.reject(error)};return Promise.resolve([...new Map([...this.records,...this.volatileEntries()])].map(([key,record])=>({key:parseCredentialKey(key),kind:record.kind})))}
 modifyRecord(key:CredentialKey,mutate:(current:CredentialRecord|undefined)=>Promise<CredentialRecord|undefined>):Promise<CredentialRecord|undefined>{
  if(this.fault!==undefined&&!this.closed&&volatileRecordKeys.has(key))return this.enqueue(async()=>{
   if(this.closed)throw new Error(`credentials is disposed: cannot modify ${key}`)
   const current=this.volatile.get(key)??(this.loaded?this.records.get(key):undefined),next=await mutate(current)
   if(next===undefined)return current
   this.volatile.set(key,next)
   this.notifyRecordUpdated(parseCredentialKey(key))
   return next
  })
  return this.edit(`modify ${key}`,async doc=>{
   const current=doc.records.get(key),next=await mutate(current)
   if(next===undefined)return {result:current}
   doc.records.set(key,next)
   return {next:doc,result:next}
  })
 }
 async deleteRecord(key:CredentialKey):Promise<void>{
  await this.edit(`delete ${key}`,async doc=>doc.records.delete(key)?{next:doc,result:undefined}:{result:undefined})
 }

 /** 启动环境给了 REF 或 REF_FILE（即便文件读不到）：存储里的值会被遮住，按不可写处理。 */
 private shadowed(ref:string):boolean{
  const env=launchEnvironmentOf(this.ctx)
  return Boolean(env.getFrom(ref,['process'])?.value||env.getFrom(`${ref}_FILE`,['process'])?.value)
 }
 private assertUnshadowed(ref:string):void{
  if(this.shadowed(ref))throw new Error(`credentials: "${ref}" is supplied read-only by the launching environment, so the write would be shadowed`)
 }
 private blocked(what:string):Error|undefined{
  if(this.closed)return new Error(`credentials is disposed: cannot ${what}`)
  return this.fault===undefined?undefined:new CredentialStoreLocked(this.fault)
 }
 private edit<T>(what:string,operation:(doc:Doc)=>Promise<{next?:Doc;result:T}>):Promise<T>{
  const early=this.blocked(what)
  if(early)return Promise.reject(early)
  return this.enqueue(async()=>{
   const late=this.blocked(what)
   if(late)throw late
   // 写锁孤儿（持锁进程崩溃）不接管就会让之后每次写入都等满 30 s 后失败。
   await clearStaleLock(this.dataPath())
   return withFileLock(this.dataPath(),async()=>{
    try{await this.reconcile()}catch(error){if(error instanceof EnvelopeError)this.fault='document-corrupt';throw error}
    const {next,result}=await operation({refs:new Map(this.refs),records:new Map(this.records)})
    if(next!==undefined){
     const text=renderDocument(next)
     parseCredentialsDocument(text,'teloa-credentials')
     await this.writeData(text)
     this.publish(text,next)
    }
    return result
   },lockWait)
  })
 }
 private enqueue<T>(operation:()=>Promise<T>):Promise<T>{
  const task=this.operations.then(operation)
  this.operations=task.then(()=>undefined,()=>undefined)
  return task
 }
 private publish(text:string|undefined,next:Doc):void{
  const changedRefs=[...new Set([...this.refs.keys(),...next.refs.keys()])].filter(key=>this.refs.get(key)!==next.refs.get(key))
  const changedRecords=[...new Set([...this.records.keys(),...next.records.keys()])].filter(key=>canonical(this.records.get(key))!==canonical(next.records.get(key)))
  this.text=text;this.refs=next.refs;this.records=next.records
  for(const key of changedRefs)this.notifyUpdated(credentialRef(key))
  for(const key of changedRecords)this.notifyRecordUpdated(parseCredentialKey(key))
 }
 private async reconcile():Promise<void>{
  const text=await this.readData()
  if(text===this.text||this.closed)return
  this.publish(text,text===undefined?{refs:new Map(),records:new Map()}:parseCredentialsDocument(text,'teloa-credentials'))
 }
 private async refresh():Promise<void>{
  if(this.closed)return
  try{await this.reconcile()}catch(error){
   if(error instanceof EnvelopeError){this.fault='document-corrupt';this.ctx.logger.error('credentials: encrypted document failed verification; serving the last good snapshot read-only')}
   else this.ctx.logger.warn('credentials: reload failed; keeping the last good document')
  }
 }
 private dataPath():string{return this.state.mode==='plaintext'?this.paths.legacy:this.paths.encrypted}
 private async readData():Promise<string|undefined>{
  const state=this.state
  if(state.mode==='locked')throw new StoreFault(state.reason)
  const raw=await readOptional(this.dataPath())
  if(raw===undefined)return undefined
  if(state.mode==='plaintext'){
   if(process.platform!=='win32'&&((await stat(this.paths.legacy)).mode&0o077)!==0)throw new StoreFault('store-unavailable')
   return raw
  }
  const opened=open(state.key,raw)
  if(opened.fileId!==state.meta.installId)throw new EnvelopeError('key-mismatch')
  return opened.plaintext
 }
 private async writeData(text:string):Promise<void>{
  const state=this.state
  if(state.mode==='locked')throw new StoreFault(state.reason)
  await writeFileAtomic(this.dataPath(),state.mode==='plaintext'?text:seal(state.key,state.meta.installId,text),{mode:0o600,dirMode:0o700})
 }
 /**
  * 旧明文 → 加密（规格 §3.5）。以 O_NOFOLLOW 打开，读取与擦除用同一句柄，不跟随符号链接、不覆写链接目标。
  * - 没有 `.enc`：解析 → 加密写入 → 解密逐项比对 → 原位擦除 → 删除；解析失败或不是普通文件则锁定，旧文件原样保留。
  * - 已有 `.enc`，旧文件为空或全 NUL/空白：上次擦除中途中断，直接删除。内容一致：擦除并删除。
  * - 已有 `.enc`，旧文件不一致、无法解析或不是普通文件：接管后 DSH 不应再写它。不导入（可被利用注入凭据），
  *   也不锁定（一个外部文件就能让宿主失能），原子改名隔离为 `.credentials.yaml.quarantine-<时间>`（0600），常驻警告。
  *   打不开（如 0000 权限）的同样隔离；硬链接（链接数大于 1）不改名也不改权限，原位保留，作为历史明文副本进设置页清单。
  */
 private async migrateLegacy():Promise<void>{
  if(this.state.mode!=='encrypted')return
  await clearStaleLock(this.paths.encrypted)
  await withFileLock(this.paths.encrypted,async()=>{
   let handle:FileHandle
   try{handle=await openFile(this.paths.legacy,constants.O_RDWR|constants.O_NONBLOCK|(constants.O_NOFOLLOW??0))}
   catch(error){
    const code=(error as NodeJS.ErrnoException).code
    if(code==='ENOENT')return
    // 打不开的旧文件（符号链接、目录、无读写权限）：已有 .enc 时按 M5 隔离、不锁定；首次初始化时它是唯一数据，锁定并原样保留。
    if(code!=='ELOOP'&&code!=='EISDIR'&&code!=='EACCES'&&code!=='EPERM')throw error
    if(await this.readData()===undefined)throw new StoreFault('store-unavailable')
    await this.quarantineLegacy(undefined);return
   }
   try{
    const info=await handle.stat(),existing=await this.readData()
    if(!info.isFile()){
     if(existing===undefined)throw new StoreFault('store-unavailable')
     await this.quarantineLegacy(handle);return
    }
    const legacy=await handle.readFile('utf8')
    if(existing!==undefined){
     if(/^[\0\s]*$/.test(legacy)){await this.removeLegacy(info.ino);this.ctx.logger.info('credentials: removed the residue of an interrupted plaintext wipe');return}
     let doc
     try{doc=parseCredentialsDocument(legacy,this.paths.legacy)}catch{doc=undefined}
     if(doc===undefined||!sameDocument(parseCredentialsDocument(existing,'teloa-credentials'),doc)){await this.quarantineLegacy(handle);return}
     await wipe(handle,info.size);await this.removeLegacy(info.ino)
     return
    }
    const doc=parseCredentialsDocument(legacy,this.paths.legacy)
    await this.writeData(renderDocument(doc))
    const back=await this.readData()
    if(back===undefined||!sameDocument(parseCredentialsDocument(back,'teloa-credentials'),doc))throw new StoreFault('document-corrupt')
    await wipe(handle,info.size);await this.removeLegacy(info.ino)
    this.ctx.logger.info('credentials: migrated references [%s] and records [%s] into the encrypted store',[...doc.refs.keys()].join(', '),[...doc.records.keys()].join(', '))
   }finally{await handle.close()}
  },lockWait)
 }
 /** 只删我们打开的那个 inode：名字若已被换成别的文件就留给下次启动处理。 */
 private async removeLegacy(ino:number):Promise<void>{
  const now=await lstat(this.paths.legacy).catch(()=>undefined)
  if(now?.ino===ino)await unlink(this.paths.legacy)
 }
 private async quarantineLegacy(handle:FileHandle|undefined):Promise<void>{
  // 硬链接：chmod 会改到另一路径共享的同一 inode，改名后另一路径也还留着明文——拒绝，不改外部文件的内容与权限。
  const info=handle?await handle.stat():await lstat(this.paths.legacy)
  if(info.isFile()&&info.nlink>1){this.ctx.logger.warn('credentials: a plaintext .credentials.yaml shares its contents with another path (hard link); it was left in place, not imported; review it in settings');return}
  const target=join(this.paths.dshHome,quarantinePrefix+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomBytes(3).toString('hex'))
  await handle?.chmod(0o600)
  await rename(this.paths.legacy,target)
  // 没有句柄的普通文件（无读写权限打不开）：改名后核对仍是同一 inode 再收紧为 0600，本人才能在设置页安全擦除它。
  if(!handle&&info.isFile()){const moved=await lstat(target);if(moved.isFile()&&moved.ino===info.ino&&moved.nlink===1)await chmod(target,0o600)}
  this.quarantined.push(target)
  this.ctx.logger.warn('credentials: a plaintext .credentials.yaml appeared after the encrypted store took over; it was not imported and was moved aside as %s',basename(target))
 }
}
