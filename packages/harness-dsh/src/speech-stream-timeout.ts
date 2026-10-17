/** 超时只约束 fetch 与每次读取；消费者播放背压不占用网络空闲预算。 */
export function createSpeechStreamTimeout(signal:AbortSignal){
 const timeout=new AbortController(),requestSignal=AbortSignal.any([signal,timeout.signal])
 return Object.freeze({
  signal:requestSignal,
  async wait<T>(operation:()=>Promise<T>):Promise<T>{
   requestSignal.throwIfAborted()
   let rejectAbort!:(reason:unknown)=>void
   const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=reject})
   const abort=()=>rejectAbort(requestSignal.reason)
   requestSignal.addEventListener('abort',abort,{once:true})
   const timer=setTimeout(()=>timeout.abort(new DOMException('Speech network timed out','TimeoutError')),60000)
   timer.unref()
   try{
    const value=await Promise.race([Promise.resolve().then(operation),aborted])
    requestSignal.throwIfAborted();return value
   }finally{clearTimeout(timer);requestSignal.removeEventListener('abort',abort)}
  },
 })
}
