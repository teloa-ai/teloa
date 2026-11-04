import test from 'node:test'
import assert from 'node:assert/strict'
import {parseArguments,main} from '../src/bin.ts'
import {mkdtemp,realpath,mkdir,readFile,writeFile,rm,lstat,chmod,link,unlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {once} from 'node:events'
import {fork,type ChildProcess} from 'node:child_process'
import {resolveLayout} from '../src/layout.ts'
import {writeInstall,writePrivateJson,readPrivateJson,withInstallLock,readInstall} from '../src/state.ts'
import {resumeUpgradeInstall,upgradeResumePending,archiveCompletedUpgradeResumeJournal,completedUpgradeReceiptProvenance,type UpgradeResumePorts} from '../src/upgrade-resume.ts'
import {controlRecord,controlRequest,sleep,type ControlRecord} from '../src/service.ts'
import type {InstallState,Status} from '../src/contracts.ts'

const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex')
async function fixture(t:{after:(fn:()=>Promise<unknown>)=>unknown},dataVersion=4,versions={from:'0.2.22',to:'0.2.35'}){
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-upgrade-resume-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const home=join(root,'home'),version=versions.to,from=versions.from,layout=await resolveLayout({home,version}),state:InstallState={schema:'teloa.install/v1',id:randomUUID(),version,layout,port:3236,database:{kind:'docker'},phase:'maintenance'}
 await writeInstall(state)
 const release=async(path:string,v:string)=>{await mkdir(path,{recursive:true});await writeFile(join(path,'entry.js'),'// frozen '+v+'\n');await writePrivateJson(join(path,'release-manifest.json'),{schema:'teloa.release/v1',version:v,dshVersion:'0.2.1-rc.2',dataVersion,compatibleDataVersions:[dataVersion],files:[{path:'entry.js',sha256:digest('// frozen '+v+'\n')}]})}
 await release(layout.releaseRoot,version);await release(join(home,'releases',from),from)
 const source=join(root,'original59');await release(source,version)
 const backup=join(home+'.backups','before-'+version+'-'+randomUUID());await mkdir(backup,{recursive:true})
 const bodies={'database.dump':'original DB archive','installation.json':JSON.stringify({workspaceRoot:layout.workspaceRoot,port:state.port})}
 for(const [path,body] of Object.entries(bodies))await writeFile(join(backup,path),body,{mode:0o600})
 await writePrivateJson(join(backup,'backup-manifest.json'),{schema:'teloa.backup/v1',id:randomUUID(),createdAt:new Date().toISOString(),installId:state.id,version:from,dataVersion,externalWorkspaceIncluded:false,files:Object.entries(bodies).map(([path,body])=>({path,sha256:digest(body)}))})
 const receipt={from,to:version,backup,restartId:randomUUID(),status:'failed'};await writePrivateJson(join(layout.instanceRoot,'upgrade.json'),receipt)
 const original=await readFile(join(layout.instanceRoot,'upgrade.json')),journal=join(layout.instanceRoot,'upgrade-resume.json')
 let app:Status['app']='stopped',control:ControlRecord|null=null,starts=0,prepares=0
 const status=():Status=>({app,database:'ready',activeWork:0,version,port:state.port})
 const p:UpgradeResumePorts={status:async()=>status(),control:async()=>control,prepare:async()=>{prepares++},start:async(s)=>{starts++;control={pid:process.pid,startedAt:new Date().toISOString(),nonce:randomUUID(),installId:s.id,port:45000,secret:'a'.repeat(64)};app='ready';await writeInstall({...s,phase:'prepared'});return status()}}
 const run=(s=state,src=source)=>withInstallLock(home,()=>resumeUpgradeInstall(s,version,src,p))
 return {root,home,state,source,backup,receipt,original,journal,p,status,run,setApp:(value:Status['app'])=>{app=value},getControl:()=>control,setControl:(value:ControlRecord|null)=>{control=value},counts:()=>({starts,prepares})}
}

async function laterFailure(t:{after:(fn:()=>Promise<unknown>)=>unknown},versions={previous:4,source:4,target:4},releases={previousFrom:'0.2.22',previousTo:'0.2.35',from:'0.2.59',to:'0.2.60'}){
 const f=await fixture(t,versions.previous,{from:releases.previousFrom,to:releases.previousTo});await f.run();const oldJournal=await readFile(f.journal)
 const version=releases.to,from=releases.from,layout=await resolveLayout({home:f.home,version,workspace:f.state.layout.workspaceRoot}),state:InstallState={...f.state,version,layout,phase:'maintenance'}
 const release=async(path:string,v:string,dataVersion:number)=>{await mkdir(path,{recursive:true});const body='// next frozen '+v+'\n';await writeFile(join(path,'entry.js'),body);await writePrivateJson(join(path,'release-manifest.json'),{schema:'teloa.release/v1',version:v,dshVersion:'0.2.1-rc.2',dataVersion,compatibleDataVersions:[dataVersion],files:[{path:'entry.js',sha256:digest(body)}]})}
 await release(layout.releaseRoot,version,versions.target);if(from!==releases.previousTo)await release(join(f.home,'releases',from),from,versions.source);const source=join(f.root,'next-source');await release(source,version,versions.target)
 const backup=join(f.home+'.backups','before-'+version+'-'+randomUUID());await mkdir(backup,{recursive:true});const bodies={'database.dump':'next original DB archive','installation.json':JSON.stringify({workspaceRoot:layout.workspaceRoot,port:state.port})}
 for(const[path,body]of Object.entries(bodies))await writeFile(join(backup,path),body,{mode:0o600})
 await writePrivateJson(join(backup,'backup-manifest.json'),{schema:'teloa.backup/v1',id:randomUUID(),createdAt:new Date().toISOString(),installId:state.id,version:from,dataVersion:versions.source,externalWorkspaceIncluded:false,files:Object.entries(bodies).map(([path,body])=>({path,sha256:digest(body)}))})
 const receipt={from,to:version,backup,restartId:randomUUID(),status:'failed'};await writePrivateJson(join(layout.instanceRoot,'upgrade.json'),receipt);await writeInstall(state)
 let app:Status['app']='stopped',control:ControlRecord|null=null,starts=0,prepares=0
 const status=():Status=>({app,database:'ready',activeWork:0,version,port:state.port}),p:UpgradeResumePorts={status:async()=>status(),control:async()=>control,prepare:async()=>{prepares++},start:async s=>{starts++;control={pid:process.pid,startedAt:new Date().toISOString(),nonce:randomUUID(),installId:s.id,port:45000,secret:'b'.repeat(64)};app='ready';await writeInstall({...s,phase:'prepared'});return status()}}
 return {...f,state,source,backup,receipt,oldJournal,p,run:(s=state)=>withInstallLock(f.home,()=>resumeUpgradeInstall(s,version,source,p)),setApp:(value:Status['app'])=>{app=value},counts:()=>({starts,prepares}),archive:join(layout.instanceRoot,'upgrade-resume-history',digest(oldJournal)+'.json')}
}

async function ordinarySwitching(f:Awaited<ReturnType<typeof laterFailure>>){
 const home=await lstat(f.home),source={...f.state,version:f.receipt.from,layout:await resolveLayout({home:f.home,version:f.receipt.from,workspace:f.state.layout.workspaceRoot}),phase:'stopped' as const}
 const intent={schema:'teloa.ordinary-upgrade-intent/v1',id:f.receipt.restartId,source,device:home.dev,inode:home.ino,to:f.state.version,sourceManifestSha256:digest(await readFile(join(source.layout.releaseRoot,'release-manifest.json'))),targetManifestSha256:digest(await readFile(join(f.state.layout.releaseRoot,'release-manifest.json'))),databaseConfigSha256:null,backup:f.backup,purpose:'ordinary-upgrade'}
 // 正常 intent 的备份目录由 intent ID 固定；复用同一已验证备份，不新建保护点。
 const backup=join(f.home+'.backups','before-'+f.state.version+'-'+intent.id)
 await (await import('node:fs/promises')).rename(f.backup,backup);intent.backup=backup;f.backup=backup;f.receipt.backup=backup
 const checkpoint={schema:'teloa.ordinary-upgrade-checkpoint/v1',intentSha256:digest(JSON.stringify(intent)),phase:'switch-issued',attempts:[],backupManifestSha256:digest(await readFile(join(backup,'backup-manifest.json')))}
 await writePrivateJson(join(f.state.layout.instanceRoot,'upgrade-intent.json'),{intent,checkpoint})
 await writePrivateJson(join(f.state.layout.instanceRoot,'upgrade.json'),{...f.receipt,status:'switching'})
 return {intent,checkpoint}
}

test('已完成遗留journal按身份与固定证据归档，不按RC稳定或降号版本排序',async t=>{
 const sequences=[
  {previousFrom:'0.2.131',previousTo:'0.2.132',from:'0.2.11-rc.6',to:'0.2.11-rc.9'},
  {previousFrom:'0.2.11-rc.1',previousTo:'0.2.11-rc.2',from:'0.2.11-rc.6',to:'0.2.11-rc.9'},
  {previousFrom:'0.2.11-rc.1',previousTo:'0.2.11-rc.2',from:'0.2.11-rc.2',to:'0.2.11'},
  {previousFrom:'0.2.131',previousTo:'0.2.132',from:'0.2.20',to:'0.2.11'},
 ]
 for(const releases of sequences)await t.test(releases.previousTo+' -> '+releases.from+' -> '+releases.to,async sub=>{
  const f=await laterFailure(sub,{previous:16,source:16,target:16},releases);await ordinarySwitching(f);await chmod(f.journal,0o400)
  const originalInfo=await lstat(f.journal),receipt=await readFile(join(f.state.layout.instanceRoot,'upgrade.json'))
  const archived=await withInstallLock(f.home,()=>archiveCompletedUpgradeResumeJournal(f.state));assert.deepEqual(archived,{archived:true,path:f.archive,sha256:digest(f.oldJournal)})
  assert.deepEqual(await readFile(f.archive),f.oldJournal);const info=await lstat(f.archive);assert.equal(info.ino,originalInfo.ino);assert.equal(info.dev,originalInfo.dev);assert.equal(info.mode,originalInfo.mode)
  assert.deepEqual(await readFile(join(f.state.layout.instanceRoot,'upgrade.json')),receipt);assert.deepEqual(f.counts(),{starts:0,prepares:0})
  assert.equal((await f.run()).phase,'ready');assert.deepEqual(f.counts(),{starts:1,prepares:1});assert.deepEqual(await readFile(f.archive),f.oldJournal)
 })
})

test('跨轮归档必须验证当前普通intent且不能重用旧轮操作或attempt身份',async t=>{
 for(const kind of ['valid-failed','wrong-receipt','bad-checkpoint','old-operation','old-attempt','old-home-inode','old-port','old-workspace','missing-process'] as const)await t.test(kind,async sub=>{
  const f=await laterFailure(sub),old=JSON.parse(f.oldJournal.toString()) as {binding:{originalReceipt:{restartId:string};inode:number;port:number;workspace:string};attempts:Array<{requestId:string;process?:unknown}>}
  if(kind==='old-operation')f.receipt.restartId=old.binding.originalReceipt.restartId
  if(kind==='old-attempt')f.receipt.restartId=old.attempts.at(-1)!.requestId
  const operation=await ordinarySwitching(f),receiptPath=join(f.state.layout.instanceRoot,'upgrade.json')
  // failed 不能绕过已存在的普通 intent；合法原 failed 同样可被证明并归档。
  await writePrivateJson(receiptPath,{...f.receipt,status:'failed'})
  if(kind==='wrong-receipt')await writePrivateJson(receiptPath,{...f.receipt,restartId:randomUUID(),status:'failed'})
  if(kind==='bad-checkpoint')await writePrivateJson(join(f.state.layout.instanceRoot,'upgrade-intent.json'),{...operation,checkpoint:{...operation.checkpoint,backupManifestSha256:'0'.repeat(64)}})
  if(kind==='old-home-inode')old.binding.inode++
  if(kind==='old-port')old.binding.port++
  if(kind==='old-workspace')old.binding.workspace=join(f.root,'foreign-workspace')
  if(kind==='missing-process')delete old.attempts.at(-1)!.process
  if(['old-home-inode','old-port','old-workspace','missing-process'].includes(kind))await writePrivateJson(f.journal,old)
  const bytes=await readFile(f.journal),receipt=await readFile(receiptPath),state=await readFile(join(f.state.layout.instanceRoot,'state.json'))
  if(kind==='valid-failed'){
   assert.equal((await withInstallLock(f.home,()=>archiveCompletedUpgradeResumeJournal(f.state))).archived,true)
   assert.deepEqual(await readFile(f.archive),f.oldJournal)
  }else{
   await assert.rejects(withInstallLock(f.home,()=>archiveCompletedUpgradeResumeJournal(f.state)))
   assert.deepEqual(await readFile(f.journal),bytes);await assert.rejects(lstat(join(f.state.layout.instanceRoot,'upgrade-resume-history',digest(bytes)+'.json')),{code:'ENOENT'})
  }
  assert.deepEqual(await readFile(receiptPath),receipt);assert.deepEqual(await readFile(join(f.state.layout.instanceRoot,'state.json')),state);assert.deepEqual(f.counts(),{starts:0,prepares:0})
 })
})

test('completed provenance区分私密control端口与app端口，保留世代身份及固定证据校验',async t=>{
 for(const kind of ['valid','foreign-process','invalid-control-port','bad-nonce','bad-time','binding-app-port','wrong-attempt','target-hash','backup-hash'] as const)await t.test(kind,async sub=>{
  const f=await fixture(sub),ready=await f.run(),receipt=await readPrivateJson(join(f.state.layout.instanceRoot,'upgrade.json')),j=await readPrivateJson(f.journal) as {binding:{port:number;backupManifestSha256:string};attempts:Array<{requestId:string;process:{installId:string;port:number;nonceSha256:string;startedAt:string}}>}
  assert.equal(ready.port,3236);assert.equal(j.binding.port,ready.port);assert.equal(j.attempts.at(-1)!.process.port,45000)
  if(kind==='foreign-process')j.attempts.at(-1)!.process.installId=randomUUID()
  if(kind==='invalid-control-port')j.attempts.at(-1)!.process.port=65536
  if(kind==='bad-nonce')j.attempts.at(-1)!.process.nonceSha256='invalid'
  if(kind==='bad-time')j.attempts.at(-1)!.process.startedAt='invalid'
  if(kind==='binding-app-port')j.binding.port++
  if(kind==='wrong-attempt')j.attempts.at(-1)!.requestId=randomUUID()
  if(kind==='backup-hash')j.binding.backupManifestSha256='0'.repeat(64)
  if(kind!=='valid'&&kind!=='target-hash')await writePrivateJson(f.journal,j)
  const journal=await readFile(f.journal),receiptPath=join(f.state.layout.instanceRoot,'upgrade.json'),receiptBytes=await readFile(receiptPath),target=kind==='target-hash'?'0'.repeat(64):digest(await readFile(join(ready.layout.releaseRoot,'release-manifest.json')))
  const proof=()=>completedUpgradeReceiptProvenance(ready,receipt,f.receipt.restartId,target)
  if(kind==='valid'){
   const refs=await proof();assert.deepEqual(refs.map(x=>x.path),[f.journal,join(ready.layout.instanceRoot,'upgrade-failures',digest(f.original)+'.json'),join(f.backup,'backup-manifest.json')])
   for(const ref of refs)assert.equal(digest(await readFile(ref.path)),ref.sha256)
  }else await assert.rejects(proof())
  assert.deepEqual(await readFile(f.journal),journal);assert.deepEqual(await readFile(receiptPath),receiptBytes);assert.deepEqual(f.counts(),{starts:1,prepares:1})
 })
})

test('普通switching已ready后本人明确stop，同intent仅从stopped续办一次且不再备份或stage',async t=>{
 for(const oldJournal of [false,true])await t.test(oldJournal?'archive-old-completed':'no-current-journal',async sub=>{
  const f=await laterFailure(sub);await ordinarySwitching(f);if(!oldJournal)await unlink(f.journal)
  const receiptPath=join(f.state.layout.instanceRoot,'upgrade.json'),receipt=await readFile(receiptPath),backup=await readFile(join(f.backup,'backup-manifest.json')),target=await readFile(join(f.state.layout.releaseRoot,'release-manifest.json')),backups=await (await import('node:fs/promises')).readdir(f.home+'.backups')
  // 注入端口模拟普通up已ready；正式stopService写stopped，而非手造maintenance。
  const ready:InstallState={...f.state,phase:'ready'};f.setApp('ready');await writeInstall(ready)
  await assert.rejects(f.run(ready));assert.deepEqual(f.counts(),{starts:0,prepares:0})
  const stopped:InstallState={...ready,phase:'stopped'};f.setApp('stopped');await writeInstall(stopped)
  const result=await f.run(stopped);assert.equal(result.phase,'ready');assert.deepEqual(f.counts(),{starts:1,prepares:1})
  assert.deepEqual(await readFile(join(f.backup,'backup-manifest.json')),backup);assert.deepEqual(await readFile(join(result.layout.releaseRoot,'release-manifest.json')),target);assert.deepEqual(await (await import('node:fs/promises')).readdir(f.home+'.backups'),backups)
  const complete=await readPrivateJson(receiptPath) as {from:string;to:string;backup:string;status:string};const original=JSON.parse(receipt.toString());assert.equal(complete.status,'complete');assert.equal(complete.from,original.from);assert.equal(complete.to,original.to);assert.equal(complete.backup,original.backup)
  if(oldJournal)assert.deepEqual(await readFile(f.archive),f.oldJournal)
  assert.equal((await f.run(result)).phase,'ready');assert.deepEqual(f.counts(),{starts:1,prepares:1})
 })
})

test('stopped豁免只属于完整当前switching intent；legacy、错intent、宿主不明及未结journal拒绝',async t=>{
 for(const kind of ['no-intent','wrong-intent','failed-receipt','host-ready','host-unknown','launching-journal','unknown-journal'] as const)await t.test(kind,async sub=>{
  const f=await laterFailure(sub);if(kind!=='no-intent')await ordinarySwitching(f)
  if(kind==='wrong-intent')await writePrivateJson(join(f.state.layout.instanceRoot,'upgrade.json'),{...f.receipt,status:'switching',restartId:randomUUID()})
  if(kind==='failed-receipt')await writePrivateJson(join(f.state.layout.instanceRoot,'upgrade.json'),{...f.receipt,status:'failed'})
  if(kind==='launching-journal'||kind==='unknown-journal'){
   const journal=await readPrivateJson(f.journal) as {attempts:Array<{phase:string}>};journal.attempts.at(-1)!.phase=kind==='launching-journal'?'launching':'unknown';await writePrivateJson(f.journal,journal)
  }
  // 宿主结果不明不得因state写着stopped而启动；用无journal分支隔离实际端口核验。
  if(kind==='host-ready'||kind==='host-unknown'){await unlink(f.journal);f.setApp(kind==='host-ready'?'ready':'unknown')}
  const stopped:InstallState={...f.state,phase:'stopped'};await writeInstall(stopped);const receipt=await readFile(join(stopped.layout.instanceRoot,'upgrade.json')),state=await readFile(join(stopped.layout.instanceRoot,'state.json'))
  await assert.rejects(f.run(stopped));assert.deepEqual(f.counts(),{starts:0,prepares:0});assert.deepEqual(await readFile(join(stopped.layout.instanceRoot,'upgrade.json')),receipt);assert.deepEqual(await readFile(join(stopped.layout.instanceRoot,'state.json')),state)
  await assert.rejects(lstat(f.archive),{code:'ENOENT'})
 })
})

test('旧completed跨轮journal保全原字节和权限后续当前失败，同轮再次收口不启动',async t=>{
 const f=await laterFailure(t);await chmod(f.journal,0o400)
 const ready=await f.run();assert.equal(ready.phase,'ready');assert.deepEqual(f.counts(),{starts:1,prepares:1})
 assert.deepEqual(await readFile(f.archive),f.oldJournal);assert.equal((await lstat(f.archive)).mode&0o777,0o400)
 const current=await readPrivateJson(f.journal) as {binding:{from:string;to:string;backup:string}};assert.equal(current.binding.from,'0.2.59');assert.equal(current.binding.to,'0.2.60');assert.equal(current.binding.backup,f.backup)
 assert.equal((await f.run(ready)).phase,'ready');assert.deepEqual(f.counts(),{starts:1,prepares:1})
})

test('data5到6失败续办分别核对旧completed轮与本轮原发行备份版本',async t=>{
 for(const previous of [5,4])await t.test('previous-data'+previous,async sub=>{
  const f=await laterFailure(sub,{previous,source:5,target:6}),prepare=f.p.prepare
  const backupBytes=await readFile(join(f.backup,'backup-manifest.json'))
  f.p.prepare=async(s,backup,sourceData,targetData)=>{assert.equal(backup,f.backup);assert.equal(sourceData,5);assert.equal(targetData,6);await prepare(s,backup,sourceData,targetData)}
  assert.equal((await f.run()).phase,'ready');assert.deepEqual(f.counts(),{starts:1,prepares:1})
  assert.deepEqual(await readFile(f.archive),f.oldJournal)
  assert.deepEqual(await readFile(join(f.backup,'backup-manifest.json')),backupBytes)
  const current=await readPrivateJson(f.journal) as {binding:{from:string;to:string;backup:string}}
  assert.equal(current.binding.from,f.receipt.from);assert.equal(current.binding.to,f.state.version);assert.equal(current.binding.backup,f.backup)
 })
})

test('旧completed原from退役不阻断data5到6续办，旧目标与备份固定哈希仍不可变',async t=>{
 for(const kind of ['missing-from','manifest-only-from','target-manifest-changed','backup-manifest-changed'] as const)await t.test(kind,async sub=>{
  const f=await laterFailure(sub,{previous:5,source:5,target:6}),old=JSON.parse(f.oldJournal.toString()) as {binding:{from:string;to:string;backup:string}}
  const oldFrom=join(f.home,'releases',old.binding.from)
  if(kind==='missing-from')await rm(oldFrom,{recursive:true})
  if(kind==='manifest-only-from')await unlink(join(oldFrom,'entry.js'))
  if(kind==='target-manifest-changed'||kind==='backup-manifest-changed'){
   const path=kind==='target-manifest-changed'?join(f.home,'releases',old.binding.to,'release-manifest.json'):join(old.binding.backup,'backup-manifest.json')
   await writeFile(path,Buffer.concat([await readFile(path),Buffer.from('\n')]))
   await assert.rejects(f.run());assert.deepEqual(f.counts(),{starts:0,prepares:0})
   assert.deepEqual(await readFile(f.journal),f.oldJournal);await assert.rejects(lstat(f.archive),{code:'ENOENT'});return
  }
  assert.equal((await f.run()).phase,'ready');assert.deepEqual(f.counts(),{starts:1,prepares:1})
  assert.deepEqual(await readFile(f.archive),f.oldJournal)
 })
})

test('foreign未完成或身份不明journal一律拒绝且不归档、不准备或启动',async t=>{
 for(const kind of ['launching','unknown','failed','identity','target'] as const)await t.test(kind,async sub=>{
  const f=await laterFailure(sub),j=await readPrivateJson(f.journal) as {binding:{installId:string;to:string};attempts:Array<{phase:string}>}
  if(kind==='identity')j.binding.installId=randomUUID();else if(kind==='target')j.binding.to='0.2.61';else j.attempts.at(-1)!.phase=kind
  await writePrivateJson(f.journal,j);const before=await readFile(f.journal),receipt=await readFile(join(f.state.layout.instanceRoot,'upgrade.json'))
  await assert.rejects(f.run());assert.deepEqual(f.counts(),{starts:0,prepares:0});assert.deepEqual(await readFile(f.journal),before);assert.deepEqual(await readFile(join(f.state.layout.instanceRoot,'upgrade.json')),receipt);await assert.rejects(lstat(f.archive),{code:'ENOENT'})
 })
})

test('归档原子保全后中断可继续；已移出live且尚未建新journal也可继续',async t=>{
 for(const removed of [false,true])await t.test(removed?'after-live-removal':'after-archive-link',async sub=>{
  const f=await laterFailure(sub);await mkdir(join(f.state.layout.instanceRoot,'upgrade-resume-history'),{mode:0o700});await link(f.journal,f.archive);if(removed)await unlink(f.journal)
  assert.equal((await f.run()).phase,'ready');assert.deepEqual(f.counts(),{starts:1,prepares:1});assert.deepEqual(await readFile(f.archive),f.oldJournal)
 })
})

test('独立归档helper只整理元数据且必须持安装锁，不改当前失败回执或状态',async t=>{
 const f=await laterFailure(t),state=await readFile(join(f.state.layout.instanceRoot,'state.json')),receipt=await readFile(join(f.state.layout.instanceRoot,'upgrade.json'))
 await assert.rejects(archiveCompletedUpgradeResumeJournal(f.state))
 const result=await withInstallLock(f.home,()=>archiveCompletedUpgradeResumeJournal(f.state));assert.deepEqual(result,{archived:true,path:f.archive,sha256:digest(f.oldJournal)})
 assert.deepEqual(await readFile(f.archive),f.oldJournal);assert.deepEqual(await readFile(join(f.state.layout.instanceRoot,'state.json')),state);assert.deepEqual(await readFile(join(f.state.layout.instanceRoot,'upgrade.json')),receipt);assert.deepEqual(f.counts(),{starts:0,prepares:0})
 assert.deepEqual(await withInstallLock(f.home,()=>archiveCompletedUpgradeResumeJournal(f.state)),{archived:false})
 assert.equal((await f.run()).phase,'ready');assert.deepEqual(f.counts(),{starts:1,prepares:1})
})

test('同名历史若字节不符不得覆盖，也不能移出live journal',async t=>{
 const f=await laterFailure(t);await mkdir(join(f.state.layout.instanceRoot,'upgrade-resume-history'),{mode:0o700});await writeFile(f.archive,'unknown history',{mode:0o600})
 await assert.rejects(f.run());assert.deepEqual(await readFile(f.journal),f.oldJournal);assert.equal(await readFile(f.archive,'utf8'),'unknown history');assert.deepEqual(f.counts(),{starts:0,prepares:0})
})

test('普通升级失败后只有显式resume可绑定原冻结目标，source-release不能用于普通升级',()=>{
 assert.deepEqual(parseArguments(['upgrade','--to','0.2.35','--resume','--source-release','/frozen59']),{command:'upgrade',options:{to:'0.2.35',resume:true,'source-release':'/frozen59'}})
 assert.throws(()=>parseArguments(['upgrade','--to','0.2.35','--source-release','/other']))
 assert.throws(()=>parseArguments(['upgrade','--resume']))
 assert.throws(()=>parseArguments(['up','--resume']))
})

test('原完整备份/冻结清单同身份续办一次，保留原失败字节；完成回执再次读取不启动',async t=>{
 const f=await fixture(t),before=await readFile(join(f.state.layout.releaseRoot,'release-manifest.json'))
 const ready=await f.run();assert.equal(ready.phase,'ready');assert.deepEqual(f.counts(),{starts:1,prepares:1})
 const current=await readPrivateJson(join(f.state.layout.instanceRoot,'upgrade.json')) as {restartId:string;status:string;backup:string}
 assert.equal(current.status,'complete');assert.equal(current.backup,f.backup);assert.notEqual(current.restartId,f.receipt.restartId)
 assert.deepEqual(await readFile(join(f.state.layout.instanceRoot,'upgrade-failures',digest(f.original)+'.json')),f.original)
 assert.deepEqual(await readFile(join(f.state.layout.releaseRoot,'release-manifest.json')),before)
 assert.equal(await upgradeResumePending(ready),false)
 assert.equal((await f.run(ready)).phase,'ready');assert.deepEqual(f.counts(),{starts:1,prepares:1})
})

test('错安装/原版本/目标/源包或坏备份在准备与启动之前拒绝，不另建保护点',async t=>{
 for(const change of ['install','from','to','source','valid-source-difference','backup','workspace','lock','switching','complete'] as const){
  await t.test(change,async sub=>{
   const f=await fixture(sub)
   if(change==='install')await writeInstall({...f.state,id:randomUUID()})
   if(change==='from')await writePrivateJson(join(f.state.layout.instanceRoot,'upgrade.json'),{...f.receipt,from:'0.2.21'})
   if(change==='to')await writePrivateJson(join(f.state.layout.instanceRoot,'upgrade.json'),{...f.receipt,to:'0.2.36'})
   if(change==='source')await writeFile(join(f.source,'entry.js'),'changed target')
   if(change==='valid-source-difference'){
    const body='valid other same-version bytes';await writeFile(join(f.source,'entry.js'),body)
    const path=join(f.source,'release-manifest.json'),manifest=await readPrivateJson(path) as {files:Array<{path:string;sha256:string}>};manifest.files[0]!.sha256=digest(body);await writePrivateJson(path,manifest)
   }
   if(change==='backup')await writeFile(join(f.backup,'database.dump'),'bad original backup')
   if(change==='workspace'){
    const file=join(f.backup,'installation.json'),body=JSON.stringify({workspaceRoot:join(f.root,'another-workspace'),port:f.state.port});await writeFile(file,body)
    const manifest=await readPrivateJson(join(f.backup,'backup-manifest.json')) as {files:Array<{path:string;sha256:string}>};manifest.files.find(row=>row.path==='installation.json')!.sha256=digest(body);await writePrivateJson(join(f.backup,'backup-manifest.json'),manifest)
   }
   if(change==='switching'||change==='complete')await writePrivateJson(join(f.state.layout.instanceRoot,'upgrade.json'),{...f.receipt,status:change})
   const before=await readFile(join(f.state.layout.instanceRoot,'upgrade.json'))
   if(change==='lock')await assert.rejects(resumeUpgradeInstall(f.state,f.state.version,f.source,f.p))
   else await assert.rejects(f.run())
   assert.deepEqual(f.counts(),{starts:0,prepares:0});assert.deepEqual(await readFile(join(f.state.layout.instanceRoot,'upgrade.json')),before)
  })
 }
})

test('已运行或失联的原宿主不得作为failed原应用停止证明',async t=>{
 for(const app of ['ready','starting','unknown','failed'] as const){const f=await fixture(t);f.setApp(app);await assert.rejects(f.run());assert.deepEqual(f.counts(),{starts:0,prepares:0})}
})

test('正式启动明确失败且已回收为stopped，记录终态后才准下一次本人显式续办',async t=>{
 const f=await fixture(t),start=f.p.start;let attempts=0
 f.p.start=async(s,id)=>{if(++attempts===1)throw Error('known terminal startup failure');return start(s,id)}
 await assert.rejects(f.run(),/known terminal/)
 const failed=await readPrivateJson(f.journal) as {attempts:Array<{phase:string;requestId:string}>};assert.equal(failed.attempts[0]!.phase,'failed')
 assert.equal(await upgradeResumePending(f.state),false);assert.deepEqual(await readFile(join(f.state.layout.instanceRoot,'upgrade.json')),f.original)
 const ready=await f.run(),final=await readPrivateJson(f.journal) as typeof failed
 assert.equal(ready.phase,'ready');assert.equal(attempts,2);assert.equal(final.attempts.length,2);assert.notEqual(final.attempts[0]!.requestId,final.attempts[1]!.requestId);assert.equal(final.attempts[0]!.phase,'failed')
})

test('启动结果未知且没有世代证明时不能因稍后stopped就重新启动',async t=>{
 const f=await fixture(t),start=f.p.start
 f.p.start=async(s,id)=>{const value=await start(s,id);f.setApp('unknown');return value}
 await assert.rejects(f.run());assert.equal(await upgradeResumePending(f.state),true)
 f.setApp('stopped');await assert.rejects(f.run());assert.deepEqual(f.counts(),{starts:1,prepares:1})
 for(const command of [['up','--no-open'],['restart','--no-open'],['upgrade','--to',f.state.version]])await assert.rejects(main([...command,'--home',f.home]),/原升级启动尚待核对/)
 await assert.rejects(main(['upgrade','--to',f.state.version,'--resume','--home',f.home]),/source-release/)
})

test('已认证并持久绑定的新世代可只读收口；同PID但nonce变化仍不得冒认原启动',async t=>{
 for(const changed of [false,true]){
  const f=await fixture(t),start=f.p.start,status=f.p.status;let completed=false
  f.p.start=async(s,id)=>{const value=await start(s,id);await sleep(60);completed=true;return value}
  f.p.status=async s=>completed?{...(await status(s)),app:'unknown'}:status(s)
  await assert.rejects(f.run());const journal=await readPrivateJson(f.journal) as {attempts:Array<{phase:string;process?:unknown}>};assert.equal(journal.attempts[0]!.phase,'unknown');assert.ok(journal.attempts[0]!.process)
  f.p.status=status;if(changed)f.setControl({...f.getControl()!,nonce:randomUUID()})
  const prepared=await readInstall(f.state.layout);assert.ok(prepared)
  if(changed)await assert.rejects(f.run(prepared))
  else assert.equal((await f.run(prepared)).phase,'ready')
  assert.deepEqual(f.counts(),{starts:1,prepares:1})
 }
})

test('真实独立OS宿主的私密控制回包绑定世代，丢收口后只恢复原启动不再spawn',async t=>{
 const f=await fixture(t);let child:ChildProcess|undefined,spawned=0,hideReady=true
 const entry=join(f.root,'host.mjs')
 await writeFile(entry,`import {createServer} from 'node:http';import {writeFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
 process.on('message',async({path,installId,version,port})=>{const nonce=randomUUID(),secret=randomUUID().replaceAll('-','').repeat(2);const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;const value=JSON.parse(body);if(req.headers.authorization!=='Bearer '+secret||value.nonce!==nonce||value.installId!==installId){res.writeHead(403).end();return}res.setHeader('content-type','application/json');res.end(JSON.stringify({nonce,installId,ok:true,value:{app:'ready',database:'ready',activeWork:0,version,port}}));if(req.url==='/stop')server.close(()=>process.exit(0))});server.listen(0,'127.0.0.1',async()=>{await writeFile(path,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString(),nonce,installId,port:server.address().port,secret}),{mode:0o600});process.send('ready')})})`)
 f.p.control=controlRecord
 f.p.status=async s=>{if(!await controlRecord(s))return {...f.status(),app:'stopped'};const value=await controlRequest(s,'status') as Status;return hideReady?{...value,app:'starting'}:value}
 f.p.start=async(s)=>{spawned++;await writeInstall({...s,phase:'prepared'});child=fork(entry,[],{stdio:['ignore','ignore','ignore','ipc']});const ready=once(child,'message');child.send({path:join(s.layout.instanceRoot,'control.json'),installId:s.id,version:s.version,port:s.port});await ready;await sleep(80);return f.status()}
 try{
  await assert.rejects(f.run());assert.equal(await upgradeResumePending(f.state),true)
  hideReady=false;const prepared=await readInstall(f.state.layout);assert.ok(prepared);assert.equal((await f.run(prepared)).phase,'ready');assert.equal(spawned,1)
  const journal=await readPrivateJson(f.journal) as {attempts:Array<{process:{pid:number}}>} ;assert.equal(journal.attempts[0]!.process.pid,child!.pid)
 }finally{if(child&&child.exitCode===null){const exited=once(child,'exit');await controlRequest(f.state,'stop');await exited}}
})
