import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WorkError,type WorkControl} from '@teloa/contract'
import {plannedRestartResume,plannedRestartWaitMs,readPlannedRestartReceipt} from '../src/planned-restart-resume.ts'

const owner='local:teloa-owner',restartId='8f0c2a52-5b8e-4f0e-9c1d-2a3b4c5d6e7f',controlId='6a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d'
const control=():WorkControl=>({id:controlId,ownerId:owner,generation:2,version:3,state:'paused',scope:'round',pendingRunIds:[],unknownOperationIds:[]})
const candidate=(safeRecovery:boolean)=>({controlId,expectedGeneration:2,runId:'r',nativeRequestId:'n',goal:null,reason:'accepted' as const,safeRecovery,resumable:true})
function ports(options:{state?:()=>string,candidates?:ReturnType<typeof candidate>[],resume?:()=>Promise<WorkControl>,now?:()=>number}={}){
 const calls:{resumes:number,records:string[],reports:string[]}={resumes:0,records:[],reports:[]}
 return {calls,ports:{controls:{plannedRestartState:async()=>options.state?.()??'ready',get:async()=>control(),recordPlannedRestart:async(_:string,input:{outcome:string})=>{calls.records.push(input.outcome)}} as never,
  inspect:async()=>options.candidates??[],resume:async()=>{calls.resumes++;return options.resume?options.resume():control()},report:(code:string)=>calls.reports.push(code),...(options.now?{now:options.now}:{})}}
}

test('只有无候选或全部 safeRecovery 的控制才自动恢复；可恢复但未开启安全恢复的保持暂停并带原因落库',async()=>{
 const held=ports({candidates:[candidate(false)]});await plannedRestartResume(owner,restartId,[control()],held.ports)(new AbortController().signal)
 assert.equal(held.calls.resumes,0);assert.deepEqual(held.calls.records,['held:candidates']);assert.deepEqual(held.calls.reports,['teloa/planned-restart-held:'+controlId+':candidates'])
 const safe=ports({candidates:[candidate(true)]});await plannedRestartResume(owner,restartId,[control()],safe.ports)(new AbortController().signal)
 assert.equal(safe.calls.resumes,1);assert.deepEqual(safe.calls.records,['resumed'])
})

test('撤防后迟迟不收口：超过时限转为保持暂停并报告，不在数小时后突然恢复',async()=>{
 let clock=0;const slow=ports({state:()=>'wait',now:()=>clock}),drain=plannedRestartResume(owner,restartId,[control()],slow.ports)
 await drain(new AbortController().signal);assert.deepEqual(slow.calls.records,[])
 clock=plannedRestartWaitMs;await drain(new AbortController().signal);await drain(new AbortController().signal)
 assert.deepEqual(slow.calls.records,['held:timeout']);assert.equal(slow.calls.resumes,0)
})

test('恢复提交后派发失败：世代已变也沿用同一请求续用票据；冲突不再重试',async()=>{
 let state='ready',fail=true
 const flaky=ports({state:()=>state,resume:async()=>{state='changed';if(fail){fail=false;throw new WorkError('teloa/unavailable','x')}return control()}}),drain=plannedRestartResume(owner,restartId,[control()],flaky.ports)
 await drain(new AbortController().signal);await drain(new AbortController().signal);await drain(new AbortController().signal)
 assert.equal(flaky.calls.resumes,2);assert.deepEqual(flaky.calls.records,['resumed'])
 const conflict=ports({resume:async()=>{throw new WorkError('teloa/conflict','x')}}),again=plannedRestartResume(owner,restartId,[control()],conflict.ports)
 for(let i=0;i<3;i++)await again(new AbortController().signal)
 assert.equal(conflict.calls.resumes,1);assert.deepEqual(conflict.calls.records,['held:teloa/conflict'])
 // 未提交恢复时本人改动了控制：直接保持暂停，不调用恢复。
 const changed=ports({state:()=>'changed'});await plannedRestartResume(owner,restartId,[control()],changed.ports)(new AbortController().signal)
 assert.equal(changed.calls.resumes,0);assert.deepEqual(changed.calls.records,['held:changed'])
})

test('宿主只接受与 upgrade.json 中仍在切换的 restartId 一致的回执',async()=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-receipt-'))
 try{
  const runtime=join(root,'instances/default/runtime');await mkdir(runtime,{recursive:true})
  const env={TELOA_PLANNED_RESTART:restartId,TELOA_RUNTIME_ROOT:runtime},record=(value:unknown)=>writeFile(join(root,'instances/default/upgrade.json'),JSON.stringify(value))
  assert.equal(await readPlannedRestartReceipt(env),undefined,'没有升级记录（如源码启动）')
  await record({from:'1',to:'2',backup:'/b',restartId,status:'switching'});assert.equal(await readPlannedRestartReceipt(env),restartId)
  await record({from:'1',to:'2',backup:'/b',restartId,status:'complete'});assert.equal(await readPlannedRestartReceipt(env),undefined,'升级已完成后不再接受')
  await record({from:'1',to:'2',backup:'/b',restartId:'0e4f8a1c-1111-4222-8333-944455556666',status:'switching'});assert.equal(await readPlannedRestartReceipt(env),undefined,'与本次升级记录不符')
  assert.equal(await readPlannedRestartReceipt({TELOA_RUNTIME_ROOT:runtime}),undefined)
 }finally{await rm(root,{recursive:true,force:true})}
})
