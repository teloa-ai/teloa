import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {WorkAccess} from '@teloa/backend'
import {WorkError as ContractWorkError} from '@teloa/contract'
import * as implementation from '../src/native-hardware-input-admission.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {createNativeProducerAdmissions} from '../src/native-producer-admission.ts'
import {controllerAdmissionFixture,promptRequest} from './fixtures/native-controller-admission.ts'
import {hotGate} from './fixtures/native-hot-causality.ts'

test('外部 MCP 输入只有宿主作用域可派发，不能凭请求编号伪造本人输入',async t=>{
 assert.equal(typeof implementation.NativeHardwareInputAdmissions,'function')
 const f=await controllerAdmissionFixture(t),authority=new implementation.NativeHardwareInputAdmissions(),input=createNativeWorkInput(f.ctx,new WorkAccess()),gate=hotGate()
 t.after(()=>{authority.close();input.close();gate.release()})
 f.controller.requireInputAdmission();f.controller.installInputAdmission(createNativeProducerAdmissions(input,undefined,undefined,authority).controller)
 const fixed={requestId:randomUUID(),sessionId:String(f.agent.id),text:'请小松鼠整理测试记录。'}
 const work=new AbortController(),pending=authority.withPrompt(fixed,()=>{},async()=>{await gate.wait();return f.controller.prompt(promptRequest(f.agent,fixed.requestId,fixed.text),work.signal)})
 await gate.entered
 await assert.rejects(f.controller.prompt(promptRequest(f.agent,fixed.requestId,'伪造内容'),work.signal),{code:'teloa/forbidden'})
 assert.equal(f.agent.inbox.nextTurn.length,0)
 gate.release();await pending
 assert.equal(f.agent.inbox.nextTurn.length,1)
 assert.deepEqual(f.agent.inbox.nextTurn[0]?.content,[{type:'text',text:fixed.text}])
 await assert.rejects(authority.withPrompt(fixed,()=>{},async()=>{}),{code:'teloa/conflict'})
})

test('撤销发生在原生许可等待期间，最终 Session 写入为零',async t=>{
 assert.equal(typeof implementation.NativeHardwareInputAdmissions,'function')
 const f=await controllerAdmissionFixture(t),authority=new implementation.NativeHardwareInputAdmissions(),access=new WorkAccess(),gate=hotGate()
 t.after(gate.release)
 access.installPolicy(async()=>{await gate.wait();return {assertCurrent(){}}})
 const input=createNativeWorkInput(f.ctx,access);t.after(()=>{authority.close();input.close()})
 f.controller.requireInputAdmission();f.controller.installInputAdmission(createNativeProducerAdmissions(input,undefined,undefined,authority).controller)
 const fixed={requestId:randomUUID(),sessionId:String(f.agent.id),text:'不得接纳撤销后的内容。'}
 let active=true
 const pending=authority.withPrompt(fixed,()=>{if(!active)throw new ContractWorkError('teloa/forbidden','已撤销')},()=>f.controller.prompt(promptRequest(f.agent,fixed.requestId,fixed.text),new AbortController().signal))
 void pending.catch(()=>{})
 await gate.entered;active=false;gate.release()
 await assert.rejects(pending,{code:'teloa/forbidden'})
 assert.equal(f.agent.inbox.nextTurn.length,0)
})
