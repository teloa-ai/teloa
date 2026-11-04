import test from 'node:test'
import assert from 'node:assert/strict'
import {createSessionContinuation} from '../src/client/session-continuation.ts'

const next=()=>new Promise<void>(resolve=>setImmediate(resolve))
function fixture(){
 const facts={identity:{},current:true,ready:true,running:false,pending:false,blocked:false},draft={text:'尚未提交的草稿',attachments:['draft-file']},prefix='a'.repeat(64),calls:string[]=[]
 let changed=()=>{},inspect=async()=>({sessionId:'original',available:true,prefixSha256:prefix}),resume=async(value:string)=>{calls.push(value)}
 const port=createSessionContinuation({sessionId:'original',facts:()=>facts,subscribe:listener=>{changed=listener;return()=>{changed=()=>{}}},inspect:()=>inspect(),resume:value=>resume(value)})
 return {facts,draft,prefix,calls,port,change:()=>changed(),setInspect(value:typeof inspect){inspect=value},setResume(value:typeof resume){resume=value}}
}
test('首次打开、历史变化和重连只查询状态，显式点击才沿固定前缀恢复并保留草稿',async()=>{
 const f=fixture(),off=f.port.subscribe(()=>{});await next()
 f.change();await next();f.facts.ready=false;f.change();await next();f.facts.ready=true;f.change();await next()
 assert.equal(f.port.getSnapshot().available,true);assert.deepEqual(f.calls,[])
 await f.port.continue()
 assert.deepEqual(f.calls,[f.prefix]);assert.deepEqual(f.draft,{text:'尚未提交的草稿',attachments:['draft-file']});off()
})
test('导航后的迟到状态不能把旧会话入口重新打开或执行',async()=>{
 const f=fixture();let deliver!:(value:{sessionId:string;available:boolean;prefixSha256:string})=>void
 f.setInspect(()=>new Promise(resolve=>{deliver=resolve}))
 const off=f.port.subscribe(()=>{});await next();f.facts.identity={};f.facts.current=false;f.change()
 deliver({sessionId:'original',available:true,prefixSha256:f.prefix});await next()
 assert.equal(f.port.getSnapshot().available,false);await assert.rejects(f.port.continue());assert.deepEqual(f.calls,[]);off()
})
test('重复点击不并发恢复；未知响应重试仍使用原前缀',async()=>{
 const f=fixture();let fail!:(error:Error)=>void
 f.setResume(value=>{f.calls.push(value);return new Promise((_resolve,reject)=>{fail=reject})})
 const off=f.port.subscribe(()=>{});await next()
 const first=f.port.continue();await assert.rejects(f.port.continue());assert.equal(f.calls.length,1)
 fail(Error('response lost'));await assert.rejects(first);await next()
 assert.equal(f.port.getSnapshot().error,true,'只读刷新保留未知响应与原恢复票据')
 f.setResume(async value=>{f.calls.push(value)})
 await f.port.continue();assert.deepEqual(f.calls,[f.prefix,f.prefix]);off()
})
