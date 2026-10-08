import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkRecoveryCoordinator,controlledWorkRestore} from '../src/work-recovery-coordinator.ts'

test('已受理恢复走精确 checkpoint 且不重新send；旧票据/未知结果不重放',async()=>{
 let started=0,restored=0,resumed=0,claimed=false,valid=true,unknown=false
 const recorded:string[]=[],lease={assertCurrent(){if(!valid)throw new Error('revoked')}}
 const ports:any={service:{resume:async()=>({state:'active'}),begin:async()=>({dispatch:!claimed&&(claimed=true),candidate:{reason:unknown?'unknown':'accepted',goal:{goalId:'goal'}},lease,checkpointSha256:'a'.repeat(64)}),record:async({},{state}:any)=>{recorded.push(state)}},runs:{get:async()=>({state:'active',sessionId:'session'})},startUnaccepted:async()=>{started++},restoreAccepted:async()=>{restored++;lease.assertCurrent()},resumeGoal:async()=>{resumed++;lease.assertCurrent()}}
 const coordinator=new WorkRecoveryCoordinator(ports),request:any={requestId:'request',candidateRunIds:['run']}
 await coordinator.resume('owner',request,new AbortController().signal);assert.equal(started,0);assert.equal(restored,1);assert.equal(resumed,1);assert.deepEqual(recorded,['applied'])
 await coordinator.resume('owner',request,new AbortController().signal);assert.equal(restored,1)
 claimed=false;valid=false;await assert.rejects(coordinator.resume('owner',request,new AbortController().signal),/revoked/);assert.equal(restored,1);assert.equal(recorded.at(-1),'unknown')
 claimed=false;valid=true;unknown=true;await assert.rejects(coordinator.resume('owner',request,new AbortController().signal),{code:'teloa/execution-pending'});assert.equal(restored,1)
})

test('冷恢复沿既有 roots 核验与当前控制同步guard；异步原策略返回后撤权不能修复Inbox',async()=>{
 let valid=true,hash='a'.repeat(64),release!:()=>void
 const waiting=new Promise<void>(resolve=>{release=resolve}),input:any={sessionId:'session',signal:new AbortController().signal},permit:any={candidate:{reason:'accepted'},checkpointSha256:hash,lease:{assertCurrent(){if(!valid)throw new Error('revoked')}}}
 const restore=controlledWorkRestore(async()=>{await waiting;return {roots:[],assertCurrent:()=>undefined}},async()=>({permit,sessionId:'session'}),()=>hash)
 const pending=restore(input);valid=false;release();await assert.rejects(Promise.resolve(pending),/revoked/)
 valid=true;const lease=await restore(input);lease.assertCurrent();hash='b'.repeat(64);assert.throws(lease.assertCurrent,{code:'teloa/version-conflict'})
})
