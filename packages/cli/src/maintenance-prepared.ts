import {randomUUID,createHash} from 'node:crypto'
import {readFile,lstat,open} from 'node:fs/promises'
import {readFileSync,lstatSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {isDeepStrictEqual} from 'node:util'
import type {InstallState,ReleaseManifest} from './contracts.ts'
import {canUseData,canUpgradeData} from './data-version.ts'
import {readPrivateJson,writePrivateJson,writeInstall} from './state.ts'
import {databasePool,databaseConfig,localConnection,prepareDatabase} from './database.ts'
import {verifyRelease,stageRelease} from './releases.ts'
import {resolveLayout,exactVersion} from './layout.ts'
import {controlRequest} from './service.ts'
import {withReleaseModule} from './release-modules.ts'
import {assertPreparedMaintenanceDatabase,createPreparedMaintenanceBackup,verifySubmissionMaintenanceBackup} from './maintenance.ts'
import {maintenanceHelper,maintenanceDigest,captureMaintenanceProcesses,assertMaintenanceExited,stopForSubmissionMaintenance,type MaintenanceProcesses,type MaintenanceProcessReceipt} from './maintenance-process.ts'

export const preparedMaintenanceNotice='仅保全具名且确定未提交的准备执行。原宿主将通过正式工作暂停和认证进程世代退出；原任务、会话、输入及请求保持。专用备份仅属于原安装；完成后仍停止，本人须在原工作恢复入口重新核对资料并明确继续，不自动调用模型。'
type Run={owner:string;runId:string;taskId:string;sessionId:string;nativeRequestId:string;inputSha256:string;runtimeId:string|null;agentPresetId:string;controlId:string}
type Intent={schema:'teloa.prepared-maintenance-intent/v1';requestId:string;installId:string;home:string;homeDevice:number;homeInode:number;database:{endpoint:string;systemIdentifier:string};sourceVersion:string;sourceManifestSha256:string;targetVersion:string;targetManifestSha256:string;run:Run;processes:MaintenanceProcesses;profileHashes:Record<string,string>;pause:PauseRequest;adoptedPause?:AdoptedPause;backup:string}
type Pause={id:string;generation:number;version:number;state:string}
type PauseRequest={requestId:string;controlId:string;expectedVersion:number;action:'pause';scope:'round';roundControlId:null}
type AdoptedPause={result:Pause;settledVersion:number}
type PauseSelection={request:PauseRequest;adopted?:AdoptedPause}
type PauseReader={query:(sql:string,args?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>}
type Native={schema:string;original:{snapshotSha256:string;fileSha256:string};files:{path:string;sha256:string;bytes:number}[];allInboxesEmpty:true;noOpenTurnOrTool:true}
// 发行模块是独立编译边界；只声明本命令消费的结构端口，不把其他仓的 src 纳入 CLI composite。
type RunReservation={ownerId:string;sessionId:string;requestId?:string;purpose?:string;status:string;run?:{taskId:string;taskVersion:number;roleId:string|null;roleVersion:number|null;agentPresetId:string}}
type ConversationModule={FileConversationRepository:new(path:string)=>{read():Promise<RunReservation[]>}}
type NativeInspectionModule={inspectPreparedMaintenanceNative(input:{dshHome:string;expectedCwd:string;sessionId:string;agentPresetId:string}):Promise<Native>}
type PreservationAudit={schema:'teloa.prepared-maintenance/v1';requestId:string;installId:string;ownerId:string;runId:string;taskId:string;sessionId:string;nativeRequestId:string;inputSha256:string;runtimeId:string|null;sourceVersion:string;targetVersion:string;pauseRequestId:string;controlId:string;controlGeneration:number;nativeSnapshotSha256:string;nativeFileSha256:string;processReceiptSha256:string;backupManifestSha256:string}
type PreservationModule={preservePreparedRun(pool:Awaited<ReturnType<typeof databasePool>>,audit:PreservationAudit,proof:{assertCurrent:()=>void},now:string):Promise<void>}
type ExitIssued={schema:'teloa.prepared-maintenance-exit-issued/v1';bindingSha256:string;startedAt:string;issuedAt:string;activity:0;deferredSealed:true}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const denied=()=>Error('具名准备执行的维护身份、暂停或停发证明不完整，保持维护；不会重发、换任务或自动执行。')
/** prepared 保全自数据4具备完整来源；跨数据版本仍只走已声明且有专用备份的迁移。 */
export function assertPreparedMaintenanceData(source:ReleaseManifest,candidate:ReleaseManifest):void{
 if(source.dataVersion<4||!canUseData(source,source.dataVersion)||!canUpgradeData(candidate,source.dataVersion))throw denied()
}
const paths=(s:InstallState)=>Object.fromEntries(['intent','pause','exit','exit-issued','native','complete'].map(k=>[k,join(s.layout.instanceRoot,'prepared-maintenance-'+k+'.json')])) as Record<'intent'|'pause'|'exit'|'exit-issued'|'native'|'complete',string>
/** 先持久化 quiesce/sealed 的发送边界，再允许认证退出；重入不能事后补造期限证明。 */
export function assertPreparedExitWindow(value:unknown,receipt:Pick<MaintenanceProcessReceipt,'bindingSha256'|'observedAt'>,bindingSha256:string):void{
 const row=value as ExitIssued|undefined,started=Date.parse(row?.startedAt??''),issued=Date.parse(row?.issuedAt??''),observed=Date.parse(receipt.observedAt)
 if(!row||row.schema!=='teloa.prepared-maintenance-exit-issued/v1'||row.bindingSha256!==bindingSha256||receipt.bindingSha256!==bindingSha256||row.activity!==0||row.deferredSealed!==true||![started,issued,observed].every(Number.isFinite)||issued<started||issued>started+5000||observed<issued||observed>=started+28_000)throw denied()
}
async function optional(path:string){try{return await readPrivateJson(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}}
async function durable(path:string,value:unknown){await writePrivateJson(path,value);const h=await open(dirname(path),'r');try{await h.sync()}finally{await h.close()}}
const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
function installationLease(state:InstallState){const path=join(state.layout.home,'install.lock'),value=JSON.parse(readFileSync(path,'utf8'));if(value.pid!==process.pid||typeof value.identity!=='string')throw denied();return()=>{if(!isDeepStrictEqual(JSON.parse(readFileSync(path,'utf8')),value))throw denied()}}
async function databaseIdentity(state:InstallState,pool:Awaited<ReturnType<typeof databasePool>>){const cfg=await readPrivateJson(databaseConfig(state)) as {connectionString:string},url=localConnection(cfg.connectionString),id=(await pool.query('select system_identifier::text as id from pg_control_system()')).rows[0]?.id;if(typeof id!=='string'||!/^\d+$/.test(id))throw denied();return {endpoint:url.protocol+'//'+url.hostname+':'+(url.port||'5432')+url.pathname,systemIdentifier:id}}
async function fixedProfile(state:InstallState,sourceRoot:string){
 const yaml=createRequire(join(sourceRoot,'package.json'))('yaml') as {parse:(text:string)=>unknown},directory=join(state.layout.dshHome,'profiles/teloa'),names=['package.json','cordis.yml','cordis.patch.yml'],bytes=await Promise.all(names.map(name=>readFile(join(directory,name))))
 const pkg=JSON.parse(bytes[0]!.toString()),base=yaml.parse(bytes[1]!.toString()),patch=yaml.parse(bytes[2]!.toString())
 const bundles=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@deepseek-ai/dsh-experimental-agent-team-profile','@teloa/bundle','@teloa/im-gateway','@deepseek-ai/dsh-experimental-voice-input-bundle','@deepseek-ai/dsh-experimental-auto-review']
 if(!isDeepStrictEqual(pkg.dsh?.profile?.bundles,bundles)||!isDeepStrictEqual(base,[])||!Array.isArray(patch)||patch.some(row=>!row||typeof row!=='object'||!['@deepseek-ai/dsh-llm-pi-ai','@deepseek-ai/dsh-agent-default-model'].includes(row.name)||row.disabled===true)||new Set(patch.map(row=>row.name)).size!==patch.length)throw Error('此具名维护仅支持固定默认原生模块；自定义配置需先按其正式收口流程处理。')
 const channelsPath=join(state.layout.runtimeRoot,'im-gateway/channels.json'),channels=await optional(channelsPath) as {channels?:Array<{enabled?:unknown}>}|undefined
 if(channels!==undefined&&(!isDeepStrictEqual(Object.keys(channels),['channels'])||!Array.isArray(channels.channels)||channels.channels.some(row=>row?.enabled!==false)))throw Error('此具名维护不支持启用或状态不明的外部渠道，请先按原渠道正式收口。')
 return {...Object.fromEntries(names.map((name,index)=>[name,maintenanceDigest(bytes[index]!)])),channels:channels===undefined?'absent':maintenanceDigest(await readFile(channelsPath))}
}
async function readRun(state:InstallState,pool:Awaited<ReturnType<typeof databasePool>>,runId:string,release:ReleaseManifest):Promise<Run>{
 const marker=(await pool.query('select id,data_version from teloa_installation')).rows;if(marker.length!==1||marker[0].id!==state.id||!canUseData(release,marker[0].data_version))throw denied()
 const r=(await pool.query('select * from teloa_task_runs where id=$1',[runId])).rows[0]
 if(!r||r.state!=='prepared'||r.evidence!==null||r.stop_requested_at!==null||typeof r.agent_preset_id!=='string')throw denied()
 const input=JSON.parse(r.input_text),lineage=input.lineage;if(!uuid(r.role_id)||input.schema!=='teloa.task-run-input/v2'||!lineage||!uuid(lineage.roundControlId)||lineage.definitionControlId!==null)throw denied()
 const links=(await pool.query('select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2',[r.owner_id,runId])).rows,link=links[0]
 if(links.length>1||links.length===1&&(link.kind!=='job'||link.payload?.record!=='owner'||!uuid(link.payload.runtimeId)||link.session_id!==r.session_id||link.payload.requestId!==r.native_request_id||link.native_id!=='owner:'+link.payload.runtimeId+':'+r.session_id))throw denied()
 const stored=await withReleaseModule(state.layout.releaseRoot,'packages/backend/lib/work/conversations.js',async value=>{const api=value as ConversationModule;if(typeof api.FileConversationRepository!=='function')throw denied();return new api.FileConversationRepository(join(state.layout.runtimeRoot,'conversations.json')).read()})
 const reservations=stored.filter(row=>row.ownerId===r.owner_id&&row.sessionId===r.session_id&&row.requestId===r.request_id),reservation=reservations[0],reserved=reservation?.run as Record<string,unknown>|undefined
 if(reservations.length!==1||reservation?.purpose!=='task-run'||reservation.status!=='ready'||!reserved||reserved.taskId!==r.task_id||reserved.taskVersion!==r.task_version||reserved.roleId!==r.role_id||reserved.roleVersion!==r.role_version||reserved.agentPresetId!==r.agent_preset_id)throw denied()
 await assertPreparedMaintenanceDatabase(pool,{owner:r.owner_id,runId})
 return {owner:r.owner_id,runId,taskId:r.task_id,sessionId:r.session_id,nativeRequestId:r.native_request_id,inputSha256:digest(r.input_text),runtimeId:link?.payload.runtimeId??null,agentPresetId:r.agent_preset_id,controlId:lineage.roundControlId}
}
/** prepareDatabase 的内部专用证明；不使用 submitting 的 intent，也不接受客户端提供的备份例外。 */
export async function verifyPreparedMaintenanceMigration(state:InstallState,backup:string){
 const lease=installationLease(state),p=paths(state),intent=await readPrivateJson(p.intent) as Intent
 if(state.phase!=='maintenance'||intent.schema!=='teloa.prepared-maintenance-intent/v1'||intent.installId!==state.id||intent.home!==state.layout.home||intent.targetVersion!==state.version||intent.sourceVersion===intent.targetVersion||!uuid(intent.requestId)||backup!==intent.backup||backup!==state.layout.home+'.backups/prepared-'+intent.requestId)throw denied()
 const sourceState={...state,version:intent.sourceVersion,layout:await resolveLayout({home:state.layout.home,workspace:state.layout.workspaceRoot,version:intent.sourceVersion})},source=await verifyRelease(sourceState.layout.releaseRoot),candidate=await verifyRelease(state.layout.releaseRoot)
 assertPreparedMaintenanceData(source,candidate)
 if(source.version!==intent.sourceVersion||candidate.version!==intent.targetVersion||maintenanceDigest(await readFile(join(sourceState.layout.releaseRoot,'release-manifest.json')))!==intent.sourceManifestSha256||maintenanceDigest(JSON.stringify(candidate))!==intent.targetManifestSha256)throw denied()
 const guard=()=>{lease();const current=JSON.parse(readFileSync(join(state.layout.instanceRoot,'state.json'),'utf8')),home=lstatSync(state.layout.home);if(current.id!==state.id||current.phase!=='maintenance'||current.version!==intent.targetVersion||!isDeepStrictEqual(current.layout,state.layout)||home.isSymbolicLink()||home.dev!==intent.homeDevice||home.ino!==intent.homeInode||!isDeepStrictEqual(JSON.parse(readFileSync(p.intent,'utf8')),intent))throw denied()}
 guard()
 const receipt=await readPrivateJson(p.exit) as MaintenanceProcessReceipt,native=await readPrivateJson(p.native) as Native,pause=await readPrivateJson(p.pause) as Pause,bindingSha=maintenanceDigest(JSON.stringify(intent))
 assertPreparedExitWindow(await readPrivateJson(p['exit-issued']),receipt,bindingSha)
 await assertMaintenanceExited(sourceState,await maintenanceHelper(state.layout.releaseRoot),intent.processes,receipt,bindingSha)
 if(!isDeepStrictEqual(await fixedProfile(sourceState,state.layout.releaseRoot),intent.profileHashes))throw denied()
 const actualNative=await withReleaseModule(sourceState.layout.releaseRoot,'packages/harness-dsh/lib/prepared-maintenance-inspection.js',async value=>{const api=value as NativeInspectionModule;if(typeof api.inspectPreparedMaintenanceNative!=='function')throw denied();return api.inspectPreparedMaintenanceNative({dshHome:state.layout.dshHome,expectedCwd:state.layout.workspaceRoot,sessionId:intent.run.sessionId,agentPresetId:intent.run.agentPresetId})})
 if(!isDeepStrictEqual(native,actualNative))throw denied()
 const pool=await databasePool(sourceState)
 try{
  if(!isDeepStrictEqual(await databaseIdentity(sourceState,pool),intent.database)||!isDeepStrictEqual(await readRun(sourceState,pool,intent.run.runId,source),intent.run))throw denied()
  const original=(await pool.query('select spec,result from teloa_work_control_requests where owner_id=$1 and request_id=$2',[intent.run.owner,intent.pause.requestId])).rows[0]
  if(!original||!isDeepStrictEqual(original.spec,intent.pause)||!isDeepStrictEqual(original.result,pause)||pause.id!==intent.run.controlId||pause.state!=='pausing')throw denied()
 }finally{await pool.end()}
 const manifest=await verifySubmissionMaintenanceBackup(backup,{installId:state.id,home:state.layout.home,bindingSha256:bindingSha}),saved=await readPrivateJson(join(backup,'maintenance-receipt.json'))
 if(manifest.version!==intent.sourceVersion||!canUseData(source,manifest.dataVersion)||!isDeepStrictEqual(saved,{intent,processReceipt:receipt,native,bindingSha256:bindingSha}))throw denied()
 guard();return manifest
}
/** 只采用同安装原Run当前世代的正式本人暂停；外部声明或本地回执不能代替数据库来源。 */
export async function readPreparedMaintenancePause(db:PauseReader,run:Pick<Run,'owner'|'runId'|'taskId'|'controlId'>,expected?:PauseSelection):Promise<PauseSelection>{
 const rows=(await db.query(`select c.id,c.owner_id,c.kind,c.root_task_id,c.state,c.version,c.generation,c.pause_origin,
  l.owner_id as lineage_owner_id,l.task_id as lineage_task_id,l.root_task_id as lineage_root_task_id,l.definition_control_id,l.round_control_id,
  p.owner_id as progress_owner_id,p.control_id as progress_control_id,p.generation as progress_generation,p.pending_run_ids,p.unknown_operation_ids,
  q.owner_id as request_owner_id,q.request_id,q.control_id as request_control_id,q.spec,q.result
  from teloa_work_controls c join teloa_task_work_lineage l on l.owner_id=c.owner_id and l.round_control_id=c.id
  left join teloa_work_control_progress p on p.owner_id=c.owner_id and p.control_id=c.id
  left join teloa_work_control_requests q on q.owner_id=c.owner_id and q.control_id=c.id and q.result->>'generation'=c.generation::text
  where c.owner_id=$1 and c.id=$2 and l.task_id=$3`,[run.owner,run.controlId,run.taskId])).rows
 if(rows.length!==1)throw denied()
 const row=rows[0]!,positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
 if(row.id!==run.controlId||row.owner_id!==run.owner||row.kind!=='round'||row.lineage_owner_id!==run.owner||row.lineage_task_id!==run.taskId||row.root_task_id!==row.lineage_root_task_id||row.round_control_id!==run.controlId||row.definition_control_id!==null||!positive(row.version)||!positive(row.generation))throw denied()
 if(row.state==='active'){
  if(expected)throw denied()
  return {request:{requestId:randomUUID(),controlId:run.controlId,expectedVersion:row.version,action:'pause',scope:'round',roundControlId:null}}
 }
 const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
 const spec=row.spec,result=row.result
 if(row.state!=='paused'||row.pause_origin!=='owner'||row.progress_owner_id!==run.owner||row.progress_control_id!==run.controlId||row.progress_generation!==row.generation||!Array.isArray(row.pending_run_ids)||row.pending_run_ids.length||!Array.isArray(row.unknown_operation_ids)||row.unknown_operation_ids.length||row.request_owner_id!==run.owner||row.request_control_id!==run.controlId||!uuid(row.request_id)||!record(spec)||!record(result))throw denied()
 const request:PauseRequest={requestId:row.request_id,controlId:run.controlId,expectedVersion:Number(spec.expectedVersion),action:'pause',scope:'round',roundControlId:null}
 if(!positive(spec.expectedVersion)||!isDeepStrictEqual(spec,request)||result.id!==run.controlId||result.ownerId!==run.owner||result.scope!=='round'||result.state!=='pausing'||result.generation!==row.generation||!positive(result.version)||result.version!==request.expectedVersion+1||row.version!==result.version+1||!Array.isArray(result.pendingRunIds)||!result.pendingRunIds.includes(run.runId)||!result.pendingRunIds.every(uuid)||new Set(result.pendingRunIds).size!==result.pendingRunIds.length||!Array.isArray(result.unknownOperationIds)||result.unknownOperationIds.length)throw denied()
 const selected:PauseSelection={request,adopted:{result:result as Pause,settledVersion:row.version}}
 if(expected&&!isDeepStrictEqual(selected,expected))throw denied()
 return selected
}
async function rpc(origin:string,cookie:string,channel:string,method:string,payload:unknown){const rpcId=randomUUID(),response=await fetch(origin+channel+'/'+method,{method:'POST',headers:{'content-type':'application/json',cookie},body:JSON.stringify({type:'client-request',rpcId,method,payload}),signal:AbortSignal.timeout(5000)}),body=await response.json() as {rpcId?:string;result?:{ok?:boolean;value?:unknown}};if(!response.ok||body.rpcId!==rpcId||body.result?.ok!==true)throw denied();return body.result.value}
/** 仅调用方持安装锁后进入。普通 stop / backup / upgrade 不消费此例外。 */
export async function maintainPreparedRun(state:InstallState,input:{runId:string;targetVersion:string;confirm:true;finish?:true;existingTargetOnly?:true},sourceRoot:string):Promise<{state:InstallState;backup:string}>{
 if(!uuid(input.runId)||!exactVersion(input.targetVersion)||input.confirm!==true)throw denied()
 const lease=installationLease(state),candidate=await verifyRelease(sourceRoot),helper=await maintenanceHelper(sourceRoot),p=paths(state)
 if(candidate.version!==input.targetVersion||!canUseData(candidate,candidate.dataVersion)||candidate.dshVersion!=='0.2.1-rc.2')throw denied()
 let intent=await optional(p.intent) as Intent|undefined
 if(input.existingTargetOnly&&(!intent||state.phase!=='maintenance'&&!(input.finish&&state.phase==='stopped')))throw denied()
 if(!intent){
  if(input.finish||state.phase!=='ready'||state.version===input.targetVersion)throw denied()
  const source=await verifyRelease(state.layout.releaseRoot);assertPreparedMaintenanceData(source,candidate);if(source.version!==state.version||source.dshVersion!==candidate.dshVersion)throw denied()
  const profileHashes=await fixedProfile(state,sourceRoot),pool=await databasePool(state);let run:Run,database:Intent['database'],selection:PauseSelection
  try{run=await readRun(state,pool,input.runId,source);database=await databaseIdentity(state,pool);selection=await readPreparedMaintenancePause(pool,run)}finally{await pool.end()}
  const processes=await captureMaintenanceProcesses(state,helper),home=await lstat(state.layout.home),requestId=randomUUID()
  intent={schema:'teloa.prepared-maintenance-intent/v1',requestId,installId:state.id,home:state.layout.home,homeDevice:home.dev,homeInode:home.ino,database,sourceVersion:state.version,sourceManifestSha256:maintenanceDigest(await readFile(join(state.layout.releaseRoot,'release-manifest.json'))),targetVersion:input.targetVersion,targetManifestSha256:maintenanceDigest(JSON.stringify(candidate)),run,processes,profileHashes,pause:selection.request,...(selection.adopted?{adoptedPause:selection.adopted}:{}),backup:state.layout.home+'.backups/prepared-'+requestId};lease();await durable(p.intent,intent);await writeInstall({...state,phase:'maintenance'})
 }
 if(intent.schema!=='teloa.prepared-maintenance-intent/v1'||intent.installId!==state.id||intent.home!==state.layout.home||intent.run.runId!==input.runId||intent.targetVersion!==input.targetVersion||intent.targetManifestSha256!==maintenanceDigest(JSON.stringify(candidate))||![intent.sourceVersion,intent.targetVersion].includes(state.version))throw denied()
 const sourceState={...state,version:intent.sourceVersion,layout:await resolveLayout({home:state.layout.home,workspace:state.layout.workspaceRoot,version:intent.sourceVersion}),phase:'maintenance' as const},bindingSha=maintenanceDigest(JSON.stringify(intent))
 const source=await verifyRelease(sourceState.layout.releaseRoot);assertPreparedMaintenanceData(source,candidate);if(source.version!==intent.sourceVersion||source.dshVersion!==candidate.dshVersion)throw denied()
 const guard=()=>{lease();const current=JSON.parse(readFileSync(join(state.layout.instanceRoot,'state.json'),'utf8')),home=lstatSync(state.layout.home),control=JSON.parse(readFileSync(join(state.layout.instanceRoot,'control.json'),'utf8'));if(current.id!==state.id||current.phase!=='maintenance'&&!(input.finish&&state.phase==='stopped'&&current.phase==='stopped')||current.layout?.home!==intent!.home||current.layout?.workspaceRoot!==state.layout.workspaceRoot||![intent!.sourceVersion,intent!.targetVersion].includes(current.version)||current.layout.releaseRoot!==join(intent!.home,'releases',current.version)||home.isSymbolicLink()||home.dev!==intent!.homeDevice||home.ino!==intent!.homeInode||!isDeepStrictEqual(JSON.parse(readFileSync(p.intent,'utf8')),intent)||['pid','startedAt','nonce','installId','port'].some(key=>Reflect.get(control,key)!==Reflect.get(intent!.processes.control,key)))throw denied()}
 async function databaseCurrent(){guard();const pool=await databasePool(sourceState);try{
  const marker=(await pool.query('select id,data_version from teloa_installation')).rows,current=JSON.parse(readFileSync(join(state.layout.instanceRoot,'state.json'),'utf8'))
  // 写入目标发行之后，迁移前按源读、迁移后按目标读；旧发行本身不能接管目标数据。
  const target=current.version===intent!.targetVersion&&marker.length===1&&canUseData(candidate,marker[0].data_version),reader=target?{...sourceState,version:intent!.targetVersion,layout:await resolveLayout({home:state.layout.home,workspace:state.layout.workspaceRoot,version:intent!.targetVersion})}:sourceState
  if(!isDeepStrictEqual(await databaseIdentity(reader,pool),intent!.database)||!isDeepStrictEqual(await readRun(reader,pool,input.runId,target?candidate:source),intent!.run))throw denied();if(intent!.adoptedPause)await readPreparedMaintenancePause(pool,intent!.run,{request:intent!.pause,adopted:intent!.adoptedPause})
 }finally{await pool.end()}}
 if(maintenanceDigest(await readFile(join(sourceState.layout.releaseRoot,'release-manifest.json')))!==intent.sourceManifestSha256||!isDeepStrictEqual(await fixedProfile(sourceState,sourceRoot),intent.profileHashes))throw denied()
 let receipt=await optional(p.exit) as MaintenanceProcessReceipt|undefined,pause=await optional(p.pause) as Pause|undefined
 if(!receipt){
  // 已派发退出但无回执属于未知，不再发送第二个 fence，也不补造新的时间窗。
  if(await optional(p['exit-issued']))throw denied()
  if(!isDeepStrictEqual(await captureMaintenanceProcesses(sourceState,helper),intent.processes))throw denied()
  const startup=await controlRequest(sourceState,'open') as string,origin='http://127.0.0.1:'+state.port;if(new URL(startup).origin!==origin)throw denied()
  const readiness=await import(pathToFileURL(join(sourceRoot,'scripts/核对宿主就绪.mjs')).href),cookie=await readiness.authorizeSession(startup)
  if(intent.adoptedPause){
   // 已成功的原暂停只读核验后采用；即使intent后尚未落pause文件，也不发送第二次暂停。
   const pool=await databasePool(sourceState);try{const selected=await readPreparedMaintenancePause(pool,intent.run,{request:intent.pause,adopted:intent.adoptedPause}),original=selected.adopted!.result;if(pause&&!isDeepStrictEqual(pause,original))throw denied();if(!pause){pause=original;await durable(p.pause,pause)}}finally{await pool.end()}
  }
  if(!pause){
   const issued=join(state.layout.instanceRoot,'prepared-maintenance-pause-issued.json')
   if(await optional(issued)){const pool=await databasePool(sourceState);try{const row=(await pool.query('select spec,result from teloa_work_control_requests where owner_id=$1 and request_id=$2',[intent.run.owner,intent.pause.requestId])).rows[0];if(!row||!isDeepStrictEqual(row.spec,intent.pause))throw denied();pause=row.result}finally{await pool.end()}}
   else{await durable(issued,{request:intent.pause,runId:input.runId,noNewNonce:true});pause=await rpc(origin,cookie,'/teloa','work-controls/change',intent.pause) as Pause}
   if(!pause||pause.id!==intent.run.controlId||pause.state!=='pausing'||pause.version!==intent.pause.expectedVersion+1)throw denied();await durable(p.pause,pause)
  }
  guard();await databaseCurrent();const startedAt=Date.now();await rpc(origin,cookie,'/teloa-local-runtime','quiesce',{})
  try{
   const activity=await rpc(origin,cookie,'/teloa-local-runtime','activity',{}) as {active?:number};if(activity.active!==0)throw denied()
   await databaseCurrent();await rpc(origin,cookie,'/teloa-local-runtime','sealed',{})
   if(Date.now()-startedAt>5000)throw denied();guard()
   // 不持 PG 行锁等待旧 worker；原 Run 已由同宿主 pause epoch 封住，入站已 quiesce。
   const issued:ExitIssued={schema:'teloa.prepared-maintenance-exit-issued/v1',bindingSha256:bindingSha,startedAt:new Date(startedAt).toISOString(),issuedAt:new Date().toISOString(),activity:0,deferredSealed:true};await durable(p['exit-issued'],issued)
   receipt=await stopForSubmissionMaintenance(helper,intent.processes,p.exit,bindingSha)
   assertPreparedExitWindow(issued,receipt,bindingSha)
  }catch(error){if(!await optional(p['exit-issued']))await rpc(origin,cookie,'/teloa-local-runtime','resume',{}).catch(()=>{});throw error}
 }
 assertPreparedExitWindow(await optional(p['exit-issued']),receipt,bindingSha)
 if(!pause)throw denied();guard();await assertMaintenanceExited(sourceState,helper,intent.processes,receipt,bindingSha);await databaseCurrent()
 if(!isDeepStrictEqual(await fixedProfile(sourceState,sourceRoot),intent.profileHashes))throw denied()
 const native=await withReleaseModule(sourceRoot,'packages/harness-dsh/lib/prepared-maintenance-inspection.js',async value=>{const api=value as NativeInspectionModule;if(typeof api.inspectPreparedMaintenanceNative!=='function')throw denied();return api.inspectPreparedMaintenanceNative({dshHome:state.layout.dshHome,expectedCwd:state.layout.workspaceRoot,sessionId:intent.run.sessionId,agentPresetId:intent.run.agentPresetId})})
 const savedNative=await optional(p.native);if(savedNative&&!isDeepStrictEqual(savedNative,native))throw denied();if(!savedNative)await durable(p.native,native)
 const stopped=async()=>{guard();await assertMaintenanceExited(sourceState,helper,intent!.processes,receipt!,bindingSha);await databaseCurrent()}
 if(!await optional(join(intent.backup,'backup-manifest.json')))await createPreparedMaintenanceBackup(sourceState,intent.backup,{bindingSha256:bindingSha,receipt:{intent,processReceipt:receipt,native},assertCurrent:stopped})
 await verifySubmissionMaintenanceBackup(intent.backup,{installId:state.id,home:state.layout.home,bindingSha256:bindingSha});await stopped()
 const next={...state,version:input.targetVersion,layout:await resolveLayout({home:state.layout.home,workspace:state.layout.workspaceRoot,version:input.targetVersion}),phase:'maintenance' as const}
 if(state.version!==input.targetVersion){if(input.finish)throw denied();await stageRelease(sourceRoot,next.layout);guard();await writeInstall(next)}
 await prepareDatabase(next,{migrationBackup:intent.backup,preparedMaintenance:true})
 const pool=await databasePool(next)
 try{await withReleaseModule(next.layout.releaseRoot,'packages/backend/lib/work/prepared-maintenance.js',async value=>{const api=value as PreservationModule;if(typeof api.preservePreparedRun!=='function')throw denied();await api.preservePreparedRun(pool,{schema:'teloa.prepared-maintenance/v1',requestId:intent.requestId,installId:state.id,ownerId:intent.run.owner,runId:input.runId,taskId:intent.run.taskId,sessionId:intent.run.sessionId,nativeRequestId:intent.run.nativeRequestId,inputSha256:intent.run.inputSha256,runtimeId:intent.run.runtimeId,sourceVersion:intent.sourceVersion,targetVersion:intent.targetVersion,pauseRequestId:intent.pause.requestId,controlId:intent.run.controlId,controlGeneration:pause.generation,nativeSnapshotSha256:native.original.snapshotSha256,nativeFileSha256:native.original.fileSha256,processReceiptSha256:maintenanceDigest(JSON.stringify(receipt)),backupManifestSha256:maintenanceDigest(await readFile(join(intent.backup,'backup-manifest.json')))},{assertCurrent:guard},new Date().toISOString())})}finally{await pool.end()}
 guard();const completed={requestId:intent.requestId,runId:input.runId,version:input.targetVersion,bindingSha256:bindingSha,keptPrepared:true},previousComplete=await optional(p.complete);if(previousComplete&&!isDeepStrictEqual(previousComplete,completed))throw denied();if(!previousComplete)await durable(p.complete,completed)
 if(input.finish){const finished={...next,phase:'stopped' as const};await writeInstall(finished);return {state:finished,backup:intent.backup}}
 return {state:next,backup:intent.backup}
}
