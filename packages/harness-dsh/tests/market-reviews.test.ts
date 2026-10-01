import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import type {AddressInfo} from 'node:net'
import {readFile} from 'node:fs/promises'
import {createMarketReviewsHandler,marketApiBase,marketReviewEndpoints,type MarketCredentialStore} from '../src/market-reviews.ts'
import {createTeloaWorkService} from '../src/teloa-work-service.ts'
import {securityEnvNames} from '../src/launch-env.ts'
import {secretValuesOf} from '../src/credentials/known-values.ts'
import {credentialKey} from '@deepseek-ai/dsh-credentials'

const TOKEN='tmkt_'+'a'.repeat(43)
const own={id:'00000000-0000-4000-8000-000000000009',rating:4,body:'好用',entryVersion:'1.0.1',status:'pending',createdAt:'2026-09-26T00:00:00.000Z',updatedAt:'2026-09-26T00:00:00.000Z'}
const page={entryId:'teloa.soc',count:1,avg:5,claimedBy:null,items:[{id:'00000000-0000-4000-8000-000000000001',nickname:'小明',rating:5,body:'很快',entryVersion:'1.0.1',createdAt:'2026-09-26T00:00:00.000Z',updatedAt:'2026-09-26T00:00:00.000Z',reply:null}],nextCursor:null}
type Seen={method:string;url:string;auth:string|undefined;body:string}

/** 本地桩：模拟 api.market.teloa.ai 的相关接口（形状照 market-worker/src 当前实现）；state 可切换失败、重定向、超大回包与多余字段。 */
async function stub(t:TestContext){
 const seen:Seen[]=[]
 const state={approved:false,fail:false,redirect:false,huge:false,meExtra:false,moderation:'pre' as unknown,startExtra:{} as Record<string,unknown>,summary:{format:'teloa.market-ratings/v1',asOf:'2026-09-26T00:00:00.000Z',entries:[{id:'teloa.soc',count:1,avg:5}]} as unknown}
 const server=createServer((req,res)=>{
  let body=''
  req.on('data',chunk=>{body+=String(chunk)})
  req.on('end',()=>{
   seen.push({method:req.method??'',url:req.url??'',auth:req.headers.authorization,body})
   const send=(status:number,value:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value))}
   if(state.redirect){res.writeHead(302,{Location:'https://evil.example/'});res.end('{}');return}
   if(state.fail)return send(503,{error:'service_unavailable'})
   if(state.huge){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({pad:'x'.repeat(1024*1024+16)}));return}
   const authed=req.headers.authorization==='Bearer '+TOKEN
   if(req.url==='/v1/summary')return send(200,state.summary)
   if(req.url==='/v1/device/start')return send(200,{deviceCode:'d'.repeat(43),userCode:'BCDF-GHJK',verificationUri:'https://market.teloa.ai/account/',expiresIn:600,interval:10,...state.startExtra})
   if(req.url==='/v1/device/token')return send(200,state.approved?{status:'approved',token:TOKEN}:{status:'pending'})
   if(req.url==='/v1/me')return authed?send(200,{account:{id:'00000000-0000-4000-8000-00000000000a',provider:'github',nickname:'小明',githubLogin:'xm',admin:false,createdAt:'2026-09-20T00:00:00.000Z',...(state.meExtra?{email:'x@y.z'}:{})},login:{email:true,github:true},moderation:state.moderation}):send(401,{error:'unauthorized'})
   if(req.url==='/v1/auth/logout')return send(200,{signedOut:true})
   if(req.url==='/v1/entries/teloa.soc/reviews')return send(200,page)
   if(req.url==='/v1/entries/teloa.soc/review'){
    if(!authed)return send(401,{error:'unauthorized'})
    if(req.method==='GET')return send(200,{review:null})
    if(req.method==='PUT'){const input=JSON.parse(body) as {rating:number;body:string};return send(200,{review:{...own,rating:input.rating,body:input.body}})}
    if(req.method==='DELETE')return send(200,{deleted:true})
   }
   send(404,{error:'not_found'})
  })
 })
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',()=>done()))
 t.after(()=>new Promise<void>(done=>server.close(()=>done())))
 const port=(server.address() as AddressInfo).port
 // 回环覆盖只在浏览器验收态生效（TELOA_BROWSER_ACCEPTANCE=1），此处即模拟验收态接本机桩
 return {seen,state,env:{TELOA_MARKET_REMOTE:'on',TELOA_BROWSER_ACCEPTANCE:'1',TELOA_MARKET_API_ENDPOINT:`http://127.0.0.1:${port}`} as NodeJS.ProcessEnv}
}
type MemoryStore=MarketCredentialStore&{value?:string}
function memoryStore():MemoryStore{
 const store:MemoryStore={read:async()=>store.value,write:async value=>{store.value=value},remove:async()=>{delete store.value}}
 return store
}

test('只连 https://api.market.teloa.ai；回环覆盖只在验收态（TELOA_BROWSER_ACCEPTANCE=1）生效且只认回环 http；九个端点；覆盖变量只认启动环境',()=>{
 assert.equal(marketApiBase({}),'https://api.market.teloa.ai')
 assert.equal(marketApiBase({TELOA_BROWSER_ACCEPTANCE:'1',TELOA_MARKET_API_ENDPOINT:'http://127.0.0.1:4000'}),'http://127.0.0.1:4000')
 // 非验收态（生产、开发、CI）一律固定主机，带令牌的请求不会被启动环境引到本机端口
 for(const env of [{},{NODE_ENV:'development'},{CI:'true'},{TELOA_BROWSER_ACCEPTANCE:'0'},{TELOA_BROWSER_ACCEPTANCE:'true'}])assert.equal(marketApiBase({...env,TELOA_MARKET_API_ENDPOINT:'http://127.0.0.1:4000'}),'https://api.market.teloa.ai',JSON.stringify(env))
 for(const value of ['https://evil.example','http://localhost:4000','http://127.0.0.1:4000/v1','http://10.0.0.1:80','http://127.0.0.1:4000@evil.example','https://api.market.teloa.ai.evil.example'])assert.equal(marketApiBase({TELOA_BROWSER_ACCEPTANCE:'1',TELOA_MARKET_API_ENDPOINT:value}),'https://api.market.teloa.ai',value)
 assert.deepEqual([...marketReviewEndpoints].sort(),['market-reviews/account','market-reviews/delete','market-reviews/link-poll','market-reviews/link-start','market-reviews/list','market-reviews/mine','market-reviews/publish','market-reviews/summary','market-reviews/unlink'])
 // 工作区 .env（模型可写）不能把令牌请求引到本机监听端口
 assert.ok((securityEnvNames as readonly string[]).includes('TELOA_MARKET_API_ENDPOINT'))
})

test('在线市场未启用：summary 返回 enabled:false，其余端点拒绝，零请求；验收态只有 on + 回环覆盖同时具备才可用',async t=>{
 const s=await stub(t)
 const {TELOA_MARKET_REMOTE:_on,...noSwitch}=s.env,{TELOA_MARKET_API_ENDPOINT:_endpoint,...noOverride}=s.env
 for(const env of [{...s.env,TELOA_MARKET_REMOTE:'off'},{...s.env,CI:'true'},{...s.env,NODE_ENV:'development'},noSwitch,noOverride,{...noOverride,TELOA_MARKET_API_ENDPOINT:'https://evil.example'}]){
  const store=memoryStore()
  const handle=createMarketReviewsHandler({getEnv:()=>env as NodeJS.ProcessEnv,store,appVersion:'0.2.0'})
  assert.deepEqual(await handle('market-reviews/summary',{}),{enabled:false,asOf:null,entries:[]})
  await assert.rejects(handle('market-reviews/list',{entryId:'teloa.soc'}),{code:'teloa/source-unavailable'})
  await assert.rejects(handle('market-reviews/link-start',{}),{code:'teloa/source-unavailable'})
  store.value=TOKEN
  await assert.rejects(handle('market-reviews/account',{}),{code:'teloa/source-unavailable'})
  await assert.rejects(handle('market-reviews/publish',{entryId:'teloa.soc',rating:5,body:'好'}),{code:'teloa/source-unavailable'})
  assert.equal(store.value,TOKEN)
 }
 assert.equal(s.seen.length,0)
})

test('summary：转换为 {enabled,asOf,entries}，5 分钟内复用；失败或结构不符时 1 分钟内不重试并返回上次结果',async t=>{
 const s=await stub(t);let now=1_000_000
 const handle=createMarketReviewsHandler({getEnv:()=>s.env,store:memoryStore(),appVersion:'0.2.0',now:()=>now})
 const first=await handle('market-reviews/summary',{})
 assert.deepEqual(first,{enabled:true,asOf:'2026-09-26T00:00:00.000Z',entries:[{id:'teloa.soc',count:1,avg:5}]})
 await handle('market-reviews/summary',{});assert.equal(s.seen.length,1)
 now+=6*60_000;s.state.fail=true
 assert.deepEqual(await handle('market-reviews/summary',{}),first)
 await handle('market-reviews/summary',{});assert.equal(s.seen.length,2)
 s.state.fail=false;s.state.summary={format:'teloa.market-ratings/v1',asOf:'bad',entries:[]};now+=2*60_000
 assert.deepEqual(await handle('market-reviews/summary',{}),first)
 s.state.summary={format:'teloa.market-ratings/v1',asOf:'2026-09-26T00:00:00.000Z',entries:[],extra:1};now+=2*60_000
 assert.deepEqual(await handle('market-reviews/summary',{}),first)
 assert.equal(s.seen.length,4)
 await assert.rejects(handle('market-reviews/summary',{extra:1}),{code:'teloa/invalid-input'})
 // 从未成功过：返回启用但为空，不抛错
 const fresh=createMarketReviewsHandler({getEnv:()=>s.env,store:memoryStore(),appVersion:'0.2.0',now:()=>now})
 assert.deepEqual(await fresh('market-reviews/summary',{}),{enabled:true,asOf:null,entries:[]})
})

test('连接：设备码 → 轮询 → 令牌只进凭据存储；发表带 Bearer 与校验后的正文；401 清除本机令牌',async t=>{
 const s=await stub(t),store=memoryStore()
 const handle=createMarketReviewsHandler({getEnv:()=>s.env,store,appVersion:'0.2.0-alpha.7'})
 assert.deepEqual(await handle('market-reviews/account',{}),{linked:false})
 assert.deepEqual(await handle('market-reviews/link-poll',{}),{status:'idle'})
 const started=await handle('market-reviews/link-start',{}) as {userCode:string;verificationUri:string;interval:number}
 assert.equal(started.userCode,'BCDF-GHJK');assert.equal(started.verificationUri,'https://market.teloa.ai/account/?code=BCDF-GHJK');assert.equal(started.interval,10)
 assert.doesNotMatch(JSON.stringify(started),/d{43}/)
 assert.deepEqual(JSON.parse(s.seen.find(row=>row.url==='/v1/device/start')!.body),{label:'Teloa 0.2.0-alpha.7'})
 assert.deepEqual(await handle('market-reviews/link-poll',{}),{status:'pending'})
 assert.deepEqual(JSON.parse(s.seen.at(-1)!.body),{deviceCode:'d'.repeat(43)})
 s.state.approved=true
 const linked=await handle('market-reviews/link-poll',{})
 assert.deepEqual(linked,{status:'linked',nickname:'小明',provider:'github'})
 assert.equal(store.value,TOKEN);assert.doesNotMatch(JSON.stringify(linked),/tmkt_/)
 assert.deepEqual(await handle('market-reviews/link-poll',{}),{status:'idle'})
 const account=await handle('market-reviews/account',{})
 assert.deepEqual(account,{linked:true,nickname:'小明',provider:'github',moderation:'pre'})
 await assert.rejects(handle('market-reviews/link-start',{}),{code:'teloa/conflict'})
 const published=await handle('market-reviews/publish',{entryId:'teloa.soc',rating:4,body:'  上手快 '}) as {review:{status:string;body:string}}
 assert.equal(published.review.status,'pending');assert.equal(published.review.body,'上手快')
 const sent=s.seen.find(row=>row.method==='PUT')!
 assert.equal(sent.auth,'Bearer '+TOKEN);assert.deepEqual(JSON.parse(sent.body),{rating:4,body:'上手快'})
 assert.deepEqual(await handle('market-reviews/mine',{entryId:'teloa.soc'}),{review:null})
 assert.deepEqual(await handle('market-reviews/delete',{entryId:'teloa.soc'}),{deleted:true})
 // 读公开评价不带令牌
 await handle('market-reviews/list',{entryId:'teloa.soc'})
 assert.equal(s.seen.at(-1)!.auth,undefined)
 // 服务端回包多出字段（如邮箱）即拒绝
 s.state.meExtra=true
 await assert.rejects(handle('market-reviews/account',{}),{code:'teloa/invalid-host-response'})
 s.state.meExtra=false
 store.value='tmkt_'+'b'.repeat(43)
 await assert.rejects(handle('market-reviews/mine',{entryId:'teloa.soc'}),{code:'teloa/forbidden'})
 assert.equal(store.value,undefined)
 store.value='tmkt_'+'b'.repeat(43)
 assert.deepEqual(await handle('market-reviews/account',{}),{linked:false})
 assert.equal(store.value,undefined)
})

test('连接直达链接：回包带 verificationUriComplete 且恰为 connect 页加本次用户码才采用；其余取值丢弃该键、仍用账号页旧链接',async t=>{
 const s=await stub(t)
 const start=async(extra:Record<string,unknown>)=>{
  s.state.startExtra=extra
  const handle=createMarketReviewsHandler({getEnv:()=>s.env,store:memoryStore(),appVersion:'0.2.0'})
  return (await handle('market-reviews/link-start',{}) as {verificationUri:string}).verificationUri
 }
 assert.equal(await start({verificationUriComplete:'https://market.teloa.ai/account/connect/?code=BCDF-GHJK'}),'https://market.teloa.ai/account/connect/?code=BCDF-GHJK')
 for(const bad of ['https://market.teloa.ai/account/connect/?code=BCDF-GHJL','http://market.teloa.ai/account/connect/?code=BCDF-GHJK','https://evil.example/account/connect/?code=BCDF-GHJK','https://market.teloa.ai/account/connect/?code=BCDF-GHJK&next=https://evil.example','https://market.teloa.ai/account/connect?code=BCDF-GHJK','https://market.teloa.ai.evil.example/account/connect/?code=BCDF-GHJK','',null,42,{}])
  assert.equal(await start({verificationUriComplete:bad}),'https://market.teloa.ai/account/?code=BCDF-GHJK',JSON.stringify(bad))
 assert.equal(await start({}),'https://market.teloa.ai/account/?code=BCDF-GHJK')
 // 除这一个可选键外，多出其他字段仍按无效回包拒绝
 s.state.startExtra={verificationUriComplete:'https://market.teloa.ai/account/connect/?code=BCDF-GHJK',extra:1}
 await assert.rejects(createMarketReviewsHandler({getEnv:()=>s.env,store:memoryStore(),appVersion:'0.2.0'})('market-reviews/link-start',{}),{code:'teloa/invalid-host-response'})
})

test('账号状态带审核方式：/v1/me 的 moderation 为 post 才是先发后审，其余（含未知值）一律按先审后发，令牌保留',async t=>{
 const s=await stub(t),store=memoryStore()
 store.value=TOKEN
 const handle=createMarketReviewsHandler({getEnv:()=>s.env,store,appVersion:'0.2.0'})
 assert.deepEqual(await handle('market-reviews/account',{}),{linked:true,nickname:'小明',provider:'github',moderation:'pre'})
 s.state.moderation='post'
 assert.deepEqual(await handle('market-reviews/account',{}),{linked:true,nickname:'小明',provider:'github',moderation:'post'})
 for(const bad of ['auto','',null,1]){
  s.state.moderation=bad
  assert.deepEqual(await handle('market-reviews/account',{}),{linked:true,nickname:'小明',provider:'github',moderation:'pre'},JSON.stringify(bad))
 }
 assert.equal(store.value,TOKEN)
})

test('领取令牌后凭据写入失败：尽力作废服务端会话再报存储不可用，不留孤儿会话、本机无令牌',async t=>{
 const s=await stub(t)
 const store:MarketCredentialStore&{value?:string}={read:async()=>undefined,write:async()=>{throw new Error('credentials: modify teloa-market/account locked')},remove:async()=>{}}
 const handle=createMarketReviewsHandler({getEnv:()=>s.env,store,appVersion:'0.2.0'})
 await handle('market-reviews/link-start',{})
 s.state.approved=true
 await assert.rejects(handle('market-reviews/link-poll',{}),(error:{code?:string;message?:string})=>error.code==='teloa/storage-unavailable'&&!error.message!.includes('teloa-market/account'))
 const logout=s.seen.at(-1)!
 assert.equal(logout.url,'/v1/auth/logout');assert.equal(logout.auth,'Bearer '+TOKEN)
 assert.equal(store.value,undefined)
 // 设备码已清，不再重复领取
 assert.deepEqual(await handle('market-reviews/link-poll',{}),{status:'idle'})
 assert.equal(s.seen.at(-1),logout)
})

test('取消连接：link-poll {cancel:true} 清掉设备码并回 idle，之后网页误点允许也不会被领取',async t=>{
 const s=await stub(t),store=memoryStore()
 const handle=createMarketReviewsHandler({getEnv:()=>s.env,store,appVersion:'0.2.0'})
 await handle('market-reviews/link-start',{})
 assert.deepEqual(await handle('market-reviews/link-poll',{cancel:true}),{status:'idle'})
 const before=s.seen.length
 s.state.approved=true
 assert.deepEqual(await handle('market-reviews/link-poll',{}),{status:'idle'})
 assert.equal(s.seen.length,before);assert.equal(store.value,undefined)
 // 没有进行中的连接时取消也是 idle；cancel 只接受 true
 assert.deepEqual(await handle('market-reviews/link-poll',{cancel:true}),{status:'idle'})
 await assert.rejects(handle('market-reviews/link-poll',{cancel:false}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-reviews/link-poll',{cancel:'yes'}),{code:'teloa/invalid-input'})
 assert.equal(s.seen.length,before)
})

test('取消与在途轮询竞态：等待中的 poll 在取消后返回 approved，令牌不落本机并尽力作废，结果为 idle',async t=>{
 const calls:{url:string;auth:string|undefined;body:unknown}[]=[]
 let release!:(value:Response)=>void
 const gate=new Promise<Response>(resolve=>{release=resolve})
 const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}})
 const fakeFetch=(async(url:string,init:RequestInit)=>{
  calls.push({url,auth:(init.headers as Record<string,string>).Authorization,body:init.body?JSON.parse(String(init.body)):undefined})
  if(url.endsWith('/v1/device/start'))return json({deviceCode:'d'.repeat(43),userCode:'BCDF-GHJK',verificationUri:'https://market.teloa.ai/account/',expiresIn:600,interval:10})
  if(url.endsWith('/v1/device/token'))return gate
  if(url.endsWith('/v1/auth/logout'))return json({signedOut:true})
  return json({error:'not_found'})
 }) as unknown as typeof fetch
 const store=memoryStore()
 const handle=createMarketReviewsHandler({getEnv:()=>({TELOA_MARKET_REMOTE:'on',TELOA_BROWSER_ACCEPTANCE:'1',TELOA_MARKET_API_ENDPOINT:'http://127.0.0.1:4000'}),store,appVersion:'0.2.0',fetch:fakeFetch})
 await handle('market-reviews/link-start',{})
 const inflight=handle('market-reviews/link-poll',{})
 await new Promise(resolve=>setTimeout(resolve,10))
 assert.equal(calls.at(-1)!.url,'http://127.0.0.1:4000/v1/device/token')
 assert.deepEqual(await handle('market-reviews/link-poll',{cancel:true}),{status:'idle'})
 release(json({status:'approved',token:TOKEN}))
 assert.deepEqual(await inflight,{status:'idle'})
 assert.equal(store.value,undefined)
 assert.deepEqual(calls.at(-1),{url:'http://127.0.0.1:4000/v1/auth/logout',auth:'Bearer '+TOKEN,body:undefined})
 assert.equal(calls.filter(row=>row.url.endsWith('/v1/me')).length,0)
})

test('断开：先请服务端作废令牌，失败也删除本机记录',async t=>{
 const s=await stub(t),store=memoryStore();store.value=TOKEN
 const handle=createMarketReviewsHandler({getEnv:()=>s.env,store,appVersion:'0.2.0'})
 s.state.fail=true
 assert.deepEqual(await handle('market-reviews/unlink',{}),{linked:false})
 assert.equal(store.value,undefined);assert.equal(s.seen.at(-1)!.url,'/v1/auth/logout');assert.equal(s.seen.at(-1)!.auth,'Bearer '+TOKEN)
})

test('请求严格：未知端点与字段、非法条目 ID、非法评分与游标都在发请求前拒绝；未连接时发表拒绝；重定向与超大回包不接受',async t=>{
 const s=await stub(t),store=memoryStore()
 const handle=createMarketReviewsHandler({getEnv:()=>s.env,store,appVersion:'0.2.0'})
 await assert.rejects(handle('market-reviews/other',{}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-reviews/list',{entryId:'Teloa.SOC'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-reviews/list',{entryId:'teloa.soc',x:1}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-reviews/list',{entryId:'teloa.soc',cursor:'1&x=1'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-reviews/list',null),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-reviews/publish',{entryId:'teloa.soc',rating:6,body:''}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-reviews/publish',{entryId:'teloa.soc',rating:5,body:'好',turnstile:'x'}),{code:'teloa/invalid-input'})
 await assert.rejects(handle('market-reviews/publish',{entryId:'teloa.soc',rating:5,body:'好'}),{code:'teloa/forbidden'})
 await assert.rejects(handle('market-reviews/delete',{entryId:'teloa.soc'}),{code:'teloa/forbidden'})
 await assert.rejects(handle('market-reviews/account',{x:1}),{code:'teloa/invalid-input'})
 assert.equal(s.seen.length,0)
 assert.equal((await handle('market-reviews/list',{entryId:'teloa.soc'}) as {items:unknown[]}).items.length,1)
 s.state.redirect=true
 await assert.rejects(handle('market-reviews/list',{entryId:'teloa.soc'}),{code:'teloa/source-unavailable'})
 s.state.redirect=false;s.state.huge=true
 await assert.rejects(handle('market-reviews/list',{entryId:'teloa.soc'}),{code:'teloa/source-unavailable'})
})

test('出站请求：禁跟随重定向、带超时信号、只发往固定主机',async()=>{
 const calls:{url:string;init:RequestInit}[]=[]
 const fakeFetch=(async(url:string,init:RequestInit)=>{calls.push({url,init});return new Response(JSON.stringify({entryId:'teloa.soc',count:0,avg:null,claimedBy:null,items:[],nextCursor:null}),{status:200})}) as unknown as typeof fetch
 const handle=createMarketReviewsHandler({getEnv:()=>({TELOA_MARKET_REMOTE:'on',TELOA_MARKET_API_ENDPOINT:'https://evil.example'}),store:memoryStore(),appVersion:'0.2.0',fetch:fakeFetch})
 await handle('market-reviews/list',{entryId:'teloa.soc'})
 assert.equal(calls[0]!.url,'https://api.market.teloa.ai/v1/entries/teloa.soc/reviews')
 // 非验收态即使给了回环覆盖也只发往固定主机
 const production=createMarketReviewsHandler({getEnv:()=>({TELOA_MARKET_REMOTE:'on',TELOA_MARKET_API_ENDPOINT:'http://127.0.0.1:4000'}),store:memoryStore(),appVersion:'0.2.0',fetch:fakeFetch})
 await production('market-reviews/list',{entryId:'teloa.soc'})
 assert.equal(calls[1]!.url,'https://api.market.teloa.ai/v1/entries/teloa.soc/reviews')
 assert.equal(calls[0]!.init.redirect,'error')
 assert.ok(calls[0]!.init.signal instanceof AbortSignal)
})

test('凭据存储不可用：连接相关端点报存储不可用，不发请求、不回显内部错误',async t=>{
 const s=await stub(t)
 const broken:MarketCredentialStore={read:async()=>{throw new Error('credentials: modify teloa-market/account locked')},write:async()=>{throw new Error('x')},remove:async()=>{throw new Error('x')}}
 const handle=createMarketReviewsHandler({getEnv:()=>s.env,store:broken,appVersion:'0.2.0'})
 for(const endpoint of ['market-reviews/account','market-reviews/link-start'] as const)
  await assert.rejects(handle(endpoint,{}),(error:{code?:string;message?:string})=>error.code==='teloa/storage-unavailable'&&!error.message!.includes('teloa-market/account'))
 await assert.rejects(handle('market-reviews/publish',{entryId:'teloa.soc',rating:5,body:'好'}),{code:'teloa/storage-unavailable'})
 assert.equal(s.seen.length,0)
})

test('index.ts 接线：市场评价端点只在本人浏览器 /teloa 连接上分发，不进 endpointSet；进程内调用口（IM/插件）一律拒绝；令牌记录键固定',async()=>{
 const calls:string[]=[]
 const work=createTeloaWorkService({owner:'local:teloa-owner',runtimeRoot:'/tmp/x',dispatch:async endpoint=>{calls.push(endpoint)},broadcast:{add:()=>()=>{}} as never,install:async()=>'',attachAllowed:()=>false})
 for(const endpoint of marketReviewEndpoints)await assert.rejects(work.invoke(endpoint,{entryId:'teloa.soc',rating:5,body:'好'},new AbortController().signal),(error:{code?:string})=>error.code==='teloa/forbidden')
 assert.deepEqual(calls,[])
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 // 会话工具（功能验证）另经原生确认卡直接调用处理器；RPC 分发语句只此一处，且在 /teloa 连接处理函数内
 const line='if((marketReviewEndpoints as readonly string[]).includes(endpoint))return {ok:true,value:await marketReviewsHandler(endpoint,payload)}'
 assert.equal(source.split(line).length-1,1)
 const rpc=source.indexOf("connection.rpc.handle('/teloa'"),call=source.indexOf(line),dispatch=source.indexOf('const dispatchTeloaEndpoint=')
 assert.ok(rpc>0&&call>rpc&&call<source.indexOf('ctx.tools.register',rpc))
 // 在 endpointSet 判定之前分发，与凭据存储端点同一位置
 assert.ok(call<source.indexOf('if(!endpointSet.has(endpoint))',rpc))
 assert.ok(!source.slice(dispatch,rpc).includes('marketReview'))
 assert.ok(!/const endpointSet=new Set\([^\n]*marketReview/.test(source))
 assert.match(source,/credentialKey\('teloa-market','account'\)/)
 // 记录按 api-key 保存：已知秘密值集合收录令牌，日志脱敏、贴密钥闸与模型上下文守卫都认得它
 assert.equal(credentialKey('teloa-market','account'),'teloa-market/account')
 assert.deepEqual(secretValuesOf('teloa-market/account',{kind:'api-key',key:TOKEN}),[TOKEN])
 assert.match(source,/modifyRecord\(marketAccountKey,async\(\)=>\(\{kind:'api-key',key:token\}\)\)/)
 // 覆盖地址与开关只取启动环境（trusted），不读 process.env 里的 .env 合入值
 assert.match(source,/createMarketReviewsHandler\(\{getEnv:\(\)=>\(\{CI:process\.env\.CI,NODE_ENV:process\.env\.NODE_ENV,\.\.\.trusted\}\)/)
})
