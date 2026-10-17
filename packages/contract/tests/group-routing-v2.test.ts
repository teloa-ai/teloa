import assert from 'node:assert/strict'
import {test} from 'node:test'
import {groupRoutingOutputV2,groupRoutingOutputV2Schema,groupWorkContinuationRunRequestId,groupWorkInputRequestId,isGroupRoutingDecision} from '../src/group-routing.ts'
import {groupWorkInput,isGroupWorkInputReceipt} from '../src/group-work-inputs.ts'

const A='aaaaaaaa-1111-4111-8111-111111111111',B='bbbbbbbb-1111-4111-8111-111111111111',T='cccccccc-1111-4111-8111-111111111111',R='dddddddd-1111-4111-8111-111111111111'
const source='整理这些记录，生成跟进表，不要修改原记录。'
const answer=(patch:Record<string,unknown>)=>JSON.stringify({schema:groupRoutingOutputV2Schema,intent:'reply',respond:[A],reactions:[],assignments:[],workTarget:null,...patch})
const invalid={code:'teloa/invalid-input'}
const parse=(patch:Record<string,unknown>,text=source)=>groupRoutingOutputV2(answer(patch),[A,B],[{taskId:T,runId:R}],text)

test('明确工作：每位实际接手者恰一个原文范围，范围必须落在本人原文内',()=>{
 const work=parse({intent:'work',respond:[A,B],assignments:[{roleId:A,instructionRange:{start:0,end:source.length}}]})
 assert.deepEqual(work.assignments,[{roleId:A,instructionRange:{start:0,end:source.length}}])
 assert.deepEqual(work.respond,[A,B],'其余被点名者只受限回复')
 for(const bad of [
  {intent:'work',respond:[A],assignments:[]},
  {intent:'work',respond:[A],assignments:[{roleId:B,instructionRange:{start:0,end:2}}]},
  {intent:'work',respond:[A],assignments:[{roleId:A,instructionRange:{start:0,end:source.length+1}}]},
  {intent:'work',respond:[A],assignments:[{roleId:A,instructionRange:{start:3,end:3}}]},
  {intent:'work',respond:[A],assignments:[{roleId:A,instructionRange:{start:0,end:2}},{roleId:A,instructionRange:{start:2,end:4}}]},
  {intent:'work',respond:[A],assignments:[{roleId:A,instructionRange:{start:0,end:2}}],goal:'模型自拟的新目标'},
 ])assert.throws(()=>parse(bad),invalid)
})

test('跨业务分工只可固定该员工候选业务与原文中的固定对象，不接受模型扩展目标',()=>{
 const assignment={roleId:A,instructionRange:{start:0,end:source.length},businessTarget:{scope:'SOC'}}
 const output=groupRoutingOutputV2(answer({intent:'work',assignments:[assignment]}),[A],[],source,[{roleId:A,scopes:['SOC']}])
 assert.deepEqual(output.assignments,[assignment])
 assert.throws(()=>groupRoutingOutputV2(answer({intent:'work',assignments:[assignment]}),[A],[],source,[{roleId:A,scopes:['AppSec']}]),invalid)
 assert.throws(()=>groupRoutingOutputV2(answer({intent:'work',assignments:[{...assignment,businessTarget:{scope:'SOC',object:{scope:'SOC',type:'alert',id:'guessed-object',version:1,snapshotHash:'a'.repeat(64)}}}]}),[A],[],source,[{roleId:A,scopes:['SOC']}]),invalid)
})

test('范围不能切开代理对；问好、澄清与记录不接受分工或工作目标',()=>{
 const emoji='😀确认',ok=groupRoutingOutputV2(answer({intent:'work',assignments:[{roleId:A,instructionRange:{start:0,end:2}}]}),[A],[],emoji)
 assert.equal(ok.assignments.length,1)
 assert.throws(()=>groupRoutingOutputV2(answer({intent:'work',assignments:[{roleId:A,instructionRange:{start:1,end:3}}]}),[A],[],emoji),invalid)
 assert.throws(()=>groupRoutingOutputV2(answer({intent:'work',assignments:[{roleId:A,instructionRange:{start:0,end:1}}]}),[A],[],emoji),invalid)
 for(const intent of ['none','reply','clarify'])assert.throws(()=>parse({intent,workTarget:{taskId:T,runId:R}}),invalid)
 assert.equal(parse({intent:'none',respond:[]}).intent,'none')
})

test('追加与停止：目标必须逐字匹配宿主给出的本群候选工作',()=>{
 assert.deepEqual(parse({intent:'continue',respond:[],workTarget:{taskId:T,runId:R}}).workTarget,{taskId:T,runId:R})
 assert.throws(()=>parse({intent:'stop',respond:[],workTarget:null}),invalid)
 assert.throws(()=>parse({intent:'stop',respond:[],workTarget:{taskId:T,runId:null}}),invalid,'运行身份不一致也拒绝')
 assert.throws(()=>parse({intent:'continue',respond:[],workTarget:{taskId:A,runId:R}}),invalid,'候选外任务')
})

test('决策：v2 三键要么都有要么都没有；分工只能落在 respond 里',()=>{
 const base={kind:'routed',respond:[A],reactions:[],hops:0,candidateIds:[A,B],truncatedCandidates:false,stopMessageId:null,at:'2026-10-14T00:00:00.000Z'}
 assert.equal(isGroupRoutingDecision(base),true)
 assert.equal(isGroupRoutingDecision({...base,intent:'work',assignments:[{roleId:A,instructionRange:{start:0,end:2}}],workTarget:null}),true)
 assert.equal(isGroupRoutingDecision({...base,intent:'work'}),false)
 assert.equal(isGroupRoutingDecision({...base,intent:'work',assignments:[{roleId:B,instructionRange:{start:0,end:2}}],workTarget:null}),false)
})

test('追加回执与身份：请求严格解析，回执闭集；同一消息与任务的身份随尝试世代变化',()=>{
 const input={requestId:R,groupId:A,messageId:B,taskId:T,expectedTaskVersion:3,operation:'continue'}
 assert.deepEqual(groupWorkInput(input),input)
 for(const bad of [{operation:'restart'},{expectedTaskVersion:0},{text:'补上负责人列'}])assert.throws(()=>groupWorkInput({...input,...bad}),invalid)
 assert.equal(isGroupWorkInputReceipt({requestId:R,taskId:T,taskVersion:4,runId:null,state:'reserved',nativeRequestId:null,acceptedSeq:null,operation:'continue'}),true)
 assert.equal(isGroupWorkInputReceipt({requestId:R,taskId:T,taskVersion:4,runId:null,state:'delivered',nativeRequestId:null,acceptedSeq:null,operation:'continue'}),false)
 assert.notEqual(groupWorkInputRequestId('o',B,T,1),groupWorkInputRequestId('o',B,T,2))
 assert.notEqual(groupWorkContinuationRunRequestId('o',R),R)
})

test('依赖分工：阶段从 1 开始连续；后序阶段只记录序号，宿主据此先只启动当前阶段',()=>{
 const two=parse({intent:'work',respond:[A,B],assignments:[{roleId:A,instructionRange:{start:0,end:4}},{roleId:B,instructionRange:{start:0,end:4},stage:2}]})
 assert.deepEqual(two.assignments.map(item=>item.stage??1),[1,2])
 assert.throws(()=>parse({intent:'work',respond:[A],assignments:[{roleId:A,instructionRange:{start:0,end:4},stage:2}]}),invalid,'只有后序阶段而没有当前阶段')
 assert.throws(()=>parse({intent:'work',respond:[A,B],assignments:[{roleId:A,instructionRange:{start:0,end:4}},{roleId:B,instructionRange:{start:0,end:4},stage:3}]}),invalid,'阶段不连续')
 assert.throws(()=>parse({intent:'work',respond:[A],assignments:[{roleId:A,instructionRange:{start:0,end:4},stage:0}]}),invalid)
})
