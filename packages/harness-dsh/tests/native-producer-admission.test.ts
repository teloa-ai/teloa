import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkAccess,type WorkAccessRequest} from '../../backend/src/work/work-access.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {createNativeProducerAdmissions} from '../src/native-producer-admission.ts'
import {controllerAdmissionFixture,promptRequest,queueRequest} from './fixtures/native-controller-admission.ts'
import {patchedSessionPackage} from './fixtures/native-final-session.ts'
import {subagentFixture} from './fixtures/native-subagent-admission.ts'
import {scheduleFixture,until} from './fixtures/native-schedule-admission.ts'

const forbidden={code:'teloa/forbidden'},signal=new AbortController().signal

test('统一 Controller policy 接真实 prompt/queue-edit；旧回执重试不再请求许可，撤销保留原稿',async t=>{
 const f=await controllerAdmissionFixture(t),access=new WorkAccess(),seen:WorkAccessRequest[]=[],work=createNativeWorkInput(f.ctx,access)
 let valid=true
 access.requirePolicy();access.installPolicy(async request=>{seen.push(request);return {assertCurrent(){if(!valid)throw Error('revoked')}}})
 const policies=createNativeProducerAdmissions(work);assert.equal(Object.isFrozen(policies),true)
 f.controller.requireInputAdmission();f.controller.installInputAdmission(policies.controller)
 await f.controller.prompt(promptRequest(f.agent,'new-input','原稿'),signal)
 const original=f.agent.inbox.nextTurn[0]!,before=f.agent.session.seq
 assert.equal(seen.length,1);assert.equal(seen[0]?.kind,'native-input');assert.equal((seen[0] as Extract<WorkAccessRequest,{kind:'native-input'}>).producer,'prompt')
 valid=false;await f.controller.prompt(promptRequest(f.agent,'new-input','原稿'),signal);assert.equal(seen.length,1);assert.equal(f.agent.session.seq,before)
 await assert.rejects(f.controller.updateQueue(queueRequest(f.agent,original.id,'拒绝编辑')),forbidden)
 assert.equal(f.agent.inbox.nextTurn[0],original)
 valid=true
 await f.controller.updateQueue(queueRequest(f.agent,original.id,'准许编辑'))
 assert.equal(f.agent.inbox.nextTurn.length,1);assert.equal(f.agent.inbox.nextTurn[0]?.content[0]?.type,'text')
 assert.equal((seen.at(-1) as Extract<WorkAccessRequest,{kind:'native-input'}>).producer,'queue')
 assert.ok(!JSON.stringify(seen).includes('准许编辑'));assert.equal(f.agent.session.seq,before+1)
 work.close();await assert.rejects(f.controller.prompt(promptRequest(f.agent,'after-close'),signal),forbidden)
})

test('统一 Subagent policy 复用一个最终 guard；上下行实际入Inbox，关闸拒绝新输入',async t=>{
 const sessionPackage=await patchedSessionPackage(t),access=new WorkAccess(),seen:WorkAccessRequest[]=[]
 access.installPolicy(async request=>{seen.push(request);return {assertCurrent(){}}})
 let work:ReturnType<typeof createNativeWorkInput>|undefined
 const f=await subagentFixture(t,{},true,{sessionPackage,beforeService({ctx}){work=createNativeWorkInput(ctx,access)}})
 const policies=createNativeProducerAdmissions(work!);f.service.requirePromptAdmission();f.service.installPromptAdmission(policies.subagent)
 const down=await f.send(f.parent,f.child,'真实下行'),up=await f.send(f.child,f.parent,'真实上行')
 assert.equal(f.ledger(f.child).at(-1)?.id,down);assert.equal(f.ledger(f.parent).at(-1)?.id,up);assert.equal(seen.length,2)
 for(const row of seen){assert.equal(row.kind,'native-input');if(row.kind==='native-input')assert.equal(row.producer,'subagent')}
 work!.close();const before=f.ledger(f.child).length
 await assert.rejects(f.send(f.parent,f.child,'关闸下行'),forbidden);assert.equal(f.ledger(f.child).length,before);assert.equal(f.modelCalls(),0)
})

test('统一 Schedule policy 在初始due扫描前装配；真实发生项批次完成一个受理回执',async t=>{
 const now=Date.parse('2033-05-18T12:00:00.000Z');t.mock.timers.enable({apis:['Date'],now})
 const sessionPackage=await patchedSessionPackage(t),access=new WorkAccess(),seen:WorkAccessRequest[]=[]
 access.installPolicy(async request=>{seen.push(request);return {assertCurrent(){}}})
 let policies:ReturnType<typeof createNativeProducerAdmissions>|undefined
 const records=['a','b'].map(id=>({id,kind:'every',everySeconds:60,title:'固定计划',prompt:'正式计划输入',scheduledAt:new Date(now-5000).toISOString()}))
 const f=await scheduleFixture(t,{requireDeliveryAdmission:true,admitDelivery:(request,dispatch)=>policies!.schedule(request,dispatch)},records,true,undefined,{sessionPackage,beforeService({ctx}){policies=createNativeProducerAdmissions(createNativeWorkInput(ctx,access))}})
 await until(async()=>(await f.catalog()).every((row:{lastDelivery?:unknown})=>row.lastDelivery!==undefined))
 assert.equal(f.inbox().length,1);assert.equal(f.state.flushes,1);assert.equal(seen.length,1)
 const request=seen[0]!;assert.equal(request.kind,'native-input');if(request.kind==='native-input'){assert.equal(request.producer,'schedule');assert.match(request.contextSha256,/^[a-f0-9]{64}$/)}
 for(const row of await f.catalog())assert.equal(row.lastDelivery.messageId,f.inbox()[0]!.id)
 assert.ok(!JSON.stringify(seen).includes('正式计划输入'))
})
