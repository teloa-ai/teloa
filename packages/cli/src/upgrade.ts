import {readFile,mkdtemp,mkdir,chmod,unlink} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {randomUUID} from 'node:crypto'
import type {ReleaseManifest,InstallState} from './contracts.ts'
import {exactVersion,resolveLayout} from './layout.ts'
import {writePrivateJson,writeInstall} from './state.ts'
import {verifyRelease,stageRelease} from './releases.ts'
import {createBackup,assertMaintenanceStopped} from './maintenance.ts'
import {databasePool,prepareDatabase} from './database.ts'
import {serviceStatus,startService,stopService,controlPath} from './service.ts'
import {command} from './process.ts'

export function canUseData(release:ReleaseManifest,dataVersion:number):boolean{
 // 首发没有通用 schema 降级系统；只支持已验收的同数据版本，不执行迁移。
 return dataVersion===1&&release.dataVersion===1&&release.compatibleDataVersions.includes(dataVersion)
}
export function verifyRegistryInstall(pkg:any,lock:any,version:string):void{
 if(!exactVersion(version)||pkg?.version!==version)throw Error('注册表发行版本与指定版本不一致。')
 if(pkg?.name!=='@teloa/cli')throw Error('注册表包身份不正确。')
 const entry=lock?.packages?.['node_modules/@teloa/cli']
 if(entry?.version!==version||typeof entry.integrity!=='string'||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity))throw Error('注册表安装缺少可核对的完整性记录。')
}
export async function fetchRelease(state:InstallState,version:string):Promise<string>{
 if(!exactVersion(version))throw Error('升级必须指定确切版本，不能使用标签或 URL。')
 const updates=join(state.layout.home,'updates');await mkdir(updates,{recursive:true,mode:0o700})
 const directory=await mkdtemp(join(updates,'download-'));await chmod(directory,0o700)
 const result=await command('npm',['install','--prefix',directory,'--cache',join(directory,'cache'),'--ignore-scripts','--package-lock=true','--save-exact','--no-audit','--no-fund','@teloa/cli@'+version],{timeout:180_000})
 if(result.code!==0)throw Error('指定版本下载或依赖安装失败；当前版本与数据未切换。请核对 npm 注册表及版本。')
 const source=join(directory,'node_modules/@teloa/cli')
 verifyRegistryInstall(JSON.parse(await readFile(join(source,'package.json'),'utf8')),JSON.parse(await readFile(join(directory,'package-lock.json'),'utf8')),version)
 await verifyRelease(source);return source
}
/** 由调用方持安装锁。下载失败保留旧安装；切换后的失败只保留恢复点，不假装回滚数据库。 */
export async function upgradeInstall(state:InstallState,version:string,download=fetchRelease):Promise<InstallState>{
 if(!exactVersion(version))throw Error('升级必须指定确切版本。')
 if(version===state.version)return state
 assertMaintenanceStopped(await serviceStatus(state),state.phase)
 const current=await verifyRelease(state.layout.releaseRoot)
 const source=await download(state,version),candidate=await verifyRelease(source)
 if(candidate.version!==version||!canUseData(candidate,current.dataVersion))throw Error('候选版本的数据兼容性尚未验证，拒绝切换。')
 const layout=await resolveLayout({home:state.layout.home,workspace:state.layout.workspaceRoot,version})
 await stageRelease(source,layout)
 const directory=state.layout.home+'.backups';await mkdir(directory,{recursive:true,mode:0o700})
 const backup=join(directory,'before-'+version+'-'+randomUUID())
 await createBackup(state,backup)
 const next:InstallState={...state,version,layout,phase:'maintenance'},record=join(layout.instanceRoot,'upgrade.json')
 await writePrivateJson(record,{from:state.version,to:version,backup,status:'switching'})
 await writeInstall(next)
 try{
  await prepareDatabase(next)
  const pool=await databasePool(next)
  try{const row=(await pool.query('select data_version from teloa_installation where id=$1',[next.id])).rows[0];if(!canUseData(candidate,row?.data_version))throw Error('数据库版本与候选不兼容。')}finally{await pool.end()}
  await startService({...next,phase:'stopped'})
  await writePrivateJson(record,{from:state.version,to:version,backup,status:'complete'})
  const ready:InstallState={...next,phase:'ready'};await writeInstall(ready);return ready
 }catch{
  await stopService(next).catch(()=>{})
  await writeInstall({...next,phase:'maintenance'})
  await writePrivateJson(record,{from:state.version,to:version,backup,status:'failed'})
  throw Error('候选版本未就绪；安装保持维护状态，未自动降级数据。请用旧版 CLI 将 '+backup+' 恢复到新目录；该备份不含凭据，恢复后需在设置中重新录入。')
 }
}
export async function unregisterInstall(state:InstallState):Promise<void>{
 await stopService(state)
 // 只有私密控制通道确认停止后才移除进程登记；所有数据与保留的版本均不删除。
 await unlink(controlPath(state)).catch(error=>{if(error.code!=='ENOENT')throw error})
 await writeInstall({...state,phase:state.phase==='maintenance'?'maintenance':'stopped'})
}
