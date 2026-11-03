import test from 'node:test'
import assert from 'node:assert/strict'
import {parseArguments} from '../src/bin.ts'
import {assertPreparedExitWindow,readPreparedMaintenancePause,assertPreparedMaintenanceData,assertPreparedRunReservation,assertCompletedPreparedMaintenance,publishPreparedMaintenanceCycle,assertCompletedPreparedDatabase} from '../src/maintenance-prepared.ts'
import type {ReleaseManifest} from '../src/contracts.ts'
import {assertMaintenanceDatabase,assertPreparedMaintenanceDatabase} from '../src/maintenance.ts'
import {dataVersionMetadata} from '../src/data-version.ts'

test('prepared维护仅匹配已声明源和目标数据：保留历史边及当前迁移，降级/未知版本拒绝',()=>{
 const release=(dataVersion:number,compatibleDataVersions=[dataVersion]):ReleaseManifest=>({schema:'teloa.release/v1',version:'0.2.65',dshVersion:'0.2.1-rc.2',dataVersion,compatibleDataVersions,files:[]})
 for(const [source,target] of [[4,4],[4,5],[5,5],[4,9],[9,9],[4,10],[9,10],[10,10],[10,11],[10,13],[12,13],[13,14]])assert.doesNotThrow(()=>assertPreparedMaintenanceData(release(source!),release(target!)))
 for(const {from,to} of dataVersionMetadata.migrations.filter(row=>row.from>=4))assert.doesNotThrow(()=>assertPreparedMaintenanceData(release(from),release(to)))
 for(const [source,target] of [[5,4],[6,5],[dataVersionMetadata.dataVersion,dataVersionMetadata.dataVersion+1],[10,9],[11,10],[3,5]])assert.throws(()=>assertPreparedMaintenanceData(release(source!),release(target!)))
 assert.throws(()=>assertPreparedMaintenanceData(release(5,[]),release(5)))
 assert.throws(()=>assertPreparedMaintenanceData(release(4),release(5,[4])))
})

test('具名prepared维护仅精确Run/版本/明确确认可用；普通命令不接受例外参数',()=>{
 const run='10000000-0000-4000-8000-000000000001'
 assert.deepEqual(parseArguments(['maintain-prepared','--run',run,'--to','0.2.35','--confirm']),{command:'maintain-prepared',options:{run,to:'0.2.35',confirm:true}})
 for(const args of [['maintain-prepared'],['maintain-prepared','--run',run,'--to','0.2.35'],['maintain-prepared','--run','all','--to','0.2.35','--confirm'],['maintain-prepared','--run',run,'--to','latest','--confirm'],['maintain-prepared','--run',run,'--to','0.2.35','--confirm','--start'],['stop','--run',run],['upgrade','--to','0.2.35','--run',run]])assert.throws(()=>parseArguments(args))
})
test('认证退出期限必须来自发送前持久边界，缺失/过期/换绑定均拒绝',()=>{
 const bindingSha256='a'.repeat(64),start=Date.parse('2026-10-26T00:00:00Z'),at=(ms:number)=>new Date(start+ms).toISOString(),issued={schema:'teloa.prepared-maintenance-exit-issued/v1',bindingSha256,startedAt:at(0),issuedAt:at(1000),activity:0,deferredSealed:true},receipt={bindingSha256,observedAt:at(3000)}
 assert.doesNotThrow(()=>assertPreparedExitWindow(issued,receipt,bindingSha256))
 for(const changed of [undefined,{...issued,bindingSha256:'b'.repeat(64)},{...issued,activity:1},{...issued,deferredSealed:false},{...issued,issuedAt:at(5001)},{...issued,startedAt:'invalid'}])assert.throws(()=>assertPreparedExitWindow(changed,receipt,bindingSha256))
 for(const changed of [{...receipt,observedAt:at(28_000)},{...receipt,observedAt:at(999)},{...receipt,bindingSha256:'b'.repeat(64)}])assert.throws(()=>assertPreparedExitWindow(issued,changed,bindingSha256))
})
test('普通维护继续拒prepared；窄例外只豁免原身份，未知提交/其它活动仍失败',async()=>{
 const run={owner:'fixture',runId:'10000000-0000-4000-8000-000000000001'},queries:string[]=[]
 const db={query:async(sql:string,args?:unknown[])=>{queries.push(sql);if(sql.includes('count(*)::integer'))return {rows:[{runs:sql.includes("state='prepared'")&&args?.[0]===run.owner&&args?.[1]===run.runId?0:1,plans:0,effects:0,plugins:0}]};return {rows:[]}}}
 await assert.rejects(assertMaintenanceDatabase(db),/未收尾/);await assertPreparedMaintenanceDatabase(db,run);assert.ok(queries[0]!.includes("state='submitting'"));assert.ok(queries[1]!.includes("state='prepared'"))
 await assert.rejects(assertPreparedMaintenanceDatabase({query:async(sql,args)=>sql.includes('teloa_task_run_submissions')?{rows:[{found:1}]}:db.query(sql,args)},run),/未结清/)
 await assert.rejects(assertPreparedMaintenanceDatabase({query:async()=>({rows:[{runs:1,plans:0,effects:0,plugins:0}]})},run),/未收尾/)
})

const pausedOwner='fixture-owner',pausedRun={owner:pausedOwner,runId:'10000000-0000-4000-8000-000000000001',taskId:'10000000-0000-4000-8000-000000000002',controlId:'10000000-0000-4000-8000-000000000003'}
const originalPauseId='10000000-0000-4000-8000-000000000004'
function pausedSource(){return {
 id:pausedRun.controlId,owner_id:pausedOwner,kind:'round',root_task_id:pausedRun.taskId,state:'paused',version:3,generation:2,pause_origin:'owner',
 lineage_owner_id:pausedOwner,lineage_task_id:pausedRun.taskId,lineage_root_task_id:pausedRun.taskId,definition_control_id:null,round_control_id:pausedRun.controlId,
 progress_owner_id:pausedOwner,progress_control_id:pausedRun.controlId,progress_generation:2,pending_run_ids:[],unknown_operation_ids:[],
 request_owner_id:pausedOwner,request_id:originalPauseId,request_control_id:pausedRun.controlId,
 spec:{requestId:originalPauseId,controlId:pausedRun.controlId,expectedVersion:1,action:'pause',scope:'round',roundControlId:null},
 result:{id:pausedRun.controlId,ownerId:pausedOwner,generation:2,version:2,state:'pausing',scope:'round',pendingRunIds:[pausedRun.runId],unknownOperationIds:[]},
}}
function pausedReader(rows:Record<string,unknown>[]){return {query:async(sql:string,args?:unknown[])=>{
 assert.deepEqual(args,[pausedOwner,pausedRun.controlId,pausedRun.taskId]);assert.match(sql,/teloa_work_controls/);assert.match(sql,/teloa_task_work_lineage/);assert.match(sql,/teloa_work_control_requests/)
 assert.ok(!/insert|update|delete/i.test(sql),'Pause source selection is read only');return {rows:structuredClone(rows)}
}}}
async function readPause(rows:Record<string,unknown>[],expected?:Parameters<typeof readPreparedMaintenancePause>[2]){
 return await readPreparedMaintenancePause(pausedReader(rows),pausedRun,expected)
}
test('已成功暂停的prepared采用数据库原nonce和原pausing回执，不再发第二次pause',async()=>{
 const row=pausedSource(),selected=await readPause([row]);assert.deepEqual(selected,{request:row.spec,adopted:{result:row.result,settledVersion:3}})
 assert.deepEqual(await readPause([row],selected),selected,'Existing adopted intent reuses its exact original request and proof')
})
test('active入口保留原CAS暂停请求，pausing或其它状态不借用已暂停例外',async()=>{
 const row=pausedSource(),selected=await readPause([{...row,state:'active',version:1,generation:1}])
 assert.equal(selected.adopted,undefined);assert.notEqual(selected.request.requestId,originalPauseId)
 assert.deepEqual({...selected.request,requestId:originalPauseId},{...row.spec,expectedVersion:1})
 for(const state of ['pausing','ending','ended','unknown'])await assert.rejects(readPause([{...row,state}]),/维护身份、暂停或停发证明/)
})
test('缺失或冲突的正式暂停来源、旧nonce、旧世代和错误归属均关闭',async()=>{
 const row=pausedSource(),different='10000000-0000-4000-8000-000000000099'
 const invalid=[[],[row,row],[{...row,request_owner_id:'other-owner'}],[{...row,request_id:different}],
  [{...row,request_control_id:different}],[{...row,owner_id:'other-owner'}],[{...row,lineage_owner_id:'other-owner'}],
  [{...row,lineage_task_id:different}],[{...row,lineage_root_task_id:different}],[{...row,round_control_id:different}],
  [{...row,definition_control_id:different}],[{...row,kind:'definition'}],[{...row,pause_origin:'restart'}],
  [{...row,spec:{...row.spec,action:'resume'}}],[{...row,spec:{...row.spec,expectedVersion:2}}],
  [{...row,spec:{...row.spec,untrustedClaim:true}}],[{...row,result:{...row.result,ownerId:'other-owner'}}],
  [{...row,result:{...row.result,generation:1}}],[{...row,result:{...row.result,version:1}}],
  [{...row,result:{...row.result,state:'paused'}}],[{...row,result:{...row.result,pendingRunIds:[different]}}],
  [{...row,result:{...row.result,unknownOperationIds:['unknown']}}],[{...row,result:null}],
 ]
 for(const rows of invalid)await assert.rejects(readPause(rows),/维护身份、暂停或停发证明/)
})
test('当前暂停必须同代且已收口，未知进度和版本漂移不进入intent',async()=>{
 const row=pausedSource()
 for(const changed of [{progress_generation:1},{pending_run_ids:[pausedRun.runId]},{unknown_operation_ids:['runtime-owner:'+pausedRun.runId]},
  {progress_owner_id:'other-owner'},{progress_control_id:'10000000-0000-4000-8000-000000000099'},
  {pending_run_ids:null},{unknown_operation_ids:null},{version:4},{generation:3}])
  await assert.rejects(readPause([{...row,...changed}]),/维护身份、暂停或停发证明/)
})
test('已有采用intent只认原暂停证明，不更换nonce、回执或恢复后的控制世代',async()=>{
 const row=pausedSource(),selected=await readPause([row])
 assert.ok(selected.adopted)
 for(const changed of [{...selected,request:{...selected.request,requestId:'10000000-0000-4000-8000-000000000099'}},
  {...selected,adopted:{...selected.adopted,settledVersion:4}},
  {...selected,adopted:{...selected.adopted,result:{...row.result,version:1}}}])
  await assert.rejects(readPause([row],changed),/维护身份、暂停或停发证明/)
 await assert.rejects(readPause([{...row,state:'active'}],selected),/维护身份、暂停或停发证明/)
})

const maintenanceId=(n:number)=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0')
function reservationFixture(){
 const owner='fixture-owner',taskId=maintenanceId(1),roleId=maintenanceId(2),oldRequest=maintenanceId(3),requestId=maintenanceId(4),sessionId='task-run-'+oldRequest
 const run={id:maintenanceId(5),owner_id:owner,request_id:requestId,task_id:taskId,role_id:roleId,task_version:2,role_version:4,session_id:sessionId,link_version:1,agent_preset_id:'teloa-standard',request_spec:{requestId,taskId,expectedTaskVersion:2,roleId,expectedRoleVersion:4,sessionId,expectedLinkVersion:1}}
 const stored=[{id:maintenanceId(6),ownerId:owner,sessionId,requestId:oldRequest,purpose:'task-run',status:'ready',run:{taskId,taskVersion:1,roleId,roleVersion:1,agentPresetId:'teloa-standard'}}]
 const rows={rejected:[{owner_id:owner,request_id:oldRequest,endpoint:'task-runs/prepare',state:'rejected',request_spec:{requestId:oldRequest,taskId,expectedTaskVersion:1}}],runs:[{id:run.id,owner_id:owner,task_id:taskId,request_id:requestId}],links:[{active:true,source_only:false,conversation_id:stored[0]!.id,version:1,object_version:1}],changes:[{owner_id:owner,task_id:taskId,request_id:maintenanceId(7),base_version:1,applied_version:2,from_party:{kind:'role',roleId,roleVersion:1},to_party:{kind:'role',roleId,roleVersion:4},note:'同角色正式更新授权版本',created_at:new Date('2026-10-01T00:00:00Z'),request_spec:{requestId:maintenanceId(7),taskId,expectedTaskVersion:1,target:{kind:'role',roleId,expectedRoleVersion:4},note:'同角色正式更新授权版本'}}]}
 const db={query:async(sql:string)=>{assert.match(sql,/^select /);return {rows:structuredClone(sql.includes('pending_request_registry')?rows.rejected:sql.includes('task_handoff_changes')?rows.changes:sql.includes('object_conversations')?rows.links:rows.runs)}}}
 return {run,stored,rows,db}
}
import {readStoredTaskHandoffChange} from '../../backend/src/work/handoffs.ts'
import {preparedMaintenanceHash,readPreparedMaintenance} from '../../backend/src/work/prepared-maintenance.ts'
test('仅明确拒绝无Run预约支持同Task/角色/预设的显式SID及正式交办版本链，历史原件不改',async()=>{
 const f=reservationFixture(),before=structuredClone({stored:f.stored,run:f.run})
 await assertPreparedRunReservation(f.db,f.run,f.stored,readStoredTaskHandoffChange)
 assert.deepEqual(f.stored,before.stored);assert.deepEqual(f.run,before.run)
 const exact={...f.stored[0]!,requestId:f.run.request_id,run:{...f.stored[0]!.run,taskVersion:2,roleVersion:4}}
 await assertPreparedRunReservation({query:async()=>{throw Error('精确预约无需兼容查询')}},f.run,[exact],readStoredTaskHandoffChange)
})
test('SID兼容拒跨owner/Task/角色/预设、未知旧请求、第二Run、错误关联及交办链',async()=>{
 const changes:Array<(f:ReturnType<typeof reservationFixture>)=>void>=[
  f=>{f.stored[0]!.ownerId='other'},f=>{f.stored[0]!.run.taskId=maintenanceId(99)},f=>{f.stored[0]!.run.roleId=maintenanceId(99)},f=>{f.stored[0]!.run.agentPresetId='other'},
  f=>{f.stored.push(structuredClone(f.stored[0]!))},f=>{f.stored[0]!.status='pending'},f=>{f.rows.rejected[0]!.state='pending'},f=>{f.rows.rejected[0]!.state='unknown'},
  f=>{f.rows.rejected[0]!.owner_id='other'},f=>{f.rows.rejected[0]!.request_spec.taskId=maintenanceId(99)},f=>{f.rows.runs.push({...f.rows.runs[0]!,id:maintenanceId(99)})},
  f=>{f.rows.runs[0]!.owner_id='other'},f=>{f.rows.links[0]!.active=false},f=>{f.rows.links[0]!.source_only=true},f=>{f.rows.links[0]!.conversation_id=maintenanceId(99)},
  f=>{f.rows.changes=[]},f=>{f.rows.changes[0]!.from_party.roleVersion=2},f=>{f.rows.changes[0]!.request_spec.target.expectedRoleVersion=99},
  f=>{f.run.request_spec.sessionId='another-session'},f=>{f.run.request_spec.expectedRoleVersion=1},
 ]
 for(const change of changes){const f=reservationFixture();change(f);await assert.rejects(assertPreparedRunReservation(f.db,f.run,f.stored,readStoredTaskHandoffChange))}
})

import {createHash} from 'node:crypto'
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {withInstallLock,writePrivateJson} from '../src/state.ts'
import type {InstallState} from '../src/contracts.ts'
function completedDatabaseFixture(){
 const installId=maintenanceId(70),container={Config:{Labels:{'ai.teloa.install':installId}},NetworkSettings:{Ports:{'5432/tcp':[{HostIp:'127.0.0.1',HostPort:'55402'}]}}}
 const input={installId,database:{endpoint:'postgresql://127.0.0.1:55401/teloa',systemIdentifier:'123456789'},backupConnection:'postgresql://teloa:fixture@127.0.0.1:55401/teloa',currentConnection:'postgresql://teloa:fixture@127.0.0.1:55402/teloa',container}
 const rows:Record<string,unknown>[]=[{database:'teloa',schema:'public',schemas:['public'],username:'teloa',session_username:'teloa',system_identifier:'123456789',public_marker_resolved:true}],markers=[{id:installId}],queries:string[]=[]
 const db={query:async(sql:string)=>{assert.match(sql,/^select /);queries.push(sql);if(sql.includes('current_database()'))return {rows:structuredClone(rows)};assert.equal(sql,'select id from public.teloa_installation');return {rows:structuredClone(markers)}}}
 return {input,container,rows,markers,queries,db}
}
test('已完成旧周期仅Docker映射端口改变时，真实库/public/角色/安装和备份绑定仍一致才通过',async()=>{
 const f=completedDatabaseFixture(),before=structuredClone(f.input)
 await assertCompletedPreparedDatabase(f.db,f.input)
 assert.equal(f.queries.length,2);assert.deepEqual(f.input,before,'不修改旧数据库身份、备份配置或周期原件')
})
test('同一PG也不能跨database/schema/search_path/角色或安装标记认领旧周期',async()=>{
 const changes:Array<(f:ReturnType<typeof completedDatabaseFixture>)=>void>=[
  f=>{f.input.currentConnection=f.input.currentConnection.replace('/teloa','/another')},
  f=>{f.input.currentConnection+='?options=-csearch_path%3Dtenant'},
  f=>{f.input.backupConnection+='?options=-csearch_path%3Dtenant'},
  f=>{f.input.currentConnection=f.input.currentConnection.replace('teloa:fixture','another:fixture')},
  f=>{f.rows[0]!.database='another'},f=>{f.rows[0]!.schema='tenant'},f=>{f.rows[0]!.schemas=['tenant','public']},
  f=>{f.rows[0]!.schemas=['public','tenant']},f=>{f.rows[0]!.username='another'},f=>{f.rows[0]!.session_username='another'},
  f=>{f.rows[0]!.system_identifier='987654321'},f=>{f.rows[0]!.public_marker_resolved=false},
  f=>{f.markers[0]!.id=maintenanceId(71)},f=>{f.markers.push({id:maintenanceId(71)})},f=>{f.rows.length=0},
 ]
 for(const change of changes){const f=completedDatabaseFixture();change(f);await assert.rejects(assertCompletedPreparedDatabase(f.db,f.input))}
})
test('旧备份endpoint、自有容器或当前loopback映射缺失/漂移均不能放宽历史身份',async()=>{
 const changes:Array<(f:ReturnType<typeof completedDatabaseFixture>)=>void>=[
  f=>{f.input.database.endpoint='postgresql://127.0.0.1:55403/teloa'},
  f=>{f.input.database.systemIdentifier='not-a-system-id'},
  f=>{f.input.backupConnection=f.input.currentConnection},
  f=>{f.input.currentConnection=f.input.currentConnection.replace('127.0.0.1','localhost')},
  f=>{f.input.currentConnection=f.input.currentConnection.replace('127.0.0.1','192.0.2.1')},
  f=>{f.container.Config.Labels['ai.teloa.install']=maintenanceId(71)},
  f=>{f.container.NetworkSettings.Ports['5432/tcp'][0]!.HostPort='55403'},
  f=>{f.container.NetworkSettings.Ports['5432/tcp'][0]!.HostIp='0.0.0.0'},
  f=>{f.container.NetworkSettings.Ports['5432/tcp'].push({HostIp:'127.0.0.1',HostPort:'55402'})},
  f=>{f.container.NetworkSettings.Ports['5432/tcp']=[]},
 ]
 for(const change of changes){const f=completedDatabaseFixture();change(f);await assert.rejects(assertCompletedPreparedDatabase(f.db,f.input));assert.equal(f.queries.length,0)}
})
const maintenanceHash=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex')
function completedFixture(){
 const oldRun=maintenanceId(20),requestId=maintenanceId(21),input='original fixed input',run={owner:'fixture-owner',runId:oldRun,taskId:maintenanceId(22),sessionId:'fixture-session',nativeRequestId:maintenanceId(23),inputSha256:maintenanceHash(input),runtimeId:null,agentPresetId:'teloa-standard',controlId:maintenanceId(24)}
 const intent={schema:'teloa.prepared-maintenance-intent/v1' as const,requestId,installId:maintenanceId(25),home:'/fixture-home',homeDevice:1,homeInode:2,database:{endpoint:'postgresql://127.0.0.1/teloa',systemIdentifier:'123'},sourceVersion:'0.2.47',sourceManifestSha256:'a'.repeat(64),targetVersion:'0.2.59',targetManifestSha256:'b'.repeat(64),run,processes:{} as Parameters<typeof assertCompletedPreparedMaintenance>[1]['processes'],profileHashes:{},pause:{requestId:maintenanceId(26),controlId:run.controlId,expectedVersion:1,action:'pause' as const,scope:'round' as const,roundControlId:null},backup:'/fixture-home.backups/prepared-'+requestId}
 const proof={pause:{id:run.controlId,generation:2,version:2,state:'pausing'},native:{schema:'fixture-native',original:{snapshotSha256:'c'.repeat(64),fileSha256:'d'.repeat(64)},files:[],allInboxesEmpty:true as const,noOpenTurnOrTool:true as const},receipt:{} as Parameters<typeof assertCompletedPreparedMaintenance>[3]['receipt'],backupManifestSha256:'e'.repeat(64)}
 const complete={requestId,runId:oldRun,version:intent.targetVersion,bindingSha256:maintenanceHash(intent),keptPrepared:true}
 const audit={schema:'teloa.prepared-maintenance/v1',requestId,installId:intent.installId,ownerId:run.owner,runId:oldRun,taskId:run.taskId,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,inputSha256:run.inputSha256,runtimeId:null,sourceVersion:intent.sourceVersion,targetVersion:intent.targetVersion,pauseRequestId:intent.pause.requestId,controlId:run.controlId,controlGeneration:2,nativeSnapshotSha256:proof.native.original.snapshotSha256,nativeFileSha256:proof.native.original.fileSha256,processReceiptSha256:maintenanceHash(proof.receipt),backupManifestSha256:proof.backupManifestSha256}
 const rows={audits:[{request_id:requestId,audit}],runs:[{owner_id:run.owner,id:oldRun,task_id:run.taskId,session_id:run.sessionId,native_request_id:run.nativeRequestId,agent_preset_id:run.agentPresetId,input_text:input,state:'ended',evidence:{state:'ended'}}],progress:[{pending_run_ids:[] as string[],unknown_operation_ids:[] as string[]}],attempts:[] as Array<{state:string;settled_at:Date|null}>}
 const db={query:async(sql:string)=>{assert.match(sql,/^select /);return {rows:structuredClone(sql.includes('prepared_run_maintenance')?rows.audits:sql.includes('work_control_progress')?rows.progress:sql.includes('task_run_submissions')?rows.attempts:rows.runs)}}}
 return {intent,complete,proof,rows,db}
}
test('完成旧周期必须同时匹配complete、DB审计、Run终态和无未知提交',async()=>{
 const f=completedFixture();await assertCompletedPreparedMaintenance(f.db,f.intent,f.complete,f.proof)
 const mutations:Array<(g:ReturnType<typeof completedFixture>)=>void>=[
  g=>{g.complete.requestId=maintenanceId(99)},g=>{g.complete.runId=maintenanceId(99)},g=>{g.complete.version='0.2.60'},g=>{g.complete.keptPrepared=false},
  g=>{g.rows.audits=[]},g=>{g.rows.audits[0]!.audit.inputSha256='f'.repeat(64)},g=>{g.rows.runs[0]!.state='prepared'},g=>{g.rows.runs[0]!.state='submission_unknown'},
  g=>{g.rows.runs[0]!.owner_id='other'},g=>{g.rows.runs[0]!.input_text='changed'},g=>{g.rows.progress[0]!.unknown_operation_ids=['unknown']},g=>{g.rows.progress[0]!.pending_run_ids=[maintenanceId(99)]},
  g=>{g.rows.attempts=[{state:'dispatching',settled_at:null}]},g=>{g.rows.attempts=[{state:'accepted',settled_at:null}]},
 ]
 for(const mutate of mutations){const g=completedFixture();mutate(g);await assert.rejects(assertCompletedPreparedMaintenance(g.db,g.intent,g.complete,g.proof))}
 await assert.rejects(assertCompletedPreparedMaintenance(f.db,f.intent,undefined,f.proof))
})
function samePreparedCycleFixture(){
 const f=completedFixture(),r=f.intent.run
 Object.assign(f.rows.runs[0]!,{state:'prepared',evidence:null,stop_requested_at:null})
 Object.assign(f.rows.audits[0]!,{resume:null,dispatch:null})
 const result={...f.proof.pause,ownerId:r.owner,scope:'round',pendingRunIds:[r.runId],unknownOperationIds:[]}
 Object.assign(f.proof.pause,result)
 const paused={...pausedSource(),id:r.controlId,owner_id:r.owner,root_task_id:r.taskId,lineage_owner_id:r.owner,lineage_task_id:r.taskId,lineage_root_task_id:r.taskId,round_control_id:r.controlId,progress_owner_id:r.owner,progress_control_id:r.controlId,request_owner_id:r.owner,request_id:f.intent.pause.requestId,request_control_id:r.controlId,spec:f.intent.pause,result}
 const db={query:async(sql:string,args?:unknown[])=>sql.includes('join teloa_task_work_lineage')?{rows:[structuredClone(paused)]}:f.db.query(sql)}
 return {...f,paused,db}
}
test('同一prepared Run可继续后续维护：复用原owner暂停、未resume/未受理，不要求先结束原Run',async()=>{
 const f=samePreparedCycleFixture(),before=structuredClone(f.rows)
 await assertCompletedPreparedMaintenance(f.db,f.intent,f.complete,f.proof,{samePreparedRun:true})
 assert.deepEqual(f.rows,before)
 await assert.rejects(assertCompletedPreparedMaintenance(f.db,f.intent,f.complete,f.proof),'换Run仍须原Run终态')
})
test('同Run后续维护拒绝已恢复、受理、停止、换输入、owner暂停变化及未结清提交',async()=>{
 const changes:Array<(f:ReturnType<typeof samePreparedCycleFixture>)=>void>=[
  f=>{Object.assign(f.rows.audits[0]!,{resume:{requestId:maintenanceId(90)}})},
  f=>{Object.assign(f.rows.runs[0]!,{state:'accepted'})},f=>{Object.assign(f.rows.runs[0]!,{evidence:{state:'accepted'}})},
  f=>{Object.assign(f.rows.runs[0]!,{stop_requested_at:new Date()})},f=>{f.rows.runs[0]!.input_text+=' changed'},
  f=>{f.paused.pause_origin='restart'},f=>{f.paused.state='active'},f=>{f.paused.generation++},
  f=>{Object.assign(f.paused,{unknown_operation_ids:['unknown']})},f=>{f.rows.attempts.push({state:'unknown',settled_at:null})},
 ]
 for(const change of changes){const f=samePreparedCycleFixture();change(f);await assert.rejects(assertCompletedPreparedMaintenance(f.db,f.intent,f.complete,f.proof,{samePreparedRun:true}))}
})
test('原prepared Run的新周期只追加目录/指针；绑定前一审计且旧intent/complete/exit逐字保持',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-prepared-same-cycle-'))
 try{
  const instanceRoot=join(home,'instances/default');await mkdir(instanceRoot,{recursive:true});const f=samePreparedCycleFixture()
  f.intent.home=home;f.intent.backup=home+'.backups/prepared-'+f.intent.requestId;f.complete.bindingSha256=maintenanceHash(f.intent)
  const state={schema:'teloa.install/v1',id:f.intent.installId,version:f.intent.targetVersion,phase:'ready',port:3236,database:{kind:'docker'},layout:{home,instanceRoot}} as InstallState
  await writePrivateJson(join(instanceRoot,'state.json'),state)
  const original={intent:JSON.stringify(f.intent),complete:JSON.stringify(f.complete),exit:'{"originalExit":"retained"}\n'}
  for(const [name,text]of Object.entries(original))await writeFile(join(instanceRoot,'prepared-maintenance-'+name+'.json'),text,{mode:0o600})
  const previousPreparedAudit={requestId:f.intent.requestId,auditSha256:preparedMaintenanceHash(f.rows.audits[0]!.audit)},next={...f.intent,requestId:maintenanceId(80),sourceVersion:state.version,targetVersion:'0.2.60',previousPreparedAudit}
  await withInstallLock(home,async()=>{
   const verified=await assertCompletedPreparedMaintenance(f.db,f.intent,f.complete,f.proof,{samePreparedRun:true})
   await assert.rejects(publishPreparedMaintenanceCycle(state,f.intent,{...next,previousPreparedAudit:{...previousPreparedAudit,auditSha256:'0'.repeat(64)}},verified))
   await assert.rejects(publishPreparedMaintenanceCycle(state,f.intent,{...next,run:{...next.run,sessionId:'other'}},verified))
   await publishPreparedMaintenanceCycle(state,f.intent,next,verified)
   assert.equal(JSON.parse(await readFile(join(instanceRoot,'prepared-maintenance-current.json'),'utf8')).requestId,next.requestId)
   assert.deepEqual(JSON.parse(await readFile(join(instanceRoot,'prepared-maintenance-cycles',next.requestId,'prepared-maintenance-intent.json'),'utf8')),next)
   await assert.rejects(publishPreparedMaintenanceCycle(state,f.intent,next,verified),'同一验证票据不能再发布一次')
  })
  for(const [name,text]of Object.entries(original))assert.equal(await readFile(join(instanceRoot,'prepared-maintenance-'+name+'.json'),'utf8'),text)
 }finally{await rm(home,{recursive:true,force:true})}
})
test('已核完整旧周期的新Run/新目标使用独立目录，旧intent/complete/exit原字节保留且不能伪造证明',async()=>{
 const home=await mkdtemp(join(tmpdir(),'teloa-prepared-cycle-'))
 try{
  const instanceRoot=join(home,'instances/default');await mkdir(instanceRoot,{recursive:true});const f=completedFixture()
  f.intent.home=home;f.intent.backup=home+'.backups/prepared-'+f.intent.requestId;f.complete.bindingSha256=maintenanceHash(f.intent)
  const state={schema:'teloa.install/v1',id:f.intent.installId,version:'0.2.62',phase:'ready',port:3236,database:{kind:'docker'},layout:{home,instanceRoot}} as InstallState
  await writePrivateJson(join(instanceRoot,'state.json'),state)
  const original={intent:JSON.stringify(f.intent),complete:JSON.stringify(f.complete),exit:'{"originalExit":"retained"}\n'}
  for(const [name,text]of Object.entries(original))await writeFile(join(instanceRoot,'prepared-maintenance-'+name+'.json'),text,{mode:0o600})
  const next={...f.intent,requestId:maintenanceId(30),sourceVersion:state.version,targetVersion:'0.2.110',run:{...f.intent.run,runId:maintenanceId(31)}}
  await withInstallLock(home,async()=>{
   await assert.rejects(publishPreparedMaintenanceCycle(state,f.intent,next,{}))
   const verified=await assertCompletedPreparedMaintenance(f.db,f.intent,f.complete,f.proof)
   await assert.rejects(publishPreparedMaintenanceCycle(state,f.intent,{...next,run:f.intent.run},verified),'旧Run不能因完成记录再次成为新周期')
   await assert.rejects(publishPreparedMaintenanceCycle(state,f.intent,{...next,requestId:f.intent.requestId},verified))
   await assert.rejects(publishPreparedMaintenanceCycle(state,f.intent,{...next,targetVersion:state.version},verified))
   await publishPreparedMaintenanceCycle(state,f.intent,next,verified)
   const pointer=JSON.parse(await readFile(join(instanceRoot,'prepared-maintenance-current.json'),'utf8'));assert.equal(pointer.requestId,next.requestId);assert.equal(pointer.previousRequestId,f.intent.requestId)
   assert.deepEqual(JSON.parse(await readFile(join(instanceRoot,'prepared-maintenance-cycles',next.requestId,'prepared-maintenance-intent.json'),'utf8')),next)
   await assert.rejects(publishPreparedMaintenanceCycle(state,f.intent,{...next,requestId:maintenanceId(32)},verified))
  })
  for(const [name,text]of Object.entries(original))assert.equal(await readFile(join(instanceRoot,'prepared-maintenance-'+name+'.json'),'utf8'),text)
 }finally{await rm(home,{recursive:true,force:true})}
})

import {assertPreparedUpgradeLineage} from '../src/maintenance-prepared.ts'
async function ordinaryPreparedChain(){
 const first=completedFixture(),last=completedFixture()
 Object.assign(first.intent,{sourceVersion:'0.2.62',targetVersion:'0.2.114'})
 const sync=(f:ReturnType<typeof completedFixture>)=>{
  f.intent.backup=f.intent.home+'.backups/prepared-'+f.intent.requestId
  Object.assign(f.complete,{requestId:f.intent.requestId,version:f.intent.targetVersion,bindingSha256:maintenanceHash(f.intent)})
  Object.assign(f.rows.audits[0]!,{request_id:f.intent.requestId});Object.assign(f.rows.audits[0]!.audit,{requestId:f.intent.requestId,sourceVersion:f.intent.sourceVersion,targetVersion:f.intent.targetVersion})
 }
 sync(first)
 Object.assign(last.intent,{requestId:maintenanceId(81),sourceVersion:'0.2.114',targetVersion:'0.2.117',previousPreparedAudit:{requestId:first.intent.requestId,auditSha256:preparedMaintenanceHash(first.rows.audits[0]!.audit)}});sync(last)
 const links=[{intent:first.intent,proof:await assertCompletedPreparedMaintenance(first.db,first.intent,first.complete,first.proof)},{intent:last.intent,proof:await assertCompletedPreparedMaintenance(last.db,last.intent,last.complete,last.proof)}]
 const state={id:first.intent.installId,version:'0.2.117',layout:{home:first.intent.home}} as InstallState,previous={from:'0.2.60',to:'0.2.62',backup:first.intent.home+'.backups/before-0.2.62-'+maintenanceId(82),restartId:maintenanceId(83),status:'complete' as const}
 return {first,last,links,state,previous}
}
test('ordinary legacy .62回执经两笔真实typed DB维护证明接到.117；不要求原Run仍prepared',async()=>{
 const f=await ordinaryPreparedChain(),before=structuredClone(f.previous)
 assertPreparedUpgradeLineage(f.state,f.previous,f.links,{dev:1,ino:2})
 assert.deepEqual(f.previous,before);assert.equal(f.first.rows.runs[0]!.state,'ended');assert.equal(f.last.rows.runs[0]!.state,'ended')
 const first={...f.first.rows.audits[0]!,dispatch:null},last={...f.last.rows.audits[0]!,dispatch:null,previous_request_id:f.first.intent.requestId,previous_audit_sha256:preparedMaintenanceHash(first.audit)}
 const db={query:async(sql:string,args?:unknown[])=>{
  if(sql.includes('::text as root'))return {rows:[{root:'teloa_prepared_run_maintenance',cycles:'teloa_prepared_run_maintenance_cycles'}]}
  if(sql.includes('to_regclass('))return {rows:[{name:'present'}]}
  if(sql.startsWith('select * from teloa_prepared_run_maintenance where'))return {rows:[first]}
  if(sql.startsWith('select * from teloa_prepared_run_maintenance_cycles'))return {rows:[last]}
  if(sql.includes('union all'))return {rows:[args?.[2]===f.first.intent.requestId?first:last]}
  throw Error('unexpected read')
 }}
 const source:ReleaseManifest={schema:'teloa.release/v1',version:'0.2.117',dataVersion:13,compatibleDataVersions:[13],dshVersion:'0.2.1-rc.2',files:[]}
 for(const intent of [f.first.intent,f.last.intent])assert.equal((await readPreparedUpgradeAudit(db,{source,chain:f.links.map(x=>x.intent),intent,reader:readPreparedMaintenance as Parameters<typeof readPreparedUpgradeAudit>[1]['reader'],legacyRootOnly:false})).request_id,intent.requestId)
})
test('prepared→ordinary只准完整同安装相接链：foreign/篡改/缺complete/旧回执或当前版不匹配均拒',async()=>{
 const f=await ordinaryPreparedChain()
 for(const state of [{...f.state,id:maintenanceId(99)},{...f.state,version:'0.2.118'},{...f.state,layout:{...f.state.layout,home:'/foreign'}}])assert.throws(()=>assertPreparedUpgradeLineage(state,f.previous,f.links,{dev:1,ino:2}))
 assert.throws(()=>assertPreparedUpgradeLineage(f.state,f.previous,f.links,{dev:1,ino:3}))
 assert.throws(()=>assertPreparedUpgradeLineage(f.state,{...f.previous,to:'0.2.61'},f.links,{dev:1,ino:2}))
 assert.throws(()=>assertPreparedUpgradeLineage(f.state,{...f.previous,status:'failed' as 'complete'},f.links,{dev:1,ino:2}))
 assert.throws(()=>assertPreparedUpgradeLineage(f.state,f.previous,f.links.slice(1),{dev:1,ino:2}))
 assert.throws(()=>assertPreparedUpgradeLineage(f.state,f.previous,f.links.slice(0,1),{dev:1,ino:2}))
 assert.throws(()=>assertPreparedUpgradeLineage(f.state,f.previous,[f.links[0]!,{...f.links[1]!,proof:{}}],{dev:1,ino:2}))
 await assert.rejects(assertCompletedPreparedMaintenance(f.first.db,f.first.intent,undefined,f.first.proof))
 const foreign=await ordinaryPreparedChain();foreign.last.intent.run.owner='foreign-owner';Object.assign(foreign.last.rows.runs[0]!,{owner_id:'foreign-owner'});foreign.last.rows.audits[0]!.audit.ownerId='foreign-owner';foreign.last.complete.bindingSha256=maintenanceHash(foreign.last.intent)
 const foreignProof=await assertCompletedPreparedMaintenance(foreign.last.db,foreign.last.intent,foreign.last.complete,foreign.last.proof)
 assert.throws(()=>assertPreparedUpgradeLineage(foreign.state,foreign.previous,[foreign.links[0]!,{intent:foreign.last.intent,proof:foreignProof}],{dev:1,ino:2}))
 f.last.intent.targetVersion='0.2.118';assert.throws(()=>assertPreparedUpgradeLineage(f.state,f.previous,f.links,{dev:1,ino:2}))
})

import {assertPreparedUpgradeDatabase} from '../src/maintenance-prepared.ts'
test('ordinary维护桥同endpoint完整连接+真实DB/role/public/marker逐项核验，换role/schema不能借旧审计',async()=>{
 const installId=maintenanceId(70),config={connectionString:'postgresql://teloa:fixture@127.0.0.1:55401/teloa'},source:ReleaseManifest={schema:'teloa.release/v1',version:'0.2.117',dshVersion:'0.2.1-rc.2',dataVersion:13,compatibleDataVersions:[13],files:[]},state={id:installId,database:{kind:'existing',configFile:'/fixture-only'}}as InstallState
 const row={database:'teloa',schema:'public',schemas:['public'],username:'teloa',session_username:'teloa',system_identifier:'123456789',public_marker_resolved:true},marker={id:installId,data_version:13};let calls=0
 const db={query:async(sql:string)=>{calls++;assert.match(sql,/^select /);return {rows:sql.includes('current_database()')?[structuredClone(row)]:[structuredClone(marker)]}}};
 const input={state,current:config,historical:structuredClone(config),database:{endpoint:'postgresql://127.0.0.1:55401/teloa',systemIdentifier:'123456789'},source}
 await assertPreparedUpgradeDatabase(db,input);assert.equal(calls,2)
 for(const field of ['username','session_username','schema','database','system_identifier']as const){const saved=row[field];row[field]='foreign';await assert.rejects(assertPreparedUpgradeDatabase(db,input));row[field]=saved}
 row.schemas=['foreign','public'];await assert.rejects(assertPreparedUpgradeDatabase(db,input));row.schemas=['public'];row.public_marker_resolved=false;await assert.rejects(assertPreparedUpgradeDatabase(db,input));row.public_marker_resolved=true
 marker.id=maintenanceId(99);await assert.rejects(assertPreparedUpgradeDatabase(db,input));marker.id=installId;marker.data_version=12;await assert.rejects(assertPreparedUpgradeDatabase(db,input));marker.data_version=13
 for(const connectionString of ['postgresql://other:fixture@127.0.0.1:55401/teloa','postgresql://teloa:other@127.0.0.1:55401/teloa','postgresql://teloa:fixture@localhost:55401/teloa','postgres://teloa:fixture@127.0.0.1:55401/teloa','postgresql://teloa:fixture@127.0.0.1:55401/foreign','postgresql://teloa:fixture@127.0.0.1:55401/teloa?sslmode=require']){
  calls=0;await assert.rejects(assertPreparedUpgradeDatabase(db,{...input,current:{connectionString}}));assert.equal(calls,0,'连接变化在真实query前拒绝')
 }
 await assert.rejects(assertPreparedUpgradeDatabase(db,{...input,current:{...config,extra:'untrusted'}}))
})


import {readPreparedUpgradeAudit} from '../src/maintenance-prepared.ts'
async function legacyUpgradeAuditFixture(){
 const f=await ordinaryPreparedChain(),i=f.first.intent,source:ReleaseManifest={schema:'teloa.release/v1',version:'0.2.114',dshVersion:'0.2.1-rc.2',dataVersion:10,compatibleDataVersions:[10],files:[]}
 const tables:Record<string,unknown>={root:'teloa_prepared_run_maintenance',cycles:null},columns=[['owner_id','text'],['run_id','uuid'],['request_id','uuid'],['audit','jsonb'],['resume','jsonb'],['dispatch','jsonb'],['created_at','timestamp with time zone']].map(([name,type])=>({name,type}))
 const db={query:async(sql:string,args?:unknown[])=>{
  if(sql.includes("to_regclass('public.teloa_prepared_run_maintenance')"))return {rows:[structuredClone(tables)]}
  if(sql.includes('pg_catalog.pg_attribute'))return {rows:structuredClone(columns)}
  if(sql.startsWith('select request_id,audit,resume from public.')){assert.deepEqual(args,[i.run.owner,i.run.runId]);return {rows:structuredClone(f.first.rows.audits)}}
  return f.first.db.query(sql)
 }}
 return {f,i,source,tables,columns,db,input:{source,chain:[i],intent:i,reader:undefined,legacyRootOnly:true}}
}
test('旧data10单root维护审计复用原typed终态证明接ordinary，不建表不迁移',async()=>{
 const {f,i,db,input}=await legacyUpgradeAuditFixture(),audit=await readPreparedUpgradeAudit(db,input)
 const proof=await assertCompletedPreparedMaintenance(db,i,f.first.complete,f.first.proof,{readAudit:async()=>audit})
 assertPreparedUpgradeLineage({...f.state,version:'0.2.114'},f.previous,[{intent:i,proof}],{dev:1,ino:2})
})
test('旧root兼容资格不从缺表推断：modern/unknown/多周期/pointer/篡改均拒',async()=>{
 const x=await legacyUpgradeAuditFixture()
 for(const dataVersion of [0,13,14])await assert.rejects(readPreparedUpgradeAudit(x.db,{...x.input,source:{...x.source,dataVersion}}))
 await assert.rejects(readPreparedUpgradeAudit(x.db,{...x.input,legacyRootOnly:false}))
 await assert.rejects(readPreparedUpgradeAudit(x.db,{...x.input,source:{...x.source,version:'0.2.113'}}))
 await assert.rejects(readPreparedUpgradeAudit(x.db,{...x.input,source:{...x.source,compatibleDataVersions:[]}}))
 await assert.rejects(readPreparedUpgradeAudit(x.db,{...x.input,chain:[x.i,x.f.last.intent]}))
 await assert.rejects(readPreparedUpgradeAudit(x.db,{...x.input,reader:async()=>x.f.first.rows.audits[0]}))
 x.tables.root=null;await assert.rejects(readPreparedUpgradeAudit(x.db,x.input));x.tables.root='teloa_prepared_run_maintenance'
 x.tables.cycles='teloa_prepared_run_maintenance_cycles';await assert.rejects(readPreparedUpgradeAudit(x.db,x.input));x.tables.cycles=null
 x.columns[3]!.type='text';await assert.rejects(readPreparedUpgradeAudit(x.db,x.input));x.columns[3]!.type='jsonb'
 x.f.first.rows.audits.push({...x.f.first.rows.audits[0]!,request_id:maintenanceId(98)});await assert.rejects(readPreparedUpgradeAudit(x.db,x.input));x.f.first.rows.audits.pop()
 x.f.first.rows.audits[0]!.audit.ownerId='foreign-owner';const audit=await readPreparedUpgradeAudit(x.db,x.input)
 await assert.rejects(assertCompletedPreparedMaintenance(x.db,x.i,x.f.first.complete,x.f.first.proof,{readAudit:async()=>audit}))
})


import {readPreparedUpgradeManifest} from '../src/maintenance-prepared.ts'
test('公开manifest0644按发行域读取，摘要和文件字节不变；私有配置仍拒0644',async()=>{
 const {mkdtemp,realpath,mkdir,writeFile,readFile,lstat,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{readPrivateJson}=await import('../src/state.ts')
 const home=await realpath(await mkdtemp(join(tmpdir(),'teloa-public-manifest-'))),root=join(home,'releases','0.2.62'),path=join(root,'release-manifest.json'),manifest:ReleaseManifest={schema:'teloa.release/v1',version:'0.2.62',dshVersion:'0.2.1-rc.2',dataVersion:9,compatibleDataVersions:[9],files:[]},bytes=Buffer.from(JSON.stringify(manifest)+'\n')
 try{await mkdir(root,{recursive:true});await writeFile(path,bytes,{mode:0o644});const before=await lstat(path);await assert.rejects(readPrivateJson(path),/配置文件权限/);const value=await readPreparedUpgradeManifest(home,'0.2.62');assert.deepEqual(value.bytes,bytes);assert.deepEqual(value.manifest,manifest);assert.deepEqual(await readFile(path),bytes);assert.equal((await lstat(path)).mode,before.mode)}finally{await rm(home,{recursive:true,force:true})}
})


import {assertPreparedUpgradeManifestFile} from '../src/maintenance-prepared.ts'
test('公开manifest仍拒链接/可写/异主/错版；guard复读同字节链接或可写替换也拒',async()=>{
 const {mkdtemp,realpath,mkdir,writeFile,readFile,lstat,rm,symlink,unlink,chmod}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const home=await realpath(await mkdtemp(join(tmpdir(),'teloa-public-manifest-negative-'))),root=join(home,'releases','0.2.62'),path=join(root,'release-manifest.json'),other=join(root,'same.json'),bytes=Buffer.from(JSON.stringify({schema:'teloa.release/v1',version:'0.2.62',dataVersion:9,compatibleDataVersions:[9],files:[]})+'\n')
 try{
  await mkdir(root,{recursive:true});await writeFile(path,bytes,{mode:0o644});const before=await readPreparedUpgradeManifest(home,'0.2.62'),info=await lstat(path)
  assert.throws(()=>assertPreparedUpgradeManifestFile(info,info.uid+1),'实际stat上的异属比较边界；不chown测试或用户文件')
  await chmod(path,0o664);await assert.rejects(readPreparedUpgradeManifest(home,'0.2.62'));assert.deepEqual(await readFile(path),before.bytes);await chmod(path,0o644)
  await writeFile(other,bytes,{mode:0o644});await unlink(path);await symlink('same.json',path);await assert.rejects(readPreparedUpgradeManifest(home,'0.2.62'));assert.deepEqual(await readFile(path),before.bytes);await unlink(path)
  await writeFile(path,JSON.stringify({...JSON.parse(bytes.toString()),version:'0.2.63'}),{mode:0o644});await assert.rejects(readPreparedUpgradeManifest(home,'0.2.62'))
  await assert.rejects(readPreparedUpgradeManifest(home,'../0.2.62'))
 }finally{await rm(home,{recursive:true,force:true})}
})
