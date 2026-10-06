import type {ISessions,SessionBinding} from '@deepseek-ai/dsh-api-session-controller/client'
import type {SessionId} from '@deepseek-ai/dsh-session'
import type {MainSessionSource} from './main-session.js'

export type InitialNativeSessionProof={sessionId:SessionId;binding:SessionBinding;assertCurrent:()=>void}
export type InitialNativeSessionRequest={signal:AbortSignal;current:()=>SessionId|undefined;waitForCurrent:()=>Promise<InitialNativeSessionProof>;isCurrent:(id:SessionId,binding:SessionBinding)=>boolean;confirmBlank:(id:SessionId,binding:SessionBinding)=>Promise<boolean>}
export type InitialNativeSessionProvider=(request:InitialNativeSessionRequest)=>Promise<string|undefined>
declare module '@deepseek-ai/cordis'{interface Events{'teloa/initial-native-session/register'(provider:InitialNativeSessionProvider):void}}
type Ports={current:MainSessionSource;sessions:()=>ISessions;isBlank:(id:SessionId)=>Promise<boolean|undefined>}
const changed=()=>Error('原生初始会话或本人作用域已变化。')

/** 官方主引用完成历史打开后才交给初始输入；不创建第二份选择状态。 */
export function initialNativeSessionRequest(ports:Ports,signal:AbortSignal):InitialNativeSessionRequest{
 const sessions=ports.sessions()
 const isCurrent=(id:SessionId,binding:SessionBinding)=>!signal.aborted&&ports.sessions()===sessions&&ports.current.getSnapshot()===id&&sessions.binding(id)===binding
 const waitForCurrent=async():Promise<InitialNativeSessionProof>=>{
   signal.throwIfAborted()
   const id=ports.current.getSnapshot()??await new Promise<SessionId>((resolve,reject)=>{
    let off=()=>{}
    const finish=(error?:unknown,id?:SessionId)=>{off();signal.removeEventListener('abort',aborted);error!==undefined?reject(error):resolve(id!)}
    const inspect=()=>{const next=ports.current.getSnapshot();if(next!==undefined)finish(undefined,next)}
    const aborted=()=>finish(signal.reason)
    off=ports.current.subscribe(inspect);signal.addEventListener('abort',aborted,{once:true})
    if(signal.aborted)aborted();else inspect()
   })
   signal.throwIfAborted()
   if(ports.sessions()!==sessions)throw changed()
   return sessions.using(id,{source:'controllerOperation',signal},async reference=>{
    await reference.ready
    signal.throwIfAborted()
    const binding=reference.binding
    if(!isCurrent(id,binding))throw changed()
    return {sessionId:id,binding,assertCurrent:()=>{signal.throwIfAborted();if(!isCurrent(id,binding))throw changed()}}
   })
 }
 return {signal,current:ports.current.getSnapshot,waitForCurrent,isCurrent,confirmBlank:async(id,binding)=>{
  signal.throwIfAborted()
  if(ports.sessions()!==sessions||sessions.binding(id)!==binding)throw changed()
  const blank=await ports.isBlank(id)
  signal.throwIfAborted()
  if(ports.sessions()!==sessions||sessions.binding(id)!==binding)throw changed()
  return blank===true
 }}
}

/** 单个显式初始 provider 可接入原稿；无原稿时沿官方当前会话认领真正空历史。 */
export async function prepareInitialNativeSession(ports:Ports,signal:AbortSignal,provide:(request:InitialNativeSessionRequest)=>Promise<string|undefined>):Promise<(InitialNativeSessionProof&{explicit:boolean})|undefined>{
 const request=initialNativeSessionRequest(ports,signal),provided=await provide(request)
 signal.throwIfAborted()
 const proof=await request.waitForCurrent()
 if(provided!==undefined&&provided!==proof.sessionId)throw changed()
 const blank=await request.confirmBlank(proof.sessionId,proof.binding)
 proof.assertCurrent()
 if(!blank)return undefined
 return {...proof,explicit:provided!==undefined}
}

/** 显式原稿的启动与页面导航分离；首页等待同一请求，不并发创建第二份空稿。 */
export function createInitialNativeSessionCoordinator(ready:()=>Promise<Ports>,signal:AbortSignal){
 let provider:InitialNativeSessionProvider|undefined,pending:Promise<string|undefined>|undefined
 const start=()=>{
  if(!provider)return Promise.resolve(undefined)
  if(!pending){
   const operation=(async()=>{const ports=await ready();signal.throwIfAborted();return provider!(initialNativeSessionRequest(ports,signal))})()
   pending=operation
   void operation.catch(()=>{if(pending===operation)pending=undefined})
  }
  return pending
 }
 return {
  register(next:InitialNativeSessionProvider){if(provider)throw Error('初始原生会话已有提供者。');provider=next;void start().catch(()=>{})},
  async prepare(caller:AbortSignal){
   const provided=await start()
   caller.throwIfAborted()
   const ports=await ready()
   return prepareInitialNativeSession(ports,caller,async()=>provided===ports.current.getSnapshot()?provided:undefined)
  },
 }
}
