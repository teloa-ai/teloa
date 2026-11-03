import {randomUUID,createHash} from 'node:crypto'
import {readFile,lstat,open,mkdir} from 'node:fs/promises'
import {readFileSync,lstatSync,constants,type Stats} from 'node:fs'
import {join,dirname} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {isDeepStrictEqual} from 'node:util'
import type {InstallState,ReleaseManifest} from './contracts.ts'
import {canUseData,canUpgradeData} from './data-version.ts'
import {readPrivateJson,writePrivateJson,writeInstall,privateDirectory} from './state.ts'
import {databasePool,databaseConfig,localConnection,prepareDatabase,ownContainer} from './database.ts'
import {verifyRelease,stageRelease} from './releases.ts'
import {resolveLayout,exactVersion} from './layout.ts'
import {controlRequest} from './service.ts'
import {withReleaseModule} from './release-modules.ts'
import {assertPreparedMaintenanceDatabase,createPreparedMaintenanceBackup,verifySubmissionMaintenanceBackup} from './maintenance.ts'
import {maintenanceHelper,maintenanceDigest,captureMaintenanceProcesses,assertMaintenanceExited,verifyMaintenanceProcessReceipt,inspectMaintenanceProcess,stopForSubmissionMaintenance,type MaintenanceProcesses,type MaintenanceProcessReceipt} from './maintenance-process.ts'

export const preparedMaintenanceNotice='仅保全具名且确定未提交的准备执行。原宿主将通过正式工作暂停和认证进程世代退出；原任务、会话、输入及请求保持。专用备份仅属于原安装；完成后仍停止，本人须在原工作恢复入口重新核对资料并明确继续，不自动调用模型。'
type Run={owner:string;runId:string;taskId:string;sessionId:string;nativeRequestId:string;inputSha256:string;runtimeId:string|null;agentPresetId:string;controlId:string}
type PreviousAudit={requestId:string;auditSha256:string}
type Intent={schema:'teloa.prepared-maintenance-intent/v1';requestId:string;installId:string;home:string;homeDevice:number;homeInode:number;database:{endpoint:string;systemIdentifier:string};sourceVersion:string;sourceManifestSha256:string;targetVersion:string;targetManifestSha256:string;run:Run;processes:MaintenanceProcesses;profileHashes:Record<string,string>;pause:PauseRequest;adoptedPause?:AdoptedPause;previousPreparedAudit?:PreviousAudit;backup:string}
type Pause={id:string;generation:number;version:number;state:string}
type PauseRequest={requestId:string;controlId:string;expectedVersion:number;action:'pause';scope:'round';roundControlId:null}
type AdoptedPause={result:Pause;settledVersion:number}
type PauseSelection={request:PauseRequest;adopted?:AdoptedPause}
type PauseReader={query:(sql:string,args?:unknown[])=>Promise<{rows:Record<string,unknown>[]}>}
type Native={schema:string;original:{snapshotSha256:string;fileSha256:string};files:{path:string;sha256:string;bytes:number}[];allInboxesEmpty:true;noOpenTurnOrTool:true}
// 发行模块是独立编译边界；只声明本命令消费的结构端口，不把其他仓的 src 纳入 CLI composite。
type RunReservation={id?:string;ownerId:string;sessionId:string;requestId?:string;purpose?:string;status:string;run?:{taskId:string;taskVersion:number;roleId:string|null;roleVersion:number|null;agentPresetId:string}}
type ConversationModule={FileConversationRepository:new(path:string)=>{read():Promise<RunReservation[]>}}
type NativeInspectionModule={inspectPreparedMaintenanceNative(input:{dshHome:string;expectedCwd:string;sessionId:string;agentPresetId:string}):Promise<Native>}
type PreservationAudit={schema:'teloa.prepared-maintenance/v1';requestId:string;installId:string;ownerId:string;runId:string;taskId:string;sessionId:string;nativeRequestId:string;inputSha256:string;runtimeId:string|null;sourceVersion:string;targetVersion:string;pauseRequestId:string;controlId:string;controlGeneration:number;nativeSnapshotSha256:string;nativeFileSha256:string;processReceiptSha256:string;backupManifestSha256:string}
type AuditRow={request_id:unknown;audit:unknown;resume?:unknown}
type AuditReader=(db:PauseReader,owner:string,runId:string)=>Promise<AuditRow|undefined>
type PreservationModule={preservePreparedRun(pool:Awaited<ReturnType<typeof databasePool>>,audit:PreservationAudit,proof:{assertCurrent:()=>void},now:string,previous?:PreviousAudit):Promise<void>;readPreparedMaintenance:AuditReader}
type ExitIssued={schema:'teloa.prepared-maintenance-exit-issued/v1';bindingSha256:string;startedAt:string;issuedAt:string;activity:0;deferredSealed:true}
type CyclePointer={schema:'teloa.prepared-maintenance-current/v1';requestId:string;previousRequestId:string;previousBindingSha256:string}
type CyclePaths=Record<'intent'|'pause'|'exit'|'exit-issued'|'native'|'complete'|'pause-issued',string>&{assertCurrent:()=>void}
const completedCycles=new WeakMap<object,{intent:string;samePreparedRun:boolean;previous:PreviousAudit}>()
// CLI与发行后端是独立编译边界；前一审计摘要采用相同的JSON键序无关编码。
const auditDigest=(value:unknown)=>maintenanceDigest(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item))
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const denied=()=>Error('具名准备执行的维护身份、暂停或停发证明不完整，保持维护；不会重发、换任务或自动执行。')
/** prepared 保全自数据4具备完整来源；跨数据版本仍只走已声明且有专用备份的迁移。 */
export function assertPreparedMaintenanceData(source:ReleaseManifest,candidate:ReleaseManifest):void{
 if(source.dataVersion<4||!canUseData(source,source.dataVersion)||!canUpgradeData(candidate,source.dataVersion))throw denied()
}
function cyclePaths(root:string,assertCurrent:()=>void):CyclePaths{return {...Object.fromEntries(['intent','pause','exit','exit-issued','native','complete','pause-issued'].map(k=>[k,join(root,'prepared-maintenance-'+k+'.json')])),assertCurrent} as CyclePaths}
async function paths(s:InstallState):Promise<CyclePaths>{
 const file=join(s.layout.instanceRoot,'prepared-maintenance-current.json'),pointer=await optional(file) as CyclePointer|undefined
 if(pointer!==undefined&&(Object.keys(pointer).sort().join(',')!=='previousBindingSha256,previousRequestId,requestId,schema'||pointer.schema!=='teloa.prepared-maintenance-current/v1'||!uuid(pointer.requestId)||!uuid(pointer.previousRequestId)||pointer.requestId===pointer.previousRequestId||!/^[a-f0-9]{64}$/.test(pointer.previousBindingSha256)))throw denied()
 const assertCurrent=()=>{let current:unknown;try{const info=lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077))throw denied();current=JSON.parse(readFileSync(file,'utf8'))}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}if(!isDeepStrictEqual(current,pointer))throw denied()}
 const result=cyclePaths(pointer?join(s.layout.instanceRoot,'prepared-maintenance-cycles',pointer.requestId):s.layout.instanceRoot,assertCurrent)
 if(pointer){const intent=await optional(result.intent) as Intent|undefined;if(intent?.requestId!==pointer.requestId)throw denied()}
 return result
}
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
type CompletedDatabaseInput={installId:string;database:Intent['database'];currentConnection:string;backupConnection:string;container:unknown}
/** 仅已完成旧周期容许自有Docker重映射端口；备份配置、实际数据库/角色/public命名空间仍固定。 */
export async function assertCompletedPreparedDatabase(db:PauseReader,input:CompletedDatabaseInput):Promise<void>{
 if(!uuid(input.installId)||typeof input.currentConnection!=='string'||typeof input.backupConnection!=='string'||!/^\d+$/.test(input.database.systemIdentifier))throw denied()
 const current=localConnection(input.currentConnection),previous=localConnection(input.backupConnection),endpoint=(url:URL)=>url.protocol+'//'+url.hostname+':'+(url.port||'5432')+url.pathname
 if(endpoint(previous)!==input.database.endpoint||current.protocol!==previous.protocol||current.hostname!==previous.hostname||current.pathname!==previous.pathname||!previous.username||current.username!==previous.username||(current.port||'5432')===(previous.port||'5432'))throw denied()
 const container=input.container as {Config?:{Labels?:Record<string,unknown>};NetworkSettings?:{Ports?:Record<string,unknown>}}|null
 const bindings=container?.NetworkSettings?.Ports?.['5432/tcp']
 if(container?.Config?.Labels?.['ai.teloa.install']!==input.installId||!Array.isArray(bindings)||bindings.length!==1||bindings[0]?.HostIp!=='127.0.0.1'||bindings[0]?.HostPort!==(current.port||'5432'))throw denied()
 const rows=(await db.query("select pg_catalog.current_database() as database,pg_catalog.current_schema() as schema,pg_catalog.to_json(pg_catalog.current_schemas(false)) as schemas,current_user as username,session_user as session_username,(select system_identifier::text from pg_catalog.pg_control_system()) as system_identifier,pg_catalog.to_regclass('teloa_installation')=pg_catalog.to_regclass('public.teloa_installation') as public_marker_resolved")).rows,row=rows[0],username=decodeURIComponent(current.username)
 if(rows.length!==1||row!.database!==decodeURIComponent(current.pathname.slice(1))||row!.schema!=='public'||!isDeepStrictEqual(row!.schemas,['public'])||row!.username!==username||row!.session_username!==username||row!.system_identifier!==input.database.systemIdentifier||row!.public_marker_resolved!==true)throw denied()
 const marker=(await db.query('select id from public.teloa_installation')).rows
 if(marker.length!==1||marker[0]!.id!==input.installId)throw denied()
}
async function fixedProfile(state:InstallState,sourceRoot:string){
 const yaml=createRequire(join(sourceRoot,'package.json'))('yaml') as {parse:(text:string)=>unknown},directory=join(state.layout.dshHome,'profiles/teloa'),names=['package.json','cordis.yml','cordis.patch.yml'],bytes=await Promise.all(names.map(name=>readFile(join(directory,name))))
 const pkg=JSON.parse(bytes[0]!.toString()),base=yaml.parse(bytes[1]!.toString()),patch=yaml.parse(bytes[2]!.toString())
 const bundles=['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@deepseek-ai/dsh-experimental-agent-team-profile','@teloa/bundle','@teloa/im-gateway','@deepseek-ai/dsh-experimental-voice-input-bundle','@deepseek-ai/dsh-experimental-auto-review']
 if(!isDeepStrictEqual(pkg.dsh?.profile?.bundles,bundles)||!isDeepStrictEqual(base,[])||!Array.isArray(patch)||patch.some(row=>!row||typeof row!=='object'||!['@deepseek-ai/dsh-llm-pi-ai','@deepseek-ai/dsh-agent-default-model'].includes(row.name)||row.disabled===true)||new Set(patch.map(row=>row.name)).size!==patch.length)throw Error('此具名维护仅支持固定默认原生模块；自定义配置需先按其正式收口流程处理。')
 const channelsPath=join(state.layout.runtimeRoot,'im-gateway/channels.json'),channels=await optional(channelsPath) as {channels?:Array<{enabled?:unknown}>}|undefined
 if(channels!==undefined&&(!isDeepStrictEqual(Object.keys(channels),['channels'])||!Array.isArray(channels.channels)||channels.channels.some(row=>row?.enabled!==false)))throw Error('此具名维护不支持启用或状态不明的外部渠道，请先按原渠道正式收口。')
 return {...Object.fromEntries(names.map((name,index)=>[name,maintenanceDigest(bytes[index]!)])),channels:channels===undefined?'absent':maintenanceDigest(await readFile(channelsPath))}
}
type ReservationRun={id:string;owner_id:string;request_id:string;task_id:string;role_id:string;task_version:number;role_version:number;session_id:string;link_version:number;agent_preset_id:string;request_spec:Record<string,unknown>}
type HandoffParty={kind:'self'}|{kind:'role';roleId:string;roleVersion:number}
type HandoffChange={taskId:string;baseVersion:number;appliedVersion:number;from:HandoffParty;to:HandoffParty}
/** 历史预约只兼容已明确拒绝且没有产生Run的原prepare；不能给任意旧会话补授权。 */
export async function assertPreparedRunReservation(db:PauseReader,r:ReservationRun,stored:RunReservation[],readHandoff:(row:Record<string,unknown>)=>HandoffChange):Promise<void>{
 const reservations=stored.filter(row=>row.sessionId===r.session_id),reservation=reservations[0],reserved=reservation?.run
 if(reservations.length!==1||reservation?.ownerId!==r.owner_id||reservation.purpose!=='task-run'||reservation.status!=='ready'||!reserved||reserved.taskId!==r.task_id||reserved.roleId!==r.role_id||reserved.agentPresetId!==r.agent_preset_id)throw denied()
 if(reservation.requestId===r.request_id&&reserved.taskVersion===r.task_version&&reserved.roleVersion===r.role_version)return
 const spec=r.request_spec,positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
 if(!uuid(reservation.requestId)||reservation.sessionId!=='task-run-'+reservation.requestId||reservation.requestId===r.request_id||!positive(reserved.taskVersion)||!positive(reserved.roleVersion)||reserved.taskVersion>r.task_version||reserved.roleVersion>r.role_version||spec.requestId!==r.request_id||spec.taskId!==r.task_id||spec.expectedTaskVersion!==r.task_version||spec.roleId!==r.role_id||spec.expectedRoleVersion!==r.role_version||spec.sessionId!==r.session_id||spec.expectedLinkVersion!==r.link_version||spec.sourceFollowup!==undefined)throw denied()
 const rejected=(await db.query('select owner_id,request_id,endpoint,request_spec,state from teloa_pending_request_registry where owner_id=$1 and request_id=$2',[r.owner_id,reservation.requestId])).rows
 if(rejected.length!==1||rejected[0]!.owner_id!==r.owner_id||rejected[0]!.request_id!==reservation.requestId||rejected[0]!.endpoint!=='task-runs/prepare'||rejected[0]!.state!=='rejected')throw denied()
 const original=rejected[0]!.request_spec as Record<string,unknown>|undefined
 if(!original||original.requestId!==reservation.requestId||original.taskId!==r.task_id||original.expectedTaskVersion!==reserved.taskVersion||original.sessionId!==undefined&&original.sessionId!==r.session_id||original.roleId!==undefined&&original.roleId!==reserved.roleId||original.expectedRoleVersion!==undefined&&original.expectedRoleVersion!==reserved.roleVersion)throw denied()
 // 任何其它Run（含其它owner/Task或未知提交）都不能借这条“从未提交”预约。
 const runs=(await db.query('select id,owner_id,task_id,request_id from teloa_task_runs where session_id=$1',[r.session_id])).rows
 if(runs.length!==1||runs[0]!.id!==r.id||runs[0]!.owner_id!==r.owner_id||runs[0]!.task_id!==r.task_id||runs[0]!.request_id!==r.request_id)throw denied()
 const links=(await db.query("select * from teloa_object_conversations where owner_id=$1 and kind='task' and object_id=$2 and session_id=$3",[r.owner_id,r.task_id,r.session_id])).rows,l=links[0]
 if(links.length!==1||l!.active!==true||l!.source_only!==false||l!.conversation_id!==reservation.id||l!.version!==r.link_version||!positive(l!.object_version)||l!.object_version<reserved.taskVersion||l!.object_version>r.task_version)throw denied()
 const changes=(await db.query('select * from teloa_task_handoff_changes where owner_id=$1 and task_id=$2 and applied_version>$3 and applied_version<=$4 order by applied_version',[r.owner_id,r.task_id,reserved.taskVersion,r.task_version])).rows
 let party:HandoffParty={kind:'role',roleId:r.role_id,roleVersion:reserved.roleVersion},version=reserved.taskVersion
 for(const row of changes){const change=readHandoff(row);if(change.taskId!==r.task_id||change.baseVersion<version||change.appliedVersion!==change.baseVersion+1||change.appliedVersion>r.task_version||!isDeepStrictEqual(change.from,party)||change.to.kind!=='role'||change.to.roleId!==r.role_id||change.to.roleVersion<party.roleVersion)throw denied();party=change.to;version=change.appliedVersion}
 if(!isDeepStrictEqual(party,{kind:'role',roleId:r.role_id,roleVersion:r.role_version}))throw denied()
}
async function readRun(state:InstallState,pool:Awaited<ReturnType<typeof databasePool>>,runId:string,release:ReleaseManifest):Promise<Run>{
 const marker=(await pool.query('select id,data_version from teloa_installation')).rows;if(marker.length!==1||marker[0].id!==state.id||!canUseData(release,marker[0].data_version))throw denied()
 const r=(await pool.query('select * from teloa_task_runs where id=$1',[runId])).rows[0]
 if(!r||r.state!=='prepared'||r.evidence!==null||r.stop_requested_at!==null||typeof r.agent_preset_id!=='string')throw denied()
 await withReleaseModule(state.layout.releaseRoot,'packages/backend/lib/work/task-runs.js',async value=>{const api=value as {readStoredTaskRun:(row:Record<string,unknown>)=>unknown};if(typeof api.readStoredTaskRun!=='function')throw denied();api.readStoredTaskRun(r)})
 const input=JSON.parse(r.input_text),lineage=input.lineage;if(!uuid(r.role_id)||input.schema!=='teloa.task-run-input/v2'||!lineage||!uuid(lineage.roundControlId)||lineage.definitionControlId!==null)throw denied()
 const links=(await pool.query('select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2',[r.owner_id,runId])).rows,link=links[0]
 if(links.length>1||links.length===1&&(link.kind!=='job'||link.payload?.record!=='owner'||!uuid(link.payload.runtimeId)||link.session_id!==r.session_id||link.payload.requestId!==r.native_request_id||link.native_id!=='owner:'+link.payload.runtimeId+':'+r.session_id))throw denied()
 const stored=await withReleaseModule(state.layout.releaseRoot,'packages/backend/lib/work/conversations.js',async value=>{const api=value as ConversationModule;if(typeof api.FileConversationRepository!=='function')throw denied();return new api.FileConversationRepository(join(state.layout.runtimeRoot,'conversations.json')).read()})
 await withReleaseModule(state.layout.releaseRoot,'packages/backend/lib/work/handoffs.js',async value=>{const api=value as {readStoredTaskHandoffChange:(row:Record<string,unknown>)=>HandoffChange};if(typeof api.readStoredTaskHandoffChange!=='function')throw denied();await assertPreparedRunReservation(pool,r,stored,api.readStoredTaskHandoffChange)})
 await assertPreparedMaintenanceDatabase(pool,{owner:r.owner_id,runId})
 return {owner:r.owner_id,runId,taskId:r.task_id,sessionId:r.session_id,nativeRequestId:r.native_request_id,inputSha256:digest(r.input_text),runtimeId:link?.payload.runtimeId??null,agentPresetId:r.agent_preset_id,controlId:lineage.roundControlId}
}
function preservationAudit(intent:Intent,pause:Pause,native:Native,receipt:MaintenanceProcessReceipt,backupManifestSha256:string):PreservationAudit{return {schema:'teloa.prepared-maintenance/v1',requestId:intent.requestId,installId:intent.installId,ownerId:intent.run.owner,runId:intent.run.runId,taskId:intent.run.taskId,sessionId:intent.run.sessionId,nativeRequestId:intent.run.nativeRequestId,inputSha256:intent.run.inputSha256,runtimeId:intent.run.runtimeId,sourceVersion:intent.sourceVersion,targetVersion:intent.targetVersion,pauseRequestId:intent.pause.requestId,controlId:intent.run.controlId,controlGeneration:pause.generation,nativeSnapshotSha256:native.original.snapshotSha256,nativeFileSha256:native.original.fileSha256,processReceiptSha256:maintenanceDigest(JSON.stringify(receipt)),backupManifestSha256}}
/** complete文件不能单独解锁下一周期；必须同数据库不可变审计、终态和已收口提交对应。 */
export async function assertCompletedPreparedMaintenance(db:PauseReader,intent:Intent,complete:unknown,proof:{pause:Pause;native:Native;receipt:MaintenanceProcessReceipt;backupManifestSha256:string},options:{samePreparedRun?:true;readAudit?:AuditReader}={}):Promise<object>{
 const bindingSha256=maintenanceDigest(JSON.stringify(intent))
 if(!uuid(intent.requestId)||!isDeepStrictEqual(complete,{requestId:intent.requestId,runId:intent.run.runId,version:intent.targetVersion,bindingSha256,keptPrepared:true}))throw denied()
 const audits=options.readAudit?[await options.readAudit(db,intent.run.owner,intent.run.runId)].filter((row):row is AuditRow=>!!row):(await db.query('select request_id,audit,resume from teloa_prepared_run_maintenance where owner_id=$1 and run_id=$2',[intent.run.owner,intent.run.runId])).rows
 if(audits.length!==1||audits[0]!.request_id!==intent.requestId||!isDeepStrictEqual(audits[0]!.audit,preservationAudit(intent,proof.pause,proof.native,proof.receipt,proof.backupManifestSha256)))throw denied()
 const runs=(await db.query('select owner_id,id,task_id,session_id,native_request_id,agent_preset_id,input_text,state,evidence,stop_requested_at from teloa_task_runs where owner_id=$1 and id=$2',[intent.run.owner,intent.run.runId])).rows,r=runs[0]
 if(runs.length!==1||r!.owner_id!==intent.run.owner||r!.id!==intent.run.runId||r!.task_id!==intent.run.taskId||r!.session_id!==intent.run.sessionId||r!.native_request_id!==intent.run.nativeRequestId||r!.agent_preset_id!==intent.run.agentPresetId||typeof r!.input_text!=='string'||digest(r!.input_text)!==intent.run.inputSha256)throw denied()
 if(options.samePreparedRun){
  if(r!.state!=='prepared'||r!.evidence!==null||r!.stop_requested_at!==null||audits[0]!.resume!==null)throw denied()
  const selected=await readPreparedMaintenancePause(db,intent.run)
  if(!selected.adopted||!isDeepStrictEqual(selected.request,intent.pause)||!isDeepStrictEqual(selected.adopted.result,proof.pause))throw denied()
 }else if(!['ended','withdrawn'].includes(String(r!.state))||r!.state==='ended'&&(r!.evidence as {state?:unknown}|null)?.state!=='ended')throw denied()
 const progress=(await db.query('select pending_run_ids,unknown_operation_ids from teloa_work_control_progress where owner_id=$1 and control_id=$2',[intent.run.owner,intent.run.controlId])).rows
 if(progress.length!==1||!isDeepStrictEqual(progress[0]!.pending_run_ids,[])||!isDeepStrictEqual(progress[0]!.unknown_operation_ids,[]))throw denied()
 const attempts=(await db.query('select state,settled_at from teloa_task_run_submissions where owner_id=$1 and run_id=$2',[intent.run.owner,intent.run.runId])).rows
 if(attempts.some(row=>!['accepted','not-published'].includes(String(row.state))||!(row.settled_at instanceof Date)||!Number.isFinite(row.settled_at.getTime())))throw denied()
 const verified={};completedCycles.set(verified,{intent:JSON.stringify(intent),samePreparedRun:options.samePreparedRun===true,previous:{requestId:intent.requestId,auditSha256:auditDigest(audits[0]!.audit)}});return verified
}
async function completedCycle(state:InstallState,p:CyclePaths,intent:Intent,helper:string,newRunId:string,candidateRoot:string){
 const home=await lstat(state.layout.home),bindingSha256=maintenanceDigest(JSON.stringify(intent))
 if(intent.schema!=='teloa.prepared-maintenance-intent/v1'||intent.installId!==state.id||intent.home!==state.layout.home||intent.homeDevice!==home.dev||intent.homeInode!==home.ino||intent.backup!==state.layout.home+'.backups/prepared-'+intent.requestId)throw denied()
 const complete=await optional(p.complete),receipt=await readPrivateJson(p.exit) as MaintenanceProcessReceipt,native=await readPrivateJson(p.native) as Native,pause=await readPrivateJson(p.pause) as Pause
 assertPreparedExitWindow(await readPrivateJson(p['exit-issued']),receipt,bindingSha256);verifyMaintenanceProcessReceipt(receipt,intent.processes,bindingSha256)
 // 旧端口可由新世代宿主正常使用；只证明原OS世代已退出，绝不停止当前宿主。
 for(const identity of [intent.processes.supervisor,intent.processes.child,...intent.processes.referenceMcp?[intent.processes.referenceMcp]:[]]){const current=await inspectMaintenanceProcess(helper,identity.pid);if(current&&current.bootId===identity.bootId&&current.uniqueId===identity.uniqueId)throw denied()}
 const manifest=await verifySubmissionMaintenanceBackup(intent.backup,{installId:state.id,home:state.layout.home,bindingSha256}),saved=await readPrivateJson(join(intent.backup,'maintenance-receipt.json'))
 if(manifest.version!==intent.sourceVersion||!isDeepStrictEqual(saved,{intent,processReceipt:receipt,native,bindingSha256}))throw denied()
 const pool=await databasePool(state);let verified:object
 try{
  if(!isDeepStrictEqual(await databaseIdentity(state,pool),intent.database)){
   if(state.database.kind!=='docker')throw denied()
   const current=await readPrivateJson(databaseConfig(state)) as {connectionString:string},backup=await readPrivateJson(join(intent.backup,'runtime/database.json')) as {connectionString:string}
   await assertCompletedPreparedDatabase(pool,{installId:state.id,database:intent.database,currentConnection:current.connectionString,backupConnection:backup.connectionString,container:await ownContainer(state)})
  }
  const samePreparedRun=intent.run.runId===newRunId
  if(samePreparedRun){const source=await verifyRelease(state.layout.releaseRoot);if(state.version!==intent.targetVersion||!isDeepStrictEqual(await readRun(state,pool,newRunId,source),intent.run))throw denied()}
  verified=await withReleaseModule(candidateRoot,'packages/backend/lib/work/prepared-maintenance.js',async value=>{
   const api=value as PreservationModule;if(typeof api.readPreparedMaintenance!=='function')throw denied()
   return assertCompletedPreparedMaintenance(pool,intent,complete,{pause,native,receipt,backupManifestSha256:maintenanceDigest(await readFile(join(intent.backup,'backup-manifest.json')))},{...(samePreparedRun?{samePreparedRun:true as const}:{}),readAudit:api.readPreparedMaintenance})
  })
 }finally{await pool.end()}
 p.assertCurrent();return verified
}
/** 新周期只发布一个持久指针；旧legacy和旧周期的所有文件均留在原路径，不删除或覆盖。 */
export async function publishPreparedMaintenanceCycle(state:InstallState,previous:Intent,intent:Intent,proof:object):Promise<void>{
 const lease=installationLease(state);lease()
 const verified=completedCycles.get(proof),samePreparedRun=intent.run.runId===previous.run.runId
 if(!verified||verified.intent!==JSON.stringify(previous)||verified.samePreparedRun!==samePreparedRun||state.phase!=='ready'||!isDeepStrictEqual(await readPrivateJson(join(state.layout.instanceRoot,'state.json')),state)||!uuid(intent.requestId)||intent.installId!==state.id||intent.home!==state.layout.home||intent.sourceVersion!==state.version||intent.targetVersion===state.version)throw denied()
 const old=await paths(state);old.assertCurrent()
 if(!isDeepStrictEqual(await readPrivateJson(old.intent),previous)||intent.requestId===previous.requestId)throw denied()
 if(samePreparedRun?previous.targetVersion!==state.version||!isDeepStrictEqual(intent.run,previous.run)||!isDeepStrictEqual(intent.pause,previous.pause)||!isDeepStrictEqual(intent.previousPreparedAudit,verified.previous):intent.previousPreparedAudit!==undefined)throw denied()
 await privateDirectory(join(state.layout.instanceRoot,'prepared-maintenance-cycles'))
 const root=join(state.layout.instanceRoot,'prepared-maintenance-cycles',intent.requestId)
 // UUID目录不得接管已有文件；失败前没有暂停、退出或数据库副作用。
 await mkdir(root,{mode:0o700})
 await durable(cyclePaths(root,()=>{}).intent,intent)
 // 新周期目录本身也须先落盘，避免指针已持久而其目标目录在崩溃后丢失。
 const parent=await open(dirname(root),'r');try{await parent.sync()}finally{await parent.close()}
 old.assertCurrent();lease()
 await durable(join(state.layout.instanceRoot,'prepared-maintenance-current.json'),{schema:'teloa.prepared-maintenance-current/v1',requestId:intent.requestId,previousRequestId:previous.requestId,previousBindingSha256:maintenanceDigest(JSON.stringify(previous))})
 completedCycles.delete(proof)
}
/** prepareDatabase 的内部专用证明；不使用 submitting 的 intent，也不接受客户端提供的备份例外。 */
export async function verifyPreparedMaintenanceMigration(state:InstallState,backup:string){
 const lease=installationLease(state),p=await paths(state),intent=await readPrivateJson(p.intent) as Intent
 if(state.phase!=='maintenance'||intent.schema!=='teloa.prepared-maintenance-intent/v1'||intent.installId!==state.id||intent.home!==state.layout.home||intent.targetVersion!==state.version||intent.sourceVersion===intent.targetVersion||!uuid(intent.requestId)||backup!==intent.backup||backup!==state.layout.home+'.backups/prepared-'+intent.requestId)throw denied()
 const sourceState={...state,version:intent.sourceVersion,layout:await resolveLayout({home:state.layout.home,workspace:state.layout.workspaceRoot,version:intent.sourceVersion})},source=await verifyRelease(sourceState.layout.releaseRoot),candidate=await verifyRelease(state.layout.releaseRoot)
 assertPreparedMaintenanceData(source,candidate)
 if(source.version!==intent.sourceVersion||candidate.version!==intent.targetVersion||maintenanceDigest(await readFile(join(sourceState.layout.releaseRoot,'release-manifest.json')))!==intent.sourceManifestSha256||maintenanceDigest(JSON.stringify(candidate))!==intent.targetManifestSha256)throw denied()
 const guard=()=>{lease();p.assertCurrent();const current=JSON.parse(readFileSync(join(state.layout.instanceRoot,'state.json'),'utf8')),home=lstatSync(state.layout.home);if(current.id!==state.id||current.phase!=='maintenance'||current.version!==intent.targetVersion||!isDeepStrictEqual(current.layout,state.layout)||home.isSymbolicLink()||home.dev!==intent.homeDevice||home.ino!==intent.homeInode||!isDeepStrictEqual(JSON.parse(readFileSync(p.intent,'utf8')),intent))throw denied()}
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
 const lease=installationLease(state),candidate=await verifyRelease(sourceRoot),helper=await maintenanceHelper(sourceRoot)
 let p=await paths(state)
 if(candidate.version!==input.targetVersion||!canUseData(candidate,candidate.dataVersion)||candidate.dshVersion!=='0.2.1-rc.2')throw denied()
 let intent=await optional(p.intent) as Intent|undefined
 if(input.existingTargetOnly&&(!intent||state.phase!=='maintenance'&&!(input.finish&&state.phase==='stopped')))throw denied()
 let previous:Intent|undefined,previousProof:object|undefined,created=false
 if(intent&&(intent.run.runId!==input.runId||intent.targetVersion!==input.targetVersion)){
  if(input.finish||input.existingTargetOnly||state.phase!=='ready')throw denied()
  previousProof=await completedCycle(state,p,intent,helper,input.runId,sourceRoot);previous=intent;intent=undefined
 }
 if(!intent){
  if(input.finish||state.phase!=='ready'||state.version===input.targetVersion)throw denied()
  const source=await verifyRelease(state.layout.releaseRoot);assertPreparedMaintenanceData(source,candidate);if(source.version!==state.version||source.dshVersion!==candidate.dshVersion)throw denied()
  const profileHashes=await fixedProfile(state,sourceRoot),pool=await databasePool(state);let run:Run,database:Intent['database'],selection:PauseSelection
  try{run=await readRun(state,pool,input.runId,source);database=await databaseIdentity(state,pool);selection=await readPreparedMaintenancePause(pool,run)}finally{await pool.end()}
  const processes=await captureMaintenanceProcesses(state,helper),home=await lstat(state.layout.home),requestId=randomUUID()
  const previousPreparedAudit=previous&&previous.run.runId===input.runId?completedCycles.get(previousProof!)?.previous:undefined
  intent={schema:'teloa.prepared-maintenance-intent/v1',requestId,installId:state.id,home:state.layout.home,homeDevice:home.dev,homeInode:home.ino,database,sourceVersion:state.version,sourceManifestSha256:maintenanceDigest(await readFile(join(state.layout.releaseRoot,'release-manifest.json'))),targetVersion:input.targetVersion,targetManifestSha256:maintenanceDigest(JSON.stringify(candidate)),run,processes,profileHashes,pause:selection.request,...(selection.adopted?{adoptedPause:selection.adopted}:{}),...(previousPreparedAudit?{previousPreparedAudit}:{}),backup:state.layout.home+'.backups/prepared-'+requestId};lease();if(previous){await publishPreparedMaintenanceCycle(state,previous,intent,previousProof!);p=await paths(state)}else await durable(p.intent,intent);await writeInstall({...state,phase:'maintenance'});created=true
 }
 if(intent.schema!=='teloa.prepared-maintenance-intent/v1'||intent.installId!==state.id||intent.home!==state.layout.home||intent.run.runId!==input.runId||intent.targetVersion!==input.targetVersion||intent.targetManifestSha256!==maintenanceDigest(JSON.stringify(candidate))||![intent.sourceVersion,intent.targetVersion].includes(state.version))throw denied()
 if(!created&&state.phase==='ready'){
  // intent/周期指针已持久、phase尚未写入的崩溃窗口：重核同一原始身份后续办，不重建intent。
  if(input.finish||state.version!==intent.sourceVersion)throw denied()
  const source=await verifyRelease(state.layout.releaseRoot),pool=await databasePool(state)
  try{
   if(!isDeepStrictEqual(await readRun(state,pool,input.runId,source),intent.run)||!isDeepStrictEqual(await databaseIdentity(state,pool),intent.database))throw denied()
   const selection=await readPreparedMaintenancePause(pool,intent.run)
   if(intent.adoptedPause?!isDeepStrictEqual(selection,{request:intent.pause,adopted:intent.adoptedPause}):selection.adopted!==undefined||!isDeepStrictEqual({...selection.request,requestId:intent.pause.requestId},intent.pause))throw denied()
  }finally{await pool.end()}
  if(!isDeepStrictEqual(await captureMaintenanceProcesses(state,helper),intent.processes)||!isDeepStrictEqual(await fixedProfile(state,sourceRoot),intent.profileHashes))throw denied()
  lease();p.assertCurrent();await writeInstall({...state,phase:'maintenance'})
 }
 const sourceState={...state,version:intent.sourceVersion,layout:await resolveLayout({home:state.layout.home,workspace:state.layout.workspaceRoot,version:intent.sourceVersion}),phase:'maintenance' as const},bindingSha=maintenanceDigest(JSON.stringify(intent))
 const source=await verifyRelease(sourceState.layout.releaseRoot);assertPreparedMaintenanceData(source,candidate);if(source.version!==intent.sourceVersion||source.dshVersion!==candidate.dshVersion)throw denied()
 const guard=()=>{lease();p.assertCurrent();const current=JSON.parse(readFileSync(join(state.layout.instanceRoot,'state.json'),'utf8')),home=lstatSync(state.layout.home),control=JSON.parse(readFileSync(join(state.layout.instanceRoot,'control.json'),'utf8'));if(current.id!==state.id||current.phase!=='maintenance'&&!(input.finish&&state.phase==='stopped'&&current.phase==='stopped')||current.layout?.home!==intent!.home||current.layout?.workspaceRoot!==state.layout.workspaceRoot||![intent!.sourceVersion,intent!.targetVersion].includes(current.version)||current.layout.releaseRoot!==join(intent!.home,'releases',current.version)||home.isSymbolicLink()||home.dev!==intent!.homeDevice||home.ino!==intent!.homeInode||!isDeepStrictEqual(JSON.parse(readFileSync(p.intent,'utf8')),intent)||['pid','startedAt','nonce','installId','port'].some(key=>Reflect.get(control,key)!==Reflect.get(intent!.processes.control,key)))throw denied()}
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
   const issued=p['pause-issued']
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
 try{await withReleaseModule(next.layout.releaseRoot,'packages/backend/lib/work/prepared-maintenance.js',async value=>{const api=value as PreservationModule;if(typeof api.preservePreparedRun!=='function')throw denied();await api.preservePreparedRun(pool,preservationAudit(intent,pause,native,receipt,maintenanceDigest(await readFile(join(intent.backup,'backup-manifest.json')))),{assertCurrent:guard},new Date().toISOString(),intent.previousPreparedAudit)})}finally{await pool.end()}
 guard();const completed={requestId:intent.requestId,runId:input.runId,version:input.targetVersion,bindingSha256:bindingSha,keptPrepared:true},previousComplete=await optional(p.complete);if(previousComplete&&!isDeepStrictEqual(previousComplete,completed))throw denied();if(!previousComplete)await durable(p.complete,completed)
 if(input.finish){const finished={...next,phase:'stopped' as const};await writeInstall(finished);return {state:finished,backup:intent.backup}}
 return {state:next,backup:intent.backup}
}

export type PreparedUpgradeReceipt={from:string;to:string;backup:string;restartId:string;status:'complete'}
export type PreparedUpgradeLink={intent:Intent;proof:object}
/** 仅消费真实DB审计签发的内存票据；磁盘complete、state版本或RPC布尔值都不是谱系授权。 */
export function assertPreparedUpgradeLineage(state:InstallState,previous:PreparedUpgradeReceipt,links:readonly PreparedUpgradeLink[],home:{dev:number;ino:number}):void{
 if(!previous||Object.keys(previous).sort().join(',')!=='backup,from,restartId,status,to'||previous.status!=='complete'||!exactVersion(previous.from)||!exactVersion(previous.to)||previous.from===previous.to||!uuid(previous.restartId)||typeof previous.backup!=='string'||!links.length||previous.to===state.version)throw denied()
 let version=previous.to,owner:string|undefined
 const seen=new Set<string>()
 for(const {intent,proof}of links){
  const token=completedCycles.get(proof)
  if(!token||token.samePreparedRun||token.intent!==JSON.stringify(intent)||seen.has(intent.requestId)||intent.installId!==state.id||intent.home!==state.layout.home||intent.homeDevice!==home.dev||intent.homeInode!==home.ino||intent.sourceVersion!==version||intent.targetVersion===version||intent.backup!==state.layout.home+'.backups/prepared-'+intent.requestId||!exactVersion(intent.targetVersion)||owner!==undefined&&intent.run.owner!==owner)throw denied()
  const prior=links[seen.size-1]
  if(prior&&intent.run.runId===prior.intent.run.runId&&!isDeepStrictEqual(intent.previousPreparedAudit,completedCycles.get(prior.proof)!.previous)||prior&&intent.run.runId!==prior.intent.run.runId&&intent.previousPreparedAudit!==undefined)throw denied()
  owner=intent.run.owner;seen.add(intent.requestId);version=intent.targetVersion
 }
 if(version!==state.version)throw denied()
}

/** 同endpoint同PG也须核对完整历史连接和实际角色/public/marker；不授予执行许可。 */
export async function assertPreparedUpgradeDatabase(db:PauseReader,input:{state:InstallState;current:unknown;historical:unknown;database:Intent['database'];source:ReleaseManifest}):Promise<void>{
 if(!input.database||!/^\d+$/.test(input.database.systemIdentifier)||!await (await import('./upgrade-database-binding.ts')).matchesOrdinaryDatabaseConfig(input.state,input.current,maintenanceDigest(JSON.stringify(input.historical))))throw denied()
 const url=localConnection((input.current as {connectionString:string}).connectionString),old=localConnection((input.historical as {connectionString:string}).connectionString)
 if(old.protocol+'//'+old.hostname+':'+(old.port||'5432')+old.pathname!==input.database.endpoint)throw denied()
 const rows=(await db.query("select current_database() as database,current_schema() as schema,to_json(current_schemas(false)) as schemas,current_user as username,session_user as session_username,(select system_identifier::text from pg_control_system()) as system_identifier,to_regclass('teloa_installation')=to_regclass('public.teloa_installation') as public_marker_resolved")).rows,row=rows[0]
 if(rows.length!==1||row!.database!==decodeURIComponent(url.pathname.slice(1))||row!.schema!=='public'||!isDeepStrictEqual(row!.schemas,['public'])||row!.username!==decodeURIComponent(url.username)||row!.session_username!==decodeURIComponent(url.username)||row!.system_identifier!==input.database.systemIdentifier||row!.public_marker_resolved!==true)throw denied()
 const marker=(await db.query('select id,data_version from public.teloa_installation')).rows
 if(marker.length!==1||marker[0]!.id!==input.state.id||typeof marker[0]!.data_version!=='number'||!canUseData(input.source,marker[0]!.data_version))throw denied()
}

/** 旧单root审计不借缺表降级；现代发行仍须完整reader和cycles表。 */
export async function readPreparedUpgradeAudit(db:PauseReader,input:{source:ReleaseManifest;chain:readonly Intent[];intent:Intent;reader:AuditReader|undefined;legacyRootOnly:boolean}):Promise<AuditRow>{
 const tables=(await db.query("select to_regclass('public.teloa_prepared_run_maintenance')::text as root,to_regclass('public.teloa_prepared_run_maintenance_cycles')::text as cycles")).rows
 const named=(value:unknown,name:string)=>value===name||value==='public.'+name
 if(tables.length!==1||!named(tables[0]!.root,'teloa_prepared_run_maintenance'))throw denied()
 const i=input.intent
 if(typeof input.reader==='function'){
  if(!named(tables[0]!.cycles,'teloa_prepared_run_maintenance_cycles'))throw denied()
  const latest=await input.reader(db,i.run.owner,i.run.runId),expected=input.chain.filter(x=>x.run.owner===i.run.owner&&x.run.runId===i.run.runId).at(-1)
  if(!expected||!latest||latest.request_id!==expected.requestId)throw denied()
  const rows=(await db.query('select request_id,audit,resume from teloa_prepared_run_maintenance where owner_id=$1 and run_id=$2 and request_id=$3 union all select c.request_id,c.audit,r.resume from teloa_prepared_run_maintenance_cycles c join teloa_prepared_run_maintenance r on r.owner_id=c.owner_id and r.run_id=c.run_id where c.owner_id=$1 and c.run_id=$2 and c.request_id=$3',[i.run.owner,i.run.runId,i.requestId])).rows
  if(rows.length!==1)throw denied();return rows[0] as AuditRow
 }
 if(input.source.schema!=='teloa.release/v1'||!exactVersion(input.source.version)||!Number.isSafeInteger(input.source.dataVersion)||!canUseData(input.source,input.source.dataVersion)||input.source.dataVersion>=13||input.source.version!==i.targetVersion||!input.legacyRootOnly||input.chain.length!==1||input.chain[0]!==i||i.previousPreparedAudit!==undefined||tables[0]!.cycles!==null)throw denied()
 const columns=(await db.query("select attname as name,pg_catalog.format_type(atttypid,atttypmod) as type from pg_catalog.pg_attribute where attrelid='public.teloa_prepared_run_maintenance'::regclass and attnum>0 and not attisdropped order by attnum")).rows
 if(!isDeepStrictEqual(columns,[['owner_id','text'],['run_id','uuid'],['request_id','uuid'],['audit','jsonb'],['resume','jsonb'],['dispatch','jsonb'],['created_at','timestamp with time zone']].map(([name,type])=>({name,type}))))throw denied()
 const rows=(await db.query('select request_id,audit,resume from public.teloa_prepared_run_maintenance where owner_id=$1 and run_id=$2',[i.run.owner,i.run.runId])).rows
 if(rows.length!==1||rows[0]!.request_id!==i.requestId)throw denied();return rows[0] as AuditRow
}

/** 公开manifest可0644，但不得借链接、异主或组/其他人可写文件取得维护资格。 */
export function assertPreparedUpgradeManifestFile(info:Pick<Stats,'uid'|'mode'|'isFile'|'isSymbolicLink'>,owner:number):void{
 if(!info.isFile()||info.isSymbolicLink()||info.uid!==owner||(info.mode&0o022)!==0)throw denied()
}
/** 与verifyRelease同为公开JSON读取；历史整包可退役，摘要仍由原intent精确冻结。 */
export async function readPreparedUpgradeManifest(home:string,version:string):Promise<{path:string;bytes:Buffer;manifest:ReleaseManifest;identity:Record<string,number>}>{
 if(!exactVersion(version))throw denied()
 const homeInfo=await lstat(home),path=join(home,'releases',version,'release-manifest.json')
 if(!homeInfo.isDirectory()||homeInfo.isSymbolicLink()||await (await import('node:fs/promises')).realpath(path)!==path)throw denied()
 const identity=(info:Stats)=>Object.fromEntries(['dev','ino','uid','mode','size','mtimeMs','ctimeMs'].map(key=>[key,info[key as keyof Stats] as number]))
 const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
 try{
  const before=await handle.stat();assertPreparedUpgradeManifestFile(before,homeInfo.uid)
  const bytes=await handle.readFile(),after=await handle.stat(),named=await lstat(path)
  assertPreparedUpgradeManifestFile(after,homeInfo.uid);assertPreparedUpgradeManifestFile(named,homeInfo.uid)
  if(!isDeepStrictEqual(identity(before),identity(after))||!isDeepStrictEqual(identity(before),identity(named)))throw denied()
  const manifest=JSON.parse(bytes.toString()) as ReleaseManifest
  if(manifest?.schema!=='teloa.release/v1'||manifest.version!==version||!Number.isInteger(manifest.dataVersion)||!Array.isArray(manifest.compatibleDataVersions)||!Array.isArray(manifest.files))throw denied()
  return {path,bytes,manifest,identity:identity(before)}
 }finally{await handle.close()}
}

/** 公共维护已完成后的只读桥；不改原ordinary receipt、intent、Run或任何业务行。 */
export async function withPreparedUpgradeLineage<T>(state:InstallState,previous:PreparedUpgradeReceipt,ordinaryBackup:string|undefined,assertCurrent:()=>Promise<void>,action:(assertProofCurrent:()=>Promise<void>)=>Promise<T>):Promise<T>{
 const lease=installationLease(state),source=await verifyRelease(state.layout.releaseRoot),home=await lstat(state.layout.home)
 if(source.version!==state.version||!['stopped','maintenance'].includes(state.phase)||state.layout.releaseRoot!==join(state.layout.home,'releases',state.version)||home.isSymbolicLink()||await (await import('node:fs/promises')).realpath(state.layout.home)!==state.layout.home)throw denied()
 const files=new Map<string,Buffer>(),publicManifests=new Map<string,{version:string;identity:Record<string,number>}>()
 const boundManifest=async(version:string)=>{const value=await readPreparedUpgradeManifest(state.layout.home,version);files.set(value.path,value.bytes);publicManifests.set(value.path,{version,identity:value.identity});return value.manifest}
 const bound=async(path:string)=>{const bytes=await readFile(path),value=await readPrivateJson(path);if(!isDeepStrictEqual(JSON.parse(bytes.toString()),value))throw denied();files.set(path,bytes);return value}
 const guard=async()=>{lease();await assertCurrent();for(const[path,expected]of publicManifests){const value=await readPreparedUpgradeManifest(state.layout.home,expected.version);if(!isDeepStrictEqual(value.identity,expected.identity)||!isDeepStrictEqual(value.bytes,files.get(path)))throw denied()}for(const[path,bytes]of files)if(!isDeepStrictEqual(await readFile(path),bytes))throw denied()}
 if(previous.status!=='complete'||typeof previous.backup!=='string'||dirname(previous.backup)!==state.layout.home+'.backups'||await (await import('node:fs/promises')).realpath(previous.backup)!==previous.backup)throw denied()
 const oldBackup=await (await import('./maintenance.ts')).verifyBackup(previous.backup),oldMeta=await bound(join(previous.backup,'installation.json'))
 await bound(join(previous.backup,'backup-manifest.json'))
 if(oldBackup.installId!==state.id||oldBackup.version!==previous.from||!isDeepStrictEqual(oldMeta,{workspaceRoot:state.layout.workspaceRoot,port:state.port}))throw denied()
 const selected=await paths(state),latest=await bound(selected.intent) as Intent,pointer=await optional(join(state.layout.instanceRoot,'prepared-maintenance-current.json')) as CyclePointer|undefined
 if(pointer)await bound(join(state.layout.instanceRoot,'prepared-maintenance-current.json'))
 if(latest.targetVersion!==state.version||pointer&&pointer.requestId!==latest.requestId)throw denied()
 const roots=new Map<string,{root:string;intent:Intent}>()
 const remember=async(root:string)=>{const i=await bound(cyclePaths(root,()=>{}).intent) as Intent;if(i.schema!=='teloa.prepared-maintenance-intent/v1'||!uuid(i.requestId)||roots.has(i.requestId)||!exactVersion(i.sourceVersion)||!exactVersion(i.targetVersion)||i.installId!==state.id||i.home!==state.layout.home||i.backup!==state.layout.home+'.backups/prepared-'+i.requestId||!i.run||!uuid(i.run.runId)||typeof i.run.owner!=='string'||!i.run.owner)throw denied();roots.set(i.requestId,{root,intent:i})}
 await remember(state.layout.instanceRoot)
 const directory=join(state.layout.instanceRoot,'prepared-maintenance-cycles')
 try{
  const info=await lstat(directory);if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o077))throw denied()
  for(const item of await (await import('node:fs/promises')).readdir(directory,{withFileTypes:true})){if(!item.isDirectory()||!uuid(item.name))throw denied();const root=join(directory,item.name),s=await lstat(root);if(s.isSymbolicLink()||(s.mode&0o077))throw denied();await remember(root);if(roots.get(item.name)?.intent.requestId!==item.name)throw denied()}
 }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 if(!roots.has(latest.requestId)||!isDeepStrictEqual(roots.get(latest.requestId)!.intent,latest))throw denied()
 if(pointer){const parent=roots.get(pointer.previousRequestId);if(!parent||maintenanceDigest(JSON.stringify(parent.intent))!==pointer.previousBindingSha256)throw denied()}
 const reversed:Array<{root:string;intent:Intent}>=[],visited=new Set<string>();let cursor=roots.get(latest.requestId)!
 while(true){
  if(visited.has(cursor.intent.requestId))throw denied();visited.add(cursor.intent.requestId);reversed.push(cursor)
  if(cursor.intent.sourceVersion===previous.to)break
  const id=cursor.intent.previousPreparedAudit?.requestId??(cursor.intent.requestId===pointer?.requestId?pointer.previousRequestId:undefined)
  const candidates=id?[roots.get(id)].filter((x):x is NonNullable<typeof x>=>!!x):[...roots.values()].filter(x=>x.intent.targetVersion===cursor.intent.sourceVersion)
  if(candidates.length!==1||candidates[0]!.intent.targetVersion!==cursor.intent.sourceVersion)throw denied();cursor=candidates[0]!
 }
 const chain=reversed.reverse()
 // 历史发行可按正常退役策略只保留manifest；每跳的冻结摘要和备份/DB审计仍必须相接。
 for(const {intent:i}of chain){
  const a=await boundManifest(i.sourceVersion),b=await boundManifest(i.targetVersion)
  if(a.version!==i.sourceVersion||b.version!==i.targetVersion||!canUpgradeData(b,a.dataVersion)||maintenanceDigest(files.get(join(state.layout.home,'releases',i.sourceVersion,'release-manifest.json'))!)!==i.sourceManifestSha256||maintenanceDigest(JSON.stringify(b))!==i.targetManifestSha256)throw denied()
 }
 const first=await boundManifest(previous.to)
 if(!canUpgradeData(first,oldBackup.dataVersion))throw denied()
 // 明确恢复允许本人已正常修改/还原的配置；冻结本次当前profile直到发布，不冒充历史profile。
 if(ordinaryBackup){const backup=await (await import('./maintenance.ts')).verifyBackup(ordinaryBackup);if(backup.installId!==state.id||backup.version!==state.version||backup.dataVersion!==source.dataVersion)throw denied()}
 for(const name of ['package.json','cordis.yml','cordis.patch.yml']){const path=join(state.layout.dshHome,'profiles/teloa',name),info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw denied();files.set(path,await readFile(path))}
 await guard()
 // initialize:false且必须有真实旧备份：只启动本安装DB并检查既有marker，绝不认领空库/迁移/初始化。
 let pool:Awaited<ReturnType<typeof databasePool>>|undefined,db:Awaited<ReturnType<typeof databasePool>>|undefined
 try{
  await prepareDatabase(state,{initialize:false,migrationBackup:ordinaryBackup??previous.backup})
  pool=await databasePool(state);db=await pool.connect();await db.query('begin isolation level repeatable read read only')
  const currentConfig=await readPrivateJson(databaseConfig(state)),helper=await maintenanceHelper(state.layout.releaseRoot),links:PreparedUpgradeLink[]=[]
  const api=await withReleaseModule(state.layout.releaseRoot,'packages/backend/lib/work/prepared-maintenance.js',async value=>value as PreservationModule)
  const legacyRootOnly=pointer===undefined&&roots.size===1&&chain.length===1&&chain[0]!.root===state.layout.instanceRoot
  for(const {root,intent:i}of chain){
   if(i.installId!==state.id||i.home!==state.layout.home||i.homeDevice!==home.dev||i.homeInode!==home.ino)throw denied()
   const p=cyclePaths(root,()=>{}),complete=await bound(p.complete),receipt=await bound(p.exit) as MaintenanceProcessReceipt,native=await bound(p.native) as Native,pause=await bound(p.pause) as Pause
   assertPreparedExitWindow(await bound(p['exit-issued']),receipt,maintenanceDigest(JSON.stringify(i)));verifyMaintenanceProcessReceipt(receipt,i.processes,maintenanceDigest(JSON.stringify(i)))
   for(const identity of [i.processes.supervisor,i.processes.child,...i.processes.referenceMcp?[i.processes.referenceMcp]:[]]){const actual=await inspectMaintenanceProcess(helper,identity.pid);if(actual&&actual.bootId===identity.bootId&&actual.uniqueId===identity.uniqueId)throw denied()}
   const manifest=await verifySubmissionMaintenanceBackup(i.backup,{installId:state.id,home:state.layout.home,bindingSha256:maintenanceDigest(JSON.stringify(i))}),saved=await bound(join(i.backup,'maintenance-receipt.json'))
   if(manifest.version!==i.sourceVersion||!isDeepStrictEqual(saved,{intent:i,processReceipt:receipt,native,bindingSha256:maintenanceDigest(JSON.stringify(i))}))throw denied()
   await bound(join(i.backup,'backup-manifest.json'))
   for(const name of ['package.json','cordis.yml','cordis.patch.yml'])if(maintenanceDigest(await readFile(join(i.backup,'dsh/profiles/teloa',name)))!==i.profileHashes[name])throw denied()
   // 完整配置绑定包括用户名/密码/host/DB/协议/所有额外字段；Docker只容许已经证明的动态port。
   const historical=await readPrivateJson(join(i.backup,'runtime/database.json'))
   await assertPreparedUpgradeDatabase(db,{state,current:currentConfig,historical,database:i.database,source})
   // 现代reader先核完整不可分叉链；仅明确旧单root才复用原精确审计合同。
   const audit=await readPreparedUpgradeAudit(db,{source,chain:chain.map(x=>x.intent),intent:i,reader:api.readPreparedMaintenance,legacyRootOnly})
   const proof=await assertCompletedPreparedMaintenance(db,i,complete,{pause,native,receipt,backupManifestSha256:maintenanceDigest(files.get(join(i.backup,'backup-manifest.json'))!)},{readAudit:async()=>audit})
   links.push({intent:i,proof})
  }
  assertPreparedUpgradeLineage(state,previous,links,home)
  selected.assertCurrent();await guard();await db.query('select 1');return await action(async()=>{selected.assertCurrent();await guard()})
 }finally{try{if(db){try{await db.query('rollback')}finally{db.release()}}}finally{try{await pool?.end()}finally{await (await import('./database.ts')).stopDatabase(state)}}}
}
