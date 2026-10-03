import {Service,type Context} from '@deepseek-ai/cordis'
import {WorkError} from '@teloa/contract'
import {createNativeWorkInput} from './native-work-input.ts'
import {createNativeProducerAdmissions} from './native-producer-admission.ts'
import {workAccess} from '@teloa/backend'
import type {NativeInputCheckpoint,NativeProgressCheckpoint,NativeInputRestore} from './native-input-checkpoint.ts'

export type {NativeInputCheckpoint,NativeInputCheckpointInput,NativeInputRoot,NativeProgressCheckpoint,NativeProgressCheckpointInput,NativeInputRestore,NativeInputRestoreInput,NativeInputRestoreLease} from './native-input-checkpoint.ts'
export type NativeInputProviderConfig=Readonly<{checkpoint?:NativeInputCheckpoint;progress?:NativeProgressCheckpoint;restore?:NativeInputRestore}>
/** 固定宿主在装配前核验真实冷恢复契约，旧核心不能静默忽略恢复配置。 */
export const nativeInputRestoreVersion=1

declare module '@deepseek-ai/cordis'{
 interface Context{readonly teloaNativeInput:TeloaNativeInput}
}

const unavailable=()=>new WorkError('teloa/unavailable','原生输入准入服务尚未就绪。')
type Method=(...args:unknown[])=>unknown

/** 仅核对固定官方补口；没有补口时在 managed 发布者构造前拒绝。 */
export function nativeAdmissionMethods(prototype:object,requireName:string,installName:string):readonly [Method,Method]{
 try{
  const required:unknown=Reflect.get(prototype,requireName),install:unknown=Reflect.get(prototype,installName)
  if(typeof required==='function'&&typeof install==='function')return [required as Method,install as Method]
 }catch{}
 throw unavailable()
}

export function installNativeAdmission(receiver:object,methods:readonly [Method,Method],policy:unknown):void{
 for(const [method,args] of [[methods[0],[]],[methods[1],[policy]]] as const){
  const returned=Reflect.apply(method,receiver,args)
  if(returned!==undefined){void Promise.resolve(returned).catch(()=>{});throw unavailable()}
 }
}

export function requireNativeInputProvider(ctx:Context):TeloaNativeInput{
 const provider=ctx.get('teloaNativeInput')
 if(!(provider instanceof TeloaNativeInput))throw unavailable()
 return provider
}

/**
 * 一个物理宿主共享一个最终 Session guard 与一组固定发布策略。
 * 使用官方 Service/inject 装配；冷续作须由部署恢复策略核验精确历史和全部待办根。
 * 未配置恢复策略时，在官方读日志后、首个修复写入前拒绝待处理 Inbox。
 * 初次 Agent 发布仍拒绝没有受理因果证明的 pending seed/fork；seed 可能已落存。
 * Store 的 required 策略单向固定；卸载服务后维持关闭，重新运行须重建物理宿主。
 */
export class TeloaNativeInput extends Service{
 // Loop 由准入服务发布后再启动；这里只等待构造守卫直接使用的核心服务。
 static inject=['sessions','agents','llm','tools']
 declare readonly input:ReturnType<typeof createNativeWorkInput>
 declare readonly admissions:ReturnType<typeof createNativeProducerAdmissions>
 constructor(ctx:Context,config:NativeInputProviderConfig={}){
  // 必须先验证最终补口，不能先发布一个缺少守卫的准入 Service。
  const input=createNativeWorkInput(ctx,workAccess,config.checkpoint,config.progress,config.restore),admissions=createNativeProducerAdmissions(input)
  super(ctx,'teloaNativeInput')
  Object.defineProperties(this,{
   input:{value:input,enumerable:true,writable:false,configurable:false},
   admissions:{value:admissions,enumerable:true,writable:false,configurable:false},
  })
  ctx.effect(()=>()=>input.close())
 }
}
export default TeloaNativeInput
