import type {Context} from '@deepseek-ai/cordis'
import {proxyRouteFor} from '@deepseek-ai/dsh-http-proxy'
import {Agent,fetch as pooledFetch} from 'undici'
import {WorkError} from '@teloa/contract'

type ModelHttp=Readonly<{forProvider:(provider:string)=>typeof globalThis.fetch|undefined;close:()=>Promise<void>}>
type Ports={fallback?:typeof globalThis.fetch;send?:typeof globalThis.fetch;route?:typeof proxyRouteFor;agent?:()=>Pick<Agent,'close'>}
declare module '@deepseek-ai/cordis'{interface Context{dshLlmHttp:Pick<ModelHttp,'forProvider'>}}
const modelPaths=new Set(['/anthropic/v1/messages','/v1/chat/completions','/v1/responses'])

/** 只复用MiniMax模型连接；不预发模型请求，媒体取消不关闭仍在工作的宿主连接。 */
export function createMiniMaxModelHttp(ports:Ports={}):ModelHttp{
 const fallback=ports.fallback??globalThis.fetch,route=ports.route??proxyRouteFor
 // 桥接为宿主标准Response，避免不同undici版本的Headers迭代器类型渗入调用方。
 const send:typeof globalThis.fetch=ports.send??(async(input,init)=>{
  const response=await pooledFetch(input as Parameters<typeof pooledFetch>[0],init as Parameters<typeof pooledFetch>[1])
  return new Response(response.body as unknown as ReadableStream<Uint8Array>|null,{status:response.status,statusText:response.statusText,headers:[...response.headers]})
 })
 let agent:Pick<Agent,'close'>|undefined,closed=false
 const request:typeof globalThis.fetch=async(input,init)=>{
  // 保留Request与非JSON流的原始消费语义；固定SDK的模型调用使用URL及JSON字符串。
  if(typeof input!=='string'&&!(input instanceof URL)||init?.body!=null&&typeof init.body!=='string')return fallback(input,init)
  const url=new URL(input)
  if(url.origin!=='https://api.minimax.io'||!modelPaths.has(url.pathname))return fallback(input,init)
  if(closed)throw new WorkError('teloa/host-unavailable','模型连接已关闭。')
  const selected=route(url)
  // 代理沿用官方路由；直连池支持HTTP/2并跨通常的语音轮次间隔保留连接。
  const dispatcher=selected.proxied?selected.dispatcher:(agent??=ports.agent?.()??new Agent({keepAliveTimeout:60000,keepAliveMaxTimeout:120000,allowH2:true}))
  const options={...init,dispatcher}
  return send(input,options)
 }
 return Object.freeze({forProvider:provider=>!closed&&provider==='minimax'?request:undefined,async close(){if(closed)return;closed=true;await agent?.close()}})
}

export function installMiniMaxModelHttp(ctx:Context):()=>void{
 const transport=createMiniMaxModelHttp()
 ctx.provide('dshLlmHttp',transport)
 return ()=>{void transport.close().catch(()=>{})}
}
