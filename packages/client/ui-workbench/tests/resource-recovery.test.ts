import test from 'node:test'
import assert from 'node:assert/strict'
import { restoreRecoveredText } from '../src/client/resource-recovery.ts'
import { createResourceApi } from '../src/client/resource-api.ts'

test('恢复只写原会话输入，不发送；现有文字、附件、忙状态都不能被覆盖',()=>{
  const writes:string[]=[],actions={setDraft:(text:string)=>writes.push(text)}
  const request={id:'message-a',text:'待修正的原请求',otherContentCount:1}
  const empty={draft:'',attachmentIds:[],phase:'plain' as const}
  assert.match(restoreRecoveredText(request,empty,false,actions),/1/)
  assert.deepEqual(writes,['待修正的原请求'])
  for(const input of [{...empty,draft:'已有草稿'},{...empty,attachmentIds:['existing-attachment']},{...empty,phase:'submitting' as const}])assert.throws(()=>restoreRecoveredText(request,input,false,actions),/草稿|忙/)
  assert.throws(()=>restoreRecoveredText(request,empty,true,actions),/忙/)
  assert.equal(writes.length,1)
})
test('恢复接口拒绝另一会话的响应、损坏消息和非法分页',async()=>{
  const page={sessionId:'session-a',failures:[{endSeq:12,turn:1,at:'2026-09-10T00:00:00Z',code:'teloa/resources/invalid-reference',reason:'引用错误',messages:[{id:'message-a',text:'原请求',otherContentCount:0}]}],nextBeforeSeq:null}
  const valid=createResourceApi(async()=>page)
  assert.deepEqual(await valid.recovery('session-a',undefined,new AbortController().signal),page)
  const wrong=createResourceApi(async()=>({...page,sessionId:'session-b'}))
  await assert.rejects(wrong.recovery('session-a',undefined,new AbortController().signal),/格式|会话/)
  const malformed=createResourceApi(async()=>({...page,failures:[{...page.failures[0],messages:[{id:'message-a',text:1,otherContentCount:0}]}]}))
  await assert.rejects(malformed.recovery('session-a',undefined,new AbortController().signal),/格式/)
  const badCursor=createResourceApi(async()=>({...page,nextBeforeSeq:13}))
  await assert.rejects(badCursor.recovery('session-a',undefined,new AbortController().signal),/格式/)
})
