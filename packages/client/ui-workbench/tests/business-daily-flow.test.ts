import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import type {BusinessConversationBinding,Conversation} from '@teloa/contract'
import type {InputState} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {BindingClient,type WorkPort} from '../src/client/binding-client.ts'
import {BusinessDailyFlow,businessDailyStorageKeys} from '../src/client/business-daily-flow.ts'
import type {HomeWorkContext} from '../src/client/home-native-controller.ts'
import type {BusinessBuilderSwitchPort} from '../src/client/business-builder-flow.ts'
const owner='11111111-1111-4111-8111-111111111111',stamp='2026-09-29T00:00:00.000Z'
const options={scope:'sales',title:'销售工作',workspaceId:'work'}
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes});return {promise,resolve}}
function fixture(){
 const data=new Map<string,string>(),bindings=new Map<string,BusinessConversationBinding>(),conversations=new Map<string,Conversation>(),contexts=new Map<string,HomeWorkContext>()
 const calls:Array<[string,any]>=[],opened:string[]=[]
 let input:InputState={draft:'',draftRev:0,phase:'plain',attachmentIds:[],occurrences:[],queue:[]}
 const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)},removeItem:(key:string)=>{data.delete(key)}}
 let main:string|undefined,current=true,fail:string|undefined,loseAfter=true,unknown=false,pending:readonly {requestId:string}[]=[]
 const respond=async<T>(endpoint:string,r:unknown,run:()=>T):Promise<T>=>{calls.push([endpoint,r]);if(fail===endpoint&&!loseAfter){fail=undefined;throw Error('lost '+endpoint)}const result=run();if(fail===endpoint){fail=undefined;throw Error('lost '+endpoint)}return result}
 const api={
  recentDaily:async(r:{scope:string})=>respond('recent',r,()=>[...bindings.values()].find(b=>b.scope===r.scope&&!b.sessionId)??[...bindings.values()].reverse().find(b=>b.scope===r.scope)??null),
  byRequest:async(r:{requestId:string})=>respond('byRequest',r,()=>bindings.get(r.requestId)??null),
  bySession:async(r:{sessionId:string})=>respond('bySession',r,()=>[...bindings.values()].find(b=>b.sessionId===r.sessionId||conversations.get(b.requestId)?.sessionId===r.sessionId)??null),
  reserve:async(r:any)=>respond('reserve',r,()=>{const b=bindings.get(r.requestId)??{...r,createdAt:stamp,updatedAt:stamp};bindings.set(r.requestId,b);return b}),
  bind:async(r:{requestId:string;sessionId:string})=>respond('bind',r,()=>{const b=bindings.get(r.requestId)!;assert.equal(contexts.get(r.sessionId)?.scopeId,b.scope);const bound={...b,sessionId:r.sessionId};bindings.set(r.requestId,bound);return bound}),
 }
 const contextCall=async(endpoint:string,value:unknown)=>{const r=value as any;return respond(endpoint,r,()=>{
  if(endpoint==='work-context/read')return contexts.get(r.sessionId)??null
  assert.equal(endpoint,'work-context/set');const old=contexts.get(r.sessionId);if(old)return old
  const next={sessionId:r.sessionId,scopeId:r.scopeId,roleId:r.roleId,version:r.expectedVersion+1,locked:false};contexts.set(r.sessionId,next);return next
 })}
 const port:WorkPort={list:async()=>[...conversations.values()],read:async id=>[...conversations.values()].find(c=>c.sessionId===id)!,ensure:async id=>[...conversations.values()].find(c=>c.sessionId===id)!,isNativeChild:()=>false,catalog:async()=>{throw Error('unused')},block:()=>{},current:()=>main,open:id=>{main=id;opened.push(id)},adopt:async id=>id,create:async r=>respond('native/create',r,()=>{
  const c=conversations.get(r.requestId)??{id:'work-'+conversations.size,ownerId:owner,title:r.title!,version:1,status:'ready' as const,sessionId:'session-'+conversations.size,requestedSessionId:'session-'+conversations.size,requestId:r.requestId,scopeIds:['general'],createdAt:stamp,...(r.workspaceId?{requestedWorkspaceId:r.workspaceId}:{})};conversations.set(r.requestId,c);return c
 })}
 const switching:BusinessBuilderSwitchPort={read:()=>({mainSessionId:main,bindingSessionId:main,bindingReady:true,input,pendingSubmissions:pending,monitor:{getSnapshot:()=>unknown,check:async()=>{calls.push(['monitor/check',null])}}})}
 let contextRoute=contextCall
 const work=new BindingClient(port),make=()=>new BusinessDailyFlow({api,work,storage,personalSpaceId:owner,id:randomUUID,contextCall:(...args)=>contextRoute(...args),switching,mayOpen:()=>current})
 return {make,api,port,work,storage,data,bindings,conversations,contexts,calls,opened,get input(){return input},setInput:(patch:Partial<InputState>)=>{input={...input,...patch}},switching,contextCall,setContextRoute:(route:typeof contextCall)=>{contextRoute=route},setMain:(id:string|undefined)=>{main=id},setCurrent:(v:boolean)=>{current=v},setUnknown:(v:boolean)=>{unknown=v},setPending:(v:readonly {requestId:string}[])=>{pending=v},fail:(endpoint:string,after=true)=>{fail=endpoint;loseAfter=after}}
}
test('daily先持久化原请求，context与绑定完成才打开；默认复用最近，明确新建才第二条',async()=>{
 const f=fixture(),flow=f.make(),first=await flow.open(options)
 assert.equal(first!.kind,'daily');assert.equal(f.conversations.size,1)
 assert.ok(f.calls.findIndex(c=>c[0]==='work-context/set')<f.calls.findIndex(c=>c[0]==='bind'))
 const request=f.calls.find(c=>c[0]==='reserve')![1]
 assert.equal(f.calls.find(c=>c[0]==='native/create')![1].requestId,request.requestId)
 assert.equal(f.calls.find(c=>c[0]==='work-context/set')![1].requestId,request.requestId)
 assert.deepEqual(f.opened,[first!.sessionId]);assert.equal(f.data.size,0)
 assert.equal((await flow.open(options))!.sessionId,first!.sessionId);assert.equal(f.conversations.size,1)
 await flow.open({...options,newConversation:true});assert.equal(f.conversations.size,2)
})
test('各副作用丢响应后实例重建仍同预约、原生session和context请求',async()=>{
 for(const endpoint of ['reserve','native/create','work-context/set','bind']){
  const f=fixture();f.fail(endpoint)
  await assert.rejects(f.make().open(options),/lost/)
  const fixed=[...f.bindings.keys()][0]!,restored=f.make()
  await restored.recover()
  assert.equal(f.bindings.size,1);assert.equal(f.conversations.size,1);assert.equal(f.contexts.size,1)
  assert.equal(f.calls.find(c=>c[0]==='native/create')![1].requestId,fixed)
  assert.ok(f.calls.filter(c=>c[0]==='work-context/set').every(c=>c[1].requestId===fixed))
  assert.equal(f.opened.length,1);assert.equal(f.data.size,0)
 }
})
test('无本地日志server pending显式恢复；明确新建也不绕过，原title/workspace固定',async()=>{
 const f=fixture();f.fail('work-context/set',false);await assert.rejects(f.make().open(options))
 const saved=[...f.bindings.values()][0]!;f.data.clear()
 const restored=f.make();await restored.open({...options,title:'当前标题',newConversation:true})
 assert.equal(restored.getSnapshot().phase,'pending');assert.equal(f.conversations.size,1);assert.equal(f.opened.length,0)
 await restored.recover()
 assert.equal(f.conversations.size,1);assert.equal(f.opened.length,1)
 assert.ok(f.calls.filter(c=>c[0]==='native/create').every(c=>c[1].requestId===saved.requestId&&c[1].title===saved.title&&c[1].workspaceId===saved.workspaceId))
 assert.ok(f.calls.filter(c=>c[0]==='work-context/set').every(c=>c[1].requestId===saved.requestId))
})
test('同scope已locked或有role不覆盖；其它scope拒绝并保留固定恢复意图',async()=>{
 for(const scope of ['sales','other']){
  const f=fixture();f.fail('work-context/set',false);await assert.rejects(f.make().open(options))
  f.contexts.set('session-0',{sessionId:'session-0',scopeId:scope,roleId:'role',version:4,locked:true})
  const before=f.calls.filter(c=>c[0]==='work-context/set').length
  if(scope==='sales')await f.make().recover();else await assert.rejects(f.make().recover())
  assert.equal(f.calls.filter(c=>c[0]==='work-context/set').length,before);assert.equal(f.contexts.get('session-0')!.roleId,'role')
  assert.equal(f.opened.length,scope==='sales'?1:0)
 }
})
test('namespace、空/坏日志、未知键及写后丢失均拒绝，不能发副作用',async()=>{
 const keys=businessDailyStorageKeys(owner)
 for(const raw of ['', '{}','null','{"schema":"wrong"}']){
  const f=fixture();f.data.set(keys.intent,raw);await assert.rejects(f.make().open(options));assert.equal(f.calls.length,0)
 }
 const f=fixture();f.storage.setItem=()=>{};await assert.rejects(f.make().open(options));assert.ok(!f.calls.some(c=>c[0]==='reserve'||c[0]==='native/create'))
 assert.throws(()=>businessDailyStorageKeys('anonymous'));assert.throws(()=>businessDailyStorageKeys(''))
})
test('context空/坏/非本请求日志不被既有helper当成无pending，写失败不发set',async()=>{
 for(const raw of ['', '{}',JSON.stringify({requestId:randomUUID(),sessionId:'session-0',scopeId:'sales',roleId:null,expectedVersion:0}),JSON.stringify({requestId:'bad',extra:true})]){
  const f=fixture();f.fail('native/create');await assert.rejects(f.make().open(options));const request=[...f.bindings.keys()][0]!
  f.data.set(businessDailyStorageKeys(owner).context(request),raw)
  await assert.rejects(f.make().recover());assert.equal(f.calls.filter(c=>c[0]==='work-context/set').length,0);assert.equal(f.opened.length,0)
 }
 const f=fixture(),set=f.storage.setItem;f.storage.setItem=(key,value)=>{if(!key.includes('/context/'))set(key,value)}
 await assert.rejects(f.make().open(options));assert.equal(f.calls.filter(c=>c[0]==='work-context/set').length,0)
})
test('recent失败不当null；unknown发送由既有monitor.check核对，附件/队列/在途不切走',async()=>{
 const f=fixture();f.fail('recent',false);await assert.rejects(f.make().open(options));assert.equal(f.bindings.size,0)
 const g=fixture();g.setUnknown(true);await assert.rejects(g.make().open(options));assert.ok(g.calls.some(c=>c[0]==='monitor/check'));assert.equal(g.bindings.size,0)
 for(const mutation of [(f:ReturnType<typeof fixture>)=>f.setInput({attachmentIds:['file' as InputState['attachmentIds'][number]]}),(f:ReturnType<typeof fixture>)=>{f.setInput({draft:'原稿'})},(f:ReturnType<typeof fixture>)=>f.setPending([{requestId:'pending'}])]){
  const h=fixture();mutation(h);await assert.rejects(h.make().open(options));assert.equal(h.bindings.size,0)
 }
})
test('在途重复点击共享结果；reserve期间切目标不创建/打开并保留原预约',async()=>{
 const f=fixture(),gate=deferred<BusinessConversationBinding>(),reserve=f.api.reserve
 f.api.reserve=async r=>{const b=await reserve(r);await gate.promise;return b}
 const flow=f.make(),a=flow.open(options),b=flow.open(options)
 await new Promise(resolve=>setImmediate(resolve));f.setMain('other');await f.work.select(undefined)
 gate.resolve([...f.bindings.values()][0]!);await Promise.all([a,b])
 assert.equal(f.calls.filter(c=>c[0]==='reserve').length,1);assert.equal(f.conversations.size,0);assert.equal(f.opened.length,0)
 assert.ok(f.data.has(businessDailyStorageKeys(owner).intent))
})
test('native在途本人或导航变化保留原预约而不继续context；新增原稿不抢导航',async()=>{
 for(const change of ['owner','main','draft']){
  const f=fixture(),gate=deferred<string>(),adopt=f.port.adopt
  f.port.adopt=async(id,workspace)=>{await gate.promise;return adopt(id,workspace)}
  const flow=f.make(),opening=flow.open(options);await new Promise(resolve=>setImmediate(resolve))
  if(change==='owner'){f.setCurrent(false);flow.leave()}else if(change==='main')f.setMain('other');else f.setInput({draft:'新原稿'})
  gate.resolve('go');if(change==='draft')await opening;else await assert.rejects(opening)
  assert.equal(f.opened.length,0);assert.ok(f.data.has(businessDailyStorageKeys(owner).intent))
  if(change!=='draft')assert.equal(f.calls.filter(c=>c[0]==='work-context/set'||c[0]==='bind').length,0)
 }
})
test('byRequest/read context在途失去本人代次后不继续预约或设置业务',async()=>{
 for(const stage of ['request','context']){
  const f=fixture(),gate=deferred<void>(),flow=f.make()
  if(stage==='request'){const read=f.api.byRequest;f.api.byRequest=async r=>{await gate.promise;return read(r)}}
  else f.setContextRoute(async(e,r)=>{const value=await f.contextCall(e,r);await gate.promise;return value})
  const pending=flow.open(options);await new Promise(resolve=>setImmediate(resolve));f.setCurrent(false);flow.leave();gate.resolve()
  await assert.rejects(pending)
  assert.equal(f.calls.filter(c=>c[0]==='work-context/set'||c[0]==='bind').length,0)
  if(stage==='request')assert.equal(f.bindings.size,0)
 }
})
test('已绑定最近会话再次核context；缺失或跨scope不能新建、重写或打开',async()=>{
 for(const value of [null,{sessionId:'session-0',scopeId:'other',roleId:null,version:1,locked:false}]){
  const f=fixture();await f.make().open(options);const opened=f.opened.length,before=f.calls.filter(c=>c[0]==='work-context/set').length
  if(value===null)f.contexts.clear();else f.contexts.set('session-0',value)
  await assert.rejects(f.make().open(options))
  assert.equal(f.opened.length,opened);assert.equal(f.conversations.size,1);assert.equal(f.calls.filter(c=>c[0]==='work-context/set').length,before)
 }
})
test('已绑定open在native read/adopt期间导航变化或新增附件不抢开',async()=>{
 for(const stage of ['read','adopt'])for(const change of ['main','attachment']){
  const f=fixture();await f.make().open(options);const gate=deferred<void>(),count=f.opened.length
  if(stage==='read'){const read=f.port.read;f.port.read=async id=>{await gate.promise;return read(id)}}
  else {const adopt=f.port.adopt;f.port.adopt=async(id,workspace)=>{await gate.promise;return adopt(id,workspace)}}
  const pending=f.make().open(options);await new Promise(resolve=>setImmediate(resolve))
  if(change==='main')f.setMain('other');else f.setInput({attachmentIds:['late-file' as InputState['attachmentIds'][number]]})
  gate.resolve();await pending
  assert.equal(f.opened.length,count);assert.equal(f.conversations.size,1)
  if(change==='attachment')assert.deepEqual(f.input.attachmentIds,['late-file'])
 }
})
test('fixed intent冲突不换ID；context只清自己key，损坏日志也拒未知键',async()=>{
 const f=fixture();f.fail('native/create');await assert.rejects(f.make().open(options));const request=[...f.bindings.keys()][0]!,before=f.calls.length
 for(const changed of [{...options,scope:'other'},{...options,title:'改名'},{...options,workspaceId:'else'}])await assert.rejects(f.make().open(changed))
 assert.equal(f.calls.length,before)
 const other=businessDailyStorageKeys('22222222-2222-4222-8222-222222222222').context(request)
 f.data.set(other,'foreign bytes');await f.make().recover();assert.equal(f.data.get(other),'foreign bytes')
 const g=fixture();g.fail('native/create');await assert.rejects(g.make().open(options));const id=[...g.bindings.keys()][0]!
 g.data.set(businessDailyStorageKeys(owner).context(id),JSON.stringify({requestId:id,sessionId:'session-0',scopeId:'sales',roleId:null,expectedVersion:0,extra:true}))
 await assert.rejects(g.make().recover());assert.equal(g.opened.length,0)
})
test('全局inspect只识别pending，不设置context或打开；显式恢复原预约后返回同session',async()=>{
 const f=fixture();f.fail('work-context/set',false);await assert.rejects(f.make().open(options));f.data.clear()
 const flow=f.make(),before=f.calls.length
 const pending=await flow.inspectSession('session-0')
 assert.equal(pending!.sessionId,undefined);assert.equal(flow.getSnapshot().phase,'pending')
 assert.deepEqual(f.calls.slice(before).map(c=>c[0]),['bySession'])
 await flow.recover();assert.deepEqual(f.opened,['session-0'])
 const bound=await flow.inspectSession('session-0');assert.equal(bound!.sessionId,'session-0')
 f.fail('bySession',false);await assert.rejects(flow.inspectSession('session-0'));assert.equal(flow.getSnapshot().phase,'error');assert.equal(flow.getSnapshot().binding,null)
})
test('明确确认保留原InputState可打开daily，未知发送/在途仍拒绝',async()=>{
 const f=fixture();f.setMain('original');f.setInput({draft:'原稿',attachmentIds:['file' as InputState['attachmentIds'][number]]})
 const original=f.input
 await assert.rejects(f.make().open(options));await f.make().open({...options,allowDraft:true})
 assert.equal(f.input,original);assert.equal(f.input.draft,'原稿');assert.deepEqual(f.input.attachmentIds,['file'])
 assert.equal(f.conversations.size,1);assert.equal(f.calls.some(c=>c[0].includes('submit')),false)
 for(const status of ['unknown','pending','submitting']){
  const g=fixture();g.setMain('original');g.setInput({draft:'原稿'})
  if(status==='unknown')g.setUnknown(true);else if(status==='pending')g.setPending([{requestId:'pending'}]);else g.setInput({phase:'submitting'} as Partial<InputState>)
  await assert.rejects(g.make().open({...options,allowDraft:true}));assert.equal(g.conversations.size,0)
 }
})
test('确认后InputState更新或导航变化不再沿用旧确认；recover也须重新明确确认',async()=>{
 for(const change of ['input','main']){
  const f=fixture();f.setMain('original');f.setInput({draft:'原稿'})
  const gate=deferred<string>(),adopt=f.port.adopt;f.port.adopt=async(id,workspace)=>{await gate.promise;return adopt(id,workspace)}
  const opening=f.make().open({...options,allowDraft:true});await new Promise(resolve=>setImmediate(resolve))
  if(change==='input')f.setInput({draft:'新原稿',draftRev:1});else f.setMain('other')
  gate.resolve('go');if(change==='main')await assert.rejects(opening);else await opening
  assert.equal(f.opened.length,0);assert.ok(f.data.has(businessDailyStorageKeys(owner).intent))
 }
 const f=fixture();f.setMain('original');f.setInput({draft:'原稿'});f.fail('bind')
 await assert.rejects(f.make().open({...options,allowDraft:true}))
 await assert.rejects(f.make().recover());await f.make().recover(undefined,true)
 assert.equal(f.opened.length,1);assert.equal(f.input.draft,'原稿');assert.equal(f.conversations.size,1)
})
test('切换拒绝提供结构化reason，原确认入口无需重新猜输入状态',async()=>{
 for(const reason of ['draft','unknown','pending','binding']){
  const f=fixture()
  if(reason==='draft'){f.setMain('original');f.setInput({draft:'未发'})}
  else if(reason==='unknown')f.setUnknown(true)
  else if(reason==='pending')f.setPending([{requestId:'pending'}])
  else f.switching.read=()=>({mainSessionId:undefined,bindingSessionId:undefined,bindingReady:false,input:undefined,pendingSubmissions:[],monitor:undefined})
  await assert.rejects(f.make().open(options),(error:any)=>error.code==='teloa/conflict'&&error.details?.reason===reason)
  assert.equal(f.conversations.size,0)
 }
})
test('当前同session的已核实daily可带原稿继续；真正另建或跨业务仍需确认',async()=>{
 const f=fixture(),flow=f.make(),bound=await flow.open(options)
 f.setInput({draft:'当前业务原稿',attachmentIds:['file' as InputState['attachmentIds'][number]]})
 const original=f.input,sets=f.calls.filter(c=>c[0]==='work-context/set').length
 assert.equal((await flow.open(options)).sessionId,bound.sessionId)
 assert.equal(f.input,original);assert.equal(f.conversations.size,1);assert.equal(f.calls.filter(c=>c[0]==='work-context/set').length,sets)
 await assert.rejects(flow.open({...options,newConversation:true}),(e:any)=>e.details?.reason==='draft')
 await assert.rejects(flow.open({...options,scope:'other'}),(e:any)=>e.details?.reason==='draft')
 f.contexts.set(bound.sessionId!,{sessionId:bound.sessionId!,scopeId:'other',roleId:null,version:1,locked:false})
 await assert.rejects(flow.open(options));assert.equal(f.conversations.size,1)
})
