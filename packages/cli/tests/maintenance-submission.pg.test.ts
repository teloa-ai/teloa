import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink,realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {spawn,type ChildProcess} from 'node:child_process'
import {once} from 'node:events'
import {createServer} from 'node:net'
import {resolveLayout} from '../src/layout.ts'
import {writeInstall,readInstall,readPrivateJson,withInstallLock} from '../src/state.ts'
import {prepareDatabase,databasePool,docker} from '../src/database.ts'
import {verifyBackup,verifySubmissionMaintenanceBackup} from '../src/maintenance.ts'
import {resolveSubmissionMaintenance,finishSubmissionMaintenance} from '../src/maintenance-submission.ts'
import {maintenanceHelper,inspectMaintenanceProcess} from '../src/maintenance-process.ts'
import type {InstallState} from '../src/contracts.ts'
import {TaskRunService} from '../../backend/src/work/task-runs.ts'
import {TaskRunRuntimeLinkService} from '../../backend/src/work/task-run-runtime-links.ts'
import {WorkLineageService} from '../../backend/src/work/work-lineage.ts'
import {ObjectConversationService} from '../../backend/src/work/object-conversations.ts'
import {WorkBudgetService} from '../../backend/src/work/work-budget.ts'
import {roleFixture,identity} from '../../backend/tests/role-work-test-fixture.ts'

const packages=fileURLToPath(new URL('../../',import.meta.url)),backendRequire=createRequire(join(packages,'backend/package.json')),harnessRequire=createRequire(join(packages,'harness-dsh/package.json'))
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
async function freePort(){const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));return port}

// 这是源码协议集成夹具：真实 OS supervisor/runtime/reference 进程、PG、官方持久日志；不冒充已安装旧 CLI 的产品验收。
async function releaseFixture(root:string,version:string,dataVersion:2|3|5|6){
 const url=(file:string)=>JSON.stringify(pathToFileURL(join(packages,file)).href)
 const files:Record<string,string|Buffer>={
  'package.json':JSON.stringify({name:'@teloa/cli',version,type:'module',dependencies:{pg:'8.23.0'}}),
  'packages/contract/package.json':JSON.stringify({name:'@teloa/contract',version,type:'module',exports:'./lib/index.js'}),
  'packages/contract/lib/index.js':'export const fixtureIdentity="internal-release-package"',
  'packages/backend/package.json':JSON.stringify({name:'@teloa/backend',version,type:'module'}),
  'packages/backend/lib/work/initialize-database.js':`import {initializeTeloaDatabase as initialize} from ${url('backend/src/work/initialize-database.ts')};export async function initializeTeloaDatabase(pool){await initialize(pool,{businessSqlSecretPath:${JSON.stringify(join(root,'sql-secret.json'))}})}`,
  'packages/backend/lib/work/task-runs.js':`export {TaskRunService} from ${url('backend/src/work/task-runs.ts')}`,
  'packages/backend/lib/work/task-run-submission.js':`export {TaskRunSubmissionService} from ${url('backend/src/work/task-run-submission.ts')}`,
  'packages/harness-dsh/lib/stopped-task-run-inspection.js':`import '@teloa/contract';export {readStoppedSubmissionSnapshot} from ${url('harness-dsh/src/stopped-task-run-inspection.ts')}`,
  'packages/mcp-reference/lib/main.js':`process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`,
  'scripts/runtime/native-runtime-entry.mjs':`import {createServer} from 'node:http';import {spawn} from 'node:child_process';const reference=spawn(process.execPath,[${JSON.stringify(root+'//packages/mcp-reference/lib/main.js')}],{cwd:${JSON.stringify(root)},stdio:['pipe','ignore','ignore']});const server=createServer((_,res)=>res.end('fixture'));server.listen(Number(process.argv.at(-1)),'127.0.0.1',()=>process.send('ready'));process.on('SIGTERM',()=>{reference.once('exit',()=>server.close(()=>process.exit(0)));reference.stdin.end()});`,
  'packages/cli/lib/service-entry.js':`import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';import {spawn} from 'node:child_process';import {createServer} from 'node:http';import {randomUUID,randomBytes} from 'node:crypto';const home=process.argv[2],state=JSON.parse(await readFile(join(home,'instances/default/state.json')));const child=spawn(process.execPath,[join(state.layout.releaseRoot,'scripts/runtime/native-runtime-entry.mjs'),'--profile','teloa','--no-open','--host','127.0.0.1','--port',String(state.port)],{cwd:state.layout.workspaceRoot,stdio:['ignore','ignore','ignore','ipc']});await new Promise(done=>child.once('message',done));const record={pid:process.pid,startedAt:new Date().toISOString(),nonce:randomUUID(),installId:state.id,secret:randomBytes(32).toString('hex')};const server=createServer(async(req,res)=>{let text='';for await(const part of req)text+=part;const body=JSON.parse(text);const ok=req.headers.authorization==='Bearer '+record.secret&&body.nonce===record.nonce&&body.installId===state.id;res.setHeader('content-type','application/json');res.statusCode=ok&&req.url==='/status'?200:409;res.end(JSON.stringify({...record,secret:undefined,ok:ok&&req.url==='/status',value:{app:'ready',activeWork:1},error:'原提交尚未收口'}))});await new Promise(done=>server.listen(0,'127.0.0.1',done));await writeFile(join(home,'instances/default/control.json'),JSON.stringify({...record,port:server.address().port}),{mode:0o600});process.stdout.write('ready\\n');process.on('SIGTERM',()=>{child.once('exit',()=>server.close(()=>process.exit(0)));child.kill('SIGTERM')});`,
 }
 if(dataVersion!==2)for(const name of ['maintenance-process','support.json'])files['packages/cli/libexec/'+name]=await readFile(join(packages,'cli/libexec',name))
 for(const [path,content] of Object.entries(files)){await mkdir(dirname(join(root,path)),{recursive:true,mode:0o700});await writeFile(join(root,path),content,{mode:path.endsWith('/maintenance-process')?0o700:0o600})}
 await mkdir(join(root,'node_modules'),{mode:0o700});await symlink(dirname(dirname(backendRequire.resolve('pg'))),join(root,'node_modules/pg'))
 await writeFile(join(root,'release-manifest.json'),JSON.stringify({schema:'teloa.release/v1',version,dshVersion:'0.1.6-alpha.1',dataVersion,compatibleDataVersions:[dataVersion],files:Object.entries(files).map(([path,content])=>({path,sha256:hash(content)}))}),{mode:0o600})
}

test('同安装维护桥：真实三世代退出、2→3专用备份、原子失败重入和明确解除维护',{timeout:180_000,skip:process.platform!=='darwin'||process.arch!=='arm64'},async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-submission-maintenance-'))),layout=await resolveLayout({home:join(root,'home'),workspace:join(root,'workspace'),version:'0.2.10'})
 const old:InstallState={schema:'teloa.install/v1',id:randomUUID(),version:'0.2.10',phase:'ready',port:await freePort(),database:{kind:'docker'},layout}
 let supervisor:ChildProcess|undefined,pool:any
 t.after(async()=>{
  if(supervisor&&supervisor.exitCode===null&&supervisor.signalCode===null){const exited=once(supervisor,'exit');supervisor.kill('SIGTERM');await exited}
  await pool?.end()
  const name='teloa-'+old.id
  if((await docker(['ps','-a','--filter','label=ai.teloa.install='+old.id,'--format','{{.Names}}'])).split('\n').includes(name))await docker(['rm','-f',name])
  if((await docker(['volume','ls','--filter','label=ai.teloa.install='+old.id,'--format','{{.Name}}'])).split('\n').includes(name+'-data'))await docker(['volume','rm',name+'-data'])
  await rm(root,{recursive:true,force:true})
 })
 await mkdir(layout.workspaceRoot,{recursive:true,mode:0o700});await mkdir(layout.dshHome,{recursive:true,mode:0o700})
 await releaseFixture(layout.releaseRoot,old.version,2);const candidate=join(root,'candidate');await releaseFixture(candidate,'0.2.11',3)
 await writeInstall(old);await prepareDatabase(old);pool=await databasePool(old)
 const {owner,role,taskId}=await roleFixture(pool,'employee'),sessionId='maintenance-'+randomUUID(),conversationId=randomUUID(),runtimeId=randomUUID()
 const db=await pool.connect();try{await db.query('begin');await new WorkLineageService(pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'}),runs=new TaskRunService(pool,identity,inspect)
 const link=await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:link.version},undefined,undefined,undefined,async()=>'teloa-standard'),run=(await runs.claim(owner,{runId:prepared.id})).run
 await new TaskRunRuntimeLinkService(pool).put(owner,{runId:run.id,kind:'job',nativeId:'owner:'+runtimeId+':'+sessionId,sessionId,payload:{record:'owner',runtimeId,requestId:run.nativeRequestId}})
 const budget=new WorkBudgetService(pool,identity),reservation=await budget.reserveOwnerRouting(owner,{modelRequestId:'maintenance-'+run.nativeRequestId,tokens:512});await budget.markDispatched(owner,{reservationId:reservation.id})
 const beforeBudget=(await pool.query('select * from teloa_work_budget_reservations')).rows,beforeLinks=(await pool.query('select * from teloa_task_run_runtime_links')).rows
 const beforeRun=(await pool.query('select * from teloa_task_runs where id=$1',[run.id])).rows[0]
 const {Context}=await import(pathToFileURL(harnessRequire.resolve('@deepseek-ai/cordis')).href),Jsonl=await import(pathToFileURL(harnessRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href),{SessionId,SessionSeq}=await import(pathToFileURL(harnessRequire.resolve('@deepseek-ai/dsh-session')).href),{createUserMessage}=await import(pathToFileURL(harnessRequire.resolve('@deepseek-ai/dsh-llm')).href)
 const ctx=new Context();await ctx.plugin(Jsonl,{root:join(layout.dshHome,'sessions'),compression:'zstd'})
 const handle=await ctx.sessionPersistence.create({id:SessionId(sessionId),version:4,createdAt:Date.now(),cwd:layout.workspaceRoot,isSeeded:false,agentPreset:run.agentPresetId})
 await handle.append([{type:'user/message',seq:SessionSeq(0),time:Date.now(),surfaceOp:'append',data:createUserMessage({source:{kind:'user',rpcId:randomUUID()},content:[{type:'text',text:'原首报历史，不代表未知续报未发送'}]})}]);await handle.flush();await handle.close();await ctx.fiber.dispose()
 // 夹具回退到旧结构：后续新初始化器必须真实补回处置列/表，而不是只改版本号。
 await pool.query("drop table teloa_task_run_maintenance_dispositions; drop table teloa_task_run_submissions; alter table teloa_task_runs drop column submission_disposition cascade; create function reject_maintenance_commit() returns trigger language plpgsql as $$ begin if new.state='submission_unknown' then raise exception 'fixture audit commit failure'; end if; return new; end $$; create trigger reject_maintenance_commit before update on teloa_task_runs for each row execute function reject_maintenance_commit()")
 supervisor=spawn(process.execPath,[join(layout.releaseRoot,'packages/cli/lib/service-entry.js'),layout.home],{cwd:layout.workspaceRoot,stdio:['ignore','pipe','pipe']})
 await new Promise<void>((done,fail)=>{supervisor!.stdout!.once('data',()=>done());supervisor!.once('error',fail);supervisor!.once('exit',()=>fail(Error('fixture supervisor exited before ready')))})
 const input={runId:run.id,targetVersion:'0.2.11',acknowledgeUnknown:true as const}
 await t.test('无安装锁拒绝，普通stop拒绝在途；原父子仍活',async()=>{
  await assert.rejects(resolveSubmissionMaintenance(old,input,candidate))
  await assert.rejects(withInstallLock(layout.home,()=>resolveSubmissionMaintenance(old,{...input,existingTargetOnly:true},candidate)),/只能继续本安装已有的维护意图/)
  await assert.rejects(readFile(join(layout.instanceRoot,'submission-maintenance.json')),/ENOENT/)
  const record=await readPrivateJson(join(layout.instanceRoot,'control.json')) as any
  const response=await fetch('http://127.0.0.1:'+record.port+'/stop',{method:'POST',headers:{authorization:'Bearer '+record.secret},body:JSON.stringify({nonce:record.nonce,installId:old.id})});assert.equal(response.status,409)
  assert.ok(await inspectMaintenanceProcess(await maintenanceHelper(candidate),supervisor!.pid!))
 })
 await t.test('另有后台关联时不进入维护、不发送信号',async()=>{
  await new TaskRunRuntimeLinkService(pool).put(owner,{runId:run.id,kind:'job',nativeId:runtimeId+':fixture-outstanding',sessionId,payload:{record:'job',runtimeId,requestId:run.nativeRequestId,jobId:'fixture-outstanding',status:'running'}})
  await assert.rejects(withInstallLock(layout.home,()=>resolveSubmissionMaintenance(old,input,candidate)))
  assert.equal((await readInstall(layout))!.phase,'ready');assert.ok(await inspectMaintenanceProcess(await maintenanceHelper(candidate),supervisor!.pid!))
  await assert.rejects(readFile(join(layout.instanceRoot,'submission-maintenance.json')),/ENOENT/)
  await pool.query('delete from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and native_id=$3',[owner,run.id,runtimeId+':fixture-outstanding'])
 })
 await t.test('真实退出后迁移；事务故障保留原Run未知和预算，安装仍maintenance',async()=>{
  await assert.rejects(withInstallLock(layout.home,()=>resolveSubmissionMaintenance(old,input,candidate)),/fixture audit commit failure/)
  const current=(await readInstall(layout))!;assert.equal(current.phase,'maintenance');assert.equal(current.version,'0.2.11')
  const receipt=await readPrivateJson(join(layout.instanceRoot,'submission-maintenance-exit.json')) as any
  assert.equal(receipt.signal,'SIGTERM');assert.equal(receipt.supervisor.pid,supervisor!.pid)
  assert.ok(receipt.referenceMcp);assert.equal(receipt.referenceMcp.ppid,receipt.child.pid);assert.equal(receipt.exited.length,3)
  for(const pid of receipt.exited)assert.equal(await inspectMaintenanceProcess(await maintenanceHelper(candidate),pid),null)
  assert.deepEqual((await pool.query('select id,data_version from teloa_installation')).rows,[{id:old.id,data_version:3}])
  assert.equal((await pool.query('select state from teloa_task_runs where id=$1',[run.id])).rows[0].state,'submitting')
  assert.equal((await pool.query('select * from teloa_task_run_maintenance_dispositions')).rowCount,0)
  assert.deepEqual((await pool.query('select * from teloa_work_budget_reservations')).rows,beforeBudget)
 })
 await pool.query('drop trigger reject_maintenance_commit on teloa_task_runs')
 await t.test('重入拒绝同版本候选换内容；不会以新包替换原收据的目标身份',async()=>{
  const path=join(candidate,'release-manifest.json'),original=await readFile(path),current=(await readInstall(layout))!
  const intentBefore=await readFile(join(layout.instanceRoot,'submission-maintenance.json')),receiptBefore=await readFile(join(layout.instanceRoot,'submission-maintenance-exit.json'))
  await assert.rejects(withInstallLock(layout.home,()=>resolveSubmissionMaintenance({...current,id:randomUUID()},{...input,existingTargetOnly:true},candidate)),/维护身份/)
  await assert.rejects(withInstallLock(layout.home,()=>resolveSubmissionMaintenance(current,{...input,targetVersion:'0.2.12',existingTargetOnly:true},candidate)),/维护身份/)
  await writeFile(path,JSON.stringify({...JSON.parse(original.toString()),fixtureChanged:true}),{mode:0o600})
  try{await assert.rejects(withInstallLock(layout.home,()=>resolveSubmissionMaintenance(current,{...input,existingTargetOnly:true},candidate)),/维护身份/)}finally{await writeFile(path,original,{mode:0o600})}
  assert.deepEqual(await readFile(join(layout.instanceRoot,'submission-maintenance.json')),intentBefore)
  assert.deepEqual(await readFile(join(layout.instanceRoot,'submission-maintenance-exit.json')),receiptBefore)
  assert.equal((await pool.query('select state from teloa_task_runs where id=$1',[run.id])).rows[0].state,'submitting')
 })
 const current=(await readInstall(layout))!,result=await withInstallLock(layout.home,()=>resolveSubmissionMaintenance(current,{...input,existingTargetOnly:true},candidate))
 await t.test('同一收据重入完成且幂等，历史原身份与预算保持；专用备份拒绝普通恢复/跨安装',async()=>{
  assert.equal(result.state.phase,'maintenance');assert.equal(result.state.id,old.id)
  const saved=(await pool.query('select * from teloa_task_runs where id=$1',[run.id])).rows[0]
  assert.equal(saved.state,'submission_unknown');assert.equal(saved.evidence,null);assert.equal(saved.submission_disposition.runtimeId,runtimeId)
  for(const key of Object.keys(beforeRun).filter(key=>!['state','stop_requested_at','submission_disposition'].includes(key)))assert.deepEqual(saved[key],beforeRun[key],key)
  assert.equal((await pool.query('select state from teloa_tasks where id=$1',[taskId])).rows[0].state,'paused')
  assert.deepEqual((await pool.query('select * from teloa_task_run_runtime_links')).rows,beforeLinks);assert.deepEqual((await pool.query('select * from teloa_work_budget_reservations')).rows,beforeBudget)
  const audit=(await pool.query('select * from teloa_task_run_maintenance_dispositions')).rows;assert.equal(audit.length,1);assert.equal(audit[0].audit.source,'maintenance-process-exit')
  assert.equal(audit[0].audit.processReceipt.maintenanceBinding.run.nativeRequestId,run.nativeRequestId)
  const again=await withInstallLock(layout.home,()=>resolveSubmissionMaintenance(result.state,{...input,existingTargetOnly:true},candidate));assert.deepEqual(again,result)
  assert.deepEqual((await pool.query('select * from teloa_task_run_maintenance_dispositions')).rows,audit)
  await assert.rejects(verifyBackup(result.backup),/不能通过普通restore/)
  const intent=await readPrivateJson(join(layout.instanceRoot,'submission-maintenance.json')) as any
  assert.equal((await verifySubmissionMaintenanceBackup(result.backup,{installId:old.id,home:layout.home,bindingSha256:intent.bindingSha256})).dataVersion,2)
  await assert.rejects(verifySubmissionMaintenanceBackup(result.backup,{installId:randomUUID(),home:layout.home,bindingSha256:intent.bindingSha256}),/原安装/)
  await assert.rejects(prepareDatabase(old),/数据版本尚不支持/)
 })
 await t.test('完成仍不自动启动；本人精确finish才解除维护，原Task继续暂停',async()=>{
  await assert.rejects(withInstallLock(layout.home,()=>finishSubmissionMaintenance(result.state,{runId:randomUUID(),targetVersion:'0.2.11'})))
  const candidateManifest=join(candidate,'release-manifest.json'),manifestBefore=await readFile(candidateManifest)
  await writeFile(candidateManifest,JSON.stringify({...JSON.parse(manifestBefore.toString()),fixtureChanged:true}),{mode:0o600})
  try{await assert.rejects(withInstallLock(layout.home,()=>finishSubmissionMaintenance(result.state,input,candidate)),/维护身份/)}finally{await writeFile(candidateManifest,manifestBefore,{mode:0o600})}
  const snapshot=await readPrivateJson(join(layout.instanceRoot,'submission-maintenance-log.json')) as any,original=await readFile(snapshot.path),changed=Buffer.from(original);changed[changed.length-1]=changed[changed.length-1]!^1
  await writeFile(snapshot.path,changed)
  try{await assert.rejects(withInstallLock(layout.home,()=>finishSubmissionMaintenance(result.state,input)),/维护身份/)}finally{await writeFile(snapshot.path,original)}
  const audit=(await pool.query('select audit from teloa_task_run_maintenance_dispositions where run_id=$1',[run.id])).rows[0].audit
  await pool.query("update teloa_task_run_maintenance_dispositions set audit=jsonb_set(audit,'{backupSha256}',to_jsonb($2::text)) where run_id=$1",[run.id,'e'.repeat(64)])
  try{await assert.rejects(withInstallLock(layout.home,()=>finishSubmissionMaintenance(result.state,input)),/维护身份/)}finally{await pool.query('update teloa_task_run_maintenance_dispositions set audit=$2 where run_id=$1',[run.id,JSON.stringify(audit)])}
 const finished=await withInstallLock(layout.home,()=>finishSubmissionMaintenance(result.state,input,candidate));assert.equal(finished.phase,'stopped')
  assert.deepEqual(await withInstallLock(layout.home,()=>finishSubmissionMaintenance(finished,input,candidate)),finished,'完成回包丢失后可明确幂等重入')
  assert.equal((await readInstall(layout))!.phase,'stopped');assert.equal((await pool.query('select state from teloa_tasks where id=$1',[taskId])).rows[0].state,'paused')
  assert.equal((await runs.claim(owner,{runId:run.id})).dispatch,false)
 })
})


test('旧data5及已完成unknown日志：未发布取消经备份迁入data6，保留旧日志',{timeout:120_000,skip:!process.env.TELOA_TEST_CLI_CANCEL_PG_URL||process.platform!=='darwin'},async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'teloa-known-maintenance-'))),layout=await resolveLayout({home:join(root,'home'),workspace:join(root,'workspace'),version:'0.2.72'})
 const configFile=join(root,'connection.json');await writeFile(configFile,JSON.stringify({connectionString:process.env.TELOA_TEST_CLI_CANCEL_PG_URL}),{mode:0o600})
 const old:InstallState={schema:'teloa.install/v1',id:randomUUID(),version:'0.2.72',phase:'ready',port:await freePort(),database:{kind:'existing',configFile},layout}
 let supervisor:ChildProcess|undefined,pool:any
 t.after(async()=>{if(supervisor&&supervisor.exitCode===null&&supervisor.signalCode===null){const exited=once(supervisor,'exit');supervisor.kill('SIGTERM');await exited}await pool?.end();await rm(root,{recursive:true,force:true})})
 await mkdir(layout.workspaceRoot,{recursive:true,mode:0o700});await mkdir(layout.dshHome,{recursive:true,mode:0o700})
 await releaseFixture(layout.releaseRoot,old.version,5);const candidate=join(root,'candidate');await releaseFixture(candidate,'0.2.74',6)
 await writeInstall(old);await prepareDatabase(old);pool=await databasePool(old)
 const {owner,role,taskId}=await roleFixture(pool,'employee'),sessionId='known-maintenance-'+randomUUID(),conversationId=randomUUID(),runtimeId=randomUUID()
 const db=await pool.connect();try{await db.query('begin');await new WorkLineageService(pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'}),runs=new TaskRunService(pool,identity,inspect)
 const link=await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:link.version},undefined,undefined,undefined,async()=>'teloa-standard'),run=(await runs.claim(owner,{runId:prepared.id})).run
 await new TaskRunRuntimeLinkService(pool).put(owner,{runId:run.id,kind:'job',nativeId:'owner:'+runtimeId+':'+sessionId,sessionId,payload:{record:'owner',runtimeId,requestId:run.nativeRequestId}})
 const {TaskRunSubmissionService}=await import('../../backend/src/work/task-run-submission.ts'),submissions=new TaskRunSubmissionService(pool)
 for(let i=0;i<2;i++)await submissions.finish(owner,await submissions.begin(owner,run,runtimeId),'not-published')
 await runs.requestStop(owner,{runId:run.id})
 const {Context}=await import(pathToFileURL(harnessRequire.resolve('@deepseek-ai/cordis')).href),Jsonl=await import(pathToFileURL(harnessRequire.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href),{SessionId}=await import(pathToFileURL(harnessRequire.resolve('@deepseek-ai/dsh-session')).href)
 const ctx=new Context();await ctx.plugin(Jsonl,{root:join(layout.dshHome,'sessions'),compression:'zstd'})
 const handle=await ctx.sessionPersistence.create({id:SessionId(sessionId),version:4,createdAt:Date.now(),cwd:layout.workspaceRoot,isSeeded:false,agentPreset:run.agentPresetId});await handle.flush();await handle.close();await ctx.fiber.dispose()
 // 模拟旧data5：新审计表确实不存在；不得提前手工创建。
 await pool.query('drop table teloa_task_run_unpublished_cancellations')
 assert.equal((await pool.query("select to_regclass('teloa_task_run_unpublished_cancellations') as name")).rows[0].name,null)
 const previous:Record<string,Buffer>={}
 const previousRun=randomUUID(),previousRequest=randomUUID(),previousBinding={installId:old.id,home:layout.home,sourceVersion:'0.2.10',sourceDataVersion:2,run:{runId:previousRun}}
 const oldCycle={'':{schema:'teloa.submission-maintenance/v1',requestId:previousRequest,targetVersion:'0.2.12',acknowledgedUnknown:true,binding:previousBinding,bindingSha256:hash(JSON.stringify(previousBinding)),backup:layout.home+'.backups/submission-'+previousRequest},'-exit':{schema:'teloa.maintenance-process-exit/v1',bindingSha256:hash(JSON.stringify(previousBinding)),exited:[11001,11002,11003]},'-log':{fileSha256:'a'.repeat(64),logCut:0,logSha256:hash('[]')},'-complete':{schema:'teloa.submission-maintenance-complete/v1',requestId:previousRequest,runId:previousRun,installId:old.id,version:'0.2.12',state:'submission_unknown',backup:layout.home+'.backups/submission-'+previousRequest}}
 for(const [suffix,value] of Object.entries(oldCycle)){const name='submission-maintenance'+suffix+'.json',body=Buffer.from(JSON.stringify(value));previous[name]=body;await writeFile(join(layout.instanceRoot,name),body,{mode:0o600})}
 supervisor=spawn(process.execPath,[join(layout.releaseRoot,'packages/cli/lib/service-entry.js'),layout.home],{cwd:layout.workspaceRoot,stdio:['ignore','pipe','pipe']})
 await new Promise<void>((done,fail)=>{supervisor!.stdout!.once('data',()=>done());supervisor!.once('error',fail);supervisor!.once('exit',()=>fail(Error('fixture supervisor exited before ready')))})
 const input={runId:run.id,targetVersion:'0.2.74',cancelNotPublished:true as const}
 const result=await withInstallLock(layout.home,()=>resolveSubmissionMaintenance(old,input,candidate))
 assert.equal(result.state.phase,'maintenance');assert.equal((await pool.query('select state from teloa_task_runs where id=$1',[run.id])).rows[0].state,'withdrawn')
 assert.equal((await pool.query('select count(*)::int as n from teloa_task_run_unpublished_cancellations')).rows[0].n,1)
 assert.equal((await pool.query('select data_version from teloa_installation')).rows[0].data_version,6)
 for(const [name,body] of Object.entries(previous))assert.deepEqual(await readFile(join(layout.instanceRoot,name)),body)
 const journal=join(layout.instanceRoot,'submission-maintenance-not-published',run.id)
 for(const name of ['intent.json','exit.json','log.json','complete.json'])assert.ok((await readFile(join(journal,name))).length)
 assert.deepEqual(await withInstallLock(layout.home,()=>resolveSubmissionMaintenance(result.state,{...input,existingTargetOnly:true},candidate)),result)
 await assert.rejects(withInstallLock(layout.home,()=>resolveSubmissionMaintenance(result.state,{...input,runId:randomUUID(),existingTargetOnly:true},candidate)),/只能继续/)
 await assert.rejects(withInstallLock(layout.home,()=>finishSubmissionMaintenance(result.state,{...input,runId:previousRun},candidate)))
 const finished=await withInstallLock(layout.home,()=>finishSubmissionMaintenance(result.state,input,candidate));assert.equal(finished.phase,'stopped')
 assert.deepEqual(await withInstallLock(layout.home,()=>finishSubmissionMaintenance(finished,input,candidate)),finished)
 assert.equal((await verifySubmissionMaintenanceBackup(result.backup,{installId:old.id,home:layout.home,bindingSha256:(await readPrivateJson(join(journal,'intent.json')) as any).bindingSha256})).dataVersion,5)
})
