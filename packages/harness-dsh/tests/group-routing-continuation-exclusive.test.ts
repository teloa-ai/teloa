import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {groupRoutingOutputV2Schema,type GroupRoutingDecision,type GroupTaskCreateInput} from '@teloa/contract'
import {teloaAgentPresetId} from '../src/composition-safety.ts'
import {dispatchGroupRouting,type GroupRoutingDispatchPorts,type GroupRoutingMessage} from '../src/group-routing-dispatch.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

/**
 * 纯桩端口复现「续办成功仍额外派同员工交流回应」：不起数据库，只验证 `dispatchGroupRouting` 的编排决定。
 * 真实日志（soc-flagship-2026-10-18/real-log-delivery）里的组合：本人消息无 @、引用员工正式交付 →
 * 宿主按引用作者固定接收者；模型判 continue 的同时把同一员工放进 respond。
 */
type PoolClient=Parameters<Parameters<GroupRoutingDispatchPorts['decisions']['withTopicLock']>[3]>[0]
type WorkCandidate=Awaited<ReturnType<NonNullable<GroupRoutingDispatchPorts['workCandidates']>>>[number]

const endedTurn=(requestId:string,text:string)=>[
 {seq:0,time:0,type:'turn/start',data:{turn:0}},
 {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:requestId},content:[],id:'ask',role:'user'}},
 {seq:2,time:2,type:'assistant/message',surfaceOp:'append',data:{turn:0,message:{content:[{type:'text',text}]}}},
 {seq:3,time:3,type:'turn/end',data:{turn:0,reason:{kind:'stop'}}},
]
const v2=(patch:Record<string,unknown>)=>JSON.stringify({schema:groupRoutingOutputV2Schema,intent:'reply',respond:[],reactions:[],assignments:[],workTarget:null,...patch})

function modelStub(answer:string,options:{broken?:boolean}={}){
 let events:unknown[]=[]
 const session={id:'routing',header:{},snapshotEvents:()=>events},calls={prompt:0}
 const ctx={
  get:(name:string)=>name==='teloaResidentInputAdmission'?{bindRouting:async()=>()=>{}}:undefined,
  logger:{warn:()=>{},error:()=>{}},
  agentPresets:{resolve:async(id?:string)=>({id:id??teloaAgentPresetId})},
  sessionController:{
   inspect:async(id:unknown)=>({meta:{id:String(id),agentPreset:teloaAgentPresetId}}),
   create:async(request:{sessionId:string})=>({sessionId:request.sessionId}),
   prompt:async(request:Record<string,unknown>)=>{calls.prompt+=1;if(options.broken)throw Error('模型通道不可用');events=endedTurn(String(request.requestId),answer);return {accepted:true as const}},
   resolveAgent:async()=>({agent:{session}}),
  },
 } as unknown as Context
 return {ctx,calls}
}

function harness(input:{trigger:GroupRoutingMessage;candidates:{roleId:string;name:string}[];work:WorkCandidate[];outcome?:'reserved'|'rejected'}){
 const db={query:async()=>({rows:[]})} as unknown as PoolClient
 const decisions=new Map<string,GroupRoutingDecision>()
 const recorded={createTask:[] as GroupTaskCreateInput[],reserved:[] as {taskId:string;operation:string}[]}
 const ports:GroupRoutingDispatchPorts={
  decisions:{
   identity:{now:()=>new Date().toISOString()},
   withTopicLock:async(_owner,_groupId,_rootId,fn)=>fn(db),
   claimed:async(_db,_owner,messageId)=>decisions.has(messageId),
   isStopMessage:async()=>false,relayGateOpen:async()=>true,relayStopMessageId:async()=>null,relayStopRounds:async()=>0,hops:async()=>0,
   record:async(_db,_owner,params)=>{decisions.set(params.messageId,params.decision);return params.decision},
  },
  group:async()=>({version:1,archived:false,name:'路由群'}),
  message:async()=>input.trigger,
  candidates:async()=>input.candidates.map(candidate=>({...candidate,roleVersion:1,duty:'照看订单',scopes:['SOC'],...testRoleResponsibility})),
  topic:async()=>[],
  workCandidates:async()=>input.work,
  workInputs:{reserveInTransaction:async(_db,_owner,request)=>{const fixed=request as {requestId:string;taskId:string;operation:'continue'|'stop'};recorded.reserved.push({taskId:fixed.taskId,operation:fixed.operation});return {requestId:fixed.requestId,taskId:fixed.taskId,taskVersion:9,runId:null,state:input.outcome??'reserved',nativeRequestId:null,acceptedSeq:null,operation:fixed.operation}}},
  createTask:async(_owner,task)=>{recorded.createTask.push(task);return {taskId:randomUUID()}},
  prepare:async()=>({runId:randomUUID()}),
  start:async()=>({state:'active'}),
  sendSystem:async()=>({id:randomUUID()}),
  applyReaction:async()=>{},
 }
 return {ports,recorded,decision:(messageId:string)=>decisions.get(messageId)}
}

const selfMessage=(groupId:string,rootId:string,text:string,replyAuthorRoleId:string|null):GroupRoutingMessage=>({groupId,rootId,authorKind:'self',authorId:'self',authorName:'用户',text,createdAt:new Date().toISOString(),mentions:[],mentionAll:false,replyAuthorRoleId})

test('明确引用原任务时，模型选到同群同名旧交流任务也必须拒绝，不登记错误续办',async()=>{
 const owner=randomUUID(),groupId=randomUUID(),rootId=randomUUID(),messageId=randomUUID(),roleId=randomUUID(),taskId=randomUUID(),runId=randomUUID(),wrongTask=randomUUID(),wrongRun=randomUUID()
 const {ports,recorded,decision}=harness({trigger:selfMessage(groupId,rootId,'继续本条引用对应的原案件，不换案例。',roleId),candidates:[{roleId,name:'研判员'}],work:[
  {taskId,runId,title:'原调查',state:'waiting',version:9,quoted:true,assigneeRoleId:roleId},
  {taskId:wrongTask,runId:wrongRun,title:'原案件继续调查',state:'waiting',version:3,assigneeRoleId:roleId},
 ]})
 await dispatchGroupRouting(modelStub(v2({intent:'continue',respond:[roleId],workTarget:{taskId:wrongTask,runId:wrongRun}})).ctx,owner,messageId,ports,AbortSignal.timeout(20000))
 assert.equal(decision(messageId)?.kind,'parse-failed')
 assert.deepEqual(recorded.reserved,[])
 assert.deepEqual(recorded.createTask,[])
})

test('引用员工交付的续办：原任务负责人已是续办接收者，模型同时选中该员工也不另派交流回应任务',async()=>{
 const owner=randomUUID(),groupId=randomUUID(),rootId=randomUUID(),messageId=randomUUID(),a=randomUUID(),b=randomUUID(),taskId=randomUUID(),runId=randomUUID()
 const {ports,recorded,decision}=harness({trigger:selfMessage(groupId,rootId,'继续原任务，按退回意见修订，不另建工作。',a),candidates:[{roleId:a,name:'售后'},{roleId:b,name:'物流'}],work:[{taskId,runId,title:'原工作',state:'waiting',version:9,quoted:true,assigneeRoleId:a}]})
 await dispatchGroupRouting(modelStub(v2({intent:'continue',respond:[a],workTarget:{taskId,runId}})).ctx,owner,messageId,ports,AbortSignal.timeout(20000))
 assert.deepEqual(recorded.reserved,[{taskId,operation:'continue'}],'续办登记到原任务')
 assert.deepEqual([decision(messageId)?.kind,decision(messageId)?.respond],['direct',[]],'续办接收者就是原任务负责人，决策里不再把同一员工列为交流回应者')
 assert.equal(recorded.createTask.length,0,'不得再为同一员工另建交流回应任务')
})

test('续办登记被持久记为拒绝时同样不降级成新任务：保留拒绝回执，不改派',async()=>{
 const owner=randomUUID(),groupId=randomUUID(),rootId=randomUUID(),messageId=randomUUID(),a=randomUUID(),taskId=randomUUID(),runId=randomUUID()
 const {ports,recorded}=harness({trigger:selfMessage(groupId,rootId,'再继续一次原任务。',a),candidates:[{roleId:a,name:'售后'}],work:[{taskId,runId,title:'原工作',state:'waiting',version:9,quoted:true,assigneeRoleId:a}],outcome:'rejected'})
 await dispatchGroupRouting(modelStub(v2({intent:'continue',respond:[a],workTarget:{taskId,runId}})).ctx,owner,messageId,ports,AbortSignal.timeout(20000))
 assert.deepEqual(recorded.reserved,[{taskId,operation:'continue'}])
 assert.equal(recorded.createTask.length,0,'续办未成功也不能改派成新任务')
})

test('引用原工作时模型通道故障：记可重试的 degraded、不派交流回应、不登记续办；无引用工作时沿用引用作者直接回应',async()=>{
 const owner=randomUUID(),groupId=randomUUID(),rootId=randomUUID(),a=randomUUID(),taskId=randomUUID(),runId=randomUUID()
 const quoted=randomUUID(),withWork=harness({trigger:selfMessage(groupId,rootId,'# 原任务标题\n按同一案例更新调查交付。',a),candidates:[{roleId:a,name:'调查员'}],work:[{taskId,runId,title:'原任务标题',state:'waiting',version:9,quoted:true,assigneeRoleId:a}]})
 await dispatchGroupRouting(modelStub('',{broken:true}).ctx,owner,quoted,withWork.ports,AbortSignal.timeout(20000))
 assert.deepEqual([withWork.decision(quoted)?.kind,withWork.decision(quoted)?.respond],['degraded',[]],'明确引用原工作的消息在模型故障时必须可见失败且可重试，不得默默降级为交流回应')
 assert.equal(withWork.recorded.createTask.length,0);assert.equal(withWork.recorded.reserved.length,0,'不凭正则强判续办')
 const plain=randomUUID(),noWork=harness({trigger:selfMessage(groupId,rootId,'这个数怎么来的？',a),candidates:[{roleId:a,name:'调查员'}],work:[{taskId,runId,title:'别的工作',state:'waiting',version:9,assigneeRoleId:a}]})
 await dispatchGroupRouting(modelStub('',{broken:true}).ctx,owner,plain,noWork.ports,AbortSignal.timeout(20000))
 assert.deepEqual([noWork.decision(plain)?.kind,noWork.decision(plain)?.respond],['direct',[a]],'没有引用原工作时保持原有的引用作者直接回应退化')
})

test('引用原工作时模型输出指向其他任务（解析不过）：记可重试的 parse-failed，不建任务、不登记任何续办',async()=>{
 const owner=randomUUID(),groupId=randomUUID(),rootId=randomUUID(),messageId=randomUUID(),a=randomUUID(),taskId=randomUUID(),runId=randomUUID()
 const {ports,recorded,decision}=harness({trigger:selfMessage(groupId,rootId,'继续原任务，更新交付。',a),candidates:[{roleId:a,name:'调查员'}],work:[{taskId,runId,title:'原任务',state:'waiting',version:9,quoted:true,assigneeRoleId:a}]})
 await dispatchGroupRouting(modelStub(v2({intent:'continue',workTarget:{taskId:randomUUID(),runId}})).ctx,owner,messageId,ports,AbortSignal.timeout(20000))
 assert.deepEqual([decision(messageId)?.kind,decision(messageId)?.respond],['parse-failed',[]])
 assert.equal(recorded.createTask.length,0);assert.equal(recorded.reserved.length,0,'不能借引用把续办指向别的任务')
})

test('真实形状一：本人引用已 quoted 原工作，模型输出 work＋同一 workTarget＋整句 range（非法互斥）：parse-failed、respond 空、不建交流任务、不登记续办',async()=>{
 const owner=randomUUID(),groupId=randomUUID(),rootId=randomUUID(),messageId=randomUUID(),a=randomUUID(),taskId=randomUUID(),runId=randomUUID()
 const text='# 原任务标题\n'+'按同一案例更新调查交付。'.repeat(60)
 const {ports,recorded,decision}=harness({trigger:selfMessage(groupId,rootId,text,a),candidates:[{roleId:a,name:'调查员'}],work:[{taskId,runId,title:'原任务标题',state:'waiting',version:9,quoted:true,assigneeRoleId:a}]})
 await dispatchGroupRouting(modelStub(v2({intent:'work',respond:[a],assignments:[{roleId:a,instructionRange:{start:0,end:text.length}}],workTarget:{taskId,runId}})).ctx,owner,messageId,ports,AbortSignal.timeout(20000))
 assert.deepEqual([decision(messageId)?.kind,decision(messageId)?.respond],['parse-failed',[]],'非法结构不猜成工作或续办，也不退化成交流回应')
 assert.equal(recorded.createTask.length,0);assert.equal(recorded.reserved.length,0)
})

test('真实形状二：员工正式交接，模型输出 work＋respond 目标员工＋assignments 空（非法互斥），且员工消息没有候选工作：parse-failed、respond 空、不建任务',async()=>{
 const owner=randomUUID(),groupId=randomUUID(),rootId=randomUUID(),messageId=randomUUID(),a=randomUUID(),b=randomUUID()
 const trigger:GroupRoutingMessage={groupId,rootId,authorKind:'role',authorId:a,authorName:'一线',text:'升级@调查员，交接事件A，具体问题：能否判定影响、尚缺什么，请独立交付调查结果。',createdAt:new Date().toISOString(),mentions:[b],replyAuthorRoleId:null}
 const {ports,recorded,decision}=harness({trigger,candidates:[{roleId:a,name:'一线'},{roleId:b,name:'调查员'}],work:[]})
 await dispatchGroupRouting(modelStub(v2({intent:'work',respond:[b],assignments:[],workTarget:null})).ctx,owner,messageId,ports,AbortSignal.timeout(20000))
 assert.deepEqual([decision(messageId)?.kind,decision(messageId)?.respond],['parse-failed',[]],'没有引用工作也不能把解析失败降级成交流任务')
 assert.equal(recorded.createTask.length,0);assert.equal(recorded.reserved.length,0)
})

test('引用原工作但模型判普通提问（reply）：仍按被引用员工直接回应，不登记续办',async()=>{
 const owner=randomUUID(),groupId=randomUUID(),rootId=randomUUID(),messageId=randomUUID(),a=randomUUID(),taskId=randomUUID(),runId=randomUUID()
 const {ports,recorded,decision}=harness({trigger:selfMessage(groupId,rootId,'这份交付里的数字怎么来的？',a),candidates:[{roleId:a,name:'调查员'}],work:[{taskId,runId,title:'原任务',state:'waiting',version:9,quoted:true,assigneeRoleId:a}]})
 await dispatchGroupRouting(modelStub(v2({intent:'reply',respond:[a]})).ctx,owner,messageId,ports,AbortSignal.timeout(20000))
 assert.deepEqual([decision(messageId)?.kind,decision(messageId)?.respond],['direct',[a]])
 assert.deepEqual(recorded.createTask.map(item=>item.assignee?.roleId),[a]);assert.equal(recorded.reserved.length,0)
})

test('续办互斥只针对原任务负责人：另一位员工的交流回应照常派发；普通 reply 不受影响',async()=>{
 const owner=randomUUID(),groupId=randomUUID(),rootId=randomUUID(),a=randomUUID(),b=randomUUID(),taskId=randomUUID(),runId=randomUUID()
 const other=randomUUID()
 const mixed=harness({trigger:selfMessage(groupId,rootId,'继续原来的整理，物流也说一下情况。',null),candidates:[{roleId:a,name:'售后'},{roleId:b,name:'物流'}],work:[{taskId,runId,title:'原工作',state:'waiting',version:9,assigneeRoleId:a}]})
 await dispatchGroupRouting(modelStub(v2({intent:'continue',respond:[a,b],workTarget:{taskId,runId}})).ctx,owner,other,mixed.ports,AbortSignal.timeout(20000))
 assert.deepEqual(mixed.decision(other)?.respond,[b]);assert.equal(mixed.recorded.reserved.length,1)
 assert.deepEqual(mixed.recorded.createTask.map(item=>item.assignee?.roleId),[b])
 const plain=randomUUID(),reply=harness({trigger:selfMessage(groupId,rootId,'这个数怎么来的？',a),candidates:[{roleId:a,name:'售后'}],work:[{taskId,runId,title:'原工作',state:'waiting',version:9,assigneeRoleId:a}]})
 await dispatchGroupRouting(modelStub(v2({intent:'reply',respond:[a]})).ctx,owner,plain,reply.ports,AbortSignal.timeout(20000))
 assert.deepEqual(reply.decision(plain)?.respond,[a]);assert.equal(reply.recorded.reserved.length,0)
 assert.deepEqual(reply.recorded.createTask.map(item=>item.assignee?.roleId),[a],'普通交流仍派给被引用员工')
})
