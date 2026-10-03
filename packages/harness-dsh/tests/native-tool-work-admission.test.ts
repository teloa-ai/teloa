import assert from 'node:assert/strict'
import test from 'node:test'
import {setTimeout as delay} from 'node:timers/promises'
import {symbols,Service} from '@deepseek-ai/cordis'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import type {ToolRunContext,ToolDefinition} from '@deepseek-ai/dsh-tools'
import {toolWorkFixture,deferred,type WorkAdmission,type WorkAdmissionRequest} from './fixtures/native-tool-work-admission.ts'

test('默认Free与官方成功结果保持，未装策略不要求许可',async t=>{
 const f=await toolWorkFixture(t);f.register();const result=await f.tools.execute(f.input())
 assert.equal(result.isError,false);assert.equal(f.bodies(),1);assert.deepEqual(result.content,[{type:'text',text:'完成'}])
})

test('required无provider在pre和body之前拒绝，官方失败通道保留',async t=>{
 const f=await toolWorkFixture(t);f.register();let pre=0,post=0
 f.ctx.on('tools/pre-execute',async(_exec,next)=>{pre++;return next()});f.ctx.on('tools/post-execute',async(_exec,result,next)=>{post++;return next()})
 f.tools.requireWorkAdmission();const result=await f.tools.execute(f.input())
 assert.equal(result.isError,true);assert.match(result.error.message,/policy is required/);assert.equal(f.bodies(),0);assert.equal(pre,0);assert.equal(post,0)
})

test('scoped代理共用单向required和唯一policy，SDK不暴露invoke',async t=>{
 const f=await toolWorkFixture(t);f.register();const scoped=f.ctx.extend({}).tools as typeof f.tools
 const raw=Reflect.get(f.tools,symbols.original)
 const key=Object.getOwnPropertySymbols(raw).find(symbol=>symbol.description==='tool-work-admission-key')!
 assert.ok(key);assert.deepEqual(Object.getOwnPropertyDescriptor(raw,key),{value:raw,writable:false,enumerable:false,configurable:false})
 assert.equal(Reflect.defineProperty(raw,key,{value:{}}),false)
 const derived=Reflect.apply(Reflect.get(raw,Service.extend),raw,[{ctx:f.ctx.extend({})}]) as typeof f.tools
 assert.equal(Reflect.get(derived,key),raw);derived.requireWorkAdmission()
 assert.equal(Reflect.get(scoped,symbols.original),raw);scoped.requireWorkAdmission()
 assert.equal((await f.tools.execute(f.input())).isError,true)
 const kinds:string[]=[];f.tools.installWorkAdmission(r=>{kinds.push(r.kind)})
 assert.throws(()=>scoped.installWorkAdmission(()=>{}),/already installed/)
 assert.throws(()=>scoped.installWorkAdmission(null as unknown as WorkAdmission),/must be a function/)
 assert.equal((f.tools as unknown as {invoke?:unknown}).invoke,undefined)
 assert.equal((await scoped.execute(f.input())).isError,false);assert.deepEqual(kinds,['create','body','body-end'])
})

test('create以原input和SDK已mint同一exec在pre之前调用，private defer/conclude已建立',async t=>{
 const f=await toolWorkFixture(t);f.register();const input=f.input({nested:{value:1}}),context=createUserMessage({content:[{type:'text',text:'真实后续context'}],source:{kind:'user',rpcId:'tool-deferred-fixture'}})
 let minted:ToolRunContext|undefined,pre=0;const kinds:string[]=[]
 f.tools.installWorkAdmission(request=>{
  assert.equal(Object.isFrozen(request),true);kinds.push(request.kind)
  if(request.kind==='create'){assert.equal(request.input,input);minted=request.exec;assert.notEqual(request.exec,input);assert.equal(typeof request.exec.token,'symbol');assert.equal(Object.isFrozen(request.exec.arguments),true);request.exec.deferContext(context);request.exec.concludeTurn();assert.equal(pre,0)}
  else assert.equal(request.exec,minted)
 })
 f.ctx.on('tools/pre-execute',async(exec,next)=>{pre++;assert.equal(exec,minted);return next()})
 const result=await f.tools.execute(input);assert.equal(result.isError,false);assert.deepEqual(result.additionalContexts,[context]);assert.equal(result.concludesTurn,true);assert.deepEqual(kinds,['create','body','body-end'])
})

test('create拒绝沿同一mintedexec最终化，不产生第二execution和body-end',async t=>{
 const f=await toolWorkFixture(t);f.register();let minted:ToolRunContext|undefined,final:ToolRunContext|undefined;const kinds:string[]=[]
 f.tools.installWorkAdmission(r=>{kinds.push(r.kind);if(r.kind==='create'){minted=r.exec;throw Error('create revoked')}})
 f.ctx.on('tools/result',(exec)=>{final=exec as ToolRunContext})
 const result=await f.tools.execute(f.input({value:1}));assert.equal(result.isError,true);assert.match(result.error.message,/create revoked/);assert.equal(final,minted);assert.equal(f.bodies(),0);assert.deepEqual(kinds,['create'])
})

for(const [label,returned] of [['null',null],['boolean',true],['resolvedPromise',()=>Promise.resolve()],['rejectedPromise',()=>Promise.reject(Error('caught async rejection'))]] as const){
 test('create只接受同步undefined：'+label,async t=>{
  const f=await toolWorkFixture(t);f.register();f.tools.installWorkAdmission((()=>typeof returned==='function'?returned():returned) as unknown as WorkAdmission)
  const result=await f.tools.execute(f.input());assert.equal(result.isError,true);assert.match(result.error.message,/synchronously return undefined/);assert.equal(f.bodies(),0);await delay(0)
 })
}

test('body收到同一exec和最终融合signal，after middleware仍立即同步复核',async t=>{
 const f=await toolWorkFixture(t),caller=new AbortController(),wrapper=new AbortController();let minted:ToolRunContext|undefined,bodySignal:AbortSignal|undefined,active=false
 f.register('fixture',async(_args,exec)=>{assert.equal(exec,minted);assert.equal(exec.signal,bodySignal);assert.equal(active,true);return {ok:true}})
 f.ctx.on('tools/execute',async(exec,next)=>{exec.signal=wrapper.signal;return next()})
 f.tools.installWorkAdmission(r=>{if(r.kind==='create')minted=r.exec;else if(r.kind==='body'){assert.equal(r.exec,minted);bodySignal=r.exec.signal;assert.notEqual(bodySignal,wrapper.signal);assert.notEqual(bodySignal,caller.signal);active=true}else {assert.equal(active,true);assert.equal(r.exec.signal,bodySignal);active=false}})
 assert.equal((await f.tools.execute(f.input({},'fixture',caller.signal))).isError,false);assert.equal(active,false)
})

test('later tools/execute await期间撤销，final body guard拒绝且零body',async t=>{
 const f=await toolWorkFixture(t,{patched:process.env.TELOA_TEST_TOOL_ADMISSION_BASELINE!=='1'});f.register()
 const entered=deferred(),release=deferred();let valid=true;const kinds:string[]=[]
 // 普通around只有上游时点：真正后置等待在它之后发生。
 f.ctx.on('tools/execute',async(_exec,next)=>{if(!valid)throw Error('revoked upstream');return next()})
 f.ctx.on('tools/execute',async(_exec,next)=>{entered.resolve();await release.promise;return next()})
 if(typeof f.tools.installWorkAdmission==='function')f.tools.installWorkAdmission(r=>{kinds.push(r.kind);if(r.kind==='body'&&!valid)throw Error('revoked final body')})
 const pending=f.tools.execute(f.input());await entered.promise;valid=false;release.resolve();const result=await pending
 assert.equal(f.bodies(),0);assert.equal(result.isError,true);assert.match(result.error.message,/revoked final body/);assert.deepEqual(kinds,['create','body'])
})

test('工具execute getter撤销先于final assert，零body',async t=>{
 const f=await toolWorkFixture(t);let valid=true,getterReads=0,called=0;const definition=f.register()
 const execute=definition.execute
 Object.defineProperty(definition,'execute',{configurable:true,get(){getterReads++;valid=false;return async function(this:ToolDefinition,args:unknown,exec:ToolRunContext){called++;return Reflect.apply(execute,this,[args,exec])}}})
 f.tools.installWorkAdmission(r=>{if(r.kind==='body'&&!valid)throw Error('getter revoked')})
 const result=await f.tools.execute(f.input());assert.equal(result.isError,true);assert.match(result.error.message,/getter revoked/);assert.equal(getterReads,1);assert.equal(called,0);assert.equal(f.bodies(),0)
})

test('around替换arguments getter在final assert前捕获，授权后不再读取getter',async t=>{
 const f=await toolWorkFixture(t);f.register();let reads=0,valid=true
 f.ctx.on('tools/execute',async(exec,next)=>{Object.defineProperty(exec,'arguments',{configurable:true,get(){reads++;valid=false;return {changed:true}}});return next()})
 f.tools.installWorkAdmission(r=>{if(r.kind==='body'&&!valid)throw Error('arguments getter revoked')})
 const result=await f.tools.execute(f.input());assert.equal(result.isError,true);assert.match(result.error.message,/arguments getter revoked/);assert.equal(f.bodies(),0);assert.equal(reads,1)
})

test('body异步policy拒绝与Promise rejection被接住，不通知未进入body的cleanup',async t=>{
 const f=await toolWorkFixture(t);f.register();const kinds:string[]=[]
 f.tools.installWorkAdmission(((r:WorkAdmissionRequest)=>{kinds.push(r.kind);if(r.kind==='body')return Promise.reject(Error('async deny'))}) as unknown as WorkAdmission)
 const result=await f.tools.execute(f.input());assert.equal(result.isError,true);assert.equal(f.bodies(),0);assert.deepEqual(kinds,['create','body']);await delay(0)
})

for(const outcome of ['success','throw','reject'] as const){
 test('body-end只覆盖真实body并在'+outcome+'后执行，cleanup异常不替换官方结果',async t=>{
  const f=await toolWorkFixture(t);let active=false,ended=0
  f.register('fixture',((_args,_exec)=>{assert.equal(active,true);if(outcome==='throw')throw Error('real sync body error');if(outcome==='reject')return Promise.reject(Error('real async body error'));return Promise.resolve({ok:true})}) as ToolDefinition['execute'])
  f.tools.installWorkAdmission(r=>{if(r.kind==='body')active=true;else if(r.kind==='body-end'){ended++;active=false;throw Error('contained cleanup error')}})
  const result=await f.tools.execute(f.input());assert.equal(active,false);assert.equal(ended,1);assert.equal(f.bodies(),1);assert.equal(result.isError,outcome!=='success');if(result.isError)assert.match(result.error.message,/real (sync|async) body error/)
 })
}

test('异步body-end rejection被接住且保留真实结果',async t=>{
 const f=await toolWorkFixture(t);f.register();let ended=0
 f.tools.installWorkAdmission(((r:WorkAdmissionRequest)=>{if(r.kind==='body-end'){ended++;return Promise.reject(Error('cleanup async'))}}) as unknown as WorkAdmission)
 assert.equal((await f.tools.execute(f.input())).isError,false);assert.equal(ended,1);await delay(0)
})

test('真正body pending时active保持，返回后至post-execute前结束',async t=>{
 const f=await toolWorkFixture(t),entered=deferred(),release=deferred();let active=false,post=0
 f.register('fixture',async()=>{assert.equal(active,true);entered.resolve();await release.promise;assert.equal(active,true);return {ok:true}})
 f.tools.installWorkAdmission(r=>{if(r.kind==='body')active=true;if(r.kind==='body-end')active=false})
 f.ctx.on('tools/post-execute',async(_exec,result,next)=>{post++;assert.equal(active,false);return next()})
 const pending=f.tools.execute(f.input());await entered.promise;assert.equal(active,true);release.resolve();assert.equal((await pending).isError,false);assert.equal(post,1);assert.equal(active,false)
})

test('官方caller取消不启动body与body-end，取消结果保留',async t=>{
 const f=await toolWorkFixture(t);f.register();const abort=new AbortController(),kinds:string[]=[]
 f.tools.installWorkAdmission(r=>{kinds.push(r.kind)});abort.abort();const result=await f.tools.execute(f.input({},'fixture',abort.signal))
 assert.equal(result.isError,true);assert.equal(result.error.info?.code,'ABORTED_BEFORE_DISPATCH');assert.equal(f.bodies(),0);assert.deepEqual(kinds,['create'])
})

test('真实body期间caller取消仍等body静止再cleanup，结果保留ABORTED',async t=>{
 const f=await toolWorkFixture(t),abort=new AbortController(),entered=deferred(),release=deferred();let active=false
 f.register('fixture',async(_args,exec)=>{entered.resolve();await release.promise;assert.equal(active,true);assert.equal(exec.signal.aborted,true);return {ok:true}})
 f.tools.installWorkAdmission(r=>{if(r.kind==='body')active=true;if(r.kind==='body-end')active=false})
 const pending=f.tools.execute(f.input({},'fixture',abort.signal));await entered.promise;abort.abort();assert.equal(active,true);release.resolve();const result=await pending;assert.equal(result.isError,true);assert.equal(result.error.info?.code,'ABORTED');assert.equal(active,false)
})
