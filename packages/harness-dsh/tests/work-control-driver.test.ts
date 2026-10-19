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

test('已结束且带原生终态证据的成功 Run：旧会话不可读时以持久终态结算收口；结算不成立、link 在途/未知、证据未结束或缺端口仍待核对',async()=>{
 const ended={state:'ended' as const,turn:1,messageSeq:8,endSeq:50,reason:'completed'}
 const run:any={id:'run',taskId:'task',roleId:'role',sessionId:'old-session',nativeRequestId:'native',state:'ended',stopRequestedAt:null,evidence:{...ended}}
 let settled=true,links:any[]=[],readSession=0
 const cold={stopState:async()=>{readSession++;throw new WorkError('teloa/unavailable','旧会话不可 materialize')},backgroundState:async()=>({outstanding:false,interrupted:false}),subagentState:async()=>'none',goalObservation:async()=>{readSession++;throw new WorkError('teloa/unavailable','旧 Goal 足迹不可读')},events:async()=>[]}
 const make=(ports:object,withProof=true)=>new WorkControlDriver({runs:{get:async()=>run},runtimeLinks:{list:async()=>links},ports,...(withProof?{terminalSettled:async(_owner:string,value:any)=>{assert.equal(value.id,run.id);return settled}}:{})} as never)
 const input={runId:'run',action:'pause' as const,generation:20}
 assert.equal((await make(cold).inspectRun('owner',input)).settled,true,'持久终态结算成立即收口');assert.equal(readSession,0,'不为宣布停妥读取旧会话')
 assert.equal((await make({}).inspectRun('owner',input)).settled,true,'冷宿主缺检查器同样以持久结算为证')
 settled=false;assert.equal((await make({}).inspectRun('owner',input)).settled,false,'结算不成立不伪造停妥')
 assert.equal((await make(cold).inspectRun('owner',input).catch(error=>error)).code,'teloa/unavailable','结算不成立时回到原路径读会话并如实失败，不静默判停妥')
 settled=true;links=[{kind:'job',payload:{record:'job',runtimeId:taskRunRuntimeId,requestId:'native',jobId:'j',status:'running'}}]
 assert.equal((await make({}).inspectRun('owner',input)).settled,false,'在途 job 不走持久结算')
 links=[{kind:'browser',payload:{status:'dirty',dispatchId:'write:1'}}]
 const dirty=await make({}).inspectRun('owner',input);assert.equal(dirty.settled,false);assert.deepEqual(dirty.unknownOperationIds,['browser:write:1'],'未知浏览器动作照常上报')
 links=[];run.evidence={state:'active',turn:1,messageSeq:8}
 assert.equal((await make({}).inspectRun('owner',input)).settled,false,'原生证据未结束不走持久结算')
 run.evidence={...ended};run.state='active'
 assert.equal((await make({}).inspectRun('owner',input)).settled,false,'未结束 Run 仍需宿主检查器')
 run.state='ended'
 assert.equal((await make({},false).inspectRun('owner',input)).settled,false,'没有持久结算端口时维持原口径：冷宿主不判停妥')
 assert.equal((await make(cold,false).inspectRun('owner',input).catch(error=>error)).code,'teloa/unavailable','没有端口时仍按原路径读会话并如实失败')
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
