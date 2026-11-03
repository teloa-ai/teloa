import test from 'node:test'
import assert from 'node:assert/strict'
import type {Conversation,Group} from '@teloa/contract'
import {BindingClient,type WorkPort} from '../src/client/binding-client.ts'
import {createDialogueNavigation} from '../src/client/dialogue-navigation.ts'
import {createConversationGroupDirectory} from '../src/client/conversation-group-directory.ts'
import {readGroupContentPart} from '../src/client/group-content-loading.ts'
import {readDirectoryRoleIdentities} from '../src/client/session-role-identity.ts'

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
const turn=()=>new Promise(resolve=>setImmediate(resolve))
const row=(id:string):Conversation=>({id:'work-'+id,sessionId:id,requestedSessionId:id,ownerId:'owner',title:id,scopeIds:['general'],version:1,status:'ready',createdAt:'2026-10-30T00:00:00Z'})

test('已有目录后台刷新保持ready和原行，已核验的空目录也不切回首屏加载',async()=>{
 for(const initial of [[],[row('A')]]){
  const pending=deferred<Conversation[]>(),port:WorkPort={list:async()=>initial,read:async id=>row(id),ensure:async id=>row(id),isNativeChild:()=>false,catalog:async()=>{throw Error()},block:()=>{},create:async()=>{throw Error()},adopt:async id=>id,open:()=>{},current:()=>undefined}
  const work=new BindingClient(port);await work.refreshDirectory();const before=work.getDirectorySnapshot()
  port.list=()=>pending.promise;const reading=work.refreshDirectory()
  assert.equal(work.getDirectorySnapshot().status,'ready');assert.equal(work.getDirectorySnapshot().rows,before.rows);assert.equal(work.getDirectorySnapshot().refreshing,true)
  pending.resolve([row('B')]);await reading
  assert.equal(work.getDirectorySnapshot().status,'ready');assert.equal(work.getDirectorySnapshot().refreshing,false);assert.equal(work.getDirectorySnapshot().rows[0]?.sessionId,'B')
 }
})

test('首次读取与重叠的后台读取取消后恢复已落定快照，不遗留loading或refreshing',async()=>{
 const pending=deferred<Conversation[]>(),port:WorkPort={list:()=>pending.promise,read:async id=>row(id),ensure:async id=>row(id),isNativeChild:()=>false,catalog:async()=>{throw Error()},block:()=>{},create:async()=>{throw Error()},adopt:async id=>id,open:()=>{},current:()=>undefined}
 const work=new BindingClient(port),initial=new AbortController(),first=work.refreshDirectory(initial.signal)
 assert.equal(work.getDirectorySnapshot().status,'loading');initial.abort();assert.equal(work.getDirectorySnapshot().status,'idle')
 pending.resolve([]);await first
 port.list=async()=>[row('A')];await work.refreshDirectory();const baseline=work.getDirectorySnapshot()
 const stale=deferred<Conversation[]>(),latest=deferred<Conversation[]>(),cancelled=new AbortController()
 port.list=()=>stale.promise;const a=work.refreshDirectory()
 port.list=()=>latest.promise;const b=work.refreshDirectory(cancelled.signal);cancelled.abort()
 assert.equal(work.getDirectorySnapshot(),baseline)
 latest.resolve([row('B')]);stale.resolve([row('C')]);await Promise.all([a,b]);assert.equal(work.getDirectorySnapshot(),baseline)
})

test('已有会话点击不重复重读整个目录；目录外目标仍补读',async()=>{
 let rows=[row('A')],reads=0
 const opened:string[]=[],port:WorkPort={list:async()=>{reads++;return rows},read:async id=>row(id),ensure:async id=>rows.find(item=>item.sessionId===id)??row(id),isNativeChild:()=>false,catalog:async()=>{throw Error('不读取能力')},block:()=>{},create:async()=>{throw Error('不创建')},adopt:async id=>id,open:id=>opened.push(id),current:()=>undefined}
 const work=new BindingClient(port);await work.refreshDirectory()
 await work.openConversation(row('A'));await work.openConversation(row('A'));assert.equal(reads,1)
 await work.openConversation(row('B'));await turn();assert.equal(reads,2)
 assert.deepEqual(opened,['A','A','B'])
})

test('单聊读取尚未完成时改点群，撤销旧打开且不再领养旧会话',async()=>{
 const navigation=createDialogueNavigation(),binding=deferred<Conversation>(),opened:string[]=[],adopted:string[]=[]
 const port:WorkPort={list:async()=>[],read:async id=>row(id),ensure:()=>binding.promise,isNativeChild:()=>false,catalog:async()=>{throw Error()},block:()=>{},create:async()=>{throw Error()},adopt:async id=>{adopted.push(id);return id},open:id=>opened.push(id),current:()=>undefined}
 const work=new BindingClient(port),signal=navigation.begin(),pending=work.openConversation(row('employee'),signal)
 const group=navigation.begin();assert.equal(signal.aborted,true);assert.equal(group.aborted,false)
 binding.resolve(row('employee'));assert.equal(await pending,'cancelled');assert.deepEqual(opened,[]);assert.deepEqual(adopted,[])
 navigation.cancel();assert.equal(group.aborted,true)
})

test('目录刷新失败后打开已核验的旧条目，仍补读目录以恢复错误状态',async()=>{
 let failed=false,reads=0
 const port:WorkPort={list:async()=>{reads++;if(failed)throw Error('offline');return [row('A')]},read:async id=>row(id),ensure:async id=>row(id),isNativeChild:()=>false,catalog:async()=>{throw Error()},block:()=>{},create:async()=>{throw Error()},adopt:async id=>id,open:()=>{},current:()=>undefined}
 const work=new BindingClient(port);await work.refreshDirectory();failed=true;await work.refreshDirectory();assert.equal(work.getDirectorySnapshot().status,'failed')
 failed=false;await work.openConversation(row('A'));await turn();assert.equal(reads,3);assert.equal(work.getDirectorySnapshot().status,'ready')
})

test('群首次读取复用在途请求，短时间回切复用目录；手动刷新和过期重入仍读真源',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100_000})
 const pending=deferred<{items:Group[]}>();let reads=0
 const directory=createConversationGroupDirectory({list:()=>{reads++;return reads===1?pending.promise:Promise.resolve({items:[]})}})
 const first=directory.ensureLoaded(),second=directory.ensureLoaded();assert.equal(first,second);assert.equal(reads,1)
 pending.resolve({items:[]});await first;await directory.ensureLoaded();assert.equal(reads,1)
 const manual=directory.refresh();assert.equal(directory.ensureLoaded(),manual);await manual;assert.equal(reads,2)
 t.mock.timers.tick(30_001);await directory.ensureLoaded();assert.equal(reads,3)
})

test('慢提及摘要轮询不堆叠，失败后可以重新读',async()=>{
 const pending=deferred<{items:[]}>();let reads=0
 const directory=createConversationGroupDirectory({list:async()=>({items:[]}),attention:async()=>{reads++;if(reads===1)return pending.promise as never;if(reads===2)throw Error('offline');return {items:[]} as never}})
 const first=directory.ensureAttention(),second=directory.ensureAttention();assert.equal(first,second);assert.equal(reads,1)
 pending.resolve({items:[]});await first;await directory.ensureAttention();assert.equal(directory.getSnapshot().attentionFailed,true)
 await directory.ensureAttention();assert.equal(reads,3);assert.equal(directory.getSnapshot().attentionFailed,false)
})

test('员工身份逐条发布，单个慢查询不阻塞其他行，并发上限为六',async()=>{
 const ids=Array.from({length:9},(_,i)=>'session-'+i),pending=new Map(ids.map(id=>[id,deferred<never[]>()])),resolved:string[]=[],called:string[]=[]
 let active=0,peak=0
 const reading=readDirectoryRoleIdentities(ids,async id=>{called.push(id);active++;peak=Math.max(peak,active);try{return await pending.get(id)!.promise}finally{active--}},[],{onResolved:id=>resolved.push(id)})
 assert.equal(called.length,6)
 pending.get(ids[1]!)!.resolve([]);await turn();assert.deepEqual(resolved,[ids[1]]);assert.equal(called.length,7)
 for(const item of pending.values())item.resolve([])
 await reading;assert.equal(resolved.length,9);assert.equal(peak,6)
})

test('员工身份代次失效后停止排队，不发布旧结果',async()=>{
 const signal=new AbortController(),pending=deferred<never[]>(),called:string[]=[],resolved:string[]=[]
 const reading=readDirectoryRoleIdentities(Array.from({length:12},(_,i)=>String(i)),async id=>{called.push(id);return pending.promise},[],{signal:signal.signal,onResolved:id=>resolved.push(id)})
 signal.abort();pending.resolve([]);await reading;assert.equal(called.length,6);assert.deepEqual(resolved,[])
})

test('群消息独立于慢资料显示，但必须等待群身份成功核验',async()=>{
 const identity=deferred<string>(),messages=deferred<string>(),materials=deferred<string>(),shown:string[]=[]
 const main=readGroupContentPart(identity.promise,messages.promise,()=>true,value=>shown.push(value)),resources=readGroupContentPart(identity.promise,materials.promise,()=>true,value=>shown.push(value))
 messages.resolve('已核验的消息');await turn();assert.deepEqual([...shown],[])
 identity.resolve('群身份');await main;assert.deepEqual([...shown],['已核验的消息'])
 materials.resolve('资料');await resources;assert.deepEqual([...shown],['已核验的消息','资料'])
})

test('切群后旧内容不能落入新群；身份失败不展示提前回来的消息',async()=>{
 let current=true;const identity=deferred<string>(),shown:string[]=[]
 const old=readGroupContentPart(identity.promise,Promise.resolve('旧消息'),()=>current,value=>shown.push(value));current=false;identity.resolve('旧群');await old;assert.deepEqual([...shown],[])
 await assert.rejects(readGroupContentPart(Promise.reject(Error('forbidden')),Promise.resolve('无权消息'),()=>true,value=>shown.push(value)),/forbidden/)
 assert.deepEqual([...shown],[])
})


test('分批目录取消尚未返回的后一页时立即保留已核验行并停止加载提示',async()=>{
 const next=deferred<import('@teloa/contract').ConversationDirectoryPage>(),signal=new AbortController()
 const port:WorkPort={list:async()=>[],listPage:input=>input.cursor?next.promise:Promise.resolve({items:[row('A')],nextCursor:'next'}),read:async id=>row(id),ensure:async id=>row(id),isNativeChild:()=>false,catalog:async()=>{throw Error()},block:()=>{},create:async()=>{throw Error()},adopt:async id=>id,open:()=>{},current:()=>undefined}
 const work=new BindingClient(port),reading=work.refreshDirectory(signal.signal);await turn()
 assert.equal(work.getDirectorySnapshot().rows[0]?.sessionId,'A');assert.equal(work.getDirectorySnapshot().loadingMore,true)
 signal.abort();const settled=work.getDirectorySnapshot()
 assert.equal(settled.status,'ready');assert.equal(settled.loadingMore,false);assert.equal(settled.refreshing,false);assert.equal(settled.rows[0]?.sessionId,'A')
 next.resolve({items:[row('B')]});await reading;assert.equal(work.getDirectorySnapshot(),settled)
})
