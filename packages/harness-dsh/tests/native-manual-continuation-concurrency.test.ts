import test from 'node:test'
import assert from 'node:assert/strict'
import type {Context} from '@deepseek-ai/cordis'
import type {NativeSessionContinuationJournal} from '@teloa/backend'
import type {TeloaNativeInput} from '../src/native-input-provider.ts'
import {createNativeSessionManualContinuation} from '../src/native-session-manual-continuation.ts'

test('服务端只合并同会话同前缀的恢复请求，不把不同日志位置并到正在处理的票据',async()=>{
 let release!:(value:null)=>void,reads=0,authorizations=0
 const wait=new Promise<null>(resolve=>{release=resolve}),journal={forPrefix:async()=>{reads++;return wait},latest:async()=>null} as unknown as NativeSessionContinuationJournal
 const port=createNativeSessionManualContinuation({} as Context,{owner:'owner',journal,nativeInput:{} as TeloaNativeInput['input'],generation:()=>1,assertCurrent(){},snapshot:async()=>{throw Error('没有候选时不能打开writer')},inbox:()=>undefined,binding:async()=>{throw Error('没有候选时不能读取归属')},authorize:async()=>{authorizations++;throw Error('没有候选时不能授予恢复许可')}})
 const first=port.resume('original','a'.repeat(64),new AbortController().signal)
 await assert.rejects(port.resume('original','b'.repeat(64),new AbortController().signal),{code:'teloa/conflict'})
 release(null);await assert.rejects(first,{code:'teloa/conflict'})
 assert.equal(reads,1);assert.equal(authorizations,0)
 port.close()
})
