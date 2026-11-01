import {createHash,randomUUID} from 'node:crypto'
import {readFile,lstat,realpath,open,mkdir,rename,link} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {isDeepStrictEqual} from 'node:util'
import type {InstallState,Status} from './contracts.ts'
import {exactVersion,resolveLayout,canonical} from './layout.ts'
import {readPrivateJson,writePrivateJson,writeInstall,privateDirectory} from './state.ts'
import {verifyRelease} from './releases.ts'
import {createBackup,verifyBackup} from './maintenance.ts'
import {serviceStatus} from './service.ts'
import {stopDatabase,databaseConfig} from './database.ts'
import {canUpgradeData} from './data-version.ts'
import {matchesOrdinaryDatabaseConfig} from './upgrade-database-binding.ts'

type Intent={schema:'teloa.ordinary-upgrade-intent/v1';id:string;source:InstallState;device:number;inode:number;to:string;sourceManifestSha256:string;targetManifestSha256:string;databaseConfigSha256:string|null;backup:string;purpose:'ordinary-upgrade'}
type Attempt={id:string;staging:string;status:'issued'|'interrupted'|'failed'}
type Checkpoint={schema:'teloa.ordinary-upgrade-checkpoint/v1';intentSha256:string;phase:'intent'|'backup-issued'|'backup-ready'|'switch-issued';attempts:Attempt[];backupManifestSha256?:string}
export type OrdinaryUpgradePorts={status:(state:InstallState)=>Promise<Status>;stopDatabase:(state:InstallState)=>Promise<void>;backup:typeof createBackup}
const ports:OrdinaryUpgradePorts={status:serviceStatus,stopDatabase,backup:(...args)=>createBackup(...args)}
const digest=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex')
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const denied=()=>Error('普通升级 intent、安装身份、冻结发行或备份检查点不一致；保持现场，不清除维护状态。无 intent 的旧现场请用匹配备份版本的 CLI restore 到全新目录和空库，不自动采用历史操作。')
const paths=(s:InstallState)=>({intent:join(s.layout.instanceRoot,'upgrade-intent.json'),receipt:join(s.layout.instanceRoot,'upgrade.json')})
async function optional(path:string):Promise<unknown>{try{return await readPrivateJson(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error}}
async function durable(path:string,value:unknown){await writePrivateJson(path,value);for(const p of [path,dirname(path)]){const h=await open(p,'r');try{await h.sync()}finally{await h.close()}}}
async function exists(path:string){try{await lstat(path);return true}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error}}
function readIntent(value:unknown):Intent{
 const i=value as Intent
 if(!i||Object.keys(i).sort().join(',')!=='backup,databaseConfigSha256,device,id,inode,purpose,schema,source,sourceManifestSha256,targetManifestSha256,to'||i.schema!=='teloa.ordinary-upgrade-intent/v1'||i.purpose!=='ordinary-upgrade'||!uuid(i.id)||!i.source||!exactVersion(i.to)||i.to===i.source.version||!Number.isSafeInteger(i.device)||!Number.isSafeInteger(i.inode)||![i.sourceManifestSha256,i.targetManifestSha256].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||i.databaseConfigSha256!==null&&!(typeof i.databaseConfigSha256==='string'&&/^[a-f0-9]{64}$/.test(i.databaseConfigSha256))||i.backup!==i.source.layout.home+'.backups/before-'+i.to+'-'+i.id)throw denied()
 return i
}
function readCheckpoint(value:unknown,i:Intent):Checkpoint{
 const c=value as Checkpoint
 if(!c||Object.keys(c).some(k=>!['schema','intentSha256','phase','attempts','backupManifestSha256'].includes(k))||c.schema!=='teloa.ordinary-upgrade-checkpoint/v1'||c.intentSha256!==digest(JSON.stringify(i))||!['intent','backup-issued','backup-ready','switch-issued'].includes(c.phase)||!Array.isArray(c.attempts)||new Set(c.attempts.map(a=>a?.id)).size!==c.attempts.length||c.attempts.some(a=>!a||Object.keys(a).sort().join(',')!=='id,staging,status'||!uuid(a.id)||a.staging!==i.backup+'.incomplete-'+a.id||!['issued','interrupted','failed'].includes(a.status))||c.attempts.slice(0,-1).some(a=>a.status==='issued')||c.phase==='backup-issued'&&c.attempts.at(-1)?.status!=='issued'||['backup-ready','switch-issued'].includes(c.phase)&&!(typeof c.backupManifestSha256==='string'&&/^[a-f0-9]{64}$/.test(c.backupManifestSha256)))throw denied()
 return c
}
async function databaseFingerprint(state:InstallState){const value=await optional(databaseConfig(state));return value===undefined?null:digest(JSON.stringify(value))}
async function databaseMatches(state:InstallState,frozen:string|null){const value=await optional(databaseConfig(state));return value===undefined?frozen===null:matchesOrdinaryDatabaseConfig(state,value,frozen)}
const hasVerifiedBackup=(c:Checkpoint)=>c.phase==='backup-ready'
async function operation(state:InstallState){
 const raw=await optional(paths(state).intent) as {intent?:unknown;checkpoint?:unknown}|undefined
 if(raw===undefined)return
 if(Object.keys(raw).sort().join(',')!=='checkpoint,intent')throw denied()
 const i=readIntent(raw.intent),c=readCheckpoint(raw.checkpoint,i);return {i,c}
}
async function saveOperation(state:InstallState,i:Intent,c:Checkpoint){await durable(paths(state).intent,{intent:i,checkpoint:c})}
async function lease(state:InstallState,i?:Intent){
 const h=await lstat(state.layout.home),lock=await readPrivateJson(join(state.layout.home,'install.lock')) as {pid?:number;identity?:string}
 if(h.isSymbolicLink()||!h.isDirectory()||await realpath(state.layout.home)!==state.layout.home||lock.pid!==process.pid||!uuid(lock.identity))throw denied()
 const actual=await readPrivateJson(join(state.layout.instanceRoot,'state.json')) as InstallState
 if(!isDeepStrictEqual(actual,state)||state.layout.instanceRoot!==join(state.layout.home,'instances/default')||state.layout.releaseRoot!==join(state.layout.home,'releases',state.version))throw denied()
 if(i&&(!await databaseMatches(state,i.databaseConfigSha256)||i.device!==h.dev||i.inode!==h.ino||state.id!==i.source.id||state.port!==i.source.port||!isDeepStrictEqual(state.database,i.source.database)||state.layout.workspaceRoot!==i.source.layout.workspaceRoot||state.layout.home!==i.source.layout.home||![i.source.version,i.to].includes(state.version)||!isDeepStrictEqual(state.layout,await resolveLayout({home:state.layout.home,workspace:state.layout.workspaceRoot,version:state.version}))))throw denied()
 return {home:h,lock}
}
async function checked(state:InstallState,version:string,sourceRoot?:string){
 const ps=paths(state),raw=await operation(state);if(raw===undefined)return
 const {i,c}=raw;if(i.to!==version)throw denied();const held=await lease(state,i)
 const source=await verifyRelease(i.source.layout.releaseRoot),targetRoot=join(i.source.layout.home,'releases',i.to),target=await verifyRelease(targetRoot)
 if(await realpath(i.source.layout.releaseRoot)!==i.source.layout.releaseRoot||await realpath(targetRoot)!==targetRoot||source.version!==i.source.version||target.version!==i.to||!canUpgradeData(target,source.dataVersion)||digest(await readFile(join(i.source.layout.releaseRoot,'release-manifest.json')))!==i.sourceManifestSha256||digest(await readFile(join(targetRoot,'release-manifest.json')))!==i.targetManifestSha256||await canonical(i.backup)!==i.backup)throw denied()
 if(sourceRoot&&!isDeepStrictEqual(await verifyRelease(await realpath(sourceRoot)),target))throw denied()
 const original=JSON.stringify({intent:i,checkpoint:c})
 const guard=async()=>{const now=await lease(state,i);if(!isDeepStrictEqual(now.lock,held.lock)||JSON.stringify(await readPrivateJson(ps.intent))!==original)throw denied()}
 return {i,c,ps,source,guard,lock:held.lock}
}
/** 已有 pending intent 即使尚未写 maintenance，也不能被普通 up/restart 越过。 */
export async function ordinaryUpgradePending(state:InstallState):Promise<boolean>{
 const raw=await operation(state);if(raw===undefined)return false
 const {i}=raw,r=await optional(paths(state).receipt) as {from?:string;to?:string;backup?:string;status?:string}|undefined
 if(state.id!==i.source.id||state.port!==i.source.port||state.layout.home!==i.source.layout.home||state.layout.workspaceRoot!==i.source.layout.workspaceRoot||!isDeepStrictEqual(state.database,i.source.database))throw denied()
 return !(state.version===i.to&&['ready','stopped','prepared'].includes(state.phase)&&r?.from===i.source.version&&r.to===i.to&&r.backup===i.backup&&r.status==='complete')
}
/** 候选已 stage 并验证；必须在任何 maintenance/备份副作用前持久记录。 */
export async function beginOrdinaryUpgrade(state:InstallState,to:string):Promise<void>{
 const held=await lease(state),ps=paths(state),old=await operation(state)
 if(old!==undefined){
  if(await ordinaryUpgradePending(state))throw denied()
  await lease(state,old.i)
  const history=join(state.layout.instanceRoot,'upgrade-intent-history');await privateDirectory(history)
  const bytes=await readFile(ps.intent),target=join(history,digest(bytes)+'.json')
  try{await link(ps.intent,target)}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error}
  if(!isDeepStrictEqual(await readFile(target),bytes))throw denied()
  const h=await open(history,'r');try{await h.sync()}finally{await h.close()}
 }
 const target=await verifyRelease(join(state.layout.home,'releases',to)),source=await verifyRelease(state.layout.releaseRoot)
 if(!exactVersion(to)||to===state.version||source.version!==state.version||target.version!==to||!canUpgradeData(target,source.dataVersion))throw denied()
 const id=randomUUID(),i:Intent={schema:'teloa.ordinary-upgrade-intent/v1',id,source:state,device:held.home.dev,inode:held.home.ino,to,databaseConfigSha256:await databaseFingerprint(state),sourceManifestSha256:digest(await readFile(join(state.layout.releaseRoot,'release-manifest.json'))),targetManifestSha256:digest(await readFile(join(state.layout.home,'releases',to,'release-manifest.json'))),backup:state.layout.home+'.backups/before-'+to+'-'+id,purpose:'ordinary-upgrade'}
 if(!isDeepStrictEqual((await lease(state)).lock,held.lock))throw denied()
 await saveOperation(state,i,{schema:'teloa.ordinary-upgrade-checkpoint/v1',intentSha256:digest(JSON.stringify(i)),phase:'intent',attempts:[]})
}
/** 仅普通升级的已持锁、已登记 attempt 可从 maintenance 继续备份；不是任意 phase 豁免。 */
export async function authorizeOrdinaryUpgradeBackup(state:InstallState,output:string,id:string):Promise<string>{
 const raw=(await operation(state))?.i;if(!raw)throw denied();const v=await checked(state,raw.to)
 if(!v||raw.id!==id||state.version!==raw.source.version||!['stopped','maintenance'].includes(state.phase)||v.c.phase!=='backup-issued'||output!==raw.backup)throw denied()
 await v.guard();return v.c.attempts.at(-1)!.staging
}
/** 显式 resume：只补尚未完成的普通备份与切换检查点；不创建历史 intent、不下载、不自动 rollback。 */
export async function continueOrdinaryUpgrade(state:InstallState,to:string,sourceRoot:string,p:OrdinaryUpgradePorts=ports):Promise<InstallState|undefined>{
 const v=await checked(state,to,sourceRoot);if(!v)return
 const {i,c,ps,source}=v
 if(state.version===to){if(c.phase!=='switch-issued')throw denied();return state}
 if(!['stopped','maintenance'].includes(state.phase)||(await p.status(state)).app!=='stopped')throw denied()
 let expected=JSON.stringify({intent:i,checkpoint:c})
 const guard=async()=>{
  const actual=await readPrivateJson(join(state.layout.instanceRoot,'state.json')) as InstallState,held=await lease(actual,i)
  if(!isDeepStrictEqual(held.lock,v.lock)||!isDeepStrictEqual({...actual,phase:state.phase},state)||!['stopped','maintenance'].includes(actual.phase)||JSON.stringify(await readPrivateJson(ps.intent))!==expected)throw denied()
 }
 const save=async()=>{await guard();await saveOperation(state,i,c);expected=JSON.stringify({intent:i,checkpoint:c})}
 const verify=async(root:string)=>{const b=await verifyBackup(root),meta=await readPrivateJson(join(root,'installation.json'));if(b.installId!==state.id||b.version!==state.version||b.dataVersion!==source.dataVersion||!isDeepStrictEqual(meta,{workspaceRoot:state.layout.workspaceRoot,port:state.port}))throw denied();return digest(await readFile(join(root,'backup-manifest.json')))}
 await v.guard()
 if(await exists(i.backup)){
  const hash=await verify(i.backup);if(!c.backupManifestSha256||c.backupManifestSha256!==hash)throw denied()
 }else{
  if(c.phase==='switch-issued')throw denied()
  const last=c.attempts.at(-1)
  // 完整 staging 可正常提交；不完整或未知旧 staging 一律保留，下一次 attempt 使用新目录。
  let complete=false
  if(last&&await exists(last.staging)){
   const info=await lstat(last.staging);if(info.isSymbolicLink()||!info.isDirectory())throw denied()
   // 清单已写但 checkpoint 尚未持久时仍属未提交 attempt；保留原件，不能补造旧 SHA。
   if(c.backupManifestSha256&&await exists(join(last.staging,'backup-manifest.json'))){
    const hash=await verify(last.staging);if(hash!==c.backupManifestSha256)throw denied();await guard();await rename(last.staging,i.backup)
    const directory=await open(dirname(i.backup),'r');try{await directory.sync()}finally{await directory.close()}
    complete=true
   }
  }
  if(!complete){
   if(c.phase==='backup-ready')throw denied()
   await guard()
   await p.stopDatabase(state)
   if(last?.status==='issued')last.status='interrupted'
   const id=randomUUID(),attempt:Attempt={id,staging:i.backup+'.incomplete-'+id,status:'issued'};c.attempts.push(attempt);c.phase='backup-issued';await save()
   await mkdir(dirname(i.backup),{recursive:true,mode:0o700})
   try{await p.backup(state,i.backup,{ordinaryUpgradeId:i.id,onVerified:async staging=>{
    if(staging!==attempt.staging)throw denied();c.backupManifestSha256=await verify(staging);c.phase='backup-ready';await save()
   }})}catch(error){if(!hasVerifiedBackup(c)){attempt.status='failed';c.phase='intent';await save()}throw error}
   if(!c.backupManifestSha256||await verify(i.backup)!==c.backupManifestSha256)throw denied()
  }
 }
 // createBackup 的 finally 可能未执行；先正常回收本安装数据库，绝不从备份写回业务数据。
 await guard();await p.stopDatabase(state)
 const current=await readPrivateJson(join(state.layout.instanceRoot,'state.json')) as InstallState
 if(!isDeepStrictEqual({...current,phase:state.phase},state)||!['stopped','maintenance'].includes(current.phase))throw denied()
 state=current;c.phase='backup-ready';await save()
 await checked(state,to,sourceRoot);if((await p.status(state)).app!=='stopped')throw denied();await guard()
 const receipt={from:i.source.version,to:i.to,backup:i.backup,restartId:i.id,status:'switching'},previous=await optional(ps.receipt) as {status?:string;to?:string}|undefined
 if(previous&&!isDeepStrictEqual(previous,receipt)&&!(previous.status==='complete'&&previous.to===i.source.version))throw denied()
 c.phase='switch-issued';await save();await durable(ps.receipt,receipt)
 const next:InstallState={...state,version:to,layout:await resolveLayout({home:state.layout.home,workspace:state.layout.workspaceRoot,version:to}),phase:'maintenance'};await writeInstall(next);return next
}
/** 只有新持久 intent 与完整普通备份绑定的 switching 回执才能进入既有 post-switch resume。 */
export async function ordinarySwitchingReceipt(state:InstallState,to:string,sourceRoot:string){
 const v=await checked(state,to,sourceRoot);if(!v)return
 if(v.c.phase!=='switch-issued'||state.version!==to)throw denied()
 const b=await verifyBackup(v.i.backup),hash=digest(await readFile(join(v.i.backup,'backup-manifest.json')))
 if(b.installId!==state.id||b.version!==v.i.source.version||b.dataVersion!==v.source.dataVersion||hash!==v.c.backupManifestSha256)throw denied()
 return {from:v.i.source.version,to,backup:v.i.backup,restartId:v.i.id,status:'switching' as const}
}
