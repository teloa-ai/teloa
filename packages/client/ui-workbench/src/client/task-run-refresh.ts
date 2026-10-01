import type {RunView,TaskRunApi} from './task-run-api.ts'

/** 一次延迟核对；由页面在收到新快照后安排下一次，取消后丢弃迟到结果。 */
export function scheduleTaskRunRefresh(rows:RunView[],api:Pick<TaskRunApi,'reconcile'>,publish:(rows:RunView[])=>void,failed:(error:unknown)=>void,schedule:(work:()=>void)=>()=>void=work=>{
 const timer=setTimeout(work,2000)
 return ()=>clearTimeout(timer)
},relist?:()=>Promise<RunView[]>):()=>void{
 let cancelled=false
 // 空列表恰恰最需要活性：执行可能是在这个区域挂载之后才产生的。排一次延时重读，
 // 读到记录就交给上面那条常规轮询；仍为空就不再自转，免得没有执行的任务被无限轮询。
 if(!rows.length&&relist){
  const cancelFirst=schedule(()=>{void (async()=>{
   try{const fetched=await relist();if(!cancelled&&fetched.length)publish(fetched)}
   catch(error){if(!cancelled)failed(error)}
  })()})
  return ()=>{cancelled=true;cancelFirst()}
 }
 if(!rows.some(row=>row.state!=='prepared'&&row.state!=='ended'&&row.state!=='withdrawn'&&row.state!=='configuration_failed'))return ()=>{}
 const cancelTimer=schedule(()=>{void (async()=>{
  try{
   const updated:RunView[]=[]
   for(const row of rows){
    if(cancelled)return
    updated.push(row.state==='prepared'||row.state==='ended'||row.state==='withdrawn'||row.state==='configuration_failed'?row:await api.reconcile(row))
   }
   if(!cancelled)publish(updated)
  }catch(error){if(!cancelled)failed(error)}
 })()})
 return ()=>{cancelled=true;cancelTimer()}
}
