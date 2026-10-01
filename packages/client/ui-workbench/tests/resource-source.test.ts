import test from 'node:test'
import assert from 'node:assert/strict'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { resourceSource } from '../src/client/resource-source.ts'
const resource={id:'3c68e13d-95e8-4a85-9002-3edb5c111f55',ownerId:'owner',title:'设计依据',sourceId:'source',sourceVersion:'a'.repeat(64),scopeIds:['general'],version:1,status:'active' as const,createdAt:'2026-09-10T00:00:00Z',updatedAt:'2026-09-10T00:00:00Z'}
test('原生引用节点保留选择时的版本，后续目录更新和另一会话不会改写序列化结果',async()=>{
  let version=1
  const source=resourceSource({candidates:async()=>[{...resource,version}]})
  const session={sessionId:brandString<SessionId>('session-A')},signal=new AbortController().signal
  const candidates=await source.candidates(session,{query:'设计',position:'inline',drilled:false,signal})
  const pick=source.onPick({candidate:candidates[0]!,session,position:'inline',via:'menu',action:'pick',span:{start:0,end:3,draftRev:1}})
  assert.ok(pick&&typeof pick==='object'&&'insert' in pick)
  version=2
  const newer=await source.candidates({sessionId:brandString<SessionId>('session-B')},{query:'设计',position:'inline',drilled:false,signal})
  assert.match(newer[0]!.value!,/@2\]\]$/)
  assert.equal(await source.codec!.serialize(pick.insert.ref,signal),'[[teloa-resource:'+resource.id+'@1]]')
  assert.equal(pick.insert.label,'设计依据')
  assert.deepEqual(await source.candidates(session,{query:'',position:'inline',quoted:true,drilled:true,signal}),[])
})
