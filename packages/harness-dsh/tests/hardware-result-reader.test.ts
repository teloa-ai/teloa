import test from 'node:test'
import assert from 'node:assert/strict'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import {createUserMessage,createAssistantMessage} from '@deepseek-ai/dsh-llm'
import type {HardwareOperation} from '@teloa/contract'
import * as implementation from '../src/hardware-result-reader.ts'
const operation:HardwareOperation={id:'11111111-1111-4111-8111-111111111111',bindingId:'22222222-2222-4222-8222-222222222222',grantVersion:1,nativeRequestId:'33333333-3333-4333-8333-333333333333',text:'整理测试任务',textDigest:'not-used-by-reader',state:'accepted',createdAt:'2026-10-16T00:00:00.000Z',expiresAt:'2026-10-16T00:05:00.000Z',resultRef:null}
test('正式交办仍在运行时不把主聊的已交办回复当成果，原审批及真正结果分别返回',()=>{
 assert.equal(typeof implementation.hardwareWorkReceipt,'function')
 const base={operationId:'original',state:'completed' as const,speakableText:'已交办',resultRef:null}
 const status={requestId:'formal',sessionId:'assistant',kind:'task' as const,title:'测试成果',scope:'general',observedAt:'2026-10-16T00:00:00Z',stoppedAt:null,counts:{received:0,waiting:1,unavailable:0,failed:0,stopped:0},members:[{roleId:null,name:'小松鼠',scope:'general',status:'waiting' as const}]}
 assert.equal(implementation.hardwareWorkReceipt(base,[status],false).state,'pending')
 assert.equal(implementation.hardwareWorkReceipt(base,[status],true).state,'needs_approval')
 const done={...status,members:[{...status.members[0]!,status:'received' as const,result:'实际完成的清单。'}]}
 assert.equal(implementation.hardwareWorkReceipt(base,[done],false).speakableText,'小松鼠：实际完成的清单。')
})
test('只读同一原请求 completed 的最终文本，不取最新消息或混入其他输入',()=>{
 assert.equal(typeof implementation.readHardwareResult,'function')
 const session=Session.create(SessionId('hardware-original'))
 const snapshot=()=>({ownerId:'test',sessionId:String(session.id),inheritedEventCount:0,events:session.snapshotEvents()})
 session.append('turn/start',{turn:0})
 session.append('user/message',createUserMessage({source:{kind:'user',rpcId:operation.nativeRequestId},content:[{type:'text',text:operation.text}]}),{surfaceOp:'append'})
 session.append('assistant/message',{turn:0,step:0,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'已整理测试记录。'}]}),stream:[]},{surfaceOp:'append'})
 assert.equal(implementation.readHardwareResult(operation,snapshot()).state,'pending')
 session.append('turn/end',{turn:0,reason:{kind:'completed'}})
 const result=implementation.readHardwareResult(operation,snapshot())
 assert.equal(result.state,'completed');assert.equal(result.speakableText,'已整理测试记录。')
 session.append('turn/start',{turn:1})
 session.append('user/message',createUserMessage({source:{kind:'user',rpcId:'unrelated'},content:[{type:'text',text:'其他工作'}]}),{surfaceOp:'append'})
 session.append('assistant/message',{turn:1,step:0,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'这不是硬件的结果。'}]}),stream:[]},{surfaceOp:'append'})
 session.append('turn/end',{turn:1,reason:{kind:'completed'}})
 assert.equal(implementation.readHardwareResult(operation,snapshot()).speakableText,'已整理测试记录。')
})
