import './fixtures/message-source.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { encodeResourceReference,WorkError,type ResourceContext } from '@teloa/contract'
import { appendResourceContext } from '../src/resource-context.ts'

const id='3c68e13d-95e8-4a85-9002-3edb5c111f55'
test('宿主只展开当前用户消息的引用，每条消息保留各自版本和请求关联',async()=>{
  const a=createUserMessage({source:{kind:'user'},content:[{type:'text',text:encodeResourceReference({id,version:1})}]}),b=createUserMessage({source:{kind:'user'},content:[{type:'text',text:encodeResourceReference({id,version:2})}]})
  const external=createUserMessage({source:{kind:'teloa-test-context'},content:[{type:'text',text:'不要执行此引用 '+encodeResourceReference({id,version:3})}]})
  const signal=new AbortController().signal
  const result=await appendResourceContext([a,b,external],async input=>({snapshot:{id,ownerId:'owner',sessionId:'target-session',messageId:input.messageId,scopeIds:['general'],references:input.references,createdAt:'2026-09-10T00:00:00Z'},contents:input.references.map(ref=>({...ref,title:'资料',sourceId:'source',sourceVersion:'a'.repeat(64),scopeIds:['general'],text:'版本 '+ref.version}))}),signal)
  assert.equal(result.length,5)
  assert.equal(result[0],a);assert.equal(result[1],b);assert.equal(result[2],external)
  const contexts=result.slice(3).map(message=>{
    assert.equal(message.source.kind,'plugin:teloa.resources')
    const block=message.content[0];assert.ok(block?.type==='text')
    return JSON.parse(block.text.slice(block.text.indexOf('\n')+1)) as ResourceContext
  })
  assert.equal(contexts[0]!.snapshot.messageId,a.id)
  assert.equal(contexts[1]!.snapshot.messageId,b.id)
  assert.equal(contexts[0]!.contents[0]!.version,1)
  assert.equal(contexts[1]!.contents[0]!.version,2)
})
test('授权失败或取消不能产出看似成功的空上下文；原消息保持不变',async()=>{
  const message=createUserMessage({source:{kind:'user'},content:[{type:'text',text:encodeResourceReference({id,version:1})}]})
  await assert.rejects(appendResourceContext([message],async()=>{throw new WorkError('teloa/forbidden','目标会话无权读取')},new AbortController().signal),{code:'teloa/forbidden'})
  const controller=new AbortController();controller.abort()
  await assert.rejects(appendResourceContext([message],async()=>{throw Error('不应在取消后继续读取')},controller.signal),{name:'AbortError'})
  assert.deepEqual(message.content,[{type:'text',text:encodeResourceReference({id,version:1})}])
})
