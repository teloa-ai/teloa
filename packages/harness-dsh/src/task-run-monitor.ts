/**
 * 连续失败退避。只给"恢复本身会向外部系统重放请求"的循环用（安全执行），
 * 任务执行回填那条循环不配置、逐字保持原节奏。
 *
 * 为什么必须是退避而不是库里的冷却：`markUnknown` 对已是 `effect_unknown` 的记录直接返回、
 * 不写库，`updated_at` 不推进，所以服务端 `outstanding` 的一分钟冷却只推迟首次捡起——
 * 一条 `observe` 恒 null 且 `execute` 恒失败的记录过了那一分钟仍会每轮重放一次 POST
 * （规格 §九 开放问题 2）。按连续失败轮数在宿主侧跳过是不与 append-only 冲突的那条修法。
 *
 * `now` 与 `jitter` 都从外面注入：用例要能算准"第几毫秒才允许下一次重试"。
 */
export type RecoveryBackoff={initialMs:number;maxMs:number;now:()=>number;jitter?:()=>number}
/**
 * 停止意图的有界重发。`needed` 读本轮核对结果自行判定，可以异步——因为「还值不值得再喊一次
 * 停」要看宿主自报的运行状态：宿主已经不在跑时再喊多少次都是 no-op，那条路由 reconcile 收口
 * 负责。`send` 重发取消本身（cancel 幂等、keepInbox 保留排队）。达到 `limit` 就不再重发。
 */
export type StopResend={needed:(observed:unknown)=>boolean|Promise<boolean>;send:(id:string)=>Promise<void>;limit?:number;backoff?:RecoveryBackoff}
type Ports={list:()=>Promise<string[]>;reconcile:(id:string)=>Promise<unknown>;deliver?:()=>Promise<unknown>;report:(id:string,code:string)=>void;backoff?:RecoveryBackoff;resendStop?:StopResend}
type Schedule=(work:()=>void)=>()=>void
/** 指数退避 + 半抖动：等待落在 [上限/2, 上限)，既封顶也不让多条记录齐步走。 */
function backoffUntil(backoff:RecoveryBackoff,failures:number):number{
 // 指数先封顶再算，免得连续失败几十轮之后 2**failures 溢出成 Infinity。
 const ceiling=Math.min(backoff.initialMs*2**Math.min(failures-1,30),backoff.maxMs)
 return backoff.now()+ceiling*(0.5+0.5*(backoff.jitter??Math.random)())
}
/** 只观察，不领取或重发；完成本次扫描后再计时，卸载时等待正在进行的回填。 */
export function monitorTaskRuns(ports:Ports,schedule:Schedule=work=>{
 const timer=setTimeout(work,2000);timer.unref?.();return ()=>clearTimeout(timer)
}):()=>Promise<void>{
 let stopped=false,cancel=()=>{},inFlight=Promise.resolve()
 const failures=new Map<string,string>()
 const backoffs=new Map<string,{failures:number;until:number}>()
 const resends=new Map<string,{attempts:number;until:number}>()
 const report=(id:string,error:unknown,fallback='teloa/observation-unavailable')=>{
  const code=error&&typeof error==='object'&&'code' in error&&typeof error.code==='string'&&/^teloa\/[a-z-]+$/.test(error.code)?error.code:fallback
  if(failures.get(id)!==code){failures.set(id,code);ports.report(id,code)}
 }
 // 只对"已请求停止且仍未终态"的记录重发取消，最多 limit 次、按同一套退避拉开间隔；
 // 重发失败只报告，不影响这一轮的观察节奏，更不会把记录写成终态。
 const resendStop=async(id:string,observed:unknown)=>{
  const resend=ports.resendStop
  if(!resend)return
  // 判定本身也可能读宿主，读不到只报告：它和重发失败一样不该拖累这一轮的观察节奏。
  let needed:boolean
  try{needed=await resend.needed(observed)}catch(error){report(id,error,'teloa/execution-pending');return}
  if(!needed){resends.delete(id);return}
  const limit=resend.limit??5,state=resends.get(id)??{attempts:0,until:0}
  if(state.attempts>=limit||(resend.backoff&&resend.backoff.now()<state.until))return
  const attempts=state.attempts+1
  resends.set(id,{attempts,until:resend.backoff?backoffUntil(resend.backoff,attempts):0})
  try{await resend.send(id)}catch(error){report(id,error,'teloa/execution-pending')}
 }
 const tick=()=>{
  if(stopped)return
  inFlight=(async()=>{
   try{
    const ids=await ports.list()
    failures.delete('directory')
    const backoff=ports.backoff
    for(const id of ids){
     if(stopped)return
     // 退避窗口内这一轮整条跳过：不 reconcile 就不会再向外部重放一次请求。
     if(backoff&&backoff.now()<(backoffs.get(id)?.until??0))continue
     try{const observed=await ports.reconcile(id);failures.delete(id);backoffs.delete(id);await resendStop(id,observed)}
     catch(error){
      report(id,error)
      // 一次成功即清零；失败则按连续失败次数继续翻倍，直到 maxMs 封顶。
      if(backoff){const count=(backoffs.get(id)?.failures??0)+1;backoffs.set(id,{failures:count,until:backoffUntil(backoff,count)})}
     }
    }
    for(const id of failures.keys())if(!['directory','notification-delivery'].includes(id)&&!ids.includes(id))failures.delete(id)
    // 记录落终态离开目录之后，它再出现就是另一段生命（例如接续重新提议），
    // 不该继续背着上一段的退避窗口，同时退避表也不该随扫描无限长住内存。
    for(const id of backoffs.keys())if(!ids.includes(id))backoffs.delete(id)
    for(const id of resends.keys())if(!ids.includes(id))resends.delete(id)
   }catch(error){report('directory',error)}
   const next=()=>{if(!stopped)cancel=schedule(tick)}
   // 安全执行恢复没有通知可投递；端口缺席时整段跳过，免得在失败去重表里凭空多一个键。
   if(!stopped&&ports.deliver){
    try{await ports.deliver();failures.delete('notification-delivery')}
    catch(error){report('notification-delivery',error,'teloa/notification-unavailable')}
    finally{next()}
   }else{
    next()
   }
  })()
 }
 cancel=schedule(tick)
 return async()=>{stopped=true;cancel();await inFlight}
}
