import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {WorkAccess} from '@teloa/backend'
import {readTranscriptCommit} from '@teloa/contract'
import {NativeVoiceInputAdmissions} from '../src/native-voice-input-admission.ts'
import {NativeHardwareInputAdmissions} from '../src/native-hardware-input-admission.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {createNativeProducerAdmissions} from '../src/native-producer-admission.ts'
import {admitDirectDeviceInput} from '../src/direct-device-admission.ts'
import {controllerAdmissionFixture,promptRequest} from './fixtures/native-controller-admission.ts'

test('直连在真实 Controller 同时通过 voice/hardware 最终守卫，来源恢复后也不能凭原 UUID 冒充',async t=>{
 const f=await controllerAdmissionFixture(t),voice=new NativeVoiceInputAdmissions(),hardware=new NativeHardwareInputAdmissions(),input=createNativeWorkInput(f.ctx,new WorkAccess())
 t.after(()=>{voice.close();hardware.close();input.close()})
 f.controller.requireInputAdmission();f.controller.installInputAdmission(createNativeProducerAdmissions(input,undefined,voice,hardware).controller)
 const commit=readTranscriptCommit({target:'assistant',ownerId:'owner',sessionId:String(f.agent.id),scope:'general',contextVersion:1,callId:randomUUID(),callGeneration:randomUUID(),turnId:randomUUID(),speaker:'owner',revision:1,text:'用一句话介绍自己。',closed:true,complete:true,producerReceipt:randomUUID(),id:randomUUID(),contentSha256:createHash('sha256').update('用一句话介绍自己。').digest('hex'),source:{kind:'sealed-audio-stt',providerId:'test-fixture',audioSha256:'a'.repeat(64),sealReceiptId:randomUUID(),sttReceiptId:randomUUID()}})
 hardware.remember(commit.id)
 await assert.rejects(f.controller.prompt(promptRequest(f.agent,commit.id,commit.text),new AbortController().signal),{code:'teloa/forbidden'})
 await admitDirectDeviceInput({voice,hardware},commit,()=>{},()=>f.controller.prompt(promptRequest(f.agent,commit.id,commit.text),new AbortController().signal))
 assert.equal(f.agent.inbox.nextTurn.length,1)
 assert.deepEqual(f.agent.inbox.nextTurn[0]!.content,[{type:'text',text:commit.text}])
 await assert.rejects(admitDirectDeviceInput({voice,hardware},commit,()=>{},()=>f.controller.prompt(promptRequest(f.agent,commit.id,commit.text),new AbortController().signal)),{code:'teloa/conflict'})
})
