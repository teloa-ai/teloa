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
 let saved:string|null=null,setupSaved:string|null=null;const editorRows=new Map<string,string>()
 const storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>={getItem:key=>key.includes('/setup-editor/')?editorRows.get(key)??null:key.endsWith('/setup-apply')?setupSaved:saved,setItem:(key:string,v:string)=>{if(key.includes('/setup-editor/'))editorRows.set(key,v);else if(key.endsWith('/setup-apply'))setupSaved=v;else saved=v},removeItem:key=>{if(key.includes('/setup-editor/'))editorRows.delete(key);else if(key.endsWith('/setup-apply'))setupSaved=null;else saved=null}}
 const bindings=new Map<string,BusinessConversationBinding>(),conversations=new Map<string,Conversation>(),drafts=new Map<string,BusinessConfigurationDraftResponse>(),receipts=new Map<string,BusinessConfigurationApplyResult>()
 const calls:string[]=[],writes:unknown[]=[],opened:string[]=[],input:InputState={draft:'',draftRev:0,phase:'plain',attachmentIds:[],occurrences:[],queue:[]}
 let main:string|undefined,scopes=0,fail:string|undefined
 const call=async(endpoint:string,value:unknown,_signal?:AbortSignal):Promise<unknown>=>{
  const r=value as Record<string,any>;calls.push(endpoint)
  if(endpoint==='business-setup-plan/read')return null
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
  if(endpoint==='business-configuration/discard'){
   const current=drafts.get(r.draftId)!
   const discarded={...current,status:'discarded' as const,revision:r.expectedRevision+1}
   drafts.set(discarded.id,discarded);return discarded
  }
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
 const make=(journalKey='owner/builder')=>new module.BusinessBuilderFlow({api,work:new BindingClient(port),storage,journalKey,id:randomUUID,refreshScopes:async()=>{scopes++;calls.push('scopes')},switching})
 return {make,api,storage,bindings,drafts,receipts,calls,writes,opened,port,conversations,input,switching,setRoute:(f:typeof route)=>route=f,baseCall:call,setFail:(v:string)=>fail=v,scopes:()=>scopes,journal:()=>saved}
}
test('离开草案有三种明确结果，保留不新建会话，继续不导航',async()=>{
 const f=fixture(),flow=f.make();await flow.start({})
 const draftId=flow.getSnapshot().draft!.id,writes=f.writes.length
 const stay=flow.requestLeave();assert.equal(flow.getSnapshot().leaveConfirmation,true);flow.decideLeave('continue');assert.equal(await stay,false)
 const keep=flow.requestLeave();flow.decideLeave('keep');assert.equal(await keep,true);assert.equal(flow.getSnapshot().draft!.id,draftId);assert.equal(f.writes.length,writes)
})
test('等待离开确认时宿主退役或草案revision改变会结算false，旧决定不能导航新绑定',async()=>{
 const f=fixture(),flow=f.make();await flow.start({})
 const pending=flow.requestLeave();flow.leave();assert.equal(await pending,false);assert.equal(flow.getSnapshot().leaveConfirmation,false)
 await flow.restoreSession(flow.getSnapshot().binding!.sessionId!)
 const second=flow.requestLeave(),old=flow.getSnapshot().draft!;f.drafts.set(old.id,{...old,revision:old.revision+1,hash:'b'.repeat(64)});await flow.refreshDraft()
 assert.equal(await second,false);flow.decideLeave('keep');assert.equal(flow.getSnapshot().leaveConfirmation,false)
})
test('离开时明确放弃沿固定revision完成才允许导航，不被自身退役回执当成换草案取消',async()=>{
 const f=fixture(),flow=f.make();await flow.start({});const snapshot=flow.getSnapshot(),pending=flow.requestLeave()
 await flow.discard(snapshot.binding!,snapshot.draft!)
 assert.equal(await pending,true);assert.equal(flow.getSnapshot().draft!.status,'discarded');assert.equal(flow.getSnapshot().leaveConfirmation,false)
})
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
test('预览失效且无成功回执时只重新预览，必须由本人再次采用',async()=>{
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
 const resumed=f.make()
 await assert.rejects(resumed.recoverSave(),{code:'teloa/conflict'})
 assert.deepEqual(attempts,[original])
 assert.deepEqual(events,['business-configuration/receipt','business-configuration/apply','business-configuration/receipt','business-configuration/draft','business-configuration/preview'])
 assert.equal(resumed.getSnapshot().phase,'ready');assert.equal(resumed.getSnapshot().preview?.receipt,'b'.repeat(64));assert.equal(f.journal(),null)
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

test('放弃草案只移除原目录项，失回执可按同修订重试，迟答不覆盖另一草案',async()=>{
 const f=fixture(),flow=f.make(),binding=await flow.start()
 await flow.restoreSession(binding.sessionId!);await flow.refreshDirectory()
 const draft=flow.getSnapshot().draft!
 const hold=deferred<unknown>()
 f.setRoute((endpoint,input,signal)=>endpoint==='business-configuration/discard'?hold.promise:f.baseCall(endpoint,input,signal))
 const operation=flow.discard(binding,draft)
 const other={...binding,requestId:randomUUID(),draftId:randomUUID(),sessionId:'another-session'}
 const next={...draft,id:other.draftId!,candidate:{...draft.candidate,title:'另一草案'}}
 f.bindings.set(other.requestId,other);f.drafts.set(next.id,next)
 await flow.restoreSession(other.sessionId!)
 hold.resolve({...draft,status:'discarded',revision:draft.revision+1})
 await operation
 assert.equal(flow.getSnapshot().draft?.id,next.id)
 assert.equal(flow.getSnapshot().directory?.items.some(item=>item.binding.requestId===binding.requestId),false)
 assert.equal(f.calls.filter(call=>call==='business-configuration/apply').length,0)
 const retry=f.make();await retry.restoreSession(binding.sessionId!)
 f.setRoute(f.baseCall)
 f.setFail('business-configuration/discard')
 await assert.rejects(retry.discard(binding,draft),/lost/)
 assert.equal((await retry.discard(binding,draft)).status,'discarded')
})

test('保存结果未知时不能放弃，必须保留原采用意图',async()=>{
 const f=fixture(),flow=f.make(),binding=await flow.start()
 await flow.restoreSession(binding.sessionId!);await flow.preview()
 const draft=flow.getSnapshot().draft!
 f.setFail('business-configuration/apply')
 await assert.rejects(flow.save(),/lost/)
 await assert.rejects(flow.discard(binding,draft),/核对原保存结果/)
 assert.equal(f.calls.includes('business-configuration/discard'),false)
})

test('同一草案已收到采用回执时，拒绝陈旧目录修订的放弃操作',async()=>{
 const f=fixture(),flow=f.make(),binding=await flow.start()
 await flow.restoreSession(binding.sessionId!);await flow.preview()
 const original=flow.getSnapshot().draft!
 await flow.save()
 await assert.rejects(flow.discard(binding,original),/已采用/)
 assert.equal(f.calls.includes('business-configuration/discard'),false)
})

test('放弃回执与首次目录读取交错时仍显示其他草案，并过滤已退役项',async()=>{
 const f=fixture(),flow=f.make(),a=await flow.start(),draft=flow.getSnapshot().draft!
 const b=await flow.start({title:'另一业务'})
 const discard=deferred<unknown>(),list=deferred<unknown>()
 const directory=await f.baseCall('business-conversations/list',{})
 f.setRoute((e,r,s)=>e==='business-configuration/discard'?discard.promise:e==='business-conversations/list'?list.promise:f.baseCall(e,r,s))
 const retired=flow.discard(a,draft),reading=flow.refreshDirectory()
 discard.resolve({...draft,status:'discarded',revision:draft.revision+1});await retired
 list.resolve(directory);await reading
 assert.deepEqual(flow.getSnapshot().directory?.items.map(i=>i.binding.requestId),[b.requestId])
})

test('切出再返回同一草案后旧放弃回执只更新目录，不改变新展示周期',async()=>{
 const f=fixture(),flow=f.make(),a=await flow.start(),draft=flow.getSnapshot().draft!
 const b=await flow.start({title:'另一业务'});await flow.restoreSession(a.sessionId!)
 const gate=deferred<unknown>();f.setRoute((e,r,s)=>e==='business-configuration/discard'?gate.promise:f.baseCall(e,r,s))
 const retiring=flow.discard(a,draft)
 await flow.restoreSession(b.sessionId!);await flow.restoreSession(a.sessionId!)
 const current=flow.getSnapshot().draft
 gate.resolve({...draft,status:'discarded',revision:draft.revision+1});await retiring
 assert.equal(flow.getSnapshot().draft,current)
 assert.equal(flow.getSnapshot().discardedDraft,undefined)
})

test('尚未绑定会话的预约可按原请求放弃，并清除该预约的本地恢复意图',async()=>{
 const f=fixture(),flow=f.make()
 // 模拟原生创建失败，业务预约及固定请求仍存在。
 f.setRoute((e,r,s)=>{if(e==='business-conversations/bind')throw Error('native bind unavailable');return f.baseCall(e,r,s)})
 await assert.rejects(flow.start(),/unavailable/)
 const binding=[...f.bindings.values()][0]!,draft=f.drafts.get(binding.draftId!)!
 f.setRoute(f.baseCall)
 assert.equal(binding.sessionId,undefined)
 assert.equal((await flow.discard(binding,draft)).status,'discarded')
 assert.equal(flow.pendingCreation(),null)
})

test('手动输入独立持久恢复，固定原revision与来源；额度失败保留内存输入，换本人和草案隔离',async()=>{
 const f=fixture(),flow=f.make();await flow.start({})
 const draft=flow.getSnapshot().draft!,snapshot={draftId:draft.id,revision:0,configurationRevision:draft.revision,configurationHash:draft.hash,candidate:{...draft.candidate,format:'teloa.business-configuration/v2' as const,definitions:[]},description:'原说明',roleEdits:[],employees:[]}
 const value={snapshot,edit:{candidate:{...snapshot.candidate,title:''},description:'尚未保存的输入',roleEdits:[]}}
 flow.writeManualInput(value)
 assert.equal(flow.pendingCreation(),null);assert.equal(flow.pendingSave(),null)
 const restored=f.make();await restored.restoreSession(flow.getSnapshot().binding!.sessionId!)
 assert.deepEqual(restored.readManualInput(snapshot),value)
 const other=f.make('other/builder');await other.restoreSession(flow.getSnapshot().binding!.sessionId!)
 assert.equal(other.readManualInput(snapshot),null)
 const original=f.storage.setItem;f.storage.setItem=()=>{throw Error('quota')}
 value.edit.description='额度失败仍保留当前输入';assert.throws(()=>flow.writeManualInput(value),/quota/);assert.equal(value.edit.description,'额度失败仍保留当前输入')
 f.storage.setItem=original
 await flow.start({});assert.throws(()=>flow.writeManualInput(value),{code:'teloa/conflict'})
})
test('完整方案采用失回包刷新后按原journal读回执，不重发新采用请求',async()=>{
 const f=fixture(),flow=f.make();await flow.start({})
 const draft=flow.getSnapshot().draft!,contentId=randomUUID();let adoption:any=null,plan:any={format:'teloa.business-setup-plan/v1',draftId:draft.id,scope:draft.scope,revision:1,configurationRevision:draft.revision,configurationHash:draft.hash,contentId,contentHash:hash,title:'方案',description:'方案说明',resources:[{id:'work',kind:'work-template',title:'工作分工',version:'1',description:'新增工作模板'}],roleEdits:[],rejected:[],state:'draft',updatedAt:stamp},applications=0
 f.setRoute(async(endpoint,input)=>{const r=input as any
  if(endpoint==='business-setup-plan/read')return plan
  if(endpoint==='business-setup-plan/preview'){plan={...plan,revision:plan.revision+1};return {draftId:draft.id,revision:plan.revision,digest:hash,receipt:hash,configurationReceipt:hash,configurationRevision:draft.revision,baseVersion:0,changes:[],rejected:[],blocked:false}}
  if(endpoint==='business-setup-plan/apply'){applications++;adoption={requestId:r.requestId,configuration:{requestId:r.requestId,scope:draft.scope,version:1,configurationHash:hash},contentId,contentHash:hash,roleIds:[],steps:[]};plan={...plan,state:'applied',adoption};throw Error('lost after commit')}
  if(endpoint==='business-setup-plan/receipt'){assert.equal(r.requestId,adoption.requestId);return adoption}
  return f.baseCall(endpoint,input)
 })
 await flow.refreshSetupPlan();await flow.previewSetup([])
 await assert.rejects(flow.adoptSetup(),/lost after commit/);const intent=flow.pendingSetupSave()!;assert.ok(intent)
 const restored=f.make();await restored.restoreSession(flow.getSnapshot().binding!.sessionId!)
 const result=await restored.adoptSetup(true);assert.equal(result.requestId,intent.input.requestId);assert.equal(applications,1);assert.equal(restored.pendingSetupSave(),null)
})

test('采用确定成功但展示读取失败时保留原journal，可核回执恢复且不重复采用',async()=>{
 const f=fixture(),flow=f.make();await flow.start({});const draft=flow.getSnapshot().draft!,contentId=randomUUID()
 let adoption:any=null,plan:any={format:'teloa.business-setup-plan/v1',draftId:draft.id,scope:draft.scope,revision:1,configurationRevision:draft.revision,configurationHash:draft.hash,contentId,contentHash:hash,title:'方案',description:'方案说明',resources:[{id:'work',kind:'work-template',title:'工作分工',version:'1',description:'新增工作模板'}],roleEdits:[],rejected:[],state:'draft',updatedAt:stamp},applications=0,failRead=false,receiptReads=0
 f.setRoute(async(endpoint,input)=>{const r=input as any
  if(endpoint==='business-setup-plan/read'){if(failRead){failRead=false;throw Error('display unavailable')};return plan}
  if(endpoint==='business-setup-plan/preview'){plan={...plan,revision:plan.revision+1};return {draftId:draft.id,revision:plan.revision,digest:hash,receipt:hash,configurationReceipt:hash,configurationRevision:draft.revision,baseVersion:0,changes:[],rejected:[],blocked:false}}
  if(endpoint==='business-setup-plan/apply'){applications++;adoption={requestId:r.requestId,configuration:{requestId:r.requestId,scope:draft.scope,version:1,configurationHash:hash},contentId,contentHash:hash,roleIds:[],steps:[]};plan={...plan,state:'applied',adoption};failRead=true;return adoption}
  if(endpoint==='business-setup-plan/receipt'){receiptReads++;return adoption}
  return f.baseCall(endpoint,input)
 })
 await flow.refreshSetupPlan();await flow.previewSetup([]);await assert.rejects(flow.adoptSetup(),/display unavailable/)
 assert.ok(flow.pendingSetupSave(),'已成功但展示未完成时仍可沿原请求核对')
 await flow.adoptSetup(true);assert.equal(applications,1);assert.equal(receiptReads,1);assert.equal(flow.getSnapshot().phase,'saved');assert.equal(flow.pendingSetupSave(),null)
})

test('方案采用journal严格拒绝损坏JSON、未知键、无效版本和身份，原日志不删且不apply',async()=>{
 const f=fixture(),flow=f.make();await flow.start({});const draft=flow.getSnapshot().draft!,valid={scope:draft.scope,input:{requestId:randomUUID(),draftId:draft.id,sessionId:flow.getSnapshot().binding!.sessionId!,expectedRevision:1,expectedDigest:hash,previewReceipt:hash}},key='owner/builder/setup-apply'
 for(const value of ['{broken',{...valid,ownerId:'other'},{...valid,input:{...valid.input,extra:true}},{...valid,input:{...valid.input,expectedRevision:0}},{...valid,input:{...valid.input,previewReceipt:'invalid'}},{...valid,input:{...valid.input,draftId:'arbitrary'}}]){
  const raw=typeof value==='string'?value:JSON.stringify(value);f.storage.setItem(key,raw)
  assert.throws(()=>flow.pendingSetupSave(),{code:'teloa/conflict'});await assert.rejects(flow.adoptSetup(true),{code:'teloa/conflict'});assert.equal(f.storage.getItem(key),raw)
 }
 assert.equal(f.calls.includes('business-setup-plan/apply'),false)
})

test('完整方案固定凭证明确过期且无成功回执时只更新预览，须本人再次采用',async()=>{
 const f=fixture(),flow=f.make();await flow.start({});const draft=flow.getSnapshot().draft!,requestId=randomUUID()
 let plan:any={format:'teloa.business-setup-plan/v1',draftId:draft.id,scope:draft.scope,revision:1,configurationRevision:draft.revision,configurationHash:draft.hash,contentId:randomUUID(),contentHash:hash,title:'方案',description:'方案说明',resources:[],roleEdits:[],rejected:[],state:'draft',updatedAt:stamp},applications=0
 f.setRoute(async(endpoint,input)=>{if(endpoint==='business-setup-plan/read')return plan
  if(endpoint==='business-setup-plan/receipt')return null
  if(endpoint==='business-setup-plan/apply'){applications++;throw Object.assign(Error('expired'),{code:'teloa/conflict',details:{reason:'preview-receipt-invalid'}})}
  if(endpoint==='business-setup-plan/preview'){plan={...plan,revision:2};return {draftId:draft.id,revision:2,digest:hash,receipt:hash,configurationReceipt:hash,configurationRevision:draft.revision,baseVersion:0,changes:[],rejected:[],blocked:false}}
  return f.baseCall(endpoint,input)
 })
 await flow.refreshSetupPlan();f.storage.setItem('owner/builder/setup-apply',JSON.stringify({scope:draft.scope,input:{requestId,draftId:draft.id,sessionId:flow.getSnapshot().binding!.sessionId!,expectedRevision:1,expectedDigest:hash,previewReceipt:hash}}))
 await assert.rejects(flow.adoptSetup(true),{code:'teloa/conflict',details:{reason:'preview-review-required'}})
 assert.equal(applications,1);assert.equal(flow.getSnapshot().setupPreview!.revision,2);assert.equal(flow.getSnapshot().setupUnknown,false);assert.equal(flow.pendingSetupSave(),null)
})

test('完整方案原无差异或全部拒绝不写采用journal、不发送apply；新增资源仍可采用',async()=>{
 for(const kind of ['empty','rejected','resources'] as const){
  const f=fixture(),flow=f.make();await flow.start({});const draft=flow.getSnapshot().draft!,contentId=randomUUID();let applications=0
  let plan:any={format:'teloa.business-setup-plan/v1',draftId:draft.id,scope:draft.scope,revision:1,configurationRevision:draft.revision,configurationHash:draft.hash,contentId,contentHash:hash,title:'方案',description:'方案说明',resources:[{id:'configuration',kind:'business-configuration',title:'页面',version:'1',description:'页面'},...(kind==='resources'?[{id:'work',kind:'work-template',title:'核对工作',version:'1',description:'仅准备工作模板'}]:[])],roleEdits:[],rejected:[],state:'draft',updatedAt:stamp}
  f.setRoute(async(endpoint,input)=>{const r=input as any
   if(endpoint==='business-setup-plan/read')return plan
   if(endpoint==='business-setup-plan/preview'){plan={...plan,revision:2};return {draftId:draft.id,revision:2,digest:hash,receipt:hash,configurationReceipt:hash,configurationRevision:draft.revision,baseVersion:0,changes:kind==='rejected'?[{id:'business:title',entity:'business',label:'业务名称',before:'原名',after:'新名'}]:[],rejected:kind==='rejected'?['business:title']:[],blocked:false}}
   if(endpoint==='business-setup-plan/apply'){applications++;const adoption={requestId:r.requestId,configuration:{requestId:r.requestId,scope:draft.scope,version:1,configurationHash:hash},contentId,contentHash:hash,roleIds:[],steps:[]};plan={...plan,state:'applied',adoption};return adoption}
   return f.baseCall(endpoint,input)
  })
  await flow.refreshSetupPlan();await flow.previewSetup([])
  if(kind==='resources'){await flow.adoptSetup();assert.equal(applications,1)}
  else{await assert.rejects(flow.adoptSetup(),{code:'teloa/conflict'});assert.equal(applications,0);assert.equal(flow.pendingSetupSave(),null);assert.equal(flow.getSnapshot().phase,'ready')}
 }
})

test('同原请求确定零写拒绝只读回执与同revision预览后恢复编辑，不泛化清除未知或冲突journal',async()=>{
 for(const kind of ['no-writes','generic','network','version','permission','foreign-request','new-revision','receipt-unavailable'] as const){
  const f=fixture(),flow=f.make();await flow.start({});const draft=flow.getSnapshot().draft!,requestId=randomUUID(),key='owner/builder/setup-apply'
  const plan={format:'teloa.business-setup-plan/v1',draftId:draft.id,scope:draft.scope,revision:1,configurationRevision:draft.revision,configurationHash:draft.hash,contentId:randomUUID(),contentHash:hash,title:'方案',description:'仅方案说明',resources:[{id:'configuration',kind:'business-configuration',title:'页面',version:'1',description:'页面'}],roleEdits:[],rejected:[],state:'draft',updatedAt:stamp}
  const preview={draftId:draft.id,revision:1,digest:hash,receipt:hash,configurationReceipt:hash,configurationRevision:draft.revision,baseVersion:1,changes:[],rejected:[],blocked:false}
  let apply=0,previews=0
  f.setRoute(async(endpoint,input)=>{
   if(endpoint==='business-setup-plan/read')return {...plan,revision:kind==='new-revision'?2:1}
   if(endpoint==='business-setup-plan/receipt'){if(kind==='receipt-unavailable')throw Error('receipt unavailable');return null}
   if(endpoint==='business-setup-plan/preview'){previews++;throw Error('恢复不能通过递增预览改写原版本')}
   if(endpoint==='business-setup-plan/apply'){
    apply++;if(kind==='network')throw Error('network unknown')
    if(kind==='generic')throw Object.assign(Error('所有变更均已拒绝，无需采用。'),{code:'teloa/conflict'})
    if(kind==='version'||kind==='permission')throw Object.assign(Error(kind),{code:kind==='version'?'teloa/version-conflict':'teloa/forbidden'})
    throw Object.assign(Error('no effective changes'),{code:'teloa/conflict',details:{reason:'setup-no-effective-changes',requestId:kind==='foreign-request'?randomUUID():requestId,noWrites:true,preview}})
   }
   return f.baseCall(endpoint,input)
  })
  await flow.refreshSetupPlan();f.storage.setItem(key,JSON.stringify({scope:draft.scope,input:{requestId,draftId:draft.id,sessionId:flow.getSnapshot().binding!.sessionId!,expectedRevision:1,expectedDigest:hash,previewReceipt:hash}}))
  await assert.rejects(flow.adoptSetup(true))
  assert.equal(previews,0,'核对零写回执不能另存一个预览版本')
  if(kind==='no-writes'){assert.equal(flow.pendingSetupSave(),null);assert.equal(flow.getSnapshot().phase,'ready');assert.equal(flow.getSnapshot().setupUnknown,false);assert.equal(flow.getSnapshot().setupPreview!.revision,1);assert.equal(apply,1)}
  else{assert.equal(flow.pendingSetupSave()!.input.requestId,requestId,kind);assert.equal(flow.getSnapshot().phase,'unknown',kind);assert.equal(flow.getSnapshot().setupUnknown,true,kind)}
 }
})

test('保存成功后刷新搭建目录并从「继续搭建」移除已应用草案',async()=>{
 const f=fixture(),flow=f.make()
 await flow.start({});await flow.preview();await flow.refreshDirectory()
 assert.equal(flow.getSnapshot().directory!.items.length,1)
 const listCalls=()=>f.calls.filter(call=>call==='business-conversations/list').length
 f.setRoute(async(endpoint,value)=>{
  const result=await f.baseCall(endpoint,value)
  if(endpoint==='business-configuration/apply'){const draft=[...f.drafts.values()][0]!;f.drafts.set(draft.id,{...draft,status:'applied'})}
  return result
 })
 await flow.save()
 assert.equal(flow.getSnapshot().phase,'saved')
 assert.equal(flow.getSnapshot().directory!.items.some(item=>item.draft?.status==='applied'),false,'保存成功后目录必须刷新并移除已应用草案')
 assert.ok(listCalls()>=2,'保存成功后应重新读取搭建目录')
})
