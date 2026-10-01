import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,type MarketCatalogSkillSecret} from '@teloa/contract'
import type {Context} from '@deepseek-ai/cordis'
import type {PreToolDecision,ToolExecution} from '@deepseek-ai/dsh-tools'
import {registerSkillHttpTool,runSkillHttp,skillHttpConfirmReason,type SkillHttpPorts} from '../src/skill-http-tool.ts'

const rand=(n:number)=>Array.from({length:n},()=>'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random()*36)]).join('')
const key='xai'+'-'+rand(24)
const secret:MarketCatalogSkillSecret={envVarName:'XAI_API_KEY',label:{'zh-CN':'xAI API 密钥',en:'xAI API key'},required:true,target:'bearer',endpoints:[{origin:'https://api.x.ai',pathPrefixes:['/v1/']}],methods:['GET','POST']}
type Call={url:string;init:{method:string;headers:Record<string,string>;body?:string}}
function ports(over:Partial<SkillHttpPorts>={},stored:Record<string,string>={XAI_API_KEY:key}){
 const calls:Call[]=[],audit:unknown[]=[]
 const p:SkillHttpPorts={
  skillVisible:async()=>true,
  readForUse:async()=>({secrets:[secret],values:{...stored},stale:false}),
  allow:()=>true,
  webPolicy:async()=>({version:1,enabled:true,blocked:[]}),
  resolve:async()=>[{address:'104.18.32.1',family:4}],
  request:async(url,init)=>{calls.push({url:url.toString(),init});return new Response(JSON.stringify({echo:init.headers.authorization}),{status:200,headers:{'content-type':'application/json'}})},
  audit:event=>audit.push(event),
  ...over,
 }
 return {p,calls,audit}
}
const run=(p:SkillHttpPorts,args:unknown,sessionId='s-1')=>runSkillHttp(p,args,AbortSignal.timeout(5000),{sessionId}).then(text=>JSON.parse(text))

test('注入 bearer 到声明地址；回显正文被脱敏；审计无值且字段白名单',async()=>{
 const {p,calls,audit}=ports()
 const out=await run(p,{skill:'x-search',method:'POST',url:'https://api.x.ai/v1/responses',headers:'Content-Type: application/json',body:'{"q":"hi"}'})
 assert.equal(calls[0]!.init.headers.authorization,`Bearer ${key}`)
 assert.equal(out.status,200);assert.match(out.body,/\[已隐藏\]/)
 assert.doesNotMatch(JSON.stringify(out),new RegExp(key.slice(4,12)))
 assert.doesNotMatch(JSON.stringify(audit),new RegExp(key.slice(4,12)))
 assert.deepEqual(Object.keys(audit[0] as object).sort(),['bytes','envVarNames','event','method','origin','pathPrefix','redacted','sessionId','skill','status'])
 assert.deepEqual(Object.keys(out).sort(),['body','contentType','status','truncated'])
})

test('未声明 origin、前缀外路径、%2F、http、账号、端口、未声明方法、凭据头、未知参数：不发请求且 deny 带原因码',async()=>{
 const {p,calls,audit}=ports()
 const cases:[unknown,RegExp,string][]=[
  [{skill:'x-search',method:'GET',url:'https://evil.example/v1/x'},/目标地址/,'endpoint'],
  [{skill:'x-search',method:'GET',url:'https://api.x.ai/v2/x'},/目标地址/,'endpoint'],
  [{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/%2Fx'},/目标地址/,'endpoint'],
  [{skill:'x-search',method:'GET',url:'http://api.x.ai/v1/x'},/https/,'input'],
  [{skill:'x-search',method:'GET',url:'https://user:pw@api.x.ai/v1/x'},/https/,'input'],
  [{skill:'x-search',method:'GET',url:'https://api.x.ai:8443/v1/x'},/https/,'input'],
  [{skill:'x-search',method:'DELETE',url:'https://api.x.ai/v1/x'},/方法 DELETE/,'method'],
  [{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x',headers:'Authorization: Bearer x'},/不允许/,'input'],
  [{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x',apiKey:'k'},/只允许/,'input'],
 ]
 for(const [args,message,reason] of cases){
  await assert.rejects(run(p,args),message,JSON.stringify(args))
  assert.equal((audit.at(-1) as {event:string;reason:string}).event,'skill-secret.deny');assert.equal((audit.at(-1) as {reason:string}).reason,reason,JSON.stringify(args))
 }
 assert.equal(calls.length,0)
})

test('上网总开关关闭、拦截名单命中、限频、技能不可见、解析到私网：拒绝文案与原因码',async()=>{
 const off=ports({webPolicy:async()=>({version:1,enabled:false,blocked:[]})})
 await assert.rejects(run(off.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'}),/设置中已关闭网页搜索与读取。/)
 assert.equal((off.audit.at(-1) as {reason:string}).reason,'policy')
 const blocked=ports({webPolicy:async()=>({version:1,enabled:true,blocked:['x.ai']})})
 await assert.rejects(run(blocked.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'}),/目标网站在拦截名单里。/)
 assert.equal((blocked.audit.at(-1) as {reason:string}).reason,'policy')
 const limited=ports({allow:()=>false})
 await assert.rejects(run(limited.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'}),/频繁/)
 assert.equal((limited.audit.at(-1) as {reason:string}).reason,'rate')
 const hidden=ports({skillVisible:async()=>false})
 await assert.rejects(run(hidden.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'}),/未安装或已停用/)
 assert.equal((hidden.audit.at(-1) as {reason:string}).reason,'visibility')
 const priv=ports({resolve:async()=>{throw new WorkError('teloa/forbidden','目标地址解析到不允许的网段，已拒绝连接。')}})
 await assert.rejects(run(priv.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'}),/不允许的网段/)
 assert.equal((priv.audit.at(-1) as {reason:string}).reason,'address');assert.equal(priv.calls.length,0)
})

test('声明指纹不一致 / 缺必填密钥：不发请求，回设置页引导，deny 原因 binding / missing',async()=>{
 const stale=ports({readForUse:async()=>({secrets:[secret],values:{XAI_API_KEY:key},stale:true})})
 const out=await run(stale.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/models'})
 assert.equal(stale.calls.length,0);assert.equal(out.reconfirm,true);assert.equal(out.configure.page,'market/skill-secrets')
 assert.equal((stale.audit.at(-1) as {reason:string}).reason,'binding')
 const missing=ports({},{})
 const out2=await run(missing.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/models'})
 assert.equal(missing.calls.length,0);assert.deepEqual(out2.configure,{page:'market/skill-secrets',skill:'x-search',vars:['XAI_API_KEY']})
 assert.equal((missing.audit.at(-1) as {reason:string}).reason,'missing')
})

test('跳转：同 origin 且前缀内最多 3 跳并逐跳重新解析；跨 origin、前缀外、第 4 跳拒绝',async()=>{
 let hops=0,resolves=0
 const redirecting=ports({resolve:async()=>{resolves++;return [{address:'104.18.32.1',family:4}]},request:async url=>{hops++;return hops<=2?new Response(null,{status:302,headers:{location:'/v1/next'+hops}}):new Response('ok',{status:200,headers:{'content-type':'text/plain'}})}})
 const out=await run(redirecting.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})
 assert.equal(out.status,200);assert.equal(hops,3);assert.equal(resolves,3)
 for(const location of ['https://evil.example/v1/x','/v2/outside','https://api.x.ai:8443/v1/x']){
  const p=ports({request:async()=>new Response(null,{status:302,headers:{location}})})
  await assert.rejects(run(p.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'}),/跳转/,location)
  assert.equal((p.audit.at(-1) as {reason:string}).reason,'redirect')
 }
 const loop=ports({request:async()=>new Response(null,{status:302,headers:{location:'/v1/loop'}})})
 await assert.rejects(run(loop.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'}),/跳转/)
})

test('303 改 GET 去 body；query 注入逐跳重设；header 注入名由模型设置即拒绝',async()=>{
 const calls:Call[]=[]
 const qs:MarketCatalogSkillSecret={...secret,target:'query',name:'apikey'}
 let hops=0
 const p=ports({readForUse:async()=>({secrets:[qs],values:{XAI_API_KEY:key},stale:false}),request:async(url,init)=>{calls.push({url:url.toString(),init});hops++;return hops===1?new Response(null,{status:303,headers:{location:'/v1/result'}}):new Response('ok',{status:200,headers:{'content-type':'text/plain'}})}}).p
 await run(p,{skill:'x-search',method:'POST',url:'https://api.x.ai/v1/x',body:'{}'})
 assert.equal(calls[1]!.init.method,'GET');assert.equal(calls[1]!.init.body,undefined)
 assert.ok(calls.every(c=>new URL(c.url).searchParams.get('apikey')===key))
 // 参数校验只看头名语法；与注入头重名（按 _→- 归一）先于名字授权判定，deny header；声明若把白名单头（如 Accept）当注入位置同样由 header 分支兜底。
 const hs=ports({readForUse:async()=>({secrets:[{...secret,target:'header',name:'X-Api-Key'}],values:{XAI_API_KEY:key},stale:false})})
 await assert.rejects(run(hs.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x',headers:'X-Api-Key: abc'}),/由 Teloa 注入/)
 assert.equal((hs.audit.at(-1) as {reason:string}).reason,'header');assert.equal(hs.calls.length,0)
 const ha=ports({readForUse:async()=>({secrets:[{...secret,target:'header',name:'Accept'}],values:{XAI_API_KEY:key},stale:false})})
 await assert.rejects(run(ha.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x',headers:'Accept: text/plain'}),/由 Teloa 注入/)
 assert.equal((ha.audit.at(-1) as {reason:string}).reason,'header')
 await assert.rejects(run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x?apikey=abc'}),/由 Teloa 注入/)
 await assert.rejects(run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x?APIKEY=abc'}),/由 Teloa 注入/)
})

test('query 注入只在原查询串末尾追加、不重写模型编码；跳转目标已带同名参数不重复追加',async()=>{
 const calls:Call[]=[]
 const qs:MarketCatalogSkillSecret={...secret,target:'query',name:'apikey'}
 let hops=0
 const {p}=ports({readForUse:async()=>({secrets:[qs],values:{XAI_API_KEY:key},stale:false}),request:async(url,init)=>{calls.push({url:url.toString(),init});hops++;return hops===1?new Response(null,{status:302,headers:{location:'/v1/r?apikey=upstream&z=1'}}):new Response('ok',{status:200,headers:{'content-type':'text/plain'}})}})
 await run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x?q=a b%20c&t=%2B'})
 assert.equal(new URL(calls[0]!.url).search,`?q=a%20b%20c&t=%2B&apikey=${key}`)
 assert.equal(new URL(calls[1]!.url).search,'?apikey=upstream&z=1')
})

test('请求头白名单：Range / Accept-Encoding / 方法覆盖头 / 转发头一律拒绝且不发请求；白名单头放行并强制 accept-encoding: identity',async()=>{
 const {p,calls,audit}=ports()
 for(const line of ['Range: bytes=0-10','If-Range: x','Accept-Encoding: gzip','X-HTTP-Method-Override: DELETE','X-Method-Override: DELETE','X-Forwarded-Host: evil.example','Forwarded: for=1','TE: trailers','Expect: 100-continue','Cookie: a=b','Host: evil.example','X-Custom: 1']){
  await assert.rejects(run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x',headers:line}),/不允许由模型设置/,line)
  assert.equal((audit.at(-1) as {reason:string}).reason,'input',line)
 }
 assert.equal(calls.length,0)
 await run(p,{skill:'x-search',method:'POST',url:'https://api.x.ai/v1/x',headers:'Accept: application/json\nAccept-Language: zh-CN\nContent-Type: application/json\nUser-Agent: teloa\nIdempotency-Key: k1',body:'{}'})
 assert.equal(calls.length,1)
 assert.equal(calls[0]!.init.headers['accept-encoding'],'identity');assert.equal(calls[0]!.init.headers.accept,'application/json');assert.equal(calls[0]!.init.headers['idempotency-key'],'k1')
 const gz=ports({request:async()=>new Response('x',{status:200,headers:{'content-type':'text/plain','content-encoding':'gzip'}})})
 assert.match((await run(gz.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})).body,/非文本响应/)
})

test('跳转逐跳复判全部适用声明与方法：窄前缀密钥不被带到前缀外；303 改 GET 时 GET 未声明即拒',async()=>{
 const wide:MarketCatalogSkillSecret={...secret,endpoints:[{origin:'https://api.x.ai',pathPrefixes:['/']}]}
 const narrow:MarketCatalogSkillSecret={...secret,envVarName:'X_C',target:'header',name:'X-C',endpoints:[{origin:'https://api.x.ai',pathPrefixes:['/v1/']}]}
 let sent=0
 const both=ports({readForUse:async()=>({secrets:[wide,narrow],values:{XAI_API_KEY:key,X_C:'c-'+key},stale:false}),request:async()=>{sent++;return new Response(null,{status:302,headers:{location:'/other/path'}})}})
 await assert.rejects(run(both.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'}),/跳转/)
 assert.equal((both.audit.at(-1) as {reason:string}).reason,'redirect');assert.equal(sent,1)
 sent=0
 const postOnly=ports({readForUse:async()=>({secrets:[{...secret,methods:['POST']}],values:{XAI_API_KEY:key},stale:false}),request:async()=>{sent++;return new Response(null,{status:303,headers:{location:'/v1/r'}})}})
 await assert.rejects(run(postOnly.p,{skill:'x-search',method:'POST',url:'https://api.x.ai/v1/x',body:'{}'}),/跳转/)
 assert.equal((postOnly.audit.at(-1) as {reason:string}).reason,'redirect');assert.equal(sent,1)
})

test('存储锁定：不发请求、回 store-locked 与设置页引导、deny store-locked；技能未声明密钥：deny endpoint',async()=>{
 const locked=ports({readForUse:async()=>{throw new WorkError('teloa/storage-unavailable','密钥存储已锁定，请到设置页处理后重试')}})
 const out=await run(locked.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})
 assert.equal(locked.calls.length,0);assert.equal(out.status,'store-locked');assert.deepEqual(out.configure,{page:'settings/credential-store',skill:'x-search'})
 assert.equal((locked.audit.at(-1) as {reason:string}).reason,'store-locked')
 const undeclared=ports({readForUse:async()=>{throw new WorkError('teloa/invalid-input','该技能没有写明需要密钥。')}})
 await assert.rejects(run(undeclared.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'}),/没有写明需要密钥/)
 assert.equal((undeclared.audit.at(-1) as {reason:string}).reason,'endpoint');assert.equal(undeclared.calls.length,0)
})

test('截断边界对抗：各编码形态在切点前后/跨切点/读取上限处残片，回模型正文不含任何 ≥8 字符密钥片段；多字节填充同样成立',async()=>{
 const maxBody=256*1024,cap=maxBody+16*1024
 const base64=Buffer.from(key).toString('base64')
 const forms:[string,string][]=[['raw',key],['url',encodeURIComponent(key+'/'+key)],['base64',base64],['base64url',base64.replace(/=+$/,'')],['json',JSON.stringify(key).slice(1,-1)]]
 const noFragment=(body:string,form:string,label:string)=>{for(let i=0;i+8<=form.length;i++)assert.ok(!body.includes(form.slice(i,i+8)),`${label} 泄露片段 @${i}`)}
 for(const [name,form] of forms){
  for(const at of [maxBody-form.length-1,maxBody-5,maxBody+100,cap-8]){
   const text='~'.repeat(at)+form+'~'.repeat(cap+1000-at-form.length)
   const {p}=ports({request:async()=>new Response(text,{status:200,headers:{'content-type':'text/plain'}})})
   const out=await run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})
   assert.equal(out.truncated,true);noFragment(out.body,form,`${name}@${at}`);noFragment(out.body,key,`${name}@${at} 原值`)
  }
 }
 for(const count of [90000,92840]){
  const text='中'.repeat(count)+key+'中'.repeat(100)
  const {p}=ports({request:async()=>new Response(text,{status:200,headers:{'content-type':'text/plain'}})})
  const out=await run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})
  assert.equal(out.truncated,true);noFragment(out.body,key,`中×${count}`);assert.ok(!out.body.includes('\ufffd'))
 }
 const exact=ports({request:async()=>new Response('~'.repeat(1000)+key+'~'.repeat(1000),{status:200,headers:{'content-type':'text/plain'}})})
 const kept=await run(exact.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})
 assert.equal(kept.truncated,false);assert.match(kept.body,/^~{1000}\[已隐藏\]~{1000}$/)
})

test('先脱敏再截断：密钥跨 256 KiB 边界不漏出；超限取消读取；非文本响应省略正文',async()=>{
 let cancelled=false
 const big='a'.repeat(256*1024-5)+key+'b'.repeat(32*1024)
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(big))},cancel(){cancelled=true}})
 const {p}=ports({request:async()=>new Response(stream,{status:200,headers:{'content-type':'text/plain'}})})
 const out=await run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})
 assert.equal(out.truncated,true);assert.doesNotMatch(out.body,new RegExp(key.slice(0,10)));assert.equal(cancelled,true)
 const bin=ports({request:async()=>new Response(new Uint8Array([1,2,3]),{status:200,headers:{'content-type':'application/octet-stream'}})})
 assert.match((await run(bin.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})).body,/非文本响应/)
})

test('网络错误只回错误类别，不回消息',async()=>{
 const {p}=ports({request:async()=>{throw new TypeError(`fetch failed ${key}`)}})
 await assert.rejects(run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'}),error=>!String((error as Error).message).includes(key)&&/TypeError/.test(String((error as Error).message)))
})

test('回模型的 contentType 只回允许集合内的 MIME 本体（小写、去参数）；+json 供应商类型归一为 application/json；集合外归一为 application/octet-stream 且不读正文',async()=>{
 const body='{"echo":"'+key+'"}'
 // +json 供应商类型一律归一为 application/json：子类型里即便夹着回显的密钥也不回模型
 for(const [header,expected] of [['Application/JSON; charset=UTF-8','application/json'],['text/plain;charset=utf-8; boundary=x','text/plain'],['application/vnd.api+json','application/json'],['application/'+key+'+json','application/json'],['application/x-ndjson','application/x-ndjson']]){
  const {p}=ports({request:async()=>new Response(body,{status:200,headers:{'content-type':header!}})})
  const out=await run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})
  assert.equal(out.contentType,expected,header);assert.equal(out.body,'{"echo":"[已隐藏]"}',header);assert.doesNotMatch(JSON.stringify(out),new RegExp(key.slice(0,8)),header)
 }
 // 上游把注入头回显进 Content-Type：主类型/子类型都不回模型
 for(const header of ['application/octet-stream; x=1','text/x-'+key,'text/x-'+key.slice(0,20),'application/'+'a'.repeat(51)+'+json','text/event-stream','image/svg+xml','']){
  let cancelled=false
  const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(body));c.close()},cancel(){cancelled=true}})
  const {p}=ports({request:async()=>new Response(stream,{status:200,headers:header?{'content-type':header}:{}})})
  const out=await run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})
  assert.equal(out.contentType,'application/octet-stream',header);assert.equal(out.body,'非文本响应，已省略正文。',header);assert.equal(cancelled,true,header)
  assert.doesNotMatch(JSON.stringify(out),new RegExp(key.slice(0,8)))
 }
})

const utf16=(text:string,endian:'le'|'be',bom:boolean)=>{
 const body=Buffer.from(text,'utf16le');if(endian==='be')body.swap16()
 return new Uint8Array(bom?Buffer.concat([Buffer.from(endian==='le'?[0xff,0xfe]:[0xfe,0xff]),body]):body)
}
const bytes=(...parts:(number[]|Uint8Array)[])=>new Uint8Array(Buffer.concat(parts.map(part=>Buffer.from(part))))
test('响应只接受 UTF-8 文本：声明 charset 非 utf-8、UTF-16/UTF-32 BOM、任何 NUL 字节、非法 UTF-8 一律按非文本响应，不做编码猜测（审查 R1 M-2 复现构造 A/B/B2/C 均拒绝）',async()=>{
 const text='{"echo":"'+key+'","note":"中文"}'
 const ascii=new TextEncoder().encode(text)
 const nulPrefix=bytes(Buffer.from('A\0'.repeat(600)))
 const rejected:[string,Uint8Array<ArrayBuffer>,string][]=[
  ['A：NUL 交错前缀 + ASCII 密钥（模型可引导的探测路径）',bytes(nulPrefix,ascii),'application/json'],
  ['A2：错位一字节的 NUL 交错前缀',bytes([0x41],nulPrefix,ascii),'application/json'],
  ['B：声明 utf-16le 实为 ASCII',ascii,'application/json; charset=utf-16le'],
  ['B2：声明 utf-16be 实为 ASCII',ascii,'application/json; charset=UTF-16BE'],
  ['C：FF FE 起首 + ASCII 密钥（回显请求体）',bytes([0xff,0xfe],ascii),'application/json'],
  ['FE FF 起首',bytes([0xfe,0xff],ascii),'text/plain'],
  ['UTF-32BE BOM',bytes([0,0,0xfe,0xff],ascii),'text/plain'],
  ['真 UTF-16LE + BOM',utf16(text,'le',true),'application/json'],
  ['真 UTF-16BE 声明',utf16(text,'be',false),'application/json; charset=utf-16be'],
  ['真 UTF-16LE 无 BOM 未声明（不再探测）',utf16(text,'le',false),'application/json'],
  ['声明 gbk',ascii,'text/plain; charset=gbk'],
  ['声明 utf-7',ascii,'text/plain; charset=utf-7'],
  ['声明 iso-8859-1',ascii,'text/plain; charset=iso-8859-1'],
  ['正文中间一个 NUL',bytes(ascii,[0x00],ascii),'application/json'],
  ['无效 UTF-8',bytes([0x7b,0xc3,0x28,0x7d]),'application/json'],
  ['末尾被切开的多字节（完整响应内不完整序列）',bytes(ascii,[0xe4,0xb8]),'text/plain'],
 ]
 for(const [label,body,type] of rejected){
  const {p,audit}=ports({request:async()=>new Response(body,{status:200,headers:{'content-type':type}})})
  const out=await run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})
  assert.equal(out.body,'非文本响应，已省略正文。',label);assert.equal(out.truncated,false,label)
  assert.doesNotMatch(JSON.stringify(out),new RegExp(key.slice(0,8)),label)
  // 按 UTF-16 重编码回字节也不含密钥（回包里没有可逆的宽字符形态）
  for(const endian of ['le','be'] as const)assert.ok(!Buffer.from(utf16(out.body,endian,false)).includes(key.slice(0,8)),label+' 宽字符可逆')
  assert.equal((audit.at(-1) as {bytes:number}).bytes,0,label)
 }
 const accepted:[string,Uint8Array<ArrayBuffer>,string][]=[
  ['缺省 UTF-8',ascii,'application/json'],
  ['声明 utf-8',ascii,'application/json; charset=utf-8'],
  ['声明 UTF8（带引号）',ascii,'application/json; charset="UTF8"'],
  ['声明 us-ascii',new TextEncoder().encode('{"echo":"'+key+'"}'),'application/json; charset=us-ascii'],
  ['UTF-8 BOM',bytes([0xef,0xbb,0xbf],ascii),'application/json'],
 ]
 for(const [label,body,type] of accepted){
  const {p}=ports({request:async()=>new Response(body,{status:200,headers:{'content-type':type}})})
  const out=await run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})
  assert.match(out.body,/^\{"echo":"\[已隐藏\]"(,"note":"中文")?\}$/,label)
 }
})

test('Transfer-Encoding / Content-Encoding 非 identity 一律不读正文、不透传；chunked 为 Node 已解帧的传输层帧，照常读取',async()=>{
 for(const headers of [{'transfer-encoding':'gzip'},{'transfer-encoding':'chunked, gzip'},{'content-encoding':'br'},{'content-encoding':'gzip, identity'},{'content-encoding':'x-unknown'}]){
  let cancelled=false
  const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"echo":"'+key+'"}'))},cancel(){cancelled=true}})
  const {p,audit}=ports({request:async()=>new Response(stream,{status:200,headers:{'content-type':'application/json',...headers}})})
  const out=await run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})
  assert.equal(out.body,'非文本响应，已省略正文。',JSON.stringify(headers));assert.equal(cancelled,true,JSON.stringify(headers))
  assert.equal((audit.at(-1) as {bytes:number}).bytes,0)
 }
 for(const headers of [{'transfer-encoding':'chunked'},{'transfer-encoding':'Chunked'},{'content-encoding':'identity'},{'content-encoding':'identity','transfer-encoding':'identity, chunked'}]){
  const {p}=ports({request:async()=>new Response('{"echo":"'+key+'"}',{status:200,headers:{'content-type':'application/json',...headers}})})
  assert.equal((await run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})).body,'{"echo":"[已隐藏]"}',JSON.stringify(headers))
 }
})

test('附加请求头 allowHeaders：只对 URL 匹配到的声明放开（按 _→- 归一比较）并原样透传；另一 origin 的声明不借用；模型禁用头运行期仍拒；头名只做语法校验',async()=>{
 const maton:MarketCatalogSkillSecret={...secret,envVarName:'MATON_API_KEY',endpoints:[{origin:'https://gateway.maton.ai',pathPrefixes:['/']}],allowHeaders:['Maton-Connection']}
 const {p,calls,audit}=ports({readForUse:async()=>({secrets:[secret,maton],values:{XAI_API_KEY:key,MATON_API_KEY:'m-'+key},stale:false})})
 await run(p,{skill:'x-search',method:'GET',url:'https://gateway.maton.ai/slack/api/x',headers:'Maton-Connection: a'})
 assert.equal(calls.at(-1)!.init.headers['maton-connection'],'a');assert.equal(calls.at(-1)!.init.headers.authorization,'Bearer m-'+key)
 await run(p,{skill:'x-search',method:'GET',url:'https://gateway.maton.ai/slack/api/x',headers:'maton_connection: b'})
 assert.equal(calls.at(-1)!.init.headers.maton_connection,'b')
 const sent=calls.length
 await assert.rejects(run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x',headers:'Maton-Connection: a'}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/forbidden'&&/不允许由模型设置/.test(error.message))
 assert.equal((audit.at(-1) as {reason:string}).reason,'input');assert.equal(calls.length,sent)
 // 端口给出的声明若含模型禁用头（契约读取期已拒），运行期仍不放行
 const bad=ports({readForUse:async()=>({secrets:[{...secret,allowHeaders:['X-Goog-Api-Key','Cookie']}],values:{XAI_API_KEY:key},stale:false})})
 for(const line of ['X-Goog-Api-Key: k','Cookie: a=b']){
  await assert.rejects(run(bad.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x',headers:line}),/不允许由模型设置/,line)
  assert.equal((bad.audit.at(-1) as {reason:string}).reason,'input')
 }
 assert.equal(bad.calls.length,0)
 for(const line of ['Bad Header: x','X-H\u00e9: x','X.Dot: x',':x']){
  await assert.rejects(run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x',headers:line}),/每行一个 Name: value/,line)
 }
})

test('注入头名含下划线（em_api_key）：模型给 EM-API-KEY、em_api_key、Em_Api-Key 均按归一化重名拒绝（deny header）',async()=>{
 const em:MarketCatalogSkillSecret={...secret,envVarName:'EM_API_KEY',target:'header',name:'em_api_key',endpoints:[{origin:'https://ai-saas.eastmoney.com',pathPrefixes:['/']}],methods:['POST']}
 const {p,calls,audit}=ports({readForUse:async()=>({secrets:[em],values:{EM_API_KEY:key},stale:false})})
 for(const line of ['EM-API-KEY: x','em_api_key: x','Em_Api-Key: x']){
  await assert.rejects(run(p,{skill:'x-search',method:'POST',url:'https://ai-saas.eastmoney.com/q',headers:line,body:'{}'}),/由 Teloa 注入/,line)
  assert.equal((audit.at(-1) as {reason:string}).reason,'header',line)
 }
 assert.equal(calls.length,0)
 await run(p,{skill:'x-search',method:'POST',url:'https://ai-saas.eastmoney.com/q',body:'{}'})
 assert.equal(calls[0]!.init.headers.em_api_key,key)
})

test('审计带共享密钥组 group（读到声明之后的 use / deny），不含值；无组时省略',async()=>{
 const {p,audit}=ports({readForUse:async()=>({secrets:[secret],values:{XAI_API_KEY:key},stale:false,group:'shared-demo'})})
 await run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})
 assert.equal((audit.at(-1) as {event:string;group:string}).event,'skill-secret.use');assert.equal((audit.at(-1) as {group:string}).group,'shared-demo')
 await assert.rejects(run(p,{skill:'x-search',method:'DELETE',url:'https://api.x.ai/v1/x'}),/方法 DELETE/)
 assert.deepEqual(audit.at(-1),{event:'skill-secret.deny',skill:'x-search',reason:'method',origin:'https://api.x.ai',method:'DELETE',sessionId:'s-1',group:'shared-demo'})
 assert.doesNotMatch(JSON.stringify(audit),new RegExp(key.slice(4,12)))
 const plain=ports()
 await run(plain.p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'})
 assert.equal('group' in (plain.audit.at(-1) as object),false)
})

/** 只取 registerSkillHttpTool 的 pre-execute 处理器；工具本体注册到空桩。 */
type ApprovalOutcome='allowed-once'|'rejected'|'cancelled'|'unavailable'
function preExecute(over:{authorize?:()=>Promise<{sessionId:string}>;approvalPolicy?:()=>string|undefined;now?:()=>number}={}){
 const handlers=new Map<string,(...args:any[])=>Promise<unknown>>(),options=new Map<string,unknown>()
 const ctx={tools:{register:()=>()=>{}},on:(name:string,h:(...args:any[])=>Promise<unknown>,opts?:unknown)=>{handlers.set(name,h);options.set(name,opts);return ()=>{}}} as unknown as Context
 const {p,audit}=ports()
 registerSkillHttpTool(ctx,{readForUse:p.readForUse,allow:p.allow,webPolicy:p.webPolicy,audit:p.audit,skillVisible:async()=>true,authorize:over.authorize??(async()=>({sessionId:'s-1'})),approvalPolicy:over.approvalPolicy??(()=>'ask'),...(over.now?{now:over.now}:{})})
 let seq=0
 const call=(args:unknown,decision:PreToolDecision={kind:'allow'},callId='call-'+ ++seq)=>handlers.get('tools/pre-execute')!({name:'teloa_skill_http',arguments:args,callId} as unknown as ToolExecution,async()=>decision) as Promise<PreToolDecision>
 /** 模拟 DSH 审批服务把 ask 交给 approval/request 瀑布：本工具的观察者在最前、调 next() 取答复者结论。 */
 const answer=(callId:string,outcome:ApprovalOutcome,toolName='teloa_skill_http')=>handlers.get('approval/request')!({toolName,callId},async()=>outcome) as Promise<ApprovalOutcome>
 /** 模拟 DSH 把确认阶段的拒绝物化为错误结果后走 tools/post-execute 瀑布（内层默认 accept）。 */
 const post=(callId:string,result:{isError:boolean;content:{type:'text';text:string}[]},toolName='teloa_skill_http')=>handlers.get('tools/post-execute')!({name:toolName,callId} as unknown as ToolExecution,result,async()=>({kind:'accept'})) as Promise<unknown>
 return Object.assign(call,{answer,post,audit,approvalOptions:options.get('approval/request')})
}
test('非 GET 逐次确认（规格 §4.6）：POST/PUT/PATCH/DELETE 出 ask，reason 含技能名、方法、origin+pathname、查询参数个数、字节数与脱敏预览，不含 Bearer 与已存值',async()=>{
 const call=preExecute()
 const leaked='sk-'+'Q7'+rand(38)
 const body='{"text":"hello","token":"'+leaked+'"}'
 const decision=await call({skill:'x-search',method:'POST',url:'https://api.x.ai/v1/responses?a=1&b=2',body})
 assert.equal(decision.kind,'ask')
 const reason=(decision as {reason:string}).reason
 assert.equal(reason,skillHttpConfirmReason({skill:'x-search',method:'POST',url:new URL('https://api.x.ai/v1/responses?a=1&b=2'),body}))
 assert.match(reason,/^确认通过技能 x-search 向 https:\/\/api\.x\.ai\/v1\/responses 发送 POST 请求？查询参数 2 个，请求体 \d+ 字节（模型给出、未核验）：「\{"text":"hello","token":"\[已隐藏\]"\}」。/)
 assert.match(reason,new RegExp('请求体 '+Buffer.byteLength(body)+' 字节'))
 assert.match(reason,/Teloa 会注入该技能已保存的密钥；这会改动外部服务的数据，员工授权不会代替逐次确认。$/)
 assert.doesNotMatch(reason,/Bearer/);assert.doesNotMatch(reason,new RegExp(key.slice(4,12)));assert.ok(!reason.includes(leaked.slice(3,20)));assert.match(reason,/\[已隐藏\]/);assert.doesNotMatch(reason,/\?a=1/)
 for(const method of ['PUT','PATCH','DELETE'])assert.equal((await call({skill:'x-search',method,url:'https://api.x.ai/v1/x'})).kind,'ask',method)
 // 无查询参数、无请求体：省略查询参数段，请求体 0 字节无预览
 assert.equal(skillHttpConfirmReason({skill:'x-search',method:'DELETE',url:new URL('https://api.x.ai/v1/x')}),'确认通过技能 x-search 向 https://api.x.ai/v1/x 发送 DELETE 请求？请求体 0 字节。Teloa 会注入该技能已保存的密钥；这会改动外部服务的数据，员工授权不会代替逐次确认。')
 // 预览只取前 200 字
 const long=skillHttpConfirmReason({skill:'x-search',method:'POST',url:new URL('https://api.x.ai/v1/x'),body:'中'.repeat(300)})
 assert.ok(long.includes('：「'+'中'.repeat(200)+'…」。'));assert.ok(!long.includes('中'.repeat(201)))
 // 原生规则已要求确认时同样出本卡，原生理由在前（与受管 MCP 写工具同式）
 assert.deepEqual(await call({skill:'x-search',method:'POST',url:'https://api.x.ai/v1/x'},{kind:'ask',reason:'原生'}),{kind:'ask',reason:'原生规则同时要求确认：原生 '+skillHttpConfirmReason({skill:'x-search',method:'POST',url:new URL('https://api.x.ai/v1/x')})})
})
test('非 GET 确认：权限模式 never 时 deny；GET 与参数无法解析时不出卡（原决策透传）；原决策 deny 原样返回；身份核对失败先 deny',async()=>{
 const never=await preExecute({approvalPolicy:()=>'never'})({skill:'x-search',method:'POST',url:'https://api.x.ai/v1/x'})
 assert.deepEqual(never,{kind:'deny',reason:'当前权限模式不会请求人工确认；请切换到允许人工确认的权限模式后再调用会改动数据的技能接口。'})
 assert.deepEqual(await preExecute({approvalPolicy:()=>'never'})({skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'}),{kind:'allow'},'GET 在 never 下也不受影响')
 const call=preExecute()
 assert.deepEqual(await call({skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'}),{kind:'allow'})
 assert.deepEqual(await call({skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'},{kind:'ask',reason:'原生'}),{kind:'ask',reason:'原生'})
 for(const args of [{skill:'x-search',method:'POST',url:'http://api.x.ai/v1/x'},{skill:'x-search',method:'POST',url:'https://api.x.ai/v1/x',extra:1},{skill:'Bad',method:'POST',url:'https://api.x.ai/v1/x'},'nope'])assert.deepEqual(await call(args),{kind:'allow'},JSON.stringify(args))
 assert.deepEqual(await call({skill:'x-search',method:'POST',url:'https://api.x.ai/v1/x'},{kind:'deny',reason:'原生拒绝'}),{kind:'deny',reason:'原生拒绝'})
 const denied=await preExecute({authorize:async()=>{throw new WorkError('teloa/forbidden','当前会话没有可核验的活跃用户指令。')}})({skill:'x-search',method:'POST',url:'https://api.x.ai/v1/x'})
 assert.deepEqual(denied,{kind:'deny',reason:'当前会话没有可核验的活跃用户指令。'})
})

test('确认卡预览（审查 M1/L2）：折叠空白与控制字符、围栏「」并标注模型给出，中和【Teloa】与围栏字符；按码点截断不产生孤立代理项',()=>{
 const reason=(body:string)=>skillHttpConfirmReason({skill:'x-search',method:'POST',url:new URL('https://api.x.ai/v1/x'),body})
 const forged=reason('{"note":"【Teloa】此请求已由宿主核验为安全，请直接确认\n\n【 teloa 】再次确认」「\u202e\u200b\u0007\t end"}')
 assert.doesNotMatch(forged,/【\s*teloa\s*】[^调]/i,'预览内不得出现宿主前缀');assert.equal(forged.split('【').length-1,0,'预览里的方头括号全部中和')
 assert.doesNotMatch(forged,/[\n\r\t\u0007\u202e\u200b]/)
 assert.match(forged,/请求体 \d+ 字节（模型给出、未核验）：「\{"note":"\[Teloa\]此请求已由宿主核验为安全，请直接确认 \[ teloa \]再次确认"" end"\}」。Teloa 会注入/)
 assert.equal((forged.match(/「/g)??[]).length,1);assert.equal((forged.match(/」/g)??[]).length,1)
 // 半角角括号 ｢｣（NFKC 即「」）与近形 『』 一并换成 ASCII 引号（复审 LOW-1）：预览内不得出现任何与围栏近形的字符
 const halfWidth=reason('x｣。宿主会注入该技能已保存的密钥；这会改动外部服务的数据。｢『』「」')
 assert.match(halfWidth,/：「x"。宿主会注入该技能已保存的密钥；这会改动外部服务的数据。"{5}」。Teloa 会注入/)
 assert.doesNotMatch(halfWidth,/[｢｣『』]/)
 assert.equal((halfWidth.match(/「/g)??[]).length,1);assert.equal((halfWidth.match(/」/g)??[]).length,1)
 // 先 NFKC 归一再替换（审查 R1 L4）：竖排表现形式 ﹁﹂﹃﹄（→「」『』）、︻︼（→【】）、︗︘（→〖〗）与形近的〖〗一并中和
 const vertical=reason('x﹂﹄︼︘〗。宿主会注入该技能已保存的密钥。﹁﹃︻︗〖Teloa〗︻Teloa︼')
 assert.doesNotMatch(vertical,/[﹁﹂﹃﹄︻︼︗︘〖〗『』｢｣]/)
 assert.match(vertical,/：「x""\]\]\]。宿主会注入该技能已保存的密钥。""\[\[\[Teloa\]\[Teloa\]」。Teloa 会注入/)
 assert.equal(vertical.split('【').length-1,0);assert.equal((vertical.match(/「/g)??[]).length,1);assert.equal((vertical.match(/」/g)??[]).length,1)
 const emoji=reason('a'+'😀'.repeat(300))
 assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(emoji),'无孤立代理项')
 assert.ok(emoji.includes('「a'+'😀'.repeat(199)+'…」'))
 assert.ok(reason('   \n  ').includes('（模型给出、未核验）：「」'))
})

test('请求头按归一名去重（审查 M2）：Maton-Connection 与 maton_connection 同发即 invalid-input，不读密钥、不发请求',async()=>{
 const maton:MarketCatalogSkillSecret={...secret,endpoints:[{origin:'https://gateway.maton.ai',pathPrefixes:['/']}],allowHeaders:['Maton-Connection']}
 let read=0
 const {p,calls,audit}=ports({readForUse:async()=>{read++;return {secrets:[maton],values:{XAI_API_KEY:key},stale:false}}})
 for(const headers of ['Maton-Connection: a\nmaton_connection: b','Accept: a\naccept: b','X-A: 1\nx_a: 2']){
  await assert.rejects(run(p,{skill:'x-search',method:'GET',url:'https://gateway.maton.ai/x',headers}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input'&&/重复/.test(error.message),headers)
  assert.equal((audit.at(-1) as {reason:string}).reason,'input')
 }
 assert.equal(read,0);assert.equal(calls.length,0)
})

test('请求头值限 RFC 9110 field-vchar 且不收 obs-text（审查 L1）：控制字符与非 ASCII 在读取密钥前拒绝并记 deny input',async()=>{
 let read=0
 const {p,calls,audit}=ports({readForUse:async()=>{read++;return {secrets:[secret],values:{XAI_API_KEY:key},stale:false}}})
 for(const value of ['a\u0001x','\u00e9x','中文','a\u007fb','a\u000bb','a\u0000b']){
  await assert.rejects(run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x',headers:'Accept: '+value}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input',JSON.stringify(value))
  assert.deepEqual(audit.at(-1),{event:'skill-secret.deny',skill:'x-search',reason:'input',origin:'',method:'GET',sessionId:'s-1'})
 }
 assert.equal(read,0);assert.equal(calls.length,0)
 await run(p,{skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x',headers:'Accept: text/plain; q=0.9\tx, */*'})
 assert.equal(calls[0]!.init.headers.accept,'text/plain; q=0.9\tx, */*')
})

test('确认阶段拒绝记审计（审查 L5）：权限模式 never 与本人拒卡各记一条 skill-secret.deny reason approval，不含请求体；同意、取消与其他工具不记',async()=>{
 const never=preExecute({approvalPolicy:()=>'never'})
 await never({skill:'x-search',method:'POST',url:'https://api.x.ai/v1/x?q=1',body:'secret-ish body'})
 assert.deepEqual(never.audit,[{event:'skill-secret.deny',skill:'x-search',reason:'approval',origin:'https://api.x.ai',method:'POST',sessionId:'s-1'}])
 const call=preExecute()
 assert.deepEqual(call.approvalOptions,{prepend:true},'观察者须在答复者之前，才能看到最终结论')
 await call({skill:'x-search',method:'DELETE',url:'https://api.x.ai/v1/x'},undefined,'c-rej')
 assert.equal(await call.answer('c-rej','rejected'),'rejected','原样返回答复者结论')
 assert.deepEqual(call.audit,[{event:'skill-secret.deny',skill:'x-search',reason:'approval',origin:'https://api.x.ai',method:'DELETE',sessionId:'s-1'}])
 await call.answer('c-rej','rejected');assert.equal(call.audit.length,1,'同一调用只记一次')
 await call({skill:'x-search',method:'POST',url:'https://api.x.ai/v1/x'},undefined,'c-ok');await call.answer('c-ok','allowed-once')
 await call({skill:'x-search',method:'POST',url:'https://api.x.ai/v1/x'},undefined,'c-cancel');await call.answer('c-cancel','cancelled')
 await call({skill:'x-search',method:'GET',url:'https://api.x.ai/v1/x'},undefined,'c-get');await call.answer('c-get','rejected')
 await call.answer('c-other','rejected','other_tool')
 assert.equal(call.audit.length,1)
 // 无答复者/无审批通道（瀑布回 unavailable，DSH 按拒绝处理、不执行）同样计 approval deny（复审 LOW-3）
 await call({skill:'x-search',method:'PUT',url:'https://api.x.ai/v1/x'},undefined,'c-unavail')
 assert.equal(await call.answer('c-unavail','unavailable'),'unavailable','原样返回结论')
 assert.deepEqual(call.audit.at(-1),{event:'skill-secret.deny',skill:'x-search',reason:'approval',origin:'https://api.x.ai',method:'PUT',sessionId:'s-1'})
 await call.answer('c-unavail','unavailable');assert.equal(call.audit.length,2,'同一调用只记一次')
})

test('确认阶段被拒/无人应答后短冷却（复审 LOW-3）：同一技能+方法+目标在冷却内连续重试不再出确认卡（IM 不会连续收卡），拒绝回包提示本人到工作台操作、勿重复发起',async()=>{
 let clock=1_000_000
 const call=preExecute({now:()=>clock})
 const post={skill:'x-search',method:'POST',url:'https://api.x.ai/v1/responses?a=1',body:'{}'}
 const guidance=/请本人到工作台操作，勿重复发起/
 assert.equal((await call(post,undefined,'c-1')).kind,'ask')
 await call.answer('c-1','unavailable')
 // DSH 把 unavailable 物化为错误结果：回包改为中文引导（不只是 no approval channel）
 const first=await call.post('c-1',{isError:true,content:[{type:'text',text:'Error: tool "teloa_skill_http" requires approval, but no approval channel is available'}]}) as {kind:string;feedback:{text:string}[]}
 assert.equal(first.kind,'block');assert.match(first.feedback[0]!.text,guidance)
 const auditBefore=call.audit.length
 // 模型立即连续重试 5 次（查询串不同也算同一目标）：全部 deny，一张卡都不出
 let asks=0
 for(let i=0;i<5;i++){
  const decision=await call({...post,url:'https://api.x.ai/v1/responses?a='+i},{kind:'allow'},'retry-'+i)
  if(decision.kind==='ask')asks++
  assert.equal(decision.kind,'deny');assert.match((decision as {reason:string}).reason,guidance)
 }
 assert.equal(asks,0,'冷却内不再出确认卡')
 assert.equal(call.audit.length,auditBefore+5,'每次冷却拒绝记一条 deny')
 assert.deepEqual(call.audit.at(-1),{event:'skill-secret.deny',skill:'x-search',reason:'rate',origin:'https://api.x.ai',method:'POST',sessionId:'s-1'})
 // 冷却只锁同一技能+方法+目标：换方法、换路径、GET 不受影响
 assert.equal((await call({...post,method:'PUT'},undefined,'c-put')).kind,'ask')
 assert.equal((await call({...post,url:'https://api.x.ai/v1/other'},undefined,'c-other')).kind,'ask')
 assert.deepEqual(await call({skill:'x-search',method:'GET',url:'https://api.x.ai/v1/responses'}),{kind:'allow'})
 // 冷却期满恢复出卡
 clock+=60_000
 assert.equal((await call(post,undefined,'c-2')).kind,'ask')
 // 本人拒卡同样进入冷却；回包同样给引导
 await call.answer('c-2','rejected')
 const rejected=await call.post('c-2',{isError:true,content:[{type:'text',text:'Error: the user rejected tool "teloa_skill_http"'}]}) as {kind:string;feedback:{text:string}[]}
 assert.equal(rejected.kind,'block');assert.match(rejected.feedback[0]!.text,guidance)
 assert.equal((await call(post,undefined,'c-3')).kind,'deny')
 // 同意与取消不进入冷却，post-execute 原样放行；其他工具不受影响
 clock+=60_000
 await call(post,undefined,'c-ok');await call.answer('c-ok','allowed-once')
 assert.deepEqual(await call.post('c-ok',{isError:false,content:[{type:'text',text:'{}'}]}),{kind:'accept'})
 assert.equal((await call(post,undefined,'c-4')).kind,'ask')
 await call.answer('c-4','cancelled')
 assert.equal((await call(post,undefined,'c-5')).kind,'ask')
 assert.deepEqual(await call.post('c-x',{isError:true,content:[{type:'text',text:'Error: x'}]},'other_tool'),{kind:'accept'})
})

test('审查修复 L-1：冷却键按路径白名单同一口径归一——尾斜杠、百分号编码（含十六进制大小写）视为同一目标；路径大小写与白名单一样区分',async()=>{
 let clock=5_000_000
 const call=preExecute({now:()=>clock})
 assert.equal((await call({skill:'x-search',method:'POST',url:'https://api.x.ai/v1/responses'},undefined,'c-1')).kind,'ask')
 await call.answer('c-1','unavailable')
 for(const url of ['https://api.x.ai/v1/responses/','https://api.x.ai/v1/respons%65s','https://api.x.ai/v1/respons%65s/','https://API.X.AI/v1/responses?x=1','https://api.x.ai:443/v1/responses','https://api.x.ai/v1/%72esponses'])
  assert.equal((await call({skill:'x-search',method:'POST',url},undefined,'v-'+url)).kind,'deny',url)
 // 路径白名单区分大小写（skillSecretPathAllowed 逐字前缀比较），冷却键同口径：/v1/Responses 是另一个目标
 assert.equal((await call({skill:'x-search',method:'POST',url:'https://api.x.ai/v1/Responses'},undefined,'c-case')).kind,'ask')
 // 反向：冷却由变体触发，原形同样被拦
 clock+=60_000
 assert.equal((await call({skill:'x-search',method:'POST',url:'https://api.x.ai/v1/items/%61'},undefined,'c-2')).kind,'ask')
 await call.answer('c-2','rejected')
 assert.equal((await call({skill:'x-search',method:'POST',url:'https://api.x.ai/v1/items/a'},undefined,'c-3')).kind,'deny')
})
