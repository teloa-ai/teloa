import test from 'node:test'
import assert from 'node:assert/strict'
import {evaluateWorkStagnation,inspectNativeProgressRound} from '../src/work-stagnation.ts'
import {nativeInputIdentity} from '../src/native-input-access.ts'

test('相同业务事实换seq不算进展，模型文本拒绝；持久无进展次数达到上限才等待',()=>{
 const artifact={runId:'run',seq:10,kind:'artifact' as const,referenceId:'authorized-file:sha256:version-1'},policy={stagnationRounds:3}
 assert.equal(evaluateWorkStagnation([artifact],[{...artifact,seq:20}],policy,1).progressed,false)
 assert.equal(evaluateWorkStagnation([artifact],[{...artifact,seq:30}],policy,2).shouldWait,true)
 assert.equal(evaluateWorkStagnation([artifact],[{...artifact,seq:40,referenceId:'authorized-file:sha256:version-2'}],policy,2).shouldWait,false)
 assert.throws(()=>evaluateWorkStagnation([], [{...artifact,kind:'model-text'}] as any,policy),{code:'teloa/storage-corrupt'})
})

test('进展解析器只收到持久 accepted 且真实 completed 的 Goal 本轮事件；伪来源和未结束不计',async()=>{
 const run={id:'run',nativeRequestId:'request'},binding={ownerId:'owner',runId:'run',sessionId:'session',goalId:'goal',revision:1,hostGeneration:1,controlId:'control',controlGeneration:1}
 const initial={id:'initial',role:'user',content:[],source:{kind:'user',rpcId:'request'}},continuation={id:'continuation',role:'user',content:[],source:{kind:'goal',goalId:'goal',revision:1,round:1}}
 const events:any[]=[{type:'turn/start',data:{turn:0}},{type:'user/message',surfaceOp:'append',data:initial},{type:'turn/end',data:{turn:0,reason:{kind:'completed'}}},{type:'agent/inbox/spliced',data:{inserted:[continuation]}},{type:'turn/start',data:{turn:1}},{type:'user/message',surfaceOp:'append',data:continuation},{type:'assistant/message',surfaceOp:'append',data:{turn:1,message:{content:[]}}},{type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}].map((event,seq)=>({...event,seq,time:seq}))
 const receipt={...binding,round:1,messageId:continuation.id,nativeRequestId:'goal-request',payloadSha256:nativeInputIdentity(continuation as any).payloadSha256,acceptedSeq:3,state:'accepted' as const},goal:any={binding,continuations:[receipt],goalPhase:'active',activation:'armed',pendingRound:false,childrenOutstanding:false}
 let reads=0;const resolve=async(window:any)=>{reads++;assert.deepEqual(window.map((event:any)=>event.seq),[5,6,7]);return [{runId:run.id,seq:6,kind:'artifact' as const,referenceId:'resource-version-1'}]}
 assert.equal((await inspectNativeProgressRound(run,receipt,events,goal,resolve)).completed,true);assert.equal(reads,1)
 assert.equal((await inspectNativeProgressRound(run,receipt,events.slice(0,-1),goal,resolve)).completed,false)
 assert.equal((await inspectNativeProgressRound(run,receipt,events,{...goal,continuations:[]},resolve)).completed,false);assert.equal(reads,1)
 await assert.rejects(inspectNativeProgressRound(run,receipt,events,goal,async()=>[{runId:'run',seq:1,kind:'artifact',referenceId:'foreign-round'}]),{code:'teloa/forbidden'})
})
