import {lookup as dnsLookup} from 'node:dns/promises'
import {request as httpsRequest} from 'node:https'
import {BlockList,isIP,type LookupFunction} from 'node:net'
import {Readable} from 'node:stream'
import {ReadableStream as WebReadableStream} from 'node:stream/web'
import {proxyRouteFor,type ProxyRoute} from '@deepseek-ai/dsh-http-proxy'
import {WorkError} from '@teloa/contract'
import {request as undiciRequest} from 'undici'

/**
 * 技能出站的公网校验与钉住建连（规格 §5.2）。口径照 dsh-web-fetch-http（公网单播、钉住、同源），实现照
 * feat/model-phase2-ollama 的 pinnedFetch 思路（只读参考，不 import）：node:https.request 的 lookup 只回刚校验过的地址，
 * Host 头与 SNI 仍是声明主机名。非公网名单按网段判定，IPv4 映射 IPv6 由 BlockList 按内嵌 IPv4 处理。
 */
const nonPublic=new BlockList()
for(const [net,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]] as const)nonPublic.addSubnet(net,bits,'ipv4')
nonPublic.addAddress('255.255.255.255','ipv4')
// ::/96（IPv4 兼容，含 ::/128 与 ::1）、::ffff:0:0:0/96（IPv4 翻译）、fec0::/10（站点本地）、3fff::/20（文档）按 fail-closed 一并列入。
for(const [net,bits] of [['::',96],['::ffff:0:0:0',96],['64:ff9b::',96],['64:ff9b:1::',48],['100::',64],['2001::',32],['2001:db8::',32],['2002::',16],['3fff::',20],['fc00::',7],['fe80::',10],['fec0::',10],['ff00::',8]] as const)nonPublic.addSubnet(net,bits,'ipv6')
export function isPublicAddress(ip:string):boolean{
 const kind=isIP(ip)
 if(kind===0)return false
 // ::ffff:a.b.c.d：BlockList 的 ipv6 检查会按内嵌 IPv4 命中 ipv4 网段（Node 原生行为），无需自行解码。
 return !nonPublic.check(ip,kind===4?'ipv4':'ipv6')
}
export type PublicAddress={address:string;family:4|6}
export type AddressResolver=(host:string)=>Promise<{address:string;family:number}[]>
/** 解析一次，全部结果必须是公网单播；任一不是即拒绝（fail-closed）。dns.lookup 本身不可中止，用 signal 竞速让调用方超时即返回。 */
export async function resolvePublicAddresses(host:string,signal:AbortSignal,resolver:AddressResolver=h=>dnsLookup(h,{all:true})):Promise<PublicAddress[]>{
 signal.throwIfAborted()
 let onAbort=()=>{}
 const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true})})
 const results=await Promise.race([resolver(host),aborted]).catch(error=>{if(signal.aborted)throw error;throw new WorkError('teloa/dependency-unavailable','无法解析目标地址。')}).finally(()=>signal.removeEventListener('abort',onAbort))
 signal.throwIfAborted()
 if(!results.length)throw new WorkError('teloa/dependency-unavailable','无法解析目标地址。')
 if(results.some(r=>!isPublicAddress(r.address)))throw new WorkError('teloa/forbidden','目标地址解析到不允许的网段，已拒绝连接。')
 return results.map(r=>({address:r.address,family:(isIP(r.address)===6?6:4) as 4|6}))
}
/**
 * 技能出站的地址预检（审查 R1 L3 裁定）。直连路径即 resolvePublicAddresses：解析失败拒绝、任一非公网拒绝，结果用于钉住。
 * 走代理（proxied）时目标主机名由代理解析，本机解析只是纵深防御：本机解析失败（本机 DNS 不解外网、只能经代理）放行并回空地址表；
 * 解析出任何非公网地址仍拒。代理路径上防内网访问的实际控制是隧道内 TLS 按声明主机名校验证书（见 pinnedHttpsRequest）。
 * 第 4 参数仅供测试注入路由，生产一律取 proxyRouteFor。
 */
export async function resolveOutboundAddresses(host:string,signal:AbortSignal,resolver?:AddressResolver,route:ProxyRoute=proxyRouteFor(new URL(`https://${host}/`))):Promise<PublicAddress[]>{
 try{return await resolvePublicAddresses(host,signal,resolver)}catch(error){
  if(route.proxied&&error instanceof WorkError&&error.code==='teloa/dependency-unavailable')return []
  throw error
 }
}
export type PinnedInit={method:string;headers:Record<string,string>;body?:string;signal:AbortSignal}
/**
 * 按 DSH 官方进程级代理策略分流（规格 2026-09-27 §6 C3）；不跟随跳转（3xx 原样返回给调用方逐跳复判）。
 * - 直连（`proxied:false`，含 NO_PROXY 命中）：https.request + lookup 钉住 + agent:false，与此前完全一致。
 * - 走代理（`proxied:true`）：用官方 dispatcher 经 CONNECT 隧道发请求。入口取自 dispatcher 所属的同一 undici 实例（照 dsh-web-fetch-http requestVia；
 *   Node 内置 fetch 的 handler 协议与该 dispatcher 所属 undici 8 不兼容，会报 UND_ERR_INVALID_ARG），且用 request 而非 fetch：fetch 会附加
 *   accept、accept-language、sec-fetch-mode、user-agent 等默认头，request 只发调用方给的头，与直连路径的请求形态一致（审查 R1 L2）；也不跟随跳转、不自动解压。
 *   此时目标主机名由代理解析，钉住不成立（规格 §6 残余）；调用方的本机预检见 resolveOutboundAddresses。
 *   防内网访问的实际控制是 TLS：隧道内由本进程按声明主机名校验证书，Host/SNI 不变，代理即便把隧道接到内网，也只能到达持有该主机名有效证书的服务。
 *   代理 URL（可能含账号）只在 dispatcher 内部使用，不进日志、错误、审计与回包；fetch 失败按原错误抛出（undici 错误不含代理 URL）。
 * 第 4 参数仅供测试注入路由，生产一律取 proxyRouteFor(url)。
 */
export function pinnedHttpsRequest(url:URL,init:PinnedInit,addresses:readonly PublicAddress[],route:ProxyRoute=proxyRouteFor(url)):Promise<Response>{
 if(route.proxied)return undiciRequest(url,{method:init.method,headers:init.headers,...(init.body!==undefined?{body:init.body}:{}),signal:init.signal,dispatcher:route.dispatcher}).then(res=>{
  const status=res.statusCode
  if(status<200||status>599){res.body.destroy();throw new WorkError('teloa/invalid-host-response','上游返回了无法处理的状态码。')}
  const headers=new Headers()
  for(const [name,value] of Object.entries(res.headers)){if(typeof value==='string')headers.set(name,value);else if(Array.isArray(value))for(const item of value)headers.append(name,item)}
  if(status===204||status===304){res.body.destroy();return new Response(null,{status,statusText:res.statusText,headers})}
  // 不用 Readable.toWeb：undici 的 BodyReadable 在 Web 流取消后仍可能再发 data，适配器会抛 Controller is already closed；按异步迭代器桥接，取消即销毁连接体。
  return new Response(WebReadableStream.from(res.body) as unknown as ReadableStream<Uint8Array>,{status,statusText:res.statusText,headers})
 })
 // 没有已校验地址（路由在预检与请求之间由代理翻为直连）时不建连，fail-closed。
 const first=addresses[0]
 if(!first)return Promise.reject(new WorkError('teloa/dependency-unavailable','无法解析目标地址。'))
 const lookup=((_host:string,options:{all?:boolean},callback:(error:Error|null,...rest:unknown[])=>void)=>{
  if(options.all)callback(null,addresses.map(item=>({address:item.address,family:item.family})))
  else callback(null,first.address,first.family)
 }) as unknown as LookupFunction
 return new Promise<Response>((resolve,reject)=>{
  // agent:false：不与 globalAgent 共用连接池，避免复用其他调用未钉住地址建立的 keep-alive 连接。
  const req=httpsRequest(url,{method:init.method,headers:init.headers,lookup,signal:init.signal,agent:false},res=>{
   const status=res.statusCode??0
   if(status<200||status>599){res.destroy();reject(new WorkError('teloa/invalid-host-response','上游返回了无法处理的状态码。'));return}
   const headers=new Headers()
   for(const [name,value] of Object.entries(res.headers)){if(typeof value==='string')headers.set(name,value);else if(Array.isArray(value))for(const item of value)headers.append(name,item)}
   resolve(new Response(status===204||status===304?null:Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>,{status,statusText:res.statusMessage??'',headers}))
  })
  req.on('error',reject)
  if(init.body!==undefined)req.end(init.body);else req.end()
 })
}
