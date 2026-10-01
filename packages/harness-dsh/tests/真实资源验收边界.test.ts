import test from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {Context} from '@deepseek-ai/cordis'
import {LlmRuntime,createUserMessage} from '@deepseek-ai/dsh-llm'
import {LiveAcceptanceScope,acceptanceFetch,modelAcceptanceFetch,readAcceptanceTags,withLiveAcceptance} from './helpers/live-acceptance.ts'

// 全部传输均为内存替身；不监听端口，不启动数据库或模型进程。
const address=new URL('http://127.0.0.1:49199/')
const scope=()=>new LiveAcceptanceScope(new AbortController().signal)
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}

test('模型传输仅允许精确 origin、路径和方法，并强制禁重定向',async()=>{
 const lifetime=scope(),seen:{url:string;method:string;redirect:RequestRedirect|undefined}[]=[]
 const transport=modelAcceptanceFetch(lifetime,async(input,init)=>{
  seen.push({url:String(input instanceof Request?input.url:input),method:init!.method!,redirect:init?.redirect})
  return Response.json({models:[]})
 },address)
 try{
  await transport(address.origin+'/api/tags',{redirect:'follow'})
  await transport(new Request(address.origin+'/v1/chat/completions',{method:'POST',body:'{}'}))
  assert.deepEqual(seen.map(row=>[row.method,row.redirect]),[['GET','error'],['POST','error']])
  for(const [url,method] of [
   ['http://127.0.0.1:3001/api/tags','GET'],['http://127.0.0.1:3100/api/tags','GET'],['http://127.0.0.1:60154/api/tags','GET'],
   ['http://127.0.0.1:11434/api/tags','GET'],['http://localhost:49199/api/tags','GET'],['https://127.0.0.1:49199/api/tags','GET'],
   ['https://example.invalid/v1/chat/completions','POST'],[address.origin+'/api/tags?x=1','GET'],[address.origin+'/api/tags#x','GET'],
   ['http://user:pass@127.0.0.1:49199/api/tags','GET'],[address.origin+'/v1/models','GET'],[address.origin+'/api/tags/','GET'],
   [address.origin+'/api/tags','POST'],[address.origin+'/v1/chat/completions','GET'],
  ])await assert.rejects(transport(url!,{method:method!}))
  await assert.rejects(transport(new Request(address.origin+'/api/tags',{method:'DELETE'})))
  assert.equal(seen.length,2,'拒绝的请求不能到达传输层')
 }finally{await lifetime.close()}
})

test('隔离模型初始地址拒绝默认服务、远端、查询及用户信息',async()=>{
 const lifetime=scope()
 try{
  for(const url of ['http://127.0.0.1:3001/','http://127.0.0.1:3100/','http://127.0.0.1:60154/','http://127.0.0.1:11434/',
   'http://127.0.0.1/','http://localhost:49199/','https://127.0.0.1:49199/','http://example.invalid:49199/',
   address.origin+'/v1',address.origin+'/?x=1',address.origin+'/#x','http://user@127.0.0.1:49199/']){
   assert.throws(()=>modelAcceptanceFetch(lifetime,async()=>{throw Error('不得传输')},new URL(url)))
  }
 }finally{await lifetime.close()}
})

test('跨源和同机其他端口的 307/308 不可跟随，tags 非成功响应不可作为模型凭据',async()=>{
 const lifetime=scope()
 try{
  for(const target of ['https://example.invalid/','http://127.0.0.1:3001/'])for(const status of [307,308]){
   let followed=false,closed=false
   const transport=modelAcceptanceFetch(lifetime,async(_input,init)=>{
    if(init?.redirect!=='error')followed=true
    // 即使替身不遵守 redirect:error，外层也必须拒绝裸 3xx。
    return new Response(new ReadableStream({cancel(){closed=true}}),{status,headers:{location:target}})
   },address)
   await assert.rejects(transport(address.origin+'/v1/chat/completions',{method:'POST',redirect:'follow',body:'{}'}),/重定向/)
   assert.equal(followed,false)
   assert.equal(closed,true,'拒绝响应前也须释放其正文')
  }
  const failure=modelAcceptanceFetch(lifetime,async()=>Response.json({models:[{name:'qwen3:4b',digest:'伪成功'}]},{status:503}),address)
  await assert.rejects(readAcceptanceTags(lifetime,failure,address),/必须成功/)
  const success=modelAcceptanceFetch(lifetime,async()=>Response.json({models:[{name:'qwen3:4b',digest:'固定摘要'}]}),address)
  assert.deepEqual(await readAcceptanceTags(lifetime,success,address),{models:[{name:'qwen3:4b',digest:'固定摘要'}]})
 }finally{await lifetime.close()}
})

test('下载 fetch 组合测试、Request 与 init 取消信号，并保留操作截止',async()=>{
 for(const cancelled of ['test','request','init','deadline'] as const){
  const parent=new AbortController(),request=new AbortController(),init=new AbortController(),entered=deferred()
  const lifetime=new LiveAcceptanceScope(parent.signal)
  let observed:AbortSignal|undefined
  const transport=acceptanceFetch(lifetime,async(_input,options)=>{
   observed=options!.signal!;entered.resolve()
   return await new Promise<Response>((_resolve,reject)=>observed!.addEventListener('abort',()=>reject(observed!.reason),{once:true}))
  },()=>{},cancelled==='deadline'?10:1000)
  try{
   const work=transport(new Request('https://raw.githubusercontent.com/fixture',{signal:request.signal}),{signal:init.signal})
   const rejected=assert.rejects(work,error=>error instanceof DOMException&&['AbortError','TimeoutError'].includes(error.name))
   await entered.promise
   if(cancelled!=='deadline')({test:parent,request,init}[cancelled]!).abort()
   await rejected
   assert.equal(observed!.aborted,true)
  }finally{await lifetime.close()}
 }
})

test('取消等待主体及其派生操作退出，再恢复共享状态；after 同样等待',async()=>{
 const controller=new AbortController(),entered=deferred(),release=deferred(),childEntered=deferred(),childRelease=deferred()
 const events:string[]=[],hooks:(()=>Promise<void>)[]=[]
 const work=withLiveAcceptance({signal:controller.signal,after:hook=>{hooks.push(hook as ()=>Promise<void>)}},async lifetime=>{
  // 模拟依赖已返回但仍有受跟踪的传输收尾。
  void lifetime.run(1000,async()=>{childEntered.resolve();await childRelease.promise;events.push('传输退出')}).catch(()=>{})
  await lifetime.run(1000,async signal=>{
   entered.resolve();await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))
   await release.promise;events.push('操作退出')
  })
 },()=>{events.push('恢复共享状态')})
 const rejected=assert.rejects(work,{name:'AbortError'})
 await Promise.all([entered.promise,childEntered.promise])
 controller.abort()
 let hookDone=false
 const hook=hooks[0]!().then(()=>{hookDone=true})
 await Promise.resolve();assert.deepEqual(events,[]);assert.equal(hookDone,false)
 release.resolve()
 await new Promise<void>(resolve=>setImmediate(resolve))
 assert.deepEqual(events,['操作退出']);assert.equal(hookDone,false)
 childRelease.resolve();await rejected;await hook
 assert.deepEqual(events,['操作退出','传输退出','恢复共享状态'])
 assert.equal(hookDone,true)
})

test('操作截止及预先取消阻止继续派发，成功和失败均执行清理',async()=>{
 const parent=new AbortController(),lifetime=new LiveAcceptanceScope(parent.signal)
 try{
  await assert.rejects(lifetime.run(10,signal=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))),{name:'TimeoutError'})
  parent.abort();let called=false
  await assert.rejects(lifetime.run(1000,async()=>{called=true}),{name:'AbortError'})
  assert.equal(called,false)
 }finally{await lifetime.close()}
 for(const fail of [false,true]){
  let cleaned=false
  const work=withLiveAcceptance({signal:new AbortController().signal,after:()=>{}},async()=>{if(fail)throw Error('操作失败');return 42},()=>{cleaned=true})
  if(fail)await assert.rejects(work,/操作失败/);else assert.equal(await work,42)
  assert.equal(cleaned,true)
 }
})

test('node:test 真正超时时 after 等待取消收尾，后续测试不与共享状态恢复交错',async()=>{
 const helper=new URL('./helpers/live-acceptance.ts',import.meta.url).href
 const script=`
 import test from 'node:test'; import assert from 'node:assert/strict';
 import {withLiveAcceptance} from ${JSON.stringify(helper)};
 let restored=false;
 test('有意超时',{timeout:30},t=>withLiveAcceptance(t,scope=>scope.run(1000,signal=>new Promise(resolve=>{
  signal.addEventListener('abort',()=>setTimeout(resolve,30),{once:true});
 })),()=>{restored=true;console.log('取消收尾完成')}));
 test('后续状态检查',()=>{assert.equal(restored,true)});
 `
 const childEnv={...process.env};delete childEnv.NODE_TEST_CONTEXT
 const result=await promisify(execFile)(process.execPath,['--test-reporter=tap','--input-type=module','--eval',script],{timeout:10000,env:childEnv}).then(
  value=>({code:0,...value}),error=>({code:error.code,stdout:String(error.stdout),stderr:String(error.stderr)}))
 assert.equal(result.code,1,result.stdout+result.stderr)
 assert.match(result.stdout,/取消收尾完成/)
 assert.match(result.stdout,/ok 2 - 后续状态检查/)
 assert.match(result.stdout,/testTimeoutFailure/)
})

test('官方 pi-ai 适配器经受限全局 fetch 使用内存 SSE，并传递取消至正文读取',async()=>{
 const previous=globalThis.fetch,parent=new AbortController(),lifetime=new LiveAcceptanceScope(parent.signal),ctx=new Context(),seen:string[]=[]
 const entered=deferred()
 let cancelBody=false,bodyClosed=false
 const key='TELOA_ACCEPTANCE_PURE_MODEL_KEY',oldKey=process.env[key]
 process.env[key]='local-acceptance-only'
 try{
  globalThis.fetch=modelAcceptanceFetch(lifetime,async(input,init)=>{
   seen.push(String(input));assert.equal(init?.method,'POST');assert.equal(init?.redirect,'error')
   assert.ok(init?.signal instanceof AbortSignal)
   if(cancelBody)return new Response(new ReadableStream({
    start(){entered.resolve()},
    async cancel(){await new Promise<void>(resolve=>setImmediate(resolve));bodyClosed=true},
   }),{headers:{'content-type':'text/event-stream'}})
   const data=[{choices:[{index:0,delta:{role:'assistant',content:'只读替身'},finish_reason:null}]},{choices:[{index:0,delta:{},finish_reason:'stop'}]}]
   return new Response(data.map(row=>'data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',...row})+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
  },address)
  await ctx.plugin(LlmRuntime)
  const host=createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
  const piAi=await import(pathToFileURL(host.resolve('@deepseek-ai/dsh-llm-pi-ai')).href)
  await ctx.plugin(piAi,{providers:{'review-pure':{apiKeyEnv:key,api:'openai-completions',baseURL:address.origin+'/v1',models:[{id:'fixture',contextWindow:32768,maxTokens:512}]}}})
  let text=''
  await lifetime.run(1000,async signal=>{
   for await(const chunk of ctx.llm.stream({provider:'review-pure',model:'fixture',messages:[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'合成任务'}]})],tools:[],signal}))if(chunk.type==='text-delta')text+=chunk.text
  })
  assert.equal(text,'只读替身');assert.deepEqual(seen,[address.origin+'/v1/chat/completions'])
  cancelBody=true
  const work=lifetime.run(1000,async signal=>{
   for await(const _chunk of ctx.llm.stream({provider:'review-pure',model:'fixture',messages:[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'取消替身'}]})],tools:[],signal})){}
  })
  const rejected=assert.rejects(work)
  await entered.promise;parent.abort();await rejected;await lifetime.close()
  assert.equal(bodyClosed,true,'释放共享状态前必须等待正文取消收尾，不能只等适配器返回')
 }finally{
  await lifetime.close();await ctx.fiber.dispose();globalThis.fetch=previous
  if(oldKey===undefined)delete process.env[key];else process.env[key]=oldKey
 }
})
