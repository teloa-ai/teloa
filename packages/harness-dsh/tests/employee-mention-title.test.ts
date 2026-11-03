import test from 'node:test'
import assert from 'node:assert/strict'
import {employeeMentionReadableTitle,employeeMentionTitleInput,employeeMentionTitlePatches} from '../src/employee-mention-title.ts'
import {applyPatches,findRow} from './fixtures/native-input-composition.ts'
import {Context} from '@deepseek-ai/cordis'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {SessionStore,SessionId,SessionSeq} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {employeeAwareTitleProvider,installEmployeeMentionTitleRecovery,apply,inject} from '../src/employee-mention-title-plugin.ts'

const roleId='c7981988-1b0d-45ba-83d1-28211dedf37b',marker=`[teloa-employee:${roleId}:4]`
const identity={schema:'teloa.employee-mention/v1',boundTo:'current-owner-message',roleId,roleVersion:4,name:'岗位复核员',scopeId:'trusted-scope',state:'active'}
const user=(seq=10,value=marker+'  请说明复核惯例。')=>({seq,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:value}]}})
const context=(value:unknown=identity,kind='runtime-context')=>({seq:11,type:'user/message',data:{source:{kind,form:'snapshot',sections:[{name:'teloa/employee-mention',text:JSON.stringify(value)}]},content:[]}})
const title={title:marker.slice(0,40),messageSeqs:[10],source:{kind:'fallback'}}

test('同一本人原文与宿主冻结姓名修复截断marker，原事件不变',()=>{
 const events=[user(),context(),{seq:14,type:'request/header',data:{}}],before=JSON.stringify(events)
 assert.equal(employeeMentionTitleInput(events,10),'@岗位复核员 请说明复核惯例。')
 assert.equal(employeeMentionReadableTitle(events,title),'@岗位复核员 请说明复核惯例。')
 assert.equal(JSON.stringify(events),before)
 assert.equal(employeeMentionTitleInput([user(10,marker),context()],10),'@岗位复核员')
})
test('本人pin、普通可读LLM标题、缺失或错来源都不改',()=>{
 const events=[user(),context()]
 assert.equal(employeeMentionReadableTitle(events,{...title,source:{kind:'user'}}),undefined)
 assert.equal(employeeMentionReadableTitle(events,{...title,title:'复核惯例'}),undefined)
 assert.equal(employeeMentionTitleInput([user(),context(identity,'user')],10),undefined)
 assert.equal(employeeMentionTitleInput([user()],10),undefined)
 assert.equal(employeeMentionReadableTitle(events,{...title,messageSeqs:[9]}),undefined)
})
test('错员工、版本、绑定、scope、状态和冲突姓名一律不倒填',()=>{
 for(const change of [{roleId:'a7981988-1b0d-45ba-83d1-28211dedf37b'},{roleVersion:5},{boundTo:'other'},{scopeId:''},{state:'deleted'},{name:''}])assert.equal(employeeMentionTitleInput([user(),context({...identity,...change})],10),undefined)
 assert.equal(employeeMentionTitleInput([user(),context(),{...context({...identity,name:'另一姓名'}),seq:12}],10),undefined)
})
test('不得跨本人消息、turn或request header串接另一快照',()=>{
 for(const boundary of [user(11,'另一问题'),{seq:11,type:'turn/start',data:{}},{seq:11,type:'turn/end',data:{}},{seq:11,type:'request/header',data:{}}])assert.equal(employeeMentionTitleInput([user(),boundary,{...context(),seq:12}],10),undefined)
})
test('完整provider marker同样可派生；多员工或伪造marker不匹配',()=>{
 const events=[user(),context()]
 assert.equal(employeeMentionReadableTitle(events,{...title,title:marker+' 说明',source:{kind:'provider'}}),'@岗位复核员 请说明复核惯例。')
 assert.equal(employeeMentionReadableTitle(events,{...title,title:'[teloa-employee:other'}),undefined)
 assert.equal(employeeMentionTitleInput([user(10,marker+' [teloa-employee:a7981988-1b0d-45ba-83d1-28211dedf37b:4]'),context()],10),undefined)
})

const request=(events:unknown[]=[user(),context()])=>({session:{header:{},snapshotEvents:()=>events},messages:[{seq:10,text:marker+' 请说明复核惯例。'}],signal:new AbortController().signal})
test('真实provider装饰保留id/cadence；员工不发模型，普通输入原样委托原实现',async()=>{
 let calls=0,seen:unknown
 const original={id:'official-first',automatic:'first-prompt',generate:async(input:unknown)=>{calls++;seen=input;return {title:'原官方标题',messageSeqs:[10],model:{provider:'native',model:'unchanged'}}}}
 const wrapped=employeeAwareTitleProvider(original as never)
 assert.equal(wrapped.id,original.id);assert.equal(wrapped.automatic,original.automatic)
 assert.deepEqual(await wrapped.generate(request() as never),{title:'@岗位复核员 请说明复核惯例。',messageSeqs:[10]});assert.equal(calls,0)
 const plain=request([user(10,'普通问题')]);const result=await wrapped.generate(plain as never)
 assert.equal(seen,plain);assert.deepEqual(result,{title:'原官方标题',messageSeqs:[10],model:{provider:'native',model:'unchanged'}});assert.equal(calls,1)
 const aborted=request();aborted.signal=AbortSignal.abort()
 await assert.rejects(wrapped.generate(aborted as never));assert.equal(calls,1)
})

test('真实Cordis隔离scope+官方apply只注册一次，不污染父service且不调用模型',async t=>{
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 let registered:Parameters<Context['sessionTitle']['register']>[0]|undefined,modelCalls=0
 const native={register:(provider:Parameters<Context['sessionTitle']['register']>[0])=>{assert.equal(registered,undefined);registered=provider;return async()=>{}},get:()=>undefined,refresh:async()=>undefined}
 ctx.provide('sessionTitle',native);ctx.provide('sessions',{list:()=>[],get:()=>undefined});ctx.provide('llm',{prepareCall:()=>{modelCalls++;throw Error('模型禁止')}})
 await ctx.plugin({apply,inject},{targetWords:5,targetCjkCharacters:10,maxInputBytes:4096,maxOutputTokens:4096,timeoutMs:60000})
 assert.equal(ctx.sessionTitle,native);assert.ok(registered);assert.equal(registered.automatic,'first-prompt')
 assert.deepEqual(await registered.generate(request() as never),{title:'@岗位复核员 请说明复核惯例。',messageSeqs:[10]});assert.equal(modelCalls,0)
})

test('旧标题恢复延后至publication外，user pin/已换session/dispose不调用refresh',async()=>{
 for(const state of ['valid','blank-first','user','replaced','disposed','child','subagent'] as const){
  const listeners=new Map<string,(...args:unknown[])=>void>(),events=state==='blank-first'?[user(1,'\u0000\u202e '),user(),context()]:[user(),context()]
  const session={id:'same',header:state==='child'?{parentSession:'parent'}:state==='subagent'?{origin:'subagent'}:{},snapshotEvents:()=>events};let calls=0,publishing=true
  const ctx={sessions:{list:()=>[],get:()=>state==='replaced'?{}:session},sessionTitle:{get:()=>({...title,source:{kind:state==='user'?'user':'fallback'}}),refresh:async()=>{assert.equal(publishing,false);calls++}},on:(name:string,fn:(...args:unknown[])=>void)=>{listeners.set(name,fn);return()=>listeners.delete(name)},logger:{warn:()=>{}}} as unknown as Context
  const dispose=installEmployeeMentionTitleRecovery(ctx)
  listeners.get('session/created')!(session)
  if(state==='disposed')dispose()
  publishing=false;await Promise.resolve()
  assert.equal(calls,state==='valid'||state==='blank-first'?1:0);dispose();assert.equal(listeners.size,0)
 }
})

test('真实SDK唯一provider注册随社区wrapper卸载清理，可重新注册',async t=>{
 const require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-session-controller'))
 const sdk=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-title')).href)
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 ctx.provide('sessions',{list:()=>[],get:()=>undefined});ctx.provide('sessionProjections',{register:()=>()=>{}});ctx.provide('llm',{})
 await ctx.plugin(sdk.SessionTitleService,{fallbackMaxWords:5,fallbackMaxBytes:40,maxTitleBytes:80})
 const fiber=ctx.plugin({apply,inject},{targetWords:5,targetCjkCharacters:10,maxInputBytes:4096,maxOutputTokens:4096,timeoutMs:60000});await fiber
 assert.equal(typeof ctx.sessionTitle.get,'function')
 const probe={id:sdk.SessionTitleProviderId('probe'),automatic:'first-prompt' as const,generate:async()=>({title:'probe',messageSeqs:[]})}
 assert.throws(()=>ctx.sessionTitle.register(probe),/already registered/)
 await fiber.dispose()
 const dispose=ctx.sessionTitle.register(probe)
 await dispose()
})

test('真实include.applyEntryPatches默认标题disable+insert继承全部配置及条件禁用，不修改来源树',()=>{
 for(const disabled of [undefined,false,{__jsExpr:'ctx.get("feature") !== true'}]){
  const original={id:'session-title-llm',name:'@deepseek-ai/dsh-session-title-first-prompt-llm',config:{targetWords:5,targetCjkCharacters:10,maxInputBytes:4096,maxOutputTokens:4096,timeoutMs:60000},inject:['sessionTitle','sessions','llm'],...(disabled===undefined?{}:{disabled})}
  const rows=[{id:'title-group',group:true,config:[original]}],before=JSON.stringify(rows)
  const patches=employeeMentionTitlePatches(rows),final=applyPatches(rows,patches)
  assert.equal(JSON.stringify(rows),before)
  assert.equal(findRow(final,'session-title-llm')?.disabled,true)
  const expected={...structuredClone(original),id:'teloa-employee-title',name:'@teloa/harness-dsh/employee-mention-title'}
  assert.deepEqual(findRow(final,'teloa-employee-title'),expected)
  assert.equal((findRow(final,'title-group')?.config as {id:string}[]).filter(row=>row.id==='teloa-employee-title').length,1)
 }
})

test('真实include可选all禁用默认标题时保留唯一原provider；无row不增加功能门槛，冲突拒绝',()=>{
 const original={id:'session-title-llm',name:'@deepseek-ai/dsh-session-title-first-prompt-llm',disabled:true,config:{targetWords:5}}
 const optional={id:'optional-session-title-all-prompts',name:'@deepseek-ai/dsh-session-title-all-prompts-llm',config:{targetWords:5}}
 const rows=[original,optional],patches=employeeMentionTitlePatches(rows)
 assert.deepEqual(patches,[]);assert.deepEqual(applyPatches(rows,patches),rows)
 assert.deepEqual(employeeMentionTitlePatches([]),[])
 for(const invalid of [[original,original],[{...original,name:'other'}],[{...original,id:'other'}],[original,{id:'teloa-employee-title',name:'other'}],[original,{id:'other',name:'@teloa/harness-dsh/employee-mention-title'}]])assert.throws(()=>employeeMentionTitlePatches(invalid),/员工标题/)
})

test('真实apply+原生会话标题服务异步恢复已有marker，隔离后仍用捕获service且零模型',async t=>{
 const require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-api-session-controller'))
 const sdk=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-title')).href)
 const ctx=new Context();t.after(()=>ctx.fiber.dispose())
 await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry)
 let models=0
 ctx.provide('llm',{prepareCall:()=>{models++;throw Error('禁止模型')}})
 await ctx.plugin(sdk.SessionTitleService,{fallbackMaxWords:5,fallbackMaxBytes:40,maxTitleBytes:80})
 const seed=[
  {seq:SessionSeq(0),time:1,type:'user/message' as const,surfaceOp:'append' as const,data:createUserMessage({source:{kind:'user',rpcId:'synthetic-title-owner'},content:[{type:'text',text:marker+' 请说明复核惯例。'}]})},
  {seq:SessionSeq(1),time:2,type:'user/message' as const,surfaceOp:'append' as const,data:createUserMessage({source:{kind:'runtime-context',form:'snapshot',sections:[{name:'teloa/employee-mention',text:JSON.stringify(identity)}]},content:[{type:'text',text:'可信员工快照'}]})},
  {seq:SessionSeq(2),time:3,type:'session/title' as const,data:{title:marker.slice(0,40),messageSeqs:[SessionSeq(0)],source:{kind:'fallback' as const}}},
 ]
 const session=ctx.sessions.create(SessionId('synthetic-existing-title'),{seed})
 const native=ctx.sessionTitle
 let refreshes=0
 const refresh=native.refresh.bind(native)
 native.refresh=(...args:Parameters<typeof refresh>)=>{refreshes++;return refresh(...args)}
 await ctx.plugin({apply,inject},{targetWords:5,targetCjkCharacters:10,maxInputBytes:4096,maxOutputTokens:4096,timeoutMs:60000})
 for(let i=0;i<10;i++)await new Promise<void>(resolve=>setImmediate(resolve))
 assert.equal(refreshes,1);assert.equal(models,0)
 const titles=session.snapshotEvents().filter(event=>event.type==='session/title')
 assert.equal(titles.length,2);assert.equal(titles[0]!.data.title,marker.slice(0,40))
 assert.equal(titles[1]!.data.title,'@岗位复核员 请说明复核惯例。');assert.equal(titles[1]!.data.source.kind,'provider')
 assert.deepEqual(titles[1]!.data.messageSeqs,[0])
})

test('恢复持有pending直到原生完成，自身fallback事件与失败不形成自动重试',async()=>{
 const listeners=new Map<string,(...args:unknown[])=>void>(),events=[user(),context()]
 const session={id:'same',header:{},snapshotEvents:()=>events};let calls=0,reject:((error:Error)=>void)|undefined,warnings=0
 const service={get:()=>title,refresh:()=>{calls++;listeners.get('session/event')!(session,{type:'session/title'});return new Promise<never>((_,fail)=>{reject=fail})}}
 const ctx={sessions:{list:()=>[session],get:()=>session},sessionTitle:{register:()=>{}},on:(name:string,fn:(...args:unknown[])=>void)=>{listeners.set(name,fn);return()=>listeners.delete(name)},logger:{warn:()=>{warnings++}}} as unknown as Context
 const dispose=installEmployeeMentionTitleRecovery(ctx,service as never)
 await Promise.resolve();for(let i=0;i<20;i++)listeners.get('session/event')!(session,{type:'session/title'})
 await Promise.resolve();assert.equal(calls,1)
 reject!(Error('synthetic failure'));for(let i=0;i<4;i++)await Promise.resolve()
 listeners.get('session/event')!(session,{type:'session/title'});await Promise.resolve()
 assert.equal(calls,1);assert.equal(warnings,1);dispose()
})
