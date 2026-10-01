export type PlanSchedulerPhase='recover'|'tick'

export type PlanSchedulerPorts={
 recover:(now:string,signal:AbortSignal)=>Promise<void>
 tick:(now:string,signal:AbortSignal)=>Promise<void>
 report:(phase:PlanSchedulerPhase,code:string)=>void
}

export type PlanSchedulerClock=()=>string
export type PlanSchedulerTimer=(work:()=>void)=>()=>void
export type PlanSchedulerOptions={
 sleepThresholdMs?:number
 /** 独立观察心跳，不执行计划；测试可与工作计时器分别推进。 */
 observe?:PlanSchedulerTimer
}

const systemClock:PlanSchedulerClock=()=>new Date().toISOString()
const systemTimer:PlanSchedulerTimer=work=>{
 const timer=setTimeout(work,2000)
 timer.unref?.()
 return ()=>clearTimeout(timer)
}

const errorCode=(error:unknown,fallback:string)=>
 error!==null&&typeof error==='object'&&'code' in error&&
 typeof error.code==='string'&&/^teloa\/[a-z-]+$/.test(error.code)
  ? error.code
  : fallback

/** 启动时先恢复，再串行领取；取消信号只阻止端口后续工作，不撤销已经提交的操作。 */
export function startPlanScheduler(
 ports:PlanSchedulerPorts,
 clock:PlanSchedulerClock=systemClock,
 schedule:PlanSchedulerTimer=systemTimer,
 options:PlanSchedulerOptions={},
):()=>Promise<void>{
 const sleepThresholdMs=options.sleepThresholdMs??60000,observe=options.observe??systemTimer
 if(!Number.isSafeInteger(sleepThresholdMs)||sleepThresholdMs<1)throw new RangeError('调度中断阈值无效。')
 let stopped=false
 let running=false
 let recovered=false
 let cancel=()=>{}
 let cancelObservation=()=>{}
 let observedAt:number|undefined
 let inFlight=Promise.resolve()
 let stopping:Promise<void>|undefined
 let activeController:AbortController|undefined

 const report=(phase:PlanSchedulerPhase,error:unknown,fallback:string)=>{
  try{
   ports.report(phase,errorCode(error,fallback))
  }catch{
   // 错误观察端口不能接管调度生命周期；宿主应保证该端口自身可用。
  }
 }

 // 独立心跳在数据库/原生端口 await 期间继续观察，只将事件循环长间断视作停机。
 const sample=()=>{
  const now=clock(),time=Date.parse(now)
  if(!Number.isFinite(time))throw Error('调度时钟无效。')
  if(observedAt!==undefined&&(time-observedAt>sleepThresholdMs||time<observedAt)){
   recovered=false
   activeController?.abort()
  }
  observedAt=time
  return now
 }
 const heartbeat=()=>{
  if(stopped)return
  try{sample()}catch(error){recovered=false;activeController?.abort();report('recover',error,'teloa/plan-recovery-unavailable')}
  if(!stopped)cancelObservation=observe(heartbeat)
 }

 const run=()=>{
  if(stopped||running)return
  running=true
  inFlight=(async()=>{
   try{
    const now=sample(),abortController=new AbortController()
    activeController=abortController
    if(!recovered){
     try{
      await ports.recover(now,abortController.signal)
      if(abortController.signal.aborted)return
      recovered=true
     }catch(error){
      if(!abortController.signal.aborted)report('recover',error,'teloa/plan-recovery-unavailable')
      return
     }
    }
    if(stopped)return
    try{
     const tickAt=sample()
     if(abortController.signal.aborted)return
     await ports.tick(tickAt,abortController.signal)
    }catch(error){
     if(!abortController.signal.aborted)report('tick',error,'teloa/plan-scheduler-unavailable')
    }
   }catch(error){report('recover',error,'teloa/plan-recovery-unavailable')
   }finally{
    activeController=undefined
    running=false
    if(!stopped)cancel=schedule(run)
   }
  })()
 }

 run()
 cancelObservation=observe(heartbeat)
 return ()=>{
  if(stopping)return stopping
  stopped=true
  stopping=inFlight
  activeController?.abort()
  cancel()
  cancelObservation()
  return stopping
 }
}
