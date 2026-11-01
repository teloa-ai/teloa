import {randomUUID} from 'node:crypto'
import {readFile,lstat,open} from 'node:fs/promises'
import {readFileSync,lstatSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {isDeepStrictEqual} from 'node:util'
import type {InstallState,Layout} from './contracts.ts'
import {readPrivateJson,writePrivateJson,writeInstall} from './state.ts'
import {resolveLayout,exactVersion} from './layout.ts'
import {databasePool,databaseConfig,localConnection,prepareDatabase} from './database.ts'
import {verifyRelease,stageRelease} from './releases.ts'
import {canUpgradeData} from './data-version.ts'
import {assertSubmissionMaintenanceDatabase,createSubmissionMaintenanceBackup,verifySubmissionMaintenanceBackup} from './maintenance.ts'
import {maintenanceHelper,maintenanceDigest,captureMaintenanceProcesses,assertMaintenanceExited,stopForSubmissionMaintenance,type MaintenanceProcesses,type MaintenanceProcessReceipt} from './maintenance-process.ts'

export const unpublishedMaintenanceNotice='本次只取消全部尝试均确定未发布的原提交，保留任务、会话、历史和审计；不会重新发送。维护完成前应用保持停止，保护点仅供本安装核对。'
export const submissionMaintenanceNotice='提交结果将保留为未知，原任务暂停；不会重发或释放未知预算。退出证明仅覆盖已认证的原supervisor、runtime及存在时的同发行内置参考资料MCP进程世代，观察从这些进程全部注册后开始；历史未登记的派生进程与外部效果仍未知，不能视为已结清。专用维护备份只能作为本安装保护点，不能用普通restore恢复，也不提供自动回滚。'
type RunIdentity={owner:string;runId:string;taskId:string;sessionId:string;nativeRequestId:string;inputSha256:string;runtimeId:string;agentPresetId:string}
type Binding={installId:string;home:string;homeDevice:number;homeInode:number;database:{endpoint:string;systemIdentifier:string};sourceVersion:string;sourceDataVersion:2|5|6;sourceReleaseSha256:string;run:RunIdentity}
type Intent={schema:'teloa.submission-maintenance/v1';requestId:string;targetVersion:string;targetReleaseSha256:string;binding:Binding;bindingSha256:string;processes:MaintenanceProcesses;backup:string;acknowledgedUnknown?:true;cancelNotPublished?:true}
type Snapshot={path:string;device:number;inode:number;size:number;fileSha256:string;logCut:number;logSha256:string;notPublished?:true}
const uuid=(v:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const denied=()=>Error('维护身份或原运行已变化，安装保持维护状态；不会重发、接管其他安装或自动回滚。')
function paths(state:InstallState,mode?:{cancelNotPublished?:true;runId?:string;binding?:Binding}){
 if(mode?.cancelNotPublished){
  const runId=mode.runId??mode.binding?.run.runId
  if(!runId||!uuid(runId))throw denied()
  const root=join(state.layout.instanceRoot,'submission-maintenance-not-published',runId)
  return {intent:join(root,'intent.json'),receipt:join(root,'exit.json'),snapshot:join(root,'log.json'),complete:join(root,'complete.json')}
 }
 return {intent:join(state.layout.instanceRoot,'submission-maintenance.json'),receipt:join(state.layout.instanceRoot,'submission-maintenance-exit.json'),snapshot:join(state.layout.instanceRoot,'submission-maintenance-log.json'),complete:join(state.layout.instanceRoot,'submission-maintenance-complete.json')}
}
async function durable(path:string,value:unknown){await writePrivateJson(path,value);const directory=await open(dirname(path),'r');try{await directory.sync()}finally{await directory.close()}}
async function durableInstall(state:InstallState){await writeInstall(state);const directory=await open(state.layout.instanceRoot,'r');try{await directory.sync()}finally{await directory.close()}}
async function optional(path:string):Promise<unknown|undefined>{try{return await readPrivateJson(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}}
function assertLease(state:InstallState):()=>void{
 const path=join(state.layout.home,'install.lock'),lease=JSON.parse(readFileSync(path,'utf8'))
 if(lease.pid!==process.pid||typeof lease.identity!=='string')throw denied()
 return ()=>{if(!isDeepStrictEqual(JSON.parse(readFileSync(path,'utf8')),lease))throw denied()}
}
async function databaseIdentity(state:InstallState,pool:any):Promise<Binding['database']>{
 const config=await readPrivateJson(databaseConfig(state)) as {connectionString:string},url=localConnection(config.connectionString)
 // 当前桥只接受可核验cluster身份的本机库。权限不足时拒绝，不能只凭安装UUID证明是同一数据库。
 const value=(await pool.query('select system_identifier::text as id from pg_control_system()')).rows[0]?.id
 if(typeof value!=='string'||!/^\d+$/.test(value))throw denied()
 return {endpoint:url.protocol+'//'+url.hostname+':'+(url.port||'5432')+url.pathname,systemIdentifier:value}
}
async function runIdentity(pool:any,runId:string,completed=false,cancelling=false):Promise<RunIdentity>{
 const row=(await pool.query('select * from teloa_task_runs where id=$1',[runId])).rows[0]
 if(!row||row.evidence!==null||!(row.state==='submitting'||completed&&row.state===(cancelling?'withdrawn':'submission_unknown'))||typeof row.agent_preset_id!=='string')throw denied()
 if(cancelling){
  if(!row.stop_requested_at)throw denied()
  const attempts=(await pool.query('select state,settled_at,session_id,native_request_id,input_sha256,runtime_id from teloa_task_run_submissions where owner_id=$1 and run_id=$2 order by attempt',[row.owner_id,row.id])).rows
  if(!attempts.length||attempts.some((a:any)=>a.state!=='not-published'||!(a.settled_at instanceof Date)||a.session_id!==row.session_id||a.native_request_id!==row.native_request_id||a.input_sha256!==maintenanceDigest(row.input_text)||!uuid(a.runtime_id)))throw denied()
 }
 const links=(await pool.query('select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2',[row.owner_id,runId])).rows
 if(links.length!==1)throw denied()
 const link=links[0],runtimeId=link.payload?.runtimeId
 if(link.kind!=='job'||link.payload?.record!=='owner'||!uuid(runtimeId)||link.native_id!=='owner:'+runtimeId+':'+row.session_id||link.session_id!==row.session_id||link.payload.requestId!==row.native_request_id)throw denied()
 return {owner:row.owner_id,runId:row.id,taskId:row.task_id,sessionId:row.session_id,nativeRequestId:row.native_request_id,inputSha256:maintenanceDigest(row.input_text),runtimeId,agentPresetId:row.agent_preset_id}
}
function readIntent(value:any,state:InstallState,runId?:string,targetVersion?:string):Intent{
 if(!value||value.schema!=='teloa.submission-maintenance/v1'||!uuid(value.requestId)||!((value.acknowledgedUnknown===true&&value.cancelNotPublished===undefined)||(value.cancelNotPublished===true&&value.acknowledgedUnknown===undefined))||!exactVersion(value.targetVersion)||!/^[a-f0-9]{64}$/.test(value.targetReleaseSha256)||value.binding?.installId!==state.id||value.binding.home!==state.layout.home||!(value.cancelNotPublished?[5,6]:[2]).includes(value.binding.sourceDataVersion)||maintenanceDigest(JSON.stringify(value.binding))!==value.bindingSha256||!uuid(value.binding.run?.runId)||runId&&value.binding.run.runId!==runId||targetVersion&&value.targetVersion!==targetVersion||value.backup!==state.layout.home+'.backups/submission-'+value.requestId||![value.binding.sourceVersion,value.targetVersion].includes(state.version))throw denied()
 return value
}
async function verifyDatabase(state:InstallState,intent:Intent,completed=false):Promise<void>{
 const pool=await databasePool(state)
 try{
  const target=await verifyRelease(join(state.layout.home,'releases',intent.targetVersion))
  if(maintenanceDigest(JSON.stringify(target))!==intent.targetReleaseSha256||!(intent.cancelNotPublished?[5,6]:[3]).includes(target.dataVersion)||!canUpgradeData(target,intent.binding.sourceDataVersion))throw denied()
  const marker=(await pool.query('select id,data_version from teloa_installation')).rows
  if(marker.length!==1||marker[0].id!==state.id||!(intent.cancelNotPublished?[intent.binding.sourceDataVersion,target.dataVersion]:[2,3]).includes(marker[0].data_version)||!isDeepStrictEqual(await databaseIdentity(state,pool),intent.binding.database)||!isDeepStrictEqual(await runIdentity(pool,intent.binding.run.runId,completed,intent.cancelNotPublished===true),intent.binding.run))throw denied()
  await assertSubmissionMaintenanceDatabase(pool,intent.binding.run)
 }finally{await pool.end()}
}
function currentGuard(state:InstallState,intent:Intent,lease:()=>void,receipt?:MaintenanceProcessReceipt,snapshot?:Snapshot,phase:'maintenance'|'stopped'='maintenance'):()=>void{
 const p=paths(state,intent),receiptHash=receipt?maintenanceDigest(JSON.stringify(receipt)):undefined
 return ()=>{
  lease();const stored=JSON.parse(readFileSync(join(state.layout.instanceRoot,'state.json'),'utf8')),home=lstatSync(state.layout.home)
  if(stored.id!==state.id||stored.phase!==phase||stored.layout?.home!==intent.binding.home||home.isSymbolicLink()||home.dev!==intent.binding.homeDevice||home.ino!==intent.binding.homeInode||!isDeepStrictEqual(JSON.parse(readFileSync(p.intent,'utf8')),intent))throw denied()
  if(receiptHash&&maintenanceDigest(JSON.stringify(JSON.parse(readFileSync(p.receipt,'utf8'))))!==receiptHash)throw denied()
  const control=JSON.parse(readFileSync(join(state.layout.instanceRoot,'control.json'),'utf8'))
  if(['pid','startedAt','nonce','installId','port'].some(key=>Reflect.get(control,key)!==Reflect.get(intent.processes.control,key)))throw denied()
  if(snapshot){const info=lstatSync(snapshot.path);if(info.isSymbolicLink()||info.dev!==snapshot.device||info.ino!==snapshot.inode||info.size!==snapshot.size||maintenanceDigest(readFileSync(snapshot.path))!==snapshot.fileSha256)throw denied()}
 }
}
async function proofContext(state:InstallState,intent:Intent,phase:'maintenance'|'stopped'='maintenance'){
 const release=await verifyRelease(state.layout.releaseRoot)
 if(maintenanceDigest(JSON.stringify(release))!==intent.targetReleaseSha256)throw denied()
 const lease=assertLease(state),helper=await maintenanceHelper(state.layout.releaseRoot),receipt=await readPrivateJson(paths(state,intent).receipt) as MaintenanceProcessReceipt,snapshot=await readPrivateJson(paths(state,intent).snapshot) as Snapshot,guard=currentGuard(state,intent,lease,receipt,snapshot,phase)
 guard();await assertMaintenanceExited(state,helper,intent.processes,receipt,intent.bindingSha256);await verifyDatabase(state,intent,true);guard()
 return {helper,receipt,snapshot,guard}
}
const completion=(intent:Intent)=>({schema:'teloa.submission-maintenance-complete/v1',requestId:intent.requestId,runId:intent.binding.run.runId,installId:intent.binding.installId,version:intent.targetVersion,state:intent.cancelNotPublished?'withdrawn':'submission_unknown',backup:intent.backup})
async function maintenanceAudit(intent:Intent,receipt:MaintenanceProcessReceipt,snapshot:Snapshot){return {schema:'teloa.task-run-maintenance/v1',source:'maintenance-process-exit',installId:intent.binding.installId,requestId:intent.requestId,runId:intent.binding.run.runId,processReceipt:{...receipt,maintenanceBinding:intent.binding},backupSha256:maintenanceDigest(await readFile(join(intent.backup,'backup-manifest.json'))),logFileSha256:snapshot.fileSha256}}
type SnapshotReader=(input:{dshHome:string;expectedCwd:string;run:Pick<RunIdentity,'sessionId'|'agentPresetId'>&{nativeRequestId?:string};requireNotPublished?:true})=>Promise<Snapshot>
/** npm 包内没有内部包解析链接；先建立正式发行副本，不切安装状态、不迁移数据库或启动宿主。 */
export async function prepareSubmissionMaintenanceInspector(sourceRoot:string,layout:Layout):Promise<SnapshotReader>{
 await stageRelease(sourceRoot,layout)
 const inspector=await import(pathToFileURL(join(layout.releaseRoot,'packages/harness-dsh/lib/stopped-task-run-inspection.js')).href)
 if(typeof inspector.readStoppedSubmissionSnapshot!=='function')throw denied()
 return inspector.readStoppedSubmissionSnapshot as SnapshotReader
}
/** prepareDatabase内部的专用迁移证明；不提供客户端可上传或跳过活动检查的参数。 */
export async function verifySubmissionMaintenanceMigration(state:InstallState,backup:string){
 // 从已绑定保护点定位本轮具名日志；未发布取消不能误读更早的 unknown 维护日志。
 const saved=await readPrivateJson(join(backup,'maintenance-receipt.json')) as {intent?:unknown}
 const intent=readIntent(saved?.intent,state)
 if(state.phase!=='maintenance'||state.version!==intent.targetVersion||backup!==intent.backup)throw denied()
 if(!isDeepStrictEqual(readIntent(await readPrivateJson(paths(state,intent).intent),state),intent))throw denied()
 await proofContext(state,intent)
 return verifySubmissionMaintenanceBackup(backup,{installId:state.id,home:state.layout.home,bindingSha256:intent.bindingSha256})
}

/** 调用方持原安装锁；默认使用当前完整命令包，已有维护仅可显式继续其冻结目标。 */
export async function resolveSubmissionMaintenance(state:InstallState,input:{runId:string;targetVersion:string;acknowledgeUnknown?:true;cancelNotPublished?:true;existingTargetOnly?:true},sourceRoot:string):Promise<{state:InstallState;backup:string;runId:string;requestId:string}>{
 if(!uuid(input.runId)||!((input.acknowledgeUnknown===true&&input.cancelNotPublished===undefined)||(input.cancelNotPublished===true&&input.acknowledgeUnknown===undefined))||!exactVersion(input.targetVersion))throw denied()
 const lease=assertLease(state),candidate=await verifyRelease(sourceRoot),helper=await maintenanceHelper(sourceRoot),p=paths(state,input)
 if(candidate.version!==input.targetVersion||!(input.cancelNotPublished?[5,6]:[3]).includes(candidate.dataVersion)||!canUpgradeData(candidate,input.cancelNotPublished?5:2))throw denied()
 // stageRelease 会规范化清单排版；绑定结构内容，不能把空白变化误判为不同发行。
 const targetReleaseSha256=maintenanceDigest(JSON.stringify(candidate))
 let intent=readIntentIfPresent(await optional(p.intent))
 if(intent&&(intent.targetReleaseSha256!==targetReleaseSha256||!!intent.cancelNotPublished!==!!input.cancelNotPublished))throw denied()
 if(input.existingTargetOnly&&(!intent||state.phase!=='maintenance'))throw Error('--source-release 只能继续本安装已有的维护意图，不能新建维护或更换目标发行。')
 function readIntentIfPresent(value:unknown){return value===undefined?undefined:readIntent(value,state,input.runId,input.targetVersion)}
 const targetLayout=await resolveLayout({home:state.layout.home,workspace:state.layout.workspaceRoot,version:input.targetVersion})
 // 导入失败必须发生在任何维护信号之前；原包与原安装内容均不被改写。
 const inspectSnapshot=await prepareSubmissionMaintenanceInspector(sourceRoot,targetLayout)
 if(!intent){
  if(state.phase!=='ready'||state.version===input.targetVersion)throw Error('此维护路径仅处理原数据2安装的在途未知提交；请保持原安装身份。')
  const source=await verifyRelease(state.layout.releaseRoot)
  if(source.version!==state.version||!(input.cancelNotPublished?[5,6]:[2]).includes(source.dataVersion)||!canUpgradeData(candidate,source.dataVersion))throw denied()
  const pool=await databasePool(state)
  let binding:Binding
  try{
   const marker=(await pool.query('select id,data_version from teloa_installation')).rows
   if(marker.length!==1||marker[0].id!==state.id||marker[0].data_version!==source.dataVersion)throw denied()
   const run=await runIdentity(pool,input.runId,false,input.cancelNotPublished===true);await assertSubmissionMaintenanceDatabase(pool,run)
   const home=await lstat(state.layout.home)
   binding={installId:state.id,home:state.layout.home,homeDevice:home.dev,homeInode:home.ino,database:await databaseIdentity(state,pool),sourceVersion:state.version,sourceDataVersion:source.dataVersion as 2|5|6,sourceReleaseSha256:maintenanceDigest(await readFile(join(state.layout.releaseRoot,'release-manifest.json'))),run}
  }finally{await pool.end()}
  const processes=await captureMaintenanceProcesses(state,helper),requestId=randomUUID()
  intent={schema:'teloa.submission-maintenance/v1',requestId,targetVersion:input.targetVersion,targetReleaseSha256,binding,bindingSha256:maintenanceDigest(JSON.stringify(binding)),processes,backup:state.layout.home+'.backups/submission-'+requestId,...(input.cancelNotPublished?{cancelNotPublished:true as const}:{acknowledgedUnknown:true as const})}
  lease();await durable(p.intent,intent)
 }
 const sourceState:InstallState={...state,version:intent.binding.sourceVersion,layout:await resolveLayout({home:state.layout.home,workspace:state.layout.workspaceRoot,version:intent.binding.sourceVersion}),phase:'maintenance'}
 if(maintenanceDigest(await readFile(join(sourceState.layout.releaseRoot,'release-manifest.json')))!==intent.binding.sourceReleaseSha256)throw denied()
 await verifyRelease(sourceState.layout.releaseRoot)
 if(state.phase!=='maintenance'){
  if(state.phase!=='ready'||state.version!==intent.binding.sourceVersion||!isDeepStrictEqual(await captureMaintenanceProcesses(state,helper),intent.processes))throw denied()
  await durableInstall({...state,phase:'maintenance'})
 }
 let receipt=await optional(p.receipt) as MaintenanceProcessReceipt|undefined
 if(!receipt){
  if(!isDeepStrictEqual(await captureMaintenanceProcesses(sourceState,helper),intent.processes))throw denied()
  currentGuard(sourceState,intent,lease)()
  receipt=await stopForSubmissionMaintenance(helper,intent.processes,p.receipt,intent.bindingSha256)
 }
 const guard=currentGuard(sourceState,intent,lease,receipt),assertStopped=async()=>{guard();await assertMaintenanceExited(sourceState,helper,intent!.processes,receipt!,intent!.bindingSha256);await verifyDatabase(sourceState,intent!,true);guard()}
 await assertStopped()
 let snapshot=await optional(p.snapshot) as Snapshot|undefined
 const observed=await inspectSnapshot({dshHome:state.layout.dshHome,expectedCwd:state.layout.workspaceRoot,run:intent.binding.run,...(intent.cancelNotPublished?{requireNotPublished:true as const}:{})})
 if(snapshot&&!isDeepStrictEqual(snapshot,observed))throw denied()
 if(!snapshot){snapshot=observed;await durable(p.snapshot,snapshot)}
 const fixedGuard=currentGuard(sourceState,intent,lease,receipt,snapshot)
 fixedGuard()
 const existingBackup=await optional(join(intent.backup,'backup-manifest.json'))
 if(existingBackup===undefined){
  if(state.version!==intent.binding.sourceVersion)throw denied()
  await createSubmissionMaintenanceBackup(sourceState,intent.backup,{bindingSha256:intent.bindingSha256,receipt:{intent,processReceipt:receipt,snapshot},assertCurrent:async()=>{await assertStopped();fixedGuard()}},intent.binding.sourceDataVersion)
 }
 await verifySubmissionMaintenanceBackup(intent.backup,{installId:state.id,home:state.layout.home,bindingSha256:intent.bindingSha256})
 const next:InstallState={...state,version:input.targetVersion,layout:targetLayout,phase:'maintenance'}
 await stageRelease(sourceRoot,next.layout);fixedGuard();await durableInstall(next)
 await prepareDatabase(next,{migrationBackup:intent.backup,submissionMaintenance:true})
 await assertStopped();fixedGuard()
 const pool=await databasePool(next)
 try{
  const runApi=await import(pathToFileURL(join(next.layout.releaseRoot,'packages/backend/lib/work/task-runs.js')).href),submissionApi=await import(pathToFileURL(join(next.layout.releaseRoot,'packages/backend/lib/work/task-run-submission.js')).href)
  const runs=new runApi.TaskRunService(pool,{id:randomUUID,now:()=>new Date().toISOString()},async()=>{throw denied()})
  await runs.requestStop(intent.binding.run.owner,{runId:input.runId})
  const audit=await maintenanceAudit(intent,receipt,snapshot)
  const fence={runId:input.runId,sessionId:intent.binding.run.sessionId,nativeRequestId:intent.binding.run.nativeRequestId,inputSha256:intent.binding.run.inputSha256,runtimeId:intent.binding.run.runtimeId,logCut:snapshot.logCut,logSha256:snapshot.logSha256,...(snapshot.notPublished?{notPublished:true as const}:{}),assertCurrent:fixedGuard}
  if(intent.cancelNotPublished)await new submissionApi.TaskRunSubmissionService(pool).cancelNotPublishedAfterMaintenance(intent.binding.run.owner,{requestId:intent.requestId,runId:input.runId,confirmNotPublished:true},runs,fence,audit)
  else await new submissionApi.TaskRunSubmissionService(pool).disposeUnknownAfterMaintenance(intent.binding.run.owner,{requestId:intent.requestId,runId:input.runId,acknowledgeUnknown:true},runs,fence,audit)
  fixedGuard();await durable(p.complete,completion(intent))
 }finally{await pool.end()}
 return {state:next,backup:intent.backup,runId:input.runId,requestId:intent.requestId}
}

/** 只有此维护流程已原子完成后，本人另行选择才能解除maintenance；不启动宿主。 */
export async function finishSubmissionMaintenance(state:InstallState,input:{runId:string;targetVersion:string;cancelNotPublished?:true},sourceRoot?:string):Promise<InstallState>{
 const p=paths(state,input),intent=readIntent(await readPrivateJson(p.intent),state,input.runId,input.targetVersion),complete=await readPrivateJson(p.complete) as any
 if(!!input.cancelNotPublished!==!!intent.cancelNotPublished||input.runId!==intent.binding.run.runId||input.targetVersion!==intent.targetVersion||!isDeepStrictEqual(complete,completion(intent))||state.version!==intent.targetVersion||!['maintenance','stopped'].includes(state.phase))throw denied()
 if(sourceRoot){const candidate=await verifyRelease(sourceRoot);if(candidate.version!==intent.targetVersion||maintenanceDigest(JSON.stringify(candidate))!==intent.targetReleaseSha256)throw denied()}
 const {receipt,snapshot,guard}=await proofContext(state,intent,state.phase as 'maintenance'|'stopped')
 await verifySubmissionMaintenanceBackup(intent.backup,{installId:state.id,home:state.layout.home,bindingSha256:intent.bindingSha256})
 const audit=await maintenanceAudit(intent,receipt,snapshot)
 const pool=await databasePool(state)
 try{
  if(intent.cancelNotPublished){
   const rows=(await pool.query('select r.state,a.request_id,a.audit,a.receipt from teloa_task_runs r join teloa_task_run_unpublished_cancellations a on a.owner_id=r.owner_id and a.run_id=r.id where r.owner_id=$1 and r.id=$2',[intent.binding.run.owner,intent.binding.run.runId])).rows
   if(rows.length!==1||rows[0].state!=='withdrawn'||rows[0].request_id!==intent.requestId||rows[0].receipt?.schema!=='teloa.task-run-unpublished-cancellation/v1'||rows[0].receipt.requestId!==intent.requestId||!isDeepStrictEqual(rows[0].audit,audit))throw denied()
  }else{
  const rows=(await pool.query('select r.state,r.submission_disposition,a.request_id,a.audit,a.disposition from teloa_task_runs r join teloa_task_run_maintenance_dispositions a on a.owner_id=r.owner_id and a.run_id=r.id where r.owner_id=$1 and r.id=$2',[intent.binding.run.owner,intent.binding.run.runId])).rows
  if(rows.length!==1||rows[0].state!=='submission_unknown'||rows[0].request_id!==intent.requestId||rows[0].submission_disposition?.requestId!==intent.requestId||!isDeepStrictEqual(rows[0].audit,audit)||!isDeepStrictEqual(rows[0].disposition,rows[0].submission_disposition))throw denied()
  }
 }finally{await pool.end()}
 guard();const stopped:InstallState={...state,phase:'stopped'};await durableInstall(stopped);return stopped
}
