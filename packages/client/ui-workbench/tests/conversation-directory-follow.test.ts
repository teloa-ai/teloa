import test from 'node:test'
import assert from 'node:assert/strict'
import type {Conversation} from '@teloa/contract'
import {BindingClient,type WorkPort} from '../src/client/binding-client.ts'
import {followConversationDirectory} from '../src/client/conversation-directory-follow.ts'

const turn=()=>new Promise(resolve=>setImmediate(resolve))
function source<T>(initial:T){let value=initial;const listeners=new Set<()=>void>();return {getSnapshot:()=>value,subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener)}},set(next:T){value=next;for(const listener of listeners)listener()},listeners}}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}
const row=(id:string):Conversation=>({id:'conversation-'+id,sessionId:id,requestedSessionId:id,ownerId:'local:teloa-owner',title:id,scopeIds:['general'],version:1,status:'ready',createdAt:'2026-10-06T10:00:00Z'})
function fixture(){
 const state=source<'connected'|'disconnected'|'connecting'>('connected'),generation=source<{id:number}|undefined>({id:1}),watches:Array<{revision:number|undefined;signal:AbortSignal;result:ReturnType<typeof deferred<unknown>>}>=[]
 let rows=[row('local')],reads=0
 const port:WorkPort={list:async()=>{reads++;return rows},read:async id=>row(id),ensure:async id=>row(id),isNativeChild:()=>false,catalog:async()=>{throw Error('目录刷新不得读取能力')},block:()=>{},create:async()=>{throw Error('目录刷新不得创建')},adopt:async()=>{throw Error('目录刷新不得接入')},open:()=>{throw Error('目录刷新不得导航')},current:()=> 'local'}
 const client=new BindingClient(port)
 const follow=()=>followConversationDirectory({state,generation,watch:async(revision,signal)=>{const result=deferred<unknown>();watches.push({revision,signal,result});return result.promise},refresh:async signal=>{await client.refreshDirectory(signal);return client.getDirectorySnapshot().status==='ready'}})
 return {state,generation,watches,port,client,follow,setRows:(value:Conversation[])=>{rows=value},reads:()=>reads}
}

test('新会话失效刷新同一业务目录，保留当前绑定；无变化不反复读取',async()=>{
 const f=fixture();await f.client.select('local');const selected=f.client.getSnapshot(),dispose=f.follow()
 f.watches[0]!.result.resolve({revision:0});await turn()
 assert.deepEqual(f.client.getDirectorySnapshot().rows.map(value=>value.sessionId),['local'])
 assert.equal(f.watches[1]?.revision,0)
 f.state.set('connected');f.generation.set(f.generation.getSnapshot());assert.equal(f.watches.length,2,'同一世代不叠加订阅循环')
 f.setRows([row('local'),row('remote')]);f.watches[1]!.result.resolve({revision:1});await turn()
 assert.deepEqual(f.client.getDirectorySnapshot().rows.map(value=>value.sessionId),['local','remote'])
 assert.equal(f.client.getSnapshot().sessionId,'local');assert.equal(f.client.getSnapshot().conversation,selected.conversation)
 const reads=f.reads();f.watches[2]!.result.resolve({revision:1});await turn();assert.equal(f.reads(),reads)
 dispose();assert.equal(f.watches.at(-1)?.signal.aborted,true);assert.equal(f.state.listeners.size,0);assert.equal(f.generation.listeners.size,0)
})

test('刷新期间新增会话由下次watch补读；宿主重启revision归零也先补读',async()=>{
 const f=fixture(),reading=deferred<Conversation[]>();f.port.list=()=>reading.promise
 const dispose=f.follow();f.watches[0]!.result.resolve({revision:0});await turn()
 f.port.list=async()=>[row('local'),row('remote')];reading.resolve([row('local')]);await turn()
 assert.equal(f.watches[1]?.revision,0);f.watches[1]!.result.resolve({revision:1});await turn()
 assert.equal(f.client.getDirectorySnapshot().rows.length,2)
 f.generation.set({id:2});assert.equal(f.watches[2]?.signal.aborted,true);assert.equal(f.watches[3]?.revision,undefined)
 f.port.list=async()=>[row('restarted')];f.watches[3]!.result.resolve({revision:0});await turn()
 assert.deepEqual(f.client.getDirectorySnapshot().rows.map(value=>value.sessionId),['restarted'])
 dispose()
})

test('断线取消旧读取；忽略取消的迟到watch和list都不覆盖新世代',async()=>{
 const f=fixture(),oldRead=deferred<Conversation[]>();f.port.list=()=>oldRead.promise
 const dispose=f.follow();f.watches[0]!.result.resolve({revision:3});await turn()
 f.state.set('disconnected');assert.equal(f.watches[0]?.signal.aborted,true)
 oldRead.resolve([row('stale')]);await turn();assert.deepEqual(f.client.getDirectorySnapshot().rows,[])
 f.port.list=async()=>[row('new')];f.generation.set({id:2});f.state.set('connected');f.watches[1]!.result.resolve({revision:0});await turn()
 const oldWatch=f.watches[2]!;f.state.set('connecting');f.generation.set({id:3});f.state.set('connected');f.watches[3]!.result.resolve({revision:0});await turn()
 oldWatch.result.resolve({revision:9});await turn();assert.deepEqual(f.client.getDirectorySnapshot().rows.map(value=>value.sessionId),['new']);assert.equal(f.watches.length,5)
 dispose()
})

test('坏revision回包或读取失败后有界重试，取消即释放重试timer',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 const f=fixture(),dispose=f.follow();f.watches[0]!.result.resolve({revision:'bad'});await turn()
 assert.equal(f.reads(),0);assert.equal(f.watches.length,1);t.mock.timers.tick(999);await turn();assert.equal(f.watches.length,1)
 t.mock.timers.tick(1);await turn();assert.equal(f.watches.length,2)
 f.port.list=async()=>{throw Error('目录暂不可用')};f.watches[1]!.result.resolve({revision:1});await turn()
 assert.equal(f.client.getDirectorySnapshot().status,'failed');assert.equal(f.watches.length,2)
 dispose();t.mock.timers.tick(1000);await turn();assert.equal(f.watches.length,2)
})

test('同时发生的目录刷新只保留较新回包，取消的读取失败不发布错误',async()=>{
 const f=fixture(),old=deferred<Conversation[]>(),cancelled=new AbortController()
 f.port.list=()=>old.promise
 const previous=f.client.refreshDirectory(cancelled.signal)
 f.port.list=async()=>[row('newer')];await f.client.refreshDirectory()
 old.resolve([row('older')]);await previous
 assert.deepEqual(f.client.getDirectorySnapshot().rows.map(value=>value.sessionId),['newer'])
 let fail!:(error:Error)=>void
 f.port.list=()=>new Promise((_,reject)=>{fail=reject})
 const reading=f.client.refreshDirectory(cancelled.signal);cancelled.abort();fail(Error('旧世代读取失败'));await reading
 assert.equal(f.client.getDirectorySnapshot().error,undefined);assert.deepEqual(f.client.getDirectorySnapshot().rows.map(value=>value.sessionId),['newer'])
})
