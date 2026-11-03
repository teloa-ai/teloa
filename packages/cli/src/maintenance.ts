import {createHash,randomUUID} from 'node:crypto'
import {access,copyFile,lstat,readFile,readlink,readdir,realpath,mkdir,rename,chmod,open,mkdtemp,rm,writeFile,symlink} from 'node:fs/promises'
import {constants} from 'node:fs'
import {join,dirname,basename,relative,isAbsolute,resolve,sep} from 'node:path'
import {tmpdir} from 'node:os'
import {spawn} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {isDeepStrictEqual} from 'node:util'
import type {BackupManifest,SubmissionMaintenanceBackup,DatabaseChoice,InstallState,Status,ReleaseManifest} from './contracts.ts'
import {canonical,exactVersion,within,resolveLayout,programRoot} from './layout.ts'
import {readPrivateJson,writePrivateJson,writeInstall,withInstallLock} from './state.ts'
import {verifyRelease,stageRelease} from './releases.ts'
import {serviceStatus,portAvailable} from './service.ts'
import {prepareDatabase,stopDatabase,databasePool,databaseConfig,ownContainer,databaseName,localConnection} from './database.ts'
import {command} from './process.ts'
import {maintenanceHelper} from './maintenance-process.ts'
import {canUseData,supportedDataVersion} from './data-version.ts'
import {authorizeOrdinaryUpgradeBackup} from './upgrade-intent.ts'
import {inspectPackageBinLink,type PackageBinLink} from './maintenance-package-bin.ts'

const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex')
const safePath=(path:unknown):path is string=>typeof path==='string'&&path.length>0&&!isAbsolute(path)&&!path.includes('\\')&&!path.includes('\0')&&path.split('/').every(part=>part&&part!=='.'&&part!=='..')
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
async function listFiles(root:string):Promise<string[]>{
 const result:string[]=[]
 async function walk(directory:string){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const path=join(directory,entry.name)
   if(entry.isSymbolicLink()){
    if(!await inspectPackageBinLink(join(root,'dsh'),path))throw Error('备份不接受软链接。')
    result.push(relative(root,path).split(sep).join('/'))
   }else if(entry.isDirectory())await walk(path)
   else if(entry.isFile())result.push(relative(root,path).split('\\').join('/'))
   else throw Error('备份包含不支持的文件类型。')
  }
 }
 const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink())throw Error('备份目录不能是链接。')
 await walk(root);return result.sort()
}
/** 命令链接的摘要绑定链接文本；目标正文与所属包清单另有完整文件摘要。 */
export async function backupFileRecords(root:string):Promise<BackupManifest['files']>{
 return Promise.all((await listFiles(root)).map(async path=>{
  const absolute=join(root,path)
  if((await lstat(absolute)).isSymbolicLink()){const target=await readlink(absolute);return{path,sha256:digest(Buffer.from(target)),symlink:target}}
  return{path,sha256:digest(await readFile(absolute))}
 }))
}
export async function verifyBackup(root:string):Promise<BackupManifest>{
 return await verifyArchive(root,false) as BackupManifest
}
export async function verifySubmissionMaintenanceBackup(root:string,expected:{installId:string;home:string;bindingSha256:string}):Promise<SubmissionMaintenanceBackup>{
 const value=await verifyArchive(root,true) as SubmissionMaintenanceBackup
 if(value.installId!==expected.installId||value.home!==expected.home||value.bindingSha256!==expected.bindingSha256)throw Error('维护备份只能用于原安装、原目录和本次停发证明，不能恢复到新安装。')
 const receipt=await readPrivateJson(join(root,'maintenance-receipt.json')) as {bindingSha256?:string}
 if(receipt.bindingSha256!==value.bindingSha256)throw Error('维护备份的停发证据不一致。')
 return value
}
async function verifyArchive(root:string,maintenance:boolean):Promise<BackupManifest|SubmissionMaintenanceBackup>{
 const files=await listFiles(root)
 const value=await readPrivateJson(join(root,'backup-manifest.json')) as SubmissionMaintenanceBackup|BackupManifest
 if(!maintenance&&value?.schema==='teloa.maintenance-backup/v1')throw Error('这是同安装维护备份，不能通过普通restore恢复，也不提供自动回滚。')
 if(!value||Object.keys(value).sort().join(',')!==(maintenance?'bindingSha256,createdAt,dataVersion,externalWorkspaceIncluded,files,home,id,installId,schema,version':'createdAt,dataVersion,externalWorkspaceIncluded,files,id,installId,schema,version')||value.schema!==(maintenance?'teloa.maintenance-backup/v1':'teloa.backup/v1')||!uuid(value.id)||!uuid(value.installId)||!exactVersion(value.version)||!Number.isFinite(Date.parse(value.createdAt))||value.externalWorkspaceIncluded!==false||!Array.isArray(value.files))throw Error('备份清单无效。')
 if(maintenance&&(!isAbsolute((value as SubmissionMaintenanceBackup).home)||!/^[a-f0-9]{64}$/.test((value as SubmissionMaintenanceBackup).bindingSha256)))throw Error('维护备份归属无效。')
 if(!supportedDataVersion(value.dataVersion))throw Error('备份数据版本尚不支持。')
 const names=new Set<string>()
 for(const row of value.files){
  if(!row||Object.keys(row).sort().join(',')!==(row.symlink===undefined?'path,sha256':'path,sha256,symlink')||row.symlink!==undefined&&typeof row.symlink!=='string'||!safePath(row.path)||names.has(row.path)||!/^[a-f0-9]{64}$/.test(row.sha256)||!(row.path==='database.dump'||row.path==='installation.json'||maintenance&&row.path==='maintenance-receipt.json'||row.path.startsWith('dsh/')||row.path.startsWith('runtime/')))throw Error('备份清单路径无效。')
  names.add(row.path)
 }
 if(!names.has('database.dump')||!names.has('installation.json')||JSON.stringify([...names].sort())!==JSON.stringify(files.filter(path=>path!=='backup-manifest.json')))throw Error('备份实际文件与清单不一致。')
 if(maintenance&&!names.has('maintenance-receipt.json'))throw Error('维护备份缺少停发证明。')
 for(const row of value.files){
  const path=join(root,row.path),info=await lstat(path)
  if(info.isSymbolicLink()){
   const link=await inspectPackageBinLink(join(root,'dsh'),path)
   if(!link||link.target!==row.symlink||digest(Buffer.from(link.target))!==row.sha256||!names.has('dsh/'+link.targetPath)||!names.has('dsh/'+link.packagePath))throw Error('备份命令链接或目标清单不一致。')
  }else if(row.symlink!==undefined||digest(await readFile(path))!==row.sha256)throw Error('备份文件摘要不一致。')
 }
 return value
}
export function assertMaintenanceStopped(status:Pick<Status,'app'|'activeWork'>,phase:InstallState['phase']):void{
 if(status.app!=='stopped'||phase!=='stopped')throw Error('请先让任务收尾并运行 teloa stop；维护要求本安装明确停止。')
}
export async function assertMaintenanceDatabase(db:{query:(sql:string)=>Promise<{rows:any[]}>}):Promise<void>{
 await assertMaintenanceWork(db)
}
/** 仅停发证明覆盖的单一原Run可进入专用备份；所有外部未收口边界保持。 */
export async function assertSubmissionMaintenanceDatabase(db:{query:(sql:string,args?:unknown[])=>Promise<{rows:any[]}>},run:{owner:string;runId:string}):Promise<void>{
 if(typeof run.owner!=='string'||!run.owner||!uuid(run.runId))throw Error('维护运行身份无效。')
 await assertMaintenanceWork(db,run)
 for(const sql of [
  "select 1 from teloa_task_run_subagents where state in ('reserved','started') limit 1",
  "select 1 from teloa_task_run_flows where owner_id=$1 and run_id=$2 limit 1",
  "select 1 from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and (kind<>'job' or payload->>'record' is distinct from 'owner') limit 1",
 ])if((await db.query(sql,sql.includes('$1')?[run.owner,run.runId]:undefined)).rows.length)throw Error('仍有子任务或后台工作未核清，不能进入提交维护。')
}
/** 唯一具名 prepared 例外；原调用仍只支持 submitting，不放宽普通维护。 */
export async function assertPreparedMaintenanceDatabase(db:{query:(sql:string,args?:unknown[])=>Promise<{rows:any[]}>},run:{owner:string;runId:string}):Promise<void>{
 if(!run.owner||!uuid(run.runId))throw Error('维护运行身份无效。')
 await assertMaintenanceWork(db,{...run,state:'prepared'})
 for(const sql of [
  "select 1 from teloa_task_run_subagents where state in ('reserved','started') limit 1",
  "select 1 from teloa_task_run_flows where state not in ('completed','compensated','failed') limit 1",
  "select 1 from teloa_task_run_submissions where owner_id=$1 and run_id=$2 limit 1",
  "select 1 from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and (kind<>'job' or payload->>'record' is distinct from 'owner') limit 1",
 ])if((await db.query(sql,sql.includes('$1')?[run.owner,run.runId]:undefined)).rows.length)throw Error('仍有未结清的提交、子级或后台工作，不能保全准备执行。')
}
async function assertMaintenanceWork(db:{query:(sql:string,args?:unknown[])=>Promise<{rows:any[]}>},allowed?:{owner:string;runId:string;state?:'prepared'}):Promise<void>{
 const pending=await db.query(`select
  (select count(*)::integer from teloa_task_runs where state in ('prepared','submitting','accepted','active') and not(state='${allowed?.state==='prepared'?'prepared':'submitting'}' and owner_id=coalesce($1,'') and id=coalesce($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid))) as runs,
  (select count(*)::integer from teloa_plan_occurrences o
   join teloa_plan_task_links l on l.claim_id=o.id join teloa_tasks t on t.id=l.task_id
   left join teloa_task_runs r on r.owner_id=o.owner_id and r.request_id=o.id
   where r.request_id is null and t.state not in ('completed','cancelled') and (
    t.state not in ('ready','paused','blocked','waiting')
    or t.owner_id is distinct from o.owner_id or l.owner_id is distinct from o.owner_id
    or l.task_request_id is distinct from o.task_request_id or t.request_id is distinct from o.task_request_id
   )) as plans,
  (select count(*)::integer from teloa_security_action_executions where state in ('dispatching','accepted','effect_unknown')) as effects,
  (select count(*)::integer from teloa_plugin_installations where state in ('preparing','unknown')) as plugins`,[allowed?.owner??null,allowed?.runId??null])
 const row=pending.rows[0]
 if(!row||Object.values(row).some(value=>!Number.isSafeInteger(value)||Number(value)<0))throw Error('数据库维护状态不可确认。')
 if(row.runs)throw Error('数据库仍有未收尾的运行；请回到原安装处理后再备份。')
 // 已停止宿主中，来源链完整且尚未派发的任务只是持久待办；备份保留原领取与任务，不执行或重建它们。
 // 在跑/身份不一致的领取仍拒绝；所有未收口 Run、外部效果及扩展安装继续由独立检查拦截。
 if(row.plans)throw Error('计划待派发项仍在运行或来源身份不一致；请回到原安装核对。')
 if(row.effects)throw Error('仍有未确认结果的外部执行；请在原安装完成核对。')
 if(row.plugins)throw Error('仍有未完成的扩展安装；请先在原安装处理。')
}
/** 仅用于已核验原安装标记的普通备份；未知 schema 保留原拒绝，不把缺表视为空库。 */
async function explainIncompleteBackupDatabase(db:{query:(sql:string)=>Promise<{rows:any[]}>},error:unknown):Promise<never>{
 if(!(error instanceof Error&&'code' in error&&error.code==='42P01'))throw error
 let markerOnly=false
 try{
  const relations=await db.query("select n.nspname as schema,c.relname as name,c.relkind as kind from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_toast' and c.relkind in ('r','p','v','m','f','S') order by n.nspname,c.relname")
  if(isDeepStrictEqual(relations.rows,[{schema:'public',name:'teloa_installation',kind:'r'}])){
   const columns=await db.query("select a.attname as name,format_type(a.atttypid,a.atttypmod) as type from pg_attribute a where a.attrelid='public.teloa_installation'::regclass and a.attnum>0 and not a.attisdropped order by a.attnum")
   markerOnly=isDeepStrictEqual(columns.rows,[{name:'id',type:'uuid'},{name:'data_version',type:'integer'}])
  }
 }catch{/* 元数据不可确认时保留原缺表错误，不推断无业务数据。 */}
 if(markerOnly)throw Error('数据库尚未初始化完成，无法创建可恢复备份；原目录与数据库已保留。不要补表或重新初始化原库。请核对原发行的初始化错误；确认首次安装从未成功且没有工作数据后，使用已修复发行包，在新的安装目录与新的空专库独立完成首次安装。这不是原安装迁移或备份恢复。',{cause:error})
 throw error
}
async function assertNoRuns(state:InstallState,dataVersion:number):Promise<void>{
 const pool=await databasePool(state)
 try{
  const marker=await pool.query('select id,data_version from teloa_installation')
  if(marker.rows.length!==1||marker.rows[0].id!==state.id||marker.rows[0].data_version!==dataVersion)throw Error('数据库身份或版本不符。')
  try{await assertMaintenanceDatabase(pool)}catch(error){await explainIncompleteBackupDatabase(pool,error)}
 }finally{await pool.end()}
}
/** `$DSH_HOME/.env` 可能含明文密钥，与凭据一样不随备份；备份与恢复输出提示本人自行保存。 */
export const dshEnvBackupNotice='DSH 目录下的 .env 可能含明文密钥，未包含在备份中；如需保留请自行另存到受保护的位置。'
export const dshEnvRestoreNotice=(dshHome:string)=>'DSH 目录下的 .env 不随备份恢复；如原安装有需要的设置，请自行放回 '+join(dshHome,'.env')+'（仅本人可读，0600）。'
/** 调用方须核验旧安装归属及生成来源；默认仍拒绝所有缺失链接。 */
export interface BackupCopyOptions{
 allowMissingGeneratedLink?:(input:Readonly<{source:string,path:string,target:string}>)=>boolean|Promise<boolean>
 /** 仅由已核验发行的受管配方生成；验证失败或目录有额外内容时仍按普通数据备份。 */
 managedRuntimePackages?:ReadonlyMap<string,()=>Promise<boolean>>
}
/** 复用来源发行的固定锁和只读全树校验，不执行安装，不按目录名字直接省略。 */
export async function managedRuntimePackageChecks(root:string,releaseRoot:string):Promise<ReadonlyMap<string,()=>Promise<boolean>>>{
 const checks=new Map<string,()=>Promise<boolean>>()
 const path=join(releaseRoot,'packages/harness-dsh/lib/managed-package-install.js')
 const info=await lstat(path).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error})
 // 早期发行没有受管安装器时沿默认严格备份，不凭名字省略任何数据。
 if(!info)return checks
 if(!info.isFile())throw Error('受管运行依赖校验器不是发行文件。')
 const managed=await import(pathToFileURL(path).href)
 for(const recipe of managed.managedPackageAllowlist){
  const path=managed.managedPackageDir(root,recipe)
  if(dirname(path)!==resolve(root,'packages'))throw Error('受管运行依赖路径不正确。')
  checks.set(relative(root,path).split(sep).join('/'),async()=>{
   try{
    const manifest=JSON.parse(await readFile(join(path,'package.json'),'utf8')),lock=JSON.parse(await readFile(join(path,'package-lock.json'),'utf8'))
    const expected={name:'teloa-managed-install',version:'1.0.0',private:true,dependencies:{[recipe.package]:recipe.version}}
    return isDeepStrictEqual(manifest,expected)&&isDeepStrictEqual(lock,managed.managedPackageLock(recipe))&&await managed.managedPackageInstalled(root,recipe)
   }catch{return false}
  })
 }
 return checks
}
export const isGeneratedBackupDirectory=(path:string)=>/^profiles\/(?:[^/]+\/(?:\.dsh-module-fallback\/)?)?node_modules$/.test(path)
export const isBackupCopyPath=(path:string,isFile=false)=>!/^\.credentials\./.test(path)&&!/^mcp\/credentials(?:\/|$)/.test(path)&&path!=='.env'&&!(isFile&&path.split('/').at(-1)==='session.lock')
/** 旧官方原生组合链接是可重建依赖；本人扩展与额外包内容仍必须保留或明确拒绝。 */
export async function isVerifiedHistoricalNativeDependency(source:string,path:string,releaseRoot:string,verified=new Map<string,Promise<ReleaseManifest>>()):Promise<boolean>{
 const name=/^profiles\/(?:[^/]+\/(?:\.dsh-module-fallback\/)?)?node_modules\/@teloa\/(native-browser|native-computer)$/.exec(relative(source,path).split(sep).join('/'))?.[1]
 if(!name)return false
 const before=await lstat(path)
 if(!before.isSymbolicLink())return false
 const linkTarget=await readlink(path),resolved=await realpath(path)
 const current=await realpath(releaseRoot),releases=dirname(current),home=dirname(releases)
 if(basename(releases)!=='releases'||!exactVersion(basename(current))||!/^instances\/[^/]+\/dsh$/.test(relative(home,await realpath(source)).split(sep).join('/')))return false
 const old=dirname(dirname(resolved)),version=basename(old)
 if(!exactVersion(version)||old===current||old!==join(releases,version)||resolved!==join(old,'packages',name))return false
 for(const directory of [old,join(old,'packages'),resolved]){
  const info=await lstat(directory)
  if(!info.isDirectory()||info.isSymbolicLink())return false
 }
 const modules=dirname(dirname(path)),parent=dirname(modules),profile=basename(parent)==='.dsh-module-fallback'?dirname(parent):parent
 const profileFile=await lstat(join(profile,'package.json'))
 if(!profileFile.isFile()||profileFile.isSymbolicLink())return false
 const profileManifest=JSON.parse(await readFile(join(profile,'package.json'),'utf8'))
 if(profileManifest.dependencies?.['@teloa/'+name]!=='link:'+join(releaseRoot,'packages',name))return false
 const release=async(root:string)=>{
  let pending=verified.get(root)
  if(!pending){pending=verifyRelease(root);verified.set(root,pending)}
  const manifest=await pending
  if(manifest.version!==basename(root))throw Error('历史生成依赖的发行身份不一致。')
  return manifest
 }
 for(const root of [current,old]){
  for(const directory of [root,join(root,'packages'),join(root,'packages',name)]){
   const info=await lstat(directory)
   if(!info.isDirectory()||info.isSymbolicLink())return false
  }
  const manifest=await release(root),prefix='packages/'+name+'/',expected=manifest.files.filter(row=>row.path.startsWith(prefix)),actual:string[]=[]
  async function visit(directory:string):Promise<void>{
   for(const item of await readdir(directory,{withFileTypes:true})){
    const file=join(directory,item.name)
    if(item.isDirectory()){
     if(!expected.some(row=>row.path.startsWith(relative(root,file).split(sep).join('/')+'/')))throw Error('历史生成依赖含未登记目录，不能省略。')
     await visit(file)
    }
    else if(item.isFile())actual.push(relative(root,file).split(sep).join('/'))
    else throw Error('历史生成依赖包含不能省略的链接或特殊文件。')
   }
  }
  await visit(join(root,'packages',name))
  if(!expected.some(row=>row.path===prefix+'package.json')||!isDeepStrictEqual(actual.sort(),expected.map(row=>row.path).sort()))throw Error('历史生成依赖含未登记内容，不能省略。')
  for(const row of expected)if(digest(await readFile(join(root,row.path)))!==row.sha256)throw Error('历史生成依赖摘要不一致。')
  if(JSON.parse(await readFile(join(root,prefix,'package.json'),'utf8')).name!=='@teloa/'+name)throw Error('历史生成依赖包身份不一致。')
 }
 const after=await lstat(path)
 if(!after.isSymbolicLink()||before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||linkTarget!==await readlink(path)||resolved!==await realpath(path))throw Error('生成链接在备份核验期间发生变化，备份已停止。')
 return true
}
export async function copyBackupData(source:string,target:string,releaseRoot:string,skipGenerated=false,options:BackupCopyOptions={}):Promise<void>{
 await mkdir(target,{recursive:true,mode:0o700})
 let cloneHelper:string|undefined
 const verifiedGeneratedReleases=new Map<string,Promise<ReleaseManifest>>()
 const commandLinks:PackageBinLink[]=[]
 async function visit(from:string,to:string,generated:boolean){
  for(const entry of await readdir(from,{withFileTypes:true})){
   const src=join(from,entry.name),dst=join(to,entry.name)
   const skip=generated||skipGenerated&&isGeneratedBackupDirectory(relative(source,src))
   // 凭据不随备份（规格 §3.5）：根目录下 `.credentials.*` 一律跳过——凭据文件、改名留存与隔离的明文副本、
   // 原子写崩溃残留的明文 `.credentials.yaml.<hex>.tmp`，以及本就不该复制的锁与接管互斥文件；受管 MCP 旧凭据目录同样跳过。
   // 根目录下的 `.env`（DSH 的用户环境层，可能含明文密钥）同样跳过，备份与恢复输出提示本人自行保存。
   const rel=relative(source,src).split(sep).join('/')
   if(!isBackupCopyPath(rel))continue
   if(entry.isSymbolicLink()){
    // 当前发行链接按原规则重建；历史原生组合仅在同安装、声明与完整发行/包核验后省略。
    if(skip){
     let resolved:string|undefined
     try{resolved=await realpath(src)}catch(error){
      if((error as NodeJS.ErrnoException).code!=='ENOENT'||!options.allowMissingGeneratedLink)throw error
      const before=await lstat(src),linkTarget=await readlink(src)
      if(await options.allowMissingGeneratedLink(Object.freeze({source,path:src,target:linkTarget}))===true){
       const after=await lstat(src)
       if(!after.isSymbolicLink()||before.dev!==after.dev||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||linkTarget!==await readlink(src))throw Error('生成链接在备份核验期间发生变化，备份已停止。')
       // 缺失目标若在核验期间重新出现，继续按原发行范围核验。
       try{resolved=await realpath(src)}catch(next){if((next as NodeJS.ErrnoException).code==='ENOENT')continue;throw next}
      }
     }
     if(resolved&&within(await realpath(releaseRoot),resolved))continue
     if(resolved&&await isVerifiedHistoricalNativeDependency(source,src,releaseRoot,verifiedGeneratedReleases))continue
    }
    const commandLink=await inspectPackageBinLink(source,src)
    if(commandLink){commandLinks.push(commandLink);continue}
    throw Error('数据含不能安全备份的外链；请移除外部链接或另行保存扩展后重试。')
   }
   if(entry.isDirectory()){
    const check=options.managedRuntimePackages?.get(rel)
    if(check&&/^packages\/[^/]+$/.test(rel)){
     const entries=await readdir(src,{withFileTypes:true}),expected=['.teloa-install.json','node_modules','package-lock.json','package.json']
     if(entries.length===expected.length&&entries.every(item=>expected.includes(item.name)&&(item.name==='node_modules'?item.isDirectory():item.isFile()))&&await check())continue
    }
    // 生成链接可由当前发行重建；已安装到该目录的实体扩展必须进入备份。
    await mkdir(dst,{mode:0o700})
    await visit(src,dst,skip)
   }else if(entry.isFile()){
    // 操作系统锁及派生缓存重建，避免复制过期 PID 或源机器锁身份。
    if(!isBackupCopyPath(rel,true))continue
    const info=await lstat(src)
    if(process.platform==='darwin'&&info.size>=16*1024*1024){
     // 新CLI的可信helper可为旧安装创建保护点；不要求旧发行具备新clone操作。
     const [sourceRoot,targetRoot]=await Promise.all([lstat(source),lstat(target)])
     if(!sourceRoot.isDirectory()||sourceRoot.isSymbolicLink()||!targetRoot.isDirectory()||targetRoot.isSymbolicLink())throw Error('大文件备份根目录不能是符号链接。')
     cloneHelper??=await maintenanceHelper(programRoot)
     const copied=await command(cloneHelper,['clone-backup',source,target,rel],{timeout:30_000})
     if(copied.code!==0)throw Error('大文件的安全共享块备份失败；未回退普通复制，请保留原数据并检查目标卷是否支持APFS克隆。')
     const proof=JSON.parse(copied.stdout)
     if(proof.schema!=='teloa.backup-clone/v1'||proof.method!=='fclonefileat'||proof.bytes!==info.size)throw Error('大文件备份克隆回执无效，备份已停止。')
    }else{await copyFile(src,dst);await chmod(dst,0o600)}
    // 备份及恢复都保留本地扩展的本人执行位，不开放组/其他用户读取，也不带回特殊权限位。
    if(/^profiles\/(?:[^/]+\/(?:\.dsh-module-fallback\/)?)?node_modules\//.test(rel))await chmod(dst,0o600|(info.mode&0o100))
   }else throw Error('数据含不支持的文件类型，备份已停止。')
  }
 }
 await visit(source,target,false)
 const targetRoot=await realpath(target)
 // 先捕获全部正文，再重建链接；任何缺失、外链或变化都不能成为归档中的有效命令。
 for(const link of commandLinks){
  const current=await inspectPackageBinLink(source,join(source,link.path))
  if(!isDeepStrictEqual(current,link))throw Error('扩展命令链接在备份期间变化，备份已停止。')
  for(const [path,expected]of [[link.targetPath,link.targetSha256],[link.packagePath,link.packageSha256]] as const){
   const copied=join(targetRoot,path),info=await lstat(copied)
   if(!info.isFile()||info.isSymbolicLink()||await realpath(copied)!==copied||digest(await readFile(copied))!==expected)throw Error('扩展命令目标未完整捕获，备份已停止。')
  }
  await symlink(link.target,join(target,link.path))
  if(!await inspectPackageBinLink(target,join(target,link.path)))throw Error('备份命令链接核验失败。')
 }
}
async function transferDatabase(state:InstallState,path:string,action:'dump'|'restore'):Promise<void>{
 const executable=action==='dump'?'pg_dump':'pg_restore'
 let tool=executable,args:string[],environment={...process.env},temporary:string|undefined
 try{
  if(state.database.kind==='docker'){
   await ownContainer(state);tool='docker';args=['exec',...(action==='restore'?['-i']:[]),databaseName(state),executable,'--username=teloa','--dbname=teloa']
  }else{
   const config=await readPrivateJson(databaseConfig(state)) as {connectionString:string},url=localConnection(config.connectionString)
   const pool=await databasePool(state);let major:number
   try{major=Math.floor(Number((await pool.query('show server_version_num')).rows[0].server_version_num)/10000)}finally{await pool.end()}
   for(const name of ['pg_dump','pg_restore']){
    let result
    try{result=await command(name,['--version'])}catch{throw Error('已有数据库备份需要 PATH 中可用、与服务端同主版本的 pg_dump 和 pg_restore。')}
    if(result.code!==0||Number(/PostgreSQL\)\s+(\d+)/.exec(result.stdout)?.[1])!==major)throw Error('pg_dump / pg_restore 与 PostgreSQL 主版本不一致。')
   }
   temporary=await mkdtemp(join(tmpdir(),'teloa-pgpass-'));await chmod(temporary,0o700)
   const escape=(text:string)=>text.replace(/\\/g,'\\\\').replace(/:/g,'\\:')
   const username=decodeURIComponent(url.username),password=decodeURIComponent(url.password)
   if(/[\r\n]/.test(username+password))throw Error('数据库凭据不能用于当前备份工具。')
   const pgpass=join(temporary,'pgpass')
   await writeFile(pgpass,[url.hostname,url.port||'5432','teloa',username,password].map(escape).join(':')+'\n',{mode:0o600})
   // 不从调用终端继承可能改变连接目标的 PG* 参数。
   environment=Object.fromEntries(Object.entries(environment).filter(([key])=>!key.startsWith('PG')))
   environment.PGPASSFILE=pgpass
   args=['--host='+url.hostname,'--port='+(url.port||'5432'),'--username='+username,'--dbname=teloa','--no-password']
  }
  args.push('--no-owner','--no-acl',...(action==='dump'?['--format=custom','--exclude-table=public.teloa_installation']:['--single-transaction','--exit-on-error']))
  const handle=await open(path,action==='dump'?'wx':'r',0o600)
  try{
   await new Promise<void>((done,fail)=>{
    const child=spawn(tool,args,{env:environment,stdio:action==='dump'?['ignore',handle.fd,'ignore']:[handle.fd,'ignore','ignore']})
    const timer=setTimeout(()=>child.kill('SIGTERM'),180_000)
    child.once('error',()=>{clearTimeout(timer);fail(Error('数据库备份工具无法执行。'))})
    child.once('exit',code=>{clearTimeout(timer);code===0?done():fail(Error('数据库'+(action==='dump'?'导出':'恢复')+'失败；保留原数据，未启动应用。'))})
   })
   if(action==='dump')await handle.sync()
  }finally{await handle.close()}
 }finally{if(temporary)await rm(temporary,{recursive:true,force:true})}
}
/** 调用方持安装锁；从已停止状态备份，完成后数据库仍保持停止。 */
export async function createBackup(state:InstallState,output:string,options?:{ordinaryUpgradeId:string;onVerified?:(staging:string)=>Promise<void>}):Promise<BackupManifest>{
 const recoveredStaging=options?await authorizeOrdinaryUpgradeBackup(state,output,options.ordinaryUpgradeId):undefined
 assertMaintenanceStopped(await serviceStatus(state),recoveredStaging&&state.phase==='maintenance'?'stopped':state.phase)
 await portAvailable(state.port)
 const destination=await canonical(output)
 if(within(state.layout.home,destination)||within(destination,state.layout.home)||within(state.layout.workspaceRoot,destination)||within(destination,state.layout.workspaceRoot))throw Error('备份位置必须独立于安装和工作目录。')
 try{await lstat(destination);throw Error('备份目标已存在；请选择新目录。')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 const release=await verifyRelease(state.layout.releaseRoot)
 if(release.version!==state.version||!canUseData(release,release.dataVersion))throw Error('该发行数据版本尚未通过备份验收。')
 const staging=recoveredStaging??destination+'.incomplete-'+randomUUID()
 await writeInstall({...state,phase:'maintenance'})
 try{
  await prepareDatabase(state,{initialize:false});await assertNoRuns(state,release.dataVersion)
  await mkdir(staging,{mode:0o700})
  await transferDatabase(state,join(staging,'database.dump'),'dump')
  await copyBackupData(state.layout.dshHome,join(staging,'dsh'),state.layout.releaseRoot,true)
  await copyBackupData(state.layout.runtimeRoot,join(staging,'runtime'),state.layout.releaseRoot,false,{managedRuntimePackages:await managedRuntimePackageChecks(state.layout.runtimeRoot,state.layout.releaseRoot)})
  await writePrivateJson(join(staging,'installation.json'),{workspaceRoot:state.layout.workspaceRoot,port:state.port})
  const manifest:BackupManifest={schema:'teloa.backup/v1',id:randomUUID(),createdAt:new Date().toISOString(),installId:state.id,version:state.version,dataVersion:release.dataVersion,files:await backupFileRecords(staging),externalWorkspaceIncluded:false}
  await writePrivateJson(join(staging,'backup-manifest.json'),manifest);await verifyBackup(staging)
  // 普通升级先持久绑定完整清单，再发布目录；崩溃续办不能只凭目录名采用备份。
  await options?.onVerified?.(staging)
  await rename(staging,destination)
  const directory=await open(dirname(destination),'r');try{await directory.sync()}finally{await directory.close()}
  return manifest
 }finally{await stopDatabase(state);await writeInstall({...state,phase:'stopped'})}
}
/**
 * 旧备份里的明文凭据（本版起备份不再包含）：恢复时读进内存交给提供方加密导入，不复制回原路径。
 * 原子写崩溃残留（`dsh/.credentials.yaml.<hex>.tmp`、受管 MCP 目录里的 `.tmp` 等）可能是半截文档，不导入，列入 `dropped` 如实报告。
 */
const legacyMcpCredential=/^runtime\/mcp\/credentials\/([A-Za-z0-9_-]{1,64})$/
export async function readLegacyBackupCredentials(backupRoot:string,manifest:BackupManifest):Promise<{yaml?:string;mcp:Record<string,string>;dropped:string[]}>{
 const paths=new Set(manifest.files.map(row=>row.path)),mcp:Record<string,string>={},dropped:string[]=[]
 for(const path of [...paths].sort()){
  const name=legacyMcpCredential.exec(path)?.[1]
  if(name)mcp[name]=await readFile(join(backupRoot,path),'utf8')
  else if(path.startsWith('runtime/mcp/credentials/')||/^dsh\/\.credentials\.yaml\.[0-9a-f]+\.tmp$/.test(path))dropped.push(path)
 }
 return {...(paths.has('dsh/.credentials.yaml')?{yaml:await readFile(join(backupRoot,'dsh/.credentials.yaml'),'utf8')}:{}),mcp,dropped}
}
/** 恢复时按清单放回运行目录的文件：不含旧数据库身份，也不含旧的受管 MCP 明文凭据（含崩溃残留的 .tmp）。 */
export function restorableRuntimeFiles(manifest:Pick<BackupManifest,'files'>):BackupManifest['files']{
 return manifest.files.filter(row=>row.path.startsWith('runtime/')&&!['runtime/database.json','runtime/postgres.env'].includes(row.path)&&!row.path.startsWith('runtime/mcp/credentials/'))
}
export async function assertRestoreWorkspace(path:string):Promise<void>{
 try{if(!(await lstat(path)).isDirectory())throw Error();await access(path,constants.R_OK|constants.W_OK|constants.X_OK)}catch{throw Error('原工作目录不存在或不可读写；请先还原工作文件到原路径，再恢复安装。')}
}
export type RestoredInstall=InstallState&{credentials:{imported:string[];failed:string[]}}
export async function restoreBackup(archive:string,targetHome:string,database:DatabaseChoice,sourceRoot=programRoot):Promise<RestoredInstall>{
 const backupRoot=await canonical(archive),manifest=await verifyBackup(backupRoot),release=await verifyRelease(sourceRoot)
 if(release.version!==manifest.version||release.dataVersion!==manifest.dataVersion)throw Error('请用与备份完全匹配的发行版本恢复。')
 const metadata=await readPrivateJson(join(backupRoot,'installation.json')) as {workspaceRoot:string;port:number}
 if(!metadata||Object.keys(metadata).sort().join(',')!=='port,workspaceRoot'||!isAbsolute(metadata.workspaceRoot)||!Number.isInteger(metadata.port)||metadata.port<1||metadata.port>65535)throw Error('备份安装信息无效。')
 await assertRestoreWorkspace(metadata.workspaceRoot)
 const layout=await resolveLayout({home:targetHome,workspace:metadata.workspaceRoot,version:manifest.version})
 if(within(backupRoot,layout.home)||within(layout.home,backupRoot))throw Error('恢复目录不能覆盖备份目录。')
 const entries=await readdir(layout.home).catch(error=>{if(error.code==='ENOENT')return [];throw error})
 if(entries.length)throw Error('恢复目标已有数据；必须选择全新的安装目录。')
 return withInstallLock(layout.home,async()=>{
  if((await readdir(layout.home)).some(name=>name!=='install.lock'))throw Error('恢复目标已有数据。')
  await stageRelease(sourceRoot,layout)
  const state:InstallState={schema:'teloa.install/v1',id:randomUUID(),version:manifest.version,layout,port:metadata.port,database,phase:'maintenance'}
  await writeInstall(state)
  try{
   await prepareDatabase(state,{initialize:false})
   const pool=await databasePool(state)
   try{if((await pool.query("select 1 from pg_tables where schemaname='public' and tablename<>'teloa_installation' limit 1")).rows.length)throw Error('恢复数据库不是新的空库。')}finally{await pool.end()}
   await transferDatabase(state,join(backupRoot,'database.dump'),'restore')
   await copyBackupData(join(backupRoot,'dsh'),layout.dshHome,sourceRoot)
   // 新目标使用新数据库身份，不能被备份内的旧连接与密码覆盖；旧的受管 MCP 明文凭据不放回原路径，可识别的稍后经提供方导入。
   for(const file of restorableRuntimeFiles(manifest)){
    const destination=join(layout.runtimeRoot,file.path.slice('runtime/'.length));await mkdir(dirname(destination),{recursive:true,mode:0o700});await copyFile(join(backupRoot,file.path),destination);await chmod(destination,0o600)
   }
   const restored=await databasePool(state)
   try{
    const {PlanService}=await import(pathToFileURL(join(layout.releaseRoot,'packages/backend/lib/work/plans.js')).href)
    const plans=new PlanService(restored,{id:randomUUID,now:()=>new Date().toISOString()})
    const rows=(await restored.query("select id,owner_id,version from teloa_plans where state='active' order by id")).rows
    for(const row of rows)await plans.change(row.owner_id,{requestId:randomUUID(),planId:row.id,expectedVersion:row.version,action:'pause',note:'从备份恢复；由本人核对后重新启用'})
   }finally{await restored.end()}
   await assertNoRuns(state,manifest.dataVersion)
   await stopDatabase(state)
   const stopped:InstallState={...state,phase:'stopped'};await writeInstall(stopped)
  }catch{await stopDatabase(state).catch(()=>{});throw Error('恢复未完成，目标保留在维护状态；原安装与备份未修改。请检查后选择另一新目录重试。')}
  // 其余数据已恢复并停在 stopped；旧明文凭据最后导入，存储不可用时不回滚已恢复的数据，只报告未导入项。
  const stopped:InstallState={...state,phase:'stopped'},legacy=await readLegacyBackupCredentials(backupRoot,manifest)
  if(legacy.yaml===undefined&&!Object.keys(legacy.mcp).length)return {...stopped,credentials:{imported:[],failed:legacy.dropped}}
  const tools=await import(pathToFileURL(join(layout.releaseRoot,'packages/harness-dsh/lib/credentials/maintenance.js')).href)
  try{
   const result=await tools.importLegacyCredentials(layout.dshHome,{...(legacy.yaml===undefined?{}:{yaml:legacy.yaml}),mcp:legacy.mcp}) as {imported:string[];failed:string[]}
   return {...stopped,credentials:{imported:result.imported,failed:[...result.failed,...legacy.dropped]}}
  }catch(error){
   const pending=(error as {pending?:unknown}).pending
   if(Array.isArray(pending))throw Error(tools.importBlockedMessage+'未导入：'+[...pending,...legacy.dropped].join('、')+'。其余数据已恢复到 '+layout.home+'，应用保持停止；启动后请在设置中重新录入这些凭据。')
   throw Error('旧备份中的凭据导入失败；其余数据已恢复到 '+layout.home+'，应用保持停止。启动后请在设置中重新录入凭据。')
  }
 })
}

/** 同安装提交维护的保护点；普通restore永远拒绝此清单，失败保持maintenance。 */
type BoundMaintenanceProof={bindingSha256:string;receipt:Record<string,unknown>;assertCurrent:()=>Promise<void>}
export async function createSubmissionMaintenanceBackup(state:InstallState,output:string,proof:BoundMaintenanceProof,dataVersion:2|5|6=2):Promise<SubmissionMaintenanceBackup>{return createBoundMaintenanceBackup(state,output,proof,dataVersion)}
export async function createPreparedMaintenanceBackup(state:InstallState,output:string,proof:BoundMaintenanceProof):Promise<SubmissionMaintenanceBackup>{return createBoundMaintenanceBackup(state,output,proof,'prepared')}
async function createBoundMaintenanceBackup(state:InstallState,output:string,proof:BoundMaintenanceProof,dataVersion:2|5|6|'prepared'):Promise<SubmissionMaintenanceBackup>{
 if(state.phase!=='maintenance'||!/^[a-f0-9]{64}$/.test(proof.bindingSha256))throw Error('提交维护必须保持原安装maintenance状态。')
 await proof.assertCurrent();await portAvailable(state.port)
 const destination=await canonical(output)
 if(within(state.layout.home,destination)||within(destination,state.layout.home))throw Error('维护备份必须保存在原安装目录之外。')
 try{await lstat(destination);throw Error('维护备份目标已存在，不能覆盖。')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 const release=await verifyRelease(state.layout.releaseRoot),staging=destination+'.incomplete-'+randomUUID()
 if(release.version!==state.version||(dataVersion==='prepared'?release.dataVersion<4||!canUseData(release,release.dataVersion):![2,5,6].includes(dataVersion)||release.dataVersion!==dataVersion||!canUseData(release,dataVersion)))throw Error('维护保护点与原发行数据版本不符。')
 await mkdir(dirname(destination),{recursive:true,mode:0o700});await mkdir(staging,{mode:0o700})
 await transferDatabase(state,join(staging,'database.dump'),'dump')
 await copyBackupData(state.layout.dshHome,join(staging,'dsh'),state.layout.releaseRoot,true)
 await copyBackupData(state.layout.runtimeRoot,join(staging,'runtime'),state.layout.releaseRoot,false,{managedRuntimePackages:await managedRuntimePackageChecks(state.layout.runtimeRoot,state.layout.releaseRoot)})
 await writePrivateJson(join(staging,'installation.json'),{workspaceRoot:state.layout.workspaceRoot,port:state.port})
 await writePrivateJson(join(staging,'maintenance-receipt.json'),{...proof.receipt,bindingSha256:proof.bindingSha256})
 const files=await backupFileRecords(staging),names=files.map(row=>row.path),manifest:SubmissionMaintenanceBackup={schema:'teloa.maintenance-backup/v1',id:randomUUID(),createdAt:new Date().toISOString(),installId:state.id,home:state.layout.home,bindingSha256:proof.bindingSha256,version:state.version,dataVersion:release.dataVersion,externalWorkspaceIncluded:false,files}
 await writePrivateJson(join(staging,'backup-manifest.json'),manifest)
 await verifySubmissionMaintenanceBackup(staging,{installId:state.id,home:state.layout.home,bindingSha256:proof.bindingSha256});await proof.assertCurrent()
 // 保护点先落盘再发布目录；进程中断不能留下看似完整、内容尚未持久的维护备份。
 const directories=new Set([staging])
 for(const path of [...names,'backup-manifest.json']){
  const absolute=join(staging,path),handle=await open(absolute,'r');try{await handle.sync()}finally{await handle.close()}
  for(let directory=dirname(absolute);within(staging,directory);directory=dirname(directory)){directories.add(directory);if(directory===staging)break}
 }
 for(const path of [...directories].sort((a,b)=>b.length-a.length)){const handle=await open(path,'r');try{await handle.sync()}finally{await handle.close()}}
 await proof.assertCurrent();await rename(staging,destination)
 const parent=await open(dirname(destination),'r');try{await parent.sync()}finally{await parent.close()}
 return manifest
}
