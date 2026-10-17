import test from 'node:test'
import assert from 'node:assert/strict'
import type {ISessions} from '@deepseek-ai/dsh-api-session-controller/client'
import {readNativeSessionForOpening} from '../src/client/native-session-opening.ts'

test('已有工作会话按原身份打开，不调用只复用空白会话的 create',async()=>{
 let created=0,refreshed=0
 const sessions={refresh:async()=>{refreshed++},list:{getSnapshot:()=>({byId:{original:{sessionId:'original'}}})},binding:()=>undefined,subagentAddress:()=>undefined,create:async()=>{created++;return 'another'}} as unknown as ISessions
 assert.equal(await readNativeSessionForOpening(sessions,'original'),'original')
 assert.equal(created,0);assert.equal(refreshed,1)
 await assert.rejects(readNativeSessionForOpening(sessions,'missing'),/目录/)
})

test('已有子会话仍不能从普通工作入口打开',async()=>{
 const sessions={refresh:async()=>{},list:{getSnapshot:()=>({byId:{child:{sessionId:'child',subagent:{parentSessionId:'parent',mode:'continuable'}}}})},binding:()=>undefined,subagentAddress:()=>({parentSessionId:'parent',childSessionId:'child',mode:'continuable'})} as unknown as ISessions
 await assert.rejects(readNativeSessionForOpening(sessions,'child'),/目录/)
})
