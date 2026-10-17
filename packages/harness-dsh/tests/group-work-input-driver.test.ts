import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,groupWorkContinuationRunRequestId,groupWorkInputTransitions,type GroupWorkInputReceipt,type GroupWorkInputState} from '@teloa/contract'
import {drainGroupWorkInputs,type GroupWorkInputPorts} from '../src/group-work-input-driver.ts'

const T='cccccccc-1111-4111-8111-111111111111',R='dddddddd-1111-4111-8111-111111111111',S='eeeeeeee-1111-4111-8111-111111111111',RUN='ffffffff-1111-4111-8111-111111111111'

/**
 * 有状态替身：回执迁移严格使用服务端同一张迁移表，Run 状态按准备身份幂等；可注入「崩溃点」。
 * 用来证明驱动在每个断点后都能按原身份恢复，而不是依赖替身允许的非法迁移。
 */
function world(options:{activeRun?:boolean;operation?:'continue'|'stop'}={}){
 let row:GroupWorkInputReceipt={requestId:R,taskId:T,taskVersion:3,runId:null,state:'reserved',nativeRequestId:null,acceptedSeq:null,operation:options.operation??'continue'}
 let versionBumps=0,activeRun=options.activeRun??false
 const runs=new Map<string,{id:string;state:string;nativeRequestId:string}>(),prepared:string[]=[]
 const faults=new Set<string>(),calls:string[]=[]
 const fault=(name:string)=>{if(faults.has(name)){faults.delete(name);throw new Error('崩溃：'+name)}}
 const ports:GroupWorkInputPorts={
  inputs:{
   pending:async()=>['reserved','continued','unknown'].includes(row.state)?[{...row,groupId:S,messageId:S,observedRunId:null,versioned:versionBumps>0}]:[],
   continueTask:async()=>{
    calls.push('continue')
    if(!(row.state==='reserved'||row.state==='unknown'&&versionBumps===0))return {...row}
    if(activeRun)return {...row}
    versionBumps++;row={...row,state:'continued',taskVersion:row.taskVersion+1}
    fault('after-version')
    return {...row}
   },
   settle:async(_owner,input)=>{
    calls.push('settle:'+input.state)
    if(!groupWorkInputTransitions[row.state].includes(input.state as GroupWorkInputState))return {...row}
    if(row.runId&&input.runId&&row.runId!==input.runId)return {...row}
    row={...row,state:input.state,runId:row.runId??input.runId,nativeRequestId:row.nativeRequestId??input.nativeRequestId??null}
    return {...row}
   },
  },
  prepare:async(_owner,input)=>{
   calls.push('prepare');prepared.push(input.requestId)
   let run=[...runs.values()].find(item=>item.nativeRequestId==='native:'+input.requestId)
   if(!run){run={id:RUN,state:'prepared',nativeRequestId:'native:'+input.requestId};runs.set(run.id,run)}
   fault('prepare-lost')
   return {runId:run.id}
  },
  start:async(_owner,runId)=>{calls.push('start');const run=runs.get(runId)!;run.state='submitting';fault('start-unknown');run.state='accepted';return {state:run.state}},
  readRun:async(_owner,runId)=>({...runs.get(runId)!}),
  reconcile:async(_owner,runId)=>{calls.push('reconcile');const run=runs.get(runId)!;if(run.state==='submitting')run.state='accepted';return {state:run.state}},
  stop:async()=>{calls.push('stop');fault('stop-unknown');return 'accepted'},
  report:()=>{},
 }
 return {ports,faults,calls,read:()=>row,versionBumps:()=>versionBumps,prepared,runs,setActive:(value:boolean)=>{activeRun=value}}
}
const drain=(ports:GroupWorkInputPorts)=>drainGroupWorkInputs('owner',ports,AbortSignal.timeout(1000))

test('原 Run 仍在进行：追加保持已保存，不升版本、不准备、不启动',async()=>{
 const w=world({activeRun:true});await drain(w.ports)
 assert.equal(w.read().state,'reserved');assert.equal(w.versionBumps(),0);assert.deepEqual(w.prepared,[])
 w.setActive(false);await drain(w.ports)
 assert.equal(w.read().state,'accepted');assert.equal(w.versionBumps(),1)
 assert.equal(w.read().nativeRequestId,'native:'+groupWorkContinuationRunRequestId('owner',R),'只在核实原生受理后固定原生身份')
})

test('升版本后崩溃：回执停在 continued 仍可拾取；恢复只准备一次 Run，不再升版本',async()=>{
 const w=world();w.faults.add('after-version');await drain(w.ports).catch(()=>{})
 assert.equal(w.read().state,'unknown','异常回填为待核对，仍保留在待处理目录')
 await drain(w.ports)
 assert.equal(w.read().state,'accepted');assert.equal(w.versionBumps(),1);assert.equal(w.runs.size,1)
})

test('prepare 丢回包：按同一准备身份取回原 Run，不新建 Run',async()=>{
 const w=world();w.faults.add('prepare-lost');await drain(w.ports)
 assert.equal(w.read().state,'unknown');assert.equal(w.read().runId,null)
 await drain(w.ports)
 assert.deepEqual(new Set(w.prepared).size,1,'两次准备使用同一派生身份');assert.equal(w.runs.size,1);assert.equal(w.read().state,'accepted')
})

test('记录 Run 身份后、启动前崩溃：恢复从 prepared 原 Run 启动；启动结果未知时只核对原 Run',async()=>{
 const w=world();w.faults.add('start-unknown');await drain(w.ports)
 assert.deepEqual([w.read().state,w.read().runId],['unknown',RUN],'启动未知保留原 Run 身份')
 await drain(w.ports)
 assert.ok(w.calls.includes('reconcile'),'未知启动只经 reconcile 核对原请求');assert.equal(w.calls.filter(call=>call==='start').length,1,'不重复启动')
 assert.equal(w.read().state,'accepted')
})

test('非法迁移被拒：终态回执不会被改回未知；停止只提交原工作控制',async()=>{
 const w=world();await drain(w.ports);assert.equal(w.read().state,'accepted')
 await w.ports.inputs.settle('owner',{requestId:R,state:'unknown',runId:RUN,reason:'x'})
 assert.equal(w.read().state,'accepted')
 const stop=world({operation:'stop'});stop.faults.add('stop-unknown');await drain(stop.ports)
 assert.equal(stop.read().state,'unknown');await drain(stop.ports);assert.equal(stop.read().state,'accepted')
})

test('确定性失败：尚无 Run 身份时拒绝；已有 Run 身份时只记待核对',async()=>{
 const w=world();w.ports.prepare=async()=>{throw new WorkError('teloa/version-conflict','原任务已变化。')}
 await drain(w.ports);assert.equal(w.read().state,'rejected')
})
