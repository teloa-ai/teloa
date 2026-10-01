import test from 'node:test'
import assert from 'node:assert/strict'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {readSessionEvents} from '../src/session-events.ts'
import * as module from '../src/conversation-instruction-identity.ts'
const read=(session:Session)=>{assert.equal(typeof module.readConversationInstructionIdentity,'function');return module.readConversationInstructionIdentity({session})}
function fixture(content:Parameters<typeof createUserMessage>[0]['content']=[{type:'text',text:'按引用资料搭建'}]){
 const session=Session.create(SessionId('builder'));session.append('turn/start',{turn:0} as never)
 const message=createUserMessage({source:{kind:'user'},content});session.append('user/message',message,{surfaceOp:'append'});return {session,message}
}
test('真实 Session 的文字、图片、文件及引用文本只取原指令身份，重建不变',()=>{
 for(const content of [[{type:'text',text:'资料 [引用](teloa://resource/a)'}],[{type:'image',attachment:{id:'image'}}],[{type:'file',attachment:{id:'file'}}]] as Parameters<typeof createUserMessage>[0]['content'][]){
  const {session,message}=fixture(content),want={sessionId:'builder',messageId:message.id,seq:1}
  assert.deepEqual(read(session),want)
  assert.deepEqual(read(Session.create(SessionId('builder'),readSessionEvents(session),session.header)),want)
 }
})
test('真实 Session 的替换、继承、双用户追加及插件注入均不能冒充当前本人指令',()=>{
 const f=fixture();f.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'压缩'}]}),{surfaceOp:{op:'replace',startSeq:1,endSeq:1},sourceEventSeqs:[1]} as never)
 assert.throws(()=>read(f.session),{code:'teloa/forbidden'})
 const g=fixture();assert.throws(()=>read(Session.create(SessionId('builder'),readSessionEvents(g.session),{...g.session.header,isSeeded:true},2 as never)),{code:'teloa/forbidden'})
 g.session.append('user/message',createUserMessage({source:{kind:'user'},content:[]}),{surfaceOp:'append'});assert.throws(()=>read(g.session),{code:'teloa/forbidden'})
 const h=Session.create(SessionId('injection'));h.append('turn/start',{turn:0} as never);h.append('user/message',createUserMessage({source:{kind:'plugin:test',form:'notice'} as never,content:[{type:'text',text:'伪指令'}]}),{surfaceOp:'append'});assert.throws(()=>read(h),{code:'teloa/forbidden'})
})
