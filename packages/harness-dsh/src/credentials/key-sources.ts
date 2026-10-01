import {existsSync} from 'node:fs'
import {mkdir,open} from 'node:fs/promises'
import {dirname,isAbsolute,join} from 'node:path'

/**
 * 主密钥来源（规格 §3.2、§3.4）。钥匙串调用一律带超时，原生绑定加载失败按“没有钥匙串”处理。
 * 3 s 只用于首次初始化的可用性探测（超时就改走密钥文件）；读取已有密钥可能要等用户在系统弹窗里授权，放宽到 60 s。
 */
export const keyringService='Teloa Credentials'
export const keyringProbeTimeoutMs=3_000
export const keyringReadTimeoutMs=60_000
export type KeyringPort={
 get(account:string,signal:AbortSignal):Promise<string|undefined>
 set(account:string,value:string,signal:AbortSignal):Promise<void>
 delete(account:string,signal:AbortSignal):Promise<boolean>
}
export const keyringAccount=(installId:string,keyId:string):string=>`${installId}:${keyId}`
export type Env=Readonly<Record<string,string|undefined>>
/** 验收与测试开关只在浏览器验收宿主（`TELOA_BROWSER_ACCEPTANCE=1`）生效，正式环境设置了也忽略，不能借此降档。 */
const acceptance=(env:Env):boolean=>env.TELOA_BROWSER_ACCEPTANCE==='1'

/** `TELOA_CREDENTIALS_KEYRING=off` 是验收与测试开关：按“没有钥匙串”处理。 */
export async function loadNativeKeyring(env:Env=process.env):Promise<KeyringPort|undefined>{
 if(acceptance(env)&&env.TELOA_CREDENTIALS_KEYRING==='off')return undefined
 try{
  const {AsyncEntry}=await import('@napi-rs/keyring')
  return {
   get:(account,signal)=>new AsyncEntry(keyringService,account).getPassword(signal),
   set:(account,value,signal)=>new AsyncEntry(keyringService,account).setPassword(value,signal),
   delete:(account,signal)=>new AsyncEntry(keyringService,account).deletePassword(signal),
  }
 }catch{return undefined}
}
export async function withKeyringTimeout<T>(run:(signal:AbortSignal)=>Promise<T>,timeoutMs:number=keyringReadTimeoutMs):Promise<T|undefined>{
 try{return await run(AbortSignal.timeout(timeoutMs))}catch{return undefined}
}
export const encodeKey=(key:Uint8Array):string=>Buffer.from(key).toString('base64')
/** 接受 64 位十六进制（容器 prepareContainerSecret 的格式）或 44 位 base64。 */
export function decodeKey(text:string):Buffer|undefined{
 const value=text.trim()
 const bytes=/^[0-9a-f]{64}$/i.test(value)?Buffer.from(value,'hex'):/^[A-Za-z0-9+/]{43}=$/.test(value)?Buffer.from(value,'base64'):undefined
 return bytes?.length===32?bytes:undefined
}
/**
 * 读密钥文件：先打开再对同一句柄 stat，避免检查与读取之间被换掉。属主必须是当前用户；
 * `external`（显式指定的容器/systemd 密钥）另允许 root 属主与组可读（0440，组不可写），自动生成的密钥文件只接受 0600。
 */
export async function readKeyFile(path:string,options:{external?:boolean}={}):Promise<Buffer|undefined>{
 if(!isAbsolute(path))return undefined
 const handle=await open(path,'r')
 try{
  const info=await handle.stat(),uid=process.getuid?.()
  if(process.platform!=='win32'){
   if(!info.isFile())throw new Error('credentials key file is not a regular file')
   if(uid!==undefined&&info.uid!==uid&&!(options.external&&info.uid===0))throw new Error('credentials key file is owned by another user')
   // 外部文件放行组可读（0440），但组可写就能被换掉密钥：掩码 0o027 拒组写、拒其他人任何权限。
   if((info.mode&(options.external?0o027:0o077))!==0)throw new Error('credentials key file permissions are too open')
  }
  return decodeKey(await handle.readFile('utf8'))
 }finally{await handle.close()}
}
/** 生成密钥文件并落盘（文件与所在目录都 fsync），之后才会写 meta 与 `.enc`，断电不会留下指向空文件的 meta。 */
export async function createKeyFile(path:string,key:Uint8Array):Promise<void>{
 await mkdir(dirname(path),{recursive:true,mode:0o700})
 const handle=await open(path,'wx',0o600)
 try{await handle.writeFile(Buffer.from(key).toString('hex')+'\n');await handle.sync()}finally{await handle.close()}
 if(process.platform==='win32')return
 const dir=await open(dirname(path),'r')
 try{await dir.sync()}finally{await dir.close()}
}
export function explicitKeyFile(env:Env):string|undefined{
 if(env.TELOA_CREDENTIALS_KEY_FILE)return env.TELOA_CREDENTIALS_KEY_FILE
 if(env.CREDENTIALS_DIRECTORY)return join(env.CREDENTIALS_DIRECTORY,'teloa-credentials-key')
 return existsSync('/run/secrets/teloa-credentials-key')?'/run/secrets/teloa-credentials-key':undefined
}
/** `TELOA_CREDENTIALS_KEY_DIR`（绝对路径）是验收与测试开关；指到 DSH_HOME 内时首次初始化会按规格回退明文。 */
export function defaultKeyDir(env:Env,platform:NodeJS.Platform,home:string):string{
 if(acceptance(env)&&env.TELOA_CREDENTIALS_KEY_DIR&&isAbsolute(env.TELOA_CREDENTIALS_KEY_DIR))return env.TELOA_CREDENTIALS_KEY_DIR
 if(platform==='darwin')return join(home,'Library','Application Support','Teloa','credential-keys')
 const absolute=(value:string|undefined):string|undefined=>value&&isAbsolute(value)?value:undefined
 if(platform==='win32')return join(absolute(env.APPDATA)??join(home,'AppData','Roaming'),'Teloa','credential-keys')
 return join(absolute(env.XDG_CONFIG_HOME)??join(home,'.config'),'teloa','credential-keys')
}
