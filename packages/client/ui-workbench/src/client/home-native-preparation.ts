const retryDelays=[180,540] as const

export function canRetryHomeNativeInput(error:unknown):boolean{
 const code=error&&typeof error==='object'&&'code'in error?error.code:undefined
 return typeof code!=='string'||['teloa/not-bound','teloa/binding-pending'].includes(code)
}

/** 首页准备复用原会话与领养请求；短暂断连可重试，明确的业务拒绝仍交给恢复入口。 */
export async function recoverHomeNativeInput(prepare:(signal:AbortSignal)=>Promise<string|undefined>,signal:AbortSignal):Promise<string|undefined>{
 for(let attempt=0;;attempt++){
  signal.throwIfAborted()
  try{const id=await prepare(signal);signal.throwIfAborted();return id}catch(error){
   signal.throwIfAborted()
   if(attempt>=retryDelays.length||!canRetryHomeNativeInput(error))throw error
   await new Promise<void>((resolve,reject)=>{
    const aborted=()=>{clearTimeout(timer);reject(signal.reason)}
    const timer=setTimeout(()=>{signal.removeEventListener('abort',aborted);resolve()},retryDelays[attempt])
    signal.addEventListener('abort',aborted,{once:true})
    if(signal.aborted)aborted()
   })
  }
 }
}
