import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'

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
