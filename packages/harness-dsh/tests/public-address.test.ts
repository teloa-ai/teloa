import test from 'node:test'
import assert from 'node:assert/strict'
import type {ProxyRoute} from '@deepseek-ai/dsh-http-proxy'
import {WorkError} from '@teloa/contract'
import {isPublicAddress,pinnedHttpsRequest,resolveOutboundAddresses,resolvePublicAddresses} from '../src/public-address.ts'

test('非公网地址一律拒绝（含 IPv4 映射 IPv6）',()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','0.0.0.0','224.0.0.1','255.255.255.255','::1','::','fe80::1','fc00::1','fd00:ec2::254','ff02::1','::ffff:127.0.0.1','::ffff:10.0.0.1','64:ff9b::7f00:1','2001:db8::1','2002:7f00:1::','::7f00:1','::127.0.0.1','::ffff:0:7f00:1','fec0::1','3fff::1'])assert.equal(isPublicAddress(ip),false,ip)
 for(const ip of ['1.1.1.1','104.18.32.1','2606:4700::1111'])assert.equal(isPublicAddress(ip),true,ip)
})
test('解析结果任一非公网即拒绝；全部公网返回全集',async()=>{
 const signal=AbortSignal.timeout(1000)
 await assert.rejects(resolvePublicAddresses('api.example',signal,async()=>[{address:'104.18.32.1',family:4},{address:'10.0.0.1',family:4}]),/不允许的网段/)
 await assert.rejects(resolvePublicAddresses('api.example',signal,async()=>[]),/无法解析/)
 assert.deepEqual(await resolvePublicAddresses('api.example',signal,async()=>[{address:'104.18.32.1',family:4}]),[{address:'104.18.32.1',family:4}])
})
test('解析可被 signal 中止：resolver 悬挂时超时即返回 AbortError，不等 DNS',async()=>{
 const controller=new AbortController()
 const pending=resolvePublicAddresses('api.example',controller.signal,()=>new Promise(()=>{}))
 setTimeout(()=>controller.abort(),20)
 await assert.rejects(pending,(error:unknown)=>(error as Error).name==='AbortError')
})
test('出站地址预检按路由（审查 R1 L3）：走代理时本机解析失败放行、解析出非公网仍拒；直连解析失败照旧拒绝；中止不被吞',async()=>{
 const proxied={proxied:true,proxy:'http://proxy.invalid:8080',dispatcher:{}} as unknown as ProxyRoute,direct:ProxyRoute={proxied:false}
 const signal=AbortSignal.timeout(1000),notFound=async()=>{throw Object.assign(Error('getaddrinfo ENOTFOUND api.example'),{code:'ENOTFOUND'})}
 assert.deepEqual(await resolveOutboundAddresses('api.example',signal,notFound,proxied),[])
 assert.deepEqual(await resolveOutboundAddresses('api.example',signal,async()=>[],proxied),[])
 assert.deepEqual(await resolveOutboundAddresses('api.example',signal,async()=>[{address:'104.18.32.1',family:4}],proxied),[{address:'104.18.32.1',family:4}])
 await assert.rejects(resolveOutboundAddresses('api.example',signal,async()=>[{address:'104.18.32.1',family:4},{address:'10.0.0.5',family:4}],proxied),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/forbidden')
 await assert.rejects(resolveOutboundAddresses('api.example',signal,notFound,direct),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/dependency-unavailable')
 await assert.rejects(resolveOutboundAddresses('api.example',signal,async()=>[],direct),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/dependency-unavailable')
 const controller=new AbortController(),pending=resolveOutboundAddresses('api.example',controller.signal,()=>new Promise(()=>{}),proxied)
 setTimeout(()=>controller.abort(),20)
 await assert.rejects(pending,(error:unknown)=>(error as Error).name==='AbortError')
})
test('直连路径没有已校验地址时不建连（fail-closed）：路由在预检与请求之间翻转也不会无钉住直连',async()=>{
 await assert.rejects(pinnedHttpsRequest(new URL('https://api.example/v1/x'),{method:'GET',headers:{},signal:AbortSignal.timeout(1000)},[],{proxied:false}),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/dependency-unavailable')
})
