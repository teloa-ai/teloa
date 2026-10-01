import {createRequire} from 'node:module'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {programRoot} from './layout.ts'

export async function loadAdmission(){return (await import(pathToFileURL(join(programRoot,'packages/harness-dsh/lib/runtime-admission.js')).href)).runtimeAdmission}
export async function loadHost(name:string,expectedVersion?:string){
 const require=createRequire(createRequire(join(programRoot,'package.json')).resolve('@deepseek-ai/dsh/package.json'))
 if(expectedVersion&&require(name+'/package.json').version!==expectedVersion)throw Error('DSH 载体版本尚未验证，无法装配停止保护。')
 return (await import(pathToFileURL(require.resolve(name)).href)).default
}
/** 用上游公开继承接口装配，保留路由的认证和原响应所有权。 */
export function guardedWebServer(Base:any,gate:any){return class extends Base {
 get teloaAdmissionGuard(){return gate}
 register(route:any){return super.register({...route,handler:(req:any,res:any)=>{
  if(/^\/teloa-local-runtime\/(?:activity|readiness|quiesce|resume|sealed)$/.test((req.url??'').split('?')[0]))return route.handler(req,res)
  return gate.run(()=>route.handler(req,res)).catch((error:Error)=>{if(!res.headersSent){res.writeHead(503,{'content-type':'text/plain; charset=utf-8','retry-after':'1'});res.end(error.message)}else res.destroy(error)})
 }})}
}}
export function guardedGateway(Base:any,gate:any){
 // DSH 0.1.7-rc.1 的 WebSocket mux 绕过公开 stream()/wireStream.open，且没有入站拦截扩展。
 // 仅在固定版本的载体入口加停止闸门，解析、认证、取消与流协议仍由官方实现；升级须实装复验。
 if(typeof Base.prototype.openWireStream!=='function')throw Error('DSH 流入口不兼容，无法装配停止保护。')
 return class extends Base {
 get teloaAdmissionGuard(){return gate}
 // 进程内和已连接 WebSocket 的新流均须在参数解析（可能恢复 Agent）前过闸。
 stream(request:any){return gate.run(()=>super.stream(request))}
 openWireStream(...args:any[]){return gate.run(()=>super.openWireStream(...args))}
}}
