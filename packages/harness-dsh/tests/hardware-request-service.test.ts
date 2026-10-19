import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Session,SessionId} from '@deepseek-ai/dsh-session'
import {createUserMessage,createAssistantMessage} from '@deepseek-ai/dsh-llm'
import {createHardwareStore,initializeHardwareDevices} from '@teloa/backend'
import {WorkError,type HardwareOperation} from '@teloa/contract'
import {readHardwareResult} from '../src/hardware-result-reader.ts'
import * as implementation from '../src/hardware-request-service.ts'
let pool:Parameters<typeof initializeHardwareDevices>[0],container:StartedPostgreSqlContainer
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeHardwareDevices(pool)},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(){
 assert.equal(typeof implementation.createHardwareRequestService,'function')
 const ownerId='hardware-service:'+randomUUID(),installationId=randomUUID(),store=createHardwareStore(pool,{ownerId,installationId}),session=Session.create(SessionId('hardware-'+randomUUID()))
 const binding=await store.bind({assistantSessionId:String(session.id),contextVersion:1})
 let nativeCalls=0,unreadable=false,lost=false,finishImmediately=true,revoked=false
 const end=()=>{session.append('assistant/message',{turn:0,step:0,message:createAssistantMessage({source:{provider:'isolated',model:'script'},content:[{type:'text',text:'已整理成测试清单。'}]}),stream:[]},{surfaceOp:'append'});session.append('turn/end',{turn:0,reason:{kind:'completed'}})}
 const ports={store,bindingId:binding.id,workSignal:new AbortController().signal,waitMs:20,authorize:async()=>{const latest=await store.readBinding(binding.id);return {binding:latest,assertCurrent(){if(revoked||latest.status!=='active')throw new WorkError('teloa/forbidden','已撤销')}}},dispatch:async(op:HardwareOperation)=>{
  nativeCalls++;session.append('turn/start',{turn:0});session.append('user/message',createUserMessage({source:{kind:'user',rpcId:op.nativeRequestId},content:[{type:'text',text:op.text}]}),{surfaceOp:'append'})
  if(finishImmediately)end()
  if(lost)throw Error('lost receipt')
 },read:async(op:HardwareOperation)=>{if(unreadable)throw Error('temporarily unreadable');return readHardwareResult(op,{ownerId,sessionId:String(session.id),inheritedEventCount:0,events:session.snapshotEvents()})}}
 return {store,binding,ports,end,make:()=>implementation.createHardwareRequestService(ports),get nativeCalls(){return nativeCalls},lose(){lost=true;unreadable=true},recover(){unreadable=false},long(){finishImmediately=false},revoke(){revoked=true}}
}
test('真实持久操作并发 submit 只产生一条原 Session 输入，重启实例仍查询原结果',async()=>{
 const f=await fixture()
 let reads=0,release!:()=>void
 const ready=new Promise<void>(resolve=>{release=resolve})
 f.ports.store={...f.store,get:async(bindingId:string,id?:string)=>{const value=await f.store.get(bindingId,id);reads++;if(reads===2)release();if(reads<=2)await ready;return value}}
 const requests=f.make(),prepared=await requests.prepare('整理测试任务。')
 const results=await Promise.all([requests.submit(prepared.operationId),requests.submit(prepared.operationId)])
 assert.ok(results.every(x=>x.state==='completed'))
 assert.equal(f.nativeCalls,1)
 assert.equal((await f.make().submit(prepared.operationId)).speakableText,'已整理成测试清单。')
 assert.equal(f.nativeCalls,1)
})
test('受理回执丢失只读恢复；状态未知不补发，也不换请求编号',async()=>{
 const f=await fixture(),requests=f.make(),prepared=await requests.prepare('整理回执测试。');f.lose()
 assert.equal((await requests.submit(prepared.operationId)).state,'unknown')
 assert.equal(f.nativeCalls,1)
 f.recover()
 assert.equal((await f.make().submit(prepared.operationId)).state,'completed')
 assert.equal(f.nativeCalls,1)
})
test('有界等待后长任务仍在原 Session，查询读到最终结果；撤销后拒绝输出',async()=>{
 const f=await fixture(),requests=f.make();f.long()
 const prepared=await requests.prepare('长任务测试。')
 assert.equal((await requests.submit(prepared.operationId)).state,'pending')
 f.end()
 assert.equal((await requests.result()).state,'completed')
 f.revoke()
 await assert.rejects(requests.result(prepared.operationId),{code:'teloa/forbidden'})
 assert.equal(f.nativeCalls,1)
})

test('原生入队回执早于 Session 可见时仍等待原结果，不提前返回未知或重派',async()=>{
 const f=await fixture(),dispatch=f.ports.dispatch,read=f.ports.read
 let operation:HardwareOperation|undefined,reads=0
 f.ports.waitMs=1000
 f.ports.dispatch=async op=>{operation=op}
 f.ports.read=async op=>{
  const receipt=await read(op)
  if(++reads===2){
   // 派发已返回，原 Session 的投影在当前观察之后才可见。
   while((await f.store.get(f.binding.id,op.id))?.state!=='unknown')await new Promise<void>(resolve=>setImmediate(resolve))
   await new Promise<void>(resolve=>setImmediate(resolve))
   setImmediate(()=>{void dispatch(operation!)})
  }
  return receipt
 }
 const requests=f.make(),prepared=await requests.prepare('延迟可见测试。')
 assert.equal((await requests.submit(prepared.operationId)).state,'completed')
 assert.equal(f.nativeCalls,1)
})
