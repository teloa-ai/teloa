import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {WorkError} from '@teloa/contract'
import {WorkControlDriver} from '../src/work-control-driver.ts'
import {taskRunRuntimeId} from '../src/task-run-background.ts'

test('暂停走原生取消但不写不可恢复 Run stop；未知外部动作保持停止中',async()=>{
 let api:any;try{api=await import('../src/work-control-driver.ts')}catch(error){if((error as any).code!=='ERR_MODULE_NOT_FOUND')throw error;api={}}
 assert.equal(typeof api.WorkControlDriver,'function','必须有真实宿主整项控制 driver')
 const owner=randomUUID(),run:any={id:randomUUID(),sessionId:randomUUID(),nativeRequestId:randomUUID(),state:'active'},control:any={id:randomUUID(),ownerId:owner,state:'pausing',scope:'round',generation:2,version:2,pendingRunIds:[run.id],unknownOperationIds:[]}
 let native=0,business=0,child=0,unknown=true
 const driver=new api.WorkControlDriver({controls:{get:async()=>control,reconcile:async()=>control},runs:{get:async()=>run},lineage:{descendants:async()=>({runIds:[run.id]})},driver:{stop:async()=>{business++;return run}},ports:{stop:async()=>{native++},stopChildren:async()=>{child++},stopState:async()=>({running:false,settledSeq:3}),backgroundState:async()=>({outstanding:false,interrupted:false}),subagentState:async()=> 'none'},runtimeLinks:{list:async()=>unknown?[{kind:'browser',payload:{status:'dirty',dispatchId:'write:1'}}]:[]}})
 await driver.apply(owner,control,new AbortController().signal)
 assert.equal(native,1);assert.equal(child,1);assert.equal(business,0)
 const proof=await driver.inspectRun(owner,{runId:run.id,action:'pause',generation:2});assert.equal(proof.settled,false);assert.deepEqual(proof.unknownOperationIds,['browser:write:1'])
 unknown=false;assert.equal((await driver.inspectRun(owner,{runId:run.id,action:'pause',generation:2})).settled,true)
 control.state='stopping';await driver.apply(owner,control,new AbortController().signal);assert.equal(business,1)
})

test('外部预留和运行未结清时不能停妥，旧宿主与unknown只返回待核对',async()=>{
 let status='running',runtimeId:string=taskRunRuntimeId
 const run={id:'run',state:'active'},driver=new WorkControlDriver({runs:{get:async()=>run},runtimeLinks:{list:async()=>[{kind:'external',nativeId:'reservation',payload:{provider:'codex',runtimeId,reservationId:'reservation',status}}]},ports:{stopState:async()=>({running:false,settledSeq:3}),backgroundState:async()=>({outstanding:false,interrupted:false}),subagentState:async()=> 'none'}} as never)
 const input={runId:'run',action:'stop' as const,generation:1}
 for(status of ['reserved','running','stopping','unknown'])assert.equal((await driver.inspectRun('owner',input)).settled,false,status)
 status='running';runtimeId='old-host'
 assert.deepEqual((await driver.inspectRun('owner',input)).unknownOperationIds,['external:codex:reservation'])
 status='completed';assert.equal((await driver.inspectRun('owner',input)).settled,true)
})

test('无会话、无 link 的 configuration_failed Run 不读执行日志即收尾；带 link 时仍走完整核查且未收尾不判停妥',async()=>{
 let events=0,links:unknown[]=[],readable=false
 const run={id:'run',state:'configuration_failed',sessionId:'task-run-never-created'}
 const driver=new WorkControlDriver({runs:{get:async()=>run},runtimeLinks:{list:async()=>links},ports:{goalObservation:async()=>null,events:async()=>{events++;if(!readable)throw new WorkError('teloa/forbidden','执行会话身份未就绪。');return []},stopState:async()=>({running:false,settledSeq:null}),backgroundState:async()=>({outstanding:false,interrupted:false}),subagentState:async()=> 'none'}} as never)
 const input={runId:'run',action:'pause' as const,generation:2}
 assert.deepEqual(await driver.inspectRun('owner',input),{settled:true,unknownOperationIds:[]});assert.equal(events,0)
 links=[{kind:'job',nativeId:'job',payload:{record:'job',status:'running'}}]
 await assert.rejects(driver.inspectRun('owner',input),{code:'teloa/forbidden'});assert.equal(events,1)
 readable=true;assert.equal((await driver.inspectRun('owner',input)).settled,false);assert.equal(events,2)
})
