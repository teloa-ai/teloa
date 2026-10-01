import {createHash,randomUUID} from 'node:crypto'
import {access,copyFile,lstat,readFile,readdir,realpath,mkdir,rename,chmod,open,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {constants} from 'node:fs'
import {join,dirname,relative,isAbsolute,resolve,sep} from 'node:path'
import {tmpdir} from 'node:os'
import {spawn} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import type {BackupManifest,DatabaseChoice,InstallState,Status} from './contracts.ts'
import {canonical,exactVersion,within,resolveLayout,programRoot} from './layout.ts'
import {readPrivateJson,writePrivateJson,writeInstall,withInstallLock} from './state.ts'
import {verifyRelease,stageRelease} from './releases.ts'
import {serviceStatus,portAvailable} from './service.ts'
import {prepareDatabase,stopDatabase,databasePool,databaseConfig,ownContainer,databaseName,localConnection} from './database.ts'
import {command} from './process.ts'

const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex')
const safePath=(path:unknown):path is string=>typeof path==='string'&&path.length>0&&!isAbsolute(path)&&!path.includes('\\')&&!path.includes('\0')&&path.split('/').every(part=>part&&part!=='.'&&part!=='..')
const uuid=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
async function listFiles(root:string):Promise<string[]>{
 const result:string[]=[]
 async function walk(directory:string){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const path=join(directory,entry.name)
   if(entry.isSymbolicLink())throw Error('备份不接受软链接。')
   if(entry.isDirectory())await walk(path)
   else if(entry.isFile())result.push(relative(root,path).split('\\').join('/'))
   else throw Error('备份包含不支持的文件类型。')
  }
 }
 const info=await lstat(root);if(!info.isDirectory()||info.isSymbolicLink())throw Error('备份目录不能是链接。')
 await walk(root);return result.sort()
}
export async function verifyBackup(root:string):Promise<BackupManifest>{
 const files=await listFiles(root)
 const value=await readPrivateJson(join(root,'backup-manifest.json')) as BackupManifest
 if(!value||Object.keys(value).sort().join(',')!=='createdAt,dataVersion,externalWorkspaceIncluded,files,id,installId,schema,version'||value.schema!=='teloa.backup/v1'||!uuid(value.id)||!uuid(value.installId)||!exactVersion(value.version)||!Number.isFinite(Date.parse(value.createdAt))||value.externalWorkspaceIncluded!==false||!Array.isArray(value.files))throw Error('备份清单无效。')
 if(value.dataVersion!==1)throw Error('备份数据版本尚不支持。')
 const names=new Set<string>()
 for(const row of value.files){
  if(!row||Object.keys(row).sort().join(',')!=='path,sha256'||!safePath(row.path)||names.has(row.path)||!/^[a-f0-9]{64}$/.test(row.sha256)||!(row.path==='database.dump'||row.path==='installation.json'||row.path.startsWith('dsh/')||row.path.startsWith('runtime/')))throw Error('备份清单路径无效。')
  names.add(row.path)
 }
 if(!names.has('database.dump')||!names.has('installation.json')||JSON.stringify([...names].sort())!==JSON.stringify(files.filter(path=>path!=='backup-manifest.json')))throw Error('备份实际文件与清单不一致。')
 for(const row of value.files)if(digest(await readFile(join(root,row.path)))!==row.sha256)throw Error('备份文件摘要不一致。')
 return value
}
export function assertMaintenanceStopped(status:Pick<Status,'app'|'activeWork'>,phase:InstallState['phase']):void{
 if(status.app!=='stopped'||phase!=='stopped')throw Error('请先让任务收尾并运行 teloa stop；维护要求本安装明确停止。')
}
export async function assertMaintenanceDatabase(db:{query:(sql:string)=>Promise<{rows:any[]}>}):Promise<void>{
 const pending=await db.query(`select
  (select count(*)::integer from teloa_task_runs where state in ('prepared','submitting','accepted','active')) as runs,
  (select count(*)::integer from teloa_plan_occurrences o
   join teloa_plan_task_links l on l.claim_id=o.id join teloa_tasks t on t.id=l.task_id
   left join teloa_task_runs r on r.owner_id=o.owner_id and r.request_id=o.id
   where r.request_id is null and t.state not in ('completed','cancelled')) as plans,
  (select count(*)::integer from teloa_security_action_executions where state in ('dispatching','accepted','effect_unknown')) as effects,
  (select count(*)::integer from teloa_plugin_installations where state in ('preparing','unknown')) as plugins`)
 const row=pending.rows[0]
 if(!row||Object.values(row).some(value=>!Number.isSafeInteger(value)||Number(value)<0))throw Error('数据库维护状态不可确认。')
 if(row.runs)throw Error('数据库仍有未收尾的运行；请回到原安装处理后再备份。')
 if(row.plans)throw Error('仍有已生成任务但尚未运行的计划待派发项；请回到原安装收尾。')
 if(row.effects)throw Error('仍有未确认结果的外部执行；请在原安装完成核对。')
 if(row.plugins)throw Error('仍有未完成的扩展安装；请先在原安装处理。')
}
async function assertNoRuns(state:InstallState):Promise<void>{
 const pool=await databasePool(state)
 try{
  const marker=await pool.query('select id,data_version from teloa_installation')
  if(marker.rows.length!==1||marker.rows[0].id!==state.id||marker.rows[0].data_version!==1)throw Error('数据库身份或版本不符。')
  await assertMaintenanceDatabase(pool)
 }finally{await pool.end()}
}
/** `$DSH_HOME/.env` 可能含明文密钥，与凭据一样不随备份；备份与恢复输出提示本人自行保存。 */
export const dshEnvBackupNotice='DSH 目录下的 .env 可能含明文密钥，未包含在备份中；如需保留请自行另存到受保护的位置。'
export const dshEnvRestoreNotice=(dshHome:string)=>'DSH 目录下的 .env 不随备份恢复；如原安装有需要的设置，请自行放回 '+join(dshHome,'.env')+'（仅本人可读，0600）。'
export async function copyBackupData(source:string,target:string,releaseRoot:string,skipGenerated=false):Promise<void>{
 await mkdir(target,{recursive:true,mode:0o700})
 async function visit(from:string,to:string,generated:boolean){
  for(const entry of await readdir(from,{withFileTypes:true})){
   const src=join(from,entry.name),dst=join(to,entry.name)
   const skip=generated||skipGenerated&&/^profiles\/(?:[^/]+\/(?:\.dsh-module-fallback\/)?)?node_modules$/.test(relative(source,src))
   // 凭据不随备份（规格 §3.5）：根目录下 `.credentials.*` 一律跳过——凭据文件、改名留存与隔离的明文副本、
   // 原子写崩溃残留的明文 `.credentials.yaml.<hex>.tmp`，以及本就不该复制的锁与接管互斥文件；受管 MCP 旧凭据目录同样跳过。
   // 根目录下的 `.env`（DSH 的用户环境层，可能含明文密钥）同样跳过，备份与恢复输出提示本人自行保存。
   const rel=relative(source,src).split(sep).join('/')
   if(/^\.credentials\./.test(rel)||/^mcp\/credentials(?:\/|$)/.test(rel)||rel==='.env')continue
   if(entry.isSymbolicLink()){
    // DSH 根据当前发行重建这一目录；只允许省略指向当前版本的生成链接。
    if(skip&&within(await realpath(releaseRoot),await realpath(src)))continue
    throw Error('数据含不能安全备份的外链；请移除外部链接或另行保存扩展后重试。')
   }
   if(entry.isDirectory()){
    if(!skip)await mkdir(dst,{mode:0o700})
    await visit(src,dst,skip)
   }else if(entry.isFile()){
    if(skip)throw Error('生成的依赖目录含本地扩展文件，不能省略备份。')
    // 操作系统锁及派生缓存重建，避免复制过期 PID 或源机器锁身份。
    if(entry.name==='session.lock')continue
    await copyFile(src,dst);await chmod(dst,0o600)
   }else throw Error('数据含不支持的文件类型，备份已停止。')
  }
 }
 await visit(source,target,false)
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
export async function createBackup(state:InstallState,output:string):Promise<BackupManifest>{
 assertMaintenanceStopped(await serviceStatus(state),state.phase)
 await portAvailable(state.port)
 const destination=await canonical(output)
 if(within(state.layout.home,destination)||within(destination,state.layout.home)||within(state.layout.workspaceRoot,destination)||within(destination,state.layout.workspaceRoot))throw Error('备份位置必须独立于安装和工作目录。')
 try{await lstat(destination);throw Error('备份目标已存在；请选择新目录。')}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 const release=await verifyRelease(state.layout.releaseRoot)
 if(release.dataVersion!==1)throw Error('该发行数据版本尚未通过备份验收。')
 const staging=destination+'.incomplete-'+randomUUID()
 await writeInstall({...state,phase:'maintenance'})
 try{
  await prepareDatabase(state,{initialize:false});await assertNoRuns(state)
  await mkdir(staging,{mode:0o700})
  await transferDatabase(state,join(staging,'database.dump'),'dump')
  await copyBackupData(state.layout.dshHome,join(staging,'dsh'),state.layout.releaseRoot,true)
  await copyBackupData(state.layout.runtimeRoot,join(staging,'runtime'),state.layout.releaseRoot)
  await writePrivateJson(join(staging,'installation.json'),{workspaceRoot:state.layout.workspaceRoot,port:state.port})
  const files=await listFiles(staging),manifest:BackupManifest={schema:'teloa.backup/v1',id:randomUUID(),createdAt:new Date().toISOString(),installId:state.id,version:state.version,dataVersion:release.dataVersion,files:await Promise.all(files.map(async path=>({path,sha256:digest(await readFile(join(staging,path)))}))),externalWorkspaceIncluded:false}
  await writePrivateJson(join(staging,'backup-manifest.json'),manifest);await verifyBackup(staging)
  await rename(staging,destination);return manifest
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
   await assertNoRuns(state)
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
