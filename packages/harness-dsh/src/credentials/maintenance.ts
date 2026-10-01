import {randomBytes} from 'node:crypto'
import {readdir,rename,rm,unlink,writeFile} from 'node:fs/promises'
import {homedir} from 'node:os'
import {dirname,join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {withFileLock,writeFileAtomic} from '@deepseek-ai/dsh-atomic-write'
import type {CredentialKey,CredentialRef} from '@deepseek-ai/dsh-credentials'
import {parseCredentialsDocument} from '@deepseek-ai/dsh-credentials-local'
import {createLaunchEnvironmentSnapshot} from '@deepseek-ai/dsh-launch-environment'
import {credentialSlotStore,mcpCredentialKey} from '../managed-mcp-credentials.ts'
import {keyIdOf,open,readHeader,seal,type Envelope} from './envelope.ts'
import {createKeyFile,decodeKey,defaultKeyDir,encodeKey,keyringAccount,loadNativeKeyring,withKeyringTimeout,type Env,type KeyringPort} from './key-sources.ts'
import TeloaCredentialProvider,{type ProviderDeps} from './provider.ts'
import {inside,isCredentialStoreLocked,loadKey,lockWait,readMeta,readOptional,storePaths,trackKeyringAccount,writeMeta,type StorePaths} from './store-state.ts'

/**
 * 宿主停止时的凭据维护（规格 §3.5）：回滚（export-plaintext）、重置（reset）、轮换（rotate）。输出只含结果与下一步，不含值。
 * 用户裁定不轮换（2026-09-26）：rotate 只作内部维护能力保留，不经 npm CLI 对外提供，也不写进帮助与文档。
 */
export type MaintenanceAction='export-plaintext'|'reset'|'rotate'
export type MaintenanceOptions={dshHome:string;keyring?:KeyringPort|undefined;env?:Env;keyDir?:string}
const stamp=()=>new Date().toISOString().replace(/[:.]/g,'-')
/** `clearStaleLock` 的接管互斥文件（`<文件>.lock.takeover-<inode>-<mtimeNs>-<级别>`，三级）：接管者崩溃在窗口内才会残留。 */
const takeoverGuard=/^\.credentials\.(?:meta\.json|enc)\.lock\.takeover-\d+-\d+-[0-2]$/

/** 宿主仍在用这份存储时拒绝维护：读提供方写的运行标记，pid 仍存活即拒绝；标记残留而进程已退出则放行。 */
export async function assertHostStopped(dshHome:string):Promise<void>{
 const text=await readOptional(join(dshHome,'.credentials.host.pid'))
 const pid=Number(text?.trim())
 if(!Number.isInteger(pid)||pid<=0||pid===process.pid)return
 try{process.kill(pid,0)}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return}
 throw new Error(`宿主仍在运行（pid ${pid}），请先停止宿主再执行凭据维护。`)
}

/**
 * 重置前的清理，只动本安装留下的东西：
 * - 钥匙串：按登记文件（写钥匙串前先登记，见 trackKeyringAccount）逐个精确删除本 installId 名下、且不是在用主密钥的账户，
 *   不枚举钥匙串。在用主密钥（meta 与信封头的 keyId）连同它的登记一起保留，改名留存的 `.bak-*` 以后仍能解开；别的 installId 的登记原样保留。
 * - DSH_HOME 下残留的接管互斥文件（全部级别）。
 */
async function cleanupForReset(paths:StorePaths,keyring:KeyringPort|undefined):Promise<number>{
 const meta=await readMeta(paths.meta).catch(()=>'invalid' as const),text=await readOptional(paths.encrypted).catch(()=>undefined)
 let header:Envelope|undefined
 try{header=text===undefined?undefined:readHeader(text)}catch{header=undefined}
 const known=meta!==undefined&&meta!=='invalid'?meta:undefined
 const installId=known?.installId??header?.fileId
 let removed=0
 const registered=(await readOptional(paths.keyringAccounts).catch(()=>undefined))?.split('\n').filter(Boolean)
 if(registered&&installId&&keyring){
  // 档位不明（meta 缺失或损坏）时也保留信封头的 keyId；file/明文档本安装名下没有在用的钥匙串账户。
  const live=new Set(known&&known.tier!=='keyring'?[]:[known?.keyId,header?.keyId].filter(Boolean))
  const port=keyring,kept:string[]=[]
  for(const account of new Set(registered)){
   const keyId=account.startsWith(installId+':')?account.slice(installId.length+1):''
   if(!/^[0-9a-f]{16}$/.test(keyId)){kept.push(account);continue}
   if(live.has(keyId)){kept.push(account);continue}
   if(await withKeyringTimeout(signal=>port.delete(keyringAccount(installId,keyId),signal))===undefined){kept.push(account);continue}
   removed++
  }
  if(kept.length)await writeFileAtomic(paths.keyringAccounts,kept.join('\n')+'\n',{mode:0o600,dirMode:0o700})
  else await rm(paths.keyringAccounts,{force:true})
 }
 for(const name of await readdir(paths.dshHome).catch(()=>[] as string[]))if(takeoverGuard.test(name))await rm(join(paths.dshHome,name),{force:true})
 return removed
}

export async function runCredentialMaintenance(action:string,options:MaintenanceOptions):Promise<string>{
 await assertHostStopped(options.dshHome)
 const paths=storePaths(options.dshHome),env=options.env??process.env
 const keyring='keyring' in options?options.keyring:await loadNativeKeyring(env)
 const keyDir=options.keyDir??defaultKeyDir(env,process.platform,homedir())
 const retire=async()=>{const suffix='.bak-'+stamp();for(const path of [paths.encrypted,paths.meta])await rename(path,path+suffix).catch(error=>{if(error.code!=='ENOENT')throw error});return suffix}
 if(action==='reset'){
  const cleaned=await cleanupForReset(paths,keyring),suffix=await retire()
  return `密钥存储已重置，原文件改名为 *${suffix} 留存${cleaned?`，并清理了 ${cleaned} 个本安装遗留的钥匙串条目`:''}。启动后请重新录入密钥。`
 }
 const meta=await readMeta(paths.meta),envelope=await readOptional(paths.encrypted)
 if(meta===undefined||meta==='invalid'||meta.tier==='plaintext'||envelope===undefined)return '没有可操作的加密凭据。'
 const header=readHeader(envelope),key=await loadKey(meta,header.keyId,{keyring})
 if(!key)throw new Error('取不到主密钥；请先恢复系统钥匙串或密钥文件，或改用 --action reset。')
 const plaintext=open(key,envelope).plaintext
 parseCredentialsDocument(plaintext,'teloa-credentials')
 if(action==='export-plaintext'){
  await writeFile(paths.legacy,plaintext,{flag:'wx',mode:0o600})
  const suffix=await retire()
  return `已写出 0600 明文 ${paths.legacy}，加密文件改名为 *${suffix} 留存。请安装上一版 Teloa 后启动。`
 }
 if(action!=='rotate')throw new Error('未知操作')
 const next=randomBytes(32),nextKeyId=keyIdOf(next)
 let keyFile=meta.keyFile
 if(meta.tier==='keyring'){
  if(!keyring)throw new Error('系统钥匙串不可用，无法轮换。')
  const port=keyring,account=keyringAccount(meta.installId,nextKeyId)
  if(!(await trackKeyringAccount(paths,account)))throw new Error('钥匙串账户登记写入失败，已中止。')
  const stored=await withKeyringTimeout(async signal=>{await port.set(account,encodeKey(next),signal);return port.get(account,signal)})
  if(stored===undefined||!decodeKey(stored)?.equals(next))throw new Error('新主密钥写入钥匙串后读回不一致，已中止。')
 }else{
  if(!meta.keyFile||!inside(meta.keyFile,keyDir))throw new Error('外部提供的密钥文件请由部署方替换：先 export-plaintext，替换密钥文件后重启完成迁移。')
  keyFile=join(dirname(meta.keyFile),`${meta.installId}.${nextKeyId}.key`)
  await createKeyFile(keyFile,next)
 }
 await withFileLock(paths.encrypted,async()=>writeFileAtomic(paths.encrypted,seal(next,meta.installId,plaintext),{mode:0o600,dirMode:0o700}),lockWait)
 if(!(await writeMeta(paths.meta,{...meta,keyId:nextKeyId,...(keyFile?{keyFile}:{})})))throw new Error('meta 写入后读回不一致；加密文件已用新密钥，旧密钥未删除。')
 if(meta.tier==='keyring'&&keyring){const port=keyring;await withKeyringTimeout(signal=>port.delete(keyringAccount(meta.installId,header.keyId),signal))}
 else if(meta.keyFile)await unlink(meta.keyFile).catch(()=>{})
 return '主密钥已轮换。'
}

/** 旧备份里的明文凭据：`dsh/.credentials.yaml` 的全文与 `runtime/mcp/credentials/<serverName>` 各文件全文。 */
export type LegacyCredentials={yaml?:string;mcp?:Readonly<Record<string,string>>}
export type LegacyImportResult={imported:string[];failed:string[]}
export const importBlockedMessage='密钥存储当前不可用（已锁定，或本机没有可用的系统钥匙串与密钥文件），旧备份里的明文密钥未导入。'
/** 存储不能加密写入：导入中止，`pending` 列出尚未导入的备份内路径（不含值）。 */
export class CredentialImportBlocked extends Error{
 readonly pending:string[]
 readonly credentialImportBlocked=true
 constructor(pending:string[]){super(importBlockedMessage);this.name='CredentialImportBlocked';this.pending=pending}
}

/**
 * 恢复旧备份时显式导入明文凭据（主控裁定 2026-09-26）：经提供方写入加密存储，同键覆盖；受管 MCP 走凭据槽 patch。
 * 明文只在内存里，磁盘不落明文、不放回旧路径。存储锁定或只能明文存放时抛 CredentialImportBlocked，不写任何凭据；
 * 格式无法识别的条目记入 `failed`，其余照常导入。
 */
export async function importLegacyCredentials(dshHome:string,input:LegacyCredentials,options:Omit<MaintenanceOptions,'dshHome'>={}):Promise<LegacyImportResult>{
 const yamlLabel='dsh/.credentials.yaml',mcp=Object.entries(input.mcp??{}).sort(([a],[b])=>a.localeCompare(b))
 const items=[...(input.yaml!==undefined?[yamlLabel]:[]),...mcp.map(([name])=>'runtime/mcp/credentials/'+name)]
 const imported:string[]=[],failed:string[]=[]
 if(!items.length)return {imported,failed}
 const deps:ProviderDeps={env:options.env??process.env,...('keyring' in options?{keyring:options.keyring}:{}),...(options.keyDir?{keyDir:options.keyDir}:{})}
 const ctx=new Context()
 // 进程层留空：恢复命令所在终端的环境变量不能遮住写入（提供方对启动环境已给出的 REF 拒写）。
 ctx.provide('launchEnvironment',createLaunchEnvironmentSnapshot([{source:'process',values:{}}]))
 class Importer extends TeloaCredentialProvider{constructor(c:Context,config:{dshHome?:string}){super(c,config,deps)}}
 const fiber=ctx.plugin(Importer,{dshHome})
 await fiber
 try{
  const provider=ctx.get('credentials') as TeloaCredentialProvider,status=provider.status()
  if(status.fault!==null||status.tier===null||status.tier==='plaintext')throw new CredentialImportBlocked(items)
  try{
   if(input.yaml!==undefined){
    let doc:ReturnType<typeof parseCredentialsDocument>|undefined
    try{doc=parseCredentialsDocument(input.yaml,'teloa-credentials')}catch{doc=undefined}
    if(!doc)failed.push(yamlLabel)
    else{
     for(const [ref,value] of doc.refs)if(value.length)await provider.set(ref as CredentialRef,value)
     for(const [key,record] of doc.records)await provider.modifyRecord(key as CredentialKey,async()=>record)
     imported.push(yamlLabel)
    }
   }
   const slots=credentialSlotStore(provider)
   for(const [name,text] of mcp){
    const label='runtime/mcp/credentials/'+name
    let legacy:Record<string,string>
    try{
     mcpCredentialKey(name)
     const parsed=JSON.parse(text) as unknown
     if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('format')
     legacy=Object.fromEntries(Object.entries(parsed).filter((entry):entry is [string,string]=>typeof entry[1]==='string'))
    }catch{failed.push(label);continue}
    if(Object.keys(legacy).length)await slots.patch(name,legacy)
    imported.push(label)
   }
  }catch(error){
   if(isCredentialStoreLocked(error))throw new CredentialImportBlocked(items.filter(item=>!imported.includes(item)&&!failed.includes(item)))
   throw error
  }
  return {imported,failed}
 }finally{await fiber.dispose()}
}
