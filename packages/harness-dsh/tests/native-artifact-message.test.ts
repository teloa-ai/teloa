import test from 'node:test'
import assert from 'node:assert/strict'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {SessionSeq} from '@deepseek-ai/dsh-session'
import {createAssistantMessage} from '@deepseek-ai/dsh-llm'
import {savedArtifactMessage} from '@teloa/contract'
import {readNativeArtifactMessage,readNativePlainTextMessage} from '../src/native-artifact-message.ts'
test('捕获核对固定原消息，不能伪造正文、图片、来源或选取压缩副本',()=>{
 const event={type:'user/message',seq:0,time:0,surfaceOp:'append',data:{id:'m1',role:'user',source:{kind:'user'},content:[{type:'text',text:'原文'},{type:'image',attachment:{attachmentId:'sha256:abc',mediaType:'image/png',bytes:3,width:1,height:1}}]}} as unknown as SessionEvent
 const expected=savedArtifactMessage({sessionId:'s1',messageId:'m1',seq:0,role:'user',at:new Date(0).toISOString(),text:'原文',interrupted:false,omittedBlocks:0,images:[{blockIndex:1,attachment:{attachmentId:'sha256:abc',mediaType:'image/png',bytes:3,width:1,height:1}}]})
 assert.deepEqual(readNativeArtifactMessage('s1',[event],expected),expected)
 for(const input of [{...expected,text:'伪造'}, {...expected,sessionId:'s2'},{...expected,seq:1},{...expected,images:[]}])assert.throws(()=>readNativeArtifactMessage('s1',[event],input))
 assert.throws(()=>readNativeArtifactMessage('s1',[{...event,surfaceOp:'replace'} as unknown as SessionEvent],expected))
})

test('纯文本候选固定可见 append，拒绝非文本、被中断、继承或被替换消息',()=>{
 const message=createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'第一段'},{type:'text',text:'第二段'}]})
 const assistant:Extract<SessionEvent,{type:'assistant/message'}>={type:'assistant/message',seq:SessionSeq(2),time:2,surfaceOp:'append',data:{turn:1,step:1,message,stream:[]}}
 const session={id:'s1',inheritedEventCount:0,snapshotEvents:()=>[assistant],surface:{nodes:[2]}}
 const saved=readNativePlainTextMessage(session,{messageId:message.id,seq:2})
 assert.equal(saved.markdown,'第一段\n第二段');assert.match(saved.selectionHash,/^[a-f0-9]{64}$/)
 assert.deepEqual(readNativePlainTextMessage(session,{messageId:message.id,seq:2,selectionHash:saved.selectionHash}),saved)
 assert.throws(()=>readNativePlainTextMessage({...session,surface:{nodes:[]}},saved))
 assert.throws(()=>readNativePlainTextMessage({...session,inheritedEventCount:3},saved))
 assert.throws(()=>readNativePlainTextMessage({...session,snapshotEvents:()=>[{...assistant,data:{...assistant.data,interrupted:true}} as SessionEvent]},saved))
 assert.throws(()=>readNativePlainTextMessage({...session,snapshotEvents:()=>[{...assistant,data:{...assistant.data,message:{...assistant.data.message,content:[{type:'image',attachment:{}}]}}} as unknown as SessionEvent]},saved))
})
