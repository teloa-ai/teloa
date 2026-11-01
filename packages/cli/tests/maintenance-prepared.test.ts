import test from 'node:test'
import assert from 'node:assert/strict'
import {parseArguments} from '../src/bin.ts'
import {assertPreparedExitWindow,readPreparedMaintenancePause,assertPreparedMaintenanceData} from '../src/maintenance-prepared.ts'
import type {ReleaseManifest} from '../src/contracts.ts'
import {assertMaintenanceDatabase,assertPreparedMaintenanceDatabase} from '../src/maintenance.ts'

test('prepared维护仅匹配已声明源和目标数据：4→5与5→5通过，旧读者/未知6/缺失兼容声明拒绝',()=>{
 const release=(dataVersion:number,compatibleDataVersions=[dataVersion]):ReleaseManifest=>({schema:'teloa.release/v1',version:'0.2.65',dshVersion:'0.2.1-rc.2',dataVersion,compatibleDataVersions,files:[]})
 for(const [source,target] of [[4,4],[4,5],[5,5]])assert.doesNotThrow(()=>assertPreparedMaintenanceData(release(source!),release(target!)))
 for(const [source,target] of [[5,4],[6,5],[5,6],[3,5]])assert.throws(()=>assertPreparedMaintenanceData(release(source!),release(target!)))
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
