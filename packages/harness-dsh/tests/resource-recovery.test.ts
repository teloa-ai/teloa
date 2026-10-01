import './fixtures/message-source.ts'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { recoveryPage } from '../src/resource-recovery.ts'

test('恢复只取本轮实际认领而未接受的用户内容，不取取消、已接受或插件消息',()=>{
  const ordinary=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'普通请求'}]})
  const failed=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'按资料继续'},{type:'image',attachment:{attachmentId:brandString<Branded<'AttachmentId'>>('test-image'),mediaType:'image/png',bytes:68,width:1,height:1}}]})
  const canceled=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'已取消'}]})
  const context=createUserMessage({source:{kind:'teloa-test-context'},content:[{type:'text',text:'不能恢复到用户输入'}]})
  const log:SessionEvent[]=[]
  const add=<K extends SessionEvent['type']>(type:K,data:Extract<SessionEvent,{type:K}>['data'])=>log.push({type,seq:SessionSeq(log.length),time:1000+log.length,data} as SessionEvent)
  add('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[ordinary,failed,canceled]})
  add('turn/start',{turn:1})
  add('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]})
  add('user/message',ordinary)
  add('agent/inbox/spliced',{target:'next-step',start:0,inserted:[context]})
  add('agent/inbox/spliced',{target:'next-step',start:0,removedCount:1,inserted:[]})
  add('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[]})
  add('agent/inbox/spliced',{target:'next-turn',start:0,removedCount:1,inserted:[],outcome:'canceled'})
  add('turn/end',{turn:1,reason:{kind:'error',error:{code:'teloa/resources/resource-withdrawn',message:'资料已撤回'}}})
  const page=recoveryPage('session-a',log)
  assert.equal(page.sessionId,'session-a')
  assert.equal(page.failures.length,1)
  assert.deepEqual(page.failures[0]!.messages,[{id:failed.id,text:'按资料继续',otherContentCount:1}])
  assert.equal(page.failures[0]!.code,'teloa/resources/resource-withdrawn')
})

test('普通模型错误不伪装成资料失败；按结束 seq 分页不重复不漏项',()=>{
  const log:SessionEvent[]=[]
  for(let turn=1;turn<=13;turn++){
    const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请求 '+turn}]})
    log.push({type:'agent/inbox/spliced',seq:SessionSeq(log.length),time:1000,data:{target:'next-turn',start:0,inserted:[message]}})
    log.push({type:'turn/start',seq:SessionSeq(log.length),time:1000,data:{turn}})
    log.push({type:'agent/inbox/spliced',seq:SessionSeq(log.length),time:1000,data:{target:'next-turn',start:0,removedCount:1,inserted:[]}})
    log.push({type:'turn/end',seq:SessionSeq(log.length),time:1000,data:{turn,reason:{kind:'error',error:{code:turn===13?'SERVER':'teloa/resources/invalid-reference',message:'失败'}}}})
  }
  const first=recoveryPage('session-a',log),second=recoveryPage('session-a',log,first.nextBeforeSeq!)
  assert.equal(first.failures.length,10);assert.equal(second.failures.length,2)
  assert.deepEqual([...first.failures,...second.failures].map(item=>item.turn),[12,11,10,9,8,7,6,5,4,3,2,1])
  assert.equal(second.nextBeforeSeq,null)
  assert.deepEqual(recoveryPage('forked',log,undefined,log.length).failures,[],'fork 复制的父会话历史不能自动成为子会话恢复请求')
})
