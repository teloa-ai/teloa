import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createVoiceContextAuthority} from '../src/voice-call-context.ts'

const input={requestId:'11111111-1111-4111-8111-111111111111',roleId:'22222222-2222-4222-8222-222222222222',expectedRoleVersion:1,sessionId:'current-session'}
function setup(){
 let binding:{session:object;fingerprint:string}|null={session:{},fingerprint:'original'},epoch=0
 const listeners=new Set<()=>void>()
 const authority=createVoiceContextAuthority({owner:'owner',readNativeBinding:()=>binding,roleEpoch:()=>epoch,subscribeRole:(_role,notify)=>{listeners.add(notify);return()=>{listeners.delete(notify)}}})
 return {authority,listeners,changeBinding:(value:typeof binding)=>{binding=value},changeRole:()=>{epoch++;for(const notify of listeners)notify()}}
}
test('真实会话替换与角色撤权封住旧媒体，解除订阅不改业务信号',()=>{
 const fixture=setup(),lease=fixture.authority.capture(input),work=new AbortController()
 lease.assertCurrent();fixture.changeRole()
 assert.equal(lease.signal.aborted,true);assert.throws(lease.assertCurrent)
 assert.equal(work.signal.aborted,false);lease.release();lease.release();assert.equal(fixture.listeners.size,0)
 const fresh=fixture.authority.capture(input)
 fixture.changeBinding({session:{},fingerprint:'original'});assert.throws(fresh.assertCurrent);fresh.release()
})
test('只撤当前关联，宿主退出关闭所有旧媒体且不能再捕获',()=>{
 const fixture=setup(),lease=fixture.authority.capture(input)
 fixture.authority.invalidateSession('another-session');assert.equal(lease.signal.aborted,false)
 fixture.authority.invalidateSession(input.sessionId);assert.equal(lease.signal.aborted,true)
 lease.release();const next=fixture.authority.capture(input)
 fixture.authority.dispose();assert.equal(next.signal.aborted,true);assert.throws(next.assertCurrent)
 assert.throws(()=>fixture.authority.capture(input));next.release()
})
test('助手租约不读取虚构role epoch，原上下文失效只关闭媒体世代',()=>{
 const fixture=setup(),assistant={requestId:input.requestId,sessionId:input.sessionId,target:'assistant' as const,expectedContextVersion:3}
 const lease=fixture.authority.capture(assistant)
 assert.equal(fixture.listeners.size,0);fixture.changeRole();lease.assertCurrent()
 fixture.authority.invalidateSession(input.sessionId);assert.equal(lease.signal.aborted,true);assert.throws(lease.assertCurrent)
 lease.release();const next=fixture.authority.capture(assistant);next.assertCurrent();next.release()
})
