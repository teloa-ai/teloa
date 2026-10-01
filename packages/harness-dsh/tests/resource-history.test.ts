import { SessionSeq } from '@deepseek-ai/dsh-session'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { resourceHistoryPage } from '../src/resource-history.ts'

const id='11111111-1111-4111-a111-111111111111',version='a'.repeat(64)
function example(){
  const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:`请核对 [[teloa-resource:${id}@1]]`}]})
  const payload={schema:'teloa.resource-context/v1',snapshot:{ownerId:'owner',sessionId:'session',messageId:message.id,scopeIds:['general'],references:[{id,version:1}]},contents:[{id,version:1,title:'当时的资料名称',scopeIds:['general'],sourceId:'workbench',sourceVersion:version,text:'不应返回的正文'}]}
  const context=()=>createUserMessage({source:{kind:'plugin:teloa.resources'},content:[{type:'text',text:'资料说明\n'+JSON.stringify(payload)}]})
  const events:SessionEvent[]=[{type:'turn/start',seq:SessionSeq(1),time:1000,data:{turn:1}},{type:'user/message',surfaceOp:'append',seq:SessionSeq(2),time:1001,data:message},{type:'user/message',surfaceOp:'append',seq:SessionSeq(3),time:1002,data:context()}]
  return {message,payload,context,events}
}
test('历史引用读取同消息冻结元数据，不返回正文或按当前目录替换标题',()=>{
  const {events}=example(),before=JSON.stringify(events)
  const page=resourceHistoryPage('owner','session',events)
  assert.equal(page.items[0]?.references[0]?.metadata?.title,'当时的资料名称')
  assert.equal(page.items[0]?.references[0]?.metadata?.sourceVersion,version)
  assert.equal(page.items[0]?.turn,1)
  assert.equal(JSON.stringify(page).includes('不应返回的正文'),false)
  assert.equal(JSON.stringify(events),before)
})
test('伪装正文、跨会话或错版本上下文不能授予历史资料名称',()=>{
  for(const mismatch of ['session','owner','version','source'] as const){
    const f=example()
    if(mismatch==='session')f.payload.snapshot.sessionId='other'
    if(mismatch==='owner')f.payload.snapshot.ownerId='other'
    if(mismatch==='version')f.payload.contents[0]!.version=2
    const context=mismatch==='source'?createUserMessage({source:{kind:'user'},content:f.context().content}):f.context()
    f.events[2]={type:'user/message',surfaceOp:'append',seq:SessionSeq(3),time:1002,data:context}
    const page=resourceHistoryPage('owner','session',f.events)
    assert.equal(page.items[0]?.references[0]?.metadata,undefined,mismatch)
  }
})
test('分页不重不漏，fork 继承历史排除，损坏引用显式可见',()=>{
  const f=example(),events:SessionEvent[]=[]
  for(let i=0;i<12;i++)events.push({type:'user/message',surfaceOp:'append',seq:SessionSeq(i),time:1000+i,data:createUserMessage({source:{kind:'user'},content:f.message.content})})
  events.push({type:'user/message',surfaceOp:'append',seq:SessionSeq(12),time:1012,data:createUserMessage({source:{kind:'user'},content:[{type:'text',text:'[[teloa-resource:broken]]'}]})})
  const first=resourceHistoryPage('owner','session',events),second=resourceHistoryPage('owner','session',events,first.nextBeforeSeq!)
  assert.deepEqual([...first.items,...second.items].map(item=>item.seq),[12,11,10,9,8,7,6,5,4,3,2,1,0])
  assert.match(first.items[0]!.issue!,/损坏/)
  assert.deepEqual(resourceHistoryPage('owner','child',events,undefined,events.length).items,[])
})
