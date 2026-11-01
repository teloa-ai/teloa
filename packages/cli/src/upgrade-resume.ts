import {randomUUID,createHash} from 'node:crypto'
import {readFile,lstat,realpath,open,link,unlink} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import type {InstallState,Status} from './contracts.ts'
import {exactVersion} from './layout.ts'
import {readPrivateJson,writePrivateJson,writeInstall,privateDirectory} from './state.ts'
import {verifyRelease} from './releases.ts'
import {verifyBackup,assertMaintenanceDatabase} from './maintenance.ts'
import {prepareDatabase,databasePool} from './database.ts'
import {serviceStatus,startService,controlRecord,sleep,type ControlRecord} from './service.ts'
import {canUpgradeData} from './data-version.ts'

type Receipt={from:string;to:string;backup:string;restartId:string;status:'failed'|'complete'}
type ProcessProof={pid:number;startedAt:string;installId:string;port:number;nonceSha256:string}
type Binding={installId:string;home:string;device:number;inode:number;port:number;workspace:string;from:string;to:string;backup:string;backupManifestSha256:string;targetManifestSha256:string;originalReceipt:Receipt;originalReceiptSha256:string}
type Attempt={requestId:string;phase:'launching'|'unknown'|'failed'|'completed';process?:ProcessProof;error?:string}
type Journal={schema:'teloa.upgrade-resume/v1';binding:Binding;attempts:Attempt[]}
export type UpgradeResumePorts={status:(state:InstallState)=>Promise<Status>;control:(state:InstallState)=>Promise<ControlRecord|null>;prepare:(state:InstallState,backup:string,sourceData:number,targetData:number)=>Promise<void>;start:(state:InstallState,requestId:string)=>Promise<Status>}
const ports:UpgradeResumePorts={status:serviceStatus,control:controlRecord,prepare:async(state,backup,sourceData,targetData)=>{
 await prepareDatabase(state,sourceData===targetData?{}:{migrationBackup:backup})
 const pool=await databasePool(state)
 try{const marker=(await pool.query('select id,data_version from teloa_installation')).rows;if(marker.length!==1||marker[0].id!==state.id||marker[0].data_version!==targetData)throw refuse();await assertMaintenanceDatabase(pool)}finally{await pool.end()}
},start:(state,requestId)=>startService({...state,phase:'stopped'},{plannedRestartId:requestId})}
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x)
const sha=(x:Uint8Array|string)=>createHash('sha256').update(x).digest('hex')
const refuse=()=>Error('原升级、安装身份、完整备份或冻结目标不一致，保持维护；不会重新下载、备份或启动。')
const pending=()=>Error('原续办的启动结果仍待核对，不能再次启动。请保留原续办记录并核对原宿主。')
const pathOf=(state:InstallState)=>join(state.layout.instanceRoot,'upgrade-resume.json')
async function optional(path:string):Promise<unknown>{try{return await readPrivateJson(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error}}
async function durable(path:string,value:unknown){await writePrivateJson(path,value);for(const item of [path,dirname(path)]){const handle=await open(item,'r');try{await handle.sync()}finally{await handle.close()}}}
async function preserveFailure(state:InstallState,bytes:Uint8Array,digest:string){
 if(sha(bytes)!==digest)throw refuse()
 const root=join(state.layout.instanceRoot,'upgrade-failures');await privateDirectory(root)
 const path=join(root,digest+'.json')
 try{const handle=await open(path,'wx',0o600);try{await handle.writeFile(bytes);await handle.sync()}finally{await handle.close()}}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(sha(await readFile(path))!==digest)throw refuse()}
 const directory=await open(root,'r');try{await directory.sync()}finally{await directory.close()}
}
function readReceipt(value:unknown):Receipt{
 const r=value as Receipt
 if(!r||Object.keys(r).sort().join(',')!=='backup,from,restartId,status,to'||!exactVersion(r.from)||!exactVersion(r.to)||r.from===r.to||!uuid(r.restartId)||typeof r.backup!=='string'||!['failed','complete'].includes(r.status))throw refuse()
 return r
}
function readJournal(value:unknown):Journal|undefined{
 if(value===undefined)return
 const j=value as Journal
 if(!j||j.schema!=='teloa.upgrade-resume/v1'||!j.binding||!/^[a-f0-9]{64}$/.test(j.binding.originalReceiptSha256)||!Array.isArray(j.attempts)||!j.attempts.length||j.attempts.some(a=>!a||!uuid(a.requestId)||!['launching','unknown','failed','completed'].includes(a.phase))||new Set(j.attempts.map(a=>a.requestId)).size!==j.attempts.length||j.attempts.slice(0,-1).some(a=>a.phase!=='failed'))throw pending()
 for(const a of j.attempts)if(a.process&&(!Number.isSafeInteger(a.process.pid)||a.process.pid<1||!Number.isFinite(Date.parse(a.process.startedAt))||!uuid(a.process.installId)||!Number.isInteger(a.process.port)||a.process.port<1||a.process.port>65535||!/^[a-f0-9]{64}$/.test(a.process.nonceSha256)))throw pending()
 return j
}
const fingerprint=(value:ControlRecord):ProcessProof=>({pid:value.pid,startedAt:value.startedAt,installId:value.installId,port:value.port,nonceSha256:sha(value.nonce)})
/** 只整理已完成的旧轮次元数据；调用方须持本安装锁，不启动服务或数据库。 */
export async function archiveCompletedUpgradeResumeJournal(state:InstallState):Promise<{archived:boolean;path?:string;sha256?:string}>{
 const home=await lstat(state.layout.home),lockPath=join(state.layout.home,'install.lock'),lock=await readPrivateJson(lockPath) as {pid?:number;identity?:string}
 if(home.isSymbolicLink()||!home.isDirectory()||await realpath(state.layout.home)!==state.layout.home||state.layout.instanceRoot!==join(state.layout.home,'instances/default')||state.layout.releaseRoot!==join(state.layout.home,'releases',state.version)||lock.pid!==process.pid||!uuid(lock.identity))throw refuse()
 const lease=async()=>{if(!isDeepStrictEqual(await readPrivateJson(lockPath),lock)||!isDeepStrictEqual(await readPrivateJson(join(state.layout.instanceRoot,'state.json')),state))throw refuse();const h=await lstat(state.layout.home);if(h.isSymbolicLink()||h.dev!==home.dev||h.ino!==home.ino)throw refuse()}
 await lease()
 const journalPath=pathOf(state),journal=readJournal(await optional(journalPath));if(!journal)return {archived:false}
 const receiptPath=join(state.layout.instanceRoot,'upgrade.json'),receiptBytes=await readFile(receiptPath),receipt=readReceipt(await readPrivateJson(receiptPath)),binding=journal.binding
 // 同轮收口仍由原完整 binding 与世代检查处理，不能因 complete 回执更换原失败依据。
 if(binding.from===receipt.from&&binding.to===receipt.to&&binding.backup===receipt.backup)return {archived:false}
 const last=journal.attempts.at(-1)!,original=readReceipt(binding.originalReceipt)
 if(last.phase!=='completed'||!last.process||last.process.installId!==state.id)throw pending()
 const previous=exactVersion(binding.to)&&binding.to.split('.').map(Number),current=exactVersion(receipt.from)&&receipt.from.split('.').map(Number)
 const older=previous&&current&&previous.reduce((value,n,i)=>value||Math.sign(n-current[i]!),0)<=0
 if(state.phase!=='maintenance'||receipt.status!=='failed'||receipt.to!==state.version||!older||binding.installId!==state.id||binding.home!==state.layout.home||binding.device!==home.dev||binding.inode!==home.ino||binding.port!==state.port||binding.workspace!==state.layout.workspaceRoot||binding.from!==original.from||binding.to!==original.to||binding.backup!==original.backup||original.status!=='failed')throw refuse()
 for(const backup of [binding.backup,receipt.backup])if(await realpath(backup)!==backup||dirname(backup)!==state.layout.home+'.backups')throw refuse()
 const originalBytes=await readFile(join(state.layout.instanceRoot,'upgrade-failures',binding.originalReceiptSha256+'.json'))
 if(sha(originalBytes)!==binding.originalReceiptSha256||!isDeepStrictEqual(readReceipt(JSON.parse(originalBytes.toString())),original))throw refuse()
 const oldManifestPath=join(state.layout.home,'releases',binding.to,'release-manifest.json'),oldManifestBytes=await readFile(oldManifestPath),oldManifest=JSON.parse(oldManifestBytes.toString()),targetManifest=JSON.parse(await readFile(join(state.layout.releaseRoot,'release-manifest.json'),'utf8'))
 if(sha(oldManifestBytes)!==binding.targetManifestSha256||oldManifest.version!==binding.to||targetManifest.version!==state.version)throw refuse()
 for(const [backup,from,digest]of [[binding.backup,binding.from,binding.backupManifestSha256],[receipt.backup,receipt.from,undefined]] as const){
  const path=join(backup,'backup-manifest.json'),bytes=await readFile(path),manifest=await readPrivateJson(path),metadata=await readPrivateJson(join(backup,'installation.json')) as {workspaceRoot?:string;port?:number}
  const value=manifest as {schema?:string;installId?:string;version?:string;dataVersion?:number}
  if(value.schema!=='teloa.backup/v1'||value.installId!==state.id||value.version!==from||metadata.workspaceRoot!==state.layout.workspaceRoot||metadata.port!==state.port)throw refuse()
  if(digest!==undefined){
   // 已完成旧轮次由原备份与旧目标的固定哈希证明，不要求已退役的旧来源整包。
   if(sha(bytes)!==digest||typeof value.dataVersion!=='number'||!Number.isSafeInteger(value.dataVersion)||!canUpgradeData(oldManifest,value.dataVersion))throw refuse()
  }else{
   const source=await verifyRelease(join(state.layout.home,'releases',from))
   if(source.version!==from||value.dataVersion!==source.dataVersion)throw refuse()
  }
 }
 const bytes=await readFile(journalPath),info=await lstat(journalPath),digest=sha(bytes),root=join(state.layout.instanceRoot,'upgrade-resume-history'),archive=join(root,digest+'.json')
 if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||!isDeepStrictEqual(readJournal(JSON.parse(bytes.toString())),journal))throw refuse()
 await lease();if(!isDeepStrictEqual(await readFile(receiptPath),receiptBytes))throw refuse();await privateDirectory(root)
 // link 不覆盖已有历史，且原子保留原字节与权限；中断时两个名字都仍指向完整旧记录。
 try{await link(journalPath,archive)}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
 const archived=await lstat(archive);if(!archived.isFile()||archived.isSymbolicLink()||archived.mode!==info.mode||!isDeepStrictEqual(await readFile(archive),bytes))throw refuse()
 for(const path of [archive,root]){const handle=await open(path,'r');try{await handle.sync()}finally{await handle.close()}}
 await lease();const currentInfo=await lstat(journalPath);if(currentInfo.ino!==info.ino||currentInfo.dev!==info.dev||currentInfo.mode!==info.mode||!isDeepStrictEqual(await readFile(journalPath),bytes)||!isDeepStrictEqual(await readFile(receiptPath),receiptBytes))throw refuse()
 await unlink(journalPath);const directory=await open(state.layout.instanceRoot,'r');try{await directory.sync()}finally{await directory.close()}
 return {archived:true,path:archive,sha256:digest}
}
/** 普通 up/restart 不接管尚未收口的升级启动；停止仍沿既有明确停止入口。 */
export async function upgradeResumePending(state:InstallState):Promise<boolean>{const j=readJournal(await optional(pathOf(state)));return !!j&&['launching','unknown'].includes(j.attempts.at(-1)!.phase)}
/** 仅持原安装互斥锁的明确 --resume 调用；不下载、不 stage、不建备份、不恢复到新安装。 */
export async function resumeUpgradeInstall(state:InstallState,version:string,sourceRoot:string,p:UpgradeResumePorts=ports):Promise<InstallState>{
 if(!exactVersion(version)||version!==state.version||state.layout.releaseRoot!==join(state.layout.home,'releases',version)||state.layout.instanceRoot!==join(state.layout.home,'instances/default')||await realpath(state.layout.home)!==state.layout.home||await realpath(state.layout.releaseRoot)!==state.layout.releaseRoot)throw refuse()
 const home=await lstat(state.layout.home);if(home.isSymbolicLink())throw refuse()
 const lock=JSON.parse(await readFile(join(state.layout.home,'install.lock'),'utf8')) as {pid?:number;identity?:string};if(lock.pid!==process.pid||!uuid(lock.identity))throw refuse()
 const lease=async()=>{if(!isDeepStrictEqual(JSON.parse(await readFile(join(state.layout.home,'install.lock'),'utf8')),lock))throw refuse();const s=await readPrivateJson(join(state.layout.instanceRoot,'state.json')) as InstallState;if(s.schema!==state.schema||s.id!==state.id||s.version!==version||s.port!==state.port||!isDeepStrictEqual(s.layout,state.layout)||!isDeepStrictEqual(s.database,state.database))throw refuse();const h=await lstat(state.layout.home);if(h.dev!==home.dev||h.ino!==home.ino)throw refuse()}
 await lease()
 await archiveCompletedUpgradeResumeJournal(state)
 const receiptPath=join(state.layout.instanceRoot,'upgrade.json'),receiptBytes=await readFile(receiptPath),currentReceipt=readReceipt(JSON.parse(receiptBytes.toString())),journalPath=pathOf(state)
 let journal=readJournal(await optional(journalPath))
 const receipt=journal?readReceipt(journal.binding.originalReceipt):currentReceipt
 if(receipt.status!=='failed'||receipt.to!==version||await realpath(receipt.backup)!==receipt.backup||dirname(receipt.backup)!==state.layout.home+'.backups')throw refuse()
 const [target,source,old,backup]=await Promise.all([verifyRelease(state.layout.releaseRoot),verifyRelease(await realpath(sourceRoot)),verifyRelease(join(state.layout.home,'releases',receipt.from)),verifyBackup(receipt.backup)])
 const installation=await readPrivateJson(join(receipt.backup,'installation.json')) as {workspaceRoot?:string;port?:number}
 if(!isDeepStrictEqual(target,source)||target.version!==version||old.version!==receipt.from||!canUpgradeData(target,old.dataVersion)||backup.installId!==state.id||backup.version!==receipt.from||backup.dataVersion!==old.dataVersion||installation.workspaceRoot!==state.layout.workspaceRoot||installation.port!==state.port)throw refuse()
 const binding:Binding={installId:state.id,home:state.layout.home,device:home.dev,inode:home.ino,port:state.port,workspace:state.layout.workspaceRoot,from:receipt.from,to:version,backup:receipt.backup,backupManifestSha256:sha(await readFile(join(receipt.backup,'backup-manifest.json'))),targetManifestSha256:sha(await readFile(join(state.layout.releaseRoot,'release-manifest.json'))),originalReceipt:receipt,originalReceiptSha256:journal?journal.binding.originalReceiptSha256:sha(receiptBytes)}
 if(journal&&!isDeepStrictEqual(journal.binding,binding))throw refuse()
 if(!journal&&(state.phase!=='maintenance'||currentReceipt.status!=='failed'))throw refuse()
 if(journal){const original=await readFile(join(state.layout.instanceRoot,'upgrade-failures',binding.originalReceiptSha256+'.json'));if(sha(original)!==binding.originalReceiptSha256||!isDeepStrictEqual(readReceipt(JSON.parse(original.toString())),receipt))throw refuse()}
 const proof=async()=>{
  await lease()
  if(sha(await readFile(join(state.layout.releaseRoot,'release-manifest.json')))!==binding.targetManifestSha256||sha(await readFile(join(receipt.backup,'backup-manifest.json')))!==binding.backupManifestSha256)throw refuse()
  const bytes=await readFile(receiptPath),current=readReceipt(JSON.parse(bytes.toString())),last=journal?.attempts.at(-1),completed=last?{from:receipt.from,to:receipt.to,backup:receipt.backup,restartId:last.requestId,status:'complete'}:undefined
  if(!isDeepStrictEqual(current,receipt)&&!isDeepStrictEqual(current,completed))throw refuse()
  if(current.status==='failed'&&sha(bytes)!==binding.originalReceiptSha256)throw refuse()
 }
 const authenticated=async():Promise<{status:Status;process:ProcessProof|null}>=>{
  const first=await p.control(state),status=await p.status(state),second=await p.control(state)
  if(!isDeepStrictEqual(first,second))throw pending()
  if(status.version!==state.version||status.port!==state.port||first&&(first.installId!==state.id||!Number.isInteger(first.pid)||first.pid<1||!Number.isFinite(Date.parse(first.startedAt))||typeof first.nonce!=='string'||!first.nonce))throw pending()
  return {status,process:first?fingerprint(first):null}
 }
 const complete=async(attempt:Attempt):Promise<InstallState>=>{
  await proof();const live=await authenticated()
  if(live.status.app!=='ready'||live.status.database!=='ready'||!attempt.process||!isDeepStrictEqual(live.process,attempt.process))throw pending()
  const result:Receipt={from:receipt.from,to:receipt.to,backup:receipt.backup,restartId:attempt.requestId,status:'complete'}
  await durable(receiptPath,result);const ready={...state,phase:'ready' as const};await writeInstall(ready);attempt.phase='completed';await durable(journalPath,journal);return ready
 }
 const last=journal?.attempts.at(-1)
 if(last&&['launching','unknown','completed'].includes(last.phase))return complete(last)
 const initial=await authenticated()
 if(initial.status.app!=='stopped')throw pending()
 // 只有明确终态失败且认证确认原应用已停止，下一次本人显式命令才建立新 attempt。
 if(journal&&last?.phase!=='failed')throw pending()
 await preserveFailure(state,receiptBytes,binding.originalReceiptSha256)
 const attempt:Attempt={requestId:randomUUID(),phase:'launching'}
 journal=journal??{schema:'teloa.upgrade-resume/v1',binding,attempts:[]};journal.attempts.push(attempt);await durable(journalPath,journal)
 let started=false,finished=false,startFailed=false,startError:unknown,startup:Promise<void>|undefined
 try{
  await proof();await p.prepare(state,receipt.backup,old.dataVersion,target.dataVersion);await proof()
  if((await authenticated()).status.app!=='stopped')throw pending()
  startup=p.start(state,attempt.requestId).then(()=>{finished=true},error=>{startFailed=true;startError=error;finished=true});started=true
  // 绑定现有正式 supervisor 的真实、经私密控制通道认证的世代；不以墙钟或 PID 存在推断。
  while(!finished){
   // supervisor 发布新控制记录时可能恰好跨越一次只读探测；等同一正式启动结算，不另发启动。
   const live=await authenticated().catch(()=>undefined)
   if(live&&['starting','ready','failed'].includes(live.status.app)&&live.process&&!isDeepStrictEqual(live.process,initial.process)){
    if(attempt.process&&!isDeepStrictEqual(attempt.process,live.process))throw pending()
    if(!attempt.process){attempt.process=live.process;await durable(journalPath,journal)}
   }
   await Promise.race([startup,sleep(25)])
  }
  await startup
  if(startFailed)throw startError??Error('原启动明确失败，原恢复点已保留。')
  if(!attempt.process){const live=await authenticated();if(live.status.app!=='ready'||!live.process||isDeepStrictEqual(live.process,initial.process))throw pending();attempt.process=live.process;await durable(journalPath,journal)}
  return await complete(attempt)
 }catch(error){
  // 即使本地记账失败，也等待本次唯一 startService 自己完成/清理，不能让子进程结果失去归属。
  if(startup&&!finished)await startup
  const live=await authenticated().catch(()=>undefined)
  // startService 的明确失败会先回收它创建的进程；不明或仍存活的世代不能获第二次启动。
  const knownStopped=live?.status.app==='stopped'&&(!started||finished&&startFailed)
  attempt.phase=knownStopped?'failed':'unknown';attempt.error=knownStopped?'启动未完成，原失败与恢复点已保留。':'启动受理结果待核对，不能重复启动。'
  await durable(journalPath,journal);if(knownStopped)await writeInstall({...state,phase:'maintenance'})
  throw error
 }
}
