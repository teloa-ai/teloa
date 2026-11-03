import test from 'node:test'
import assert from 'node:assert/strict'
import type {TaskRun} from '@teloa/backend'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import type {WorkControl} from '@teloa/contract'
import {TaskRunDriver,type TaskRunPorts} from '../src/task-run-driver.ts'

function fixture(){
 let run={id:'run',taskId:'task',sessionId:'session',nativeRequestId:'native',state:'active',evidence:{state:'active',turn:1,messageSeq:1},stopRequestedAt:null,allowedTools:['read_file'],skills:[],inputText:'合成任务固定原文',lineage:{}} as unknown as TaskRun
 let control:WorkControl['state']='paused',records=0,proofs=0,effects=0;const modes:unknown[]=[]
 let events=[{seq:0,time:0,type:'turn/start',data:{turn:1}},{seq:1,time:1,type:'user/message',surfaceOp:'append',data:{id:'message',role:'user',source:{kind:'user',rpcId:'native'},content:[{type:'text',text:run.inputText}]}},{seq:2,time:2,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}] as SessionEvent[]
 const denied=async()=>{effects++;throw Error('终态记账不能执行、恢复或发布')}
 const ports:TaskRunPorts={check:denied,send:denied,stop:denied,events:async()=>structuredClone(events),backgroundState:async()=>({outstanding:false,interrupted:true}),continuations:async()=>new Set(),goalObservation:async()=>undefined,controlState:async()=>control,subagentState:async()=> 'none',flowState:async()=> 'none',retryOwnerOnlyBackground:async()=>{proofs++;return true},publishOwnerResult:denied,publishGroupResult:denied}
 const service={get:async()=>run,claim:denied,executionScope:denied,requestStop:denied,record:async(_owner:string,value:{evidence:NonNullable<TaskRun['evidence']>},mode?:unknown)=>{modes.push(mode);records++;run={...run,state:value.evidence.state,evidence:value.evidence};return run}}
 const internal={...service,settleDeferred:async(_owner:string,_input:unknown)=>{modes.push({settleDeferred:true});return{run,disposition:'settled' as const}}}
 const driver=new TaskRunDriver(internal as unknown as ConstructorParameters<typeof TaskRunDriver>[0],ports)
 return{driver,ports,read:()=>run,replace:(value:TaskRun)=>run=value,control:(value:WorkControl['state'])=>control=value,events:()=>events,setEvents:(value:SessionEvent[])=>events=value,records:()=>records,modes:()=>modes,proofs:()=>proofs,effects:()=>effects,reconcile:()=>driver.reconcile('owner',{runId:run.id})}
}

test('143 暂停/正在暂停只记录可信completed终态，控制不变且不执行或交付',async()=>{
 for(const state of ['paused','pausing'] as const){const f=fixture();f.control(state);const before=f.events();const run=await f.reconcile();assert.equal(run.state,'ended');assert.deepEqual(run.evidence,{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'});assert.equal(f.records(),1);assert.equal(f.proofs(),2);assert.equal(f.effects(),0);assert.deepEqual(f.events(),before);assert.equal(await f.ports.controlState!(run),state)}
})

test('143 暂停时未知/仍活跃资源或缺少只读证明不结案',async()=>{
 const variants:Array<(f:ReturnType<typeof fixture>)=>void>=[f=>{f.ports.backgroundState=async()=>({outstanding:true,interrupted:false})},f=>{f.ports.backgroundState=async()=>{throw Error('未知后台')}},f=>{f.ports.subagentState=async()=> 'outstanding'},f=>{f.ports.flowState=async()=> 'outstanding'},f=>{f.ports.retryOwnerOnlyBackground=async()=>false},f=>{delete f.ports.retryOwnerOnlyBackground},f=>{delete f.ports.subagentState},f=>{delete f.ports.flowState},f=>{delete f.ports.backgroundState}]
 for(const change of variants){const f=fixture();change(f);try{await f.reconcile()}catch{/* 读取失败保留未知，不伪造终态。 */}assert.equal(f.read().state,'active');assert.equal(f.records(),0);assert.equal(f.effects(),0)}
})

test('143 请求未结束、锚点/固定原文不符及Goal续轮不借暂停结案',async()=>{
 const variants:Array<(f:ReturnType<typeof fixture>)=>void>=[f=>f.setEvents(f.events().slice(0,2)),f=>f.replace({...f.read(),evidence:{state:'active',turn:2,messageSeq:1}}),f=>f.replace({...f.read(),inputText:'另一原文'}),f=>f.replace({...f.read(),nativeRequestId:'other'}),f=>{f.ports.continuations=async()=>new Set(['pending-official-continuation'])},f=>{f.ports.goalObservation=async()=>({goalPhase:'active'} as never)}]
 for(const change of variants){const f=fixture();change(f);try{await f.reconcile()}catch{}assert.equal(f.read().state,'active');assert.equal(f.records(),0);assert.equal(f.effects(),0)}
})

test('143 校验期间晚到日志、控制切换和第二次资源重验失败不结案',async()=>{
 for(const kind of ['events','control','resource'] as const){const f=fixture();let checks=0;f.ports.retryOwnerOnlyBackground=async()=>{checks++;if(checks===1){if(kind==='events')f.setEvents([...f.events(),{seq:3,time:3,type:'turn/start',data:{turn:2}} as SessionEvent]);if(kind==='control')f.control('active')}return !(kind==='resource'&&checks===2)};await f.reconcile();assert.equal(f.read().state,'active');assert.equal(f.records(),0);assert.equal(f.effects(),0)}
})

test('143 已ended的暂停运行后续对账也不能补发本人/群成果',async()=>{
 for(const publication of ['owner','group'] as const){const f=fixture();f.replace({...f.read(),state:'ended',evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'},...(publication==='owner'?{executor:{kind:'owner'}}:{groupContext:{}})} as TaskRun);const run=await f.reconcile();assert.equal(run.state,'ended');assert.equal(f.effects(),0);assert.equal(f.records(),0)}
})

test('143 普通active原有旧宿主中断分类保持，不借新暂停分支吞安全规则',async()=>{
 const f=fixture();f.control('active');const run=await f.reconcile();assert.equal(run.evidence?.state==='ended'?run.evidence.reason:undefined,'interrupted');assert.equal(f.records(),1);assert.equal(f.proofs(),0);assert.equal(f.effects(),0)
})

test('143 暂停仍不能进入领取/发送路径',async()=>{
 const f=fixture();f.replace({...f.read(),state:'prepared',lineage:{} as NonNullable<TaskRun['lineage']>});await assert.rejects(f.driver.start('owner',{runId:'run'},new AbortController().signal),{code:'teloa/forbidden'});assert.equal(f.effects(),0);assert.equal(f.records(),0)
})


test('143 恢复后ended分支走正常内部deferred结算，不再次执行原请求',async()=>{
 const f=fixture();await f.reconcile();assert.deepEqual(f.modes(),[{deferSettlement:true}]);f.control('active');await f.reconcile();assert.deepEqual(f.modes(),[{deferSettlement:true},{settleDeferred:true}]);assert.equal(f.effects(),0)
})
