import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,rename,lstat,chmod} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {resolveLayout} from '../src/layout.ts'
import {writeInstall,writePrivateJson,readPrivateJson,withInstallLock} from '../src/state.ts'
import {beginOrdinaryUpgrade,continueOrdinaryUpgrade,authorizeOrdinaryUpgradeBackup,ordinaryUpgradePending,authorizeCompletedPreparedUpgradeSource,type OrdinaryUpgradePorts} from '../src/upgrade-intent.ts'
import {resumeUpgradeInstall,upgradeResumePending,type UpgradeResumePorts} from '../src/upgrade-resume.ts'
import {verifyBackup} from '../src/maintenance.ts'
import type {InstallState,Status} from '../src/contracts.ts'
import type {ControlRecord} from '../src/service.ts'

const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex')
async function fixture(t:{after:(fn:()=>Promise<unknown>)=>unknown}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-upgrade-intent-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const to='0.2.21',layout=await resolveLayout({home:join(root,'home'),version:'0.2.20'}),state:InstallState={schema:'teloa.install/v1',id:randomUUID(),version:'0.2.20',layout,port:3292,database:{kind:'docker'},phase:'stopped'}
 await writeInstall(state)
 const release=async(version:string)=>{const dir=join(layout.home,'releases',version),body='// release '+version;await mkdir(dir,{recursive:true});await writeFile(join(dir,'entry.js'),body);await writePrivateJson(join(dir,'release-manifest.json'),{schema:'teloa.release/v1',version,dshVersion:'0.2.1-rc.2',dataVersion:9,compatibleDataVersions:[9],files:[{path:'entry.js',sha256:hash(body)}]});return dir}
 await release(state.version);const target=await release(to),intentPath=join(layout.instanceRoot,'upgrade-intent.json')
 let mode:'normal'|'partial'|'manifest'|'verified'|'published'='normal',backups=0,stops=0,starts=0,prepares=0,app:Status['app']='stopped',control:ControlRecord|null=null
 const status=(s:InstallState):Status=>({app,database:'ready',activeWork:0,version:s.version,port:s.port})
 const p:OrdinaryUpgradePorts={status:async s=>status(s),stopDatabase:async()=>{stops++},backup:async(s,output,options)=>{
  backups++;assert.ok(options);const staging=await authorizeOrdinaryUpgradeBackup(s,output,options.ordinaryUpgradeId)
  await writeInstall({...s,phase:'maintenance'});await mkdir(staging,{mode:0o700})
  await writeFile(join(staging,'database.dump'),'synthetic-only-database-archive',{mode:0o600})
  if(mode==='partial')throw Error('simulated backup interruption')
  const metadata=JSON.stringify({workspaceRoot:s.layout.workspaceRoot,port:s.port});await writeFile(join(staging,'installation.json'),metadata,{mode:0o600})
  const manifest={schema:'teloa.backup/v1' as const,id:randomUUID(),createdAt:new Date().toISOString(),installId:s.id,version:s.version,dataVersion:9,externalWorkspaceIncluded:false as const,files:[{path:'database.dump',sha256:hash('synthetic-only-database-archive')},{path:'installation.json',sha256:hash(metadata)}]}
  await writePrivateJson(join(staging,'backup-manifest.json'),manifest);await verifyBackup(staging)
  if(mode==='manifest')throw Error('simulated after manifest before durable checkpoint')
  await options.onVerified?.(staging)
  if(mode==='verified')throw Error('simulated before publish')
  await rename(staging,output)
  if(mode==='published')throw Error('simulated before backup finally')
  await writeInstall({...s,phase:'stopped'});return manifest
 }}
 const resume:UpgradeResumePorts={status:async s=>status(s),control:async()=>control,prepare:async()=>{prepares++},start:async s=>{starts++;control={pid:process.pid,startedAt:new Date().toISOString(),nonce:randomUUID(),installId:s.id,port:s.port,secret:'c'.repeat(64)};app='ready';return status(s)}}
 const current=async()=>await readPrivateJson(join(layout.instanceRoot,'state.json')) as InstallState
 const run=()=>withInstallLock(layout.home,async()=>await continueOrdinaryUpgrade(await current(),to,target,p))
 const begin=()=>withInstallLock(layout.home,()=>beginOrdinaryUpgrade(state,to))
 return {root,state,to,target,intentPath,p,resume,current,run,begin,release,setMode:(m:typeof mode)=>{mode=m},counts:()=>({backups,stops,starts,prepares}),setApp:(a:Status['app'])=>{app=a}}
}

test('intent先于维护；pending阻止普通启动，正常备份→真实switching→既有resume且完成后幂等',async t=>{
 const f=await fixture(t);await f.begin();assert.deepEqual(await f.current(),f.state)
 assert.equal(await ordinaryUpgradePending(f.state),true);assert.equal(await upgradeResumePending(f.state),true)
 const next=(await f.run())!;assert.equal(next.version,f.to);assert.equal(next.phase,'maintenance')
 const receipt=await readPrivateJson(join(next.layout.instanceRoot,'upgrade.json')) as {status:string};assert.equal(receipt.status,'switching')
 const ready=await withInstallLock(next.layout.home,()=>resumeUpgradeInstall(next,f.to,f.target,f.resume));assert.equal(ready.phase,'ready')
 assert.equal(await upgradeResumePending(ready),false);assert.equal((await withInstallLock(next.layout.home,()=>resumeUpgradeInstall(ready,f.to,f.target,f.resume))).phase,'ready')
 const stopped={...ready,phase:'stopped' as const};await writeInstall(stopped);assert.equal(await upgradeResumePending(stopped),false,'已完成升级正常stop后不阻止普通up/restart')
 assert.deepEqual(f.counts(),{backups:1,stops:2,starts:1,prepares:1})
})

test('partial备份保留旧attempt并显式重做；完整staging及已发布backup不重复导出',async t=>{
 for(const mode of ['partial','manifest','verified','published'] as const)await t.test(mode,async sub=>{
  const f=await fixture(sub);await f.begin();f.setMode(mode);await assert.rejects(f.run(),/simulated/)
  const op=await readPrivateJson(f.intentPath) as {intent:{backup:string};checkpoint:{attempts:Array<{staging:string}>}},first=op.checkpoint.attempts[0]!
  const bytes=await readFile(join(mode==='published'?op.intent.backup:first.staging,'database.dump'))
  const uncommitted=mode==='partial'||mode==='manifest'
  f.setMode('normal');const next=(await f.run())!;assert.equal(next.phase,'maintenance');assert.equal(f.counts().backups,uncommitted?2:1)
  const after=await readPrivateJson(f.intentPath) as {checkpoint:{attempts:Array<{status:string}>}}
  if(uncommitted){assert.deepEqual(await readFile(join(first.staging,'database.dump')),bytes);assert.equal(after.checkpoint.attempts.length,2)}
  else assert.equal(after.checkpoint.attempts.length,1)
 })
})

test('切换回执已发布而state尚为源版本的断点可对账，不伪造failed或重复backup',async t=>{
 const f=await fixture(t);await f.begin();await f.run();await writeInstall({...f.state,phase:'maintenance'})
 const next=(await f.run())!;assert.equal(next.version,f.to);assert.equal(f.counts().backups,1)
 assert.equal((await readPrivateJson(join(next.layout.instanceRoot,'upgrade.json')) as {status:string}).status,'switching')
})

test('无intent的legacy现场不采用完整backup、不创建历史证据，旧拒绝路径仍在',async t=>{
 const f=await fixture(t),s={...f.state,phase:'maintenance' as const};await writeInstall(s)
 assert.equal(await withInstallLock(s.layout.home,()=>continueOrdinaryUpgrade(s,f.to,f.target,f.p)),undefined)
 await assert.rejects(withInstallLock(s.layout.home,()=>resumeUpgradeInstall(s,f.to,f.target,f.resume)))
 await assert.rejects(lstat(f.intentPath),{code:'ENOENT'});assert.deepEqual(f.counts(),{backups:0,stops:0,starts:0,prepares:0})
})

test('错用途、清单、安装身份、锁、活服务及检查点篡改在副作用前拒绝',async t=>{
 for(const kind of ['purpose','manifest','install','checkpoint','database','lock','service'] as const)await t.test(kind,async sub=>{
  const f=await fixture(sub);await f.begin()
  if(kind==='purpose'||kind==='checkpoint'){
   const value=await readPrivateJson(f.intentPath) as {intent:{purpose:string};checkpoint:{intentSha256:string}}
   if(kind==='purpose')value.intent.purpose='submission-maintenance';else value.checkpoint.intentSha256='0'.repeat(64)
   await writePrivateJson(f.intentPath,value)
  }
  if(kind==='manifest')await writeFile(join(f.target,'entry.js'),'changed frozen release')
  if(kind==='install')await writeInstall({...f.state,id:randomUUID()})
  if(kind==='database')await writePrivateJson(join(f.state.layout.runtimeRoot,'database.json'),{connectionString:'synthetic-changed-endpoint'})
  if(kind==='service')f.setApp('ready')
  if(kind==='lock')await assert.rejects(continueOrdinaryUpgrade(f.state,f.to,f.target,f.p))
  else await assert.rejects(f.run())
  assert.deepEqual(f.counts(),{backups:0,stops:0,starts:0,prepares:0})
 })
})

test('完整备份发布前冻结的manifest hash不可因后来重新生成合法清单而改写',async t=>{
 const f=await fixture(t);await f.begin();f.setMode('verified');await assert.rejects(f.run(),/simulated/)
 const op=await readPrivateJson(f.intentPath) as {checkpoint:{attempts:Array<{staging:string}>}},path=join(op.checkpoint.attempts[0]!.staging,'backup-manifest.json'),manifest=await readPrivateJson(path) as {createdAt:string}
 manifest.createdAt='2000-01-01T00:00:00.000Z';await writePrivateJson(path,manifest)
 const counts=f.counts();await assert.rejects(f.run());assert.deepEqual(f.counts(),counts)
})

test('提交维护备份即使放在intent固定目录也拒绝；并发安装锁不允许第二次受理',async t=>{
 const f=await fixture(t);await f.begin()
 const value=await readPrivateJson(f.intentPath) as {intent:{backup:string}}
 await mkdir(value.intent.backup,{recursive:true});await writePrivateJson(join(value.intent.backup,'backup-manifest.json'),{schema:'teloa.maintenance-backup/v1'})
 await assert.rejects(f.run(),/专用|同安装维护备份/);assert.equal(f.counts().backups,0)
 await withInstallLock(f.state.layout.home,async()=>{await assert.rejects(f.run(),/另一项安装/);assert.equal(f.counts().backups,0)})
})


test('普通v1 intent在备份中Docker端口重绑定后可完成并正常resume，旧intent冻结SHA不改',async t=>{
 const f=await fixture(t),password='a'.repeat(64),name='teloa-'+f.state.id
 const config=(port:number)=>({connectionString:'postgresql://teloa:'+password+'@127.0.0.1:'+port+'/teloa'})
 await writePrivateJson(join(f.state.layout.runtimeRoot,'database.json'),config(34065))
 await writeFile(join(f.state.layout.runtimeRoot,'postgres.env'),'POSTGRES_DB=teloa\nPOSTGRES_USER=teloa\nPOSTGRES_PASSWORD='+password+'\n',{mode:0o600})
 const bin=join(f.root,'bin');await mkdir(bin)
 const docker=join(bin,'docker'),proof={Name:'/'+name,Config:{Labels:{'ai.teloa.install':f.state.id},Env:['POSTGRES_DB=teloa','POSTGRES_USER=teloa','POSTGRES_PASSWORD='+password]},State:{Running:false},Mounts:[{Type:'volume',Name:name+'-data',Destination:'/var/lib/postgresql/data'}],HostConfig:{PortBindings:{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:''}]}},NetworkSettings:{Ports:{}}},volume={Name:name+'-data',Labels:{'ai.teloa.install':f.state.id}}
 await writeFile(docker,'#!'+process.execPath+'\nconst a=process.argv.slice(2);if(a[0]==="context")console.log(JSON.stringify([{Endpoints:{docker:{Host:"unix:///synthetic-docker"}}}]));else if(a[0]==="info")console.log("linux");else if(a[0]==="container")console.log(JSON.stringify(['+JSON.stringify(proof)+']));else if(a[0]==="volume")console.log(JSON.stringify(['+JSON.stringify(volume)+']));else process.exit(1);\n',{mode:0o700});await chmod(docker,0o700)
 const beforePath=process.env.PATH;process.env.PATH=bin+':'+(beforePath??'');t.after(()=>{if(beforePath===undefined)delete process.env.PATH;else process.env.PATH=beforePath})
 await f.begin()
 const before=await readPrivateJson(f.intentPath) as {intent:{databaseConfigSha256:string}}
 // 与真实createBackup一致：authorize先过，数据库准备随后重写易变port，onVerified必须仍能保存检查点。
 const original=f.p.backup
 f.p.backup=async(state,output,options)=>{
  assert.ok(options);await authorizeOrdinaryUpgradeBackup(state,output,options.ordinaryUpgradeId)
  await writePrivateJson(join(state.layout.runtimeRoot,'database.json'),config(34066))
  return original(state,output,options)
 }
 const next=(await f.run())!;assert.equal(next.version,f.to)
 const after=await readPrivateJson(f.intentPath) as typeof before
 assert.deepEqual(after.intent,before.intent)
 assert.deepEqual(await readPrivateJson(join(f.state.layout.runtimeRoot,'database.json')),config(34066))
 const ready=await withInstallLock(next.layout.home,()=>resumeUpgradeInstall(next,f.to,f.target,f.resume));assert.equal(ready.phase,'ready')
 assert.equal(f.counts().backups,1)
})

import {assertCompletedPreparedMaintenance,assertPreparedUpgradeLineage,type PreparedUpgradeReceipt,type PreparedUpgradeLink} from '../src/maintenance-prepared.ts'
import {preparedMaintenanceHash} from '../../backend/src/work/prepared-maintenance.ts'
/** 控制SQL传输签发真实typed终态票据；完整磁盘/PG/进程读取由生产bridge负责，不声称实装。 */
async function typedUpgradeProofs(state:InstallState,previous:PreparedUpgradeReceipt){
 const home=await lstat(state.layout.home),run={owner:'fixture-owner',runId:randomUUID(),taskId:randomUUID(),sessionId:'fixture-ended-session',nativeRequestId:randomUUID(),inputSha256:hash('fixed input'),runtimeId:null,agentPresetId:'teloa-standard',controlId:randomUUID()},links:PreparedUpgradeLink[]=[]
 const pieces=state.version.split('.').map(Number),middle=pieces.slice(0,2).join('.')+'.'+(pieces[2]!-1)
 for(const[from,to]of [[previous.to,middle],[middle,state.version]]){
  const requestId=randomUUID(),pause={id:run.controlId,generation:2,version:2,state:'pausing'},receipt={} as Parameters<typeof assertCompletedPreparedMaintenance>[3]['receipt'],native={schema:'fixture-native',original:{snapshotSha256:'a'.repeat(64),fileSha256:'b'.repeat(64)},files:[],allInboxesEmpty:true as const,noOpenTurnOrTool:true as const}
  const intent:Parameters<typeof assertCompletedPreparedMaintenance>[1]={schema:'teloa.prepared-maintenance-intent/v1' as const,requestId,installId:state.id,home:state.layout.home,homeDevice:home.dev,homeInode:home.ino,database:{endpoint:'postgresql://127.0.0.1/teloa',systemIdentifier:'123'},sourceVersion:from!,targetVersion:to!,sourceManifestSha256:'c'.repeat(64),targetManifestSha256:'d'.repeat(64),run,processes:{} as Parameters<typeof assertCompletedPreparedMaintenance>[1]['processes'],profileHashes:{},pause:{requestId:randomUUID(),controlId:run.controlId,expectedVersion:1,action:'pause' as const,scope:'round' as const,roundControlId:null},backup:state.layout.home+'.backups/prepared-'+requestId}
  const audit={schema:'teloa.prepared-maintenance/v1',requestId,installId:state.id,ownerId:run.owner,runId:run.runId,taskId:run.taskId,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,inputSha256:run.inputSha256,runtimeId:null,sourceVersion:from,targetVersion:to,pauseRequestId:intent.pause.requestId,controlId:run.controlId,controlGeneration:2,nativeSnapshotSha256:native.original.snapshotSha256,nativeFileSha256:native.original.fileSha256,processReceiptSha256:hash(JSON.stringify(receipt)),backupManifestSha256:'e'.repeat(64)}
  if(links.length)intent.previousPreparedAudit={requestId:links[0]!.intent.requestId,auditSha256:preparedMaintenanceHash((links[0]as typeof links[0]&{audit:unknown}).audit)}
  const db={query:async(sql:string)=>({rows:sql.includes('prepared_run_maintenance')?[{request_id:requestId,audit}]:sql.includes('work_control_progress')?[{pending_run_ids:[],unknown_operation_ids:[]}]:sql.includes('task_run_submissions')?[]:[{owner_id:run.owner,id:run.runId,task_id:run.taskId,session_id:run.sessionId,native_request_id:run.nativeRequestId,agent_preset_id:run.agentPresetId,input_text:'fixed input',state:'ended',evidence:{state:'ended',reason:'completed'},stop_requested_at:null}]})}
  const complete={requestId,runId:run.runId,version:to,bindingSha256:hash(JSON.stringify(intent)),keptPrepared:true},proof=await assertCompletedPreparedMaintenance(db,intent,complete,{pause,native,receipt,backupManifestSha256:'e'.repeat(64)})
  links.push(Object.assign({intent,proof},{audit}))
 }
 assertPreparedUpgradeLineage(state,previous,links,home)
}

test('已有backup-ready跨prepared旧回执继续原intent，旧receipt入历史且不重新导出',async t=>{
 const f=await fixture(t),previous={from:'0.2.17',to:'0.2.18',backup:f.state.layout.home+'.backups/before-0.2.18-'+randomUUID(),restartId:randomUUID(),status:'complete' as const},path=join(f.state.layout.instanceRoot,'upgrade.json')
 await writePrivateJson(path,previous);const bytes=await readFile(path);await f.begin();const frozen=(await readPrivateJson(f.intentPath)as {intent:unknown}).intent
 let proofs=0
 f.p.preparedLineage=async(state,r,_backup,guard,action)=>{proofs++;await typedUpgradeProofs(state,r);await guard();return action(guard)}
 const next=(await f.run())!;assert.equal(next.version,f.to);assert.equal(proofs,1);assert.equal(f.counts().backups,1)
 assert.deepEqual((await readPrivateJson(f.intentPath)as {intent:unknown}).intent,frozen)
 assert.deepEqual(await readFile(join(f.state.layout.instanceRoot,'upgrade-receipt-history',hash(bytes)+'.json')),bytes)
 assert.deepEqual((await f.run())!.version,f.to);assert.equal(f.counts().backups,1);assert.equal(proofs,1)
})

test('现代completed ordinary intent经显式维护谱系核验才可归档；被动pending不启动DB',async t=>{
 const f=await fixture(t);await f.begin();const n=(await f.run())!;const ready=await withInstallLock(n.layout.home,()=>resumeUpgradeInstall(n,f.to,f.target,f.resume));f.setApp('stopped')
 await f.release('0.2.22');await f.release('0.2.23');const target=await f.release('0.2.24'),state={...ready,version:'0.2.23',layout:await resolveLayout({home:ready.layout.home,version:'0.2.23'}),phase:'stopped' as const};await writeInstall(state)
 const original=await readFile(f.intentPath);let reads=0
 assert.equal(await ordinaryUpgradePending(state),true)
 const lineage:NonNullable<OrdinaryUpgradePorts['preparedLineage']>=async(s,r,_backup,guard,action)=>{reads++;await typedUpgradeProofs(s,r);await guard();return action(guard)}
 await withInstallLock(state.layout.home,async()=>{
  const journalPath=join(state.layout.instanceRoot,'upgrade-resume.json'),journal=await readPrivateJson(journalPath)as {binding:{port:number};attempts:Array<{process?:{installId:string;port:number}}>},last=journal.attempts.at(-1)!,originalProcess=structuredClone(last.process!)
  for(const process of [undefined,{...originalProcess,installId:randomUUID()},{...originalProcess,port:0},{...originalProcess,port:65536}]){
   if(process===undefined)delete last.process;else last.process=process
   await writePrivateJson(journalPath,journal);await assert.rejects(authorizeCompletedPreparedUpgradeSource(state,lineage));assert.equal(reads,0)
  }
  // 私密控制端口独立于app端口；拒绝的应是错误app绑定，而不是合法控制端口。
  last.process={...originalProcess,port:state.port+1};const bindingPort=journal.binding.port;journal.binding.port=state.port+1
  await writePrivateJson(journalPath,journal);await assert.rejects(authorizeCompletedPreparedUpgradeSource(state,lineage));assert.equal(reads,0)
  journal.binding.port=bindingPort;await writePrivateJson(journalPath,journal)
  const operation=await readPrivateJson(f.intentPath)as {checkpoint:{backupManifestSha256:string}},backupSHA=operation.checkpoint.backupManifestSha256
  operation.checkpoint.backupManifestSha256='0'.repeat(64);await writePrivateJson(f.intentPath,operation);await assert.rejects(authorizeCompletedPreparedUpgradeSource(state,lineage));assert.equal(reads,0);operation.checkpoint.backupManifestSha256=backupSHA;await writePrivateJson(f.intentPath,operation)
  assert.equal(await authorizeCompletedPreparedUpgradeSource(state,lineage),true);assert.equal(await ordinaryUpgradePending(state),false);assert.equal(reads,1)
  await beginOrdinaryUpgrade(state,'0.2.24');assert.deepEqual(await readFile(join(state.layout.instanceRoot,'upgrade-intent-history',hash(original)+'.json')),original)
  assert.equal(await ordinaryUpgradePending(state),true,'新intent仍正常拦启动，不复用旧内存票据')
  f.p.preparedLineage=lineage;const next=await continueOrdinaryUpgrade(state,'0.2.24',target,f.p);assert.equal(next!.version,'0.2.24')
 });assert.equal(reads,2)
})
