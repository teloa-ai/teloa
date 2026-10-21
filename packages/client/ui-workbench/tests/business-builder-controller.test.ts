import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {BusinessBuilderController,builderJournalKey,readBuilderSwitchSnapshot} from '../src/client/business-builder-controller.ts'
import {BindingClient,type WorkPort} from '../src/client/binding-client.ts'
import {createBusinessRecordApi} from '../src/client/business-record-api.ts'
import {createBusinessResponsibilityApi} from '../src/client/business-responsibility-api.ts'
import {createBusinessBuilderApi} from '../src/client/business-builder-api.ts'
import type {BusinessBuilderSwitchSnapshot} from '../src/client/business-builder-flow.ts'
import type {BusinessConversationBinding,BusinessConfigurationDraftResponse,Conversation} from '@teloa/contract'

const stamp='2026-09-29T00:00:00.000Z',hash='a'.repeat(64)
function fixture(){
 const rows=new Map<string,string>(),calls:string[]=[],blocks=new Map<string,string|undefined>(),bindings=new Map<string,BusinessConversationBinding>(),drafts=new Map<string,BusinessConfigurationDraftResponse>(),conversations=new Map<string,Conversation>()
 let selected:string|undefined,space=randomUUID(),location='spaces',refreshes=0
 const listeners=new Set<()=>void>(),empty={draft:'',draftRev:0,phase:'plain' as const,attachmentIds:[],occurrences:[],queue:[]}
 let input:BusinessBuilderSwitchSnapshot['input']=empty
 const source={read:():BusinessBuilderSwitchSnapshot=>({mainSessionId:selected,bindingSessionId:selected,bindingReady:input!==undefined,input:selected?input:input===undefined?undefined:null,pendingSubmissions:[],monitor:undefined})}
 const api=createBusinessBuilderApi(async(endpoint,payload)=>{
  calls.push(endpoint);const p=payload as Record<string,any>
  if(endpoint==='business-setup-plan/read')return null
  if(endpoint==='business-conversations/recent-daily')return [...bindings.values()].find(b=>b.kind==='daily'&&b.scope===p.scope)??null
  if(endpoint==='business-conversations/reserve'){
   if(p.kind==='daily'){const b={...p,createdAt:stamp,updatedAt:stamp} as BusinessConversationBinding;bindings.set(b.requestId,b);return b}
   let binding=bindings.get(p.requestId)
   if(!binding){binding={...p,draftId:randomUUID(),createdAt:stamp,updatedAt:stamp} as BusinessConversationBinding;bindings.set(binding.requestId,binding);drafts.set(binding.draftId!,{ownerId:'self',id:binding.draftId!,scope:'sales',revision:1,baseVersion:0,status:'draft',hash,createdAt:stamp,updatedAt:stamp,candidate:{format:'teloa.business-configuration/v1',scope:'sales',title:'订单',sources:[{sourceId:'records',kind:'local-records'}],definitions:[],pages:[]}})}
   return binding
  }
  if(endpoint==='business-conversations/by-request')return bindings.get(p.requestId)??null
  if(endpoint==='business-conversations/bind'){const binding={...bindings.get(p.requestId)!,sessionId:p.sessionId};bindings.set(p.requestId,binding);return binding}
  if(endpoint==='business-conversations/by-session')return [...bindings.values()].find(b=>b.sessionId===p.sessionId)??null
  if(endpoint==='business-configuration/draft')return drafts.get(p.draftId)
  if(endpoint==='business-conversations/list')return {items:[...bindings.values()].map(binding=>({binding,draft:{id:binding.draftId!,scope:'sales',title:'订单',revision:1,status:'draft',updatedAt:stamp}}))}
  throw Error('unexpected '+endpoint)
 })
 const port:WorkPort={list:async()=>[...conversations.values()],read:async id=>conversations.get(id)!,ensure:async id=>conversations.get(id)!,isNativeChild:()=>false,catalog:async()=>{throw Error('not requested')},block:()=>{},current:()=>selected,open:id=>{selected=id;calls.push('open')},adopt:async id=>id,create:async p=>{calls.push('create');const existing=[...conversations.values()].find(row=>row.requestId===p.requestId);if(existing)return existing;const row:Conversation={id:randomUUID(),ownerId:'self',title:p.title!,version:1,status:'ready',sessionId:randomUUID(),requestedSessionId:'request',requestId:p.requestId,scopeIds:['general'],createdAt:stamp,...(p.workspaceId?{requestedWorkspaceId:p.workspaceId}:{})};conversations.set(row.sessionId,row);return row}}
 const controller=new BusinessBuilderController({api,work:new BindingClient(port),storage:{getItem:key=>rows.get(key)??null,setItem:(key,value)=>{rows.set(key,value)},removeItem:key=>{rows.delete(key)}},identity:async()=>space,switching:source,subscribeNative:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},contextCall:async(endpoint,payload)=>{const p=payload as any;if(endpoint==='work-context/read')return {sessionId:p.sessionId,scopeId:'sales',roleId:null,version:1,locked:false};throw Error(endpoint)},block:(id,reason)=>blocks.set(id,reason),watch:()=>()=>{},id:randomUUID})
 controller.configure({location:()=>location,refreshScopes:async()=>{refreshes++}})
 return {port,changeInput:(next:BusinessBuilderSwitchSnapshot['input'])=>{input=next;for(const listener of listeners)listener()},notify:()=>{for(const listener of listeners)listener()},controller,calls,blocks,bindings,drafts,conversations,rows,source,space:()=>space,changeSpace:()=>space=randomUUID(),selected:()=>selected,select:(id:string|undefined)=>{selected=id},navigate:(value:string)=>location=value,location:()=>location,refreshes:()=>refreshes}
}

test('固定原来源的native页面只在本次明确opened后接受，start/open/recover首次完成原稿核对',async t=>{
 for(const operation of ['start','open','recover'] as const){
  const f=fixture();t.after(()=>f.controller.dispose());await f.controller.connect({})
  const original=operation==='start'?undefined:await f.controller.start()
  f.navigate('home');f.controller.configure({location:f.location,nativeLocation:()=> 'messages/native/sales/original-detail',refreshScopes:async()=>{}})
  const open=f.port.open;f.port.open=id=>{open(id);f.navigate('messages/native/sales/original-detail')}
  const result=operation==='start'?await f.controller.start():operation==='open'?await f.controller.open(original!.sessionId!):await f.controller.recover(original!.requestId)
  const state=f.controller.getSnapshot(),binding=state.flow!.getSnapshot().binding!
  assert.equal(state.error,null,operation);assert.equal(state.checkedSessionId,binding.sessionId);assert.equal(binding.sessionId,f.selected())
  assert.equal(state.sessionKind,'builder');assert.equal(f.conversations.size,1);if(result)assert.equal(result.sessionId,binding.sessionId)
 }
})

test('native目标在capture时固定，用户先切页面、换来源或换会话不借本次opened恢复',async t=>{
 for(const change of ['before-open','source','session','changed-projection','cancelled'] as const){
  const f=fixture();t.after(()=>f.controller.dispose());await f.controller.connect({});const original=await f.controller.start()
  f.navigate('home');let projected='messages/native/sales/original-detail'
  f.controller.configure({location:f.location,nativeLocation:()=>projected,refreshScopes:async()=>{}})
  const token=f.controller.captureNavigation(),open=f.port.open
  if(change==='before-open'){const adopt=f.port.adopt;f.port.adopt=async(...args)=>{f.navigate(projected);return adopt(...args)}}
  else if(change==='cancelled')f.controller.ports.work.openSessionResult=async()=>{f.navigate(projected);return 'cancelled'}
  else f.port.open=id=>{open(id);if(change==='source')f.navigate('messages/native/other-scope/detail');else if(change==='session'){f.navigate(projected);f.select('other-session')}else{projected='messages/native/changed-detail';f.navigate(projected)}}
  await assert.rejects(f.controller.open(original.sessionId!,false,token),{code:'teloa/conflict'},change)
  assert.equal(f.conversations.size,1)
 }
})

test('来源抽屉关闭后原生read迟答不能导航到旧方案',async()=>{
 const f=fixture();f.select('original');await f.controller.connect({})
 let current=true,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve)
 f.port.read=async sessionId=>{await gate;return {id:'target',sessionId,requestedSessionId:sessionId,ownerId:'self',title:'方案',scopeIds:['general'],version:1,status:'ready',createdAt:stamp}}
 const token=f.controller.captureNavigation(()=>current),pending=f.controller.open('target',false,token)
 await new Promise(resolve=>setImmediate(resolve));current=false;release();await assert.rejects(pending,{code:'teloa/conflict'})
 assert.equal(f.selected(),'original');assert.equal(f.calls.includes('open'),false)
 f.controller.dispose()
})
test('创建已绑定但离开到无主会话视图时，等待拒绝后清理旧Flow且保留原创建回执',async t=>{
 const f=fixture();t.after(()=>f.controller.dispose());await f.controller.connect({})
 const read=f.controller.ports.api.draft
 f.controller.ports.api.draft=async request=>{const draft=await read(request);f.navigate('tasks');f.select(undefined);return draft}
 await assert.rejects(f.controller.start({}),{code:'teloa/conflict'})
 assert.equal(f.selected(),undefined)
 assert.equal(f.controller.getSnapshot().flow!.getSnapshot().phase,'idle')
 assert.equal(f.controller.getSnapshot().checkedSessionId,null)
 assert.equal(f.calls.filter(call=>call==='create').length,1)
 assert.equal(f.calls.includes('open'),false)
 assert.equal(f.bindings.size,1)
 assert.equal(f.conversations.size,1)
})
test('无main真实已就绪的空选择不造InputState；未确认连接/选择/绑定保持undefined',()=>{
 const common={connected:true,generationReady:true,selectionReady:true,mainSessionId:undefined,bindingSessionId:undefined,bindingReady:false,pendingSubmissions:[],monitor:undefined}
 assert.equal(readBuilderSwitchSnapshot({...common,input:undefined}).input,null)
 assert.equal(readBuilderSwitchSnapshot({...common,input:undefined}).bindingReady,true)
 for(const patch of [{connected:false},{generationReady:false},{selectionReady:false},{bindingSessionId:'old'}])assert.equal(readBuilderSwitchSnapshot({...common,...patch,input:undefined}).input,undefined)
 const input={draft:'old',draftRev:2,phase:'plain' as const,attachmentIds:[],occurrences:[],queue:[]}
 assert.equal(readBuilderSwitchSnapshot({...common,mainSessionId:'s',bindingSessionId:'s',bindingReady:true,input}).input,input)
 assert.equal(readBuilderSwitchSnapshot({...common,mainSessionId:'s',input:undefined}).input,undefined)
})

test('首次工作绑定ensure未完成不抢跑业务读取；就绪后按原会话核对，真实失败只显式重试',async()=>{
 const f=fixture();f.select('cold-home');f.changeInput(undefined)
 let reads=0,fail=false
 f.controller.ports.api.bySession=async()=>{reads++;if(fail)throw Object.assign(Error('binding unavailable'),{code:'teloa/not-bound'});return null}
 await f.controller.connect({})
 assert.equal(reads,0);assert.equal(f.controller.getSnapshot().checkedSessionId,undefined)
 assert.equal(f.controller.getSnapshot().error,null);assert.equal(f.blocks.get('cold-home'),'checking')
 f.changeInput({draft:'原稿',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[],queue:[]})
 await f.controller.followSession('cold-home')
 assert.equal(reads,1);assert.equal(f.controller.getSnapshot().checkedSessionId,'cold-home');assert.equal(f.blocks.get('cold-home'),undefined)
 fail=true;await f.controller.retry();assert.equal(reads,2);assert.equal((f.controller.getSnapshot().error as {code:string}).code,'teloa/not-bound')
 f.notify();await f.controller.followSession('cold-home');assert.equal(reads,2,'失败不盲重试')
 fail=false;await f.controller.retry();assert.equal(reads,3);assert.equal(f.controller.getSnapshot().error,null)
 f.controller.dispose()
})

test('待用绑定切换先使旧读取失效，旧回包不污染新会话等待与就绪状态',async()=>{
 const f=fixture();f.select('old')
 let release!:(value:null)=>void;const reads:string[]=[]
 f.controller.ports.api.bySession=async({sessionId})=>{reads.push(sessionId);return sessionId==='old'?new Promise<null>(resolve=>{release=resolve}):null}
 const connecting=f.controller.connect({});await new Promise(resolve=>setImmediate(resolve))
 f.select('new');f.changeInput(undefined);await f.controller.followSession('new')
 assert.deepEqual(reads,['old']);release(null);await connecting
 assert.equal(f.controller.getSnapshot().checkedSessionId,undefined);assert.equal(f.controller.getSnapshot().error,null)
 f.changeInput({draft:'新原稿',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[],queue:[]});await f.controller.followSession('new')
 assert.deepEqual(reads,['old','new']);assert.equal(f.controller.getSnapshot().checkedSessionId,'new');assert.equal(f.blocks.get('new'),undefined)
 f.controller.dispose()
})

test('权威personal空间namespace在重连稳定、换本人库隔离；身份读取失败没有共享fallback',async()=>{
 const f=fixture();await f.controller.connect({id:1})
 const first=f.controller.getSnapshot().flow!
 assert.equal(f.controller.getSnapshot().namespace,builderJournalKey(f.space()))
 await f.controller.connect(undefined);assert.equal(f.controller.getSnapshot().flow,null)
 await f.controller.connect({id:2});assert.notEqual(f.controller.getSnapshot().flow,first)
 assert.equal(f.controller.getSnapshot().namespace,builderJournalKey(f.space()))
 const previous=f.controller.getSnapshot().namespace;f.changeSpace();await f.controller.connect({id:3})
 assert.notEqual(f.controller.getSnapshot().namespace,previous)
})

test('销毁立即使负责人旧实例失效；晚回包保留journal，同generation重接可核对原成功回执',async()=>{
 const f=fixture(),generation={},calls:string[]=[]
 await f.controller.connect(generation)
 const storage={getItem:(key:string)=>f.rows.get(key)??null,setItem:(key:string,value:string)=>{f.rows.set(key,value)},removeItem:(key:string)=>{f.rows.delete(key)}}
 const input={scope:'sales',requestId:randomUUID(),expectedVersion:0,role:null}
 const receipt={scope:'sales',version:1,roleId:null,selectedRoleVersion:null,currentRoleVersion:null,availability:'none'}
 let release!:(value:unknown)=>void
 const original=f.controller.getSnapshot(),namespace=original.namespace!,token=original.api!
 const api=createBusinessResponsibilityApi(async method=>{calls.push(method);return new Promise(resolve=>{release=resolve})},{storage,personalSpaceId:f.space(),isCurrent:()=>{const current=f.controller.getSnapshot();return current.status==='ready'&&current.namespace===namespace&&current.api===token}})
 const pending=api.set(input)
 f.controller.dispose();release(receipt)
 await assert.rejects(pending,{code:'teloa/conflict',details:{reason:'changed'}})
 assert.equal(f.rows.size,1)
 await assert.rejects(api.set({...input,requestId:randomUUID()}));assert.equal(calls.length,1)
 await f.controller.connect(generation)
 const next=f.controller.getSnapshot();assert.notEqual(next.api,token);assert.equal(next.namespace,namespace)
 await assert.rejects(api.read({scope:'sales'}));assert.equal(calls.length,1,'重接不能复活旧实例')
 const restored=createBusinessResponsibilityApi(async method=>{calls.push(method);return receipt},{storage,personalSpaceId:f.space(),isCurrent:()=>f.controller.getSnapshot().namespace===next.namespace&&f.controller.getSnapshot().api===next.api})
 assert.equal(restored.pending('sales')?.requestId,input.requestId)
 assert.deepEqual(await restored.reconcile({scope:'sales'}),receipt);assert.equal(f.rows.size,0)
 assert.deepEqual(calls,['business-responsibility/set','business-responsibility/receipt','business-responsibility/read'])
 f.changeInput(undefined);assert.equal(f.controller.getSnapshot().nativeReady,false,'重接必须恢复真实native就绪订阅')
 f.controller.dispose()
})

test('真实BindingClient首次新建只有一原生业务会话；全局重开恢复不重复create或open',async()=>{
 const f=fixture();await f.controller.connect({id:1});await f.controller.start({workspaceId:'workspace'})
 assert.equal(f.calls.filter(c=>c==='create').length,1);assert.equal(f.calls.filter(c=>c==='open').length,1)
 const id=f.selected()!;await f.controller.followSession(id)
 assert.equal(f.controller.getSnapshot().flow!.getSnapshot().binding!.sessionId,id)
 assert.equal(f.blocks.get(id),undefined)
 await f.controller.followSession(id)
 assert.equal(f.calls.filter(c=>c==='create').length,1)
 f.controller.dispose()
})

test('明确start/open/recover等待原目标的延迟原生绑定通知，完成前不冒充ready或重复导航',async t=>{
 for(const operation of ['start','open','recover'] as const){
  const f=fixture();t.after(()=>f.controller.dispose());await f.controller.connect({})
  const original=operation==='start'?undefined:await f.controller.start({workspaceId:'workspace'})
  if(original){f.select(undefined);f.notify();await f.controller.followSession(undefined)}
  const open=f.port.open;f.port.open=id=>{open(id);f.changeInput(undefined)}
  let settled=false
  const pending=operation==='start'?f.controller.start({workspaceId:'workspace'}):operation==='open'?f.controller.open(original!.sessionId!):f.controller.recover(original!.requestId)
  void pending.then(()=>{settled=true},()=>{settled=true})
  await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve))
  assert.equal(settled,false,operation+'必须等待官方原生绑定通知')
  const sessionId=f.selected()!,created=f.calls.filter(c=>c==='create').length,opened=f.calls.filter(c=>c==='open').length
  assert.equal(f.controller.getSnapshot().checkedSessionId,undefined)
  f.changeInput({draft:'',draftRev:0,phase:'plain',attachmentIds:[],occurrences:[],queue:[]})
  await pending
  const state=f.controller.getSnapshot(),builder=state.flow!.getSnapshot()
  assert.equal(state.nativeReady,true);assert.equal(state.checkedSessionId,sessionId);assert.equal(state.sessionKind,'builder')
  assert.equal(builder.binding!.sessionId,sessionId);assert.equal(builder.draft!.id,builder.binding!.draftId)
  assert.equal(f.calls.filter(c=>c==='create').length,created);assert.equal(f.calls.filter(c=>c==='open').length,opened)
  assert.equal(f.conversations.size,1)
 }
})

test('同原目标交错follow合并读取，所有调用都等待最终绑定核对',async t=>{
 const f=fixture();t.after(()=>f.controller.dispose());await f.controller.connect({});const bound=await f.controller.start()
 await f.controller.followSession(undefined)
 const read=f.controller.ports.api.bySession;let reads=0,release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve});t.after(()=>release())
 f.controller.ports.api.bySession=async input=>{reads++;if(reads===1)await gate;return read(input)}
 const first=f.controller.followSession(bound.sessionId!);await new Promise(resolve=>setImmediate(resolve))
 const second=f.controller.followSession(bound.sessionId!),third=f.controller.followSession(bound.sessionId!)
 assert.equal(reads,1,'同target只保留一条在途读取')
 release();await Promise.all([first,second,third])
 assert.equal(reads,2,'一轮归属核对和Flow恢复各读一次，不互相作废重读')
 assert.equal(f.controller.getSnapshot().checkedSessionId,bound.sessionId)
 assert.equal(f.controller.getSnapshot().flow!.getSnapshot().draft!.id,bound.draftId)
})

test('明确导航等待中关闭/API/原生session变化立即失效，迟答不串入新目标',async t=>{
 for(const stage of ['binding','draft'] as const)for(const mode of ['close','api','session'] as const){
  const f=fixture();t.after(()=>f.controller.dispose());await f.controller.connect({})
  const abort=new AbortController(),token=f.controller.captureNavigation(()=>!abort.signal.aborted,abort.signal)
  const originalFlow=f.controller.getSnapshot().flow!,read=f.controller.ports.api.bySession,draft=f.controller.ports.api.draft;let release!:()=>void,entered!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve}),reading=new Promise<void>(resolve=>{entered=resolve});t.after(()=>release())
  if(stage==='binding')f.controller.ports.api.bySession=async input=>{entered();await gate;return read(input)}
  else f.controller.ports.api.draft=async input=>{if(f.calls.includes('open')){entered();await gate}return draft(input)}
  let rejected=false;const pending=f.controller.start({},token);void pending.catch(()=>{rejected=true})
  await reading;const sessionId=f.selected()!;let reconnect:Promise<void>|undefined
  if(mode==='close')abort.abort()
  else if(mode==='api')reconnect=f.controller.connect({})
  else{f.select('new-native-target');f.notify()}
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(rejected,true,stage+'/'+mode+'必须立即失效，不等待旧RPC回包')
  await assert.rejects(pending,{code:'teloa/conflict',details:{reason:'changed'}})
  release();await reconnect;await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve))
  if(mode==='api'){
   assert.notEqual(f.controller.getSnapshot().flow,originalFlow)
   assert.equal(f.controller.getSnapshot().checkedSessionId,sessionId,'新API独立核对原目标，不被旧finally覆盖')
  }else if(mode==='close'){
   assert.equal(f.controller.getSnapshot().checkedSessionId,sessionId,'关闭后仍选中原目标，由原在途只读核验恢复保护')
   assert.equal(f.blocks.get(sessionId),undefined)
  }else assert.equal(f.controller.getSnapshot().checkedSessionId,undefined)
  if(mode!=='close')assert.equal(originalFlow.getSnapshot().phase,'idle','切主体/目标后旧Flow迟答不恢复ready')
  if(mode==='session')assert.equal(f.selected(),'new-native-target')
  assert.equal(f.calls.filter(c=>c==='create').length,1);assert.equal(f.calls.filter(c=>c==='open').length,1)
  assert.equal(f.conversations.size,1)
 }
})

test('从B打开已有A后关闭只取消局部等待，原A可信核验解锁或显式重试，不重开会话',async t=>{
 for(const fail of [false,true]){
  const f=fixture();t.after(()=>f.controller.dispose());await f.controller.connect({})
  const a=await f.controller.start(),b=await f.controller.start(),flow=f.controller.getSnapshot().flow!
  assert.equal(flow.getSnapshot().binding!.sessionId,b.sessionId)
  const abort=new AbortController(),token=f.controller.captureNavigation(()=>!abort.signal.aborted,abort.signal)
  const read=f.controller.ports.api.bySession;let release!:()=>void,entered!:()=>void
  const gate=new Promise<void>(resolve=>{release=resolve}),reading=new Promise<void>(resolve=>{entered=resolve});t.after(()=>release())
  f.controller.ports.api.bySession=async input=>{if(input.sessionId===a.sessionId){entered();await gate;if(fail)throw Error('A binding unavailable')}return read(input)}
  const pending=f.controller.open(a.sessionId!,false,token);void pending.catch(()=>{})
  await reading;assert.equal(f.selected(),a.sessionId);assert.equal(f.blocks.get(a.sessionId!),'checking')
  assert.equal(flow.getSnapshot().binding!.sessionId,b.sessionId,'开始核验A时Flow仍保留B原稿，不能借它放行')
  const created=f.calls.filter(c=>c==='create').length,opened=f.calls.filter(c=>c==='open').length
  abort.abort();await assert.rejects(pending,{code:'teloa/conflict',details:{reason:'changed'}})
  assert.equal(f.blocks.get(a.sessionId!),'checking','关闭不能无条件解除原生发送保护')
  release();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve))
  assert.equal(f.controller.getSnapshot().checkedSessionId,a.sessionId)
  if(fail){
   assert.match(String(f.controller.getSnapshot().error),/A binding unavailable/);assert.equal(f.blocks.get(a.sessionId!),'checking')
   f.controller.ports.api.bySession=read;await f.controller.retry()
  }
  assert.equal(f.controller.getSnapshot().error,null);assert.equal(f.blocks.get(a.sessionId!),undefined)
  assert.equal(flow.getSnapshot().binding!.sessionId,a.sessionId);assert.equal(flow.getSnapshot().draft!.id,a.draftId)
  assert.equal(f.calls.filter(c=>c==='create').length,created);assert.equal(f.calls.filter(c=>c==='open').length,opened)
 }
})

test('原生绑定尚未就绪时关闭留下可重试状态，随后只读核验恢复原目标',async t=>{
 const f=fixture();t.after(()=>f.controller.dispose());await f.controller.connect({})
 const abort=new AbortController(),token=f.controller.captureNavigation(()=>!abort.signal.aborted,abort.signal)
 const open=f.port.open;f.port.open=id=>{open(id);f.changeInput(undefined)}
 const pending=f.controller.start({},token);void pending.catch(()=>{})
 await new Promise(resolve=>setImmediate(resolve));const sessionId=f.selected()!
 abort.abort();await assert.rejects(pending,{code:'teloa/conflict'})
 assert.equal(f.controller.getSnapshot().checkedSessionId,undefined)
 assert.ok(f.controller.getSnapshot().error,'没有在途核验时不可留下无限checking而无错误/重试入口')
 f.changeInput({draft:'',draftRev:0,phase:'plain',attachmentIds:[],occurrences:[],queue:[]});await f.controller.retry()
 assert.equal(f.controller.getSnapshot().checkedSessionId,sessionId);assert.equal(f.controller.getSnapshot().error,null)
 assert.equal(f.calls.filter(c=>c==='create').length,1);assert.equal(f.calls.filter(c=>c==='open').length,1)
})

test('切换原生会话读取期间暂时阻止发送；失败不当作普通空绑定放行',async()=>{
 const f=fixture();await f.controller.connect({id:1});await f.controller.start({})
 const id=f.selected()!;await f.controller.followSession(undefined)
 const pending=f.controller.followSession(id)
 assert.equal(typeof f.blocks.get(id),'string');await pending;assert.equal(f.blocks.get(id),undefined)
 f.controller.dispose()
})


test('生产record装配在同本人刷新后核对原request；不同空间和类型不继承未知请求',async()=>{
 const f=fixture();await f.controller.connect({id:1})
 let receipt:any;const requests:string[]=[]
 const api=createBusinessRecordApi(async(method,input)=>{
  const p=input as any;requests.push(method+':'+p.requestId)
  if(method==='business-records/create'){receipt={scope:p.scope,type:p.type,id:'one',version:1,snapshotHash:hash,title:p.title,summary:p.summary,source:'本地记录',observedAt:stamp,receivedAt:stamp,quality:'complete',fields:[]};throw Error('lost response')}
  if(method==='business-records/receipt')return receipt
  throw Error(method)
 })
 const definition={format:'teloa.business-object-type/v1' as const,domain:'sales',id:'ticket',version:'1.0.0',sourceId:'records',title:'工单',unit:'条',lead:'工单记录',fields:[{name:'note',label:'备注',from:'备注',type:'text' as const,required:false}]}
 const original=f.controller.createRecordFlow(api).forTarget('sales','ticket')
 original.configure(definition,{create:true,edit:true,archive:true});original.create();original.change('title','首条记录');await original.save()
 assert.equal(original.getSnapshot().phase,'unknown');const request=original.getSnapshot().pending!.input.requestId
 await f.controller.connect({id:2})
 const restored=f.controller.createRecordFlow(api).forTarget('sales','ticket');assert.equal(restored.getSnapshot().pending?.input.requestId,request)
 assert.equal(f.controller.createRecordFlow(api).forTarget('sales','other').getSnapshot().phase,'idle')
 f.changeSpace();await f.controller.connect({id:3});assert.equal(f.controller.createRecordFlow(api).forTarget('sales','ticket').getSnapshot().phase,'idle')
 await restored.recover();assert.equal(restored.getSnapshot().phase,'saved')
 assert.deepEqual(requests,['business-records/create:'+request,'business-records/receipt:'+request]);assert.equal(f.rows.size,0)
})

test('官方MutableSessionEventSource成功revise结果只刷新一次；继承历史、其它工具、失败结果不刷新',async()=>{
 const {MutableSessionEventSource}=await import(new URL('./types/client/contract/events.js',import.meta.resolve('@deepseek-ai/dsh-api-session-controller/client')).href)
 const module=await import('../src/client/business-builder-controller.ts')
 const source=new MutableSessionEventSource();let refreshes=0
 const call=(seq:number,id:string,name='teloa_business_builder_revise')=>({type:'event',event:{type:'tool/call',seq,time:0,data:{callId:id,name,arguments:{}},surfaceOp:'none'}} as any)
 const result=(seq:number,id:string,error=false)=>({type:'event',event:{type:'tool/result',seq,time:0,data:{message:{toolCallId:id,isError:error}},surfaceOp:'append'}} as any)
 source.replace([call(1,'old'),result(2,'old')],false)
 const off=module.watchBusinessBuilderRevisions(source,()=>refreshes++)
 source.prepend([call(-1,'history'),result(0,'history')],false);assert.equal(refreshes,0)
 source.append(call(3,'other','read_file'));source.append(result(4,'other'));assert.equal(refreshes,0)
 source.append(call(5,'failed'));source.append(result(6,'failed',true));assert.equal(refreshes,0)
 source.append(call(7,'changed'));source.append(result(8,'changed'));assert.equal(refreshes,1)
 source.replace(source.getSnapshot().entries,false);assert.equal(refreshes,1)
 source.append(call(9,'plan','teloa_business_builder_plan_revise'));source.append(result(10,'plan'));assert.equal(refreshes,2)
 off();source.append(call(11,'later'));source.append(result(12,'later'));assert.equal(refreshes,2)
})

test('权威身份失败保持关闭并可显式重试，绑定读失败继续阻止原生发送',async()=>{
 const f=fixture();f.controller.ports.identity=async()=>{throw Error('offline')};await f.controller.connect({})
 assert.equal(f.controller.getSnapshot().status,'failed');assert.equal(f.controller.getSnapshot().namespace,null);assert.equal(f.controller.getSnapshot().flow,null)
 await assert.rejects(()=>f.controller.start());assert.equal(f.calls.length,0)
 f.controller.ports.identity=async()=>f.space();await f.controller.retry();assert.equal(f.controller.getSnapshot().status,'ready')
 f.select('ordinary');f.controller.ports.api.bySession=async()=>{throw Error('offline')};await f.controller.followSession('ordinary')
 assert.equal(typeof f.blocks.get('ordinary'),'string');assert.match(String(f.controller.getSnapshot().error),/offline/)
})


test('旧连接预览在途不吞掉新连接当前草案刷新',async()=>{
 const f=fixture();await f.controller.connect({});await f.controller.start()
 const draft=[...f.drafts.values()][0]!
 let release!:(value:BusinessConfigurationDraftResponse)=>void,reads=0
 f.controller.ports.api.draft=async()=>{reads++;return reads===1?new Promise(resolve=>{release=resolve}):draft}
 const old=f.controller.refreshPreview();await f.controller.connect({})
 assert.equal(reads,3,'旧请求1次，新连接restore与refresh各1次')
 release(draft);await old;assert.equal(f.controller.getSnapshot().error,null)
})

test('服务端pending绑定阻止发送，Panel原Flow显式恢复相同request后解锁且不增加会话',async()=>{
 const f=fixture();await f.controller.connect({});const ready=await f.controller.start(),sessionId=ready.sessionId!
 const {sessionId:_,...pending}=ready;f.bindings.set(ready.requestId,pending)
 f.controller.ports.api.bySession=async()=>f.bindings.get(ready.requestId)!
 await f.controller.followSession(undefined);await f.controller.followSession(sessionId)
 assert.equal(f.blocks.get(sessionId),'builder-pending')
 await f.controller.getSnapshot().flow!.recoverCreation(ready.requestId)
 assert.equal(f.blocks.get(sessionId),undefined)
 assert.equal(f.controller.getSnapshot().flow!.getSnapshot().binding!.sessionId,sessionId)
 assert.equal(f.conversations.size,1)
})

test('R1 同generation绑定失败后显式retry重新读取并清error/自身block',async()=>{
 const f=fixture(),generation={};let reads=0,fail=true
 f.select('ordinary');f.controller.ports.api.bySession=async()=>{reads++;if(fail)throw Error('transient');return null}
 await f.controller.connect(generation)
 assert.equal(f.controller.getSnapshot().status,'ready');assert.equal(reads,1);assert.ok(f.blocks.get('ordinary'))
 fail=false;await f.controller.retry()
 assert.equal(reads,2);assert.equal(f.controller.getSnapshot().error,null);assert.equal(f.blocks.get('ordinary'),undefined)
 assert.equal(f.controller.getSnapshot().checkedSessionId,'ordinary')
})

test('R1 等待本人身份前先阻止当前main，期间换main与失败均保持；成功核对才解禁',async()=>{
 const f=fixture();let reject!:(error:Error)=>void
 f.select('initial');f.controller.ports.identity=()=>new Promise((_,no)=>{reject=no})
 const connecting=f.controller.connect({})
 assert.equal(f.controller.getSnapshot().status,'loading');assert.ok(f.blocks.get('initial'))
 f.select('next');await f.controller.followSession('next');assert.ok(f.blocks.get('next'))
 reject(Error('identity offline'));await connecting
 assert.equal(f.controller.getSnapshot().status,'failed');assert.ok(f.blocks.get('next'))
 f.select('failed-selection');await f.controller.followSession('failed-selection');assert.ok(f.blocks.get('failed-selection'))
 f.controller.ports.identity=async()=>f.space();await f.controller.retry()
 assert.equal(f.controller.getSnapshot().checkedSessionId,'failed-selection');assert.equal(f.blocks.get('failed-selection'),undefined)
 assert.ok(f.blocks.get('initial'));assert.ok(f.blocks.get('next'))
 f.select('next');await f.controller.followSession('next');assert.equal(f.blocks.get('next'),undefined)
})


test('统一业务生命周期识别全局pending daily，阻止发送且不把它恢复为builder或另建首页会话',async()=>{
 const f=fixture(),requestId=randomUUID(),sessionId='daily-global'
 f.select(sessionId);f.bindings.set(requestId,{requestId,kind:'daily',scope:'sales',title:'原业务会话',createdAt:stamp,updatedAt:stamp})
 f.controller.ports.api.bySession=async()=>f.bindings.get(requestId)!
 await f.controller.connect({})
 assert.equal(f.controller.getSnapshot().sessionKind,'daily');assert.equal(f.controller.getSnapshot().daily!.getSnapshot().phase,'pending')
 assert.equal(f.blocks.get(sessionId),'daily-pending');assert.equal(f.calls.filter(x=>x==='create').length,0)
 assert.equal(f.controller.getSnapshot().flow!.getSnapshot().binding,null)
 f.controller.dispose()
})

test('真实native就绪订阅仅在状态变化发布，未知input不捕获导航批准',async()=>{
 const f=fixture();f.changeInput(undefined);await f.controller.connect({})
 assert.equal(f.controller.getSnapshot().nativeReady,false);assert.throws(()=>f.controller.captureNavigation())
 let changes=0;const off=f.controller.subscribe(()=>changes++)
 f.notify();f.notify();assert.equal(changes,0)
 f.changeInput(null);assert.equal(f.controller.getSnapshot().nativeReady,true);assert.equal(changes,1)
 f.notify();assert.equal(changes,1);off();f.controller.dispose()
})

test('草稿批准固定同InputState跨确认与工作区等待，新编辑/导航/重连使原token失效',async()=>{
 for(const change of ['input','location','connection']){
  const f=fixture();f.select('original');await f.controller.connect({})
  const input={draft:'原稿',draftRev:1,phase:'plain' as const,attachmentIds:[],occurrences:[],queue:[]};f.changeInput(input)
  const token=f.controller.captureNavigation();f.controller.approveNavigation(token)
  if(change==='input')f.changeInput({...input,draft:'后来编辑',draftRev:2})
  if(change==='location')f.navigate('elsewhere')
  if(change==='connection')await f.controller.connect({})
  await assert.rejects(f.controller.start({workspaceId:'workspace'},token),{code:'teloa/conflict',details:{reason:'changed'}})
  assert.equal(f.calls.filter(c=>c==='create').length,0)
  f.controller.dispose()
 }
})

test('默认daily预检复用最近而无需工作区选择；pending显示原请求，明确new也不能绕过',async()=>{
 const f=fixture();await f.controller.connect({})
 const requestId=randomUUID(),binding:BusinessConversationBinding={requestId,kind:'daily',scope:'sales',title:'原业务',createdAt:stamp,updatedAt:stamp}
 f.bindings.set(requestId,binding)
 assert.equal(await f.controller.prepareDaily({scope:'sales',title:'销售',newConversation:true}),false)
 assert.deepEqual(f.controller.getSnapshot().dailyPending,binding)
 assert.equal(f.calls.filter(c=>c==='create').length,0)
 f.controller.dispose()
})


test('同一草稿批准贯穿原生read/adopt等待；后来编辑不能借旧批准抢开',async()=>{
 for(const stage of ['read','adopt']){
  const f=fixture();f.select('original');await f.controller.connect({})
  const input={draft:'原稿',draftRev:1,phase:'plain' as const,attachmentIds:[],occurrences:[],queue:[]};f.changeInput(input)
  const token=f.controller.captureNavigation();f.controller.approveNavigation(token)
  let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve)
  f.port.read=async sessionId=>{if(stage==='read')await gate;return {id:'target',sessionId,requestedSessionId:sessionId,ownerId:'self',title:'目标',scopeIds:['general'],version:1,status:'ready',createdAt:stamp}}
  f.port.adopt=async id=>{if(stage==='adopt')await gate;return id}
  const pending=f.controller.open('target',false,token)
  await new Promise(resolve=>setImmediate(resolve));f.changeInput({...input,draft:'后来编辑',draftRev:2});release();await assert.rejects(pending,{code:'teloa/conflict'})
  assert.equal(f.selected(),'original');assert.equal(f.calls.includes('open'),false)
  f.controller.dispose()
 }
})

test('本人切换后daily旧context回包不得绑定或打开新主体，当前业务阻止不被旧finally清除',async()=>{
 const f=fixture();await f.controller.connect({});const original=f.controller.getSnapshot().daily!
 let release!:(value:unknown)=>void,entered!:()=>void;const atContext=new Promise<void>(resolve=>entered=resolve)
 f.controller.ports.contextCall=async()=>{entered();return new Promise(resolve=>release=resolve)}
 const pending=f.controller.openDaily({scope:'sales',title:'销售',workspaceId:'workspace'})
 await atContext;f.changeSpace();await f.controller.connect({});f.select('other');await f.controller.followSession('other')
 release(null);await assert.rejects(pending)
 assert.notEqual(f.controller.getSnapshot().daily,original);assert.equal(f.controller.getSnapshot().checkedSessionId,'other')
 assert.equal(f.calls.includes('business-conversations/bind'),false);assert.equal(f.calls.includes('open'),false)
 f.controller.dispose()
})


test('R2 当前真实builder重开保留同InputState草稿，不要求迁移确认；另一会话仍拒绝',async()=>{
 const f=fixture();await f.controller.connect({});await f.controller.start({})
 const current=f.selected()!,input={draft:'刷新后保留的原稿',draftRev:1,phase:'plain' as const,attachmentIds:[],occurrences:[],queue:[]}
 f.changeInput(input)
 await f.controller.open(current)
 assert.equal(f.selected(),current);assert.equal(f.source.read().input,input);assert.equal(f.calls.filter(c=>c==='create').length,1)
 await assert.rejects(f.controller.open('other'),{code:'teloa/conflict',details:{reason:'draft'}})
 f.controller.dispose()
})

test('R2 当前builder重开仍核unknown/pending/真实binding，核对和adopt等待中新编辑仍失效',async()=>{
 for(const mode of ['unknown','pending','binding','read-changed','adopt-changed']){
  const f=fixture();await f.controller.connect({});await f.controller.start({})
  const current=f.selected()!,input={draft:'原稿',draftRev:1,phase:'plain' as const,attachmentIds:[],occurrences:[],queue:[]};f.changeInput(input)
  const read=f.source.read;let checks=0
  if(mode==='unknown')f.source.read=()=>({...read(),monitor:{getSnapshot:()=>({}) as never,check:async()=>{checks++}}})
  if(mode==='pending')f.source.read=()=>({...read(),pendingSubmissions:[{requestId:'inflight'}]})
  if(mode==='binding')f.controller.ports.api.bySession=async()=>null
  if(mode==='read-changed'){const original=f.controller.ports.api.bySession;f.controller.ports.api.bySession=async request=>{const result=await original(request);f.changeInput({...input,draft:'新编辑',draftRev:2});return result}}
  if(mode==='adopt-changed')f.port.adopt=async id=>{f.changeInput({...input,draft:'新编辑',draftRev:2});return id}
  const opens=f.calls.filter(c=>c==='open').length
  if(mode==='adopt-changed')await assert.rejects(f.controller.open(current),{code:'teloa/conflict',details:{reason:'changed'}})
  else await assert.rejects(f.controller.open(current),{code:'teloa/conflict',details:{reason:mode==='read-changed'?'changed':mode}})
  assert.equal(f.calls.filter(c=>c==='open').length,opens);assert.equal(f.selected(),current)
  if(mode==='unknown')assert.equal(checks,1)
  f.controller.dispose()
 }
})
