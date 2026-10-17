/**
 * 已打开的正式群串行重读；成功回传仍完全由服务端群消息目录决定。
 * 一次读取完成（包括失败）后再安排下一轮，不依赖页面收到新目录；切群或卸载后不再续排。
 */
export function scheduleGroupMessageRefresh(refresh:()=>Promise<void>,schedule:(work:()=>void)=>()=>void=work=>{
 const timer=setTimeout(work,4000)
 return ()=>clearTimeout(timer)
}):()=>void{
 let cancelled=false,cancelTimer=()=>{}
 const next=()=>{
  if(cancelled)return
  cancelTimer=schedule(()=>{
   if(cancelled)return
   // 同步异常与异步失败都交给下一轮重读恢复；错误提示由实际读取口保留。
   void Promise.resolve().then(()=>{if(!cancelled)return refresh()}).catch(()=>undefined).finally(next)
  })
 }
 next()
 return ()=>{cancelled=true;cancelTimer()}
}
