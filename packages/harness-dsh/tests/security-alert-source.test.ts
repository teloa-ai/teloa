import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {chmod,mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {SecurityAlertHttpSource,readSecurityAlertSourceConfig} from '../src/security-alert-source.ts'

const response={schema:'teloa.data-source-page/v1',sourceId:'security-alert-http',scope:'SOC',capturedAt:'2026-09-12T01:00:02.000Z',items:[],nextCursor:'next'}

test('安全告警适配器通过真实 HTTP GET 传递只读筛选与凭据',async()=>{
 const requests:Array<{url:string;method:string;accept?:string;authorization?:string}>=[]
 const server=createServer((request,reply)=>{requests.push({url:request.url!,method:request.method!,...(request.headers.accept?{accept:request.headers.accept}:{}),...(request.headers.authorization?{authorization:request.headers.authorization}:{})});reply.setHeader('content-type','application/json');reply.end(JSON.stringify(response))})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object')
 const root=await mkdtemp(join(tmpdir(),'teloa-security-source-')),config=join(root,'source.json')
 try{
  await writeFile(config,JSON.stringify({url:`http://127.0.0.1:${address.port}/alerts`,bearerToken:'test-token'}),{mode:0o600})
  const result=await new SecurityAlertHttpSource(config).query({scope:'SOC',text:'prod 03',source:'EDR',quality:'complete',observedAfter:'2026-09-12T00:30:00.000Z',limit:20,cursor:'page-1'})
  assert.deepEqual(result,response);assert.equal(requests.length,1);const request=requests[0]!,url=new URL(request.url,'http://localhost')
  assert.equal(request.method,'GET');assert.equal(request.accept,'application/json');assert.equal(request.authorization,'Bearer test-token');assert.deepEqual(Object.fromEntries(url.searchParams),{scope:'SOC',limit:'20',text:'prod 03',source:'EDR',quality:'complete',observedAfter:'2026-09-12T00:30:00.000Z',cursor:'page-1'})
 }finally{server.close();await rm(root,{recursive:true,force:true})}
})

test('来源配置拒绝内嵌凭据、明文远程地址、查询串和未知字段',()=>{
 assert.deepEqual(readSecurityAlertSourceConfig({url:'https://security.example.test/api'}),{url:'https://security.example.test/api'})
 for(const value of [{url:'http://security.example.test/api'},{url:'https://user:pass@security.example.test/api'},{url:'https://security.example.test/api?token=x'},{url:'file:///tmp/alerts'},{url:'https://security.example.test/api',extra:true}])assert.throws(()=>readSecurityAlertSourceConfig(value),{code:'teloa/source-unavailable'})
})

test('缺失配置、失败状态、非法 JSON 与过大回包均显式失败',async()=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-security-source-')),config=join(root,'source.json')
 try{
  await assert.rejects(new SecurityAlertHttpSource(config).query({scope:'SOC',limit:10}),{code:'teloa/source-unavailable',message:'安全告警来源尚未配置。',details:{sourceState:'disconnected'}},'配置文件不存在即来源没接上，带 sourceState:disconnected')
  await writeFile(config,JSON.stringify({url:'https://security.example.test/api'}),{mode:0o600})
  const failed=new SecurityAlertHttpSource(config,async()=>new Response('unavailable',{status:503}));await assert.rejects(failed.query({scope:'SOC',limit:10}),{code:'teloa/source-unavailable'})
  const invalid=new SecurityAlertHttpSource(config,async()=>new Response('{'));await assert.rejects(invalid.query({scope:'SOC',limit:10}),{code:'teloa/source-invalid'})
  const oversized=new SecurityAlertHttpSource(config,async()=>new Response(new Uint8Array(2*1024*1024+1)));await assert.rejects(oversized.query({scope:'SOC',limit:10}),{code:'teloa/source-invalid'})
 }finally{await rm(root,{recursive:true,force:true})}
})

test('已取消请求不读取配置或发起网络调用',async()=>{
 let requests=0;const controller=new AbortController();controller.abort()
 await assert.rejects(new SecurityAlertHttpSource('/missing',async()=>{requests++;return new Response('{}')}).query({scope:'SOC',limit:10},controller.signal),{name:'AbortError'})
 assert.equal(requests,0)
})

test('就绪核验读取配置并做 limit=1 有界探测',async()=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-security-source-')),config=join(root,'source.json')
 try{
  let requests=0
  const unconfigured=await new SecurityAlertHttpSource(config,async()=>{requests++;return new Response(JSON.stringify(response))}).ready('SOC',new AbortController().signal)
  assert.deepEqual(unconfigured,{ready:false,reason:'安全告警来源尚未配置。'});assert.equal(requests,0)
  await writeFile(config,JSON.stringify({url:'https://security.example.test/api'}),{mode:0o600})
  const urls:string[]=[]
  const ok=await new SecurityAlertHttpSource(config,async url=>{urls.push(String(url));return new Response(JSON.stringify(response))}).ready('SOC',new AbortController().signal)
  assert.ok(ok.ready);assert.equal(new Date(ok.probedAt).toISOString(),ok.probedAt)
  assert.equal(urls.length,1);assert.deepEqual(Object.fromEntries(new URL(urls[0]!).searchParams),{scope:'SOC',limit:'1'})
  assert.deepEqual(await new SecurityAlertHttpSource(config,async()=>new Response('unavailable',{status:503})).ready('SOC',new AbortController().signal),{ready:false,reason:'安全告警来源未返回成功状态。'})
  assert.deepEqual(await new SecurityAlertHttpSource(config,async()=>new Response('{')).ready('SOC',new AbortController().signal),{ready:false,reason:'安全告警来源没有返回合法 UTF-8 JSON。'})
 }finally{await rm(root,{recursive:true,force:true})}
})

test('就绪核验在取消时抛出而不返回未就绪',async()=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-security-source-')),config=join(root,'source.json')
 try{
  await writeFile(config,JSON.stringify({url:'https://security.example.test/api'}),{mode:0o600})
  let requests=0
  const cancelled=new AbortController();cancelled.abort()
  await assert.rejects(new SecurityAlertHttpSource(config,async()=>{requests++;return new Response('{}')}).ready('SOC',cancelled.signal),{name:'AbortError'})
  assert.equal(requests,0)
  const midflight=new AbortController()
  await assert.rejects(new SecurityAlertHttpSource(config,async()=>{midflight.abort();throw midflight.signal.reason}).ready('SOC',midflight.signal),{name:'AbortError'})
 }finally{await rm(root,{recursive:true,force:true})}
})

test('来源配置文件权限过宽或为符号链接时拒绝读取',async()=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-security-source-')),config=join(root,'source.json')
 try{
  await writeFile(config,JSON.stringify({url:'https://security.example.test/api'}),{mode:0o600})
  await chmod(config,0o644)
  await assert.rejects(new SecurityAlertHttpSource(config).query({scope:'SOC',limit:10}),{code:'teloa/source-unavailable',message:'安全告警来源配置文件权限过宽，已停止读取。',details:{sourceState:'config-unreadable'}})

  const external=join(root,'external.json')
  await writeFile(external,JSON.stringify({url:'https://security.example.test/api'}),{mode:0o600})
  await rm(config,{force:true})
  await symlink(external,config)
  await assert.rejects(new SecurityAlertHttpSource(config).query({scope:'SOC',limit:10}),{code:'teloa/source-unavailable',message:'安全告警来源配置文件无法读取，请检查配置文件。',details:{sourceState:'config-unreadable'}})
 }finally{await rm(root,{recursive:true,force:true})}
})

test('配置文件存在但读不了（JSON 损坏、格式不正确、读取权限错误、不是文件）→ sourceState:config-unreadable；就绪原因随之说清',async()=>{
 const root=await mkdtemp(join(tmpdir(),'teloa-security-source-')),config=join(root,'source.json')
 const unreadable={code:'teloa/source-unavailable',details:{sourceState:'config-unreadable'}}
 try{
  await writeFile(config,'{"url":',{mode:0o600})
  await assert.rejects(new SecurityAlertHttpSource(config).query({scope:'SOC',limit:10}),{...unreadable,message:'安全告警来源配置文件无法读取，请检查配置文件。'},'JSON 损坏')
  assert.deepEqual(await new SecurityAlertHttpSource(config).ready('SOC',new AbortController().signal),{ready:false,reason:'安全告警来源配置文件无法读取，请检查配置文件。'})
  await writeFile(config,JSON.stringify({url:'http://security.example.test/api'}),{mode:0o600})
  await assert.rejects(new SecurityAlertHttpSource(config).query({scope:'SOC',limit:10}),{...unreadable,message:'安全告警来源必须使用 HTTPS，或指向本机 HTTP 测试服务。'},'格式不正确')
  await writeFile(config,JSON.stringify({url:'https://security.example.test/api',extra:1}),{mode:0o600})
  await assert.rejects(new SecurityAlertHttpSource(config).query({scope:'SOC',limit:10}),{...unreadable,message:'安全告警来源配置格式不正确。'})
  await chmod(config,0o000)
  if(process.getuid?.()!==0)await assert.rejects(new SecurityAlertHttpSource(config).query({scope:'SOC',limit:10}),{...unreadable,message:'安全告警来源配置文件无法读取，请检查配置文件。'},'读取权限错误')
  await rm(config,{force:true})
  await mkdir(config)
  await assert.rejects(new SecurityAlertHttpSource(config).query({scope:'SOC',limit:10}),{...unreadable,message:'安全告警来源配置文件无法读取，请检查配置文件。'},'路径是目录')
 }finally{await rm(root,{recursive:true,force:true})}
})
