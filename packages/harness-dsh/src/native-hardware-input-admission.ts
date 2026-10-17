import {AsyncLocalStorage} from 'node:async_hooks'
import {WorkError,readHardwarePrepare,hardwareOperationId} from '@teloa/contract'
import type {WorkAccessLease} from '@teloa/backend'
import type {ControllerInputCandidate} from './native-producer-admission.ts'

export type HardwareNativeInput=Readonly<{requestId:string;sessionId:string;text:string}>
type Entry={fixed:HardwareNativeInput;assertCurrent:()=>void}
const denied=()=>new WorkError('teloa/forbidden','当前外部输入不属于获准的原助手请求。')
/** 外部 MCP 文本保留独立来源；不伪造音频封口或本人录音证明。 */
export class NativeHardwareInputAdmissions{
 readonly #entries=new Map<string,Entry>()
 readonly #known=new Set<string>()
 readonly #scope=new AsyncLocalStorage<Entry>()
 #closed=false
 remember(requestId:string):void{if(!hardwareOperationId(requestId))throw denied();this.#known.add(requestId)}
 knows(requestId:string):boolean{return this.#known.has(requestId)}
 #assert(entry:Entry):void{
  if(this.#closed||this.#entries.get(entry.fixed.requestId)!==entry)throw denied()
  const value:unknown=entry.assertCurrent()
  if(value!==undefined){void Promise.resolve(value).catch(()=>{});throw denied()}
 }
 async withPrompt<T>(input:HardwareNativeInput,assertCurrent:()=>void,dispatch:()=>Promise<T>):Promise<T>{
  if(this.#closed||!hardwareOperationId(input.requestId)||!/^[-A-Za-z0-9_]{1,128}$/.test(input.sessionId)||readHardwarePrepare({text:input.text}).text!==input.text||typeof assertCurrent!=='function')throw denied()
  if(this.#entries.has(input.requestId))throw new WorkError('teloa/conflict','原操作已经尝试，只能查询原结果。')
  const entry:Entry={fixed:Object.freeze({...input}),assertCurrent}
  this.#entries.set(input.requestId,entry);this.remember(input.requestId);this.#assert(entry)
  return this.#scope.run(entry,dispatch)
 }
 controller(candidate:ControllerInputCandidate):WorkAccessLease|undefined{
  if(candidate.kind!=='prompt')return undefined
  const entry=this.#entries.get(candidate.requestId)
  if(!entry&&!this.#known.has(candidate.requestId))return undefined
  if(!entry||this.#scope.getStore()!==entry)throw denied()
  const check=()=>{
   this.#assert(entry)
   const {fixed}=entry,{message}=candidate
   if(candidate.agent.id!==fixed.sessionId||candidate.agent.session.id!==fixed.sessionId||candidate.mode!=='queue'||message.role!=='user'||message.source.kind!=='user'||!('rpcId'in message.source)||message.source.rpcId!==fixed.requestId||message.content.length!==1||message.content[0]?.type!=='text'||message.content[0].text!==fixed.text)throw denied()
  }
  check()
  return {assertCurrent:check,assertContinuationCurrent(){}}
 }
 close():void{this.#closed=true;this.#entries.clear();this.#known.clear()}
}
