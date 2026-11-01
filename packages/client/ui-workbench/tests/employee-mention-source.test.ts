import test from 'node:test'
import assert from 'node:assert/strict'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {SessionId} from '@deepseek-ai/dsh-session'
import {employeeMentionSource,prepareEmployeeMentionInput} from '../src/client/employee-mention-source.ts'
import {encodeEmployeeMention} from '@teloa/contract'
const roleId='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
test('官方picker选择仅插入opaque引用；fresh codec验证失败不降级为名字，原引用/版本未改',async()=>{
 let stale=false,verifications=0
 const source=employeeMentionSource({locale:()=> 'zh-CN',candidates:async()=>[{roleId,roleVersion:1,name:'研判员',state:'active',scopeTitle:'安全'}],verify:async(sessionId,ref)=>{verifications++;assert.equal(sessionId,'parent');assert.equal(ref.roleVersion,1);if(stale)throw Error('version changed')}})
 const session={sessionId:brandString<SessionId>('parent')},signal=new AbortController().signal,rows=await source.candidates(session,{query:'研判',signal,position:'inline',drilled:false})
 const pick=source.onPick({candidate:rows[0]!,session,position:'inline',via:'enter',action:'pick',span:{start:0,end:3,draftRev:1}})
 assert.ok(pick&&typeof pick==='object'&&'insert'in pick);assert.deepEqual(Object.keys(pick),['insert']);assert.equal(verifications,0)
 const raw=pick.insert.ref,expected=encodeEmployeeMention({roleId,roleVersion:1});assert.equal(source.codec!.clipboardText!(raw),expected)
 assert.equal(await source.codec!.serialize(raw,signal),expected);stale=true;await assert.rejects(()=>source.codec!.serialize(raw,signal));assert.equal(pick.insert.ref,raw)
 const abort=new AbortController();abort.abort();await assert.rejects(()=>source.codec!.serialize(raw,abort.signal))
 assert.deepEqual(await source.candidates(session,{query:'',signal,position:'inline',drilled:true}),[])
})
test('原生submit preparation覆盖多员工和粘贴；多选不调用验证、不发出消息',async()=>{
 let calls=0;const ports={verify:async()=>{calls++}},signal=new AbortController().signal,a=encodeEmployeeMention({roleId,roleVersion:1}),b=encodeEmployeeMention({roleId:other,roleVersion:1})
 await assert.rejects(()=>prepareEmployeeMentionInput('parent',a+' '+b,ports,signal));assert.equal(calls,0)
 assert.deepEqual(await prepareEmployeeMentionInput('parent',a+' 你好',ports,signal),{roleId,roleVersion:1});assert.equal(calls,1)
 await assert.rejects(()=>prepareEmployeeMentionInput('parent','[teloa-employee:broken]',ports,signal));assert.equal(calls,1)
})
