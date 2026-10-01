import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import type {Conversation,BusinessConfigurationDraftResponseVersioned as BusinessConfigurationDraftResponse,BusinessConversationBinding,BusinessConfigurationApplyResult} from '@teloa/contract'
import type {InputState} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {BindingClient,type WorkPort} from '../src/client/binding-client.ts'
import {createBusinessBuilderApi} from '../src/client/business-builder-api.ts'
import * as module from '../src/client/business-builder-flow.ts'
const stamp='2026-09-29T00:00:00.000Z',hash='a'.repeat(64)
function deferred<T>(){let resolve!:(v:T)=>void,reject!:(e:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function fixture(){
 let saved:string|null=null
 const storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>={getItem:()=>saved,setItem:(_k:string,v:string)=>{saved=v},removeItem:()=>{saved=null}}
 const bindings=new Map<string,BusinessConversationBinding>(),conversations=new Map<string,Conversation>(),drafts=new Map<string,BusinessConfigurationDraftResponse>(),receipts=new Map<string,BusinessConfigurationApplyResult>()
 const calls:string[]=[],writes:unknown[]=[],opened:string[]=[],input:InputState={draft:'',draftRev:0,phase:'plain',attachmentIds:[],occurrences:[],queue:[]}
 let main:string|undefined,scopes=0,fail:string|undefined
 const call=async(endpoint:string,value:unknown,_signal?:AbortSignal):Promise<unknown>=>{
  const r=value as Record<string,any>;calls.push(endpoint)
  if(fail===endpoint){fail=undefined;throw Error('lost')}
  if(endpoint==='business-conversations/reserve'){
   writes.push(value)
   let b=bindings.get(r.requestId)
   if(!b){b={...r,draftId:randomUUID(),createdAt:stamp,updatedAt:stamp} as BusinessConversationBinding;bindings.set(b.requestId,b);drafts.set(b.draftId!,{ownerId:'owner',id:b.draftId!,scope:'sales',revision:2,baseVersion:0,status:'draft',hash,createdAt:stamp,updatedAt:stamp,candidate:{format:'teloa.business-configuration/v1',scope:'sales',title:'当前业务名称',sources:[{sourceId:'records',kind:'local-records'}],definitions:[],pages:[]}})}
   return b
  }
  if(endpoint==='business-conversations/by-request')return bindings.get(r.requestId)??null
  if(endpoint==='business-conversations/by-session')return [...bindings.values()].find(b=>b.sessionId===r.sessionId)??null
  if(endpoint==='business-conversations/bind'){const b={...bindings.get(r.requestId)!,sessionId:r.sessionId};bindings.set(b.requestId,b);return b}
  if(endpoint==='business-conversations/list')return {items:[...bindings.values()].map(binding=>{const d=drafts.get(binding.draftId!)!;return {binding,draft:{id:d.id,title:d.candidate.title,scope:d.scope,revision:d.revision,status:d.status,updatedAt:d.updatedAt}}})}
  if(endpoint==='business-configuration/draft')return drafts.get(r.draftId)!
  if(endpoint==='business-configuration/preview'){const d=drafts.get(r.draftId)!;return {draftId:d.id,revision:r.expectedRevision,candidateHash:d.hash,baseVersion:d.baseVersion,dependencyHash:hash,receipt:hash,changes:{rows:[],truncated:false},issues:[]}}
  if(endpoint==='business-configuration/receipt')return receipts.get(r.requestId)??null
  if(endpoint==='business-configuration/apply'){
   writes.push(value)
   const result={scope:'sales',version:r.expectedBaseVersion+1,configurationHash:hash,requestId:r.requestId};receipts.set(r.requestId,result);return result
  }
  throw Error('unexpected '+endpoint)
 }
 let route=call
 const api=createBusinessBuilderApi((...args)=>route(...args))
 const port:WorkPort={list:async()=>[...conversations.values()],read:async id=>[...conversations.values()].find(c=>c.sessionId===id)!,ensure:async id=>[...conversations.values()].find(c=>c.sessionId===id)!,isNativeChild:()=>false,catalog:async()=>{throw Error()},block:()=>{},current:()=>main,open:id=>{main=id;opened.push(id)},adopt:async id=>id,create:async r=>{
  calls.push('native/create')
  let c=conversations.get(r.requestId);if(!c){c={id:'work',ownerId:'owner',title:r.title??'默认',version:1,status:'ready',sessionId:'session-'+conversations.size,requestedSessionId:'session-'+conversations.size,requestId:r.requestId,scopeIds:['general'],createdAt:stamp,...(r.workspaceId?{requestedWorkspaceId:r.workspaceId}:{})};conversations.set(r.requestId,c)}return c
 }}
 const switching:module.BusinessBuilderSwitchPort={read:()=>({mainSessionId:main,bindingSessionId:main,bindingReady:true,input,pendingSubmissions:[],monitor:{getSnapshot:()=>false,check:async()=>{}}})}
 const make=()=>new module.BusinessBuilderFlow({api,work:new BindingClient(port),storage,journalKey:'owner/builder',id:randomUUID,refreshScopes:async()=>{scopes++;calls.push('scopes')},switching})
 return {make,api,storage,bindings,drafts,receipts,calls,writes,opened,port,conversations,input,switching,setRoute:(f:typeof route)=>route=f,baseCall:call,setFail:(v:string)=>fail=v,scopes:()=>scopes,journal:()=>saved}
}
test('预约前持久固定意图，create/bind断点完整刷新后复用唯一原生会话且绑定前不开',async()=>{
 const f=fixture(),first=f.make();f.setFail('business-conversations/bind')
 await assert.rejects(first.start({workspaceId:'workspace'}),/lost/)
 assert.equal(f.conversations.size,1);assert.deepEqual(f.opened,[])
 const requestId=[...f.bindings.keys()][0]!
 const restored=f.make();await restored.refreshDirectory()
 assert.equal(restored.getSnapshot().directory!.items[0]!.draft!.title,'当前业务名称')
 await restored.recoverCreation(requestId)
 assert.equal(f.conversations.size,1);assert.equal(f.bindings.size,1)
 assert.deepEqual(f.opened,['session-0']);assert.equal(restored.getSnapshot().binding!.sessionId,'session-0');assert.equal(f.journal(),null)
})
test('日志损坏和写失败不发写请求；未知预约仍按原requestId恢复',async()=>{
 const f=fixture();f.storage.setItem('', 'broken')
 await assert.rejects(f.make().start({}));assert.equal(f.calls.length,0)
 f.storage.removeItem('');f.storage.setItem=()=>{throw Error('quota')}
 await assert.rejects(f.make().start({}),/quota/);assert.equal(f.calls.length,0)
 const g=fixture();g.setFail('business-conversations/reserve');await assert.rejects(g.make().start({title:'原名'}))
 const raw=JSON.parse(g.journal()!),requestId=raw.creation.requestId
 await g.make().recoverCreation()
 assert.equal([...g.bindings.keys()][0],requestId)
})
test('创建期间切走不抢开；pending固定title/workspace不允许换投',async()=>{
 const f=fixture(),gate=deferred<void>();f.setRoute(async(e,r)=>{if(e==='business-conversations/bind')await gate.promise;return f.baseCall(e,r)})
 const flow=f.make(),pending=flow.start({title:'原名',workspaceId:'workspace'})
 await new Promise(resolve=>setImmediate(resolve));flow.leave();gate.resolve();await pending
 assert.deepEqual(f.opened,[])
 const g=fixture();g.setFail('business-conversations/bind');const original=g.make();await assert.rejects(original.start({title:'原名'}))
 await assert.rejects(original.start({title:'改名'}),{code:'teloa/conflict'})
 assert.equal(g.conversations.size,1)
})
test('采用丢响应后刷新scope并优先回执，重建flow不更换ID或再次apply',async()=>{
 const f=fixture(),flow=f.make();await flow.start({});await flow.preview()
 let first=true
 f.setRoute(async(e,r)=>{const result=await f.baseCall(e,r);if(e==='business-configuration/apply'&&first){first=false;throw Error('response lost')}return result})
 await assert.rejects(flow.save(),/response lost/)
 const input=(f.writes.at(-1) as {requestId:string}),restored=f.make()
 const result=await restored.recoverSave()
 assert.equal(result!.requestId,input.requestId);assert.equal(f.scopes(),1)
 assert.equal(f.calls.filter(e=>e==='business-configuration/apply').length,1)
 assert.ok(f.calls.lastIndexOf('scopes')<f.calls.lastIndexOf('business-configuration/receipt'))
 assert.equal(f.journal(),null)
})
test('旧revision迟到预览和采用回包不能覆盖新草案',async()=>{
 const f=fixture(),flow=f.make();await flow.start({})
 const gate=deferred<unknown>();f.setRoute(async(e,r)=>e==='business-configuration/preview'?gate.promise:f.baseCall(e,r))
 const pending=flow.preview(),id=flow.getSnapshot().draft!.id,old=f.drafts.get(id)!
 f.drafts.set(id,{...old,revision:3,hash:'b'.repeat(64)});await flow.refreshDraft()
 gate.resolve({draftId:id,revision:2,candidateHash:hash,baseVersion:0,dependencyHash:hash,receipt:hash,changes:{rows:[],truncated:false},issues:[]});await pending
 assert.equal(flow.getSnapshot().draft!.revision,3);assert.equal(flow.getSnapshot().preview,null)
 await assert.rejects(flow.save())
})
test('完整原生状态guard保留附件/引用/队列，unknown只走既有monitor.check',async()=>{
 const f=fixture(),flow=f.make();await flow.start({})
 Object.assign(f.input,{attachmentIds:['image'],occurrences:[{id:'reference'}]})
 await assert.rejects(flow.start({}),{code:'teloa/conflict'})
 assert.equal(f.conversations.size,1)
 let checks=0,unknown=true
 f.switching.read=()=>({mainSessionId:'session-0',bindingSessionId:'session-0',bindingReady:true,input:f.input,pendingSubmissions:[],monitor:{getSnapshot:()=>unknown,check:async()=>{checks++}}})
 assert.equal(await module.checkBusinessBuilderSwitch(f.switching,true),'unknown')
 assert.equal(checks,1)
 unknown=false
 assert.equal(await module.checkBusinessBuilderSwitch(f.switching,false),'draft')
 assert.equal(await module.checkBusinessBuilderSwitch(f.switching,true),'ready')
})
test('重启凭证失效只在原apply明确拒绝且二次回执为空时用同请求重新预览',async()=>{
 const f=fixture(),flow=f.make();await flow.start({});await flow.preview()
 f.setFail('business-configuration/apply');await assert.rejects(flow.save())
 const original=JSON.parse(f.journal()!).save.input,attempts:unknown[]=[],events:string[]=[]
 f.setRoute(async(e,r)=>{
  events.push(e)
  if(e==='business-configuration/apply'){
   attempts.push(r)
   if(attempts.length===1)throw Object.assign(Error('expired'),{code:'teloa/conflict',details:{reason:'preview-receipt-invalid'}})
  }
  const value=await f.baseCall(e,r)
  return e==='business-configuration/preview'?{...value as object,receipt:'b'.repeat(64)}:value
 })
 const result=await f.make().recoverSave()
 assert.equal(result.requestId,original.requestId)
 assert.deepEqual(attempts,[original,{...original,previewReceipt:'b'.repeat(64)}])
 assert.deepEqual(events,['business-configuration/receipt','business-configuration/apply','business-configuration/receipt','business-configuration/draft','business-configuration/preview','business-configuration/apply'])
 assert.equal(f.scopes(),3);assert.equal(f.journal(),null)
})
test('网络/权限/版本/一般冲突不能更新预览凭证，固定journal保留',async()=>{
 for(const error of [Error('network'),Object.assign(Error('permission'),{code:'teloa/forbidden'}),Object.assign(Error('version'),{code:'teloa/version-conflict'}),Object.assign(Error('conflict'),{code:'teloa/conflict'}),Object.assign(Error('wrong code'),{code:'teloa/forbidden',details:{reason:'preview-receipt-invalid'}})]){
  const f=fixture(),flow=f.make();await flow.start({});await flow.preview();f.setFail('business-configuration/apply');await assert.rejects(flow.save())
  const fixed=f.journal(),before=f.calls.filter(e=>e==='business-configuration/preview').length
  f.setRoute(async(e,r)=>{if(e==='business-configuration/apply')throw error;return f.baseCall(e,r)})
  await assert.rejects(f.make().recoverSave(),e=>e===error)
  assert.equal(f.journal(),fixed);assert.equal(f.calls.filter(e=>e==='business-configuration/preview').length,before)
 }
})
test('等待unknown核对时离开，不发预约与原生create',async()=>{
 const f=fixture(),gate=deferred<void>();let unknown=true
 f.switching.read=()=>({mainSessionId:undefined,bindingSessionId:undefined,bindingReady:true,input:undefined,pendingSubmissions:[],monitor:{getSnapshot:()=>unknown,check:async()=>{await gate.promise;unknown=false}}})
 const flow=f.make(),pending=flow.start();flow.leave();gate.resolve()
 await assert.rejects(pending,{code:'teloa/conflict'})
 assert.equal(f.calls.length,0);assert.equal(f.journal(),null)
})
test('迟到采用错误不能盖掉已刷新revision的状态',async()=>{
 const f=fixture(),flow=f.make();await flow.start();await flow.preview()
 const gate=deferred<unknown>();f.setRoute(async(e,r)=>e==='business-configuration/apply'?gate.promise:f.baseCall(e,r))
 const pending=flow.save(),id=flow.getSnapshot().draft!.id,old=f.drafts.get(id)!
 f.drafts.set(id,{...old,revision:3,hash:'b'.repeat(64)});await flow.refreshDraft()
 const refreshed=flow.getSnapshot();gate.reject(Error('late failure'));await assert.rejects(pending)
 assert.equal(flow.getSnapshot(),refreshed);assert.equal(flow.getSnapshot().draft!.revision,3)
 assert.ok(f.journal())
})
test('原生create或adopt丢响应后按同预约恢复，每个断点只留下一个会话',async()=>{
 for(const stage of ['create','adopt'] as const){
  const f=fixture(),original=f.port[stage];let first=true
  if(stage==='create')f.port.create=async input=>{const value=await (original as WorkPort['create'])(input);if(first){first=false;throw Error('lost create')}return value}
  else f.port.adopt=async(...args)=>{const value=await (original as WorkPort['adopt'])(...args);if(first){first=false;throw Error('lost adopt')}return value}
  await assert.rejects(f.make().start({title:'固定标题',workspaceId:'workspace'}))
  assert.equal(f.conversations.size,1);assert.deepEqual(f.opened,[])
  const originalRequest=[...f.bindings.keys()][0]
  await f.make().recoverCreation()
  assert.equal(f.bindings.size,1);assert.equal(f.conversations.size,1);assert.equal([...f.conversations.keys()][0],originalRequest)
  assert.deepEqual(f.opened,['session-0'])
 }
})
test('本地journal不存在也能从精简服务目录按原预约找回，草案新名称不改create标题',async()=>{
 const f=fixture();f.setFail('business-conversations/bind');await assert.rejects(f.make().start({title:'创建原名',workspaceId:'workspace'}))
 const id=[...f.bindings.keys()][0]!
 f.storage.removeItem('');const restored=f.make();await restored.refreshDirectory()
 assert.equal(restored.getSnapshot().directory!.items[0]!.draft!.title,'当前业务名称')
 await restored.recoverCreation(id)
 assert.equal([...f.conversations.values()][0]!.title,'创建原名');assert.equal(f.conversations.size,1);assert.equal(f.journal(),null)
})
test('采用journal写失败不提交，双击采用复用同一个固定请求，成功后刷新真实scope',async()=>{
 const f=fixture(),flow=f.make();await flow.start();await flow.preview()
 const write=f.storage.setItem;f.storage.setItem=()=>{throw Error('quota')}
 await assert.rejects(flow.save(),/quota/);assert.equal(f.calls.includes('business-configuration/apply'),false)
 f.storage.setItem=write
 const gate=deferred<void>();f.setRoute(async(e,r)=>{if(e==='business-configuration/apply')await gate.promise;return f.baseCall(e,r)})
 const first=flow.save(),second=flow.save();assert.equal(first,second);gate.resolve();await first
 assert.equal(f.calls.filter(e=>e==='business-configuration/apply').length,1);assert.equal(f.scopes(),1)
 assert.equal(flow.getSnapshot().phase,'saved');assert.equal(f.journal(),null)
})
test('旧采用的成功回执不能盖当前另一业务草案',async()=>{
 const f=fixture(),flow=f.make();await flow.start();await flow.preview();f.setFail('business-configuration/apply');await assert.rejects(flow.save())
 const oldRequest=JSON.parse(f.journal()!).save.input.requestId
 await flow.start({title:'另一业务'})
 const newDraft=flow.getSnapshot().draft!
 f.receipts.set(oldRequest,{requestId:oldRequest,scope:'sales',version:1,configurationHash:hash})
 await flow.recoverSave()
 assert.equal(flow.getSnapshot().draft,newDraft);assert.equal(flow.getSnapshot().result,null)
 assert.equal(flow.getSnapshot().phase,'ready');assert.equal(f.journal(),null)
})
test('失效预览后若成功回执出现优先回执；草案变化不允许更换令牌',async()=>{
 for(const successful of [true,false]){
  const f=fixture(),flow=f.make();await flow.start();await flow.preview();f.setFail('business-configuration/apply');await assert.rejects(flow.save())
  const saved=f.journal()!,intent=JSON.parse(saved).save,events:string[]=[]
  f.setRoute(async(e,r)=>{
   events.push(e)
   if(e==='business-configuration/apply'){
    if(successful)f.receipts.set(intent.input.requestId,{requestId:intent.input.requestId,scope:'sales',version:1,configurationHash:hash})
    else {const d=f.drafts.get(intent.input.draftId)!;f.drafts.set(d.id,{...d,revision:d.revision+1})}
    throw Object.assign(Error('expired'),{code:'teloa/conflict',details:{reason:'preview-receipt-invalid'}})
   }
   return f.baseCall(e,r)
  })
  if(successful){assert.equal((await f.make().recoverSave()).requestId,intent.input.requestId);assert.equal(f.journal(),null)}
  else{await assert.rejects(f.make().recoverSave(),{code:'teloa/conflict'});assert.equal(f.journal(),saved)}
  assert.equal(events.includes('business-configuration/preview'),false)
 }
})
test('bind回包不能更改预约标题/工作区，草案scope必须属于原预约',async()=>{
 for(const wrong of ['title','workspaceId','scope'] as const){
  const f=fixture();f.setRoute(async(e,r)=>{const value=await f.baseCall(e,r);if(e==='business-conversations/bind'&&wrong!=='scope')return {...value as object,[wrong]:'wrong'};if(e==='business-configuration/draft'&&wrong==='scope')return {...value as BusinessConfigurationDraftResponse,scope:'other',candidate:{...(value as BusinessConfigurationDraftResponse).candidate,scope:'other'}};return value})
  await assert.rejects(f.make().start({scope:'sales',workspaceId:'workspace'}),{code:'teloa/invalid-host-response'})
  assert.deepEqual(f.opened,[]);assert.ok(f.journal())
 }
})
test('采用成功后旧预览不能再次保存',async()=>{
 const f=fixture(),flow=f.make();await flow.start();await flow.preview();await flow.save()
 await assert.rejects(flow.save(),{code:'teloa/conflict'})
 assert.equal(f.calls.filter(e=>e==='business-configuration/apply').length,1)
})
test('创建等待期间原生输入新增附件或未知发送时不抢导航，绑定仍可从服务目录恢复',async()=>{
 for(const changed of ['attachment','unknown'] as const){
  const f=fixture(),flow=f.make();await flow.start()
  const gate=deferred<void>();f.setRoute(async(e,r)=>{if(e==='business-conversations/bind')await gate.promise;return f.baseCall(e,r)})
  const pending=flow.start();await new Promise(resolve=>setImmediate(resolve))
  f.switching.read=()=>({mainSessionId:'session-0',bindingSessionId:'session-0',bindingReady:true,input:{...f.input,attachmentIds:changed==='attachment'?['image' as never]:[]},pendingSubmissions:[],monitor:{getSnapshot:()=>changed==='unknown',check:async()=>{}}})
  gate.resolve();await pending
  assert.deepEqual(f.opened,['session-0']);assert.equal(f.bindings.size,2)
 }
})
test('页面失败保留上次真实投影并标记失效；迟到旧页面不覆盖新revision',async()=>{
 const f=fixture(),flow=f.make();await flow.start()
 const draft=flow.getSnapshot().draft!,objectType={format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:'sales',title:'客户',unit:'位',lead:'客户',sourceId:'records',fields:[{name:'stage',label:'阶段',type:'text',from:'阶段',required:true}]}
 const projection={mode:'preview',scope:'sales',configurationHash:hash,draftId:draft.id,revision:2,page:{kind:'records',definition:{id:'customers',kind:'records',title:'客户',objectType:'customer',fields:['stage'],allowCreate:true,allowEdit:true,allowArchive:true},objectType,emptyState:'no-records'}}
 f.setRoute(async(e,r)=>e==='business-configuration/page'?projection:f.baseCall(e,r))
 const good=await flow.page('customers')
 f.setRoute(async(e,r)=>{if(e==='business-configuration/page')throw Error('invalid new candidate');return f.baseCall(e,r)})
 await assert.rejects(flow.page('customers'));assert.equal(flow.getSnapshot().page,good);assert.equal(flow.getSnapshot().pageStatus,'invalid')
 const gate=deferred<unknown>();f.setRoute(async(e,r)=>e==='business-configuration/page'?gate.promise:f.baseCall(e,r))
 const pending=flow.page('customers');f.drafts.set(draft.id,{...draft,revision:3,hash:'b'.repeat(64)});await flow.refreshDraft()
 const latest=flow.getSnapshot();gate.resolve(projection);await pending
 assert.equal(flow.getSnapshot(),latest);assert.equal(flow.getSnapshot().pageStatus,'idle')
})
test('guard完整检查队列、claim、phase和pendingSubmissions；check期间目标变化不放行',async()=>{
 const f=fixture();await f.make().start()
 const initial=f.switching.read()
 for(const patch of [{queue:[{} as never]},{claim:{} as never},{phase:'claimed' as const},{draft:'未发送'}]){
  f.switching.read=()=>({...initial,input:{...f.input,...patch}})
  assert.equal(await module.checkBusinessBuilderSwitch(f.switching),'draft')
 }
 for(const phase of ['adjudicating','submitting'] as const){
  f.switching.read=()=>({...initial,input:{...f.input,phase}})
  assert.equal(await module.checkBusinessBuilderSwitch(f.switching,true),'pending')
 }
 f.switching.read=()=>({...initial,pendingSubmissions:[{requestId:'pending'}]})
 assert.equal(await module.checkBusinessBuilderSwitch(f.switching,true),'pending')
 let changed=false
 f.switching.read=()=>({...initial,mainSessionId:changed?'another':'session-0',monitor:{getSnapshot:()=>!changed,check:async()=>{changed=true}}})
 assert.equal(await module.checkBusinessBuilderSwitch(f.switching,true),'changed')
})
test('R1 无mainSession时仍核对发送与完整输入，未知归属不能用allowDraft放行',async()=>{
 const cases:Array<Partial<module.BusinessBuilderSwitchSnapshot>>=[
  {pendingSubmissions:[{requestId:'pending'}]},
  {input:undefined},
  {bindingSessionId:'old'},
  ...[{draft:'未发送'}, {attachmentIds:['image' as never]}, {occurrences:[{} as never]}, {queue:[{} as never]}, {claim:{} as never}, {phase:'claimed' as const}, {phase:'adjudicating' as const}, {phase:'submitting' as const}].map(patch=>({input:{draft:'',draftRev:0,phase:'plain' as const,attachmentIds:[],occurrences:[],queue:[],...patch}})),
 ]
 for(const patch of cases){
  const f=fixture()
  f.switching.read=()=>({mainSessionId:undefined,bindingSessionId:undefined,bindingReady:false,input:f.input,pendingSubmissions:[],monitor:undefined,...patch})
  assert.notEqual(await module.checkBusinessBuilderSwitch(f.switching,true),'ready')
  await assert.rejects(f.make().start({allowDraft:true}),{code:'teloa/conflict'})
  assert.equal(f.calls.length,0);assert.equal(f.opened.length,0)
 }
 const f=fixture();f.switching.read=()=>({mainSessionId:undefined,bindingSessionId:undefined,bindingReady:false,input:f.input,pendingSubmissions:[],monitor:undefined})
 assert.equal(await module.checkBusinessBuilderSwitch(f.switching),'ready')
 await f.make().start();assert.equal(f.conversations.size,1)
})
test('R1 reserve等待时A切B且BindingClient.select(B)，迟到预约不能以B为新基线开C',async()=>{
 const f=fixture(),work=new BindingClient(f.port)
 const a=await work.create(),b=await work.create()
 f.port.open(a.sessionId);await work.select(a.sessionId)
 const gate=deferred<void>(),entered=deferred<void>()
 f.setRoute(async(e,r)=>{const result=await f.baseCall(e,r);if(e==='business-conversations/reserve'){entered.resolve();await gate.promise}return result})
 const flow=new module.BusinessBuilderFlow({api:f.api,work,storage:f.storage,journalKey:'owner/builder',id:randomUUID,refreshScopes:async()=>{},switching:f.switching})
 const pending=flow.start({title:'C',workspaceId:'workspace'});await entered.promise
 const requestId=flow.pendingCreation()!.requestId
 f.port.open(b.sessionId);await work.select(b.sessionId)
 const inputB:InputState={...f.input,draft:'B 原稿',attachmentIds:['B-file' as never],queue:[{} as never]},read=f.switching.read
 f.switching.read=()=>({...read(),input:inputB})
 const beforeInput=structuredClone(inputB),before=f.opened.length;gate.resolve();const reservation=await pending
 assert.equal(reservation.requestId,requestId);assert.equal(f.port.current(),b.sessionId)
 assert.equal(f.opened.length,before);assert.equal(f.conversations.size,2);assert.deepEqual(f.switching.read().input,beforeInput)
 assert.equal(flow.pendingCreation()!.requestId,requestId);assert.equal(f.bindings.size,1)
 f.setRoute(f.baseCall);await flow.recoverCreation(undefined,true)
 assert.equal(f.conversations.size,3);assert.equal(f.bindings.size,1)
 assert.equal([...f.conversations.values()].at(-1)!.requestId,requestId);assert.equal(flow.pendingCreation(),null)
})
test('R1 明确就绪且无会话作用域的null输入可首次建业务，undefined或残留状态不能冒充空输入',async()=>{
 const f=fixture()
 let unknown=true,checks=0
 const absent={mainSessionId:undefined,bindingSessionId:undefined,bindingReady:true,input:null,pendingSubmissions:[],monitor:{getSnapshot:()=>unknown,check:async()=>{checks++;unknown=false}}}
 f.switching.read=()=>absent as module.BusinessBuilderSwitchSnapshot
 assert.equal(await module.checkBusinessBuilderSwitch(f.switching),'ready')
 await f.make().start()
 assert.equal(f.conversations.size,1);assert.equal(f.calls.filter(e=>e==='native/create').length,1);assert.equal(checks,1)
 for(const patch of [{input:undefined},{bindingReady:false},{mainSessionId:'old'},{bindingSessionId:'old'},{pendingSubmissions:[{requestId:'pending'}]},{monitor:{getSnapshot:()=>true,check:async()=>{}}}]){
  const g=fixture();g.switching.read=()=>({...absent,...patch}) as module.BusinessBuilderSwitchSnapshot
  assert.notEqual(await module.checkBusinessBuilderSwitch(g.switching,true),'ready')
  await assert.rejects(g.make().start({allowDraft:true}),{code:'teloa/conflict'});assert.equal(g.calls.length,0)
 }
})
