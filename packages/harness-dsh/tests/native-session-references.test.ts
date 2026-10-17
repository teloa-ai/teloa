import test from 'node:test'
import assert from 'node:assert/strict'
import {existsSync} from 'node:fs'
import type {Context} from '@deepseek-ai/cordis'
import {SessionId,type SessionHeader} from '@deepseek-ai/dsh-session'
import {SessionReferenceResolver,parseSessionReferenceText} from '@deepseek-ai/dsh-session-reference'
import {nativeProviderFixture} from './fixtures/native-input-provider.ts'

const file=new URL('../src/native-session-references.ts',import.meta.url)
async function load(){assert.ok(existsSync(file),'原生引用目录没有按真实会话用途过滤');return import('../src/native-session-references.ts')}
const header=(id:string,extra:Partial<SessionHeader>={}):SessionHeader=>({id:SessionId(id),version:4,createdAt:100,isSeeded:false,...extra})
const binding=(sessionId:string,extra:Record<string,unknown>={})=>({ownerId:'owner',sessionId,requestedSessionId:sessionId,status:'ready' as const,title:'本人空白会话',...extra})
const ordinary='00000000-0000-4000-8000-000000000010',reserved='00000000-0000-4000-8000-000000000011'

test('真实原生菜单在限制之前过滤执行用途和子代理，保留 UUID 普通会话与规范引用',async t=>{
 const {installNativeSessionReferenceDirectory}=await load(),f=await nativeProviderFixture(t)
 const ids=['group-routing-00000000-0000-4000-8000-000000000001','task-run-00000000-0000-4000-8000-000000000002','child',reserved,'foreign','pending',ordinary,'human-json','other-workspace']
 const headers=ids.map(id=>header(id,id==='child'?{origin:'subagent',parentSession:f.agent.id}:id==='other-workspace'?{cwd:'/other'}:{}))
 const rows=[binding(reserved,{purpose:'task-run'}),binding('foreign',{ownerId:'someone-else'}),binding('pending',{status:'pending'}),binding(ordinary),binding('human-json',{title:'普通 JSON 资料讨论'})]
 const titles=new Map([['human-json','{"schema":"teloa.task-run-input/v2"}'],['other-workspace','跨目录会话']])
 let queryCalls=0,writes=0,reads=0
 Object.assign(f.ctx.sessionQuery,{listSessions:async()=>{queryCalls++;return headers.map(h=>({header:h,live:false}))},readSurface:async(id:string)=>{reads++;return {session:header(id),capturedThroughSeq:null,events:[{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'显式引用的原始子会话资料'}]}}]}}})
 f.ctx.provide('sessionProjectionCache',{cachedSnapshot:(h:SessionHeader)=>({values:{title:titles.get(h.id)}})} as never)
 await f.ctx.plugin(SessionReferenceResolver,{candidateLimit:2,maxReferenceBytes:2000})
 const resolver=f.ctx.sessionReferenceResolver,originalPrepare=Object.getOwnPropertyDescriptor(resolver,'prepare'),originalRemote=Object.getOwnPropertyDescriptor(resolver,'remoteExportCandidates')
 await installNativeSessionReferenceDirectory(f.ctx,{owner:'owner',bindings:async()=>rows as never,write:()=>{writes++}} as never)
 const chosen=await resolver.remoteExportCandidates(f.agent,'',new AbortController().signal)
 assert.deepEqual(chosen.map(row=>row.sessionId),[ordinary,'human-json']);assert.equal(chosen[0]!.label,'本人空白会话');assert.equal(chosen[1]!.label,titles.get('human-json'))
 assert.equal(parseSessionReferenceText(chosen[0]!.mention).references[0]!.sessionId,ordinary)
 assert.deepEqual((await resolver.remoteExportCandidates(f.agent,'本人空白',new AbortController().signal)).map(row=>row.sessionId),[ordinary])
 assert.deepEqual((await resolver.listCandidates(f.agent,'',undefined)).map(row=>row.sessionId),[ordinary,'human-json'])
 assert.deepEqual(Object.getOwnPropertyDescriptor(resolver,'prepare'),originalPrepare);assert.deepEqual(Object.getOwnPropertyDescriptor(resolver,'remoteExportCandidates'),originalRemote);assert.equal(writes,0);assert.equal(reads,0);assert.ok(queryCalls>0)
 const snapshot=await resolver.prepare(f.agent,[{type:'text',text:'明确补充资料'}],[{sessionId:SessionId('child'),label:'显式子会话'}])
 assert.equal(reads,1);assert.ok(snapshot.additionalContext?.content.some(row=>row.type==='text'&&row.text.includes('显式引用的原始子会话资料')),'候选隐藏不阻断原生显式引用或快照准备')
 await assert.rejects(resolver.listCandidates(f.agent,'',0),{code:'SESSION_REFERENCE_INVALID_REFERENCE'})
 assert.equal(Object.getOwnPropertyDescriptor(resolver,'listCandidates')?.value.name,'list')
})

test('只读用途失败或迟到取消不能发布候选；卸载只恢复自己安装的公开方法',async t=>{
 const {installNativeSessionReferenceDirectory}=await load(),f=await nativeProviderFixture(t)
 Object.assign(f.ctx.sessionQuery,{listSessions:async()=>[{header:header('ordinary'),live:false}]})
 await f.ctx.plugin(SessionReferenceResolver,{candidateLimit:1})
 let mode:'fail'|'wait'|'ready'='fail',release:()=>void=()=>{},entered:()=>void=()=>{}
 const resolver=f.ctx.sessionReferenceResolver,original=Object.getOwnPropertyDescriptor(resolver,'listCandidates')
 const fiber=await installNativeSessionReferenceDirectory(f.ctx,{owner:'owner',bindings:async()=>{if(mode==='fail')throw Error('会话用途读取失败');if(mode==='wait'){entered();await new Promise<void>(done=>{release=done})}return [binding('ordinary')] as never}})
 await assert.rejects(resolver.listCandidates(f.agent),/会话用途读取失败/)
 mode='wait';const controller=new AbortController(),ready=new Promise<void>(done=>{entered=done}),pending=resolver.listCandidates(f.agent,'',1,controller.signal),denied=assert.rejects(pending,{code:'SESSION_REFERENCE_CANCELLED'})
 await ready;controller.abort();release();await denied
 mode='ready';assert.equal((await resolver.listCandidates(f.agent)).length,1)
 mode='wait';const lateReady=new Promise<void>(done=>{entered=done}),late=resolver.listCandidates(f.agent,'',1),lateDenied=assert.rejects(late,{code:'teloa/dependency-unavailable'})
 await lateReady
 const cached=resolver.listCandidates
 await fiber.dispose();assert.deepEqual(Object.getOwnPropertyDescriptor(resolver,'listCandidates'),original);assert.equal((await resolver.listCandidates(f.agent))[0]!.label,'ordinary','卸载恢复原生发现且不引用已释放作用域')
 release();await lateDenied;await assert.rejects(cached.call(resolver,f.agent),{code:'teloa/dependency-unavailable'})
 const second=await installNativeSessionReferenceDirectory(f.ctx,{owner:'owner',bindings:async()=>[]})
 const later:SessionReferenceResolver['listCandidates']=async()=>[];resolver.listCandidates=later;await second.dispose();assert.equal(Object.getOwnPropertyDescriptor(resolver,'listCandidates')?.value,later)
})
