import test from 'node:test'
import assert from 'node:assert/strict'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {createMethodReuseMessageReader} from '../src/method-reuse-native-source.ts'

const rpcId='20000000-0000-4000-8000-000000000001'
function fixture(){
 const session=Session.create(SessionId('method-source-native'))
 const event=session.append('user/message',createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:'请将这份成果保存为方法。'}]}),{surfaceOp:'append'})
 const input={sessionId:session.id,messageId:event.data.id,messageSeq:event.seq,requestId:rpcId}
 return {session,input}
}
test('方法认可只从固定的本人原生消息读取，不接受客户端正文或另一条rpc身份',async()=>{
 const {session,input}=fixture()
 const read=createMethodReuseMessageReader('owner',{conversation:async id=>({ownerId:'owner',sessionId:id,status:'ready'}),session:async()=>session})
 const value=await read('owner',input)
 assert.equal(value.text,'请将这份成果保存为方法。');assert.equal(value.source.rpcId,rpcId)
 await assert.rejects(read('foreign',input),{code:'teloa/forbidden'})
 await assert.rejects(read('owner',{...input,requestId:'30000000-0000-4000-8000-000000000001'}),{code:'teloa/forbidden'})
})
test('已替换的原消息和受管任务会话不能冒充普通本人认可',async()=>{
 const {session,input}=fixture()
 const read=createMethodReuseMessageReader('owner',{conversation:async id=>({ownerId:'owner',sessionId:id,status:'ready'}),session:async()=>session})
 session.append('user/message',createUserMessage({source:{kind:'user',rpcId},content:[{type:'text',text:'不要保存。'}]}),{surfaceOp:{op:'replace',startSeq:input.messageSeq,endSeq:input.messageSeq},sourceEventSeqs:[input.messageSeq]} as never)
 await assert.rejects(read('owner',input),{code:'teloa/source-unavailable'})
 const task=createMethodReuseMessageReader('owner',{conversation:async id=>({ownerId:'owner',sessionId:id,status:'ready',purpose:'task-run'}),session:async()=>session})
 await assert.rejects(task('owner',input),{code:'teloa/forbidden'})
})
