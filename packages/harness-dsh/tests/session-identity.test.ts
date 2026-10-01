import test from 'node:test'
import assert from 'node:assert/strict'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

test('原生会话核验拒绝 subagent 身份，但允许带父会话的普通副本',async()=>{
  const module=await import('../src/index.ts') as unknown as Record<string,unknown>
  const inspect=module.inspectOrdinarySession as undefined|((reader:(sessionId:SessionId)=>Promise<{meta:{origin?:'subagent';parentSession?:SessionId}}>,sessionId:SessionId)=>Promise<void>)
  assert.equal(typeof inspect,'function')
  const sessionId=brandString<SessionId>('session-history')
  await assert.doesNotReject(inspect!(async()=>({meta:{parentSession:brandString<SessionId>('session-parent')}}),sessionId))
  await assert.rejects(inspect!(async()=>({meta:{origin:'subagent',parentSession:brandString<SessionId>('session-parent')}}),sessionId),{
    code:'teloa/session-not-adoptable',
  })
})
