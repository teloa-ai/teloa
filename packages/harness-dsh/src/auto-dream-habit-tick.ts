/** 观察按分钟检查；生成服务按日期幂等，重启、关机恢复与目录刷新共用同一份记录。 */
export function createAutoDreamHabitTick(ports:{observe:(now:string,signal:AbortSignal)=>Promise<void>;report:(code:string)=>void}){
 let last:number|undefined
 return async(now:string,signal:AbortSignal):Promise<void>=>{
  const time=Date.parse(now)
  if(signal.aborted||!Number.isFinite(time)||last!==undefined&&time>=last&&time-last<60000)return
  last=time
  try{await ports.observe(now,signal)}catch{ports.report('teloa/habit-observation-unavailable')}
 }
}
